import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readBoundedUtf8FileSync } from './bounded-file'
import { readDirectoryEntriesSync } from './bounded-directory'
import { isProviderId, type ProviderId } from './catalog'
import { providerConfigRoot, type ProviderConfigRoots } from './codex-home'
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

export type ConfigBackupRootKind = 'user-home' | 'codex-home'

export interface ConfigBackupManifestV1 {
  version: 1
  id: string
  provider: ProviderId
  reason: ConfigBackupReason
  createdAt: string
  files: ConfigBackupFile[]
}

export interface ConfigBackupFileV2 extends ConfigBackupFile {
  targetRoot: ConfigBackupRootKind
}

/**
 * 备份那一刻配置里那把 Key 的归属。`digest` 是 Key 的 SHA-256：同目录的备份文件
 * 本来就存着 Key 明文，多存一份摘要不增加暴露面，却让列表不必逐个解析四家 CLI
 * 的配置格式。`accountId` / `accountName` 只在那把 Key 正是当时登录账号由本软件
 * 签发的那把时才记，缺省 = 不知道是谁的。旧版本读到这个字段会直接忽略。
 */
export interface ConfigBackupKeyRecord {
  digest: string | null
  accountId?: string
  accountName?: string
}

export interface ConfigBackupManifestV2 {
  version: 2
  id: string
  provider: ProviderId
  reason: ConfigBackupReason
  createdAt: string
  files: ConfigBackupFileV2[]
  key?: ConfigBackupKeyRecord
}

export type ConfigBackupManifest = ConfigBackupManifestV1 | ConfigBackupManifestV2

/**
 * `current` = 当前账号由本软件签发的那把；`other` = 别的 Key（记得是哪个账号时
 * 带上 `keyAccountName`）；`none` = 备份里没有 Key；`unknown` = 旧备份没记，或者
 * 没登录又说不出是谁的。
 */
export type ConfigBackupKeyOwnership = 'current' | 'other' | 'none' | 'unknown'

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
  /** 缺省 = 旧行为（不标归属）。只有账号名，从不带 Key 或摘要（I3）。 */
  keyOwnership?: ConfigBackupKeyOwnership
  keyAccountName?: string | null
}

/**
 * 列表 / 预览 / 创建时由调用方（ipc.ts）按当前登录态读好传进来。`keyDigests`
 * 是本软件替这个账号签发过的 Key 的摘要；备份库本身不碰账号与 Key 缓存。
 */
export interface ConfigBackupAccountContext {
  accountId: string
  accountName: string
  keyDigests: ReadonlySet<string>
}

export interface ConfigBackupPreview extends ConfigBackupSummary {
  files: ConfigBackupFile[]
}

export interface ConfigRestoreResult {
  provider: ProviderId
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
  providerRoots?: ProviderConfigRoots
  // Legacy callers still provide one home. It implies the historical ~/.codex root.
  homeDirectory?: string
  now?: () => Date
  hooks?: ConfigBackupHooks
}

interface ValidatedBackup {
  directory: string
  manifest: ConfigBackupManifest
  targets: Array<ConfigBackupFile & {
    targetPath: string
    backupPath: string | null
    rootDirectory: string
  }>
}

interface RestorePlan {
  rootDirectory: string
  targetPath: string
  desiredExisted: boolean
  desiredSize: number
  desiredSha256: string | null
  backupPath: string | null
  temporaryPath: string | null
  temporarySnapshot: fs.BigIntStats | null
  rollbackPath: string
  rollbackCreated: boolean
  rollbackSnapshot: fs.BigIntStats | null
  previousSnapshot: fs.BigIntStats | null
  committedSnapshot: fs.BigIntStats | null | undefined
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
const MAX_ACCOUNT_ID_LENGTH = 256
const MAX_ACCOUNT_NAME_LENGTH = 128

export function apiKeyDigest(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex')
}

/** 备份那一刻的归属只看 Key 本身：同一把 Key 在当时账号的签发名单里，才记账号。 */
export function buildBackupKeyRecord(
  apiKey: string,
  context: ConfigBackupAccountContext | null | undefined,
): ConfigBackupKeyRecord {
  if (!apiKey) return { digest: null }
  const digest = apiKeyDigest(apiKey)
  if (!context || !context.keyDigests.has(digest)) return { digest }
  return {
    digest,
    accountId: context.accountId.slice(0, MAX_ACCOUNT_ID_LENGTH),
    accountName: context.accountName.slice(0, MAX_ACCOUNT_NAME_LENGTH),
  }
}

export function classifyBackupKey(
  record: ConfigBackupKeyRecord | undefined,
  context: ConfigBackupAccountContext | null | undefined,
): { keyOwnership: ConfigBackupKeyOwnership, keyAccountName: string | null } {
  if (!record) return { keyOwnership: 'unknown', keyAccountName: null }
  if (record.digest === null) return { keyOwnership: 'none', keyAccountName: null }
  if (context?.keyDigests.has(record.digest)) return { keyOwnership: 'current', keyAccountName: null }
  // 记下来的是同一个账号、但名单里已经没有这把 Key（被删掉或换过）：说它是
  // 「当前账号的」会让用户恢复出一把已经作废的 Key，所以不带账号名。
  if (record.accountName && record.accountId !== context?.accountId) {
    return { keyOwnership: 'other', keyAccountName: record.accountName }
  }
  return { keyOwnership: context ? 'other' : 'unknown', keyAccountName: null }
}

function parseKeyRecord(value: unknown): ConfigBackupKeyRecord | undefined {
  // 这个字段只用来显示，坏了就当旧备份没记，不能让整份备份变成「校验失败」。
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (input.digest === null) return { digest: null }
  if (typeof input.digest !== 'string' || !SHA256_PATTERN.test(input.digest)) return undefined
  const record: ConfigBackupKeyRecord = { digest: input.digest }
  if (
    typeof input.accountId === 'string' && input.accountId && input.accountId.length <= MAX_ACCOUNT_ID_LENGTH
    && typeof input.accountName === 'string' && input.accountName.trim()
    && input.accountName.length <= MAX_ACCOUNT_NAME_LENGTH
  ) {
    record.accountId = input.accountId
    record.accountName = input.accountName.trim()
  }
  return record
}

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

function relativeToRoot(targetPath: string, rootDirectory: string): string {
  const relative = path.relative(path.resolve(rootDirectory), path.resolve(targetPath))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('配置目标不在指定根目录内')
  }
  return requireSafeRelativePath(relative.split(path.sep).join('/'), '配置目标')
}

function rootKindForProvider(provider: ProviderId): ConfigBackupRootKind {
  return provider === 'codex' ? 'codex-home' : 'user-home'
}

function rootForKind(kind: ConfigBackupRootKind, roots: ProviderConfigRoots): string {
  return kind === 'codex-home' ? roots.codexHome : roots.userHome
}

function rootRelativeTargetKey(kind: ConfigBackupRootKind, relativePath: string): string {
  return `${kind}:${normalizedPathKey(relativePath)}`
}

function assertSafeTargetPath(targetPath: string, rootDirectory: string): void {
  const root = path.resolve(rootDirectory)
  const target = path.resolve(targetPath)
  if (normalizedPathKey(target) === normalizedPathKey(root) || !isPathInside(target, root)) {
    throw new Error('配置目标越过 Provider 根目录')
  }
  assertNoReparseComponents(root, 'Provider 配置根目录')
  assertNoReparseComponents(target, '配置目标')
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

function assertBackupFileMatches(filePath: string, size: number, sha256: string): void {
  assertNoReparseComponents(filePath, '备份文件')
  const stats = assertRegularFile(filePath, '备份文件')
  if (stats.size !== size || sha256File(filePath) !== sha256) {
    throw new Error('备份文件已损坏或被篡改')
  }
}

function fileSnapshotIfPresent(filePath: string, label: string): fs.BigIntStats | null {
  try {
    const stats = fs.lstatSync(filePath, { bigint: true })
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${label}必须是普通文件`)
    return stats
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function sameFileSnapshot(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return sameFileContentIdentity(left, right)
    && left.ctimeNs === right.ctimeNs
}

function sameFileContentIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
}

function assertFileMatchesSnapshot(
  filePath: string,
  snapshot: fs.BigIntStats,
  label: string,
): fs.BigIntStats {
  const current = fileSnapshotIfPresent(filePath, label)
  if (!current || !sameFileSnapshot(current, snapshot)) {
    throw new Error(`${label}在恢复期间发生变化`)
  }
  return current
}

function assertPathAbsent(filePath: string, label: string): void {
  try {
    fs.lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error(`${label}在恢复期间发生变化`)
}

interface AllowedTarget {
  targetPath: string
  rootDirectory: string
}

function v2AllowedTargetMap(
  provider: ProviderId,
  roots: ProviderConfigRoots,
): Map<string, AllowedTarget> {
  const inspection = inspectProviderConfig(provider, roots)
  const targetRoot = rootKindForProvider(provider)
  const manifestRoot = rootForKind(targetRoot, roots)
  const providerRoot = providerConfigRoot(provider, roots)
  const result = new Map<string, AllowedTarget>()
  for (const file of inspection.files) {
    const relative = relativeToRoot(file.path, manifestRoot)
    assertSafeTargetPath(file.path, providerRoot)
    result.set(rootRelativeTargetKey(targetRoot, relative), {
      targetPath: path.resolve(file.path),
      rootDirectory: path.resolve(providerRoot),
    })
  }
  return result
}

function v1AllowedTargetMap(
  provider: ProviderId,
  roots: ProviderConfigRoots,
): Map<string, AllowedTarget> {
  const historicalRoots = {
    userHome: roots.userHome,
    codexHome: path.join(roots.userHome, '.codex'),
  }
  const inspection = inspectProviderConfig(provider, historicalRoots)
  const providerRoot = providerConfigRoot(provider, historicalRoots)
  const result = new Map<string, AllowedTarget>()
  for (const file of inspection.files) {
    const relative = relativeToRoot(file.path, historicalRoots.userHome)
    assertSafeTargetPath(file.path, providerRoot)
    result.set(normalizedPathKey(relative), {
      targetPath: path.resolve(file.path),
      rootDirectory: path.resolve(providerRoot),
    })
  }
  return result
}

function requireBackupRootKind(value: unknown): ConfigBackupRootKind {
  if (value !== 'user-home' && value !== 'codex-home') {
    throw new Error('配置目标根目录无效')
  }
  return value
}

function parseManifestValue(value: unknown): ConfigBackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('备份清单必须是 JSON 对象')
  const input = value as Record<string, unknown>
  if (input.version !== 1 && input.version !== 2) throw new Error('备份清单版本不受支持')
  const version = input.version
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
  const files = input.files.map((entry, index): ConfigBackupFile | ConfigBackupFileV2 => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`备份文件 ${index + 1} 无效`)
    const item = entry as Record<string, unknown>
    const targetRelativePath = requireSafeRelativePath(item.targetRelativePath, '配置目标')
    const targetRoot = version === 2 ? requireBackupRootKind(item.targetRoot) : null
    const targetKey = targetRoot
      ? rootRelativeTargetKey(targetRoot, targetRelativePath)
      : normalizedPathKey(targetRelativePath)
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
      const file: ConfigBackupFile = {
        targetRelativePath,
        backupRelativePath: null,
        existed: false,
        size: 0,
        sha256: null,
      }
      return targetRoot ? { ...file, targetRoot } : file
    }

    const backupRelativePath = requireSafeRelativePath(item.backupRelativePath, '备份文件路径')
    if (!backupRelativePath.startsWith('files/')) throw new Error('备份文件必须位于 files 目录')
    const sourceKey = normalizedPathKey(backupRelativePath)
    if (sources.has(sourceKey)) throw new Error('备份清单包含重复文件')
    sources.add(sourceKey)
    if (typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256)) {
      throw new Error('备份文件 SHA-256 无效')
    }
    const file: ConfigBackupFile = {
      targetRelativePath,
      backupRelativePath,
      existed: true,
      size: item.size as number,
      sha256: item.sha256,
    }
    return targetRoot ? { ...file, targetRoot } : file
  })
  const common = {
    id,
    provider: input.provider,
    reason: input.reason as ConfigBackupReason,
    createdAt: new Date(input.createdAt).toISOString(),
  }
  if (version === 1) return { version, ...common, files: files as ConfigBackupFile[] }
  const key = parseKeyRecord(input.key)
  return { version, ...common, files: files as ConfigBackupFileV2[], ...(key ? { key } : {}) }
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
  roots: ProviderConfigRoots,
  id: string,
): ValidatedBackup {
  const directory = validateBackupDirectory(userDataDirectory, id)
  const manifest = readManifest(directory)
  if (manifest.id !== id) throw new Error('备份清单 ID 与目录不一致')
  if (
    manifest.version === 1
    && manifest.provider === 'codex'
    && normalizedPathKey(roots.codexHome) !== normalizedPathKey(path.join(roots.userHome, '.codex'))
  ) {
    throw new Error('旧版 Codex 备份仅可在默认 ~/.codex 根目录手动恢复')
  }
  const allowed = manifest.version === 1
    ? v1AllowedTargetMap(manifest.provider, roots)
    : v2AllowedTargetMap(manifest.provider, roots)
  const targets = manifest.files.map((file) => {
    const targetKey = manifest.version === 1
      ? normalizedPathKey(file.targetRelativePath)
      : rootRelativeTargetKey((file as ConfigBackupFileV2).targetRoot, file.targetRelativePath)
    const allowedTarget = allowed.get(targetKey)
    if (!allowedTarget) throw new Error('备份清单包含未授权的配置目标')
    const { targetPath, rootDirectory } = allowedTarget
    assertSafeTargetPath(targetPath, rootDirectory)
    if (!file.existed) return { ...file, targetPath, backupPath: null, rootDirectory }

    const backupPath = path.resolve(directory, ...file.backupRelativePath!.split('/'))
    if (!isPathInside(backupPath, path.join(directory, 'files'))) throw new Error('备份文件路径越界')
    assertNoReparseComponents(backupPath, '备份文件')
    const stats = assertRegularFile(backupPath, '备份文件')
    if (stats.size !== file.size) throw new Error('备份文件已损坏或被篡改')
    return { ...file, targetPath, backupPath, rootDirectory }
  })
  return { directory, manifest, targets }
}

function validateBackup(
  userDataDirectory: string,
  roots: ProviderConfigRoots,
  id: string,
): ValidatedBackup {
  const validated = validateBackupManifest(userDataDirectory, roots, id)
  for (const target of validated.targets) {
    if (target.backupPath) {
      assertBackupFileMatches(target.backupPath, target.size, target.sha256!)
    }
  }
  return validated
}

function summaryFromManifest(
  manifest: ConfigBackupManifest,
  context?: ConfigBackupAccountContext | null,
): ConfigBackupSummary {
  return {
    ...classifyBackupKey(manifest.version === 2 ? manifest.key : undefined, context),
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
  private readonly providerRoots: ProviderConfigRoots
  private readonly now: () => Date
  private readonly hooks: ConfigBackupHooks

  constructor(options: ConfigBackupStoreOptions) {
    this.userDataDirectory = path.resolve(options.userDataDirectory)
    const userHome = path.resolve(
      options.providerRoots?.userHome ?? options.homeDirectory ?? os.homedir(),
    )
    this.providerRoots = {
      userHome,
      codexHome: path.resolve(options.providerRoots?.codexHome ?? path.join(userHome, '.codex')),
    }
    this.now = options.now ?? (() => new Date())
    this.hooks = options.hooks ?? {}
  }

  list(context?: ConfigBackupAccountContext | null): ConfigBackupSummary[] {
    const root = backupRoot(this.userDataDirectory)
    if (!fs.existsSync(root)) return []
    ensureSafeDataDirectory(root, '配置备份目录')
    const entries = readDirectoryEntriesSync(root, MAX_BACKUP_ENTRIES, '配置备份目录')
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && BACKUP_ID_PATTERN.test(entry.name))
      .map((entry): ConfigBackupSummary => {
        try {
          const validated = validateBackupManifest(this.userDataDirectory, this.providerRoots, entry.name)
          return summaryFromManifest(validated.manifest, context)
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

  inspect(id: string, context?: ConfigBackupAccountContext | null): ConfigBackupPreview {
    const validated = validateBackup(this.userDataDirectory, this.providerRoots, id)
    const files = validated.manifest.files.map((file): ConfigBackupFile => ({
      targetRelativePath: file.targetRelativePath,
      backupRelativePath: file.backupRelativePath,
      existed: file.existed,
      size: file.size,
      sha256: file.sha256,
    }))
    return { ...summaryFromManifest(validated.manifest, context), files }
  }

  create(
    provider: ProviderId,
    reason: ConfigBackupReason = 'manual',
    protectId?: string,
    context?: ConfigBackupAccountContext | null,
  ): ConfigBackupSummary {
    if (!isProviderId(provider)) throw new Error('未知的配置类型')
    if (!BACKUP_REASONS.includes(reason)) throw new Error('未知的备份原因')
    const createdAt = this.now()
    const id = backupId(createdAt)
    const root = backupRoot(this.userDataDirectory)
    const finalDirectory = backupDirectory(this.userDataDirectory, id)
    const temporaryDirectory = path.join(root, `.${id}.${randomUUID()}.tmp`)
    const filesDirectory = path.join(temporaryDirectory, 'files')
    const inspection = inspectProviderConfig(provider, this.providerRoots)
    const targetRoot = rootKindForProvider(provider)
    const manifestRoot = rootForKind(targetRoot, this.providerRoots)
    const providerRoot = providerConfigRoot(provider, this.providerRoots)
    ensureSafeDataDirectory(root, '配置备份目录')
    fs.mkdirSync(filesDirectory, { recursive: true, mode: 0o700 })

    try {
      const files = inspection.files.map((file, index): ConfigBackupFileV2 => {
        const targetRelativePath = relativeToRoot(file.path, manifestRoot)
        assertSafeTargetPath(file.path, providerRoot)
        if (!fs.existsSync(file.path)) {
          return {
            targetRoot,
            targetRelativePath,
            backupRelativePath: null,
            existed: false,
            size: 0,
            sha256: null,
          }
        }
        this.hooks.beforeBackupFile?.(file.path, index)
        assertSafeTargetPath(file.path, providerRoot)
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
          targetRoot,
          targetRelativePath,
          backupRelativePath,
          existed: true,
          size: copiedStats.size,
          sha256: sha256File(targetPath),
        }
      })
      // 复制完再读一次：备份期间配置被改写，复制到的与开头读到的就可能不是同一把
      // Key。对不上宁可不记，列表显示成「未记录」，也不标一个错的账号。
      const copiedKey = inspectProviderConfig(provider, this.providerRoots).apiKey
      const manifest: ConfigBackupManifestV2 = {
        version: 2,
        id,
        provider,
        reason,
        createdAt: createdAt.toISOString(),
        files,
        ...(copiedKey === inspection.apiKey ? { key: buildBackupKeyRecord(inspection.apiKey, context) } : {}),
      }
      writeDurableJson(path.join(temporaryDirectory, 'manifest.json'), manifest)
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
      fs.renameSync(temporaryDirectory, finalDirectory)
      this.prune(root, protectId)
      return summaryFromManifest(manifest, context)
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

  restore(id: string, context?: ConfigBackupAccountContext | null): ConfigRestoreResult {
    let validated = validateBackup(this.userDataDirectory, this.providerRoots, id)
    const restoreProvider = validated.manifest.provider
    const preRestore = this.create(restoreProvider, 'pre-restore', id, context)
    validated = validateBackup(this.userDataDirectory, this.providerRoots, id)
    if (validated.manifest.provider !== restoreProvider) {
      throw new Error('备份清单在恢复期间发生变化')
    }
    const plans: RestorePlan[] = []
    const committed: RestorePlan[] = []
    // 回退 rename 失败时 rollbackPath 是用户当前配置的唯一副本，finally 绝不能清理它。
    const preserveRollback = new Set<RestorePlan>()

    try {
      for (const target of validated.targets) {
        assertSafeTargetPath(target.targetPath, target.rootDirectory)
        fs.mkdirSync(path.dirname(target.targetPath), { recursive: true, mode: 0o700 })
        assertSafeTargetPath(target.targetPath, target.rootDirectory)
        const previousSnapshot = fileSnapshotIfPresent(target.targetPath, '当前配置文件')
        const temporaryPath = target.existed
          ? `${target.targetPath}.xingmang-restore-${randomUUID()}.tmp`
          : null
        const plan: RestorePlan = {
          rootDirectory: target.rootDirectory,
          targetPath: target.targetPath,
          desiredExisted: target.existed,
          desiredSize: target.size,
          desiredSha256: target.sha256,
          backupPath: target.backupPath,
          temporaryPath,
          temporarySnapshot: null,
          rollbackPath: `${target.targetPath}.xingmang-rollback-${randomUUID()}.tmp`,
          rollbackCreated: false,
          rollbackSnapshot: null,
          previousSnapshot,
          committedSnapshot: undefined,
        }
        plans.push(plan)
        if (temporaryPath && target.backupPath) {
          assertSafeTargetPath(temporaryPath, target.rootDirectory)
          assertBackupFileMatches(target.backupPath, target.size, target.sha256!)
          copyDurable(target.backupPath, temporaryPath)
          assertSafeTargetPath(temporaryPath, target.rootDirectory)
          assertBackupFileMatches(temporaryPath, target.size, target.sha256!)
          plan.temporarySnapshot = fileSnapshotIfPresent(temporaryPath, '恢复临时文件')
        }
      }

      plans.forEach((plan, index) => {
        try {
          assertSafeTargetPath(plan.targetPath, plan.rootDirectory)
          assertSafeTargetPath(plan.rollbackPath, plan.rootDirectory)
          if (plan.temporaryPath) assertSafeTargetPath(plan.temporaryPath, plan.rootDirectory)
          assertPathAbsent(plan.rollbackPath, '配置回滚路径')
          if (plan.previousSnapshot) {
            assertFileMatchesSnapshot(plan.targetPath, plan.previousSnapshot, '当前配置文件')
            fs.renameSync(plan.targetPath, plan.rollbackPath)
            plan.rollbackCreated = true
            plan.rollbackSnapshot = fileSnapshotIfPresent(plan.rollbackPath, '配置回滚文件')
            if (
              !plan.rollbackSnapshot
              || !sameFileContentIdentity(plan.rollbackSnapshot, plan.previousSnapshot)
            ) {
              throw new Error('配置回滚文件在移动期间发生变化')
            }
          } else {
            assertPathAbsent(plan.targetPath, '配置目标')
          }
          assertPathAbsent(plan.targetPath, '配置目标')
          this.hooks.beforeRestoreCommit?.(plan.targetPath, index)
          assertSafeTargetPath(plan.targetPath, plan.rootDirectory)
          assertSafeTargetPath(plan.rollbackPath, plan.rootDirectory)
          assertPathAbsent(plan.targetPath, '配置目标')
          if (plan.rollbackSnapshot) {
            assertFileMatchesSnapshot(plan.rollbackPath, plan.rollbackSnapshot, '配置回滚文件')
          }
          if (plan.desiredExisted && plan.temporaryPath) {
            assertSafeTargetPath(plan.temporaryPath, plan.rootDirectory)
            if (!plan.temporarySnapshot || !plan.desiredSha256) {
              throw new Error('恢复临时文件状态无效')
            }
            assertFileMatchesSnapshot(plan.temporaryPath, plan.temporarySnapshot, '恢复临时文件')
            assertBackupFileMatches(plan.temporaryPath, plan.desiredSize, plan.desiredSha256)
            fs.renameSync(plan.temporaryPath, plan.targetPath)
            plan.temporarySnapshot = null
            plan.committedSnapshot = fileSnapshotIfPresent(plan.targetPath, '已恢复配置文件')
            if (!plan.committedSnapshot) throw new Error('恢复配置文件丢失')
          } else {
            plan.committedSnapshot = null
          }
          committed.push(plan)
        } catch (error) {
          // 第一步 rename 失败时 targetPath 仍是用户当前配置，绝不能删除。
          if (plan.rollbackCreated && plan.previousSnapshot && plan.rollbackSnapshot) {
            try {
              assertSafeTargetPath(plan.targetPath, plan.rootDirectory)
              assertSafeTargetPath(plan.rollbackPath, plan.rootDirectory)
              assertFileMatchesSnapshot(plan.rollbackPath, plan.rollbackSnapshot, '配置回滚文件')
              assertPathAbsent(plan.targetPath, '配置目标')
              fs.renameSync(plan.rollbackPath, plan.targetPath)
              plan.rollbackCreated = false
              const restoredSnapshot = fileSnapshotIfPresent(plan.targetPath, '当前配置文件')
              if (!restoredSnapshot || !sameFileContentIdentity(restoredSnapshot, plan.rollbackSnapshot)) {
                throw new Error('当前配置文件在回滚期间发生变化')
              }
              plan.rollbackSnapshot = null
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
        if (!plan.rollbackCreated || !plan.rollbackSnapshot) continue
        try {
          assertSafeTargetPath(plan.rollbackPath, plan.rootDirectory)
          assertFileMatchesSnapshot(plan.rollbackPath, plan.rollbackSnapshot, '配置回滚文件')
          removeIfPresent(plan.rollbackPath)
          plan.rollbackCreated = false
          plan.rollbackSnapshot = null
        } catch {
          // The restored configuration is already committed. A cleanup failure
          // must not start a rollback after earlier rollback files were removed.
        }
      }
      return {
        provider: restoreProvider,
        restoredBackupId: id,
        preRestoreBackupId: preRestore.id,
        restoredFiles: plans.filter((plan) => plan.desiredExisted).map((plan) => plan.targetPath),
        removedFiles: plans.filter((plan) => !plan.desiredExisted).map((plan) => plan.targetPath),
      }
    } catch (error) {
      const rollbackErrors: string[] = []
      for (const plan of [...committed].reverse()) {
        try {
          assertSafeTargetPath(plan.targetPath, plan.rootDirectory)
          if (plan.committedSnapshot) {
            assertFileMatchesSnapshot(plan.targetPath, plan.committedSnapshot, '已恢复配置文件')
          } else {
            assertPathAbsent(plan.targetPath, '配置目标')
          }
          if (plan.rollbackCreated && plan.rollbackSnapshot) {
            assertSafeTargetPath(plan.rollbackPath, plan.rootDirectory)
            assertFileMatchesSnapshot(plan.rollbackPath, plan.rollbackSnapshot, '配置回滚文件')
          }
          if (plan.committedSnapshot) removeIfPresent(plan.targetPath)
          if (plan.rollbackCreated && plan.rollbackSnapshot) {
            fs.renameSync(plan.rollbackPath, plan.targetPath)
            plan.rollbackCreated = false
            const restoredSnapshot = fileSnapshotIfPresent(plan.targetPath, '当前配置文件')
            if (!restoredSnapshot || !sameFileContentIdentity(restoredSnapshot, plan.rollbackSnapshot)) {
              throw new Error('当前配置文件在回滚期间发生变化')
            }
            plan.rollbackSnapshot = null
          }
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
        if (plan.temporaryPath && plan.temporarySnapshot) {
          try {
            assertSafeTargetPath(plan.temporaryPath, plan.rootDirectory)
            assertFileMatchesSnapshot(plan.temporaryPath, plan.temporarySnapshot, '恢复临时文件')
            removeIfPresent(plan.temporaryPath)
            plan.temporarySnapshot = null
          } catch {
            // Never follow a path that became a reparse point during cleanup.
          }
        }
        if (plan.rollbackCreated && plan.rollbackSnapshot && !preserveRollback.has(plan)) {
          try {
            assertSafeTargetPath(plan.rollbackPath, plan.rootDirectory)
            assertFileMatchesSnapshot(plan.rollbackPath, plan.rollbackSnapshot, '配置回滚文件')
            removeIfPresent(plan.rollbackPath)
            plan.rollbackCreated = false
            plan.rollbackSnapshot = null
          } catch {
            // Never follow a path that became a reparse point during cleanup.
          }
        }
      }
    }
  }
}
