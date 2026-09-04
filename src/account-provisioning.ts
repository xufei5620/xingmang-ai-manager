// Core CLI configuration value chain. Account-managed keys are provisioned
// and written entirely in Electron's main process, so their plaintext never
// enters renderer memory.
import { providerIds, type AppConfigSummary, type ProviderId, type SystemSnapshot } from './types'

export interface ManagedCliProvisioningApi {
  configureManagedCliKeys(input: {
    providers: ProviderId[]
    preferredModels: Partial<Record<ProviderId, string>>
  }): Promise<CliKeyProvisioningOutcome>
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
 * Asks the main process to ensure each selected provider's dedicated group
 * key and write it to that provider's config. The result contains provider
 * ids and failures only; no plaintext key crosses IPC.
 */
export function sanitizePreferredModels(
  preferredModels: Partial<Record<ProviderId, string>>,
): Partial<Record<ProviderId, string>> {
  const sanitized: Partial<Record<ProviderId, string>> = {}
  for (const provider of providerIds) {
    const model = preferredModels[provider]
    if (typeof model === 'string' && model.trim()) sanitized[provider] = model.trim()
  }
  return sanitized
}

export async function configureManagedCliKeysForInstalledClis(
  installedProviders: readonly ProviderId[],
  preferredModels: Partial<Record<ProviderId, string>>,
  api: ManagedCliProvisioningApi,
): Promise<CliKeyProvisioningOutcome> {
  if (installedProviders.length === 0) return { configured: [], failed: [] }
  return api.configureManagedCliKeys({
    providers: [...installedProviders],
    preferredModels: sanitizePreferredModels(preferredModels),
  })
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
export function buildProvisioningTargets(
  snapshot: SystemSnapshot,
  excludedProviders: readonly ProviderId[] = [],
): ProviderId[] {
  const excluded = new Set(excludedProviders)
  return providerIds.filter((id) => !excluded.has(id) && snapshot.clis[id].installed)
}

/**
 * Verifies the durable renderer-safe projection after managed configuration
 * writes. A resolved IPC call is not enough to admit the user to the dashboard:
 * every installed target must read back with a key, the active relay URL, and a
 * concrete model.
 */
export function validateProvisionedCliConfigs(
  targets: readonly ProviderId[],
  config: AppConfigSummary,
  excludedProviders: readonly ProviderId[] = [],
): Array<{ provider: ProviderId; message: string }> {
  const excluded = new Set(excludedProviders)
  return targets.flatMap((provider) => {
    if (excluded.has(provider)) return []
    const summary = config.providers[provider]
    if (!summary?.hasApiKey) return [{ provider, message: '配置文件未检测到 API Key' }]
    if (!summary.matchesRelay) return [{ provider, message: 'Base URL 未指向当前星芒站点' }]
    if (!summary.model.trim()) return [{ provider, message: '默认模型未写入配置' }]
    if (provider === 'gemini' && 'authType' in summary && summary.authType !== 'gemini-api-key') {
      return [{ provider, message: 'Gemini 未切换到 API Key 模式' }]
    }
    return []
  })
}

/**
 * Revalidates the account bootstrap checkpoint against current machine state.
 * A user may install another supported CLI, edit a config file, or switch the
 * relay after the checkpoint was written; any such drift must re-enter the
 * managed repair flow instead of being hidden by a stale completion marker.
 */
export function managedCliConfigsReadyForDashboard(
  snapshot: SystemSnapshot,
  config: AppConfigSummary,
  excludedProviders: readonly ProviderId[] = [],
): boolean {
  return validateProvisionedCliConfigs(
    buildProvisioningTargets(snapshot, excludedProviders),
    config,
    excludedProviders,
  ).length === 0
}

export type CliProvisioningGate = 'requires-login' | 'requires-install' | 'ready'

/**
 * Gates a user-initiated "配置星芒 Key" click (the 下一步 task card's action and
 * the account-area manual re-trigger both call this before touching any
 * state -- see App.tsx's handleConfigureCliKey) so the caller can react
 * distinctly instead of the offer silently doing nothing:
 *
 * - Not signed in: offerCliProvisioning would be meaningless (there is no
 *   session for provisionCliKey() to mint a key against) -- the caller must
 *   redirect to login/register instead of opening a dialog that can only
 *   fail.
 * - Signed in but nothing installed yet: buildProvisioningTargets would
 *   return an empty list and offerCliProvisioning silently no-ops. That
 *   silence is correct right after a login/register submit (the user did not
 *   just ask for this), but a dead click is bad UX when the user explicitly
 *   pressed a "配置" button -- the caller should say so instead.
 * - Otherwise: safe to call offerCliProvisioning for real.
 */
export function resolveCliProvisioningGate(
  authenticated: boolean,
  snapshot: SystemSnapshot,
  excludedProviders: readonly ProviderId[] = [],
): CliProvisioningGate {
  if (!authenticated) return 'requires-login'
  return buildProvisioningTargets(snapshot, excludedProviders).length === 0 ? 'requires-install' : 'ready'
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
