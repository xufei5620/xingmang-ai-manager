import type { ProviderId } from './catalog'
import type { IgnoredCodexHome, ProviderConfigRoots } from './codex-home'
import {
  createDiagnosticsContext,
  diagnosticsScanReuseMs,
  scannedCodexDesktopStatus,
  scannedToolStatus,
} from './diagnostics-context'
import { createDiagnosticsExport, redactDiagnosticText } from './diagnostics-redaction'
import { buildSystemChecks, buildWindowsArmSummary, operatingSystemSummary } from './diagnostics-system-checks'
import {
  buildDiagnosticsCodexDesktopProbeScript,
  buildToolChecks,
  diagnosticsCodexDesktopProbeModules,
  diagnosticsCodexDesktopProbeTimeoutMs,
  reconcileNodeRuntimeWithClis,
} from './diagnostics-tool-checks'
import {
  buildNetworkChecks,
  buildProxyChecks,
  certificateProbeTarget,
  certificateTrustOutcome,
  clockSkewMs,
  clockSyncGuidance,
  describeRelayRouteChange,
  parseClashTunConfig,
  reconcileCertificateTrustWithNetwork,
  relayNetworkPassSummary,
  relaySiteStatusProbeUrls,
  relayStatusProbeUrl,
  windowsProxySettingsOutcome,
} from './diagnostics-network-checks'
import { buildDnsChecks } from './diagnostics-dns-check'
import { buildProxySoftwareChecks } from './diagnostics-proxy-software-check'
import {
  buildStorageChecks,
  describeRelocationTarget,
  documentsWritabilityOutcome,
  findRelocatedFolders,
  type RelocatedFolderFinding,
  type RelocatedFolderTarget,
} from './diagnostics-storage-checks'
import {
  buildOverrideChecks,
  clearableEnvironmentOverrides,
  environmentAccountBaseUrls,
  environmentOverrideNames,
  homeFolderLeftoversOutcome,
} from './diagnostics-override-checks'
import type { NativeConfigInspection } from './config-files'
import { readDiskSpace } from './disk-space'
import type { LinuxTerminalCandidate } from './linux-terminal'
import type { NodeTlsProbeResult } from './certificate-trust-probe'
import type { RelayRouteChange } from './relay-route-controller'
import type { RelayEndpointId, RelaySite } from './relay-sites'
import type { RouteStatus } from './route-status-file'
import type { ReparseComponent } from './safe-local-data'
import type { DocumentsWritability } from './documents-fallback'
import type { StarterWorkspaceLocationContext } from './starter-workspace'
import type { LoopbackProbe, ProxyVariableScopes } from './stale-proxy-environment'
import type { ToolConfigOwnership } from './tool-config-ownership'
import type { SystemSnapshot } from './system-service'
import type { WindowsExecutableMachine, WindowsProcessorArchitecture } from './windows-processor'
import type { WindowsCliExecutionModeResolution, WindowsElevationCapability } from './windows-elevation'

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
  /**
   * Mac 上本进程是不是经 Rosetta 转换运行（app.runningUnderARM64Translation）。Apple 芯片上装了
   * Intel 版时 arch 是 x64，「操作系统」一项不能照它说成 Intel 处理器（#1155）。缺省 = 不是。
   */
  macRosetta?: boolean
  release?: string
  /** Linux 发行版名字；缺省时在 Linux 上读 /etc/os-release。 */
  readLinuxSystemName?: () => Promise<string | null>
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  now?: () => Date
  inspectAdministrator?: (signal: AbortSignal) => Promise<boolean>
  /** 当前 Windows 账号能不能自己提权（不是「现在是不是管理员」，见 windows-elevation.ts）。 */
  inspectElevationCapability?: (signal: AbortSignal) => Promise<WindowsElevationCapability>
  inspectPowerShell?: (signal: AbortSignal) => Promise<DiagnosticToolStatus>
  /**
   * Linux 上「打开工具用的命令窗口」一项：点「打开」时会用哪个命令窗口程序（linux-terminal.ts）。
   * 缺省 = 按这台电脑的 PATH 和桌面现找；测试用它造「装了哪个」「一个都没有」。
   */
  findLinuxTerminal?: () => LinuxTerminalCandidate | null
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
   * 「星芒 AI 网络」一项：relaySite 这会儿走的线路（relay-route-controller.ts）。给了就在结论里写明
   * 用的是直连还是默认线路；选「自动」、这会儿走先走的那条却没连上时，改查同一个站的备用那条，查通了
   * 算能连上、说清已经自动改走备用那条，并把先走那条的失败报给线路那边。缺省 = 不提线路（旧行为）。
   * 「电脑里另外设过的工具地址或密钥」也看它：选「自动」时指着默认线路的地址也算指向当前账号
   * （environmentAccountBaseUrls）。缺省 = 只认 relaySite 那一份。
   */
  relayRoute?: DiagnosticsRelayRoute
  /**
   * xm 三线路：各工具「连接设置」那几项、「电脑里另外设过的工具地址或密钥」比的是写进工具配置的那条线路
   * （工具线路），它可以和「星芒 AI 网络」用的那条（应用线路）不一样。缺省 = 和 relaySite、relayRoute
   * 同一份（旧行为，历史账号也一直是这样）。
   */
  toolRoute?: {
    site: RelaySite
    route?: Pick<DiagnosticsRelayRoute, 'line' | 'automatic' | 'settled' | 'primarySite'>
    /**
     * 工具线路这会儿的情况（C16）：最近一次切换和原因、线路状态文件读不读得到和 incident、两条线路
     * 最近一次照工具的连法探测的结果。只写进「星芒 AI 网络」那一项导出的报告，检查页的详情不摆；
     * 不带地址。
     */
    report?(): Record<string, string>
  }
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
   * 「别的代理软件」一项问系统代理对星芒这个地址生不生效：宿主交给只跟随系统代理的那个会话的
   * `resolveProxy`（network-routes.ts 的 resolveSystemProxy），系统设置里勾的 HTTP / HTTPS / SOCKS /
   * 自动代理配置都已经算进去，不起任何外部命令。不问默认会话：星芒自己改了直连以后它答 DIRECT，
   * 会把一个没在运行的代理说成没有。下面三样都给了才有这一项；缺省 = 没有这一项。
   */
  resolveSystemProxy?: (url: string) => Promise<string>
  /** 「别的代理软件」：只经系统代理的会话发请求（network-routes.ts 的 systemProxyFetch）。 */
  fetchThroughSystemProxy?: typeof globalThis.fetch
  /** 「别的代理软件」：只直接连的会话发请求（network-routes.ts 的 siteDirectFetch）。 */
  fetchDirect?: typeof globalThis.fetch
  /**
   * 「查网址的服务（DNS）」一项：用电脑自己的 DNS、公共 DNS 各查一个域名（diagnostics-dns-check.ts 的
   * lookupWithSystemDns、lookupWithPublicDns）。两样都给了才有这一项；缺省 = 没有这一项，测试不会对外发查询。
   */
  lookupHost?: (host: string) => Promise<string[]>
  lookupHostWithPublicDns?: (host: string) => Promise<string[]>
  /** 上次读到的线路状态文件（不为检查专门去读）：星芒账号线路2 的地址对不对看它。缺省 = 没有。 */
  routeStatus?: () => RouteStatus | null
  /**
   * 「安全证书」一项用电脑上的 Node.js 做一次 TLS 握手（certificate-trust-probe.ts）。
   * 缺省 = 真的起 `node -e`；测试用它造「公司证书」「Node 太旧」这些情况。
   */
  probeNodeTls?: (input: NodeTlsProbeInput, signal: AbortSignal) => Promise<NodeTlsProbeResult>
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
  aiOutputPlacement?: () => { movedFromDocuments: boolean, earlierWorksLeftInDocuments: boolean, earlierWorksLeftInSyncedDocuments?: 'onedrive' | 'icloud' } | null
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

// 定义随用它的上下文搬进了 diagnostics-context.ts（#1070 第 9 步），这里照旧导出。
export { diagnosticsScanReuseMs, scannedCodexDesktopStatus, scannedToolStatus }

export interface CheckOutcome {
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

export interface CheckDefinition {
  code: string
  title: string
  run: (signal: AbortSignal) => Promise<CheckOutcome> | CheckOutcome
  /**
   * 超时就给这个结论，不给笼统的「检查超时」。只说明情况、不决定软件行为的项给一句不亮红的
   * 提醒。给函数就在超时那一刻再看卡在哪一步，返回 undefined 照旧「检查超时」：「星芒 AI 网络」
   * 只有一直等不到回话才算连不上。
   */
  timeoutOutcome?: CheckOutcome | (() => CheckOutcome | undefined)
}

export interface DiagnosticsRelayRoute {
  line: RelayEndpointId
  /** 选的是「自动」：只有它会在先走的那条连不上时改走备用那条。 */
  automatic: boolean
  /** 「自动」定下来了没有；定在备用那条上 = 先走的那条上次没连上，已经退回。 */
  settled: boolean
  /** 同一个站默认线路上的那一份。 */
  primarySite: RelaySite
  /**
   * 「自动」先走哪条，和备用那条上的那一份（先走的那条没查通时改查它）：星芒账号先走直连、备用默认线路，
   * 历史账号先走默认线路、备用直连（relay-sites.ts 的 relayAutoPreferredLines）。缺省 = 星芒账号那样，
   * 备用的就是 primarySite。
   */
  preferredLine?: RelayEndpointId
  backupSite?: RelaySite
  /**
   * 「自动」这会儿走的那条（line）上没查通，报给线路那边查一轮（relay-route-controller.ts 的 reportFailure）：
   * 先走的那条照三次的规矩查，已经退到备用那条就两条一起查（#1053）。
   */
  reportLineFailure(reason: string): void
  /** 「自动」最近一次换线路（relay-route-controller.ts 的 lastChange），详情里说给客户和客服听。 */
  lastChange?: RelayRouteChange | null
}

const DEFAULT_CHECK_TIMEOUT_MS = 8_000

// 脱敏和导出搬进了 diagnostics-redaction.ts（#1070 第 9 步），这里照旧导出。
export { createDiagnosticsExport, redactDiagnosticText }

// 「系统与权限」那几项搬进了 diagnostics-system-checks.ts（#1070 第 9 步），这里照旧导出。
export { buildWindowsArmSummary, operatingSystemSummary }

// 「运行环境与工具」那几项搬进了 diagnostics-tool-checks.ts（#1070 第 9 步），这里照旧导出。
export {
  buildDiagnosticsCodexDesktopProbeScript,
  diagnosticsCodexDesktopProbeModules,
  diagnosticsCodexDesktopProbeTimeoutMs,
  reconcileNodeRuntimeWithClis,
}

// 「网络与代理」那几项搬进了 diagnostics-network-checks.ts（#1070 第 9 步），这里照旧导出。
export {
  certificateProbeTarget,
  certificateTrustOutcome,
  clockSkewMs,
  clockSyncGuidance,
  describeRelayRouteChange,
  parseClashTunConfig,
  reconcileCertificateTrustWithNetwork,
  relayNetworkPassSummary,
  relaySiteStatusProbeUrls,
  relayStatusProbeUrl,
  windowsProxySettingsOutcome,
}

// 「磁盘与文件夹」那几项搬进了 diagnostics-storage-checks.ts（#1070 第 9 步），这里照旧导出。
export { describeRelocationTarget, documentsWritabilityOutcome, findRelocatedFolders }
export type { RelocatedFolderFinding, RelocatedFolderTarget }

// 「电脑里另外设过的设置」那几项搬进了 diagnostics-override-checks.ts（#1070 第 9 步），这里照旧导出。
export { clearableEnvironmentOverrides, environmentAccountBaseUrls, environmentOverrideNames, homeFolderLeftoversOutcome }

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
    const timeoutOutcome = timedOut
      ? typeof check.timeoutOutcome === 'function' ? check.timeoutOutcome() : check.timeoutOutcome
      : undefined
    if (timeoutOutcome) {
      return {
        ...timeoutOutcome,
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
 * 检查页上「打开文件夹」按钮打开哪一个：由主进程按这个名字自己找到路径，
 * 渲染层给不出任何路径（I5）。
 */
export type DiagnosticFolderTarget = 'projects' | 'ai-output'

export function isDiagnosticFolderTarget(value: unknown): value is DiagnosticFolderTarget {
  return value === 'projects' || value === 'ai-output'
}

export async function runDiagnostics(dependencies: DiagnosticsDependencies): Promise<DiagnosticsReport> {
  const startedAt = Date.now()
  const context = createDiagnosticsContext(dependencies)
  const { sanitize, now } = context
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS

  const checks: CheckDefinition[] = [
    ...buildSystemChecks(context),
    ...buildToolChecks(context),
    ...buildNetworkChecks(context),
    ...buildDnsChecks(context),
    ...buildStorageChecks(context),
    ...buildProxyChecks(context),
    ...buildProxySoftwareChecks(context),
    ...buildOverrideChecks(context),
  ]

  const items = reconcileNodeRuntimeWithClis(reconcileCertificateTrustWithNetwork(
    (await Promise.all(checks.map((check) => runIsolatedCheck(check, timeoutMs, sanitize))))
      .filter((item): item is DiagnosticItem => item !== null),
  ))
  return {
    version: 1,
    generatedAt: now().toISOString(),
    durationMs: Date.now() - startedAt,
    counts: countStates(items),
    items,
  }
}
