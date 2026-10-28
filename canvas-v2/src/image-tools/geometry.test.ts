import { describe, expect, it } from 'vitest'
import { buildImageTransformFrames, fitImageTransform, imageLayerRasterSelectionFromOutput, imageLayerSelectionFromOutputRect, imageTransformGrid } from './geometry'
import { defaultImageTransformRecipe, type ImageLayer, type ImageLayerRecipe, type ImageTransformRecipe } from './recipe'

describe('image transform pixel geometry', () => {
  it('anchors native raster samples through the same flipped rotation affine without rewriting their pixel grid', () => {
    const layer: ImageLayer = { sourceIndex: 0, x: -0.1, y: 0.2, width: 1.5, height: 0.7, rotation: 37, opacity: 1, blend: 'source-over', visible: true, flipX: true, flipY: true }
    const output = { width: 800, height: 600 }, rect = { x: 20, y: 30, width: 4, height: 2 }, raster = { width: 4, height: 2, runs: [0, 2, 4, 4] }
    const expected = imageLayerSelectionFromOutputRect(layer, output, rect, 'rectangle', true, 5)
    const actual = imageLayerRasterSelectionFromOutput(layer, output, rect, raster, true, 5)
    expect(actual).toEqual({ ...expected, kind: 'raster', raster })
    raster.runs[0] = 1
    expect(actual).toMatchObject({ raster: { runs: [0, 2, 4, 4] } })
    expect(() => imageLayerRasterSelectionFromOutput(layer, output, rect, { ...raster, runs: [3, 2] })).toThrow('跨行')
  })
  it('snapshots output-pixel feather against local layer dimensions without changing the old affine mapping', () => {
    const layer: ImageLayer = { sourceIndex: 0, x: 0, y: 0, width: 0.8, height: 0.4, rotation: 45, opacity: 1, blend: 'source-over', visible: true, flipX: true }
    const output = { width: 800, height: 600 }, rect = { x: 100, y: 70, width: 240, height: 180 }
    const old = imageLayerSelectionFromOutputRect(layer, output, rect, 'ellipse', true)
    expect(imageLayerSelectionFromOutputRect(layer, output, rect, 'ellipse', true, 5)).toEqual({ ...old, feather: { radius: 5, space: { width: 640, height: 240 } } })
    expect(imageLayerSelectionFromOutputRect(layer, output, rect, 'ellipse', true, 0)).toEqual(old)
    expect(() => imageLayerSelectionFromOutputRect(layer, output, rect, 'ellipse', true, 129)).toThrow('羽化半径')
  })
  it.each([0, 30, 90, -135])('keeps world-axis selections exact after %s degree rotation and both output flips', (rotation) => {
    for (const flipX of [true, false]) for (const flipY of [true, false]) {
      const layer: ImageLayer = { sourceIndex: 0, x: -0.1, y: 0.2, width: 0.8, height: 0.4, rotation, opacity: 1, blend: 'source-over', visible: true, flipX, flipY }
      const output = { width: 800, height: 600 }, rect = { x: 100, y: 70, width: 240, height: 180 }
      const selection = imageLayerSelectionFromOutputRect(layer, output, rect, 'ellipse', true)
      const [a, b, c, d, e, f] = selection.transform, angle = rotation * Math.PI / 180
      for (const [u, v] of [[0, 0], [0, 1], [1, 0], [1, 1], [0.5, 0.5]]) {
        const localX = (a * u + c * v + e - 0.5) * layer.width * output.width
        const localY = (b * u + d * v + f - 0.5) * layer.height * output.height
        const worldX = (layer.x + layer.width / 2) * output.width + (flipX ? -1 : 1) * (Math.cos(angle) * localX - Math.sin(angle) * localY)
        const worldY = (layer.y + layer.height / 2) * output.height + (flipY ? -1 : 1) * (Math.sin(angle) * localX + Math.cos(angle) * localY)
        expect(worldX).toBeCloseTo(rect.x + rect.width * u, 8)
        expect(worldY).toBeCloseTo(rect.y + rect.height * v, 8)
      }
    }
  })

  it('plans zero-source transparent painting with ordered edits and an independent mask', () => {
    const layer: ImageLayer = { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 0.4, blend: 'multiply', visible: true, content: { kind: 'paint' }, edits: { version: 1, operations: [{ mode: 'erase', points: [[5000, 5000]], size: 30, hardness: 0.5, opacity: 1, color: '#000000', space: { width: 100, height: 80 } }] }, mask: { kind: 'rectangle', transform: [1, 0, 0, 1, 0, 0], inverted: false } }
    const [frame] = buildImageTransformFrames([], { kind: 'layer', outputWidth: 100, outputHeight: 80, background: 'transparent', layers: [layer] })
    expect(frame.draws[0]).toMatchObject({ content: layer.content, edits: layer.edits, mask: layer.mask, opacity: 0.4, blend: 'multiply' })
  })
  it('partitions odd dimensions in row-major order without losing edge pixels', () => {
    expect(imageTransformGrid({ width: 15, height: 11 }, 2, 3, 1, 1)).toEqual([
      { x: 1, y: 1, width: 3, height: 4 }, { x: 5, y: 1, width: 4, height: 4 }, { x: 10, y: 1, width: 4, height: 4 },
      { x: 1, y: 6, width: 3, height: 4 }, { x: 5, y: 6, width: 4, height: 4 }, { x: 10, y: 6, width: 4, height: 4 },
    ])
  })

  it('rejects padding that leaves less than one pixel in each grid cell', () => {
    expect(() => imageTransformGrid({ width: 5, height: 5 }, 3, 3, 1, 1)).toThrow('尺寸不足')
  })

  it('centres contain images and crops cover images instead of stretching them', () => {
    const target = { x: 10, y: 20, width: 100, height: 100 }
    expect(fitImageTransform({ width: 200, height: 100 }, target, 'contain')).toEqual({ source: { x: 0, y: 0, width: 200, height: 100 }, destination: { x: 10, y: 45, width: 100, height: 50 } })
    expect(fitImageTransform({ width: 200, height: 100 }, target, 'cover')).toEqual({ source: { x: 50, y: 0, width: 100, height: 100 }, destination: target })
  })

  it('rotates the crop into the requested output dimensions and preserves output-axis flips', () => {
    const recipe: ImageTransformRecipe = { kind: 'crop', x: 0.2, y: 0.1, width: 0.5, height: 0.6, outputWidth: 120, outputHeight: 80, rotation: 90, flipX: true, flipY: false }
    const [frame] = buildImageTransformFrames([{ width: 200, height: 100 }], recipe)
    expect(frame).toMatchObject({ width: 120, height: 80, background: 'transparent' })
    expect(frame.draws).toEqual([{ sourceIndex: 0, source: { x: 40, y: 10, width: 100, height: 60 }, destination: { x: 20, y: -20, width: 80, height: 120 }, rotation: 90, flipX: true, flipY: false, opacity: 1, blend: 'source-over' }])
  })

  it('clamps a tolerated floating-point crop boundary to the source image', () => {
    const recipe: ImageTransformRecipe = { kind: 'crop', x: 0.9, y: 0, width: 0.1000005, height: 1, outputWidth: 10, outputHeight: 10, rotation: 0, flipX: false, flipY: false }
    expect(buildImageTransformFrames([{ width: 100, height: 100 }], recipe)[0].draws[0].source).toEqual({ x: 90, y: 0, width: 10, height: 100 })
  })

  it('makes row-major grid outputs with independent dimensions and transparent backgrounds', () => {
    const frames = buildImageTransformFrames([{ width: 7, height: 5 }], { kind: 'grid-split', rows: 2, columns: 2, gap: 1, padding: 0 })
    expect(frames.map((frame) => ({ width: frame.width, height: frame.height, source: frame.draws[0].source, destination: frame.draws[0].destination }))).toEqual([
      { width: 3, height: 2, source: { x: 0, y: 0, width: 3, height: 2 }, destination: { x: 0, y: 0, width: 3, height: 2 } },
      { width: 3, height: 2, source: { x: 4, y: 0, width: 3, height: 2 }, destination: { x: 0, y: 0, width: 3, height: 2 } },
      { width: 3, height: 2, source: { x: 0, y: 3, width: 3, height: 2 }, destination: { x: 0, y: 0, width: 3, height: 2 } },
      { width: 3, height: 2, source: { x: 4, y: 3, width: 3, height: 2 }, destination: { x: 0, y: 0, width: 3, height: 2 } },
    ])
    expect(frames.every((frame) => frame.background === 'transparent')).toBe(true)
  })

  it('preserves collage input order and leaves missing cells as background', () => {
    const recipe: ImageTransformRecipe = { kind: 'collage', rows: 2, columns: 2, gap: 2, padding: 1, outputWidth: 24, outputHeight: 24, fit: 'contain', background: '#ffffff80' }
    const [frame] = buildImageTransformFrames([{ width: 10, height: 10 }, { width: 10, height: 20 }, { width: 20, height: 10 }], recipe)
    expect(frame.background).toBe('#ffffff80')
    expect(frame.draws.map((value) => value.sourceIndex)).toEqual([0, 1, 2])
    expect(frame.draws[0].destination).toEqual({ x: 1, y: 1, width: 10, height: 10 })
    expect(frame.draws[1].destination).toEqual({ x: 15.5, y: 1, width: 5, height: 10 })
    expect(() => buildImageTransformFrames(Array.from({ length: 5 }, () => ({ width: 1, height: 1 })), recipe)).toThrow('不会自动丢弃')
  })

  it('mirrors repeated tiles horizontally by column and vertically by row', () => {
    const [frame] = buildImageTransformFrames([{ width: 10, height: 10 }], { kind: 'tile', rows: 2, columns: 3, gap: 0, outputWidth: 30, outputHeight: 20, fit: 'cover', background: 'transparent', mirrorAlternate: true })
    expect(frame.draws.map((value) => [value.flipX, value.flipY])).toEqual([[false, false], [true, false], [false, false], [false, true], [true, true], [false, true]])
  })

  it('keeps layer order, off-canvas position, opacity and blend while skipping hidden layers', () => {
    const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 100, outputHeight: 200, background: 'transparent', layers: [
      { sourceIndex: 1, x: -0.1, y: 0.2, width: 0.5, height: 0.4, rotation: 45, opacity: 0.5, blend: 'multiply', visible: true },
      { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'screen', visible: false },
      { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true },
    ] }
    const draws = buildImageTransformFrames([{ width: 10, height: 10 }, { width: 20, height: 30 }], recipe)[0].draws
    expect(draws.map((value) => value.sourceIndex)).toEqual([1, 0])
    expect(draws[0]).toMatchObject({ destination: { x: -10, y: 40, width: 50, height: 80 }, opacity: 0.5, rotation: 45, blend: 'multiply' })
    expect(() => buildImageTransformFrames([{ width: 10, height: 10 }], recipe)).toThrow('不存在')
  })

  it('defaults to one full-canvas layer per input without reversing stacking order', () => {
    expect(buildImageTransformFrames([{ width: 10, height: 20 }, { width: 30, height: 40 }], defaultImageTransformRecipe('layer'))[0].draws.map((value) => value.sourceIndex)).toEqual([0, 1])
  })

  it('plans content without source pixels while retaining flips and adjustments in stacking order', () => {
    const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 200, outputHeight: 100, background: 'transparent', layers: [{ sourceIndex: 19, x: 0.25, y: 0.1, width: 0.5, height: 0.4, rotation: 20, flipX: true, flipY: true, opacity: 0.5, blend: 'screen', visible: true, locked: true, adjustments: { brightness: 1, contrast: 2, saturation: 1, blur: 2, grayscale: 0.5 }, content: { kind: 'shape', shape: 'ellipse', fill: '#ff0000', stroke: 'transparent', strokeWidth: 0 } }] }
    const [frame] = buildImageTransformFrames([], recipe)
    expect(frame.draws).toHaveLength(1)
    expect(frame.draws[0]).toMatchObject({ sourceIndex: 19, destination: { x: 50, y: 10, width: 100, height: 40 }, flipX: true, flipY: true, rotation: 20, opacity: 0.5, blend: 'screen', adjustments: recipe.layers[0].adjustments, content: recipe.layers[0].content })
    expect(frame.draws[0]).not.toHaveProperty('locked')
    expect(() => buildImageTransformFrames([], { ...recipe, layers: [{ ...recipe.layers[0], content: undefined, visible: false }] })).toThrow()
  })

  it('distinguishes an explicit empty canvas from the legacy automatic input stack', () => {
    const defaults = defaultImageTransformRecipe('layer') as ImageLayerRecipe
    expect(() => buildImageTransformFrames([], defaults)).toThrow()
    expect(buildImageTransformFrames([], { ...defaults, explicitLayers: true })[0].draws).toEqual([])
    expect(buildImageTransformFrames([{ width: 1, height: 1 }], { ...defaults, explicitLayers: true })[0].draws).toEqual([])
    expect(buildImageTransformFrames(Array.from({ length: 20 }, () => ({ width: 1, height: 1 })), defaults)[0].draws).toHaveLength(20)
    expect(() => buildImageTransformFrames(Array.from({ length: 21 }, () => ({ width: 1, height: 1 })), defaults)).toThrow()
  })

  it('bounds input pixels and individual output dimensions before rendering', () => {
    expect(() => buildImageTransformFrames([{ width: 8192, height: 8192 }], defaultImageTransformRecipe('crop'))).toThrow('总像素')
    expect(() => buildImageTransformFrames([{ width: 8192, height: 4096 }], { kind: 'grid-split', rows: 1, columns: 1, gap: 0, padding: 0 })).toThrow('4096')
    expect(() => buildImageTransformFrames([{ width: 1, height: 1 }, { width: 1, height: 1 }], defaultImageTransformRecipe('tile'))).toThrow('一张')
  })
})


describe('grouped native frame geometry', () => {
  it('keeps pass through frames and own flags unchanged while respecting nested visibility', () => {
    const leaf: ImageLayer = { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 0.5, blend: 'multiply', visible: true, content: { kind: 'shape', shape: 'rectangle', fill: '#ff0000', stroke: 'transparent', strokeWidth: 0 } }
    const flat: ImageLayerRecipe = { kind: 'layer', explicitLayers: true, outputWidth: 100, outputHeight: 100, background: 'transparent', layers: [leaf, { ...leaf, blend: 'screen' }, { ...leaf, visible: false }] }
    const grouped: ImageLayerRecipe = { ...flat, layerGroups: { version: 1, layerIds: ['a', 'b', 'c'], groups: [{ id: 'inner', name: 'Inner', children: ['a', 'b'], visible: true, locked: true }, { id: 'outer', name: 'Outer', children: ['inner'], visible: true, locked: false }] } }
    const before = structuredClone(grouped)
    expect(buildImageTransformFrames([], grouped)).toEqual(buildImageTransformFrames([], flat))
    expect(grouped).toEqual(before)
    const hidden = structuredClone(grouped); hidden.layerGroups!.groups[1].visible = false
    expect(buildImageTransformFrames([], hidden)[0].draws).toHaveLength(0)
    expect(hidden.layers.map((layer) => layer.visible)).toEqual([true, true, false])
  })
})
