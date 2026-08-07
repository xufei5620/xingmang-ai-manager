import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sameLocalPathIdentity } from './path-identity'

export interface NativeCliUninstallOptions {
  actualDirectory: string
  expectedDirectory: string
  fileNames: readonly string[]
  label: string
  platform?: NodeJS.Platform
  removeDirectoryWhenEmpty?: boolean
  expectedSymbolicLinks?: Readonly<Record<string, string>>
  expectedSymbolicLinkIdentities?: Readonly<Record<string, NativeCliSymbolicLinkIdentity>>
  expectedSymbolicLinkRootDirectory?: string
  expectedSymbolicLinkRootDirectoryIdentity?: NativeCliDirectoryIdentity
  expectedResolvedSymbolicLinkTargets?: Readonly<Record<string, NativeCliResolvedSymbolicLinkTarget>>
  expectedOwnerUid?: number
  expectedDirectoryIdentity?: NativeCliDirectoryIdentity
}

export interface NativeCliDirectoryIdentity {
  dev: number
  ino: number
  mode: number
  uid: number
}

export interface NativeCliSymbolicLinkIdentity {
  dev: bigint
  ino: bigint
  mode: bigint
  uid: bigint
  gid: bigint
  nlink: bigint
  size: bigint
  ctimeNs: bigint
  birthtimeNs: bigint
}

export interface NativeCliRegularFileIdentity {
  dev: bigint
  ino: bigint
  mode: bigint
  size: bigint
  ctimeNs: bigint
  mtimeNs: bigint
}

export interface NativeCliResolvedSymbolicLinkTarget {
  path: string
  identity: NativeCliRegularFileIdentity
}

export interface NativeCliUninstallResult {
  directory: string
  removedFiles: string[]
  retainedQuarantineFiles: string[]
  directoryRemoved: boolean
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value).replace(/[\\/]$/, '')
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

function requirePlainDirectory(
  actualDirectory: string,
  expectedDirectory: string,
  label: string,
  platform: NodeJS.Platform,
  expectedIdentity?: NativeCliDirectoryIdentity,
): string {
  const actual = path.resolve(actualDirectory)
  const expected = path.resolve(expectedDirectory)
  if (normalizedPath(actual, platform) !== normalizedPath(expected, platform)) {
    throw new Error(`检测到非标准 ${label} 安装目录 ${actual}，为避免误删，请使用该发行版自带的卸载方式`)
  }
  let stats: fs.Stats
  try {
    stats = fs.lstatSync(actual)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} 安装目录已不存在，请刷新后重试`)
    }
    throw error
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} 安装目录被链接替换，已停止卸载`)
  }
  if (expectedIdentity && (
    stats.dev !== expectedIdentity.dev
    || stats.ino !== expectedIdentity.ino
    || stats.mode !== expectedIdentity.mode
    || stats.uid !== expectedIdentity.uid
  )) {
    throw new Error(`${label} 安装目录与已验证卸载计划不一致，已停止卸载`)
  }
  const realDirectory = fs.realpathSync.native?.(actual) ?? fs.realpathSync(actual)
  if (!sameLocalPathIdentity(realDirectory, actual)) {
    throw new Error(`${label} 安装目录经过了符号链接或目录联接，已停止卸载`)
  }
  return realDirectory
}

function requireSafeFileName(fileName: string): void {
  if (!fileName || fileName.includes('\0') || path.basename(fileName) !== fileName) {
    throw new Error('原生 CLI 卸载文件名无效')
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
}

function symbolicLinkIdentity(stats: fs.BigIntStats): NativeCliSymbolicLinkIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    nlink: stats.nlink,
    size: stats.size,
    ctimeNs: stats.ctimeNs,
    birthtimeNs: stats.birthtimeNs,
  }
}

function sameSymbolicLinkIdentity(
  left: NativeCliSymbolicLinkIdentity,
  right: NativeCliSymbolicLinkIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs
}

function sameSymbolicLinkAcrossRename(
  left: NativeCliSymbolicLinkIdentity,
  right: NativeCliSymbolicLinkIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.birthtimeNs === right.birthtimeNs
}

function sameRegularFileIdentity(
  stats: fs.BigIntStats,
  expected: NativeCliRegularFileIdentity,
): boolean {
  return stats.dev === expected.dev
    && stats.ino === expected.ino
    && stats.mode === expected.mode
    && stats.size === expected.size
    && stats.ctimeNs === expected.ctimeNs
    && stats.mtimeNs === expected.mtimeNs
}

interface VerifiedSymbolicLinkTargetContext {
  rootDirectory: string
  rootDirectoryIdentity: NativeCliDirectoryIdentity
}

interface VerifiedUninstallFile {
  fileName: string
  filePath: string
  quarantinePath: string
  identity: fs.Stats
  symbolicLinkIdentity: NativeCliSymbolicLinkIdentity | null
  symbolicLinkTarget: string | null
  resolvedSymbolicLinkTarget: NativeCliResolvedSymbolicLinkTarget | null
  moved: boolean
}

async function matchesVerifiedFileAtPath(
  file: VerifiedUninstallFile,
  candidatePath: string,
): Promise<boolean> {
  if (file.symbolicLinkTarget !== null) {
    if (!file.symbolicLinkIdentity) return false
    const before = await fs.promises.lstat(candidatePath, { bigint: true })
    const beforeIdentity = symbolicLinkIdentity(before)
    if (
      !before.isSymbolicLink()
      || !sameSymbolicLinkIdentity(beforeIdentity, file.symbolicLinkIdentity)
    ) {
      return false
    }
    if (await fs.promises.readlink(candidatePath) !== file.symbolicLinkTarget) return false
    const afterTargetRead = await fs.promises.lstat(candidatePath, { bigint: true })
    const afterTargetIdentity = symbolicLinkIdentity(afterTargetRead)
    return afterTargetRead.isSymbolicLink()
      && sameSymbolicLinkIdentity(beforeIdentity, afterTargetIdentity)
      && sameSymbolicLinkIdentity(file.symbolicLinkIdentity, afterTargetIdentity)
  }

  const before = await fs.promises.lstat(candidatePath)
  if (!before.isFile() || before.isSymbolicLink()) return false
  const after = await fs.promises.lstat(candidatePath)
  return sameFile(before, after) && sameFile(file.identity, after)
}

async function captureVerifiedSymbolicLinkAfterRename(
  file: VerifiedUninstallFile,
): Promise<NativeCliSymbolicLinkIdentity | null> {
  if (file.symbolicLinkTarget === null || !file.symbolicLinkIdentity) return null
  const beforeTargetRead = await fs.promises.lstat(file.quarantinePath, { bigint: true })
  const renamedIdentity = symbolicLinkIdentity(beforeTargetRead)
  if (
    !beforeTargetRead.isSymbolicLink()
    || !sameSymbolicLinkAcrossRename(file.symbolicLinkIdentity, renamedIdentity)
  ) {
    return null
  }
  file.symbolicLinkIdentity = renamedIdentity
  if (await fs.promises.readlink(file.quarantinePath) !== file.symbolicLinkTarget) return null
  const afterTargetRead = await fs.promises.lstat(file.quarantinePath, { bigint: true })
  const afterTargetIdentity = symbolicLinkIdentity(afterTargetRead)
  return afterTargetRead.isSymbolicLink()
    && sameSymbolicLinkIdentity(renamedIdentity, afterTargetIdentity)
    ? afterTargetIdentity
    : null
}

async function requireVerifiedSymbolicLinkTarget(
  file: VerifiedUninstallFile,
  candidatePath: string,
  label: string,
  platform: NodeJS.Platform,
  context: VerifiedSymbolicLinkTargetContext | null,
): Promise<void> {
  if (!file.resolvedSymbolicLinkTarget || !context || file.symbolicLinkTarget === null) return
  const rootDirectory = requirePlainDirectory(
    context.rootDirectory,
    context.rootDirectory,
    label,
    platform,
    context.rootDirectoryIdentity,
  )
  try {
    const linkTarget = await fs.promises.readlink(candidatePath)
    if (
      linkTarget !== file.symbolicLinkTarget
      || !linkTarget
      || linkTarget.includes('\0')
      || path.isAbsolute(linkTarget)
    ) {
      throw new Error('符号链接文本发生变化')
    }
    const resolvedTarget = await fs.promises.realpath(path.resolve(path.dirname(candidatePath), linkTarget))
    requirePlainDirectory(
      context.rootDirectory,
      context.rootDirectory,
      label,
      platform,
      context.rootDirectoryIdentity,
    )
    if (
      !isPathInside(rootDirectory, resolvedTarget)
      || resolvedTarget !== file.resolvedSymbolicLinkTarget.path
    ) {
      throw new Error('解析路径发生变化')
    }
    const stats = await fs.promises.stat(resolvedTarget, { bigint: true })
    if (!stats.isFile() || !sameRegularFileIdentity(stats, file.resolvedSymbolicLinkTarget.identity)) {
      throw new Error('普通文件身份发生变化')
    }
  } catch (error) {
    throw new Error(`${label} 符号链接 ${file.fileName} 目标与卸载计划不一致，已停止卸载`, { cause: error })
  }
}

async function prepareVerifiedFile(
  directory: string,
  fileName: string,
  label: string,
  platform: NodeJS.Platform,
  required: boolean,
  expectedSymbolicLinkTarget?: string,
  expectedSymbolicLinkIdentity?: NativeCliSymbolicLinkIdentity,
  expectedResolvedSymbolicLinkTarget?: NativeCliResolvedSymbolicLinkTarget,
  expectedOwnerUid?: number,
  symbolicLinkTargetContext: VerifiedSymbolicLinkTargetContext | null = null,
): Promise<VerifiedUninstallFile | null> {
  requireSafeFileName(fileName)
  const filePath = path.join(directory, fileName)
  let before: fs.Stats
  try {
    before = await fs.promises.lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) return null
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} 主程序 ${fileName} 已不存在，请刷新后重试`)
    }
    throw error
  }
  if (expectedSymbolicLinkTarget !== undefined) {
    if (
      !expectedSymbolicLinkTarget
      || expectedSymbolicLinkTarget.includes('\0')
      || path.isAbsolute(expectedSymbolicLinkTarget)
    ) {
      throw new Error(`${label} 符号链接 ${fileName} 的卸载计划无效`)
    }
    if (!before.isSymbolicLink() || before.nlink !== 1) {
      throw new Error(`${label} 文件 ${fileName} 不是卸载计划中的唯一符号链接，已停止卸载`)
    }
    if (!expectedSymbolicLinkIdentity) {
      throw new Error(`${label} 符号链接 ${fileName} 的卸载计划缺少身份`)
    }
    const plannedIdentity = symbolicLinkIdentity(await fs.promises.lstat(filePath, { bigint: true }))
    if (!sameSymbolicLinkIdentity(plannedIdentity, expectedSymbolicLinkIdentity)) {
      throw new Error(`${label} 符号链接 ${fileName} 身份与卸载计划不一致，已停止卸载`)
    }
    if (expectedOwnerUid === undefined || before.uid !== expectedOwnerUid) {
      throw new Error(`${label} 符号链接 ${fileName} 所有者与卸载计划不一致，已停止卸载`)
    }
    const file: VerifiedUninstallFile = {
      fileName,
      filePath,
      quarantinePath: path.join(directory, `.${fileName}-${randomUUID()}.removing`),
      identity: before,
      symbolicLinkIdentity: plannedIdentity,
      symbolicLinkTarget: expectedSymbolicLinkTarget,
      resolvedSymbolicLinkTarget: expectedResolvedSymbolicLinkTarget ?? null,
      moved: false,
    }
    if (await fs.promises.readlink(filePath) !== expectedSymbolicLinkTarget) {
      throw new Error(`${label} 符号链接 ${fileName} 与卸载计划不一致，已停止卸载`)
    }
    if (!await matchesVerifiedFileAtPath(file, filePath)) {
      throw new Error(`${label} 符号链接 ${fileName} 在卸载前发生变化，已停止卸载`)
    }
    await requireVerifiedSymbolicLinkTarget(file, filePath, label, platform, symbolicLinkTargetContext)
    return file
  }

  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`${label} 文件 ${fileName} 不是单链接普通文件，已停止卸载`)
  }
  const realFile = fs.realpathSync.native?.(filePath) ?? fs.realpathSync(filePath)
  if (!sameLocalPathIdentity(realFile, filePath)) {
    throw new Error(`${label} 文件 ${fileName} 被链接替换，已停止卸载`)
  }
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const opened = await handle.stat()
    const current = await fs.promises.lstat(filePath)
    if (!sameFile(before, opened) || !sameFile(opened, current)) {
      throw new Error(`${label} 文件 ${fileName} 在卸载前发生变化，已停止卸载`)
    }
  } finally {
    await handle.close()
  }
  return {
    fileName,
    filePath,
    quarantinePath: path.join(directory, `.${fileName}-${randomUUID()}.removing`),
    identity: before,
    symbolicLinkIdentity: null,
    symbolicLinkTarget: null,
    resolvedSymbolicLinkTarget: null,
    moved: false,
  }
}

async function requireVerifiedQuarantineFile(
  file: VerifiedUninstallFile,
  label: string,
): Promise<void> {
  try {
    if (await matchesVerifiedFileAtPath(file, file.quarantinePath)) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} 隔离文件 ${file.fileName} 在最终删除前已不存在`)
    }
    throw new Error(`${label} 隔离文件 ${file.fileName} 在最终删除前发生变化`, { cause: error })
  }
  throw new Error(`${label} 隔离文件 ${file.fileName} 在最终删除前发生变化`)
}

async function moveVerifiedFilesToQuarantine(
  files: VerifiedUninstallFile[],
  label: string,
  directory: string,
  platform: NodeJS.Platform,
  expectedDirectoryIdentity?: NativeCliDirectoryIdentity,
  symbolicLinkTargetContext: VerifiedSymbolicLinkTargetContext | null = null,
): Promise<void> {
  try {
    requirePlainDirectory(directory, directory, label, platform, expectedDirectoryIdentity)
    for (const file of files) {
      requirePlainDirectory(directory, directory, label, platform, expectedDirectoryIdentity)
      if (file.symbolicLinkTarget !== null) {
        if (!await matchesVerifiedFileAtPath(file, file.filePath)) {
          throw new Error(`${label} 文件 ${file.fileName} 在卸载提交前发生变化`)
        }
        await requireVerifiedSymbolicLinkTarget(
          file,
          file.filePath,
          label,
          platform,
          symbolicLinkTargetContext,
        )
      }
      await fs.promises.rename(file.filePath, file.quarantinePath)
      file.moved = true
      if (file.symbolicLinkTarget !== null) {
        const renamedIdentity = await captureVerifiedSymbolicLinkAfterRename(file)
        if (!renamedIdentity) {
          throw new Error(`${label} 文件 ${file.fileName} 在卸载提交时发生变化`)
        }
        file.symbolicLinkIdentity = renamedIdentity
        await requireVerifiedSymbolicLinkTarget(
          file,
          file.quarantinePath,
          label,
          platform,
          symbolicLinkTargetContext,
        )
      } else if (!await matchesVerifiedFileAtPath(file, file.quarantinePath)) {
        throw new Error(`${label} 文件 ${file.fileName} 在卸载提交时发生变化`)
      }
      requirePlainDirectory(directory, directory, label, platform, expectedDirectoryIdentity)
    }
    for (const file of files) {
      if (file.symbolicLinkTarget === null) continue
      requirePlainDirectory(directory, directory, label, platform, expectedDirectoryIdentity)
      await requireVerifiedQuarantineFile(file, label)
      await requireVerifiedSymbolicLinkTarget(
        file,
        file.quarantinePath,
        label,
        platform,
        symbolicLinkTargetContext,
      )
    }
    requirePlainDirectory(directory, directory, label, platform, expectedDirectoryIdentity)
  } catch (error) {
    const rollbackErrors: string[] = []
    for (const file of [...files].reverse()) {
      if (!file.moved) continue
      try {
        try {
          await fs.promises.lstat(file.filePath)
          throw new Error('原路径已被其他文件占用')
        } catch (pathError) {
          if ((pathError as NodeJS.ErrnoException).code !== 'ENOENT') throw pathError
        }
        await requireVerifiedQuarantineFile(file, label)
        await fs.promises.rename(file.quarantinePath, file.filePath)
      } catch (rollbackError) {
        rollbackErrors.push(`${file.fileName}：${String(rollbackError)}`)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${label} 卸载失败且文件回滚不完整：${rollbackErrors.join('；')}`, { cause: error })
    }
    throw error
  }
}

/** The first file name is the required primary executable; later entries are optional helpers. */
export async function uninstallVerifiedNativeCliFiles(
  options: NativeCliUninstallOptions,
): Promise<NativeCliUninstallResult> {
  if (!options.fileNames.length) throw new Error('原生 CLI 卸载清单为空')
  const platform = options.platform ?? process.platform
  const directory = requirePlainDirectory(
    options.actualDirectory,
    options.expectedDirectory,
    options.label,
    platform,
    options.expectedDirectoryIdentity,
  )
  const files: VerifiedUninstallFile[] = []
  const targetVerificationFields = [
    options.expectedSymbolicLinkRootDirectory,
    options.expectedSymbolicLinkRootDirectoryIdentity,
    options.expectedResolvedSymbolicLinkTargets,
  ]
  const usesResolvedTargetVerification = targetVerificationFields.some((value) => value !== undefined)
  if (usesResolvedTargetVerification && (
    !options.expectedSymbolicLinks
    || !options.expectedSymbolicLinkRootDirectory
    || !path.isAbsolute(options.expectedSymbolicLinkRootDirectory)
    || !options.expectedSymbolicLinkRootDirectoryIdentity
    || !options.expectedResolvedSymbolicLinkTargets
  )) {
    throw new Error(`${options.label} 符号链接卸载计划缺少完整目标身份`)
  }
  let symbolicLinkTargetContext: VerifiedSymbolicLinkTargetContext | null = null
  if (
    options.expectedSymbolicLinkRootDirectory
    && options.expectedSymbolicLinkRootDirectoryIdentity
    && options.expectedResolvedSymbolicLinkTargets
  ) {
    const rootDirectory = requirePlainDirectory(
      options.expectedSymbolicLinkRootDirectory,
      options.expectedSymbolicLinkRootDirectory,
      options.label,
      platform,
      options.expectedSymbolicLinkRootDirectoryIdentity,
    )
    if (!isPathInside(rootDirectory, directory)) {
      throw new Error(`${options.label} 安装目录不在已验证目标根目录内，已停止卸载`)
    }
    symbolicLinkTargetContext = {
      rootDirectory,
      rootDirectoryIdentity: options.expectedSymbolicLinkRootDirectoryIdentity,
    }
  }
  const expectedOwnerUid = options.expectedSymbolicLinks
    ? options.expectedOwnerUid ?? process.getuid?.()
    : undefined
  if (
    options.expectedSymbolicLinks
    && (expectedOwnerUid === undefined || !Number.isSafeInteger(expectedOwnerUid) || expectedOwnerUid < 0)
  ) {
    throw new Error(`${options.label} 符号链接卸载计划缺少有效所有者`)
  }
  if (options.expectedSymbolicLinks && !options.expectedSymbolicLinkIdentities) {
    throw new Error(`${options.label} 符号链接卸载计划缺少身份`)
  }
  for (const [index, fileName] of options.fileNames.entries()) {
    const hasExpectedLink = options.expectedSymbolicLinks
      ? Object.prototype.hasOwnProperty.call(options.expectedSymbolicLinks, fileName)
      : false
    if (options.expectedSymbolicLinks && !hasExpectedLink) {
      throw new Error(`${options.label} 文件 ${fileName} 未包含在符号链接卸载计划中`)
    }
    const expectedResolvedTarget = hasExpectedLink && options.expectedResolvedSymbolicLinkTargets
      ? options.expectedResolvedSymbolicLinkTargets[fileName]
      : undefined
    if (symbolicLinkTargetContext && (
      !expectedResolvedTarget
      || !path.isAbsolute(expectedResolvedTarget.path)
      || !isPathInside(symbolicLinkTargetContext.rootDirectory, expectedResolvedTarget.path)
    )) {
      throw new Error(`${options.label} 符号链接 ${fileName} 的卸载计划缺少有效目标身份`)
    }
    const file = await prepareVerifiedFile(
      directory,
      fileName,
      options.label,
      platform,
      index === 0,
      hasExpectedLink ? options.expectedSymbolicLinks![fileName] : undefined,
      hasExpectedLink ? options.expectedSymbolicLinkIdentities![fileName] : undefined,
      expectedResolvedTarget,
      expectedOwnerUid,
      symbolicLinkTargetContext,
    )
    if (file) files.push(file)
  }
  await moveVerifiedFilesToQuarantine(
    files,
    options.label,
    directory,
    platform,
    options.expectedDirectoryIdentity,
    symbolicLinkTargetContext,
  )

  const retainedQuarantineFiles: string[] = []
  const removableQuarantineFiles: VerifiedUninstallFile[] = []
  for (const file of files) {
    if (platform === 'darwin' && file.symbolicLinkTarget !== null) {
      // Node has no inode-bound unlink on macOS. The verified command name is
      // already gone, so retain the quarantine pathname instead of racing rm().
      retainedQuarantineFiles.push(file.quarantinePath)
    } else {
      removableQuarantineFiles.push(file)
    }
  }
  for (const file of removableQuarantineFiles) {
    await requireVerifiedQuarantineFile(file, options.label)
  }
  for (const file of removableQuarantineFiles) {
    await requireVerifiedQuarantineFile(file, options.label)
    try {
      await fs.promises.rm(file.quarantinePath, { force: true })
    } catch {
      // The declared command paths are already gone. A locked quarantine file
      // is harmless; expose its path so callers can report deferred cleanup.
      retainedQuarantineFiles.push(file.quarantinePath)
    }
  }
  const removedFiles = files.map((file) => file.fileName)
  let directoryRemoved = false
  if (options.removeDirectoryWhenEmpty !== false) {
    try {
      await fs.promises.rmdir(directory)
      directoryRemoved = true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw error
    }
  }
  return { directory, removedFiles, retainedQuarantineFiles, directoryRemoved }
}
