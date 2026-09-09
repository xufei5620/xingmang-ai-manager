import type { AccountIdentitySource } from './active-identity'
import { createSiteRuntime, requireXmSiteRuntimeDefinition, type SiteRuntime, type SiteRuntimeDefinition } from './site-runtime'
import { providerIds } from './catalog'

export interface BackendRegistry<T extends AccountIdentitySource> {
  get(siteId: unknown): SiteRuntime<T>
}

function definitionKey(definition: SiteRuntimeDefinition): string {
  return JSON.stringify([
    definition.siteId, definition.realmId, definition.backend,
    definition.accountOrigin, definition.aiBaseUrl,
    ...providerIds.map((provider) => definition.providerBaseUrls[provider]),
  ])
}

/**
 * Lazy, xm-only registry. Legacy ids share one account client, rather than
 * creating a logged-out clone for canvas or a second session for an alias.
 * A second backend is NOT enabled by merely adding a relaySites entry.
 *
 * The factory is main-process-owned and receives only validated, frozen
 * routing metadata. It must construct a client without logging in or
 * emitting a session-change event synchronously during construction.
 */
export function createBackendRegistry<T extends AccountIdentitySource>(
  createClient: (definition: SiteRuntimeDefinition) => T,
): BackendRegistry<T> {
  let runtime: SiteRuntime<T> | undefined
  let key: string | undefined
  let constructing = false

  function get(siteId: unknown): SiteRuntime<T> {
    // Validate EVERY selection before inspecting the cache: otherwise an
    // unknown site might receive an already authenticated xm client.
    const definition = requireXmSiteRuntimeDefinition(siteId)
    const requestedKey = definitionKey(definition)
    if (runtime) {
      if (key !== requestedKey) throw new Error('站点配置已变化，请重启应用')
      return runtime
    }
    if (constructing) throw new Error('账号运行时正在初始化')
    constructing = true
    try {
      const created = createSiteRuntime(definition, createClient(definition))
      runtime = created
      key = requestedKey
      return created
    } finally {
      // A failed factory must not poison the cache or prevent retry.
      constructing = false
    }
  }

  return Object.freeze({ get })
}
