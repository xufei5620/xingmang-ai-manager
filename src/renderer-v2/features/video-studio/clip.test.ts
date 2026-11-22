import { describe, expect, it } from 'vitest'
import { assetThumbnailUrl } from '../../../../electron/asset-thumbnail'
import { readVideoClip, readVideoRequestId, videoClipPlayUrl } from './clip'

const assetId = 'v'.repeat(43)

describe('stored video clip', () => {
  it('reads a clip and points its thumbnail at the current thumbnail version', () => {
    const stored = { assetId, thumbnailUrl: `xingmang-asset://thumb/v1/video/${assetId}`, width: 1280, height: 720, durationSeconds: 5.2, extra: 'ignored' }
    expect(readVideoClip(stored)).toEqual({ assetId, thumbnailUrl: assetThumbnailUrl(assetId, 'video'), width: 1280, height: 720, durationSeconds: 5.2 })
  })

  it('leaves out measurements that are missing or make no sense', () => {
    const base = { assetId, thumbnailUrl: assetThumbnailUrl(assetId, 'video') }
    expect(readVideoClip({ ...base, width: 0, height: -1, durationSeconds: Number.NaN })).toEqual(base)
    expect(readVideoClip({ ...base, width: '1280', durationSeconds: Infinity })).toEqual(base)
  })

  // Why this matters: the address goes straight into <img src> and the id into the play address, so only the
  // main process's own thumbnail address for this very clip is accepted.
  it('refuses a clip whose id or thumbnail address is not the main process kind', () => {
    const good = assetThumbnailUrl(assetId, 'video')
    for (const bad of [
      null, 'clip', [], {},
      { assetId: 'short', thumbnailUrl: good },
      { assetId: `${assetId}/../x`, thumbnailUrl: good },
      { assetId, thumbnailUrl: 'https://example.invalid/poster.png' },
      { assetId, thumbnailUrl: `file:///C:/Users/x/${assetId}` },
      { assetId, thumbnailUrl: assetThumbnailUrl(assetId, 'image') },
      { assetId, thumbnailUrl: assetThumbnailUrl('w'.repeat(43), 'video') },
      { assetId, thumbnailUrl: `${good}?next=https://example.invalid` },
      { assetId, thumbnailUrl: 42 },
    ]) expect(readVideoClip(bad), JSON.stringify(bad)).toBeUndefined()
  })

  it('accepts only request ids the page itself makes', () => {
    expect(readVideoRequestId('3f1c2b9e-7a44-4a2f-9d0e-1b2c3d4e5f60')).toBe('3f1c2b9e-7a44-4a2f-9d0e-1b2c3d4e5f60')
    expect(readVideoRequestId('request-1')).toBe('request-1')
    for (const bad of ['', '../other', 'a b', 'r'.repeat(65), 'id_with_underscore', 7, null, undefined]) expect(readVideoRequestId(bad)).toBeUndefined()
  })

  it('plays a clip from the asset library address', () => {
    expect(videoClipPlayUrl(assetId)).toBe(`xingmang-asset://video/${assetId}`)
  })
})
