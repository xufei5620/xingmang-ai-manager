import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { managedProductRoot } from './managed-cli-paths'
import {
  appendSafeUtf8File,
  ensureSafeDataDirectory,
  readSafeUtf8File,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

// 手写的 .zprofile / .bash_profile 不会有几百 KB；再大就不是我们该去碰的文件了。
const maximumProfileBytes = 512 * 1024

export const macosShellProfileMarker = '# >>> xingmang-ai-manager terminal commands >>>'
const macosShellProfileEndMarker = '# <<< xingmang-ai-manager terminal commands <<<'

// 打开软件时只在从没写过的电脑上补一次：客户自己把那几行删了，就别每次开软件又加回来。
// 装、修复、更新工具时仍然会再确认一遍，那是客户明确要用这个工具的时候。
const stampFileName = 'terminal-commands-added'
const fishFileName = 'xingmang-ai-manager.fish'

// bash 作为登录 shell 只读这三个里第一个存在的那个，后面的就不读了（bash 自己的规矩）。
const bashLoginFileNames = ['.bash_profile', '.bash_login', '.profile']

/**
 * Every directory is written relative to `$HOME` and appended, never
 * prepended, for the same reason the Windows side appends: a CLI the user
 * installed on their own keeps winning. The app-downloaded Node.js comes last
 * so the user's own Node, if any, is the one `#!/usr/bin/env node` finds.
 */
const terminalCommandDirectories = [
  '$HOME/Library/Application Support/XingMangAI/Cli/npm/bin',
  '$HOME/.grok/bin',
  '$HOME/Library/Application Support/XingMangAI/Runtime/node/bin',
]

export type MacosShellProfileOutcome = 'added' | 'present' | 'already-handled' | 'unsupported-shell'

/** The login shells whose startup files get the lines; any other is left alone. */
export type MacosLoginShell = 'zsh' | 'bash' | 'fish'

/**
 * The lines appended to ~/.zprofile, or to the file a bash login shell reads.
 * The `case` guard keeps a nested login shell from listing a directory twice,
 * and also covers a profile that already carries the one-line fix support
 * handed out before this existed.
 */
export function buildMacosShellProfileBlock(): string {
  return [
    macosShellProfileMarker,
    '# 星芒AI管理工具加的：让新开的终端能直接敲 claude / codex / gemini / grok。不想要可以连同上下两行标记一起删掉。',
    `for xingmang_dir in ${terminalCommandDirectories.map((directory) => `"${directory}"`).join(' ')}; do`,
    '  case ":$PATH:" in',
    '    *":$xingmang_dir:"*) ;;',
    '    *) export PATH="$PATH:$xingmang_dir" ;;',
    '  esac',
    'done',
    'unset xingmang_dir',
    macosShellProfileEndMarker,
    '',
  ].join('\n')
}

/**
 * The same directories for fish, in the same order and between the same
 * markers. fish reads every file in conf.d, so it gets a file of its own
 * instead of an edit to config.fish, as on Linux.
 */
export function buildMacosFishProfile(): string {
  return [
    macosShellProfileMarker,
    '# 星芒AI管理工具加的：让新开的终端能直接敲 claude / codex / gemini / grok。不想要可以删掉这个文件。',
    ...terminalCommandDirectories.flatMap((directory) => [
      `if not contains -- "${directory}" $PATH`,
      `    set -gx PATH $PATH "${directory}"`,
      'end',
    ]),
    macosShellProfileEndMarker,
    '',
  ].join('\n')
}

/** What to append to `current` so it ends with the block; empty when the block is already there. */
export function planMacosShellProfileAppend(current: string | null): string {
  if (current?.includes(macosShellProfileMarker)) return ''
  const block = buildMacosShellProfileBlock()
  if (!current) return block
  // 客户文件最后一行没换行时，直接接上会把我们的第一行粘进他那一行里。
  return `${current.endsWith('\n') ? '\n' : '\n\n'}${block}`
}

/** Which of the shells handled here the account logs in with; null for any other (tcsh, sh, ksh …). */
export function resolveMacosLoginShell(shell: string | null | undefined): MacosLoginShell | null {
  if (typeof shell !== 'string') return null
  const name = path.posix.basename(shell.trim())
  return name === 'zsh' || name === 'bash' || name === 'fish' ? name : null
}

export interface MacosShellProfileTarget {
  kind: 'posix' | 'fish'
  filePath: string
  /** `~/.zprofile` and the like: names the file in the log without the home directory. */
  displayPath: string
}

export interface MacosShellProfileTargetInput {
  shell: MacosLoginShell
  homeDirectory: string
  /** The fish config folder: `$XDG_CONFIG_HOME/fish` or `~/.config/fish`. */
  fishConfigDirectory: string
  /** Whether something (a file, a link, a folder) is already at this path. */
  exists: (filePath: string) => boolean
}

/**
 * The one file a new window of Terminal.app or iTerm reads, both of which start
 * a login shell: ~/.zprofile for zsh; for bash the first of ~/.bash_profile,
 * ~/.bash_login and ~/.profile that exists, or a new ~/.profile when there is
 * none. Never a new ~/.bash_profile: once it exists bash stops reading
 * ~/.profile, so whatever another installer adds there later would silently
 * stop working. Whatever sits at one of those names counts, a link included,
 * so a dotfiles-managed ~/.bash_profile is picked and then refused (I8) rather
 * than passed over for a ~/.profile bash never reads.
 */
export function planMacosShellProfileTarget(input: MacosShellProfileTargetInput): MacosShellProfileTarget {
  if (input.shell === 'fish') {
    return {
      kind: 'fish',
      filePath: path.posix.join(input.fishConfigDirectory, 'conf.d', fishFileName),
      displayPath: `fish/conf.d/${fishFileName}`,
    }
  }
  const name = input.shell === 'zsh'
    ? '.zprofile'
    : bashLoginFileNames.find((candidate) => input.exists(path.posix.join(input.homeDirectory, candidate))) ?? '.profile'
  return { kind: 'posix', filePath: path.posix.join(input.homeDirectory, name), displayPath: `~/${name}` }
}

export interface EnsureMacosShellProfileOptions {
  reason: 'install' | 'startup'
  homeDirectory?: string
  /** The user's login shell; defaults to the account record, not $SHELL, which a launcher may override. */
  loginShell?: string | null
  /** XDG_CONFIG_HOME is read from here, for fish. */
  env?: NodeJS.ProcessEnv
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
  } catch (error) {
    // 看不清的当作有：宁可这次不改，也别另建一个 bash 根本不读的 ~/.profile。
    const code = (error as NodeJS.ErrnoException).code
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}

function fishConfigDirectory(env: NodeJS.ProcessEnv, homeDirectory: string): string {
  const configHome = env.XDG_CONFIG_HOME?.trim()
  const base = configHome && !configHome.includes('\0') && path.posix.isAbsolute(configHome)
    ? configHome
    : path.posix.join(homeDirectory, '.config')
  return path.posix.join(base, 'fish')
}

async function appendShellProfileBlock(target: MacosShellProfileTarget, label: string): Promise<boolean> {
  const current = await readSafeUtf8File(target.filePath, label, maximumProfileBytes)
  const addition = planMacosShellProfileAppend(current)
  if (!addition) return false
  await appendSafeUtf8File(target.filePath, addition, label)
  return true
}

async function writeFishProfile(target: MacosShellProfileTarget, label: string): Promise<boolean> {
  const current = await readSafeUtf8File(target.filePath, label, maximumProfileBytes)
  if (current?.includes(macosShellProfileMarker)) return false
  if (current !== null) throw new Error(`${label}已被别的内容占用`)
  ensureSafeDataDirectory(path.posix.dirname(target.filePath), label)
  await writeAtomicSafeUtf8File(target.filePath, buildMacosFishProfile(), label, { mode: 0o644 })
  return true
}

/**
 * Lets terminals the user opens on their own run the CLIs by name, the way the
 * Windows side does through the user PATH. Only the user's own startup file is
 * touched, the one their login shell reads (planMacosShellProfileTarget): it
 * is appended to, never rewritten, so nothing the user wrote moves, and fish
 * gets a file of its own. The file has to be a single-link regular file reached
 * without symlinks (I8); a dotfiles-managed one that is a symlink is left for
 * its owner and the caller only logs it. Login shells other than zsh, bash and
 * fish are skipped rather than guessed at.
 */
export async function ensureMacosShellProfile(options: EnsureMacosShellProfileOptions): Promise<MacosShellProfileOutcome> {
  const homeDirectory = options.homeDirectory ?? os.homedir()
  if (!homeDirectory || !path.posix.isAbsolute(homeDirectory) || homeDirectory.includes('\0')) {
    throw new Error('未找到有效的 macOS 用户目录')
  }
  const shell = resolveMacosLoginShell(options.loginShell === undefined ? defaultLoginShell() : options.loginShell)
  // 不留记录：账号换成这几种 shell 以后，下次打开软件还能补上。
  if (!shell) return 'unsupported-shell'
  const stampPath = path.posix.join(managedProductRoot({ HOME: homeDirectory }, 'darwin'), stampFileName)
  if (options.reason === 'startup') {
    const stamp = await readSafeUtf8File(stampPath, '终端设置记录', 4096)
    if (stamp !== null) return 'already-handled'
  }
  const target = planMacosShellProfileTarget({
    shell,
    homeDirectory,
    fishConfigDirectory: fishConfigDirectory(options.env ?? process.env, homeDirectory),
    exists: pathExists,
  })
  // bash 可能落在三个文件里的任何一个，出错时日志得说清是哪一个。
  const label = `终端启动设置（${target.displayPath}）`
  const added = target.kind === 'fish'
    ? await writeFishProfile(target, label)
    : await appendShellProfileBlock(target, label)
  // 记录写不进去不影响结果：下次打开软件最多再确认一次，那一行已经在了就不会重复加。
  await writeAtomicSafeUtf8File(stampPath, `${new Date().toISOString()}\n`, '终端设置记录').catch(() => undefined)
  return added ? 'added' : 'present'
}
