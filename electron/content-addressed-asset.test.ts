import { describe, expect, it } from 'vitest'
import { mediaContentDigest, scopedLocalAssetId } from './content-addressed-asset'

describe('content addressed media assets', () => {
  it('is stable within one account and asset root', () => {
    const bytes = Buffer.from('same media bytes')
    const first = scopedLocalAssetId('D:\\projects\\one\\assets', 36, bytes)
    const second = scopedLocalAssetId('D:\\projects\\one\\assets', 36, Buffer.from(bytes))
    expect(first).toBe(second)
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(mediaContentDigest(bytes)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('separates accounts, project roots, and different content', () => {
    const bytes = Buffer.from('same media bytes')
    const baseline = scopedLocalAssetId('D:\\projects\\one\\assets', 36, bytes)
    expect(scopedLocalAssetId('D:\\projects\\one\\assets', 37, bytes)).not.toBe(baseline)
    expect(scopedLocalAssetId('D:\\projects\\two\\assets', 36, bytes)).not.toBe(baseline)
    expect(scopedLocalAssetId('D:\\projects\\one\\assets', 36, Buffer.from('other media bytes'))).not.toBe(baseline)
  })
})
