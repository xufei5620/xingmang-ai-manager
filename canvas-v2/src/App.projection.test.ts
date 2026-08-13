import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import type { WorkflowNode } from './model'
import { toCanvasNode, toCanvasRunGraph, toWorkflowNode, workflowNodeData } from './App'

function workflowNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'node-1',
    kind: 'prompt',
    definitionVersion: 3,
    position: { x: 10, y: 20 },
    data: { prompt: '测试', model: '', status: 'idle', settings: { note: '保留' } },
    ...overrides,
  }
}

describe('canvas workflow projection', () => {
  it('restores registry dimensions for legacy asset nodes without saved geometry', () => {
    const canvas = toCanvasNode(workflowNode({ id: 'legacy-asset', kind: 'image-input', data: workflowNodeData('image-input') }))

    expect(canvas.width).toBe(280)
    expect(canvas.height).toBe(340)
    expect(canvas.style).toMatchObject({ width: 280, height: 340 })
  })

  it('round-trips definition metadata without leaking it into user settings', () => {
    const source = workflowNode({
      kind: 'unknown',
      definitionVersion: 7,
      disabled: true,
      unknownKind: 'future-super-node',
    })

    const canvas = toCanvasNode(source)
    expect(canvas).toMatchObject({ type: 'unknown', definitionVersion: 7, disabled: true, unknownKind: 'future-super-node' })
    expect(canvas.data.settings).toEqual({ note: '保留' })
    expect(toWorkflowNode(canvas)).toMatchObject({
      kind: 'unknown', definitionVersion: 7, disabled: true, unknownKind: 'future-super-node',
      data: { settings: { note: '保留' } },
    })
  })

  it('preserves disabled known nodes and excludes unknown placeholders from execution', () => {
    const disabled = toCanvasNode(workflowNode({ id: 'disabled', disabled: true, definitionVersion: 4 }))
    const unknown = toCanvasNode(workflowNode({
      id: 'unknown', kind: 'unknown', disabled: true, unknownKind: 'future-node', definitionVersion: 9,
    }))
    const edges: Edge[] = [{ id: 'edge-1', source: 'disabled', target: 'unknown' }]

    const graph = toCanvasRunGraph([disabled, unknown], edges, '生图分组')

    expect(graph.nodes).toEqual([expect.objectContaining({ id: 'disabled', definitionVersion: 4, disabled: true })])
    expect(graph.edges).toEqual([])
  })

  it('projects a template-bound local asset into an owned image-input run', () => {
    const assetId = 'a'.repeat(43)
    const data = workflowNodeData('image-input', { assetId })
    expect(data).toMatchObject({
      status: 'succeeded',
      result: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}` },
    })
    expect(data.settings).toBeUndefined()

    const canvas = toCanvasNode(workflowNode({ id: 'asset', kind: 'image-input', data }))
    expect(toCanvasRunGraph([canvas], [], '生图分组').nodes[0].data.adoptedAssetId).toBe(assetId)
  })
})
