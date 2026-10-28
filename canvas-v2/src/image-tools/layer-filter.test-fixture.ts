import type { ImageLayerFilterStroke, ImageLayerRecipe } from './recipe'

export function layerFilterRecipeFixture(): ImageLayerRecipe {
  const space = { width: 640, height: 480 }
  const operations: ImageLayerFilterStroke[] = [
    { mode: 'blur', points: [[2000, 3000], [4500, 6000]], size: 121, strength: 1, space },
    { mode: 'sharpen', points: [[5500, 3000], [8000, 6000]], size: 121, strength: .65, space, selection: { kind: 'ellipse', transform: [.8, 0, 0, .8, .1, .1], inverted: false } },
  ]
  return { kind: 'layer', outputWidth: 640, outputHeight: 480, background: 'transparent', explicitLayers: true, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, edits: { version: 1, operations } }] }
}
