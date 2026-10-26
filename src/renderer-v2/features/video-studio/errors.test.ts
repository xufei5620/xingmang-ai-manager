import { describe, expect, it } from 'vitest'
import { describeVideoStudioFailure, isVideoStudioAbort, throwIfVideoStudioAborted, VideoStudioError, videoStudioAbortError, videoStudioFailureDetail } from './errors'

describe('video studio errors', () => {
  it('shows our own messages as they are and replaces browser errors with something actionable', () => {
    expect(describeVideoStudioFailure(new VideoStudioError('第 1 段片段里没有画面'))).toBe('第 1 段片段里没有画面')
    expect(describeVideoStudioFailure(videoStudioAbortError())).toBe('已取消')
    expect(describeVideoStudioFailure(new RangeError('Array buffer allocation failed'))).toBe('电脑内存不够拼这么长的片子，少放几段或调低清晰度再试')
    expect(describeVideoStudioFailure(new DOMException('quota', 'QuotaExceededError'))).toBe('电脑内存不够拼这么长的片子，少放几段或调低清晰度再试')
    expect(describeVideoStudioFailure(new DOMException('Decoding error.', 'EncodingError'))).toBe('拼接视频时出错了，换几段片段或调低清晰度再试一次')
    expect(describeVideoStudioFailure('boom')).toBe('拼接视频时出错了，换几段片段或调低清晰度再试一次')
  })

  it('recognizes a cancellation only by its name', () => {
    expect(isVideoStudioAbort(videoStudioAbortError())).toBe(true)
    expect(isVideoStudioAbort(new Error('AbortError'))).toBe(false)
    const controller = new AbortController()
    expect(() => throwIfVideoStudioAborted(controller.signal)).not.toThrow()
    controller.abort()
    expect(() => throwIfVideoStudioAborted(controller.signal)).toThrow(DOMException)
    expect(() => throwIfVideoStudioAborted(undefined)).not.toThrow()
  })

  it('keeps the diagnostic detail short', () => {
    expect(videoStudioFailureDetail(new TypeError('bad'))).toBe('TypeError: bad')
    const long = videoStudioFailureDetail(new Error('x'.repeat(1000)))
    expect(long).toHaveLength(301)
    expect(long.endsWith('…')).toBe(true)
  })
})
