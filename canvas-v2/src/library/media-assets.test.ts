import { describe, expect, it } from 'vitest'
import type { CanvasAudioAssetSummary, CanvasImageAssetSummary, CanvasVideoAssetSummary } from '../host'
import { assetInputNodeKind, imageAssetForBinding, mediaAssetAspectRatio, mediaAssetNodeDimensions, mediaResultNodeDimensions, videoAspectRatioForSize } from './media-assets'

const image: CanvasImageAssetSummary = {
  assetId: 'i'.repeat(43),
  localUrl: `xingmang-asset://image/${'i'.repeat(43)}`,
  thumbnailUrl: `xingmang-asset://image/${'i'.repeat(43)}`,
  mimeType: 'image/png',
  fileName: 'image.png',
  createdAt: '2026-08-14T00:00:00.000Z',
  mediaType: 'image',
  displayName: 'image.png',
}

const video: CanvasVideoAssetSummary = {
  assetId: 'v'.repeat(43),
  localUrl: `xingmang-asset://video/${'v'.repeat(43)}`,
  thumbnailUrl: `xingmang-asset://video/${'v'.repeat(43)}`,
  mimeType: 'video/mp4',
  fileName: 'video.mp4',
  taskId: 'task-1',
  createdAt: '2026-08-14T00:00:00.000Z',
  mediaType: 'video',
  displayName: 'video.mp4',
}

const audio: CanvasAudioAssetSummary = {
  assetId: 'a'.repeat(43),
  localUrl: `xingmang-asset://audio/${'a'.repeat(43)}`,
  thumbnailUrl: `xingmang-asset://audio/${'a'.repeat(43)}`,
  mimeType: 'audio/wav',
  fileName: 'audio.wav',
  createdAt: '2026-08-14T00:00:00.000Z',
  mediaType: 'audio',
  displayName: 'audio.wav',
}

describe('canvas media asset projection', () => {
  it('creates the matching input node for each media type', () => {
    expect(assetInputNodeKind(image)).toBe('image-input')
    expect(assetInputNodeKind(video)).toBe('video-input')
    expect(assetInputNodeKind(audio)).toBe('audio-input')
  })

  it('preserves common media ratios and keeps audio compact', () => {
    expect(mediaAssetNodeDimensions({ ...image, width: 1200, height: 1500 })).toEqual({ width: 280, height: 350 })
    expect(mediaAssetNodeDimensions({ ...video, width: 1920, height: 1080 })).toEqual({ width: 320, height: 180 })
    expect(mediaAssetNodeDimensions({ ...video, width: 1080, height: 1920 })).toEqual({ width: 270, height: 480 })
    expect(mediaAssetNodeDimensions(audio)).toEqual({ width: 360, height: 104 })
  })

  it('projects a stable CSS aspect ratio for media previews', () => {
    expect(mediaAssetAspectRatio({ ...video, width: 448, height: 672 })).toBe('448 / 672')
    expect(mediaAssetAspectRatio(video)).toBe('16 / 9')
    expect(mediaAssetAspectRatio(video, '720x1280')).toBe('720 / 1280')
    expect(mediaAssetAspectRatio(image)).toBe('1 / 1')
    expect(videoAspectRatioForSize('720x1280')).toBe('720 / 1280')
    expect(videoAspectRatioForSize('not-a-size')).toBeUndefined()
  })

  it('reserves the real height for portrait video results instead of clipping them in a fixed node', () => {
    expect(mediaResultNodeDimensions('video-generate', { ...video, width: 448, height: 672 }, 304, 360)).toEqual({ width: 304, height: 672 })
    expect(mediaResultNodeDimensions('video-generate', { ...video, width: 1920, height: 1080 }, 304, 360)).toEqual({ width: 304, height: 406 })
    expect(mediaResultNodeDimensions('video-generate', video, 304, 360, '720x1280')).toEqual({ width: 304, height: 751 })
    expect(mediaResultNodeDimensions('image-edit', { ...image, width: 1024, height: 1024 }, 304, 360)).toBeNull()
  })

  it('never binds a video asset to an image input', () => {
    expect(imageAssetForBinding(image)).toBe(image)
    expect(imageAssetForBinding(video)).toBeNull()
  })
})
