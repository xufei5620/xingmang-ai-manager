import { describe, expect, it } from 'vitest'
import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import {
  buildCanvasClipboardPayload,
  parseCanvasClipboard,
  pasteCanvasClipboard,
  serializeCanvasClipboard,
} from './clipboard'

function node(id: string, parentId?: string): EditorNodeRecord {
  return { id, type: 'prompt', definitionVersion: 1, position: { x: 10, y: 20 }, data: { prompt: id }, ...(parentId ? { parentId } : {}) }
}

const edges: EditorEdgeRecord[] = [
  { id: 'ab', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' },
  { id: 'bc', source: 'b', sourceHandle: 'out:text', target: 'c', targetHandle: 'in:text' },
]

describe('canvas clipboard', () => {
  it('copies only internal edges and strips selection state', () => {
    const a = { ...node('a'), selected: true }
    const payload = buildCanvasClipboardPayload([a, node('b'), node('c')], edges, new Set(['a', 'b']))
    expect(payload.nodes.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(payload.edges.map((entry) => entry.id)).toEqual(['ab'])
    expect(payload.nodes[0].selected).toBeUndefined()
  })

  it('round trips bounded payloads and rejects dangling edges', () => {
    const payload = buildCanvasClipboardPayload([node('a'), node('b')], edges, new Set(['a', 'b']))
    expect(parseCanvasClipboard(serializeCanvasClipboard(payload))).toEqual(payload)
    expect(parseCanvasClipboard(JSON.stringify({ ...payload, edges: [edges[1]] }))).toBeNull()
  })

  it('remaps every id and offsets only top-level nodes', () => {
    const group: EditorNodeRecord = { id: 'g', type: 'group', definitionVersion: 1, position: { x: 100, y: 100 }, data: {}, width: 400, height: 300 }
    const child = node('a', 'g')
    const result = pasteCanvasClipboard(
      { version: 1, nodes: [group, child], edges: [] },
      { offset: { x: 20, y: 30 }, createNodeId: (id) => `copy-${id}`, createEdgeId: (id) => `copy-${id}` },
    )
    expect(result.nodes[0]).toMatchObject({ id: 'copy-g', position: { x: 120, y: 130 } })
    expect(result.nodes[1]).toMatchObject({ id: 'copy-a', parentId: 'copy-g', position: { x: 10, y: 20 } })
  })
})
