import { describe, expect, it } from 'vitest'
import type { CanvasRunRecord } from '../host'
import { completeVideoBatchAttempts, latestVideoBatchCandidates, parseVideoCandidateBatch } from './video-candidate-batch'
import { inspectPendingVideoBatch } from '../lib/canvas-video-batch'

type RunNode = CanvasRunRecord['nodes'][number]
function fixture(): RunNode {
  return { nodeId: 'video', kind: 'video-generate', state: 'succeeded', attempts: [1, 2].map((index) => ({
    attemptId: `attempt-${index}`, fingerprint: 'fingerprint', videoTaskId: `task-${index}`, videoBatch: { batchId: 'batch', index: index as 1 | 2, count: 2 }, state: 'succeeded', cached: false, startedAt: '2026-10-15T00:00:00Z', completedAt: '2026-10-15T00:00:01Z', durationMs: 1000, group: 'provider', model: 'grok-imagine-video', inputAssetIds: ['source'],
    candidates: [{ candidateId: `candidate-${index}`, attemptId: `attempt-${index}`, createdAt: '2026-10-15T00:00:01Z', asset: { kind: 'video', assetId: String(index).repeat(43), localUrl: `xingmang-asset://video/${String(index).repeat(43)}`, taskId: `task-${index}` } }],
  })) }
}
const expected = { fingerprint: 'fingerprint', count: 2, group: 'provider', model: 'grok-imagine-video', sourceAssetIds: ['source'] }

describe('durable video batch shape', () => {
  it('rejects malformed metadata instead of flattening it to a single task', () => {
    expect(parseVideoCandidateBatch(undefined)).toBeUndefined()
    for (const value of [null, [], {}, { batchId: 'batch', index: 0, count: 2 }, { batchId: 'batch', index: 3, count: 2 }, { batchId: 'batch', index: 1, count: 5 }, { batchId: 'batch', index: '1', count: 2 }, { batchId: '../bad', index: 1, count: 2 }, { batchId: 'batch', index: 1, count: 2, extra: true }]) expect(() => parseVideoCandidateBatch(value)).toThrow()
  })
  it('requires every original attempt and saved task for a full batch cache', () => {
    const original = fixture()
    expect(completeVideoBatchAttempts(original, 'fingerprint', 2)).toEqual(original.attempts)
    for (const mutation of ['fingerprint', 'index', 'task', 'assetTask', 'media', 'input', 'provider', 'state', 'missing'] as const) {
      const changed = fixture(), last = changed.attempts[1]
      if (mutation === 'fingerprint') last.fingerprint = 'other'
      if (mutation === 'index') last.videoBatch!.index = 1
      if (mutation === 'task') last.videoTaskId = changed.attempts[0].videoTaskId
      if (mutation === 'assetTask') last.candidates[0].asset.taskId = 'other'
      if (mutation === 'media') last.candidates[0].asset.kind = 'image'
      if (mutation === 'input') last.inputAssetIds = ['other']
      if (mutation === 'provider') last.group = 'other'
      if (mutation === 'state') last.state = 'running'
      if (mutation === 'missing') changed.attempts.pop()
      expect(completeVideoBatchAttempts(changed, 'fingerprint', 2), mutation).toBeNull()
    }
  })
  it('resumes only the last original running task and advances after a saved prefix', () => {
    const node = fixture()
    node.state = 'running'
    node.attempts[1].state = 'running'
    node.attempts[1].candidates = []
    expect(inspectPendingVideoBatch(node, expected)).toEqual({ batchId: 'batch', nextIndex: 2, active: node.attempts[1] })
    expect(latestVideoBatchCandidates(node.attempts)).toEqual(node.attempts[0].candidates)
    node.attempts.pop()
    expect(inspectPendingVideoBatch(node, expected)).toEqual({ batchId: 'batch', nextIndex: 2 })
    node.attempts[0].state = 'interrupted'
    expect(() => inspectPendingVideoBatch(node, expected)).toThrow('不会补交')
    expect(() => inspectPendingVideoBatch({ ...node, attempts: [] }, expected)).toThrow('缺少')
  })
})
