import type {
  AppConfigSummary,
  CodexSetupStatus,
  PlatformCapabilities,
  ProviderId,
} from './types'
import { isDetectionFailed } from './app-shared'

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'
export const CODEX_SETUP_STATUS_TIMEOUT_MS = 45_000

export type OnboardingSetupAction =
  | 'idle'
  | 'scanning'
  | 'installing-desktop'

export type OnboardingSetupPhase = 'environment' | 'desktop'

export interface ManagedCodexAuthorizationApi {
  configureManagedCliKeys(input: {
    providers: ProviderId[]
    preferredModels: Partial<Record<ProviderId, string>>
  }): Promise<{
    configured: ProviderId[]
    failed: Array<{ provider: ProviderId; message: string }>
  }>
  getConfig(): Promise<AppConfigSummary>
}

export interface CodexSetupApi {
  getCodexSetupStatus(): Promise<CodexSetupStatus>
  installCodexDesktop(): Promise<unknown>
  /**
   * Applies the official local zh-CN resources after the desktop package is
   * ready. This is optional so the pure setup flow remains usable by older
   * embedders and by tests that only model installation.
   */
  setCodexDesktopLocale?(locale: 'zh-CN'): Promise<unknown>
}

export interface CodexSetupCallbacks {
  onAction(action: OnboardingSetupAction): void
  onStatus(status: CodexSetupStatus): void
  onLog(message: string, mode: 'replace' | 'append'): void
}

export type CodexSetupResult =
  | { outcome: 'ready'; status: CodexSetupStatus }
  | { outcome: 'detection-failed'; status: CodexSetupStatus; message: string }
  | { outcome: 'desktop-recovery'; status: CodexSetupStatus; error: unknown }
  | { outcome: 'failed'; phase: OnboardingSetupPhase; status: CodexSetupStatus | null; error: unknown }

export type CodexAutomaticSetupResult = CodexSetupResult

export interface CodexAutomaticSetupOptions {
  detectionRetries?: number
  retryDelayMs?: number
  wait?: (delayMs: number) => Promise<void>
  statusTimeoutMs?: number
  /** Respect a user's explicit Codex Desktop uninstall choice. */
  skipDesktopInstall?: boolean
}

async function getCodexSetupStatusWithTimeout(
  api: CodexSetupApi,
  timeoutMs = CODEX_SETUP_STATUS_TIMEOUT_MS,
): Promise<CodexSetupStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      api.getCodexSetupStatus(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Codex Desktop 安装已完成，但环境复核超时；请点击“重新检测”继续')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Codex Desktop ships its Chinese resources, but newer builds only load the
 * web locale after the `enable_i18n` Statsig gate is enabled. Apply the
 * persisted locale as the final step of first-run setup so a fresh account
 * does not need to open a hidden maintenance screen or a browser setting.
 * Locale application is deliberately best-effort: a package without the
 * official resources must not block the rest of onboarding.
 */
async function applyCodexDesktopChineseLocale(
  api: CodexSetupApi,
  status: CodexSetupStatus,
  callbacks: CodexSetupCallbacks,
): Promise<void> {
  if (!status.desktop.installed || !api.setCodexDesktopLocale) return
  callbacks.onLog('正在应用 Codex Desktop 简体中文界面', 'append')
  try {
    await api.setCodexDesktopLocale('zh-CN')
    callbacks.onLog('Codex Desktop 简体中文界面已准备完成', 'append')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    callbacks.onLog(`简体中文界面暂未应用：${detail || '本地资源不可用'}；不影响继续使用`, 'append')
  }
}

/**
 * Node.js, npm and Codex CLI are optional during onboarding, so only the
 * desktop-app probe can block its installer. A failed desktop probe must not
 * be reinterpreted as "confirmed missing" or the flow could reinstall over an
 * existing Appx registration whose metadata was temporarily unreadable.
 */
export function buildCodexDetectionFailureMessage(status: CodexSetupStatus): string | null {
  return isDetectionFailed(status.desktop)
    ? 'Codex 桌面端暂时无法确认状态，请重试检测'
    : null
}

/**
 * Configures Codex from the signed-in account's locally cached managed key.
 * The main process owns key lookup, model validation and the config write, so
 * relay key plaintext never enters renderer state or crosses the normal IPC
 * response boundary.
 */
export async function authorizeManagedCodex(
  api: ManagedCodexAuthorizationApi,
): Promise<AppConfigSummary> {
  const outcome = await api.configureManagedCliKeys({
    providers: ['codex'],
    preferredModels: { codex: DEFAULT_CODEX_MODEL },
  })
  if (!outcome.configured.includes('codex')) {
    const failure = outcome.failed.find((entry) => entry.provider === 'codex')
    throw new Error(failure?.message ?? 'Codex 专属 Key 尚未就绪')
  }
  return api.getConfig()
}

export async function prepareCodexEnvironment(
  api: CodexSetupApi,
  callbacks: CodexSetupCallbacks,
  capabilities?: PlatformCapabilities,
  statusTimeoutMs = CODEX_SETUP_STATUS_TIMEOUT_MS,
  skipDesktopInstall = false,
): Promise<CodexSetupResult> {
  let phase: OnboardingSetupPhase = 'environment'
  let status: CodexSetupStatus | null = null
  callbacks.onAction('scanning')

  try {
    status = await getCodexSetupStatusWithTimeout(api, statusTimeoutMs)
    callbacks.onStatus(status)
    const detectionFailureMessage = buildCodexDetectionFailureMessage(status)
    if (detectionFailureMessage) {
      callbacks.onAction('idle')
      return { outcome: 'detection-failed', status, message: detectionFailureMessage }
    }
    if (!status.desktop.installed && (skipDesktopInstall || capabilities?.codexDesktop.install === 'external')) {
      callbacks.onAction('idle')
      return { outcome: 'ready', status }
    }

    if (!status.desktop.installed) {
      phase = 'desktop'
      callbacks.onAction('installing-desktop')
      callbacks.onLog('正在准备 Codex 桌面端最新版', 'append')
      try {
        await api.installCodexDesktop()
        callbacks.onLog('Codex Desktop 安装命令已完成，正在确认安装结果', 'append')
        status = await getCodexSetupStatusWithTimeout(api, statusTimeoutMs)
        callbacks.onStatus(status)
        if (!status.desktop.installed) {
          throw new Error('Codex 桌面端安装完成后仍未检测到应用，请使用微软商店安装或稍后重试')
        }
      } catch (error) {
        callbacks.onAction('idle')
        return { outcome: 'desktop-recovery', status, error }
      }
    }

    await applyCodexDesktopChineseLocale(api, status, callbacks)

    callbacks.onAction('idle')
    return { outcome: 'ready', status }
  } catch (error) {
    callbacks.onAction('idle')
    return { outcome: 'failed', phase, status, error }
  }
}

/**
 * Runs the desktop-only managed first-run chain. Node.js, npm and Codex CLI
 * remain available from maintenance, but their state cannot trigger an
 * install or block onboarding. Desktop detection failures remain retry-only.
 */
export async function prepareCodexEnvironmentAutomatically(
  api: CodexSetupApi,
  callbacks: CodexSetupCallbacks,
  capabilities?: PlatformCapabilities,
  options: CodexAutomaticSetupOptions = {},
): Promise<CodexAutomaticSetupResult> {
  const detectionRetries = Math.max(0, Math.floor(options.detectionRetries ?? 2))
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 750))
  const statusTimeoutMs = Math.max(1_000, Math.floor(options.statusTimeoutMs ?? CODEX_SETUP_STATUS_TIMEOUT_MS))
  const wait = options.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs)
  }))
  let setup = await prepareCodexEnvironment(api, callbacks, capabilities, statusTimeoutMs, options.skipDesktopInstall)
  for (let attempt = 0; setup.outcome === 'detection-failed' && attempt < detectionRetries; attempt += 1) {
    callbacks.onLog(`Codex Desktop 检测暂时失败，正在自动重试（${attempt + 1}/${detectionRetries}）`, 'append')
    await wait(retryDelayMs)
    setup = await prepareCodexEnvironment(api, callbacks, capabilities, statusTimeoutMs, options.skipDesktopInstall)
  }
  return setup
}
