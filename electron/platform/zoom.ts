import { calculateUiZoom } from '../window-preferences'
import type { UiScalePreference } from './types'

// Re-exported rather than redeclared: a second copy of these numbers is what
// let the two appliers disagree in the first place. This module floored at
// 0.7 and window-preferences.ts at 0.8, so 960 DIP produced 0.75 here and 0.8
// there, and only the listener registration order decided which one the user
// actually saw.
export { UI_DESIGN_WIDTH_DIP, UI_MAX_ZOOM, UI_MIN_ZOOM } from '../window-preferences'

/**
 * Browser zoom is derived from DIP width. System DPI is already represented by
 * the DIP value and must not be multiplied into this calculation a second time.
 *
 * The platform-facing name for calculateUiZoom, kept so the v2 platform layer
 * keeps its own vocabulary. It must stay a delegation: re-deriving the clamp
 * here would reintroduce the split this signature now exists to prevent.
 */
export function calculatePlatformZoom(
  contentWidthDip: number,
  preference: UiScalePreference = 'auto',
): number {
  return calculateUiZoom(contentWidthDip, preference)
}
