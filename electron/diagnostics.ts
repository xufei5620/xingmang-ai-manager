import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { readBoundedUtf8FileSync } from './bounded-file'
import { readBoundedResponseText } from './bounded-response'
import { cliCatalog, providerConfigDirectoryNames, providerIds, type ProviderId } from './catalog'
import {
  commandEnvironment,
  findExecutable,
  isTrustedHighIntegrityExecutable,
  primeTrustedHighIntegrityExecutable,
  runCommand,
  trustedCommandEnvironment,
} from './command-runner'
import { defaultProviderConfigRoots, type IgnoredCodexHome, type ProviderConfigRoots } from './codex-home'
import { isLoopbackDownloadProxy, parseChromiumProxyResult } from './download-proxy'
import { inspectProviderConfig, type NativeConfigInspection } from './config-files'
import {
  formatFreeSpace,
  installMinimumFreeBytes,
  lowDiskSpaceBytes,
  mergeSameDeviceReadings,
  readDiskSpace,
  type DiskSpaceReading,
} from './disk-space'
import { gitMissingImpact, gitMissingNotice } from './git-runtime'
import {
  commandLineToolsShimNotice,
  inspectCommandLineToolsShim,
  isMacOsCommandLineToolsShim,
  xcodeLicensePendingNotice,
} from './macos-command-line-tools'
import { managedCliRoot } from './managed-cli-paths'
import { classifyNetworkFailure, networkFailureMessages } from './network-failure'
import {
  buildNodeTlsProbeScript,
  certificateTrustNetworkFailedSummary,
  certificateTrustSummaries,
  certificateTrustVerdict,
  nodeTlsProbeEnvironment,
  nodeTlsProbeTimeoutMs,
  parseNodeTlsProbeOutput,
  type CertificateTrustVerdict,
  type NodeTlsProbeResult,
} from './certificate-trust-probe'
import { redactSecretPatterns } from './redaction-patterns'
import { relayApiProbeBaseUrl, resolveRelaySite, type RelaySite } from './relay-sites'
import { findReparseComponent, type ReparseComponent } from './safe-local-data'
import { resolveRelocatedPath } from './relocated-folders'
import { inspectDocumentsWritability, type DocumentsWritability } from './documents-fallback'
import type { StarterWorkspaceLocationContext } from './starter-workspace'
import {
  inspectProxyVariables,
  probeLoopbackProxy,
  readWindowsProxyScopes,
  type LoopbackProbe,
  type ProxyVariableFinding,
  type ProxyVariableScopes,
} from './stale-proxy-environment'
import { resolveCliCommand, resolveCliInstallation } from './tool-installation'
import type { ToolConfigOwnership } from './tool-config-ownership'
import type { SystemSnapshot } from './system-service'
import type { UserWideCertificateTrustState } from './user-certificate-trust'
import {
  inspectWindowsExecutableMachine,
  type WindowsExecutableMachine,
  type WindowsProcessorArchitecture,
} from './windows-processor'
import { buildPowerShellModuleImportStatement } from './powershell-module-imports'
import {
  describeWindowsExecutionProbeFailure,
  inspectCurrentWindowsProcessHighIntegrity,
  inspectWindowsElevationCapability,
  resolveWindowsPowerShellExecutable,
  type WindowsCliExecutionModeResolution,
  type WindowsElevationCapability,
} from './windows-elevation'
import {
  describeOverride,
  inspectWorkspaceConfigOverrides,
  summarizeWorkspaceOverrides,
} from './workspace-config-overrides'

export type DiagnosticState = 'pass' | 'warn' | 'fail' | 'error'

export interface DiagnosticItem {
  code: string
  title: string
  state: DiagnosticState
  summary: string
  details?: Record<string, boolean | number | string | null>
  durationMs: number
}

export interface DiagnosticsReport {
  version: 1
  generatedAt: string
  durationMs: number
  counts: Record<DiagnosticState, number>
  items: DiagnosticItem[]
}

export interface DiagnosticToolStatus {
  installed: boolean
  version: string | null
  path: string | null
  running?: boolean
  /** macOS：PATH 上只找到了命令行开发者工具的空壳，没去执行它（见 macos-command-line-tools.ts）。 */
  commandLineToolsShim?: boolean
  /** macOS：空壳背后是 Xcode，但许可协议还没同意，一跑只吐一句英文报错。 */
  xcodeLicensePending?: boolean
}

export interface DiagnosticAppInfo {
  name: string
  version: string
  packaged: boolean
}

export interface ProxyVariableSummary {
  name: string
  source: 'process' | 'user' | 'system'
}

export interface DiagnosticsDependencies {
  app: DiagnosticAppInfo
  providerRoots?: ProviderConfigRoots
  homeDirectory?: string
  platform?: NodeJS.Platform
  arch?: string
  release?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  now?: () => Date
  inspectAdministrator?: (signal: AbortSignal) => Promise<boolean>
  /** 当前 Windows 账号能不能自己提权（不是「现在是不是管理员」，见 windows-elevation.ts）。 */
  inspectElevationCapability?: (signal: AbortSignal) => Promise<WindowsElevationCapability>
  inspectPowerShell?: (signal: AbortSignal) => Promise<DiagnosticToolStatus>
  inspectTool?: (tool: DiagnosticToolId, signal: AbortSignal) => Promise<DiagnosticToolStatus>
  inspectCodexDesktop?: (signal: AbortSignal) => Promise<DiagnosticToolStatus>
  inspectProvider?: (provider: ProviderId, roots: ProviderConfigRoots) => NativeConfigInspection
  /**
   * 「Claude 命令确认方式」那一项要先知道这份 settings.json 是不是本软件替当前账号写
   * 的（`account`），否则每个配置正常的用户都会被自己造成的配置警告一次。诊断自己算
   * 不出来源（判定要读 userData 下的所有权记录并比对当前登录账号），宿主给了才分流，
   * 不给就按「不是我们写的」处理。
   */
  readClaudeConfigOwnership?: () => ToolConfigOwnership | null | undefined
  /**
   * 用户最近一次在本软件里选的项目文件夹。「项目文件夹里的设置」一项看它里面有没有
   * 会盖过当前账号的设置；不给就只看这台电脑上统一下发的那几份。
   */
  workspace?: string
  /** 只给测试用：Claude Code 管理策略所在目录。 */
  claudeManagedDirectory?: string
  /**
   * 首页扫描刚探过的结果。给了就直接拿它回答运行环境、四个 CLI、Codex 桌面端与
   * PowerShell 这几项，不再各起一遍子进程；扫描里探测失败的那几项仍然自己探。
   * 缺省 = 全部自己探（旧行为），检查页手动点「重新检测」走的就是这条。
   */
  recentScan?: DiagnosticsScanSnapshot | null
  /** 复用扫描结果时 PowerShell 那一项只取可信路径、不起进程；测试用它造出 Windows 的路径解析。 */
  resolvePowerShellExecutable?: () => string
  /** Which relay site's connectivity to probe (XINGMANG_NETWORK). Defaults to the default site. */
  relaySite?: RelaySite
  /**
   * 加速开着没有。开着时星芒自己的服务按加速规则直接连（acceleration-clash-config.ts
   * 的 relayDirectHosts），「星芒 AI 网络」一项顺带说一句，免得用户以为这项量的是加速线路。
   * 缺省 = 不提（旧行为）。
   */
  inspectAccelerationActive?: () => Promise<boolean>
  fetch?: typeof globalThis.fetch
  clashConfigPaths?: readonly string[]
  /**
   * Windows 上「电脑里的代理设置」一项读当前账号与整台电脑各设了哪几条，用来判断
   * 能不能给「清掉这条旧设置」按钮。缺省 = 起 PowerShell 读（异步）；读不到按不知道处理。
   */
  readProxyScopes?: () => Promise<ProxyVariableScopes | null>
  /** 试连代理设置指向的本机端口；缺省 = 真的去连。 */
  probeLoopbackProxy?: LoopbackProbe
  /**
   * 「电脑里的代理设置」一项另看星芒自己连账号服务走不走代理：宿主交给 Electron 的
   * `session.resolveProxy`，答案就是账号请求（net.fetch）真正走的那条路，系统设置
   * 里勾的 HTTP / HTTPS / SOCKS / 自动代理配置都已经算进去，不起任何外部命令。
   * 缺省 = 不看（旧行为）。
   */
  resolveAppProxy?: (url: string) => Promise<string>
  /**
   * 「安全证书」一项用电脑上的 Node.js 做一次 TLS 握手（certificate-trust-probe.ts）。
   * 缺省 = 真的起 `node -e`；测试用它造「公司证书」「Node 太旧」这些情况。
   */
  probeNodeTls?: (input: NodeTlsProbeInput, signal: AbortSignal) => Promise<NodeTlsProbeResult>
  /**
   * 「安全证书」查出公司证书时，客户自己开的终端是不是也已经信任它
   * （user-certificate-trust.ts）。宿主给了才在 Windows 上多一颗按钮；缺省 = 不提。
   */
  inspectUserWideCertificateTrust?: () => UserWideCertificateTrustState
  /**
   * 软件数据目录（Electron 的 userData）。诊断自己算不出它在哪，宿主给了才把它
   * 算进「磁盘空间」这一项；不给就只看 CLI 落点。
   */
  userDataDirectory?: string
  /** 剩余空间的读取口，测试用它造「够 / 不够 / 读不到」三种盘。 */
  readDiskSpace?: typeof readDiskSpace
  inspectProxyVariables?: (signal: AbortSignal) => Promise<ProxyVariableSummary[]>
  /**
   * AI 生成的图片、视频存在哪只有宿主知道；给了才有「AI 作品保存位置」这一项。
   * 宿主真写一个小文件再删掉，resolve 就是写得进，reject 就是写不进。
   */
  probeAiOutput?: () => Promise<void>
  /**
   * 启动时 AI 作品位置是不是因为「文档」不让写改到了个人文件夹（ai-output-location.ts
   * 的 chooseAiOutputRoot）。给了且换过，「AI 作品保存位置」一项照实说作品在哪。
   */
  aiOutputPlacement?: () => { movedFromDocuments: boolean, earlierWorksLeftInDocuments: boolean } | null
  /**
   * 系统「文档」目录（app.getPath('documents')）；拿不到传 null。给了（含 null）才在
   * Windows 上有「「文档」文件夹能不能写」这一项。
   */
  documentsDirectory?: string | null
  /** 测试用：模拟「文档」能写、不让写、写不进。 */
  inspectDocuments?: (documentsDirectory: string | null, context: StarterWorkspaceLocationContext) => DocumentsWritability
  /**
   * 正式安装包自带的加速文件启动时读没读通。只有安装包本来就带加速文件时宿主才给，
   * 给了才有「加速功能」这一项；开发时和不带加速的包都没有这一项。
   */
  accelerationBundle?: 'intact' | 'damaged'
  /**
   * 启动时那次「是不是管理员」探测的结果（`resolveWindowsCliExecutionModeDetailed`）。
   * 只读、不重跑：执行模式在启动时就定死了，检查页要说的是「这次启动被怎么处理了」。
   * 缺省按探测成功处理，只看当前令牌。
   */
  windowsExecution?: WindowsCliExecutionModeResolution | null
  /**
   * 这台 Windows 电脑真实的芯片（system-service 的 inspectWindowsProcessor，一次启动只问一次）。
   * 是 ARM 才有「电脑芯片」这一项；缺省 = 不知道，不出这一项。
   */
  windowsProcessor?: WindowsProcessorArchitecture | null
  /** 「电脑芯片」一项读 node.exe 的文件头看它是哪一版；测试用它造两种 Node.js。 */
  inspectExecutableMachine?: (filePath: string) => Promise<WindowsExecutableMachine | null>
  /** 「文件夹位置」一项逐级找被重定向的那一级；测试用它造「搬过家」的目录。 */
  findReparseComponent?: (target: string) => ReparseComponent | null
  /** 按当前放行规则把「搬过家」的文件夹换成实际位置；测试用它模拟放行。 */
  resolveRelocatedPath?: (target: string) => string
  /**
   * 启动时发现用户环境里的 CODEX_HOME 不可用、已按没设处理（codex-home.ts）。
   * 传进来的 env 里 CODEX_HOME 已被换成本程序算出的位置，诊断自己看不到原值，
   * 只能由宿主告诉它。原值只用来判断会不会连不上，从不进报告。
   */
  ignoredCodexHome?: IgnoredCodexHome
  /**
   * 诊断报告是要上屏、也要能导出给客服的，所以它只装中文结论。认出一个失败靠的
   * 那段上游原文（`net::ERR_CERT_AUTHORITY_INVALID` 这类）留在 runtime.jsonl 里：
   * 用户看结论，排查的人看原文，两边都不用迁就对方。缺省不记。
   */
  log?: (
    level: 'info' | 'warn' | 'error',
    event: string,
    message: string,
    detail?: Record<string, unknown>,
  ) => void
}

export interface DiagnosticRedactionOptions {
  userHome?: string
  codexHome?: string
  /** @deprecated Use userHome. */
  homeDirectory?: string
  sensitiveValues?: readonly string[]
}

export type DiagnosticToolId = 'node' | 'npm' | 'python' | 'git' | ProviderId

export type DiagnosticsScanSnapshot = Pick<SystemSnapshot, 'runtime' | 'clis' | 'desktopApps'>

export interface DiagnosticsRunOptions {
  /**
   * 手上有现成的首页扫描结果就用它（见 DiagnosticsDependencies.recentScan）。只有开机
   * 那次自动检查传；检查页手动检测不传，照旧全部重探。缺省 = 不复用（旧行为）。
   */
  reuseRecentScan?: boolean
}

/** 多久以内跑完的扫描算「现成的」：开机自动检查紧跟着首页扫描，一分钟足够。 */
export const diagnosticsScanReuseMs = 60_000

/** 扫描里这一项的结论；扫描自己没探成（detectionFailed）就是 null，交回诊断自己探。 */
export function scannedToolStatus(snapshot: DiagnosticsScanSnapshot, tool: DiagnosticToolId): DiagnosticToolStatus | null {
  const status = (providerIds as readonly string[]).includes(tool) ? snapshot.clis[tool as ProviderId] : snapshot.runtime[tool as 'node' | 'npm' | 'python' | 'git']
  if (!status || status.detectionFailed) return null
  return status.installed ? { installed: true, version: status.version, path: status.path } : { installed: false, version: null, path: null }
}

export function scannedCodexDesktopStatus(snapshot: DiagnosticsScanSnapshot): DiagnosticToolStatus | null {
  const status = snapshot.desktopApps.codex
  if (status.detectionFailed) return null
  return status.installed
    ? { installed: true, version: status.version, path: status.path, running: status.running }
    : { installed: false, version: null, path: null, running: false }
}

interface CheckOutcome {
  state: DiagnosticState
  summary: string
  details?: Record<string, boolean | number | string | null>
  /** 这一项这台电脑上不用出（比如没装 Node.js 时的「安全证书」）。 */
  omit?: boolean
}

export interface NodeTlsProbeInput {
  nodePath: string
  host: string
  port: number
  /** true = 带上 NODE_USE_SYSTEM_CA=1；false = 只用 Node 自带的根证书。 */
  useSystemRoots: boolean
}

interface CheckDefinition {
  code: string
  title: string
  run: (signal: AbortSignal) => Promise<CheckOutcome> | CheckOutcome
  /** 只说明情况、不决定软件行为的项，超时给这句提醒，不亮红色的「检查超时」。 */
  timeoutOutcome?: CheckOutcome
}

const DEFAULT_CHECK_TIMEOUT_MS = 8_000
const accelerationBundleDamagedSummary = '加速用的文件被删掉或改动了，多半是杀毒软件拦的。'
  + '打开杀毒软件的「隔离区」或「恢复区」把星芒的文件恢复，并把星芒加入信任；也可以重新安装一次星芒，装在原来的位置就行。'
/**
 * 差多少才值得说。证书校验本身有容差，本机时钟与服务器差几十秒也是常态，
 * 阈值定低了就是每次检查都亮一条没人能处理的黄灯。
 */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const MAX_CLASH_CONFIG_BYTES = 2 * 1024 * 1024
const MAX_CLAUDE_SETTINGS_BYTES = 256 * 1024
/** 两个站的状态接口都只回几 KB 的 JSON；门户页再大也用不着读完才认出来。 */
const MAX_NETWORK_PROBE_BYTES = 256 * 1024
const MAX_YAML_ALIAS_COUNT = 20
const runtimeCheckTitles: Readonly<Record<'node' | 'npm' | 'python', string>> = {
  node: 'Node.js',
  // npm 是 Node.js 自带的，客户不需要认识这个名字。
  npm: 'Node.js 自带的安装组件',
  python: 'Python',
}
const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizedPathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function pathApiFor(value: string, ...roots: string[]): typeof path.win32 | typeof path.posix {
  return /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\\\')
    || roots.some((root) => /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\'))
    ? path.win32
    : path.posix
}

function resolvePathLike(value: string): string {
  return pathApiFor(value, value).resolve(value)
}

function isAbsolutePathLike(value: string, roots: ProviderConfigRoots): boolean {
  return pathApiFor(value, roots.userHome, roots.codexHome).isAbsolute(value)
}

function pathForDisplay(filePath: string | null, roots: ProviderConfigRoots): string | null {
  if (!filePath) return null
  const pathApi = pathApiFor(filePath, roots.userHome, roots.codexHome)
  const resolved = pathApi.resolve(filePath)
  const rootLabels = [
    { root: pathApi.resolve(roots.codexHome), label: '[CODEX_HOME]' },
    { root: pathApi.resolve(roots.userHome), label: '~' },
  ].sort((left, right) => right.root.length - left.root.length)
  for (const { root, label } of rootLabels) {
    const relative = pathApi.relative(root, resolved)
    if (relative === '') return label
    if (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative)) {
      return `${label}/${relative.split(pathApi.sep).join('/')}`
    }
  }
  const basename = pathApi.basename(resolved)
  return basename && basename !== pathApi.parse(resolved).root
    ? `[ABSOLUTE_PATH]/${basename}`
    : '[ABSOLUTE_PATH]'
}

function pathOrIdentifierForDisplay(value: string | null, roots: ProviderConfigRoots): string | null {
  if (!value) return null
  return isAbsolutePathLike(value, roots) || value.includes('/') || value.includes('\\')
    ? pathForDisplay(value, roots)
    : value
}

interface RootReplacement {
  candidate: string
  label: string
  caseInsensitive: boolean
}

function rootReplacements(roots: { userHome?: string, codexHome?: string }): RootReplacement[] {
  const replacements = new Map<string, RootReplacement>()
  for (const [root, label] of [
    [roots.codexHome?.trim(), '[CODEX_HOME]'],
    [roots.userHome?.trim(), '~'],
  ] as const) {
    if (!root) continue
    const resolved = resolvePathLike(root)
    const slashRoot = root.replaceAll('\\', '/')
    const slashResolved = resolved.replaceAll('\\', '/')
    const variants = new Set([
      root,
      resolved,
      slashRoot,
      root.replaceAll('/', '\\'),
      slashResolved,
      resolved.replaceAll('/', '\\'),
      slashRoot.replaceAll('/', '\\/'),
      slashResolved.replaceAll('/', '\\/'),
    ])
    for (const variant of [...variants]) variants.add(JSON.stringify(variant).slice(1, -1))
    const caseInsensitive = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\')
    for (const candidate of variants) {
      if (!candidate || replacements.has(candidate)) continue
      replacements.set(candidate, { candidate, label, caseInsensitive })
    }
  }
  return [...replacements.values()].sort((left, right) => right.candidate.length - left.candidate.length)
}

function redactRootPaths(value: string, roots: { userHome?: string, codexHome?: string }): string {
  let result = value
  for (const replacement of rootReplacements(roots)) {
    const flags = replacement.caseInsensitive ? 'gi' : 'g'
    const pattern = new RegExp(
      `(^|[^A-Za-z0-9\\\\/._-])${escapeRegExp(replacement.candidate)}(?=$|[\\\\/]|[^A-Za-z0-9\\\\/._-])`,
      flags,
    )
    result = result.replace(
      pattern,
      (_match, prefix: string) => `${prefix}${replacement.label}`,
    )
  }
  return result
}

function redactStructuredAbsolutePaths(value: unknown, roots: ProviderConfigRoots): unknown {
  if (typeof value === 'string') {
    const redacted = redactRootPaths(value, roots)
    if (redacted !== value) return redacted
    return isAbsolutePathLike(value, roots) ? pathForDisplay(value, roots) : value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactStructuredAbsolutePaths(entry, roots))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      redactStructuredAbsolutePaths(entry, roots),
    ]))
  }
  return value
}

function safeUrlForDisplay(value: string): string {
  if (!value) return ''
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, parsed.pathname === '/' ? '/' : '')
  } catch {
    return '[invalid URL]'
  }
}

function redactUrls(value: string): string {
  return value.replace(/\b(?:https?|socks4|socks5):\/\/[^\s"'<>]+/gi, (match) => {
    const suffix = match.match(/[),.;]+$/)?.[0] ?? ''
    const rawUrl = suffix ? match.slice(0, -suffix.length) : match
    try {
      const parsed = new URL(rawUrl)
      if (parsed.username) parsed.username = '[REDACTED]'
      if (parsed.password) parsed.password = '[REDACTED]'
      if (parsed.search) parsed.search = '?[REDACTED]'
      parsed.hash = ''
      return `${parsed.toString()}${suffix}`
    } catch {
      return `[REDACTED_URL]${suffix}`
    }
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function redactDiagnosticText(
  value: string,
  options: DiagnosticRedactionOptions = {},
): string {
  let result = value
  const secrets = [...new Set((options.sensitiveValues ?? []).filter((entry) => entry.length >= 3))]
    .sort((left, right) => right.length - left.length)
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]')

  result = redactUrls(redactSecretPatterns(result))

  return redactRootPaths(result, {
    userHome: options.userHome ?? options.homeDirectory,
    codexHome: options.codexHome,
  })
}

export function createDiagnosticsExport(
  report: DiagnosticsReport,
  options: DiagnosticRedactionOptions = {},
): string {
  const userHome = resolvePathLike(options.userHome ?? options.homeDirectory ?? os.homedir())
  const codexHome = resolvePathLike(
    options.codexHome ?? defaultProviderConfigRoots(userHome).codexHome,
  )
  const roots = { userHome, codexHome }
  const payload = {
    product: '星芒AI管理工具',
    exportedAt: new Date().toISOString(),
    diagnostics: redactStructuredAbsolutePaths(report, roots),
  }
  return `${redactDiagnosticText(JSON.stringify(payload, null, 2), {
    ...options,
    userHome,
    codexHome,
  })}\n`
}

function clashCandidates(homeDirectory: string, env: NodeJS.ProcessEnv): string[] {
  const appData = env.APPDATA
  const xdgConfig = env.XDG_CONFIG_HOME
  return [...new Set([
    appData && path.join(appData, 'io.github.clash-verge-rev.clash-verge-rev', 'clash-verge.yaml'),
    appData && path.join(appData, 'clash-verge-rev', 'clash-verge.yaml'),
    xdgConfig && path.join(xdgConfig, 'io.github.clash-verge-rev.clash-verge-rev', 'clash-verge.yaml'),
    path.join(homeDirectory, '.config', 'io.github.clash-verge-rev.clash-verge-rev', 'clash-verge.yaml'),
    path.join(homeDirectory, '.config', 'clash-verge-rev', 'clash-verge.yaml'),
  ].filter((entry): entry is string => Boolean(entry)).map((entry) => path.resolve(entry)))]
}

export function parseClashTunConfig(source: string): boolean {
  if (Buffer.byteLength(source, 'utf8') > MAX_CLASH_CONFIG_BYTES) {
    throw new Error('Clash 配置文件超过解析限制')
  }
  const document = parseDocument(source, {
    schema: 'core',
    customTags: [],
    resolveKnownTags: false,
    merge: false,
    strict: true,
    uniqueKeys: true,
    logLevel: 'silent',
  })
  if (document.errors.length || document.warnings.length) {
    throw new Error('Clash YAML 包含不受支持的结构或标签')
  }
  const value = document.toJS({ maxAliasCount: MAX_YAML_ALIAS_COUNT }) as unknown
  if (!isRecord(value)) throw new Error('Clash YAML 顶层必须是映射')

  if (value.enable_tun_mode === true || value.tun_mode === true) return true
  const tun = value.tun
  return isRecord(tun) && tun.enable === true
}

function findWindowsShim(command: string, env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== 'win32') return null
  const searchPath = env.PATH ?? env.Path ?? env.path ?? ''
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory.replace(/^"(.*)"$/, '$1'), `${command}.cmd`)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // Continue with the next PATH entry.
    }
  }
  return null
}

async function versionForExecutable(
  executable: string,
  tool: DiagnosticToolId,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  // 直接做同步校验，Program Files 下的路径会在主线程上起 PowerShell 读权限，
  // node / npm / git 各一次，普通用户点「重新检测」时窗口就卡住了。
  await primeTrustedHighIntegrityExecutable(executable)
  if (!isTrustedHighIntegrityExecutable(executable, env)) return null
  if (process.platform === 'win32' && path.extname(executable).toLowerCase() === '.cmd' && tool !== 'npm') {
    return null
  }
  const args = ['--version']
  const result = await runCommand({
    executable,
    argv: args,
    windowsPackageManager: tool === 'npm' ? 'npm' : undefined,
  }, {
    env: process.platform === 'win32' ? trustedCommandEnvironment(env) : commandEnvironment(env),
    trustedOnly: process.platform === 'win32',
    timeoutMs: 5_000,
    maxOutputBytes: 128 * 1024,
    signal,
  })
  return `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null
}

async function defaultInspectTool(
  tool: DiagnosticToolId,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<DiagnosticToolStatus> {
  if (providerIds.includes(tool as ProviderId)) {
    const provider = tool as ProviderId
    const installation = await resolveCliInstallation(provider, { env })
    if (!installation) return { installed: false, version: null, path: null }
    if (installation.source === 'npm') {
      return {
        installed: true,
        version: installation.packageVersion ?? null,
        path: installation.commandPath,
      }
    }
    try {
      const command = await resolveCliCommand(provider, env, 'trusted-only', {
        darwinStagingRetention: 'ephemeral',
      })
      try {
        await primeTrustedHighIntegrityExecutable(command.executable)
        if (!isTrustedHighIntegrityExecutable(command.executable, env)) {
          return { installed: true, version: null, path: installation.commandPath }
        }
        const result = await runCommand({
          executable: command.executable,
          argv: [...command.argv, ...cliCatalog[provider].versionArgs],
        }, {
          env: process.platform === 'win32' ? trustedCommandEnvironment(env) : commandEnvironment(env),
          trustedOnly: process.platform === 'win32',
          timeoutMs: 5_000,
          maxOutputBytes: 128 * 1024,
          signal,
        })
        return {
          installed: true,
          version: `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null,
          path: command.verifiedDarwinStandalone?.executablePath ?? installation.commandPath,
        }
      } finally {
        await command.release?.()
      }
    } catch {
      return { installed: true, version: null, path: null }
    }
  }
  const commands = tool === 'python' ? ['python', 'python3', 'py'] : [tool]
  let commandLineToolsShim = false
  let xcodeLicensePending = false
  for (const command of commands) {
    const executable = await findExecutable(command, {
      env: commandEnvironment(env),
      windowsPackageManagers: command === 'npm' ? ['npm'] : [],
    }) ?? findWindowsShim(command, env)
    if (!executable) continue
    if (isMacOsCommandLineToolsShim(executable)) {
      const shimState = await inspectCommandLineToolsShim(executable, { env, signal })
      if (shimState !== 'usable') {
        commandLineToolsShim = true
        xcodeLicensePending ||= shimState === 'license-pending'
        continue
      }
    }
    let version: string | null = null
    try {
      version = await versionForExecutable(executable, tool, signal, env)
    } catch {
      // Presence is still useful when a package-manager shim cannot be executed safely.
    }
    return { installed: true, version, path: executable }
  }
  if (commandLineToolsShim) {
    return {
      installed: false,
      version: null,
      path: null,
      commandLineToolsShim,
      ...(xcodeLicensePending ? { xcodeLicensePending } : {}),
    }
  }
  return { installed: false, version: null, path: null }
}

async function defaultInspectAdministrator(signal: AbortSignal): Promise<boolean> {
  if (process.platform !== 'win32') return typeof process.getuid === 'function' && process.getuid() === 0
  // whoami 几十毫秒就答；PowerShell 冷启动在慢电脑上要好几秒，和下面问「能不能提权」
  // 那次加起来就超过单项预算了。读不出完整性标签时才退回 PowerShell。
  const highIntegrity = await inspectCurrentWindowsProcessHighIntegrity({ timeoutMs: 3_000 }).catch(() => null)
  if (highIntegrity !== null) return highIntegrity
  const script = [
    '$identity=[Security.Principal.WindowsIdentity]::GetCurrent()',
    '$principal=[Security.Principal.WindowsPrincipal]::new($identity)',
    '$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  ].join(';')
  const result = await runCommand({
    executable: resolveWindowsPowerShellExecutable(),
    argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
  }, {
    env: trustedCommandEnvironment(),
    trustedOnly: true,
    timeoutMs: 4_000,
    maxOutputBytes: 16 * 1024,
    signal,
  })
  return result.stdout.trim().toLowerCase() === 'true'
}

async function defaultInspectPowerShell(
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<DiagnosticToolStatus> {
  let executable: string
  try {
    executable = resolveWindowsPowerShellExecutable({ env })
  } catch {
    return { installed: false, version: null, path: null }
  }
  const result = await runCommand({
    executable,
    argv: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$PSVersionTable.PSVersion.ToString()',
    ],
  }, {
    env: trustedCommandEnvironment(env),
    trustedOnly: true,
    timeoutMs: 4_000,
    maxOutputBytes: 16 * 1024,
    signal,
  })
  return {
    installed: true,
    version: result.stdout.trim() || null,
    path: executable,
  }
}

/**
 * 检查页「Codex 桌面端」那一项单独跑时的脚本。跑在 trustedCommandEnvironment() 下，
 * 有一条命令要 PowerShell 自己去找模块就得把系统模块整个扫一遍（CI 上 20 多秒），
 * 远超这一项的 6 秒，检查页就报「读不到」；所以开头先按名字导入用到的模块。
 */
export const diagnosticsCodexDesktopProbeModules = [
  'Microsoft.PowerShell.Utility',
  'Appx',
  'Microsoft.PowerShell.Management',
  'StartLayout',
] as const

export const diagnosticsCodexDesktopProbeTimeoutMs = 6_000

export function buildDiagnosticsCodexDesktopProbeScript(): string {
  return [
    buildPowerShellModuleImportStatement(diagnosticsCodexDesktopProbeModules),
    '$app=@(Get-StartApps | Where-Object { $_.AppID -like "OpenAI.Codex*!App" } | Select-Object -First 1 Name,AppID)',
    // AppX registration is per user. Do not fall back to Get-AppxPackage
    // -AllUsers: a normal account is commonly denied that query, and an
    // elevated manager could otherwise report another user's package as
    // launchable from the current profile.
    'if ($app.Count -eq 0) { $pkg=@(Get-AppxPackage -Name "OpenAI.Codex*" | Sort-Object Name | Select-Object -First 1 PackageFamilyName,Version); if ($pkg.Count -gt 0) { $app=@([pscustomobject]@{Name="Codex Desktop $($pkg[0].Version)";AppID="$($pkg[0].PackageFamilyName)!App"}) } }',
    '$running=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "Codex*" }).Count -gt 0',
    '[pscustomobject]@{Name=$app.Name;AppID=$app.AppID;Running=$running}|ConvertTo-Json -Compress',
  ].join(';')
}

async function defaultInspectCodexDesktop(signal: AbortSignal): Promise<DiagnosticToolStatus> {
  if (process.platform !== 'win32') return { installed: false, version: null, path: null, running: false }
  const script = buildDiagnosticsCodexDesktopProbeScript()
  const result = await runCommand({
    executable: resolveWindowsPowerShellExecutable(),
    argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
  }, {
    env: trustedCommandEnvironment(),
    trustedOnly: true,
    timeoutMs: diagnosticsCodexDesktopProbeTimeoutMs,
    maxOutputBytes: 64 * 1024,
    signal,
  })
  const parsed = JSON.parse(result.stdout) as { Name?: unknown; AppID?: unknown; Running?: unknown }
  const appId = typeof parsed.AppID === 'string' ? parsed.AppID : null
  return {
    installed: Boolean(appId),
    version: typeof parsed.Name === 'string' ? parsed.Name : null,
    path: appId,
    running: parsed.Running === true,
  }
}

async function defaultProxyVariables(env: NodeJS.ProcessEnv): Promise<ProxyVariableSummary[]> {
  const result: ProxyVariableSummary[] = []
  const pairs = Object.entries(env)
  for (const name of PROXY_NAMES) {
    const match = pairs.find(([candidate]) => candidate.toUpperCase() === name)
    if (match?.[1]?.trim()) result.push({ name, source: 'process' })
  }
  return result
}

function proxyFindingDetails(findings: readonly ProxyVariableFinding[]): Record<string, string> {
  return Object.fromEntries(findings.map((finding) => [
    finding.name,
    finding.target ? `本机 ${finding.target.port} 端口（${finding.reach === 'open' ? '开着' : '没开'}）` : '别的机器',
  ]))
}

/**
 * 「电脑里的代理设置」（第十六批 5）。看的是本软件自己的环境——从这里打开的工具
 * 拿到的就是它——再读一次当前账号与整台电脑各设了什么，决定能不能一键清掉。
 * details 只写变量名和本机端口，不写原值：原值里可能带着代理的用户名和密码。
 */
export async function windowsProxySettingsOutcome(
  env: NodeJS.ProcessEnv,
  probe: LoopbackProbe,
  readScopes: () => Promise<ProxyVariableScopes | null>,
): Promise<Omit<DiagnosticItem, 'code' | 'title' | 'durationMs'>> {
  const findings = await inspectProxyVariables(env, probe)
  if (!findings.length) return { state: 'pass', summary: '电脑里没有设代理，工具直接联网' }
  const closed = findings.filter((finding) => finding.reach === 'closed')
  const details = proxyFindingDetails(findings)
  if (closed.length) {
    const port = closed[0].target?.port
    const scopes = await readScopes().catch(() => null)
    const userClosed = scopes ? (await inspectProxyVariables(scopes.user, probe)).some((finding) => finding.reach === 'closed') : false
    const machineClosed = scopes ? (await inspectProxyVariables(scopes.machine, probe)).some((finding) => finding.reach === 'closed') : false
    const lead = `电脑里设了一个代理（本机 ${port} 端口），但它现在没开。`
    if (userClosed) {
      return {
        state: 'warn',
        summary: `${lead}从星芒打开的工具会自动绕开它；你自己开的命令行窗口可能还是连不上。`,
        details: { ...details, fix: 'clear-user-proxy', port: port ?? null },
      }
    }
    return {
      state: 'warn',
      summary: machineClosed
        ? `${lead}这条设置是给整台电脑设的，要管理员才能改。从星芒打开的工具已经会自动绕开它。`
        : `${lead}从星芒打开的工具会自动绕开它。`,
      details,
    }
  }
  const remote = findings.find((finding) => finding.reach === 'remote')
  if (remote) {
    return {
      state: 'warn',
      summary: '电脑里设了代理，工具会通过它联网。如果工具连不上，先确认这个代理能用。',
      details,
    }
  }
  return {
    state: 'pass',
    summary: `电脑里设了代理（本机 ${findings[0].target?.port} 端口），工具会通过它联网。`,
    details,
  }
}

/** Windows 以外只列环境变量的名字和来源，不探端口（旧行为）。 */
function otherProxySettingsOutcome(
  variables: readonly ProxyVariableSummary[],
): Omit<DiagnosticItem, 'code' | 'title' | 'durationMs'> {
  const unique = [...new Map(variables.map((item) => [`${item.name}:${item.source}`, item])).values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source))
  return {
    state: unique.length ? 'warn' : 'pass',
    summary: unique.length ? `电脑里另外设了 ${unique.length} 处代理，详情里能看到` : '没有另外设过代理',
    details: Object.fromEntries(unique.map((item, index) => [`variable${index + 1}`, `${item.name} (${item.source})`])),
  }
}

/** 系统代理只是一句附加说明，读不出来就当没有，不拖慢整项检查。 */
const appProxyResolveTimeoutMs = 3_000

export type AppProxyRoute =
  | { reach: 'open' | 'closed'; port: number }
  | { reach: 'remote' }

/**
 * 客户开着别的代理软件或 VPN 时，它通常改的是系统设置里的代理，而不是那几个环境
 * 变量；星芒的账号、余额请求跟着系统代理走，于是全部超时，可这一项此前只看环境
 * 变量，照样报「正常」（2026-10-01 客户 Mac 报障）。这里问 Chromium 这一个地址
 * 实际走哪条路，DIRECT 或认不出的写法都按没有代理处理，和以前一样。
 */
export async function inspectAppProxyRoute(
  resolve: (url: string) => Promise<string>,
  url: string,
  probe: LoopbackProbe,
): Promise<AppProxyRoute | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), appProxyResolveTimeoutMs)
    timer.unref()
  })
  try {
    const resolved = await Promise.race([resolve(url).catch(() => null), timeout])
    const endpoint = parseChromiumProxyResult(resolved)
    if (!endpoint) return null
    if (!isLoopbackDownloadProxy(endpoint)) return { reach: 'remote' }
    const host = endpoint.host.replace(/^\[(.*)\]$/, '$1').toLowerCase()
    const open = await probe({ host, port: endpoint.port }).catch(() => false)
    return { reach: open ? 'open' : 'closed', port: endpoint.port }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把系统代理并进「电脑里的代理设置」这一项。只写本机端口或「别的机器」，不写代理
 * 地址：和环境变量那半边同一个口径，报告会被导出发给客服。
 */
export function withAppProxyRoute(
  outcome: Omit<DiagnosticItem, 'code' | 'title' | 'durationMs'>,
  route: AppProxyRoute | null,
): Omit<DiagnosticItem, 'code' | 'title' | 'durationMs'> {
  if (!route) return outcome
  const sentence = route.reach === 'remote'
    ? '电脑里开着代理（用的是别的机器上的代理），星芒会跟着它走；连不上账号时先关掉这个代理再试。'
    : route.reach === 'closed'
      ? `电脑里开着代理（本机 ${route.port} 端口），但它现在没开，星芒会连不上账号。打开对应的代理软件，或者在系统设置里把代理关掉再试。`
      : `电脑里开着代理（本机 ${route.port} 端口），星芒会跟着它走；连不上账号时先退出代理软件再试。`
  const details = outcome.details ?? {}
  const variablesFound = Object.keys(details).length > 0
  return {
    ...outcome,
    state: outcome.state === 'pass' ? 'warn' : outcome.state,
    summary: variablesFound ? `${sentence}另外，${outcome.summary}` : sentence,
    details: {
      ...details,
      systemProxy: route.reach === 'remote' ? '别的机器' : `本机 ${route.port} 端口（${route.reach === 'open' ? '开着' : '没开'}）`,
    },
  }
}

type EnvironmentOverrideKind = 'baseUrl' | 'secret' | 'directory' | 'model' | 'other'

interface EnvironmentOverrideVariable {
  name: string
  provider: ProviderId
  kind: EnvironmentOverrideKind
  /**
   * true = 设了（且不指向当前账号）就一定让这个 CLI 绕开本程序写入的配置，请求
   * 发去别处或带着别的 Key——检查结论升为「待处理」，开机提示也会数它。
   * false = 盖不过写入的配置，或只影响模型之类不决定能不能连上的东西，仍是「需留意」。
   */
  breaksAccount: boolean
}

interface EnvironmentOverrideMatch {
  name: string
  provider: ProviderId
  kind: EnvironmentOverrideKind
  /** false = 用户确实设了它，但它指的就是当前账号，不会把请求带去别处。 */
  overriding: boolean
  /** overriding 且这个变量会让 CLI 连不上当前账号（见 breaksAccount）。 */
  breaking: boolean
}

/**
 * 用户自己开终端跑 CLI 时，进程环境里这几个变量的优先级高于配置文件，所以
 * 「配置文件写对了」并不等于「跑起来用的就是当前账号」。这是「我明明配好了却
 * 还是走旧地址」最常见的来源，而检查页此前对此一无所知——四个 PROVIDER_* 项只
 * 看文件。
 *
 * 只读、只提醒：代删别人设的变量等于改用户的机器，而且本进程也删不掉别的 shell
 * 的环境。Grok 的同类变量没有在本仓实测过（`GROK_DISABLE_AUTOUPDATER` 是唯一
 * 核实过的一个，与中转地址无关），按 T12 的口径宁缺勿猜，等实测再补。
 *
 * breaksAccount 的取值是 2026-09-22 在沙箱里实测的（Claude Code 2.1.277、Codex
 * 0.155.1、Gemini CLI 0.60.0；配置按 config-files.ts 的模板写，base URL 指本地假
 * 接口，逐个设变量看请求去了哪、带的是哪把 Key），不是照文档推的：
 * - Claude：settings.json 的 env 段压过进程环境，ANTHROPIC_BASE_URL /
 *   ANTHROPIC_AUTH_TOKEN 设了请求照样发往写入的地址、带写入的 Key。但
 *   ANTHROPIC_API_KEY 会多带一个 `x-api-key` 头，而 new-api 在 /v1/messages 上拿
 *   它顶掉 Authorization（middleware/auth.go），等于换了一把 Key。
 *   CLAUDE_CONFIG_DIR 让 Claude 去别的目录找配置，本程序写的 ~/.claude 整个不读。
 * - Codex：自定义 model provider 不认 OPENAI_BASE_URL / OPENAI_API_KEY（设了照旧打
 *   config.toml 里的地址、带 auth.json 的 Key）。CODEX_HOME 本程序自己也认
 *   （codex-home.ts），配置就写在它指的地方，所以也不算。
 * - Gemini：~/.gemini/.env 不覆盖已有的进程环境，GOOGLE_GEMINI_BASE_URL 与
 *   GEMINI_API_KEY 都是进程环境说了算。GOOGLE_GEMINI_API_KEY 实测不生效；
 *   GEMINI_MODEL、GOOGLE_GENAI_API_VERSION 只换模型和路径版本，不换账号。
 */
const ENVIRONMENT_OVERRIDE_VARIABLES: readonly EnvironmentOverrideVariable[] = [
  { name: 'ANTHROPIC_BASE_URL', provider: 'claude', kind: 'baseUrl', breaksAccount: false },
  { name: 'ANTHROPIC_AUTH_TOKEN', provider: 'claude', kind: 'secret', breaksAccount: false },
  { name: 'ANTHROPIC_API_KEY', provider: 'claude', kind: 'secret', breaksAccount: true },
  { name: 'CLAUDE_CONFIG_DIR', provider: 'claude', kind: 'directory', breaksAccount: true },
  { name: 'OPENAI_BASE_URL', provider: 'codex', kind: 'baseUrl', breaksAccount: false },
  { name: 'OPENAI_API_KEY', provider: 'codex', kind: 'secret', breaksAccount: false },
  { name: 'CODEX_HOME', provider: 'codex', kind: 'directory', breaksAccount: false },
  { name: 'GOOGLE_GEMINI_BASE_URL', provider: 'gemini', kind: 'baseUrl', breaksAccount: true },
  { name: 'GEMINI_API_KEY', provider: 'gemini', kind: 'secret', breaksAccount: true },
  { name: 'GOOGLE_GEMINI_API_KEY', provider: 'gemini', kind: 'secret', breaksAccount: false },
  { name: 'GEMINI_MODEL', provider: 'gemini', kind: 'model', breaksAccount: false },
  { name: 'GOOGLE_GENAI_API_VERSION', provider: 'gemini', kind: 'other', breaksAccount: false },
]

/** 与 defaultProxyVariables 同法：Windows 的环境变量名大小写不敏感。 */
function environmentValueFor(env: NodeJS.ProcessEnv, name: string): string {
  const match = Object.entries(env).find(([candidate]) => candidate.toUpperCase() === name)
  return typeof match?.[1] === 'string' ? match[1].trim() : ''
}

function sameHostAs(value: string, expected: string): boolean {
  try {
    const left = new URL(value)
    const right = new URL(expected)
    return left.protocol === right.protocol && left.host.toLowerCase() === right.host.toLowerCase()
  } catch {
    return false
  }
}

function collectEnvironmentOverrides(
  env: NodeJS.ProcessEnv,
  providerBaseUrls: RelaySite['providerBaseUrls'],
  userHome: string,
): EnvironmentOverrideMatch[] {
  const matches: EnvironmentOverrideMatch[] = []
  for (const variable of ENVIRONMENT_OVERRIDE_VARIABLES) {
    const value = environmentValueFor(env, variable.name)
    if (!value) continue
    // CODEX_HOME 是本程序自己解析出来再注入进 codexEnv 的（codex-home.ts），所以
    // 诊断拿到的 env 里它永远有值。指到默认位置就是本程序自己写的那份，报它等于
    // 每次检查都给一条假警报；只有指到别处才是用户真的改过。
    if (variable.kind === 'directory') {
      const fallback = path.join(userHome, providerConfigDirectoryNames[variable.provider])
      if (normalizedPathKey(value) === normalizedPathKey(fallback)) continue
    }
    // 指向当前站点的 BASE_URL 不会把请求带去别处，报它只会教用户删一个本来
    // 没问题的变量。Key 和模型不在此列：它们盖掉的是账号和分组本身。
    const overriding = !(variable.kind === 'baseUrl' && sameHostAs(value, providerBaseUrls[variable.provider]))
    matches.push({
      name: variable.name,
      provider: variable.provider,
      kind: variable.kind,
      overriding,
      breaking: overriding && variable.breaksAccount,
    })
  }
  return matches
}

/**
 * 检查页「删掉这几项设置」能替用户删的那几个名字：盖过当前账号的地址、密钥、模型。
 * 指向别的文件夹的那两个（CLAUDE_CONFIG_DIR、CODEX_HOME）不删：它们指着用户自己的
 * 一整份配置，删了等于把他原来的设置、记录换了个地方，这个得他自己决定。
 */
export function clearableEnvironmentOverrides(
  env: NodeJS.ProcessEnv,
  providerBaseUrls: RelaySite['providerBaseUrls'],
  userHome: string,
): string[] {
  return collectEnvironmentOverrides(env, providerBaseUrls, userHome)
    .filter((match) => match.overriding && match.kind !== 'directory')
    .map((match) => match.name)
}

/** 名单外的名字一律不碰；清除脚本那一侧再对照一遍。 */
export const environmentOverrideNames: readonly string[] = ENVIRONMENT_OVERRIDE_VARIABLES.map((variable) => variable.name)

/** Windows 上有能删的，就在结论里挂上「删掉这几项设置」（details.fix，详情抽屉不显示它）。 */
function withEnvironmentOverrideFix(outcome: CheckOutcome, clearable: boolean): CheckOutcome {
  if (!clearable || outcome.state === 'pass') return outcome
  return { ...outcome, details: { ...outcome.details, fix: 'clear-user-overrides' } }
}

function namesOf(matches: readonly EnvironmentOverrideMatch[]): string {
  const listed = matches.slice(0, 3).map((match) => match.name).join('、')
  return matches.length > 3 ? `${listed}等 ${matches.length} 项` : listed
}

function environmentOverrideOutcome(matches: readonly EnvironmentOverrideMatch[]): CheckOutcome {
  const details: Record<string, boolean | number | string | null> = { count: matches.length }
  matches.forEach((match, index) => {
    // 只有变量名进报告。ANTHROPIC_AUTH_TOKEN 的值本身就是一把 Key，而诊断导出是
    // 要发到客服群里的（I3、I13）——所以这里永远不读也不写它的值。
    const note = !match.overriding ? '，已指向当前账号' : match.breaking ? '，会绕开当前账号' : ''
    details[`variable${index + 1}`] = `${match.name}（${cliCatalog[match.provider].name}${note}）`
  })
  const overriding = matches.filter((match) => match.overriding)
  if (!overriding.length) {
    return {
      state: 'pass',
      summary: matches.length
        ? '电脑里另外设的工具地址也指向当前账号，不影响使用'
        : '没有另外设过工具地址或密钥',
      details,
    }
  }
  const breaking = overriding.filter((match) => match.breaking)
  if (breaking.length) {
    const tools = [...new Set(breaking.map((match) => cliCatalog[match.provider].name))].join('、')
    return {
      // 这几个变量实测会让 CLI 绕开写入的配置（见 breaksAccount），用户在终端里
      // 跑就连不上当前账号，所以是「待处理」。本程序仍然不替他删。
      state: 'fail',
      summary: `电脑里另外设了 ${namesOf(breaking)}，会让 ${tools} 不用当前账号的设置。删掉它们再重新打开工具就好；不会删请在「反馈」页导出报告发给客服`,
      details,
    }
  }
  return {
    // 用「需留意」不是「待处理」：剩下这些实测盖不过写入的配置，或只换模型、不换
    // 账号（见 breaksAccount）。仍提一句，是因为用户换个方式跑（项目里的配置、别的
    // 启动器）时它们可能生效；文案因此用「可能」。
    state: 'warn',
    summary: `电脑里另外设了 ${namesOf(overriding)}，可能会盖过当前账号的设置`,
    details,
  }
}

/**
 * 网络那一项探测的地址：当前站点上一个不用登录、本来就回 JSON 的公开接口。
 *
 * 站点根路径不能用来判断「被拦截」：两个站的根路径都是网页前端，正常时也回
 * text/html，#302 就是因此对所有人误报。换成本来就回 JSON 的接口后，「拿到的
 * 是网页而不是 JSON」才真正说明中间有东西替服务器答了话。两个接口都已按上游
 * 源码核实：new-api 的 `GET /api/status`（docs/RECON-new-api.md 的「状态」行，
 * 公开）与 sub2api 的 `GET /api/v1/settings/public`（登录页自己读的公开设置）。
 * 都在 /api 下，是账号客户端本来就要走的路径，不会被只放行 /api 与 /v1 的反代
 * 挡在外面。两者都只认 GET：gin 不会把 HEAD 路由到 GET 处理器，HEAD 拿不到这份
 * JSON。
 *
 * 地址跟着 CLI 实际调用的域走（relayApiProbeBaseUrl），今天两个站的中转域与
 * 账号域恰好同域，所以接口按 accountBackend 选。
 */
export function relayStatusProbeUrl(site: RelaySite): string {
  const origin = new URL(relayApiProbeBaseUrl(site))
  if (origin.protocol !== 'https:') throw new Error('星芒 AI 地址不是 https，已拒绝检查')
  switch (site.accountBackend) {
    case 'new-api':
      return new URL('/api/status', origin).href
    case 'sub2api':
      return new URL('/api/v1/settings/public', origin).href
  }
}

function parsesAsJson(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null
  } catch {
    return false
  }
}

/**
 * 一张证书有没有过期，是拿本机时钟去比出来的：系统时间差得多，每一张正常的证书
 * 都会当场变成「已过期」，于是登录、装 CLI、检查更新一起卡在证书校验这一步，而
 * 用户看到的只是「换个网络」。HTTP 的 Date 头里就带着服务器那一侧的时间，顺手比
 * 一次不用新发任何请求。
 *
 * 没有 Date 头、或者这个头不是一个能解析的时间，就返回 null——宁可不说，也不要
 * 拿一个解析不出来的值去吓用户。
 */
export function clockSkewMs(dateHeader: string | null | undefined, now: Date): number | null {
  if (!dateHeader) return null
  const serverTime = Date.parse(dateHeader)
  if (!Number.isFinite(serverTime)) return null
  return now.getTime() - serverTime
}

/** 对时入口每个系统都不一样，说不清具体在哪一页的提示等于没说。 */
export function clockSyncGuidance(platform: NodeJS.Platform): string {
  if (platform === 'win32') return '请在「设置 → 时间和语言 → 日期和时间」里打开「自动设置时间」，并确认时区正确。'
  if (platform === 'darwin') return '请在「系统设置 → 通用 → 日期与时间」里打开「自动设置时间和日期」，并确认时区正确。'
  return '请把系统时间设为自动同步，并确认时区正确。'
}

/** 日志里要看得见真正的原因，而 fetch 把它塞在 cause 里，外层只剩 fetch failed。 */
function errorChainText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (typeof current !== 'object') {
      parts.push(String(current))
      break
    }
    const record = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown }
    parts.push([record.name, record.message, record.code]
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      .join(': '))
    current = record.cause
  }
  return parts.filter(Boolean).join(' <- ').slice(0, 500)
}

interface IgnoredCodexHomeFinding {
  /** true = 在软件外面打开的 Codex 读不到本程序替当前账号写好的配置。 */
  blocking: boolean
}

/**
 * 软件自己启动的 Codex 拿到的是注入过的 CODEX_HOME，不受影响；受影响的是用户
 * 从开始菜单、终端这些软件外面打开的 Codex，它读的仍是那个写错的值。Codex 不展开
 * `~` 和 `%USERPROFILE%`，相对路径按当前目录解析，而这类进程的当前目录通常就是
 * 用户目录，所以按用户目录解析一次：落回本程序写配置的那个目录（比如只写了
 * `.codex`）就还连得上，否则就连不上。Codex 根本没接当前账号时，连不连得上
 * 无从谈起，只提醒不算待处理。
 */
function inspectIgnoredCodexHome(
  ignored: IgnoredCodexHome | undefined,
  roots: ProviderConfigRoots,
  codexInspection: NativeConfigInspection | undefined,
): IgnoredCodexHomeFinding | null {
  if (!ignored) return null
  const configured = Boolean(codexInspection?.matchesRelay && codexInspection.hasApiKey)
  const landsOnCodexHome = ignored.reason === 'relative'
    && normalizedPathKey(path.resolve(roots.userHome, ignored.value)) === normalizedPathKey(roots.codexHome)
  return { blocking: configured && !landsOnCodexHome }
}

/**
 * 叠在 environmentOverrideOutcome 之后而不是改它：写错的 CODEX_HOME 不是「盖过
 * 配置」，是「本来要盖、被本程序忽略了」，结论要单独说，其余变量的判定原样保留。
 */
function withIgnoredCodexHome(outcome: CheckOutcome, finding: IgnoredCodexHomeFinding | null): CheckOutcome {
  if (!finding) return outcome
  const previous = outcome.details ?? {}
  const labels = Object.keys(previous)
    .filter((key) => /^variable\d+$/.test(key))
    .sort((left, right) => Number(left.slice(8)) - Number(right.slice(8)))
    .map((key) => previous[key])
  const details: Record<string, boolean | number | string | null> = {
    ...Object.fromEntries(Object.entries(previous).filter(([key]) => !/^variable\d+$/.test(key))),
    count: labels.length + 1,
  }
  // 写错的原值可能带着用户名，和其它变量一样只有名字进报告。
  const ordered = [`CODEX_HOME（${cliCatalog.codex.name}，写得不对，已忽略）`, ...labels]
  ordered.forEach((label, index) => {
    details[`variable${index + 1}`] = label
  })
  const effect = finding.blocking ? '，但在软件外面打开 Codex 会连不上当前账号' : ''
  const others = outcome.state === 'pass' ? '' : `；${outcome.summary}`
  // 连不上当前账号才算「待处理」（开机横幅只数这一档）；软件里打开的 Codex 本来
  // 就不受影响，其余情况只是提醒。其它变量已经判出更重的一档时不往下拉。
  const state = finding.blocking || outcome.state === 'fail' ? 'fail' : 'warn'
  return { state, summary: `电脑里有一个 Codex 的设置写得不对，软件已经忽略它${effect}${others}`, details }
}

function providerOutcome(provider: ProviderId, inspection: NativeConfigInspection, roots: ProviderConfigRoots): CheckOutcome {
  const details: Record<string, boolean | number | string | null> = {
    exists: inspection.exists,
    hasApiKey: inspection.hasApiKey,
    matchesRelay: inspection.matchesRelay,
    model: inspection.model || null,
    baseUrl: safeUrlForDisplay(inspection.actualBaseUrl),
    fileCount: inspection.files.length,
    existingFileCount: inspection.files.filter((file) => file.exists).length,
    updatedAt: inspection.updatedAt,
  }
  inspection.files.forEach((file, index) => {
    details[`file${index + 1}`] = pathForDisplay(file.path, roots)
  })
  if (inspection.matchesRelay && inspection.hasApiKey) {
    return { state: 'pass', summary: '已连到当前账号', details }
  }
  if (!inspection.exists) return { state: 'warn', summary: '还没有连接设置', details }
  if (!inspection.hasApiKey) return { state: 'fail', summary: '连接设置里没有 Key', details }
  return { state: 'fail', summary: '连接地址不是当前账号的', details }
}

async function defaultProbeNodeTls(
  input: NodeTlsProbeInput,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<NodeTlsProbeResult> {
  try {
    // 普通权限那条路（system-service 的 sameUserTerminalEnvironment）同样是
    // commandEnvironment：量的就是装工具、打开工具时真实会用到的那个 Node。
    const result = await runCommand({
      executable: input.nodePath,
      argv: ['-e', buildNodeTlsProbeScript(), input.host, String(input.port)],
    }, {
      env: nodeTlsProbeEnvironment(commandEnvironment(env), input.useSystemRoots),
      timeoutMs: nodeTlsProbeTimeoutMs + 2_000,
      maxOutputBytes: 4 * 1024,
      signal,
    })
    return parseNodeTlsProbeOutput(result.stdout)
  } catch {
    return { outcome: 'other', version: null }
  }
}

/** 探测地址拆成握手用的主机和端口；不是 https 就不探。 */
export function certificateProbeTarget(endpoint: string): { host: string, port: number } | null {
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || !url.hostname) return null
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 443 }
  } catch {
    return null
  }
}

export function certificateTrustOutcome(input: {
  verdict: CertificateTrustVerdict
  nodeVersion: string | null
  defaultRoots: NodeTlsProbeResult['outcome'] | null
  systemRoots: NodeTlsProbeResult['outcome'] | null
  elevated: boolean
  /** 只在 systemTrusted 时有意义；缺省 = 不提客户自己开的窗口。 */
  userWide?: UserWideCertificateTrustState
}): CheckOutcome {
  const state: DiagnosticState = input.verdict === 'outdatedNode' || input.verdict === 'untrusted'
    ? 'fail'
    : input.verdict === 'elevated' ? 'warn' : 'pass'
  const userWide = input.verdict === 'systemTrusted' ? input.userWide : undefined
  return {
    state,
    summary: input.verdict === 'systemTrusted'
      ? systemTrustedSummary(userWide)
      : certificateTrustSummaries[input.verdict],
    details: {
      verdict: input.verdict,
      nodeVersion: input.nodeVersion,
      defaultRoots: input.defaultRoots,
      systemRoots: input.systemRoots,
      elevated: input.elevated,
      ...(userWide ? { userWide } : {}),
    },
  }
}

// 客户自己开的终端、VS Code 里的 Gemini 拿不到星芒给工具加的那一条（第十八批 7）。
function systemTrustedSummary(userWide: UserWideCertificateTrustState | undefined): string {
  const base = certificateTrustSummaries.systemTrusted
  if (userWide === 'available') {
    return `${base}你自己开的终端、VS Code 里的 Gemini 还不认它，可以点「让这台电脑上所有终端都信任」。`
  }
  if (userWide === 'applied') return `${base}你自己开的终端也已经设好，新开的终端就能用。`
  return base
}

/**
 * 「安全证书」说「电脑自己也不认」时，若同一次检查里「星芒 AI 网络」也失败了，
 * 根子多半在网络那一项（门户、公司网关拦截、断网），不在这里再怪一次证书。
 */
export function reconcileCertificateTrustWithNetwork(items: DiagnosticItem[]): DiagnosticItem[] {
  const networkFailed = items.some((item) => item.code === 'XINGMANG_NETWORK' && item.state === 'fail')
  if (!networkFailed) return items
  return items.map((item) => item.code === 'CERTIFICATE_TRUST' && item.details?.verdict === 'untrusted'
    ? { ...item, summary: certificateTrustNetworkFailedSummary }
    : item)
}

/**
 * 「操作系统」一项的结论说人话：Windows 11（64 位）、macOS 15（Apple 芯片）。
 * Windows 11 的内核号仍是 10.0，只能按版本号 22000 起算；macOS 从 Darwin 20
 * （macOS 11）起主版本号差 9，Darwin 25 起苹果跳到 26。认不出就原样给。
 */
export function operatingSystemSummary(platform: NodeJS.Platform, release: string, arch: string): string {
  if (platform === 'win32') {
    const match = release.match(/^(\d+)\.(\d+)\.(\d+)/)
    if (match && match[1] === '10' && match[2] === '0') {
      const name = Number(match[3]) >= 22_000 ? 'Windows 11' : 'Windows 10'
      const bits = arch === 'arm64' ? 'ARM 芯片' : arch === 'ia32' ? '32 位' : '64 位'
      return `${name}（${bits}）`
    }
  }
  if (platform === 'darwin') {
    const darwinMajor = Number(release.match(/^(\d+)\./)?.[1])
    if (Number.isInteger(darwinMajor) && darwinMajor >= 20) {
      const version = darwinMajor >= 25 ? darwinMajor + 1 : darwinMajor - 9
      const chip = arch === 'arm64' ? 'Apple 芯片' : 'Intel 芯片'
      return `macOS ${version}（${chip}）`
    }
  }
  return `${platform} ${release} (${arch})`
}

function countStates(items: DiagnosticItem[]): Record<DiagnosticState, number> {
  return items.reduce<Record<DiagnosticState, number>>((counts, item) => {
    counts[item.state] += 1
    return counts
  }, { pass: 0, warn: 0, fail: 0, error: 0 })
}

async function runIsolatedCheck(
  check: CheckDefinition,
  timeoutMs: number,
  sanitize: (value: string) => string,
): Promise<DiagnosticItem | null> {
  const controller = new AbortController()
  const startedAt = Date.now()
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        const error = new Error('超时')
        error.name = 'DiagnosticTimeoutError'
        reject(error)
      }, timeoutMs)
      timer.unref()
    })
    const { omit, ...outcome } = await Promise.race([Promise.resolve(check.run(controller.signal)), timeout])
    if (omit) return null
    const details = outcome.details
      ? Object.fromEntries(Object.entries(outcome.details).map(([name, detail]) => [
          name,
          typeof detail === 'string' ? sanitize(detail) : detail,
        ]))
      : undefined
    return {
      ...outcome,
      summary: sanitize(outcome.summary),
      details,
      code: check.code,
      title: check.title,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'DiagnosticTimeoutError'
    if (timedOut && check.timeoutOutcome) {
      return {
        ...check.timeoutOutcome,
        code: check.code,
        title: check.title,
        durationMs: Date.now() - startedAt,
      }
    }
    const reason = timedOut
      ? `单项检查超过 ${timeoutMs}ms`
      : sanitize(error instanceof Error ? error.message : String(error))
    return {
      code: check.code,
      title: check.title,
      state: 'error',
      summary: timedOut ? '检查超时' : '检查时发生错误',
      details: { reason },
      durationMs: Date.now() - startedAt,
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 本软件写 Claude 配置时本来就会带上 permissions.defaultMode = 'bypassPermissions'
 * （不这么写，用户每跑一条命令都要按一次确认，而这是本产品替客户省掉的门槛之一）。
 * 所以「文件里是 bypass」单独看不说明任何问题：它多半就是我们自己刚写的。只有确认
 * 这份配置是本软件替当前账号写下的（所有权 `account`）才当成正常状态；来源判不准
 * （用户手改过、别的工具写的、没登录、指纹对不上的 `changed`）时照旧提醒，因为那种
 * 情况下用户确实可能不知道自己的 AI 正在不打招呼地执行命令。
 */
function readClaudeBypass(homeDirectory: string, ownership: ToolConfigOwnership | null): CheckOutcome {
  const configPath = path.join(homeDirectory, '.claude', 'settings.json')
  if (!fs.existsSync(configPath)) return { state: 'pass', summary: '跑命令前会先问你' }
  const parsed = JSON.parse(readBoundedUtf8FileSync(
    configPath,
    MAX_CLAUDE_SETTINGS_BYTES,
    'Claude settings.json',
  )) as unknown
  const permissions = isRecord(parsed) && isRecord(parsed.permissions) ? parsed.permissions : null
  const bypass = permissions?.defaultMode === 'bypassPermissions'
  if (!bypass) return { state: 'pass', summary: '跑命令前会先问你', details: { bypass, managed: false } }
  if (ownership === 'account') {
    return {
      state: 'pass',
      summary: '按当前账号的设置，跑命令前不再逐条问你',
      details: { bypass, managed: true },
    }
  }
  return {
    state: 'warn',
    summary: '被设成了跑命令前不问你，这个设置不是星芒写的。留意它会直接执行命令',
    details: { bypass, managed: false },
  }
}

/**
 * 「磁盘空间」这一项只看两处：CLI 落点（托管目录）和软件数据目录。托管目录在
 * Windows 上要有可信的 ProgramData 才算得出来，算不出就不看这一处；软件数据目录
 * 由宿主给出（诊断自己算不出 Electron 的 userData 在哪）。
 */
function resolveDiskSpaceTargets(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  userDataDirectory?: string,
): readonly { label: string, path: string }[] {
  const targets: { label: string, path: string }[] = []
  try {
    targets.push({ label: '工具安装目录', path: managedCliRoot(env, platform) })
  } catch {
    // 托管目录都算不出来的机器上装不了工具，这一项也就无从说起。
  }
  if (userDataDirectory?.trim()) targets.push({ label: '软件数据目录', path: userDataDirectory })
  return targets
}

export interface RelocatedFolderTarget {
  label: string
  path: string
}

export interface RelocatedFolderFinding {
  /** 被重定向的那一级，已按原样给出。 */
  component: string
  /** 它实际指向哪里；读不出来时为 null。 */
  target: string | null
  /** 受影响的文件夹（去重后按出现顺序）。 */
  labels: string[]
}

/**
 * 搬过去的位置多半带着用户名（D:\Users\alice），而报告的脱敏只认原来的用户目录，
 * 认不出它。客服要知道的只是「搬到了哪块盘」，所以只说盘，不写整条路径。
 */
export function describeRelocationTarget(target: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const drive = /^(?:\\\\[?.]\\)?([A-Za-z]):/.exec(target)?.[1]
    if (drive) return ` ${drive.toUpperCase()} 盘`
    return target.startsWith('\\\\') ? '另一台电脑的共享文件夹' : '别的位置'
  }
  const volume = /^\/Volumes\/([^/]+)/.exec(target)?.[1]
  return volume ? `外接磁盘「${volume}」` : '别的位置'
}

/**
 * 同一级被重定向时（最常见的是整个用户文件夹被搬走），下面几个文件夹全受牵连，
 * 按那一级合并成一条，免得用户读到四遍同一件事。
 */
export function findRelocatedFolders(
  targets: readonly RelocatedFolderTarget[],
  find: (target: string) => ReparseComponent | null,
): RelocatedFolderFinding[] {
  const findings: RelocatedFolderFinding[] = []
  for (const entry of targets) {
    let found: ReparseComponent | null
    try {
      found = find(entry.path)
    } catch {
      continue
    }
    if (!found) continue
    const existing = findings.find((finding) => finding.component === found.component)
    if (existing) {
      if (!existing.labels.includes(entry.label)) existing.labels.push(entry.label)
      continue
    }
    findings.push({ component: found.component, target: found.target, labels: [entry.label] })
  }
  return findings
}

function relocatedFolderTargets(
  userHome: string,
  codexHome: string,
  userDataDirectory: string | undefined,
): RelocatedFolderTarget[] {
  const targets: RelocatedFolderTarget[] = [{ label: '用户文件夹', path: userHome }]
  if (userDataDirectory?.trim()) targets.push({ label: '软件数据文件夹', path: userDataDirectory })
  for (const provider of providerIds) {
    targets.push({
      label: `${cliCatalog[provider].name} 配置文件夹`,
      path: provider === 'codex' ? codexHome : path.join(userHome, providerConfigDirectoryNames[provider]),
    })
  }
  return targets
}

/**
 * 检查页上「打开文件夹」按钮打开哪一个：由主进程按这个名字自己找到路径，
 * 渲染层给不出任何路径（I5）。
 */
export type DiagnosticFolderTarget = 'projects' | 'ai-output'

export function isDiagnosticFolderTarget(value: unknown): value is DiagnosticFolderTarget {
  return value === 'projects' || value === 'ai-output'
}

export function documentsWritabilityOutcome(
  result: DocumentsWritability,
  log: DiagnosticsDependencies['log'],
  sanitizeText: (value: string) => string,
): CheckOutcome {
  if (result.state === 'writable') {
    return { state: 'pass', summary: '能正常写入，新项目和 AI 作品放在「文档」里' }
  }
  if (result.state === 'not-used') {
    return {
      state: 'pass',
      summary: result.why === 'cloud'
        ? '「文档」在 OneDrive 同步里，新项目和 AI 作品放在个人文件夹里，免得拖慢电脑'
        : '没找到「文档」文件夹，新项目和 AI 作品放在个人文件夹里',
    }
  }
  // 原因原文（EPERM 之类，带着路径）只进日志，报告里只有中文结论。
  log?.('warn', 'diagnostics.documents.unwritable', '「文档」文件夹写不进去', {
    kind: result.state,
    raw: sanitizeText(result.reason),
  })
  if (result.state === 'denied') {
    return {
      state: 'warn',
      summary: '「文档」文件夹不让本软件写入，常见原因是 Windows 安全中心开了「受控文件夹访问」，'
        + '或者安全软件开了文档保护。新建的项目和 AI 作品已经改放在个人文件夹里，照常能用。',
      details: { openFolder: 'projects' },
    }
  }
  return {
    state: 'warn',
    summary: '「文档」文件夹这次没写进去，可能是磁盘满了或者文件夹是只读的。'
      + '新建项目和保存 AI 作品可能会失败，清理一些空间后再点「重新检测」。',
  }
}

/**
 * 「电脑芯片」一项的结论。面向小白：只说「ARM 芯片」「ARM 版」「普通电脑用的版本」，
 * 不出现 arm64 / x64 / 模拟层这些词。
 */
export function buildWindowsArmSummary(input: {
  nodeInstalled: boolean
  nodeMachine: WindowsExecutableMachine | null
  appArch: string
}): string {
  const node = !input.nodeInstalled
    ? '这台电脑是 ARM 芯片，装 Node.js 时会自动装 ARM 版，之后装的工具跑起来更快、更省电'
    : input.nodeMachine === 'arm64'
      ? '这台电脑是 ARM 芯片，Node.js 已是 ARM 版，用它装的工具也按 ARM 版运行'
      : input.nodeMachine === 'x64' || input.nodeMachine === 'x86'
        ? '这台电脑是 ARM 芯片，现有的 Node.js 是给普通电脑用的版本，工具能正常用，只是会慢一些、更费电'
        : '这台电脑是 ARM 芯片'
  const app = input.appArch === 'arm64'
    ? ''
    : '。星芒本身暂时只有普通电脑版，在这台电脑上靠系统转换运行，打开时会慢一点'
  return `${node}${app}`
}

export async function runDiagnostics(dependencies: DiagnosticsDependencies): Promise<DiagnosticsReport> {
  const startedAt = Date.now()
  const env = dependencies.env ?? process.env
  const userHome = path.resolve(
    dependencies.providerRoots?.userHome ?? dependencies.homeDirectory ?? os.homedir(),
  )
  const providerRoots = dependencies.providerRoots ?? defaultProviderConfigRoots(userHome, env)
  const codexHome = providerRoots.codexHome
  const displayRoots = { userHome, codexHome }
  const platform = dependencies.platform ?? process.platform
  const arch = dependencies.arch ?? process.arch
  const release = dependencies.release ?? os.release()
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  const inspectProvider = dependencies.inspectProvider
    ?? ((provider, roots) => inspectProviderConfig(provider, roots))
  const relaySite = dependencies.relaySite ?? resolveRelaySite(undefined)
  const providerInspections = new Map<ProviderId, NativeConfigInspection>()
  const knownSecrets: string[] = []
  for (const provider of providerIds) {
    try {
      const inspection = inspectProvider(provider, providerRoots)
      providerInspections.set(provider, inspection)
      if (inspection.apiKey) knownSecrets.push(inspection.apiKey)
    } catch {
      // The isolated provider check will surface its own error.
    }
  }
  // 只看配过的工具：没配过的工具谈不上「盖过当前账号」。管理策略不看工作目录，
  // 所以没选过文件夹时 Claude 那一份照查。
  const workspaceOverrideOutcome = (): CheckOutcome => {
    const workspace = typeof dependencies.workspace === 'string' ? dependencies.workspace.trim() : ''
    const workspaceChecked = workspace !== '' && path.isAbsolute(workspace) && fs.existsSync(workspace)
    const overrides = providerIds.flatMap((provider) => {
      const inspection = providerInspections.get(provider)
      if (!inspection?.exists) return []
      const found = inspectWorkspaceConfigOverrides(provider, workspaceChecked ? workspace : userHome, {
        platform,
        home: userHome,
        codexHome,
        current: {
          baseUrl: inspection.baseUrl,
          apiKey: inspection.apiKey,
          authType: inspection.authType,
          codexAuthMode: inspection.codexAuthMode,
        },
        ...(dependencies.claudeManagedDirectory ? { claudeManagedDirectory: dependencies.claudeManagedDirectory } : {}),
      })
      return workspaceChecked ? found : found.filter((entry) => entry.scope === 'managed')
    })
    const summary = summarizeWorkspaceOverrides(overrides, {
      toolName: (provider) => cliCatalog[provider].name,
      describe: (override) => describeOverride(override, workspaceChecked ? workspace : userHome, userHome, platform),
      workspaceChecked,
    })
    return {
      ...summary,
      details: {
        ...(workspaceChecked ? { workspace: pathForDisplay(workspace, displayRoots) } : {}),
        ...summary.details,
      },
    }
  }
  const sanitize = (value: string) => redactDiagnosticText(value, {
    userHome,
    codexHome,
    sensitiveValues: knownSecrets,
  })
  const scanned = dependencies.recentScan ?? null
  const probeTool = dependencies.inspectTool
    ?? ((tool, signal) => defaultInspectTool(tool, signal, env))
  const inspectTool: typeof probeTool = (tool, signal) => {
    const known = scanned ? scannedToolStatus(scanned, tool) : null
    return known ? Promise.resolve(known) : probeTool(tool, signal)
  }
  const probePowerShell = dependencies.inspectPowerShell
    ?? ((signal) => defaultInspectPowerShell(signal, env))
  // Windows 上 Codex 桌面端那次探测本身就是经 resolveWindowsPowerShellExecutable 选出的
  // PowerShell 跑的：它没失败，就说明这个 PowerShell 找得到、起得来，不必为读一个版本号
  // 再起一次。只有这一种能省；桌面端探测失败或没有扫描结果时照旧自己探。
  const inspectPowerShell = (signal: AbortSignal): Promise<DiagnosticToolStatus> => {
    if (scanned && platform === 'win32' && !scanned.desktopApps.codex.detectionFailed) {
      try {
        const executable = dependencies.resolvePowerShellExecutable?.() ?? resolveWindowsPowerShellExecutable({ env })
        return Promise.resolve({ installed: true, version: null, path: executable })
      } catch { /* 找不到可信路径时交给自己探，让它给出同样的结论。 */ }
    }
    return probePowerShell(signal)
  }
  const probeDesktop = dependencies.inspectCodexDesktop ?? defaultInspectCodexDesktop
  const inspectDesktop = (signal: AbortSignal): Promise<DiagnosticToolStatus> => {
    const known = scanned ? scannedCodexDesktopStatus(scanned) : null
    return known ? Promise.resolve(known) : probeDesktop(signal)
  }
  const inspectAdmin = dependencies.inspectAdministrator ?? defaultInspectAdministrator
  const inspectElevation = dependencies.inspectElevationCapability
    ?? ((signal) => inspectWindowsElevationCapability({ timeoutMs: 3_000, signal }))
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  const paths = dependencies.clashConfigPaths ?? clashCandidates(userHome, env)
  const inspectProxy = dependencies.inspectProxyVariables ?? ((signal) => defaultProxyVariables(env))
  async function inspectAppProxyRouteUnlessAccelerating(): Promise<AppProxyRoute | null> {
    const resolve = dependencies.resolveAppProxy
    if (!resolve) return null
    // 加速开着时系统代理就是星芒自己设的那个，不算「别的程序开着代理」。
    if (await dependencies.inspectAccelerationActive?.().catch(() => false)) return null
    return inspectAppProxyRoute(resolve, relaySite.accountBaseUrl ?? relayStatusProbeUrl(relaySite), dependencies.probeLoopbackProxy ?? probeLoopbackProxy)
  }
  const probeDiskSpace = dependencies.readDiskSpace ?? readDiskSpace
  const probeAiOutput = dependencies.probeAiOutput
  const diskSpaceTargets = resolveDiskSpaceTargets(env, platform, dependencies.userDataDirectory)
  const log = dependencies.log
  const now = dependencies.now ?? (() => new Date())
  const supportedPlatform = platform === 'win32' || platform === 'darwin'

  const checks: CheckDefinition[] = [
    {
      code: 'APP_RUNTIME',
      title: '星芒版本',
      run: () => ({
        state: 'pass',
        summary: `${dependencies.app.name} ${dependencies.app.version}`,
        details: { packaged: dependencies.app.packaged },
      }),
    },
    {
      code: 'OPERATING_SYSTEM',
      title: '操作系统',
      run: () => ({
        state: supportedPlatform ? 'pass' : 'warn',
        summary: operatingSystemSummary(platform, release, arch),
        details: { supported: supportedPlatform },
      }),
    },
    ...(platform === 'win32' && dependencies.windowsProcessor === 'arm64' ? [{
      // 星芒自己只出 x64 安装包，在 ARM 笔记本上靠系统模拟运行；Node.js 和经它装的
      // 工具是哪一版，要看 node.exe 自己，不能看本进程。这一项只做说明，不算故障。
      code: 'WINDOWS_ARM',
      title: '电脑芯片',
      timeoutOutcome: { state: 'pass', summary: '这台电脑是 ARM 芯片' },
      run: async (signal: AbortSignal): Promise<CheckOutcome> => {
        const node = await inspectTool('node', signal)
        const nodeMachine = node.installed && node.path
          ? await (dependencies.inspectExecutableMachine ?? inspectWindowsExecutableMachine)(node.path)
          : null
        return {
          state: 'pass',
          summary: buildWindowsArmSummary({ nodeInstalled: node.installed, nodeMachine, appArch: arch }),
          details: { nodeInstalled: node.installed, nodeMachine, appArch: arch },
        }
      },
    } satisfies CheckDefinition] : []),
    {
      // 这一项问两件事。一是「现在是不是管理员在跑」——是的话仍然建议普通启动。
      // 二是「这个账号需要时能不能提权」：Node.js 是机器级 MSI、Codex 桌面端是
      // Appx，两处都会弹 UAC，普通账号走到那一步才失败，太晚了。macOS 上本程序
      // 从不提权，所以第二问只在 Windows 上做。
      code: 'ADMINISTRATOR',
      title: '运行权限',
      // 软件按不按管理员方式做事，是启动时就定好的，这一项只负责说明。
      // 电脑正忙时它没问完，不该让用户以为出了故障。
      timeoutOutcome: {
        state: 'warn',
        summary: '电脑这会儿比较忙，没来得及确认运行权限。这不影响软件使用，稍后点「重新检测」再看一次',
        details: { timedOut: true },
      },
      run: async (signal): Promise<CheckOutcome> => {
        const windowsExecution = platform === 'win32' ? dependencies.windowsExecution : undefined
        const probeFailure = windowsExecution?.probeFailure
        // 启动时那次探测失败的机器上，这次探测多半也会失败（同样要起 PowerShell）。
        // 那时这一项要说的正是「没问出来」，不能让它自己的失败把原因盖掉。
        const elevated = probeFailure
          ? await Promise.resolve(inspectAdmin(signal)).catch(() => null)
          : await inspectAdmin(signal)
        const probeDetails: Record<string, string | number | null> = probeFailure
          ? {
              executionMode: windowsExecution?.mode ?? null,
              probeFailure: probeFailure.reason,
              probeElapsedMs: windowsExecution?.elapsedMs ?? null,
            }
          : {}
        if (probeFailure && windowsExecution?.mode === 'trusted-only') {
          // 启动时已经看出是高权限、只是细节没问出来，软件按管理员方式处理（从严）。
          // 这时再说「当前以普通用户权限运行」就和实际行为对不上，客服会被带偏。
          return {
            state: 'warn',
            summary: `软件这次是以管理员权限打开的，但没能确认细节，已按管理员方式处理，所以安装和打开工具可能会失败。原因：${describeWindowsExecutionProbeFailure(probeFailure.reason)}。请关掉软件，直接双击重新打开（不要选「以管理员身份运行」）；还不行请在「反馈」页导出报告发给客服`,
            details: { elevated, required: false, ...probeDetails },
          }
        }
        if (elevated && !probeFailure && windowsExecution?.mode === 'same-user') {
          // 令牌是高权限，启动时却确认了不是专门提权打开的（TokenElevationType 为 default）：
          // 系统自带的 Administrator 账号，或整台电脑关了授权弹窗。这就是这个账号平常的
          // 权限，没有「普通启动」可选，软件也已按普通方式做事。国内很多装机版系统默认
          // 登这个账号，一直挂着「建议普通启动」只会让客户以为软件坏了（0.2.8 起就这样）。
          // 0.2.12 起这里曾黄着说「商店装的软件（比如 Codex 桌面端）可能打不开」，是误报，
          // 已撤掉，原因见 windows-store-app-launch.ts 开头。
          return {
            state: 'pass',
            summary: '这台电脑登录的账号本身就带管理员权限，软件每次都是这样打开的，已按平常方式运行，不用处理',
            details: { elevated, required: false, alwaysElevated: true },
          }
        }
        if (elevated) {
          return {
            state: 'warn',
            summary: '当前以管理员权限运行，建议普通启动',
            details: { elevated, required: false, canElevate: true, ...probeDetails },
          }
        }
        if (probeFailure) {
          // 什么都没看出来时按普通用户处理，软件照常能用，不必吓用户；原因只留给客服。
          // 「能不能提权」那一问同样要起 PowerShell，这时不再问。
          return {
            state: 'pass',
            summary: '当前以普通用户权限运行',
            details: { elevated, required: false, canElevate: null, ...probeDetails },
          }
        }
        const capability = platform === 'win32' ? await inspectElevation(signal) : 'unknown'
        if (capability === 'standard') {
          return {
            state: 'warn',
            summary: '当前以普通用户权限运行。这个 Windows 账号不在管理员组，自动安装 Node.js、Codex 桌面端时会要求输入一个管理员账号的密码；公司或学校的电脑请联系 IT 协助，也可以请 IT 先装好 Node.js LTS 再回来点「重新检测」',
            details: { elevated, required: false, canElevate: false },
          }
        }
        return {
          state: 'pass',
          summary: '当前以普通用户权限运行',
          details: { elevated, required: false, canElevate: capability === 'administrator' ? true : null },
        }
      },
    },
    {
      code: 'SYSTEM_POWERSHELL',
      title: '打开工具用的命令窗口',
      run: async (signal) => {
        if (platform !== 'win32') {
          return {
            state: 'pass',
            summary: 'Mac 不需要这一项',
            details: { required: false, installed: null, path: null },
          }
        }
        const status = await inspectPowerShell(signal)
        return {
          state: status.installed ? 'pass' : 'fail',
          summary: status.installed
            ? '可用'
            : '这台电脑上找不到打开工具要用的系统命令窗口，工具没法从星芒打开。请在「反馈」页导出报告发给客服',
          details: {
            required: true,
            installed: status.installed,
            path: pathForDisplay(status.path, displayRoots),
          },
        }
      },
    },
    ...(['node', 'npm', 'python'] as const).map<CheckDefinition>((tool) => ({
      code: `RUNTIME_${tool.toUpperCase()}`,
      title: runtimeCheckTitles[tool],
      run: async (signal) => {
        const status = await inspectTool(tool, signal)
        const required = tool !== 'python'
        return {
          state: status.installed ? 'pass' : required ? 'fail' : 'warn',
          summary: status.installed
            ? (status.version || '已安装')
            : status.xcodeLicensePending ? `未安装。${xcodeLicensePendingNotice('python3')}。`
              : status.commandLineToolsShim ? `未安装。${commandLineToolsShimNotice('python3')}。` : '未安装',
          details: { installed: status.installed, path: pathForDisplay(status.path, displayRoots) },
        }
      },
    })),
    {
      // 官方文档明说 Git for Windows 是 optional，所以缺了最重也只是「需留意」：
      // 把它判成待处理会让一个用不到 bash 的客户以为软件装坏了。要说的是
      // 「缺了会怎样」，文案在 git-runtime.ts（与插件市场那条共用）。
      code: 'RUNTIME_GIT',
      title: 'Git',
      run: async (signal) => {
        const status = await inspectTool('git', signal)
        return {
          state: status.installed ? 'pass' : 'warn',
          summary: status.installed
            ? (status.version || '已安装')
            : status.xcodeLicensePending
              ? `${xcodeLicensePendingNotice('git')}。${gitMissingImpact(platform)}。`
              : status.commandLineToolsShim
                ? `${commandLineToolsShimNotice('git')}。${gitMissingImpact(platform)}。`
                : gitMissingNotice(platform),
          details: {
            required: false,
            installed: status.installed,
            path: pathForDisplay(status.path, displayRoots),
          },
        }
      },
    },
    ...providerIds.map<CheckDefinition>((provider) => ({
      code: `CLI_${provider.toUpperCase()}`,
      title: cliCatalog[provider].name,
      run: async (signal) => {
        const status = await inspectTool(provider, signal)
        return {
          state: status.installed ? 'pass' : 'warn',
          summary: status.installed ? (status.version || '已安装') : '未安装',
          details: { installed: status.installed, path: pathForDisplay(status.path, displayRoots) },
        }
      },
    })),
    {
      code: 'CODEX_DESKTOP',
      title: 'Codex 桌面端',
      run: async (signal) => {
        const status = await inspectDesktop(signal)
        return {
          state: status.installed ? 'pass' : 'warn',
          summary: status.installed ? (status.running ? '已安装并正在运行' : '已安装，当前未运行') : '未安装',
          details: {
            installed: status.installed,
            running: status.running ?? false,
            path: pathOrIdentifierForDisplay(status.path, displayRoots),
          },
        }
      },
    },
    ...providerIds.map<CheckDefinition>((provider) => ({
      code: `PROVIDER_${provider.toUpperCase()}`,
      title: `${cliCatalog[provider].name} 连接设置`,
      run: () => {
        const inspection = providerInspections.get(provider) ?? inspectProvider(provider, providerRoots)
        return providerOutcome(provider, inspection, displayRoots)
      },
    })),
    {
      // 这一项此前把任何失败都交给 runIsolatedCheck 的兜底，于是 DNS 解析不了、
      // 公司网关换掉证书、酒店 Wi-Fi 门户劫持在页面上长得一模一样：一句「检查时
      // 发生错误」，原因还是一行英文，藏在详情抽屉里。归类复用 network-failure.ts
      // （登录页用的是同一份文案），判断只用这里本来就要发的这一次请求。
      code: 'XINGMANG_NETWORK',
      title: '星芒 AI 网络',
      run: async (signal): Promise<CheckOutcome> => {
        if (!fetchImpl) throw new Error('当前运行时不支持 fetch')
        const endpoint = relayStatusProbeUrl(relaySite)
        let response: Response
        let body = ''
        try {
          response = await fetchImpl(endpoint, {
            method: 'GET',
            credentials: 'omit',
            redirect: 'error',
            signal,
            headers: { Accept: 'application/json' },
          })
          // 只有 2xx 才看内容；非 2xx 的错误页不读，免得一张大错误页顶掉下面那句 HTTP 状态。
          if (response.ok) body = await readBoundedResponseText(response, MAX_NETWORK_PROBE_BYTES, '星芒 AI 状态接口')
          else await response.body?.cancel().catch(() => undefined)
        } catch (error) {
          const reason = classifyNetworkFailure(error)
          // 认不出来就照旧抛给兜底。把一个跟网络无关的故障说成「换个网络再试」，
          // 只会让用户白折腾一轮（同 network-failure.ts 的口径）。
          if (!reason) throw error
          log?.('warn', 'diagnostics.network.failed', `星芒 AI 网络检查失败（${reason}）`, {
            endpoint,
            reason,
            raw: sanitize(errorChainText(error)),
          })
          return { state: 'fail', summary: networkFailureMessages[reason], details: { endpoint, reason } }
        }
        // 门户认证页的另一种形态：请求明明成功，回来的却是一张 HTML 登录页。
        // 这时没有异常可归类，只能从内容认出来：这个接口正常时一定回 JSON，
        // 拿到别的（网页、空白）就是中间有东西替服务器答了话。
        if (response.ok && !parsesAsJson(body)) {
          const contentType = response.headers.get('content-type') ?? ''
          log?.('warn', 'diagnostics.network.failed', '星芒 AI 网络检查被拦截（intercepted）', {
            endpoint,
            reason: 'intercepted',
            status: response.status,
            contentType,
          })
          return {
            state: 'fail',
            summary: networkFailureMessages.intercepted,
            details: { endpoint, reason: 'intercepted', status: response.status },
          }
        }
        if (!response.ok) {
          log?.('warn', 'diagnostics.network.failed', `星芒 AI 网络检查返回 HTTP ${response.status}`, {
            endpoint,
            status: response.status,
          })
          // 网络本身是通的，所以不该说「换个网络」：这是服务端那一侧的事。
          return {
            state: 'fail',
            summary: `网络能连通，但星芒 AI 返回 HTTP ${response.status}，多半是服务端暂时的问题，请稍后再试。`,
            details: { endpoint, status: response.status },
          }
        }
        // 这一次请求已经拿到了响应头，Date 就在里面：顺手和本机时间比一次，
        // 把「证书日期对不上」的真正源头提前抓出来，不新增任何请求。
        const skewMs = clockSkewMs(response.headers.get('date'), now())
        if (skewMs !== null && Math.abs(skewMs) > MAX_CLOCK_SKEW_MS) {
          const minutes = Math.round(Math.abs(skewMs) / 60_000)
          return {
            state: 'warn',
            summary: `能连上星芒服务，但这台电脑的系统时间与服务器相差约 ${minutes} 分钟，`
              + `可能让登录、安装、更新卡在证书校验这一步。${clockSyncGuidance(platform)}`,
            details: { endpoint, status: response.status, clockSkewMinutes: Math.round(skewMs / 60_000) },
          }
        }
        const accelerating = await dependencies.inspectAccelerationActive?.().catch(() => false) ?? false
        return {
          state: 'pass',
          // 状态码留在 details 里给导出报告，结论只说人话。
          summary: accelerating ? '能连上星芒服务（开着加速时也直接连，不绕加速线路）' : '能连上星芒服务',
          details: accelerating ? { endpoint, status: response.status, route: 'direct' } : { endpoint, status: response.status },
        }
      },
    },
    {
      // 公司的上网审计、安全软件的网页扫描会换掉所有网页的证书。星芒自己走 Chromium
      // 不受影响（上面那一项永远是绿的），工具那一侧走 Node.js，要看它认不认。
      // 只做说明、不决定软件行为，所以超时不亮红灯。
      code: 'CERTIFICATE_TRUST',
      title: '安全证书',
      timeoutOutcome: {
        state: 'pass',
        summary: '电脑这会儿比较忙，安全证书这一项没来得及查完，稍后点「重新检测」再看一次。',
        details: { timedOut: true },
      },
      run: async (signal): Promise<CheckOutcome> => {
        const node = await inspectTool('node', signal)
        if (!node.installed || !node.path) return { state: 'pass', summary: '', omit: true }
        // 以管理员身份打开时工具那一侧刻意不带这个开关（trustedCommandEnvironment），
        // 也就不替它起进程去量：结论只有一个。
        if (platform === 'win32' && dependencies.windowsExecution?.mode === 'trusted-only') {
          return certificateTrustOutcome({
            verdict: 'elevated',
            nodeVersion: node.version,
            defaultRoots: null,
            systemRoots: null,
            elevated: true,
          })
        }
        const target = certificateProbeTarget(relayStatusProbeUrl(relaySite))
        if (!target) return { state: 'pass', summary: '', omit: true }
        const probe = dependencies.probeNodeTls ?? ((input, probeSignal) => defaultProbeNodeTls(input, probeSignal, env))
        const [withoutSwitch, withSwitch] = await Promise.all([
          probe({ nodePath: node.path, ...target, useSystemRoots: false }, signal),
          probe({ nodePath: node.path, ...target, useSystemRoots: true }, signal),
        ])
        const nodeVersion = withoutSwitch.version ?? withSwitch.version ?? node.version
        const verdict = certificateTrustVerdict({
          defaultRoots: withoutSwitch.outcome,
          systemRoots: withSwitch.outcome,
          nodeVersion,
        })
        const userWide = verdict === 'systemTrusted' && platform === 'win32'
          ? dependencies.inspectUserWideCertificateTrust?.()
          : undefined
        return certificateTrustOutcome({
          verdict,
          nodeVersion,
          defaultRoots: withoutSwitch.outcome,
          systemRoots: withSwitch.outcome,
          elevated: false,
          userWide,
        })
      },
    },
    {
      // 8G 内存的机器通常也是 128/256G 的小硬盘，C 盘剩几百兆很常见，而装一个
      // CLI 的峰值要两份空间（临时目录装完整份再原子替换）。装到一半才报
      // ENOSPC 是最难受的失败方式，所以这一项的用处是「还没出事先说一声」。
      code: 'DISK_SPACE',
      title: '磁盘空间',
      run: async () => {
        const readings = mergeSameDeviceReadings(
          (await Promise.all(diskSpaceTargets.map(async (entry) => {
            const reading = await probeDiskSpace(entry.path)
            return reading ? { ...entry, reading } : null
          })))
            .filter((entry): entry is { label: string, path: string, reading: DiskSpaceReading } => entry !== null)
            .map((entry) => ({ ...entry.reading, label: entry.label })),
        )
        // 读不到不算失败：网络盘、交接点上 statfs 本来就可能不给数字，为此报一
        // 条待处理只会让人去修一个没坏的东西。
        if (!readings.length) {
          return {
            state: 'warn',
            summary: '未能读取磁盘剩余空间，这一项这次跳过',
            details: { measured: 0 },
          }
        }
        const tightest = readings.reduce(
          (left, right) => (right.availableBytes < left.availableBytes ? right : left),
        )
        const state: DiagnosticState = tightest.availableBytes < installMinimumFreeBytes
          ? 'fail'
          : tightest.availableBytes < lowDiskSpaceBytes ? 'warn' : 'pass'
        const summary = readings
          .map((reading) => `${reading.label}所在磁盘剩余 ${formatFreeSpace(reading.availableBytes)}`)
          .join('；')
        const details: Record<string, boolean | number | string | null> = { measured: readings.length }
        for (const [index, reading] of readings.entries()) {
          details[`disk${index + 1}`] = `${reading.label}：${formatFreeSpace(reading.availableBytes)} / `
            + `${formatFreeSpace(reading.totalBytes)}`
          details[`path${index + 1}`] = pathForDisplay(reading.measuredPath, displayRoots)
        }
        return {
          state,
          summary: state === 'fail'
            ? `${summary}，已经装不下新工具了，请清理后再安装或更新`
            : state === 'warn'
              ? `${summary}，空间偏紧，安装或更新工具前建议先清理一些`
              : summary,
          details,
        }
      },
    },
    // 受控文件夹访问、安全软件的文档保护会让「文档」只读，新项目和 AI 作品默认都在
    // 它下面。只在 Windows 上查：Mac 的新项目本来就放个人文件夹（#587），往「文稿」里
    // 试写还会平白弹一次系统的访问询问。
    ...(platform === 'win32' && dependencies.documentsDirectory !== undefined ? [{
      code: 'DOCUMENTS_WRITABLE',
      title: '「文档」文件夹能不能写',
      run: (): CheckOutcome => {
        const inspect = dependencies.inspectDocuments ?? inspectDocumentsWritability
        const result = inspect(dependencies.documentsDirectory ?? null, { platform, home: userHome, env })
        return documentsWritabilityOutcome(result, log, sanitize)
      },
    }] : []),
    // 写不进时生成前就会拦下、不会扣费，而且只影响用 AI 生图、生视频的人，所以这里
    // 标「需留意」而不是「待处理」：不为它在每次开机时弹提示，检查页照实标黄。
    ...(probeAiOutput ? [{
      code: 'AI_OUTPUT',
      title: 'AI 作品保存位置',
      run: async (): Promise<CheckOutcome> => {
        try {
          await probeAiOutput()
        } catch (error) {
          log?.('warn', 'diagnostics.ai-output.unwritable', 'AI 作品保存位置写不进去', {
            raw: sanitize(errorChainText(error)),
          })
          return {
            state: 'warn',
            summary: '保存位置写不进去。用 AI 生成图片或视频时，软件会在扣费前先拦下来；'
              + '可以在画布里新建一个项目、给它选一个自己的文件夹，在那里生成就能存下来。',
          }
        }
        const placement = dependencies.aiOutputPlacement?.() ?? null
        if (placement?.movedFromDocuments) {
          return {
            state: 'pass',
            summary: '「文档」文件夹不让写，AI 生成的图片和视频改存在个人文件夹里的 XingmangAI'
              + (placement.earlierWorksLeftInDocuments ? '。以前的作品还在「文档」里的 XingmangAI，没有搬动' : ''),
            details: { openFolder: 'ai-output' },
          }
        }
        return { state: 'pass', summary: 'AI 生成的图片和视频能正常保存' }
      },
    }] : []),
    // 杀毒软件隔离了加速内核时，加速页以前只写「线路准备中」，客户会一直等下去。
    // 这里说同一句话；读文件是启动时做的，这一项只报告结果、不再读一遍几十 MB 的内核。
    // 标黄不标红（同 AI_OUTPUT）：只影响用加速的人，不为它在每次开机时弹「需要处理」。
    ...(dependencies.accelerationBundle ? [{
      code: 'ACCELERATION_BUNDLE',
      title: '加速功能',
      run: (): CheckOutcome => dependencies.accelerationBundle === 'damaged'
        ? { state: 'warn', summary: accelerationBundleDamagedSummary }
        : { state: 'pass', summary: '加速用的文件完好' },
    }] : []),
    {
      // 「C 盘搬家」工具或 mklink /J 把用户文件夹、软件数据文件夹挪到别的盘之后，
      // 路径上多出一级目录联接。普通权限运行时，用户文件夹里、搬到本机硬盘的联接
      // 会被跟过去读写（relocated-folders.ts），这一项只报告一句「搬到了哪」；
      // 仍被写入校验（I8）拒绝的（管理员身份运行、网络盘、共享位置）才算失败。
      code: 'FOLDER_RELOCATED',
      title: '文件夹位置',
      run: (): CheckOutcome => {
        const find = dependencies.findReparseComponent ?? findReparseComponent
        const resolveRelocated = dependencies.resolveRelocatedPath ?? resolveRelocatedPath
        const targets = relocatedFolderTargets(userHome, codexHome, dependencies.userDataDirectory)
        const relocated = findRelocatedFolders(targets, find)
        if (!relocated.length) {
          return {
            state: 'pass',
            summary: '软件要用到的文件夹都在原来的位置',
            details: { relocated: 0 },
          }
        }
        const findings = findRelocatedFolders(targets, (target) => find(resolveRelocated(target)))
        if (!findings.length) {
          const moved = relocated.map((finding) => `${finding.labels.join('、')}${finding.target
            ? `在${describeRelocationTarget(finding.target, platform)}`
            : '在别的位置'}`)
          return {
            state: 'pass',
            summary: `${moved.join('；')}，软件会跟过去读写，能正常使用`,
            details: { relocated: relocated.length, followed: true },
          }
        }
        const elevated = platform === 'win32' && dependencies.windowsExecution?.mode === 'trusted-only'
        const described = findings.map((finding) => `${finding.labels.join('、')}${finding.target
          ? `被搬到了${describeRelocationTarget(finding.target, platform)}`
          : '被搬走了，但读不出它现在在哪里'}`)
        const hint = platform === 'win32' ? '（常见于用过「C 盘搬家」一类的工具）' : ''
        const details: Record<string, boolean | number | string | null> = { relocated: findings.length }
        for (const [index, finding] of findings.entries()) {
          details[`folder${index + 1}`] = finding.labels.join('、')
          details[`from${index + 1}`] = finding.component
          details[`to${index + 1}`] = finding.target ? describeRelocationTarget(finding.target, platform).trim() : null
        }
        if (elevated) details.elevated = true
        return {
          state: 'fail',
          summary: elevated
            ? `${described.join('；')}${hint}。软件现在是用管理员身份运行的，为了安全不往被搬过的文件夹里写东西，`
              + '所以写入 Key、保存设置、记录日志都可能失败。关掉软件，直接双击打开（不要选「以管理员身份运行」）就能恢复'
            : `${described.join('；')}${hint}。为了安全，软件不往被搬过的文件夹里写东西，`
              + '所以写入 Key、保存设置、记录日志都可能失败。把文件夹搬回原来的位置就能恢复；'
              + '搬不回来请在「反馈」页导出报告发给客服',
          details,
        }
      },
    },
    {
      code: 'CLASH_VERGE_TUN',
      title: '代理软件的全局接管模式',
      run: () => {
        let detectedPath: string | null = null
        for (const candidate of paths) {
          if (!fs.existsSync(candidate)) continue
          detectedPath ??= candidate
          const enabled = parseClashTunConfig(readBoundedUtf8FileSync(
            candidate,
            MAX_CLASH_CONFIG_BYTES,
            'Clash 配置文件',
          ))
          if (enabled) {
            return {
              state: 'warn',
              summary: 'Clash Verge Rev 开着全局接管模式，可能让工具连不上。用不到时先把它关掉',
              details: { enabled: true, path: pathForDisplay(candidate, displayRoots) },
            }
          }
        }
        return {
          state: 'pass',
          summary: detectedPath ? 'Clash Verge Rev 没开全局接管模式' : '没发现 Clash Verge Rev',
          details: { enabled: false, path: pathForDisplay(detectedPath, displayRoots) },
        }
      },
    },
    {
      code: 'PROXY_ENVIRONMENT',
      title: '电脑里的代理设置',
      run: async (signal) => {
        const [variables, route] = await Promise.all([
          platform === 'win32'
            ? windowsProxySettingsOutcome(
              env,
              dependencies.probeLoopbackProxy ?? probeLoopbackProxy,
              dependencies.readProxyScopes ?? (() => readWindowsProxyScopes()),
            )
            : otherProxySettingsOutcome(await inspectProxy(signal)),
          inspectAppProxyRouteUnlessAccelerating(),
        ])
        return withAppProxyRoute(variables, route)
      },
    },
    {
      code: 'PROVIDER_ENVIRONMENT_OVERRIDE',
      title: '电脑里另外设过的工具地址或密钥',
      run: () => withIgnoredCodexHome(
        withEnvironmentOverrideFix(
          environmentOverrideOutcome(collectEnvironmentOverrides(env, relaySite.providerBaseUrls, userHome)),
          platform === 'win32' && clearableEnvironmentOverrides(env, relaySite.providerBaseUrls, userHome).length > 0,
        ),
        inspectIgnoredCodexHome(dependencies.ignoredCodexHome, providerRoots, providerInspections.get('codex')),
      ),
    },
    {
      code: 'WORKSPACE_CONFIG_OVERRIDE',
      title: '项目文件夹里的设置',
      run: () => workspaceOverrideOutcome(),
    },
    {
      code: 'CODEX_DOTENV',
      title: 'Codex 文件夹里的额外设置',
      run: () => {
        const envPath = path.join(codexHome, '.env')
        const exists = fs.existsSync(envPath)
        const details: Record<string, boolean | number | string | null> = { exists, path: pathForDisplay(envPath, displayRoots) }
        // 有这份文件时给「挪开这份设置」：改个名留在原处，不删（diagnostic-fixes.ts）。
        if (exists) details.fix = 'set-aside-codex-dotenv'
        return {
          state: exists ? 'warn' : 'pass',
          summary: exists ? 'Codex 文件夹里有一份额外设置，可能盖过当前账号的连接' : 'Codex 文件夹里没有额外设置',
          details,
        }
      },
    },
    {
      code: 'CLAUDE_BYPASS_PERMISSIONS',
      title: 'Claude Code 跑命令前要不要先问你',
      run: () => readClaudeBypass(userHome, dependencies.readClaudeConfigOwnership?.() ?? null),
    },
  ]

  const items = reconcileCertificateTrustWithNetwork(
    (await Promise.all(checks.map((check) => runIsolatedCheck(check, timeoutMs, sanitize))))
      .filter((item): item is DiagnosticItem => item !== null),
  )
  return {
    version: 1,
    generatedAt: now().toISOString(),
    durationMs: Date.now() - startedAt,
    counts: countStates(items),
    items,
  }
}
