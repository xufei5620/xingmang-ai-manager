import type { UiScalePreference } from './types'

export const UI_DESIGN_WIDTH_DIP = 1280
export const UI_MIN_ZOOM = 0.7
export const UI_MAX_ZOOM = 1.25

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/**
 * Browser zoom is derived from DIP width. System DPI is already represented by
 * the DIP value and must not be multiplied into this calculation a second time.
 */
export function calculatePlatformZoom(
  contentWidthDip: number,
  preference: UiScalePreference = 'auto',
): number {
  if (!Number.isFinite(contentWidthDip) || contentWidthDip <= 0) return 1
  const automatic = clamp(contentWidthDip / UI_DESIGN_WIDTH_DIP, UI_MIN_ZOOM, UI_MAX_ZOOM)
  const multiplier = preference === '90' ? 0.9 : preference === '110' ? 1.1 : 1
  return Math.round(clamp(automatic * multiplier, UI_MIN_ZOOM, UI_MAX_ZOOM) * 10_000) / 10_000
}
