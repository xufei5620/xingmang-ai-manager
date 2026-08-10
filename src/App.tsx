import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleDot, X } from 'lucide-react'
import { AppFrame } from './components/AppFrame'
import { LoginDialog } from './components/account/LoginDialog'
import { RegisterDialog } from './components/account/RegisterDialog'
import { ForgotPasswordDialog } from './components/account/ForgotPasswordDialog'
import { ProvisioningConfirmDialog } from './components/account/ProvisioningConfirmDialog'
import { PasteKeyDialog } from './components/account/PasteKeyDialog'
import { AccountCenterPage } from './components/account/AccountCenterPage'
import { resolveAccountErrorMessage } from './components/account/account-errors'
import { WALLET_URL } from './components/account/account-center'
import { resolveAccountAreaStatus, shouldShowManualKeyEntry } from './components/account/account-stub'
import { resolveAccountSnapshot } from './components/account/account-session'
import {
  buildProvisioningTargets,
  provisionCliKeyForInstalledClis,
  resolveCliProvisioningGate,
  writeCliKeyForInstalledClis,
} from './account-provisioning'
import {
  codexDesktopInstallActive,
  codexDesktopLaunchDecision,
  commitStartupPlatformCapabilities,
  EmptyStatus,
  initialOnboardingPreview,
  initialSidebarCollapsed,
  initialTheme,
  isDetectionFailed,
  resolveInitialAppView,
  sameDesktopStatus,
  SIDEBAR_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type AppView,
  type StartupStage,
  type ThemeMode,
} from './app-shared'
import { providers, type ConfigTabId } from './provider-meta'
import { errorMessage } from './error-message'
import { CodexLaunchDialog } from './components/config/CodexLaunchDialog'
import { ConfigDialog } from './components/config/ConfigDialog'
import { Dashboard } from './components/dashboard/Dashboard'
import { ErrorBoundary } from './components/ErrorBoundary'
import { CodexOnboarding } from './components/onboarding/CodexOnboarding'
import { NodeInstallGuide } from './components/onboarding/NodeInstallGuide'
import { Sidebar } from './components/Sidebar'
import { WelcomePage } from './components/welcome/WelcomePage'
import { StartupSplash } from './components/StartupSplash'
import { Toast, type ToastMessage } from './components/Toast'
import type { PageId } from './navigation'
import { nodeRuntimeSupported } from './onboarding-runtime'
import { PlaceholderPage } from './pages/PlaceholderPage'
import { BackupsPage } from './pages/BackupsPage'
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
import {
  providerIds,
  resolveRelaySite,
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

function App() {
  const [theme, setTheme] = useState<ThemeMode>(initialTheme)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed)
  const [activePage, setActivePage] = useState<PageId>('overview')
  const [platformCapabilities, setPlatformCapabilities] = useState<PlatformCapabilities>(() => {
    document.documentElement.dataset.platform = failClosedPlatformCapabilities.platform
    return failClosedPlatformCapabilities
  })
  const [appView, setAppView] = useState<AppView>('loading')
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
  // Codex CLI resolution (mcp/plugins/model list) races ahead of the first
  // environment scan if fired the instant the dashboard becomes navigable;
  // see startup-gate.ts. Settled once, in `scan`, below.
  const cliReadyGate = useRef(createStartupGate()).current
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
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

  const maintenanceApi = useMemo(() => ({
    scan: async (forceRefresh = false) => {
      const result = await scan(forceRefresh)
      const next = result.snapshot ?? snapshotRef.current
      return {
        checkedAt: next.checkedAt,
        clis: next.clis,
        codexDesktop: next.desktopApps.codex,
      }
    },
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
      return window.xingmang.installCodexDesktop()
    },
    uninstallCodexDesktop: async () => window.xingmang.uninstallCodexDesktop(),
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
    setSettings((current) => {
      const next = !current.sidebarMoreExpanded
      // 只发窄更新（①栏11）：载荷仅携带本次交互的真实意图，哪怕设置页的
      // 全量保存正在途中，两笔写入无论先后落盘都互不覆盖对方的字段。
      // 不用响应结果回填 setSettings：极快连点时慢响应可能晚于快响应落地，
      // 用旧值覆盖刚设好的乐观状态，会让侧边栏"更多"展开态出现瞬时闪跳。
      // 这里的乐观值已经是本次交互的真实意图，持久化失败也不影响当次会话
      // 内的展开/折叠，下次切换会带着最新状态重新保存、自愈。
      void window.xingmang.saveSettings({ version: 2, sidebarMoreExpanded: next }).catch(() => {})
      return { ...current, sidebarMoreExpanded: next }
    })
  }, [])

  useEffect(() => {
    let active = true
    let unsubscribeStartupUpdate: (() => void) | null = null
    let cancelStartupWait: (() => void) | null = null
    const initialize = async () => {
      try {
        await commitStartupPlatformCapabilities(
          () => window.xingmang.getPlatformCapabilities(),
          (capabilities) => {
            if (!active) return
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
        const codexReadiness = await window.xingmang.getCodexReadiness()
        if (!active) return
        const codexReady = codexReadiness.hasApiKey && codexReadiness.matchesRelay
        // account:get-session is awaited ahead of BOTH startup destinations
        // now -- 登录先行(老板拍板 2026-08-10):账号站点上未登录时,即使
        // 四个 CLI 早已配置齐全也不再直进工作台,先到欢迎页登录/注册,
        // 登录成功后 handleAccountLoginSubmit 才转工作台并触发自动写 Key。
        // 快速通道因此必须先知道登录态,旧的"只在 !codexReady 分支里读
        // session"的作用域优化不再成立。main.ts 的 accountSessionReady
        // 保证(见 ipc.ts account:get-session 的 doc comment)使这次读取
        // 不会撞上启动恢复的中间态;读取失败一律按未登录处理——宁可多要求
        // 登录一次,不能把未登录用户放进工作台。relaySiteId 直接复用上面
        // 已读进闭包的 startupSettings,不再重复读一次设置。
        const startupAccountSession = await window.xingmang.getAccountSession().catch(() => null)
        if (!active) return
        const authenticated = startupAccountSession?.authenticated ?? false
        const manualKeySite = shouldShowManualKeyEntry(
          resolveRelaySite(startupSettings?.relaySiteId).accountBackend,
        )
        if (codexReady && (authenticated || manualKeySite)) {
          setAppView('dashboard')
          void scan()
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
    // own because both are designed to fill the same 1340x845 canvas as the
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

  // 阶段 A 核心价值链「拿 Key → 写进 CLI 配置」：签发一个新 Key，写进调用方给定
  // 的 CLI 子集（复用 config-files.ts 既有两阶段提交写入路径，不新写落盘逻辑）。
  // I3：明文 Key 只活在 provisionCliKeyForInstalledClis/writeCliKeyForInstalledClis
  // 的局部作用域里，绝不经过这里的任何 useState。`selected` 由
  // ProvisioningConfirmDialog/PasteKeyDialog 勾选后给出——已经是用户确认过的
  // 子集，这里不再重新读 snapshot。
  //
  // `suppliedKey` 是 W3b 加的第二条路径：manual-key 站点没有账号服务可签发
  // Key，PasteKeyDialog 把用户粘贴的值直接交过来，写入逻辑与账号签发的 Key
  // 完全复用同一条 writeCliKeyForInstalledClis（config:save 两阶段提交），
  // 只是跳过 provisionCliKey() 这一步。
  const runCliProvisioning = async (selected: readonly ProviderId[], suppliedKey?: string) => {
    if (selected.length === 0) return
    const preferredModels = Object.fromEntries(
      providerIds.map((id) => [id, config?.providers[id]?.model || undefined]),
    ) as Partial<Record<ProviderId, string>>
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
        ? await writeCliKeyForInstalledClis(suppliedKey, selected, preferredModels, window.xingmang)
        : await provisionCliKeyForInstalledClis(selected, preferredModels, window.xingmang)
      // 写入已经落盘成功，这里只是刷新配置摘要。刷新失败不能落进外层 catch
      // 把结论反转成"写入失败"——那与磁盘上的事实完全相反。
      let refreshFailed = false
      if (outcome.configured.length > 0) {
        try {
          setConfig(await window.xingmang.getConfig())
        } catch {
          refreshFailed = true
        }
      }
      if (outcome.configured.length > 0 && outcome.failed.length === 0) {
        setToast(refreshFailed
          ? { type: 'error', message: `已把${keyLabel}配置到 ${outcome.configured.length} 个 CLI，但状态刷新失败；请到概览页重新检测` }
          : { type: 'success', message: `已把${keyLabel}配置到 ${outcome.configured.length} 个 CLI` })
      } else if (outcome.configured.length > 0) {
        const failedNames = outcome.failed.map((entry) => providers[entry.provider].name).join('、')
        setToast({
          type: 'error',
          message: `已配置 ${outcome.configured.length} 个 CLI；${failedNames} 配置失败，可到“CLI 配置”页手动重试`,
        })
      } else if (outcome.failed.length > 0) {
        setToast({ type: 'error', message: `${keyLabel}未能配置到所选 CLI：${outcome.failed[0].message}` })
      }
    } catch (error) {
      setToast({ type: 'error', message: `${keyLabel}${suppliedKey ? '写入' : '签发'}失败：${errorMessage(error)}` })
    }
  }

  // 登录/注册成功后调用：把已装 CLI 列表交给确认弹窗，由用户勾选后再真正写入
  // （阶段 A 加固，见 ProvisioningConfirmDialog.tsx）。没有已装 CLI 时不打扰
  // 用户，直接跳过——原静默写入在“没有可写对象”这一分支上的行为保持不变。
  const offerCliProvisioning = (snapshot: SystemSnapshot = snapshotRef.current) => {
    const targets = buildProvisioningTargets(snapshot)
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
  const handleConfigureCliKey = () => {
    // manual-key 站点没有账号登录/签发能力，「一键配置」必须导向粘贴 Key，
    // 否则会走到 offerCliProvisioning 的账号签发路径：未登录时弹出该站点根本
    // 用不到的星芒登录框，已登录（切站前在账号站登录过、未登出）时更糟——向
    // 账号站签发 Key 再写进当前 manual-key 站点的 CLI 配置，构成跨站点凭据混线。
    if (shouldShowManualKeyEntry(activeRelaySite.accountBackend)) {
      handleOpenPasteKeyDialog()
      return
    }
    const gate = resolveCliProvisioningGate(Boolean(accountSession?.authenticated), snapshotRef.current)
    if (gate === 'requires-login') {
      setAccountDialog('login')
      setToast({ type: 'error', message: '请先登录星芒账号，再一键配置 Key' })
      return
    }
    if (gate === 'requires-install') {
      setToast({ type: 'error', message: '请先安装一个 AI 工具，再配置星芒 Key' })
      return
    }
    offerCliProvisioning()
  }

  // 粘贴 Key 弹窗的打开入口（W3b，AccountArea 的 manual-key 分支按钮）。不需要
  // resolveCliProvisioningGate 的登录检查——manual-key 站点本来就没有账号
  // 登录态；唯一的前置条件是至少装了一个 CLI，否则弹窗打开了也没有勾选对象。
  const handleOpenPasteKeyDialog = async () => {
    let targets = buildProvisioningTargets(snapshotRef.current)
    if (targets.length === 0 && scanning) {
      // 启动路径先进工作台再扫描，首扫落地前 snapshot 还是全未安装的占位。
      // 这是 manual-key 站点唯一的配 Key 入口，直接报"未安装"是谎报——等
      // 扫描结果（scan 经 T6 协调器合并并发调用），与账号路径把
      // scanResult.snapshot 显式传给 offerCliProvisioning 是同一种处理。
      const scanResult = await scan()
      targets = buildProvisioningTargets(scanResult.snapshot ?? snapshotRef.current)
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

  // identifier may be either a username or an email address -- new-api's
  // Login handler matches either (see LoginDialog.tsx's own comment), and
  // its request field is always literally named `username` regardless of
  // which kind of value it holds.
  const handleAccountLoginSubmit = async (values: { identifier: string; password: string; remember: boolean }) => {
    if (accountBusyRef.current) return
    accountBusyRef.current = true
    setAccountBusy(true)
    try {
      await window.xingmang.loginAccount({ username: values.identifier, password: values.password })
      // 只在登录确实成功后才落盘「记住密码」;勾选取消则清除已存凭据。
      // 失败静默:记不住密码不该打断刚成功的登录。
      void window.xingmang.setRememberedAccountLogin(
        values.remember ? { identifier: values.identifier, password: values.password } : null,
      ).catch(() => undefined)
      const account = await refreshAccountSession()
      setAccountDialog(null)
      setAccountLoginPrefill('')
      setToast({ type: 'success', message: account ? `欢迎回来，${account.username}` : '登录成功' })
      // 登录成功即离开欢迎页进入工作台，并跑一次环境扫描——欢迎页那条启动
      // 路径不扫描，snapshot 为空会让写 Key 弹窗拿不到已装 CLI。用扫到的
      // 快照直接触发，避免 snapshotRef 尚未随渲染更新。
      setAppView('dashboard')
      const scanResult = await scan()
      offerCliProvisioning(scanResult.snapshot ?? snapshotRef.current)
    } catch (error) {
      setToast({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
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
      })
      // new-api's POST /api/user/register replies with only {success,
      // message} -- no token, no session (confirmed by reading
      // QuantumNous/new-api's controller/user.go Register handler; see
      // NewApiRegisterInput's comment in electron/new-api-client.ts). The
      // official web frontend itself shows a success toast and redirects to
      // sign-in rather than auto-logging in, so this mirrors that instead of
      // chaining a second network call the server was never going to hand a
      // session for: show clear success feedback, then hand off to
      // LoginDialog with the just-registered username pre-filled so the
      // user only has to type their password once more.
      setAccountDialog('login')
      setAccountLoginPrefill(values.username)
      setToast({ type: 'success', message: '注册成功，请登录' })
    } catch (error) {
      setToast({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
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
  const handleAccountLogout = async () => {
    if (accountBusyRef.current) return
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
    } catch (error) {
      setToast({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
    } finally {
      accountBusyRef.current = false
      setAccountBusy(false)
    }
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
        message: refreshed.snapshot
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
      if (showToast) {
        setToast({ type: 'success', message: `${providers[provider].name} ${updating ? '更新' : '安装'}完成` })
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
      if (!providerConfig.hasApiKey || !providerConfig.matchesRelay) {
        setActiveConfigTab(provider)
        setConfigOpen(true)
        setToast({
          type: 'error',
          message: `${providers[provider].name} 尚未配置星芒 AI，请先完成配置`,
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
      if (!codexConfig.hasApiKey || !codexConfig.matchesRelay) {
        setActiveConfigTab('codexDesktop')
        setConfigOpen(true)
        setToast({ type: 'error', message: 'Codex 尚未配置星芒 AI，请先完成配置' })
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

  const finishOnboarding = async () => {
    setInstallLog([])
    setLogOpen(false)
    setAppView('dashboard')
    void scan()
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
        theme={theme}
        onToggleTheme={() => {
          const next = theme === 'light' ? 'dark' : 'light'
          setTheme(next)
          // 设置页的 draft 以 settings 为基准，主题双通道必须同步，否则保存设置会把主题回退。
          setSettings((current) => current.theme === next ? current : { ...current, theme: next })
        }}
        onConfigChange={setConfig}
        onComplete={finishOnboarding}
        onCancel={() => setAppView('dashboard')}
        desktopInstallProgress={codexDesktopInstallProgress}
        platform={platformCapabilities}
      />
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
        updateState={updateState}
        relaySite={activeRelaySite}
        moreExpanded={Boolean(settings.sidebarMoreExpanded)}
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
        onRecharge={() => {
          // Same destination and same "opens in the system browser, desktop
          // session never travels there" reasoning as the 个人中心充值 Tab's
          // own openWallet (AccountCenterPage.tsx) -- href already
          // allowlisted in electron/main.ts (I12).
          void window.xingmang.openExternal(WALLET_URL).catch((error: unknown) => {
            setToast({ type: 'error', message: errorMessage(error) })
          })
        }}
        onConfigureCliKey={handleConfigureCliKey}
        onOpenAccountCenter={() => setAppView('account-center')}
        onPasteKey={handleOpenPasteKeyDialog}
        onOpenKeysPage={() => {
          // Same "opens in the system browser" reasoning as onRecharge above
          // -- href already I12 allowlisted via relaySiteExternalUrls
          // (electron/main.ts).
          void window.xingmang.openExternal(activeRelaySite.keysPageUrl).catch((error: unknown) => {
            setToast({ type: 'error', message: errorMessage(error) })
          })
        }}
      />

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
            runtimeReady={runtimeReady}
            installedCliCount={installedCliCount}
            installedToolCount={installedToolCount}
            nextStepsNudge={{ triedLaunch: nextStepsTriedLaunch, exploredMcp: nextStepsExploredMcp }}
            onScan={() => void scan(true)}
            onInstallNode={() => void installNodeRuntime()}
            onOpenNodeGuide={() => setNodeGuideOpen(true)}
            onInstall={(provider) => void install(provider)}
            onInstallAll={() => void installAll()}
            onConfigure={openConfig}
            onConfigureCodexDesktop={openCodexDesktopConfig}
            onInstallCodexDesktop={() => setCodexInstallDialogOpen(true)}
            onLaunch={(provider) => void launch(provider)}
            onLaunchCodexDesktop={() => void requestCodexDesktopLaunch()}
            onNextStepsConfigureFirstCli={handleConfigureCliKey}
            manualKeySite={shouldShowManualKeyEntry(activeRelaySite.accountBackend)}
            onNextStepsTryLaunch={handleNextStepsTryLaunch}
            onNextStepsGoMaintenance={() => setActivePage('maintenance')}
            onNextStepsExploreMcp={handleNextStepsExploreMcp}
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
            onReplayOnboarding={() => setAppView('onboarding')}
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
          onConfigChange={setConfig}
          onClose={() => setConfigOpen(false)}
          notify={setToast}
          awaitCliReady={cliReadyGate.ready}
        />
      )}

      {codexLaunchDialogOpen && (
        <CodexLaunchDialog
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
