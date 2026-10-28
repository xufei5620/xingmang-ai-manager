import { buildCollageLayout } from './collage-layout'
import { CollageStyledPreview } from './CollageStyledPreview'
import type { CSSProperties, ReactNode } from 'react'
import { SafeImage } from '../components/MediaPreview'
import type { AssetRef } from '../model'
import { imageTransformGrid, type ImageTransformSize, type ImageTransformRect } from './geometry'
import type { ImageCollageRecipe, ImageGridSplitRecipe, ImageTileRecipe } from './recipe'
import './image-grid-preview.css'

interface GridImage { label: string; asset: AssetRef; dimensions: ImageTransformSize; onLoad(image: HTMLImageElement): void }

export function gridPreviewCellStyle(cell: ImageTransformRect, size: ImageTransformSize): CSSProperties {
  return { position: 'absolute', left: `${cell.x / size.width * 100}%`, top: `${cell.y / size.height * 100}%`, width: `${cell.width / size.width * 100}%`, height: `${cell.height / size.height * 100}%` }
}

/** Keep preview boundaries identical to the integer pixel plan used by the processor. */
export function ImageGridPreview({ recipe, images, cellControls }: { cellControls?(index: number): ReactNode; recipe: ImageCollageRecipe | ImageGridSplitRecipe | ImageTileRecipe; images: readonly GridImage[] }) {
  const source = images[0]
  let size = recipe.kind === 'grid-split' ? source?.dimensions ?? { width: 1024, height: 1024 } : { width: recipe.outputWidth, height: recipe.outputHeight }
  let cells: ImageTransformRect[]
  try {
    if (recipe.kind === 'collage') {
      const layout = buildCollageLayout(images.map((image) => image.dimensions), recipe)
      size = { width: layout.width, height: layout.height }; cells = layout.cells
    } else cells = imageTransformGrid(size, recipe.rows, recipe.columns, recipe.gap, recipe.kind === 'tile' ? 0 : recipe.padding)
  }
  catch (cause) { return <div className="image-tool-empty" role="alert">{cause instanceof Error ? cause.message : '图像网格参数无效'}</div> }
  const aspect = size.width / size.height
  const styled = recipe.kind === 'collage' && Boolean(recipe.cornerRadius || recipe.borderWidth || recipe.shadow || (recipe.watermark?.text && recipe.watermark.opacity > 0))
  const split = recipe.kind === 'grid-split'
  return <div className={`image-grid-pixel-preview image-tool-checker${split ? ' is-split' : ''}`} aria-label={split ? '宫格切片像素预览' : '拼排像素预览'} style={{ aspectRatio: aspect, width: `min(100%, calc(var(--image-tool-preview-height, 240px) * ${aspect}))`, ...(!split && !styled && recipe.background !== 'transparent' ? { background: recipe.background } : {}) }}>
    {split && source?.asset.localUrl && <SafeImage className="image-grid-original" src={source.asset.localUrl} alt={source.label} draggable={false} onLoad={(event) => source.onLoad(event.currentTarget)} />}
    {cells.map((cell, index) => {
      const image = recipe.kind === 'tile' ? source : images[index]
      const mirrored = recipe.kind === 'tile' && recipe.mirrorAlternate
      return <div key={index} className="image-grid-pixel-cell" data-collage-slot-index={index} style={gridPreviewCellStyle(cell, size)} data-pixel-rect={`${cell.x},${cell.y},${cell.width},${cell.height}`}>
        {split ? <span>{index + 1}</span> : styled ? null : image?.asset.localUrl ? <SafeImage src={image.asset.localUrl} alt={image.label} draggable={false} onLoad={(event) => image.onLoad(event.currentTarget)} style={{ objectFit: recipe.fit, ...(mirrored ? { transform: `scale(${index % recipe.columns % 2 ? -1 : 1},${Math.floor(index / recipe.columns) % 2 ? -1 : 1})` } : {}) }} /> : <span className="image-tool-cell-empty">{index + 1} · 空位</span>}
      </div>
    })}
    {styled && recipe.kind === 'collage' && <CollageStyledPreview recipe={recipe} images={images} size={size} />}
    {recipe.kind === 'collage' && cellControls && cells.map((cell, index) => <div key={index} className="image-grid-cell-controls" data-collage-slot-index={index} style={gridPreviewCellStyle(cell, size)}>{cellControls(index)}</div>)}
  </div>
}
