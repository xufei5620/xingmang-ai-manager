import { useEffect, useRef, useState, type ImgHTMLAttributes, type VideoHTMLAttributes } from 'react'
import { ImageOff, MoreHorizontal, X } from 'lucide-react'
import type { AssetRef } from '../model'

interface SafeImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src: string
  fallbackLabel?: string
}

export function SafeImage({ src, fallbackLabel = '素材不可用', className, ...props }: SafeImageProps) {
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [src])

  if (failed) {
    return (
      <span className={`${className ?? ''} media-unavailable`} role="img" aria-label={fallbackLabel}>
        <ImageOff size={18} aria-hidden="true" />
        <span>{fallbackLabel}</span>
      </span>
    )
  }
  return <img {...props} className={className} src={src} onError={() => setFailed(true)} />
}

export function isLocalCanvasAssetUrl(value: string | undefined): value is string {
  return typeof value === 'string' && /^xingmang-asset:\/\/video\/[A-Za-z0-9_-]{43}$/.test(value)
}

interface ViewportVideoProps extends Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'> {
  src: string
  fallbackLabel?: string
}

export function ViewportVideo({ src, fallbackLabel = '视频素材不可用', className, ...props }: ViewportVideoProps) {
  const ref = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [src])
  useEffect(() => {
    const video = ref.current
    if (!video || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) video.pause()
    }, { rootMargin: '80px' })
    observer.observe(video)
    const onVisibilityChange = () => { if (document.hidden) video.pause() }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [src])

  if (failed || !isLocalCanvasAssetUrl(src)) {
    return (
      <span className={`${className ?? ''} media-unavailable`} role="img" aria-label={fallbackLabel}>
        <ImageOff size={18} aria-hidden="true" />
        <span>{fallbackLabel}</span>
      </span>
    )
  }
  return <video {...props} ref={ref} className={className} src={src} preload="metadata" onError={() => setFailed(true)} />
}

interface MediaLightboxProps {
  asset: AssetRef | null
  onClose(): void
  onAssetMenu(assetId: string): void
}

export function MediaLightbox({ asset, onClose, onAssetMenu }: MediaLightboxProps) {
  useEffect(() => {
    if (!asset) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [asset, onClose])

  if (!asset?.localUrl || asset.kind !== 'image') return null
  return (
    <div className="media-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div className="media-lightbox-toolbar">
        <span>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : '图片预览'}</span>
        {asset.assetId && (
          <button type="button" title="图片操作" aria-label="图片操作" onClick={() => onAssetMenu(asset.assetId as string)}>
            <MoreHorizontal size={18} />
          </button>
        )}
        <button type="button" title="关闭预览" aria-label="关闭图片预览" onClick={onClose}><X size={18} /></button>
      </div>
      <SafeImage className="media-lightbox-image" src={asset.localUrl} alt="图片大图预览" />
    </div>
  )
}
