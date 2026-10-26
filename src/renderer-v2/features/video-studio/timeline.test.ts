import { describe, expect, it } from 'vitest'
import { VideoStudioError } from './errors'
import {
  buildVideoStudioRenderPlan,
  maxVideoStudioClips,
  normalizeVideoStudioCaption,
  resolveVideoStudioOutputSize,
  videoStudioAudioSampleRate,
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
      { clipIndex: 0, sourceStart: 0, firstFrame: 0, frameCount: 150, caption: '' },
      { clipIndex: 1, sourceStart: 0, firstFrame: 150, frameCount: 181, caption: '第二段\n字幕' },
      { clipIndex: 2, sourceStart: 0.52, firstFrame: 331, frameCount: 59, caption: '' },
    ])
    expect(plan.frameCount).toBe(390)
    expect(plan.duration).toBe(13)
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

  it('accepts a timeline exactly at the length limit', () => {
    expect(buildVideoStudioRenderPlan([{ start: 0, end: 300 }, { start: 0, end: 300 }], options).duration).toBe(600)
  })
})
