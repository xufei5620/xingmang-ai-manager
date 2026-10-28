const maximumVideoBytes = 32 * 1024 * 1024
const maximumPNGBytes = 20 * 1024 * 1024
const maximumFramePixels = 16_777_216
const frameConfirmationWaitMs = 250

export interface BrowserFrameOptions {
  timestampSeconds: number
  signal?: AbortSignal
  timeoutMs?: number
  maxEdge?: number
  maxPixels?: number
}

export interface BrowserFrameResult {
  blob: Blob
  width: number
  height: number
  requestedTimestampSeconds: number
  /** Omitted when the browser did not confirm a presented frame's mediaTime. */
  decodedTimestampSeconds?: number
}

export interface BrowserFrameVideo {
  readonly readyState: number
  readonly seeking: boolean
  readonly currentTime: number
  readonly duration: number
  readonly videoWidth: number
  readonly videoHeight: number
  source(url: string): void
  seek(timestampSeconds: number): void
  load(): void
  listen(event: 'loadedmetadata' | 'loadeddata' | 'seeked' | 'error', callback: () => void): () => void
  requestFrame?(callback: (mediaTime: number) => void): () => void
  capturePNG(width: number, height: number): Promise<Blob>
  dispose(): void
}

/** The seam supplies browser primitives; the extraction state machine stays real in tests. */
export interface BrowserFramePlatform {
  createVideo(): BrowserFrameVideo
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
  scheduleTimeout(callback: () => void, milliseconds: number): () => void
}

interface FrameBudget {
  timestampSeconds: number
  timeoutMs: number
  maxEdge: number
  maxPixels: number
}

function frameBudget(blob: Blob, options: BrowserFrameOptions): FrameBudget {
  if (!(blob instanceof Blob) || blob.size === 0 || blob.size > maximumVideoBytes || (blob.type !== '' && blob.type !== 'video/mp4')) throw new Error('请选择本账户可读取的 MP4 视频，单文件不超过 32 MB')
  if (!Number.isFinite(options.timestampSeconds) || options.timestampSeconds < 0 || options.timestampSeconds > 86_400) throw new Error('抽帧时间点必须是 0 到 86400 秒之间的有限数值')
  const timeoutMs = options.timeoutMs ?? 20_000
  const maxEdge = options.maxEdge ?? 4096
  const maxPixels = options.maxPixels ?? maximumFramePixels
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error('抽帧等待时间必须是 100 到 60000 毫秒')
  if (!Number.isSafeInteger(maxEdge) || maxEdge < 1 || maxEdge > 8192 || !Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > maximumFramePixels) throw new Error('抽帧尺寸预算不正确')
  return { timestampSeconds: options.timestampSeconds, timeoutMs, maxEdge, maxPixels }
}

function frameAbortError(): Error {
  const error = new Error('已取消抽帧，当前画布没有改变')
  error.name = 'AbortError'
  return error
}

/** Receives an owned Blob read by the host; accepts neither URLs nor fetch credentials. */
export function createBrowserFrameExtractor(platform: BrowserFramePlatform) {
  return function extract(blob: Blob, options: BrowserFrameOptions): Promise<BrowserFrameResult> {
    let budget: FrameBudget
    try { budget = frameBudget(blob, options) }
    catch (error) { return Promise.reject(error) }
    if (options.signal?.aborted) return Promise.reject(frameAbortError())
    return new Promise((resolve, reject) => {
      let video: BrowserFrameVideo | undefined
      let objectURL: string | undefined
      let settled = false
      let metadataReady = false
      let seekComplete = false
      let capturing = false
      let width = 0
      let height = 0
      let cancelTimeout: (() => void) | undefined
      let cancelConfirmation: (() => void) | undefined
      let cancelFrame: (() => void) | undefined
      let frameGeneration = 0
      const removers: Array<() => void> = []

      function cleanup(): void {
        cancelTimeout?.()
        cancelConfirmation?.()
        cancelFrame?.()
        frameGeneration += 1
        options.signal?.removeEventListener('abort', aborted)
        for (const remove of removers) remove()
        try { video?.dispose() } catch { /* URL revocation must survive a broken decoder. */ }
        if (objectURL) platform.revokeObjectURL(objectURL)
      }

      function fail(error: Error): void {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }

      function aborted(): void { fail(frameAbortError()) }

      function ready(): boolean {
        return Boolean(video && metadataReady && seekComplete && !video.seeking && video.readyState >= 2
          && Math.abs(video.currentTime - budget.timestampSeconds) <= 0.001)
      }

      function capture(decodedTimestampSeconds?: number): void {
        if (settled || capturing || !video || !ready()) return
        if (options.signal?.aborted) { aborted(); return }
        if (video.videoWidth !== width || video.videoHeight !== height) { fail(new Error('视频尺寸在解码期间发生变化，请重新选择素材')); return }
        capturing = true
        cancelConfirmation?.()
        cancelFrame?.()
        cancelFrame = undefined
        let pending: Promise<Blob>
        try { pending = video.capturePNG(width, height) }
        catch { fail(new Error('视频帧无法转换为 PNG 图片，请确认浏览器支持此视频编码')); return }
        void pending.then((png) => {
          if (settled) return
          if (options.signal?.aborted) { aborted(); return }
          if (!(png instanceof Blob) || png.type !== 'image/png' || png.size === 0 || png.size > maximumPNGBytes) { fail(new Error('抽帧图片为空或超过 20 MB，未保存图片')); return }
          settled = true
          cleanup()
          resolve({ blob: png, width, height, requestedTimestampSeconds: budget.timestampSeconds, ...(decodedTimestampSeconds !== undefined ? { decodedTimestampSeconds } : {}) })
        }, () => fail(new Error('视频帧无法转换为 PNG 图片，请确认浏览器支持此视频编码')))
      }

      function armFrame(): void {
        if (settled || capturing || !video?.requestFrame) return
        const generation = frameGeneration
        try {
          cancelFrame = video.requestFrame((mediaTime) => {
            if (settled || capturing || generation !== frameGeneration) return
            cancelFrame = undefined
            // A callback scheduled before a seek may still describe the old frame.
            // It cannot certify the requested frame merely because currentTime changed.
            if (ready() && video && Number.isFinite(mediaTime) && mediaTime >= 0 && mediaTime < video.duration
              && Math.abs(mediaTime - budget.timestampSeconds) <= 0.25) capture(mediaTime)
            else armFrame()
          })
        } catch { fail(new Error('浏览器无法读取视频帧，请确认视频可以正常播放')) }
      }

      function frameReady(): void {
        if (settled || capturing || !ready()) return
        if (!video?.requestFrame) { capture(); return }
        if (!cancelConfirmation) cancelConfirmation = platform.scheduleTimeout(() => capture(), frameConfirmationWaitMs)
      }

      function seeked(): void {
        if (!video || !metadataReady || video.seeking || Math.abs(video.currentTime - budget.timestampSeconds) > 0.001) return
        if (!seekComplete) {
          seekComplete = true
          // A post-seek callback is distinct from a queued callback for the old frame.
          frameGeneration += 1
          cancelFrame?.()
          cancelFrame = undefined
          armFrame()
        }
        frameReady()
      }

      function metadata(): void {
        if (settled || metadataReady || !video) return
        if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 86_400) { fail(new Error('视频时长无法读取或超过 24 小时，未进行抽帧')); return }
        if (budget.timestampSeconds >= video.duration) { fail(new Error('抽帧时间点必须小于视频时长')); return }
        width = video.videoWidth
        height = video.videoHeight
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) { fail(new Error('视频分辨率无法读取，未进行抽帧')); return }
        if (width > budget.maxEdge || height > budget.maxEdge || width * height > budget.maxPixels) { fail(new Error('视频分辨率超过抽帧尺寸预算，请先使用较小分辨率的视频')); return }
        metadataReady = true
        const needsSeek = budget.timestampSeconds !== 0 || Math.abs(video.currentTime) > 0.001
        seekComplete = !needsSeek && !video.seeking
        try {
          armFrame()
          if (needsSeek) video.seek(budget.timestampSeconds)
          frameReady()
        } catch { fail(new Error('浏览器无法定位此视频时间点，请确认视频可以正常播放')) }
      }

      try {
        video = platform.createVideo()
        removers.push(video.listen('loadedmetadata', metadata), video.listen('loadeddata', frameReady), video.listen('seeked', seeked), video.listen('error', () => fail(new Error('视频无法解码，请确认素材为可播放的 MP4 文件'))))
        options.signal?.addEventListener('abort', aborted, { once: true })
        cancelTimeout = platform.scheduleTimeout(() => fail(new Error('抽帧等待超时，图片没有保存；请确认视频可以正常播放后重试')), budget.timeoutMs)
        objectURL = platform.createObjectURL(blob)
        if (settled) { platform.revokeObjectURL(objectURL); return }
        video.source(objectURL)
        video.load()
        if (video.readyState >= 1) metadata()
      } catch { fail(new Error('浏览器无法初始化视频解码，请稍后重试')) }
    })
  }
}

function browserFrameVideo(): BrowserFrameVideo {
  const video = document.createElement('video')
  const canvases = new Set<HTMLCanvasElement>()
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  return {
    get readyState() { return video.readyState },
    get seeking() { return video.seeking },
    get currentTime() { return video.currentTime },
    get duration() { return video.duration },
    get videoWidth() { return video.videoWidth },
    get videoHeight() { return video.videoHeight },
    source(url) { video.src = url },
    seek(timestampSeconds) { video.currentTime = timestampSeconds },
    load() { video.load() },
    listen(event, callback) {
      video.addEventListener(event, callback)
      return () => video.removeEventListener(event, callback)
    },
    ...(typeof video.requestVideoFrameCallback === 'function' ? {
      requestFrame(callback: (mediaTime: number) => void) {
        const id = video.requestVideoFrameCallback((_now, metadata) => callback(metadata.mediaTime))
        return () => video.cancelVideoFrameCallback(id)
      },
    } : {}),
    capturePNG(width, height) {
      const canvas = document.createElement('canvas')
      canvases.add(canvas)
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) { canvases.delete(canvas); canvas.width = 0; canvas.height = 0; return Promise.reject(new Error('浏览器无法创建图片画布')) }
      context.drawImage(video, 0, 0, width, height)
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          canvas.width = 0
          canvas.height = 0
          canvases.delete(canvas)
          if (blob) resolve(blob)
          else reject(new Error('浏览器未返回帧图片'))
        }, 'image/png')
      })
    },
    dispose() {
      for (const canvas of canvases) { canvas.width = 0; canvas.height = 0 }
      canvases.clear()
      video.pause()
      video.removeAttribute('src')
      video.load()
    },
  }
}

export function extractBrowserVideoFrame(blob: Blob, options: BrowserFrameOptions): Promise<BrowserFrameResult> {
  if (typeof document === 'undefined') return Promise.reject(new Error('当前环境没有浏览器视频解码能力'))
  return createBrowserFrameExtractor({
    createVideo: browserFrameVideo,
    createObjectURL: (source) => URL.createObjectURL(source),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    scheduleTimeout(callback, milliseconds) {
      const timer = window.setTimeout(callback, milliseconds)
      return () => window.clearTimeout(timer)
    },
  })(blob, options)
}
