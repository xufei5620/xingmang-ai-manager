import { parseImageTransformRecipe, type ImageLayerRecipe } from './recipe'
import { maximumLayerDocumentEdge, resolveLayerDocumentFrame, type LayerDocumentSize } from './layer-document-geometry'

export interface LayerDocumentCropRect { x: number; y: number; width: number; height: number }
export type LayerDocumentCropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
interface Point { x: number; y: number }

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)) }
function size(output: LayerDocumentSize): void { if (![output.width, output.height].every((value) => Number.isInteger(value) && value >= 1 && value <= maximumLayerDocumentEdge)) throw new Error('裁剪画布宽高必须为 1–4096 的整数像素') }
function finite(values: number[]): void { if (!values.every(Number.isFinite)) throw new Error('裁剪范围包含无效坐标，请重新框选') }
function assertRect(rect: LayerDocumentCropRect, output: LayerDocumentSize): void {
  size(output)
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || rect.x + rect.width > output.width || rect.y + rect.height > output.height) throw new Error('裁剪范围必须位于当前画布内，且至少包含 1 × 1 个完整像素')
}

/** Pointer drafts clamp to reachable integer pixels. The commit below validates
 * strictly instead, so a stale or malformed payload cannot silently crop elsewhere. */
export function normalizeLayerDocumentCrop(rect: LayerDocumentCropRect, output: LayerDocumentSize): LayerDocumentCropRect {
  size(output); finite([rect.x, rect.y, rect.width, rect.height])
  const x = clamp(Math.round(rect.x), 0, output.width - 1), y = clamp(Math.round(rect.y), 0, output.height - 1)
  return { x, y, width: clamp(Math.round(rect.width), 1, output.width - x), height: clamp(Math.round(rect.height), 1, output.height - y) }
}

export function buildLayerDocumentCrop(start: Point, end: Point, output: LayerDocumentSize): LayerDocumentCropRect | null {
  size(output); finite([start.x, start.y, end.x, end.y])
  const left = clamp(Math.round(Math.min(start.x, end.x)), 0, output.width), top = clamp(Math.round(Math.min(start.y, end.y)), 0, output.height)
  const right = clamp(Math.round(Math.max(start.x, end.x)), 0, output.width), bottom = clamp(Math.round(Math.max(start.y, end.y)), 0, output.height)
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null
}

export function moveLayerDocumentCrop(rect: LayerDocumentCropRect, delta: Point, output: LayerDocumentSize): LayerDocumentCropRect {
  assertRect(rect, output); finite([delta.x, delta.y])
  return { ...rect, x: clamp(Math.round(rect.x + delta.x), 0, output.width - rect.width), y: clamp(Math.round(rect.y + delta.y), 0, output.height - rect.height) }
}

export function resizeLayerDocumentCrop(rect: LayerDocumentCropRect, handle: LayerDocumentCropHandle, delta: Point, output: LayerDocumentSize): LayerDocumentCropRect {
  assertRect(rect, output); finite([delta.x, delta.y])
  if (!['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].includes(handle)) throw new Error('裁剪控制点无效')
  let left = rect.x, top = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height
  if (handle.includes('w')) left = clamp(Math.round(left + delta.x), 0, right - 1)
  if (handle.includes('e')) right = clamp(Math.round(right + delta.x), left + 1, output.width)
  if (handle.includes('n')) top = clamp(Math.round(top + delta.y), 0, bottom - 1)
  if (handle.includes('s')) bottom = clamp(Math.round(bottom + delta.y), top + 1, output.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function cropLayerDocumentRecipe(recipe: ImageLayerRecipe, rect: LayerDocumentCropRect): ImageLayerRecipe {
  assertRect(rect, { width: recipe.outputWidth, height: recipe.outputHeight })
  if (!rect.x && !rect.y && rect.width === recipe.outputWidth && rect.height === recipe.outputHeight) return recipe
  if (!recipe.explicitLayers && !recipe.layers.length) throw new Error('请先打开图层编辑器确认全部来源，再裁剪文档；原图层没有更改')
  const frame = resolveLayerDocumentFrame(recipe)
  const candidate: ImageLayerRecipe = { ...recipe, outputWidth: rect.width, outputHeight: rect.height, explicitLayers: true,
    documentFrame: { ...frame, offsetX: frame.offsetX + rect.x, offsetY: frame.offsetY + rect.y },
    layers: recipe.layers.map((layer) => ({ ...layer,
      x: (layer.x * recipe.outputWidth - rect.x) / rect.width, y: (layer.y * recipe.outputHeight - rect.y) / rect.height,
      width: layer.width * recipe.outputWidth / rect.width, height: layer.height * recipe.outputHeight / rect.height,
    })),
  }
  const parsed = parseImageTransformRecipe(candidate)
  if (parsed.kind !== 'layer') throw new Error('图层文档参数无效')
  // Validation must not reserialize unrelated local operations or normalize
  // their colors merely because the document window changed.
  return candidate
}
