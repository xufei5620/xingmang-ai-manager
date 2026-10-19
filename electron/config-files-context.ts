// 读写工具配置文件的共用底层（#1070 第 10 步，从 config-files.ts 原样搬来）：读配置文本（只认单链接普通文件、
// 去掉字节顺序标记、有大小上限），写之前查路径（I8），两阶段提交 + .bak + 失败回滚（I9），各家配置的位置
// providerConfigPaths，以及几家配置都用的 JSON 小工具。config-files.ts 和从它拆出去的文件都拿这一份。
//
// 这里只 import config-files.ts 的类型：值要是也从那边拿，两个文件就互相 require 了。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProviderId } from './catalog'
import { readBoundedUtf8FileSync } from './bounded-file'
import {
  defaultProviderConfigRoots,
  providerConfigRoot,
  type ProviderConfigRoots,
} from './codex-home'
import { configBackupSuffix, staleConfigBackups, uniqueConfigBackupPath } from './config-file-backups'
import type { FilePlan, FileRemovePlan, NativeConfigSaveResult, NativeConfigWriteHooks } from './config-files'
import { assertNoReparseComponents, renameWithTransientRetrySync } from './safe-local-data'
import { resolveRelocatedPath } from './relocated-folders'
import { configLinkRefusalMessage } from './config-link-refusal'

export const MAX_NATIVE_CONFIG_BYTES = 2 * 1024 * 1024

function isRemovePlan(plan: FilePlan): plan is FileRemovePlan {
  return 'remove' in plan
}

export function normalizeProviderConfigRoots(
  roots: ProviderConfigRoots = defaultProviderConfigRoots(),
): ProviderConfigRoots {
  return {
    userHome: path.resolve(roots.userHome),
    codexHome: path.resolve(roots.codexHome),
  }
}

export function providerConfigPaths(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): string[] {
  const root = providerConfigRoot(provider, normalizeProviderConfigRoots(rootsInput))
  switch (provider) {
    case 'codex':
      return [
        path.join(root, 'config.toml'),
        path.join(root, 'auth.json'),
      ]
    case 'claude':
      return [path.join(root, 'settings.json')]
    case 'gemini':
      return [
        path.join(root, 'settings.json'),
        path.join(root, '.env'),
      ]
    case 'grok':
      return [path.join(root, 'config.toml')]
  }
}

export function readText(filePath: string): string | null {
  try {
    const info = fs.lstatSync(filePath)
    if (!info.isFile() || info.nlink > 1 || info.isSymbolicLink()) return null
    return withoutByteOrderMark(readBoundedUtf8FileSync(filePath, MAX_NATIVE_CONFIG_BYTES, '配置文件'))
  } catch {
    return null
  }
}

/**
 * Notepad on older Windows and PowerShell 5's `Set-Content -Encoding UTF8`
 * both write a UTF-8 BOM. JSON.parse and @iarna/toml reject it as an unknown
 * character, so a config the CLI itself reads fine used to be reported as
 * unparseable and never got the account key (全面检测 Q41). Writing back
 * without the BOM is harmless: every managed CLI reads plain UTF-8.
 */
export function withoutByteOrderMark(content: string): string {
  return content.replace(/^\uFEFF/, '')
}

export function requireConfigText(
  filePath: string,
  label: string,
  maximumBytes = MAX_NATIVE_CONFIG_BYTES,
): string | null {
  const content = requireRawConfigText(filePath, label, maximumBytes)
  return content === null ? null : withoutByteOrderMark(content)
}

/** 同 requireConfigText，但字节顺序标记照原样留着：定点改写要逐字节写回去。 */
export function requireRawConfigText(
  filePath: string,
  label: string,
  maximumBytes = MAX_NATIVE_CONFIG_BYTES,
): string | null {
  let info: fs.Stats
  try {
    info = fs.lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (isLinkedFile(info)) throw linkedConfigError(filePath, 'file', `${label} 必须是单链接普通文件，未执行修改`)
  if (!info.isFile() || info.nlink !== 1) {
    throw new Error(`${label} 必须是单链接普通文件，未执行修改`)
  }
  return readBoundedUtf8FileSync(filePath, maximumBytes, label)
}

/** 符号链接、硬链接都算：dotfiles 工具两种都做。 */
function isLinkedFile(info: fs.Stats): boolean {
  return info.isSymbolicLink() || (info.isFile() && info.nlink > 1)
}

/**
 * 配置文件（或路径上的文件夹）是个链接时给客户看的那句（#1100 第2条）。校验照旧拒绝，只是说法换成
 * 客户照着做得了的：在哪、为什么不写、怎么办。原来那句（带完整路径）挂在 cause 上进运行日志。
 */
function linkedConfigError(filePath: string, kind: 'file' | 'folder', detail: string): Error {
  const relative = path.relative(os.homedir(), filePath)
  const insideHome = relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  return new Error(configLinkRefusalMessage(insideHome ? `用户文件夹里的 ${relative}` : path.basename(filePath), kind), { cause: new Error(detail) })
}

/**
 * 配置文件本身是链接时，要赶在下面逐级检查之前认出来：那一步把它报成「不能经过符号链接或目录联接」，
 * 界面于是说「文件夹被搬到了别的位置」，客户去「检查」页也找不到是哪个文件夹（#1100 第2条）。
 * 这里只是先认、换个说法，后面的检查一个不少；读不到就交给后面照原样报。
 */
function assertConfigFileNotLinked(resolvedPath: string, shownPath: string): void {
  let info: fs.Stats
  try {
    info = fs.lstatSync(resolvedPath)
  } catch {
    return
  }
  if (isLinkedFile(info)) throw linkedConfigError(shownPath, 'file', `配置目标不是单链接普通文件，已拒绝写入：${resolvedPath}`)
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key]
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, unknown>
  }
  const created: Record<string, unknown> = {}
  parent[key] = created
  return created
}

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function normalizeWorkspacePathKey(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const windowsPath = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')
  const normalized = windowsPath
    ? trimmed.replace(/\//g, '\\')
    : path.posix.normalize(trimmed.replace(/\\/g, '/'))
  if (windowsPath) {
    const isDriveRoot = /^[A-Za-z]:\\$/.test(normalized)
    return isDriveRoot ? normalized.toLowerCase() : normalized.replace(/[\\]+$/, '').toLowerCase()
  }
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '')
}

// Codex on Windows may record a folder in its verbatim form (\\?\C:\...);
// strip that prefix so the same folder compares equal.
export function trustedFolderKey(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('\\\\?\\UNC\\')) return normalizeWorkspacePathKey(`\\\\${trimmed.slice(8)}`)
  return normalizeWorkspacePathKey(trimmed.startsWith('\\\\?\\') ? trimmed.slice(4) : trimmed)
}

type PreparedFilePlan = FilePlan & {
  backupPath: string | null
  existed: boolean
  temporaryPath: string
}

// 清理失败只静默跳过，绝不影响已成功的保存。
function pruneBackups(filePath: string, providerRoot: string): void {
  try {
    assertSafeConfigPath(filePath, providerRoot, 'parent')
  } catch {
    return
  }
  for (const backupPath of staleConfigBackups(filePath)) {
    try {
      assertSafeConfigPath(backupPath, providerRoot, 'file')
      removeIfPresent(backupPath)
    } catch {
      continue
    }
  }
}

function writeDurableUtf8(filePath: string, content: string, providerRoot: string): void {
  assertSafeConfigPath(filePath, providerRoot, 'file')
  const descriptor = fs.openSync(filePath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, content, { encoding: 'utf8' })
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function removeIfPresent(filePath: string): void {
  try {
    fs.rmSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function assertSafeConfigPath(filePath: string, rootDirectory: string, target: 'file' | 'parent'): void {
  // A profile moved to another disk is judged at where it lives now; any link the
  // relocation policy does not accept stays in the path and is rejected below.
  const root = resolveRelocatedPath(rootDirectory)
  const resolved = resolveRelocatedPath(filePath)
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`配置路径越过 Provider 根目录，已拒绝写入：${filePath}`)
  }

  assertNoReparseComponents(root, 'Provider 配置根目录')
  if (target === 'file') assertConfigFileNotLinked(resolved, filePath)
  const stopAt = target === 'parent' ? path.dirname(resolved) : resolved
  assertNoReparseComponents(stopAt, '配置路径')

  let canonicalRoot: string | null = null
  try {
    const rootInfo = fs.lstatSync(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error(`配置根目录不是安全的本地目录：${root}`)
    }
    canonicalRoot = fs.realpathSync.native(root)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('配置根目录')) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`无法验证配置根目录：${root}`)
    }
  }

  const segments = path.relative(root, stopAt).split(path.sep).filter(Boolean)
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    let info: fs.Stats
    try {
      info = fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (info.isSymbolicLink()) {
      throw linkedConfigError(current, target === 'file' && current === resolved ? 'file' : 'folder', `配置路径包含符号链接，已拒绝写入：${current}`)
    }
    if (target === 'parent' || current !== resolved) {
      if (!info.isDirectory()) throw new Error(`配置父路径不是目录，已拒绝写入：${current}`)
    } else if (isLinkedFile(info)) {
      throw linkedConfigError(current, 'file', `配置目标不是单链接普通文件，已拒绝写入：${current}`)
    } else if (!info.isFile()) {
      throw new Error(`配置目标不是单链接普通文件，已拒绝写入：${current}`)
    }
    if (canonicalRoot) {
      const canonical = fs.realpathSync.native(current)
      const canonicalRelative = path.relative(canonicalRoot, canonical)
      if (
        canonicalRelative.startsWith(`..${path.sep}`)
        || canonicalRelative === '..'
        || path.isAbsolute(canonicalRelative)
      ) {
        throw new Error(`配置路径指向 Provider 根目录之外，已拒绝写入：${current}`)
      }
    }
  }

  if (target === 'file') {
    try {
      const info = fs.lstatSync(resolved)
      if (isLinkedFile(info)) throw linkedConfigError(filePath, 'file', `配置目标不是单链接普通文件，已拒绝写入：${resolved}`)
      if (!info.isFile()) {
        throw new Error(`配置目标不是单链接普通文件，已拒绝写入：${resolved}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function assertSafeExistingFile(filePath: string, providerRoot: string): void {
  assertSafeConfigPath(filePath, providerRoot, 'file')
  try {
    const info = fs.lstatSync(filePath)
    if (isLinkedFile(info)) throw linkedConfigError(filePath, 'file', `配置事务源不是单链接普通文件，已拒绝写入：${filePath}`)
    if (!info.isFile()) {
      throw new Error(`配置事务源不是单链接普通文件，已拒绝写入：${filePath}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`配置事务源文件不存在，已拒绝写入：${filePath}`)
    }
    throw error
  }
}

function assertSafeSourceAndTarget(
  sourcePath: string,
  targetPath: string,
  providerRoot: string,
): void {
  assertSafeExistingFile(sourcePath, providerRoot)
  assertSafeConfigPath(targetPath, providerRoot, 'file')
}

function prepareFilePlans(plans: FilePlan[], providerRoot: string): PreparedFilePlan[] {
  const seenTargets = new Set<string>()
  const suffix = configBackupSuffix()
  return plans.map((plan) => {
    const targetKey = path.resolve(plan.path).toLowerCase()
    if (seenTargets.has(targetKey)) throw new Error(`配置写入计划包含重复路径：${plan.path}`)
    seenTargets.add(targetKey)
    assertSafeConfigPath(plan.path, providerRoot, 'parent')
    let existed = false
    try {
      const info = fs.lstatSync(plan.path)
      if (isLinkedFile(info)) throw linkedConfigError(plan.path, 'file', `配置目标不是单链接普通文件，已拒绝写入：${plan.path}`)
      if (!info.isFile()) {
        throw new Error(`配置目标不是单链接普通文件，已拒绝写入：${plan.path}`)
      }
      existed = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return {
      ...plan,
      existed,
      backupPath: existed ? uniqueConfigBackupPath(plan.path, suffix) : null,
      temporaryPath: `${plan.path}.xingmang-${randomUUID()}.tmp`,
    }
  }).filter((plan) => plan.existed || !isRemovePlan(plan))
}

function rollbackCommittedPlans(
  committed: PreparedFilePlan[],
  providerRoot: string,
): Error[] {
  const rollbackErrors: Error[] = []
  for (const plan of [...committed].reverse()) {
    if (plan.existed && plan.backupPath) {
      const rollbackPath = `${plan.path}.xingmang-rollback-${randomUUID()}.tmp`
      let rollbackCopyCreated = false
      try {
        assertSafeSourceAndTarget(plan.backupPath, rollbackPath, providerRoot)
        fs.copyFileSync(plan.backupPath, rollbackPath, fs.constants.COPYFILE_EXCL)
        rollbackCopyCreated = true
        renameWithTransientRetrySync(
          rollbackPath,
          plan.path,
          () => assertSafeSourceAndTarget(rollbackPath, plan.path, providerRoot),
        )
        rollbackCopyCreated = false
      } catch (error) {
        rollbackErrors.push(error instanceof Error ? error : new Error(String(error)))
      }
      if (rollbackCopyCreated) {
        try {
          assertSafeConfigPath(rollbackPath, providerRoot, 'file')
          removeIfPresent(rollbackPath)
        } catch (error) {
          rollbackErrors.push(error instanceof Error ? error : new Error(String(error)))
        }
      }
    } else {
      try {
        assertSafeConfigPath(plan.path, providerRoot, 'file')
        removeIfPresent(plan.path)
      } catch (error) {
        rollbackErrors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
  return rollbackErrors
}

function cleanupPreparedPlans(
  prepared: PreparedFilePlan[],
  providerRoot: string,
): Error[] {
  const cleanupErrors: Error[] = []
  for (const plan of prepared) {
    try {
      assertSafeConfigPath(plan.temporaryPath, providerRoot, 'file')
      removeIfPresent(plan.temporaryPath)
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }
  return cleanupErrors
}

export function executeFilePlans(
  plans: FilePlan[],
  hooks: NativeConfigWriteHooks,
  providerRoot: string,
  // discard：提交成功以后把这次的 .bak 删掉，不进每个文件 5 份的轮换。换线路的定点改写
  // 来回切几次就会把客户自己保存时留下的备份挤掉，那几份才是有用的（原件另由调用方留一份）。
  backupRetention: 'rotate' | 'discard' = 'rotate',
): NativeConfigSaveResult {
  const prepared = prepareFilePlans(plans, providerRoot)
  const committed: PreparedFilePlan[] = []

  try {
    // No target is touched until every new file has been written successfully.
    for (const plan of prepared) {
      if (isRemovePlan(plan)) continue
      assertSafeConfigPath(plan.path, providerRoot, 'parent')
      fs.mkdirSync(path.dirname(plan.path), { recursive: true })
      writeDurableUtf8(plan.temporaryPath, plan.content, providerRoot)
    }
    for (const plan of prepared) {
      if (plan.backupPath) {
        assertSafeSourceAndTarget(plan.path, plan.backupPath, providerRoot)
        fs.copyFileSync(plan.path, plan.backupPath, fs.constants.COPYFILE_EXCL)
      }
    }
    for (const [index, plan] of prepared.entries()) {
      // Removal moves the file aside instead of deleting it, so the rollback
      // below can still put the .bak copy back; the cleanup after a full commit
      // deletes the moved-aside file together with the other temporaries.
      const [source, target] = isRemovePlan(plan) ? [plan.path, plan.temporaryPath] : [plan.temporaryPath, plan.path]
      assertSafeSourceAndTarget(source, target, providerRoot)
      // A hook may re-read what this save was computed from (external-tool-config
      // does), so it runs again before every retry: whoever held the file may
      // have just saved its own change.
      renameWithTransientRetrySync(source, target, () => {
        hooks.beforeReplace?.(plan.path, index)
        assertSafeSourceAndTarget(source, target, providerRoot)
      })
      committed.push(plan)
    }
  } catch (error) {
    const recoveryErrors = [
      ...rollbackCommittedPlans(committed, providerRoot),
      ...cleanupPreparedPlans(prepared, providerRoot),
    ]
    if (recoveryErrors.length) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        '配置写入失败，且部分文件无法自动回滚；请从 .bak 备份恢复',
      )
    }
    throw error
  }

  const cleanupErrors = cleanupPreparedPlans(prepared, providerRoot)
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, '配置已写入，但临时文件无法安全清理')
  }

  // 必须在全部提交成功后清理：回滚依赖本次 backupPath，提前删除会破坏恢复链路。
  if (backupRetention === 'discard') {
    for (const plan of prepared) {
      if (!plan.backupPath) continue
      try {
        assertSafeConfigPath(plan.backupPath, providerRoot, 'file')
        removeIfPresent(plan.backupPath)
      } catch {
        // 删不掉只是多留一份备份，不影响已经写成的配置。
      }
    }
    return { backups: [], files: prepared.map((plan) => plan.path) }
  }
  for (const plan of prepared) pruneBackups(plan.path, providerRoot)

  return {
    backups: prepared.flatMap((plan) => plan.backupPath ? [plan.backupPath] : []),
    files: prepared.map((plan) => plan.path),
  }
}

/** 键缺省时建一张表；已经是表就用它；是别的东西（用户写坏了或另有用途）返回 null，一字不动。 */
export function fillableRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> | null {
  if (parent[key] === undefined) parent[key] = {}
  const current = parent[key]
  return isJsonRecord(current) ? current : null
}
