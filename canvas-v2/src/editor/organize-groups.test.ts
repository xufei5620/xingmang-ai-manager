import { describe, expect, it } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { EditorNodeRecord } from '../domain/node-definition'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { arrangeCanvasNodes } from './arrange-nodes'
import { organizeCanvasGroupContents } from './organize-groups'

function group(id: string, parentId?: string): EditorNodeRecord {
  return { ...builtinNodeRegistry.create('group', id, { x: 32, y: 96 }), width: 400, height: 300, ...(parentId ? { parentId } : {}) }
}
function child(id: string, parentId: string, height = 220): EditorNodeRecord {
  return { ...builtinNodeRegistry.create('prompt', id, { x: 40, y: 100 }), parentId, width: 280, height }
}
function overlap(a: EditorNodeRecord, b: EditorNodeRecord): boolean {
  return a.position.x < b.position.x + b.width! && a.position.x + a.width! > b.position.x && a.position.y < b.position.y + b.height! && a.position.y + a.height! > b.position.y
}
function assertContained(nodes: EditorNodeRecord[]) {
  for (const node of nodes.filter((entry) => entry.parentId)) {
    const parent = nodes.find((entry) => entry.id === node.parentId)!
    expect(node.position.x).toBeGreaterThanOrEqual(32)
    expect(node.position.y).toBeGreaterThanOrEqual(96)
    expect(node.position.x + node.width! + 32).toBeLessThanOrEqual(parent.width!)
    expect(node.position.y + node.height! + 32).toBeLessThanOrEqual(parent.height!)
  }
  for (const a of nodes) for (const b of nodes) {
    if (a.id < b.id && a.parentId === b.parentId) expect(overlap(a, b), `${a.id} overlaps ${b.id}`).toBe(false)
  }
}

describe('explicit group content organization', () => {
  it('organizes a single selected group using real child heights and leaves ordinary arrange semantics intact', () => {
    const nodes = [group('g'), child('a', 'g', 1100), child('b', 'g', 830)]
    expect(arrangeCanvasNodes(nodes, [], 'smart').slice(1)).toEqual(nodes.slice(1))
    expect(arrangeCanvasNodes(nodes, [], 'smart', ['g']).slice(1)).toEqual(nodes.slice(1))
    const result = organizeCanvasGroupContents(nodes, [], ['g'])
    assertContained(result)
    expect(result[2].position.y).toBeGreaterThanOrEqual(result[1].position.y + 1100 + 24)
    expect(result[1].data).toEqual(nodes[1].data)
    expect(nodes[2].position).toEqual({ x: 40, y: 100 })
  })

  it('normalizes a single child below the group header', () => {
    const result = organizeCanvasGroupContents([group('g'), { ...child('only', 'g'), position: { x: 0, y: 0 } }], [], ['g'])
    expect(result[1].position).toEqual({ x: 32, y: 96 })
    assertContained(result)
  })

  it('lays out nested groups inside out and avoids top-level siblings after expanding', () => {
    const nodes = [group('root'), group('nested', 'root'), child('a', 'nested', 1300), child('b', 'nested', 900), child('c', 'root', 700), { ...child('outside', 'unused'), parentId: undefined, position: { x: 100, y: 500 } }]
    const edges = [{ id: 'edge', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' }]
    const result = organizeCanvasGroupContents(nodes, edges, ['root'])
    expect(result[2].position.x).toBeLessThan(result[3].position.x)
    expect(result[5]).toEqual(nodes[5])
    expect(result[0].position.y).toBeGreaterThan(nodes[5].position.y + nodes[5].height!)
    assertContained(result)
    const history = createCanvasHistory({ ...createCanvasDocument(), nodes, edges })
    const changed = applyCanvasCommand(history, { type: 'replace-nodes', nodes: result })
    expect(undoCanvasHistory(changed).present).toEqual(history.present)
    expect(redoCanvasHistory(undoCanvasHistory(changed)).present).toEqual(changed.present)
  })

  it('moves an expanded selected subgroup past untouched siblings and expands ancestors', () => {
    const nodes = [group('root'), group('selected', 'root'), child('a', 'selected', 1500), child('b', 'selected', 1000), { ...child('sibling', 'root', 300), position: { x: 50, y: 600 } }, { ...group('other-root'), height: 400, position: { x: 2000, y: 0 } }, child('other-child', 'other-root')]
    const result = organizeCanvasGroupContents(nodes, [], ['selected'])
    expect(result[4]).toEqual(nodes[4])
    expect(result[5]).toEqual(nodes[5])
    expect(result[6]).toEqual(nodes[6])
    expect(result[1].position.y).toBeGreaterThan(nodes[4].position.y + nodes[4].height!)
    assertContained(result)
  })

  it('organizes all groups without a selection and separates expanded root groups', () => {
    const result = organizeCanvasGroupContents([group('first'), child('a', 'first', 1000), child('b', 'first'), group('second'), child('c', 'second', 900), child('d', 'second')], [])
    assertContained(result)
  })

  it('keeps a locked child fixed and uses it as an obstacle', () => {
    const fixed = { ...child('a', 'g', 900), position: { x: 32, y: 96 }, locked: true }
    const result = organizeCanvasGroupContents([group('g'), fixed, child('b', 'g')], [], ['g'])
    expect(result[1]).toEqual(fixed)
    assertContained(result)
  })

  it.each(['target', 'ancestor'] as const)('rejects changes inside a locked %s without mutating any input', (locked) => {
    const nodes = [{ ...group('root'), width: 6000, height: 6000, locked: locked === 'ancestor' }, { ...group('nested', 'root'), width: 5000, height: 5000, locked: locked === 'target' }, child('a', 'nested'), child('b', 'nested')]
    const before = structuredClone(nodes)
    expect(() => organizeCanvasGroupContents(nodes, [], ['nested'])).toThrow('锁定')
    expect(nodes).toEqual(before)
  })

  it('rejects overlapping locked children instead of reporting a successful partial arrangement', () => {
    const nodes = [group('g'), { ...child('a', 'g'), locked: true }, { ...child('b', 'g'), locked: true }, child('c', 'g')]
    const before = structuredClone(nodes)
    expect(() => organizeCanvasGroupContents(nodes, [], ['g'])).toThrow('锁定节点互相重叠')
    expect(nodes).toEqual(before)
  })

  it('preserves unrelated empty groups and rejects incomplete or cyclic hierarchies', () => {
    const empty = group('empty')
    expect(organizeCanvasGroupContents([empty], [], ['empty'])).toEqual([empty])
    expect(() => organizeCanvasGroupContents([group('g', 'missing')], [])).toThrow('层级不完整')
    expect(() => organizeCanvasGroupContents([group('g', 'nested'), group('nested', 'g')], [])).toThrow('循环')
  })
})
