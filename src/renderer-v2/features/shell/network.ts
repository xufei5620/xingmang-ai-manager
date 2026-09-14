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

export function networkLocationLabel(
  network: NetworkLocation | null | undefined,
): string {
  if (!network || network.region === 'unknown' || !network.countryCode) {
    return '网络位置未知'
  }

  const countryCode = network.countryCode.trim().toUpperCase()
  let countryName = countryCode
  try {
    countryName = regionDisplayNames.of(countryCode) ?? countryCode
  } catch {
    // Keep the country code when the platform does not know this region.
  }
  return network.publicIp
    ? `${countryName} · ${network.publicIp}`
    : `${countryName} · IP 未知`
}
