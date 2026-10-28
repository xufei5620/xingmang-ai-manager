import { parseImageTransformRecipe, type ImageLayerRecipe } from './recipe'
import { layerLiquifyLimits, parseImageLayerLiquifyOperation, type ImageLayerLiquifyOperation, type ImageLayerLiquifyStroke } from './layer-liquify'

export interface LiquifyHistory { past: ImageLayerLiquifyStroke[][]; strokes: ImageLayerLiquifyStroke[]; future: ImageLayerLiquifyStroke[][] }
export interface LiquifyView { zoom: number; x: number; y: number }

export function layerLiquifySpace(recipe: ImageLayerRecipe, index: number): { width: number; height: number } {
  const layer = recipe.layers[index]
  if (!layer || layer.locked || !layer.visible) throw new Error('请先选择可见且未锁定的图层')
  const width = Math.max(1, Math.round(layer.width * recipe.outputWidth)), height = Math.max(1, Math.round(layer.height * recipe.outputHeight))
  if (![width, height].every((value) => Number.isFinite(value) && value <= layerLiquifyLimits.spaceEdge)) throw new Error('当前图层超过液化尺寸上限，请先缩小图层')
  if (width > 4096 || height > 4096) throw new Error('液化工作台支持本地图层最长边 4096 像素，请先缩小图层；原图层未改变')
  return { width, height }
}

export function liquifyPoint(point: { x: number; y: number }, space: { width: number; height: number }): [number, number] | null {
  if (![point.x, point.y].every(Number.isFinite) || point.x < 0 || point.y < 0 || point.x > space.width || point.y > space.height) return null
  return [Math.round(point.x / space.width * layerLiquifyLimits.pointScale), Math.round(point.y / space.height * layerLiquifyLimits.pointScale)]
}

export function appendLiquifyPoint(stroke: ImageLayerLiquifyStroke, point: [number, number], space: { width: number; height: number }, final = false): ImageLayerLiquifyStroke {
  const previous = stroke.points.at(-1)
  if (previous) {
    const distance = Math.hypot((point[0] - previous[0]) * space.width / layerLiquifyLimits.pointScale, (point[1] - previous[1]) * space.height / layerLiquifyLimits.pointScale)
    if (distance < (final ? .05 : Math.max(1, stroke.radius * .08))) return stroke
  }
  if (stroke.points.length >= layerLiquifyLimits.pointsPerStroke) throw new Error('这一笔已达到 256 个采样点，请松开后继续绘制')
  return { ...stroke, points: [...stroke.points, point] }
}

export function hasLiquifyStroke(stroke: ImageLayerLiquifyStroke): boolean {
  return stroke.strength > 0 && stroke.points.length >= (stroke.tool === 'push' ? 2 : 1) && (stroke.tool !== 'push' || stroke.points.some((point) => point[0] !== stroke.points[0][0] || point[1] !== stroke.points[0][1]))
}

export function buildLiquifyOperation(space: { width: number; height: number }, strokes: readonly ImageLayerLiquifyStroke[]): ImageLayerLiquifyOperation | null {
  const active = strokes.filter(hasLiquifyStroke)
  return active.length ? parseImageLayerLiquifyOperation({ mode: 'liquify', version: 1, space, strokes: active }) : null
}

/** Validate against the original recipe so prior edits share the same point,
 * operation and byte budgets. The isolated display recipe is never persisted. */
export function appendLiquifyRecipe(recipe: ImageLayerRecipe, index: number, operation: ImageLayerLiquifyOperation | null): ImageLayerRecipe {
  if (!operation) return recipe
  const layer = recipe.layers[index]
  if (!layer || layer.locked || !layer.visible) throw new Error('当前图层已隐藏或锁定，液化没有应用')
  const result = parseImageTransformRecipe({ ...recipe, layers: recipe.layers.map((entry, at) => at === index ? { ...entry, edits: { version: 1, operations: [...(entry.edits?.operations ?? []), operation] } } : entry) })
  if (result.kind !== 'layer') throw new Error('液化图层参数无效')
  return result
}

export function liquifyHistoryChange(history: LiquifyHistory, strokes: ImageLayerLiquifyStroke[]): LiquifyHistory {
  if (history.strokes === strokes || !history.strokes.length && !strokes.length) return history
  return { past: [...history.past.slice(-63), history.strokes], strokes, future: [] }
}

export function liquifyHistoryStep(history: LiquifyHistory, redo = false): LiquifyHistory {
  if (redo) return history.future.length ? { past: [...history.past, history.strokes], strokes: history.future[0], future: history.future.slice(1) } : history
  return history.past.length ? { past: history.past.slice(0, -1), strokes: history.past.at(-1)!, future: [history.strokes, ...history.future] } : history
}

export function zoomLiquifyView(view: LiquifyView, next: number, anchor = { x: 0, y: 0 }): LiquifyView {
  const zoom = Math.max(.25, Math.min(8, Number.isFinite(next) ? next : view.zoom)), factor = zoom / view.zoom
  return { zoom, x: anchor.x + (view.x - anchor.x) * factor, y: anchor.y + (view.y - anchor.y) * factor }
}
