import { imageLayerRasterSelectionFromOutput, imageLayerSelectionFromOutputRect } from './geometry'
import { imageLayerEditUsage, imageLayerPointScale, maximumImageLayerOperations, maximumImageLayerPathPoints, maximumImageLayerPoints, parseImageTransformRecipe, type ImageLayer, type ImageLayerRecipe, type ImageLayerSelection, type ImageLayerStroke, type ImageLayerBrushStroke, type ImageLayerFilterStroke, type ImageLayerOperation, type ImageLayerGradient } from './recipe'
import { appendEditorCustomLayer, defaultEditorImageLayer, patchEditorLayer, type LayerEditorState } from './layer-editor-state'
import type { LayerRasterSelection } from './layer-raster-selection'

export type LayerCanvasTool = 'move' | 'blur' | 'sharpen' | 'brush' | 'eraser' | 'select-rectangle' | 'select-ellipse' | 'select-wand' | 'select-quick' | 'select-color-range' | 'fill' | 'bucket' | 'picker' | 'gradient' | 'pen'
export interface LayerPaintSettings { size: number; hardness: number; opacity: number; color: string }
export interface LayerCanvasPoint { x: number; y: number }
export interface LayerPathAnchor extends LayerCanvasPoint { in?: LayerCanvasPoint; out?: LayerCanvasPoint }
export interface LayerCanvasGeometricSelection { kind: 'rectangle' | 'ellipse'; x: number; y: number; width: number; height: number; inverted: boolean; featherRadius?: number }
export interface LayerCanvasRasterSelection { kind: 'raster'; raster: LayerRasterSelection; inverted: boolean; featherRadius?: number }
export type LayerCanvasSelection = LayerCanvasGeometricSelection | LayerCanvasRasterSelection

export interface LayerColorSampleRequest { controller: AbortController; recipe: ImageLayerRecipe; selectedId: string | null; sourcesKey: string }

export function isCurrentLayerColorSample(request: LayerColorSampleRequest, active: LayerColorSampleRequest | null, present: { recipe: ImageLayerRecipe; selectedId: string | null }, sourcesKey: string): boolean {
  return active === request && !request.controller.signal.aborted && request.recipe === present.recipe && request.selectedId === present.selectedId && request.sourcesKey === sourcesKey
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)) }

export function isLayerGesturePointer(gesture: { pointerId: number } | null, pointerId: number): boolean {
  return gesture !== null && gesture.pointerId === pointerId
}

export function outputPointToLayerPoint(layer: ImageLayer, output: { width: number; height: number }, point: LayerCanvasPoint): [number, number] {
  const width = layer.width * output.width, height = layer.height * output.height, angle = layer.rotation * Math.PI / 180
  const x = (point.x - layer.x * output.width - width / 2) * (layer.flipX ? -1 : 1)
  const y = (point.y - layer.y * output.height - height / 2) * (layer.flipY ? -1 : 1)
  return [
    Math.round(clamp((Math.cos(angle) * x + Math.sin(angle) * y + width / 2) / width, -2, 3) * imageLayerPointScale) || 0,
    Math.round(clamp((-Math.sin(angle) * x + Math.cos(angle) * y + height / 2) / height, -2, 3) * imageLayerPointScale) || 0,
  ]
}

export function buildCanvasSelection(start: LayerCanvasPoint, end: LayerCanvasPoint, kind: 'rectangle' | 'ellipse', output: { width: number; height: number }, equalSides = false): LayerCanvasGeometricSelection | null {
  const x = clamp(start.x, 0, output.width), y = clamp(start.y, 0, output.height)
  let endX = clamp(end.x, 0, output.width), endY = clamp(end.y, 0, output.height)
  if (equalSides) {
    const directionX = endX >= x ? 1 : -1, directionY = endY >= y ? 1 : -1
    const side = Math.min(Math.max(Math.abs(endX - x), Math.abs(endY - y)), directionX > 0 ? output.width - x : x, directionY > 0 ? output.height - y : y)
    endX = x + side * directionX; endY = y + side * directionY
  }
  if (Math.abs(endX - x) < 0.5 || Math.abs(endY - y) < 0.5) return null
  return { kind, x: Math.min(x, endX) / output.width, y: Math.min(y, endY) / output.height, width: Math.abs(endX - x) / output.width, height: Math.abs(endY - y) / output.height, inverted: false }
}

export function layerSelectionSnapshot(layer: ImageLayer, recipe: ImageLayerRecipe, selection: LayerCanvasSelection): ImageLayerSelection {
  if (selection.kind === 'raster') {
    if (selection.raster.width !== recipe.outputWidth || selection.raster.height !== recipe.outputHeight) throw new Error('画布尺寸已变化，请重新创建像素选区')
    return imageLayerRasterSelectionFromOutput(layer, { width: recipe.outputWidth, height: recipe.outputHeight }, { x: 0, y: 0, width: recipe.outputWidth, height: recipe.outputHeight }, selection.raster, selection.inverted, selection.featherRadius)
  }
  return imageLayerSelectionFromOutputRect(layer, { width: recipe.outputWidth, height: recipe.outputHeight }, { x: selection.x * recipe.outputWidth, y: selection.y * recipe.outputHeight, width: selection.width * recipe.outputWidth, height: selection.height * recipe.outputHeight }, selection.kind, selection.inverted, selection.featherRadius)
}

export function layerPaintTargetError(layer: ImageLayer | undefined): string | null {
  if (!layer) return '请先选择图层，或新建空白绘画层'
  if (layer.locked) return '当前图层已锁定，请先解锁再绘制'
  if (!layer.visible) return '当前图层已隐藏，请先显示再绘制'
  return null
}

export function remainingLayerPaintBudget(recipe: ImageLayerRecipe): { operations: number; points: number } {
  const usage = imageLayerEditUsage(recipe.layers)
  return { operations: maximumImageLayerOperations - usage.operations, points: maximumImageLayerPoints - usage.points }
}

export function createLayerGradient(layer: ImageLayer, recipe: ImageLayerRecipe, settings: { startColor: string; endColor: string; opacity: number }, fromOutput: LayerCanvasPoint, toOutput: LayerCanvasPoint, selection: LayerCanvasSelection | null = null): ImageLayerGradient {
  const error = layerPaintTargetError(layer)
  if (error) throw new Error(error)
  if (![fromOutput.x, fromOutput.y, toOutput.x, toOutput.y].every(Number.isFinite)) throw new Error('渐变端点坐标无效，请重新拖拽')
  const output = { width: recipe.outputWidth, height: recipe.outputHeight }
  const from = outputPointToLayerPoint(layer, output, fromOutput), to = outputPointToLayerPoint(layer, output, toOutput)
  if (from[0] === to[0] && from[1] === to[1]) throw new Error('请拖出一段渐变距离')
  return { mode: 'gradient', from, to, ...settings, space: { width: layer.width * recipe.outputWidth, height: layer.height * recipe.outputHeight }, ...(selection ? { selection: layerSelectionSnapshot(layer, recipe, selection) } : {}) }
}

export function addEditorPathLayer(state: LayerEditorState, pointsOutput: readonly LayerPathAnchor[], style: { fill: string; stroke: string; strokeWidth: number }, selection: LayerCanvasSelection | null = null): LayerEditorState {
  const recipe = state.present.recipe
  if (pointsOutput.length < 3 || pointsOutput.length > maximumImageLayerPathPoints) throw new Error('钢笔路径需要 3–1024 个锚点')
  if (!Number.isFinite(style.strokeWidth) || style.strokeWidth < 0 || style.strokeWidth > 64) throw new Error('钢笔描边宽度必须在 0–64 范围内')
  if (pointsOutput.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > recipe.outputWidth || point.y < 0 || point.y > recipe.outputHeight)) throw new Error('钢笔锚点必须位于当前画布内')
  const controls = pointsOutput.flatMap((point) => [point, ...(point.in ? [point.in] : []), ...(point.out ? [point.out] : [])])
  if (controls.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < -2 * recipe.outputWidth || point.x > 3 * recipe.outputWidth || point.y < -2 * recipe.outputHeight || point.y > 3 * recipe.outputHeight)) throw new Error('钢笔曲线柄超出安全范围')
  const padding = style.stroke !== 'transparent' && style.strokeWidth > 0 ? style.strokeWidth / 2 + 1 : 1
  const left = Math.min(...controls.map((point) => point.x)) - padding, top = Math.min(...controls.map((point) => point.y)) - padding
  const width = Math.max(recipe.outputWidth * 0.001, Math.max(...controls.map((point) => point.x)) + padding - left)
  const height = Math.max(recipe.outputHeight * 0.001, Math.max(...controls.map((point) => point.y)) + padding - top)
  function normalize(point: LayerCanvasPoint): [number, number] { return [Math.round((point.x - left) / width * imageLayerPointScale), Math.round((point.y - top) / height * imageLayerPointScale)] }
  const points: Array<[number, number]> = []
  const handles: Array<{ in?: [number, number]; out?: [number, number] }> = []
  for (const point of pointsOutput) {
    const normalized = normalize(point)
    if (points.length && normalized[0] === points.at(-1)![0] && normalized[1] === points.at(-1)![1]) {
      if (point.in || point.out) throw new Error('曲线锚点过近，请移动锚点后再闭合')
      continue
    }
    points.push(normalized)
    handles.push({ ...(point.in ? { in: normalize(point.in) } : {}), ...(point.out ? { out: normalize(point.out) } : {}) })
  }
  if (points.length > 1 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1]) {
    if (handles.at(-1)!.in || handles.at(-1)!.out) throw new Error('闭合锚点不应重复，请直接确认完成')
    points.pop(); handles.pop()
  }
  const layer: ImageLayer = { ...defaultEditorImageLayer(0), name: `钢笔 ${state.sequence + 1}`, x: left / recipe.outputWidth, y: top / recipe.outputHeight, width: width / recipe.outputWidth, height: height / recipe.outputHeight, content: { kind: 'path', points, ...(handles.some((handle) => handle.in || handle.out) ? { handles } : {}), ...style, space: { width, height } } }
  if (selection) layer.mask = layerSelectionSnapshot(layer, recipe, selection)
  return appendEditorCustomLayer(state, layer)
}

export function createLayerPaintStroke(layer: ImageLayer, recipe: ImageLayerRecipe, settings: LayerPaintSettings, mode: 'paint' | 'erase', point: LayerCanvasPoint, selection: LayerCanvasSelection | null): ImageLayerStroke {
  return { mode, points: [outputPointToLayerPoint(layer, { width: recipe.outputWidth, height: recipe.outputHeight }, point)], ...settings, space: { width: layer.width * recipe.outputWidth, height: layer.height * recipe.outputHeight }, ...(selection ? { selection: layerSelectionSnapshot(layer, recipe, selection) } : {}) }
}

export function createLayerFilterStroke(layer: ImageLayer, recipe: ImageLayerRecipe, settings: { size: number; strength: number }, mode: 'blur' | 'sharpen', point: LayerCanvasPoint, selection: LayerCanvasSelection | null): ImageLayerFilterStroke {
  return { mode, points: [outputPointToLayerPoint(layer, { width: recipe.outputWidth, height: recipe.outputHeight }, point)], ...settings, space: { width: layer.width * recipe.outputWidth, height: layer.height * recipe.outputHeight }, ...(selection ? { selection: layerSelectionSnapshot(layer, recipe, selection) } : {}) }
}

export function shouldAppendPaintPoint(stroke: ImageLayerBrushStroke, point: [number, number], force = false): boolean {
  const previous = stroke.points.at(-1)
  if (!previous) return true
  if (previous[0] === point[0] && previous[1] === point[1]) return false
  const dx = (point[0] - previous[0]) / imageLayerPointScale * stroke.space.width, dy = (point[1] - previous[1]) / imageLayerPointScale * stroke.space.height
  return force || Math.hypot(dx, dy) >= Math.min(2, Math.max(0.25, stroke.size / 16))
}

export function appendEditorPaintStroke(state: LayerEditorState, id: string, stroke: ImageLayerBrushStroke): LayerEditorState {
  return appendEditorLayerOperation(state, id, stroke)
}

export function appendEditorLayerOperation(state: LayerEditorState, id: string, operation: ImageLayerOperation): LayerEditorState {
  const index = state.present.ids.indexOf(id), layer = state.present.recipe.layers[index]
  const error = layerPaintTargetError(layer)
  if (error) throw new Error(error)
  const edits = { version: 1 as const, operations: [...(layer.edits?.operations ?? []), structuredClone(operation)] }
  const candidate = { ...state.present.recipe, layers: state.present.recipe.layers.map((item, i) => i === index ? { ...item, edits } : item) }
  const parsed = parseImageTransformRecipe(candidate)
  if (parsed.kind !== 'layer') throw new Error('绘画参数无效')
  return patchEditorLayer(state, id, { edits: parsed.layers[index].edits })
}

export function adjustCanvasSelection(selection: LayerCanvasGeometricSelection, output: { width: number; height: number }, amount: number): LayerCanvasGeometricSelection {
  if (!Number.isFinite(amount) || Math.abs(amount) > 4096) throw new Error('选区调整距离无效')
  // Expansion of an inverted selection contracts its unselected hole.
  const distance = selection.inverted ? -amount : amount
  const left = clamp(selection.x * output.width - distance, 0, output.width)
  const top = clamp(selection.y * output.height - distance, 0, output.height)
  const right = clamp((selection.x + selection.width) * output.width + distance, 0, output.width)
  const bottom = clamp((selection.y + selection.height) * output.height + distance, 0, output.height)
  if (right - left < 0.5 || bottom - top < 0.5) throw new Error('选区边界过小，已保留原选区，请减小距离')
  return { ...selection, x: left / output.width, y: top / output.height, width: (right - left) / output.width, height: (bottom - top) / output.height }
}

export function appendEditorLayerFill(state: LayerEditorState, id: string, color: string, opacity: number, selection: LayerCanvasSelection | null): LayerEditorState {
  const layer = state.present.recipe.layers[state.present.ids.indexOf(id)]
  const error = layerPaintTargetError(layer)
  if (error) throw new Error(error)
  return appendEditorLayerOperation(state, id, { mode: 'fill', color, opacity, ...(selection ? { selection: layerSelectionSnapshot(layer, state.present.recipe, selection) } : {}) })
}

export function appendEditorLayerOutline(state: LayerEditorState, id: string, settings: { color: string; opacity: number; width: number; position: 'inside' | 'center' | 'outside' }, selection: LayerCanvasSelection): LayerEditorState {
  const layer = state.present.recipe.layers[state.present.ids.indexOf(id)]
  const error = layerPaintTargetError(layer)
  if (error) throw new Error(error)
  return appendEditorLayerOperation(state, id, { mode: 'outline', ...settings, space: { width: layer.width * state.present.recipe.outputWidth, height: layer.height * state.present.recipe.outputHeight }, selection: layerSelectionSnapshot(layer, state.present.recipe, selection) })
}

export function layerRasterPreviewSize(width: number, height: number, rasterCount: number): { width: number; height: number } {
  const pixelBudget = Math.min(1_048_576, Math.floor(2_097_152 / Math.max(1, rasterCount)))
  const scale = Math.min(1, 1024 / Math.max(width, height), Math.sqrt(pixelBudget / (width * height)))
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}
