import { describe, expect, it } from 'vitest'
import { createBrowserFrameExtractor, type BrowserFramePlatform, type BrowserFrameVideo } from './browser-frame'

type VideoEvent = Parameters<BrowserFrameVideo['listen']>[0]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function png(): Blob { return new Blob(['test encoded pixels'], { type: 'image/png' }) }
function mp4(): Blob { return new Blob(['test owned MP4'], { type: 'video/mp4' }) }

class FakeVideo implements BrowserFrameVideo {
  readyState = 0
  seeking = false
  currentTime = 0
  duration = 2
  videoWidth = 320
  videoHeight = 180
  sourceURL = ''
  loads = 0
  disposals = 0
  seeks: number[] = []
  captures: Array<{ width: number; height: number; currentTime: number }> = []
  listeners = new Map<VideoEvent, Set<() => void>>()
  frames = new Map<number, (mediaTime: number) => void>()
  frameSequence = 0
  encode: () => Promise<Blob> = () => Promise.resolve(png())
  requestFrame?: BrowserFrameVideo['requestFrame']

  constructor(frameCallbacks = true) {
    if (frameCallbacks) this.requestFrame = (callback) => {
      const id = ++this.frameSequence
      this.frames.set(id, callback)
      return () => { this.frames.delete(id) }
    }
  }

  source(url: string): void { this.sourceURL = url }
  seek(timestampSeconds: number): void { this.seeks.push(timestampSeconds); this.currentTime = timestampSeconds; this.seeking = true; this.readyState = 1 }
  load(): void { this.loads += 1 }
  listen(event: VideoEvent, callback: () => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set<() => void>()
    listeners.add(callback)
    this.listeners.set(event, listeners)
    return () => { listeners.delete(callback) }
  }
  capturePNG(width: number, height: number): Promise<Blob> {
    this.captures.push({ width, height, currentTime: this.currentTime })
    return this.encode()
  }
  dispose(): void { this.disposals += 1; this.sourceURL = '' }
  emit(event: VideoEvent): void { for (const listener of [...(this.listeners.get(event) ?? [])]) listener() }
  metadata(): void { this.readyState = 1; this.emit('loadedmetadata') }
  firstFrame(): void { this.readyState = 2; this.emit('loadeddata') }
  completeSeek(): void { this.seeking = false; this.readyState = 2; this.emit('seeked') }
  present(mediaTime: number): void {
    const entry = this.frames.entries().next().value
    if (!entry) throw new Error('no test frame callback is registered')
    this.frames.delete(entry[0])
    entry[1](mediaTime)
  }
}

function fixture(frameCallbacks = true) {
  const video = new FakeVideo(frameCallbacks)
  const timers = new Map<number, { callback: () => void; milliseconds: number }>()
  const revoked: string[] = []
  let timerSequence = 0
  let creations = 0
  const platform: BrowserFramePlatform = {
    createVideo: () => video,
    createObjectURL: () => { creations += 1; return 'blob:owned-test-video' },
    revokeObjectURL: (url) => { revoked.push(url) },
    scheduleTimeout(callback, milliseconds) {
      const id = ++timerSequence
      timers.set(id, { callback, milliseconds })
      return () => { timers.delete(id) }
    },
  }
  function fire(milliseconds: number) {
    const entry = [...timers.entries()].find(([, timer]) => timer.milliseconds === milliseconds)
    if (!entry) throw new Error('no matching test timer is registered')
    timers.delete(entry[0])
    entry[1].callback()
  }
  function assertClean() {
    expect(timers.size).toBe(0)
    expect(video.frames.size).toBe(0)
    expect([...video.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
    expect(revoked).toEqual(['blob:owned-test-video'])
    expect(video.disposals).toBe(1)
  }
  return { video, platform, extract: createBrowserFrameExtractor(platform), fire, assertClean, timers, revoked, creations: () => creations }
}

describe('browser owned-video frame extraction', () => {
  it('extracts the zero-second frame without waiting for a seeked event and confirms presented mediaTime', async () => {
    const context = fixture()
    const pending = context.extract(mp4(), { timestampSeconds: 0 })
    context.video.metadata()
    expect(context.video.captures).toEqual([])
    context.video.firstFrame()
    context.video.present(0)
    const result = await pending
    expect(result).toMatchObject({ width: 320, height: 180, requestedTimestampSeconds: 0, decodedTimestampSeconds: 0 })
    expect(result.blob.type).toBe('image/png')
    expect(context.video.seeks).toEqual([])
    expect(context.video.captures).toEqual([{ width: 320, height: 180, currentTime: 0 }])
    context.assertClean()
  })

  it('supports decoders without presentation callbacks without inventing decoded mediaTime', async () => {
    const context = fixture(false)
    const pending = context.extract(mp4(), { timestampSeconds: 0 })
    context.video.metadata()
    context.video.firstFrame()
    expect(await pending).not.toHaveProperty('decodedTimestampSeconds')
    context.assertClean()
  })

  it('rejects old callbacks and premature seek events before capturing a mid-video frame', async () => {
    const context = fixture()
    const pending = context.extract(mp4(), { timestampSeconds: 1 })
    context.video.metadata()
    const oldFrame = [...context.video.frames.values()][0]
    context.video.emit('seeked')
    context.video.present(0)
    expect(context.video.captures).toEqual([])
    context.video.completeSeek()
    oldFrame(1)
    expect(context.video.captures).toEqual([])
    context.video.present(1.04)
    expect(await pending).toMatchObject({ requestedTimestampSeconds: 1, decodedTimestampSeconds: 1.04 })
    expect(context.video.seeks).toEqual([1])
    expect(context.video.captures).toEqual([{ width: 320, height: 180, currentTime: 1 }])
    context.assertClean()
  })

  it('captures a seeked readable frame when no presentation confirmation arrives and labels its time as unconfirmed', async () => {
    const context = fixture()
    const pending = context.extract(mp4(), { timestampSeconds: 1 })
    context.video.metadata()
    context.video.completeSeek()
    context.fire(250)
    expect(await pending).not.toHaveProperty('decodedTimestampSeconds')
    context.assertClean()
  })

  it('aborts before decoding without allocating an object URL', async () => {
    const context = fixture()
    const controller = new AbortController()
    controller.abort('private abort reason')
    await expect(context.extract(mp4(), { timestampSeconds: 0, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', message: '已取消抽帧，当前画布没有改变' })
    expect(context.creations()).toBe(0)
    expect(context.video.loads).toBe(0)
  })

  it('cleans an in-progress seek on abort and ignores its later media events', async () => {
    const context = fixture()
    const controller = new AbortController()
    const pending = context.extract(mp4(), { timestampSeconds: 1, signal: controller.signal })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    context.video.metadata()
    controller.abort()
    context.video.completeSeek()
    await rejection
    expect(context.video.captures).toEqual([])
    context.assertClean()
  })

  it('keeps a global deadline during PNG encoding and never reports a late encoded image as successful', async () => {
    const context = fixture(false)
    const encoded = deferred<Blob>()
    context.video.encode = () => encoded.promise
    const pending = context.extract(mp4(), { timestampSeconds: 0, timeoutMs: 100 })
    const rejection = expect(pending).rejects.toThrow('抽帧等待超时')
    context.video.metadata()
    context.video.firstFrame()
    context.fire(100)
    encoded.resolve(png())
    await rejection
    expect(context.video.captures).toHaveLength(1)
    context.assertClean()
  })

  it.each([
    { duration: Number.POSITIVE_INFINITY, message: '视频时长无法读取' },
    { duration: 0, message: '视频时长无法读取' },
    { videoWidth: 8192, message: '视频分辨率超过抽帧尺寸预算' },
    { videoHeight: 0, message: '视频分辨率无法读取' },
  ])('rejects unreadable or excessive media before allocating a PNG canvas', async (values) => {
    const context = fixture()
    Object.assign(context.video, values)
    const pending = context.extract(mp4(), { timestampSeconds: 0 })
    const rejection = expect(pending).rejects.toThrow(values.message)
    context.video.metadata()
    await rejection
    expect(context.video.captures).toEqual([])
    context.assertClean()
  })

  it('rejects the end-of-video timestamp rather than pretending the last frame is exact', async () => {
    const context = fixture()
    const pending = context.extract(mp4(), { timestampSeconds: 2 })
    const rejection = expect(pending).rejects.toThrow('抽帧时间点必须小于视频时长')
    context.video.metadata()
    await rejection
    context.assertClean()
  })

  it.each([new Blob([], { type: 'image/png' }), new Blob(['wrong media'], { type: 'image/jpeg' })])('rejects empty or non-PNG encodings and releases all decoder resources', async (encoded) => {
    const context = fixture(false)
    context.video.encode = () => Promise.resolve(encoded)
    const pending = context.extract(mp4(), { timestampSeconds: 0 })
    const rejection = expect(pending).rejects.toThrow('抽帧图片为空或超过 20 MB')
    context.video.metadata()
    context.video.firstFrame()
    await rejection
    context.assertClean()
  })

  it('rejects a successfully encoded PNG exceeding the derivation API limit without shrinking the source-video allowance', async () => {
    const context = fixture(false)
    context.video.encode = () => Promise.resolve(new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: 'image/png' }))
    const pending = context.extract(new Blob([new Uint8Array(21 * 1024 * 1024)], { type: 'video/mp4' }), { timestampSeconds: 0 })
    const rejection = expect(pending).rejects.toThrow('抽帧图片为空或超过 20 MB')
    context.video.metadata()
    context.video.firstFrame()
    await rejection
    expect(context.video.captures).toHaveLength(1)
    context.assertClean()
  })

  it('reports a controlled decoder error and cleans pending listeners and callbacks', async () => {
    const context = fixture()
    const pending = context.extract(mp4(), { timestampSeconds: 0 })
    const rejection = expect(pending).rejects.toThrow('视频无法解码')
    context.video.metadata()
    context.video.emit('error')
    await rejection
    context.assertClean()
  })

  it('cleans a failed PNG encoder without exposing its original error', async () => {
    const context = fixture(false)
    context.video.encode = () => Promise.reject(new Error('private decoder path /tmp/internal'))
    const pending = context.extract(mp4(), { timestampSeconds: 0 })
    const rejection = expect(pending).rejects.toThrow('视频帧无法转换为 PNG 图片')
    context.video.metadata()
    context.video.firstFrame()
    await rejection
    context.assertClean()
  })

  it('revokes an allocated object URL even when the request aborts during URL setup', async () => {
    const context = fixture()
    const controller = new AbortController()
    context.platform.createObjectURL = () => { controller.abort(); return 'blob:owned-test-video' }
    await expect(context.extract(mp4(), { timestampSeconds: 0, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    context.assertClean()
    expect(context.video.loads).toBe(0)
  })

  it('does not certify a frame with a presentation time outside the requested neighborhood', async () => {
    const context = fixture()
    const pending = context.extract(mp4(), { timestampSeconds: 1 })
    context.video.metadata()
    context.video.completeSeek()
    context.video.present(0)
    expect(context.video.captures).toEqual([])
    context.fire(250)
    expect(await pending).not.toHaveProperty('decodedTimestampSeconds')
    context.assertClean()
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 86_401])('rejects invalid timestamps before starting the browser decoder', async (timestampSeconds) => {
    const context = fixture()
    await expect(context.extract(mp4(), { timestampSeconds })).rejects.toThrow('抽帧时间点必须')
    expect(context.creations()).toBe(0)
  })
})
