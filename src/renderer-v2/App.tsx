import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { flushSync } from 'react-dom'
import QRCode from 'qrcode'
import type { AccountSessionState, AccountSourceSwitchResult, AccountSourceTarget, AppSettingsV2, ExternalDeepLink, ExternalToolId, LegalDocumentKind, NetworkSettingsKind, PlatformCapabilities, ProviderId, UpdateSnapshot, XingmangApi } from '../../electron/ipc-contract'
import { resolveRelaySite, resolveSupportServiceUrl } from '../../electron/relay-sites'
import { appReleaseDownloadUrl } from '../../electron/app-download-page'
import { offersCodexDesktopRestart } from '../../electron/running-tools'
import { claudeDesktopDownloadPageUrl } from '../../electron/claude-desktop-install-failure'
import { codexDesktopStoreUrl } from '../../electron/codex-desktop-install-failure'
import { Shell as AppFrame } from './features/shell/Shell'
import { createChatTransfer } from './features/chat/transfer'
import { isOffline, offlineActionMessage, offlineCause } from './features/shell/online-status'
import { OnlineStatusContext, useBrowserOnline, type OnlineStatus } from './features/shell/useOnlineStatus'
import { buildEnvironmentStatus, publishDiagnosticsCounts, useDiagnosticsCounts } from './features/app/environment-status'
import { createAppApi } from './features/app/api'
import { AuthFlow, LegalDocument, Splash, StartGuide, Welcome, createAuthApi, guideOfficialLoginRequired, type AuthMode, type GuideToolState, type LoginTarget } from './features/auth'
import { ConfigDialog } from './features/tools/ConfigDialog'
import { ExternalClientDialog } from './features/tools/ExternalClientDialog'
import { Home } from './features/tools/Home'
import { visibleExternalClients } from './features/tools/external-model'
import { createToolsApi } from './features/tools/api'
import { launchWaitLabel, launchWarning } from './features/tools/launch-notice'
import { modelSwapOffer, modelSwapQuestion, type ModelSwapChoice, type ModelSwapOffer } from './features/tools/model-check'
import { chineseRuntimePatchAnswerMissing, shouldAskForChineseRuntimePatch } from './features/tools/chinese-runtime-choice'
import { offersCodexDesktopRestartOnOpen } from './features/tools/codex-desktop-open'
import { cliInstallStageLabel, cliNeedsNodeRuntime, cliNeedsPythonRuntime, nodeRuntimeReady, planCliInstall, pythonRuntimeReady, runtimeStageFailureMessage, type InstallRuntimeId } from './features/tools/runtime-readiness'
import { canSwitchToManagedInstall, codexNeedsRepair, foreignKeyKind, isToolId, presentTools, providerFor, readyOnceRepaired, toolInstallDirectory, toolUpdateOffer, type ToolId, type ToolSource } from './features/tools/model'
import { managedSwitchConfirmation, managedSwitchVersion } from './features/tools/managed-switch'
import { inAppToolUpdates, pendingToolUpdates, readAnnouncedToolUpdates, rememberAnnouncedToolUpdates, rememberRevertedToolUpdate, unannouncedToolUpdates, updateNoticeKey } from './features/tools/update-notice'
import { isMissingWorkspace, type CliLaunchChoice } from './features/tools/recent-workspaces'
import { uninstallHandOffNotice } from './features/tools/uninstall-handoff'
import { describeRuntimeInstallOutcome, type RuntimeInstallOutcome } from './features/tools/runtime-install-outcome'
import { RestartReminder, RuntimeRestartDialog } from './features/tools/RuntimeRestartDialog'
import { guideJobProgress, installedToolSyncLabel, useToolbox } from './features/tools/useToolbox'
import { ManualUninstallDialog, type ManualUninstallState } from './features/tools/ManualUninstall'
import { operationLogPage, type OperationActionId } from './operation-error'
import { accountSwitchAnchor, accountTabs, macDesktopTutorialTopic, settingsGroups, settingsItemAvailable, settingsItems, autoUpdateBubbleBody, updateBubbleRepeatsUpdatesPage, updateBubbleTitle, updateDiskShortfallText, updateFailureLabel, updatesTutorialTopic, type SettingsItem } from './registry/business'
import { tools } from './registry/tools'
import { clientConnections } from './registry/clients'
import { pageRegistry, type PageId } from './registry/pages'
import type { ToolInstallOutcome } from './pages-maintenance'
import type { ToolConfigConfirmation } from './pages-account'
import { BalanceTierProvider, Button, Confirm, Dialog, Notice, Switch, ToastProvider, useToast, useReducedMotion } from './ui'
import { bridge as getBridge } from './bridge'
import { errorMessage, operationFailureFrom, pendingBusinessOperations, userFacingErrorMessage } from './business-common'
import { SavedAccounts } from './SavedAccounts'
import { accountSwitchNeedsAttention } from './account-switch-sync'
import { accountSources } from './features/auth/state'
import { AnnouncementCenter } from './features/shell/Announcement'
import { createAccelerationApi } from './features/acceleration/api'
import { useAcceleration } from './features/acceleration/useAcceleration'
import { useNetworkLocation } from './features/shell/useNetworkLocation'
import { latestNetworkLocation } from './features/shell/network'
import { bindPlatformAppearance, platformApi } from './platform-api'
import { FailureBoundary } from './features/app/FailureBoundary'
import { OperationErrorDialog, supportFailureOf, type OperationFailure } from './features/app/OperationErrorDialog'
import { NodeReplaceDialog } from './features/tools/NodeReplaceDialog'
import { canReplaceNode, describeNodeReplaceOutcome } from './features/tools/node-replace'
import { StartupNotices } from './features/app/StartupNotices'
import { redownloadUpdate, requestUpdateInstallConfirm, retryFailedUpdateStep, updateFailureTone, updateNeedsManualReinstall, updateOffersDownloadPage } from './features/app/update-retry'
import { RequiredUpdateGate } from './features/app/RequiredUpdateGate'
import { MaintenanceNotice, maintenanceNoticeKey } from './features/app/MaintenanceNotice'
import { LaunchInstallNotice } from './features/app/LaunchInstallNotice'
import { claudeDesktopRepairedNotice, crashReportingNotice, displayCompatNotice, displayRelaunchNotice, settingsSaveNotice, toolTemplateFilledNotice, startupCheckFailure, startupCheckLogContext, startupDiagnosticsIssues, unexpectedExitNotice, updatedNotice, vaultRecoveredNotice, withStartupNotice, withoutStartupNotice, type StartupCheckId, type StartupNotice } from './features/app/startup-notice'
import { readLocalPreference, writeLocalPreference } from './features/app/preferences'
import { currentWindowOs, windowOsFor } from './features/app/window-os'
import { nextUiScale, uiScaleShortcutFor, type UiScaleShortcut } from './features/app/ui-scale-shortcut'
import { rememberTourPending, rememberTourSeen, tourReplayPending } from './features/shell/tour-state'
import { onboardingPreviewEnabled } from './features/app/dev-preview'
import { deepLinkReadErrorText, supportQrFallbackText } from './features/app/fallback-messages'
import { SupportIdentity, buildLastFailureLine, buildSupportBundle, buildSupportIdentityLine, linuxSystemDetail, type SupportFailure } from './features/app/SupportIdentity'
import { KeyRewriteSkippedError, bootstrapAccountTools, skippedNamedProviders, describeAccountBootstrapFailure, describeAccountBootstrapResult, type AccountBootstrapLogLine, type AccountBootstrapMode, type AccountBootstrapProgress, type AccountBootstrapResult } from './features/tools/account-bootstrap'
import { rewritableKeyProviders } from './features/tools/connection-check'
import { applyManualSourceMarker, getSourceMarkerStorage } from './features/tools/source-marker'
import { idleOnlineResync, noteBootstrapOutcome, planOnlineResync } from './features/tools/online-resync'
import { accountOrigin, accountScope, accountSiteId, accountSupports, sessionRestoreRetrying, sessionRestoring, sessionScope, siteIdForOrigin, visibleAccountTab, type AccountSiteId } from './account-context'
import { accountReadErrorAction, formatAccountReadError } from './features/app/account-read-error'
import { AccountBalanceContext, useAccountBalanceStore, useUsableSubscription } from './features/app/balance-context'
import { subscriptionSummaryText } from '../../electron/subscription-summary'
import { createSpendSpikeWatch } from './features/app/spend-spike'
import { hasPendingSettingsGroup, requestSettingsGroup } from './features/app/settings-group-intent'
import { requestRowFocus } from './features/app/row-focus'
import { createTemplateFillRetry } from './features/app/template-fill-retry'
import './business.css'

const BusinessPage = lazy(() => import('./pages-business').then((module) => ({ default: module.BusinessPage })))
const ChatPage = lazy(() => import('./features/chat').then((module) => ({ default: module.ChatPage })))
const AccelerationPage = lazy(() => import('./features/acceleration/AccelerationPage').then((module) => ({ default: module.AccelerationPage })))
const pageLoading = <div className="v2-business-loading" role="status" data-testid="route-loading"><RefreshCw size={24} className="xm-spin" aria-hidden="true" /><strong>正在加载页面...</strong></div>

type AccountTab = typeof accountTabs[number]['value']
interface PendingConfirmation { title: string; body: string; label: string; danger?: boolean; /** 失败时「复制路径」要复制哪个工具的安装目录；与工具无关的确认不填。 */ tool?: ToolId; work(): Promise<void> }
interface AccountBootstrapView extends AccountBootstrapProgress {
  scope: string
  result?: AccountBootstrapResult
  error?: string
}

/**
 * 新手引导只认四种来源，没有「被改过」这一档：引导讲的是怎么第一次连上，
 * 而被改过的前提是已经连过一次。这里按它原来对「来源未确认」的讲法折过去，
 * 引导的文案和按钮都不变。
 */
function guideSource(source: ToolSource): GuideToolState['source'] {
  if (source === 'missing') return 'none'
  return source === 'changed' ? 'unknown' : source
}

// 文案固定在主进程，渲染层只给一个事件编号；受设置里的桌面通知开关管。
function notifyAnnouncement(eventKey: string) {
  void platformApi()?.notifyActivity('announcement', eventKey).catch(() => undefined)
}

function RuntimeApp({ native, accelerationPreview = false }: { native: XingmangApi; accelerationPreview?: boolean }) {
  useReducedMotion()
  const app = useMemo(() => createAppApi(native), [native])
  const authApi = useMemo(() => createAuthApi(native), [native])
  const toolsApi = useMemo(() => createToolsApi(native), [native])
  // 「最近」这份列表由 toolsApi 缓存 60 秒（首页切来切去不再反复读盘）。作废缓存
  // 只是让下一次读真去读，首页当时可能正开着，所以同时递增一个版本号把它拉起来重读。
  const [recentRevision, setRecentRevision] = useState(0)
  const refreshRecent = useCallback(() => {
    toolsApi.invalidateRecent()
    setRecentRevision((value) => value + 1)
  }, [toolsApi])
  const toast = useToast()
  const [boot, setBoot] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [bootError, setBootError] = useState('')
  const [bootAttempt, setBootAttempt] = useState(0)
  const [settings, setSettings] = useState<AppSettingsV2 | null>(null)
  const [platform, setPlatform] = useState<PlatformCapabilities | null>(null)
  const [systemLabel, setSystemLabel] = useState<string | undefined>(undefined)
  const [session, setSession] = useState<AccountSessionState>({ authenticated: false, account: null })
  const [update, setUpdate] = useState<UpdateSnapshot | null>(null)
  const [dismissedMaintenance, setDismissedMaintenance] = useState<string | null>(null)
  const [page, setPage] = useState<PageId>('home')
  const [chatScope, setChatScope] = useState<string | null>(null)
  const [visitedPages, setVisitedPages] = useState<Partial<Record<PageId, string>>>({})
  // 带序号：已经停在「我的订单」时再点「充值」，值还是上次那个 'wallet'，
  // 光比值 React 不会重新切过去（全面检测 Q29），同 tutorialTopic。
  // rechargeAmount：从活动卡片点某一档进充值页时带上，充值页直接选好这一档。
  const [accountTab, setAccountTab] = useState<{ sequence: number; value: AccountTab; rechargeAmount?: number }>({ sequence: 0, value: 'overview' })
  // 教程页停在哪一章。页面挂上之后只是 hidden 不会重新挂载，所以每次跳转都换一个
  // sequence，教程页才接得住第二次、第三次跳过来。
  const [tutorialTopic, setTutorialTopic] = useState<{ sequence: number; id: string; query?: string; extra?: string } | null>(null)
  // 设置页只在挂载时取一次要落的分组（settings-group-intent），已经打开过再点名
  // 某一组就换个 key 让它重新挂一次，否则会停在上次看的那组（全面检测 Q48）。
  const [settingsRequest, setSettingsRequest] = useState(0)
  const [guide, setGuide] = useState(false)
  const [workspaceEntered, setWorkspaceEntered] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)
  const [auth, setAuth] = useState<AuthMode | null>(null)
  // 登录框要预先对准的保存账号（#480）；只有「重新登录这个账号」给，关框就清。
  const [authTarget, setAuthTarget] = useState<LoginTarget | null>(null)
  const [legal, setLegal] = useState<LegalDocumentKind | null>(null)
  const [configTool, setConfigTool] = useState<ToolId | null>(null)
  const [toolConfigConfirmed, setToolConfigConfirmed] = useState<ToolConfigConfirmation | null>(null)
  const [codexModelFilter, setCodexModelFilter] = useState<'all' | 'non-gpt'>('all')
  const [externalClient, setExternalClient] = useState<ExternalToolId | null>(null)
  const openToolConfig = (tool: ToolId) => { setCodexModelFilter('all'); setConfigTool(tool) }
  const [help, setHelp] = useState(false)
  const [accelerationHelp, setAccelerationHelp] = useState(false)
  const [switcher, setSwitcher] = useState(false)
  const [announcementOpen, setAnnouncementOpen] = useState(false)
  const [unread, setUnread] = useState(false)
  const [pendingLink, setPendingLink] = useState<ExternalDeepLink | null>(null)
  const [inviteCode, setInviteCode] = useState('')
  const linkPrompted = useRef(false)
  const [paymentReturn, setPaymentReturn] = useState<{ sequence: number; order: string | null }>()
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const [runtimeRestart, setRuntimeRestart] = useState(false)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [restartDialog, setRestartDialog] = useState(false)
  // 首页一键切换账号来源之后 Codex 桌面端还开着：问一次要不要替用户重开，记下切到了哪边。
  const [switchRestartOffer, setSwitchRestartOffer] = useState<AccountSourceTarget | null>(null)
  const [ccSwitchReminder, setCcSwitchReminder] = useState(false)
  const [modelSwap, setModelSwap] = useState<{ offer: ModelSwapOffer; answer: (choice: ModelSwapChoice) => void } | null>(null)
  // 官方安装器装的 Claude Code 换成星芒装的之前那一问（第三十一批 B）；answer(false) = 不换。
  const [managedSwitch, setManagedSwitch] = useState<{ version: string; answer: (confirmed: boolean) => void } | null>(null)
  const pendingManagedSwitch = useRef<((confirmed: boolean) => void) | null>(null)
  /** 换模型弹框还开着时切了账号，要替用户点掉：那是上一个账号的提问（#538）。 */
  const pendingModelSwap = useRef<((choice: ModelSwapChoice) => void) | null>(null)
  const [chineseDialog, setChineseDialog] = useState(false)
  const chineseDecline = useRef<HTMLButtonElement>(null)
  const [dismissedUpdate, setDismissedUpdate] = useState('')
  const [updateRetrying, setUpdateRetrying] = useState(false)
  const [operationError, setOperationError] = useState<OperationFailure | null>(null)
  // 帮助框「最近一次出错」：错误框关掉以后客户才想起来找客服，那时错误已经不在屏上了。
  const [lastFailure, setLastFailure] = useState<SupportFailure | null>(null)
  // 错误框里点了「换成新版 Node.js」：先问一次，确认后换完接着重做刚才失败的那一步。
  const [nodeReplace, setNodeReplace] = useState<{ retry?: () => void } | null>(null)
  // 国内下载线路还没跟上微软商店时，这次「更新」其实没换版本：说一句，并给出去商店的按钮。
  const [storeNewerVersion, setStoreNewerVersion] = useState<string | null>(null)
  const [startupNotices, setStartupNotices] = useState<readonly StartupNotice[]>([])
  const [manualUninstall, setManualUninstall] = useState<ManualUninstallState | null>(null)
  const [accountReadError, setAccountReadError] = useState<{ scope: string; message: string } | null>(null)
  const [supportQr, setSupportQr] = useState<{ url: string; data: string | null }>()
  const accountEpoch = useRef(0)
  const mounted = useRef(true)
  const confirmationLock = useRef(false)
  const launchRequest = useRef<{ epoch: number } | null>(null)
  const diagnosticsStarted = useRef(false)
  const previousBalance = useRef<{ scope: string; value: number } | null>(null)
  const bootstrapEpoch = useRef(0)
  const bootstrapInFlight = useRef<{ scope: string; promise: Promise<void> } | null>(null)
  const bootstrapAttempts = useRef(new Set<string>())
  const suppressRestoredBootstrap = useRef(new Set<string>())
  const onlineResync = useRef(idleOnlineResync())
  const resumeOnline = useRef<(() => void) | null>(null)
  const [accountBootstrap, setAccountBootstrap] = useState<AccountBootstrapView | null>(null)
  // 会话变化事件来过几次。启动那次读取可能在事件之后才落地（账号恢复超时先放行
  // 时两者会赛跑），那时手上的会话已经比它新，不能再拿它盖回去。
  const sessionEvents = useRef(0)
  const scope = sessionScope(session)
  // 开机账号恢复超过了启动画面的等待上限：先进首页，按正在恢复的账号显示，
  // 恢复结束再补读一次配置（见 onAccountSessionChanged）。
  const restoring = sessionRestoring(session)
  const restoreRetrying = sessionRestoreRetrying(session)
  function cancelPendingLaunchDialogs() {
    pendingModelSwap.current?.('cancel')
    pendingModelSwap.current = null
    setModelSwap(null)
    setRestartDialog(false)
    setSwitchRestartOffer(null)
    setChineseDialog(false)
  }
  const toolbox = useToolbox(native, boot === 'ready' && (session.authenticated || restoring || guide || workspaceEntered), scope)
  const accelerationApi = useMemo(() => createAccelerationApi(native), [native])
  // Linux 第一版不带加速（platformCapabilitiesFor 的 acceleration）：页面、搜索、领时长都不出现，
  // 也不去读加速状态。能力回来之前按窗口的系统先判断，免得 Linux 上侧栏先闪一下「游戏加速」。
  const accelerationAvailable = platform ? platform.acceleration !== false : currentWindowOs() !== 'linux'
  const acceleration = useAcceleration(accelerationApi, session.authenticated && accelerationAvailable ? scope : null)
  const networkLocation = useNetworkLocation(native, acceleration.snapshot.state)
  // 没在加速时不再定时读状态，所以进加速页时读一次：托盘或 Codex 桌面端可能刚连上过。
  const refreshAcceleration = acceleration.refresh
  useEffect(() => { if (page === 'acceleration') void refreshAcceleration() }, [page, refreshAcceleration])
  const { store: balanceStore, snapshot: balanceState } = useAccountBalanceStore(native, session.authenticated ? scope : null)
  const balance = balanceState.balance
  // 买了订阅的客户钱包常是 0，请求扣的却是订阅：有能用的订阅时不再按钱包喊「余额不足」。
  const { subscription, refresh: refreshSubscription } = useUsableSubscription(native, session.authenticated && accountSupports(session, 'supportsSubscriptions') ? scope : null, balanceState)
  const browserOnline = useBrowserOnline()
  const diagnosticsCounts = useDiagnosticsCounts()
  const offline = isOffline({ browserOnline, networkFailures: session.authenticated ? balanceState.networkFailures : 0 })
  // 安装任务跑到一半要看的是「现在」断没断网（换成星芒装的，动手卸之前），闭包里的 offline 停在点按钮那一刻。
  const offlineNow = useRef(offline)
  offlineNow.current = offline
  const [onlineChecking, setOnlineChecking] = useState(false)
  // 系统说网回来了，不等下一次定时刷新：马上读一次余额，确认真的通了横幅才收起。
  useEffect(() => {
    if (browserOnline && session.authenticated && balanceStore.getSnapshot().networkFailures > 0) void balanceStore.refresh('manual')
  }, [browserOnline, balanceStore, session.authenticated])
  const onlineCause = offline ? offlineCause({ browserOnline, networkFailureReason: balanceState.networkFailureReason }) : undefined
  // 代理连不上时，星芒先替用户试一次直连（只改自己的连接，下次打开软件照旧跟随系统）。
  // 自动只试一次；之后点「重新检测」再试。
  const proxyBypassTried = useRef(false)
  const [proxyBypassNotice, setProxyBypassNotice] = useState(false)
  const tryProxyBypass = useCallback(async () => {
    proxyBypassTried.current = true
    const outcome = await Promise.resolve().then(() => native.bypassBrokenProxy()).catch(() => 'unavailable' as const)
    if (outcome === 'direct' && mounted.current) setProxyBypassNotice(true)
    return outcome === 'direct'
  }, [native])
  useEffect(() => {
    if (onlineCause !== 'proxy' || proxyBypassTried.current) return
    void tryProxyBypass().then((direct) => { if (direct) void balanceStore.refresh('manual') })
  }, [onlineCause, tryProxyBypass, balanceStore])
  const recheckOnline = useCallback(() => {
    if (!navigator.onLine || !session.authenticated) return
    setOnlineChecking(true)
    const bypass = onlineCause === 'proxy' ? tryProxyBypass() : Promise.resolve(false)
    void bypass.then(() => balanceStore.refresh('manual')).finally(() => { if (mounted.current) setOnlineChecking(false) })
  }, [balanceStore, session.authenticated, onlineCause, tryProxyBypass])
  const openNetworkSettings = useCallback((kind: NetworkSettingsKind) => {
    void Promise.resolve().then(() => native.openNetworkSettings(kind)).then((opened) => {
      if (!opened) throw new Error('not-opened')
    }).catch(() => {
      toast.show(kind === 'proxy' ? '没能打开系统代理设置，请在系统设置里找「代理」。' : '没能打开认证页，请打开浏览器随便访问一个网页。', 'warn')
    })
  }, [native, toast])
  const dismissProxyBypassNotice = useCallback(() => setProxyBypassNotice(false), [])
  const onlineStatus = useMemo<OnlineStatus>(() => ({
    offline,
    cause: onlineCause,
    proxyBypassNotice: !offline && proxyBypassNotice,
    checking: onlineChecking,
    recheck: recheckOnline,
    openNetworkSettings,
    dismissProxyBypassNotice,
  }), [offline, onlineCause, proxyBypassNotice, onlineChecking, recheckOnline, openNetworkSettings, dismissProxyBypassNotice])
  // 换账号等于换了一整套上下文：首页那份「最近」和余额卡用量两份缓存（各 60 秒）
  // 必须当场作废，否则切过去的头一眼看到的还是上一个账号在的时候读到的东西。
  useLayoutEffect(() => { accountEpoch.current++; cancelPendingLaunchDialogs(); setAccountReadError(null); refreshRecent(); toolsApi.invalidateBalanceUsage() }, [scope, session.authenticated, refreshRecent, toolsApi])
  const siteId = accountSiteId(session)
  const relaySite = resolveRelaySite(siteId)
  const supportUrl = resolveSupportServiceUrl(session)
  const qr = supportQr?.url === supportUrl ? supportQr.data ?? undefined : undefined
  const qrFallback = supportQrFallbackText(supportQr, supportUrl)
  const avatarIdentity = session.account ? { origin: accountOrigin(session), userId: session.account.userId } : undefined
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; accountEpoch.current++ } }, [])
  // 启动时自动跑的检查不许弹模态框：用户什么都没点，却会被挡在欢迎页上点不动
  // 任何东西。坏消息改挂在角落、随手能关，检查本身照跑、失败照样进运行日志
  // ——主进程按通道记一条，这里再记一条写明是哪一次启动检查。
  const noteStartupCheck = useCallback((notice: StartupNotice) => {
    if (!mounted.current) return
    setStartupNotices((current) => withStartupNotice(current, notice))
    if (!notice.failure) return
    void native.reportRendererError({ message: `${notice.title}：${notice.body}`, context: startupCheckLogContext(notice.id), level: 'warn' }).catch(() => undefined)
  }, [native])
  const dismissStartupNotice = useCallback((id: StartupCheckId) => {
    setStartupNotices((current) => withoutStartupNotice(current, id))
  }, [])
  // 开机那轮工具开着、设置没补成的，隔一阵再要（第二十六批 E）；真补上了照样在角落说一句。
  const templateFillRetry = useMemo(() => createTemplateFillRetry({
    fill: () => native.fillToolTemplateDefaults(true),
    filled: (providers) => {
      const notice = toolTemplateFilledNotice(providers)
      if (notice) noteStartupCheck(notice)
    },
  }), [native, noteStartupCheck])
  useEffect(() => {
    function foreground() {
      if (document.visibilityState !== 'hidden') templateFillRetry.foreground()
    }
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', foreground)
    return () => {
      window.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', foreground)
      templateFillRetry.stop()
    }
  }, [templateFillRetry])
  // 换了账号或退出登录：欠着的是上一个账号的，不再替它要（主进程那边也认账号）。
  useEffect(() => { templateFillRetry.stop() }, [templateFillRetry, scope, session.authenticated])
  useEffect(() => {
    let current = true
    const eventsAtStart = sessionEvents.current
    setBoot('loading'); setBootError('')
    void app.bootstrap().then((result) => {
      if (!current) return
      setSettings(result.settings); setPlatform(result.platform); setUpdate(result.update); setSystemLabel(result.capabilities.systemLabel)
      if (sessionEvents.current === eventsAtStart) setSession(result.session)
      // 低配电脑只由主进程判断一次；这里只把结论挂到根节点上，星空背景据此只画静态一帧。
      document.documentElement.dataset.lowEnd = String(result.capabilities.lowEndDevice === true)
      // 预览开关要等主进程说清这是不是打包版才生效，所以放在 bootstrap 里而不是
      // 初始 state；`boot !== 'ready'` 期间只渲染 Splash，用户看不到中间态。
      if (onboardingPreviewEnabled(window.location.search, result.update.development)) setGuide(true)
      // 本机工具里已经有 Key 也不再绕过欢迎页直接进首页：那样进来的人看不到登录按钮，
      // 退出登录后再开软件也找不回账号。没登录就先到欢迎页，登录或看使用步骤由用户点。
      // 工具配置文件原样保留，终端里照常能用。
      setBoot('ready')
      const updated = updatedNotice(result.update.currentVersion, result.update.installedRelease)
      if (updated) noteStartupCheck(updated)
      const settingsSave = settingsSaveNotice(result.capabilities.settingsSaveIssue)
      if (settingsSave) noteStartupCheck(settingsSave)
      const displayCompat = displayCompatNotice(result.capabilities)
      if (displayCompat) noteStartupCheck(displayCompat)
      const unexpectedExit = unexpectedExitNotice(result.capabilities)
      if (unexpectedExit) {
        noteStartupCheck(unexpectedExit)
        // 帮助框的「最近一次出错」也记上这一次：他没点卡片、直接去找客服时同样带得上。
        if (unexpectedExit.action && 'supportFailure' in unexpectedExit.action) setLastFailure(unexpectedExit.action.supportFailure)
      }
      const claudeDesktopRepaired = claudeDesktopRepairedNotice(result.capabilities, result.platform.platform)
      if (claudeDesktopRepaired) noteStartupCheck(claudeDesktopRepaired)
      if (result.settings.checkUpdatesOnStartup && result.update.phase !== 'disabled') {
        void app.startupUpdate().then((checked) => { if (current) setUpdate(checked) }).catch((cause) => {
          if (current) noteStartupCheck(startupCheckFailure('update', errorMessage(cause, '更新检查没有完成')))
        })
      }
    }).catch((cause) => {
      if (current) { setBootError(errorMessage(cause, '启动检查没有完成')); setBoot('failed') }
    })
    return () => { current = false }
  }, [app, bootAttempt, noteStartupCheck])
  const runAccountBootstrap = useCallback(async (userId: number, mode: AccountBootstrapMode = 'restore', force = false, onlyProviders?: readonly ProviderId[], accountSite: AccountSiteId = siteId) => {
    if (!settings || !Number.isSafeInteger(userId) || userId < 1) return
    const bootstrapScope = accountScope({ siteId: accountSite, account: { userId } as AccountSessionState['account'] })
    const attemptKey = `${bootstrapScope}:${mode}:${onlyProviders?.join(',') ?? 'all'}`
    const existing = bootstrapInFlight.current?.scope === bootstrapScope ? bootstrapInFlight.current.promise : null
    if (!force && bootstrapAttempts.current.has(attemptKey)) return existing ?? undefined
    if (existing) await existing
    bootstrapAttempts.current.add(attemptKey)
    const epoch = ++bootstrapEpoch.current
    const updateProgress = (progress: AccountBootstrapProgress) => {
      if (!mounted.current || epoch !== bootstrapEpoch.current) return
      setAccountBootstrap({ ...progress, scope: bootstrapScope })
    }
    updateProgress({ phase: 'syncing', label: '正在同步账号专属 Key', percent: 5 })
    // 结论要能被调用方读到：这个函数自己把失败收进首页的横幅，而「重新写入 Key」
    // 的人正站在「检查」页上，横幅在他看不见的地方。用对象而不是 let，是因为赋值
    // 发生在闭包里，TypeScript 会把 let 的类型收窄成初始值。
    const outcome: { result?: AccountBootstrapResult; error?: string } = {}
    // 这一轮给哪几家写了、跳过了谁、为什么，只进本机运行日志（info / warn 不上报），
    // 客服拿到报告才看得出「登录成功」和「打开工具」之间发生了什么。
    function logAccountBootstrap(line: AccountBootstrapLogLine) {
      void native.reportRendererError({ message: line.message, context: 'account-bootstrap', level: line.level }).catch(() => undefined)
    }
    const promise = (async () => {
      try {
        const result = await bootstrapAccountTools(native, userId, updateProgress, mode, onlyProviders)
        outcome.result = result
        logAccountBootstrap(describeAccountBootstrapResult(mode, result))
        // 开机恢复只核对连没连上、一个字不写，老客户因此拿不到后来加进模板的设置。
        // 这里让主进程给当前账号写过、版本落后的配置补一次缺省项；补不成只进日志，
        // 真补了才在角落说一句。工具开着没补成的交给 templateFillRetry 隔一阵再要，
        // 等结果这段时间换了账号就不跟了。
        if (mode === 'restore') {
          const fillEpoch = accountEpoch.current
          void Promise.resolve().then(() => native.fillToolTemplateDefaults()).then((filled) => {
            const notice = toolTemplateFilledNotice(filled.filled)
            if (notice) noteStartupCheck(notice)
            if (accountEpoch.current === fillEpoch) templateFillRetry.follow(filled)
          }).catch(() => undefined)
        }
        if (!mounted.current || epoch !== bootstrapEpoch.current) return
        setAccountBootstrap((current) => current && current.scope === bootstrapScope
          ? { ...current, phase: 'verifying', label: result.failed.length ? 'Key 同步完成，部分工具待处理' : 'Key 已写入，正在刷新工具状态', percent: 100, result }
          : current)
        setWorkspaceEntered(true)
        // 只重读配置，不再把整轮环境探测走第二遍：跟着 Key 变的只有配置状态，
        // 已装/版本/桌面端是首屏那遍刚探完的（见 useToolbox.refreshConfig）。
        await toolbox.refreshConfig().catch(() => undefined)
        // 开机那一轮替客户修好了 Codex 认不出的老配置：没人点过按钮，轻轻说一句改了什么、
        // 原样在哪找回。点名重写的那一档由调用方自己报结果，这里不重复。
        if (mode !== 'rewrite' && result.repairedShadowed?.length) toast.show('已修好 Codex 的连接设置，原来的设置在「备份」里。', 'ok')
      } catch (cause) {
        outcome.error = errorMessage(cause, '账号 Key 初始化没有完成')
        logAccountBootstrap(describeAccountBootstrapFailure(mode, outcome.error))
        if (!mounted.current || epoch !== bootstrapEpoch.current) return
        setWorkspaceEntered(true)
        setAccountBootstrap((current) => ({
          ...(current ?? { phase: 'verifying', label: 'Key 初始化没有完成', percent: 100, scope: bootstrapScope }),
          scope: bootstrapScope,
          error: errorMessage(cause, '账号 Key 初始化没有完成'),
        }))
      }
    })()
    bootstrapInFlight.current = { scope: bootstrapScope, promise }
    try { await promise } finally {
      if (bootstrapInFlight.current?.promise === promise) bootstrapInFlight.current = null
    }
    onlineResync.current = noteBootstrapOutcome(onlineResync.current, bootstrapScope, outcome)
    return outcome
  }, [native, settings, toast.show, toolbox.refreshConfig, siteId, noteStartupCheck, templateFillRetry])
  /**
   * 「重新写入 Key」与「Key 失效」的「一键修复」共用的入口：跑的就是装完工具后
   * 那条同样的重写流程（syncAfterToolInstalled 里的这一行），只是限定到指定的工具。
   * 主进程说不成的原因原样抛回给调用方，由它决定显示在哪，不在这里吞掉。
   */
  const rewriteAccountKeys = useCallback(async (providers?: readonly ProviderId[]) => {
    // 登录已经掉了就没有「当前账号」可写，这时该做的是把登录框打开，而不是报一句
    // 成功。返回值说的就是这次到底写没写。
    if (!session.authenticated || !session.account) { setAuth('login'); return false }
    // 点名某个工具 = 用户明确要求覆盖它，这一档才会去改写一份「被改动过」的配置；
    // 不点名的整轮修复照旧只碰来源确认过的那些，免得顺手改掉别的工具。
    const outcome = await runAccountBootstrap(session.account.userId, providers ? 'rewrite' : 'login', true, providers)
    if (outcome?.error) throw new Error(outcome.error)
    const failed = outcome?.result?.failed ?? []
    const relevant = providers ? failed.filter((entry) => providers.includes(entry.provider)) : failed
    if (relevant.length) throw new Error(relevant.map((entry) => entry.message).join('；'))
    // 点名的工具被跳过 = 配置里还是原来那把 Key，不能算写好了（#478）。
    const skipped = skippedNamedProviders(outcome?.result, providers)
    if (skipped.length) throw new KeyRewriteSkippedError(skipped)
    return true
  }, [runAccountBootstrap, session.account, session.authenticated])
  /**
   * 订阅开通之后把用得上它的工具换过去。走的是开机恢复那一档：主进程这一轮发现哪家
   * 工具的 Key 换进了订阅分组，就只改写那几家，其余已连好的工具不碰。
   */
  const applySubscriptionToTools = useCallback(async (): Promise<ProviderId[]> => {
    if (!session.authenticated || !session.account) return []
    const outcome = await runAccountBootstrap(session.account.userId, 'restore', true)
    if (outcome?.error) throw new Error(outcome.error)
    return outcome?.result?.regrouped ?? []
  }, [runAccountBootstrap, session.account, session.authenticated])
  /**
   * 首页「就用现在这份」：用户自己改过配置又不想被提醒时，把这个工具记成手动来源。
   * 写的是配置对话框里「自己填写密钥」同一个本机标记，所以以后在配置里改回星芒
   * 账号时会被自动清掉，不需要另开一条通道来撤销。
   */
  const keepCurrentToolConfig = useCallback(async (tool: ToolId) => {
    const provider = providerFor(tool)
    const current = toolbox.snapshot?.config.providers[provider]
    if (!current) throw new Error('请先完成工具检测')
    const warning = applyManualSourceMarker(getSourceMarkerStorage(), current.baseUrl, provider, true)
    if (warning) toast.show(warning, 'warn')
    else toast.show('已按现在这份配置处理，以后不再提示。', 'ok')
    await toolbox.refreshConfig().catch(() => undefined)
  }, [toast, toolbox.refreshConfig, toolbox.snapshot])
  /**
   * 首页「切到当前账号 / 切回官方账号」。主进程一次做完备份、写入、自检和失败
   * 回滚，成功与失败都只说一句话；失败的那句走统一的错误条（perform）。
   */
  const switchToolAccount = useCallback(async (tool: ToolId, target: AccountSourceTarget): Promise<AccountSourceSwitchResult | null> => {
    if (target === 'account' && (!session.authenticated || !session.account)) { setAuth('login'); return null }
    const provider = providerFor(tool)
    // CC Switch 还开着的话，它切供应商、退出时写回接管前的备份，都会把刚写好的配置
    // 改回去。一闪而过的提示容易看漏，改完用一个要点「知道了」的框说（方案盘查第 5 条）；
    // 退不退由用户定。
    const ccSwitchLeftover = target === 'account' && Boolean(toolbox.snapshot?.config.providers[provider].ccSwitchLeftover)
    // 引导要按这次的结果决定第 4 步怎么说（自检没通过时不能写「已准备好」）。
    const outcome: { result?: AccountSourceSwitchResult } = {}
    // 登记成工具行上的任务（全面检测 Q35）：切换要备份、写入、自检，失败还要回滚，
    // 一次得好几秒。以前没有忙态，连点两下就是两次切换叠在一起跑；现在同一个工具
    // 在切的时候行上显示「切换中」、菜单收起，再点也进不来。
    await toolbox.run(`switch:${tool}`, target === 'account' ? '正在改用当前账号' : '正在切回官方账号', async () => {
      try {
        const result = await toolsApi.switchSource(tool, target)
        outcome.result = result
        // 与配置对话框保存时一样：换了来源就清掉「自己填写密钥」的本机标记。
        const baseUrl = toolbox.snapshot?.config.providers[provider].baseUrl
        const markerWarning = baseUrl ? applyManualSourceMarker(getSourceMarkerStorage(), baseUrl, provider, false) : ''
        toast.show(result.message, result.loginRequired || (target === 'account' && !result.verified) ? 'warn' : 'ok')
        if (markerWarning) toast.show(markerWarning, 'warn')
        if (ccSwitchLeftover) setCcSwitchReminder(true)
        // Codex CLI 与 Codex 桌面端读的是同一份配置：从哪一行点的，两行都一起换了。
        if (provider === 'codex' && target === 'account') toast.show('Codex CLI 和 Codex 桌面端共用一份设置，已一起改好。', 'neutral')
        if (provider === 'codex' && offersCodexDesktopRestart(result.runningTools)) setSwitchRestartOffer(target)
      } finally {
        await toolbox.refresh(true).catch(() => undefined)
      }
    })
    return outcome.result ?? null
  }, [session.account, session.authenticated, toast, toolbox.refresh, toolbox.run, toolbox.snapshot, toolsApi])
  /**
   * 首页「提醒设置要修」的「修好它」。主进程先备份、只改钩子与状态行、再查一遍；
   * 没修好会抛中文原因，走统一的错误条（perform）。
   */
  const repairToolHooks = useCallback(async (tool: ToolId) => {
    await toolbox.run(`repair-hooks:${tool}`, '正在修提醒设置', async () => {
      try {
        await toolsApi.repairHooks(tool)
        toast.show('提醒设置已改好，原来的设置已备份。', 'ok')
      } finally {
        await toolbox.refreshConfig().catch(() => undefined)
      }
    })
  }, [toast, toolbox.refreshConfig, toolbox.run, toolsApi])
  // 官方账号与手填密钥重写不动（重写流程本身会跳过它们），所以按钮按当前配置的
  // 来源决定给不给，而不是见到密钥层失败就画一颗出来。
  const rewritableKeys = useMemo(
    () => rewritableKeyProviders(session.authenticated ? toolbox.snapshot?.config : null),
    [session.authenticated, toolbox.snapshot?.config],
  )
  // 扩展三页按它挑默认显示哪个工具。还没检测完时给 undefined，页面先按旧行为选 Claude。
  const installedProviders = useMemo(() => {
    const clis = toolbox.snapshot?.system.clis
    return clis ? (Object.keys(clis) as Array<keyof typeof clis>).filter((id) => clis[id].installed) : undefined
  }, [toolbox.snapshot?.system.clis])
  useEffect(() => {
    if (boot === 'ready' && !auth && session.authenticated && session.account) {
      const restoredScope = accountScope(session)
      if (!suppressRestoredBootstrap.current.delete(restoredScope)) void runAccountBootstrap(session.account.userId, 'restore')
    }
    if (!session.authenticated) {
      bootstrapEpoch.current++
      bootstrapInFlight.current = null
      onlineResync.current = idleOnlineResync()
      setAccountBootstrap(null)
    }
  }, [boot, runAccountBootstrap, session.account?.userId, session.authenticated, siteId, auth])
  /**
   * 断网时打开软件，Key 同步这一步必然失败，而引导段每次启动只跑一次，网络回来
   * 之后不会有人再去补。这里挂一次自动补跑：只在上一轮确实是被网络拦住时补，
   * 每次离线→在线最多一次，补跑本身不弹任何对话框（结果照旧写进首页那条横幅）。
   *
   * 补跑仍走 restore 模式：已经连好的工具照旧跳过，不会覆盖任何现成配置。
   */
  useEffect(() => {
    if (boot !== 'ready' || !session.authenticated || !session.account) return
    const userId = session.account.userId
    function resume() {
      const plan = planOnlineResync(onlineResync.current, scope)
      onlineResync.current = plan.state
      if (!plan.scope) return
      void runAccountBootstrap(userId, 'restore', true).then((outcome) => {
        // 补跑再失败不打扰用户——他并没有点任何东西。留一行给运行日志，客服排查
        // 「明明联网了 Key 还是没写上」时才有据可查。
        const reason = outcome?.error || outcome?.result?.failed.map((entry) => entry.message).join('；') || ''
        if (!reason) return
        void native.reportRendererError({ message: `联网后自动补跑 Key 同步仍未完成：${reason}`, context: 'account-bootstrap-online-resync', level: 'warn' }).catch(() => undefined)
      })
    }
    resumeOnline.current = resume
    window.addEventListener('online', resume)
    return () => {
      resumeOnline.current = null
      window.removeEventListener('online', resume)
    }
  }, [boot, native, runAccountBootstrap, scope, session.account?.userId, session.authenticated])
  // 代理恢复、门户认证做完时系统不会发 online 事件，只有请求重新成功才知道网回来了；
  // 这时同样补跑一次。planOnlineResync 挡住了和 online 事件撞在一起的重复补跑。
  const wasOffline = useRef(offline)
  useEffect(() => {
    if (wasOffline.current && !offline) resumeOnline.current?.()
    wasOffline.current = offline
  }, [offline])
  useEffect(() => {
    if (boot !== 'ready' || !session.authenticated || !settings?.runDiagnosticsOnStartup || diagnosticsStarted.current) return
    diagnosticsStarted.current = true
    // 开机这次紧跟着首页扫描，让主进程直接用那轮的探测结果，不再重跑一遍子进程。
    void native.runDiagnostics({ reuseRecentScan: true }).then((report) => {
      if (!mounted.current) return
      publishDiagnosticsCounts(report.counts)
      const notice = startupDiagnosticsIssues(report.counts)
      if (notice) noteStartupCheck(notice)
    }).catch((cause) => { if (mounted.current) noteStartupCheck(startupCheckFailure('diagnostics', errorMessage(cause, '启动环境检查没有完成'))) })
  }, [boot, native, noteStartupCheck, session.authenticated, settings?.runDiagnosticsOnStartup])
  useLayoutEffect(() => {
    if (!settings) return
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.dataset.skin = settings.uiSkin ?? 'mist'
    document.documentElement.dataset.reducedMotion = String(settings.reducedMotion === true)
    document.documentElement.dataset.largeText = String(settings.largeText === true)
    document.documentElement.style.colorScheme = settings.theme
  }, [settings])
  useEffect(() => {
    const system = platformApi()
    if (!system || boot !== 'ready') return
    return bindPlatformAppearance(system, native, (theme) => setSettings((current) => current ? { ...current, theme } : current),
      (cause) => noteStartupCheck(startupCheckFailure('appearance', errorMessage(cause, '系统外观没有同步'))))
  }, [boot, native, noteStartupCheck])
  // 平台能力回来之前沿用挂载前定下的系统，不能先按 Windows 写上去再改：欢迎页和
  // 启动页据此排顶栏，Mac 上那样第一帧就没给红黄绿按钮让位。
  const os = platform ? windowOsFor(platform.platform) : currentWindowOs()
  const supportInput = { signedIn: session.authenticated, account: session.account, version: update?.currentVersion, os,
    ...(os === 'linux' ? { systemDetail: linuxSystemDetail(systemLabel, platform?.architecture) } : {}) }
  const supportIdentity = buildSupportIdentityLine(supportInput)
  const lastFailureLine = lastFailure ? buildLastFailureLine(lastFailure) : undefined
  useEffect(() => { if (operationError) setLastFailure(supportFailureOf(operationError, new Date())) }, [operationError])
  useLayoutEffect(() => { document.documentElement.dataset.os = os }, [os])
  useEffect(() => {
    let current = true
    void QRCode.toDataURL(supportUrl, { width: 192, margin: 1, errorCorrectionLevel: 'M' })
      .then((data) => { if (current) setSupportQr({ url: supportUrl, data }) })
      .catch(() => { if (current) setSupportQr({ url: supportUrl, data: null }) })
    return () => { current = false }
  }, [supportUrl])
  const reloadAccount = useCallback(async () => {
    const id = ++accountEpoch.current
    cancelPendingLaunchDialogs()
    let next: AccountSessionState
    try { next = await app.session() }
    catch (cause) {
      if (!mounted.current || id !== accountEpoch.current) return
      const message = formatAccountReadError(cause, 'session')
      if (message) setAccountReadError({ scope, message })
      return
    }
    if (!mounted.current || id !== accountEpoch.current) return
    setSession(next); setConfigTool(null); setExternalClient(null); setAccountReadError(null)
    balanceStore.setScope(next.authenticated ? accountScope(next) : null)
    if (next.authenticated) await balanceStore.refresh('foreground')
    else { setGuide(false); setPage('home'); setWorkspaceEntered(false) }
  }, [app, balanceStore, scope])
  useEffect(() => native.onAccountSessionChanged?.((next) => {
    sessionEvents.current++
    accountEpoch.current++
    cancelPendingLaunchDialogs()
    bootstrapEpoch.current++
    bootstrapInFlight.current = null
    setSession(next); setAccountReadError(null); setUnread(false); setConfigTool(null); setExternalClient(null); setPaymentReturn(undefined)
    balanceStore.setScope(next.authenticated ? accountScope(next) : null)
    if (restoring) {
      // 开机恢复结束。先进首页时读到的配置没有账号可比，来源是「待定」：恢复成功
      // 就当场补读一次（作用域没变，首页不重来）；没恢复成就只是落回未登录，
      // 回到欢迎页，不按「登录被结束」处理。
      if (next.authenticated) { void toolbox.refreshConfig().catch(() => undefined); void balanceStore.refresh('foreground') }
      return
    }
    if (!next.authenticated) {
      setGuide(false); setPage('home'); setWorkspaceEntered(false)
      if (session.authenticated) toast.show('当前登录已结束，请重新登录。', 'warn')
    }
    else void balanceStore.refresh('foreground')
  }), [native, balanceStore, restoring, session.authenticated, toast, toolbox.refreshConfig])
  // 本机账号存储被重建：主进程一次启动只发一条，界面照后台检查那套挂在角落，
  // 用户关掉就不再出现。事件不带任何账号内容，这里也不去读它。
  useEffect(() => native.onAccountVaultRecovered?.(() => noteStartupCheck(vaultRecoveredNotice())), [native, noteStartupCheck])
  // tool 只是把「这次失败关系到哪个工具」记下来；具体目录在渲染那一刻从当时的
  // 快照里取，装完又失败的第二次点击才不会拿到上一次的旧路径。
  const perform = useCallback(async function run(label: string, work: () => Promise<unknown>, tool?: ToolId): Promise<void> {
    setOperationError(null)
    try { await work() }
    catch (cause) {
      setOperationError({ ...operationFailureFrom(cause, label), action: label, retry: () => void run(label, work, tool), ...(tool ? { tool } : {}) })
    }
  }, [])
  // 兼容显示提示里的二选一：两颗都写进设置，主进程据此清掉崩溃记录。「一直用」现在
  // 已经是兼容方式，不用重开；「恢复」要重开才生效，接着给一颗「现在重开」。
  const chooseDisplayCompat = useCallback((choice: 'keep' | 'restore') => perform('保存显示方式', async () => {
    setSettings(await app.savePreferences({ version: 2, hardwareAcceleration: choice === 'restore' }))
    if (choice === 'restore') noteStartupCheck(displayRelaunchNotice())
    else toast.show('以后都用兼容方式显示。想改回来，到「设置」的「外观」里打开「用显卡加速显示」。', 'ok')
  }), [app, noteStartupCheck, perform, toast])
  // 错误报告告知：登录进来后说一次，这次运行里只出一回。两颗按钮都记下「已告知」，
  // 「不想发送」同时把上报关掉，和设置页那个开关是同一个设置。
  const crashNoticeOffered = useRef(false)
  useEffect(() => {
    if (boot !== 'ready' || crashNoticeOffered.current) return
    const notice = crashReportingNotice(settings, session.authenticated)
    if (!notice) return
    crashNoticeOffered.current = true
    noteStartupCheck(notice)
  }, [boot, noteStartupCheck, session.authenticated, settings])
  const chooseCrashReporting = useCallback((choice: 'keep' | 'off') => perform('保存错误报告设置', async () => {
    setSettings(await app.savePreferences({ version: 2, crashReportingNoticeShown: true, ...(choice === 'off' ? { crashReporting: false } : {}) }))
    if (choice === 'off') toast.show('已关掉，出错时不再发送错误报告。想重新打开，到「设置」的「隐私与数据」里。', 'ok')
  }), [app, perform, toast])
  // 连按几下 Ctrl 加号时，保存还没回来，下一下要接着上一下算，不能都从旧设置起步。
  const uiScaleRef = useRef<AppSettingsV2['uiScale']>(undefined)
  useEffect(() => { uiScaleRef.current = settings?.uiScale }, [settings?.uiScale])
  const changeUiScale = useCallback((shortcut: UiScaleShortcut) => {
    const step = nextUiScale(uiScaleRef.current, shortcut, os)
    toast.show(step.message)
    const next = step.next
    if (next === null) return
    uiScaleRef.current = next === 'auto' ? undefined : next
    void perform('保存界面缩放', async () => setSettings(await app.savePreferences({ version: 2, uiScale: next })))
  }, [app, os, perform, toast])
  const navigate = useCallback((target: PageId, section?: string, rechargeAmount?: number) => {
    if (target === 'canvas') { void perform('打开画布', app.openCanvas); return }
    if (target === 'acceleration' && !accelerationAvailable) return
    if ((target === 'account' || target === 'chat') && restoring) {
      toast.show(restoreRetrying ? '暂时连不上服务，登录还在，连上后会自动恢复，不用重新登录。' : '正在恢复上次的登录，稍等一下再试。')
      return
    }
    if ((target === 'account' || target === 'chat') && !session.authenticated) { setAuth('login'); return }
    // 顶部搜索的个人中心「切换账号」落在页头那颗按钮上，停在当前分页不动。
    if (target === 'account' && section === accountSwitchAnchor) requestRowFocus('account', section)
    else if (target === 'account') setAccountTab((current) => ({ sequence: current.sequence + 1, value: accountTabs.find((entry) => entry.value === section)?.value ?? 'overview', rechargeAmount }))
    // 教程的 section 可以带「#某条补充说明的标题」：打开那一篇、展开那一条（技能页「看怎么放」）。
    if (target === 'tutorial' && section) {
      const mark = section.indexOf('#')
      const id = mark < 0 ? section : section.slice(0, mark)
      const extra = mark < 0 ? '' : section.slice(mark + 1)
      setTutorialTopic((current) => ({ sequence: (current?.sequence ?? 0) + 1, id, ...(extra ? { extra } : {}) }))
    }
    if (target === 'settings') {
      // section 可以是一组，也可以是某一行（顶部搜索搜到的「自动更新」）：是一行就打开它那一组再翻过去。
      const item = settingsItems.find((entry) => entry.id === section)
      const group = settingsGroups.find((entry) => entry.value === section)?.value ?? item?.group
      if (group) requestSettingsGroup(group)
      if (item) requestRowFocus('settings', item.id)
      if (hasPendingSettingsGroup()) setSettingsRequest((current) => current + 1)
    }
    if (target === 'health' && section) requestRowFocus('health', section)
    if (target === 'chat') setChatScope(scope)
    if (target !== 'home' && target !== 'chat') setVisitedPages((current) => ({ ...current, [target]: scope }))
    setGuide(false); setPage(target)
  }, [accelerationAvailable, app, perform, restoring, restoreRetrying, session.authenticated, scope, toast])
  // 顶部搜索没搜到时的「去教程里搜」：带着输入的字打开教程页。
  const searchTutorial = useCallback((query: string) => {
    setTutorialTopic((current) => ({ sequence: (current?.sequence ?? 0) + 1, id: 'start', query }))
    navigate('tutorial')
  }, [navigate])
  // 设置页的「重看界面导览」：回到首页立刻重播一遍，同时把「还没看完」记进本机，
  // 这样中途关掉软件下次还能接着看。
  const replayTour = useCallback(() => {
    rememberTourPending(scope)
    navigate('home')
    setTourOpen(true)
  }, [navigate, scope])
  // 商店链接在主进程外链白名单里（全等匹配）。系统没接住时说清楚自己去哪儿找，
  // 不留一颗按了没反应的按钮。打不开多半是这台电脑没有商店（第二十一批 2），
  // 那就别再叫人去开始菜单里找它，回星芒重装会改走 OpenAI 官网的离线安装包或国内线路。
  const openCodexDesktopStore = useCallback(async () => {
    if (!await app.openExternal(codexDesktopStoreUrl)) throw new Error('没能打开微软商店，这台电脑可能没有它。回星芒再点一次安装，星芒会改用 OpenAI 官网的离线安装包或国内线路装；还不行就找客服。')
  }, [app])
  // 错误框里的「重置 Codex」：清掉的是 Codex 桌面端自己的登录和缓存，先问一句再动手；
  // 重置完接着把刚才没打开的那一次再跑一遍，客户不用再回首页点「打开」。
  const requestCodexDesktopReset = useCallback((retry?: () => void) => {
    setConfirmation({ title: '重置 Codex 桌面端？', body: 'Codex 桌面端里的登录状态和缓存会被清掉，星芒写好的连接设置不受影响。重置完会自动再打开一次。', label: '重置', danger: true, tool: 'codexDesktop', work: async () => {
      await toolsApi.resetCodexDesktop()
      if (retry) retry()
      else toast.show('Codex 桌面端已经重置，回首页点「打开」试试。', 'ok')
    } })
  }, [toast, toolsApi])
  const runOperationAction = useCallback((action: OperationActionId) => {
    const failure = operationError
    setOperationError(null)
    if (action === 'retry') failure?.retry?.()
    else if (action === 'log') navigate(failure ? operationLogPage(failure) : 'feedback')
    else if (action === 'network') navigate('health')
    else if (action === 'recharge') navigate('account', 'recharge')
    else if (action === 'backups') navigate('backups')
    else if (action === 'relogin') setAuth('login')
    // 目录里 keyInvalid 的「一键修复」就是这件事：对当前账号把已配置的工具重新
    // 写一次 Key。一次点击只重写一次，连续失败的出口仍旧是「找客服」。
    else if (action === 'repair') void perform('重新写入 Key', () => rewriteAccountKeys())
    else if (action === 'replaceNode') setNodeReplace(failure?.retry ? { retry: failure.retry } : {})
    else if (action === 'openStore') void perform('打开微软商店', openCodexDesktopStore)
    else if (action === 'resetCodexDesktop') requestCodexDesktopReset(failure?.retry)
    else if (action === 'useCodexCli') switchToCodexCli()
    else if (action === 'installGuide') navigate('tutorial', macDesktopTutorialTopic)
    // Windows 上 Claude Desktop 一键安装没装上时的出口；下载页在主进程外链白名单里（全等匹配）。
    else if (action === 'claudeDesktopDownload') void perform('打开下载页', () => app.openExternal(claudeDesktopDownloadPageUrl))
    else setHelp(true)
  }, [app, navigate, openCodexDesktopStore, operationError, perform, requestCodexDesktopReset, rewriteAccountKeys])
  // 引导里「改用」或安装失败时的出口：和错误框同一张表，只是没有「再试一次」
  //（引导自己有）。去充值、去备份页会离开引导，进度照旧留着；换 Node.js 不离开，
  // 换完接着重跑引导里失败的那一步。
  const runGuideFailureAction = useCallback((action: OperationActionId, retry?: () => void) => {
    if (action === 'replaceNode') setNodeReplace(retry ? { retry } : {})
    else if (action === 'recharge') navigate('account', 'recharge')
    else if (action === 'backups') navigate('backups')
    else if (action === 'log') navigate('feedback')
    else if (action === 'network') navigate('health')
    else if (action === 'relogin') setAuth('login')
    else if (action === 'repair') void perform('重新写入 Key', () => rewriteAccountKeys())
    else if (action === 'openStore') void perform('打开微软商店', openCodexDesktopStore)
    else if (action === 'resetCodexDesktop') requestCodexDesktopReset(retry)
    else if (action === 'useCodexCli') switchToCodexCli()
    else if (action === 'installGuide') navigate('tutorial', macDesktopTutorialTopic)
    else if (action === 'claudeDesktopDownload') void perform('打开下载页', () => app.openExternal(claudeDesktopDownloadPageUrl))
    else setHelp(true)
  }, [app, navigate, openCodexDesktopStore, perform, requestCodexDesktopReset, rewriteAccountKeys])
  // Codex 桌面端这一版已知打不开时的「改用 Codex 命令行版」：回到首页 Codex 那一行；
  // 还没装就直接开始装，装好了由客户自己点「打开」（第十九批 7）。
  function switchToCodexCli() {
    navigate('home')
    if (toolbox.snapshot?.system.clis.codex.installed) toast.show('Codex 命令行版在首页，点它那一行的「打开」就能用。', 'neutral')
    else void perform('安装工具', () => install('codex'), 'codex')
  }
  async function install(id: ToolId, version?: string): Promise<ToolInstallOutcome> {
    const state = toolbox.snapshot
    if (!state) throw new Error('请先完成工具检测')
    const management = id === 'codexDesktop' ? state.platform.codexDesktop.install : state.platform.cliInstall[id]
    // 这不是一次失败：macOS 上这几个桌面端本来就要客户自己下载。以前当错误抛出来，
    // 用户会同时看到红色错误框和一个跳到教程首页、又没有对应章节的页面（第七批 3）。
    // Linux 的教程里没有 Mac 那一章，跳过去只会落到第一章：只说一句，不跳。
    if (management === 'external' && state.platform.platform === 'linux') { toast.show(`${tools.find((tool) => tool.id === id)?.name ?? '这个工具'}在这台电脑上暂时不能一键安装。`, 'neutral'); return 'skipped' }
    if (management === 'external') { navigate('tutorial', macDesktopTutorialTopic); toast.show('这个系统要你自己下载安装，教程里是完整步骤。', 'neutral'); return 'skipped' }
    if (offline) { toast.show(offlineActionMessage, 'warn'); return 'skipped' }
    const definition = tools.find((tool) => tool.id === id)
    const toolName = definition?.name ?? '工具'
    const plan = id === 'codexDesktop'
      ? { prepare: [], blocked: null }
      : planCliInstall({ runtime: state.system.runtime, needsNode: cliNeedsNodeRuntime(state.platform, id), needsPython: cliNeedsPythonRuntime(state.platform, id, Boolean(definition?.requires.includes('python'))), nodeInstall: platform?.nodeRuntimeInstall, pythonInstall: platform?.pythonRuntimeInstall })
    if (plan.blocked) throw new Error(plan.blocked)
    const current = presentTools(state).find((tool) => tool.id === id)
    // 官方安装器装的 Claude Code 星芒更新不了，只能先卸掉再装回星芒自己的（第三十一批 B）。
    // 卸之前问一句；问之前上面已经确认过没断网、运行环境装得上。
    const switchVersion = current && canSwitchToManagedInstall(id, current.status) ? managedSwitchVersion(current, version) : null
    if (switchVersion) {
      // 这一份已经在换（比如首页点过、又到安装卸载页点「重新安装」）：再问一遍「先把它卸掉」
      // 只会让人糊涂。和 toolbox.run 撞锁一样，当作已经在装。
      if (toolbox.jobs[id]) return 'skipped'
      if (!await confirmManagedSwitch(switchVersion)) return 'declined'
      // 确认框里写的是哪一版，就点名装哪一版。
      version = switchVersion
    }
    const total = plan.prepare.length + 1
    // 运行环境那一段主进程没有取消通道；这时按「取消」要说清楚，而不是回一句
    //「没有正在进行的安装」。换装时卸载那一步同样没有。
    let preparing = plan.prepare.length > 0
    let uninstalling = false
    let outcome: ToolInstallOutcome = 'installed'
    const updating = Boolean(current?.status.installed)
    // 收尾必须留在同一个安装任务里。任务一结束工具行就回落到安装前的快照：
    // 同步 Key 和重新检测还没跑完，版本号已经退回旧值、「更新」按钮跟着回弹，
    // 用户看到的是「装完了又要装一次」（yoyo 2026-09-20 真机反馈①）。
    // 用户中途取消时安装那一步抛出，收尾自然不会跑：本来就没装上，不用写 Key。
    const finished = await toolbox.run(id, switchVersion && !preparing ? '正在卸载' : version ? `正在安装 ${version}` : preparing ? cliInstallStageLabel(plan.prepare[0], 0, total, toolName) : '正在安装', async (report) => {
      for (const [index, runtime] of plan.prepare.entries()) {
        report(cliInstallStageLabel(runtime, index, total, toolName))
        // MSI 回 3010 时 Windows 要重启才算装完，接着装工具多半失败（第七批 5）：
        // 停在这里弹「现在重启」，重启后再点一次「安装」只剩装工具这一段。
        if ((await prepareRuntimeForInstall(runtime, toolName)).restartRequired) {
          await toolbox.refresh(true).catch(() => undefined)
          if (mounted.current) setRuntimeRestart(true)
          outcome = 'restart'
          return
        }
      }
      preparing = false
      if (switchVersion) {
        // 运行环境备齐了才卸：卸完到装上之间越短越好，环境要重启电脑时官方那份也还在。
        // 确认框可能开着放了好一阵，运行环境也可能刚装了几分钟：真动手卸之前再看一眼网，
        // 断了就先不卸，免得卸完装不回来。
        if (offlineNow.current) {
          if (mounted.current) toast.show(offlineActionMessage, 'warn')
          outcome = 'skipped'
          return
        }
        uninstalling = true
        report('正在卸载')
        try {
          if (!await uninstallBeforeSwitch(id, toolName)) { outcome = 'skipped'; return }
        }
        catch (cause) {
          void toolbox.refresh(true).catch(() => undefined)
          throw cause
        }
        finally { uninstalling = false }
        report(plan.prepare.length > 0 ? cliInstallStageLabel('tool', total - 1, total, toolName) : `正在安装 ${version}`)
      }
      else if (plan.prepare.length > 0) report(cliInstallStageLabel('tool', total - 1, total, toolName))
      try {
        const result = await toolsApi.install(id, version)
        if (id === 'codexDesktop' && result && 'storeNewerVersion' in result && result.storeNewerVersion && mounted.current) setStoreNewerVersion(result.storeNewerVersion)
      }
      catch (cause) {
        // 环境已经装好、工具没装上：刷新一次，下次再点只剩装工具这一段。
        // 换装时官方那份已经卸掉了：刷新后这一行变回「安装」，再点一次就好。
        if (plan.prepare.length > 0 || switchVersion) void toolbox.refresh(true).catch(() => undefined)
        throw cause
      }
      report(installedToolSyncLabel)
      await syncAfterToolInstalled(id)
    }, { cancel: async () => preparing ? { cancelled: false, reason: '正在准备运行环境，这一步不能取消；准备好后会接着安装工具。' } : uninstalling ? { cancelled: false, reason: '这一步已经不能取消了。' } : toolsApi.cancelInstall(id), notice: { updating, unfinished: () => outcome !== 'installed' } })
    // run 返回 false 只有两种：用户取消了，或同一个工具已经有一次安装在跑。
    return finished ? outcome : 'skipped'
  }
  /** 弹「换成星芒装的」确认框，等客户点；关掉框和点「取消」一样算不换。 */
  function confirmManagedSwitch(version: string): Promise<boolean> {
    pendingManagedSwitch.current?.(false)
    return new Promise<boolean>((resolve) => {
      const answer = (confirmed: boolean) => {
        if (pendingManagedSwitch.current !== answer) return
        pendingManagedSwitch.current = null
        setManagedSwitch(null)
        resolve(confirmed)
      }
      pendingManagedSwitch.current = answer
      setManagedSwitch({ version, answer })
    })
  }
  /**
   * 「换成星芒装的」的前一半：和「卸载」走同一条路、同一套结果处理，只多带 reinstall，
   * 主进程先看盘够不够装回来再动手。返回 false = 卸载转交给了别的窗口，这次先不装。
   */
  async function uninstallBeforeSwitch(id: ToolId, name: string): Promise<boolean> {
    const result = await toolsApi.uninstall(id, { reinstall: true })
    // 程序已经卸掉，只剩几个旧版本文件没删掉（多半是 Claude Code 还开着）：照常装上，清理那一步交给客户。
    if (result.outcome === 'manual-required') setManualUninstall({ name, reason: result.manualHelp.reason, manualCommand: result.manualHelp.manualCommand })
    const handedOff = uninstallHandOffNotice(result)
    if (!handedOff) return true
    // 同「卸载」：转交出去时官方那份可能已经卸掉了，刷新一次，这一行照实际情况显示。
    void toolbox.refresh(true).catch(() => undefined)
    if (mounted.current) toast.show(handedOff, 'neutral')
    return false
  }
  /**
   * 串在「安装」里的运行环境那一段。单独占一个 node / python 任务，运行环境卡上
   * 的进度条照常走；那个任务已经在跑（用户先点过运行环境卡）时不重复发起。
   */
  async function prepareRuntimeForInstall(runtime: InstallRuntimeId, toolName: string): Promise<RuntimeInstallOutcome> {
    try {
      const done: { outcome?: RuntimeInstallOutcome } = {}
      const started = await toolbox.run(runtime, '正在准备运行环境', async () => {
        done.outcome = describeRuntimeInstallOutcome(runtime, await toolsApi.prepareRuntime(runtime))
      })
      if (!started || !done.outcome) throw new Error('运行环境正在准备，请等它完成后再点「安装」。')
      return done.outcome
    } catch (cause) {
      // 原话留着不先翻成中文：外层的错误分类要靠 ENOSPC、ETIMEDOUT 这类原词认出
      //「磁盘满」「下载超时」，展示前 errorMessage 会统一脱敏。
      throw new Error(runtimeStageFailureMessage(runtime, toolName, cause))
    }
  }
  async function cancelInstall(id: ToolId | ExternalToolId) {
    const outcome = await toolbox.cancel(id)
    // 主进程拒绝取消时必须说清楚为什么，否则按钮看起来像坏了。
    if (!outcome.cancelled && outcome.reason) toast.show(outcome.reason, 'warn')
  }
  /**
   * 装完一个工具要做两件收尾：把账号 Key 写进刚装好的工具，再刷新检测结果。
   * 首页和「安装卸载」页必须共用这一段，否则维护页装完只提示「工具状态已更新」，
   * 首页还停在「未安装」、Key 也没写（R-G3）。
   */
  async function syncAfterToolInstalled(id: ToolId) {
    if (session.authenticated && session.account) {
      await runAccountBootstrap(session.account.userId, 'login', true, [providerFor(id)])
    }
    // 「安装卸载」页装完走的是它自己的 bridge 调用，绕开了 toolsApi 那侧的作废，
    // 所以收尾这一步补一刀，两个入口装完都能立刻看到新的「最近」。
    refreshRecent()
    await toolbox.refresh(true)
  }
  async function installRuntime(runtime: 'node' | 'python' | 'git') {
    if (offline) { toast.show(offlineActionMessage, 'warn'); return }
    // Git 按钮在 Windows 和 macOS 出现。以前点了是打开官网让客户自己下安装包，小白卡在
    // 这一步（yoyo 2026-09-24）。Windows 由主进程按当前用户代装；Mac 弹苹果自己的安装
    // 窗口，客户可能在那里点取消，那时主进程带回 installed: false 和要说的那句话（第十六批 2）。
    if (runtime === 'git') {
      const outcome: { message?: string } = {}
      const done = await toolbox.run('git', '正在准备安装 Git', async () => {
        const result = await toolsApi.installGit()
        if (!result.installed) outcome.message = result.message ?? '没有装 Git。需要时再点一次「安装 Git」就行。'
      }, { notice: { unfinished: () => Boolean(outcome.message) } })
      await toolbox.refresh(true)
      if (done && mounted.current) toast.show(outcome.message ?? 'Git 装好了。', outcome.message ? 'warn' : 'ok')
      return
    }
    const mode = runtime === 'node' ? platform?.nodeRuntimeInstall : platform?.pythonRuntimeInstall
    if (mode !== 'managed') { await app.openExternal(runtime === 'node' ? 'https://nodejs.org/' : 'https://www.python.org/downloads/'); return }
    // 主进程装完带回「要重启 / 要刷新 PATH」两个标记，以前这里直接扔掉（第七批 5）。
    const done: { outcome?: RuntimeInstallOutcome } = {}
    await toolbox.run(runtime, '正在准备运行环境', async () => {
      done.outcome = describeRuntimeInstallOutcome(runtime, await toolsApi.prepareRuntime(runtime))
    }, { notice: { unfinished: () => Boolean(done.outcome?.restartRequired) } })
    await toolbox.refresh(true)
    if (!done.outcome || !mounted.current) return
    if (done.outcome.restartRequired) setRuntimeRestart(true)
    else toast.show(done.outcome.message, done.outcome.tone)
  }
  async function replaceNode(retry?: () => void) {
    if (offline) { toast.show(offlineActionMessage, 'warn'); return }
    const done: { outcome?: RuntimeInstallOutcome } = {}
    await toolbox.run('node', '正在换成新版 Node.js', async () => {
      done.outcome = describeNodeReplaceOutcome(await toolsApi.replaceNode(), Boolean(retry))
    }, { notice: { unfinished: () => Boolean(done.outcome?.restartRequired) } })
    await toolbox.refresh(true)
    if (!done.outcome || !mounted.current) return
    if (done.outcome.restartRequired) { setRuntimeRestart(true); return }
    toast.show(done.outcome.message, done.outcome.tone)
    retry?.()
  }
  async function installExternal(id: ExternalToolId) {
    const epoch = accountEpoch.current
    try {
      const completed = await toolbox.run(id, '正在安装', () => toolsApi.installExternal(id), { cancel: () => toolsApi.cancelExternalInstall(id), notice: {} })
      if (!completed || !mounted.current || epoch !== accountEpoch.current) return
      await toolbox.refreshExternal()
      if (mounted.current && epoch === accountEpoch.current) toast.show('客户端已安装，点击“配置”选择密钥和模型。', 'ok')
    } catch (cause) { if (mounted.current && epoch === accountEpoch.current) throw cause }
  }
  async function launchExternal(id: ExternalToolId) {
    const epoch = accountEpoch.current
    try {
      const launched = await toolbox.run(`launch:${id}`, '正在打开客户端', () => toolsApi.launchExternal(id))
      // 打开以后变的只有这一行的「运行中」：不再整轮重扫，那会让三行按钮一起变灰（第三十一批 C）。
      if (launched && mounted.current && epoch === accountEpoch.current) toolbox.noteExternalLaunched(id)
    } catch (cause) { if (mounted.current && epoch === accountEpoch.current) throw cause }
  }
  function finishExternalConfigSave() {
    const epoch = accountEpoch.current
    void toolbox.refreshExternal().catch(() => {
      if (mounted.current && epoch === accountEpoch.current) toast.show('配置已保存，客户端状态尚未读到，请重新检测。', 'warn')
    })
  }
  /**
   * mode 走的是 toolsApi.launch 那套「两侧各取自己认得的那个」:codexDesktop 认
   * 'open' | 'restart',四家 CLI 认 'new' | 'resumeLast'(#292),Codex 接着聊另带记录 id。
   */
  function launchIsCurrent(epoch: number): boolean {
    return mounted.current && accountEpoch.current === epoch
  }
  async function launch(id: ToolId, mode: 'open' | 'restart' | CliLaunchChoice = 'open', remembered?: string, newFolder = false, epoch = accountEpoch.current): Promise<boolean> {
    try {
      if (!launchIsCurrent(epoch)) return false
      const current = toolbox.snapshot
      if (!current) throw new Error('请先完成工具检测')
      const config = await toolsApi.readConfig()
      if (!launchIsCurrent(epoch)) return false
      let tool = presentTools({ ...current, config }).find((entry) => entry.id === id)
      if (!tool) throw new Error('当前平台暂不支持打开这个工具')
      if (tool.error) throw new Error(tool.error)
      if (!tool.status.installed) throw new Error('工具尚未安装，请先完成准备。')
      // Codex 老配置写在它不认的名字下，照原样打开必然报 Key 无效。修完就能用的，
      // 先替用户修（和「修好它」同一条路：备份、写入、自检，失败会恢复原样）再打开。
      if (!tool.configured && readyOnceRepaired(config.providers[tool.provider], tool.provider)) {
        const repaired = await switchToolAccount(id, 'account')
        if (!repaired || !launchIsCurrent(epoch)) return false
        const fresh = await toolsApi.readConfig()
        if (!launchIsCurrent(epoch)) return false
        tool = presentTools({ ...current, config: fresh }).find((entry) => entry.id === id) ?? tool
        if (codexNeedsRepair(fresh.providers[tool.provider], tool.provider)) throw new Error('Codex 的连接设置没修好，已保持原样。请在首页点「修好它」再试一次。')
      }
      if (!tool.configured) { openToolConfig(id); throw new Error('请先确认账号连接，再打开工具。') }
      // Every awaited step belongs to the account that requested this launch. A
      // later session event must not resume the old request against a new owner.
      const offer = modelSwapOffer(tool.name, await toolsApi.checkModels(id))
      if (!launchIsCurrent(epoch)) return false
      if (offer) {
        let answerCurrent: (choice: ModelSwapChoice) => void = () => undefined
        const choice = await new Promise<ModelSwapChoice>((answer) => {
          answerCurrent = answer
          pendingModelSwap.current = answer
          setModelSwap({ offer, answer })
        })
        if (pendingModelSwap.current === answerCurrent) {
          pendingModelSwap.current = null
          setModelSwap(null)
        }
        if (choice === 'cancel' || !launchIsCurrent(epoch)) return false
        if (choice === 'swap') {
          // Empty key keeps the existing source; an ordinary save failure still
          // opens with the old model, while an account change stops the launch.
          let saved = false
          try {
            await toolsApi.saveManual({ provider: providerFor(id), apiKey: '', model: offer.replacement, mode: 'merge' })
            saved = true
          }
          catch (cause) {
            if (!launchIsCurrent(epoch)) return false
            toast.show(`模型没换成，先照旧打开：${errorMessage(cause)}`, 'warn')
          }
          if (!launchIsCurrent(epoch)) return false
          if (saved) {
            const refreshed = await toolbox.refreshSavedConfig(() => launchIsCurrent(epoch))
            if (!launchIsCurrent(epoch)) return false
            if (!refreshed) toast.show('模型已保存，但最新配置没有读到；工具列表可能仍显示旧模型。请重新检测，无需重复保存。', 'warn')
          }
        }
      }
      let workspace = config.workspace
      if (id !== 'codexDesktop') {
        // newFolder：不弹选择器，主进程在「文档」下替用户建一个空的项目文件夹。
        const selectedWorkspace = remembered ?? await toolsApi.chooseWorkspace(newFolder ? { createStarter: true } : undefined)
        if (!launchIsCurrent(epoch) || !selectedWorkspace) return false
        workspace = selectedWorkspace
      }
      if (!launchIsCurrent(epoch)) return false
      const waitLabel = launchWaitLabel(toolbox.jobs, (key) => tools.find((tool) => tool.id === key)?.name ?? clientConnections.find((client) => client.id === key)?.name)
      const started = await toolbox.run(`launch:${id}`, waitLabel, async () => {
        if (!launchIsCurrent(epoch)) return
        const result = await toolsApi.launch(id, workspace, mode)
        const warning = launchWarning(result)
        if (launchIsCurrent(epoch) && warning) toast.show(warning, 'warn')
        // 刚选的文件夹主进程已经记下，随打开结果带回来；首页按钮马上写「打开 它」，其余工具也不再问。
        if (launchIsCurrent(epoch) && result && 'rememberedWorkspace' in result) {
          const rememberedWorkspace = result.rememberedWorkspace ?? undefined
          toolbox.setSnapshot((current) => current && current.config.rememberedWorkspace !== rememberedWorkspace
            ? { ...current, config: { ...current.config, rememberedWorkspace } }
            : current)
          // 开机检测还没跑完就打开的（首页摆的还是上次的结果）：那一轮落地时带的是打开前读的配置，
          // 会把刚记下的目录盖回去。重读一次配置，落地时就用这份新的（见 useToolbox 的 configRevision）。
          if (current.system.cachedAt) void toolbox.refreshSavedConfig(() => launchIsCurrent(epoch)).catch(() => undefined)
        }
      })
      return launchIsCurrent(epoch) && started
    } catch (cause) {
      if (!launchIsCurrent(epoch)) return false
      throw cause
    }
  }
  /**
   * The Chinese runtime patch is what makes Codex start with a local debugging
   * port, so it is off until answered (E-S3). Users upgrading from a build
   * where it was always on would lose Chinese without noticing, so the first
   * launch with no stored answer asks, and the answer is stored either way.
   */
  async function askForChineseRuntimePatch(epoch = accountEpoch.current): Promise<boolean> {
    const storedChoice = settings?.codexDesktopChineseRuntimePatch
    if (!chineseRuntimePatchAnswerMissing(platform, storedChoice)) return false
    const locale = await toolsApi.getLocale().catch(() => null)
    if (!launchIsCurrent(epoch)) return false
    if (!shouldAskForChineseRuntimePatch({ platform, storedChoice, locale })) return false
    setChineseDialog(true)
    return true
  }
  async function answerChineseRuntimePatch(choice: 'enabled' | 'disabled'): Promise<void> {
    const epoch = accountEpoch.current
    // 'enabled' goes through setCodexDesktopLocale, the one path that owns both
    // config.toml and the stored answer; only the refusal is written directly.
    try {
      if (choice === 'enabled') await toolsApi.setLocale('zh-CN')
      else await app.savePreferences({ version: 2, codexDesktopChineseRuntimePatch: 'disabled' })
      if (!launchIsCurrent(epoch)) return
      const nextSettings = await app.readSettings()
      if (!launchIsCurrent(epoch)) return
      setSettings(nextSettings)
      setChineseDialog(false)
      await launch('codexDesktop', 'open', undefined, false, epoch)
    } catch (cause) {
      if (launchIsCurrent(epoch)) throw cause
    }
  }
  function requestLaunch(id: ToolId, remembered?: string, mode: CliLaunchChoice = 'new', newFolder = false) {
    const request = { epoch: accountEpoch.current }
    if (launchRequest.current?.epoch === request.epoch) return
    launchRequest.current = request
    void perform('打开工具', async () => {
      try {
        if (!launchIsCurrent(request.epoch)) return
        if (id === 'codexDesktop') {
          const status = await native.getCodexDesktopStatus()
          if (!launchIsCurrent(request.epoch)) return
          if (offersCodexDesktopRestartOnOpen(os, status.running)) { setRestartDialog(true); return }
          const asking = await askForChineseRuntimePatch(request.epoch)
          if (!launchIsCurrent(request.epoch) || asking) return
        }
        if (remembered) await launchRemembered(id, remembered, mode, request.epoch)
        else await launch(id, mode, undefined, newFolder, request.epoch)
      } catch (cause) {
        if (launchIsCurrent(request.epoch)) throw cause
      }
    }).finally(() => { if (launchRequest.current === request) launchRequest.current = null })
  }
  /**
   * 记住的目录随时可能被删掉或改名。那种情况下退回目录选择器，用户点一次
   * 「打开」仍然能走到底，而不是只收到一条错误（N7）。
   */
  async function launchRemembered(id: ToolId, remembered: string, mode: CliLaunchChoice = 'new', epoch = accountEpoch.current): Promise<boolean> {
    try { return await launch(id, mode, remembered, false, epoch) }
    catch (cause) {
      if (!launchIsCurrent(epoch)) return false
      if (!isMissingWorkspace(cause)) throw cause
      // 目录没了就没有「上次那条对话」可接,退回选择器开新的,总比只甩一条错误强。
      toast.show('上次用的目录已经找不到了，请重新选择。', 'warn')
      return launch(id, 'open', undefined, false, epoch)
    }
  }
  // 设置窗口写进了新 Key：读回配置成功才告诉密钥页，好收起那条「还在用刚撤销的密钥」（#546）。
  // 读回失败就不收，警告宁可多留一会儿。
  function confirmToolKeyWritten(tool: ToolId) {
    const epoch = accountEpoch.current
    const provider = providerFor(tool)
    void toolsApi.readConfig().then((config) => {
      if (!mounted.current || epoch !== accountEpoch.current || config.providers[provider].configurationOwnership === 'missing') return
      setToolConfigConfirmed((current) => ({ provider, sequence: (current?.sequence ?? 0) + 1 }))
    }, () => undefined)
  }
  function finishConfigSave(warning?: string) {
    const epoch = accountEpoch.current
    setConfigTool(null)
    toast.show('配置保存成功', 'ok')
    if (warning) toast.show(warning, 'warn')
    void toolbox.refresh(true).catch(() => {
      if (mounted.current && epoch === accountEpoch.current) {
        toast.show('配置已保存，但最新状态没有读到。请重新检测，无需重复保存。', 'warn')
      }
    })
  }
  function requestUninstall(id: ToolId) {
    const definition = tools.find((tool) => tool.id === id)!
    setConfirmation({ title: `卸载 ${definition.name}？`, body: '工具配置、账户数据和历史记录会保留。', label: '卸载工具', danger: true, tool: id, work: async () => {
      await toolbox.run(id, '正在卸载', async () => {
        const result = await toolsApi.uninstall(id)
        if (result.outcome === 'manual-required') {
          setManualUninstall({ name: definition.name, reason: result.manualHelp.reason, manualCommand: result.manualHelp.manualCommand })
          return
        }
        // 管理员模式下卸载转交给普通窗口：是预料之中的一步，给中性提示，不当失败弹红框。
        const handedOff = uninstallHandOffNotice(result)
        if (handedOff && mounted.current) toast.show(handedOff, 'neutral')
      }, { kind: 'uninstall' })
      await toolbox.refresh(true)
    } })
  }
  function requestRevert(id: ToolId, version: string) {
    const name = tools.find((tool) => tool.id === id)?.name ?? '工具'
    const latestVersion = toolbox.snapshot ? presentTools(toolbox.snapshot).find((tool) => tool.id === id)?.latestVersion ?? null : null
    setConfirmation({ title: `退回 ${name} ${version}？`, body: '更新后如果用着不对劲，可以先退回原来的版本。退回后还会显示有新版本，等下次更新写明修好了再更新。', label: '退回', tool: id, work: async () => {
      // 确认框马上关掉，进度交给工具行，和「更新」一样可以看进度、可以取消。
      void perform('退回工具版本', async () => {
        rememberRevertedToolUpdate(id, latestVersion)
        if (await install(id, version) === 'installed' && mounted.current) toast.show(`已退回 ${name} ${version}。`, 'ok')
      }, id)
    } })
  }
  useEffect(() => native.onUpdateState(setUpdate), [native])
  useEffect(() => {
    function receive() {
      void native.takeExternalDeepLink()
        .then((link) => { if (link && mounted.current) { linkPrompted.current = false; setPendingLink(link) } })
        .catch((cause) => { if (mounted.current) setOperationError({ message: deepLinkReadErrorText(cause), retry: receive }) })
    }
    const unsubscribe = native.onExternalDeepLink(receive)
    receive()
    return () => {
      delete document.documentElement.dataset.rendererReady
      unsubscribe()
    }
  }, [native])
  useEffect(() => {
    if (!pendingLink || boot !== 'ready' || auth || configTool || confirmation || switcher || restartDialog) return
    if (pendingLink.kind === 'invalid') { setOperationError({ message: pendingLink.message }); setPendingLink(null) }
    else if (pendingLink.kind === 'invite') {
      if (session.authenticated) setOperationError({ message: `邀请码为 ${pendingLink.code}。退出当前账号后可用于注册。` })
      else { setInviteCode(pendingLink.code); setAuth('register') }
      setPendingLink(null)
    } else if (session.authenticated) {
      navigate('account', 'orders')
      setPaymentReturn((current) => ({ sequence: (current?.sequence ?? 0) + 1, order: pendingLink.order }))
      setPendingLink(null)
    } else if (!linkPrompted.current) { linkPrompted.current = true; setAuth('login') }
  }, [pendingLink, boot, auth, configTool, confirmation, switcher, restartDialog, session.authenticated, navigate])
  useEffect(() => native.onNavigate((target) => {
    // 系统通知点进来：余额去「充值与订阅」，异步任务去个人中心那一栏，花费突然变多去「用量看板」，公告直接打开公告。
    if (target === 'topup') navigate('account', 'recharge')
    else if (target === 'tasks') navigate('account', 'tasks')
    else if (target === 'usage') navigate('account', visibleAccountTab('dashboard', session) ? 'dashboard' : 'usage')
    else if (target === 'announcement') { if (session.authenticated) setAnnouncementOpen(true) }
    else navigate(target)
  }), [native, navigate, session])
  useEffect(() => native.onLaunchTool((id) => { if (isToolId(id)) requestLaunch(id) }), [native, toolbox.snapshot, session.authenticated])
  useEffect(() => {
    const unsubscribe = native.onWindowCloseRequest(({ requestId }) => {
      void native.replyWindowClose(requestId, {
        blockingTask: Object.keys(toolbox.jobs).length > 0 || confirmBusy || pendingBusinessOperations().length > 0
          || Boolean(accountBootstrap?.scope === scope && !accountBootstrap.result && !accountBootstrap.error)
          || Boolean(document.querySelector('[data-busy="true"]')),
        unsavedChanges: Boolean(document.querySelector('dialog[open], [data-unsaved="true"]')),
      }).catch(() => undefined)
    })
    document.documentElement.dataset.rendererReady = 'true'
    return unsubscribe
  }, [native, toolbox.jobs, confirmBusy, accountBootstrap, scope])
  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      // 放大缩小对整个窗口都有效，弹窗开着也照样能调；Mac 上这里拦下后菜单里的「放大」就不会再动一遍。
      const zoom = uiScaleShortcutFor(event)
      if (zoom) {
        event.preventDefault()
        if (settings) changeUiScale(zoom)
        return
      }
      if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) || document.querySelector('dialog[open]')) return
      if (event.key === ',') { event.preventDefault(); navigate('settings') }
      if (/^[1-5]$/.test(event.key)) {
        const tool = tools.filter((entry) => !entry.hidden?.(os))[Number(event.key) - 1]
        if (tool && isToolId(tool.id)) { event.preventDefault(); requestLaunch(tool.id) }
      }
    }
    document.addEventListener('keydown', onShortcut)
    return () => document.removeEventListener('keydown', onShortcut)
  }, [navigate, os, toolbox.snapshot, session.authenticated, settings, changeUiScale])
  const guideTools: GuideToolState[] = toolbox.snapshot ? presentTools(toolbox.snapshot).map((tool) => ({
    id: tool.id, installed: tool.status.installed, configured: tool.configured, source: guideSource(tool.source),
    version: tool.currentVersion ?? undefined, model: tool.model, detectionError: Boolean(tool.error),
    runtimeReady: nodeRuntimeReady(toolbox.snapshot!.system.runtime),
    runtimeNotNeeded: tool.id !== 'codexDesktop' && !cliNeedsNodeRuntime(toolbox.snapshot!.platform, tool.provider),
    pythonReady: pythonRuntimeReady(toolbox.snapshot!.system.runtime),
    pythonNotNeeded: tool.id !== 'codexDesktop' && !cliNeedsPythonRuntime(toolbox.snapshot!.platform, tool.provider, Boolean(tools.find((entry) => entry.id === tool.id)?.requires.includes('python'))),
    runtimeAutoPrepare: platform?.nodeRuntimeInstall === 'managed', pythonAutoPrepare: platform?.pythonRuntimeInstall === 'managed',
    supported: tool.id !== 'codexDesktop' || platform?.codexDesktop.launch,
    officialLoginRequired: guideOfficialLoginRequired(tool.provider, guideSource(tool.source), toolbox.snapshot!.config.providers[tool.provider]),
    update: toolUpdateOffer(tool),
    installMode: tool.id === 'codexDesktop' ? platform?.codexDesktop.install : platform?.cliInstall[tool.id], workspace: toolbox.snapshot!.config.workspace,
    // 没登录就没有「当前账号」可比：来源没确认的一律按「不是当前账号的 Key」走，
    // 引导只给「登录后改用我的账号」，不因 Key 恰好在我们站上就放行（方案盘查第 1 条）。
    keyState: tool.source === 'changed' ? 'changed' : session.authenticated ? foreignKeyKind(toolbox.snapshot!.config.providers[tool.provider], tool.source) ?? undefined : tool.source === 'unknown' ? 'otherSite' : undefined,
  })) : []
  const balanceAmount = balance && balance.quotaPerUnit > 0 ? balance.quota / balance.quotaPerUnit : null
  const toolUpdates = toolbox.snapshot ? pendingToolUpdates(presentTools(toolbox.snapshot)) : []
  // 启动扫描完成后把「有新版本」汇总成一条系统通知。同一个工具同一个目标版本
  // 只说一次，抑制状态留在本机，所以下次启动不会再念一遍；工具更完或者上游又
  // 出了新版本，记录随之变化，才会再提醒。通知说「回到星芒就能逐个更新」，
  // 所以只算星芒更新得了的那几个（inAppToolUpdates），角标照旧数全部。
  const noticeUpdates = toolbox.snapshot ? inAppToolUpdates(presentTools(toolbox.snapshot)) : []
  const toolUpdateKey = updateNoticeKey(noticeUpdates)
  useEffect(() => {
    // 开机先画出来的上次结果不算：那时说的「有新版本」可能早就更新过了。
    if (!toolbox.snapshot || toolbox.snapshot.system.cachedAt) return
    if (unannouncedToolUpdates(noticeUpdates, readAnnouncedToolUpdates()).length > 0) {
      void platformApi()?.notifyActivity('cliUpdate', toolUpdateKey).catch(() => undefined)
    }
    rememberAnnouncedToolUpdates(noticeUpdates)
    // toolUpdateKey 已经把这一轮的工具与目标版本压成一个字符串，
    // 快照里别的字段变化（余额、运行环境）不该重新触发这段。
  }, [toolUpdateKey, Boolean(toolbox.snapshot), Boolean(toolbox.snapshot?.system.cachedAt)])
  useEffect(() => {
    if (balanceAmount === null) return
    const previous = previousBalance.current
    if (!subscription && previous?.scope === scope && previous.value >= 5 && balanceAmount < 5) {
      void platformApi()?.notifyActivity('balance', `balance:${session.account?.userId ?? 0}:${Date.now()}`).catch(() => undefined)
    }
    previousBalance.current = { scope, value: balanceAmount }
    // subscription 只用来挡这一次提醒，它自己读回来不该补发，所以不进依赖。
  }, [balanceAmount, scope, session.account?.userId])
  // 一小时里花掉的钱远超平时就提醒一次（第十五批 7）：只用余额每次刷新读到的数，
  // 掉得够多了才去读一次用量核账。开关在设置 → 通知「花费突然变多」，由主进程把关。
  const spendWatch = useMemo(() => createSpendSpikeWatch({
    readBaseline: () => toolsApi.spendBaseline(),
    notify: (eventKey, notice) => { void platformApi()?.notifyActivity('spend', eventKey, notice).catch(() => undefined) },
  }), [toolsApi])
  const supportsSpendCheck = session.authenticated && accountSupports(session, 'supportsUsage')
  useEffect(() => {
    if (!balance || balanceState.updatedAt === null || !supportsSpendCheck) return
    void spendWatch.observe({ scope, account: String(session.account?.userId ?? 0), quota: balance.quota, quotaPerUnit: balance.quotaPerUnit, at: balanceState.updatedAt })
  }, [balanceState.updatedAt, balance, scope, session.account?.userId, supportsSpendCheck, spendWatch])
  // 导览看完或被关掉才记成「已看」，所以上次没看完的用户一回到首页就接着播。
  // 从没有过记录的老用户不在此列：他们不会凭空多出一段导览。
  const workspaceVisible = boot === 'ready' && !guide && (session.authenticated || restoring || workspaceEntered)
  useEffect(() => {
    if (workspaceVisible && page === 'home' && tourReplayPending(scope)) setTourOpen(true)
  }, [workspaceVisible, page, scope])
  // 空间不够是另一句话：之前关掉的「有新版本」不该连它一起盖住。
  const updateKey = update ? `${update.phase}:${update.availableVersion}:${update.error?.code ?? ''}${update.diskShortfall ? ':disk' : ''}` : ''
  // 维护提示来自更新目录上的状态文件，没登录也收得到。角落那条可以关，关掉的
  // 是这一句话；发布者换了说法（比如改了预计恢复时间）会再出现一次。
  const maintenance = update?.serviceMaintenance ?? null
  const launchInstall = update?.launchInstallNotice ?? null
  const maintenanceKey = maintenanceNoticeKey(maintenance)
  // 人就在更新页时，说的是页面上同一件事的那几种气泡不弹，离开更新页照旧。
  const showUpdate = update && (update.error || update.currentVersionWithdrawn || ['available', 'downloading', 'downloaded'].includes(update.phase)) && dismissedUpdate !== updateKey
    && !(page === 'updates' && updateBubbleRepeatsUpdatesPage(update))
  // 「自动更新」勾选跟着提示气泡走：用户第一次看到「有新版本」时就能看到它、改它。
  // 这台电脑的更新通道不支持自动更新时不显示，免得勾了没用。
  const autoUpdateToggle = Boolean(update?.autoUpdateSupported && settings && !update.error && !update.rollback)
  const autoUpdateOn = autoUpdateToggle && settings?.autoUpdate !== false
  const updateDiskText = updateDiskShortfallText(update, autoUpdateOn)
  // 气泡上的重试与更新页的重试是同一套（update-retry.ts）：检查失败重新查，下载失败
  // 重新查再下，安装失败跳到更新页的「重启并安装」确认框。
  const runUpdateRetry = (work: () => Promise<UpdateSnapshot>) => {
    setUpdateRetrying(true)
    void perform('重试更新', async () => setUpdate(await work())).finally(() => setUpdateRetrying(false))
  }
  const retryUpdate = () => retryFailedUpdateStep(update?.failedStep, {
    check: () => runUpdateRetry(() => native.checkForUpdates()),
    redownload: () => runUpdateRetry(() => redownloadUpdate(native)),
    confirmInstall: () => { navigate('updates'); requestUpdateInstallConfirm() },
  })
  const accountBootstrapBusy = Boolean(accountBootstrap?.scope === scope && !accountBootstrap.result && !accountBootstrap.error)
  // Account switches can happen while the chat route is active. The retained
  // chat host deliberately keeps its previous scope in state, but rendering
  // must follow the newly authenticated account immediately; otherwise the
  // old-scope equality guard hides the entire page until the user navigates
  // away and back.
  const renderedChatScope = page === 'chat' ? scope : chatScope
  // 「搬到新电脑」：导入前把聊天页同步卸下，免得它下一次自动保存把刚导入的对话又删掉。
  const chatTransfer = useMemo(() => session.authenticated
    ? createChatTransfer(native, window.localStorage, scope, () => flushSync(() => setChatScope(null)))
    : undefined, [native, scope, session.authenticated])
  if (boot !== 'ready') return <Splash platform={os} phase="正在准备星芒 AI" error={bootError || undefined} progress={update?.progress?.percent} onRetry={() => setBootAttempt((value) => value + 1)} />
  return <AccountBalanceContext.Provider value={balanceStore}><OnlineStatusContext.Provider value={onlineStatus}><BalanceTierProvider value={subscription ? 'ok' : balanceAmount === null ? 'neutral' : balanceAmount <= 0 ? 'zero' : balanceAmount < 5 ? 'bad' : balanceAmount < 20 ? 'warn' : 'ok'}>
    {guide ? <StartGuide platform={os} tools={guideTools} signedIn={session.authenticated} busy={Object.keys(toolbox.jobs).length > 0 || accountBootstrapBusy} progress={accountBootstrapBusy && accountBootstrap ? { label: accountBootstrap.label, percent: accountBootstrap.percent } : guideJobProgress(toolbox.jobs)} resumeKey={scope}
      onDetect={() => toolbox.refresh(true)} onInstall={async (id, version) => { await install(id, version) }} onInstallRuntime={() => installRuntime('node')} onInstallPython={() => installRuntime('python')} onConfigure={async (id) => { openToolConfig(id) }} onLogin={() => setAuth('login')}
      accountName={session.account?.username ?? null} onSwitchAccount={(id) => switchToolAccount(id, 'account')} onFailureAction={runGuideFailureAction} support={supportInput} onFailure={setLastFailure} canReplaceNode={canReplaceNode({ platform: platform?.platform, nodeRuntimeInstall: platform?.nodeRuntimeInstall })}
      onLaunch={async (id, newFolder) => id === 'chat' ? true : launch(id, 'open', undefined, newFolder)}
      onComplete={(id) => { if (!writeLocalPreference(`xingmang-v2-guide:${scope}`, id)) toast.show('工具已准备好，但引导偏好没有保存在本机。', 'warn'); setWorkspaceEntered(true); rememberTourPending(scope); setTourOpen(true); navigate(id === 'chat' ? 'chat' : 'home') }} onBack={() => setGuide(false)} onHelp={() => setHelp(true)} />
      : !session.authenticated && !restoring && !workspaceEntered ? <Welcome platform={os} onLogin={() => setAuth('login')} onRegister={() => setAuth('register')} onSteps={() => setGuide(true)} onHelp={() => setHelp(true)} onLegal={setLegal}
        reducedMotion={settings?.reducedMotion} supportQrUrl={qr} onReducedMotionChange={(reducedMotion) => void perform('保存外观', async () => setSettings(await app.savePreferences({ version: 2, reducedMotion })))} />
        : <AppFrame key={scope} activePage={page} account={{ signedIn: session.authenticated, supportsBilling: accountSupports(session, 'supportsBilling'), supportsAnnouncements: session.authenticated, identity: avatarIdentity, displayName: restoreRetrying ? '暂时连不上，登录还在' : restoring ? '正在恢复登录' : session.account?.username, email: restoreRetrying ? '稍后自动重试，不用重新登录' : restoring ? '网络慢时要多等一会儿' : undefined, restoring: restoreRetrying ? 'retrying' : restoring ? 'pending' : undefined, sourceTag: siteId === 'solov-api' ? accountSources[siteId].label : undefined, balance: balanceAmount === null ? undefined : `$${balanceAmount.toFixed(2)}`, subscription: subscription ? `订阅：${subscriptionSummaryText(subscription, (usd) => `$${usd.toFixed(2)}`)}` : undefined, balanceLoading: balanceState.loading, balanceUpdatedAt: balanceState.updatedAt, balanceError: balanceState.error }} platform={os}
          tourOpen={tourOpen} onTourClose={() => { rememberTourSeen(scope); setTourOpen(false) }}
          environment={buildEnvironmentStatus(diagnosticsCounts, toolbox.snapshot?.system.runtime)} version={update?.currentVersion}
          unread={unread} installedCount={toolbox.snapshot ? presentTools(toolbox.snapshot).filter((tool) => tool.status.installed).length + visibleExternalClients(os, toolbox.externalClients).filter((tool) => tool.installed).length : undefined}
          updatableCount={toolUpdates.length}
          network={latestNetworkLocation(toolbox.snapshot?.system.network, networkLocation.snapshot.network)}
          networkRefreshing={networkLocation.snapshot.busy}
          banner={<><RestartReminder restart={toolsApi.restartWindows} />{session.authenticated && <AnnouncementCenter key={scope} scope={scope} read={app.announcement} refreshTick={balanceState.updatedAt} markRemoteRead={app.markAnnouncementRead} syncLocalReads={app.syncLocalNoticeReads} open={announcementOpen} onClose={() => setAnnouncementOpen(false)} onOpen={() => setAnnouncementOpen(true)} onUnread={setUnread} openExternal={app.openExternal} noticeUrl={relaySite.websiteUrl} notify={notifyAnnouncement}
            promoVisible={page === 'home'} onTopUp={accountSupports(session, 'supportsBilling') ? (amount) => navigate('account', 'recharge', amount) : undefined}
            readTopupOffers={accountSupports(session, 'supportsBilling') ? () => native.getAccountTopupInfo() : undefined} />}</>}
          notification={showUpdate && <Notice tone={update.error ? updateFailureTone(update) : updateDiskText ? 'warn' : 'accent'} title={update.error ? updateFailureLabel(update.failedStep).title : updateBubbleTitle(update)}
            body={update.error ? userFacingErrorMessage(update.error) : updateDiskText ?? autoUpdateBubbleBody(update.phase, autoUpdateOn, update.installMethod)} progress={update.progress?.percent} onDismiss={() => setDismissedUpdate(updateKey)}
            actions={<>{update.error && !updateNeedsManualReinstall(update) && <Button size="sm" variant="primary" testId="update-bubble-retry" loading={updateRetrying} onClick={retryUpdate}>{updateFailureLabel(update.failedStep).retry}</Button>}
              {updateOffersDownloadPage(update) && <Button size="sm" variant={updateNeedsManualReinstall(update) ? 'primary' : 'secondary'} onClick={() => void perform('打开下载页', () => app.openExternal(appReleaseDownloadUrl))}>打开下载页</Button>}
              {updateDiskText && <Button size="sm" onClick={() => navigate('tutorial', updatesTutorialTopic)}>怎么清理</Button>}<Button size="sm" onClick={() => navigate('updates')}>查看更新</Button>
              {autoUpdateToggle && <Switch testId="update-auto-toggle" label="自动更新" checked={autoUpdateOn} onChange={(autoUpdate) => void perform('保存自动更新', async () => setSettings(await app.savePreferences({ version: 2, autoUpdate })))} />}</>} />}
          adapter={{ navigate, searchTutorial, accountTabVisible: (tab) => !session.authenticated || visibleAccountTab(tab, session), pageVisible: (id) => id !== 'acceleration' || accelerationAvailable,
            settingsItemVisible: (item: SettingsItem) => settingsItemAvailable(item, { mac: os === 'mac', autoUpdate: Boolean(update?.autoUpdateSupported), acceleration: accelerationAvailable, signedIn: session.authenticated }), refreshNetwork: () => { void networkLocation.refresh() }, openAccount: () => navigate('account'), switchAccount: () => setSwitcher(true), topUp: () => navigate('account', accountSupports(session, 'supportsBilling') ? 'recharge' : 'overview'), refreshBalance: () => { void balanceStore.refresh('manual') },
            ...(accelerationAvailable ? { redeemAccelerationCode: async (code: string) => {
              if (!session.authenticated) throw new Error('请先登录星芒账号，再领取加速时长。')
              const epoch = accountEpoch.current
              const result = await acceleration.redeem(code)
              return mounted.current && accountEpoch.current === epoch ? result : null
            } } : {}),
            openHealth: () => navigate('health'), openUpdates: () => navigate('updates'), openHelp: () => setHelp(true), openAnnouncements: () => setAnnouncementOpen(true), openNotifications: () => navigate('updates'),
            logout: () => setConfirmation({ title: '退出星芒账号？', body: '已写入工具的配置会保留。', label: '退出登录', work: async () => { await app.logout(); await reloadAccount() } }),
          }}>
          <div key={scope} className="v2-page-host">
            {renderedChatScope === scope && <div className="v2-chat-host" hidden={page !== 'chat'}><Suspense fallback={pageLoading}><ChatPage bridge={native} accountScope={scope} active={page === 'chat'} onOpenAccount={(tab) => navigate('account', visibleAccountTab(tab, session) ? tab : 'overview')} /></Suspense></div>}
            {visitedPages.acceleration === scope && <div data-testid="page-acceleration" hidden={page !== 'acceleration'} inert={page !== 'acceleration'}>
              <Suspense fallback={pageLoading}>
                <AccelerationPage connection={acceleration} scope={session.authenticated ? scope : null} live={page === 'acceleration'}
                  onLogin={() => setAuth('login')} onHelp={() => setAccelerationHelp(true)} onViewLog={() => navigate('feedback')} preview={accelerationPreview}
                  onContactSupport={() => setHelp(true)} onRelaunch={() => void perform('重开软件', async () => { await app.relaunch() })} />
              </Suspense>
            </div>}
            {page === 'home' ? <Home api={toolsApi} accountScope={scope} supportsUsage={accountSupports(session, 'supportsUsage')} supportsBilling={accountSupports(session, 'supportsBilling')} snapshot={toolbox.snapshot} loading={toolbox.loading} error={toolbox.error} failures={toolbox.failures} account={session.account} accountRestoring={restoring} balance={balance} subscription={subscription} jobs={toolbox.jobs} bootstrap={accountBootstrap?.scope === scope ? accountBootstrap : null}
              externalClients={visibleExternalClients(os, toolbox.externalClients)} externalLoading={toolbox.externalLoading} externalError={toolbox.externalError} recentRevision={recentRevision}
              onScan={() => { refreshRecent(); void toolbox.refresh(true).catch(() => undefined); void toolbox.refreshExternal(true).catch(() => undefined) }} onInstall={(id, version) => void perform('安装工具', () => install(id, version), id)} onCancelInstall={(id) => void perform('取消安装', () => cancelInstall(id))} onLaunch={requestLaunch} onLaunchInNewFolder={(id) => requestLaunch(id, undefined, 'new', true)} onConfigure={openToolConfig} onUninstall={requestUninstall} onRevert={requestRevert}
              onRewriteKey={(id) => void perform('重新写入 Key', () => rewriteAccountKeys([providerFor(id)]), id)} onKeepConfig={(id) => void perform('保留当前配置', () => keepCurrentToolConfig(id))}
              onSwitchAccount={(id, target) => void perform(target === 'account' ? '改用当前账号' : '切回官方账号', async () => { if (await switchToolAccount(id, target)) confirmToolKeyWritten(id) }, id)}
              onRepairHooks={(id) => void perform('修提醒设置', () => repairToolHooks(id), id)}
              onOpenConfigDirectory={(id) => void perform('打开配置文件夹', () => toolsApi.openConfigDirectory(id))}
              onInstallExternal={(id) => void perform('安装客户端', () => installExternal(id))} onCancelInstallExternal={(id) => void perform('取消安装', () => cancelInstall(id))} onLaunchExternal={(id) => void perform('打开客户端', () => launchExternal(id))} onOpenExternalDownload={(url) => void perform('打开下载页', () => app.openExternal(url))}
              onConfigureExternal={setExternalClient} onCodexModels={() => { setCodexModelFilter('non-gpt'); setConfigTool(platform?.codexDesktop.launch ? 'codexDesktop' : 'codex') }}
              onRuntime={(runtime) => void perform('准备环境', () => installRuntime(runtime))} onNavigate={navigate} onGuide={() => setGuide(true)} onBootstrapRetry={() => { if (session.account) void runAccountBootstrap(session.account.userId, 'login', true) }} />
              : null}
            {(Object.keys(visitedPages) as PageId[]).filter((id) => id !== 'acceleration' && (visitedPages[id] === scope || id === page)).map((id) => <div key={id === 'settings' ? `settings:${settingsRequest}` : id} hidden={page !== id} inert={page !== id}>
              <Suspense fallback={pageLoading}>
                <BusinessPage api={native} page={id} accountTab={accountTab.value} accountTabRequest={accountTab.sequence} accountRechargeAmount={accountTab.rechargeAmount} accountSession={session} tutorialTopic={tutorialTopic ?? undefined} paymentReturn={paymentReturn} navigate={navigate} openLogin={(target) => { setAuthTarget(target ?? null); setAuth('login') }} openHelp={() => setHelp(true)}
                  switchAccount={() => setSwitcher(true)} appSettings={settings ?? undefined}
                  onSessionsChanged={refreshRecent}
                  onBackupRestored={() => void toolbox.refreshConfig().catch(() => undefined)}
                  onToolConfigSaved={() => void toolbox.refreshConfig().catch(() => undefined)}
                  toolConfigConfirmed={toolConfigConfirmed}
                  installedProviders={installedProviders}
                  onAccountChanged={() => void perform('刷新账号', reloadAccount)} onSettingsChanged={setSettings} uiScale={settings ? settings.uiScale ?? 'auto' : undefined} openConfig={openToolConfig}
                  openGuide={() => setGuide(true)} replayTour={replayTour} chatTransfer={chatTransfer}
                  onToolsChanged={(tool) => syncAfterToolInstalled(tool).catch((cause) => {
                    if (mounted.current) toast.show(errorMessage(cause, '工具已安装，但最新状态没有读到。请回到首页重新检测。'), 'warn')
                  })}
                  installTool={install} cancelToolInstall={(tool) => toolbox.cancel(tool)} toolJobs={toolbox.jobs}
                  onRewriteKey={(provider) => rewriteAccountKeys([provider])} rewritableKeys={rewritableKeys}
                  onSubscriptionActivated={applySubscriptionToTools} onSubscriptionPurchased={() => void refreshSubscription()} />
              </Suspense>
            </div>)}
          </div>
        </AppFrame>}
    {auth && <AuthFlow api={authApi} initialMode={auth} initialInviteCode={inviteCode} initialSiteId={authTarget?.siteId} initialIdentifier={authTarget?.identifier} sessionOnly={session.sessionOnly === true} onClose={() => { setAuth(null); setAuthTarget(null) }} onHelp={() => setHelp(true)}
      notice={maintenance ? <MaintenanceNotice maintenance={maintenance} testId="auth-maintenance-notice" /> : undefined} onAuthenticated={(result, options) => {
      const authenticatedScope = accountScope(result)
      suppressRestoredBootstrap.current.add(authenticatedScope)
      setAuth(null); setAuthTarget(null); setSession({ ...result, authenticated: true }); setGuide(!readLocalPreference(`xingmang-v2-guide:${authenticatedScope}`))
      void runAccountBootstrap(result.account.userId, 'login', true, undefined, accountSiteId(result))
      if (options?.notice) toast.show(options.notice, 'ok')
      if (options?.rememberError) toast.show(options.rememberError, 'warn')
    }} />}
    {legal && <LegalDocument api={authApi} kind={legal} onClose={() => setLegal(null)} />}
    {switcher && <Dialog open title="切换账号" width={480} onClose={() => setSwitcher(false)}><SavedAccounts api={native} onAccountChanged={(result) => { bootstrapEpoch.current++; bootstrapInFlight.current = null; if (result) suppressRestoredBootstrap.current.add(accountScope({ siteId: siteIdForOrigin(result.origin) ?? undefined, account: { userId: result.userId } as AccountSessionState['account'] })); setAccountBootstrap(null); if (!result || !accountSwitchNeedsAttention(result)) setSwitcher(false); setPaymentReturn(undefined); void perform('刷新账号', reloadAccount) }} onLogin={(target) => { setSwitcher(false); setAuthTarget(target ?? null); setAuth('login') }} /></Dialog>}
    {externalClient && <ExternalClientDialog key={`${scope}:${externalClient}`} api={native} tool={externalClient} signedIn={session.authenticated} onClose={() => setExternalClient(null)} onSaved={finishExternalConfigSave} />}
    {configTool && toolbox.snapshot && <ConfigDialog key={`${scope}:${configTool}:${codexModelFilter}`} api={toolsApi} tool={configTool} config={toolbox.snapshot.config} signedIn={session.authenticated} initialModelFilter={codexModelFilter}
      onClose={() => setConfigTool(null)} onRefresh={() => toolbox.refresh(true)} onSaved={finishConfigSave} onKeyWritten={confirmToolKeyWritten} onLogin={() => setAuth('login')} onKeys={() => { setConfigTool(null); navigate('account', 'keys') }} onHelp={() => setHelp(true)}
      accountName={session.account?.username ?? null}
      onSwitchAccount={async (id) => {
        const switched: { result: AccountSourceSwitchResult | null } = { result: null }
        await perform('改用当前账号', async () => { switched.result = await switchToolAccount(id, 'account') }, id)
        return switched.result
      }} />}
    {accelerationHelp && <Dialog open title="游戏加速使用说明" onClose={() => setAccelerationHelp(false)} width={480}
      footer={<><Button variant="ghost" onClick={() => { setAccelerationHelp(false); setHelp(true) }}>帮助与客服</Button><Button onClick={() => setAccelerationHelp(false)}>知道了</Button></>}>
      <p>选择线路后点击“开始加速”，连接成功后再打开游戏或启动器。“智能分配”会自动测速并选择可用线路，也可以手动选择。</p>
      <p>当前适用于部分游戏、启动器和下载场景，实际连接效果以应用内表现为准。加速只改这台电脑的系统代理，不接管整台电脑的网络。</p>
      <p>每个账号在本机累计享有 20 分钟免费体验。连接成功后才开始计时，停止后保留剩余时长，下次继续使用，不会每天重置。当前时长在本机保存，设备之间不同步。</p>
      <p>切换页面、缩到托盘或退出游戏都不会停止加速。点击“停止加速”或退出本软件才会断开；免费时长用完后自动停止。</p>
    </Dialog>}
    {help && <Dialog open title="帮助与客服" onClose={() => setHelp(false)} width={640} testId="support-dialog">
      {/* 左边扫码、右边复制身份，常用的几处去向排在下面一行，弹框不再高出一截。 */}
      <div className="v2-support"><div className="v2-support-contact">{qr && <img src={qr} alt="微信客服二维码" />}<h3>微信扫码找客服</h3><p>装不上、付了没到账，都可以问。</p>
        {qrFallback && <p role="alert" data-testid="support-qr-fallback">{qrFallback}</p>}</div>
        <SupportIdentity line={supportIdentity} lastFailure={lastFailureLine} onCopy={() => { void navigator.clipboard.writeText(lastFailureLine ? `${supportIdentity}\n${lastFailureLine}` : supportIdentity).then(() => toast.show('已复制，发给客服就行', 'ok'), () => toast.show('没复制上，请手动选中这行文字复制。', 'warn')) }} /></div>
      <div className="v2-support-actions"><Button onClick={() => void perform('打开帮助', () => app.openExternal(supportUrl))}>在浏览器打开</Button><Button onClick={() => { setHelp(false); navigate('feedback') }}>去反馈页</Button><Button onClick={() => { setHelp(false); navigate('tutorial') }}>使用教程</Button></div>
      {/* 欢迎页和引导里没有侧栏，「左边「更多」」无从说起，这一行只在主界面里出。 */}
      {!guide && (session.authenticated || restoring || workspaceEntered) && <div className="v2-support-more" data-testid="support-more"><span>左边「更多」里还有：</span>{(['maintenance', 'backups', 'updates'] as const).map((id) => <Button key={id} size="sm" onClick={() => { setHelp(false); navigate(id) }} testId={`support-more-${id}`}>{pageRegistry.find((entry) => entry.id === id)?.label}</Button>)}</div>}
    </Dialog>}
    <RequiredUpdateGate update={update} windows={os === 'win'} linux={os === 'linux'} actions={{
      check: () => native.checkForUpdates(), download: (options) => native.downloadUpdate(options), install: () => native.installUpdate(),
      openDownloadPage: () => void perform('打开下载页', () => app.openExternal(appReleaseDownloadUrl)), contactSupport: () => setHelp(true),
    }} />
    <StartupNotices notices={startupNotices} onDismiss={dismissStartupNotice}
      leading={[
        ...(launchInstall ? [<LaunchInstallNotice key={`launch-install-${launchInstall.installAt}`} notice={launchInstall} />] : []),
        ...(maintenance && maintenanceKey !== dismissedMaintenance ? [<MaintenanceNotice key="maintenance" maintenance={maintenance} onDismiss={() => setDismissedMaintenance(maintenanceKey)} />] : []),
      ]}
      onOpen={(id, action) => {
        if ('supportFailure' in action) {
          // 复制上了才收起卡片；没复制上就打开帮助框，那里的文字能手动选中复制。
          const text = buildSupportBundle(supportInput, action.supportFailure)
          const copied = navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error('clipboard unavailable'))
          void copied.then(() => { dismissStartupNotice(id); toast.show('已复制，发给客服就行', 'ok') },
            () => { setHelp(true); toast.show('没复制上，请在「帮助与客服」里手动选中文字复制。', 'warn') })
          return
        }
        dismissStartupNotice(id)
        if ('login' in action) setAuth('login')
        else if ('page' in action) navigate(action.page, action.section)
        else if ('displayCompat' in action) void chooseDisplayCompat(action.displayCompat)
        else if ('crashReporting' in action) void chooseCrashReporting(action.crashReporting)
        else if ('relaunch' in action) void perform('重开软件', async () => { await app.relaunch() })
      }} />
    {operationError && <OperationErrorDialog failure={operationError} installDirectory={toolInstallDirectory(toolbox.snapshot, operationError.tool)} canReplaceNode={canReplaceNode({ platform: platform?.platform, nodeRuntimeInstall: platform?.nodeRuntimeInstall })} support={supportInput} onClose={() => setOperationError(null)} onAction={runOperationAction} />}
    {nodeReplace && <NodeReplaceDialog version={toolbox.snapshot?.system.runtime.node.version} onClose={() => setNodeReplace(null)} onConfirm={() => {
      const retry = nodeReplace.retry
      setNodeReplace(null)
      void perform('换成新版 Node.js', () => replaceNode(retry))
    }} />}
    {storeNewerVersion && <Dialog open title="微软商店里有更新的一版" onClose={() => setStoreNewerVersion(null)} width={480} testId="codex-desktop-store-newer" footer={<>
      <Button onClick={() => setStoreNewerVersion(null)}>先不用</Button>
      <Button variant="primary" testId="codex-desktop-store-newer-open" onClick={() => { setStoreNewerVersion(null); void perform('打开微软商店', openCodexDesktopStore) }}>去微软商店装</Button>
    </>}><p>国内下载线路还没跟上，这台电脑上的 Codex 桌面端这次没有变。微软商店里已经有 {storeNewerVersion}，想用最新版就去商店点「更新」或「获取」。</p></Dialog>}
    {manualUninstall && <ManualUninstallDialog state={manualUninstall} platform={platform?.platform} onClose={() => setManualUninstall(null)} />}
    {!operationError && session.authenticated && accountReadError?.scope === scope && <Dialog open title="操作没有完成" onClose={() => setAccountReadError(null)} footer={<>
      <Button onClick={() => setAccountReadError(null)}>返回</Button>
      {accountReadErrorAction(accountReadError.message) === 'relogin'
        ? <Button variant="primary" testId="account-read-relogin" onClick={() => { setAccountReadError(null); setAuth('login') }}>重新登录</Button>
        : <Button variant="primary" testId="account-read-retry" onClick={() => { setAccountReadError(null); void reloadAccount() }}>重试</Button>}
    </>}><p role="alert">{accountReadError.message}</p></Dialog>}
    {ccSwitchReminder && <Dialog open title="请先退出 CC Switch" onClose={() => setCcSwitchReminder(false)} width={480} testId="cc-switch-reminder"
      footer={<Button variant="primary" onClick={() => setCcSwitchReminder(false)}>知道了</Button>}>
      <p>这个工具以前用 CC Switch 配过。CC Switch 还开着的话，会把刚改好的设置又改回去。不再用它的话，请把它退出（包括托盘里的图标）。</p>
    </Dialog>}
    {switchRestartOffer && <Dialog open title="Codex 桌面端还开着" onClose={() => setSwitchRestartOffer(null)} busy={Boolean(toolbox.jobs['launch:codexDesktop'])} footer={<>
      <Button variant="ghost" onClick={() => setSwitchRestartOffer(null)}>先不用</Button>
      <Button variant="primary" testId="switch-restart-codex-desktop" onClick={() => void perform('重开 Codex 桌面端', async () => { await launch('codexDesktop', 'restart'); setSwitchRestartOffer(null) })}>帮我重开</Button>
    </>}><p>{switchRestartOffer === 'official' ? '它还在用刚才的账号，要重开才会换回官方账号。' : '它还在用刚才的账号，要重开才会用上当前账号。'}重开会打断它正在进行的回答。</p></Dialog>}
    {restartDialog && <Dialog open title="Codex 已在运行" onClose={() => setRestartDialog(false)} busy={Boolean(toolbox.jobs['launch:codexDesktop'])} footer={<>
      <Button variant="ghost" onClick={() => setRestartDialog(false)}>取消</Button>
      <Button onClick={() => void perform('重启 Codex', async () => { await launch('codexDesktop', 'restart'); setRestartDialog(false) })}>重启 Codex</Button>
      <Button variant="primary" onClick={() => void perform('打开 Codex', async () => { await launch('codexDesktop'); setRestartDialog(false) })}>打开窗口</Button>
    </>}><p>可以直接打开现有窗口；需要重新加载配置时，选择重启 Codex。</p></Dialog>}
    {/* 显示中文要在本机开一个调试端口（早先审查标过的安全点），所以仍然问一次、不替用户默认开。
        两个按钮同等样式，键盘焦点落在「先不用」：随手一按回车不会开端口，想要中文的人点一下就行。 */}
    {chineseDialog && <Dialog open title="要让 Codex 的界面显示中文吗？" onClose={() => setChineseDialog(false)} busy={Boolean(toolbox.jobs['launch:codexDesktop'])} initialFocus={chineseDecline} footer={<>
      <Button ref={chineseDecline} testId="codex-chinese-decline" onClick={() => void perform('打开 Codex', () => answerChineseRuntimePatch('disabled'))}>先不用</Button>
      <Button testId="codex-chinese-enable" onClick={() => void perform('启用中文界面', () => answerChineseRuntimePatch('enabled'))}>显示中文</Button>
    </>}><p>选「显示中文」后，星芒每次打开 Codex 时会顺带开一个只有这台电脑自己能连的通道，用来把界面换成中文；关掉 Codex，通道也跟着关上。</p>
      <p>不用也没关系，Codex 照样能用，只是界面是英文。只问这一次，以后想改，随时可以在 Codex 桌面端的配置里打开或关掉。</p></Dialog>}
    {/* 默认模型换不换由用户点，不替付费客户自动换（第十二批候选 5）；关掉对话框 = 这次先不打开。 */}
    {modelSwap && <Dialog open title="默认模型用不了了" onClose={() => modelSwap.answer('cancel')} footer={<>
      <Button testId="model-swap-keep" onClick={() => modelSwap.answer('keep')}>照旧打开</Button>
      <Button variant="primary" testId="model-swap-confirm" onClick={() => modelSwap.answer('swap')}>换成 {modelSwap.offer.replacement}</Button>
    </>}><p data-testid="model-swap-question">{modelSwapQuestion(modelSwap.offer)}</p></Dialog>}
    {runtimeRestart && <RuntimeRestartDialog onClose={() => setRuntimeRestart(false)} restart={toolsApi.restartWindows} />}
    {/* 点「取消」或关掉框都是不换：install 收到 false，什么都不动。 */}
    {managedSwitch && <Confirm {...managedSwitchConfirmation(managedSwitch.version)} testId="managed-switch-confirm" onOk={() => managedSwitch.answer(true)} onClose={() => managedSwitch.answer(false)} />}
    {confirmation && <Confirm title={confirmation.title} body={confirmation.body} danger={confirmation.danger} okLabel={confirmation.label} loading={confirmBusy} onClose={() => setConfirmation(null)} onOk={() => {
      if (confirmationLock.current) return
      confirmationLock.current = true; setConfirmBusy(true)
      void confirmation.work().then(() => setConfirmation(null)).catch((cause) => setOperationError({ ...operationFailureFrom(cause), ...(confirmation.tool ? { tool: confirmation.tool } : {}) })).finally(() => { confirmationLock.current = false; setConfirmBusy(false) })
    }} />}
  </BalanceTierProvider></OnlineStatusContext.Provider></AccountBalanceContext.Provider>
}

export default function RendererV2App({ api, accelerationPreview = false }: { api?: XingmangApi; accelerationPreview?: boolean }) {
  const native = api ?? getBridge()
  if (!native) return <Splash phase="请从桌面应用打开工具箱" error="浏览器页面未连接本机服务。" />
  return <FailureBoundary native={native}><ToastProvider><RuntimeApp native={native} accelerationPreview={accelerationPreview} /></ToastProvider></FailureBoundary>
}
