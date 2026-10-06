import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { isIP } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { type AppSettings, type AppSettingsUpdate, AppSettingsStore, type MirrorPolicy } from './app-settings'
import type { RuntimeLogLike } from './account-session-store'
import type { InstallProgressStage, NodeRuntimeInstallRequest } from './ipc-contract'
import { redactHomeDirectory } from './startup-log'
import {
  bypassClosedLoopbackProxies,
  describeDroppedProxies,
  probeLoopbackProxy,
  type LoopbackProbe,
} from './stale-proxy-environment'
import { cliCatalog, providerIds, type ProviderId } from './catalog'
import {
  buildCliVersionAdvice,
  resolveCliInstallVersion,
  type CliVersionAdvice,
} from './cli-verified-versions'
import { buildCliUpdateRecord, CliUpdateHistoryStore, resolveCliRevertVersion } from './cli-update-history'
import {
  defaultProviderConfigRoots,
  type ProviderConfigRoots,
} from './codex-home'
import {
  CommandRunnerError,
  cleanCommandOutput,
  commandEnvironment,
  findExecutable,
  isTrustedHighIntegrityExecutable,
  primeTrustedHighIntegrityExecutable,
  isUserWritablePath,
  redactCommandText,
  runCommand,
  trustedCommandEnvironment,
  windowsSystemExecutable,
  type WindowsPackageManager,
} from './command-runner'
import {
  cliPackageDirectory as cliPackageDirectoryFromNpmRoot,
  describeOccupiedUpdateFailure,
  describeRunningCliProcessWarning,
  fileLockErrorCode,
  managedCliPackageDirectory,
  type OccupiedUpdateFailureInput,
  probeRunningCliProcesses,
} from './cli-process-probe'
import { cliProcessProbeRoots, inspectRunningTools as inspectRunningToolsWith, type RunningToolsReport } from './running-tools'
import { createToolModelChecker, type ToolModelCheck, type ToolModelCheckTarget } from './tool-model-check'
import {
  npmPrefixGlobalRoot,
  resolveSameUserNpmPrefix,
} from './npm-user-prefix'
import { buildClaudeStatusLineCommand } from './claude-status-line'
import { buildCliHookInvocation, cliHookEventsDirectory, cliHookTargetsStale, grokCliHookCommand, grokCliHookShellChanged, resolveGrokWindowsShell, type CliHookInvocation, type GrokWindowsShell } from './cli-hooks'
import { readWindowsLivePath, withAppendedWindowsPath } from './windows-live-path'
import { isCodexDesktopExecutable } from './codex-desktop'
import { activateCodexDesktopWithCdp, withCodexDesktopCdpFailureReport } from './codex-desktop-cdp'
import {
  createCodexDesktopService,
  desktopUpdateFields,
  inspectCodexDesktopPackage,
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
  geminiCliCompatibleModel,
  ensureCodexPermissionDefaults,
  ensureGeminiProjectContextFiles,
  inspectCodexWorkspacePermissions,
  inspectOfficialLogin,
  claudeModelPickerNeedsRefresh,
  codexModelCatalogNeedsRefresh,
  codexModelCatalogTargetUsable,
  inspectCodexModelCatalogOnDisk,
  takeBackCodexModelCatalog,
  inspectManagedCliHookTargets,
  inspectProviderConfig,
  managedProviderLaunchBlockedMessage,
  moveClaudeConsoleKeyAside,
  readCodexAuthTokens,
  restoreClaudeConsoleKey,
  rewriteManagedCliHooks,
  saveProviderConfig,
  fillRelayTemplateDefaults,
  forgetStaleGeminiUsageStatisticsRecord,
  relayTemplateDefaultsPending,
  relayTemplateRevision,
  switchProviderToOfficialAccount,
  trustCodexWorkspace,
  trustManagedWorkspace,
  toNativeConfigSummary,
  type CodexWorkspacePermissionStatus,
  type CodexWorkspacePermissionWriteResult,
  type NativeConfigInspection,
  type NativeConfigSaveMode,
  type NativeConfigSummary,
} from './config-files'
import {
  ProjectInstructionsStateStore,
  ensureProjectInstructions,
  readProjectInstructionsTemplate,
} from './project-instructions'
import { classifyWorkspace, resolveRememberedWorkspace, sensitiveWorkspaceLabel } from './workspace-guard'
import {
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
  findNpmExecutable,
  resolveCliCommand,
  resolveCliInstallation,
  resolveNpmGlobalRoot,
  type CliInstallation,
  type CliInstallDisplaySource,
  type CliLaunchMode,
  type CliUninstallCapability,
} from './tool-installation'
export type { CliLaunchMode } from './tool-installation'
import { isExactCliVersion, isNewerVersion, nodeVersionStatus, type NodeVersionStatus } from './versions'
import { nodeReadsSystemCertificates, toolCertificateFailureKind, withSystemCertificateTrust } from './system-certificate-trust'
import {
  inspectWindowsRestartRequired,
  installNodeRuntime as installNodeRuntimeLts,
  type NodeRuntimeInstallResult,
  type WindowsRestartStatus,
} from './node-runtime'
import { installDarwinNodeRuntime, resolveDarwinPreferredNodeDirectory } from './macos-node-runtime'
import { installLinuxNodeRuntime } from './linux-node-runtime'
import {
  inspectInstalledPythonRuntime,
  installPythonRuntime as installPythonRuntime312,
  isPython312RuntimeVersion,
  type PythonRuntimeInstallResult,
} from './python-runtime'
import {
  installGitRuntime as installGitForWindows,
  type GitRuntimeInstallProgress,
  type GitRuntimeInstallResult,
} from './git-runtime-install'
import { InstallationQueue, type InstallationQueueSnapshot } from './installation-queue'
import type { DownloadAccelerationLease } from './download-acceleration'
import {
  InstallCancellationRegistry,
  InstallCancelledError,
  isInstallCancelledError,
  type InstallCancellationHandle,
  type InstallCancellationOutcome,
} from './install-cancellation'
import { inspectCcSwitchInstalled, resolveCcSwitchLeftover, type CcSwitchLeftover } from './cc-switch-leftover'
import { ToolConfigOwnershipStore, toolConfigIdentity, type ToolConfigOwnership, type ToolTemplateFillResult } from './tool-config-ownership'
import type { StoredManagedCliKey } from './managed-cli-key-store'
import { ExternalClientOwnershipStore } from './external-client-ownership'
import {
  assertTrustedElevatedCliCommand,
  launchCliPowerShell,
  launchUnelevatedCommandWindow,
  resolveWindowsPowerShellExecutable,
  WindowsCliLaunchError,
  type WindowsCliExecutionMode,
} from './windows-elevation'
import { createTrustedTemporaryDirectory, trustedInstallerCacheRoot } from './trusted-temp'
import {
  buildInstallLeftoverLocations,
  type InstallLeftoverLocation,
  type InstallLeftoverSweepResult,
} from './install-leftovers'
import { resolveWindowsMachinePaths } from './windows-machine-paths'
import {
  chooseNodeRuntimeArchitecture,
  inspectWindowsExecutableMachine,
  inspectWindowsProcessorArchitecture,
  type WindowsProcessorArchitecture,
} from './windows-processor'
import { createCliTerminalAccess, type UserPathOutcome } from './windows-cli-shell-access'
import type { MacosShellProfileOutcome } from './macos-shell-profile'
import type { LinuxTerminalCommandsReason, LinuxTerminalCommandsResult } from './linux-shell-profile'
import { createManagedNpmCache, ensureManagedNpmLayout, type ManagedNpmLayout } from './managed-cli'
import { managedCliRoot, managedNativeProviderRoot, managedNpmCacheRoot, managedNpmPrefix } from './managed-cli-paths'
import { isRegisteredTrustedManagedWindowsPath } from './managed-path-trust'
import {
  describeInsufficientDiskSpace,
  readDiskSpace,
  tightestDiskSpace,
} from './disk-space'
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
import { fetchGrokStableVersion, resolveGrokInstallVersion } from './grok-update'
import { createNetworkLocationCache, reloadNetworkProxyConfiguration } from './network-location-cache'
import { readBoundedUtf8File } from './bounded-file'
import { cliNativePackageMissingMessage, findMissingCliNativePackage } from './cli-native-package'
import { readBoundedResponseText } from './bounded-response'
import { launchMacosTerminal, type MacosTerminalLaunchPlan } from './macos-platform'
import { launchLinuxTerminal, LinuxTerminalLaunchError, type LinuxTerminalAttempt } from './linux-terminal'
import { createRelayEndpointRoutingSnapshot, relayApiProbeBaseUrl, relayProviderBaseUrls, relaySiteEndpointChoices, relaySiteForProviderBaseUrl,
  type RelayEndpointId, type RelayEndpointRoutingSnapshot, type RelaySite } from './relay-sites'
import {
  ensureDarwinGrokAgentLink,
  inspectDarwinGrokVerifiedSelection,
  listDarwinGrokHistoricalQuarantineFiles,
  listDarwinGrokOrphanedDownloads,
  resolveDarwinGrokCanonicalSelection,
  runDarwinGrokPostInstallTransaction,
  verifyDarwinGrokUninstallPlan,
} from './macos-grok'
import {
  buildLinuxGrokRetainedFilesCommand,
  buildLinuxGrokRetainedFilesReason,
  resolveLinuxGrokInstalledVersion,
  runLinuxGrokPostInstallTransaction,
  uninstallVerifiedLinuxGrokInstallation,
  verifyLinuxGrokPostInstall,
  type VerifyLinuxGrokPostInstallOptions,
} from './linux-grok'
import { inspectMacosCodexApp, type MacosCodexAppInfo, type MacosCodexAppInspection } from './macos-codex-app'
import {
  inspectCommandLineToolsShim,
  isCommandLineToolsShimBacked,
  isMacOsCommandLineToolsShim,
} from './macos-command-line-tools'
import {
  installMacGitRuntime,
  requestMacCommandLineToolsInstall,
  waitForMacCommandLineTools,
} from './macos-git-install'
import { uninstallVerifiedNativeCliFiles } from './native-cli-uninstall'
import {
  buildClaudeRetainedVersionFilesCommand,
  buildClaudeRetainedVersionFilesReason,
  uninstallVerifiedClaudeNativeInstallation,
} from './claude-native-uninstall'
import { sameLocalPathIdentity } from './path-identity'
import { syncXingmangAiSkillCodexAvailability } from './xingmang-ai-skill'
import {
  cleanupDownloadedGrokBinary,
  downloadLatestGrokBinary,
  installDownloadedGrokBinary,
  type DownloadedGrokBinary,
} from './grok-installer'
import {
  followExternalToolRoute,
  saveExternalToolConfig,
  type ExternalToolConfigOptions,
  type ExternalToolId,
} from './external-tool-config'
import { externalClientNames, type ExternalClientConfigResult, type ExternalClientStatus, type ExternalClientRuntimeStatus } from './external-client-contract'
import { createExternalClientRuntime, type ExternalClientDetectionErrorDetail, type ExternalClientMacVerificationFailure, type ExternalClientRegistryFailure } from './external-client-runtime'
import { inspectExternalToolConnection, resolveExternalToolProbeCredential, type ExternalToolProbeCredential } from './external-tool-config'
import { runExternalClientCheck, type ExternalClientCheckResult } from './external-client-connection'
import { createClaudeDesktopConfigService } from './claude-desktop-config'
import { resolveClaudeDesktopPaths } from './claude-desktop-paths'
import { inspectClaudeDesktopStoreVirtualization } from './claude-desktop-manifest'
import { assertClaudeDesktopUnmanaged } from './claude-desktop-policy'
import { classifyNetworkFailure, isServiceUnavailableResponse, networkFailureMessages, parsesAsJsonObject, toolCertificateMessages } from './network-failure'
import { NewApiNetworkError } from './new-api-client'
import { createSystemSnapshotCache } from './system-snapshot-cache'
import { createExternalClientSnapshotCache } from './external-client-snapshot-cache'
import { BoundedOperationQueue } from './bounded-operation-queue'

const execFileAsync = promisify(execFile)
const npmLatestCacheTtlMs = 10 * 60_000
const npmLatestFailureCacheTtlMs = 2 * 60_000
// Version checks run during the dashboard's initial scan. Keep each registry
// attempt bounded so an offline machine reaches the UI with an explicit
// "检查失败" state instead of appearing frozen for a minute or longer.
const npmLatestQueryTimeoutMs = 10_000
const maximumNpmRegistryResponseBytes = 256 * 1024
const maximumNpmPackageLockBytes = 16 * 1024 * 1024
export const networkLocationCacheTtlMs = 10 * 60_000
const npmOfficialRegistry = 'https://registry.npmjs.org'
const npmMirrorRegistry = 'https://registry.npmmirror.com'
// 安装走到「把新版本换进全局目录」这一步就不能再中断了：半个目录被替换掉的
// CLI 既跑不起来也回不去。这两条是拒绝取消时给用户看的原因。
const managedPrefixSwapSealReason = '正在把新版本写入工具目录，这一步中断会让工具用不了，请等它结束。'
const grokBinarySwapSealReason = '正在替换 Grok CLI 可执行文件，这一步中断会让工具用不了，请等它结束。'
// Windows 上装完 Claude Code 接着顺带装 Git 的那一段接不上取消（第四十批 C），
// 用界面上别处「停不下来」时的同一句。
const gitAlongsideClaudeSealReason = '这一步已经不能取消了。'
const networkLocationUrl = 'https://www.cloudflare.com/cdn-cgi/trace'
const networkLocationFallbackUrls = [
  'https://myip.ipip.net/',
  'https://ipapi.co/json/',
  'https://ipinfo.io/json',
] as const
const maximumModelResponseBytes = 1024 * 1024
const modelAccessCacheMaxEntries = 32
const maximumRuntimeManifestBytes = 256 * 1024
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

/**
 * 本工具给 Claude Code / Codex / Gemini CLI 的安装、更新、回滚都走 npm。已经由官方
 * 安装器或别的方式装好的那份，npm 碰不到，只会在 npm 全局目录旁边再装一份，两份
 * 抢着被找到（#481）。这种情况不装，给一句怎么办。Grok 走自己的原生通道，不在此列。
 */
export function externalCliInstallRefusal(provider: ProviderId, installSource: CliInstallDisplaySource | undefined): string | null {
  if (provider === 'grok') return null
  const name = cliCatalog[provider].name
  if (installSource === 'native') return `这台电脑上的 ${name} 由官方安装器管理，这里不会再另装一份，请用它自己的方式更新`
  if (installSource === 'path') return `这台电脑上的 ${name} 不是通过本工具安装的，这里不会再另装一份，更新请用它原本的安装方式`
  return null
}

/** Keeps service-level macOS launching bound to the command already verified by CLI resolution. */
export function buildDarwinCliLaunchPlan(
  command: { executable: string; argv: readonly string[] },
  workspace: string,
  env: NodeJS.ProcessEnv,
): MacosTerminalLaunchPlan {
  if (!path.isAbsolute(command.executable)) {
    throw new Error('macOS CLI executable must be an absolute resolved path')
  }
  if (!path.isAbsolute(workspace)) throw new Error('macOS workspace must be an absolute path')
  return { executable: command.executable, argv: [...command.argv], workspace, env }
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
         * files left behind by uninstallVerifiedClaudeNativeInstallation.
         */
        manualCommand: string | null
      }
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
 * Every darwin Grok post-install and uninstall codesign verification runs through
 * this rather than the plain commandEnvironment() baseline used elsewhere to locate an
 * installation. The result decides whether a just-installed or about-to-be-removed
 * Grok binary is the genuine xAI build, so it must not run in an environment the
 * caller can still shape after the fact — the same reasoning macos-codex-app.ts and
 * resolveCliCommand's darwin staging path already apply for Codex.
 *
 * executeCommand is threaded through explicitly, rather than closed over, so this
 * stays a top-level function callable — and testable — from outside
 * createSystemService's closure.
 */
export function buildDarwinTrustedVerificationRunner(
  executeCommand: typeof runCommand,
): (spec: { executable: string; argv: readonly string[] }) => Promise<{ stdout: string; stderr: string }> {
  return async (spec) => {
    const result = await executeCommand(spec, {
      env: trustedCommandEnvironment(),
      timeoutMs: 8_000,
      maxOutputBytes: 1024 * 1024,
    })
    return { stdout: result.stdout, stderr: result.stderr }
  }
}

export interface UninstallVerifiedDarwinGrokInstallationOptions {
  homeDirectory: string
  installDirectory: string
  runCommand: (
    spec: { executable: string; argv: readonly string[] },
  ) => Promise<{ stdout: string; stderr: string }>
}

export interface InspectVerifiedDarwinGrokPostInstallOptions {
  homeDirectory: string
  expectedVersion: string
  runCommand: (
    spec: { executable: string; argv: readonly string[] },
  ) => Promise<{ stdout: string; stderr: string }>
}

/** Verifies and inspects only a private staged copy, then describes the bound canonical install. */
export async function inspectVerifiedDarwinGrokPostInstall(
  options: InspectVerifiedDarwinGrokPostInstallOptions,
): Promise<{ status: ToolStatus; installation: CliInstallation }> {
  const selection = resolveDarwinGrokCanonicalSelection(options.homeDirectory)
  // internal #16: the npm lifecycle script driving this install only ever
  // recreates the `grok` link on real hardware. Ensuring `agent` here — inside
  // the same post-install transaction — means a failure rolls back the whole
  // install exactly like a codesign or version mismatch would, instead of
  // quietly shipping an install this app's own automatic uninstall can't
  // later complete (see uninstallVerifiedDarwinGrokInstallation below).
  await ensureDarwinGrokAgentLink(options.homeDirectory, selection)
  return inspectDarwinGrokVerifiedSelection({
    homeDirectory: options.homeDirectory,
    selection,
    expectedVersion: options.expectedVersion,
    runCommand: options.runCommand,
    inspect: async (executablePath) => {
      const stats = await fs.promises.lstat(executablePath)
      if (
        !path.isAbsolute(executablePath)
        || executablePath === selection.executablePath
        || !stats.isFile()
        || stats.isSymbolicLink()
        || (stats.mode & 0o111) === 0
      ) {
        throw new Error('Grok postinstall inspection requires a private staged executable')
      }
      const installDirectory = fs.realpathSync(path.dirname(selection.canonicalLinkPath))
      return {
        status: {
          installed: true,
          version: options.expectedVersion,
          path: selection.executablePath,
          installDirectory,
        },
        installation: {
          commandPath: selection.canonicalLinkPath,
          installDirectory,
          packageRoot: null,
          npmPrefix: null,
          packageVersion: null,
          source: 'native',
        },
      }
    },
  })
}

/**
 * Linux 版拆分 ③：Linux 上没有 codesign，linux-grok.ts 改用「和 npm 官方源校验过的主程序包逐字节
 * 一致 + 报告的版本一致」来证明装的是 xAI 的那份，证明完了才在这里描述这次安装，和 macOS 那一份同形。
 */
export async function inspectVerifiedLinuxGrokPostInstall(
  options: VerifyLinuxGrokPostInstallOptions,
): Promise<{ status: ToolStatus; installation: CliInstallation }> {
  const selection = await verifyLinuxGrokPostInstall(options)
  const installDirectory = fs.realpathSync(path.dirname(selection.canonicalLinkPath))
  return {
    status: {
      installed: true,
      version: options.expectedVersion,
      path: selection.executablePath,
      installDirectory,
    },
    installation: {
      commandPath: selection.canonicalLinkPath,
      installDirectory,
      packageRoot: null,
      npmPrefix: null,
      packageVersion: null,
      source: 'native',
    },
  }
}

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

/** Single-quotes a path so a copied command pastes safely even if $HOME contains spaces or quotes. */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function formatMebibytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MiB`
}

/** One rm -f target per line so the copy-command dialog's <pre> block stays readable for more than a couple of paths. */
function buildDarwinGrokCleanupCommand(paths: readonly string[]): string {
  const quoted = paths.map(shellSingleQuote)
  if (quoted.length <= 1) return `rm -f ${quoted[0] ?? ''}`
  return [
    'rm -f \\',
    ...quoted.map((value, index) => `  ${value}${index < quoted.length - 1 ? ' \\' : ''}`),
  ].join('\n')
}

/**
 * internal #18: on darwin, uninstallVerifiedNativeCliFiles never deletes a
 * quarantined symlink's renamed file (Node has no inode-bound unlink on
 * macOS — see its comment at the retainedQuarantineFiles push), so every
 * darwin Grok uninstall ends up here; this is the routine last step, not a
 * rare edge case. grokManualUninstallResult recognizes this type to hand back
 * a fully re-verified, ready-to-run manualCommand instead of the generic null
 * it falls back to for an actual security-verification failure, where no
 * command can safely be guessed.
 */
export class DarwinGrokRetainedPathsError extends Error {
  readonly manualCommand: string

  constructor(message: string, manualCommand: string) {
    super(message)
    this.name = 'DarwinGrokRetainedPathsError'
    this.manualCommand = manualCommand
  }
}

/** Verifies the official link layout, then removes only the exact planned links. */
export async function uninstallVerifiedDarwinGrokInstallation(
  options: UninstallVerifiedDarwinGrokInstallationOptions,
) {
  const plan = await verifyDarwinGrokUninstallPlan({
    homeDirectory: options.homeDirectory,
    runCommand: options.runCommand,
  })
  if (!plan.expectedSymbolicLinks.grok) {
    throw new Error('Grok automatic uninstall requires a verified grok symbolic link; use the official manual uninstall instructions')
  }
  // internal #16: agent is best-effort here, not required. Installs made
  // before ensureDarwinGrokAgentLink existed (or a user who removed the link
  // by hand) can legitimately lack it, and uninstalling grok alone still
  // leaves a consistent, fully-uninstalled state — so a missing agent only
  // narrows what gets removed instead of blocking the whole operation.
  // verifyDarwinGrokUninstallPlan above already fully re-verified whichever
  // links are actually present; this just decides which ones to act on.
  const hasAgentLink = Boolean(plan.expectedSymbolicLinks.agent)
  const result = await uninstallVerifiedNativeCliFiles({
    actualDirectory: options.installDirectory,
    expectedDirectory: plan.directory,
    expectedDirectoryIdentity: plan.directoryIdentity,
    fileNames: hasAgentLink ? ['grok', 'agent'] : ['grok'],
    label: 'Grok CLI',
    platform: 'darwin',
    expectedSymbolicLinks: plan.expectedSymbolicLinks,
    expectedSymbolicLinkIdentities: plan.expectedSymbolicLinkIdentities,
    expectedSymbolicLinkRootDirectory: plan.rootDirectory,
    expectedSymbolicLinkRootDirectoryIdentity: plan.rootDirectoryIdentity,
    expectedResolvedSymbolicLinkTargets: plan.expectedResolvedSymbolicLinkTargets,
    expectedOwnerUid: plan.expectedOwnerUid,
    removeDirectoryWhenEmpty: false,
  })
  // internal #16 (real-hardware regression): grok and agent can resolve to
  // the exact same underlying binary once both links target the same
  // release, so summing every entry in expectedResolvedSymbolicLinkTargets
  // without deduping double-counted that one shared file's size (measured
  // 251 MiB reported for a 125.7 MiB binary). These are already realpath'd
  // absolute paths, so plain string-identity dedup is exact.
  const retainedProgramPaths = [...new Set(
    Object.values(plan.expectedResolvedSymbolicLinkTargets)
      .map((target) => target.path)
      .filter((filePath) => fs.existsSync(filePath)),
  )]
  // internal #20: fold in every earlier round's own leftover .removing files
  // too — see listDarwinGrokHistoricalQuarantineFiles for why a name match
  // alone is trustworthy here. Excluding this round's own paths keeps the
  // variable's name honest; the Set below would dedupe them either way.
  const currentQuarantineFiles = new Set(result.retainedQuarantineFiles)
  const historicalQuarantineFiles = listDarwinGrokHistoricalQuarantineFiles(options.homeDirectory)
    .filter((filePath) => !currentQuarantineFiles.has(filePath))
  const retainedPaths = [...new Set([
    ...result.retainedQuarantineFiles,
    ...retainedProgramPaths,
    ...historicalQuarantineFiles,
  ])]
  if (retainedPaths.length > 0) {
    const displayPath = (filePath: string) => `~/.grok/${path.relative(plan.rootDirectory, filePath)}`
    // Quarantine paths (this round's and historical) are deliberately left
    // out of this sum: they are this app's own tiny renamed symlinks, not
    // the "程序文件" this figure describes, and a quarantine symlink's target
    // text still resolves after the rename — summing it too would reopen
    // this same function's #16 double-count across rounds that happened to
    // reinstall the same release.
    const retainedBytes = retainedProgramPaths.reduce((total, filePath) => {
      try {
        return total + fs.statSync(filePath).size
      } catch {
        return total
      }
    }, 0)
    const messageParts = [
      'Grok CLI 命令入口已移除，但自动卸载未完整完成。',
      `为避免 macOS 按路径删除时误删被并发替换的文件，以下 ${retainedPaths.length} 个文件未自动删除：`,
      retainedPaths.map(displayPath).join('；'),
      retainedBytes > 0 ? `（其中程序文件共约 ${formatMebibytes(retainedBytes)}）。` : '。',
      historicalQuarantineFiles.length > 0
        ? `它们包含本次卸载的符号链接改名残留、已失去命令入口的旧程序文件，以及 ${historicalQuarantineFiles.length} 个以前几次卸载遗留的隔离文件；Grok 命令已不可用，确认没有进程占用后即可删除，下方是可直接复制执行的清理命令。`
        : '它们是卸载时符号链接改名后的残留、以及已失去命令入口的旧程序文件；Grok 命令已不可用，确认没有进程占用后即可删除，下方是可直接复制执行的清理命令。',
    ]
    // internal #18: these accumulate silently across every version this
    // machine has ever installed — mention them so a user cleaning up notices
    // them, without ever deleting them ourselves (out of scope for #18).
    const orphans = listDarwinGrokOrphanedDownloads(options.homeDirectory, retainedProgramPaths)
    if (orphans.length > 0) {
      const orphanBytes = orphans.reduce((total, orphan) => total + orphan.size, 0)
      const orphanNames = orphans.slice(0, 5).map((orphan) => path.basename(orphan.path))
      const orphanNamesText = orphans.length > 5 ? `${orphanNames.join('；')} 等` : orphanNames.join('；')
      messageParts.push(
        `另在 ~/.grok/downloads/ 检测到 ${orphans.length} 个未被当前 grok/agent 引用的历史版本安装包`
          + `（共约 ${formatMebibytes(orphanBytes)}：${orphanNamesText}），如确认不再需要可一并手动清理，本工具不会自动删除它们。`,
      )
    }
    throw new DarwinGrokRetainedPathsError(messageParts.join(''), buildDarwinGrokCleanupCommand(retainedPaths))
  }
  return result
}

export function grokManualUninstallResult(
  previousVersion: string | null,
  error: unknown,
): Extract<ToolUninstallResult, { outcome: 'manual-required' }> {
  if (error instanceof DarwinGrokRetainedPathsError) {
    // Built entirely in-house from a small, already-bounded set of verified
    // paths (the orphan list above is itself capped for display), unlike an
    // arbitrary caught Error, so this skips the generic control-character
    // stripping below and keeps more of its own text. The command itself
    // always comes straight from the error's own property, never from this
    // truncated string, so a long reason can never truncate mid-path.
    const reason = error.message.trim().slice(0, 2000) || 'Grok CLI 自动卸载安全验证失败'
    return {
      outcome: 'manual-required',
      previousVersion,
      error: reason,
      manualHelp: {
        reason,
        manualCommand: error.manualCommand,
      },
    }
  }
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500)
    || 'Grok CLI 自动卸载安全验证失败'
  return {
    outcome: 'manual-required',
    previousVersion,
    error: message,
    manualHelp: {
      reason: `自动卸载安全验证失败：${message}`,
      manualCommand: null,
    },
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
  /** 备份恢复成功之后调用；`isAccountKey` 判断一把 Key 是不是当前账号由本软件签发的。 */
  adoptRestoredConfig(provider: ProviderId, isAccountKey: (apiKey: string) => boolean): Promise<void>
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
  inspectCliUpdate(provider: ProviderId, forceRefresh?: boolean): Promise<CliStatus>
  installCodexDesktop(target: RendererMessageTarget): Promise<CodexDesktopInstallResult>
  cancelCodexDesktopInstall(): InstallCancellationOutcome
  uninstallCodexDesktop(): Promise<ToolUninstallResult>
  resetCodexDesktop(): Promise<void>
  inspectCodexDesktopUpdate(forceRefresh?: boolean): Promise<DesktopAppStatus>
  /** resumeSessionId 只在 Codex 续接时由 ipc.ts 核对过后传入，见 cliLaunchArgv。 */
  launchProvider(provider: ProviderId, workspace: string, mode?: CliLaunchMode, resumeSessionId?: string | null): Promise<CliLaunchResult>
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
    launchOptions?: { injectChinese?: boolean },
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
  fetchAvailableModels(apiKey: string, options?: { bypassCache?: boolean }): Promise<string[]>
  configureExternalTool(tool: ExternalToolId, options: ExternalToolConfigOptions, assertBeforeWrite?: () => void): Promise<ExternalClientConfigResult>
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
}

function firstOutputLine(stdout: string, stderr: string): string | null {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '') ?? null
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

async function readPackageManifestVersion(filePath: string, label: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readBoundedUtf8File(
      filePath,
      maximumRuntimeManifestBytes,
      label,
    )) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const version = (parsed as Record<string, unknown>).version
    return typeof version === 'string' && isExactCliVersion(version.trim())
      ? version.trim()
      : null
  } catch {
    return null
  }
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
 * An unknown region means the Cloudflare probe could not complete, and the
 * users whose network blocks that probe are overwhelmingly the ones who also
 * cannot reach registry.npmjs.org. Sending them to the official registry first
 * was exactly backwards.
 *
 * The costs are not symmetric. An overseas user wrongly routed to npmmirror
 * loses a few seconds to a CDN that still serves them; a mainland user wrongly
 * routed to the official registry cannot install at all. Both entries stay in
 * the list either way, so a wrong guess only changes which one is tried first.
 */
export function npmInstallRegistries(region: NetworkRegion): [string, string] {
  return region === 'outside-mainland-china'
    ? [npmOfficialRegistry, npmMirrorRegistry]
    : [npmMirrorRegistry, npmOfficialRegistry]
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

export function npmRegistryLabel(registry: string): string {
  return registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
}

/**
 * The dependency graph must be resolved against the official registry, and a
 * mirror cannot stand in for it. Measured on Windows, all four managed CLIs
 * resolve only 7-12 packages in 1-4s on a healthy connection, so a wait long
 * enough to notice means the connection to registry.npmjs.org is struggling,
 * not that there is a lot of work to do. Ten minutes is a ceiling for that
 * case rather than an expected duration; five was killing connections that
 * were slow but still making progress. npm prints nothing throughout, which
 * is why this step used to look like a hang.
 */
export const npmResolutionTimeoutMs = 10 * 60_000
export const npmDownloadTimeoutMs = 5 * 60_000
export const npmResolutionHeartbeatMs = 15_000
/**
 * `npm ci` is where the package bytes move, and a fixed five minutes was not
 * enough of them: Claude Code and Codex are 90-160 MB per platform, so a link
 * under roughly 0.3-0.5 MB/s ran out of time mid-download, and the next
 * registry started again from zero because every attempt has its own cache.
 * npm never ends a transfer that is slow but still moving, so neither does
 * this step: it ends only once the attempt directory has stopped changing for
 * the stall window, and the ceiling is a backstop for a download that trickles
 * forever. The `--offline` install that follows still uses
 * npmDownloadTimeoutMs; it reads the verified cache and fetches nothing.
 */
export const npmDownloadStallTimeoutMs = 3 * 60_000
export const npmDownloadCeilingMs = 30 * 60_000
export const npmDownloadProgressCheckMs = 15_000
export const npmDownloadHeartbeatMs = 15_000
export const grokDownloadStallHeartbeatMs = 15_000

export function grokDownloadStallMessage(idleMs: number): string {
  return `Grok CLI 下载已 ${Math.round(idleMs / 1000)} 秒没有新数据，仍在等待；若长时间不动，请检查网络或切换加速线路后重试`
}

export function formatElapsedDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}

export function npmResolutionStartMessage(registry: string): string {
  return registry === npmOfficialRegistry
    ? '正在从 npm 官方源解析完整依赖图并校验 SHA-512 完整性。这一步必须直连官方源，'
      + '镜像无法代替；网络受限时可能较慢，但不影响后续下载速度，请耐心等待'
    : `正在从${npmRegistryLabel(registry)}解析完整依赖图，准备与官方 SHA-512 对账`
}

export function npmResolutionHeartbeatMessage(registry: string, elapsedMs: number): string {
  return `仍在解析${npmRegistryLabel(registry)}的依赖图…（已用时 ${formatElapsedDuration(elapsedMs)}）`
}

/**
 * npm 下载时也一声不出，网慢时这一步能下到 30 分钟（第三十七批 A），进度停在一句话上像卡死了。
 * 写法照解析那句，只报已用时：总量不知道，不猜百分比。两句是 2026-10-06 拍板的原话（第三十七批 D），
 * 「从」后面接 npm 时空一格，所以不拼 npmRegistryLabel。
 */
export function npmDownloadHeartbeatMessage(registry: string, elapsedMs: number): string {
  const source = registry === npmMirrorRegistry ? '从国内 npm 镜像' : '从 npm 官方源'
  return `仍在${source}下载…（已用时 ${formatElapsedDuration(elapsedMs)}）`
}

/** 总时长到点和下载卡住被掐，对客户是一回事，都说这一句（渲染层按它归成「下载超时」）。 */
const npmDownloadTimedOutMessage = '下载超时，长时间没有完成，已中止'

/**
 * Bytes under `directory`, counted without following links. Entries that vanish
 * mid-walk (npm moves a finished download out of its temp folder) are skipped.
 * A root that cannot be read rejects instead of counting as empty: a reading
 * that stays at zero would look exactly like a download that stopped moving.
 * The walk is sequential on purpose: it runs every few seconds next to the
 * download it watches and must not compete with it for the disk.
 */
export async function measureDirectoryBytes(directory: string): Promise<number> {
  let total = 0
  const pending = [directory]
  while (pending.length) {
    const current = pending.pop()
    if (current === undefined) break
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch (error) {
      if (current === directory) throw error
      continue
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(child)
      } else if (entry.isFile()) {
        try {
          total += (await fs.promises.lstat(child)).size
        } catch {
          // 量的这一刻刚被挪走或删掉：这次少算它，下一次再量。
        }
      }
    }
  }
  return total
}

export interface NpmDownloadStallWatch {
  /** Fires once the measured size has not changed for the stall window. */
  readonly signal: AbortSignal
  /** True once this watch ended the download, as opposed to the user's cancel or the ceiling. */
  readonly stalled: boolean
  /** The last size measured; null until the first measurement lands. */
  readonly bytes: number | null
  stop(): void
}

export interface NpmDownloadStallWatchOptions {
  checkIntervalMs?: number
  stallTimeoutMs?: number
  /** Monotonic milliseconds: a wall-clock correction must never read as a stall. */
  now?: () => number
}

/**
 * The size of the attempt directory is the progress report npm never prints:
 * make-fetch-happen tees every response into cacache, which appends to a temp
 * file as chunks arrive, while tar unpacks into node_modules as it reads. Any
 * change counts, a shrink included, since npm discarding a broken partial
 * download before its own retry is activity rather than a hang. A measurement
 * that fails counts as activity too: a download is never ended on evidence the
 * watch could not collect.
 */
export function createNpmDownloadStallWatch(
  measureBytes: () => Promise<number>,
  options: NpmDownloadStallWatchOptions = {},
): NpmDownloadStallWatch {
  const checkIntervalMs = options.checkIntervalMs ?? npmDownloadProgressCheckMs
  const stallTimeoutMs = options.stallTimeoutMs ?? npmDownloadStallTimeoutMs
  const now = options.now ?? (() => performance.now())
  const controller = new AbortController()
  let lastBytes: number | null = null
  let lastChangeAt = now()
  let measuring = false
  let stopped = false
  let stalled = false
  const timer = setInterval(() => { void check() }, checkIntervalMs)

  function stop(): void {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }

  async function check(): Promise<void> {
    // 上一次还没量完（盘慢、文件多）就跳过这一拍，不叠着量。
    if (measuring || stopped) return
    measuring = true
    let bytes: number | null
    try {
      bytes = await measureBytes()
    } catch {
      bytes = null
    } finally {
      measuring = false
    }
    if (stopped) return
    const checkedAt = now()
    if (bytes === null || bytes !== lastBytes) {
      if (bytes !== null) lastBytes = bytes
      lastChangeAt = checkedAt
      return
    }
    if (checkedAt - lastChangeAt < stallTimeoutMs) return
    stalled = true
    stop()
    controller.abort(new Error(npmDownloadTimedOutMessage))
  }

  void check()
  return {
    signal: controller.signal,
    get stalled() { return stalled },
    get bytes() { return lastBytes },
    stop,
  }
}

/**
 * CommandRunnerError keeps npm's stderr on the error object, but its message
 * only says "命令执行失败（退出码 1）：node". The renderer classifies install
 * failures by the tokens npm prints (ENOSPC, EPERM, ETIMEDOUT, certificate
 * codes), so without npm's own lines a full disk, a denied folder and a
 * dropped connection all looked the same and every one of them was sent to
 * customer support.
 *
 * The runner's generic timeout wording deliberately avoids "超时" because a
 * command running long is not always a network problem. Inside an npm install
 * it is: npm spends its time downloading, so here it is said plainly.
 */
export function describeNpmCommandFailure(error: unknown): string {
  if (!(error instanceof CommandRunnerError)) {
    return error instanceof Error ? error.message : String(error)
  }
  if (error.code === 'TIMED_OUT') return npmDownloadTimedOutMessage
  const highlights = npmFailureHighlights(error.stderr)
  return highlights ? `${error.message}（${highlights}）` : error.message
}

/**
 * 卸载不下载任何东西，所以不借上面那句「下载超时」：借过去渲染层会归成下载超时，
 * 叫客户换源重试。这里一律用命令运行器自己那句话（它刻意不说「超时」），后面接上
 * npm 的要点（EPERM、EBUSY 这些），文件被占用要靠它们才认得出来。
 */
export function describeNpmUninstallFailure(error: unknown): string {
  if (!(error instanceof CommandRunnerError)) {
    return error instanceof Error ? error.message : String(error)
  }
  const highlights = npmFailureHighlights(error.stderr)
  return highlights ? `${error.message}（${highlights}）` : error.message
}

function npmFailureHighlights(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .filter((line) => !/^\s*npm (?:warn|notice|verbose|info|http|timing)\b/i.test(line))
    .map((line) => line.replace(/^\s*npm (?:error|ERR!)\s*/i, '').trim())
    // The pointer to npm's own log file names a folder under the user's
    // profile and says nothing about what went wrong.
    .filter((line) => line && !/complete log of this run/i.test(line))
  const codeLine = lines.find((line) => /^code\s+\S+$/.test(line))
  const picked = codeLine
    ? [
        codeLine.replace(/^code\s+/, ''),
        ...lines.filter((line) => line !== codeLine && !/^(?:syscall|errno|path|dest)\s/.test(line)).slice(0, 1),
      ]
    : lines.slice(-2)
  return redactCommandText(picked.map((line) => line.slice(0, 160)).join('；'))
}

export function npmPackageLatestUrl(registry: string, packageName: string): string {
  return `${registry.replace(/\/+$/, '')}/${encodeURIComponent(packageName)}/latest`
}

export function npmPackageVersionUrl(registry: string, packageName: string, version: string): string {
  return `${registry.replace(/\/+$/, '')}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`
}

export interface NpmPackageReleaseMetadata {
  name: string
  version: string
  integrity: string
}

export function parseNpmPackageReleaseMetadata(
  input: string,
  expectedPackageName: string,
): NpmPackageReleaseMetadata | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const dist = record.dist && typeof record.dist === 'object' && !Array.isArray(record.dist)
    ? record.dist as Record<string, unknown>
    : null
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  const integrity = typeof dist?.integrity === 'string' ? dist.integrity.trim() : ''
  if (name !== expectedPackageName || !isExactCliVersion(version)) return null
  const match = integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)
  if (!match) return null
  try {
    if (Buffer.from(match[1], 'base64').length !== 64) return null
  } catch {
    return null
  }
  return { name, version, integrity }
}

export async function fetchNpmPackageReleaseMetadata(
  registry: string,
  packageName: string,
  version: string | 'latest',
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = npmLatestQueryTimeoutMs,
): Promise<NpmPackageReleaseMetadata> {
  const sourceLabel = registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  try {
    const endpoint = version === 'latest'
      ? npmPackageLatestUrl(registry, packageName)
      : npmPackageVersionUrl(registry, packageName, version)
    const response = await fetchImplementation(endpoint, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`${sourceLabel} HTTP ${response.status}`)
    const body = await readBoundedResponseText(
      response,
      maximumNpmRegistryResponseBytes,
      `${sourceLabel}包元数据`,
    )
    const release = parseNpmPackageReleaseMetadata(body, packageName)
    if (!release || (version !== 'latest' && release.version !== version)) {
      throw new Error(`${sourceLabel}返回的包名、版本或 SHA-512 完整性元数据无效`)
    }
    return release
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${sourceLabel}包元数据查询超时`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
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

/** Binds registry metadata to the exact direct package record npm resolved from the official registry. */
export function assertNpmReleaseMatchesOfficialLock(
  trustedRelease: NpmPackageReleaseMetadata,
  officialLock: string,
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(officialLock) as unknown
  } catch {
    throw new Error('npm 官方 package-lock.json 不是有效 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('npm 官方 package-lock.json 根结构无效')
  }
  const packages = (parsed as Record<string, unknown>).packages
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error('npm 官方 package-lock.json 缺少 packages 图')
  }
  const packageEntries = packages as Record<string, unknown>
  const root = packageEntries['']
  const rootDependencies = root && typeof root === 'object' && !Array.isArray(root)
    ? (root as Record<string, unknown>).dependencies
    : null
  const directVersion = rootDependencies && typeof rootDependencies === 'object' && !Array.isArray(rootDependencies)
    ? (rootDependencies as Record<string, unknown>)[trustedRelease.name]
    : null
  const directLocation = `node_modules/${trustedRelease.name}`
  const directEntry = packageEntries[directLocation]
  if (
    directVersion !== trustedRelease.version
    || !directEntry
    || typeof directEntry !== 'object'
    || Array.isArray(directEntry)
  ) {
    throw new Error('npm 官方 package-lock.json 的目标直依赖身份或版本与发布元数据不一致')
  }
  const record = directEntry as Record<string, unknown>
  if (
    record.version !== trustedRelease.version
    || record.integrity !== trustedRelease.integrity
  ) {
    throw new Error('npm 官方 package-lock.json 的目标直依赖版本或 SHA-512 与发布元数据不一致')
  }
}

function canonicalNpmPackageLock(
  input: string,
  packageName: string,
  version: string,
): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch {
    throw new Error('npm package-lock.json 不是有效 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('npm package-lock.json 根结构无效')
  }
  const lock = parsed as Record<string, unknown>
  const packages = lock.packages
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error('npm package-lock.json 缺少 packages 图')
  }
  const packageEntries = packages as Record<string, unknown>
  const root = packageEntries['']
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('npm package-lock.json 缺少根包')
  }
  const rootDependencies = (root as Record<string, unknown>).dependencies
  if (
    !rootDependencies
    || typeof rootDependencies !== 'object'
    || Array.isArray(rootDependencies)
    || (rootDependencies as Record<string, unknown>)[packageName] !== version
  ) {
    throw new Error('npm package-lock.json 没有锁定目标 CLI 的精确版本')
  }
  for (const [location, entry] of Object.entries(packageEntries)) {
    if (!location) continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`npm package-lock.json 包记录无效：${location}`)
    }
    const record = entry as Record<string, unknown>
    const entryVersion = typeof record.version === 'string' ? record.version.trim() : ''
    const integrity = typeof record.integrity === 'string' ? record.integrity.trim() : ''
    const integrityMatch = integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)
    if (!isExactCliVersion(entryVersion) || !integrityMatch) {
      throw new Error(`npm package-lock.json 包版本或 SHA-512 无效：${location}`)
    }
    if (Buffer.from(integrityMatch[1], 'base64').length !== 64) {
      throw new Error(`npm package-lock.json SHA-512 长度无效：${location}`)
    }
  }

  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'resolved')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]))
  }
  return JSON.stringify(canonicalize(lock))
}

export function assertNpmPackageLocksEquivalent(
  officialLock: string,
  candidateLock: string,
  packageName: string,
  version: string,
): void {
  const official = canonicalNpmPackageLock(officialLock, packageName, version)
  const candidate = canonicalNpmPackageLock(candidateLock, packageName, version)
  if (candidate !== official) {
    throw new Error('npm 镜像的完整依赖图、版本或 SHA-512 与官方源不一致')
  }
}

export class ManagedNpmRollbackError extends Error {
  readonly preserveTransaction = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ManagedNpmRollbackError'
  }
}

export interface ManagedNpmReplaceOperations {
  rename(source: string, destination: string): Promise<void>
}

export interface ManagedNpmReplaceResult {
  /**
   * 检查通过后，旧版那份是否已改名成 superseded-prefix。false 时它还叫 previous-prefix：
   * 收尾删除没做完的话，下次安装开头的恢复仍会把它当成「更新没做完」退回去，和以前一样。
   */
  backupRetired: boolean
}

const managedNpmBackupRetireAttempts = 5

function isTransientManagedNpmRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EAGAIN'
}

/**
 * 新版检查通过以后，previous-prefix 就不该再是「断了要退回的那份」。下次装、更新、卸载开头的
 * 恢复（managed-cli.ts）只认这个名字：「完成」之后、临时文件夹删完之前退出、关机、崩掉，或者
 * 删到一半失败，以前都会被它当成更新没做完，把检查过的新版换回旧版，删了一半的话换回来的
 * 还是残缺的旧版。同一个目录里改名一步完成，所以不另写记号文件：删到一半时记号可能先没了、
 * 备份还在。安全软件正攥着里面的文件时照 safe-local-data.ts 的规矩重试几次；还不行就留着
 * 原名，和以前一样，不影响这次报完成。
 */
async function retireVerifiedManagedNpmBackup(
  backup: string,
  superseded: string,
  operations: ManagedNpmReplaceOperations,
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operations.rename(backup, superseded)
      return true
    } catch (error) {
      if (!isTransientManagedNpmRenameError(error) || attempt === managedNpmBackupRetireAttempts - 1) return false
    }
    await new Promise((resolve) => setTimeout(resolve, 20 * (2 ** attempt)))
  }
}

export async function replaceManagedNpmPrefixAtomically(
  activePrefix: string,
  stagedPrefix: string,
  transactionDirectory: string,
  verifyPromotedPrefix: () => Promise<void>,
  operations: ManagedNpmReplaceOperations = fs.promises,
): Promise<ManagedNpmReplaceResult> {
  const active = path.resolve(activePrefix)
  const staged = path.resolve(stagedPrefix)
  const transaction = path.resolve(transactionDirectory)
  const relativeStage = path.relative(transaction, staged)
  if (
    active === staged
    || path.parse(active).root.toLowerCase() !== path.parse(staged).root.toLowerCase()
    || relativeStage === ''
    || relativeStage === '..'
    || relativeStage.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeStage)
  ) {
    throw new Error('托管 npm 事务目录无效，未修改当前安装')
  }
  if (!fs.existsSync(active) || !fs.statSync(active).isDirectory()) {
    throw new Error('当前托管 npm 目录不存在，无法执行原子更新')
  }
  if (!fs.existsSync(staged) || !fs.statSync(staged).isDirectory()) {
    throw new Error('暂存 npm 目录不存在，无法执行原子更新')
  }

  const backup = path.join(transaction, 'previous-prefix')
  const rejected = path.join(transaction, 'rejected-prefix')
  await operations.rename(active, backup)
  let promoted = false
  try {
    await operations.rename(staged, active)
    promoted = true
    await verifyPromotedPrefix()
  } catch (error) {
    let rollbackError: unknown = null
    try {
      if (promoted && fs.existsSync(active)) await operations.rename(active, rejected)
      if (fs.existsSync(backup)) await operations.rename(backup, active)
    } catch (cause) {
      rollbackError = cause
    }
    if (rollbackError) {
      const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      throw new ManagedNpmRollbackError(`托管 npm 更新失败，且旧版本回滚失败：${detail}`, { cause: error })
    }
    throw error
  }
  return {
    backupRetired: await retireVerifiedManagedNpmBackup(backup, path.join(transaction, 'superseded-prefix'), operations),
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

export interface CliMaintenancePlan {
  kind: 'npm-install'
  executable: string
  argv: string[]
  windowsPackageManager: 'npm'
}

export type GrokInstallStrategy = 'windows-native' | 'darwin-official-npm' | 'linux-official-npm' | 'external'

export function grokInstallStrategyFor(platform: NodeJS.Platform): GrokInstallStrategy {
  if (platform === 'win32') return 'windows-native'
  if (platform === 'darwin') return 'darwin-official-npm'
  // 和 macOS 一样从 npm 装（Linux 版拆分 ③），只是没有 codesign，核对改由 linux-grok.ts 做。
  if (platform === 'linux') return 'linux-official-npm'
  return 'external'
}

/**
 * 「有没有新版」去哪问。Windows 与 macOS 的 Grok 以 xAI 的 stable 清单为准；Linux 的 Grok 从
 * npm 装，也就问 npm：x.ai 和它的备用地址在国内大多连不上，Linux 第一版又没有加速。
 * 不给平台时按 stable 清单答，和以前一样。
 */
export function cliLatestVersionSource(
  provider: ProviderId,
  platform?: NodeJS.Platform,
): 'npm' | 'official-manifest' {
  if (provider !== 'grok') return 'npm'
  return platform && grokInstallStrategyFor(platform) === 'linux-official-npm' ? 'npm' : 'official-manifest'
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

export interface CliInstallReleaseOptions {
  /** 要安装的版本,'latest' 表示不钉版本。Grok 的官方稳定版路径以 xAI stable 为上限。 */
  version?: string
  fetchGrokStableVersion: () => Promise<{ version: string }>
  fetchNpmRelease: (
    registry: string,
    packageName: string,
    version: string | 'latest',
  ) => Promise<NpmPackageReleaseMetadata>
}

/** Selects the authoritative release before generating an npm dependency lock. */
export async function resolveCliInstallRelease(
  provider: ProviderId,
  grokStrategy: GrokInstallStrategy | null,
  options: CliInstallReleaseOptions = {
    fetchGrokStableVersion,
    fetchNpmRelease: fetchNpmPackageReleaseMetadata,
  },
): Promise<NpmPackageReleaseMetadata> {
  if (provider !== 'grok' || grokStrategy !== 'darwin-official-npm') {
    return options.fetchNpmRelease(
      npmOfficialRegistry,
      cliCatalog[provider].packageName,
      options.version ?? 'latest',
    )
  }
  const stable = await options.fetchGrokStableVersion()
  const version = resolveGrokInstallVersion(options.version, stable.version)
  const release = await options.fetchNpmRelease(
    npmOfficialRegistry,
    cliCatalog.grok.packageName,
    version,
  )
  if (release.version !== version) {
    throw new Error('Grok npm 发布版本与要安装的 xAI 官方版本不一致')
  }
  return release
}

export function buildCliMaintenancePlan(
  provider: ProviderId,
  npmExecutable: string | null,
  npmPrefix: string | null = null,
  version = 'latest',
  verifiedLifecycleScripts = false,
  platform: NodeJS.Platform = process.platform,
): CliMaintenancePlan {
  if (provider === 'grok') {
    const strategy = grokInstallStrategyFor(platform)
    if (strategy === 'windows-native') {
      throw new Error('Grok CLI 必须使用 xAI 已签名二进制安装器')
    }
    if (strategy === 'external') {
      throw new Error('当前平台不支持 Grok CLI 一键安装')
    }
    if (!verifiedLifecycleScripts) {
      throw new Error('Grok CLI 生命周期脚本必须先通过完整性校验')
    }
  }
  if (!npmExecutable) throw new Error('未检测到 npm，请先安装 Node.js')
  if (platform !== 'win32' && provider !== 'grok' && !npmPrefix) {
    throw new Error(platform === 'darwin' ? 'macOS 用户级 npm 前缀不能为空' : '用户级 npm 前缀不能为空')
  }
  if (version !== 'latest' && !isExactCliVersion(version)) {
    throw new Error('npm CLI 版本号格式无效')
  }
  if (provider === 'grok') {
    return {
      kind: 'npm-install',
      executable: npmExecutable,
      argv: ['ci', '--omit=dev'],
      windowsPackageManager: 'npm',
    }
  }
  return {
    kind: 'npm-install',
    executable: npmExecutable,
    argv: [
      'install',
      '--global',
      ...(npmPrefix ? [`--prefix=${npmPrefix}`] : []),
      ...(!verifiedLifecycleScripts ? ['--ignore-scripts'] : []),
      '--omit=dev',
      '--package-lock=false',
      `${cliCatalog[provider].packageName}@${version}`,
    ],
    windowsPackageManager: 'npm',
  }
}

export type CliUninstallPlan =
  | {
      kind: 'npm-uninstall'
      executable: string
      argv: string[]
      windowsPackageManager: 'npm'
      packageRoot: string
    }
  | { kind: 'grok-native' | 'claude-native' }

export function buildCliUninstallPlan(
  provider: ProviderId,
  installation: CliInstallation,
  npmExecutable: string | null,
): CliUninstallPlan {
  if (installation.source === 'npm' && installation.packageRoot) {
    if (!npmExecutable || !installation.npmPrefix) {
      throw new Error(`无法确定 ${cliCatalog[provider].name} 所属的 npm 和安装前缀`)
    }
    return {
      kind: 'npm-uninstall',
      executable: npmExecutable,
      argv: [
        'uninstall',
        '--global',
        `--prefix=${installation.npmPrefix}`,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        cliCatalog[provider].packageName,
      ],
      windowsPackageManager: 'npm',
      packageRoot: installation.packageRoot,
    }
  }
  if (provider === 'grok' && installation.source === 'native') return { kind: 'grok-native' }
  if (provider === 'claude' && installation.source === 'native') return { kind: 'claude-native' }
  throw new Error(`当前 ${cliCatalog[provider].name} 不是 npm 安装，无法确认安全卸载方式`)
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

// `describeProbeFailure` (probe-failure.ts) and the `build*FromSettled`
// helpers below keep a rejected probe from masquerading as "not installed".
/**
 * 装 Claude Code 时顺带把缺的 Git 装上（协调者 2026-09-24：能自动的就不让客户点）。
 * Git 只是可选环境，它装不上**不能**让已经装好的 Claude Code 报失败：这里吞掉错误，
 * 只留一句中文说明，首页运行环境那行的「安装 Git」按钮照旧在，客户想重试点它就行。
 */
export async function installGitAlongsideClaude(
  install: () => Promise<{ action: GitRuntimeInstallResult['action'] }>,
  note: (message: string) => void,
): Promise<void> {
  try {
    const result = await install()
    if (result.action === 'installed') note('Git 也顺带装好了')
  } catch {
    note('Git 这次没装上，不影响使用 Claude Code；以后可以在首页「运行环境」里点「安装 Git」再试')
  }
}

/**
 * Windows 上装 Claude Code 时，顺带的 Git（installGitAlongsideClaude）是在 Claude Code 那一项出队之后
 * 才装的，界面上却仍是同一次「安装」，那一行的「取消」也还亮着。装 Git 接不上取消，所以这次安装的取消
 * 句柄先不收、改成封住：这时点「取消」回「这一步已经不能取消了。」，而不是「这个工具当前没有正在进行的
 * 安装。」（第四十批 C）。Git 那段结束（装上、没装上都算）再收。Claude Code 自己没装成（失败或被取消）
 * 就不进 Git 这段，照旧马上收。
 */
export async function finishClaudeInstallWithGit(
  claude: Promise<void>,
  cancellation: InstallCancellationHandle,
  installGit: () => Promise<void>,
): Promise<void> {
  try {
    await claude
    cancellation.seal(gitAlongsideClaudeSealReason)
    await installGit()
  } finally {
    cancellation.release()
  }
}

export function buildToolStatusFromSettled(result: PromiseSettledResult<ToolStatus>): ToolStatus {
  if (result.status === 'fulfilled') return result.value
  return {
    installed: false,
    version: null,
    path: null,
    installDirectory: null,
    detectionFailed: true,
    detectionError: describeProbeFailure(result.reason),
  }
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
  /** Frozen at startup: pending settings must not repoint live account or tool work. */
  relayEndpointRouting?: RelayEndpointRoutingSnapshot
  /** Stable realm + user identity; null while logged out. Never inferred from the relay URL. */
  getExternalClientAccountId?: () => string | null
  /** 开机补模板缺省项前问「哪些工具开着」的那一步；缺省 = 真去查进程，测试里替换掉。 */
  inspectRunningToolsForTemplateFill?: (providers: readonly ProviderId[]) => Promise<RunningToolsReport>
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
  /** Relay traffic uses Electron's proxy-aware network stack in the desktop host. */
  relayFetch?: typeof fetch
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

export function providerCommandEnvironment(
  provider: ProviderId,
  processEnv: NodeJS.ProcessEnv,
  codexEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = commandEnvironment(provider === 'codex' ? codexEnv : processEnv)
  if (provider === 'gemini') {
    // Gemini CLI loads the managed ~/.gemini/.env only when a variable is not
    // already present. A shell-level stale gateway/key/model would otherwise
    // override the account configuration just written by the manager and send
    // requests to another relay (or select a model that is not in the group).
    const managedGeminiVariables = new Set([
      'GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_MODEL',
      'GOOGLE_GENAI_API_VERSION', 'GOOGLE_GEMINI_API_KEY',
    ])
    for (const key of Object.keys(environment)) {
      if (managedGeminiVariables.has(key.toUpperCase())) delete environment[key]
    }
  }
  return environment
}

/** 刚跑完的一轮扫描在这么久以内可以直接复用（见 createScanCoalescer）。 */
export const scanReuseMs = 15_000

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
 * 客户点了「换成新版 Node.js」（公司电脑的证书要 22.19 / 24.6 以上才认）时，已经装着的
 * Node.js 即使够装工具也要照样换。Windows 上换：那边装的是官方安装包，会接替
 * Program Files 里原来那份；Linux 上也换：本软件代下的那份排在 PATH 最前
 * （linux-platform.ts），装上就是它。Mac 上代下的那份排在 PATH 最后，客户自己的旧版
 * 永远先被找到，装了也白装（macos-platform.ts darwinCommandPathCandidates）。
 * 版本读不出（null）不换：那时不知道该怪 Node 旧。
 */
export function shouldReplaceNodeForCertificates(input: {
  platform: NodeJS.Platform
  request: NodeRuntimeInstallRequest
  node: Pick<ToolStatus, 'installed' | 'version'>
}): boolean {
  return input.platform !== 'darwin'
    && input.request.reason === 'certificate'
    && input.node.installed
    && nodeReadsSystemCertificates(input.node.version) === false
}

export const nodeStillOutdatedAfterReplaceMessage = '新版 Node.js 已经装上了，但电脑上另外还有一份旧的 Node.js 排在前面，工具仍会先用到它，还是认不了这台电脑的证书。请联系客服帮你处理。'

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

/** 比两个线路地址时不计末尾的斜杠：Claude Desktop 设置窗口里存的地址可能带一个。 */
function sameRouteUrl(left: string, right: string): boolean {
  return left.replace(/\/+$/, '') === right.replace(/\/+$/, '')
}

export function createSystemService(
  store: AppSettingsStore,
  serviceOptions: SystemServiceOptions = {},
): SystemService {
  const windowsExecutionMode = serviceOptions.windowsExecutionMode ?? 'trusted-only'
  const platform = serviceOptions.platform ?? process.platform
  const providerRoots = serviceOptions.providerRoots ?? defaultProviderConfigRoots()
  const runtimeLog = serviceOptions.runtimeLog
  // 这次启动替用户改过的钩子（第十八批 1b）：试过的不再试，改好的让首页说一句。只在内存里，重开软件从头算。
  const autoRepairAttemptedCliHooks = new Set<ProviderId>()
  const autoRepairCheckedOwners = new Set<string>()
  const autoRepairedCliHooks = new Set<ProviderId>()
  let autoRepairQueue: Promise<unknown> = Promise.resolve()
  const configOwnership = new ToolConfigOwnershipStore(path.join(serviceOptions.managerDataDirectory ?? store.dataDirectory, 'tool-config-ownership'))
  const externalOwnership = new ExternalClientOwnershipStore(path.join(serviceOptions.managerDataDirectory ?? store.dataDirectory, 'external-client-ownership'))
  const projectInstructionsState = new ProjectInstructionsStateStore(path.join(serviceOptions.managerDataDirectory ?? store.dataDirectory, 'project-instructions'))
  const cliUpdateHistory = new CliUpdateHistoryStore(path.join(serviceOptions.managerDataDirectory ?? store.dataDirectory, 'cli-update-history'))
  let configWriteQueue: Promise<unknown> = Promise.resolve()
  function serializeConfigWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = configWriteQueue.then(operation, operation)
    configWriteQueue = next.catch(() => undefined)
    return next
  }
  const codexEnv = serviceOptions.codexEnv
    ?? { ...process.env, CODEX_HOME: providerRoots.codexHome }
  const relayRouting = serviceOptions.relayEndpointRouting ?? createRelayEndpointRoutingSnapshot(store.read().relayEndpointIds)
  function activeRelaySite(): RelaySite {
    return relayRouting.resolve(serviceOptions.getRelaySiteId?.() ?? store.read().relaySiteId)
  }
  function providerRelaySite(provider: ProviderId, current: NativeConfigInspection, removal = false): RelaySite {
    const selected = activeRelaySite()
    if (!removal && relayRouting.selection(selected.id) !== undefined) return selected
    return relaySiteForProviderBaseUrl(selected.id, provider, current.actualBaseUrl) ?? selected
  }
  // The account's site remains live; its selected transport is frozen until
  // restart so account clients, native writes and probes cannot use mixed lines.
  const inspectNativeProviderConfig = (provider: ProviderId) =>
    (serviceOptions.inspectProviderConfig ?? inspectProviderConfig)(
      provider,
      providerRoots,
      activeRelaySite().providerBaseUrls,
    )
  const providerEnvironment = (provider: ProviderId): NodeJS.ProcessEnv =>
    providerCommandEnvironment(provider, process.env, codexEnv)
  const resolveVerifiedCliCommand = serviceOptions.resolveCliCommand ?? resolveCliCommand
  const launchLinuxTerminalForService = serviceOptions.launchLinuxTerminal ?? launchLinuxTerminal
  const launchCliPowerShellForService = serviceOptions.launchCliPowerShell ?? launchCliPowerShell
  const resolveCliInstallationForService = serviceOptions.resolveCliInstallation ?? resolveCliInstallation
  const findExecutableForService = serviceOptions.findExecutable ?? findExecutable
  const executeCommand = serviceOptions.runCommand ?? runCommand
  const detectMacosCodexApp = serviceOptions.macosCodexAppDetector ?? inspectMacosCodexApp
  const installPythonRuntimeForService = serviceOptions.installPythonRuntime ?? installPythonRuntime312
  const inspectInstalledPythonRuntimeForService = serviceOptions.inspectInstalledPythonRuntime ?? inspectInstalledPythonRuntime
  const inspectWindowsRestartRequiredForService = serviceOptions.inspectWindowsRestartRequired ?? inspectWindowsRestartRequired
  // macOS 上不跑 Windows 那套 winget / MSI：把官方压缩包解进本软件自己的文件夹（第十六批 2）。
  // Linux 同理，只是版本和校验值钉在软件里（linux-node-runtime.ts，Linux 版拆分 ②）。
  const installNodeRuntimeForService = serviceOptions.installNodeRuntime
    ?? (platform === 'darwin'
      ? installDarwinNodeRuntime
      : platform === 'win32' ? installNodeRuntimeLts : installLinuxNodeRuntime)
  const installGitRuntimeForService = serviceOptions.installGitRuntime ?? installGitForWindows
  const installMacGitRuntimeWith = serviceOptions.installMacGitRuntime ?? installMacGitRuntime
  // 安装下载曾经完全无视机器上的代理：产物下载走 Node 自带网络栈、npm 子进程
  // 没有任何代理变量，于是开着加速也一样直连。这两个注入点把下载接回系统代理。
  const downloadFetch = serviceOptions.downloadFetch ?? fetch
  /**
   * 管理员身份时照旧用 Node 自带的根证书：当前用户的证书库普通权限就写得进，不能
   * 让它决定管理员的安装信任哪张证书（与 trustedCommandEnvironment 剥掉
   * NODE_USE_SYSTEM_CA 同一个理由）。取 fetch 放在调用时，测试替换全局 fetch 才生效。
   */
  const registryMetadataFetch: typeof fetch = (input, init) => (
    serviceOptions.registryFetch && !(platform === 'win32' && windowsExecutionMode === 'trusted-only')
      ? serviceOptions.registryFetch(input, init)
      : fetch(input, init)
  )
  const resolveSubprocessProxyEnvironment = serviceOptions.resolveSubprocessProxyEnvironment
    ?? (async (): Promise<NodeJS.ProcessEnv> => ({}))
  const acquireDownloadAcceleration = serviceOptions.acquireDownloadAcceleration
  const probeLoopbackProxyForService = serviceOptions.probeLoopbackProxy ?? probeLoopbackProxy
  /**
   * 电脑里留着指向本机某个没开的代理的设置时，这一次不带它（第十六批 5）。只减不增：
   * 开着的、指向别的机器的照旧带上；探测出错时原样返回，不挡住打开和安装。
   */
  async function withoutDeadLoopbackProxies(env: NodeJS.ProcessEnv, provider: ProviderId): Promise<NodeJS.ProcessEnv> {
    const bypass = await bypassClosedLoopbackProxies(env, probeLoopbackProxyForService)
    if (bypass.dropped.length) {
      runtimeLog?.log('info', 'network', 'proxy-env.bypassed', '电脑里设的本机代理没开，这一次不带它', {
        provider,
        ...describeDroppedProxies(bypass.dropped),
      })
    }
    return bypass.env
  }
  // 有多少次下载正跑在加速线路上。只用来决定安装源顺序，所以是个计数而不是
  // 布尔：两个工具同时装时，先装完的那个不能把后一个的官方优先撤掉。
  let acceleratedDownloads = 0
  const resolveWindowsMachinePathsForService = serviceOptions.resolveWindowsMachinePaths ?? resolveWindowsMachinePaths
  const installing = new Set<ProviderId>()
  const installationQueue = new InstallationQueue()
  const installCancellations = new InstallCancellationRegistry()
  const externalClientRuntime = serviceOptions.externalClientRuntime ?? createExternalClientRuntime({
    installationQueue, platform, userHome: providerRoots.userHome, runCommand: executeCommand, windowsExecutionMode,
    // Mac 上一键装桌面端自己下官方包：和命令行工具一样走系统代理、临时加速，下之前先看盘。
    fetch: downloadFetch,
    withDownloadRoute: (operation) => withDownloadAcceleration(null, operation),
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
  })
  let nodeRuntimeInstalling = false
  // Mac 上要不要改用代下的那份 Node.js（preferredNodeDirectories）。判断要起一两次 `node --version`，
  // 同一阵子里的检测、装工具、开工具共用一次结果；强制重新检测、装完 Node.js 时重新判断。
  let preferredNodeProbe: { at: number; directory: Promise<string | null> } | null = null
  let windowsProcessor: Promise<WindowsProcessorArchitecture | null> | null = null
  const inspectExecutableMachine = serviceOptions.inspectExecutableMachine ?? inspectWindowsExecutableMachine
  // 苹果的安装窗口一次只该弹一个：连点两下「安装 Git」拿到的是同一次等待。
  let macGitInstall: Promise<GitRuntimeInstallResult> | null = null
  let pythonRuntimeInstalling = false
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
  const inspectOfficialUsage = serviceOptions.fetchOfficialChatGptUsage
    ?? (process.env.VITEST ? async () => null : fetchOfficialChatGptUsage)

  function createInstallTemporaryDirectory(
    label: string,
    options: { baseDirectory?: string } = {},
  ): Promise<string> {
    if (options.baseDirectory) {
      return createTrustedTemporaryDirectory(label, {
        platform,
        env: commandEnvironment(),
        baseDirectory: options.baseDirectory,
      })
    }
    if (process.platform === 'win32' && windowsExecutionMode === 'trusted-only') {
      return createTrustedTemporaryDirectory(label, options)
    }
    const safeLabel = label.replace(/[^a-z0-9-]/gi, '-')
    return fs.promises.mkdtemp(path.join(os.tmpdir(), `xingmang-${safeLabel}-`))
  }

  const probeDiskSpace = serviceOptions.readDiskSpace ?? readDiskSpace

  /**
   * 一次安装会同时用到临时事务目录和托管目录，所以两块盘都问一次，按最紧的那
   * 一块判断。npm 的全局目录要跑一条命令才知道，而事务目录和缓存本来就落在临
   * 时目录，够覆盖「C 盘只剩几百兆」这个真实场景。
   */
  function installDiskSpaceTargets(): string[] {
    const targets = [os.tmpdir()]
    try {
      targets.push(managedCliRoot(commandEnvironment(), platform))
    } catch {
      // Windows 上拿不到可信的 ProgramData 时托管目录本来就用不了，这一项跳过。
    }
    return targets
  }

  /**
   * 装之前先看一眼盘。**读不到空间一律放行**（disk-space.ts 的 fail-open）：为了
   * 一个查不到的数字拦下安装，是把小毛病变成大故障。拦住时抛的那句话里有
   * 「磁盘空间不足」，渲染层按已有的「磁盘空间不够」一类呈现，不新立一类。
   */
  async function assertInstallDiskSpace(subject: string): Promise<void> {
    const readings = await Promise.all(
      installDiskSpaceTargets().map((target) => probeDiskSpace(target)),
    )
    const tightest = tightestDiskSpace(readings)
    const shortfall = describeInsufficientDiskSpace(tightest)
    if (!shortfall) return
    runtimeLog?.log('warn', 'install', 'disk-space.insufficient', `${subject}：${shortfall}`, {
      subject,
      availableBytes: tightest?.availableBytes ?? null,
      measuredPath: tightest ? redactHomeDirectory(tightest.measuredPath, providerRoots.userHome) : null,
    })
    throw new Error(`${subject}：${shortfall}`)
  }

  function inspectNetworkLocation(forceRefresh = false): Promise<NetworkLocationStatus> {
    return networkLocationCache.read(forceRefresh)
  }

  function refreshNetworkLocation(): Promise<SystemSnapshot['network']> {
    return inspectNetworkLocation(true)
  }

  /**
   * 把一次下载包在临时加速里：开始前把线路拉起来，结束（无论成败）再还回去。
   * 拿不到线路就原样执行——加速是加分项，绝不能变成安装的前置条件。
   */
  async function withDownloadAcceleration<T>(
    note: ((message: string) => void) | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!acquireDownloadAcceleration) return operation()
    note?.('正在准备下载加速')
    let lease: DownloadAccelerationLease
    try { lease = await acquireDownloadAcceleration() }
    catch { return operation() }
    // 拿到手就一定要还回去，哪怕这一次并没有线路：租约的归属在协调者那边，
    // 不还回去等于让下一次下载去猜还有没有人在用。
    if (lease.accelerated) {
      note?.('已为本次下载启用加速线路（未改动系统代理）')
      acceleratedDownloads += 1
    } else {
      note?.('未启用下载加速，按现有下载源顺序继续')
    }
    try { return await operation() }
    finally {
      if (lease.accelerated) acceleratedDownloads -= 1
      await lease.release().catch(() => undefined)
    }
  }

  async function inspectNetworkRegion(): Promise<NetworkRegion> {
    // 2.4：镜像策略被用户钉死时不再探测——直接归约到产生所需源顺序的
    // region。scanSystem 的网络状态卡片仍走真实探测（inspectNetworkLocation），
    // 展示保持诚实，这里只决定安装/版本检查的源顺序。
    const policy = store.read().mirrorPolicy
    if (policy) return effectiveNetworkRegion(policy, 'unknown')
    // 加速已经为这次下载起来了：线路本来就是为直连官方源准备的，再绕镜像
    // 没有意义。顺带省掉一次区域探测——网络受限时那一步本身最不可靠。
    if (acceleratedDownloads > 0) return effectiveNetworkRegion('official-first', 'unknown')
    return (await inspectNetworkLocation()).region
  }

  /**
   * Tool discovery is deliberately not restricted to machine PATH entries.
   * npm global installs and the official Grok/Claude installers live under a
   * user's profile on Windows. Discovery is read-only; an explicitly elevated
   * process still blocks version execution from user-writable paths.
   */
  async function findInstalledExecutable(command: string): Promise<string | null> {
    const additionalPaths = await nodeCommandDirectories(command)
    return findExecutableForService(command, {
      env: commandEnvironment(),
      windowsPackageManagers: command.toLowerCase() === 'npm' ? ['npm'] : [],
      ...(additionalPaths.length ? { additionalPaths } : {}),
    })
  }

  /**
   * Mac 上客户自己那份 Node.js 太旧、代下的那份够新时，本软件自己找 node / npm、跑 npm
   * 都把代下的那份排到最前（第三十四批 A，macos-node-runtime.ts）；别的平台、别的情况是空的，
   * 顺序照旧。交给工具的终端 PATH 不经过这里，客户在工具里用的还是他自己那份。
   */
  function preferredNodeDirectories(): Promise<string[]> {
    if (platform !== 'darwin') return Promise.resolve([])
    const now = Date.now()
    if (!preferredNodeProbe || now - preferredNodeProbe.at >= scanReuseMs) {
      preferredNodeProbe = {
        at: now,
        directory: resolveDarwinPreferredNodeDirectory({
          findNode: () => findExecutableForService('node', { env: commandEnvironment() }),
          readVersion: (executable) => executeVersion(executable, ['--version']),
        }).catch(() => null),
      }
    }
    return preferredNodeProbe.directory.then((directory) => directory ? [directory] : [])
  }

  function nodeCommandDirectories(command: string): Promise<string[]> {
    return ['node', 'npm', 'npx'].includes(command.toLowerCase()) ? preferredNodeDirectories() : Promise.resolve([])
  }

  /** `npm root --global` 也得用找 npm 时排在最前的那份 Node.js 跑，不然代下的 npm 会落到客户的旧 node 上。 */
  async function resolveServiceNpmGlobalRoot(npmExecutable: string | null): Promise<string | null> {
    return resolveNpmGlobalRoot(npmExecutable, commandEnvironment(), undefined, undefined, await preferredNodeDirectories())
  }

  async function executeVersion(
    executable: string,
    args: string[],
    windowsPackageManager?: WindowsPackageManager,
    baseEnv: NodeJS.ProcessEnv = process.env,
    additionalPaths: readonly string[] = [],
  ): Promise<string | null> {
    try {
      const trustedOnly = platform === 'win32' && windowsExecutionMode === 'trusted-only'
      if (trustedOnly) await primeTrustedHighIntegrityExecutable(executable, platform)
      if (trustedOnly && !isTrustedHighIntegrityExecutable(executable)) return null
      const result = await executeCommand({ executable, argv: args, windowsPackageManager }, {
        env: trustedOnly ? trustedCommandEnvironment(baseEnv) : commandEnvironment(baseEnv, additionalPaths),
        trustedOnly,
        timeoutMs: 8_000,
        maxOutputBytes: 1024 * 1024,
      })
      return firstOutputLine(result.stdout, result.stderr)
    } catch (error) {
      const candidate = error as { stdout?: string; stderr?: string }
      return firstOutputLine(candidate.stdout ?? '', candidate.stderr ?? '')
    }
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
   * 「也信任这台电脑的证书」去跑、仍然失败的，原文不动，交给渲染层「连接被证书拦截」
   * 那条。Node 版本读 PATH 上的 node：npm 就是由它跑起来的。读不出版本就不下结论。
   */
  async function withToolCertificateHint(message: string): Promise<string> {
    if (classifyNetworkFailure(message) !== 'tls') return message
    const trustedOnly = process.platform === 'win32' && windowsExecutionMode === 'trusted-only'
    let nodeVersion: string | null = null
    if (!trustedOnly) {
      try { nodeVersion = (await inspectTool('node')).version } catch { nodeVersion = null }
    }
    const kind = toolCertificateFailureKind({ trustedOnly, nodeVersion })
    return kind ? `${message}。${toolCertificateMessages[kind]}` : message
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
      // Linux 的 Grok 问的是 npm（cliLatestVersionSource），下面那份也要清。
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
      preferredNodeProbe = null
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
      providerIds.map((id) => limitedProbe(() => inspectCliTool(id, npm.path, npmGlobalRoot))),
    )
    const cliResults: ToolStatus[] = cliProbes.map(buildCliToolStatusFromSettled)
    // 老版本装的工具旁边还留着 .ps1 启动文件；每次打开软件后的第一轮检测顺手清掉，
    // 只动文件、不起 PowerShell，也不等它。Mac 上这一轮给以前装过、还没补终端设置的
    // 电脑补一次（只补一次，见 macos-shell-profile.ts）；Linux 同理，另外把小启动器
    // 和装着的工具对齐（linux-shell-profile.ts）。
    void cliTerminalAccess.sweepOnce(providerIds.flatMap((provider, index) => {
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
    const uncheckedLatest = providerIds.map(
      (id, index) => buildUncheckedLatestVersion(id, cliResults[index].installed, undefined, platform),
    )
    const latestVersionBudgetMs = networkProbeSuggestsOffline(network)
      ? offlineLatestVersionBudgetMs
      : null
    const latestVersionBudget = latestVersionBudgetMs === null ? undefined : new AbortController()
    const latestVersions = await settleLatestVersionProbes(
      providerIds.map((id, index) => inspectCliLatestVersion(
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
    const clis = Object.fromEntries(providerIds.map((id, index) => {
      const status = cliResults[index]
      return [id, buildCliStatus(status, latestVersions[index], buildCliVersionAdvice(id, status.version, {
        siteId: scanSettings.relaySiteId,
        alwaysLatest: scanSettings.alwaysInstallLatestCli === true,
      }), resolveCliRevertVersion(id, updateHistory[id], status.version, scannedAt, scanSettings.relaySiteId))]
    })) as Record<ProviderId, CliStatus>

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

  async function installNodeRuntimeOperation(
    target: RendererMessageTarget,
    request: NodeRuntimeInstallRequest,
  ): Promise<NodeRuntimeInstallResult> {
    if (nodeRuntimeInstalling) throw new Error('Node.js 正在安装中，请等待当前任务完成')
    nodeRuntimeInstalling = true
    try {
      const [nodeResult, npmResult] = await Promise.allSettled([inspectNode(), inspectTool('npm')])
      const node = buildToolStatusFromSettled(nodeResult)
      const npm = buildToolStatusFromSettled(npmResult)
      if (node.detectionFailed || npm.detectionFailed) {
        throw new Error(node.detectionError ?? npm.detectionError ?? 'Node.js/npm 检测失败，请重新检测后再试')
      }
      const replaceForCertificates = shouldReplaceNodeForCertificates({ platform, request, node })
      if (node.installed && node.versionStatus === 'supported' && npm.installed && !replaceForCertificates) {
        const architecture = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : 'x64'
        const result: NodeRuntimeInstallResult = {
          installed: true,
          action: 'unchanged',
          method: null,
          source: null,
          version: node.version,
          architecture,
          pathRefreshRequired: false,
          systemRestartRequired: false,
        }
        if (!target.isDestroyed()) {
          target.send('runtime:node-install-progress', {
            phase: 'complete',
            source: null,
            message: `已检测到可用的 Node.js ${node.version ?? ''} 和 npm，无需重复安装`.trim(),
            percent: 100,
          })
        }
        return result
      }
      if (platform === 'win32') {
        let restartStatus: WindowsRestartStatus
        try {
          restartStatus = await inspectWindowsRestartRequiredForService()
        } catch (error) {
          // A probe failure must not turn into a false "reboot required" state.
          // The installer still has its own verified fallback and will report
          // the actual Windows Installer result if the probe is unavailable.
          restartStatus = { required: false, reasons: [] }
          if (!target.isDestroyed()) {
            target.send('runtime:node-install-progress', {
              phase: 'checking',
              source: null,
              message: `无法确认 Windows 待重启状态，将继续安装：${error instanceof Error ? error.message : String(error)}`,
              percent: null,
            })
          }
        }
        if (restartStatus.required) {
          const reasons = restartStatus.reasons.length > 0
            ? `（${restartStatus.reasons.join('、')}）`
            : ''
          const message = `检测到 Windows 有待完成的系统更新${reasons}，请先重启电脑；重启后回到这里重新检测，再自动安装 Node.js LTS`
          if (!target.isDestroyed()) {
            target.send('runtime:node-install-progress', {
              phase: 'error',
              source: null,
              message,
              percent: null,
            })
          }
          throw new Error(message)
        }
      }
      const architecture = platform === 'win32'
        ? chooseNodeRuntimeArchitecture({
          processor: await inspectWindowsProcessor(),
          existingNodeMachine: node.installed && node.path ? await inspectExecutableMachine(node.path) : null,
          nodeInstalled: node.installed,
        })
        : undefined
      if (architecture === 'arm64' && process.arch !== 'arm64' && !target.isDestroyed()) {
        target.send('runtime:node-install-progress', {
          phase: 'checking',
          source: null,
          message: '这台电脑是 ARM 芯片，会装 ARM 版 Node.js，工具跑起来更快、更省电',
          percent: null,
        })
      }
      const result = await installNodeRuntimeForService({
        ...(architecture ? { architecture } : {}),
        // 到要下载时才问先走哪个源：Windows 借到线路以后才定，借到了就官方源优先。
        networkRegion: inspectNetworkRegion,
        // Windows 先试 winget，它自己下载、不走下载专用线路，退到下安装包时才借（第二十八批 D）；
        // macOS、Linux 一开始就是下载，整段已经包在线路里（installNodeRuntime）。
        withDownloadRoute: platform === 'win32' ? (operation) => withDownloadAcceleration(null, operation) : undefined,
        temporaryDirectoryMode: windowsExecutionMode,
        dependencies: { fetch: downloadFetch },
        onProgress: (progress) => {
          if (!target.isDestroyed()) target.send('runtime:node-install-progress', progress)
        },
      })
      // Mac 上客户自己那份太旧时，刚下好的这份当场就用上，后面装工具不再去下（第三十四批 A）。
      preferredNodeProbe = null
      if (replaceForCertificates) await assertNodeReplacedForCertificates()
      return result
    } finally {
      nodeRuntimeInstalling = false
    }
  }

  /**
   * 装新版的目的是让工具认得公司证书，装完却仍然找到旧的那份（比如 nvm 之类的
   * 版本管理工具把自己的目录放在前面），工具还是会失败。这时照实说，别让客户以为
   * 换好了、回去重试再撞同一个错。读不出版本就不下结论。
   */
  async function assertNodeReplacedForCertificates(): Promise<void> {
    let version: string | null = null
    try { version = (await inspectTool('node')).version } catch { return }
    if (nodeReadsSystemCertificates(version) !== false) return
    throw new Error(nodeStillOutdatedAfterReplaceMessage)
  }

  function inspectWindowsProcessor(): Promise<WindowsProcessorArchitecture | null> {
    // 芯片开机后不会变，一次启动只问一次；问失败也记住「不知道」，不反复起 reg.exe。
    windowsProcessor ??= (serviceOptions.inspectWindowsProcessor
      ?? (() => inspectWindowsProcessorArchitecture({ platform, machinePaths: () => resolveWindowsMachinePathsForService() })))()
      .catch(() => null)
    return windowsProcessor
  }

  function installNodeRuntime(
    target: RendererMessageTarget,
    request: NodeRuntimeInstallRequest = {},
  ): Promise<NodeRuntimeInstallResult> {
    // Windows 只在退到下安装包时借线路，见 installNodeRuntimeOperation 传下去的 withDownloadRoute。
    return installationQueue.enqueue('runtime:node', () => platform === 'win32'
      ? installNodeRuntimeOperation(target, request)
      : withDownloadAcceleration(null, () => installNodeRuntimeOperation(target, request)))
      .then(async (result) => {
        // 等补完再回，首页随后那次刷新就不再显示「补上」。它自己兜住所有错误，不影响装运行环境的结果。
        if (platform === 'win32') await addMissingGrokHooks('runtime-installed')
        return result
      })
  }

  async function restartWindows(): Promise<void> {
    if (platform !== 'win32') throw new Error('系统重启仅支持 Windows')
    // shutdown /r 会在倒计时结束后强行结束本程序，队列里的安装会停在原子替换的
    // 半截（I11 保护的正是这种中间态），所以有任务在跑就不发重启。
    if (installationQueue.busy) throw new Error('还有安装、卸载或打开工具的任务在进行，等它做完再重启电脑')
    const machinePaths = resolveWindowsMachinePathsForService()
    await executeCommand({
      executable: windowsSystemExecutable('shutdown.exe', process.env, 'win32', machinePaths),
      argv: ['/r', '/t', '15', '/d', 'p:0:0', '/c', 'XingMang AI requires a restart to finish Windows updates'],
    }, {
      env: trustedCommandEnvironment(process.env, machinePaths, 'win32'),
      trustedOnly: true,
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    })
  }

  async function installPythonRuntimeOperation(target: RendererMessageTarget): Promise<PythonRuntimeInstallResult> {
    if (pythonRuntimeInstalling) throw new Error('Python 正在安装中，请等待当前任务完成')
    pythonRuntimeInstalling = true
    try {
      const [pythonResult] = await Promise.allSettled([inspectPython()])
      const python = buildToolStatusFromSettled(pythonResult)
      if (python.detectionFailed) {
        throw new Error(python.detectionError ?? 'Python 检测失败，请重新检测后再试')
      }
      const architecture = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : 'x64'
      if (python.installed && Boolean(python.version?.trim())) {
        const result: PythonRuntimeInstallResult = {
          installed: true,
          action: 'unchanged',
          method: null,
          source: null,
          version: python.version,
          architecture,
          pathRefreshRequired: false,
        }
        if (!target.isDestroyed()) {
          target.send('runtime:python-install-progress', {
            phase: 'complete',
            source: null,
            message: '已检测到可用的 ' + python.version + '，无需重复安装',
            percent: 100,
          })
        }
        return result
      }
      // 商店装不上时退到 python.org 下载，那是国外的站：和装 Node.js、Git 一样借一条
      // 下载专用线路（不改系统代理），所以 fetch 也要换成认这条线路的那一个。商店那一步
      // 自己下载、不走这条线路，所以退到 python.org 时才借（第二十八批 D）。
      return await installPythonRuntimeForService({
        architecture: process.arch,
        temporaryDirectoryMode: windowsExecutionMode,
        withDownloadRoute: (operation) => withDownloadAcceleration(null, operation),
        onProgress: (progress) => {
          if (!target.isDestroyed()) target.send('runtime:python-install-progress', progress)
        },
        dependencies: { fetch: downloadFetch },
      })
    } finally {
      pythonRuntimeInstalling = false
    }
  }

  function installPythonRuntime(target: RendererMessageTarget): Promise<PythonRuntimeInstallResult> {
    return installationQueue.enqueue('runtime:python', () => installPythonRuntimeOperation(target))
  }

  async function installGitRuntimeOperation(
    target: RendererMessageTarget,
    onProgress?: (progress: GitRuntimeInstallProgress) => void,
  ): Promise<GitRuntimeInstallResult> {
    if (platform !== 'win32') throw new Error('Git 自动安装当前仅支持 Windows 和 macOS')
    const git = buildToolStatusFromSettled((await Promise.allSettled([inspectGit()]))[0])
    if (git.detectionFailed) throw new Error(git.detectionError ?? 'Git 检测失败，请重新检测后再试')
    const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
    if (git.installed) {
      if (!target.isDestroyed()) {
        target.send('runtime:git-install-progress', {
          phase: 'complete',
          source: null,
          message: 'Git 本来就装好了，不用重复安装',
          percent: 100,
        })
      }
      return {
        installed: true,
        action: 'unchanged',
        source: null,
        version: git.version,
        architecture,
        pathRefreshRequired: false,
      }
    }
    return installGitRuntimeForService({
      networkRegion: await inspectNetworkRegion(),
      temporaryDirectoryMode: windowsExecutionMode,
      dependencies: { fetch: downloadFetch },
      // 安装程序退出 0 不等于装好：被安全软件或公司策略拦了一半时它照样退出 0（#549）。
      // inspectGit 会额外找代装的两个固定目录，本进程的 PATH 没刷新也找得到。
      verifyInstalled: async () => {
        const installed = await inspectGit()
        return installed.installed ? { version: installed.version } : null
      },
      onProgress: (progress) => {
        if (!target.isDestroyed()) target.send('runtime:git-install-progress', progress)
        onProgress?.(progress)
      },
    })
  }

  /**
   * macOS 上的 Git 交给苹果自己的安装窗口（第十六批 2）。只有「弹窗口」这一下进安装队列；
   * 之后客户在苹果窗口里下载安装可能要十几分钟，这段等待不能占着队列，否则别的工具
   * 全都装不了。
   */
  function installMacGitRuntimeForService(target: RendererMessageTarget): Promise<GitRuntimeInstallResult> {
    macGitInstall ??= installMacGitRuntimeWith({
      inspectInstalled: async () => {
        const git = await inspectGit()
        return git.installed ? { version: git.version } : null
      },
      inspectShim: () => inspectCommandLineToolsShim('/usr/bin/git'),
      request: () => installationQueue.enqueue('runtime:git', () => requestMacCommandLineToolsInstall()),
      wait: () => waitForMacCommandLineTools(),
      onProgress: (progress) => {
        if (!target.isDestroyed()) target.send('runtime:git-install-progress', progress)
      },
    }, process.arch === 'arm64' ? 'arm64' : 'x64').finally(() => {
      macGitInstall = null
    })
    return macGitInstall
  }

  function installGitRuntime(
    target: RendererMessageTarget,
    onProgress?: (progress: GitRuntimeInstallProgress) => void,
  ): Promise<GitRuntimeInstallResult> {
    if (platform === 'darwin') return installMacGitRuntimeForService(target)
    return installationQueue.enqueue('runtime:git',
      () => withDownloadAcceleration(null, () => installGitRuntimeOperation(target, onProgress)))
      .then((result) => {
        if (result.installed && result.action === 'installed') void refreshGrokHooksForShellChange()
        return result
      })
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

  function sendInstallProgress(
    target: RendererMessageTarget,
    provider: ProviderId,
    state: 'started' | 'output' | 'success' | 'error',
    message: string,
    percent?: number,
    staged?: { stage: InstallProgressStage; elapsedMs?: number },
  ): void {
    // 界面只按阶段显示白话，原话（源名、SHA-512、包名、网址、npm 自己的英文）
    // 客服排查还要看，所以落进运行日志。心跳和下载百分比每隔几秒一条，不记。
    if (staged && staged.elapsedMs === undefined && percent === undefined) {
      runtimeLog?.log('info', 'install', staged.stage === 'raw-output' ? 'cli.install.output' : 'cli.install.progress', message, {
        provider,
        stage: staged.stage,
      })
    }
    if (!target.isDestroyed()) {
      target.send('cli:install-progress', {
        provider,
        state,
        message,
        percent,
        ...(staged ? { stage: staged.stage } : {}),
        ...(staged?.elapsedMs !== undefined ? { elapsedMs: staged.elapsedMs } : {}),
      })
    }
  }

  async function findNpmForCliInstall(
    provider: ProviderId,
    target: RendererMessageTarget,
    nodeDirectories: readonly string[],
  ): Promise<string | null> {
    if (process.platform !== 'win32') {
      return findExecutableForService('npm', {
        env: commandEnvironment(),
        windowsPackageManagers: ['npm'],
        ...(nodeDirectories.length ? { additionalPaths: nodeDirectories } : {}),
      })
    }

    const trustedOnly = windowsExecutionMode === 'trusted-only'
    const findUsableNpm = () => findExecutableForService('npm', {
      env: trustedOnly ? trustedCommandEnvironment() : commandEnvironment(),
      windowsPackageManagers: ['npm'],
      trustedOnly,
    })
    let npmExecutable = await findUsableNpm()
    if (npmExecutable) return npmExecutable

    const detectedNpm = await findInstalledExecutable('npm')
    if (detectedNpm) {
      if (trustedOnly) await primeTrustedHighIntegrityExecutable(detectedNpm, platform)
      if (!trustedOnly || isTrustedHighIntegrityExecutable(detectedNpm)) return detectedNpm
      throw new Error(
        `已检测到 npm（${detectedNpm}），但当前会话经过了显式提权或权限状态无法确认，不能安全执行该路径。请以普通权限启动本程序，或将 Node.js 安装到受保护的系统目录后重试`,
      )
    }

    sendInstallProgress(
      target,
      provider,
      'output',
      `未检测到${trustedOnly ? '系统级' : '可用的'} Node.js/npm，正在自动安装 Node.js LTS`,
    )
    if (nodeRuntimeInstalling) throw new Error('Node.js 正在安装中，请等待当前任务完成')
    nodeRuntimeInstalling = true
    try {
      await installNodeRuntimeLts({
        networkRegion: await inspectNetworkRegion(),
        temporaryDirectoryMode: windowsExecutionMode,
        dependencies: { fetch: downloadFetch },
        onProgress: (progress) => {
          if (progress.message) sendInstallProgress(target, provider, 'output', progress.message)
        },
      })
    } finally {
      nodeRuntimeInstalling = false
    }
    npmExecutable = await findUsableNpm()
    if (!npmExecutable) {
      throw new Error('Node.js 安装完成后仍未检测到可用的 npm，请重启本程序后再试')
    }
    return npmExecutable
  }

  /**
   * 把「文件被占用」这句话补到失败原文上,前提是真的撞上了占用:EBUSY / ETXTBSY
   * 自己就够,EPERM / EACCES 必须数到这个工具的进程才算(见 cli-process-probe.ts
   * 的 describeOccupiedUpdateFailure)。数不到就返回 null,原来的失败原样出去。
   */
  async function describeOccupiedCliFailure(
    provider: ProviderId,
    errorLike: unknown,
    detail: string,
    probeRoot: string | null,
    action: OccupiedUpdateFailureInput['action'],
  ): Promise<string | null> {
    if (!fileLockErrorCode(errorLike)) return null
    const probe = probeRoot
      ? await probeRunningCliProcesses(probeRoot)
      : { status: 'unsupported' as const, processes: [] }
    const message = describeOccupiedUpdateFailure({
      toolName: cliCatalog[provider].name,
      action,
      error: errorLike,
      probe,
      detail,
    })
    if (!message) return null
    runtimeLog?.log('warn', 'install', 'cli.file-locked', `${cliCatalog[provider].name} ${action}时文件被占用`, {
      provider,
      probeStatus: probe.status,
      processes: probe.processes.length,
    })
    return message
  }

  /**
   * 安装整段都包在临时加速里：Grok 二进制、Node.js LTS 与 npm 下载共用同一条
   * 线路，中途不换代理（换代理会让已建立的连接和重试落到两条线路上）。
   */
  async function installCliOperation(
    provider: ProviderId,
    target: RendererMessageTarget,
    requestedVersion?: string,
    cancellation?: InstallCancellationHandle,
  ): Promise<void> {
    // 已经在装、排队期间被取消、或磁盘根本不够的，一条线路都不要起。
    if (installing.has(provider)) throw new Error(`${cliCatalog[provider].name} 正在安装中`)
    cancellation?.throwIfCancelled()
    await assertNpmChannelOwnsCli(provider)
    // 磁盘快满时 npm 会跑到一半才报 ENOSPC：用户白等几分钟，旧版本还可能已经被
    // 动过。所以一个字节都还没下之前先看一眼盘（读不到空间照常放行）。
    await assertInstallDiskSpace(`${cliCatalog[provider].name} 安装失败`)
    try {
      await withDownloadAcceleration(
        (message) => sendInstallProgress(target, provider, 'output', message),
        () => runCliInstall(provider, target, requestedVersion, cancellation),
      )
    } finally {
      // 命令行可能换了版本（更新、退回，装到一半回滚没回干净的也算）：读不进型号名单的话
      // Codex 起不来。趁还没出队就收回，排在后面的那次打开才不会先撞上。
      if (provider === 'codex') await takeBackUnreadableCodexModelCatalog('cli-installed')
    }
  }

  /**
   * 按首页同一套判定（同一个 npm 全局根）看现在装着的是哪一份。探测本身失败时不拦：
   * 那时装没装都没有结论，界面给的是「重新检测」，不会走到这里。
   */
  async function assertNpmChannelOwnsCli(provider: ProviderId): Promise<void> {
    if (provider === 'grok') return
    let installSource: CliInstallDisplaySource | undefined
    try {
      // 同 inspectCliUpdate：这里只用得上 npm 在哪，不为它的版本号多起一次 `npm --version`。
      const npmPath = await findInstalledExecutable('npm')
      const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npmPath)
      installSource = (await inspectCliTool(provider, npmPath, npmGlobalRoot)).status.installSource
    } catch {
      return
    }
    const refusal = externalCliInstallRefusal(provider, installSource)
    if (refusal) throw new Error(refusal)
  }

  async function readInstalledCliVersion(provider: ProviderId): Promise<string | null> {
    try {
      return (await inspectCliTool(provider, null, null)).status.version ?? null
    } catch {
      return null
    }
  }

  async function recordCliUpdate(
    provider: ProviderId,
    from: string | null,
    to: string | null,
    requested: boolean,
  ): Promise<void> {
    const updateRecord = buildCliUpdateRecord(from, to, requested, Date.now())
    if (!updateRecord) return
    // 记录只决定首页能不能「退回更新前的版本」,写不进去不该让一次已经
    // 成功的更新报失败。
    await cliUpdateHistory.record(provider, updateRecord).catch((error: unknown) => {
      runtimeLog?.log('warn', 'install', 'cli.update-history.write-failed', `${cliCatalog[provider].name} 更新记录没有写入`, {
        provider,
        detail: error instanceof Error ? redactHomeDirectory(error.message, providerRoots.userHome) : '未知错误',
      })
    })
  }

  async function runCliInstall(
    provider: ProviderId,
    target: RendererMessageTarget,
    requestedVersion?: string,
    cancellation?: InstallCancellationHandle,
  ): Promise<void> {
    const grokInstallStrategy = provider === 'grok' ? grokInstallStrategyFor(platform) : null
    if (installing.has(provider)) throw new Error(`${cliCatalog[provider].name} 正在安装中`)
    // 排队等待期间点的取消在这里生效:队列把任务交给我们时才发现已经取消,
    // 直接退出,一条 npm 命令都不要起。
    cancellation?.throwIfCancelled()
    const definition = cliCatalog[provider]
    installing.add(provider)
    let downloadedGrokBinary: DownloadedGrokBinary | null = null
    let managedNpmLayout: ManagedNpmLayout | null = null
    let managedNpmTransaction: string | null = null
    let preserveManagedNpmTransaction = false
    let occupancyProbeRoot: string | null = null
    let updatingExistingInstall = false
    let versionBeforeUpdate: string | null = null
    try {
      // 装哪个版本由主进程决定:调用方点名(回滚)优先,其次看设置里的
      // 「总是安装最新版」,再次才是名单里的推荐版本。名单为空的工具落回
      // latest,行为与从前一致。Grok 在 Windows、macOS 上以 xAI stable 为上限;Linux 上
      // 和另外三家一样只认 npm（cliLatestVersionSource）。
      const versionChoice = resolveCliInstallVersion(provider, {
        requested: requestedVersion,
        alwaysLatest: store.read().alwaysInstallLatestCli === true,
      })
      if (provider === 'grok') {
        // Grok 不走下面按 npm 目录读 package.json 的那一套,更新前的版本只能问它自己。
        // 读不出来就不记这一笔,「退回」只是不出现,不影响这次更新。
        versionBeforeUpdate = await readInstalledCliVersion(provider)
        if (grokInstallStrategy === 'external') {
          throw new Error('当前平台不支持 Grok CLI 一键安装')
        }
        if (grokInstallStrategy === 'windows-native') {
          const sameUserInstall = windowsExecutionMode === 'same-user'
          const installedBefore = await findInstalledExecutable(definition.command)
          sendInstallProgress(
            target,
            provider,
            'started',
            `正在从 xAI 官方下载并验证已签名的 Grok CLI ${installedBefore ? '更新' : '安装'}包`,
            undefined,
            { stage: 'download' },
          )
          let lastReportedBucket = -1
          // 百分比只在有新数据时才动，所以一条不通的线路看上去和「正在下载」
          // 完全一样。心跳把静止的那段时间说出来，用户才知道该等还是该换线路。
          let lastDownloadActivity = Date.now()
          const stallTicker = setInterval(() => {
            const idleMs = Date.now() - lastDownloadActivity
            if (idleMs < grokDownloadStallHeartbeatMs) return
            sendInstallProgress(
              target,
              provider,
              'output',
              grokDownloadStallMessage(idleMs),
              undefined,
              { stage: 'download', elapsedMs: idleMs },
            )
          }, grokDownloadStallHeartbeatMs)
          try {
            downloadedGrokBinary = await downloadLatestGrokBinary({
              fetchImpl: downloadFetch,
              ...(versionChoice.source === 'latest' ? {} : { version: versionChoice.version }),
              ...(cancellation ? { signal: cancellation.signal } : {}),
              createTemporaryDirectory: () => createInstallTemporaryDirectory('grok-binary'),
              onProgress: ({ percent, transferred, total }) => {
                lastDownloadActivity = Date.now()
                const bucket = Math.floor(percent / 5)
                if (bucket === lastReportedBucket && percent !== 100) return
                lastReportedBucket = bucket
                sendInstallProgress(
                  target,
                  provider,
                  'output',
                  `Grok CLI 下载 ${percent}%（${Math.floor(transferred / 1024 / 1024)} / ${Math.floor(total / 1024 / 1024)} MiB）`,
                  percent,
                  { stage: 'download' },
                )
              },
            })
          } finally {
            clearInterval(stallTicker)
          }
          sendInstallProgress(
            target,
            provider,
            'output',
            `xAI 签名与文件校验通过（${downloadedGrokBinary.version}，SHA-256 ${downloadedGrokBinary.sha256Hex.slice(0, 16)}…）`,
            undefined,
            { stage: 'install' },
          )
          cancellation?.seal(grokBinarySwapSealReason)
          const installed = await installDownloadedGrokBinary(downloadedGrokBinary, sameUserInstall
            ? {
                managedRoot: path.join(os.homedir(), '.grok', 'bin'),
                protectInstallDirectory: false,
              }
            : {})
          cancellation?.unseal()
          invalidateCliUpdateCache(provider)
          sendInstallProgress(target, provider, 'output', `${definition.name} 已写入，正在检查安装结果`, undefined, { stage: 'final-check' })
          const verification = await inspectCliTool(provider, null, null, installed.executablePath)
          if (
            !verification.installation
            || !verification.status.version
            || verification.status.version !== installed.version
            || path.resolve(verification.installation.commandPath) !== path.resolve(installed.executablePath)
          ) {
            throw new Error('Grok CLI 安装后验证失败：未识别到托管可执行文件或版本不一致')
          }
          await recordCliUpdate(provider, versionBeforeUpdate, installed.version, versionChoice.source === 'requested')
          sendInstallProgress(
            target,
            provider,
            'success',
            `${definition.name} ${installedBefore ? '更新' : '安装'}完成（${installed.version}）`,
          )
          return
        }
      }

      // Mac 上客户自己那份 Node.js 太旧时用代下的那份装：npm 用它自带的，跑 npm 的环境也把它
      // 排最前，npm 和工具的安装脚本都靠 `#!/usr/bin/env node` 找 node（第三十四批 A）。
      const nodeDirectories = await preferredNodeDirectories()
      const npmExecutable = await findNpmForCliInstall(provider, target, nodeDirectories)
      let installPrefix: string | null = null
      if (process.platform === 'win32' && windowsExecutionMode === 'trusted-only') {
        managedNpmLayout = await ensureManagedNpmLayout()
      } else if (platform !== 'win32' && provider !== 'grok') {
        // Linux 与 macOS 一样装进当前用户自己的托管目录（Linux 版拆分 ②）：发行版 npm 的
        // 默认全局目录是 /usr，普通权限写不进去；装进 Node.js 自己的目录又会在换 Node 时一起丢掉。
        managedNpmLayout = await ensureManagedNpmLayout({
          platform,
          env: commandEnvironment(),
        })
      }
      // 普通权限安装给 npm 的是空 --userconfig（不让用户 .npmrc 改源、改脚本策略），
      // 这也把用户在 .npmrc 里改过的全局目录一并丢了：新版装进 npm 默认目录，
      // 用户自己敲的命令还是旧版。这里只把 prefix 这一项读回来显式传给 npm。
      // 提权安装走托管目录，绝不读用户可写的配置来决定管理员令牌写到哪里。
      const sameUserNpmPrefix = !managedNpmLayout
        && provider !== 'grok'
        && !(process.platform === 'win32' && windowsExecutionMode === 'trusted-only')
        ? await resolveSameUserNpmPrefix({ env: commandEnvironment(), platform })
        : null
      if (sameUserNpmPrefix) {
        runtimeLog?.log(
          'info',
          'install',
          'cli.install.user-npm-prefix',
          `${definition.name} 按用户 npm 配置安装到 ${redactHomeDirectory(sameUserNpmPrefix.prefix, providerRoots.userHome)}`,
          { provider },
        )
      }
      managedNpmTransaction = await createInstallTemporaryDirectory('npm-transaction', {
        ...(managedNpmLayout ? { baseDirectory: managedNpmLayout.cacheRoot } : {}),
      })
      // 更新和回滚都要替换这个工具已经装好的文件。工具还开着的时候,Windows 会
      // 锁住它自己的可执行文件,替换必然失败;检测只是为了把话说对,所以它既不
      // 拦更新,失败也不影响流程(候选 5 第 2 层)。
      if (provider !== 'grok') {
        if (managedNpmLayout) {
          occupancyProbeRoot = managedCliPackageDirectory(managedNpmLayout.prefix, definition.packageName, platform)
        } else if (sameUserNpmPrefix) {
          occupancyProbeRoot = cliPackageDirectoryFromNpmRoot(
            npmPrefixGlobalRoot(sameUserNpmPrefix.prefix, platform),
            definition.packageName,
          )
        } else {
          const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npmExecutable)
          occupancyProbeRoot = npmGlobalRoot
            ? cliPackageDirectoryFromNpmRoot(npmGlobalRoot, definition.packageName)
            : null
        }
        if (occupancyProbeRoot && fs.existsSync(occupancyProbeRoot)) {
          updatingExistingInstall = true
          versionBeforeUpdate = await readPackageManifestVersion(
            path.join(occupancyProbeRoot, 'package.json'),
            `${definition.name} package.json`,
          )
          const probe = await probeRunningCliProcesses(occupancyProbeRoot)
          runtimeLog?.log(
            probe.status === 'checked' ? 'info' : 'warn',
            'install',
            'cli.running-processes.probe',
            `${definition.name} 更新前进程检测：${probe.status}（${probe.processes.length} 个）`,
            {
              provider,
              status: probe.status,
              processes: probe.processes.length,
              ...(probe.detail ? { detail: redactHomeDirectory(probe.detail, providerRoots.userHome) } : {}),
            },
          )
          const warning = describeRunningCliProcessWarning(definition.name, probe)
          if (warning) sendInstallProgress(target, provider, 'output', warning)
        }
      }
      sendInstallProgress(
        target,
        provider,
        'output',
        versionChoice.source === 'latest'
          ? '正在从 npm 官方源校验最新版本和 SHA-512 完整性元数据'
          : `正在从 npm 官方源校验${versionChoice.source === 'recommended' ? '推荐' : '指定'}版本 ${versionChoice.version} 和 SHA-512 完整性元数据`,
        undefined,
        { stage: 'version' },
      )
      const trustedRelease = await resolveCliInstallRelease(provider, grokInstallStrategy, {
        version: versionChoice.version,
        fetchGrokStableVersion: () => fetchGrokStableVersion({ fetchImpl: registryMetadataFetch }),
        fetchNpmRelease: (registry, packageName, version) => (
          fetchNpmPackageReleaseMetadata(registry, packageName, version, registryMetadataFetch)
        ),
      })
      if (!npmExecutable) throw new Error('未检测到 npm，请先安装 Node.js')
      const networkRegion = await inspectNetworkRegion()
      // Derived from the routing rather than restated, so the line can never
      // claim one registry while npmInstallRegistries picks the other. That had
      // already happened once: the unknown branch still advertised the official
      // registry after the ordering moved to mirror-first.
      const [primaryRegistry] = npmInstallRegistries(networkRegion)
      const primaryLabel = primaryRegistry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
      // 策略钉死时 networkRegion 是归约值而非探测结果，"检测到"的措辞会撒谎。
      const regionLabel = store.read().mirrorPolicy
        ? '已按设置固定安装源顺序'
        : acceleratedDownloads > 0
        ? '已启用下载加速，优先使用官方源'
        : networkRegion === 'mainland-china'
          ? '检测到中国大陆网络'
          : networkRegion === 'outside-mainland-china'
            ? '检测到非中国大陆网络'
            : '未能识别网络区域，按国内网络处理'
      const action = `${regionLabel}，正在通过${primaryLabel}安装已校验版本 ${definition.packageName}@${trustedRelease.version}`
      sendInstallProgress(target, provider, 'started', action, undefined, { stage: 'download' })
      const transaction = managedNpmTransaction
      const npmUserConfig = managedNpmLayout?.userConfig ?? path.join(transaction, 'npmrc')
      if (!managedNpmLayout) {
        const handle = await fs.promises.open(npmUserConfig, 'wx', 0o600)
        await handle.close()
      }
      /**
       * The dependency-graph resolution and the package download are timed
       * separately. Sharing one budget meant a slow official resolution ate the
       * time the download still needed, and a legitimately slow resolution was
       * being killed at five minutes as if it had hung.
       */
      // 解析一次就够：加速开关在一次安装中途变化时，换代理反而会让已经建立
      // 的连接和重试落到两条不同的线路上。
      let npmProxyVariables: NodeJS.ProcessEnv | null = null
      const resolveNpmProxyVariables = async (): Promise<NodeJS.ProcessEnv> => {
        if (!npmProxyVariables) {
          try { npmProxyVariables = await resolveSubprocessProxyEnvironment() }
          catch { npmProxyVariables = {} }
        }
        return npmProxyVariables
      }
      // npm 认 https_proxy / http_proxy：电脑里留着指向没开的本机代理时，没开加速就一样
      // 装不上。同一次安装只判断一次，日志也只写一条。Linux 上照着网上教程把
      // `export http_proxy=…7890` 写进 ~/.profile 的很常见，同样要绕开（Linux 版拆分 ②）；
      // macOS 维持原样。
      let npmBaseEnvironment: Promise<NodeJS.ProcessEnv> | null = null
      const resolveNpmBaseEnvironment = (trustedOnly: boolean): Promise<NodeJS.ProcessEnv> => {
        if (!npmBaseEnvironment) {
          // 公司或安全软件装在这台电脑上的证书，npm 默认不认（system-certificate-trust.ts）。
          // 管理员身份那条路不加：trustedCommandEnvironment 会把它剥掉，这里也不补回去。
          const base = trustedOnly ? trustedCommandEnvironment() : withSystemCertificateTrust(commandEnvironment(process.env, nodeDirectories))
          npmBaseEnvironment = platform !== 'darwin' ? withoutDeadLoopbackProxies(base, provider) : Promise.resolve(base)
        }
        return npmBaseEnvironment
      }
      const executeNpm = async (
        argv: string[],
        cwd: string,
        cache: string,
        timeoutMs = npmDownloadTimeoutMs,
        signal?: AbortSignal,
      ) => {
        // 提权执行会对 argv 里的每个绝对路径做 realpath，路径不存在即判定为
        // 「位于用户可写目录」而拒绝。npm 自己会建缓存目录，但那发生在校验之后。
        await fs.promises.mkdir(cache, { recursive: true })
        const trustedOnly = process.platform === 'win32' && windowsExecutionMode === 'trusted-only'
        // 调用处自己的信号（下载卡住）和客户的取消，哪个先到都结束这次 npm；
        // 是哪一个由调用处分辨，取消照旧报「安装已取消」。
        const abortSignal = cancellation && signal
          ? AbortSignal.any([cancellation.signal, signal])
          : cancellation?.signal ?? signal
        return executeCommand({
          executable: npmExecutable,
          argv: [
            ...argv,
            `--cache=${cache}`,
            `--userconfig=${npmUserConfig}`,
            '--audit=false',
            '--fund=false',
          ],
          windowsPackageManager: 'npm',
        }, {
          env: {
            ...await resolveNpmBaseEnvironment(trustedOnly),
            ...await resolveNpmProxyVariables(),
          },
          trustedOnly,
          trustedPaths: managedNpmLayout
            ? [npmUserConfig, transaction]
            : undefined,
          ...(abortSignal ? { signal: abortSignal } : {}),
          cwd,
          timeoutMs,
          maxOutputBytes: 8 * 1024 * 1024,
          onOutput: ({ text }) => {
            const message = text.trim()
            if (message) sendInstallProgress(target, provider, 'output', message, undefined, { stage: 'raw-output' })
          },
        })
      }
      const assertCliNativePackageInstalled = async (packageRoot: string) => {
        const missing = await findMissingCliNativePackage(packageRoot, definition.packageName, platform)
        if (!missing) return
        runtimeLog?.log(
          'warn',
          'install',
          'cli.install.native-package-missing',
          `${definition.name} 的平台主程序包 ${missing} 没有装上（npm 跳过了下载失败的可选依赖）`,
          { provider },
        )
        throw new Error(cliNativePackageMissingMessage(definition.name))
      }
      const createResolutionManifest = async (directory: string) => {
        await fs.promises.mkdir(directory, { recursive: true })
        const manifestPath = path.join(directory, 'package.json')
        const handle = await fs.promises.open(manifestPath, 'wx', 0o600)
        try {
          await handle.writeFile(`${JSON.stringify({
            name: 'xingmang-cli-resolution',
            version: '1.0.0',
            private: true,
            dependencies: { [definition.packageName]: trustedRelease.version },
          }, null, 2)}\n`, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      /**
       * npm emits nothing during `--package-lock-only`, so without a heartbeat
       * the window sits on one static line for minutes and users conclude the
       * app has hung. The ticker only reports elapsed time; it never guesses at
       * a completion percentage it cannot know.
       */
      const resolveDependencyGraph = async (
        registry: string,
        resolution: string,
        cache: string,
      ) => {
        sendInstallProgress(target, provider, 'output', npmResolutionStartMessage(registry), undefined, { stage: 'download' })
        const startedAt = Date.now()
        const ticker = setInterval(() => {
          const elapsedMs = Date.now() - startedAt
          sendInstallProgress(
            target,
            provider,
            'output',
            npmResolutionHeartbeatMessage(registry, elapsedMs),
            undefined,
            { stage: 'download', elapsedMs },
          )
        }, npmResolutionHeartbeatMs)
        try {
          await executeNpm([
            'install',
            '--package-lock-only',
            '--ignore-scripts',
            '--omit=dev',
            `--registry=${registry}`,
          ], resolution, cache, npmResolutionTimeoutMs)
        } finally {
          clearInterval(ticker)
        }
      }

      const officialResolution = path.join(transaction, 'official-resolution')
      const officialCache = path.join(transaction, 'official-cache')
      await createResolutionManifest(officialResolution)
      try {
        await resolveDependencyGraph(npmOfficialRegistry, officialResolution, officialCache)
      } catch (error) {
        if (isInstallCancelledError(error)) throw error
        cancellation?.throwIfCancelled()
        throw new Error(await withToolCertificateHint(`${definition.name} 安装失败：npm 官方源：${describeNpmCommandFailure(error)}`))
      }
      const officialLock = await readBoundedUtf8File(
        path.join(officialResolution, 'package-lock.json'),
        maximumNpmPackageLockBytes,
        'npm 官方 package-lock.json',
      )
      assertNpmReleaseMatchesOfficialLock(trustedRelease, officialLock)
      const registries = npmInstallRegistries(networkRegion)
      const installErrors: string[] = []
      let installed = false
      let verification: Awaited<ReturnType<typeof inspectCliTool>> | null = null
      for (const [index, registry] of registries.entries()) {
        cancellation?.throwIfCancelled()
        if (index > 0) {
          sendInstallProgress(
            target,
            provider,
            'output',
            `${registries[0] === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'}安装失败，正在切换${registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'} ${registry}`,
            undefined,
            { stage: 'switch-route' },
          )
        }
        const attemptRoot = path.join(transaction, `attempt-${index}`)
        try {
          const resolution = path.join(attemptRoot, 'resolution')
          const cache = path.join(attemptRoot, 'cache')
          const attemptPrefix = managedNpmLayout
            ? path.join(attemptRoot, 'staged-prefix')
            : null
          await createResolutionManifest(resolution)
          await resolveDependencyGraph(registry, resolution, cache)
          const candidateLock = await readBoundedUtf8File(
            path.join(resolution, 'package-lock.json'),
            maximumNpmPackageLockBytes,
            `${registry === npmMirrorRegistry ? '国内镜像' : 'npm 官方'} package-lock.json`,
          )
          assertNpmPackageLocksEquivalent(
            officialLock,
            candidateLock,
            definition.packageName,
            trustedRelease.version,
          )
          sendInstallProgress(
            target,
            provider,
            'output',
            `${registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'}完整依赖图与官方 SHA-512 对账通过，正在下载校验包缓存`,
            undefined,
            { stage: 'verify' },
          )
          // 下载这一步看的是还在不在下，不是总共下了多久：网慢的客户以前满 5 分钟就被掐、换源
          // 从零再下，怎么点都装不上。这一轮的临时目录 3 分钟一点没变才算卡住、换下一个源，
          // 慢但一直在下的最多等 30 分钟（第三十七批 A）。
          const stallWatch = createNpmDownloadStallWatch(() => measureDirectoryBytes(attemptRoot))
          const downloadStartedAt = performance.now()
          // 同解析那一步：带上已用时，界面进度那一行就换成现成的「还在下载，已经等了……」，
          // 这句原话进安装日志；运行日志不记这种每隔几秒一条的（第三十七批 D）。
          const downloadTicker = setInterval(() => {
            const elapsedMs = Math.round(performance.now() - downloadStartedAt)
            sendInstallProgress(
              target,
              provider,
              'output',
              npmDownloadHeartbeatMessage(registry, elapsedMs),
              undefined,
              { stage: 'download', elapsedMs },
            )
          }, npmDownloadHeartbeatMs)
          try {
            await executeNpm([
              'ci',
              '--ignore-scripts',
              '--omit=dev',
              `--registry=${registry}`,
              '--replace-registry-host=always',
            ], resolution, cache, npmDownloadCeilingMs, stallWatch.signal)
          } catch (error) {
            if (!stallWatch.stalled) throw error
            runtimeLog?.log(
              'warn',
              'install',
              'cli.install.download-stalled',
              `${definition.name} 从${npmRegistryLabel(registry)}下载 ${formatElapsedDuration(npmDownloadStallTimeoutMs)}没有进展，已中止`,
              {
                provider,
                registry,
                elapsedMs: Math.round(performance.now() - downloadStartedAt),
                attemptBytes: stallWatch.bytes,
              },
            )
            throw new Error(npmDownloadTimedOutMessage, { cause: error })
          } finally {
            clearInterval(downloadTicker)
            stallWatch.stop()
          }
          // npm ci 跳过下载失败的平台主程序包也照样退出 0，所以下完就在它解出来的包里查。普通权限
          // 那条路没有暂存目录，后面 npm 直接写进正在用的工具目录，写完再查就晚了，旧版已经被盖掉；
          // 在这里查出缺了，记成这个源失败、换下一个源，旧版还没动（第二十八批 A）。Grok 的两条
          // npm 通道在自己的安装事务里核对。
          if (provider !== 'grok') {
            await assertCliNativePackageInstalled(
              path.join(resolution, 'node_modules', ...definition.packageName.split('/')),
            )
          }
          if (managedNpmLayout && attemptPrefix) {
            await fs.promises.cp(managedNpmLayout.prefix, attemptPrefix, {
              recursive: true,
              force: false,
              errorOnExist: true,
            })
          }
          const plan = buildCliMaintenancePlan(
            provider,
            npmExecutable,
            attemptPrefix ?? sameUserNpmPrefix?.prefix ?? null,
            trustedRelease.version,
            true,
            platform,
          )
          sendInstallProgress(target, provider, 'output', `${definition.name} 下载校验完成，正在安装到本机`, undefined, { stage: 'install' })
          const lifecycle = () => executeNpm([
            ...plan.argv,
            '--offline',
            `--registry=${registry}`,
          ], resolution, cache).then(() => undefined)
          if (provider === 'grok' && grokInstallStrategy === 'darwin-official-npm') {
            verification = await runDarwinGrokPostInstallTransaction({
              homeDirectory: os.homedir(),
              lifecycle,
              verify: async () => {
                const inspected = await inspectVerifiedDarwinGrokPostInstall({
                  homeDirectory: os.homedir(),
                  expectedVersion: trustedRelease.version,
                  runCommand: buildDarwinTrustedVerificationRunner(executeCommand),
                })
                if (!inspected.installation || inspected.status.version !== trustedRelease.version) {
                  throw new Error(`${definition.name} 安装后服务验证失败，已恢复更新前版本`)
                }
                return inspected
              },
            })
          } else if (provider === 'grok' && grokInstallStrategy === 'linux-official-npm') {
            // 核对用的主程序包就在这次 npm ci 的 resolution 目录里，事务结束前它都还在。
            verification = await runLinuxGrokPostInstallTransaction({
              homeDirectory: os.homedir(),
              lifecycle,
              verify: () => inspectVerifiedLinuxGrokPostInstall({
                homeDirectory: os.homedir(),
                expectedVersion: trustedRelease.version,
                resolutionDirectory: resolution,
                architecture: process.arch,
                runCommand: buildDarwinTrustedVerificationRunner(executeCommand),
              }),
            })
          } else {
            // 普通权限这条路没有暂存目录：npm 在正在用的目录里先挪开旧版、再解新包、跑安装脚本，取消是
            // 强行结束整棵进程树，它来不及挪回去，新旧两份都用不了。所以从这里起和暂存那条路换进去
            // 以后一样不让取消，前面下载、对账照样能取消（第二十八批 B）。
            const writesInPlace = !attemptPrefix
            if (writesInPlace) {
              cancellation?.throwIfCancelled()
              cancellation?.seal(managedPrefixSwapSealReason)
            }
            try {
              await lifecycle()
              // 在这一个源里就查：缺了就记成这个源失败，接着换下一个源再下一次，
              // 而不是带着装不全的程序走到替换托管目录那一步。
              const stagedPrefix = attemptPrefix ?? sameUserNpmPrefix?.prefix ?? null
              if (stagedPrefix) {
                await assertCliNativePackageInstalled(
                  managedCliPackageDirectory(stagedPrefix, definition.packageName, platform),
                )
              }
            } catch (error) {
              // 这个源没装成，换下一个源要重新下载，下载那段照样能取消。装成了就一直不让取消到结束：
              // 新版已经写进去了，这时再取消，界面会以为没装上。
              if (writesInPlace) cancellation?.unseal()
              throw error
            }
          }
          installPrefix = attemptPrefix
          installed = true
          break
        } catch (error) {
          if (isInstallCancelledError(error)) throw error
          cancellation?.throwIfCancelled()
          const detail = describeNpmCommandFailure(error)
          installErrors.push(
            `${registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'}：${redactCommandText(detail).replace(/\s+/g, ' ').trim().slice(0, 300) || '安装失败'}`,
          )
          // 这个源下了一半的东西先删掉再换源：下载最长能等 30 分钟，留到整次安装结束才删，
          // 盘快满时下一个源更容易写不下。删不掉就算了，结束时 finally 还会整个再删一次。
          await fs.promises.rm(attemptRoot, { recursive: true, force: true }).catch(() => undefined)
        }
      }
      if (!installed) {
        const detail = installErrors.join('；') || '所有 npm 源均不可用'
        // npm 替换正在运行的工具时报的是 EBUSY / EPERM,两者的原文都读不出「谁
        // 占着这个文件」。这里重新数一遍进程,数到了才改写成「文件被占用」。
        const occupied = await describeOccupiedCliFailure(provider, detail, detail, occupancyProbeRoot, updatingExistingInstall ? '更新' : '安装')
        throw new Error(occupied ?? await withToolCertificateHint(`${definition.name} 安装失败：${detail}`))
      }
      sendInstallProgress(target, provider, 'output', `${definition.name} 已安装，正在检查安装结果`, undefined, { stage: 'final-check' })
      invalidateCliUpdateCache(provider)
      const stagedManifest = installPrefix
        ? path.join(
            installPrefix,
            ...(platform !== 'win32' ? ['lib', 'node_modules'] : ['node_modules']),
            ...definition.packageName.split('/'),
            'package.json',
          )
        : null
      if (stagedManifest) {
        const stagedVersion = await readPackageManifestVersion(
          stagedManifest,
          `${definition.name} staged package.json`,
        )
        if (stagedVersion !== trustedRelease.version) {
          throw new Error(`${definition.name} 暂存安装验证失败：版本或 package.json 无效`)
        }
      }

      // 两条 npm 官方通道都在 postinstall 事务里核对过了（macOS 靠 codesign，Linux 靠逐字节对账）。
      const grokPostInstallVerified = provider === 'grok'
        && (grokInstallStrategy === 'darwin-official-npm' || grokInstallStrategy === 'linux-official-npm')
      if (managedNpmLayout && managedNpmTransaction && installPrefix) {
        cancellation?.seal(managedPrefixSwapSealReason)
        let promotion: ManagedNpmReplaceResult | null = null
        try {
          promotion = await replaceManagedNpmPrefixAtomically(
            managedNpmLayout.prefix,
            installPrefix,
            managedNpmTransaction,
            async () => {
              invalidateCliUpdateCache(provider)
              const promoted = await inspectCliTool(
                provider,
                npmExecutable,
                path.join(
                  managedNpmLayout!.prefix,
                  ...(platform !== 'win32' ? ['lib', 'node_modules'] : ['node_modules']),
                ),
              )
              if (
                !promoted.installation
                || promoted.status.version !== trustedRelease.version
                || !isManagedNpmInstallation(promoted.installation)
              ) {
                throw new Error(`${definition.name} 提交后验证失败，已恢复更新前版本`)
              }
              verification = promoted
            },
          )
        } catch (error) {
          // 回滚也没成的那一种不碰：ManagedNpmRollbackError 要原样传到外层（它的
          // preserveTransaction 决定事务目录留不留），它的原话也是渲染层不套
          // 安抚文案的依据。
          if (error instanceof ManagedNpmRollbackError) throw error
          const detail = error instanceof Error ? error.message : String(error)
          const occupied = await describeOccupiedCliFailure(
            provider,
            error,
            redactCommandText(detail).replace(/\s+/g, ' ').trim().slice(0, 300),
            occupancyProbeRoot,
            updatingExistingInstall ? '更新' : '安装',
          )
          if (!occupied) throw error
          throw new Error(occupied, { cause: error })
        }
        if (!promotion.backupRetired) {
          runtimeLog?.log(
            'warn',
            'install',
            'cli.install.backup-retire-failed',
            `${definition.name} 新版已检查通过，但旧版那份没能标成已换下；临时文件夹删完之前退出的话，下次装工具时会被退回旧版`,
            { provider },
          )
        }
      } else if (!grokPostInstallVerified) {
        const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npmExecutable)
        verification = await inspectCliTool(provider, npmExecutable, npmGlobalRoot)
        if (verification.installation?.source === 'npm' && verification.installation.packageRoot) {
          await assertCliNativePackageInstalled(verification.installation.packageRoot)
        }
      }
      if (!grokPostInstallVerified && (
        !verification?.installation
        || verification.status.version !== trustedRelease.version
        || (managedNpmLayout && !isManagedNpmInstallation(verification.installation))
      )) {
        throw new Error(`${definition.name} npm 命令已结束，但未在托管目录识别到有效安装和版本`)
      }
      // npm 每次安装都会把 .ps1 启动文件重新写回来，所以装完、更新完都要再清一遍。
      if (verification?.installation) await cliTerminalAccess.prepare({ provider, installation: verification.installation }, 'install')
      await recordCliUpdate(provider, versionBeforeUpdate, verification?.status.version ?? null, versionChoice.source === 'requested')
      sendInstallProgress(
        target,
        provider,
        'success',
        `${definition.name} 安装或更新完成（${verification!.status.version}）`,
      )
    } catch (error) {
      if (error instanceof ManagedNpmRollbackError) {
        preserveManagedNpmTransaction = error.preserveTransaction
      }
      // 取消是用户自己按的,不是安装失败:换成统一的中文文案,并且把底层
      // 「命令被中止」这类实现细节挡在外面,否则界面会像出了故障。
      if (isInstallCancelledError(error) || cancellation?.cancelled === true) {
        const cancelled = new InstallCancelledError(`${definition.name} 安装已取消`)
        sendInstallProgress(target, provider, 'error', cancelled.message)
        throw cancelled
      }
      const message = error instanceof Error ? error.message : String(error)
      sendInstallProgress(target, provider, 'error', message)
      throw error
    } finally {
      if (downloadedGrokBinary) await cleanupDownloadedGrokBinary(downloadedGrokBinary)
      if (managedNpmTransaction && !preserveManagedNpmTransaction) {
        // 几百 MB 的目录删起来要一会儿，安全软件、索引服务常在中途攥住刚解出来的文件：让 rm 自己
        // 等一等再删（同 install-leftovers.ts）。还删不掉的过 6 小时由那边清；新版检查通过的话，
        // 里面的旧版这时已经改名成 superseded-prefix，下次装工具时不会再被退回去。
        await fs.promises.rm(managedNpmTransaction, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
          .catch((error: unknown) => {
            runtimeLog?.log(
              'warn',
              'install',
              'cli.install.transaction-cleanup-failed',
              `${definition.name} 安装用的临时文件夹没删掉，之后会自动清理`,
              {
                provider,
                error: redactHomeDirectory(error instanceof Error ? error.message : String(error), providerRoots.userHome),
              },
            )
          })
      }
      installing.delete(provider)
    }
  }

  function installCli(provider: ProviderId, target: RendererMessageTarget, version?: string): Promise<void> {
    // 队列 key 刻意不含版本:同一个工具的两次安装必须串行(I11),
    // 让「更新」和「回到推荐版本」同时跑会互相看到半完成的全局目录。
    const key = `cli:install:${provider}`
    // 重复点击复用队列里的同一个 Promise,所以这里也不能再开一个取消句柄:
    // 后点的那次会把前一次的句柄挤掉,取消按钮就再也找不到正在跑的安装。
    // Windows 上 Claude Code 接着装 Git 的那一段句柄也还登记着(见 finishClaudeInstallWithGit),
    // 这时再装一次 Claude Code 会走到这里,另排一次取消不了的安装;界面上同一个工具
    // 一次只放一个安装(useToolbox 的 run 按工具加锁),碰不到。
    if (installCancellations.has(key)) {
      return installationQueue.enqueue(key, () => installCliOperation(provider, target, version))
    }
    // 句柄在入队之前登记:排在别人后面等待的那次安装也要能取消,
    // 否则用户只能干等前一个工具装完。
    const cancellation = installCancellations.begin(key)
    let started = false
    const finished = installationQueue.enqueue(
      key,
      () => {
        started = true
        return installCliOperation(provider, target, version, cancellation)
      },
      { signal: cancellation.signal },
    ).catch((error: unknown) => {
      if (started) throw error
      // 排着队时取消的那次直接出队，installCliOperation 没跑过：取消的那句和进度在这里补上，
      // 和跑起来以后取消一样。
      const cancelled = new InstallCancelledError(`${cliCatalog[provider].name} 安装已取消`)
      sendInstallProgress(target, provider, 'error', cancelled.message)
      throw cancelled
    })
    // 装好一次顺手清掉以前中途被打断的残留：这次自己的临时目录已经在 finally 里删了，
    // 剩下的只会是更早的。排在队列末尾，不拖慢这次安装的完成提示。
    void finished.then(() => cleanupInstallLeftovers(), () => undefined)
    // Windows 上 Claude Code 靠 Git 自带的 bash 跑技能和插件里的命令。Claude Code 自己
    // 那一项出队之后才排 Git：队列是全局串行的，在队列任务里再入队会互相等死。
    if (provider !== 'claude' || platform !== 'win32') return finished.finally(() => cancellation.release())
    return finishClaudeInstallWithGit(finished, cancellation, () => installGitAlongsideClaude(
      () => installGitRuntime(target, (progress) => sendInstallProgress(
        target, provider, 'output', progress.message, progress.percent ?? undefined)),
      (message) => sendInstallProgress(target, provider, 'output', message),
    ))
  }

  function resolveInstallLeftoverLocations(): InstallLeftoverLocation[] {
    let trustedCacheRoot: string | null = null
    try {
      trustedCacheRoot = trustedInstallerCacheRoot(process.env, platform)
    } catch {
      // ProgramData 解析不出来时安装本身也用不了那里，没有残留可清。
    }
    let managedNpmCache: string | null = null
    try {
      // 和装工具时准备托管目录（ensureManagedNpmLayout）用同一份环境，指的才是同一处。
      managedNpmCache = managedNpmCacheRoot(commandEnvironment(), platform)
    } catch {
      // 同上：解析不出来时托管安装也用不了，那里不会有更新留下的临时文件夹。
    }
    // 安装缓存和托管 npm 缓存都在 ProgramData\XingMangAI 底下。按管理员身份在那里删东西，要这次运行
    // 亲手加固、核过 ACL 的目录才算只有管理员能写（装、卸工具准备托管目录，或建安装用的临时目录时，
    // 会把整个 XingMangAI 加固一遍）。没核过的那一处可能是普通进程抢先建好、等着在删的时候换成联接的
    // （同 I8），这一轮先不扫，核过以后的那一轮再清：开机后那一轮一般还没核过，装完工具那一轮会清。
    if (platform === 'win32' && trustedCacheRoot && !isRegisteredTrustedManagedWindowsPath(trustedCacheRoot)) {
      trustedCacheRoot = null
    }
    if (platform === 'win32' && managedNpmCache && !isRegisteredTrustedManagedWindowsPath(managedNpmCache)) {
      managedNpmCache = null
    }
    return buildInstallLeftoverLocations({
      platform,
      windowsExecutionMode,
      temporaryDirectory: os.tmpdir(),
      trustedCacheRoot,
      managedNpmCacheRoot: managedNpmCache,
    })
  }

  function cleanupInstallLeftovers(): Promise<InstallLeftoverSweepResult> {
    const sweep = serviceOptions.sweepInstallLeftovers
    const empty: InstallLeftoverSweepResult = { removed: 0, freedBytes: 0, failed: 0 }
    if (!sweep) return Promise.resolve(empty)
    // 走安装队列（I11）：清理和安装、卸载互相等，谁也看不到对方做了一半的目录。
    return installationQueue.enqueue('maintenance:install-leftovers', async () => {
      const result = await sweep(resolveInstallLeftoverLocations())
      if (result.removed || result.failed) {
        runtimeLog?.log('info', 'install', 'install-leftovers.swept', `清掉以前没装完留下的下载 ${result.removed} 份，约 ${Math.round(result.freedBytes / 1024 / 1024)} MB`, {
          removed: result.removed,
          freedBytes: result.freedBytes,
          failed: result.failed,
        })
      }
      return result
    }).catch((error: unknown) => {
      runtimeLog?.log('warn', 'install', 'install-leftovers.failed', '清理以前没装完留下的下载时出错，下次再试', {
        error: error instanceof Error ? error.message : String(error),
      })
      return empty
    })
  }

  function cancelCliInstall(provider: ProviderId): InstallCancellationOutcome {
    return installCancellations.cancel(`cli:install:${provider}`)
  }

  async function removeDirectoryFromUserPath(directory: string): Promise<void> {
    if (process.platform !== 'win32') return
    const script = [
      '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$target = [IO.Path]::GetFullPath($env:XINGMANG_REMOVE_PATH).TrimEnd("\\")',
      '$current = [Environment]::GetEnvironmentVariable("Path", "User")',
      '$next = @(($current -split ";") | Where-Object {',
      '  if (-not $_) { return $false }',
      '  try { [IO.Path]::GetFullPath($_).TrimEnd("\\") -ine $target } catch { $true }',
      '}) -join ";"',
      '[Environment]::SetEnvironmentVariable("Path", $next, "User")',
    ].join('\n')
    await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      env: { ...trustedCommandEnvironment(), XINGMANG_REMOVE_PATH: directory },
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
    })
  }

  /** 返回命令入口已经删掉、但没能删掉的程序文件（只有 Linux 会有）。 */
  async function uninstallNativeGrok(installation: CliInstallation): Promise<string[]> {
    const cliEnvironment = commandEnvironment()
    const homeDirectory = cliEnvironment.HOME?.trim() || os.homedir()
    const userDirectory = path.resolve(homeDirectory, '.grok', 'bin')
    if (platform === 'darwin') {
      await uninstallVerifiedDarwinGrokInstallation({
        homeDirectory,
        installDirectory: installation.installDirectory,
        runCommand: buildDarwinTrustedVerificationRunner(executeCommand),
      })
      return []
    }
    if (platform === 'linux') {
      // npm postinstall 留下的是指向 grok-<版本> 的链接，按普通文件卸会被拒（Linux 版拆分 ③）。
      const result = await uninstallVerifiedLinuxGrokInstallation({
        homeDirectory,
        installDirectory: installation.installDirectory,
      })
      return result.retainedFiles
    }
    const managedDirectory = process.platform === 'win32'
      ? path.resolve(managedNativeProviderRoot('grok'))
      : null
    const actualKey = path.resolve(installation.installDirectory).toLowerCase()
    const managed = Boolean(managedDirectory && actualKey === managedDirectory.toLowerCase())
    const expectedDirectory = managed ? managedDirectory! : userDirectory
    const result = await uninstallVerifiedNativeCliFiles({
      actualDirectory: installation.installDirectory,
      expectedDirectory,
      fileNames: process.platform === 'win32'
        ? ['grok.exe', 'agent.exe', 'version.json']
        : ['grok', 'agent'],
      label: 'Grok CLI',
      platform: process.platform,
    })
    if (!managed) await removeDirectoryFromUserPath(result.directory)
    return []
  }

  // Q14：官方脚本装的 ~/.local/bin/claude 在 macOS/Linux 上是指向
  // ~/.local/share/claude/versions/<版本> 的符号链接，旧实现按普通文件校验直接拒绝；
  // 两个平台也都把 versions 里的程序本体留在了磁盘上。
  async function uninstallNativeClaude(installation: CliInstallation): Promise<string[]> {
    const result = await uninstallVerifiedClaudeNativeInstallation({
      homeDirectory: os.homedir(),
      installDirectory: installation.installDirectory,
      platform: process.platform,
    })
    return result.retainedVersionFiles
  }

  function isManagedNpmInstallation(installation: Pick<CliInstallation, 'npmPrefix'>): boolean {
    if (!installation.npmPrefix) return false
    const expected = managedNpmPrefix(commandEnvironment(), platform)
    return sameLocalPathIdentity(expected, installation.npmPrefix)
  }

  // 让用户在自己开的 PowerShell / cmd 里直接敲工具名就能用：删掉 npm 写的 .ps1
  // 启动文件（默认执行策略下它会报「禁止运行脚本」），装完时再确认工具目录在
  // 当前用户的 PATH 里。两步都只动当前用户自己的东西，不改执行策略、不提权；
  // 失败只记日志，不影响安装结果。
  const cliTerminalAccess = createCliTerminalAccess({
    platform,
    executionMode: windowsExecutionMode,
    isManaged: isManagedNpmInstallation,
    ensureUserPath: serviceOptions.ensureWindowsUserPath,
    ensureShellProfile: serviceOptions.ensureMacosShellProfile,
    syncTerminalCommands: serviceOptions.syncLinuxTerminalCommands,
    log: (level, event, message, detail) => runtimeLog?.log(level, 'install', event, message, detail),
    describeError: (error) => redactHomeDirectory(
      redactCommandText(error instanceof Error ? error.message : String(error)),
      providerRoots.userHome,
    ),
  })

  async function uninstallCliOperation(provider: ProviderId, options: CliUninstallOptions = {}): Promise<ToolUninstallResult> {
    if (installing.has(provider)) throw new Error(`${cliCatalog[provider].name} 正在安装、更新或卸载中`)
    installing.add(provider)
    try {
      // 同 inspectCliUpdate：卸载只用得上 npm 在哪，不为它的版本号多起一次 `npm --version`。
      const npmPath = await findInstalledExecutable('npm')
      const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npmPath)
      const initial = await inspectCliTool(provider, npmPath, npmGlobalRoot)
      if (!initial.status.installed || !initial.installation) {
        return { outcome: 'not-installed', previousVersion: null }
      }
      // 和装的时候问同一句、用同一个门槛（installCliOperation），只是提前到动手卸之前。
      if (options.reinstall) await assertInstallDiskSpace(`${cliCatalog[provider].name} 安装失败`)
      let current = initial
      const removedInstallations: string[] = []
      const retainedClaudeVersionFiles: string[] = []
      const retainedGrokFiles: string[] = []
      for (let attempt = 0; attempt < 8 && current.installation; attempt += 1) {
        const installation = current.installation
        const uninstall = current.status.uninstall
          ?? cliUninstallCapability(provider, installation, { platform, windowsExecutionMode })
        if (!uninstall.available) {
          throw new Error([
            uninstall.reason,
            uninstall.manualCommand ? `请在${platform === 'win32' ? '普通 PowerShell' : '终端'}中运行：${uninstall.manualCommand}` : null,
          ].filter(Boolean).join('；'))
        }
        if (uninstall.delegated) {
          // 包自带的卸载脚本位于用户可写目录，绝不能拿主进程的管理员令牌去跑。
          if (!uninstall.manualCommand) throw new Error('缺少可执行的卸载命令')
          const name = cliCatalog[provider].name
          await launchUnelevatedCommandWindow({
            commandLine: uninstall.manualCommand,
            // 窗口里的字说中文（已知33）；中间卸载程序自己吐的几行还是英文。
            text: {
              title: `星芒：卸载 ${name}`,
              running: `正在卸载 ${name}，请稍等，别关这个窗口。`,
              succeeded: '卸载完成。现在可以关掉这个窗口，回星芒点「重新检测」。',
              failed: '卸载没有完成（错误代码 {code}）。关掉这个窗口，回星芒点「重新检测」看看；还不行请找客服。',
            },
            machinePaths: resolveWindowsMachinePaths(),
          })
          return { outcome: 'delegated', previousVersion: initial.status.version }
        }
        const managedInstallation = isManagedNpmInstallation(installation)
        // isManagedNpmInstallation admits darwin, but the trusted resolution below is
        // Windows-only in effect: findExecutable drops additionalPaths on the trusted
        // branch, and the darwin trusted PATH is whatever the caller inherited — for a
        // Finder-launched build that is launchd's, which contains no npm. The managed
        // uninstall then failed to resolve npm at all. The sibling call twelve lines
        // below already gates on win32; this one now matches it.
        const npmExecutable = managedInstallation && platform === 'win32'
          ? await findExecutable('npm', {
              env: trustedCommandEnvironment(),
              windowsPackageManagers: ['npm'],
              trustedOnly: true,
            })
          : await findNpmExecutable(commandEnvironment(), [installation.commandPath])
            ?? npmPath
        const plan = buildCliUninstallPlan(provider, installation, npmExecutable)
        if (plan.kind === 'npm-uninstall') {
          const layout = managedInstallation ? await ensureManagedNpmLayout() : null
          const cache = layout ? await createManagedNpmCache(layout) : null
          try {
            const trustedOnly = process.platform === 'win32' && windowsExecutionMode === 'trusted-only'
            await runCommand({
              executable: plan.executable,
              argv: layout && cache
                ? [
                    ...plan.argv,
                    `--cache=${cache}`,
                    `--userconfig=${layout.userConfig}`,
                    '--audit=false',
                    '--fund=false',
                  ]
                : plan.argv,
              windowsPackageManager: plan.windowsPackageManager,
            }, {
              env: trustedOnly ? trustedCommandEnvironment() : commandEnvironment(),
              trustedOnly,
              trustedPaths: layout && cache ? [layout.userConfig, cache] : undefined,
              timeoutMs: 2 * 60_000,
              maxOutputBytes: 4 * 1024 * 1024,
            })
          } catch (error) {
            // 工具开着时 Windows 锁着它自己的文件，npm 挪不开包目录，报 EPERM / EBUSY 后原样退回。
            // 原话只剩「命令执行失败（退出码 1）：node.exe」，客户看不出是工具开着（第三十三批 C），
            // 所以和安装、更新一样接上 npm 的要点，再数一遍这个工具的进程。cause 用 Object.assign
            // 挂成可枚举的：运行日志只记错误的可枚举字段（runtime-log.ts 的 sanitizeValue），
            // npm 的原始输出要跟着进日志给客服看。
            // Mac 不数：那边挪得动、删得掉正开着的程序文件，EPERM / EACCES 只会是权限不够（比如
            // 用 sudo 装进 /usr/local 的那份），这时数到进程就会叫客户去关窗口，关了照样卸不掉。
            // Linux 的进程检测本来就回 unsupported。
            const detail = describeNpmUninstallFailure(error)
            const occupied = await describeOccupiedCliFailure(
              provider,
              detail,
              detail,
              platform === 'darwin' ? null : plan.packageRoot,
              '卸载',
            )
            throw Object.assign(new Error(occupied ?? `${cliCatalog[provider].name} 卸载失败：${detail}`), { cause: error })
          } finally {
            if (cache) await fs.promises.rm(cache, { recursive: true, force: true }).catch(() => undefined)
          }
          if (fs.existsSync(plan.packageRoot)) {
            throw new Error(`${cliCatalog[provider].name} 的 npm 包目录仍然存在，卸载未完成`)
          }
        } else if (plan.kind === 'grok-native') {
          try {
            retainedGrokFiles.push(...await uninstallNativeGrok(installation))
          } catch (error) {
            // Linux 和 macOS 一样：安全核对没过就交给客户手动卸，并说清为什么。
            if (platform === 'darwin' || platform === 'linux') {
              return grokManualUninstallResult(initial.status.version, error)
            }
            throw error
          }
        } else {
          retainedClaudeVersionFiles.push(...await uninstallNativeClaude(installation))
        }
        removedInstallations.push(installation.installDirectory)
        current = await inspectCliTool(provider, npmPath, npmGlobalRoot)
      }
      if (current.status.installed) {
        const removed = removedInstallations.length
          ? `已移除 ${removedInstallations.length} 个安装：${removedInstallations.join('；')}。`
          : '未移除任何安装。'
        const remaining = current.installation?.installDirectory ?? current.status.path ?? '未知目录'
        throw new Error(`${removed}仍检测到 ${cliCatalog[provider].name}：${remaining}`)
      }
      invalidateCliUpdateCache(provider)
      // Linux：删掉这个工具的小启动器，星芒装的一个都不剩时把终端启动设置里加的几行也去掉。
      void cliTerminalAccess.release(provider)
      const retainedReason = buildClaudeRetainedVersionFilesReason(retainedClaudeVersionFiles, process.platform)
      if (retainedReason) {
        return {
          outcome: 'manual-required',
          previousVersion: initial.status.version,
          error: retainedReason,
          manualHelp: {
            reason: retainedReason,
            manualCommand: buildClaudeRetainedVersionFilesCommand(retainedClaudeVersionFiles, process.platform),
          },
        }
      }
      const retainedGrokReason = buildLinuxGrokRetainedFilesReason(retainedGrokFiles)
      if (retainedGrokReason) {
        return {
          outcome: 'manual-required',
          previousVersion: initial.status.version,
          error: retainedGrokReason,
          manualHelp: {
            reason: retainedGrokReason,
            manualCommand: buildLinuxGrokRetainedFilesCommand(retainedGrokFiles),
          },
        }
      }
      return { outcome: 'uninstalled', previousVersion: initial.status.version }
    } finally {
      installing.delete(provider)
    }
  }

  function uninstallCli(provider: ProviderId, options: CliUninstallOptions = {}): Promise<ToolUninstallResult> {
    const finished = installationQueue.enqueue(`cli:uninstall:${provider}`, () => uninstallCliOperation(provider, options))
    // 卸掉命令行不会让谁读不进型号名单，只是下次写名单时要重新看装没装。
    if (provider === 'codex') void finished.then(forgetCodexModelCatalogReaders, forgetCodexModelCatalogReaders)
    return finished
  }

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
    assertInstallDiskSpace,
    // 官方包在海外：Mac 上那次下载、Windows 上商店没走通后的官网离线安装包，都和 OpenCode
    // 一样临时接上下载线路。Windows 的国内镜像那一路用不着它。
    withDownloadRoute: (operation) => withDownloadAcceleration(null, operation),
    userHome: providerRoots.userHome,
    // 中文增强没开起来时，启动那边改走普通启动，只往控制台打一句，打包版不留控制台；原错误（连同 PowerShell 那层）记在这一条里。
    activateCodexDesktopWithCdp: withCodexDesktopCdpFailureReport(activateCodexDesktopWithCdp, (error) => runtimeLog?.log(
      'warn', 'system', 'codex-desktop.chinese-launch.failed', 'Codex 桌面端中文增强启动没成，改走普通启动', { error },
    )),
  })

  async function installCodexDesktop(target: RendererMessageTarget): Promise<CodexDesktopInstallResult> {
    let result: CodexDesktopInstallResult
    try {
      result = await installCodexDesktopOperation(target)
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
    launchOptions: { injectChinese?: boolean } = {},
  ): Promise<CodexDesktopLaunchResult> {
    // Configs created before the permission picker was introduced often omit
    // both legacy fields. Add only missing defaults so a mirror-installed
    // Desktop gets the same interactive baseline as a local installation.
    try {
      // Only normalize configs managed by Xingmang. An official/custom Codex
      // profile is user-owned and must remain byte-for-byte untouched here.
      if (inspectNativeProviderConfig('codex').matchesRelay) {
        ensureCodexPermissionDefaults(providerRoots)
      }
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
          await writeCodexDesktopLocale({ codexHome: providerRoots.codexHome }, 'zh-CN')
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
        const trust = trustManagedWorkspace(provider, providerRoots, workspace)
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
    // Grok 按 PATH 挑跑钩子的 shell：补上注册表里新加的那几段，与 expectedGrokWindowsShell 推的是同一份 PATH。
    // 只在不跨提权边界时补；trusted-only 的终端 PATH 由 trustedCommandEnvironment 重建，不收用户可写的目录（I2）。
    const providerEnv = provider === 'grok' && platform === 'win32' && windowsExecutionMode === 'same-user'
      ? withAppendedWindowsPath(providerEnvironment(provider), windowsLivePath)
      : providerEnvironment(provider)
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
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`未能打开 ${definition.name}：${detail || '请查看反馈与诊断日志'}`)
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
        await launchMacosTerminal(buildDarwinCliLaunchPlan(
          {
            ...command,
            argv: cliLaunchArgv(provider, command.argv, mode, { installedVersion: installedStatus.version, resumeSessionId }),
          },
          workspace,
          withSystemCertificateTrust(providerEnv),
        ))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        // Windows、Linux 另记一条 terminal.failed；Mac 上 open 交回来的退出码和原话挂在 cause 上，
        // 随这次失败一起进运行日志。
        throw new Error(`未能打开 ${definition.name}：${detail || '请查看反馈与诊断日志'}`, { cause: error })
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
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`未能打开 ${definition.name}：${detail || '请查看反馈与诊断日志'}`)
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
  ): Promise<CliLaunchResult> {
    return installationQueue.enqueue(
      buildCliLaunchQueueKey(provider, workspace, mode, resumeSessionId),
      async () => ({
        ...await launchProviderOperation(provider, workspace, mode, resumeSessionId),
        rememberedWorkspace: rememberedWorkspaceFor(store.read().workspace),
      }),
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
    const result = trustCodexWorkspace(providerRoots, workspace)
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
    if (changed) await writeCodexDesktopLocale({ codexHome: providerRoots.codexHome }, locale)
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
    options: { bypassCache?: boolean; site?: RelaySite } = {},
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
    try {
      const response = await (serviceOptions.relayFetch ?? fetch)(`${relayApiProbeBaseUrl(activeSite)}/v1/models`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      })
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
        const statusMessage = `模型查询失败，服务返回 ${response.status}`
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
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('模型查询超时，请检查网络后重试')
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
        if (owner) await externalOwnership.write(tool, owner, activeSite.providerBaseUrls.claude, apiKey)
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
      if (owner) await externalOwnership.write(tool, owner, activeSite.providerBaseUrls.codex, apiKey)
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
  async function followExternalClientRoutes(statuses: readonly ExternalClientRuntimeStatus[]): Promise<ExternalClientStatus[]> {
    const describe = () => Promise.all(statuses.map(describeExternalClient))
    const to = relayRouting.selection(activeRelaySite().id)
    if (to === undefined) return describe()
    const work = async () => {
      const clients = await describe()
      // 已经在当前线路上的不用再读一遍（Windows 商店版读 Claude Desktop 配置要起一次 PowerShell）；
      // 没装上的看不出开没开，不碰。
      const candidates = statuses.flatMap((status) => {
        const client = clients.find((entry) => entry.tool === status.tool)
        return client && status.installed && !status.detectionError && client.configurationSource === 'other' ? [{ status, client }] : []
      })
      const updated = new Map<ExternalToolId, ExternalClientStatus>()
      for (const { status, client } of candidates) {
        try {
          const next = await followExternalClientRoute(status, client, to)
          if (next) updated.set(status.tool, next)
        } catch (error) {
          runtimeLog?.log('warn', 'config', 'external-client.route.failed', `${externalClientNames[status.tool]} 的连接线路这次没换成，下次检测再试`, {
            tool: status.tool, to, reason: credentialFailureReason(error),
          })
        }
      }
      return clients.map((client) => updated.get(client.tool) ?? client)
    }
    const task = externalConfigQueue.then(work, work)
    externalConfigQueue = task.catch(() => undefined)
    return task
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
      await externalOwnership.write(tool, owner, baseUrl, found.apiKey)
      runtimeLog?.log('info', 'config', 'external-client.route.recorded', `${name} 已在当前连接线路上，补记归属`, detail)
      return await describeExternalClient(status)
    }
    if (status.running) {
      runtimeLog?.log('info', 'config', 'external-client.route.deferred', `${name} 还开着，连接线路暂未改动`, detail)
      return { ...client, routePending: true }
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
      await externalOwnership.write(tool, owner, baseUrl, found.apiKey)
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
   * 这个站登记过的线路，回 null。只认登记的主地址：星芒保存时只写它，别名不会有归属记录。
   * 主进程内部专用，密钥永不跨 IPC（I3）。
   */
  async function externalClientRouteCredential(
    status: ExternalClientRuntimeStatus,
    activeSite: RelaySite,
    owner: string,
  ): Promise<{ from: RelayEndpointId; baseUrl: string; apiKey: string; model: string | null } | null> {
    const provider = status.tool === 'claudeDesktop' ? 'claude' : 'codex'
    const current = activeSite.providerBaseUrls[provider]
    const routes = relaySiteEndpointChoices(activeSite.id)
      .map((endpoint) => ({ from: endpoint.id, baseUrl: relayProviderBaseUrls(activeSite.id, endpoint.id)[provider] }))
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
            ...ccSwitchLeftoverField(resolveCcSwitchLeftover(current, ccSwitchInstalled)),
            ...cliHooksSummaryFields(hooks),
            ...cliHooksAutoRepairedField(!previewOnboarding && autoRepairedCliHooks.has(id), hooks?.stale === true),
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
      if (after.stale) throw new Error('提醒设置没修好，原来的设置已备份，可以在「备份」里找回')
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
    for (const provider of providerIds) {
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
    return serializeConfigWrite(async () => {
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
      const automaticRouteMigration = ownership?.automatic === true
        && relayRouting.selection(activeSite.id) !== undefined && previousRoute !== null
        && previousRoute.providerBaseUrls[payload.provider] !== activeSite.providerBaseUrls[payload.provider]
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
      if (automaticRouteMigration) {
        // A Start Menu launch can happen while the models request is in flight.
        // Probe after asynchronous preparation, before invalidating ownership or
        // changing any native file. This is a process snapshot, not an OS lock.
        let stopped = false
        try {
          const report = await (serviceOptions.inspectRunningToolsForTemplateFill ?? inspectRunningTools)([payload.provider])
          stopped = !report.running.includes(payload.provider) && !report.unknown.includes(payload.provider)
            && (payload.provider !== 'codex' || report.codexDesktopRunning === false)
        } catch {
          // A failed probe must preserve the account's working configuration.
        }
        if (!stopped) throw new Error('工具可能还开着，已保留原配置；请完全退出工具后重新同步连接线路')
      }
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
      assertOwner()
      await store.setOfficialProvider(payload.provider, false)
      if (payload.provider === 'codex') await applyXingmangAiSkillForCodexAccount(false)
      return result
    })
  }

  // 打开前的模型核对（tool-model-check.ts）。只认本软件用当前账号写的配置：官方账号、
  // 手填、被改动过的都不碰；刷新菜单走 saveConfig 的自动写入那道闸，与开机同步 Key
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
    // 写入当中认人时不看来源记录：saveConfig 写之前会先把记录改成「手动」（写失败就停在受
    // 保护的状态），按记录认人的话刷新永远在写到一半时作废，记录还留在「手动」（#562 起
    // Claude Code 的菜单就是这样一次没刷成过）。来源是不是当前账号，由 saveConfig 的自动写入
    // 那道闸进锁时自己把关。
    identity: (provider) => modelCheckTarget(provider, false)?.identity ?? null,
    listModels: (apiKey) => fetchAvailableModels(apiKey, { bypassCache: true }),
    pickerOutdated: (provider, models, model) => provider === 'claude'
      ? claudeModelPickerNeedsRefresh(models, model, providerRoots)
      : codexModelCatalogOutdated(models, model),
    refreshPicker: async (provider, model, assertCurrent) => {
      await saveConfig({ provider, apiKey: '', model, mode: 'merge' }, false, assertCurrent, { source: 'account', automatic: true })
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
    const due = round.providers.filter(outdated)
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
          if ((serviceOptions.getExternalClientAccountId?.() ?? null) !== owner || !outdated(provider)) return false
          const site = providerRelaySite(provider, inspectNativeProviderConfig(provider))
          // 已经齐了（多半是新模板写的，只是记录里还没有版本号）就只记版本号，不留备份。
          // 真要补才先做一份与保存配置同样的整套备份，「备份」页里能找回补之前的样子；
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
    void toolModelChecker.syncPicker('codex', { beforeRefresh: () => backup?.('codex') }).catch(() => undefined)
    return false
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
      : { retry: false, providers: providerIds, codexModelCatalog: true }
    const stopped = templateFillWaits.signal
    let result: ToolTemplateFillResult
    try {
      result = await fillToolTemplateDefaults(backup, round, stopped)
    } catch (error) {
      void syncCodexModelCatalog(backup, round, stopped).catch(() => false)
      throw error
    }
    const catalogOwed = await syncCodexModelCatalog(backup, round, stopped).catch(() => false)
    const skipped = result.pending ?? []
    templateFillDebt = owner && (skipped.length || catalogOwed) ? { owner, providers: skipped, codexModelCatalog: catalogOwed } : null
    const pending = providerIds.filter((provider) => skipped.includes(provider) || (provider === 'codex' && catalogOwed))
    // 客服看报告分得清是工具开着没补，还是给换账号让了路。
    if (stopped.aborted) runtimeLog?.log('info', 'config', 'template-defaults.stopped', '要换账号了，补设置不再等本机检测，没补的下次再补', { pending, ...(round.retry ? { retry: true } : {}) })
    return pending.length ? { filled: result.filled, pending } : { filled: result.filled }
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
      throw new Error(`Claude Code 原来登录留下的官方 Key 没能挪开，配置没有改动：${reason}`)
    }
  }

  /** 放回挪开的官方 Key；失败抛错，回滚方据此知道恢复不完整。返回是否改动了文件。 */
  function restoreOfficialCredentialsNow(): boolean {
    try {
      return restoreClaudeConsoleKey(providerRoots)
    } catch (error) {
      const reason = credentialFailureReason(error)
      runtimeLog?.log('warn', 'config', 'official-credentials.restore-failed', 'Claude Code 的官方 Console Key 没能放回原处', { provider: 'claude', reason })
      throw new Error(`Claude Code 原来的官方 Key 没能放回原处：${reason}`)
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

  async function adoptRestoredConfig(provider: ProviderId, isAccountKey: (apiKey: string) => boolean): Promise<void> {
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
    readStoredConfig: () => ({ ...store.read(), activeRelayEndpointIds: { ...relayRouting.activeEndpointIds },
      ...(serviceOptions.getRelaySiteId ? { relaySiteId: serviceOptions.getRelaySiteId() } : {}) }),
    updateStoredConfig: async (update) => ({ ...await store.update(update), activeRelayEndpointIds: { ...relayRouting.activeEndpointIds } }),
    inspectCodexReadiness,
    getConfig: buildConfigSummary,
    revealApiKey,
    saveConfig,
    repairCliHooks,
    autoRepairStaleCliHooks,
    switchToOfficialAccount,
    setOfficialSourcePreference,
    restoreOfficialCredentials,
    inspectOfficialLogin: (provider) => inspectOfficialLogin(provider, providerRoots),
    adoptRestoredConfig,
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
    inspectInstallationQueue: () => installationQueue.snapshot(),
    onInstallationQueueChange: (listener) => installationQueue.onChange(listener),
    cleanupInstallLeftovers,
  }
}
