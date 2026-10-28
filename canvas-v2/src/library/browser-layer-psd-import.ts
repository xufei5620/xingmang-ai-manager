import { maximumGeneratedImageBytes, generatedImageInfo } from '../lib/generation-protocol'
import { maximumImportedPsdBytes, openLayerPsd, type ImportedLayerPsdPixels, type LayerPsdLayerMetadata } from './layer-psd-reader'
import type { ImageLayerGrouping } from '../image-tools/recipe'

export interface BrowserImportedPsdLayer extends LayerPsdLayerMetadata { blob: Blob }
export interface BrowserImportedLayerPsd { width: number; height: number; layers: BrowserImportedPsdLayer[]; layerGroups?: ImageLayerGrouping; warnings: string[] }
export type BrowserLayerPsdDocument = BrowserImportedLayerPsd
export interface BrowserLayerPsdImportOptions { signal?: AbortSignal }
export interface BrowserLayerPsdImportPlatform { encode(layer: ImportedLayerPsdPixels, signal: AbortSignal): Promise<Blob> }

function aborted(): Error { const error = new Error('已取消 PSD 导入，当前图层没有改变'); error.name = 'AbortError'; return error }
function check(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : aborted() }
function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    function abort() { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(signal.reason instanceof Error ? signal.reason : aborted()) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void pending.then((value) => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); resolve(value) } }, (error: unknown) => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); reject(error) } })
  })
}

function pngChunk(type: string, data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(data.length + 12), view = new DataView(result.buffer)
  view.setUint32(0, data.length)
  for (let index = 0; index < 4; index++) result[index + 4] = type.charCodeAt(index)
  result.set(data, 8)
  let crc = 0xffffffff
  for (let index = 4; index < result.length - 4; index++) { crc ^= result[index]; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  view.setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0)
  return result
}

/** Encode straight RGBA directly. A canvas roundtrip premultiplies low-alpha
 * channels and loses hidden RGB, which would change editable imported pixels.
 * Input rows and compressor output are streamed with independent byte bounds.
 */
export async function encodeImportedPsdLayerPng(layer: ImportedLayerPsdPixels, signal: AbortSignal): Promise<Blob> {
  check(signal)
  if (typeof CompressionStream !== 'function') throw new Error('当前浏览器不支持无损 PSD 图层转换，请使用新版浏览器')
  const { width, height, data } = layer
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || !(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw new Error('PSD 图层像素无效，未转换图片')
  const rowBytes = width * 4 + 1, batchRows = Math.max(1, Math.floor(65536 / rowBytes))
  let row = 0
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      check(signal)
      if (row === height) { controller.close(); return }
      const rows = Math.min(batchRows, height - row), bytes = new Uint8Array(rows * rowBytes)
      for (let offset = 0; offset < rows; offset++) bytes.set(data.subarray((row + offset) * width * 4, (row + offset + 1) * width * 4), offset * rowBytes + 1)
      row += rows; controller.enqueue(bytes)
    },
  })
  const compressed = source.pipeThrough(new CompressionStream('deflate'), { signal }).getReader()
  const header = new Uint8Array(13), view = new DataView(header.buffer)
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6
  const chunks: Uint8Array<ArrayBuffer>[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header)]
  let size = 45
  try {
    while (true) {
      check(signal)
      const result = await bounded(compressed.read(), signal)
      if (result.done) break
      size += result.value.byteLength + 12
      if (size > maximumGeneratedImageBytes) throw new Error('PSD 单个图层 PNG 超过 20 MB，请先缩小图片')
      chunks.push(pngChunk('IDAT', new Uint8Array(result.value)))
    }
    check(signal)
    chunks.push(pngChunk('IEND', new Uint8Array()))
    return new Blob(chunks, { type: 'image/png' })
  } finally {
    void compressed.cancel().catch(() => undefined)
    compressed.releaseLock()
  }
}

export function createBrowserLayerPsdImporter(platform: BrowserLayerPsdImportPlatform) {
  return async function importPsd(file: Blob, options: BrowserLayerPsdImportOptions = {}): Promise<BrowserImportedLayerPsd> {
    const controller = new AbortController(), abort = () => controller.abort(aborted())
    options.signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('PSD 导入超时，请减少图层或缩小画布')), 120_000)
    try {
      if (options.signal?.aborted) abort()
      const signal = controller.signal
      check(signal)
      if (!(file instanceof Blob) || file.size < 40 || file.size > maximumImportedPsdBytes) throw new Error('请选择不超过 128 MB 的完整 PSD 文件')
      const bytes = new Uint8Array(await bounded(file.arrayBuffer(), signal))
      check(signal)
      if (bytes.length !== file.size) throw new Error('PSD 文件读取不完整，请重新选择')
      const document = await openLayerPsd(bytes, { signal }), layers: BrowserImportedPsdLayer[] = []
      let totalBytes = 0
      for (let index = 0; index < document.layers.length; index++) {
        check(signal)
        // Only one decoded RGBA layer is alive during sequential conversion.
        const frame = await document.readLayer(index), blob = await bounded(platform.encode(frame, signal), signal)
        check(signal)
        if (!(blob instanceof Blob) || blob.type !== 'image/png' || blob.size < 1 || blob.size > maximumGeneratedImageBytes) throw new Error('PSD 图层 PNG 转换结果无效或超过 20 MB')
        totalBytes += blob.size
        if (totalBytes > 64 * 1024 * 1024) throw new Error('PSD 图层 PNG 总计超过 64 MB，请减少图层或缩小图片')
        const info = generatedImageInfo(new Uint8Array(await bounded(blob.arrayBuffer(), signal)))
        if (info.mimeType !== 'image/png' || info.width !== frame.width || info.height !== frame.height) throw new Error('PSD 图层 PNG 尺寸不一致，未导入图层')
        layers.push({ ...document.layers[index], blob })
      }
      check(signal)
      return { width: document.width, height: document.height, layers, ...(document.layerGroups ? { layerGroups: document.layerGroups } : {}), warnings: [...document.warnings] }
    } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort) }
  }
}

export function importBrowserLayerPsd(file: Blob, options: BrowserLayerPsdImportOptions = {}): Promise<BrowserImportedLayerPsd> {
  return createBrowserLayerPsdImporter({ encode: encodeImportedPsdLayerPng })(file, options)
}
