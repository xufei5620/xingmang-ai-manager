/**
 * Cover frames for videos the platform could not thumbnail.
 *
 * The main process derives thumbnails with the OS shell provider, which exists
 * on Windows and macOS but still declines any file whose codec it has no
 * provider for. Those tiles used to sit on a grey "MP4 视频" placeholder
 * forever. Chromium in this window can already decode the file, so the frame is
 * captured here instead -- from one detached element at a time, which is the
 * point: the grid itself mounts no media, and this queue is what keeps that
 * true when two dozen tiles all want a cover at once.
 */

export const videoCoverMaxEdge = 320
export const videoCoverSeekRatio = 0.1
export const videoCoverSeekCeilingSeconds = 1

/**
 * Where to grab the frame. Never the first one: the opening frame of a
 * generated clip is usually black or mid fade-in, which is the least
 * recognisable image the file contains.
 */
export function videoCoverSeekTime(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0
  return Math.min(videoCoverSeekCeilingSeconds, durationSeconds * videoCoverSeekRatio)
}

export function videoCoverSize(
  width: number,
  height: number,
  maxEdge = videoCoverMaxEdge,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: maxEdge, height: maxEdge }
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export interface VideoCoverCache {
  resolve(src: string): Promise<string | null>
  size(): number
}

export function createVideoCoverCache(options: {
  capture(src: string): Promise<string | null>
  maximumEntries?: number
}): VideoCoverCache {
  const maximumEntries = options.maximumEntries ?? 64
  const entries = new Map<string, Promise<string | null>>()
  let queue: Promise<unknown> = Promise.resolve()

  return {
    resolve(src) {
      const existing = entries.get(src)
      if (existing) return existing
      // Decoding is serialized so only one media element is ever live. Failures
      // stay cached too: a file Chromium cannot decode will not decode on the
      // next scroll either, and retrying would re-run the whole queue.
      const pending = queue.then(() => options.capture(src), () => options.capture(src))
      queue = pending.catch(() => null)
      const recovered = pending.catch(() => null)
      entries.set(src, recovered)
      if (entries.size > maximumEntries) {
        const oldest = entries.keys().next()
        if (!oldest.done) entries.delete(oldest.value)
      }
      return recovered
    },
    size: () => entries.size,
  }
}

/**
 * Draws one frame of the file into a still image. Lives here rather than in a
 * component so the element is never part of the tray's tree, cannot be scrolled
 * into view, and is torn down the moment the frame is read.
 */
export async function captureVideoCoverFrame(src: string, timeoutMs = 10_000): Promise<string | null> {
  if (typeof document === 'undefined') return null
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'metadata'
  video.playsInline = true
  // The asset protocol answers with an allow-all origin, so the canvas the
  // frame is drawn into stays untainted and can be read back.
  video.crossOrigin = 'anonymous'
  const cleanup = () => {
    video.removeAttribute('src')
    video.load()
  }
  try {
    return await new Promise<string | null>((resolve) => {
      const finish = (value: string | null) => {
        window.clearTimeout(timer)
        resolve(value)
      }
      const timer = window.setTimeout(() => finish(null), timeoutMs)
      video.addEventListener('error', () => finish(null), { once: true })
      video.addEventListener('loadedmetadata', () => {
        const seekTo = videoCoverSeekTime(video.duration)
        video.addEventListener('seeked', () => {
          try {
            const size = videoCoverSize(video.videoWidth, video.videoHeight)
            const canvas = document.createElement('canvas')
            canvas.width = size.width
            canvas.height = size.height
            const context = canvas.getContext('2d')
            if (!context) {
              finish(null)
              return
            }
            context.drawImage(video, 0, 0, size.width, size.height)
            finish(canvas.toDataURL('image/jpeg', 0.72))
          } catch {
            finish(null)
          }
        }, { once: true })
        video.currentTime = seekTo
      }, { once: true })
      video.src = src
    })
  } finally {
    cleanup()
  }
}

export const videoCoverCache = createVideoCoverCache({ capture: (src) => captureVideoCoverFrame(src) })
