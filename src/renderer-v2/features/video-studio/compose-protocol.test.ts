import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addVideoStudioClipBytes,
  maxVideoStudioClipBytes,
  maxVideoStudioMusicBytes,
  maxVideoStudioTotalBytes,
  minVideoStudioTotalBytes,
  parseVideoStudioComposeRequest,
  parseVideoStudioWorkerMessage,
  parseVideoStudioWorkerReply,
  videoStudioTotalBytesLimit,
} from './compose-protocol'

const options = { aspect: '9:16', resolution: 720, fit: 'cover', frameRate: 30 }
const megabyte = 1024 * 1024

function clip(bytes = 8) {
  return { data: new ArrayBuffer(bytes) }
}

/** 只有 byteLength、不真分配内存的「片段」，用来试几百 MB 的上限。 */
function sizedClip(bytes: number) {
  const data = { byteLength: bytes }
  Object.setPrototypeOf(data, ArrayBuffer.prototype)
  return { data }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('video studio compose protocol', () => {
  it('keeps only the fields it knows from a compose request', () => {
    const data = new ArrayBuffer(4)
    const request = parseVideoStudioComposeRequest({
      clips: [{ data, trimStart: 0.5, trimEnd: 0, caption: '字幕', path: '/etc/passwd' }],
      options: { ...options, extra: true },
      encoding: { video: ['vp9'], audio: ['opus'] },
    })
    expect(request).toEqual({
      clips: [{ data, trimStart: 0.5, trimEnd: 0, caption: '字幕' }],
      options,
      encoding: { video: ['vp9'], audio: ['opus'] },
    })
    expect(request.clips[0].data).toBe(data)
  })

  it('rejects requests the composer cannot use', () => {
    expect(() => parseVideoStudioComposeRequest(null)).toThrow('拼的时候出了点问题，请再试一次')
    expect(() => parseVideoStudioComposeRequest({ clips: [clip()], options: { ...options, resolution: 2160 } })).toThrow('成片的画面设置不对')
    expect(() => parseVideoStudioComposeRequest({ clips: [], options })).toThrow('至少要放一段片段才能拼成片')
    expect(() => parseVideoStudioComposeRequest({ clips: [clip(0)], options })).toThrow('第 1 段片段是空的')
    expect(() => parseVideoStudioComposeRequest({ clips: [clip(), { data: new Uint8Array(4) }], options })).toThrow('第 2 段片段是空的')
    expect(() => parseVideoStudioComposeRequest({ clips: [{ ...clip(), trimEnd: -1 }], options })).toThrow('第 1 段的剪切时间不对')
    expect(() => parseVideoStudioComposeRequest({ clips: [{ ...clip(), trimStart: Number.POSITIVE_INFINITY }], options })).toThrow('第 1 段的剪切时间不对')
    expect(() => parseVideoStudioComposeRequest({ clips: [{ ...clip(), caption: 7 }], options })).toThrow('第 1 段的字幕太长了')
    expect(() => parseVideoStudioComposeRequest({ clips: [{ ...clip(), caption: 'x'.repeat(1001) }], options })).toThrow('第 1 段的字幕太长了')
    expect(() => parseVideoStudioComposeRequest({ clips: [clip()], options, encoding: { video: ['h265'] } })).toThrow('拼的时候出了点问题，请再试一次')
    expect(() => parseVideoStudioComposeRequest({ clips: [clip()], options, encoding: { audio: [] } })).toThrow('拼的时候出了点问题，请再试一次')
  })

  it('caps the bytes a single clip and the whole request may hold', () => {
    const big = { byteLength: maxVideoStudioClipBytes + 1 }
    Object.setPrototypeOf(big, ArrayBuffer.prototype)
    expect(() => parseVideoStudioComposeRequest({ clips: [{ data: big }], options })).toThrow('第 1 段片段太大了，一段最多 512 MB')
    const half = { byteLength: maxVideoStudioClipBytes }
    Object.setPrototypeOf(half, ArrayBuffer.prototype)
    expect(() => parseVideoStudioComposeRequest({ clips: [{ data: half }, { data: half }, clip()], options })).toThrow('片段加起来超过 1 GB 了，少放几段再拼')
  })

  it('carries a song and the two volumes through, and turns away a song or volume it cannot use', () => {
    const song = new ArrayBuffer(16)
    const request = parseVideoStudioComposeRequest({ clips: [clip()], options, music: { data: song, gain: 0.7, path: 'C:/music.mp3' }, clipGain: 0.35 })
    expect(request).toEqual({ clips: [clip()], options, encoding: undefined, music: { data: song, gain: 0.7 }, clipGain: 0.35 })
    expect(request.music?.data).toBe(song)
    expect(parseVideoStudioComposeRequest({ clips: [clip()], options, clipGain: 0 }).clipGain).toBe(0)
    expect(parseVideoStudioComposeRequest({ clips: [clip()], options })).not.toHaveProperty('music')

    const unreadable = '这首歌读不出来，换一首试试（支持 MP3、M4A、WAV、OGG）'
    expect(() => parseVideoStudioComposeRequest({ clips: [clip()], options, music: { data: new ArrayBuffer(0), gain: 1 } })).toThrow(unreadable)
    expect(() => parseVideoStudioComposeRequest({ clips: [clip()], options, music: { data: new Uint8Array(4), gain: 1 } })).toThrow(unreadable)
    const big = { byteLength: maxVideoStudioMusicBytes + 1 }
    Object.setPrototypeOf(big, ArrayBuffer.prototype)
    expect(() => parseVideoStudioComposeRequest({ clips: [clip()], options, music: { data: big, gain: 1 } })).toThrow(unreadable)
    expect(() => parseVideoStudioComposeRequest({ clips: [clip()], options, music: { data: song } })).toThrow('拼的时候出了点问题，请再试一次')
    expect(() => parseVideoStudioComposeRequest({ clips: [clip()], options, music: { data: song, gain: 1.5 } })).toThrow('拼的时候出了点问题，请再试一次')
    expect(() => parseVideoStudioComposeRequest({ clips: [clip()], options, clipGain: -0.1 })).toThrow('拼的时候出了点问题，请再试一次')
    expect(() => parseVideoStudioComposeRequest({ clips: [clip()], options, clipGain: Number.NaN })).toThrow('拼的时候出了点问题，请再试一次')
  })

  it('carries the fades between shots and at the end, and turns away a transition it does not know', () => {
    expect(parseVideoStudioComposeRequest({ clips: [clip()], options: { ...options, transition: 'fade', fadeOut: true } }).options).toEqual({ ...options, transition: 'fade', fadeOut: true })
    // The defaults (a straight cut, no fade at the end) are left out, as before.
    expect(parseVideoStudioComposeRequest({ clips: [clip()], options: { ...options, transition: 'cut', fadeOut: false } }).options).toEqual(options)
    expect(() => parseVideoStudioComposeRequest({ clips: [clip()], options: { ...options, transition: 'wipe' } })).toThrow('成片的画面设置不对')
    expect(() => parseVideoStudioComposeRequest({ clips: [clip()], options: { ...options, fadeOut: 'yes' } })).toThrow('成片的画面设置不对')
  })

  it('carries the caption size and place, leaves out the defaults and turns away anything else', () => {
    expect(parseVideoStudioComposeRequest({ clips: [clip()], options: { ...options, captionSize: 'large', captionPosition: 'top' } }).options).toEqual({ ...options, captionSize: 'large', captionPosition: 'top' })
    expect(parseVideoStudioComposeRequest({ clips: [clip()], options: { ...options, captionSize: 'medium', captionPosition: 'bottom' } }).options).toEqual(options)
    expect(() => parseVideoStudioComposeRequest({ clips: [clip()], options: { ...options, captionSize: 'huge' } })).toThrow('成片的画面设置不对')
    expect(() => parseVideoStudioComposeRequest({ clips: [clip()], options: { ...options, captionPosition: 'left' } })).toThrow('成片的画面设置不对')
  })

  it('stops the page reading clips at the same total, with the same words, as the worker', () => {
    expect(addVideoStudioClipBytes(0, maxVideoStudioClipBytes)).toBe(maxVideoStudioClipBytes)
    expect(addVideoStudioClipBytes(maxVideoStudioClipBytes, maxVideoStudioClipBytes)).toBe(maxVideoStudioTotalBytes)
    expect(() => addVideoStudioClipBytes(maxVideoStudioTotalBytes, 1)).toThrow('片段加起来超过 1 GB 了，少放几段再拼')
  })

  it('tightens the total to an eighth of the memory, between 256 MB and 1 GB', () => {
    expect(videoStudioTotalBytesLimit(32)).toBe(maxVideoStudioTotalBytes)
    expect(videoStudioTotalBytesLimit(8)).toBe(maxVideoStudioTotalBytes)
    expect(videoStudioTotalBytesLimit(6)).toBe(768 * megabyte)
    expect(videoStudioTotalBytesLimit(4)).toBe(512 * megabyte)
    expect(videoStudioTotalBytesLimit(2)).toBe(minVideoStudioTotalBytes)
    expect(videoStudioTotalBytesLimit(0.25)).toBe(minVideoStudioTotalBytes)
    expect(minVideoStudioTotalBytes).toBe(256 * megabyte)
  })

  it('keeps the old 1 GB when the memory is unknown or makes no sense', () => {
    for (const memory of [null, 0, -4, Number.NaN, Number.POSITIVE_INFINITY, '4', {}]) {
      expect(videoStudioTotalBytesLimit(memory)).toBe(maxVideoStudioTotalBytes)
    }
    // Node has a navigator without deviceMemory, the same as an engine that does not report it.
    expect(videoStudioTotalBytesLimit()).toBe(maxVideoStudioTotalBytes)
    vi.stubGlobal('navigator', undefined)
    expect(videoStudioTotalBytesLimit()).toBe(maxVideoStudioTotalBytes)
  })

  it('stops the page and the worker at the same memory-based total, naming the number it stopped at', () => {
    vi.stubGlobal('navigator', { deviceMemory: 4 })
    expect(addVideoStudioClipBytes(0, 512 * megabyte)).toBe(512 * megabyte)
    expect(() => addVideoStudioClipBytes(512 * megabyte, 1)).toThrow('片段加起来超过 512 MB 了，少放几段再拼')
    const tooMuch = { kind: 'compose', request: { clips: [sizedClip(300 * megabyte), sizedClip(300 * megabyte)], options } }
    expect(() => parseVideoStudioWorkerMessage(tooMuch)).toThrow('片段加起来超过 512 MB 了，少放几段再拼')

    vi.stubGlobal('navigator', { deviceMemory: 2 })
    expect(() => addVideoStudioClipBytes(200 * megabyte, 100 * megabyte)).toThrow('片段加起来超过 256 MB 了，少放几段再拼')
    expect(() => parseVideoStudioWorkerMessage(tooMuch)).toThrow('片段加起来超过 256 MB 了，少放几段再拼')

    // An 8 GB computer keeps the room it had: two 300 MB clips still go through.
    vi.stubGlobal('navigator', { deviceMemory: 8 })
    expect(parseVideoStudioWorkerMessage(tooMuch).request.clips).toHaveLength(2)
    expect(addVideoStudioClipBytes(0, maxVideoStudioTotalBytes)).toBe(maxVideoStudioTotalBytes)
  })

  it('uses a limit handed in over the one it reads, so the page reads the memory once per export', () => {
    vi.stubGlobal('navigator', { deviceMemory: 8 })
    expect(() => addVideoStudioClipBytes(0, 300 * megabyte, 256 * megabyte)).toThrow('片段加起来超过 256 MB 了，少放几段再拼')
    expect(() => parseVideoStudioComposeRequest({ clips: [sizedClip(300 * megabyte)], options }, 256 * megabyte)).toThrow('片段加起来超过 256 MB 了，少放几段再拼')
  })

  it('always lands on a whole number of MB between 256 MB and 1 GB that never shrinks as memory grows, with random inputs', () => {
    fc.assert(fc.property(fc.double({ noNaN: true }), fc.double({ noNaN: true }), (a, b) => {
      const limit = videoStudioTotalBytesLimit(a)
      expect(limit).toBeGreaterThanOrEqual(minVideoStudioTotalBytes)
      expect(limit).toBeLessThanOrEqual(maxVideoStudioTotalBytes)
      expect(limit % megabyte).toBe(0)
      if (a > 0 && b > a && Number.isFinite(b)) expect(videoStudioTotalBytesLimit(b)).toBeGreaterThanOrEqual(limit)
    }))
  })

  it('accepts only compose messages in the worker', () => {
    expect(parseVideoStudioWorkerMessage({ kind: 'compose', request: { clips: [clip()], options } }).request.options).toEqual(options)
    expect(() => parseVideoStudioWorkerMessage({ kind: 'cancel' })).toThrow('拼片线程收到了看不懂的消息')
  })

  it('reads worker replies by whitelist and drops anything else', () => {
    expect(parseVideoStudioWorkerReply({ kind: 'progress', progress: { stage: 'rendering', ratio: 1.4 } }))
      .toEqual({ kind: 'progress', progress: { stage: 'rendering', ratio: 1 } })
    const data = new ArrayBuffer(2)
    const result = { data, mimeType: 'video/mp4; codecs="avc1.4d4029, opus"', videoCodec: 'avc', audioCodec: 'opus', width: 720, height: 1280, duration: 3 }
    expect(parseVideoStudioWorkerReply({ kind: 'done', result: { ...result, extra: 1 } })).toEqual({ kind: 'done', result })
    expect(parseVideoStudioWorkerReply({ kind: 'done', result: { ...result, audioCodec: null } })).toMatchObject({ result: { audioCodec: null } })
    expect(parseVideoStudioWorkerReply({ kind: 'failed', message: '出错了', detail: 'Error: x' })).toEqual({ kind: 'failed', message: '出错了', detail: 'Error: x' })
    expect(parseVideoStudioWorkerReply({ kind: 'failed', message: '出错了', detail: 4 })).toEqual({ kind: 'failed', message: '出错了', detail: undefined })

    expect(parseVideoStudioWorkerReply({ kind: 'progress', progress: { stage: 'uploading', ratio: 0.5 } })).toBeNull()
    expect(parseVideoStudioWorkerReply({ kind: 'done', result: { ...result, data: 'bytes' } })).toBeNull()
    expect(parseVideoStudioWorkerReply({ kind: 'done', result: { ...result, videoCodec: 'hevc' } })).toBeNull()
    expect(parseVideoStudioWorkerReply({ kind: 'done', result: { ...result, duration: Number.NaN } })).toBeNull()
    expect(parseVideoStudioWorkerReply({ kind: 'failed', message: '' })).toBeNull()
    expect(parseVideoStudioWorkerReply({ kind: 'log' })).toBeNull()
    expect(parseVideoStudioWorkerReply('done')).toBeNull()
  })
})
