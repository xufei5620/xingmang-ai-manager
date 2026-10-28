import { describe, expect, it } from 'vitest'
import {
  isMediaResultKind,
  mediaBoundChipKind,
  mediaBoundChipLabel,
  usesMediaBoundLayout,
} from './media-bound'

describe('media-bound layout', () => {
  it('treats generate nodes as picture-only even before they have a result', () => {
    expect(usesMediaBoundLayout('image-generate', undefined)).toBe(true)
    expect(usesMediaBoundLayout('image-generate', '')).toBe(true)
    expect(usesMediaBoundLayout('image-edit', 'a'.repeat(43))).toBe(true)
    expect(usesMediaBoundLayout('video-generate', undefined)).toBe(true)
    expect(usesMediaBoundLayout('image-input', 'a'.repeat(43))).toBe(true)
  })

  it('keeps imported media sources as a form until they have an asset', () => {
    expect(usesMediaBoundLayout('image-input', undefined)).toBe(false)
    expect(usesMediaBoundLayout('image-input', '')).toBe(false)
    expect(usesMediaBoundLayout('prompt', 'a'.repeat(43))).toBe(false)
  })

  it('labels generate chips as nodes and imported chips as media', () => {
    expect(isMediaResultKind('image-generate')).toBe(true)
    expect(mediaBoundChipKind('image-generate')).toBe('image')
    expect(mediaBoundChipKind('video-generate')).toBe('video')
    expect(mediaBoundChipLabel('image-generate')).toBe('图像节点')
    expect(mediaBoundChipLabel('image-edit')).toBe('图像节点')
    expect(mediaBoundChipLabel('video-generate')).toBe('视频节点')
    expect(mediaBoundChipLabel('image-input')).toBe('图像')
    expect(mediaBoundChipLabel('audio-input')).toBe('音频')
  })
})
