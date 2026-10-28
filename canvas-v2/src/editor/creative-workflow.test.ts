import { describe, expect, it } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { createEmptyWorkflow, type WorkflowNode } from '../model'
import { connectionForInsertedNode, isValidWorkflowConnection } from '../ports'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { relatedNodeOptions } from './related-nodes'
import { arrangeCanvasNodes } from './arrange-nodes'
import { buildWorkshopSelection, instantiateWorkshopGraph } from './workshop-graph'
import { groupCanvasNodes } from './grouping'

function workflowNode(id: string, kind: WorkflowNode['kind'], x: number, y: number, parentId?: string): WorkflowNode {
  return { id, kind, definitionVersion: 1, position: { x, y }, ...(parentId ? { parentId } : {}), data: { prompt: id, model: '', status: 'idle' } }
}

describe('related-node creation', () => {
  it('uses the right-click target output and only lists compatible downstream nodes', () => {
    const nodes = [builtinNodeRegistry.create('prompt', 'old-selection', { x: 0, y: 0 }), builtinNodeRegistry.create('video-input', 'right-clicked', { x: 300, y: 0 })]
    const options = relatedNodeOptions('right-clicked', nodes, [])
    expect(options.some((option) => option.type === 'frame-extract')).toBe(true)
    expect(options.some((option) => option.type === 'image-generate')).toBe(false)
    expect(options.every((option) => option.pending.nodeId === 'right-clicked' && option.pending.handleId === 'out:video')).toBe(true)
    expect(relatedNodeOptions('gone', nodes, [])).toEqual([])
  })

  it('validates every offered connection and undoes a linked node in one step', () => {
    const source = builtinNodeRegistry.create('prompt', 'source', { x: 0, y: 0 })
    for (const option of relatedNodeOptions(source.id, [source], [])) {
      const target = builtinNodeRegistry.create(option.type, 'target', { x: 500, y: 0 })
      const connection = connectionForInsertedNode(option.pending, target.id, option.inputHandle)
      expect(isValidWorkflowConnection(connection, { nodeKindOf: (id) => id === source.id ? source.type : id === target.id ? target.type : null, edges: [] })).toBe(true)
      const edge = { id: 'edge', source: connection.source!, sourceHandle: connection.sourceHandle!, target: connection.target!, targetHandle: connection.targetHandle! }
      const before = createCanvasHistory({ ...createCanvasDocument(), nodes: [source] })
      const added = applyCanvasCommand(before, { type: 'add-nodes', nodes: [target], edges: [edge] })
      expect(added.present.edges).toHaveLength(1)
      expect(undoCanvasHistory(added).present).toEqual(before.present)
      expect(redoCanvasHistory(undoCanvasHistory(added)).present.nodes).toHaveLength(2)
    }
  })
})

describe('workshop graph selection and insertion', () => {
  const workflow = {
    ...createEmptyWorkflow('source'),
    nodes: [workflowNode('g', 'group', 500, 300), workflowNode('nested', 'group', 20, 30, 'g'), workflowNode('prompt', 'prompt', 40, 50, 'nested'), workflowNode('image', 'image-generate', 360, 50, 'nested'), workflowNode('external', 'prompt', 0, 0)],
    edges: [{ id: 'inside', source: 'prompt', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' }, { id: 'outside', source: 'external', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' }],
  }

  it('recursively collects groups and internal edges without including an external input', () => {
    const selected = buildWorkshopSelection(workflow, ['g'])
    expect(selected.nodes.map((node) => node.id)).toEqual(['g', 'nested', 'prompt', 'image'])
    expect(selected.edges.map((edge) => edge.id)).toEqual(['inside'])
    expect(selected.nodes[0].position).toEqual({ x: 80, y: 80 })
    expect(selected.nodes[2].position).toEqual({ x: 40, y: 50 })
    expect(workflow.nodes[0].position).toEqual({ x: 500, y: 300 })
  })

  it('detaches separately selected children using absolute positions', () => {
    const selected = buildWorkshopSelection(workflow, ['prompt', 'external'])
    expect(selected.nodes.every((node) => !node.parentId)).toBe(true)
    expect(selected.nodes.find((node) => node.id === 'prompt')?.position).toEqual({ x: 640, y: 460 })
    expect(selected.nodes.find((node) => node.id === 'external')?.position).toEqual({ x: 80, y: 80 })
    expect(selected.edges).toEqual([])
  })

  it('remaps nested parents and edges for each insertion and supports single-command undo', () => {
    const selected = buildWorkshopSelection(workflow, ['g'])
    let sequence = 0
    const first = instantiateWorkshopGraph(selected, () => `fresh-${++sequence}`, { x: 200, y: 900 })
    const second = instantiateWorkshopGraph(selected, () => `fresh-${++sequence}`, { x: 200, y: 1500 })
    const byOriginal = new Map(selected.nodes.map((node, index) => [node.id, first.nodes[index]]))
    expect(first.nodes[0].position).toEqual({ x: 200, y: 900 })
    expect(byOriginal.get('nested')?.parentId).toBe(byOriginal.get('g')?.id)
    expect(byOriginal.get('prompt')?.parentId).toBe(byOriginal.get('nested')?.id)
    expect(first.edges[0].source).toBe(byOriginal.get('prompt')?.id)
    expect(first.edges[0].target).toBe(byOriginal.get('image')?.id)
    expect(new Set([...first.nodes, ...first.edges, ...second.nodes, ...second.edges].map((entry) => entry.id)).size).toBe(10)
    const before = createCanvasHistory(createCanvasDocument())
    const inserted = applyCanvasCommand(before, { type: 'add-nodes', nodes: first.nodes.map((node) => ({ id: node.id, type: node.kind, definitionVersion: node.definitionVersion ?? 1, position: node.position, parentId: node.parentId, data: { ...node.data } })), edges: first.edges })
    expect(undoCanvasHistory(inserted).present.nodes).toEqual([])
    expect(redoCanvasHistory(undoCanvasHistory(inserted)).present.edges).toEqual(first.edges)
    expect(selected.nodes[0].id).toBe('g')
  })

  it('rejects empty structural selections and duplicate generated ids', () => {
    expect(() => buildWorkshopSelection({ ...workflow, nodes: [workflow.nodes[0]], edges: [] }, ['g'])).toThrow('内容节点')
    expect(() => instantiateWorkshopGraph(workflow, () => 'same')).toThrow('唯一')
  })

  it('preserves the new group container when saving the group selected after creation', () => {
    const content = [builtinNodeRegistry.create('prompt', 'a', { x: 100, y: 100 }), builtinNodeRegistry.create('image-generate', 'b', { x: 500, y: 100 })]
    const grouped = groupCanvasNodes(content, new Set(['a', 'b']), { groupId: 'new-group', title: '商品工作流' })!
    const saved = buildWorkshopSelection({ ...createEmptyWorkflow(), nodes: grouped.map((node) => ({ id: node.id, kind: node.type as WorkflowNode['kind'], definitionVersion: node.definitionVersion, parentId: node.parentId, position: node.position, data: { prompt: '', model: '', status: 'idle', settings: node.type === 'group' ? { title: '商品工作流' } : {} } })), edges: [{ id: 'edge', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' }] }, ['new-group'])
    expect(saved.nodes).toHaveLength(3)
    expect(saved.nodes.filter((node) => node.parentId === 'new-group')).toHaveLength(2)
    expect(saved.nodes[0].data.settings?.title).toBe('商品工作流')
    expect(saved.edges).toHaveLength(1)
  })
})

describe('canvas arrangement', () => {
  it('arranges selected peers without moving a locked node or an unselected sibling', () => {
    const a = builtinNodeRegistry.create('prompt', 'a', { x: 100, y: 200 })
    const b = { ...builtinNodeRegistry.create('prompt', 'b', { x: 700, y: 600 }), locked: true }
    const c = builtinNodeRegistry.create('prompt', 'c', { x: 900, y: 900 })
    const d = builtinNodeRegistry.create('prompt', 'd', { x: 1800, y: 1300 })
    const arranged = arrangeCanvasNodes([a, b, c, d], [], 'horizontal', ['a', 'b', 'c'])
    expect(arranged[1].position).toEqual(b.position)
    expect(arranged[2].position.y).toBe(200)
    expect(arranged[3].position).toEqual(d.position)
  })

  it('moves selected groups once without changing child coordinates and allows undo', () => {
    const group = builtinNodeRegistry.create('group', 'g', { x: 100, y: 100 })
    const child = { ...builtinNodeRegistry.create('prompt', 'child', { x: 20, y: 20 }), parentId: 'g' }
    const other = builtinNodeRegistry.create('prompt', 'other', { x: 700, y: 500 })
    const original = [group, child, other]
    const arranged = arrangeCanvasNodes(original, [], 'vertical', ['g', 'child', 'other'])
    expect(arranged[1].position).toEqual(child.position)
    expect(arranged[2].position.x).toBe(100)
    const history = createCanvasHistory({ ...createCanvasDocument(), nodes: original })
    const moved = applyCanvasCommand(history, { type: 'move-nodes', positions: Object.fromEntries(arranged.map((node) => [node.id, node.position])) })
    expect(undoCanvasHistory(moved).present.nodes).toEqual(original)
  })

  it('lays out selected chains in dependency order', () => {
    const nodes = [builtinNodeRegistry.create('prompt', 'text', { x: 900, y: 900 }), builtinNodeRegistry.create('image-generate', 'image', { x: 0, y: 0 })]
    const edges = [{ id: 'e', source: 'text', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' }]
    const arranged = arrangeCanvasNodes(nodes, edges, 'smart', ['text', 'image'])
    expect(arranged[0].position.x).toBeLessThan(arranged[1].position.x)
  })

  it.each(['horizontal', 'vertical', 'smart'] as const)('avoids locked rectangles during %s layout', (mode) => {
    const movable = builtinNodeRegistry.create('prompt', 'a', { x: 0, y: 200 })
    const locked = { ...builtinNodeRegistry.create('prompt', 'b', { x: 100, y: 0 }), locked: true }
    const arranged = arrangeCanvasNodes([movable, locked], [], mode, ['a', 'b'])
    expect(arranged[1].position).toEqual(locked.position)
    const [a, b] = arranged
    const overlaps = a.position.x < b.position.x + b.width! && a.position.x + a.width! > b.position.x && a.position.y < b.position.y + b.height! && a.position.y + a.height! > b.position.y
    expect(overlaps).toBe(false)
  })

  it.each(['horizontal', 'vertical', 'smart'] as const)('expands group extents atomically for %s child layout', (mode) => {
    const group = { ...builtinNodeRegistry.create('group', 'group', { x: 0, y: 0 }), width: 400, height: 400 }
    const children = ['a', 'b', 'c'].map((id, index) => ({ ...builtinNodeRegistry.create('image-generate', id, { x: 32, y: 96 + index * 320 }), parentId: group.id }))
    const original = [group, ...children]
    const arranged = arrangeCanvasNodes(original, [], mode, children.map((node) => node.id))
    const parent = arranged[0]
    for (const child of arranged.slice(1)) {
      expect(child.position.x + child.width! + 32).toBeLessThanOrEqual(parent.width!)
      expect(child.position.y + child.height! + 32).toBeLessThanOrEqual(parent.height!)
      expect(child.position.y).toBeGreaterThanOrEqual(96)
    }
    const history = createCanvasHistory({ ...createCanvasDocument(), nodes: original })
    const updated = applyCanvasCommand(history, { type: 'replace-nodes', nodes: arranged })
    expect(undoCanvasHistory(updated).present.nodes).toEqual(original)
  })

  it('refuses to overflow locked parent extents without mutating the graph', () => {
    const group = { ...builtinNodeRegistry.create('group', 'group', { x: 0, y: 0 }), width: 400, height: 800, locked: true }
    const children = ['a', 'b'].map((id, index) => ({ ...builtinNodeRegistry.create('prompt', id, { x: 32, y: 96 + index * 240 }), parentId: group.id }))
    const nodes = [group, ...children]
    const before = structuredClone(nodes)
    expect(() => arrangeCanvasNodes(nodes, [], 'horizontal', ['a', 'b'])).toThrow('锁定分组')
    expect(nodes).toEqual(before)
  })
})
