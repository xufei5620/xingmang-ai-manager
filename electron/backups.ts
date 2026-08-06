import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readBoundedUtf8FileSync } from './bounded-file'
import { readDirectoryEntriesSync } from './bounded-directory'
import { isProviderId, type ProviderId } from './catalog'
import { inspectProviderConfig } from './config-files'
import { assertNoReparseComponents, ensureSafeDataDirectory } from './safe-local-data'

export type ConfigBackupReason = 'manual' | 'pre-save' | 'pre-restore'

export interface ConfigBackupFile {
  targetRelativePath: string
  backupRelativePath: string | null
  existed: boolean
  size: number
  sha256: string | null
}

export interface ConfigBackupManifest {
  version: 1
  id: string
  provider: ProviderId
  reason: ConfigBackupReason
  createdAt: string
  files: ConfigBackupFile[]
}

export interface ConfigBackupSummary {
  id: string
  provider: ProviderId | null
  reason: ConfigBackupReason | null
  createdAt: string | null
  fileCount: number
  existingFileCount: number
  totalSize: number
  valid: boolean
  error: string | null
}

export interface ConfigBackupPreview extends ConfigBackupSummary {
  files: ConfigBackupFile[]
}

export interface ConfigRestoreResult {
  restoredBackupId: string
  preRestoreBackupId: string
  restoredFiles: string[]
  removedFiles: string[]
}

export interface ConfigBackupHooks {
  beforeBackupFile?: (targetPath: string, index: number) => void
  beforeRestoreCommit?: (targetPath: string, index: number) => void
}

export interface ConfigBackupStoreOptions {
  userDataDirectory: string
  homeDirectory?: string
  now?: () => Date
  hooks?: ConfigBackupHooks
}

interface ValidatedBackup {
  directory: string
  manifest: ConfigBackupManifest
  targets: Array<ConfigBackupFile & { targetPath: string; backupPath: string | null }>
}

interface RestorePlan {
  targetPath: string
  desiredExisted: boolean
  backupPath: string | null
  temporaryPath: string | null
  rollbackPath: string
  previousExisted: boolean
}

const BACKUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
// prune 的 200 条配额只统计 backupId() 产出的目录；宽松的 BACKUP_ID_PATTERN 会把
// corrupt-manifest 之类的字母目录也计入配额且永不清理，挤掉真实备份。
const RETAINED_BACKUP_ID_PATTERN = /^\d{17}-[0-9a-f-]{36}$/i
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_BACKUP_FILE_BYTES = 2 * 1024 * 1024
const MAX_BACKUP_ENTRIES = 2_000
// 低于 MAX_BACKUP_ENTRIES，保证目录不会增长到 list() 永久不可用。
const MAX_RETAINED_BACKUPS = 200
const STALE_TEMPORARY_PATTERN = /^\..*\.tmp$/
const BACKUP_REASONS: readonly ConfigBackupReason[] = ['manual', 'pre-save', 'pre-restore']

function normalizedPathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function requireSafeId(value: string): string {
  if (!BACKUP_ID_PATTERN.test(value)) throw new Error('备份 ID 格式错误')
  return value
}

function requireSafeRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new Error(`${label}格式错误`)
  }
  const normalized = value.replaceAll('\\', '/')
  if (
    path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(value)
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label}不是安全的相对路径`)
  }
  return normalized
}

function relativeToHome(targetPath: string, homeDirectory: string): string {
  const relative = path.relative(path.resolve(homeDirectory), path.resolve(targetPath))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('配置目标不在用户目录内')
  }
  return requireSafeRelativePath(relative.split(path.sep).join('/'), '配置目标')
}

function backupRoot(userDataDirectory: string): string {
  if (!userDataDirectory.trim() || userDataDirectory.includes('\0')) throw new Error('userData 目录格式错误')
  return path.join(path.resolve(userDataDirectory), 'backups')
}

function backupDirectory(userDataDirectory: string, id: string): string {
  return path.join(backupRoot(userDataDirectory), requireSafeId(id))
}

function sha256File(filePath: string): string {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead)
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function writeDurableJson(filePath: string, value: unknown): void {
  const descriptor = fs.openSync(filePath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' })
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function copyDurable(sourcePath: string, targetPath: string): void {
  fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(targetPath, 0o600)
  const descriptor = fs.openSync(targetPath, 'r+')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function removeIfPresent(filePath: string, recursiveDirectory = false): void {
  try {
    const stats = fs.lstatSync(filePath)
    if (stats.isDirectory() && !stats.isSymbolicLink() && !recursiveDirectory) {
      throw new Error(`拒绝将备份文件清理扩大为目录删除：${filePath}`)
    }
    fs.rmSync(filePath, { recursive: recursiveDirectory, force: false })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function assertRegularFile(filePath: string, label: string): fs.Stats {
  const stats = fs.lstatSync(filePath)
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${label}必须是普通文件`)
  return stats
}

function assertNoSymlinkParents(targetPath: string, homeDirectory: string): void {
  const home = path.resolve(homeDirectory)
  if (!isPathInside(targetPath, home)) throw new Error('配置目标越界')
  const relativeDirectory = path.relative(home, path.dirname(path.resolve(targetPath)))
  let current = home
  for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (!fs.existsSync(current)) break
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('配置目录不能包含符号链接')
  }
}

function allowedTargetMap(provider: ProviderId, homeDirectory: string): Map<string, string> {
  const inspection = inspectProviderConfig(provider, homeDirectory)
  const result = new Map<string, string>()
  for (const file of inspection.files) {
    const relative = relativeToHome(file.path, homeDirectory)
    result.set(normalizedPathKey(relative), file.path)
  }
  return result
}

function parseManifestValue(value: unknown): ConfigBackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('备份清单必须是 JSON 对象')
  const input = value as Record<string, unknown>
  if (input.version !== 1) throw new Error('备份清单版本不受支持')
  if (typeof input.id !== 'string') throw new Error('备份清单缺少 ID')
  const id = requireSafeId(input.id)
  if (!isProviderId(input.provider)) throw new Error('备份清单的工具类型无效')
  if (!BACKUP_REASONS.includes(input.reason as ConfigBackupReason)) throw new Error('备份原因无效')
  if (typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error('备份时间无效')
  }
  if (!Array.isArray(input.files) || input.files.length > 16) throw new Error('备份文件列表无效')

  const targets = new Set<string>()
  const sources = new Set<string>()
  const files = input.files.map((entry, index): ConfigBackupFile => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`备份文件 ${index + 1} 无效`)
    const item = entry as Record<string, unknown>
    const targetRelativePath = requireSafeRelativePath(item.targetRelativePath, '配置目标')
    const targetKey = normalizedPathKey(targetRelativePath)
    if (targets.has(targetKey)) throw new Error('备份清单包含重复配置目标')
    targets.add(targetKey)
    if (typeof item.existed !== 'boolean') throw new Error('备份文件 existed 无效')
    if (!Number.isSafeInteger(item.size) || (item.size as number) < 0) throw new Error('备份文件 size 无效')
    if ((item.size as number) > MAX_BACKUP_FILE_BYTES) {
      throw new Error('备份文件超过 2048 KB 安全上限')
    }

    if (!item.existed) {
      if (item.backupRelativePath !== null || item.sha256 !== null || item.size !== 0) {
        throw new Error('不存在文件的备份元数据不一致')
      }
      return { targetRelativePath, backupRelativePath: null, existed: false, size: 0, sha256: null }
    }

    const backupRelativePath = requireSafeRelativePath(item.backupRelativePath, '备份文件路径')
    if (!backupRelativePath.startsWith('files/')) throw new Error('备份文件必须位于 files 目录')
    const sourceKey = normalizedPathKey(backupRelativePath)
    if (sources.has(sourceKey)) throw new Error('备份清单包含重复文件')
    sources.add(sourceKey)
    if (typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256)) {
      throw new Error('备份文件 SHA-256 无效')
    }
    return {
      targetRelativePath,
      backupRelativePath,
      existed: true,
      size: item.size as number,
      sha256: item.sha256,
    }
  })
  return {
    version: 1,
    id,
    provider: input.provider,
    reason: input.reason as ConfigBackupReason,
    createdAt: new Date(input.createdAt).toISOString(),
    files,
  }
}

function readManifest(directory: string): ConfigBackupManifest {
  const manifestPath = path.join(directory, 'manifest.json')
  const stats = assertRegularFile(manifestPath, '备份清单')
  if (stats.size > MAX_MANIFEST_BYTES) throw new Error('备份清单过大')
  let parsed: unknown
  try {
    parsed = JSON.parse(readBoundedUtf8FileSync(
      manifestPath,
      MAX_MANIFEST_BYTES,
      '备份清单',
    )) as unknown
  } catch {
    throw new Error('备份清单不是有效 JSON')
  }
  return parseManifestValue(parsed)
}

function validateBackupDirectory(userDataDirectory: string, id: string): string {
  const root = backupRoot(userDataDirectory)
  ensureSafeDataDirectory(root, '配置备份目录')
  const directory = backupDirectory(userDataDirectory, id)
  if (!isPathInside(directory, root)) throw new Error('备份路径越界')
  assertNoReparseComponents(directory, '配置备份目录')
  const directoryStats = fs.lstatSync(directory)
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) throw new Error('备份目录无效')
  return directory
}

// list() 高频调用，只做清单与存在性校验；SHA-256 留给 inspect()/restore()，避免同步全量哈希阻塞。
function validateBackupManifest(
  userDataDirectory: string,
  homeDirectory: string,
  id: string,
): ValidatedBackup {
  const directory = validateBackupDirectory(userDataDirectory, id)
  const manifest = readManifest(directory)
  if (manifest.id !== id) throw new Error('备份清单 ID 与目录不一致')
  const allowed = allowedTargetMap(manifest.provider, homeDirectory)
  const targets = manifest.files.map((file) => {
    const targetPath = allowed.get(normalizedPathKey(file.targetRelativePath))
    if (!targetPath) throw new Error('备份清单包含未授权的配置目标')
    assertNoSymlinkParents(targetPath, homeDirectory)
    if (!file.existed) return { ...file, targetPath, backupPath: null }

    const backupPath = path.resolve(directory, ...file.backupRelativePath!.split('/'))
    if (!isPathInside(backupPath, path.join(directory, 'files'))) throw new Error('备份文件路径越界')
    assertNoReparseComponents(backupPath, '备份文件')
    const stats = assertRegularFile(backupPath, '备份文件')
    if (stats.size !== file.size) throw new Error('备份文件已损坏或被篡改')
    return { ...file, targetPath, backupPath }
  })
  return { directory, manifest, targets }
}

function validateBackup(
  userDataDirectory: string,
  homeDirectory: string,
  id: string,
): ValidatedBackup {
  const validated = validateBackupManifest(userDataDirectory, homeDirectory, id)
  for (const target of validated.targets) {
    if (target.backupPath && sha256File(target.backupPath) !== target.sha256) {
      throw new Error('备份文件已损坏或被篡改')
    }
  }
  return validated
}

function summaryFromManifest(manifest: ConfigBackupManifest): ConfigBackupSummary {
  return {
    id: manifest.id,
    provider: manifest.provider,
    reason: manifest.reason,
    createdAt: manifest.createdAt,
    fileCount: manifest.files.length,
    existingFileCount: manifest.files.filter((file) => file.existed).length,
    totalSize: manifest.files.reduce((sum, file) => sum + file.size, 0),
    valid: true,
    error: null,
  }
}

function backupId(now: Date): string {
  const timestamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
  return `${timestamp}-${randomUUID()}`
}

export class ConfigBackupStore {
  private readonly userDataDirectory: string
  private readonly homeDirectory: string
  private readonly now: () => Date
  private readonly hooks: ConfigBackupHooks

  constructor(options: ConfigBackupStoreOptions) {
    this.userDataDirectory = path.resolve(options.userDataDirectory)
    this.homeDirectory = path.resolve(options.homeDirectory ?? os.homedir())
    this.now = options.now ?? (() => new Date())
    this.hooks = options.hooks ?? {}
  }

  list(): ConfigBackupSummary[] {
    const root = backupRoot(this.userDataDirectory)
    if (!fs.existsSync(root)) return []
    ensureSafeDataDirectory(root, '配置备份目录')
    const entries = readDirectoryEntriesSync(root, MAX_BACKUP_ENTRIES, '配置备份目录')
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && BACKUP_ID_PATTERN.test(entry.name))
      .map((entry): ConfigBackupSummary => {
        try {
          const validated = validateBackupManifest(this.userDataDirectory, this.homeDirectory, entry.name)
          return summaryFromManifest(validated.manifest)
        } catch (error) {
          return {
            id: entry.name,
            provider: null,
            reason: null,
            createdAt: null,
            fileCount: 0,
            existingFileCount: 0,
            totalSize: 0,
            valid: false,
            error: error instanceof Error ? error.message : '备份无效',
          }
        }
      })
      .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? '') || right.id.localeCompare(left.id))
  }

  inspect(id: string): ConfigBackupPreview {
    const validated = validateBackup(this.userDataDirectory, this.homeDirectory, id)
    return { ...summaryFromManifest(validated.manifest), files: validated.manifest.files.map((file) => ({ ...file })) }
  }

  create(provider: ProviderId, reason: ConfigBackupReason = 'manual', protectId?: string): ConfigBackupSummary {
    if (!isProviderId(provider)) throw new Error('未知的配置类型')
    if (!BACKUP_REASONS.includes(reason)) throw new Error('未知的备份原因')
    const createdAt = this.now()
    const id = backupId(createdAt)
    const root = backupRoot(this.userDataDirectory)
    const finalDirectory = backupDirectory(this.userDataDirectory, id)
    const temporaryDirectory = path.join(root, `.${id}.${randomUUID()}.tmp`)
    const filesDirectory = path.join(temporaryDirectory, 'files')
    const inspection = inspectProviderConfig(provider, this.homeDirectory)
    ensureSafeDataDirectory(root, '配置备份目录')
    fs.mkdirSync(filesDirectory, { recursive: true, mode: 0o700 })

    try {
      const files = inspection.files.map((file, index): ConfigBackupFile => {
        const targetRelativePath = relativeToHome(file.path, this.homeDirectory)
        assertNoSymlinkParents(file.path, this.homeDirectory)
        if (!fs.existsSync(file.path)) {
          return { targetRelativePath, backupRelativePath: null, existed: false, size: 0, sha256: null }
        }
        this.hooks.beforeBackupFile?.(file.path, index)
        const stats = assertRegularFile(file.path, '配置文件')
        if (stats.size > MAX_BACKUP_FILE_BYTES) {
          throw new Error('配置文件超过 2048 KB 备份安全上限')
        }
        const safeBaseName = path.basename(file.path).replace(/[^A-Za-z0-9._-]/g, '_') || 'config'
        const backupRelativePath = `files/${String(index).padStart(3, '0')}-${safeBaseName}`
        const targetPath = path.join(temporaryDirectory, ...backupRelativePath.split('/'))
        copyDurable(file.path, targetPath)
        const copiedStats = assertRegularFile(targetPath, '备份文件')
        if (stats.size !== copiedStats.size) throw new Error('配置文件在备份期间发生变化')
        return {
          targetRelativePath,
          backupRelativePath,
          existed: true,
          size: copiedStats.size,
          sha256: sha256File(targetPath),
        }
      })
      const manifest: ConfigBackupManifest = {
        version: 1,
        id,
        provider,
        reason,
        createdAt: createdAt.toISOString(),
        files,
      }
      writeDurableJson(path.join(temporaryDirectory, 'manifest.json'), manifest)
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
      fs.renameSync(temporaryDirectory, finalDirectory)
      this.prune(root, protectId)
      return summaryFromManifest(manifest)
    } catch (error) {
      removeIfPresent(temporaryDirectory, true)
      throw error
    }
  }

  delete(id: string): void {
    const directory = validateBackupDirectory(this.userDataDirectory, id)
    fs.rmSync(directory, { recursive: true, force: false })
  }

  private prune(root: string, keepId?: string): void {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true })
      for (const entry of entries) {
        if (!STALE_TEMPORARY_PATTERN.test(entry.name)) continue
        const stalePath = path.join(root, entry.name)
        try {
          if (fs.lstatSync(stalePath).isSymbolicLink()) continue
          fs.rmSync(stalePath, { recursive: true, force: true })
        } catch {
          // 单条清理失败（如并发竞态 ENOENT）不能中止其余清理。
        }
      }
      const retained = entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && RETAINED_BACKUP_ID_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort()
      for (const name of retained.slice(0, Math.max(0, retained.length - MAX_RETAINED_BACKUPS))) {
        // keepId 正在被 restore 读取：校验通过不等于文件还在，删掉它会让恢复中途 ENOENT 且数据丢失。
        if (name === keepId) continue
        try {
          fs.rmSync(path.join(root, name), { recursive: true, force: false })
        } catch {
          // 单条清理失败（如并发竞态 ENOENT）不能中止其余清理。
        }
      }
    } catch {
      // 保留策略失败不能让已成功落盘的备份创建报错。
    }
  }

  restore(id: string): ConfigRestoreResult {
    const validated = validateBackup(this.userDataDirectory, this.homeDirectory, id)
    const preRestore = this.create(validated.manifest.provider, 'pre-restore', id)
    const plans: RestorePlan[] = []
    const committed: RestorePlan[] = []
    // 回退 rename 失败时 rollbackPath 是用户当前配置的唯一副本，finally 绝不能清理它。
    const preserveRollback = new Set<RestorePlan>()

    try {
      for (const target of validated.targets) {
        fs.mkdirSync(path.dirname(target.targetPath), { recursive: true, mode: 0o700 })
        const previousExisted = fs.existsSync(target.targetPath)
        if (previousExisted) assertRegularFile(target.targetPath, '当前配置文件')
        const temporaryPath = target.existed
          ? `${target.targetPath}.xingmang-restore-${randomUUID()}.tmp`
          : null
        if (temporaryPath && target.backupPath) copyDurable(target.backupPath, temporaryPath)
        plans.push({
          targetPath: target.targetPath,
          desiredExisted: target.existed,
          backupPath: target.backupPath,
          temporaryPath,
          rollbackPath: `${target.targetPath}.xingmang-rollback-${randomUUID()}.tmp`,
          previousExisted,
        })
      }

      plans.forEach((plan, index) => {
        let movedPrevious = false
        try {
          if (plan.previousExisted) {
            fs.renameSync(plan.targetPath, plan.rollbackPath)
            movedPrevious = true
          }
          this.hooks.beforeRestoreCommit?.(plan.targetPath, index)
          if (plan.desiredExisted && plan.temporaryPath) fs.renameSync(plan.temporaryPath, plan.targetPath)
          committed.push(plan)
        } catch (error) {
          // 第一步 rename 失败时 targetPath 仍是用户当前配置，绝不能删除。
          if (movedPrevious) {
            removeIfPresent(plan.targetPath)
            try {
              fs.renameSync(plan.rollbackPath, plan.targetPath)
            } catch {
              preserveRollback.add(plan)
              const primary = error instanceof Error ? error.message : String(error)
              throw new Error(`${primary}；当前配置已保留在 ${plan.rollbackPath}`)
            }
          }
          throw error
        }
      })

      for (const plan of committed) {
        try {
          removeIfPresent(plan.rollbackPath)
        } catch {
          // The restored configuration is already committed. A cleanup failure
          // must not start a rollback after earlier rollback files were removed.
        }
      }
      return {
        restoredBackupId: id,
        preRestoreBackupId: preRestore.id,
        restoredFiles: plans.filter((plan) => plan.desiredExisted).map((plan) => plan.targetPath),
        removedFiles: plans.filter((plan) => !plan.desiredExisted).map((plan) => plan.targetPath),
      }
    } catch (error) {
      const rollbackErrors: string[] = []
      for (const plan of [...committed].reverse()) {
        try {
          removeIfPresent(plan.targetPath)
          if (plan.previousExisted) fs.renameSync(plan.rollbackPath, plan.targetPath)
        } catch (rollbackError) {
          preserveRollback.add(plan)
          rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError))
        }
      }
      if (rollbackErrors.length) {
        const primary = error instanceof Error ? error.message : String(error)
        throw new Error(`${primary}；回滚失败：${rollbackErrors.join('；')}`)
      }
      throw error
    } finally {
      for (const plan of plans) {
        if (plan.temporaryPath) removeIfPresent(plan.temporaryPath)
        if (!committed.includes(plan) && !preserveRollback.has(plan)) removeIfPresent(plan.rollbackPath)
      }
    }
  }
}
