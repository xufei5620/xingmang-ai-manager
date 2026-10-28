import { normalizeLayerDocumentCrop, type LayerDocumentCropHandle, type LayerDocumentCropRect } from './layer-document-crop'

export type LayerDocumentCropRatio = readonly [number, number]
interface Size { width: number; height: number }
interface Point { x: number; y: number }
function clamp(value: number, minimum: number, maximum: number) { return Math.max(minimum, Math.min(maximum, value)) }
function ratioSize(ratio: LayerDocumentCropRatio, output: Size): [number, number] {
  if (ratio.length !== 2 || !ratio.every((value) => Number.isInteger(value) && value >= 1 && value <= 4096)) throw new Error('裁剪比例无效，请重新选择')
  normalizeLayerDocumentCrop({ x: 0, y: 0, width: 1, height: 1 }, output)
  let [a, b] = ratio
  while (b) { const next = a % b; a = b; b = next }
  return [ratio[0] / a, ratio[1] / a]
}
function assertFinite(...values: number[]) { if (!values.every(Number.isFinite)) throw new Error('裁剪坐标无效，请重新框选') }
function maximumScale(p: number, q: number, output: Size) { return Math.floor(Math.min(output.width / p, output.height / q)) }

/** Exact integer ratios avoid labelling a rounded 1x1 box as 16:9. Free crop
 * remains available when the document cannot fit a single ratio block. */
export function fitLayerDocumentCropRatio(rect: LayerDocumentCropRect, ratio: LayerDocumentCropRatio, output: Size): LayerDocumentCropRect | null {
  const [p, q] = ratioSize(ratio, output), maximum = maximumScale(p, q, output)
  if (maximum < 1) return null
  const before = normalizeLayerDocumentCrop(rect, output), scale = clamp(Math.floor(Math.min(before.width / p, before.height / q)), 1, maximum), width = scale * p, height = scale * q
  return { x: clamp(Math.round(before.x + before.width / 2 - width / 2), 0, output.width - width), y: clamp(Math.round(before.y + before.height / 2 - height / 2), 0, output.height - height), width, height }
}

export function buildLayerDocumentCropRatio(start: Point, end: Point, ratio: LayerDocumentCropRatio, output: Size): LayerDocumentCropRect | null {
  const [p, q] = ratioSize(ratio, output); assertFinite(start.x, start.y, end.x, end.y)
  const x = clamp(Math.round(start.x), 0, output.width), y = clamp(Math.round(start.y), 0, output.height), dx = end.x - start.x, dy = end.y - start.y
  if (Math.abs(dx) < .5 && Math.abs(dy) < .5) return null
  const sx = dx ? Math.sign(dx) : x <= output.width / 2 ? 1 : -1, sy = dy ? Math.sign(dy) : y <= output.height / 2 ? 1 : -1
  const maximum = Math.floor(Math.min((sx > 0 ? output.width - x : x) / p, (sy > 0 ? output.height - y : y) / q))
  if (maximum < 1) return null
  const scale = clamp(Math.round(Math.max(Math.abs(dx) / p, Math.abs(dy) / q)), 1, maximum), width = scale * p, height = scale * q
  return { x: sx > 0 ? x : x - width, y: sy > 0 ? y : y - height, width, height }
}

export function resizeLayerDocumentCropRatio(rect: LayerDocumentCropRect, handle: LayerDocumentCropHandle, delta: Point, ratio: LayerDocumentCropRatio, output: Size): LayerDocumentCropRect | null {
  const [p, q] = ratioSize(ratio, output); assertFinite(delta.x, delta.y)
  if (!['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].includes(handle)) throw new Error('裁剪控制点无效')
  const before = normalizeLayerDocumentCrop(rect, output)
  if (before.width * q !== before.height * p) throw new Error('裁剪框比例不一致，请重新选择比例')
  const sx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0, sy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0
  const anchorX = sx < 0 ? before.x + before.width : sx > 0 ? before.x : before.x + before.width / 2
  const anchorY = sy < 0 ? before.y + before.height : sy > 0 ? before.y : before.y + before.height / 2
  const maxWidth = sx < 0 ? anchorX : sx > 0 ? output.width - anchorX : 2 * Math.min(anchorX, output.width - anchorX)
  const maxHeight = sy < 0 ? anchorY : sy > 0 ? output.height - anchorY : 2 * Math.min(anchorY, output.height - anchorY)
  const maximum = Math.floor(Math.min(maxWidth / p, maxHeight / q))
  if (maximum < 1) return null
  const widthScale = (before.width + sx * delta.x) / p, heightScale = (before.height + sy * delta.y) / q
  const desired = !sy ? widthScale : !sx ? heightScale : Math.abs(delta.x / p) >= Math.abs(delta.y / q) ? widthScale : heightScale
  const scale = clamp(Math.round(desired), 1, maximum), width = scale * p, height = scale * q
  return { x: clamp(Math.round(sx < 0 ? anchorX - width : sx > 0 ? anchorX : anchorX - width / 2), 0, output.width - width), y: clamp(Math.round(sy < 0 ? anchorY - height : sy > 0 ? anchorY : anchorY - height / 2), 0, output.height - height), width, height }
}
