import { describe, expect, it } from 'vitest'
import type { CanvasRunRecord } from '../host'
import type { WorkflowNodeData } from '../model'
import {
  adoptNodeCandidate,
  markNodeAndDescendantsDirty,
  projectRunRecordToNodes,
  selectNodeCandidate,
} from './run-projection'

function data(): WorkflowNodeData {
  return { prompt: '', model: 'image-model', status: 'idle' }
}

function runRecord(): CanvasRunRecord {
  return {
    version: 1,
    userId: 7,
    ownerId: 9,
    runId: 'run-1',
    graphRevision: 'revision-1',
    scope: { kind: 'all' },
    status: 'succeeded',
    createdAt: '2026-08-13T01:00:00Z',
    startedAt: '2026-08-13T01:00:00Z',
    completedAt: '2026-08-13T01:00:02Z',
    nodes: [{
      nodeId: 'generate',
      kind: 'image-generate',
      state: 'succeeded',
      attempts: [{
        attemptId: 'attempt-1',
        fingerprint: 'fingerprint',
        state: 'succeeded',
        startedAt: '2026-08-13T01:00:00Z',
        completedAt: '2026-08-13T01:00:02Z',
        durationMs: 2_000,
        cached: false,
        costQuota: 12,
        candidates: [
          {
            candidateId: 'candidate-1', attemptId: 'attempt-1', createdAt: '2026-08-13T01:00:02Z',
            asset: { kind: 'image', assetId: 'asset-1', localUrl: 'xingmang-asset://image/asset-1' },
          },
          {
            candidateId: 'candidate-2', attemptId: 'attempt-1', createdAt: '2026-08-13T01:00:02Z',
            asset: { kind: 'image', assetId: 'asset-2', localUrl: 'xingmang-asset://image/asset-2' },
          },
        ],
      }],
    }],
    events: [],
  }
}

describe('run record projection', () => {
  it('maps terminal attempts and candidates back to node data', () => {
    const projected = projectRunRecordToNodes([{ id: 'generate', data: data() }], runRecord())
    expect(projected[0].data).toMatchObject({
      status: 'succeeded', dirty: false, attemptCount: 1, latestAttemptDurationMs: 2_000,
      candidateAssetIds: ['asset-1', 'asset-2'], selectedCandidateId: 'candidate-1',
      costQuota: 12,
      result: { assetId: 'asset-1' },
    })
    expect(projected[0].data.adoptedCandidateId).toBeUndefined()
  })

  it('selects without changing output, then adopts and dirties descendants only', () => {
    const projected = projectRunRecordToNodes([
      { id: 'generate', data: data() },
      { id: 'output', data: data() },
      { id: 'independent', data: data() },
    ], runRecord())
    const selected = selectNodeCandidate(projected, 'generate', 'candidate-2')
    expect(selected[0].data.result?.assetId).toBe('asset-1')
    expect(selected[0].data.selectedCandidateId).toBe('candidate-2')

    const adopted = adoptNodeCandidate(selected, [{ source: 'generate', target: 'output' }], 'generate', 'candidate-2')
    expect(adopted[0].data.result?.assetId).toBe('asset-2')
    expect(adopted[0].data.dirty).toBe(false)
    expect(adopted[1].data.dirty).toBe(true)
    expect(adopted[2].data.dirty).toBeUndefined()
  })

  it('marks edited node and transitive descendants dirty without clearing old output', () => {
    const nodes = [
      { id: 'a', data: { ...data(), result: { kind: 'image' as const, assetId: 'old' } } },
      { id: 'b', data: data() },
      { id: 'c', data: data() },
    ]
    const dirty = markNodeAndDescendantsDirty(nodes, [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ], 'a', { prompt: 'changed' })
    expect(dirty.map((node) => node.data.dirty)).toEqual([true, true, true])
    expect(dirty[0].data.result?.assetId).toBe('old')
    expect(dirty[0].data.prompt).toBe('changed')
  })

  it('keeps previous output visible for a failed retry', () => {
    const failed = runRecord()
    failed.status = 'failed'
    failed.nodes[0] = { nodeId: 'generate', kind: 'image-generate', state: 'failed', attempts: [], errorMessage: '请求失败' }
    const projected = projectRunRecordToNodes([{
      id: 'generate',
      data: { ...data(), status: 'succeeded', result: { kind: 'image', assetId: 'old' } },
    }], failed)
    expect(projected[0].data).toMatchObject({ status: 'failed', dirty: true, errorMessage: '请求失败' })
    expect(projected[0].data.result?.assetId).toBe('old')
  })

  it('can reselect and adopt a candidate from an older run', () => {
    const historical = runRecord().nodes[0].attempts[0].candidates[1]
    const current = [{ id: 'generate', data: data() }, { id: 'output', data: data() }]
    const selected = selectNodeCandidate(current, 'generate', historical)
    expect(selected[0].data.candidates?.[0].candidateId).toBe('candidate-2')
    const adopted = adoptNodeCandidate(selected, [{ source: 'generate', target: 'output' }], 'generate', historical.candidateId)
    expect(adopted[0].data.result?.assetId).toBe('asset-2')
    expect(adopted[1].data.dirty).toBe(true)
  })
})
