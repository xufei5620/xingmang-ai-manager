import type {
  CodexDesktopInstallProgress,
  DesktopAppStatus,
  PlatformCapabilities,
  SystemSnapshot,
} from './types'

export type AppView = 'loading' | 'onboarding' | 'dashboard'
export type ThemeMode = 'light' | 'dark'
export type StartupStage = 'updates' | 'codex'

export const THEME_STORAGE_KEY = 'xingmang-theme-v2'
export const SIDEBAR_STORAGE_KEY = 'xingmang-sidebar-collapsed'

export function shortVersion(value: string | null): string {
  if (!value) return '已检测到'
  return value.length > 34 ? `${value.slice(0, 31)}...` : value
}

const regionDisplayNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' })

export function networkLocationLabel(network: SystemSnapshot['network']): string {
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

export function updateFailureLabel(error: string | null | undefined): string {
  if (!error) return '检测失败'
  if (/xAI.*超时|连接.*xAI.*超时/i.test(error)) return 'xAI 连接超时'
  if (/超时/.test(error)) return '更新查询超时'
  if (/无效 JSON|无法解析/.test(error)) return '返回数据无效'
  if (/未返回内容/.test(error)) return '未返回更新数据'
  if (/无法启动/.test(error)) return '无法启动检查'
  if (/版本.*不一致/.test(error)) return '版本信息不一致'
  return error.length > 16 ? `${error.slice(0, 15)}…` : error
}

export function codexDesktopInstallActive(progress: CodexDesktopInstallProgress | null): boolean {
  return Boolean(progress && progress.phase !== 'completed' && progress.phase !== 'error')
}

export function codexDesktopInstallLabel(progress: CodexDesktopInstallProgress | null): string {
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

export function maskedApiKey(value: string): string {
  if (!value) return ''
  const prefix = value.slice(0, 5)
  const suffixLength = Math.min(4, Math.max(0, value.length - prefix.length))
  const suffix = suffixLength ? value.slice(-suffixLength) : ''
  const hiddenLength = Math.max(8, value.length - prefix.length - suffix.length)
  return `${prefix}${'•'.repeat(hiddenLength)}${suffix}`
}

export function sameDesktopStatus(left: DesktopAppStatus, right: DesktopAppStatus): boolean {
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

export function EmptyStatus(): SystemSnapshot {
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

export function initialTheme(): ThemeMode {
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

export function initialSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}
