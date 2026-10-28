import { describe, expect, it } from 'vitest'
import type { CanvasRunRecord } from '../host'
import type { WorkflowNode } from '../model'
import { projectRunRecordToNodes } from './run-projection'

const at = '2026-10-15T12:00:00.000Z'
type Attempt = CanvasRunRecord['nodes'][number]['attempts'][number]

function attempt(index: 1 | 2 | 3, state: Attempt['state'] = 'succeeded'): Attempt {
  const assetId = String(index).repeat(43)
  return {
    attemptId: `attempt-${index}`, fingerprint: 'same-input', state,
    startedAt: at, completedAt: state === 'running' ? '' : at,
    durationMs: index * 100, cached: state === 'cached',
    videoTaskId: `task-${index}`, videoBatch: { batchId: 'batch', index, count: 3 },
    candidates: state === 'succeeded' || state === 'cached' ? [{
      candidateId: `candidate-${index}`, attemptId: `attempt-${index}`, createdAt: at,
      asset: { kind: 'video', assetId, localUrl: `/api/assets/${assetId}/content`, taskId: `task-${index}` },
    }] : [],
  }
}

function run(attempts: Attempt[], state: CanvasRunRecord['nodes'][number]['state'] = 'running'): CanvasRunRecord {
  return {
    version: 1, runId: 'run', userId: 1, ownerId: 1, graphRevision: 'revision',
    scope: { kind: 'all' }, status: state === 'cached' ? 'succeeded' : state === 'failed' ? 'failed' : state === 'succeeded' ? 'succeeded' : 'running',
    createdAt: at, startedAt: at, events: [], nodes: [{ nodeId: 'video', kind: 'video-generate', state, attempts }],
  }
}

function node(): WorkflowNode {
  return { id: 'video', kind: 'video-generate', position: { x: 0, y: 0 }, data: { prompt: 'a scene', model: 'mock', status: 'idle', videoCandidateCount: 1 } }
}

describe('video batch runtime projection', () => {
  it('uses durable batch totals and original task identities rather than a changed draft count', () => {
    const record = run([attempt(1), attempt(2, 'running')])
    const projected = projectRunRecordToNodes([node()], record)[0]
    expect(projected.data.videoBatchProgress).toEqual({ completed: 1, submitted: 2, total: 3 })
    expect(projected.data.result?.assetId).toBe('1'.repeat(43))
    expect(projected.data.candidateAssetIds).toEqual(['1'.repeat(43)])
    expect(record.nodes[0].attempts[1].videoTaskId).toBe('task-2')
  })

  it('retains a completed candidate and marks a failed partial batch dirty', () => {
    const projected = projectRunRecordToNodes([node()], run([attempt(1), attempt(2, 'failed')], 'failed'))[0]
    expect(projected.data.status).toBe('failed')
    expect(projected.data.dirty).toBe(true)
    expect(projected.data.result?.assetId).toBe('1'.repeat(43))
    expect(projected.data.videoBatchProgress).toEqual({ completed: 1, submitted: 2, total: 3 })
    expect(projected.data.latestAttemptDurationMs).toBe(300)
  })

  it('does not replace a selected candidate when a terminal batch is projected again', () => {
    const original = node()
    original.data.result = attempt(2).candidates[0].asset
    original.data.adoptedCandidateId = 'candidate-2'
    const projected = projectRunRecordToNodes([original], run([attempt(1), attempt(2), attempt(3)], 'succeeded'))[0]
    expect(projected.data.result?.assetId).toBe('2'.repeat(43))
    expect(projected.data.videoBatchProgress).toEqual({ completed: 3, submitted: 3, total: 3 })
    expect(projected.data.latestAttemptDurationMs).toBe(600)
  })

  it('preserves the saved asset and paid duration on complete cache replay after reopening', () => {
    const original = node()
    original.data.result = attempt(2).candidates[0].asset
    original.data.latestAttemptDurationMs = 600
    const projected = projectRunRecordToNodes([original], run([attempt(1, 'cached'), attempt(2, 'cached'), attempt(3, 'cached')], 'cached'))[0]
    expect(projected.data.result?.assetId).toBe('2'.repeat(43))
    expect(projected.data.adoptedCandidateId).toBe('candidate-2')
    expect(projected.data.latestAttemptDurationMs).toBe(600)
    expect(projected.data.fromCache).toBe(true)
  })

  it('clears stale progress without adopting late results for edited inputs', () => {
    const original = node()
    original.data.result = attempt(3).candidates[0].asset
    original.data.videoBatchProgress = { completed: 1, submitted: 2, total: 3 }
    const projected = projectRunRecordToNodes([original], run([attempt(1), attempt(2)], 'failed'), [], new Set())[0]
    expect(projected.data.result).toEqual(original.data.result)
    expect(projected.data.videoBatchProgress).toBeUndefined()
    expect(projected.data.dirty).toBe(true)
    expect(projected.data.candidateAssetIds).toEqual(['1'.repeat(43), '2'.repeat(43)])
  })
})
