import { describe, expect, it } from 'vitest'
import { rasterizeLayerLiquifySteps, assertLayerLiquifySize, type LayerLiquifyRasterInput } from './layer-liquify-raster'
import type { ImageLayerLiquifyOperation, ImageLayerLiquifyTool } from './layer-liquify'

function fixture(tool: ImageLayerLiquifyTool = 'bulge', width = 17, height = 17): LayerLiquifyRasterInput {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x * 13 % 256, y * 11 % 256, (x + y) * 7 % 256, (x * 31 + y * 17) % 256], (y * width + x) * 4)
  return { data, width, height, operation: { mode: 'liquify', version: 1, space: { width, height }, strokes: [{ tool, radius: 7, strength: .8, points: tool === 'push' ? [[4000, 5000], [6000, 5000]] : [[5000, 5000]] }] } }
}
function render(input: LayerLiquifyRasterInput): Uint8ClampedArray {
  const iterator = rasterizeLayerLiquifySteps(input)
  let step = iterator.next()
  while (!step.done) step = iterator.next()
  return step.value
}
// Independent single-stamp oracle: normalized-coordinate radial equations and
// explicit four-neighbour premultiplied sampling, no kernel helpers imported.
function radialOracle(input: LayerLiquifyRasterInput): Uint8ClampedArray {
  const { width, height, data } = input, stroke = input.operation.strokes[0], output = data.slice()
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = x + .5 - width / 2, dy = y + .5 - height / 2, radius = Math.hypot(dx, dy)
    if (radius >= stroke.radius) continue
    const weight = (1 - (radius / stroke.radius) ** 2) ** 2 * stroke.strength
    let sx = x, sy = y
    if (stroke.tool === 'bulge' || stroke.tool === 'pinch') { const factor = 1 + (stroke.tool === 'bulge' ? -.35 : .35) * weight; sx = width / 2 + dx * factor - .5; sy = height / 2 + dy * factor - .5 }
    else { const angle = (stroke.tool === 'twirl-cw' ? -1 : 1) * Math.PI / 8 * weight; sx = width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle) - .5; sy = height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) - .5 }
    const at = (y * width + x) * 4, accum = [0, 0, 0, 0]
    if (Math.abs(sx - x) + Math.abs(sy - y) < 1e-10) continue
    for (const yy of [Math.floor(sy), Math.floor(sy) + 1]) for (const xx of [Math.floor(sx), Math.floor(sx) + 1]) {
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue
      const index = (yy * width + xx) * 4, a = data[index + 3] * (1 - Math.abs(sx - xx)) * (1 - Math.abs(sy - yy))
      for (let c = 0; c < 3; c++) accum[c] += data[index + c] * a
      accum[3] += a
    }
    for (let c = 0; c < 3; c++) output[at + c] = accum[3] ? accum[c] / accum[3] : 0
    output[at + 3] = accum[3]
  }
  return output
}
describe('bounded liquify pixel rendering', () => {
  it.each(['bulge', 'pinch', 'twirl-cw', 'twirl-ccw'] as const)('matches an independent inverse-mapping oracle for %s including alpha', (tool) => {
    const input = fixture(tool), expected = radialOracle(input), before = input.data.slice(), actual = render(input)
    expect(Math.max(...actual.map((v, i) => Math.abs(v - expected[i])))).toBeLessThanOrEqual(1)
    expect(actual).not.toEqual(before); expect(input.data).toEqual(before)
  })
  it('pushes texture in drag direction and remains independent of event density on a straight line', () => {
    const input = fixture('push'), dense = structuredClone(input)
    dense.operation.strokes[0].points = [[4000, 5000], [4500, 5000], [5000, 5000], [5500, 5000], [6000, 5000]]
    const output = render(input), at = (8 * 17 + 9) * 4
    expect(output[at]).toBeLessThan(input.data[at])
    expect(output).toEqual(render(dense))
  })
  it('matches an explicit one-stamp push oracle for all RGBA pixels', () => {
    const input = fixture('push', 20, 20), stroke = input.operation.strokes[0], expected = input.data.slice()
    stroke.radius = 8; stroke.points = [[4000, 5000], [4500, 5000]]
    // A one-pixel right drag is shorter than the two-pixel uniform spacing,
    // therefore exactly one terminal stamp at (9,10) is required.
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
      const distance = Math.hypot(x + .5 - 9, y + .5 - 10)
      if (distance >= 8) continue
      const sourceX = x - .8 * Math.pow(1 - distance * distance / 64, 2), left = Math.floor(sourceX), fraction = sourceX - left, at = (y * 20 + x) * 4
      const alphaA = left >= 0 ? input.data[(y * 20 + left) * 4 + 3] * (1 - fraction) : 0, alphaB = left + 1 < 20 ? input.data[(y * 20 + left + 1) * 4 + 3] * fraction : 0
      for (let c = 0; c < 3; c++) expected[at + c] = alphaA + alphaB ? ((left >= 0 ? input.data[(y * 20 + left) * 4 + c] * alphaA : 0) + (left + 1 < 20 ? input.data[(y * 20 + left + 1) * 4 + c] * alphaB : 0)) / (alphaA + alphaB) : 0
      expected[at + 3] = alphaA + alphaB
    }
    const actual = render(input)
    expect(Math.max(...actual.map((value, index) => Math.abs(value - expected[index])))).toBeLessThanOrEqual(1)
  })
  it('does not bleed hidden RGB into a transparent deformed silhouette', () => {
    const input = fixture('pinch')
    for (let i = 0; i < input.width * input.height; i++) input.data.set(i % input.width < 8 ? [255, 0, 0, 255] : [0, 255, 255, 0], i * 4)
    const output = render(input)
    for (let i = 0; i < input.width * input.height; i++) if (output[i * 4 + 3] > 0) expect([...output.slice(i * 4, i * 4 + 3)]).toEqual([255, 0, 0])
  })
  it('replays each stroke against frozen preceding pixels in the original order', () => {
    const input = fixture('bulge'), second = fixture('twirl-cw').operation.strokes[0], both = structuredClone(input)
    both.operation.strokes.push(second)
    expect(render(both)).toEqual(render({ ...input, data: render(input), operation: { ...input.operation, strokes: [second] } }))
    const backwards = structuredClone(both); backwards.operation.strokes.reverse()
    expect(render(both)).not.toEqual(render(backwards))
  })
  it('maps a quarter-turned layer to the same local deformation', () => {
    const input = fixture('bulge'), rotate = (data: Uint8ClampedArray) => { const result = new Uint8ClampedArray(data.length); for (let y = 0; y < 17; y++) for (let x = 0; x < 17; x++) result.set(data.slice((y * 17 + x) * 4, (y * 17 + x) * 4 + 4), (x * 17 + (16 - y)) * 4); return result }
    const actual = render({ ...input, data: rotate(input.data), pixelToLayer: { a: 0, b: -1, c: 1, d: 0, e: 0, f: 17 } })
    const expected = rotate(render(input))
    expect(Math.max(...actual.map((v, i) => Math.abs(v - expected[i])))).toBeLessThanOrEqual(1)
  })
  it('keeps zero strength byte-identical and aborts without altering caller pixels', () => {
    const input = fixture('push', 80, 80), before = input.data.slice()
    const zero = structuredClone(input); zero.operation.strokes[0].strength = 0
    expect(render(zero)).toEqual(before)
    const controller = new AbortController(), iterator = rasterizeLayerLiquifySteps({ ...input, signal: controller.signal })
    expect(iterator.next().done).toBe(false); controller.abort()
    expect(() => iterator.next()).toThrow('取消'); expect(input.data).toEqual(before)
    expect(() => render({ ...input, deadline: 0 })).toThrow('超时')
    expect(() => assertLayerLiquifySize(4096, 4096)).not.toThrow(); expect(() => assertLayerLiquifySize(4357, 1)).toThrow('容量')
    expect(() => render({ ...input, pixelToLayer: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 } })).toThrow('空间')
  })
  it('uses transparent sampling outside the original image and enforces work budgets', () => {
    const input = fixture('pinch', 3, 3); input.data.fill(255); input.operation.strokes[0].radius = 10
    expect([...render(input)].filter((_, i) => i % 4 === 3).some((a) => a < 255)).toBe(true)
    const huge: ImageLayerLiquifyOperation = { mode: 'liquify', version: 1, space: { width: 4096, height: 4096 }, strokes: [{ tool: 'push', radius: 1, strength: 1, points: [[0, 0], [10000, 10000]] }] }
    expect(() => render({ ...input, operation: huge })).toThrow('路径过长')
  })
})
