import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type AppSettings, type AppSettingsUpdate, AppSettingsStore, type RelayToolRouteStatus } from './app-settings'
import type { RuntimeLogLike } from './account-session-store'
import type { NodeRuntimeInstallRequest } from './ipc-contract'
import type { LoopbackProbe } from './stale-proxy-environment'
import { activeProviderIds, isRetiredProviderId, providerIds, type ProviderId } from './catalog'
import {
  type CliVersionAdvice,
} from './cli-verified-versions'
import type { ProviderConfigRoots } from './codex-home'
import {
  findExecutable,
  isUserWritablePath,
  redactCommandText,
  runCommand,
} from './command-runner'
import { emptyRunningToolsReport, type RunningToolsReport } from './running-tools'
import { createToolModelChecker, type ToolModelCheck, type ToolModelCheckTarget } from './tool-model-check'
import { isRetiredCliModel, type CliModelHints } from './cli-model-defaults'
import { errorCodeClause } from './failure-wording'
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
import { buildClaudeStatusLineCommand } from './claude-status-line'
import { buildCliHookInvocation, cliHookEventsDirectory, cliHookTargetsStale, grokCliHookCommand, grokCliHookShellChanged, resolveGrokWindowsShell, type CliHookInvocation, type GrokWindowsShell } from './cli-hooks'
import { withAppendedWindowsPath } from './windows-live-path'
import { activateCodexDesktopWithCdp, injectCodexDesktopChineseLocale, withCodexDesktopCdpFailureReport, withCodexDesktopLocaleFailureReport } from './codex-desktop-cdp'
import type { CodexDesktopStartupRoute } from './codex-desktop-startup-route'
import {
  createCodexDesktopService,
  inspectCodexDesktopPackage,
  type CodexDesktopInstallProgress,
  type CodexDesktopInstallResult,
  type CodexDesktopPackageProbe,
} from './codex-desktop-service'
import {
  buildCodexRelayModelCatalog,
  codexCliAcceptsModelCatalog,
  codexDesktopAcceptsModelCatalog,
  codexModelCatalogContent,
  codexModelCatalogListsModel,
  codexModelCatalogRequiredCliVersion,
  combineCodexModelCatalogVerdicts,
  parseCodexModelCatalog,
  readBundledCodexModelCatalog,
  type CodexDesktopCatalogProbe,
  type CodexModelCatalog,
  type CodexModelCatalogVerdict,
  type ParsedCodexModelCatalog,
} from './codex-model-catalog'
import {
  inspectOfficialLogin,
  claudeModelPickerNeedsRefresh,
  classifyCodexConfigProfile,
  codexModelCatalogNeedsRefresh,
  codexModelCatalogTargetUsable,
  inspectCodexModelCatalogOnDisk,
  takeBackCodexModelCatalog,
  inspectManagedCliHookTargets,
  inspectProviderConfig,
  inspectRetiredGeminiIntegrations,
  moveClaudeConsoleKeyAside,
  restoreClaudeConsoleKey,
  rewriteManagedCliHooks,
  saveProviderConfig,
  applyProviderModelReplace,
  applyProviderPickerRefresh,
  planProviderModelReplace,
  planProviderPickerRefresh,
  codexOfficialAliasPending,
  fillRelayTemplateDefaults,
  forgetStaleGeminiUsageStatisticsRecord,
  relayTemplateDefaultsPending,
  relayTemplateRevision,
  removeRetiredGeminiIntegrations,
  restoreCodexOfficialAlias,
  switchProviderToOfficialAccount,
  toNativeConfigSummary,
  type CodexWorkspacePermissionStatus,
  type CodexWorkspacePermissionWriteResult,
  type NativeConfigInspection,
  type NativeConfigSaveMode,
  type NativeConfigSummary,
  type RetiredGeminiIntegrations,
} from './config-files'
import { resolveRememberedWorkspace } from './workspace-guard'
import {
  fetchOfficialChatGptUsage,
  type OfficialChatGptAccount,
  type OfficialChatGptWindow,
} from './official-account-usage'
import { parseModelIds } from './models'
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
import { inspectCcSwitchInstalled, resolveCcSwitchLeftover, type CcSwitchLeftover } from './cc-switch-leftover'
import { type ToolConfigOwnership, type ToolTemplateFillResult } from './tool-config-ownership'
import { isReplacedManagedKey, type StoredManagedCliKey } from './managed-cli-key-store'
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
import { readBoundedResponseText } from './bounded-response'
import { launchMacosTerminal } from './macos-platform'
import { launchLinuxTerminal } from './linux-terminal'
import {
  relayApiProbeBaseUrl,
  relayProviderBaseUrlEquals,
  relaySiteEndpointIdForBaseUrl,
  relaySiteForProviderBaseUrl,
  type RelayEndpointRoutingSnapshot,
  type RelayRouteLines,
  type RelayRouteSiteId,
  type RelaySite,
} from './relay-sites'
import type { RelayRouteChange } from './relay-route-controller'
import { inspectMacosCodexApp, type MacosCodexAppInfo, type MacosCodexAppInspection } from './macos-codex-app'
import {
  installMacGitRuntime,
} from './macos-git-install'
import { adoptRestoredXingmangAiSkillOff, syncXingmangAiSkillCodexAvailability } from './xingmang-ai-skill'
import {
  type ExternalToolConfigOptions,
  type ExternalToolId,
} from './external-tool-config'
import { type ExternalClientConfigResult, type ExternalClientSourceSwitchResult, type ExternalClientStatus, type ExternalClientRuntimeStatus } from './external-client-contract'
import { createExternalClientRuntime } from './external-client-runtime'
import { type ExternalClientCheckResult } from './external-client-connection'
import {
  buildDarwinTrustedVerificationRunner,
  buildToolStatusFromSettled,
  createServiceContext,
  sameNativeConfigSnapshot,
  scanReuseMs,
} from './system-service-context'
import { createCliInstallService } from './cli-install-service'
import { createToolRouteFollowService } from './tool-route-follow-service'
import { createExternalClientRouteService } from './external-client-route-service'
import { createProviderLaunchService, providerCommandEnvironment } from './provider-launch-service'
import { createSystemScanService } from './system-scan-service'
import { createRuntimeInstallService } from './runtime-install-service'
import { createCliUninstallService } from './cli-uninstall-service'
import { inspectClaudeDesktopStoreVirtualization } from './claude-desktop-manifest'
import { isServiceUnavailableResponse, networkFailureMessages, parsesAsJsonObject } from './network-failure'
import { modelProbeFailurePrefix } from './relay-quota-failure'
import { carryRequestDiagnostics, noteRequestDiagnostics, responseDiagnostics, type RequestDiagnostics } from './request-diagnostics'
import { NewApiNetworkError } from './new-api-client'

const maximumModelResponseBytes = 1024 * 1024
const modelAccessCacheMaxEntries = 32

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
  installCodexDesktop(target: RendererMessageTarget): Promise<CodexDesktopInstallResult>
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
  installExternalClient(tool: ExternalToolId, target: RendererMessageTarget): Promise<ExternalClientStatus>
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

export function modelAccessCacheKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex')
}

function safeRelayErrorMessage(value: string, apiKey: string): string {
  return redactCommandText(value, [apiKey])
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
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

/**
 * 恢复备份是用户点名的动作：恢复出来的配置不该在下一次扫描时被当成「被人改过」，
 * 也不该被自动写 Key 的流程悄悄覆盖。所以恢复后按恢复出来的那份重新登记来源：
 * Key 正是当前账号由本软件签发的那把，记成账号来源（和本软件自己写的一样）；
 * 其余一律记成手动来源（和「就用现在这份」同一个意思，以后不提示、不自动改写）。
 * 返回 null = 不用登记：没有 Key 时来源本来就读成未配置 / 未知，已经对得上的记录
 * 也不必重写。
 */
export function planRestoredConfigOwnership(input: {
  current: ToolConfigOwnership
  hasApiKey: boolean
  matchesRelay: boolean
  owner: string | null
  isAccountKey: boolean
}): 'account' | 'manual' | null {
  if (!input.hasApiKey) return null
  if (input.current === 'account' || input.current === 'manual') return null
  return input.owner && input.matchesRelay && input.isAccountKey ? 'account' : 'manual'
}

/**
 * 备份页恢复出来的这份配置是哪一边的（#1080），「选了官方账号」的记号和 Claude 的官方 Key
 * 照它对齐。只认两种看得准的，口径跟首页 sourceFor 对得上，只是更保守：
 * - 'account'：地址是当前账号所在的站，带着 Key。
 * - 'official'：官方登录的样子。Codex 是 ChatGPT 登录、没有接到别的连接上；其余工具什么 Key 和
 *   地址都没写。Grok 的 config.toml 装好就有，还要真有一份 Grok 登录才算。
 * 别家中转、半截的（ChatGPT 令牌配着中转地址）、工具自己都读不了的，返回 null，一样都不动。
 */
export function restoredAccountSide(
  provider: ProviderId,
  restored: Pick<NativeConfigInspection, 'exists' | 'hasApiKey' | 'matchesRelay' | 'actualBaseUrl'
    | 'codexAuthMode' | 'configBroken' | 'codexAuthBroken' | 'grokLoginMode'>,
): 'account' | 'official' | null {
  if (isRetiredProviderId(provider)) return null
  if (restored.configBroken === true || restored.codexAuthBroken === true) return null
  if (provider === 'codex' && restored.codexAuthMode === 'chatgpt') return restored.actualBaseUrl ? null : 'official'
  if (restored.hasApiKey && restored.matchesRelay) return 'account'
  if (!restored.exists || restored.hasApiKey || restored.actualBaseUrl) return null
  if (provider === 'grok' && !restored.grokLoginMode) return null
  return 'official'
}

/**
 * 老版本写下的 Codex 配置把当前账号的服务放在 openai 这类内置名下，Codex 不认那张表，
 * 一打开就 401；这种配置往往没有归属记录，平常会被「来源未经确认就不自动改写」挡住。
 * 只在三件事都对得上时让开机那一轮自动修（yoyo 9-30 同意第十七批 1b）：地址是当前站、
 * 配置里的 Key 正是这次要写入的当前账号 Key、写入只把那张表搬到我们自己的连接名下。
 * 「被改过」（changed）和手动来源不在其列：那是用户动过的配置，照旧只给按钮。
 */
export function permitsShadowedCodexRepair(
  provider: ProviderId,
  before: Pick<NativeConfigInspection, 'hasApiKey' | 'matchesRelay' | 'apiKey' | 'codexProviderShadowed'>,
  previousOwnership: ToolConfigOwnership,
  apiKey: string,
): boolean {
  const key = apiKey.trim()
  return provider === 'codex' && previousOwnership === 'unknown' && before.codexProviderShadowed === true
    && before.hasApiKey && before.matchesRelay && key.length > 0 && before.apiKey === key
}

/** 看不出来就不带这个字段，旧的快照与测试夹具不用跟着改。 */
export function ccSwitchLeftoverField(leftover: CcSwitchLeftover | null): { ccSwitchLeftover?: CcSwitchLeftover } {
  return leftover ? { ccSwitchLeftover: leftover } : {}
}

/** 首页「提醒设置要修」那两项；「换了命令行」只在真换了时才带，旧快照和测试夹具不用跟着改。null = 引导预览，一律不报。 */
export function cliHooksSummaryFields(
  state: { stale: boolean; shellChanged: boolean; missing?: boolean } | null,
): { cliHooksStale: boolean; cliHooksShellChanged?: true; cliHooksMissing?: true } {
  if (!state) return { cliHooksStale: false }
  if (state.shellChanged) return { cliHooksStale: true, cliHooksShellChanged: true }
  return !state.stale && state.missing ? { cliHooksStale: false, cliHooksMissing: true } : { cliHooksStale: state.stale }
}

/**
 * Windows 上只装 Grok 时不装运行环境（#695），那时钩子写不出来，配置照写，Grok 于是少了做完提醒和
 * 防睡两项。只认本软件替当前账号写的那份（连着星芒、有 Key）；推到 cmd 本来就不写，不算缺。
 * Mac 上的 Grok 从 npm 装，没有运行环境装不上，不会走到这里。
 */
export function grokCliHooksMissing(input: {
  platform: NodeJS.Platform
  provider: ProviderId
  managedTargets: number
  relayConfigured: boolean
  shell: GrokWindowsShell | null
}): boolean {
  return input.platform === 'win32' && input.provider === 'grok' && input.managedTargets === 0
    && input.relayConfigured && input.shell !== null && input.shell !== 'cmd'
}

/**
 * 开机发现的旧钩子要不要不等客户点就改掉（第十八批 1b，yoyo 2026-09-30 同意）：只改本账号写的、
 * 这次启动还没试过的那份。别处来的配置、被改过的配置不自动动，首页照旧给「修好它」；
 * 试过一次没修好的也不再反复试，免得每次读配置都去改文件。
 */
export function shouldAutoRepairCliHooks(input: {
  stale: boolean
  ownership: ToolConfigOwnership
  attempted: boolean
}): boolean {
  return input.stale && !input.attempted && input.ownership === 'account'
}

/** 这次启动替用户改好了、而且现在确实不再指向旧位置，才带这个字段；旧快照和测试夹具不用跟着改。 */
export function cliHooksAutoRepairedField(autoRepaired: boolean, stale: boolean): { cliHooksAutoRepaired?: true } {
  return autoRepaired && !stale ? { cliHooksAutoRepaired: true } : {}
}

/**
 * Windows 上桌面端是哪一批：Appx 探测明确报了「没有」才算没装，报错、没下结论都算看不出
 * （同 codex-desktop-service.ts 判卸载干净的口径）。
 */
export function codexDesktopCatalogProbeFromPackage(probe: CodexDesktopPackageProbe): CodexDesktopCatalogProbe {
  if (probe.value) return { installed: true, version: probe.value.version }
  return probe.confirmedAbsent === true && !probe.error ? { installed: false, version: null } : { installed: null, version: null }
}

/** Mac 上同理：检测没跑完（detectionFailed）就是看不出，不当没装。 */
export function codexDesktopCatalogProbeFromMacosApp(inspection: MacosCodexAppInspection): CodexDesktopCatalogProbe {
  if (inspection.app) return { installed: true, version: inspection.app.version }
  return inspection.detectionFailed ? { installed: null, version: null } : { installed: false, version: null }
}

/** 读本软件写的 Codex 型号名单的是哪几份 Codex：命令行、桌面端自带的那份，或两边都看。 */
type CodexModelCatalogReaders = 'cli' | 'desktop' | 'all'

type CodexModelCatalogGuardTrigger = 'cli-installed' | 'desktop-installed' | 'startup' | 'before-launch'

/** 收回读不进的名单时只看这次可能变了的那一边：装了命令行只看命令行，开机两边都看。 */
const codexModelCatalogGuardReaders: Record<CodexModelCatalogGuardTrigger, CodexModelCatalogReaders> = {
  'cli-installed': 'cli',
  'desktop-installed': 'desktop',
  startup: 'all',
  'before-launch': 'cli',
}

/** 打开 Codex 之前在本机看一眼型号名单，最多等这么久。 */
const codexModelCatalogLaunchGuardMs = 3_000

/**
 * 补设置这一轮看哪些：开机那轮（连同联网后、开通订阅后补跑的那几次）什么都看；渲染层
 * 隔一阵来补做（retry）时只看开机那轮因为工具可能开着而欠下的（第二十六批 E）。
 */
interface TemplateFillRound {
  retry: boolean
  providers: readonly ProviderId[]
  codexModelCatalog: boolean
}

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
 * 等 start() 起的活落定，signal 一停就不等了（按停下的原因拒绝），活自己接着跑完、结果没人要；
 * 已经停了就不起。给只读的本机探测用：起出去的进程收不回来，放着跑完无害，等它的人不必陪着。
 */
export function unlessStopped<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const work = start()
    function stop(): void {
      reject(signal.reason)
    }
    signal.addEventListener('abort', stop, { once: true })
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

/**
 * 同一个本机探测在 ttlMs 内复用上一次的结果（同时只跑一遍）；forget 之后下一次重新探。
 * probe 自己不该抛错：抛了也会被复用到过期为止。
 */
export function createCachedProbe<T>(probe: () => Promise<T>, ttlMs: number, now: () => number = () => Date.now()) {
  let cached: { at: number; result: Promise<T> } | null = null
  return {
    read(): Promise<T> {
      const at = now()
      // 系统时间往回拨过也重新探，不能让上一次的结论一直用下去。
      if (!cached || at - cached.at >= ttlMs || at < cached.at) cached = { at, result: probe() }
      return cached.result
    },
    forget(): void {
      cached = null
    },
  }
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
    configOwnership, toolRouteFollow, serializeConfigWrite,
    codexEnv, relayRouting, activeRelaySite, providerRelaySite, inspectNativeProviderConfig,
    executeCommand, detectMacosCodexApp,
    downloadFetch,
    withDownloadAcceleration, desktopBucketDownloads,
    installationQueue,
    createInstallTemporaryDirectory, assertInstallDiskSpace,
    findInstalledExecutable,
    credentialFailureReason,
    refreshWindowsLivePath, currentWindowsLivePath,
    untouchedSince,
  } = context
  // 这次启动替用户改过的钩子（第十八批 1b）：试过的不再试，改好的让首页说一句。只在内存里，重开软件从头算。
  const autoRepairAttemptedCliHooks = new Set<ProviderId>()
  const autoRepairCheckedOwners = new Set<string>()
  const autoRepairedCliHooks = new Set<ProviderId>()
  let autoRepairQueue: Promise<unknown> = Promise.resolve()
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
    managedKeyFollowTarget,
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
  const modelAccessCache = new Map<string, { expiresAt: number; models: string[] }>()

  /**
   * Windows 版 Grok 找得到 Git Bash 就改用它跑钩子，原来按 PowerShell 写的那几行会每一轮报红。
   * 所以星芒装好 Git 之后，把 Grok 配置里本软件那几条钩子按新的 shell 重写一遍（只动我们
   * 写过的那几条，原来没有就不补，同「修好它」那条路）。失败只记日志，不影响装 Git。
   */
  async function refreshGrokHooksForShellChange(): Promise<void> {
    try {
      const cliHook = await resolveCliHookInvocation()
      if (!cliHook) return
      await serializeConfigWrite(async () => {
        rewriteManagedCliHooks('grok', providerRoots, { cliHook })
      })
      runtimeLog?.log('info', 'config', 'grok-hooks.rewritten', '装好 Git 后按新的命令行重写了 Grok 的钩子', { shell: cliHook.grokWindowsShell ?? null })
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'grok-hooks.rewrite-failed', '装好 Git 后重写 Grok 钩子没成功', { reason: credentialFailureReason(error) })
    }
  }

  /**
   * Windows 上只装 Grok 时没有运行环境，做完提醒和防睡的钩子写不出来（#695）。等这台电脑有了运行环境
   * （星芒装的、客户自己装的都算），就把那几条补上：装好运行环境后、打开 Grok 前、每次启动各看一眼。
   * 只补本软件替当前账号写的那份，其余设置一个字不动，写之前照旧备份。补不上只记日志，下次再看。
   */
  async function addMissingGrokHooks(trigger: 'runtime-installed' | 'before-launch' | 'startup'): Promise<boolean> {
    if (platform !== 'win32') return false
    try {
      await refreshWindowsLivePath()
      if (!managedCliHooksState('grok').missing) return false
      const owner = serviceOptions.getExternalClientAccountId?.() ?? null
      if (!owner || configOwnership.read('grok', inspectNativeProviderConfig('grok'), owner) !== 'account') return false
      const cliHook = await resolveCliHookInvocation()
      // 还是找不到运行环境：首页那句「缺什么」留着，不写文件。
      if (!cliHook || grokCliHookCommand(cliHook) === null) return false
      await serializeConfigWrite(async () => {
        rewriteManagedCliHooks('grok', providerRoots, { cliHook, addIfMissing: true })
      })
      const added = !managedCliHooksState('grok').missing
      runtimeLog?.log(added ? 'info' : 'warn', 'config', added ? 'grok-hooks.added' : 'grok-hooks.add-incomplete',
        added ? '有了运行环境，给 Grok 补上了做完提醒和防睡' : '给 Grok 补做完提醒和防睡没补上', { trigger, shell: cliHook.grokWindowsShell ?? null })
      return added
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'grok-hooks.add-failed', '给 Grok 补做完提醒和防睡没成功', { trigger, reason: credentialFailureReason(error) })
      return false
    }
  }

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

  async function installCodexDesktop(target: RendererMessageTarget): Promise<CodexDesktopInstallResult> {
    let result: CodexDesktopInstallResult
    try {
      result = await installCodexDesktopOperation(withCodexDesktopProgressLog(target, (progress) => runtimeLog?.log(
        'info', 'install', 'codex-desktop.install.progress', progress.message, { phase: progress.phase },
      )))
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

  async function fetchAvailableModels(
    apiKeyInput: string,
    options: { bypassCache?: boolean; site?: RelaySite; routed?: boolean } = {},
  ): Promise<string[]> {
    const apiKey = apiKeyInput.trim()
    if (!apiKey) throw new Error('请先填写 API Key')
    // Reject any C0/C1 control character, not just CR/LF. A relay API key is a
    // single opaque bearer token with no legitimate embedded control byte; an
    // embedded NUL otherwise reaches undici's fetch below, which throws with
    // the raw "Bearer <key…>" sequence in its message -- and redactCommandText's
    // Bearer rule stops at the first non-token char, leaving the tail past the
    // NUL in the clear in both the runtime log and the renderer-facing failure
    // reason. This one chokepoint covers both models:list and config:save (the
    // latter funnels through fetchAvailableModels before writing).
    if (/[\x00-\x1F\x7F]/.test(apiKey)) throw new Error('API Key 格式错误')

    const now = Date.now()
    for (const [key, entry] of modelAccessCache) {
      if (entry.expiresAt <= now) modelAccessCache.delete(key)
    }
    // Site id joins the cache key: the same API key can be pointed at a
    // different relay site within the 2-minute TTL (site switcher), and a
    // model list fetched from the previous site must not validate a model
    // that then gets written into a config aimed at the new site.
    const activeSite = options.site ?? activeRelaySite()
    const cacheKey = `${activeSite.id}:${relayApiProbeBaseUrl(activeSite)}:${modelAccessCacheKey(apiKey)}`
    const cached = options.bypassCache ? undefined : modelAccessCache.get(cacheKey)
    if (cached) {
      modelAccessCache.delete(cacheKey)
      modelAccessCache.set(cacheKey, cached)
      return [...cached.models]
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12_000)
    // 写 Key 前查模型没过时，日志要记得出走的哪条线路、服务器回了什么（request-diagnostics.ts）。
    let diagnostics: RequestDiagnostics | null = null
    try {
      const relayFetch = (options.routed ? serviceOptions.relayRoutedFetch : undefined) ?? serviceOptions.relayFetch ?? fetch
      const response = await relayFetch(`${relayApiProbeBaseUrl(activeSite)}/v1/models`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      })
      diagnostics = responseDiagnostics(response)
      const body = await readBoundedResponseText(response, maximumModelResponseBytes, '模型接口')
      if (!response.ok) {
        // 维护、网关错误、防护层验证页：写入 Key 与 AI 对话都经过这一步，按「服务
        // 暂时不可用」说，免得渲染层把「服务返回 503」猜成 Key 或分组出了问题。
        if (isServiceUnavailableResponse({ status: response.status, json: parsesAsJsonObject(body), headers: response.headers, bodyText: body })) {
          // 用带分类的错误，一键切换才认得出「服务在维护」而不回滚（account-source-switch.ts）。
          throw new NewApiNetworkError('serviceUnavailable', `模型查询 HTTP ${response.status}`)
        }
        let detail = ''
        try {
          const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
          const message = parsed.error?.message ?? parsed.message
          if (typeof message === 'string') detail = safeRelayErrorMessage(message, apiKey)
        } catch {
          detail = ''
        }
        const statusMessage = `${modelProbeFailurePrefix} ${response.status}`
        throw new Error((detail ? `${statusMessage}：${detail}` : statusMessage).slice(0, 500))
      }

      let payload: unknown
      try {
        payload = JSON.parse(body) as unknown
      } catch {
        throw new Error('模型接口返回的不是有效 JSON')
      }
      const models = parseModelIds(payload)
      if (!models.length) throw new Error('当前 API Key 没有返回可用模型')
      while (modelAccessCache.size >= modelAccessCacheMaxEntries) {
        const oldestKey = modelAccessCache.keys().next().value as string | undefined
        if (!oldestKey) break
        modelAccessCache.delete(oldestKey)
      }
      modelAccessCache.set(cacheKey, {
        expiresAt: Date.now() + 2 * 60_000,
        models: [...models],
      })
      return [...models]
    } catch (error) {
      noteRequestDiagnostics(error, diagnostics)
      if (error instanceof Error && error.name === 'AbortError') {
        throw carryRequestDiagnostics(error, new Error('模型查询超时，请检查网络后重试'))
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  function rememberedWorkspaceFor(workspace: string): string | null {
    return resolveRememberedWorkspace(workspace, {
      platform,
      home: providerRoots.userHome,
      defaultWorkspace: os.homedir(),
    })
  }

  function buildConfigSummary(previewOnboarding: boolean, cachedKeys: readonly StoredManagedCliKey[] = []): AppConfigSummary {
    const stored = store.read()
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    const ccSwitchInstalled = inspectCcSwitchInstalled(providerRoots.userHome)
    const rememberedWorkspace = rememberedWorkspaceFor(stored.workspace)
    const routeRecords = toolRouteFollow.read().providers
    const result = {
      workspace: stored.workspace,
      ...(rememberedWorkspace ? { rememberedWorkspace } : {}),
      providers: Object.fromEntries(
        providerIds.map((id) => {
          const current = inspectNativeProviderConfig(id)
          const hooks = previewOnboarding ? null : managedCliHooksState(id)
          return [id, {
            ...toNativeConfigSummary(current),
            configurationOwnership: configOwnership.read(id, current, owner),
            configurationAccountMatched: Boolean(owner) && current.hasApiKey && current.matchesRelay
              && cachedKeys.some((entry) => entry.provider === id && entry.key === current.apiKey),
            configurationKeyReplaced: Boolean(owner) && current.hasApiKey && current.matchesRelay
              && isReplacedManagedKey(id, current.apiKey, cachedKeys),
            ...ccSwitchLeftoverField(resolveCcSwitchLeftover(current, ccSwitchInstalled)),
            ...cliHooksSummaryFields(hooks),
            ...cliHooksAutoRepairedField(!previewOnboarding && autoRepairedCliHooks.has(id), hooks?.stale === true),
            ...(previewOnboarding ? {} : toolRouteSummaryFields(id, current, routeRecords)),
          }]
        }),
      ) as Record<ProviderId, NativeConfigSummary>,
    }
    if (previewOnboarding) {
      result.providers.codex = {
        ...result.providers.codex,
        actualBaseUrl: '',
        exists: false,
        hasApiKey: false,
        matchesRelay: false,
        configurationAccountMatched: false,
        configurationKeyReplaced: false,
        ccSwitchLeftover: undefined,
        apiKeyPreview: null,
        officialAccountEmail: null,
        officialAccountPlan: null,
        officialAccountRenewsAt: null,
        codexAuthMode: null,
        codexProviderName: null,
        codexProviderShadowed: false,
        model: '',
        updatedAt: null,
        files: result.providers.codex.files.map((file) => ({ ...file, exists: false })),
      }
    }
    return result
  }

  function inspectCodexReadiness(previewOnboarding: boolean): CodexReadinessStatus {
    if (previewOnboarding) return { hasApiKey: false, matchesRelay: false }
    const codex = inspectNativeProviderConfig('codex')
    return { hasApiKey: codex.hasApiKey, matchesRelay: codex.matchesRelay }
  }

  function revealApiKey(provider: ProviderId, previewOnboarding: boolean): string {
    if (previewOnboarding) return ''
    return inspectNativeProviderConfig(provider).apiKey
  }

  /**
   * Claude Code 的状态行命令。解析不到托管 Node、脚本没随包拷进来、路径里带 shell
   * 元字符，一律返回 undefined——状态行是锦上添花，任何一环不成立都只是「这次不写
   * 状态行」，不能让整条配置写入失败。
   */
  async function resolveClaudeStatusLineCommand(provider: ProviderId): Promise<string | undefined> {
    if (provider !== 'claude') return undefined
    const scriptPath = serviceOptions.claudeStatusLineScriptPath
    if (!scriptPath) return undefined
    try {
      const nodeExecutable = await findInstalledExecutable('node')
      if (!nodeExecutable) return undefined
      return buildClaudeStatusLineCommand(nodeExecutable, scriptPath) ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * 终端里出错、做完、等人时通知星芒的钩子。与状态行同一个口径：哪一环不成立（没有
   * 托管 Node、脚本没随包、路径带 shell 元字符）都只是这次不写，配置照写。
   */
  async function resolveCliHookInvocation(): Promise<CliHookInvocation | undefined> {
    const scriptPath = serviceOptions.cliHookScriptPath
    const dataDirectory = serviceOptions.managerDataDirectory
    if (!scriptPath || !dataDirectory) return undefined
    try {
      const nodeExecutable = await findInstalledExecutable('node')
      if (!nodeExecutable) return undefined
      const invocation = buildCliHookInvocation(nodeExecutable, scriptPath, cliHookEventsDirectory(dataDirectory), platform)
      if (!invocation) return undefined
      if (platform === 'win32') {
        await refreshWindowsLivePath()
        invocation.grokWindowsShell = expectedGrokWindowsShell()
      }
      return invocation
    } catch {
      return undefined
    }
  }

  // 随包那份官方 Codex 型号名单同一次运行里不会变，只读一次；读不成（构建残留、被替换）
  // 也不必每次保存都再试，这次运行就不写名单。
  let bundledCodexModelCatalog: ParsedCodexModelCatalog | null | undefined

  function loadBundledCodexModelCatalog(): ParsedCodexModelCatalog | null {
    if (bundledCodexModelCatalog !== undefined) return bundledCodexModelCatalog
    bundledCodexModelCatalog = null
    const filePath = serviceOptions.bundledCodexModelCatalogPath
    if (!filePath) return null
    try {
      bundledCodexModelCatalog = readBundledCodexModelCatalog(filePath)
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'codex-model-catalog.bundled-unreadable', '随包的 Codex 型号名单读不出来，这次运行不写型号名单', {
        reason: credentialFailureReason(error),
      })
      return null
    }
    if (bundledCodexModelCatalog.rejected.length) {
      runtimeLog?.log('warn', 'config', 'codex-model-catalog.bundled-rejected', '随包的 Codex 型号名单里有 Codex 读不进去的型号，已经剔掉', {
        rejected: bundledCodexModelCatalog.rejected,
      })
    }
    return bundledCodexModelCatalog
  }

  // 读 xingmang-models.json 的不只命令行，还有桌面端自带的那份 Codex：两边是哪一版都在本机
  // 探（命令行读 npm 包的版本或跑一次 --version，桌面端 Windows 问 Appx 包、Mac 看应用包）。
  // 一次保存、开机那一轮会连着问好几遍，30 秒内复用上一次的结论；星芒自己装、卸、更新过
  // 之后作废。
  const codexCliForModelCatalog = createCachedProbe(async (): Promise<{ installed: boolean; version: string | null } | null> => {
    try {
      const { status } = await inspectCliTool('codex', null, null)
      return { installed: status.installed, version: status.version }
    } catch {
      return null
    }
  }, 30_000)
  const codexDesktopForModelCatalog = createCachedProbe(async (): Promise<CodexDesktopCatalogProbe> => {
    try {
      if (serviceOptions.inspectCodexDesktopForModelCatalog) return await serviceOptions.inspectCodexDesktopForModelCatalog()
      if (platform === 'win32') return codexDesktopCatalogProbeFromPackage(await inspectCodexDesktopPackage())
      if (platform === 'darwin') return codexDesktopCatalogProbeFromMacosApp(await detectMacosCodexApp())
      return { installed: false, version: null }
    } catch {
      return { installed: null, version: null }
    }
  }, 30_000)

  function forgetCodexModelCatalogReaders(): void {
    codexCliForModelCatalog.forget()
    codexDesktopForModelCatalog.forget()
  }

  /** 读这份名单的几份 Codex 合起来能不能用它（codex-model-catalog.ts），顺带各自的版本留给日志。 */
  async function codexModelCatalogReadersVerdict(catalog: CodexModelCatalog, readers: CodexModelCatalogReaders): Promise<{
    verdict: CodexModelCatalogVerdict
    detail: Record<string, unknown>
  }> {
    const verdicts: CodexModelCatalogVerdict[] = []
    const detail: Record<string, unknown> = { required: codexModelCatalogRequiredCliVersion(catalog) }
    if (readers !== 'desktop') {
      const cli = await codexCliForModelCatalog.read()
      const verdict = cli ? codexCliAcceptsModelCatalog(cli, catalog) : 'unknown'
      verdicts.push(verdict)
      Object.assign(detail, { cli: verdict, cliVersion: cli?.version ?? null })
    }
    if (readers !== 'cli') {
      const desktop = await codexDesktopForModelCatalog.read()
      const verdict = codexDesktopAcceptsModelCatalog(desktop)
      verdicts.push(verdict)
      Object.assign(detail, { desktop: verdict, desktopVersion: desktop.version })
    }
    return { verdict: combineCodexModelCatalogVerdicts(verdicts), detail }
  }

  /**
   * 这次要给 Codex 写的型号名单（codex-model-catalog.ts）：全文 = 照写；null = 收回本软件
   * 写的那一行（账号的型号随包名单里一个都没有、默认型号不在名单里、名单文件的位置被换成了
   * 链接、这台电脑上的命令行或桌面端太旧）；undefined = 原样不动（没有随包名单、看不出
   * 命令行或桌面端是哪一版），免得一次没读到就把菜单来回改。
   */
  async function resolveCodexModelCatalog(availableModels: readonly string[], model: string): Promise<string | null | undefined> {
    const official = loadBundledCodexModelCatalog()
    if (!official) return undefined
    const catalog = buildCodexRelayModelCatalog(official, availableModels)
    if (!catalog) {
      runtimeLog?.log('info', 'config', 'codex-model-catalog.no-match', '当前账号能用的型号随包名单里都没有，Codex 用它自带的菜单', {
        models: availableModels.length,
      })
      return null
    }
    if (!codexModelCatalogListsModel(catalog, model)) {
      runtimeLog?.log('info', 'config', 'codex-model-catalog.model-not-listed', 'Codex 的默认型号不在随包名单里，这次不写型号名单', { model })
      return null
    }
    if (!codexModelCatalogTargetUsable(providerRoots)) {
      runtimeLog?.log('warn', 'config', 'codex-model-catalog.target-unsafe', 'Codex 型号名单的位置被换成了链接，这次不写型号名单')
      return null
    }
    const { verdict, detail } = await codexModelCatalogReadersVerdict(catalog, 'all')
    if (verdict === 'unknown') {
      runtimeLog?.log('info', 'config', 'codex-model-catalog.reader-unknown', '看不出 Codex 命令行或桌面端是哪一版，型号名单这次不动', detail)
      return undefined
    }
    if (verdict === 'too-old') {
      runtimeLog?.log('info', 'config', 'codex-model-catalog.reader-too-old', '这台电脑上的 Codex 命令行或桌面端太旧，读不进型号名单，这次不写', detail)
      return null
    }
    return codexModelCatalogContent(catalog)
  }

  /** Codex 那份型号名单按当前账号的型号重写会不会变；看不出该不该写的时候算没变。 */
  async function codexModelCatalogOutdated(availableModels: readonly string[], model: string): Promise<boolean> {
    const expected = await resolveCodexModelCatalog(availableModels, model)
    return expected !== undefined && codexModelCatalogNeedsRefresh(expected, providerRoots)
  }

  /**
   * 本软件写的名单该不该收回：名单文件丢了、读不进，或读它的命令行 / 桌面端太旧（只看这次
   * 可能变了的那一边）。不该收回是 null，该收回给出原因留给日志；看不出版本的算不该。
   */
  async function codexModelCatalogTakeBackReason(trigger: CodexModelCatalogGuardTrigger): Promise<Record<string, unknown> | null> {
    const onDisk = inspectCodexModelCatalogOnDisk(providerRoots)
    if (!onDisk.managed) return null
    let catalog: ParsedCodexModelCatalog | null = null
    try {
      catalog = onDisk.content === null ? null : parseCodexModelCatalog(onDisk.content)
    } catch {
      catalog = null
    }
    if (!catalog || catalog.rejected.length) return { reason: onDisk.content === null ? 'missing' : 'unreadable' }
    const readers = await codexModelCatalogReadersVerdict(catalog, codexModelCatalogGuardReaders[trigger])
    return readers.verdict === 'too-old' ? { reason: 'too-old', ...readers.detail } : null
  }

  /**
   * 不看账号、不联网，只看本机，读不进就收回 config.toml 里那一行（名单文件留着）：Codex 读
   * 不进名单整个起不来，这一步不能等联网核对，也不管工具开没开。失败只记日志。
   */
  async function takeBackUnreadableCodexModelCatalog(trigger: CodexModelCatalogGuardTrigger): Promise<void> {
    if (!serviceOptions.bundledCodexModelCatalogPath) return
    try {
      // 打开前那次有人在等：名单好好的（绝大多数时候）就不必排在别的写入后面。装完那两次
      // 不能这样省：正在进行的保存可能拿装之前探的版本写下那一行，要等它写完再看。
      if (trigger === 'before-launch' && !(await codexModelCatalogTakeBackReason(trigger))) return
      await serializeConfigWrite(async () => {
        if (trigger === 'cli-installed' || trigger === 'desktop-installed') {
          // 刚装完的那一边要重新探，不能用装之前那次的结论；当天那次核对说的「名单该不该写」
          // 也跟着作废，版本够了下次打开就补上。
          forgetCodexModelCatalogReaders()
          toolModelChecker.forget('codex')
        }
        // 进锁以后按同一套条件再判一次：排队期间配置可能刚被重写过。
        const detail = await codexModelCatalogTakeBackReason(trigger)
        if (detail && takeBackCodexModelCatalog(providerRoots)) {
          runtimeLog?.log('info', 'config', 'codex-model-catalog.taken-back', 'Codex 读不进本软件写的型号名单，已经收回 config.toml 里那一行', { trigger, ...detail })
        }
      })
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'codex-model-catalog.take-back-failed', '没能收回 Codex 读不进的型号名单', { trigger, reason: credentialFailureReason(error) })
    }
  }

  // 开机那次只做一遍：没登录的由 main.ts 在开机后调，登录状态下开机那轮按账号同步也先等它，
  // 两边共用这一次，不为同一件事问两遍命令行和桌面端。
  let startupCodexModelCatalogGuard: Promise<void> | null = null
  function guardCodexModelCatalogAtStartup(): Promise<void> {
    startupCodexModelCatalogGuard ??= takeBackUnreadableCodexModelCatalog('startup')
    return startupCodexModelCatalogGuard
  }

  /**
   * Gemini CLI 下线后，星芒以前写进它 settings.json 的做完提醒和画图工具没人跟着改了：星芒换了
   * 位置或被卸掉，Gemini 每一轮都会多报一行错。每次开机看一眼，有就收回（config-files.ts 的
   * removeRetiredGeminiIntegrations），收过了就什么都不写。Gemini 开着时它可能正在写同一个文件，
   * 和补设置同一套规矩：开着或看不出开没开的这次不动。
   */
  async function reclaimRetiredToolIntegrations(): Promise<RetiredGeminiIntegrations> {
    const none: RetiredGeminiIntegrations = { hooks: false, imageMcp: false }
    try {
      const pending = inspectRetiredGeminiIntegrations(providerRoots)
      if (!pending.hooks && !pending.imageMcp) return none
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'retired-integrations.unreadable', 'Gemini CLI 的设置读不懂，星芒写进去的提醒和画图这次没收回', { reason: credentialFailureReason(error) })
      return none
    }
    let report: RunningToolsReport
    try {
      report = await (serviceOptions.inspectRunningToolsForTemplateFill ?? inspectRunningTools)(['gemini'])
    } catch {
      report = { ...emptyRunningToolsReport, unknown: ['gemini'] }
    }
    if (report.running.includes('gemini') || report.unknown.includes('gemini')) {
      runtimeLog?.log('info', 'config', 'retired-integrations.deferred', 'Gemini CLI 可能正开着，星芒写进去的提醒和画图下次开机再收回')
      return none
    }
    try {
      const removed = await serializeConfigWrite(async () => removeRetiredGeminiIntegrations(providerRoots))
      if (removed.hooks || removed.imageMcp) {
        runtimeLog?.log('info', 'config', 'retired-integrations.removed', '已收回星芒写进 Gemini CLI 的提醒和画图', { hooks: removed.hooks, imageMcp: removed.imageMcp })
      }
      return { hooks: removed.hooks, imageMcp: removed.imageMcp }
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'retired-integrations.failed', '收回星芒写进 Gemini CLI 的提醒和画图没有完成，下次开机再试', { reason: credentialFailureReason(error) })
      return none
    }
  }

  /**
   * Windows 版 Grok 现在会拿哪个 shell 跑钩子。PATH 用启动时快照再补上注册表里新加的那几段：
   * 客户新开的终端看得到的，这里也要看得到；从星芒打开 Grok 时也补上同样几段（launchProviderOperation），
   * 两边推出来的是同一个 shell。Git Bash 那三处本来就是实时看文件在不在。
   */
  function expectedGrokWindowsShell(): GrokWindowsShell {
    return resolveGrokWindowsShell(withAppendedWindowsPath(process.env, currentWindowsLivePath()), (candidate) => fs.existsSync(candidate))
  }

  /**
   * 本软件写进这家配置的钩子、状态行要不要重写：指向旧位置（cliHookTargetsStale），或 Windows 上 Grok 换了 shell；
   * 以及 Windows 上只装 Grok 时一条都没写上（grokCliHooksMissing）。读不出来按不用算。
   */
  function managedCliHooksState(provider: ProviderId): { stale: boolean; shellChanged: boolean; missing: boolean } {
    try {
      const targets = inspectManagedCliHookTargets(provider, providerRoots)
      const windowsGrok = provider === 'grok' && platform === 'win32'
      const shell = windowsGrok ? expectedGrokWindowsShell() : null
      const shellChanged = shell !== null && grokCliHookShellChanged(targets, shell)
      const moved = cliHookTargetsStale(targets, [serviceOptions.cliHookScriptPath, serviceOptions.claudeStatusLineScriptPath])
      let missing = false
      if (windowsGrok && targets.length === 0) {
        const current = inspectNativeProviderConfig(provider)
        missing = grokCliHooksMissing({
          platform,
          provider,
          managedTargets: targets.length,
          relayConfigured: current.hasApiKey && current.matchesRelay,
          shell,
        })
      }
      return { stale: moved || shellChanged, shellChanged, missing }
    } catch {
      return { stale: false, shellChanged: false, missing: false }
    }
  }

  function cliHooksStale(provider: ProviderId): boolean {
    return managedCliHooksState(provider).stale
  }

  /**
   * 打开 Grok 之前复核一遍星芒写的那几条钩子：Grok 换了 shell、或指向旧位置，就先修好再开，
   * 与 Codex「打开前先修」同一个路数。这是客户点了「打开」才做的，不是开机静默改文件；
   * 修不好只记日志，不挡打开。
   */
  async function repairGrokHooksBeforeLaunch(): Promise<void> {
    await refreshWindowsLivePath()
    const state = managedCliHooksState('grok')
    if (state.missing) {
      await addMissingGrokHooks('before-launch')
      return
    }
    if (!state.stale) return
    const shell = platform === 'win32' ? expectedGrokWindowsShell() : null
    try {
      await repairCliHooks('grok')
      runtimeLog?.log('info', 'config', state.shellChanged ? 'grok-hooks.shell-changed' : 'grok-hooks.repaired-before-launch',
        state.shellChanged ? 'Grok 换了命令行，打开前按新的命令行重写了钩子' : '打开 Grok 前把指向旧位置的钩子改好了', { shell })
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'grok-hooks.repair-before-launch-failed', '打开 Grok 前修钩子没成功，照常打开', {
        shellChanged: state.shellChanged,
        shell,
        reason: credentialFailureReason(error),
      })
    }
  }

  async function repairCliHooks(provider: ProviderId): Promise<ReturnType<typeof saveProviderConfig>> {
    // 找 node 要读 PATH，放在排队之前；与 saveConfig 同一个次序。修完的复核也按最新的 PATH 推 Grok 的 shell。
    await refreshWindowsLivePath()
    const cliHook = await resolveCliHookInvocation()
    const claudeStatusLineCommand = await resolveClaudeStatusLineCommand(provider)
    return serializeConfigWrite(async () => {
      // 首页「补上」也走这里：Grok 一条没写过的，这次一并补上。
      const result = rewriteManagedCliHooks(provider, providerRoots, { cliHook, claudeStatusLineCommand, addIfMissing: provider === 'grok' })
      const after = managedCliHooksState(provider)
      if (after.stale) throw new Error('提醒设置没修好，原来的设置已备份，可以在「设置 › 备份迁移」里找回')
      if (cliHook && after.missing) throw new Error('做完提醒和防睡还没补上，先点首页的「补上」准备好运行环境再试')
      runtimeLog?.log('info', 'config', 'cli-hooks.repaired', '已把工具里的提醒设置改到这次安装的位置', {
        provider,
        rewritten: Boolean(cliHook),
      })
      return result
    })
  }

  /**
   * 开机后第一次读配置时，把本账号写的、指向旧位置的钩子和状态行直接改好（卸载后换文件夹重装、
   * 挪了软件、换装了 Node.js 之后），不用客户去首页点「修好它」。每个账号只查一遍、每家只试一次；
   * 修不好只记日志，首页照旧给「修好它」。串成一条队，同时来的几次读配置不会一起改同一份文件。
   */
  function autoRepairStaleCliHooks(): Promise<ProviderId[]> {
    const run = autoRepairQueue.then(repairStaleAccountCliHooks, repairStaleAccountCliHooks)
    autoRepairQueue = run.catch(() => [])
    return run
  }

  async function repairStaleAccountCliHooks(): Promise<ProviderId[]> {
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    // 每个账号这次启动只查一遍：读配置很频繁，不能每次都去翻四家的文件（Windows 上还要读注册表）。
    // Grok 换了命令行这种开着软件时才发生的事，交给打开 Grok 前那一道（repairGrokHooksBeforeLaunch）。
    if (!owner || autoRepairCheckedOwners.has(owner)) return []
    autoRepairCheckedOwners.add(owner)
    const repaired: ProviderId[] = []
    for (const provider of activeProviderIds) {
      if (provider === 'grok' && platform === 'win32') {
        // 只装 Grok 时缺的那几条：这台电脑后来有了运行环境就补上（addMissingGrokHooks 自己看归属）。
        if (await addMissingGrokHooks('startup')) repaired.push(provider)
      }
      let due = false
      try {
        due = shouldAutoRepairCliHooks({
          stale: managedCliHooksState(provider).stale,
          ownership: configOwnership.read(provider, inspectNativeProviderConfig(provider), owner),
          attempted: autoRepairAttemptedCliHooks.has(provider),
        })
      } catch {
        due = false
      }
      if (!due) continue
      autoRepairAttemptedCliHooks.add(provider)
      try {
        await repairCliHooks(provider)
        autoRepairedCliHooks.add(provider)
        repaired.push(provider)
        runtimeLog?.log('info', 'config', 'cli-hooks.auto-repaired', '打开软件时把指向旧位置的提醒设置改好了', { provider })
      } catch (error) {
        runtimeLog?.log('warn', 'config', 'cli-hooks.auto-repair-failed', '打开软件时没能改好提醒设置，首页留着「修好它」', {
          provider,
          reason: credentialFailureReason(error),
        })
      }
    }
    return repaired
  }

  async function saveConfig(
    payload: ConfigSavePayload,
    previewOnboarding: boolean,
    assertBeforeWrite?: () => void,
    ownership?: { source: 'account'; automatic: boolean },
  ) {
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    const assertOwner = () => {
      assertBeforeWrite?.()
      if ((serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) throw new Error('账号已变化，请重新配置')
    }
    let managedKeyReplaced = false
    const saved = await serializeConfigWrite(async () => {
      assertOwner()
      if (ownership?.source === 'account' && !owner) throw new Error('请先登录账号再配置账号密钥')
      const before = inspectNativeProviderConfig(payload.provider)
      const previousOwnership = configOwnership.read(payload.provider, before, owner)
      // `changed`（我们写过、之后被改动）同样不在放行之列：自动写入永远不覆盖
      // 用户或工具自己改出来的配置，首页只会提示，改不改由用户点。
      const shadowRepair = ownership?.automatic === true && permitsShadowedCodexRepair(payload.provider, before, previousOwnership, payload.apiKey)
      if (ownership?.automatic && previousOwnership !== 'account' && previousOwnership !== 'missing' && !shadowRepair) {
        throw new Error('已有工具配置的来源未经确认，已保留原配置；请在工具配置中明确选择账号密钥')
      }
      if (ownership?.automatic && store.read().officialProviders?.includes(payload.provider)) {
        throw new Error('工具已选择官方账号，已保留原配置')
      }
      const model = payload.model.trim()
      const activeSite = providerRelaySite(payload.provider, before)
      const previousRoute = relaySiteForProviderBaseUrl(activeSite.id, payload.provider, before.actualBaseUrl)
      // 线路换了、自动写入跟着换过去的那一笔（历史账号，和 R6 切回整份写入时的星芒账号）。工具开着也照样改
      // （#941）：开着的进程要重开才用上新地址；不改的话它会一直停在原来那条线路上。星芒账号平时不走这里，
      // 由 followToolRoutes 定点只改地址，重开提示也在那边（xm 三线路 C9、C10）。
      const followedRoute = ownership?.automatic === true && previousRoute !== null
        && previousRoute.providerBaseUrls[payload.provider] !== activeSite.providerBaseUrls[payload.provider]
        ? relayRouting.selection(activeSite.id)
        : undefined
      const assertUnchanged = () => {
        assertOwner()
        if (!sameNativeConfigSnapshot(before, inspectNativeProviderConfig(payload.provider))) {
          throw new Error('工具配置在模型检测期间发生变化，已保留现有配置，请重新检测')
        }
        if (activeRelaySite().id !== activeSite.id) throw new Error('账号已变化，请重新配置')
      }
      // An empty key is an explicit renderer sentinel: reuse the main-process key.
      const configured = payload.apiKey.trim() ? null : before
      if (configured?.hasApiKey && !configured.matchesRelay) throw new Error('已保存的 Key 属于其他账号，请使用当前账号重新配置')
      const apiKey = payload.apiKey.trim() || configured?.apiKey || ''
      if (!apiKey) throw new Error('请先填写 API Key')
      const availableModels = await fetchAvailableModels(apiKey, { site: activeSite })
      if (!availableModels.includes(model)) throw new Error(`当前 API Key 不支持模型 ${model}，请重新检测并选择可用模型`)
      // 在 assertUnchanged 之前解析：找 node 要读 PATH，不该夹在「校验没变」和写入之间。
      const statusLineCommand = await resolveClaudeStatusLineCommand(payload.provider)
      const cliHook = await resolveCliHookInvocation()
      if (previewOnboarding && payload.provider === 'codex') return { backups: [], files: [] }
      // 同上：要问一遍 Codex 命令行是哪一版，也放在「校验没变」之前。
      const codexModelCatalog = payload.provider === 'codex' ? await resolveCodexModelCatalog(availableModels, model) : undefined
      assertUnchanged()
      // Invalidate previous consent before a write, including same-key manual
      // saves. A crash or persistence failure then leaves a protected source.
      const source = ownership?.source ?? (payload.apiKey.trim() ? 'manual'
        : previousOwnership === 'account' || previousOwnership === 'manual' ? previousOwnership : 'unknown')
      const restoreOwnership = configOwnership.remember(payload.provider, before)
      await configOwnership.write(payload.provider, before, 'manual', owner)
      let result: ReturnType<typeof saveProviderConfig>
      try {
        assertUnchanged()
        // 官方 Key 先挪、配置后写：挪不开就一个字都不写，写配置失败再把 Key 放回，
        // 不会留下「配置已是当前账号、官方 Key 还在抢道」的半切换状态（#477）。
        const movedConsoleKey = payload.provider === 'claude' && moveOfficialCredentialsAside()
        try {
          result = saveProviderConfig(payload.provider, apiKey, payload.model, payload.mode, providerRoots, {}, activeSite.providerBaseUrls, statusLineCommand, availableModels, cliHook, codexModelCatalog)
        } catch (error) {
          if (movedConsoleKey) throw withCredentialUndo(error, restoreOfficialCredentialsNow, '原来登录留下的官方 Key 暂时收在一边，切回官方账号时会放回')
          throw error
        }
      } catch (error) {
        // 上面那条「手动」防的是写到一半崩掉。没写成、配置也一点没动时（最常见的是工具开着、
        // 文件被占用）要原样放回：不然客户关掉工具再保存一次就成功了，可这一次把「手动」当成了
        // 原来的来源，「当前账号」从此变成「手动」，开机同步 Key、换账号、换连接线路都不再改它
        // （10-06 写 #899 真机清单时看到）。账号中途换了就照旧留着「手动」：那一刻是谁在操作已经
        // 说不清，宁可多挡一次自动写入。
        const sameOwner = (serviceOptions.getExternalClientAccountId?.() ?? null) === owner
        if (restoreOwnership && sameOwner && untouchedSince(payload.provider, before)) {
          await restoreOwnership().catch((restoreError: unknown) => {
            runtimeLog?.log('warn', 'config', 'ownership.restore-failed', '保存没成功，工具配置的来源记录也没能原样放回', {
              provider: payload.provider,
              reason: credentialFailureReason(restoreError),
            })
          })
        }
        throw error
      }
      // 整份模板刚按当前版本写过一遍，记下版本号，开机补缺省项那条路就不会再来一次。
      await configOwnership.write(payload.provider, inspectNativeProviderConfig(payload.provider), source, owner, relayTemplateRevision)
      if (shadowRepair) runtimeLog?.log('info', 'config', 'codex-provider.auto-repaired', '开机时把 Codex 认不出的连接设置改好了，原来的设置已备份', { provider: payload.provider })
      // 客服从日志看得出工具配置是什么时候、从哪条线路换到哪条的：只记线路 id，不记地址。
      if (followedRoute) {
        runtimeLog?.log('info', 'config', 'route.followed', '工具配置已换到当前连接线路', {
          provider: payload.provider,
          kind: 'tool',
          from: relaySiteEndpointIdForBaseUrl(activeSite.id, payload.provider, before.actualBaseUrl),
          to: followedRoute,
          mode: 'merge',
          readback: relayProviderBaseUrlEquals(inspectNativeProviderConfig(payload.provider).actualBaseUrl, activeSite.providerBaseUrls[payload.provider]),
        })
      }
      // 这一家刚写的这一笔是不是因为连不上换线、跟过去的：是就等这一轮写完提示重开，不是就把以前记下的作废。
      if (followedRoute && accountRouteFaultFollowed(activeSite.id, followedRoute)) accountRouteFollowed.set(payload.provider, owner)
      else accountRouteFollowed.delete(payload.provider)
      // 整份写过一遍、来源重新记成了这次的：之前「被别的软件改回过」的结论作废，换线路照常跟。
      if (toolRouteFollow.read().providers[payload.provider]?.managedElsewhere) {
        await writeToolRouteRecord(payload.provider, ({ managedElsewhere: _managedElsewhere, reverts: _reverts, ...rest }) => rest)
      }
      assertOwner()
      await store.setOfficialProvider(payload.provider, false)
      if (payload.provider === 'codex') await applyXingmangAiSkillForCodexAccount(false)
      managedKeyReplaced = ownership?.source === 'account' && apiKey !== before.apiKey
      return result
    })
    // #1113：星芒刚替这个工具换了 Key（撤销后换新、失效重签、换组），借它那把的外部客户端马上看一眼要不要
    // 跟着换，不等下次检测。不等它：换 Key 那一步出岔子只进日志，不算这次保存失败。
    if (managedKeyReplaced) {
      // 先只看缓存和工具配置：这台电脑上的托管 Key 从没被星芒换过时，不为它盘点一遍本机客户端。
      void managedKeyFollowTarget().then((target) => target ? scanExternalClients() : undefined).catch((error: unknown) => {
        runtimeLog?.log('warn', 'config', 'external-client.key.failed', '外部客户端的密钥这次没换成，下次检测再试', {
          provider: payload.provider, reason: credentialFailureReason(error),
        })
      })
    }
    return saved
  }

  /**
   * 开机换掉已下架的型号（tool-model-check.ts 的 replaceRetiredModel）：配置里只把 from 换成 to，Codex 客户
   * 自己定的 review_model、Grok 的出图地址、注释这些一个字不动（#1154 第 4 条）。以前走 saveConfig 的整份合并，
   * 模板里的每一项都按当前版本重写一遍。闸照自动写入那道：只认当前账号写的、没选官方账号的，账号确实能用
   * to 才写。来源记录不动：它认的是路径、地址和 Key（toolConfigIdentity），型号不在里面，换完照旧是「当前账号」。
   */
  async function replaceToolModel(provider: ProviderId, from: string, to: string, assertBeforeWrite: () => void): Promise<void> {
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    function assertOwner(): void {
      assertBeforeWrite()
      if (!owner || (serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) throw new Error('账号已变化，这次不换')
    }
    await serializeConfigWrite(async () => {
      assertOwner()
      if (store.read().officialProviders?.includes(provider)) throw new Error('工具已选择官方账号，已保留原配置')
      const before = inspectNativeProviderConfig(provider)
      if (configOwnership.read(provider, before, owner) !== 'account') throw new Error('已有工具配置的来源未经确认，已保留原配置')
      const apiKey = before.apiKey?.trim() ?? ''
      if (!before.matchesRelay || !apiKey) throw new Error('已保存的 Key 属于其他账号，已保留原配置')
      const activeSite = providerRelaySite(provider, before)
      const availableModels = await fetchAvailableModels(apiKey, { site: activeSite })
      if (!availableModels.includes(to)) throw new Error(`当前 API Key 不支持模型 ${to}`)
      // 要问一遍 Codex 命令行是哪一版，放在「校验没变」之前，同 saveConfig。
      const codexModelCatalog = provider === 'codex' ? await resolveCodexModelCatalog(availableModels, to) : undefined
      assertOwner()
      if (activeRelaySite().id !== activeSite.id) throw new Error('账号已变化，这次不换')
      if (!sameNativeConfigSnapshot(before, inspectNativeProviderConfig(provider))) throw new Error('工具配置在模型检测期间发生变化，已保留现有配置')
      const plan = planProviderModelReplace(provider, from, to, providerRoots, codexModelCatalog)
      if (plan.status !== 'rewrite') throw new Error(plan.status === 'changed' ? '工具里的型号已经改了，这次不换' : '工具配置里找不到型号写在哪，这次不换')
      applyProviderModelReplace(provider, plan, providerRoots)
    })
  }

  /**
   * 打开前、开机核对时刷新型号菜单（tool-model-check.ts 的 refreshPickerIfOutdated）：只改菜单那几处，
   * Claude Code 的 modelPicker 和没写过的「Default」，Codex 的型号名单和指向它的那一行（#1154 后续）。以前走
   * saveConfig 的整份合并，Codex 客户自己定的 review_model、打开的检查更新、注释，Claude Code 放开的 deny 项
   * 和另指的「Default」都被改回模板的样子。闸同 replaceToolModel；来源记录、模板版本号都不动。
   */
  async function refreshToolPicker(provider: ProviderId, model: string, assertBeforeWrite: () => void): Promise<void> {
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    function assertOwner(): void {
      assertBeforeWrite()
      if (!owner || (serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) throw new Error('账号已变化，这次不刷新')
    }
    await serializeConfigWrite(async () => {
      assertOwner()
      if (store.read().officialProviders?.includes(provider)) throw new Error('工具已选择官方账号，已保留原配置')
      const before = inspectNativeProviderConfig(provider)
      if (configOwnership.read(provider, before, owner) !== 'account') throw new Error('已有工具配置的来源未经确认，已保留原配置')
      const apiKey = before.apiKey?.trim() ?? ''
      if (!before.matchesRelay || !apiKey) throw new Error('已保存的 Key 属于其他账号，已保留原配置')
      const activeSite = providerRelaySite(provider, before)
      const availableModels = await fetchAvailableModels(apiKey, { site: activeSite })
      if (!availableModels.includes(model)) throw new Error(`当前 API Key 不支持模型 ${model}`)
      const codexModelCatalog = provider === 'codex' ? await resolveCodexModelCatalog(availableModels, model) : undefined
      assertOwner()
      if (activeRelaySite().id !== activeSite.id) throw new Error('账号已变化，这次不刷新')
      if (!sameNativeConfigSnapshot(before, inspectNativeProviderConfig(provider))) throw new Error('工具配置在模型检测期间发生变化，已保留现有配置')
      const plan = planProviderPickerRefresh(provider, model, availableModels, providerRoots, codexModelCatalog)
      if (plan.status === 'current') return
      if (plan.status !== 'rewrite') throw new Error(plan.status === 'changed' ? '工具里的型号已经改了，这次不刷新' : '工具配置里找不到型号菜单写在哪，这次不刷新')
      applyProviderPickerRefresh(provider, plan, providerRoots)
    })
  }

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

  // 打开前的模型核对（tool-model-check.ts）。只认本软件用当前账号写的配置：官方账号、
  // 手填、被改动过的都不碰；刷新菜单走 refreshToolPicker 定点改写，闸与开机同步 Key
  // 同一套所有权规则，写一半回滚（I9）也照旧。
  function modelCheckTarget(provider: ProviderId, accountOwnedOnly: boolean): ToolModelCheckTarget | null {
    if (store.read().officialProviders?.includes(provider)) return null
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    if (!owner) return null
    const config = inspectNativeProviderConfig(provider)
    const apiKey = config.apiKey?.trim() ?? ''
    const model = config.model.trim()
    if (!config.hasApiKey || !config.matchesRelay || !apiKey || !model) return null
    if (accountOwnedOnly && configOwnership.read(provider, config, owner) !== 'account') return null
    const site = activeRelaySite()
    return { apiKey, model, identity: `${site.id}:${owner}:${modelAccessCacheKey(apiKey)}:${model}` }
  }

  const toolModelChecker = createToolModelChecker({
    now: () => Date.now(),
    target: (provider) => modelCheckTarget(provider, true),
    // 写入当中认人时不看来源记录：来源是不是当前账号，由写入那道闸（refreshToolPicker、
    // replaceToolModel）进锁时自己把关。刷新以前走 saveConfig，写之前先把记录改成「手动」，
    // 按记录认人的话刷新永远在写到一半时作废，记录还留在「手动」（#562 起 Claude Code 的菜单
    // 就是这样一次没刷成过）。
    identity: (provider) => modelCheckTarget(provider, false)?.identity ?? null,
    listModels: (apiKey) => fetchAvailableModels(apiKey, { bypassCache: true }),
    pickerOutdated: (provider, models, model) => provider === 'claude'
      ? claudeModelPickerNeedsRefresh(models, model, providerRoots)
      : codexModelCatalogOutdated(models, model),
    refreshPicker: (provider, model, assertCurrent) => refreshToolPicker(provider, model, assertCurrent),
    replaceModel: (provider, from, to, assertCurrent) => replaceToolModel(provider, from, to, assertCurrent),
    ...(serviceOptions.cliModelHints ? { modelHints: serviceOptions.cliModelHints } : {}),
    upgradeOffered: (provider, model) => (store.read().offeredModelUpgrades ?? []).includes(`${provider}:${model}`),
    markUpgradeOffered: async (provider, model) => {
      await store.update({ version: 2, offeredModelUpgrades: [`${provider}:${model}`] })
    },
    log: (level, event, message, detail) => runtimeLog?.log(level, 'config', event, message, detail),
  })

  /**
   * 开机那轮因为工具可能开着而没做的（第二十六批 E）：哪几个工具的设置没补、Codex 的型号
   * 名单有没有按账号核对。客户升级后头一回开星芒时 Codex 多半正开着，以前要等下次开机；
   * 现在渲染层隔一阵来要一次（retry），只补这几样。记的是那一轮的账号，换了账号就作废。
   */
  let templateFillDebt: { owner: string; providers: readonly ProviderId[]; codexModelCatalog: boolean } | null = null

  /**
   * 换账号、退出、登录要先等跟账号有关的活都收尾（main.ts 的 quiesce 等 accountWork），补设置
   * 那次调用也算在里面。它动手前要在本机看工具开没开（Windows 上起 PowerShell），开机那次还要
   * 先等型号名单的本机核对；安全软件拖慢的电脑上这几步各自等到超时，加起来超过换账号肯等的
   * 30 秒，客户就看到「账号服务请求超时」，被引去查网络。这几步都只是看：换账号前叫停
   * （stopTemplateFillWaits）就不再等，还没看完的当成没看出来，不写、记成还欠着；已经在写的
   * 照常写完（都在本机，很快）。真换了账号，欠的就作废。
   * 每次调用开头拿当时那个 signal，叫停之后这次调用里后面的等待也都不等了。叫停一直管到换账号
   * 那段等待结束（调返回的函数）：已经进了门、晚一步才走到这里的那次（ipc.ts 要先读备份用的账号
   * 信息）也不等。上一次换账号超时了还在等、又来一次的，两次都放开才恢复。
   */
  let templateFillWaits = new AbortController()
  let templateFillHolds = 0
  function stopTemplateFillWaits(): () => void {
    templateFillHolds += 1
    templateFillWaits.abort()
    let resumed = false
    return () => {
      if (resumed) return
      resumed = true
      templateFillHolds -= 1
      if (!templateFillHolds) templateFillWaits = new AbortController()
    }
  }

  /**
   * 老客户的配置不跟着模板升级（第十七批第 2 条）：开机恢复账号只核对连没连上，一个字
   * 不写。这里对「来源确认是当前账号、记录的模板版本落后」的配置补一次缺省项
   * （fillRelayTemplateDefaults：只补缺的，用户写过的一律不动）。官方账号、手填、来源
   * 没确认、被改动过的都不碰；工具开着或看不出开没开的这次跳过，记进 pending 等渲染层
   * 再来要。失败只记日志，不打扰用户，版本号不前进，下次开机再试。
   * 官方账号上的 Codex 只补一样：这次以前切官方时删掉的、旧对话记着的那张表
   * （restoreCodexOfficialAlias），开着不补、先备份，与上面同一套规矩。
   */
  async function fillToolTemplateDefaults(backup: ((provider: ProviderId) => void) | undefined, round: TemplateFillRound, stopped: AbortSignal): Promise<ToolTemplateFillResult> {
    const filled: ProviderId[] = []
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    if (!owner) return { filled }
    function outdated(provider: ProviderId): boolean {
      if (store.read().officialProviders?.includes(provider)) return false
      const config = inspectNativeProviderConfig(provider)
      if (!config.hasApiKey || !config.matchesRelay) return false
      if (configOwnership.read(provider, config, owner) !== 'account') return false
      const revision = configOwnership.templateRevision(provider, config)
      return revision !== null && revision < relayTemplateRevision
    }
    function codexSiteBaseUrls(): Record<ProviderId, string> {
      return providerRelaySite('codex', inspectNativeProviderConfig('codex')).providerBaseUrls
    }
    function relayChatsStranded(provider: ProviderId): boolean {
      if (provider !== 'codex' || !store.read().officialProviders?.includes(provider)) return false
      try {
        return codexOfficialAliasPending(providerRoots, codexSiteBaseUrls())
      } catch {
        // 配置读不了是别处要报的事，这一项看不了就不补，不连累别的工具补设置。
        return false
      }
    }
    const due = round.providers.filter((provider) => outdated(provider) || relayChatsStranded(provider))
    if (!due.length) return { filled }
    let report: RunningToolsReport
    try {
      report = await unlessStopped(() => (serviceOptions.inspectRunningToolsForTemplateFill ?? inspectRunningTools)(due), stopped)
    } catch {
      return { filled, pending: due }
    }
    // 补做那几次在日志里标出来，客服看得出开机那轮之后又试过几回。
    const again = round.retry ? { retry: true } : {}
    const pending: ProviderId[] = []
    for (const provider of due) {
      const busy = report.running.includes(provider) || report.unknown.includes(provider)
        || (provider === 'codex' && report.codexDesktopRunning !== false)
      if (busy) {
        runtimeLog?.log('info', 'config', 'template-defaults.deferred', '工具可能正开着，这次先不补设置', { provider, ...again })
        pending.push(provider)
        continue
      }
      try {
        const wrote = await serializeConfigWrite(async () => {
          // 排队期间账号、配置都可能变了：进锁以后按同一套条件再判一次。
          if ((serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) return false
          if (relayChatsStranded(provider)) {
            backup?.(provider)
            const restored = restoreCodexOfficialAlias(providerRoots, codexSiteBaseUrls()) !== null
            if (restored) runtimeLog?.log('info', 'config', 'codex.official-alias.restored', '已给官方账号上的 Codex 补回以前对话要用的线路表', round.retry ? { retry: true } : undefined)
            return restored
          }
          if (!outdated(provider)) return false
          const site = providerRelaySite(provider, inspectNativeProviderConfig(provider))
          // 已经齐了（多半是新模板写的，只是记录里还没有版本号）就只记版本号，不留备份。
          // 真要补才先做一份与保存配置同样的整套备份，「设置 › 备份迁移」里能找回补之前的样子；
          // 备份不成就不补。
          const pending = relayTemplateDefaultsPending(provider, providerRoots, site.providerBaseUrls)
          if (pending) backup?.(provider)
          const result = pending ? fillRelayTemplateDefaults(provider, providerRoots, site.providerBaseUrls) : null
          // 补的都是指纹之外的键，来源记录照旧是当前账号，只把版本号往前挪。
          await configOwnership.write(provider, inspectNativeProviderConfig(provider), 'account', owner, relayTemplateRevision)
          return result !== null
        })
        if (wrote) {
          filled.push(provider)
          runtimeLog?.log('info', 'config', 'template-defaults.filled', '已按新版模板给工具补齐设置', { provider, ...again })
        }
      } catch (error) {
        runtimeLog?.log('warn', 'config', 'template-defaults.failed', '给工具补齐设置没有完成，下次开机再试', { provider, reason: credentialFailureReason(error) })
      }
    }
    return pending.length ? { filled, pending } : { filled }
  }

  /**
   * 开机那一轮把 Codex 的型号名单对一遍：先在本机收回读不进的（不看账号），再按当前账号能用
   * 的型号补上或刷新（tool-model-check.ts 的 syncPicker）。老客户升级以后配置不会重写，多半
   * 也直接从开始菜单打开桌面端、不经过打开前那次核对，不在这里补，新型号就一直进不了菜单。
   * 按账号刷新与补设置同一套规矩：Codex 开着或看不出开没开的这次不动（桌面端自己也会写
   * config.toml），返回 true 记成还欠着；真要改先做一份与保存配置同样的备份，备份不成就不改。
   * 按账号核对要先问一遍中转，放到后台去做，不等它。失败只记日志。
   */
  async function syncCodexModelCatalog(backup: ((provider: ProviderId) => void) | undefined, round: TemplateFillRound, stopped: AbortSignal): Promise<boolean> {
    if (!serviceOptions.bundledCodexModelCatalogPath) return false
    try {
      await unlessStopped(guardCodexModelCatalogAtStartup, stopped)
    } catch {
      // 那次核对从不抛错，到这里只会是换账号叫停：核对照旧在后台做（main.ts 开机也起它）；欠不欠这次还没看，照原样记。
      return round.codexModelCatalog
    }
    // 不是当前账号写的 Codex 配置本来就不按账号刷新，谈不上欠着，不必起进程看它开没开。
    if (!round.codexModelCatalog || !modelCheckTarget('codex', true)) return false
    let report: RunningToolsReport
    try {
      report = await unlessStopped(() => (serviceOptions.inspectRunningToolsForTemplateFill ?? inspectRunningTools)(['codex']), stopped)
    } catch {
      return true
    }
    if (report.running.includes('codex') || report.unknown.includes('codex') || report.codexDesktopRunning !== false) {
      runtimeLog?.log('info', 'config', 'codex-model-catalog.sync-deferred', 'Codex 可能正开着，型号名单这次先不按账号刷新', round.retry ? { retry: true } : undefined)
      return true
    }
    if (round.retry) runtimeLog?.log('info', 'config', 'codex-model-catalog.sync-resumed', 'Codex 已经关了，型号名单补做一次按账号核对')
    void toolModelChecker.syncPicker('codex', {
      // 问中转、问 Codex 版本那几秒里客户可能刚打开了它：写之前再看一眼，规矩同下面 Claude Code、Grok 那条（#1154）。
      beforeRefresh: async () => {
        const latest = await (serviceOptions.inspectRunningToolsForTemplateFill ?? inspectRunningTools)(['codex'])
        if (latest.running.includes('codex') || latest.unknown.includes('codex') || latest.codexDesktopRunning !== false) throw new Error('Codex 可能正开着，这次先不写')
        backup?.('codex')
      },
    }).catch(() => undefined)
    return false
  }

  /**
   * 开机那轮替 Claude Code、Grok 换掉已下架的默认型号（Codex 由上面的 syncPicker 连菜单一起管）。下架名单
   * 可以由服务状态文件加（cli-model-defaults.ts），站上下架一个型号不用等发版。只碰当前账号写的配置：
   * 配置里的型号不在名单上就什么都不做，不起进程看工具开没开；在名单上、工具开着或看不出开没开的这次不换，
   * 交回去记成还欠着，与补设置同一套规矩。真换由 toolModelChecker.replaceRetired 在后台做：先问一遍中转，
   * 账号确实不再列它、写之前再看一眼工具还关着才换，先备份。返回这次欠下的工具。
   */
  async function replaceRetiredCliModels(backup: ((provider: ProviderId) => void) | undefined, round: TemplateFillRound, stopped: AbortSignal): Promise<ProviderId[]> {
    const candidates = round.providers.filter((provider) => provider === 'claude' || provider === 'grok')
    if (!candidates.length) return []
    let hints: CliModelHints | null = null
    if (serviceOptions.cliModelHints) {
      const loadHints = serviceOptions.cliModelHints
      try {
        hints = await unlessStopped(() => loadHints().catch(() => null), stopped)
      } catch {
        // 换账号叫停：没看过就谈不上欠，下次开机再看。
        return []
      }
    }
    const due = candidates.filter((provider) => {
      const target = modelCheckTarget(provider, true)
      return target !== null && isRetiredCliModel(provider, target.model, hints)
    })
    if (!due.length) return []
    let report: RunningToolsReport
    try {
      report = await unlessStopped(() => (serviceOptions.inspectRunningToolsForTemplateFill ?? inspectRunningTools)(due), stopped)
    } catch {
      return due
    }
    const pending: ProviderId[] = []
    for (const provider of due) {
      if (report.running.includes(provider) || report.unknown.includes(provider)) {
        runtimeLog?.log('info', 'config', 'tool-models.retired-deferred', '工具可能正开着，已下架的默认模型这次先不换', { provider, ...(round.retry ? { retry: true } : {}) })
        pending.push(provider)
        continue
      }
      void toolModelChecker.replaceRetired(provider, {
        // 问中转那几秒里客户可能刚从终端打开工具：写之前再看一眼，开着或看不出就这次不写。这时开机那轮
        // 已经交了差，不再记成欠着；下次开机再换，从星芒打开的打开前那一问也会劝换。
        beforeReplace: async () => {
          const latest = await (serviceOptions.inspectRunningToolsForTemplateFill ?? inspectRunningTools)([provider])
          if (latest.running.includes(provider) || latest.unknown.includes(provider)) throw new Error('工具可能正开着，这次先不换')
          backup?.(provider)
        },
      }).catch(() => undefined)
    }
    return pending
  }

  /**
   * 开机那次：先补设置，再在本机看 Codex 开没开、型号名单欠不欠，两样都算进 pending 交回去；
   * 按账号核对型号名单要先问一遍中转，补设置那句提示不等它。retry = 渲染层隔一阵来补做
   * （第二十六批 E）：只做开机那轮欠下的，换了账号就什么都不做。
   */
  async function fillToolTemplateDefaultsThenSyncPickers(backup?: (provider: ProviderId) => void, retry = false): Promise<ToolTemplateFillResult> {
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    const debt = templateFillDebt?.owner === owner ? templateFillDebt : null
    if (retry && !debt) return { filled: [] }
    const round: TemplateFillRound = retry && debt
      ? { retry, providers: debt.providers, codexModelCatalog: debt.codexModelCatalog }
      : { retry: false, providers: activeProviderIds, codexModelCatalog: true }
    const stopped = templateFillWaits.signal
    let result: ToolTemplateFillResult
    try {
      result = await fillToolTemplateDefaults(backup, round, stopped)
    } catch (error) {
      void syncCodexModelCatalog(backup, round, stopped).catch(() => false)
      void replaceRetiredCliModels(backup, round, stopped).catch(() => [])
      throw error
    }
    const catalogOwed = await syncCodexModelCatalog(backup, round, stopped).catch(() => false)
    const retiredOwed = await replaceRetiredCliModels(backup, round, stopped).catch((): ProviderId[] => [])
    const skipped = [...new Set([...(result.pending ?? []), ...retiredOwed])]
    templateFillDebt = owner && (skipped.length || catalogOwed) ? { owner, providers: skipped, codexModelCatalog: catalogOwed } : null
    const pending = activeProviderIds.filter((provider) => skipped.includes(provider) || (provider === 'codex' && catalogOwed))
    // 客服看报告分得清是工具开着没补，还是给换账号让了路。
    if (stopped.aborted) runtimeLog?.log('info', 'config', 'template-defaults.stopped', '要换账号了，补设置不再等本机检测，没补的下次再补', { pending, ...(round.retry ? { retry: true } : {}) })
    return pending.length ? { filled: result.filled, pending } : { filled: result.filled }
  }

  function officialKeyRestoreFailedMessage(error: unknown): string {
    return `Claude Code 原来的官方密钥没能放回原处。关掉 Claude Code 后再点一次「切回官方账号」；还不行请找客服${errorCodeClause(error)}。`
  }

  /** 配置写入失败后撤回刚才对官方 Key 的挪动；撤不回来要让用户知道，不能只报配置那一半。 */
  function withCredentialUndo(error: unknown, undo: () => unknown, leftover: string): unknown {
    try {
      undo()
      return error
    } catch {
      // undo 自己已经记了带原因的日志，这里只告诉用户现在是什么状态。
      const message = error instanceof Error ? error.message : String(error)
      return new Error(`${message}（${leftover}）`)
    }
  }

  /**
   * Console 登录留下的 primaryApiKey 会以 x-api-key 跟着每个请求出去，中转拿它
   * 覆盖掉当前账号的 Key（config-files.ts 顶部那段）。挪不开就抛错，由调用方放弃
   * 这次写入：配置写成当前账号而 Key 还在，打开工具就是 401。返回是否真的挪了一把。
   */
  function moveOfficialCredentialsAside(): boolean {
    try {
      const moved = moveClaudeConsoleKeyAside(providerRoots)
      if (moved) runtimeLog?.log('info', 'config', 'official-credentials.moved', 'Claude Code 的官方 Console Key 已挪到一边，切回官方账号时放回', { provider: 'claude' })
      return moved
    } catch (error) {
      const reason = credentialFailureReason(error)
      runtimeLog?.log('warn', 'config', 'official-credentials.move-failed', 'Claude Code 的官方 Console Key 没能挪开，本次配置没有写入', { provider: 'claude', reason })
      // 原话已经记进上面那条日志，上屏只说结果和下一步（#1100 第1条）。
      throw new Error(`Claude Code 原来登录留下的官方密钥没能挪开，配置没有改动。关掉 Claude Code 后再试；还不行请找客服${errorCodeClause(error)}。`, { cause: error })
    }
  }

  /** 放回挪开的官方 Key；失败抛错，回滚方据此知道恢复不完整。返回是否改动了文件。 */
  function restoreOfficialCredentialsNow(): boolean {
    try {
      return restoreClaudeConsoleKey(providerRoots)
    } catch (error) {
      const reason = credentialFailureReason(error)
      runtimeLog?.log('warn', 'config', 'official-credentials.restore-failed', 'Claude Code 的官方 Console Key 没能放回原处', { provider: 'claude', reason })
      throw new Error(officialKeyRestoreFailedMessage(error), { cause: error })
    }
  }

  async function restoreOfficialCredentials(provider: ProviderId): Promise<void> {
    if (provider !== 'claude') return
    await serializeConfigWrite(async () => { restoreOfficialCredentialsNow() })
  }

  async function setOfficialSourcePreference(provider: ProviderId, official: boolean): Promise<void> {
    await serializeConfigWrite(async () => {
      await store.setOfficialProvider(provider, official)
      if (provider === 'codex') await applyXingmangAiSkillForCodexAccount(official)
    })
  }

  async function adoptRestoredConfig(
    provider: ProviderId,
    isAccountKey: (apiKey: string) => boolean,
    options: { fromBackupsPage?: boolean } = {},
  ): Promise<void> {
    await serializeConfigWrite(async () => {
      // 恢复出来的 settings.json 不一定还带着星芒写的统计开关（#834 F03），对不上就作废那笔记录。
      // 放在登记来源前面：那一步失败时这里也要做完。
      if (provider === 'gemini') {
        try {
          forgetStaleGeminiUsageStatisticsRecord(providerRoots)
        } catch (error) {
          runtimeLog?.log('warn', 'config', 'gemini.statistics-record.forget-failed', 'Gemini CLI 恢复备份后没能作废星芒写过的统计开关记录', {
            reason: credentialFailureReason(error),
          })
        }
      }
      // 星芒AI技能的记录也不跟着备份恢复：备份页恢复出来的星芒配置里技能关着，是客户自己关的
      // （#834 F07），改用当前账号时不能打开。同样放在登记来源前面。
      if (provider === 'codex' && options.fromBackupsPage) {
        try {
          const current = inspectNativeProviderConfig('codex')
          const siteBaseUrl = providerRelaySite('codex', current).providerBaseUrls.codex
          await adoptRestoredXingmangAiSkillOff({
            userHome: providerRoots.userHome,
            officialCodex: (store.read().officialProviders ?? []).includes('codex'),
            configPath: path.join(providerRoots.codexHome, 'config.toml'),
            isXingmangConfig: (config) => classifyCodexConfigProfile(config, siteBaseUrl) === 'relay',
          })
        } catch (error) {
          runtimeLog?.log('warn', 'config', 'codex.skill-record.adopt-failed', 'Codex 恢复备份后没能记下星芒AI技能是客户自己关的', {
            reason: credentialFailureReason(error),
          })
        }
      }
      const owner = serviceOptions.getExternalClientAccountId?.() ?? null
      const restored = inspectNativeProviderConfig(provider)
      const source = planRestoredConfigOwnership({
        current: configOwnership.read(provider, restored, owner),
        hasApiKey: restored.hasApiKey,
        matchesRelay: restored.matchesRelay,
        owner,
        isAccountKey: restored.hasApiKey && isAccountKey(restored.apiKey),
      })
      if (source) await configOwnership.write(provider, restored, source, owner)
    })
  }

  async function alignRestoredAccountSource(provider: ProviderId): Promise<void> {
    await serializeConfigWrite(async () => {
      const side = restoredAccountSide(provider, inspectNativeProviderConfig(provider))
      if (!side) return
      const official = side === 'official'
      // 和 saveConfig / switchToOfficialAccount 一样：接中转的挪开官方 Console Key（不挪它会顶掉中转的 Key，
      // 一用就是无效令牌），官方的放回来。配置已经是恢复出来的那份了，挪不动也照样往下对齐记号。
      let credentialFailure: unknown = null
      if (provider === 'claude') {
        try {
          const changed = official ? restoreClaudeConsoleKey(providerRoots) : moveClaudeConsoleKeyAside(providerRoots)
          if (changed) {
            runtimeLog?.log('info', 'config', official ? 'official-credentials.restored' : 'official-credentials.moved',
              official ? '恢复的是官方账号的配置，Claude Code 的官方 Console Key 已放回' : '恢复的是当前账号的配置，Claude Code 的官方 Console Key 已挪到一边，切回官方账号时放回',
              { provider })
          }
        } catch (error) {
          credentialFailure = error
          runtimeLog?.log('warn', 'config', official ? 'official-credentials.restore-failed' : 'official-credentials.move-failed',
            official ? '恢复备份后 Claude Code 的官方 Console Key 没能放回原处' : '恢复备份后 Claude Code 的官方 Console Key 没能挪开',
            { provider, reason: credentialFailureReason(error) })
        }
      }
      if ((store.read().officialProviders ?? []).includes(provider) !== official) {
        await store.setOfficialProvider(provider, official)
        if (provider === 'codex') await applyXingmangAiSkillForCodexAccount(official)
      }
      if (credentialFailure) {
        // 「无效令牌」留着：account-cli-provisioner.ts 的 isCredentialFailure 认它。
        throw new Error(official
          ? officialKeyRestoreFailedMessage(credentialFailure)
          : `Claude Code 原来登录留下的官方密钥没能挪开，现在打开会报无效令牌。关掉 Claude Code 后再点一次「改用当前账号」；还不行请找客服${errorCodeClause(credentialFailure)}。`,
        { cause: credentialFailure })
      }
    })
  }

  async function switchToOfficialAccount(provider: ProviderId, mode: ConfigSavePayload['mode'] = 'merge') {
    return serializeConfigWrite(async () => {
      const activeSite = providerRelaySite(provider, inspectNativeProviderConfig(provider), true)
      // 与 saveConfig 对称：先放回官方 Key，放不回就不切；切换失败再把 Key 挪开。
      const restoredConsoleKey = provider === 'claude' && restoreOfficialCredentialsNow()
      let result: ReturnType<typeof switchProviderToOfficialAccount>
      try {
        result = switchProviderToOfficialAccount(provider, providerRoots, {}, activeSite.providerBaseUrls, mode)
      } catch (error) {
        if (restoredConsoleKey) throw withCredentialUndo(error, moveOfficialCredentialsAside, '原来登录留下的官方 Key 已经放回，可能会和当前账号的 Key 冲突，请再切一次')
        throw error
      }
      await store.setOfficialProvider(provider, true)
      if (provider === 'codex') await applyXingmangAiSkillForCodexAccount(true)
      return result
    })
  }

  async function applyXingmangAiSkillForCodexAccount(official: boolean): Promise<void> {
    try {
      await syncXingmangAiSkillCodexAvailability({
        userHome: providerRoots.userHome,
        officialCodex: official,
        configPath: path.join(providerRoots.codexHome, 'config.toml'),
      })
    } catch {
      // Account switch already committed. Skill toggle is best-effort so a
      // locked or unreadable config.toml cannot roll back the user's choice.
    }
  }

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
