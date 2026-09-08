import { providerIds, type ProviderId } from './catalog'
import { requireRelaySite } from './relay-sites'
import {
  createActiveIdentityReader,
  type AccountIdentitySource,
  type ActiveIdentityReader,
} from './active-identity'

/** Fixed routing for the xm-only rollout, not a user-editable server profile. */
export interface SiteRuntimeDefinition {
  readonly siteId: 'solov'
  readonly realmId: 'xm-account'
  readonly backend: 'new-api'
  readonly accountOrigin: string
  readonly aiBaseUrl: string
  readonly providerBaseUrls: Readonly<Record<ProviderId, string>>
}

export interface SiteRuntime<T extends AccountIdentitySource> {
  readonly definition: SiteRuntimeDefinition
  readonly accountService: T
  readonly identities: ActiveIdentityReader
}

function validatedUrl(value: unknown, requireOrigin: boolean): URL {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error('站点地址配置无效')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('站点地址配置无效')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || (requireOrigin && url.pathname !== '/')) {
    throw new Error('站点地址配置无效')
  }
  return url
}

/**
 * Resolve an explicit selection; callers recovering optional settings must
 * call resolveRelaySite at that boundary first. Do not put that tolerant
 * fallback here: a future, unimplemented site must never get an xm client.
 *
 * The persisted sub2api id remains unchanged in settings. Only runtime
 * ownership is canonicalized, since both historical ids denote xm today.
 * This deliberately rejects every other site, even if added to relaySites.
 */
export function requireXmSiteRuntimeDefinition(siteId: unknown): SiteRuntimeDefinition {
  const selected = requireRelaySite(siteId)
  if (selected.id !== 'solov' && selected.id !== 'sub2api') {
    throw new Error('该站点账号后端尚未启用')
  }
  const primary = requireRelaySite('solov')
  if (primary.accountBackend !== 'new-api' || selected.accountBackend !== 'new-api') {
    throw new Error('该站点账号后端尚未启用')
  }
  const accountOrigin = validatedUrl(primary.accountBaseUrl, true).origin
  if (validatedUrl(selected.accountBaseUrl, true).origin !== accountOrigin) {
    throw new Error('历史站点别名与账号域不一致')
  }
  const providerBaseUrls = { ...primary.providerBaseUrls }
  for (const provider of providerIds) {
    const url = validatedUrl(providerBaseUrls[provider], provider === 'claude')
    if (url.origin !== accountOrigin || selected.providerBaseUrls[provider] !== providerBaseUrls[provider]) {
      throw new Error('站点账号与 AI 路由配置不一致')
    }
  }
  return Object.freeze({
    siteId: 'solov',
    realmId: 'xm-account',
    backend: 'new-api',
    accountOrigin,
    aiBaseUrl: providerBaseUrls.claude,
    providerBaseUrls: Object.freeze(providerBaseUrls),
  })
}

/** Main-process assembly only. The client itself must stay mutable for login/refresh. */
export function createSiteRuntime<T extends AccountIdentitySource>(
  definition: SiteRuntimeDefinition,
  accountService: T,
): SiteRuntime<T> {
  if (!accountService || typeof accountService.getSessionState !== 'function'
    || typeof accountService.getSessionRevision !== 'function') {
    throw new Error('账号后端缺少会话版本接口')
  }
  const snapshot = Object.freeze({
    ...definition,
    providerBaseUrls: Object.freeze({ ...definition.providerBaseUrls }),
  })
  return Object.freeze({
    definition: snapshot,
    accountService,
    identities: createActiveIdentityReader(snapshot, accountService),
  })
}
