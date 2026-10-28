import { describe, expect, it } from 'vitest'
import { assertFrameSelection, captureFrameSelection } from './frame-selection-session'
import type { WorkflowNodeData } from '../model'

function fixture() {
  const data: WorkflowNodeData = { prompt: '', model: '', status: 'idle' }
  const nodes = [{ id: 'video', type: 'video-input', data: { ...data, result: { kind: 'video' as const, assetId: 'v'.repeat(43) } } }, { id: 'frame', type: 'frame-extract', data: { ...data, settings: { timestampSeconds: 1.2 } } }]
  const edges = [{ id: 'edge', source: 'video', sourceHandle: 'out:video', target: 'frame', targetHandle: 'in:video' }]
  return { nodes, edges }
}

describe('frame selection session', () => {
  it('captures the actual input identity and permits unrelated edits', () => {
    const f = fixture(), snapshot = captureFrameSelection(f.nodes, f.edges, 'frame')
    expect(snapshot).toEqual({ nodeId: 'frame', edgeId: 'edge', sourceNodeId: 'video', sourceAssetId: 'v'.repeat(43), timestampSeconds: 1.2 })
    f.nodes[1].data.prompt = 'unrelated'
    expect(() => assertFrameSelection(f.nodes, f.edges, snapshot)).not.toThrow()
  })
  it.each(['asset', 'edge', 'time', 'source', 'missing'] as const)('rejects a changed %s', (change) => {
    const f = fixture(), snapshot = captureFrameSelection(f.nodes, f.edges, 'frame')
    if (change === 'asset') f.nodes[0].data.result!.assetId = 'x'.repeat(43)
    if (change === 'edge') f.edges[0].id = 'new-edge'
    if (change === 'time') f.nodes[1].data.settings!.timestampSeconds = 2
    if (change === 'source') { f.nodes[0].id = 'other'; f.edges[0].source = 'other' }
    if (change === 'missing') f.nodes.pop()
    expect(() => assertFrameSelection(f.nodes, f.edges, snapshot)).toThrow()
  })
  it('rejects ambiguous or missing sources without choosing the first', () => {
    const f = fixture()
    expect(() => captureFrameSelection(f.nodes, [], 'frame')).toThrow('唯一')
    expect(() => captureFrameSelection(f.nodes, [...f.edges, { ...f.edges[0], id: 'duplicate' }], 'frame')).toThrow('唯一')
    expect(() => captureFrameSelection(f.nodes, [{ ...f.edges[0], sourceHandle: 'out:image' }], 'frame')).toThrow('唯一')
  })
  it('rejects a locked ancestor, disabled target and cyclic hierarchy', () => {
    const f = fixture(), group = { id: 'group', type: 'group', draggable: false, data: { prompt: '', model: '', status: 'idle' as const } }
    const grouped = [f.nodes[0], { ...f.nodes[1], parentId: 'group' }, group]
    expect(() => captureFrameSelection(grouped, f.edges, 'frame')).toThrow('锁定')
    expect(() => captureFrameSelection([f.nodes[0], { ...f.nodes[1], disabled: true }], f.edges, 'frame')).toThrow('禁用')
    expect(() => captureFrameSelection([f.nodes[0], { ...f.nodes[1], parentId: 'frame' }], f.edges, 'frame')).toThrow('层级')
  })
  it('rejects pending and stale generated video but permits imported input dirty flags', () => {
    const f = fixture()
    f.nodes[0].data.status = 'running'
    expect(() => captureFrameSelection(f.nodes, f.edges, 'frame')).toThrow('变化')
    f.nodes[0].data.status = 'succeeded'; f.nodes[0].data.dirty = true
    expect(() => captureFrameSelection(f.nodes, f.edges, 'frame')).not.toThrow()
    f.nodes[0].type = 'video-generate'
    expect(() => captureFrameSelection(f.nodes, f.edges, 'frame')).toThrow('变化')
  })
})
