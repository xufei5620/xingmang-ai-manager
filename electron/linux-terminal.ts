import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cliCloseWindowPrompt, cliExitHintLines, linuxFolderAccessHintLines } from './cli-exit-hint'
import {
  captureLauncherIdentity,
  cleanupStaleTerminalDirectoriesOnce,
  quotePosixArgument,
  removeLauncherIfUnchanged,
  terminalDirectoryPrefix,
  writeLauncherAtomically,
  type LauncherIdentity,
} from './terminal-launcher-files'

// Linux 上点「打开」：找一个命令窗口程序，交给它一份一次性启动脚本，脚本真的跑起来才算
// 打开成功（Linux 版拆分 ⑤）。和 macOS 一样，工具的路径、参数、项目文件夹都只出现在脚本
// 正文里；命令窗口程序收到的只有本软件自己定的 `/bin/sh` 和启动脚本路径。

export type LinuxTerminalId =
  | 'x-terminal-emulator'
  | 'gnome-terminal'
  | 'kgx'
  | 'ptyxis'
  | 'konsole'
  | 'deepin-terminal'
  | 'mate-terminal'
  | 'xfce4-terminal'
  | 'qterminal'
  | 'lxterminal'
  | 'terminator'
  | 'tilix'
  | 'kitty'
  | 'alacritty'
  | 'foot'
  | 'wezterm'
  | 'xterm'
  | 'urxvt'

interface LinuxTerminalDefinition {
  id: LinuxTerminalId
  /** 检查页和日志里给人看的名字。 */
  label: string
  executables: readonly string[]
  /** XDG_CURRENT_DESKTOP 里出现其中之一（不分大小写）时，这个桌面自带的它排在最前面。 */
  desktops: readonly string[]
  /** How this terminal is told to run `/bin/sh <launcher>`. */
  argv: (shell: string, launcher: string) => string[]
}

const launcherShell = '/bin/sh'

function split(...prefix: string[]): (shell: string, launcher: string) => string[] {
  return (shell, launcher) => [...prefix, shell, launcher]
}

/**
 * These terminals take the whole command as one string and split it on spaces
 * themselves. That is only sound because the launcher path is restricted to
 * characters that need no quoting (assertSimpleLauncherPath).
 */
function joined(...prefix: string[]): (shell: string, launcher: string) => string[] {
  return (shell, launcher) => [...prefix, `${shell} ${launcher}`]
}

/**
 * The generic entry follows Debian Policy §11.8.3: everything after `-e` is the
 * command and its arguments. The Debian wrappers (gnome-terminal.wrapper and the
 * xfce4 / mate / tilix ones) only pass arguments through untouched when `-e` is
 * followed by two or more of them; with exactly one they fall back to `sh -c`.
 * Every entry here therefore hands over at least two tokens, or one joined
 * string to a terminal that only accepts a string.
 *
 * The syntax for x-terminal-emulator and the wrappers was checked against the
 * Ubuntu 24.04 packages; the rest comes from each terminal's manual and has not
 * been run on a real desktop yet. A terminal that rejects its arguments exits
 * non-zero, and the launch then moves on to the next one, so a wrong guess costs
 * a fallback rather than the launch.
 */
const genericTerminal: LinuxTerminalDefinition = {
  id: 'x-terminal-emulator',
  label: '系统默认终端',
  executables: ['x-terminal-emulator'],
  desktops: [],
  argv: split('-e'),
}

export const linuxTerminalTable: readonly LinuxTerminalDefinition[] = [
  { id: 'gnome-terminal', label: 'GNOME 终端', executables: ['gnome-terminal'], desktops: ['GNOME', 'Unity', 'X-Cinnamon'], argv: split('--') },
  // 统信 UOS、deepin 只带这一个，它也不登记成 x-terminal-emulator（Debian 包里没有 postinst）。
  { id: 'deepin-terminal', label: '深度终端', executables: ['deepin-terminal'], desktops: ['Deepin', 'DDE'], argv: split('-e') },
  // 银河麒麟的 UKUI 桌面用的是 MATE 终端（推测，要真机确认）。
  { id: 'mate-terminal', label: 'MATE 终端', executables: ['mate-terminal'], desktops: ['MATE', 'UKUI'], argv: split('-x') },
  { id: 'konsole', label: 'Konsole', executables: ['konsole'], desktops: ['KDE'], argv: split('-e') },
  { id: 'xfce4-terminal', label: 'Xfce 终端', executables: ['xfce4-terminal'], desktops: ['XFCE'], argv: split('-x') },
  { id: 'kgx', label: 'GNOME 控制台', executables: ['kgx'], desktops: ['GNOME'], argv: split('--') },
  { id: 'ptyxis', label: 'Ptyxis 终端', executables: ['ptyxis'], desktops: ['GNOME'], argv: split('--new-window', '--') },
  { id: 'qterminal', label: 'QTerminal', executables: ['qterminal'], desktops: ['LXQt'], argv: joined('-e') },
  { id: 'lxterminal', label: 'LXTerminal', executables: ['lxterminal'], desktops: ['LXDE'], argv: joined('-e') },
  { id: 'terminator', label: 'Terminator', executables: ['terminator'], desktops: [], argv: split('-x') },
  { id: 'tilix', label: 'Tilix', executables: ['tilix'], desktops: [], argv: joined('-e') },
  { id: 'kitty', label: 'kitty', executables: ['kitty'], desktops: [], argv: split() },
  { id: 'alacritty', label: 'Alacritty', executables: ['alacritty'], desktops: [], argv: split('-e') },
  { id: 'foot', label: 'foot', executables: ['foot'], desktops: [], argv: split() },
  { id: 'wezterm', label: 'WezTerm', executables: ['wezterm'], desktops: [], argv: split('start', '--') },
  { id: 'xterm', label: 'XTerm', executables: ['xterm'], desktops: [], argv: split('-e') },
  { id: 'urxvt', label: 'urxvt', executables: ['urxvt', 'rxvt-unicode'], desktops: [], argv: split('-e') },
]

export interface LinuxTerminalCandidate {
  id: LinuxTerminalId
  label: string
  /** Absolute path that is spawned as-is; never a bare name. */
  executable: string
}

export interface LinuxTerminalDiscoveryOptions {
  isExecutableFile?: (filePath: string) => boolean
  /** Resolves /etc/alternatives; null when the link cannot be resolved. */
  realpath?: (filePath: string) => string | null
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function realpathOrNull(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return null
  }
}

/**
 * Only absolute PATH entries are searched. Node's spawn resolves a bare name
 * against relative entries such as `.` inside the child's cwd, which here is the
 * project folder the user just picked: a repository carrying its own executable
 * `gnome-terminal` would otherwise run. Searching absolute entries and spawning
 * the absolute result closes that, the same-user counterpart of I14.
 */
export function linuxTerminalSearchDirectories(env: NodeJS.ProcessEnv): string[] {
  const inherited = (env.PATH ?? '').split(path.posix.delimiter)
  const directories: string[] = []
  for (const entry of [...inherited, '/usr/local/bin', '/usr/bin', '/bin']) {
    if (!entry || entry.includes('\0') || !path.posix.isAbsolute(entry)) continue
    const normalized = path.posix.normalize(entry).replace(/(.)\/+$/, '$1')
    if (!directories.includes(normalized)) directories.push(normalized)
  }
  return directories
}

function desktopTokens(env: NodeJS.ProcessEnv): string[] {
  return (env.XDG_CURRENT_DESKTOP ?? '')
    .split(':')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Order: the terminal that belongs to the running desktop, then whatever the
 * system chose as x-terminal-emulator, then the rest of the table, and finally
 * x-terminal-emulator through its generic `-e` interface as the last resort.
 *
 * x-terminal-emulator is resolved through /etc/alternatives first. When it points
 * at a terminal this table knows (gnome-terminal.wrapper → gnome-terminal), that
 * terminal's own syntax is used; Debian's terminator, for example, only treats `-e`
 * as "the rest is the command" when it is invoked under the x-terminal-emulator name.
 */
export function findLinuxTerminals(
  env: NodeJS.ProcessEnv,
  options: LinuxTerminalDiscoveryOptions = {},
): LinuxTerminalCandidate[] {
  const executableCheck = options.isExecutableFile ?? isExecutableFile
  const resolveLink = options.realpath ?? realpathOrNull
  const directories = linuxTerminalSearchDirectories(env)
  function locate(name: string): string | null {
    for (const directory of directories) {
      const candidate = path.posix.join(directory, name)
      if (executableCheck(candidate)) return candidate
    }
    return null
  }

  const desktop = desktopTokens(env)
  const preferred = linuxTerminalTable.filter((definition) => (
    definition.desktops.some((name) => desktop.includes(name.toLowerCase()))
  ))
  const systemDefault = locate('x-terminal-emulator')
  const systemDefaultTarget = systemDefault ? resolveLink(systemDefault) : null
  const systemDefaultName = systemDefaultTarget
    ? path.posix.basename(systemDefaultTarget).replace(/\.(wrapper|real)$/, '')
    : null
  const systemChoice = systemDefaultName
    ? linuxTerminalTable.find((definition) => definition.executables.includes(systemDefaultName))
    : undefined

  const candidates: LinuxTerminalCandidate[] = []
  const seen = new Set<LinuxTerminalId>()
  for (const definition of [...preferred, ...(systemChoice ? [systemChoice] : []), ...linuxTerminalTable]) {
    if (seen.has(definition.id)) continue
    seen.add(definition.id)
    for (const name of definition.executables) {
      const executable = locate(name)
      if (executable) {
        candidates.push({ id: definition.id, label: definition.label, executable })
        break
      }
    }
  }
  if (systemDefault) {
    candidates.push({ id: genericTerminal.id, label: genericTerminal.label, executable: systemDefault })
  }
  return candidates
}

function definitionFor(id: LinuxTerminalId): LinuxTerminalDefinition {
  return linuxTerminalTable.find((definition) => definition.id === id) ?? genericTerminal
}

function assertSimpleLauncherPath(launcherPath: string): void {
  if (!/^\/[A-Za-z0-9._/+-]+$/.test(launcherPath) || launcherPath.split('/').some((part) => part === '..' || part === '.')) {
    throw new TypeError('launcher path must be an absolute path of plain characters')
  }
}

/** The terminal's whole argument list: constants and the launcher path, nothing the user typed. */
export function buildLinuxTerminalArgv(id: LinuxTerminalId, launcherPath: string): string[] {
  assertSimpleLauncherPath(launcherPath)
  return definitionFor(id).argv(launcherShell, launcherPath)
}

export interface LinuxTerminalScriptPlan {
  executable: string
  argv: readonly string[]
  workspace: string
  launcherPath: string
  /** 窗口标题，例如「Claude Code · 星芒AI」。 */
  title: string
  env: NodeJS.ProcessEnv
}

export interface LinuxTerminalLaunchPlan extends Omit<LinuxTerminalScriptPlan, 'launcherPath'> {}

/**
 * Variables written into the launcher. The script has to state them itself
 * because a terminal that hands the window to an already running server process
 * (deepin-terminal, tilix, konsole and xfce4-terminal in their default modes) may
 * start the CLI with that server's environment rather than the one passed to the
 * spawned client.
 *
 * TERM is left out on purpose: unlike Terminal.app, every Linux terminal sets its
 * own, and forcing xterm-256color into kitty or xterm would describe the wrong
 * terminal. The proxy variables are here because the app may have just dropped
 * one that points at a closed local port (stale-proxy-environment.ts); a live one
 * is carried over unchanged, exactly as the inherited environment did before.
 */
const exportedEnvironmentKeys = new Set([
  'HOME',
  'PATH',
  'CODEX_HOME',
  'GEMINI_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'NODE_USE_SYSTEM_CA',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'COLORTERM',
  'FORCE_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
])

/**
 * The app decides these for every launch. When the plan leaves one out, a server
 * process's copy must not fill the gap: that would put another account's endpoint,
 * a dead proxy or a colour switch back into the window.
 */
const clearedWhenAbsentKeys = [
  'CODEX_HOME',
  'GEMINI_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'GEMINI_MODEL',
  // providerCommandEnvironment 每次打开 Gemini 都会去掉这两个，不再补回来。
  'GOOGLE_GENAI_API_VERSION',
  'GOOGLE_GEMINI_API_KEY',
  'NO_COLOR',
  'NODE_DISABLE_COLORS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const

function isAbsolutePath(value: string): boolean {
  return Boolean(value) && !value.includes('\0') && path.posix.isAbsolute(value)
}

function printLines(lines: readonly string[], indent: string): string[] {
  return lines.map((line) => `${indent}printf '%s\\n' ${quotePosixArgument(line)}`)
}

/**
 * Only the listed variables are ever written, so only their values are checked.
 * Everything else, including names a shell cannot export such as the
 * `BASH_FUNC_module%%` that environment-modules leaves in every login session,
 * stays with the terminal process and must not block the launch.
 */
function exportedEnvironment(env: NodeJS.ProcessEnv): Array<[string, string]> {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && exportedEnvironmentKeys.has(entry[0]))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
}

function assertLinuxTerminalPlan(plan: LinuxTerminalLaunchPlan): void {
  if (!isAbsolutePath(plan.executable)) throw new TypeError('executable must be an absolute path')
  if (!isAbsolutePath(plan.workspace)) throw new TypeError('workspace must be an absolute path')
  if (plan.argv.some((argument) => argument.includes('\0'))) {
    throw new TypeError('argv must not contain NUL bytes')
  }
  // printf hands the title to the terminal verbatim; a control character in it
  // would be an escape sequence of its own.
  if (!plan.title || /[\u0000-\u001f\u007f-\u009f]/.test(plan.title)) {
    throw new TypeError('title must be non-empty printable text')
  }
  for (const [key, value] of exportedEnvironment(plan.env)) {
    if (value.includes('\0')) throw new TypeError(`environment value for ${key} must not contain NUL bytes`)
  }
  for (const requiredKey of ['HOME', 'PATH'] as const) {
    if (!plan.env[requiredKey]?.trim()) {
      throw new TypeError(`environment ${requiredKey} is required`)
    }
  }
}

/** Builds the short-lived POSIX sh launcher that the terminal runs. */
export function buildLinuxTerminalScript(plan: LinuxTerminalScriptPlan): string {
  assertLinuxTerminalPlan(plan)
  assertSimpleLauncherPath(plan.launcherPath)
  const cleared = clearedWhenAbsentKeys.filter((key) => plan.env[key] === undefined)
  const environmentExports = exportedEnvironment(plan.env)
    .map(([key, value]) => `export ${key}=${quotePosixArgument(value)}`)

  return [
    '#!/bin/sh',
    // 第一行就删掉自己：脚本里有当前账号的值，而且删掉这件事本身就是「窗口真的打开了」的
    // 信号，launchLinuxTerminal 等的就是它。
    `rm -f -- ${quotePosixArgument(plan.launcherPath)}`,
    `rmdir -- ${quotePosixArgument(path.posix.dirname(plan.launcherPath))} 2>/dev/null || true`,
    `printf '\\033]0;%s\\007' ${quotePosixArgument(plan.title)}`,
    'xingmang_close_window() {',
    `  printf '%s' ${quotePosixArgument(cliCloseWindowPrompt)}`,
    '  read -r xingmang_close_answer || true',
    '}',
    // 进不去文件夹时 sh 只会留一句英文；换成中文说明，并且不启动工具。只输出固定文案。
    `if ! cd -- ${quotePosixArgument(plan.workspace)} 2>/dev/null; then`,
    ...printLines(linuxFolderAccessHintLines, '  '),
    '  xingmang_close_window',
    '  exit 1',
    'fi',
    ...(cleared.length ? [`unset ${cleared.join(' ')}`] : []),
    ...environmentExports,
    // 不 exec：工具退出后还要留在脚本里补一句中文，再等回车关窗口。trap 让 sh 在用户按
    // Ctrl+C 时不跟着工具一起被打断；它是处理函数不是忽略，工具照旧收到默认的 SIGINT。
    "trap ':' INT",
    'cli_exit_code=0',
    `${[plan.executable, ...plan.argv].map(quotePosixArgument).join(' ')} || cli_exit_code=$?`,
    "printf '\\n'",
    'if [ "$cli_exit_code" -eq 0 ]; then',
    ...printLines(cliExitHintLines.normal, '  '),
    'else',
    ...printLines(cliExitHintLines.unexpected, '  '),
    'fi',
    'xingmang_close_window',
    '',
  ].join('\n')
}

/**
 * 找不到命令窗口、都没起来、起来了却一直没运行启动脚本：三种情况各给一句大白话。
 * system-service.ts 会在前面加上「未能打开 某某工具：」。
 */
export const linuxTerminalFailureMessages = {
  notFound: '这台电脑上没找到能打开命令窗口的程序（终端）。打开系统自带的应用商店，搜「终端」装一个，装好后回星芒再点「打开」。',
  notStarted: '命令窗口没能打开。再点一次「打开」试试；还不行就点「找客服」，把这句话发给客服。',
  notShown: '命令窗口一直没有出现。再点一次「打开」试试；还不行就点「找客服」，把这句话发给客服。',
  noLauncherDirectory: '这台电脑的临时文件夹用不了，命令窗口没能打开。重启电脑后再试；还不行就点「找客服」。',
} as const

export interface LinuxTerminalAttempt {
  terminal: LinuxTerminalId
  executable: string
  /**
   * spawn-failed: the program could not be started at all.
   * exited: it ended with a failure before running the launcher.
   * timed-out: it never ran the launcher within the wait.
   */
  outcome: 'spawn-failed' | 'exited' | 'timed-out'
  /** The errno code for spawn-failed, the exit code or signal name for exited. */
  detail: string | null
}

export class LinuxTerminalLaunchError extends Error {
  readonly attempts: readonly LinuxTerminalAttempt[]
  /** The underlying system error, for the log only; the message stays in plain words. */
  readonly reason: string | null

  constructor(message: string, attempts: readonly LinuxTerminalAttempt[], reason: string | null = null) {
    super(message)
    this.name = 'LinuxTerminalLaunchError'
    this.attempts = attempts
    this.reason = reason
  }
}

export interface LinuxTerminalLaunchResult {
  terminal: LinuxTerminalCandidate
  /** The candidates that failed before this one worked. */
  attempts: readonly LinuxTerminalAttempt[]
}

export interface LinuxTerminalProcess {
  /** Settles once the program has started, or rejects when it could not be. */
  started: Promise<void>
  /** Resolves with the exit code, or the signal name, once the program has ended. */
  exited: Promise<number | string>
}

export type LinuxTerminalSpawner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => LinuxTerminalProcess

export interface LinuxTerminalLaunchDependencies {
  findTerminals?: (env: NodeJS.ProcessEnv) => LinuxTerminalCandidate[]
  spawnTerminal?: LinuxTerminalSpawner
  /** Where the private launcher directory may be created, best first; see resolveLinuxLauncherBaseDirectories. */
  launcherBaseDirectories?: (env: NodeJS.ProcessEnv) => readonly string[]
  /** How long one terminal gets to run the launcher. */
  waitMs?: number
  pollIntervalMs?: number
}

// 慢电脑上第一次开终端要加载一阵子；窗口出来了脚本马上就跑，所以成功时不会真等这么久。
const defaultTerminalWaitMs = 15_000
const defaultPollIntervalMs = 100

function spawnLinuxTerminal(
  executable: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): LinuxTerminalProcess {
  const child = spawn(executable, [...args], { ...options, detached: true, stdio: 'ignore' })
  const started = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => resolve())
  })
  const exited = new Promise<number | string>((resolve) => {
    child.once('exit', (code, signal) => resolve(code ?? signal ?? 'unknown'))
    child.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'))
  })
  child.unref()
  return { started, exited }
}

interface DirectoryFacts {
  isDirectory: boolean
  isSymbolicLink: boolean
  uid: number
  mode: number
}

function directoryFacts(directory: string): DirectoryFacts | null {
  try {
    const stats = fs.lstatSync(directory)
    return { isDirectory: stats.isDirectory(), isSymbolicLink: stats.isSymbolicLink(), uid: stats.uid, mode: stats.mode }
  } catch {
    return null
  }
}

/**
 * The launcher holds values such as the Gemini key for a moment, so it goes to the
 * per-user runtime directory first: tmpfs, owned by the user and 0700 by spec,
 * gone at logout. Without one, the system temp directory is used; mkdtemp creates
 * a 0700 directory nobody else can enter, and the sticky bit stops others from
 * renaming it away. The workspace is never used.
 *
 * Only plain-character paths qualify, because three terminals take the command as
 * one string they split on spaces.
 */
export function resolveLinuxLauncherBaseDirectories(
  env: NodeJS.ProcessEnv,
  inspect: (directory: string) => DirectoryFacts | null = directoryFacts,
  uid: number | undefined = process.getuid?.(),
  temporaryDirectory: string = os.tmpdir(),
): string[] {
  function plain(directory: string): boolean {
    return /^\/[A-Za-z0-9._/+-]*$/.test(directory)
      && !directory.split('/').some((part) => part === '..' || part === '.')
  }
  const accepted: string[] = []
  const runtime = env.XDG_RUNTIME_DIR?.trim()
  if (runtime && plain(runtime)) {
    const facts = inspect(runtime)
    if (facts?.isDirectory && !facts.isSymbolicLink && facts.uid === uid && (facts.mode & 0o077) === 0) accepted.push(runtime)
  }
  for (const directory of [temporaryDirectory, '/tmp']) {
    if (!directory || !plain(directory) || accepted.includes(directory)) continue
    const facts = inspect(directory)
    if (!facts?.isDirectory || facts.isSymbolicLink) continue
    const ownPrivate = facts.uid === uid && (facts.mode & 0o022) === 0
    const sharedSticky = facts.uid === 0 && (facts.mode & 0o1000) !== 0
    if (ownPrivate || sharedSticky) accepted.push(directory)
  }
  return accepted
}

async function launcherConsumed(launcherPath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(launcherPath)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

type WaitOutcome = { kind: 'consumed' } | { kind: 'exited'; detail: string } | { kind: 'timed-out' }

/**
 * A started process says nothing about a window: gnome-terminal's client exits 0
 * as soon as it has asked the server for one. The only proof is the launcher
 * deleting itself, which is its first line. A terminal that ends with a failure
 * before that point is skipped for the next one. A clean exit keeps the wait going,
 * since that is exactly what a client handing over to a server looks like.
 */
async function waitForLauncher(
  launcherPath: string,
  terminal: LinuxTerminalProcess,
  waitMs: number,
  pollIntervalMs: number,
): Promise<WaitOutcome> {
  let exit: number | string | undefined
  void terminal.exited.then((value) => { exit = value })
  const deadline = Date.now() + waitMs
  for (;;) {
    if (await launcherConsumed(launcherPath)) return { kind: 'consumed' }
    if (exit !== undefined && exit !== 0) return { kind: 'exited', detail: String(exit) }
    if (Date.now() >= deadline) return { kind: 'timed-out' }
    await delay(pollIntervalMs)
  }
}

async function writeLauncher(directory: string, launcherPath: string, content: string): Promise<LauncherIdentity> {
  try {
    await fs.promises.chmod(directory, 0o700)
    await writeLauncherAtomically(launcherPath, content, 0o600)
    return await captureLauncherIdentity(directory, launcherPath)
  } catch (error) {
    // Only reached before the launcher has an identity, inside the directory this
    // call just created with mkdtemp, so there is nothing in it worth preserving.
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

interface CreatedLauncher {
  directory: string
  launcherPath: string
  identity: LauncherIdentity
}

/**
 * A full /run/user tmpfs, a quota or a read-only temp directory is a property of
 * that one directory, so the next acceptable one is tried. The plan was validated
 * before this point, so anything thrown here is about the filesystem; the user
 * gets one plain sentence and the system error goes to the log.
 */
async function createLauncher(plan: LinuxTerminalLaunchPlan, baseDirectories: readonly string[]): Promise<CreatedLauncher> {
  let lastFailure: string | null = null
  for (const baseDirectory of baseDirectories) {
    try {
      await cleanupStaleTerminalDirectoriesOnce(baseDirectory)
      // The pid in the name lets the collector above tell an abandoned directory
      // from one whose owner is still waiting on it.
      const directory = await fs.promises.mkdtemp(path.posix.join(baseDirectory, terminalDirectoryPrefix()))
      const launcherPath = path.posix.join(directory, 'launch.sh')
      const identity = await writeLauncher(directory, launcherPath, buildLinuxTerminalScript({ ...plan, launcherPath }))
      return { directory, launcherPath, identity }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
  }
  throw new LinuxTerminalLaunchError(linuxTerminalFailureMessages.noLauncherDirectory, [], lastFailure)
}

/**
 * Writes the launcher, then tries each terminal until one runs it.
 *
 * A terminal that timed out is not followed by another: it may still be starting,
 * and a second window would be confusing. Its launcher is removed instead, so a
 * window that turns up late finds nothing to run rather than starting the tool a
 * second time.
 */
export async function launchLinuxTerminal(
  plan: LinuxTerminalLaunchPlan,
  dependencies: LinuxTerminalLaunchDependencies = {},
): Promise<LinuxTerminalLaunchResult> {
  assertLinuxTerminalPlan(plan)
  const candidates = (dependencies.findTerminals ?? findLinuxTerminals)(plan.env)
  if (!candidates.length) throw new LinuxTerminalLaunchError(linuxTerminalFailureMessages.notFound, [])
  const { directory, launcherPath, identity } = await createLauncher(
    plan,
    (dependencies.launcherBaseDirectories ?? resolveLinuxLauncherBaseDirectories)(plan.env),
  )

  const spawnTerminal = dependencies.spawnTerminal ?? spawnLinuxTerminal
  const waitMs = dependencies.waitMs ?? defaultTerminalWaitMs
  const pollIntervalMs = dependencies.pollIntervalMs ?? defaultPollIntervalMs
  const attempts: LinuxTerminalAttempt[] = []
  try {
    for (const candidate of candidates) {
      // The script enters the project folder itself and explains in Chinese when it
      // cannot. Starting the terminal there would turn an unreadable folder into a
      // spawn failure that blames the terminal instead.
      const terminal = spawnTerminal(candidate.executable, buildLinuxTerminalArgv(candidate.id, launcherPath), {
        cwd: '/',
        env: plan.env,
      })
      try {
        await terminal.started
      } catch (error) {
        attempts.push({
          terminal: candidate.id,
          executable: candidate.executable,
          outcome: 'spawn-failed',
          detail: (error as NodeJS.ErrnoException).code ?? null,
        })
        continue
      }
      const outcome = await waitForLauncher(launcherPath, terminal, waitMs, pollIntervalMs)
      if (outcome.kind === 'consumed') return { terminal: candidate, attempts }
      if (outcome.kind === 'exited') {
        attempts.push({ terminal: candidate.id, executable: candidate.executable, outcome: 'exited', detail: outcome.detail })
        continue
      }
      attempts.push({ terminal: candidate.id, executable: candidate.executable, outcome: 'timed-out', detail: null })
      throw new LinuxTerminalLaunchError(linuxTerminalFailureMessages.notShown, attempts)
    }
    throw new LinuxTerminalLaunchError(linuxTerminalFailureMessages.notStarted, attempts)
  } finally {
    await removeLauncherIfUnchanged(directory, launcherPath, identity)
  }
}
