import { parseImageEditMask, type ImageEditMask } from './image-edit-mask'

export interface ImageMaskHistory { present: ImageEditMask; past: ImageEditMask[]; future: ImageEditMask[] }
export type ImageMaskPoint = ImageEditMask['strokes'][number]['points'][number]

export function createImageMaskHistory(mask: ImageEditMask): ImageMaskHistory {
  return { present: parseImageEditMask(mask), past: [], future: [] }
}

export function commitImageMask(history: ImageMaskHistory, mask: ImageEditMask): ImageMaskHistory {
  const next = parseImageEditMask(mask)
  if (JSON.stringify(next) === JSON.stringify(history.present)) return history
  return { present: next, past: [...history.past, history.present].slice(-32), future: [] }
}

export function undoImageMask(history: ImageMaskHistory): ImageMaskHistory {
  const previous = history.past.at(-1)
  return previous ? { present: previous, past: history.past.slice(0, -1), future: [history.present, ...history.future].slice(0, 32) } : history
}

export function redoImageMask(history: ImageMaskHistory): ImageMaskHistory {
  const next = history.future[0]
  return next ? { present: next, past: [...history.past, history.present].slice(-32), future: history.future.slice(1) } : history
}

/** The overlay exactly covers the displayed image, never its letterbox. */
export function imageMaskPoint(client: { x: number; y: number }, rect: { left: number; top: number; width: number; height: number }): ImageMaskPoint | null {
  if (![client.x, client.y, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null
  const bounded = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000
  return { x: bounded((client.x - rect.left) / rect.width), y: bounded((client.y - rect.top) / rect.height) }
}

export function imageMaskPointNeeded(previous: ImageMaskPoint, next: ImageMaskPoint, mask: Pick<ImageEditMask, 'width' | 'height'>, size: number): boolean {
  return Math.hypot((next.x - previous.x) * mask.width, (next.y - previous.y) * mask.height) >= Math.max(1, size * Math.min(mask.width, mask.height) / 5)
}

export function imageMaskBindingMatches(mask: ImageEditMask, source: { assetId?: string; width?: number; height?: number }): boolean {
  return Boolean(source.assetId && mask.sourceAssetId === source.assetId && mask.width === source.width && mask.height === source.height)
}

export function rebindImageMask(mask: ImageEditMask, source: { assetId: string; width: number; height: number }): ImageEditMask {
  return parseImageEditMask({ ...mask, sourceAssetId: source.assetId, width: source.width, height: source.height })
}
