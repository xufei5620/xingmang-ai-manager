import { describe, expect, it } from 'vitest'
import { defaultImageLayerColorCalibration, imageLayerColorCalibrationAmounts, isNeutralImageLayerColorCalibration, parseImageLayerColorCalibration } from './layer-color-calibration'

describe('versioned primary color calibration', () => {
  it('owns all seven neutral amounts and returns detached explicit configurations', () => {
    const first = defaultImageLayerColorCalibration(), second = defaultImageLayerColorCalibration(), parsed = parseImageLayerColorCalibration(first)
    expect(first).toEqual({ version: 1, enabled: true, shadowTint: 0, redHue: 0, redSaturation: 0, greenHue: 0, greenSaturation: 0, blueHue: 0, blueSaturation: 0 })
    expect(isNeutralImageLayerColorCalibration(first)).toBe(true)
    expect(parsed).not.toBe(first)
    first.redHue = 12
    expect(parsed.redHue).toBe(0); expect(second.redHue).toBe(0)
    expect(isNeutralImageLayerColorCalibration(first)).toBe(false)
    expect(isNeutralImageLayerColorCalibration({ ...first, enabled: false })).toBe(true)
  })

  it.each(imageLayerColorCalibrationAmounts)('accepts both observed endpoints and canonicalizes negative zero for %s', (key) => {
    for (const amount of [-100, -.5, -0, 0, .5, 100]) {
      const result = parseImageLayerColorCalibration({ ...defaultImageLayerColorCalibration(), [key]: amount })
      expect(result[key]).toBe(amount === 0 ? 0 : amount)
      expect(Object.is(result[key], -0)).toBe(false)
    }
  })

  it.each(imageLayerColorCalibrationAmounts)('rejects absent and non-finite or out-of-range %s even while disabled', (key) => {
    const missing: Record<string, unknown> = { ...defaultImageLayerColorCalibration() }; delete missing[key]
    expect(() => parseImageLayerColorCalibration(missing)).toThrow(/缺少/)
    for (const amount of [undefined, null, true, '', '0', NaN, Infinity, -Infinity, -100.01, 100.01, [], {}]) expect(() => parseImageLayerColorCalibration({ ...defaultImageLayerColorCalibration(), enabled: false, [key]: amount })).toThrow()
  })

  it('rejects an empty object without supplying missing defaults', () => { expect(() => parseImageLayerColorCalibration({})).toThrow(/缺少/) })

  it.each([null, false, undefined, [], { version: 2 }, { enabled: 1 }, { enabled: undefined }, { version: '1' }, { apiKey: 'private' }, { processVersion: '15.4' }, { red: { hue: 0 } }])('rejects unsupported shape %j without silently discarding configuration', (patch) => {
    const value = patch && typeof patch === 'object' && !Array.isArray(patch) ? { ...defaultImageLayerColorCalibration(), ...patch } : patch
    expect(() => parseImageLayerColorCalibration(value)).toThrow()
  })
})
