import type { ImageLayerRecipe } from './recipe'

export const maximumLayerDocumentEdge = 4096
export const maximumLayerPhysicalEdge = maximumLayerDocumentEdge * 4
export const maximumLayerPhysicalPosition = maximumLayerDocumentEdge * 2
export const minimumLayerPhysicalEdge = .001

/** A crop retains the original finite replay surface. Layer geometry remains
 * relative to the visible output; offsets locate that output in this surface. */
export interface ImageLayerDocumentFrame { version: 1; width: number; height: number; offsetX: number; offsetY: number }
export interface LayerDocumentSize { width: number; height: number }
export interface ImageLayerGeometryBounds { minPosition: number; maxPosition: number; minSize: number; maxSize: number }

function outputSize(output: LayerDocumentSize): void {
  if (![output.width, output.height].every((value) => Number.isInteger(value) && value >= 1 && value <= maximumLayerDocumentEdge)) throw new Error('图层画布宽高必须为 1–4096 的整数像素')
}

export function imageLayerGeometryBounds(outputAxis: number, frameOffset = 0): ImageLayerGeometryBounds {
  if (!Number.isInteger(outputAxis) || outputAxis < 1 || outputAxis > maximumLayerDocumentEdge || !Number.isInteger(frameOffset) || frameOffset < 0 || frameOffset >= maximumLayerDocumentEdge) throw new Error('图层坐标参考尺寸无效')
  return { minPosition: (-maximumLayerPhysicalPosition - frameOffset) / outputAxis, maxPosition: (maximumLayerPhysicalPosition - frameOffset) / outputAxis, minSize: minimumLayerPhysicalEdge / outputAxis, maxSize: maximumLayerPhysicalEdge / outputAxis }
}

export function parseImageLayerDocumentFrame(value: unknown, output: LayerDocumentSize): ImageLayerDocumentFrame {
  outputSize(output)
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['version', 'width', 'height', 'offsetX', 'offsetY'].includes(key))) throw new Error('图层文档参考框包含无效或不支持的字段')
  const input = value as Record<string, unknown>
  if (input.version !== 1) throw new Error('图层文档参考框版本不支持，请更新页面；原图层没有更改')
  if (![input.width, input.height].every((value) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maximumLayerDocumentEdge)
    || ![input.offsetX, input.offsetY].every((value) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < maximumLayerDocumentEdge)) throw new Error('图层文档参考框尺寸或偏移超出安全范围')
  const frame: ImageLayerDocumentFrame = { version: 1, width: input.width as number, height: input.height as number, offsetX: input.offsetX as number, offsetY: input.offsetY as number }
  if (frame.offsetX + output.width > frame.width || frame.offsetY + output.height > frame.height) throw new Error('图层文档参考框没有包含当前画布，请保留原尺寸或缩小画布')
  return frame
}

export function resolveLayerDocumentFrame(recipe: Pick<ImageLayerRecipe, 'outputWidth' | 'outputHeight' | 'documentFrame'>): ImageLayerDocumentFrame {
  const output = { width: recipe.outputWidth, height: recipe.outputHeight }
  outputSize(output)
  return recipe.documentFrame === undefined ? { version: 1, ...output, offsetX: 0, offsetY: 0 } : parseImageLayerDocumentFrame(recipe.documentFrame, output)
}

/** Manual document resizing keeps its existing normalized layer semantics.
 * Retained pixels outside a crop stay in the union; no reference frame is reset. */
export function resizeLayerDocumentFrame(frame: ImageLayerDocumentFrame, output: LayerDocumentSize): ImageLayerDocumentFrame {
  outputSize(output)
  const width = Math.max(frame.width, frame.offsetX + output.width), height = Math.max(frame.height, frame.offsetY + output.height)
  if (width > maximumLayerDocumentEdge || height > maximumLayerDocumentEdge) throw new Error('扩大后的文档参考框超过 4096 像素，请减小画布尺寸；原图层已保留')
  return parseImageLayerDocumentFrame({ ...frame, width, height }, output)
}

/** Replay old ordered effects on their original finite surface, then extract
 * the visible window. Deleting the frame makes recursive render calls finite. */
export function buildLayerDocumentReplayRecipe(recipe: ImageLayerRecipe): ImageLayerRecipe {
  if (recipe.documentFrame === undefined) return recipe
  const frame = resolveLayerDocumentFrame(recipe), { documentFrame: _frame, ...rest } = recipe
  return { ...rest, outputWidth: frame.width, outputHeight: frame.height, layers: recipe.layers.map((layer) => ({ ...layer,
    x: (layer.x * recipe.outputWidth + frame.offsetX) / frame.width,
    y: (layer.y * recipe.outputHeight + frame.offsetY) / frame.height,
    width: layer.width * recipe.outputWidth / frame.width,
    height: layer.height * recipe.outputHeight / frame.height,
  })) }
}
