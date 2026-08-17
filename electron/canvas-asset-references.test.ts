import { describe, expect, it } from 'vitest'
import type { CanvasRunRecord } from './canvas-run-contract'
import { findCanvasRunAssetReferences } from './canvas-asset-references'

function runRecord(assetId: string): CanvasRunRecord {
  return {
    version: 1,
    userId: 36,
    ownerId: 7,
    projectId: '11111111-1111-4111-8111-111111111111',
    runId: 'run-1',
    graphRevision: 'revision',
    scope: { kind: 'all' },
    status: 'succeeded',
    createdAt: '2026-08-17T00:00:00.000Z',
    startedAt: '2026-08-17T00:00:00.000Z',
    nodes: [{
      nodeId: 'image-edit',
      kind: 'image-edit',
      state: 'succeeded',
      attempts: [{
        attemptId: 'attempt-1',
        fingerprint: 'fingerprint',
        state: 'succeeded',
        startedAt: '2026-08-17T00:00:00.000Z',
        completedAt: '2026-08-17T00:00:01.000Z',
        durationMs: 1_000,
        cached: false,
        inputAssetIds: [assetId, assetId],
        candidates: [{
          candidateId: 'candidate-1',
          attemptId: 'attempt-1',
          createdAt: '2026-08-17T00:00:01.000Z',
          asset: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}` },
        }],
      }],
    }],
    events: [],
  }
}

describe('findCanvasRunAssetReferences', () => {
  it('summarizes exact input and candidate references without exposing run payloads', () => {
    const assetId = 'A'.repeat(43)
    expect(findCanvasRunAssetReferences([runRecord(assetId)], assetId)).toEqual([{
      runId: 'run-1',
      projectId: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-08-17T00:00:00.000Z',
      status: 'succeeded',
      nodeIds: ['image-edit'],
      inputReferenceCount: 2,
      candidateReferenceCount: 1,
    }])
  })

  it('does not match substrings and rejects malformed asset identifiers', () => {
    const assetId = 'B'.repeat(43)
    const record = runRecord(`prefix-${assetId}`)
    expect(findCanvasRunAssetReferences([record], assetId)).toEqual([])
    expect(() => findCanvasRunAssetReferences([], '../asset')).toThrow('格式错误')
  })
})
