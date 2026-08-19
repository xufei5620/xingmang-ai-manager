import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { projectCanvasInspectorNodes } from './canvas-inspector-model'

function node(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'image-edit', type: 'image-edit', definitionVersion: 1, position: { x: 0, y: 0 }, selected: true,
    data: { prompt: 'edit', model: 'gpt-image-2', imageResolution: '4K', status: 'succeeded' },
    ...overrides,
  }
}

describe('projectCanvasInspectorNodes', () => {
  it('projects port cardinality and connection counts in one view model', () => {
    const edges: Edge[] = [
      { id: 'text', source: 'prompt', sourceHandle: 'out:text', target: 'image-edit', targetHandle: 'in:text' },
      { id: 'image-a', source: 'a', sourceHandle: 'out:image', target: 'image-edit', targetHandle: 'in:images' },
      { id: 'image-b', source: 'b', sourceHandle: 'out:image', target: 'image-edit', targetHandle: 'in:images' },
    ]
    const projected = projectCanvasInspectorNodes([node()], edges)[0]

    expect(projected.imageResolution).toBe('4K')
    expect(projected.ports.find((port) => port.id === 'in:text')).toMatchObject({ cardinality: 'many', connectionCount: 1 })
    expect(projected.ports.find((port) => port.id === 'in:images')).toMatchObject({ cardinality: 'many', connectionCount: 2 })
    expect(projected.ports.find((port) => port.id === 'out:image')).toMatchObject({ direction: 'output', connectionCount: 0 })
  })

  it('uses the preview-only selected candidate before adopted and result assets', () => {
    const selectedAsset = { kind: 'image' as const, assetId: 's'.repeat(43) }
    const projected = projectCanvasInspectorNodes([node({
      draggable: false,
      disabled: true,
      data: {
        prompt: 'edit', model: 'gpt-image-2', status: 'failed', dirty: true,
        selectedCandidateId: 'selected', adoptedCandidateId: 'adopted',
        result: { kind: 'image', assetId: 'r'.repeat(43) },
        candidates: [
          { candidateId: 'adopted', attemptId: 'a', createdAt: '2026-08-17T00:00:00Z', asset: { kind: 'image', assetId: 'a'.repeat(43) } },
          { candidateId: 'selected', attemptId: 'b', createdAt: '2026-08-17T00:00:01Z', asset: selectedAsset },
        ],
        attemptCount: 2, latestAttemptDurationMs: 1_500, costQuota: 12, errorMessage: '请求失败',
      },
    })], [])[0]

    expect(projected).toMatchObject({ previewAsset: selectedAsset, candidateCount: 2, attemptCount: 2, locked: true, disabled: true, dirty: true })
    expect(projected.latestAttemptDurationMs).toBe(1_500)
    expect(projected.costQuota).toBe(12)
  })

  it('returns only selected nodes', () => {
    expect(projectCanvasInspectorNodes([node({ selected: false })], [])).toEqual([])
  })
})
