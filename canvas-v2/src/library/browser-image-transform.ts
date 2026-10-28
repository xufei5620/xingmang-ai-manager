import { paintImageCollageCell, paintImageCollageWatermark } from './image-collage-painter'
import { generatedImageInfo, maximumGeneratedImageBytes } from '../lib/generation-protocol'
import { isNeutralImageLayerColorGrade } from '../image-tools/layer-color-grade'
import { imageTransformRecipeNeedsSources, maximumImageTransformEdge, maximumImageTransformInputs, maximumImageTransformTotalPixels, parseImageTransformRecipe, type ImageCollageWatermark, type ImageLayerRecipe, type ImageTransformRecipe } from '../image-tools/recipe'
import { imageLayerCanvasFilter as layerFilter, paintImageLayerContent, paintImageLayerLocalAsync, paintImageLayerFullWorldFrameAsync } from './image-layer-painter'
import { assertLayerFilterPresentationBudget, buildLayerFilterPresentationFrame } from '../image-tools/layer-filter-presentation'
import { prepareLocalTextFont } from '../image-tools/local-text-fonts'
import { buildImageTransformFrames, type ImageTransformDraw, type ImageTransformFrame, type ImageTransformRect, type ImageTransformSize } from '../image-tools/geometry'
import { getPreparedColorLutTable, snapshotLayerColorLutTables, type PreparedColorLutTables } from '../image-tools/layer-color-lut-runtime'
import { materializeImageLayerGroups } from '../image-tools/layer-group-model'

export const maximumImageTransformSourceBytes = maximumGeneratedImageBytes
export const maximumImageTransformTotalBytes = 64 * 1024 * 1024
const transformTimeoutMs = 45_000

function parseRenderRecipe(value: unknown): ImageTransformRecipe {
  const parsed = parseImageTransformRecipe(value)
  return parsed.kind === 'layer' ? materializeImageLayerGroups(parsed) : parsed
}

export interface BrowserImageTransformOutput extends ImageTransformSize { blob: Blob }
export interface BrowserImageTransformInput {
  sources: Blob[]
  recipe: ImageTransformRecipe
  signal?: AbortSignal
  lutTables?: PreparedColorLutTables
  /** Optional host constraint, checked against oriented decoded pixels before drawing. */
  expectedSourceSizes?: readonly ImageTransformSize[]
}
export interface BrowserImageTransformBitmap extends ImageTransformSize { close(): void }
export interface BrowserLayerDrawOptions { signal?: AbortSignal; deadline?: number; lutTables?: PreparedColorLutTables }
export interface BrowserImageTransformCanvas {
  fill(background: string): void
  draw(bitmap: BrowserImageTransformBitmap | undefined, command: ImageTransformDraw, options?: BrowserLayerDrawOptions): void | Promise<void>
  watermark?(value: ImageCollageWatermark): void
  encodePNG(): Promise<Blob>
  dispose(): void
}
/** Browser primitive seam. Tests retain the real validation, geometry and cancellation paths. */
export interface BrowserImageTransformPlatform {
  decode(blob: Blob): Promise<BrowserImageTransformBitmap>
  createCanvas(width: number, height: number, documentFrame?: ImageTransformFrame['documentFrame']): BrowserImageTransformCanvas
}

function abortError(): Error { const error = new Error('已取消图像处理，当前画布没有改变'); error.name = 'AbortError'; return error }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortError() }
function closeBitmap(bitmap: BrowserImageTransformBitmap): void { try { bitmap.close() } catch { /* Releasing one decoder must not prevent releasing the rest. */ } }

function waitFor<T>(pending: Promise<T>, signal: AbortSignal | undefined, deadline: number, discard?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    function fail(error: Error) { if (settled) return; settled = true; cleanup(); reject(error) }
    function abort() { fail(abortError()) }
    const remaining = deadline - Date.now()
    const timer = setTimeout(() => fail(new Error('图像处理等待超时，请减少图片数量或尺寸后重试')), Math.max(0, remaining))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    else if (remaining <= 0) fail(new Error('图像处理等待超时，请减少图片数量或尺寸后重试'))
    void pending.then((result) => {
      if (settled) { discard?.(result); return }
      settled = true; cleanup(); resolve(result)
    }, (error: unknown) => fail(error instanceof Error ? error : new Error('图片处理失败，请检查输入图片后重试')))
  })
}

function animatedImage(bytes: Uint8Array, mimeType: string): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mimeType === 'image/webp') return String.fromCharCode(...bytes.slice(12, 16)) === 'VP8X' && Boolean(bytes[20] & 2)
  if (mimeType !== 'image/png') return false
  for (let offset = 8; offset + 12 <= bytes.length;) {
    if (String.fromCharCode(...bytes.slice(offset + 4, offset + 8)) === 'acTL') return true
    offset += view.getUint32(offset) + 12
  }
  return false
}

async function inspectSource(blob: Blob, signal: AbortSignal | undefined, deadline: number): Promise<ImageTransformSize> {
  checkAbort(signal)
  const buffer = await waitFor(blob.arrayBuffer(), signal, deadline)
  checkAbort(signal)
  const bytes = new Uint8Array(buffer)
  let info: ReturnType<typeof generatedImageInfo>
  try { info = generatedImageInfo(bytes, maximumImageTransformSourceBytes) }
  catch { throw new Error('输入图片结构或尺寸无效，请选择完整的 PNG、JPEG 或 WebP 图片') }
  if (blob.type && blob.type !== info.mimeType) throw new Error('图片声明的格式与实际文件不一致，请重新导出素材')
  if (animatedImage(bytes, info.mimeType)) throw new Error('图像工具目前处理静态图片，请先将动画导出为静态图片')
  return { width: info.width, height: info.height }
}

/** No URLs, credentials or remote reads enter this processor: the host supplies owned image blobs. */
export function createBrowserImageTransformer(platform: BrowserImageTransformPlatform) {
  return async function process(input: BrowserImageTransformInput): Promise<BrowserImageTransformOutput[]> {
    const signal = input.signal
    checkAbort(signal)
    const recipe = parseRenderRecipe(input.recipe)
    const deadline = Date.now() + transformTimeoutMs
    const lutTables = recipe.kind === 'layer' ? snapshotLayerColorLutTables(recipe, input.lutTables, { signal, deadline }) : undefined
    const sources = Array.isArray(input.sources) ? [...input.sources] : []
    if (input.expectedSourceSizes !== undefined && (!Array.isArray(input.expectedSourceSizes) || input.expectedSourceSizes.length !== sources.length
      || input.expectedSourceSizes.some((size) => !size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1 || size.width > maximumImageTransformEdge || size.height > maximumImageTransformEdge))) throw new Error('原图尺寸约束无效，请重新打开标注')
    const expectedSourceSizes = input.expectedSourceSizes?.map((size) => ({ width: size.width, height: size.height }))
    if ((!sources.length && imageTransformRecipeNeedsSources(recipe)) || sources.length > maximumImageTransformInputs
      || sources.some((blob) => !(blob instanceof Blob) || blob.size < 1 || blob.size > maximumImageTransformSourceBytes || (blob.type !== '' && !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)))
      || sources.reduce((sum, blob) => sum + blob.size, 0) > maximumImageTransformTotalBytes) throw new Error('最多支持 20 张 PNG、JPEG 或 WebP 图片，单张不超过 20 MB，总计不超过 64 MB；纯文字、形状或绘画图层可不选图片')
    const headers: ImageTransformSize[] = []
    let sourcePixels = 0
    // Validate every container before invoking a decoder, including later inputs in a collage.
    for (const source of sources) {
      const dimensions = await inspectSource(source, signal, deadline)
      sourcePixels += dimensions.width * dimensions.height
      if (sourcePixels > maximumImageTransformTotalPixels) throw new Error('输入图片的总像素超过 33554432，请减少数量或缩小图片')
      headers.push(dimensions)
    }
    const bitmaps: BrowserImageTransformBitmap[] = []
    const outputs: BrowserImageTransformOutput[] = []
    let outputBytes = 0
    try {
      for (let index = 0; index < sources.length; index++) {
        checkAbort(signal)
        let bitmap: BrowserImageTransformBitmap
        try { bitmap = await waitFor(platform.decode(sources[index]), signal, deadline, closeBitmap) }
        catch (error) {
          if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('等待超时'))) throw error
          throw new Error('浏览器无法解码输入图片，请重新导出 PNG、JPEG 或 WebP 后重试')
        }
        bitmaps.push(bitmap)
        const expected = headers[index]
        // EXIF orientation can transpose dimensions; no other decoder size change is accepted.
        if (!((bitmap.width === expected.width && bitmap.height === expected.height) || (bitmap.width === expected.height && bitmap.height === expected.width))) throw new Error('图片解码后的尺寸与文件信息不一致，已停止处理')
        const required = expectedSourceSizes?.[index]
        if (required && (bitmap.width !== required.width || bitmap.height !== required.height)) throw new Error('原图的实际尺寸已变化，请重新打开标注')
      }
      const frames = buildImageTransformFrames(bitmaps, recipe)
      for (const frame of frames) {
        checkAbort(signal)
        const canvas = platform.createCanvas(frame.width, frame.height, frame.documentFrame)
        try {
          canvas.fill(frame.background)
          for (const command of frame.draws) { checkAbort(signal); await canvas.draw(bitmaps[command.sourceIndex], command, { signal, deadline, lutTables }) }
          if (frame.watermark) {
            checkAbort(signal)
            if (!canvas.watermark) throw new Error('当前图像处理环境不支持拼图水印')
            canvas.watermark(frame.watermark)
          }
          checkAbort(signal)
          const blob = await waitFor(canvas.encodePNG(), signal, deadline)
          checkAbort(signal)
          if (!(blob instanceof Blob) || blob.type !== 'image/png' || !blob.size || blob.size > maximumGeneratedImageBytes) throw new Error('处理结果不是有效的 PNG 或超过 20 MB，请缩小输出尺寸')
          outputBytes += blob.size
          if (outputBytes > maximumImageTransformTotalBytes) throw new Error('处理后的图片总容量超过 64 MB，请减少数量或缩小输出尺寸')
          const bytes = new Uint8Array(await waitFor(blob.arrayBuffer(), signal, deadline))
          let encoded: ReturnType<typeof generatedImageInfo>
          try { encoded = generatedImageInfo(bytes) }
          catch { throw new Error('浏览器返回的 PNG 图片结构无效，未保存处理结果') }
          if (encoded.mimeType !== 'image/png' || encoded.width !== frame.width || encoded.height !== frame.height) throw new Error('处理结果的实际尺寸与画布不一致，未保存图片')
          outputs.push({ blob, width: frame.width, height: frame.height })
        } finally { canvas.dispose() }
      }
      checkAbort(signal)
      return outputs
    } finally { for (const bitmap of bitmaps) closeBitmap(bitmap) }
  }
}

function transformLayer(context: CanvasRenderingContext2D, command: ImageTransformDraw): void {
  const destination = command.destination
  context.translate(destination.x + destination.width / 2, destination.y + destination.height / 2)
  context.scale(command.flipX ? -1 : 1, command.flipY ? -1 : 1)
  context.rotate(command.rotation * Math.PI / 180)
}

async function drawLayerContent(context: CanvasRenderingContext2D, command: ImageTransformDraw, width: number, height: number, bitmap?: CanvasImageSource, options?: BrowserLayerDrawOptions): Promise<void> {
  const text = command.content?.kind === 'text' ? command.content : undefined
  if (text?.typography?.fontFamily) {
    checkAbort(options?.signal)
    await waitFor(prepareLocalTextFont(text.typography.fontFamily, text.typography.fontWeight ?? text.fontWeight), options?.signal, options?.deadline ?? Date.now() + transformTimeoutMs)
    checkAbort(options?.signal)
    if (options?.deadline && Date.now() >= options.deadline) throw new Error('文字字体准备超时，请重试')
  }
  // A content layer is composited once. Applying opacity/filter/blend to each
  // fill and stroke separately changes overlapping pixels and multiline text.
  // Keep the same finite blur halo as the preview before clipping the output.
  // Otherwise an off-canvas layer loses pixels that should blur back into view.
  // At the maximum blur/output this is 4356² pixels (< 19 million), regardless
  // of the potentially much larger logical layer rectangle.
  const padding = command.adjustments?.blur ? Math.ceil(command.adjustments.blur * 4) + 2 : 0
  const surface = document.createElement('canvas')
  surface.width = width + padding * 2
  surface.height = height + padding * 2
  try {
    const paint = surface.getContext('2d', { alpha: true })
    if (!paint) throw new Error('浏览器无法创建图层绘制画布')
    if (padding) paint.translate(padding, padding)
    transformLayer(paint, command)
    if (command.colorGrade && !isNeutralImageLayerColorGrade(command.colorGrade) || command.edits || command.mask || command.content?.kind === 'paint' || command.content?.kind === 'path' || text?.typography) {
      paint.translate(-command.destination.width / 2, -command.destination.height / 2)
      await paintImageLayerLocalAsync(paint, { layer: command, ...(bitmap ? { source: bitmap } : {}), width: command.destination.width, height: command.destination.height, signal: options?.signal, deadline: options?.deadline, lutTable: getPreparedColorLutTable(command.colorGrade?.lut, options?.lutTables) })
    } else if (command.content) paintImageLayerContent(paint, command.content, command.destination.width, command.destination.height)
    context.drawImage(surface, -padding, -padding)
  } finally { surface.width = 0; surface.height = 0 }
}

async function drawNativeLayer(context: CanvasRenderingContext2D, command: ImageTransformDraw, width: number, height: number, bitmap?: CanvasImageSource, options?: BrowserLayerDrawOptions): Promise<void> {
  if (command.collageCell) {
    if (!bitmap) throw new Error('拼图来源图片不可用，请重新选择素材')
    paintImageCollageCell(context, bitmap, command, { width, height }); return
  }
  const destination = command.destination
  context.save()
  try {
    context.globalAlpha = command.opacity
    context.globalCompositeOperation = command.blend
    const filter = layerFilter(command.adjustments)
    if (filter) {
      if (!('filter' in context)) throw new Error('当前浏览器不支持图层滤镜，请使用新版浏览器')
      context.filter = filter
    }
    if (command.colorGrade && !isNeutralImageLayerColorGrade(command.colorGrade) || command.content || command.edits || command.mask) { await drawLayerContent(context, command, width, height, bitmap, options); return }
    if (!bitmap) throw new Error('图层来源图片不可用，请重新选择素材')
    transformLayer(context, command)
    const source = command.source
    context.drawImage(bitmap, source.x, source.y, source.width, source.height, -destination.width / 2, -destination.height / 2, destination.width, destination.height)
  } finally { context.restore() }
}

function replayCommand(command: ImageTransformDraw, frame?: ImageTransformFrame['documentFrame']): ImageTransformDraw {
  return frame ? { ...command, destination: { ...command.destination, x: command.destination.x + frame.offsetX, y: command.destination.y + frame.offsetY } } : command
}

function createTransformCanvas(width: number, height: number, documentFrame?: ImageTransformFrame['documentFrame']): BrowserImageTransformCanvas {
  const canvas = document.createElement('canvas')
  let visibleCanvas: HTMLCanvasElement | null = null
  canvas.width = documentFrame?.width ?? width
  canvas.height = documentFrame?.height ?? height
  const context = canvas.getContext('2d', { alpha: true })
  if (!context) { canvas.width = 0; canvas.height = 0; throw new Error('浏览器无法创建图像处理画布') }
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  return {
    fill(background) { if (background !== 'transparent') { context.fillStyle = background; context.fillRect(0, 0, canvas.width, canvas.height) } },
    draw(bitmap, command, options) { return drawNativeLayer(context, replayCommand(command, documentFrame), canvas.width, canvas.height, bitmap as ImageBitmap | undefined, options) },
    watermark(value) { paintImageCollageWatermark(context, { width, height }, value) },
    encodePNG() {
      if (!documentFrame) return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('浏览器未能编码 PNG 图片')), 'image/png'))
      const visible = document.createElement('canvas'); visibleCanvas = visible; visible.width = width; visible.height = height
      const output = visible.getContext('2d', { alpha: true })
      if (!output) { visible.width = 0; visible.height = 0; visibleCanvas = null; return Promise.reject(new Error('浏览器无法创建裁剪输出画布')) }
      // Composite first in the original raster domain, then copy whole pixels.
      // Per-layer crop intermediates would change resampling and alpha rounding.
      output.drawImage(canvas, -documentFrame.offsetX, -documentFrame.offsetY)
      return new Promise((resolve, reject) => visible.toBlob((blob) => {
        visible.width = 0; visible.height = 0
        if (visibleCanvas === visible) visibleCanvas = null
        if (blob) resolve(blob); else reject(new Error('浏览器未能编码裁剪 PNG 图片'))
      }, 'image/png'))
    },
    dispose() { canvas.width = 0; canvas.height = 0; if (visibleCanvas) { visibleCanvas.width = 0; visibleCanvas.height = 0; visibleCanvas = null } },
  }
}

export interface BrowserImageLayerColorInput {
  recipe: ImageLayerRecipe
  sources: Array<{ image: CanvasImageSource; width: number; height: number }>
  point: { x: number; y: number }
  signal?: AbortSignal
  lutTables?: PreparedColorLutTables
}

export interface BrowserImageLayerPixelsInput {
  recipe: ImageLayerRecipe
  sources: BrowserImageLayerColorInput['sources']
  source: 'composite' | 'current'
  /** Index in the supplied recipe, before any visibility filtering. */
  layerIndex?: number
  /** Integer output-pixel rectangle; omission reads the complete native output. */
  region?: ImageTransformRect
  signal?: AbortSignal
  lutTables?: PreparedColorLutTables
}

/** Shared native-resolution input for selection algorithms. Current-layer reads
 * keep its visibility, opacity, masks and filters on transparent background.
 * Reading a region never changes the export origin or browser filter surface.
 */
export async function sampleBrowserImageLayerPixels(input: BrowserImageLayerPixelsInput): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  checkAbort(input.signal)
  const deadline = Date.now() + transformTimeoutMs
  const parsed = parseRenderRecipe(input.recipe)
  if (parsed.kind !== 'layer' || (input.source !== 'composite' && input.source !== 'current')) throw new Error('像素选区取样来源无效')
  const sources = input.sources.map((source) => ({ ...source }))
  let recipe = parsed
  if (input.source === 'current') {
    const layers = recipe.layers.length || recipe.explicitLayers ? recipe.layers : sources.map((_, sourceIndex) => ({ sourceIndex, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over' as const, visible: true }))
    if (!Number.isInteger(input.layerIndex) || input.layerIndex === undefined || !layers[input.layerIndex]) throw new Error('请先选择需要取样的图层')
    recipe = { ...recipe, layers: [layers[input.layerIndex]], explicitLayers: true, background: 'transparent' }
  }
  const lutTables = snapshotLayerColorLutTables(recipe, input.lutTables, { signal: input.signal, deadline })
  const frame = buildImageTransformFrames(sources, recipe)[0]
  const region = input.region ?? { x: 0, y: 0, width: frame.width, height: frame.height }
  if (![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 || region.x + region.width > frame.width || region.y + region.height > frame.height) throw new Error('像素取样区域必须位于输出画布内')
  const canvas = document.createElement('canvas')
  canvas.width = frame.documentFrame?.width ?? frame.width; canvas.height = frame.documentFrame?.height ?? frame.height
  try {
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) throw new Error('当前浏览器无法读取画布像素')
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'
    if (frame.background !== 'transparent') { context.fillStyle = frame.background; context.fillRect(0, 0, canvas.width, canvas.height) }
    for (const command of frame.draws) {
      checkAbort(input.signal)
      if (Date.now() >= deadline) throw new Error('像素取样等待超时，请减少图层或笔迹后重试')
      await drawNativeLayer(context, replayCommand(command, frame.documentFrame), canvas.width, canvas.height, sources[command.sourceIndex]?.image, { signal: input.signal, deadline, lutTables })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    checkAbort(input.signal)
    if (Date.now() >= deadline) throw new Error('像素取样等待超时，请减少图层或笔迹后重试')
    let data: Uint8ClampedArray
    try { data = context.getImageData(region.x + (frame.documentFrame?.offsetX ?? 0), region.y + (frame.documentFrame?.offsetY ?? 0), region.width, region.height).data }
    catch { throw new Error('当前素材不能安全读取像素，请使用本账号上传的图片后重试') }
    return { width: region.width, height: region.height, data }
  } finally { canvas.width = 0; canvas.height = 0 }
}

/** Reads an output-resolution merged pixel, never the downsampled SVG preview.
 * Sources are already-owned decoded images; this helper performs no network,
 * encoding, upload or ownership change and releases all temporary surfaces.
 */
export async function sampleBrowserImageLayerColor(input: BrowserImageLayerColorInput): Promise<string> {
  checkAbort(input.signal)
  const deadline = Date.now() + transformTimeoutMs
  const recipe = parseRenderRecipe(input.recipe)
  if (recipe.kind !== 'layer' || !Number.isFinite(input.point.x) || !Number.isFinite(input.point.y)
    || input.point.x < 0 || input.point.y < 0 || input.point.x >= recipe.outputWidth || input.point.y >= recipe.outputHeight) throw new Error('请在画布范围内取色')
  const sources = input.sources.map((source) => ({ ...source }))
  const lutTables = snapshotLayerColorLutTables(recipe, input.lutTables, { signal: input.signal, deadline })
  const frame = buildImageTransformFrames(sources, recipe)[0]
  const point = { x: Math.floor(input.point.x), y: Math.floor(input.point.y) }
  // A cropped viewport changes browser filter/antialias rasterization, even
  // with a Gaussian halo. Keep the export surface and origin for every layer.
  // A background-only canvas has no kernels or edges and needs just one pixel.
  const width = frame.draws.length ? frame.documentFrame?.width ?? frame.width : 1, height = frame.draws.length ? frame.documentFrame?.height ?? frame.height : 1
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  try {
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) throw new Error('当前浏览器无法读取画布颜色')
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'
    if (frame.background !== 'transparent') { context.fillStyle = frame.background; context.fillRect(0, 0, width, height) }
    for (const command of frame.draws) {
      checkAbort(input.signal)
      if (Date.now() >= deadline) throw new Error('画布取色等待超时，请减少图层或笔迹后重试')
      await drawNativeLayer(context, replayCommand(command, frame.documentFrame), width, height, sources[command.sourceIndex]?.image, { signal: input.signal, deadline, lutTables })
      // Even simple layers yield so closing the dialog can cancel a large stack.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    checkAbort(input.signal)
    if (Date.now() >= deadline) throw new Error('画布取色等待超时，请减少图层或笔迹后重试')
    let pixel: Uint8ClampedArray
    try { pixel = context.getImageData(frame.draws.length ? point.x + (frame.documentFrame?.offsetX ?? 0) : 0, frame.draws.length ? point.y + (frame.documentFrame?.offsetY ?? 0) : 0, 1, 1).data }
    catch { throw new Error('当前素材不能安全取色，请使用本账号上传的图片后重试') }
    return `#${Array.from(pixel.slice(0, 4), (channel) => channel.toString(16).padStart(2, '0')).join('')}`
  } finally { canvas.width = 0; canvas.height = 0 }
}

/** A cropped layer preview uses the same original replay domain as export and
 * sampling. Downsampling happens only after all native-pixel kernels complete;
 * rendering kernels directly in the smaller crop loses neighbouring pixels. */
export async function paintBrowserImageLayerDocumentPreview(context: CanvasRenderingContext2D, input: Pick<BrowserImageLayerColorInput, 'recipe' | 'sources' | 'signal' | 'lutTables'>): Promise<void> {
  checkAbort(input.signal)
  const deadline = Date.now() + transformTimeoutMs
  const recipe = parseRenderRecipe(input.recipe)
  if (recipe.kind !== 'layer' || !recipe.documentFrame) throw new Error('裁剪预览缺少原始画布范围')
  const lutTables = snapshotLayerColorLutTables(recipe, input.lutTables, { signal: input.signal, deadline })
  const target = context.canvas
  if (![target.width, target.height].every((value) => Number.isInteger(value) && value >= 1 && value <= 1024) || target.width * target.height > 1_048_576 || target.width > recipe.outputWidth || target.height > recipe.outputHeight) throw new Error('图层预览尺寸超过安全容量')
  const sources = input.sources.map((source) => ({ ...source })), frame = buildImageTransformFrames(sources, recipe)[0]
  const surface = document.createElement('canvas')
  surface.width = frame.documentFrame?.width ?? frame.width; surface.height = frame.documentFrame?.height ?? frame.height
  try {
    const paint = surface.getContext('2d', { alpha: true })
    if (!paint) throw new Error('当前浏览器无法显示裁剪图层')
    paint.imageSmoothingEnabled = true; paint.imageSmoothingQuality = 'high'
    if (frame.background !== 'transparent') { paint.fillStyle = frame.background; paint.fillRect(0, 0, surface.width, surface.height) }
    for (const command of frame.draws) {
      checkAbort(input.signal)
      if (Date.now() >= deadline) throw new Error('裁剪图层预览等待超时，请减少图层或笔迹后重试')
      await drawNativeLayer(paint, replayCommand(command, frame.documentFrame), surface.width, surface.height, sources[command.sourceIndex]?.image, { signal: input.signal, deadline, lutTables })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    checkAbort(input.signal)
    if (Date.now() >= deadline) throw new Error('裁剪图层预览等待超时，请减少图层或笔迹后重试')
    context.save()
    try {
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.globalAlpha = 1; context.globalCompositeOperation = 'source-over'
      context.clearRect(0, 0, target.width, target.height)
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'
      context.drawImage(surface, frame.documentFrame?.offsetX ?? 0, frame.documentFrame?.offsetY ?? 0, frame.width, frame.height, 0, 0, target.width, target.height)
    } finally { context.restore() }
  } finally { surface.width = 0; surface.height = 0 }
}

export interface BrowserImageLayerFullPreviewInput {
  recipe: ImageLayerRecipe
  layerIndex: number
  source?: { image: CanvasImageSource; width: number; height: number }
  signal?: AbortSignal
  deadline?: number
  lutTables?: PreparedColorLutTables
}

/** Full, upright presentation is assembled in unchanged world axes. The old
 * document replay domain is copied back before the final inverse presentation;
 * expanding a preview must never redefine a pre-existing blur/liquify kernel.
 * No recipe, output encoder or PSD path calls this presentation-only entry.
 */
export async function paintBrowserImageLayerFullPreview(context: CanvasRenderingContext2D, input: BrowserImageLayerFullPreviewInput): Promise<void> {
  checkAbort(input.signal)
  const parsed = parseRenderRecipe(input.recipe)
  if (parsed.kind !== 'layer') throw new Error('完整图层预览需要图层配方')
  const frame = buildLayerFilterPresentationFrame(parsed, input.layerIndex), target = context.canvas
  if (![target.width, target.height].every((value) => Number.isInteger(value) && value >= 1 && value <= 1024) || target.width * target.height > 1_048_576 || target.width > frame.width || target.height > frame.height) throw new Error('完整图层预览尺寸超过安全容量')
  const layer = { ...parsed.layers[input.layerIndex], sourceIndex: 0, visible: true, opacity: 1, blend: 'source-over' as const }
  const deadline = Math.min(input.deadline ?? Infinity, Date.now() + 30000)
  const lutTables = snapshotLayerColorLutTables({ ...parsed, explicitLayers: true, layers: [layer] }, input.lutTables, { signal: input.signal, deadline })
  if (!layer.content && !input.source) throw new Error('完整图层预览的来源图片不可用')
  if (input.source && ![input.source.width, input.source.height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 16384) || input.source && input.source.width * input.source.height > maximumImageTransformTotalPixels) throw new Error('完整图层预览来源尺寸超过安全容量')
  const retained = new Set<HTMLCanvasElement>()
  function check(): void { checkAbort(input.signal); if (Date.now() >= deadline) throw new Error('完整图层预览等待超时，请减小图层或参数后重试') }
  function surface(width: number, height: number): { canvas: HTMLCanvasElement; paint: CanvasRenderingContext2D } {
    check()
    assertLayerFilterPresentationBudget([...retained].map((canvas) => ({ width: canvas.width, height: canvas.height })).concat({ width, height }))
    const canvas = document.createElement('canvas'); retained.add(canvas); canvas.width = width; canvas.height = height
    const paint = canvas.getContext('2d', { alpha: true })
    if (!paint) throw new Error('当前浏览器无法创建完整图层预览')
    paint.imageSmoothingEnabled = true; paint.imageSmoothingQuality = 'high'
    return { canvas, paint }
  }
  function release(canvas: HTMLCanvasElement): void { canvas.width = 0; canvas.height = 0; retained.delete(canvas) }
  try {
    if (layer.content?.kind === 'text' && layer.content.typography?.fontFamily) {
      await waitFor(prepareLocalTextFont(layer.content.typography.fontFamily, layer.content.typography.fontWeight ?? layer.content.fontWeight), input.signal, deadline)
      check()
    }
    let complete = surface(frame.worldBounds.width, frame.worldBounds.height)
    await paintImageLayerFullWorldFrameAsync(complete.paint, { layer, source: input.source?.image, lutTable: getPreparedColorLutTable(layer.colorGrade?.lut, lutTables), output: { width: parsed.outputWidth, height: parsed.outputHeight }, presentation: frame, signal: input.signal, deadline })
    check()
    const filter = layerFilter(layer.adjustments)
    if (filter) {
      const adjusted = surface(frame.worldBounds.width, frame.worldBounds.height)
      if (!('filter' in adjusted.paint)) throw new Error('当前浏览器不支持图层滤镜，请使用新版浏览器')
      adjusted.paint.filter = filter; adjusted.paint.drawImage(complete.canvas, 0, 0)
      release(complete.canvas); complete = adjusted
    }
    check()
    const canonical = surface(frame.replayRect.width, frame.replayRect.height)
    const single: ImageLayerRecipe = { ...parsed, background: 'transparent', explicitLayers: true, layers: [layer] }
    const commandFrame = buildImageTransformFrames(input.source ? [{ width: input.source.width, height: input.source.height }] : [], single)[0]
    for (const command of commandFrame.draws) {
      check()
      await drawNativeLayer(canonical.paint, replayCommand(command, commandFrame.documentFrame), canonical.canvas.width, canonical.canvas.height, input.source?.image, { signal: input.signal, deadline, lutTables })
    }
    check()
    const left = Math.max(frame.worldBounds.x, frame.replayRect.x), top = Math.max(frame.worldBounds.y, frame.replayRect.y)
    const right = Math.min(frame.worldBounds.x + frame.worldBounds.width, frame.replayRect.x + frame.replayRect.width), bottom = Math.min(frame.worldBounds.y + frame.worldBounds.height, frame.replayRect.y + frame.replayRect.height)
    if (right > left && bottom > top) {
      complete.paint.save()
      try {
        complete.paint.setTransform(1, 0, 0, 1, 0, 0)
        // Copy, not source-over: transparent canonical pixels replace rather
        // than double the alpha of the independent presentation extension.
        complete.paint.globalAlpha = 1; complete.paint.globalCompositeOperation = 'copy'; complete.paint.filter = 'none'
        complete.paint.beginPath(); complete.paint.rect(left - frame.worldBounds.x, top - frame.worldBounds.y, right - left, bottom - top); complete.paint.clip()
        complete.paint.drawImage(canonical.canvas, left - frame.replayRect.x, top - frame.replayRect.y, right - left, bottom - top, left - frame.worldBounds.x, top - frame.worldBounds.y, right - left, bottom - top)
      } finally { complete.paint.restore() }
    }
    release(canonical.canvas); check()
    const m = frame.worldToLayer, sx = target.width / frame.width, sy = target.height / frame.height
    context.save()
    try {
      context.setTransform(1, 0, 0, 1, 0, 0); context.globalAlpha = 1; context.globalCompositeOperation = 'source-over'; context.filter = 'none'
      context.clearRect(0, 0, target.width, target.height)
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'
      context.setTransform(sx * m.a, sy * m.b, sx * m.c, sy * m.d, sx * (m.a * frame.worldBounds.x + m.c * frame.worldBounds.y + m.e), sy * (m.b * frame.worldBounds.x + m.d * frame.worldBounds.y + m.f))
      context.drawImage(complete.canvas, 0, 0)
    } finally { context.restore() }
  } finally { for (const canvas of retained) { canvas.width = 0; canvas.height = 0 } }
}

export function processBrowserImageTransform(input: BrowserImageTransformInput): Promise<BrowserImageTransformOutput[]> {
  if (typeof document === 'undefined' || Array.isArray(input.sources) && input.sources.length > 0 && typeof createImageBitmap !== 'function') return Promise.reject(new Error('当前浏览器不支持本地图像处理，请使用新版浏览器'))
  return createBrowserImageTransformer({ decode: (blob) => createImageBitmap(blob, { imageOrientation: 'from-image' }), createCanvas: createTransformCanvas })(input)
}
