import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleDot, Headset, X } from 'lucide-react'
import { AppFrame } from './components/AppFrame'
import { LoginDialog } from './components/account/LoginDialog'
import { RegisterDialog } from './components/account/RegisterDialog'
import { ForgotPasswordDialog } from './components/account/ForgotPasswordDialog'
import { ProvisioningConfirmDialog } from './components/account/ProvisioningConfirmDialog'
import { PasteKeyDialog } from './components/account/PasteKeyDialog'
import { AccountCenterPage, type AccountCenterTab } from './components/account/AccountCenterPage'
import { resolveAccountErrorMessage } from './components/account/account-errors'
import { resolveAccountAreaStatus, shouldShowManualKeyEntry } from './components/account/account-stub'
import { resolveAccountSnapshot } from './components/account/account-session'
import {
  buildProvisioningTargets,
  configureManagedCliKeysForInstalledClis,
  managedCliConfigsReadyForDashboard,
  resolveCliProvisioningGate,
  validateProvisionedCliConfigs,
  writeCliKeyForInstalledClis,
} from './account-provisioning'
import {
  codexDesktopInstallActive,
  codexDesktopLaunchDecision,
  codexSetupReadyForDashboard,
  commitStartupPlatformCapabilities,
  EmptyStatus,
  initialOnboardingPreview,
  initialSidebarCollapsed,
  initialTheme,
  isDetectionFailed,
  managedBootstrapCompleted,
  markManagedBootstrapCompleted,
  resolveInitialAppView,
  sameDesktopStatus,
  SIDEBAR_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type AppView,
  type StartupStage,
  type ThemeMode,
} from './app-shared'
import { providers, type ConfigTabId } from './provider-meta'
import { errorMessage, userFacingErrorMessage } from './error-message'
import packageInfo from '../package.json'
import { CodexLaunchDialog } from './components/config/CodexLaunchDialog'
import { ConfigDialog } from './components/config/ConfigDialog'
import { Dashboard } from './components/dashboard/Dashboard'
import { PythonInstallConfirmDialog } from './components/dashboard/PythonInstallConfirmDialog'
import { ErrorBoundary } from './components/ErrorBoundary'
import { CodexOnboarding } from './components/onboarding/CodexOnboarding'
import { NodeInstallGuide } from './components/onboarding/NodeInstallGuide'
import { Sidebar } from './components/Sidebar'
import { SupportDialog } from './components/SupportDialog'
import { WelcomePage } from './components/welcome/WelcomePage'
import { StartupSplash } from './components/StartupSplash'
import { Toast, type ToastMessage } from './components/Toast'
import { navigationItem, type PageId } from './navigation'
import { nodeRuntimeSupported } from './onboarding-runtime'
import type { ManagedBootstrapProgressUpdate, ManagedBootstrapStepId } from './managed-bootstrap-progress'
import { PlaceholderPage } from './pages/PlaceholderPage'
import { BackupsPage } from './pages/BackupsPage'
import { AiChatPage } from './pages/AiChatPage'
import { HealthPage } from './pages/HealthPage'
import { FeedbackPage } from './pages/FeedbackPage'
import {
  CODEX_DESKTOP_STORE_URI,
  CodexDesktopInstallSourceDialog,
  MaintenancePage,
} from './pages/MaintenancePage'
import { McpPage, type McpCreateRequest } from './pages/McpPage'
import { PluginsPage, type MarketplaceCreateRequest } from './pages/PluginsPage'
import { SessionsPage } from './pages/SessionsPage'
import { SettingsPage } from './pages/SettingsPage'
import { createScanRequestTracker, runCoordinatedScan } from './scan-coordinator'
import { createLatestRequestTracker } from './latest-request'
import {
  canLaunchManagedProvider,
  canRefreshOfficialChatGptUsage,
  managedProviderLaunchBlockedMessage,
  officialChatGptUsageRefreshMs,
  providerAccountSource,
} from './account-source'
import { createStartupGate } from './startup-gate'
import { shouldBlockStartupForUpdate, shouldCheckUpdatesOnStartup } from './startup-settings'
import {
  failClosedPlatformCapabilities,
  performCliInstallAction,
  performNodeRuntimeAction,
  platformPresentation,
} from './platform-presentation'
import { SkillsPage, type SkillImportRequest } from './pages/SkillsPage'
import { UpdatePage } from './pages/UpdatePage'
import { TutorialPage } from './pages/TutorialPage'
import {
  providerIds,
  resolveRelaySite,
  supportServiceUrl,
  type AccountBalance,
  type AccountProfile,
  type AccountSessionState,
  type AppConfigSummary,
  type AppSettingsV2,
  type CodexDesktopLaunchMode,
  type CodexDesktopInstallProgress,
  type CodexDesktopStatusEvent,
  type InstallProgress,
  type NodeRuntimeInstallProgress,
  type PythonRuntimeInstallProgress,
  type DiagnosticsReport,
  type McpServer,
  type PluginCatalog,
  type PlatformCapabilities,
  type ProviderId,
  type RememberedAccountLogin,
  type RepositoryContext,
  type SkillItem,
  type SystemSnapshot,
  type UpdateSnapshot,
} from './types'

function preferredModelsFromConfig(
  ...configs: Array<AppConfigSummary | null | undefined>
): Partial<Record<ProviderId, string>> {
  const preferred: Partial<Record<ProviderId, string>> = {}
  for (const provider of providerIds) {
    const model = configs
      .map((config) => config?.providers[provider]?.model)
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    if (model) preferred[provider] = model.trim()
  }
  return preferred
}

function App() {
  const [theme, setTheme] = useState<ThemeMode>(initialTheme)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed)
  const [activePage, setActivePage] = useState<PageId>('overview')
  const [systemNavigationExpanded, setSystemNavigationExpanded] = useState(false)
  const [platformCapabilities, setPlatformCapabilities] = useState<PlatformCapabilities>(() => {
    document.documentElement.dataset.platform = failClosedPlatformCapabilities.platform
    return failClosedPlatformCapabilities
  })
  const [appView, setAppView] = useState<AppView>('loading')
  const [accountCenterSection, setAccountCenterSection] = useState<AccountCenterTab>('overview')
  const [startupStage, setStartupStage] = useState<StartupStage>('updates')
  // Dev-only onboarding preview (XINGMANG_ONBOARDING_PREVIEW). Fixed at mount,
  // false in every packaged build — see initialOnboardingPreview in
  // app-shared.ts. Read by the startup gate below to bypass the welcome page.
  const [previewOnboarding] = useState<boolean>(() => initialOnboardingPreview(window.location.search))
  const [activeConfigTab, setActiveConfigTab] = useState<ConfigTabId>('codexDesktop')
  const [configOpen, setConfigOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<SystemSnapshot>(EmptyStatus)
  const [config, setConfig] = useState<AppConfigSummary | null>(null)
  const [scanning, setScanning] = useState(true)
  const [officialUsageRefreshing, setOfficialUsageRefreshing] = useState(false)
  const [installing, setInstalling] = useState<Set<ProviderId>>(new Set())
  const [installLog, setInstallLog] = useState<string[]>([])
  const [logOpen, setLogOpen] = useState(false)
  const [codexLaunchDialogOpen, setCodexLaunchDialogOpen] = useState(false)
  const [codexInstallDialogOpen, setCodexInstallDialogOpen] = useState(false)
  const [codexLaunchPhase, setCodexLaunchPhase] = useState<'idle' | 'closing' | 'opening'>('idle')
  const [cliLaunching, setCliLaunching] = useState<ProviderId | null>(null)
  const [codexDesktopInstalling, setCodexDesktopInstalling] = useState(false)
  const [codexDesktopInstallProgress, setCodexDesktopInstallProgress] = useState<CodexDesktopInstallProgress | null>(null)
  const [nodeRuntimeInstalling, setNodeRuntimeInstalling] = useState(false)
  const [nodeRuntimeInstallProgress, setNodeRuntimeInstallProgress] = useState<NodeRuntimeInstallProgress | null>(null)
  const [pythonRuntimeInstalling, setPythonRuntimeInstalling] = useState(false)
  const [pythonRuntimeInstallProgress, setPythonRuntimeInstallProgress] = useState<PythonRuntimeInstallProgress | null>(null)
  const [pythonInstallConfirmOpen, setPythonInstallConfirmOpen] = useState(false)
  const pythonRuntimeInstallRequestedRef = useRef(false)
  const [nodeGuideOpen, setNodeGuideOpen] = useState(false)
  // "下一步" 任务卡的两个不可推导里程碑（方案 B 第 3 节）：纯会话内存态，
  // 不持久化、重启即清；挂在 App() 而非 Dashboard() 上是为了在页面间导航时
  // 保留住——页面切换只是 11 分支三元链换分支，Dashboard 会随之卸载重挂，
  // 若状态挂在它上面，切一次页再切回来就白记了。
  const [nextStepsTriedLaunch, setNextStepsTriedLaunch] = useState(false)
  const [nextStepsExploredMcp, setNextStepsExploredMcp] = useState(false)
  // Real account session + balance (阶段 A). Synced from account:get-session /
  // account:get-balance on mount and after every successful login/register;
  // accountSnapshot itself is derived further down via resolveAccountSnapshot
  // (account-session.ts), right next to accountStatus.
  const [accountSession, setAccountSession] = useState<AccountSessionState | null>(null)
  const [accountBalance, setAccountBalance] = useState<AccountBalance | null>(null)
  const [accountDialog, setAccountDialog] = useState<'login' | 'register' | 'forgot-password' | null>(null)
  const [supportDialogOpen, setSupportDialogOpen] = useState(false)
  const supportWrapRef = useRef<HTMLDivElement>(null)
  const [onboardingAutoStart, setOnboardingAutoStart] = useState(true)
  const [accountBusy, setAccountBusy] = useState(false)
  // Set only by a real successful account:reset-password call (handleForgot-
  // PasswordSubmit below), never from mere form input -- same non-negotiable
  // as accountLoginPrefill just below. Holds the server-generated password
  // (new-api's ResetPassword hands one back; see NewApiResetPasswordResult's
  // comment in electron/new-api-client.ts) so ForgotPasswordDialog can reveal
  // it, and the email so handleForgotPasswordDone can seed LoginDialog's
  // prefill the same way handleAccountRegisterSubmit already does.
  const [accountResetOutcome, setAccountResetOutcome] = useState<{ email: string; newPassword: string } | null>(null)
  // Pre-fills LoginDialog's identifier field right after a successful
  // registration (new-api's POST /api/user/register returns no token/session
  // to auto-login with -- see handleAccountRegisterSubmit below), so the
  // user only has to retype their password. Only ever set from a real
  // successful register() call, never from mere form input, so a dialog the
  // user closes without submitting can never leak a fake prefill into a
  // later, unrelated login.
  const [accountLoginPrefill, setAccountLoginPrefill] = useState('')
  // 「记住密码」凭据(account:get-remembered-login,主进程 safeStorage 加密
  // 落盘)。只在登录弹窗打开期间驻留内存:弹窗一关立即清空,不让明文密码
  // 常驻渲染进程(I3 的精神)。ready 门控弹窗渲染,保证 LoginDialog 挂载时
  // 初始值已就位——useState 的 initial 只读一次,晚到的预填不会显示。
  const [rememberedLogin, setRememberedLogin] = useState<RememberedAccountLogin | null>(null)
  const [rememberedLoginReady, setRememberedLoginReady] = useState(false)
  useEffect(() => {
    if (!supportDialogOpen) return undefined
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && supportWrapRef.current?.contains(target)) return
      setSupportDialogOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [supportDialogOpen])
  useEffect(() => {
    if (accountDialog !== 'login') {
      setRememberedLogin(null)
      setRememberedLoginReady(false)
      return undefined
    }
    let active = true
    window.xingmang.getRememberedAccountLogin()
      .catch(() => null)
      .then((value) => {
        if (!active) return
        setRememberedLogin(value)
        setRememberedLoginReady(true)
      })
    return () => { active = false }
  }, [accountDialog])
  // 注册/找回密码流程会预填 identifier;只有它与记住的账号一致(或为空)
  // 时才带出记住的密码,避免"账号是 A、密码是 B 的"错配预填。
  const loginDialogSeed = () => {
    const matchesRemembered = accountLoginPrefill === '' || accountLoginPrefill === rememberedLogin?.identifier
    return {
      identifier: accountLoginPrefill || rememberedLogin?.identifier || '',
      password: matchesRemembered && rememberedLogin ? rememberedLogin.password : '',
      remember: Boolean(matchesRemembered && rememberedLogin),
    }
  }
  // "写入星芒 Key" 确认弹窗（阶段 A 加固）：登录/注册成功后，若已装 CLI 非空，
  // 把候选列表放进这里而不是直接写入；null = 弹窗不显示。见 offerCliProvisioning。
  const [provisioningTargets, setProvisioningTargets] = useState<ProviderId[] | null>(null)
  const [provisioningRetryTargets, setProvisioningRetryTargets] = useState<ProviderId[] | null>(null)
  const [provisioningBusy, setProvisioningBusy] = useState(false)
  // 粘贴 Key 弹窗（W3b，manual-key 站点的写 Key 入口）：与 provisioningTargets
  // 同构，但候选列表来自侧边栏账号区的手动触发，而不是登录/注册成功后的
  // 静默 offer——见 handleOpenPasteKeyDialog。null = 弹窗不显示。
  const [pasteKeyTargets, setPasteKeyTargets] = useState<ProviderId[] | null>(null)
  const [pasteKeyBusy, setPasteKeyBusy] = useState(false)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [updateState, setUpdateState] = useState<UpdateSnapshot | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [settings, setSettings] = useState<AppSettingsV2>({
    version: 2,
    workspace: '',
    theme,
    checkUpdatesOnStartup: true,
    runDiagnosticsOnStartup: false,
  })
  const [repositoryContext, setRepositoryContext] = useState<RepositoryContext>({ repositoryRoot: null })
  const [healthReport, setHealthReport] = useState<DiagnosticsReport | null>(null)
  const [startupDiagnosticsAttempted, setStartupDiagnosticsAttempted] = useState(false)
  const [mcpServers, setMcpServers] = useState<McpServer[]>([])
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpError, setMcpError] = useState<string | null>(null)
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState<string | null>(null)
  const [pluginCatalog, setPluginCatalog] = useState<PluginCatalog>({ plugins: [], marketplaces: [] })
  const [pluginsLoading, setPluginsLoading] = useState(false)
  const [pluginsError, setPluginsError] = useState<string | null>(null)
  const scanTracker = useRef(createScanRequestTracker()).current
  const pageDataTracker = useRef(createLatestRequestTracker<'mcp' | 'skills' | 'plugins'>()).current
  // 概览页 30 秒轮询的桌面端探测是秒级慢操作（Windows 上三个 PowerShell 冷
  // 启动）。"打开桌面端"在探测在途时完成的话，旧探测落地会把 running:true
  // 盖回 running:false——按钮退回"打开"，用户以为没启动成功而重复点。任何
  // 更权威的写入（启动结果/状态事件/全量扫描）提交前都先作废在途探测。
  const desktopStatusTracker = useRef(createLatestRequestTracker<'codex-desktop'>()).current
  const officialUsageTracker = useRef(createLatestRequestTracker<'official-chatgpt'>()).current
  // Codex CLI resolution (mcp/plugins/model list) races ahead of the first
  // environment scan if fired the instant the dashboard becomes navigable;
  // see startup-gate.ts. Settled once, in `scan`, below.
  const cliReadyGate = useRef(createStartupGate()).current
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const configRef = useRef(config)
  configRef.current = config
  // state 更新在同一帧内不可见，双击防重入必须用 ref 同步短路。
  const cliLaunchingRef = useRef(false)
  const codexLaunchRequestRef = useRef(false)
  const accountBusyRef = useRef(false)
  const provisioningBusyRef = useRef(false)
  const pasteKeyBusyRef = useRef(false)
  const persistedSettings = useMemo(() => settings, [
    settings.version,
    settings.workspace,
    settings.theme,
    settings.checkUpdatesOnStartup,
    settings.runDiagnosticsOnStartup,
    // relaySiteId/mirrorPolicy are AppSettings fields SettingsPage's own
    // SettingsV2 mirrors (W3b's site dropdown, 2.4's mirror-policy dropdown)
    // -- every field SettingsPage reads/writes needs to be in this deps list,
    // or a save that only changes that field (every other field
    // byte-identical) would leave this memo returning the pre-save object
    // reference and SettingsPage's reconcileSettingsDraft effect would never
    // see the new value prop.
    // sidebarMoreExpanded stays deliberately excluded: SettingsPage's own
    // SettingsV2 type has no field for it, and settings:save's field-wise
    // merge (①栏11) leaves it untouched by the page's saves.
    settings.relaySiteId,
    settings.mirrorPolicy,
  ])
  // W3b adds the first site-switcher UI (SettingsPage's 服务站点 dropdown),
  // writing into settings.relaySiteId through the page's own normal save
  // path. Resolving through settings here (rather than hardcoding the
  // default site in each consumer) is what let that land as a pure addition
  // instead of another round of touching Sidebar/ConfigDialog/CodexOnboarding.
  const activeRelaySite = useMemo(
    () => resolveRelaySite(settings.relaySiteId),
    [settings.relaySiteId],
  )
  const presentation = useMemo(
    () => platformPresentation(platformCapabilities),
    [platformCapabilities],
  )

  useEffect(() => {
    const unsubscribe = window.xingmang.onNavigate(setActivePage)
    return unsubscribe
  }, [])

  useEffect(() => () => {
    scanTracker.invalidate()
    pageDataTracker.invalidateAll()
    desktopStatusTracker.invalidateAll()
  }, [pageDataTracker, scanTracker, desktopStatusTracker])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Theme still applies for the current session when persistence is unavailable.
    }
    void window.xingmang.setWindowTheme(theme).catch(() => {
      // Renderer theme remains available if native title bar synchronization fails.
    })
  }, [theme])

  useEffect(() => {
    void window.xingmang.getRepositoryContext()
      .then(setRepositoryContext)
      .catch((error) => setToast({ type: 'error', message: errorMessage(error) }))
  }, [])

  // The account service lives in the main process for the app's lifetime
  // with no disk persistence across restarts (docs/RECON-new-api.md 坑7), so
  // a renderer-only reload can still observe an already-authenticated
  // session here even though nothing was just logged in from this mount.
  useEffect(() => {
    let active = true
    void window.xingmang.getAccountSession()
      .then(async (session) => {
        if (!active) return
        setAccountSession(session)
        if (!session.authenticated) return
        try {
          void window.xingmang.syncManagedCliKeys()
            .then((synchronized) => {
              if (!active) return
              if (synchronized.storageWarning) {
                setToast({ type: 'error', message: `API Key 本地加密保存失败：${synchronized.storageWarning}` })
              } else if (synchronized.failed.length > 0) {
                setToast({ type: 'error', message: `${synchronized.failed.length} 个专属 Key 未完成初始化` })
              } else if (synchronized.imageSkillWarning) {
                setToast({ type: 'error', message: synchronized.imageSkillWarning })
              }
            })
            .catch((error) => {
              if (active) {
                setToast({ type: 'error', message: `API Key 本地配置读取失败：${resolveAccountErrorMessage(errorMessage(error))}` })
              }
            })
          const balance = await window.xingmang.getAccountBalance()
          if (active) setAccountBalance(balance)
        } catch {
          // Session may have just expired between the two calls; the account
          // area simply falls back to the guest/preview snapshot.
        }
      })
      .catch(() => undefined)
    return () => { active = false }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed))
    } catch {
      // Sidebar remains usable when persistence is unavailable.
    }
  }, [sidebarCollapsed])

  const loadConfig = useCallback(async () => {
    const next = await window.xingmang.getConfig()
    setConfig(next)
    return next
  }, [])

  useEffect(() => {
    if (
      appView !== 'dashboard'
      || !settings.runDiagnosticsOnStartup
      || startupDiagnosticsAttempted
    ) return
    setStartupDiagnosticsAttempted(true)
    void window.xingmang.runDiagnostics()
      .then(setHealthReport)
      .catch((error) => setToast({ type: 'error', message: `启动诊断失败：${errorMessage(error)}` }))
  }, [appView, settings.runDiagnosticsOnStartup, startupDiagnosticsAttempted])

  const refreshMcp = useCallback(async () => {
    const requestId = pageDataTracker.begin('mcp')
    setMcpLoading(true)
    setMcpError(null)
    try {
      // Codex CLI resolution is real filesystem/subprocess work; wait for the
      // first environment scan to settle so a fast navigation right after
      // startup doesn't race it and see a spuriously cold "not installed".
      await cliReadyGate.ready()
      const next = await window.xingmang.listMcpServers()
      if (pageDataTracker.isCurrent('mcp', requestId)) setMcpServers(next)
    } catch (error) {
      if (pageDataTracker.isCurrent('mcp', requestId)) setMcpError(errorMessage(error))
    } finally {
      if (pageDataTracker.isCurrent('mcp', requestId)) setMcpLoading(false)
    }
  }, [pageDataTracker, cliReadyGate])

  const refreshSkills = useCallback(async () => {
    const requestId = pageDataTracker.begin('skills')
    setSkillsLoading(true)
    setSkillsError(null)
    try {
      const next = await window.xingmang.listSkills()
      if (pageDataTracker.isCurrent('skills', requestId)) setSkills(next)
    } catch (error) {
      if (pageDataTracker.isCurrent('skills', requestId)) setSkillsError(errorMessage(error))
    } finally {
      if (pageDataTracker.isCurrent('skills', requestId)) setSkillsLoading(false)
    }
  }, [pageDataTracker])

  const refreshPlugins = useCallback(async () => {
    const requestId = pageDataTracker.begin('plugins')
    setPluginsLoading(true)
    setPluginsError(null)
    try {
      // See refreshMcp: wait for the first environment scan so this doesn't
      // race a fresh CLI resolution right after startup.
      await cliReadyGate.ready()
      const next = await window.xingmang.listPlugins()
      if (pageDataTracker.isCurrent('plugins', requestId)) setPluginCatalog(next)
    } catch (error) {
      if (pageDataTracker.isCurrent('plugins', requestId)) setPluginsError(errorMessage(error))
    } finally {
      if (pageDataTracker.isCurrent('plugins', requestId)) setPluginsLoading(false)
    }
  }, [pageDataTracker, cliReadyGate])

  // pageDataTracker.invalidate() 只作废在途请求、不产生后继请求；被顶掉的
  // refresh 连自己 finally 里的 setLoading(false) 都会跳过（isCurrent 已假）。
  // 突变分支必须自己收掉 loading，否则"首次加载在途时完成一次突变"会让加载
  // 态永久卡 true——页面工具栏（provider 下拉/刷新/新增）整体锁死，只能靠
  // 切页触发新 refresh 自救。三个助手把两步绑在一起，防止新增调用点漏掉。
  const invalidateMcpData = useCallback(() => {
    pageDataTracker.invalidate('mcp')
    setMcpLoading(false)
  }, [pageDataTracker])

  const invalidateSkillsData = useCallback(() => {
    pageDataTracker.invalidate('skills')
    setSkillsLoading(false)
  }, [pageDataTracker])

  const invalidatePluginsData = useCallback(() => {
    pageDataTracker.invalidate('plugins')
    setPluginsLoading(false)
  }, [pageDataTracker])

  useEffect(() => {
    if (activePage === 'mcp') void refreshMcp()
    else if (activePage === 'skills') void refreshSkills()
    else if (activePage === 'plugins') void refreshPlugins()
  }, [activePage, refreshMcp, refreshPlugins, refreshSkills])

  const healthApi = useMemo(() => ({
    run: async () => {
      const report = await window.xingmang.runDiagnostics()
      setHealthReport(report)
      return report
    },
    exportLatest: async () => {
      const result = await window.xingmang.exportDiagnostics()
      if (result) setToast({ type: 'success', message: `诊断报告已导出到 ${result.outputPath}` })
    },
  }), [])

  const backupsApi = useMemo(() => ({
    list: window.xingmang.listBackups,
    create: window.xingmang.createBackup,
    inspect: window.xingmang.inspectBackup,
    delete: window.xingmang.deleteBackup,
    restore: async (id: string) => {
      const result = await window.xingmang.restoreBackup(id)
      // 磁盘配置刚被恢复改写，任何仍在途的扫描（比如"一键安装全部"收尾的
      // 强制扫描）落地时都是恢复前的旧事实——不作废它，下面提交的新状态会
      // 被慢响应静默回滚，用户要手点"重新检测"才自愈。
      scanTracker.invalidate()
      const [configResult, snapshotResult] = await Promise.allSettled([
        window.xingmang.getConfig(),
        window.xingmang.scanSystem(),
      ])
      if (configResult.status === 'fulfilled') setConfig(configResult.value)
      if (snapshotResult.status === 'fulfilled') setSnapshot(snapshotResult.value)
      if (configResult.status === 'rejected' || snapshotResult.status === 'rejected') {
        setToast({ type: 'error', message: '配置已恢复，但工具概览刷新失败，请手动重新检测' })
      }
      return result
    },
  }), [])

  const scan = useCallback(async (forceRefresh = false): Promise<{
    snapshot: SystemSnapshot | null
    config: AppConfigSummary | null
  }> => {
    try {
      const result = await runCoordinatedScan<SystemSnapshot, AppConfigSummary>({
        tracker: scanTracker,
        scanSystem: () => window.xingmang.scanSystem(forceRefresh),
        readConfig: () => window.xingmang.getConfig(),
        onLoadingChange: setScanning,
        onSnapshot: (value) => {
          desktopStatusTracker.invalidate('codex-desktop')
          setSnapshot(value)
        },
        onConfig: setConfig,
        onFailures: (failures) => {
          const errors = failures.map(({ target, reason }) => (
            `${target === 'system' ? '环境检测' : '配置读取'}失败：${errorMessage(reason)}`
          ))
          setToast({ type: 'error', message: errors.join('；') })
        },
      })
      return { snapshot: result.snapshot, config: result.config }
    } finally {
      // A scan attempt -- successful, failed, or superseded -- means the
      // environment has been probed at least once; release anything waiting
      // on cliReadyGate even if the coordinator ever starts throwing.
      // settle() past the first call is a no-op.
      cliReadyGate.settle()
    }
  }, [scanTracker, cliReadyGate, desktopStatusTracker])

  const refreshOfficialUsage = useCallback(async (notify = false) => {
    if (!canRefreshOfficialChatGptUsage(configRef.current?.providers.codex)) return
    const requestId = officialUsageTracker.begin('official-chatgpt')
    setOfficialUsageRefreshing(true)
    try {
      const next = await window.xingmang.refreshOfficialChatGptUsage()
      if (!officialUsageTracker.isCurrent('official-chatgpt', requestId)) return
      setSnapshot((current) => ({ ...current, officialChatGpt: next }))
      if (notify) setToast({ type: 'success', message: '额度已刷新' })
    } catch (error) {
      if (!officialUsageTracker.isCurrent('official-chatgpt', requestId)) return
      if (notify) {
        setToast({ type: 'error', message: `额度刷新失败：${errorMessage(error)}` })
      }
    } finally {
      if (officialUsageTracker.isCurrent('official-chatgpt', requestId)) {
        setOfficialUsageRefreshing(false)
      }
    }
  }, [officialUsageTracker])

  const officialCodexAccount = canRefreshOfficialChatGptUsage(config?.providers.codex)
  useEffect(() => {
    if (!officialCodexAccount) return
    // Switching relay → ChatGPT only reloads config. The hourly timer would
    // leave the previous scan's empty quota on screen until the next tick.
    void refreshOfficialUsage(false)
    const timer = window.setInterval(() => {
      void refreshOfficialUsage(false)
    }, officialChatGptUsageRefreshMs)
    return () => window.clearInterval(timer)
  }, [officialCodexAccount, refreshOfficialUsage])

  const maintenanceApi = useMemo(() => ({
    scan: async (forceRefresh = false) => {
      const result = await scan(forceRefresh)
      const next = result.snapshot ?? snapshotRef.current
      return {
        checkedAt: next.checkedAt,
        runtime: { node: next.runtime.node, npm: next.runtime.npm },
        clis: next.clis,
        codexDesktop: next.desktopApps.codex,
      }
    },
    installNodeRuntime: async () => {
      if (platformCapabilities.nodeRuntimeInstall === 'external') {
        await performNodeRuntimeAction(platformCapabilities, window.xingmang)
        return { installed: false as const, action: 'external' as const }
      }
      return window.xingmang.installNodeRuntime()
    },
    restartWindows: async () => window.xingmang.restartWindows(),
    maintainCli: async (provider: ProviderId) => {
      const result = await performCliInstallAction(provider, platformCapabilities, window.xingmang)
      if (result.kind === 'external') throw new Error(result.guidance)
    },
    uninstallCli: async (provider: ProviderId) => window.xingmang.uninstallCli(provider),
    checkCli: async (provider: ProviderId) => {
      const status = await window.xingmang.checkCliUpdate(provider)
      setSnapshot((current) => current ? {
        ...current,
        checkedAt: new Date().toISOString(),
        clis: { ...current.clis, [provider]: status },
      } : current)
      return status
    },
    installCodexDesktop: async () => {
      const result = await window.xingmang.installCodexDesktop()
      try { setSettings(await window.xingmang.getSettings()) } catch { /* scan remains authoritative */ }
      return result
    },
    uninstallCodexDesktop: async () => {
      const result = await window.xingmang.uninstallCodexDesktop()
      setSettings(await window.xingmang.getSettings())
      return result
    },
    checkCodexDesktop: async () => {
      const status = await window.xingmang.checkCodexDesktopUpdate()
      setSnapshot((current) => current ? {
        ...current,
        checkedAt: new Date().toISOString(),
        desktopApps: { ...current.desktopApps, codex: status },
      } : current)
      return status
    },
    openCodexDesktopStore: async () => {
      await window.xingmang.openExternal(CODEX_DESKTOP_STORE_URI)
    },
    launchCodexDesktop: async () => {
      await window.xingmang.launchCodexDesktop('open')
    },
    onProgress: window.xingmang.onInstallProgress,
    onNodeRuntimeProgress: window.xingmang.onNodeRuntimeInstallProgress,
    onDesktopProgress: window.xingmang.onCodexDesktopInstallProgress,
  }), [platformCapabilities, scan])

  const saveSettings = useCallback(async (next: AppSettingsV2) => {
    // settings:save 已是字段级合并（①栏11）：载荷缺省的字段主进程一律不动，
    // 所以这里不再需要把 sidebarMoreExpanded 重新盖回去——设置页草稿本来
    // 就不携带它。唯一要显式表达的是 mirrorPolicy 的「自动」：合并语义下
    // 缺省 = 保持原值，设置页用缺省表达自动，需映射为显式 'auto' 清除标记。
    const saved = await window.xingmang.saveSettings({ ...next, mirrorPolicy: next.mirrorPolicy ?? 'auto' })
    // Commit the persisted settings before refreshing derived data. A failure
    // below must not make a completed save look like a rejected one.
    // sidebarMoreExpanded / theme 保留内存态：前者本次保存不携带意图；后者
    // 由预览即时 setTheme 且经 [theme] effect 即时持久化，采纳响应里的旧值
    // 会把保存在途期间的一次主题切换闪跳回去并重新落盘（launch 流同款处理）。
    setSettings((current) => ({
      ...saved,
      theme: current.theme,
      sidebarMoreExpanded: current.sidebarMoreExpanded,
    }))
    try {
      setRepositoryContext(await window.xingmang.getRepositoryContext())
      setToast({ type: 'success', message: '设置已保存' })
    } catch (error) {
      setToast({ type: 'error', message: `设置已保存，但工作目录信息刷新失败：${errorMessage(error)}` })
    }
  }, [])

  const toggleSidebarMoreExpanded = useCallback(() => {
    setSystemNavigationExpanded((current) => !current)
  }, [])

  useEffect(() => {
    setSystemNavigationExpanded(navigationItem(activePage).group === 'more')
  }, [activePage])

  useEffect(() => {
    let active = true
    let unsubscribeStartupUpdate: (() => void) | null = null
    let cancelStartupWait: (() => void) | null = null
    const initialize = async () => {
      try {
        let startupPlatform = failClosedPlatformCapabilities
        await commitStartupPlatformCapabilities(
          () => window.xingmang.getPlatformCapabilities(),
          (capabilities) => {
            if (!active) return
            startupPlatform = capabilities
            setPlatformCapabilities(capabilities)
            document.documentElement.dataset.platform = capabilities.platform
          },
        )
        if (!active) return

        let startupSettings: AppSettingsV2 | null = null
        try {
          const nextSettings = await window.xingmang.getSettings()
          startupSettings = nextSettings
          if (!active) return
          setSettings(nextSettings)
          setTheme(nextSettings.theme)
        } catch (error) {
          if (active) setToast({ type: 'error', message: errorMessage(error) })
        }

        const startupUpdate = shouldCheckUpdatesOnStartup(startupSettings)
          ? await window.xingmang.runStartupUpdate()
          : await window.xingmang.getUpdateState()
        if (!active) return
        setUpdateState(startupUpdate)
        if (shouldBlockStartupForUpdate(startupUpdate)) {
          await new Promise<void>((resolve, reject) => {
            let settled = false
            const finish = (error?: unknown) => {
              if (settled) return
              settled = true
              unsubscribeStartupUpdate?.()
              unsubscribeStartupUpdate = null
              cancelStartupWait = null
              if (error) reject(error)
              else resolve()
            }
            const accept = (state: UpdateSnapshot) => {
              if (!active) {
                finish()
                return
              }
              setUpdateState(state)
              if (!shouldBlockStartupForUpdate(state)) finish()
            }
            unsubscribeStartupUpdate = window.xingmang.onUpdateState(accept)
            cancelStartupWait = () => finish()
            // Close the event-subscription race if the installer failed
            // between runStartupUpdate() resolving and listener registration.
            void window.xingmang.getUpdateState().then(accept).catch(finish)
          })
          if (!active) return
        }

        setStartupStage('codex')
        // account:get-session is awaited ahead of BOTH startup destinations.
        // The single scan below supplies config, runtime, CLI and desktop
        // readiness; older code ran separate readiness/setup probes first and
        // repeated the same PowerShell work during scan().
        const startupAccountSession = await window.xingmang.getAccountSession().catch(() => null)
        if (!active) return
        if (startupAccountSession) setAccountSession(startupAccountSession)
        const authenticated = startupAccountSession?.authenticated ?? false
        const manualKeySite = shouldShowManualKeyEntry(
          resolveRelaySite(startupSettings?.relaySiteId).accountBackend,
        )
        const officialProviders = startupSettings?.officialProviders ?? []
        const managedBootstrapCheckpointReady = manualKeySite
          || Boolean(
            startupAccountSession?.account
            && (
              managedBootstrapCompleted(startupAccountSession.account.userId)
              || officialProviders.includes('codex')
            ),
          )
        let durableCodexSetupReady = false
        let managedCliConfigsReady = manualKeySite
        let startupScanCompleted = false
        if (
          (manualKeySite || managedBootstrapCheckpointReady)
          && (authenticated || manualKeySite)
        ) {
          const startupScan = await scan()
          if (!active) return
          startupScanCompleted = true
          const scannedCodex = startupScan.config?.providers.codex
          const scannedCodexReady = Boolean(scannedCodex?.hasApiKey && scannedCodex.matchesRelay)
          const scannedCodexConfigured = scannedCodexReady || officialProviders.includes('codex')
          const scannedSetup = startupScan.snapshot
            ? {
                checkedAt: startupScan.snapshot.checkedAt,
                runtime: {
                  node: startupScan.snapshot.runtime.node,
                  npm: startupScan.snapshot.runtime.npm,
                },
                cli: startupScan.snapshot.clis.codex,
                desktop: startupScan.snapshot.desktopApps.codex,
              }
            : null
          durableCodexSetupReady = Boolean(
            scannedCodexConfigured
            && scannedSetup
            && codexSetupReadyForDashboard(
              scannedSetup,
              startupPlatform,
              startupSettings?.codexDesktopInstallDisabled === true,
            ),
          )
          managedCliConfigsReady = Boolean(
            startupScan.snapshot
            && startupScan.config
            && managedCliConfigsReadyForDashboard(
              startupScan.snapshot,
              startupScan.config,
              officialProviders,
            ),
          )
        }
        if (
          managedBootstrapCheckpointReady
          && durableCodexSetupReady
          && managedCliConfigsReady
        ) {
          setAppView('dashboard')
          if (!startupScanCompleted) void scan()
          return
        }
        // The welcome/onboarding paths never run the initial scan, so config
        // must be hydrated here for the onboarding flow (same side effect
        // and failure semantics as before: a loadConfig rejection falls to
        // the catch below).
        await loadConfig()
        if (!active) return
        setScanning(false)
        setAppView(resolveInitialAppView(authenticated, previewOnboarding, manualKeySite))
      } catch (error) {
        if (!active) return
        setToast({ type: 'error', message: errorMessage(error) })
        setAppView('dashboard')
        void scan()
      }
    }
    void initialize()
    return () => {
      active = false
      cancelStartupWait?.()
      unsubscribeStartupUpdate?.()
    }
  }, [loadConfig, scan])

  useEffect(() => {
    if (appView === 'loading') return
    // AppWindowMode (main-process IPC contract) only knows 'onboarding' |
    // 'dashboard' — welcome and account-center have no window size of their
    // own because both are designed to fill the same 1590x875 canvas as the
    // dashboard, so they ride the 'dashboard' mode rather than growing a
    // third/fourth IPC-level mode.
    const windowMode = appView === 'welcome' || appView === 'account-center' ? 'dashboard' : appView
    void window.xingmang.setWindowMode(windowMode).catch(() => {
      // Window sizing should not block configuration or tool access.
    })
  }, [appView])

  useEffect(() => {
    if (appView !== 'dashboard' || activePage !== 'overview') return
    const refreshCodexDesktopStatus = async () => {
      if (document.hidden) return
      try {
        const requestId = desktopStatusTracker.begin('codex-desktop')
        const status = await window.xingmang.getCodexDesktopStatus()
        if (!desktopStatusTracker.isCurrent('codex-desktop', requestId)) return
        setSnapshot((current) => sameDesktopStatus(current.desktopApps.codex, status)
          ? current
          : {
              ...current,
              desktopApps: { ...current.desktopApps, codex: status },
            })
      } catch {
        // The main scan surfaces errors; background status polling stays silent.
      }
    }
    // Every probe spawns three PowerShell processes on Windows, and a cold
    // start dominates the cost once a virus scanner inspects each one. Probing
    // when the page opens and whenever the window comes back to the foreground
    // keeps the card as fresh as the user can perceive, so the timer between
    // those moments only needs to catch changes made outside the app.
    void refreshCodexDesktopStatus()
    const interval = window.setInterval(() => void refreshCodexDesktopStatus(), 30_000)
    const refreshWhenVisible = () => void refreshCodexDesktopStatus()
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [activePage, appView, desktopStatusTracker])

  useEffect(() => {
    return window.xingmang.onCodexDesktopInstallProgress((progress) => {
      setCodexDesktopInstallProgress(progress)
      setCodexDesktopInstalling(codexDesktopInstallActive(progress))
      if (appView === 'dashboard') {
        setLogOpen(true)
        setInstallLog((current) => [...current.slice(-80), progress.message])
      }
    })
  }, [appView])

  useEffect(() => {
    return window.xingmang.onNodeRuntimeInstallProgress((progress) => {
      setNodeRuntimeInstallProgress(progress)
    })
  }, [])

  useEffect(() => {
    return window.xingmang.onPythonRuntimeInstallProgress((progress) => {
      setPythonRuntimeInstallProgress(progress)
    })
  }, [])

  useEffect(() => {
    if (appView !== 'dashboard') return
    return window.xingmang.onInstallProgress((event: InstallProgress) => {
      setLogOpen(true)
      setInstallLog((current) => [...current.slice(-80), event.message])
      if (event.state === 'success' || event.state === 'error') {
        setInstalling((current) => {
          const next = new Set(current)
          next.delete(event.provider)
          return next
        })
      }
    })
  }, [appView])

  useEffect(() => {
    return window.xingmang.onCodexDesktopStatus((event: CodexDesktopStatusEvent) => {
      desktopStatusTracker.invalidate('codex-desktop')
      setSnapshot((current) => ({
        ...current,
        desktopApps: { ...current.desktopApps, codex: event.status },
      }))
      setCodexLaunchPhase(event.phase === 'stopped' ? 'opening' : 'idle')
    })
  }, [desktopStatusTracker])

  useEffect(() => {
    let active = true
    void window.xingmang.getUpdateState()
      .then((state) => {
        if (active) setUpdateState(state)
      })
      .catch(() => undefined)
    const unsubscribe = window.xingmang.onUpdateState((state) => {
      if (active) setUpdateState(state)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!toast || toast.type !== 'success') return
    const timeout = window.setTimeout(() => setToast(null), 3_600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const copyToastMessage = useCallback(() => {
    if (!toast) return
    const clipboard = navigator.clipboard
    if (clipboard) void clipboard.writeText(toast.message).catch(() => undefined)
  }, [toast])

  const runtimeReady = nodeRuntimeSupported(snapshot.runtime) && snapshot.runtime.npm.installed
  const installedCliCount = providerIds.filter((id) => snapshot.clis[id].installed).length
  const installedToolCount = installedCliCount + Number(snapshot.desktopApps.codex.installed)
  const accountSnapshot = resolveAccountSnapshot(accountSession, accountBalance, window.location.search)
  const accountStatus = resolveAccountAreaStatus(accountSnapshot)

  // Shared by both submit handlers below: re-reads the main process's account
  // session right after a successful login/register call so the sidebar's
  // three-state account area starts reflecting real data immediately.
  // 侧边栏「刷新余额」按钮(老板需求 2026-08-10):即点即拉实时余额。复用
  // refreshAccountSession 的同一条链,成功/失败都有明确反馈,不做静默。
  const handleRefreshBalance = async () => {
    try {
      await refreshAccountSession()
      setToast({ type: 'success', message: '余额已刷新' })
    } catch (error) {
      setToast({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
    }
  }

  const refreshAccountSession = async (): Promise<AccountProfile | null> => {
    const session = await window.xingmang.getAccountSession()
    setAccountSession(session)
    if (!session.authenticated) {
      setAccountBalance(null)
      return null
    }
    const balance = await window.xingmang.getAccountBalance()
    setAccountBalance(balance)
    return session.account
  }

  // 账号路径在主进程为每个 provider 使用其专属分组 Key，并直接写入对应 CLI；
  // renderer 只收到 provider 级摘要，明文不跨 IPC。`selected` 由确认弹窗给出。
  //
  // `suppliedKey` 是 W3b 加的第二条路径：manual-key 站点没有账号服务可签发
  // Key，PasteKeyDialog 把用户粘贴的值直接交过来，写入逻辑与账号签发的 Key
  // 完全复用 writeCliKeyForInstalledClis（config:save 两阶段提交）。
  const runCliProvisioning = async (selected: readonly ProviderId[], suppliedKey?: string) => {
    const effectiveSelected = suppliedKey
      ? [...selected]
      : selected.filter((provider) => !settings.officialProviders?.includes(provider))
    if (effectiveSelected.length === 0) return
    const preferredModels = preferredModelsFromConfig(config)
    const keyLabel = suppliedKey ? '粘贴的 Key' : '星芒 Key'
    // handleConfigureCliKey 只在点击入口挡了一次 manual-key 站点，但登录成功
    // 后的自动 offer 路径要先 await scan()（秒~十秒级且无模态遮挡），用户在
    // 这个窗口里切到 manual-key 站点再确认弹窗，就会向账号站签发 Key 写进
    // 当前站点配置——跨站点凭据混线。真正签发前在这里再复查一次。
    if (!suppliedKey && shouldShowManualKeyEntry(activeRelaySite.accountBackend)) {
      setToast({ type: 'error', message: '当前站点不支持账号签发 Key，请使用「粘贴 Key」配置' })
      return
    }
    try {
      const outcome = suppliedKey
        ? await writeCliKeyForInstalledClis(suppliedKey, effectiveSelected, preferredModels, window.xingmang)
        : await configureManagedCliKeysForInstalledClis(effectiveSelected, preferredModels, window.xingmang)
      // 写入已经落盘成功，这里只是刷新配置摘要。刷新失败不能落进外层 catch
      // 把结论反转成"写入失败"——那与磁盘上的事实完全相反。
      let refreshFailed = false
      if (outcome.configured.length > 0) {
        try {
          setConfig(await window.xingmang.getConfig())
          setSettings(await window.xingmang.getSettings())
        } catch {
          refreshFailed = true
        }
      }
      if (outcome.configured.length > 0 && outcome.failed.length === 0) {
        setProvisioningRetryTargets(null)
        setToast(refreshFailed
          ? { type: 'error', message: `已把${keyLabel}配置到 ${outcome.configured.length} 个 CLI，但状态刷新失败；请到概览页重新检测` }
          : { type: 'success', message: `已把${keyLabel}配置到 ${outcome.configured.length} 个 CLI` })
      } else if (outcome.configured.length > 0) {
        const failedNames = outcome.failed.map((entry) => providers[entry.provider].name).join('、')
        const failureDetails = outcome.failed
          .map((entry) => `${providers[entry.provider].name}：${userFacingErrorMessage(entry.message)}`)
          .join('；')
        if (!suppliedKey) setProvisioningRetryTargets(outcome.failed.map((entry) => entry.provider))
        setToast({
          type: 'error',
          message: `已配置 ${outcome.configured.length} 个 CLI；${failedNames} 配置失败：${failureDetails}`,
        })
      } else if (outcome.failed.length > 0) {
        if (!suppliedKey) setProvisioningRetryTargets(outcome.failed.map((entry) => entry.provider))
        const failureDetails = outcome.failed
          .map((entry) => `${providers[entry.provider].name}：${userFacingErrorMessage(entry.message)}`)
          .join('；')
        setToast({ type: 'error', message: `${keyLabel}未能配置到所选 CLI：${failureDetails}` })
      }
    } catch (error) {
      setToast({ type: 'error', message: `${keyLabel}${suppliedKey ? '写入' : '签发'}失败：${userFacingErrorMessage(error)}` })
    }
  }

  // 登录/注册成功后调用：把已装 CLI 列表交给确认弹窗，由用户勾选后再真正写入
  // （阶段 A 加固，见 ProvisioningConfirmDialog.tsx）。没有已装 CLI 时不打扰
  // 用户，直接跳过——原静默写入在“没有可写对象”这一分支上的行为保持不变。
  const offerCliProvisioning = (snapshot: SystemSnapshot = snapshotRef.current) => {
    const targets = buildProvisioningTargets(snapshot, settings.officialProviders)
    if (targets.length === 0) return
    setProvisioningTargets(targets)
  }

  // T6：state 更新在同一帧内不可见，双击/重复 submit 防重入必须用 ref 同步短路
  // （与 accountBusyRef 同一模式）。
  const confirmCliProvisioning = async (selected: ProviderId[]) => {
    if (provisioningBusyRef.current) return
    provisioningBusyRef.current = true
    setProvisioningBusy(true)
    try {
      await runCliProvisioning(selected)
    } finally {
      provisioningBusyRef.current = false
      setProvisioningBusy(false)
      setProvisioningTargets(null)
    }
  }

  const skipCliProvisioning = () => {
    if (provisioningBusyRef.current) return
    setProvisioningTargets(null)
  }

  // 下一步任务卡的"一键配置"与账号区的手动入口共用这一个触发口（W2.5,
  // docs/ACCOUNT-PLAN.md）——两处都不能直接调用 offerCliProvisioning：未登录
  // 时它会对着一个不存在的会话签发 Key，必然失败；已登录但零已装 CLI 时它
  // 又会静默什么都不做，用户点了按钮却什么反应都没有。resolveCliProvisioning-
  // Gate（纯函数，account-provisioning.ts）把这两种情况从"可以正常写"里分出
  // 来，好分别给出可执行的引导，而不是复用 handleAccountLoginSubmit 那条
  // 登录成功后的静默 offer 路径。
  const handleConfigureCliKey = async () => {
    // manual-key 站点没有账号登录/签发能力，「一键配置」必须导向粘贴 Key，
    // 否则会走到 offerCliProvisioning 的账号签发路径：未登录时弹出该站点根本
    // 用不到的星芒登录框，已登录（切站前在账号站登录过、未登出）时更糟——向
    // 账号站签发 Key 再写进当前 manual-key 站点的 CLI 配置，构成跨站点凭据混线。
    if (shouldShowManualKeyEntry(activeRelaySite.accountBackend)) {
      handleOpenPasteKeyDialog()
      return
    }
    const gate = resolveCliProvisioningGate(
      Boolean(accountSession?.authenticated),
      snapshotRef.current,
      settings.officialProviders,
    )
    if (gate === 'requires-login') {
      setAccountDialog('login')
      setToast({ type: 'error', message: '请先登录星芒账号，再一键配置 Key' })
      return
    }
    if (gate === 'requires-install') {
      if (scanning) {
        const scanResult = await scan()
        const targets = buildProvisioningTargets(
          scanResult.snapshot ?? snapshotRef.current,
          settings.officialProviders,
        )
        if (targets.length > 0) {
          offerCliProvisioning(scanResult.snapshot ?? snapshotRef.current)
          return
        }
      }
      setToast({ type: 'error', message: '请先安装一个 AI 工具，再配置星芒 Key' })
      return
    }
    offerCliProvisioning()
  }

  // 粘贴 Key 弹窗的打开入口（W3b，AccountArea 的 manual-key 分支按钮）。不需要
  // resolveCliProvisioningGate 的登录检查——manual-key 站点本来就没有账号
  // 登录态；唯一的前置条件是至少装了一个 CLI，否则弹窗打开了也没有勾选对象。
  const handleOpenPasteKeyDialog = async () => {
    let targets = buildProvisioningTargets(snapshotRef.current, settings.officialProviders)
    if (targets.length === 0 && scanning) {
      // 启动路径先进工作台再扫描，首扫落地前 snapshot 还是全未安装的占位。
      // 这是 manual-key 站点唯一的配 Key 入口，直接报"未安装"是谎报——等
      // 扫描结果（scan 经 T6 协调器合并并发调用），与账号路径把
      // scanResult.snapshot 显式传给 offerCliProvisioning 是同一种处理。
      const scanResult = await scan()
      targets = buildProvisioningTargets(
        scanResult.snapshot ?? snapshotRef.current,
        settings.officialProviders,
      )
    }
    if (targets.length === 0) {
      setToast({ type: 'error', message: '请先安装一个 AI 工具，再粘贴 Key' })
      return
    }
    setPasteKeyTargets(targets)
  }

  // T6：与 confirmCliProvisioning 同一模式的双击/重复 submit 防重入。
  const confirmPasteKeyProvisioning = async (key: string, selected: ProviderId[]) => {
    if (pasteKeyBusyRef.current) return
    pasteKeyBusyRef.current = true
    setPasteKeyBusy(true)
    try {
      await runCliProvisioning(selected, key)
    } finally {
      pasteKeyBusyRef.current = false
      setPasteKeyBusy(false)
      setPasteKeyTargets(null)
    }
  }

  const cancelPasteKeyProvisioning = () => {
    if (pasteKeyBusyRef.current) return
    setPasteKeyTargets(null)
  }

  const handleRequestVerificationCode = async (email: string) => {
    try {
      await window.xingmang.sendVerificationCode(email)
      setToast({ type: 'success', message: '验证码已发送至邮箱' })
    } catch (error) {
      setToast({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
    }
  }

  // Unlike handleRequestVerificationCode above, this one rethrows after
  // showing the toast: ForgotPasswordDialog's onRequestResetCode contract
  // needs to distinguish "the email really went out" from "the request
  // failed" to decide whether to reveal its 重置码 field (see that
  // component's own doc comment), which a never-rejects callback can't do.
  //
  // The success wording deliberately never confirms or denies that the
  // address has an account: new-api's GET /api/reset_password always
  // replies success either way (anti-enumeration by construction -- see
  // electron/new-api-client.ts's sendPasswordResetEmail comment), so a
  // wording implying certainty either way would be a lie this client has no
  // way to back up.
  const handleSendPasswordResetCode = async (email: string) => {
    try {
      await window.xingmang.sendPasswordResetCode(email)
      setToast({ type: 'success', message: '若该邮箱已注册，重置邮件已发送，请查收' })
    } catch (error) {
      setToast({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
      throw error
    }
  }

  const finishAuthenticatedEntry = async (successMessage: string, initialWarnings: string[] = []) => {
    const warnings = [...initialWarnings]
    try {
      const synchronized = await window.xingmang.syncManagedCliKeys()
      if (synchronized.storageWarning) {
        warnings.push(`API Key 本地加密保存失败：${synchronized.storageWarning}`)
      }
      if (synchronized.failed.length > 0) {
        warnings.push(`${synchronized.failed.length} 个专属 Key 未完成初始化`)
      }
      if (synchronized.imageSkillWarning) warnings.push(synchronized.imageSkillWarning)
    } catch (error) {
      warnings.push(`API Key 本地配置读取失败：${resolveAccountErrorMessage(errorMessage(error))}`)
    }

    // Re-login should reuse a verified bootstrap instead of replaying the
    // entire managed initialization flow. This is deliberately the same
    // durable gate used
    // at process startup, including official-provider opt-outs and drift
    // validation, so a newly installed or edited CLI still re-enters repair.
    try {
      const [freshSettings, session, readiness] = await Promise.all([
        window.xingmang.getSettings(),
        window.xingmang.getAccountSession(),
        window.xingmang.getCodexReadiness(),
      ])
      setSettings(freshSettings)
      if (session.authenticated && session.account) {
        const officialProviders = freshSettings.officialProviders ?? []
        const codexConfigured = readiness.hasApiKey && readiness.matchesRelay
          || officialProviders.includes('codex')
        const setup = codexConfigured
          ? await window.xingmang.getCodexSetupStatus()
          : null
        const checkpointReady = managedBootstrapCompleted(session.account.userId)
          || officialProviders.includes('codex')
        const durableReady = Boolean(
          codexConfigured
          && setup
          && codexSetupReadyForDashboard(
            setup,
            platformCapabilities,
            freshSettings.codexDesktopInstallDisabled === true,
          ),
        )
        if (checkpointReady && durableReady) {
          const scanned = await scan()
          if (
            scanned.snapshot
            && scanned.config
            && managedCliConfigsReadyForDashboard(
              scanned.snapshot,
              scanned.config,
              officialProviders,
            )
          ) {
            setAppView('dashboard')
            setToast(warnings.length > 0
              ? { type: 'error', message: `${successMessage}，${warnings.join('；')}` }
              : { type: 'success', message: `${successMessage}，已复用现有配置` })
            return
          }
        }
      }
    } catch (error) {
      warnings.push(`现有配置复核失败：${errorMessage(error)}`)
    }

    // Account-backed sites have a zero-click post-login bootstrap. The managed
    // onboarding path reuses the cached GPT-中转/订阅 key, prepares Codex
    // Desktop, verifies the resulting config, then enters the dashboard
    // automatically. Node.js, npm and Codex CLI stay optional and can be
    // installed later from maintenance when the user needs them.
    setOnboardingAutoStart(true)
    setAppView('onboarding')
    // The managed progress panel becomes the source of truth immediately
    // after login. A success toast repeated the same status and covered the
    // first progress rows in the compact onboarding window; retain only
    // actionable warnings here.
    setToast(warnings.length > 0
      ? { type: 'error', message: `${successMessage}，但${warnings.join('；')}` }
      : null)
  }

  // identifier may be either a username or an email address -- new-api's
  // Login handler matches either (see LoginDialog.tsx's own comment), and
  // its request field is always literally named `username` regardless of
  // which kind of value it holds.
  const handleAccountLoginSubmit = async (values: { identifier: string; password: string; remember: boolean }) => {
    if (accountBusyRef.current) return
    accountBusyRef.current = true
    setAccountBusy(true)
    let loginResult
    try {
      loginResult = await window.xingmang.loginAccount({ username: values.identifier, password: values.password })
    } catch (error) {
      setToast({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
      accountBusyRef.current = false
      setAccountBusy(false)
      return
    }
    try {
      // 只在登录确实成功后才落盘「记住密码」。未勾选时只清除"同一账号"的
      // 旧凭据——错配预填场景(如注册完 B 账号后登录,勾选框初值为 false)
      // 不能静默删掉 A 账号已存的记住密码(复查发现)。失败静默:记不住
      // 密码不该打断刚成功的登录。
      if (values.remember) {
        void window.xingmang.setRememberedAccountLogin(
          { identifier: values.identifier, password: values.password },
        ).catch(() => undefined)
      } else if (rememberedLogin && rememberedLogin.identifier === values.identifier) {
        void window.xingmang.setRememberedAccountLogin(null).catch(() => undefined)
      }
      setAccountSession({ authenticated: true, account: loginResult.account })
      const warnings: string[] = []
      try {
        setAccountBalance(await window.xingmang.getAccountBalance())
      } catch (error) {
        setAccountBalance(null)
        warnings.push(`余额暂时无法刷新：${resolveAccountErrorMessage(errorMessage(error))}`)
      }
      setAccountDialog(null)
      setAccountLoginPrefill('')
      await finishAuthenticatedEntry(`欢迎回来，${loginResult.account.username}`, warnings)
    } catch (error) {
      setAccountDialog(null)
    setOnboardingAutoStart(true)
    setAppView('onboarding')
      setToast({ type: 'error', message: `登录成功，但账号初始化失败：${resolveAccountErrorMessage(errorMessage(error))}` })
    } finally {
      accountBusyRef.current = false
      setAccountBusy(false)
    }
  }

  const handleAccountRegisterSubmit = async (values: {
    username: string
    email: string
    password: string
    verificationCode: string
    affCode?: string
  }) => {
    if (accountBusyRef.current) return
    accountBusyRef.current = true
    setAccountBusy(true)
    try {
      await window.xingmang.registerAccount({
        username: values.username,
        email: values.email,
        password: values.password,
        verificationCode: values.verificationCode,
        ...(values.affCode ? { affCode: values.affCode } : {}),
      })
    } catch (error) {
      setToast({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
      accountBusyRef.current = false
      setAccountBusy(false)
      return
    }

    let loginResult
    try {
      loginResult = await window.xingmang.loginAccount({ username: values.username, password: values.password })
    } catch {
      setAccountDialog('login')
      setAccountLoginPrefill(values.username)
      setToast({ type: 'success', message: '注册成功，请登录' })
      accountBusyRef.current = false
      setAccountBusy(false)
      return
    }

    try {
      setAccountSession({ authenticated: true, account: loginResult.account })
      const warnings: string[] = []
      try {
        setAccountBalance(await window.xingmang.getAccountBalance())
      } catch (error) {
        setAccountBalance(null)
        warnings.push(`余额暂时无法刷新：${resolveAccountErrorMessage(errorMessage(error))}`)
      }
      setAccountDialog(null)
      setAccountLoginPrefill('')
      await finishAuthenticatedEntry(`欢迎，${loginResult.account.username}，账号已创建`, warnings)
    } catch (error) {
      setAccountDialog(null)
      setOnboardingAutoStart(true)
      setAppView('onboarding')
      setToast({ type: 'error', message: `注册并登录成功，但账号初始化失败：${resolveAccountErrorMessage(errorMessage(error))}` })
    } finally {
      accountBusyRef.current = false
      setAccountBusy(false)
    }
  }

  // Completes the flow handleSendPasswordResetCode started. Shares
  // accountBusyRef with login/register/logout (same reentrancy guard, same
  // reasoning as those). Unlike handleAccountRegisterSubmit's success path,
  // this does NOT immediately hand off to LoginDialog: new-api's
  // POST /api/user/reset generates the new password itself and returns it
  // here (see ForgotPasswordDialog's own doc comment for why), so the user
  // has to actually see and copy it before leaving -- accountResetOutcome
  // makes ForgotPasswordDialog render that reveal panel instead of closing.
  // handleForgotPasswordDone below performs the actual hand-off once the
  // user has done so.
  const handleForgotPasswordSubmit = async (values: { email: string; token: string }) => {
    if (accountBusyRef.current) return
    accountBusyRef.current = true
    setAccountBusy(true)
    try {
      const result = await window.xingmang.resetPassword({ email: values.email, token: values.token })
      // 服务端已轮换密码,存着的「记住密码」凭据从此必然失效——立刻清除,
      // 否则「去登录」会把刚作废的旧密码预填给用户(复查发现)。
      void window.xingmang.setRememberedAccountLogin(null).catch(() => undefined)
      setAccountResetOutcome({ email: values.email, newPassword: result.newPassword })
      setToast({ type: 'success', message: '密码重置成功，请复制新密码后登录' })
    } catch (error) {
      setToast({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
    } finally {
      accountBusyRef.current = false
      setAccountBusy(false)
    }
  }

  // "去登录" on ForgotPasswordDialog's success panel: mirrors
  // handleAccountRegisterSubmit's hand-off (prefill the identifier, let the
  // user retype only the credential), and clears accountResetOutcome so the
  // generated password does not linger in memory once no longer needed.
  const handleForgotPasswordDone = () => {
    setAccountDialog('login')
    setAccountLoginPrefill(accountResetOutcome?.email ?? '')
    setAccountResetOutcome(null)
  }

  // W2 (docs/ACCOUNT-PLAN.md): the account:logout IPC call clears both the
  // main process's in-memory session and its safeStorage-encrypted disk copy
  // (electron/new-api-client.ts's onSessionChange -> account-session-store.ts);
  // this only has to reset local UI state to match. Shares accountBusyRef with
  // login/register so a logout click can't race an in-flight login/register
  // submit (same reentrancy guard, same reasoning as those two handlers).
  const handleAccountLogout = async (): Promise<boolean> => {
    if (accountBusyRef.current) return false
    accountBusyRef.current = true
    setAccountBusy(true)
    try {
      await window.xingmang.logoutAccount()
      setAccountSession({ authenticated: false, account: null })
      setAccountBalance(null)
      setToast({ type: 'success', message: '已登出星芒账号' })
      // 个人中心的四个 Tab 都要求已登录会话；登出后继续停在那儿只会在下次加载
      // 时看到一圈重试报错，不如直接送回工作台（仅在真的登出成功时才跳转，
      // 失败态必须原地不动，用户仍是登录状态）。
      setAppView((current) => current === 'account-center' ? 'dashboard' : current)
      return true
    } catch (error) {
      setToast({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
      return false
    } finally {
      accountBusyRef.current = false
      setAccountBusy(false)
    }
  }

  const leaveManagedOnboardingToWelcome = async () => {
    if (await handleAccountLogout()) setAppView('welcome')
  }

  const switchManagedOnboardingToManual = async () => {
    if (await handleAccountLogout()) setAppView('onboarding')
  }

  const installNodeRuntime = async () => {
    if (nodeRuntimeInstalling) return
    if (platformCapabilities.nodeRuntimeInstall === 'external') {
      try {
        await performNodeRuntimeAction(platformCapabilities, window.xingmang)
        setToast({ type: 'success', message: '已打开 Node.js 官网，请完成安装后重新检测' })
      } catch (error) {
        setToast({ type: 'error', message: errorMessage(error) })
      }
      return
    }
    setNodeRuntimeInstalling(true)
    setNodeRuntimeInstallProgress({
      phase: 'checking',
      source: null,
      percent: null,
      message: '正在准备 Node.js LTS 安装',
    })
    try {
      const result = await window.xingmang.installNodeRuntime()
      const refreshed = await scan(true)
      // snapshot 为 null 说明本次收尾扫描被更新的扫描取代，不能据此判定安装失败。
      if (refreshed.snapshot && (!nodeRuntimeSupported(refreshed.snapshot.runtime) || !refreshed.snapshot.runtime.npm.installed)) {
        throw new Error('Node.js 安装已完成，但当前进程仍未识别到受支持版本或 npm。请重启星芒AI管理工具后重新检测。')
      }
      setNodeGuideOpen(false)
      setToast({
        type: 'success',
        message: result.action === 'unchanged'
          ? `已检测到 Node.js ${result.version ?? ''} 和 npm，无需重复安装`.trim()
          : refreshed.snapshot
            ? `Node.js ${result.version ?? 'LTS'} 已安装，环境检测已刷新`
            : `Node.js ${result.version ?? 'LTS'} 已安装，检测结果以最新一次环境检测为准`,
      })
    } catch (error) {
      setToast({ type: 'error', message: errorMessage(error) })
      setNodeGuideOpen(true)
    } finally {
      setNodeRuntimeInstalling(false)
    }
  }

  const installPythonRuntime = async () => {
    if (pythonRuntimeInstalling || pythonRuntimeInstallRequestedRef.current) return
    pythonRuntimeInstallRequestedRef.current = true
    if (platformCapabilities.pythonRuntimeInstall === 'external') {
      try {
        await window.xingmang.openExternal('https://www.python.org/downloads/')
        setToast({ type: 'success', message: '已打开 Python 官网，请完成安装后重新检测' })
      } catch (error) {
        setToast({ type: 'error', message: errorMessage(error) })
      } finally {
        pythonRuntimeInstallRequestedRef.current = false
      }
      return
    }
    setPythonRuntimeInstalling(true)
    setPythonRuntimeInstallProgress({
      phase: 'checking',
      source: null,
      percent: null,
      message: '正在准备 Python 3.12 安装',
    })
    try {
      const result = await window.xingmang.installPythonRuntime()
      const refreshed = await scan(true)
      if (refreshed.snapshot && !refreshed.snapshot.runtime.python.installed) {
        throw new Error('Python 安装已完成，但当前进程仍未识别到 Python。请重启星芒AI管理工具后重新检测。')
      }
      setToast({
        type: 'success',
        message: result.action === 'unchanged'
          ? '已检测到 ' + (result.version ?? 'Python') + '，无需重复安装'
          : refreshed.snapshot
            ? (result.version ?? 'Python 3.12') + ' 已安装，环境检测已刷新'
            : (result.version ?? 'Python 3.12') + ' 已安装，检测结果以最新一次环境检测为准',
      })
    } catch (error) {
      setToast({ type: 'error', message: errorMessage(error) })
    } finally {
      setPythonRuntimeInstalling(false)
      pythonRuntimeInstallRequestedRef.current = false
    }
  }

  const install = async (
    provider: ProviderId,
    refreshAfter = true,
    showToast = true,
  ): Promise<boolean> => {
    if (platformCapabilities.cliInstall[provider] === 'external') {
      const result = await performCliInstallAction(provider, platformCapabilities, window.xingmang)
      if (result.kind === 'external' && showToast) {
        setToast({ type: 'error', message: result.guidance })
      }
      return false
    }
    const updating = snapshot.clis[provider].installed
    setInstalling((current) => new Set(current).add(provider))
    setInstallLog((current) => [
      ...current,
      provider === 'grok'
        ? '> 正在校验并安装 xAI 官方 Grok CLI'
        : `> 正在检测网络区域并为 ${providers[provider].packageName} 选择 npm 源`,
    ])
    setLogOpen(true)
    try {
      await window.xingmang.installCli(provider)
      let provisioningNotice = ''
      let provisioningError = ''
      if (
        accountSession?.authenticated
        && !shouldShowManualKeyEntry(activeRelaySite.accountBackend)
        && !settings.officialProviders?.includes(provider)
      ) {
        try {
          const outcome = await configureManagedCliKeysForInstalledClis(
            [provider],
            preferredModelsFromConfig(config),
            window.xingmang,
          )
          if (outcome.failed.length > 0) {
            provisioningError = `${providers[provider].name} 已安装，但星芒 Key 配置失败：${userFacingErrorMessage(outcome.failed[0].message)}`
          } else {
            provisioningNotice = '，星芒 Key 已自动配置'
          }
          try {
            setConfig(await window.xingmang.getConfig())
            setSettings(await window.xingmang.getSettings())
          } catch {
            // The write already committed; a later scan can refresh the safe
            // projection without misreporting the install as failed.
          }
        } catch (error) {
          provisioningError = `${providers[provider].name} 已安装，但星芒 Key 配置失败：${userFacingErrorMessage(error)}`
        }
      }
      if (showToast) {
        setToast(provisioningError
          ? { type: 'error', message: provisioningError }
          : { type: 'success', message: `${providers[provider].name} ${updating ? '更新' : '安装'}完成${provisioningNotice}` })
      }
      if (refreshAfter) await scan()
      return true
    } catch (error) {
      if (showToast) setToast({ type: 'error', message: errorMessage(error) })
      return false
    } finally {
      setInstalling((current) => {
        const next = new Set(current)
        next.delete(provider)
        return next
      })
    }
  }

  const installAll = async () => {
    // A detection failure is not evidence of absence: batch-installing over
    // it could reinstall on top of an already-working setup that the probe
    // merely failed to see this scan.
    const missing = providerIds.filter((id) => !snapshot.clis[id].installed && !isDetectionFailed(snapshot.clis[id]))
    if (!missing.length) return
    const succeeded: ProviderId[] = []
    const failures: Array<{ provider: ProviderId; message: string }> = []
    for (const provider of missing) {
      const success = await install(provider, false, false)
      if (success) succeeded.push(provider)
      else failures.push({ provider, message: '安装失败，详情请查看安装日志' })
    }
    await scan(true)
    if (failures.length) {
      const names = failures.map(({ provider }) => providers[provider].name).join('、')
      setToast({
        type: 'error',
        message: `批量安装完成：成功 ${succeeded.length} 项，失败 ${failures.length} 项（${names}）。请查看安装日志。`,
      })
    } else {
      setToast({ type: 'success', message: `批量安装完成：${succeeded.length} 项工具已安装，环境检测已刷新` })
    }
  }

  const installCodexDesktop = async () => {
    if (codexDesktopInstalling || codexDesktopInstallActive(codexDesktopInstallProgress)) return
    setCodexDesktopInstalling(true)
    setCodexDesktopInstallProgress(null)
    try {
      const result = await window.xingmang.installCodexDesktop()
      try { setSettings(await window.xingmang.getSettings()) } catch { /* scan remains authoritative */ }
      const message = result.action === 'updated'
        ? `Codex 桌面端已更新到 ${result.installedVersion ?? '最新版'}`
        : result.action === 'installed'
          ? `Codex 桌面端 ${result.installedVersion ?? ''} 安装完成`.trim()
          : 'Codex 桌面端已是最新版本'
      setToast({ type: 'success', message })
    } catch (error) {
      setToast({ type: 'error', message: errorMessage(error) })
    } finally {
      await scan(true)
      setCodexDesktopInstalling(false)
    }
  }

  const openConfig = (provider: ProviderId) => {
    setActiveConfigTab(provider)
    setConfigOpen(true)
  }


  const openCodexDesktopConfig = () => {
    setActiveConfigTab('codexDesktop')
    setConfigOpen(true)
  }

  const launch = async (provider: ProviderId) => {
    if (cliLaunchingRef.current) return
    cliLaunchingRef.current = true
    setCliLaunching(provider)
    try {
      const latest = await window.xingmang.getConfig()
      setConfig(latest)
      const providerConfig = latest.providers[provider]
      if (!canLaunchManagedProvider(providerConfig, provider)) {
        setActiveConfigTab(provider)
        setConfigOpen(true)
        setToast({
          type: 'error',
          message: managedProviderLaunchBlockedMessage(provider),
        })
        return
      }
      const workspace = await window.xingmang.chooseWorkspace()
      if (!workspace) return
      const [savedSettings, context] = await Promise.all([
        window.xingmang.getSettings(),
        window.xingmang.getRepositoryContext(),
      ])
      // 磁盘值不能覆盖内存主题，否则随后保存设置时可见主题会闪回旧值。
      // sidebarMoreExpanded 同理：「更多」切换是 fire-and-forget 窄更新，
      // 这里读到的磁盘快照可能早于其落盘，采纳会把乐观展开态闪跳回去。
      setSettings((current) => savedSettings.theme === current.theme
        && savedSettings.sidebarMoreExpanded === current.sidebarMoreExpanded
        ? savedSettings
        : { ...savedSettings, theme: current.theme, sidebarMoreExpanded: current.sidebarMoreExpanded })
      setRepositoryContext(context)
      await window.xingmang.launchCli(provider, workspace)
      setToast({ type: 'success', message: `${providers[provider].name} 已在新窗口启动` })
    } catch (error) {
      setToast({ type: 'error', message: errorMessage(error) })
    } finally {
      cliLaunchingRef.current = false
      setCliLaunching(null)
    }
  }

  // "下一步" 任务卡的两个 nudge 动作：标记内存态 + 复用既有导航/启动路径。
  // 标记动作故意不等待 launch() 的异步结果——这是一个软提示，不是「启动成
  // 功」的证明。但没有可启动的 provider 时（全新态）只弹提示、不标记完成，
  // 否则「已完成」的勾选和报错 toast 同时出现会自相矛盾。
  const handleNextStepsTryLaunch = (provider: ProviderId | null) => {
    if (provider) {
      setNextStepsTriedLaunch(true)
      void launch(provider)
    } else {
      setToast({ type: 'error', message: '请先安装并配置一个 AI 工具，再试试一键启动' })
    }
  }

  const handleNextStepsExploreMcp = () => {
    setNextStepsExploredMcp(true)
    setActivePage('mcp')
  }

  // "无限画布" opens a separate, isolated BrowserWindow (阶段 C) rather than
  // an in-app page, so it is intercepted here before activePage ever changes
  // -- every other nav item still goes straight to setActivePage.
  const handleNavigate = (pageId: PageId) => {
    if (pageId === 'canvas') {
      void window.xingmang.openCanvasWindow().catch((error) => {
        setToast({ type: 'error', message: errorMessage(error) })
      })
      return
    }
    setActivePage(pageId)
  }

  const performCodexDesktopLaunch = async (mode: CodexDesktopLaunchMode) => {
    setCodexLaunchDialogOpen(false)
    setCodexLaunchPhase(mode === 'restart' ? 'closing' : 'opening')
    try {
      const result = await window.xingmang.launchCodexDesktop(mode)
      desktopStatusTracker.invalidate('codex-desktop')
      setSnapshot((current) => ({
        ...current,
        desktopApps: { ...current.desktopApps, codex: result.status },
      }))
      setToast({
        type: 'success',
        message: result.restarted ? 'Codex 桌面端已重启并加载新配置' : 'Codex 桌面端窗口已打开',
      })
    } catch (error) {
      setToast({ type: 'error', message: errorMessage(error) })
    } finally {
      setCodexLaunchPhase('idle')
    }
  }

  const requestCodexDesktopLaunch = async () => {
    if (codexLaunchRequestRef.current) return
    codexLaunchRequestRef.current = true
    setCodexLaunchPhase('opening')
    try {
      const latest = await window.xingmang.getConfig()
      setConfig(latest)
      const codexConfig = latest.providers.codex
      if (!canLaunchManagedProvider(codexConfig, 'codex')) {
        setActiveConfigTab('codexDesktop')
        setConfigOpen(true)
        setToast({ type: 'error', message: managedProviderLaunchBlockedMessage('codex') })
        return
      }

      const status = await window.xingmang.getCodexDesktopStatus()
      setSnapshot((current) => ({
        ...current,
        desktopApps: { ...current.desktopApps, codex: status },
      }))
      if (codexDesktopLaunchDecision(platformCapabilities, status.running) === 'choose') {
        setCodexLaunchDialogOpen(true)
        return
      }
      await performCodexDesktopLaunch('open')
    } catch (error) {
      setToast({ type: 'error', message: errorMessage(error) })
    } finally {
      // early return（配置未就绪、打开确认弹窗）也必须复位，否则按钮永久 busy。
      codexLaunchRequestRef.current = false
      setCodexLaunchPhase('idle')
    }
  }

  const finishOnboarding = async (onProgress?: (update: ManagedBootstrapProgressUpdate) => void) => {
    setInstallLog([])
    setLogOpen(false)
    const failStep = (id: ManagedBootstrapStepId, error: unknown): never => {
      const message = userFacingErrorMessage(error)
      onProgress?.({ id, status: 'failed', message })
      throw error instanceof Error ? error : new Error(message)
    }

    onProgress?.({ id: 'scan-installed-clis', status: 'active', message: '正在扫描本机已安装的 AI CLI' })
    let scanResult: Awaited<ReturnType<typeof scan>>
    try {
      scanResult = await scan(true)
      if (!scanResult.snapshot) throw new Error('环境最终检测失败，正在等待下一次自动重试')
    } catch (error) {
      return failStep('scan-installed-clis', error)
    }
    onProgress?.({ id: 'scan-installed-clis', status: 'completed', message: '本机 AI CLI 扫描完成' })
    const latestSnapshot = scanResult.snapshot

    if (accountSession?.authenticated && !shouldShowManualKeyEntry(activeRelaySite.accountBackend)) {
      const targets = buildProvisioningTargets(latestSnapshot, settings.officialProviders)
      const preferredModels = preferredModelsFromConfig(scanResult.config, config)
      onProgress?.({
        id: 'configure-installed-clis',
        status: 'active',
        message: targets.length > 0 ? `正在配置 ${targets.length} 个已安装 AI CLI` : '当前没有其他 CLI 需要配置',
      })
      let configurationWarning = false
      let verificationTargets = targets
      try {
        const outcome = await configureManagedCliKeysForInstalledClis(targets, preferredModels, window.xingmang)
        const fatalFailures = outcome.failed.filter((entry) => (
          entry.provider === 'codex' && !settings.officialProviders?.includes('codex')
        ))
        if (fatalFailures.length > 0) {
          const failures = fatalFailures
            .map((entry) => `${providers[entry.provider].name}：${userFacingErrorMessage(entry.message)}`)
            .join('；')
          throw new Error(`Codex 自动配置验证未完成：${failures}`)
        }
        const nonFatalFailures = outcome.failed.filter((entry) => !fatalFailures.includes(entry))
        if (nonFatalFailures.length > 0) {
          configurationWarning = true
          const failedProviders = new Set(nonFatalFailures.map((entry) => entry.provider))
          verificationTargets = targets.filter((provider) => !failedProviders.has(provider))
          const warnings = nonFatalFailures
            .map((entry) => `${providers[entry.provider].name}：${userFacingErrorMessage(entry.message)}`)
            .join('；')
          setToast({ type: 'error', message: `部分 CLI 暂未配置，已进入工作台：${warnings}` })
          onProgress?.({ id: 'configure-installed-clis', status: 'completed', message: `配置完成，部分 CLI 有警告：${warnings}` })
        }
      } catch (error) {
        return failStep('configure-installed-clis', error)
      }
      if (!configurationWarning) {
        onProgress?.({ id: 'configure-installed-clis', status: 'completed', message: '已安装 CLI 配置写入完成' })
      }
      onProgress?.({ id: 'verify-config', status: 'active', message: '正在复核 Key、Relay 和默认模型' })
      let verifiedConfig: AppConfigSummary
      try {
        verifiedConfig = await window.xingmang.getConfig()
        const verificationFailures = validateProvisionedCliConfigs(
          verificationTargets,
          verifiedConfig,
          settings.officialProviders,
        )
        if (verificationFailures.length > 0) {
          const failures = verificationFailures
            .map((entry) => `${providers[entry.provider].name}：${entry.message}`)
            .join('；')
          throw new Error(`CLI 配置读后验证未通过：${failures}`)
        }
      } catch (error) {
        return failStep('verify-config', error)
      }
      onProgress?.({ id: 'verify-config', status: 'completed', message: 'Key、Relay 和默认模型验证通过' })
      setConfig(verifiedConfig)
      const userId = accountSession.account?.userId
      if (userId) markManagedBootstrapCompleted(userId)
    }

    onProgress?.({ id: 'enter-dashboard', status: 'active', message: '正在载入工作台' })
    onProgress?.({ id: 'enter-dashboard', status: 'completed', message: '工作台已准备完成' })
    if (onProgress) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 220))
    }
    setAppView('dashboard')
  }

  const runUpdateAction = async (
    action: () => Promise<UpdateSnapshot | { accepted: true }>,
  ) => {
    setUpdateBusy(true)
    try {
      const result = await action()
      if ('phase' in result) setUpdateState(result)
    } catch (error) {
      setToast({ type: 'error', message: errorMessage(error) })
    } finally {
      setUpdateBusy(false)
    }
  }

  if (appView === 'loading') {
    return (
      <AppFrame theme={theme} platform={platformCapabilities}>
        <StartupSplash theme={theme} stage={startupStage} updateState={updateState} />
      </AppFrame>
    )
  }

  if (appView === 'welcome') {
    return (
      <AppFrame theme={theme} platform={platformCapabilities}>
        <WelcomePage
          theme={theme}
          onRegister={() => setAccountDialog('register')}
          onLogin={() => setAccountDialog('login')}
          onHaveCode={() => setAppView('onboarding')}
        />
        {accountDialog === 'login' && rememberedLoginReady && (
          <LoginDialog
            onClose={() => setAccountDialog(null)}
            onSwitchToRegister={() => setAccountDialog('register')}
            onSubmit={(values) => void handleAccountLoginSubmit(values)}
            onForgotPassword={() => setAccountDialog('forgot-password')}
            initialIdentifier={loginDialogSeed().identifier}
            initialPassword={loginDialogSeed().password}
            initialRemember={loginDialogSeed().remember}
            isSubmitting={accountBusy}
          />
        )}
        {accountDialog === 'register' && (
          <RegisterDialog
            onClose={() => setAccountDialog(null)}
            onSwitchToLogin={() => setAccountDialog('login')}
            onSubmit={(values) => void handleAccountRegisterSubmit(values)}
            onRequestVerificationCode={handleRequestVerificationCode}
            isSubmitting={accountBusy}
          />
        )}
        {accountDialog === 'forgot-password' && (
          <ForgotPasswordDialog
            onClose={() => { setAccountDialog(null); setAccountResetOutcome(null) }}
            onSwitchToLogin={() => setAccountDialog('login')}
            onSubmit={(values) => void handleForgotPasswordSubmit(values)}
            onRequestResetCode={handleSendPasswordResetCode}
            onDone={handleForgotPasswordDone}
            isSubmitting={accountBusy}
            resetResult={accountResetOutcome}
          />
        )}
        {provisioningTargets && (
          <ProvisioningConfirmDialog
            targets={provisioningTargets}
            busy={provisioningBusy}
            onConfirm={(selected) => void confirmCliProvisioning(selected)}
            onSkip={skipCliProvisioning}
          />
        )}
        {provisioningRetryTargets && !provisioningTargets && (
          <ProvisioningConfirmDialog
            targets={provisioningRetryTargets}
            onConfirm={(selected) => {
              setProvisioningRetryTargets(null)
              void confirmCliProvisioning(selected)
            }}
            onSkip={() => setProvisioningRetryTargets(null)}
          />
        )}
        {toast && (
          <Toast
            toast={toast}
            onDismiss={() => setToast(null)}
            onCopy={toast.type === 'error' ? copyToastMessage : undefined}
          />
        )}
      </AppFrame>
    )
  }

  if (appView === 'onboarding') {
    return (
      <AppFrame theme={theme} platform={platformCapabilities}>
      <CodexOnboarding
        initialConfig={config}
        relaySite={activeRelaySite}
        authorizationMode={accountSession?.authenticated
          && !shouldShowManualKeyEntry(activeRelaySite.accountBackend)
          ? 'managed'
          : 'manual'}
        codexOfficial={settings.officialProviders?.includes('codex') ?? false}
        codexDesktopInstallDisabled={settings.codexDesktopInstallDisabled === true}
        theme={theme}
        onToggleTheme={() => {
          const next = theme === 'light' ? 'dark' : 'light'
          setTheme(next)
          // 设置页的 draft 以 settings 为基准，主题双通道必须同步，否则保存设置会把主题回退。
          setSettings((current) => current.theme === next ? current : { ...current, theme: next })
        }}
        onConfigChange={setConfig}
        onComplete={finishOnboarding}
        onLogout={() => void leaveManagedOnboardingToWelcome()}
        onSwitchToManual={() => void switchManagedOnboardingToManual()}
        autoStart={onboardingAutoStart}
        onCancel={() => {
          // 登录先行(老板拍板 2026-08-10):账号站点未登录时,「返回工作
          // 台」回欢迎页——否则「已有授权码→返回工作台」两次点击就零凭据
          // 绕过了登录门(复查发现)。
          const loginRequired = !shouldShowManualKeyEntry(activeRelaySite.accountBackend)
            && !(accountSession?.authenticated ?? false)
          if (loginRequired) {
            setAppView('welcome')
            return
          }
          setAppView('dashboard')
          // 不经 scan 进工作台会让 cliReadyGate 永不 settle,MCP/插件页
          // 与模型检测将永久挂起(settle 唯一调用点在 scan 的 finally)。
          void scan()
        }}
        desktopInstallProgress={codexDesktopInstallProgress}
        platform={platformCapabilities}
      />
      {toast && (
        <Toast
          toast={toast}
          onDismiss={() => setToast(null)}
          onCopy={toast.type === 'error' ? copyToastMessage : undefined}
        />
      )}
      </AppFrame>
    )
  }

  if (appView === 'account-center') {
    return (
      <AppFrame theme={theme} platform={platformCapabilities}>
        <AccountCenterPage
          onClose={() => setAppView('dashboard')}
          onLogout={() => void handleAccountLogout()}
          notify={setToast}
          initialSection={accountCenterSection}
        />
        {toast && (
          <Toast
            toast={toast}
            onDismiss={() => setToast(null)}
            onCopy={toast.type === 'error' ? copyToastMessage : undefined}
          />
        )}
      </AppFrame>
    )
  }

  return (
    <AppFrame theme={theme} platform={platformCapabilities}>
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <Sidebar
        activePage={activePage}
        collapsed={sidebarCollapsed}
        theme={theme}
        appVersion={packageInfo.version}
        updateState={updateState}
        relaySite={activeRelaySite}
        moreExpanded={systemNavigationExpanded}
        onNavigate={handleNavigate}
        onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
        onToggleTheme={() => {
          const next = theme === 'light' ? 'dark' : 'light'
          setTheme(next)
          // 设置页的 draft 以 settings 为基准，主题双通道必须同步，否则保存设置会把主题回退。
          setSettings((current) => current.theme === next ? current : { ...current, theme: next })
        }}
        onToggleMoreExpanded={toggleSidebarMoreExpanded}
        accountStatus={accountStatus}
        accountSnapshot={accountSnapshot}
        onAccountLogin={() => setAccountDialog('login')}
        onAccountLogout={() => void handleAccountLogout()}
        onRecharge={() => { setAccountCenterSection('topup'); setAppView('account-center') }}
        onConfigureCliKey={() => void handleConfigureCliKey()}
        onRefreshBalance={() => void handleRefreshBalance()}
        onOpenAccountCenter={() => { setAccountCenterSection('overview'); setAppView('account-center') }}
        onPasteKey={handleOpenPasteKeyDialog}
        onOpenKeysPage={() => { setAccountCenterSection('keys'); setAppView('account-center') }}
      />

      <div ref={supportWrapRef} className="floating-support-wrap">
        {supportDialogOpen && (
          <SupportDialog
            url={supportServiceUrl}
            onClose={() => setSupportDialogOpen(false)}
            onOpen={() => {
              setSupportDialogOpen(false)
              void window.xingmang.openExternal(supportServiceUrl).catch((error: unknown) => {
                setToast({ type: 'error', message: errorMessage(error) })
              })
            }}
          />
        )}
        <button
          type="button"
          className={`floating-support-button${supportDialogOpen ? ' is-open' : ''}`}
          aria-label="客服"
          aria-expanded={supportDialogOpen}
          title="客服"
          onClick={() => setSupportDialogOpen((current) => !current)}
        >
          <Headset size={21} aria-hidden="true" />
        </button>
      </div>

      <main className="main-content">
        <ErrorBoundary resetKey={activePage} onReturnOverview={() => setActivePage('overview')} notify={setToast}>
        {activePage === 'overview' ? (
          <Dashboard
            platform={platformCapabilities}
            snapshot={snapshot}
            config={config}
            scanning={scanning}
            installing={installing}
            cliLaunching={cliLaunching}
            codexLaunchPhase={codexLaunchPhase}
            codexDesktopInstalling={codexDesktopInstalling}
            codexDesktopInstallProgress={codexDesktopInstallProgress}
            nodeRuntimeInstalling={nodeRuntimeInstalling}
            nodeRuntimeInstallProgress={nodeRuntimeInstallProgress}
            pythonRuntimeInstalling={pythonRuntimeInstalling}
            pythonRuntimeInstallProgress={pythonRuntimeInstallProgress}
            runtimeReady={runtimeReady}
            installedCliCount={installedCliCount}
            installedToolCount={installedToolCount}
            nextStepsNudge={{ triedLaunch: nextStepsTriedLaunch, exploredMcp: nextStepsExploredMcp }}
            onScan={() => void scan(true)}
            officialUsageRefreshing={officialUsageRefreshing}
            onRefreshOfficialUsage={() => void refreshOfficialUsage(true)}
            onInstallNode={() => void installNodeRuntime()}
            onInstallPython={() => {
              if (platformCapabilities.pythonRuntimeInstall === 'managed') {
                setPythonInstallConfirmOpen(true)
                return
              }
              void installPythonRuntime()
            }}
            onOpenNodeGuide={() => setNodeGuideOpen(true)}
            onInstall={(provider) => void install(provider)}
            onInstallAll={() => void installAll()}
            onConfigure={openConfig}
            onConfigureCodexDesktop={openCodexDesktopConfig}
            onInstallCodexDesktop={() => setCodexInstallDialogOpen(true)}
            onLaunch={(provider) => void launch(provider)}
            onLaunchCodexDesktop={() => void requestCodexDesktopLaunch()}
            onNextStepsConfigureFirstCli={() => void handleConfigureCliKey()}
            manualKeySite={shouldShowManualKeyEntry(activeRelaySite.accountBackend)}
            onNextStepsTryLaunch={handleNextStepsTryLaunch}
            onNextStepsGoMaintenance={() => setActivePage('maintenance')}
            onNextStepsExploreMcp={handleNextStepsExploreMcp}
          />
        ) : activePage === 'chat' ? (
          <AiChatPage
            api={window.xingmang}
            userId={accountSession?.account?.userId ?? 'signed-out'}
            notify={setToast}
          />
        ) : activePage === 'sessions' ? (
          <SessionsPage api={window.xingmang} notify={setToast} />
        ) : activePage === 'mcp' ? (
          <McpPage
            servers={mcpServers}
            loading={mcpLoading}
            error={mcpError}
            onRefresh={refreshMcp}
            onAdd={async (input: McpCreateRequest) => {
              setMcpServers(await window.xingmang.addMcpServer(input))
              setMcpError(null)
              // 突变已经拿到权威结果，必须让任何仍在途的 refreshMcp() 失效，
              // 否则它稍后落地会用旧快照覆盖刚写入的数据。
              invalidateMcpData()
            }}
            onRemove={async (name) => {
              setMcpServers(await window.xingmang.removeMcpServer(name))
              setMcpError(null)
              invalidateMcpData()
            }}
            onLogin={async (name) => {
              setMcpServers(await window.xingmang.loginMcpServer(name))
              setMcpError(null)
              invalidateMcpData()
            }}
            onLogout={async (name) => {
              setMcpServers(await window.xingmang.logoutMcpServer(name))
              setMcpError(null)
              invalidateMcpData()
            }}
          />
        ) : activePage === 'skills' ? (
          <SkillsPage
            skills={skills}
            loading={skillsLoading}
            error={skillsError}
            repositoryAvailable={Boolean(repositoryContext.repositoryRoot)}
            platform={platformCapabilities}
            onRefresh={refreshSkills}
            onImport={async (input: SkillImportRequest) => {
              setSkills(await window.xingmang.importSkill(input))
              setSkillsError(null)
              // 突变已经拿到权威结果，必须让任何仍在途的 refreshSkills() 失效，
              // 否则它稍后落地会用旧快照覆盖刚写入的数据。
              invalidateSkillsData()
            }}
            onToggle={async (skillPath, enabled) => {
              const { skills: next, rewriteNotice } = await window.xingmang.toggleSkill(skillPath, enabled)
              setSkills(next)
              setSkillsError(null)
              invalidateSkillsData()
              // 写回 config.toml 会重排序列化，用户手写注释可能丢失，必须让用户看到提示。
              if (rewriteNotice) setToast({ type: 'success', message: rewriteNotice })
            }}
            onUninstall={async (skillPath) => {
              const result = await window.xingmang.uninstallSkill(skillPath)
              setSkills(result.skills)
              setSkillsError(null)
              invalidateSkillsData()
              setToast({ type: 'success', message: 'Skill 已移动到应用回收站' })
            }}
          />
        ) : activePage === 'plugins' ? (
          <PluginsPage
            plugins={pluginCatalog.plugins}
            marketplaces={pluginCatalog.marketplaces}
            loading={pluginsLoading}
            error={pluginsError}
            onRefresh={refreshPlugins}
            onInstall={async (id) => {
              setPluginCatalog(await window.xingmang.addPlugin(id))
              setPluginsError(null)
              // 突变已经拿到权威结果，必须让任何仍在途的 refreshPlugins() 失效，
              // 否则它稍后落地会用旧快照覆盖刚写入的数据。
              invalidatePluginsData()
            }}
            onRemove={async (id) => {
              setPluginCatalog(await window.xingmang.removePlugin(id))
              setPluginsError(null)
              invalidatePluginsData()
            }}
            onToggle={async (id, enabled) => {
              const catalog = await window.xingmang.togglePlugin(id, enabled)
              // 写回 config.toml 会重排序列化，用户手写注释可能丢失，必须让用户看到提示。
              if (catalog.rewriteNotice) setToast({ type: 'success', message: catalog.rewriteNotice })
              setPluginCatalog(catalog)
              setPluginsError(null)
              invalidatePluginsData()
            }}
            onAddMarketplace={async (input: MarketplaceCreateRequest) => {
              setPluginCatalog(await window.xingmang.addMarketplace(input))
              setPluginsError(null)
              invalidatePluginsData()
            }}
            onUpgradeMarketplace={async (name) => {
              setPluginCatalog(await window.xingmang.upgradeMarketplace(name))
              setPluginsError(null)
              invalidatePluginsData()
            }}
            onRemoveMarketplace={async (name) => {
              setPluginCatalog(await window.xingmang.removeMarketplace(name))
              setPluginsError(null)
              invalidatePluginsData()
            }}
          />
        ) : activePage === 'backups' ? (
          <BackupsPage api={backupsApi} />
        ) : activePage === 'health' ? (
          <HealthPage api={healthApi} initialReport={healthReport} />
        ) : activePage === 'maintenance' ? (
          <MaintenancePage api={maintenanceApi} platform={platformCapabilities} />
        ) : activePage === 'feedback' ? (
          <FeedbackPage api={window.xingmang} notify={setToast} />
        ) : activePage === 'updates' ? (
          <UpdatePage
            state={updateState}
            busy={updateBusy}
            onCheck={() => void runUpdateAction(() => window.xingmang.checkForUpdates())}
            onDownload={() => void runUpdateAction(() => window.xingmang.downloadUpdate())}
            onInstall={() => void runUpdateAction(() => window.xingmang.installUpdate())}
          />
        ) : activePage === 'settings' ? (
          <SettingsPage
            value={persistedSettings}
            onSave={saveSettings}
            onThemePreview={(next) => {
              setTheme(next)
              // 设置页的 draft 以 settings 为基准，主题双通道必须同步，否则保存设置会把主题回退。
              setSettings((current) => current.theme === next ? current : { ...current, theme: next })
            }}
            onReplayOnboarding={() => {
              setOnboardingAutoStart(false)
              setAppView('onboarding')
            }}
          />
        ) : activePage === 'tutorial' ? (
          <TutorialPage
            onNavigate={setActivePage}
            onOpenAccountCenter={() => { setAccountCenterSection('overview'); setAppView('account-center') }}
            onOpenSupport={() => {
              setSupportDialogOpen(true)
            }}
          />
        ) : (
          <PlaceholderPage pageId={activePage} />
        )}
        </ErrorBoundary>
      </main>

      {configOpen && (
        <ConfigDialog
          platform={platformCapabilities}
          activeTab={activeConfigTab}
          config={config}
          snapshot={snapshot}
          relaySite={activeRelaySite}
          accountAuthenticated={Boolean(accountSession?.authenticated)}
          onConfigChange={setConfig}
          onSettingsChange={setSettings}
          onClose={() => setConfigOpen(false)}
          notify={setToast}
          awaitCliReady={cliReadyGate.ready}
        />
      )}

      {codexLaunchDialogOpen && (
        <CodexLaunchDialog
          accountSource={providerAccountSource(config?.providers.codex)}
          onSelect={(mode) => void performCodexDesktopLaunch(mode)}
          onCancel={() => setCodexLaunchDialogOpen(false)}
        />
      )}

      {codexInstallDialogOpen && (
        presentation.showDesktopMirror &&
        <CodexDesktopInstallSourceDialog
          installedVersion={snapshot.desktopApps.codex.version}
          latestVersion={snapshot.desktopApps.codex.latestVersion}
          mirrorVersion={snapshot.desktopApps.codex.mirrorVersion}
          mirrorUpdateAvailable={snapshot.desktopApps.codex.mirrorUpdateAvailable}
          mirrorError={snapshot.desktopApps.codex.mirrorError}
          onInstall={() => {
            setCodexInstallDialogOpen(false)
            void installCodexDesktop()
          }}
          onOpenStore={() => {
            setCodexInstallDialogOpen(false)
            void window.xingmang.openExternal(CODEX_DESKTOP_STORE_URI)
              .catch((error) => setToast({ type: 'error', message: errorMessage(error) }))
          }}
          onCancel={() => setCodexInstallDialogOpen(false)}
        />
      )}

      {nodeGuideOpen && (
        <NodeInstallGuide
          runtime={snapshot.runtime}
          platform={platformCapabilities}
          busy={nodeRuntimeInstalling}
          scanning={scanning}
          installProgress={nodeRuntimeInstallProgress}
          onClose={() => setNodeGuideOpen(false)}
          onInstall={() => void installNodeRuntime()}
          onRecheck={() => {
            setNodeGuideOpen(false)
            void scan(true)
          }}
        />
      )}

      {pythonInstallConfirmOpen && !pythonRuntimeInstalling && (
        <PythonInstallConfirmDialog
          onCancel={() => setPythonInstallConfirmOpen(false)}
          onConfirm={() => {
            setPythonInstallConfirmOpen(false)
            void installPythonRuntime()
          }}
        />
      )}

      {accountDialog === 'login' && rememberedLoginReady && (
        <LoginDialog
          onClose={() => setAccountDialog(null)}
          onSwitchToRegister={() => setAccountDialog('register')}
          onSubmit={(values) => void handleAccountLoginSubmit(values)}
          onForgotPassword={() => setAccountDialog('forgot-password')}
          initialIdentifier={loginDialogSeed().identifier}
          initialPassword={loginDialogSeed().password}
          initialRemember={loginDialogSeed().remember}
          isSubmitting={accountBusy}
        />
      )}

      {accountDialog === 'register' && (
        <RegisterDialog
          onClose={() => setAccountDialog(null)}
          onSwitchToLogin={() => setAccountDialog('login')}
          onSubmit={(values) => void handleAccountRegisterSubmit(values)}
          onRequestVerificationCode={handleRequestVerificationCode}
          isSubmitting={accountBusy}
        />
      )}

      {accountDialog === 'forgot-password' && (
        <ForgotPasswordDialog
          onClose={() => { setAccountDialog(null); setAccountResetOutcome(null) }}
          onSwitchToLogin={() => setAccountDialog('login')}
          onSubmit={(values) => void handleForgotPasswordSubmit(values)}
          onRequestResetCode={handleSendPasswordResetCode}
          onDone={handleForgotPasswordDone}
          isSubmitting={accountBusy}
          resetResult={accountResetOutcome}
        />
      )}

      {provisioningTargets && (
        <ProvisioningConfirmDialog
          targets={provisioningTargets}
          busy={provisioningBusy}
          onConfirm={(selected) => void confirmCliProvisioning(selected)}
          onSkip={skipCliProvisioning}
        />
      )}
      {provisioningRetryTargets && !provisioningTargets && (
        <ProvisioningConfirmDialog
          targets={provisioningRetryTargets}
          onConfirm={(selected) => {
            setProvisioningRetryTargets(null)
            void confirmCliProvisioning(selected)
          }}
          onSkip={() => setProvisioningRetryTargets(null)}
        />
      )}

      {pasteKeyTargets && (
        <PasteKeyDialog
          targets={pasteKeyTargets}
          keysPageUrl={activeRelaySite.keysPageUrl}
          busy={pasteKeyBusy}
          onConfirm={(key, selected) => void confirmPasteKeyProvisioning(key, selected)}
          onOpenKeysPage={(url) => {
            void window.xingmang.openExternal(url).catch((error: unknown) => {
              setToast({ type: 'error', message: errorMessage(error) })
            })
          }}
          onCancel={cancelPasteKeyProvisioning}
        />
      )}

      {logOpen && (
        <div className="log-drawer" role="status" aria-live="polite">
          <div className="log-header">
            <div><CircleDot size={15} /> 安装日志</div>
            <button className="icon-button compact" title="关闭日志" aria-label="关闭日志" onClick={() => setLogOpen(false)}><X size={16} /></button>
          </div>
          <pre>{installLog.length ? installLog.join('\n') : '等待安装任务...'}</pre>
        </div>
      )}

      {toast && (
        <Toast
          toast={toast}
          onDismiss={() => setToast(null)}
          onCopy={toast.type === 'error' ? copyToastMessage : undefined}
        />
      )}
    </div>
    </AppFrame>
  )
}

export default App
