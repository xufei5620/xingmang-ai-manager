import type { ImageLayerRecipe } from './recipe'
import { resolveLayerDocumentFrame } from './layer-document-geometry'
import { assertLayerFilterSize, layerFilterLimits } from './layer-filter-raster'
import { layerWholeFilterSpace } from './layer-whole-filter'

export interface LayerFilterPresentationMatrix { a: number; b: number; c: number; d: number; e: number; f: number }
export interface LayerFilterPresentationRect { x: number; y: number; width: number; height: number }
export interface LayerFilterPresentationFrame {
  width: number
  height: number
  /** Native upright pixel coordinates <-> current document world coordinates. */
  layerToWorld: LayerFilterPresentationMatrix
  worldToLayer: LayerFilterPresentationMatrix
  worldBounds: LayerFilterPresentationRect
  replayRect: LayerFilterPresentationRect
  documentPolygon: readonly [number, number][]
}

export const maximumLayerFilterPresentationPixels = layerFilterLimits.pixels * 2

export function assertLayerFilterPresentationBudget(surfaces: readonly { width: number; height: number }[]): void {
  let pixels = 0
  for (const surface of surfaces) { assertLayerFilterSize(surface.width, surface.height); pixels += surface.width * surface.height }
  if (pixels > maximumLayerFilterPresentationPixels) throw new Error('完整图层预览的临时像素超过安全容量，请减小图层或模糊半径')
}

export function layerFilterPresentationPoint(matrix: LayerFilterPresentationMatrix, x: number, y: number): [number, number] {
  return [matrix.a * x + matrix.c * y + matrix.e, matrix.b * x + matrix.d * y + matrix.f]
}

export function buildLayerFilterPresentationFrame(recipe: ImageLayerRecipe, layerIndex: number): LayerFilterPresentationFrame {
  const native = layerWholeFilterSpace(recipe, layerIndex), layer = recipe.layers[layerIndex], replay = resolveLayerDocumentFrame(recipe)
  const physicalWidth = layer.width * recipe.outputWidth, physicalHeight = layer.height * recipe.outputHeight
  if (![physicalWidth, physicalHeight, layer.x, layer.y, layer.rotation].every(Number.isFinite) || physicalWidth <= 0 || physicalHeight <= 0) throw new Error('完整图层预览坐标无效')
  const angle = layer.rotation * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle), flipX = layer.flipX ? -1 : 1, flipY = layer.flipY ? -1 : 1
  const a = flipX * cosine, b = flipY * sine, c = -flipX * sine, d = flipY * cosine
  const layerToWorld = { a: a * physicalWidth / native.width, b: b * physicalWidth / native.width, c: c * physicalHeight / native.height, d: d * physicalHeight / native.height,
    e: layer.x * recipe.outputWidth + physicalWidth / 2 - a * physicalWidth / 2 - c * physicalHeight / 2,
    f: layer.y * recipe.outputHeight + physicalHeight / 2 - b * physicalWidth / 2 - d * physicalHeight / 2 }
  const determinant = layerToWorld.a * layerToWorld.d - layerToWorld.b * layerToWorld.c
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('完整图层预览变换无法确认')
  const worldToLayer = { a: layerToWorld.d / determinant, b: -layerToWorld.b / determinant, c: -layerToWorld.c / determinant, d: layerToWorld.a / determinant,
    e: (layerToWorld.c * layerToWorld.f - layerToWorld.d * layerToWorld.e) / determinant, f: (layerToWorld.b * layerToWorld.e - layerToWorld.a * layerToWorld.f) / determinant }
  const corners = [[0, 0], [native.width, 0], [native.width, native.height], [0, native.height]].map(([x, y]) => layerFilterPresentationPoint(layerToWorld, x, y))
  const halo = Math.max(2, Math.ceil((layer.adjustments?.blur ?? 0) * 4) + 2)
  const x = Math.floor(Math.min(...corners.map((point) => point[0]))) - halo, y = Math.floor(Math.min(...corners.map((point) => point[1]))) - halo
  const worldBounds = { x, y, width: Math.ceil(Math.max(...corners.map((point) => point[0]))) + halo - x, height: Math.ceil(Math.max(...corners.map((point) => point[1]))) + halo - y }
  assertLayerFilterSize(worldBounds.width, worldBounds.height)
  const needsAdjustmentSurface = layer.adjustments && (layer.adjustments.brightness !== 1 || layer.adjustments.contrast !== 1 || layer.adjustments.saturation !== 1 || layer.adjustments.blur !== 0 || layer.adjustments.grayscale !== 0)
  assertLayerFilterPresentationBudget([worldBounds, replay])
  if (needsAdjustmentSurface) assertLayerFilterPresentationBudget([worldBounds, worldBounds])
  return { ...native, layerToWorld, worldToLayer, worldBounds, replayRect: { x: -replay.offsetX, y: -replay.offsetY, width: replay.width, height: replay.height },
    documentPolygon: [[0, 0], [recipe.outputWidth, 0], [recipe.outputWidth, recipe.outputHeight], [0, recipe.outputHeight]].map(([px, py]) => layerFilterPresentationPoint(worldToLayer, px, py)) }
}
