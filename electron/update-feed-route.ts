import type { GenericServerOptions } from 'builder-util-runtime'
import { parseDocument } from 'yaml'
import { readBoundedUtf8FileSync } from './bounded-file'
import { networkFailureCode } from './network-failure'
import { relayLineFailureReason, reportedRelayLineFailure } from './relay-line-fetch'
import type { RelayEndpointId } from './relay-sites'

const primaryUpdateUrl = 'https://updatesnew.shenfengwl.fun/xingmang-manager/'
const directUpdateUrl = 'https://xm-direct.solov.cc/xingmang-manager/'
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

/**
 * 包里写的那个标准更新目录。直连那份只在包里写的正是它时才会用上（resolveDirectUpdateFeed），
 * 所以从直连换回来时设回它，就是设回包里原来那份；别的包从不换地址，用不到它。
 */
export function packagedUpdateFeed(): DirectUpdateFeed {
  return {
    feed: { provider: 'generic', url: primaryUpdateUrl },
    serviceStatusUrl: new URL('service-status.json', primaryUpdateUrl).href,
  }
}

const directFeedFallbackStatuses: ReadonlySet<number> = new Set([404, 502, 503, 504])

function httpStatusCode(error: unknown): number | null {
  let current: unknown = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const record = current as { statusCode?: unknown; cause?: unknown }
    if (typeof record.statusCode === 'number') return record.statusCode
    current = record.cause
  }
  return null
}

/**
 * 在直连那份更新地址上没查通、换回包里那份有可能查得通时，说清是哪一种（只记日志用，不带地址）；
 * 换了也白换的返回 null。lineFailure：要报给线路那边查一轮健康检查的，只有网络层连不上一类和
 * 502 / 503 / 504（直连那边的网关出错）。直连回的 404 是白名单没放行那一个文件；下得太慢超时是慢，
 * 不是直连坏了（#941 第 3 节）。这两种都只这一次换回来查。
 */
export function classifyDirectFeedFailure(error: unknown): { reason: string; lineFailure: boolean } | null {
  const status = httpStatusCode(error)
  if (status !== null) return directFeedFallbackStatuses.has(status) ? { reason: `http-${status}`, lineFailure: status !== 404 } : null
  const reason = relayLineFailureReason(error)
  return reason ? { reason: networkFailureCode(error) ?? reason, lineFailure: reportedRelayLineFailure(error) !== null } : null
}
