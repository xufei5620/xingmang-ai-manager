import type { ImageLayerRecipe } from '../image-tools/recipe'
import type { ImageLayerLiquifyOperation } from '../image-tools/layer-liquify'

export function liquifyOperationFixture(): ImageLayerLiquifyOperation {
  return { mode: 'liquify', version: 1, space: { width: 128, height: 96 }, strokes: [
    { tool: 'push', radius: 24, strength: .65, points: [[3000, 4000], [6000, 5000]] },
    { tool: 'bulge', radius: 18, strength: .5, points: [[6000, 4000]] },
    { tool: 'twirl-cw', radius: 20, strength: .4, points: [[5000, 6000]] },
  ] }
}
export function liquifyRecipeFixture(): ImageLayerRecipe {
  return { kind: 'layer', outputWidth: 128, outputHeight: 96, background: 'transparent', explicitLayers: true, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, edits: { version: 1, operations: [
    { mode: 'paint', points: [[1000, 5000], [9000, 5000]], size: 8, hardness: 1, opacity: 1, color: '#ff8844', space: { width: 128, height: 96 } },
    liquifyOperationFixture(),
    { mode: 'paint', points: [[5000, 1000], [5000, 9000]], size: 6, hardness: .8, opacity: .75, color: '#44aaff', space: { width: 128, height: 96 } },
  ] } }] }
}
