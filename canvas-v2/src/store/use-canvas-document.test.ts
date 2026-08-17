import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { canvasNodeDocumentRecord } from './use-canvas-document'

describe('canvas document runtime boundary', () => {
  it('keeps accepted results but strips staged candidates and run progress', () => {
    const node: CanvasNode = {
      id: 'output',
      type: 'output',
      definitionVersion: 1,
      position: { x: 10, y: 20 },
      data: {
        prompt: '',
        model: '',
        status: 'succeeded',
        result: { kind: 'image', assetId: 'accepted-asset' },
        candidateAssetIds: ['staged-asset'],
        candidates: [{
          candidateId: 'candidate-1',
          attemptId: 'attempt-1',
          createdAt: '2026-08-17T12:00:00Z',
          asset: { kind: 'image', assetId: 'staged-asset' },
        }],
        selectedCandidateId: 'candidate-1',
        adoptedCandidateId: 'candidate-old',
        runStage: 'saving',
        dirty: false,
      },
    }

    const persisted = canvasNodeDocumentRecord(node)
    expect(persisted.data.result).toEqual({ kind: 'image', assetId: 'accepted-asset' })
    expect(persisted.data).not.toHaveProperty('candidateAssetIds')
    expect(persisted.data).not.toHaveProperty('candidates')
    expect(persisted.data).not.toHaveProperty('selectedCandidateId')
    expect(persisted.data).not.toHaveProperty('adoptedCandidateId')
    expect(persisted.data).not.toHaveProperty('runStage')
    expect(persisted.data).not.toHaveProperty('dirty')
  })
})
