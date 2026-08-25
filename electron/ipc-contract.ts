import type { AppSettings, AppSettingsUpdate, AppTheme as StoredAppTheme } from './app-settings'
import type {
  ConfigBackupPreview as StoredConfigBackupPreview,
  ConfigBackupReason,
  ConfigBackupSummary as StoredConfigBackupSummary,
  ConfigRestoreResult,
} from './backups'
import type { ProviderId as CatalogProviderId } from './catalog'
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
} from './diagnostics'
import type {
  AppConfigSummary as MainAppConfigSummary,
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
  ToolStatus as MainToolStatus,
  ToolUninstallResult as MainToolUninstallResult,
} from './system-service'
import type {
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
  supportServiceUrl,
  userAgreementUrl,
} from './relay-sites'

export type ProviderId = CatalogProviderId
export type { RelaySite } from './relay-sites'
export type ConfigSaveMode = NativeConfigSaveMode
export type CodexDesktopLaunchMode = MainCodexDesktopLaunchMode
export type AppWindowMode = 'onboarding' | 'dashboard'
export type AppTheme = StoredAppTheme
export type UpdatePhase = MainUpdatePhase
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
export type DesktopAppStatus = MainDesktopAppStatus
export type CodexDesktopLocale = MainCodexDesktopLocale
export type CodexDesktopLocaleStatus = MainCodexDesktopLocaleStatus
export type CodexDesktopLocaleResult = MainCodexDesktopLocaleResult
export type SystemSnapshot = MainSystemSnapshot
export type OfficialChatGptAccount = MainOfficialChatGptAccount
export type OfficialChatGptWindow = MainOfficialChatGptWindow
export type CodexDesktopLaunchResult = MainCodexDesktopLaunchResult
export type ToolUninstallResult = MainToolUninstallResult
export type AppSettingsV2 = AppSettings
export type AppSettingsV2Update = AppSettingsUpdate
export type RepositoryContext = CodexRepositoryContext
export type DiagnosticState = MainDiagnosticState
export type DiagnosticsReport = MainDiagnosticsReport
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
export type CodexSetupStatus = MainCodexSetupStatus
export type CodexReadinessStatus = MainCodexReadinessStatus
export type ProviderConfigSummary = NativeConfigSummary
export type ConfigSaveResult = NativeConfigSaveResult
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
export type AccountLoginInput = NewApiLoginInput

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
export type AccountLoginResult = NewApiLoginResult
export type AccountRegisterInput = NewApiRegisterInput
export type AccountSessionState = NewApiSessionState
export type AccountBalance = NewApiBalance
export type AccountTopupInfo = NewApiTopupInfo
export type AccountTopupAmountInput = NewApiTopupAmountInput
export type AccountTopupAmountQuote = NewApiTopupAmountQuote
export type AccountTopupPaymentInput = NewApiTopupPaymentInput
export interface AccountTopupPaymentResult {
  opened: true
  tradeNo: string | null
}
export interface AccountPaymentWindowTerminalEvent {
  status: 'expired' | 'failed' | 'closed'
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
export type AccountKey = NewApiAccountKey
export type AccountKeysQuery = NewApiAccountKeysQuery
export type AccountKeysPage = NewApiAccountKeysPage
export type AccountKeyCreateInput = NewApiAccountKeyCreateInput
export type AccountKeyUpdateInput = NewApiAccountKeyUpdateInput

export interface AccountKeyCliConfigurationInput {
  provider: ProviderId
  keyId: number
  model: string
  mode: ConfigSaveMode
}
export type AccountChangePasswordInput = NewApiChangePasswordInput
export type AccountChangePasswordResult = NewApiChangePasswordResult
export type RendererNavigationTarget = 'settings'

export interface AccountManagedCliConfigurationInput {
  providers: ProviderId[]
  preferredModels: Partial<Record<ProviderId, string>>
}

export interface RendererErrorPayload {
  message: string
  stack?: string
  context?: string
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

export type AiChatStreamEvent =
  | { requestId: string; type: 'content'; content: string }
  | { requestId: string; type: 'reasoning'; content: string }
  | { requestId: string; type: 'complete' }
  | { requestId: string; type: 'canceled'; mayStillComplete?: boolean }
  | { requestId: string; type: 'error'; message: string }

export interface AiChatCancelResult {
  canceled: boolean
  mayStillComplete: boolean
}

export interface InstallProgress {
  provider: ProviderId
  state: 'started' | 'output' | 'success' | 'error'
  message: string
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
  scanSystem: IpcInvokeDefinition<'system:scan', [forceRefresh?: boolean], SystemSnapshot>
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
   * 把某个 CLI 切回用户自己的官方订阅账号(只收回星芒写进去的键,官方登录
   * 凭据一个字节不碰,见 config-files.ts 的 switchProviderToOfficialAccount)。
   * 切回星芒走既有的 config:save,不另开通道。
   */
  switchToOfficialAccount: IpcInvokeDefinition<
    'config:switch-to-official-account',
    [provider: ProviderId],
    ConfigSaveResult
  >
  listModels: IpcInvokeDefinition<'models:list', [apiKey: string], string[]>
  listConfiguredModels: IpcInvokeDefinition<'models:list-configured', [provider: ProviderId], string[]>
  chooseWorkspace: IpcInvokeDefinition<'workspace:choose', [], string | null>
  getRepositoryContext: IpcInvokeDefinition<'repository:get-context', [], RepositoryContext>
  installNodeRuntime: IpcInvokeDefinition<'runtime:install-node', [], NodeRuntimeInstallResult>
  restartWindows: IpcInvokeDefinition<'runtime:restart-windows', [], void>
  installPythonRuntime: IpcInvokeDefinition<'runtime:install-python', [], PythonRuntimeInstallResult>
  installCli: IpcInvokeDefinition<'cli:install', [provider: ProviderId], void>
  uninstallCli: IpcInvokeDefinition<'cli:uninstall', [provider: ProviderId], ToolUninstallResult>
  checkCliUpdate: IpcInvokeDefinition<'cli:check-update', [provider: ProviderId], CliStatus>
  getCodexSetupStatus: IpcInvokeDefinition<'setup:codex-status', [], CodexSetupStatus>
  installCodexDesktop: IpcInvokeDefinition<'desktop:install-codex', [], CodexDesktopInstallResult>
  uninstallCodexDesktop: IpcInvokeDefinition<'desktop:uninstall-codex', [], ToolUninstallResult>
  checkCodexDesktopUpdate: IpcInvokeDefinition<'desktop:check-update-codex', [], DesktopAppStatus>
  launchCli: IpcInvokeDefinition<'cli:launch', [provider: ProviderId, workspace: string], void>
  getCodexDesktopStatus: IpcInvokeDefinition<'desktop:codex-status', [], DesktopAppStatus>
  inspectCodexDesktopLocale: IpcInvokeDefinition<
    'desktop:codex-locale-status',
    [],
    CodexDesktopLocaleStatus
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
  getSettings: IpcInvokeDefinition<'settings:get', [], AppSettingsV2>
  saveSettings: IpcInvokeDefinition<'settings:save', [settings: AppSettingsV2Update], AppSettingsV2>
  runDiagnostics: IpcInvokeDefinition<'diagnostics:run', [], DiagnosticsReport>
  exportDiagnostics: IpcInvokeDefinition<'diagnostics:export', [], { outputPath: string } | null>
  getRuntimeLogs: IpcInvokeDefinition<'runtime-logs:list', [limit?: number], RuntimeLogSnapshot>
  copyFeedbackReport: IpcInvokeDefinition<'runtime-logs:copy-feedback', [], { entries: number }>
  exportFeedbackReport: IpcInvokeDefinition<'runtime-logs:export-feedback', [], { outputPath: string } | null>
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
  getAccountStatus: IpcInvokeDefinition<'account:get-status', [], AccountStatus>
  getLegalDocument: IpcInvokeDefinition<'account:get-legal-document', [kind: LegalDocumentKind], LegalDocument>
  loginAccount: IpcInvokeDefinition<'account:login', [input: AccountLoginInput], AccountLoginResult>
  logoutAccount: IpcInvokeDefinition<'account:logout', [], void>
  getAccountSession: IpcInvokeDefinition<'account:get-session', [], AccountSessionState>
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
  sendPasswordResetCode: IpcInvokeDefinition<'account:send-reset-code', [email: string], void>
  resetPassword: IpcInvokeDefinition<
    'account:reset-password',
    [input: AccountResetPasswordInput],
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
  getRememberedAccountLogin: IpcInvokeDefinition<'account:get-remembered-login', [], RememberedAccountLogin | null>
  setRememberedAccountLogin: IpcInvokeDefinition<'account:set-remembered-login', [input: RememberedAccountLogin | null], void>
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
}

export interface XingmangEventContract {
  onNavigate: IpcEventDefinition<'navigation:open-page', RendererNavigationTarget>
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
  refreshOfficialChatGptUsage: 'system:refresh-official-chatgpt',
  getCodexReadiness: 'startup:codex-readiness',
  getConfig: 'config:get',
  revealApiKey: 'config:reveal-api-key',
  saveConfig: 'config:save',
  switchToOfficialAccount: 'config:switch-to-official-account',
  chooseWorkspace: 'workspace:choose',
  getRepositoryContext: 'repository:get-context',
  installNodeRuntime: 'runtime:install-node',
  restartWindows: 'runtime:restart-windows',
  installPythonRuntime: 'runtime:install-python',
  installCli: 'cli:install',
  uninstallCli: 'cli:uninstall',
  checkCliUpdate: 'cli:check-update',
  getCodexSetupStatus: 'setup:codex-status',
  installCodexDesktop: 'desktop:install-codex',
  uninstallCodexDesktop: 'desktop:uninstall-codex',
  checkCodexDesktopUpdate: 'desktop:check-update-codex',
  launchCli: 'cli:launch',
  getCodexDesktopStatus: 'desktop:codex-status',
  inspectCodexDesktopLocale: 'desktop:codex-locale-status',
  setCodexDesktopLocale: 'desktop:set-codex-locale',
  launchCodexDesktop: 'desktop:launch-codex',
  listModels: 'models:list',
  listConfiguredModels: 'models:list-configured',
  setWindowMode: 'window:set-mode',
  setWindowTheme: 'window:set-theme',
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
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  runDiagnostics: 'diagnostics:run',
  exportDiagnostics: 'diagnostics:export',
  getRuntimeLogs: 'runtime-logs:list',
  copyFeedbackReport: 'runtime-logs:copy-feedback',
  exportFeedbackReport: 'runtime-logs:export-feedback',
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
  getAccountStatus: 'account:get-status',
  getLegalDocument: 'account:get-legal-document',
  loginAccount: 'account:login',
  logoutAccount: 'account:logout',
  getAccountSession: 'account:get-session',
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
} as const satisfies {
  [Method in keyof XingmangInvokeContract]: XingmangInvokeContract[Method]['channel']
}

export const ipcEventChannels = {
  onNavigate: 'navigation:open-page',
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
