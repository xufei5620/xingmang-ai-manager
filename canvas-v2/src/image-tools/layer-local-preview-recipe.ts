import type { ImageLayer, ImageLayerRecipe } from './recipe'

/** These dedicated tools inspect the whole selected layer in local pixels.
 * A document crop window belongs only to the composed document, so inheriting
 * it here would clip the wrong coordinates or invalidate the local preview. */
export function buildLayerLocalPreviewRecipe(recipe: ImageLayerRecipe, layer: ImageLayer): ImageLayerRecipe {
  const { documentFrame: _documentFrame, ...document } = recipe
  return { ...document, outputWidth: Math.max(1, Math.round(layer.width * recipe.outputWidth)), outputHeight: Math.max(1, Math.round(layer.height * recipe.outputHeight)), background: 'transparent', explicitLayers: true,
    layers: [{ ...layer, x: 0, y: 0, width: 1, height: 1, rotation: 0, flipX: false, flipY: false, visible: true, opacity: 1, blend: 'source-over' }],
  }
}
