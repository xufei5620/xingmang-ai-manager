import type {
  CodexSetupStatus,
  CodexDesktopInstallProgress,
  DesktopAppStatus,
  PlatformCapabilities,
  SystemSnapshot,
} from './types'
import { nodeRuntimeSupported } from './onboarding-runtime'

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
export const MANAGED_BOOTSTRAP_STORAGE_PREFIX = 'xingmang-managed-bootstrap-v1:'

interface BootstrapStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function bootstrapStorage(): BootstrapStorage | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

export function managedBootstrapCompleted(
  userId: number,
  storage: BootstrapStorage | null = bootstrapStorage(),
): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false
  try {
    return storage?.getItem(`${MANAGED_BOOTSTRAP_STORAGE_PREFIX}${userId}`) === '1'
  } catch {
    return false
  }
}

export function markManagedBootstrapCompleted(
  userId: number,
  storage: BootstrapStorage | null = bootstrapStorage(),
): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) return
  try {
    storage?.setItem(`${MANAGED_BOOTSTRAP_STORAGE_PREFIX}${userId}`, '1')
  } catch {
    // A storage failure only makes the next launch verify the bootstrap again.
  }
}

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
 * The persisted CLI config alone is not a completed first-run checkpoint.
 * Startup may happen after the app was closed between config write, runtime
 * installation, CLI installation, and desktop installation. Rechecking the
 * durable machine state makes the bootstrap naturally resumable.
 */
export function codexSetupReadyForDashboard(
  status: CodexSetupStatus,
  platform: PlatformCapabilities,
): boolean {
  return !isDetectionFailed(status.runtime.node)
    && !isDetectionFailed(status.runtime.npm)
    && !isDetectionFailed(status.cli)
    && !isDetectionFailed(status.desktop)
    && nodeRuntimeSupported(status.runtime)
    && status.runtime.npm.installed
    && status.cli.installed
    && (status.desktop.installed || platform.codexDesktop.install === 'external')
}

/**
 * Decides the non-dashboard startup destination. 登录先行(老板拍板
 * 2026-08-10):在有账号后端的站点上,未登录用户一律先到欢迎页走
 * 登录/注册——即使这台机器的 CLI 早已配置齐全,也不再凭"配过任一
 * CLI"直进(旧 shouldShowWelcome 规则已废),这样登录成功后账号侧才能
 * 为用户自动签发 API Key。An authenticated 星芒 account routes to
 * onboarding/dashboard as before -- W2 (docs/ACCOUNT-PLAN.md) persists
 * login across restarts specifically so a signed-in user is never made to
 * sit through the welcome page again. A manual-key site has no account
 * backend to log into, so it keeps the pre-account behavior. Preview mode
 * still wins outright.
 *
 * App.tsx's initialize() also consults this gate's inputs before its
 * codexReady fast path: dashboard is only entered directly when the login
 * requirement is already satisfied (authenticated or manual-key site).
 */
export function resolveInitialAppView(
  accountAuthenticated: boolean,
  previewOnboarding: boolean,
  // True when the active relay site has no account backend of its own
  // (relay-sites.ts's accountBackend: 'manual-key'). The welcome page's whole
  // value proposition is "注册/登录星芒账号", which such a site does not
  // offer -- routing straight to onboarding avoids stranding the user on a
  // sign-up screen they cannot act on.
  manualKeySite = false,
): 'welcome' | 'onboarding' {
  if (previewOnboarding) return 'onboarding'
  if (accountAuthenticated) return 'onboarding'
  if (manualKeySite) return 'onboarding'
  return 'welcome'
}

/**
 * Dev-only override for XINGMANG_ONBOARDING_PREVIEW, mirroring the `?theme=`
 * override `initialTheme()` reads below. main.ts only ever appends
 * `?onboardingPreview=1` to the renderer URL when its own preview flag is
 * set — which itself requires `!app.isPackaged` — so this reads back false
 * in any packaged build. resolveInitialAppView() lets this flag win over
 * every other rule so the preview can never strand behind the welcome page.
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
