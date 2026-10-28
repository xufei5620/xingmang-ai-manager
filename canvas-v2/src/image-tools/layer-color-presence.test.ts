import { describe, expect, it } from 'vitest'
import { defaultImageLayerColorPresence, isNeutralImageLayerColorPresence, parseImageLayerColorPresence } from './layer-color-presence'

describe('strict versioned texture clarity and dehaze', () => {
  it('returns independent neutral controls and retains disabled nonzero amounts', () => {
    const original = defaultImageLayerColorPresence(), parsed = parseImageLayerColorPresence(original)
    expect(parsed).toEqual({ version: 1, enabled: true, texture: 0, clarity: 0, dehaze: 0 })
    original.texture = 30
    expect(parsed.texture).toBe(0)
    expect(isNeutralImageLayerColorPresence(parsed)).toBe(true)
    const dormant = { ...original, enabled: false, clarity: -100, dehaze: 100 }
    expect(parseImageLayerColorPresence(dormant)).toEqual(dormant)
    expect(isNeutralImageLayerColorPresence(dormant)).toBe(true)
    expect(isNeutralImageLayerColorPresence(original)).toBe(false)
  })
  it.each(['texture', 'clarity', 'dehaze'] as const)('accepts both signed endpoints and fractions for %s', (key) => {
    for (const amount of [-100, -27.5, 0, 58.25, 100]) expect(parseImageLayerColorPresence({ ...defaultImageLayerColorPresence(), [key]: amount })[key]).toBe(amount)
    expect(Object.is(parseImageLayerColorPresence({ ...defaultImageLayerColorPresence(), [key]: -0 })[key], -0)).toBe(false)
    for (const amount of [-100.01, 100.01, NaN, Infinity, -Infinity, '20', null, undefined, false]) expect(() => parseImageLayerColorPresence({ ...defaultImageLayerColorPresence(), [key]: amount })).toThrow()
  })
  it.each([null, [], false, {}, { ...defaultImageLayerColorPresence(), version: 2 }, { ...defaultImageLayerColorPresence(), enabled: 1 }, { ...defaultImageLayerColorPresence(), alien: 0 }, { version: 1, enabled: true, texture: 0, clarity: 0 }])('rejects unsupported fields missing required values or versions %j', (value) => {
    expect(() => parseImageLayerColorPresence(value)).toThrow()
  })
})
