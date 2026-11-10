import { describe, expect, it } from 'vitest'
import { VideoStudioError } from './errors'
import {
  buildVideoStudioRenderPlan,
  formatVideoStudioDuration,
  maxVideoStudioClips,
  normalizeVideoStudioCaption,
  resolveVideoStudioOutputSize,
  videoStudioAudioSampleRate,
  videoStudioFadeLevel,
  videoStudioFrameRates,
  videoStudioSamplesPerFrame,
  videoStudioSourceFrameTimes,
  type VideoStudioRenderOptions,
} from './timeline'

const options: VideoStudioRenderOptions = { aspect: '16:9', resolution: 720, fit: 'cover', frameRate: 30 }

describe('video studio timeline', () => {
  it('reads the resolution as the short side and keeps both sides even', () => {
    expect(resolveVideoStudioOutputSize('16:9', 720)).toEqual({ width: 1280, height: 720 })
    expect(resolveVideoStudioOutputSize('9:16', 720)).toEqual({ width: 720, height: 1280 })
    expect(resolveVideoStudioOutputSize('16:9', 480)).toEqual({ width: 854, height: 480 })
    expect(resolveVideoStudioOutputSize('9:16', 1080)).toEqual({ width: 1080, height: 1920 })
    expect(resolveVideoStudioOutputSize('1:1', 480)).toEqual({ width: 480, height: 480 })
  })

  it('lays clips end to end on whole frames', () => {
    const plan = buildVideoStudioRenderPlan([
      { start: 0, end: 5 },
      { start: 0, end: 6.04, caption: '  第二段\r\n  字幕  ' },
      { start: 0.02, end: 3, trimStart: 0.5, trimEnd: 0.5 },
    ], options)
    expect(plan).toMatchObject({ width: 1280, height: 720, frameRate: 30, fit: 'cover' })
    expect(plan.segments).toEqual([
      { clipIndex: 0, sourceStart: 0, firstFrame: 0, frameCount: 150, caption: '', fadeInFrames: 0, fadeOutFrames: 0 },
      { clipIndex: 1, sourceStart: 0, firstFrame: 150, frameCount: 181, caption: '第二段\n字幕', fadeInFrames: 0, fadeOutFrames: 0 },
      { clipIndex: 2, sourceStart: 0.52, firstFrame: 331, frameCount: 59, caption: '', fadeInFrames: 0, fadeOutFrames: 0 },
    ])
    expect(plan.frameCount).toBe(390)
    expect(plan.duration).toBe(13)
  })

  it('fades between shots and at the end of the film only when asked, never eating a short shot', () => {
    const clips = [{ start: 0, end: 5 }, { start: 0, end: 0.6 }, { start: 0, end: 3 }]
    const fades = (extra: Partial<typeof options>) => buildVideoStudioRenderPlan(clips, { ...options, ...extra }).segments.map((segment) => [segment.fadeInFrames, segment.fadeOutFrames])
    expect(fades({})).toEqual([[0, 0], [0, 0], [0, 0]])
    // 0.4 s at 30 fps is 12 frames; the 0.6 s shot (18 frames) gives each end at most a third of itself.
    expect(fades({ transition: 'fade' })).toEqual([[0, 12], [6, 6], [12, 0]])
    expect(fades({ fadeOut: true })).toEqual([[0, 0], [0, 0], [0, 30]])
    expect(fades({ transition: 'fade', fadeOut: true })).toEqual([[0, 12], [6, 6], [12, 30]])
    // A single short shot fades out over at most half of itself.
    expect(buildVideoStudioRenderPlan([{ start: 0, end: 1 }], { ...options, fadeOut: true }).segments[0].fadeOutFrames).toBe(15)
    // @ts-expect-error A transition the engine does not know, as a poisoned request would send it.
    expect(() => buildVideoStudioRenderPlan(clips, { ...options, transition: 'wipe' })).toThrow('不支持这种转场')
  })

  it('tells how bright a frame or a sound sample is inside its fades', () => {
    const segment = { frameCount: 60, fadeInFrames: 10, fadeOutFrames: 20 }
    expect(videoStudioFadeLevel(segment, 0)).toBe(0)
    expect(videoStudioFadeLevel(segment, 5)).toBe(0.5)
    expect(videoStudioFadeLevel(segment, 10)).toBe(1)
    expect(videoStudioFadeLevel(segment, 40)).toBe(1)
    expect(videoStudioFadeLevel(segment, 50)).toBe(0.5)
    expect(videoStudioFadeLevel(segment, 60)).toBe(0)
    // Out of range positions clamp instead of going negative or above one.
    expect(videoStudioFadeLevel(segment, -3)).toBe(0)
    expect(videoStudioFadeLevel(segment, 61)).toBe(0)
    expect(videoStudioFadeLevel({ frameCount: 60, fadeInFrames: 0, fadeOutFrames: 0 }, 30)).toBe(1)
  })

  it('keeps the audio on a whole number of samples per frame for every frame rate', () => {
    for (const frameRate of videoStudioFrameRates) {
      expect(Number.isInteger(videoStudioSamplesPerFrame(frameRate))).toBe(true)
      expect(videoStudioSamplesPerFrame(frameRate) * frameRate).toBe(videoStudioAudioSampleRate)
    }
  })

  it('samples each output frame from the trimmed source', () => {
    const [segment] = buildVideoStudioRenderPlan([{ start: 1, end: 2, trimStart: 0.25 }], { ...options, frameRate: 24 }).segments
    const times = videoStudioSourceFrameTimes(segment, 24)
    expect(times).toHaveLength(18)
    expect(times[0]).toBe(1.25)
    expect(times[17]).toBeCloseTo(1.25 + 17 / 24, 10)
  })

  it('starts a clip whose first frames sit before zero at zero, like a player does', () => {
    const plan = buildVideoStudioRenderPlan([
      { start: -0.25, end: 1 },
      { start: -0.5, end: 2, trimStart: 0.5 },
      { start: 0.5, end: 2 },
    ], options)
    expect(plan.segments.map(({ sourceStart, frameCount }) => ({ sourceStart, frameCount }))).toEqual([
      { sourceStart: 0, frameCount: 30 },
      { sourceStart: 0.5, frameCount: 45 },
      { sourceStart: 0.5, frameCount: 45 },
    ])
    expect(() => buildVideoStudioRenderPlan([{ start: -1, end: 0 }], options)).toThrow('第 1 段片段的时长读不出来')
  })

  it('normalizes captions without touching their words', () => {
    expect(normalizeVideoStudioCaption(undefined)).toBe('')
    expect(normalizeVideoStudioCaption('  \n \r\n ')).toBe('')
    expect(normalizeVideoStudioCaption(' Hello  world \r\r 你好 ')).toBe('Hello  world\n你好')
  })

  it('rejects timelines that cannot be rendered with a message the user can act on', () => {
    function failure(run: () => unknown) {
      try {
        run()
      } catch (error) {
        expect(error).toBeInstanceOf(VideoStudioError)
        return error instanceof Error ? error.message : ''
      }
      throw new Error('expected a failure')
    }
    expect(failure(() => buildVideoStudioRenderPlan([], options))).toBe('至少要放一段片段才能拼成片')
    expect(failure(() => buildVideoStudioRenderPlan(Array.from({ length: maxVideoStudioClips + 1 }, () => ({ start: 0, end: 1 })), options)))
      .toBe(`一次最多拼 ${maxVideoStudioClips} 段片段`)
    expect(failure(() => buildVideoStudioRenderPlan([{ start: 0, end: 1 }, { start: 0, end: Number.NaN }], options))).toBe('第 2 段片段的时长读不出来')
    expect(failure(() => buildVideoStudioRenderPlan([{ start: 0, end: 1, trimStart: -1 }], options))).toBe('第 1 段的剪切时间不能是负数')
    expect(failure(() => buildVideoStudioRenderPlan([{ start: 0, end: 1, trimStart: 0.5, trimEnd: 0.4 }], options))).toBe('第 1 段剪掉首尾后不到 0.2 秒，没法用')
    expect(failure(() => buildVideoStudioRenderPlan([{ start: 0, end: 1, caption: '字'.repeat(201) }], options))).toBe('第 1 段的字幕太长了，最多 200 个字')
    expect(failure(() => buildVideoStudioRenderPlan([{ start: 0, end: 400 }, { start: 0, end: 201.5 }], options))).toBe('成片最长 10 分钟，现在是 10 分 2 秒')
    expect(failure(() => buildVideoStudioRenderPlan([{ start: 0, end: 1 }], { ...options, aspect: '4:3' as never }))).toBe('不支持这个画面比例')
    expect(failure(() => buildVideoStudioRenderPlan([{ start: 0, end: 1 }], { ...options, frameRate: 60 as never }))).toBe('不支持这个帧率')
  })

  it('does not call a timeline a fraction of a second over the limit exactly ten minutes', () => {
    const message = (() => {
      try {
        buildVideoStudioRenderPlan([{ start: 0, end: 300 }, { start: 0, end: 300.1 }], options)
      } catch (error) {
        return error instanceof Error ? error.message : ''
      }
      throw new Error('expected a failure')
    })()
    expect(message).toBe('成片最长 10 分钟，现在是 10 分 1 秒')
  })

  it('accepts a timeline exactly at the length limit', () => {
    expect(buildVideoStudioRenderPlan([{ start: 0, end: 300 }, { start: 0, end: 300 }], options).duration).toBe(600)
  })
})

describe('formatVideoStudioDuration', () => {
  it('writes seconds, then minutes and seconds, then hours and minutes', () => {
    expect(formatVideoStudioDuration(0)).toBe('0 秒')
    expect(formatVideoStudioDuration(45.4)).toBe('45 秒')
    expect(formatVideoStudioDuration(60)).toBe('1 分 0 秒')
    expect(formatVideoStudioDuration(602)).toBe('10 分 2 秒')
    expect(formatVideoStudioDuration(3600)).toBe('1 小时 0 分钟')
    expect(formatVideoStudioDuration(4503)).toBe('1 小时 15 分钟')
  })

  it('rounds the whole duration before splitting it, so seconds never reach 60', () => {
    expect(formatVideoStudioDuration(59.6)).toBe('1 分 0 秒')
    expect(formatVideoStudioDuration(659.7)).toBe('11 分 0 秒')
    expect(formatVideoStudioDuration(3599.6)).toBe('1 小时 0 分钟')
  })

  it('does not pad seconds with a leading zero', () => {
    expect(formatVideoStudioDuration(65)).toBe('1 分 5 秒')
  })
})
