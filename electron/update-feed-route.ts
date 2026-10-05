import type { GenericServerOptions } from 'builder-util-runtime'
import { parseDocument } from 'yaml'
import { readBoundedUtf8FileSync } from './bounded-file'
import type { RelayEndpointId } from './relay-sites'

const primaryUpdateUrl = 'https://updatesnew.shenfengwl.fun/xingmang-manager/'
const directUpdateUrl = 'https://38.147.105.28:8443/xingmang-manager/'
const maxUpdateConfigBytes = 16 * 1024
const defaultConfigKeys = new Set(['provider', 'url', 'publisherName', 'updaterCacheDirName'])

export interface UpdateFeedRouteOptions {
  activeSolovEndpointId: RelayEndpointId
  platform: string
  isPackaged: boolean
  localBuild?: boolean
}

export interface DirectUpdateFeed {
  feed: GenericServerOptions
  serviceStatusUrl: string
}

function usesDirectUpdateFeed(options: UpdateFeedRouteOptions): boolean {
  return options.activeSolovEndpointId === 'direct'
    && options.platform === 'win32'
    && options.isPackaged
    && options.localBuild !== true
}

/**
 * The mirror serves the existing release bytes, manifests and withdrawal file.
 * It is a fixed transport for the standard Windows release only: custom feeds
 * (including build-time XINGMANG_UPDATE_URL), channels and provider options stay
 * authoritative. Do not derive this URL from an account URL or copy credentials.
 */
export function resolveDirectUpdateFeed(configText: string, options: UpdateFeedRouteOptions): DirectUpdateFeed | null {
  if (!usesDirectUpdateFeed(options) || Buffer.byteLength(configText, 'utf8') > maxUpdateConfigBytes) return null
  try {
    const document = parseDocument(configText, {
      schema: 'core',
      customTags: [],
      resolveKnownTags: false,
      merge: false,
      strict: true,
      uniqueKeys: true,
      logLevel: 'silent',
    })
    if (document.errors.length || document.warnings.length) return null
    const config: unknown = document.toJS({ maxAliasCount: 0 })
    if (typeof config !== 'object' || config === null || Array.isArray(config)) return null
    if (!('provider' in config) || config.provider !== 'generic' || !('url' in config) || config.url !== primaryUpdateUrl) return null
    if (Object.keys(config).some((key) => !defaultConfigKeys.has(key))) return null
    return {
      feed: { provider: 'generic', url: directUpdateUrl },
      serviceStatusUrl: new URL('service-status.json', directUpdateUrl).href,
    }
  } catch {
    return null
  }
}

export function locateDirectUpdateFeed(configPath: string, options: UpdateFeedRouteOptions): DirectUpdateFeed | null {
  if (!usesDirectUpdateFeed(options)) return null
  try {
    return resolveDirectUpdateFeed(readBoundedUtf8FileSync(configPath, maxUpdateConfigBytes, '更新配置'), options)
  } catch {
    return null
  }
}
