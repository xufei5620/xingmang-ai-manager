// Antigravity 这一簇（命令行 agy 和桌面端）：检测装没装、一键装、把网关设置写给它、带着设置打开。
// 方案和实测事实见 docs/module-map/main-cli-clients.md 里 antigravity-* 那几条。
//
// 它不是第五个命令行工具（ProviderId）：那样登录时每次都会替它签密钥，安装也是按 npm 写的。这里单独一簇，
// 密钥按需签：只在客户点安装、打开时由调用方（IPC 那一层，手里有账号）交来一把，这里不碰账号。
//
// 和别的簇一样只 import 类型以外的底层模块，不 import 别的簇的值；要用别的簇的东西（终端的环境）由门面传进来。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AntigravityManagedKey } from './account-cli-provisioner'
import type { QueuedAccountWork } from './account-work-gate'
import {
  inspectAntigravityCliInstallation,
  installAntigravityCli,
  resolveAntigravityCliInstallTarget,
  type AntigravityCliInstallTarget,
} from './antigravity-cli-installer'
import { verifyDarwinAntigravityCli, type AntigravityCliDarwinProcess } from './antigravity-cli-macos'
import { resolveAntigravityCliPlatform } from './antigravity-cli-release'
import { resolveAntigravityDesktopPlatform } from './antigravity-desktop-release'
import {
  inspectAntigravityDesktopWindowsInstallation,
  installAntigravityDesktopWindows,
  resolveAntigravityDesktopWindowsExecutable,
} from './antigravity-desktop-windows'
import {
  antigravityGatewayVariableNames,
  buildAntigravityGatewayEnvironment,
  normalizeAntigravityGatewayUrl,
  type AntigravityEnvironmentValues,
  type AntigravityEnvironmentWriteOutcome,
  type AntigravityGatewayEnvironment,
} from './antigravity-gateway'
import { readMacosAntigravityEnvironment, writeMacosAntigravityEnvironment } from './antigravity-macos-environment'
import { readWindowsAntigravityEnvironment, writeWindowsAntigravityEnvironment } from './antigravity-windows-environment'
import { CommandRunnerError, commandEnvironment, runCommand, trustedCommandEnvironment, type CommandResult, type CommandSpec } from './command-runner'
import { darwinDeepVerificationTimeoutMs, darwinDeveloperIdVerificationArgv } from './macos-code-signing'
import { installMacosDesktopApp } from './macos-desktop-app-installer'
import { buildPowerShellJsonOutputStatements, powerShellUtf8OutputStatement } from './powershell-constrained-language'
import { buildPowerShellModuleImportStatement } from './powershell-module-imports'
import { relayRouteSiteIds, relaySiteEndpointIdForBaseUrl, type RelayEndpointId, type RelayRouteSiteId } from './relay-sites'
import { resolveWindowsExplorerExecutable } from './system-shell'
import { verifyOfficialNativeCliFile } from './trusted-native-cli'
import { encodeWindowsPowerShellCommand, launchCliPowerShell, resolveWindowsPowerShellExecutable, type WindowsCliExecutionMode, type WindowsCliLaunchRequest } from './windows-elevation'
import { resolveWindowsMachinePaths } from './windows-machine-paths'
import { assertWorkspaceDirectory } from './workspace-access'
import { launchMacosTerminal, type MacosTerminalLaunchPlan } from './macos-platform'

export type AntigravityTarget = 'cli' | 'desktop'

export interface AntigravityStatus {
  /** 这台电脑能不能用：Windows、Mac 的 x64 和 arm64（Linux 先不做）。 */
  supported: boolean
  cliInstalled: boolean
  desktopInstalled: boolean
  /**
   * 写下的四个设置都在，地址是当前账号此刻这条线路的 Gemini 地址，密钥是这台电脑上缓存的当前账号那一把。
   * 只看本机，不问服务端：密钥还能不能用、型号菜单是不是最新，每次打开时都会重新签、重新写一遍。
   */
  configured: boolean
}

export interface AntigravityProgress {
  target: AntigravityTarget
  phase: 'downloading' | 'verifying' | 'installing' | 'configuring'
  percent: number | null
}

export interface AntigravityInstallResult {
  status: AntigravityStatus
  /** 装好了、设置没写成时的那句话（多半是「服务暂时不可用」）。写成了就没有这一项。 */
  configureError?: string
}

/**
 * 打开桌面端的结果。closeFirst：它已经开着，而开着的那一份拿的不是这次写下的设置；它只认启动时带的设置、
 * 又只许开一个（再起一个 0.3 秒就退出），所以这时不打开，由界面请客户先关掉它。
 */
export interface AntigravityDesktopLaunchResult {
  opened: boolean
  closeFirst?: true
}

/** 调用方交来的取密钥那一步：只在要写设置时才调，签不到时抛它自己那句（AntigravityServiceUnavailableError）。 */
export type AntigravityKeyResolver = () => Promise<AntigravityManagedKey>

/** 什么时候回头看一眼 Antigravity 的设置跟没跟上：换了账号（含开机恢复登录），或者这个站换了线路。 */
export type AntigravityFollowReason = 'account-changed' | 'route-changed'

/** 设置里的地址是哪个站的哪条线路（日志里只记这两样，不记地址）。 */
export interface AntigravityGatewayLine {
  site: RelayRouteSiteId
  line: RelayEndpointId
}

/**
 * 回头看那一眼要做什么：
 * - keep：不动。不是星芒写的（not-managed）、已经是当前账号当前线路的（current）、只差线路但线路还没定下来
 *   （route-unsettled）、看不出当前账号的密钥又不在同一个站（unknown-account）。
 * - move-route：密钥就是当前账号那把，只是地址在同一个站的另一条线路上：密钥和菜单原样，只换地址，不联网。
 * - switch-account：密钥不是当前账号的（换了账号、换了站）：照点「打开」那样按当前账号取一把重写。
 */
export type AntigravityFollowPlan =
  | { action: 'keep', reason: 'not-managed' | 'current' | 'route-unsettled' | 'unknown-account' }
  | { action: 'move-route', environment: AntigravityGatewayEnvironment, from: AntigravityGatewayLine, to: AntigravityGatewayLine }
  | { action: 'switch-account', from: AntigravityGatewayLine, to: AntigravityGatewayLine | null }

/** 写一次设置时的两样讲究，缺省都是旧行为（启动文件那一段写不进就报错、不另外核账号）。 */
export interface AntigravityEnvironmentWriteOptions {
  /** Mac：终端启动文件那一段写不进只记一笔、照常往下走。打开桌面端、后台跟着改时用不上那个文件。 */
  startupFileOptional?: boolean
  /** 轮到这一笔、动手之前调，抛错就不写。 */
  assertBeforeWrite?: () => void
}

export class AntigravityElevatedSessionError extends Error {
  constructor() {
    super('星芒正以管理员身份运行，无法安装、设置或打开 Antigravity。请以普通方式重新打开星芒。')
    this.name = 'AntigravityElevatedSessionError'
  }
}

export interface AntigravityDetachedLaunchPlan extends CommandSpec {
  cwd?: string
  env: NodeJS.ProcessEnv
  windowsHide: boolean
}

export interface AntigravityServiceLog {
  (level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
}

export interface AntigravityServiceDependencies {
  platform: NodeJS.Platform
  architecture: NodeJS.Architecture
  env: NodeJS.ProcessEnv
  userHome: string
  executionMode: WindowsCliExecutionMode
  /** 安装队列（I11）：同 key 复用同一次，双击不会装两遍；signal 中止时还在排队的直接出队。 */
  enqueue<T>(key: string, task: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>
  /** 写设置排成一队：安装后写的那次和打开前写的那次不会同时改同一份文件。 */
  serializeSettingsWrite<T>(operation: () => Promise<T>): Promise<T>
  /** 当前账号站点、此刻这条线路上 Gemini 那一项的地址；每次写设置时读一次，整次只用这一个。 */
  gatewayBaseUrl(): string
  /**
   * 「自动」线路这会儿定下来没有（历史账号开机还没查出结论时先走线路1，没定下来）。没定下来不替它挪线路，
   * 同命令行工具的配置（relayRouting.selection）。缺省 = 定下来了。
   */
  gatewayRouteSettled?(): boolean
  /** 现在登录的是哪个账号（站点加用户，同外部客户端的归属），没登录 null。跟到一半换了账号就不写。缺省 = 不跟。 */
  accountOwner?(): string | null
  /**
   * 当前账号在这台电脑上缓存的 Gemini 那几把（Antigravity 用的就是它，和下线的 Gemini CLI 同一格），没登录、
   * 没签过交空的。首页「当前账号」和换账号后跟不跟都靠它比；明文只在主进程里比（I3）。缺省 = 只比地址（旧行为）。
   */
  cachedAccountKeys?(): Promise<readonly string[]>
  /**
   * 换账号、换线路以后替它跟上了：叫一声，界面只重读 Antigravity 两张卡（main.ts 发 antigravity:settings-followed）。
   * 不借线路那一声：那一声还会让界面把三个外部客户端重新检测一遍（复查 A 第 2 轮第 2 条）。
   */
  onFollowed?(): void
  /** 打开命令行时交给终端的环境（Windows 上用；Mac 的终端读登录 shell 的启动文件）。 */
  terminalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  fetch: typeof fetch
  log?: AntigravityServiceLog
  /** 只包谷歌那一路（加速线路）；存储桶那一路国内直连，不包。 */
  withVendorDownloadRoute?<T>(operation: () => Promise<T>): Promise<T>
  runCommand?: typeof runCommand
  installCli?: typeof installAntigravityCli
  installDesktopWindows?: typeof installAntigravityDesktopWindows
  installDesktopMac?: typeof installMacosDesktopApp
  writeWindowsEnvironment?: typeof writeWindowsAntigravityEnvironment
  readWindowsEnvironment?: typeof readWindowsAntigravityEnvironment
  writeMacosEnvironment?: typeof writeMacosAntigravityEnvironment
  readMacosEnvironment?: typeof readMacosAntigravityEnvironment
  verifyWindowsCli?(executablePath: string): Promise<unknown>
  verifyMacosCli?(executablePath: string, architecture: 'x64' | 'arm64', runProcess: (plan: AntigravityCliDarwinProcess) => Promise<CommandResult>): Promise<void>
  launchWindowsTerminal?(request: WindowsCliLaunchRequest): Promise<void>
  launchMacosTerminal?(plan: MacosTerminalLaunchPlan): Promise<void>
  /** 起一个和星芒脱开的进程，答回它的进程号（Mac 上靠它认出开着的那一份是不是星芒带着设置起的）。 */
  launchProcess?(plan: AntigravityDetachedLaunchPlan): Promise<number | null>
  /** 只给测试换掉：资源管理器的绝对路径和系统目录（I14，由固定解析器给出）。 */
  resolveWindowsShell?(): { explorer: string, systemRoot: string }
  resolvePowerShellExecutable?(): string
  /** 只给测试换掉：客户选的文件夹在不在、进不进得去。 */
  assertWorkspace?(workspace: string): void
  /** 只给测试换掉：本机一个文件是不是普通文件（不跟随链接）。 */
  isPlainFile?(filePath: string): boolean
  /** 只给测试换掉：本机一个目录是不是普通目录（不跟随链接）。 */
  isPlainDirectory?(directoryPath: string): boolean
  /** 系统的「应用程序」目录；只给测试换成临时目录。 */
  systemApplicationsDirectory?: string
  /** 只给测试换掉：现在的时间（毫秒），跟 Windows 上开着的那一份是什么时候起的比。 */
  now?(): number
}

/** Antigravity 桌面端在 Mac 上的身份：谷歌的 Developer ID 团队和 bundle id（11-23 两种芯片实测）。 */
export const antigravityDesktopMacTeamIdentifier = 'EQHXZ8M8AV'
export const antigravityDesktopMacBundleIdentifier = 'com.google.antigravity'

const desktopNotInstalledMessage = '未检测到 Antigravity，请先安装'
const cliNotInstalledMessage = '未检测到 Antigravity 命令行，请先安装'
const unsupportedMessage = '当前电脑的系统或处理器不支持 Antigravity'
const desktopNotOfficialMessage = '已安装的 Antigravity 不是 Google 官方签名版本，星芒不会打开它'
const cliNotOfficialMessage = '已安装的 Antigravity 命令行不是 Google 官方签名版本，星芒不会打开它'
const probeTimeoutMs = 15_000
const maximumProbeBytes = 256 * 1024

/**
 * 为哪一样写设置：桌面端不强求 Mac 终端启动文件那一段（打开时设置直接放进它的环境）；命令行要那一段，
 * Mac 的「终端」从那里读设置（复查 A 第 1 轮第 4 条）。
 */
export function writeOptionsFor(target: AntigravityTarget): AntigravityEnvironmentWriteOptions {
  return { startupFileOptional: target === 'desktop' }
}

/** 安装队列里这一项的名字。前缀不是 cli:launch:，退出拦截按安装算它（quit-blocking-tasks.ts）。 */
export function antigravityInstallQueueKey(target: AntigravityTarget): string {
  return `antigravity:install:${target}`
}

/** 打开命令行的排队名：同一文件夹的两次点击合成一次，前缀照旧 cli:launch:，退出拦截不当它是安装。 */
export function antigravityCliLaunchQueueKey(workspace: string, platform: NodeJS.Platform): string {
  const resolved = platform === 'win32' ? path.win32.resolve(workspace).toLowerCase() : path.posix.resolve(workspace)
  return `cli:launch:antigravity:${resolved}`
}

export const antigravityDesktopLaunchQueueKey = 'antigravity:launch:desktop'

/** 这台电脑能不能用：命令行和桌面端支持的平台一样（Windows、Mac 的 x64 和 arm64）。 */
export function isAntigravitySupported(platform: NodeJS.Platform, architecture: NodeJS.Architecture): boolean {
  return resolveAntigravityCliPlatform(platform, architecture) !== null
    && resolveAntigravityDesktopPlatform(platform, architecture) !== null
}

/**
 * 读回来的设置是不是星芒为当前站点、当前线路写的那一份：四个都在、不空，地址就是这条线路的 Gemini 地址，
 * 接口是 genai。地址收不成 Antigravity 要的样子（站点表里没有它）也算不是。菜单不比。
 * accountKeys 给了就连密钥一起比：得是当前账号缓存的那几把之一（同一个站换了账号，地址一样、密钥不一样）；
 * 没给只比地址和接口（旧行为）。
 */
export function isAntigravityEnvironmentCurrent(values: AntigravityEnvironmentValues, gatewayBaseUrl: string, accountKeys?: readonly string[]): boolean {
  for (const name of antigravityGatewayVariableNames) {
    if (!values[name]?.trim()) return false
  }
  let expected: string
  try {
    expected = normalizeAntigravityGatewayUrl(gatewayBaseUrl)
  } catch {
    return false
  }
  if (values.AGY_LLM_GATEWAY_URL !== expected || values.AGY_LLM_GATEWAY_WIRE_PROTOCOL !== 'genai') return false
  return accountKeys === undefined || accountKeys.includes(values.AGY_LLM_GATEWAY_API_KEY ?? '')
}

/**
 * 读回来的设置是不是星芒写的那种、写的是哪个站哪条线路：四个都在、接口是 genai，地址是某个站 Gemini 那一项
 * 登记过的地址（退役的别名也认）。Antigravity 的网关模式文档里没写，这四个变量又只有星芒写，地址认得出是
 * 中转的就是星芒写的；认不出（客户自己接的别的网关、没写过）回 null，跟账号、跟线路都不碰它。
 */
export function antigravityEnvironmentLine(values: AntigravityEnvironmentValues): AntigravityGatewayLine | null {
  for (const name of antigravityGatewayVariableNames) {
    if (!values[name]?.trim()) return null
  }
  if (values.AGY_LLM_GATEWAY_WIRE_PROTOCOL !== 'genai') return null
  const url = values.AGY_LLM_GATEWAY_URL ?? ''
  for (const site of relayRouteSiteIds) {
    const line = relaySiteEndpointIdForBaseUrl(site, 'gemini', url)
    if (line) return { site, line }
  }
  return null
}

/**
 * 换了账号、换了线路以后，Antigravity 那份设置要怎么跟（复查 A 第 1 轮第 3 条）。只看本机：
 * accountKeys 是当前账号缓存的 Gemini 那几把；undefined 是看不出（没接上账号缓存），这时只挪同一个站的线路。
 * routeSettled 为假（线路还没定下来）时不挪线路，换账号照样换：那一步写的就是点「打开」会写的那一份。
 */
export function planAntigravityFollow(values: AntigravityEnvironmentValues, input: {
  gatewayBaseUrl: string
  routeSettled: boolean
  accountKeys: readonly string[] | undefined
}): AntigravityFollowPlan {
  const from = antigravityEnvironmentLine(values)
  if (!from) return { action: 'keep', reason: 'not-managed' }
  let expected: string
  try {
    expected = normalizeAntigravityGatewayUrl(input.gatewayBaseUrl)
  } catch {
    return { action: 'keep', reason: 'not-managed' }
  }
  const to = antigravityEnvironmentLine({ ...values, AGY_LLM_GATEWAY_URL: expected })
  const key = values.AGY_LLM_GATEWAY_API_KEY ?? ''
  const accountKey = input.accountKeys === undefined ? null : input.accountKeys.includes(key)
  if (accountKey === false) return { action: 'switch-account', from, to }
  if (values.AGY_LLM_GATEWAY_URL === expected) return { action: 'keep', reason: 'current' }
  // 密钥对得上（或看不出）、地址不是这条线路的：同一个站只换地址；别的站的地址配不上这个站的密钥。
  if (!to || to.site !== from.site) return accountKey === null ? { action: 'keep', reason: 'unknown-account' } : { action: 'switch-account', from, to }
  if (!input.routeSettled) return { action: 'keep', reason: 'route-unsettled' }
  try {
    const environment = buildAntigravityGatewayEnvironment({ baseUrl: expected, apiKey: key, models: (values.AGY_LLM_GATEWAY_MODELS ?? '').split(',') })
    return { action: 'move-route', environment, from, to }
  } catch {
    // 菜单被改坏了、一个型号都不剩：原样搬不过去，照点「打开」那样重取一份。
    return { action: 'switch-account', from, to }
  }
}

/**
 * 交给子进程的环境：先去掉同名的旧值（Windows 上名字不分大小写，`agy_llm_gateway_url` 和大写是同一个），
 * 再放这次写下的四个，免得同一个变量交下去两份、子进程拿到哪一份全看运气。
 */
export function withAntigravityEnvironment(env: NodeJS.ProcessEnv, environment: AntigravityGatewayEnvironment): NodeJS.ProcessEnv {
  const names = new Set<string>(antigravityGatewayVariableNames)
  const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !names.has(key.toUpperCase())))
  return { ...kept, ...environment }
}

/** 这次写下的设置的指纹，只在内存里比「开着的那一份带的是不是这一份」，不落盘、不进日志。 */
export function antigravityEnvironmentFingerprint(environment: AntigravityGatewayEnvironment): string {
  const hash = createHash('sha256')
  for (const name of antigravityGatewayVariableNames) hash.update(`${name}=${environment[name]}\0`)
  return hash.digest('hex')
}

/** Mac 上 Antigravity.app 可能在的两处：「应用程序」，或没有管理员权限时装进的 ~/Applications。 */
export function antigravityDesktopMacCandidates(userHome: string, systemApplicationsDirectory = '/Applications'): string[] {
  return [
    path.posix.join(systemApplicationsDirectory, 'Antigravity.app'),
    path.posix.join(userHome, 'Applications', 'Antigravity.app'),
  ]
}

/**
 * Windows 上开着的 Antigravity.exe 各在哪里、什么时候起的：列路径和启动时间（FILETIME，UTC），交给调用方比。
 * 开着应用控制策略的电脑上 PowerShell 跑在受限语言模式里：设 UTF-8 那句只在完整模式下做，路径里的中文（用户名）
 * 在受限模式下转成 \uXXXX 再输出，主进程读回来是同一个路径（powershell-constrained-language.ts）；每一项是
 * 哈希表（受限模式不许 [pscustomobject]），启动时间只调 DateTime 自己的方法、转成字符串，两样受限模式都放行。
 * 启动时间读不出来的照样列出来、留空，调用方按「早于设置」算。模块按名字先导入：收窄过的环境里自动加载
 * 一次要十几秒，比打开前这一问的时限还长。
 */
export function buildAntigravityDesktopWindowsProcessScript(): string {
  return [
    powerShellUtf8OutputStatement,
    buildPowerShellModuleImportStatement(['Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management']),
    "$ErrorActionPreference = 'Stop'",
    "$found = @(Get-Process -Name Antigravity -ErrorAction SilentlyContinue | ForEach-Object { $path = $null; $started = ''; try { $path = [string]$_.Path } catch {}; try { $started = [string]$_.StartTime.ToFileTimeUtc() } catch {}; if ($path) { @{ path = $path; started = $started } } })",
    ...buildPowerShellJsonOutputStatements('ConvertTo-Json -InputObject @($found) -Compress'),
  ].join('\n')
}

// FILETIME 从 1601-01-01 起、以 100 纳秒计；减掉到 1970-01-01 的这段换成毫秒，跟 Date.now() 比。
const fileTimeTicksPerMillisecond = 10_000
const fileTimeEpochOffsetMilliseconds = 11_644_473_600_000

/**
 * 上面那段脚本的输出里这一份开着的各个进程什么时候起的（毫秒；读不出来的是 null）。没开着交空数组；
 * 读不懂的一律当作没开着之外的「看不出来」，交 null。
 */
export function parseAntigravityDesktopWindowsProcesses(stdout: string, executablePath: string): Array<number | null> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim() || '[]')
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const expected = path.win32.normalize(executablePath).toLowerCase()
  const started: Array<number | null> = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const { path: entryPath, started: fileTime } = entry as { path?: unknown, started?: unknown }
    if (typeof entryPath !== 'string' || path.win32.normalize(entryPath).toLowerCase() !== expected) continue
    started.push(typeof fileTime === 'string' && /^\d{1,20}$/.test(fileTime)
      ? Number(fileTime) / fileTimeTicksPerMillisecond - fileTimeEpochOffsetMilliseconds
      : null)
  }
  return started
}

/**
 * `ps -axo pid=,comm=` 的输出里，主程序是 `<bundle>/Contents/MacOS/` 下那几个的进程号。辅助进程在
 * Contents/Frameworks 下，不算。
 */
export function parseAntigravityDesktopMacProcesses(stdout: string, bundle: string): number[] {
  const prefix = `${bundle}/Contents/MacOS/`
  const pids: number[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (match && match[2].startsWith(prefix)) pids.push(Number(match[1]))
  }
  return pids
}

/** CFBundleExecutable 只能是 Contents/MacOS 下一个文件的名字：不带路径分隔、不是 . 和 ..。 */
export function isPlainBundleExecutableName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/.test(name) && name !== '.' && name !== '..'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultIsPlainFile(filePath: string): boolean {
  try {
    const stats = fs.lstatSync(filePath)
    return stats.isFile() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

function defaultIsPlainDirectory(directoryPath: string): boolean {
  try {
    const stats = fs.lstatSync(directoryPath)
    return stats.isDirectory() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

function defaultLaunchProcess(plan: AntigravityDetachedLaunchPlan): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.executable, [...plan.argv], {
      cwd: plan.cwd, env: plan.env, shell: false, detached: true,
      stdio: 'ignore', windowsHide: plan.windowsHide,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve(child.pid ?? null)
    })
  })
}

// codesign 退出码 1 是核对没过，3 是签名完好但不满足钉住的要求（团队、包名）；别的（没跑起来、超时）原样往上抛。
function refusedByCodesign(error: unknown): boolean {
  return error instanceof CommandRunnerError && error.code === 'EXIT_NON_ZERO' && (error.exitCode === 1 || error.exitCode === 3)
}

export function createAntigravityService(deps: AntigravityServiceDependencies) {
  const { platform, architecture, env, userHome } = deps
  const execute = deps.runCommand ?? runCommand
  const isPlainFile = deps.isPlainFile ?? defaultIsPlainFile
  const isPlainDirectory = deps.isPlainDirectory ?? defaultIsPlainDirectory
  const launchProcess = deps.launchProcess ?? defaultLaunchProcess
  // Mac 上星芒带着设置起的那一份：开着的主进程就是它、设置也没变，再点打开只把它叫到前面。
  let macSpawn: { bundle: string, pid: number, fingerprint: string } | null = null
  // Windows 上最近一次改写设置是什么时候（毫秒）：装、打开命令行或桌面端时改的，后台跟账号、跟线路改的，都算。它只认
  // 启动时的设置，起得比这早的那一份拿的是旧的，点「打开」时请客户先关掉，不能只看这一次点击写没写（别处已经写过，这次
  // 是 unchanged）。按进程启动时间判、不记「请关掉过」：客户自己关了、从开始菜单或桌面重新打开的，起得比改写晚，
  // 资源管理器已经换上新设置，不再请他关（复查 A 第 2 轮第 2 条）。开着的都比它晚（或都没开）以后清掉。
  // 只记在这次运行里：星芒重启后没有这一笔，改写时开着、一直没关的那一份点「打开」会被直接叫到前面（同 #2156 以前）。
  let windowsSettingsWrittenAt: number | null = null
  // 换账号、换线路以后自己跟的那一步取密钥用的：IPC 那一层注册通道时交来（手里有账号的只有那一层），撤通道时收回。
  let followKey: AntigravityKeyResolver | null = null
  // 跟的那一轮同一时刻只跑一轮；跑着时又叫的记下最后那个原因，跑完再看一遍（同 followManagedKeysNow）。
  let followRound: Promise<void> | null = null
  let followAgain: AntigravityFollowReason | null = null

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { deps.log?.(level, event, message, detail) } catch { /* 日志记不下不挡安装和打开。 */ }
  }

  function assertSupported(): void {
    if (!isAntigravitySupported(platform, architecture)) throw new Error(unsupportedMessage)
  }

  // 管理员身份打开的星芒：当前用户的环境变量可能根本不是坐在电脑前那个人的（换了管理员账号提权时
  // HKCU 是管理员那一份），装进用户文件夹的程序也不该从提权的进程里起。检测照常，其余一律不做。
  function assertSameUser(): void {
    if (platform === 'win32' && deps.executionMode !== 'same-user') throw new AntigravityElevatedSessionError()
  }

  function cliTarget(): AntigravityCliInstallTarget | null {
    return resolveAntigravityCliInstallTarget(platform, env, userHome)
  }

  function cliInstalled(): boolean {
    const target = cliTarget()
    if (!target) return false
    return deps.isPlainFile ? deps.isPlainFile(target.executablePath) : inspectAntigravityCliInstallation(target).installed
  }

  function windowsDesktopExecutable(): string | null {
    const executable = resolveAntigravityDesktopWindowsExecutable(platform, env, userHome)
    if (!executable) return null
    const installed = deps.isPlainFile ? deps.isPlainFile(executable) : inspectAntigravityDesktopWindowsInstallation(executable).installed
    return installed ? executable : null
  }

  function macDesktopBundle(): string | null {
    if (platform !== 'darwin') return null
    return antigravityDesktopMacCandidates(userHome, deps.systemApplicationsDirectory).find((candidate) => isPlainDirectory(candidate)) ?? null
  }

  function desktopInstalled(): boolean {
    return platform === 'win32' ? windowsDesktopExecutable() !== null : macDesktopBundle() !== null
  }

  async function readEnvironment(): Promise<AntigravityEnvironmentValues> {
    if (platform === 'win32') return (deps.readWindowsEnvironment ?? readWindowsAntigravityEnvironment)({ platform })
    return (deps.readMacosEnvironment ?? readMacosAntigravityEnvironment)({ platform, homeDirectory: userHome })
  }

  /** 当前账号缓存的 Gemini 那几把；没接上账号缓存回 undefined（只比地址），读不出来当作一把都没有。 */
  async function accountKeys(): Promise<readonly string[] | undefined> {
    if (!deps.cachedAccountKeys) return undefined
    try {
      return await deps.cachedAccountKeys()
    } catch {
      return []
    }
  }

  async function inspect(): Promise<AntigravityStatus> {
    if (!isAntigravitySupported(platform, architecture)) {
      return { supported: false, cliInstalled: false, desktopInstalled: false, configured: false }
    }
    let configured = false
    try {
      const values = await readEnvironment()
      const baseUrl = deps.gatewayBaseUrl()
      // 地址对上了才去读账号缓存：没写过、写的是别的线路的，用不着解一遍缓存。
      configured = isAntigravityEnvironmentCurrent(values, baseUrl) && isAntigravityEnvironmentCurrent(values, baseUrl, await accountKeys())
    } catch (error) {
      // 读不出来只当没写过：打开时会重新写一遍，不为一次读失败挡住检测。
      log('warn', 'antigravity.settings.read-failed', '没读出 Antigravity 的设置', { error: errorText(error) })
    }
    return { supported: true, cliInstalled: cliInstalled(), desktopInstalled: desktopInstalled(), configured }
  }

  /**
   * 写下整份设置，和别的工具配置排同一队。startupFileOptional：Mac 上终端启动文件那一段写不进只记一笔、照常往下走
   * （见 configureNow）。assertBeforeWrite 在轮到这一笔、动手之前调：后台跟的那一步排队时换了账号就不写。
   */
  function writeEnvironment(environment: AntigravityGatewayEnvironment, options: AntigravityEnvironmentWriteOptions = {}): Promise<AntigravityEnvironmentWriteOutcome> {
    return deps.serializeSettingsWrite(async (): Promise<AntigravityEnvironmentWriteOutcome> => {
      options.assertBeforeWrite?.()
      if (platform === 'win32') {
        const outcome = await (deps.writeWindowsEnvironment ?? writeWindowsAntigravityEnvironment)(environment, { platform })
        // 哪一步写的都记（安装、打开命令行、后台跟、打开桌面端）：开着的桌面端哪一次都拿不到（复查 A 第 3 轮）。
        if (outcome === 'written') noteWindowsSettingsWritten()
        return outcome
      }
      const result = await (deps.writeMacosEnvironment ?? writeMacosAntigravityEnvironment)(environment, {
        platform,
        homeDirectory: userHome,
        env,
        startupFileOptional: options.startupFileOptional === true,
        skipped: (displayPath, error) => log('warn', 'antigravity.settings.profile-skipped', '没写进终端的启动设置', { file: displayPath, error: errorText(error) }),
      })
      if (result.profile === 'unsupported-shell') {
        log('warn', 'antigravity.settings.unsupported-shell', '登录 shell 不是 zsh、bash、fish，自己开的终端里读不到 Antigravity 的设置')
      }
      return result.outcome
    })
  }

  /**
   * 签一把密钥、按当时的型号算出设置、写下去。地址只读一次，整次只用这一个（线路「自动」时可能半路换）。
   * 为桌面端写（writeOptionsFor('desktop')）时，Mac 上终端启动文件那一段写不进只记一笔、照常往下走：桌面端的设置
   * 由打开的那一步放进它的环境里，用不上那个文件（复查 A 第 1 轮第 4 条，~/.zprofile 是 dotfiles 的链接时桌面端打不开）。
   * 命令行要那一段：Mac 的「终端」从那里读设置，写不进照旧报错。
   */
  async function configureNow(
    resolveKey: AntigravityKeyResolver,
    options: AntigravityEnvironmentWriteOptions = {},
  ): Promise<{ environment: AntigravityGatewayEnvironment, outcome: AntigravityEnvironmentWriteOutcome }> {
    const baseUrl = deps.gatewayBaseUrl()
    const key = await resolveKey()
    const environment = buildAntigravityGatewayEnvironment({ baseUrl, apiKey: key.key, models: key.models })
    const outcome = await writeEnvironment(environment, options)
    // 只记词和个数，不记密钥、不记地址（I13）。
    log('info', 'antigravity.settings.saved', 'Antigravity 的设置已写好', {
      outcome,
      group: key.group,
      models: environment.AGY_LLM_GATEWAY_MODELS.split(',').length,
    })
    return { environment, outcome }
  }

  async function installCliNow(onProgress?: (progress: AntigravityProgress) => void): Promise<void> {
    const installed = await (deps.installCli ?? installAntigravityCli)({
      executionMode: deps.executionMode,
      platform,
      architecture,
      env,
      homeDirectory: userHome,
      fetchImpl: deps.fetch,
      onProgress: (progress) => onProgress?.({ target: 'cli', phase: 'downloading', percent: progress.percent }),
      bucket: { onFallback: (reason) => log('warn', 'antigravity.cli.bucket-fallback', 'Antigravity 命令行存储桶这一路没走通，改去谷歌下载', { reason }) },
      ...(deps.withVendorDownloadRoute ? { withVendorDownloadRoute: deps.withVendorDownloadRoute } : {}),
    })
    log('info', 'antigravity.cli.installed', 'Antigravity 命令行已装好', {
      version: installed.version,
      source: installed.source,
      ...(installed.userPath ? { userPath: installed.userPath } : {}),
    })
  }

  async function installDesktopNow(onProgress?: (progress: AntigravityProgress) => void): Promise<void> {
    // 两个平台都先从存储桶下；为什么没走通只进运行日志（detail 开头是桶里那个包的名字）。
    const bucket = { onFallback: (detail: string) => log('warn', 'antigravity.desktop.bucket-fallback', 'Antigravity 桌面端存储桶这一路没走通，改去谷歌下载', { detail }) }
    if (platform === 'win32') {
      const installed = await (deps.installDesktopWindows ?? installAntigravityDesktopWindows)({
        executionMode: deps.executionMode,
        platform,
        architecture,
        env,
        homeDirectory: userHome,
        fetchImpl: deps.fetch,
        onProgress: (progress) => onProgress?.({ target: 'desktop', phase: progress.phase, percent: progress.percent }),
        bucket,
        ...(deps.withVendorDownloadRoute ? { withVendorDownloadRoute: deps.withVendorDownloadRoute } : {}),
      })
      log('info', 'antigravity.desktop.installed', 'Antigravity 已装好', { version: installed.version })
      return
    }
    const installed = await (deps.installDesktopMac ?? installMacosDesktopApp)({
      tool: 'antigravityDesktop',
      architecture,
      userHome,
      environment: env,
      fetch: deps.fetch,
      runProcess: (plan) => execute({ executable: plan.executable, argv: [...plan.argv] }, {
        env: commandEnvironment(env), trustedOnly: false, timeoutMs: plan.timeoutMs, maxOutputBytes: 8 * 1024 * 1024,
      }),
      onProgress: (event) => onProgress?.({
        target: 'desktop',
        phase: event.phase === 'checking' ? 'verifying' : event.phase,
        percent: event.percent,
      }),
      ...(deps.systemApplicationsDirectory ? { systemApplicationsDirectory: deps.systemApplicationsDirectory } : {}),
      bucket,
      ...(deps.withVendorDownloadRoute ? { withVendorDownloadRoute: deps.withVendorDownloadRoute } : {}),
    })
    log('info', 'antigravity.desktop.installed', 'Antigravity 已装好', { version: installed.version })
  }

  /**
   * 装好以后接着写设置。写设置在安装队列外面做：要问账号、签密钥，不该让排在后面的别的安装干等。
   * 设置没写成不算装失败（程序已经在了），那句话交给界面另说。
   */
  async function install(
    target: AntigravityTarget,
    resolveKey: AntigravityKeyResolver,
    onProgress?: (progress: AntigravityProgress) => void,
  ): Promise<AntigravityInstallResult> {
    if (target !== 'cli' && target !== 'desktop') throw new Error('未知的 Antigravity 安装项')
    assertSupported()
    await deps.enqueue(antigravityInstallQueueKey(target), () => target === 'cli' ? installCliNow(onProgress) : installDesktopNow(onProgress))
    onProgress?.({ target, phase: 'configuring', percent: null })
    let configureError: string | undefined
    try {
      assertSameUser()
      await configureNow(resolveKey, writeOptionsFor(target))
    } catch (error) {
      configureError = errorText(error)
      log('warn', 'antigravity.settings.failed', 'Antigravity 已装好，设置没写成', { target, error: configureError })
    }
    const status = await inspect()
    return configureError === undefined ? { status } : { status, configureError }
  }

  /** 只写设置：签一把、按当时的型号重写一遍。 */
  async function configure(resolveKey: AntigravityKeyResolver): Promise<AntigravityStatus> {
    assertSupported()
    assertSameUser()
    await configureNow(resolveKey)
    return inspect()
  }

  /** IPC 那一层注册通道时交来自动签发那一档的取密钥，撤通道时交 null（同 bindToolRouteAccount）。 */
  function bindFollowKey(resolveKey: AntigravityKeyResolver | null): void {
    followKey = resolveKey
  }

  /**
   * 换了账号、换了线路以后回头看一眼（复查 A 第 1 轮第 3 条）。设置写进了用户环境变量（Mac 是终端启动文件读的
   * 那份），客户以后从开始菜单、程序坞、自己开的终端打开 Antigravity 都用它，所以不能只在点「打开」时写：
   * 换了账号还扣上一个账号的钱，「自动」换了线路它还连旧线路。
   *
   * 只跟星芒写的那份（antigravityEnvironmentLine 认得出地址是中转的），客户自己接的别的网关不碰；两样都没装、
   * 没登录、管理员身份打开的星芒都不看。密钥按需签的原则不变：只有这台电脑上已经写过星芒的设置才可能替新账号
   * 签一把，没用过 Antigravity 的客户不会因此多签。跟不上（签不到、写不进）只记日志，不挡别的工具，首页那张卡
   * 显示「待连接」，客户点「打开」时再写。
   */
  function follow(reason: AntigravityFollowReason): Promise<void> {
    if (followRound) {
      followAgain = reason
      return followRound
    }
    const round = (async () => {
      let next: AntigravityFollowReason | null = reason
      try {
        while (next) {
          followAgain = null
          await followOnce(next)
          next = followAgain
        }
      } finally {
        // 最后一次看完和这里之间没有 await：之后再叫的另起一轮，不会挂在一个已经不再回头看的轮次上。
        followRound = null
      }
    })()
    followRound = round
    return round
  }

  async function followOnce(reason: AntigravityFollowReason): Promise<void> {
    if (!isAntigravitySupported(platform, architecture)) return
    // 管理员身份打开的星芒不碰当前用户的设置（同 assertSameUser）。
    if (platform === 'win32' && deps.executionMode !== 'same-user') return
    // 两样都没装的不看：Windows 上读一次设置要起一次 PowerShell，没用 Antigravity 的客户换账号、换线路不该多起。
    if (!cliInstalled() && !desktopInstalled()) return
    const owner = deps.accountOwner?.() ?? null
    if (owner === null) return
    let plan: AntigravityFollowPlan
    try {
      const values = await readEnvironment()
      plan = planAntigravityFollow(values, {
        gatewayBaseUrl: deps.gatewayBaseUrl(),
        routeSettled: deps.gatewayRouteSettled?.() ?? true,
        accountKeys: await accountKeys(),
      })
    } catch (error) {
      log('warn', 'antigravity.settings.follow-failed', 'Antigravity 的设置这次没读出来，打开时会重新写', { reason, error: errorText(error) })
      return
    }
    if (plan.action === 'keep') return
    const assertOwner = () => {
      if ((deps.accountOwner?.() ?? null) !== owner) throw new Error('账号已变化，这次不改 Antigravity 的设置')
    }
    const resolveKey = followKey
    // 只记站点和线路，不记地址、不记密钥（I13）。
    const detail = { reason, kind: plan.action, from: plan.from, to: plan.to }
    try {
      assertOwner()
      let outcome: AntigravityEnvironmentWriteOutcome
      // Mac 上终端启动文件那一段跟打开桌面端一样不强求：设置文件照写，那一段之前已经加过（或者这次加不进），
      // 客户下次从星芒打开命令行时会再要一次。
      const write: AntigravityEnvironmentWriteOptions = { startupFileOptional: true, assertBeforeWrite: assertOwner }
      if (plan.action === 'move-route') outcome = await writeEnvironment(plan.environment, write)
      // 还没接上账号（通道还没注册、或者已经撤了）：要签密钥的这次不做，下次换账号、换线路再看。
      else if (resolveKey) outcome = (await configureNow(resolveKey, write)).outcome
      else return
      log('info', 'antigravity.settings.followed', plan.action === 'move-route' ? 'Antigravity 的设置已换到当前连接线路' : 'Antigravity 的设置已换成当前账号', { ...detail, outcome })
      deps.onFollowed?.()
    } catch (error) {
      log('warn', 'antigravity.settings.follow-failed', 'Antigravity 的设置这次没跟上，打开时会重新写', { ...detail, error: errorText(error) })
    }
  }

  // 改写那一刻记下来（writeEnvironment 里，不管是哪一步写的），开没开着到点「打开」时再看：那时开着的、起得比这早的
  // 拿不到新设置。写完才记，写的时候系统已经通知完资源管理器（antigravity-windows-environment.ts），之后它开的都带着新设置。
  // Mac 上不用记：星芒起的那一份认设置的指纹（macSpawn），别处打开的本来就带不上设置。
  function noteWindowsSettingsWritten(): void {
    if (platform === 'win32') windowsSettingsWrittenAt = (deps.now ?? Date.now)()
  }

  function windowsShell(): { explorer: string, systemRoot: string } {
    if (deps.resolveWindowsShell) return deps.resolveWindowsShell()
    const machinePaths = resolveWindowsMachinePaths()
    return { explorer: resolveWindowsExplorerExecutable({ platform, machinePaths }), systemRoot: machinePaths.systemRoot }
  }

  /** 开着的这一份各个进程什么时候起的；没开着是空数组，看不出来是 null。 */
  async function windowsDesktopProcesses(executable: string): Promise<Array<number | null> | null> {
    try {
      const powershell = deps.resolvePowerShellExecutable?.() ?? resolveWindowsPowerShellExecutable()
      const result = await execute({
        executable: powershell,
        argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeWindowsPowerShellCommand(buildAntigravityDesktopWindowsProcessScript())],
      }, { env: trustedCommandEnvironment(), trustedOnly: true, timeoutMs: probeTimeoutMs, maxOutputBytes: maximumProbeBytes, windowsHide: true })
      return parseAntigravityDesktopWindowsProcesses(result.stdout, executable)
    } catch (error) {
      log('warn', 'antigravity.desktop.process-probe-failed', '没看出 Antigravity 开没开着', { error: errorText(error) })
      return null
    }
  }

  async function macDesktopProcesses(bundle: string): Promise<number[] | null> {
    try {
      const result = await execute({ executable: '/bin/ps', argv: ['-axo', 'pid=,comm='] }, {
        env: commandEnvironment(env), trustedOnly: false, timeoutMs: probeTimeoutMs, maxOutputBytes: 4 * 1024 * 1024,
      })
      return parseAntigravityDesktopMacProcesses(result.stdout, bundle)
    } catch (error) {
      log('warn', 'antigravity.desktop.process-probe-failed', '没看出 Antigravity 开没开着', { error: errorText(error) })
      return null
    }
  }

  /** Mac 上打开前核对：谷歌团队的 Developer ID、bundle id 对得上，整个包都核（同外部客户端）。 */
  async function verifyMacDesktop(bundle: string): Promise<string> {
    try {
      await execute({
        executable: '/usr/bin/codesign',
        argv: darwinDeveloperIdVerificationArgv(antigravityDesktopMacTeamIdentifier, bundle, { deep: true, bundleIdentifier: antigravityDesktopMacBundleIdentifier }),
      }, { env: commandEnvironment(env), trustedOnly: false, timeoutMs: darwinDeepVerificationTimeoutMs, maxOutputBytes: maximumProbeBytes })
    } catch (error) {
      if (refusedByCodesign(error)) {
        log('warn', 'antigravity.desktop.signature-refused', 'Antigravity 的签名没核过，不打开', { error: errorText(error) })
        throw new Error(desktopNotOfficialMessage, { cause: error })
      }
      throw error
    }
    // 签名封住了 Info.plist，核过以后读到的主程序名才算数。
    const result = await execute({
      executable: '/usr/bin/plutil',
      argv: ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.posix.join(bundle, 'Contents', 'Info.plist')],
    }, { env: commandEnvironment(env), trustedOnly: false, timeoutMs: probeTimeoutMs, maxOutputBytes: maximumProbeBytes })
    const name = result.stdout.trim()
    const executable = path.posix.join(bundle, 'Contents', 'MacOS', name)
    if (!isPlainBundleExecutableName(name) || !isPlainFile(executable)) throw new Error(desktopNotOfficialMessage)
    return executable
  }

  async function openDesktopOnWindows(resolveKey: AntigravityKeyResolver): Promise<AntigravityDesktopLaunchResult> {
    const executable = windowsDesktopExecutable()
    if (!executable) throw new Error(desktopNotInstalledMessage)
    // 先写设置再看开没开着：写完系统通知资源管理器换上新环境，之后它开的 Antigravity 带着新设置。
    const { outcome } = await configureNow(resolveKey, writeOptionsFor('desktop'))
    const processes = await windowsDesktopProcesses(executable)
    const running = processes === null ? null : processes.length > 0
    // 开着的里头有起得比最近一次改写早的（这次刚改的，或者之前装、打开命令行、后台跟时改的）：它拿的是旧的（或没有），请客户先关掉。
    // 启动时间读不出来的也算早。主程序和它的辅助进程同名同路径，只要主程序早就算早。
    // 看不出开没开着就照常打开：开着的话第二个自己退出、把原来的叫到前面，最坏是客户看到的还是旧设置，不会开出两个。
    const writtenAt = windowsSettingsWrittenAt
    if (writtenAt !== null && processes?.some((startedAt) => startedAt === null || startedAt <= writtenAt)) {
      return { opened: false, closeFirst: true }
    }
    // yoyo 11-23「Antigravity 免核签名」：装好的 Antigravity.exe 本身没有签名（只有安装包有），打开前不核
    // 程序签名；装的时候安装包照核。交给资源管理器打开（不带星芒的权限），其余校验不动。
    const shell = windowsShell()
    await launchProcess({ executable: shell.explorer, argv: [executable], cwd: shell.systemRoot, env: commandEnvironment(env), windowsHide: true })
    if (processes !== null) windowsSettingsWrittenAt = null
    log('info', 'antigravity.desktop.opened', '已打开 Antigravity', { running, outcome })
    return { opened: true }
  }

  async function openDesktopOnMac(resolveKey: AntigravityKeyResolver): Promise<AntigravityDesktopLaunchResult> {
    const bundle = macDesktopBundle()
    if (!bundle) throw new Error(desktopNotInstalledMessage)
    const executable = await verifyMacDesktop(bundle)
    const { environment } = await configureNow(resolveKey, writeOptionsFor('desktop'))
    const fingerprint = antigravityEnvironmentFingerprint(environment)
    const running = await macDesktopProcesses(bundle)
    if (running?.length) {
      // 开着的就是星芒带着同一份设置起的那一个：只把它叫到前面。别的（客户自己从程序坞开的、设置后来变了的）
      // 拿不到这次的设置，请客户先关掉。
      const ours = macSpawn !== null && macSpawn.bundle === bundle && macSpawn.fingerprint === fingerprint && running.includes(macSpawn.pid)
      if (!ours) return { opened: false, closeFirst: true }
      await execute({ executable: '/usr/bin/open', argv: ['-a', bundle] }, {
        env: commandEnvironment(env), trustedOnly: false, timeoutMs: probeTimeoutMs, maxOutputBytes: maximumProbeBytes,
      })
      log('info', 'antigravity.desktop.focused', 'Antigravity 已经开着，叫到了前面')
      return { opened: true }
    }
    // 直接起主程序，设置放在环境里交给它（密钥不进命令行参数）。从程序坞、访达打开的读不到这份设置，
    // 只有星芒打开的这一种带得上，所以上面认得出自己起的那一个。
    const pid = await launchProcess({
      executable,
      argv: [],
      cwd: userHome,
      env: withAntigravityEnvironment(commandEnvironment(env), environment),
      windowsHide: false,
    })
    macSpawn = pid === null ? null : { bundle, pid, fingerprint }
    log('info', 'antigravity.desktop.opened', '已打开 Antigravity')
    return { opened: true }
  }

  /**
   * 排进安装队列；accountWork 是点的时候那个账号（#1085 的 scoped-queued）：排着队时换了账号就出队，
   * 轮到它时账号换过就一行都不跑，免得拿新账号的密钥替上一个账号打开。
   */
  function enqueueForAccount<T>(key: string, task: () => Promise<T>, accountWork?: QueuedAccountWork): Promise<T> {
    if (!accountWork) return deps.enqueue(key, task)
    return deps.enqueue(key, () => accountWork.run(task), { signal: accountWork.signal })
  }

  /** 带着设置打开桌面端。和装、卸载排同一队（I11）：装到一半时不会从换了一半的位置起。 */
  function openDesktop(resolveKey: AntigravityKeyResolver, accountWork?: QueuedAccountWork): Promise<AntigravityDesktopLaunchResult> {
    try {
      assertSupported()
      assertSameUser()
    } catch (error) {
      return Promise.reject(error)
    }
    return enqueueForAccount(antigravityDesktopLaunchQueueKey, () => platform === 'win32' ? openDesktopOnWindows(resolveKey) : openDesktopOnMac(resolveKey), accountWork)
  }

  async function openCliNow(workspace: string, resolveKey: AntigravityKeyResolver): Promise<void> {
    const target = cliTarget()
    if (!target || !cliInstalled()) throw new Error(cliNotInstalledMessage)
    if (platform === 'win32') {
      try {
        await (deps.verifyWindowsCli ?? ((filePath: string) => verifyOfficialNativeCliFile('antigravity', filePath)))(target.executablePath)
      } catch (error) {
        log('warn', 'antigravity.cli.signature-refused', 'Antigravity 命令行的签名没核过，不打开', { error: errorText(error) })
        throw new Error(cliNotOfficialMessage, { cause: error })
      }
      const { environment } = await configureNow(resolveKey, writeOptionsFor('cli'))
      // 星芒自己的环境是它启动那一刻从资源管理器继承的，刚写下（或刚换过）的用户环境变量这次运行看不到，
      // 所以这次的设置直接交给终端，同名的旧值整组换掉（antigravity-windows-environment.ts 开头）。
      await (deps.launchWindowsTerminal ?? launchCliPowerShell)({
        executable: target.executablePath,
        argv: [],
        workspace,
        title: 'Antigravity 命令行 · 星芒AI',
        env: withAntigravityEnvironment(deps.terminalEnvironment(env), environment),
      })
      log('info', 'antigravity.cli.opened', '已打开 Antigravity 命令行')
      return
    }
    const cpu = architecture === 'arm64' ? 'arm64' : 'x64'
    try {
      await (deps.verifyMacosCli ?? verifyDarwinAntigravityCli)(target.executablePath, cpu, (plan) => execute(
        { executable: plan.executable, argv: plan.argv },
        { env: commandEnvironment(env), trustedOnly: false, timeoutMs: plan.timeoutMs, maxOutputBytes: maximumProbeBytes },
      ))
    } catch (error) {
      log('warn', 'antigravity.cli.signature-refused', 'Antigravity 命令行的签名没核过，不打开', { error: errorText(error) })
      throw new Error(cliNotOfficialMessage, { cause: error })
    }
    await configureNow(resolveKey, writeOptionsFor('cli'))
    // 「终端」先起客户的登录 shell，读启动文件里星芒加的那一段，设置就在环境里了；启动脚本里不另写密钥。
    await (deps.launchMacosTerminal ?? launchMacosTerminal)({ executable: target.executablePath, argv: [], workspace, env: deps.terminalEnvironment(env) })
    log('info', 'antigravity.cli.opened', '已打开 Antigravity 命令行')
  }

  /** 在客户选的文件夹里开一个终端跑 agy。和别的命令行工具一样排进安装队列，前缀 cli:launch:（I11）。 */
  function openCli(workspace: string, resolveKey: AntigravityKeyResolver, accountWork?: QueuedAccountWork): Promise<void> {
    try {
      assertSupported()
      assertSameUser()
      if (deps.assertWorkspace) deps.assertWorkspace(workspace)
      else assertWorkspaceDirectory(workspace, platform, '项目文件夹不存在，请重新选择')
    } catch (error) {
      return Promise.reject(error)
    }
    return enqueueForAccount(antigravityCliLaunchQueueKey(workspace, platform), () => openCliNow(workspace, resolveKey), accountWork)
  }

  return { inspect, install, configure, openDesktop, openCli, bindFollowKey, follow }
}

export type AntigravityService = ReturnType<typeof createAntigravityService>
