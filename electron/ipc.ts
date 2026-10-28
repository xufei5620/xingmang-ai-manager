import { ipcMain, type WebContents } from 'electron'
import type { AppSettingsUpdate, AppTheme } from './app-settings'
import { classifyNetworkFailure } from './network-failure'
import type { ExternalDeepLink } from './external-deep-links'
import type { SavedAccountsStore } from './saved-accounts'
import type { ConfigBackupStore } from './backups'
import type { AnnouncementReadStore } from './announcement-read-store'
import { accelerationFailureReason, type AccelerationApi, type AccelerationPreferenceApi } from './acceleration-contract'
import type { ProviderId } from './catalog'
import type { ManagedKeyReplacementStore } from './managed-key-replacement-store'
import type { ManagedCliKeyStoreLike } from './account-cli-provisioner'
import { requestDiagnosticsOf } from './request-diagnostics'
import { usageArgumentChannels, type UsageOperation } from './usage-stats'
import type { CodexExtensionService } from './codex-extensions'
import { ProviderExtensionService } from './provider-extensions'
import { CodexSessionsService } from './codex-sessions'
import { ProviderSessionsService } from './provider-sessions'
import type { ExternalToolId } from './external-tool-config'
import type { ExternalClientCheckResult } from './external-client-connection'
import { isTrustedIpcSenderUrl, type ApplicationUrlPolicy } from './security'
import type { SystemSnapshot, SystemService } from './system-service'
import type { ProviderConfigRoots } from './codex-home'
import type { UpdateSnapshot, UpdaterService } from './updater'
import type { RelayBackendClient, RelayNotice } from './relay-backend'
import type { AccountGroupHints } from './managed-cli-groups'
import type { CliModelHints } from './cli-model-defaults'
import type { AiAssetStore } from './ai-asset-store'
import type { AiChatService } from './ai-chat-service'
import type { AiImageService } from './ai-image-service'
import type { AiVideoAssetStore } from './ai-video-asset-store'
import type { AiVideoService } from './ai-video-service'
import type { ChatCredentialCoordinator } from './chat-credential-coordinator'
import type {
  RememberedAccountLogin,
  RendererActivity,
  RendererErrorPayload,
  WindowCapabilities,
  AppUninstallRequest,
  AppUninstallResult,
} from './ipc-contract'
import { ipcChannelPolicies, type IpcInvokeChannel } from './ipc-channel-policy'
import type { DiagnosticsReport, DiagnosticsRunOptions } from './diagnostics'
import type { ConnectionCheckResult, ConnectionProbeReport } from './connection-check'
import type { RuntimeLogStore } from './runtime-log'
import type { ExternalShellLauncher } from './system-shell'
import type { NetworkSettingsKind, ProxyBypassOutcome } from './proxy-bypass'
import type { StaleProxyClearResult } from './stale-proxy-environment'
import type { DiagnosticFixKind, DiagnosticFixResult } from './diagnostic-fixes'
import type { PaymentWindowController } from './payment-window'
import type { AccountStartupGate } from './account-startup-gate'
import type { AiChatHistoryStore } from './ai-chat-history-store'
import type { ChatAttachmentService } from './ai-chat-attachments'
import { isRecord } from './input-guards'
import {
  accelerationStateLogKey,
  ipcLogDetail,
  ipcSuccessLevel,
  ipcSuccessMessage,
  readsCachedExternalClientsOnly,
  SLOW_POLLING_SUCCESS_MS,
} from './ipc/handler-log'
import { createIpcHandlerContext, type TrustedIpcHandler } from './ipc/handlers/context'
import { registerSystemHandlers } from './ipc/handlers/system'
import { registerConfigHandlers } from './ipc/handlers/config'
import { registerExternalClientHandlers } from './ipc/handlers/external-clients'
import { registerLaunchHandlers } from './ipc/handlers/launch'
import { registerToolHandlers } from './ipc/handlers/tools'
import { registerWindowHandlers } from './ipc/handlers/window'
import { registerUpdateHandlers } from './ipc/handlers/updates'
import { registerSessionHandlers } from './ipc/handlers/sessions'
import { registerSettingsHandlers } from './ipc/handlers/settings'
import { registerDiagnosticsHandlers } from './ipc/handlers/diagnostics'
import { registerRuntimeLogHandlers } from './ipc/handlers/runtime-logs'
import { registerBackupHandlers } from './ipc/handlers/backups'
import { registerExtensionHandlers } from './ipc/handlers/extensions'
import { registerAccountHandlers } from './ipc/handlers/account'
import { registerAccelerationHandlers } from './ipc/handlers/acceleration'
import { registerAccountBillingHandlers } from './ipc/handlers/account-billing'
import { registerAccountUsageHandlers } from './ipc/handlers/account-usage'
import { registerAccountKeyHandlers } from './ipc/handlers/account-keys'
import { registerAiChatHandlers } from './ipc/handlers/ai-chat'
import { registerAiVideoHandlers } from './ipc/handlers/ai-video'
import { registerDataTransferHandlers } from './ipc/handlers/data-transfer'
import { registerCodexRemoteHandlers } from './ipc/handlers/codex-remote'
import { registerCodexRemoteWeixinHandlers } from './ipc/handlers/codex-remote-weixin'

export type AppWindowMode = 'onboarding' | 'dashboard'

export interface IpcRegistrationOptions {
  realmAccounts?: import('./realm-account-service').RealmAccountService
  accountWork?: import('./account-work-gate').AccountWorkGate
  accountCredentialsForSite?: (siteId: 'solov' | 'solov-api') => NonNullable<IpcRegistrationOptions['accountCredentials']>
  systemService: SystemService
  // 解析各 CLI 配置目录用的根路径（Codex 认 CODEX_HOME）。省略 = 按当前进程
  // 环境推一份，和 system-service 默认拿到的那份一致（旧行为）。
  providerRoots?: ProviderConfigRoots
  // Windows 上「新建一个项目文件夹」优先建在它下面（starter-workspace.ts，被云盘同步时退到
  // 主目录；macOS 一律建在主目录）；
  // main.ts 传系统「文档」目录（app.getPath('documents')）。省略 = 主目录下的 Documents。
  documentsDirectory?: () => string
  // 新建项目文件夹认的用户主目录（macOS 建在它下面）。省略 = os.homedir()；测试注入，
  // 免得在跑测试的 Mac 上往真实主目录里建文件夹。
  homeDirectory?: () => string
  // 打开工具前试写选中的文件夹（documents-fallback.ts）。省略 = 按当前平台、真去试写；
  // 测试注入，免得只有 Windows 上才走得到这一步。
  workspaceWriteCheck?: { platform: NodeJS.Platform; probe: (directory: string) => Promise<void> }
  // 当前账号的 AI 作品实际存在哪（「文档」不让写时是主目录下的 XingmangAI）；检查页
  // 「打开文件夹」用。main.ts 传启动时定下的位置；省略 = 这颗按钮打不开 AI 作品那一个。
  aiOutputDirectory?: () => string
  // 「搬到新电脑」和「导出这段对话」的保存框默认落在桌面；main.ts 传 app.getPath('desktop')。
  // 省略 = 主目录下的 Desktop。
  desktopDirectory?: () => string
  sessionsService: CodexSessionsService
  providerSessionsService: ProviderSessionsService
  backupStore: ConfigBackupStore
  diagnosticsService: {
    run(options?: DiagnosticsRunOptions): Promise<DiagnosticsReport>
    checkConnection(provider: ProviderId): Promise<ConnectionCheckResult>
    probeCodexResponses?: (expectedAccountScope: string) => Promise<ConnectionProbeReport>
    checkExternalConnection(tool: ExternalToolId): Promise<ExternalClientCheckResult>
    exportLatest(): string
    /** 检查页「清掉这条旧设置」；缺省 = stale-proxy-environment.ts 的真实现。 */
    clearStaleProxy?(): Promise<StaleProxyClearResult>
    /** 检查页「挪开这份设置」「删掉这几项设置」；缺省 = 不支持，点了报一句中文（旧行为无此按钮）。 */
    fix?(kind: DiagnosticFixKind): Promise<DiagnosticFixResult>
    /** 反馈报告「最近一次自检」那段有没有结果；缺省 = 不知道，预览报告时不提醒先去检查。 */
    hasSelfCheckResult?(): boolean
  }
  runtimeLog: RuntimeLogStore
  extensionService: CodexExtensionService
  providerExtensionService: ProviderExtensionService
  // Defaults to a real client talking to the production New-Api instance
  // when the host app does not supply one; tests inject a stub the same way
  // they do for other services. Typed as the backend-agnostic
  // RelayBackendClient (relay-backend.ts), not new-api-client.ts's concrete
  // type -- this module never needs to know which relay backend is active.
  accountService?: RelayBackendClient
  announcementReads?: Pick<AnnouncementReadStore, 'sync'>
  acceleration?: AccelerationApi & Partial<AccelerationPreferenceApi>
  /** 手机遥控 Codex（bootstrap/codex-remote.ts）；省略 = 那几条通道报「暂未准备好」。 */
  codexRemote?: import('./codex-remote-service').CodexRemoteService
  // The server-owned payment form stays in the main process. IPC receives
  // only the user's amount/method choice and delegates the returned form to
  // this isolated window controller without serializing its signed fields.
  paymentWindow: Pick<PaymentWindowController, 'open' | 'openUrl' | 'close' | 'destroy'> & Partial<Pick<PaymentWindowController, 'openQrCode'>>
  // Resolves once main.ts's startup session-restore attempt (see
  // realm-account-service.ts's restoreActive) has settled,
  // success or failure -- awaited by account:get-session so the renderer's
  // very first query on mount never races the async refresh-then-self round
  // trip restoreSession() performs (docs/RECON-new-api.md section D). Never
  // rejects by contract; defaults to an already-resolved promise so tests and
  // any host that never attempts a restore see the pre-existing synchronous
  // behavior unchanged.
  accountSessionReady?: Promise<void>
  /**
   * 启动画面那两条读取（account:get-session、config:get）等账号恢复的上限。不传
   * = 照旧等 accountSessionReady 结束。见 account-startup-gate.ts。
   */
  accountStartupGate?: AccountStartupGate
  savedAccounts?: Pick<SavedAccountsStore, 'list' | 'getSession' | 'remove'>
  urlPolicy: ApplicationUrlPolicy
  previewOnboarding: boolean
  externalUrlAllowlist: readonly string[]
  externalShell?: ExternalShellLauncher
  /** Defaults to Electron's `shell.showItemInFolder`; injectable for tests. */
  revealInFolder?(filePath: string): void | Promise<void>
  updaterService: UpdaterService
  broadcastUpdate(snapshot: UpdateSnapshot): void
  setWindowMode(target: WebContents, mode: AppWindowMode): void
  setWindowTheme(target: WebContents, theme: AppTheme): void
  getWindowCapabilities?(): WindowCapabilities
  /** 界面报告手上有没有事（renderer-release.ts 靠它决定缩到托盘后能不能关掉界面）。不传 = 不管。 */
  onRendererActivity?(target: WebContents, activity: RendererActivity): void
  /**
   * Windows 上这次本身就带着管理员权限在跑（windows-elevation.ts 的 highIntegrity）。为真时
   * platform:get-capabilities 叠上 processElevated，界面不再说会弹授权窗口。缺省 = 不是（旧行为）。
   */
  windowsProcessElevated?: boolean
  /** 见 electron/proxy-bypass.ts；不传 = 不绕（测试与旧调用方）。 */
  bypassBrokenProxy?(): Promise<ProxyBypassOutcome>
  openNetworkSettings?(kind: NetworkSettingsKind): Promise<boolean>
  /** Mac 上打开系统设置的「App 管理」那一页（macos-desktop-app-update.ts 的固定地址）；不传 = 不是 Mac。 */
  openAppManagementSettings?(): Promise<boolean>
  relaunchApp?(): Promise<boolean>
  /**
   * 更新页「确认重启安装」（带 askIfInstalling）前问一句有没有工具在装（已知31）：false = 客户点了
   * 「继续安装」，这次不装。不传 = 不问（测试与旧调用方）。
   */
  confirmUpdateInstall?(): Promise<boolean>
  /**
   * Mac 上「卸载星芒」。backupCliConfigs 由这里给：备份要用本模块里的账号上下文，和
   * 「修好它」同一份。不传 = 这台电脑不支持在星芒里卸载。
   */
  uninstallApp?(request: AppUninstallRequest, backupCliConfigs: () => Promise<void>): Promise<AppUninstallResult>
  takeExternalDeepLink?(target: WebContents): ExternalDeepLink | null
  /** `update` is the parsed request, so a hook can tell which fields the user just changed. */
  onSettingsChanged?(update: AppSettingsUpdate): void
  /** Renderer-side crashes the host may forward to crash reporting. The
   *  payload is the already-validated one, never the raw IPC value. */
  onRendererError?(error: RendererErrorPayload): void
  /**
   * 每次操作结束（成功或失败）都告诉一声，匿名使用统计靠它数装失败、付款页打开慢（usage-stats.ts）。
   * 参数只给装工具那两条通道的第一个（usageArgumentChannels），其余一律不给。缺省 = 不数。
   * 它抛错也不影响这次操作的结果。
   */
  observeOperation?(operation: UsageOperation): void
  onSystemSnapshot?(snapshot: SystemSnapshot): void
  /** 客户点了首页的「重新检测」（system:scan 带 recheckRoutes）：叫工具线路马上查一轮。 */
  onRouteRecheckRequested?(): void
  /**
   * 开机拉起时的安静期（login-launch.ts）。期间工具检测、启动时检查更新、账号 Key
   * 初始化都等它结束再做；首页那次读取只回上次落盘的结果、不起真扫描。缺省 = 不等。
   */
  startupQuiet?: { active(): boolean; whenOver(): Promise<void> }
  onAccountBalance?(balance: Awaited<ReturnType<RelayBackendClient['getBalance']>>): void
  /** 渲染层读到了当前账号的订阅；托盘靠它说「订阅剩余多少」，不自己去读。 */
  onAccountSubscription?(subscription: Awaited<ReturnType<RelayBackendClient['getSubscriptionSelf']>>): void
  /** 渲染层读到了公告：界面关着时主进程拿它比对有没有新公告（released-renderer-watch.ts）。 */
  onAccountNotice?(notice: RelayNotice | null): void
  // Opens (or focuses, if already open) the isolated canvas window. Kept as
  // a plain callback -- not a CanvasWindowController -- so this module never
  // has to depend on canvas-window.ts's full surface just to delegate one
  // button click.
  openCanvasWindow(): Promise<void>
  // Backing store for the "记住密码" credential (account-credential-store.ts,
  // safeStorage-encrypted). Optional the same way accountService is: main.ts
  // always passes the real store; when absent (tests that predate it), the
  // read reports "nothing remembered" and writes are dropped.
  accountCredentials?: {
    read(): Promise<RememberedAccountLogin | null>
    save(identifier: string, password: string): Promise<void>
    clear(): Promise<void>
  }
  managedCliKeys?: ManagedCliKeyStoreLike
  // 服务状态文件里的分组对照（service-status.ts 的 accountGroups）：签 Key、画图技能、AI 对话默认分组
  // 先看它，站上改了分组本名也跟得上。缺省 = 不看对照，照旧按写死的名字和工具专属词认。
  accountGroupHints?: () => Promise<AccountGroupHints | null>
  // 同上，但不等：状态文件这次启动还没读成过给 undefined。三把 Key 都缓存的开机同步拿它看对照改没改，
  // 不为它等状态文件（#1157 第 8 条）。缺省 = 照旧等 accountGroupHints。
  peekAccountGroupHints?: () => AccountGroupHints | null | undefined
  // 服务状态文件里的型号表（service-status.ts 的 cliModels）：登录后签 Key、写配置时挑默认型号先看它。
  // 缺省 = 只用程序自带的那份（cli-model-defaults.ts）。
  cliModelHints?: () => Promise<CliModelHints | null>
  // 服务状态文件里的充值方式开关（service-status.ts 的 paymentMethodsOff），这台电脑该藏的付款方式（小写的 type）。
  // 缺省 = 一种也不藏。
  hiddenPaymentMethods?: () => Promise<readonly string[]>
  // 撤销一把设了限制、工具正在用的 Key 时记下的限制（managed-key-replacement-store.ts），
  // 换新时照抄。缺省用内存版：测试与预览不落盘。
  keyReplacements?: ManagedKeyReplacementStore
  chatKeyStore?: {
    removeByKeyId(userId: number, keyId: number): Promise<void>
    read?(userId: number): Promise<import('./chat-key-store').StoredChatKey[]>
  }
  chatCredentials?: ChatCredentialCoordinator
  chatService?: AiChatService
  imageService?: AiImageService
  aiAssets?: AiAssetStore
  chatHistory?: AiChatHistoryStore
  chatAttachments?: ChatAttachmentService
  // 视频剪辑页出视频片段；片段和拼好的成片都放进这个全局作品库（画布的全局素材也是它）。
  videoService?: Pick<AiVideoService, 'generate' | 'resumeRequest' | 'cancel' | 'cancelSender' | 'cancelAll'>
  videoAssets?: Pick<AiVideoAssetStore, 'readOwned' | 'storeComposed' | 'resolveOwnedFilePath' | 'saveAs'>
  transformSystemSnapshot?: (snapshot: SystemSnapshot) => SystemSnapshot
  // Bundled 星芒AI skill: login copies the template into user skill roots and
  // writes the image-group key into config.json. Optional so existing IPC
  // tests keep the previous "CLI keys only" sync behavior.
  xingmangAiSkill?: {
    bundledRoot: string
    userHome: string
    syncImageMcp?: (input: { skillDirectory: string; officialCodex: boolean }) => Promise<string[]>
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function') && 'then' in value)
}

export function registerIpcHandlers(options: IpcRegistrationOptions): () => void {
  const registeredChannels: string[] = []
  const startupGate = options.accountStartupGate
  const accountSessionReady = options.accountSessionReady ?? Promise.resolve()
  let lastAccelerationStateLogKey: string | null = null
  // 上一次失败了的轮询通道：下一次成功要照记 info，看得出什么时候恢复的。
  const failedPollingChannels = new Set<string>()
  const registerTrustedHandler = (channel: IpcInvokeChannel, handler: TrustedIpcHandler): void => {
    registeredChannels.push(channel)
    const policy = ipcChannelPolicies[channel]
    ipcMain.handle(channel, (event, ...args) => {
      const startedAt = Date.now()
      const observe = (failed: boolean, error?: unknown) => {
        try {
          options.observeOperation?.({ channel, args: usageArgumentChannels.has(channel) ? args.slice(0, 1) : [], durationMs: Date.now() - startedAt, failed, ...(failed ? { error } : {}) })
        } catch {
          // Counting is best effort; it must never turn a finished operation into a failure.
        }
      }
      const recordSuccess = (result: unknown) => {
        observe(false)
        if (policy.log === 'quiet-success' || policy.log === 'silent') return
        if (channel === 'acceleration:get-state') {
          const key = accelerationStateLogKey(result)
          if (key !== null && key === lastAccelerationStateLogKey) return
          lastAccelerationStateLogKey = key
        }
        if (channel === 'acceleration:stop' && isRecord(result) && typeof result.phase === 'string'
          && ['connecting', 'active', 'stopping', 'error'].includes(result.phase)) {
          options.runtimeLog.log('warn', 'ipc', channel, '停止加速尚未完成，已保留恢复状态', {
            durationMs: Date.now() - startedAt, phase: result.phase,
          })
          return
        }
        const durationMs = Date.now() - startedAt
        const polling = policy.log === 'polling'
        const recovered = polling && failedPollingChannels.delete(channel)
        const routinePoll = polling && !recovered && durationMs < SLOW_POLLING_SUCCESS_MS
        const loggedArgs = policy.log === 'secret-input' ? [] : args
        options.runtimeLog.log(
          routinePoll ? 'debug' : ipcSuccessLevel(channel),
          'ipc',
          channel,
          ipcSuccessMessage(channel, loggedArgs, result),
          { ...ipcLogDetail(channel, loggedArgs, result, durationMs), ...(recovered ? { recovered: true } : {}) },
        )
      }
      const recordFailure = (error: unknown) => {
        observe(true, error)
        if (policy.log === 'polling') failedPollingChannels.add(channel)
        if (policy.log === 'silent') return
        const reason = error instanceof Error ? error.message : String(error)
        const label = policy.label ?? channel
        // 受限网络下最贵的排查成本是「日志里只写了一句请求失败」。归得出原因就
        // 单列一个字段，客服和诊断导出不用再从错误文本里猜 DNS 还是证书。
        const networkFailure = classifyNetworkFailure(error)
        // 同理：加速那条线把失败收成一句话，日志里看不出是临时目录、辅助进程
        // 还是本机账本。归类由主进程自己给出，单列一个字段便于按原因检索。
        const accelerationReason = accelerationFailureReason(error)
        // 账号请求失败时这一次走的线路、服务器回的状态码和请求编号（三线路 7b）：客户说「登不上」，
        // 客服拿请求编号就能请服务端查到这一次，不用再从前后几行日志里猜。
        const request = requestDiagnosticsOf(error)
        options.runtimeLog.log('error', 'ipc', channel, `${label}失败：${reason || '未知错误'}`, {
          durationMs: Date.now() - startedAt,
          error,
          ...(networkFailure ? { networkFailure } : {}),
          ...(accelerationReason ? { accelerationReason } : {}),
          ...(request ? { request } : {}),
        })
      }
      const senderUrl = event.senderFrame?.url ?? event.sender.getURL()
      if (!isTrustedIpcSenderUrl(senderUrl, options.urlPolicy)) {
        options.runtimeLog.log('warn', 'security', 'ipc.denied', '已拒绝非应用页面的 IPC 请求', { channel })
        throw new Error('已拒绝来自非应用页面的操作请求')
      }
      try {
        const scoped = policy.account !== 'none' && !readsCachedExternalClientsOnly(channel, args)
        // scoped-queued 的处理函数交给安装队列时自己拿 accountWork.queue()（#1085），这里不再包一层。
        const invoke = () => scoped && options.accountWork && policy.account !== 'scoped-queued'
          ? options.accountWork.run(() => handler(event, ...args), { checkRevision: policy.account !== 'scoped-may-end-session' }) : handler(event, ...args)
        // Bootstrap requests config and session concurrently. The first
        // config read must not turn an in-progress restore into a failed boot.
        // Only the bootstrap config read may stop waiting at the startup
        // budget; it then runs outside the account work gate (which refuses
        // work mid-restore) and reports ownership as pending.
        const result = scoped && options.realmAccounts
          ? channel === 'config:get' && startupGate
            ? startupGate.released.then(() => startupGate.pending() ? handler(event, ...args) : accountSessionReady.then(invoke))
            : accountSessionReady.then(invoke)
          : invoke()
        if (isPromiseLike(result)) {
          return Promise.resolve(result).then((value) => {
            recordSuccess(value)
            return value
          }, (error: unknown) => {
            recordFailure(error)
            throw error
          })
        }
        recordSuccess(result)
        return result
      } catch (error) {
        recordFailure(error)
        throw error
      }
    })
  }
  const ctx = createIpcHandlerContext({ options, registerTrustedHandler, startupGate, accountSessionReady })
  const unsubscribeUpdates = options.updaterService.subscribe(options.broadcastUpdate)
  // 每个域把自己的通道交给 registerTrustedHandler；先后不影响哪个处理器接哪条通道。
  registerSystemHandlers(ctx)
  const disposeConfig = registerConfigHandlers(ctx)
  registerExternalClientHandlers(ctx)
  registerLaunchHandlers(ctx)
  registerToolHandlers(ctx)
  registerWindowHandlers(ctx)
  registerUpdateHandlers(ctx)
  registerSessionHandlers(ctx)
  registerSettingsHandlers(ctx)
  registerDiagnosticsHandlers(ctx)
  const disposeRuntimeLog = registerRuntimeLogHandlers(ctx)
  registerBackupHandlers(ctx)
  registerExtensionHandlers(ctx)
  registerAccountHandlers(ctx)
  registerAccelerationHandlers(ctx)
  registerAccountBillingHandlers(ctx)
  registerAccountUsageHandlers(ctx)
  registerAccountKeyHandlers(ctx)
  registerAiChatHandlers(ctx)
  registerAiVideoHandlers(ctx)
  registerDataTransferHandlers(ctx)
  registerCodexRemoteHandlers(ctx)
  registerCodexRemoteWeixinHandlers(ctx)

  return () => {
    disposeConfig()
    disposeRuntimeLog()
    ctx.sensitiveClipboard.dispose()
    unsubscribeUpdates()
    options.chatService?.dispose()
    options.imageService?.cancelAll()
    options.videoService?.cancelAll()
    for (const channel of registeredChannels) ipcMain.removeHandler(channel)
  }
}
