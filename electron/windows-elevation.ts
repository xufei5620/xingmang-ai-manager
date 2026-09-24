import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  isUserWritableResolvedPathSync,
  trustedCommandEnvironment,
  type CommandSpec,
} from './command-runner'
import { cliExitHintLines } from './cli-exit-hint'
import { resolveWindowsMachinePaths, type WindowsMachinePaths } from './windows-machine-paths'

const execFileAsync = promisify(execFile)

export interface WindowsCliLaunchRequest {
  executable: string
  argv?: readonly string[]
  workspace: string
  title: string
  env?: NodeJS.ProcessEnv
}

export interface WindowsPowerShellLaunchPlan {
  executable: string
  argv: string[]
  cwd: string
  windowsHide: true
}

export interface WindowsPowerShellResolutionOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  isFile?: (candidate: string) => boolean
  isTrustedPath?: (candidate: string, env: NodeJS.ProcessEnv) => boolean
  machinePaths?: WindowsMachinePaths
}

export interface TrustedElevatedCliCommandOptions {
  env?: NodeJS.ProcessEnv
  isUserWritableResolvedPath?: (candidate: string, env: NodeJS.ProcessEnv) => boolean
  machinePaths?: WindowsMachinePaths
}

export type WindowsCliExecutionMode = 'trusted-only' | 'same-user'
export type WindowsTokenElevationType = 'default' | 'full' | 'limited'
/** 这个账号能不能自己提权：administrator = 在管理员组，standard = 不在，unknown = 没问出来。 */
export type WindowsElevationCapability = 'administrator' | 'standard' | 'unknown'

export interface ResolveWindowsCliExecutionModeOptions {
  isPackaged: boolean
  platform?: NodeJS.Platform
  probeAdministrator?: () => Promise<boolean>
  probeElevationType?: () => Promise<WindowsTokenElevationType>
  /** Mandatory integrity RID of the current token, or null when it cannot be read. */
  probeIntegrityRid?: () => Promise<number | null>
}

export interface WindowsAdministratorProbeOptions {
  env?: NodeJS.ProcessEnv
  machinePaths?: WindowsMachinePaths
  timeoutMs?: number
}

/** Resolve Windows PowerShell from the protected system directory. Never let
 * an elevated launch depend on the caller's (user-modifiable) PATH. */
export function windowsPowerShellExecutable(
  _env: NodeJS.ProcessEnv = process.env,
  machinePathsInput?: WindowsMachinePaths,
): string {
  if (process.platform !== 'win32' && !machinePathsInput) return 'powershell.exe'
  const machinePaths = machinePathsInput ?? resolveWindowsMachinePaths()
  return path.win32.join(machinePaths.system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function windowsPowerShellCandidates(
  _env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  machinePathsInput?: WindowsMachinePaths,
): string[] {
  if (platform !== 'win32') return []
  const machinePaths = machinePathsInput ?? resolveWindowsMachinePaths()
  const candidates = [
    path.win32.join(machinePaths.system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  const programFilesRoots = [machinePaths.programFiles, machinePaths.programFilesX86]
    .filter((value): value is string => Boolean(value))
  for (const root of programFilesRoots) {
    const candidate = path.win32.join(root, 'PowerShell', '7', 'pwsh.exe')
    if (!candidates.some((value) => value.toLowerCase() === candidate.toLowerCase())) {
      candidates.push(candidate)
    }
  }
  return candidates
}

function regularFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** Resolve only fixed, machine-level PowerShell locations. PATH is never read. */
export function resolveWindowsPowerShellExecutable(
  options: WindowsPowerShellResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw new Error('PowerShell CLI 启动仅支持 Windows')
  const env = options.env ?? process.env
  const machinePaths = options.machinePaths ?? resolveWindowsMachinePaths()
  const isFile = options.isFile ?? regularFile
  const isTrustedPath = options.isTrustedPath
    ?? ((candidate, candidateEnv) => !isUserWritableResolvedPathSync(candidate, candidateEnv, machinePaths))
  const executable = windowsPowerShellCandidates(env, platform, machinePaths)
    .find((candidate) => isFile(candidate) && isTrustedPath(candidate, env))
  if (executable) return executable
  throw new Error(
    '未找到可用的系统 PowerShell；请启用 Windows PowerShell，或将 64 位 PowerShell 7 安装到 Program Files\\PowerShell\\7',
  )
}

/**
 * Detects the current Windows token without consulting PATH or a user-owned
 * executable. An invalid probe result is an error so callers can fail closed.
 */
export async function inspectCurrentWindowsProcessAdministrator(
  options: WindowsAdministratorProbeOptions = {},
): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const env = options.env ?? process.env
  const machinePaths = options.machinePaths ?? resolveWindowsMachinePaths()
  const { stdout } = await execFileAsync(
    resolveWindowsPowerShellExecutable({ env, machinePaths }),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=[Security.Principal.WindowsPrincipal]::new($identity);$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ],
    {
      env: trustedCommandEnvironment(env, machinePaths),
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 64 * 1024,
    },
  )
  const value = stdout.trim().toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('无法确认当前 Windows 进程是否具有管理员权限')
}

/**
 * Whether this Windows account can raise itself to administrator at all. This is a
 * different question from `inspectCurrentWindowsProcessAdministrator`, which only
 * reports the *current* token: under UAC an administrator normally runs filtered,
 * so that probe answers "no" for an account that can elevate with one click, and
 * also "no" for a standard account that cannot elevate without someone else's
 * password. Node.js and the Codex desktop package both need a real elevation, so
 * the two cases have to be told apart before the UAC prompt appears.
 *
 * A UAC-filtered token still carries BUILTIN\Administrators in its group list
 * (as deny-only), which is why group membership survives the filtering and can be
 * read from the ordinary, unelevated process. whoami lists deny-only groups;
 * .NET's WindowsIdentity.Groups deliberately skips them, so a PowerShell probe
 * built on it calls every filtered administrator "standard". The SID is compared
 * as a whole quoted field so the answer does not depend on the display language,
 * and output without exactly one mandatory label is not whoami's and answers
 * "unknown".
 */
export function parseWindowsElevationCapability(output: string): WindowsElevationCapability {
  if (parseWindowsMandatoryLabelRid(output) === null) return 'unknown'
  return /"S-1-5-32-544"/.test(output) ? 'administrator' : 'standard'
}

export async function inspectWindowsElevationCapability(
  options: WindowsAdministratorProbeOptions & { signal?: AbortSignal } = {},
): Promise<WindowsElevationCapability> {
  if (process.platform !== 'win32') return 'unknown'
  try {
    return parseWindowsElevationCapability(await readCurrentWindowsTokenGroups(options))
  } catch {
    // Never let this probe break an install or a self-check: an unknown answer
    // only means the extra sentence is left out.
    return 'unknown'
  }
}

/**
 * The sentence appended when the account provably cannot elevate on its own.
 * Deliberately not an instruction to re-run the app as administrator: running
 * elevated bypasses the problem instead of fixing it, and this app is built to
 * run unelevated (I2 keeps the elevation boundary narrow on purpose).
 */
export function windowsStandardAccountAdvice(): string {
  return '这个 Windows 账号不在管理员组，需要在授权窗口里输入一个管理员账号的密码才能继续；公司或学校的电脑请联系 IT 协助。'
}

/** 用户在授权窗口点了「否」或直接关掉。 */
export function windowsElevationCancelledMessage(
  subject: string,
  capability: WindowsElevationCapability = 'unknown',
): string {
  const head = `已取消管理员授权，${subject}安装未开始。`
  return capability === 'standard'
    ? `${head}${windowsStandardAccountAdvice()}`
    : `${head}重新点击安装即可再次授权。`
}

/** 授权窗口出现过，但没拿到管理员权限（多半是账号本身没有）。 */
export function windowsElevationDeniedMessage(
  subject: string,
  capability: WindowsElevationCapability = 'unknown',
): string {
  const head = `未获得管理员权限，${subject}安装已停止。`
  return capability === 'standard'
    ? `${head}${windowsStandardAccountAdvice()}`
    : `${head}请在弹出的授权窗口点击「是」；如果这台电脑用的是普通账号，需要输入一个管理员账号的密码。`
}

export function parseWindowsTokenElevationType(value: string): WindowsTokenElevationType | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'default' || normalized === 'full' || normalized === 'limited') return normalized
  return null
}

/** SECURITY_MANDATORY_HIGH_RID: every TokenElevationTypeFull token runs at or above it. */
const highMandatoryIntegrityRid = 0x3000

/**
 * Reads the mandatory label out of `whoami /groups /fo csv /nh`. Group names are
 * localized, SIDs are not, so only a quoted field that is exactly an S-1-16-*
 * SID counts; anything but exactly one such field is "unknown", never a guess.
 */
export function parseWindowsMandatoryLabelRid(output: string): number | null {
  const labels = [...output.matchAll(/"S-1-16-(\d{1,6})"/g)]
  if (labels.length !== 1) return null
  const rid = Number(labels[0][1])
  return Number.isSafeInteger(rid) ? rid : null
}

/**
 * whoami.exe answers in tens of milliseconds, where the Add-Type probe below has
 * to start PowerShell and compile C# first: seconds on an ordinary machine, and
 * past its 15 second cap on a slow one or right after boot. The main window
 * waits for this answer, so it is asked first.
 */
export async function inspectCurrentWindowsIntegrityRid(
  options: WindowsAdministratorProbeOptions = {},
): Promise<number | null> {
  if (process.platform !== 'win32') return null
  return parseWindowsMandatoryLabelRid(await readCurrentWindowsTokenGroups(options))
}

/**
 * Whether the current token runs at High integrity or above, which is what an
 * elevated administrator (or the built-in Administrator) holds. Null when the
 * label cannot be read; the caller decides what that means.
 */
export async function inspectCurrentWindowsProcessHighIntegrity(
  options: WindowsAdministratorProbeOptions = {},
): Promise<boolean | null> {
  const rid = await inspectCurrentWindowsIntegrityRid(options)
  return rid === null ? null : rid >= highMandatoryIntegrityRid
}

async function readCurrentWindowsTokenGroups(
  options: WindowsAdministratorProbeOptions & { signal?: AbortSignal },
): Promise<string> {
  const env = options.env ?? process.env
  const machinePaths = options.machinePaths ?? resolveWindowsMachinePaths()
  const { stdout } = await execFileAsync(
    path.win32.join(machinePaths.system32, 'whoami.exe'),
    ['/groups', '/fo', 'csv', '/nh'],
    {
      env: trustedCommandEnvironment(env, machinePaths),
      windowsHide: true,
      timeout: options.timeoutMs ?? 5_000,
      maxBuffer: 256 * 1024,
      signal: options.signal,
    },
  )
  return stdout
}

/**
 * Distinguishes an explicitly elevated UAC token from a default token. The
 * built-in Administrator account can hold a high-integrity default token when
 * Admin Approval Mode is disabled; that is the account's ordinary execution
 * context, not an elevation boundary introduced by launching this app.
 */
/**
 * What the token-elevation probe hands PowerShell. Pure, so the script is checked as text on
 * every platform: compiling this Add-Type through csc.exe inside a cold Windows PowerShell is
 * what a busy runner kept failing to finish in time (#511).
 */
export function buildWindowsTokenElevationProbeScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class XingMangTokenElevationProbe {',
    '  [DllImport("advapi32.dll", SetLastError = true)]',
    '  public static extern bool GetTokenInformation(IntPtr token, int informationClass, out int information, int informationLength, out int returnLength);',
    '}',
    "'@",
    '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
    '$elevationType = 0',
    '$returnLength = 0',
    '$ok = [XingMangTokenElevationProbe]::GetTokenInformation($identity.Token, 18, [ref]$elevationType, 4, [ref]$returnLength)',
    'if (-not $ok) { throw "GetTokenInformation(TokenElevationType) failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }',
    'switch ($elevationType) {',
    '  1 { "default" }',
    '  2 { "full" }',
    '  3 { "limited" }',
    '  default { throw "Unexpected TokenElevationType: $elevationType" }',
    '}',
  ].join('\n')
}

export interface WindowsTokenElevationProbeOptions extends WindowsAdministratorProbeOptions {
  platform?: NodeJS.Platform
  /** Test seams: production leaves both unset and runs the resolved system PowerShell through execFile. */
  resolvePowerShell?: () => string
  run?: (executable: string, argv: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }) => Promise<string>
}

async function runTokenElevationProbe(
  executable: string,
  argv: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number },
): Promise<string> {
  const { stdout } = await execFileAsync(executable, argv, {
    env: options.env,
    windowsHide: true,
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes,
  })
  return stdout
}

export async function inspectCurrentWindowsTokenElevationType(
  options: WindowsTokenElevationProbeOptions = {},
): Promise<WindowsTokenElevationType> {
  if ((options.platform ?? process.platform) !== 'win32') return 'default'
  const env = options.env ?? process.env
  const machinePaths = options.machinePaths ?? resolveWindowsMachinePaths()
  const executable = options.resolvePowerShell?.() ?? resolveWindowsPowerShellExecutable({ env, machinePaths })
  const stdout = await (options.run ?? runTokenElevationProbe)(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', buildWindowsTokenElevationProbeScript()],
    {
      env: trustedCommandEnvironment(env, machinePaths),
      // Keep startup bounded: main-window creation waits for this probe.
      // A timeout is a failed probe; the caller decides what that means.
      timeoutMs: options.timeoutMs ?? 15_000,
      maxOutputBytes: 64 * 1024,
    },
  )
  const elevationType = parseWindowsTokenElevationType(stdout)
  if (!elevationType) throw new Error('无法确认当前 Windows 进程的令牌提升类型')
  return elevationType
}

/**
 * 探测失败的几种可以分辨的原因。只用来让客服看懂「这次为什么没问出来」，
 * **不参与判定**：按哪种方式处理只看完整性标签读没读出来（见
 * `resolveWindowsCliExecutionModeDetailed`）。
 */
export type WindowsExecutionProbeFailureReason =
  | 'timeout'
  | 'powershell-unavailable'
  | 'blocked'
  | 'unexpected-output'
  | 'failed'

export interface WindowsExecutionProbeFailure {
  reason: WindowsExecutionProbeFailureReason
  /** 上游原文的第一段，只进运行日志，不上屏、不进检查页。 */
  detail: string
}

export interface WindowsCliExecutionModeResolution {
  mode: WindowsCliExecutionMode
  /** 探测花了多久。主窗口要等它，慢机器上这一项本身就是线索。 */
  elapsedMs: number
  /** 只有探测失败时才有；这时 mode 可能是 same-user，也可能是 trusted-only。 */
  probeFailure?: WindowsExecutionProbeFailure
}

const PROBE_FAILURE_DETAIL_LIMIT = 300

function probeFailureText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const stderr = (error as { stderr?: unknown }).stderr
  const stderrText = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : ''
  if (stderrText.trim()) return stderrText
  // execFile 的 message 是「Command failed: <整条命令行>」，命令行里就是探测脚本本身
  // （Add-Type、TokenElevationType 都在里面），拿它归类每次都会归成同一类。
  return error.message.startsWith('Command failed:') ? '' : error.message
}

/**
 * Classifies why the token probe failed without changing what the failure
 * means; that is decided by `resolveWindowsCliExecutionModeDetailed`. The
 * distinctions exist so support can tell a machine whose security software
 * blocks PowerShell's `Add-Type` compilation from one that was merely too slow.
 */
export function classifyWindowsExecutionProbeFailure(error: unknown): WindowsExecutionProbeFailure {
  const text = probeFailureText(error)
  // execFile 的 code 在进程非零退出时是退出码（数字），spawn 失败时才是 ENOENT 这类字符串。
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined
  const killed = error instanceof Error && (error as { killed?: unknown }).killed === true
  const signal = error instanceof Error ? (error as { signal?: unknown }).signal : undefined
  const fallbackDetail = [typeof code === 'string' || typeof code === 'number' ? `code=${code}` : '', typeof signal === 'string' ? `signal=${signal}` : '']
    .filter(Boolean)
    .join(' ')
  const detail = (text.replace(/\s+/g, ' ').trim() || fallbackDetail || 'unknown').slice(0, PROBE_FAILURE_DETAIL_LIMIT)
  let reason: WindowsExecutionProbeFailureReason = 'failed'
  // execFile 超时时先 kill 子进程，再以 killed=true、signal=SIGTERM 报错。
  if (killed || code === 'ETIMEDOUT' || /timed? ?out|超时/i.test(text)) reason = 'timeout'
  else if (code === 'ENOENT' || /未找到可用的系统 PowerShell/.test(text)) reason = 'powershell-unavailable'
  else if (
    code === 'EPERM'
    || code === 'EACCES'
    || /Add-Type|language mode|语言模式|Cannot add type|无法添加类型|csc\.exe|compil|编译|blocked|拦截|access is denied|拒绝访问|group policy|组策略/i.test(text)
  ) reason = 'blocked'
  else if (/无法确认当前 Windows 进程的令牌提升类型|Unexpected TokenElevationType/.test(text)) reason = 'unexpected-output'
  return { reason, detail }
}

const probeFailureDescriptions: Readonly<Record<WindowsExecutionProbeFailureReason, string>> = {
  timeout: '确认权限这一步超过 15 秒没做完，常见于电脑较慢或刚开机',
  'powershell-unavailable': '系统自带的命令行组件找不到或打不开',
  blocked: '确认权限这一步被安全软件或电脑的管控策略拦下了',
  'unexpected-output': '确认权限时系统给出的结果看不懂',
  failed: '确认权限这一步出错了',
}

/** 检查页与反馈报告共用的那半句原因，面向用户，不带任何上游原文。 */
export function describeWindowsExecutionProbeFailure(reason: WindowsExecutionProbeFailureReason): string {
  return probeFailureDescriptions[reason]
}

/** Packaged and development builds normally run as the current user. If a user
 * explicitly starts the app as administrator and that can be confirmed, retain
 * the restrictive boundary so user-writable commands are never inherited by the
 * elevated process. */
export async function resolveWindowsCliExecutionMode(
  options: ResolveWindowsCliExecutionModeOptions,
): Promise<WindowsCliExecutionMode> {
  return (await resolveWindowsCliExecutionModeDetailed(options)).mode
}

/**
 * Same decision as `resolveWindowsCliExecutionMode`, plus why a probe failed.
 *
 * A failed elevation probe is resolved by what the integrity label already said:
 * - label read as High or above: the token is known to be elevated (or the
 *   built-in Administrator), so the failure keeps the restrictive boundary;
 * - label unreadable too: nothing is known, and since this app never elevates
 *   itself that is overwhelmingly an ordinary user on a slow or locked-down
 *   machine. The strict fallback left exactly those users unable to install or
 *   open any tool, so it answers same-user (product decision, 2026-09-23).
 * The residual risk is an app started as administrator on a machine where
 * whoami and the PowerShell probe both fail; the self-check page still
 * compares the live token and tells that user to start it normally.
 */
export async function resolveWindowsCliExecutionModeDetailed(
  options: ResolveWindowsCliExecutionModeOptions & { now?: () => number },
): Promise<WindowsCliExecutionModeResolution> {
  const platform = options.platform ?? process.platform
  const now = options.now ?? Date.now
  const startedAt = now()
  const settle = (mode: WindowsCliExecutionMode, probeFailure?: WindowsExecutionProbeFailure) => ({
    mode,
    elapsedMs: Math.max(0, now() - startedAt),
    ...(probeFailure ? { probeFailure } : {}),
  })
  if (platform !== 'win32') return settle('same-user')
  let integrityRid: number | null = null
  try {
    // Below High integrity the token cannot be the elevated half of a split
    // admin token, which is the only case that answers trusted-only, so the
    // verdict is the one the full probe would reach. At High and above (an
    // elevated admin, or the built-in Administrator with a default token) and
    // whenever the label cannot be read, the full probe still decides.
    const probeIntegrityRid = options.probeIntegrityRid
      ?? (options.probeElevationType || options.probeAdministrator ? undefined : inspectCurrentWindowsIntegrityRid)
    if (probeIntegrityRid) {
      integrityRid = await probeIntegrityRid().catch(() => null)
      if (integrityRid !== null && integrityRid < highMandatoryIntegrityRid) return settle('same-user')
    }
    if (options.probeElevationType) {
      return settle(await options.probeElevationType() === 'full' ? 'trusted-only' : 'same-user')
    }
    if (options.probeAdministrator) {
      return settle(await options.probeAdministrator() ? 'trusted-only' : 'same-user')
    }
    return settle(await inspectCurrentWindowsTokenElevationType() === 'full' ? 'trusted-only' : 'same-user')
  } catch (error) {
    return settle(integrityRid === null ? 'same-user' : 'trusted-only', classifyWindowsExecutionProbeFailure(error))
  }
}

function requireWindowsLaunchValue(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label}不能为空`)
  if (value.includes('\0')) throw new Error(`${label}包含无效字符`)
  return value
}

// PowerShell's tokenizer accepts U+2018..U+201B as single quotes too
// (CharExtensions.IsSingleQuote in engine/parser/CharTraits.cs), both to open
// and to close a verbatim string. Escaping only the ASCII quote lets a path
// such as C:\Users\O’Brien end the literal early and run the rest as code.
// Inside a verbatim string any quote character followed by another is read as
// one literal copy of the second, so doubling each one in place keeps the text.
export function powerShellLiteral(value: string): string {
  return `'${value.replace(/['\u2018-\u201b]/g, '$&$&')}'`
}

export function encodeWindowsPowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export function decodeWindowsPowerShellCommand(encodedCommand: string): string {
  return Buffer.from(encodedCommand, 'base64').toString('utf16le')
}

export function parseStartedWindowsProcessId(output: string): number | null {
  const line = output.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean)
  if (!line || !/^\d{1,10}$/.test(line)) return null
  const processId = Number(line)
  return Number.isSafeInteger(processId) && processId > 0 ? processId : null
}

export function assertTrustedElevatedCliCommand(
  command: Pick<CommandSpec, 'executable' | 'argv'>,
  toolName: string,
  options: TrustedElevatedCliCommandOptions = {},
): void {
  const env = options.env ?? process.env
  const isUserWritableResolvedPath = options.isUserWritableResolvedPath
    ?? ((candidate, candidateEnv) => (
      isUserWritableResolvedPathSync(candidate, candidateEnv, options.machinePaths)
    ))
  const executable = requireWindowsLaunchValue(command.executable, 'CLI 路径')
  if (!path.win32.isAbsolute(executable)) {
    throw new Error(`${toolName}的运行时不是绝对路径，无法安全地以管理员权限执行`)
  }
  const targets = [
    { value: executable, label: '运行时' },
    ...command.argv
      .filter((argument) => path.win32.isAbsolute(argument))
      .map((value) => ({ value, label: 'CLI 脚本或绝对路径参数' })),
  ]
  const unsafe = targets.find((target) => isUserWritableResolvedPath(target.value, env))
  if (unsafe) {
    throw new Error(
      `${toolName}使用的${unsafe.label}位于用户可写目录、链接目标不可信或已失效，无法安全地以管理员权限执行；请通过本工具重新安装该 CLI（${unsafe.value}）`,
    )
  }
}

function windowsCliExitHint(lines: readonly string[], color: 'Cyan' | 'Yellow'): string {
  return ["Write-Host ''", ...lines.map((line) => `Write-Host ${powerShellLiteral(line)} -ForegroundColor ${color}`)].join('; ')
}

export function buildCliLaunchPlan(
  request: WindowsCliLaunchRequest,
  resolvedPowerShellExecutable = windowsPowerShellExecutable(),
): WindowsPowerShellLaunchPlan {
  const cliExecutable = requireWindowsLaunchValue(request.executable, 'CLI 路径')
  const cliArguments = (request.argv ?? []).map((argument) => requireWindowsLaunchValue(argument, 'CLI 参数'))
  const workspace = requireWindowsLaunchValue(request.workspace, '工作目录')
  const title = requireWindowsLaunchValue(request.title, '窗口标题')
  const powershellExecutable = requireWindowsLaunchValue(resolvedPowerShellExecutable, '系统 PowerShell 路径')
  if (!path.win32.isAbsolute(powershellExecutable)) {
    throw new Error('系统 PowerShell 路径必须是绝对路径')
  }

  const terminalScript = [
    // 这个窗口是交给用户的，-NoProfile 让用户自己在 profile 里设的编码也不生效：
    // 简体中文 Windows 默认代码页是 936，CLI 让子进程跑 `dir`、`git log` 时读回的
    // 中文会按 GBK 解码，AI 看到的就是乱码。主进程自己起的探测脚本都写了同一句。
    // .NET 的 OutputEncoding / InputEncoding 赋值本身就会调 SetConsoleOutputCP /
    // SetConsoleCP，等价于 chcp 65001，所以不额外跑 chcp——那会在可能提权的窗口里
    // 引入一次 PATH 查找系统可执行文件（I14）。设不上只是继续乱码，不能因此让
    // 用户点「打开」后 CLI 根本起不来，所以整句吞掉异常。
    'try { $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }',
    `$Host.UI.RawUI.WindowTitle = ${powerShellLiteral(title)}`,
    `$env:TERM = 'xterm-256color'`,
    `$env:COLORTERM = 'truecolor'`,
    `$env:FORCE_COLOR = '3'`,
    `$env:CLICOLOR = '1'`,
    `$env:CLICOLOR_FORCE = '1'`,
    'Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue',
    'Remove-Item Env:NODE_DISABLE_COLORS -ErrorAction SilentlyContinue',
    `Set-Location -LiteralPath ${powerShellLiteral(workspace)}`,
    `& ${powerShellLiteral(cliExecutable)}${cliArguments.map((argument) => ` ${powerShellLiteral(argument)}`).join('')}`,
    // 工具退出后 -NoExit 留下一个 PowerShell 提示符，小白会以为 AI 还在，往里打中文
    // 只换来一串红字。补一句中文告诉他下一步；各家退出码含义不一，非零只说「可能」。
    // 启动失败时 $LASTEXITCODE 仍是 $null，同样落到意外那一支。只输出固定文案，不引入变量。
    `if ($LASTEXITCODE -eq 0) { ${windowsCliExitHint(cliExitHintLines.normal, 'Cyan')} } else { ${windowsCliExitHint(cliExitHintLines.unexpected, 'Yellow')} }`,
  ].join('; ')
  const terminalEncodedCommand = encodeWindowsPowerShellCommand(terminalScript)
  const terminalArguments = [
    '-NoLogo',
    '-NoProfile',
    '-NoExit',
    '-EncodedCommand',
    terminalEncodedCommand,
  ]
  const brokerScript = [
    '$ErrorActionPreference = "Stop"',
    `$process = Start-Process -FilePath ${powerShellLiteral(powershellExecutable)} -ArgumentList @(${terminalArguments.map(powerShellLiteral).join(', ')}) -WorkingDirectory ${powerShellLiteral(workspace)} -WindowStyle Normal -PassThru`,
    '[Console]::Out.WriteLine($process.Id)',
  ].join('; ')

  return {
    executable: powershellExecutable,
    argv: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodeWindowsPowerShellCommand(brokerScript),
    ],
    cwd: workspace,
    windowsHide: true,
  }
}

function compactErrorDetail(value: string): string {
  return value
    .replace(/-EncodedCommand\s+\S+/gi, '-EncodedCommand [REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

export function describeWindowsCliLaunchError(error: unknown): string {
  const candidate = error as NodeJS.ErrnoException & { stderr?: unknown; stdout?: unknown; message?: unknown }
  const detail = compactErrorDetail([
    typeof candidate?.stderr === 'string' ? candidate.stderr : '',
    typeof candidate?.message === 'string' ? candidate.message : String(error ?? ''),
  ].filter(Boolean).join(' '))
  const code = typeof candidate?.code === 'string' ? candidate.code.toUpperCase() : ''
  if (code === 'ENOENT' || /cannot find|找不到.*文件|系统找不到/i.test(detail)) {
    return '系统 PowerShell 启动文件不存在或已被移除，请修复 Windows PowerShell 或安装 PowerShell 7'
  }
  if (
    code === 'EACCES'
    || code === 'EPERM'
    || /access (?:is )?denied|permission denied|拒绝访问|无权访问/i.test(detail)
  ) {
    return 'Windows 拒绝访问 PowerShell 或工作目录，请检查目录权限后重试'
  }
  if (/directory (?:name )?is invalid|cannot find.*path|找不到.*路径|目录.*(?:无效|不存在)/i.test(detail)) {
    return '工作目录已失效或无法访问，请重新选择工作目录'
  }
  return detail
    ? `Windows 无法启动 PowerShell：${detail}`
    : 'Windows 无法启动 PowerShell，请查看反馈与诊断日志'
}

function assertAccessibleWorkspace(workspace: string): void {
  try {
    if (!fs.statSync(workspace).isDirectory()) throw new Error('not-directory')
    fs.accessSync(workspace, fs.constants.R_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error('工作目录无法访问，请检查目录权限后重试')
    }
    throw new Error('工作目录不存在或已失效，请重新选择')
  }
}

export interface UnelevatedCommandWindowRequest {
  /** 固定拼装的命令行，禁止直接拼入渲染进程传来的字符串。 */
  commandLine: string
  title: string
  env?: NodeJS.ProcessEnv
  machinePaths?: WindowsMachinePaths
}

/** 从提权进程以登录用户身份打开一个命令窗口。explorer.exe 始终以 shell 用户的
 * 令牌运行，它拉起的进程因此不会继承管理员令牌——这是不引入原生模块就能降权的
 * 常规做法。用于执行位于用户可写目录、不应以管理员身份运行的卸载脚本。
 *
 * 批处理内容一律使用 ASCII：cmd.exe 按当前代码页逐行解析 .cmd，写入 UTF-8 中文
 * 会乱码，而 chcp 只对其后的输出生效、管不到解析本身。 */
export async function launchUnelevatedCommandWindow(
  request: UnelevatedCommandWindowRequest,
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('降权命令窗口仅支持 Windows')
  }
  if (!/^[\x20-\x7E]+$/.test(request.commandLine)) {
    throw new Error('降权命令包含非 ASCII 字符，已拒绝执行')
  }
  const machinePaths = request.machinePaths ?? resolveWindowsMachinePaths()
  const explorer = path.win32.join(machinePaths.systemRoot, 'explorer.exe')
  if (!fs.existsSync(explorer)) throw new Error('未找到 Windows 资源管理器，无法降权执行')

  const script = [
    '@echo off',
    `title ${request.title}`,
    `echo Running: ${request.commandLine}`,
    'echo.',
    `call ${request.commandLine}`,
    'echo.',
    'if errorlevel 1 (echo FAILED with code %errorlevel%) else (echo Completed successfully.)',
    'echo.',
    'echo You can close this window and refresh the app.',
    'pause',
    'del "%~f0"',
    '',
  ].join('\r\n')

  const scriptPath = path.join(os.tmpdir(), `xingmang-uninstall-${randomUUID()}.cmd`)
  await fs.promises.writeFile(scriptPath, script, { encoding: 'ascii', flag: 'wx', mode: 0o600 })
  const child = spawn(explorer, [scriptPath], {
    detached: true,
    stdio: 'ignore',
    env: request.env ?? process.env,
    windowsHide: false,
  })
  child.once('error', () => {
    fs.promises.rm(scriptPath, { force: true }).catch(() => undefined)
  })
  child.unref()
}

export async function launchCliPowerShell(
  request: WindowsCliLaunchRequest,
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('PowerShell CLI 启动仅支持 Windows')
  }
  assertAccessibleWorkspace(request.workspace)
  const powershellExecutable = resolveWindowsPowerShellExecutable()
  const plan = buildCliLaunchPlan(request, powershellExecutable)
  try {
    const { stdout } = await execFileAsync(plan.executable, plan.argv, {
      cwd: plan.cwd,
      env: request.env ?? process.env,
      windowsHide: plan.windowsHide,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    })
    if (!parseStartedWindowsProcessId(stdout)) {
      throw new Error('PowerShell 启动代理未返回有效的终端进程 ID')
    }
  } catch (error) {
    throw new Error(describeWindowsCliLaunchError(error))
  }
}
