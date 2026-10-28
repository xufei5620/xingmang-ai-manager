import { resolveImageCollageTemplate, type ImageCollageTemplateLayout } from './collage-templates'
import { parseImageLayerTypography, type ImageLayerTypography } from './layer-text-layout'
import { parseImageLayerColorGrade, type ImageLayerColorGrade } from './layer-color-grade'
import { parseImageLayerLiquifyOperation, type ImageLayerLiquifyOperation } from './layer-liquify'
import { imageLayerGeometryBounds, maximumLayerDocumentEdge, parseImageLayerDocumentFrame, type ImageLayerDocumentFrame } from './layer-document-geometry'
import { parseImageLayerWholeFilterOperation, type ImageLayerWholeFilterOperation } from './layer-whole-filter'
import { parseImageLayerGroups, type ImageLayerGrouping } from './layer-group-model'
export type { ImageLayerGroup, ImageLayerGrouping } from './layer-group-model'
export type { ImageLayerWholeFilterOperation, ImageLayerWholeFilter, WholeLayerFilterType } from './layer-whole-filter'
export type { ImageLayerColorGrade } from './layer-color-grade'
export type { ImageLayerLiquifyOperation, ImageLayerLiquifyStroke, ImageLayerLiquifyTool } from './layer-liquify'
export type { ImageLayerDocumentFrame } from './layer-document-geometry'
export type { ImageLayerTypography, ImageLayerTextWarpStyle, ImageLayerTextWeight } from './layer-text-layout'

/** Declarative, versioned recipes shared by the editor, host and asset service. */
// Additive layer options leave every previously accepted recipe byte-for-byte
// canonical and keep old pending receipts resumable under the same processor.
export const imageTransformProcessorRevision = 'browser-image-v1' as const
export const maximumImageTransformInputs = 20
export const maximumImageTransformOutputs = 16
export const maximumImageTransformEdge = maximumLayerDocumentEdge
export const maximumImageTransformPixels = 16_777_216
export const maximumImageTransformTotalPixels = 33_554_432
export const maximumImageLayerPoints = 4096
export const maximumImageLayerOperations = 256
export const maximumImageLayerEditBytes = 64 * 1024
export const maximumImageLayerRasterRuns = 8192
export const maximumImageLayerPathPoints = 1024
export const imageLayerPointScale = 10000

export type ImageTransformKind = 'crop' | 'collage' | 'grid-split' | 'tile' | 'layer'
export type ImageTransformNodeKind = 'image-crop' | 'image-collage' | 'image-grid-split' | 'image-tile' | 'image-layer'
export type ImageFit = 'contain' | 'cover'
export type ImageBlendMode = 'source-over' | 'multiply' | 'screen' | 'overlay'
export type ImageCollageLayout = 'grid' | 'horizontal' | 'vertical' | 'hero-left' | 'hero-top' | ImageCollageTemplateLayout
export interface ImageCollageWatermark { text: string; color: string; opacity: number; fontSize: number }
export interface ImageCropRecipe {
  kind: 'crop'
  x: number
  y: number
  width: number
  height: number
  outputWidth: number
  outputHeight: number
  rotation: 0 | 90 | 180 | 270
  flipX: boolean
  flipY: boolean
}
export interface ImageCollageRecipe {
  kind: 'collage'
  rows: number
  columns: number
  gap: number
  padding: number
  outputWidth: number
  outputHeight: number
  fit: ImageFit
  background: string
  layout?: ImageCollageLayout
  autoSize?: boolean
  cornerRadius?: number
  borderWidth?: number
  borderColor?: string
  shadow?: boolean
  watermark?: ImageCollageWatermark
}
export interface ImageGridSplitRecipe {
  kind: 'grid-split'
  rows: number
  columns: number
  gap: number
  padding: number
}
export interface ImageTileRecipe {
  kind: 'tile'
  rows: number
  columns: number
  gap: number
  outputWidth: number
  outputHeight: number
  fit: ImageFit
  background: string
  mirrorAlternate: boolean
}
export interface ImageLayerAdjustments {
  brightness: number
  contrast: number
  saturation: number
  blur: number
  grayscale: number
}
export interface ImageLayerTextContent {
  kind: 'text'
  text: string
  color: string
  fontSize: number
  fontFamily: 'sans-serif' | 'serif' | 'monospace'
  fontWeight: 400 | 700
  align: 'left' | 'center' | 'right'
  typography?: ImageLayerTypography
}
export interface ImageLayerShapeContent {
  kind: 'shape'
  shape: 'rectangle' | 'ellipse'
  fill: string
  stroke: string
  strokeWidth: number
}
export interface ImageLayerPaintContent { kind: 'paint' }
export interface ImageLayerPathContent {
  kind: 'path'
  /** An implicitly closed path, in layer-local normalized fixed points. */
  points: Array<[number, number]>
  handles?: Array<{ in?: [number, number]; out?: [number, number] }>
  fill: string
  stroke: string
  strokeWidth: number
  space: { width: number; height: number }
}
/** Maps a unit selection rectangle to layer-local normalized coordinates. */
interface ImageLayerSelectionBase {
  transform: [number, number, number, number, number, number]
  inverted: boolean
  /** Gaussian radius in pixels at the time of selection; resizing scales it. */
  feather?: { radius: number; space: { width: number; height: number } }
}
export interface ImageLayerRaster { width: number; height: number; runs: number[] }
export type ImageLayerSelection = ImageLayerSelectionBase & (
  { kind: 'rectangle' | 'ellipse' } | { kind: 'raster'; raster: ImageLayerRaster }
)
export interface ImageLayerStroke {
  mode: 'paint' | 'erase'
  points: Array<[number, number]>
  size: number
  hardness: number
  opacity: number
  color: string
  /** Logical layer size when this stroke was drawn; subsequent resizing scales it. */
  space: { width: number; height: number }
  selection?: ImageLayerSelection
}
export interface ImageLayerFilterStroke {
  mode: 'blur' | 'sharpen'
  points: Array<[number, number]>
  size: number
  strength: number
  space: { width: number; height: number }
  selection?: ImageLayerSelection
}
export type ImageLayerBrushStroke = ImageLayerStroke | ImageLayerFilterStroke
export interface ImageLayerFill {
  mode: 'fill'
  color: string
  opacity: number
  selection?: ImageLayerSelection
}
export interface ImageLayerOutline {
  mode: 'outline'
  color: string
  opacity: number
  width: number
  position: 'inside' | 'center' | 'outside'
  space: { width: number; height: number }
  selection: ImageLayerSelection
}
export interface ImageLayerGradient {
  mode: 'gradient'
  from: [number, number]
  to: [number, number]
  startColor: string
  endColor: string
  opacity: number
  space: { width: number; height: number }
  selection?: ImageLayerSelection
}
export type ImageLayerOperation = ImageLayerBrushStroke | ImageLayerFill | ImageLayerOutline | ImageLayerGradient | ImageLayerLiquifyOperation | ImageLayerWholeFilterOperation
export interface ImageLayerEdits { version: 1; operations: ImageLayerOperation[] }
export type ImageLayerContent = ImageLayerTextContent | ImageLayerShapeContent | ImageLayerPaintContent | ImageLayerPathContent
export interface ImageLayer {
  sourceIndex: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
  blend: ImageBlendMode
  visible: boolean
  name?: string
  locked?: boolean
  flipX?: boolean
  flipY?: boolean
  adjustments?: ImageLayerAdjustments
  colorGrade?: ImageLayerColorGrade
  content?: ImageLayerContent
  edits?: ImageLayerEdits
  mask?: ImageLayerSelection
}
export interface ImageLayerRecipe {
  kind: 'layer'
  outputWidth: number
  outputHeight: number
  background: string
  /** Without explicitLayers, empty means one full-canvas layer per input. */
  layers: ImageLayer[]
  explicitLayers?: boolean
  documentFrame?: ImageLayerDocumentFrame
  layerGroups?: ImageLayerGrouping
}
export type ImageTransformRecipe = ImageCropRecipe | ImageCollageRecipe | ImageGridSplitRecipe | ImageTileRecipe | ImageLayerRecipe

export function isImageTransformNodeKind(value: string): value is ImageTransformNodeKind {
  return ['image-crop', 'image-collage', 'image-grid-split', 'image-tile', 'image-layer'].includes(value)
}

export function imageTransformKindForNode(value: string): ImageTransformKind | null {
  return isImageTransformNodeKind(value) ? value.slice(6) as ImageTransformKind : null
}

export function defaultImageTransformRecipe(kind: ImageTransformKind): ImageTransformRecipe {
  if (kind === 'crop') return { kind, x: 0, y: 0, width: 1, height: 1, outputWidth: 1024, outputHeight: 1024, rotation: 0, flipX: false, flipY: false }
  if (kind === 'grid-split') return { kind, rows: 3, columns: 3, gap: 0, padding: 0 }
  if (kind === 'collage') return { kind, rows: 2, columns: 2, gap: 16, padding: 16, outputWidth: 1024, outputHeight: 1024, fit: 'cover', background: '#ffffff' }
  if (kind === 'tile') return { kind, rows: 3, columns: 3, gap: 0, outputWidth: 1024, outputHeight: 1024, fit: 'cover', background: '#ffffff', mirrorAlternate: false }
  return { kind, outputWidth: 1024, outputHeight: 1024, background: 'transparent', layers: [] }
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('图像工具参数格式不正确')
  const item = value as Record<string, unknown>
  if (Object.keys(item).some((key) => !allowed.includes(key))) throw new Error('图像工具参数包含不支持的字段')
  return item
}

function number(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${label}必须在 ${min}–${max} 范围内${integer ? '且为整数' : ''}`)
  return Object.is(value, -0) ? 0 : value
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('图像工具开关参数无效')
  return value
}

function color(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:transparent|#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)$/.test(value)) throw new Error('背景色必须是十六进制颜色或透明')
  return value.toLowerCase()
}

function fit(value: unknown): ImageFit {
  if (value !== 'contain' && value !== 'cover') throw new Error('图像填充方式无效')
  return value
}

function plainText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) throw new Error(`${label}格式无效或超过 ${maximum} 字`)
  return value
}

function adjustments(value: unknown): ImageLayerAdjustments {
  const input = record(value, ['brightness', 'contrast', 'saturation', 'blur', 'grayscale'])
  return { brightness: number(input.brightness, '亮度', 0, 2), contrast: number(input.contrast, '对比度', 0, 2), saturation: number(input.saturation, '饱和度', 0, 2), blur: number(input.blur, '模糊', 0, 32), grayscale: number(input.grayscale, '灰度', 0, 1) }
}

function layerContent(value: unknown): ImageLayerContent {
  const kind = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).kind : undefined
  if (kind === 'paint') { record(value, ['kind']); return { kind } }
  if (kind === 'path') {
    const input = record(value, ['kind', 'points', 'handles', 'fill', 'stroke', 'strokeWidth', 'space'])
    if (!Array.isArray(input.points) || input.points.length < 3 || input.points.length > maximumImageLayerPathPoints) throw new Error('钢笔路径需要 3–1024 个锚点')
    const points = input.points.map((value) => fixedPoint(value, '钢笔锚点', 0, imageLayerPointScale))
    let handles: ImageLayerPathContent['handles']
    if (input.handles !== undefined) {
      if (!Array.isArray(input.handles) || input.handles.length !== points.length) throw new Error('钢笔曲线柄必须与锚点一一对应')
      handles = input.handles.map((value) => {
        const handle = record(value, ['in', 'out'])
        return { ...(handle.in !== undefined ? { in: fixedPoint(handle.in, '钢笔入柄', 0, imageLayerPointScale) } : {}), ...(handle.out !== undefined ? { out: fixedPoint(handle.out, '钢笔出柄', 0, imageLayerPointScale) } : {}) }
      })
    }
    if (points.some((point, index) => { const next = points[(index + 1) % points.length]; return point[0] === next[0] && point[1] === next[1] })) throw new Error('钢笔路径不能包含相邻重复锚点')
    const [first, second] = points
    const controls = [...points, ...(handles ?? []).flatMap((handle) => [...(handle.in ? [handle.in] : []), ...(handle.out ? [handle.out] : [])])]
    if (controls.every((point) => (second[0] - first[0]) * (point[1] - first[1]) === (second[1] - first[1]) * (point[0] - first[0]))) throw new Error('钢笔路径的锚点和曲线柄不能全部共线')
    const space = record(input.space, ['width', 'height'])
    return { kind, points, ...(handles !== undefined ? { handles } : {}), fill: color(input.fill), stroke: color(input.stroke), strokeWidth: number(input.strokeWidth, '钢笔描边宽度', 0, 64), space: { width: number(space.width, '钢笔参考宽度', 0.001, 16384), height: number(space.height, '钢笔参考高度', 0.001, 16384) } }
  }
  if (kind === 'text') {
    const input = record(value, ['kind', 'text', 'color', 'fontSize', 'fontFamily', 'fontWeight', 'align', 'typography'])
    if (typeof input.color !== 'string' || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(input.color)) throw new Error('文字颜色必须是十六进制颜色')
    if (input.fontFamily !== 'sans-serif' && input.fontFamily !== 'serif' && input.fontFamily !== 'monospace') throw new Error('文字字体不受支持')
    if (input.fontWeight !== 400 && input.fontWeight !== 700) throw new Error('文字字重不受支持')
    if (input.align !== 'left' && input.align !== 'center' && input.align !== 'right') throw new Error('文字对齐方式不受支持')
    return { kind, text: plainText(input.text, '图层文字', 2000), color: input.color.toLowerCase(), fontSize: number(input.fontSize, '文字大小', 1, 512), fontFamily: input.fontFamily, fontWeight: input.fontWeight, align: input.align, ...(input.typography !== undefined ? { typography: parseImageLayerTypography(input.typography) } : {}) }
  }
  if (kind === 'shape') {
    const input = record(value, ['kind', 'shape', 'fill', 'stroke', 'strokeWidth'])
    if (input.shape !== 'rectangle' && input.shape !== 'ellipse') throw new Error('图层形状不受支持')
    return { kind, shape: input.shape, fill: color(input.fill), stroke: color(input.stroke), strokeWidth: number(input.strokeWidth, '描边宽度', 0, 64) }
  }
  throw new Error('图层内容类型不受支持')
}

function fixedPoint(value: unknown, label: string, min = -2 * imageLayerPointScale, max = 3 * imageLayerPointScale): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label}坐标无效`)
  return [number(value[0], `${label}横坐标`, min, max, true), number(value[1], `${label}纵坐标`, min, max, true)]
}

export function parseImageLayerRaster(value: unknown): ImageLayerRaster {
  const input = record(value, ['width', 'height', 'runs'])
  const width = number(input.width, '像素选区宽度', 1, maximumImageTransformEdge, true)
  const height = number(input.height, '像素选区高度', 1, maximumImageTransformEdge, true)
  if (!Array.isArray(input.runs) || input.runs.length % 2 || input.runs.length > maximumImageLayerRasterRuns * 2) throw new Error('像素选区过于复杂，请减少选区细节后重试')
  const runs: number[] = []
  let previousEnd = -1
  for (let index = 0; index < input.runs.length; index += 2) {
    const start = number(input.runs[index], '像素选区起点', 0, width * height - 1, true)
    const length = number(input.runs[index + 1], '像素选区长度', 1, width, true)
    if (start < previousEnd || start % width + length > width || (start === previousEnd && start % width !== 0)) throw new Error('像素选区必须按行排序、合并连续像素且不能重叠或跨行')
    runs.push(start, length)
    previousEnd = start + length
  }
  return { width, height, runs }
}

export function parseImageLayerSelection(value: unknown): ImageLayerSelection {
  const kind = value && typeof value === 'object' ? (value as Record<string, unknown>).kind : undefined
  const input = record(value, ['kind', 'transform', 'inverted', 'feather', ...(kind === 'raster' ? ['raster'] : [])])
  if (input.kind !== 'rectangle' && input.kind !== 'ellipse' && input.kind !== 'raster') throw new Error('选区形状不受支持')
  if (!Array.isArray(input.transform) || input.transform.length !== 6) throw new Error('选区变换无效')
  const matrix = input.transform.map((entry) => number(entry, '选区变换', -8192, 8192)) as ImageLayerSelection['transform']
  const [a, b, c, d] = matrix
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d))
  if (!scale || Math.abs(a * d - b * c) <= Math.max(1e-12, scale * scale * 1e-10)) throw new Error('选区过小或变换无效，请重新框选')
  let feather: ImageLayerSelection['feather']
  if (input.feather !== undefined) {
    const value = record(input.feather, ['radius', 'space']), space = record(value.space, ['width', 'height'])
    const radius = number(value.radius, '选区羽化半径', 0, 128)
    const size = { width: number(space.width, '羽化参考宽度', 0.001, 16384), height: number(space.height, '羽化参考高度', 0.001, 16384) }
    if (radius > 0) feather = { radius, space: size }
  }
  const common = { transform: matrix, inverted: bool(input.inverted), ...(feather ? { feather } : {}) }
  return input.kind === 'raster' ? { kind: 'raster', ...common, raster: parseImageLayerRaster(input.raster) } : { kind: input.kind, ...common }
}

function layerEdits(value: unknown): ImageLayerEdits {
  const input = record(value, ['version', 'operations'])
  if (input.version !== 1 || !Array.isArray(input.operations) || input.operations.length > maximumImageLayerOperations) throw new Error('绘画参数无效或超过 256 笔')
  return { version: 1, operations: input.operations.map((value): ImageLayerOperation => {
    if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).mode === 'whole-filter') return parseImageLayerWholeFilterOperation(value)
    if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).mode === 'liquify') return parseImageLayerLiquifyOperation(value)
    if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).mode === 'gradient') {
      const gradient = record(value, ['mode', 'from', 'to', 'startColor', 'endColor', 'opacity', 'space', 'selection'])
      const from = fixedPoint(gradient.from, '渐变起点'), to = fixedPoint(gradient.to, '渐变终点'), space = record(gradient.space, ['width', 'height'])
      if (from[0] === to[0] && from[1] === to[1]) throw new Error('请拖出一段渐变距离')
      const startColor = color(gradient.startColor), endColor = color(gradient.endColor)
      if (startColor === 'transparent' || endColor === 'transparent') throw new Error('渐变颜色必须是十六进制颜色，透明度请使用颜色的 Alpha 值')
      return { mode: 'gradient', from, to, startColor, endColor, opacity: number(gradient.opacity, '渐变不透明度', 0, 1), space: { width: number(space.width, '渐变参考宽度', 0.001, 16384), height: number(space.height, '渐变参考高度', 0.001, 16384) }, ...(gradient.selection !== undefined ? { selection: parseImageLayerSelection(gradient.selection) } : {}) }
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).mode === 'fill') {
      const fill = record(value, ['mode', 'color', 'opacity', 'selection']), fillColor = color(fill.color)
      if (fillColor === 'transparent') throw new Error('填充颜色必须是十六进制颜色')
      return { mode: 'fill', color: fillColor, opacity: number(fill.opacity, '填充不透明度', 0, 1), ...(fill.selection !== undefined ? { selection: parseImageLayerSelection(fill.selection) } : {}) }
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).mode === 'outline') {
      const outline = record(value, ['mode', 'color', 'opacity', 'width', 'position', 'space', 'selection']), outlineColor = color(outline.color)
      const space = record(outline.space, ['width', 'height'])
      if (outlineColor === 'transparent') throw new Error('描边颜色必须是十六进制颜色')
      if (outline.position !== 'inside' && outline.position !== 'center' && outline.position !== 'outside') throw new Error('选区描边位置无效')
      return { mode: 'outline', color: outlineColor, opacity: number(outline.opacity, '描边不透明度', 0, 1), width: number(outline.width, '选区描边宽度', 1, 64), position: outline.position,
        space: { width: number(space.width, '描边参考宽度', 0.001, 16384), height: number(space.height, '描边参考高度', 0.001, 16384) }, selection: parseImageLayerSelection(outline.selection) }
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && ['blur', 'sharpen'].includes(String((value as Record<string, unknown>).mode))) {
      const filter = record(value, ['mode', 'points', 'size', 'strength', 'space', 'selection'])
      if (!Array.isArray(filter.points) || !filter.points.length || filter.points.length > maximumImageLayerPoints) throw new Error('每笔局部滤镜需要有效路径且不超过 4096 个点')
      const space = record(filter.space, ['width', 'height'])
      return { mode: filter.mode as 'blur' | 'sharpen', points: filter.points.map((point) => fixedPoint(point, '滤镜笔坐标')), size: number(filter.size, '滤镜笔大小', 1, 512), strength: number(filter.strength, '滤镜强度', 0, 1), space: { width: number(space.width, '滤镜参考宽度', 0.001, 16384), height: number(space.height, '滤镜参考高度', 0.001, 16384) }, ...(filter.selection !== undefined ? { selection: parseImageLayerSelection(filter.selection) } : {}) }
    }
    const stroke = record(value, ['mode', 'points', 'size', 'hardness', 'opacity', 'color', 'space', 'selection'])
    if (stroke.mode !== 'paint' && stroke.mode !== 'erase') throw new Error('绘画工具类型无效')
    if (!Array.isArray(stroke.points) || !stroke.points.length || stroke.points.length > maximumImageLayerPoints) throw new Error('每笔需要有效路径且不超过 4096 个点')
    const space = record(stroke.space, ['width', 'height'])
    const brushColor = color(stroke.color)
    if (brushColor === 'transparent') throw new Error('画笔颜色必须是十六进制颜色')
    return { mode: stroke.mode, points: stroke.points.map((value): [number, number] => {
      if (!Array.isArray(value) || value.length !== 2) throw new Error('画笔坐标无效')
      return [number(value[0], '画笔横坐标', -2 * imageLayerPointScale, 3 * imageLayerPointScale, true), number(value[1], '画笔纵坐标', -2 * imageLayerPointScale, 3 * imageLayerPointScale, true)]
    }), size: number(stroke.size, '画笔大小', 1, 512), hardness: number(stroke.hardness, '画笔硬度', 0, 1), opacity: number(stroke.opacity, '画笔不透明度', 0, 1), color: brushColor,
    space: { width: number(space.width, '画笔参考宽度', 0.001, 16384), height: number(space.height, '画笔参考高度', 0.001, 16384) },
    ...(stroke.selection !== undefined ? { selection: parseImageLayerSelection(stroke.selection) } : {}) }
  }) }
}

/** Shared aggregate limits also used by editor gesture admission. */
export function imageLayerEditUsage(layers: readonly ImageLayer[]): { points: number; operations: number; bytes: number } {
  let points = 0, operations = 0
  const values = layers.map((layer) => {
    for (const stroke of layer.edits?.operations ?? []) { operations++; if (stroke.mode === 'paint' || stroke.mode === 'erase' || stroke.mode === 'blur' || stroke.mode === 'sharpen') points += stroke.points.length; else if (stroke.mode === 'gradient') points += 2; else if (stroke.mode === 'liquify') { operations += stroke.strokes.length; points += stroke.strokes.reduce((sum, entry) => sum + entry.points.length, 0) } }
    if (layer.content?.kind === 'path') { operations++; points += layer.content.points.length + (layer.content.handles ?? []).reduce((total, handle) => total + Number(!!handle.in) + Number(!!handle.out), 0) }
    return { ...(layer.edits !== undefined ? { edits: layer.edits } : {}), ...(layer.mask !== undefined ? { mask: layer.mask } : {}), ...(layer.content?.kind === 'path' ? { content: layer.content } : {}) }
  })
  return { points, operations, bytes: new TextEncoder().encode(JSON.stringify(values)).byteLength }
}

/** Local text/shapes and an explicitly empty canvas can omit source images. */
export function imageTransformRecipeNeedsSources(recipe: ImageTransformRecipe): boolean {
  return recipe.kind !== 'layer' || (!recipe.layers.length && !recipe.explicitLayers) || recipe.layers.some((layer) => !layer.content)
}

function dimensions(input: Record<string, unknown>) {
  return { outputWidth: number(input.outputWidth, '输出宽度', 1, maximumImageTransformEdge, true), outputHeight: number(input.outputHeight, '输出高度', 1, maximumImageTransformEdge, true) }
}

export function imageCollageCapacity(recipe: ImageCollageRecipe): number {
  const template = resolveImageCollageTemplate(recipe.layout)
  if (template) return template.inputCount
  if (recipe.layout === 'horizontal' || recipe.layout === 'vertical') return maximumImageTransformInputs
  if (recipe.layout === 'hero-left' || recipe.layout === 'hero-top') return 3
  return recipe.rows * recipe.columns
}

/** Unknown batches establish a lower bound; they cannot prove missing template inputs. */
export function imageCollageInputCountError(recipe: ImageCollageRecipe, count: number, exact = true): string | null {
  const template = resolveImageCollageTemplate(recipe.layout)
  if (template) return count > template.inputCount || (exact && count !== template.inputCount)
    ? `${template.title}模板需要恰好 ${template.inputCount} 张输入图片，当前${exact ? '' : '至少 '}${count} 张；请调整来源或改用其他布局，不会自动丢弃图片`
    : null
  const hero = recipe.layout === 'hero-left' || recipe.layout === 'hero-top'
  if (hero && (count > 3 || (exact && count < 2))) return '主辅图拼图需要 2–3 张输入图片，请调整来源；不会自动丢弃图片'
  if (count <= imageCollageCapacity(recipe)) return null
  if (recipe.layout === 'horizontal' || recipe.layout === 'vertical') return '横向或纵向拼图最多支持 20 张输入图片，请减少来源'
  return `${count} 张输入需至少 ${count} 格，当前 ${recipe.rows}×${recipe.columns}=${recipe.rows * recipe.columns} 格，请调整拼图行列`
}

export function imageCollageUsesAutoSize(recipe: ImageTransformRecipe): boolean {
  return recipe.kind === 'collage' && recipe.autoSize === true && (recipe.layout === 'horizontal' || recipe.layout === 'vertical')
}

function collageOptions(input: Record<string, unknown>): Pick<ImageCollageRecipe, 'layout' | 'autoSize' | 'cornerRadius' | 'borderWidth' | 'borderColor' | 'shadow' | 'watermark'> {
  const result: ReturnType<typeof collageOptions> = {}
  if (input.layout !== undefined) {
    if (typeof input.layout !== 'string' || (!['grid', 'horizontal', 'vertical', 'hero-left', 'hero-top'].includes(input.layout) && !resolveImageCollageTemplate(input.layout))) throw new Error('拼图布局无效')
    result.layout = input.layout as ImageCollageLayout
  }
  if (input.autoSize !== undefined) {
    result.autoSize = bool(input.autoSize)
    if (result.autoSize && result.layout !== 'horizontal' && result.layout !== 'vertical') throw new Error('自动尺寸仅适用于横向或纵向拼图')
  }
  if (input.cornerRadius !== undefined) result.cornerRadius = number(input.cornerRadius, '拼图圆角', 0, 256)
  if (input.borderWidth !== undefined) result.borderWidth = number(input.borderWidth, '拼图边框宽度', 0, 64)
  if (input.borderColor !== undefined) result.borderColor = color(input.borderColor)
  if (input.shadow !== undefined) result.shadow = bool(input.shadow)
  if (input.watermark !== undefined) {
    const watermark = record(input.watermark, ['text', 'color', 'opacity', 'fontSize'])
    result.watermark = { text: plainText(watermark.text, '水印文字', 160), color: color(watermark.color), opacity: number(watermark.opacity, '水印不透明度', 0, 1), fontSize: number(watermark.fontSize, '水印字号', 10, 128) }
  }
  return result
}

export function parseImageTransformRecipe(value: unknown): ImageTransformRecipe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请先设置图像工具参数')
  const kind = (value as Record<string, unknown>).kind
  if (kind === 'crop') {
    const input = record(value, ['kind', 'x', 'y', 'width', 'height', 'outputWidth', 'outputHeight', 'rotation', 'flipX', 'flipY'])
    const x = number(input.x, '裁剪横坐标', 0, 1), y = number(input.y, '裁剪纵坐标', 0, 1)
    const width = number(input.width, '裁剪宽度', 0.0001, 1), height = number(input.height, '裁剪高度', 0.0001, 1)
    if (x + width > 1.000001 || y + height > 1.000001) throw new Error('裁剪范围超出图片边界')
    if (![0, 90, 180, 270].includes(input.rotation as number)) throw new Error('旋转角度必须是 90° 的倍数')
    return { kind, x, y, width, height, ...dimensions(input), rotation: input.rotation as ImageCropRecipe['rotation'], flipX: bool(input.flipX), flipY: bool(input.flipY) }
  }
  if (kind === 'grid-split') {
    const input = record(value, ['kind', 'rows', 'columns', 'gap', 'padding'])
    const rows = number(input.rows, '行数', 1, 4, true), columns = number(input.columns, '列数', 1, 4, true)
    return { kind, rows, columns, gap: number(input.gap, '间距', 0, 512, true), padding: number(input.padding, '边距', 0, 512, true) }
  }
  if (kind === 'collage' || kind === 'tile') {
    const input = record(value, ['kind', 'rows', 'columns', 'gap', 'outputWidth', 'outputHeight', 'fit', 'background', ...(kind === 'tile' ? ['mirrorAlternate'] : ['padding', 'layout', 'autoSize', 'cornerRadius', 'borderWidth', 'borderColor', 'shadow', 'watermark'])])
    const rows = number(input.rows, '行数', 1, kind === 'tile' ? 8 : 4, true), columns = number(input.columns, '列数', 1, kind === 'tile' ? 8 : 4, true)
    const size = dimensions(input), gap = number(input.gap, '间距', 0, 512, true)
    const padding = kind === 'collage' ? number(input.padding, '边距', 0, 512, true) : 0
    const options = kind === 'collage' ? collageOptions(input) : {}
    if ((!options.layout || options.layout === 'grid') && (size.outputWidth - padding * 2 - gap * (columns - 1) < columns || size.outputHeight - padding * 2 - gap * (rows - 1) < rows)) throw new Error('间距和边距过大，图片单元格没有可用空间')
    if (options.layout && options.layout !== 'grid' && !options.autoSize && (size.outputWidth <= padding * 2 || size.outputHeight <= padding * 2)) throw new Error('边距过大，拼图没有可用空间')
    const common = { rows, columns, gap, ...size, fit: fit(input.fit), background: color(input.background) }
    return kind === 'tile' ? { kind, ...common, mirrorAlternate: bool(input.mirrorAlternate) } : { kind, ...common, padding, ...options }
  }
  if (kind === 'layer') {
    const input = record(value, ['kind', 'outputWidth', 'outputHeight', 'background', 'layers', 'explicitLayers', 'documentFrame', 'layerGroups'])
    if (!Array.isArray(input.layers) || input.layers.length > maximumImageTransformInputs) throw new Error('最多支持 20 个图层')
    const size = dimensions(input)
    const documentFrame = input.documentFrame === undefined ? undefined : parseImageLayerDocumentFrame(input.documentFrame, { width: size.outputWidth, height: size.outputHeight })
    if (documentFrame && input.explicitLayers !== true) throw new Error('裁剪文档需要明确的图层列表，请先打开图层编辑器确认全部来源')
    const horizontal = imageLayerGeometryBounds(size.outputWidth, documentFrame?.offsetX), vertical = imageLayerGeometryBounds(size.outputHeight, documentFrame?.offsetY)
    const layers = input.layers.map((value): ImageLayer => {
      const layer = record(value, ['sourceIndex', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'blend', 'visible', 'name', 'locked', 'flipX', 'flipY', 'adjustments', 'colorGrade', 'content', 'edits', 'mask'])
      if (!['source-over', 'multiply', 'screen', 'overlay'].includes(layer.blend as string)) throw new Error('图层混合模式无效')
      return { sourceIndex: number(layer.sourceIndex, '图层来源', 0, maximumImageTransformInputs - 1, true), x: number(layer.x, '图层横坐标', horizontal.minPosition, horizontal.maxPosition), y: number(layer.y, '图层纵坐标', vertical.minPosition, vertical.maxPosition), width: number(layer.width, '图层宽度', horizontal.minSize, horizontal.maxSize), height: number(layer.height, '图层高度', vertical.minSize, vertical.maxSize), rotation: number(layer.rotation, '图层角度', -360, 360), opacity: number(layer.opacity, '图层不透明度', 0, 1), blend: layer.blend as ImageBlendMode, visible: bool(layer.visible),
        ...(layer.name !== undefined ? { name: plainText(layer.name, '图层名称', 80) } : {}),
        ...(layer.locked !== undefined ? { locked: bool(layer.locked) } : {}),
        ...(layer.flipX !== undefined ? { flipX: bool(layer.flipX) } : {}),
        ...(layer.flipY !== undefined ? { flipY: bool(layer.flipY) } : {}),
        ...(layer.adjustments !== undefined ? { adjustments: adjustments(layer.adjustments) } : {}),
        ...(layer.colorGrade !== undefined ? { colorGrade: parseImageLayerColorGrade(layer.colorGrade) } : {}),
        ...(layer.content !== undefined ? { content: layerContent(layer.content) } : {}),
        ...(layer.edits !== undefined ? { edits: layerEdits(layer.edits) } : {}),
        ...(layer.mask !== undefined ? { mask: parseImageLayerSelection(layer.mask) } : {}),
      }
    })
    const usage = imageLayerEditUsage(layers)
    if (usage.points > maximumImageLayerPoints || usage.operations > maximumImageLayerOperations || usage.bytes > maximumImageLayerEditBytes) throw new Error('绘画内容超过容量：全部图层合计最多 256 笔、4096 个路径点及 64 KB，请拆分图层节点')
    for (const layer of layers) {
      if (layer.content?.kind === 'path' && layer.content.strokeWidth * Math.max(layer.width * size.outputWidth / layer.content.space.width, layer.height * size.outputHeight / layer.content.space.height) > 512) throw new Error('钢笔描边缩放过大，请减小图层或描边宽度')
      const selections = [layer.mask, ...(layer.edits?.operations ?? []).map((operation) => operation.mode === 'liquify' || operation.mode === 'whole-filter' ? undefined : operation.selection)]
      for (const selection of selections) if (selection?.feather) {
        const feather = selection.feather
        if (feather.radius * Math.max(layer.width * size.outputWidth / feather.space.width, layer.height * size.outputHeight / feather.space.height) > 512) throw new Error('选区羽化缩放过大，请减小图层或羽化半径')
      }
      for (const stroke of layer.edits?.operations ?? []) {
        if (stroke.mode === 'fill' || stroke.mode === 'gradient' || stroke.mode === 'liquify' || stroke.mode === 'whole-filter') continue
        if (stroke.mode === 'outline') {
          if (stroke.width * Math.max(layer.width * size.outputWidth / stroke.space.width, layer.height * size.outputHeight / stroke.space.height) > 512) throw new Error('描边缩放过大，请减小图层或描边宽度')
          continue
        }
        const diameter = stroke.size * Math.max(layer.width * size.outputWidth / stroke.space.width, layer.height * size.outputHeight / stroke.space.height)
        if (diameter > 16384 || ('hardness' in stroke && diameter * (1 - Math.max(0.05, stroke.hardness)) / 6 > 512)) throw new Error('笔迹缩放过大，请减小图层或画笔尺寸')
      }
    }
    if (input.layerGroups !== undefined && input.explicitLayers !== true) throw new Error('图层编组需要明确的图层列表')
    return { kind, ...size, background: color(input.background), layers, ...(input.explicitLayers !== undefined ? { explicitLayers: bool(input.explicitLayers) } : {}), ...(documentFrame !== undefined ? { documentFrame } : {}), ...(input.layerGroups !== undefined ? { layerGroups: parseImageLayerGroups(input.layerGroups, layers.length) } : {}) }
  }
  throw new Error('当前图像工具类型不受支持')
}

export function imageTransformRecipeForNode(kind: string, settings?: Record<string, unknown>): ImageTransformRecipe | null {
  const operation = imageTransformKindForNode(kind)
  if (!operation) return null
  if (settings?.imageTransform === undefined) return defaultImageTransformRecipe(operation)
  const recipe = parseImageTransformRecipe(settings.imageTransform)
  if (recipe.kind !== operation) throw new Error('图像工具参数与节点类型不匹配')
  return recipe
}
