import type { ProviderId } from '../../../../electron/ipc-contract'

export type SourceMarkerStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>

const markerPrefix = 'xingmang-v2:provider-source:v1'
const manualMarker = 'manual'

export function getSourceMarkerStorage(): SourceMarkerStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** Provider paths and relay-site aliases on one origin intentionally share a marker. */
export function manualSourceMarkerKey(
  relayBaseUrl: string,
  provider: ProviderId,
): string | null {
  try {
    const url = new URL(relayBaseUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return `${markerPrefix}:${encodeURIComponent(url.origin)}:${provider}`
  } catch {
    return null
  }
}

export function readManualSourceMarker(
  storage: SourceMarkerStorage | null,
  relayBaseUrl: string,
  provider: ProviderId,
): boolean {
  const key = manualSourceMarkerKey(relayBaseUrl, provider)
  if (!storage || !key) return false
  try {
    return storage.getItem(key) === manualMarker
  } catch {
    return false
  }
}

export function writeManualSourceMarker(
  storage: SourceMarkerStorage | null,
  relayBaseUrl: string,
  provider: ProviderId,
  manual: boolean,
): boolean {
  const key = manualSourceMarkerKey(relayBaseUrl, provider)
  if (!storage || !key) return false
  try {
    if (manual) storage.setItem(key, manualMarker)
    else storage.removeItem(key)
    return true
  } catch {
    return false
  }
}
