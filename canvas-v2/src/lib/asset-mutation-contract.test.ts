import { describe, expect, it } from 'vitest'
import { assetMutationRequestDigest, confirmAssetMutationResult, isAssetMutationResult, parseAssetMutationInput, parseAssetMutationInspection, type AssetMutationInput, type AssetMutationResult } from './asset-mutation-contract'

const A = 'a'.repeat(43), B = 'b'.repeat(43), OP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
function result(input: AssetMutationInput, digest: string): AssetMutationResult {
  return { version: 1, operationId: input.operationId, requestDigest: digest, action: input.action, createdAt: '2026-10-18T00:00:00.000Z', outcomes: [{ assetId: A, displayName: '素材', state: 'succeeded', changed: true, undoable: input.action !== 'undo', message: '已完成' }], ...(input.action === 'undo' ? { undoOf: { operationId: input.originalOperationId, requestDigest: input.originalRequestDigest } } : {}) }
}
describe('ordinary asset mutation contracts', () => {
  it('preserves ordered identities and canonicalizes only declared text and operation IDs', async () => {
    const input = parseAssetMutationInput({ assetIds: [B, A], action: 'favorite', operationId: OP.toUpperCase() })
    expect(input).toEqual({ operationId: OP, action: 'favorite', assetIds: [B, A] })
    expect(await assetMutationRequestDigest(input)).toBe(await assetMutationRequestDigest({ assetIds: [B, A], action: 'favorite', operationId: OP }))
    expect(await assetMutationRequestDigest(input)).not.toBe(await assetMutationRequestDigest({ ...input, assetIds: [A, B] }))
    expect(parseAssetMutationInput({ operationId: OP, action: 'rename', assetId: A, displayName: '  自有 😀  ' })).toMatchObject({ displayName: '自有 😀' })
  })
  it.each([
    { action: 'purge', assetIds: [A] }, { action: 'favorite', assetIds: [] }, { action: 'favorite', assetIds: [A, A] }, { action: 'favorite', assetIds: [A], expectedVersion: 1 },
    { action: 'tags', assetIds: [A], tags: ['a', 'a'] }, { action: 'tags', assetIds: [A], tags: Array.from({ length: 21 }, (_, index) => `${index}`) }, { action: 'tags', assetIds: [A], tags: ['x'.repeat(41)] },
    { action: 'rename', assetId: A, displayName: '\ud800' }, { action: 'rename', assetId: A, displayName: '\nname' }, { action: 'favorite', assetIds: ['../wrong'] },
    { action: 'undo', assetIds: [A], originalOperationId: OP, originalRequestDigest: 'a'.repeat(64) },
  ])('rejects malformed or unsupported mutation %j', (value) => { expect(() => parseAssetMutationInput({ operationId: OP, ...value })).toThrow() })
  it('requires exact original digest, action, targets and undo identity in inspected receipts', async () => {
    const input: AssetMutationInput = { operationId: OP, action: 'favorite', assetIds: [A] }, digest = await assetMutationRequestDigest(input), receipt = result(input, digest)
    expect(parseAssetMutationInspection({ status: 'applied', operationId: OP, requestDigest: digest, result: receipt }, input, digest)).toMatchObject({ status: 'applied', result: receipt })
    expect(() => parseAssetMutationInspection({ status: 'missing', operationId: OP, requestDigest: digest }, input)).toThrow()
    expect(() => parseAssetMutationInspection({ status: 'missing', operationId: OP, requestDigest: 'b'.repeat(64) }, input, digest)).toThrow()
    expect(() => confirmAssetMutationResult(input, { ...receipt, outcomes: [{ ...receipt.outcomes[0], assetId: B }] }, digest)).toThrow()
    expect(() => confirmAssetMutationResult(input, { ...receipt, action: 'unfavorite' }, digest)).toThrow()
    const undo: AssetMutationInput = { operationId: crypto.randomUUID(), action: 'undo', assetIds: [A], originalOperationId: OP, originalRequestDigest: digest }, undoDigest = await assetMutationRequestDigest(undo)
    expect(() => confirmAssetMutationResult(undo, { ...result(undo, undoDigest), undoOf: { operationId: OP, requestDigest: 'c'.repeat(64) } }, undoDigest)).toThrow()
  })
  it('rejects future or contradictory outcomes rather than treating unknown states as success', async () => {
    const input: AssetMutationInput = { operationId: OP, action: 'favorite', assetIds: [A] }, receipt = result(input, await assetMutationRequestDigest(input))
    expect(isAssetMutationResult(receipt)).toBe(true)
    for (const value of [{ ...receipt, version: 2 }, { ...receipt, extra: true }, { ...receipt, outcomes: [{ ...receipt.outcomes[0], state: 'unconfirmed' }] }, { ...receipt, outcomes: [{ ...receipt.outcomes[0], state: 'rejected' }] }, { ...receipt, outcomes: [{ ...receipt.outcomes[0], changed: false }] }, { ...receipt, createdAt: 'not a date' }]) expect(isAssetMutationResult(value)).toBe(false)
  })
})
