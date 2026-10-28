import { imageCollageInputCountError, imageCollageUsesAutoSize, maximumImageTransformEdge, type ImageCollageRecipe } from './recipe'
import type { ImageTransformSize, ImageTransformRect } from './geometry'
import { resolveImageCollageTemplate } from './collage-templates'

export interface CollageLayout extends ImageTransformSize { cells: ImageTransformRect[] }

function validSize(size: ImageTransformSize): boolean {
  return Number.isSafeInteger(size.width) && size.width > 0 && Number.isSafeInteger(size.height) && size.height > 0
}

/** Integer boundaries distribute remainder pixels without losing the final row/column. */
export function imageTransformGrid(size: ImageTransformSize, rows: number, columns: number, gap: number, padding: number): ImageTransformRect[] {
  if (!validSize(size) || !Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1 || rows > 8 || columns > 8
    || !Number.isSafeInteger(gap) || gap < 0 || !Number.isSafeInteger(padding) || padding < 0) throw new Error('图像网格参数无效')
  const usableWidth = size.width - padding * 2 - gap * (columns - 1)
  const usableHeight = size.height - padding * 2 - gap * (rows - 1)
  if (usableWidth < columns || usableHeight < rows) throw new Error('图片尺寸不足以容纳指定的宫格、间距和边距')
  return Array.from({ length: rows * columns }, (_, index) => {
    const row = Math.floor(index / columns), column = index % columns
    const left = Math.floor(usableWidth * column / columns), right = Math.floor(usableWidth * (column + 1) / columns)
    const top = Math.floor(usableHeight * row / rows), bottom = Math.floor(usableHeight * (row + 1) / rows)
    return { x: padding + left + column * gap, y: padding + top + row * gap, width: right - left, height: bottom - top }
  })
}


function assertSources(sources: readonly ImageTransformSize[]): void {
  if (!sources.length || sources.length > 20 || sources.some((source) => !validSize(source) || source.width > 16_384 || source.height > 16_384)) throw new Error('请等待输入图片的真实尺寸就绪后再使用该拼图布局')
}

/** Uses EXIF-normalised source dimensions; no asset metadata or recipe mutation. */
export function resolveCollageOutputSize(sources: readonly ImageTransformSize[], recipe: ImageCollageRecipe): ImageTransformSize {
  if (!imageCollageUsesAutoSize(recipe)) return { width: recipe.outputWidth, height: recipe.outputHeight }
  assertSources(sources)
  const horizontal = recipe.layout === 'horizontal'
  const cross = Math.max(...sources.map((source) => horizontal ? source.height : source.width))
  const span = sources.reduce((sum, source) => sum + cross * (horizontal ? source.width / source.height : source.height / source.width), 0)
  const rawWidth = (horizontal ? span + recipe.gap * (sources.length - 1) : cross) + recipe.padding * 2
  const rawHeight = (horizontal ? cross : span + recipe.gap * (sources.length - 1)) + recipe.padding * 2
  const scale = Math.min(1, maximumImageTransformEdge / rawWidth, maximumImageTransformEdge / rawHeight)
  return { width: Math.max(1, Math.round(rawWidth * scale)), height: Math.max(1, Math.round(rawHeight * scale)) }
}

function weightedCells(size: ImageTransformSize, weights: readonly number[], horizontal: boolean, gap: number, padding: number): ImageTransformRect[] {
  const length = (horizontal ? size.width : size.height) - padding * 2 - gap * (weights.length - 1)
  const cross = (horizontal ? size.height : size.width) - padding * 2
  if (length < weights.length || cross < 1) throw new Error('图片尺寸不足以容纳当前拼图布局、间距和边距')
  const total = weights.reduce((sum, value) => sum + value, 0)
  let accumulated = 0
  return weights.map((weight, index) => {
    const start = Math.floor(length * accumulated / total)
    accumulated += weight
    const end = index === weights.length - 1 ? length : Math.floor(length * accumulated / total)
    if (end <= start) throw new Error('输入图片比例差异过大，当前输出尺寸无法为每张图片分配有效像素')
    return horizontal
      ? { x: padding + start + gap * index, y: padding, width: end - start, height: cross }
      : { x: padding, y: padding + start + gap * index, width: cross, height: end - start }
  })
}

/** Every source gets one cell. Remainder pixels belong to cumulative boundaries. */
export function buildCollageLayout(sources: readonly ImageTransformSize[], recipe: ImageCollageRecipe): CollageLayout {
  const layout = recipe.layout ?? 'grid'
  const size = resolveCollageOutputSize(sources, recipe)
  if (!validSize(size) || size.width > maximumImageTransformEdge || size.height > maximumImageTransformEdge) throw new Error('拼图输出尺寸无效')
  const countError = imageCollageInputCountError(recipe, sources.length)
  if (countError) throw new Error(countError.endsWith('不会自动丢弃图片') ? countError : `${countError}；不会自动丢弃图片`)
  if (layout === 'grid') return { ...size, cells: imageTransformGrid(size, recipe.rows, recipe.columns, recipe.gap, recipe.padding) }
  assertSources(sources)
  let gap = recipe.gap, padding = recipe.padding
  if (imageCollageUsesAutoSize(recipe)) {
    const horizontal = layout === 'horizontal'
    const cross = Math.max(...sources.map((source) => horizontal ? source.height : source.width))
    const span = sources.reduce((sum, source) => sum + cross * (horizontal ? source.width / source.height : source.height / source.width), 0)
    const rawWidth = (horizontal ? span + gap * (sources.length - 1) : cross) + padding * 2
    const rawHeight = (horizontal ? cross : span + gap * (sources.length - 1)) + padding * 2
    const scale = Math.min(1, maximumImageTransformEdge / rawWidth, maximumImageTransformEdge / rawHeight)
    gap = Math.floor(gap * scale)
    padding = Math.floor(padding * scale)
  }
  if (layout === 'horizontal' || layout === 'vertical') {
    return { ...size, cells: weightedCells(size, sources.map((source) => layout === 'horizontal' ? source.width / source.height : source.height / source.width), layout === 'horizontal', gap, padding) }
  }
  const template = resolveImageCollageTemplate(layout)
  if (template) {
    const primary = weightedCells(size, template.weights, template.direction === 'horizontal', gap, padding)
    if (!template.secondaryDirection) return { ...size, cells: primary }
    const side = primary[1]
    const secondary = weightedCells(side, [1, 1], template.secondaryDirection === 'horizontal', gap, 0)
    return { ...size, cells: [primary[0], ...secondary.map((cell) => ({ ...cell, x: cell.x + side.x, y: cell.y + side.y }))] }
  }
  const horizontal = layout === 'hero-left'
  const main = weightedCells(size, [2, 1], horizontal, gap, padding)
  const side = main[1]
  const secondary = imageTransformGrid({ width: side.width, height: side.height }, horizontal ? sources.length - 1 : 1, horizontal ? 1 : sources.length - 1, gap, 0)
  return { ...size, cells: [main[0], ...secondary.map((cell) => ({ ...cell, x: cell.x + side.x, y: cell.y + side.y }))] }
}
