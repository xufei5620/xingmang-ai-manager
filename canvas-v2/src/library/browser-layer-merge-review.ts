import { generatedImageInfo, maximumGeneratedImageBytes } from '../lib/generation-protocol'
import { buildEditorLayerMergeCandidate, buildEditorLayerMergePlan, type EditorLayerMergePlan } from '../image-tools/layer-editor-merge'
import { materializeImageLayerGroups } from '../image-tools/layer-group-model'
import { buildLayerDocumentReplayRecipe, resolveLayerDocumentFrame } from '../image-tools/layer-document-geometry'
import { snapshotLayerColorLutTables } from '../image-tools/layer-color-lut-runtime'
import { maximumImageTransformTotalPixels, type ImageLayerRecipe } from '../image-tools/recipe'
import { sampleBrowserImageLayerPixels, type BrowserImageLayerPixelsInput, type BrowserImageTransformOutput } from './browser-image-transform'
import { renderBrowserEditorLayerMerge, type BrowserEditorLayerMergeInput, type EditorLayerMergeSource } from './browser-layer-merge'
import { encodeImportedPsdLayerPng } from './browser-layer-psd-import'

interface LayerMergePixels { width: number; height: number; data: Uint8ClampedArray }
export interface LayerMergeComparison {
  width: number; height: number; totalPixels: number
  /** Eight-bit premultiplied RGBA measures visible differences, ignoring RGB
   * under zero alpha. Raw channel statistics remain available separately. */
  changedPixels: number; maxChannelDelta: number; meanChannelDelta: number
  rawChangedPixels: number; rawMaxChannelDelta: number
  outputWindow?: { x: number; y: number; width: number; height: number }
}
export interface BrowserEditorLayerMergeReview {
  output: BrowserImageTransformOutput
  before: Blob; after: Blob; difference: Blob
  comparison: LayerMergeComparison
  candidate: ReturnType<typeof buildEditorLayerMergeCandidate>
}
export interface BrowserEditorLayerMergeReviewPlatform {
  merge(plan: EditorLayerMergePlan, input: BrowserEditorLayerMergeInput): Promise<BrowserImageTransformOutput>
  sample(input: BrowserImageLayerPixelsInput): Promise<LayerMergePixels>
  decode(blob: Blob): Promise<EditorLayerMergeSource & { close(): void }>
  encode(input: LayerMergePixels, signal: AbortSignal): Promise<Blob>
}
export interface BrowserEditorLayerMergeReviewInput extends BrowserEditorLayerMergeInput {
  sourceIndex: number; replacementId: string
  /** All original editor inputs remain connected for undo/reuse after applying
   * the PNG. Include even hidden or currently unused input dimensions so the
   * final execution's existing total-pixel budget is checked before rendering. */
  originalSourceSizes: ReadonlyArray<{ width: number; height: number }>
}

function cancelled(): Error { const value = new Error('已取消合并预览，原图层没有改变'); value.name = 'AbortError'; return value }
function abortReason(signal: AbortSignal): Error { return signal.reason instanceof Error && signal.reason.name !== 'AbortError' ? signal.reason : cancelled() }
function check(signal: AbortSignal): void { if (signal.aborted) throw abortReason(signal) }
function bounded<T>(pending: Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    function abort() { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(abortReason(signal)) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void pending.then((value) => { if (settled) { discard?.(value); return }; settled = true; signal.removeEventListener('abort', abort); resolve(value) }, (cause: unknown) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(cause) })
  })
}
function assertPixels(value: LayerMergePixels, width: number, height: number): void {
  if (value.width !== width || value.height !== height || !(value.data instanceof Uint8ClampedArray) || value.data.length !== width * height * 4) throw new Error('合并对比像素与文档尺寸不一致，请重新生成预览')
}
function premultiplied(value: number, alpha: number): number { return Math.round(value * alpha / 255) }

/** Compare the complete native output, including unselected backdrop. Thumbnail
 * heat buckets collect every changed output pixel rather than sampling away
 * small changes. The two picture thumbnails use nearest output-pixel centers;
 * only their display size is reduced, never the comparison resolution. */
export async function compareEditorLayerMergePixels(before: LayerMergePixels, after: LayerMergePixels, signal: AbortSignal): Promise<{ comparison: LayerMergeComparison; before: LayerMergePixels; after: LayerMergePixels; difference: LayerMergePixels }> {
  const { width, height } = before
  if (![width, height].every((size) => Number.isSafeInteger(size) && size >= 1 && size <= 4096)) throw new Error('合并对比尺寸超过文档容量')
  assertPixels(before, width, height); assertPixels(after, width, height); check(signal)
  const scale = Math.min(1, 1024 / Math.max(width, height)), tw = Math.max(1, Math.round(width * scale)), th = Math.max(1, Math.round(height * scale))
  const original = new Uint8ClampedArray(tw * th * 4), candidate = new Uint8ClampedArray(original.length), heat = new Uint8ClampedArray(original.length), heatValues = new Uint8Array(tw * th)
  let changedPixels = 0, maxChannelDelta = 0, channelSum = 0, rawChangedPixels = 0, rawMaxChannelDelta = 0
  for (let start = 0; start < width * height; start += 262144) {
    check(signal)
    const end = Math.min(width * height, start + 262144)
    for (let pixel = start; pixel < end; pixel++) {
      const at = pixel * 4, alphaBefore = before.data[at + 3], alphaAfter = after.data[at + 3]
      let delta = Math.abs(alphaBefore - alphaAfter), rawDelta = delta, sum = delta
      for (let channel = 0; channel < 3; channel++) {
        const difference = Math.abs(premultiplied(before.data[at + channel], alphaBefore) - premultiplied(after.data[at + channel], alphaAfter))
        delta = Math.max(delta, difference); sum += difference
        rawDelta = Math.max(rawDelta, Math.abs(before.data[at + channel] - after.data[at + channel]))
      }
      if (delta) changedPixels++
      if (rawDelta) rawChangedPixels++
      maxChannelDelta = Math.max(maxChannelDelta, delta); rawMaxChannelDelta = Math.max(rawMaxChannelDelta, rawDelta); channelSum += sum
      const x = pixel % width, y = Math.floor(pixel / width), target = Math.min(th - 1, Math.floor(y * th / height)) * tw + Math.min(tw - 1, Math.floor(x * tw / width))
      heatValues[target] = Math.max(heatValues[target], delta)
    }
    // Native pixel comparisons must leave cancellation and input responsive at
    // the largest supported document size. No document data is persisted here.
    await bounded(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal)
  }
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const at = (y * tw + x) * 4, src = (Math.min(height - 1, Math.floor((y + .5) * height / th)) * width + Math.min(width - 1, Math.floor((x + .5) * width / tw))) * 4
    original.set(before.data.subarray(src, src + 4), at); candidate.set(after.data.subarray(src, src + 4), at)
    const delta = heatValues[y * tw + x]
    if (delta) { heat[at] = 255; heat[at + 1] = Math.max(32, 255 - delta); heat[at + 2] = 32; heat[at + 3] = 255 }
  }
  check(signal)
  return {
    comparison: { width, height, totalPixels: width * height, changedPixels, maxChannelDelta, meanChannelDelta: channelSum / (width * height * 4), rawChangedPixels, rawMaxChannelDelta },
    before: { width: tw, height: th, data: original }, after: { width: tw, height: th, data: candidate }, difference: { width: tw, height: th, data: heat },
  }
}

function remapSources(recipe: ImageLayerRecipe, input: ReadonlyMap<number, EditorLayerMergeSource>): { recipe: ImageLayerRecipe; sources: EditorLayerMergeSource[] } {
  const flat = materializeImageLayerGroups(recipe), indices = new Map<number, number>(), sources: EditorLayerMergeSource[] = []
  let pixels = 0
  const layers = flat.layers.filter((layer) => layer.visible && layer.opacity > 0).map((layer) => {
    if (layer.content) return layer
    if (!indices.has(layer.sourceIndex)) {
      const source = input.get(layer.sourceIndex)
      if (!source || ![source.width, source.height].every((size) => Number.isSafeInteger(size) && size >= 1 && size <= 16384)) throw new Error('完整文档素材仍未就绪，请等待全部可见图层加载')
      pixels += source.width * source.height
      if (pixels > maximumImageTransformTotalPixels) throw new Error('合并对比素材的总像素超过容量，请缩小素材')
      indices.set(layer.sourceIndex, sources.length); sources.push({ ...source })
    }
    return { ...layer, sourceIndex: indices.get(layer.sourceIndex)! }
  })
  return { recipe: { ...flat, layers, explicitLayers: true }, sources }
}

/** One bounded transaction rasterizes once, decodes that exact PNG, and paints
 * the original and replacement documents through the production native painter.
 * Final confirmation uploads output.blob; it must not rerender a new candidate. */
export function createBrowserEditorLayerMergeReviewer(platform: BrowserEditorLayerMergeReviewPlatform) {
  return async function review(plan: EditorLayerMergePlan, input: BrowserEditorLayerMergeReviewInput): Promise<BrowserEditorLayerMergeReview> {
    const controller = new AbortController(), abort = () => controller.abort(cancelled()), timeout = setTimeout(() => controller.abort(new Error('整图合并对比等待超时，请缩小文档后重试')), 90000)
    input.signal?.addEventListener('abort', abort, { once: true })
    let decoded: (EditorLayerMergeSource & { close(): void }) | undefined
    try {
      if (input.signal?.aborted) abort()
      const signal = controller.signal; check(signal)
      const verified = buildEditorLayerMergePlan(plan.snapshot, { placement: plan.placement })
      if (JSON.stringify([plan.rasterRecipe, plan.replacement, plan.groupParentId, plan.insertionIndex]) !== JSON.stringify([verified.rasterRecipe, verified.replacement, verified.groupParentId, verified.insertionIndex])) throw new Error('合并位置已变化，请重新生成预览')
      const candidate = buildEditorLayerMergeCandidate(verified, { sourceIndex: input.sourceIndex, replacementId: input.replacementId })
      if (input.sources.has(input.sourceIndex)) throw new Error('合并图片来源与现有素材冲突，请重新打开预览')
      if (!Array.isArray(input.originalSourceSizes) || input.originalSourceSizes.length !== input.sourceIndex) throw new Error('原素材尺寸尚未核对，请重新打开图层编辑器')
      let executionPixels = verified.width * verified.height
      for (const size of input.originalSourceSizes) {
        if (!size || ![size.width, size.height].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 16384)) throw new Error('原素材尺寸尚未确定，请等待素材加载后重试')
        executionPixels += size.width * size.height
      }
      if (executionPixels > maximumImageTransformTotalPixels) throw new Error('合并图片与保留来源的总像素超过图像工具容量，请先缩小或整理原素材；原图层已保留')
      const full = remapSources(buildLayerDocumentReplayRecipe(verified.recipe), input.sources)
      let sourcePixels = 0
      for (const source of input.sources.values()) {
        if (![source.width, source.height].every((size) => Number.isSafeInteger(size) && size >= 1 && size <= 16384)) throw new Error('原文档素材尺寸无效，请重新载入素材')
        sourcePixels += source.width * source.height
      }
      if (sourcePixels > maximumImageTransformTotalPixels) throw new Error('原文档素材的总像素超过容量，请缩小素材')
      // A selected zero-opacity layer is still part of the raster recipe. Keep
      // its prepared LUT in the owned snapshot even though full-output sampling
      // can omit this visually empty layer.
      const lutTables = snapshotLayerColorLutTables(verified.recipe, input.lutTables, { signal, deadline: Date.now() + 90000 })
      const ownedInput = { sources: new Map(input.sources), signal, lutTables }
      const output = await bounded(platform.merge(verified, ownedInput), signal)
      check(signal)
      if (output.width !== verified.width || output.height !== verified.height || !(output.blob instanceof Blob) || output.blob.type !== 'image/png' || !output.blob.size || output.blob.size > maximumGeneratedImageBytes) throw new Error('合并预览 PNG 无效，原图层已保留')
      const info = generatedImageInfo(new Uint8Array(await bounded(output.blob.arrayBuffer(), signal)))
      if (info.mimeType !== 'image/png' || info.width !== output.width || info.height !== output.height) throw new Error('合并预览图片的实际尺寸不一致')
      decoded = await bounded(platform.decode(output.blob), signal, (source) => source.close())
      check(signal)
      if (decoded.width !== verified.width || decoded.height !== verified.height) throw new Error('合并图片解码尺寸不一致')
      const before = await bounded(platform.sample({ ...full, source: 'composite', signal, lutTables }), signal)
      const afterSources = new Map(ownedInput.sources); afterSources.set(input.sourceIndex, decoded)
      const afterInput = remapSources(buildLayerDocumentReplayRecipe(candidate.recipe), afterSources)
      const after = await bounded(platform.sample({ ...afterInput, source: 'composite', signal, lutTables }), signal)
      assertPixels(before, verified.width, verified.height); assertPixels(after, before.width, before.height)
      const pictures = await compareEditorLayerMergePixels(before, after, signal)
      if (verified.recipe.documentFrame) {
        const frame = resolveLayerDocumentFrame(verified.recipe)
        pictures.comparison.outputWindow = { x: frame.offsetX, y: frame.offsetY, width: verified.recipe.outputWidth, height: verified.recipe.outputHeight }
      }
      const blobs: Blob[] = []
      for (const pixels of [pictures.before, pictures.after, pictures.difference]) {
        const blob = await bounded(platform.encode(pixels, signal), signal)
        check(signal)
        if (!(blob instanceof Blob) || blob.type !== 'image/png' || !blob.size || blob.size > maximumGeneratedImageBytes) throw new Error('无法生成合并对比图，请重试')
        const preview = generatedImageInfo(new Uint8Array(await bounded(blob.arrayBuffer(), signal)))
        if (preview.width !== pixels.width || preview.height !== pixels.height || preview.mimeType !== 'image/png') throw new Error('合并对比缩略图无效')
        blobs.push(blob)
      }
      check(signal)
      return { output, candidate, before: blobs[0], after: blobs[1], difference: blobs[2], comparison: pictures.comparison }
    } finally { clearTimeout(timeout); input.signal?.removeEventListener('abort', abort); decoded?.close() }
  }
}

export function reviewBrowserEditorLayerMerge(plan: EditorLayerMergePlan, input: BrowserEditorLayerMergeReviewInput): Promise<BrowserEditorLayerMergeReview> {
  return createBrowserEditorLayerMergeReviewer({ merge: renderBrowserEditorLayerMerge, sample: sampleBrowserImageLayerPixels,
    async decode(blob) { const image = await createImageBitmap(blob); return { image, width: image.width, height: image.height, close() { image.close() } } },
    encode: (pixels, signal) => encodeImportedPsdLayerPng({ ...pixels, data: new Uint8ClampedArray(pixels.data), name: '合并整图对比', left: 0, top: 0, visible: true, opacity: 1, blend: 'source-over' }, signal),
  })(plan, input)
}
