import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleDot, X } from 'lucide-react'
import { AppFrame } from './components/AppFrame'
import {
  codexDesktopInstallActive,
  codexDesktopLaunchDecision,
  commitStartupPlatformCapabilities,
  EmptyStatus,
  initialSidebarCollapsed,
  initialTheme,
  isDetectionFailed,
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
import { CodexOnboarding } from './components/onboarding/CodexOnboarding'
import { NodeInstallGuide } from './components/onboarding/NodeInstallGuide'
import { Sidebar } from './components/Sidebar'
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
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  // state 更新在同一帧内不可见，双击防重入必须用 ref 同步短路。
  const cliLaunchingRef = useRef(false)
  const codexLaunchRequestRef = useRef(false)
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
      const next = await window.xingmang.listMcpServers()
      if (pageDataTracker.isCurrent('mcp', requestId)) setMcpServers(next)
    } catch (error) {
      if (pageDataTracker.isCurrent('mcp', requestId)) setMcpError(errorMessage(error))
    } finally {
      if (pageDataTracker.isCurrent('mcp', requestId)) setMcpLoading(false)
    }
  }, [pageDataTracker])

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
      const next = await window.xingmang.listPlugins()
      if (pageDataTracker.isCurrent('plugins', requestId)) setPluginCatalog(next)
    } catch (error) {
      if (pageDataTracker.isCurrent('plugins', requestId)) setPluginsError(errorMessage(error))
    } finally {
      if (pageDataTracker.isCurrent('plugins', requestId)) setPluginsLoading(false)
    }
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
  }, [scanTracker])

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
    const saved = await window.xingmang.saveSettings(next)
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
          await loadConfig()
          if (!active) return
          setScanning(false)
          setAppView('onboarding')
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
    void window.xingmang.setWindowMode(appView).catch(() => {
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
        onNavigate={setActivePage}
        onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
        onToggleTheme={() => {
          const next = theme === 'light' ? 'dark' : 'light'
          setTheme(next)
          // 设置页的 draft 以 settings 为基准，主题双通道必须同步，否则保存设置会把主题回退。
          setSettings((current) => current.theme === next ? current : { ...current, theme: next })
        }}
      />

      <main className="main-content">
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
            }}
            onRemove={async (name) => {
              setMcpServers(await window.xingmang.removeMcpServer(name))
              setMcpError(null)
            }}
            onLogin={async (name) => {
              setMcpServers(await window.xingmang.loginMcpServer(name))
              setMcpError(null)
            }}
            onLogout={async (name) => {
              setMcpServers(await window.xingmang.logoutMcpServer(name))
              setMcpError(null)
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
            }}
            onToggle={async (skillPath, enabled) => {
              const { skills: next, rewriteNotice } = await window.xingmang.toggleSkill(skillPath, enabled)
              setSkills(next)
              setSkillsError(null)
              // 写回 config.toml 会重排序列化，用户手写注释可能丢失，必须让用户看到提示。
              if (rewriteNotice) setToast({ type: 'success', message: rewriteNotice })
            }}
            onUninstall={async (skillPath) => {
              const result = await window.xingmang.uninstallSkill(skillPath)
              setSkills(result.skills)
              setSkillsError(null)
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
            }}
            onRemove={async (id) => {
              setPluginCatalog(await window.xingmang.removePlugin(id))
              setPluginsError(null)
            }}
            onToggle={async (id, enabled) => {
              const catalog = await window.xingmang.togglePlugin(id, enabled)
              // 写回 config.toml 会重排序列化，用户手写注释可能丢失，必须让用户看到提示。
              if (catalog.rewriteNotice) setToast({ type: 'success', message: catalog.rewriteNotice })
              setPluginCatalog(catalog)
              setPluginsError(null)
            }}
            onAddMarketplace={async (input: MarketplaceCreateRequest) => {
              setPluginCatalog(await window.xingmang.addMarketplace(input))
              setPluginsError(null)
            }}
            onUpgradeMarketplace={async (name) => {
              setPluginCatalog(await window.xingmang.upgradeMarketplace(name))
              setPluginsError(null)
            }}
            onRemoveMarketplace={async (name) => {
              setPluginCatalog(await window.xingmang.removeMarketplace(name))
              setPluginsError(null)
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
            onThemePreview={setTheme}
          />
        ) : (
          <PlaceholderPage pageId={activePage} />
        )}
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
