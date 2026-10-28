import { parseImageTransformRecipe, type ImageLayerRecipe } from './recipe'
import { isNeutralWholeLayerFilter, layerWholeFilterSpace, parseImageLayerWholeFilterOperation, type ImageLayerWholeFilter, type ImageLayerWholeFilterOperation } from './layer-whole-filter'
import { buildLayerFilterPresentationFrame, type LayerFilterPresentationFrame } from './layer-filter-presentation'

export function buildLayerFilterPreview(recipe: ImageLayerRecipe, layerIndex: number, operation: ImageLayerWholeFilterOperation | null): { recipe: ImageLayerRecipe; frame: LayerFilterPresentationFrame | null; error: string } {
  try {
    // A neutral operation must not switch a plain bitmap to the edited-source
    // sampling path merely to display its unchanged comparison preview.
    const neutral = operation && isNeutralWholeLayerFilter(parseImageLayerWholeFilterOperation(operation).filter)
    return { recipe: neutral ? recipe : appendLayerFilterRecipe(recipe, layerIndex, operation), frame: buildLayerFilterPresentationFrame(recipe, layerIndex), error: '' }
  }
  catch (cause) { return { recipe, frame: null, error: cause instanceof Error ? cause.message : '当前图层无法完整预览' } }
}

export function buildLayerFilterOperation(recipe: ImageLayerRecipe, layerIndex: number, filter: ImageLayerWholeFilter): ImageLayerWholeFilterOperation {
  const operation = parseImageLayerWholeFilterOperation({ mode: 'whole-filter', version: 1, filter, space: layerWholeFilterSpace(recipe, layerIndex) })
  appendLayerFilterRecipe(recipe, layerIndex, operation)
  return operation
}

export function appendLayerFilterRecipe(recipe: ImageLayerRecipe, layerIndex: number, operation: ImageLayerWholeFilterOperation | null): ImageLayerRecipe {
  if (!operation) return recipe
  const layer = recipe.layers[layerIndex]
  if (!layer) throw new Error('目标图层已不存在')
  const parsed = parseImageTransformRecipe({ ...recipe, layers: recipe.layers.map((entry, index) => index === layerIndex ? { ...entry, edits: { version: 1, operations: [...(layer.edits?.operations ?? []), operation] } } : entry) })
  if (parsed.kind !== 'layer') throw new Error('图层滤镜配置无效')
  return parsed
}

/** Keep the original output axes and crop replay domain: older outline/filter
 * operations would change meaning if replayed in an unrotated local document. */
export function previewLayerFilterRecipe(recipe: ImageLayerRecipe, layerIndex: number, operation: ImageLayerWholeFilterOperation | null): ImageLayerRecipe {
  const withFilter = appendLayerFilterRecipe(recipe, layerIndex, operation), layer = withFilter.layers[layerIndex]
  if (!layer) throw new Error('目标图层已不存在')
  return { ...withFilter, background: 'transparent', explicitLayers: true, layers: [{ ...layer, visible: true }] }
}
