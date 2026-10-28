import { describe, expect, it } from 'vitest'
import { createCanvasNodeRenderSelector } from './node-render-snapshot'
import type { WorkflowNodeData } from '../model'

describe('controlled node content snapshots', () => {
  it('preserves the context identity for dragging, measurements, selection and reordering', () => {
    const select = createCanvasNodeRenderSelector()
    const nodes = ['a', 'b'].map((id) => ({ id, type: 'image-crop', position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle' as const } }))
    const before = select(nodes)
    expect(select(nodes.map((node) => ({ ...node, position: { x: 30, y: 50 }, measured: { width: 320, height: 535 }, selected: true })).reverse())).toBe(before)
    expect(before.get('a')?.data).toBe(nodes[0].data)
  })

  it('publishes a complete result in one snapshot and removes deleted or replaced content', () => {
    const select = createCanvasNodeRenderSelector()
    const data: WorkflowNodeData & Record<string, unknown> = { prompt: '', model: '', status: 'running' }
    const first = select([{ id: 'crop', type: 'image-crop', data }])
    const asset = { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }
    const completed: WorkflowNodeData & Record<string, unknown> = { ...data, status: 'succeeded', result: asset, candidates: [{ candidateId: 'candidate', attemptId: 'attempt', createdAt: '', asset }] }
    const second = select([{ id: 'crop', type: 'image-crop', data: completed }])
    expect(second).not.toBe(first)
    expect(second.get('crop')?.data).toBe(completed)
    expect(first.get('crop')?.data.status).toBe('running')
    const replaced = select([{ id: 'crop', type: 'image-grid-split', data: completed }])
    expect(replaced).not.toBe(second)
    expect(replaced.get('crop')?.type).toBe('image-grid-split')
    const removed = select([])
    expect(removed.has('crop')).toBe(false)
    expect(select([])).toBe(removed)
  })
})
