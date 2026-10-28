import { imageLayerPointScale, type ImageLayer, type ImageLayerAdjustments, type ImageLayerContent, type ImageLayerFill, type ImageLayerFilterStroke, type ImageLayerGradient, type ImageLayerOperation, type ImageLayerOutline, type ImageLayerSelection, type ImageLayerStroke, type ImageLayerTextContent } from '../image-tools/recipe'
import { buildLayerRasterOutlineSteps } from '../image-tools/layer-raster-selection'
import { assertImageLayerTextRasterSize, imageLayerTextFont, imageLayerTextLines, rasterizeImageLayerTextWarpSteps } from '../image-tools/layer-text-layout'
import { assertLayerFilterSize, layerFilterLimits, rasterizeLayerFilterSteps } from '../image-tools/layer-filter-raster'
import { assertLocalTextFontReady } from '../image-tools/local-text-fonts'
import { createLayerColorGradeRasterizer } from '../image-tools/layer-color-grade-raster'
import { isNeutralImageLayerColorGrade } from '../image-tools/layer-color-grade'
import { isNeutralImageLayerColorDetail } from '../image-tools/layer-color-detail'
import { isNeutralImageLayerColorPresence } from '../image-tools/layer-color-presence'
import { rasterizeLayerLiquifySteps } from '../image-tools/layer-liquify-raster'
import type { ImageLayerLiquifyOperation } from '../image-tools/layer-liquify'
import { isNeutralWholeLayerFilter, type ImageLayerWholeFilterOperation } from '../image-tools/layer-whole-filter'
import { rasterizeWholeLayerFilterWorldSteps } from '../image-tools/layer-whole-filter-raster'
import type { LayerFilterPresentationFrame } from '../image-tools/layer-filter-presentation'
import type { ColorLutTable } from '../image-tools/layer-color-lut'

export interface ImageLayerPaintInput {
  layer: Pick<ImageLayer, 'content' | 'edits' | 'mask' | 'colorGrade'>
  source?: CanvasImageSource
  lutTable?: ColorLutTable
  width: number
  height: number
  signal?: AbortSignal
  deadline?: number
  /** Preview caches the unmasked layer and applies a feather mask once after its transient edit. */
  deferFeatherMask?: boolean
  /** Maps a full-resolution output surface into the reduced world preview. */
  filterRaster?: { width: number; height: number; scaleX: number; scaleY: number; offsetX: number; offsetY: number }
}

export function imageLayerCanvasFilter(adjustments?: ImageLayerAdjustments, blurScale = 1): string | undefined {
  if (!adjustments || adjustments.brightness === 1 && adjustments.contrast === 1 && adjustments.saturation === 1 && adjustments.blur === 0 && adjustments.grayscale === 0) return undefined
  return `brightness(${adjustments.brightness}) contrast(${adjustments.contrast}) saturate(${adjustments.saturation}) blur(${adjustments.blur * blurScale}px) grayscale(${adjustments.grayscale})`
}

/** Output-space preview for directional pixel kernels. Opacity and blending
 * remain on the enclosing SVG group; adjustments are applied here exactly once.
 * The small retained preview has one temporary halo surface, always released.
 */
interface ImageLayerWorldPreviewInput { layer: ImageLayer; source?: CanvasImageSource; lutTable?: ColorLutTable; output: { width: number; height: number }; transient?: ImageLayerOperation; signal?: AbortSignal; deadline?: number }

function* imageLayerWorldPreviewSteps(context: CanvasRenderingContext2D, input: ImageLayerWorldPreviewInput): Generator<void> {
  const { layer, output } = input, pixelWidth = context.canvas.width, pixelHeight = context.canvas.height
  checkPainting({ layer, width: output.width, height: output.height, signal: input.signal, deadline: input.deadline })
  if (![output.width, output.height].every((value) => Number.isInteger(value) && value > 0 && value <= 4096)
    || pixelWidth < 1 || pixelHeight < 1 || pixelWidth > 1024 || pixelHeight > 1024 || pixelWidth * pixelHeight > 1_048_576 || pixelWidth > output.width || pixelHeight > output.height) throw new Error('图层预览尺寸超过安全容量')
  const scaleX = pixelWidth / output.width, scaleY = pixelHeight / output.height, scale = Math.max(scaleX, scaleY)
  const padding = layer.adjustments?.blur ? Math.ceil(layer.adjustments.blur * scale * 4) + 2 : 0
  if (!Number.isFinite(padding) || padding < 0 || padding > 130) throw new Error('图层预览模糊参数无效')
  const surface = document.createElement('canvas'), width = layer.width * output.width, height = layer.height * output.height
  surface.width = pixelWidth + padding * 2; surface.height = pixelHeight + padding * 2
  try {
    const paint = surface.getContext('2d', { alpha: true })
    if (!paint) throw new Error('当前浏览器无法显示图层预览')
    paint.setTransform(scaleX, 0, 0, scaleY, padding, padding)
    paint.translate(layer.x * output.width + width / 2, layer.y * output.height + height / 2)
    paint.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1)
    paint.rotate(layer.rotation * Math.PI / 180)
    paint.translate(-width / 2, -height / 2)
    const drawing = input.transient ? { ...layer, edits: { version: 1 as const, operations: [...(layer.edits?.operations ?? []), input.transient] } } : layer
    const fullPadding = layer.adjustments?.blur ? Math.ceil(layer.adjustments.blur * 4) + 2 : 0
    const paintInput = { layer: drawing, source: input.source, lutTable: input.lutTable, width, height, signal: input.signal, deadline: input.deadline ?? Date.now() + 2000, filterRaster: { width: output.width + fullPadding * 2, height: output.height + fullPadding * 2, scaleX, scaleY, offsetX: padding - fullPadding * scaleX, offsetY: padding - fullPadding * scaleY } }
    checkPainting(paintInput)
    yield* imageLayerPaintSteps(paint, paintInput)
    // The target is only touched after all cancellable work has completed.
    checkPainting(paintInput)
    context.save()
    try {
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.globalAlpha = 1; context.globalCompositeOperation = 'source-over'
      context.clearRect(0, 0, pixelWidth, pixelHeight)
      const filter = imageLayerCanvasFilter(layer.adjustments, scale)
      const supportsFilter = 'filter' in context
      if (filter && !supportsFilter) throw new Error('当前浏览器不支持图层滤镜，请使用新版浏览器')
      if (supportsFilter) context.filter = filter ?? 'none'
      context.drawImage(surface, -padding, -padding)
    } finally { context.restore() }
  } finally { surface.width = 0; surface.height = 0 }
}

export function paintImageLayerWorldPreview(context: CanvasRenderingContext2D, input: ImageLayerWorldPreviewInput): void {
  for (const _step of imageLayerWorldPreviewSteps(context, input)) { /* Preserve the existing synchronous entry point. */ }
}

/** Uses the same world-coordinate geometry and final composite as the sync
 * preview; interruption closes the generator and releases its halo surface.
 */
export async function paintImageLayerWorldPreviewAsync(context: CanvasRenderingContext2D, input: ImageLayerWorldPreviewInput): Promise<void> {
  let count = 0
  for (const _step of imageLayerWorldPreviewSteps(context, input)) {
    if (++count % (input.layer.colorGrade && !isNeutralImageLayerColorGrade(input.layer.colorGrade) ? 1 : 4) === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    checkPainting({ layer: input.layer, width: input.output.width, height: input.output.height, signal: input.signal, deadline: input.deadline })
  }
}

/** Existing content coordinates are centred; keep this path unchanged for old receipts. */
export function paintImageLayerContent(context: CanvasRenderingContext2D, content: ImageLayerContent, width: number, height: number): void {
  const left = -width / 2, top = -height / 2
  if (content.kind === 'text' && content.typography) {
    for (const _step of paintImageLayerTypography(context, content, { layer: { content }, width, height, deadline: Date.now() + 2000 })) { /* Synchronous callers still use the same bounded renderer. */ }
    return
  }
  if (content.kind === 'paint') return
  if (content.kind === 'path') {
    const strokeWidth = content.strokeWidth * Math.max(width / content.space.width, height / content.space.height)
    if (!Number.isFinite(strokeWidth) || strokeWidth > 512) throw new Error('钢笔描边缩放过大，请减小图层或描边宽度')
    context.beginPath()
    const first = content.points[0]
    context.moveTo(left + first[0] * width / imageLayerPointScale, top + first[1] * height / imageLayerPointScale)
    for (let index = 1; index <= content.points.length; index++) {
      const nextIndex = index % content.points.length, previousIndex = index - 1
      const point = content.points[nextIndex], x = left + point[0] * width / imageLayerPointScale, y = top + point[1] * height / imageLayerPointScale
      const out = content.handles?.[previousIndex]?.out, incoming = content.handles?.[nextIndex]?.in
      if (out || incoming) {
        const a = out ?? content.points[previousIndex], b = incoming ?? point
        context.bezierCurveTo(left + a[0] * width / imageLayerPointScale, top + a[1] * height / imageLayerPointScale, left + b[0] * width / imageLayerPointScale, top + b[1] * height / imageLayerPointScale, x, y)
      } else context.lineTo(x, y)
    }
    context.closePath()
    if (content.fill !== 'transparent') { context.fillStyle = content.fill; context.fill() }
    if (content.stroke !== 'transparent' && strokeWidth > 0) {
      context.strokeStyle = content.stroke; context.lineWidth = strokeWidth; context.lineJoin = 'round'; context.stroke()
    }
    return
  }
  if (content.kind === 'text') {
    context.beginPath()
    context.rect(left, top, width, height)
    context.clip()
    context.font = `${content.fontWeight} ${content.fontSize}px ${content.fontFamily}`
    context.textBaseline = 'alphabetic'
    context.textAlign = content.align
    context.fillStyle = content.color
    const anchor = content.align === 'left' ? left : content.align === 'right' ? width / 2 : 0
    const lines = content.text.split(/\r\n?|\n/)
    for (let index = 0; index < lines.length && index * content.fontSize * 1.2 < height; index++) context.fillText(lines[index], anchor, top + content.fontSize + index * content.fontSize * 1.2)
    return
  }
  function shape(inset: number): void {
    context.beginPath()
    if (content.kind !== 'shape') return
    if (content.shape === 'ellipse') context.ellipse(0, 0, Math.max(0, width / 2 - inset), Math.max(0, height / 2 - inset), 0, 0, Math.PI * 2)
    else context.rect(left + inset, top + inset, width - inset * 2, height - inset * 2)
  }
  if (content.fill !== 'transparent') { context.fillStyle = content.fill; shape(0); context.fill() }
  if (content.stroke !== 'transparent' && content.strokeWidth > 0) {
    const strokeWidth = Math.min(content.strokeWidth, width, height)
    context.strokeStyle = content.stroke
    context.lineWidth = strokeWidth
    shape(strokeWidth / 2)
    context.stroke()
  }
}

function* paintTypographyLines(context: CanvasRenderingContext2D, content: ImageLayerTextContent, input: ImageLayerPaintInput, left: number, top: number): Generator<void> {
  const typography = content.typography!
  if (typography.fontSource === 'local' && typography.fontFamily) assertLocalTextFontReady(typography.fontFamily, typography.fontWeight ?? content.fontWeight)
  context.font = imageLayerTextFont(content)
  if ('letterSpacing' in context) context.letterSpacing = `${typography.letterSpacing}px`
  else if (typography.letterSpacing !== 0) throw new Error('当前浏览器不支持文字字距，请使用新版浏览器或将字距设为 0')
  context.textBaseline = 'alphabetic'; context.textAlign = content.align; context.fillStyle = content.color
  const anchor = left + (content.align === 'left' ? 0 : content.align === 'center' ? input.width / 2 : input.width)
  for (const line of imageLayerTextLines(content, input.height)) {
    checkPainting(input)
    context.fillText(line.text, anchor, top + line.baseline)
    yield
  }
}

/** Shape each complete line once, then remap premultiplied pixels in small
 * strips. Raster allocation is independent of the destination's transform;
 * large logical text layers are refused rather than silently downsampled.
 */
function* paintImageLayerTypography(context: CanvasRenderingContext2D, content: ImageLayerTextContent, input: ImageLayerPaintInput): Generator<void> {
  const { width, height } = input, left = -width / 2, top = -height / 2, warp = content.typography!.warp
  context.save()
  let source: HTMLCanvasElement | undefined, tile: HTMLCanvasElement | undefined
  try {
    context.beginPath(); context.rect(left, top, width, height); context.clip()
    if (!warp?.bend) { yield* paintTypographyLines(context, content, input, left, top); return }
    const pixelWidth = Math.ceil(width), pixelHeight = Math.ceil(height)
    assertImageLayerTextRasterSize(pixelWidth, pixelHeight)
    checkPainting(input)
    source = document.createElement('canvas'); source.width = pixelWidth; source.height = pixelHeight
    const paint = source.getContext('2d', { alpha: true, willReadFrequently: true })
    if (!paint) throw new Error('当前浏览器无法创建文字变形画布')
    paint.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0)
    yield* paintTypographyLines(paint, content, input, 0, 0)
    checkPainting(input)
    const pixels = paint.getImageData(0, 0, pixelWidth, pixelHeight).data
    source.width = 0; source.height = 0
    // A single completed surface avoids antialiased seams when a rotated or
    // fractionally scaled layer would otherwise composite separate strips.
    tile = document.createElement('canvas'); tile.width = pixelWidth; tile.height = pixelHeight
    const output = tile.getContext('2d', { alpha: true })
    if (!output) throw new Error('当前浏览器无法绘制文字变形结果')
    for (const part of rasterizeImageLayerTextWarpSteps(pixels, pixelWidth, pixelHeight, warp, input)) {
      checkPainting(input)
      const image = output.createImageData(pixelWidth, part.height)
      image.data.set(part.data); output.putImageData(image, 0, part.top)
      yield
    }
    checkPainting(input)
    context.drawImage(tile, 0, 0, pixelWidth, pixelHeight, left, top, width, height)
  } finally { context.restore(); if (source) { source.width = 0; source.height = 0 }; if (tile) { tile.width = 0; tile.height = 0 } }
}

function selectionPath(context: CanvasRenderingContext2D, selection: ImageLayerSelection): void {
  if (selection.kind === 'ellipse') { context.moveTo(1, 0.5); context.ellipse(0.5, 0.5, 0.5, 0.5, 0, 0, Math.PI * 2) }
  else if (selection.kind === 'raster') {
    const { width, height, runs } = selection.raster
    for (let index = 0; index < runs.length; index += 2) context.rect((runs[index] % width) / width, Math.floor(runs[index] / width) / height, runs[index + 1] / width, 1 / height)
  } else context.rect(0, 0, 1, 1)
}

function clipSelection(context: CanvasRenderingContext2D, selection: ImageLayerSelection, width: number, height: number): void {
  context.beginPath()
  if (selection.inverted) context.rect(0, 0, width, height)
  context.save()
  try {
    const [a, b, c, d, e, f] = selection.transform
    context.transform(a * width, b * height, c * width, d * height, e * width, f * height)
    selectionPath(context, selection)
  } finally { context.restore() }
  context.clip(selection.inverted ? 'evenodd' : 'nonzero')
}

function assertPaintSurface(context: CanvasRenderingContext2D, width: number, height: number): void {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0 && value <= 16384)
    || context.canvas.width > 4356 || context.canvas.height > 4356 || context.canvas.width * context.canvas.height > 18_974_736) throw new Error('图层绘制画布超过安全容量')
}

/** An alpha mask is applied to the complete isolated source, not each overlapping
 * primitive. Filtering the finite vector path avoids another full-size bitmap.
 * Inversion complements its blurred coverage, rather than blurring the canvas edge.
 */
export function applyImageLayerFeatherMask(context: CanvasRenderingContext2D, input: { mask: ImageLayerSelection; width: number; height: number }): void {
  const { mask, width, height } = input, feather = mask.feather
  if (!feather) return
  assertPaintSurface(context, width, height)
  if (mask.kind === 'raster' && !mask.raster.runs.length) {
    if (!mask.inverted) { context.save(); try { context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, context.canvas.width, context.canvas.height) } finally { context.restore() } }
    return
  }
  const matrix = context.getTransform()
  const logical = feather.radius * Math.max(width / feather.space.width, height / feather.space.height)
  const blur = logical * Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d))
  if (!Number.isFinite(logical) || logical < 0 || logical > 512 || !Number.isFinite(blur) || blur > 512) throw new Error('选区羽化缩放过大，请减小图层或羽化半径')
  if (!('filter' in context)) throw new Error('当前浏览器不支持选区羽化，请使用新版浏览器')
  context.save()
  try {
    context.globalAlpha = 1
    context.globalCompositeOperation = mask.inverted ? 'destination-out' : 'destination-in'
    context.filter = `blur(${blur}px)`
    context.fillStyle = '#ffffff'
    context.beginPath()
    const [a, b, c, d, e, f] = mask.transform
    context.transform(a * width, b * height, c * width, d * height, e * width, f * height)
    selectionPath(context, mask)
    context.fill()
  } finally { context.restore() }
}

/** A deformable layer keeps its mask fixed in layer coordinates. Applying a
 * hard mask before resampling would distort its edge and putImageData would
 * bypass the old canvas clip. Legacy non-deformed recipes retain their path. */
function applyLiquifyLayerMask(context: CanvasRenderingContext2D, mask: ImageLayerSelection, width: number, height: number): void {
  context.save()
  try {
    context.globalAlpha = 1; context.globalCompositeOperation = mask.inverted ? 'destination-out' : 'destination-in'; context.filter = 'none'; context.fillStyle = '#ffffff'
    context.beginPath()
    const [a, b, c, d, e, f] = mask.transform
    context.transform(a * width, b * height, c * width, d * height, e * width, f * height)
    selectionPath(context, mask)
    context.fill()
  } finally { context.restore() }
}

function strokePath(context: CanvasRenderingContext2D, stroke: ImageLayerStroke, width: number, height: number): void {
  context.scale(width / stroke.space.width, height / stroke.space.height)
  const first = stroke.points[0]
  const core = stroke.size * Math.max(0.05, stroke.hardness)
  context.lineWidth = core
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.fillStyle = context.strokeStyle = stroke.mode === 'erase' ? '#000000' : stroke.color
  context.beginPath()
  const x = first[0] * stroke.space.width / imageLayerPointScale, y = first[1] * stroke.space.height / imageLayerPointScale
  if (stroke.points.every((point) => point[0] === first[0] && point[1] === first[1])) {
    context.arc(x, y, core / 2, 0, Math.PI * 2)
    context.fill()
  } else {
    context.moveTo(x, y)
    for (let index = 1; index < stroke.points.length; index++) context.lineTo(stroke.points[index][0] * stroke.space.width / imageLayerPointScale, stroke.points[index][1] * stroke.space.height / imageLayerPointScale)
    context.stroke()
  }
}

function softStrokeBounds(context: CanvasRenderingContext2D, stroke: ImageLayerStroke, width: number, height: number) {
  const matrix = context.getTransform()
  const scale = Math.max(Math.hypot(matrix.a, matrix.b) * width / stroke.space.width, Math.hypot(matrix.c, matrix.d) * height / stroke.space.height)
  const blur = stroke.size * (1 - Math.max(0.05, stroke.hardness)) * scale / 6
  if (!Number.isFinite(scale) || stroke.size * scale > 16384 || blur > 512) throw new Error('笔迹缩放过大，请减小图层或画笔尺寸')
  const radius = stroke.size * scale / 2 + blur * 4 + 2
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (const point of stroke.points) {
    const x = point[0] * width / imageLayerPointScale, y = point[1] * height / imageLayerPointScale
    const px = matrix.a * x + matrix.c * y + matrix.e, py = matrix.b * x + matrix.d * y + matrix.f
    left = Math.min(left, px); top = Math.min(top, py); right = Math.max(right, px); bottom = Math.max(bottom, py)
  }
  left = Math.max(0, Math.floor(left - radius)); top = Math.max(0, Math.floor(top - radius))
  right = Math.min(context.canvas.width, Math.ceil(right + radius)); bottom = Math.min(context.canvas.height, Math.ceil(bottom + radius))
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top), matrix, blur }
}

function paintStroke(context: CanvasRenderingContext2D, stroke: ImageLayerStroke, width: number, height: number, scratch: () => HTMLCanvasElement): void {
  if (!stroke.opacity) return
  const diameter = stroke.size * Math.max(width / stroke.space.width, height / stroke.space.height)
  if (!Number.isFinite(diameter) || diameter > 16384 || diameter * (1 - Math.max(0.05, stroke.hardness)) / 6 > 512) throw new Error('笔迹缩放过大，请减小图层或画笔尺寸')
  const matrix = context.getTransform()
  const physicalDiameter = stroke.size * Math.max(Math.hypot(matrix.a, matrix.b) * width / stroke.space.width, Math.hypot(matrix.c, matrix.d) * height / stroke.space.height)
  if (!Number.isFinite(physicalDiameter) || physicalDiameter > 16384) throw new Error('笔迹缩放过大，请减小图层或画笔尺寸')
  context.save()
  try {
    // Clip AFTER constructing the soft brush on its isolated surface, so a
    // blurred stroke cannot leak outside the selection or permanent mask.
    if (stroke.selection && !stroke.selection.feather) clipSelection(context, stroke.selection, width, height)
    context.globalAlpha = stroke.opacity
    context.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over'
    if (stroke.hardness === 1 && !stroke.selection?.feather) { strokePath(context, stroke, width, height); return }
    const bounds = softStrokeBounds(context, stroke, width, height)
    if (!bounds.width || !bounds.height) return
    const surface = scratch()
    surface.width = bounds.width
    surface.height = bounds.height
      const brush = surface.getContext('2d', { alpha: true })
      if (!brush || !('filter' in brush)) throw new Error('当前浏览器不支持柔边画笔，请使用新版浏览器')
      brush.globalAlpha = 1; brush.globalCompositeOperation = 'source-over'
      const transform = bounds.matrix
      brush.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e - bounds.left, transform.f - bounds.top)
      // Three Gaussian standard deviations on either side fit within the
      // requested diameter; opacity is applied once to the whole stroke.
      brush.filter = `blur(${bounds.blur}px)`
      strokePath(brush, stroke, width, height)
      if (stroke.selection?.feather) {
        brush.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e - bounds.left, transform.f - bounds.top)
        applyImageLayerFeatherMask(brush, { mask: stroke.selection, width, height })
      }
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.drawImage(surface, bounds.left, bounds.top)
  } finally { context.restore() }
}

/** Only a stroke's bounded region is retained. Original pixels stay untouched
 * while tiles (including kernel halo) are computed, so later tiles cannot read
 * an already blurred neighbour. Cancellation never publishes a partial stroke. */
function* paintLocalFilter(context: CanvasRenderingContext2D, operation: ImageLayerFilterStroke, input: ImageLayerPaintInput, scratch: () => HTMLCanvasElement): Generator<void> {
  if (!operation.strength) return
  const { width, height } = input
  const brush: ImageLayerStroke = { ...operation, mode: 'paint', hardness: 1, opacity: 1, color: '#ffffff' }
  const bounds = softStrokeBounds(context, brush, width, height)
  if (!bounds.width || !bounds.height) return
  const matrix = bounds.matrix
  const radiusX = Math.min(layerFilterLimits.radius, Math.max(1, Math.round(operation.size / 12 * Math.hypot(matrix.a * width / operation.space.width, matrix.c * height / operation.space.height))))
  const radiusY = Math.min(layerFilterLimits.radius, Math.max(1, Math.round(operation.size / 12 * Math.hypot(matrix.b * width / operation.space.width, matrix.d * height / operation.space.height))))
  const result = document.createElement('canvas')
  result.width = bounds.width; result.height = bounds.height
  try {
    const output = result.getContext('2d', { alpha: true })
    if (!output) throw new Error('当前浏览器无法创建局部滤镜画布')
    const left = Math.max(0, bounds.left - radiusX), right = Math.min(context.canvas.width, bounds.left + bounds.width + radiusX)
    for (let row = bounds.top; row < bounds.top + bounds.height; row += 32) {
      checkPainting(input)
      const end = Math.min(bounds.top + bounds.height, row + 32), top = Math.max(0, row - radiusY), bottom = Math.min(context.canvas.height, end + radiusY)
      const surface = scratch(); surface.width = right - left; surface.height = bottom - top
      const mask = surface.getContext('2d', { alpha: true, willReadFrequently: true })
      if (!mask) throw new Error('当前浏览器无法创建滤镜笔覆盖区域')
      mask.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - left, matrix.f - top)
      mask.beginPath(); mask.rect(0, 0, width, height); mask.clip()
      if (input.layer.mask && !input.layer.mask.feather) clipSelection(mask, input.layer.mask, width, height)
      if (operation.selection && !operation.selection.feather) clipSelection(mask, operation.selection, width, height)
      mask.save(); strokePath(mask, brush, width, height); mask.restore()
      if (operation.selection?.feather) applyImageLayerFeatherMask(mask, { mask: operation.selection, width, height })
      const original = context.getImageData(left, top, surface.width, surface.height)
      const coverage = mask.getImageData(0, 0, surface.width, surface.height)
      for (const tile of rasterizeLayerFilterSteps({ data: original.data, coverage: coverage.data, width: surface.width, height: surface.height, radiusX, radiusY, mode: operation.mode, strength: operation.strength, signal: input.signal, deadline: input.deadline })) {
        const from = Math.max(row, top + tile.top), until = Math.min(end, top + tile.top + tile.height)
        if (until > from) {
          const image = output.createImageData(surface.width, until - from)
          image.data.set(tile.data.subarray((from - top - tile.top) * surface.width * 4, (until - top - tile.top) * surface.width * 4))
          output.putImageData(image, left - bounds.left, from - bounds.top)
        }
        yield
      }
    }
    checkPainting(input)
    // putImageData intentionally ignores the transform and clip. The coverage
    // already includes both selections; every other pixel is the original RGBA.
    for (let row = 0; row < bounds.height; row += 32) context.putImageData(output.getImageData(0, row, bounds.width, Math.min(32, bounds.height - row)), bounds.left, bounds.top + row)
  } finally { result.width = 0; result.height = 0 }
}

function paintFill(context: CanvasRenderingContext2D, operation: ImageLayerFill, width: number, height: number, scratch: () => HTMLCanvasElement): void {
  if (!operation.opacity) return
  context.save()
  try {
    context.globalAlpha = operation.opacity
    context.globalCompositeOperation = 'source-over'
    if (!operation.selection?.feather) {
      if (operation.selection) clipSelection(context, operation.selection, width, height)
      context.fillStyle = operation.color
      context.fillRect(0, 0, width, height)
      return
    }
    const surface = scratch(), matrix = context.getTransform()
    surface.width = context.canvas.width; surface.height = context.canvas.height
    const paint = surface.getContext('2d', { alpha: true })
    if (!paint) throw new Error('浏览器无法创建选区填充画布')
    if (!('filter' in paint)) throw new Error('当前浏览器不支持选区羽化，请使用新版浏览器')
    paint.globalAlpha = 1; paint.globalCompositeOperation = 'source-over'; paint.filter = 'none'
    paint.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f)
    paint.fillStyle = operation.color
    paint.fillRect(0, 0, width, height)
    applyImageLayerFeatherMask(paint, { mask: operation.selection, width, height })
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.drawImage(surface, 0, 0)
  } finally { context.restore() }
}

function gradientStyle(context: CanvasRenderingContext2D, operation: ImageLayerGradient, width: number, height: number): CanvasGradient {
  const gradient = context.createLinearGradient(operation.from[0] * width / imageLayerPointScale, operation.from[1] * height / imageLayerPointScale, operation.to[0] * width / imageLayerPointScale, operation.to[1] * height / imageLayerPointScale)
  gradient.addColorStop(0, operation.startColor)
  gradient.addColorStop(1, operation.endColor)
  return gradient
}

/** Stops are created under the same layer transform as the fill. A feathered
 * selection masks an isolated gradient once before its global opacity is applied.
 */
function paintGradient(context: CanvasRenderingContext2D, operation: ImageLayerGradient, width: number, height: number, scratch: () => HTMLCanvasElement): void {
  if (!operation.opacity) return
  context.save()
  try {
    context.globalAlpha = operation.opacity; context.globalCompositeOperation = 'source-over'
    if (!operation.selection?.feather) {
      if (operation.selection) clipSelection(context, operation.selection, width, height)
      context.fillStyle = gradientStyle(context, operation, width, height)
      context.fillRect(0, 0, width, height)
      return
    }
    const surface = scratch(), matrix = context.getTransform()
    surface.width = context.canvas.width; surface.height = context.canvas.height
    const paint = surface.getContext('2d', { alpha: true })
    if (!paint || !('filter' in paint)) throw new Error('当前浏览器不支持选区羽化，请使用新版浏览器')
    paint.globalAlpha = 1; paint.globalCompositeOperation = 'source-over'; paint.filter = 'none'
    paint.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f)
    paint.fillStyle = gradientStyle(paint, operation, width, height)
    paint.fillRect(0, 0, width, height)
    applyImageLayerFeatherMask(paint, { mask: operation.selection, width, height })
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.drawImage(surface, 0, 0)
  } finally { context.restore() }
}

/** Draw the selection once, including its complement, before deriving an alpha
 * border. Bands include a morphology halo: viewport edges are not selection edges.
 */
function* paintOutline(context: CanvasRenderingContext2D, operation: ImageLayerOutline, input: ImageLayerPaintInput, scratch: () => HTMLCanvasElement): Generator<void> {
  if (!operation.opacity) return
  input = { ...input, deadline: Math.min(input.deadline ?? Infinity, Date.now() + 10000) }
  const { width, height } = input, matrix = context.getTransform(), selection = operation.selection
  const physicalWidth = operation.width * Math.max(Math.hypot(matrix.a * width / operation.space.width, matrix.c * height / operation.space.height), Math.hypot(matrix.b * width / operation.space.width, matrix.d * height / operation.space.height))
  if (!Number.isFinite(physicalWidth) || physicalWidth <= 0 || physicalWidth > 512) throw new Error('描边缩放过大，请减小图层或描边宽度')
  const padding = Math.ceil(physicalWidth) + 2, surface = scratch()
  const rgba = operation.color.slice(1).match(/../g)?.map((channel) => parseInt(channel, 16))
  if (!rgba || (rgba.length !== 3 && rgba.length !== 4) || rgba.some((value) => !Number.isFinite(value))) throw new Error('描边颜色无效')
  context.save()
  try {
    context.globalAlpha = operation.opacity
    context.globalCompositeOperation = 'source-over'
    for (let top = 0; top < context.canvas.height; top += 256) {
      checkPainting(input)
      const rows = Math.min(256, context.canvas.height - top)
      surface.width = context.canvas.width + padding * 2; surface.height = rows + padding * 2
      const paint = surface.getContext('2d', { alpha: true })
      if (!paint) throw new Error('浏览器无法创建选区描边画布')
      const supportsFilter = 'filter' in paint
      if (selection.feather && !supportsFilter) throw new Error('当前浏览器不支持选区羽化，请使用新版浏览器')
      paint.globalAlpha = 1; if (supportsFilter) paint.filter = 'none'; paint.globalCompositeOperation = 'source-over'; paint.fillStyle = '#ffffff'
      if (selection.inverted) paint.fillRect(0, 0, surface.width, surface.height)
      paint.globalCompositeOperation = selection.inverted ? 'destination-out' : 'source-over'
      paint.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e + padding, matrix.f + padding - top)
      if (selection.feather) {
        const feather = selection.feather
        const blur = feather.radius * Math.max(width / feather.space.width, height / feather.space.height) * Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d))
        if (!Number.isFinite(blur) || blur > 512) throw new Error('选区羽化缩放过大，请减小图层或羽化半径')
        paint.filter = `blur(${blur}px)`
      }
      paint.beginPath()
      const [a, b, c, d, e, f] = selection.transform
      paint.transform(a * width, b * height, c * width, d * height, e * width, f * height)
      selectionPath(paint, selection)
      paint.fill()
      const pixels = paint.getImageData(0, 0, surface.width, surface.height), alpha = new Uint8ClampedArray(surface.width * surface.height)
      for (let index = 0; index < alpha.length; index++) {
        alpha[index] = pixels.data[index * 4 + 3]
        if (index % 16384 === 0) { checkPainting(input); yield }
      }
      const outline = yield* buildLayerRasterOutlineSteps({ width: surface.width, height: surface.height, alpha, widthPixels: physicalWidth, position: operation.position }, { signal: input.signal, maxMilliseconds: Math.min(10000, Math.max(1, input.deadline! - Date.now())) })
      for (let index = 0; index < outline.length; index++) {
        pixels.data[index * 4] = rgba[0]; pixels.data[index * 4 + 1] = rgba[1]; pixels.data[index * 4 + 2] = rgba[2]; pixels.data[index * 4 + 3] = outline[index] * (rgba[3] ?? 255) / 255
        if (index % 16384 === 0) { checkPainting(input); yield }
      }
      paint.putImageData(pixels, 0, 0)
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.drawImage(surface, padding, padding, context.canvas.width, rows, 0, top, context.canvas.width, rows)
      yield
    }
  } finally { context.restore() }
}

/** Paints one isolated layer in local coordinates, never onto the merged output.
 * The caller supplies its own bounded surface and transform (left/top origin).
 * No fetch, data URL, font URL or credential is accepted by this renderer.
 */
function* paintLiquify(context: CanvasRenderingContext2D, operation: ImageLayerLiquifyOperation, input: ImageLayerPaintInput): Generator<void> {
  const matrix = context.getTransform(), determinant = matrix.a * matrix.d - matrix.b * matrix.c
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('液化图层空间无法确认，请检查尺寸与缩放')
  const pixelToLayer = { a: matrix.d / determinant, b: -matrix.b / determinant, c: -matrix.c / determinant, d: matrix.a / determinant, e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant, f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant }
  const width = context.canvas.width, height = context.canvas.height, pixels = context.getImageData(0, 0, width, height)
  const iterator = rasterizeLayerLiquifySteps({ data: pixels.data, width, height, operation, pixelToLayer, layerWidth: input.width, layerHeight: input.height, signal: input.signal, deadline: input.deadline })
  let step = iterator.next()
  while (!step.done) { yield; checkPainting(input); step = iterator.next() }
  checkPainting(input)
  pixels.data.set(step.value)
  context.putImageData(pixels, 0, 0)
}

function* paintWholeFilter(context: CanvasRenderingContext2D, operation: ImageLayerWholeFilterOperation, input: ImageLayerPaintInput): Generator<void> {
  if (isNeutralWholeLayerFilter(operation.filter)) return
  const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height)
  const iterator = rasterizeWholeLayerFilterWorldSteps({ data: pixels.data, width: pixels.width, height: pixels.height, layerWidth: input.width, layerHeight: input.height, layerToPixel: context.getTransform(), operation, signal: input.signal, deadline: input.deadline })
  let step = iterator.next()
  while (!step.done) { yield; checkPainting(input); step = iterator.next() }
  checkPainting(input)
  pixels.data.set(step.value)
  context.putImageData(pixels, 0, 0)
}

function* imageLayerPaintSteps(context: CanvasRenderingContext2D, input: ImageLayerPaintInput, isolatedFilter = false, fullPresentation = false): Generator<void> {
  const { layer, source, width, height } = input
  const hasLiquify = layer.edits?.operations.some((operation) => operation.mode === 'liquify') === true
  const hasWholeFilter = layer.edits?.operations.some((operation) => operation.mode === 'whole-filter' && !isNeutralWholeLayerFilter(operation.filter)) === true
  assertPaintSurface(context, width, height)
  const nativeGradePreview = layer.colorGrade && !isNeutralImageLayerColorGrade(layer.colorGrade) && input.filterRaster && (input.filterRaster.scaleX !== 1 || input.filterRaster.scaleY !== 1)
  if (!isolatedFilter && (fullPresentation || hasWholeFilter || nativeGradePreview || layer.edits?.operations.some((operation) => operation.mode === 'blur' || operation.mode === 'sharpen' || operation.mode === 'liquify'))) {
    const raster = input.filterRaster ?? { width: context.canvas.width, height: context.canvas.height, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 }
    assertLayerFilterSize(raster.width, raster.height)
    if (![raster.scaleX, raster.scaleY].every((value) => Number.isFinite(value) && value > 0 && value <= 1) || ![raster.offsetX, raster.offsetY].every(Number.isFinite)) throw new Error('局部滤镜预览映射无效')
    const originalMatrix = context.getTransform()
    const nativeMatrix = { a: originalMatrix.a / raster.scaleX, b: originalMatrix.b / raster.scaleY, c: originalMatrix.c / raster.scaleX, d: originalMatrix.d / raster.scaleY, e: (originalMatrix.e - raster.offsetX) / raster.scaleX, f: (originalMatrix.f - raster.offsetY) / raster.scaleY }
    let left = 0, top = 0, nativeWidth = raster.width, nativeHeight = raster.height
    if (hasWholeFilter || fullPresentation) {
      const points = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => ({ x: nativeMatrix.a * x + nativeMatrix.c * y + nativeMatrix.e, y: nativeMatrix.b * x + nativeMatrix.d * y + nativeMatrix.f }))
      left = Math.floor(Math.min(...points.map((point) => point.x))) - 2
      top = Math.floor(Math.min(...points.map((point) => point.y))) - 2
      nativeWidth = Math.ceil(Math.max(...points.map((point) => point.x))) + 2 - left
      nativeHeight = Math.ceil(Math.max(...points.map((point) => point.y))) + 2 - top
      assertLayerFilterSize(nativeWidth, nativeHeight)
    }
    const local = document.createElement('canvas'); local.width = nativeWidth; local.height = nativeHeight
    try {
      const paint = local.getContext('2d', { alpha: true, willReadFrequently: true })
      if (!paint) throw new Error('当前浏览器无法创建局部滤镜图层')
      if (fullPresentation && !layer.content && !layer.edits && !layer.mask && (!layer.colorGrade || isNeutralImageLayerColorGrade(layer.colorGrade))) {
        paint.imageSmoothingEnabled = context.imageSmoothingEnabled; paint.imageSmoothingQuality = context.imageSmoothingQuality
      }
      // Retain the original OUTPUT transform. A new filter must not rotate a
      // prior outline kernel or resample untouched pixels in layer-local space.
      paint.setTransform(nativeMatrix.a, nativeMatrix.b, nativeMatrix.c, nativeMatrix.d, nativeMatrix.e - left, nativeMatrix.f - top)
      yield* imageLayerPaintSteps(paint, { ...input, filterRaster: undefined }, true)
      checkPainting(input)
      context.save()
      try {
        context.setTransform(1, 0, 0, 1, 0, 0)
        context.drawImage(local, 0, 0, nativeWidth, nativeHeight, raster.offsetX + left * raster.scaleX, raster.offsetY + top * raster.scaleY, nativeWidth * raster.scaleX, nativeHeight * raster.scaleY)
      } finally { context.restore() }
    } finally { local.width = 0; local.height = 0 }
    return
  }
  let surface: HTMLCanvasElement | undefined
  function scratch(): HTMLCanvasElement { return surface ??= document.createElement('canvas') }
  context.save()
  try {
    context.beginPath()
    context.rect(0, 0, width, height)
    context.clip()
    if (layer.mask && !layer.mask.feather && !hasLiquify && !hasWholeFilter) clipSelection(context, layer.mask, width, height)
    context.save()
    try {
      if (layer.content) {
        context.translate(width / 2, height / 2)
        if (layer.content.kind === 'text' && layer.content.typography) yield* paintImageLayerTypography(context, layer.content, input)
        else paintImageLayerContent(context, layer.content, width, height)
      } else {
        if (!source) throw new Error('图层来源图片不可用，请重新选择素材')
        context.drawImage(source, 0, 0, width, height)
      }
    } finally { context.restore() }
    for (const stroke of layer.edits?.operations ?? []) {
      checkPainting(input)
      if (stroke.mode === 'fill') paintFill(context, stroke, width, height, scratch)
      else if (stroke.mode === 'gradient') paintGradient(context, stroke, width, height, scratch)
      else if (stroke.mode === 'outline') yield* paintOutline(context, stroke, input, scratch)
      else if (stroke.mode === 'blur' || stroke.mode === 'sharpen') yield* paintLocalFilter(context, stroke, input, scratch)
      else if (stroke.mode === 'liquify') yield* paintLiquify(context, stroke, input)
      else if (stroke.mode === 'whole-filter') yield* paintWholeFilter(context, stroke, input)
      else if (stroke.mode === 'paint' || stroke.mode === 'erase') paintStroke(context, stroke, width, height, scratch)
      yield
    }
    checkPainting(input)
    if ((hasLiquify || hasWholeFilter) && layer.mask && !layer.mask.feather) applyLiquifyLayerMask(context, layer.mask, width, height)
    if (layer.mask?.feather && !input.deferFeatherMask) applyImageLayerFeatherMask(context, { mask: layer.mask, width, height })
  } finally { context.restore(); if (surface) { surface.width = 0; surface.height = 0 } }
  if (layer.colorGrade && !isNeutralImageLayerColorGrade(layer.colorGrade)) {
    // The isolated native surface is graded BEFORE preview downsampling. This
    // keeps point curves, vignette and seeded grain independent of thumbnail size.
    const pixelWidth = context.canvas.width, pixelHeight = context.canvas.height
    const matrix = context.getTransform(), determinant = matrix.a * matrix.d - matrix.b * matrix.c
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('图层调整空间无法确认，请检查缩放参数')
    const pixelToLayer = { a: matrix.d / determinant, b: -matrix.b / determinant, c: -matrix.c / determinant, d: matrix.a / determinant, e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant, f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant }
    const rasterize = createLayerColorGradeRasterizer(layer.colorGrade, { lutTable: input.lutTable, signal: input.signal, deadline: input.deadline })
    if (layer.colorGrade.detail && !isNeutralImageLayerColorDetail(layer.colorGrade.detail) || layer.colorGrade.presence && !isNeutralImageLayerColorPresence(layer.colorGrade.presence)) {
      // A spatial kernel must read immutable full native pixels. Reading and
      // writing successive 16-row strips would make every strip edge a seam.
      checkPainting(input)
      const pixels = context.getImageData(0, 0, pixelWidth, pixelHeight)
      for (const tile of rasterize.steps({ data: pixels.data, width: pixelWidth, height: pixelHeight, spaceWidth: width, spaceHeight: height, pixelToLayer, signal: input.signal, deadline: input.deadline })) {
        const output = context.createImageData(pixelWidth, tile.height)
        output.data.set(tile.data)
        context.putImageData(output, 0, tile.top)
        yield
      }
      return
    }
    for (let top = 0; top < pixelHeight; top += 16) {
      checkPainting(input)
      const rows = Math.min(16, pixelHeight - top), pixels = context.getImageData(0, top, pixelWidth, rows)
      for (const tile of rasterize.steps({ data: pixels.data, width: pixelWidth, height: rows, originY: top, spaceWidth: width, spaceHeight: height, pixelToLayer, signal: input.signal, deadline: input.deadline })) {
        pixels.data.set(tile.data, tile.top * pixelWidth * 4)
      }
      context.putImageData(pixels, 0, top)
      yield
    }
  }
}

function checkPainting(input: ImageLayerPaintInput): void {
  if (input.signal?.aborted) { const error = new Error('已取消图像处理，当前画布没有改变'); error.name = 'AbortError'; throw error }
  if (input.deadline !== undefined && Date.now() >= input.deadline) throw new Error('图像处理等待超时，请减少笔迹数量或缩小输出尺寸')
}

export function paintImageLayerLocal(context: CanvasRenderingContext2D, input: ImageLayerPaintInput): void {
  if (input.deadline === undefined && (input.layer.colorGrade || input.layer.edits?.operations.some((operation) => ['outline', 'blur', 'sharpen', 'liquify', 'whole-filter'].includes(operation.mode)) || input.layer.content?.kind === 'text' && input.layer.content.typography)) input = { ...input, deadline: Date.now() + 2000 }
  checkPainting(input)
  for (const _step of imageLayerPaintSteps(context, input)) { /* The interactive preview intentionally paints synchronously. */ }
}

/** Export yields between small batches so cancellation can interrupt long recipes. */
export async function paintImageLayerLocalAsync(context: CanvasRenderingContext2D, input: ImageLayerPaintInput): Promise<void> {
  checkPainting(input)
  let count = 0
  for (const _step of imageLayerPaintSteps(context, input)) {
    if (++count % (input.layer.colorGrade && !isNeutralImageLayerColorGrade(input.layer.colorGrade) ? 1 : 4) === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    checkPainting(input)
  }
}

/** Presentation-only extension. Canonical callers never pass this flag: their
 * finite blur/liquify kernel domain remains the original document surface.
 * The workbench later replaces that authoritative region with canonical pixels.
 */
export async function paintImageLayerFullWorldFrameAsync(context: CanvasRenderingContext2D, input: { layer: ImageLayer; source?: CanvasImageSource; lutTable?: ColorLutTable; output: { width: number; height: number }; presentation: LayerFilterPresentationFrame; signal?: AbortSignal; deadline: number }): Promise<void> {
  const { layer, presentation: frame } = input, width = layer.width * input.output.width, height = layer.height * input.output.height
  assertLayerFilterSize(context.canvas.width, context.canvas.height)
  if (context.canvas.width !== frame.worldBounds.width || context.canvas.height !== frame.worldBounds.height) throw new Error('完整图层预览画布与展示范围不一致')
  const m = frame.layerToWorld, paintInput = { layer, source: input.source, lutTable: input.lutTable, width, height, signal: input.signal, deadline: input.deadline }
  checkPainting(paintInput)
  context.save()
  try {
    context.globalAlpha = 1; context.globalCompositeOperation = 'source-over'
    context.setTransform(m.a * frame.width / width, m.b * frame.width / width, m.c * frame.height / height, m.d * frame.height / height, m.e - frame.worldBounds.x, m.f - frame.worldBounds.y)
    let count = 0
    for (const _step of imageLayerPaintSteps(context, paintInput, false, true)) {
      if (++count % 4 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
      checkPainting(paintInput)
    }
  } finally { context.restore() }
}
