import { describe, expect, it } from 'vitest'
import { assertLayerFilterPresentationBudget, buildLayerFilterPresentationFrame, layerFilterPresentationPoint, maximumLayerFilterPresentationPixels } from './layer-filter-presentation'
import type { ImageLayerRecipe } from './recipe'

function recipe(): ImageLayerRecipe { return { kind: 'layer', outputWidth: 320, outputHeight: 180, background: 'transparent', explicitLayers: true, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 2, height: 480 / 180, rotation: 0, visible: true, opacity: .4, blend: 'multiply' }] } }

describe('full layer presentation geometry', () => {
  it('presents the complete upright layer without changing the smaller document or recipe', () => {
    const value = recipe(), before = JSON.stringify(value), frame = buildLayerFilterPresentationFrame(value, 0)
    expect(frame).toMatchObject({ width: 640, height: 480, worldBounds: { x: -2, y: -2, width: 644, height: 484 }, replayRect: { x: -0, y: -0, width: 320, height: 180 } })
    expect(frame.documentPolygon).toEqual([[0, 0], [320, 0], [320, 180], [0, 180]])
    expect(JSON.stringify(value)).toBe(before)
  })

  it.each([[30, false, false], [-37, true, false], [112, false, true], [-90, true, true]] as const)('keeps the original world transform for rotation %s and flips %s/%s', (rotation, flipX, flipY) => {
    const value = recipe(); value.layers[0] = { ...value.layers[0], x: -.2, y: .1, rotation, flipX, flipY }
    const frame = buildLayerFilterPresentationFrame(value, 0), radians = rotation * Math.PI / 180
    expect([frame.width, frame.height]).toEqual([640, 480])
    for (const [x, y] of [[0, 0], [640, 0], [640, 480], [0, 480], [123.5, 241.75]]) {
      const rotatedX = Math.cos(radians) * (x - 320) - Math.sin(radians) * (y - 240), rotatedY = Math.sin(radians) * (x - 320) + Math.cos(radians) * (y - 240)
      const world = layerFilterPresentationPoint(frame.layerToWorld, x, y)
      expect(world[0]).toBeCloseTo(256 + (flipX ? -1 : 1) * rotatedX)
      expect(world[1]).toBeCloseTo(258 + (flipY ? -1 : 1) * rotatedY)
      const back = layerFilterPresentationPoint(frame.worldToLayer, ...world)
      expect(back[0]).toBeCloseTo(x); expect(back[1]).toBeCloseTo(y)
    }
    for (const [index, point] of [[0, [0, 0]], [1, [320, 0]], [2, [320, 180]], [3, [0, 180]]] as const) {
      const world = layerFilterPresentationPoint(frame.layerToWorld, ...frame.documentPolygon[index])
      expect(world[0]).toBeCloseTo(point[0]); expect(world[1]).toBeCloseTo(point[1])
    }
  })

  it('retains the original replay region and crop offset in current document coordinates', () => {
    const value = recipe(); value.outputWidth = 40; value.outputHeight = 28; value.documentFrame = { version: 1, width: 320, height: 180, offsetX: 200, offsetY: 140 }
    value.layers[0] = { ...value.layers[0], x: -5, y: -5, width: 16, height: 480 / 28 }
    const frame = buildLayerFilterPresentationFrame(value, 0)
    expect(frame).toMatchObject({ width: 640, height: 480, replayRect: { x: -200, y: -140, width: 320, height: 180 }, worldBounds: { x: -202, y: -142, width: 644, height: 484 } })
    expect(frame.documentPolygon).toEqual([[200, 140], [240, 140], [240, 168], [200, 168]])
  })

  it('keeps before and after geometry identical for any ordered filter and mask', () => {
    const value = recipe(), before = buildLayerFilterPresentationFrame(value, 0)
    value.layers[0].edits = { version: 1, operations: [{ mode: 'whole-filter', version: 1, filter: { type: 'gaussian', parameters: { radius: 20 } }, space: { width: 640, height: 480 } }] }
    value.layers[0].mask = { kind: 'ellipse', transform: [1, 0, 0, 1, 0, 0], inverted: true }
    expect(buildLayerFilterPresentationFrame(value, 0)).toEqual(before)
  })

  it('accepts a full 4K layer with halo and rejects per-surface or retained-surface overflow', () => {
    const value = recipe(); value.outputWidth = 4096; value.outputHeight = 4096; value.layers[0] = { ...value.layers[0], width: 1, height: 1 }
    expect(buildLayerFilterPresentationFrame(value, 0).worldBounds).toMatchObject({ width: 4100, height: 4100 })
    expect(maximumLayerFilterPresentationPixels).toBe(37_949_472)
    expect(() => assertLayerFilterPresentationBudget([{ width: 4356, height: 4356 }, { width: 4356, height: 4356 }])).not.toThrow()
    expect(() => assertLayerFilterPresentationBudget([{ width: 4357, height: 1 }])).toThrow('安全容量')
    expect(() => assertLayerFilterPresentationBudget(Array.from({ length: 3 }, () => ({ width: 4096, height: 4096 })))).toThrow('临时像素')
    value.layers[0].rotation = 45
    expect(() => buildLayerFilterPresentationFrame(value, 0)).toThrow('安全容量')
  })

  it('rejects invalid dimensions and keeps fractional physical sizes invertible', () => {
    const value = recipe(); value.layers[0].width = 2.001
    const frame = buildLayerFilterPresentationFrame(value, 0)
    expect(frame.width).toBe(640)
    expect(layerFilterPresentationPoint(frame.layerToWorld, 640, 0)[0]).toBeCloseTo(640.32)
    for (const width of [0, NaN, Infinity]) { value.layers[0].width = width; expect(() => buildLayerFilterPresentationFrame(value, 0)).toThrow() }
    expect(() => buildLayerFilterPresentationFrame(recipe(), 8)).toThrow('选择')
  })
})
