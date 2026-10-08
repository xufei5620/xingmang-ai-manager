import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildClaudeDesktopInstallFailureMessage, classifyClaudeDesktopInstallFailure, isPlainClaudeDesktopInstallMessage,
} from './claude-desktop-install-failure'
import { describeClaudeDesktopMsixDownload, installClaudeDesktopFromOfficial } from './claude-desktop-msix-installer'
import {
  cleanCommandOutput, CommandRunnerError, runCommand, trustedCommandEnvironment,
  type CommandErrorCode, type CommandSpec, type RunCommandOptions,
} from './command-runner'
import { externalClientOfficialDownloadUrls, isExternalToolId, type ExternalClientInstallProgress, type ExternalClientRuntimeStatus } from './external-client-contract'
import type { ExternalToolId } from './external-tool-config'
import {
  InstallCancellationRegistry, InstallCancelledError, isInstallCancelledError,
  type InstallCancellationHandle, type InstallCancellationOutcome,
} from './install-cancellation'
import { InstallationQueue } from './installation-queue'
import { darwinDeveloperIdVerificationArgv } from './macos-code-signing'
import { installMacosDesktopApp, macosDesktopAppInstallable } from './macos-desktop-app-installer'
import { resolveSystemWingetExecutable, type SystemWingetResolution } from './node-runtime'
import { sameLocalPathIdentity } from './path-identity'
import { assertNoReparseComponents } from './safe-local-data'
import { resolveWindowsExplorerExecutable } from './system-shell'
import { buildPowerShellModuleImportStatement } from './powershell-module-imports'
import { encodeWindowsPowerShellCommand, resolveWindowsPowerShellExecutable, type WindowsCliExecutionMode } from './windows-elevation'
import { pathWithinWindowsRoot, resolveWindowsMachinePaths, type WindowsMachinePaths } from './windows-machine-paths'
import { installWorkBuddyFromOfficial } from './workbuddy-installer'

const tools: readonly ExternalToolId[] = ['workbuddy', 'claudeDesktop', 'opencode']
const definitions = {
  workbuddy: { name: 'WorkBuddy', winget: 'Tencent.WorkBuddy', executable: 'WorkBuddy.exe', bundle: 'WorkBuddy.app', bundleId: 'com.tencent.workbuddy.mac' },
  claudeDesktop: { name: 'Claude Desktop', winget: 'Anthropic.Claude', executable: 'Claude.exe', bundle: 'Claude.app', bundleId: 'com.anthropic.claudefordesktop' },
  opencode: { name: 'OpenCode', winget: 'SST.OpenCodeDesktop', executable: 'OpenCode.exe', bundle: 'OpenCode.app', bundleId: 'ai.opencode.desktop' },
} as const
const claudeFamily = 'Claude_pzs8sxrjxfjjc'
const claudeApplicationId = `${claudeFamily}!Claude`
const maximumProbeBytes = 256 * 1024
// 找不到可信的系统 winget 时，原因是 ENOENT、包身份校验失败之类的内部细节，客户看不懂
// 也做不了什么；首页行里只说装不了、怎么办，原因写进运行日志给客服查。
export const externalClientWingetUnavailableHint = '这台电脑缺少系统自带的应用安装组件，不能一键安装；点「去官网下载」装好后回来重新检测'
// Windows 上签名不对、Mac 上苹果的签名核对没过，首页那一行说的都是这一句。
const signatureMismatchMessage = '客户端数字签名无效或签名发布者与官方发布者不一致'
// winget 自己的软件源坏了：源数据没有（多半是之前那次更新源没下下来），或者下下来的
// 源数据对不上。两种都出在打开源的时候，那时连客户端的清单都还没读到，安装程序一步没动。
const wingetSourceDataFailures = [0x8a15000f, 0x8a15003f]
// 检测脚本最多交回几条读不出来的安装记录（只进运行日志）。
const maximumRegistryFailures = 10
// 老电脑上这一轮 PowerShell 盘点（注册表、进程、AppX、签名）要好几秒，而装没装
// 客户端这件事几分钟内几乎不会变；装、卸、打开之后会主动作废。
const defaultScanCacheTtlMs = 5 * 60_000
const maximumKnownSignatures = 32
// How long a display-only macOS scan may reuse a verified bundle (as in
// macos-codex-app.ts). The fingerprint covers the bundle directory, Info.plist
// and the main executable only; edits deeper inside need not touch their
// timestamps, so the reuse is capped rather than trusted indefinitely.
const macVerificationTtlMs = 5 * 60_000
const publisherPatterns: Record<ExternalToolId, RegExp> = {
  workbuddy: /(?:^|,\s*)(?:CN|O)="?Tencent Technology \(Shenzhen\) Company Limited"?(?:,|$)/i,
  claudeDesktop: /(?:^|,\s*)(?:CN|O)="Anthropic, PBC"(?:,|$)/i,
  opencode: /(?:^|,\s*)(?:CN|O)="Anomaly Innovations, Inc https:\/\/anoma\.ly\/"(?:,|$)/i,
}

interface LocatedClient {
  tool: ExternalToolId
  path: string
  version: string | null
  running: boolean
  applicationId?: string
}
interface Inspection { clients: LocatedClient[]; errors: Partial<Record<ExternalToolId, string>>; timings?: ExternalClientInventoryTimings }
interface InspectionScope {
  /** 只给展示用的检测：可以认之前验过、文件没变的签名（Mac 上只认几分钟内的）。装、打开从不传。 */
  reuseSignatures?: boolean
  /**
   * Windows 上打开之前那次检测（已知68）：只认之前验过并且通过、文件和版本都没变的签名，
   * 没验过的、上次没通过的照旧现验。装从不传；Mac 上不看它，打开照旧现验。
   */
  reuseVerifiedSignatures?: boolean
  /** 只看这一个客户端（打开它之前）：没点的那几家跟这次打开无关，不该让人多等。 */
  only?: ExternalToolId
}
/** 判断应用包变没变要看的那几项；fs.Stats 本身就满足。 */
interface BundleEntryStats { dev: number; ino: number; mtimeMs: number; size: number; isFile(): boolean }
interface LaunchPlan extends CommandSpec { cwd?: string; env: NodeJS.ProcessEnv; windowsHide: boolean }

export interface ExternalClientRuntimeOptions {
  installationQueue?: InstallationQueue
  platform?: NodeJS.Platform
  architecture?: NodeJS.Architecture
  userHome?: string
  env?: NodeJS.ProcessEnv
  windowsExecutionMode?: WindowsCliExecutionMode
  runCommand?: typeof runCommand
  resolveWingetExecutable?: () => Promise<SystemWingetResolution>
  resolveMachinePaths?: () => WindowsMachinePaths
  resolveExplorerExecutable?: () => string
  resolvePowerShellExecutable?: () => string
  /** Test seams keep installation and launch tests entirely outside the host machine. */
  verifyPath?: (candidate: string, kind: 'file' | 'directory' | 'appx-file') => Promise<string>
  /** 读应用包指纹用的 lstat；测试不碰本机文件。 */
  lstatPath?: (candidate: string) => Promise<BundleEntryStats>
  launchProcess?: (plan: LaunchPlan) => Promise<void>
  installWorkBuddyFromOfficial?: typeof installWorkBuddyFromOfficial
  installClaudeDesktopFromOfficial?: typeof installClaudeDesktopFromOfficial
  /** 星芒自己下官方安装包时用的 fetch（Mac 上各家、Windows 上的 Claude Desktop）；system-service 传接好系统代理的那个。 */
  fetch?: typeof fetch
  /** 把星芒自己下官方安装包的那次下载包进临时加速线路（同命令行工具的安装）；缺省直接下。 */
  withDownloadRoute?: <T>(operation: () => Promise<T>) => Promise<T>
  /** 下载之前先看一眼盘，不够时抛出那句「磁盘空间不足」。 */
  assertDiskSpace?: (subject: string) => Promise<void>
  installMacosDesktopApp?: typeof installMacosDesktopApp
  getuid?: () => number
  /** 同一份盘点结果复用多久；缺省 5 分钟。测试用假时钟时一并注入 now。 */
  scanCacheTtlMs?: number
  now?: () => number
  /** 系统 winget 用不了的原因只进运行日志，不上屏。 */
  onWingetUnavailable?: (reason: string) => void
  /** Windows 上哪几条安装记录读不出来、为什么，只进运行日志；内容和上一次一样就不再调。 */
  onRegistryIncomplete?: (failures: ExternalClientRegistryFailure[]) => void
  /** Mac 上苹果的签名核对没过时它自己说的原因，只进运行日志；同一个应用包原因没变就不再调。 */
  onMacVerificationFailed?: (failure: ExternalClientMacVerificationFailure) => void
  /**
   * Windows 上 AppX 注册信息、数字签名读不出时 PowerShell 给的原话（多是系统英文），只进运行日志：
   * 首页那一行只说前半句中文（已知3）。同一个客户端内容没变就不再调。
   */
  onDetectionErrorDetail?: (failure: ExternalClientDetectionErrorDetail) => void
  /**
   * 每次打开成了，各段花了多久（排队、打开前那次检测和它里面的各段、交出去），只进运行日志：
   * 客户说「打开还是慢」时，分得清是慢在星芒这边哪一段，还是客户端自己启动慢。没打开成的不调，
   * 那一次一共多久照旧记在「外部客户端启动」那一行。
   */
  onLaunchTiming?: (timing: ExternalClientLaunchTiming) => void
}

/** 检测脚本读不出来的一条安装记录：记录名（或整处卸载信息的位置）和 PowerShell 给的原因。 */
export interface ExternalClientRegistryFailure {
  // 不叫 key：运行日志把名字正好是 key 的字段当凭据打码（runtime-log.ts 的 SENSITIVE_KEY），
  // 叫了它，客服在日志里就只看得到 [REDACTED]。
  entry: string
  reason: string
}

/** 检测失败时首页那句中文（reason），和 PowerShell 给的原话（message）。 */
export interface ExternalClientDetectionErrorDetail {
  tool: ExternalToolId
  reason: string
  message: string
}

/** Windows 检测脚本里各段花的毫秒数，和这一次现核、照用了几个签名。 */
export interface ExternalClientInventoryTimings {
  /** PowerShell 从起来到退出一共多久；减去下面各段（signatureMs 已算在 clientsMs 里），剩下的多半是它自己启动花的。 */
  powershellMs?: number
  /** 导入要用的几个 PowerShell 模块，再读入记住的签名结果（Windows PowerShell 头一回解析 JSON 也要加载组件）。 */
  importMs?: number
  /** 读三处卸载信息。 */
  registryMs?: number
  /** 看哪些客户端在运行。 */
  processMs?: number
  /** 查 Claude Desktop 的 AppX 注册信息；只看 WorkBuddy、OpenCode 时不查，也就没有这一项。 */
  appxMs?: number
  /** 逐家核对安装位置和签名，含下面的 signatureMs。 */
  clientsMs?: number
  signatureMs?: number
  signaturesChecked?: number
  signaturesReused?: number
}

/** 点「打开」到交给资源管理器（Mac 上是 open）为止，各段花的毫秒数。 */
export interface ExternalClientLaunchTiming extends ExternalClientInventoryTimings {
  tool: ExternalToolId
  /** 排在别的安装、卸载、打开后面等了多久。 */
  queueWaitMs: number
  /** 打开前那次检测一共多久：Windows 上是 powershellMs 加上星芒自己再核一遍路径。 */
  inventoryMs: number
  /** 交给资源管理器（Mac 上是 open）用了多久。 */
  launchMs: number
}

/** spctl 或 codesign 没放行时的那几项；output 是它们写在标准错误里的原话。 */
export interface ExternalClientMacVerificationFailure {
  tool: ExternalToolId
  /** 被核对的那个应用包（「应用程序」和主目录下的「应用程序」里可能各有一个）。 */
  path: string
  command: string
  code: CommandErrorCode
  exitCode: number | null
  output: string
}

export interface ExternalClientScanOptions {
  /** 用户亲手点「重新检测」：不用缓存里那份，但仍与正在跑的那次合并。 */
  force?: boolean
  /**
   * 要一轮这次调用之后才开始的盘点（换线路动客户端配置之前看它开没开）：正在跑的那次可能是在
   * 客户端打开之前起的，等它跑完，再并进那之后起的一轮或者另起一轮。不用缓存。
   */
  fresh?: boolean
}

/** A signature verdict the inventory script may reuse while the file stamp and registered version are unchanged. */
export interface KnownExternalClientSignature {
  path: string
  stamp: string
  status: string
  subject: string
  /** 验签那次卸载信息里登记的版本（DisplayVersion，没有就是空串）；对不上就现验。 */
  version: string
}

function errorText(error: unknown): string {
  return cleanCommandOutput(error instanceof Error ? error.message : String(error)).slice(0, 1500)
}

function officialDownloadUrl(tool: ExternalToolId): string | null {
  const urls: Partial<Record<ExternalToolId, string>> = externalClientOfficialDownloadUrls
  return urls[tool] ?? null
}

/**
 * 这台电脑没有可信的系统 winget 时各家的出路。WorkBuddy 换腾讯官方安装包，首页灰字
 * 交代一句；Claude Desktop 换 Claude 官网的离线安装包，和有 winget 时一样只给「安装」；
 * 其余没有星芒核对过的官方安装包，只能去官网自己下载。
 */
function windowsWithoutWinget(tool: ExternalToolId): { hint: string | null; official: boolean } {
  if (tool === 'workbuddy') return { hint: '将使用腾讯官方安装包', official: true }
  if (tool === 'claudeDesktop') return { hint: null, official: true }
  return { hint: externalClientWingetUnavailableHint, official: false }
}

function wingetNetworkFailure(error: unknown): boolean {
  if (!(error instanceof CommandRunnerError) || error.code !== 'EXIT_NON_ZERO' || error.exitCode === null || error.signal) return false
  // WinINet timeout, name resolution, connection and connection-reset failures.
  return [0x80072ee2, 0x80072ee7, 0x80072efd, 0x80072efe, 0x80072eff].includes(error.exitCode >>> 0)
}

/** 连不上微软的软件下载源，或者连上了但 winget 自己的软件源坏了：这两种都还没开始装。 */
function wingetSourceUnavailable(error: unknown): boolean {
  if (wingetNetworkFailure(error)) return true
  return error instanceof CommandRunnerError && error.code === 'EXIT_NON_ZERO' && error.exitCode !== null && !error.signal
    && wingetSourceDataFailures.includes(error.exitCode >>> 0)
}

function wingetCancelled(error: unknown): boolean {
  return error instanceof CommandRunnerError
    && (error.code === 'ABORTED' || error.exitCode !== null && [1223, 0x800704c7].includes(error.exitCode >>> 0))
}

function wingetFailureMessage(error: unknown): string {
  if (!(error instanceof CommandRunnerError)) return errorText(error)
  const exitCode = error.exitCode === null ? '' : `（错误码 0x${(error.exitCode >>> 0).toString(16)}）`
  if (wingetNetworkFailure(error)) return `连不上微软的软件下载源${exitCode}，请检查网络连接后重试。`
  if (wingetCancelled(error)) return '安装已取消。'
  if (error.code === 'TIMED_OUT') return '安装超时，请重新检测客户端状态后再尝试安装。'
  return `安装没有完成${exitCode}，请查看运行日志中的安装器输出。`
}

function installationError(message: string, originalError: unknown): Error {
  return Object.assign(new Error(message), { originalError })
}
function installKey(tool: ExternalToolId): string {
  return `external-client:install:${tool}`
}
/** Windows 上交给系统去装的那一步不接受取消时，按「取消」弹出的那句话。 */
function installSealReason(tool: ExternalToolId): string {
  return `正在安装 ${definitions[tool].name}，这一步中断会留下装了一半的程序，请等它结束。`
}
function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && value.length < 32_768 && !/[\x00-\x1f]/.test(value) ? value.trim() : null
}
function versionValue(value: unknown): string | null {
  const result = textValue(value)
  return result && /^[0-9][0-9A-Za-z.+_-]{0,100}$/.test(result) ? result : null
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('客户端检测结果格式无效')
  return value as Record<string, unknown>
}
function localWindowsPath(value: string): boolean {
  return /^[a-z]:\\/i.test(value) && !/[<>"|?*\x00-\x1f]/.test(value) && !value.slice(2).includes(':')
}
function scriptLogText(value: unknown, limit: number): string {
  return typeof value === 'string' ? cleanCommandOutput(value).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, limit) : ''
}
/** 检测脚本交回的读不出来的安装记录。格式不对就当没有：少的只是一行日志，检测结论照旧。 */
function registryFailures(value: unknown): ExternalClientRegistryFailure[] {
  if (!Array.isArray(value)) return []
  try {
    return value.slice(0, maximumRegistryFailures).map((raw) => {
      const item = record(raw)
      return { entry: scriptLogText(item.entry, 260), reason: scriptLogText(item.reason, 500) }
    })
  } catch { return [] }
}
/** 检测脚本交回的 PowerShell 原话，按客户端。格式不对同样当没有。 */
function scriptErrorDetails(value: unknown): Partial<Record<ExternalToolId, string>> {
  const details: Partial<Record<ExternalToolId, string>> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return details
  for (const tool of tools) {
    const message = scriptLogText((value as Record<string, unknown>)[tool], 500)
    if (message) details[tool] = message
  }
  return details
}
const scriptTimingKeys = ['importMs', 'registryMs', 'processMs', 'appxMs', 'clientsMs', 'signatureMs', 'signaturesChecked', 'signaturesReused'] as const
/** 检测脚本报的各段用时，只进运行日志：只留认识的那几项里的非负整数，格式不对同样当没有。 */
function scriptTimings(value: unknown): ExternalClientInventoryTimings {
  const timings: ExternalClientInventoryTimings = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return timings
  for (const key of scriptTimingKeys) {
    const entry = (value as Record<string, unknown>)[key]
    if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) timings[key] = entry
  }
  return timings
}
/** spctl 退出码 3 是 Gatekeeper 拒绝；codesign 1 是核对没过，3 是签名完好但不满足钉住的要求（团队、包名）。 */
function macSignatureRefused(error: unknown): boolean {
  if (!(error instanceof CommandRunnerError) || error.code !== 'EXIT_NON_ZERO' || error.signal) return false
  const command = path.posix.basename(error.executable)
  return command === 'spctl' ? error.exitCode === 3 : command === 'codesign' && (error.exitCode === 1 || error.exitCode === 3)
}
function describeMacVerificationFailure(tool: ExternalToolId, bundle: string, error: unknown): ExternalClientMacVerificationFailure | null {
  if (!(error instanceof CommandRunnerError)) return null
  return {
    tool, path: bundle, command: path.posix.basename(error.executable), code: error.code, exitCode: error.exitCode,
    output: cleanCommandOutput(error.stderr || error.stdout).trim().slice(0, 500),
  }
}

export async function verifyExternalClientPath(candidate: string, kind: 'file' | 'directory' | 'appx-file'): Promise<string> {
  if (kind === 'appx-file') {
    // WindowsApps itself denies native realpath to normal users, while the
    // registered package and its executable remain accessible. Compare the
    // complete path identity (including lstat of each component), rather than
    // requiring a native realpath handle on every parent directory.
    if (!sameLocalPathIdentity(candidate, candidate)) throw new Error('客户端 AppX 路径身份无法验证')
  } else assertNoReparseComponents(candidate, '客户端安装路径')
  const stats = await fs.promises.lstat(candidate)
  if (stats.isSymbolicLink() || (kind === 'directory' ? !stats.isDirectory() : !stats.isFile() || (kind !== 'appx-file' && stats.nlink !== 1))) {
    throw new Error('客户端安装路径不是普通文件或目录')
  }
  return fs.promises.realpath(candidate)
}

// Read registry metadata and current-user AppX registration only. Never execute a
// discovered application's --version, uninstall string, or registry command line.
//
// `knownSignatures` lets a scan skip Get-AuthenticodeSignature for an executable
// whose size, timestamps and registered version are unchanged since it was last
// verified. The list is passed as base64 JSON so no path, subject or version text
// ever becomes PowerShell source. A same-user attacker can forge those timestamps,
// so install never passes this list: what it installs is verified anew.
//
// Launch passes only the entries that verified as Valid. This is a deliberate
// relaxation (已知68, approved in writing by yoyo on 2026-10-06): every 「打开」
// used to wait several seconds for a full signature check. It stays narrow: the
// launch goes through Explorer, which starts the client as the signed-in user,
// so a forged stamp runs nothing that user could not already run; the registry
// and path checks still run on every launch, and the remembered subject must
// still name the official publisher.
//
// The script runs under trustedCommandEnvironment(), where one cmdlet left to
// autoloading costs the whole System32 module scan (20 s and more on the CI
// runner, see buildPowerShellModuleImportStatement) against a 15 s limit, so it
// imports every module it calls before the first call.
export const windowsExternalClientInventoryModules = [
  'Microsoft.PowerShell.Utility',
  'Appx',
  'Microsoft.PowerShell.Management',
  'Microsoft.PowerShell.Security',
] as const

export const externalClientSystemCommandTimeoutMs = 15_000

/**
 * 只看进程的那一小段（xm 三线路 C11）：客户端开着、换线路要等它退出时，每 5 分钟问一次「还开着吗」。
 * 整轮盘点要读注册表、核签名，老电脑上好几秒；这里只列一个进程名的路径。进程名是写死的常量，
 * 比路径在 JS 里做，没有任何外来文字进 PowerShell 源码。
 */
export function windowsExternalClientProcessScript(tool: ExternalToolId): string {
  const name = definitions[tool].executable.replace(/\.exe$/i, '')
  return String.raw`
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
${buildPowerShellModuleImportStatement(['Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management'])}
$ErrorActionPreference = 'Stop'
$paths = @(Get-Process -Name ${name} -ErrorAction SilentlyContinue | ForEach-Object { try { [string]$_.Path } catch {} } | Where-Object { $_ })
ConvertTo-Json -InputObject @($paths) -Compress
`
}

/** 打开 WorkBuddy、OpenCode 之前只看它自己，用不着 Appx：导入它、查 AppX 注册信息都要花时间。 */
export function windowsExternalClientInventoryModulesFor(only?: ExternalToolId): readonly string[] {
  return only === undefined || only === 'claudeDesktop' ? windowsExternalClientInventoryModules
    : windowsExternalClientInventoryModules.filter((name) => name !== 'Appx')
}

// Claude Desktop's MSIX install, registered for the current user only.
const windowsClaudeAppxInventory = String.raw`
try {
  foreach ($package in @(Get-AppxPackage -Name Claude)) {
    if ($package.PackageFamilyName -ceq 'Claude_pzs8sxrjxfjjc') {
      $exe = Join-Path $package.InstallLocation 'app\Claude.exe'
      $clients.Add([pscustomobject]@{ tool='claudeDesktop'; path=$exe; version=[string]$package.Version; running=($processes -contains $exe); family=[string]$package.PackageFamilyName; publisher=[string]$package.Publisher; installLocation=[string]$package.InstallLocation; applicationId='Claude_pzs8sxrjxfjjc!Claude' })
    }
  }
} catch { $errors.claudeDesktop = '无法读取当前用户 Claude 桌面端的 AppX 注册信息'; $errorDetails.claudeDesktop = [string]$_.Exception.Message }
$timings['appxMs'] = [int]$clock.ElapsedMilliseconds; $clock.Restart()
`.trim()

/**
 * `only` is the client about to be opened: the script then reads every uninstall
 * key as before (that is how it finds the client and its registered version) but
 * locates, stamps and verifies that client alone, and queries AppX only for Claude
 * Desktop. Every check on the client being opened is unchanged.
 *
 * `timings` reports, per section, the milliseconds the script spent, for the
 * runtime log alone (see onLaunchTiming).
 */
export function windowsExternalClientInventoryScript(knownSignatures: readonly KnownExternalClientSignature[] = [], only?: ExternalToolId): string {
  if (only !== undefined && !isExternalToolId(only)) throw new Error('未知客户端')
  const known = Buffer.from(JSON.stringify(knownSignatures.map(({ path: file, stamp, status, subject, version }) => ({ path: file, stamp, status, subject, version }))), 'utf8').toString('base64')
  return String.raw`
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
${buildPowerShellModuleImportStatement(windowsExternalClientInventoryModulesFor(only))}
$ErrorActionPreference = 'Stop'
$knownSignatures = @{}
# Windows PowerShell 5.1 emits a JSON array as one pipeline object; assigning it
# first and then iterating enumerates the entries on every PowerShell version.
$knownList = ConvertFrom-Json ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${known}')))
foreach ($entry in $knownList) {
  if ($entry -and $entry.path) { $knownSignatures[[string]$entry.path] = $entry }
}
# The first ConvertFrom-Json loads its serializer on Windows PowerShell 5.1, so it
# is counted with the imports rather than as reading the registry.
$timings = [ordered]@{ importMs = [int]$clock.ElapsedMilliseconds }
$clock.Restart()
$clients = [System.Collections.Generic.List[object]]::new()
$errors = @{}
# The screen gets only the Chinese sentence in $errors; what PowerShell said, most
# often system English, goes back beside it for the runtime log alone.
$errorDetails = @{}
$registry = [System.Collections.Generic.List[object]]::new()
function Test-LocalExecutablePath([string]$candidate) {
  # Registry entries are user writable. Reject remote paths, alternate streams
  # and reparse parents before reading metadata or a signature from them.
  if ($candidate -notmatch '^[A-Za-z]:\\' -or $candidate.Substring(2) -match '[:<>"|?*\x00-\x1f]') { return $false }
  try {
    $full = [System.IO.Path]::GetFullPath($candidate)
    if ($full -ine $candidate) { return $false }
    $cursor = [System.IO.Path]::GetPathRoot($full)
    foreach ($segment in $full.Substring($cursor.Length).Split('\')) {
      if (!$segment) { continue }
      $cursor = Join-Path $cursor $segment
      $item = Get-Item -LiteralPath $cursor -Force
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $false }
    }
    return !$item.PSIsContainer
  } catch { return $false }
}
$roots = @('Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
$registryIncomplete = $false
$registryFailures = [System.Collections.Generic.List[object]]::new()
# Get-ItemProperty converts every value of a key, and a single malformed one fails
# the whole key: some installers write an 8-byte REG_DWORD (NetBeans' NoModify, for
# one), which the registry provider cannot cast, so that key throws on every scan.
# A key that throws is read again for just the values matched below, straight from
# the key; it counts as unreadable only when one of those is not readable as text.
function Read-UninstallValues($key) {
  $entry = [ordered]@{ PSChildName = [string]$key.PSChildName }
  foreach ($name in @('DisplayName', 'InstallLocation', 'DisplayIcon', 'DisplayVersion')) {
    $value = $key.GetValue($name)
    if ($null -ne $value -and $value -isnot [string]) { throw "$name is not text" }
    $entry[$name] = $value
  }
  [pscustomobject]$entry
}
foreach ($root in $roots) {
  try {
    if (Test-Path -LiteralPath $root) {
      foreach ($key in Get-ChildItem -LiteralPath $root) {
        try { $registry.Add((Get-ItemProperty -LiteralPath $key.PSPath)) }
        catch {
          $failure = $_
          try { $registry.Add((Read-UninstallValues $key)) }
          catch {
            $registryIncomplete = $true
            if ($registryFailures.Count -lt ${maximumRegistryFailures}) { $registryFailures.Add([pscustomobject]@{ entry=[string]$key.PSChildName; reason=[string]$failure.Exception.Message }) }
          }
        }
      }
    }
  } catch {
    $registryIncomplete = $true
    if ($registryFailures.Count -lt ${maximumRegistryFailures}) { $registryFailures.Add([pscustomobject]@{ entry=$root; reason=[string]$_.Exception.Message }) }
  }
}
$timings['registryMs'] = [int]$clock.ElapsedMilliseconds; $clock.Restart()
$processes = @(Get-Process -Name WorkBuddy,Claude,OpenCode -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Path } catch {} })
$timings['processMs'] = [int]$clock.ElapsedMilliseconds; $clock.Restart()
$products = @(
  @{ tool='workbuddy'; code='BFD312E9-1019-4F57-9F44-F86246833B50'; name='^WorkBuddy(?:\s|$)'; exe='WorkBuddy.exe' },
  @{ tool='claudeDesktop'; code='AnthropicClaude'; name='^Claude$'; exe='Claude.exe' },
  @{ tool='opencode'; code='d074f30d-5f88-5885-b075-be1348cc7676'; name='^OpenCode$'; exe='OpenCode.exe' }
)${only === undefined ? '' : `
$products = @($products | Where-Object { $_.tool -ceq '${only}' })`}
${only === undefined || only === 'claudeDesktop' ? windowsClaudeAppxInventory : ''}
$signatureClock = [System.Diagnostics.Stopwatch]::new()
$signaturesChecked = 0
$signaturesReused = 0
foreach ($product in $products) {
  if ($registryIncomplete -and !$errors.ContainsKey($product.tool)) {
    $errors[$product.tool] = '部分软件安装记录无法读取，暂时不能确认客户端是否未安装，请重试检测'
  }
  foreach ($entry in $registry) {
    $keyName = ([string]$entry.PSChildName).Trim('{}')
    if ($keyName -ine $product.code -and [string]$entry.DisplayName -notmatch $product.name) { continue }
    $paths = [System.Collections.Generic.List[string]]::new()
    if ($entry.InstallLocation) { $paths.Add((Join-Path ([string]$entry.InstallLocation).Trim('"') $product.exe)) }
    $icon = [string]$entry.DisplayIcon
    if ($icon -match '^"([^"\r\n]+\.exe)"(?:,[-\d]+)?$') { $paths.Add($Matches[1]) }
    elseif ($icon -match '^([^"\r\n]+\.exe)(?:,[-\d]+)?$') { $paths.Add($Matches[1]) }
    foreach ($exe in @($paths | Select-Object -Unique)) {
      if ([System.IO.Path]::GetFileName($exe) -ine $product.exe -or !(Test-LocalExecutablePath $exe)) { continue }
      try {
        $file = Get-Item -LiteralPath $exe -Force
        $stamp = '{0}:{1}:{2}' -f $file.Length, $file.LastWriteTimeUtc.Ticks, $file.CreationTimeUtc.Ticks
        $known = $knownSignatures[$exe]
        if ($known -and [string]$known.stamp -ceq $stamp -and [string]$known.version -ceq [string]$entry.DisplayVersion) {
          $signatureStatus = [string]$known.status
          $signatureSubject = [string]$known.subject
          $signaturesReused++
        } else {
          $signaturesChecked++
          $signatureClock.Start()
          try { $signature = Get-AuthenticodeSignature -LiteralPath $exe } finally { $signatureClock.Stop() }
          $signatureStatus = [string]$signature.Status
          $signatureSubject = [string]$signature.SignerCertificate.Subject
        }
        $clients.Add([pscustomobject]@{ tool=$product.tool; path=$exe; version=[string]$entry.DisplayVersion; running=($processes -contains $exe); signatureStatus=$signatureStatus; signatureSubject=$signatureSubject; signatureStamp=$stamp })
      } catch { $errors[$product.tool] = '无法读取客户端数字签名'; $errorDetails[$product.tool] = [string]$_.Exception.Message }
    }
  }
}
$timings['clientsMs'] = [int]$clock.ElapsedMilliseconds
$timings['signatureMs'] = [int]$signatureClock.ElapsedMilliseconds
$timings['signaturesChecked'] = $signaturesChecked
$timings['signaturesReused'] = $signaturesReused
@{ clients=@($clients.ToArray()); errors=$errors; errorDetails=$errorDetails; registryFailures=@($registryFailures.ToArray()); timings=$timings } | ConvertTo-Json -Depth 5 -Compress
`.trim()
}

export function buildExternalClientWingetInstall(tool: ExternalToolId, executable: string): CommandSpec {
  if (!isExternalToolId(tool)) throw new Error('未知客户端')
  return {
    executable,
    argv: ['install', '--id', definitions[tool].winget, '--exact', '--source', 'winget', '--scope', 'user', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
  }
}

function launchDetached(plan: LaunchPlan): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.executable, [...plan.argv], {
      cwd: plan.cwd, env: plan.env, shell: false, detached: true,
      stdio: 'ignore', windowsHide: plan.windowsHide,
    })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

export function createExternalClientRuntime(options: ExternalClientRuntimeOptions = {}) {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const userHome = options.userHome ?? os.homedir()
  const execute = options.runCommand ?? runCommand
  const verifyPath = options.verifyPath ?? verifyExternalClientPath
  const lstatPath = options.lstatPath ?? ((candidate: string) => fs.promises.lstat(candidate))
  const queue = options.installationQueue ?? new InstallationQueue()
  const launchProcess = options.launchProcess ?? launchDetached
  const resolveMachinePaths = options.resolveMachinePaths ?? resolveWindowsMachinePaths
  const jobs = new Map<ExternalToolId, { promise: Promise<ExternalClientRuntimeStatus>; observers: Set<(event: ExternalClientInstallProgress) => void>; last: ExternalClientInstallProgress | null }>()
  const installCancellations = new InstallCancellationRegistry()
  let inFlightScan: Promise<ExternalClientRuntimeStatus[]> | null = null
  const now = options.now ?? Date.now
  const scanCacheTtlMs = options.scanCacheTtlMs ?? defaultScanCacheTtlMs
  let cachedScan: { statuses: ExternalClientRuntimeStatus[]; at: number } | null = null
  // 装、卸、打开都会让在飞的那次盘点过时：它的结果照样交给等它的人，但不落进缓存。
  let scanGeneration = 0
  const knownSignatures = new Map<string, KnownExternalClientSignature>()
  // The macOS half of knownSignatures: a Gatekeeper/codesign pass is remembered
  // against the bundle fingerprint for a few minutes, passes only. A same-user
  // attacker can forge those timestamps, so only display-only scans may reuse it;
  // install and launch act on the bundle and always verify anew (the Windows
  // launch exception above does not extend to macOS).
  const verifiedBundles = new Map<string, { fingerprint: string; verifiedAt: number }>()

  const environment = () => trustedCommandEnvironment(options.env, platform === 'win32' ? resolveMachinePaths() : undefined, platform)
  const runningAsRoot = () => (options.getuid?.() ?? process.getuid?.() ?? 1) === 0
  const systemOptions = (): RunCommandOptions => ({ env: environment(), trustedOnly: true, timeoutMs: externalClientSystemCommandTimeoutMs, maxOutputBytes: maximumProbeBytes, windowsHide: true })
  const noInstallHint = (tool: ExternalToolId): string | null => {
    if (platform === 'win32') return architecture === 'x64' || (architecture === 'arm64' && tool !== 'workbuddy') ? null : '当前处理器架构没有可用的官方 Windows 安装包'
    // 有核对过的官方 Mac 包的才一键装；root 身份下装出来的应用归 root，客户自己更新不了。
    if (platform === 'darwin') return macosDesktopAppInstallable(tool, architecture) && !runningAsRoot() ? null : 'macOS 请先从客户端官网下载并将应用移入 Applications，然后重新检测'
    return '工具箱当前不支持此系统的桌面客户端安装与启动，请使用客户端官网提供的平台安装方案'
  }
  let lastWingetReason: string | null = null
  const resolveWinget = async (): Promise<SystemWingetResolution> => {
    if (platform !== 'win32') return { executable: null, reason: null }
    let winget: SystemWingetResolution
    try { winget = await (options.resolveWingetExecutable ?? resolveSystemWingetExecutable)() }
    catch (error) { winget = { executable: null, reason: errorText(error) } }
    const reason = winget.executable ? null : winget.reason || '未找到受信任的系统 winget'
    // 每次检测都会重找一遍；原因没变就不重复记，免得运行日志被同一行刷满。
    if (reason && reason !== lastWingetReason) options.onWingetUnavailable?.(reason)
    lastWingetReason = reason
    return winget
  }
  // 读不出来的安装记录、苹果没放行的原因同理：每次检测都会再碰到一次，内容没变就不重复记。
  let lastRegistryFailures: string | null = null
  const lastMacVerificationFailures = new Map<string, string>()
  const lastDetectionErrorDetails = new Map<ExternalToolId, string>()
  function noteRegistryFailures(failures: ExternalClientRegistryFailure[]) {
    const signature = failures.length ? JSON.stringify(failures) : null
    if (signature && signature !== lastRegistryFailures) options.onRegistryIncomplete?.(failures)
    lastRegistryFailures = signature
  }
  function noteMacVerificationFailure(tool: ExternalToolId, bundle: string, error: unknown) {
    const failure = describeMacVerificationFailure(tool, bundle, error)
    if (!failure) return
    const signature = JSON.stringify(failure)
    if (lastMacVerificationFailures.get(bundle) === signature) return
    lastMacVerificationFailures.set(bundle, signature)
    options.onMacVerificationFailed?.(failure)
  }
  // 这一次没有原话（检测成了，或失败的是别的原因）就忘掉，下次同样的原话再来时照样记。
  function noteDetectionErrorDetail(tool: ExternalToolId, reason: string | undefined, message: string | undefined) {
    if (!reason || !message) { lastDetectionErrorDetails.delete(tool); return }
    const signature = JSON.stringify([reason, message])
    if (lastDetectionErrorDetails.get(tool) === signature) return
    lastDetectionErrorDetails.set(tool, signature)
    options.onDetectionErrorDetail?.({ tool, reason, message })
  }

  function rememberSignature(item: Record<string, unknown>) {
    const file = textValue(item.path)
    const stamp = textValue(item.signatureStamp)
    if (!file || !stamp || !/^\d{1,20}:\d{1,20}:\d{1,20}$/.test(stamp)) return
    // 版本原样记（不 trim）：脚本拿它和卸载信息里的 DisplayVersion 逐字比，差一个空格也现验。
    // 太长的不记，这个文件之前记的也忘掉：截短或记成空串，就和别的版本、没登记版本分不开了。
    const version = item.version
    if (typeof version !== 'string' || version.length > 256) {
      knownSignatures.delete(file.toLowerCase())
      return
    }
    if (knownSignatures.size >= maximumKnownSignatures) knownSignatures.clear()
    knownSignatures.set(file.toLowerCase(), { path: file, stamp, status: textValue(item.signatureStatus) ?? '', subject: textValue(item.signatureSubject) ?? '', version })
  }

  async function inspectWindows(scope: InspectionScope): Promise<Inspection> {
    const remembered = [...knownSignatures.values()]
    const script = windowsExternalClientInventoryScript(scope.reuseSignatures === true ? remembered
      : scope.reuseVerifiedSignatures === true ? remembered.filter((entry) => entry.status === 'Valid') : [], scope.only)
    const result = await execute({ executable: options.resolvePowerShellExecutable?.() ?? resolveWindowsPowerShellExecutable({ platform, machinePaths: resolveMachinePaths() }), argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeWindowsPowerShellCommand(script)] }, systemOptions())
    const data = record(JSON.parse(cleanCommandOutput(result.stdout).trim()) as unknown)
    if (!Array.isArray(data.clients)) throw new Error('客户端安装检测未返回有效列表')
    noteRegistryFailures(registryFailures(data.registryFailures))
    const errors: Inspection['errors'] = {}
    if (data.errors !== undefined) {
      const rawErrors = record(data.errors)
      for (const tool of tools) if (textValue(rawErrors[tool])) errors[tool] = textValue(rawErrors[tool])!
    }
    const scriptErrors = { ...errors }
    const details = scriptErrorDetails(data.errorDetails)
    const clients: LocatedClient[] = []
    for (const raw of data.clients.slice(0, 100)) {
      const item = record(raw)
      if (!isExternalToolId(item.tool)) continue
      const tool = item.tool
      if (item.family === undefined) rememberSignature(item)
      try {
        const candidate = textValue(item.path)
        if (!candidate || !localWindowsPath(candidate) || path.win32.basename(candidate).toLowerCase() !== definitions[tool].executable.toLowerCase()) throw new Error('客户端可执行文件路径无效')
        const canonical = await verifyPath(candidate, item.family !== undefined ? 'appx-file' : 'file')
        if (path.win32.normalize(canonical).toLowerCase() !== path.win32.normalize(candidate).toLowerCase()) throw new Error('客户端路径经过符号链接或目录联接')
        let applicationId: string | undefined
        if (item.family !== undefined) {
          const location = textValue(item.installLocation)
          const publisher = textValue(item.publisher)
          if (tool !== 'claudeDesktop' || item.family !== claudeFamily || item.applicationId !== claudeApplicationId
            || !publisher || !/(?:^|,\s*)(?:CN|O)="Anthropic, PBC"(?:,|$)/i.test(publisher)
            || !location || !localWindowsPath(location)
            || !pathWithinWindowsRoot(location, path.win32.join(resolveMachinePaths().programFiles, 'WindowsApps'))
            || path.win32.dirname(location).toLowerCase() !== path.win32.join(resolveMachinePaths().programFiles, 'WindowsApps').toLowerCase()
            || !/^Claude_\d+(?:\.\d+){3}_(?:x64|arm64|neutral)__pzs8sxrjxfjjc$/i.test(path.win32.basename(location))
            || path.win32.relative(location, canonical).toLowerCase() !== 'app\\claude.exe') throw new Error('Claude 桌面端 AppX 身份或安装路径不可信')
          applicationId = claudeApplicationId
        } else if (item.signatureStatus !== 'Valid' || !publisherPatterns[tool].test(textValue(item.signatureSubject) ?? '')) {
          throw new Error(signatureMismatchMessage)
        }
        clients.push({ tool, path: canonical, version: versionValue(item.version), running: item.running === true, ...(applicationId ? { applicationId } : {}) })
      } catch (error) { errors[tool] = errorText(error) }
    }
    for (const client of clients) delete errors[client.tool]
    // 原话只配脚本自己说的那句：这一行最后报的要是这边核对路径、签名时另起的错，它就对不上了。
    // 打开前只看了一家，没看的那几家不算「这次没有原话」，免得下一轮检测把同一句再记一遍。
    for (const tool of scope.only ? [scope.only] : tools) noteDetectionErrorDetail(tool, errors[tool] === scriptErrors[tool] ? errors[tool] : undefined, details[tool])
    return { clients, errors, timings: { powershellMs: result.durationMs, ...scriptTimings(data.timings) } }
  }

  /** 包目录、Info.plist、主程序三处的身份和时间；主程序名不像样或读不到时给 null，那一次就现验。 */
  async function macBundleFingerprint(bundle: string, info: string, executableName: unknown): Promise<string | null> {
    if (typeof executableName !== 'string' || !executableName || executableName === '.' || executableName === '..'
      || path.posix.basename(executableName) !== executableName) return null
    try {
      const [bundleStats, infoStats, executableStats] = await Promise.all([
        lstatPath(bundle), lstatPath(info), lstatPath(path.posix.join(bundle, 'Contents', 'MacOS', executableName)),
      ])
      if (!executableStats.isFile()) return null
      return [
        bundleStats.dev, bundleStats.ino, bundleStats.mtimeMs,
        infoStats.mtimeMs, infoStats.size,
        executableStats.dev, executableStats.ino, executableStats.mtimeMs, executableStats.size,
      ].join(':')
    } catch { return null }
  }

  async function inspectMac(scope: InspectionScope): Promise<Inspection> {
    const clients: LocatedClient[] = []
    const errors: Inspection['errors'] = {}
    for (const tool of scope.only ? [scope.only] : tools) {
      const definition = definitions[tool]
      for (const directory of ['/Applications', path.posix.join(userHome, 'Applications')]) {
        const candidate = path.posix.join(directory, definition.bundle)
        try {
          const canonical = await verifyPath(candidate, 'directory')
          const info = await verifyPath(path.posix.join(canonical, 'Contents', 'Info.plist'), 'file')
          // `systemOptions()` defaults to trustedOnly for the Windows inventory probe,
          // where it resolves the executable from a trusted system directory and rejects
          // user-writable argument paths. On POSIX runCommand only swaps the environment
          // for that flag and drops the path checks silently, so leaving it on here would
          // advertise a guarantee macOS never gets. Every darwin probe passes the already
          // sanitized trusted environment explicitly and turns the flag off.
          const result = await execute({ executable: '/usr/bin/plutil', argv: ['-convert', 'json', '-o', '-', info] }, { ...systemOptions(), trustedOnly: false })
          const data = record(JSON.parse(result.stdout) as unknown)
          if (definition.bundleId && data.CFBundleIdentifier !== definition.bundleId) throw new Error('应用的 bundle identifier 与官方客户端不一致')
          const fingerprint = await macBundleFingerprint(canonical, info, data.CFBundleExecutable)
          const remembered = verifiedBundles.get(canonical)
          const stillVerified = scope.reuseSignatures === true && fingerprint !== null && remembered?.fingerprint === fingerprint
            && now() - remembered.verifiedAt < macVerificationTtlMs
          if (!stillVerified) {
            try {
              // LaunchServices performs the launch as the current user. Gatekeeper
              // checks the entire application; no guessed Team ID is used as proof.
              await execute({ executable: '/usr/sbin/spctl', argv: ['--assess', '--type', 'execute', canonical] }, { ...systemOptions(), trustedOnly: false, timeoutMs: 20_000 })
              if (tool === 'workbuddy') await execute({ executable: '/usr/bin/codesign', argv: darwinDeveloperIdVerificationArgv('FN2V63AD2J', canonical, { deep: true, bundleIdentifier: definition.bundleId }) }, { ...systemOptions(), trustedOnly: false, timeoutMs: 20_000 })
            } catch (error) {
              // 现验没过就忘掉上次那份：不然下一次展示用的检测会拿旧的「通过」把它报成好的。
              verifiedBundles.delete(canonical)
              noteMacVerificationFailure(tool, canonical, error)
              // 苹果说的原话只进运行日志；它明说不放行的，首页那一行说的和 Windows 上签名不对时同一句。
              throw macSignatureRefused(error) ? new Error(signatureMismatchMessage) : error
            }
            lastMacVerificationFailures.delete(canonical)
            if (fingerprint !== null) verifiedBundles.set(canonical, { fingerprint, verifiedAt: now() })
          }
          const processes = await execute({ executable: '/bin/ps', argv: ['-axo', 'comm='] }, { ...systemOptions(), trustedOnly: false })
          const running = processes.stdout.split(/\r?\n/).some((line) => line.trim().startsWith(`${canonical}/Contents/MacOS/`))
          clients.push({ tool, path: canonical, version: versionValue(data.CFBundleShortVersionString), running })
          delete errors[tool]
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors[tool] = errorText(error)
        }
      }
    }
    return { clients, errors }
  }

  async function inspect(scope: InspectionScope = {}): Promise<Inspection> {
    try { return platform === 'win32' ? await inspectWindows(scope) : platform === 'darwin' ? await inspectMac(scope) : { clients: [], errors: {} } }
    catch (error) { return { clients: [], errors: Object.fromEntries(tools.map((tool) => [tool, errorText(error)])) } }
  }
  function status(tool: ExternalToolId, inspection: Inspection, winget: SystemWingetResolution): ExternalClientRuntimeStatus {
    const client = inspection.clients.find((item) => item.tool === tool)
    const platformHint = noInstallHint(tool)
    const fallback = platform === 'win32' && platformHint === null && !winget.executable ? windowsWithoutWinget(tool) : null
    return {
      tool, installed: Boolean(client), version: client?.version ?? null, path: client?.path ?? null,
      installDirectory: client ? (platform === 'win32' ? path.win32.dirname(client.path) : client.path) : null,
      running: client?.running ?? false,
      installSupported: platformHint === null && (platform === 'darwin' || (platform === 'win32' && Boolean(winget.executable || fallback?.official))),
      launchSupported: Boolean(client) && (platform === 'win32' || (platform === 'darwin' && !runningAsRoot())),
      detectionError: inspection.errors[tool] ?? null, installHint: platformHint ?? fallback?.hint ?? null,
      officialDownloadUrl: fallback && !fallback.official ? officialDownloadUrl(tool) : null,
    }
  }
  function invalidateScan() {
    scanGeneration++
    cachedScan = null
  }
  function scan(scanOptions: ExternalClientScanOptions = {}): Promise<ExternalClientRuntimeStatus[]> {
    if (inFlightScan && scanOptions.fresh) {
      // 正在跑的那次一结束（它自己先清掉 inFlightScan），之后再有正在跑的也是这次调用之后起的。
      const after = () => scan({ force: true })
      return inFlightScan.then(after, after)
    }
    if (inFlightScan) return inFlightScan
    if (!scanOptions.force && !scanOptions.fresh && cachedScan && now() - cachedScan.at < scanCacheTtlMs) return Promise.resolve(cachedScan.statuses)
    const generation = scanGeneration
    const promise = Promise.all([inspect({ reuseSignatures: true }), resolveWinget()]).then(([inspection, winget]) => {
      const statuses = tools.map((tool) => status(tool, inspection, winget))
      // 检测出错的那次不缓存：老电脑上一次 PowerShell 超时不该让界面连着几分钟报错。
      if (generation === scanGeneration && statuses.every((entry) => !entry.detectionError)) cachedScan = { statuses, at: now() }
      return statuses
    })
    inFlightScan = promise
    void promise.then(() => { if (inFlightScan === promise) inFlightScan = null }, () => { if (inFlightScan === promise) inFlightScan = null })
    return promise
  }
  /**
   * Mac 上没有 winget 一类的系统安装器：下载官方包、核对签名、放进「应用程序」都在这一步。
   * 放进去是整个改名（跨盘时先拷到旁边的临时名字再改名），哪一步停下都不会留下半个应用，
   * 所以从头到尾都接受取消，不封存。
   */
  async function installOnMac(tool: ExternalToolId, report: (phase: ExternalClientInstallProgress['phase'], message: string, percent?: number | null) => void, signal: AbortSignal): Promise<void> {
    await options.assertDiskSpace?.(`${definitions[tool].name} 安装失败`)
    const run = () => (options.installMacosDesktopApp ?? installMacosDesktopApp)({
      tool, architecture, userHome, environment: options.env ?? process.env, fetch: options.fetch ?? fetch,
      runProcess: (plan) => execute({ executable: plan.executable, argv: [...plan.argv] }, { env: environment(), trustedOnly: false, timeoutMs: plan.timeoutMs, maxOutputBytes: 2 * 1024 * 1024, signal }),
      onProgress: (event) => report(event.phase, event.message, event.percent),
      signal,
    })
    await (options.withDownloadRoute ? options.withDownloadRoute(run) : run())
  }
  /**
   * Windows 上 Claude Desktop 的第二路：系统自带的安装组件没装上，或这台电脑根本没有它时，
   * 从 Claude 官网下离线安装包装。两路都没装上时把原因归成客户分得清的一句，原话挂在
   * originalError 上进运行日志。
   */
  async function installClaudeDesktopOnWindows(wingetFailure: unknown, report: (phase: ExternalClientInstallProgress['phase'], message: string, percent?: number | null) => void, cancellation: InstallCancellationHandle): Promise<void> {
    const wingetTried = wingetFailure !== undefined
    try {
      await options.assertDiskSpace?.(`${definitions.claudeDesktop.name} 安装失败`)
      // 接上加速线路要一会儿，先换上这一路的第一句，免得还停在上一路那句。
      report('downloading', describeClaudeDesktopMsixDownload(wingetTried, { percent: 0 }), 0)
      const run = () => (options.installClaudeDesktopFromOfficial ?? installClaudeDesktopFromOfficial)({
        architecture, wingetTried, fetch: options.fetch ?? fetch,
        windowsExecutionMode: options.windowsExecutionMode ?? 'trusted-only', runCommand: execute, env: options.env,
        resolveMachinePaths, resolvePowerShellExecutable: options.resolvePowerShellExecutable,
        onProgress: (event) => report(event.phase, event.message, event.percent),
        // 下载、核对安装包时点取消就停；交给 Windows 装的那一步不停，见 onInstallStarting。
        signal: cancellation.signal,
        onInstallStarting: () => cancellation.seal(installSealReason('claudeDesktop')),
      })
      await (options.withDownloadRoute ? options.withDownloadRoute(run) : run())
    } catch (error) {
      if (cancellation.cancelled) throw error
      const detail = error instanceof Error ? error.message : String(error)
      const message = isPlainClaudeDesktopInstallMessage(detail)
        ? errorText(error)
        : buildClaudeDesktopInstallFailureMessage(classifyClaudeDesktopInstallFailure(detail), { wingetTried })
      throw installationError(message, wingetTried ? { winget: wingetFailure, official: error } : error)
    }
  }
  function install(tool: ExternalToolId, onProgress?: (event: ExternalClientInstallProgress) => void): Promise<ExternalClientRuntimeStatus> {
    if (!isExternalToolId(tool)) return Promise.reject(new Error('未知客户端'))
    const existing = jobs.get(tool)
    if (existing) {
      if (onProgress) { existing.observers.add(onProgress); if (existing.last) { try { onProgress(existing.last) } catch { /* Observer errors cannot interrupt installation. */ } } }
      return existing.promise
    }
    const observers = new Set(onProgress ? [onProgress] : [])
    const job = { promise: null as unknown as Promise<ExternalClientRuntimeStatus>, observers, last: null as ExternalClientInstallProgress | null }
    const report = (phase: ExternalClientInstallProgress['phase'], message: string, percent: number | null = null) => {
      job.last = { tool, phase, message, percent }
      for (const observer of observers) { try { observer(job.last) } catch { /* UI failures cannot change an installer outcome. */ } }
    }
    // 句柄在入队之前登记：排在别的安装后面等待时也要能取消（同命令行工具）。重复点击
    // 走上面的 existing，不会再登记第二个把这一个挤掉。
    const cancellation = installCancellations.begin(installKey(tool))
    // 取消是客户自己按的，不是装失败：换成统一的一句，界面认得出来，不弹错误框。
    const cancelled = () => {
      const error = new InstallCancelledError(`${definitions[tool].name} 安装已取消`)
      report('error', error.message)
      return error
    }
    let started = false
    report('queued', `${definitions[tool].name} 已加入安装队列`)
    job.promise = queue.enqueue(installKey(tool), async () => {
      started = true
      try {
        // 排着队时点的取消已经让这一项直接出队了；这里兜底，这时什么都还没动。
        cancellation.throwIfCancelled()
        report('checking', `正在检测 ${definitions[tool].name}`)
        const [before, winget] = await Promise.all([inspect(), resolveWinget()])
        cancellation.throwIfCancelled()
        const current = status(tool, before, winget)
        if (current.installed) { report('completed', '客户端已安装，无需重复安装', 100); return current }
        if (current.detectionError) throw new Error(`无法确认当前安装状态：${current.detectionError}`)
        if (!current.installSupported) throw new Error(current.installHint || '当前系统不支持一键安装')
        if (platform === 'darwin') await installOnMac(tool, report, cancellation.signal)
        let officialDownloadNeeded = platform === 'win32' && !winget.executable
        let sourceFailure: unknown
        let installerStarted = false
        let recentOutput = ''
        // The resolver binds winget to Microsoft's protected AppInstaller package.
        // Its WindowsApps ACL is deliberately handled by that resolver, as in
        // node-runtime/python-runtime; never substitute a PATH/AppExecutionAlias.
        if (winget.executable) {
          // winget 自己又下载又安装，看不出哪一刻开始动这台电脑；结束它会连同它拉起的安装程序
          // 一起结束（Windows 上取消是结束整个进程树），所以整段都不接受取消。
          cancellation.seal(installSealReason(tool))
          report('downloading', `正在下载并安装 ${definitions[tool].name}`)
          try {
            await execute(buildExternalClientWingetInstall(tool, winget.executable), {
              env: environment(), trustedOnly: false, windowsHide: true,
              timeoutMs: 15 * 60_000, maxOutputBytes: 2 * 1024 * 1024, acceptedExitCodes: [0],
              onOutput: (event) => {
                const combined = recentOutput + cleanCommandOutput(event.text)
                if (/installing|starting package install|正在安装|开始.*安装/i.test(combined)) {
                  installerStarted = true
                  report('installing', `正在安装 ${definitions[tool].name}`)
                }
                recentOutput = combined.slice(-2048)
              },
            })
          } catch (error) {
            // Claude 官网的离线安装包是 MSIX：Windows 的应用部署要么整个装上、要么什么都不留，
            // 前一路装到一半也不会和它打架，所以除了客户自己取消，怎么没装上都换它接着装。
            const claudeFallback = tool === 'claudeDesktop' && !wingetCancelled(error)
            if (!claudeFallback && (tool !== 'workbuddy' || installerStarted || !wingetSourceUnavailable(error))) throw installationError(wingetFailureMessage(error), error)
            sourceFailure = error
            // 换星芒自己下官方安装包的那一路：下载时又能取消了。
            cancellation.unseal()
            const recheck = status(tool, await inspect(), winget)
            if (recheck.detectionError) {
              throw installationError(claudeFallback
                ? `无法确认当前安装状态：${recheck.detectionError}`
                : `连不上微软的软件下载源，且无法确认客户端安装状态：${recheck.detectionError}`, error)
            }
            officialDownloadNeeded = !recheck.installed
          }
        }
        if (officialDownloadNeeded) cancellation.throwIfCancelled()
        if (officialDownloadNeeded && tool === 'claudeDesktop') await installClaudeDesktopOnWindows(sourceFailure, report, cancellation)
        else if (officialDownloadNeeded) {
          report('downloading', sourceFailure ? '连不上微软的软件下载源，正在切换到腾讯官方下载' : '正在使用腾讯官方安装包')
          try {
            await (options.installWorkBuddyFromOfficial ?? installWorkBuddyFromOfficial)({
              architecture, windowsExecutionMode: options.windowsExecutionMode ?? 'trusted-only', runCommand: execute,
              onProgress: (event) => report(event.phase, event.message, event.percent),
              // 下载、核对时点取消就停；腾讯的安装程序跑起来以后不停，见 onInstallStarting。
              signal: cancellation.signal,
              onInstallStarting: () => cancellation.seal(installSealReason(tool)),
            })
          } catch (error) {
            if (cancellation.cancelled) throw error
            throw installationError(`${sourceFailure ? '连不上微软的软件下载源；' : ''}腾讯官方安装未完成：${errorText(error)}`, { winget: sourceFailure, official: error })
          }
        }
        report('checking', '正在验证安装结果')
        const after = status(tool, await inspect(), winget)
        if (!after.installed) throw new Error(after.detectionError || '安装命令已结束，但未检测到客户端，请检查安装器结果后重试检测')
        report('completed', `${definitions[tool].name} 安装完成`, 100)
        return after
      } catch (error) {
        if (cancellation.cancelled || isInstallCancelledError(error)) throw cancelled()
        report('error', errorText(error))
        throw error
      }
    }, { signal: cancellation.signal })
      // 排着队时点的取消让这一项直接出队，不用等前面那项装完。上面的任务没跑过，
      // 取消的那句在这里补上。
      .catch((error: unknown) => { throw started ? error : cancelled() })
      .finally(() => cancellation.release())
    jobs.set(tool, job)
    void job.promise.then(() => { jobs.delete(tool) }, () => { jobs.delete(tool) })
    // 装成、装失败都作废：失败的安装器也可能已经留下了一半的文件。
    void job.promise.then(invalidateScan, invalidateScan)
    return job.promise
  }
  function cancelInstall(tool: ExternalToolId): InstallCancellationOutcome {
    return installCancellations.cancel(installKey(tool))
  }
  function launch(tool: ExternalToolId): Promise<void> {
    if (!isExternalToolId(tool)) return Promise.reject(new Error('未知客户端'))
    const requestedAt = now()
    const launched = queue.enqueue(`external-client:launch:${tool}`, async () => {
      const startedAt = now()
      // 只看要打开的这一个：没点的那几家跟这次打开无关，不该让人多等它们的检测和签名核对。
      // Windows 上验过并且通过、文件和版本都没变的不再现验（已知68，理由见 windowsExternalClientInventoryScript 上面）。
      const inspection = await inspect({ only: tool, reuseVerifiedSignatures: platform === 'win32' })
      const inspectedAt = now()
      const client = inspection.clients.find((item) => item.tool === tool)
      if (!client) throw new Error(inspection.errors[tool] || '尚未检测到客户端，请先安装并重新检测')
      if (platform === 'win32') {
        const machinePaths = resolveMachinePaths()
        const executable = options.resolveExplorerExecutable?.() ?? resolveWindowsExplorerExecutable({ platform, machinePaths })
        // Reuse the project's Explorer broker boundary for user-installed apps.
        // A signed Electron exe alone does not make writable sibling DLLs safe
        // for an elevated spawn; Explorer delegates to the interactive shell.
        await launchProcess({ executable, argv: [client.applicationId ? `shell:AppsFolder\\${client.applicationId}` : client.path], cwd: machinePaths.systemRoot, env: environment(), windowsHide: true })
      } else if (platform === 'darwin') {
        if (runningAsRoot()) throw new Error('请以普通用户身份重新打开工具箱后启动桌面客户端')
        await execute({ executable: '/usr/bin/open', argv: ['-a', client.path] }, { env: environment(), trustedOnly: false, timeoutMs: 15_000, maxOutputBytes: maximumProbeBytes })
      } else throw new Error('当前系统不支持启动此桌面客户端')
      try { options.onLaunchTiming?.({ tool, queueWaitMs: startedAt - requestedAt, inventoryMs: inspectedAt - startedAt, launchMs: now() - inspectedAt, ...inspection.timings }) }
      catch { /* 客户端已经交出去了：用时记不下也不能让这次打开报失败，不然客户再点一次就开出第二个窗口。 */ }
    })
    // 打开之后「正在运行」就变了，下一次检测得重新盘点。
    void launched.then(invalidateScan, invalidateScan)
    return launched
  }
  /**
   * 上一轮盘点认出来的那个客户端这会儿还开着没有：true / false；看不出来（检测失败、平台不支持）= null。
   * 只比路径，不重新认人：认人那一步在真要改配置之前的整轮盘点里照旧做（followExternalClientRoute）。
   */
  async function stillRunning(tool: ExternalToolId, clientPath: string): Promise<boolean | null> {
    try {
      if (platform === 'win32') {
        const result = await execute({ executable: options.resolvePowerShellExecutable?.() ?? resolveWindowsPowerShellExecutable({ platform, machinePaths: resolveMachinePaths() }), argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeWindowsPowerShellCommand(windowsExternalClientProcessScript(tool))] }, systemOptions())
        const paths = JSON.parse(cleanCommandOutput(result.stdout).trim() || '[]') as unknown
        if (!Array.isArray(paths)) return null
        const expected = path.win32.normalize(clientPath).toLowerCase()
        return paths.some((entry) => typeof entry === 'string' && path.win32.normalize(entry).toLowerCase() === expected)
      }
      if (platform === 'darwin') {
        const processes = await execute({ executable: '/bin/ps', argv: ['-axo', 'comm='] }, { ...systemOptions(), trustedOnly: false })
        return processes.stdout.split(/\r?\n/).some((line) => line.trim().startsWith(`${clientPath}/Contents/MacOS/`))
      }
      return null
    } catch {
      return null
    }
  }

  return { scan, install, cancelInstall, launch, stillRunning }
}
