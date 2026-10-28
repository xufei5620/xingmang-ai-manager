import { describe, expect, it } from 'vitest'
import { desktopCanvasCapabilities } from './canvas-contract'
import {
  canvasFeatureEnabled,
  canvasImageModelResolutions,
  resolveCanvasCapabilities,
  v2EquivalentCapabilities,
  type CanvasHostFeature,
} from '../canvas-v2/src/host-capabilities'

// The kernel reads capabilities() leniently: a declaration it cannot parse
// silently becomes the v2-equivalent set. So a desktop literal that drifts out
// of the shape the synced kernel knows would not fail anywhere else; it would
// just quietly change which entries the canvas shows.
describe('desktop canvas capabilities as the synced kernel reads them', () => {
  const profile = resolveCanvasCapabilities(desktopCanvasCapabilities)

  it('parses the desktop declaration instead of falling back to the v2-equivalent set', () => {
    expect(profile).not.toBe(v2EquivalentCapabilities)
    expect(profile.host).toBe('desktop')
    expect(profile.contractVersion).toBe(desktopCanvasCapabilities.contractVersion)
  })

  it('offers exactly the node kinds the desktop main process executes', () => {
    expect([...profile.executableNodeKinds].sort()).toEqual([...desktopCanvasCapabilities.executableNodeKinds].sort())
  })

  it('keeps every feature the desktop does not provide switched off', () => {
    const declared = desktopCanvasCapabilities.features as Partial<Record<CanvasHostFeature, boolean>>
    for (const feature of Object.keys(profile.features) as CanvasHostFeature[]) {
      expect(canvasFeatureEnabled(feature, profile), feature).toBe(declared[feature] === true)
    }
  })

  it('offers 2K and 4K for Gemini 3.1 Flash Image as the desktop declares', () => {
    expect(canvasImageModelResolutions('gemini-3.1-flash-image', profile)).toEqual(['1K', '2K', '4K'])
    expect(canvasImageModelResolutions('gpt-image-1', profile)).toEqual(['1K'])
  })
})
