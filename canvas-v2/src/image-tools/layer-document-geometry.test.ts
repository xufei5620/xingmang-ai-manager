import { describe, expect, it } from 'vitest'
import { buildLayerDocumentReplayRecipe, imageLayerGeometryBounds, parseImageLayerDocumentFrame, resizeLayerDocumentFrame, resolveLayerDocumentFrame } from './layer-document-geometry'
import { defaultEditorImageLayer } from './layer-editor-state'
import { parseImageTransformRecipe, type ImageLayerRecipe } from './recipe'

function recipe(): ImageLayerRecipe { return { kind: 'layer', outputWidth: 640, outputHeight: 480, background: 'transparent', explicitLayers: true, layers: [defaultEditorImageLayer(0)] } }

describe('layer document geometry', () => {
  it('keeps legacy recipe serialization and the absent-frame replay path unchanged', () => {
    const value = recipe()
    const legacyCanonical = { kind: 'layer', outputWidth: 640, outputHeight: 480, background: 'transparent', layers: [defaultEditorImageLayer(0)], explicitLayers: true }
    expect(JSON.stringify(parseImageTransformRecipe(value))).toBe(JSON.stringify(legacyCanonical))
    expect(buildLayerDocumentReplayRecipe(value)).toBe(value)
    expect(resolveLayerDocumentFrame(value)).toEqual({ version: 1, width: 640, height: 480, offsetX: 0, offsetY: 0 })
  })

  it('validates a versioned integer frame containing the whole visible document', () => {
    const output = { width: 400, height: 280 }, frame = { version: 1, width: 640, height: 480, offsetX: 120, offsetY: 100 }
    expect(parseImageLayerDocumentFrame(frame, output)).toEqual(frame)
    for (const invalid of [null, {}, { ...frame, version: 2 }, { ...frame, secret: 'x' }, { ...frame, width: 4097 }, { ...frame, height: 0 }, { ...frame, offsetX: .5 }, { ...frame, offsetY: -1 }, { ...frame, offsetX: 241 }, { ...frame, offsetY: 201 }, { ...frame, offsetX: Infinity }]) expect(() => parseImageLayerDocumentFrame(invalid, output)).toThrow()
    expect(() => parseImageTransformRecipe({ ...recipe(), documentFrame: frame })).toThrow(/包含/)
    expect(() => parseImageTransformRecipe({ ...recipe(), outputWidth: 400, outputHeight: 280, explicitLayers: undefined, documentFrame: frame })).toThrow(/明确/)
  })

  it('bounds physical geometry in the retained frame rather than the crop ratio', () => {
    const bounds = imageLayerGeometryBounds(1, 4095)
    expect(bounds).toEqual({ minPosition: -12287, maxPosition: 4097, minSize: .001, maxSize: 16384 })
    for (const axis of [1, 3, 640, 4096]) {
      const b = imageLayerGeometryBounds(axis)
      expect(b.minPosition * axis).toBe(-8192); expect(b.maxPosition * axis).toBe(8192)
      expect(b.minSize * axis).toBeCloseTo(.001); expect(b.maxSize * axis).toBe(16384)
      expect(b.minPosition).toBeLessThanOrEqual(-2); expect(b.maxPosition).toBeGreaterThanOrEqual(2)
      expect(b.minSize).toBeLessThanOrEqual(.001); expect(b.maxSize).toBeGreaterThanOrEqual(4)
    }
    for (const axis of [0, -1, NaN, Infinity, 4097, 1.5]) expect(() => imageLayerGeometryBounds(axis)).toThrow()
  })

  it('accepts every old geometry boundary and rejects physical overflow', () => {
    for (const axis of [1, 640, 4096]) for (const x of [-2, 2]) for (const width of [.001, 4]) {
      const value = { ...recipe(), outputWidth: axis, outputHeight: axis, layers: [{ ...defaultEditorImageLayer(0), x, y: x, width, height: width }] }
      expect(parseImageTransformRecipe(value)).toEqual(value)
    }
    const value = { ...recipe(), outputWidth: 1, outputHeight: 1, layers: [{ ...defaultEditorImageLayer(0), x: -12287, width: 16384 }], documentFrame: { version: 1, width: 4096, height: 1, offsetX: 4095, offsetY: 0 } }
    expect(parseImageTransformRecipe(value)).toEqual(value)
    for (const patch of [{ x: -12287.001 }, { x: 4097.001 }, { width: 16384.001 }, { height: .0009 }]) expect(() => parseImageTransformRecipe({ ...value, layers: [{ ...value.layers[0], ...patch }] })).toThrow()
  })

  it('reconstructs original replay geometry while retaining local edit object identity', () => {
    const edits = { version: 1 as const, operations: [{ mode: 'fill' as const, color: '#ff0000', opacity: 1 }] }
    const value: ImageLayerRecipe = { ...recipe(), outputWidth: 400, outputHeight: 280, documentFrame: { version: 1, width: 640, height: 480, offsetX: 120, offsetY: 100 }, layers: [{ ...defaultEditorImageLayer(0), x: -.3, y: -100 / 280, width: 1.6, height: 480 / 280, edits }] }
    const replay = buildLayerDocumentReplayRecipe(value)
    expect(replay.documentFrame).toBeUndefined(); expect(replay.outputWidth).toBe(640); expect(replay.outputHeight).toBe(480)
    expect(replay.layers[0]).toMatchObject({ x: 0, y: 0, width: 1, height: 1 })
    expect(replay.layers[0].edits).toBe(edits)
    expect(parseImageTransformRecipe(replay)).toEqual(replay)
    expect(value.documentFrame?.offsetX).toBe(120)
  })

  it('grows the replay union without discarding retained pixels and refuses excess allocations', () => {
    const frame = { version: 1 as const, width: 640, height: 480, offsetX: 120, offsetY: 100 }
    expect(resizeLayerDocumentFrame(frame, { width: 200, height: 100 })).toEqual(frame)
    expect(resizeLayerDocumentFrame(frame, { width: 800, height: 500 })).toEqual({ ...frame, width: 920, height: 600 })
    expect(frame.width).toBe(640)
    expect(() => resizeLayerDocumentFrame(frame, { width: 4096, height: 500 })).toThrow(/4096/)
  })
})
