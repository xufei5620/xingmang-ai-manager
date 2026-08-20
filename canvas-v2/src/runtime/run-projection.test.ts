import { describe, expect, it } from 'vitest'
import type { CanvasRunCandidate, CanvasRunRecord } from '../host'
import type { WorkflowNodeData } from '../model'
import {
  autoFixedDownstreamNodeIds,
  downstreamNodeIds,
  fixNodeCandidate,
  markNodeAndDescendantsDirty,
  nodeResultStagingState,
  projectRunRecordToNodes,
  selectNodeCandidate,
} from './run-projection'

function data(): WorkflowNodeData {
  return { prompt: '', model: 'image-model', status: 'idle' }
}

function candidate(suffix: string, attemptId: string): CanvasRunCandidate {
  return {
    candidateId: `candidate-${suffix}`,
    attemptId,
    createdAt: '2026-08-13T01:00:02Z',
    asset: { kind: 'image', assetId: `asset-${suffix}`, localUrl: `xingmang-asset://image/asset-${suffix}` },
  }
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
        candidates: [candidate('1', 'attempt-1'), candidate('2', 'attempt-1')],
      }],
    }],
    events: [],
  }
}

/** A second, later attempt on the same node -- a retry or a repeated run. */
function withSecondAttempt(record: CanvasRunRecord): CanvasRunRecord {
  record.nodes[0].attempts.push({
    attemptId: 'attempt-2',
    fingerprint: 'fingerprint-2',
    state: 'succeeded',
    startedAt: '2026-08-13T02:00:00Z',
    completedAt: '2026-08-13T02:00:03Z',
    durationMs: 3_000,
    cached: false,
    costQuota: 12,
    candidates: [candidate('3', 'attempt-2'), candidate('4', 'attempt-2')],
  })
  return record
}

// 2026-08-20 产品决策（老板拍板）：最新候选自动成为节点产物，「先候选、后采纳」
// 那一档取消。原先这里的断言钉的是被推翻的那条决策。
describe('run record projection', () => {
  it('fixes the newest candidate as the node result without asking for confirmation', () => {
    const projected = projectRunRecordToNodes([{ id: 'generate', data: data() }], runRecord())
    expect(projected[0].data).toMatchObject({
      status: 'succeeded', dirty: false, attemptCount: 1, latestAttemptDurationMs: 2_000,
      candidateAssetIds: ['asset-1', 'asset-2'], selectedCandidateId: 'candidate-1',
      adoptedCandidateId: 'candidate-1',
      costQuota: 12,
    })
    expect(projected[0].data.result?.assetId).toBe('asset-1')
    expect(nodeResultStagingState(projected[0].data)).toBe('accepted')
  })

  it('keeps every attempt and candidate so an overwritten result stays retrievable', () => {
    const projected = projectRunRecordToNodes([{ id: 'generate', data: data() }], withSecondAttempt(runRecord()))
    // The newest attempt owns the result, but nothing from the earlier one is
    // dropped: automatic overwriting is only acceptable while the history can
    // still be walked back to.
    expect(projected[0].data.result?.assetId).toBe('asset-3')
    expect(projected[0].data.adoptedCandidateId).toBe('candidate-3')
    expect(projected[0].data.candidates?.map((entry) => entry.candidateId))
      .toEqual(['candidate-1', 'candidate-2', 'candidate-3', 'candidate-4'])
    expect(projected[0].data.attemptCount).toBe(2)
  })

  it('does not undo a manual switch within the newest attempt when the record is reprojected', () => {
    const record = withSecondAttempt(runRecord())
    const projected = projectRunRecordToNodes([{ id: 'generate', data: data() }], record)
    const switched = selectNodeCandidate(projected, [], 'generate', 'candidate-4')
    expect(switched[0].data.result?.assetId).toBe('asset-4')
    // The same record is projected again on every terminal event and on a manual
    // history refresh; that must not drag the result back to candidate-3.
    const reprojected = projectRunRecordToNodes(switched, record)
    expect(reprojected[0].data.result?.assetId).toBe('asset-4')
    expect(reprojected[0].data.adoptedCandidateId).toBe('candidate-4')
  })

  it('replaces an older result with the new run output and keeps the old asset in history', () => {
    const projected = projectRunRecordToNodes([{
      id: 'generate',
      data: {
        ...data(),
        result: { kind: 'image', assetId: 'accepted-old' },
        adoptedCandidateId: 'candidate-old',
      },
    }], runRecord())
    expect(projected[0].data.result?.assetId).toBe('asset-1')
    expect(projected[0].data.adoptedCandidateId).toBe('candidate-1')
    expect(projected[0].data.selectedCandidateId).toBe('candidate-1')
    expect(nodeResultStagingState(projected[0].data)).toBe('accepted')
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

  it('switches the result on selection and dirties descendants only', () => {
    const projected = projectRunRecordToNodes([
      { id: 'generate', data: data() },
      { id: 'output', data: data() },
      { id: 'independent', data: data() },
    ], runRecord())
    const switched = selectNodeCandidate(projected, [{ source: 'generate', target: 'output' }], 'generate', 'candidate-2')
    expect(switched[0].data.result?.assetId).toBe('asset-2')
    expect(switched[0].data.selectedCandidateId).toBe('candidate-2')
    expect(switched[0].data.dirty).toBe(false)
    // Marked for a rerun, never started: a switch must not spend money.
    expect(switched[1].data.dirty).toBe(true)
    expect(switched[2].data.dirty).toBeUndefined()
  })

  it('is idempotent when the same candidate is used twice', () => {
    const projected = projectRunRecordToNodes([{ id: 'generate', data: data() }, { id: 'output', data: data() }], runRecord())
    const edges = [{ source: 'generate', target: 'output' }]
    const settled = fixNodeCandidate(projected, edges, 'generate', 'candidate-1').map((node) => (
      node.id === 'output' ? { ...node, data: { ...node.data, dirty: false } } : node
    ))
    const repeated = fixNodeCandidate(settled, edges, 'generate', 'candidate-1')
    expect(repeated[1].data.dirty).toBe(false)
    expect(repeated[0].data.result?.assetId).toBe('asset-1')
    expect(repeated[0].data.candidates).toHaveLength(2)
  })

  it('marks out-of-scope downstream nodes dirty for the newly fixed result', () => {
    const edges = [{ source: 'generate', target: 'upscale' }, { source: 'upscale', target: 'output' }]
    const nodes = [
      { id: 'generate', data: { ...data(), status: 'succeeded' as const, result: { kind: 'image' as const, assetId: 'asset-old' } } },
      { id: 'upscale', data: { ...data(), status: 'succeeded' as const, result: { kind: 'image' as const, assetId: 'asset-upscaled' } } },
      { id: 'output', data: data() },
    ]
    // Only `generate` ran, so the chain behind it is now holding stale input.
    expect(autoFixedDownstreamNodeIds(nodes, runRecord(), edges)).toEqual(['upscale', 'output'])
    const projected = projectRunRecordToNodes(nodes, runRecord(), edges)
    expect(projected[0].data.dirty).toBe(false)
    expect(projected[1].data.dirty).toBe(true)
    expect(projected[2].data.dirty).toBe(true)
    expect(projected[1].data.result?.assetId).toBe('asset-upscaled')
  })

  it('leaves nodes that ran with the new result alone', () => {
    const record = runRecord()
    record.nodes.push({
      nodeId: 'output', kind: 'output', state: 'succeeded', attempts: [],
    })
    const edges = [{ source: 'generate', target: 'output' }]
    const nodes = [{ id: 'generate', data: data() }, { id: 'output', data: data() }]
    // `output` executed inside the same run, so it consumed the fresh asset and
    // must not be dragged back to "needs a rerun".
    expect(autoFixedDownstreamNodeIds(nodes, record, edges)).toEqual([])
    expect(projectRunRecordToNodes(nodes, record, edges)[1].data.dirty).toBe(false)
  })

  it('marks edited node and transitive descendants dirty without clearing old output', () => {
    const nodes = [
      { id: 'a', data: { ...data(), result: { kind: 'image' as const, assetId: 'old' } } },
      { id: 'b', data: data() },
      { id: 'c', data: data() },
    ]
    const edges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }]
    expect(downstreamNodeIds(['a'], edges)).toEqual(['b', 'c'])
    const dirty = markNodeAndDescendantsDirty(nodes, edges, 'a', { prompt: 'changed' })
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

  it('can put a candidate from an older run back in as the result', () => {
    const historical = runRecord().nodes[0].attempts[0].candidates[1]
    const current = [{ id: 'generate', data: data() }, { id: 'output', data: data() }]
    const restored = selectNodeCandidate(current, [{ source: 'generate', target: 'output' }], 'generate', historical)
    expect(restored[0].data.candidates?.[0].candidateId).toBe('candidate-2')
    expect(restored[0].data.result?.assetId).toBe('asset-2')
    expect(restored[1].data.dirty).toBe(true)
  })
})
