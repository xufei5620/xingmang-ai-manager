import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  AppWindow,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileCheck2,
  FileWarning,
  FolderOpen,
  Globe2,
  LoaderCircle,
  MonitorDown,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Store,
  Terminal,
  X,
} from 'lucide-react'
import logoUrl from '../assets/icon.png'
import logoWhiteUrl from '../assets/icon-white.png'
import chatGptIconUrl from '../assets/brands/chatgpt.svg'
import claudeCodeIconUrl from '../assets/brands/claude-code.svg'
import geminiCliIconUrl from '../assets/brands/gemini-cli.svg'
import grokIconUrl from '../assets/brands/grok.svg'
import { AppFrame } from './components/AppFrame'
import { errorMessage } from './error-message'
import { DialogBackdrop } from './components/Dialog'
import { Sidebar, ThemeToggle } from './components/Sidebar'
import { Toast, type ToastMessage } from './components/Toast'
import type { PageId } from './navigation'
import {
  authorizeCodex,
  DEFAULT_CODEX_MODEL,
  installNodeAndPrepareCodexEnvironment,
  prepareCodexEnvironment,
  type CodexSetupResult,
  type OnboardingSetupAction,
} from './onboarding-flow'
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
import { localPathForDisplay } from './local-path-display'
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
  type CodexSetupStatus,
  type ConfigSaveMode,
  type DesktopAppStatus,
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
  type ToolStatus,
  type UpdateSnapshot,
} from './types'

type ConfigTabId = ProviderId | 'codexDesktop'
type AppView = 'loading' | 'onboarding' | 'dashboard'
type ThemeMode = 'light' | 'dark'
type StartupStage = 'updates' | 'codex'

const THEME_STORAGE_KEY = 'xingmang-theme-v2'
const SIDEBAR_STORAGE_KEY = 'xingmang-sidebar-collapsed'

interface ProviderMeta {
  name: string
  company: string
  command: string
  packageName: string
  color: string
  tint: string
  icon: string
}

const providers: Record<ProviderId, ProviderMeta> = {
  claude: {
    name: 'Claude Code',
    company: 'Anthropic',
    command: 'claude',
    packageName: '@anthropic-ai/claude-code',
    color: '#b35b34',
    tint: '#fff5ef',
    icon: claudeCodeIconUrl,
  },
  codex: {
    name: 'Codex CLI',
    company: 'OpenAI',
    command: 'codex',
    packageName: '@openai/codex',
    color: '#087b68',
    tint: '#edfaf7',
    icon: chatGptIconUrl,
  },
  grok: {
    name: 'Grok CLI',
    company: 'xAI',
    command: 'grok',
    packageName: '@xai-official/grok',
    color: '#323640',
    tint: '#f2f3f5',
    icon: grokIconUrl,
  },
  gemini: {
    name: 'Gemini CLI',
    company: 'Google',
    command: 'gemini',
    packageName: '@google/gemini-cli',
    color: '#5969c7',
    tint: '#f1f3ff',
    icon: geminiCliIconUrl,
  },
}

const codexDesktopMeta: ProviderMeta = {
  name: 'Codex 桌面端',
  company: 'OpenAI · Windows',
  command: 'Codex App',
  packageName: '',
  color: '#087b68',
  tint: '#edfaf7',
  icon: chatGptIconUrl,
}

const dashboardProviderIds: ProviderId[] = ['codex', 'claude', 'grok', 'gemini']

function configProvider(tab: ConfigTabId): ProviderId {
  return tab === 'codexDesktop' ? 'codex' : tab
}

function configTabMeta(tab: ConfigTabId, platform: PlatformCapabilities): ProviderMeta {
  return tab === 'codexDesktop'
    ? { ...codexDesktopMeta, company: platformPresentation(platform).codexDesktopCompany }
    : providers[tab]
}

function shortVersion(value: string | null): string {
  if (!value) return '已检测到'
  return value.length > 34 ? `${value.slice(0, 31)}...` : value
}

const regionDisplayNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' })

function networkLocationLabel(network: SystemSnapshot['network']): string {
  if (network.region === 'unknown' || !network.countryCode) return '网络位置未知'
  const countryCode = network.countryCode.toUpperCase()
  let countryName = countryCode
  try {
    countryName = regionDisplayNames.of(countryCode) ?? countryCode
  } catch {
    // Keep the country code when Windows reports a non-standard region value.
  }
  return network.publicIp ? `${countryName} · ${network.publicIp}` : countryName
}

function updateFailureLabel(error: string | null | undefined): string {
  if (!error) return '检测失败'
  if (/xAI.*超时|连接.*xAI.*超时/i.test(error)) return 'xAI 连接超时'
  if (/超时/.test(error)) return '更新查询超时'
  if (/无效 JSON|无法解析/.test(error)) return '返回数据无效'
  if (/未返回内容/.test(error)) return '未返回更新数据'
  if (/无法启动/.test(error)) return '无法启动检查'
  if (/版本.*不一致/.test(error)) return '版本信息不一致'
  return error.length > 16 ? `${error.slice(0, 15)}…` : error
}

function codexDesktopInstallActive(progress: CodexDesktopInstallProgress | null): boolean {
  return Boolean(progress && progress.phase !== 'completed' && progress.phase !== 'error')
}

function codexDesktopInstallLabel(progress: CodexDesktopInstallProgress | null): string {
  if (!progress) return '准备安装'
  if (progress.phase === 'downloading') {
    return progress.percent === null ? '正在下载安装包' : `正在下载安装包 ${Math.round(progress.percent)}%`
  }
  if (progress.phase === 'validating') return '正在校验安装包'
  if (progress.phase === 'closing') return '正在关闭 Codex 桌面端'
  if (progress.phase === 'installing') return '正在安装最新版'
  if (progress.phase === 'completed') return '安装已完成'
  return progress.message || '安装失败'
}

function maskedApiKey(value: string): string {
  if (!value) return ''
  const prefix = value.slice(0, 5)
  const suffixLength = Math.min(4, Math.max(0, value.length - prefix.length))
  const suffix = suffixLength ? value.slice(-suffixLength) : ''
  const hiddenLength = Math.max(8, value.length - prefix.length - suffix.length)
  return `${prefix}${'•'.repeat(hiddenLength)}${suffix}`
}

function sameDesktopStatus(left: DesktopAppStatus, right: DesktopAppStatus): boolean {
  return left.installed === right.installed
    && left.version === right.version
    && left.appVersion === right.appVersion
    && left.mirrorVersion === right.mirrorVersion
    && left.mirrorUpdateAvailable === right.mirrorUpdateAvailable
    && left.mirrorError === right.mirrorError
    && left.path === right.path
    && left.installDirectory === right.installDirectory
    && left.running === right.running
}

export function codexDesktopLaunchDecision(
  platform: PlatformCapabilities,
  running: boolean,
): 'open' | 'choose' {
  return running && platform.platform !== 'macos' ? 'choose' : 'open'
}

export async function commitStartupPlatformCapabilities(
  load: () => Promise<PlatformCapabilities>,
  commit: (capabilities: PlatformCapabilities) => void,
): Promise<void> {
  const capabilities = await load()
  commit(capabilities)
}

function EmptyStatus(): SystemSnapshot {
  const missing = { installed: false, version: null, path: null, installDirectory: null }
  const missingCli = {
    ...missing,
    latestVersion: null,
    updateAvailable: false,
    uninstall: { available: false, reason: null, manualCommand: null },
  }
  return {
    checkedAt: '',
    network: {
      publicIp: null,
      countryCode: null,
      region: 'unknown',
      checkedAt: '',
      error: null,
    },
    runtime: { node: missing, npm: missing, python: missing },
    clis: { claude: missingCli, codex: missingCli, grok: missingCli, gemini: missingCli },
    desktopApps: {
      codex: {
        ...missing,
        appVersion: null,
        mirrorVersion: null,
        mirrorUpdateAvailable: null,
        mirrorError: null,
        running: false,
      },
    },
  }
}

function initialTheme(): ThemeMode {
  let theme: ThemeMode = 'dark'
  const startupTheme = new URLSearchParams(window.location.search).get('theme')
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (startupTheme === 'light' || startupTheme === 'dark') theme = startupTheme
    else if (stored === 'light' || stored === 'dark') theme = stored
  } catch {
    // Local storage can be unavailable in hardened browser environments.
  }
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  return theme
}

function initialSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function StatusMark({ installed, loading }: { installed: boolean; loading?: boolean }) {
  if (loading) return <LoaderCircle size={16} className="spin" />
  return installed
    ? <span className="status-mark installed"><Check size={12} strokeWidth={3} /></span>
    : <span className="status-mark missing"><X size={12} strokeWidth={3} /></span>
}

function RuntimeCell({
  label,
  status,
  loading,
  busyLabel,
  optional,
  actionLabel = '获取',
  onInstall,
}: {
  label: string
  status: ToolStatus
  loading: boolean
  busyLabel?: string
  optional?: boolean
  actionLabel?: string
  onInstall: () => void
}) {
  const blocked = status.tooOld === true || status.versionStatus === 'unknown'
  const needsAction = !status.installed || blocked
  return (
    <div className="runtime-cell">
      <div className="runtime-icon"><Terminal size={19} /></div>
      <div className="runtime-copy">
        <div className="runtime-name">
          {label}
          {optional && <span className="optional-label">扩展</span>}
        </div>
        <span className={status.installed && !blocked ? 'runtime-version' : 'runtime-version is-missing'}>
          {loading ? busyLabel ?? '检测中...'
            : !status.installed ? '未安装'
              : status.tooOld ? `版本过低 ${shortVersion(status.version)}`
                : status.versionStatus === 'unknown' ? '版本无法识别'
                  : shortVersion(status.version)}
        </span>
      </div>
      <div className="runtime-action">
        <StatusMark installed={status.installed} loading={loading} />
        {!loading && needsAction && (
          <button className="inline-link" onClick={onInstall}>{actionLabel}</button>
        )}
      </div>
    </div>
  )
}

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
    const missing = providerIds.filter((id) => !snapshot.clis[id].installed)
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

function formatStartupBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function startupUpdateLabel(state: UpdateSnapshot | null): string {
  if (state?.error) return `更新失败：${state.error.message}`
  if (state?.phase === 'available') return `发现新版本 ${state.availableVersion ?? ''}，准备下载`.trim()
  if (state?.phase === 'downloading') return `正在下载 ${state.availableVersion ?? '新版本'}`
  if (state?.phase === 'downloaded') return '更新下载完成，正在安装并重启'
  return '正在检查主程序更新'
}

function StartupSplash({
  theme,
  stage,
  updateState,
}: {
  theme: ThemeMode
  stage: StartupStage
  updateState: UpdateSnapshot | null
}) {
  const progress = stage === 'updates' ? updateState?.progress ?? null : null
  return (
    <div className="startup-splash">
      <img src={theme === 'dark' ? logoWhiteUrl : logoUrl} alt="星芒AI" />
      <div className="startup-splash-copy">
        <strong>星芒 AI</strong>
        <span>{stage === 'updates' ? startupUpdateLabel(updateState) : '正在检测 Codex 配置'}</span>
        {progress && (
          <div className="startup-update-progress" aria-label="主程序更新下载进度">
            <div>
              <span style={{ width: `${progress.percent}%` }} />
            </div>
            <small>
              {progress.percent.toFixed(1)}%
              {' · '}{formatStartupBytes(progress.transferred)} / {formatStartupBytes(progress.total)}
              {' · '}{formatStartupBytes(progress.bytesPerSecond)}/s
            </small>
          </div>
        )}
      </div>
      <LoaderCircle size={20} className="spin" />
    </div>
  )
}

type SetupAction = OnboardingSetupAction

function CodexOnboarding({
  initialConfig,
  theme,
  onToggleTheme,
  onConfigChange,
  onComplete,
  desktopInstallProgress,
  platform,
}: {
  initialConfig: AppConfigSummary | null
  theme: ThemeMode
  onToggleTheme: () => void
  onConfigChange: (config: AppConfigSummary) => void
  onComplete: () => Promise<void>
  desktopInstallProgress: CodexDesktopInstallProgress | null
  platform: PlatformCapabilities
}) {
  const existingCodex = initialConfig?.providers.codex
  const [stage, setStage] = useState<'authorize' | 'setup' | 'ready'>('authorize')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(true)
  const [status, setStatus] = useState<CodexSetupStatus | null>(null)
  const [action, setAction] = useState<SetupAction>('idle')
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [nodeGuideOpen, setNodeGuideOpen] = useState(false)
  const [nodeInstallProgress, setNodeInstallProgress] = useState<NodeRuntimeInstallProgress | null>(null)
  const [desktopInstallRecovery, setDesktopInstallRecovery] = useState(false)

  useEffect(() => {
    return window.xingmang.onInstallProgress((event: InstallProgress) => {
      if (event.provider !== 'codex') return
      setLogs((current) => [...current.slice(-20), event.message])
    })
  }, [])

  useEffect(() => {
    return window.xingmang.onNodeRuntimeInstallProgress((progress) => {
      setNodeInstallProgress(progress)
      setLogs((current) => [...current.slice(-20), progress.message])
    })
  }, [])

  useEffect(() => {
    if (!desktopInstallProgress) return
    setLogs((current) => [...current.slice(-20), desktopInstallProgress.message])
  }, [desktopInstallProgress])

  const setupCallbacks = {
    onAction: setAction,
    onStatus: setStatus,
    onLog: (message: string, mode: 'replace' | 'append') => {
      setLogs((current) => mode === 'replace' ? [message] : [...current, message])
    },
  }

  const applySetupResult = (result: CodexSetupResult) => {
    if (result.outcome === 'ready') {
      setStage('ready')
      return
    }
    if (result.outcome === 'runtime-required') {
      setError(result.message)
      setNodeGuideOpen(true)
      return
    }
    if (result.outcome === 'desktop-recovery') {
      setDesktopInstallRecovery(true)
      setError(errorMessage(result.error))
      setStage('ready')
      return
    }
    setDesktopInstallRecovery(result.phase === 'desktop')
    setError(errorMessage(result.error))
  }

  const runSetup = async () => {
    setError('')
    setDesktopInstallRecovery(false)
    applySetupResult(await prepareCodexEnvironment(window.xingmang, setupCallbacks, platform))
  }

  const openDesktopStore = async () => {
    try {
      await window.xingmang.openExternal(CODEX_DESKTOP_STORE_URI)
      setError('已打开微软商店。安装完成后点击“我已安装，重新检测”。')
    } catch (storeError) {
      setError(`无法打开微软商店：${errorMessage(storeError)}`)
    }
  }

  const recheckDesktop = async () => {
    setDesktopInstallRecovery(false)
    setError('')
    setAction('scanning')
    try {
      const next = await window.xingmang.getCodexSetupStatus()
      setStatus(next)
      if (!next.desktop.installed) throw new Error('仍未检测到 Codex 桌面端，请先完成微软商店安装')
      setAction('idle')
      setStage('ready')
    } catch (recheckError) {
      setAction('idle')
      setDesktopInstallRecovery(true)
      setError(errorMessage(recheckError))
    }
  }

  const skipDesktop = () => {
    setDesktopInstallRecovery(false)
    setError('')
    setStage('ready')
  }

  const installNodeAndContinue = async () => {
    if (action !== 'idle') return
    if (platform.nodeRuntimeInstall === 'external') {
      try {
        await performNodeRuntimeAction(platform, window.xingmang)
        setError('请从 Node.js 官网完成安装，然后返回重新检测。')
      } catch (installError) {
        setError(errorMessage(installError))
      }
      return
    }
    setError('')
    setNodeInstallProgress({
      phase: 'checking',
      source: null,
      percent: null,
      message: '正在准备 Node.js LTS 安装',
    })
    const result = await installNodeAndPrepareCodexEnvironment(window.xingmang, setupCallbacks, platform)
    if (result.outcome === 'node-failed') {
      setError(errorMessage(result.error))
      setNodeGuideOpen(true)
      return
    }
    setNodeGuideOpen(false)
    applySetupResult(result.setup)
  }

  const startInitialization = async () => {
    setError('')
    setAction('scanning')
    try {
      const nextConfig = await authorizeCodex(apiKey, window.xingmang)
      onConfigChange(nextConfig)
      setStage('setup')
      await runSetup()
    } catch (initializeError) {
      setAction('idle')
      setError(errorMessage(initializeError))
    }
  }

  const enterDashboard = async () => {
    setFinishing(true)
    setError('')
    try {
      await onComplete()
    } catch (completeError) {
      setFinishing(false)
      setError(errorMessage(completeError))
    }
  }

  const installedCount = status
    ? [status.runtime.node, status.runtime.npm, status.cli, status.desktop]
        .filter((item) => item.installed).length
    : 0
  const busy = action !== 'idle'

  return (
    <div className="onboarding-shell">
      <aside className="onboarding-rail">
        <div className="onboarding-brand">
          <img src={theme === 'dark' ? logoWhiteUrl : logoUrl} alt="星芒AI" />
          <div>
            <strong><span>星芒</span> AI</strong>
            <small>Codex 快速配置</small>
          </div>
        </div>

        <div className="onboarding-steps" aria-label="初始化进度">
          <OnboardingStep
            index={1}
            label="授权配置"
            detail="验证 API 授权码"
            active={stage === 'authorize'}
            complete={stage !== 'authorize'}
          />
          <OnboardingStep
            index={2}
            label="环境安装"
            detail="安装运行组件"
            active={stage === 'setup'}
            complete={stage === 'ready'}
          />
          <OnboardingStep
            index={3}
            label="准备完成"
            detail="进入工具概览"
            active={stage === 'ready'}
            complete={false}
          />
        </div>

        <div className="onboarding-rail-bottom">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <div className="onboarding-rail-note">
            <ShieldCheck size={16} />
            <span>修改配置前自动备份</span>
          </div>
        </div>
      </aside>

      <main className="onboarding-main">
        <div className="onboarding-content">
          {stage === 'authorize' ? (
            <>
              <div className="onboarding-heading">
                <div className="onboarding-heading-icon onboarding-codex-icon">
                  <img src={chatGptIconUrl} alt="" />
                </div>
                <div>
                  <span>CODEX QUICK SETUP</span>
                  <h1>初始化 Codex 配置</h1>
                  <p>验证授权码后，自动完成配置与运行环境准备。</p>
                </div>
              </div>

              {existingCodex?.exists && (
                <div className="onboarding-notice">
                  <AlertCircle size={17} />
                  <span>检测到现有 Codex 配置不是星芒 AI，初始化前会创建时间戳备份。</span>
                </div>
              )}

              <div className="onboarding-form">
                <div className="field-label-row">
                  <label htmlFor="onboarding-api-key">安装授权码</label>
                  <button
                    type="button"
                    className="key-link-button"
                    onClick={() => void window.xingmang.openExternal('https://api.solov.cc/keys')}
                  >
                    没有授权码？前往获取
                    <ExternalLink size={13} />
                  </button>
                </div>
                <div className="input-with-action onboarding-key-input">
                  <input
                    id="onboarding-api-key"
                    type="text"
                    value={showKey ? apiKey : maskedApiKey(apiKey || existingCodex?.apiKeyPreview || '')}
                    onChange={(event) => setApiKey(event.target.value)}
                    onFocus={() => {
                      if (!showKey) setShowKey(true)
                    }}
                    onBlur={() => {
                      // 未输入新 Key 时失焦恢复掩码，保留已保存 Key 的预览。
                      if (!apiKey) setShowKey(false)
                    }}
                    placeholder="请输入 API Key"
                    spellCheck={false}
                    autoComplete="off"
                    readOnly={!showKey}
                  />
                  <button
                    type="button"
                    title={!apiKey && existingCodex?.apiKeyPreview
                      ? '已保存的 Key 不可查看，输入新 Key 可替换'
                      : showKey ? '隐藏授权码' : '显示授权码'}
                    onClick={() => setShowKey((value) => !value)}
                  >
                    {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>

                <div className="onboarding-defaults">
                  <div>
                    <span>服务</span>
                    <strong><i />星芒 AI</strong>
                  </div>
                  <div>
                    <span>模型</span>
                    <code>{DEFAULT_CODEX_MODEL}</code>
                  </div>
                </div>

                {error && <div className="onboarding-error"><AlertCircle size={16} />{error}</div>}

                <button
                  type="button"
                  className="primary-button onboarding-primary"
                  disabled={busy || !apiKey.trim()}
                  onClick={() => void startInitialization()}
                >
                  {busy ? <LoaderCircle size={18} className="spin" /> : <MonitorDown size={18} />}
                  {busy ? '正在验证并写入配置' : '开始初始化'}
                  {!busy && <ArrowRight size={17} />}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="onboarding-heading setup-heading">
                <div className="onboarding-heading-icon onboarding-codex-icon">
                  <img src={chatGptIconUrl} alt="" />
                </div>
                <div>
                  <span>{stage === 'ready' ? 'SETUP COMPLETE' : 'ENVIRONMENT SETUP'}</span>
                  <h1>{stage === 'ready' ? (status?.desktop.installed ? 'Codex 已准备就绪' : 'Codex CLI 已准备就绪') : '正在准备 Codex 环境'}</h1>
                  <p>{stage === 'ready'
                    ? status?.desktop.installed
                      ? '配置与运行环境均已完成，可以进入工具概览。'
                      : '桌面端尚未安装，可以先进入工具概览，稍后继续安装。'
                    : '正在依次检测并安装 Codex 所需组件。'}</p>
                </div>
              </div>

              <div className="setup-progress-row">
                <span>初始化进度</span>
                <strong>{installedCount}/4</strong>
              </div>
              <div className="setup-progress"><span style={{ width: `${installedCount * 25}%` }} /></div>

              <div className="setup-check-list">
                <SetupCheckItem label="Node.js" detail={status?.runtime.node.version ?? 'Codex CLI 前置环境'} status={status?.runtime.node ?? null} loading={(action === 'scanning' && !status) || action === 'installing-node'} />
                <SetupCheckItem label="npm" detail={status?.runtime.npm.version ?? 'Node.js 包管理器'} status={status?.runtime.npm ?? null} loading={(action === 'scanning' && !status) || action === 'installing-node'} />
                <SetupCheckItem label="Codex CLI" detail={status?.cli.version ?? '@openai/codex'} status={status?.cli ?? null} loading={action === 'installing-cli'} />
                <SetupCheckItem
                  label="Codex 桌面端"
                  detail={action === 'installing-desktop' ? codexDesktopInstallLabel(desktopInstallProgress) : status?.desktop.installed ? platformPresentation(platform).codexDesktopClient : platform.isMac ? '可通过 Codex CLI 打开' : '等待安装最新版'}
                  status={status?.desktop ?? null}
                  loading={action === 'installing-desktop'}
                />
              </div>

              {nodeInstallProgress && action === 'installing-node' && (
                <div className={`node-runtime-progress phase-${nodeInstallProgress.phase}`} role="status" aria-live="polite">
                  <div>
                    <span>{nodeInstallProgress.message}</span>
                    {nodeInstallProgress.percent !== null && <strong>{Math.round(nodeInstallProgress.percent)}%</strong>}
                  </div>
                  <progress max="100" value={nodeInstallProgress.percent ?? undefined} />
                </div>
              )}

              {desktopInstallProgress && action === 'installing-desktop' && (
                <div className={`desktop-install-progress onboarding-desktop-progress phase-${desktopInstallProgress.phase}`} role="status" aria-live="polite">
                  <div>
                    <span>{codexDesktopInstallLabel(desktopInstallProgress)}</span>
                    {desktopInstallProgress.percent !== null && <strong>{Math.round(desktopInstallProgress.percent)}%</strong>}
                  </div>
                  {desktopInstallProgress.percent !== null && <progress max="100" value={desktopInstallProgress.percent} />}
                </div>
              )}

              {logs.length > 0 && stage !== 'ready' && (
                <div className="onboarding-log" aria-live="polite">
                  <div><CircleDot size={13} /> 安装进度</div>
                  <pre>{logs.slice(-6).join('\n')}</pre>
                </div>
              )}

              {error && <div className="onboarding-error"><AlertCircle size={16} />{error}</div>}

              {desktopInstallRecovery && (
                <div className="setup-recovery" role="group" aria-label="Codex 桌面端安装选项">
                  <div className="setup-recovery-copy">
                    <strong>桌面端安装未完成</strong>
                    <span>可以使用微软商店安装，或先进入工具概览，稍后再处理桌面端。</span>
                  </div>
                  <div className="setup-recovery-actions">
                    <button type="button" className="secondary-button" onClick={() => void openDesktopStore()}>
                      <Store size={16} /> 打开微软商店
                    </button>
                    <button type="button" className="secondary-button" onClick={() => void recheckDesktop()}>
                      <RefreshCw size={16} /> 我已安装，重新检测
                    </button>
                    <button type="button" className="primary-button" onClick={skipDesktop}>
                      <ArrowRight size={16} /> 稍后安装并进入工具概览
                    </button>
                  </div>
                </div>
              )}

              <div className="onboarding-actions">
                {stage === 'ready' ? (
                  <button type="button" className="primary-button onboarding-primary" disabled={finishing} onClick={() => void enterDashboard()}>
                    {finishing ? <LoaderCircle size={18} className="spin" /> : <CheckCircle2 size={18} />}
                    {finishing ? '正在载入工具概览' : '进入工具概览'}
                    {!finishing && <ArrowRight size={17} />}
                  </button>
                ) : !status || !nodeRuntimeSupported(status.runtime) || !status.runtime.npm.installed ? (
                  <>
                    <button type="button" className="primary-button" disabled={busy} onClick={() => void installNodeAndContinue()}>
                      {action === 'installing-node' ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
                      {action === 'installing-node' ? '正在安装 Node.js' : platformPresentation(platform).nodeActionLabel}
                    </button>
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => setNodeGuideOpen(true)}>
                      <BookOpen size={16} /> 安装教程
                    </button>
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => void runSetup()}>
                      <RefreshCw size={16} className={action === 'scanning' ? 'spin' : ''} /> 重新检测
                    </button>
                  </>
                ) : error && !desktopInstallRecovery ? (
                  <button type="button" className="secondary-button" onClick={() => void runSetup()}>
                    <RefreshCw size={16} /> 重试安装
                  </button>
                ) : (
                  <div className="setup-working"><LoaderCircle size={17} className="spin" />正在处理，请稍候</div>
                )}
              </div>
            </>
          )}
        </div>
      </main>
      {nodeGuideOpen && (
        <NodeInstallGuide
          runtime={status?.runtime ?? null}
          platform={platform}
          busy={busy}
          installProgress={nodeInstallProgress}
          onClose={() => setNodeGuideOpen(false)}
          onInstall={() => void installNodeAndContinue()}
          onRecheck={() => {
            setNodeGuideOpen(false)
            void runSetup()
          }}
        />
      )}
    </div>
  )
}

function OnboardingStep({
  index,
  label,
  detail,
  active,
  complete,
}: {
  index: number
  label: string
  detail: string
  active: boolean
  complete: boolean
}) {
  return (
    <div className={`onboarding-step${active ? ' active' : ''}${complete ? ' complete' : ''}`}>
      <span>{complete ? <Check size={14} strokeWidth={3} /> : index}</span>
      <div>
        <strong>{label}</strong>
        <small>{detail}</small>
      </div>
    </div>
  )
}

function SetupCheckItem({
  label,
  detail,
  status,
  loading,
}: {
  label: string
  detail: string
  status: ToolStatus | null
  loading: boolean
}) {
  const ready = Boolean(status?.installed && !status.tooOld && status.versionStatus !== 'unknown')
  return (
    <div className="setup-check-item">
      <div className={ready ? 'setup-check-icon ready' : loading ? 'setup-check-icon loading' : 'setup-check-icon'}>
        {ready
          ? <Check size={15} strokeWidth={3} />
          : loading ? <LoaderCircle size={16} className="spin" /> : <CircleDot size={15} />}
      </div>
      <div>
        <strong>{label}</strong>
        <span title={detail}>{detail}</span>
      </div>
      <small>{ready ? '已就绪' : loading ? '处理中' : status?.tooOld ? '需升级' : status ? '待安装' : '等待检测'}</small>
    </div>
  )
}

function NodeInstallGuide({
  runtime,
  busy,
  scanning = false,
  installProgress,
  onClose,
  onInstall,
  onRecheck,
  platform,
}: {
  runtime: CodexSetupStatus['runtime'] | null
  busy: boolean
  scanning?: boolean
  installProgress: NodeRuntimeInstallProgress | null
  onClose: () => void
  onInstall: () => void
  onRecheck: () => void
  platform: PlatformCapabilities
}) {
  const presentation = platformPresentation(platform)
  const [step, setStep] = useState(0)
  const steps = [
    {
      title: '下载 Node.js LTS',
      description: presentation.nodeGuideDescription,
      content: (
        <div className="node-guide-download-actions">
          <button type="button" className="primary-button node-guide-download" disabled={busy} onClick={onInstall}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
            {busy ? '正在自动安装' : presentation.nodeActionLabel}
          </button>
          <button
            type="button"
            className="secondary-button node-guide-download"
            disabled={busy}
            onClick={() => void window.xingmang.openExternal('https://nodejs.org/')}
          >
            官网手动下载
            <ExternalLink size={14} />
          </button>
        </div>
      ),
    },
    {
      title: '安装 Node.js 和 npm',
      description: presentation.nodeGuideInstallDescription,
      content: (
        <div className="node-guide-checks">
          <span><CheckCircle2 size={15} />Node.js runtime</span>
          <span><CheckCircle2 size={15} />npm package manager</span>
        </div>
      ),
    },
    {
      title: presentation.nodeGuidePathTitle,
      description: presentation.nodeGuidePathDescription,
      content: (
        <div className="node-guide-path">
          <CheckCircle2 size={16} />
          <div>
            <strong>{presentation.nodeGuidePathLabel}</strong>
            <span>{presentation.nodeGuidePathDetail}</span>
          </div>
        </div>
      ),
    },
    {
      title: '完成安装并重新检测',
      description: presentation.nodeGuideFinishDescription,
      content: (
        <div className="node-guide-status">
          <span className={runtime && nodeRuntimeSupported(runtime) ? 'ready' : ''}>
            {runtime && nodeRuntimeSupported(runtime) ? <Check size={14} /> : <CircleDot size={14} />}
            Node.js {runtime?.node.tooOld ? '版本过低' : runtime?.node.installed ? '已识别' : '等待检测'}
          </span>
          <span className={runtime?.npm.installed ? 'ready' : ''}>
            {runtime?.npm.installed ? <Check size={14} /> : <CircleDot size={14} />}
            npm {runtime?.npm.installed ? '已识别' : '等待检测'}
          </span>
        </div>
      ),
    },
  ] as const
  const current = steps[step]

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [busy, onClose])

  return (
    <DialogBackdrop className="save-mode-backdrop onboarding-guide-backdrop" onDismiss={busy ? () => undefined : onClose}>
      <section className="onboarding-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="node-guide-title">
        <header className="onboarding-guide-head">
          <div className="onboarding-guide-title">
            <span><BookOpen size={19} /></span>
            <div>
              <h2 id="node-guide-title">Node.js 安装教程</h2>
              <p>按下面 4 步完成 Codex CLI 前置环境。</p>
            </div>
          </div>
          <button type="button" className="icon-button" title="关闭教程" aria-label="关闭教程" disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="node-guide-steps" aria-label="Node.js 安装步骤">
          {steps.map((item, index) => (
            <button
              type="button"
              key={item.title}
              className={index === step ? 'active' : index < step ? 'complete' : ''}
              aria-label={`第 ${index + 1} 步：${item.title}`}
              onClick={() => setStep(index)}
            >
              {index < step ? <Check size={13} strokeWidth={3} /> : index + 1}
            </button>
          ))}
        </div>

        <div className="node-guide-content" aria-live="polite">
          <span>第 {step + 1} 步</span>
          <h3>{current.title}</h3>
          <p>{current.description}</p>
          {current.content}
          {installProgress && busy && (
            <div className={`node-guide-install-progress phase-${installProgress.phase}`}>
              <div>
                <span>{installProgress.message}</span>
                {installProgress.percent !== null && <strong>{Math.round(installProgress.percent)}%</strong>}
              </div>
              <progress max="100" value={installProgress.percent ?? undefined} />
            </div>
          )}
        </div>

        <footer className="onboarding-guide-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={step === 0 || busy}
            onClick={() => setStep((value) => Math.max(0, value - 1))}
          >
            上一步
          </button>
          {step < steps.length - 1 ? (
            <button type="button" className="primary-button" onClick={() => setStep((value) => Math.min(steps.length - 1, value + 1))}>
              下一步 <ArrowRight size={16} />
            </button>
          ) : (
            <button type="button" className="primary-button" disabled={busy || scanning} onClick={onRecheck}>
              <RefreshCw size={16} className={busy || scanning ? 'spin' : ''} />
              {busy || scanning ? '正在检测' : '完成并重新检测'}
            </button>
          )}
        </footer>
      </section>
    </DialogBackdrop>
  )
}

function Dashboard({
  platform,
  snapshot,
  config,
  scanning,
  installing,
  cliLaunching,
  codexLaunchPhase,
  codexDesktopInstalling,
  codexDesktopInstallProgress,
  nodeRuntimeInstalling,
  nodeRuntimeInstallProgress,
  runtimeReady,
  installedCliCount,
  installedToolCount,
  onScan,
  onInstallNode,
  onOpenNodeGuide,
  onInstall,
  onInstallAll,
  onConfigure,
  onConfigureCodexDesktop,
  onInstallCodexDesktop,
  onLaunch,
  onLaunchCodexDesktop,
}: {
  platform: PlatformCapabilities
  snapshot: SystemSnapshot
  config: AppConfigSummary | null
  scanning: boolean
  installing: Set<ProviderId>
  cliLaunching: ProviderId | null
  codexLaunchPhase: 'idle' | 'closing' | 'opening'
  codexDesktopInstalling: boolean
  codexDesktopInstallProgress: CodexDesktopInstallProgress | null
  nodeRuntimeInstalling: boolean
  nodeRuntimeInstallProgress: NodeRuntimeInstallProgress | null
  runtimeReady: boolean
  installedCliCount: number
  installedToolCount: number
  onScan: () => void
  onInstallNode: () => void
  onOpenNodeGuide: () => void
  onInstall: (provider: ProviderId) => void
  onInstallAll: () => void
  onConfigure: (provider: ProviderId) => void
  onConfigureCodexDesktop: () => void
  onInstallCodexDesktop: () => void
  onLaunch: (provider: ProviderId) => void
  onLaunchCodexDesktop: () => void
}) {
  const presentation = platformPresentation(platform)
  return (
    <div className="page dashboard-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">SYSTEM OVERVIEW</div>
          <h1>工具概览</h1>
        </div>
        <div className="header-actions">
          {installedCliCount < 4 && (
            <button className="secondary-button" disabled={!runtimeReady || installing.size > 0} onClick={onInstallAll}>
              <Download size={16} />
              安装全部缺失项
            </button>
          )}
          <div
            className={`network-location${snapshot.network.region === 'unknown' ? ' unknown' : ''}`}
            title={snapshot.network.error ?? networkLocationLabel(snapshot.network)}
          >
            <Globe2 size={14} />
            <span>{networkLocationLabel(snapshot.network)}</span>
          </div>
          <button className="icon-button" title="重新检测" aria-label="重新检测" onClick={onScan} disabled={scanning}>
            <RefreshCw size={18} className={scanning ? 'spin' : ''} />
          </button>
        </div>
      </header>

      <section className="environment-section">
        <div className="section-heading">
          <div>
            <h2>本机环境</h2>
            <span>最后检测 {snapshot.checkedAt ? new Date(snapshot.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--'}</span>
          </div>
          <div className="environment-heading-actions">
            {!runtimeReady && (
              <button className="runtime-guide-button" disabled={nodeRuntimeInstalling} onClick={onOpenNodeGuide}>
                <BookOpen size={13} /> 安装教程
              </button>
            )}
            <div className={runtimeReady ? 'readiness ready' : 'readiness blocked'}>
              <span />
              {runtimeReady ? '可安装 CLI' : nodeRuntimeInstalling ? '正在安装 Node.js' : '需补全前置环境'}
            </div>
          </div>
        </div>
        <div className="runtime-grid">
          <RuntimeCell label="Node.js" status={snapshot.runtime.node} loading={scanning || nodeRuntimeInstalling} busyLabel={nodeRuntimeInstalling ? '安装中...' : undefined} actionLabel={presentation.nodeAction === 'open-website' ? presentation.nodeActionLabel : snapshot.runtime.node.installed ? '升级' : '一键安装'} onInstall={onInstallNode} />
          <RuntimeCell label="npm" status={snapshot.runtime.npm} loading={scanning || nodeRuntimeInstalling} busyLabel={nodeRuntimeInstalling ? '安装中...' : undefined} actionLabel={presentation.nodeAction === 'open-website' ? presentation.nodeActionLabel : '一键安装'} onInstall={onInstallNode} />
          <RuntimeCell label="Python" status={snapshot.runtime.python} loading={scanning} optional onInstall={() => void window.xingmang.openExternal('https://www.python.org/downloads/')} />
        </div>
        {nodeRuntimeInstallProgress && nodeRuntimeInstalling && (
          <div className={`node-runtime-progress dashboard-node-progress phase-${nodeRuntimeInstallProgress.phase}`} role="status" aria-live="polite">
            <div>
              <span>{nodeRuntimeInstallProgress.message}</span>
              {nodeRuntimeInstallProgress.percent !== null && <strong>{Math.round(nodeRuntimeInstallProgress.percent)}%</strong>}
            </div>
            <progress max="100" value={nodeRuntimeInstallProgress.percent ?? undefined} />
          </div>
        )}
      </section>

      <section className="cli-section">
        <div className="section-heading">
          <div>
            <h2>AI 工具</h2>
            <span>{installedToolCount}/5 个已安装</span>
          </div>
        </div>
        <div className="cli-grid">
          <CodexDesktopCard
            platform={platform}
            status={snapshot.desktopApps.codex}
            configured={Boolean(config?.providers.codex.hasApiKey && config.providers.codex.matchesRelay)}
            configExists={Boolean(config?.providers.codex.exists)}
            model={config?.providers.codex.model ?? ''}
            scanning={scanning}
            launchPhase={codexLaunchPhase}
            installing={codexDesktopInstalling}
            installProgress={codexDesktopInstallProgress}
            onConfigure={onConfigureCodexDesktop}
            onInstall={onInstallCodexDesktop}
            onLaunch={onLaunchCodexDesktop}
          />
          {dashboardProviderIds.map((provider) => {
            const meta = providers[provider]
            const status = snapshot.clis[provider]
            const isInstalling = installing.has(provider)
            const providerConfig = config?.providers[provider]
            const isConfigured = Boolean(providerConfig?.hasApiKey && providerConfig.matchesRelay)
            return (
              <article className="cli-card" key={provider}>
                <div className="cli-card-top">
                  <div className="provider-icon" style={{ color: meta.color, backgroundColor: meta.tint }}>
                    <img src={meta.icon} alt="" aria-hidden="true" />
                  </div>
                  <div className="cli-identity">
                    <h3>{meta.name}</h3>
                    <span>{meta.company}</span>
                  </div>
                  <StatusMark installed={status.installed} loading={scanning || isInstalling} />
                </div>
                <div className="cli-meta-row">
                  <code>{meta.command}</code>
                  <span
                    className={status.updateCheck === 'failed'
                      ? 'version-pill error'
                      : status.updateState === 'available'
                        ? 'version-pill update'
                        : status.installed ? 'version-pill' : 'version-pill missing'}
                    title={status.updateError ?? (status.latestVersion ? `最新版 ${status.latestVersion}` : undefined)}
                  >
                    {isInstalling
                      ? status.installed ? '更新中' : '安装中'
                      : scanning ? '检测中'
                        : status.updateState === 'available' ? `可更新 ${status.latestVersion}`
                          : status.updateState === 'latest' ? '已是最新'
                            : status.updateCheck === 'failed' ? updateFailureLabel(status.updateError)
                              : status.installed ? shortVersion(status.version) : '未安装'}
                  </span>
                </div>
                <div className="config-state">
                  <span className={isConfigured ? 'config-dot configured' : 'config-dot'} />
                  {providerConfig?.exists
                    ? isConfigured ? '星芒 AI 已配置' : '需要重新配置'
                    : '配置文件未创建'}
                </div>
                {isConfigured && providerConfig?.model && (
                  <div className="config-model configured-model" title={providerConfig.model}>
                    <span className="config-dot configured" />
                    <code>{providerConfig.model}</code>
                  </div>
                )}
                <div className="cli-actions">
                  {!status.installed ? (
                    <button className="primary-button full" disabled={!runtimeReady || isInstalling || scanning} onClick={() => onInstall(provider)}>
                      {isInstalling ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
                      {isInstalling ? '正在安装' : presentation.grokAction === 'external-guidance' && provider === 'grok' ? presentation.grokActionLabel : '一键安装'}
                    </button>
                  ) : (
                    <>
                      {status.updateAvailable && (
                        <button
                          className="secondary-button grow update-button"
                          disabled={isInstalling || scanning}
                          title={`更新到 ${status.latestVersion}`}
                          onClick={() => onInstall(provider)}
                        >
                          {isInstalling ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
                          更新
                        </button>
                      )}
                      <button className="secondary-button grow" disabled={isInstalling} onClick={() => onConfigure(provider)}>
                        <Settings2 size={16} />
                        配置
                      </button>
                      <button
                        className="primary-button grow launch-button"
                        disabled={isInstalling || cliLaunching !== null}
                        onClick={() => onLaunch(provider)}
                      >
                        {cliLaunching === provider ? <LoaderCircle size={16} className="spin" /> : <FolderOpen size={16} />}
                        {cliLaunching === provider ? '启动中' : '打开'}
                      </button>
                    </>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function CodexDesktopCard({
  platform,
  status,
  configured,
  configExists,
  model,
  scanning,
  launchPhase,
  installing,
  installProgress,
  onConfigure,
  onInstall,
  onLaunch,
}: {
  platform: PlatformCapabilities
  status: DesktopAppStatus
  configured: boolean
  configExists: boolean
  model: string
  scanning: boolean
  launchPhase: 'idle' | 'closing' | 'opening'
  installing: boolean
  installProgress: CodexDesktopInstallProgress | null
  onConfigure: () => void
  onInstall: () => void
  onLaunch: () => void
}) {
  const busy = scanning || installing || launchPhase !== 'idle'
  const presentation = platformPresentation(platform)
  return (
    <article className="cli-card desktop-card">
      <div className="cli-card-top">
        <div className="provider-icon" style={{ color: providers.codex.color, backgroundColor: providers.codex.tint }}>
          <img src={providers.codex.icon} alt="" aria-hidden="true" />
        </div>
        <div className="cli-identity">
          <h3>Codex 桌面端</h3>
          <span>{presentation.codexDesktopCompany}</span>
        </div>
        <StatusMark installed={status.installed} loading={scanning || installing} />
      </div>
      <div className="cli-meta-row">
        <code>Codex App</code>
        <span className={
          !status.installed
            ? 'version-pill missing'
            : launchPhase !== 'idle'
              ? 'version-pill update'
              : status.running ? 'version-pill running' : 'version-pill idle'
        }>
          {installing
            ? codexDesktopInstallLabel(installProgress)
            : launchPhase === 'closing'
            ? '正在关闭'
            : launchPhase === 'opening'
              ? '正在启动'
              : scanning
            ? '检测中'
            : !status.installed
              ? '未安装'
              : status.running ? '窗口已打开' : '窗口未打开'}
        </span>
      </div>
      <div className="config-state">
        <span className={configured ? 'config-dot configured' : 'config-dot'} />
        {configured
          ? '与 Codex CLI 共用星芒配置'
          : configExists ? '共用配置需要重新配置' : '共用配置文件未创建'}
      </div>
      {status.installed && presentation.showWindowsPackages && (
        <div
          className="config-model"
          title={status.updateError ?? [
            status.appVersion ? `应用版本 ${status.appVersion}` : null,
            status.version ? `MSIX 包版本 ${status.version}` : null,
            status.latestVersion ? `官方最新包版本 ${status.latestVersion}` : null,
          ].filter(Boolean).join('；')}
        >
          <span className={`config-dot ${status.updateState === 'latest' ? 'configured' : ''}`} />
          <code>{status.version ?? '版本未知'}</code>
          <span>
            {status.updateState === 'available'
              ? `可更新至 ${status.latestVersion}`
              : status.updateState === 'latest' ? '已检查，当前最新' : status.updateError ?? '更新状态未知'}
          </span>
        </div>
      )}
      {configured && model && (
        <div className="config-model configured-model" title={model}>
          <span className="config-dot configured" />
          <code>{model}</code>
        </div>
      )}
      {installing && installProgress && (
        <div className={`desktop-install-progress phase-${installProgress.phase}`} role="status" aria-live="polite">
          <div>
            <span>{installProgress.message}</span>
            {installProgress.percent !== null && <strong>{Math.round(installProgress.percent)}%</strong>}
          </div>
          {installProgress.percent !== null && <progress max="100" value={installProgress.percent} />}
        </div>
      )}
      <div className="cli-actions">
        {!status.installed ? (
          <button className="primary-button full" onClick={presentation.codexDesktopAction === 'launch' ? onLaunch : onInstall} disabled={busy || presentation.codexDesktopAction === 'unsupported'}>
            {installing ? <LoaderCircle size={16} className="spin" /> : presentation.codexDesktopAction === 'launch' ? <AppWindow size={16} /> : <Download size={16} />}
            {installing ? '正在安装' : presentation.codexDesktopActionLabel}
          </button>
        ) : (
          <>
            {status.updateState === 'available' && (
              <button className="secondary-button grow update-button" onClick={onInstall} disabled={busy} title={`安装 Codex Desktop ${status.latestVersion}`}>
                {installing ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
                {installing ? '更新中' : '安装最新版'}
              </button>
            )}
            <button className="secondary-button grow" onClick={onConfigure} disabled={busy}>
              <Settings2 size={16} />
              配置
            </button>
            <button
              className="primary-button grow launch-button"
              title="打开 Codex 桌面端"
              onClick={onLaunch}
              disabled={busy}
            >
              {launchPhase !== 'idle' ? <LoaderCircle size={16} className="spin" /> : <AppWindow size={16} />}
              {launchPhase === 'closing' ? '关闭中' : launchPhase === 'opening' ? '启动中' : '打开'}
            </button>
          </>
        )}
      </div>
    </article>
  )
}

function ConfigDialog({
  platform,
  activeTab,
  config,
  snapshot,
  onConfigChange,
  onClose,
  notify,
}: {
  platform: PlatformCapabilities
  activeTab: ConfigTabId
  config: AppConfigSummary | null
  snapshot: SystemSnapshot
  onConfigChange: (config: AppConfigSummary) => void
  onClose: () => void
  notify: (toast: { type: 'success' | 'error'; message: string }) => void
}) {
  const activeProvider = configProvider(activeTab)
  const summary = config?.providers[activeProvider]
  // Empty input is an explicit sentinel: the main process reuses the existing key.
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [validatedApiKey, setValidatedApiKey] = useState<string | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [revealedApiKey, setRevealedApiKey] = useState('')
  const [apiKeyEdited, setApiKeyEdited] = useState(false)
  const [revealingKey, setRevealingKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveModeOpen, setSaveModeOpen] = useState(false)
  const [discardChangesOpen, setDiscardChangesOpen] = useState(false)

  // 只跟随标签页重置：config 引用会被后台扫描等操作频繁刷新，
  // 若一并作为依赖会清空用户正在输入的 API Key 和已检测的模型列表。
  useEffect(() => {
    setApiKey('')
    setModel(config?.providers[activeProvider].model ?? '')
    setAvailableModels([])
    setValidatedApiKey(null)
    setShowKey(false)
    setRevealedApiKey('')
    setApiKeyEdited(false)
    setRevealingKey(false)
    setDiscardChangesOpen(false)
  }, [activeProvider])

  const modelOptions = useMemo(() => {
    if (model && !availableModels.includes(model)) return [model, ...availableModels]
    return availableModels
  }, [availableModels, model])

  // config 晚于弹窗打开才就绪时补同步 model 显示值；一旦开始输入或已检测模型就不再覆盖。
  useEffect(() => {
    if (apiKey.trim() || availableModels.length) return
    const nextModel = config?.providers[activeProvider].model ?? ''
    setModel((current) => current === nextModel ? current : nextModel)
  }, [activeProvider, apiKey, availableModels, config])

  const configured = Boolean(summary?.hasApiKey && summary.matchesRelay)
  const isDirty = summary ? (
    Boolean(apiKey.trim())
    || model !== summary.model
  ) : false
  const normalizedApiKey = apiKey.trim()
  const keyVerified = normalizedApiKey
    ? validatedApiKey === normalizedApiKey
    : Boolean(summary?.hasApiKey)
  const modelVerified = keyVerified && (
    availableModels.length > 0
      ? availableModels.includes(model)
      : !normalizedApiKey && Boolean(summary?.hasApiKey) && model === summary?.model
  )
  const toolStatus = activeTab === 'codexDesktop'
    ? snapshot.desktopApps.codex
    : snapshot.clis[activeProvider]
  const installed = toolStatus.installed
  const installDirectory = toolStatus.installDirectory
  const meta = configTabMeta(activeTab, platform)

  const toggleApiKeyVisibility = async () => {
    if (showKey) {
      setShowKey(false)
      setRevealedApiKey('')
      return
    }
    if (apiKeyEdited || apiKey || !summary?.hasApiKey) {
      setShowKey(true)
      return
    }
    setRevealingKey(true)
    try {
      const savedApiKey = await window.xingmang.revealApiKey(activeProvider)
      if (!savedApiKey) throw new Error('未读取到已保存的 API Key')
      setRevealedApiKey(savedApiKey)
      setShowKey(true)
    } catch (error) {
      notify({ type: 'error', message: errorMessage(error) })
    } finally {
      setRevealingKey(false)
    }
  }

  const requestClose = useCallback(() => {
    if (saveModeOpen) {
      setSaveModeOpen(false)
      return
    }
    if (discardChangesOpen) {
      setDiscardChangesOpen(false)
      return
    }
    if (isDirty) {
      setDiscardChangesOpen(true)
      return
    }
    onClose()
  }, [discardChangesOpen, isDirty, onClose, saveModeOpen])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [requestClose])

  const detectModels = async () => {
    if (!apiKey.trim()) {
      notify({ type: 'error', message: '请先填写 API Key' })
      return
    }
    setModelsLoading(true)
    try {
      const models = await window.xingmang.listModels(apiKey)
      setAvailableModels(models)
      setValidatedApiKey(apiKey.trim())
      if (!models.includes(model) && models[0]) setModel(models[0])
      notify({ type: 'success', message: `检测到 ${models.length} 个可用模型` })
    } catch (error) {
      notify({ type: 'error', message: errorMessage(error) })
    } finally {
      setModelsLoading(false)
    }
  }

  const persistConfig = async (mode: ConfigSaveMode) => {
    if (!modelVerified) {
      notify({ type: 'error', message: '请先检测当前 API Key，并选择该 Key 可用的模型' })
      return
    }
    setSaveModeOpen(false)
    setSaving(true)
    try {
      const result = await window.xingmang.saveConfig({
        provider: activeProvider,
        apiKey,
        model,
        mode,
      })
      const next = await window.xingmang.getConfig()
      onConfigChange(next)
      // 保存成功后回到「无未保存修改」状态，避免关闭弹窗时误弹放弃确认。
      setApiKey('')
      setAvailableModels([])
      setValidatedApiKey(null)
      setShowKey(false)
      setRevealedApiKey('')
      setApiKeyEdited(false)
      notify({
        type: 'success',
        message: result.backups.length
          ? mode === 'merge'
            ? `${meta.name} 已备份 ${result.backups.length} 个文件并更新 API Key 和模型`
            : `${meta.name} 已备份 ${result.backups.length} 个文件并恢复初始配置`
          : `${meta.name} 配置文件已创建`,
      })
    } catch (error) {
      notify({ type: 'error', message: errorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  const save = async () => {
    try {
      const latestConfig = await window.xingmang.getConfig()
      if (latestConfig.providers[activeProvider].exists) {
        setSaveModeOpen(true)
        return
      }
      await persistConfig('reset')
    } catch (error) {
      notify({ type: 'error', message: errorMessage(error) })
    }
  }

  return (
    <DialogBackdrop className="config-modal-backdrop" onDismiss={requestClose}>
      <section className="config-dialog" role="dialog" aria-modal="true" aria-labelledby="config-dialog-title">
        <header className="config-dialog-head">
          <div className="config-dialog-identity">
            <div className="provider-icon large" style={{ color: meta.color, backgroundColor: meta.tint }}>
              <img src={meta.icon} alt="" aria-hidden="true" />
            </div>
          <div>
              <h2 id="config-dialog-title">{meta.name} 配置</h2>
            <div className="command-line">
              {activeTab === 'codexDesktop' ? <AppWindow size={14} /> : <Terminal size={14} />}
              <code>{meta.command}</code>
              <span>·</span>
              <span>{installed ? `${activeTab === 'codexDesktop' ? '桌面端' : 'CLI'} 已安装` : `${activeTab === 'codexDesktop' ? '桌面端' : 'CLI'} 未安装`}</span>
              {activeTab === 'codexDesktop' && <><span>·</span><span>与 Codex CLI 共用配置</span></>}
            </div>
          </div>
          </div>
          <div className="config-dialog-head-actions">
            <div className={configured ? 'readiness ready' : 'readiness blocked'}>
              <span />
              {configured ? '星芒 AI 已配置' : summary?.exists ? '需要重新配置' : '尚未创建配置'}
            </div>
            <button className="icon-button" type="button" title="关闭配置" aria-label="关闭配置" onClick={requestClose}>
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="form-grid">
          <div className="field full-field">
            <div className="field-label-row">
              <label htmlFor="api-key-input">API Key</label>
              <button
                type="button"
                className="key-link-button"
                onClick={() => void window.xingmang.openExternal('https://api.solov.cc/keys')}
              >
                没有 Key？前往生成
                <ExternalLink size={13} />
              </button>
            </div>
            <div className="input-with-action">
              <input
                id="api-key-input"
                type="text"
                value={showKey
                  ? apiKeyEdited ? apiKey : apiKey || revealedApiKey
                  : maskedApiKey(apiKey || summary?.apiKeyPreview || '')}
                onChange={(event) => {
                  setApiKey(event.target.value)
                  setApiKeyEdited(true)
                  setAvailableModels([])
                  setValidatedApiKey(null)
                }}
                onFocus={() => {
                  if (!summary?.hasApiKey && !showKey) setShowKey(true)
                }}
                onBlur={() => {
                  // 未输入新 Key 时失焦恢复掩码，保留已保存 Key 的预览。
                  if (!apiKeyEdited || !apiKey) {
                    setShowKey(false)
                    setRevealedApiKey('')
                  }
                }}
                placeholder="sk-..."
                spellCheck={false}
                autoComplete="off"
                readOnly={!showKey}
              />
              <button
                type="button"
                title={revealingKey ? '正在读取 API Key' : showKey ? '隐藏 API Key' : '显示 API Key'}
                onClick={() => void toggleApiKeyVisibility()}
                disabled={revealingKey}
              >
                {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </div>

          <div className="field full-field">
            <div className="field-label-row">
              <label htmlFor="model-select">使用模型</label>
              <span className="model-count">
                {modelsLoading
                  ? '正在查询可用模型'
                  : availableModels.length
                    ? `已检测 ${availableModels.length} 个模型`
                    : keyVerified ? '当前配置已验证' : '请检测当前 API Key'}
              </span>
            </div>
            <div className="model-picker">
              <select
                id="model-select"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={modelsLoading || modelOptions.length === 0}
              >
                {modelOptions.length === 0 && <option value="">请先检测可用模型</option>}
                {modelOptions.map((modelId) => <option value={modelId} key={modelId}>{modelId}</option>)}
              </select>
              <button
                type="button"
                className="secondary-button detect-models-button"
                disabled={modelsLoading || !apiKey.trim()}
                onClick={() => void detectModels()}
              >
                <RefreshCw size={16} className={modelsLoading ? 'spin' : ''} />
                {modelsLoading ? '检测中' : '检测模型'}
              </button>
            </div>
          </div>

        </div>

        <div className="native-file-list installation-directory-list">
          <div className="native-file-label">安装目录</div>
          <div className="native-files">
            <div className="native-file installation-directory">
              <FolderOpen size={15} />
              <code title={localPathForDisplay(installDirectory) || undefined}>
                {localPathForDisplay(installDirectory) || '未识别到安装目录'}
              </code>
              <span className={installDirectory ? 'file-state exists' : 'file-state'}>
                {installDirectory ? '已识别' : '未识别'}
              </span>
            </div>
          </div>
        </div>

        <div className="native-file-list data-directory-list">
          <div className="native-file-label">数据目录</div>
          <div className="native-files">
            <div className="native-file data-directory">
              <FolderOpen size={15} />
              <code title={localPathForDisplay(summary?.dataDirectory) || undefined}>
                {localPathForDisplay(summary?.dataDirectory) || '未识别到数据目录'}
              </code>
              <span className={summary?.dataDirectoryExists ? 'file-state exists' : 'file-state'}>
                {summary?.dataDirectoryExists ? '已识别' : '未创建'}
              </span>
            </div>
          </div>
        </div>

        <div className="native-file-list config-file-list">
          <div className="native-file-label">配置文件</div>
          <div className="native-files">
            {summary?.files.map((file) => (
              <div className="native-file" key={file.path}>
                {file.exists ? <FileCheck2 size={15} /> : <FileWarning size={15} />}
                <code title={localPathForDisplay(file.path)}>{localPathForDisplay(file.path)}</code>
                <span className={file.exists ? 'file-state exists' : 'file-state'}>
                  {file.exists ? '已存在' : '未创建'}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="config-actions">
          <button className="primary-button" onClick={() => void save()} disabled={saving || !isDirty || !modelVerified}>
            {saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}
            保存配置
          </button>
        </div>

        <div className="config-summary-bar">
          <div><ShieldCheck size={16} />API Key 写入 CLI 原生配置</div>
          <ChevronRight size={16} />
          <div>覆盖前自动创建时间戳备份</div>
        </div>
      </section>
      {saveModeOpen && (
        <SaveModeDialog
          onSelect={(mode) => void persistConfig(mode)}
          onCancel={() => setSaveModeOpen(false)}
        />
      )}
      {discardChangesOpen && (
        <DiscardConfigChangesDialog
          onDiscard={onClose}
          onCancel={() => setDiscardChangesOpen(false)}
        />
      )}
    </DialogBackdrop>
  )
}

function CodexLaunchDialog({
  onSelect,
  onCancel,
}: {
  onSelect: (mode: CodexDesktopLaunchMode) => void
  onCancel: () => void
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onCancel])

  return (
    <DialogBackdrop className="save-mode-backdrop" onDismiss={onCancel}>
      <section className="save-mode-dialog" role="alertdialog" aria-modal="true" aria-labelledby="codex-launch-title">
        <header className="save-mode-head">
          <div>
            <div className="save-mode-icon"><AppWindow size={20} /></div>
            <div>
              <h3 id="codex-launch-title">Codex 桌面端已运行</h3>
              <p>修改了配置请选择重启 Codex，若无修改直接打开即可。</p>
            </div>
          </div>
          <button className="icon-button" type="button" title="取消" onClick={onCancel}>
            <X size={18} />
          </button>
        </header>

        <div className="save-mode-options">
          <button type="button" className="save-mode-option" onClick={() => onSelect('open')}>
            <span className="save-option-icon"><AppWindow size={19} /></span>
            <span>
              <strong>直接打开</strong>
              <small>未修改配置，保留当前进程并唤起窗口</small>
            </span>
            <ChevronRight size={18} />
          </button>
          <button type="button" className="save-mode-option reset-option" onClick={() => onSelect('restart')}>
            <span className="save-option-icon"><RotateCcw size={19} /></span>
            <span>
              <strong>重启 Codex</strong>
              <small>退出当前进程，重新加载刚保存的配置</small>
            </span>
            <ChevronRight size={18} />
          </button>
        </div>

        <footer className="save-mode-footer">
          <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
        </footer>
      </section>
    </DialogBackdrop>
  )
}

function SaveModeDialog({
  onSelect,
  onCancel,
}: {
  onSelect: (mode: ConfigSaveMode) => void
  onCancel: () => void
}) {
  return (
    <DialogBackdrop className="save-mode-backdrop" onDismiss={onCancel}>
      <section className="save-mode-dialog" role="alertdialog" aria-modal="true" aria-labelledby="save-mode-title">
        <header className="save-mode-head">
          <div>
            <div className="save-mode-icon"><FileWarning size={20} /></div>
            <div>
              <h3 id="save-mode-title">配置文件已存在</h3>
              <p>选择本次保存方式，执行前都会创建时间戳备份。</p>
            </div>
          </div>
          <button className="icon-button" type="button" title="取消" onClick={onCancel}>
            <X size={18} />
          </button>
        </header>

        <div className="save-mode-options">
          <button type="button" className="save-mode-option" onClick={() => onSelect('merge')}>
            <span className="save-option-icon"><PencilLine size={19} /></span>
            <span>
              <strong>只修改 API Key 和模型</strong>
              <small>保留配置文件中的其他自定义设置</small>
            </span>
            <ChevronRight size={18} />
          </button>
          <button type="button" className="save-mode-option reset-option" onClick={() => onSelect('reset')}>
            <span className="save-option-icon"><RotateCcw size={19} /></span>
            <span>
              <strong>重置为初始配置</strong>
              <small>若只修改 API Key 和模型不能正常使用，请使用此项重置配置文件</small>
            </span>
            <ChevronRight size={18} />
          </button>
        </div>

        <footer className="save-mode-footer">
          <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
        </footer>
      </section>
    </DialogBackdrop>
  )
}

function DiscardConfigChangesDialog({
  onDiscard,
  onCancel,
}: {
  onDiscard: () => void
  onCancel: () => void
}) {
  return (
    <DialogBackdrop className="save-mode-backdrop" onDismiss={onCancel}>
      <section className="save-mode-dialog" role="alertdialog" aria-modal="true" aria-labelledby="discard-config-title">
        <header className="save-mode-head">
          <div>
            <div className="save-mode-icon"><AlertCircle size={20} /></div>
            <div>
              <h3 id="discard-config-title">放弃未保存的修改？</h3>
              <p>API Key 或模型已经更改，关闭后本次修改不会保留。</p>
            </div>
          </div>
          <button className="icon-button" type="button" title="继续编辑" onClick={onCancel}>
            <X size={18} />
          </button>
        </header>
        <footer className="save-mode-footer">
          <button className="secondary-button" type="button" onClick={onCancel}>继续编辑</button>
          <button className="danger-button" type="button" onClick={onDiscard}>放弃修改</button>
        </footer>
      </section>
    </DialogBackdrop>
  )
}

export default App
