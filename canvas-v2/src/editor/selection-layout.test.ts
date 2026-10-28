import { describe, expect, it } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { layoutCanvasSelection } from './selection-layout'

function node(id: string, x: number, y: number, options: Partial<EditorNodeRecord> = {}): EditorNodeRecord {
  return { id, type: 'prompt', definitionVersion: 1, data: { prompt: id }, position: { x, y }, width: 100, height: 80, ...options }
}
function group(id: string, x: number, y: number, options: Partial<EditorNodeRecord> = {}): EditorNodeRecord {
  return node(id, x, y, { type: 'group', width: 400, height: 300, ...options })
}
function absolute(nodes: readonly EditorNodeRecord[], id: string): { x: number; y: number } {
  const current = nodes.find((entry) => entry.id === id)!
  const parent = current.parentId ? absolute(nodes, current.parentId) : { x: 0, y: 0 }
  return { x: parent.x + current.position.x, y: parent.y + current.position.y }
}
function assertContained(nodes: readonly EditorNodeRecord[]) {
  for (const child of nodes) {
    if (!child.parentId) continue
    const parent = nodes.find((entry) => entry.id === child.parentId)!
    expect(child.position.x).toBeGreaterThanOrEqual(32)
    expect(child.position.y).toBeGreaterThanOrEqual(96)
    expect(child.position.x + child.width! + 32).toBeLessThanOrEqual(parent.width!)
    expect(child.position.y + child.height! + 32).toBeLessThanOrEqual(parent.height!)
  }
}

describe('selection layout in nested world coordinates', () => {
  it('aligns a root and a grouped child while preserving its unselected sibling', () => {
    const before = [node('root', 0, 20), group('g', 1000, 200), node('child', 40, 100, { parentId: 'g' }), node('sibling', 180, 190, { parentId: 'g', locked: true })]
    const frozen = structuredClone(before)
    const result = layoutCanvasSelection(before, ['root', 'child'], { kind: 'align', mode: 'left' })
    expect(result.changed).toBe(true)
    expect(absolute(result.nodes, 'root').x).toBe(0)
    expect(absolute(result.nodes, 'child').x).toBe(0)
    expect(absolute(result.nodes, 'sibling')).toEqual(absolute(before, 'sibling'))
    expect(result.nodes.find((entry) => entry.id === 'g')!.position.x).toBe(-32)
    assertContained(result.nodes)
    expect(before).toEqual(frozen)
  })

  it.each(['left', 'horizontal-center', 'right', 'top', 'vertical-center', 'bottom'] as const)('aligns mixed parents by the %s edge using actual sizes', (mode) => {
    const before = [group('g1', -300, 250), group('g2', 700, 800), node('a', 32, 96, { parentId: 'g1', width: 143, height: 89 }), node('b', 60, 130, { parentId: 'g2', width: 210, height: 137 })]
    const result = layoutCanvasSelection(before, ['a', 'b'], { kind: 'align', mode })
    const axis = ['left', 'right', 'horizontal-center'].includes(mode) ? 'x' : 'y'
    const a = result.nodes.find((entry) => entry.id === 'a')!, b = result.nodes.find((entry) => entry.id === 'b')!
    const factor = mode.includes('center') ? 0.5 : ['right', 'bottom'].includes(mode) ? 1 : 0
    const aEdge = absolute(result.nodes, 'a')[axis] + (axis === 'x' ? a.width! : a.height!) * factor
    const bEdge = absolute(result.nodes, 'b')[axis] + (axis === 'x' ? b.width! : b.height!) * factor
    expect(aEdge).toBe(bEdge)
    assertContained(result.nodes)
  })

  it('grows nested containers from the inside out and preserves all other contents', () => {
    const before = [node('anchor', -200, -100), group('outer', 1000, 600, { width: 800, height: 650 }), group('inner', 70, 140, { parentId: 'outer' }), node('selected', 32, 96, { parentId: 'inner' }), node('inner-other', 190, 180, { parentId: 'inner' }), node('outer-other', 600, 450, { parentId: 'outer' }), node('root-other', 2000, 300)]
    const horizontal = layoutCanvasSelection(before, ['anchor', 'selected'], { kind: 'align', mode: 'left' })
    const result = layoutCanvasSelection(horizontal.nodes, ['anchor', 'selected'], { kind: 'align', mode: 'top' })
    expect(absolute(result.nodes, 'selected')).toEqual({ x: -200, y: -100 })
    for (const id of ['inner-other', 'outer-other', 'root-other']) expect(absolute(result.nodes, id)).toEqual(absolute(before, id))
    assertContained(result.nodes)
  })

  it('moves a selected group only once when its child is also selected', () => {
    const before = [node('anchor', 0, 50), group('g', 800, 200), node('child', 32, 96, { parentId: 'g' })]
    const result = layoutCanvasSelection(before, ['anchor', 'g', 'child'], { kind: 'align', mode: 'left' })
    expect(result.selectedRootIds).toEqual(['anchor', 'g'])
    expect(result.nodes.find((entry) => entry.id === 'child')!.position).toEqual({ x: 32, y: 96 })
    expect(absolute(result.nodes, 'child')).toEqual({ x: 32, y: 296 })
  })

  it.each(['horizontal', 'vertical'] as const)('distributes cross-parent nodes with measured %s gaps', (axis) => {
    const horizontal = axis === 'horizontal'
    const before = [node('first', 0, 0), group('g', 400, 400), node('middle', 32, 96, { parentId: 'g', width: 200, height: 180 }), node('last', 1000, 1000), node('other', 200, 190, { parentId: 'g' })]
    const result = layoutCanvasSelection(before, ['first', 'middle', 'last'], { kind: 'distribute', axis })
    const key = horizontal ? 'x' : 'y'
    const firstGap = absolute(result.nodes, 'middle')[key] - absolute(result.nodes, 'first')[key] - (horizontal ? 100 : 80)
    const secondGap = absolute(result.nodes, 'last')[key] - absolute(result.nodes, 'middle')[key] - (horizontal ? 200 : 180)
    expect(firstGap).toBe(secondGap)
    expect(absolute(result.nodes, 'other')).toEqual(absolute(before, 'other'))
    assertContained(result.nodes)
  })

  it('uses locked nodes and locked ancestors as fixed anchors', () => {
    const before = [node('movable', 0, 10), group('locked-group', 1000, 200, { locked: true }), node('locked-child', 32, 96, { parentId: 'locked-group' })]
    const result = layoutCanvasSelection(before, ['movable', 'locked-child'], { kind: 'align', mode: 'right' })
    expect(absolute(result.nodes, 'movable').x).toBe(1032)
    expect(result.nodes.find((entry) => entry.id === 'locked-group')).toEqual(before[1])
    expect(result.nodes.find((entry) => entry.id === 'locked-child')).toEqual(before[2])
  })

  it('does not move a selected group containing a locked descendant', () => {
    const before = [node('anchor', 0, 0), group('g', 1000, 200), node('locked', 32, 96, { parentId: 'g', locked: true })]
    const result = layoutCanvasSelection(before, ['anchor', 'g'], { kind: 'align', mode: 'left' })
    expect(result.changed).toBe(false)
    expect(result.nodes).toEqual(before)
  })

  it('returns no change for a single effective selection or an already aligned selection', () => {
    const before = [group('g', 0, 0), node('child', 32, 96, { parentId: 'g' }), node('other', 0, 500)]
    expect(layoutCanvasSelection(before, ['g', 'child'], { kind: 'align', mode: 'left' }).changed).toBe(false)
    expect(layoutCanvasSelection(before, ['g', 'other'], { kind: 'align', mode: 'left' }).changed).toBe(false)
  })

  it('keeps edges and restores all geometry with one undo and redo', () => {
    const nodes = [node('anchor', 0, 0), group('g', 800, 500), node('selected', 32, 96, { parentId: 'g' }), node('other', 190, 190, { parentId: 'g' })]
    const edges = [{ id: 'external', source: 'anchor', target: 'selected', sourceHandle: 'out:text', targetHandle: 'in:text' }]
    const before = createCanvasHistory({ ...createCanvasDocument(), nodes, edges })
    const result = layoutCanvasSelection(nodes, ['anchor', 'selected'], { kind: 'align', mode: 'left' })
    const changed = applyCanvasCommand(before, { type: 'replace-nodes', nodes: result.nodes })
    expect(changed.present.edges).toEqual(edges)
    expect(undoCanvasHistory(changed).present).toEqual(before.present)
    expect(redoCanvasHistory(undoCanvasHistory(changed)).present.nodes).toEqual(result.nodes)
  })

  it('rejects malformed graphs and out-of-range growth without changing the input', () => {
    const before = [node('anchor', -9_999_990, 0), group('g', 1000, 200), node('child', 32, 96, { parentId: 'g' })]
    const copy = structuredClone(before)
    expect(() => layoutCanvasSelection(before, ['anchor', 'child'], { kind: 'align', mode: 'left' })).toThrow('范围过大')
    expect(before).toEqual(copy)
    expect(() => layoutCanvasSelection([node('broken', 0, 0, { parentId: 'missing' })], ['broken'], { kind: 'align', mode: 'left' })).toThrow('分组层级')
    expect(() => layoutCanvasSelection(before, ['missing'], { kind: 'align', mode: 'left' })).toThrow('已发生变化')
  })
})
