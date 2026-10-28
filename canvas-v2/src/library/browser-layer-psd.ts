import { generatedImageInfo, maximumGeneratedImageBytes } from '../lib/generation-protocol'
import { imageTransformRecipeNeedsSources, maximumImageTransformInputs, maximumImageTransformTotalPixels, parseImageTransformRecipe, type ImageLayer, type ImageLayerRecipe } from '../image-tools/recipe'
import { sampleBrowserImageLayerPixels, type BrowserImageLayerPixelsInput } from './browser-image-transform'
import { assertLayerPsdBudget, writeLayerPsd, type LayerPsdPixels } from './layer-psd-writer'
import { snapshotLayerColorLutTables, type PreparedColorLutTables } from '../image-tools/layer-color-lut-runtime'
import { materializeImageLayerGroups } from '../image-tools/layer-group-model'

export interface BrowserLayerPsdInput { recipe: ImageLayerRecipe; sources: Blob[]; signal?: AbortSignal; lutTables?: PreparedColorLutTables }
export interface BrowserLayerPsdResult { blob: Blob; layerCount: number; groupCount?: number }
export interface LayerPsdDecodedSource { image: CanvasImageSource; width: number; height: number; close(): void }
export interface BrowserLayerPsdPlatform {
  decode(blob: Blob): Promise<LayerPsdDecodedSource>
  sample(input: BrowserImageLayerPixelsInput): Promise<LayerPsdPixels>
}

function aborted(): Error { const error = new Error('已取消 PSD 导出，当前画布没有改变'); error.name = 'AbortError'; return error }
function check(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : aborted() }

function bounded<T>(pending: Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    function abort() { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(signal.reason instanceof Error ? signal.reason : aborted()) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void pending.then((value) => {
      if (settled) { discard?.(value); return }
      settled = true; signal.removeEventListener('abort', abort); resolve(value)
    }, (error: unknown) => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); reject(error) } })
  })
}

function defaultLayer(sourceIndex: number): ImageLayer { return { sourceIndex, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true } }

/** Also called by the host BEFORE downloading owned source blobs. */
export function inspectLayerPsdRecipe(value: unknown, sourceCount: number): { recipe: ImageLayerRecipe; layers: ImageLayer[] } {
  const recipe = parseImageTransformRecipe(value)
  if (recipe.kind !== 'layer') throw new Error('只有图层节点可以导出 PSD')
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 0 || sourceCount > maximumImageTransformInputs || (!sourceCount && imageTransformRecipeNeedsSources(recipe))) throw new Error('PSD 图层来源数量无效，请检查图片连接')
  const layers = recipe.layers.length || recipe.explicitLayers ? [...recipe.layers] : Array.from({ length: sourceCount }, (_, index) => defaultLayer(index))
  if (layers.some((layer) => !layer.content && layer.sourceIndex >= sourceCount)) throw new Error('PSD 图层来源图片缺失，请重新连接素材后导出')
  if (recipe.background !== 'transparent') layers.unshift({ ...defaultLayer(0), name: '画布背景', content: { kind: 'shape', shape: 'rectangle', fill: recipe.background, stroke: 'transparent', strokeWidth: 0 } })
  if (!layers.length) layers.push({ ...defaultLayer(0), name: '透明背景', content: { kind: 'paint' } })
  assertLayerPsdBudget(recipe.outputWidth, recipe.outputHeight, layers.length)
  return { recipe, layers }
}

function isAnimated(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'image/webp') return String.fromCharCode(...bytes.slice(12, 16)) === 'VP8X' && Boolean(bytes[20] & 2)
  if (mimeType !== 'image/png') return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 8; offset + 12 <= bytes.length;) {
    if (String.fromCharCode(...bytes.slice(offset + 4, offset + 8)) === 'acTL') return true
    offset += view.getUint32(offset) + 12
  }
  return false
}

/** No URLs or credentials: only the host can supply owned, bounded image blobs.
 * Each layer is rendered at opacity 1 / normal blending, then its ORIGINAL
 * opacity and blending are stored as PSD metadata. Applying them twice would
 * make the external editor's composition differ from the canvas.
 */
export function createBrowserLayerPsdExporter(platform: BrowserLayerPsdPlatform) {
  return async function exportPsd(input: BrowserLayerPsdInput): Promise<BrowserLayerPsdResult> {
    const controller = new AbortController()
    const deadline = Date.now() + 120_000
    const abort = () => controller.abort(aborted())
    input.signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('PSD 导出超时，请减少图层或缩小画布后重试')), 120_000)
    const decoded: LayerPsdDecodedSource[] = []
    try {
      if (input.signal?.aborted) abort()
      const signal = controller.signal
      check(signal)
      if (!Array.isArray(input.sources)) throw new Error('PSD 图片来源格式无效')
      const sources = [...input.sources], { recipe, layers } = inspectLayerPsdRecipe(input.recipe, sources.length)
      const lutTables = snapshotLayerColorLutTables(recipe, input.lutTables, { signal, deadline })
      if (sources.some((blob) => !(blob instanceof Blob) || blob.size < 1 || blob.size > maximumGeneratedImageBytes)
        || sources.reduce((sum, blob) => sum + blob.size, 0) > 64 * 1024 * 1024) throw new Error('PSD 图片单张不得超过 20 MB，总计不得超过 64 MB')
      const sizes: Array<{ width: number; height: number }> = []
      let totalPixels = 0
      for (const source of sources) {
        const bytes = new Uint8Array(await bounded(source.arrayBuffer(), signal))
        check(signal)
        let info: ReturnType<typeof generatedImageInfo>
        try { info = generatedImageInfo(bytes, maximumGeneratedImageBytes) } catch { throw new Error('PSD 来源图片格式无效，请使用完整的 PNG、JPEG 或 WebP') }
        if (source.type && source.type !== info.mimeType || isAnimated(bytes, info.mimeType)) throw new Error('PSD 只支持格式匹配的静态 PNG、JPEG 或 WebP 图片')
        totalPixels += info.width * info.height
        if (totalPixels > maximumImageTransformTotalPixels) throw new Error('PSD 来源图片总像素超过容量，请减少或缩小图片')
        sizes.push({ width: info.width, height: info.height })
      }
      for (const [index, source] of sources.entries()) {
        check(signal)
        const bitmap = await bounded(platform.decode(source), signal, (value) => value.close())
        decoded.push(bitmap)
        check(signal)
        const expected = sizes[index]
        if (!((bitmap.width === expected.width && bitmap.height === expected.height) || (bitmap.width === expected.height && bitmap.height === expected.width))) throw new Error('PSD 来源图片解码尺寸不一致，未导出文件')
      }
      const sampleSources = decoded.map(({ image, width, height }) => ({ image, width, height }))
      const renderedRecipe = materializeImageLayerGroups(recipe)
      const bytes = await writeLayerPsd({
        width: recipe.outputWidth, height: recipe.outputHeight,
        layers: layers.map((layer, index) => ({ name: layer.name || `图层 ${index + 1}`, visible: layer.visible, opacity: layer.opacity, blend: layer.blend, ...(layer.locked !== undefined ? { locked: layer.locked } : {}) })),
        ...(recipe.layerGroups ? { layerGroups: recipe.layerGroups, groupedLayerOffset: recipe.background !== 'transparent' ? 1 as const : 0 as const } : {}),
        async readLayer(index) {
          check(signal)
          const layer = { ...layers[index], visible: true, opacity: 1, blend: 'source-over' as const }
          return bounded(platform.sample({ recipe: { ...renderedRecipe, background: 'transparent', explicitLayers: true, layers: [layer] }, sources: sampleSources, source: 'composite', signal, lutTables }), signal)
        },
        async readComposite() { check(signal); return bounded(platform.sample({ recipe, sources: sampleSources, source: 'composite', signal, lutTables }), signal) },
      }, { signal })
      check(signal)
      return { blob: new Blob([bytes], { type: 'image/vnd.adobe.photoshop' }), layerCount: layers.length, ...(recipe.layerGroups ? { groupCount: recipe.layerGroups.groups.length } : {}) }
    } finally {
      clearTimeout(timeout); input.signal?.removeEventListener('abort', abort)
      for (const bitmap of decoded) { try { bitmap.close() } catch { /* Release every decoder even if one close fails. */ } }
    }
  }
}

export function exportBrowserLayerPsd(input: BrowserLayerPsdInput): Promise<BrowserLayerPsdResult> {
  if (typeof document === 'undefined' || input.sources.length > 0 && typeof createImageBitmap !== 'function') return Promise.reject(new Error('当前浏览器不支持分层 PSD 导出，请使用新版浏览器'))
  return createBrowserLayerPsdExporter({
    async decode(blob) { const image = await createImageBitmap(blob, { imageOrientation: 'from-image' }); return { image, width: image.width, height: image.height, close: () => image.close() } },
    sample: sampleBrowserImageLayerPixels,
  })(input)
}
