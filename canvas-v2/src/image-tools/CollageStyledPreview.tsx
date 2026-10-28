import { useEffect, useRef, useState } from 'react'
import { SafeImage, isCanvasImagePreviewUrl } from '../components/MediaPreview'
import type { AssetRef } from '../model'
import { paintImageCollageCell, paintImageCollageWatermark } from '../library/image-collage-painter'
import { buildImageTransformFrames, type ImageTransformSize } from './geometry'
import type { ImageCollageRecipe } from './recipe'

export interface CollagePreviewImage { label: string; asset: AssetRef; dimensions: ImageTransformSize; onLoad(image: HTMLImageElement): void }

export function collagePreviewSourceKey(image: CollagePreviewImage): string {
  return JSON.stringify([image.asset.assetId ?? '', image.asset.localUrl ?? '', image.dimensions.width, image.dimensions.height])
}

export function collagePreviewSize(size: ImageTransformSize): ImageTransformSize {
  const scale = Math.min(1, 1024 / size.width, 1024 / size.height)
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}

/** Reuse only already-approved image elements. No fetch, credentials, or full-size preview surfaces. */
export function CollageStyledPreview({ recipe, images, size }: { recipe: ImageCollageRecipe; images: readonly CollagePreviewImage[]; size: ImageTransformSize }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const decoded = useRef(new Map<string, HTMLImageElement>())
  const [loadVersion, setLoadVersion] = useState(0)
  const [error, setError] = useState('')
  const [renderedKey, setRenderedKey] = useState('')
  const failed = useRef(new Set<string>())
  const keys = images.map(collagePreviewSourceKey), sourceKey = JSON.stringify(keys)
  const activeSourceKey = useRef(sourceKey); activeSourceKey.current = sourceKey
  const recipeKey = JSON.stringify(recipe)
  const frameKey = `${sourceKey}:${recipeKey}`
  const ready = renderedKey === frameKey
  const inputs = useRef({ recipe, images, keys, size }); inputs.current = { recipe, images, keys, size }
  useEffect(() => {
    const { recipe: currentRecipe, images: currentImages, keys: currentKeys, size: currentSize } = inputs.current
    const active = new Set(currentKeys)
    for (const key of decoded.current.keys()) if (!active.has(key)) decoded.current.delete(key)
    for (const key of failed.current) if (!active.has(key)) failed.current.delete(key)
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = 0; canvas.height = 0; setRenderedKey(''); setError('')
    const unavailable = currentImages.findIndex((image, index) => !isCanvasImagePreviewUrl(image.asset.localUrl) || failed.current.has(currentKeys[index]))
    if (unavailable >= 0) { setError(`第 ${unavailable + 1} 张拼图素材不可用，请重新选择`); return }
    if (!currentImages.length || currentKeys.some((key) => !decoded.current.has(key))) return
    try {
      const frame = buildImageTransformFrames(currentImages.map((image) => image.dimensions), currentRecipe)[0]
      const preview = collagePreviewSize(currentSize)
      canvas.width = preview.width; canvas.height = preview.height
      const context = canvas.getContext('2d', { alpha: true })
      if (!context) throw new Error('浏览器无法显示拼图样式预览')
      context.scale(preview.width / currentSize.width, preview.height / currentSize.height)
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'
      if (frame.background !== 'transparent') { context.fillStyle = frame.background; context.fillRect(0, 0, frame.width, frame.height) }
      for (const command of frame.draws) {
        const image = decoded.current.get(currentKeys[command.sourceIndex])
        if (!image) throw new Error('拼图素材正在更新，请稍候')
        paintImageCollageCell(context, image, command, frame)
      }
      if (frame.watermark) paintImageCollageWatermark(context, frame, frame.watermark)
      setRenderedKey(frameKey)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '拼图样式预览失败') }
    return () => { canvas.width = 0; canvas.height = 0 }
  }, [recipeKey, sourceKey, loadVersion])
  useEffect(() => () => { decoded.current.clear() }, [])
  return <>
    <canvas ref={canvasRef} className="image-collage-styled-canvas" aria-label="拼图样式像素预览" style={{ visibility: ready ? 'visible' : 'hidden' }} />
    <div className="image-collage-source-loaders" aria-hidden="true">{images.map((image, index) => image.asset.localUrl ? <SafeImage key={`${index}:${keys[index]}`} src={image.asset.localUrl} alt="" draggable={false} onLoad={(event) => {
      if (activeSourceKey.current !== sourceKey) return
      failed.current.delete(keys[index]); decoded.current.set(keys[index], event.currentTarget); image.onLoad(event.currentTarget); setLoadVersion((value) => value + 1)
    }} onError={() => { if (activeSourceKey.current === sourceKey) { failed.current.add(keys[index]); setLoadVersion((value) => value + 1) } }} /> : null)}</div>
    {!ready && <span className="image-collage-preview-status" role={error ? 'alert' : 'status'}>{error || (images.length ? '正在准备拼图样式预览…' : '连接图片后显示拼图样式预览')}</span>}
  </>
}
