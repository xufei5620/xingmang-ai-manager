import { providerIds, type ProviderId } from './catalog'
import { requireRelaySite } from './relay-sites'
import {
  createActiveIdentityReader,
  type AccountIdentitySource,
  type ActiveIdentityReader,
} from './active-identity'

/** Fixed routing for the xm-only rollout, not a user-editable server profile. */
export interface SiteRuntimeDefinition {
  readonly siteId: 'solov' | 'solov-api'
  readonly realmId: 'xm-account' | 'api-account'
  readonly backend: 'new-api' | 'sub2api'
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
export function requireSiteRuntimeDefinition(siteId: unknown): SiteRuntimeDefinition {
  const selected = requireRelaySite(siteId)
  if (selected.id === 'sub2api') {
    const primary = requireRelaySite('solov')
    const primaryOrigin = validatedUrl(primary.accountBaseUrl, true).origin
    if (validatedUrl(selected.accountBaseUrl, true).origin !== primaryOrigin
      || providerIds.some((provider) => selected.providerBaseUrls[provider] !== primary.providerBaseUrls[provider])) {
      const sameOrigin = validatedUrl(selected.accountBaseUrl, true).origin === primaryOrigin
      throw new Error(sameOrigin ? '站点账号与 AI 路由配置不一致' : '历史站点别名与账号域不一致')
    }
    return requireSiteRuntimeDefinition('solov')
  }
  const accountOrigin = validatedUrl(selected.accountBaseUrl, true).origin
  const providerBaseUrls = { ...selected.providerBaseUrls }
  for (const provider of providerIds) {
    const url = validatedUrl(providerBaseUrls[provider], provider === 'claude')
    if (url.origin !== accountOrigin) throw new Error('站点账号与 AI 路由配置不一致')
  }
  return Object.freeze({
    siteId: selected.accountBackend === 'sub2api' ? 'solov-api' : 'solov',
    realmId: selected.accountBackend === 'sub2api' ? 'api-account' : 'xm-account',
    backend: selected.accountBackend,
    accountOrigin,
    aiBaseUrl: providerBaseUrls.claude,
    providerBaseUrls: Object.freeze(providerBaseUrls),
  })
}
/** Backwards-compatible guard for callers that intentionally require xm. */
export function requireXmSiteRuntimeDefinition(siteId: unknown): SiteRuntimeDefinition {
  if (siteId === 'solov-api') {
    throw new Error('未知中转站点')
  }
  const definition = requireSiteRuntimeDefinition(siteId)
  if (definition.backend !== 'new-api') throw new Error('该站点账号后端尚未启用')
  return definition
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
