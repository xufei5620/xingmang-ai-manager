import type { ImageCropRecipe } from './recipe'
import type { ImageTransformSize } from './geometry'

function clamp(value: number, low: number, high: number): number { return Math.max(low, Math.min(high, value)) }

export function cropPixelRatio(recipe: ImageCropRecipe, source: ImageTransformSize): number {
  return recipe.width * source.width / (recipe.height * source.height)
}

export function fitCropRatio(recipe: ImageCropRecipe, source: ImageTransformSize, ratio: number): ImageCropRecipe {
  if (!Number.isFinite(ratio) || ratio <= 0) return recipe
  const normalized = ratio * source.height / source.width
  const width = Math.min(1, normalized), height = Math.min(1, 1 / normalized)
  if (width < .0001 || height < .0001) throw new Error('当前图片尺寸下无法使用这个裁剪比例，请调整比例')
  const cx = recipe.x + recipe.width / 2, cy = recipe.y + recipe.height / 2
  return { ...recipe, x: clamp(cx - width / 2, 0, 1 - width), y: clamp(cy - height / 2, 0, 1 - height), width, height }
}

function snap(value: number, candidates: number[], tolerance: number): number {
  let best = value, distance = tolerance
  for (const candidate of candidates) {
    const delta = Math.abs(candidate - value)
    if (delta <= distance) { best = candidate; distance = delta }
  }
  return best
}

export function moveCrop(recipe: ImageCropRecipe, dx: number, dy: number, tolerance?: { x: number; y: number }): ImageCropRecipe {
  let x = clamp(recipe.x + dx, 0, 1 - recipe.width), y = clamp(recipe.y + dy, 0, 1 - recipe.height)
  if (tolerance) {
    x = snap(x, [0, (1 - recipe.width) / 2, 1 - recipe.width], tolerance.x)
    y = snap(y, [0, (1 - recipe.height) / 2, 1 - recipe.height], tolerance.y)
  }
  return { ...recipe, x, y }
}

export function resizeCrop(recipe: ImageCropRecipe, width: number, height: number, source: ImageTransformSize, ratio: number | null, axis: 'width' | 'height' = 'width'): ImageCropRecipe {
  let w = clamp(width, .0001, 1 - recipe.x), h = clamp(height, .0001, 1 - recipe.y)
  if (ratio && Number.isFinite(ratio) && ratio > 0) {
    const normalized = ratio * source.height / source.width
    const minimumWidth = Math.max(.0001, .0001 * normalized)
    const maximumWidth = Math.min(1 - recipe.x, (1 - recipe.y) * normalized)
    if (maximumWidth < minimumWidth) return recipe
    w = clamp(axis === 'width' ? w : h * normalized, minimumWidth, maximumWidth)
    h = w / normalized
    return { ...recipe, width: w, height: h }
  }
  return { ...recipe, width: Math.max(.0001, w), height: Math.max(.0001, h) }
}

export function resizeCropOutput(recipe: ImageCropRecipe, edge: 'width' | 'height', value: number, lockedRatio: number | null): ImageCropRecipe {
  let width = edge === 'width' ? clamp(Math.round(value), 1, 4096) : recipe.outputWidth
  let height = edge === 'height' ? clamp(Math.round(value), 1, 4096) : recipe.outputHeight
  if (lockedRatio !== null && Number.isFinite(lockedRatio) && lockedRatio > 0) {
    // The editor owns this stable ratio. Recomputing from rounded intermediate
    // sizes makes typing 2048 through 2/20/204 silently change the aspect.
    if (edge === 'width') height = Math.max(1, Math.round(width / lockedRatio))
    else width = Math.max(1, Math.round(height * lockedRatio))
    const scale = Math.min(1, 4096 / width, 4096 / height)
    width = Math.max(1, Math.round(width * scale)); height = Math.max(1, Math.round(height * scale))
  }
  return { ...recipe, outputWidth: width, outputHeight: height }
}

export function cropOutputRatio(recipe: ImageCropRecipe, sourceRatio: number): number {
  const ratio = recipe.rotation === 90 || recipe.rotation === 270 ? 1 / sourceRatio : sourceRatio
  if (!Number.isFinite(ratio) || ratio < 1 / 4096 || ratio > 4096) throw new Error('当前裁剪比例超出输出尺寸支持范围，请使用 1:4096 至 4096:1 之间的比例')
  return ratio
}

export function syncCropOutput(recipe: ImageCropRecipe, source: ImageTransformSize, longestEdge?: number, exactSourceRatio?: number): ImageCropRecipe {
  const width = Math.min(source.width, Math.ceil((recipe.x + recipe.width) * source.width)) - Math.floor(recipe.x * source.width)
  const height = Math.min(source.height, Math.ceil((recipe.y + recipe.height) * source.height)) - Math.floor(recipe.y * source.height)
  const rotated = recipe.rotation === 90 || recipe.rotation === 270
  let w = rotated ? height : width, h = rotated ? width : height
  if (exactSourceRatio !== undefined) {
    const ratio = cropOutputRatio(recipe, exactSourceRatio), edge = Math.max(w, h)
    // Pixel bounding boxes and rounded output dimensions are not the user's
    // chosen ratio. Keep that ratio separate from their integer approximation.
    w = Math.min(edge, edge * ratio); h = Math.min(edge, edge / ratio)
  }
  const scale = longestEdge ? Math.min(4096, longestEdge) / Math.max(w, h) : Math.min(1, 4096 / Math.max(w, h))
  w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale))
  return { ...recipe, outputWidth: w, outputHeight: h }
}

export function rotateCrop(recipe: ImageCropRecipe, clockwise: boolean): ImageCropRecipe {
  return { ...recipe, rotation: ((recipe.rotation + (clockwise ? 90 : 270)) % 360) as ImageCropRecipe['rotation'], outputWidth: recipe.outputHeight, outputHeight: recipe.outputWidth }
}
