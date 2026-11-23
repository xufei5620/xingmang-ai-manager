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
   * 写下的四个设置都在，地址是当前账号此刻这条线路的 Gemini 地址。只看本机，不问服务端：密钥还能不能用、
   * 型号菜单是不是最新，每次打开时都会重新签、重新写一遍。
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

export class AntigravityElevatedSessionError extends Error {
  constructor() {
    super('星芒正以管理员身份运行，不能替你设置和打开 Antigravity。请用普通方式重新打开星芒。')
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
}

/** Antigravity 桌面端在 Mac 上的身份：谷歌的 Developer ID 团队和 bundle id（11-23 两种芯片实测）。 */
export const antigravityDesktopMacTeamIdentifier = 'EQHXZ8M8AV'
export const antigravityDesktopMacBundleIdentifier = 'com.google.antigravity'

const desktopNotInstalledMessage = '未检测到 Antigravity，请先安装'
const cliNotInstalledMessage = '未检测到 Antigravity 命令行，请先安装'
const unsupportedMessage = '这台电脑的系统或芯片不支持 Antigravity'
const desktopNotOfficialMessage = '装着的 Antigravity 不是谷歌官方签名的原版，星芒不替你打开它'
const cliNotOfficialMessage = '装着的 Antigravity 命令行不是谷歌官方签名的原版，星芒不替你打开它'
const probeTimeoutMs = 15_000
const maximumProbeBytes = 256 * 1024

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
 * 接口是 genai。地址收不成 Antigravity 要的样子（站点表里没有它）也算不是。只比地址和接口，不比密钥和菜单。
 */
export function isAntigravityEnvironmentCurrent(values: AntigravityEnvironmentValues, gatewayBaseUrl: string): boolean {
  for (const name of antigravityGatewayVariableNames) {
    if (!values[name]?.trim()) return false
  }
  let expected: string
  try {
    expected = normalizeAntigravityGatewayUrl(gatewayBaseUrl)
  } catch {
    return false
  }
  return values.AGY_LLM_GATEWAY_URL === expected && values.AGY_LLM_GATEWAY_WIRE_PROTOCOL === 'genai'
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
 * Windows 上开着的 Antigravity.exe 各在哪里：只列路径，交给调用方比。开着应用控制策略的电脑上 PowerShell 跑在
 * 受限语言模式里：设 UTF-8 那句只在完整模式下做，路径里的中文（用户名）在受限模式下转成 \uXXXX 再输出，
 * 主进程读回来是同一个路径（powershell-constrained-language.ts）。模块按名字先导入：收窄过的环境里自动加载
 * 一次要十几秒，比打开前这一问的时限还长。
 */
export function buildAntigravityDesktopWindowsProcessScript(): string {
  return [
    powerShellUtf8OutputStatement,
    buildPowerShellModuleImportStatement(['Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management']),
    "$ErrorActionPreference = 'Stop'",
    '$paths = @(Get-Process -Name Antigravity -ErrorAction SilentlyContinue | ForEach-Object { try { [string]$_.Path } catch {} } | Where-Object { $_ })',
    ...buildPowerShellJsonOutputStatements('ConvertTo-Json -InputObject @($paths) -Compress'),
  ].join('\n')
}

/** 上面那段脚本的输出里有没有这一份；读不懂的一律当作没开着之外的「看不出来」，交 null。 */
export function parseAntigravityDesktopWindowsProcesses(stdout: string, executablePath: string): boolean | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim() || '[]')
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const expected = path.win32.normalize(executablePath).toLowerCase()
  return parsed.some((entry) => typeof entry === 'string' && path.win32.normalize(entry).toLowerCase() === expected)
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

  async function inspect(): Promise<AntigravityStatus> {
    if (!isAntigravitySupported(platform, architecture)) {
      return { supported: false, cliInstalled: false, desktopInstalled: false, configured: false }
    }
    let configured = false
    try {
      configured = isAntigravityEnvironmentCurrent(await readEnvironment(), deps.gatewayBaseUrl())
    } catch (error) {
      // 读不出来只当没写过：打开时会重新写一遍，不为一次读失败挡住检测。
      log('warn', 'antigravity.settings.read-failed', '没读出 Antigravity 的设置', { error: errorText(error) })
    }
    return { supported: true, cliInstalled: cliInstalled(), desktopInstalled: desktopInstalled(), configured }
  }

  /** 签一把密钥、按当时的型号算出设置、写下去。地址只读一次，整次只用这一个（线路「自动」时可能半路换）。 */
  async function configureNow(resolveKey: AntigravityKeyResolver): Promise<{ environment: AntigravityGatewayEnvironment, outcome: AntigravityEnvironmentWriteOutcome }> {
    const baseUrl = deps.gatewayBaseUrl()
    const key = await resolveKey()
    const environment = buildAntigravityGatewayEnvironment({ baseUrl, apiKey: key.key, models: key.models })
    const outcome = await deps.serializeSettingsWrite(async (): Promise<AntigravityEnvironmentWriteOutcome> => {
      if (platform === 'win32') return (deps.writeWindowsEnvironment ?? writeWindowsAntigravityEnvironment)(environment, { platform })
      const result = await (deps.writeMacosEnvironment ?? writeMacosAntigravityEnvironment)(environment, {
        platform,
        homeDirectory: userHome,
        env,
        skipped: (displayPath, error) => log('warn', 'antigravity.settings.fish-skipped', '没写进 fish 的启动设置', { file: displayPath, error: errorText(error) }),
      })
      if (result.profile === 'unsupported-shell') {
        log('warn', 'antigravity.settings.unsupported-shell', '登录 shell 不是 zsh、bash、fish，自己开的终端里读不到 Antigravity 的设置')
      }
      return result.outcome
    })
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
    if (platform === 'win32') {
      const installed = await (deps.installDesktopWindows ?? installAntigravityDesktopWindows)({
        executionMode: deps.executionMode,
        platform,
        architecture,
        env,
        homeDirectory: userHome,
        fetchImpl: deps.fetch,
        onProgress: (progress) => onProgress?.({ target: 'desktop', phase: progress.phase, percent: progress.percent }),
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
      await configureNow(resolveKey)
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

  function windowsShell(): { explorer: string, systemRoot: string } {
    if (deps.resolveWindowsShell) return deps.resolveWindowsShell()
    const machinePaths = resolveWindowsMachinePaths()
    return { explorer: resolveWindowsExplorerExecutable({ platform, machinePaths }), systemRoot: machinePaths.systemRoot }
  }

  async function windowsDesktopRunning(executable: string): Promise<boolean | null> {
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
    const { outcome } = await configureNow(resolveKey)
    const running = await windowsDesktopRunning(executable)
    // 开着、设置这次又改了：开着的那一份拿的是旧的（或没有），请客户先关掉。看不出开没开着就照常打开：
    // 开着的话第二个自己退出、把原来的叫到前面，最坏是客户看到的还是旧设置，不会开出两个。
    if (running === true && outcome === 'written') return { opened: false, closeFirst: true }
    // yoyo 11-23「Antigravity 免核签名」：装好的 Antigravity.exe 本身没有签名（只有安装包有），打开前不核
    // 程序签名；装的时候安装包照核。交给资源管理器打开（不带星芒的权限），其余校验不动。
    const shell = windowsShell()
    await launchProcess({ executable: shell.explorer, argv: [executable], cwd: shell.systemRoot, env: commandEnvironment(env), windowsHide: true })
    log('info', 'antigravity.desktop.opened', '已打开 Antigravity', { running, outcome })
    return { opened: true }
  }

  async function openDesktopOnMac(resolveKey: AntigravityKeyResolver): Promise<AntigravityDesktopLaunchResult> {
    const bundle = macDesktopBundle()
    if (!bundle) throw new Error(desktopNotInstalledMessage)
    const executable = await verifyMacDesktop(bundle)
    const { environment } = await configureNow(resolveKey)
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
      const { environment } = await configureNow(resolveKey)
      // 星芒自己的环境没跟着用户环境变量改（改了，之后起的每个子进程都会带上这把密钥），所以这次的设置直接交给终端。
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
    await configureNow(resolveKey)
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

  return { inspect, install, configure, openDesktop, openCli }
}

export type AntigravityService = ReturnType<typeof createAntigravityService>
