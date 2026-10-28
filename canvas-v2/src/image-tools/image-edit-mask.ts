/** Pixel-center binary capsules. Changing geometry requires a new processor revision. */
export const imageEditMaskProcessorRevision = 'image-edit-mask-v1' as const
export const maximumImageEditMaskEdge = 4096
export const maximumImageEditMaskPixels = 16_777_216
export const maximumImageEditMaskBytes = 64 * 1024
export const maximumImageEditMaskStrokes = 128
export const maximumImageEditMaskPoints = 4096

export interface ImageEditMaskPoint { x: number; y: number }
export interface ImageEditMaskStroke { tool: 'brush' | 'erase'; size: number; points: ImageEditMaskPoint[] }
export interface ImageEditMask {
  version: 1
  sourceAssetId?: string
  width: number
  height: number
  strokes: ImageEditMaskStroke[]
}
export interface ImageEditMaskRaster { width: number; height: number; bits: Uint8Array; editedPixels: number }

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('局部修改蒙版包含无效或未知参数')
  return value as Record<string, unknown>
}

function unit(value: unknown, nonzero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1 || nonzero && value === 0) throw new Error('局部修改蒙版笔画坐标或大小不正确')
  return value
}

export function parseImageEditMask(value: unknown): ImageEditMask {
  const raw = record(value, ['version', 'sourceAssetId', 'width', 'height', 'strokes'])
  if (raw.version !== 1 || !Number.isSafeInteger(raw.width) || !Number.isSafeInteger(raw.height) || Number(raw.width) < 1 || Number(raw.height) < 1 || Number(raw.width) > maximumImageEditMaskEdge || Number(raw.height) > maximumImageEditMaskEdge || Number(raw.width) * Number(raw.height) > maximumImageEditMaskPixels) throw new Error('局部修改蒙版尺寸无效，最长边不能超过 4096 像素')
  if (raw.sourceAssetId !== undefined && (typeof raw.sourceAssetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.sourceAssetId))) throw new Error('局部修改蒙版绑定的原图编号无效')
  if (!Array.isArray(raw.strokes) || raw.strokes.length > maximumImageEditMaskStrokes) throw new Error('局部修改蒙版最多保存 128 条笔画')
  let pointCount = 0
  const strokes = raw.strokes.map((value): ImageEditMaskStroke => {
    const stroke = record(value, ['tool', 'size', 'points'])
    if (stroke.tool !== 'brush' && stroke.tool !== 'erase') throw new Error('局部修改蒙版画笔类型不正确')
    if (!Array.isArray(stroke.points) || !stroke.points.length || (pointCount += stroke.points.length) > maximumImageEditMaskPoints) throw new Error('局部修改蒙版笔画过于复杂，请减少笔画后重试')
    return { tool: stroke.tool, size: unit(stroke.size, true), points: stroke.points.map((value) => { const point = record(value, ['x', 'y']); return { x: unit(point.x), y: unit(point.y) } }) }
  })
  const result: ImageEditMask = { version: 1, ...(raw.sourceAssetId ? { sourceAssetId: String(raw.sourceAssetId) } : {}), width: Number(raw.width), height: Number(raw.height), strokes }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maximumImageEditMaskBytes) throw new Error('局部修改蒙版数据超过 64 KB，请减少笔画后重试')
  return result
}

export function portableImageEditMask(mask: ImageEditMask): ImageEditMask {
  const { sourceAssetId: ignored, ...portable } = parseImageEditMask(mask)
  return portable
}

export function imageEditMaskModelSupported(model: string): boolean {
  return ['gpt-image-1', 'gpt-image-2', 'gpt-image-2-2026-04-21'].includes(model)
}

export function readImageEditMaskPixel(raster: ImageEditMaskRaster, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return false
  const index = y * raster.width + x
  return Boolean(raster.bits[index >> 3] & (1 << (index & 7)))
}

function writeSpan(bits: Uint8Array, start: number, end: number, paint: boolean): void {
  while (start < end && start % 8) { if (paint) bits[start >> 3] |= 1 << (start & 7); else bits[start >> 3] &= ~(1 << (start & 7)); start++ }
  const alignedEnd = end - end % 8
  if (alignedEnd > start) { bits.fill(paint ? 255 : 0, start >> 3, alignedEnd >> 3); start = alignedEnd }
  while (start < end) { if (paint) bits[start >> 3] |= 1 << (start & 7); else bits[start >> 3] &= ~(1 << (start & 7)); start++ }
}

export function rasterizeImageEditMask(value: ImageEditMask): ImageEditMaskRaster {
  const mask = parseImageEditMask(value)
  const bits = new Uint8Array(Math.ceil(mask.width * mask.height / 8))
  let scannedRows = 0
  for (const stroke of mask.strokes) {
    const radius = Math.max(0.5, stroke.size * Math.min(mask.width, mask.height) / 2)
    for (let index = 0; index < Math.max(1, stroke.points.length - 1); index++) {
      const a = stroke.points[index]
      const b = stroke.points[Math.min(index + 1, stroke.points.length - 1)]
      const ax = a.x * mask.width, ay = a.y * mask.height, bx = b.x * mask.width, by = b.y * mask.height
      const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy)
      const nx = length ? -dy * radius / length : 0, ny = length ? dx * radius / length : 0
      const corners = [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]
      const startY = Math.max(0, Math.ceil(Math.min(ay, by) - radius - 0.5))
      const endY = Math.min(mask.height - 1, Math.floor(Math.max(ay, by) + radius - 0.5))
      scannedRows += endY - startY + 1
      if (scannedRows > 4_000_000) throw new Error('局部修改蒙版笔画过于复杂，请减少重复笔画后重试')
      for (let y = startY; y <= endY; y++) {
        const py = y + 0.5
        let left = Infinity, right = -Infinity
        for (const [cx, cy] of [[ax, ay], [bx, by]]) {
          const distance = Math.abs(py - cy)
          if (distance <= radius) { const extent = Math.sqrt(Math.max(0, radius * radius - distance * distance)); left = Math.min(left, cx - extent); right = Math.max(right, cx + extent) }
        }
        if (length) for (let side = 0; side < 4; side++) {
          const from = corners[side], to = corners[(side + 1) % 4]
          if (from[1] === to[1]) { if (py === from[1]) { left = Math.min(left, from[0], to[0]); right = Math.max(right, from[0], to[0]) }; continue }
          if (py < Math.min(from[1], to[1]) || py > Math.max(from[1], to[1])) continue
          const x = from[0] + (py - from[1]) * (to[0] - from[0]) / (to[1] - from[1])
          left = Math.min(left, x); right = Math.max(right, x)
        }
        const start = Math.max(0, Math.ceil(left - 0.5)), end = Math.min(mask.width, Math.floor(right - 0.5) + 1)
        if (start < end) writeSpan(bits, y * mask.width + start, y * mask.width + end, stroke.tool === 'brush')
      }
    }
  }
  let editedPixels = 0
  for (const byte of bits) { let value = byte; while (value) { value &= value - 1; editedPixels++ } }
  return { width: mask.width, height: mask.height, bits, editedPixels }
}

/** This check is also performed before cache reads: a stale mask never becomes an ordinary edit. */
export function assertImageEditMaskInput(mask: ImageEditMask, model: string, sources: readonly { assetId: string; width?: number; height?: number }[]): void {
  if (!imageEditMaskModelSupported(model)) throw new Error('当前模型尚未接通蒙版局部修改，请选择支持的 GPT Image 模型；不会改为整图生成')
  if (!mask.sourceAssetId) throw new Error('请打开蒙版编辑器，核对并绑定当前原图后再运行')
  if (sources.length !== 1 || sources[0].assetId !== mask.sourceAssetId) throw new Error('局部修改需要唯一且与蒙版绑定一致的原图；原图已变化，请重新核对蒙版')
  if (sources[0].width !== mask.width || sources[0].height !== mask.height) throw new Error('原图像素尺寸与蒙版不一致，请重新核对蒙版后运行')
}
