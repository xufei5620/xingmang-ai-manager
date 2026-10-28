import type { AssetRef } from '../model'
import { createLayerEditorState } from './layer-editor-state'
import { parseImageTransformRecipe, type ImageLayerRecipe } from './recipe'

export function buildLayerEditorPsdExport(recipe: ImageLayerRecipe, images: readonly { asset: AssetRef }[]): { recipe: ImageLayerRecipe; sourceAssetIds: string[]; name: string } {
  const materialized = createLayerEditorState(recipe, images.length).present.recipe
  const sourceIndices: number[] = [], sourceAssetIds: string[] = []
  const layers = materialized.layers.map((layer) => {
    if (layer.content) return layer
    let sourceIndex = sourceIndices.indexOf(layer.sourceIndex)
    if (sourceIndex < 0) {
      const assetId = images[layer.sourceIndex]?.asset.assetId
      if (!assetId || !/^[A-Za-z0-9_-]{43}$/.test(assetId)) throw new Error('有图片图层缺少可导出的账号素材，请重新选择图片来源后导出 PSD')
      sourceIndex = sourceIndices.length; sourceIndices.push(layer.sourceIndex); sourceAssetIds.push(assetId)
    }
    return { ...layer, sourceIndex }
  })
  const parsed = parseImageTransformRecipe({ ...materialized, explicitLayers: true, layers })
  if (parsed.kind !== 'layer') throw new Error('当前图层参数无法导出 PSD')
  return { recipe: parsed, sourceAssetIds, name: '星芒图层作品' }
}
