import { combineLayerRasterSelections, invertLayerRasterSelection, rasterizeLayerGeometricSelection, resizeLayerRasterSelection, type LayerRasterSelection } from './layer-raster-selection'
import { isCurrentLayerColorSample, type LayerCanvasSelection, type LayerCanvasTool, type LayerColorSampleRequest } from './layer-paint-state'
import type { ImageLayerRecipe } from './recipe'

export type LayerSelectionCombination = 'replace' | 'add' | 'subtract' | 'intersect'
export interface LayerPixelRequest extends LayerColorSampleRequest { selection: LayerCanvasSelection | null; tool: LayerCanvasTool }

export function isCurrentLayerPixelRequest(request: LayerPixelRequest, active: LayerColorSampleRequest | null, present: { recipe: ImageLayerRecipe; selectedId: string | null }, sourcesKey: string, selection: LayerCanvasSelection | null, tool: LayerCanvasTool): boolean {
  return isCurrentLayerColorSample(request, active, present, sourcesKey) && request.selection === selection && request.tool === tool
}

export function layerSelectionCombination(base: LayerSelectionCombination, modifiers: { shiftKey: boolean; altKey: boolean }): LayerSelectionCombination {
  return modifiers.shiftKey && modifiers.altKey ? 'intersect' : modifiers.altKey ? 'subtract' : modifiers.shiftKey ? 'add' : base
}

export async function rasterizeCanvasSelection(selection: LayerCanvasSelection, output: { width: number; height: number }, signal?: AbortSignal): Promise<LayerRasterSelection> {
  if (selection.kind === 'raster') {
    if (selection.raster.width !== output.width || selection.raster.height !== output.height) throw new Error('画布尺寸已变化，请重新创建像素选区')
    if (signal?.aborted) throw new DOMException('已取消选区处理', 'AbortError')
    return selection.inverted ? invertLayerRasterSelection(selection.raster, { signal }) : selection.raster
  }
  return rasterizeLayerGeometricSelection({ ...output, kind: selection.kind, rect: { x: selection.x * output.width, y: selection.y * output.height, width: selection.width * output.width, height: selection.height * output.height }, inverted: selection.inverted }, { signal })
}

export async function combineCanvasSelections(previous: LayerCanvasSelection | null, next: LayerCanvasSelection, mode: LayerSelectionCombination, output: { width: number; height: number }, signal?: AbortSignal): Promise<LayerCanvasSelection> {
  if (mode === 'replace' || (!previous && mode === 'add')) return next
  if (!previous) throw new Error('请先创建选区，再使用减去或交集')
  const left = await rasterizeCanvasSelection(previous, output, signal)
  const right = await rasterizeCanvasSelection(next, output, signal)
  const raster = await combineLayerRasterSelections(left, right, mode, { signal })
  return { kind: 'raster', raster, inverted: false, ...(previous.featherRadius ? { featherRadius: previous.featherRadius } : {}) }
}

export async function resizeCanvasRasterSelection(selection: Extract<LayerCanvasSelection, { kind: 'raster' }>, amount: number, signal?: AbortSignal): Promise<LayerCanvasSelection> {
  const base = await rasterizeCanvasSelection(selection, selection.raster, signal)
  const raster = await resizeLayerRasterSelection(base, amount, { signal })
  return { ...selection, raster, inverted: false }
}

export function canvasRasterSelectionCount(selection: Extract<LayerCanvasSelection, { kind: 'raster' }>): number {
  let count = 0
  for (let index = 1; index < selection.raster.runs.length; index += 2) count += selection.raster.runs[index]
  return selection.inverted ? selection.raster.width * selection.raster.height - count : count
}
