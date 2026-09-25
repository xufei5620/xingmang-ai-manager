import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import QRCode from 'qrcode'
import type { AccountSessionState, AccountSourceSwitchResult, AccountSourceTarget, AppSettingsV2, CliLaunchMode, ExternalDeepLink, ExternalToolId, LegalDocumentKind, PlatformCapabilities, ProviderId, UpdateSnapshot, XingmangApi } from '../../electron/ipc-contract'
import { resolveRelaySite, resolveSupportServiceUrl } from '../../electron/relay-sites'
import { offersCodexDesktopRestart } from '../../electron/running-tools'
import { Shell as AppFrame } from './features/shell/Shell'
import { isOffline, offlineActionMessage } from './features/shell/online-status'
import { OnlineStatusContext, useBrowserOnline, type OnlineStatus } from './features/shell/useOnlineStatus'
import { createAppApi } from './features/app/api'
import { AuthFlow, LegalDocument, Splash, StartGuide, Welcome, createAuthApi, guideOfficialLoginRequired, type AuthMode, type GuideToolState, type LoginTarget } from './features/auth'
import { ConfigDialog } from './features/tools/ConfigDialog'
import { ExternalClientDialog } from './features/tools/ExternalClientDialog'
import { Home } from './features/tools/Home'
import { createToolsApi } from './features/tools/api'
import { launchWaitLabel, launchWarning } from './features/tools/launch-notice'
import { modelSwapOffer, modelSwapQuestion, type ModelSwapChoice, type ModelSwapOffer } from './features/tools/model-check'
import { chineseRuntimePatchAnswerMissing, shouldAskForChineseRuntimePatch } from './features/tools/chinese-runtime-choice'
import { cliInstallStageLabel, nodeRuntimeReady, planCliInstall, pythonRuntimeReady, runtimeStageFailureMessage, type InstallRuntimeId } from './features/tools/runtime-readiness'
import { foreignKeyKind, isToolId, presentTools, providerFor, toolInstallDirectory, toolUpdateOffer, type ToolId, type ToolSource } from './features/tools/model'
import { pendingToolUpdates, readAnnouncedToolUpdates, rememberAnnouncedToolUpdates, unannouncedToolUpdates, updateNoticeKey } from './features/tools/update-notice'
import { isMissingWorkspace } from './features/tools/recent-workspaces'
import { uninstallHandOffNotice } from './features/tools/uninstall-handoff'
import { describeRuntimeInstallOutcome, type RuntimeInstallOutcome } from './features/tools/runtime-install-outcome'
import { RuntimeRestartDialog } from './features/tools/RuntimeRestartDialog'
import { guideJobProgress, installedToolSyncLabel, useToolbox } from './features/tools/useToolbox'
import { ManualUninstallDialog, type ManualUninstallState } from './features/tools/ManualUninstall'
import { operationLogPage, type OperationActionId } from './operation-error'
import { accountTabs, macDesktopTutorialTopic, settingsGroups, autoUpdateBubbleBody, updateBubbleTitle, updateFailureLabel } from './registry/business'
import { tools } from './registry/tools'
import { clientConnections } from './registry/clients'
import type { PageId } from './registry/pages'
import type { ToolInstallOutcome } from './pages-maintenance'
import type { ToolConfigConfirmation } from './pages-account'
import { BalanceTierProvider, Button, Confirm, Dialog, Notice, Switch, ToastProvider, useToast, useReducedMotion } from './ui'
import { bridge as getBridge } from './bridge'
import { errorMessage, pendingBusinessOperations } from './business-common'
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
import { OperationErrorDialog, type OperationFailure } from './features/app/OperationErrorDialog'
import { StartupNotices } from './features/app/StartupNotices'
import { MaintenanceNotice, maintenanceNoticeKey } from './features/app/MaintenanceNotice'
import { displayCompatNotice, displayRelaunchNotice, settingsSaveNotice, startupCheckFailure, startupCheckLogContext, startupDiagnosticsIssues, updatedNotice, vaultRecoveredNotice, withStartupNotice, withoutStartupNotice, type StartupCheckId, type StartupNotice } from './features/app/startup-notice'
import { readLocalPreference, writeLocalPreference } from './features/app/preferences'
import { currentWindowOs, windowOsFor } from './features/app/window-os'
import { rememberTourPending, rememberTourSeen, tourReplayPending } from './features/shell/tour-state'
import { onboardingPreviewEnabled } from './features/app/dev-preview'
import { deepLinkReadErrorText, supportQrFallbackText } from './features/app/fallback-messages'
import { SupportIdentity, buildSupportIdentityLine } from './features/app/SupportIdentity'
import { KeyRewriteSkippedError, bootstrapAccountTools, skippedNamedProviders, describeAccountBootstrapFailure, describeAccountBootstrapResult, type AccountBootstrapLogLine, type AccountBootstrapMode, type AccountBootstrapProgress, type AccountBootstrapResult } from './features/tools/account-bootstrap'
import { rewritableKeyProviders } from './features/tools/connection-check'
import { applyManualSourceMarker, getSourceMarkerStorage } from './features/tools/source-marker'
import { idleOnlineResync, noteBootstrapOutcome, planOnlineResync } from './features/tools/online-resync'
import { accountOrigin, accountScope, accountSiteId, accountSupports, sessionRestoreRetrying, sessionRestoring, sessionScope, siteIdForOrigin, visibleAccountTab, type AccountSiteId } from './account-context'
import { accountReadErrorAction, formatAccountReadError } from './features/app/account-read-error'
import { AccountBalanceContext, useAccountBalanceStore } from './features/app/balance-context'
import { hasPendingSettingsGroup, requestSettingsGroup } from './features/app/settings-group-intent'
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
  const [session, setSession] = useState<AccountSessionState>({ authenticated: false, account: null })
  const [update, setUpdate] = useState<UpdateSnapshot | null>(null)
  const [dismissedMaintenance, setDismissedMaintenance] = useState<string | null>(null)
  const [page, setPage] = useState<PageId>('home')
  const [chatScope, setChatScope] = useState<string | null>(null)
  const [visitedPages, setVisitedPages] = useState<Partial<Record<PageId, string>>>({})
  // 带序号：已经停在「我的订单」时再点「充值」，值还是上次那个 'wallet'，
  // 光比值 React 不会重新切过去（全面检测 Q29），同 tutorialTopic。
  const [accountTab, setAccountTab] = useState<{ sequence: number; value: AccountTab }>({ sequence: 0, value: 'overview' })
  // 教程页停在哪一章。页面挂上之后只是 hidden 不会重新挂载，所以每次跳转都换一个
  // sequence，教程页才接得住第二次、第三次跳过来。
  const [tutorialTopic, setTutorialTopic] = useState<{ sequence: number; id: string } | null>(null)
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
  /** 换模型弹框还开着时切了账号，要替用户点掉：那是上一个账号的提问（#538）。 */
  const pendingModelSwap = useRef<((choice: ModelSwapChoice) => void) | null>(null)
  const [chineseDialog, setChineseDialog] = useState(false)
  const chineseDecline = useRef<HTMLButtonElement>(null)
  const [dismissedUpdate, setDismissedUpdate] = useState('')
  const [operationError, setOperationError] = useState<OperationFailure | null>(null)
  const [startupNotices, setStartupNotices] = useState<readonly StartupNotice[]>([])
  const [manualUninstall, setManualUninstall] = useState<ManualUninstallState | null>(null)
  const [accountReadError, setAccountReadError] = useState<{ scope: string; message: string } | null>(null)
  const [supportQr, setSupportQr] = useState<{ url: string; data: string | null }>()
  const accountEpoch = useRef(0)
  const mounted = useRef(true)
  const confirmationLock = useRef(false)
  const launchRequest = useRef(false)
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
  const toolbox = useToolbox(native, boot === 'ready' && (session.authenticated || restoring || guide || workspaceEntered), scope)
  const accelerationApi = useMemo(() => createAccelerationApi(native), [native])
  const acceleration = useAcceleration(accelerationApi, session.authenticated ? scope : null)
  const networkLocation = useNetworkLocation(native, acceleration.snapshot.state)
  // 没在加速时不再定时读状态，所以进加速页时读一次：托盘或 Codex 桌面端可能刚连上过。
  const refreshAcceleration = acceleration.refresh
  useEffect(() => { if (page === 'acceleration') void refreshAcceleration() }, [page, refreshAcceleration])
  const { store: balanceStore, snapshot: balanceState } = useAccountBalanceStore(native, session.authenticated ? scope : null)
  const balance = balanceState.balance
  const browserOnline = useBrowserOnline()
  const offline = isOffline({ browserOnline, networkFailures: session.authenticated ? balanceState.networkFailures : 0 })
  const [onlineChecking, setOnlineChecking] = useState(false)
  // 系统说网回来了，不等下一次定时刷新：马上读一次余额，确认真的通了横幅才收起。
  useEffect(() => {
    if (browserOnline && session.authenticated && balanceStore.getSnapshot().networkFailures > 0) void balanceStore.refresh('manual')
  }, [browserOnline, balanceStore, session.authenticated])
  const recheckOnline = useCallback(() => {
    if (!navigator.onLine || !session.authenticated) return
    setOnlineChecking(true)
    void balanceStore.refresh('manual').finally(() => { if (mounted.current) setOnlineChecking(false) })
  }, [balanceStore, session.authenticated])
  const onlineStatus = useMemo<OnlineStatus>(() => ({ offline, checking: onlineChecking, recheck: recheckOnline }), [offline, onlineChecking, recheckOnline])
  // 换账号等于换了一整套上下文：首页那份「最近」缓存（60 秒）必须当场作废，
  // 否则切过去的头一眼看到的还是上一个账号在的时候读到的列表。
  useLayoutEffect(() => { accountEpoch.current++; pendingModelSwap.current?.('cancel'); setAccountReadError(null); refreshRecent() }, [scope, session.authenticated, refreshRecent])
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
  useEffect(() => {
    let current = true
    const eventsAtStart = sessionEvents.current
    setBoot('loading'); setBootError('')
    void app.bootstrap().then((result) => {
      if (!current) return
      setSettings(result.settings); setPlatform(result.platform); setUpdate(result.update)
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
        if (!mounted.current || epoch !== bootstrapEpoch.current) return
        setAccountBootstrap((current) => current && current.scope === bootstrapScope
          ? { ...current, phase: 'verifying', label: result.failed.length ? 'Key 同步完成，部分工具待处理' : 'Key 已写入，正在刷新工具状态', percent: 100, result }
          : current)
        setWorkspaceEntered(true)
        // 只重读配置，不再把整轮环境探测走第二遍：跟着 Key 变的只有配置状态，
        // 已装/版本/桌面端是首屏那遍刚探完的（见 useToolbox.refreshConfig）。
        await toolbox.refreshConfig().catch(() => undefined)
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
  }, [native, settings, toolbox.refreshConfig, siteId])
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
  // 官方账号与手填密钥重写不动（重写流程本身会跳过它们），所以按钮按当前配置的
  // 来源决定给不给，而不是见到密钥层失败就画一颗出来。
  const rewritableKeys = useMemo(
    () => rewritableKeyProviders(session.authenticated ? toolbox.snapshot?.config : null),
    [session.authenticated, toolbox.snapshot?.config],
  )
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
      const notice = startupDiagnosticsIssues(report.counts)
      if (notice) noteStartupCheck(notice)
    }).catch((cause) => { if (mounted.current) noteStartupCheck(startupCheckFailure('diagnostics', errorMessage(cause, '启动环境检查没有完成'))) })
  }, [boot, native, noteStartupCheck, session.authenticated, settings?.runDiagnosticsOnStartup])
  useLayoutEffect(() => {
    if (!settings) return
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.dataset.skin = settings.uiSkin ?? 'mist'
    document.documentElement.dataset.reducedMotion = String(settings.reducedMotion === true)
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
  const supportIdentity = buildSupportIdentityLine({ signedIn: session.authenticated, account: session.account, version: update?.currentVersion, os })
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
      setOperationError({ message: errorMessage(cause, `${label}没有完成`), retry: () => void run(label, work, tool), ...(tool ? { tool } : {}) })
    }
  }, [])
  // 兼容显示提示里的二选一：两颗都写进设置，主进程据此清掉崩溃记录。「一直用」现在
  // 已经是兼容方式，不用重开；「恢复」要重开才生效，接着给一颗「现在重开」。
  const chooseDisplayCompat = useCallback((choice: 'keep' | 'restore') => perform('保存显示方式', async () => {
    setSettings(await app.savePreferences({ version: 2, hardwareAcceleration: choice === 'restore' }))
    if (choice === 'restore') noteStartupCheck(displayRelaunchNotice())
    else toast.show('以后都用兼容方式显示。想改回来，到「设置」的「外观」里打开「用显卡加速显示」。', 'ok')
  }), [app, noteStartupCheck, perform, toast])
  const navigate = useCallback((target: PageId, section?: string) => {
    if (target === 'canvas') { void perform('打开画布', app.openCanvas); return }
    if ((target === 'account' || target === 'chat') && restoring) {
      toast.show(restoreRetrying ? '暂时连不上服务，登录还在，连上后会自动恢复，不用重新登录。' : '正在恢复上次的登录，稍等一下再试。')
      return
    }
    if ((target === 'account' || target === 'chat') && !session.authenticated) { setAuth('login'); return }
    if (target === 'account') setAccountTab((current) => ({ sequence: current.sequence + 1, value: accountTabs.find((entry) => entry.value === section)?.value ?? 'overview' }))
    if (target === 'tutorial' && section) setTutorialTopic((current) => ({ sequence: (current?.sequence ?? 0) + 1, id: section }))
    if (target === 'settings') {
      const group = settingsGroups.find((entry) => entry.value === section)?.value
      if (group) requestSettingsGroup(group)
      if (hasPendingSettingsGroup()) setSettingsRequest((current) => current + 1)
    }
    if (target === 'chat') setChatScope(scope)
    if (target !== 'home' && target !== 'chat') setVisitedPages((current) => ({ ...current, [target]: scope }))
    setGuide(false); setPage(target)
  }, [app, perform, restoring, restoreRetrying, session.authenticated, scope, toast])
  // 设置页的「重看界面导览」：回到首页立刻重播一遍，同时把「还没看完」记进本机，
  // 这样中途关掉软件下次还能接着看。
  const replayTour = useCallback(() => {
    rememberTourPending(scope)
    navigate('home')
    setTourOpen(true)
  }, [navigate, scope])
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
    else setHelp(true)
  }, [navigate, operationError, perform, rewriteAccountKeys])
  // 引导里「改用」失败或没能确认能用时的出口：和错误框同一张表，只是没有「再试一次」
  //（引导自己有）。去充值、去备份页会离开引导，进度照旧留在第 3 步。
  const runGuideFailureAction = useCallback((action: OperationActionId) => {
    if (action === 'recharge') navigate('account', 'recharge')
    else if (action === 'backups') navigate('backups')
    else if (action === 'log') navigate('feedback')
    else if (action === 'network') navigate('health')
    else if (action === 'relogin') setAuth('login')
    else if (action === 'repair') void perform('重新写入 Key', () => rewriteAccountKeys())
    else setHelp(true)
  }, [navigate, perform, rewriteAccountKeys])
  async function install(id: ToolId, version?: string): Promise<ToolInstallOutcome> {
    const state = toolbox.snapshot
    if (!state) throw new Error('请先完成工具检测')
    const management = id === 'codexDesktop' ? state.platform.codexDesktop.install : state.platform.cliInstall[id]
    // 这不是一次失败：macOS 上这几个桌面端本来就要客户自己下载。以前当错误抛出来，
    // 用户会同时看到红色错误框和一个跳到教程首页、又没有对应章节的页面（第七批 3）。
    if (management === 'external') { navigate('tutorial', macDesktopTutorialTopic); toast.show('这个系统要你自己下载安装，教程里是完整步骤。', 'neutral'); return 'skipped' }
    if (offline) { toast.show(offlineActionMessage, 'warn'); return 'skipped' }
    const definition = tools.find((tool) => tool.id === id)
    const toolName = definition?.name ?? '工具'
    const plan = id === 'codexDesktop'
      ? { prepare: [], blocked: null }
      : planCliInstall({ runtime: state.system.runtime, needsPython: Boolean(definition?.requires.includes('python')), nodeInstall: platform?.nodeRuntimeInstall, pythonInstall: platform?.pythonRuntimeInstall })
    if (plan.blocked) throw new Error(plan.blocked)
    const total = plan.prepare.length + 1
    // 运行环境那一段主进程没有取消通道；这时按「取消」要说清楚，而不是回一句
    //「没有正在进行的安装」。
    let preparing = plan.prepare.length > 0
    let outcome: ToolInstallOutcome = 'installed'
    const updating = Boolean(presentTools(state).find((tool) => tool.id === id)?.status.installed)
    // 收尾必须留在同一个安装任务里。任务一结束工具行就回落到安装前的快照：
    // 同步 Key 和重新检测还没跑完，版本号已经退回旧值、「更新」按钮跟着回弹，
    // 用户看到的是「装完了又要装一次」（yoyo 2026-09-20 真机反馈①）。
    // 用户中途取消时安装那一步抛出，收尾自然不会跑：本来就没装上，不用写 Key。
    const finished = await toolbox.run(id, version ? `正在安装 ${version}` : preparing ? cliInstallStageLabel(plan.prepare[0], 0, total, toolName) : '正在安装', async (report) => {
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
      if (plan.prepare.length > 0) report(cliInstallStageLabel('tool', total - 1, total, toolName))
      try { await toolsApi.install(id, version) }
      catch (cause) {
        // 环境已经装好、工具没装上：刷新一次，下次再点只剩装工具这一段。
        if (plan.prepare.length > 0) void toolbox.refresh(true).catch(() => undefined)
        throw cause
      }
      report(installedToolSyncLabel)
      await syncAfterToolInstalled(id)
    }, { cancel: async () => preparing ? { cancelled: false, reason: '正在准备运行环境，这一步不能取消；准备好后会接着安装工具。' } : toolsApi.cancelInstall(id), notice: { updating, unfinished: () => outcome === 'restart' } })
    // run 返回 false 只有两种：用户取消了，或同一个工具已经有一次安装在跑。
    return finished ? outcome : 'skipped'
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
      throw new Error(runtimeStageFailureMessage(runtime, toolName, cause instanceof Error ? cause.message : String(cause)))
    }
  }
  async function cancelInstall(id: ToolId) {
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
    // Git 按钮只在 Windows 出现（其余平台的装法以文案给出）。以前点了是打开官网让
    // 客户自己下安装包，小白卡在这一步（yoyo 2026-09-24），现在由主进程按当前用户代装。
    if (runtime === 'git') {
      const done = await toolbox.run('git', '正在准备安装 Git', () => toolsApi.installGit(), { notice: {} })
      await toolbox.refresh(true)
      if (done && mounted.current) toast.show('Git 装好了。', 'ok')
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
  async function installExternal(id: ExternalToolId) {
    const epoch = accountEpoch.current
    try {
      const completed = await toolbox.run(id, '正在安装', () => toolsApi.installExternal(id), { notice: {} })
      if (!completed || !mounted.current || epoch !== accountEpoch.current) return
      await toolbox.refreshExternal()
      if (mounted.current && epoch === accountEpoch.current) toast.show('客户端已安装，点击“配置”选择密钥和模型。', 'ok')
    } catch (cause) { if (mounted.current && epoch === accountEpoch.current) throw cause }
  }
  async function launchExternal(id: ExternalToolId) {
    const epoch = accountEpoch.current
    try {
      await toolbox.run(`launch:${id}`, '正在打开客户端', () => toolsApi.launchExternal(id))
      if (mounted.current && epoch === accountEpoch.current) await toolbox.refreshExternal()
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
   * 'open' | 'restart',四家 CLI 认 'new' | 'resumeLast'(#292)。
   */
  async function launch(id: ToolId, mode: 'open' | 'restart' | CliLaunchMode = 'open', remembered?: string, newFolder = false): Promise<boolean> {
    const current = toolbox.snapshot
    if (!current) throw new Error('请先完成工具检测')
    const config = await toolsApi.readConfig()
    const tool = presentTools({ ...current, config }).find((entry) => entry.id === id)
    if (!tool) throw new Error('当前平台暂不支持打开这个工具')
    if (tool.error) throw new Error(tool.error)
    if (!tool.status.installed) throw new Error('工具尚未安装，请先完成准备。')
    if (!tool.configured) { openToolConfig(id); throw new Error('请先确认账号连接，再打开工具。') }
    // 核对结果和换模型的提问都只属于发起时那个账号：中途切了号，这次打开作废，免得拿上一个账号的结论去改新账号的默认模型（#538）。
    const epoch = accountEpoch.current
    const offer = modelSwapOffer(tool.name, await toolsApi.checkModels(id))
    if (!mounted.current || epoch !== accountEpoch.current) return false
    if (offer) {
      const choice = await new Promise<ModelSwapChoice>((answer) => {
        pendingModelSwap.current = answer
        setModelSwap({ offer, answer })
      })
      pendingModelSwap.current = null
      setModelSwap(null)
      if (choice === 'cancel' || !mounted.current || epoch !== accountEpoch.current) return false
      if (choice === 'swap') {
        // 空 Key + merge：只换模型，Key 和这份配置的来源都原样留着（Claude Code 的菜单随之重写）。
        try { await toolsApi.saveManual({ provider: providerFor(id), apiKey: '', model: offer.replacement, mode: 'merge' }) }
        catch (cause) { if (mounted.current) toast.show(`模型没换成，先照旧打开：${errorMessage(cause)}`, 'warn') }
      }
    }
    let workspace = config.workspace
    if (id !== 'codexDesktop') {
      // newFolder：不弹选择器，主进程在「文档」下替用户建一个空的项目文件夹。
      const selectedWorkspace = remembered ?? await toolsApi.chooseWorkspace(newFolder ? { createStarter: true } : undefined)
      if (!selectedWorkspace) return false
      workspace = selectedWorkspace
    }
    const waitLabel = launchWaitLabel(toolbox.jobs, (key) => tools.find((tool) => tool.id === key)?.name ?? clientConnections.find((client) => client.id === key)?.name)
    return toolbox.run(`launch:${id}`, waitLabel, async () => {
      const warning = launchWarning(await toolsApi.launch(id, workspace, mode))
      if (mounted.current && warning) toast.show(warning, 'warn')
    })
  }
  /**
   * The Chinese runtime patch is what makes Codex start with a local debugging
   * port, so it is off until answered (E-S3). Users upgrading from a build
   * where it was always on would lose Chinese without noticing, so the first
   * launch with no stored answer asks, and the answer is stored either way.
   */
  async function askForChineseRuntimePatch(): Promise<boolean> {
    const storedChoice = settings?.codexDesktopChineseRuntimePatch
    if (!chineseRuntimePatchAnswerMissing(platform, storedChoice)) return false
    const locale = await toolsApi.getLocale().catch(() => null)
    if (!shouldAskForChineseRuntimePatch({ platform, storedChoice, locale })) return false
    setChineseDialog(true)
    return true
  }
  async function answerChineseRuntimePatch(choice: 'enabled' | 'disabled'): Promise<void> {
    // 'enabled' goes through setCodexDesktopLocale, the one path that owns both
    // config.toml and the stored answer; only the refusal is written directly.
    if (choice === 'enabled') await toolsApi.setLocale('zh-CN')
    else await app.savePreferences({ version: 2, codexDesktopChineseRuntimePatch: 'disabled' })
    setSettings(await app.readSettings())
    setChineseDialog(false)
    await launch('codexDesktop')
  }
  function requestLaunch(id: ToolId, remembered?: string, mode: CliLaunchMode = 'new', newFolder = false) {
    if (launchRequest.current) return
    launchRequest.current = true
    void perform('打开工具', async () => {
      if (id === 'codexDesktop' && (await native.getCodexDesktopStatus()).running) setRestartDialog(true)
      else if (id === 'codexDesktop' && await askForChineseRuntimePatch()) return
      else if (remembered) await launchRemembered(id, remembered, mode)
      else await launch(id, mode, undefined, newFolder)
    }).finally(() => { launchRequest.current = false })
  }
  /**
   * 记住的目录随时可能被删掉或改名。那种情况下退回目录选择器，用户点一次
   * 「打开」仍然能走到底，而不是只收到一条错误（N7）。
   */
  async function launchRemembered(id: ToolId, remembered: string, mode: CliLaunchMode = 'new'): Promise<boolean> {
    try { return await launch(id, mode, remembered) }
    catch (cause) {
      if (!isMissingWorkspace(cause)) throw cause
      // 目录没了就没有「上次那条对话」可接,退回选择器开新的,总比只甩一条错误强。
      toast.show('上次用的目录已经找不到了，请重新选择。', 'warn')
      return launch(id)
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
      })
      await toolbox.refresh(true)
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
  useEffect(() => native.onNavigate((target) => navigate(target === 'topup' ? 'account' : target, target === 'topup' ? 'recharge' : undefined)), [native, navigate])
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
      if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) || document.querySelector('dialog[open]')) return
      if (event.key === ',') { event.preventDefault(); navigate('settings') }
      if (/^[1-5]$/.test(event.key)) {
        const tool = tools.filter((entry) => !entry.hidden?.(os))[Number(event.key) - 1]
        if (tool && isToolId(tool.id)) { event.preventDefault(); requestLaunch(tool.id) }
      }
    }
    document.addEventListener('keydown', onShortcut)
    return () => document.removeEventListener('keydown', onShortcut)
  }, [navigate, os, toolbox.snapshot, session.authenticated])
  const guideTools: GuideToolState[] = toolbox.snapshot ? presentTools(toolbox.snapshot).map((tool) => ({
    id: tool.id, installed: tool.status.installed, configured: tool.configured, source: guideSource(tool.source),
    version: tool.currentVersion ?? undefined, model: tool.model, detectionError: Boolean(tool.error),
    runtimeReady: nodeRuntimeReady(toolbox.snapshot!.system.runtime),
    pythonReady: pythonRuntimeReady(toolbox.snapshot!.system.runtime),
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
  // 出了新版本，记录随之变化，才会再提醒。
  const toolUpdateKey = updateNoticeKey(toolUpdates)
  useEffect(() => {
    // 开机先画出来的上次结果不算：那时说的「有新版本」可能早就更新过了。
    if (!toolbox.snapshot || toolbox.snapshot.system.cachedAt) return
    if (unannouncedToolUpdates(toolUpdates, readAnnouncedToolUpdates()).length > 0) {
      void platformApi()?.notifyActivity('cliUpdate', toolUpdateKey).catch(() => undefined)
    }
    rememberAnnouncedToolUpdates(toolUpdates)
    // toolUpdateKey 已经把这一轮的工具与目标版本压成一个字符串，
    // 快照里别的字段变化（余额、运行环境）不该重新触发这段。
  }, [toolUpdateKey, Boolean(toolbox.snapshot), Boolean(toolbox.snapshot?.system.cachedAt)])
  useEffect(() => {
    if (balanceAmount === null) return
    const previous = previousBalance.current
    if (previous?.scope === scope && previous.value >= 5 && balanceAmount < 5) {
      void platformApi()?.notifyActivity('balance', `balance:${session.account?.userId ?? 0}:${Date.now()}`).catch(() => undefined)
    }
    previousBalance.current = { scope, value: balanceAmount }
  }, [balanceAmount, scope, session.account?.userId])
  // 导览看完或被关掉才记成「已看」，所以上次没看完的用户一回到首页就接着播。
  // 从没有过记录的老用户不在此列：他们不会凭空多出一段导览。
  const workspaceVisible = boot === 'ready' && !guide && (session.authenticated || restoring || workspaceEntered)
  useEffect(() => {
    if (workspaceVisible && page === 'home' && tourReplayPending(scope)) setTourOpen(true)
  }, [workspaceVisible, page, scope])
  const updateKey = update ? `${update.phase}:${update.availableVersion}:${update.error?.code ?? ''}` : ''
  // 维护提示来自更新目录上的状态文件，没登录也收得到。角落那条可以关，关掉的
  // 是这一句话；发布者换了说法（比如改了预计恢复时间）会再出现一次。
  const maintenance = update?.serviceMaintenance ?? null
  const maintenanceKey = maintenanceNoticeKey(maintenance)
  const showUpdate = update && (update.error || update.currentVersionWithdrawn || ['available', 'downloading', 'downloaded'].includes(update.phase)) && dismissedUpdate !== updateKey
  // 「自动更新」勾选跟着提示气泡走：用户第一次看到「有新版本」时就能看到它、改它。
  // 这台电脑的更新通道不支持自动更新时不显示，免得勾了没用。
  const autoUpdateToggle = Boolean(update?.autoUpdateSupported && settings && !update.error && !update.rollback)
  const autoUpdateOn = autoUpdateToggle && settings?.autoUpdate !== false
  const accountBootstrapBusy = Boolean(accountBootstrap?.scope === scope && !accountBootstrap.result && !accountBootstrap.error)
  // Account switches can happen while the chat route is active. The retained
  // chat host deliberately keeps its previous scope in state, but rendering
  // must follow the newly authenticated account immediately; otherwise the
  // old-scope equality guard hides the entire page until the user navigates
  // away and back.
  const renderedChatScope = page === 'chat' ? scope : chatScope
  if (boot !== 'ready') return <Splash platform={os} phase="正在准备星芒 AI" error={bootError || undefined} progress={update?.progress?.percent} onRetry={() => setBootAttempt((value) => value + 1)} />
  return <AccountBalanceContext.Provider value={balanceStore}><OnlineStatusContext.Provider value={onlineStatus}><BalanceTierProvider value={balanceAmount === null ? 'neutral' : balanceAmount <= 0 ? 'zero' : balanceAmount < 5 ? 'bad' : balanceAmount < 20 ? 'warn' : 'ok'}>
    {guide ? <StartGuide platform={os} tools={guideTools} signedIn={session.authenticated} busy={Object.keys(toolbox.jobs).length > 0 || accountBootstrapBusy} progress={accountBootstrapBusy && accountBootstrap ? { label: accountBootstrap.label, percent: accountBootstrap.percent } : guideJobProgress(toolbox.jobs)} resumeKey={scope}
      onDetect={() => toolbox.refresh(true)} onInstall={async (id, version) => { await install(id, version) }} onInstallRuntime={() => installRuntime('node')} onInstallPython={() => installRuntime('python')} onConfigure={async (id) => { openToolConfig(id) }} onLogin={() => setAuth('login')}
      accountName={session.account?.username ?? null} onSwitchAccount={(id) => switchToolAccount(id, 'account')} onFailureAction={runGuideFailureAction}
      onLaunch={async (id, newFolder) => id === 'chat' ? true : launch(id, 'open', undefined, newFolder)}
      onComplete={(id) => { if (!writeLocalPreference(`xingmang-v2-guide:${scope}`, id)) toast.show('工具已准备好，但引导偏好没有保存在本机。', 'warn'); setWorkspaceEntered(true); rememberTourPending(scope); setTourOpen(true); navigate(id === 'chat' ? 'chat' : 'home') }} onBack={() => setGuide(false)} onHelp={() => setHelp(true)} />
      : !session.authenticated && !restoring && !workspaceEntered ? <Welcome platform={os} onLogin={() => setAuth('login')} onRegister={() => setAuth('register')} onSteps={() => setGuide(true)} onHelp={() => setHelp(true)} onLegal={setLegal}
        reducedMotion={settings?.reducedMotion} supportQrUrl={qr} onReducedMotionChange={(reducedMotion) => void perform('保存外观', async () => setSettings(await app.savePreferences({ version: 2, reducedMotion })))} />
        : <AppFrame key={scope} activePage={page} account={{ signedIn: session.authenticated, supportsBilling: accountSupports(session, 'supportsBilling'), supportsAnnouncements: session.authenticated, identity: avatarIdentity, displayName: restoreRetrying ? '暂时连不上，登录还在' : restoring ? '正在恢复登录' : session.account?.username, email: restoreRetrying ? '稍后自动重试，不用重新登录' : restoring ? '网络慢时要多等一会儿' : undefined, sourceLabel: accountSources[siteId].label, balance: balanceAmount === null ? undefined : `$${balanceAmount.toFixed(2)}`, balanceLoading: balanceState.loading, balanceUpdatedAt: balanceState.updatedAt, balanceError: balanceState.error }} platform={os}
          tourOpen={tourOpen} onTourClose={() => { rememberTourSeen(scope); setTourOpen(false) }}
          environment={toolbox.snapshot?.system.runtime.node.version ? `Node ${toolbox.snapshot.system.runtime.node.version}` : '命令行环境可选'} version={update?.currentVersion}
          unread={unread} installedCount={toolbox.snapshot ? presentTools(toolbox.snapshot).filter((tool) => tool.status.installed).length + toolbox.externalClients.filter((tool) => tool.installed).length : undefined}
          updatableCount={toolUpdates.length}
          network={latestNetworkLocation(toolbox.snapshot?.system.network, networkLocation.snapshot.network)}
          networkRefreshing={networkLocation.snapshot.busy}
          banner={session.authenticated && <AnnouncementCenter key={scope} scope={scope} read={app.announcement} refreshTick={balanceState.updatedAt} markRemoteRead={app.markAnnouncementRead} syncLocalReads={app.syncLocalNoticeReads} open={announcementOpen} onClose={() => setAnnouncementOpen(false)} onOpen={() => setAnnouncementOpen(true)} onUnread={setUnread} openExternal={app.openExternal} noticeUrl={relaySite.websiteUrl} notify={notifyAnnouncement} />}
          notification={showUpdate && <Notice tone={update.error ? 'bad' : 'accent'} title={update.error ? updateFailureLabel(update.failedStep).title : updateBubbleTitle(update)}
            body={update.error?.message ?? autoUpdateBubbleBody(update.phase, autoUpdateOn)} progress={update.progress?.percent} onDismiss={() => setDismissedUpdate(updateKey)}
            actions={<><Button size="sm" onClick={() => navigate('updates')}>查看更新</Button>
              {autoUpdateToggle && <Switch testId="update-auto-toggle" label="自动更新" checked={autoUpdateOn} onChange={(autoUpdate) => void perform('保存自动更新', async () => setSettings(await app.savePreferences({ version: 2, autoUpdate })))} />}</>} />}
          adapter={{ navigate, refreshNetwork: () => { void networkLocation.refresh() }, openAccount: () => navigate('account'), switchAccount: () => setSwitcher(true), topUp: () => navigate('account', accountSupports(session, 'supportsBilling') ? 'recharge' : 'overview'), refreshBalance: () => { void balanceStore.refresh('manual') },
            redeemAccelerationCode: async (code) => {
              if (!session.authenticated) throw new Error('请先登录星芒账号，再领取加速时长。')
              const epoch = accountEpoch.current
              const result = await acceleration.redeem(code)
              return mounted.current && accountEpoch.current === epoch ? result : null
            },
            openHealth: () => navigate('health'), openUpdates: () => navigate('updates'), openHelp: () => setHelp(true), openAnnouncements: () => setAnnouncementOpen(true), openNotifications: () => navigate('updates'),
            logout: () => setConfirmation({ title: '退出星芒账号？', body: '已写入工具的配置会保留。', label: '退出登录', work: async () => { await app.logout(); await reloadAccount() } }),
          }}>
          <div key={scope} className="v2-page-host">
            {renderedChatScope === scope && <div className="v2-chat-host" hidden={page !== 'chat'}><Suspense fallback={pageLoading}><ChatPage bridge={native} accountScope={scope} active={page === 'chat'} onOpenAccount={(tab) => navigate('account', visibleAccountTab(tab, session) ? tab : 'overview')} /></Suspense></div>}
            {visitedPages.acceleration === scope && <div data-testid="page-acceleration" hidden={page !== 'acceleration'} inert={page !== 'acceleration'}>
              <Suspense fallback={pageLoading}>
                <AccelerationPage connection={acceleration} scope={session.authenticated ? scope : null}
                  onLogin={() => setAuth('login')} onHelp={() => setAccelerationHelp(true)} onViewLog={() => navigate('feedback')} preview={accelerationPreview} />
              </Suspense>
            </div>}
            {page === 'home' ? <Home api={toolsApi} supportsUsage={accountSupports(session, 'supportsUsage')} supportsBilling={accountSupports(session, 'supportsBilling')} snapshot={toolbox.snapshot} loading={toolbox.loading} error={toolbox.error} failures={toolbox.failures} account={session.account} balance={balance} jobs={toolbox.jobs} bootstrap={accountBootstrap?.scope === scope ? accountBootstrap : null}
              externalClients={toolbox.externalClients} externalLoading={toolbox.externalLoading} externalError={toolbox.externalError} recentRevision={recentRevision}
              onScan={() => { refreshRecent(); void toolbox.refresh(true).catch(() => undefined); void toolbox.refreshExternal(true).catch(() => undefined) }} onInstall={(id, version) => void perform('安装工具', () => install(id, version), id)} onCancelInstall={(id) => void perform('取消安装', () => cancelInstall(id))} onLaunch={requestLaunch} onLaunchInNewFolder={(id) => requestLaunch(id, undefined, 'new', true)} onConfigure={openToolConfig} onUninstall={requestUninstall}
              onRewriteKey={(id) => void perform('重新写入 Key', () => rewriteAccountKeys([providerFor(id)]), id)} onKeepConfig={(id) => void perform('保留当前配置', () => keepCurrentToolConfig(id))}
              onSwitchAccount={(id, target) => void perform(target === 'account' ? '改用当前账号' : '切回官方账号', async () => { if (await switchToolAccount(id, target)) confirmToolKeyWritten(id) }, id)}
              onOpenConfigDirectory={(id) => void perform('打开配置文件夹', () => toolsApi.openConfigDirectory(id))}
              onInstallExternal={(id) => void perform('安装客户端', () => installExternal(id))} onLaunchExternal={(id) => void perform('打开客户端', () => launchExternal(id))} onOpenExternalDownload={(url) => void perform('打开下载页', () => app.openExternal(url))}
              onConfigureExternal={setExternalClient} onCodexModels={() => { setCodexModelFilter('non-gpt'); setConfigTool(platform?.codexDesktop.launch ? 'codexDesktop' : 'codex') }}
              onRuntime={(runtime) => void perform('准备环境', () => installRuntime(runtime))} onNavigate={navigate} onGuide={() => setGuide(true)} onBootstrapRetry={() => { if (session.account) void runAccountBootstrap(session.account.userId, 'login', true) }} />
              : null}
            {(Object.keys(visitedPages) as PageId[]).filter((id) => id !== 'acceleration' && (visitedPages[id] === scope || id === page)).map((id) => <div key={id === 'settings' ? `settings:${settingsRequest}` : id} hidden={page !== id} inert={page !== id}>
              <Suspense fallback={pageLoading}>
                <BusinessPage api={native} page={id} accountTab={accountTab.value} accountTabRequest={accountTab.sequence} tutorialTopic={tutorialTopic ?? undefined} paymentReturn={paymentReturn} navigate={navigate} openLogin={(target) => { setAuthTarget(target ?? null); setAuth('login') }} openHelp={() => setHelp(true)}
                  onSessionsChanged={refreshRecent}
                  onBackupRestored={() => void toolbox.refreshConfig().catch(() => undefined)}
                  onToolConfigSaved={() => void toolbox.refreshConfig().catch(() => undefined)}
                  toolConfigConfirmed={toolConfigConfirmed}
                  onAccountChanged={() => void perform('刷新账号', reloadAccount)} onSettingsChanged={setSettings} openConfig={openToolConfig}
                  openGuide={() => setGuide(true)} replayTour={replayTour}
                  onToolsChanged={(tool) => syncAfterToolInstalled(tool).catch((cause) => {
                    if (mounted.current) toast.show(errorMessage(cause, '工具已安装，但最新状态没有读到。请回到首页重新检测。'), 'warn')
                  })}
                  installTool={install} cancelToolInstall={(tool) => toolbox.cancel(tool)}
                  onRewriteKey={(provider) => rewriteAccountKeys([provider])} rewritableKeys={rewritableKeys} />
              </Suspense>
            </div>)}
          </div>
        </AppFrame>}
    {auth && <AuthFlow api={authApi} initialMode={auth} initialInviteCode={inviteCode} initialSiteId={authTarget?.siteId} initialIdentifier={authTarget?.identifier} onClose={() => { setAuth(null); setAuthTarget(null) }} onHelp={() => setHelp(true)}
      notice={maintenance ? <MaintenanceNotice maintenance={maintenance} testId="auth-maintenance-notice" /> : undefined} onAuthenticated={(result, options) => {
      const authenticatedScope = accountScope(result)
      suppressRestoredBootstrap.current.add(authenticatedScope)
      setAuth(null); setAuthTarget(null); setSession({ ...result, authenticated: true }); setGuide(!readLocalPreference(`xingmang-v2-guide:${authenticatedScope}`))
      void runAccountBootstrap(result.account.userId, 'login', true, undefined, accountSiteId(result))
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
      <p>当前适用于部分游戏、启动器和下载场景，实际连接效果以应用内表现为准。TUN 模式暂未开放。</p>
      <p>每个账号在本机累计享有 20 分钟免费体验。连接成功后才开始计时，停止后保留剩余时长，下次继续使用，不会每天重置。当前时长在本机保存，设备之间不同步。</p>
      <p>切换页面、缩到托盘或退出游戏都不会停止加速。点击“停止加速”或退出本软件才会断开；免费时长用完后自动停止。</p>
    </Dialog>}
    {help && <Dialog open title="帮助与客服" onClose={() => setHelp(false)} width={480} footer={<Button onClick={() => { setHelp(false); navigate('tutorial') }}>使用教程</Button>}>
      <div className="v2-support">{qr && <img src={qr} alt="微信客服二维码" />}<h3>微信扫码找客服</h3><p>装不上、付了没到账，都可以问。</p>
        <SupportIdentity line={supportIdentity} onCopy={() => { void navigator.clipboard.writeText(supportIdentity).then(() => toast.show('已复制，发给客服就行', 'ok'), () => toast.show('没复制上，请手动选中这行文字复制。', 'warn')) }} />
        {qrFallback && <p role="alert" data-testid="support-qr-fallback">{qrFallback}</p>}<Button onClick={() => void perform('打开帮助', () => app.openExternal(supportUrl))}>在浏览器打开</Button><Button onClick={() => { setHelp(false); navigate('feedback') }}>去反馈页</Button></div>
    </Dialog>}
    <StartupNotices notices={startupNotices} onDismiss={dismissStartupNotice}
      leading={maintenance && maintenanceKey !== dismissedMaintenance ? <MaintenanceNotice maintenance={maintenance} onDismiss={() => setDismissedMaintenance(maintenanceKey)} /> : undefined}
      onOpen={(id, action) => {
        dismissStartupNotice(id)
        if ('login' in action) setAuth('login')
        else if ('page' in action) navigate(action.page)
        else if ('displayCompat' in action) void chooseDisplayCompat(action.displayCompat)
        else if ('relaunch' in action) void perform('重开软件', async () => { await app.relaunch() })
      }} />
    {operationError && <OperationErrorDialog failure={operationError} installDirectory={toolInstallDirectory(toolbox.snapshot, operationError.tool)} onClose={() => setOperationError(null)} onAction={runOperationAction} />}
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
    {confirmation && <Confirm title={confirmation.title} body={confirmation.body} danger={confirmation.danger} okLabel={confirmation.label} loading={confirmBusy} onClose={() => setConfirmation(null)} onOk={() => {
      if (confirmationLock.current) return
      confirmationLock.current = true; setConfirmBusy(true)
      void confirmation.work().then(() => setConfirmation(null)).catch((cause) => setOperationError({ message: errorMessage(cause, '操作没有完成'), ...(confirmation.tool ? { tool: confirmation.tool } : {}) })).finally(() => { confirmationLock.current = false; setConfirmBusy(false) })
    }} />}
  </BalanceTierProvider></OnlineStatusContext.Provider></AccountBalanceContext.Provider>
}

export default function RendererV2App({ api, accelerationPreview = false }: { api?: XingmangApi; accelerationPreview?: boolean }) {
  const native = api ?? getBridge()
  if (!native) return <Splash phase="请从桌面应用打开工具箱" error="浏览器页面未连接本机服务。" />
  return <FailureBoundary native={native}><ToastProvider><RuntimeApp native={native} accelerationPreview={accelerationPreview} /></ToastProvider></FailureBoundary>
}
