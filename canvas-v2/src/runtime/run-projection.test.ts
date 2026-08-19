import { describe, expect, it } from 'vitest'
import type { CanvasRunRecord } from '../host'
import type { WorkflowNodeData } from '../model'
import {
  adoptNodeCandidate,
  discardNodeCandidate,
  markNodeAndDescendantsDirty,
  nodeResultStagingState,
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
  it('stages terminal candidates without silently accepting the first result', () => {
    const projected = projectRunRecordToNodes([{ id: 'generate', data: data() }], runRecord())
    expect(projected[0].data).toMatchObject({
      status: 'succeeded', dirty: false, attemptCount: 1, latestAttemptDurationMs: 2_000,
      candidateAssetIds: ['asset-1', 'asset-2'], selectedCandidateId: 'candidate-1',
      costQuota: 12,
    })
    expect(projected[0].data.result).toBeUndefined()
    expect(projected[0].data.adoptedCandidateId).toBeUndefined()
    expect(nodeResultStagingState(projected[0].data)).toBe('pending')
  })

  it('keeps a cache hit distinguishable from a fresh paid run after reload', () => {
    const fresh = projectRunRecordToNodes([{ id: 'generate', data: data() }], runRecord())
    expect(fresh[0].data.fromCache).toBe(false)

    const record = runRecord()
    record.nodes[0].state = 'cached'
    const cached = projectRunRecordToNodes([{ id: 'generate', data: data() }], record)
    // A cache hit is still a success for run semantics, but the user must be
    // able to tell nothing was regenerated or paid for.
    expect(cached[0].data.status).toBe('succeeded')
    expect(cached[0].data.dirty).toBe(false)
    expect(cached[0].data.fromCache).toBe(true)
  })

  it('selects without changing output, then adopts and dirties descendants only', () => {
    const projected = projectRunRecordToNodes([
      { id: 'generate', data: data() },
      { id: 'output', data: data() },
      { id: 'independent', data: data() },
    ], runRecord())
    const selected = selectNodeCandidate(projected, 'generate', 'candidate-2')
    expect(selected[0].data.result).toBeUndefined()
    expect(selected[0].data.selectedCandidateId).toBe('candidate-2')

    const adopted = adoptNodeCandidate(selected, [{ source: 'generate', target: 'output' }], 'generate', 'candidate-2')
    expect(adopted[0].data.result?.assetId).toBe('asset-2')
    expect(adopted[0].data.dirty).toBe(false)
    expect(adopted[1].data.dirty).toBe(true)
    expect(adopted[2].data.dirty).toBeUndefined()
    expect(nodeResultStagingState(adopted[0].data)).toBe('pending')
  })

  it('keeps an accepted result while a newer run waits for confirmation', () => {
    const projected = projectRunRecordToNodes([{
      id: 'generate',
      data: {
        ...data(),
        result: { kind: 'image', assetId: 'accepted-old' },
        adoptedCandidateId: 'candidate-old',
      },
    }], runRecord())
    expect(projected[0].data.result?.assetId).toBe('accepted-old')
    expect(projected[0].data.adoptedCandidateId).toBe('candidate-old')
    expect(projected[0].data.selectedCandidateId).toBe('candidate-1')
    expect(nodeResultStagingState(projected[0].data)).toBe('pending')
  })

  it('discards only staged candidates without changing accepted output or descendants', () => {
    const nodes = [{
      id: 'generate',
      data: {
        ...data(),
        result: { kind: 'image' as const, assetId: 'accepted' },
        adoptedCandidateId: 'accepted-candidate',
        selectedCandidateId: 'staged-candidate',
        candidates: [
          { candidateId: 'accepted-candidate', attemptId: 'attempt-0', createdAt: '2026-08-13T00:00:00Z', asset: { kind: 'image' as const, assetId: 'accepted' } },
          { candidateId: 'staged-candidate', attemptId: 'attempt-1', createdAt: '2026-08-13T01:00:00Z', asset: { kind: 'image' as const, assetId: 'staged' } },
        ],
        candidateAssetIds: ['accepted', 'staged'],
      },
    }, { id: 'output', data: data() }]
    const discarded = discardNodeCandidate(nodes, 'generate', 'staged-candidate')
    expect(discarded[0].data.result?.assetId).toBe('accepted')
    expect(discarded[0].data.adoptedCandidateId).toBe('accepted-candidate')
    expect(discarded[0].data.selectedCandidateId).toBe('accepted-candidate')
    expect(discarded[0].data.candidateAssetIds).toEqual(['accepted'])
    expect(discarded[1]).toBe(nodes[1])
    expect(nodeResultStagingState(discarded[0].data)).toBe('accepted')
  })

  it('does not discard an accepted candidate or dirty descendants on repeated accept', () => {
    const projected = projectRunRecordToNodes([{ id: 'generate', data: data() }, { id: 'output', data: data() }], runRecord())
    const adopted = adoptNodeCandidate(projected, [{ source: 'generate', target: 'output' }], 'generate', 'candidate-1')
    const repeated = adoptNodeCandidate(adopted.map((node) => (
      node.id === 'output' ? { ...node, data: { ...node.data, dirty: false } } : node
    )), [{ source: 'generate', target: 'output' }], 'generate', 'candidate-1')
    const discarded = discardNodeCandidate(repeated, 'generate', 'candidate-1')
    expect(repeated[1].data.dirty).toBe(false)
    expect(discarded[0].data.candidates).toHaveLength(2)
    expect(discarded[0].data.result?.assetId).toBe('asset-1')
  })

  it('clears candidate indexes when the last staged candidate is discarded', () => {
    const projected = projectRunRecordToNodes([{ id: 'generate', data: data() }], runRecord())
    const firstDiscard = discardNodeCandidate(projected, 'generate', 'candidate-1')
    const secondDiscard = discardNodeCandidate(firstDiscard, 'generate', 'candidate-2')
    expect(secondDiscard[0].data.candidates).toEqual([])
    expect(secondDiscard[0].data.candidateAssetIds).toBeUndefined()
    expect(secondDiscard[0].data.selectedCandidateId).toBeUndefined()
    expect(nodeResultStagingState(secondDiscard[0].data)).toBe('empty')
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

  it('shows live progress while running and clears it for terminal records', () => {
    const running = runRecord()
    running.status = 'running'
    running.completedAt = undefined
    running.nodes[0] = {
      ...running.nodes[0],
      state: 'running',
      latestStage: 'processing',
      latestProgress: 38,
      latestProgressMode: 'determinate',
      latestHealth: 'delayed',
    }
    const live = projectRunRecordToNodes([{ id: 'generate', data: data() }], running)
    expect(live[0].data).toMatchObject({
      runStartedAt: '2026-08-13T01:00:00Z',
      runStage: 'processing', runProgress: 38, runProgressMode: 'determinate', runHealth: 'delayed',
    })

    running.status = 'succeeded'
    running.nodes[0].state = 'succeeded'
    const completed = projectRunRecordToNodes(live, running)
    expect(completed[0].data.runStartedAt).toBeUndefined()
    expect(completed[0].data.runStage).toBeUndefined()
    expect(completed[0].data.runProgress).toBeUndefined()
    expect(completed[0].data.runProgressMode).toBeUndefined()
    expect(completed[0].data.runHealth).toBeUndefined()
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
