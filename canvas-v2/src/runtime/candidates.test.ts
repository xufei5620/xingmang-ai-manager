import { describe, expect, it } from 'vitest'
import {
  adoptCandidate,
  beginAttempt,
  cancelAttempt,
  completeAttempt,
  createCandidateState,
  failAttempt,
  markNodesDirty,
  resolveRunScope,
  startAttempt,
} from './candidates'

describe('candidate runtime state', () => {
  it('keeps sibling candidates until explicit adoption', () => {
    const initial = createCandidateState(['source', 'generate', 'output'])
    const queued = beginAttempt(initial, {
      id: 'attempt-1',
      runId: 'run-1',
      nodeId: 'generate',
      requestSnapshot: { prompt: 'original' },
    })
    const running = startAttempt(queued, 'attempt-1', '2026-08-13T01:00:00Z')
    const completed = completeAttempt(running, 'attempt-1', [
      { id: 'candidate-1', assetId: 'asset-1', createdAt: '2026-08-13T01:01:00Z' },
      { id: 'candidate-2', assetId: 'asset-2', createdAt: '2026-08-13T01:01:01Z' },
    ], '2026-08-13T01:01:02Z', { quota: 12 })

    expect(completed.attempts['attempt-1'].candidateIds).toEqual(['candidate-1', 'candidate-2'])
    expect(completed.nodes.generate.selectedCandidateId).toBeUndefined()
    expect(completed.nodes.generate.dirty).toBe(false)

    const adopted = adoptCandidate(completed, 'candidate-2', [
      { source: 'source', target: 'generate' },
      { source: 'generate', target: 'output' },
    ])
    expect(adopted.nodes.generate.selectedCandidateId).toBe('candidate-2')
    expect(adopted.nodes.output.dirty).toBe(true)
    expect(Object.keys(adopted.candidates)).toEqual(['candidate-1', 'candidate-2'])
  })

  it('numbers retries and never mutates a terminal attempt', () => {
    const first = beginAttempt(createCandidateState(['generate']), {
      id: 'attempt-1', runId: 'run-1', nodeId: 'generate', requestSnapshot: {},
    })
    const failed = failAttempt(first, 'attempt-1', {
      message: ' provider detail ', retryable: true,
    }, '2026-08-13T01:01:00Z')
    const retry = beginAttempt(failed, {
      id: 'attempt-2', runId: 'run-2', nodeId: 'generate', requestSnapshot: {},
    })
    expect(failed.attempts['attempt-1'].error?.message).toBe('provider detail')
    expect(retry.attempts['attempt-2'].ordinal).toBe(2)
    expect(() => startAttempt(failed, 'attempt-1', 'later')).toThrow(/已结束/)
  })

  it('makes cancellation idempotent without deleting a previous adoption', () => {
    let state = beginAttempt(createCandidateState(['generate']), {
      id: 'attempt-1', runId: 'run-1', nodeId: 'generate', requestSnapshot: {},
    })
    state = cancelAttempt(state, 'attempt-1', '2026-08-13T01:00:00Z')
    expect(cancelAttempt(state, 'attempt-1', 'later')).toBe(state)
    expect(state.nodes.generate).toMatchObject({ status: 'idle', dirty: true })
  })

  it('marks descendants dirty without automatically running them', () => {
    const state = createCandidateState(['a', 'b', 'c', 'independent'])
    const dirty = markNodesDirty(state, ['a'], [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ])
    expect(dirty.nodes.a.dirty).toBe(true)
    expect(dirty.nodes.b.dirty).toBe(true)
    expect(dirty.nodes.c.dirty).toBe(true)
    expect(dirty.nodes.independent.dirty).toBe(true)
    expect(dirty.nodes.b.status).toBe('idle')
  })

  it('resolves all, dirty, selected, upstream-to-target and downstream scopes', () => {
    const state = createCandidateState(['a', 'b', 'c', 'd', 'dependency', 'merged', 'other'])
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'merged' },
      { source: 'dependency', target: 'merged' },
    ]
    const allNodeIds = ['a', 'b', 'c', 'd', 'dependency', 'merged', 'other']
    expect(resolveRunScope(state, allNodeIds, edges, { kind: 'all' })).toEqual(allNodeIds)
    expect(resolveRunScope(state, allNodeIds, edges, { kind: 'dirty' })).toEqual(allNodeIds)
    expect(resolveRunScope(state, allNodeIds, edges, { kind: 'selection', nodeIds: ['b', 'd'] })).toEqual(['a', 'b', 'd'])
    expect(resolveRunScope(state, allNodeIds, edges, { kind: 'to-node', nodeId: 'c' })).toEqual(['a', 'b', 'c'])
    expect(resolveRunScope(state, allNodeIds, edges, { kind: 'from-node', nodeId: 'b' }))
      .toEqual(['a', 'b', 'c', 'dependency', 'merged'])
  })

  it('rejects duplicate candidates and oversized candidate sets', () => {
    const queued = beginAttempt(createCandidateState(['generate']), {
      id: 'attempt-1', runId: 'run-1', nodeId: 'generate', requestSnapshot: {},
    })
    const repeated = [
      { id: 'same', assetId: 'asset-1', createdAt: 'now' },
      { id: 'same', assetId: 'asset-2', createdAt: 'now' },
    ]
    expect(() => completeAttempt(queued, 'attempt-1', repeated, 'now')).toThrow(/候选 ID 重复/)
    expect(() => completeAttempt(queued, 'attempt-1', [], 'now')).toThrow(/候选结果数量/)
  })
})
