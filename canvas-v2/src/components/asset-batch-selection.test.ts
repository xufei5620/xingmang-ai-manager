import { describe, expect, it, vi } from 'vitest'
import { assetBatchDragIds, assetBatchSelectionError, assetBatchUnavailableReason, createAssetBatchActionController, orderedAssetBatchIds, type AssetBatchActionState, type AssetBatchItem } from './asset-batch-selection'
import { runCandidateBatchItems } from './run-candidate-selection'
import type { CanvasRunCandidate, CanvasRunRecord } from '../host'

function id(value: number) { return String(value).padStart(43, '0') }
function item(value: number): AssetBatchItem { return { assetId: id(value), label: `素材${value}` } }
function delayed() { let resolve = () => {}; let reject = (_: Error) => {}; const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail }); return { promise, resolve, reject } }
function candidate(value: number, kind: 'image' | 'video' | 'audio' = 'image'): CanvasRunCandidate { return { candidateId: `candidate-${value}`, attemptId: 'attempt', createdAt: '', asset: { assetId: id(value), kind, localUrl: `xingmang-asset://${kind}/${id(value)}` } } }
function record(groups: CanvasRunCandidate[][]): CanvasRunRecord { return { version: 1, runId: 'run-a', userId: 1, ownerId: 1, graphRevision: 'g', scope: { kind: 'all' }, status: 'succeeded', createdAt: '', startedAt: '', nodes: groups.map((candidates, index) => ({ nodeId: `node-${index}`, kind: 'image-generate', state: 'succeeded', attempts: [{ attemptId: 'attempt', fingerprint: 'f', state: 'succeeded', startedAt: '', completedAt: '', durationMs: 0, cached: false, candidates }] })), events: [] } }

describe('ordered local asset batches', () => {
  it('uses display order and one identity for cached duplicate assets rather than click order', () => {
    expect(orderedAssetBatchIds([item(3), item(1), item(3), item(2)], new Set([id(2), id(3), id(1)]))).toEqual([id(3), id(1), id(2)])
  })
  it('drags the selected set in display order or only the unselected target', () => {
    const items = [item(3), item(1), item(2)], selection = { ids: new Set([id(2), id(3)]), anchor: id(2) }
    expect(assetBatchDragIds(items, selection, id(3))).toEqual([id(3), id(2)])
    expect(assetBatchDragIds(items, selection, id(1))).toEqual([id(1)])
  })
  it('refuses 51 items without truncation and accepts exactly 50', () => {
    const items = Array.from({ length: 51 }, (_, index) => item(index)), ids = items.map((value) => value.assetId)
    expect(assetBatchSelectionError(items, ids)).toContain('不会只处理前 50 项')
    expect(() => assetBatchDragIds(items, { ids: new Set(ids), anchor: ids[0] }, ids[0])).toThrow('最多处理 50')
    expect(assetBatchSelectionError(items, ids.slice(0, 50))).toBeUndefined()
  })
  it('reports each unavailable selection and never silently skips it', () => {
    const items = [{ ...item(1), unavailableReason: '原文件缺失' }, { ...item(2), unavailableReason: '素材已回收' }, item(3)]
    expect(assetBatchSelectionError(items, items.map((entry) => entry.assetId))).toBe('素材1：原文件缺失\n素材2：素材已回收')
    expect(() => assetBatchDragIds(items, { ids: new Set([id(1), id(3)]), anchor: id(3) }, id(3))).toThrow('素材1：原文件缺失')
  })
  it.each(['image', 'video', 'audio'] as const)('accepts only the saved local %s identity and rejects a different URL identity', (kind) => {
    const asset = candidate(1, kind).asset
    expect(assetBatchUnavailableReason(asset)).toBeUndefined()
    expect(assetBatchUnavailableReason({ ...asset, localUrl: `xingmang-asset://${kind}/${id(2)}` })).toBeTruthy()
    expect(assetBatchUnavailableReason({ ...asset, localUrl: 'https://example.com/private' })).toBeTruthy()
    expect(assetBatchUnavailableReason({ ...asset, assetId: 'external-asset' })).toBeTruthy()
    expect(assetBatchUnavailableReason({ ...asset, deletedAt: '2026-10-15' })).toContain('回收站')
  })
  it('collects one run in node and attempt order while retaining unavailable candidates for visible explanation', () => {
    const missing = candidate(4); missing.asset.localUrl = ''
    const items = runCandidateBatchItems(record([[candidate(3), candidate(1)], [candidate(1), candidate(2, 'video'), missing, candidate(5, 'audio')]]))
    expect(items.map((entry) => entry.assetId)).toEqual([3, 1, 2, 4, 5].map(id))
    expect(items[1].nodeId).toBe('node-0'); expect(items[3].unavailableReason).toBeTruthy()
    expect(runCandidateBatchItems(undefined)).toEqual([])
  })
})

describe('single-flight batch callback feedback', () => {
  it('submits a copied fixed list once and does not dispatch a second action while busy', async () => {
    const controller = createAssetBatchActionController(), wait = delayed(), action = vi.fn(() => wait.promise), update = vi.fn()
    controller.scope('owner:project')
    const ids = [id(1), id(2)], pending = controller.run('add', ids, action, update)
    ids.reverse()
    await controller.run('download', ids, action, update)
    expect(action).toHaveBeenCalledExactlyOnceWith([id(1), id(2)])
    wait.resolve(); await pending
    expect(update).toHaveBeenLastCalledWith({ busy: null, error: '', notice: '已将 2 项素材加入画布，可一次撤销' })
  })
  it.each(['resolve', 'reject'] as const)('suppresses late %s from a previous scope while the next scope has its own action', async (outcome) => {
    const controller = createAssetBatchActionController(), first = delayed(), second = delayed(), old = vi.fn(), next = vi.fn()
    controller.scope('owner1:project1'); const a = controller.run('add', [id(1)], () => first.promise, old)
    controller.scope('owner2:project2'); const b = controller.run('download', [id(2)], () => second.promise, next)
    if (outcome === 'resolve') first.resolve(); else first.reject(new Error('旧账号错误'))
    await a; expect(old).toHaveBeenCalledTimes(1); expect(next).toHaveBeenCalledTimes(1)
    second.resolve(); await b; expect(next).toHaveBeenLastCalledWith({ busy: null, error: '', notice: '下载准备已结束，请查看打包结果' })
  })
  it('preserves per-item host failure and never retries automatically', async () => {
    const controller = createAssetBatchActionController(), action = vi.fn().mockRejectedValue(new Error('素材A：文件缺失\n素材B：权限已变化')), values: AssetBatchActionState[] = []
    await controller.run('download', [id(1), id(2)], action, (value) => values.push(value))
    expect(action).toHaveBeenCalledTimes(1); expect(values.at(-1)?.error).toBe('素材A：文件缺失\n素材B：权限已变化')
    expect(values.at(-1)?.notice).toBe('')
  })
  it('suppresses unmounted replies and allows a fresh mount to work', async () => {
    const controller = createAssetBatchActionController(), wait = delayed(), update = vi.fn()
    const pending = controller.run('add', [id(1)], () => wait.promise, update)
    controller.dispose(); wait.resolve(); await pending; expect(update).toHaveBeenCalledTimes(1)
    controller.activate(); await controller.run('add', [id(2)], async () => {}, update); expect(update).toHaveBeenCalledTimes(3)
  })
})
