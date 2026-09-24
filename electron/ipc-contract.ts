import type { AppSettings, AppSettingsUpdate, AppTheme as StoredAppTheme } from './app-settings'
import type { WindowCloseReport } from './window-close-query'
import type { AiChatStreamErrorCode as MainAiChatStreamErrorCode } from './ai-chat-service'
import type { ExternalDeepLink } from './external-deep-links'
import type { SavedAccountSummary } from './saved-accounts'
import type {
  ConfigBackupPreview as StoredConfigBackupPreview,
  ConfigBackupReason,
  ConfigBackupSummary as StoredConfigBackupSummary,
  ConfigRestoreResult,
} from './backups'
import type { ProviderId as CatalogProviderId } from './catalog'
import type { CliLaunchMode as MainCliLaunchMode } from './tool-installation'
import type {
  ExternalToolId,
} from './external-tool-config'
export type { ExternalToolConfigOptions, ExternalToolConfigSaveResult, ExternalToolId } from './external-tool-config'
import type { ExternalClientConfigRequest, ExternalClientConfigResult, ExternalClientStatus, ExternalClientInstallProgress } from './external-client-contract'
import type { ExternalClientCheckResult } from './external-client-connection'
export type { ExternalClientCheckResult } from './external-client-connection'
export type { ExternalClientConfigRequest, ExternalClientConfigResult, ExternalClientCredential, ExternalClientStatus, ExternalClientRuntimeStatus, ExternalClientConnectionStatus, ExternalClientInstallProgress } from './external-client-contract'
import type {
  ManagedCliConfigurationOutcome,
  ManagedCliKeySyncSummary,
} from './account-cli-provisioner'
import type {
  AddMarketplaceInput,
  AddMcpInput,
  ImportSkillInput,
  MarketplaceDto,
  McpServerDto,
  PluginCatalogDto,
  PluginDto,
  RepositoryContext as CodexRepositoryContext,
  SkillDto,
} from './codex-extensions'
import type {
  ProviderExtensionMutation,
  ProviderExtensionsSnapshot,
  ProviderMcpHealthReport,
} from './provider-extensions'
import type {
  CodexSessionDetail,
  CodexSessionExportResult,
  CodexSessionListQuery,
  CodexSessionMutationResult,
  CodexSessionPage,
  CodexSessionSummary,
  SessionArchiveFilter as CodexSessionArchiveFilter,
} from './codex-sessions'
import type {
  ProviderSessionDetail,
  ProviderSessionExportResult,
  ProviderSessionListQuery,
  ProviderSessionPage,
  ProviderSessionProvider,
  ProviderSessionSummary,
} from './provider-sessions'
import type {
  CodexWorkspacePermissionStatus as MainCodexWorkspacePermissionStatus,
  CodexWorkspacePermissionWriteResult as MainCodexWorkspacePermissionWriteResult,
  NativeConfigSummary,
  NativeConfigSaveMode,
  NativeConfigSaveResult,
} from './config-files'
import type {
  CodexDesktopLocale as MainCodexDesktopLocale,
  CodexDesktopLocaleResult as MainCodexDesktopLocaleResult,
  CodexDesktopLocaleStatus as MainCodexDesktopLocaleStatus,
} from './codex-desktop-locale'
import type {
  DiagnosticState as MainDiagnosticState,
  DiagnosticsReport as MainDiagnosticsReport,
  DiagnosticsRunOptions as MainDiagnosticsRunOptions,
} from './diagnostics'
import type { CliVersionAdvice as MainCliVersionAdvice } from './cli-verified-versions'
import type { AccountSourceSwitchResult, AccountSourceTarget } from './account-source-switch'
export type { AccountSourceSwitchResult, AccountSourceTarget } from './account-source-switch'
import type { RunningToolsReport } from './running-tools'
export type { RunningToolsReport } from './running-tools'
import type {
  ConnectionCheckLayer as MainConnectionCheckLayer,
  ConnectionCheckResult as MainConnectionCheckResult,
  ConnectionProbeReport as MainConnectionProbeReport,
} from './connection-check'
import type {
  AppConfigSummary as MainAppConfigSummary,
  CliLaunchResult as MainCliLaunchResult,
  CliStatus as MainCliStatus,
  CodexDesktopLaunchMode as MainCodexDesktopLaunchMode,
  CodexDesktopLaunchResult as MainCodexDesktopLaunchResult,
  CodexReadinessStatus as MainCodexReadinessStatus,
  CodexSetupStatus as MainCodexSetupStatus,
  ConfigSavePayload,
  DesktopAppStatus as MainDesktopAppStatus,
  OfficialChatGptAccount as MainOfficialChatGptAccount,
  OfficialChatGptWindow as MainOfficialChatGptWindow,
  SystemSnapshot as MainSystemSnapshot,
  SystemScanOptions as MainSystemScanOptions,
  ToolStatus as MainToolStatus,
  ToolUninstallResult as MainToolUninstallResult,
} from './system-service'
import type {
  InstalledRelease as MainInstalledRelease,
  UpdateFailedStep as MainUpdateFailedStep,
  UpdatePhase as MainUpdatePhase,
  UpdateSnapshot as MainUpdateSnapshot,
} from './updater'
import type {
  NodeRuntimeInstallProgress as MainNodeRuntimeInstallProgress,
  NodeRuntimeInstallResult as MainNodeRuntimeInstallResult,
} from './node-runtime'
import type {
  PythonRuntimeInstallProgress as MainPythonRuntimeInstallProgress,
  PythonRuntimeInstallResult as MainPythonRuntimeInstallResult,
} from './python-runtime'
import type {
  RuntimeLogEntry as MainRuntimeLogEntry,
  RuntimeLogSnapshot as MainRuntimeLogSnapshot,
} from './runtime-log'
import type { PlatformCapabilities as MainPlatformCapabilities } from './platform-capabilities'
import type {
  NewApiAccountKey,
  NewApiAccountKeyCreateInput,
  NewApiAccountKeysPage,
  NewApiAccountKeysQuery,
  NewApiAccountKeyUpdateInput,
  NewApiAccountProfile,
  NewApiAccountProfileDetail,
  NewApiAccountStatus,
  NewApiAccountUsagePage,
  NewApiAccountUsageQuery,
  NewApiAccountUsageRecord,
  NewApiAccountDashboardData,
  NewApiAccountDashboardQuery,
  NewApiAccountDashboardRecord,
  NewApiAccountTaskPage,
  NewApiAccountTaskQuery,
  NewApiAccountTaskRecord,
  NewApiAffiliateTransferInput,
  NewApiBalance,
  NewApiChangePasswordInput,
  NewApiChangePasswordResult,
  NewApiLegalDocument,
  NewApiLegalDocumentKind,
  NewApiLoginInput,
  NewApiLoginResult,
  NewApiLoginSession,
  NewApiDisplayNameUpdateInput,
  NewApiProfileUpdateResult,
  NewApiRedemptionResult,
  NewApiRegisterInput,
  NewApiResetPasswordInput,
  NewApiResetPasswordResult,
  NewApiRevokeLoginSessionResult,
  NewApiRevokeOtherLoginSessionsResult,
  NewApiSessionState,
  NewApiSubscriptionPlan,
  NewApiBillingPreference,
  NewApiSubscriptionPaymentInput,
  NewApiSubscriptionPurchaseResult,
  NewApiSubscriptionSelf,
  NewApiTopupAmountInput,
  NewApiTopupAmountQuote,
  NewApiTopupInfo,
  NewApiTopupOrdersPage,
  NewApiTopupOrdersQuery,
  NewApiTopupPaymentInput,
  NewApiUsableGroup,
} from './new-api-client'

export { managedCliKeyProfiles, providerIds } from './catalog'
// Zero-Node-dependency value export, same precedent as providerIds above
// (I6) -- relay-sites.ts only imports from catalog.ts, itself zero-dep.
export {
  defaultRelaySiteId,
  privacyPolicyUrl,
  relaySites,
  resolveRelaySite,
  resolveSupportServiceUrl,
  supportServiceUrl,
  userAgreementUrl,
} from './relay-sites'

export type ProviderId = CatalogProviderId
export type { RelaySite } from './relay-sites'
export type ConfigSaveMode = NativeConfigSaveMode
export type CodexDesktopLaunchMode = MainCodexDesktopLaunchMode
export type CliLaunchMode = MainCliLaunchMode
export type AppWindowMode = 'onboarding' | 'dashboard'
export type AppTheme = StoredAppTheme
export interface WindowCapabilities {
  tray: boolean
  notifications: boolean
  // 主进程按本机内存与 CPU 判断，只用来让界面背景少画一点；缺省 = 旧行为（照常动画）。
  lowEndDevice?: boolean
}
export type { ExternalDeepLink } from './external-deep-links'
export interface FeedbackReportPreview { id: string; text: string; entries: number }
export type UpdatePhase = MainUpdatePhase
export type UpdateFailedStep = MainUpdateFailedStep
export type InstalledRelease = MainInstalledRelease
export type UpdateSnapshot = MainUpdateSnapshot
export type SessionArchiveFilter = CodexSessionArchiveFilter
export type SessionListQuery = CodexSessionListQuery
export type SessionSummary = CodexSessionSummary
export type SessionPageResult = CodexSessionPage
export type SessionDetailResult = CodexSessionDetail
export type SessionMutationResult = CodexSessionMutationResult
export type SessionExportResult = CodexSessionExportResult
export type MultiProviderSessionProvider = ProviderSessionProvider
export type MultiProviderSessionListQuery = ProviderSessionListQuery
export type MultiProviderSessionSummary = ProviderSessionSummary
export type MultiProviderSessionPage = ProviderSessionPage
export type MultiProviderSessionDetail = ProviderSessionDetail
export type MultiProviderSessionExportResult = ProviderSessionExportResult
export type ToolStatus = MainToolStatus
export type CliStatus = MainCliStatus
export type CliVersionAdvice = MainCliVersionAdvice
export type DesktopAppStatus = MainDesktopAppStatus
export type CodexDesktopLocale = MainCodexDesktopLocale
export type CodexDesktopLocaleStatus = MainCodexDesktopLocaleStatus
export type CodexDesktopLocaleResult = MainCodexDesktopLocaleResult
export type SystemSnapshot = MainSystemSnapshot
export type SystemScanOptions = MainSystemScanOptions
export type OfficialChatGptAccount = MainOfficialChatGptAccount
export type OfficialChatGptWindow = MainOfficialChatGptWindow
export type CodexDesktopLaunchResult = MainCodexDesktopLaunchResult
export type CliLaunchResult = MainCliLaunchResult
export type ToolUninstallResult = MainToolUninstallResult
export type AppSettingsV2 = AppSettings
export type AppSettingsV2Update = AppSettingsUpdate
export type SavedAccount = SavedAccountSummary
export type RepositoryContext = CodexRepositoryContext

/** `workspace:choose` 的可选参数。渲染层只能说「要新建」，路径永远由主进程决定。 */
export interface ChooseWorkspaceOptions {
  createStarter?: boolean
}
export type DiagnosticState = MainDiagnosticState
export type DiagnosticsReport = MainDiagnosticsReport
export type DiagnosticsRunOptions = MainDiagnosticsRunOptions
export type ConnectionCheckLayer = MainConnectionCheckLayer
export type ConnectionCheckResult = MainConnectionCheckResult
/** 自检结论本身，不含身份。CLI 与外部客户端的结果条共用同一套渲染（R-S11 同理）。 */
export type ConnectionProbeReport = MainConnectionProbeReport
export type BackupReason = ConfigBackupReason
export type ConfigBackupSummary = StoredConfigBackupSummary
export type ConfigBackupPreview = StoredConfigBackupPreview
export type McpServer = McpServerDto
export type McpCreateInput = AddMcpInput
export type SkillItem = SkillDto
export type PluginItem = PluginDto
export type MarketplaceItem = MarketplaceDto
export type PluginCatalog = PluginCatalogDto
export type ExtensionMutation = ProviderExtensionMutation
export type ExtensionSnapshot = ProviderExtensionsSnapshot
export type McpHealthReport = ProviderMcpHealthReport
export type CodexSetupStatus = MainCodexSetupStatus
export type CodexReadinessStatus = MainCodexReadinessStatus
export type ProviderConfigSummary = NativeConfigSummary
export type ConfigSaveResult = NativeConfigSaveResult
export type CodexWorkspacePermissionStatus = MainCodexWorkspacePermissionStatus
export type CodexWorkspacePermissionWriteResult = MainCodexWorkspacePermissionWriteResult
export type AppConfigSummary = MainAppConfigSummary
export type RuntimeLogSnapshot = MainRuntimeLogSnapshot
export type RuntimeLogEntry = MainRuntimeLogEntry
export type NodeRuntimeInstallProgress = MainNodeRuntimeInstallProgress
export type NodeRuntimeInstallResult = MainNodeRuntimeInstallResult
export type PythonRuntimeInstallProgress = MainPythonRuntimeInstallProgress
export type PythonRuntimeInstallResult = MainPythonRuntimeInstallResult
export type PlatformCapabilities = MainPlatformCapabilities
export type AccountStatus = NewApiAccountStatus
export type AccountProfile = NewApiAccountProfile
export type AccountSiteId = 'solov' | 'solov-api'
export type AccountLoginInput = NewApiLoginInput & { siteId?: AccountSiteId }

/**
 * The "记住密码" credential the login dialog can ask the main process to
 * keep (safeStorage-encrypted at rest, see account-credential-store.ts).
 * Plaintext deliberately crosses IPC only on its two dedicated channels --
 * the config:reveal-api-key precedent (I3): an explicit, single-purpose
 * channel rather than a field piggybacking on ordinary queries.
 */
export interface RememberedAccountLogin {
  identifier: string
  password: string
}
export type AccountLoginResult = NewApiLoginResult & AccountContextMetadata
export type AccountRegisterInput = NewApiRegisterInput
export interface AccountContextMetadata {
  siteId?: AccountSiteId
  realmId?: 'xm-account' | 'api-account'
  capabilities?: import('./relay-backend').RelayBackendCapabilities
}
/**
 * 开机账号恢复超过启动画面的等待上限时，会话先按「未登录、正在恢复」作答。
 * `account` 是正在恢复的那个账号（本机账号库读出来之前为 null），界面据此把
 * 首页先画在它名下，恢复结束后不用整页重来。恢复结束后的会话不带这个字段。
 */
export interface AccountRestoringState {
  account: { siteId: AccountSiteId; userId: number } | null
  /** 开机恢复联不上（不是登录失效）：登录还在本机，主进程隔一会儿自己重试。缺省 = 恢复还在进行。 */
  retrying?: boolean
}
export type AccountSessionState = NewApiSessionState & AccountContextMetadata & { restoring?: AccountRestoringState }
export type AccountBalance = NewApiBalance
export interface AccountUsageChangedEvent {
  scope: string
}
export type AccountTopupInfo = NewApiTopupInfo
export type AccountTopupAmountInput = NewApiTopupAmountInput
export type AccountTopupAmountQuote = NewApiTopupAmountQuote
export type AccountTopupPaymentInput = NewApiTopupPaymentInput
export interface AccountTopupPaymentResult {
  opened: true
  tradeNo: string | null
}
export interface AccountPaymentWindowTerminalEvent {
  status: 'success' | 'expired' | 'failed' | 'closed'
  tradeNo: string | null
}
export type AccountTopupOrdersQuery = NewApiTopupOrdersQuery
export type AccountTopupOrdersPage = NewApiTopupOrdersPage
export type AccountRedemptionResult = NewApiRedemptionResult
export type AccountAffiliateTransferInput = NewApiAffiliateTransferInput
export type AccountSubscriptionPlan = NewApiSubscriptionPlan
export type AccountSubscriptionSelf = NewApiSubscriptionSelf
export type AccountSubscriptionPurchaseResult = NewApiSubscriptionPurchaseResult
export type AccountSubscriptionBillingPreference = NewApiBillingPreference
export type AccountSubscriptionPaymentInput = NewApiSubscriptionPaymentInput
export interface AccountSubscriptionPaymentResult {
  opened: true
  tradeNo: string | null
  expiresAt: string | null
}
export type AccountDisplayNameUpdateInput = NewApiDisplayNameUpdateInput
export type AccountProfileUpdateResult = NewApiProfileUpdateResult
export type AccountLoginSession = NewApiLoginSession
export type AccountRevokeLoginSessionResult = NewApiRevokeLoginSessionResult
export type AccountRevokeOtherLoginSessionsResult = NewApiRevokeOtherLoginSessionsResult
export type AccountManagedCliKeysResult = ManagedCliKeySyncSummary
export type AccountManagedCliConfigurationResult = ManagedCliConfigurationOutcome
export type LegalDocumentKind = NewApiLegalDocumentKind
export type LegalDocument = NewApiLegalDocument
export type AccountUsableGroup = NewApiUsableGroup
export type AccountResetPasswordInput = NewApiResetPasswordInput
export type AccountResetPasswordResult = NewApiResetPasswordResult
export type AccountProfileDetail = NewApiAccountProfileDetail
export type AccountUsageQuery = NewApiAccountUsageQuery
export type AccountUsageRecord = NewApiAccountUsageRecord
export type AccountUsagePage = NewApiAccountUsagePage
export type AccountDashboardQuery = NewApiAccountDashboardQuery
export type AccountDashboardRecord = NewApiAccountDashboardRecord
export type AccountDashboardData = NewApiAccountDashboardData
export type AccountTaskQuery = NewApiAccountTaskQuery
export type AccountTaskRecord = NewApiAccountTaskRecord
export type AccountTaskPage = NewApiAccountTaskPage
export interface AccountKey extends NewApiAccountKey {
  /**
   * 本软件替这个工具签发、且这个工具的配置此刻用的就是这把 Key。只由主进程按托管
   * Key 缓存与本机配置比对后补上；缺省 = 没有工具在用（旧行为）。
   */
  managedProvider?: ProviderId
}
export type AccountKeysQuery = NewApiAccountKeysQuery
export interface AccountKeysPage extends Omit<NewApiAccountKeysPage, 'keys'> {
  keys: AccountKey[]
}
export type AccountKeyCreateInput = NewApiAccountKeyCreateInput
export type AccountKeyUpdateInput = NewApiAccountKeyUpdateInput

/** Current local configuration and the explicitly requested automatic group; contains no full keys. */
export interface AccountKeyOptions {
  current: { preview: string | null; keyId: number | null; name: string | null; group: string | null }
  automatic: { name: string; group: string }
}

export interface AccountKeyCliConfigurationInput {
  provider: ProviderId
  keyId: number
  model: string
  mode: ConfigSaveMode
}
export type AccountChangePasswordInput = NewApiChangePasswordInput
export type AccountChangePasswordResult = NewApiChangePasswordResult
export type RendererNavigationTarget = 'settings' | 'updates' | 'topup' | 'acceleration'

export interface AccountManagedCliConfigurationInput {
  providers: ProviderId[]
  preferredModels: Partial<Record<ProviderId, string>>
  mode?: ConfigSavePayload['mode']
  intent?: 'automatic' | 'explicit'
}

export type RendererLogLevel = 'info' | 'warn' | 'error'

export interface RendererErrorPayload {
  message: string
  stack?: string
  context?: string
  /**
   * 缺省 = error，即这条通道原本的含义：写一条 error 日志并走崩溃上报。info /
   * warn 只进本机运行日志，给「渲染层做了什么决定」这类排障线索用，不上报。
   */
  level?: RendererLogLevel
}

export interface AiChatGroupSummary {
  name: string
  description: string
  ratio: number | string
}

export interface AiChatPreparedGroup {
  group: string
  models: string[]
  keyCreated: boolean
  storageWarning?: string
}

export type AiChatRole = 'system' | 'user' | 'assistant'

export interface AiChatMessageInput {
  role: AiChatRole
  content: string
}

export interface AiChatParametersInput {
  temperature?: number
  topP?: number
  maxTokens?: number
  frequencyPenalty?: number
  presencePenalty?: number
  seed?: number
}

export interface AiChatStartInput {
  requestId: string
  group: string
  model: string
  messages: AiChatMessageInput[]
  parameters?: AiChatParametersInput
}

export interface AiImageGenerateInput {
  requestId: string
  group: string
  model: string
  prompt: string
  size?: string
  quality?: 'low' | 'medium' | 'high' | 'auto'
  imageResolution?: '1K' | '2K' | '4K'
}

export interface AiChatAsset {
  assetId: string
  localUrl: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  width?: number
  height?: number
  fileName: string
  revisedPrompt?: string
}

export type AiChatErrorCode = MainAiChatStreamErrorCode

export type AiChatStreamEvent =
  | { requestId: string; type: 'content'; content: string }
  | { requestId: string; type: 'reasoning'; content: string }
  | { requestId: string; type: 'complete' }
  | { requestId: string; type: 'canceled'; mayStillComplete?: boolean }
  | { requestId: string; type: 'error'; code?: AiChatErrorCode; message: string }

/** 一个对话一份文件；key 由渲染层分配，只含字母、数字、_ 和 -。 */
export interface AiChatHistoryFile {
  key: string
  content: string
}

export interface AiChatHistorySnapshot {
  /** null = 这个账号在新存储里还没有记录（首次使用，或还没从旧的本机存储搬过来）。 */
  index: string | null
  conversations: AiChatHistoryFile[]
}

export interface AiChatHistoryWrite {
  scope: string
  index: string
  /** 索引引用的全部对话；不在这里的对话文件会在索引写好之后删掉。 */
  keys: string[]
  /** 这次真正改过、需要重写的对话，必须是 keys 的子集。 */
  put: AiChatHistoryFile[]
}

export interface AiChatCancelResult {
  canceled: boolean
  mayStillComplete: boolean
}

export interface InstallCancelResult {
  /** 取消请求是否被接受。 */
  cancelled: boolean
  /** 没能取消时给用户看的中文原因；取消成功为 null。 */
  reason: string | null
}

export interface InstallProgress {
  provider: ProviderId
  state: 'started' | 'output' | 'success' | 'error'
  message: string
  /**
   * Only the few phases that can honestly measure themselves report this --
   * today the signed Grok download. Absent means "no percentage is knowable",
   * not zero: npm's dependency resolution reports elapsed time instead.
   */
  percent?: number
}

export interface CodexDesktopStatusEvent {
  phase: 'stopped' | 'running'
  status: DesktopAppStatus
}

export interface CodexDesktopInstallProgress {
  phase: 'downloading' | 'validating' | 'closing' | 'installing' | 'completed' | 'error'
  percent: number | null
  message: string
}

export interface CodexDesktopInstallResult {
  action: 'installed' | 'updated' | 'unchanged'
  previousVersion: string | null
  installedVersion: string | null
}

export interface IpcInvokeDefinition<
  Channel extends string,
  Args extends unknown[],
  Result,
> {
  readonly channel: Channel
  readonly args: Args
  readonly result: Result
}

export interface IpcEventDefinition<Channel extends string, Payload> {
  readonly channel: Channel
  readonly payload: Payload
}

export type IpcContractArgs<Definition> = Definition extends IpcInvokeDefinition<
  string,
  infer Args,
  unknown
> ? Args : never

export type IpcContractResult<Definition> = Definition extends IpcInvokeDefinition<
  string,
  unknown[],
  infer Result
> ? Result : never

export type IpcEventPayload<Definition> = Definition extends IpcEventDefinition<
  string,
  infer Payload
> ? Payload : never

export interface XingmangInvokeContract {
  getPlatformCapabilities: IpcInvokeDefinition<
    'platform:get-capabilities',
    [],
    PlatformCapabilities
  >
  scanSystem: IpcInvokeDefinition<'system:scan', [forceRefresh?: boolean, options?: SystemScanOptions], SystemSnapshot>
  refreshNetworkLocation: IpcInvokeDefinition<'system:refresh-network-location', [], SystemSnapshot['network']>
  refreshOfficialChatGptUsage: IpcInvokeDefinition<
    'system:refresh-official-chatgpt',
    [],
    OfficialChatGptAccount | null
  >
  getCodexReadiness: IpcInvokeDefinition<'startup:codex-readiness', [], CodexReadinessStatus>
  getConfig: IpcInvokeDefinition<'config:get', [], AppConfigSummary>
  revealApiKey: IpcInvokeDefinition<'config:reveal-api-key', [provider: ProviderId], string>
  saveConfig: IpcInvokeDefinition<'config:save', [payload: ConfigSavePayload], ConfigSaveResult>
  /**
   * 在资源管理器 / 访达里打开这个工具自己的配置目录（Claude 是 ~/.claude，
   * Codex 以软件注入的 CODEX_HOME 为准）。只打开目录，不碰里面任何文件，
   * 目录还没生成时报错而不是替用户建一个空目录。
   */
  openProviderConfigDirectory: IpcInvokeDefinition<'config:open-directory', [provider: ProviderId], boolean>
  configureExternalTool: IpcInvokeDefinition<
    'config:configure-external-tool',
    [tool: ExternalToolId, options: ExternalClientConfigRequest],
    ExternalClientConfigResult
  >
  scanExternalClients: IpcInvokeDefinition<'external-clients:scan', [force?: boolean], ExternalClientStatus[]>
  installExternalClient: IpcInvokeDefinition<'external-clients:install', [tool: ExternalToolId], ExternalClientStatus>
  launchExternalClient: IpcInvokeDefinition<'external-clients:launch', [tool: ExternalToolId], void>
  /**
   * 切回官方订阅账号；merge 恢复对应来源配置，reset 重建初始配置。
   * 两种方式均保留官方登录凭据和历史会话。省略 mode 沿用 merge。
   * 切回星芒走既有的 config:save,不另开通道。
   */
  switchToOfficialAccount: IpcInvokeDefinition<
    'config:switch-to-official-account',
    [provider: ProviderId, mode?: ConfigSavePayload['mode']],
    ConfigSaveResult
  >
  /**
   * 首页工具行的一键切换：自动备份 → 写配置（切到当前账号时挪开抢道的官方凭据）
   * → 连接自检 → 配置本身用不了就整体恢复。失败时抛出的中文原因直接上屏。
   */
  switchAccountSource: IpcInvokeDefinition<
    'config:switch-account-source',
    [provider: ProviderId, target: AccountSourceTarget],
    AccountSourceSwitchResult
  >
  /**
   * 换账号把 Key 写进这些工具之后，看哪些还开着（Codex 连同桌面端），只对开着的
   * 提醒关掉重开。只读，不改任何东西；检测不出来的归到 unknown，不抛错。
   */
  inspectRunningTools: IpcInvokeDefinition<
    'tools:inspect-running',
    [providers: ProviderId[]],
    RunningToolsReport
  >
  listModels: IpcInvokeDefinition<'models:list', [apiKey: string], string[]>
  listConfiguredModels: IpcInvokeDefinition<'models:list-configured', [provider: ProviderId], string[]>
  /** options 省略 = 弹目录选择器；createStarter = 不弹选择器，直接替用户新建一个项目文件夹。 */
  chooseWorkspace: IpcInvokeDefinition<'workspace:choose', [options?: ChooseWorkspaceOptions], string | null>
  getRepositoryContext: IpcInvokeDefinition<'repository:get-context', [], RepositoryContext>
  installNodeRuntime: IpcInvokeDefinition<'runtime:install-node', [], NodeRuntimeInstallResult>
  restartWindows: IpcInvokeDefinition<'runtime:restart-windows', [], void>
  installPythonRuntime: IpcInvokeDefinition<'runtime:install-python', [], PythonRuntimeInstallResult>
  /** version 省略时由主进程按已验证版本名单与设置决定装哪个版本(N1)。 */
  installCli: IpcInvokeDefinition<'cli:install', [provider: ProviderId, version?: string], void>
  /** 中止正在进行的安装或更新;已经走到写入工具目录那一步时会被拒绝并给出原因。 */
  cancelCliInstall: IpcInvokeDefinition<'cli:cancel-install', [provider: ProviderId], InstallCancelResult>
  uninstallCli: IpcInvokeDefinition<'cli:uninstall', [provider: ProviderId], ToolUninstallResult>
  checkCliUpdate: IpcInvokeDefinition<'cli:check-update', [provider: ProviderId], CliStatus>
  getCodexSetupStatus: IpcInvokeDefinition<'setup:codex-status', [], CodexSetupStatus>
  installCodexDesktop: IpcInvokeDefinition<'desktop:install-codex', [], CodexDesktopInstallResult>
  /** 中止正在进行的安装或更新;已经开始装 MSIX 时会被拒绝并给出原因。 */
  cancelCodexDesktopInstall: IpcInvokeDefinition<'desktop:cancel-install-codex', [], InstallCancelResult>
  uninstallCodexDesktop: IpcInvokeDefinition<'desktop:uninstall-codex', [], ToolUninstallResult>
  checkCodexDesktopUpdate: IpcInvokeDefinition<'desktop:check-update-codex', [], DesktopAppStatus>
  /** mode 省略 = 开新对话(旧行为);resumeLast 由主进程按工具映射成固定参数。 */
  launchCli: IpcInvokeDefinition<
    'cli:launch',
    [provider: ProviderId, workspace: string, mode?: CliLaunchMode],
    CliLaunchResult
  >
  getCodexDesktopStatus: IpcInvokeDefinition<'desktop:codex-status', [], DesktopAppStatus>
  inspectCodexDesktopLocale: IpcInvokeDefinition<
    'desktop:codex-locale-status',
    [],
    CodexDesktopLocaleStatus
  >
  inspectCodexWorkspacePermissions: IpcInvokeDefinition<
    'desktop:codex-permissions-status',
    [],
    MainCodexWorkspacePermissionStatus
  >
  trustCodexWorkspace: IpcInvokeDefinition<
    'desktop:trust-workspace',
    [],
    MainCodexWorkspacePermissionWriteResult & { restarted: boolean }
  >
  setCodexDesktopLocale: IpcInvokeDefinition<
    'desktop:set-codex-locale',
    [locale: CodexDesktopLocale],
    CodexDesktopLocaleResult
  >
  launchCodexDesktop: IpcInvokeDefinition<
    'desktop:launch-codex',
    [mode: CodexDesktopLaunchMode],
    CodexDesktopLaunchResult
  >
  setWindowMode: IpcInvokeDefinition<'window:set-mode', [mode: AppWindowMode], void>
  setWindowTheme: IpcInvokeDefinition<'window:set-theme', [theme: AppTheme], void>
  getWindowCapabilities: IpcInvokeDefinition<'window:get-capabilities', [], WindowCapabilities>
  takeExternalDeepLink: IpcInvokeDefinition<'navigation:take-deep-link', [], ExternalDeepLink | null>
  replyWindowClose: IpcInvokeDefinition<'window:close-report', [requestId: string, report: WindowCloseReport], boolean>
  openExternal: IpcInvokeDefinition<'external:open', [url: string], boolean>
  getUpdateState: IpcInvokeDefinition<'update:get-state', [], UpdateSnapshot>
  runStartupUpdate: IpcInvokeDefinition<'update:startup', [], UpdateSnapshot>
  checkForUpdates: IpcInvokeDefinition<'update:check', [], UpdateSnapshot>
  downloadUpdate: IpcInvokeDefinition<'update:download', [], UpdateSnapshot>
  installUpdate: IpcInvokeDefinition<'update:install', [], { accepted: true }>
  listSessions: IpcInvokeDefinition<'sessions:list', [query: SessionListQuery], SessionPageResult>
  getSessionDetail: IpcInvokeDefinition<'sessions:detail', [sessionId: string], SessionDetailResult>
  exportSession: IpcInvokeDefinition<
    'sessions:export',
    [sessionId: string],
    SessionExportResult | null
  >
  archiveSession: IpcInvokeDefinition<
    'sessions:archive',
    [sessionId: string],
    SessionMutationResult
  >
  restoreSession: IpcInvokeDefinition<
    'sessions:restore',
    [sessionId: string],
    SessionMutationResult
  >
  listProviderSessions: IpcInvokeDefinition<
    'provider-sessions:list',
    [query: MultiProviderSessionListQuery],
    MultiProviderSessionPage
  >
  getProviderSessionDetail: IpcInvokeDefinition<
    'provider-sessions:detail',
    [sessionId: string],
    MultiProviderSessionDetail
  >
  exportProviderSession: IpcInvokeDefinition<
    'provider-sessions:export',
    [sessionId: string],
    MultiProviderSessionExportResult | null
  >
  /** 入参只有会话 id：工作目录由主进程从记录里取，渲染层不传任意路径。 */
  openProviderSessionDirectory: IpcInvokeDefinition<
    'provider-sessions:open-directory',
    [sessionId: string],
    boolean
  >
  getSettings: IpcInvokeDefinition<'settings:get', [], AppSettingsV2>
  saveSettings: IpcInvokeDefinition<'settings:save', [settings: AppSettingsV2Update], AppSettingsV2>
  runDiagnostics: IpcInvokeDefinition<'diagnostics:run', [options?: DiagnosticsRunOptions], DiagnosticsReport>
  exportDiagnostics: IpcInvokeDefinition<'diagnostics:export', [], { outputPath: string } | null>
  getRuntimeLogs: IpcInvokeDefinition<'runtime-logs:list', [limit?: number], RuntimeLogSnapshot>
  getFeedbackReport: IpcInvokeDefinition<'runtime-logs:preview-feedback', [], FeedbackReportPreview>
  copyFeedbackReport: IpcInvokeDefinition<'runtime-logs:copy-feedback', [reportId?: string], { entries: number }>
  exportFeedbackReport: IpcInvokeDefinition<'runtime-logs:export-feedback', [reportId?: string], { outputPath: string } | null>
  /** 只认本次运行里导出过的文件路径（主进程记着），渲染层给别的路径会被拒。 */
  revealExportedFile: IpcInvokeDefinition<'exports:reveal-file', [filePath: string], boolean>
  openRuntimeLogDirectory: IpcInvokeDefinition<'runtime-logs:open-directory', [], boolean>
  clearRuntimeLogs: IpcInvokeDefinition<'runtime-logs:clear', [], void>
  reportRendererError: IpcInvokeDefinition<'runtime-logs:renderer-error', [payload: RendererErrorPayload], void>
  listBackups: IpcInvokeDefinition<'backups:list', [], ConfigBackupSummary[]>
  createBackup: IpcInvokeDefinition<'backups:create', [provider: ProviderId], ConfigBackupSummary>
  inspectBackup: IpcInvokeDefinition<'backups:inspect', [id: string], ConfigBackupPreview>
  restoreBackup: IpcInvokeDefinition<'backups:restore', [id: string], ConfigRestoreResult>
  deleteBackup: IpcInvokeDefinition<'backups:delete', [id: string], void>
  listMcpServers: IpcInvokeDefinition<'mcp:list', [], McpServer[]>
  addMcpServer: IpcInvokeDefinition<'mcp:add', [input: McpCreateInput], McpServer[]>
  removeMcpServer: IpcInvokeDefinition<'mcp:remove', [name: string], McpServer[]>
  loginMcpServer: IpcInvokeDefinition<'mcp:login', [name: string], McpServer[]>
  logoutMcpServer: IpcInvokeDefinition<'mcp:logout', [name: string], McpServer[]>
  listSkills: IpcInvokeDefinition<'skills:list', [], SkillItem[]>
  importSkill: IpcInvokeDefinition<'skills:import', [input: ImportSkillInput], SkillItem[]>
  toggleSkill: IpcInvokeDefinition<
    'skills:toggle',
    [skillPath: string, enabled: boolean],
    { skills: SkillItem[]; rewriteNotice?: string }
  >
  uninstallSkill: IpcInvokeDefinition<
    'skills:uninstall',
    [skillPath: string],
    { skills: SkillItem[]; trashPath: string }
  >
  listPlugins: IpcInvokeDefinition<'plugins:list', [], PluginCatalog>
  addPlugin: IpcInvokeDefinition<'plugins:add', [selector: string], PluginCatalog>
  removePlugin: IpcInvokeDefinition<'plugins:remove', [selector: string], PluginCatalog>
  togglePlugin: IpcInvokeDefinition<
    'plugins:toggle',
    [selector: string, enabled: boolean],
    PluginCatalog
  >
  addMarketplace: IpcInvokeDefinition<
    'marketplaces:add',
    [input: AddMarketplaceInput],
    PluginCatalog
  >
  upgradeMarketplace: IpcInvokeDefinition<'marketplaces:upgrade', [name?: string], PluginCatalog>
  removeMarketplace: IpcInvokeDefinition<'marketplaces:remove', [name: string], PluginCatalog>
  listProviderExtensions: IpcInvokeDefinition<
    'extensions:list',
    [provider: ProviderId],
    ProviderExtensionsSnapshot
  >
  listAllProviderExtensions: IpcInvokeDefinition<
    'extensions:list-all',
    [],
    ProviderExtensionsSnapshot[]
  >
  mutateProviderExtension: IpcInvokeDefinition<
    'extensions:mutate',
    [input: ProviderExtensionMutation],
    ProviderExtensionsSnapshot
  >
  ensureProviderMarketplace: IpcInvokeDefinition<
    'extensions:ensure-marketplace',
    [provider: ProviderId],
    ProviderExtensionsSnapshot
  >
  checkProviderMcpHealth: IpcInvokeDefinition<
    'extensions:check-mcp-health',
    [provider: ProviderId],
    ProviderMcpHealthReport
  >
  getAccountStatus: IpcInvokeDefinition<'account:get-status', [siteId?: AccountSiteId], AccountStatus>
  getAccountNotice: IpcInvokeDefinition<'account:get-notice', [mode?: import('./relay-backend').RelayNoticeReadMode], import('./relay-backend').RelayNotice | null>
  markAccountNoticeRead: IpcInvokeDefinition<'account:mark-notice-read', [id: string, entryId: string], void>
  syncLocalNoticeReads: IpcInvokeDefinition<'account:sync-local-notice-reads', [scope: string, ids: string[]], string[]>
  getAccelerationState: IpcInvokeDefinition<'acceleration:get-state', [scope: string], import('./acceleration-contract').AccelerationState>
  listAccelerationLines: IpcInvokeDefinition<'acceleration:list-lines', [scope: string], import('./acceleration-contract').AccelerationLine[]>
  pingAccelerationLine: IpcInvokeDefinition<'acceleration:ping-line', [scope: string, lineId: string], import('./acceleration-contract').AccelerationLine>
  startAcceleration: IpcInvokeDefinition<'acceleration:start', [scope: string, mode: import('./acceleration-contract').AccelerationMode, lineId?: string, ignoreConflicts?: boolean], import('./acceleration-contract').AccelerationState>
  stopAcceleration: IpcInvokeDefinition<'acceleration:stop', [scope: string], import('./acceleration-contract').AccelerationState>
  redeemAccelerationCode: IpcInvokeDefinition<'acceleration:redeem-code', [scope: string, code: string], import('./acceleration-contract').AccelerationRedemptionResult>
  getAccelerationPreference: IpcInvokeDefinition<'acceleration:get-preference', [scope: string], import('./acceleration-contract').AccelerationPreference>
  saveAccelerationPreference: IpcInvokeDefinition<'acceleration:save-preference', [scope: string, update: import('./acceleration-contract').AccelerationPreferenceUpdate], import('./acceleration-contract').AccelerationPreference>
  getLegalDocument: IpcInvokeDefinition<'account:get-legal-document', [kind: LegalDocumentKind, siteId?: AccountSiteId], LegalDocument>
  loginAccount: IpcInvokeDefinition<'account:login', [input: AccountLoginInput], AccountLoginResult>
  logoutAccount: IpcInvokeDefinition<'account:logout', [], void>
  getAccountSession: IpcInvokeDefinition<'account:get-session', [], AccountSessionState>
  listSavedAccounts: IpcInvokeDefinition<'account:list-saved', [], SavedAccount[]>
  switchSavedAccount: IpcInvokeDefinition<'account:switch-saved', [id: string], AccountSessionState>
  removeSavedAccount: IpcInvokeDefinition<'account:remove-saved', [id: string], void>
  getAccountBalance: IpcInvokeDefinition<'account:get-balance', [], AccountBalance>
  getAccountTopupInfo: IpcInvokeDefinition<'account:get-topup-info', [], AccountTopupInfo>
  quoteAccountTopupAmount: IpcInvokeDefinition<
    'account:quote-topup',
    [input: AccountTopupAmountInput],
    AccountTopupAmountQuote
  >
  createAccountTopupPayment: IpcInvokeDefinition<
    'account:create-topup-payment',
    [input: AccountTopupPaymentInput],
    AccountTopupPaymentResult
  >
  closeAccountPaymentWindow: IpcInvokeDefinition<'account:close-payment-window', [], void>
  getAccountTopupOrders: IpcInvokeDefinition<
    'account:list-topup-orders',
    [input: AccountTopupOrdersQuery],
    AccountTopupOrdersPage
  >
  redeemAccountTopupCode: IpcInvokeDefinition<
    'account:redeem-topup-code',
    [code: string],
    AccountRedemptionResult
  >
  transferAccountAffiliateQuota: IpcInvokeDefinition<
    'account:transfer-affiliate-quota',
    [input: AccountAffiliateTransferInput],
    void
  >
  getAccountSubscriptionPlans: IpcInvokeDefinition<
    'account:list-subscription-plans',
    [],
    AccountSubscriptionPlan[]
  >
  getAccountSubscriptionSelf: IpcInvokeDefinition<
    'account:get-subscription-self',
    [],
    AccountSubscriptionSelf
  >
  updateAccountSubscriptionPreference: IpcInvokeDefinition<
    'account:update-subscription-preference',
    [preference: AccountSubscriptionBillingPreference],
    AccountSubscriptionBillingPreference
  >
  createAccountSubscriptionPayment: IpcInvokeDefinition<
    'account:create-subscription-payment',
    [input: AccountSubscriptionPaymentInput],
    AccountSubscriptionPaymentResult
  >
  purchaseAccountSubscriptionWithBalance: IpcInvokeDefinition<
    'account:purchase-subscription-balance',
    [planId: number],
    AccountSubscriptionPurchaseResult
  >
  syncManagedCliKeys: IpcInvokeDefinition<'account:sync-managed-cli-keys', [], AccountManagedCliKeysResult>
  configureManagedCliKeys: IpcInvokeDefinition<
    'account:configure-managed-clis',
    [input: AccountManagedCliConfigurationInput],
    AccountManagedCliConfigurationResult
  >
  registerAccount: IpcInvokeDefinition<'account:register', [input: AccountRegisterInput], void>
  sendVerificationCode: IpcInvokeDefinition<'account:send-verification-code', [email: string], void>
  sendPasswordResetCode: IpcInvokeDefinition<'account:send-reset-code', [email: string, siteId?: AccountSiteId], void>
  resetPassword: IpcInvokeDefinition<
    'account:reset-password',
    [input: AccountResetPasswordInput, siteId?: AccountSiteId],
    AccountResetPasswordResult
  >
  getAccountProfile: IpcInvokeDefinition<'account:get-profile', [], AccountProfileDetail>
  updateAccountDisplayName: IpcInvokeDefinition<
    'account:update-display-name',
    [input: AccountDisplayNameUpdateInput],
    AccountProfileUpdateResult
  >
  getAccountUsage: IpcInvokeDefinition<
    'account:get-usage',
    [input: AccountUsageQuery],
    AccountUsagePage
  >
  getAccountDashboard: IpcInvokeDefinition<
    'account:get-dashboard',
    [input: AccountDashboardQuery],
    AccountDashboardData
  >
  getAccountTasks: IpcInvokeDefinition<
    'account:get-tasks',
    [input: AccountTaskQuery],
    AccountTaskPage
  >
  getAccountKeys: IpcInvokeDefinition<'account:list-keys', [input: AccountKeysQuery], AccountKeysPage>
  getAccountUsableGroups: IpcInvokeDefinition<'account:list-groups', [], AccountUsableGroup[]>
  revokeAccountKey: IpcInvokeDefinition<'account:revoke-key', [id: number], void>
  copyAccountKey: IpcInvokeDefinition<'account:copy-key', [id: number], void>
  revealAccountKey: IpcInvokeDefinition<'account:reveal-key', [id: number], string>
  listAccountKeyModels: IpcInvokeDefinition<'account:list-key-models', [id: number], string[]>
  saveConfigWithAccountKey: IpcInvokeDefinition<
    'account:configure-cli-with-key',
    [input: AccountKeyCliConfigurationInput],
    ConfigSaveResult
  >
  changeAccountPassword: IpcInvokeDefinition<
    'account:change-password',
    [input: AccountChangePasswordInput],
    AccountChangePasswordResult
  >
  getAccountLoginSessions: IpcInvokeDefinition<
    'account:list-login-sessions',
    [],
    AccountLoginSession[]
  >
  revokeAccountLoginSession: IpcInvokeDefinition<
    'account:revoke-login-session',
    [sid: string],
    AccountRevokeLoginSessionResult
  >
  revokeOtherAccountLoginSessions: IpcInvokeDefinition<
    'account:revoke-other-login-sessions',
    [],
    AccountRevokeOtherLoginSessionsResult
  >
  openCanvasWindow: IpcInvokeDefinition<'canvas:open', [], void>
  getRememberedAccountLogin: IpcInvokeDefinition<'account:get-remembered-login', [siteId?: AccountSiteId], RememberedAccountLogin | null>
  setRememberedAccountLogin: IpcInvokeDefinition<'account:set-remembered-login', [input: RememberedAccountLogin | null, siteId?: AccountSiteId], void>
  createAccountKey: IpcInvokeDefinition<'account:create-key', [input: AccountKeyCreateInput], void>
  updateAccountKey: IpcInvokeDefinition<'account:update-key', [input: AccountKeyUpdateInput], void>
  listAiChatGroups: IpcInvokeDefinition<'chat:list-groups', [], AiChatGroupSummary[]>
  prepareAiChatGroup: IpcInvokeDefinition<'chat:prepare-group', [group: string], AiChatPreparedGroup>
  startAiChat: IpcInvokeDefinition<'chat:start', [input: AiChatStartInput], { requestId: string; accepted: true }>
  generateAiImage: IpcInvokeDefinition<'chat:generate-image', [input: AiImageGenerateInput], AiChatAsset[]>
  cancelAiChat: IpcInvokeDefinition<'chat:cancel', [requestId: string], AiChatCancelResult>
  copyAiChatAsset: IpcInvokeDefinition<'chat:copy-asset', [assetId: string], void>
  saveAiChatAsset: IpcInvokeDefinition<'chat:save-asset', [assetId: string], { saved: boolean }>
  showAiChatAssetMenu: IpcInvokeDefinition<'chat:asset-menu', [assetId: string], void>
  readAiChatHistory: IpcInvokeDefinition<'chat-history:read', [scope: string], AiChatHistorySnapshot>
  writeAiChatHistory: IpcInvokeDefinition<'chat-history:write', [input: AiChatHistoryWrite], void>
  /**
   * 连接自检：用该工具配置文件里真正写着的 Key、服务地址和模型，向星芒服务
   * 发一次最小请求，把失败归到网络 / 密钥 / 额度 / 分组 / 模型 / 协议中的
   * 一层；没配过的工具归到「未配置」，不算失败。diagnostics:run 的
   * XINGMANG_NETWORK 只读一次不用登录的状态接口，证明网络通不证明能用，所以这条单独成通道、
   * 只在用户点按钮时才跑。一次调用只测一个工具，结果页按工具各调一次。
   */
  checkProviderConnection: IpcInvokeDefinition<
    'diagnostics:check-connection',
    [provider: ProviderId],
    ConnectionCheckResult
  >
  /**
   * 外部客户端（WorkBuddy / Claude Desktop / OpenCode）的连接自检。与上面那条
   * 分成两条通道而不是合成一个联合入参：这一条的密钥来自客户端自己的配置文件、
   * 由主进程读出，渲染层既给不了也不该给（I3）；结论形状相同，身份换成客户端 id。
   */
  checkExternalClientConnection: IpcInvokeDefinition<
    'diagnostics:check-external-connection',
    [tool: ExternalToolId],
    ExternalClientCheckResult
  >
  getAccountKeyOptions: IpcInvokeDefinition<'account:get-key-options', [provider: ProviderId], AccountKeyOptions>
}

export interface XingmangEventContract {
  onExternalClientInstallProgress: IpcEventDefinition<'external-clients:install-progress', ExternalClientInstallProgress>
  onAccountSessionChanged: IpcEventDefinition<'account:session-changed', AccountSessionState>
  onAccountUsageChanged: IpcEventDefinition<'account:usage-changed', AccountUsageChangedEvent>
  /** 本机账号存储被重建。载荷为空：备份文件名与账号内容都不跨 IPC。 */
  onAccountVaultRecovered: IpcEventDefinition<'account:vault-recovered', undefined>
  onNavigate: IpcEventDefinition<'navigation:open-page', RendererNavigationTarget>
  onWindowCloseRequest: IpcEventDefinition<'window:close-request', { requestId: string }>
  onExternalDeepLink: IpcEventDefinition<'navigation:deep-link-pending', undefined>
  onLaunchTool: IpcEventDefinition<'window:launch-tool', ProviderId | 'codexDesktop'>
  onNodeRuntimeInstallProgress: IpcEventDefinition<
    'runtime:node-install-progress',
    NodeRuntimeInstallProgress
  >
  onPythonRuntimeInstallProgress: IpcEventDefinition<
    'runtime:python-install-progress',
    PythonRuntimeInstallProgress
  >
  onInstallProgress: IpcEventDefinition<'cli:install-progress', InstallProgress>
  onCodexDesktopStatus: IpcEventDefinition<
    'desktop:codex-status-changed',
    CodexDesktopStatusEvent
  >
  onCodexDesktopInstallProgress: IpcEventDefinition<
    'desktop:codex-install-progress',
    CodexDesktopInstallProgress
  >
  onUpdateState: IpcEventDefinition<'update:state-changed', UpdateSnapshot>
  onAccountPaymentWindowTerminal: IpcEventDefinition<
    'account:payment-window-terminal',
    AccountPaymentWindowTerminalEvent
  >
  onAiChatStream: IpcEventDefinition<'chat:stream-event', AiChatStreamEvent>
}

export type XingmangApi = {
  [Method in keyof XingmangInvokeContract]: (
    ...args: IpcContractArgs<XingmangInvokeContract[Method]>
  ) => Promise<IpcContractResult<XingmangInvokeContract[Method]>>
} & {
  [Method in keyof XingmangEventContract]: (
    listener: (event: IpcEventPayload<XingmangEventContract[Method]>) => void
  ) => () => void
}

export const ipcInvokeChannels = {
  getPlatformCapabilities: 'platform:get-capabilities',
  scanSystem: 'system:scan',
  refreshNetworkLocation: 'system:refresh-network-location',
  refreshOfficialChatGptUsage: 'system:refresh-official-chatgpt',
  getCodexReadiness: 'startup:codex-readiness',
  getConfig: 'config:get',
  revealApiKey: 'config:reveal-api-key',
  saveConfig: 'config:save',
  openProviderConfigDirectory: 'config:open-directory',
  configureExternalTool: 'config:configure-external-tool',
  scanExternalClients: 'external-clients:scan',
  installExternalClient: 'external-clients:install',
  launchExternalClient: 'external-clients:launch',
  switchToOfficialAccount: 'config:switch-to-official-account',
  switchAccountSource: 'config:switch-account-source',
  inspectRunningTools: 'tools:inspect-running',
  chooseWorkspace: 'workspace:choose',
  getRepositoryContext: 'repository:get-context',
  installNodeRuntime: 'runtime:install-node',
  restartWindows: 'runtime:restart-windows',
  installPythonRuntime: 'runtime:install-python',
  installCli: 'cli:install',
  cancelCliInstall: 'cli:cancel-install',
  uninstallCli: 'cli:uninstall',
  checkCliUpdate: 'cli:check-update',
  getCodexSetupStatus: 'setup:codex-status',
  installCodexDesktop: 'desktop:install-codex',
  cancelCodexDesktopInstall: 'desktop:cancel-install-codex',
  uninstallCodexDesktop: 'desktop:uninstall-codex',
  checkCodexDesktopUpdate: 'desktop:check-update-codex',
  launchCli: 'cli:launch',
  getCodexDesktopStatus: 'desktop:codex-status',
  inspectCodexDesktopLocale: 'desktop:codex-locale-status',
  inspectCodexWorkspacePermissions: 'desktop:codex-permissions-status',
  trustCodexWorkspace: 'desktop:trust-workspace',
  setCodexDesktopLocale: 'desktop:set-codex-locale',
  launchCodexDesktop: 'desktop:launch-codex',
  listModels: 'models:list',
  listConfiguredModels: 'models:list-configured',
  setWindowMode: 'window:set-mode',
  setWindowTheme: 'window:set-theme',
  getWindowCapabilities: 'window:get-capabilities',
  takeExternalDeepLink: 'navigation:take-deep-link',
  replyWindowClose: 'window:close-report',
  openExternal: 'external:open',
  getUpdateState: 'update:get-state',
  runStartupUpdate: 'update:startup',
  checkForUpdates: 'update:check',
  downloadUpdate: 'update:download',
  installUpdate: 'update:install',
  listSessions: 'sessions:list',
  getSessionDetail: 'sessions:detail',
  exportSession: 'sessions:export',
  archiveSession: 'sessions:archive',
  restoreSession: 'sessions:restore',
  listProviderSessions: 'provider-sessions:list',
  getProviderSessionDetail: 'provider-sessions:detail',
  exportProviderSession: 'provider-sessions:export',
  openProviderSessionDirectory: 'provider-sessions:open-directory',
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  runDiagnostics: 'diagnostics:run',
  exportDiagnostics: 'diagnostics:export',
  getRuntimeLogs: 'runtime-logs:list',
  getFeedbackReport: 'runtime-logs:preview-feedback',
  copyFeedbackReport: 'runtime-logs:copy-feedback',
  exportFeedbackReport: 'runtime-logs:export-feedback',
  revealExportedFile: 'exports:reveal-file',
  openRuntimeLogDirectory: 'runtime-logs:open-directory',
  clearRuntimeLogs: 'runtime-logs:clear',
  reportRendererError: 'runtime-logs:renderer-error',
  listBackups: 'backups:list',
  createBackup: 'backups:create',
  inspectBackup: 'backups:inspect',
  restoreBackup: 'backups:restore',
  deleteBackup: 'backups:delete',
  listMcpServers: 'mcp:list',
  addMcpServer: 'mcp:add',
  removeMcpServer: 'mcp:remove',
  loginMcpServer: 'mcp:login',
  logoutMcpServer: 'mcp:logout',
  listSkills: 'skills:list',
  importSkill: 'skills:import',
  toggleSkill: 'skills:toggle',
  uninstallSkill: 'skills:uninstall',
  listPlugins: 'plugins:list',
  addPlugin: 'plugins:add',
  removePlugin: 'plugins:remove',
  togglePlugin: 'plugins:toggle',
  addMarketplace: 'marketplaces:add',
  upgradeMarketplace: 'marketplaces:upgrade',
  removeMarketplace: 'marketplaces:remove',
  listProviderExtensions: 'extensions:list',
  listAllProviderExtensions: 'extensions:list-all',
  mutateProviderExtension: 'extensions:mutate',
  ensureProviderMarketplace: 'extensions:ensure-marketplace',
  checkProviderMcpHealth: 'extensions:check-mcp-health',
  getAccountStatus: 'account:get-status',
  getAccountNotice: 'account:get-notice',
  markAccountNoticeRead: 'account:mark-notice-read',
  syncLocalNoticeReads: 'account:sync-local-notice-reads',
  getAccelerationState: 'acceleration:get-state',
  listAccelerationLines: 'acceleration:list-lines',
  pingAccelerationLine: 'acceleration:ping-line',
  startAcceleration: 'acceleration:start',
  stopAcceleration: 'acceleration:stop',
  redeemAccelerationCode: 'acceleration:redeem-code',
  getAccelerationPreference: 'acceleration:get-preference',
  saveAccelerationPreference: 'acceleration:save-preference',
  getLegalDocument: 'account:get-legal-document',
  loginAccount: 'account:login',
  logoutAccount: 'account:logout',
  getAccountSession: 'account:get-session',
  listSavedAccounts: 'account:list-saved',
  switchSavedAccount: 'account:switch-saved',
  removeSavedAccount: 'account:remove-saved',
  getAccountBalance: 'account:get-balance',
  getAccountTopupInfo: 'account:get-topup-info',
  quoteAccountTopupAmount: 'account:quote-topup',
  createAccountTopupPayment: 'account:create-topup-payment',
  closeAccountPaymentWindow: 'account:close-payment-window',
  getAccountTopupOrders: 'account:list-topup-orders',
  redeemAccountTopupCode: 'account:redeem-topup-code',
  transferAccountAffiliateQuota: 'account:transfer-affiliate-quota',
  getAccountSubscriptionPlans: 'account:list-subscription-plans',
  getAccountSubscriptionSelf: 'account:get-subscription-self',
  updateAccountSubscriptionPreference: 'account:update-subscription-preference',
  createAccountSubscriptionPayment: 'account:create-subscription-payment',
  purchaseAccountSubscriptionWithBalance: 'account:purchase-subscription-balance',
  syncManagedCliKeys: 'account:sync-managed-cli-keys',
  configureManagedCliKeys: 'account:configure-managed-clis',
  registerAccount: 'account:register',
  sendVerificationCode: 'account:send-verification-code',
  sendPasswordResetCode: 'account:send-reset-code',
  resetPassword: 'account:reset-password',
  getAccountProfile: 'account:get-profile',
  updateAccountDisplayName: 'account:update-display-name',
  getAccountUsage: 'account:get-usage',
  getAccountDashboard: 'account:get-dashboard',
  getAccountTasks: 'account:get-tasks',
  getAccountKeys: 'account:list-keys',
  getAccountUsableGroups: 'account:list-groups',
  revokeAccountKey: 'account:revoke-key',
  copyAccountKey: 'account:copy-key',
  revealAccountKey: 'account:reveal-key',
  listAccountKeyModels: 'account:list-key-models',
  saveConfigWithAccountKey: 'account:configure-cli-with-key',
  changeAccountPassword: 'account:change-password',
  getAccountLoginSessions: 'account:list-login-sessions',
  revokeAccountLoginSession: 'account:revoke-login-session',
  revokeOtherAccountLoginSessions: 'account:revoke-other-login-sessions',
  openCanvasWindow: 'canvas:open',
  getRememberedAccountLogin: 'account:get-remembered-login',
  setRememberedAccountLogin: 'account:set-remembered-login',
  createAccountKey: 'account:create-key',
  updateAccountKey: 'account:update-key',
  listAiChatGroups: 'chat:list-groups',
  prepareAiChatGroup: 'chat:prepare-group',
  startAiChat: 'chat:start',
  generateAiImage: 'chat:generate-image',
  cancelAiChat: 'chat:cancel',
  copyAiChatAsset: 'chat:copy-asset',
  saveAiChatAsset: 'chat:save-asset',
  showAiChatAssetMenu: 'chat:asset-menu',
  readAiChatHistory: 'chat-history:read',
  writeAiChatHistory: 'chat-history:write',
  checkProviderConnection: 'diagnostics:check-connection',
  checkExternalClientConnection: 'diagnostics:check-external-connection',
  getAccountKeyOptions: 'account:get-key-options',
} as const satisfies {
  [Method in keyof XingmangInvokeContract]: XingmangInvokeContract[Method]['channel']
}

export const ipcEventChannels = {
  onExternalClientInstallProgress: 'external-clients:install-progress',
  onAccountSessionChanged: 'account:session-changed',
  onAccountUsageChanged: 'account:usage-changed',
  onAccountVaultRecovered: 'account:vault-recovered',
  onNavigate: 'navigation:open-page',
  onWindowCloseRequest: 'window:close-request',
  onExternalDeepLink: 'navigation:deep-link-pending',
  onLaunchTool: 'window:launch-tool',
  onNodeRuntimeInstallProgress: 'runtime:node-install-progress',
  onPythonRuntimeInstallProgress: 'runtime:python-install-progress',
  onInstallProgress: 'cli:install-progress',
  onCodexDesktopStatus: 'desktop:codex-status-changed',
  onCodexDesktopInstallProgress: 'desktop:codex-install-progress',
  onUpdateState: 'update:state-changed',
  onAccountPaymentWindowTerminal: 'account:payment-window-terminal',
  onAiChatStream: 'chat:stream-event',
} as const satisfies {
  [Method in keyof XingmangEventContract]: XingmangEventContract[Method]['channel']
}
