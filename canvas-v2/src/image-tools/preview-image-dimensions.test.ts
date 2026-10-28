import { describe, expect, it } from 'vitest'
import type { AssetRef } from '../model'
import { imagePreviewOriginalOutputSize, imagePreviewSourceKey, recordImagePreviewSize, resolveImagePreviewSize } from './preview-image-dimensions'

const asset: AssetRef = { kind: 'image', assetId: 'oriented-jpeg', localUrl: '/api/assets/oriented-jpeg/content', width: 600, height: 400 }

describe('decoded image preview dimensions', () => {
  it('prefers EXIF-oriented natural dimensions over the unrotated JPEG header', () => {
    const source = imagePreviewSourceKey(asset)
    const measured = recordImagePreviewSize(new Map(), new Set([source]), source, 400, 600)
    expect(resolveImagePreviewSize(asset, measured)).toEqual({ width: 400, height: 600 })
    expect(imagePreviewOriginalOutputSize(resolveImagePreviewSize(asset, measured))).toEqual({ width: 400, height: 600 })
    expect(asset).toMatchObject({ width: 600, height: 400 })
  })

  it('uses metadata only as a loading fallback and falls back atomically for incomplete dimensions', () => {
    expect(resolveImagePreviewSize(asset, new Map())).toEqual({ width: 600, height: 400 })
    expect(resolveImagePreviewSize({ ...asset, height: undefined }, new Map())).toEqual({ width: 1024, height: 1024 })
    expect(resolveImagePreviewSize(undefined, new Map())).toEqual({ width: 1024, height: 1024 })
  })

  it('does not reuse dimensions across asset or URL versions', () => {
    const source = imagePreviewSourceKey(asset)
    const measured = recordImagePreviewSize(new Map(), new Set([source]), source, 400, 600)
    expect(resolveImagePreviewSize({ ...asset, assetId: 'new-owner-asset' }, measured)).toEqual({ width: 600, height: 400 })
    expect(resolveImagePreviewSize({ ...asset, localUrl: `${asset.localUrl}?v=2` }, measured)).toEqual({ width: 600, height: 400 })
  })

  it('ignores a late load from an image removed or replaced before it decoded', () => {
    const oldSource = imagePreviewSourceKey(asset), newSource = imagePreviewSourceKey({ ...asset, assetId: 'replacement' })
    const current = new Map([[newSource, { width: 300, height: 800 }]])
    expect(recordImagePreviewSize(current, new Set([newSource]), oldSource, 400, 600)).toBe(current)
  })

  it('does not rerender for duplicate loads and bounds the cache to current source identities', () => {
    const source = imagePreviewSourceKey(asset)
    const initial = new Map([['removed', { width: 5, height: 5 }]])
    const measured = recordImagePreviewSize(initial, new Set([source]), source, 400, 600)
    expect(measured.size).toBe(1)
    expect(recordImagePreviewSize(measured, new Set([source]), source, 400, 600)).toBe(measured)
  })

  it.each([[0, 100], [100, 0], [NaN, 100], [100, Infinity], [1.5, 100]])('ignores invalid natural dimensions %s × %s', (width, height) => {
    const source = imagePreviewSourceKey(asset), current = new Map()
    expect(recordImagePreviewSize(current, new Set([source]), source, width, height)).toBe(current)
  })

  it('keeps the oriented aspect ratio when fitting large original dimensions to the output limit', () => {
    expect(imagePreviewOriginalOutputSize({ width: 6000, height: 4000 })).toEqual({ width: 4096, height: 2731 })
    expect(imagePreviewOriginalOutputSize({ width: 4000, height: 6000 })).toEqual({ width: 2731, height: 4096 })
  })
})
