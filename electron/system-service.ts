import { spawn } from 'node:child_process'
import { type AppSettings, type AppSettingsUpdate, AppSettingsStore, type RelayToolRouteStatus } from './app-settings'
import type { RuntimeLogLike } from './account-session-store'
import type { NodeRuntimeInstallRequest } from './ipc-contract'
import type { LoopbackProbe } from './stale-proxy-environment'
import type { ProviderId } from './catalog'
import {
  type CliVersionAdvice,
} from './cli-verified-versions'
import type { ProviderConfigRoots } from './codex-home'
import {
  findExecutable,
  runCommand,
} from './command-runner'
import type { RunningToolsReport } from './running-tools'
import type { ToolModelCheck } from './tool-model-check'
import type { CliModelHints } from './cli-model-defaults'
import {
  describeNpmCommandFailure,
  describeNpmUninstallFailure,
  isMachineBoundNpmFailure,
  isNpmExitFailure,
} from './npm-command-failure'
import {
  npmInstallRegistries,
  npmPackageLatestUrl,
  npmPackageVersionUrl,
  npmRegistryLabel,
} from './npm-registry'
import { grokInstallStrategyFor } from './platform-capabilities'
import { activateCodexDesktopWithCdp, injectCodexDesktopChineseLocale, withCodexDesktopCdpFailureReport, withCodexDesktopLocaleFailureReport } from './codex-desktop-cdp'
import type { ClaudeDesktopLaunchContext } from './claude-desktop-acceleration'
import type { CodexDesktopStartupRoute } from './codex-desktop-startup-route'
import {
  createCodexDesktopService,
  type CodexDesktopInstallProgress,
  type CodexDesktopInstallResult,
} from './codex-desktop-service'
import {
  type CodexDesktopCatalogProbe,
} from './codex-model-catalog'
import {
  inspectOfficialLogin,
  inspectProviderConfig,
  saveProviderConfig,
  switchProviderToOfficialAccount,
  type CodexWorkspacePermissionStatus,
  type CodexWorkspacePermissionWriteResult,
  type NativeConfigSaveMode,
  type NativeConfigSummary,
  type RetiredGeminiIntegrations,
} from './config-files'
import {
  fetchOfficialChatGptUsage,
  type OfficialChatGptAccount,
  type OfficialChatGptWindow,
} from './official-account-usage'
import {
  resolveCliCommand,
  resolveCliInstallation,
  type CliInstallDisplaySource,
  type CliLaunchMode,
  type CliUninstallCapability,
} from './tool-installation'
export type { CliLaunchMode } from './tool-installation'
export type { GrokInstallStrategy } from './platform-capabilities'
import type { NodeVersionStatus } from './versions'
import {
  inspectWindowsRestartRequired,
  installNodeRuntime as installNodeRuntimeLts,
  type NodeRuntimeInstallResult,
} from './node-runtime'
import {
  inspectInstalledPythonRuntime,
  installPythonRuntime as installPythonRuntime312,
  type PythonRuntimeInstallResult,
} from './python-runtime'
import {
  installGitRuntime as installGitForWindows,
  type GitRuntimeInstallResult,
} from './git-runtime-install'
import type { InstallationQueueSnapshot } from './installation-queue'
import type { QueuedAccountWork } from './account-work-gate'
import type { DownloadAccelerationLease } from './download-acceleration'
import {
  type InstallCancellationOutcome,
} from './install-cancellation'
import type { ToolTemplateFillResult } from './tool-config-ownership'
import type { StoredManagedCliKey } from './managed-cli-key-store'
import type { ExternalClientKeySource } from './external-client-ownership'
import {
  launchCliPowerShell,
  type WindowsCliExecutionMode,
} from './windows-elevation'
import {
  type InstallLeftoverLocation,
  type InstallLeftoverSweepResult,
} from './install-leftovers'
import { resolveWindowsMachinePaths } from './windows-machine-paths'
import {
  inspectWindowsExecutableMachine,
  type WindowsProcessorArchitecture,
} from './windows-processor'
import type { UserPathOutcome, UserPathRemoval } from './windows-cli-shell-access'
import type { MacosShellProfileOutcome } from './macos-shell-profile'
import type { LinuxTerminalCommandsReason, LinuxTerminalCommandsResult } from './linux-shell-profile'
import { readDiskSpace } from './disk-space'
import {
  type CodexDesktopLocale,
  type CodexDesktopLocaleResult,
  type CodexDesktopLocaleStatus,
} from './codex-desktop-locale'
import { reloadNetworkProxyConfiguration } from './network-location-cache'
import { launchMacosTerminal } from './macos-platform'
import { launchLinuxTerminal } from './linux-terminal'
import {
  type RelayEndpointRoutingSnapshot,
  type RelayRouteLines,
  type RelayRouteSiteId,
} from './relay-sites'
import type { RelayRouteChange } from './relay-route-controller'
import { inspectMacosCodexApp } from './macos-codex-app'
import {
  installMacGitRuntime,
} from './macos-git-install'
import {
  type ExternalToolConfigOptions,
  type ExternalToolId,
} from './external-tool-config'
import { type DesktopAppUpdateRequest, type ExternalClientConfigResult, type ExternalClientSourceSwitchResult, type ExternalClientStatus, type ExternalClientRuntimeStatus } from './external-client-contract'
import { createExternalClientRuntime } from './external-client-runtime'
import type { MacosDesktopLatestVersionLookup } from './macos-desktop-app-update'
import { type ExternalClientCheckResult } from './external-client-connection'
import {
  buildDarwinTrustedVerificationRunner,
  buildToolStatusFromSettled,
  createServiceContext,
  modelAccessCacheKey,
  sameNativeConfigSnapshot,
  scanReuseMs,
} from './system-service-context'
import { createCliInstallService } from './cli-install-service'
import { createConfigSaveService } from './config-save-service'
import { createOfficialCredentialService } from './official-credential-service'
import { createToolRouteFollowService } from './tool-route-follow-service'
import { createExternalClientRouteService } from './external-client-route-service'
import { createProviderLaunchService, providerCommandEnvironment } from './provider-launch-service'
import { createSystemScanService } from './system-scan-service'
import { createRuntimeInstallService } from './runtime-install-service'
import { createCliUninstallService } from './cli-uninstall-service'
import { inspectClaudeDesktopStoreVirtualization } from './claude-desktop-manifest'

export type UpdateCheckStatus = 'checked' | 'failed' | 'skipped'
export type UpdateState = 'available' | 'latest' | 'unknown'
export type UpdateSource = 'npm' | 'native' | 'windows-appx' | 'official-manifest' | 'winget' | null

export interface VersionUpdateStatus {
  latestVersion: string | null
  updateAvailable: boolean | null
  updateSource: UpdateSource
  updateCheck: UpdateCheckStatus
  updateState: UpdateState
  updateCheckedAt: string | null
  updateError: string | null
}

export interface ToolStatus {
  installed: boolean
  version: string | null
  path: string | null
  installDirectory: string | null
  tooOld?: boolean
  versionStatus?: NodeVersionStatus
  uninstall?: CliUninstallCapability
  /**
   * Set when the probe itself threw instead of concluding "not installed".
   * Must stay distinguishable from `installed: false` so the renderer never
   * tells a user to install something that may already be on their machine.
   */
  detectionFailed?: boolean
  detectionError?: string | null
  /**
   * 这次安装是怎么装上的：npm 全局包（npm）、官方原生安装器（native）、或 PATH
   * 上的其他来源（path）。未装、探测失败、或非 CLI 工具（运行环境、桌面端）时为
   * undefined，渲染层此时退回中性的「已安装」。
   */
  installSource?: CliInstallDisplaySource
  /**
   * 这个工具装上去会落在哪个目录。未装时 installDirectory 为 null，而用户要
   * 查写入权限或加杀毒白名单需要的正是这个路径；已装时两者指同一处。算不出
   * 落点（非 CLI 工具、探测不到 npm 全局根）时缺省，界面据此不出「复制路径」。
   */
  installTarget?: string | null
}

export interface CliStatus extends ToolStatus {
  latestVersion: string | null
  updateAvailable: boolean
  updateSource?: UpdateSource
  updateCheck?: UpdateCheckStatus
  updateState?: UpdateState
  updateCheckedAt?: string | null
  updateError?: string | null
  uninstall: CliUninstallCapability
  /**
   * 已验证版本名单(cli-verified-versions.ts)对这个工具的建议。渲染层只读
   * 这一个字段就能显示「推荐版本」和不兼容提示,不需要自己持有名单。
   */
  versionAdvice?: CliVersionAdvice
  /**
   * 本工具最近一次把它更新过、还能退回去的那个旧版本(cli-update-history.ts)。
   * 缺省 = 没有可退的版本,界面不显示「退回更新前的版本」。
   */
  revertVersion?: string
  /**
   * 星芒已经下线的工具（catalog.ts 的 retiredProviderIds）。扫描不再去看它装没装，
   * 这一格只为让按 ProviderId 取值的旧代码照常拿到一份「未检测、没装」的占位。
   */
  retired?: boolean
}

export interface DesktopAppStatus extends ToolStatus, Partial<VersionUpdateStatus> {
  appVersion: string | null
  mirrorVersion: string | null
  mirrorUpdateAvailable: boolean | null
  mirrorError: string | null
  running: boolean
}

export interface LatestVersionProbe {
  status: UpdateCheckStatus
  version: string | null
  source: 'npm' | 'native' | 'official-manifest'
  checkedAt: string
  error: string | null
}

export type { OfficialChatGptAccount, OfficialChatGptWindow }

export interface SystemSnapshot {
  checkedAt: string
  network: NetworkLocationStatus
  runtime: {
    node: ToolStatus
    npm: ToolStatus
    python: ToolStatus
    /**
     * Git 不是必装项，缺了也不该把「运行环境」整体判成不通过：它只决定
     * Claude Code 的 Bash 工具能不能用、官方插件市场能不能拉下来
     * （见 git-runtime.ts）。所以这一行和 Python 一样是「可选环境」。
     */
    git: ToolStatus
  }
  clis: Record<ProviderId, CliStatus>
  desktopApps: {
    codex: DesktopAppStatus
  }
  officialChatGpt?: OfficialChatGptAccount | null
  /**
   * 只有「上次的检测结果」才有：落盘的时间。界面见到它就当作还在检测，
   * 真的扫描结果回来会整份替换（见 system-snapshot-cache.ts）。
   */
  cachedAt?: string
}

/** 首页那次读取可以先拿上次的结果（见 SystemService.cachedScan）；其余调用方不传。 */
export interface SystemScanOptions {
  acceptCached?: boolean
  /** 客户亲手点了首页的「重新检测」：星芒账号的工具线路也马上查一轮（xm 三线路 5.1.4）。 */
  recheckRoutes?: boolean
}

/** 卸载命令行工具的附加要求；缺省 = 只卸载（旧行为）。 */
export interface CliUninstallOptions {
  /**
   * 这次卸载是「换成星芒装的」的前一半，卸完渲染层马上用 npm 装回来（第三十一批 B）。
   * 先按安装那一道门槛看盘：装不下就一个文件都不动，免得客户卸完落得一份都没有。
   */
  reinstall?: boolean
}

export interface CodexDesktopLaunchResult {
  restarted: boolean
  status: DesktopAppStatus
  /** Runtime confirmation is separate from successfully opening the app. */
  chineseLocale?: { status: 'verified' | 'failed' | 'restart-required'; message?: string }
}

export interface CliLaunchResult {
  /**
   * 项目文件夹里（或这台电脑上公司统一下发）的设置会盖过当前账号时，给用户的一句
   * 提醒。只提醒不改：那些文件是用户或公司的，本软件不动它们。缺省 = 没发现。
   */
  configOverrideNotice?: string
  /**
   * 用户在「这个文件夹不建议打开」那一问里选了不打开（或关掉了对话框），工具
   * 没有启动。界面据此不说「已打开」。缺省 = 打开了，老调用方照旧。
   */
  declined?: boolean
  /**
   * 打开后「上次选的文件夹」是哪个（同 AppConfigSummary.rememberedWorkspace，null = 没有）。
   * 首页据此直接换按钮，不必为这一个字段再读一遍整份配置。缺省 = 没带，界面照旧。
   */
  rememberedWorkspace?: string | null
}

export type ToolUninstallResult =
  | {
      /** delegated：已交给以登录用户身份运行的窗口执行，结果需用户完成后刷新确认。 */
      outcome: 'uninstalled' | 'not-installed' | 'delegated'
      previousVersion: string | null
    }
  | {
      outcome: 'manual-required'
      previousVersion: string | null
      error: string
      manualHelp: {
        reason: string
        /**
         * null when a plain, unverified guess would be unsafe to hand back
         * (e.g. a security check itself failed, so the file identities behind
         * a command can no longer be trusted). Non-null only where the
         * producer already fully re-verified every path it names — see
         * DarwinGrokRetainedPathsError below, and the Claude native version
         * files (plus, on Windows, the renamed claude.exe still running) left
         * behind by uninstallVerifiedClaudeNativeInstallation.
         */
        manualCommand: string | null
        /**
         * true = the main process pinned exactly the files manualCommand names
         * and `cli:clean-uninstall-leftovers` may delete them after checking
         * them again (已知48「帮我清理」). Omitted = the command is all there is.
         */
        cleanUpAvailable?: boolean
      }
    }

/** 「帮我清理」之后还剩几个文件（已知48）；0 = 删干净了。 */
export interface CliLeftoverCleanupResult {
  remaining: number
}

export interface CodexSetupStatus {
  checkedAt: string
  runtime: {
    node: ToolStatus
    npm: ToolStatus
  }
  cli: ToolStatus
  desktop: DesktopAppStatus
}

export interface ConfigSavePayload {
  provider: ProviderId
  apiKey: string
  model: string
  mode: NativeConfigSaveMode
}

/** 换线路定点改写是哪一下起的（只进日志）。 */
export type ToolRouteFollowReason = 'route-changed' | 'startup' | 'retry' | 'verify'

export interface ToolRouteFollowRequest {
  reason: ToolRouteFollowReason
  /** 这次换线是因为连不上（relay-route-controller 的 health-failed）；只有这种才可能提示重开。 */
  fault?: boolean
  /** 只看这几个；缺省 = 还在管的那几个都看（catalog.ts 的 activeProviderIds）。 */
  providers?: readonly ProviderId[]
}

export interface ToolRouteFollowReport {
  rewritten: ProviderId[]
}

/** ipc.ts 交进来的两件要账号信息的事。 */
export interface ToolRouteAccountHooks {
  /** 第一次定点改写之前整套备份一次（「备份」页里那份就是迁移前原件），带上账号信息。 */
  backup(provider: ProviderId): Promise<void>
  /** 当前账号签发过的 Key 的 id，生图技能据此认人；读不到 = 空集合。 */
  ownedKeyIds(): Promise<ReadonlySet<number>>
}

export interface AppConfigSummary {
  workspace: string
  /**
   * 首页「打开」在这个工具还没有会话记录时直接用的文件夹：用户上次在本软件里选过、
   * 且不是主目录或其他敏感目录的那个（resolveRememberedWorkspace）。缺省 = 没有，照旧弹选择器。
   */
  rememberedWorkspace?: string
  providers: Record<ProviderId, NativeConfigSummary>
  /**
   * 账号还在恢复时读到的配置：「是不是当前账号写的」这一问还答不上来，
   * configurationOwnership 只会是 unknown，不代表真的来源不明。缺省 = 已判定。
   */
  ownershipPending?: boolean
}

export interface CodexReadinessStatus {
  hasApiKey: boolean
  matchesRelay: boolean
}

export interface RendererMessageTarget {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

export type CodexDesktopLaunchMode = 'open' | 'restart'

export interface SystemService {
  readStoredConfig(): AppSettings
  updateStoredConfig(update: AppSettingsUpdate): Promise<AppSettings>
  inspectCodexReadiness(previewOnboarding: boolean): CodexReadinessStatus
  getConfig(previewOnboarding: boolean, cachedKeys?: readonly StoredManagedCliKey[]): AppConfigSummary
  revealApiKey(provider: ProviderId, previewOnboarding: boolean): string
  saveConfig(
    payload: ConfigSavePayload,
    previewOnboarding: boolean,
    assertBeforeWrite?: () => void,
    ownership?: { source: 'account'; automatic: boolean },
  ): Promise<ReturnType<typeof saveProviderConfig>>
  switchToOfficialAccount(provider: ProviderId, mode?: ConfigSavePayload['mode']): ReturnType<typeof switchProviderToOfficialAccount> | Promise<ReturnType<typeof switchProviderToOfficialAccount>>
  /** 切换失败回滚时把「是否选了官方账号」这个记号恢复成切换前的值；可选 = 旧实现不提供。 */
  setOfficialSourcePreference?(provider: ProviderId, official: boolean): Promise<void>
  /** 把切到当前账号时挪开的官方凭据放回原处；可选 = 旧实现不提供。 */
  restoreOfficialCredentials?(provider: ProviderId): Promise<void>
  /** 这台电脑上是否已有这个 CLI 的官方登录，null = 看不出来；可选 = 旧实现不提供。 */
  inspectOfficialLogin?(provider: ProviderId): boolean | null
  /**
   * 首页「修好它」：把本软件写进这家配置、却指向旧位置的钩子与状态行改成这次的路径
   * （这台电脑写不出来就收回），写完再查一遍；还是旧的就抛中文原因。可选 = 旧实现不提供。
   */
  repairCliHooks?(provider: ProviderId): Promise<ReturnType<typeof saveProviderConfig>>
  /**
   * 开机后读配置前：本账号写的、指向旧位置的钩子与状态行不等客户点就改好，每家这次启动只试一次。
   * 返回这一次改好了哪几家。可选 = 旧实现不提供。
   */
  autoRepairStaleCliHooks?(): Promise<ProviderId[]>
  /**
   * 备份恢复成功之后调用；`isAccountKey` 判断一把 Key 是不是当前账号由本软件签发的。
   * `fromBackupsPage`：客户在备份页挑的那一份；缺省 = 切换失败的回滚（恢复切换前那一刻）。
   */
  adoptRestoredConfig(provider: ProviderId, isAccountKey: (apiKey: string) => boolean, options?: { fromBackupsPage?: boolean }): Promise<void>
  /**
   * 备份页恢复、登记来源之后调用（#1080）：恢复出来的是当前账号的配置还是官方登录，「选了官方账号」
   * 的记号和 Claude 的官方 Key 跟着对齐。切换失败的回滚不调：它自己按切换前的样子放回这两样。
   * 对不齐抛错，配置照样是恢复出来的那份。
   */
  alignRestoredAccountSource(provider: ProviderId): Promise<void>
  /**
   * 排进保存配置那一队再改工具配置（#1061 第 1 条）：主进程别处替客户改配置的（画图工具登记、
   * 星芒AI技能跟着账号开关）用它，不然保存查模型那一会儿改了文件，保存就报配置在检测期间变了。
   * operation 里不能再排这一队，那会自己等自己。可选 = 旧实现不提供，调用方直接写。
   */
  serializeToolConfigWrite?<T>(operation: () => Promise<T>): Promise<T>
  scanSystem(forceRefresh?: boolean): Promise<SystemSnapshot>
  /** 手上现成的扫描结果（正在跑的，或 `maxAgeMs` 以内跑完且之后没装卸过东西的）；没有就是 null，不会新起一轮。 */
  recentScan(maxAgeMs: number): Promise<SystemSnapshot> | null
  /**
   * 本次启动还没有扫完过一轮时，给出上次落盘的结果（带 `cachedAt`），同时确保
   * 一轮真扫描在跑；已经扫完过、或没有可用的旧结果时是 null。只给首页「先画个样子」用。
   * `startScan: false` 只读旧结果、不起真扫描：开机安静期里用（见 login-launch.ts）。
   */
  cachedScan(options?: { startScan?: boolean }): Promise<SystemSnapshot | null>
  refreshNetworkLocation(): Promise<SystemSnapshot['network']>
  refreshOfficialChatGptUsage(): Promise<OfficialChatGptAccount | null>
  inspectCodexSetupStatus(): Promise<CodexSetupStatus>
  installNodeRuntime(target: RendererMessageTarget, request?: NodeRuntimeInstallRequest): Promise<NodeRuntimeInstallResult>
  /** 这台 Windows 电脑真实的芯片（星芒在 ARM 电脑上是模拟运行的，process.arch 不作数）；认不出或不是 Windows 为 null。 */
  inspectWindowsProcessor(): Promise<WindowsProcessorArchitecture | null>
  restartWindows(): Promise<void>
  installPythonRuntime(target: RendererMessageTarget): Promise<PythonRuntimeInstallResult>
  installGitRuntime(target: RendererMessageTarget): Promise<GitRuntimeInstallResult>
  installCli(provider: ProviderId, target: RendererMessageTarget, version?: string): Promise<void>
  cancelCliInstall(provider: ProviderId): InstallCancellationOutcome
  uninstallCli(provider: ProviderId, options?: CliUninstallOptions): Promise<ToolUninstallResult>
  /** 「帮我清理」：只删这个工具上次卸载时记下的那几个文件，删前再核对一遍（已知48）。 */
  cleanUninstallLeftovers(provider: ProviderId): Promise<CliLeftoverCleanupResult>
  inspectCliUpdate(provider: ProviderId, forceRefresh?: boolean): Promise<CliStatus>
  /** request 只有 Mac 上首页「可更新到 v…」那一下才传（见 DesktopAppUpdateRequest）。 */
  installCodexDesktop(target: RendererMessageTarget, request?: DesktopAppUpdateRequest): Promise<CodexDesktopInstallResult>
  cancelCodexDesktopInstall(): InstallCancellationOutcome
  uninstallCodexDesktop(): Promise<ToolUninstallResult>
  resetCodexDesktop(): Promise<void>
  inspectCodexDesktopUpdate(forceRefresh?: boolean): Promise<DesktopAppStatus>
  /** resumeSessionId 只在 Codex 续接时由 ipc.ts 核对过后传入，见 cliLaunchArgv。 */
  /** accountWork：排在安装后面的这段不算账号工作，轮到它执行时才算（#1085）。 */
  launchProvider(provider: ProviderId, workspace: string, mode?: CliLaunchMode, resumeSessionId?: string | null, accountWork?: QueuedAccountWork): Promise<CliLaunchResult>
  inspectCodexDesktop(): Promise<DesktopAppStatus>
  inspectCodexDesktopLocale(): Promise<CodexDesktopLocaleStatus>
  inspectCodexWorkspacePermissions(): CodexWorkspacePermissionStatus
  trustCodexWorkspace(target: RendererMessageTarget): Promise<CodexWorkspacePermissionWriteResult & { restarted: boolean }>
  setCodexDesktopLocale(
    locale: CodexDesktopLocale,
    target: RendererMessageTarget,
  ): Promise<CodexDesktopLocaleResult>
  launchCodexDesktop(
    mode: CodexDesktopLaunchMode,
    target: RendererMessageTarget,
    launchOptions?: { injectChinese?: boolean; accountWork?: QueuedAccountWork },
  ): Promise<CodexDesktopLaunchResult>
  /** 换账号之后看哪些工具还开着（Codex 连同桌面端）；可选 = 旧实现不提供，调用方退回无条件提醒。 */
  inspectRunningTools?(providers: readonly ProviderId[]): Promise<RunningToolsReport>
  /** 打开工具前核对当前账号能用的模型（一天一次）；可选 = 旧实现不提供，调用方直接打开。 */
  checkToolModels?(provider: ProviderId): Promise<ToolModelCheck>
  /**
   * 开机恢复账号后给落后于模板的配置补缺省项；可选 = 旧实现不提供，调用方当什么都没补。
   * retry = 只补开机那轮因为工具可能开着而欠下的（第二十六批 E）。
   */
  fillToolTemplateDefaults?(backup?: (provider: ProviderId) => void, retry?: boolean): Promise<ToolTemplateFillResult>
  /**
   * 换账号、退出、登录之前叫一声（main.ts 的 quiesce）：正在补设置的那次不再等本机看工具开没开，
   * 这次先不补、记成还欠着，账号操作不用陪它等。返回的函数在那段等待结束后调，之后开始的补设置
   * 照常看。可选 = 旧实现不提供，调用方照旧等它做完。
   */
  stopTemplateFillWaits?(): () => void
  /**
   * 换线路时把星芒账号工具配置里的地址改到当前线路，只改那一处（xm 三线路 C9）；可选 = 旧实现不提供，
   * 调用方当什么都没改。
   */
  followToolRoutes?(request: ToolRouteFollowRequest): Promise<ToolRouteFollowReport>
  /**
   * 整份写入那一轮写完了（account-cli-provisioner.ts 的 configureManagedClis），written 是这一轮写好的几家：其中
   * 因为连不上换了线路、跟过去的一次提示重开，不一家一句（历史账号，#1061 第 2 条）。可选 = 旧实现不提供。
   */
  noteRouteFollowRestart?(written: readonly ProviderId[]): Promise<void>
  /** ipc.ts 注册时交进来，注销时交 null。 */
  bindToolRouteAccount?(hooks: ToolRouteAccountHooks | null): void
  /** 星芒窗口回到前台：等着外部客户端退出再换线路的，看一眼退了没有（同一个客户端两次至少隔 2 分钟）。 */
  recheckPendingExternalRoutes?(): void
  /** 退出时停掉换线路的几个定时器。 */
  disposeToolRoutes?(): void
  /** routed：星芒自己用的（AI 工作区），「自动」时直连没走通当场改走默认线路；缺省查的是工具会用的那条线路。 */
  fetchAvailableModels(apiKey: string, options?: { bypassCache?: boolean; routed?: boolean }): Promise<string[]>
  configureExternalTool(tool: ExternalToolId, options: ExternalToolConfigOptions, assertBeforeWrite?: () => void, keySource?: ExternalClientKeySource): Promise<ExternalClientConfigResult>
  scanExternalClients(force?: boolean): Promise<ExternalClientStatus[]>
  /**
   * 本次启动还没真检测过客户端时，给出上次落盘的结果（每条带 `cachedAt`）；检测过了、或没有可用的
   * 旧结果时是空列表。只读文件、不起盘点，只给首页「先画个样子」用（已知13）。
   */
  cachedExternalClients(): Promise<ExternalClientStatus[]>
  /** 上一次客户端检测留下的快照；反馈报告只读它，不为了生成报告再探测一轮。 */
  getLastExternalClients(): ExternalClientStatus[] | null
  /**
   * 外部客户端的连接自检：用它自己配置里那把密钥核对一次当前账号。
   * knownStatus 是调用方手里已有的那份运行时检测结果，省掉一次机器盘点。
   */
  checkExternalClientConnection(
    tool: ExternalToolId,
    knownStatus?: ExternalClientRuntimeStatus | null,
  ): Promise<ExternalClientCheckResult>
  /** request 只有 Mac 上首页「可更新到 v…」那一下才传（见 DesktopAppUpdateRequest）。 */
  installExternalClient(tool: ExternalToolId, target: RendererMessageTarget, request?: DesktopAppUpdateRequest): Promise<ExternalClientStatus>
  cancelExternalClientInstall(tool: ExternalToolId): InstallCancellationOutcome
  launchExternalClient(tool: ExternalToolId): Promise<void>
  /** 首页 Claude Desktop 卡上的一键切换：只改它登录页那个选择，星芒那份配置留着。 */
  switchExternalClientSource(tool: ExternalToolId, target: 'account' | 'official', assertBeforeWrite?: () => void): Promise<ExternalClientSourceSwitchResult>
  /** 安装队列当前的状态，退出前判断有没有安装正在跑时用。 */
  inspectInstallationQueue(): InstallationQueueSnapshot
  /** 安装队列每有一项开始或结束就回调一次；装东西时挡住自动睡眠用。 */
  onInstallationQueueChange(listener: (snapshot: InstallationQueueSnapshot) => void): () => void
  /**
   * 清掉以前中途被打断的安装留下的临时下载目录（见 install-leftovers.ts）。排在安装
   * 队列里，不会和正在进行的安装撞上；从不抛错。
   */
  cleanupInstallLeftovers(): Promise<InstallLeftoverSweepResult>
  /**
   * 开机时在本机看一眼本软件写给 Codex 的型号名单还读不读得进，读不进就收回那一行；不看
   * 账号、不联网，登录状态下开机那轮按账号同步也共用这一次。从不抛错。可选 = 旧实现不提供。
   */
  guardCodexModelCatalogAtStartup?(): Promise<void>
  /**
   * 开机后收回星芒以前写进下线工具（Gemini CLI）配置的做完提醒与画图工具；Key、线路、型号
   * 不动。工具开着或看不出开没开的这次不动，下次开机再看。从不抛错。可选 = 旧实现不提供。
   */
  reclaimRetiredToolIntegrations?(): Promise<RetiredGeminiIntegrations>
}

export type NetworkRegion = 'mainland-china' | 'outside-mainland-china' | 'unknown'

export interface NetworkLocationStatus {
  publicIp: string | null
  countryCode: string | null
  region: NetworkRegion
  checkedAt: string
  error: string | null
}

export interface NpmPackageReleaseMetadata {
  name: string
  version: string
  integrity: string
}

export function assertNpmReleaseIntegrityMatches(
  trusted: NpmPackageReleaseMetadata,
  candidate: NpmPackageReleaseMetadata,
): void {
  if (
    candidate.name !== trusted.name
    || candidate.version !== trusted.version
    || candidate.integrity !== trusted.integrity
  ) {
    throw new Error('国内 npm 镜像的包名、版本或 SHA-512 完整性元数据与 npm 官方源不一致')
  }
}

export interface SystemServiceOptions {
  managerDataDirectory?: string
  /** 首页扫描结果落在哪；缺省不落盘（测试与旧行为）。 */
  systemSnapshotCacheFile?: string
  /** 外部客户端检测结果落在哪；缺省不落盘（测试与旧行为）。见 external-client-snapshot-cache.ts。 */
  externalClientSnapshotCacheFile?: string
  /** 记进落盘的旧结果；别的版本写的也认，但不带推荐版本这类判断（见 system-snapshot-cache.ts）。 */
  appVersion?: string
  /** Native profile roots and policy reads are isolated in tests. */
  claudeDesktopEnv?: NodeJS.ProcessEnv
  inspectClaudeDesktopStoreVirtualization?: typeof inspectClaudeDesktopStoreVirtualization
  assertClaudeDesktopUnmanaged?: () => Promise<void>
  externalClientRuntime?: ReturnType<typeof createExternalClientRuntime>
  /**
   * Mac 上查星芒存储桶里几个桌面端的最新版，首页提醒「可更新到 v…」（yoyo 2026-10-27「桌面端更新改」）。
   * 缺省 = 生产照查（测试里不查，免得单测真的去连存储桶）；null = 不查。
   */
  latestMacosDesktopVersions?: MacosDesktopLatestVersionLookup | null
  /** The active account owns model lookup and CLI routing, independently of saved UI preferences. */
  getRelaySiteId?: () => string
  /** Preferences freeze at startup; under "auto" the line itself may move during the run (relay-route-controller.ts). */
  relayEndpointRouting?: RelayEndpointRoutingSnapshot
  /**
   * xm 三线路：relayEndpointRouting 给的是工具线路（星芒账号读 tool-route-controller.ts，历史账号照旧读应用线路，
   * relay-sites.ts 的 createToolRouteRoutingSnapshot）。这里给设置快照里管理工具自己那条线路（relayRouteLines，
   * 含义不变）和工具线路的状态。缺省 = 两套是同一套（旧行为）。
   */
  relayToolRouting?: {
    applicationLines(): RelayRouteLines
    status(): RelayToolRouteStatus | undefined
  }
  /** Stable realm + user identity; null while logged out. Never inferred from the relay URL. */
  getExternalClientAccountId?: () => string | null
  /**
   * 当前账号的托管 Key 缓存（managed-cli-key-store.ts），读出来带着每家被换掉的那几把的指纹。Claude Desktop
   * 跟着 Claude Code 换 Key 要用（#1113）；明文只在主进程里用，永不跨 IPC（I3）。缺省 = 不跟着换。
   */
  readCurrentManagedCliKeys?: () => Promise<readonly StoredManagedCliKey[]>
  /**
   * 这台电脑上同一个站别的账号的托管 Key 缓存，owner 同 getExternalClientAccountId 的写法。换了账号、工具同步成
   * 新账号那把以后，外部客户端跟着换要用（已知37）；明文只在主进程里用（I3）。缺省 = 换账号时不跟着换。
   */
  readOtherManagedCliKeyAccounts?: () => Promise<readonly { owner: string; keys: readonly StoredManagedCliKey[] }[]>
  /**
   * R6：换线路时工具配置怎么改。缺省 targeted = 主进程定点只改地址；merge = 退回整份写入的老路
   * （渲染层照旧跑同步 Key）。来自服务状态文件，出问题不用发版就能切回。
   */
  getToolRouteRewriteMode?: () => 'targeted' | 'merge'
  /**
   * 「自动」线路最近一次换线（relay-route-controller.ts 的 lastChange）。历史账号的工具配置跟的就是这条，界面
   * 整份写入跟过去以后据此判断要不要提示重开（#1061 第 2 条）。缺省 = 不提示。
   */
  relayRouteLastChange?: (siteId: RelayRouteSiteId) => RelayRouteChange | null
  /**
   * 服务状态文件里的型号表（service-status.ts 的 cliModels）：默认型号、上一代、已下架。从不拒绝，
   * 读不到给 null。缺省 = 只用程序自带的那份（cli-model-defaults.ts）。
   */
  cliModelHints?: () => Promise<CliModelHints | null>
  /** 换线路自动改了工具配置、出了重开提示、外部客户端换成了：叫一声，界面重读（main.ts 发 network:relay-route-changed）。 */
  onToolRouteFollowed?: () => void
  /** 测试注入：换线路那几个定时器；缺省 setTimeout（unref）。 */
  scheduleToolRoute?: (callback: () => void, delayMs: number) => () => void
  /** 测试注入：换线路那几处用的时钟；缺省 Date.now。 */
  toolRouteNow?: () => number
  /** 开机补模板缺省项前问「哪些工具开着」的那一步；缺省 = 真去查进程，测试里替换掉。 */
  inspectRunningToolsForTemplateFill?: (providers: readonly ProviderId[]) => Promise<RunningToolsReport>
  /** 换线路重开提示问「哪几个开着」用的；缺省走 inspectRunningTools。测试注入用。 */
  inspectRunningToolsForRouteHint?: (providers: readonly ProviderId[]) => Promise<RunningToolsReport>
  /** Defaults to the restrictive mode so tests and non-main callers fail closed. */
  windowsExecutionMode?: WindowsCliExecutionMode
  platform?: NodeJS.Platform
  providerRoots?: ProviderConfigRoots
  codexEnv?: NodeJS.ProcessEnv
  inspectProviderConfig?: typeof inspectProviderConfig
  resolveCliCommand?: typeof resolveCliCommand
  resolveCliInstallation?: typeof resolveCliInstallation
  findExecutable?: typeof findExecutable
  /** Test seam: the real one looks for a terminal program and waits for its window (linux-terminal.ts). */
  launchLinuxTerminal?: typeof launchLinuxTerminal
  /** Test seam: the real one has a hidden PowerShell start the terminal and hand back its process id (windows-elevation.ts). */
  launchCliPowerShell?: typeof launchCliPowerShell
  /** Test seam: the real one writes the zsh launcher and has `open -a Terminal` run it (macos-platform.ts). */
  launchMacosTerminal?: typeof launchMacosTerminal
  runCommand?: typeof runCommand
  macosCodexAppDetector?: typeof inspectMacosCodexApp
  installPythonRuntime?: typeof installPythonRuntime312
  inspectInstalledPythonRuntime?: typeof inspectInstalledPythonRuntime
  inspectWindowsRestartRequired?: typeof inspectWindowsRestartRequired
  installNodeRuntime?: typeof installNodeRuntimeLts
  /** Test seam: the real probe reads HKLM through reg.exe. */
  inspectWindowsProcessor?: () => Promise<WindowsProcessorArchitecture | null>
  /** Test seam: the real probe reads the PE header of the installed node.exe. */
  inspectExecutableMachine?: typeof inspectWindowsExecutableMachine
  installGitRuntime?: typeof installGitForWindows
  /** Test seam: the macOS path would otherwise run the real xcode-select --install. */
  installMacGitRuntime?: typeof installMacGitRuntime
  /** Test seam for Windows-only operations exercised on non-Windows CI runners. */
  resolveWindowsMachinePaths?: typeof resolveWindowsMachinePaths
  /** Test seam: the real read runs reg.exe for the machine and user PATH. */
  readWindowsLivePath?: (system32: string, env: NodeJS.ProcessEnv) => Promise<string | null>
  /** Test seam so scanSystem never talks to chatgpt.com under vitest. */
  fetchOfficialChatGptUsage?: typeof fetchOfficialChatGptUsage
  /**
   * Relay traffic uses Electron's proxy-aware network stack in the desktop host. Tool-facing
   * requests (model checks before a config write, client checks) go out on exactly the line the
   * tool will use: no rewrite, no retry (relay-line-fetch.ts createRelayObservedFetch).
   */
  relayFetch?: typeof fetch
  /** 星芒自己的请求：「自动」时直连没走通当场改走默认线路（createRelayLineFetch）。缺省同 relayFetch。 */
  relayRoutedFetch?: typeof fetch
  /** Location must use the desktop session's actual route, independently of relay traffic. */
  networkLocationFetch?: typeof fetch
  /** Re-read Chromium's proxy configuration before an explicit location refresh. */
  reloadNetworkProxyConfig?: () => Promise<void>
  /** Artifact downloads follow the same proxy a browser would; see download-proxy.ts. */
  downloadFetch?: typeof fetch
  /**
   * 查 npm 包版本与完整性元数据用的 fetch。缺省 = 主进程自带的 Node fetch，行为与
   * 从前一致；宿主接 Chromium 那条（net.fetch），它认这台电脑装的证书，公司电脑上
   * 装工具才不会第一步就卡在「校验版本」。管理员身份时不用它，见 registryMetadataFetch。
   */
  registryFetch?: typeof fetch
  /** Loopback-only proxy variables handed to package-manager subprocesses. */
  resolveSubprocessProxyEnvironment?: () => Promise<NodeJS.ProcessEnv>
  /** 试连电脑里代理设置指向的本机端口；缺省 = 真的去连（stale-proxy-environment.ts）。 */
  probeLoopbackProxy?: LoopbackProbe
  /**
   * 下载期间临时拉起加速（只开本机回环端口，不动系统代理）。缺省 = 不做，
   * 行为与从前一致。真正的路由由宿主实现，这里只需要知道它有没有生效——
   * 生效了就把安装源顺序切成官方优先。见 download-acceleration.ts。
   */
  acquireDownloadAcceleration?: () => Promise<DownloadAccelerationLease>
  /**
   * 拉起 Codex 桌面端之前先把加速连上（完整连接，不是下载专用线路——桌面端
   * 是独立进程，只认系统代理）。缺省 = 不做，行为与从前一致；实现永不抛错，
   * 见 codex-desktop-acceleration.ts。
   */
  prepareCodexDesktopAcceleration?: () => Promise<void>
  /**
   * 拉起 Codex 桌面端之前给它启动时读中文开关的那一下找条路（codex-desktop-startup-route.ts）。给了它
   * 就由它按需连加速，prepareCodexDesktopAcceleration 不再单独调。缺省 = 旧行为。
   */
  prepareCodexDesktopStartupRoute?: (context: { launchArgumentsUsable: boolean }) => Promise<CodexDesktopStartupRoute>
  /**
   * 从星芒打开 Claude Desktop 之前先在后台替他连上加速，好让它下得到 Claude Code 程序和 Cowork 工作区
   * （#1373，claude-desktop-acceleration.ts）。实现永不抛错；缺省 = 旧行为，直接打开。
   */
  prepareClaudeDesktopLaunch?: (context: ClaudeDesktopLaunchContext) => Promise<unknown>
  /** runtime.jsonl sink for steps that are allowed to fail without blocking. */
  runtimeLog?: RuntimeLogLike
  /** 随包的中文 AGENTS.md 模板路径；缺省则打开目录时不生成项目说明。 */
  projectInstructionsTemplatePath?: string
  /** 随包的 Claude Code 状态行脚本路径；缺省则不给 Claude Code 写 statusLine。 */
  claudeStatusLineScriptPath?: string
  /** 随包的命令行工具钩子脚本路径；缺省则不给 Claude Code / Gemini CLI 写通知钩子。 */
  cliHookScriptPath?: string
  /**
   * 随包的官方 Codex 型号名单（codex-model-catalog.ts）。缺省 = 不写也不收回 Codex 的
   * 型号名单，与从前一致。
   */
  bundledCodexModelCatalogPath?: string
  /**
   * 读型号名单的还有桌面端自带的那份 Codex，写之前要知道桌面端是哪一批。缺省 = Windows
   * 问 Appx 包、Mac 看应用包、其余平台算没装；测试里替换掉。
   */
  inspectCodexDesktopForModelCatalog?: () => Promise<CodexDesktopCatalogProbe>
  /** 安装前那次磁盘剩余空间预检的读取口，测试用它造「够 / 不够 / 读不到」三种盘。 */
  readDiskSpace?: typeof readDiskSpace
  /**
   * 把 Windows 上工具所在的目录补进当前用户的 PATH，让用户自己开的终端也能直接
   * 敲工具名。缺省 = 不改（测试与旧行为），只有 main.ts 接真实现。
   */
  ensureWindowsUserPath?: (directory: string) => Promise<UserPathOutcome>
  /**
   * Windows 上卸掉 ~/.grok/bin 里的 Grok 后，把这个目录从当前用户的 PATH 里拿掉（官方安装脚本
   * 加的那一段）。缺省 = 不改（测试里不起 PowerShell），只有 main.ts 接真实现。
   */
  removeWindowsUserPath?: (directory: string) => Promise<UserPathRemoval>
  /**
   * Mac 上对应的那一步：往当前用户登录 shell 读的启动文件补几行（zsh 的 ~/.zprofile、
   * bash 的 ~/.bash_profile 或 ~/.profile、fish 的 conf.d 文件），让自己开的终端也能直接敲
   * 工具名。缺省 = 不改（测试与旧行为），只有 main.ts 接真实现。
   */
  ensureMacosShellProfile?: (reason: 'install' | 'startup') => Promise<MacosShellProfileOutcome>
  /**
   * Linux 上对应的那一步：给星芒装的每个工具放一个小启动器，并往 ~/.bashrc 等文件末尾补
   * 几行；卸掉最后一个时再去掉。缺省 = 不改（测试与旧行为），只有 main.ts 接真实现。
   */
  syncLinuxTerminalCommands?: (reason: LinuxTerminalCommandsReason) => Promise<LinuxTerminalCommandsResult>
  /**
   * 真正去删安装残留的那一步。缺省 = 不清（测试与旧行为），只有 main.ts 接真实现，
   * 免得单测装一次工具就去扫开发机的临时目录。
   */
  sweepInstallLeftovers?: (locations: readonly InstallLeftoverLocation[]) => Promise<InstallLeftoverSweepResult>
}

// 定义随用它的 preferredNodeDirectories 搬进了 system-service-context.ts，这里照旧导出。
export { scanReuseMs }
// #1070 搬进 npm-registry.ts、npm-command-failure.ts、platform-capabilities.ts、system-service-context.ts 的几个，
// 测试和别处照旧从这里拿。
export {
  buildDarwinTrustedVerificationRunner,
  buildToolStatusFromSettled,
  describeNpmCommandFailure,
  describeNpmUninstallFailure,
  grokInstallStrategyFor,
  isMachineBoundNpmFailure,
  isNpmExitFailure,
  modelAccessCacheKey,
  npmInstallRegistries,
  npmPackageLatestUrl,
  npmPackageVersionUrl,
  npmRegistryLabel,
  sameNativeConfigSnapshot,
}
// 装命令行工具搬进 cli-install-service.ts 时一起带走的那些（#1070 第 2 步），测试和别处照旧从这里拿。
export {
  assertNpmPackageLocksEquivalent,
  assertNpmReleaseMatchesOfficialLock,
  buildCliInstallScriptAllowlist,
  buildCliMaintenancePlan,
  buildCliResolutionManifest,
  createNpmDownloadStallWatch,
  externalCliInstallRefusal,
  fetchNpmPackageReleaseMetadata,
  finishClaudeInstallWithGit,
  formatElapsedDuration,
  grokDownloadStallHeartbeatMs,
  grokDownloadStallMessage,
  inspectVerifiedDarwinGrokPostInstall,
  inspectVerifiedLinuxGrokPostInstall,
  installGitAlongsideClaude,
  ManagedNpmRollbackError,
  measureDirectoryBytes,
  npmDownloadCeilingMs,
  npmDownloadHeartbeatMessage,
  npmDownloadHeartbeatMs,
  npmDownloadProgressCheckMs,
  npmDownloadStallTimeoutMs,
  npmDownloadTimeoutMs,
  npmResolutionHeartbeatMessage,
  npmResolutionHeartbeatMs,
  npmResolutionStartMessage,
  npmResolutionTimeoutMs,
  parseNpmPackageReleaseMetadata,
  replaceManagedNpmPrefixAtomically,
  resolveCliInstallRelease,
} from './cli-install-service'
export type {
  CliInstallReleaseOptions,
  CliMaintenancePlan,
  CliResolutionManifest,
  InspectVerifiedDarwinGrokPostInstallOptions,
  ManagedNpmReplaceOperations,
  ManagedNpmReplaceResult,
  NpmDownloadStallWatch,
  NpmDownloadStallWatchOptions,
} from './cli-install-service'
// 保存配置那一段搬进 config-save-service.ts 时一起带走的那些（#1070 第 3 步），测试和别处照旧从这里拿。
export {
  ccSwitchLeftoverField,
  cliHooksAutoRepairedField,
  cliHooksSummaryFields,
  codexDesktopCatalogProbeFromMacosApp,
  codexDesktopCatalogProbeFromPackage,
  createCachedProbe,
  grokCliHooksMissing,
  permitsShadowedCodexRepair,
  shouldAutoRepairCliHooks,
  unlessStopped,
} from './config-save-service'
// 官方账号那一段搬进 official-credential-service.ts 时一起带走的那些（#1070 第 3 步），测试和别处照旧从这里拿。
export {
  planRestoredConfigOwnership,
  restoredAccountSide,
} from './official-credential-service'
// 外部客户端搬进 external-client-route-service.ts 时一起带走的那些（#1070 第 3 步），测试和别处照旧从这里拿。
export {
  buildExternalClientDetectionErrorLogDetail,
  buildExternalClientMacVerificationLogDetail,
  buildExternalClientRegistryLogDetail,
} from './external-client-route-service'
// 打开工具搬进 provider-launch-service.ts 时一起带走的那些（#1070 第 3 步），测试和别处照旧从这里拿。
export {
  buildCliLaunchQueueKey,
  buildDarwinCliLaunchPlan,
  interactiveTerminalEnvironment,
  launchExcludedEnvironmentVariables,
  macosShellOverrideVariables,
  providerCommandEnvironment,
  sameUserTerminalEnvironment,
  withoutEnvironmentVariables,
  writeQueuedWithin,
} from './provider-launch-service'
// 首页检测搬进 system-scan-service.ts 时一起带走的那些（#1070 第 3 步），测试和别处照旧从这里拿。
export {
  buildCliStatus,
  buildCliToolStatusFromSettled,
  buildDesktopAppStatusFromSettled,
  buildNetworkLocationStatusFromSettled,
  buildRetiredCliStatus,
  buildUncheckedLatestVersion,
  cliInstallTargetDirectory,
  cliLatestVersionSource,
  createScanCoalescer,
  detectNetworkLocation,
  detectNetworkRegion,
  effectiveNetworkRegion,
  latestVersionUncheckedMessage,
  networkLocationCacheTtlMs,
  networkProbeSuggestsOffline,
  offlineLatestVersionBudgetMs,
  parseCloudflareNetworkLocation,
  parseCloudflareNetworkRegion,
  parseGrokLocalVersion,
  parseLatestNpmVersion,
  readGrokLocalVersionForExecutable,
  scanProbeConcurrency,
  settleLatestVersionProbes,
} from './system-scan-service'
export type {
  CliInstallTargetOptions,
} from './system-scan-service'
// 装运行环境搬进 runtime-install-service.ts 时一起带走的那些（#1070 第 3 步），测试和别处照旧从这里拿。
export {
  nodeStillOutdatedAfterReplaceMessage,
  shouldReplaceNodeForCertificates,
} from './runtime-install-service'
// 卸载命令行工具搬进 cli-uninstall-service.ts 时一起带走的那些（#1070 第 3 步），测试和别处照旧从这里拿。
export {
  buildCliUninstallPlan,
  DarwinGrokRetainedPathsError,
  formatMebibytes,
  grokManualUninstallResult,
  uninstallVerifiedDarwinGrokInstallation,
} from './cli-uninstall-service'
export type {
  CliUninstallPlan,
  UninstallVerifiedDarwinGrokInstallationOptions,
} from './cli-uninstall-service'

/** 打开 Codex 之前在本机看一眼型号名单，最多等这么久。 */
const codexModelCatalogLaunchGuardMs = 3_000

/** 等 promise 落定，最多等 ms 毫秒：到点就不等了，它自己接着跑完。从不抛错。 */
export function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    function done(): void {
      clearTimeout(timer)
      resolve()
    }
    promise.then(done, done)
  })
}

/**
 * Codex 桌面端装的时候每一步原来只发给界面，「安装卸载」页的安装日志卡还看得见；那一页
 * 拆掉以后（界面 v4 第 10 批）要落进运行日志，客服才看得出卡在哪一步、商店那一路换没换
 * 官网离线包。下载百分比和已等秒数每跳一次就是一条，按去掉数字以后的话去重，同一句只记一次。
 */
export function codexDesktopProgressLogKey(progress: CodexDesktopInstallProgress): string {
  return `${progress.phase}:${progress.message.replace(/\d+(?:\.\d+)*/g, '#')}`
}

function isCodexDesktopInstallProgress(value: unknown): value is CodexDesktopInstallProgress {
  return typeof value === 'object' && value !== null
    && typeof (value as { phase?: unknown }).phase === 'string'
    && typeof (value as { message?: unknown }).message === 'string'
}

/**
 * 包一层发给界面的目标，安装进度照发，同时按 codexDesktopProgressLogKey 去重后交给 log。
 * 失败那一条不交：ipc 层已经把「Codex 桌面端安装失败：…」记成错误，再记一遍错误数会多算。
 */
export function withCodexDesktopProgressLog(
  target: RendererMessageTarget,
  log: (progress: CodexDesktopInstallProgress) => void,
): RendererMessageTarget {
  let lastKey: string | null = null
  return {
    isDestroyed() {
      return target.isDestroyed()
    },
    send(channel, payload) {
      if (channel === 'desktop:codex-install-progress' && isCodexDesktopInstallProgress(payload) && payload.phase !== 'error') {
        const key = codexDesktopProgressLogKey(payload)
        if (key !== lastKey) {
          lastKey = key
          log(payload)
        }
      }
      target.send(channel, payload)
    },
  }
}

export function createSystemService(
  store: AppSettingsStore,
  serviceOptions: SystemServiceOptions = {},
): SystemService {
  const context = createServiceContext(store, serviceOptions)
  const {
    platform, providerRoots, runtimeLog,
    serializeConfigWrite,
    codexEnv, relayRouting, inspectNativeProviderConfig,
    executeCommand, detectMacosCodexApp,
    downloadFetch,
    withDownloadAcceleration, desktopBucketDownloads, latestMacosDesktopVersions,
    installationQueue,
    createInstallTemporaryDirectory, assertInstallDiskSpace,
    fetchAvailableModels,
  } = context
  const providerEnvironment = (provider: ProviderId): NodeJS.ProcessEnv =>
    providerCommandEnvironment(provider, process.env, codexEnv)
  // 三个外部桌面客户端那一段在 external-client-route-service.ts（#1070 第 3 步）。
  const {
    scanExternalClients,
    cachedExternalClients,
    getLastExternalClients,
    installExternalClient,
    cancelExternalClientInstall,
    launchExternalClient,
    checkExternalClientConnection,
    configureExternalTool,
    switchExternalClientSource,
    recheckPendingExternalRoutes,
    followManagedKeysNow,
    cancelPendingExternalRouteRecheck,
  } = createExternalClientRouteService(context, {
    fetchAvailableModels,
  })
  // Owns the Codex Desktop version-probe caches and the install/uninstall/
  // launch busy lock in its own closure; only the pieces that cross the
  // CLI-launch trust boundary or touch the shared installation queue are
  // threaded through explicitly.
  const {
    inspectCodexDesktop,
    inspectCodexDesktopUpdate,
    installCodexDesktop: installCodexDesktopOperation,
    cancelCodexDesktopInstall,
    uninstallCodexDesktop: uninstallCodexDesktopOperation,
    resetCodexDesktop,
    launchCodexDesktop: launchCodexDesktopOperation,
  } = createCodexDesktopService({
    platform,
    installationQueue,
    createInstallTemporaryDirectory,
    detectMacosCodexApp,
    executeCommand,
    codexEnv,
    store,
    inspectNativeProviderConfig,
    spawnDetached,
    downloadFetch,
    reloadDownloadProxyConfig,
    prepareAcceleration: serviceOptions.prepareCodexDesktopAcceleration,
    prepareStartupRoute: serviceOptions.prepareCodexDesktopStartupRoute,
    assertInstallDiskSpace,
    // 官方包在海外：Mac 上那次下载、Windows 上商店没走通后的官网离线安装包，都和 OpenCode
    // 一样临时接上下载线路。Windows 的国内镜像那一路用不着它。
    withDownloadRoute: (operation) => withDownloadAcceleration(null, operation),
    bucketDownloads: desktopBucketDownloads,
    userHome: providerRoots.userHome,
    ...(latestMacosDesktopVersions ? { latestMacosDesktopVersions } : {}),
    // 中文增强没开起来时，启动那边改走普通启动，只往控制台打一句，打包版不留控制台；原错误（连同 PowerShell 那层）记在这一条里。
    activateCodexDesktopWithCdp: withCodexDesktopCdpFailureReport(activateCodexDesktopWithCdp, (error) => runtimeLog?.log(
      'warn', 'system', 'codex-desktop.chinese-launch.failed', 'Codex 桌面端中文增强启动没成，改走普通启动', { error },
    )),
    // Codex 起来了但中文没核对上：客户只看到一句固定的话，原因（没找到页面、超时、端口归属）记在这一条里。
    injectCodexDesktopChineseLocale: withCodexDesktopLocaleFailureReport(injectCodexDesktopChineseLocale, (error) => runtimeLog?.log(
      'warn', 'system', 'codex-desktop.chinese-locale.unverified', 'Codex 桌面端打开了，但中文没核对上', { error },
    )),
  })
  // 首页检测那一段在 system-scan-service.ts（#1070 第 3 步）。
  const {
    inspectNetworkRegion,
    refreshNetworkLocation,
    inspectTool,
    withToolCertificateHint,
    inspectNode,
    inspectCliTool,
    inspectPython,
    inspectGit,
    invalidateCliUpdateCache,
    inspectRunningTools,
    inspectCliUpdate,
    refreshOfficialChatGptUsage,
    coalescedScan,
    scanSystem,
    cachedScan,
    inspectCodexSetupStatus,
  } = createSystemScanService(context, {
    providerEnvironment,
    inspectCodexDesktop,
    inspectCodexDesktopUpdate,
  })
  // 换线路时定点改写命令行工具配置那一段在 tool-route-follow-service.ts（#1070 第 3 步）。
  const {
    followToolRoutes,
    noteRouteFollowRestart,
    accountRouteFollowed,
    accountRouteFaultFollowed,
    writeToolRouteRecord,
    toolRouteSummaryFields,
    routeLineSnapshotFields,
    toolRouteSnapshotFields,
    disposeToolRoutes,
    bindToolRouteAccount,
  } = createToolRouteFollowService(context, {
    inspectRunningTools,
    cancelPendingExternalRouteRecheck,
  })
  // 官方账号与当前账号来回切、挪开或放回官方 Console Key 那一段在 official-credential-service.ts（#1070 第 3 步）。
  const {
    restoreOfficialCredentialsNow,
    moveOfficialCredentialsAside,
    withCredentialUndo,
    applyXingmangAiSkillForCodexAccount,
    switchToOfficialAccount,
    adoptRestoredConfig,
    setOfficialSourcePreference,
    alignRestoredAccountSource,
    restoreOfficialCredentials,
  } = createOfficialCredentialService(context)
  // 保存配置、钩子、型号名单和开机补设置那一段在 config-save-service.ts（#1070 第 3 步）。
  const {
    refreshGrokHooksForShellChange,
    addMissingGrokHooks,
    takeBackUnreadableCodexModelCatalog,
    forgetCodexModelCatalogReaders,
    rememberedWorkspaceFor,
    repairGrokHooksBeforeLaunch,
    buildConfigSummary,
    inspectCodexReadiness,
    revealApiKey,
    saveConfig,
    repairCliHooks,
    autoRepairStaleCliHooks,
    toolModelChecker,
    guardCodexModelCatalogAtStartup,
    reclaimRetiredToolIntegrations,
    fillToolTemplateDefaultsThenSyncPickers,
    stopTemplateFillWaits,
  } = createConfigSaveService(context, {
    inspectCliTool,
    inspectRunningTools,
    followManagedKeysNow,
    accountRouteFollowed,
    accountRouteFaultFollowed,
    writeToolRouteRecord,
    toolRouteSummaryFields,
    restoreOfficialCredentialsNow,
    moveOfficialCredentialsAside,
    withCredentialUndo,
    applyXingmangAiSkillForCodexAccount,
  })
  // 装运行环境和重启 Windows 那一段在 runtime-install-service.ts（#1070 第 3 步）。
  const { installNodeRuntime, inspectWindowsProcessor, restartWindows, installPythonRuntime, installGitRuntime } = createRuntimeInstallService(context, {
    inspectNetworkRegion,
    inspectTool,
    inspectNode,
    inspectPython,
    inspectGit,
    refreshGrokHooksForShellChange,
    addMissingGrokHooks,
  })

  // 装和更新命令行工具那一整段在 cli-install-service.ts（#1070 第 2 步）。
  const { installCli, cancelCliInstall, cleanupInstallLeftovers } = createCliInstallService(context, {
    inspectNetworkRegion,
    withToolCertificateHint,
    inspectCliTool,
    invalidateCliUpdateCache,
    installGitRuntime,
    takeBackUnreadableCodexModelCatalog,
  })

  // 卸载命令行工具那一段在 cli-uninstall-service.ts（#1070 第 3 步）。
  const { uninstallCli, cleanUninstallLeftovers } = createCliUninstallService(context, {
    inspectCliTool,
    invalidateCliUpdateCache,
    forgetCodexModelCatalogReaders,
  })

  function spawnDetached(
    executable: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide?: boolean },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { ...options, detached: true, stdio: 'ignore' })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  }

  // A Chromium proxy reload has no AbortSignal, so the Codex Desktop install
  // must not await it unbounded -- reuse the same bounded wrapper the network
  // location refresh uses.
  function reloadDownloadProxyConfig(): Promise<void> {
    const reload = serviceOptions.reloadNetworkProxyConfig
    if (!reload) return Promise.resolve()
    return reloadNetworkProxyConfiguration(reload)
  }

  async function installCodexDesktop(target: RendererMessageTarget, request?: DesktopAppUpdateRequest): Promise<CodexDesktopInstallResult> {
    let result: CodexDesktopInstallResult
    try {
      result = await installCodexDesktopOperation(withCodexDesktopProgressLog(target, (progress) => runtimeLog?.log(
        'info', 'install', 'codex-desktop.install.progress', progress.message, { phase: progress.phase },
      )), request)
    } finally {
      // 桌面端换了一批，自带的 Codex 也跟着换了：读不进型号名单的话开不了新对话。
      await takeBackUnreadableCodexModelCatalog('desktop-installed')
    }
    // A successful manual install is an explicit opt-in again. The setting is
    // cleared only after the desktop package has been verified by the service.
    await store.update({ version: 2, codexDesktopInstallDisabled: false })
    return result
  }

  async function uninstallCodexDesktop(): Promise<ToolUninstallResult> {
    const result = await uninstallCodexDesktopOperation().finally(forgetCodexModelCatalogReaders)
    if (result.outcome === 'uninstalled') {
      await store.update({ version: 2, codexDesktopInstallDisabled: true })
    }
    return result
  }

  // 打开工具（命令行工具和 Codex 桌面端）那一段在 provider-launch-service.ts（#1070 第 3 步）。
  const {
    launchCodexDesktop,
    launchProvider,
    inspectCodexDesktopLocale,
    inspectCodexWorkspacePermissionsForService,
    trustCodexWorkspaceForService,
    setCodexDesktopLocale,
  } = createProviderLaunchService(context, {
    providerEnvironment,
    inspectCodexDesktop,
    launchCodexDesktopOperation,
    inspectCliTool,
    rememberedWorkspaceFor,
    repairGrokHooksBeforeLaunch,
  })

  return {
    readStoredConfig: () => ({ ...store.read(), activeRelayEndpointIds: { ...relayRouting.preferences },
      ...routeLineSnapshotFields(), ...toolRouteSnapshotFields(),
      ...(serviceOptions.getRelaySiteId ? { relaySiteId: serviceOptions.getRelaySiteId() } : {}) }),
    updateStoredConfig: async (update) => ({ ...await store.update(update), activeRelayEndpointIds: { ...relayRouting.preferences },
      ...routeLineSnapshotFields(), ...toolRouteSnapshotFields() }),
    followToolRoutes,
    noteRouteFollowRestart,
    bindToolRouteAccount,
    recheckPendingExternalRoutes,
    disposeToolRoutes,
    inspectCodexReadiness,
    getConfig: buildConfigSummary,
    revealApiKey,
    saveConfig,
    serializeToolConfigWrite: serializeConfigWrite,
    repairCliHooks,
    autoRepairStaleCliHooks,
    switchToOfficialAccount,
    setOfficialSourcePreference,
    restoreOfficialCredentials,
    inspectOfficialLogin: (provider) => inspectOfficialLogin(provider, providerRoots),
    adoptRestoredConfig,
    alignRestoredAccountSource,
    scanSystem,
    recentScan: (maxAgeMs: number) => coalescedScan.recent(maxAgeMs),
    cachedScan,
    refreshNetworkLocation,
    refreshOfficialChatGptUsage,
    inspectCodexSetupStatus,
    installNodeRuntime,
    inspectWindowsProcessor,
    restartWindows,
    installPythonRuntime,
    installGitRuntime,
    installCli,
    cancelCliInstall,
    uninstallCli,
    cleanUninstallLeftovers,
    inspectCliUpdate,
    installCodexDesktop,
    cancelCodexDesktopInstall,
    uninstallCodexDesktop,
    resetCodexDesktop,
    inspectCodexDesktopUpdate,
    launchProvider,
    inspectCodexDesktop,
    inspectCodexDesktopLocale,
    inspectCodexWorkspacePermissions: inspectCodexWorkspacePermissionsForService,
    trustCodexWorkspace: trustCodexWorkspaceForService,
    setCodexDesktopLocale,
    launchCodexDesktop,
    inspectRunningTools,
    checkToolModels: async (provider: ProviderId) => {
      // 打开前那次核对一天只有一回，还要联网；命令行在星芒开着时被换成了旧版，名单读不进
      // 它就起不来，所以每次打开前先在本机看一眼。最多等这么久，打开的人在等；没看完的
      // 自己在后台接着做完。
      if (provider === 'codex') await settleWithin(takeBackUnreadableCodexModelCatalog('before-launch'), codexModelCatalogLaunchGuardMs)
      return toolModelChecker.check(provider)
    },
    guardCodexModelCatalogAtStartup,
    reclaimRetiredToolIntegrations,
    fillToolTemplateDefaults: fillToolTemplateDefaultsThenSyncPickers,
    stopTemplateFillWaits,
    fetchAvailableModels,
    configureExternalTool,
    scanExternalClients,
    cachedExternalClients,
    getLastExternalClients,
    checkExternalClientConnection,
    installExternalClient,
    cancelExternalClientInstall,
    launchExternalClient,
    switchExternalClientSource,
    inspectInstallationQueue: () => installationQueue.snapshot(),
    onInstallationQueueChange: (listener) => installationQueue.onChange(listener),
    cleanupInstallLeftovers,
  }
}
