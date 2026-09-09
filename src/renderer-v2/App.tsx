import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { AccountBalance, AccountSessionState, AppSettingsV2, ExternalDeepLink, LegalDocumentKind, PlatformCapabilities, ProviderId, UpdateSnapshot, XingmangApi } from '../../electron/ipc-contract'
import { resolveRelaySite, supportServiceUrl } from '../../electron/relay-sites'
import { Shell as AppFrame } from './features/shell/Shell'
import { createAppApi } from './features/app/api'
import { AuthFlow, LegalDocument, Splash, StartGuide, Welcome, createAuthApi, type AuthMode, type GuideToolState } from './features/auth'
import { ConfigDialog } from './features/tools/ConfigDialog'
import { Home } from './features/tools/Home'
import { createToolsApi } from './features/tools/api'
import { isToolId, presentTools, providerFor, type ToolId } from './features/tools/model'
import { useToolbox } from './features/tools/useToolbox'
import { BusinessPage } from './pages-business'
import { accountTabs } from './registry/business'
import { tools } from './registry/tools'
import type { PageId } from './registry/pages'
import { BalanceTierProvider, Button, Confirm, Dialog, Notice, ToastProvider, useToast, useReducedMotion } from './ui'
import { bridge as getBridge } from './bridge'
import { pendingBusinessOperations } from './business-common'
import { SavedAccounts } from './SavedAccounts'
import { AnnouncementCenter } from './features/shell/Announcement'
import { ChatPage } from './features/chat'
import { bindPlatformAppearance, platformApi } from './platform-api'
import { FailureBoundary } from './features/app/FailureBoundary'
import { readLocalPreference, writeLocalPreference } from './features/app/preferences'
import { bootstrapAccountTools, type AccountBootstrapMode, type AccountBootstrapProgress, type AccountBootstrapResult } from './features/tools/account-bootstrap'
import { accountOrigin, accountScope, accountSiteId, accountSupports, type AccountSiteId } from './account-context'

type AccountTab = typeof accountTabs[number]['value']
interface PendingConfirmation { title: string; body: string; label: string; danger?: boolean; work(): Promise<void> }
interface AccountBootstrapView extends AccountBootstrapProgress {
  scope: string
  result?: AccountBootstrapResult
  error?: string
}

function RuntimeApp({ native }: { native: XingmangApi }) {
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
  const [balance, setBalance] = useState<AccountBalance | null>(null)
  const [update, setUpdate] = useState<UpdateSnapshot | null>(null)
  const [page, setPage] = useState<PageId>('home')
  const [chatScope, setChatScope] = useState<string | null>(null)
  const [visitedPages, setVisitedPages] = useState<Partial<Record<PageId, string>>>({})
  const [accountTab, setAccountTab] = useState<AccountTab>('overview')
  const [guide, setGuide] = useState(() => new URLSearchParams(window.location.search).get('onboardingPreview') === '1')
  const [workspaceEntered, setWorkspaceEntered] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)
  const [auth, setAuth] = useState<AuthMode | null>(null)
  const [legal, setLegal] = useState<LegalDocumentKind | null>(null)
  const [configTool, setConfigTool] = useState<ToolId | null>(null)
  const [help, setHelp] = useState(false)
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
  const [dismissedUpdate, setDismissedUpdate] = useState('')
  const [operationError, setOperationError] = useState('')
  const [qr, setQr] = useState<string>()
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
  const toolbox = useToolbox(native, boot === 'ready' && (session.authenticated || guide || workspaceEntered))
  const scope = accountScope(session)
  const siteId = accountSiteId(session)
  const relaySite = resolveRelaySite(siteId)
  const avatarIdentity = session.account ? { origin: accountOrigin(session), userId: session.account.userId } : undefined
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; accountEpoch.current++ } }, [])
  useEffect(() => {
    let current = true
    setBoot('loading'); setBootError('')
    void app.bootstrap().then((result) => {
      if (!current) return
      setSettings(result.settings); setPlatform(result.platform); setSession(result.session); setUpdate(result.update)
      setWorkspaceEntered(Object.values(result.config.providers).some((provider) => provider.hasApiKey || provider.codexAuthMode === 'chatgpt' || provider.authType === 'oauth-personal' || Boolean(provider.officialAccountEmail)))
      setBoot('ready')
      if (result.settings.checkUpdatesOnStartup && result.update.phase !== 'disabled') {
        void app.startupUpdate().then((checked) => { if (current) setUpdate(checked) }).catch((cause) => {
          if (current) setOperationError(cause instanceof Error ? cause.message : '更新检查没有完成')
        })
      }
    }).catch((cause) => {
      if (current) { setBootError(cause instanceof Error ? cause.message : '启动检查没有完成'); setBoot('failed') }
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
          error: cause instanceof Error ? cause.message : '账号 Key 初始化没有完成',
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
      if (issues) setOperationError(`环境检查发现 ${issues} 项需要处理，请在“检查”页查看。`)
    }).catch((cause) => { if (mounted.current) setOperationError(cause instanceof Error ? cause.message : '启动环境检查没有完成') })
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
      (cause) => setOperationError(cause instanceof Error ? cause.message : '系统外观没有同步'))
  }, [boot, native])
  const os = platform?.platform === 'macos' ? 'mac' : platform?.platform === 'linux' ? 'linux' : 'win'
  useEffect(() => { document.documentElement.dataset.os = os }, [os])
  useEffect(() => {
    let current = true
    void QRCode.toDataURL(supportServiceUrl, { width: 192, margin: 1, errorCorrectionLevel: 'M' }).then((value) => { if (current) setQr(value) }).catch(() => undefined)
    return () => { current = false }
  }, [])
  useEffect(() => {
    const id = ++accountEpoch.current
    setBalance(null)
    if (!session.authenticated) return
    void app.balance().then((value) => { if (mounted.current && id === accountEpoch.current) setBalance(value) }).catch((cause) => {
      if (mounted.current && id === accountEpoch.current) setOperationError(cause instanceof Error ? cause.message : '余额暂时没有读到')
    })
  }, [app, session.authenticated, scope])
  const reloadAccount = useCallback(async () => {
    const id = ++accountEpoch.current
    const next = await app.session()
    if (!mounted.current || id !== accountEpoch.current) return
    setSession(next); setConfigTool(null)
    if (next.authenticated) {
      try { const value = await app.balance(); if (id === accountEpoch.current) setBalance(value) }
      catch { if (id === accountEpoch.current) setBalance(null) }
    } else { setBalance(null); setGuide(false); setPage('home'); setWorkspaceEntered(false) }
  }, [app])
  useEffect(() => native.onAccountSessionChanged?.((next) => {
    const id = ++accountEpoch.current
    bootstrapEpoch.current++
    bootstrapInFlight.current = null
    setSession(next); setBalance(null); setUnread(false); setConfigTool(null); setPaymentReturn(undefined)
    if (!next.authenticated) {
      setGuide(false); setPage('home'); setWorkspaceEntered(false)
      if (session.authenticated) toast.show('当前登录已结束，请重新登录。', 'warn')
    }
    else void app.balance().then((value) => {
      if (mounted.current && id === accountEpoch.current) setBalance(value)
    }).catch(() => undefined)
  }), [native, app, session.authenticated, toast])
  const perform = useCallback(async (label: string, work: () => Promise<unknown>) => {
    setOperationError('')
    try { await work() }
    catch (cause) { setOperationError(cause instanceof Error ? cause.message : `${label}没有完成`) }
  }, [])
  const navigate = useCallback((target: PageId, section?: string) => {
    if (target === 'canvas') { void perform('打开画布', app.openCanvas); return }
    if ((target === 'account' || target === 'chat') && !session.authenticated) { setAuth('login'); return }
    if (target === 'account') setAccountTab(accountTabs.find((entry) => entry.value === section)?.value ?? 'overview')
    if (target === 'chat') setChatScope(scope)
    if (target !== 'home' && target !== 'chat') setVisitedPages((current) => ({ ...current, [target]: scope }))
    setGuide(false); setPage(target)
  }, [app, perform, session.authenticated, scope])
  async function install(id: ToolId) {
    const state = toolbox.snapshot
    if (!state) throw new Error('请先完成工具检测')
    const management = id === 'codexDesktop' ? state.platform.codexDesktop.install : state.platform.cliInstall[id]
    if (management === 'external') { navigate('tutorial'); throw new Error('此平台需要在应用外安装，完成后回来重新检测。') }
    if (id !== 'codexDesktop' && (!state.system.runtime.node.installed || state.system.runtime.node.tooOld || !state.system.runtime.npm.installed)) throw new Error('请先准备 Node.js 运行环境，再安装命令行工具。')
    if (tools.find((tool) => tool.id === id)?.requires.includes('python') && (!state.system.runtime.python.installed || state.system.runtime.python.detectionFailed)) throw new Error('Gemini 还需要 Python 环境。请先在运行环境卡中准备 Python，再安装工具。')
    await toolbox.run(id, '正在安装', () => toolsApi.install(id))
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
  async function launch(id: ToolId, mode: 'open' | 'restart' = 'open'): Promise<boolean> {
    const current = toolbox.snapshot
    if (!current) throw new Error('请先完成工具检测')
    const config = await toolsApi.readConfig()
    const tool = presentTools({ ...current, config }).find((entry) => entry.id === id)
    if (!tool) throw new Error('当前平台暂不支持打开这个工具')
    if (tool.error) throw new Error(tool.error)
    if (!tool.status.installed) throw new Error('工具尚未安装，请先完成准备。')
    if (!tool.configured) { setConfigTool(id); throw new Error('请先确认账号连接，再打开工具。') }
    let workspace = config.workspace
    if (id !== 'codexDesktop') {
      const selectedWorkspace = await toolsApi.chooseWorkspace()
      if (!selectedWorkspace) return false
      workspace = selectedWorkspace
    }
    return toolbox.run(`launch:${id}`, '正在打开工具', () => toolsApi.launch(id, workspace, mode))
  }
  function requestLaunch(id: ToolId) {
    if (launchRequest.current) return
    launchRequest.current = true
    void perform('打开工具', async () => {
      if (id === 'codexDesktop' && (await native.getCodexDesktopStatus()).running) setRestartDialog(true)
      else await launch(id)
    }).finally(() => { launchRequest.current = false })
  }
  function requestUninstall(id: ToolId) {
    const definition = tools.find((tool) => tool.id === id)!
    setConfirmation({ title: `卸载 ${definition.name}？`, body: '工具配置、账户数据和历史记录会保留。', label: '卸载工具', danger: true, work: async () => {
      await toolbox.run(id, '正在卸载', async () => {
        const result = await toolsApi.uninstall(id)
        if ('outcome' in result && result.outcome !== 'uninstalled' && result.outcome !== 'not-installed') {
          throw new Error(result.outcome === 'manual-required' ? result.error : '已打开卸载窗口，完成后请重新检测。')
        }
      })
      await toolbox.refresh(true)
    } })
  }
  useEffect(() => native.onUpdateState(setUpdate), [native])
  useEffect(() => {
    function receive() { void native.takeExternalDeepLink().then((link) => { if (link && mounted.current) { linkPrompted.current = false; setPendingLink(link) } }).catch(() => undefined) }
    const unsubscribe = native.onExternalDeepLink(receive)
    receive()
    return () => {
      delete document.documentElement.dataset.rendererReady
      unsubscribe()
    }
  }, [native])
  useEffect(() => {
    if (!pendingLink || boot !== 'ready' || auth || configTool || confirmation || switcher || restartDialog) return
    if (pendingLink.kind === 'invalid') { setOperationError(pendingLink.message); setPendingLink(null) }
    else if (pendingLink.kind === 'invite') {
      if (session.authenticated) setOperationError(`邀请码为 ${pendingLink.code}。退出当前账号后可用于注册。`)
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
    runtimeReady: toolbox.snapshot!.system.runtime.node.installed && !toolbox.snapshot!.system.runtime.node.tooOld && toolbox.snapshot!.system.runtime.npm.installed,
    pythonReady: toolbox.snapshot!.system.runtime.python.installed && !toolbox.snapshot!.system.runtime.python.detectionFailed,
    supported: tool.id !== 'codexDesktop' || platform?.codexDesktop.launch,
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
  return <BalanceTierProvider value={balanceAmount === null ? 'neutral' : balanceAmount <= 0 ? 'zero' : balanceAmount < 5 ? 'bad' : balanceAmount < 20 ? 'warn' : 'ok'}>
    {guide ? <StartGuide platform={os} tools={guideTools} signedIn={session.authenticated} busy={Object.keys(toolbox.jobs).length > 0 || accountBootstrapBusy} progress={accountBootstrapBusy && accountBootstrap ? { label: accountBootstrap.label, percent: accountBootstrap.percent } : undefined} resumeKey={scope}
      onDetect={() => toolbox.refresh(true)} onInstall={install} onInstallRuntime={() => installRuntime('node')} onInstallPython={() => installRuntime('python')} onConfigure={async (id) => { setConfigTool(id) }} onLogin={() => setAuth('login')}
      onLaunch={async (id) => id === 'chat' ? true : launch(id)}
      onComplete={(id) => { if (!writeLocalPreference(`xingmang-v2-guide:${scope}`, id)) toast.show('工具已准备好，但引导偏好没有保存在本机。', 'warn'); setWorkspaceEntered(true); setTourOpen(true); navigate(id === 'chat' ? 'chat' : 'home') }} onBack={() => setGuide(false)} onHelp={() => setHelp(true)} />
      : !session.authenticated && !workspaceEntered ? <Welcome onLogin={() => setAuth('login')} onRegister={() => setAuth('register')} onSteps={() => setGuide(true)} onHelp={() => setHelp(true)} onLegal={setLegal}
        reducedMotion={settings?.reducedMotion} supportQrUrl={qr} onReducedMotionChange={(reducedMotion) => void perform('保存外观', async () => setSettings(await app.savePreferences({ version: 2, reducedMotion })))} />
        : <AppFrame key={scope} activePage={page} account={{ signedIn: session.authenticated, supportsBilling: accountSupports(session, 'supportsBilling'), supportsAnnouncements: siteId === 'solov', identity: avatarIdentity, displayName: session.account?.username, balance: balanceAmount === null ? undefined : `$${balanceAmount.toFixed(2)}` }} platform={os}
          tourOpen={tourOpen} onTourClose={() => setTourOpen(false)}
          environment={toolbox.snapshot?.system.runtime.node.version ? `Node ${toolbox.snapshot.system.runtime.node.version}` : '命令行环境可选'} version={update?.currentVersion}
          unread={unread} installedCount={toolbox.snapshot ? presentTools(toolbox.snapshot).filter((tool) => tool.status.installed).length : undefined}
          network={toolbox.snapshot?.system.network}
          banner={session.authenticated && siteId === 'solov' && <AnnouncementCenter scope={scope} read={app.announcement} open={announcementOpen} onClose={() => setAnnouncementOpen(false)} onOpen={() => setAnnouncementOpen(true)} onUnread={setUnread} openExternal={app.openExternal} noticeUrl={relaySite.websiteUrl} />}
          notification={showUpdate && <Notice tone={update.error ? 'bad' : 'accent'} title={update.error ? '更新没有完成' : update.phase === 'downloaded' ? '更新已下载' : update.phase === 'downloading' ? '正在下载更新' : `新版本 ${update.availableVersion} 可以安装`}
            body={update.error?.message ?? '查看更新内容和安装状态。'} progress={update.progress?.percent} onDismiss={() => setDismissedUpdate(updateKey)} actions={<Button size="sm" onClick={() => navigate('updates')}>查看更新</Button>} />}
          adapter={{ navigate, openAccount: () => navigate('account'), switchAccount: () => setSwitcher(true), topUp: () => navigate('account', accountSupports(session, 'supportsBilling') ? 'recharge' : 'overview'),
            openHealth: () => navigate('health'), openUpdates: () => navigate('updates'), openHelp: () => setHelp(true), openAnnouncements: () => setAnnouncementOpen(true), openNotifications: () => navigate('updates'),
            logout: () => setConfirmation({ title: '退出星芒账号？', body: '已写入工具的配置会保留。', label: '退出登录', work: async () => { await app.logout(); await reloadAccount() } }),
          }}>
          <div key={scope} className="v2-page-host">
            {renderedChatScope === scope && <div className="v2-chat-host" hidden={page !== 'chat'}><ChatPage bridge={native} accountScope={scope} active={page === 'chat'} /></div>}
            {page === 'home' ? <Home api={toolsApi} supportsUsage={accountSupports(session, 'supportsUsage')} supportsBilling={accountSupports(session, 'supportsBilling')} snapshot={toolbox.snapshot} loading={toolbox.loading} error={toolbox.error} account={session.account} balance={balance} jobs={toolbox.jobs} bootstrap={accountBootstrap?.scope === scope ? accountBootstrap : null}
              onScan={() => void toolbox.refresh(true).catch(() => undefined)} onInstall={(id) => void perform('安装工具', () => install(id))} onLaunch={requestLaunch} onConfigure={setConfigTool} onUninstall={requestUninstall}
              onRuntime={(runtime) => void perform('准备环境', () => installRuntime(runtime))} onNavigate={navigate} onGuide={() => setGuide(true)} onBootstrapRetry={() => { if (session.account) void runAccountBootstrap(session.account.userId, 'login', true) }} />
              : null}
            {(Object.keys(visitedPages) as PageId[]).filter((id) => visitedPages[id] === scope || id === page).map((id) => <div key={id} hidden={page !== id} inert={page !== id}>
              <BusinessPage api={native} page={id} accountTab={accountTab} paymentReturn={paymentReturn} navigate={navigate} openLogin={() => setAuth('login')} openHelp={() => setHelp(true)}
                onAccountChanged={() => void perform('刷新账号', reloadAccount)} onSettingsChanged={setSettings} openConfig={setConfigTool} />
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
    {switcher && <Dialog open title="切换账号" width={480} onClose={() => setSwitcher(false)}><SavedAccounts api={native} onAccountChanged={(result) => { bootstrapEpoch.current++; bootstrapInFlight.current = null; if (result) suppressRestoredBootstrap.current.add(accountScope({ siteId: result.origin === 'https://api.solov.cc' ? 'solov-api' : 'solov', account: { userId: result.userId } as AccountSessionState['account'] })); setAccountBootstrap(null); if (!result?.failed.length) setSwitcher(false); setPaymentReturn(undefined); void perform('刷新账号', reloadAccount) }} onLogin={() => { setSwitcher(false); setAuth('login') }} /></Dialog>}
    {configTool && toolbox.snapshot && <ConfigDialog key={`${scope}:${configTool}`} api={toolsApi} tool={configTool} config={toolbox.snapshot.config} signedIn={session.authenticated}
      onClose={() => setConfigTool(null)} onSaved={() => toolbox.refresh(true)} onLogin={() => setAuth('login')} onKeys={() => { setConfigTool(null); navigate('account', 'keys') }} onHelp={() => setHelp(true)} />}
    {help && <Dialog open title="帮助与客服" onClose={() => setHelp(false)} width={480} footer={<Button onClick={() => { setHelp(false); navigate('tutorial') }}>使用教程</Button>}>
      <div className="v2-support">{siteId === 'solov' && qr && <img src={qr} alt="微信客服二维码" />}<h3>{siteId === 'solov' ? '微信扫码找客服' : '账号帮助'}</h3><p>{siteId === 'solov' ? '装不上、付了没到账，都可以问。' : '请在官方网站查看帮助与账号服务。'}</p><Button onClick={() => void perform('打开帮助', () => app.openExternal(siteId === 'solov' ? supportServiceUrl : relaySite.websiteUrl))}>在浏览器打开</Button><Button onClick={() => { setHelp(false); navigate('feedback') }}>复制反馈报告</Button></div>
    </Dialog>}
    {operationError && <Dialog open title="操作没有完成" onClose={() => setOperationError('')} footer={<Button onClick={() => setOperationError('')}>返回</Button>}><p role="alert">{operationError}</p></Dialog>}
    {restartDialog && <Dialog open title="Codex 已在运行" onClose={() => setRestartDialog(false)} busy={Boolean(toolbox.jobs['launch:codexDesktop'])} footer={<>
      <Button variant="ghost" onClick={() => setRestartDialog(false)}>取消</Button>
      <Button onClick={() => void perform('重启 Codex', async () => { await launch('codexDesktop', 'restart'); setRestartDialog(false) })}>重启 Codex</Button>
      <Button variant="primary" onClick={() => void perform('打开 Codex', async () => { await launch('codexDesktop'); setRestartDialog(false) })}>打开窗口</Button>
    </>}><p>可以直接打开现有窗口；需要重新加载配置时，选择重启 Codex。</p></Dialog>}
    {confirmation && <Confirm title={confirmation.title} body={confirmation.body} danger={confirmation.danger} okLabel={confirmation.label} loading={confirmBusy} onClose={() => setConfirmation(null)} onOk={() => {
      if (confirmationLock.current) return
      confirmationLock.current = true; setConfirmBusy(true)
      void confirmation.work().then(() => setConfirmation(null)).catch((cause) => setOperationError(cause instanceof Error ? cause.message : '操作没有完成')).finally(() => { confirmationLock.current = false; setConfirmBusy(false) })
    }} />}
  </BalanceTierProvider>
}

export default function RendererV2App({ api }: { api?: XingmangApi }) {
  const native = api ?? getBridge()
  if (!native) return <Splash phase="请从桌面应用打开工具箱" error="浏览器页面未连接本机服务。" />
  return <FailureBoundary native={native}><ToastProvider><RuntimeApp native={native} /></ToastProvider></FailureBoundary>
}
