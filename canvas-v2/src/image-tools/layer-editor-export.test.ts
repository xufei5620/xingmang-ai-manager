import { describe, expect, it } from 'vitest'
import { buildLayerEditorPsdExport } from './layer-editor-export'
import { defaultEditorImageLayer } from './layer-editor-state'
import type { ImageLayerRecipe } from './recipe'

function recipe(): ImageLayerRecipe { return { kind: 'layer', explicitLayers: true, outputWidth: 320, outputHeight: 240, background: 'transparent', layers: [] } }
const images = [{ asset: { kind: 'image' as const, localUrl: 'legacy-without-id' } }, { asset: { kind: 'image' as const, assetId: 'a'.repeat(43) } }, { asset: { kind: 'image' as const, assetId: 'b'.repeat(43) } }]

describe('layer editor PSD export input', () => {
  it('densely remaps used image sources including hidden layers without changing the editable recipe', () => {
    const value = { ...recipe(), layers: [{ ...defaultEditorImageLayer(2), visible: false }, defaultEditorImageLayer(1), defaultEditorImageLayer(2)] }, before = structuredClone(value)
    const result = buildLayerEditorPsdExport(value, images)
    expect(result.sourceAssetIds).toEqual(['b'.repeat(43), 'a'.repeat(43)])
    expect(result.recipe.layers.map((layer) => layer.sourceIndex)).toEqual([0, 1, 0])
    expect(result.recipe.layers[0].visible).toBe(false)
    expect(value).toEqual(before)
    expect(result.recipe).not.toBe(value)
  })

  it('exports content-only and explicit empty documents without loading unused legacy images', () => {
    const value: ImageLayerRecipe = { ...recipe(), layers: [{ ...defaultEditorImageLayer(0), content: { kind: 'paint' } }] }
    expect(buildLayerEditorPsdExport(value, images).sourceAssetIds).toEqual([])
    expect(buildLayerEditorPsdExport(recipe(), images).recipe.layers).toEqual([])
  })

  it('materializes older implicit image layers and refuses actually used images without an asset id', () => {
    const value = { ...recipe(), explicitLayers: false }
    expect(buildLayerEditorPsdExport(value, images.slice(1)).recipe.layers).toHaveLength(2)
    expect(() => buildLayerEditorPsdExport(value, images)).toThrow('缺少可导出')
    expect(() => buildLayerEditorPsdExport({ ...recipe(), layers: [defaultEditorImageLayer(0)] }, images)).toThrow('缺少可导出')
  })
})
