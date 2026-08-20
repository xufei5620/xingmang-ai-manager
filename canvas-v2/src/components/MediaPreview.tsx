import {
  useEffect,
  useId,
  useRef,
  useState,
  type AudioHTMLAttributes,
  type ImgHTMLAttributes,
  type MouseEvent,
  type VideoHTMLAttributes,
} from 'react'
import { ChevronLeft, ChevronRight, ImageOff, MoreHorizontal, Music2, Pause, Pencil, Play, Volume2, VolumeX, X } from 'lucide-react'
import type { AssetRef } from '../model'
import { videoCoverCache } from '../library/video-cover'

interface SafeImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src: string
  /** Used when `src` is a derived thumbnail that 404s; the original asset is
   *  still on disk. The grid used to treat a thumb:// URL as "no file". */
  fallbackSrc?: string
  fallbackLabel?: string
}

export function SafeImage({ src, fallbackSrc, fallbackLabel = '素材不可用', className, ...props }: SafeImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const { onError, ...imageProps } = props

  useEffect(() => setFailedSrc(null), [src, fallbackSrc])

  const primary = isCanvasImagePreviewUrl(src) ? src : undefined
  const fallback = isCanvasImagePreviewUrl(fallbackSrc) && fallbackSrc !== src ? fallbackSrc : undefined
  const activeSrc = primary && failedSrc !== primary ? primary : fallback

  if (!activeSrc || failedSrc === activeSrc) {
    return (
      <span className={`${className ?? ''} media-unavailable`} role="img" aria-label={fallbackLabel}>
        <ImageOff size={18} aria-hidden="true" />
        <span>{fallbackLabel}</span>
      </span>
    )
  }
  return <img {...imageProps} className={className} src={activeSrc} onError={(event) => { setFailedSrc(activeSrc); onError?.(event) }} />
}

interface VideoCoverImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /** Derived still from the main process; absent whenever the OS declined the file. */
  thumbnailUrl: string
  /** The video itself, read only if the derived still is unavailable. */
  videoUrl: string
  fallbackLabel?: string
}

/**
 * A video tile. Prefers the still the main process derived from the platform
 * thumbnail provider; when that provider has nothing for this codec, one frame
 * is captured here instead. The capture is queued globally, so a page of tiles
 * still only ever has one media element alive, and the element is detached --
 * the grid's markup stays free of players.
 */
export function VideoCoverImage({ thumbnailUrl, videoUrl, fallbackLabel = '视频素材', className, ...props }: VideoCoverImageProps) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  const [cover, setCover] = useState<string | null>(null)

  useEffect(() => {
    setThumbnailFailed(false)
    setCover(null)
  }, [thumbnailUrl, videoUrl])

  const usable = !thumbnailFailed && isCanvasThumbnailUrl(thumbnailUrl)

  useEffect(() => {
    // Covers both ways the derived still can be missing: never generated, so
    // the summary carries no thumbnail path, and generated but unreadable.
    if (usable || cover || !isLocalCanvasAssetUrl(videoUrl, 'video')) return undefined
    let active = true
    void videoCoverCache.resolve(videoUrl).then((frame) => { if (active && frame) setCover(frame) })
    return () => { active = false }
  }, [cover, usable, videoUrl])

  if (!usable && !cover) {
    return (
      <span className={`${className ?? ''} media-unavailable`} role="img" aria-label={fallbackLabel}>
        <ImageOff size={18} aria-hidden="true" />
        <span>{fallbackLabel}</span>
      </span>
    )
  }
  return (
    <img
      {...props}
      className={className}
      src={usable ? thumbnailUrl : cover as string}
      onError={() => setThumbnailFailed(true)}
    />
  )
}

const THUMBNAIL_URL_PATTERN = /^xingmang-asset:\/\/thumb\/v[0-9]+\/(image|video)\/[A-Za-z0-9_-]{43}$/

/**
 * Derived thumbnails live under their own protocol host so they can be served
 * as immutable. They are still images whatever the source media was, so a video
 * tile can render its cover frame without mounting a video element.
 */
export function isCanvasThumbnailUrl(value: string | undefined): value is string {
  return typeof value === 'string' && THUMBNAIL_URL_PATTERN.test(value)
}

/** A still the image tile can paint: the derived thumb, or the original file. */
export function isCanvasImagePreviewUrl(value: string | undefined): value is string {
  return isCanvasThumbnailUrl(value) || isLocalCanvasAssetUrl(value, 'image')
}

/**
 * Whether the library card should try to paint this asset. Image tiles list a
 * `xingmang-asset://thumb/...` URL; treating only `://image/` as present made
 * every derived-thumb card read as missing.
 */
export function canvasAssetIsPreviewable(asset: {
  mediaType: 'image' | 'video' | 'audio'
  localUrl: string
  thumbnailUrl?: string
}): boolean {
  if (asset.mediaType === 'image') {
    return isCanvasImagePreviewUrl(asset.thumbnailUrl) || isLocalCanvasAssetUrl(asset.localUrl, 'image')
  }
  return isLocalCanvasAssetUrl(asset.localUrl, asset.mediaType)
}

export function isLocalCanvasAssetUrl(
  value: string | undefined,
  expectedKind?: AssetRef['kind'],
): value is string {
  if (typeof value !== 'string') return false
  const match = /^xingmang-asset:\/\/(image|video|audio)\/([A-Za-z0-9_-]{43})$/.exec(value)
  return Boolean(match && (!expectedKind || match[1] === expectedKind))
}

interface ViewportVideoProps extends Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'> {
  src: string
  fallbackLabel?: string
  /** Canvas nodes keep the surface draggable. Native controls steal the
   *  pointer, so playback is a single overlay button marked `nodrag`. */
  canvasPlayback?: boolean
}

export function ViewportVideo({ src, fallbackLabel = '视频素材不可用', className, canvasPlayback = false, ...props }: ViewportVideoProps) {
  const ref = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const { onError, onPlay, onPause, onDoubleClick, style, title, controls, ...videoProps } = props

  useEffect(() => {
    setFailed(false)
    setPlaying(false)
  }, [src])
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

  if (failed || !isLocalCanvasAssetUrl(src, 'video')) {
    return (
      <span className={`${className ?? ''} media-unavailable`} role="img" aria-label={fallbackLabel}>
        <ImageOff size={18} aria-hidden="true" />
        <span>{fallbackLabel}</span>
      </span>
    )
  }

  const togglePlayback = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const video = ref.current
    if (!video) return
    if (video.paused) void video.play().catch(() => undefined)
    else video.pause()
  }

  const video = (
    <video
      {...videoProps}
      ref={ref}
      className={canvasPlayback ? 'wf-canvas-video-el' : className}
      src={src}
      preload="metadata"
      controls={canvasPlayback ? false : controls}
      style={canvasPlayback ? undefined : style}
      title={canvasPlayback ? undefined : title}
      onError={(event) => { setFailed(true); onError?.(event) }}
      onPlay={(event) => { setPlaying(true); onPlay?.(event) }}
      onPause={(event) => { setPlaying(false); onPause?.(event) }}
      onDoubleClick={canvasPlayback ? undefined : onDoubleClick}
    />
  )
  if (!canvasPlayback) return video
  return (
    <div
      className={`wf-canvas-video ${className ?? ''}`.trim()}
      style={style}
      title={title}
      onDoubleClick={onDoubleClick
        ? (event) => onDoubleClick(event as never)
        : undefined}
    >
      {video}
      <button
        type="button"
        className="wf-canvas-video-toggle nodrag"
        title={playing ? '暂停' : '播放'}
        aria-label={playing ? '暂停视频' : '播放视频'}
        onClick={togglePlayback}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
      </button>
    </div>
  )
}

interface WaveformBuffer {
  numberOfChannels: number
  length: number
  duration?: number
  getChannelData(channel: number): Float32Array
}

interface AudioWaveform {
  duration: number
  peaks: number[]
}

const waveformCache = new Map<string, Promise<AudioWaveform>>()
const maximumWaveformCacheEntries = 64
const maximumWaveformBytes = 64 * 1024 * 1024

export function downsampleWaveform(buffer: WaveformBuffer, bucketCount = 64): number[] {
  const buckets = Math.max(8, Math.min(128, Math.floor(bucketCount)))
  if (buffer.length <= 0 || buffer.numberOfChannels <= 0) return Array.from({ length: buckets }, () => 0)
  const rawPeaks = Array.from({ length: buckets }, (_, bucketIndex) => {
    const start = Math.floor((bucketIndex * buffer.length) / buckets)
    const end = Math.max(start + 1, Math.floor(((bucketIndex + 1) * buffer.length) / buckets))
    const stride = Math.max(1, Math.floor((end - start) / 256))
    let peak = 0
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const samples = buffer.getChannelData(channel)
      for (let offset = start; offset < end; offset += stride) peak = Math.max(peak, Math.abs(samples[offset] ?? 0))
    }
    return peak
  })
  const maximum = Math.max(...rawPeaks, 0.0001)
  return rawPeaks.map((peak) => Math.min(1, peak / maximum))
}

async function readAudioWaveform(src: string): Promise<AudioWaveform> {
  if (!isLocalCanvasAssetUrl(src, 'audio')) throw new Error('音频素材地址无效')
  const cached = waveformCache.get(src)
  if (cached) return cached
  const request = (async () => {
    const response = await fetch(src, { cache: 'force-cache' })
    if (!response.ok) throw new Error(`音频素材读取失败：${response.status}`)
    const declaredBytes = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredBytes) && declaredBytes > maximumWaveformBytes) throw new Error('音频过大，已跳过波形解码')
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > maximumWaveformBytes) throw new Error('音频过大，已跳过波形解码')
    const context = new AudioContext()
    try {
      const decoded = await context.decodeAudioData(bytes.slice(0))
      return { duration: decoded.duration, peaks: downsampleWaveform(decoded) }
    } finally {
      await context.close().catch(() => undefined)
    }
  })().catch((error) => {
    waveformCache.delete(src)
    throw error
  })
  if (waveformCache.size >= maximumWaveformCacheEntries) {
    const oldest = waveformCache.keys().next().value
    if (oldest) waveformCache.delete(oldest)
  }
  waveformCache.set(src, request)
  return request
}

export function formatMediaTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const seconds = Math.floor(value)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function waveformAreaPath(peaks: readonly number[], width = 100, height = 30): string {
  if (peaks.length === 0 || width <= 0 || height <= 0) return ''
  const baseline = height - 1
  const points = peaks.map((peak, index) => {
    const x = peaks.length === 1 ? 0 : (index / (peaks.length - 1)) * width
    const normalized = Number.isFinite(peak) ? Math.max(0, Math.min(1, peak)) : 0
    const y = baseline - Math.max(1.5, normalized * (height - 3))
    return `${x.toFixed(2)} ${y.toFixed(2)}`
  })
  return `M 0 ${baseline} L ${points.join(' L ')} L ${width} ${baseline} Z`
}

interface AudioPreviewProps extends Omit<AudioHTMLAttributes<HTMLAudioElement>, 'src' | 'controls'> {
  src: string
}

export function AudioPreview({ src, className, muted: mutedProp, autoPlay, ...props }: AudioPreviewProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const waveformClipId = useId()
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(Boolean(mutedProp))
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const { onError, onLoadedMetadata, onTimeUpdate, onEnded, onPlay, onPause, ...audioProps } = props

  useEffect(() => {
    setFailed(false)
    setPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    setPeaks(null)
    if (!isLocalCanvasAssetUrl(src, 'audio')) return undefined
    let active = true
    void readAudioWaveform(src).then((waveform) => {
      if (!active) return
      setPeaks(waveform.peaks)
      setDuration((value) => value || waveform.duration)
    }).catch(() => {
      if (active) setPeaks([])
    })
    return () => { active = false }
  }, [src])

  useEffect(() => setMuted(Boolean(mutedProp)), [mutedProp])

  if (failed || !isLocalCanvasAssetUrl(src, 'audio')) {
    return <span className={`${className ?? ''} media-unavailable`} role="img" aria-label="音频素材不可用"><Music2 size={18} aria-hidden="true" /><span>音频素材不可用</span></span>
  }

  const seek = (value: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = value
    setCurrentTime(value)
  }
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0
  const displayPeaks = peaks?.length ? peaks : Array.from({ length: 64 }, () => 0.08)
  const waveformPath = waveformAreaPath(displayPeaks)

  return (
    <div className={`${className ?? ''} media-audio-player`}>
      <audio
        {...audioProps}
        ref={audioRef}
        className="media-audio-element"
        src={src}
        preload="metadata"
        autoPlay={autoPlay}
        muted={muted}
        onError={(event) => { setFailed(true); onError?.(event) }}
        onLoadedMetadata={(event) => { setDuration(event.currentTarget.duration || 0); onLoadedMetadata?.(event) }}
        onTimeUpdate={(event) => { setCurrentTime(event.currentTarget.currentTime); onTimeUpdate?.(event) }}
        onEnded={(event) => { setPlaying(false); setCurrentTime(0); onEnded?.(event) }}
        onPlay={(event) => { setPlaying(true); onPlay?.(event) }}
        onPause={(event) => { setPlaying(false); onPause?.(event) }}
      />
      <button
        type="button"
        className="media-audio-toggle nodrag"
        title={playing ? '暂停' : '播放'}
        aria-label={playing ? '暂停音频' : '播放音频'}
        onClick={() => {
          const audio = audioRef.current
          if (!audio) return
          if (audio.paused) void audio.play().catch(() => undefined)
          else audio.pause()
        }}
      >{playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}</button>
      <div className="media-audio-timeline">
        <svg className={`media-audio-waveform${!peaks?.length ? ' is-fallback' : ''}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
          <defs><clipPath id={waveformClipId}><rect x="0" y="0" width={progress * 100} height="30" /></clipPath></defs>
          <line className="media-audio-waveform-axis" x1="0" y1="29" x2="100" y2="29" />
          <path className="media-audio-waveform-base" d={waveformPath} />
          <path className="media-audio-waveform-played" d={waveformPath} clipPath={`url(#${waveformClipId})`} />
          {displayPeaks.map((peak, index) => peak >= 0.98
            ? <circle key={index} className="media-audio-waveform-clip" cx={(index / Math.max(1, displayPeaks.length - 1)) * 100} cy="1.2" r="0.55" />
            : null)}
        </svg>
        <input
          className="media-audio-seek nodrag nowheel"
          type="range"
          min="0"
          max={duration || 0}
          step="0.01"
          value={Math.min(currentTime, duration || 0)}
          aria-label="音频播放进度"
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span>{formatMediaTime(currentTime)} / {formatMediaTime(duration)}</span>
      </div>
      <button type="button" className="media-audio-volume nodrag" title={muted ? '恢复声音' : '静音'} aria-label={muted ? '恢复声音' : '静音'} onClick={() => setMuted((value) => !value)}>
        {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </button>
    </div>
  )
}

interface MediaLightboxProps {
  asset: AssetRef | null
  title?: string
  createdAt?: string
  onClose(): void
  onAssetMenu(assetId: string): void
  onRename?(assetId: string): void
  /** Absent when there is nothing before or after, which also disables the key. */
  onPrevious?(): void
  onNext?(): void
}

export function MediaLightbox({ asset, title, createdAt, onClose, onAssetMenu, onRename, onPrevious, onNext }: MediaLightboxProps) {
  useEffect(() => {
    if (!asset) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return onClose()
      // Arrow keys belong to a focused video's scrubber while it has focus;
      // stepping the viewer is only safe when they are not being used to seek.
      const active = document.activeElement
      if (active instanceof HTMLMediaElement) return
      if (event.key === 'ArrowLeft' && onPrevious) { event.preventDefault(); onPrevious() }
      if (event.key === 'ArrowRight' && onNext) { event.preventDefault(); onNext() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [asset, onClose, onPrevious, onNext])

  if (!asset?.localUrl) return null
  const mediaLabel = asset.kind === 'video' ? '视频预览' : asset.kind === 'audio' ? '音频预览' : '图片预览'
  return (
    <div className="media-lightbox" role="dialog" aria-modal="true" aria-label={title || mediaLabel} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div className="media-lightbox-toolbar">
        <span>{title || (asset.width && asset.height ? `${asset.width} × ${asset.height}` : mediaLabel)}</span>
        {createdAt && <time dateTime={createdAt}>{new Date(createdAt).toLocaleString()}</time>}
        {(onPrevious || onNext) && (
          <>
            <button type="button" title="上一个素材" aria-label="上一个素材" disabled={!onPrevious} onClick={() => onPrevious?.()}><ChevronLeft size={18} /></button>
            <button type="button" title="下一个素材" aria-label="下一个素材" disabled={!onNext} onClick={() => onNext?.()}><ChevronRight size={18} /></button>
          </>
        )}
        {asset.assetId && onRename && (
          <button type="button" title="重命名" aria-label="重命名素材" onClick={() => onRename(asset.assetId as string)}><Pencil size={16} /></button>
        )}
        {asset.assetId && (
          <button type="button" title="素材操作" aria-label="素材操作" onClick={() => onAssetMenu(asset.assetId as string)}>
            <MoreHorizontal size={18} />
          </button>
        )}
        <button type="button" title="关闭预览" aria-label="关闭媒体预览" onClick={onClose}><X size={18} /></button>
      </div>
      {asset.kind === 'image' && <SafeImage className="media-lightbox-image" src={asset.localUrl} alt={title || '图片大图预览'} />}
      {asset.kind === 'video' && <ViewportVideo className="media-lightbox-video" src={asset.localUrl} aria-label={title || '视频放大预览'} controls autoPlay />}
      {asset.kind === 'audio' && <div className="media-lightbox-audio"><Music2 size={32} /><AudioPreview src={asset.localUrl} /></div>}
    </div>
  )
}
