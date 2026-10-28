import type { ImageLayerRecipe } from './recipe'
import type { LayerCanvasPoint, LayerCanvasSelection } from './layer-paint-state'

export interface LayerVectorScope {
  recipe: ImageLayerRecipe
  selectedId: string | null
  sourcesKey: string
  selection: LayerCanvasSelection | null
}
export interface LayerPenAnchor extends LayerCanvasPoint { in?: LayerCanvasPoint; out?: LayerCanvasPoint }

export function isCurrentLayerVectorScope(scope: LayerVectorScope, present: { recipe: ImageLayerRecipe; selectedId: string | null }, sourcesKey: string, selection: LayerCanvasSelection | null): boolean {
  return scope.recipe === present.recipe && scope.selectedId === present.selectedId && scope.sourcesKey === sourcesKey && scope.selection === selection
}

export function appendLayerPenAnchor(points: readonly LayerPenAnchor[], point: LayerCanvasPoint, output: { width: number; height: number }, maximumPoints: number): LayerPenAnchor[] {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > output.width || point.y > output.height) throw new Error('请在画布内添加钢笔锚点')
  const previous = points.at(-1)
  // A double click closes the current path; its second down event must not
  // introduce a duplicate anchor or a tiny extra segment.
  if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) < 0.5) return [...points]
  if (points.length >= maximumPoints) throw new Error(`钢笔路径最多 ${maximumPoints} 个锚点，请先完成当前路径`)
  return [...points, { x: point.x, y: point.y }]
}

export function dragLayerPenHandles(anchor: LayerPenAnchor, pointer: LayerCanvasPoint, output: { width: number; height: number }): LayerPenAnchor {
  if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return anchor
  const dx = Math.max(-2 * output.width, Math.min(2 * output.width, pointer.x - anchor.x))
  const dy = Math.max(-2 * output.height, Math.min(2 * output.height, pointer.y - anchor.y))
  if (Math.hypot(dx, dy) < 0.5) return { x: anchor.x, y: anchor.y }
  return { x: anchor.x, y: anchor.y, in: { x: anchor.x - dx, y: anchor.y - dy }, out: { x: anchor.x + dx, y: anchor.y + dy } }
}

export function layerPenGuidePath(points: readonly LayerPenAnchor[], closed = false): string {
  if (!points.length) return ''
  let path = `M ${points[0].x} ${points[0].y}`
  for (let index = 1; index < points.length + (closed ? 1 : 0); index++) {
    const previous = points[(index - 1) % points.length], next = points[index % points.length]
    path += previous.out || next.in ? ` C ${previous.out?.x ?? previous.x} ${previous.out?.y ?? previous.y} ${next.in?.x ?? next.x} ${next.in?.y ?? next.y} ${next.x} ${next.y}` : ` L ${next.x} ${next.y}`
  }
  return closed ? `${path} Z` : path
}

export function hasLayerGradientDistance(from: LayerCanvasPoint, to: LayerCanvasPoint): boolean {
  return Number.isFinite(from.x) && Number.isFinite(from.y) && Number.isFinite(to.x) && Number.isFinite(to.y) && Math.hypot(to.x - from.x, to.y - from.y) >= 0.5
}
