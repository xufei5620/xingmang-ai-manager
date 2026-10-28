import type { LayerCanvasPoint, LayerCanvasSelection } from './layer-paint-state'
import type { ImageLayerRecipe } from './recipe'
import { maximumLayerGrabCutPoints, maximumLayerGrabCutStrokes, normalizeLayerGrabCutRegion, type LayerGrabCutRegion, type LayerGrabCutStroke } from './layer-grabcut-selection'
import type { LayerSelectionCombination } from './layer-canvas-selection'

export type LayerQuickSelectionMode = 'region' | 'foreground' | 'background'
export type LayerQuickSampleSource = 'current' | 'composite'
export interface LayerQuickPixels {
  recipe: ImageLayerRecipe
  selectedId: string | null
  sourcesKey: string
  source: LayerQuickSampleSource
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}
export interface LayerQuickSelectionSession {
  pixels: LayerQuickPixels
  region: LayerGrabCutRegion
  strokes: readonly LayerGrabCutStroke[]
  baseSelection: LayerCanvasSelection | null
  combination: LayerSelectionCombination
}
export interface LayerQuickSelectionGuide {
  mode: LayerQuickSelectionMode
  start: LayerCanvasPoint
  end: LayerCanvasPoint
  points: readonly LayerCanvasPoint[]
  diameter: number
}

export function layerQuickPixelsCurrent(pixels: LayerQuickPixels | null, present: { recipe: ImageLayerRecipe; selectedId: string | null }, sourcesKey: string, source: LayerQuickSampleSource): pixels is LayerQuickPixels {
  return !!pixels && pixels.recipe === present.recipe && pixels.selectedId === present.selectedId && pixels.sourcesKey === sourcesKey && pixels.source === source
}

export function layerQuickSessionCurrent(session: LayerQuickSelectionSession | undefined, pixels: LayerQuickPixels | null, present: { recipe: ImageLayerRecipe; selectedId: string | null }, sourcesKey: string, source: LayerQuickSampleSource): session is LayerQuickSelectionSession {
  return !!session && session.pixels === pixels && layerQuickPixelsCurrent(pixels, present, sourcesKey, source)
}

export function clampLayerQuickPoint(point: LayerCanvasPoint, bounds: LayerGrabCutRegion): LayerCanvasPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('快速选择坐标无效，请重新框选')
  return { x: Math.max(bounds.x, Math.min(bounds.x + bounds.width, point.x)), y: Math.max(bounds.y, Math.min(bounds.y + bounds.height, point.y)) }
}

export function layerQuickRegion(start: LayerCanvasPoint, end: LayerCanvasPoint, output: { width: number; height: number }): LayerGrabCutRegion {
  const bounds = { x: 0, y: 0, ...output }, a = clampLayerQuickPoint(start, bounds), b = clampLayerQuickPoint(end, bounds)
  return normalizeLayerGrabCutRegion({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }, output)
}

export function appendLayerQuickPoint(points: readonly LayerCanvasPoint[], point: LayerCanvasPoint, diameter: number, existingPoints: number, bounds: LayerGrabCutRegion, force = false): readonly LayerCanvasPoint[] {
  if (!Number.isFinite(diameter) || diameter < 1 || diameter > 512) throw new Error('修正笔径应为 1–512 原始像素')
  const next = clampLayerQuickPoint(point, bounds), previous = points.at(-1)
  if (previous && Math.hypot(next.x - previous.x, next.y - previous.y) < (force ? 0.001 : Math.max(0.75, diameter / 10))) return points
  if (existingPoints + points.length >= maximumLayerGrabCutPoints) throw new Error('快速选择修正超过 4096 个轨迹点，本笔已取消；请撤销部分修正或重新框选')
  return [...points, next]
}

export function appendLayerQuickStroke(session: LayerQuickSelectionSession, mode: 'foreground' | 'background', diameter: number, points: readonly LayerCanvasPoint[]): readonly LayerGrabCutStroke[] {
  if (session.strokes.length >= maximumLayerGrabCutStrokes) throw new Error('快速选择最多支持 128 笔修正，请撤销部分修正或重新框选')
  if (!points.length) throw new Error('请在处理框内绘制修正笔触')
  if (session.strokes.reduce((count, stroke) => count + stroke.points.length, 0) + points.length > maximumLayerGrabCutPoints) throw new Error('快速选择修正超过 4096 个轨迹点，本笔已取消')
  return [...session.strokes, { mode, diameter, points: points.map((point) => clampLayerQuickPoint(point, session.region)) }]
}

