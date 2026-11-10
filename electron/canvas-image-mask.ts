import { createDeflate } from 'node:zlib'
import type { CanvasImageEditMask, CanvasImageEditMaskStroke } from './canvas-run-contract'

// 蒙版局部修改（画布完善第 5 条）。画布里涂的是一串笔画（xingmang-canvas
// image-tools/image-edit-mask.ts），主进程按同一套几何画成像素，再做成中转
// /v1/images/edits 认的 mask：PNG、和原图一样大、透明的地方重画
// （docs/RECON-image-generation.md §5）。笔画数、点数、64 KB 这几道上限和内核
// 一字不差，canvas-image-mask.test.ts 拿内核那份对拍，钉住两边画出来的像素一样。

export const maximumCanvasImageEditMaskEdge = 4096
const maximumMaskPixels = 16_777_216
const maximumMaskBytes = 64 * 1024
const maximumMaskStrokes = 128
const maximumMaskPoints = 4096
const maximumScannedRows = 4_000_000
/** OpenAI's edits endpoint refuses a mask file of 4 MB or more. */
export const maximumCanvasImageMaskPngBytes = 4 * 1024 * 1024

export interface CanvasImageEditMaskRaster { width: number; height: number; bits: Uint8Array; editedPixels: number }

// The kernel's list (imageEditMaskModelSupported). gpt-image-2.5 is left out
// there too: nobody has checked that the relay passes its mask through.
const maskModels = new Set(['gpt-image-1', 'gpt-image-2', 'gpt-image-2-2026-04-21'])

function maskRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error('局部修改蒙版包含无效或未知参数')
  }
  return value as Record<string, unknown>
}

function unitValue(value: unknown, nonzero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1 || (nonzero && value === 0)) {
    throw new Error('局部修改蒙版笔画坐标或大小不正确')
  }
  return value
}

export function parseCanvasImageEditMask(value: unknown): CanvasImageEditMask {
  const raw = maskRecord(value, ['version', 'sourceAssetId', 'width', 'height', 'strokes'])
  const width = raw.width
  const height = raw.height
  if (
    raw.version !== 1
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || (width as number) < 1 || (height as number) < 1
    || (width as number) > maximumCanvasImageEditMaskEdge || (height as number) > maximumCanvasImageEditMaskEdge
    || (width as number) * (height as number) > maximumMaskPixels
  ) {
    throw new Error('局部修改蒙版尺寸无效，最长边不能超过 4096 像素')
  }
  if (raw.sourceAssetId !== undefined && (typeof raw.sourceAssetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.sourceAssetId))) {
    throw new Error('局部修改蒙版绑定的原图编号无效')
  }
  if (!Array.isArray(raw.strokes) || raw.strokes.length > maximumMaskStrokes) throw new Error('局部修改蒙版最多保存 128 条笔画')
  let pointCount = 0
  const strokes = raw.strokes.map((entry): CanvasImageEditMaskStroke => {
    const stroke = maskRecord(entry, ['tool', 'size', 'points'])
    if (stroke.tool !== 'brush' && stroke.tool !== 'erase') throw new Error('局部修改蒙版画笔类型不正确')
    if (!Array.isArray(stroke.points) || stroke.points.length === 0) throw new Error('局部修改蒙版笔画过于复杂，请减少笔画后重试')
    pointCount += stroke.points.length
    if (pointCount > maximumMaskPoints) throw new Error('局部修改蒙版笔画过于复杂，请减少笔画后重试')
    return {
      tool: stroke.tool,
      size: unitValue(stroke.size, true),
      points: stroke.points.map((point) => {
        const parsed = maskRecord(point, ['x', 'y'])
        return { x: unitValue(parsed.x), y: unitValue(parsed.y) }
      }),
    }
  })
  const mask: CanvasImageEditMask = {
    version: 1,
    ...(typeof raw.sourceAssetId === 'string' ? { sourceAssetId: raw.sourceAssetId } : {}),
    width: width as number,
    height: height as number,
    strokes,
  }
  if (Buffer.byteLength(JSON.stringify(mask), 'utf8') > maximumMaskBytes) throw new Error('局部修改蒙版数据超过 64 KB，请减少笔画后重试')
  return mask
}

export function canvasImageEditMaskModelSupported(model: string): boolean {
  return maskModels.has(model)
}

function writeSpan(bits: Uint8Array, start: number, end: number, paint: boolean): void {
  let index = start
  while (index < end && index % 8) {
    if (paint) bits[index >> 3] |= 1 << (index & 7)
    else bits[index >> 3] &= ~(1 << (index & 7))
    index += 1
  }
  const alignedEnd = end - (end % 8)
  if (alignedEnd > index) {
    bits.fill(paint ? 255 : 0, index >> 3, alignedEnd >> 3)
    index = alignedEnd
  }
  while (index < end) {
    if (paint) bits[index >> 3] |= 1 << (index & 7)
    else bits[index >> 3] &= ~(1 << (index & 7))
    index += 1
  }
}

/**
 * Pixel-centre binary capsules, the same geometry as the kernel's
 * rasterizeImageEditMask: what the relay repaints is exactly what the user saw
 * shaded in the editor. Any change here has to land in the kernel first.
 */
export function rasterizeCanvasImageEditMask(value: CanvasImageEditMask): CanvasImageEditMaskRaster {
  const mask = parseCanvasImageEditMask(value)
  const bits = new Uint8Array(Math.ceil((mask.width * mask.height) / 8))
  let scannedRows = 0
  for (const stroke of mask.strokes) {
    const radius = Math.max(0.5, (stroke.size * Math.min(mask.width, mask.height)) / 2)
    for (let index = 0; index < Math.max(1, stroke.points.length - 1); index += 1) {
      const a = stroke.points[index]
      const b = stroke.points[Math.min(index + 1, stroke.points.length - 1)]
      const ax = a.x * mask.width
      const ay = a.y * mask.height
      const bx = b.x * mask.width
      const by = b.y * mask.height
      const dx = bx - ax
      const dy = by - ay
      const length = Math.hypot(dx, dy)
      const nx = length ? (-dy * radius) / length : 0
      const ny = length ? (dx * radius) / length : 0
      const corners = [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]
      const startY = Math.max(0, Math.ceil(Math.min(ay, by) - radius - 0.5))
      const endY = Math.min(mask.height - 1, Math.floor(Math.max(ay, by) + radius - 0.5))
      scannedRows += endY - startY + 1
      if (scannedRows > maximumScannedRows) throw new Error('局部修改蒙版笔画过于复杂，请减少重复笔画后重试')
      for (let y = startY; y <= endY; y += 1) {
        const py = y + 0.5
        let left = Infinity
        let right = -Infinity
        for (const [cx, cy] of [[ax, ay], [bx, by]]) {
          const distance = Math.abs(py - cy)
          if (distance <= radius) {
            const extent = Math.sqrt(Math.max(0, radius * radius - distance * distance))
            left = Math.min(left, cx - extent)
            right = Math.max(right, cx + extent)
          }
        }
        if (length) {
          for (let side = 0; side < 4; side += 1) {
            const from = corners[side]
            const to = corners[(side + 1) % 4]
            if (from[1] === to[1]) {
              if (py === from[1]) {
                left = Math.min(left, from[0], to[0])
                right = Math.max(right, from[0], to[0])
              }
              continue
            }
            if (py < Math.min(from[1], to[1]) || py > Math.max(from[1], to[1])) continue
            const x = from[0] + ((py - from[1]) * (to[0] - from[0])) / (to[1] - from[1])
            left = Math.min(left, x)
            right = Math.max(right, x)
          }
        }
        const start = Math.max(0, Math.ceil(left - 0.5))
        const end = Math.min(mask.width, Math.floor(right - 0.5) + 1)
        if (start < end) writeSpan(bits, y * mask.width + start, y * mask.width + end, stroke.tool === 'brush')
      }
    }
  }
  let editedPixels = 0
  for (const byte of bits) {
    let remaining = byte
    while (remaining) {
      remaining &= remaining - 1
      editedPixels += 1
    }
  }
  return { width: mask.width, height: mask.height, bits, editedPixels }
}

/**
 * The checks a run makes before it spends anything, the same as the kernel's
 * assertImageEditMaskInput plus an empty mask: a mask that no longer fits its
 * source never turns into an ordinary whole-image edit.
 */
export function assertCanvasImageEditMaskInput(
  mask: CanvasImageEditMask,
  model: string,
  sources: readonly { assetId?: string; width?: number; height?: number }[],
): void {
  if (!canvasImageEditMaskModelSupported(model)) throw new Error('当前模型尚未接通蒙版局部修改，请选择支持的 GPT Image 模型；不会改为整图生成')
  if (!mask.sourceAssetId) throw new Error('请打开蒙版编辑器，核对并绑定当前原图后再运行')
  if (sources.length !== 1 || sources[0].assetId !== mask.sourceAssetId) throw new Error('局部修改需要唯一且与蒙版绑定一致的原图；原图已变化，请重新核对蒙版')
  const source = sources[0]
  if ((source.width !== undefined && source.width !== mask.width) || (source.height !== undefined && source.height !== mask.height)) {
    throw new Error('原图像素尺寸与蒙版不一致，请重新核对蒙版后运行')
  }
  if (!mask.strokes.some((stroke) => stroke.tool === 'brush')) throw new Error('请先涂抹希望修改的区域，空蒙版不能生成')
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
}

const crcTable = buildCrcTable()
const keptPixel = Buffer.from([0, 0, 0, 255])

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4, 'ascii')
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (let index = 4; index < chunk.length - 4; index += 1) crc = crcTable[(crc ^ chunk[index]) & 255] ^ (crc >>> 8)
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}

async function deflateRows(width: number, height: number, raster: CanvasImageEditMaskRaster, signal?: AbortSignal): Promise<Buffer> {
  const deflater = createDeflate()
  const chunks: Buffer[] = []
  let total = 0
  const finished = new Promise<void>((resolve, reject) => {
    deflater.on('data', (chunk: Buffer) => {
      total += chunk.length
      // A mask this large is refused anyway; stop holding the output.
      if (total > maximumCanvasImageMaskPngBytes) deflater.destroy(new Error('蒙版太复杂，做成的蒙版图片超过 4 MB，请减少笔画后重试'))
      else chunks.push(chunk)
    })
    deflater.once('end', resolve)
    deflater.once('error', reject)
  })
  // Unhandled until awaited below, and a write after destroy rejects it early.
  finished.catch(() => undefined)
  const rowBytes = 1 + width * 4
  try {
    for (let y = 0; y < height; y += 1) {
      if (signal?.aborted) throw signal.reason ?? new Error('运行已取消')
      if (deflater.destroyed) break
      // Filter byte 0, then RGBA: opaque black keeps a pixel, alpha 0 repaints it.
      const row = Buffer.alloc(rowBytes)
      row.fill(keptPixel, 1)
      const first = y * width
      for (let x = 0; x < width; x += 1) {
        const index = first + x
        if (raster.bits[index >> 3] & (1 << (index & 7))) row[1 + x * 4 + 3] = 0
      }
      if (!deflater.write(row)) {
        // close covers a destroy while waiting, which never drains.
        await new Promise<void>((resolve) => {
          deflater.once('drain', resolve)
          deflater.once('close', resolve)
        })
      }
    }
    if (!deflater.destroyed) deflater.end()
    await finished
  } catch (error) {
    deflater.destroy()
    throw error
  }
  return Buffer.concat(chunks)
}

/**
 * The PNG the relay receives as `mask`: 8-bit RGBA at the source's exact size,
 * fully transparent where the user painted and opaque elsewhere. RGBA rather
 * than the kernel's 1-bit export because the edits endpoint reads the alpha
 * channel. Rows are compressed one at a time, so a 4096 x 4096 mask never sits
 * in memory uncompressed.
 */
export async function buildCanvasImageMaskPng(value: CanvasImageEditMask, signal?: AbortSignal): Promise<Buffer> {
  const raster = rasterizeCanvasImageEditMask(value)
  if (!raster.editedPixels) throw new Error('请先涂抹希望修改的区域，空蒙版不能生成')
  const header = Buffer.alloc(13)
  header.writeUInt32BE(raster.width, 0)
  header.writeUInt32BE(raster.height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: truecolour with alpha
  const compressed = await deflateRows(raster.width, raster.height, raster, signal)
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  if (png.length >= maximumCanvasImageMaskPngBytes) throw new Error('蒙版太复杂，做成的蒙版图片超过 4 MB，请减少笔画后重试')
  return png
}
