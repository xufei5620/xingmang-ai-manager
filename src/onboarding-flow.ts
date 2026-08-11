import type {
  AppConfigSummary,
  CodexSetupStatus,
  NodeRuntimeInstallResult,
  PlatformCapabilities,
  ProviderId,
} from './types'
import { isDetectionFailed } from './app-shared'
import { codexRuntimeSetupMessage, nodeRuntimeSupported } from './onboarding-runtime'

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'

export type OnboardingSetupAction =
  | 'idle'
  | 'scanning'
  | 'installing-node'
  | 'installing-cli'
  | 'installing-desktop'

export type OnboardingSetupPhase = 'environment' | 'cli' | 'desktop'

export interface CodexAuthorizationApi {
  listModels(apiKey: string): Promise<string[]>
  saveConfig(payload: {
    provider: 'codex'
    apiKey: string
    model: string
    mode: 'reset'
  }): Promise<unknown>
  getConfig(): Promise<AppConfigSummary>
}

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
  installCli(provider: 'codex'): Promise<unknown>
  installCodexDesktop(): Promise<unknown>
}

export interface CodexNodeInstallApi extends CodexSetupApi {
  installNodeRuntime(): Promise<NodeRuntimeInstallResult>
}

export interface CodexSetupCallbacks {
  onAction(action: OnboardingSetupAction): void
  onStatus(status: CodexSetupStatus): void
  onLog(message: string, mode: 'replace' | 'append'): void
}

export type CodexSetupResult =
  | { outcome: 'ready'; status: CodexSetupStatus }
  | { outcome: 'runtime-required'; status: CodexSetupStatus; message: string }
  | { outcome: 'detection-failed'; status: CodexSetupStatus; message: string }
  | { outcome: 'desktop-recovery'; status: CodexSetupStatus; error: unknown }
  | { outcome: 'failed'; phase: OnboardingSetupPhase; status: CodexSetupStatus | null; error: unknown }

export type CodexNodeInstallResult =
  | { outcome: 'setup'; setup: CodexSetupResult }
  | { outcome: 'node-failed'; status: CodexSetupStatus | null; error: unknown }

/**
 * A probe that threw must not be reinterpreted as "confirmed missing" this
 * far downstream either: left unchecked, `prepareCodexEnvironment` would
 * read a detection failure as "not installed" and either show a misleading
 * "please install" prompt or — worse — silently kick off `installCli`/
 * `installCodexDesktop` on top of a tool that may already be working.
 * Checked once, right after the status fetch, so it wins over every
 * installed/not-installed branch below rather than needing to be threaded
 * through each of them individually.
 */
export function buildCodexDetectionFailureMessage(status: CodexSetupStatus): string | null {
  const failedLabels = [
    isDetectionFailed(status.runtime.node) ? 'Node.js' : null,
    isDetectionFailed(status.runtime.npm) ? 'npm' : null,
    isDetectionFailed(status.cli) ? 'Codex CLI' : null,
    isDetectionFailed(status.desktop) ? 'Codex 桌面端' : null,
  ].filter((label): label is string => label !== null)
  if (failedLabels.length === 0) return null
  return `${failedLabels.join('、')}暂时无法确认状态，请重试检测`
}

export async function authorizeCodex(
  rawApiKey: string,
  api: CodexAuthorizationApi,
): Promise<AppConfigSummary> {
  const apiKey = rawApiKey.trim()
  if (!apiKey) throw new Error('请填写安装授权码')

  const models = await api.listModels(apiKey)
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('当前 API Key 没有返回可用模型')
  }
  if (!models.includes(DEFAULT_CODEX_MODEL)) {
    throw new Error(`当前授权码不支持默认模型 ${DEFAULT_CODEX_MODEL}`)
  }

  await api.saveConfig({
    provider: 'codex',
    apiKey,
    model: DEFAULT_CODEX_MODEL,
    mode: 'reset',
  })
  return api.getConfig()
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
): Promise<CodexSetupResult> {
  let phase: OnboardingSetupPhase = 'environment'
  let status: CodexSetupStatus | null = null
  callbacks.onAction('scanning')

  try {
    status = await api.getCodexSetupStatus()
    callbacks.onStatus(status)
    const detectionFailureMessage = buildCodexDetectionFailureMessage(status)
    if (detectionFailureMessage) {
      callbacks.onAction('idle')
      return { outcome: 'detection-failed', status, message: detectionFailureMessage }
    }
    const runtimeError = codexRuntimeSetupMessage(status.runtime)
    if (runtimeError) {
      callbacks.onAction('idle')
      return { outcome: 'runtime-required', status, message: runtimeError }
    }

    if (!status.cli.installed) {
      phase = 'cli'
      callbacks.onAction('installing-cli')
      callbacks.onLog('正在安装 @openai/codex@latest', 'replace')
      await api.installCli('codex')
      status = await api.getCodexSetupStatus()
      callbacks.onStatus(status)
    }

    if (!status.cli.installed) {
      throw new Error('Codex CLI 安装完成后仍未检测到命令，请重新检测环境')
    }

    if (!status.desktop.installed && capabilities?.codexDesktop.install === 'external') {
      callbacks.onAction('idle')
      return { outcome: 'ready', status }
    }

    if (!status.desktop.installed) {
      phase = 'desktop'
      callbacks.onAction('installing-desktop')
      callbacks.onLog('正在准备 Codex 桌面端最新版', 'append')
      try {
        await api.installCodexDesktop()
        status = await api.getCodexSetupStatus()
        callbacks.onStatus(status)
        if (!status.desktop.installed) {
          throw new Error('Codex 桌面端安装完成后仍未检测到应用，请使用微软商店安装或稍后重试')
        }
      } catch (error) {
        callbacks.onAction('idle')
        return { outcome: 'desktop-recovery', status, error }
      }
    }

    callbacks.onAction('idle')
    return { outcome: 'ready', status }
  } catch (error) {
    callbacks.onAction('idle')
    return { outcome: 'failed', phase, status, error }
  }
}

export async function installNodeAndPrepareCodexEnvironment(
  api: CodexNodeInstallApi,
  callbacks: CodexSetupCallbacks,
  capabilities?: PlatformCapabilities,
): Promise<CodexNodeInstallResult> {
  let status: CodexSetupStatus | null = null
  callbacks.onAction('installing-node')
  callbacks.onLog('正在准备 Node.js LTS 安装', 'replace')

  try {
    await api.installNodeRuntime()
    status = await api.getCodexSetupStatus()
    callbacks.onStatus(status)
    if (!nodeRuntimeSupported(status.runtime) || !status.runtime.npm.installed) {
      throw new Error('安装已完成，但程序仍未识别到受支持的 Node.js 或 npm，请重启星芒AI管理工具后重新检测')
    }
    callbacks.onAction('idle')
    return {
      outcome: 'setup',
      setup: await prepareCodexEnvironment(api, callbacks, capabilities),
    }
  } catch (error) {
    callbacks.onAction('idle')
    return { outcome: 'node-failed', status, error }
  }
}
