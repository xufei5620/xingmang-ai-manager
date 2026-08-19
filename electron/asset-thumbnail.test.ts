import { describe, expect, it } from 'vitest'
import {
  assetThumbnailFileName,
  assetThumbnailMimeType,
  assetThumbnailSize,
  assetThumbnailUrl,
  assetThumbnailVersion,
  parseAssetThumbnailPath,
} from './asset-thumbnail'

const assetId = 'a'.repeat(43)

describe('assetThumbnailUrl', () => {
  it('carries the pipeline version so a bump invalidates every cached response', () => {
    expect(assetThumbnailUrl(assetId, 'image')).toBe(`xingmang-asset://thumb/${assetThumbnailVersion}/image/${assetId}`)
    expect(assetThumbnailUrl(assetId, 'video')).toBe(`xingmang-asset://thumb/${assetThumbnailVersion}/video/${assetId}`)
  })
})

describe('parseAssetThumbnailPath', () => {
  it('accepts exactly a version, a media kind and an identifier', () => {
    expect(parseAssetThumbnailPath(`/${assetThumbnailVersion}/image/${assetId}`)).toEqual({ version: assetThumbnailVersion, mediaKind: 'image', assetId })
    expect(parseAssetThumbnailPath(`${assetThumbnailVersion}/video/${assetId}`)).toEqual({ version: assetThumbnailVersion, mediaKind: 'video', assetId })
  })

  it('rejects traversal, empty segments and malformed identifiers', () => {
    expect(parseAssetThumbnailPath(`/${assetThumbnailVersion}/image/../${assetId}`)).toBeNull()
    expect(parseAssetThumbnailPath(`/${assetThumbnailVersion}/image/`)).toBeNull()
    expect(parseAssetThumbnailPath(`//image/${assetId}`)).toBeNull()
    expect(parseAssetThumbnailPath(`/${assetThumbnailVersion}/image/${'a'.repeat(42)}`)).toBeNull()
    expect(parseAssetThumbnailPath(`/${assetThumbnailVersion}/image/${'a'.repeat(43)}.png`)).toBeNull()
    expect(parseAssetThumbnailPath(`/latest/image/${assetId}`)).toBeNull()
    expect(parseAssetThumbnailPath(`/${assetThumbnailVersion}/image/${assetId}/extra`)).toBeNull()
    expect(parseAssetThumbnailPath(`/${assetThumbnailVersion}/${assetId}`)).toBeNull()
  })

  it('rejects a media kind that no store can answer for', () => {
    expect(parseAssetThumbnailPath(`/${assetThumbnailVersion}/audio/${assetId}`)).toBeNull()
    expect(parseAssetThumbnailPath(`/${assetThumbnailVersion}/thumb/${assetId}`)).toBeNull()
  })
})

describe('assetThumbnailMimeType', () => {
  it('keeps PNG for sources that may carry transparency', () => {
    expect(assetThumbnailMimeType('image/png')).toBe('image/png')
    expect(assetThumbnailMimeType('image/webp')).toBe('image/png')
    expect(assetThumbnailMimeType('video/mp4')).toBe('image/png')
  })

  it('uses JPEG for photographic sources', () => {
    expect(assetThumbnailMimeType('image/jpeg')).toBe('image/jpeg')
  })
})

describe('assetThumbnailFileName', () => {
  it('matches the encoded format', () => {
    expect(assetThumbnailFileName(assetId, 'image/jpeg')).toBe(`${assetId}.jpg`)
    expect(assetThumbnailFileName(assetId, 'image/png')).toBe(`${assetId}.png`)
  })
})

describe('assetThumbnailSize', () => {
  it('contains a landscape source inside the box', () => {
    expect(assetThumbnailSize(1600, 900, 320)).toEqual({ width: 320, height: 180 })
  })

  it('contains a portrait source inside the box', () => {
    expect(assetThumbnailSize(900, 1600, 320)).toEqual({ width: 180, height: 320 })
  })

  it('never upscales a source that already fits', () => {
    expect(assetThumbnailSize(120, 80, 320)).toEqual({ width: 120, height: 80 })
  })

  it('never rounds an extreme aspect ratio down to zero', () => {
    expect(assetThumbnailSize(4000, 3, 320)).toEqual({ width: 320, height: 1 })
  })

  it('falls back to the full box for unusable dimensions', () => {
    expect(assetThumbnailSize(0, 0, 320)).toEqual({ width: 320, height: 320 })
    expect(assetThumbnailSize(Number.NaN, 100, 320)).toEqual({ width: 320, height: 320 })
  })
})
