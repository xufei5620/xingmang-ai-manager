import { describe, expect, it } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import { groupCanvasNodes, ungroupCanvasNode, validateParentGraph } from './grouping'

function node(id: string, x: number, y: number): EditorNodeRecord {
  return { id, type: 'prompt', definitionVersion: 1, position: { x, y }, data: {}, width: 100, height: 80 }
}

describe('canvas grouping', () => {
  it('keeps absolute positions across group and ungroup', () => {
    const original = [node('a', 100, 120), node('b', 300, 240), node('c', 800, 400)]
    const grouped = groupCanvasNodes(original, new Set(['a', 'b']), { groupId: 'group-1', padding: 20 })
    expect(grouped).not.toBeNull()
    const restored = ungroupCanvasNode(grouped as EditorNodeRecord[], 'group-1')
    expect(restored?.find((entry) => entry.id === 'a')?.position).toEqual({ x: 100, y: 120 })
    expect(restored?.find((entry) => entry.id === 'b')?.position).toEqual({ x: 300, y: 240 })
    expect(restored?.find((entry) => entry.id === 'c')?.position).toEqual({ x: 800, y: 400 })
  })

  it('requires siblings and at least two nodes', () => {
    const a = { ...node('a', 0, 0), parentId: 'group-a' }
    const b = { ...node('b', 100, 0), parentId: 'group-b' }
    expect(groupCanvasNodes([a, b], new Set(['a', 'b']), { groupId: 'g' })).toBeNull()
    expect(groupCanvasNodes([a, b], new Set(['a']), { groupId: 'g' })).toBeNull()
  })

  it('supports nested groups without changing document-space positions', () => {
    const inner = { ...node('inner', 40, 60), type: 'group', width: 220, height: 180 }
    const sibling = node('sibling', 320, 80)
    const child = { ...node('child', 25, 30), parentId: 'inner' }
    const grouped = groupCanvasNodes([inner, sibling, child], new Set(['inner', 'sibling']), {
      groupId: 'outer',
      padding: 20,
    })
    expect(grouped).not.toBeNull()
    expect(validateParentGraph(grouped as EditorNodeRecord[])).toBe(true)

    const outer = grouped?.find((entry) => entry.id === 'outer')
    const nestedInner = grouped?.find((entry) => entry.id === 'inner')
    const nestedChild = grouped?.find((entry) => entry.id === 'child')
    expect(outer?.position).toEqual({ x: 20, y: 40 })
    expect(nestedInner?.position).toEqual({ x: 20, y: 20 })
    expect(nestedChild?.position).toEqual({ x: 25, y: 30 })

    const restored = ungroupCanvasNode(grouped as EditorNodeRecord[], 'outer')
    expect(restored?.find((entry) => entry.id === 'inner')?.position).toEqual({ x: 40, y: 60 })
    expect(restored?.find((entry) => entry.id === 'child')?.parentId).toBe('inner')
    expect(validateParentGraph(restored as EditorNodeRecord[])).toBe(true)
  })

  it('rejects parent cycles, missing groups, and excessive depth', () => {
    const cycle = [
      { ...node('a', 0, 0), type: 'group', parentId: 'b' },
      { ...node('b', 0, 0), type: 'group', parentId: 'a' },
    ]
    expect(validateParentGraph(cycle)).toBe(false)
    expect(validateParentGraph([{ ...node('a', 0, 0), parentId: 'missing' }])).toBe(false)
  })
})
