import { describe, expect, it } from 'vitest'
import { assertAnnotationTarget, replaceAnnotatedImage } from './annotation-workflow'
import type { CanvasImageAssetSummary } from '../host'
import type { WorkflowNodeData } from '../model'

const id = 'a'.repeat(43), next = 'b'.repeat(43), other = 'c'.repeat(43)
function asset(): CanvasImageAssetSummary { return { assetId: next, mediaType: 'image', localUrl: `xingmang-asset://image/${next}`, mimeType: 'image/png', width: 640, height: 480, thumbnailUrl: '', createdAt: '', fileName: 'annotation.png' } }
function fixture(dirty = false) {
  return [{ id: 'source', data: { prompt: 'unchanged', model: 'model', status: 'succeeded', dirty, result: { kind: 'image', assetId: id, localUrl: `xingmang-asset://image/${id}` }, candidateAssetIds: [other, id], candidates: [{ candidateId: 'paid', attemptId: 'paid', createdAt: '', asset: { kind: 'image', assetId: id } }] } as WorkflowNodeData },
    { id: 'child', data: { prompt: '', model: '', status: 'succeeded' } as WorkflowNodeData }, { id: 'unrelated', data: { prompt: '', model: '', status: 'idle' } as WorkflowNodeData }]
}
describe('annotation result adoption', () => {
  it('replaces the current batch slot and dirties only descendants without mutating inputs', () => {
    const before = fixture(), after = replaceAnnotatedImage(before, [{ source: 'source', target: 'child' }], 'source', id, asset())
    expect(after[0].data.result?.assetId).toBe(next)
    expect(after[0].data.candidateAssetIds).toEqual([other, next])
    expect(after[0].data.candidates).toEqual([{ candidateId: `document:source:annotation:${next}`, attemptId: 'document:source', createdAt: '', asset: after[0].data.result }])
    expect(after[0].data.dirty).toBe(false)
    expect(after[1].data.dirty).toBe(true)
    expect(after[2]).toBe(before[2])
    expect(before[0].data.result?.assetId).toBe(id)
    expect(before[0].data.candidates?.[0].attemptId).toBe('paid')
  })
  it('retains pending input edits and rejects stale or locked sources', () => {
    expect(replaceAnnotatedImage(fixture(true), [], 'source', id, asset())[0].data.dirty).toBe(true)
    expect(() => assertAnnotationTarget(fixture(), 'missing')).toThrow('删除')
    expect(() => assertAnnotationTarget(fixture(), 'source', other)).toThrow('变化')
    expect(() => assertAnnotationTarget([{ ...fixture()[0], draggable: false }], 'source')).toThrow('锁定')
    expect(() => replaceAnnotatedImage(fixture(), [], 'source', id, { ...asset(), deletedAt: 'now' })).toThrow('完整保存')
  })
  it('retains untouched mixed-media candidates without attributing the new PNG to a paid attempt', () => {
    const before = fixture()
    const video = { candidateId: 'video-paid', attemptId: 'video-attempt', createdAt: 'yesterday', asset: { kind: 'video' as const, assetId: other, durationSeconds: 5 } }
    before[0].data.candidates!.unshift(video)
    Object.assign(before[0].data.candidates![1], { model: 'paid-model', group: 'paid-group', costQuota: 20, outputIndex: 1 })
    const after = replaceAnnotatedImage(before, [], 'source', id, asset())
    expect(after[0].data.candidates![0]).toBe(video)
    expect(after[0].data.candidates![1]).toMatchObject({ candidateId: `document:source:annotation:${next}`, attemptId: 'document:source', outputIndex: 1 })
    expect(after[0].data.candidates![1].costQuota).toBeUndefined()
    expect(after[0].data.candidates![1].model).toBeUndefined()
    expect(after[0].data.candidates![1].group).toBeUndefined()
    expect(before[0].data.candidates![1].attemptId).toBe('paid')
  })
  it('adds a local candidate when a persisted batch has no runtime candidates', () => {
    const before = fixture()
    before[0].data.candidates = undefined
    const after = replaceAnnotatedImage(before, [], 'source', id, asset())
    expect(after[0].data.candidateAssetIds).toEqual([other, next])
    expect(after[0].data.candidates?.map((candidate) => candidate.asset.assetId)).toEqual([next])
  })
})
