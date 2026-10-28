import { defaultImageLayerColorGrade } from '../image-tools/layer-color-grade'
import type { ImageLayerRecipe } from '../image-tools/recipe'

export function colorGradeRecipeFixture(): ImageLayerRecipe {
  const colorGrade = defaultImageLayerColorGrade()
  colorGrade.exposure = 0.75
  colorGrade.curves.rgb = [{ x: 0, y: 0 }, { x: 0.45, y: 0.6 }, { x: 1, y: 1 }]
  colorGrade.hsl.orange.saturation = 15
  colorGrade.colorGrading.shadows = { hue: 215, saturation: 20, luminance: -5 }
  return { kind: 'layer', outputWidth: 128, outputHeight: 96, background: 'transparent', explicitLayers: true, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 0.75, blend: 'source-over', visible: true, content: { kind: 'shape', shape: 'rectangle', fill: '#dd8844', stroke: 'transparent', strokeWidth: 0 }, colorGrade }] }
}
