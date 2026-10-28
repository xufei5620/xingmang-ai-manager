import { describe, expect, it } from 'vitest'
import { assertLayerFilterSize, rasterizeLayerFilterSteps } from './layer-filter-raster'

function fixture(width = 9, height = 7) {
  const data = new Uint8ClampedArray(width * height * 4), coverage = new Uint8ClampedArray(data.length)
  for (let i = 0; i < width * height; i++) {
    data.set([i * 47 % 256, i * 73 % 256, i * 83 % 256, i * 29 % 256], i * 4)
    coverage[i * 4 + 3] = i % 3 === 0 ? 0 : i % 3 === 1 ? 128 : 255
  }
  return { data, coverage, width, height, radiusX: 2, radiusY: 1, strength: .7, mode: 'blur' as 'blur' | 'sharpen' }
}
function render(input: ReturnType<typeof fixture>) {
  const output = new Uint8ClampedArray(input.data.length)
  for (const tile of rasterizeLayerFilterSteps(input)) output.set(tile.data, tile.top * input.width * 4)
  return output
}
// Independent direct neighbourhood oracle: no rolling sums or strip reuse.
function oracle(input: ReturnType<typeof fixture>) {
  const { width, height, data, coverage, radiusX, radiusY, mode, strength } = input, out = data.slice()
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, weight = coverage[i + 3] / 255 * strength
    if (!weight) continue
    const sums = [0, 0, 0, 0], samples = (radiusX * 2 + 1) * (radiusY * 2 + 1)
    for (let dy = -radiusY; dy <= radiusY; dy++) for (let dx = -radiusX; dx <= radiusX; dx++) {
      const j = (Math.max(0, Math.min(height - 1, y + dy)) * width + Math.max(0, Math.min(width - 1, x + dx))) * 4
      for (let c = 0; c < 3; c++) sums[c] += data[j + c] * data[j + 3] / 255 / samples
      sums[3] += data[j + 3] / samples
    }
    const a = mode === 'blur' ? data[i + 3] * (1 - weight) + sums[3] * weight : data[i + 3]
    out[i + 3] = a
    for (let c = 0; c < 3; c++) out[i + c] = mode === 'blur' ? a ? (data[i + c] * data[i + 3] * (1 - weight) + sums[c] * 255 * weight) / a : 0 : data[i + 3] ? data[i + c] + (data[i + c] - (sums[3] ? sums[c] * 255 / sums[3] : data[i + c])) * weight : 0
  }
  return out
}

describe('local blur and sharpen pixel kernels', () => {
  it.each(['blur', 'sharpen'] as const)('matches a direct premultiplied-alpha oracle for %s across tile and edge boundaries', (mode) => {
    for (const [width, height] of [[1, 1], [3, 5], [9, 37], [41, 70]]) {
      const input = { ...fixture(width, height), mode }, before = input.data.slice(), result = render(input), expected = oracle(input)
      expect(Math.max(...result.map((v, i) => Math.abs(v - expected[i])))).toBeLessThanOrEqual(1)
      expect(input.data).toEqual(before)
      for (let i = 0; i < width * height; i++) if (!input.coverage[i * 4 + 3]) expect(result.slice(i * 4, i * 4 + 4)).toEqual(before.slice(i * 4, i * 4 + 4))
    }
  })
  it('blurs a hard edge but sharpens a soft edge without changing the alpha silhouette', () => {
    const input = fixture(7, 1); input.coverage.fill(255); input.strength = 1; input.radiusX = 1
    for (let x = 0; x < 7; x++) input.data.set([x < 3 ? 0 : 255, x < 3 ? 0 : 255, x < 3 ? 0 : 255, 255], x * 4)
    expect(render(input)[2 * 4]).toBe(85); expect(render(input)[3 * 4]).toBe(170)
    const soft = [0, 30, 90, 165, 225, 255, 255]; soft.forEach((v, x) => input.data.set([v, v, v, 255], x * 4))
    input.mode = 'sharpen'
    expect(render(input)[1 * 4]).toBeLessThan(soft[1]); expect(render(input)[4 * 4]).toBeGreaterThan(soft[4])
    expect([...render(input)].filter((_, i) => i % 4 === 3)).toEqual(Array(7).fill(255))
  })
  it('does not bleed RGB hidden under fully transparent pixels into the blurred image', () => {
    const input = fixture(3, 1); input.coverage.fill(255); input.strength = 1; input.radiusX = 1
    input.data.set([0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0])
    expect([...render(input)]).toEqual([255, 0, 0, 85, 255, 0, 0, 85, 255, 0, 0, 85])
  })
  it('keeps zero-strength pixels byte-identical and refuses invalid budgets or cancellation', () => {
    const input = fixture(); input.strength = 0; expect(render(input)).toEqual(input.data)
    expect(() => assertLayerFilterSize(3840, 2160)).not.toThrow(); expect(() => assertLayerFilterSize(4096, 4096)).not.toThrow()
    expect(() => assertLayerFilterSize(4357, 100)).toThrow('容量')
    const controller = new AbortController(), iterator = rasterizeLayerFilterSteps({ ...fixture(40, 70), signal: controller.signal })
    expect(iterator.next().done).toBe(false); controller.abort(); expect(() => iterator.next()).toThrow('取消')
    expect(() => [...rasterizeLayerFilterSteps({ ...input, deadline: 0 })]).toThrow('超时')
    for (const radiusX of [-1, 0, 1.2, 33, NaN]) expect(() => render({ ...input, radiusX })).toThrow('参数')
  })
})
