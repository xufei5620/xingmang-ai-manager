import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { isIP } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { type AppSettings, type AppSettingsUpdate, AppSettingsStore, type MirrorPolicy, type RelayToolRouteStatus } from './app-settings'
import type { RuntimeLogLike } from './account-session-store'
import type { NodeRuntimeInstallRequest } from './ipc-contract'
import { redactHomeDirectory } from './startup-log'
import type { LoopbackProbe } from './stale-proxy-environment'
import { activeProviderIds, cliCatalog, isRetiredProviderId, providerIds, retiredProviderIds, type ProviderId } from './catalog'
import {
  buildCliVersionAdvice,
  type CliVersionAdvice,
} from './cli-verified-versions'
import { resolveCliRevertVersion } from './cli-update-history'
import type { ProviderConfigRoots } from './codex-home'
import {
  cleanCommandOutput,
  commandEnvironment,
  findExecutable,
  isUserWritablePath,
  redactCommandText,
  runCommand,
  trustedCommandEnvironment,
} from './command-runner'
import {
  cliPackageDirectory as cliPackageDirectoryFromNpmRoot,
  managedCliPackageDirectory,
  probeRunningCliProcesses,
} from './cli-process-probe'
import { cliProcessProbeRoots, emptyRunningToolsReport, inspectRunningTools as inspectRunningToolsWith, toolRouteRestartNeeds, type RunningToolsReport, type ToolRouteRestartHint } from './running-tools'
import { createToolModelChecker, type ToolModelCheck, type ToolModelCheckTarget } from './tool-model-check'
import { isRetiredCliModel, type CliModelHints } from './cli-model-defaults'
import { errorCodeClause, toolLaunchFailureMessage } from './failure-wording'
import {
  describeNpmCommandFailure,
  describeNpmUninstallFailure,
  isMachineBoundNpmFailure,
  isNpmExitFailure,
} from './npm-command-failure'
import {
  maximumNpmRegistryResponseBytes,
  npmInstallRegistries,
  npmLatestQueryTimeoutMs,
  npmMirrorRegistry,
  npmPackageLatestUrl,
  npmPackageVersionUrl,
  npmRegistryLabel,
} from './npm-registry'
import { grokInstallStrategyFor } from './platform-capabilities'
import { buildClaudeStatusLineCommand } from './claude-status-line'
import { buildCliHookInvocation, cliHookEventsDirectory, cliHookTargetsStale, grokCliHookCommand, grokCliHookShellChanged, resolveGrokWindowsShell, type CliHookInvocation, type GrokWindowsShell } from './cli-hooks'
import { readWindowsLivePath, withAppendedWindowsPath } from './windows-live-path'
import { isCodexDesktopExecutable } from './codex-desktop'
import { activateCodexDesktopWithCdp, injectCodexDesktopChineseLocale, withCodexDesktopCdpFailureReport, withCodexDesktopLocaleFailureReport } from './codex-desktop-cdp'
import type { CodexDesktopStartupRoute } from './codex-desktop-startup-route'
import {
  createCodexDesktopService,
  desktopUpdateFields,
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
  canLaunchManagedProvider,
  claudeForeignModelEnvKeys,
  geminiCliCompatibleModel,
  ensureCodexPermissionDefaults,
  ensureGeminiProjectContextFiles,
  inspectCodexWorkspacePermissions,
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
  managedProviderLaunchBlockedMessage,
  moveClaudeConsoleKeyAside,
  providerAccountMode,
  readCodexAuthTokens,
  restoreClaudeConsoleKey,
  rewriteManagedCliHooks,
  saveProviderConfig,
  applyProviderModelReplace,
  applyProviderPickerRefresh,
  applyProviderRouteFollow,
  planProviderModelReplace,
  planProviderPickerRefresh,
  planProviderRouteFollow,
  codexOfficialAliasPending,
  fillRelayTemplateDefaults,
  forgetStaleGeminiUsageStatisticsRecord,
  relayTemplateDefaultsPending,
  relayTemplateRevision,
  removeRetiredGeminiIntegrations,
  restoreCodexOfficialAlias,
  switchProviderToOfficialAccount,
  trustCodexWorkspace,
  trustManagedWorkspace,
  toNativeConfigSummary,
  type CodexWorkspacePermissionStatus,
  type CodexWorkspacePermissionWriteResult,
  type NativeConfigInspection,
  type NativeConfigSaveMode,
  type NativeConfigSummary,
  type ProviderAccountMode,
  type RetiredGeminiIntegrations,
} from './config-files'
import {
  ensureProjectInstructions,
  readProjectInstructionsTemplate,
} from './project-instructions'
import { classifyWorkspace, resolveRememberedWorkspace, sensitiveWorkspaceLabel } from './workspace-guard'
import {
  claudePlatformSwitches,
  describeOverride,
  inspectWorkspaceConfigOverrides,
  launchOverrideNotice,
} from './workspace-config-overrides'
import {
  fetchOfficialChatGptUsage,
  type OfficialChatGptAccount,
  type OfficialChatGptWindow,
} from './official-account-usage'
import { parseModelIds } from './models'
import { describeProbeFailure } from './probe-failure'
import {
  classifyCliInstallDisplaySource,
  cliLaunchArgv,
  cliUninstallCapability,
  resolveCliCommand,
  resolveCliInstallation,
  type CliInstallation,
  type CliInstallDisplaySource,
  type CliLaunchMode,
  type CliUninstallCapability,
} from './tool-installation'
export type { CliLaunchMode } from './tool-installation'
export type { GrokInstallStrategy } from './platform-capabilities'
import { isExactCliVersion, isNewerVersion, nodeVersionStatus, type NodeVersionStatus } from './versions'
import { toolCertificateFailureKind, withSystemCertificateTrust } from './system-certificate-trust'
import {
  inspectWindowsRestartRequired,
  installNodeRuntime as installNodeRuntimeLts,
  type NodeRuntimeInstallResult,
} from './node-runtime'
import {
  inspectInstalledPythonRuntime,
  installPythonRuntime as installPythonRuntime312,
  isPython312RuntimeVersion,
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
import { toolConfigIdentity, type ToolConfigOwnership, type ToolTemplateFillResult } from './tool-config-ownership'
import { isReplacedManagedKey, type StoredManagedCliKey } from './managed-cli-key-store'
import type { ExternalClientKeySource } from './external-client-ownership'
import {
  assertTrustedElevatedCliCommand,
  launchCliPowerShell,
  resolveWindowsPowerShellExecutable,
  WindowsCliLaunchError,
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
import { managedNativeProviderRoot, managedNpmPrefix } from './managed-cli-paths'
import { readDiskSpace } from './disk-space'
import {
  codexDesktopLocaleNeedsChange,
  inspectCodexDesktopLocale as inspectCodexDesktopLocaleStatus,
  shouldAutoConfigureCodexDesktopChineseLocale,
  writeCodexDesktopLocale,
  type CodexDesktopLocale,
  type CodexDesktopLocaleResult,
  type CodexDesktopLocaleStatus,
} from './codex-desktop-locale'
import {
  inspectCodexDesktopGlobalState,
  type CodexDesktopGlobalStateStatus,
} from './codex-desktop-state'
import { fetchGrokStableVersion } from './grok-update'
import { createNetworkLocationCache, reloadNetworkProxyConfiguration } from './network-location-cache'
import { readBoundedUtf8File } from './bounded-file'
import { readPackageManifestVersion } from './cli-native-package'
import { readBoundedResponseText } from './bounded-response'
import { launchMacosTerminal, type MacosTerminalLaunchPlan } from './macos-platform'
import { launchLinuxTerminal, LinuxTerminalLaunchError, type LinuxTerminalAttempt } from './linux-terminal'
import { relayApiProbeBaseUrl, relayProviderBaseUrlEquals, relaySiteEndpointIdForBaseUrl,
  relaySiteExactEndpointIdForBaseUrl, relaySiteForProviderBaseUrl, relaySiteProviderBaseUrlVariants, type RelayEndpointId, type RelayEndpointRoutingSnapshot, type RelayRouteLines, type RelayRouteSiteId, type RelaySite } from './relay-sites'
import type { RelayRouteChange } from './relay-route-controller'
import {
  ensureDarwinGrokAgentLink,
  resolveDarwinGrokCanonicalSelection,
} from './macos-grok'
import {
  resolveLinuxGrokInstalledVersion,
} from './linux-grok'
import { inspectMacosCodexApp, type MacosCodexAppInfo, type MacosCodexAppInspection } from './macos-codex-app'
import {
  isCommandLineToolsShimBacked,
  isMacOsCommandLineToolsShim,
} from './macos-command-line-tools'
import {
  installMacGitRuntime,
} from './macos-git-install'
import { adoptRestoredXingmangAiSkillOff, followXingmangAiSkillRoute, syncXingmangAiSkillCodexAvailability } from './xingmang-ai-skill'
import { recordToolRouteRevert, toolRouteHintDue, toolRouteRetryAllowed, toolRouteRetryDelayMs, type ToolRouteFollowRecord } from './tool-route-follow-state'
import {
  followExternalToolKey,
  followExternalToolRoute,
  saveExternalToolConfig,
  type ExternalToolConfigOptions,
  type ExternalToolId,
} from './external-tool-config'
import { externalClientNames, type ExternalClientConfigResult, type ExternalClientSourceSwitchResult, type ExternalClientStatus, type ExternalClientRuntimeStatus } from './external-client-contract'
import { createExternalClientRuntime, type ExternalClientDetectionErrorDetail, type ExternalClientMacVerificationFailure, type ExternalClientRegistryFailure } from './external-client-runtime'
import { inspectExternalToolConnection, resolveExternalToolProbeCredential, type ExternalToolProbeCredential } from './external-tool-config'
import { runExternalClientCheck, type ExternalClientCheckResult } from './external-client-connection'
import { createClaudeDesktopConfigService } from './claude-desktop-config'
import { buildDarwinTrustedVerificationRunner, buildToolStatusFromSettled, createServiceContext, scanReuseMs } from './system-service-context'
import { createCliInstallService } from './cli-install-service'
import { createRuntimeInstallService } from './runtime-install-service'
import { createCliUninstallService } from './cli-uninstall-service'
import { resolveClaudeDesktopPaths } from './claude-desktop-paths'
import { inspectClaudeDesktopStoreVirtualization } from './claude-desktop-manifest'
import { assertClaudeDesktopUnmanaged } from './claude-desktop-policy'
import { classifyNetworkFailure, isServiceUnavailableResponse, networkFailureMessages, parsesAsJsonObject, toolCertificateMessages } from './network-failure'
import { modelProbeFailurePrefix } from './relay-quota-failure'
import { carryRequestDiagnostics, noteRequestDiagnostics, responseDiagnostics, type RequestDiagnostics } from './request-diagnostics'
import { NewApiNetworkError } from './new-api-client'
import { createSystemSnapshotCache } from './system-snapshot-cache'
import { createExternalClientSnapshotCache } from './external-client-snapshot-cache'
import { BoundedOperationQueue } from './bounded-operation-queue'

const execFileAsync = promisify(execFile)
const npmLatestCacheTtlMs = 10 * 60_000
const npmLatestFailureCacheTtlMs = 2 * 60_000
export const networkLocationCacheTtlMs = 10 * 60_000
const networkLocationUrl = 'https://www.cloudflare.com/cdn-cgi/trace'
const networkLocationFallbackUrls = [
  'https://myip.ipip.net/',
  'https://ipapi.co/json/',
  'https://ipinfo.io/json',
] as const
const maximumModelResponseBytes = 1024 * 1024
const modelAccessCacheMaxEntries = 32
const maximumGrokVersionMetadataBytes = 16 * 1024

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

/**
 * The color layer must sit on top of a caller-selected base. An elevated
 * terminal has to start from `trustedCommandEnvironment`, but that base cannot
 * be applied unconditionally: callers that stay at the current integrity level
 * would lose every user-writable PATH entry for no security gain. Sanitizing
 * after the color layer is not an option either, because the sanitizer strips
 * TERM/COLORTERM/FORCE_COLOR and would leave the terminal monochrome.
 */
export function interactiveTerminalEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  buildBaseEnvironment: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv = commandEnvironment,
): NodeJS.ProcessEnv {
  const env = buildBaseEnvironment(baseEnv)
  const colorKeys = new Set([
    'term',
    'colorterm',
    'force_color',
    'no_color',
    'node_disable_colors',
    'clicolor',
    'clicolor_force',
  ])
  for (const key of Object.keys(env)) {
    if (colorKeys.has(key.toLowerCase())) delete env[key]
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.FORCE_COLOR = '3'
  env.CLICOLOR = '1'
  env.CLICOLOR_FORCE = '1'
  return env
}

/**
 * 普通权限打开工具时的基底：在 commandEnvironment 之上让 Claude Code、Gemini CLI
 * 也信任这台电脑装的证书（公司上网审计、安全软件的网页扫描）。管理员身份那条路
 * 用 trustedCommandEnvironment，不经过这里。
 */
export function sameUserTerminalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return withSystemCertificateTrust(commandEnvironment(env))
}

/**
 * 打开 CLI 的排队 key。只有同一工具、同一文件夹、同一种打开方式才算「同一次打开」
 * 合并成一个（双击幂等，I11）；换了文件夹或从记录页「接着聊」是另一件事，
 * 要排在后面各自执行，不能被前一个吞掉、再拿到前一个的结果（#482）。
 * 前缀保持 `cli:launch:`，退出拦截（quit-blocking-tasks.ts）按前缀认它不是安装。
 */
export function buildCliLaunchQueueKey(provider: ProviderId, workspace: string, mode: CliLaunchMode, resumeSessionId?: string | null): string {
  // 同一目录里按 id 接两条不同的 Codex 对话也是两件事，不能合并。
  const resumed = mode === 'resumeLast' && resumeSessionId ? `${mode}=${resumeSessionId}` : mode
  return `cli:launch:${provider}:${resumed}:${path.resolve(workspace)}`
}

/** Keeps service-level macOS launching bound to the command already verified by CLI resolution. */
export function buildDarwinCliLaunchPlan(
  command: { executable: string; argv: readonly string[] },
  workspace: string,
  env: NodeJS.ProcessEnv,
  clearedEnvironmentKeys: readonly string[] = [],
): MacosTerminalLaunchPlan {
  if (!path.isAbsolute(command.executable)) {
    throw new Error('macOS CLI executable must be an absolute resolved path')
  }
  if (!path.isAbsolute(workspace)) throw new Error('macOS workspace must be an absolute path')
  return {
    executable: command.executable,
    argv: [...command.argv],
    workspace,
    env,
    ...(clearedEnvironmentKeys.length ? { clearedEnvironmentKeys: [...clearedEnvironmentKeys] } : {}),
  }
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

/**
 * internal #20 (second-round darwin verification): every entry point that
 * decides whether to run a fresh install — the dashboard's per-card button,
 * "安装全部缺失项", and the maintenance page's batch action — gates purely on
 * `status.installed`, which has only ever come from the canonical `grok`
 * link (resolveDarwinGrokCanonicalSelection); `agent` has never been part of
 * that determination (see inspectCliTool below). So once grok reads as
 * installed, nothing user-reachable ever re-invokes ensureDarwinGrokAgentLink
 * for it again — the only thing that does is a fresh
 * runDarwinGrokPostInstallTransaction, which only runs when npm actually has
 * something to (re)install. Folding the same idempotent, non-destructive
 * ensure into every "is grok in place" probe means the very next scan or
 * update check repairs the gap on its own, regardless of how grok ended up
 * without its companion link — independent of, and in addition to, the
 * transaction every install/reinstall already runs.
 *
 * Best-effort by design: a failure here (permissions, a mid-scan uninstall,
 * a non-canonical install) must never turn a healthy "installed" status into
 * a false "not installed" — inspectCliTool's contract is to probe state, not
 * throw, so this swallows everything.
 */
async function ensureDarwinGrokAgentLinkQuietly(homeDirectory: string): Promise<void> {
  try {
    const selection = resolveDarwinGrokCanonicalSelection(homeDirectory)
    await ensureDarwinGrokAgentLink(homeDirectory, selection)
  } catch {
    // Best effort — see docstring above. The next successful probe, or an
    // explicit reinstall, gets another chance.
  }
}

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

export function parseLatestNpmVersion(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const candidate = typeof parsed === 'string'
      ? parsed
      : parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).version
        : null
    return typeof candidate === 'string' && isExactCliVersion(candidate.trim())
      ? candidate.trim()
      : null
  } catch {
    return isExactCliVersion(trimmed) ? trimmed : null
  }
}

export function parseGrokLocalVersion(input: string): string | null {
  try {
    const parsed = JSON.parse(input) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    for (const key of ['version', 'stable_version']) {
      const value = record[key]
      if (typeof value === 'string' && isExactCliVersion(value.trim())) {
        return value.trim()
      }
    }
  } catch {
    // Invalid or partially written metadata is ignored; the caller can use a
    // separately verified executable or report an unknown version.
  }
  return null
}

interface GrokLocalVersionOptions {
  platform?: NodeJS.Platform
  homeDirectory?: string
  managedDirectory?: string | null
}

export async function readGrokLocalVersionForExecutable(
  executablePath: string,
  options: GrokLocalVersionOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin') {
    try {
      return resolveDarwinGrokCanonicalSelection(
        options.homeDirectory ?? os.homedir(),
        executablePath,
      ).version
    } catch {
      return null
    }
  }
  if (platform === 'linux') {
    // npm 的 postinstall 不写 version.json，版本在 ~/.grok/bin/grok 指向的文件名里（Linux 版拆分 ③）。
    const version = resolveLinuxGrokInstalledVersion(options.homeDirectory ?? os.homedir(), executablePath)
    if (version) return version
  }
  const executableDirectory = path.dirname(executablePath)
  const candidates = new Set<string>([
    // The managed installer writes metadata beside grok.exe. Keep this first so
    // an older xAI root-level version.json cannot override a completed update.
    path.join(executableDirectory, 'version.json'),
  ])
  if (path.basename(executableDirectory).toLowerCase() === 'bin') {
    candidates.add(path.join(path.dirname(executableDirectory), 'version.json'))
  }
  if (platform === 'win32') {
    const managedDirectory = options.managedDirectory === undefined
      ? managedNativeProviderRoot('grok')
      : options.managedDirectory
    if (managedDirectory) candidates.add(path.join(managedDirectory, 'version.json'))
  }
  candidates.add(path.join(options.homeDirectory ?? os.homedir(), '.grok', 'version.json'))

  for (const candidate of candidates) {
    try {
      const version = parseGrokLocalVersion(await readBoundedUtf8File(
        candidate,
        maximumGrokVersionMetadataBytes,
        'Grok version.json',
      ))
      if (version) return version
    } catch {
      // Continue through the bounded list of known metadata locations.
    }
  }
  return null
}

function normalizeRuntimeVersion(command: string, value: string | null): string | null {
  if (!value) return null
  const match = value.trim().match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
  if (!match) return null
  const version = match[0]
  const normalizedCommand = command.toLowerCase()
  if (normalizedCommand === 'node') return `v${version}`
  if (normalizedCommand === 'python' || normalizedCommand === 'python3' || normalizedCommand === 'py') {
    return `Python ${version}`
  }
  return version
}

async function readNpmPackageVersion(executable: string): Promise<string | null> {
  const executableDirectory = path.dirname(executable)
  const candidates = [
    path.join(executableDirectory, 'node_modules', 'npm', 'package.json'),
    path.join(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'package.json'),
  ]
  for (const candidate of candidates) {
    const version = await readPackageManifestVersion(candidate, 'npm package.json')
    if (version) return version
  }
  return null
}

async function readWindowsExecutableProductVersion(
  executable: string,
  command: string,
): Promise<string | null> {
  if (process.platform !== 'win32' || path.extname(executable).toLowerCase() !== '.exe') return null
  try {
    const stats = await fs.promises.stat(executable)
    if (!stats.isFile()) return null
    const script = [
      '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$ErrorActionPreference = "Stop"',
      '$value = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:XINGMANG_VERSION_TARGET).ProductVersion',
      'if ($value) { [Console]::Out.Write([string]$value) }',
    ].join('; ')
    const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      env: {
        ...trustedCommandEnvironment(),
        XINGMANG_VERSION_TARGET: executable,
      },
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 64 * 1024,
    })
    return normalizeRuntimeVersion(command, cleanCommandOutput(stdout))
  } catch {
    return null
  }
}

function isWindowsAppExecutionAlias(filePath: string | null): boolean {
  return process.platform === 'win32'
    && Boolean(filePath && /\\AppData\\Local\\Microsoft\\WindowsApps\\/i.test(filePath))
}

export type NetworkRegion = 'mainland-china' | 'outside-mainland-china' | 'unknown'

export interface NetworkLocationStatus {
  publicIp: string | null
  countryCode: string | null
  region: NetworkRegion
  checkedAt: string
  error: string | null
}

export function parseCloudflareNetworkLocation(
  input: string,
  checkedAt = new Date().toISOString(),
): NetworkLocationStatus {
  if (!input.trim() || Buffer.byteLength(input, 'utf8') > 32 * 1024) {
    return {
      publicIp: null,
      countryCode: null,
      region: 'unknown',
      checkedAt,
      error: '网络位置响应为空或超过安全上限',
    }
  }
  const fields = new Map<string, string>()
  for (const rawLine of input.split(/\r?\n/)) {
    const separator = rawLine.indexOf('=')
    if (separator <= 0) continue
    const key = rawLine.slice(0, separator).trim().toLowerCase()
    const value = rawLine.slice(separator + 1).trim()
    if (key && value && !fields.has(key)) fields.set(key, value)
  }
  const ipCandidate = fields.get('ip') ?? ''
  const publicIp = isIP(ipCandidate) ? ipCandidate : null
  const countryCandidate = (fields.get('loc') ?? '').toUpperCase()
  const countryCode = /^[A-Z]{2}$/.test(countryCandidate) ? countryCandidate : null
  const region: NetworkRegion = countryCode === 'CN'
    ? 'mainland-china'
    : countryCode ? 'outside-mainland-china' : 'unknown'
  return {
    publicIp,
    countryCode,
    region,
    checkedAt,
    error: publicIp || countryCode ? null : '网络位置响应缺少有效 IP 和国家代码',
  }
}

export function parseCloudflareNetworkRegion(input: string): NetworkRegion {
  return parseCloudflareNetworkLocation(input).region
}

function parseFallbackNetworkLocation(
  input: string,
  sourceUrl: string,
): { publicIp: string; countryCode: string } | null {
  const trimmed = input.trim()
  if (sourceUrl.includes('myip.ipip.net')) {
    const ip = trimmed.match(/(?:当前\s*IP|IP)\s*[:：]\s*([0-9a-f:.]+)/i)?.[1] ?? ''
    const publicIp = isIP(ip) ? ip : ''
    const countryCode = /中国|China/i.test(trimmed)
      ? 'CN'
      : /美国|United States|USA/i.test(trimmed)
        ? 'US'
        : /日本|Japan/i.test(trimmed)
          ? 'JP'
          : /新加坡|Singapore/i.test(trimmed) ? 'SG' : ''
    if (publicIp && countryCode) return { publicIp, countryCode }
    return null
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const ipCandidate = typeof record.ip === 'string' ? record.ip.trim() : ''
    const publicIp = isIP(ipCandidate) ? ipCandidate : ''
    const countryCandidate = typeof record.country_code === 'string'
      ? record.country_code
      : typeof record.country === 'string' ? record.country : ''
    const countryCode = countryCandidate.trim().toUpperCase()
    return publicIp && /^[A-Z]{2}$/.test(countryCode) ? { publicIp, countryCode } : null
  } catch {
    return null
  }
}

export async function detectNetworkLocation(
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = 2_500,
): Promise<NetworkLocationStatus> {
  const checkedAt = new Date().toISOString()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  const fallbackProbe = async (): Promise<NetworkLocationStatus | null> => {
    // The primary Cloudflare probe can already consume its full timeout on
    // mainland networks. Give the fallback chain its own budget instead of
    // leaving the usable IPIP endpoint only a few hundred milliseconds.
    const deadline = Date.now() + Math.max(1_000, timeoutMs)
    for (const fallbackUrl of networkLocationFallbackUrls) {
      const remainingMs = Math.max(200, deadline - Date.now())
      const fallbackController = new AbortController()
      const fallbackTimeout = setTimeout(() => fallbackController.abort(), remainingMs)
      fallbackTimeout.unref?.()
      try {
        const fallbackResponse = await fetchImplementation(fallbackUrl, {
          method: 'GET',
          headers: { Accept: 'text/plain' },
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          signal: fallbackController.signal,
        })
        if (!fallbackResponse.ok) continue
        const fallbackBody = await readBoundedResponseText(fallbackResponse, 256, '备用网络位置')
        const location = parseFallbackNetworkLocation(fallbackBody, fallbackUrl)
        if (!location) continue
        return {
          publicIp: location.publicIp,
          countryCode: location.countryCode,
          region: location.countryCode === 'CN' ? 'mainland-china' : 'outside-mainland-china',
          checkedAt,
          error: null,
        }
      } catch {
        // Try the next provider within the shared fallback deadline.
      } finally {
        clearTimeout(fallbackTimeout)
      }
    }
    return null
  }
  try {
    const response = await fetchImplementation(networkLocationUrl, {
      method: 'GET',
      headers: { Accept: 'text/plain' },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      const fallback = await fallbackProbe()
      if (fallback) return fallback
      return {
        publicIp: null,
        countryCode: null,
        region: 'unknown',
        checkedAt,
        error: `网络位置服务返回 HTTP ${response.status}`,
      }
    }
    const body = await readBoundedResponseText(response, 32 * 1024, '网络位置')
    const primary = parseCloudflareNetworkLocation(body, checkedAt)
    // A Cloudflare response may contain `loc=CN` while omitting `ip` on
    // restricted/proxied networks. Treat that as partial data so the
    // fallback providers still get a chance to supply the missing address.
    if (primary.region !== 'unknown' && primary.publicIp) return primary

    // Some mainland networks can reach the relay but block Cloudflare's
    // trace endpoint. A tiny country-only fallback keeps mirror selection and
    // the dashboard location useful without sending a second request when the
    // primary probe already returned a valid country.
    return (await fallbackProbe()) ?? primary
  } catch (error) {
    const fallback = await fallbackProbe()
    if (fallback) return fallback
    return {
      publicIp: null,
      countryCode: null,
      region: 'unknown',
      checkedAt,
      error: error instanceof Error && error.name === 'AbortError'
        ? '网络位置检测超时'
        : error instanceof Error && error.message.includes('安全上限')
          ? error.message
          : '无法连接网络位置服务',
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function detectNetworkRegion(
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = 2_500,
): Promise<NetworkRegion> {
  return (await detectNetworkLocation(fetchImplementation, timeoutMs)).region
}

/**
 * IMPROVEMENT-PLAN 2.4: a user-pinned mirror policy overrides the probed
 * region by reducing to the region that yields the desired order. Both
 * npmInstallRegistries and nodeRuntimeDownloadSources branch only on
 * 'outside-mainland-china' vs everything else, so this single reduction
 * covers every source-order decision without touching their signatures --
 * and a pinned policy lets install paths skip the region probe entirely,
 * which in a blocked network is itself the unreliable step.
 *
 * Deliberately NOT applied to the Codex desktop manifest: its bytes are
 * mirror-only, so the manifest must stay mirror-first regardless of policy
 * or the card can advertise a release the install path cannot fetch (see
 * buildCodexDesktopManifestSources).
 */
export function effectiveNetworkRegion(
  policy: MirrorPolicy | undefined,
  detected: NetworkRegion,
): NetworkRegion {
  if (policy === 'mirror-first') return 'mainland-china'
  if (policy === 'official-first') return 'outside-mainland-china'
  return detected
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

/**
 * 「有没有新版」去哪问。Windows 的 Grok 以 xAI 的 stable 清单为准；macOS 与 Linux 的 Grok 从
 * npm 装，也就问 npm：x.ai 和它的备用地址在国内大多连不上，Linux 第一版又没有加速，Mac 上
 * yoyo 2026-10-14 定了照 Linux 只问 npm（去加速）。不给平台时按 stable 清单答，和以前一样。
 */
export function cliLatestVersionSource(
  provider: ProviderId,
  platform?: NodeJS.Platform,
): 'npm' | 'official-manifest' {
  if (provider !== 'grok') return 'npm'
  const strategy = platform ? grokInstallStrategyFor(platform) : null
  return strategy === 'linux-official-npm' || strategy === 'darwin-official-npm' ? 'npm' : 'official-manifest'
}

export interface CliInstallTargetOptions {
  platform: NodeJS.Platform
  /** 当前 npm 全局根；探测不到时为 null。 */
  npmGlobalRoot: string | null
  /** 这一次安装会不会落进托管 npm 布局，落则给出它的 prefix，否则 null。 */
  managedNpmPrefix: string | null
  /**
   * Grok 不落在 node_modules 里：Windows 上走原生通道装进这个目录，Linux 上 npm 的
   * postinstall 把程序放进 ~/.grok/bin。
   */
  managedNativeRoot: string | null
}

/**
 * 还没装上的工具没有安装目录——目录要等安装那一步写完才存在。错误面板上的
 * 「复制路径」要回答的却是「它会装到哪」，用户拿这个路径去查写入权限或加进
 * 杀毒白名单。所以这里按 installCli 自己的选路重算一遍落点：托管布局优先，
 * Grok 的 Windows 原生通道单列，其余落在当前 npm 全局根下。
 *
 * 算不出来时返回 null，界面据此不出那颗按钮——一个猜出来的路径比没有更糟。
 */
export function cliInstallTargetDirectory(
  provider: ProviderId,
  options: CliInstallTargetOptions,
): string | null {
  const grokStrategy = provider === 'grok' ? grokInstallStrategyFor(options.platform) : null
  if (grokStrategy === 'windows-native' || grokStrategy === 'linux-official-npm') {
    return options.managedNativeRoot
  }
  const packageName = cliCatalog[provider].packageName
  if (options.managedNpmPrefix) {
    return managedCliPackageDirectory(options.managedNpmPrefix, packageName, options.platform)
  }
  return options.npmGlobalRoot ? cliPackageDirectoryFromNpmRoot(options.npmGlobalRoot, packageName) : null
}

function containsComparableVersion(value: string | null): boolean {
  return typeof value === 'string'
    && /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/.test(value)
}

/** 离线时给四家 CLI 最新版探测的总预算：到点先出画面，不让首屏干等各自的超时。 */
export const offlineLatestVersionBudgetMs = 3_000

/** 预算到点仍未返回时，版本列上显示的那句话。 */
export const latestVersionUncheckedMessage = '当前可能没有网络，这次没有检查最新版本'

/**
 * 网络位置探测没能给出结果 = 这会儿八成没网。离线时每家 CLI 的最新版探测都会各自
 * 耗满自己的超时（npm 8 秒、Grok 清单 10 秒），首屏就卡在这上面十几秒，而本地已装
 * 版本其实一瞬间就读出来了。探测接口自己挂了却仍能上网时会误判，代价只是这一次不
 * 显示「有新版本」，下次扫描或手动刷新会补上。
 */
export function networkProbeSuggestsOffline(
  network: Pick<NetworkLocationStatus, 'region' | 'error'>,
): boolean {
  return network.region === 'unknown' && network.error !== null
}

/** 没检查最新版时的占位结果：未安装的照旧算 skipped，已装的算 failed 并带上原因。 */
export function buildUncheckedLatestVersion(
  provider: ProviderId,
  installed: boolean,
  checkedAt: string = new Date().toISOString(),
  platform?: NodeJS.Platform,
): LatestVersionProbe {
  const source = cliLatestVersionSource(provider, platform)
  return installed
    ? { status: 'failed', version: null, source, checkedAt, error: latestVersionUncheckedMessage }
    : { status: 'skipped', version: null, source, checkedAt, error: null }
}

/**
 * 给一批最新版探测套一个总预算。`budgetMs` 为 null 时等齐（联网时的老行为）；到点
 * 还没回来的项用占位结果顶上，那几个 Promise 仍会在后台自己走完并把结果写进缓存，
 * 这里不再等、也不重新发起——联网后靠下一次扫描或用户点刷新补上，不加定时器。
 *
 * 传入 `budgetExpired` 时，预算到点会顺手 abort 它。探测那侧据此知道「这一轮的结果
 * 已经没人要了」，手里那次请求照旧跑完（它可能给缓存留下有用的结果），但不再往备用
 * 源发新的请求——否则一批被丢弃的探测会在后台继续出网，在测试里还会串进后面的用例。
 */
export async function settleLatestVersionProbes(
  probes: readonly Promise<LatestVersionProbe>[],
  unchecked: readonly LatestVersionProbe[],
  budgetMs: number | null,
  budgetExpired?: AbortController,
): Promise<LatestVersionProbe[]> {
  const settled = probes.map((probe, index) => probe.then(
    (value) => value,
    (reason): LatestVersionProbe => ({
      ...unchecked[index],
      status: 'failed',
      error: reason instanceof Error ? reason.message : String(reason),
    }),
  ))
  if (budgetMs === null) return Promise.all(settled)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      budgetExpired?.abort()
      resolve('timeout')
    }, budgetMs)
    timer.unref?.()
  })
  try {
    return await Promise.all(settled.map(async (probe, index) => {
      const outcome = await Promise.race([probe, deadline])
      return outcome === 'timeout' ? unchecked[index] : outcome
    }))
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 下线工具在快照里的占位：当作没装、没查过更新，不给卸载、不给推荐版本。 */
export function buildRetiredCliStatus(provider: ProviderId, platform?: NodeJS.Platform): CliStatus {
  return {
    ...buildCliStatus(
      { installed: false, version: null, path: null, installDirectory: null },
      buildUncheckedLatestVersion(provider, false, undefined, platform),
    ),
    retired: true,
  }
}

export function buildCliStatus(
  installed: ToolStatus,
  latest: LatestVersionProbe,
  versionAdvice?: CliVersionAdvice,
  revertVersion?: string | null,
): CliStatus {
  const base = {
    ...installed,
    ...(versionAdvice ? { versionAdvice } : {}),
    ...(revertVersion && installed.installed ? { revertVersion } : {}),
    uninstall: installed.uninstall ?? {
      available: false,
      reason: installed.installed ? '未能确认当前安装是否可由本工具安全卸载' : null,
      manualCommand: null,
    },
    latestVersion: latest.version,
    updateAvailable: false,
    updateSource: latest.source,
    updateCheck: latest.status,
    updateState: 'unknown',
    updateCheckedAt: latest.checkedAt,
    updateError: latest.error,
  } satisfies CliStatus

  if (latest.status !== 'checked' || !latest.version) return base
  if (!installed.installed) return base
  if (!containsComparableVersion(installed.version)) {
    return {
      ...base,
      updateCheck: 'failed',
      updateError: '已安装 CLI 的版本号无法解析，不能判断是否有更新',
    }
  }
  if (isNewerVersion(installed.version, latest.version)) {
    // npm latest 变新并不代表推荐安装目标也变新；同版重装和退回推荐版
    // 都不是更新。latestVersion 仍保留真实上游版本供界面说明。
    if (versionAdvice?.pinned && versionAdvice.recommendedVersion
      && !isNewerVersion(installed.version, versionAdvice.recommendedVersion)) {
      return { ...base, updateAvailable: false, updateState: 'latest', updateError: null }
    }
    return { ...base, updateAvailable: true, updateState: 'available', updateError: null }
  }
  if (isNewerVersion(latest.version, installed.version)) {
    const sourceName = latest.source === 'native' ? '原生更新源' : 'npm latest'
    return {
      ...base,
      updateCheck: 'failed',
      updateError: `已安装版本高于${sourceName}，可能来自其他分发通道，无法可靠比较`,
    }
  }
  return { ...base, updateAvailable: false, updateState: 'latest', updateError: null }
}

function safeVersionCheckError(error: unknown, operation = 'npm latest'): string {
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown }
  if (candidate?.name === 'AbortError') return `${operation} 查询超时`
  if (candidate?.code === 'TIMED_OUT') {
    return operation.startsWith('Grok')
      ? '连接 xAI 更新服务超时，请检查代理或网络后重试'
      : `${operation} 查询超时`
  }
  if (candidate?.code === 'SPAWN_FAILED') return `无法启动 ${operation} 查询`
  if (candidate?.code === 'EXIT_NON_ZERO') return `${operation} 查询失败`
  const message = typeof candidate?.message === 'string' ? candidate.message.trim() : ''
  return message.slice(0, 240) || `${operation} 查询失败`
}

export function buildNetworkLocationStatusFromSettled(
  result: PromiseSettledResult<NetworkLocationStatus>,
  checkedAt: string = new Date().toISOString(),
): NetworkLocationStatus {
  if (result.status === 'fulfilled') return result.value
  return {
    publicIp: null,
    countryCode: null,
    region: 'unknown',
    checkedAt,
    error: describeProbeFailure(result.reason),
  }
}

export function buildDesktopAppStatusFromSettled(
  result: PromiseSettledResult<DesktopAppStatus>,
): DesktopAppStatus {
  if (result.status === 'fulfilled') return result.value
  const error = describeProbeFailure(result.reason)
  return {
    installed: false,
    version: null,
    path: null,
    installDirectory: null,
    appVersion: null,
    mirrorVersion: null,
    mirrorUpdateAvailable: null,
    mirrorError: null,
    running: false,
    detectionFailed: true,
    detectionError: error,
    ...desktopUpdateFields('failed', error, null),
  }
}

/**
 * `inspectCliTool` cannot join a `Promise.allSettled` alongside the runtime
 * probes above it: it needs the npm probe's resolved path first. A rejection
 * here must still degrade exactly like the others — distinguishably failed,
 * never silently "not installed" — otherwise onboarding could offer to
 * reinstall a CLI that may already be working.
 */
export function buildCliToolStatusFromSettled(
  result: PromiseSettledResult<{ status: ToolStatus }>,
): ToolStatus {
  return result.status === 'fulfilled' ? result.value.status : buildToolStatusFromSettled(result)
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

// Gemini CLI loads the managed ~/.gemini/.env only when a variable is not
// already present. A shell-level stale gateway/key/model would otherwise
// override the account configuration just written by the manager and send
// requests to another relay (or select a model that is not in the group).
const managedGeminiVariables = [
  'GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_MODEL',
  'GOOGLE_GENAI_API_VERSION', 'GOOGLE_GEMINI_API_KEY',
] as const

export function providerCommandEnvironment(
  provider: ProviderId,
  processEnv: NodeJS.ProcessEnv,
  codexEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = commandEnvironment(provider === 'codex' ? codexEnv : processEnv)
  if (provider === 'gemini') {
    const managed = new Set<string>(managedGeminiVariables)
    for (const key of Object.keys(environment)) {
      if (managed.has(key.toUpperCase())) delete environment[key]
    }
  }
  return environment
}

/**
 * 三个平台从星芒打开工具时都不交给它的变量（已知45 跟进，#1081）。只管 Claude Code 用星芒账号的时候：
 * - 检查页实测会绕开当前账号的那两个（diagnostics.ts 的 breaksAccount）：ANTHROPIC_API_KEY 会换掉 Key，
 *   CLAUDE_CONFIG_DIR 让它整个不读星芒写的 ~/.claude。这一次不交给工具不等于改客户的电脑，他系统里的设置
 *   一个字不动，所以 Windows、Linux 和 Mac 一样不带，不再只靠检查页提示。
 * - 选型号的那几个：客户自己设的 ANTHROPIC_MODEL 这类会让 Claude Code 去要当前账号没有的型号；接账号时
 *   settings.json 里的同名项已经挪开（config-files.ts 的 claudeForeignModelEnvKeys），环境里的这里一并不带。
 * - 改走云厂商的那几个开关（workspace-config-overrides.ts 的 claudePlatformSwitches，#1157 第 11 条）：
 *   CLAUDE_CODE_USE_BEDROCK 这类一打开，Claude Code 连地址带登录都换成云厂商的，星芒写的 settings.json
 *   里没有同名项，盖不住它。客户给自己终端里的 Claude Code 用 Bedrock、Vertex 照旧，这里只是这一次不带。
 *   settings.json 里客户自己写的同名项不挪（那是他设的值，挪不挪要 yoyo 定）。
 * 用自己的 Claude 账号时照旧都带：这些可能就是客户自己的 Key、登录和型号（切回官方账号时星芒也把他原来的
 * ANTHROPIC_API_KEY 放回 settings.json）。ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 盖不过 settings.json 的
 * env 段，不在里面。
 */
const claudeRelayLaunchExcludedVariables: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CONFIG_DIR',
  ...claudeForeignModelEnvKeys,
  ...claudePlatformSwitches,
]

export function launchExcludedEnvironmentVariables(provider: ProviderId, accountMode: ProviderAccountMode): readonly string[] {
  return provider === 'claude' && accountMode === 'relay' ? claudeRelayLaunchExcludedVariables : []
}

/** 名字不分大小写：Windows 上 `anthropic_model` 和大写是同一个变量（同 providerCommandEnvironment）。 */
export function withoutEnvironmentVariables(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const excluded = new Set(names.map((name) => name.toUpperCase()))
  return Object.fromEntries(Object.entries(env).filter(([key]) => !excluded.has(key.toUpperCase())))
}

/**
 * Mac 上「终端」先起客户自己的登录 shell 读 ~/.zshrc 这些启动文件，再跑星芒的启动脚本，那里 export
 * 的变量一路带给工具；星芒是从访达打开的，自己的环境里看不到它们，上面那步管不到（已知45，同第三十四批 B）。
 * 启动脚本先把这里列的 unset 掉，再写星芒自己的值。三个平台都不带的（launchExcludedEnvironmentVariables）
 * 都在里面，另加 Mac 才要的：
 * - Claude Code：没有另加的，Key、配置目录、选型号和改走云厂商的那几个三个平台一样，只在用星芒账号时去掉。
 * - Gemini CLI：同 Windows、Linux 上的 providerCommandEnvironment，星芒管的这五个不论哪种账号都不用客户 shell
 *   里的，要给的值启动时另给。
 * - Codex：CODEX_HOME 星芒每次都自己写，OPENAI_* 盖不过 config.toml。Grok 没实测过，不猜。
 */
export function macosShellOverrideVariables(provider: ProviderId, accountMode: ProviderAccountMode): readonly string[] {
  switch (provider) {
    case 'claude':
      return launchExcludedEnvironmentVariables(provider, accountMode)
    case 'gemini':
      return managedGeminiVariables
    case 'codex':
    case 'grok':
      return []
  }
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

/** 一轮扫描里同时在跑的探测子进程上限（见 createSystemService 里的 limitedProbe）。 */
export const scanProbeConcurrency = 3

/**
 * 非强制的扫描先看手上有没有现成的：正在跑的那一轮直接接上，刚跑完不久（`reuseMs`
 * 以内）的那一轮直接拿来用，而不是再起一整套探测子进程。主进程开窗前先起一轮预热，
 * 首页随后那次读取、账号恢复后 Key 同步那次检查就都用它；低配机器上两轮探测抢同一
 * 时刻的 CPU 与磁盘，比串着跑还慢。
 *
 * 两种情况不复用：调用方要求强制重扫（「重新检测」、装完工具、保存配置之后），以及
 * 那一轮开始之后安装队列动过——它可能是在工具装好之前探的，拿它回答「装完了吗」
 * 会答错。`revision` 就是安装队列的读数。失败的那一轮不留。
 */
export function createScanCoalescer<T>(options: { run(force: boolean): Promise<T>; revision(): number; reuseMs: number; now?(): number }) {
  const now = options.now ?? Date.now
  let sequence = 0
  let inFlight: { promise: Promise<T>; revision: number } | null = null
  let latest: { value: T; revision: number; sequence: number; at: number } | null = null
  /** 手上现成的一轮：正在跑的，或 `maxAgeMs` 以内跑完的；安装队列动过就都不算。没有就是 null，不会新起一轮。 */
  function recent(maxAgeMs: number): Promise<T> | null {
    const revision = options.revision()
    if (inFlight && inFlight.revision === revision) return inFlight.promise
    if (latest && latest.revision === revision && now() - latest.at <= maxAgeMs) return Promise.resolve(latest.value)
    return null
  }
  function scan(force: boolean): Promise<T> {
    const current = force ? null : recent(options.reuseMs)
    if (current) return current
    const revision = options.revision()
    const started = ++sequence
    const promise = options.run(force)
    const entry = { promise, revision }
    inFlight = entry
    function release() { if (inFlight === entry) inFlight = null }
    void promise.then((value) => {
      if (!latest || latest.sequence < started) latest = { value, revision, sequence: started, at: now() }
      release()
    }, release)
    return promise
  }
  return { scan, recent }
}

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

/**
 * 「保存前读到的那份配置一点没动」只有这一个口径：检测模型期间被人改了就不写；写失败以后，
 * 也只有这样才把来源原样放回。修改时间也要一样：回滚会把内容照原样写回去，身份和型号都对得上，
 * 可那几个文件毕竟被这次保存动过，按「写到一半」处理，照旧留着保护。
 */
export function sameNativeConfigSnapshot(before: NativeConfigInspection, current: NativeConfigInspection): boolean {
  return toolConfigIdentity(current) === toolConfigIdentity(before) && current.updatedAt === before.updatedAt && current.model === before.model
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

/** 打开工具前替客户补写配置（目录信任、Codex 权限缺省、桌面端中文），排在保存配置后面最多等这么久。 */
const toolLaunchConfigWriteWaitMs = 3_000

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
 * 把 write 排进 enqueue 那一队，最多等 ms 毫秒：到点还没轮到就按 gaveUp 那句拒绝，之后轮到了也不再做。
 * 轮到了就等它做完。给打开工具前那几样补写用（#1061 第 1 条）：打开的人在等，排不上就这次不写；
 * 也不能留到工具起来以后再写，那时工具自己也在写同一个文件。
 */
export function writeQueuedWithin<T>(
  enqueue: (operation: () => Promise<T>) => Promise<T>,
  write: () => T | Promise<T>,
  ms: number,
  gaveUp: string,
): Promise<T> {
  let started = false
  let abandoned = false
  const queued = enqueue(async () => {
    if (abandoned) throw new Error(gaveUp)
    started = true
    return write()
  })
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (started) return
      abandoned = true
      reject(new Error(gaveUp))
    }, ms)
    queued.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }, (error: unknown) => {
      clearTimeout(timer)
      reject(error)
    })
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

/** 读不出来的安装记录进运行日志时的那几项：原因里万一带着主目录，按主目录脱敏。 */
export function buildExternalClientRegistryLogDetail(failures: ExternalClientRegistryFailure[], userHome: string) {
  return { failures: failures.map((failure) => ({ ...failure, reason: redactHomeDirectory(failure.reason, userHome) })) }
}

/** 苹果没放行时进运行日志的那几项：应用包可能在主目录下的「应用程序」里，原话里也会带着这个路径。 */
export function buildExternalClientMacVerificationLogDetail(failure: ExternalClientMacVerificationFailure, userHome: string) {
  return { ...failure, path: redactHomeDirectory(failure.path, userHome), output: redactHomeDirectory(failure.output, userHome) }
}

/** 检测失败时 PowerShell 的原话进运行日志的那几项：读签名报的错里常带着客户端的完整路径。 */
export function buildExternalClientDetectionErrorLogDetail(failure: ExternalClientDetectionErrorDetail, userHome: string) {
  return { ...failure, message: redactHomeDirectory(failure.message, userHome) }
}

/**
 * 外部客户端要跟上的那几把（#1113）：星芒替哪几个工具换过 Key、它们自己也已经换上了缓存里那把，连同读出来的缓存。
 * 主进程内部专用（I3）。
 */
interface ManagedKeyFollowTarget {
  owner: string
  keys: readonly { provider: ProviderId; apiKey: string }[]
  cachedKeys: readonly StoredManagedCliKey[]
}

/** 比两个线路地址时不计末尾的斜杠：Claude Desktop 设置窗口里存的地址可能带一个。 */
function sameRouteUrl(left: string, right: string): boolean {
  return left.replace(/\/+$/, '') === right.replace(/\/+$/, '')
}

export function createSystemService(
  store: AppSettingsStore,
  serviceOptions: SystemServiceOptions = {},
): SystemService {
  const context = createServiceContext(store, serviceOptions)
  const {
    windowsExecutionMode, platform, providerRoots, runtimeLog,
    configOwnership, externalOwnership, projectInstructionsState, cliUpdateHistory, toolRouteFollow, serializeConfigWrite,
    codexEnv, relayRouting, activeRelaySite, providerRelaySite, inspectNativeProviderConfig,
    resolveVerifiedCliCommand, launchLinuxTerminalForService, launchCliPowerShellForService, launchMacosTerminalForService,
    resolveCliInstallationForService, executeCommand, detectMacosCodexApp,
    inspectInstalledPythonRuntimeForService,
    resolveWindowsMachinePathsForService, inspectOfficialUsage,
    downloadFetch, registryMetadataFetch, withoutDeadLoopbackProxies,
    acceleratedDownloadCount, withDownloadAcceleration, desktopBucketDownloads,
    installationQueue,
    createInstallTemporaryDirectory, assertInstallDiskSpace,
    findInstalledExecutable, preferredNodeDirectories, forgetPreferredNodeDirectories, nodeCommandDirectories,
    resolveServiceNpmGlobalRoot, executeVersion, cliTerminalAccess,
  } = context
  // 这次启动替用户改过的钩子（第十八批 1b）：试过的不再试，改好的让首页说一句。只在内存里，重开软件从头算。
  const autoRepairAttemptedCliHooks = new Set<ProviderId>()
  const autoRepairCheckedOwners = new Set<string>()
  const autoRepairedCliHooks = new Set<ProviderId>()
  let autoRepairQueue: Promise<unknown> = Promise.resolve()
  // 打开工具前替客户补的那几样也排进保存配置这一队（#1061 第 1 条）。保存要先联网查模型，查完核对
  // 配置没被动过才写（sameNativeConfigSnapshot 连修改时间一起比）；以前这一两秒里点「打开」，补写
  // 一改 config.toml，保存就报「工具配置在模型检测期间发生变化」。这几样都是写不进去也不挡打开的，
  // 排不上就这次不写：下次打开再补，目录信任 CLI 自己还会问。
  function writeBeforeLaunch<T>(write: () => T | Promise<T>): Promise<T> {
    return writeQueuedWithin(serializeConfigWrite, write, toolLaunchConfigWriteWaitMs, '保存配置还没做完，这次打开先不写')
  }
  const providerEnvironment = (provider: ProviderId): NodeJS.ProcessEnv =>
    providerCommandEnvironment(provider, process.env, codexEnv)
  const externalClientRuntime = serviceOptions.externalClientRuntime ?? createExternalClientRuntime({
    installationQueue, platform, userHome: providerRoots.userHome, runCommand: executeCommand, windowsExecutionMode,
    // Mac 上一键装桌面端自己下官方包：和命令行工具一样走系统代理、临时加速，下之前先看盘。
    fetch: downloadFetch,
    withDownloadRoute: (operation) => withDownloadAcceleration(null, operation),
    bucketDownloads: desktopBucketDownloads,
    assertDiskSpace: assertInstallDiskSpace,
    onWingetUnavailable: (reason) => runtimeLog?.log('warn', 'install', 'external-client.winget-unavailable', '桌面客户端无法一键安装：系统 winget 不可用', { reason }),
    // 首页只说「部分软件安装记录无法读取」；是哪几条、为什么，客服在反馈报告里看这一行。
    onRegistryIncomplete: (failures) => runtimeLog?.log('warn', 'system', 'external-client.registry-incomplete', '部分软件安装记录无法读取，桌面客户端检测不完整',
      buildExternalClientRegistryLogDetail(failures, providerRoots.userHome)),
    onMacVerificationFailed: (failure) => runtimeLog?.log('warn', 'system', 'external-client.mac-verification-failed', '桌面客户端没通过苹果的签名核对',
      buildExternalClientMacVerificationLogDetail(failure, providerRoots.userHome)),
    // 首页只说「无法读取客户端数字签名」这类前半句中文（已知3），系统给的原话客服在反馈报告里看这一行。
    onDetectionErrorDetail: (failure) => runtimeLog?.log('warn', 'system', 'external-client.detection-error-detail', '桌面客户端检测失败时系统给的原话',
      buildExternalClientDetectionErrorLogDetail(failure, providerRoots.userHome)),
    // 客户说「打开还是慢」，客服在反馈报告里看这一行：慢在排队、PowerShell 启动、读安装记录、核签名，还是交出去以后客户端自己慢。
    onLaunchTiming: (timing) => runtimeLog?.log('info', 'system', 'external-client.launch-timing', '打开桌面客户端前各段用时', { ...timing }),
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
  const npmLatestCache = new Map<string, { expiresAt: number; value: LatestVersionProbe }>()
  // 失效时递增，让失效前发起的在途查询放弃回写过期结果
  let npmLatestCacheGeneration = 0
  const grokLatestInFlight = new Map<string, Promise<LatestVersionProbe>>()
  const modelAccessCache = new Map<string, { expiresAt: number; models: string[] }>()
  const networkLocationCache = createNetworkLocationCache({
    ttlMs: networkLocationCacheTtlMs,
    probe: async (forceRefresh) => {
      if (forceRefresh && serviceOptions.reloadNetworkProxyConfig) {
        await reloadNetworkProxyConfiguration(serviceOptions.reloadNetworkProxyConfig)
      }
      return detectNetworkLocation(serviceOptions.networkLocationFetch ?? fetch)
    },
  })
  let officialChatGptCache: { expiresAt: number; value: OfficialChatGptAccount | null } | null = null

  function inspectNetworkLocation(forceRefresh = false): Promise<NetworkLocationStatus> {
    return networkLocationCache.read(forceRefresh)
  }

  function refreshNetworkLocation(): Promise<SystemSnapshot['network']> {
    return inspectNetworkLocation(true)
  }

  async function inspectNetworkRegion(): Promise<NetworkRegion> {
    // 2.4：镜像策略被用户钉死时不再探测——直接归约到产生所需源顺序的
    // region。scanSystem 的网络状态卡片仍走真实探测（inspectNetworkLocation），
    // 展示保持诚实，这里只决定安装/版本检查的源顺序。
    const policy = store.read().mirrorPolicy
    if (policy) return effectiveNetworkRegion(policy, 'unknown')
    // 加速已经为这次下载起来了：线路本来就是为直连官方源准备的，再绕镜像
    // 没有意义。顺带省掉一次区域探测——网络受限时那一步本身最不可靠。
    if (acceleratedDownloadCount() > 0) return effectiveNetworkRegion('official-first', 'unknown')
    return (await inspectNetworkLocation()).region
  }

  async function inspectTool(command: string, args = ['--version']): Promise<ToolStatus> {
    const executable = await findInstalledExecutable(command)
    if (!executable) return { installed: false, version: null, path: null, installDirectory: null }
    // 没装命令行开发者工具的 Mac 上，/usr/bin/git 与 /usr/bin/python3 一跑就弹苹果的
    // 安装对话框；背后那份不在就当没找到，别每次扫描都把弹窗招出来。
    if (
      isMacOsCommandLineToolsShim(executable, platform)
      && !await isCommandLineToolsShimBacked(executable, { runCommand: executeCommand })
    ) {
      return { installed: false, version: null, path: null, installDirectory: null }
    }
    let version = await executeVersion(
      executable,
      args,
      command.toLowerCase() === 'npm' ? 'npm' : undefined,
      process.env,
      await nodeCommandDirectories(command),
    )
    if (!version && command.toLowerCase() === 'npm') {
      version = await readNpmPackageVersion(executable)
    } else if (!version && !isWindowsAppExecutionAlias(executable)) {
      // Reading PE metadata through the trusted inbox PowerShell does not
      // execute a runtime found in a user-writable directory.
      version = await readWindowsExecutableProductVersion(executable, command)
    }
    return {
      installed: true,
      version,
      path: executable,
      installDirectory: path.dirname(executable),
    }
  }

  /**
   * npm 报「证书被换掉」时，说清是哪一种（system-certificate-trust.ts）。npm 已经带着
   * 「也信任这台电脑的证书」去跑、仍然失败的，原文不动，交给渲染层「连接被网络拦截」
   * 那条。Node 版本读 PATH 上的 node：npm 就是由它跑起来的。读不出版本就不下结论。
   */
  async function withToolCertificateHint(message: string, raw = message): Promise<string> {
    // 上屏那句只剩中文原因和错误码，拿 npm 的原话认（#1100 第1条连带 2）。
    if (classifyNetworkFailure(raw) !== 'tls') return message
    const trustedOnly = process.platform === 'win32' && windowsExecutionMode === 'trusted-only'
    let nodeVersion: string | null = null
    if (!trustedOnly) {
      try { nodeVersion = (await inspectTool('node')).version } catch { nodeVersion = null }
    }
    const kind = toolCertificateFailureKind({ trustedOnly, nodeVersion })
    return kind ? `${message.replace(/。$/, '')}。${toolCertificateMessages[kind]}` : message
  }

  async function inspectNode(): Promise<ToolStatus> {
    const status = await inspectTool('node')
    if (!status.installed) return { ...status, tooOld: false, versionStatus: 'unknown' }
    const versionStatus = nodeVersionStatus(status.version)
    return { ...status, tooOld: versionStatus === 'too-old', versionStatus }
  }

  /**
   * 安装那一步的落点选择（installCli）在这里重放一遍，只为把「会装到哪」交给
   * 界面。ProgramData / ~/Library 这两条托管路径在个别机器上算不出来（缺少可信
   * 的 ProgramData、HOME 为空），那属于正常情况，吞掉后退回 null 即可——探测
   * 不该因为一个附带字段失败。
   */
  function resolveCliInstallTarget(provider: ProviderId, npmGlobalRoot: string | null): string | null {
    try {
      const managed = platform === 'win32'
        ? windowsExecutionMode === 'trusted-only' ? managedNpmPrefix() : null
        : provider !== 'grok' ? managedNpmPrefix(commandEnvironment(), platform) : null
      return cliInstallTargetDirectory(provider, {
        platform,
        npmGlobalRoot,
        managedNpmPrefix: managed,
        managedNativeRoot: provider !== 'grok'
          ? null
          : platform === 'win32'
            ? managedNativeProviderRoot('grok')
            : path.join(commandEnvironment().HOME?.trim() || os.homedir(), '.grok', 'bin'),
      })
    } catch {
      return null
    }
  }

  async function inspectCliTool(
    provider: ProviderId,
    npmExecutable?: string | null,
    npmGlobalRoot?: string | null,
    executablePath?: string | null,
  ): Promise<{ status: ToolStatus; installation: CliInstallation | null }> {
    const cliEnvironment = providerEnvironment(provider)
    const installation = await resolveCliInstallationForService(provider, {
      env: cliEnvironment,
      executablePath,
      npmExecutable,
      npmGlobalRoot,
      platform,
    })
    const installTarget = resolveCliInstallTarget(provider, npmGlobalRoot ?? null)
    if (
      !installation
      || (provider === 'codex' && installation.source === 'native'
        && isCodexDesktopExecutable(installation.commandPath))
    ) {
      return {
        status: { installed: false, version: null, path: null, installDirectory: null, installTarget },
        installation: null,
      }
    }
    const safeNativeCommand = installation.source === 'native' && provider !== 'grok'
      ? await resolveVerifiedCliCommand(provider, cliEnvironment, windowsExecutionMode, {
          darwinStagingRetention: 'ephemeral',
        }).catch(() => null)
      : null
    try {
      let version = installation.source === 'npm'
        ? installation.packageVersion ?? null
        : platform === 'darwin' && provider === 'codex' && safeNativeCommand?.verifiedDarwinStandalone
          ? safeNativeCommand.verifiedDarwinStandalone.version
          : safeNativeCommand
            ? await executeVersion(
                safeNativeCommand.executable,
                [...safeNativeCommand.argv, ...cliCatalog[provider].versionArgs],
                undefined,
                cliEnvironment,
              )
            : null
      if (provider === 'grok') {
        version = await readGrokLocalVersionForExecutable(installation.commandPath)
        if (platform === 'darwin') {
          await ensureDarwinGrokAgentLinkQuietly(cliEnvironment.HOME?.trim() || os.homedir())
        }
      }
      return { status: {
        installed: true,
        // Reading an npm package manifest avoids unnecessary CLI execution and
        // remains safe even when the app was manually started as administrator.
        version,
        // Grok 的安装/更新走原生通道（非 npm），首页对它保留朴素的「已安装」与既有
        // 更新按钮，不做来源标注；其余三个 CLI 的安装通道是 npm，标注来源后原生/其他
        // 来源装的那份才好挡住 npm 重装。
        installSource: provider === 'grok'
          ? undefined
          : classifyCliInstallDisplaySource(installation, {
              env: cliEnvironment,
              platform,
            }),
        path: installation.source === 'native'
          ? provider === 'grok'
            ? installation.commandPath
            : platform === 'darwin' && safeNativeCommand?.verifiedDarwinStandalone
              ? safeNativeCommand.verifiedDarwinStandalone.executablePath
              : safeNativeCommand?.executable ?? null
          : installation.commandPath,
        installDirectory: installation.installDirectory,
        installTarget,
        uninstall: cliUninstallCapability(provider, installation, {
          managedNpmPrefix: (() => {
            try {
              return managedNpmPrefix()
            } catch {
              return null
            }
          })(),
          managedNativeDirectory: process.platform === 'win32' && provider === 'grok'
            ? managedNativeProviderRoot('grok')
            : null,
          homeDirectory: cliEnvironment.HOME?.trim() || os.homedir(),
          platform,
          verifiedDarwinStandalone: safeNativeCommand?.verifiedDarwinStandalone ?? null,
          windowsExecutionMode,
        }),
      }, installation }
    } finally {
      await safeNativeCommand?.release?.()
    }
  }

  async function inspectPython(): Promise<ToolStatus> {
    let fallback: ToolStatus | null = null
    for (const [command, args] of [
      ['python', ['--version']],
      ['python3', ['--version']],
      ['py', ['--version']],
    ] as const) {
      const result = await inspectTool(command, [...args])
      if (!result.installed) continue
      if (isPython312RuntimeVersion(result.version)) return result
      if (!isWindowsAppExecutionAlias(result.path)) fallback ??= result
    }
    if (platform === 'win32') {
      try {
        const inspected = await inspectInstalledPythonRuntimeForService()
        return {
          installed: true,
          version: inspected.version,
          path: inspected.executable,
          installDirectory: path.dirname(inspected.executable),
        }
      } catch {
        // The fixed current-user Python 3.12 location is an additional probe,
        // not a reason to turn a normal "not installed" result into a failure.
      }
    }
    if (fallback) return fallback
    return { installed: false, version: null, path: null, installDirectory: null }
  }

  /**
   * `git --version` 打印的是「git version 2.43.0.windows.1」，整行放进运行环境行里
   * 会把「Git」重复一遍，所以只留版本号；解析不出来时按其余运行环境的老规矩留空，
   * 由渲染层退回中性的「已安装」。探测本身抛错时不在这里吞掉，交给 scanSystem 的
   * allSettled 归成「检测失败」——缺 Git 与探不到 Git 对用户是两件事（A4）。
   */
  async function inspectGit(): Promise<ToolStatus> {
    const status = await inspectTool('git')
    if (!status.installed) return status
    return { ...status, version: normalizeRuntimeVersion('git', status.version) }
  }

  async function inspectLatestNpmVersion(
    packageName: string,
    networkRegion: NetworkRegion,
    budgetSignal?: AbortSignal,
  ): Promise<LatestVersionProbe> {
    const cacheKey = `npm:${networkRegion}:${packageName}`
    const cached = npmLatestCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value

    const generation = npmLatestCacheGeneration
    const checkedAt = new Date().toISOString()
    const query = async (registry: string): Promise<LatestVersionProbe> => {
      const sourceLabel = registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), npmLatestQueryTimeoutMs)
      try {
        const response = await registryMetadataFetch(npmPackageLatestUrl(registry, packageName), {
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`${sourceLabel} HTTP ${response.status}`)
        const body = await readBoundedResponseText(
          response,
          maximumNpmRegistryResponseBytes,
          sourceLabel,
        )
        const version = parseLatestNpmVersion(body)
        return version
          ? { status: 'checked', version, source: 'npm', checkedAt, error: null }
          : {
              status: 'failed',
              version: null,
              source: 'npm',
              checkedAt,
              error: `${sourceLabel} 返回了无法解析的版本号`,
            }
      } catch (error) {
        return {
          status: 'failed',
          version: null,
          source: 'npm',
          checkedAt,
          error: safeVersionCheckError(error, sourceLabel),
        }
      } finally {
        clearTimeout(timeout)
      }
    }
    const errors: string[] = []
    let value: LatestVersionProbe | null = null
    for (const registry of npmInstallRegistries(networkRegion)) {
      const result = await query(registry)
      if (result.status === 'checked') {
        value = result
        break
      }
      if (result.error) errors.push(result.error)
      // 预算到点了：这一轮的结果已经被占位顶掉，没人会用。再往备用源发一次请求
      // 只是在后台空转（离线时它注定也要耗满自己的超时），停在这里等下一次扫描。
      if (budgetSignal?.aborted) break
    }
    value ??= {
      status: 'failed',
      version: null,
      source: 'npm',
      checkedAt,
      error: errors.join('；') || 'npm 版本查询失败',
    }
    // 预算到点后攒出来的失败不写缓存：写了会把这份可能还没试完备用源的结论
    // 按失败 TTL 钉住，让紧跟着的那次扫描连试都不试。查成了的照写不误。
    const abandoned = value.status !== 'checked' && budgetSignal?.aborted === true
    if (!abandoned && generation === npmLatestCacheGeneration) {
      const ttl = value.status === 'checked' ? npmLatestCacheTtlMs : npmLatestFailureCacheTtlMs
      npmLatestCache.set(cacheKey, { expiresAt: Date.now() + ttl, value })
    }
    return value
  }

  async function inspectLatestGrokVersion(budgetSignal?: AbortSignal): Promise<LatestVersionProbe> {
    const cacheKey = 'official:grok:stable'
    const cached = npmLatestCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const existingProbe = grokLatestInFlight.get(cacheKey)
    if (existingProbe) return existingProbe

    const probe = (async (): Promise<LatestVersionProbe> => {
      const checkedAt = new Date().toISOString()
      try {
        const result = await fetchGrokStableVersion({ abandonedSignal: budgetSignal, fetchImpl: registryMetadataFetch })
        return {
          status: 'checked',
          version: result.version,
          source: 'official-manifest',
          checkedAt,
          error: null,
        }
      } catch (error) {
        return {
          status: 'failed',
          version: null,
          source: 'official-manifest',
          checkedAt,
          error: safeVersionCheckError(error, 'Grok 官方版本'),
        }
      }
    })().then((value) => {
      // invalidate 会清空 in-flight 表，比对可拦住失效前发起的过期回写；
      // 预算到点后攒出来的失败同样不写，理由与 npm 那边一样。
      const abandoned = value.status !== 'checked' && budgetSignal?.aborted === true
      if (!abandoned && grokLatestInFlight.get(cacheKey) === probe) {
        npmLatestCache.set(cacheKey, {
          expiresAt: Date.now() + (value.status === 'checked'
            ? npmLatestCacheTtlMs
            : npmLatestFailureCacheTtlMs),
          value,
        })
      }
      return value
    })
    grokLatestInFlight.set(cacheKey, probe)
    try {
      return await probe
    } finally {
      if (grokLatestInFlight.get(cacheKey) === probe) grokLatestInFlight.delete(cacheKey)
    }
  }

  function invalidateCliUpdateCache(provider: ProviderId): void {
    npmLatestCacheGeneration += 1
    if (provider === 'grok') {
      for (const key of npmLatestCache.keys()) {
        if (key.startsWith('official:grok:')) npmLatestCache.delete(key)
      }
      grokLatestInFlight.clear()
      // macOS、Linux 的 Grok 问的是 npm（cliLatestVersionSource），下面那份也要清。
      if (cliLatestVersionSource(provider, platform) === 'official-manifest') return
    }
    const packageSuffix = `:${cliCatalog[provider].packageName}`
    for (const key of npmLatestCache.keys()) {
      if (key.endsWith(packageSuffix) || key === cliCatalog[provider].packageName) {
        npmLatestCache.delete(key)
      }
    }
  }

  async function inspectCliLatestVersion(
    provider: ProviderId,
    installed: ToolStatus,
    networkRegion: NetworkRegion,
    budgetSignal?: AbortSignal,
  ): Promise<LatestVersionProbe> {
    const source = cliLatestVersionSource(provider, platform)
    if (!installed.installed) {
      return {
        status: 'skipped',
        version: null,
        source,
        checkedAt: new Date().toISOString(),
        error: null,
      }
    }
    if (source === 'official-manifest') {
      return inspectLatestGrokVersion(budgetSignal)
    }
    return inspectLatestNpmVersion(cliCatalog[provider].packageName, networkRegion, budgetSignal)
  }

  /**
   * 进程检测要的是「用户实际在跑的那一份」装在哪，和启动工具时用的是同一套发现
   * （resolveCliInstallation），而不是安装流程里「npm 这次会装到哪」的那个推算：
   * 两者在用户自己改过 npm 全局目录、或同时装了两份时并不相同。npm 与它的全局
   * 目录对所有工具只算一次，只找路径、不跑任何工具的 --version。
   */
  async function inspectRunningTools(providers: readonly ProviderId[]): Promise<RunningToolsReport> {
    let npmLocation: Promise<{ npmExecutable: string | null; npmGlobalRoot: string | null }> | null = null
    function locateNpm() {
      npmLocation ??= (async () => {
        const npmExecutable = await findInstalledExecutable('npm')
        return { npmExecutable, npmGlobalRoot: await resolveServiceNpmGlobalRoot(npmExecutable) }
      })()
      return npmLocation
    }
    return inspectRunningToolsWith(providers, {
      probeRoots: async (provider) => {
        const { npmExecutable, npmGlobalRoot } = await locateNpm()
        const installation = await resolveCliInstallationForService(provider, {
          env: providerEnvironment(provider),
          npmExecutable,
          npmGlobalRoot,
          platform,
        })
        // 与 inspectCliTool 同一条排除：命令行找到的若是桌面端自带的 codex，那是
        // 桌面端的进程，下面单独问桌面端，别在这里再算一遍 Codex CLI。
        if (installation && provider === 'codex' && installation.source === 'native'
          && isCodexDesktopExecutable(installation.commandPath)) return []
        return cliProcessProbeRoots(installation, platform)
      },
      probe: (root) => probeRunningCliProcesses(root, { platform }),
      codexDesktopRunning: async () => {
        if (platform !== 'win32' && platform !== 'darwin') return false
        const status = await inspectCodexDesktop()
        if (status.running) return true
        return status.detectionFailed ? null : false
      },
      canRestartCodexDesktop: platform === 'win32',
    })
  }

  async function inspectCliUpdate(
    provider: ProviderId,
    forceRefresh = false,
  ): Promise<CliStatus> {
    if (forceRefresh) invalidateCliUpdateCache(provider)
    // 同「打开」那条路（launchProviderOperation）：检查更新只用得上 npm 在哪，
    // 用不上它的版本号，别为此多起一次 `npm --version`。路径照旧每次现查，不缓存。
    const npmPath = await findInstalledExecutable('npm')
    const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npmPath)
    const { status } = await inspectCliTool(provider, npmPath, npmGlobalRoot)
    const networkRegion = cliLatestVersionSource(provider, platform) === 'npm' && status.installed
      ? await inspectNetworkRegion()
      : 'unknown'
    const latest = await inspectCliLatestVersion(provider, status, networkRegion)
    const settings = store.read()
    return buildCliStatus(status, latest, buildCliVersionAdvice(provider, status.version, {
      siteId: settings.relaySiteId,
      alwaysLatest: settings.alwaysInstallLatestCli === true,
    }), resolveCliRevertVersion(provider, cliUpdateHistory.read()[provider], status.version, Date.now(), settings.relaySiteId))
  }

  async function inspectOfficialChatGptAccount(forceRefresh: boolean): Promise<OfficialChatGptAccount | null> {
    if (forceRefresh) officialChatGptCache = null
    if (officialChatGptCache && officialChatGptCache.expiresAt > Date.now()) {
      return officialChatGptCache.value
    }
    const inspection = inspectNativeProviderConfig('codex')
    if (inspection.hasApiKey) {
      officialChatGptCache = { expiresAt: Date.now() + 45_000, value: null }
      return null
    }
    const value = await inspectOfficialUsage(readCodexAuthTokens(providerRoots), {
      fallback: {
        planLabel: inspection.officialAccountPlan,
        renewsAt: inspection.officialAccountRenewsAt,
      },
    })
    officialChatGptCache = { expiresAt: Date.now() + 45_000, value }
    return value
  }

  async function refreshOfficialChatGptUsage(): Promise<OfficialChatGptAccount | null> {
    return inspectOfficialChatGptAccount(true)
  }

  const snapshotCache = serviceOptions.systemSnapshotCacheFile && serviceOptions.appVersion
    ? createSystemSnapshotCache({
        filePath: serviceOptions.systemSnapshotCacheFile,
        appVersion: serviceOptions.appVersion,
        onWarning: (code, message) => runtimeLog?.log('warn', 'system', code, '上次检测结果没有读写成功', { error: message }),
      })
    : null
  let scanCompleted = false
  let scansStarted = 0
  let newestSaved = 0
  const coalescedScan = createScanCoalescer({
    run: async (force) => {
      const started = ++scansStarted
      const snapshot = await runScan(force)
      scanCompleted = true
      // 强制重扫与普通扫描可能交错完成，落盘只让后开始的那一轮覆盖先开始的。
      if (started > newestSaved) {
        newestSaved = started
        void snapshotCache?.save(snapshot)
      }
      return snapshot
    },
    revision: () => installationQueue.revision,
    reuseMs: scanReuseMs,
  })
  function scanSystem(forceRefresh = false): Promise<SystemSnapshot> {
    return coalescedScan.scan(forceRefresh)
  }
  async function cachedScan(options: { startScan?: boolean } = {}): Promise<SystemSnapshot | null> {
    if (scanCompleted || !snapshotCache) return null
    if (options.startScan !== false) void scanSystem(false).catch(() => undefined)
    const cached = await snapshotCache.load()
    // 读文件这几毫秒里真扫描可能已经回来了，那就不必再给旧的。
    return scanCompleted ? null : cached
  }
  // 低配机器上一轮扫描同时起十来个探测子进程（node、npm、python、git、PowerShell、
  // 四家 CLI 的 --version），CPU 与磁盘被挤满，整轮反而更慢，别的程序也跟着卡。
  // 起子进程的探测一次最多跑这么多个；网络位置这类只发请求的不占名额。
  const probeQueue = new BoundedOperationQueue({ maxActive: scanProbeConcurrency, maxQueued: 64 })
  function limitedProbe<T>(probe: () => Promise<T>): Promise<T> {
    return probeQueue.enqueue(() => probe()).promise
  }

  async function runScan(forceRefresh: boolean): Promise<SystemSnapshot> {
    if (forceRefresh) {
      npmLatestCacheGeneration += 1
      npmLatestCache.clear()
      grokLatestInFlight.clear()
      officialChatGptCache = null
      forgetPreferredNodeDirectories()
    }
    const [nodeResult, npmResult, pythonResult, gitResult, codexDesktopResult, networkResult, officialChatGptResult] = await Promise.allSettled([
      limitedProbe(inspectNode),
      limitedProbe(() => inspectTool('npm')),
      limitedProbe(inspectPython),
      limitedProbe(inspectGit),
      limitedProbe(() => inspectCodexDesktopUpdate(forceRefresh)),
      inspectNetworkLocation(forceRefresh),
      inspectOfficialChatGptAccount(forceRefresh),
    ])
    // 单个探测异常不再丢弃整份快照；失败项降级为可区分的「检测失败」状态
    const node = buildToolStatusFromSettled(nodeResult)
    const npm = buildToolStatusFromSettled(npmResult)
    const python = buildToolStatusFromSettled(pythonResult)
    const git = buildToolStatusFromSettled(gitResult)
    const codexDesktop = buildDesktopAppStatusFromSettled(codexDesktopResult)
    const network = buildNetworkLocationStatusFromSettled(networkResult)
    const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npm.path)
    // 单个 CLI 探测异常不能伪装成“未安装”，否则维护页会自动勾选并重装。
    const cliProbes = await Promise.allSettled(
      activeProviderIds.map((id) => limitedProbe(() => inspectCliTool(id, npm.path, npmGlobalRoot))),
    )
    const cliResults: ToolStatus[] = cliProbes.map(buildCliToolStatusFromSettled)
    // 老版本装的工具旁边还留着 .ps1 启动文件；每次打开软件后的第一轮检测顺手清掉，
    // 只动文件、不起 PowerShell，也不等它。Mac 上这一轮给以前装过、还没补终端设置的
    // 电脑补一次（只补一次，见 macos-shell-profile.ts）；Linux 同理，另外把小启动器
    // 和装着的工具对齐（linux-shell-profile.ts）。
    void cliTerminalAccess.sweepOnce(activeProviderIds.flatMap((provider, index) => {
      const probe = cliProbes[index]
      return probe.status === 'fulfilled' && probe.value.installation
        ? [{ provider, installation: probe.value.installation }]
        : []
    })).catch((error: unknown) => {
      // 没人等它，出错也不该变成进程级的未处理 Promise；留一行日志就够，下次打开软件会再清。
      runtimeLog?.log('warn', 'install', 'cli.powershell-shim.sweep-failed', '打开软件后顺手清理旧启动文件没有完成', {
        reason: credentialFailureReason(error),
      })
    })
    const networkRegion = network.region

    // 离线时四家探测会一个个耗满超时，首屏本地信息早就齐了却还在等；
    // 给整批一个总预算，到点先出画面（见 settleLatestVersionProbes）。
    const uncheckedLatest = activeProviderIds.map(
      (id, index) => buildUncheckedLatestVersion(id, cliResults[index].installed, undefined, platform),
    )
    const latestVersionBudgetMs = networkProbeSuggestsOffline(network)
      ? offlineLatestVersionBudgetMs
      : null
    const latestVersionBudget = latestVersionBudgetMs === null ? undefined : new AbortController()
    const latestVersions = await settleLatestVersionProbes(
      activeProviderIds.map((id, index) => inspectCliLatestVersion(
        id,
        cliResults[index],
        networkRegion,
        latestVersionBudget?.signal,
      )),
      uncheckedLatest,
      latestVersionBudgetMs,
      latestVersionBudget,
    )
    const scanSettings = store.read()
    const updateHistory = cliUpdateHistory.read()
    const scannedAt = Date.now()
    const clis = Object.fromEntries([
      ...activeProviderIds.map((id, index) => {
        const status = cliResults[index]
        return [id, buildCliStatus(status, latestVersions[index], buildCliVersionAdvice(id, status.version, {
          siteId: scanSettings.relaySiteId,
          alwaysLatest: scanSettings.alwaysInstallLatestCli === true,
        }), resolveCliRevertVersion(id, updateHistory[id], status.version, scannedAt, scanSettings.relaySiteId))] as const
      }),
      // 下线的工具不起进程、不问 npm，只给一格占位（CliStatus.retired）。
      ...retiredProviderIds.map((id) => [id, buildRetiredCliStatus(id, platform)] as const),
    ]) as Record<ProviderId, CliStatus>

    // A Microsoft Store install is outside the app's installer IPC. Once a
    // scan positively sees the desktop package again, treat that as the user's
    // manual opt-in and re-enable future managed installs.
    if (codexDesktop.installed && store.read().codexDesktopInstallDisabled) {
      await store.update({ version: 2, codexDesktopInstallDisabled: false })
    }

    return {
      checkedAt: new Date().toISOString(),
      network,
      runtime: { node, npm, python, git },
      clis,
      desktopApps: { codex: codexDesktop },
      officialChatGpt: officialChatGptResult.status === 'fulfilled' ? officialChatGptResult.value : null,
    }
  }

  async function inspectCodexSetupStatus(): Promise<CodexSetupStatus> {
    const [nodeResult, npmResult, desktopResult] = await Promise.allSettled([
      inspectNode(),
      inspectTool('npm'),
      inspectCodexDesktop(),
    ])
    // 三路探测彼此独立；任一异常都不应连累其余两个已知结果（同 scanSystem，见 317b34f）
    const node = buildToolStatusFromSettled(nodeResult)
    const npm = buildToolStatusFromSettled(npmResult)
    const desktop = buildDesktopAppStatusFromSettled(desktopResult)
    const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npm.path)
    // CLI 探测依赖上面 npm 探测的结果，只能顺序执行、无法并入 allSettled；
    // 同样降级为「检测失败」而非「未安装」，避免向导误判并对已在正常工作的 CLI 触发重装
    const [cliSettled] = await Promise.allSettled([inspectCliTool('codex', npm.path, npmGlobalRoot)])
    const cli = buildCliToolStatusFromSettled(cliSettled)
    return { checkedAt: new Date().toISOString(), runtime: { node, npm }, cli, desktop }
  }

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

  /**
   * A persisted zh-CN override must also affect a later ordinary “打开”
   * action, not only the click that originally changed the setting. Resolve
   * that flag at the last possible moment so a fresh process restart keeps the
   * local CDP enhancement without changing the system-language path.
   */
  async function launchCodexDesktop(
    mode: CodexDesktopLaunchMode,
    target: RendererMessageTarget,
    launchOptions: { injectChinese?: boolean; accountWork?: QueuedAccountWork } = {},
  ): Promise<CodexDesktopLaunchResult> {
    // Configs created before the permission picker was introduced often omit
    // both legacy fields. Add only missing defaults so a mirror-installed
    // Desktop gets the same interactive baseline as a local installation.
    try {
      // Only normalize configs managed by Xingmang. An official/custom Codex
      // profile is user-owned and must remain byte-for-byte untouched here.
      // Decide inside the queue: a save that was in flight may just have
      // switched the profile.
      await writeBeforeLaunch(() => {
        if (inspectNativeProviderConfig('codex').matchesRelay) ensureCodexPermissionDefaults(providerRoots)
      })
    } catch {
      // The launch path remains available; malformed configs are reported by
      // Codex itself and by the dedicated permission inspection below.
    }
    let effectiveLaunchMode = mode
    let repairPermissionModeVisibility = false
    if (platform === 'win32') {
      const globalState: CodexDesktopGlobalStateStatus = inspectCodexDesktopGlobalState(providerRoots.codexHome)
      if (globalState.needsRepair) {
        repairPermissionModeVisibility = true
        // The Desktop keeps the legacy value in memory and writes it back on
        // exit. Force a full restart before migration when an open action
        // finds a running instance; otherwise the repair would be lost.
        if (mode === 'open') {
          const desktop = await inspectCodexDesktop()
          if (desktop.running) effectiveLaunchMode = 'restart'
        }
      }
    }
    let injectChinese = launchOptions.injectChinese
    if (injectChinese === undefined && platform === 'win32') {
      // The runtime patch is the only reason this app ever starts Codex with a
      // remote debugging port, and that port then stays open -- unauthenticated
      // on loopback -- for the whole Codex session. Consent therefore comes
      // from the stored setting written by the explicit 「启用中文界面」 action,
      // never from config.toml: `localeOverride = "zh-CN"` is a value this
      // program writes by itself, so reading it as consent made the debugging
      // port the default path for every Chinese customer (E-S3).
      injectChinese = store.read().codexDesktopChineseRuntimePatch === 'enabled'
      try {
        const locale = await inspectCodexDesktopLocale()
        if (shouldAutoConfigureCodexDesktopChineseLocale(locale)) {
          // Installations created before the locale flow have no override at
          // all. Persisting the Chinese default still costs nothing: the native
          // menus and the packaged locale honor it without any debugging port,
          // and only the web view's Statsig gate needs the runtime patch.
          // `writeCodexDesktopLocale` re-validates the safe path and TOML, so a
          // malformed or redirected config can never be silently overwritten.
          await writeBeforeLaunch(() => writeCodexDesktopLocale({ codexHome: providerRoots.codexHome }, 'zh-CN'))
        }
      } catch {
        // The normal launch remains available if a locale probe is temporarily
        // unavailable; config.toml will still be honored by Codex itself.
      }
    }
    return launchCodexDesktopOperation(effectiveLaunchMode, target, {
      ...launchOptions,
      injectChinese,
      repairPermissionModeVisibility,
    })
  }

  async function launchProviderOperation(
    provider: ProviderId,
    workspace: string,
    mode: CliLaunchMode,
    resumeSessionId: string | null,
  ): Promise<CliLaunchResult> {
    const nativeConfig = inspectNativeProviderConfig(provider)
    if (!canLaunchManagedProvider(nativeConfig)) {
      throw new Error(managedProviderLaunchBlockedMessage(provider))
    }
    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
      throw new Error('工作目录不存在，请重新选择')
    }
    // 从星芒打开的窗口读的是现在的配置：之前标的「需重开生效」说的不是它了（C19 另按「开着」算 Gemini）。
    toolLaunchedAt.set(provider, Date.now())
    toolRouteRestartPending.delete(provider)
    if (provider === 'grok') await repairGrokHooksBeforeLaunch()

    const definition = cliCatalog[provider]
    // 主目录、盘根、桌面、系统目录、四家工具的配置目录等敏感目录不写信任、也不生成 AGENTS.md：
    // 两者都是「配一次管整棵目录树」的动作，放在这种目录上等于把整台电脑标成
    // 可信、给所有项目加一份看不见的说明（workspace-guard.ts）。打开本身照常，
    // 信任那一问由 CLI 自己去问 —— 在这种目录上那一问是有意义的。
    const workspaceSensitivity = classifyWorkspace(workspace, {
      platform,
      home: providerRoots.userHome,
    })
    if (workspaceSensitivity) {
      runtimeLog?.log('info', 'config', 'workspace.guard.skipped', `${definition.name} 打开的是${sensitiveWorkspaceLabel(workspaceSensitivity)}，不写入信任，也不生成项目说明`, {
        provider,
        kind: workspaceSensitivity,
      })
    }
    // 目录是用户刚在本软件的对话框里亲自选的，再让他去读一遍 CLI 自己的英文
    // 信任问答没有意义，所以打开之前先把这一项写进 CLI 的配置。写不进去
    // （文件损坏、只读、主目录被重定向）绝不能挡住打开：CLI 自己还会问一次。
    if (!workspaceSensitivity) {
      try {
        const trust = await writeBeforeLaunch(() => trustManagedWorkspace(provider, providerRoots, workspace))
        if (trust.changed) {
          runtimeLog?.log('info', 'config', 'workspace.trust.written', `${definition.name} 已信任所选工作目录`, {
            provider,
          })
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        runtimeLog?.log('warn', 'config', 'workspace.trust.failed', `${definition.name} 未能记录工作目录信任，将由工具自己询问`, {
          provider,
          reason: redactHomeDirectory(reason, providerRoots.userHome),
        })
      }
    }
    // 目录里三种项目说明文件（CLAUDE.md / AGENTS.md / GEMINI.md）一个都没有、
    // 且本应用没给这个目录生成过时，放一份中文 AGENTS.md，三个工具打开这个目录
    // 都会读它。绝不覆盖已有文件；客户删掉生成的那份就不再生成（记录在
    // projectInstructionsState 里，不往客户目录写标记）；写不进去（磁盘满、只读、
    // 目录被重定向）绝不能挡住打开。
    if (serviceOptions.projectInstructionsTemplatePath && !workspaceSensitivity) {
      try {
        const template = readProjectInstructionsTemplate(serviceOptions.projectInstructionsTemplatePath)
        const result = await ensureProjectInstructions({
          workspace,
          template,
          state: projectInstructionsState,
        })
        if (result.created) {
          runtimeLog?.log('info', 'config', 'project-instructions.created', `${definition.name} 已为工作目录生成 AGENTS.md`, {
            provider,
          })
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        runtimeLog?.log('warn', 'config', 'project-instructions.failed', `${definition.name} 未能生成项目说明，将不影响打开`, {
          provider,
          reason: redactHomeDirectory(reason, providerRoots.userHome),
        })
      }
    }
    // Gemini CLI 默认只把 GEMINI.md 当项目说明，得在用户级 settings.json 里把
    // AGENTS.md 一起加进 context.fileName，它才会读到上面生成的那份。只补不删。
    if (provider === 'gemini') {
      try {
        const written = ensureGeminiProjectContextFiles(providerRoots)
        if (written.changed) {
          runtimeLog?.log('info', 'config', 'gemini.context-files.written', 'Gemini CLI 已配置为读取 AGENTS.md', {
            provider,
          })
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        runtimeLog?.log('warn', 'config', 'gemini.context-files.failed', 'Gemini CLI 项目说明配置未写入，将不影响打开', {
          provider,
          reason: redactHomeDirectory(reason, providerRoots.userHome),
        })
      }
    }
    const launchResult = inspectLaunchConfigOverrides(provider, workspace, nativeConfig)
    const accountMode = providerAccountMode(nativeConfig)
    const excludedVariables = launchExcludedEnvironmentVariables(provider, accountMode)
    // Grok 按 PATH 挑跑钩子的 shell：补上注册表里新加的那几段，与 expectedGrokWindowsShell 推的是同一份 PATH。
    // 只在不跨提权边界时补；trusted-only 的终端 PATH 由 trustedCommandEnvironment 重建，不收用户可写的目录（I2）。
    const providerEnv = withoutEnvironmentVariables(
      provider === 'grok' && platform === 'win32' && windowsExecutionMode === 'same-user'
        ? withAppendedWindowsPath(providerEnvironment(provider), windowsLivePath)
        : providerEnvironment(provider),
      excludedVariables,
    )
    if (provider === 'gemini') {
      // Gemini CLI 0.59 may skip ~/.gemini/.env for an untrusted workspace,
      // and it never overwrites conflicting parent-process variables. Pass the
      // exact inspected managed values for this launch so the selected account
      // cannot silently fall back to another endpoint or model.
      if (nativeConfig.apiKey) providerEnv.GEMINI_API_KEY = nativeConfig.apiKey
      if (nativeConfig.baseUrl) providerEnv.GOOGLE_GEMINI_BASE_URL = nativeConfig.baseUrl
      if (nativeConfig.model) providerEnv.GEMINI_MODEL = geminiCliCompatibleModel(nativeConfig.model)
    }
    // 打开只用得上 npm 在哪，用不上它的版本号；inspectTool 会多起一次 `npm --version`
    // （Windows 上是 .cmd 再套 node，还要过一遍杀毒），每点一次「打开」都白等那一下。
    // 路径照旧每次现查，不缓存，刚装 / 卸 / 换过 Node 也不会拿到旧答案。
    const npmPath = await findInstalledExecutable('npm')
    const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npmPath)
    const { status: installedStatus, installation } = await inspectCliTool(provider, npmPath, npmGlobalRoot)
    if (!installation) throw new Error(`未检测到 ${definition.name}，请先安装`)

    if (platform === 'win32') {
      let command
      try {
        command = await resolveVerifiedCliCommand(provider, providerEnv, windowsExecutionMode)
        if (windowsExecutionMode === 'trusted-only') {
          assertTrustedElevatedCliCommand(command, definition.name)
        }
        await launchCliPowerShellForService({
          executable: command.executable,
          argv: cliLaunchArgv(provider, command.argv, mode, {
            installedVersion: installedStatus.version,
            resumeSessionId,
          }),
          workspace,
          title: `${definition.name} · 星芒AI`,
          // The broker starts this terminal with Start-Process, so it inherits
          // the elevated token. Without the trusted base, NODE_OPTIONS and the
          // other injection variables would cross the integrity boundary and
          // run attacker code as administrator. assertTrustedElevatedCliCommand
          // only vets the executable path and cannot see the environment.
          env: await withoutDeadLoopbackProxies(interactiveTerminalEnvironment(
            providerEnv,
            windowsExecutionMode === 'trusted-only' ? trustedCommandEnvironment : sameUserTerminalEnvironment,
          ), provider),
        })
      } catch (error) {
        if (error instanceof WindowsCliLaunchError) {
          // 错误框只说原因；PowerShell 和 Node 交回来的原文记在这一条里，路径按主目录脱敏（I13）。
          const { stderr, message, ...exit } = error.launchOutput
          runtimeLog?.log('warn', 'system', 'terminal.failed', `${definition.name} 的命令窗口没能打开`, {
            provider,
            ...exit,
            stderr: stderr && redactHomeDirectory(stderr, providerRoots.userHome),
            message: message && redactHomeDirectory(message, providerRoots.userHome),
          })
        }
        throw new Error(toolLaunchFailureMessage(definition.name, error), { cause: error })
      }
      return launchResult
    }

    if (platform === 'darwin') {
      try {
        // 客户自己那份 Node.js 太旧时，要 node 才跑得起来的工具（比如 Gemini CLI）用代下的那份跑；
        // 下面交给终端的环境照旧，客户在工具里跑 node 还是他自己那份（第三十四批 A）。
        const nodeDirectories = await preferredNodeDirectories()
        const command = await resolveVerifiedCliCommand(provider, providerEnv, windowsExecutionMode, {
          darwinStagingRetention: 'retained',
          ...(nodeDirectories.length ? { nodeDirectories } : {}),
        })
        await launchMacosTerminalForService(buildDarwinCliLaunchPlan(
          {
            ...command,
            argv: cliLaunchArgv(provider, command.argv, mode, { installedVersion: installedStatus.version, resumeSessionId }),
          },
          workspace,
          withSystemCertificateTrust(providerEnv),
          macosShellOverrideVariables(provider, accountMode),
        ))
      } catch (error) {
        // Windows、Linux 另记一条 terminal.failed；Mac 上 open 交回来的退出码和原话挂在 cause 上，
        // 随这次失败一起进运行日志。
        throw new Error(toolLaunchFailureMessage(definition.name, error), { cause: error })
      }
      return launchResult
    }

    // Linux：找一个命令窗口程序，交给它一份一次性启动脚本，脚本真的跑起来才算打开
    // （linux-terminal.ts，Linux 版拆分 ⑤）。
    try {
      // 打开的工具同样带不上一个没开的本机代理，否则连不上中转（Linux 版拆分 ②，与上面 Windows 那条同理）。
      const environment = await withoutDeadLoopbackProxies(
        interactiveTerminalEnvironment(providerEnv, sameUserTerminalEnvironment),
        provider,
      )
      const command = await resolveVerifiedCliCommand(provider, providerEnv, windowsExecutionMode)
      const opened = await launchLinuxTerminalForService({
        executable: command.executable,
        argv: cliLaunchArgv(provider, command.argv, mode, { installedVersion: installedStatus.version, resumeSessionId }),
        workspace,
        title: `${definition.name} · 星芒AI`,
        env: environment,
        // 交给已经开着的命令窗口程序时，工具拿到的是那个程序自己的环境，上面去掉的得在脚本里再去一次。
        ...(excludedVariables.length ? { clearedEnvironmentKeys: excludedVariables } : {}),
      })
      runtimeLog?.log('info', 'system', 'terminal.opened', `${definition.name} 已在「${opened.terminal.label}」里打开`, {
        provider,
        terminal: opened.terminal.id,
        ...describeLinuxTerminalAttempts(opened.attempts),
      })
    } catch (error) {
      if (error instanceof LinuxTerminalLaunchError) {
        runtimeLog?.log('warn', 'system', 'terminal.failed', `${definition.name} 的命令窗口没能打开`, {
          provider,
          ...describeLinuxTerminalAttempts(error.attempts),
          ...(error.reason ? { reason: redactHomeDirectory(error.reason, providerRoots.userHome) } : {}),
        })
      }
      throw new Error(toolLaunchFailureMessage(definition.name, error), { cause: error })
    }
    return launchResult
  }

  /** 日志只写试过哪几个命令窗口、各自怎么失败的；路径按主目录脱敏（I13）。 */
  function describeLinuxTerminalAttempts(attempts: readonly LinuxTerminalAttempt[]): Record<string, unknown> {
    if (!attempts.length) return {}
    return {
      attempts: attempts.map((attempt) => ({
        terminal: attempt.terminal,
        executable: redactHomeDirectory(attempt.executable, providerRoots.userHome),
        outcome: attempt.outcome,
        detail: attempt.detail,
      })),
    }
  }

  /**
   * 项目文件夹里（或公司统一下发）的设置会盖过当前账号时，打开照常，只带回一句
   * 提醒并记一条日志。只读，不动那些文件；查的过程出任何错都不能挡住打开。
   */
  function inspectLaunchConfigOverrides(
    provider: ProviderId,
    workspace: string,
    nativeConfig: NativeConfigInspection,
  ): CliLaunchResult {
    const definition = cliCatalog[provider]
    try {
      const overrides = inspectWorkspaceConfigOverrides(provider, workspace, {
        platform,
        home: providerRoots.userHome,
        codexHome: providerRoots.codexHome,
        current: {
          baseUrl: nativeConfig.baseUrl,
          apiKey: nativeConfig.apiKey,
          authType: nativeConfig.authType,
          codexAuthMode: nativeConfig.codexAuthMode,
        },
      })
      if (!overrides.length) return {}
      runtimeLog?.log('warn', 'config', 'workspace.config-override', `${definition.name} 的项目文件夹或这台电脑上有会盖过当前账号的设置`, {
        provider,
        severity: overrides.some((entry) => entry.severity === 'blocking' && !entry.launchUnaffected) ? 'blocking' : 'possible',
        scopes: [...new Set(overrides.map((entry) => entry.scope))],
        files: overrides.map((entry) => redactHomeDirectory(
          describeOverride(entry, workspace, providerRoots.userHome, platform),
          providerRoots.userHome,
        )),
      })
      const notice = launchOverrideNotice(definition.name, overrides)
      return notice ? { configOverrideNotice: notice } : {}
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      runtimeLog?.log('warn', 'config', 'workspace.config-override.failed', `${definition.name} 未能检查项目文件夹里的设置，将不影响打开`, {
        provider,
        reason: redactHomeDirectory(reason, providerRoots.userHome),
      })
      return {}
    }
  }

  function launchProvider(
    provider: ProviderId,
    workspace: string,
    mode: CliLaunchMode = 'new',
    resumeSessionId: string | null = null,
    accountWork?: QueuedAccountWork,
  ): Promise<CliLaunchResult> {
    async function launch(): Promise<CliLaunchResult> {
      return {
        ...await launchProviderOperation(provider, workspace, mode, resumeSessionId),
        rememberedWorkspace: rememberedWorkspaceFor(store.read().workspace),
      }
    }
    return installationQueue.enqueue(
      buildCliLaunchQueueKey(provider, workspace, mode, resumeSessionId),
      () => accountWork ? accountWork.run(launch) : launch(),
      { signal: accountWork?.signal },
    )
  }

  async function inspectCodexDesktopLocale(): Promise<CodexDesktopLocaleStatus> {
    const desktop = await inspectCodexDesktop()
    return inspectCodexDesktopLocaleStatus({
      codexHome: providerRoots.codexHome,
      installed: desktop.installed,
      version: desktop.version,
      installDirectory: desktop.installDirectory,
      running: desktop.running,
      platform,
    })
  }

  function inspectCodexWorkspacePermissionsForService(): CodexWorkspacePermissionStatus {
    const workspace = store.read().workspace
    try {
      return inspectCodexWorkspacePermissions(providerRoots, workspace)
    } catch (error) {
      return {
        configPath: path.join(providerRoots.codexHome, 'config.toml'),
        workspace,
        configExists: false,
        trustLevel: 'unknown',
        approvalPolicy: null,
        permissionProfile: null,
        sandboxMode: null,
        control: 'unknown',
        error: error instanceof Error ? error.message : 'Codex 权限配置读取失败',
      }
    }
  }

  async function trustCodexWorkspaceForService(
    target: RendererMessageTarget,
  ): Promise<CodexWorkspacePermissionWriteResult & { restarted: boolean }> {
    const workspace = store.read().workspace
    if (!path.isAbsolute(workspace)) throw new Error('Codex 工作目录不是绝对路径')
    try {
      if (!fs.statSync(workspace).isDirectory()) throw new Error('工作目录不是文件夹')
    } catch {
      throw new Error('Codex 工作目录不存在，请重新选择')
    }
    // 客户点的按钮，等保存做完再写，不像打开前那几样排不上就算了；重开桌面端放在队外（它自己还要排队）。
    const result = await serializeConfigWrite(async () => trustCodexWorkspace(providerRoots, workspace))
    let restarted = false
    // 只在 Windows 上替人重开：Mac 上主进程一律拒绝重启 Codex（codex-desktop-service.ts），
    // 信任这时已经写进去了，再去重启只会把「已保存」变成一个报错框（第二十九批 A 的同一个原因）。
    if (result.changed && platform === 'win32') {
      const desktop = await inspectCodexDesktop()
      if (desktop.running) {
        await launchCodexDesktop('restart', target)
        restarted = true
      }
    }
    return {
      ...result,
      restarted,
      status: inspectCodexWorkspacePermissionsForService(),
    }
  }

  async function setCodexDesktopLocale(
    locale: CodexDesktopLocale,
    target: RendererMessageTarget,
  ): Promise<CodexDesktopLocaleResult> {
    if (locale !== 'zh-CN' && locale !== 'system') throw new Error('Codex Desktop 语言选项无效')
    const before = await inspectCodexDesktopLocale()
    if (before.error) throw new Error(before.error)
    if (!before.installed) throw new Error('未检测到 Codex Desktop，请先安装后重新检测')
    if (locale === 'zh-CN' && !before.chineseResources.available) {
      throw new Error('当前 Codex Desktop 安装包没有本地简体中文资源，请先通过镜像更新 Codex Desktop')
    }
    const changed = codexDesktopLocaleNeedsChange(before.configuredLocale, locale)
    if (changed) await serializeConfigWrite(() => writeCodexDesktopLocale({ codexHome: providerRoots.codexHome }, locale))
    // This call is the explicit switch for the runtime patch, so it is also the
    // only place that grants or withdraws consent for the debugging port. Store
    // it before the restart: a failed restart must not leave the later ordinary
    // 「打开」 path disagreeing with what the user just chose.
    await store.update({ version: 2, codexDesktopChineseRuntimePatch: locale === 'zh-CN' ? 'enabled' : 'disabled' })
    let launchResult: CodexDesktopLaunchResult | undefined
    // A saved zh-CN preference is not proof that a previous runtime patch
    // worked. Explicitly enabling Chinese is also the retry path.
    if (before.running && platform === 'win32' && (changed || locale === 'zh-CN')) {
      launchResult = await launchCodexDesktop('restart', target, { injectChinese: locale === 'zh-CN' })
    }
    const after = await inspectCodexDesktopLocale()
    if (codexDesktopLocaleNeedsChange(after.configuredLocale, locale)) {
      throw new Error('语言设置保存后未通过回读检查，请重新尝试')
    }
    const runtimeVerified = locale === 'zh-CN' && launchResult?.chineseLocale?.status === 'verified'
    const warning = locale === 'zh-CN' && launchResult && !runtimeVerified
      ? launchResult.chineseLocale?.message || '中文设置已保存，但本次未确认中文界面生效。请再次启用中文界面以重试。'
      : undefined
    return {
      ...after,
      restarted: launchResult?.restarted ?? false,
      runtimeVerified,
      needsRestart: locale === 'zh-CN' ? !runtimeVerified : changed && !launchResult,
      ...(warning ? { warning } : {}),
    }
  }

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

  let externalConfigQueue: Promise<unknown> = Promise.resolve()
  let latestExternalClients: ExternalClientStatus[] | null = null
  const externalClientCache = serviceOptions.externalClientSnapshotCacheFile
    ? createExternalClientSnapshotCache({
        filePath: serviceOptions.externalClientSnapshotCacheFile,
        onWarning: (code, message) => runtimeLog?.log('warn', 'system', code, '上次客户端检测结果没有读写成功', { error: message }),
      })
    : null
  let externalScansStarted = 0
  let newestExternalScanSaved = 0
  // 这次运行里替哪个账号的哪个客户端换过线路，记着原来的地址和那把 Key（只在主进程内存里）：
  // 换完又回到原来那份（推测是客户端退出时把旧配置写了回去），要能在日志里说出来。
  const externalRoutesFollowed = new Map<string, { from: RelayEndpointId; baseUrl: string; apiKey: string }>()
  async function claudeDesktopConfig(status: ExternalClientRuntimeStatus, assertBeforeWrite?: () => void) {
    if (status.detectionError) throw new Error('Claude Desktop 安装位置无法确认，请重新检测')
    const env = serviceOptions.claudeDesktopEnv ?? (providerRoots.userHome === os.homedir() ? process.env : {})
    const installationPath = status.path ?? undefined
    const storeVirtualization = env.CLAUDE_USER_DATA_DIR ? undefined
      : await (serviceOptions.inspectClaudeDesktopStoreVirtualization ?? inspectClaudeDesktopStoreVirtualization)({ platform, installationPath })
    assertBeforeWrite?.()
    const roots = resolveClaudeDesktopPaths({ platform, userHome: providerRoots.userHome, env, installationPath, storeVirtualization })
    return createClaudeDesktopConfigService({
      dataDirectory: serviceOptions.managerDataDirectory ?? path.join(providerRoots.userHome, '.xingmang-ai-manager'),
      ...roots,
      assertBeforeWrite,
      assertUnmanaged: serviceOptions.assertClaudeDesktopUnmanaged ?? (() => assertClaudeDesktopUnmanaged({ platform, userHome: providerRoots.userHome })),
    })
  }
  /**
   * 「这个客户端该对哪个地址、用谁的账号对账」只算一次：检测、连接自检与保存
   * 后的复测读的必须是同一份，否则换过站点或换过账号的用户会在三处拿到三种
   * 说法。
   */
  function externalClientContext(tool: ExternalToolId) {
    const activeSite = activeRelaySite()
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    const baseUrl = tool === 'claudeDesktop' ? activeSite.providerBaseUrls.claude : activeSite.providerBaseUrls.codex
    const belongsToCurrentAccount = (apiKey: string) => owner !== null
      && serviceOptions.getExternalClientAccountId?.() === owner
      && activeRelaySite().id === activeSite.id
      && externalOwnership.matches(tool, owner, baseUrl, apiKey)
    return { activeSite, baseUrl, belongsToCurrentAccount }
  }
  async function describeExternalClient(status: ExternalClientRuntimeStatus): Promise<ExternalClientStatus> {
    const { baseUrl, belongsToCurrentAccount } = externalClientContext(status.tool)
    if (status.tool === 'claudeDesktop') {
      try {
        return { ...status, ...await (await claudeDesktopConfig(status)).inspectConnection(baseUrl, belongsToCurrentAccount) }
      } catch {
        return { ...status, configured: false, model: null, configurationSource: 'unknown',
          configurationError: 'Claude Desktop 本地配置目录无法确认，请重新检测。' }
      }
    }
    const xdgConfig = providerRoots.userHome === os.homedir() ? process.env.XDG_CONFIG_HOME : undefined
    if (xdgConfig && !path.isAbsolute(xdgConfig)) return { ...status, configured: false, model: null,
      configurationSource: 'unknown', configurationError: 'XDG_CONFIG_HOME 必须是绝对路径。' }
    const externalPlatform = platform === 'win32' || platform === 'darwin' ? platform : 'linux'
    return { ...status, ...inspectExternalToolConnection(status.tool, externalPlatform, {
      userHome: providerRoots.userHome, configHome: xdgConfig || path.join(providerRoots.userHome, '.config'),
    }, baseUrl, belongsToCurrentAccount) }
  }
  /**
   * 客户端配置里那把密钥。**只在主进程内部用**：它要被拿去发一次真实请求，
   * 永远不跨 IPC（I3）。取不出来（没配、不是当前账号写的、文件读不了）一律
   * 回 null，由调用方按「未配置 / 本地配置」去说。
   */
  async function externalClientProbeCredential(
    status: ExternalClientRuntimeStatus,
    baseUrl: string,
    belongsToCurrentAccount: (apiKey: string) => boolean,
  ): Promise<ExternalToolProbeCredential | null> {
    try {
      if (status.tool === 'claudeDesktop') {
        return await (await claudeDesktopConfig(status)).inspectGatewayCredential(baseUrl, belongsToCurrentAccount)
      }
      const xdgConfig = providerRoots.userHome === os.homedir() ? process.env.XDG_CONFIG_HOME : undefined
      if (xdgConfig && !path.isAbsolute(xdgConfig)) return null
      const externalPlatform = platform === 'win32' || platform === 'darwin' ? platform : 'linux'
      return resolveExternalToolProbeCredential(status.tool, externalPlatform, {
        userHome: providerRoots.userHome, configHome: xdgConfig || path.join(providerRoots.userHome, '.config'),
      }, baseUrl, belongsToCurrentAccount)
    } catch {
      // 读不出来不是自检失败，是「本地配置」层的结论，由 describeExternalClient
      // 那一份已经算出来的 configurationSource 去说。
      return null
    }
  }
  /**
   * 外部客户端的连接自检。「检查」页与保存后的复测走同一条路，所以两处永远
   * 给同一句结论。
   */
  async function checkExternalClientConnection(
    tool: ExternalToolId,
    knownStatus?: ExternalClientRuntimeStatus | null,
  ): Promise<ExternalClientCheckResult> {
    const { activeSite, baseUrl, belongsToCurrentAccount } = externalClientContext(tool)
    // 装没装这件事只在 Windows 上要跑一轮 PowerShell 盘点。调用方手里已经有一份
    // 时就用那份：保存配置之后顺手自检不该为此再盘点一次机器。
    const status = knownStatus ?? (await externalClientRuntime.scan()).find((entry) => entry.tool === tool) ?? null
    const described = status ? await describeExternalClient(status) : null
    const credential = status && described?.configurationSource === 'xingmang'
      ? await externalClientProbeCredential(status, baseUrl, belongsToCurrentAccount)
      : null
    return runExternalClientCheck({
      tool,
      installed: status?.installed === true,
      baseUrl,
      configurationSource: described?.configurationSource ?? 'unknown',
      configurationError: described?.configurationError ?? null,
      model: credential?.model ?? described?.model ?? null,
      apiKey: credential?.apiKey ?? null,
      ...(described?.officialAccount ? { officialAccount: true } : {}),
    }, activeSite.id, { fetch: serviceOptions.relayFetch })
  }
  async function scanExternalClients(force = false): Promise<ExternalClientStatus[]> {
    const started = ++externalScansStarted
    // 本机盘点几分钟内复用（见 external-client-runtime 的缓存），配置每次都重读：
    // 保存配置之后那次刷新要看到的正是刚写下去的那份。
    const clients = await followExternalClientRoutes(await externalClientRuntime.scan({ force }))
    // 反馈报告要答「客户端装没装、什么版本、配置指没指向当前账号」，而生成报告
    // 时不该再发一轮探测（同 latestTraySystem 的取舍）。这份快照就是那一段的
    // 数据源：只在用户自己点检测时更新。
    latestExternalClients = clients
    // 下次开机首页先摆它（已知13）。强制重扫与普通扫描可能交错完成，落盘只让后开始的那一轮
    // 覆盖先开始的，同 CLI 那份快照。
    if (started > newestExternalScanSaved) {
      newestExternalScanSaved = started
      void externalClientCache?.save(clients)
    }
    return clients
  }
  async function cachedExternalClients(): Promise<ExternalClientStatus[]> {
    if (latestExternalClients || !externalClientCache) return []
    const cached = await externalClientCache.load()
    // 读文件这几毫秒里真的检测可能已经回来了，那就不必再给旧的。
    return latestExternalClients || !cached ? [] : cached
  }
  /** 反馈报告用的上一份客户端快照；还没检测过时为 null，那一段写「未能读取」。 */
  function getLastExternalClients(): ExternalClientStatus[] | null {
    return latestExternalClients
  }
  async function installExternalClient(tool: ExternalToolId, target: RendererMessageTarget): Promise<ExternalClientStatus> {
    const status = await externalClientRuntime.install(tool, (event) => {
      if (!target.isDestroyed()) {
        try { target.send('external-clients:install-progress', event) } catch { /* Installation continues if the renderer exits. */ }
      }
    })
    const described = await describeExternalClient(status)
    // 就地替换而不是追加：这份快照的顺序就是反馈报告与界面读到的顺序。
    latestExternalClients = latestExternalClients?.some((entry) => entry.tool === tool)
      ? latestExternalClients.map((entry) => entry.tool === tool ? described : entry)
      : [...(latestExternalClients ?? []), described]
    return described
  }
  const cancelExternalClientInstall = (tool: ExternalToolId) => externalClientRuntime.cancelInstall(tool)
  const launchExternalClient = (tool: ExternalToolId) => externalClientRuntime.launch(tool)
  /**
   * 保存之后立刻回读一遍并自检。这一步问出来的比保存时那次模型清单校验多两件
   * 事：写下去的配置本机能不能原样读回来、读回来的那把密钥在客户端真正会打的
   * 那个地址上还认不认。自检本身出岔子不该把「已经写成功了」变成失败，所以整
   * 段吞掉异常，只是结果变成 null（界面照实说「这次没测成」）。
   */
  async function verifySavedExternalClient(
    tool: ExternalToolId,
    knownStatus?: ExternalClientRuntimeStatus | null,
  ): Promise<ExternalClientCheckResult | null> {
    try {
      return await checkExternalClientConnection(tool, knownStatus)
    } catch {
      return null
    }
  }
  function configureExternalTool(
    tool: ExternalToolId,
    requested: ExternalToolConfigOptions,
    assertBeforeWrite?: () => void,
    keySource?: ExternalClientKeySource,
  ): Promise<ExternalClientConfigResult> {
    const work = async (): Promise<ExternalClientConfigResult> => {
      assertBeforeWrite?.()
      const activeSite = activeRelaySite()
      const owner = serviceOptions.getExternalClientAccountId?.() ?? null
      const apiKey = requested.apiKey?.trim() ?? ''
      const model = requested.model?.trim() ?? ''
      if (!model || model.length > 256 || /[\x00-\x1f\x7f]/.test(model)) throw new Error('请选择有效模型')
      const models = await fetchAvailableModels(apiKey, { bypassCache: true })
      const assertContext = () => {
        assertBeforeWrite?.()
        if (activeRelaySite().id !== activeSite.id) throw new Error('账号已变化，请重新配置')
        if ((serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) throw new Error('账号已变化，请重新配置')
      }
      assertContext()
      if (!models.includes(model)) throw new Error('当前密钥不支持所选模型，请重新检测')
      if (tool === 'claudeDesktop') {
        const status = (await externalClientRuntime.scan()).find((entry) => entry.tool === tool)
        assertContext()
        if (!status?.installed) throw new Error('请先安装 Claude Desktop，再保存第三方推理配置')
        const gateway = await claudeDesktopConfig(status, assertContext)
        // 只写客户选中的那一个型号。0.2.12 曾把当前 Key 能用的全部 claude-* 型号都写进去（#685），
        // 客户 Mac 上 Claude Desktop 随即提示型号被拒、发消息没回复，退回只写一个（0.2.8 的做法）就好了。
        const input = { baseUrl: activeSite.providerBaseUrls.claude, apiKey, authScheme: 'bearer' as const, models: [model] }
        const result = await gateway.saveGateway(input)
        assertContext()
        if (owner) await externalOwnership.write(tool, owner, activeSite.providerBaseUrls.claude, apiKey, keySource)
        const connection = await verifySavedExternalClient(tool, status)
        return { tool, model, path: result.path, files: result.files, backups: result.backups,
          outcome: 'configured', message: result.warnings.join(' '),
          restartRequired: result.restartRequired,
          connectionVerified: connection?.ok === true, connection }
      }
      const externalPlatform = platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : 'linux'
      const xdgConfig = providerRoots.userHome === os.homedir() ? process.env.XDG_CONFIG_HOME : undefined
      if (xdgConfig && !path.isAbsolute(xdgConfig)) throw new Error('XDG_CONFIG_HOME 必须是绝对路径')
      const result = await saveExternalToolConfig(tool, externalPlatform, {
        userHome: providerRoots.userHome, configHome: xdgConfig || path.join(providerRoots.userHome, '.config'),
      }, { apiKey, model, baseUrl: activeSite.providerBaseUrls.codex,
        protocol: tool === 'workbuddy' ? 'chat-completions' : requested.protocol ?? 'responses',
      }, { beforeReplace: assertContext })
      assertContext()
      if (owner) await externalOwnership.write(tool, owner, activeSite.providerBaseUrls.codex, apiKey, keySource)
      const connection = await verifySavedExternalClient(tool, latestExternalClients?.find((entry) => entry.tool === tool))
      return { tool, model, path: result.path, files: result.files, backups: result.backups, outcome: 'configured',
        message: tool === 'workbuddy' ? '配置已写入 WorkBuddy 桌面端。重新进入“设置 → 模型”选择此模型；列表未刷新时请重启 WorkBuddy。'
          : '全局配置与默认模型已保存。重新打开 OpenCode 后使用；项目配置或环境变量可能覆盖全局设置。',
        restartRequired: tool === 'opencode',
        connectionVerified: connection?.ok === true, connection }
    }
    const task = externalConfigQueue.then(work, work)
    externalConfigQueue = task.catch(() => undefined)
    return task
  }
  /**
   * 首页 Claude Desktop 卡上「切回官方账号 / 改用当前账号」。和保存配置排同一个队：两件事改的是同一个
   * 文件。切回当前账号只认星芒替当前账号写的、地址是当前线路的那一份，用不上就回 reconnect，界面接着
   * 打开「连接 Claude Desktop」重新保存。
   */
  function switchExternalClientSource(
    tool: ExternalToolId,
    target: 'account' | 'official',
    assertBeforeWrite?: () => void,
  ): Promise<ExternalClientSourceSwitchResult> {
    const work = async (): Promise<ExternalClientSourceSwitchResult> => {
      if (tool !== 'claudeDesktop') throw new Error('未知的外部客户端类型')
      assertBeforeWrite?.()
      const { baseUrl, belongsToCurrentAccount } = externalClientContext(tool)
      const status = (await externalClientRuntime.scan()).find((entry) => entry.tool === tool)
      assertBeforeWrite?.()
      if (!status?.installed) throw new Error(`还没有检测到 ${externalClientNames[tool]}`)
      const gateway = await claudeDesktopConfig(status, assertBeforeWrite)
      if (target === 'official') {
        const result = await gateway.useOfficialLogin(belongsToCurrentAccount)
        runtimeLog?.log('info', 'config', 'external-client.source-switched', 'Claude Desktop 已切回官方登录', { target, running: status.running })
        return { tool, target, outcome: 'switched', backups: result.backups,
          message: '已切回官方账号，原来的配置已备份。下次打开 Claude Desktop 时用你自己的 Claude 账号登录；现在开着的话，要完全退出再打开。用星芒时的聊天记录不会删，切回当前账号还能看到。' }
      }
      const result = await gateway.useGatewayLogin(baseUrl, belongsToCurrentAccount)
      runtimeLog?.log('info', 'config', 'external-client.source-switched', result.outcome === 'switched' ? 'Claude Desktop 已改用当前账号' : 'Claude Desktop 原来那份配置用不上，要重新连接', { target, outcome: result.outcome, running: status.running })
      if (result.outcome === 'reconnect') return { tool, target, outcome: 'reconnect' }
      return { tool, target, outcome: 'switched', backups: result.backups,
        message: '已改用当前账号，原来的配置已备份。Claude Desktop 现在开着的话，要完全退出再打开才会换过来。' }
    }
    const task = externalConfigQueue.then(work, work)
    externalConfigQueue = task.catch(() => undefined)
    return task
  }
  /**
   * 第四十三批 A：用户换了线路、重启以后，星芒替当前账号写进 Claude Desktop、WorkBuddy、
   * OpenCode 的那一份跟着换到当前线路，只换地址，Key、型号和别的设置都不动。四个命令行工具
   * #872 起已经这么换，规矩照那边：用户明确选过线路、地址是这个站登记过的另一条、归属对得上、
   * 客户端没开着，四条都满足才写；开着就先不写，那一行带 routePending。和保存配置排同一个队。
   * 检测时顺带做：开机那一次、「重新检测」、检查页「测试连接」之前那次都会走到。换过以后归属
   * 记在新地址上：客户端要是又把旧的那份写了回来，那份不再算星芒的，不会来回改。
   *
   * 选过线路的人连读配置也排进队：同时有两次检测时，后一次要读到前一次换完的那份，不然
   * 首页会被它旧的结论盖回去。
   */
  // C11：外部客户端开着、换线路要等它退出的，每 5 分钟只看一眼它的进程（runtime.stillRunning，不做整轮盘点），
  // 星芒窗口回到前台时也看一眼（同一个客户端两次至少隔 2 分钟）；退了就整轮检测一次，换线路在那一轮里做，
  // 写之前照旧再盘点一次（followExternalClientRoute 的 recheck）。一直看到换成、线路又变、换账号或星芒退出，
  // 不设次数上限：Claude Desktop 往往整天开着。看不出开没开的（检测失败）退成每 15 分钟整轮检测一次。
  // 跟着工具换 Key 开着等的（#1113）也记在这里，两个站都等，那一行带 keyPending。
  const externalRoutePending = new Map<ExternalToolId, { path: string; checkedAt: number; scannedAt: number }>()
  let cancelExternalRouteRecheck: (() => void) | null = null
  const externalRouteRecheckMs = 5 * 60 * 1000
  const externalRouteFocusGapMs = 2 * 60 * 1000
  const externalRouteFullScanMs = 15 * 60 * 1000

  function noteExternalRoutePending(
    statuses: readonly ExternalClientRuntimeStatus[],
    clients: readonly ExternalClientStatus[],
    keyPending: ReadonlySet<ExternalToolId> = new Set(),
  ): void {
    const now = toolRouteNow()
    for (const client of clients) {
      const clientPath = statuses.find((status) => status.tool === client.tool)?.path ?? null
      if (((client.routePending && client.routeRecheck) || keyPending.has(client.tool)) && clientPath) {
        const known = externalRoutePending.get(client.tool)
        externalRoutePending.set(client.tool, known?.path === clientPath ? known : { path: clientPath, checkedAt: now, scannedAt: now })
      } else {
        externalRoutePending.delete(client.tool)
      }
    }
    if (!externalRoutePending.size) {
      cancelExternalRouteRecheck?.()
      cancelExternalRouteRecheck = null
    } else if (!cancelExternalRouteRecheck) {
      cancelExternalRouteRecheck = scheduleToolRouteTimer(() => {
        cancelExternalRouteRecheck = null
        void recheckExternalRoutes('timer')
      }, externalRouteRecheckMs)
    }
  }

  async function recheckExternalRoutes(trigger: 'timer' | 'focus'): Promise<void> {
    const now = toolRouteNow()
    let rescan = false
    for (const [tool, entry] of [...externalRoutePending]) {
      if (trigger === 'focus' && now - entry.checkedAt < externalRouteFocusGapMs) continue
      entry.checkedAt = now
      const running = await externalClientRuntime.stillRunning?.(tool, entry.path) ?? null
      if (running === false || (running === null && now - entry.scannedAt >= externalRouteFullScanMs)) {
        entry.scannedAt = now
        rescan = true
      }
    }
    if (rescan) {
      const waiting = new Set(externalRoutePending.keys())
      try {
        await scanExternalClients(true)
      } catch (error) {
        runtimeLog?.log('warn', 'config', 'external-client.route.recheck-failed', '外部客户端这次没检测成，稍后再看', { reason: credentialFailureReason(error) })
      }
      // 换成了的那几个界面要重读；没换成的照旧等。
      if ([...waiting].some((tool) => !externalRoutePending.has(tool))) serviceOptions.onToolRouteFollowed?.()
    }
    if (externalRoutePending.size && !cancelExternalRouteRecheck) {
      cancelExternalRouteRecheck = scheduleToolRouteTimer(() => {
        cancelExternalRouteRecheck = null
        void recheckExternalRoutes('timer')
      }, externalRouteRecheckMs)
    }
  }

  function recheckPendingExternalRoutes(): void {
    if (externalRoutePending.size) void recheckExternalRoutes('focus')
  }

  async function followExternalClientRoutes(statuses: readonly ExternalClientRuntimeStatus[]): Promise<ExternalClientStatus[]> {
    const describe = () => Promise.all(statuses.map(describeExternalClient))
    const to = relayRouting.selection(activeRelaySite().id)
    if (to === undefined && !await externalKeyTarget(statuses)) {
      const clients = await describe()
      // 之前开着等换 Key 的，现在不用换了（客户自己重配过、Claude Code 又换了别的）：别再隔 5 分钟看一眼。
      if (externalRoutePending.size) noteExternalRoutePending(statuses, clients)
      return clients
    }
    const work = async () => {
      const clients = await describe()
      const updated = new Map<ExternalToolId, ExternalClientStatus>()
      // 已经在当前线路上的不用再读一遍（Windows 商店版读 Claude Desktop 配置要起一次 PowerShell）；
      // 没装上的看不出开没开，不碰。
      const candidates = to === undefined ? [] : statuses.flatMap((status) => {
        const client = clients.find((entry) => entry.tool === status.tool)
        return client && status.installed && !status.detectionError && client.configurationSource === 'other' ? [{ status, client, to }] : []
      })
      for (const { status, client, to } of candidates) {
        try {
          const next = await followExternalClientRoute(status, client, to)
          if (next) updated.set(status.tool, next)
        } catch (error) {
          runtimeLog?.log('warn', 'config', 'external-client.route.failed', `${externalClientNames[status.tool]} 的连接线路这次没换成，下次检测再试`, {
            tool: status.tool, to, reason: credentialFailureReason(error),
          })
        }
      }
      // 换 Key 放在换线路之后：两样都要换时，这一轮先换地址；旧 Key 在新线路上不认、地址没换成的，Key 照样换，
      // 地址下一轮再换。排队这会儿工具的 Key 可能又换过，所以进了队再看一次。
      const keyPending = new Set<ExternalToolId>()
      const keyTarget = await externalKeyTarget(statuses)
      if (keyTarget) {
        for (const status of statuses) {
          const client = updated.get(status.tool) ?? clients.find((entry) => entry.tool === status.tool)
          if (!client || !status.installed || status.detectionError) continue
          const followed = await followExternalClientKey(status, client, keyTarget)
          if (followed.client) updated.set(status.tool, followed.client)
          if (followed.pending) keyPending.add(status.tool)
        }
      }
      const result = clients.map((client) => updated.get(client.tool) ?? client)
      noteExternalRoutePending(statuses, result, keyPending)
      return result
    }
    const task = externalConfigQueue.then(work, work)
    externalConfigQueue = task.catch(() => undefined)
    return task
  }
  /** 这一轮要不要看外部客户端跟没跟上工具的 Key：一个都没装上、看不出装没装的不看（#1113）。 */
  async function externalKeyTarget(statuses: readonly ExternalClientRuntimeStatus[]): Promise<ManagedKeyFollowTarget | null> {
    return statuses.some((status) => status.installed && !status.detectionError) ? managedKeyFollowTarget() : null
  }
  /**
   * #1113：Claude Desktop 默认借 Claude Code 那把星芒密钥，WorkBuddy、OpenCode 也能选「使用某工具当前的密钥」。
   * 星芒替那个工具换了 Key（撤销后换新、失效重签、换组）以后，客户端要跟上的就是它现在用的那把，连同缓存一起交出。
   * 只交这台电脑上托管 Key 换过、自己也已经换上缓存里那把的工具；一个都没有回 null：没登录、从没换过，或者工具
   * 自己还没换上（写配置没成、客户换成了别的 Key），这时不替客户端做主。主进程内部专用，密钥永不跨 IPC（I3）。
   */
  async function managedKeyFollowTarget(): Promise<ManagedKeyFollowTarget | null> {
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    if (owner === null || !serviceOptions.readCurrentManagedCliKeys) return null
    const cachedKeys = await serviceOptions.readCurrentManagedCliKeys().catch(() => [])
    const keys = cachedKeys.flatMap((entry) => {
      if (isRetiredProviderId(entry.provider) || !entry.replacedKeyDigests?.length) return []
      const tool = inspectNativeProviderConfig(entry.provider)
      return tool.hasApiKey && tool.matchesRelay && tool.apiKey === entry.key ? [{ provider: entry.provider, apiKey: entry.key }] : []
    })
    if (!keys.length || (serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) return null
    return { owner, keys, cachedKeys }
  }
  /**
   * 把客户端那份换成借的那个工具现在的 Key（#1113），只换 Key，地址、型号和别的设置都不动。全都对上才换：
   * 正在用的是星芒替当前账号写的那份、地址是这个站的线路；它那把是缓存记着「被换掉」的某个工具的旧 Key；
   * 不是客户自己填的（保存时记下的来源，0.2.20 以前保存的没记，凭「就是工具换下来的那把」认）；新 Key 认它
   * 用着的型号。客户端开着就先不写，等它退出再换（同换线路 C11），那一行带 keyPending、pending 交回去记着。
   */
  async function followExternalClientKey(
    status: ExternalClientRuntimeStatus,
    client: ExternalClientStatus,
    target: ManagedKeyFollowTarget,
  ): Promise<{ client: ExternalClientStatus | null; pending: boolean }> {
    const { tool } = status
    const name = externalClientNames[tool]
    const activeSite = activeRelaySite()
    const { owner } = target
    const assertContext = () => {
      if (activeRelaySite().id !== activeSite.id || (serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) {
        throw new Error('账号已变化，这次不换密钥')
      }
    }
    const found = await externalClientKeyCredential(status, activeSite, owner)
    // 它那把是哪个工具换下来的，就跟那个工具现在那把。
    const next = found ? target.keys.find((key) => key.apiKey !== found.apiKey && isReplacedManagedKey(key.provider, found.apiKey, target.cachedKeys)) : undefined
    if (!found || !next) return { client: null, pending: false }
    const recorded = (serviceOptions.getExternalClientAccountId?.() ?? null) === owner
      ? externalOwnership.inspect(tool, owner, found.route.baseUrl, found.apiKey) : null
    // 客户自己在客户端里填的那把，哪怕就是工具的旧 Key 也不动。
    if (!recorded || recorded.source === 'manual') return { client: null, pending: false }
    const detail = { tool, route: found.route.endpointId }
    if (status.running) {
      runtimeLog?.log('info', 'config', 'external-client.key.deferred', `${name} 还开着，先不换密钥，退出后再换`, detail)
      return { client: { ...client, keyPending: true }, pending: true }
    }
    const latest = { status }
    try {
      // 新 Key 认它用着的型号才换，不替客户换型号；Claude Desktop 没写型号（由它自动获取）的，新 Key 能用就够了。
      const models = await fetchAvailableModels(next.apiKey, { bypassCache: true, site: activeSite })
      assertContext()
      if (found.model !== null && !models.includes(found.model)) throw new Error(`新密钥不支持 ${name} 现在用的型号`)
      // 同换线路：动文件之前再盘点一次开没开，要的是拉清单之后才开始的那一轮。
      const recheck = async () => {
        latest.status = (await externalClientRuntime.scan({ fresh: true })).find((entry) => entry.tool === tool) ?? { ...status, installed: false }
        if (latest.status.running) throw new Error(`${name} 还开着，已保留原配置`)
        if (!latest.status.installed || latest.status.detectionError) throw new Error(`${name} 这次没认出来开没开，已保留原配置`)
        assertContext()
      }
      await externalOwnership.stageKey(tool, owner, found.route.baseUrl, found.apiKey, next.apiKey)
      await moveExternalClientKey(status, { baseUrl: found.baseUrl, from: found.apiKey, to: next.apiKey }, assertContext, recheck)
      await externalOwnership.rewrite(tool, owner, found.route.baseUrl, next.apiKey)
      runtimeLog?.log('info', 'config', 'external-client.key.followed', `已把 ${name} 换成 ${cliCatalog[next.provider].name} 现在用的密钥`, detail)
      return { client: await describeExternalClient(latest.status), pending: false }
    } catch (error) {
      if (latest.status.running) {
        runtimeLog?.log('info', 'config', 'external-client.key.deferred', `${name} 还开着，先不换密钥，退出后再换`, detail)
        return { client: { ...client, ...latest.status, keyPending: true }, pending: true }
      }
      // 拉不到模型清单、型号不在了、写之前客户刚改过配置都走这里：这次不动，下次检测再看。
      runtimeLog?.log('warn', 'config', 'external-client.key.failed', `${name} 的密钥这次没换成，下次检测再试`, {
        ...detail, reason: credentialFailureReason(error),
      })
      return { client: { ...client, ...latest.status }, pending: false }
    }
  }
  /**
   * 星芒替当前账号写进这个客户端、现在正用着的那一份（#1113）：route 是它在这个站登记的哪条线路，baseUrl 是配置里
   * 原样写着的地址（Claude Desktop 设置窗口存的可能带斜杠），Key 和型号原样交出（Claude Desktop 没写型号时 model
   * 为 null）。归属对不上、不在这个站的线路上回 null。主进程内部专用，密钥永不跨 IPC（I3）。
   */
  async function externalClientKeyCredential(
    status: ExternalClientRuntimeStatus,
    activeSite: RelaySite,
    owner: string,
  ): Promise<{ route: { endpointId: RelayEndpointId; baseUrl: string }; baseUrl: string; apiKey: string; model: string | null } | null> {
    const owned = (baseUrl: string, apiKey: string) => (serviceOptions.getExternalClientAccountId?.() ?? null) === owner
      && externalOwnership.matches(status.tool, owner, baseUrl, apiKey)
    if (status.tool === 'claudeDesktop') {
      // 一次读出地址再比：Windows 上每读一次都要起 PowerShell 查管理策略。
      const gateway = await claudeDesktopConfig(status).then((service) => service.inspectOwnedRoute()).catch(() => null)
      const route = gateway ? relaySiteProviderBaseUrlVariants(activeSite.id, 'claude').find((variant) => sameRouteUrl(gateway.baseUrl, variant.baseUrl)) : undefined
      return gateway && route && owned(route.baseUrl, gateway.apiKey) ? { route, ...gateway } : null
    }
    for (const route of relaySiteProviderBaseUrlVariants(activeSite.id, 'codex')) {
      const credential = await externalClientProbeCredential(status, route.baseUrl, (apiKey) => owned(route.baseUrl, apiKey))
      if (credential) return { route, baseUrl: route.baseUrl, ...credential }
    }
    return null
  }
  /** 只改 Key 的那一笔写，recheck 的位置同 moveExternalClientRoute。 */
  async function moveExternalClientKey(
    status: ExternalClientRuntimeStatus,
    change: { baseUrl: string; from: string; to: string },
    assertContext: () => void,
    recheck: () => Promise<void>,
  ): Promise<void> {
    if (status.tool === 'claudeDesktop') {
      await (await claudeDesktopConfig(status, assertContext)).followKey(change.baseUrl, change.from, change.to, recheck)
      return
    }
    const xdgConfig = providerRoots.userHome === os.homedir() ? process.env.XDG_CONFIG_HOME : undefined
    if (xdgConfig && !path.isAbsolute(xdgConfig)) throw new Error('XDG_CONFIG_HOME 必须是绝对路径')
    await recheck()
    await followExternalToolKey(status.tool, platform === 'win32' || platform === 'darwin' ? platform : 'linux', {
      userHome: providerRoots.userHome, configHome: xdgConfig || path.join(providerRoots.userHome, '.config'),
    }, change, { beforeReplace: assertContext })
  }
  /** followExternalClientRoutes 里的一个客户端：那一行要换成什么就回什么，不用动时回 null。 */
  async function followExternalClientRoute(
    status: ExternalClientRuntimeStatus,
    client: ExternalClientStatus,
    to: RelayEndpointId,
  ): Promise<ExternalClientStatus | null> {
    const { tool } = status
    const name = externalClientNames[tool]
    const activeSite = activeRelaySite()
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    if (owner === null) return null
    const followedKey = JSON.stringify([tool, owner])
    const baseUrl = tool === 'claudeDesktop' ? activeSite.providerBaseUrls.claude : activeSite.providerBaseUrls.codex
    const assertContext = () => {
      if (activeRelaySite().id !== activeSite.id || (serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) {
        throw new Error('账号已变化，这次不换线路')
      }
    }
    const found = await externalClientRouteCredential(status, activeSite, owner)
    if (!found) {
      // 换过的又回到原来那份：归属已经记在新地址上，不会再换，只在日志里说一次。
      const followed = externalRoutesFollowed.get(followedKey)
      if (!followed) return null
      externalRoutesFollowed.delete(followedKey)
      if (await externalClientProbeCredential(status, followed.baseUrl, (apiKey) => apiKey === followed.apiKey)) {
        runtimeLog?.log('warn', 'config', 'external-client.route.reverted', `${name} 换过连接线路后又回到了原来那条，不再替它换`, { tool, from: followed.from, to })
      }
      return null
    }
    const detail = { tool, from: found.from, to }
    if (found.baseUrl === baseUrl) {
      // 地址已经在当前线路上，归属还记在原来那条：上回换完没记上（记归属那一步失败，或者星芒
      // 正好在两步之间退出）。客户端那份不用再动，补记归属就行。
      assertContext()
      await externalOwnership.rewrite(tool, owner, baseUrl, found.apiKey)
      runtimeLog?.log('info', 'config', 'external-client.route.recorded', `${name} 已在当前连接线路上，补记归属`, detail)
      return await describeExternalClient(status)
    }
    if (status.running) {
      runtimeLog?.log('info', 'config', 'external-client.route.deferred', `${name} 还开着，连接线路暂未改动`, detail)
      return { ...client, routePending: true, ...(activeSite.id === 'solov' ? { routeRecheck: true } : {}) }
    }
    const latest = { status, moved: false }
    try {
      // 新线路上认这把 Key、型号也还在才换，不替客户换型号（同 #872）；Claude Desktop 没写型号
      // （由它自动获取）的那份，新线路认这把 Key 就够了。
      const models = await fetchAvailableModels(found.apiKey, { bypassCache: true, site: activeSite })
      assertContext()
      if (found.model !== null && !models.includes(found.model)) throw new Error('当前密钥不支持所选模型，请重新检测')
      // 动文件之前再盘点一次客户端开没开，放在写之前最后一步异步里（同 #872）。要的是这之后才
      // 开始的那一轮：客户端可能是在拉清单那几秒里打开的，而那时正在跑的盘点可能比它早。
      const recheck = async () => {
        latest.status = (await externalClientRuntime.scan({ fresh: true })).find((entry) => entry.tool === tool) ?? { ...status, installed: false }
        if (latest.status.running) throw new Error(`${name} 还开着，已保留原配置`)
        if (!latest.status.installed || latest.status.detectionError) throw new Error(`${name} 这次没认出来开没开，已保留原配置`)
        assertContext()
      }
      await moveExternalClientRoute(status, { from: found.baseUrl, to: baseUrl, apiKey: found.apiKey }, assertContext, recheck)
      latest.moved = true
      externalRoutesFollowed.set(followedKey, { from: found.from, baseUrl: found.baseUrl, apiKey: found.apiKey })
      await externalOwnership.rewrite(tool, owner, baseUrl, found.apiKey)
      runtimeLog?.log('info', 'config', 'external-client.route.followed', `已把 ${name} 换到当前连接线路`, detail)
      return await describeExternalClient(latest.status)
    } catch (error) {
      if (latest.status.running) {
        runtimeLog?.log('info', 'config', 'external-client.route.deferred', `${name} 还开着，连接线路暂未改动`, detail)
        return { ...client, ...latest.status, routePending: true }
      }
      // 拉不到模型清单、型号不在了、写之前客户刚改过配置也走这里：这次不动，下次检测再试。
      // 地址已经换好、只是归属没记上的，下次检测补记（上面 recorded 那一支）。
      runtimeLog?.log('warn', 'config', 'external-client.route.failed', latest.moved
        ? `${name} 已换到当前连接线路，归属没记上，下次检测补记` : `${name} 的连接线路这次没换成，下次检测再试`,
      { ...detail, reason: credentialFailureReason(error) })
      return { ...client, ...latest.status }
    }
  }
  /**
   * 星芒替当前账号写的那一份在这个站的哪条线路上：from 是归属记在哪条线路，baseUrl 是那份配置
   * 现在指着的地址，Key 和型号原样交出（Claude Desktop 没写型号时 model 为 null）。baseUrl 是另一条
   * 线路的，跟着换；已经是当前线路的（上回地址换好了、归属没记上），补记归属。归属对不上、不是
   * 这个站登记过的线路，回 null。别名也认：直连原来的地址是 IP 测试入口，那时存的那份归属记在
   * IP 上，现在 IP 退成别名、要关掉，得跟着换到域名。主进程内部专用，密钥永不跨 IPC（I3）。
   */
  async function externalClientRouteCredential(
    status: ExternalClientRuntimeStatus,
    activeSite: RelaySite,
    owner: string,
  ): Promise<{ from: RelayEndpointId; baseUrl: string; apiKey: string; model: string | null } | null> {
    const provider = status.tool === 'claudeDesktop' ? 'claude' : 'codex'
    const current = activeSite.providerBaseUrls[provider]
    const routes = relaySiteProviderBaseUrlVariants(activeSite.id, provider)
      .map((variant) => ({ from: variant.endpointId, baseUrl: variant.baseUrl }))
      .filter((route) => route.baseUrl !== current)
    const unchanged = () => serviceOptions.getExternalClientAccountId?.() === owner && activeRelaySite().id === activeSite.id
    const ownedRoute = (apiKey: string) => unchanged() ? routes.find((route) => externalOwnership.matches(status.tool, owner, route.baseUrl, apiKey)) : undefined
    if (status.tool === 'claudeDesktop') {
      // 一次读出地址再比：Windows 上每读一次都要起 PowerShell 查管理策略。
      const gateway = await claudeDesktopConfig(status).then((service) => service.inspectOwnedRoute()).catch(() => null)
      const route = gateway ? ownedRoute(gateway.apiKey) : undefined
      if (!gateway || !route) return null
      const at = sameRouteUrl(gateway.baseUrl, current) ? current : sameRouteUrl(gateway.baseUrl, route.baseUrl) ? route.baseUrl : null
      return at ? { ...gateway, from: route.from, baseUrl: at } : null
    }
    for (const route of routes) {
      const credential = await externalClientProbeCredential(status, route.baseUrl, (apiKey) => ownedRoute(apiKey) === route)
      if (credential) return { ...credential, from: route.from, baseUrl: route.baseUrl }
    }
    const credential = await externalClientProbeCredential(status, current, (apiKey) => ownedRoute(apiKey) !== undefined)
    const route = credential ? ownedRoute(credential.apiKey) : undefined
    return credential && route ? { ...credential, from: route.from, baseUrl: current } : null
  }
  /**
   * 只改地址的那一笔写：Claude Desktop 改网关地址，WorkBuddy、OpenCode 改星芒那几条的地址。
   * recheck 是写之前最后看一眼客户端开没开，放在最后一步异步之后：Claude Desktop 那边商店版目录、
   * 管理策略都要起 PowerShell，所以交给 followRoute 在那之后调。
   */
  async function moveExternalClientRoute(
    status: ExternalClientRuntimeStatus,
    route: { from: string; to: string; apiKey: string },
    assertContext: () => void,
    recheck: () => Promise<void>,
  ): Promise<void> {
    if (status.tool === 'claudeDesktop') {
      await (await claudeDesktopConfig(status, assertContext)).followRoute(route.from, route.to, route.apiKey, recheck)
      return
    }
    const xdgConfig = providerRoots.userHome === os.homedir() ? process.env.XDG_CONFIG_HOME : undefined
    if (xdgConfig && !path.isAbsolute(xdgConfig)) throw new Error('XDG_CONFIG_HOME 必须是绝对路径')
    await recheck()
    await followExternalToolRoute(status.tool, platform === 'win32' || platform === 'darwin' ? platform : 'linux', {
      userHome: providerRoots.userHome, configHome: xdgConfig || path.join(providerRoots.userHome, '.config'),
    }, route, { beforeReplace: assertContext })
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

  // 注册表里整台电脑 + 当前账号的 PATH，最近读到的那一份；读不到时是 null，只看星芒启动时的快照。
  let windowsLivePath: string | null = null
  let windowsLivePathRead: Promise<void> | null = null
  let windowsLivePathReadAt = 0

  /**
   * 星芒开着的时候客户装了 PowerShell 7，启动时的快照里没有它，新开的终端里却有（windows-live-path.ts）。
   * 异步起 reg.exe，同一时刻只读一次，几秒内读过的不再读（修一次钩子会先后问两遍）；读不到就留着上一次的。
   */
  function refreshWindowsLivePath(): Promise<void> {
    if (platform !== 'win32' || Date.now() - windowsLivePathReadAt < 5_000) return Promise.resolve()
    windowsLivePathRead ??= (async () => {
      try {
        const system32 = resolveWindowsMachinePathsForService().system32
        const value = await (serviceOptions.readWindowsLivePath ?? readWindowsLivePath)(system32, process.env)
        if (value) windowsLivePath = value
      } catch {
        // 读不到只是少看见新装的那几段，照旧用快照推。
      } finally {
        windowsLivePathReadAt = Date.now()
        windowsLivePathRead = null
      }
    })()
    return windowsLivePathRead
  }

  /**
   * Windows 版 Grok 现在会拿哪个 shell 跑钩子。PATH 用启动时快照再补上注册表里新加的那几段：
   * 客户新开的终端看得到的，这里也要看得到；从星芒打开 Grok 时也补上同样几段（launchProviderOperation），
   * 两边推出来的是同一个 shell。Git Bash 那三处本来就是实时看文件在不在。
   */
  function expectedGrokWindowsShell(): GrokWindowsShell {
    return resolveGrokWindowsShell(withAppendedWindowsPath(process.env, windowsLivePath), (candidate) => fs.existsSync(candidate))
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

  // 读不出来（比如路径里冒出了联接）就当动过：宁可留着「手动」保护，也不能让读配置的错误顶掉保存本来的错误。
  function untouchedSince(provider: ProviderId, before: NativeConfigInspection): boolean {
    try {
      return sameNativeConfigSnapshot(before, inspectNativeProviderConfig(provider))
    } catch {
      return false
    }
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

  // ---- 换线路时定点改写工具配置（xm 三线路 C9、C10、C11、C19） ----
  //
  // 只管星芒账号（solov）；历史账号照旧由渲染层 followRelayRoute 走整份写入，一行不改（重开提示见 noteRouteFollowRestart）。地址取的是
  // relayRouting 这次运行生效的线路（开机定下的偏好，设置里改了没重启的不算），所以「改了设置没重启」
  // 那段时间工具配置照样跟着当前生效的线路走（(f)）。和整份写入排同一个 serializeConfigWrite 队。
  const toolRouteNow = serviceOptions.toolRouteNow ?? Date.now
  function scheduleToolRouteTimer(callback: () => void, delayMs: number): () => void {
    if (serviceOptions.scheduleToolRoute) return serviceOptions.scheduleToolRoute(callback, delayMs)
    const timer = setTimeout(callback, delayMs)
    timer.unref?.()
    return () => clearTimeout(timer)
  }
  let toolRouteAccount: ToolRouteAccountHooks | null = null
  // 这次运行从星芒打开过的工具（C19：从星芒打开的 Gemini 窗口按「开着」算）。
  const toolLaunchedAt = new Map<ProviderId, number>()
  // 改了以后要重开才生效、这回没弹提示的（24 小时内弹过、或客户关了提示），首页标「需重开生效」。
  const toolRouteRestartPending = new Set<ProviderId>()
  let toolRouteRestartHint: ToolRouteRestartHint | null = null
  // 暂时性失败已经连着失败了几次；换线或重启从头算。
  const toolRouteFailures = new Map<ProviderId, number>()
  let cancelToolRouteRetry: (() => void) | null = null
  let cancelToolRouteVerify: (() => void) | null = null
  // 提示只在出来以后半小时内给界面：窗口晚开、重载时还能看到，过了就是旧事。
  const toolRouteHintTtlMs = 30 * 60 * 1000
  // 改完一分钟回头看一眼有没有被别的程序改回去（cc-switch 这类会在几秒内改回）。
  const toolRouteVerifyDelayMs = 60 * 1000

  function toolRouteRewriteMode(): 'targeted' | 'merge' {
    return serviceOptions.getToolRouteRewriteMode?.() === 'merge' ? 'merge' : 'targeted'
  }

  async function writeToolRouteRecord(provider: ProviderId, update: (record: ToolRouteFollowRecord) => ToolRouteFollowRecord): Promise<void> {
    try {
      const state = toolRouteFollow.read()
      state.providers[provider] = update(state.providers[provider] ?? {})
      await toolRouteFollow.write(state)
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'route.record-failed', '换线路的跟随记录没能写下，不影响工具使用', { provider, reason: credentialFailureReason(error) })
    }
  }

  type ToolRouteOutcome = 'rewritten' | 'on-target' | 'skipped' | 'retry'

  /** 一个工具。已经在 serializeConfigWrite 里。 */
  async function followProviderToolRoute(provider: ProviderId, owner: string, request: ToolRouteFollowRequest, attempt: number): Promise<ToolRouteOutcome> {
    if ((serviceOptions.getExternalClientAccountId?.() ?? null) !== owner) return 'skipped'
    if (store.read().officialProviders?.includes(provider)) return 'skipped'
    const site = activeRelaySite()
    if (site.id !== 'solov') return 'skipped'
    const before = inspectNativeProviderConfig(provider)
    const record = toolRouteFollow.read().providers[provider] ?? {}
    if (record.managedElsewhere) return 'skipped'
    const ownership = configOwnership.read(provider, before, owner)
    // 上回改完又变回改之前那一份（那一份当时确认是当前账号的）：多半是别的配置管理器在替客户维护它。
    const reverted = ownership === 'changed' && record.revertIdentity === toolConfigIdentity(before)
    // 来源不是当前账号（手填、被改过、看不出来）不自动改，重试多少次也一样，不排重试。
    if (!reverted && ownership !== 'account') return 'skipped'
    const templateRevision = configOwnership.templateRevision(provider, before)
    const target = site.providerBaseUrls[provider]
    let plan: ReturnType<typeof planProviderRouteFollow>
    try {
      plan = planProviderRouteFollow(provider, site.id, target, providerRoots)
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'route.follow-failed', '工具配置这次没读成，稍后再换线路', { provider, kind: 'tool', reason: credentialFailureReason(error), attempt })
      return 'retry'
    }
    if (plan.status === 'unlocated') {
      runtimeLog?.log('info', 'config', 'route.unlocated', '工具配置里找不到要改的那一处地址，这次不改', { provider })
    }
    if (reverted && plan.status === 'on-target') {
      // 改回去的那份正好就在现在的线路上（线路也切回来了）：不算拉锯，把来源记回当前账号。
      await configOwnership.write(provider, before, 'account', owner, templateRevision ?? undefined)
      return 'on-target'
    }
    if (plan.status !== 'rewrite') return plan.status === 'on-target' ? 'on-target' : 'skipped'
    if (reverted) {
      // 再改一次；24 小时内第二次就停手，首页标「由其他工具管理」。
      const next = recordToolRouteRevert(record, toolRouteNow())
      await writeToolRouteRecord(provider, () => next)
      if (next.managedElsewhere) {
        runtimeLog?.log('warn', 'config', 'route.managed-elsewhere', '工具配置被别的软件改回过两次，不再自动换线路', { provider })
        return 'skipped'
      }
      runtimeLog?.log('warn', 'config', 'route.reverted', '工具配置换完线路又被改了回去，再换一次', { provider })
    }
    // 迁移前原件：第一次定点改写之前整套备份一次，「设置 › 备份迁移」里能找回。备份不成照旧换线路（连不上
    // 的线路比少一份备份要紧），下回再补。
    let originalKept = record.originalKept === true
    if (!originalKept && toolRouteAccount) {
      try {
        await toolRouteAccount.backup(provider)
        originalKept = true
      } catch (error) {
        runtimeLog?.log('warn', 'config', 'route.original-backup-failed', '换线路前的原件没能备份，下次再补', { provider, reason: credentialFailureReason(error) })
      }
    }
    // 同 saveConfig：写之前先记成「手动」，写到一半崩掉宁可多挡一次自动写入。模板版本号原样带回去，
    // 不然下次开机会当成模板落后，再整套备份、补一遍缺省项、弹一句「已补齐」。
    const restoreOwnership = configOwnership.remember(provider, before)
    async function putOwnershipBack(): Promise<void> {
      if (!restoreOwnership) return
      await restoreOwnership().catch((error: unknown) => {
        runtimeLog?.log('warn', 'config', 'ownership.restore-failed', '换线路没成功，工具配置的来源记录也没能原样放回', { provider, reason: credentialFailureReason(error) })
      })
    }
    await configOwnership.write(provider, before, 'manual', owner)
    const from = relaySiteEndpointIdForBaseUrl(site.id, provider, plan.from)
    const to = relaySiteEndpointIdForBaseUrl(site.id, provider, target)
    const detail = { provider, kind: 'tool', from, to, reason: request.reason, ...(request.fault ? { fault: true } : {}), mode: 'targeted', attempt }
    try {
      applyProviderRouteFollow(provider, plan, providerRoots)
    } catch (error) {
      if (untouchedSince(provider, before)) await putOwnershipBack()
      runtimeLog?.log('warn', 'config', 'route.follow-failed', '工具配置这次没换成线路，稍后再试', { ...detail, reason: credentialFailureReason(error) })
      return 'retry'
    }
    const after = inspectNativeProviderConfig(provider)
    if (!relayProviderBaseUrlEquals(after.actualBaseUrl, target)) {
      await putOwnershipBack()
      runtimeLog?.log('warn', 'config', 'route.followed', '工具配置写了，回读出来的地址不对，稍后再试', { ...detail, readback: false })
      return 'retry'
    }
    await configOwnership.write(provider, after, 'account', owner, templateRevision ?? undefined)
    await writeToolRouteRecord(provider, (current) => ({
      ...current, revertIdentity: toolConfigIdentity(before), ...(originalKept ? { originalKept: true } : {}),
    }))
    // 客服从日志看得出工具配置是什么时候、从哪条线路换到哪条的：只记线路 id，不记地址。
    runtimeLog?.log('info', 'config', 'route.followed', '工具配置已换到当前连接线路', { ...detail, readback: true })
    return 'rewritten'
  }

  async function followSkillToolRoute(): Promise<void> {
    const site = activeRelaySite()
    if (site.id !== 'solov' || !toolRouteAccount) return
    try {
      const rewritten = await followXingmangAiSkillRoute({
        userHome: providerRoots.userHome,
        siteId: site.id,
        baseUrl: new URL(site.providerBaseUrls.claude).origin,
        ownedKeyIds: await toolRouteAccount.ownedKeyIds(),
      })
      if (rewritten) runtimeLog?.log('info', 'config', 'route.followed', '星芒画图的连接地址已换到当前线路', { provider: 'skill', kind: 'tool', count: rewritten, mode: 'targeted' })
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'route.follow-failed', '星芒画图的连接地址这次没换成', { provider: 'skill', kind: 'tool', reason: credentialFailureReason(error) })
    }
  }

  function scheduleToolRouteRetry(providers: readonly ProviderId[]): void {
    const due = providers.filter((provider) => {
      const failures = (toolRouteFailures.get(provider) ?? 0) + 1
      toolRouteFailures.set(provider, failures)
      if (toolRouteRetryAllowed(failures)) return true
      runtimeLog?.log('warn', 'config', 'route.retry-exhausted', '工具配置换线路连着失败了 12 次，等下次换线或重启再试', { provider })
      return false
    })
    if (!due.length || cancelToolRouteRetry) return
    cancelToolRouteRetry = scheduleToolRouteTimer(() => {
      cancelToolRouteRetry = null
      void followToolRoutes({ reason: 'retry', providers: [...toolRouteFailures.keys()] })
    }, toolRouteRetryDelayMs)
  }

  /**
   * 因为连不上换的线路，开着的工具要重开才走新线路（C10）。同一个工具 24 小时最多弹一次，之后、或者
   * 客户关了提示，只在首页标「需重开生效」。Claude Code 每次请求都重读配置，不提。
   */
  async function noteToolRouteRestart(rewritten: readonly ProviderId[]): Promise<boolean> {
    const candidates = rewritten.filter((provider) => provider !== 'claude')
    if (!candidates.length) return false
    let report: RunningToolsReport
    try {
      report = await (serviceOptions.inspectRunningToolsForRouteHint ?? inspectRunningTools)(candidates)
    } catch {
      report = { ...emptyRunningToolsReport, unknown: [...candidates], codexDesktopRunning: candidates.includes('codex') ? null : false }
    }
    const needs = toolRouteRestartNeeds(candidates, report, { geminiLaunched: toolLaunchedAt.has('gemini'), platform })
    const tools = (['codex', 'gemini', 'grok'] as const).filter((provider) => needs[provider] !== undefined)
    if (!tools.length) return false
    const now = toolRouteNow()
    const enabled = store.read().toolRouteRestartHints !== false
    const records = toolRouteFollow.read().providers
    const hinted = tools.filter((provider) => enabled && toolRouteHintDue(records[provider], now))
    for (const provider of tools) if (!hinted.includes(provider)) toolRouteRestartPending.add(provider)
    if (!hinted.length) return true
    const hint: ToolRouteRestartHint = { id: now }
    if (hinted.includes('codex')) hint.codex = needs.codex
    if (hinted.includes('gemini')) hint.gemini = needs.gemini
    if (hinted.includes('grok')) hint.grok = needs.grok
    toolRouteRestartHint = hint
    for (const provider of hinted) await writeToolRouteRecord(provider, (current) => ({ ...current, hintAt: now }))
    runtimeLog?.log('info', 'config', 'route.restart-hint', '连接线路因为连不上换了，提示客户重开工具', { providers: hinted, tagged: tools.filter((provider) => !hinted.includes(provider)) })
    return true
  }

  // 历史账号的工具配置跟应用线路走，换了以后由界面整份写入跟过去（saveConfig 的 followedRoute），不走上面的
  // 定点改写，以前因此一直不提示重开（#1061 第 2 条）。这一轮写完（noteRouteFollowRestart）再一次说完，只说这一轮
  // 自己写的那几家：同时跑着的另一轮（客户自己点的换来源、换账号）不会把它们提前说掉。记着是哪个账号写的：账号
  // 中途换了，那一轮整轮作废、走不到说完那一步，留下的不带到下一个账号那一轮。
  const accountRouteFollowed = new Map<ProviderId, string | null>()

  /**
   * 整份写入跟过去的这条线路，是不是半小时内「自动」因为连不上换过来的那条。按换线时刻算、不按这次运行：上次
   * 运行刚换完线就退出、这次开机才跟过去的也算；更早的、写死线路的、切回先走那条的不算。
   */
  function accountRouteFaultFollowed(siteId: string, line: RelayEndpointId): boolean {
    // 星芒账号由 followToolRoutes 自己提示（R6 切回整份写入时它的工具线路也不在应用线路这里）。
    if (siteId !== 'solov-api') return false
    const change = serviceOptions.relayRouteLastChange?.(siteId)
    if (!change || change.to !== line || (change.reason !== 'health-failed' && change.reason !== 'line-down')) return false
    const age = toolRouteNow() - change.at
    return age >= 0 && age < toolRouteHintTtlMs
  }

  async function noteRouteFollowRestart(written: readonly ProviderId[]): Promise<void> {
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    const followed = written.filter((provider) => accountRouteFollowed.has(provider) && accountRouteFollowed.get(provider) === owner)
    for (const provider of written) accountRouteFollowed.delete(provider)
    if (!followed.length) return
    // 配置已经写好了：提示没出成只进日志，不能把这一轮写入算成失败。
    try {
      if (await noteToolRouteRestart(followed)) serviceOptions.onToolRouteFollowed?.()
    } catch (error) {
      runtimeLog?.log('warn', 'config', 'route.restart-hint-failed', '换线路的重开提示这次没出成，不影响工具使用', { providers: followed, reason: credentialFailureReason(error) })
    }
  }

  async function followToolRoutes(request: ToolRouteFollowRequest): Promise<ToolRouteFollowReport> {
    if (activeRelaySite().id !== 'solov' || toolRouteRewriteMode() === 'merge') return { rewritten: [] }
    const owner = serviceOptions.getExternalClientAccountId?.() ?? null
    if (!owner) return { rewritten: [] }
    if (request.reason === 'route-changed' || request.reason === 'startup') {
      toolRouteFailures.clear()
      cancelToolRouteRetry?.()
      cancelToolRouteRetry = null
    }
    const rewritten: ProviderId[] = []
    const failed: ProviderId[] = []
    for (const provider of request.providers ?? activeProviderIds) {
      const attempt = request.reason === 'retry' ? toolRouteFailures.get(provider) ?? 0 : 0
      let outcome: ToolRouteOutcome
      try {
        outcome = await serializeConfigWrite(() => followProviderToolRoute(provider, owner, request, attempt))
      } catch (error) {
        runtimeLog?.log('warn', 'config', 'route.follow-failed', '工具配置这次没换成线路，稍后再试', { provider, kind: 'tool', reason: credentialFailureReason(error), attempt })
        outcome = 'retry'
      }
      if (outcome === 'retry') failed.push(provider)
      else toolRouteFailures.delete(provider)
      if (outcome === 'rewritten') {
        rewritten.push(provider)
        // 这回又改了一次，之前那句「需重开生效」说的是上一条线路：因故障换的下面再按这次的标。
        toolRouteRestartPending.delete(provider)
      }
    }
    await followSkillToolRoute()
    if (failed.length) scheduleToolRouteRetry(failed)
    const hinted = request.fault === true && rewritten.length > 0 && await noteToolRouteRestart(rewritten)
    if (rewritten.length) {
      cancelToolRouteVerify?.()
      const verify = [...rewritten]
      cancelToolRouteVerify = scheduleToolRouteTimer(() => {
        cancelToolRouteVerify = null
        void followToolRoutes({ reason: 'verify', providers: verify })
      }, toolRouteVerifyDelayMs)
    }
    if (rewritten.length || hinted) serviceOptions.onToolRouteFollowed?.()
    return { rewritten }
  }

  function toolRouteSummaryFields(provider: ProviderId, current: NativeConfigInspection, records: ReturnType<typeof toolRouteFollow.read>['providers']): Pick<NativeConfigSummary, 'relayLine' | 'relayRouteState'> {
    const site = activeRelaySite()
    if (site.id !== 'solov' || !current.actualBaseUrl || !current.matchesRelay) return {}
    if (store.read().officialProviders?.includes(provider)) return {}
    const relayLine = relaySiteExactEndpointIdForBaseUrl(site.id, provider, current.actualBaseUrl)
    const state = records[provider]?.managedElsewhere ? 'managed-elsewhere' as const
      : toolRouteRestartPending.has(provider) ? 'restart' as const : undefined
    return { relayLine, ...(state ? { relayRouteState: state } : {}) }
  }

  // relayRouteLines 一直是管理工具自己那条（应用线路）；接了工具线路时另给星芒账号写进工具配置的那条和它的状态。
  function routeLineSnapshotFields(): Pick<AppSettings, 'relayRouteLines' | 'relayToolRouteLines' | 'relayToolRouteStatus'> {
    const tool = serviceOptions.relayToolRouting
    if (!tool) return { relayRouteLines: relayRouting.lines() }
    const status = tool.status()
    return {
      relayRouteLines: tool.applicationLines(),
      relayToolRouteLines: { solov: relayRouting.lines().solov },
      ...(status ? { relayToolRouteStatus: status } : {}),
    }
  }

  function toolRouteSnapshotFields(): { toolRouteRestartHint?: ToolRouteRestartHint; toolRouteRewrite?: 'merge' } {
    const hint = currentToolRouteRestartHint()
    return { ...(hint ? { toolRouteRestartHint: hint } : {}), ...(toolRouteRewriteMode() === 'merge' ? { toolRouteRewrite: 'merge' as const } : {}) }
  }

  function disposeToolRoutes(): void {
    cancelToolRouteRetry?.()
    cancelToolRouteRetry = null
    cancelToolRouteVerify?.()
    cancelToolRouteVerify = null
    cancelExternalRouteRecheck?.()
    cancelExternalRouteRecheck = null
  }

  /** 设置快照里给界面的那条重开提示；过了半小时不再给。 */
  function currentToolRouteRestartHint(): ToolRouteRestartHint | undefined {
    if (!toolRouteRestartHint) return undefined
    const age = toolRouteNow() - toolRouteRestartHint.id
    return age >= 0 && age < toolRouteHintTtlMs ? toolRouteRestartHint : undefined
  }

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

  function credentialFailureReason(error: unknown): string {
    return redactHomeDirectory(error instanceof Error ? error.message : String(error), providerRoots.userHome)
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
    bindToolRouteAccount: (hooks) => { toolRouteAccount = hooks },
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
