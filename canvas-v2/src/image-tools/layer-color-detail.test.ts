import { describe, expect, it } from 'vitest'
import { defaultImageLayerColorDetail, isNeutralImageLayerColorDetail, parseImageLayerColorDetail } from './layer-color-detail'

describe('strict editable color detail configuration', () => {
  it('constructs independent neutral controls without discarding dormant values', () => {
    const first = defaultImageLayerColorDetail(), second = defaultImageLayerColorDetail()
    expect(first).toEqual({ version: 1, enabled: true, sharpening: { amount: 0, radius: 1, detail: 25, masking: 0 }, luminance: { amount: 0, detail: 50, contrast: 0 }, color: { amount: 0, detail: 50, smoothness: 50 } })
    expect(isNeutralImageLayerColorDetail(first)).toBe(true)
    first.sharpening.radius = 3
    expect(second.sharpening.radius).toBe(1)
    first.enabled = false; first.color.amount = 100
    expect(parseImageLayerColorDetail(first)).toEqual(first)
    expect(isNeutralImageLayerColorDetail(first)).toBe(true)
    first.enabled = true
    expect(isNeutralImageLayerColorDetail(first)).toBe(false)
  })
  it.each([null, false, [], {}, { ...defaultImageLayerColorDetail(), version: 2 }, { ...defaultImageLayerColorDetail(), enabled: 1 }, { ...defaultImageLayerColorDetail(), x: 1 }, { ...defaultImageLayerColorDetail(), sharpening: { ...defaultImageLayerColorDetail().sharpening, hidden: 1 } }])('rejects malformed, unknown and future values %j', (value) => {
    expect(() => parseImageLayerColorDetail(value)).toThrow()
  })
  it.each([
    ['sharpening', 'amount', 0, 150], ['sharpening', 'radius', .5, 3], ['sharpening', 'detail', 0, 100], ['sharpening', 'masking', 0, 100],
    ['luminance', 'amount', 0, 100], ['luminance', 'detail', 0, 100], ['luminance', 'contrast', 0, 100],
    ['color', 'amount', 0, 100], ['color', 'detail', 0, 100], ['color', 'smoothness', 0, 100],
  ] as const)('enforces finite inclusive bounds for %s.%s', (group, key, low, high) => {
    for (const value of [low, high]) expect(() => parseImageLayerColorDetail({ ...defaultImageLayerColorDetail(), [group]: { ...defaultImageLayerColorDetail()[group], [key]: value } })).not.toThrow()
    for (const value of [undefined, null, '50', NaN, Infinity, -Infinity, low - .001, high + .001]) expect(() => parseImageLayerColorDetail({ ...defaultImageLayerColorDetail(), [group]: { ...defaultImageLayerColorDetail()[group], [key]: value } })).toThrow()
  })
})
