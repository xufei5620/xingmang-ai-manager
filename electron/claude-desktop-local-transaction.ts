import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertSafeDataFile, ensureSafeDataDirectory, readSafeUtf8FileSync } from './safe-local-data'

const label = 'Claude Desktop 第三方推理配置'
const maximumBytes = 512 * 1024
interface FilePlan { path: string; content: string }
interface PreparedFile extends FilePlan {
  before: string | null
  temporaryPath: string
  temporaryIdentity: fs.BigIntStats
  backupPath: string | null
}

function read(filePath: string): string | null { return readSafeUtf8FileSync(filePath, label, maximumBytes) }
function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink
}
function ownedFile(filePath: string, identity: fs.BigIntStats, content: string): boolean {
  return assertSafeDataFile(filePath, label)
    && sameIdentity(identity, fs.lstatSync(filePath, { bigint: true })) && read(filePath) === content
}
function stage(filePath: string, content: string): fs.BigIntStats {
  assertSafeDataFile(filePath, label)
  const descriptor = fs.openSync(filePath, 'wx', 0o600)
  const identity = fs.fstatSync(descriptor, { bigint: true })
  let complete = false
  try {
    fs.writeFileSync(descriptor, content, { encoding: 'utf8' })
    fs.fsyncSync(descriptor)
    complete = true
    return fs.fstatSync(descriptor, { bigint: true })
  } finally {
    fs.closeSync(descriptor)
    if (!complete) {
      try {
        if (assertSafeDataFile(filePath, label) && sameIdentity(identity, fs.lstatSync(filePath, { bigint: true }))) fs.unlinkSync(filePath)
      } catch { /* Preserve any replacement created by another writer. */ }
    }
  }
}

/** Profiles and toolbox state may reside on different volumes. Every rename is
 * within one directory; rollback only replaces files still owned by this commit. */
export function commitClaudeDesktopFiles(
  plans: readonly FilePlan[],
  snapshots: ReadonlyMap<string, string | null>,
  assertContext: () => void,
): { files: string[]; backups: string[] } {
  const prepared: PreparedFile[] = []
  const committed: PreparedFile[] = []
  const changes = plans.filter((plan) => snapshots.get(plan.path) !== plan.content)
  const assertSnapshots = () => {
    for (const [filePath, content] of snapshots) {
      const current = committed.find((plan) => plan.path === filePath)
      if (current ? !ownedFile(filePath, current.temporaryIdentity, current.content) : read(filePath) !== content) {
        throw new Error(`${label}已被其他程序修改，请关闭 Claude Desktop 后重试`)
      }
    }
  }
  try {
    const targets = new Set<string>()
    for (const plan of plans) {
      const target = path.resolve(plan.path)
      const key = process.platform === 'win32' ? target.toLowerCase() : target
      if (targets.has(key) || !snapshots.has(plan.path)) throw new Error(`${label}写入计划无效`)
      targets.add(key)
    }
    assertContext()
    assertSnapshots()
    for (const plan of changes) {
      ensureSafeDataDirectory(path.dirname(plan.path), label)
      const temporaryPath = `${plan.path}.xingmang-${randomUUID()}.tmp`
      const before = snapshots.get(plan.path) ?? null
      prepared.push({ ...plan, before, temporaryPath, temporaryIdentity: stage(temporaryPath, plan.content), backupPath: null })
    }
    assertContext()
    assertSnapshots()
    for (const plan of prepared) {
      if (plan.before === null) continue
      const backupPath = `${plan.path}.bak.${randomUUID()}`
      stage(backupPath, plan.before)
      if (read(backupPath) !== plan.before) throw new Error(`${label}备份校验失败`)
      plan.backupPath = backupPath
    }
    for (const plan of prepared) {
      assertContext()
      assertSnapshots()
      if (!ownedFile(plan.temporaryPath, plan.temporaryIdentity, plan.content)) throw new Error(`${label}暂存文件发生变化`)
      assertSafeDataFile(plan.path, label)
      fs.renameSync(plan.temporaryPath, plan.path)
      committed.push(plan)
    }
    assertContext()
    assertSnapshots()
    for (const plan of plans) if (read(plan.path) !== plan.content) throw new Error(`${label}保存后回读不一致`)
  } catch {
    let rollbackIncomplete = false
    for (const plan of [...committed].reverse()) {
      try {
        if (!ownedFile(plan.path, plan.temporaryIdentity, plan.content)) { rollbackIncomplete = true; continue }
        if (plan.before === null) fs.unlinkSync(plan.path)
        else {
          const restorePath = `${plan.path}.xingmang-rollback-${randomUUID()}.tmp`
          const restoreIdentity = stage(restorePath, plan.before)
          try {
            if (!ownedFile(plan.path, plan.temporaryIdentity, plan.content)) throw new Error('changed')
            fs.renameSync(restorePath, plan.path)
          } finally {
            if (ownedFile(restorePath, restoreIdentity, plan.before)) fs.unlinkSync(restorePath)
          }
        }
      } catch { rollbackIncomplete = true }
    }
    throw new Error(rollbackIncomplete
      ? `${label}写入失败，部分文件已被其他程序修改，未覆盖外部改动；请从 .bak 备份恢复`
      : `${label}未完成，原配置已保留或恢复；账号可能已切换或文件被其他程序修改，请重试`)
  } finally {
    for (const plan of prepared) {
      try { if (ownedFile(plan.temporaryPath, plan.temporaryIdentity, plan.content)) fs.unlinkSync(plan.temporaryPath) } catch { /* Never remove a temporary file replaced by another writer. */ }
    }
  }
  return { files: plans.map((plan) => plan.path), backups: prepared.flatMap((plan) => plan.backupPath ? [plan.backupPath] : []) }
}
