import { generatedImageInfo, maximumGeneratedImageBytes } from '../lib/generation-protocol'
import { buildEditorLayerMergePlan, type EditorLayerMergePlan } from '../image-tools/layer-editor-merge'
import { maximumImageTransformTotalPixels } from '../image-tools/recipe'
import { snapshotLayerColorLutTables, type PreparedColorLutTables } from '../image-tools/layer-color-lut-runtime'
import { sampleBrowserImageLayerPixels, type BrowserImageLayerPixelsInput, type BrowserImageTransformOutput } from './browser-image-transform'
import { encodeImportedPsdLayerPng } from './browser-layer-psd-import'

export interface EditorLayerMergeSource { image: CanvasImageSource; width: number; height: number }
export interface BrowserEditorLayerMergeInput { sources: ReadonlyMap<number, EditorLayerMergeSource>; signal?: AbortSignal; lutTables?: PreparedColorLutTables }
export interface BrowserEditorLayerMergePlatform {
  sample(input: BrowserImageLayerPixelsInput): Promise<{ width: number; height: number; data: Uint8ClampedArray }>
  encode(input: { width: number; height: number; data: Uint8ClampedArray }, signal: AbortSignal): Promise<Blob>
}

function cancelled(): Error { const error = new Error('已取消图层合并，原图层没有改变'); error.name = 'AbortError'; return error }
function check(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : cancelled() }
function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    function abort() { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(signal.reason instanceof Error ? signal.reason : cancelled()) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void pending.then((result) => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); resolve(result) } }, (cause: unknown) => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); reject(cause) } })
  })
}

/** Native pixels use the existing bounded layer painter, including crop replay,
 * masks, filters, opacity, local fonts and owned LUT tables. Encoding raw RGBA
 * avoids another premultiplication roundtrip; no URL, credential or upload is
 * accepted here. The editor owns the lifetime and final source-key guard. */
export function createBrowserEditorLayerMerger(platform: BrowserEditorLayerMergePlatform) {
  return async function render(plan: EditorLayerMergePlan, input: BrowserEditorLayerMergeInput): Promise<BrowserImageTransformOutput> {
    const controller = new AbortController(), abort = () => controller.abort(cancelled())
    input.signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('图层合并等待超时，请减少图层或缩小文档后重试')), 45000)
    try {
      if (input.signal?.aborted) abort()
      const signal = controller.signal, deadline = Date.now() + 45000
      check(signal)
      const verified = buildEditorLayerMergePlan(plan.snapshot, { placement: plan.placement })
      if (JSON.stringify([plan.rasterRecipe, plan.replacement, plan.width, plan.height]) !== JSON.stringify([verified.rasterRecipe, verified.replacement, verified.width, verified.height])) throw new Error('合并参数已变化，请重新确认')
      const remap = new Map<number, number>(), sources: EditorLayerMergeSource[] = []
      let pixels = 0
      const layers = verified.rasterRecipe.layers.map((layer) => {
        if (layer.content) return layer
        if (!remap.has(layer.sourceIndex)) {
          const source = input.sources.get(layer.sourceIndex)
          if (!source || ![source.width, source.height].every((size) => Number.isSafeInteger(size) && size >= 1 && size <= 16384)) throw new Error('合并图层的原图尚未就绪，请等待素材加载或重新选择')
          pixels += source.width * source.height
          if (pixels > maximumImageTransformTotalPixels) throw new Error('合并来源图片的总像素超过容量，请减少或缩小图片')
          remap.set(layer.sourceIndex, sources.length); sources.push({ ...source })
        }
        return { ...layer, sourceIndex: remap.get(layer.sourceIndex)! }
      })
      const recipe = { ...verified.rasterRecipe, layers }, lutTables = snapshotLayerColorLutTables(recipe, input.lutTables, { signal, deadline })
      const result = await bounded(platform.sample({ recipe, sources, source: 'composite', signal, lutTables }), signal)
      check(signal)
      if (result.width !== verified.width || result.height !== verified.height || !(result.data instanceof Uint8ClampedArray) || result.data.length !== verified.width * verified.height * 4) throw new Error('合并像素与原文档尺寸不一致，原图层已保留')
      const blob = await bounded(platform.encode(result, signal), signal)
      check(signal)
      if (!(blob instanceof Blob) || blob.type !== 'image/png' || !blob.size || blob.size > maximumGeneratedImageBytes) throw new Error('合并图片无效或超过 20 MB，请缩小文档；原图层已保留')
      const bytes = new Uint8Array(await bounded(blob.arrayBuffer(), signal)), info = generatedImageInfo(bytes)
      check(signal)
      if (info.mimeType !== 'image/png' || info.width !== verified.width || info.height !== verified.height) throw new Error('合并图片的实际尺寸与文档不一致，原图层已保留')
      return { blob, width: verified.width, height: verified.height }
    } finally { clearTimeout(timeout); input.signal?.removeEventListener('abort', abort) }
  }
}

export function renderBrowserEditorLayerMerge(plan: EditorLayerMergePlan, input: BrowserEditorLayerMergeInput): Promise<BrowserImageTransformOutput> {
  return createBrowserEditorLayerMerger({ sample: sampleBrowserImageLayerPixels,
    encode: (pixels, signal) => encodeImportedPsdLayerPng({ ...pixels, data: new Uint8ClampedArray(pixels.data), name: '合并图层', left: 0, top: 0, visible: true, opacity: 1, blend: 'source-over' }, signal),
  })(plan, input)
}
