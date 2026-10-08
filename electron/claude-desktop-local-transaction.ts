import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertSafeDataFile, ensureSafeDataDirectory, readSafeUtf8FileSync, removeSafeDataFileSync, renameWithTransientRetrySync } from './safe-local-data'

const label = 'Claude Desktop 第三方推理配置'
const maximumBytes = 512 * 1024
// 每次保存给改到的每个文件留一份 .bak.<随机>，里面有旧 Key，以前从来不清（已知20）。
// 同 config-files.ts 的 MAX_BACKUPS_PER_FILE，每个文件只留最近 5 份。
const maximumBackupsPerFile = 5
const backupIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
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

/**
 * 只认这里自己起的名字（randomUUID 那种后缀），手工或别的程序放的 .bak 不碰。名字是随机的，
 * 先后只能看修改时间；刚留的那份无论如何不删。清不掉的照旧留着：保存已经成功了，不能因为
 * 清备份变成失败。
 */
function pruneBackups(filePath: string, latest: string): void {
  const directory = path.dirname(filePath)
  const prefix = `${path.basename(filePath)}.bak.`
  const latestName = path.basename(latest)
  let names: string[]
  try { names = fs.readdirSync(directory) } catch { return }
  const older: { path: string; modified: bigint }[] = []
  for (const name of names) {
    if (name === latestName || !name.startsWith(prefix) || !backupIdPattern.test(name.slice(prefix.length))) continue
    const candidate = path.join(directory, name)
    try { older.push({ path: candidate, modified: fs.lstatSync(candidate, { bigint: true }).mtimeNs }) } catch { continue }
  }
  older.sort((left, right) => left.modified === right.modified ? 0 : left.modified > right.modified ? -1 : 1)
  for (const backup of older.slice(maximumBackupsPerFile - 1)) {
    try { removeSafeDataFileSync(backup.path, label) } catch { /* Kept: the save itself already succeeded. */ }
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
    // Windows 上安全软件正扫着刚写好的暂存文件或目标文件时，换过去会被拒（EPERM / EBUSY），
    // 过一会儿就好，等一下再试（第三十七批 C）。账号和各文件的检查每次试之前都重做：
    // 等的那一下，账号可能已切换，Claude Desktop 也可能刚存了自己的改动。
    for (const plan of prepared) {
      renameWithTransientRetrySync(plan.temporaryPath, plan.path, () => {
        assertContext()
        assertSnapshots()
        if (!ownedFile(plan.temporaryPath, plan.temporaryIdentity, plan.content)) throw new Error(`${label}暂存文件发生变化`)
        assertSafeDataFile(plan.path, label)
      })
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
            renameWithTransientRetrySync(restorePath, plan.path, () => {
              if (!ownedFile(plan.path, plan.temporaryIdentity, plan.content)) throw new Error('changed')
            })
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
  // 只在整次保存成功以后清：没成功时那句报错要客户从 .bak 恢复。
  for (const plan of prepared) if (plan.backupPath) pruneBackups(plan.path, plan.backupPath)
  return { files: plans.map((plan) => plan.path), backups: prepared.flatMap((plan) => plan.backupPath ? [plan.backupPath] : []) }
}
