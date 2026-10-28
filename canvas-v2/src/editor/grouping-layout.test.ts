import { describe, expect, it } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { groupCanvasNodes, ungroupCanvasNode, validateParentGraph } from './grouping'

function node(id: string, x: number, y: number, options: Partial<EditorNodeRecord> = {}): EditorNodeRecord {
  return { id, type: 'prompt', definitionVersion: 1, data: { prompt: id }, position: { x, y }, width: 280, height: 180, ...options }
}
function group(id: string, x: number, y: number, options: Partial<EditorNodeRecord> = {}): EditorNodeRecord {
  return node(id, x, y, { type: 'group', width: 900, height: 900, ...options })
}
function world(nodes: readonly EditorNodeRecord[], id: string): { x: number; y: number } {
  const current = nodes.find((entry) => entry.id === id)!, parent = current.parentId ? world(nodes, current.parentId) : { x: 0, y: 0 }
  return { x: parent.x + current.position.x, y: parent.y + current.position.y }
}
function expectContained(nodes: readonly EditorNodeRecord[]) {
  for (const child of nodes.filter((entry) => entry.parentId)) {
    const parent = nodes.find((entry) => entry.id === child.parentId)!
    expect(child.position.x).toBeGreaterThanOrEqual(32)
    expect(child.position.y).toBeGreaterThanOrEqual(96)
    expect(child.position.x + child.width! + 32).toBeLessThanOrEqual(parent.width!)
    expect(child.position.y + child.height! + 32).toBeLessThanOrEqual(parent.height!)
  }
}

describe('nested grouping header space', () => {
  it('keeps the observed fixture content fixed while moving the outer header above the new group', () => {
    const nodes = [group('A', 100, 100), node('A1', 80, 120, { parentId: 'A' }), node('A2', 450, 360, { parentId: 'A' }), node('sibling', 580, 660, { parentId: 'A', locked: true }), node('outside', 1500, 100)]
    const snapshot = structuredClone(nodes)
    const result = groupCanvasNodes(nodes, new Set(['A1', 'A2']), { groupId: 'new' })!
    expect(world(result, 'new')).toEqual({ x: 148, y: 124 })
    expect(result.find((entry) => entry.id === 'new')!.position).toEqual({ x: 48, y: 96 })
    expect(result.find((entry) => entry.id === 'A')).toMatchObject({ position: { x: 100, y: 28 }, width: 900, height: 972 })
    for (const id of ['A1', 'A2', 'sibling', 'outside']) expect(world(result, id)).toEqual(world(nodes, id))
    expect(result.find((entry) => entry.id === 'sibling')?.locked).toBe(true)
    expectContained(result)
    expect(nodes).toEqual(snapshot)
  })

  it('recursively grows left and top extents without moving selected or unselected leaves', () => {
    const nodes = [group('outer', 500, 500, { width: 1800, height: 1800 }), group('inner', 32, 96, { parentId: 'outer' }), node('a', 32, 96, { parentId: 'inner', locked: true }), node('b', 430, 400, { parentId: 'inner' }), node('inner-other', 600, 700, { parentId: 'inner' }), node('outer-other', 1200, 1200, { parentId: 'outer', locked: true })]
    const result = groupCanvasNodes(nodes, new Set(['a', 'b']), { groupId: 'new' })!
    expect(result.find((entry) => entry.id === 'outer')!.position).toEqual({ x: 468, y: 404 })
    expect(result.find((entry) => entry.id === 'inner')!.position).toEqual({ x: 32, y: 96 })
    for (const id of ['a', 'b', 'inner-other', 'outer-other']) expect(world(result, id)).toEqual(world(nodes, id))
    expectContained(result)
    expect(validateParentGraph(result)).toBe(true)
  })

  it.each(['parent', 'ancestor'] as const)('rejects required growth inside a locked %s without changing any input', (locked) => {
    const nodes = [group('outer', 500, 500, { locked: locked === 'ancestor', width: 1800, height: 1800 }), group('inner', 32, 96, { parentId: 'outer', locked: locked === 'parent' }), node('a', 32, 96, { parentId: 'inner' }), node('b', 430, 400, { parentId: 'inner' })]
    const before = structuredClone(nodes)
    expect(() => groupCanvasNodes(nodes, new Set(['a', 'b']), { groupId: 'new' })).toThrow('锁定分组')
    expect(nodes).toEqual(before)
  })

  it('records the new frame and all ancestor geometry in one reversible command without changing edges', () => {
    const nodes = [group('A', 100, 100), node('a', 80, 120, { parentId: 'A' }), node('b', 450, 360, { parentId: 'A' })]
    const edges = [{ id: 'edge', source: 'a', target: 'b', sourceHandle: 'out:text', targetHandle: 'in:text' }]
    const before = createCanvasHistory({ ...createCanvasDocument(), nodes, edges })
    const grouped = groupCanvasNodes(nodes, new Set(['a', 'b']), { groupId: 'new' })!
    const after = applyCanvasCommand(before, { type: 'replace-nodes', nodes: grouped })
    expect(after.present.edges).toEqual(edges)
    expect(undoCanvasHistory(after).present).toEqual(before.present)
    expect(redoCanvasHistory(undoCanvasHistory(after)).present).toEqual(after.present)
    const ungrouped = ungroupCanvasNode(grouped, 'new')!
    for (const id of ['a', 'b']) expect(world(ungrouped, id)).toEqual(world(nodes, id))
  })

  it('does not silently expand past the maximum depth or a broken parent graph', () => {
    const groups = Array.from({ length: 8 }, (_, index) => group(`g${index}`, 32, 96, index ? { parentId: `g${index - 1}` } : {}))
    const nodes = [...groups, node('a', 32, 96, { parentId: 'g7' }), node('b', 430, 400, { parentId: 'g7' })]
    expect(groupCanvasNodes(nodes, new Set(['a', 'b']), { groupId: 'too-deep' })).toBeNull()
    expect(groupCanvasNodes([node('a', 0, 0, { parentId: 'missing' }), node('b', 300, 0, { parentId: 'missing' })], new Set(['a', 'b']), { groupId: 'new' })).toBeNull()
  })
})
