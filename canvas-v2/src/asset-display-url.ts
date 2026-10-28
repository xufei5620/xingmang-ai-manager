import type { CanvasHostBridge } from './host'

function installedHost(): CanvasHostBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.xingmangCanvasHost
}

/** Stored workflows keep protocol references; only media rendering resolves them. */
export function resolveCanvasAssetDisplayUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (/^xingmang-asset:\/\/(image|video|audio)\/[A-Za-z0-9_-]{43}$/.test(value) || /^xingmang-asset:\/\/thumb\/v[0-9]+\/(image|video)\/[A-Za-z0-9_-]{43}$/.test(value)) {
    const host = installedHost()
    return host?.resolveAssetDisplayUrl ? host.resolveAssetDisplayUrl(value) : value
  }
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return value
  return undefined
}

/**
 * Whether a stored address is this asset's content: its protocol address, or
 * an older address the host recognises as the same asset. Project-scoped host
 * addresses count only where the caller says so.
 */
export function canvasAssetContentUrlMatches(value: unknown, kind: string, assetId: string, options: { projectScoped?: boolean } = {}): boolean {
  if (typeof value !== 'string') return false
  if (value === `xingmang-asset://${kind}/${assetId}`) return true
  const recognised = installedHost()?.resolveHostAssetUrl?.(value)
  return recognised?.assetId === assetId && (recognised.projectId === undefined || options.projectScoped === true)
}
