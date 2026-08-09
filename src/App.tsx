import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleDot, X } from 'lucide-react'
import { AppFrame } from './components/AppFrame'
import { LoginDialog } from './components/account/LoginDialog'
import { RegisterDialog } from './components/account/RegisterDialog'
import { ProvisioningConfirmDialog } from './components/account/ProvisioningConfirmDialog'
import { resolveAccountErrorMessage } from './components/account/account-errors'
import { resolveAccountAreaStatus } from './components/account/account-stub'
import { resolveAccountSnapshot } from './components/account/account-session'
import {
  buildProvisioningTargets,
  provisionCliKeyForInstalledClis,
  resolveCliProvisioningGate,
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
  const [accountDialog, setAccountDialog] = useState<'login' | 'register' | null>(null)
  const [accountBusy, setAccountBusy] = useState(false)
  // Pre-fills LoginDialog's identifier field right after a successful
  // registration (new-api's POST /api/user/register returns no token/session
  // to auto-login with -- see handleAccountRegisterSubmit below), so the
  // user only has to retype their password. Only ever set from a real
  // successful register() call, never from mere form input, so a dialog the
  // user closes without submitting can never leak a fake prefill into a
  // later, unrelated login.
  const [accountLoginPrefill, setAccountLoginPrefill] = useState('')
  // "写入星芒 Key" 确认弹窗（阶段 A 加固）：登录/注册成功后，若已装 CLI 非空，
  // 把候选列表放进这里而不是直接写入；null = 弹窗不显示。见 offerCliProvisioning。
  const [provisioningTargets, setProvisioningTargets] = useState<ProviderId[] | null>(null)
  const [provisioningBusy, setProvisioningBusy] = useState(false)
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
  const persistedSettings = useMemo(() => settings, [
    settings.version,
    settings.workspace,
    settings.theme,
    settings.checkUpdatesOnStartup,
    settings.runDiagnosticsOnStartup,
  ])
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
  }, [pageDataTracker, scanTracker])

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
        onSnapshot: setSnapshot,
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
  }, [scanTracker, cliReadyGate])

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
    // SettingsPage's own draft type doesn't know about sidebarMoreExpanded
    // (it has no UI for it), so its submitted object can be stale relative to
    // the sidebar's own toggle. Re-stamp the live value here rather than
    // trusting the round trip, so an unrelated "保存设置" click never reverts
    // a "更多" expand/collapse made while the Settings page was open.
    const saved = await window.xingmang.saveSettings({ ...next, sidebarMoreExpanded: settings.sidebarMoreExpanded })
    // Commit the persisted settings before refreshing derived data. A failure
    // below must not make a completed save look like a rejected one.
    setSettings(saved)
    setTheme(saved.theme)
    try {
      setRepositoryContext(await window.xingmang.getRepositoryContext())
      setToast({ type: 'success', message: '设置已保存' })
    } catch (error) {
      setToast({ type: 'error', message: `设置已保存，但工作目录信息刷新失败：${errorMessage(error)}` })
    }
  }, [settings.sidebarMoreExpanded])

  const toggleSidebarMoreExpanded = useCallback(() => {
    setSettings((current) => {
      const next = !current.sidebarMoreExpanded
      void window.xingmang.saveSettings({ ...current, sidebarMoreExpanded: next })
        .then(setSettings)
        .catch(() => {
          // "更多" 的展开态只是便利性 UI 偏好，持久化失败不影响当次会话内的展开/折叠。
        })
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
        if (!codexReady) {
          // account:get-session is awaited alongside the config read here --
          // not left to the separate mount-only effect further down (which
          // still owns hydrating accountSession/accountBalance for the
          // sidebar) -- because the welcome/onboarding gate right below must
          // never decide before it knows whether this is an authenticated
          // returning user. main.ts's accountSessionReady guarantee (see
          // ipc.ts's account:get-session handler doc comment) means this
          // call only resolves once any startup session restore has already
          // settled, so there is no earlier "unknown" window to race here.
          // A rejection falls back to "not authenticated" rather than
          // aborting startup -- resolveInitialAppView then applies the
          // pre-existing config-only rule, same as before accounts existed.
          // Scoped to this branch alone (not hoisted above the codexReady
          // check) so the already-fully-configured fast path straight to
          // 'dashboard' below never waits on it.
          const [latestConfig, startupAccountSession] = await Promise.all([
            loadConfig(),
            window.xingmang.getAccountSession().catch(() => null),
          ])
          if (!active) return
          setScanning(false)
          setAppView(resolveInitialAppView(latestConfig, startupAccountSession?.authenticated ?? false, previewOnboarding))
          return
        }
        setAppView('dashboard')
        void scan()
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
    // 'dashboard' — welcome has no window size of its own because it's
    // designed to fill the same 1340x845 canvas as the dashboard, so it
    // rides the 'dashboard' mode rather than growing a third IPC-level mode.
    const windowMode = appView === 'welcome' ? 'dashboard' : appView
    void window.xingmang.setWindowMode(windowMode).catch(() => {
      // Window sizing should not block configuration or tool access.
    })
  }, [appView])

  useEffect(() => {
    if (appView !== 'dashboard' || activePage !== 'overview') return
    const refreshCodexDesktopStatus = async () => {
      if (document.hidden) return
      try {
        const status = await window.xingmang.getCodexDesktopStatus()
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
  }, [activePage, appView])

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
      setSnapshot((current) => ({
        ...current,
        desktopApps: { ...current.desktopApps, codex: event.status },
      }))
      setCodexLaunchPhase(event.phase === 'stopped' ? 'opening' : 'idle')
    })
  }, [])

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
  // I3：明文 Key 只活在 provisionCliKeyForInstalledClis 的局部作用域里，绝不
  // 经过这里的任何 useState。`selected` 由 ProvisioningConfirmDialog 勾选后给出
  // ——已经是用户确认过的子集，这里不再重新读 snapshot。
  const runCliProvisioning = async (selected: readonly ProviderId[]) => {
    if (selected.length === 0) return
    const preferredModels = Object.fromEntries(
      providerIds.map((id) => [id, config?.providers[id]?.model || undefined]),
    ) as Partial<Record<ProviderId, string>>
    try {
      const outcome = await provisionCliKeyForInstalledClis(selected, preferredModels, window.xingmang)
      if (outcome.configured.length > 0) setConfig(await window.xingmang.getConfig())
      if (outcome.configured.length > 0 && outcome.failed.length === 0) {
        setToast({ type: 'success', message: `已把星芒 Key 配置到 ${outcome.configured.length} 个 CLI` })
      } else if (outcome.configured.length > 0) {
        const failedNames = outcome.failed.map((entry) => providers[entry.provider].name).join('、')
        setToast({
          type: 'error',
          message: `已配置 ${outcome.configured.length} 个 CLI；${failedNames} 配置失败，可到“CLI 配置”页手动重试`,
        })
      } else if (outcome.failed.length > 0) {
        setToast({ type: 'error', message: `星芒 Key 未能配置到所选 CLI：${outcome.failed[0].message}` })
      }
    } catch (error) {
      setToast({ type: 'error', message: `星芒 Key 签发失败：${errorMessage(error)}` })
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

  const handleRequestVerificationCode = async (email: string) => {
    try {
      await window.xingmang.sendVerificationCode(email)
      setToast({ type: 'success', message: '验证码已发送至邮箱' })
    } catch (error) {
      setToast({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
    }
  }

  // identifier may be either a username or an email address -- new-api's
  // Login handler matches either (see LoginDialog.tsx's own comment), and
  // its request field is always literally named `username` regardless of
  // which kind of value it holds.
  const handleAccountLoginSubmit = async (values: { identifier: string; password: string }) => {
    if (accountBusyRef.current) return
    accountBusyRef.current = true
    setAccountBusy(true)
    try {
      await window.xingmang.loginAccount({ username: values.identifier, password: values.password })
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
      setSettings((current) => savedSettings.theme === current.theme
        ? savedSettings
        : { ...savedSettings, theme: current.theme })
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
        {accountDialog === 'login' && (
          <LoginDialog
            onClose={() => setAccountDialog(null)}
            onSwitchToRegister={() => setAccountDialog('register')}
            onSubmit={(values) => void handleAccountLoginSubmit(values)}
            initialIdentifier={accountLoginPrefill}
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

  return (
    <AppFrame theme={theme} platform={platformCapabilities}>
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <Sidebar
        activePage={activePage}
        collapsed={sidebarCollapsed}
        theme={theme}
        updateState={updateState}
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
        onRecharge={() => setToast({ type: 'success', message: '充值功能即将开放' })}
        onConfigureCliKey={handleConfigureCliKey}
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
              pageDataTracker.invalidate('mcp')
            }}
            onRemove={async (name) => {
              setMcpServers(await window.xingmang.removeMcpServer(name))
              setMcpError(null)
              pageDataTracker.invalidate('mcp')
            }}
            onLogin={async (name) => {
              setMcpServers(await window.xingmang.loginMcpServer(name))
              setMcpError(null)
              pageDataTracker.invalidate('mcp')
            }}
            onLogout={async (name) => {
              setMcpServers(await window.xingmang.logoutMcpServer(name))
              setMcpError(null)
              pageDataTracker.invalidate('mcp')
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
              pageDataTracker.invalidate('skills')
            }}
            onToggle={async (skillPath, enabled) => {
              const { skills: next, rewriteNotice } = await window.xingmang.toggleSkill(skillPath, enabled)
              setSkills(next)
              setSkillsError(null)
              pageDataTracker.invalidate('skills')
              // 写回 config.toml 会重排序列化，用户手写注释可能丢失，必须让用户看到提示。
              if (rewriteNotice) setToast({ type: 'success', message: rewriteNotice })
            }}
            onUninstall={async (skillPath) => {
              const result = await window.xingmang.uninstallSkill(skillPath)
              setSkills(result.skills)
              setSkillsError(null)
              pageDataTracker.invalidate('skills')
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
              pageDataTracker.invalidate('plugins')
            }}
            onRemove={async (id) => {
              setPluginCatalog(await window.xingmang.removePlugin(id))
              setPluginsError(null)
              pageDataTracker.invalidate('plugins')
            }}
            onToggle={async (id, enabled) => {
              const catalog = await window.xingmang.togglePlugin(id, enabled)
              // 写回 config.toml 会重排序列化，用户手写注释可能丢失，必须让用户看到提示。
              if (catalog.rewriteNotice) setToast({ type: 'success', message: catalog.rewriteNotice })
              setPluginCatalog(catalog)
              setPluginsError(null)
              pageDataTracker.invalidate('plugins')
            }}
            onAddMarketplace={async (input: MarketplaceCreateRequest) => {
              setPluginCatalog(await window.xingmang.addMarketplace(input))
              setPluginsError(null)
              pageDataTracker.invalidate('plugins')
            }}
            onUpgradeMarketplace={async (name) => {
              setPluginCatalog(await window.xingmang.upgradeMarketplace(name))
              setPluginsError(null)
              pageDataTracker.invalidate('plugins')
            }}
            onRemoveMarketplace={async (name) => {
              setPluginCatalog(await window.xingmang.removeMarketplace(name))
              setPluginsError(null)
              pageDataTracker.invalidate('plugins')
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

      {accountDialog === 'login' && (
        <LoginDialog
          onClose={() => setAccountDialog(null)}
          onSwitchToRegister={() => setAccountDialog('register')}
          onSubmit={(values) => void handleAccountLoginSubmit(values)}
          initialIdentifier={accountLoginPrefill}
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

      {provisioningTargets && (
        <ProvisioningConfirmDialog
          targets={provisioningTargets}
          busy={provisioningBusy}
          onConfirm={(selected) => void confirmCliProvisioning(selected)}
          onSkip={skipCliProvisioning}
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
