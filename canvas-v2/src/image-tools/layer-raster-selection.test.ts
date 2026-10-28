import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertLayerRasterSelection, buildLayerRasterOutline, buildLayerRasterOutlineSteps,
  buildLayerRasterOutlineSync, combineLayerRasterSelections, invertLayerRasterSelection,
  maximumLayerRasterSelectionBytes, rasterizeLayerGeometricSelection,
  resizeLayerRasterSelection, selectLayerRasterColors,
  type LayerRasterSelection,
} from './layer-raster-selection'

function selection(rows: string[]): LayerRasterSelection {
  const width = rows[0].length, runs: number[] = []
  for (let y = 0; y < rows.length; y++) {
    let start = -1
    for (let x = 0; x <= width; x++) {
      if (rows[y][x] === '#' && start < 0) start = x
      if (rows[y][x] !== '#' && start >= 0) { runs.push(y * width + start, x - start); start = -1 }
    }
  }
  return { width, height: rows.length, runs }
}
function selectedPixels(value: LayerRasterSelection): number[] {
  const pixels: number[] = []
  for (let index = 0; index < value.runs.length; index += 2) {
    for (let point = value.runs[index]; point < value.runs[index] + value.runs[index + 1]; point++) pixels.push(point)
  }
  return pixels
}
function rgba(rows: string[]): Uint8ClampedArray {
  const values = rows.join('').split('').flatMap((pixel) => pixel === '#' ? [20, 50, 80, 255] : [220, 240, 250, 255])
  return new Uint8ClampedArray(values)
}
function alpha(rows: string[]): Uint8ClampedArray {
  return new Uint8ClampedArray(rows.join('').split('').map((pixel) => pixel === '#' ? 255 : 0))
}
function naiveMorph(input: Uint8ClampedArray, width: number, height: number, radius: number, dilate: boolean): Uint8ClampedArray {
  const output = new Uint8ClampedArray(input.length)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = dilate ? 0 : 255
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx, yy = y + dy, sample = xx < 0 || yy < 0 || xx >= width || yy >= height ? 0 : input[yy * width + xx]
      value = dilate ? Math.max(value, sample) : Math.min(value, sample)
    }
    output[y * width + x] = value
  }
  return output
}

afterEach(() => vi.restoreAllMocks())

describe('native raster color selection', () => {
  it('distinguishes four-neighbor components from disconnected matching colors', async () => {
    const rows = ['##..', '#...', '..#.', '...#'], input = { width: 4, height: 4, rgba: rgba(rows), seed: { x: 0, y: 0 }, tolerance: 0 }
    expect(await selectLayerRasterColors({ ...input, contiguous: true })).toEqual(selection(['##..', '#...', '....', '....']))
    expect(await selectLayerRasterColors({ ...input, contiguous: false })).toEqual(selection(rows))
  })

  it('preserves holes instead of replacing the region with a bounding rectangle', async () => {
    const rows = ['#####', '#...#', '#.#.#', '#...#', '#####']
    expect(await selectLayerRasterColors({ width: 5, height: 5, rgba: rgba(rows), seed: { x: 0, y: 0 }, tolerance: 0, contiguous: true })).toEqual(selection(['#####', '#...#', '#...#', '#...#', '#####']))
  })

  it('does not cross a domain gap and allows global sampling from outside the domain', async () => {
    const input = { width: 5, height: 1, rgba: rgba(['#####']), seed: { x: 0, y: 0 }, tolerance: 0, domain: selection(['##.##']) }
    expect(await selectLayerRasterColors({ ...input, contiguous: true })).toEqual(selection(['##...']))
    expect(await selectLayerRasterColors({ ...input, contiguous: false })).toEqual(selection(['##.##']))
    expect(await selectLayerRasterColors({ ...input, seed: { x: 2, y: 0 }, contiguous: true })).toEqual(selection(['.....']))
    expect(await selectLayerRasterColors({ ...input, seed: { x: 2, y: 0 }, contiguous: false })).toEqual(selection(['##.##']))
  })

  it('uses inclusive maximum-channel tolerance and alpha-aware transparent matching', async () => {
    const opaque = new Uint8ClampedArray([100, 100, 100, 255, 132, 100, 100, 255, 133, 100, 100, 255])
    expect((await selectLayerRasterColors({ width: 3, height: 1, rgba: opaque, seed: { x: 0, y: 0 }, tolerance: 32, contiguous: false })).runs).toEqual([0, 2])
    const transparent = new Uint8ClampedArray([255, 1, 130, 0, 0, 200, 255, 0, 255, 255, 255, 1, 0, 0, 0, 255])
    expect((await selectLayerRasterColors({ width: 4, height: 1, rgba: transparent, seed: { x: 0, y: 0 }, tolerance: 0, contiguous: false })).runs).toEqual([0, 2])
    expect((await selectLayerRasterColors({ width: 4, height: 1, rgba: transparent, seed: { x: 0, y: 0 }, tolerance: 1, contiguous: false })).runs).toEqual([0, 3])
  })

  it('supports explicit color-range samples and rejects a mismatched contiguous seed', async () => {
    const input = { width: 4, height: 1, rgba: rgba(['.##.']), seed: { x: 0, y: 0 }, tolerance: 0, color: [20, 50, 80, 255] as const }
    expect(await selectLayerRasterColors({ ...input, contiguous: false })).toEqual(selection(['.##.']))
    expect(await selectLayerRasterColors({ ...input, contiguous: true })).toEqual(selection(['....']))
    expect(await selectLayerRasterColors({ ...input, seed: { x: 1, y: 0 }, contiguous: true })).toEqual(selection(['.##.']))
    await expect(selectLayerRasterColors({ ...input, color: [256, 0, 0, 255], contiguous: false })).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('matches a reference flood fill over deterministic irregular domains', async () => {
    let random = 713
    function next() { random = (random * 16807) % 2147483647; return random }
    for (let sample = 0; sample < 100; sample++) {
      const width = 9, height = 7, rows = Array.from({ length: height }, () => Array.from({ length: width }, () => next() % 3 ? '#' : '.').join(''))
      const domain = Array.from({ length: height }, () => Array.from({ length: width }, () => next() % 5 ? '#' : '.').join(''))
      const x = next() % width, y = next() % height, target = rows[y][x], visited = new Set<number>(), pending = [y * width + x]
      while (pending.length) {
        const index = pending.pop()!, xx = index % width, yy = Math.floor(index / width)
        if (visited.has(index) || domain[yy][xx] !== '#' || rows[yy][xx] !== target) continue
        visited.add(index)
        if (xx > 0) pending.push(index - 1)
        if (xx + 1 < width) pending.push(index + 1)
        if (yy > 0) pending.push(index - width)
        if (yy + 1 < height) pending.push(index + width)
      }
      const result = await selectLayerRasterColors({ width, height, rgba: rgba(rows), seed: { x, y }, tolerance: 0, contiguous: true, domain: selection(domain) })
      expect(selectedPixels(result)).toEqual([...visited].sort((a, b) => a - b))
      assertLayerRasterSelection(result)
    }
  })

  it.each([{ x: -1, y: 0 }, { x: 3, y: 0 }, { x: 0.1, y: 0 }, { x: 0, y: 1 }])('rejects invalid sample coordinates %j', async (seed) => {
    await expect(selectLayerRasterColors({ width: 3, height: 1, rgba: rgba(['###']), seed, tolerance: 0, contiguous: true })).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('rejects invalid dimensions, pixel buffers, tolerances and incompatible domains', async () => {
    const input = { width: 2, height: 1, rgba: rgba(['##']), seed: { x: 0, y: 0 }, tolerance: 32, contiguous: false }
    for (const patch of [{ width: 4097 }, { width: 0 }, { height: 0.5 }, { rgba: new Uint8ClampedArray(7) }, { tolerance: NaN }, { tolerance: 256 }, { tolerance: -1 }, { domain: selection(['#']) }]) {
      await expect(selectLayerRasterColors({ ...input, ...patch })).rejects.toMatchObject({ code: 'invalid-input' })
    }
  })

  it('rejects overly fragmented native masks without downsampling or partial output', async () => {
    const rows = Array.from({ length: 129 }, (_, y) => Array.from({ length: 128 }, (_, x) => (x + y) % 2 ? '.' : '#').join(''))
    await expect(selectLayerRasterColors({ width: 128, height: 129, rgba: rgba(rows), seed: { x: 0, y: 0 }, tolerance: 0, contiguous: false })).rejects.toMatchObject({ code: 'too-complex' })
  })
})

describe('canonical raster selection operations', () => {
  it.each([[1, 2], [0, 1, 1, 1], [3, 2], [0, 0], [0.5, 1], [0, 2, 1, 1], [7, 2], [0]].map((runs) => ({ runs })))('rejects malformed or noncanonical runs $runs', ({ runs }) => {
    // [1,2] is legal in a wider row but crosses this two-pixel row.
    expect(() => assertLayerRasterSelection({ width: 2, height: 4, runs })).toThrow()
  })

  it('checks encoded byte capacity independently of the run count', () => {
    const runs = Array.from({ length: 7000 }, (_, index) => [8_388_608 + index * 2, 1]).flat()
    const value = { width: 4096, height: 4096, runs }
    expect(JSON.stringify(value).length).toBeGreaterThan(maximumLayerRasterSelectionBytes)
    expect(() => assertLayerRasterSelection(value)).toThrow(/保存容量/)
  })

  it('rasterizes geometric selections at pixel centers and supports inversion', async () => {
    const input = { width: 5, height: 5, kind: 'rectangle' as const, rect: { x: 1, y: 1, width: 3, height: 3 } }
    expect(await rasterizeLayerGeometricSelection(input)).toEqual(selection(['.....', '.###.', '.###.', '.###.', '.....']))
    expect(await rasterizeLayerGeometricSelection({ ...input, kind: 'ellipse', rect: { x: 0, y: 0, width: 5, height: 5 } })).toEqual(selection(['.###.', '#####', '#####', '#####', '.###.']))
    expect(await rasterizeLayerGeometricSelection({ ...input, inverted: true })).toEqual(selection(['#####', '#...#', '#...#', '#...#', '#####']))
  })

  it('combines exact membership and canonicalizes adjacent runs without mutating inputs', async () => {
    const a = selection(['##..', '#...']), b = selection(['.###', '..#.']), before = JSON.stringify([a, b])
    expect(await combineLayerRasterSelections(a, b, 'add')).toEqual(selection(['####', '#.#.']))
    expect(await combineLayerRasterSelections(a, b, 'subtract')).toEqual(selection(['#...', '#...']))
    expect(await combineLayerRasterSelections(a, b, 'intersect')).toEqual(selection(['.#..', '....']))
    const replacement = await combineLayerRasterSelections(a, b, 'replace')
    expect(replacement).toEqual(b); expect(replacement.runs).not.toBe(b.runs)
    expect(JSON.stringify([a, b])).toBe(before)
    await expect(combineLayerRasterSelections(a, selection(['#']), 'add')).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('inverts empty/full masks and preserves their original dimensions', async () => {
    const empty = selection(['....', '....'])
    const full = await invertLayerRasterSelection(empty)
    expect(full).toEqual(selection(['####', '####']))
    expect(await invertLayerRasterSelection(full)).toEqual(empty)
    const native = await invertLayerRasterSelection({ width: 4096, height: 2, runs: [] })
    expect(native).toEqual({ width: 4096, height: 2, runs: [0, 4096, 4096, 4096] })
  })

  it('preserves all pixels at the maximum native resolution within the encoded budget', async () => {
    const native = await invertLayerRasterSelection({ width: 4096, height: 4096, runs: [] })
    expect(native.width).toBe(4096); expect(native.height).toBe(4096)
    expect(native.runs).toHaveLength(8192)
    expect(native.runs.slice(-2)).toEqual([4095 * 4096, 4096])
    expect(native.runs.filter((_, index) => index % 2).reduce((sum, length) => sum + length, 0)).toBe(16_777_216)
    expect(JSON.stringify(native).length).toBeLessThan(maximumLayerRasterSelectionBytes)
    assertLayerRasterSelection(native)
  })

  it('expands and contracts exact raster coverage including image edges and holes', async () => {
    const point = selection(['.....', '.....', '..#..', '.....', '.....'])
    const block = selection(['.....', '.###.', '.###.', '.###.', '.....'])
    expect(await resizeLayerRasterSelection(point, 1)).toEqual(block)
    expect(await resizeLayerRasterSelection(block, -1)).toEqual(point)
    expect(await resizeLayerRasterSelection(selection(['###', '###', '###']), -1)).toEqual(selection(['...', '.#.', '...']))
    expect(await resizeLayerRasterSelection(selection(['###', '#.#', '###']), 1)).toEqual(selection(['###', '###', '###']))
    await expect(resizeLayerRasterSelection(point, 65)).rejects.toMatchObject({ code: 'invalid-input' })
  })
})

describe('bounded alpha outline core', () => {
  it.each(['inside', 'center', 'outside'] as const)('matches a brute-force square morphology for %s strokes and gray alpha', async (position) => {
    const width = 7, height = 6, source = new Uint8ClampedArray(width * height)
    for (let index = 0; index < source.length; index++) source[index] = (index * 47 + index % 3 * 80) % 256
    for (const widthPixels of [1, 2, 3, 5]) {
      const outside = position === 'inside' ? 0 : position === 'outside' ? widthPixels : Math.ceil(widthPixels / 2)
      const inside = position === 'outside' ? 0 : position === 'inside' ? widthPixels : Math.floor(widthPixels / 2)
      const high = naiveMorph(source, width, height, outside, true), low = naiveMorph(source, width, height, inside, false)
      const expected = high.map((value, index) => value - low[index]), input = { width, height, alpha: source, widthPixels, position }
      expect(buildLayerRasterOutlineSync(input)).toEqual(expected)
      expect(await buildLayerRasterOutline(input)).toEqual(expected)
      const steps = buildLayerRasterOutlineSteps(input)
      let next = steps.next()
      while (!next.done) next = steps.next()
      expect(next.value).toEqual(expected)
    }
  })

  it('outlines hole boundaries and treats pixels outside the supplied alpha surface as transparent', () => {
    const rows = ['.....', '.###.', '.#.#.', '.###.', '.....'], source = alpha(rows)
    const output = buildLayerRasterOutlineSync({ width: 5, height: 5, alpha: source, widthPixels: 1, position: 'outside' })
    expect(output).toEqual(alpha(['#####', '#...#', '#.#.#', '#...#', '#####']))
    expect(source).toEqual(alpha(rows))
    expect(buildLayerRasterOutlineSync({ width: 2, height: 2, alpha: alpha(['##', '##']), widthPixels: 1, position: 'inside' })).toEqual(alpha(['##', '##']))
  })

  it('interpolates fractional preview widths without forcing a fully opaque pixel', () => {
    const input = { width: 5, height: 5, alpha: alpha(['.....', '.....', '..#..', '.....', '.....']), position: 'outside' as const }
    const one = buildLayerRasterOutlineSync({ ...input, widthPixels: 1 })
    expect(buildLayerRasterOutlineSync({ ...input, widthPixels: 0.5 })).toEqual(one.map((value) => value * 0.5))
    const two = buildLayerRasterOutlineSync({ ...input, widthPixels: 2 })
    expect(buildLayerRasterOutlineSync({ ...input, widthPixels: 1.25 })).toEqual(one.map((value, index) => value * 0.75 + two[index] * 0.25))
  })

  it('accepts bounded halo strips and scaled widths while rejecting excessive surfaces', () => {
    expect(buildLayerRasterOutlineSync({ width: 5384, height: 1, alpha: new Uint8Array(5384), widthPixels: 512, position: 'outside' })).toHaveLength(5384)
    for (const [width, height] of [[5385, 1], [5384, 5384]]) {
      expect(() => buildLayerRasterOutlineSync({ width, height, alpha: new Uint8Array(0), widthPixels: 1, position: 'outside' })).toThrow(/尺寸/)
    }
    for (const widthPixels of [0, NaN, 512.1]) expect(() => buildLayerRasterOutlineSync({ width: 1, height: 1, alpha: new Uint8Array(1), widthPixels, position: 'outside' })).toThrow(/描边/)
  })
})

describe('cooperative work limits', () => {
  it('rejects an already cancelled operation without changing its input', async () => {
    const controller = new AbortController(), input = selection(['##', '##'])
    controller.abort()
    await expect(invertLayerRasterSelection(input, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', code: 'cancelled' })
    expect(input).toEqual(selection(['##', '##']))
  })

  it('yields during color matching and observes cancellation before completing a large region', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now += 4)
    const controller = new AbortController(), yieldControl = vi.fn(async () => { controller.abort() })
    const data = new Uint8ClampedArray(256 * 256 * 4)
    await expect(selectLayerRasterColors({ width: 256, height: 256, rgba: data, seed: { x: 0, y: 0 }, tolerance: 0, contiguous: true }, { signal: controller.signal, yieldControl })).rejects.toMatchObject({ code: 'cancelled' })
    expect(yieldControl).toHaveBeenCalledTimes(1)
  })

  it('supports cancelling a suspended outline generator and its async wrapper', async () => {
    const input = { width: 256, height: 256, alpha: new Uint8Array(256 * 256).fill(255), widthPixels: 2, position: 'inside' as const }, controller = new AbortController()
    const steps = buildLayerRasterOutlineSteps(input, { signal: controller.signal })
    expect(steps.next().done).toBe(false)
    controller.abort()
    expect(() => steps.next()).toThrow(/取消/)
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now += 4)
    const second = new AbortController()
    await expect(buildLayerRasterOutline(input, { signal: second.signal, yieldControl: async () => { second.abort() } })).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('enforces a synchronous time budget as well as the asynchronous budget', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now += 1)
    const input = { width: 256, height: 256, alpha: new Uint8Array(256 * 256), widthPixels: 4, position: 'outside' as const }
    expect(() => buildLayerRasterOutlineSync(input, { maxMilliseconds: 2 })).toThrow(/时间限制/)
    await expect(buildLayerRasterOutline(input, { maxMilliseconds: 2 })).rejects.toMatchObject({ code: 'time-budget' })
    await expect(invertLayerRasterSelection(selection(['#']), { maxMilliseconds: 10001 })).rejects.toMatchObject({ code: 'invalid-input' })
  })
})
