import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import QRCode from 'qrcode'
import type { AccountSessionState, AppSettingsV2, ExternalDeepLink, ExternalToolId, LegalDocumentKind, PlatformCapabilities, ProviderId, UpdateSnapshot, XingmangApi } from '../../electron/ipc-contract'
import { resolveRelaySite, resolveSupportServiceUrl } from '../../electron/relay-sites'
import { Shell as AppFrame } from './features/shell/Shell'
import { createAppApi } from './features/app/api'
import { AuthFlow, LegalDocument, Splash, StartGuide, Welcome, createAuthApi, guideOfficialLoginRequired, type AuthMode, type GuideToolState } from './features/auth'
import { ConfigDialog } from './features/tools/ConfigDialog'
import { ExternalClientDialog } from './features/tools/ExternalClientDialog'
import { Home } from './features/tools/Home'
import { createToolsApi } from './features/tools/api'
import { chineseRuntimePatchAnswerMissing, shouldAskForChineseRuntimePatch } from './features/tools/chinese-runtime-choice'
import { cliRuntimeBlockMessage, nodeRuntimeReady } from './features/tools/runtime-readiness'
import { isToolId, presentTools, providerFor, type ToolId } from './features/tools/model'
import { installedToolSyncLabel, useToolbox } from './features/tools/useToolbox'
import { ManualUninstallDialog, type ManualUninstallState } from './features/tools/ManualUninstall'
import type { OperationActionId } from './operation-error'
import { accountTabs } from './registry/business'
import { tools } from './registry/tools'
import type { PageId } from './registry/pages'
import { BalanceTierProvider, Button, Confirm, Dialog, Notice, ToastProvider, useToast, useReducedMotion } from './ui'
import { bridge as getBridge } from './bridge'
import { errorMessage, pendingBusinessOperations } from './business-common'
import { SavedAccounts } from './SavedAccounts'
import { AnnouncementCenter } from './features/shell/Announcement'
import { createAccelerationApi } from './features/acceleration/api'
import { useAcceleration } from './features/acceleration/useAcceleration'
import { useNetworkLocation } from './features/shell/useNetworkLocation'
import { latestNetworkLocation } from './features/shell/network'
import { bindPlatformAppearance, platformApi } from './platform-api'
import { FailureBoundary } from './features/app/FailureBoundary'
import { OperationErrorDialog, type OperationFailure } from './features/app/OperationErrorDialog'
import { readLocalPreference, writeLocalPreference } from './features/app/preferences'
import { onboardingPreviewEnabled } from './features/app/dev-preview'
import { deepLinkReadErrorText, supportQrFallbackText } from './features/app/fallback-messages'
import { bootstrapAccountTools, type AccountBootstrapMode, type AccountBootstrapProgress, type AccountBootstrapResult } from './features/tools/account-bootstrap'
import { accountOrigin, accountScope, accountSiteId, accountSupports, siteIdForOrigin, type AccountSiteId } from './account-context'
import { formatAccountReadError } from './features/app/account-read-error'
import { AccountBalanceContext, useAccountBalanceStore } from './features/app/balance-context'
import './business.css'

const BusinessPage = lazy(() => import('./pages-business').then((module) => ({ default: module.BusinessPage })))
const ChatPage = lazy(() => import('./features/chat').then((module) => ({ default: module.ChatPage })))
const AccelerationPage = lazy(() => import('./features/acceleration/AccelerationPage').then((module) => ({ default: module.AccelerationPage })))
const pageLoading = <div className="v2-business-loading" role="status" data-testid="route-loading"><RefreshCw size={24} className="xm-spin" aria-hidden="true" /><strong>正在加载页面...</strong></div>

type AccountTab = typeof accountTabs[number]['value']
interface PendingConfirmation { title: string; body: string; label: string; danger?: boolean; work(): Promise<void> }
interface AccountBootstrapView extends AccountBootstrapProgress {
  scope: string
  result?: AccountBootstrapResult
  error?: string
}

function RuntimeApp({ native, accelerationPreview = false }: { native: XingmangApi; accelerationPreview?: boolean }) {
  useReducedMotion()
  const app = useMemo(() => createAppApi(native), [native])
  const authApi = useMemo(() => createAuthApi(native), [native])
  const toolsApi = useMemo(() => createToolsApi(native), [native])
  const toast = useToast()
  const [boot, setBoot] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [bootError, setBootError] = useState('')
  const [bootAttempt, setBootAttempt] = useState(0)
  const [settings, setSettings] = useState<AppSettingsV2 | null>(null)
  const [platform, setPlatform] = useState<PlatformCapabilities | null>(null)
  const [session, setSession] = useState<AccountSessionState>({ authenticated: false, account: null })
  const [update, setUpdate] = useState<UpdateSnapshot | null>(null)
  const [page, setPage] = useState<PageId>('home')
  const [chatScope, setChatScope] = useState<string | null>(null)
  const [visitedPages, setVisitedPages] = useState<Partial<Record<PageId, string>>>({})
  const [accountTab, setAccountTab] = useState<AccountTab>('overview')
  const [guide, setGuide] = useState(false)
  const [workspaceEntered, setWorkspaceEntered] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)
  const [auth, setAuth] = useState<AuthMode | null>(null)
  const [legal, setLegal] = useState<LegalDocumentKind | null>(null)
  const [configTool, setConfigTool] = useState<ToolId | null>(null)
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
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [restartDialog, setRestartDialog] = useState(false)
  const [chineseDialog, setChineseDialog] = useState(false)
  const [dismissedUpdate, setDismissedUpdate] = useState('')
  const [operationError, setOperationError] = useState<OperationFailure | null>(null)
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
  const [accountBootstrap, setAccountBootstrap] = useState<AccountBootstrapView | null>(null)
  const scope = accountScope(session)
  const toolbox = useToolbox(native, boot === 'ready' && (session.authenticated || guide || workspaceEntered), scope)
  const accelerationApi = useMemo(() => createAccelerationApi(native), [native])
  const acceleration = useAcceleration(accelerationApi, session.authenticated ? scope : null)
  const networkLocation = useNetworkLocation(native, acceleration.snapshot.state)
  const { store: balanceStore, snapshot: balanceState } = useAccountBalanceStore(native, session.authenticated ? scope : null)
  const balance = balanceState.balance
  useLayoutEffect(() => { accountEpoch.current++; setAccountReadError(null) }, [scope, session.authenticated])
  const siteId = accountSiteId(session)
  const relaySite = resolveRelaySite(siteId)
  const supportUrl = resolveSupportServiceUrl(session)
  const qr = supportQr?.url === supportUrl ? supportQr.data ?? undefined : undefined
  const qrFallback = supportQrFallbackText(supportQr, supportUrl)
  const avatarIdentity = session.account ? { origin: accountOrigin(session), userId: session.account.userId } : undefined
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; accountEpoch.current++ } }, [])
  useEffect(() => {
    let current = true
    setBoot('loading'); setBootError('')
    void app.bootstrap().then((result) => {
      if (!current) return
      setSettings(result.settings); setPlatform(result.platform); setSession(result.session); setUpdate(result.update)
      // 预览开关要等主进程说清这是不是打包版才生效，所以放在 bootstrap 里而不是
      // 初始 state；`boot !== 'ready'` 期间只渲染 Splash，用户看不到中间态。
      if (onboardingPreviewEnabled(window.location.search, result.update.development)) setGuide(true)
      setWorkspaceEntered(Object.values(result.config.providers).some((provider) => provider.hasApiKey || provider.codexAuthMode === 'chatgpt' || provider.authType === 'oauth-personal' || Boolean(provider.officialAccountEmail)))
      setBoot('ready')
      if (result.settings.checkUpdatesOnStartup && result.update.phase !== 'disabled') {
        void app.startupUpdate().then((checked) => { if (current) setUpdate(checked) }).catch((cause) => {
          if (current) setOperationError({ message: errorMessage(cause, '更新检查没有完成') })
        })
      }
    }).catch((cause) => {
      if (current) { setBootError(errorMessage(cause, '启动检查没有完成')); setBoot('failed') }
    })
    return () => { current = false }
  }, [app, bootAttempt])
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
    const promise = (async () => {
      try {
        const result = await bootstrapAccountTools(native, userId, updateProgress, mode, onlyProviders)
        if (!mounted.current || epoch !== bootstrapEpoch.current) return
        setAccountBootstrap((current) => current && current.scope === bootstrapScope
          ? { ...current, phase: 'verifying', label: result.failed.length ? 'Key 同步完成，部分工具待处理' : 'Key 已写入，正在刷新工具状态', percent: 100, result }
          : current)
        setWorkspaceEntered(true)
        await toolbox.refresh(true).catch(() => undefined)
      } catch (cause) {
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
  }, [native, settings, toolbox.refresh, siteId])
  useEffect(() => {
    if (boot === 'ready' && !auth && session.authenticated && session.account) {
      const restoredScope = accountScope(session)
      if (!suppressRestoredBootstrap.current.delete(restoredScope)) void runAccountBootstrap(session.account.userId, 'restore')
    }
    if (!session.authenticated) {
      bootstrapEpoch.current++
      bootstrapInFlight.current = null
      setAccountBootstrap(null)
    }
  }, [boot, runAccountBootstrap, session.account?.userId, session.authenticated, siteId, auth])
  useEffect(() => {
    if (boot !== 'ready' || !session.authenticated || !settings?.runDiagnosticsOnStartup || diagnosticsStarted.current) return
    diagnosticsStarted.current = true
    void native.runDiagnostics().then((report) => {
      if (!mounted.current) return
      const issues = report.counts.warn + report.counts.fail + report.counts.error
      if (issues) setOperationError({ message: `环境检查发现 ${issues} 项需要处理，请在“检查”页查看。` })
    }).catch((cause) => { if (mounted.current) setOperationError({ message: errorMessage(cause, '启动环境检查没有完成') }) })
  }, [boot, native, session.authenticated, settings?.runDiagnosticsOnStartup])
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
      (cause) => setOperationError({ message: errorMessage(cause, '系统外观没有同步') }))
  }, [boot, native])
  const os = platform?.platform === 'macos' ? 'mac' : platform?.platform === 'linux' ? 'linux' : 'win'
  useEffect(() => { document.documentElement.dataset.os = os }, [os])
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
    accountEpoch.current++
    bootstrapEpoch.current++
    bootstrapInFlight.current = null
    setSession(next); setAccountReadError(null); setUnread(false); setConfigTool(null); setExternalClient(null); setPaymentReturn(undefined)
    balanceStore.setScope(next.authenticated ? accountScope(next) : null)
    if (!next.authenticated) {
      setGuide(false); setPage('home'); setWorkspaceEntered(false)
      if (session.authenticated) toast.show('当前登录已结束，请重新登录。', 'warn')
    }
    else void balanceStore.refresh('foreground')
  }), [native, balanceStore, session.authenticated, toast])
  const perform = useCallback(async function run(label: string, work: () => Promise<unknown>): Promise<void> {
    setOperationError(null)
    try { await work() }
    catch (cause) {
      setOperationError({ message: errorMessage(cause, `${label}没有完成`), retry: () => void run(label, work) })
    }
  }, [])
  const navigate = useCallback((target: PageId, section?: string) => {
    if (target === 'canvas') { void perform('打开画布', app.openCanvas); return }
    if ((target === 'account' || target === 'chat') && !session.authenticated) { setAuth('login'); return }
    if (target === 'account') setAccountTab(accountTabs.find((entry) => entry.value === section)?.value ?? 'overview')
    if (target === 'chat') setChatScope(scope)
    if (target !== 'home' && target !== 'chat') setVisitedPages((current) => ({ ...current, [target]: scope }))
    setGuide(false); setPage(target)
  }, [app, perform, session.authenticated, scope])
  const runOperationAction = useCallback((action: OperationActionId) => {
    const failure = operationError
    setOperationError(null)
    if (action === 'retry') failure?.retry?.()
    else if (action === 'log') navigate('maintenance')
    else if (action === 'network') navigate('health')
    else if (action === 'recharge') navigate('account', 'recharge')
    else if (action === 'relogin') setAuth('login')
    else setHelp(true)
  }, [navigate, operationError])
  async function install(id: ToolId, version?: string) {
    const state = toolbox.snapshot
    if (!state) throw new Error('请先完成工具检测')
    const management = id === 'codexDesktop' ? state.platform.codexDesktop.install : state.platform.cliInstall[id]
    if (management === 'external') { navigate('tutorial'); throw new Error('此平台需要在应用外安装，完成后回来重新检测。') }
    const runtimeBlocked = id === 'codexDesktop' ? null : cliRuntimeBlockMessage(state.system.runtime)
    if (runtimeBlocked) throw new Error(runtimeBlocked)
    if (tools.find((tool) => tool.id === id)?.requires.includes('python') && (!state.system.runtime.python.installed || state.system.runtime.python.detectionFailed)) throw new Error('Gemini 还需要 Python 环境。请先在运行环境卡中准备 Python，再安装工具。')
    // 收尾必须留在同一个安装任务里。任务一结束工具行就回落到安装前的快照：
    // 同步 Key 和重新检测还没跑完，版本号已经退回旧值、「更新」按钮跟着回弹，
    // 用户看到的是「装完了又要装一次」（yoyo 2026-09-20 真机反馈①）。
    // 用户中途取消时安装那一步抛出，收尾自然不会跑：本来就没装上，不用写 Key。
    await toolbox.run(id, version ? `正在安装 ${version}` : '正在安装', async (report) => {
      await toolsApi.install(id, version)
      report(installedToolSyncLabel)
      await syncAfterToolInstalled(id)
    }, { cancel: () => toolsApi.cancelInstall(id) })
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
    await toolbox.refresh(true)
  }
  async function installRuntime(runtime: 'node' | 'python') {
    const mode = runtime === 'node' ? platform?.nodeRuntimeInstall : platform?.pythonRuntimeInstall
    if (mode !== 'managed') { await app.openExternal(runtime === 'node' ? 'https://nodejs.org/' : 'https://www.python.org/downloads/'); return }
    await toolbox.run(runtime, '正在准备运行环境', () => toolsApi.prepareRuntime(runtime))
    await toolbox.refresh(true)
  }
  async function installExternal(id: ExternalToolId) {
    const epoch = accountEpoch.current
    try {
      const completed = await toolbox.run(id, '正在安装', () => toolsApi.installExternal(id))
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
  async function launch(id: ToolId, mode: 'open' | 'restart' = 'open'): Promise<boolean> {
    const current = toolbox.snapshot
    if (!current) throw new Error('请先完成工具检测')
    const config = await toolsApi.readConfig()
    const tool = presentTools({ ...current, config }).find((entry) => entry.id === id)
    if (!tool) throw new Error('当前平台暂不支持打开这个工具')
    if (tool.error) throw new Error(tool.error)
    if (!tool.status.installed) throw new Error('工具尚未安装，请先完成准备。')
    if (!tool.configured) { openToolConfig(id); throw new Error('请先确认账号连接，再打开工具。') }
    let workspace = config.workspace
    if (id !== 'codexDesktop') {
      const selectedWorkspace = await toolsApi.chooseWorkspace()
      if (!selectedWorkspace) return false
      workspace = selectedWorkspace
    }
    return toolbox.run(`launch:${id}`, '正在打开工具', async () => {
      const result = await toolsApi.launch(id, workspace, mode)
      if (mounted.current && result?.chineseLocale && result.chineseLocale.status !== 'verified') {
        toast.show(result.chineseLocale.message || 'Codex 已打开，中文界面尚未确认生效，请在配置中再次启用。', 'warn')
      }
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
  function requestLaunch(id: ToolId) {
    if (launchRequest.current) return
    launchRequest.current = true
    void perform('打开工具', async () => {
      if (id === 'codexDesktop' && (await native.getCodexDesktopStatus()).running) setRestartDialog(true)
      else if (id === 'codexDesktop' && await askForChineseRuntimePatch()) return
      else await launch(id)
    }).finally(() => { launchRequest.current = false })
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
    setConfirmation({ title: `卸载 ${definition.name}？`, body: '工具配置、账户数据和历史记录会保留。', label: '卸载工具', danger: true, work: async () => {
      await toolbox.run(id, '正在卸载', async () => {
        const result = await toolsApi.uninstall(id)
        if (result.outcome === 'manual-required') {
          setManualUninstall({ name: definition.name, reason: result.manualHelp.reason, manualCommand: result.manualHelp.manualCommand })
          return
        }
        if (result.outcome !== 'uninstalled' && result.outcome !== 'not-installed') {
          throw new Error('已打开卸载窗口，完成后请重新检测。')
        }
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
    id: tool.id, installed: tool.status.installed, configured: tool.configured, source: tool.source === 'missing' ? 'none' : tool.source,
    version: tool.currentVersion ?? undefined, model: tool.model, detectionError: Boolean(tool.error),
    runtimeReady: nodeRuntimeReady(toolbox.snapshot!.system.runtime),
    pythonReady: toolbox.snapshot!.system.runtime.python.installed && !toolbox.snapshot!.system.runtime.python.detectionFailed,
    supported: tool.id !== 'codexDesktop' || platform?.codexDesktop.launch,
    officialLoginRequired: guideOfficialLoginRequired(tool.provider, tool.source === 'missing' ? 'none' : tool.source, toolbox.snapshot!.config.providers[tool.provider]),
    installMode: tool.id === 'codexDesktop' ? platform?.codexDesktop.install : platform?.cliInstall[tool.id], workspace: toolbox.snapshot!.config.workspace,
  })) : []
  const balanceAmount = balance && balance.quotaPerUnit > 0 ? balance.quota / balance.quotaPerUnit : null
  useEffect(() => {
    if (balanceAmount === null) return
    const previous = previousBalance.current
    if (previous?.scope === scope && previous.value >= 5 && balanceAmount < 5) {
      void platformApi()?.notifyActivity('balance', `balance:${session.account?.userId ?? 0}:${Date.now()}`).catch(() => undefined)
    }
    previousBalance.current = { scope, value: balanceAmount }
  }, [balanceAmount, scope, session.account?.userId])
  const updateKey = update ? `${update.phase}:${update.availableVersion}:${update.error?.code ?? ''}` : ''
  const showUpdate = update && (update.error || ['available', 'downloading', 'downloaded'].includes(update.phase)) && dismissedUpdate !== updateKey
  const accountBootstrapBusy = Boolean(accountBootstrap?.scope === scope && !accountBootstrap.result && !accountBootstrap.error)
  // Account switches can happen while the chat route is active. The retained
  // chat host deliberately keeps its previous scope in state, but rendering
  // must follow the newly authenticated account immediately; otherwise the
  // old-scope equality guard hides the entire page until the user navigates
  // away and back.
  const renderedChatScope = page === 'chat' ? scope : chatScope
  if (boot !== 'ready') return <Splash phase="正在准备星芒 AI" error={bootError || undefined} progress={update?.progress?.percent} onRetry={() => setBootAttempt((value) => value + 1)} />
  return <AccountBalanceContext.Provider value={balanceStore}><BalanceTierProvider value={balanceAmount === null ? 'neutral' : balanceAmount <= 0 ? 'zero' : balanceAmount < 5 ? 'bad' : balanceAmount < 20 ? 'warn' : 'ok'}>
    {guide ? <StartGuide platform={os} tools={guideTools} signedIn={session.authenticated} busy={Object.keys(toolbox.jobs).length > 0 || accountBootstrapBusy} progress={accountBootstrapBusy && accountBootstrap ? { label: accountBootstrap.label, percent: accountBootstrap.percent } : undefined} resumeKey={scope}
      onDetect={() => toolbox.refresh(true)} onInstall={install} onInstallRuntime={() => installRuntime('node')} onInstallPython={() => installRuntime('python')} onConfigure={async (id) => { openToolConfig(id) }} onLogin={() => setAuth('login')}
      onLaunch={async (id) => id === 'chat' ? true : launch(id)}
      onComplete={(id) => { if (!writeLocalPreference(`xingmang-v2-guide:${scope}`, id)) toast.show('工具已准备好，但引导偏好没有保存在本机。', 'warn'); setWorkspaceEntered(true); setTourOpen(true); navigate(id === 'chat' ? 'chat' : 'home') }} onBack={() => setGuide(false)} onHelp={() => setHelp(true)} />
      : !session.authenticated && !workspaceEntered ? <Welcome onLogin={() => setAuth('login')} onRegister={() => setAuth('register')} onSteps={() => setGuide(true)} onHelp={() => setHelp(true)} onLegal={setLegal}
        reducedMotion={settings?.reducedMotion} supportQrUrl={qr} onReducedMotionChange={(reducedMotion) => void perform('保存外观', async () => setSettings(await app.savePreferences({ version: 2, reducedMotion })))} />
        : <AppFrame key={scope} activePage={page} account={{ signedIn: session.authenticated, supportsBilling: accountSupports(session, 'supportsBilling'), supportsAnnouncements: session.authenticated, identity: avatarIdentity, displayName: session.account?.username, balance: balanceAmount === null ? undefined : `$${balanceAmount.toFixed(2)}`, balanceLoading: balanceState.loading, balanceUpdatedAt: balanceState.updatedAt, balanceError: balanceState.error }} platform={os}
          tourOpen={tourOpen} onTourClose={() => setTourOpen(false)}
          environment={toolbox.snapshot?.system.runtime.node.version ? `Node ${toolbox.snapshot.system.runtime.node.version}` : '命令行环境可选'} version={update?.currentVersion}
          unread={unread} installedCount={toolbox.snapshot ? presentTools(toolbox.snapshot).filter((tool) => tool.status.installed).length + toolbox.externalClients.filter((tool) => tool.installed).length : undefined}
          network={latestNetworkLocation(toolbox.snapshot?.system.network, networkLocation.snapshot.network)}
          networkRefreshing={networkLocation.snapshot.busy}
          banner={session.authenticated && <AnnouncementCenter key={scope} scope={scope} read={app.announcement} markRemoteRead={app.markAnnouncementRead} syncLocalReads={app.syncLocalNoticeReads} open={announcementOpen} onClose={() => setAnnouncementOpen(false)} onOpen={() => setAnnouncementOpen(true)} onUnread={setUnread} openExternal={app.openExternal} noticeUrl={relaySite.websiteUrl} />}
          notification={showUpdate && <Notice tone={update.error ? 'bad' : 'accent'} title={update.error ? '更新没有完成' : update.phase === 'downloaded' ? '更新已下载' : update.phase === 'downloading' ? '正在下载更新' : `新版本 ${update.availableVersion} 可以安装`}
            body={update.error?.message ?? '查看更新内容和安装状态。'} progress={update.progress?.percent} onDismiss={() => setDismissedUpdate(updateKey)} actions={<Button size="sm" onClick={() => navigate('updates')}>查看更新</Button>} />}
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
            {renderedChatScope === scope && <div className="v2-chat-host" hidden={page !== 'chat'}><Suspense fallback={pageLoading}><ChatPage bridge={native} accountScope={scope} active={page === 'chat'} /></Suspense></div>}
            {visitedPages.acceleration === scope && <div data-testid="page-acceleration" hidden={page !== 'acceleration'} inert={page !== 'acceleration'}>
              <Suspense fallback={pageLoading}>
                <AccelerationPage connection={acceleration} scope={session.authenticated ? scope : null}
                  onLogin={() => setAuth('login')} onHelp={() => setAccelerationHelp(true)} preview={accelerationPreview} />
              </Suspense>
            </div>}
            {page === 'home' ? <Home api={toolsApi} supportsUsage={accountSupports(session, 'supportsUsage')} supportsBilling={accountSupports(session, 'supportsBilling')} snapshot={toolbox.snapshot} loading={toolbox.loading} error={toolbox.error} failures={toolbox.failures} account={session.account} balance={balance} jobs={toolbox.jobs} bootstrap={accountBootstrap?.scope === scope ? accountBootstrap : null}
              externalClients={toolbox.externalClients} externalLoading={toolbox.externalLoading} externalError={toolbox.externalError}
              onScan={() => { void toolbox.refresh(true).catch(() => undefined); void toolbox.refreshExternal().catch(() => undefined) }} onInstall={(id, version) => void perform('安装工具', () => install(id, version))} onCancelInstall={(id) => void perform('取消安装', () => cancelInstall(id))} onLaunch={requestLaunch} onConfigure={openToolConfig} onUninstall={requestUninstall}
              onInstallExternal={(id) => void perform('安装客户端', () => installExternal(id))} onLaunchExternal={(id) => void perform('打开客户端', () => launchExternal(id))}
              onConfigureExternal={setExternalClient} onCodexModels={() => { setCodexModelFilter('non-gpt'); setConfigTool(platform?.codexDesktop.launch ? 'codexDesktop' : 'codex') }}
              onRuntime={(runtime) => void perform('准备环境', () => installRuntime(runtime))} onNavigate={navigate} onGuide={() => setGuide(true)} onBootstrapRetry={() => { if (session.account) void runAccountBootstrap(session.account.userId, 'login', true) }} />
              : null}
            {(Object.keys(visitedPages) as PageId[]).filter((id) => id !== 'acceleration' && (visitedPages[id] === scope || id === page)).map((id) => <div key={id} hidden={page !== id} inert={page !== id}>
              <Suspense fallback={pageLoading}>
                <BusinessPage api={native} page={id} accountTab={accountTab} paymentReturn={paymentReturn} navigate={navigate} openLogin={() => setAuth('login')} openHelp={() => setHelp(true)}
                  onAccountChanged={() => void perform('刷新账号', reloadAccount)} onSettingsChanged={setSettings} openConfig={openToolConfig}
                  onToolsChanged={(tool) => syncAfterToolInstalled(tool).catch((cause) => {
                    if (mounted.current) toast.show(errorMessage(cause, '工具已安装，但最新状态没有读到。请回到首页重新检测。'), 'warn')
                  })} />
              </Suspense>
            </div>)}
          </div>
        </AppFrame>}
    {auth && <AuthFlow api={authApi} initialMode={auth} initialInviteCode={inviteCode} onClose={() => setAuth(null)} onHelp={() => setHelp(true)} onAuthenticated={(result, options) => {
      const authenticatedScope = accountScope(result)
      suppressRestoredBootstrap.current.add(authenticatedScope)
      setAuth(null); setSession({ ...result, authenticated: true }); setGuide(!readLocalPreference(`xingmang-v2-guide:${authenticatedScope}`))
      void runAccountBootstrap(result.account.userId, 'login', true, undefined, accountSiteId(result))
      if (options?.rememberError) toast.show(options.rememberError, 'warn')
    }} />}
    {legal && <LegalDocument api={authApi} kind={legal} onClose={() => setLegal(null)} />}
    {switcher && <Dialog open title="切换账号" width={480} onClose={() => setSwitcher(false)}><SavedAccounts api={native} onAccountChanged={(result) => { bootstrapEpoch.current++; bootstrapInFlight.current = null; if (result) suppressRestoredBootstrap.current.add(accountScope({ siteId: siteIdForOrigin(result.origin) ?? undefined, account: { userId: result.userId } as AccountSessionState['account'] })); setAccountBootstrap(null); if (!result?.failed.length) setSwitcher(false); setPaymentReturn(undefined); void perform('刷新账号', reloadAccount) }} onLogin={() => { setSwitcher(false); setAuth('login') }} /></Dialog>}
    {externalClient && <ExternalClientDialog key={`${scope}:${externalClient}`} api={native} tool={externalClient} signedIn={session.authenticated} onClose={() => setExternalClient(null)} onSaved={finishExternalConfigSave} />}
    {configTool && toolbox.snapshot && <ConfigDialog key={`${scope}:${configTool}:${codexModelFilter}`} api={toolsApi} tool={configTool} config={toolbox.snapshot.config} signedIn={session.authenticated} initialModelFilter={codexModelFilter}
      onClose={() => setConfigTool(null)} onRefresh={() => toolbox.refresh(true)} onSaved={finishConfigSave} onLogin={() => setAuth('login')} onKeys={() => { setConfigTool(null); navigate('account', 'keys') }} onHelp={() => setHelp(true)} />}
    {accelerationHelp && <Dialog open title="游戏加速使用说明" onClose={() => setAccelerationHelp(false)} width={480}
      footer={<><Button variant="ghost" onClick={() => { setAccelerationHelp(false); setHelp(true) }}>帮助与客服</Button><Button onClick={() => setAccelerationHelp(false)}>知道了</Button></>}>
      <p>选择线路后点击“开始加速”，连接成功后再打开游戏或启动器。“智能分配”会自动测速并选择可用线路，也可以手动选择。</p>
      <p>当前适用于部分游戏、启动器和下载场景，实际连接效果以应用内表现为准。TUN 模式暂未开放。</p>
      <p>每个账号在本机累计享有 20 分钟免费体验。连接成功后才开始计时，停止后保留剩余时长，下次继续使用，不会每天重置。当前时长在本机保存，设备之间不同步。</p>
      <p>切换页面、缩到托盘或退出游戏都不会停止加速。点击“停止加速”或退出本软件才会断开；免费时长用完后自动停止。</p>
    </Dialog>}
    {help && <Dialog open title="帮助与客服" onClose={() => setHelp(false)} width={480} footer={<Button onClick={() => { setHelp(false); navigate('tutorial') }}>使用教程</Button>}>
      <div className="v2-support">{qr && <img src={qr} alt="微信客服二维码" />}<h3>微信扫码找客服</h3><p>装不上、付了没到账，都可以问。</p>
        {qrFallback && <p role="alert" data-testid="support-qr-fallback">{qrFallback}</p>}<Button onClick={() => void perform('打开帮助', () => app.openExternal(supportUrl))}>在浏览器打开</Button><Button onClick={() => { setHelp(false); navigate('feedback') }}>复制反馈报告</Button></div>
    </Dialog>}
    {operationError && <OperationErrorDialog failure={operationError} onClose={() => setOperationError(null)} onAction={runOperationAction} />}
    {manualUninstall && <ManualUninstallDialog state={manualUninstall} platform={platform?.platform} onClose={() => setManualUninstall(null)} />}
    {!operationError && session.authenticated && accountReadError?.scope === scope && <Dialog open title="操作没有完成" onClose={() => setAccountReadError(null)} footer={<Button onClick={() => setAccountReadError(null)}>返回</Button>}><p role="alert">{accountReadError.message}</p></Dialog>}
    {restartDialog && <Dialog open title="Codex 已在运行" onClose={() => setRestartDialog(false)} busy={Boolean(toolbox.jobs['launch:codexDesktop'])} footer={<>
      <Button variant="ghost" onClick={() => setRestartDialog(false)}>取消</Button>
      <Button onClick={() => void perform('重启 Codex', async () => { await launch('codexDesktop', 'restart'); setRestartDialog(false) })}>重启 Codex</Button>
      <Button variant="primary" onClick={() => void perform('打开 Codex', async () => { await launch('codexDesktop'); setRestartDialog(false) })}>打开窗口</Button>
    </>}><p>可以直接打开现有窗口；需要重新加载配置时，选择重启 Codex。</p></Dialog>}
    {chineseDialog && <Dialog open title="启用 Codex 中文界面？" onClose={() => setChineseDialog(false)} busy={Boolean(toolbox.jobs['launch:codexDesktop'])} footer={<>
      <Button variant="ghost" onClick={() => void perform('打开 Codex', () => answerChineseRuntimePatch('disabled'))}>保持当前语言</Button>
      <Button variant="primary" onClick={() => void perform('启用中文界面', () => answerChineseRuntimePatch('enabled'))}>启用中文界面</Button>
    </>}><p>Codex 自带中文语言包，但要让它的界面真正显示中文，星芒需要在每次打开 Codex 时附带一个仅限本机的调试端口，Codex 关闭后端口随之关闭。</p>
      <p>只问这一次。之后可以在 Codex 桌面端的配置里随时改。</p></Dialog>}
    {confirmation && <Confirm title={confirmation.title} body={confirmation.body} danger={confirmation.danger} okLabel={confirmation.label} loading={confirmBusy} onClose={() => setConfirmation(null)} onOk={() => {
      if (confirmationLock.current) return
      confirmationLock.current = true; setConfirmBusy(true)
      void confirmation.work().then(() => setConfirmation(null)).catch((cause) => setOperationError({ message: errorMessage(cause, '操作没有完成') })).finally(() => { confirmationLock.current = false; setConfirmBusy(false) })
    }} />}
  </BalanceTierProvider></AccountBalanceContext.Provider>
}

export default function RendererV2App({ api, accelerationPreview = false }: { api?: XingmangApi; accelerationPreview?: boolean }) {
  const native = api ?? getBridge()
  if (!native) return <Splash phase="请从桌面应用打开工具箱" error="浏览器页面未连接本机服务。" />
  return <FailureBoundary native={native}><ToastProvider><RuntimeApp native={native} accelerationPreview={accelerationPreview} /></ToastProvider></FailureBoundary>
}
