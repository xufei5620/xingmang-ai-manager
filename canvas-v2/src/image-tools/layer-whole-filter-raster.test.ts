import { describe, expect, it } from 'vitest'
import { defaultWholeLayerFilter, wholeLayerFilterDefinitions, type ImageLayerWholeFilter, type ImageLayerWholeFilterOperation } from './layer-whole-filter'
import { rasterizeWholeLayerFilterSteps, rasterizeWholeLayerFilterWorldSteps, type WholeLayerFilterRasterInput } from './layer-whole-filter-raster'

function fixture(width = 9, height = 7, opaque = false): Uint8ClampedArray { return Uint8ClampedArray.from({ length: width * height * 4 }, (_, index) => index % 4 === 3 ? opaque ? 255 : index * 29 % 256 : index * 47 % 256) }
function finish<T>(steps: Generator<void, T>): T { let step = steps.next(); while (!step.done) step = steps.next(); return step.value }
function render(filter: ImageLayerWholeFilter, data = fixture(), width = 9, height = 7): Uint8ClampedArray { return finish(rasterizeWholeLayerFilterSteps({ data, width, height, filter })) }
function pixel(data: Uint8ClampedArray, width: number, x: number, y: number): number[] { return [...data.slice((y * width + x) * 4, (y * width + x) * 4 + 4)] }

// Direct 2D neighbourhood oracle deliberately shares no separable row cache.
function directGaussian(data: Uint8ClampedArray, width: number, height: number, sigma: number): Uint8ClampedArray {
  const radius = Math.ceil(3 * sigma), out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sums = [0, 0, 0, 0], i = (y * width + x) * 4
    let weights = 0
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const weight = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)), j = (Math.max(0, Math.min(height - 1, y + dy)) * width + Math.max(0, Math.min(width - 1, x + dx))) * 4
      weights += weight; sums[3] += data[j + 3] * weight
      for (let c = 0; c < 3; c++) sums[c] += data[j + c] * data[j + 3] * weight
    }
    out[i + 3] = sums[3] / weights
    for (let c = 0; c < 3; c++) out[i + c] = sums[3] ? sums[c] / sums[3] : 0
  }
  return out
}

function directNeighborhood(data: Uint8ClampedArray, width: number, height: number, radius: number, mode: 'median' | 'mean'): Uint8ClampedArray {
  const output = new Uint8ClampedArray(data.length)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const values: number[][] = [[], [], [], []], index = (y * width + x) * 4
    for (let yy = y - radius; yy <= y + radius; yy++) for (let xx = x - radius; xx <= x + radius; xx++) {
      const sample = (Math.max(0, Math.min(height - 1, yy)) * width + Math.max(0, Math.min(width - 1, xx))) * 4, alpha = data[sample + 3]
      values[3].push(alpha)
      for (let c = 0; c < 3; c++) values[c].push(mode === 'median' ? Math.round(data[sample + c] * alpha / 255) : data[sample + c] * alpha / 255)
    }
    const reduced = values.map((channel) => mode === 'median' ? channel.sort((a, b) => a - b)[Math.floor(channel.length / 2)] : channel.reduce((a, b) => a + b, 0) / channel.length)
    output[index + 3] = reduced[3]
    for (let c = 0; c < 3; c++) output[index + c] = reduced[3] ? reduced[c] * 255 / reduced[3] : 0
  }
  return output
}

// Four explicit neighbours form an independent inverse-map sampling oracle.
function interpolated(data: Uint8ClampedArray, width: number, height: number, x: number, y: number): number[] {
  const x0 = Math.floor(x), y0 = Math.floor(y), result = [0, 0, 0, 0]
  for (const [xx, yy, weight] of [[x0, y0, (1 - x + x0) * (1 - y + y0)], [x0 + 1, y0, (x - x0) * (1 - y + y0)], [x0, y0 + 1, (1 - x + x0) * (y - y0)], [x0 + 1, y0 + 1, (x - x0) * (y - y0)]]) {
    if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue
    const rgba = pixel(data, width, xx, yy)
    result[3] += rgba[3] * weight
    for (let c = 0; c < 3; c++) result[c] += rgba[c] * rgba[3] * weight
  }
  for (let c = 0; c < 3; c++) result[c] = result[3] ? result[c] / result[3] : 0
  return [...new Uint8ClampedArray(result)]
}

describe('native whole layer filter pixel algorithms', () => {
  it.each(wholeLayerFilterDefinitions.map((item) => item.type))('executes %s deterministically without mutating frozen input', (type) => {
    const data = fixture(), before = data.slice(), filter = defaultWholeLayerFilter(type)
    const output = render(filter, data)
    expect(output).toHaveLength(data.length)
    expect(render(filter, data)).toEqual(output)
    expect(data).toEqual(before)
    if (type !== 'lens-correction') expect(output).not.toEqual(data)
    else expect(output).toEqual(data)
  })

  it('matches a direct premultiplied Gaussian oracle across edges, alpha and tiles', () => {
    for (const [width, height] of [[1, 1], [7, 5], [3, 19]]) {
      const data = fixture(width, height), expected = directGaussian(data, width, height, 1)
      const actual = render({ type: 'gaussian', parameters: { radius: 1 } }, data, width, height)
      expect(Math.max(...actual.map((value, index) => Math.abs(value - expected[index])))).toBeLessThanOrEqual(1)
    }
    const hidden = new Uint8ClampedArray([0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0])
    const output = render({ type: 'gaussian', parameters: { radius: 1 } }, hidden, 3, 1)
    for (let i = 0; i < output.length; i += 4) expect([...output.slice(i, i + 3)]).toEqual([255, 0, 0])
  })

  it('uses an alpha-weighted block average anchored at the layer origin', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 0, 255, 0])
    const output = render({ type: 'mosaic', parameters: { size: 2 } }, data, 3, 2)
    // First block contains 3 opaque colours; hidden green contributes no RGB.
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) expect(pixel(output, 3, x, y)).toEqual([255, 85, 85, 191])
    expect(pixel(output, 3, 2, 0)).toEqual([0, 0, 255, 128])
    const twice = finish(rasterizeWholeLayerFilterSteps({ data: output, width: 3, height: 2, filter: { type: 'mosaic', parameters: { size: 2 } } }))
    expect(twice).toEqual(output)
  })

  it('matches sorted premultiplied median and direct repeated box neighbourhood oracles', () => {
    const width = 5, height = 11, data = fixture(width, height)
    const median = render({ type: 'median', parameters: { radius: 2 } }, data, width, height)
    expect(median).toEqual(directNeighborhood(data, width, height, 2, 'median'))
    let expected = data
    for (let iteration = 0; iteration < 3; iteration++) expected = directNeighborhood(expected, width, height, 1, 'mean')
    const box = render({ type: 'box-blur', parameters: { iterations: 3 } }, data, width, height)
    expect(Math.max(...box.map((value, index) => Math.abs(value - expected[index])))).toBeLessThanOrEqual(1)
  })

  it('uses direct USM differences and threshold while preserving original alpha', () => {
    const data = fixture(7, 5), blurred = directGaussian(data, 7, 5, 1), output = render({ type: 'usm', parameters: { amount: 150, radius: 1, threshold: 0 } }, data, 7, 5)
    const expected = data.slice()
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) expected[i + c] = data[i + 3] ? data[i + c] + (data[i + c] - blurred[i + c]) * 1.5 : 0
    expect(Math.max(...output.map((value, index) => Math.abs(value - expected[index])))).toBeLessThanOrEqual(2)
    const opaque = fixture(7, 5, true)
    expect(render({ type: 'usm', parameters: { amount: 100, radius: 1, threshold: 255 } }, opaque, 7, 5)).toEqual(opaque)
  })

  it('fades smart sharpening in shadows and highlights using an independent Gaussian oracle', () => {
    const data = fixture(7, 5), blurred = directGaussian(data, 7, 5, 1), output = render({ type: 'smart-sharpen', parameters: { amount: 150, radius: 1, shadowFade: .8, highlightFade: .6 } }, data, 7, 5), expected = data.slice()
    for (let i = 0; i < data.length; i += 4) {
      const luminance = (.2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2]) / 255
      const amount = 1.5 * (1 - .8 * (1 - luminance) ** 2) * (1 - .6 * luminance ** 2)
      for (let c = 0; c < 3; c++) expected[i + c] = data[i + 3] ? data[i + c] + (data[i + c] - blurred[i + c]) * amount : 0
    }
    expect(Math.max(...output.map((value, index) => Math.abs(value - expected[index])))).toBeLessThanOrEqual(2)
  })

  it('has a fixed mulberry32 seed and keeps its spatial noise grid when resized', () => {
    const data = new Uint8ClampedArray([100, 100, 100, 255])
    expect([...render(defaultWholeLayerFilter('noise'), data, 1, 1)]).toEqual([103, 88, 101, 255])
    const enlarged = new Uint8ClampedArray(Array.from({ length: 16 }, (_, index) => index % 4 === 3 ? 255 : 100))
    expect([...finish(rasterizeWholeLayerFilterSteps({ data: enlarged, width: 2, height: 2, referenceSpace: { width: 1, height: 1 }, filter: defaultWholeLayerFilter('noise') }))]).toEqual(Array.from({ length: 4 }, () => [103, 88, 101, 255]).flat())
  })

  it('uses the displayed 3x3 kernels for sharpen, emboss and edge extraction', () => {
    const data = fixture(5, 5, true), kernels = { sharpen: [0, -1, 0, -1, 5, -1, 0, -1, 0], edges: [-1, -1, -1, -1, 8, -1, -1, -1, -1], emboss: [-2, -1, 0, -1, 1, 1, 0, 1, 2] }
    for (const type of ['sharpen', 'edges', 'emboss'] as const) {
      const output = render(defaultWholeLayerFilter(type), data, 5, 5), expected = new Uint8ClampedArray(4)
      expected[3] = 255
      for (let c = 0; c < 3; c++) { let sum = type === 'emboss' ? 128 : 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += data[((2 + dy) * 5 + 2 + dx) * 4 + c] * kernels[type][(dy + 1) * 3 + dx + 1]; expected[c] = sum }
      expect(pixel(output, 5, 2, 2)).toEqual([...expected])
    }
  })

  it('maps the wave displacement in native pixels and samples outside as transparent', () => {
    const data = new Uint8ClampedArray(8 * 5 * 4)
    for (let y = 0; y < 5; y++) for (let x = 0; x < 8; x++) data.set([x * 20, y * 30, 60, 255], (y * 8 + x) * 4)
    const output = render({ type: 'wave', parameters: { amplitude: 2, wavelength: 4 } }, data, 8, 5)
    expect(pixel(output, 8, 3, 1)).toEqual([20, 30, 60, 255])
    expect(pixel(output, 8, 0, 1)).toEqual([0, 0, 0, 0])
    expect(pixel(output, 8, 3, 0)).toEqual(pixel(data, 8, 3, 0))
  })

  it.each(['twirl', 'pinch', 'spherize'] as const)('matches an independent radial inverse mapping for %s in both directions', (type) => {
    const width = 9, height = 9, data = fixture(width, height), center = 4, radius = 4.5
    for (const sign of [-1, 1]) {
      const filter: ImageLayerWholeFilter = { type, parameters: type === 'twirl' ? { angle: sign * 120, radius: 100 } : type === 'pinch' ? { strength: sign * .7, radius: 100 } : { amount: sign * .6, radius: 100 } }, output = render(filter, data, width, height)
      for (const [x, y] of [[0, 0], [3, 2], [5, 4], [8, 8], [4, 4]]) {
        const dx = x - center, dy = y - center, length = Math.sqrt(dx * dx + dy * dy)
        let u = x, v = y
        if (length && length < radius) {
          if (type === 'twirl') {
            const rotation = -sign * 120 * Math.PI / 180 * ((radius - length) / radius) ** 2
            u = center + dx * Math.cos(rotation) - dy * Math.sin(rotation); v = center + dx * Math.sin(rotation) + dy * Math.cos(rotation)
          } else {
            const mapped = type === 'pinch' ? length * (1 + sign * .7 * ((radius - length) / radius) ** 2) : length * .4 + radius * .6 * (sign > 0 ? 2 / Math.PI * Math.asin(length / radius) : Math.sin(Math.PI / 2 * length / radius))
            u = center + mapped * dx / length; v = center + mapped * dy / length
          }
        }
        expect(pixel(output, width, x, y)).toEqual(interpolated(data, width, height, u, v))
      }
    }
  })

  it('matches Brown radial lens correction and independent vignette gain without darkening alpha', () => {
    const width = 9, height = 7, data = fixture(width, height), output = render({ type: 'lens-correction', parameters: { k1: .4, vignette: .6, falloff: 1.5 } }, data, width, height)
    for (const [x, y] of [[0, 0], [2, 1], [4, 3], [7, 5], [8, 6]]) {
      const dx = x - 4, dy = y - 3, r2 = (dx / 4.5) ** 2 + (dy / 3.5) ** 2
      const expected = interpolated(data, width, height, 4 + dx * (1 + .4 * r2), 3 + dy * (1 + .4 * r2)), gain = 1 - .6 * Math.min(1, Math.sqrt(r2 / 2)) ** 1.5
      for (let c = 0; c < 3; c++) expected[c] = new Uint8ClampedArray([expected[c] * gain])[0]
      expect(pixel(output, width, x, y)).toEqual(expected)
    }
  })

  it('keeps iris centers and tilt focus bands unblurred while filtering their outside regions', () => {
    const data = fixture(11, 11, true)
    for (const type of ['iris-blur', 'tilt-shift'] as const) {
      const output = render(defaultWholeLayerFilter(type), data, 11, 11)
      expect(pixel(output, 11, 5, 5)).toEqual(pixel(data, 11, 5, 5))
      expect(pixel(output, 11, 0, 0)).not.toEqual(pixel(data, 11, 0, 0))
    }
  })

  it('keeps neutral operations byte-identical and fails closed for cancellation, timeout and resource limits', () => {
    const data = fixture()
    expect(render({ type: 'gaussian', parameters: { radius: 0 } }, data)).toEqual(data)
    const controller = new AbortController(), input: WholeLayerFilterRasterInput = { data, width: 9, height: 7, filter: defaultWholeLayerFilter('gaussian'), signal: controller.signal }
    const iterator = rasterizeWholeLayerFilterSteps(input)
    expect(iterator.next().done).toBe(false); controller.abort()
    expect(() => finish(iterator)).toThrow('取消')
    expect(() => finish(rasterizeWholeLayerFilterSteps({ ...input, signal: undefined, deadline: 0 }))).toThrow('超时')
    expect(() => finish(rasterizeWholeLayerFilterSteps({ ...input, signal: undefined, width: 4097 }))).toThrow('4096')
    expect(() => finish(rasterizeWholeLayerFilterSteps({ ...input, signal: undefined, referenceSpace: { width: 1, height: 1 }, filter: { type: 'gaussian', parameters: { radius: 80 } } }))).toThrow('处理容量')
  })

  it('yields before building the maximum-radius first window and cancels before reading any pixel', () => {
    const original = fixture(640, 480), controller = new AbortController()
    let reads = 0
    const observed = new Proxy(original, { get(target, key) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, target) } })
    const iterator = rasterizeWholeLayerFilterSteps({ data: observed, width: 640, height: 480, filter: { type: 'gaussian', parameters: { radius: 80 } }, signal: controller.signal })
    expect(iterator.next().done).toBe(false)
    expect(reads).toBe(0)
    controller.abort()
    expect(() => iterator.next()).toThrow('取消')
    expect(reads).toBe(0)
  })
})

describe('whole filter world and local coordinate mapping', () => {
  it.each(wholeLayerFilterDefinitions.map((definition) => definition.type))('keeps the original identity-grid output for %s', (type) => {
    for (const opaque of [true, false]) {
      const width = 9, height = 7, data = fixture(width, height, opaque), filter = defaultWholeLayerFilter(type)
      if (!opaque) data.fill(0, 0, 4)
      const output = finish(rasterizeWholeLayerFilterWorldSteps({ data, width, height, layerWidth: width, layerHeight: height, layerToPixel: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, operation: { mode: 'whole-filter', version: 1, filter, space: { width, height } } }))
      expect(output).toEqual(render(filter, data, width, height))
    }
  })

  it.each(['twirl', 'pinch', 'spherize', 'iris-blur', 'tilt-shift'] as const)('preserves prior 30-degree world detail and partial alpha outside the %s effect', (type) => {
    const width = 96, height = 96, layerWidth = 64, layerHeight = 48, cosine = Math.cos(Math.PI / 6), sine = Math.sin(Math.PI / 6)
    const matrix = { a: cosine, b: sine, c: -sine, d: cosine, e: 48 - cosine * 32 + sine * 24, f: 48 - sine * 32 - cosine * 24 }, data = new Uint8ClampedArray(width * height * 4)
    function local(x: number, y: number): number[] { const dx = x + .5 - matrix.e, dy = y + .5 - matrix.f; return [cosine * dx + sine * dy, -sine * dx + cosine * dy] }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const [u, v] = local(x, y)
      if (u >= 0 && u < layerWidth && v >= 0 && v < layerHeight) data.set([x % 2 ? 255 : 0, y % 2 ? 255 : 0, 127, Math.min(u, v, layerWidth - u, layerHeight - v) < 1.5 ? 96 : 255], (y * width + x) * 4)
    }
    const filter = defaultWholeLayerFilter(type)
    if (type === 'twirl' || type === 'pinch' || type === 'spherize') filter.parameters.radius = 5
    const output = finish(rasterizeWholeLayerFilterWorldSteps({ data, width, height, layerWidth, layerHeight, layerToPixel: matrix, operation: { mode: 'whole-filter', version: 1, filter, space: { width: layerWidth, height: layerHeight } } }))
    let checked = 0, partialAlpha = 0
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const [u, v] = local(x, y), p = filter.parameters
      const unaffected = type === 'iris-blur' ? Math.hypot((u - .5 - p.centerX * layerWidth / 100) / (p.radiusX * layerWidth / 100), (v - .5 - p.centerY * layerHeight / 100) / (p.radiusY * layerHeight / 100)) <= .95 : type === 'tilt-shift' ? Math.abs(v - .5 - p.centerY * layerHeight / 100) <= p.band * layerHeight / 100 - .5 : Math.hypot(u - 32, v - 24) > 2
      if (!unaffected || !data[(y * width + x) * 4 + 3]) continue
      expect(pixel(output, width, x, y)).toEqual(pixel(data, width, x, y))
      checked++; if (data[(y * width + x) * 4 + 3] < 255) partialAlpha++
    }
    expect(checked).toBeGreaterThan(type === 'iris-blur' ? 700 : type === 'tilt-shift' ? 700 : 2500)
    if (type !== 'iris-blur') expect(partialAlpha).toBeGreaterThan(20)
    expect(output).not.toEqual(data)
  })

  it.each(['rotate', 'flip'] as const)('preserves native orientation for %s without changing a prior world raster', (mode) => {
    const width = 5, height = 3, local = fixture(width, height), expected = render({ type: 'mosaic', parameters: { size: 2 } }, local, width, height)
    const worldWidth = mode === 'rotate' ? height : width, worldHeight = mode === 'rotate' ? width : height, world = new Uint8ClampedArray(local.length)
    function target(x: number, y: number): number { return mode === 'rotate' ? (x * worldWidth + height - 1 - y) * 4 : (y * width + width - 1 - x) * 4 }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) world.set(local.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), target(x, y))
    const beforeWorld = world.slice()
    const operation: ImageLayerWholeFilterOperation = { mode: 'whole-filter', version: 1, filter: { type: 'mosaic', parameters: { size: 2 } }, space: { width, height } }
    const output = finish(rasterizeWholeLayerFilterWorldSteps({ data: world, width: worldWidth, height: worldHeight, layerWidth: width, layerHeight: height, operation, layerToPixel: mode === 'rotate' ? { a: 0, b: 1, c: -1, d: 0, e: height, f: 0 } : { a: -1, b: 0, c: 0, d: 1, e: width, f: 0 } }))
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) expect([...output.slice(target(x, y), target(x, y) + 4)]).toEqual(pixel(expected, width, x, y))
    expect(world).toEqual(beforeWorld)
  })
})
