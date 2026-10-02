import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cliCatalog, providerIds } from './catalog'
import { quotePosixArgument } from './macos-platform'
import {
  managedNodeRuntimeBinDirectory,
  managedNpmBinDirectory,
  managedProductRoot,
  managedTerminalLauncherDirectory,
} from './managed-cli-paths'
import {
  appendSafeUtf8File,
  ensureSafeDataDirectory,
  readSafeUtf8File,
  removeSafeDataFile,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

// 手写的 .bashrc / .zshrc / .profile 不会有几百 KB；再大就不是我们该去碰的文件了。
const maximumProfileBytes = 512 * 1024
const maximumLauncherBytes = 16 * 1024

// 和 macOS 的 .zprofile 用同一对标记，客服让客户找这一段时只用记一种写法。
export const linuxShellProfileMarker = '# >>> xingmang-ai-manager terminal commands >>>'
const linuxShellProfileEndMarker = '# <<< xingmang-ai-manager terminal commands <<<'
const launcherSignature = '# xingmang-ai-manager terminal launcher'

// 打开软件时只在从没写过的电脑上补一次：客户自己把那几行删了，就别每次开软件又加回来。
// 装、修复、更新工具时仍然会再确认一遍，那是客户明确要用这个工具的时候。
const stampFileName = 'terminal-commands-added'
const fishFileName = 'xingmang-ai-manager.fish'

const profileLabel = '终端启动设置'
const launcherLabel = '终端启动器'

export type LinuxTerminalCommandsReason = 'install' | 'startup' | 'uninstall'

export type LinuxTerminalCommandsOutcome =
  | 'added'
  | 'present'
  | 'already-handled'
  | 'unsupported-shell'
  | 'removed'
  | 'not-needed'

export interface LinuxTerminalCommandsResult {
  outcome: LinuxTerminalCommandsOutcome
  /** Commands that now have a launcher, i.e. the CLIs this app installed. */
  launchers: string[]
  /** Files left alone because they could not be read or written safely; `~`-relative, for the log. */
  skipped: string[]
}

export interface LinuxShellProfileTarget {
  kind: 'posix' | 'fish'
  filePath: string
  /** `~/.bashrc` and the like: what the log shows instead of the real home directory. */
  displayPath: string
}

/**
 * The launcher directory as it should appear inside a double-quoted string,
 * once for sh-family shells and once for fish. Under the default data folder it
 * is written through `$HOME` so it reads like what support would type; with a
 * custom XDG_DATA_HOME the absolute path is written instead, escaped for the
 * quotes it sits in. A ':' would split it into two PATH entries, so such a
 * folder is refused rather than half-added.
 */
export function buildLauncherDirectoryWords(launcherDirectory: string, homeDirectory: string): { posix: string; fish: string } {
  if (!path.posix.isAbsolute(launcherDirectory) || /[\0\n\r:]/.test(launcherDirectory)) {
    throw new Error('终端启动器目录无效')
  }
  const home = homeDirectory.replace(/\/+$/, '')
  const relative = home && launcherDirectory.startsWith(`${home}/`)
    ? launcherDirectory.slice(home.length + 1)
    : null
  if (relative !== null && /^[A-Za-z0-9._/-]+$/.test(relative)) {
    const word = `$HOME/${relative}`
    return { posix: word, fish: word }
  }
  return {
    posix: launcherDirectory.replace(/[\\"$`]/g, '\\$&'),
    fish: launcherDirectory.replace(/[\\"$]/g, '\\$&'),
  }
}

/**
 * The lines appended to ~/.bashrc, ~/.zshrc and ~/.profile. Only the launcher
 * directory is added, never the npm or Node.js folders themselves: putting the
 * app's Node.js on the user's PATH would change what their own `node` means,
 * and the raw npm entry points would run under whatever old `node` comes first.
 * It is appended, not prepended, for the reason macOS and Windows append: a CLI
 * the user installed on their own keeps winning. The `case` guard keeps a shell
 * that reads both ~/.profile and ~/.bashrc from listing it twice.
 */
export function buildLinuxShellProfileBlock(launcherDirectory: string, homeDirectory: string): string {
  const { posix } = buildLauncherDirectoryWords(launcherDirectory, homeDirectory)
  return [
    linuxShellProfileMarker,
    '# 星芒AI管理工具加的：让新开的终端能直接敲 claude / codex / gemini / grok。在星芒里卸掉它装的全部工具时会自动去掉；不想要也可以连同上下两行标记一起删掉。',
    'case ":$PATH:" in',
    `  *":${posix}:"*) ;;`,
    `  *) export PATH="$PATH:${posix}" ;;`,
    'esac',
    linuxShellProfileEndMarker,
    '',
  ].join('\n')
}

/** fish reads every file in conf.d, so it gets a file of its own instead of an edit to config.fish. */
export function buildLinuxFishProfile(launcherDirectory: string, homeDirectory: string): string {
  const { fish } = buildLauncherDirectoryWords(launcherDirectory, homeDirectory)
  return [
    linuxShellProfileMarker,
    '# 星芒AI管理工具加的：让新开的终端能直接敲 claude / codex / gemini / grok。在星芒里卸掉它装的全部工具时会自动删掉这个文件。',
    `if not contains -- "${fish}" $PATH`,
    `    set -gx PATH $PATH "${fish}"`,
    'end',
    linuxShellProfileEndMarker,
    '',
  ].join('\n')
}

/** What to append to `current` so it ends with the block; empty when the block is already there. */
export function planLinuxShellProfileAppend(current: string | null, block: string): string {
  if (current?.includes(linuxShellProfileMarker)) return ''
  if (!current) return block
  // 客户文件最后一行没换行时，直接接上会把我们的第一行粘进他那一行里。
  return `${current.endsWith('\n') ? '\n' : '\n\n'}${block}`
}

/**
 * `current` without the block this app appended, or null when that exact block
 * is not there. Only a byte-for-byte match is removed: a block the user edited
 * is theirs now, and guessing where their edit ends could delete their lines.
 * The blank line the append put in front of the block goes with it.
 */
export function planLinuxShellProfileRemoval(current: string, block: string): string | null {
  let start = current.indexOf(block)
  let length = block.length
  if (start === -1) {
    // 客户删掉了文件最后那个换行。
    const unterminated = block.slice(0, -1)
    if (!current.endsWith(unterminated)) return null
    start = current.length - unterminated.length
    length = unterminated.length
  }
  if (start > 0 && current[start - 1] !== '\n') return null
  let before = current.slice(0, start)
  if (before.endsWith('\n\n')) before = before.slice(0, -1)
  return `${before}${current.slice(start + length)}`
}

/**
 * One small launcher per CLI the app installed. It puts the app's Node.js in
 * front for this one command only, so a too-old distro `node` earlier on the
 * user's PATH cannot hijack the npm entry points' `#!/usr/bin/env node`, and
 * their own `node` keeps meaning what it meant. It does the same as starting
 * the CLI from the app, where linux-platform.ts puts that Node.js first.
 * Nothing in it is exported except PATH, and only when the app's Node.js exists.
 */
export function buildLinuxTerminalLauncher(command: string, target: string, nodeBinDirectory: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(command)) throw new Error('命令名无效')
  if (!path.posix.isAbsolute(target) || !path.posix.isAbsolute(nodeBinDirectory)) {
    throw new Error(`${launcherLabel}的目标路径无效`)
  }
  return [
    '#!/bin/sh',
    launcherSignature,
    `# 星芒AI管理工具生成：在自己开的终端里敲 ${command} 走这里，固定用星芒准备的 Node.js。在星芒里卸掉 ${command} 时会自动删掉。`,
    `xingmang_target=${quotePosixArgument(target)}`,
    `xingmang_node=${quotePosixArgument(nodeBinDirectory)}`,
    'if [ ! -x "$xingmang_target" ]; then',
    `  echo ${quotePosixArgument(`找不到星芒AI管理工具装的 ${command}，请打开星芒AI管理工具重新安装。`)} >&2`,
    '  exit 127',
    'fi',
    'if [ -x "$xingmang_node/node" ]; then',
    '  PATH="$xingmang_node:$PATH"',
    '  export PATH',
    'fi',
    'exec "$xingmang_target" "$@"',
    '',
  ].join('\n')
}

function shellName(shell: string | null | undefined): string | null {
  if (typeof shell !== 'string' || !shell.trim()) return null
  return path.posix.basename(shell.trim())
}

export interface LinuxShellProfileTargetInput {
  homeDirectory: string
  /** The fish config folder: `$XDG_CONFIG_HOME/fish` or `~/.config/fish`. */
  fishConfigDirectory: string
  loginShell: string | null | undefined
  /** Whether something (a file, a link, a folder) is already at this path. */
  exists: (filePath: string) => boolean
}

/**
 * Which startup files get the lines. Terminal windows on Linux start
 * interactive non-login shells, so the rc file of the account's own shell is
 * the one that matters; ~/.profile is added for login shells and for the
 * desktop session after the next sign-in. A file that already exists always
 * gets the lines, whatever the account's shell, because the user evidently
 * runs that shell too. New files are only created for the account's own shell,
 * and never ~/.bash_profile: creating it would silently stop bash from reading
 * an existing ~/.profile.
 */
export function planLinuxShellProfileTargets(input: LinuxShellProfileTargetInput): LinuxShellProfileTarget[] {
  const shell = shellName(input.loginShell)
  const targets: LinuxShellProfileTarget[] = []
  function posix(name: string, ownShell: boolean): void {
    const filePath = path.posix.join(input.homeDirectory, name)
    if (ownShell || input.exists(filePath)) targets.push({ kind: 'posix', filePath, displayPath: `~/${name}` })
  }
  posix('.bashrc', shell === 'bash')
  posix('.zshrc', shell === 'zsh')
  posix('.profile', shell === 'bash' || shell === 'sh' || shell === 'dash')
  if (shell === 'fish' || input.exists(input.fishConfigDirectory)) {
    targets.push({
      kind: 'fish',
      filePath: path.posix.join(input.fishConfigDirectory, 'conf.d', fishFileName),
      displayPath: `fish/conf.d/${fishFileName}`,
    })
  }
  return targets
}

export interface SyncLinuxTerminalCommandsOptions {
  reason: LinuxTerminalCommandsReason
  /** HOME, XDG_DATA_HOME and XDG_CONFIG_HOME are read from here. */
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
  /** The account's login shell; defaults to the account record, not $SHELL, which a launcher may override. */
  loginShell?: string | null
}

function defaultLoginShell(): string | null {
  try {
    return os.userInfo().shell
  } catch {
    return null
  }
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath)
    return true
  } catch {
    return false
  }
}

function fishConfigDirectory(env: NodeJS.ProcessEnv, homeDirectory: string): string {
  const configHome = env.XDG_CONFIG_HOME?.trim()
  const base = configHome && !configHome.includes('\0') && path.posix.isAbsolute(configHome)
    ? configHome
    : path.posix.join(homeDirectory, '.config')
  return path.posix.join(base, 'fish')
}

interface LauncherSync {
  /** Commands whose entry point exists in the app's npm folder, whether or not their launcher could be written. */
  installed: string[]
  /** Commands that have a launcher after this call. */
  launchers: string[]
}

async function syncLaunchers(env: NodeJS.ProcessEnv, skipped: string[]): Promise<LauncherSync> {
  const npmBin = managedNpmBinDirectory(env, 'linux')
  const nodeBin = managedNodeRuntimeBinDirectory(env, 'linux')
  const launcherDirectory = managedTerminalLauncherDirectory(env, 'linux')
  const installed: string[] = []
  const launchers: string[] = []
  for (const provider of providerIds) {
    const command = cliCatalog[provider].command
    const target = path.posix.join(npmBin, command)
    const launcherPath = path.posix.join(launcherDirectory, command)
    const present = pathExists(target)
    if (present) installed.push(command)
    try {
      if (present) {
        ensureSafeDataDirectory(launcherDirectory, launcherLabel)
        const content = buildLinuxTerminalLauncher(command, target, nodeBin)
        const current = await readSafeUtf8File(launcherPath, launcherLabel, maximumLauncherBytes).catch(() => null)
        if (current !== content) await writeAtomicSafeUtf8File(launcherPath, content, launcherLabel, { mode: 0o700 })
        launchers.push(command)
      } else if (pathExists(launcherPath)) {
        // 只删自己写的：目录在我们名下，但万一客户放了同名的东西，不替他删。
        const current = await readSafeUtf8File(launcherPath, launcherLabel, maximumLauncherBytes)
        if (current?.startsWith(`#!/bin/sh\n${launcherSignature}\n`)) await removeSafeDataFile(launcherPath, launcherLabel)
      }
    } catch {
      skipped.push(`Cli/launchers/${command}`)
    }
  }
  return { installed, launchers }
}

async function addToTarget(target: LinuxShellProfileTarget, block: string, fishProfile: string): Promise<boolean> {
  const current = await readSafeUtf8File(target.filePath, profileLabel, maximumProfileBytes)
  if (target.kind === 'fish') {
    if (current?.includes(linuxShellProfileMarker)) return false
    if (current !== null) throw new Error(`${profileLabel}已被别的内容占用`)
    ensureSafeDataDirectory(path.posix.dirname(target.filePath), profileLabel)
    await writeAtomicSafeUtf8File(target.filePath, fishProfile, profileLabel, { mode: 0o644 })
    return true
  }
  const addition = planLinuxShellProfileAppend(current, block)
  if (!addition) return false
  await appendSafeUtf8File(target.filePath, addition, profileLabel)
  return true
}

async function removeFromTarget(target: LinuxShellProfileTarget, block: string, fishProfile: string): Promise<boolean> {
  const current = await readSafeUtf8File(target.filePath, profileLabel, maximumProfileBytes)
  if (current === null) return false
  if (target.kind === 'fish') {
    if (current !== fishProfile) return false
    await removeSafeDataFile(target.filePath, profileLabel)
    return true
  }
  const next = planLinuxShellProfileRemoval(current, block)
  if (next === null) return false
  const { mode } = await fs.promises.lstat(target.filePath)
  // 两次读之间客户正好在改这个文件，就这次不动，下次卸载再说。
  const again = await readSafeUtf8File(target.filePath, profileLabel, maximumProfileBytes)
  if (again !== current) throw new Error(`${profileLabel}在修改过程中发生变化`)
  await writeAtomicSafeUtf8File(target.filePath, next, profileLabel, { mode: mode & 0o777 })
  return true
}

/**
 * Lets terminals the user opens on their own run the CLIs this app installed
 * by name (Linux 版拆分 ④), the way the Windows side does through the user
 * PATH and macOS through ~/.zprofile.
 *
 * - Launchers: one per CLI whose entry point exists in the app's npm folder,
 *   written into the app's own folder; a launcher whose CLI is gone is deleted.
 * - Startup files: the marked block is appended, so nothing the user wrote
 *   moves. Each file has to be a single-link regular file
 *   reached without symlinks (I8); a dotfiles-managed one that is a symlink is
 *   left for its owner and only named in `skipped`.
 * - After an uninstall that left no CLI of ours, the exact block is taken out
 *   of every file it is in and the fish file is deleted, so nothing points at
 *   an empty folder. Startup never does this: a scan that sees nothing of ours
 *   (another XDG_DATA_HOME, say) must not undo what an install set up.
 */
export async function syncLinuxTerminalCommands(options: SyncLinuxTerminalCommandsOptions): Promise<LinuxTerminalCommandsResult> {
  const baseEnv = options.env ?? process.env
  const homeDirectory = options.homeDirectory ?? (baseEnv.HOME?.trim() || os.homedir())
  if (!homeDirectory || !path.posix.isAbsolute(homeDirectory) || homeDirectory.includes('\0')) {
    throw new Error('未找到有效的用户主目录')
  }
  const env = { ...baseEnv, HOME: homeDirectory }
  const launcherDirectory = managedTerminalLauncherDirectory(env, 'linux')
  // 目录名放不进终端设置（比如带冒号）就什么都不写，小启动器写了也没人找得到。
  const block = buildLinuxShellProfileBlock(launcherDirectory, homeDirectory)
  const fishProfile = buildLinuxFishProfile(launcherDirectory, homeDirectory)
  const loginShell = options.loginShell === undefined ? defaultLoginShell() : options.loginShell
  const fishDirectory = fishConfigDirectory(env, homeDirectory)
  const skipped: string[] = []
  const { installed, launchers } = await syncLaunchers(env, skipped)

  if (!installed.length) {
    if (options.reason !== 'uninstall') return { outcome: 'not-needed', launchers, skipped }
    // 撤的时候不看登录 shell：以前加过的文件都要找一遍。
    const targets = planLinuxShellProfileTargets({ homeDirectory, fishConfigDirectory: fishDirectory, loginShell: null, exists: pathExists })
    let removed = false
    for (const target of targets) {
      try {
        if (await removeFromTarget(target, block, fishProfile)) removed = true
      } catch {
        skipped.push(target.displayPath)
      }
    }
    await fs.promises.rmdir(launcherDirectory).catch(() => undefined)
    return { outcome: removed ? 'removed' : 'not-needed', launchers, skipped }
  }
  if (options.reason === 'uninstall') return { outcome: 'not-needed', launchers, skipped }

  const stampPath = path.posix.join(managedProductRoot(env, 'linux'), stampFileName)
  if (options.reason === 'startup') {
    const stamp = await readSafeUtf8File(stampPath, '终端设置记录', 4096).catch(() => null)
    if (stamp !== null) return { outcome: 'already-handled', launchers, skipped }
  }
  const targets = planLinuxShellProfileTargets({ homeDirectory, fishConfigDirectory: fishDirectory, loginShell, exists: pathExists })
  if (!targets.length) return { outcome: 'unsupported-shell', launchers, skipped }
  let added = false
  for (const target of targets) {
    try {
      if (await addToTarget(target, block, fishProfile)) added = true
    } catch {
      skipped.push(target.displayPath)
    }
  }
  // 记录写不进去不影响结果：下次打开软件最多再确认一次，那几行已经在了就不会重复加。
  await writeAtomicSafeUtf8File(stampPath, `${new Date().toISOString()}\n`, '终端设置记录').catch(() => undefined)
  return { outcome: added ? 'added' : 'present', launchers, skipped }
}
