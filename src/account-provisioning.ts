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

/**
 * The subset of the write chain that both provisioning paths share: mint (or
 * already hold) a key, validate it by listing its models, then write it into
 * each installed CLI's config. Split out from CliKeyProvisioningApi below so
 * writeCliKeyForInstalledClis (the 粘贴 Key path, W3b) can take exactly the
 * capability it needs without also requiring provisionCliKey -- a pasted key
 * never goes through the account service's own minting call.
 */
export interface CliKeyWriteApi {
  listModels(apiKey: string): Promise<string[]>
  saveConfig(payload: {
    provider: ProviderId
    apiKey: string
    model: string
    mode: 'merge'
  }): Promise<unknown>
}

export interface CliKeyProvisioningApi extends CliKeyWriteApi {
  provisionCliKey(): Promise<{ key: string }>
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
 * Writes an already-known key into every already-installed CLI's config via
 * the existing config-files.ts write path (config:save / saveProviderConfig
 * -- no new on-disk write logic). Shared by both provisioning paths:
 * provisionCliKeyForInstalledClis below hands it a freshly minted key, and
 * the 粘贴 Key flow (PasteKeyDialog.tsx, W3b) hands it whatever the user
 * typed in -- from this function's point of view the two are identical, it
 * never asks where `key` came from.
 *
 * `preferredModels` lets the caller reuse each provider's currently
 * configured model (from AppConfigSummary) when it is still valid for this
 * key; otherwise the first model the relay reports is used. This mirrors
 * onboarding-flow.ts's authorizeCodex(), which always re-lists models for a
 * key rather than trusting a remembered one.
 */
export async function writeCliKeyForInstalledClis(
  key: string,
  installedProviders: readonly ProviderId[],
  preferredModels: Partial<Record<ProviderId, string>>,
  api: CliKeyWriteApi,
): Promise<CliKeyProvisioningOutcome> {
  if (installedProviders.length === 0) return { configured: [], failed: [] }

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
 * Provisions a single new CLI key from the account service, then delegates
 * to writeCliKeyForInstalledClis for the actual write. All installed CLIs
 * share the one key: xm.solov.cc exposes a single relay account, so there is
 * no reason to mint one token per local tool.
 */
export async function provisionCliKeyForInstalledClis(
  installedProviders: readonly ProviderId[],
  preferredModels: Partial<Record<ProviderId, string>>,
  api: CliKeyProvisioningApi,
): Promise<CliKeyProvisioningOutcome> {
  if (installedProviders.length === 0) return { configured: [], failed: [] }

  const { key } = await api.provisionCliKey()
  return writeCliKeyForInstalledClis(key, installedProviders, preferredModels, api)
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
): CliProvisioningGate {
  if (!authenticated) return 'requires-login'
  return buildProvisioningTargets(snapshot).length === 0 ? 'requires-install' : 'ready'
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
