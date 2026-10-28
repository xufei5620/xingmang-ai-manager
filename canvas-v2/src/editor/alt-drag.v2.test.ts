import { describe, expect, it } from 'vitest'
import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import { duplicateCanvasNodesForAltDrag } from './alt-drag'

function node(id: string, parentId?: string): EditorNodeRecord {
  return {
    id,
    type: 'prompt',
    definitionVersion: 1,
    position: { x: id.length * 10, y: 20 },
    data: { prompt: id },
    ...(parentId ? { parentId } : {}),
  }
}

const edges: EditorEdgeRecord[] = [
  { id: 'input', source: 'upstream', sourceHandle: 'out:text', target: 'a', targetHandle: 'in:text' },
  { id: 'internal', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' },
  { id: 'output', source: 'b', sourceHandle: 'out:text', target: 'downstream', targetHandle: 'in:text' },
]

function duplicate(preserveInputConnections: boolean) {
  return duplicateCanvasNodesForAltDrag(
    [node('upstream'), node('a'), node('b'), node('downstream')],
    edges,
    {
      nodeIds: ['a', 'b'],
      preserveInputConnections,
      createNodeId: (id) => `copy-${id}`,
      createEdgeId: (id) => `copy-${id}`,
    },
  )
}

describe('Alt drag duplication', () => {
  it('copies selected nodes and their internal edges without external outputs', () => {
    const result = duplicate(false)
    expect(result.nodes.map((entry) => entry.id)).toEqual(['copy-a', 'copy-b'])
    expect(result.edges).toEqual([expect.objectContaining({
      id: 'copy-internal', source: 'copy-a', target: 'copy-b', selected: undefined,
    })])
  })

  it('retains external input edges only for Shift+Alt drag', () => {
    const result = duplicate(true)
    expect(result.edges.map((entry) => [entry.id, entry.source, entry.target])).toEqual([
      ['copy-input', 'upstream', 'copy-a'],
      ['copy-internal', 'copy-a', 'copy-b'],
    ])
  })

  it('copies descendants of selected groups and remaps their parent', () => {
    const result = duplicateCanvasNodesForAltDrag(
      [{ ...node('group'), type: 'group' }, node('child', 'group'), node('grandchild', 'child')],
      [],
      {
        nodeIds: ['group'],
        preserveInputConnections: false,
        createNodeId: (id) => `copy-${id}`,
        createEdgeId: (id) => `copy-${id}`,
      },
    )
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'copy-child', parentId: 'copy-group' }),
      expect.objectContaining({ id: 'copy-grandchild', parentId: 'copy-child' }),
    ]))
  })

  it('keeps a copied child inside its existing parent when the group is not copied', () => {
    const result = duplicateCanvasNodesForAltDrag(
      [{ ...node('group'), type: 'group' }, node('child', 'group')],
      [],
      {
        nodeIds: ['child'],
        preserveInputConnections: false,
        createNodeId: (id) => `copy-${id}`,
        createEdgeId: (id) => `copy-${id}`,
      },
    )
    expect(result.nodes[0]).toMatchObject({ id: 'copy-child', parentId: 'group' })
  })
})
