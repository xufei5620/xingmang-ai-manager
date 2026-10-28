import { describe, expect, it } from 'vitest'
import type { CanvasRunRecord } from '../host'
import { completeImageBatchAttempts, latestImageBatchCandidates, parseImageCandidateBatch } from './image-candidate-batch'
import { matchingCanvasRunNodeIds } from './run-input-matching'

function node(): CanvasRunRecord['nodes'][number] {
  const at = '2026-10-14T00:00:00.000Z'
  return { nodeId: 'image', kind: 'image-generate', state: 'succeeded', attempts: [1, 2].map((index) => ({
    attemptId: `attempt-${index}`, imageBatch: { batchId: 'batch', index: index as 1 | 2, count: 2 }, fingerprint: 'hash', state: 'succeeded', startedAt: at, completedAt: at, durationMs: 10, cached: false, group: 'provider', model: 'image-model', inputAssetIds: ['s'.repeat(43)],
    candidates: [{ candidateId: `candidate-${index}`, attemptId: `attempt-${index}`, createdAt: at, asset: { kind: 'image', assetId: String(index).repeat(43), localUrl: `xingmang-asset://image/${String(index).repeat(43)}` } }],
  })) }
}

describe('durable image candidate batch grouping', () => {
  it('strictly validates one-based count and slot metadata', () => {
    expect(parseImageCandidateBatch(undefined)).toBeUndefined()
    expect(parseImageCandidateBatch({ batchId: 'batch', index: 4, count: 4 })).toEqual({ batchId: 'batch', index: 4, count: 4 })
    for (const value of [null, [], {}, { batchId: 'batch', index: 0, count: 2 }, { batchId: 'batch', index: 3, count: 2 }, { batchId: 'batch', index: 1, count: 5 }, { batchId: 'batch', index: 1.5, count: 2 }, { batchId: 'batch', index: '1', count: 2 }, { batchId: '../bad', index: 1, count: 2 }, { batchId: 'batch', index: 1, count: 2, extra: true }]) expect(() => parseImageCandidateBatch(value)).toThrow()
  })

  it('accepts only complete ordered homogeneous batches and preserves real attempt identities', () => {
    const original = node()
    expect(completeImageBatchAttempts(original, 'hash', 2)).toEqual(original.attempts)
    for (const mutation of ['missing', 'index', 'batch', 'count', 'provider', 'model', 'fingerprint', 'inputs', 'failed', 'empty', 'candidate-owner', 'duplicate-id', 'duplicate-candidate']) {
      const changed = node()
      const last = changed.attempts[1]
      if (mutation === 'missing') changed.attempts.pop()
      else if (mutation === 'index') last.imageBatch!.index = 1
      else if (mutation === 'batch') last.imageBatch!.batchId = 'different'
      else if (mutation === 'count') last.imageBatch!.count = 3
      else if (mutation === 'provider') last.group = 'other'
      else if (mutation === 'model') last.model = 'other'
      else if (mutation === 'fingerprint') last.fingerprint = 'other'
      else if (mutation === 'inputs') last.inputAssetIds = []
      else if (mutation === 'failed') last.state = 'failed'
      else if (mutation === 'empty') last.candidates = []
      else if (mutation === 'candidate-owner') last.candidates[0].attemptId = 'another'
      else if (mutation === 'duplicate-id') last.attemptId = changed.attempts[0].attemptId
      else if (mutation === 'duplicate-candidate') last.candidates[0].candidateId = changed.attempts[0].candidates[0].candidateId
      expect(completeImageBatchAttempts(changed, 'hash', 2), mutation).toBeNull()
    }
  })

  it('aggregates partial candidates without mixing another batch or inventing receipts', () => {
    const current = node()
    current.attempts[1].state = 'failed'
    current.attempts[1].candidates = []
    expect(latestImageBatchCandidates(current.attempts)).toEqual(current.attempts[0].candidates)
    current.attempts[1].imageBatch!.batchId = 'new-batch'
    expect(latestImageBatchCandidates(current.attempts)).toEqual([])
  })

  it('rejects late adoption when the desired count changes but treats omitted and explicit one alike', () => {
    const graph = { nodes: [{ id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'hello', model: 'image-model' } }], edges: [] }
    expect(matchingCanvasRunNodeIds(graph, { ...graph, nodes: [{ ...graph.nodes[0], data: { ...graph.nodes[0].data, imageCandidateCount: 1 } }] }).has('image')).toBe(true)
    expect(matchingCanvasRunNodeIds(graph, { ...graph, nodes: [{ ...graph.nodes[0], data: { ...graph.nodes[0].data, imageCandidateCount: 2 } }] }).has('image')).toBe(false)
  })
})
