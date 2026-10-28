import { describe, expect, it } from 'vitest'
import { frameEditorComposing, frameEditorLastTimestamp, frameEditorMaximumBytes, frameEditorMetadata, frameEditorSeconds, frameEditorSelectionMatches, frameEditorTimecode, moveFrameEditorTimestamp, parseFrameEditorTimestamp, validateFrameEditorBlob } from './frame-editor-state'

describe('video frame editor draft validation', () => {
  it('accepts exact decimal seconds including zero and rejects EOF without silently changing a draft', () => {
    const metadata = frameEditorMetadata(12.345, 1280, 720)
    for (const [raw, value] of [['0', 0], [' 1.2345 ', 1.2345], ['.5', .5], ['2.', 2]] as const) expect(parseFrameEditorTimestamp(raw, metadata)).toEqual({ value, error: '' })
    for (const raw of ['', '-', '-1', '1e1', 'Infinity', 'NaN', '1 秒', '12.345', '20']) expect(parseFrameEditorTimestamp(raw, metadata).value).toBeNull()
    expect(parseFrameEditorTimestamp('12.345', metadata).error).toContain('小于')
    expect(parseFrameEditorTimestamp('0', null).value).toBeNull()
  })
  it('bounds metadata and video bytes before preview decoding', () => {
    expect(frameEditorMetadata(86_400, 4096, 4096)).toEqual({ duration: 86_400, width: 4096, height: 4096 })
    for (const duration of [0, -1, NaN, Infinity, 86_401]) expect(() => frameEditorMetadata(duration, 640, 480)).toThrow('时长')
    for (const [width, height] of [[0, 2], [640.5, 480], [4097, 2], [2, Infinity]]) expect(() => frameEditorMetadata(10, width, height)).toThrow('尺寸')
    expect(() => validateFrameEditorBlob(new Blob(['video'], { type: 'video/mp4' }))).not.toThrow()
    expect(() => validateFrameEditorBlob(new Blob([], { type: 'video/mp4' }))).toThrow('MP4')
    expect(() => validateFrameEditorBlob(new Blob(['video'], { type: 'video/webm' }))).toThrow('MP4')
    expect(() => validateFrameEditorBlob(new Blob([new Uint8Array(frameEditorMaximumBytes + 1)], { type: 'video/mp4' }))).toThrow('32 MB')
  })
  it('clamps manual steps before EOF without pretending that a step is one video frame', () => {
    const metadata = frameEditorMetadata(1.2345, 640, 480)
    expect(moveFrameEditorTimestamp(.2, -.3, metadata)).toBe(0)
    expect(moveFrameEditorTimestamp(.2, .1, metadata)).toBe(.3)
    expect(moveFrameEditorTimestamp(.2, 10, metadata)).toBe(1.233)
    expect(frameEditorLastTimestamp(.0005)).toBe(0)
    expect(frameEditorSeconds(1.2351)).toBe('1.235')
    expect(frameEditorTimecode(3723.456)).toBe('01:02:03.456')
    expect(frameEditorTimecode(NaN)).toBe('00:00.000')
  })
  it('requires both source identity and exact requested time to certify a preview', () => {
    const selected = { sourceAssetId: 'source-a', timestampSeconds: 1.2345 }
    expect(frameEditorSelectionMatches(selected, { ...selected })).toBe(true)
    expect(frameEditorSelectionMatches(selected, { ...selected, sourceAssetId: 'source-b' })).toBe(false)
    expect(frameEditorSelectionMatches(selected, { ...selected, timestampSeconds: 1.234 })).toBe(false)
    expect(frameEditorSelectionMatches(null, selected)).toBe(false)
    expect(frameEditorComposing({ isComposing: true })).toBe(true)
    expect(frameEditorComposing({ keyCode: 229 })).toBe(true)
    expect(frameEditorComposing({ keyCode: 13 })).toBe(false)
  })
})
