import { describe, expect, it } from 'vitest'
import { defaultImageLayerColorPresence, type ImageLayerColorPresence } from './layer-color-presence'
import { createLayerColorPresenceRows, layerColorPresenceLimits, rasterizeLayerColorPresence, rasterizeLayerColorPresenceSteps } from './layer-color-presence-raster'

function fixture(width = 29, height = 37): Uint8ClampedArray {
  return new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => [70 + at * 7 % 100, 50 + at * 13 % 120, 80 + at * 17 % 100, at % 17 ? at % 5 ? 255 : 39 : 0]).flat())
}
function controls(patch: Partial<ImageLayerColorPresence> = {}): ImageLayerColorPresence { return { ...defaultImageLayerColorPresence(), texture: 65, clarity: 50, dehaze: 35, ...patch } }
function render(data: Uint8ClampedArray, presence = controls(), width = 29): Uint8ClampedArray { return rasterizeLayerColorPresence({ data, width, height: data.length / width / 4, presence }) }
function sine(period: number, width = 192, height = 32): Uint8ClampedArray { return new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => { const value = Math.round(128 + Math.sin(at % width * Math.PI * 2 / period) * 20); return [value, value, value, 255] }).flat()) }
function amplitude(data: Uint8ClampedArray, period: number, width = 192): number {
  let projection = 0, denominator = 0
  for (let y = 12; y < 20; y++) for (let x = 32; x < width - 32; x++) { const wave = Math.sin(x * Math.PI * 2 / period); projection += (data[(y * width + x) * 4] - 128) * wave; denominator += wave * wave }
  return projection / denominator
}

describe('native multiscale presence raster', () => {
  it('preserves exact neutral or disabled bytes and never mutates its source', () => {
    const data = fixture(), before = data.slice()
    expect(render(data, defaultImageLayerColorPresence())).toEqual(data)
    expect(render(data, controls({ enabled: false }))).toEqual(data)
    expect(render(data)).not.toEqual(data)
    expect(data).toEqual(before)
  })
  it('separates fine texture from broad midtone clarity and makes both negative directions useful', () => {
    const fine = sine(8), broad = sine(48)
    const only = (key: 'texture' | 'clarity', amount: number) => ({ ...defaultImageLayerColorPresence(), [key]: amount })
    const fineTexture = amplitude(render(fine, only('texture', 100), 192), 8), fineOriginal = amplitude(fine, 8)
    const broadTexture = amplitude(render(broad, only('texture', 100), 192), 48), broadOriginal = amplitude(broad, 48)
    const fineClarity = amplitude(render(fine, only('clarity', 100), 192), 8), broadClarity = amplitude(render(broad, only('clarity', 100), 192), 48)
    expect(fineTexture).toBeGreaterThan(fineOriginal * 1.9)
    expect(broadTexture).toBeLessThan(broadOriginal * 1.12)
    expect(broadClarity).toBeGreaterThan(broadOriginal * 1.2)
    expect(fineClarity).toBeLessThan(fineTexture * .65)
    expect(amplitude(render(fine, only('texture', -100), 192), 8)).toBeLessThan(fineOriginal * .65)
    expect(amplitude(render(fine, only('texture', -100), 192), 8)).toBeGreaterThan(0)
    expect(amplitude(render(broad, only('clarity', -100), 192), 48)).toBeLessThan(broadOriginal * .8)
  })
  it('uses spatial alpha-weighted band statistics with an independent direct neighborhood oracle', () => {
    const width = 9, height = 7, data = fixture(width, height), presence = controls({ texture: 70, clarity: -80, dehaze: 0 }), actual = render(data, presence, width)
    function mean(x: number, y: number, radius: number): number {
      let value = 0, weight = 0
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        const at = (Math.max(0, Math.min(height - 1, y + dy)) * width + Math.max(0, Math.min(width - 1, x + dx))) * 4, a = data[at + 3] / 255
        value += (.2126 * data[at] + .7152 * data[at + 1] + .0722 * data[at + 2]) / 255 * a; weight += a
      }
      return value / weight
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      if (!data[at + 3]) { expect(actual.slice(at, at + 4)).toEqual(data.slice(at, at + 4)); continue }
      const medium = mean(x, y, 3), fine = mean(x, y, 1), broad = mean(x, y, 12)
      const change = .11 * Math.tanh((fine - medium) / .11) * .7 * 1.8 + .18 * Math.tanh((medium - broad) / .18) * -.8 * 4 * medium * (1 - medium)
      for (let c = 0; c < 3; c++) expect(Math.abs(actual[at + c] - Math.max(0, Math.min(255, Math.round(data[at + c] + change * 255))))).toBeLessThanOrEqual(1)
    }
  })
  it('removes local atmospheric veiling and adds haze in the negative direction rather than applying a global contrast curve', () => {
    const width = 96, height = 32, data = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => { const base = at % width < 48 ? 90 : 180; return [base, base + 10, base + 20, 255] }).flat())
    const positive = render(data, controls({ texture: 0, clarity: 0, dehaze: 80 }), width), negative = render(data, controls({ texture: 0, clarity: 0, dehaze: -80 }), width)
    for (const x of [24, 72]) {
      const at = (16 * width + x) * 4, normalizedDark = data[at] / 255, transmission = 1 - .8 * (.08 + .72 * normalizedDark)
      for (let c = 0; c < 3; c++) {
        expect(positive[at + c]).toBe(Math.max(0, Math.round((1 + (data[at + c] / 255 - 1) / transmission) * 255)))
        expect(negative[at + c]).toBe(Math.round((1 + (data[at + c] / 255 - 1) * transmission) * 255))
      }
      expect(positive[at]).toBeLessThan(data[at]); expect(negative[at]).toBeGreaterThan(data[at])
      expect(positive[at + 2] - positive[at]).toBeGreaterThan(20)
    }
    const altered = data.slice(), sample = (16 * width + 45) * 4
    // Same center pixel, different surrounding atmospheric evidence.
    for (let y = 0; y < height; y++) for (let x = 48; x < width; x++) altered.set([100, 110, 120, 255], (y * width + x) * 4)
    expect(render(altered, controls({ texture: 0, clarity: 0, dehaze: 80 }), width)[sample]).not.toBe(positive[sample])
  })
  it('does not alter constant fields under texture or clarity and gates clarity away from extreme tones', () => {
    for (const value of [0, 20, 128, 235, 255]) {
      const data = new Uint8ClampedArray(Array.from({ length: 13 * 17 }, () => [value, value, value, 91]).flat())
      expect(render(data, controls({ dehaze: 0 }), 13)).toEqual(data)
    }
    const middle = sine(48), dark = middle.map((byte, at) => at % 4 === 3 ? byte : byte - 100)
    const patch = controls({ texture: 0, clarity: 100, dehaze: 0 })
    function difference(a: Uint8ClampedArray, b: Uint8ClampedArray) { return a.reduce((sum, byte, at) => sum + (at % 4 === 0 ? Math.abs(byte - b[at]) : 0), 0) }
    expect(difference(render(dark, patch, 192), dark)).toBeLessThan(difference(render(middle, patch, 192), middle) * .5)
  })
  it('preserves all alpha bytes excludes hidden colors and attenuates nearly transparent neighbors', () => {
    const first = new Uint8ClampedArray(Array.from({ length: 29 * 37 }, () => [100, 120, 140, 255]).flat()), second = first.slice(), at = (18 * 29 + 14) * 4
    first.set([255, 0, 255, 0], at); second.set([0, 255, 0, 0], at)
    const a = render(first), b = render(second)
    expect(a.slice(at, at + 4)).toEqual(first.slice(at, at + 4))
    for (let index = 0; index < a.length; index++) if (index < at || index >= at + 4) expect(a[index]).toBe(b[index])
    const partial = first.slice(); partial.set([255, 0, 255, 1], at)
    const weighted = render(partial)
    for (let y = 17; y <= 19; y++) for (let x = 13; x <= 15; x++) if (x !== 14 || y !== 18) for (let c = 0; c < 3; c++) expect(Math.abs(weighted[(y * 29 + x) * 4 + c] - a[(y * 29 + x) * 4 + c])).toBeLessThanOrEqual(1)
    for (let index = 3; index < a.length; index += 4) expect(a[index]).toBe(first[index])
  })
  it('owns yielded tiles and keeps caches bounded by native row halos instead of image height', () => {
    const width = 29, height = 93, data = fixture(width, height), expected = render(data, controls(), width), actual = new Uint8ClampedArray(data.length)
    const source = createLayerColorPresenceRows({ data, width, height, presence: controls() })
    for (let y = 0; y < height; y++) {
      source.row(y); source.discardBefore(y - 8)
      const cache = source.cacheRows()
      expect(cache.point).toBeLessThanOrEqual(25); expect(cache.output).toBeLessThanOrEqual(9)
      expect(cache.small).toBeLessThanOrEqual(3); expect(cache.medium).toBeLessThanOrEqual(7); expect(cache.broad).toBeLessThanOrEqual(25)
    }
    const generator = rasterizeLayerColorPresenceSteps({ data, width, height, presence: controls() }), first = generator.next()
    if (first.done) throw new Error('missing tile')
    const bytes = first.value.data.slice(); actual.set(bytes, 0)
    for (const tile of generator) actual.set(tile.data, tile.top * width * 4)
    expect(first.value.data).toEqual(bytes); expect(actual).toEqual(expected)
  })
  it('rejects invalid dimensions values and checks abort or deadlines before further native work', () => {
    const data = fixture(), input = { data, width: 29, height: 37, presence: controls() }, controller = new AbortController()
    controller.abort()
    expect(() => rasterizeLayerColorPresence({ ...input, signal: controller.signal })).toThrow(/取消/)
    expect(() => rasterizeLayerColorPresence({ ...input, deadline: 0 })).toThrow(/超时/)
    expect(() => rasterizeLayerColorPresence({ ...input, width: layerColorPresenceLimits.edge + 1 })).toThrow(/安全/)
    expect(() => rasterizeLayerColorPresence({ ...input, presence: { ...controls(), texture: Infinity } })).toThrow(/范围/)
    const next = new AbortController(), steps = rasterizeLayerColorPresenceSteps({ ...input, signal: next.signal })
    expect(steps.next().value).toMatchObject({ top: 0, height: 4 }); next.abort(); expect(() => steps.next()).toThrow(/取消/)
    const timed = { ...input, deadline: Date.now() + 10000 }, pending = rasterizeLayerColorPresenceSteps(timed)
    expect(pending.next().done).toBe(false); timed.deadline = 0; expect(() => pending.next()).toThrow(/超时/)
  })
  it('interrupts a real native 4K job after four rows without allocating a float frame', () => {
    const width = 3840, height = 2160, data = new Uint8ClampedArray(width * height * 4).fill(128), before = data.slice(0, 128), controller = new AbortController()
    const steps = rasterizeLayerColorPresenceSteps({ data, width, height, presence: controls(), signal: controller.signal })
    const first = steps.next()
    expect(first.done).toBe(false)
    if (first.done) throw new Error('missing 4K tile')
    expect(first.value).toMatchObject({ top: 0, height: 4 }); expect(first.value.data.byteLength).toBe(width * 4 * 4)
    controller.abort(); expect(() => steps.next()).toThrow(/取消/)
    expect(data.slice(0, 128)).toEqual(before); expect(data.at(-1)).toBe(128)
  })
})
