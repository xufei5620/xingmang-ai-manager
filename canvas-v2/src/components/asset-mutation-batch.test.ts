import { describe, expect, it, vi } from 'vitest'
import { resolveCanvasAssetMutationResult, runCanvasAssetMutationBatch } from './asset-mutation-batch'
import { maximumAssetBatchCount } from './asset-batch-selection'

function id(index: number) { return String(index).padStart(43, '0') }
describe('confirmed canvas asset mutation batches', () => {
  it('continues after an independently rejected item and records actual successful receipts in input order', async () => {
    const perform = vi.fn(async (assetId: string) => { if (assetId === id(2)) throw new Error('仍被共享项目引用'); return { assetId, deletedAt: '2026-10-18T00:00:00Z' } })
    const result = await runCanvasAssetMutationBatch({ action: 'delete', ids: [id(1), id(2), id(3)], current: () => true, perform })
    expect(perform.mock.calls.flat()).toEqual([id(1), id(2), id(3)])
    expect(result.outcomes.map((item) => [item.assetId, item.state])).toEqual([[id(1), 'succeeded'], [id(2), 'unconfirmed'], [id(3), 'succeeded']])
    expect(result.outcomes[1].message).toBe('仍被共享项目引用')
  })
  it('keeps an accepted write receipt but stops all unsent operations after scope changes', async () => {
    let current = true, complete!: (value: { assetId: string; deletedAt: string }) => void
    const perform = vi.fn(() => new Promise<{ assetId: string; deletedAt: string }>((resolve) => { complete = resolve }))
    const ids = [id(1), id(2)], request = runCanvasAssetMutationBatch({ action: 'delete', ids, current: () => current, perform })
    ids.push(id(3)); current = false; complete({ assetId: id(1), deletedAt: 'now' })
    expect((await request).outcomes.map((item) => item.state)).toEqual(['succeeded', 'not-started']); expect(perform).toHaveBeenCalledTimes(1)
  })
  it('does not confirm wrong identities, missing recycle receipts or a still-deleted restore', async () => {
    const wrong = await runCanvasAssetMutationBatch({ action: 'delete', ids: [id(1), id(2)], current: () => true, perform: async (assetId) => assetId === id(1) ? { assetId: id(9), deletedAt: 'now' } : { assetId } })
    expect(wrong.outcomes.every((item) => item.state === 'unconfirmed')).toBe(true)
    const restored = await runCanvasAssetMutationBatch({ action: 'restore', ids: [id(1)], current: () => true, perform: async (assetId) => ({ assetId, deletedAt: 'still deleted' }) })
    expect(restored.outcomes[0].state).toBe('unconfirmed')
  })
  it('validates the whole bounded batch before sending any item', async () => {
    const perform = vi.fn(async (assetId: string) => ({ assetId }))
    for (const ids of [[], [id(1), id(1)], [id(1), '../bad'], Array.from({ length: maximumAssetBatchCount + 1 }, (_, index) => id(index))]) {
      await expect(runCanvasAssetMutationBatch({ action: 'restore', ids, current: () => true, perform })).rejects.toThrow('请选择')
    }
    expect(perform).not.toHaveBeenCalled()
  })
  it('keeps the legacy void callback contract and rejects mismatched structured receipts', () => {
    expect(resolveCanvasAssetMutationResult('restore', [id(1)], undefined).outcomes).toEqual([{ assetId: id(1), state: 'succeeded', message: '已恢复' }])
    expect(() => resolveCanvasAssetMutationResult('delete', [id(1)], { action: 'delete', outcomes: [{ assetId: id(9), state: 'succeeded', message: 'wrong' }] })).toThrow('不一致')
    expect(() => resolveCanvasAssetMutationResult('delete', [id(1)], { action: 'restore', outcomes: [{ assetId: id(1), state: 'succeeded', message: 'wrong action' }] })).toThrow('不一致')
  })
  it('preserves a confirmed rejection distinctly from an unknown result while retaining exact identity checks', () => {
    const result = { action: 'delete' as const, outcomes: [{ assetId: id(1), state: 'rejected' as const, message: '后续修改已保留' }] }
    expect(resolveCanvasAssetMutationResult('delete', [id(1)], result)).toBe(result)
    expect(() => resolveCanvasAssetMutationResult('delete', [id(2)], result)).toThrow('不一致')
  })
})
