import type { ImageBlendMode, ImageLayerGrouping } from '../image-tools/recipe'
import { maximumImageLayerGroups, maximumImageLayerGroupDepth, parseImageLayerGroups } from '../image-tools/layer-group-model'
import { maximumLayerPsdBytes, maximumLayerPsdPixels } from './layer-psd-writer'

export const maximumImportedPsdLayers = 20
export const maximumImportedPsdBytes = maximumLayerPsdBytes
export interface LayerPsdLayerMetadata {
  name: string
  left: number
  top: number
  width: number
  height: number
  visible: boolean
  opacity: number
  blend: ImageBlendMode
  locked?: boolean
}
export interface ImportedLayerPsdPixels extends LayerPsdLayerMetadata { data: Uint8ClampedArray<ArrayBuffer> }
export interface LayerPsdDocument { width: number; height: number; layers: ImportedLayerPsdPixels[]; layerGroups?: ImageLayerGrouping; warnings: string[] }
export interface LayerPsdReadOptions { signal?: AbortSignal; deadline?: number; yieldControl?: () => Promise<void> }
interface Channel { id: number; start: number; length: number }
interface RecordLayer { metadata: LayerPsdLayerMetadata; channels: Channel[]; divider?: number }
interface ExtraLayerMetadata { name: string; section?: { kind: number; blend?: string }; locked?: boolean }

const blends: Record<string, ImageBlendMode> = { norm: 'source-over', 'mul ': 'multiply', scrn: 'screen', over: 'overlay' }

function failure(message = '文件结构损坏或不完整'): Error { return new Error(`PSD ${message}，未导入任何图层`) }
function check(options: LayerPsdReadOptions): void {
  if (options.signal?.aborted) { const error = failure('导入已取消'); error.name = 'AbortError'; throw error }
  if (Date.now() >= (options.deadline ?? Infinity)) throw failure('读取超时，请减少图层或缩小画布')
}
function pause(options: LayerPsdReadOptions): Promise<void> { return (options.yieldControl ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0))))() }

class Reader {
  offset: number
  readonly view: DataView
  constructor(readonly bytes: Uint8Array, readonly end = bytes.length, offset = 0) { this.offset = offset; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
  need(length: number): void { if (!Number.isSafeInteger(length) || length < 0 || length > this.end - this.offset) throw failure() }
  u8(): number { this.need(1); return this.bytes[this.offset++] }
  u16(): number { this.need(2); const result = this.view.getUint16(this.offset); this.offset += 2; return result }
  i16(): number { this.need(2); const result = this.view.getInt16(this.offset); this.offset += 2; return result }
  u32(): number { this.need(4); const result = this.view.getUint32(this.offset); this.offset += 4; return result }
  i32(): number { this.need(4); const result = this.view.getInt32(this.offset); this.offset += 4; return result }
  take(length: number): Uint8Array { this.need(length); const start = this.offset; this.offset += length; return this.bytes.subarray(start, this.offset) }
  text(length: number): string { return Array.from(this.take(length), (value) => String.fromCharCode(value)).join('') }
  section(length = this.u32()): Reader { this.need(length); const result = new Reader(this.bytes, this.offset + length, this.offset); this.offset += length; return result }
  finish(padding = 0): void { if (this.end - this.offset > padding || this.take(this.end - this.offset).some((byte) => byte !== 0)) throw failure() }
}

async function readResources(reader: Reader, options: LayerPsdReadOptions): Promise<void> {
  if (reader.end - reader.offset > 4 * 1024 * 1024) throw failure('附加图像资源超过 4 MB，请移除多余元数据后重试')
  let count = 0
  while (reader.offset < reader.end) {
    check(options)
    if (++count > 4096) throw failure('附加图像资源数量过多')
    if (reader.text(4) !== '8BIM') throw failure('包含无法识别的图像资源')
    const id = reader.u16(), nameLength = reader.u8()
    reader.take(nameLength); if ((nameLength + 1) % 2) reader.take(1)
    const length = reader.u32()
    if (id === 1039 && length) throw failure('包含 ICC 色彩配置，当前不能保证颜色一致；请先转换为不嵌入配置的 sRGB 位图 PSD')
    reader.take(length); if (length % 2) reader.take(1)
    if (count % 128 === 0) { await pause(options); check(options) }
  }
}

function readExtra(reader: Reader, index: number): ExtraLayerMetadata {
  const mask = reader.section()
  if (mask.end !== mask.offset) throw failure('包含图层蒙版，当前仅支持无蒙版的位图图层')
  const ranges = reader.section()
  if ((ranges.end - ranges.offset) % 8 || ranges.end - ranges.offset > 40) throw failure('混合范围格式无效')
  while (ranges.offset < ranges.end) for (const expected of [0, 0, 255, 255, 0, 0, 255, 255]) if (ranges.u8() !== expected) throw failure('包含非默认混合范围，不能正确还原')
  const length = reader.u8(), fallbackBytes = reader.take(length)
  let name = new TextDecoder('windows-1252').decode(fallbackBytes)
  let section: ExtraLayerMetadata['section'], locked: boolean | undefined
  reader.take((4 - (length + 1) % 4) % 4)
  const seen = new Set<string>()
  while (reader.offset < reader.end) {
    if (reader.end - reader.offset < 12) { reader.finish(3); break }
    if (reader.text(4) !== '8BIM') throw failure('包含不支持的附加图层数据')
    const key = reader.text(4), blockLength = reader.u32(), block = reader.section(blockLength)
    if (seen.has(key)) throw failure('包含重复图层属性')
    seen.add(key)
    if (key === 'luni') {
      const count = block.u32()
      if (count > 80) throw failure('图层名称超过 80 字，请先缩短名称')
      name = ''
      for (let character = 0; character < count; character++) name += String.fromCharCode(block.u16())
      block.finish(3)
    } else if (key === 'lyid') {
      block.u32(); block.finish()
    } else if (key === 'lclr') {
      block.take(8); block.finish()
    } else if (key === 'iOpa') {
      if (block.u8() !== 255) throw failure('包含独立填充不透明度，不能正确还原')
      block.finish(3)
    } else if (key === 'lsct' || key === 'lsdk') {
      if (![4, 12, 16].includes(blockLength)) throw failure('图层编组分隔记录长度无效')
      const kind = block.u32()
      if (![0, 1, 2, 3].includes(kind)) throw failure('图层编组类型不受支持')
      let blend: string | undefined
      if (blockLength >= 12) { if (block.text(4) !== '8BIM') throw failure('图层编组混合签名无效'); blend = block.text(4) }
      if (blockLength === 16 && block.u32() !== 0) throw failure('动画场景编组暂不支持')
      block.finish()
      if (section && (section.kind !== kind || section.blend !== blend)) throw failure('存在冲突的图层编组分隔记录')
      section = { kind, ...(blend !== undefined ? { blend } : {}) }
    } else if (key === 'lspf') {
      const flags = block.u32(); block.finish()
      const complete = (flags & 0x80000000) !== 0 && (flags & 0x7ffffff0) === 0
      if (flags !== 0 && flags !== 7 && flags !== 15 && !complete) throw failure('包含部分锁定保护，当前仅支持完整锁定或未锁定图层')
      locked = flags !== 0
    } else {
      throw failure('包含文字、矢量、智能对象、效果或其他不支持的图层属性，请先在原编辑器中明确转换为普通位图层')
    }
    if (blockLength % 2) reader.take(1)
  }
  if (name.length > 80 || /[\x00-\x1f\x7f]/.test(name) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name)) throw failure('图层名称无效，请先修改名称')
  return { name: name || `图层 ${index + 1}`, ...(section ? { section } : {}), ...(locked !== undefined ? { locked } : {}) }
}

async function decodeChannel(bytes: Uint8Array, channel: Channel, width: number, height: number, options: LayerPsdReadOptions, target?: Uint8ClampedArray, targetChannel = 0): Promise<void> {
  const reader = new Reader(bytes, channel.start + channel.length, channel.start), compression = reader.u16()
  if (compression === 2 || compression === 3) throw failure('使用 ZIP 压缩，当前支持原始或 RLE 压缩；请另存兼容 PSD 后重试')
  if (compression !== 0 && compression !== 1) throw failure('压缩方式不受支持')
  const rowLengths = compression === 1 ? Array.from({ length: height }, () => reader.u16()) : null
  let work = 0
  for (let row = 0; row < height; row++) {
    check(options)
    if (!rowLengths) {
      const values = reader.take(width)
      if (target) for (let column = 0; column < width; column++) target[((row * width + column) * 4) + targetChannel] = values[column]
    } else {
      const packed = reader.section(rowLengths[row]); let column = 0
      while (packed.offset < packed.end) {
        const control = packed.u8()
        if (control === 128) continue
        const count = control < 128 ? control + 1 : 257 - control
        if (column + count > width) throw failure('RLE 行展开超过声明宽度')
        if (control < 128) {
          const values = packed.take(count)
          if (target) for (let index = 0; index < count; index++) target[((row * width + column + index) * 4) + targetChannel] = values[index]
        } else {
          const value = packed.u8()
          if (target) for (let index = 0; index < count; index++) target[((row * width + column + index) * 4) + targetChannel] = value
        }
        column += count
      }
      if (column !== width) throw failure('RLE 行像素不足')
    }
    work += width + (rowLengths?.[row] ?? 0)
    if (work >= 65536) { work = 0; await pause(options); check(options) }
  }
  reader.finish()
}

/** Adobe PSD v1 subset: RGB/8-bit raster leaves and pass-through folders.
 * Scan every record and validate all encoded planes before exposing any layer.
 * Unknown appearance-affecting metadata is rejected, never silently flattened.
 * https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/
 */
export async function openLayerPsd(bytes: Uint8Array, options: LayerPsdReadOptions = {}): Promise<{ width: number; height: number; layers: LayerPsdLayerMetadata[]; layerGroups?: ImageLayerGrouping; warnings: string[]; readLayer(index: number): Promise<ImportedLayerPsdPixels> }> {
  options = { ...options, deadline: Math.min(options.deadline ?? Infinity, Date.now() + 120_000) }
  check(options)
  if (!(bytes instanceof Uint8Array) || bytes.length < 40 || bytes.length > maximumImportedPsdBytes) throw failure('文件为空或超过 128 MB 安全容量')
  const reader = new Reader(bytes)
  if (reader.text(4) !== '8BPS' || reader.u16() !== 1) throw failure('不是受支持的 PSD v1 文件；PSB 暂不支持')
  if (reader.take(6).some((value) => value !== 0)) throw failure()
  const channels = reader.u16(), height = reader.u32(), width = reader.u32(), depth = reader.u16(), mode = reader.u16()
  if (depth !== 8 || mode !== 3 || (channels !== 3 && channels !== 4)) throw failure('仅支持 RGB 8 位和最多一个透明通道，不支持额外专色通道')
  if (!width || !height || width > 4096 || height > 4096) throw failure('画布宽高须为 1–4096 像素')
  const colorData = reader.section(); colorData.finish()
  await readResources(reader.section(), options)
  const layerSection = reader.section(), info = layerSection.section(), signedCount = info.i16(), count = Math.abs(signedCount)
  if (!count) throw failure('没有可导入的独立图层，不会以合成预览代替图层')
  if (count > maximumImportedPsdLayers + 1 + maximumImageLayerGroups * 2) throw failure('图层与编组记录超过安全容量')
  if (signedCount < 0 && channels !== 4) throw failure('合成透明通道声明不一致')
  let pixels = width * height
  const records: RecordLayer[] = [], leafRecords: RecordLayer[] = [], layerIds: string[] = []
  const groups: ImageLayerGrouping['groups'] = [], stack: ImageLayerGrouping['groups'] = []
  for (let index = 0; index < count; index++) {
    check(options)
    const top = info.i32(), left = info.i32(), bottom = info.i32(), right = info.i32(), layerWidth = right - left, layerHeight = bottom - top
    if (layerWidth < 0 || layerHeight < 0 || layerWidth > 4096 || layerHeight > 4096 || Math.abs(top) > 16384 || Math.abs(left) > 16384 || Math.abs(bottom) > 16384 || Math.abs(right) > 16384) throw failure('图层边界为空或超过安全容量')
    const channelCount = info.u16()
    if (![0, 3, 4].includes(channelCount)) throw failure('图层包含蒙版、专色或不完整的 RGB 通道')
    const descriptions: Channel[] = [], ids = new Set<number>()
    for (let item = 0; item < channelCount; item++) {
      const id = info.i16(), length = info.u32()
      if (![0, 1, 2, -1].includes(id) || ids.has(id) || length < 2) throw failure('图层通道无效或重复')
      ids.add(id); descriptions.push({ id, length, start: 0 })
    }
    if (info.text(4) !== '8BIM') throw failure()
    const key = info.text(4)
    const opacity = info.u8(), clipping = info.u8(), flags = info.u8(), filler = info.u8()
    if (clipping !== 0) throw failure('包含剪贴图层，当前不能正确还原')
    if (filler !== 0 || (flags & 0xe0)) throw failure('包含非普通位图图层标记')
    const extra = readExtra(info.section(), index), divider = extra.section?.kind ?? 0
    if (flags & 1 && !extra.locked) throw failure('包含透明像素部分保护，当前仅支持完整锁定')
    const metadata: LayerPsdLayerMetadata = { name: extra.name, left, top, width: layerWidth, height: layerHeight, visible: !(flags & 2), opacity: opacity / 255, blend: blends[key] ?? 'source-over', ...(extra.locked !== undefined ? { locked: extra.locked } : {}) }
    const record: RecordLayer = { metadata, channels: descriptions, ...(divider ? { divider } : {}) }
    records.push(record)
    if (divider) {
      if (layerWidth || layerHeight || top || left || descriptions.some((channel) => channel.length !== 2) || opacity !== 255) throw failure('编组含独立像素、偏移或不透明度，当前仅支持原位穿透编组')
      if (key !== 'norm' && key !== 'pass') throw failure('编组使用不支持的混合模式')
      if (divider === 3) {
        if (groups.length >= maximumImageLayerGroups || stack.length >= maximumImageLayerGroupDepth) throw failure('最多导入 20 个组、4 层嵌套')
        const group = { id: `psd-group-${groups.length + 1}`, name: '图层组', children: [] as string[], visible: true, locked: false }
        stack.at(-1)?.children.push(group.id); groups.push(group); stack.push(group)
      } else {
        const group = stack.pop()
        if (!group) throw failure('编组分隔不成对')
        if ((extra.section?.blend ?? key) !== 'pass') throw failure('隔离混合编组暂不支持，请在原编辑器明确转换为穿透编组')
        group.name = extra.name; group.visible = metadata.visible; group.locked = !!metadata.locked
      }
    } else {
      if (!layerWidth || !layerHeight || flags & 8 && flags & 16) throw failure('图层边界为空或包含非普通位图标记')
      if (![0, 1, 2].every((id) => ids.has(id))) throw failure('图层缺少 RGB 通道')
      if (!Object.prototype.hasOwnProperty.call(blends, key)) throw failure('包含不支持的混合模式；当前支持正常、正片叠底、滤色和叠加')
      pixels += layerWidth * layerHeight
      if (pixels > maximumLayerPsdPixels) throw failure('分层总像素超过容量，请减少图层或缩小图片；不会自动降低分辨率')
      const id = `psd-layer-${leafRecords.length + 1}`
      layerIds.push(id); stack.at(-1)?.children.push(id); leafRecords.push(record)
    }
  }
  if (stack.length) throw failure('编组分隔不成对')
  if (!leafRecords.length) throw failure('没有可导入的独立图层，不会以合成预览代替图层')
  if (leafRecords.length > maximumImportedPsdLayers) throw failure(`包含 ${leafRecords.length} 个图层，最多导入 20 个；导出文件中的独立背景也计为一层，请先合并或移除多余图层`)
  const layerGroups = groups.length ? parseImageLayerGroups({ version: 1, layerIds, groups }, leafRecords.length) : undefined
  for (const record of records) for (const channel of record.channels) { channel.start = info.offset; info.take(channel.length) }
  // Some PSD writers align this even-sized section to four bytes. Accept only
  // the bounded zero padding, never another record or unparsed payload.
  info.finish(3)
  if (layerSection.offset < layerSection.end) {
    const globalMask = layerSection.section()
    if (globalMask.offset !== globalMask.end) throw failure('包含全局蒙版，当前不能正确还原')
  }
  layerSection.finish()
  // A PSD's merged preview has one shared compression header and RLE row table.
  // Validate it without allocating it; import uses the straight per-layer planes.
  const compositeCompression = reader.u16()
  if (compositeCompression !== 0 && compositeCompression !== 1) throw failure('合成预览使用不支持的 ZIP 压缩，请另存原始或 RLE PSD')
  if (compositeCompression === 0) { reader.take(width * height * channels); reader.finish() }
  else {
    const rowLengths = Array.from({ length: height * channels }, () => reader.u16())
    let work = 0
    for (const length of rowLengths) {
      check(options)
      const row = reader.section(length); let expanded = 0
      while (row.offset < row.end) { const control = row.u8(); if (control === 128) continue; const length = control < 128 ? control + 1 : 257 - control; row.take(control < 128 ? length : 1); expanded += length; if (expanded > width) throw failure('合成 RLE 行越界') }
      if (expanded !== width) throw failure('合成 RLE 行像素不足')
      work += length + width
      if (work >= 65536) { work = 0; await pause(options); check(options) }
    }
    reader.finish()
  }
  for (const record of records) for (const channel of record.channels) await decodeChannel(bytes, channel, record.metadata.width, record.metadata.height, options)
  check(options)
  let reading = false
  return {
    width, height, layers: leafRecords.map(({ metadata }) => ({ ...metadata })), ...(layerGroups ? { layerGroups } : {}), warnings: [],
    async readLayer(index) {
      check(options)
      if (!Number.isSafeInteger(index) || index < 0 || index >= leafRecords.length || reading) throw failure('读取顺序无效，请逐层读取')
      reading = true
      try {
        const record = leafRecords[index], data = new Uint8ClampedArray(record.metadata.width * record.metadata.height * 4)
        if (!record.channels.some(({ id }) => id === -1)) for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255
        for (const channel of record.channels) await decodeChannel(bytes, channel, record.metadata.width, record.metadata.height, options, data, channel.id === -1 ? 3 : channel.id)
        check(options)
        return { ...record.metadata, data }
      } finally { reading = false }
    },
  }
}

export async function readLayerPsd(bytes: Uint8Array, options: LayerPsdReadOptions = {}): Promise<LayerPsdDocument> {
  const document = await openLayerPsd(bytes, options), layers: ImportedLayerPsdPixels[] = []
  for (let index = 0; index < document.layers.length; index++) layers.push(await document.readLayer(index))
  return { width: document.width, height: document.height, layers, ...(document.layerGroups ? { layerGroups: document.layerGroups } : {}), warnings: [...document.warnings] }
}
