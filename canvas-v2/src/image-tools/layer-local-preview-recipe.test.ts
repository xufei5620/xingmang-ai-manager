import { describe, expect, it } from 'vitest'
import { defaultEditorImageLayer } from './layer-editor-state'
import { buildLayerLocalPreviewRecipe } from './layer-local-preview-recipe'
import { parseImageTransformRecipe, type ImageLayerRecipe } from './recipe'

describe('whole-layer tool preview after a document crop', () => {
  it('retains native layer pixels while removing only the composed document window', () => {
    const layer = { ...defaultEditorImageLayer(0), x: -5, y: -5, width: 16, height: 480 / 28, rotation: 30, flipX: true, opacity: .5 }
    const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 40, outputHeight: 28, background: '#ff0000', explicitLayers: true, documentFrame: { version: 1, width: 640, height: 480, offsetX: 200, offsetY: 140 }, layers: [layer] }
    const before = JSON.stringify(recipe), preview = buildLayerLocalPreviewRecipe(recipe, layer)
    expect(preview).not.toHaveProperty('documentFrame')
    expect(preview).toMatchObject({ outputWidth: 640, outputHeight: 480, background: 'transparent', layers: [{ x: 0, y: 0, width: 1, height: 1, rotation: 0, flipX: false, opacity: 1 }] })
    expect(parseImageTransformRecipe(preview)).toEqual(preview)
    expect(JSON.stringify(recipe)).toBe(before)
  })
  it('keeps whole-layer ordered operations without reusing document offsets', () => {
    const layer = { ...defaultEditorImageLayer(0), content: { kind: 'paint' as const }, edits: { version: 1 as const, operations: [{ mode: 'paint' as const, points: [[5000, 5000] as [number, number]], size: 16, hardness: 1, opacity: 1, color: '#00ffff', space: { width: 100, height: 80 } }] } }
    const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 100, outputHeight: 80, background: 'transparent', layers: [layer] }
    const preview = buildLayerLocalPreviewRecipe(recipe, layer)
    expect(preview.layers[0].edits).toEqual(layer.edits)
    expect(preview.layers[0].sourceIndex).toBe(0)
  })
})
