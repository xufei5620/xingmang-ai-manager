import { describe, expect, it } from 'vitest'
import { imageCollageCapacity, imageCollageInputCountError, imageCollageUsesAutoSize } from './recipe'
import { defaultImageTransformRecipe, imageLayerEditUsage, imageTransformKindForNode, imageTransformProcessorRevision, imageTransformRecipeForNode, imageTransformRecipeNeedsSources, parseImageLayerRaster, parseImageLayerSelection, parseImageTransformRecipe, type ImageLayerGradient, type ImageLayerPathContent, type ImageLayerRecipe, type ImageLayerStroke, type ImageTransformKind } from './recipe'

function stroke(): ImageLayerStroke {
  return { mode: 'paint', points: [[-100, 5000], [8000, 5000]], size: 30, hardness: 1, opacity: 0.8, color: '#ff0000', space: { width: 640, height: 480 }, selection: { kind: 'ellipse', transform: [1, 0, 0, 1, 0, 0], inverted: true } }
}

function layerRecipe(): ImageLayerRecipe {
  return { kind: 'layer', outputWidth: 640, outputHeight: 480, background: '#AABBCC80', layers: [
    { sourceIndex: 2, x: -0.25, y: 0.1, width: 1.5, height: 0.75, rotation: 90, opacity: 0.4, blend: 'multiply', visible: true },
    { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: -20, opacity: 1, blend: 'source-over', visible: false },
  ] }
}

describe('image transform recipe contract', () => {
  it('preserves legacy collage bytes and roundtrips additive layouts, false flags and zero style values', () => {
    const legacy = defaultImageTransformRecipe('collage')
    expect(JSON.stringify(parseImageTransformRecipe(legacy))).toBe('{"kind":"collage","rows":2,"columns":2,"gap":16,"outputWidth":1024,"outputHeight":1024,"fit":"cover","background":"#ffffff","padding":16}')
    const value = { ...legacy, layout: 'horizontal', autoSize: true, cornerRadius: 24.5, borderWidth: 4, borderColor: '#FFCC0080', shadow: true, watermark: { text: '原创 · 星芒', color: '#FFFFFF', opacity: 0.25, fontSize: 24 } }
    const parsed = parseImageTransformRecipe(value)
    expect(parsed).toEqual({ ...value, borderColor: '#ffcc0080', watermark: { ...value.watermark, color: '#ffffff' } })
    value.watermark.text = 'changed'
    expect(parsed).toMatchObject({ watermark: { text: '原创 · 星芒' } })
    expect(parseImageTransformRecipe(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
    expect(parseImageTransformRecipe({ ...legacy, layout: 'grid', autoSize: false, cornerRadius: 0, borderWidth: 0, shadow: false, watermark: { text: '', color: 'transparent', opacity: 0, fontSize: 10 } })).toMatchObject({ autoSize: false, cornerRadius: 0, borderWidth: 0, shadow: false, watermark: { opacity: 0 } })
  })

  it('rejects arbitrary collage effects, malformed watermark prose and automatic dimensions on unsupported layouts', () => {
    const base = defaultImageTransformRecipe('collage')
    for (const patch of [{ layout: 'unknown' }, { layout: 2 }, { autoSize: true }, { layout: 'hero-left', autoSize: true }, { autoSize: 1 }, { cornerRadius: 257 }, { cornerRadius: NaN }, { borderWidth: -1 }, { borderWidth: 65 }, { borderColor: 'url(private)' }, { shadow: 'true' }, { inputOrder: [0] }]) expect(() => parseImageTransformRecipe({ ...base, ...patch })).toThrow()
    const watermark = { text: '产品图', color: '#ffffff', opacity: 0.5, fontSize: 24 }
    for (const patch of [{ text: '字'.repeat(161) }, { text: 'bad\0text' }, { color: 'rgb(1,2,3)' }, { opacity: Infinity }, { opacity: 1.1 }, { fontSize: 9 }, { fontSize: 129 }, { fontFamily: 'url(private)' }, { sourceUrl: 'https://private.test' }]) expect(() => parseImageTransformRecipe({ ...base, watermark: { ...watermark, ...patch } })).toThrow()
    expect(() => parseImageTransformRecipe({ ...defaultImageTransformRecipe('tile'), cornerRadius: 1 })).toThrow('不支持')
  })

  it('uses layout-specific capacity while leaving actual automatic geometry to normalized source dimensions', () => {
    const base = defaultImageTransformRecipe('collage')
    if (base.kind !== 'collage') throw new Error('bad fixture')
    for (const layout of ['horizontal', 'vertical'] as const) {
      const recipe = { ...base, layout, autoSize: true, outputWidth: 1, outputHeight: 1, padding: 100 }
      expect(parseImageTransformRecipe(recipe)).toEqual(recipe)
      expect(imageCollageCapacity(recipe)).toBe(20)
      expect(imageCollageInputCountError(recipe, 20)).toBeNull()
      expect(imageCollageInputCountError(recipe, 21)).toContain('20')
      expect(imageCollageUsesAutoSize(recipe)).toBe(true)
    }
    for (const layout of ['hero-left', 'hero-top'] as const) {
      const recipe = { ...base, layout }
      expect(imageCollageCapacity(recipe)).toBe(3)
      expect(imageCollageInputCountError(recipe, 1)).toContain('2–3')
      expect(imageCollageInputCountError(recipe, 1, false)).toBeNull()
      expect(imageCollageInputCountError(recipe, 2)).toBeNull()
      expect(imageCollageInputCountError(recipe, 3)).toBeNull()
      expect(imageCollageInputCountError(recipe, 4, false)).toContain('2–3')
    }
    expect(imageCollageCapacity(base)).toBe(4)
    expect(imageCollageInputCountError(base, 9)).toContain('9 张输入需至少 9 格')
    expect(imageCollageUsesAutoSize(base)).toBe(false)
  })

  it('roundtrips bounded gradients and cubic paths without aliases or injecting handles into polygons', () => {
    const base = layerRecipe(), gradient: ImageLayerGradient = { mode: 'gradient', from: [-100, 0], to: [10000, 9000], startColor: '#FF000080', endColor: '#00FF0000', opacity: 0.4, space: { width: 640, height: 480 }, selection: stroke().selection }
    const content: ImageLayerPathContent = { kind: 'path', points: [[0, 0], [5000, 10000], [10000, 0]], handles: [{ out: [2000, 7000] }, { in: [3000, 5000], out: [7000, 5000] }, { in: [8000, 7000] }], fill: '#AABBCC80', stroke: '#FFFFFF', strokeWidth: 2, space: { width: 640, height: 480 } }
    const parsed = parseImageTransformRecipe({ ...base, layers: [{ ...base.layers[0], content, edits: { version: 1, operations: [gradient] } }] }) as ImageLayerRecipe
    expect(parsed.layers[0].content).toMatchObject({ kind: 'path', fill: '#aabbcc80', stroke: '#ffffff', handles: content.handles })
    expect(parsed.layers[0].edits?.operations[0]).toMatchObject({ mode: 'gradient', startColor: '#ff000080', endColor: '#00ff0000' })
    expect(imageLayerEditUsage(parsed.layers)).toMatchObject({ points: 9, operations: 2 })
    expect(parseImageTransformRecipe(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
    content.points[0][0] = 123; content.handles![0].out![0] = 123; gradient.from[0] = 456
    expect(parsed.layers[0].content).toMatchObject({ points: [[0, 0], [5000, 10000], [10000, 0]] })
    expect((parsed.layers[0].content as ImageLayerPathContent).handles?.[0].out).toEqual([2000, 7000])
    const { handles: _handles, ...polygon } = content
    expect((parseImageTransformRecipe({ ...base, layers: [{ ...base.layers[0], content: polygon }] }) as ImageLayerRecipe).layers[0].content).not.toHaveProperty('handles')
  })

  it('rejects degenerate gradients, arbitrary CSS and unbounded cubic control structures', () => {
    const base = layerRecipe(), gradient = { mode: 'gradient', from: [0, 0], to: [10000, 0], startColor: '#ff0000', endColor: '#0000ff00', opacity: 1, space: { width: 640, height: 480 } }
    for (const patch of [{ to: [0, 0] }, { from: [NaN, 0] }, { from: [0.1, 0] }, { to: [30001, 0] }, { startColor: 'url(secret)' }, { endColor: 'transparent' }, { opacity: 2 }, { space: { width: 0, height: 10 } }, { script: 'alert(1)' }]) expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...base.layers[0], edits: { version: 1, operations: [{ ...gradient, ...patch }] } }] })).toThrow()
    const path = { kind: 'path', points: [[0, 0], [10000, 0], [5000, 10000]], fill: '#ffffff', stroke: '#000000', strokeWidth: 2, space: { width: 640, height: 480 } }
    for (const patch of [{ points: [[0, 0], [1, 1]] }, { points: [[0, 0], [1, 1], [2, 2]] }, { points: [[0, 0], [10001, 0], [1, 2]] }, { points: [[0, 0], [0, 0], [1, 2]] }, { handles: [{}] }, { handles: [{ out: [-1, 0] }, {}, {}] }, { handles: [{ out: [1, 1], url: 'private' }, {}, {}] }, { space: { width: 0.001, height: 0.001 } }, { strokeWidth: 65 }, { fill: 'url(private)' }]) expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...base.layers[0], content: { ...path, ...patch } }] })).toThrow()
  })

  it('counts path anchors, handles, gradient endpoints and path bytes in the unchanged aggregate budgets', () => {
    const base = layerRecipe(), points: Array<[number, number]> = Array.from({ length: 1024 }, (_, index) => [index * 9, index % 2 * 10000])
    const content: ImageLayerPathContent = { kind: 'path', points, fill: '#ffffff', stroke: 'transparent', strokeWidth: 0, space: { width: 640, height: 480 } }
    const layers = Array.from({ length: 4 }, () => ({ ...base.layers[0], content }))
    expect(() => parseImageTransformRecipe({ ...base, layers })).not.toThrow()
    expect(imageLayerEditUsage(layers)).toMatchObject({ points: 4096, operations: 4 })
    expect(() => parseImageTransformRecipe({ ...base, layers: [...layers, { ...base.layers[0], edits: { version: 1, operations: [{ mode: 'gradient', from: [0, 0], to: [1, 1], startColor: '#ffffff', endColor: '#000000', opacity: 1, space: { width: 640, height: 480 } }] } }] })).toThrow('4096')
    expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...layers[0], content: { ...content, points: [...points, [9000, 1000]] } }] })).toThrow('1024')
    const mask = { kind: 'raster', transform: [1, 0, 0, 1, 0, 0], inverted: false, raster: { width: 4096, height: 4096, runs: Array.from({ length: 4096 }, (_, row) => [row * 4096, 4096]).flat() } }
    expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...layers[0], mask }] })).toThrow('64 KB')
    const curved = { ...content, handles: points.map(() => ({ in: [1000, 2000], out: [3000, 4000] })) }
    expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...layers[0], content: curved }, { ...layers[0], content: curved }] })).toThrow('4096')
  })
  it('roundtrips native raster selections and ordered outlines without aliasing or adding fields to legacy selections', () => {
    const selection = { kind: 'raster' as const, transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number], inverted: false, raster: { width: 4, height: 2, runs: [0, 2, 4, 4] } }
    const outline = { mode: 'outline' as const, color: '#FF00AA80', opacity: 0.5, width: 2, position: 'center' as const, space: { width: 960, height: 360 }, selection }
    const base = layerRecipe(), recipe = { ...base, layers: [{ ...base.layers[0], mask: selection, edits: { version: 1, operations: [outline, { mode: 'fill', color: '#ffffff', opacity: 1, selection }, stroke()] } }] }
    const parsed = parseImageTransformRecipe(recipe)
    if (parsed.kind !== 'layer') throw new Error('expected layers')
    expect(parsed.layers[0].edits?.operations[0]).toEqual({ ...outline, color: '#ff00aa80' })
    expect(imageLayerEditUsage(parsed.layers)).toMatchObject({ operations: 3, points: 2 })
    selection.raster.runs[0] = 1
    expect(parsed.layers[0].mask).toMatchObject({ raster: { runs: [0, 2, 4, 4] } })
    const legacy = { kind: 'rectangle', transform: [1, 0, 0, 1, 0, 0], inverted: true }
    expect(JSON.stringify(parseImageLayerSelection(legacy))).toBe(JSON.stringify(legacy))
  })

  it('rejects noncanonical or unsafe row runs rather than silently clipping or downsampling selections', () => {
    for (const runs of [[0], [0, 0], [0, -1], [3, 2], [7, 2], [1, 2, 2, 1], [4, 1, 0, 1], [0, 1, 1, 1], [NaN, 1], [0.5, 1], [8, 1]]) expect(() => parseImageLayerRaster({ width: 4, height: 2, runs })).toThrow()
    for (const change of [{ width: 4097 }, { height: Infinity }, { runs: Array.from({ length: 8193 }, (_, index) => [index * 2, 1]).flat() }, { url: 'private' }]) expect(() => parseImageLayerRaster({ width: 4096, height: 8, runs: [], ...change })).toThrow()
    expect(parseImageLayerRaster({ width: 4, height: 2, runs: [0, 4, 4, 4] })).toEqual({ width: 4, height: 2, runs: [0, 4, 4, 4] })
    for (const inverted of [false, true]) expect(parseImageLayerSelection({ kind: 'raster', transform: [1, 0, 0, 1, 0, 0], inverted, raster: { width: 4096, height: 4096, runs: [] } })).toMatchObject({ inverted, raster: { runs: [] } })
  })

  it('retains a full native 4096 square selection while counting repeated raster payloads against the aggregate byte budget', () => {
    const base = layerRecipe(), mask = { kind: 'raster' as const, transform: [1, 0, 0, 1, 0, 0], inverted: false, raster: { width: 4096, height: 4096, runs: Array.from({ length: 4096 }, (_, row) => [row * 4096, 4096]).flat() } }
    expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...base.layers[0], mask }] })).not.toThrow()
    expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...base.layers[0], mask, edits: { version: 1, operations: [{ mode: 'fill', color: '#ffffff', opacity: 1, selection: mask }] } }] })).toThrow('64 KB')
  })

  it('rejects unsafe outline geometry, colors and inherited scaling before any pixel allocation', () => {
    const base = layerRecipe(), outline = { mode: 'outline', color: '#ffffff', opacity: 1, width: 2, position: 'center', space: { width: 960, height: 360 }, selection: { kind: 'rectangle', transform: [1, 0, 0, 1, 0, 0], inverted: false } }
    for (const change of [{ width: 0 }, { width: 65 }, { width: NaN }, { opacity: 2 }, { position: 'arbitrary' }, { color: 'transparent' }, { color: 'url(private)' }, { points: [] }, { selection: undefined }, { space: { width: 0.001, height: 0.001 } }]) expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...base.layers[0], edits: { version: 1, operations: [{ ...outline, ...change }] } }] })).toThrow()
  })
  it('keeps additive feather snapshots and fills ordered without manufacturing defaults on old recipes', () => {
    const base = layerRecipe(), selection = { kind: 'rectangle' as const, transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number], inverted: false, feather: { radius: 5, space: { width: 960, height: 360 } } }
    const value = { ...base, layers: [{ ...base.layers[0], content: { kind: 'paint' }, edits: { version: 1, operations: [{ mode: 'fill', color: '#AABBCC80', opacity: 0.3, selection }, stroke()] }, mask: selection }] }
    const parsed = parseImageTransformRecipe(value)
    if (parsed.kind !== 'layer') throw new Error('expected layers')
    expect(parsed.layers[0].edits?.operations.map((operation) => operation.mode)).toEqual(['fill', 'paint'])
    expect(parsed.layers[0].edits?.operations[0]).toEqual({ mode: 'fill', color: '#aabbcc80', opacity: 0.3, selection })
    expect(imageLayerEditUsage(parsed.layers)).toMatchObject({ points: 2, operations: 2 })
    selection.feather.radius = 12
    expect(parsed.layers[0].mask?.feather?.radius).toBe(5)
    const zero = parseImageTransformRecipe({ ...base, layers: [{ ...base.layers[0], mask: { ...selection, feather: { ...selection.feather, radius: 0 } } }] })
    if (zero.kind !== 'layer') throw new Error('expected layers')
    expect(zero.layers[0].mask).not.toHaveProperty('feather')
  })

  it('bounds feather scaling and fill payloads before allocating a raster surface', () => {
    const base = layerRecipe(), selection = { kind: 'ellipse', transform: [1, 0, 0, 1, 0, 0], inverted: true }
    for (const feather of [{ radius: -1, space: { width: 10, height: 10 } }, { radius: 129, space: { width: 10, height: 10 } }, { radius: 5, space: { width: 0.001, height: 0.001 } }, { radius: NaN, space: { width: 640, height: 480 } }, { radius: 5, space: { width: 640, height: 480 }, url: 'private' }]) {
      expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...base.layers[0], mask: { ...selection, feather } }] })).toThrow()
    }
    for (const fill of [{ mode: 'fill', color: 'transparent', opacity: 1 }, { mode: 'fill', color: 'url(private)', opacity: 1 }, { mode: 'fill', color: '#ffffff', opacity: 2 }, { mode: 'fill', color: '#ffffff', opacity: 1, points: [[0, 0]] }, { mode: 'fill', color: '#ffffff', opacity: 1, tolerance: 32 }]) {
      expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...base.layers[0], edits: { version: 1, operations: [fill] } }] })).toThrow()
    }
    expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...base.layers[0], edits: { version: 1, operations: Array.from({ length: 257 }, () => ({ mode: 'fill', color: '#ffffff', opacity: 1 })) } }] })).toThrow('256')
  })

  it('roundtrips transparent paint layers, ordered erase and independent selection masks without aliasing', () => {
    const value: ImageLayerRecipe = { ...layerRecipe(), layers: [{ ...layerRecipe().layers[0], content: { kind: 'paint' }, edits: { version: 1, operations: [stroke(), { ...stroke(), mode: 'erase' }, stroke()] }, mask: { kind: 'rectangle', transform: [0.5, 0.2, -0.1, 0.5, 0.1, 0.1], inverted: false } }] }
    const result = parseImageTransformRecipe(value)
    expect(imageTransformRecipeNeedsSources(result)).toBe(false)
    expect(result).toEqual({ ...value, background: '#aabbcc80' })
    if (result.kind !== 'layer') throw new Error('expected layers')
    const inputStroke = value.layers[0].edits!.operations[0], copiedStroke = result.layers[0].edits!.operations[0]
    if (!('points' in inputStroke) || !('points' in copiedStroke)) throw new Error('expected stroke')
    inputStroke.points[0][0] = 999
    value.layers[0].mask!.transform[0] = 0.75
    expect(copiedStroke.points[0][0]).toBe(-100)
    expect(result.layers[0].mask!.transform[0]).toBe(0.5)
  })

  it('rejects unsafe stroke fields, unbounded geometry, singular masks and remote content', () => {
    const base = layerRecipe(), layer = base.layers[0]
    for (const change of [{ mode: 'fetch' }, { points: [] }, { points: [[NaN, 0]] }, { points: [[0.5, 0]] }, { points: [[30001, 0]] }, { points: [[0, 1, 2]] }, { size: 513 }, { hardness: -0.1 }, { opacity: Infinity }, { color: 'url(private)' }, { color: 'transparent' }, { space: { width: 0, height: 10 } }, { space: { width: 16385, height: 1 } }, { assetId: 'private' }]) expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...layer, edits: { version: 1, operations: [{ ...stroke(), ...change }] } }] })).toThrow()
    for (const transform of [[1, 1, 1, 1, 0, 0], [1, 0, 0, 1e-14, 0, 0], [Infinity, 0, 0, 1, 0, 0], [1, 0, 0, 1, 8193, 0], [1, 0, 0, 1, 0]]) expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...layer, mask: { kind: 'rectangle', transform, inverted: false } }] })).toThrow()
    expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...layer, content: { kind: 'paint', url: 'private' } }] })).toThrow('不支持的字段')
    expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...layer, edits: { version: 2, operations: [] } }] })).toThrow()
    expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...layer, edits: { version: 1, operations: [{ ...stroke(), hardness: 0, space: { width: 0.001, height: 0.001 } }] } }] })).toThrow('缩放过大')
  })

  it('bounds total operations, points and UTF8 edit bytes across all layers', () => {
    const base = layerRecipe(), layer = base.layers[0]
    const operations = Array.from({ length: 129 }, () => ({ ...stroke(), points: [[0, 0]] as Array<[number, number]>, selection: undefined }))
    expect(() => parseImageTransformRecipe({ ...base, layers: Array.from({ length: 2 }, () => ({ ...layer, edits: { version: 1, operations } })) })).toThrow('256 笔')
    const points = Array.from({ length: 2049 }, (): [number, number] => [0, 0])
    expect(() => parseImageTransformRecipe({ ...base, layers: Array.from({ length: 2 }, () => ({ ...layer, edits: { version: 1, operations: [{ ...stroke(), points }] } })) })).toThrow('4096')
    const large = { ...layer, edits: { version: 1 as const, operations: Array.from({ length: 256 }, () => ({ ...stroke(), points: Array.from({ length: 8 }, (): [number, number] => [-20000, 30000]) })) } }
    expect(imageLayerEditUsage([large]).bytes).toBeGreaterThan(64 * 1024)
    expect(() => parseImageTransformRecipe({ ...base, layers: [large] })).toThrow('64 KB')
  })
  it.each(['crop', 'collage', 'grid-split', 'tile', 'layer'] as const)('roundtrips the %s defaults and resolves only its own node type', (kind) => {
    const defaults = defaultImageTransformRecipe(kind)
    expect(parseImageTransformRecipe(JSON.parse(JSON.stringify(defaults)))).toEqual(defaults)
    expect(imageTransformRecipeForNode(`image-${kind}`)).toEqual(defaults)
    expect(imageTransformKindForNode(`image-${kind}`)).toBe(kind)
  })

  it('deep copies ordered layer arrays without dropping transform, opacity or visibility', () => {
    const input = layerRecipe()
    const result = parseImageTransformRecipe(input)
    expect(result).toEqual({ ...input, background: '#aabbcc80' })
    expect(result.kind).toBe('layer')
    if (result.kind !== 'layer') throw new Error('expected layer recipe')
    expect(result.layers).not.toBe(input.layers)
    expect(result.layers[0]).not.toBe(input.layers[0])
    input.layers.reverse()
    input.layers[0].opacity = 0
    expect(result.layers.map((layer) => [layer.sourceIndex, layer.opacity])).toEqual([[2, 0.4], [0, 1]])
  })

  it('rejects an otherwise valid recipe assigned to a different tool node', () => {
    expect(() => imageTransformRecipeForNode('image-crop', { imageTransform: defaultImageTransformRecipe('tile') })).toThrow('节点类型不匹配')
    expect(imageTransformRecipeForNode('image-panorama', { imageTransform: layerRecipe() })).toBeNull()
    expect(imageTransformKindForNode('image-compare')).toBeNull()
  })

  it.each(['apiKey', 'authorization', 'endpoint', 'unknownCapability'])('rejects unrecognized root field %s rather than persisting it', (key) => {
    expect(() => parseImageTransformRecipe({ ...layerRecipe(), [key]: 'private-value' })).toThrow('不支持的字段')
  })

  it.each(['accessToken', 'localUrl', 'assetId', 'unknownCapability'])('rejects unrecognized layer field %s', (key) => {
    const input = layerRecipe()
    expect(() => parseImageTransformRecipe({ ...input, layers: [{ ...input.layers[0], [key]: 'private-value' }] })).toThrow('不支持的字段')
  })

  it.each([0, -1, 4097, Infinity, NaN, 1.5])('rejects invalid output edge %s', (outputWidth) => {
    expect(() => parseImageTransformRecipe({ ...layerRecipe(), outputWidth })).toThrow('输出宽度')
  })

  it('rejects bad layer indices, capacities, transforms and blends', () => {
    const base = layerRecipe()
    for (const change of [{ sourceIndex: -1 }, { sourceIndex: 20 }, { sourceIndex: 0.5 }, { x: NaN }, { width: 0 }, { rotation: 361 }, { opacity: 1.1 }, { visible: 'true' }, { blend: 'destination-out' }]) {
      expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...base.layers[0], ...change }] })).toThrow()
    }
    expect(() => parseImageTransformRecipe({ ...base, layers: Array.from({ length: 21 }, () => base.layers[0]) })).toThrow('20')
  })

  it('retains the exact old canonical recipe and processor revision for pending receipt recovery', () => {
    const old = { kind: 'layer', outputWidth: 640, outputHeight: 480, background: 'transparent', layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true }] }
    expect(JSON.stringify(parseImageTransformRecipe(old))).toBe(JSON.stringify(old))
    expect(imageTransformProcessorRevision).toBe('browser-image-v1')
    expect(parseImageTransformRecipe(old)).not.toHaveProperty('explicitLayers')
  })

  it('deep copies twenty named locked and adjusted content layers without coercing their flags', () => {
    const content = { kind: 'text' as const, text: '第一行\nsecond line', color: '#AABBCC80', fontSize: 32, fontFamily: 'serif' as const, fontWeight: 700 as const, align: 'center' as const }
    const adjustments = { brightness: 2, contrast: 0, saturation: 0.5, blur: 32, grayscale: 1 }
    const value = { ...layerRecipe(), explicitLayers: true, layers: Array.from({ length: 20 }, (_, sourceIndex) => ({ ...layerRecipe().layers[0], sourceIndex, name: '图层'.repeat(40), locked: true, flipX: false, flipY: true, adjustments, content })) }
    const result = parseImageTransformRecipe(value)
    expect(result).toMatchObject({ explicitLayers: true, layers: Array.from({ length: 20 }, (_, sourceIndex) => ({ sourceIndex, name: '图层'.repeat(40), locked: true, flipX: false, flipY: true, adjustments, content: { ...content, color: '#aabbcc80' } })) })
    if (result.kind !== 'layer') throw new Error('expected layer recipe')
    expect(result.layers[0].content).not.toBe(content)
    expect(result.layers[0].adjustments).not.toBe(adjustments)
  })

  it('only permits source-free text, shapes or an explicitly empty layer stack', () => {
    const shape = { ...layerRecipe().layers[0], sourceIndex: 19, content: { kind: 'shape' as const, shape: 'ellipse' as const, fill: 'transparent', stroke: '#ff0000', strokeWidth: 64 } }
    expect(imageTransformRecipeNeedsSources(parseImageTransformRecipe({ ...layerRecipe(), layers: [shape] }))).toBe(false)
    expect(imageTransformRecipeNeedsSources(parseImageTransformRecipe({ ...layerRecipe(), layers: [], explicitLayers: true }))).toBe(false)
    expect(imageTransformRecipeNeedsSources(parseImageTransformRecipe({ ...layerRecipe(), layers: [], explicitLayers: false }))).toBe(true)
    expect(imageTransformRecipeNeedsSources(defaultImageTransformRecipe('layer'))).toBe(true)
    expect(imageTransformRecipeNeedsSources({ ...layerRecipe(), layers: [shape, { ...layerRecipe().layers[0], visible: false }] })).toBe(true)
    expect(() => parseImageTransformRecipe({ ...layerRecipe(), explicitLayers: 'true' })).toThrow()
  })

  it('rejects style injection, excessive text and unsupported content fields', () => {
    const base = layerRecipe(), layer = base.layers[0]
    const content = { kind: 'text', text: 'a'.repeat(2000), color: '#abcdef', fontSize: 512, fontFamily: 'sans-serif', fontWeight: 400, align: 'left' }
    expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...layer, content }] })).not.toThrow()
    for (const change of [{ text: 'a'.repeat(2001) }, { text: 'private\u0000value' }, { color: 'url(https://private.invalid)' }, { color: 'transparent' }, { fontSize: 0 }, { fontSize: 513 }, { fontFamily: 'url(private)' }, { fontWeight: 500 }, { align: 'start' }, { url: 'private' }]) expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...layer, content: { ...content, ...change } }] })).toThrow()
    for (const change of [{ name: 'n'.repeat(81) }, { locked: 1 }, { flipX: 'yes' }, { content: { kind: 'image', url: 'private' } }]) expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...layer, ...change }] })).toThrow()
    const shape = { kind: 'shape', shape: 'rectangle', fill: 'transparent', stroke: '#ffffffff', strokeWidth: 0 }
    for (const change of [{ shape: 'path' }, { fill: 'var(--color)' }, { strokeWidth: -1 }, { strokeWidth: 65 }, { path: 'M0 0' }]) expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...layer, content: { ...shape, ...change } }] })).toThrow()
  })

  it('bounds each adjustment and rejects arbitrary filter syntax', () => {
    const base = layerRecipe(), layer = base.layers[0], adjustments = { brightness: 1, contrast: 1, saturation: 1, blur: 0, grayscale: 0 }
    for (const change of [{ brightness: -1 }, { contrast: 2.01 }, { saturation: Infinity }, { blur: 32.01 }, { grayscale: 1.1 }, { brightness: '1' }, { filter: 'url(private)' }]) expect(() => parseImageTransformRecipe({ ...base, layers: [{ ...layer, adjustments: { ...adjustments, ...change } }] })).toThrow()
  })

  it('bounds crop rectangles and rotation while accepting zero origins and supported flips', () => {
    const base = defaultImageTransformRecipe('crop')
    expect(() => parseImageTransformRecipe({ ...base, x: 0.5 })).toThrow('超出图片边界')
    expect(() => parseImageTransformRecipe({ ...base, rotation: 45 })).toThrow('90°')
    expect(parseImageTransformRecipe({ ...base, x: -0, rotation: 270, flipX: true, flipY: true })).toMatchObject({ x: 0, rotation: 270, flipX: true, flipY: true })
  })

  it.each(['collage', 'tile'] as ImageTransformKind[])('rejects %s layouts whose padding and gaps consume the output', (kind) => {
    const recipe = defaultImageTransformRecipe(kind)
    expect(() => parseImageTransformRecipe({ ...recipe, outputWidth: 10, outputHeight: 10, gap: 512 })).toThrow('没有可用空间')
    expect(() => parseImageTransformRecipe({ ...recipe, rows: 1.5 })).toThrow('整数')
  })

  it('restricts backgrounds and rejects URLs, expressions and missing recipes', () => {
    for (const background of ['url(https://private.invalid/image)', 'red', '#fff', 'rgba(0,0,0,0)']) expect(() => parseImageTransformRecipe({ ...layerRecipe(), background })).toThrow('背景色')
    for (const invalid of [null, [], {}, { kind: 'fetch-image' }]) expect(() => parseImageTransformRecipe(invalid)).toThrow()
  })
})
