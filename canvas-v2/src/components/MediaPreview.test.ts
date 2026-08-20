import { describe, expect, it } from 'vitest'
import { canvasAssetIsPreviewable, downsampleWaveform, formatMediaTime, isCanvasImagePreviewUrl, isLocalCanvasAssetUrl, waveformAreaPath } from './MediaPreview'

describe('canvas media preview protocol', () => {
  it('accepts owned image, video, and audio asset URLs', () => {
    const assetId = 'a'.repeat(43)
    expect(isLocalCanvasAssetUrl(`xingmang-asset://image/${assetId}`)).toBe(true)
    expect(isLocalCanvasAssetUrl(`xingmang-asset://video/${assetId}`)).toBe(true)
    expect(isLocalCanvasAssetUrl(`xingmang-asset://audio/${assetId}`)).toBe(true)
  })

  it('can require the URL media kind to match the renderer', () => {
    const assetId = 'a'.repeat(43)
    expect(isLocalCanvasAssetUrl(`xingmang-asset://image/${assetId}`, 'image')).toBe(true)
    expect(isLocalCanvasAssetUrl(`xingmang-asset://image/${assetId}`, 'video')).toBe(false)
    expect(isLocalCanvasAssetUrl(`xingmang-asset://audio/${assetId}`, 'audio')).toBe(true)
  })

  it('rejects remote URLs, filesystem paths, and malformed asset identifiers', () => {
    expect(isLocalCanvasAssetUrl('https://example.com/video.mp4')).toBe(false)
    expect(isLocalCanvasAssetUrl('C:\\Users\\speaker\\video.mp4')).toBe(false)
    expect(isLocalCanvasAssetUrl('xingmang-asset://video/short-id')).toBe(false)
    expect(isLocalCanvasAssetUrl('xingmang-asset://image/' + 'a'.repeat(42))).toBe(false)
    expect(isLocalCanvasAssetUrl('xingmang-asset://image/' + 'a'.repeat(44))).toBe(false)
  })

  it('treats a derived thumbnail URL as a paintable image still', () => {
    const assetId = 'b'.repeat(43)
    expect(isCanvasImagePreviewUrl(`xingmang-asset://thumb/v1/image/${assetId}`)).toBe(true)
    expect(isCanvasImagePreviewUrl(`xingmang-asset://image/${assetId}`)).toBe(true)
    expect(isCanvasImagePreviewUrl(`xingmang-asset://video/${assetId}`)).toBe(false)
    expect(canvasAssetIsPreviewable({
      mediaType: 'image',
      localUrl: `xingmang-asset://image/${assetId}`,
      thumbnailUrl: `xingmang-asset://thumb/v1/image/${assetId}`,
    })).toBe(true)
    expect(canvasAssetIsPreviewable({
      mediaType: 'video',
      localUrl: `xingmang-asset://video/${assetId}`,
      thumbnailUrl: `xingmang-asset://thumb/v1/video/${assetId}`,
    })).toBe(true)
    expect(canvasAssetIsPreviewable({
      mediaType: 'image',
      localUrl: '',
      thumbnailUrl: `xingmang-asset://video/${assetId}`,
    })).toBe(false)
  })
})

describe('audio waveform preview', () => {
  it('downsamples decoded audio amplitudes and normalizes the strongest bucket', () => {
    const channel = Float32Array.from([0, 0.25, -0.5, 0.1, 0.2, -1, 0.4, 0])
    const peaks = downsampleWaveform({
      numberOfChannels: 1,
      length: channel.length,
      duration: 1,
      getChannelData: () => channel,
    }, 8)

    expect(peaks).toHaveLength(8)
    expect(peaks[5]).toBe(1)
    expect(peaks[2]).toBe(0.5)
    expect(peaks.every((peak) => peak >= 0 && peak <= 1)).toBe(true)
  })

  it('keeps waveform work bounded and formats media time defensively', () => {
    const silent = new Float32Array(400)
    expect(downsampleWaveform({ numberOfChannels: 1, length: silent.length, getChannelData: () => silent }, 1)).toHaveLength(8)
    expect(downsampleWaveform({ numberOfChannels: 1, length: silent.length, getChannelData: () => silent }, 999)).toHaveLength(128)
    expect(formatMediaTime(65.9)).toBe('1:05')
    expect(formatMediaTime(Number.NaN)).toBe('0:00')
  })

  it('builds one continuous filled waveform path', () => {
    const path = waveformAreaPath([0, 0.5, 1], 100, 30)
    expect(path).toBe('M 0 29 L 0.00 27.50 L 50.00 15.50 L 100.00 2.00 L 100 29 Z')
    expect(path.match(/ L /g)).toHaveLength(4)
  })
})
