import fs from 'node:fs'
import path from 'node:path'
import { uninstallVerifiedNativeCliFiles } from './native-cli-uninstall'
import type {
  NativeCliDirectoryIdentity,
  NativeCliUninstallOptions,
} from './native-cli-uninstall'
import { sameLocalPathIdentity } from './path-identity'

const label = 'Claude Code'
const claudeVersionPattern = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,126})?(?:\\+[0-9A-Za-z][0-9A-Za-z.-]{0,126})?'
const posixVersionFileNamePattern = new RegExp(`^${claudeVersionPattern}$`)
const windowsVersionFileNamePattern = new RegExp(`^${claudeVersionPattern}(?:\\.exe)?$`, 'i')

export interface ClaudeNativeLayout {
  localRoot: string
  binDirectory: string
  commandName: string
  commandPath: string
  dataDirectory: string
  versionsDirectory: string
}

export interface UninstallVerifiedClaudeNativeInstallationOptions {
  homeDirectory: string
  installDirectory: string
  platform?: NodeJS.Platform
}

export interface ClaudeNativeUninstallResult {
  /** Absolute paths of version files under ~/.local/share/claude/versions that are gone now. */
  removedVersionFiles: string[]
  /** Version-named files the uninstall found but did not delete (locked, foreign owner, raced). */
  retainedVersionFiles: string[]
  /** macOS keeps the renamed command link; see uninstallVerifiedNativeCliFiles. */
  retainedQuarantineFiles: string[]
}

interface VerifiedVersionsDirectory {
  directory: string
  realDirectory: string
  identity: NativeCliDirectoryIdentity
}

export function buildClaudeNativeLayout(
  homeDirectory: string,
  platform: NodeJS.Platform,
): ClaudeNativeLayout {
  const localRoot = path.join(homeDirectory, '.local')
  const binDirectory = path.join(localRoot, 'bin')
  const commandName = platform === 'win32' ? 'claude.exe' : 'claude'
  const dataDirectory = path.join(localRoot, 'share', 'claude')
  return {
    localRoot,
    binDirectory,
    commandName,
    commandPath: path.join(binDirectory, commandName),
    dataDirectory,
    versionsDirectory: path.join(dataDirectory, 'versions'),
  }
}

/**
 * Only names the official installer itself produces. The leading digit rules
 * out this module's own `.name-<uuid>.removing` quarantine entries and any
 * lock/staging file the installer may drop next to the versions.
 */
export function isClaudeVersionFileName(fileName: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? windowsVersionFileNamePattern.test(fileName)
    : posixVersionFileNamePattern.test(fileName)
}

function directoryIdentity(stats: fs.Stats): NativeCliDirectoryIdentity {
  return { dev: stats.dev, ino: stats.ino, mode: stats.mode, uid: stats.uid }
}

function lstatOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function requirePlainDataDirectory(
  directory: string,
  ownerUid: number | undefined,
): NativeCliDirectoryIdentity | null {
  const stats = lstatOrNull(directory)
  if (!stats) return null
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} 程序数据目录 ${directory} 被链接替换，为避免误删已停止卸载`)
  }
  // macOS never elevates (AGENTS.md T5): the boundary is whether a principal
  // other than the current user could have planted this directory. Deleting
  // inside a directory someone else owns is refused rather than guessed at.
  if (ownerUid !== undefined && stats.uid !== ownerUid) {
    throw new Error(`${label} 程序数据目录 ${directory} 不属于当前用户，为避免误删已停止卸载`)
  }
  const realDirectory = fs.realpathSync.native?.(directory) ?? fs.realpathSync(directory)
  if (!sameLocalPathIdentity(realDirectory, directory)) {
    throw new Error(`${label} 程序数据目录 ${directory} 经过了符号链接或目录联接，为避免误删已停止卸载`)
  }
  return directoryIdentity(stats)
}

/**
 * Verified before the command entry is touched, so a redirected data tree
 * refuses the whole uninstall instead of leaving the user half-uninstalled.
 * Every ancestor is covered by the realpath comparison: a junction or link on
 * ~/.local, ~/.local/share or ~/.local/share/claude makes realpath differ.
 */
function resolveVerifiedVersionsDirectory(
  layout: ClaudeNativeLayout,
  ownerUid: number | undefined,
): VerifiedVersionsDirectory | null {
  if (!requirePlainDataDirectory(layout.dataDirectory, ownerUid)) return null
  const identity = requirePlainDataDirectory(layout.versionsDirectory, ownerUid)
  if (!identity) return null
  const directory = path.resolve(layout.versionsDirectory)
  return { directory, realDirectory: fs.realpathSync(directory), identity }
}

function assertVersionsDirectoryUnchanged(
  versions: VerifiedVersionsDirectory,
  ownerUid: number | undefined,
): void {
  const current = requirePlainDataDirectory(versions.directory, ownerUid)
  if (
    !current
    || current.dev !== versions.identity.dev
    || current.ino !== versions.identity.ino
    || current.mode !== versions.identity.mode
    || current.uid !== versions.identity.uid
  ) {
    throw new Error(`${label} 程序数据目录在卸载期间发生变化，已停止清理`)
  }
}

type CommandLinkPlan = Pick<
  NativeCliUninstallOptions,
  | 'expectedSymbolicLinks'
  | 'expectedSymbolicLinkIdentities'
  | 'expectedSymbolicLinkRootDirectory'
  | 'expectedSymbolicLinkRootDirectoryIdentity'
  | 'expectedResolvedSymbolicLinkTargets'
  | 'expectedOwnerUid'
  | 'allowAbsoluteSymbolicLinkTargets'
>

/**
 * Anthropic's installer publishes `claude` as a link to one file directly
 * inside ~/.local/share/claude/versions. Only that exact shape is accepted:
 * the link, its resolved target and the versions directory all belong to the
 * current user, and the target is a single-link regular file whose name is a
 * version. A link aimed anywhere else (Homebrew, a user script, another
 * user's tree) is refused before anything is renamed.
 */
function buildVerifiedCommandLinkPlan(
  layout: ClaudeNativeLayout,
  versions: VerifiedVersionsDirectory | null,
  ownerUid: number | undefined,
  platform: NodeJS.Platform,
): CommandLinkPlan {
  if (ownerUid === undefined || !Number.isSafeInteger(ownerUid) || ownerUid < 0) {
    throw new Error(`${label} 命令入口是符号链接，但当前系统无法确认所有者，已停止卸载`)
  }
  const outsideMessage = `${label} 命令入口指向官方安装目录 ~/.local/share/claude/versions 以外的位置，为避免误删已停止卸载，请用原来的安装方式卸载`
  const linkStats = fs.lstatSync(layout.commandPath, { bigint: true })
  if (!linkStats.isSymbolicLink()) throw new Error(`${label} 命令入口在卸载前发生变化，请刷新后重试`)
  if (linkStats.uid !== BigInt(ownerUid)) {
    throw new Error(`${label} 命令入口不属于当前用户，为避免误删已停止卸载`)
  }
  const linkTarget = fs.readlinkSync(layout.commandPath)
  if (!linkTarget || linkTarget.includes('\0')) throw new Error(outsideMessage)
  if (!versions) throw new Error(outsideMessage)
  let resolvedTarget: string
  try {
    resolvedTarget = fs.realpathSync(path.resolve(layout.binDirectory, linkTarget))
  } catch (error) {
    throw new Error(`${label} 命令入口指向的程序已不存在，请刷新后重试`, { cause: error })
  }
  if (
    path.dirname(resolvedTarget) !== versions.realDirectory
    || !isClaudeVersionFileName(path.basename(resolvedTarget), platform)
  ) {
    throw new Error(outsideMessage)
  }
  const targetStats = fs.lstatSync(resolvedTarget, { bigint: true })
  if (!targetStats.isFile() || targetStats.nlink !== 1n || targetStats.uid !== BigInt(ownerUid)) {
    throw new Error(`${label} 命令入口指向的程序不是当前用户的单链接普通文件，已停止卸载`)
  }
  const localRootStats = fs.lstatSync(layout.localRoot)
  const localRoot = fs.realpathSync(layout.localRoot)
  if (
    !localRootStats.isDirectory()
    || localRootStats.isSymbolicLink()
    || !sameLocalPathIdentity(localRoot, layout.localRoot)
  ) {
    throw new Error(`${label} 安装目录经过了符号链接或目录联接，已停止卸载`)
  }
  return {
    expectedSymbolicLinks: { [layout.commandName]: linkTarget },
    expectedSymbolicLinkIdentities: {
      [layout.commandName]: {
        dev: linkStats.dev,
        ino: linkStats.ino,
        mode: linkStats.mode,
        uid: linkStats.uid,
        gid: linkStats.gid,
        nlink: linkStats.nlink,
        size: linkStats.size,
        ctimeNs: linkStats.ctimeNs,
        birthtimeNs: linkStats.birthtimeNs,
      },
    },
    // ~/.local is the narrowest directory holding both bin/ and share/; the
    // module re-proves the target stays inside it across every rename.
    expectedSymbolicLinkRootDirectory: localRoot,
    expectedSymbolicLinkRootDirectoryIdentity: directoryIdentity(localRootStats),
    expectedResolvedSymbolicLinkTargets: {
      [layout.commandName]: {
        path: resolvedTarget,
        identity: {
          dev: targetStats.dev,
          ino: targetStats.ino,
          mode: targetStats.mode,
          size: targetStats.size,
          ctimeNs: targetStats.ctimeNs,
          mtimeNs: targetStats.mtimeNs,
        },
      },
    },
    expectedOwnerUid: ownerUid,
    allowAbsoluteSymbolicLinkTargets: true,
  }
}

function isRemovableVersionFile(stats: fs.Stats, ownerUid: number | undefined): boolean {
  return stats.isFile()
    && !stats.isSymbolicLink()
    && stats.nlink === 1
    && (ownerUid === undefined || stats.uid === ownerUid)
}

async function removeVerifiedVersionFiles(
  versions: VerifiedVersionsDirectory,
  ownerUid: number | undefined,
  platform: NodeJS.Platform,
): Promise<Pick<ClaudeNativeUninstallResult, 'removedVersionFiles' | 'retainedVersionFiles'>> {
  assertVersionsDirectoryUnchanged(versions, ownerUid)
  const removedVersionFiles: string[] = []
  const retainedVersionFiles: string[] = []
  const names = fs.readdirSync(versions.directory)
    .filter((name) => isClaudeVersionFileName(name, platform))
    .sort()
  for (const name of names) {
    const filePath = path.join(versions.directory, name)
    const stats = lstatOrNull(filePath)
    if (!stats || stats.isDirectory()) continue
    if (!isRemovableVersionFile(stats, ownerUid)) {
      retainedVersionFiles.push(filePath)
      continue
    }
    try {
      // One call per file: a single locked version (Windows keeps a running
      // image open) must not roll back the ones that were free to go.
      const result = await uninstallVerifiedNativeCliFiles({
        actualDirectory: versions.directory,
        expectedDirectory: versions.directory,
        expectedDirectoryIdentity: versions.identity,
        fileNames: [name],
        label,
        platform,
        removeDirectoryWhenEmpty: false,
      })
      if (result.retainedQuarantineFiles.length > 0) {
        retainedVersionFiles.push(...result.retainedQuarantineFiles)
      } else {
        removedVersionFiles.push(filePath)
      }
    } catch {
      if (lstatOrNull(filePath)) retainedVersionFiles.push(filePath)
    }
  }
  return { removedVersionFiles, retainedVersionFiles }
}

function removeDirectoryIfEmpty(directory: string, expected: NativeCliDirectoryIdentity | null): void {
  const stats = lstatOrNull(directory)
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) return
  if (expected && (stats.dev !== expected.dev || stats.ino !== expected.ino)) return
  try {
    fs.rmdirSync(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT' && code !== 'EBUSY' && code !== 'EPERM') {
      throw error
    }
  }
}

/**
 * Mirrors Anthropic's documented uninstall (remove ~/.local/bin/claude, then
 * ~/.local/share/claude) with the same verified per-file primitive every other
 * native uninstall uses, instead of a recursive delete by pathname: only
 * version-named single-link regular files directly inside the verified
 * versions directory are removed, and only emptied directories are rmdir'd.
 * ~/.claude and ~/.claude.json (settings, sessions, credentials) are never
 * looked at.
 */
export async function uninstallVerifiedClaudeNativeInstallation(
  options: UninstallVerifiedClaudeNativeInstallationOptions,
): Promise<ClaudeNativeUninstallResult> {
  const platform = options.platform ?? process.platform
  const layout = buildClaudeNativeLayout(options.homeDirectory, platform)
  const ownerUid = platform === 'win32' ? undefined : process.getuid?.()
  const versions = resolveVerifiedVersionsDirectory(layout, ownerUid)
  const command = lstatOrNull(layout.commandPath)
  const linkPlan = command?.isSymbolicLink()
    ? buildVerifiedCommandLinkPlan(layout, versions, ownerUid, platform)
    : {}
  const commandResult = await uninstallVerifiedNativeCliFiles({
    actualDirectory: options.installDirectory,
    expectedDirectory: layout.binDirectory,
    fileNames: [layout.commandName],
    label,
    platform,
    removeDirectoryWhenEmpty: false,
    ...linkPlan,
  })
  if (!versions) {
    return {
      removedVersionFiles: [],
      retainedVersionFiles: [],
      retainedQuarantineFiles: commandResult.retainedQuarantineFiles,
    }
  }
  const cleanup = await removeVerifiedVersionFiles(versions, ownerUid, platform)
  removeDirectoryIfEmpty(versions.directory, versions.identity)
  removeDirectoryIfEmpty(layout.dataDirectory, null)
  return {
    ...cleanup,
    retainedQuarantineFiles: commandResult.retainedQuarantineFiles,
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function powerShellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** A copyable command for the version files the uninstall had to leave behind, or null when none. */
export function buildClaudeRetainedVersionFilesCommand(
  retainedVersionFiles: readonly string[],
  platform: NodeJS.Platform,
): string | null {
  if (retainedVersionFiles.length === 0) return null
  if (platform === 'win32') {
    return retainedVersionFiles
      .map((filePath) => `Remove-Item -LiteralPath ${powerShellSingleQuote(filePath)} -Force`)
      .join('; ')
  }
  return `rm -f ${retainedVersionFiles.map(shellSingleQuote).join(' ')}`
}

/** 命令入口已经没了、只剩旧版本程序文件时给用户的说明；null 表示已全部清理干净。 */
export function buildClaudeRetainedVersionFilesReason(
  retainedVersionFiles: readonly string[],
  platform: NodeJS.Platform,
): string | null {
  if (retainedVersionFiles.length === 0) return null
  const location = platform === 'win32'
    ? '%USERPROFILE%\\.local\\share\\claude\\versions'
    : '~/.local/share/claude/versions'
  const names = retainedVersionFiles.slice(0, 5).map((filePath) => path.basename(filePath))
  const listed = retainedVersionFiles.length > 5 ? `${names.join('、')} 等` : names.join('、')
  return `Claude Code 已卸载，但 ${location} 里有 ${retainedVersionFiles.length} 个旧版本程序文件没能自动删除（${listed}），可能还有 Claude Code 在运行。关闭所有 Claude Code 窗口后，可以用下方命令删除它们；你的 Claude Code 设置和会话记录不受影响。`
}
