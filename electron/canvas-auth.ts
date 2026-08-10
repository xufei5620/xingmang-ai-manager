import type { CanvasAuthToken } from './canvas-ai-config'

// Deliberately a pure-ish function taking injected dependencies rather than
// importing SystemService/NewApiClientService directly, so it can be unit
// tested with fakes the same way src/account-provisioning.ts is -- see
// CLAUDE.md section 6 ("新逻辑优先写成纯函数再测").
export interface CanvasAuthTokenDependencies {
  /**
   * Whether the active relay site has an account backend to gate on and mint
   * keys from (accountBackend === 'new-api'). A manual-key site has neither:
   * the only credential that can exist is the relay key the user already
   * pasted into the CLI configs.
   */
  hasAccountBackend(): boolean
  /** Synchronous, in-memory only -- never touches the network. */
  isAccountAuthenticated(): boolean
  /**
   * Synchronous, local-disk only (reads already-written CLI config files via
   * SystemService.revealApiKey) -- never touches the network. Returns '' if
   * no installed CLI has a relay key configured yet.
   */
  revealConfiguredRelayKey(): string
  /**
   * Mints a fresh relay key via the account service's provisionCliKey() --
   * the one call in this module that reaches xm.solov.cc. Only invoked when
   * the account is authenticated but no already-configured key was found
   * locally, so this never runs for a logged-out user and never runs twice
   * for a user who already has at least one CLI configured.
   */
  provisionRelayKey(): Promise<string>
  /** Optional: observe a provisioning failure without surfacing it to canvas. */
  onProvisionError?(error: unknown): void
}

/**
 * Resolves the { baseUrl, apiKey } to hand the canvas window, or null when
 * there is nothing to give it (not logged in, or provisioning failed) -- in
 * every "null" case canvas is left to fall back to its own config UI, never
 * an error. See buildCanvasAiConfigInjection (canvas-ai-config.ts) for what
 * happens to this value next.
 */
export async function resolveCanvasAuthToken(
  baseUrl: string,
  deps: CanvasAuthTokenDependencies,
): Promise<CanvasAuthToken | null> {
  if (!deps.hasAccountBackend()) {
    // Manual-key site: no account exists to gate on, and there is nothing to
    // mint from -- the pasted relay key already written into the CLI configs
    // is the whole credential story. This mirrors what the CLIs themselves
    // run with on such a site, so canvas gets exactly the same key pairing,
    // never a broader one. No key configured yet -> canvas falls back to its
    // own config UI, same as the logged-out case below.
    const pastedKey = deps.revealConfiguredRelayKey().trim()
    return pastedKey ? { baseUrl, apiKey: pastedKey } : null
  }

  if (!deps.isAccountAuthenticated()) return null

  const existingKey = deps.revealConfiguredRelayKey().trim()
  if (existingKey) return { baseUrl, apiKey: existingKey }

  try {
    const provisionedKey = (await deps.provisionRelayKey()).trim()
    return provisionedKey ? { baseUrl, apiKey: provisionedKey } : null
  } catch (error) {
    deps.onProvisionError?.(error)
    return null
  }
}
