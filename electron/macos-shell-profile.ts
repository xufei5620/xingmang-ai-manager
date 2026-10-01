import os from 'node:os'
import path from 'node:path'
import { managedProductRoot } from './managed-cli-paths'
import { appendSafeUtf8File, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'

// 一个手写的 .zprofile 不会有几百 KB；再大就不是我们该去碰的文件了。
const maximumProfileBytes = 512 * 1024

export const macosShellProfileMarker = '# >>> xingmang-ai-manager terminal commands >>>'
const macosShellProfileEndMarker = '# <<< xingmang-ai-manager terminal commands <<<'

// 打开软件时只在从没写过的电脑上补一次：客户自己把那几行删了，就别每次开软件又加回来。
// 装、修复、更新工具时仍然会再确认一遍，那是客户明确要用这个工具的时候。
const stampFileName = 'terminal-commands-added'

export type MacosShellProfileOutcome = 'added' | 'present' | 'already-handled' | 'unsupported-shell'

/**
 * The lines appended to ~/.zprofile. Every directory is written relative to
 * `$HOME` and appended, never prepended, for the same reason the Windows side
 * appends: a CLI the user installed on their own keeps winning. The `case`
 * guard keeps a nested login shell from listing a directory twice, and also
 * covers a profile that already carries the one-line fix support handed out
 * before this existed. The app-downloaded Node.js comes last so the user's own
 * Node, if any, is the one `#!/usr/bin/env node` finds.
 */
export function buildMacosShellProfileBlock(): string {
  const directories = [
    '$HOME/Library/Application Support/XingMangAI/Cli/npm/bin',
    '$HOME/.grok/bin',
    '$HOME/Library/Application Support/XingMangAI/Runtime/node/bin',
  ]
  return [
    macosShellProfileMarker,
    '# 星芒AI管理工具加的：让新开的终端能直接敲 claude / codex / gemini / grok。不想要可以连同上下两行标记一起删掉。',
    `for xingmang_dir in ${directories.map((directory) => `"${directory}"`).join(' ')}; do`,
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

/** What to append to `current` so it ends with the block; empty when the block is already there. */
export function planMacosShellProfileAppend(current: string | null): string {
  if (current?.includes(macosShellProfileMarker)) return ''
  const block = buildMacosShellProfileBlock()
  if (!current) return block
  // 客户文件最后一行没换行时，直接接上会把我们的第一行粘进他那一行里。
  return `${current.endsWith('\n') ? '\n' : '\n\n'}${block}`
}

/** Terminal.app and iTerm start a login shell, which for zsh reads ~/.zprofile. */
export function isZshLoginShell(shell: string | null | undefined): boolean {
  return typeof shell === 'string' && path.posix.basename(shell.trim()) === 'zsh'
}

export interface EnsureMacosShellProfileOptions {
  reason: 'install' | 'startup'
  homeDirectory?: string
  /** The user's login shell; defaults to the account record, not $SHELL, which a launcher may override. */
  loginShell?: string | null
}

function defaultLoginShell(): string | null {
  try {
    return os.userInfo().shell
  } catch {
    return null
  }
}

/**
 * Lets terminals the user opens on their own run the CLIs by name, the way the
 * Windows side does through the user PATH. Only the user's own ~/.zprofile is
 * touched: it is appended to, never rewritten, so nothing the user wrote moves.
 * The file has to be a single-link regular file reached without symlinks (I8);
 * a dotfiles-managed profile that is a symlink is left for its owner and the
 * caller only logs it. Accounts whose login shell is not zsh are skipped
 * rather than guessed at: creating ~/.bash_profile would silently stop bash
 * from reading an existing ~/.profile.
 */
export async function ensureMacosShellProfile(options: EnsureMacosShellProfileOptions): Promise<MacosShellProfileOutcome> {
  const homeDirectory = options.homeDirectory ?? os.homedir()
  if (!homeDirectory || !path.posix.isAbsolute(homeDirectory) || homeDirectory.includes('\0')) {
    throw new Error('未找到有效的 macOS 用户目录')
  }
  const loginShell = options.loginShell === undefined ? defaultLoginShell() : options.loginShell
  if (!isZshLoginShell(loginShell)) return 'unsupported-shell'
  const stampPath = path.posix.join(managedProductRoot({ HOME: homeDirectory }, 'darwin'), stampFileName)
  if (options.reason === 'startup') {
    const stamp = await readSafeUtf8File(stampPath, '终端设置记录', 4096)
    if (stamp !== null) return 'already-handled'
  }
  const profilePath = path.posix.join(homeDirectory, '.zprofile')
  const label = '终端启动设置'
  const current = await readSafeUtf8File(profilePath, label, maximumProfileBytes)
  const addition = planMacosShellProfileAppend(current)
  if (addition) await appendSafeUtf8File(profilePath, addition, label)
  // 记录写不进去不影响结果：下次打开软件最多再确认一次，那一行已经在了就不会重复加。
  await writeAtomicSafeUtf8File(stampPath, `${new Date().toISOString()}\n`, '终端设置记录').catch(() => undefined)
  return addition ? 'added' : 'present'
}
