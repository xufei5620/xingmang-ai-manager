// Core "拿 Key -> 写进 CLI 配置" value chain (阶段 A task 4). Deliberately a
// pure function so it can be unit-tested with injected fakes instead of a
// real IPC bridge -- see CLAUDE.md section 6 ("新逻辑优先写成纯函数再测").
//
// I3 (plaintext never persisted): the key returned by provisionCliKey() lives
// only in this function's local `key` variable. It is handed straight to
// saveConfig() for each installed CLI and is never included in the returned
// CliKeyProvisioningOutcome, so a caller (App.tsx) can never end up holding
// it in React state -- the one in-memory copy the renderer process ever has
// goes out of scope the moment this promise settles.
import { errorMessage } from './error-message'
import { providerIds, type ProviderId, type SystemSnapshot } from './types'

export interface CliKeyProvisioningApi {
  provisionCliKey(): Promise<{ key: string }>
  listModels(apiKey: string): Promise<string[]>
  saveConfig(payload: {
    provider: ProviderId
    apiKey: string
    model: string
    mode: 'merge'
  }): Promise<unknown>
}

export interface CliKeyProvisioningFailure {
  provider: ProviderId
  message: string
}

export interface CliKeyProvisioningOutcome {
  configured: ProviderId[]
  failed: CliKeyProvisioningFailure[]
}

/**
 * Provisions a single new CLI key from the account service and writes it
 * into every already-installed CLI's config via the existing config-files.ts
 * write path (config:save / saveProviderConfig) -- no new on-disk write logic.
 * All installed CLIs share the one key: xm.solov.cc exposes a single relay
 * account, so there is no reason to mint one token per local tool.
 *
 * `preferredModels` lets the caller reuse each provider's currently
 * configured model (from AppConfigSummary) when it is still valid for the
 * freshly issued key; otherwise the first model the relay reports is used.
 * This mirrors onboarding-flow.ts's authorizeCodex(), which always re-lists
 * models for a key rather than trusting a remembered one.
 */
export async function provisionCliKeyForInstalledClis(
  installedProviders: readonly ProviderId[],
  preferredModels: Partial<Record<ProviderId, string>>,
  api: CliKeyProvisioningApi,
): Promise<CliKeyProvisioningOutcome> {
  if (installedProviders.length === 0) return { configured: [], failed: [] }

  const { key } = await api.provisionCliKey()

  let models: string[]
  try {
    models = await api.listModels(key)
  } catch (error) {
    const message = errorMessage(error)
    return { configured: [], failed: installedProviders.map((provider) => ({ provider, message })) }
  }
  if (models.length === 0) {
    return {
      configured: [],
      failed: installedProviders.map((provider) => ({ provider, message: '当前 Key 未返回可用模型' })),
    }
  }

  const configured: ProviderId[] = []
  const failed: CliKeyProvisioningFailure[] = []
  for (const provider of installedProviders) {
    const preferred = preferredModels[provider]
    const model = preferred && models.includes(preferred) ? preferred : models[0]
    try {
      await api.saveConfig({ provider, apiKey: key, model, mode: 'merge' })
      configured.push(provider)
    } catch (error) {
      failed.push({ provider, message: errorMessage(error) })
    }
  }
  return { configured, failed }
}

/**
 * Derives the "写入星芒 Key" confirmation dialog's candidate list from a
 * system snapshot: every provider currently reported as installed, in
 * canonical provider order (providerIds). Pure and side-effect-free so
 * App.tsx can call it straight off a snapshot ref, and so the dialog's
 * default-all-checked behavior is unit-testable without a real IPC round
 * trip -- see ProvisioningConfirmDialog.tsx, which seeds its selection state
 * from this function's result.
 */
export function buildProvisioningTargets(snapshot: SystemSnapshot): ProviderId[] {
  return providerIds.filter((id) => snapshot.clis[id].installed)
}

/**
 * Narrows the full candidate list down to whatever the user left checked in
 * ProvisioningConfirmDialog, preserving canonical order. A provider id that
 * is in `selected` but no longer in `targets` -- e.g. a stale selection
 * surviving a snapshot refresh -- is silently dropped rather than written,
 * since `targets` (not `selected`) drives the iteration.
 */
export function filterProvisioningTargets(
  targets: readonly ProviderId[],
  selected: ReadonlySet<ProviderId>,
): ProviderId[] {
  return targets.filter((provider) => selected.has(provider))
}
