import { describe, expect, it } from 'vitest'
import { collectAssetReferenceIds, collectNodeAssetReferences } from './asset-reference-values'

const assetId = 'a'.repeat(43)
const other = 'b'.repeat(43)

describe('asset reference values', () => {
  it('includes adopted and source fields used by input and recovered workflows', () => {
    expect(collectAssetReferenceIds({ adoptedAssetId: assetId, sourceAssetIds: [other, assetId], result: { assetId }, settings: { sourceAssetID: other } })).toEqual([assetId, other])
  })
  it('ignores arbitrary text, invalid identifiers and nested objects inside ID arrays', () => {
    expect(collectAssetReferenceIds({ prompt: assetId, assetId: '../private', candidateAssetIds: [{ assetId }, null, other], sources: [{ assetId }] })).toEqual([other, assetId])
  })
  it('preserves bounded traversal and merges each node only once', () => {
    let within: unknown = { assetId }
    let beyond: unknown = { assetId }
    for (let depth = 0; depth < 32; depth++) within = { next: within }
    for (let depth = 0; depth < 33; depth++) beyond = { next: beyond }
    expect(collectAssetReferenceIds(within)).toEqual([assetId])
    expect(collectAssetReferenceIds(beyond)).toEqual([])
    expect([...collectNodeAssetReferences([{ id: 'one', data: { assetId, sourceAssetIds: [assetId] } }, { id: 'two', data: { adoptedAssetId: assetId } }]).get(assetId)!]).toEqual(['one', 'two'])
  })
})
