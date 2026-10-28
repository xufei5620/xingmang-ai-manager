import { buildCollageLayout, imageTransformGrid } from './collage-layout'
import type { ImageLayerColorGrade } from './layer-color-grade'
import { materializeImageLayerGroups } from './layer-group-model'
export { imageTransformGrid } from './collage-layout'
import { imageTransformRecipeNeedsSources, maximumImageTransformEdge, maximumImageTransformInputs, maximumImageTransformOutputs, maximumImageTransformPixels, maximumImageTransformTotalPixels, parseImageLayerSelection, parseImageTransformRecipe, type ImageCollageWatermark, type ImageBlendMode, type ImageFit, type ImageLayer, type ImageLayerAdjustments, type ImageLayerContent, type ImageLayerEdits, type ImageLayerRaster, type ImageLayerRecipe, type ImageLayerSelection, type ImageTransformRecipe } from './recipe'

export interface ImageTransformSize { width: number; height: number }
export interface ImageTransformRect extends ImageTransformSize { x: number; y: number }
export interface ImageTransformDraw {
  sourceIndex: number
  source: ImageTransformRect
  destination: ImageTransformRect
  /** Clockwise rotation about the destination centre, followed by output-axis flips. */
  rotation: number
  flipX: boolean
  flipY: boolean
  opacity: number
  blend: ImageBlendMode
  adjustments?: ImageLayerAdjustments
  colorGrade?: ImageLayerColorGrade
  content?: ImageLayerContent
  edits?: ImageLayerEdits
  mask?: ImageLayerSelection
  collageCell?: ImageCollageCellStyle
}
export interface ImageCollageCellStyle {
  rect: ImageTransformRect
  cornerRadius: number
  borderWidth: number
  borderColor: string
  shadow: boolean
}
export interface ImageTransformFrame extends ImageTransformSize {
  background: string
  draws: ImageTransformDraw[]
  watermark?: ImageCollageWatermark
  /** Replay kernels in their original bounded document before clipping. */
  documentFrame?: ImageLayerRecipe['documentFrame']
}

function validSize(size: ImageTransformSize): boolean {
  return Number.isSafeInteger(size.width) && size.width > 0 && Number.isSafeInteger(size.height) && size.height > 0
}

function fullRect(size: ImageTransformSize): ImageTransformRect { return { x: 0, y: 0, width: size.width, height: size.height } }


export function fitImageTransform(source: ImageTransformSize, target: ImageTransformRect, fit: ImageFit): Pick<ImageTransformDraw, 'source' | 'destination'> {
  if (!validSize(source) || ![target.x, target.y, target.width, target.height].every(Number.isFinite) || target.width <= 0 || target.height <= 0 || (fit !== 'contain' && fit !== 'cover')) throw new Error('图片填充尺寸无效')
  const ratio = fit === 'cover' ? Math.max(target.width / source.width, target.height / source.height) : Math.min(target.width / source.width, target.height / source.height)
  if (fit === 'cover') {
    const width = Math.min(source.width, target.width / ratio), height = Math.min(source.height, target.height / ratio)
    return { source: { x: (source.width - width) / 2, y: (source.height - height) / 2, width, height }, destination: target }
  }
  const width = source.width * ratio, height = source.height * ratio
  return { source: fullRect(source), destination: { x: target.x + (target.width - width) / 2, y: target.y + (target.height - height) / 2, width, height } }
}

function draw(sourceIndex: number, source: ImageTransformRect, destination: ImageTransformRect, values: Partial<Pick<ImageTransformDraw, 'rotation' | 'flipX' | 'flipY' | 'opacity' | 'blend' | 'adjustments' | 'colorGrade' | 'content' | 'edits' | 'mask'>> = {}): ImageTransformDraw {
  return { sourceIndex, source, destination, rotation: 0, flipX: false, flipY: false, opacity: 1, blend: 'source-over', ...values }
}

/** Preserve a world-axis selection under T(center) * F * R, including nonuniform layer dimensions. */
export function imageLayerSelectionFromOutputRect(layer: ImageLayer, output: ImageTransformSize, rect: ImageTransformRect, kind: 'rectangle' | 'ellipse', inverted: boolean, featherRadius = 0): ImageLayerSelection {
  const width = layer.width * output.width, height = layer.height * output.height
  if (![width, height, rect.x, rect.y, rect.width, rect.height, featherRadius].every(Number.isFinite) || width <= 0 || height <= 0 || rect.width <= 0 || rect.height <= 0 || featherRadius < 0 || featherRadius > 128) throw new Error('选区尺寸或羽化半径无效')
  const angle = layer.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle)
  const flipX = layer.flipX ? -1 : 1, flipY = layer.flipY ? -1 : 1
  const centerX = (layer.x + layer.width / 2) * output.width, centerY = (layer.y + layer.height / 2) * output.height
  const x = (rect.x - centerX) * flipX, y = (rect.y - centerY) * flipY
  return { kind, transform: [cos * flipX * rect.width / width, -sin * flipX * rect.width / height, sin * flipY * rect.height / width, cos * flipY * rect.height / height, (cos * x + sin * y) / width + 0.5, (-sin * x + cos * y) / height + 0.5], inverted, ...(featherRadius > 0 ? { feather: { radius: featherRadius, space: { width, height } } } : {}) }
}

/** A sampled output rectangle remains anchored through layer rotation/flips and later resizing. */
export function imageLayerRasterSelectionFromOutput(layer: ImageLayer, output: ImageTransformSize, rect: ImageTransformRect, raster: ImageLayerRaster, inverted = false, featherRadius = 0): ImageLayerSelection {
  return parseImageLayerSelection({ ...imageLayerSelectionFromOutputRect(layer, output, rect, 'rectangle', inverted, featherRadius), kind: 'raster', raster })
}

function outputFrame(size: ImageTransformSize, background: string, draws: ImageTransformDraw[]): ImageTransformFrame {
  if (!validSize(size) || size.width > maximumImageTransformEdge || size.height > maximumImageTransformEdge || size.width * size.height > maximumImageTransformPixels) throw new Error('处理后的单张图片不能超过 4096 像素边长或 16777216 像素')
  return { ...size, background, draws }
}

/** Plans pixels only. Source dimensions have already been normalised by EXIF orientation. */
export function buildImageTransformFrames(sources: readonly ImageTransformSize[], value: ImageTransformRecipe): ImageTransformFrame[] {
  const parsed = parseImageTransformRecipe(value)
  const recipe = parsed.kind === 'layer' ? materializeImageLayerGroups(parsed) : parsed
  if ((!sources.length && imageTransformRecipeNeedsSources(recipe)) || sources.length > maximumImageTransformInputs || sources.some((source) => !validSize(source) || source.width > 16_384 || source.height > 16_384)
    || sources.reduce((sum, source) => sum + source.width * source.height, 0) > maximumImageTransformTotalPixels) throw new Error('输入图片尺寸或总像素超过图像工具容量')
  if (['crop', 'grid-split', 'tile'].includes(recipe.kind) && sources.length !== 1) throw new Error('裁剪、宫格裁剪和平铺每次需要一张输入图片')
  let frames: ImageTransformFrame[]
  if (recipe.kind === 'crop') {
    const source = sources[0]
    const x = Math.min(source.width, Math.floor(recipe.x * source.width)), y = Math.min(source.height, Math.floor(recipe.y * source.height))
    const right = Math.min(source.width, Math.ceil((recipe.x + recipe.width) * source.width)), bottom = Math.min(source.height, Math.ceil((recipe.y + recipe.height) * source.height))
    if (right <= x || bottom <= y) throw new Error('裁剪范围没有包含有效像素')
    const rotated = recipe.rotation === 90 || recipe.rotation === 270
    const width = rotated ? recipe.outputHeight : recipe.outputWidth, height = rotated ? recipe.outputWidth : recipe.outputHeight
    frames = [outputFrame({ width: recipe.outputWidth, height: recipe.outputHeight }, 'transparent', [draw(0, { x, y, width: right - x, height: bottom - y }, {
      x: (recipe.outputWidth - width) / 2, y: (recipe.outputHeight - height) / 2, width, height,
    }, { rotation: recipe.rotation, flipX: recipe.flipX, flipY: recipe.flipY })])]
  } else if (recipe.kind === 'grid-split') {
    frames = imageTransformGrid(sources[0], recipe.rows, recipe.columns, recipe.gap, recipe.padding).map((cell) => outputFrame({ width: cell.width, height: cell.height }, 'transparent', [draw(0, cell, { x: 0, y: 0, width: cell.width, height: cell.height })]))
  } else if (recipe.kind === 'collage' || recipe.kind === 'tile') {
    const layout = recipe.kind === 'collage' ? buildCollageLayout(sources, recipe) : null
    const size = layout ? { width: layout.width, height: layout.height } : { width: recipe.outputWidth, height: recipe.outputHeight }
    const cells = layout?.cells ?? imageTransformGrid(size, recipe.rows, recipe.columns, recipe.gap, 0)
    const draws = cells.flatMap((cell, index) => {
      const sourceIndex = recipe.kind === 'tile' ? 0 : index
      if (sourceIndex >= sources.length) return []
      const fitted = fitImageTransform(sources[sourceIndex], cell, recipe.fit)
      const mirror = recipe.kind === 'tile' && recipe.mirrorAlternate
      const command = draw(sourceIndex, fitted.source, fitted.destination, { flipX: Boolean(mirror && index % recipe.columns % 2), flipY: Boolean(mirror && Math.floor(index / recipe.columns) % 2) })
      if (recipe.kind === 'collage' && ((recipe.cornerRadius ?? 0) > 0 || (recipe.borderWidth ?? 0) > 0 || recipe.shadow)) command.collageCell = {
        rect: cell, cornerRadius: recipe.cornerRadius ?? 0, borderWidth: recipe.borderWidth ?? 0, borderColor: recipe.borderColor ?? '#ffffff', shadow: recipe.shadow ?? false,
      }
      return [command]
    })
    const frame = outputFrame(size, recipe.background, draws)
    if (recipe.kind === 'collage' && recipe.watermark?.text && recipe.watermark.opacity > 0) frame.watermark = recipe.watermark
    frames = [frame]
  } else {
    const size = { width: recipe.outputWidth, height: recipe.outputHeight }
    const layers: ImageLayer[] = recipe.layers.length || recipe.explicitLayers ? recipe.layers : sources.map((_, sourceIndex) => ({ sourceIndex, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true }))
    // Even hidden layers must refer to a valid source so toggling visibility never changes identity.
    if (layers.some((layer) => !layer.content && !sources[layer.sourceIndex])) throw new Error('图层引用了不存在的输入图片，请重新选择来源')
    const draws = layers.filter((layer) => layer.visible && layer.opacity > 0).map((layer) => draw(layer.sourceIndex, fullRect(layer.content ? size : sources[layer.sourceIndex]), {
      x: layer.x * size.width, y: layer.y * size.height, width: layer.width * size.width, height: layer.height * size.height,
    }, { rotation: layer.rotation, opacity: layer.opacity, blend: layer.blend, flipX: layer.flipX ?? false, flipY: layer.flipY ?? false,
      ...(layer.adjustments ? { adjustments: layer.adjustments } : {}), ...(layer.content ? { content: layer.content } : {}),
      ...(layer.colorGrade ? { colorGrade: layer.colorGrade } : {}),
      ...(layer.edits ? { edits: layer.edits } : {}), ...(layer.mask ? { mask: layer.mask } : {}),
    }))
    frames = [{ ...outputFrame(size, recipe.background, draws), ...(recipe.documentFrame ? { documentFrame: recipe.documentFrame } : {}) }]
  }
  if (frames.length > maximumImageTransformOutputs || frames.reduce((sum, frame) => sum + frame.width * frame.height, 0) > maximumImageTransformTotalPixels) throw new Error('处理结果数量或总像素超过图像工具容量')
  return frames
}
