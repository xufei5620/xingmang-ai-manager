import { parseImageEditMask, rasterizeImageEditMask, readImageEditMaskPixel, type ImageEditMask } from './image-edit-mask'

export interface ImageMaskPng { blob: Blob; width: number; height: number }
export interface ImageMaskPngOptions { signal?: AbortSignal; yieldControl?: () => Promise<void> }

function crcTable(): Uint32Array<ArrayBuffer> {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
}
const crcValues = crcTable()

function pngChunk(type: string, bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(bytes.length + 12), view = new DataView(result.buffer)
  view.setUint32(0, bytes.length)
  for (let index = 0; index < 4; index++) result[index + 4] = type.charCodeAt(index)
  result.set(bytes, 8)
  let crc = 0xffffffff
  for (let index = 4; index < result.length - 4; index++) crc = crcValues[(crc ^ result[index]) & 255] ^ (crc >>> 8)
  view.setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0)
  return result
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('蒙版图片导出已取消', 'AbortError')
}
function yieldToBrowser(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)) }

/** A binary mask needs one grayscale bit, not a 64 MiB RGBA surface. PNG type 0
 * without tRNS is opaque: black preserves, white paints, decoded alpha is 255.
 * Stored DEFLATE blocks keep output deterministic and below 2.2 MiB at 4096²,
 * with bounded row chunks and cancellation without Canvas/compressor support. */
export async function encodeImageMaskPng(value: ImageEditMask, options: ImageMaskPngOptions = {}): Promise<ImageMaskPng> {
  assertActive(options.signal)
  const mask = parseImageEditMask(value), cooperate = options.yieldControl ?? yieldToBrowser
  await cooperate(); assertActive(options.signal)
  const raster = rasterizeImageEditMask(mask)
  if (!raster.editedPixels) throw new Error('蒙版没有可修改区域，请先涂抹后再导出图片')
  const rowBytes = Math.ceil(mask.width / 8) + 1, rowsPerBlock = Math.max(1, Math.floor(65535 / rowBytes))
  const header = new Uint8Array(13), dimensions = new DataView(header.buffer)
  dimensions.setUint32(0, mask.width); dimensions.setUint32(4, mask.height); header[8] = 1
  const parts: BlobPart[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header)]
  let adlerA = 1, adlerB = 0
  for (let firstRow = 0; firstRow < mask.height; firstRow += rowsPerBlock) {
    assertActive(options.signal)
    const rows = Math.min(rowsPerBlock, mask.height - firstRow), length = rows * rowBytes, final = firstRow + rows === mask.height
    const prefix = firstRow === 0 ? 2 : 0, bytes = new Uint8Array(prefix + 5 + length + (final ? 4 : 0)), view = new DataView(bytes.buffer)
    if (prefix) { bytes[0] = 0x78; bytes[1] = 0x01 }
    bytes[prefix] = final ? 1 : 0; view.setUint16(prefix + 1, length, true); view.setUint16(prefix + 3, length ^ 0xffff, true)
    for (let row = 0; row < rows; row++) {
      const start = prefix + 5 + row * rowBytes
      for (let x = 0; x < mask.width; x++) if (readImageEditMaskPixel(raster, x, firstRow + row)) bytes[start + 1 + (x >>> 3)] |= 1 << (7 - (x & 7))
    }
    for (let index = prefix + 5; index < prefix + 5 + length; index++) { adlerA = (adlerA + bytes[index]) % 65521; adlerB = (adlerB + adlerA) % 65521 }
    if (final) view.setUint32(bytes.length - 4, ((adlerB << 16) | adlerA) >>> 0)
    parts.push(pngChunk('IDAT', bytes))
    await cooperate(); assertActive(options.signal)
  }
  parts.push(pngChunk('IEND', new Uint8Array()))
  return { blob: new Blob(parts, { type: 'image/png' }), width: mask.width, height: mask.height }
}
