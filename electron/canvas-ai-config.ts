// Pure construction of the value the canvas preload seeds into the canvas
// app's own persisted AI-config store, so a logged-in xingmang account's
// relay key is already filled in when infinite-canvas boots.
//
// Store shape reverse-engineered from the (read-only, not modified) canvas
// source at K:\星芒\xingmang-canvas\web\src\stores\use-config-store.ts:
// zustand's persist() middleware, with no `storage` override, so it defaults
// to localStorage (not IndexedDB -- see the report for this task; the
// canvas repo's own index.html reads a sibling store the same way via
// `localStorage.getItem('infinite-canvas:theme_store')`). The wire format is
// `{ state: { config, webdav }, version }`, and use-config-store.ts's own
// `merge()` is defensive enough (`{...defaultConfig, ...persistedConfig}`,
// channel-less config auto-normalized into a full default channel) that this
// module only ever needs to set the two fields that actually matter.

export const canvasAiConfigStorageKey = 'infinite-canvas:ai_config_store'

export interface CanvasAuthToken {
  baseUrl: string
  apiKey: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Builds the JSON string to write back to `canvasAiConfigStorageKey`, or
 * null when nothing should be written.
 *
 * - token === null: no-op. A missing/expired xingmang login must never blank
 *   out a key the user already typed into canvas's own config UI -- "no
 *   token" means "leave storage exactly as it is".
 * - a real key is already stored (ours from a previous run, or one the user
 *   typed in by hand -- canvasAiConfigHasApiKey() cannot tell the two apart,
 *   deliberately: see the report for this task on why "never clobber" beats
 *   "always resync" for this phase): no-op, so this is safe to call
 *   unconditionally on every canvas window open.
 * - token present, no prior stored value (or a value with no channels yet):
 *   only the top-level config.baseUrl/apiKey are set. use-config-store.ts's
 *   merge() treats an empty/absent `channels` array as "build one from
 *   scratch from config.model/imageModel/...", which is the only path that
 *   also populates a usable model list -- pre-seeding a channels array
 *   ourselves here would starve that fallback and ship a channel with zero
 *   selectable models.
 * - token present, channels already stored but with no key set anywhere
 *   (canvasAiConfigHasApiKey() false, e.g. defaultConfig's own empty-apiKey
 *   shape): only the "default" channel's baseUrl/apiKey are overwritten in
 *   place (its name/apiFormat/models and every other channel are preserved
 *   untouched), because actual API calls read from the resolved channel, not
 *   from the top-level config fields (see resolveModelRequestConfig in
 *   use-config-store.ts).
 */
export function buildCanvasAiConfigInjection(
  existingRaw: string | null,
  token: CanvasAuthToken | null,
): string | null {
  if (!token) return null
  const trimmedBaseUrl = token.baseUrl.trim()
  const trimmedApiKey = token.apiKey.trim()
  if (!trimmedBaseUrl || !trimmedApiKey) return null
  if (canvasAiConfigHasApiKey(existingRaw)) return null

  const parsed = parseRecord(existingRaw)
  const state = parsed && isRecord(parsed.state) ? parsed.state : null
  const config = state && isRecord(state.config) ? state.config : null
  const existingChannels = config && Array.isArray(config.channels) ? config.channels : null

  const nextConfig: Record<string, unknown> = {
    ...(config ?? {}),
    baseUrl: trimmedBaseUrl,
    apiKey: trimmedApiKey,
  }

  if (existingChannels && existingChannels.length > 0) {
    const defaultIndex = existingChannels.findIndex((channel) => isRecord(channel) && channel.id === 'default')
    const nextChannels = existingChannels.map((channel) => (isRecord(channel) ? { ...channel } : channel))
    const baseChannel = defaultIndex >= 0 && isRecord(nextChannels[defaultIndex]) ? nextChannels[defaultIndex] : {}
    const injectedChannel = { ...baseChannel, id: 'default', baseUrl: trimmedBaseUrl, apiKey: trimmedApiKey }
    if (defaultIndex >= 0) nextChannels[defaultIndex] = injectedChannel
    else nextChannels.unshift(injectedChannel)
    nextConfig.channels = nextChannels
  }
  // else: leave `channels` unset so canvas's own normalizeChannels()
  // fallback builds a fully-populated default channel (including its model
  // list) from the top-level baseUrl/apiKey just set above.

  const version = typeof parsed?.version === 'number' ? parsed.version : 0
  return JSON.stringify({
    ...(parsed ?? {}),
    state: { ...(state ?? {}), config: nextConfig },
    version,
  })
}

/**
 * True when the currently stored config already has a real (non-empty)
 * relay key somewhere -- top-level or on any channel. Used to decide whether
 * an auto-injection would clobber something the user already configured by
 * hand (including a channel they added themselves, not just "default").
 */
export function canvasAiConfigHasApiKey(existingRaw: string | null): boolean {
  const parsed = parseRecord(existingRaw)
  const state = parsed && isRecord(parsed.state) ? parsed.state : null
  const config = state && isRecord(state.config) ? state.config : null
  if (!config) return false
  if (typeof config.apiKey === 'string' && config.apiKey.trim()) return true
  if (!Array.isArray(config.channels)) return false
  return config.channels.some((channel) => (
    isRecord(channel) && typeof channel.apiKey === 'string' && channel.apiKey.trim()
  ))
}
