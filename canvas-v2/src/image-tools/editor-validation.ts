import { buildCollageLayout } from './collage-layout'
import type { ImageTransformSize } from './geometry'
import { imageCollageInputCountError, parseImageTransformRecipe, type ImageTransformRecipe } from './recipe'

/** Empty tools remain reusable templates; connected tools must not save a known invalid layout. */
export function validateImageToolDraft(recipe: ImageTransformRecipe, images: readonly { dimensions: ImageTransformSize; dimensionsReady: boolean }[]): ImageTransformRecipe {
  const parsed = parseImageTransformRecipe(recipe)
  if (parsed.kind === 'collage' && images.length) {
    const countError = imageCollageInputCountError(parsed, images.length)
    if (countError) throw new Error(countError)
    if (images.every((image) => image.dimensionsReady)) buildCollageLayout(images.map((image) => image.dimensions), parsed)
  }
  return parsed
}
