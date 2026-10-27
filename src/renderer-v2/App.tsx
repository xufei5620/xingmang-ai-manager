import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Download, ListChecks, MessageSquare, RotateCcw, Zap } from 'lucide-react'
import { flushSync } from 'react-dom'
import type { AccountSessionState, AccountSourceSwitchResult, AccountSourceTarget, ExternalToolId, LegalDocumentKind, XingmangApi } from '../../electron/ipc-contract'
import { resolveRelaySite } from '../../electron/relay-sites'
import { appReleaseDownloadUrl } from '../../electron/app-download-page'
import { Shell as AppFrame } from './features/shell/Shell'
import { createChatTransfer } from './features/chat/transfer'
import { OnlineStatusContext } from './features/shell/useOnlineStatus'
import { buildEnvironmentStatus, environmentJobsFinished, markDiagnosticsStale, useDiagnosticsCounts } from './features/app/environment-status'
import { createAppApi } from './features/app/api'
import { AuthFlow, LegalDocument, Splash, StartGuide, Welcome, createAuthApi, guideOfficialLoginRequired, type AuthMode, type GuideToolState, type LoginTarget } from './features/auth'
import { AuthConnectionRoutes } from './features/app/AuthConnectionRoutes'
import { ConfigDialog } from './features/tools/ConfigDialog'
import { ExternalClientDialog } from './features/tools/ExternalClientDialog'
import { OfficialQuotaDialog } from './features/tools/OfficialQuotaDialog'
import { Home, homeWalletEmpty } from './features/tools/Home'
import { rescanFingerprint } from './features/tools/rescan-change'
import { externalClientReady, visibleExternalClients } from './features/tools/external-model'
import { createToolsApi } from './features/tools/api'
import { logoutJobsNote } from './features/tools/launch-notice'
import { modelSwapConfirmLabel, modelSwapKeepLabel, modelSwapQuestion, modelSwapTitle } from './features/tools/model-check'
import { cliNeedsNodeRuntime, nodeRuntimeReady } from './features/tools/runtime-readiness'
import { foreignKeyKind, isToolId, presentTools, providerFor, spacedName, toolInstallDirectory, toolUpdateOffer, type ToolId, type ToolSource } from './features/tools/model'
import { managedSwitchConfirmation } from './features/tools/managed-switch'
import { RestartReminder, RuntimeRestartDialog } from './features/tools/RuntimeRestartDialog'
import { guideJobProgress, useToolbox } from './features/tools/useToolbox'
import { ManualUninstallDialog } from './features/tools/ManualUninstall'
import { operationFailureFrom, dollars, userFacingErrorMessage } from './business-common'
import { rewriteKeyAction, operationTargetOf } from './operation-error'
import { autoUpdateBubbleBody, settingsItemAvailable, updateBubbleTitle, updateFailureLabel, updateInstallActionLabel, updateSidebarEntry, updatesTutorialTopic, type SettingsItem } from './registry/business'
import { homeToolOrder, tools } from './registry/tools'
import { activeProviderIds } from '../../electron/catalog'
import { clientConnections } from './registry/clients'
import type { PageId } from './registry/pages'
import { BalanceTierProvider, Button, Confirm, Dialog, Notice, Switch, ToastProvider, useToast, useReducedMotion } from './ui'
import { bridge as getBridge } from './bridge'
import { useLatestRequest } from './latest-request'
import { SavedAccounts } from './SavedAccounts'
import { accountSwitchNeedsAttention } from './account-switch-sync'
import { accountSources } from './features/auth/state'
import { AnnouncementCenter } from './features/shell/Announcement'
import { createAccelerationApi } from './features/acceleration/api'
import { useAcceleration } from './features/acceleration/useAcceleration'
import { useCodexRemoteActive } from './features/settings/codex-remote/useCodexRemoteActive'
import { useNetworkLocation } from './features/shell/useNetworkLocation'
import { latestNetworkLocation } from './features/shell/network'
import { platformApi } from './platform-api'
import { FailureBoundary } from './features/app/FailureBoundary'
import { PageLoading } from './features/app/PageLoading'
import { OperationErrorDialog, type OperationFailure } from './features/app/OperationErrorDialog'
import { NodeReplaceDialog } from './features/tools/NodeReplaceDialog'
import { canReplaceNode } from './features/tools/node-replace'
import { StartupNotices } from './features/app/StartupNotices'
import { updateFailureTone, updateNeedsManualReinstall, updateOffersDownloadPage } from './features/app/update-retry'
import { RequiredUpdateGate } from './features/app/RequiredUpdateGate'
import { KnownIssueNotice, useKnownIssue } from './features/app/KnownIssueNotice'
import { MaintenanceNotice } from './features/app/MaintenanceNotice'
import { LaunchInstallNotice } from './features/app/LaunchInstallNotice'
import { readLocalPreference, writeLocalPreference } from './features/app/preferences'
import { currentWindowOs, windowOsFor } from './features/app/window-os'
import { rememberTourPending, rememberTourSeen, tourReplayPending } from './features/shell/tour-state'
import { SupportIdentity, buildSupportBundle, type SupportFailure } from './features/app/SupportIdentity'
import { accountOrigin, accountScope, accountSiteId, accountSupports, sessionRestoreRetrying, sessionRestoring, sessionScope, signedInSiteId, siteIdForOrigin, visibleAccountTab } from './account-context'
import { accountReadErrorAction } from './features/app/account-read-error'
import { AccountBalanceContext, useAccountBalanceStore, useUsableSubscription } from './features/app/balance-context'
import { subscriptionSummaryText } from '../../electron/subscription-summary'
import { keyToolInstalled } from './features/account/account-center'
import { rewritableKeyProviders } from './features/tools/connection-check'
import type { PendingConfirmation } from './features/app/runtime-context'
import { useStartupChecks, useStartupNotices } from './features/app/useStartupNotices'
import { startupNoticesShown } from './features/app/startup-notice'
import { useAppBoot } from './features/app/useAppBoot'
import { useAppOnlineStatus } from './features/app/useAppOnlineStatus'
import { useAppNavigation } from './features/app/useAppNavigation'
import { useAccountBootstrap } from './features/app/useAccountBootstrap'
import { useRelayRouteSync } from './features/app/useRelayRouteSync'
import { useAppearance } from './features/app/useAppearance'
import { useSupportContact } from './features/app/useSupportContact'
import { useBalanceWatch, useToolUpdateNotice } from './features/app/useActivityNotices'
import { useUpdateBubble } from './features/app/useUpdateBubble'
import { useDeepLinks } from './features/app/useDeepLinks'
import { useFailureActions } from './features/app/useFailureActions'
import { useAccountSessionSync } from './features/app/useAccountSessionSync'
import { useAppEntryPoints } from './features/app/useAppEntryPoints'
import { usePageRestore, useRendererActivityReport } from './features/app/useRendererRelease'
import { useBackgroundWork } from './background-work'
import { useToolAccountActions } from './features/tools/useToolAccountActions'
import { useToolLaunch } from './features/tools/useToolLaunch'
import { useToolInstall } from './features/tools/useToolInstall'
import { jobToolName } from './features/tools/tool-jobs'
import { resolveToolKeySyncFailure } from './features/tools/key-sync-failure'
import './business.css'

const BusinessPage = lazy(() => import('./pages-business').then((module) => ({ default: module.BusinessPage })))
const ChatPage = lazy(() => import('./features/chat').then((module) => ({ default: module.ChatPage })))
const AccelerationPage = lazy(() => import('./features/acceleration/AccelerationPage').then((module) => ({ default: module.AccelerationPage })))
const pageLoading = <PageLoading />

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

/**
 * 界面主组件只做两件事：把各块状态（features/app、features/tools 下的 use* hook）接到一起，
 * 再把它们摆成页面。哪一块的逻辑去对应的 hook 里找（#1070 第 8 步）。
 */
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
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  // 账号一换就换一代：换账号、重新读账号、界面卸载都作废上一代。各处操作 capture() 记下点下去时
  // 是哪一代，结果回来先问还算不算数，上一个账号的结果不落到新账号头上。
  const accountEpoch = useLatestRequest()
  const [operationError, setOperationError] = useState<OperationFailure | null>(null)
  // tool 只是把「这次失败关系到哪个工具」记下来；具体目录在渲染那一刻从当时的
  // 快照里取，装完又失败的第二次点击才不会拿到上一次的旧路径。
  // 改用账号、重新写入密钥 这几件写的是配置文件，错误框按配置文件说（已知29）。
  const perform = useCallback(async function run(label: string, work: () => Promise<unknown>, tool?: ToolId): Promise<void> {
    setOperationError(null)
    try { await work() }
    catch (cause) {
      const target = operationTargetOf(label)
      setOperationError({ ...operationFailureFrom(cause, label), action: label, retry: () => void run(label, work, tool), ...(tool ? { tool } : {}), ...(target ? { target } : {}) })
    }
  }, [])
  // 帮助框「最近一次出错」：错误框关掉以后客户才想起来找客服，那时错误已经不在屏上了。
  const [lastFailure, setLastFailure] = useState<SupportFailure | null>(null)
  const [guide, setGuide] = useState(false)
  const { startupNotices, noteStartupCheck, showRouteRestartHint, dismissStartupNotice } = useStartupNotices(native, mounted)
  const { boot, bootError, retryBoot, settings, setSettings, platform, systemLabel, session, setSession, update, setUpdate, sessionEvents, restoredBoot } = useAppBoot({ native, app, noteStartupCheck, showRouteRestartHint, setLastFailure, setGuide })
  const [workspaceEntered, setWorkspaceEntered] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)
  const [auth, setAuth] = useState<AuthMode | null>(null)
  // 登录框要预先对准的保存账号（#480）；只有「重新登录这个账号」给，关框就清。
  const [authTarget, setAuthTarget] = useState<LoginTarget | null>(null)
  const [legal, setLegal] = useState<LegalDocumentKind | null>(null)
  const [configTool, setConfigTool] = useState<ToolId | null>(null)
  const [codexModelFilter, setCodexModelFilter] = useState<'all' | 'non-gpt'>('all')
  const [externalClient, setExternalClient] = useState<ExternalToolId | null>(null)
  const openToolConfig = (tool: ToolId) => { setCodexModelFilter('all'); setConfigTool(tool) }
  const [help, setHelp] = useState(false)
  const [accelerationHelp, setAccelerationHelp] = useState(false)
  const [switcher, setSwitcher] = useState(false)
  // 配置弹窗里「查看 ChatGPT 账号额度」打开的那个（首页「…」里的那个由首页自己开）。
  const [officialQuotaOpen, setOfficialQuotaOpen] = useState(false)
  const [announcementOpen, setAnnouncementOpen] = useState(false)
  const [unread, setUnread] = useState(false)
  const [paymentReturn, setPaymentReturn] = useState<{ sequence: number; order: string | null }>()
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const confirmationLock = useRef(false)
  // 首页一键切换账号来源之后 Codex 桌面端还开着：问一次要不要替用户重开，记下切到了哪边。
  const [switchRestartOffer, setSwitchRestartOffer] = useState<AccountSourceTarget | null>(null)
  const [ccSwitchReminder, setCcSwitchReminder] = useState(false)
  const chineseDecline = useRef<HTMLButtonElement>(null)
  // 首页提示区交出来的那一格和剩下的位置：公告、活动画进去，跟首页自己的提示一起最多两条。
  const [homeNoticeSlot, setHomeNoticeSlot] = useState<HTMLElement | null>(null)
  const [homeNoticeRoom, setHomeNoticeRoom] = useState(2)
  // 首页「重新检测」点下去那一刻的工具和运行环境（rescanFingerprint）；null = 没在等这一轮检测。
  const [rescanBefore, setRescanBefore] = useState<string | null>(null)
  // 错误框里点了「换成新版 Node.js」：先问一次，确认后换完接着重做刚才失败的那一步。
  const [nodeReplace, setNodeReplace] = useState<{ retry?: () => void } | null>(null)
  const scope = sessionScope(session)
  // 装完工具同步 Key 要对的是「现在」的账号，安装闭包里那份会话还停在点安装那一刻（#1097）。
  const latestScope = useRef(scope)
  latestScope.current = scope
  // 开机账号恢复超过了启动画面的等待上限：先进首页，按正在恢复的账号显示，
  // 恢复结束再补读一次配置（见 useAccountSessionSync）。
  const restoring = sessionRestoring(session)
  const restoreRetrying = sessionRestoreRetrying(session)
  const toolboxEnabled = boot === 'ready' && (session.authenticated || restoring || guide || workspaceEntered)
  const toolbox = useToolbox(native, toolboxEnabled, scope)
  const accelerationApi = useMemo(() => createAccelerationApi(native), [native])
  // Linux 第一版不带加速（platformCapabilitiesFor 的 acceleration）：设置里的游戏加速卡、搜索、领时长都不出现，
  // 也不去读加速状态。能力回来之前按窗口的系统先判断，免得 Linux 上侧栏先闪一下「游戏加速」。
  const accelerationAvailable = platform ? platform.acceleration !== false : currentWindowOs() !== 'linux'
  const acceleration = useAcceleration(accelerationApi, session.authenticated && accelerationAvailable ? scope : null)
  const remoteActive = useCodexRemoteActive(native)
  const networkLocation = useNetworkLocation(native, acceleration.snapshot.state)
  const { store: balanceStore, snapshot: balanceState } = useAccountBalanceStore(native, session.authenticated ? scope : null)
  const balance = balanceState.balance
  // 买了订阅的客户钱包常是 0，请求扣的却是订阅：有能用的订阅时不再按钱包喊「余额不足」。
  const { subscription, refresh: refreshSubscription } = useUsableSubscription(native, session.authenticated && accountSupports(session, 'supportsSubscriptions') ? scope : null, balanceState)
  const diagnosticsCounts = useDiagnosticsCounts()
  // 工具行上装、卸、换来源这类任务一收尾，状态栏那份检查结果就说不准了（已知6）。
  const previousJobs = useRef<readonly string[]>([])
  useEffect(() => {
    const current = Object.keys(toolbox.jobs)
    if (environmentJobsFinished(previousJobs.current, current)) markDiagnosticsStale()
    previousJobs.current = current
  }, [toolbox.jobs])
  const { offline, offlineNow, onlineStatus } = useAppOnlineStatus({ native, toast, authenticated: session.authenticated, balanceStore, balanceState, mounted })
  const siteId = accountSiteId(session)
  const relaySite = resolveRelaySite(siteId)
  const avatarIdentity = session.account ? { origin: accountOrigin(session), userId: session.account.userId } : undefined
  const { accountBootstrap, accountBootstrapRef, runAccountBootstrap, rewriteAccountKeys, applySubscriptionToTools, followSessionChange, abandonAccountBootstrap, suppressRestore } = useAccountBootstrap({
    native, settings, toast, toolbox, session, scope, siteId, boot, auth, offline, noteStartupCheck, mounted, accountEpoch, setAuth, setWorkspaceEntered, restoredBoot,
  })
  const { toolConfigConfirmed, keepCurrentToolConfig, switchToolAccount, repairToolHooks, repairBrokenToolConfig, confirmToolKeyWritten, finishConfigSave } = useToolAccountActions({
    toolsApi, toolbox, toast, session, mounted, accountEpoch, configTool, setConfigTool, setAuth, setCcSwitchReminder, setSwitchRestartOffer,
  })
  // 官方账号与手填密钥重写不动（重写流程本身会跳过它们），所以按钮按当前配置的
  // 来源决定给不给，而不是见到密钥层失败就画一颗出来。
  const rewritableKeys = useMemo(
    () => rewritableKeyProviders(session.authenticated ? toolbox.snapshot?.config : null),
    [session.authenticated, toolbox.snapshot?.config],
  )
  // 扩展三页按它挑默认显示哪个工具。还没检测完时给 undefined，页面先按旧行为选 Claude。
  // 已下线的工具（Gemini）装着也不算：扩展页不再显示它。
  const installedProviders = useMemo(() => {
    const clis = toolbox.snapshot?.system.clis
    return clis ? activeProviderIds.filter((id) => clis[id].installed) : undefined
  }, [toolbox.snapshot?.system.clis])
  // 只装了 Codex 桌面端时，扩展几页照样替 Codex 管外接工具和技能（桌面端和 CLI 读同一份配置）。
  const codexDesktopInstalled = toolbox.snapshot?.system.desktopApps.codex.installed
  useRelayRouteSync({ native, app, boot, session, siteId, toolbox, setSettings, showRouteRestartHint, runAccountBootstrap, mounted })
  const { chooseDisplayCompat, chooseCrashReporting, chooseUsageStats } = useStartupChecks({ native, app, boot, settings, setSettings, authenticated: session.authenticated, noteStartupCheck, perform, toast, mounted, restoredBoot })
  // 平台能力回来之前沿用挂载前定下的系统，不能先按 Windows 写上去再改：欢迎页和
  // 启动页据此排顶栏，Mac 上那样第一帧就没给红黄绿按钮让位。
  const os = platform ? windowOsFor(platform.platform) : currentWindowOs()
  const { changeUiScale, toggleTheme } = useAppearance({ native, app, boot, settings, setSettings, os, noteStartupCheck, perform, toast })
  const { qr, qrFallback, supportInput, supportIdentity, lastFailureLine, copySupportIdentity, openSupport, feedbackSupport } = useSupportContact({
    app, session, version: update?.currentVersion, os, platform, systemLabel, operationError, lastFailure, setLastFailure, perform, toast,
  })
  // 首页「重新检测」两边都检测完、都没出错，结果和点之前一样：说一句，免得以为没点上。
  useEffect(() => {
    if (rescanBefore === null || toolbox.loading || toolbox.externalLoading) return
    setRescanBefore(null)
    if (toolbox.error || toolbox.externalError) return
    if (rescanFingerprint(toolbox.snapshot, toolbox.externalClients) === rescanBefore) toast.show('检测完了，工具和运行环境都没有变化', 'neutral')
  }, [rescanBefore, toast, toolbox.error, toolbox.externalClients, toolbox.externalError, toolbox.externalLoading, toolbox.loading, toolbox.snapshot])
  const {
    page, setPage, chatScope, setChatScope, chatParametersPending, setChatParametersPending, visitedPages, settingsGroup, setSettingsGroup,
    accountTab, shownAccountTab, setShownAccountTab, tutorialTopic, settingsRequest, healthRequest, feedbackRequest, navigate, searchTutorial, startCheck,
  } = useAppNavigation({ app, perform, toast, accelerationAvailable, restoring, restoreRetrying, authenticated: session.authenticated, scope, setAuth, setGuide })
  // 设置页的「重看界面导览」：回到首页立刻重播一遍，同时把「还没看完」记进本机，
  // 这样中途关掉软件下次还能接着看。
  const replayTour = useCallback(() => {
    rememberTourPending(scope)
    navigate('home')
    setTourOpen(true)
  }, [navigate, scope])
  const {
    modelSwap, restartDialog, setRestartDialog, chineseDialog, setChineseDialog,
    cancelPendingLaunchDialogs, prepareToolLaunch, launch, requestLaunch, requestLaunchInLastWorkspace, answerChineseRuntimePatch,
  } = useToolLaunch({ native, app, toolsApi, toolbox, toast, perform, settings, setSettings, platform, os, scope, mounted, accountEpoch, accountBootstrapRef, switchToolAccount, openToolConfig, setSwitchRestartOffer })
  const closeAccountDialogs = useCallback(() => { setConfigTool(null); setExternalClient(null) }, [])
  const leaveWorkspace = useCallback(() => { setGuide(false); setPage('home'); setWorkspaceEntered(false) }, [setPage])
  const { accountReadError, setAccountReadError, reloadAccount, logoutVoluntarily } = useAccountSessionSync({
    native, app, toolsApi, toolbox, toast, balanceStore, session, setSession, scope, restoring, sessionEvents, accountEpoch, mounted,
    cancelPendingLaunchDialogs, followSessionChange, refreshRecent, noteStartupCheck, closeAccountDialogs, leaveWorkspace, setUnread, setPaymentReturn,
  })
  const {
    installIntents, installFailures, storeNewerVersion, setStoreNewerVersion, manualUninstall, setManualUninstall, runtimeRestart, setRuntimeRestart, managedSwitch,
    install, cancelInstall, installRuntime, replaceNode, installExternal, launchExternal, switchExternalSource, finishExternalConfigSave,
    requestUninstall, requestRevert, installFromHome, cancelHomeInstall,
  } = useToolInstall({
    app, toolsApi, toolbox, toast, perform, platform, session, scope, latestScope, offline, offlineNow, mounted, accountEpoch,
    runAccountBootstrap, refreshRecent, navigate, setAuth, setConfirmation, setOperationError, setExternalClient,
  })
  const { openCodexDesktopStore, runOperationAction, runGuideFailureAction } = useFailureActions({
    app, toolsApi, toast, perform, navigate, operationError, setOperationError, rewriteAccountKeys, install, snapshot: toolbox.snapshot,
    setConfirmation, setNodeReplace, setAuth, setHelp,
  })
  // 确认过的事没做成时，错误框里的「重试」直接再做一遍，不再问一次。卸载时工具还开着，
  // 错误框说「先关掉……再重试」，以前框里却没有「重试」可点。确认框一直开在错误框后面，
  // 重试时它照样转圈，做成了一起关掉。
  function runConfirmed(pending: PendingConfirmation) {
    if (confirmationLock.current) return
    confirmationLock.current = true; setConfirmBusy(true)
    void pending.work().then(() => setConfirmation(null)).catch((cause) => setOperationError({ ...operationFailureFrom(cause), retry: () => runConfirmed(pending), ...(pending.tool ? { tool: pending.tool } : {}) })).finally(() => { confirmationLock.current = false; setConfirmBusy(false) })
  }
  const { inviteCode } = useDeepLinks({ native, mounted, boot, authenticated: session.authenticated, auth, configTool, confirmation, switcher, restartDialog, navigate, setAuth, setOperationError, setPaymentReturn })
  useAppEntryPoints({ native, navigate, session, os, settings, snapshot: toolbox.snapshot, changeUiScale, requestLaunchInLastWorkspace, setAnnouncementOpen })
  // 界面挂好了的标记，e2e/macos-visual-qa.mjs 等到它才开始量。
  useEffect(() => {
    document.documentElement.dataset.rendererReady = 'true'
    return () => { delete document.documentElement.dataset.rendererReady }
  }, [])
  const guideTools: GuideToolState[] = toolbox.snapshot ? presentTools(toolbox.snapshot).map((tool) => ({
    id: tool.id, installed: tool.status.installed, configured: tool.configured, source: guideSource(tool.source),
    version: tool.currentVersion ?? undefined, model: tool.model, detectionError: Boolean(tool.error),
    runtimeReady: nodeRuntimeReady(toolbox.snapshot!.system.runtime),
    runtimeNotNeeded: tool.id !== 'codexDesktop' && !cliNeedsNodeRuntime(toolbox.snapshot!.platform, tool.provider),
    runtimeAutoPrepare: platform?.nodeRuntimeInstall === 'managed',
    supported: tool.id !== 'codexDesktop' || platform?.codexDesktop.launch,
    officialLoginRequired: guideOfficialLoginRequired(tool.provider, guideSource(tool.source), toolbox.snapshot!.config.providers[tool.provider]),
    update: toolUpdateOffer(tool),
    installMode: tool.id === 'codexDesktop' ? platform?.codexDesktop.install : platform?.cliInstall[tool.id], workspace: toolbox.snapshot!.config.workspace,
    // 没登录就没有「当前账号」可比：来源没确认的一律按「不是当前账号的 Key」走，
    // 引导只给「登录后改用我的账号」，不因 Key 恰好在我们站上就放行（方案盘查第 1 条）。
    keyState: tool.source === 'changed' ? 'changed' : session.authenticated ? foreignKeyKind(toolbox.snapshot!.config.providers[tool.provider], tool.source) ?? undefined : tool.source === 'unknown' ? 'otherSite' : undefined,
    // 装完自动写密钥没写成：引导第 3 步说首页横幅那句、给「重新同步」，不叫客户自己去配（主路卡点 F14）。
    keySyncFailure: resolveToolKeySyncFailure(accountBootstrap?.scope === scope ? accountBootstrap : null, tool.provider, tool.id) ?? undefined,
  })) : []
  const toolUpdates = useToolUpdateNotice(toolbox.snapshot)
  const { balanceAmount, runway, accountSummary } = useBalanceWatch({ toolsApi, session, scope, balanceState, subscription })
  // 顶部搜索的「工具」组，按首页卡片的顺序；还没检测完时不列。
  const presentedTools = toolbox.snapshot ? presentTools(toolbox.snapshot) : []
  const shownClients = visibleExternalClients(os, toolbox.externalClients)
  const commandTools = toolbox.snapshot ? homeToolOrder.flatMap((id) => {
    const cli = presentedTools.find((tool) => tool.id === id)
    if (cli) return [{ id, name: tools.find((tool) => tool.id === id)?.name ?? cli.name, installed: cli.status.installed }]
    const client = shownClients.find((tool) => tool.tool === id)
    return client ? [{ id, name: clientConnections.find((tool) => tool.id === id)?.name ?? id, installed: client.installed }] : []
  }) : undefined
  // 密钥管理「配置到工具」下拉：哪些命令行工具装了、哪些现在用官方账号登录。
  const accountKeyTools = useMemo(() => {
    if (!toolbox.snapshot) return undefined
    const tools = presentTools(toolbox.snapshot)
    // Codex 桌面端和 Codex CLI 共用一份配置：只装了桌面端，「Codex CLI」那一项也能点。
    const desktop = tools.find((tool) => tool.id === 'codexDesktop')
    return tools.flatMap((tool) => tool.id === 'claude' || tool.id === 'codex' || tool.id === 'grok'
      ? [{ provider: tool.id, name: tool.name, installed: keyToolInstalled(tool.id === 'codex' && desktop ? [tool.status, desktop.status] : [tool.status]), official: tool.source === 'official' }]
      : [])
  }, [toolbox.snapshot])
  // 导览看完或被关掉才记成「已看」，所以上次没看完的用户一回到首页就接着播。
  // 从没有过记录的老用户不在此列：他们不会凭空多出一段导览。
  const workspaceVisible = boot === 'ready' && !guide && (session.authenticated || restoring || workspaceEntered)
  // 帮助弹窗下面那六格（v4 第 10 批）。跑检查、看日志要进主界面，欢迎页和引导里只给不用进主界面的那几格。
  const helpShortcuts = [
    { id: 'tutorial', label: '使用教程', icon: BookOpen, run: () => navigate('tutorial') },
    { id: 'feedback', label: '留言反馈', icon: MessageSquare, run: () => navigate('feedback', 'form') },
    ...(workspaceVisible ? [
      { id: 'health', label: '跑一遍检查', icon: Zap, run: startCheck },
      { id: 'log', label: '运行日志', icon: ListChecks, run: () => navigate('feedback', 'log') },
    ] : []),
    { id: 'download', label: '打开下载页', icon: Download, run: () => void perform('打开下载页', () => app.openExternal(appReleaseDownloadUrl)) },
    { id: 'relaunch', label: '重开软件', icon: RotateCcw, run: () => void perform('重开软件', async () => { await app.relaunch() }) },
  ]
  useEffect(() => {
    if (workspaceVisible && page === 'home' && tourReplayPending(scope)) setTourOpen(true)
  }, [workspaceVisible, page, scope])
  const { showUpdate, dismissUpdate, updateRetrying, retryUpdate, autoUpdateToggle, autoUpdateOn, updateDiskText, offerInstall, offerDownload, openInstallConfirm, downloadUpdate, maintenance, launchInstall, maintenanceDismissed, dismissMaintenance } = useUpdateBubble({
    native, update, setUpdate, settings, page, settingsGroup, perform, navigate,
  })
  // 状态文件里的已知问题提示（service-status.ts 的 knownIssues）：跟维护提示挤同一个角落，按这一页挑一条。
  const knownIssue = useKnownIssue(update, { page, accountTab: page === 'account' ? shownAccountTab : undefined })
  const accountBootstrapBusy = Boolean(accountBootstrap?.scope === scope && !accountBootstrap.result && !accountBootstrap.error)
  // 窗口缩到托盘久了主进程会关掉界面省内存（useRendererRelease.ts）：装工具、同步密钥时不关；
  // 重新加载的那一次回到原来那一页，工具检测回来了再告诉主进程准备好了（托盘「打开工具」要用它）。
  useBackgroundWork('tool-jobs', Object.keys(toolbox.jobs).length > 0)
  useBackgroundWork('account-bootstrap', accountBootstrapBusy)
  const pageRestored = usePageRestore({
    boot, restoredBoot, authenticated: session.authenticated, workspaceVisible, page,
    section: page === 'account' ? shownAccountTab : page === 'settings' ? settingsGroup ?? undefined : undefined, navigate,
  })
  const toolboxSettled = !toolboxEnabled || toolbox.snapshot !== null || toolbox.error !== ''
  useRendererActivityReport(native, boot !== 'loading' && pageRestored && toolboxSettled)
  // Account switches can happen while the chat route is active. The retained
  // chat host deliberately keeps its previous scope in state, but rendering
  // must follow the newly authenticated account immediately; otherwise the
  // old-scope equality guard hides the entire page until the user navigates
  // away and back.
  const renderedChatScope = page === 'chat' ? scope : chatScope
  // 「搬到新电脑」：导入前把聊天页同步卸下，免得它下一次自动保存把刚导入的对话又删掉。
  const chatTransfer = useMemo(() => session.authenticated
    ? createChatTransfer(native, window.localStorage, scope, () => flushSync(() => setChatScope(null)))
    : undefined, [native, scope, session.authenticated, setChatScope])
  if (boot !== 'ready') return <Splash platform={os} phase="正在准备星芒 AI" error={bootError || undefined} progress={update?.progress?.percent} onRetry={retryBoot} />
  return <AccountBalanceContext.Provider value={balanceStore}><OnlineStatusContext.Provider value={onlineStatus}><BalanceTierProvider value={subscription ? 'ok' : balanceAmount === null ? 'neutral' : balanceAmount <= 0 ? 'zero' : balanceAmount < 5 ? 'bad' : balanceAmount < 20 ? 'warn' : 'ok'}>
    {!session.authenticated && !restoring && !workspaceEntered ? <Welcome platform={os} onLogin={() => setAuth('login')} onRegister={() => setAuth('register')} onSteps={() => setGuide(true)} onHelp={() => setHelp(true)} onLegal={setLegal}
        onHistoryLogin={() => { setAuthTarget({ siteId: 'solov-api', identifier: '' }); setAuth('login') }} theme={settings?.theme} onThemeToggle={toggleTheme}
        reducedMotion={settings?.reducedMotion} supportQrUrl={qr} onReducedMotionChange={(reducedMotion) => void perform('保存外观', async () => setSettings(await app.savePreferences({ version: 2, reducedMotion })))} />
        : <AppFrame key={scope} activePage={page} account={{ signedIn: session.authenticated, supportsBilling: accountSupports(session, 'supportsBilling'), supportsAnnouncements: session.authenticated, identity: avatarIdentity, displayName: restoreRetrying ? '暂时连不上，登录还在' : restoring ? '正在恢复登录' : session.account?.username, email: restoreRetrying ? '稍后自动重试，不用重新登录' : restoring ? '网络慢时要多等一会儿' : undefined, restoring: restoreRetrying ? 'retrying' : restoring ? 'pending' : undefined, sourceTag: siteId === 'solov-api' ? accountSources[siteId].label : undefined, balance: balanceAmount === null ? undefined : dollars(balanceAmount), subscription: subscription ? `订阅：${subscriptionSummaryText(subscription, dollars)}` : undefined, balanceLoading: balanceState.loading, balanceUpdatedAt: balanceState.updatedAt, balanceError: balanceState.error,
            plan: session.authenticated && !restoring && balanceAmount !== null ? subscription ? subscription.name ?? undefined : '按量付费' : undefined, runway }} platform={os}
          accountTab={page === 'account' ? shownAccountTab : undefined} theme={settings?.theme} announcementOpen={announcementOpen}
          update={update && !update.error ? update.phase === 'downloaded' ? 'ready' : update.phase === 'available' || update.phase === 'downloading' ? 'available' : undefined : undefined}
          updateEntry={updateSidebarEntry(update)}
          accelerationLine={acceleration.snapshot.state?.phase === 'active' ? acceleration.snapshot.state.line?.name : undefined}
          remoteActive={remoteActive}
          tourOpen={tourOpen} onTourClose={() => { rememberTourSeen(scope); setTourOpen(false) }}
          environment={buildEnvironmentStatus(diagnosticsCounts, toolbox.snapshot?.system.runtime)} version={update?.currentVersion}
          unread={unread} installedCount={toolbox.snapshot ? presentTools(toolbox.snapshot).filter((tool) => tool.status.installed).length + visibleExternalClients(os, toolbox.externalClients).filter((tool) => tool.installed).length : undefined}
          updatableCount={toolUpdates.length}
          network={latestNetworkLocation(toolbox.snapshot?.system.network, networkLocation.snapshot.network)}
          networkRefreshing={networkLocation.snapshot.busy}
          banner={<>{page !== 'home' && <RestartReminder restart={toolsApi.restartWindows} />}{session.authenticated && <AnnouncementCenter key={scope} scope={scope} read={app.announcement} refreshTick={balanceState.updatedAt} markRemoteRead={app.markAnnouncementRead} syncLocalReads={app.syncLocalNoticeReads} open={announcementOpen} onClose={() => setAnnouncementOpen(false)} onOpen={() => setAnnouncementOpen(true)} onUnread={setUnread} openExternal={app.openExternal} noticeUrl={relaySite.websiteUrl} notify={notifyAnnouncement}
            promoVisible={page === 'home'} noticeSlot={page === 'home' ? homeNoticeSlot : null} noticeRoom={homeNoticeRoom} onTopUp={accountSupports(session, 'supportsBilling') ? (amount) => navigate('account', 'recharge', amount) : undefined}
            readTopupOffers={accountSupports(session, 'supportsBilling') ? () => native.getAccountTopupInfo() : undefined} />}</>}
          notification={update && showUpdate && <Notice tone={update.error ? updateFailureTone(update) : updateDiskText ? 'warn' : 'accent'} title={update.error ? updateFailureLabel(update.failedStep).title : updateBubbleTitle(update)}
            body={update.error ? userFacingErrorMessage(update.error) : updateDiskText ?? autoUpdateBubbleBody(update.phase, autoUpdateOn, update.installMethod, update.installNeedsAdminPassword, update.idleInstall)} progress={update.progress?.percent} onDismiss={dismissUpdate}
            actions={<>{update.error && !updateNeedsManualReinstall(update) && <Button size="sm" variant="primary" testId="update-bubble-retry" loading={updateRetrying} onClick={retryUpdate}>{updateFailureLabel(update.failedStep).retry}</Button>}
              {updateOffersDownloadPage(update) && <Button size="sm" variant={updateNeedsManualReinstall(update) ? 'primary' : 'secondary'} onClick={() => void perform('打开下载页', () => app.openExternal(appReleaseDownloadUrl))}>打开下载页</Button>}
              {offerInstall && <Button size="sm" variant="primary" testId="update-bubble-install" onClick={openInstallConfirm}>{updateInstallActionLabel(update.installMethod)}</Button>}
              {offerDownload && <Button size="sm" variant="primary" testId="update-bubble-download" loading={updateRetrying} onClick={downloadUpdate}>下载更新</Button>}
              {updateDiskText && <Button size="sm" onClick={() => navigate('tutorial', updatesTutorialTopic)}>怎么清理</Button>}<Button size="sm" onClick={() => navigate('updates')}>查看更新</Button>
              {autoUpdateToggle && <Switch testId="update-auto-toggle" label="自动更新" checked={autoUpdateOn} onChange={(autoUpdate) => void perform('保存自动更新', async () => setSettings(await app.savePreferences({ version: 2, autoUpdate })))} />}</>} />}
          adapter={{ navigate, searchTutorial, accountTabVisible: (tab) => !session.authenticated || visibleAccountTab(tab, session), pageVisible: (id) => id === 'video' ? signedInSiteId(session) !== 'solov-api' : id !== 'acceleration' || accelerationAvailable,
            settingsItemVisible: (item: SettingsItem) => settingsItemAvailable(item, { mac: os === 'mac', autoUpdate: Boolean(update?.autoUpdateSupported), acceleration: accelerationAvailable }), refreshNetwork: () => { void networkLocation.refresh() }, openAccount: () => navigate('account'), switchAccount: () => setSwitcher(true), topUp: () => navigate('account', accountSupports(session, 'supportsBilling') ? 'recharge' : 'overview'), refreshBalance: () => { void balanceStore.refresh('manual') },
            ...(accelerationAvailable ? { redeemAccelerationCode: async (code: string) => {
              if (!session.authenticated) throw new Error('请先登录星芒账号，再领取加速时长。')
              const epoch = accountEpoch.capture()
              const result = await acceleration.redeem(code)
              return mounted.current && epoch() ? result : null
            } } : {}),
            tools: commandTools,
            openTool: (id: string) => {
              if (isToolId(id)) { void requestLaunchInLastWorkspace(id); return }
              const client = clientConnections.find((tool) => tool.id === id)
              if (client) void perform('打开客户端', () => launchExternal(client.id))
            },
            installTool: (id: string) => {
              navigate('home')
              if (isToolId(id)) { installFromHome(id); return }
              const client = clientConnections.find((tool) => tool.id === id)
              if (client) void perform('安装客户端', () => installExternal(client.id))
            },
            configureTool: (id: string) => {
              if (isToolId(id)) { openToolConfig(id); return }
              const client = clientConnections.find((tool) => tool.id === id)
              if (client) setExternalClient(client.id)
            },
            openHealth: () => navigate('health'), openUpdates: () => navigate('updates'), installUpdate: openInstallConfirm, openHelp: () => setHelp(true), openAnnouncements: () => setAnnouncementOpen((current) => !current), openNotifications: () => navigate('updates'),
            startCheck,
            ...(toggleTheme ? { toggleTheme } : {}),
            logout: () => setConfirmation({ title: '退出登录？', body: `已配好的工具会保留。${logoutJobsNote(toolbox.jobs, jobToolName)}`, label: '退出', work: async () => { await logoutVoluntarily(); await reloadAccount() } }),
          }}>
          <div key={scope} className="v2-page-host">
            {renderedChatScope === scope && <div className="v2-chat-host" hidden={page !== 'chat'}><Suspense fallback={pageLoading}><ChatPage bridge={native} accountScope={scope} active={page === 'chat'} openParameters={chatParametersPending} onParametersOpened={() => setChatParametersPending(false)} onOpenAccount={(tab) => navigate('account', visibleAccountTab(tab, session) ? tab : 'overview')} /></Suspense></div>}
            {page === 'home' ? <Home api={toolsApi} accountScope={scope} supportsUsage={accountSupports(session, 'supportsUsage')} supportsUsageTrend={accountSupports(session, 'supportsDashboardTrends')} supportsBilling={accountSupports(session, 'supportsBilling')} snapshot={toolbox.snapshot} loading={toolbox.loading} error={toolbox.error} failures={toolbox.failures} account={session.account} accountRestoring={restoring} balance={balance} subscription={subscription} jobs={toolbox.jobs} bootstrap={accountBootstrap?.scope === scope ? accountBootstrap : null}
              externalClients={visibleExternalClients(os, toolbox.externalClients)} externalLoading={toolbox.externalLoading} externalError={toolbox.externalError} recentRevision={recentRevision}
              toolRouteStatus={session.authenticated && siteId === 'solov' ? settings?.relayToolRouteStatus : undefined}
              onScan={() => {
                setRescanBefore(rescanFingerprint(toolbox.snapshot, toolbox.externalClients))
                refreshRecent(); void toolbox.refresh(true, { recheckRoutes: true }).catch(() => undefined); void toolbox.refreshExternal(true).catch(() => undefined)
              }} onInstall={installFromHome} installIntents={installIntents} installFailures={installFailures}
              onShowInstallFailure={(id) => { const failure = installFailures[id]?.failure; if (failure) setOperationError(failure) }}
              restart={toolsApi.restartWindows} onNoticeSlot={setHomeNoticeSlot} onNoticeRoom={setHomeNoticeRoom}
              onCancelInstall={(id) => void perform('取消安装', () => cancelHomeInstall(id))} onLaunch={requestLaunch} onLaunchInNewFolder={(id, firstOpen) => requestLaunch(id, undefined, 'new', firstOpen ? 'firstOpen' : 'create')} onConfigure={openToolConfig} onUninstall={requestUninstall} onRevert={requestRevert}
              onRewriteKey={(id) => void perform(rewriteKeyAction, async () => {
                if (await rewriteAccountKeys([providerFor(id)]) && mounted.current) toast.show(`已重新写入 ${spacedName(tools.find((tool) => tool.id === id)?.name ?? '工具')}的密钥，改动前的配置已备份`, 'ok')
              }, id)} onKeepConfig={(id) => void perform('保留当前配置', () => keepCurrentToolConfig(id))}
              onSwitchAccount={(id, target) => void perform(target === 'account' ? '改用当前账号' : '切回官方账号', async () => { if (await switchToolAccount(id, target)) confirmToolKeyWritten(id) }, id)}
              onRepairHooks={(id) => void perform('修提醒设置', () => repairToolHooks(id), id)}
              onRepairConfig={(id) => void perform('重置为初始状态', async () => { if (await repairBrokenToolConfig(id)) confirmToolKeyWritten(id) }, id)}
              onOpenConfigDirectory={(id) => void perform('打开配置文件夹', () => toolsApi.openConfigDirectory(id))}
              onInstallExternal={(id) => void perform('安装客户端', () => installExternal(id))} onCancelInstallExternal={(id) => void perform('取消安装', () => cancelInstall(id))} onLaunchExternal={(id) => void perform('打开客户端', () => launchExternal(id))}
              onSwitchExternalSource={(id, target) => void perform(target === 'account' ? '改用当前账号' : '切回官方账号', () => switchExternalSource(id, target))} onOpenExternalDownload={(url) => void perform('打开下载页', () => app.openExternal(url))}
              onConfigureExternal={setExternalClient} onCodexModels={() => { setCodexModelFilter('non-gpt'); setConfigTool(platform?.codexDesktop.launch ? 'codexDesktop' : 'codex') }}
              onRuntime={(runtime) => void perform('准备环境', () => installRuntime(runtime))} onNavigate={navigate} onGuide={() => setGuide(true)} onBootstrapRetry={() => { if (session.account) void runAccountBootstrap(session.account.userId, 'login', true) }} onHelp={() => setHelp(true)} />
              : null}
            {(Object.keys(visitedPages) as PageId[]).filter((id) => visitedPages[id] === scope || id === page).map((id) => <div key={id === 'settings' ? `settings:${settingsRequest}` : id === 'health' ? `health:${healthRequest}` : id} hidden={page !== id} inert={page !== id}>
              <Suspense fallback={pageLoading}>
                <BusinessPage api={native} page={id} active={page === id} onLogout={logoutVoluntarily} logoutNote={logoutJobsNote(toolbox.jobs, jobToolName)} accountTab={accountTab.value} accountTabRequest={accountTab.sequence} onAccountTabChange={setShownAccountTab} accountRechargeAmount={accountTab.rechargeAmount} accountSession={session} accountSummary={accountSummary} accountKeyTools={accountKeyTools} tutorialTopic={tutorialTopic ?? undefined} paymentReturn={paymentReturn} navigate={navigate} openLogin={(target) => { setAuthTarget(target ?? null); setAuth('login') }} openHelp={() => setHelp(true)}
                  switchAccount={() => setSwitcher(true)} appSettings={settings ?? undefined}
                  updateAvailable={Boolean(update && !update.error && (update.phase === 'available' || update.phase === 'downloading' || update.phase === 'downloaded'))}
                  accelerating={acceleration.snapshot.state?.phase === 'active'}
                  onSettingsGroupChange={setSettingsGroup}
                  // 平台读回来之前按窗口所在系统猜：Linux 上不先挂一张加速卡再撤掉（同侧栏和顶部搜索那一份判断）。
                  accelerationCard={accelerationAvailable ? (shown) => <div data-testid="page-acceleration">
                    <Suspense fallback={null}>
                      <AccelerationPage connection={acceleration} scope={session.authenticated ? scope : null} live={shown}
                        onLogin={() => setAuth('login')} onHelp={() => setAccelerationHelp(true)} onViewLog={() => navigate('feedback', 'log')} preview={accelerationPreview}
                        onContactSupport={() => setHelp(true)} onRelaunch={() => void perform('重开软件', async () => { await app.relaunch() })} />
                    </Suspense>
                  </div> : undefined}
                  onSessionsChanged={refreshRecent}
                  beforeResume={async (provider) => Boolean(await prepareToolLaunch(provider, accountEpoch.capture()))}
                  onBackupRestored={() => { markDiagnosticsStale(); void toolbox.refreshConfig().catch(() => undefined) }}
                  onToolConfigSaved={() => { markDiagnosticsStale(); void toolbox.refreshConfig().catch(() => undefined) }}
                  toolConfigConfirmed={toolConfigConfirmed}
                  installedProviders={installedProviders}
                  codexDesktopInstalled={codexDesktopInstalled}
                  onSystemChanged={() => { markDiagnosticsStale(); refreshRecent(); void toolbox.refresh(true).catch(() => undefined) }}
                  onAccountChanged={() => void perform('刷新账号', reloadAccount)} onSettingsChanged={setSettings} uiScale={settings ? settings.uiScale ?? 'auto' : undefined} openConfig={openToolConfig}
                  openGuide={() => setGuide(true)} replayTour={replayTour} chatTransfer={chatTransfer}
                  installTool={install} cancelToolInstall={(tool) => toolbox.cancel(tool)} toolJobs={toolbox.jobs}
                  onRewriteKey={(provider) => rewriteAccountKeys([provider])} rewritableKeys={rewritableKeys}
                  onInstallRuntime={(runtime) => void perform('准备环境', () => installRuntime(runtime))} onReplaceNode={() => setNodeReplace({})}
                  support={feedbackSupport} feedbackRequest={feedbackRequest} ordersVisible={!session.authenticated || visibleAccountTab('orders', session)}
                  onSubscriptionActivated={applySubscriptionToTools} onSubscriptionPurchased={() => void refreshSubscription()} />
              </Suspense>
            </div>)}
          </div>
        </AppFrame>}
    {/* v4：新手引导是叠在欢迎页或主界面上面的弹窗，不再整页换掉它们。 */}
    {guide && <StartGuide platform={os} tools={guideTools} signedIn={session.authenticated} busy={Object.keys(toolbox.jobs).length > 0 || accountBootstrapBusy} progress={accountBootstrapBusy && accountBootstrap ? { label: accountBootstrap.label, percent: accountBootstrap.percent } : guideJobProgress(toolbox.jobs)} resumeKey={scope}
      onDetect={() => toolbox.refresh(true)} onInstall={async (id, version) => { await install(id, version) }} onInstallRuntime={() => installRuntime('node')} onConfigure={async (id) => { openToolConfig(id) }} onLogin={() => setAuth('login')}
      accountName={session.account?.username ?? null} onSwitchAccount={(id) => switchToolAccount(id, 'account')}
      onBootstrapRetry={async (id) => {
        // 跟装完以后那一轮一样，只给这一个工具写（useToolInstall），不顺手改别的工具。
        if (!session.account) return false
        const provider = providerFor(id)
        const outcome = await runAccountBootstrap(session.account.userId, 'login', true, [provider])
        return Boolean(outcome?.result?.configured.includes(provider))
      }} onFailureAction={runGuideFailureAction} support={supportInput} onFailure={setLastFailure} canReplaceNode={canReplaceNode({ platform: platform?.platform, nodeRuntimeInstall: platform?.nodeRuntimeInstall })}
      walletEmpty={session.authenticated && homeWalletEmpty(balanceAmount, subscription, accountSupports(session, 'supportsBilling'))}
      onLaunch={async (id, newFolder) => id === 'chat' ? true : launch(id, 'open', undefined, newFolder ? 'create' : 'choose')}
      onComplete={(id, landing) => { if (!writeLocalPreference(`xingmang-v2-guide:${scope}`, id)) toast.show('工具已准备好，但引导偏好没有保存在本机。', 'warn'); setWorkspaceEntered(true); rememberTourPending(scope); setTourOpen(true); navigate(landing) }} onBack={() => setGuide(false)} onHelp={() => setHelp(true)} onRegister={() => setAuth('register')} />}
    {auth && <AuthFlow api={authApi} initialMode={auth} initialInviteCode={inviteCode} initialSiteId={authTarget?.siteId} initialIdentifier={authTarget?.identifier} sessionOnly={session.sessionOnly === true} onClose={() => { setAuth(null); setAuthTarget(null) }} onHelp={() => setHelp(true)}
      onRelaunch={() => void perform('重开软件', async () => { await app.relaunch() })}
      connectionSettings={settings ? (onBusyChange) => <AuthConnectionRoutes api={app} settings={settings} onSettingsChanged={setSettings} onBusyChange={onBusyChange} /> : undefined}
      notice={maintenance ? <MaintenanceNotice maintenance={maintenance} testId="auth-maintenance-notice" /> : undefined} onAuthenticated={(result, options) => {
      const authenticatedScope = accountScope(result)
      suppressRestore(authenticatedScope)
      setAuth(null); setAuthTarget(null); setSession({ ...result, authenticated: true }); setGuide(!readLocalPreference(`xingmang-v2-guide:${authenticatedScope}`))
      void runAccountBootstrap(result.account.userId, 'login', true, undefined, accountSiteId(result))
      if (options?.notice) toast.show(options.notice, 'ok')
      if (options?.rememberError) toast.show(options.rememberError, 'warn')
    }} />}
    {legal && <LegalDocument api={authApi} kind={legal} onClose={() => setLegal(null)} />}
    {switcher && <Dialog open title="切换账号" width={480} onClose={() => setSwitcher(false)} footer={<Button onClick={() => setSwitcher(false)} testId="account-switcher-done">完成</Button>}><SavedAccounts api={native} onAccountChanged={(result) => { abandonAccountBootstrap(); if (result) suppressRestore(accountScope({ siteId: siteIdForOrigin(result.origin) ?? undefined, account: { userId: result.userId } as AccountSessionState['account'] })); if (!result || !accountSwitchNeedsAttention(result)) setSwitcher(false); setPaymentReturn(undefined); void perform('刷新账号', reloadAccount) }} onLogin={(target) => { setSwitcher(false); setAuthTarget(target ?? null); setAuth('login') }} /></Dialog>}
    {externalClient && <ExternalClientDialog key={`${scope}:${externalClient}`} api={native} tool={externalClient} signedIn={session.authenticated} strictKeyFormat={siteId === 'solov'}
      liveConfig={toolbox.failures.some((failure) => failure.partition === 'config') ? null : toolbox.snapshot?.config ?? null}
      ready={externalClientReady(toolbox.externalClients, externalClient)} version={toolbox.externalClients.find((client) => client.tool === externalClient)?.version ?? null} onClose={() => setExternalClient(null)} onSaved={finishExternalConfigSave} />}
    {configTool && toolbox.snapshot && <ConfigDialog key={`${scope}:${configTool}:${codexModelFilter}`} api={toolsApi} tool={configTool} config={toolbox.snapshot.config} signedIn={session.authenticated} initialModelFilter={codexModelFilter}
      strictKeyFormat={siteId === 'solov'} onOfficialQuota={() => setOfficialQuotaOpen(true)} onBackups={() => navigate('backups')}
      onClose={() => setConfigTool(null)} onRefresh={() => toolbox.refresh(true)} onSaved={finishConfigSave} onKeyWritten={confirmToolKeyWritten} onLogin={() => setAuth('login')} onKeys={() => { setConfigTool(null); navigate('account', 'keys') }} onHelp={() => setHelp(true)}
      accountName={session.account?.username ?? null}
      onSwitchAccount={async (id) => {
        const switched: { result: AccountSourceSwitchResult | null } = { result: null }
        await perform('改用当前账号', async () => { switched.result = await switchToolAccount(id, 'account') }, id)
        return switched.result
      }} />}
    {officialQuotaOpen && <OfficialQuotaDialog email={toolbox.snapshot?.config.providers.codex.officialAccountEmail ?? null} initial={toolbox.snapshot?.system.officialChatGpt ?? null}
      refresh={() => toolsApi.officialUsage()} onClose={() => setOfficialQuotaOpen(false)} />}
    {accelerationHelp && <Dialog open title="网络加速使用说明" onClose={() => setAccelerationHelp(false)} width={480}
      footer={<><Button variant="ghost" onClick={() => { setAccelerationHelp(false); setHelp(true) }}>帮助与客服</Button><Button onClick={() => setAccelerationHelp(false)}>知道了</Button></>}>
      <p>选择线路后点击“开启加速”，连接成功后再打开 ChatGPT 网页或 Codex。“自动选择”会自动测速并选择可用线路，也可以手动选择。</p>
      <p>只有 ChatGPT、Codex 这些 OpenAI 的服务走这条线路，别的网站和下载照常直连。加速只改这台电脑的系统代理，不接管整台电脑的网络。开着别的 VPN 时可能连不上，建议先关掉。</p>
      <p>每个账号在本机累计享有 20 分钟免费体验。连接成功后才开始计时，停止后保留剩余时长，下次继续使用，不会每天重置。当前时长在本机保存，设备之间不同步。</p>
      <p>切换页面、缩到托盘或关掉浏览器都不会停止加速。点击“停止加速”或退出本软件才会断开；免费时长用完后自动停止。</p>
    </Dialog>}
    {help && <Dialog open title="帮助与客服" onClose={() => setHelp(false)} width={640} testId="support-dialog">
      {/* 左边扫码、右边复制身份，常去的几处排成下面的六格（v4 第 10 批，代替原来那排按钮和「设置里还有」「左边「更多」里还有」）。 */}
      <div className="v2-support"><div className="v2-support-contact">{qr && <img src={qr} alt="微信客服二维码" />}<h3>微信扫码找客服</h3><p>装不上、付了没到账，都可以问。</p>
        {qrFallback && <p role="alert" data-testid="support-qr-fallback">{qrFallback}</p>}
        <Button size="sm" onClick={openSupport}>在浏览器打开</Button></div>
        <SupportIdentity line={supportIdentity} lastFailure={lastFailureLine} onCopy={copySupportIdentity} /></div>
      <div className="v2-support-grid" data-testid="support-more">
        {helpShortcuts.map((item) => <button key={item.id} type="button" className="v2-support-item" onClick={() => { setHelp(false); item.run() }} data-testid={`support-more-${item.id}`}><item.icon size={16} aria-hidden="true" /><span>{item.label}</span></button>)}
      </div>
    </Dialog>}
    <RequiredUpdateGate update={update} windows={os === 'win'} linux={os === 'linux'} actions={{
      check: () => native.checkForUpdates(), download: (options) => native.downloadUpdate(options), install: () => native.installUpdate(),
      openDownloadPage: () => void perform('打开下载页', () => app.openExternal(appReleaseDownloadUrl)), contactSupport: () => setHelp(true),
    }} />
    {/* 引导、导览开着时，登录后说一次的告知卡先等着（主路卡点 F11）。导览只在首页放，开在别的页上客户看不见它，
        那时不用等，否则一直待在聊天页的客户就一直看不到告知。 */}
    <StartupNotices notices={startupNoticesShown(startupNotices, guide || (tourOpen && page === 'home'))} onDismiss={dismissStartupNotice}
      leading={[
        ...(launchInstall ? [<LaunchInstallNotice key={`launch-install-${launchInstall.installAt}`} notice={launchInstall} />] : []),
        ...(maintenance && !maintenanceDismissed ? [<MaintenanceNotice key="maintenance" maintenance={maintenance} onDismiss={dismissMaintenance} />] : []),
        ...(knownIssue.issue ? [<KnownIssueNotice key="known-issue" issue={knownIssue.issue} onDismiss={knownIssue.dismiss}
          onAction={(action) => { if (action === 'update') navigate('updates'); else setHelp(true) }} />] : []),
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
        else if ('usageStats' in action) void chooseUsageStats(action.usageStats)
        else if ('relaunch' in action) void perform('重开软件', async () => { await app.relaunch() })
        else if ('restartCodexDesktop' in action) void perform('重开 Codex 桌面端', async () => { await launch('codexDesktop', 'restart') })
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
    {manualUninstall && <ManualUninstallDialog state={manualUninstall} platform={platform?.platform} onClose={() => setManualUninstall(null)} cleanUp={(tool) => toolsApi.cleanUninstallLeftovers(tool)} />}
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
        两个按钮同等样式，键盘焦点落在「先不用」：随手一按回车不会开端口，想要中文的人点一下就行。
        Codex 的中文开关每次启动时才拿，只有星芒打开的那一下连了加速、开了通道，开机后直接点 Codex 自己的图标还是英文，
        所以第一段末尾先说清，免得客户以为汉化掉了。 */}
    {chineseDialog && <Dialog open title="要让 Codex 的界面显示中文吗？" onClose={() => setChineseDialog(false)} busy={Boolean(toolbox.jobs['launch:codexDesktop'])} initialFocus={chineseDecline} footer={<>
      <Button ref={chineseDecline} testId="codex-chinese-decline" onClick={() => void perform('打开 Codex', () => answerChineseRuntimePatch('disabled'))}>先不用</Button>
      <Button testId="codex-chinese-enable" onClick={() => void perform('启用中文界面', () => answerChineseRuntimePatch('enabled'))}>显示中文</Button>
    </>}><p>选「显示中文」后，星芒每次打开 Codex 时会顺带开一个本机通道，用来把界面换成中文；关掉 Codex，通道也跟着关上。通道开着时，这台电脑上的其他程序和其他账户也能连上它、控制 Codex；和别人共用这台电脑的，建议选「先不用」。中文只在从星芒打开时生效，直接点 Codex 自己的图标打开还是英文。</p>
      <p>不用也没关系，Codex 照样能用，只是界面是英文。只问这一次，以后想改，随时可以在 Codex 桌面端的配置里打开或关掉。</p></Dialog>}
    {/* 默认模型换不换由用户点，不替付费客户自动换（第十二批候选 5、第十五批 6）；关掉对话框 = 这次先不打开。 */}
    {modelSwap && <Dialog open title={modelSwapTitle(modelSwap.offer)} onClose={() => modelSwap.answer('cancel')} footer={<>
      <Button testId="model-swap-keep" onClick={() => modelSwap.answer('keep')}>{modelSwapKeepLabel(modelSwap.offer)}</Button>
      <Button variant="primary" testId="model-swap-confirm" onClick={() => modelSwap.answer('swap')}>{modelSwapConfirmLabel(modelSwap.offer)}</Button>
    </>}><p data-testid="model-swap-question">{modelSwapQuestion(modelSwap.offer)}</p></Dialog>}
    {runtimeRestart && <RuntimeRestartDialog onClose={() => setRuntimeRestart(false)} restart={toolsApi.restartWindows} />}
    {/* 点「取消」或关掉框都是不换：install 收到 false，什么都不动。 */}
    {managedSwitch && <Confirm {...managedSwitchConfirmation(managedSwitch.version)} testId="managed-switch-confirm" onOk={() => managedSwitch.answer(true)} onClose={() => managedSwitch.answer(false)} />}
    {confirmation && <Confirm title={confirmation.title} body={confirmation.body} danger={confirmation.danger} okLabel={confirmation.label} loading={confirmBusy} onClose={() => setConfirmation(null)} onOk={() => runConfirmed(confirmation)} />}
  </BalanceTierProvider></OnlineStatusContext.Provider></AccountBalanceContext.Provider>
}

export default function RendererV2App({ api, accelerationPreview = false }: { api?: XingmangApi; accelerationPreview?: boolean }) {
  const native = api ?? getBridge()
  if (!native) return <Splash phase="请从桌面应用打开工具箱" error="浏览器页面未连接本机服务。" />
  return <FailureBoundary native={native}><ToastProvider><RuntimeApp native={native} accelerationPreview={accelerationPreview} /></ToastProvider></FailureBoundary>
}
