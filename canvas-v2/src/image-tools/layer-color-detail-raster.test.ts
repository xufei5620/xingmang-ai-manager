import { describe, expect, it } from 'vitest'
import { defaultImageLayerColorDetail, type ImageLayerColorDetail } from './layer-color-detail'
import { rasterizeLayerColorDetail, rasterizeLayerColorDetailSteps } from './layer-color-detail-raster'

function fixture(width = 23, height = 37): Uint8ClampedArray {
  return new Uint8ClampedArray(Array.from({ length: width * height }, (_, index) => {
    const x = index % width, y = Math.floor(index / width), base = x < width / 2 ? 65 : 185, fine = (x * 7 + y * 11) % 5 * 4 - 8
    return [base + fine + index * 13 % 19 - 9, base + fine + index * 3 % 13 - 6, base + fine + index * 5 % 23 - 11, index % 11 ? 255 : 63]
  }).flat())
}

function controls(): ImageLayerColorDetail {
  return { version: 1, enabled: true, sharpening: { amount: 80, radius: 1, detail: 25, masking: 0 }, luminance: { amount: 70, detail: 50, contrast: 0 }, color: { amount: 80, detail: 50, smoothness: 50 } }
}

function render(data: Uint8ClampedArray, detail = controls(), width = 23): Uint8ClampedArray { return rasterizeLayerColorDetail({ data, width, height: data.length / width / 4, detail }) }

describe('bounded edge preserving detail raster', () => {
  it('preserves exact bytes for disabled and zero-amount controls including hidden RGB', () => {
    const data = fixture(); data.set([220, 31, 144, 0], 0)
    expect(render(data, defaultImageLayerColorDetail())).toEqual(data)
    expect(render(data, { ...controls(), enabled: false })).toEqual(data)
  })
  it('reduces luminance and chroma noise without crossing a strong luminance edge', () => {
    const width = 24, height = 24, data = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => {
      const base = at % width < 12 ? 55 : 200, noise = at * 17 % 23 - 11
      return [base + noise, base + noise, base + noise, 255]
    }).flat()), detail = defaultImageLayerColorDetail()
    detail.luminance = { amount: 100, detail: 0, contrast: 0 }
    const output = render(data, detail, width)
    let before = 0, after = 0
    for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
      const at = (y * width + x) * 4, base = x < 12 ? 55 : 200
      before += (data[at] - base) ** 2; after += (output[at] - base) ** 2
      if (x === 11) expect(output[at]).toBeLessThan(75)
      if (x === 12) expect(output[at]).toBeGreaterThan(180)
    }
    expect(after).toBeLessThan(before * .35)
    const chroma = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => { const n = at * 13 % 23 - 11; return [128 + n, 128, 128 - n, 255] }).flat())
    detail.luminance.amount = 0; detail.color = { amount: 100, detail: 0, smoothness: 100 }
    const cleaned = render(chroma, detail, width)
    function error(input: Uint8ClampedArray) { return [...input].reduce((sum, byte, at) => at % 4 === 0 || at % 4 === 2 ? sum + (byte - 128) ** 2 : sum, 0) }
    expect(error(cleaned)).toBeLessThan(error(chroma) * .2)
  })
  it.each([
    ['sharpening', 'amount', 0, 150], ['sharpening', 'radius', .5, 3], ['sharpening', 'detail', 0, 100], ['sharpening', 'masking', 0, 100],
    ['luminance', 'amount', 0, 100], ['luminance', 'detail', 0, 100], ['luminance', 'contrast', 0, 100],
    ['color', 'amount', 0, 100], ['color', 'detail', 0, 100], ['color', 'smoothness', 0, 100],
  ] as const)('gives %s.%s a real pixel effect rather than metadata only', (group, key, low, high) => {
    const data = fixture(), first = { ...controls(), [group]: { ...controls()[group], [key]: low } }, second = { ...controls(), [group]: { ...controls()[group], [key]: high } }
    expect(render(data, first)).not.toEqual(render(data, second))
  })
  it('preserves alpha and ignores fully transparent and alpha-weighted hidden colors in neighborhoods', () => {
    const width = 7, first = new Uint8ClampedArray(Array.from({ length: 49 }, () => [100, 120, 140, 255]).flat()), second = first.slice()
    first.set([255, 0, 255, 0], 24 * 4); second.set([0, 255, 0, 0], 24 * 4)
    const a = render(first, controls(), width), b = render(second, controls(), width)
    expect([...a.slice(24 * 4, 25 * 4)]).toEqual([255, 0, 255, 0])
    for (let at = 0; at < a.length; at++) if (Math.floor(at / 4) !== 24) expect(a[at]).toBe(b[at])
    const partial = first.slice(); partial.set([240, 20, 40, 1], 24 * 4)
    const weighted = render(partial, controls(), width)
    const neighbor = (3 * width + 2) * 4
    for (let c = 0; c < 3; c++) expect(Math.abs(weighted[neighbor + c] - a[neighbor + c])).toBeLessThanOrEqual(1)
    for (let at = 3; at < a.length; at += 4) expect(a[at]).toBe(first[at])
    expect(a).toEqual(first)
  })
  it('matches an independent clamped Gaussian USM oracle with zero fine-detail gain', () => {
    const data = new Uint8ClampedArray([64, 64, 64, 255, 128, 128, 128, 255, 192, 192, 192, 255]), detail = defaultImageLayerColorDetail()
    detail.sharpening = { amount: 100, radius: 1, detail: 0, masking: 0 }
    const actual = render(data, detail, 3), source = [64, 128, 192]
    const expected = source.map((value, x) => {
      let sum = 0, total = 0
      for (let dx = -2; dx <= 2; dx++) { const weight = Math.exp(-dx * dx / 2); sum += source[Math.max(0, Math.min(2, x + dx))] * weight; total += weight }
      return Math.max(0, Math.min(255, Math.round(value * 2 - sum / total)))
    })
    expect([...actual]).toEqual(expected.flatMap((value) => [value, value, value, 255]))
  })
  it('uses masking to suppress flat-field texture while retaining stronger hard edges', () => {
    const data = fixture(), zero = defaultImageLayerColorDetail(), masked = defaultImageLayerColorDetail()
    zero.sharpening = { amount: 100, radius: 1, detail: 50, masking: 0 }; masked.sharpening = { ...zero.sharpening, masking: 100 }
    const sharp = render(data, zero), protectedOutput = render(data, masked)
    let noisyGain = 0, protectedGain = 0
    for (let y = 3; y < 34; y++) for (let x = 3; x < 8; x++) { const at = (y * 23 + x) * 4; noisyGain += Math.abs(sharp[at] - data[at]); protectedGain += Math.abs(protectedOutput[at] - data[at]) }
    expect(protectedGain).toBeLessThan(noisyGain * .3)
    expect(protectedOutput[(18 * 23 + 12) * 4]).toBeGreaterThan(data[(18 * 23 + 12) * 4])
  })
  it('matches collected tiles across row 16 boundaries, owns yielded pixels and keeps the source immutable', () => {
    const data = fixture(), before = data.slice(), expected = render(data), actual = new Uint8ClampedArray(data.length), steps = rasterizeLayerColorDetailSteps({ data, width: 23, height: 37, detail: controls() })
    const first = steps.next()
    expect(first.done).toBe(false)
    if (first.done) throw new Error('missing tile')
    actual.set(first.value.data, first.value.top * 23 * 4)
    const owned = first.value.data.slice()
    for (const tile of steps) actual.set(tile.data, tile.top * 23 * 4)
    expect(first.value.data).toEqual(owned); expect(actual).toEqual(expected); expect(data).toEqual(before)
    expect([...expected.slice(15 * 23 * 4, 17 * 23 * 4)]).not.toEqual([...data.slice(15 * 23 * 4, 17 * 23 * 4)])
  })
  it('checks dimensions, pre-abort, cancellation and time budgets before further output', () => {
    const data = fixture(), before = data.slice(), controller = new AbortController()
    controller.abort()
    expect(() => render(data, { ...controls(), enabled: false }, 0)).toThrow()
    expect(() => rasterizeLayerColorDetail({ data, width: 23, height: 37, detail: controls(), signal: controller.signal })).toThrow(/取消/)
    expect(() => rasterizeLayerColorDetail({ data, width: 23, height: 37, detail: controls(), deadline: 0 })).toThrow(/超时/)
    expect(() => rasterizeLayerColorDetail({ data, width: 4357, height: 1, detail: controls() })).toThrow(/安全/)
    const next = new AbortController(), steps = rasterizeLayerColorDetailSteps({ data, width: 23, height: 37, detail: controls(), signal: next.signal })
    expect(steps.next().done).toBe(false); next.abort()
    expect(() => steps.next()).toThrow(/取消/)
    expect(data).toEqual(before)
  })
  it('interrupts a real 4K native job after a small tile and rechecks a changed deadline', () => {
    const width = 3840, height = 2160, data = new Uint8ClampedArray(width * height * 4).fill(128), controller = new AbortController()
    const steps = rasterizeLayerColorDetailSteps({ data, width, height, detail: controls(), signal: controller.signal })
    const first = steps.next()
    expect(first.done).toBe(false)
    if (first.done) throw new Error('missing native tile')
    expect(first.value).toMatchObject({ top: 0, height: 4 })
    expect(first.value.data.byteLength).toBe(width * 4 * 4)
    controller.abort(); expect(() => steps.next()).toThrow(/取消/)
    const input = { data: fixture(), width: 23, height: 37, detail: controls(), deadline: Date.now() + 10000 }, timed = rasterizeLayerColorDetailSteps(input)
    expect(timed.next().done).toBe(false); input.deadline = 0
    expect(() => timed.next()).toThrow(/超时/)
    expect(data[0]).toBe(128); expect(data.at(-1)).toBe(128)
  })
})
