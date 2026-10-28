import { describe, expect, it } from 'vitest'
import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import { duplicateCanvasNodesForAltDrag } from './alt-drag'
import { buildCanvasClipboardPayload, pasteCanvasClipboard } from './clipboard'

function graph() {
  const nodes: EditorNodeRecord[] = ['prompt', 'text', 'image'].map((id) => ({
    id, type: id === 'text' ? 'text-generate' : id === 'image' ? 'image-generate' : 'prompt',
    definitionVersion: 1, position: { x: 0, y: 0 },
    data: id === 'text' ? { prompt: 'instruction', outputText: 'previous result' }
      : id === 'image' ? { result: { assetId: 'previous-image', kind: 'image' } } : { prompt: 'upstream' },
  }))
  const edges: EditorEdgeRecord[] = [
    { id: 'a', source: 'prompt', target: 'text', sourceHandle: 'out:text', targetHandle: 'in:text' },
    { id: 'b', source: 'text', target: 'image', sourceHandle: 'out:text', targetHandle: 'in:text' },
  ]
  return { nodes, edges }
}

describe('copied results with omitted inputs', () => {
  it('marks the disconnected node and its copied downstream stale while retaining previous results', () => {
    const { nodes, edges } = graph()
    const payload = buildCanvasClipboardPayload(nodes, edges, new Set(['text', 'image']))
    const pasted = pasteCanvasClipboard(payload, { offset: { x: 32, y: 32 }, createNodeId: (id) => `copy-${id}`, createEdgeId: (id) => `copy-${id}` })
    expect(pasted.nodes[0].data).toMatchObject({ dirty: true, outputText: 'previous result' })
    expect(pasted.nodes[1].data).toMatchObject({ dirty: true, result: { assetId: 'previous-image' } })
    expect(pasted.edges.map((edge) => [edge.source, edge.target])).toEqual([['copy-text', 'copy-image']])
    expect(nodes.every((node) => node.data.dirty === undefined)).toBe(true)
  })

  it('retains result validity when the complete upstream chain is copied', () => {
    const { nodes, edges } = graph()
    expect(buildCanvasClipboardPayload(nodes, edges, new Set(nodes.map((node) => node.id))).nodes.every((node) => node.data.dirty === undefined)).toBe(true)
  })

  it.each([false, true])('handles Alt duplication with retained inputs=%s', (preserveInputConnections) => {
    const { nodes, edges } = graph()
    const copy = duplicateCanvasNodesForAltDrag(nodes, edges, { nodeIds: ['text', 'image'], preserveInputConnections, createNodeId: (id) => `copy-${id}`, createEdgeId: (id) => `copy-${id}` })
    expect(copy.nodes.map((node) => node.data.dirty)).toEqual(preserveInputConnections ? [undefined, undefined] : [true, true])
    expect(copy.edges.some((edge) => edge.source === 'prompt')).toBe(preserveInputConnections)
    expect(nodes.every((node) => node.data.dirty === undefined)).toBe(true)
  })
})
