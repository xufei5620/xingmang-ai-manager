import type {
  AppConfigSummary,
  CodexDesktopInstallProgress,
  DesktopAppStatus,
  PlatformCapabilities,
  SystemSnapshot,
} from './types'

// 'account-center' is a top-level overlay, not a Sidebar/PageId destination
// (see AccountCenterPage.tsx) -- entered from AccountArea's identity row,
// exited via its own "返回工作台" button back to 'dashboard'. Modeled as a
// sibling of 'welcome'/'onboarding' rather than nested inside 'dashboard'
// because, like those two, it replaces the whole window content instead of
// swapping activePage inside app-shell's <main>.
export type AppView = 'loading' | 'welcome' | 'onboarding' | 'dashboard' | 'account-center'
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
    && left.detectionFailed === right.detectionFailed
    && left.detectionError === right.detectionError
}

/**
 * A probe throwing must read as "detection failed", never as "not installed" —
 * the two states drive very different UI (retry a rescan vs. offer to install
 * something that may already be on the user's machine).
 */
export function isDetectionFailed(status: { detectionFailed?: boolean }): boolean {
  return status.detectionFailed === true
}

export function codexDesktopLaunchDecision(
  platform: PlatformCapabilities,
  running: boolean,
): 'open' | 'choose' {
  return running && platform.platform !== 'macos' ? 'choose' : 'open'
}

/**
 * Drives the post-loading welcome-page gate: a brand-new install (no
 * provider ever configured with a valid 星芒 relay key) sees the welcome
 * page first; anyone who has configured at least one CLI before — even a
 * different one than whichever the caller is about to route to onboarding
 * for — is a returning user and must skip straight past it. Checking across
 * every provider (not just the one the caller is currently gating) is what
 * keeps existing users from being re-shown the welcome page.
 */
export function shouldShowWelcome(config: AppConfigSummary | null): boolean {
  if (!config) return false
  return Object.values(config.providers).every((provider) => !provider.hasApiKey || !provider.matchesRelay)
}

/**
 * Decides between the two non-dashboard startup destinations (App.tsx's
 * initialize() effect only reaches this once getCodexReadiness() itself came
 * back negative -- codexReady already routes straight to 'dashboard' before
 * this is ever called). An authenticated 星芒 account is itself returning-user
 * evidence, same in spirit as shouldShowWelcome()'s "any provider configured"
 * check: W2 (docs/ACCOUNT-PLAN.md) persists login across restarts specifically
 * so a signed-in user is never made to sit through the marketing welcome page
 * again, even on a machine where no CLI has been configured yet (e.g. right
 * after signing in on a fresh install, before onboarding has run). Preview
 * mode still wins outright, unchanged from before this function existed.
 */
export function resolveInitialAppView(
  config: AppConfigSummary | null,
  accountAuthenticated: boolean,
  previewOnboarding: boolean,
): 'welcome' | 'onboarding' {
  if (previewOnboarding) return 'onboarding'
  if (accountAuthenticated) return 'onboarding'
  return shouldShowWelcome(config) ? 'welcome' : 'onboarding'
}

/**
 * Dev-only override for XINGMANG_ONBOARDING_PREVIEW, mirroring the `?theme=`
 * override `initialTheme()` reads below. main.ts only ever appends
 * `?onboardingPreview=1` to the renderer URL when its own preview flag is
 * set — which itself requires `!app.isPackaged` — so this reads back false
 * in any packaged build. Preview mode also clears the in-memory config
 * (see system-service.ts buildConfigSummary), which would otherwise make
 * shouldShowWelcome() true and strand the preview behind the welcome page;
 * the startup gate reads this flag to route straight to onboarding instead.
 */
export function initialOnboardingPreview(search: string): boolean {
  return new URLSearchParams(search).get('onboardingPreview') === '1'
}

export async function commitStartupPlatformCapabilities(
  load: () => Promise<PlatformCapabilities>,
  commit: (capabilities: PlatformCapabilities) => void,
): Promise<void> {
  const capabilities = await load()
  commit(capabilities)
}

export function EmptyStatus(): SystemSnapshot {
  // Pre-scan placeholder, not a failed probe: `detectionFailed` stays absent
  // so cards render as "not yet checked" (via the `scanning` flag) rather
  // than surfacing a retry prompt before the first scan ever ran.
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
