import { describe, expect, it } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { arrangeCanvasNodes } from './arrange-nodes'
import { buildCanvasClipboardPayload, pasteCanvasClipboard } from './clipboard'
import { organizeCanvasGroupContents } from './organize-groups'

function node(id: string, x: number, y: number, options: Partial<EditorNodeRecord> = {}): EditorNodeRecord {
  return { id, type: 'prompt', definitionVersion: 1, data: { prompt: id }, position: { x, y }, width: 280, height: 180, ...options }
}
function group(id: string, x: number, y: number, options: Partial<EditorNodeRecord> = {}): EditorNodeRecord {
  return node(id, x, y, { type: 'group', width: 2000, height: 1800, ...options })
}
function absolute(nodes: readonly EditorNodeRecord[], id: string): { x: number; y: number } {
  const item = nodes.find((entry) => entry.id === id)!
  const parent = item.parentId ? absolute(nodes, item.parentId) : { x: 0, y: 0 }
  return { x: parent.x + item.position.x, y: parent.y + item.position.y }
}
const paste = { offset: { x: 32, y: 32 }, createNodeId: (id: string) => `copy-${id}`, createEdgeId: (id: string) => `copy-${id}` }

describe('group selection copy and arrangement regressions', () => {
  it('copies one selected group with its nested descendants and internal edges exactly once', () => {
    const nodes = [group('outer', 100, 200), group('inner', 50, 420, { parentId: 'outer', width: 800, height: 500 }), node('a', 32, 96, { parentId: 'inner' }), node('b', 400, 120, { parentId: 'inner' }), node('outside', 2400, 100)]
    const edges = [{ id: 'inside', source: 'a', target: 'b', sourceHandle: 'out:text', targetHandle: 'in:text' }, { id: 'external', source: 'outside', target: 'a', sourceHandle: 'out:text', targetHandle: 'in:text' }]
    const payload = buildCanvasClipboardPayload(nodes, edges, new Set(['inner', 'a']))
    expect(payload.nodes.map((item) => item.id)).toEqual(['inner', 'a', 'b'])
    expect(payload.edges.map((edge) => edge.id)).toEqual(['inside'])
    const result = pasteCanvasClipboard(payload, paste)
    expect(result.nodes.find((item) => item.id === 'copy-inner')?.parentId).toBeUndefined()
    expect(result.nodes.find((item) => item.id === 'copy-a')?.parentId).toBe('copy-inner')
    for (const id of ['inner', 'a', 'b']) expect(absolute(result.nodes, `copy-${id}`)).toEqual({ x: absolute(nodes, id).x + 32, y: absolute(nodes, id).y + 32 })
    expect(result.edges[0]).toMatchObject({ source: 'copy-a', target: 'copy-b' })
    expect(nodes[1].position).toEqual({ x: 50, y: 420 })
  })

  it('preserves world spacing when copying leaves from different parents and a root', () => {
    const nodes = [group('g1', 100, 200), node('a', 32, 96, { parentId: 'g1' }), group('g2', 1300, 400), node('b', 80, 140, { parentId: 'g2' }), node('root', -300, 40)]
    const copied = pasteCanvasClipboard(buildCanvasClipboardPayload(nodes, [], new Set(['a', 'b', 'root'])), paste)
    for (const id of ['a', 'b', 'root']) {
      expect(copied.nodes.find((item) => item.id === `copy-${id}`)?.parentId).toBeUndefined()
      expect(absolute(copied.nodes, `copy-${id}`)).toEqual({ x: absolute(nodes, id).x + 32, y: absolute(nodes, id).y + 32 })
    }
    const before = createCanvasHistory({ ...createCanvasDocument(), nodes })
    const after = applyCanvasCommand(before, { type: 'add-nodes', nodes: copied.nodes, edges: copied.edges })
    expect(undoCanvasHistory(after).present).toEqual(before.present)
    expect(redoCanvasHistory(undoCanvasHistory(after)).present).toEqual(after.present)
  })

  it.each(['horizontal', 'vertical', 'smart'] as const)('keeps children of a roomy locked group fixed during %s arrangement', (mode) => {
    const nodes = [group('locked', 100, 200, { locked: true }), node('a', 300, 300, { parentId: 'locked' }), node('b', 700, 600, { parentId: 'locked' })]
    const before = structuredClone(nodes)
    expect(() => arrangeCanvasNodes(nodes, [], mode, ['a', 'b'])).toThrow('锁定分组')
    expect(nodes).toEqual(before)
  })

  it.each(['horizontal', 'vertical', 'smart'] as const)('does not move a group containing a locked descendant during %s arrangement', (mode) => {
    const nodes = [group('g', 1000, 700), node('locked', 32, 96, { parentId: 'g', locked: true }), node('root', 0, 0)]
    const result = arrangeCanvasNodes(nodes, [], mode, ['g', 'root'])
    expect(absolute(result, 'locked')).toEqual(absolute(nodes, 'locked'))
    expect(result.find((item) => item.id === 'g')?.position).toEqual(nodes[0].position)
  })

  it('rejects organization when avoiding an outside obstacle would move a locked descendant in world space', () => {
    const nodes = [group('g', 32, 96, { width: 400, height: 300 }), node('locked', 32, 96, { parentId: 'g', locked: true, height: 900 }), node('other', 40, 100, { parentId: 'g' }), node('outside', 100, 500)]
    const before = structuredClone(nodes)
    expect(() => organizeCanvasGroupContents(nodes, [], ['g'])).toThrow('锁定')
    expect(nodes).toEqual(before)
  })
})
