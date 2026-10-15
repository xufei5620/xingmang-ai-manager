import type { SystemSnapshot } from '../../../../electron/ipc-contract'

type NetworkLocation = SystemSnapshot['network']

// Intl.DisplayNames is available in the Electron renderer, but country codes
// can still be non-standard when a proxy or a future location provider sends
// an unfamiliar value. Keep the code as a useful, deterministic fallback.
const regionDisplayNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' })

/** A slow full scan can finish after the lightweight route-change probe. */
export function latestNetworkLocation(
  scanned: NetworkLocation | null | undefined,
  refreshed: NetworkLocation | null | undefined,
): NetworkLocation | undefined {
  if (!refreshed) return scanned ?? undefined
  if (!scanned) return refreshed
  return Date.parse(scanned.checkedAt) > Date.parse(refreshed.checkedAt) ? scanned : refreshed
}

function countryName(network: NetworkLocation | null | undefined): string | null {
  if (!network || network.region === 'unknown' || !network.countryCode) return null
  const countryCode = network.countryCode.trim().toUpperCase()
  try {
    return regionDisplayNames.of(countryCode) ?? countryCode
  } catch {
    // Keep the country code when the platform does not know this region.
    return countryCode
  }
}

/** 鼠标停在状态栏网络那一项上时写的全文：国家和出口 IP。 */
export function networkLocationLabel(
  network: NetworkLocation | null | undefined,
): string {
  const country = countryName(network)
  if (!country) return '网络位置未知'
  return network?.publicIp
    ? `${country} · ${network.publicIp}`
    : `${country} · IP 未知`
}

/** 状态栏上露出来的那一句：联着网才显示，只写国家，IP 进悬停提示。 */
export function networkStatusLabel(
  network: NetworkLocation | null | undefined,
): string {
  const country = countryName(network)
  return country ? `网络正常 · ${country}` : '网络正常'
}
