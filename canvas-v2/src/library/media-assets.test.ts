import { describe, expect, it } from 'vitest'
import type { CanvasAudioAssetSummary, CanvasImageAssetSummary, CanvasVideoAssetSummary } from '../host'
import {
  assetInputNodeKind,
  formatMediaDuration,
  imageAssetForBinding,
  mediaAssetAspectRatio,
  mediaAssetNodeDimensions,
  mediaAssetSizeLabel,
  parseSizePixels,
  pendingMediaNodeDimensions,
  requestedSizeLabel,
  applyCatalogClipDurationToNodes,
  mediaAssetDurationSeconds,
  mediaClipDurationChipLabel,
  mediaDurationLabel,
  mediaHoverTitle,
  requestedClipDurationSeconds,
  mediaResultNodeDimensions,
  videoAspectRatioForSize,
} from './media-assets'

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
    expect(mediaAssetNodeDimensions(video, '720x1280')).toEqual({ width: 270, height: 480 })
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

  it('sizes an empty generate node from the requested output ratio', () => {
    expect(parseSizePixels('1152x1536')).toEqual({ width: 1152, height: 1536 })
    expect(requestedSizeLabel('1152x1536')).toBe('1152 × 1536')
    expect(pendingMediaNodeDimensions('image-generate', '1024x1024')).toEqual({ width: 280, height: 280 })
    expect(pendingMediaNodeDimensions('image-generate', '1152x1536')).toEqual({ width: 280, height: 373 })
    expect(pendingMediaNodeDimensions('video-generate', '1280x720')).toEqual({ width: 320, height: 180 })
    expect(pendingMediaNodeDimensions('video-generate', '720x1280')).toEqual({ width: 270, height: 480 })
  })

  it('never binds a video asset to an image input', () => {
    expect(imageAssetForBinding(image)).toBe(image)
    expect(imageAssetForBinding(video)).toBeNull()
  })

  it('reports the real pixel size and omits the line when the record has none', () => {
    expect(mediaAssetSizeLabel({ ...image, width: 800, height: 1000 })).toBe('800 × 1000')
    expect(mediaAssetSizeLabel({ kind: 'video', width: 448, height: 672 })).toBe('448 × 672')
    // The node box and the fallback ratios would both produce a confident
    // number here. Guessing is worse than staying silent.
    expect(mediaAssetSizeLabel(image)).toBeNull()
    expect(mediaAssetSizeLabel({ ...image, width: 800 })).toBeNull()
    expect(mediaAssetSizeLabel({ ...image, width: 0, height: 1000 })).toBeNull()
    expect(mediaAssetSizeLabel(audio)).toBeNull()
    expect(mediaAssetSizeLabel(undefined)).toBeNull()
  })

  it('formats duration only when the metadata carries one', () => {
    expect(formatMediaDuration(5.04)).toBe('0:05')
    expect(formatMediaDuration(3_671)).toBe('1:01:11')
    expect(mediaDurationLabel(2.113)).toBe('0:02')
    expect(mediaDurationLabel(undefined)).toBeNull()
    expect(mediaDurationLabel(0)).toBeNull()
    expect(mediaDurationLabel(Number.NaN)).toBeNull()
    expect(mediaClipDurationChipLabel(5.2)).toBe('时长 0:05')
    expect(mediaAssetDurationSeconds({ kind: 'video', durationSeconds: 8.4 })).toBe(8.4)
    expect(mediaAssetDurationSeconds({ kind: 'image' })).toBeUndefined()
    expect(requestedClipDurationSeconds('5')).toBe(5)
    expect(requestedClipDurationSeconds('16')).toBeUndefined()
  })

  it('fills missing clip duration from the asset catalog without overwriting measured values', () => {
    const assetId = 'v'.repeat(43)
    const filled = applyCatalogClipDurationToNodes(
      [
        { data: { result: { kind: 'video', assetId, localUrl: `xingmang-asset://video/${assetId}` } } },
        { data: { result: { kind: 'video', assetId: 'k'.repeat(43), durationSeconds: 8 } } },
      ],
      [{ assetId, durationSeconds: 5.2 }],
    )
    expect(filled[0].data.result?.durationSeconds).toBe(5.2)
    expect(filled[1].data.result?.durationSeconds).toBe(8)
  })

  it('joins only the hover lines that exist', () => {
    expect(mediaHoverTitle(['视频1.mp4', '448 × 672', '时长 0:05'])).toBe('视频1.mp4\n448 × 672\n时长 0:05')
    expect(mediaHoverTitle([null, '双击放大预览'])).toBe('双击放大预览')
    expect(mediaHoverTitle([null, undefined, ''])).toBeUndefined()
  })
})
