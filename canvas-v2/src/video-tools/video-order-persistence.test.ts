import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, serializeWorkflow, parseWorkflowFile, type WorkflowFile } from '../model'
import { buildCanvasClipboardPayload, pasteCanvasClipboard } from '../editor/clipboard'
import { duplicateCanvasNodesForAltDrag } from '../editor/alt-drag'
import { instantiateWorkshopGraph } from '../editor/workshop-graph'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'

function fixture(): WorkflowFile {
  return { ...createEmptyWorkflow('Video roles'), nodes: [
    ...['a', 'b'].map((id) => ({ id, kind: 'image-input' as const, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle' as const } })),
    { id: 'video', kind: 'video-generate', definitionVersion: 1, position: { x: 400, y: 0 }, data: { prompt: 'Transition', model: 'minimax-h3-fast', status: 'idle', settings: { videoMode: 'fl2va', videoReferenceOrder: { version: 1, slots: ['b', 'a'].map((id) => ({ edgeId: `edge-${id}`, outputIndex: 0 })) } } } },
  ], edges: ['a', 'b'].map((id) => ({ id: `edge-${id}`, source: id, sourceHandle: 'out:image', target: 'video', targetHandle: 'in:images' })) }
}
function order(workflow: WorkflowFile) { return workflow.nodes.find((node) => node.kind === 'video-generate')?.data.settings?.videoReferenceOrder }

describe('video ordering persistence and portable graphs', () => {
  it('preserves exact order and missing-role evidence in normal project saves', () => {
    const source = fixture(), expected = order(source)
    expect(order(parseWorkflowFile(serializeWorkflow(source))!)).toEqual(expected)
    source.edges.pop()
    expect(order(parseWorkflowFile(serializeWorkflow(source))!)).toEqual(expected)
    source.nodes[2].data.settings!.videoReferenceOrder = { version: 1 }
    expect(parseWorkflowFile(JSON.stringify(source))).toBeNull()
    expect(() => serializeWorkflow(source)).toThrow()
  })
  it('remaps workshop group references and clears unavailable single-node roles', () => {
    const source = fixture(), portable = sanitizeWorkshopWorkflow(source, 'group', 'Video roles')
    let sequence = 0
    const inserted = instantiateWorkshopGraph(portable, () => `copy-${++sequence}`)
    expect(order(inserted)).toEqual({ version: 1, slots: [inserted.edges[1], inserted.edges[0]].map((edge) => ({ edgeId: edge.id, outputIndex: 0 })) })
    const single = sanitizeWorkshopWorkflow({ ...source, nodes: [source.nodes[2]], edges: [] }, 'node', 'Video')
    expect(order(single)).toEqual({ version: 1, slots: [] })
    expect(source.nodes[2].data.settings!.videoReferenceOrder).toEqual(order(fixture()))
  })
  it('remaps actual clipboard paste and alt-drag roles without mutating the original', () => {
    const source = fixture(), nodes = source.nodes.map(({ kind, ...node }) => ({ ...node, type: kind, definitionVersion: 1, data: { ...node.data }, selected: true }))
    const payload = buildCanvasClipboardPayload(nodes, source.edges, new Set(nodes.map((node) => node.id)))
    const pasted = pasteCanvasClipboard(payload, { offset: { x: 700, y: 100 }, createNodeId: (id) => `new-${id}`, createEdgeId: (id) => `new-${id}` })
    expect((pasted.nodes.find((node) => node.type === 'video-generate')?.data.settings as Record<string, unknown>).videoReferenceOrder).toEqual({ version: 1, slots: ['new-edge-b', 'new-edge-a'].map((edgeId) => ({ edgeId, outputIndex: 0 })) })
    const copy = duplicateCanvasNodesForAltDrag(nodes, source.edges, { nodeIds: ['video'], preserveInputConnections: true, createNodeId: (id) => `new-${id}`, createEdgeId: (id) => `new-${id}` })
    expect((copy.nodes[0].data.settings as Record<string, unknown>).videoReferenceOrder).toEqual({ version: 1, slots: ['new-edge-b', 'new-edge-a'].map((edgeId) => ({ edgeId, outputIndex: 0 })) })
    expect(order(source)).toEqual(order(fixture()))
  })
})
