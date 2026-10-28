import type { ImageLayerRecipe, ImageLayerSelection } from './recipe'

export function layerVectorRecipeFixture(): ImageLayerRecipe {
  const selection: ImageLayerSelection = { kind: 'ellipse', transform: [0.8, 0, 0, 0.8, 0.1, 0.1], inverted: false, feather: { radius: 5, space: { width: 640, height: 480 } } }
  return { kind: 'layer', outputWidth: 640, outputHeight: 480, background: 'transparent', explicitLayers: true, layers: [{
    sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 30, flipX: true, opacity: 0.7, blend: 'multiply', visible: true,
    content: { kind: 'path', points: [[1000, 1000], [8000, 1000], [5000, 9000]], handles: [{ out: [3000, 5000] }, { in: [6000, 5000] }, { out: [1000, 6000] }], fill: '#ffaa5580', stroke: '#ffffff', strokeWidth: 4, space: { width: 640, height: 480 } },
    edits: { version: 1, operations: [{ mode: 'gradient', from: [500, 1000], to: [9000, 8000], startColor: '#ff000080', endColor: '#0000ff00', opacity: 0.5, space: { width: 640, height: 480 }, selection }] },
    mask: { kind: 'rectangle', transform: [1, 0, 0, 1, 0, 0], inverted: false },
  }] }
}
