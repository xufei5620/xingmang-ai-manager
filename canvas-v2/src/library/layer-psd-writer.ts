import type { ImageBlendMode, ImageLayerGrouping } from '../image-tools/recipe'
import { buildLayerPsdRecordPlan } from './layer-psd-groups'

/** PSD v1, RGB/8-bit, four raw channels per layer and in the merged image.
 * https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/
 * No private workflow, asset identifier, URL or authentication data is encoded.
 */
export const maximumLayerPsdPixels = 33_554_432
export const maximumLayerPsdBytes = maximumLayerPsdPixels * 4 + 64 * 1024
export interface LayerPsdMetadata { name: string; visible: boolean; opacity: number; blend: ImageBlendMode; locked?: boolean }
export interface LayerPsdPixels { width: number; height: number; data: Uint8ClampedArray }
export interface LayerPsdInput {
  width: number
  height: number
  /** Bottom to top, matching the canvas recipe. */
  layers: readonly LayerPsdMetadata[]
  layerGroups?: ImageLayerGrouping
  /** Optional independent canvas background precedes every editable leaf. */
  groupedLayerOffset?: 0 | 1
  readLayer(index: number, signal?: AbortSignal): Promise<LayerPsdPixels>
  readComposite(signal?: AbortSignal): Promise<LayerPsdPixels>
}
export interface LayerPsdOptions { signal?: AbortSignal; deadline?: number; yieldControl?: () => Promise<void> }

const blendKeys: Record<ImageBlendMode, string> = { 'source-over': 'norm', multiply: 'mul ', screen: 'scrn', overlay: 'over' }

export function assertLayerPsdBudget(width: number, height: number, layerCount: number): void {
  if (![width, height].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 4096)
    || !Number.isSafeInteger(layerCount) || layerCount < 1 || layerCount > 21) throw new Error('PSD 需要 1–21 个位图图层，画布宽高不超过 4096 像素')
  // Reserve the complete native-resolution layer planes AND merged planes
  // before any image decoding. Never silently shrink an exported document.
  if (width * height * (layerCount + 1) > maximumLayerPsdPixels) throw new Error('PSD 分层像素超过容量，请缩小画布或减少图层后导出；当前不会降低分辨率')
}

function checkedMetadata(value: LayerPsdMetadata): LayerPsdMetadata {
  if (!value || typeof value.name !== 'string' || value.name.length > 80 || /[\x00-\x1f\x7f]/.test(value.name) || /[\uD800-\uDFFF]/u.test(value.name)
    || typeof value.visible !== 'boolean' || !Number.isFinite(value.opacity) || value.opacity < 0 || value.opacity > 1
    || !Object.prototype.hasOwnProperty.call(blendKeys, value.blend) || value.locked !== undefined && typeof value.locked !== 'boolean') throw new Error('PSD 图层名称或显示参数无效')
  return { name: value.name || '未命名图层', visible: value.visible, opacity: value.opacity, blend: value.blend, ...(value.locked !== undefined ? { locked: value.locked } : {}) }
}

function check(options: LayerPsdOptions): void {
  if (options.signal?.aborted) { const error = new Error('已取消 PSD 导出，当前画布没有改变'); error.name = 'AbortError'; throw error }
  if (Date.now() >= (options.deadline ?? Infinity)) throw new Error('PSD 导出超时，请减少图层或缩小画布后重试')
}

function layerRecord(metadata: LayerPsdMetadata, width: number, height: number, divider?: 1 | 3): Uint8Array<ArrayBuffer> {
  const fallback = metadata.name.replace(/[^\x20-\x7e]/g, '?')
  const pascalLength = Math.ceil((fallback.length + 1) / 4) * 4
  const unicodeLength = Math.ceil((4 + metadata.name.length * 2) / 4) * 4
  const extraLength = 8 + pascalLength + 12 + unicodeLength + (divider ? 24 : 0) + (metadata.locked ? 16 : 0)
  const bytes = new Uint8Array(58 + extraLength), view = new DataView(bytes.buffer)
  view.setInt32(8, height); view.setInt32(12, width); view.setUint16(16, 4)
  for (let channel = 0; channel < 4; channel++) { view.setInt16(18 + channel * 6, channel === 3 ? -1 : channel); view.setUint32(20 + channel * 6, 2 + width * height) }
  bytes.set(new TextEncoder().encode('8BIM' + (divider === 1 ? 'pass' : blendKeys[metadata.blend])), 42)
  bytes[50] = Math.round(metadata.opacity * 255)
  bytes[52] = 8 | (divider ? 16 : 0) | (metadata.visible ? 0 : 2)
  view.setUint32(54, extraLength)
  // Zero-length layer mask and blending-range sections precede both names.
  bytes[66] = fallback.length
  for (let index = 0; index < fallback.length; index++) bytes[67 + index] = fallback.charCodeAt(index)
  const unicodeOffset = 66 + pascalLength
  bytes.set(new TextEncoder().encode('8BIMluni'), unicodeOffset)
  view.setUint32(unicodeOffset + 8, unicodeLength)
  view.setUint32(unicodeOffset + 12, metadata.name.length)
  for (let index = 0; index < metadata.name.length; index++) view.setUint16(unicodeOffset + 16 + index * 2, metadata.name.charCodeAt(index))
  let offset = unicodeOffset + 12 + unicodeLength
  if (divider) {
    bytes.set(new TextEncoder().encode('8BIMlsct'), offset); view.setUint32(offset + 8, 12); view.setUint32(offset + 12, divider)
    bytes.set(new TextEncoder().encode('8BIM' + (divider === 1 ? 'pass' : 'norm')), offset + 16); offset += 24
  }
  if (metadata.locked) { bytes.set(new TextEncoder().encode('8BIMlspf'), offset); view.setUint32(offset + 8, 4); view.setUint32(offset + 12, 0x80000000) }
  return bytes
}

/** Reads one RGBA frame at a time; the bounded output is allocated exactly once.
 * Raw planar data avoids compression bombs, unbounded dictionaries and a second
 * complete encoded copy. The host creates the download only after scope checks.
 */
export async function writeLayerPsd(input: LayerPsdInput, options: LayerPsdOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  options = { ...options, deadline: Math.min(options.deadline ?? Infinity, Date.now() + 120_000) }
  check(options)
  assertLayerPsdBudget(input.width, input.height, input.layers.length)
  const metadata = input.layers.map(checkedMetadata)
  // PSD records follow the paint stack bottom-to-top. Reversing only appears
  // correct while reading the stored merged preview; an editor recomposites
  // the layer channels and would then cover the foreground with the background.
  const plan = buildLayerPsdRecordPlan(metadata.length, input.layerGroups, input.groupedLayerOffset)
  const records = plan.map((entry) => entry.kind === 'layer' ? layerRecord(metadata[entry.index], input.width, input.height) : layerRecord({ name: entry.name, visible: entry.visible, locked: entry.locked, opacity: 1, blend: 'source-over' }, 0, 0, entry.divider))
  const pixels = input.width * input.height
  const layerInfoLength = 2 + records.reduce((sum, record) => sum + record.byteLength, 0) + metadata.length * (pixels * 4 + 8) + (plan.length - metadata.length) * 8
  const paddedLayerInfoLength = layerInfoLength + (layerInfoLength % 2)
  const layerMaskLength = 4 + paddedLayerInfoLength + 4
  const totalLength = 26 + 4 + 4 + 4 + layerMaskLength + 2 + pixels * 4
  if (!Number.isSafeInteger(totalLength) || totalLength > maximumLayerPsdBytes) throw new Error('PSD 文件超过安全容量，请缩小画布后重试')
  const bytes = new Uint8Array(totalLength), view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('8BPS'))
  view.setUint16(4, 1); view.setUint16(12, 4); view.setUint32(14, input.height); view.setUint32(18, input.width); view.setUint16(22, 8); view.setUint16(24, 3)
  view.setUint32(34, layerMaskLength); view.setUint32(38, paddedLayerInfoLength)
  view.setInt16(42, -records.length)
  let offset = 44
  for (const record of records) { bytes.set(record, offset); offset += record.length }
  const yieldControl = options.yieldControl ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  async function writePixels(frame: LayerPsdPixels, perChannelHeader: boolean): Promise<void> {
    check(options)
    if (!frame || frame.width !== input.width || frame.height !== input.height || !(frame.data instanceof Uint8ClampedArray) || frame.data.length !== pixels * 4) throw new Error('PSD 图层像素与画布尺寸不一致，未生成文件')
    for (let channel = 0; channel < 4; channel++) {
      if (perChannelHeader) offset += 2
      for (let start = 0; start < pixels; start += 65536) {
        check(options)
        const end = Math.min(pixels, start + 65536)
        for (let index = start; index < end; index++) {
          const color = frame.data[index * 4 + channel], alpha = frame.data[index * 4 + 3]
          // Only PSD's merged RGB preview is stored against a white matte.
          // Readers remove that matte using the merged transparency plane;
          // straight RGB here darkens/saturates semitransparent colors. Layer
          // planes remain straight, and alpha-zero hidden RGB is left intact.
          bytes[offset++] = !perChannelHeader && channel < 3 && alpha > 0
            ? Math.round(color * alpha / 255 + 255 - alpha) : color
        }
        await yieldControl()
      }
    }
  }
  for (const entry of plan) {
    check(options)
    if (entry.kind === 'layer') await writePixels(await input.readLayer(entry.index, options.signal), true)
    else offset += 8
  }
  offset += layerInfoLength % 2
  // Empty global mask, then raw composite compression code.
  offset += 6
  await writePixels(await input.readComposite(options.signal), false)
  check(options)
  if (offset !== bytes.length) throw new Error('PSD 文件长度校验失败，未生成文件')
  return bytes
}
