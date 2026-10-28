import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, type WorkflowNode } from '../model'
import { buildResourceTree, resourceSelectionIds, resourceGroupSelectionIds, buildResourceExportWorkflow, type ResourceNode } from './resource-tree-model'
import { groupCanvasNodes, validateParentGraph } from '../editor/grouping'
import { createCanvasHistory, applyCanvasCommand, undoCanvasHistory, redoCanvasHistory } from '../store/history'
import { createCanvasDocument } from '../store/canvas-state'
import { parseWorkflowFile, serializeWorkflow } from '../model'
import { workflowAssetReferences } from '../lib/workflow-import'

function resource(id: string, parentId?: string, type = 'prompt', title = id): ResourceNode { return { id, type, ...(parentId ? { parentId } : {}), data: { settings: { title } } } }
function workflowNode(id: string, parentId?: string, kind: WorkflowNode['kind'] = 'prompt'): WorkflowNode {
  return { id, kind, definitionVersion: 1, ...(parentId ? { parentId } : {}), position: { x: 20, y: 30 }, data: { prompt: id, model: '', status: 'idle', settings: { title: id } } }
}

describe('canvas resource tree', () => {
  const nodes = [resource('g', undefined, 'group'), resource('a', 'g'), resource('g2', 'g', 'group'), resource('b', 'g2', 'image-input'), resource('c')]
  it('derives nested document order and folds only the displayed descendants', () => {
    const tree = buildResourceTree(nodes)
    expect(tree.rows.map((row) => [row.id, row.depth])).toEqual([['g', 0], ['a', 1], ['g2', 1], ['b', 2], ['c', 0]])
    expect(tree.topLevelCount).toBe(2)
    expect(tree.rows[0].childCount).toBe(2)
    expect(buildResourceTree(nodes, '', '', new Set(['g'])).rows.map((row) => row.id)).toEqual(['g', 'c'])
    expect(nodes).toHaveLength(5)
  })
  it('retains only matches and their ancestors, opening ancestors temporarily during search', () => {
    expect(buildResourceTree(nodes, 'b', '', new Set(['g', 'g2'])).rows.map((row) => row.id)).toEqual(['g', 'g2', 'b'])
    expect(buildResourceTree(nodes, '', 'image-input').rows.map((row) => row.id)).toEqual(['g', 'g2', 'b'])
    expect(buildResourceTree(nodes, 'g2').rows.map((row) => row.id)).toEqual(['g', 'g2'])
    expect(buildResourceTree(nodes, 'absent').rows).toEqual([])
  })
  it('matches custom names and IDs while tolerating unknown and malformed legacy groups', () => {
    const legacy = [resource('n-id', 'missing', 'future-kind', '产品主图'), resource('cycle-a', 'cycle-b', 'group'), resource('cycle-b', 'cycle-a', 'group')]
    expect(buildResourceTree(legacy, '产品').rows.map((row) => row.id)).toEqual(['n-id'])
    expect(buildResourceTree(legacy, 'N-ID').rows[0].title).toBe('产品主图')
    expect(buildResourceTree(legacy).rows).toHaveLength(3)
  })
  it('supports replace, modifier toggle and range selection without selecting collapsed descendants', () => {
    expect(resourceSelectionIds(['a'], ['g', 'c'], 'c', {})).toEqual(['c'])
    expect(resourceSelectionIds(['a'], ['g', 'c'], 'c', { toggle: true })).toEqual(['a', 'c'])
    expect(resourceSelectionIds(['c'], ['g', 'c'], 'c', { toggle: true })).toEqual([])
    expect(resourceSelectionIds(['a'], ['g', 'c'], 'c', { range: true, anchor: 'g' })).toEqual(['g', 'c'])
    expect(resourceSelectionIds(['a'], ['g', 'c'], 'c', { range: true, toggle: true, anchor: 'g' })).toEqual(['a', 'g', 'c'])
    expect(resourceSelectionIds(['a'], ['g', 'c'], 'c', { range: true, anchor: 'gone' })).toEqual(['c'])
  })
  it('groups selected sibling roots once, keeping descendants in their original group', () => {
    expect(resourceGroupSelectionIds(nodes, ['g', 'a', 'b', 'c'])).toEqual(['g', 'c'])
    expect(resourceGroupSelectionIds(nodes, ['a', 'g2'])).toEqual(['a', 'g2'])
    expect(resourceGroupSelectionIds(nodes, ['a', 'c'])).toEqual([])
    expect(resourceGroupSelectionIds(nodes, ['g', 'a'])).toEqual([])
  })
})

describe('resource scoped project packages', () => {
  const workflow = { ...createEmptyWorkflow('完整项目'), nodes: [workflowNode('g', undefined, 'group'), workflowNode('a', 'g'), workflowNode('g2', 'g', 'group'), workflowNode('b', 'g2', 'image-input'), workflowNode('private')], edges: [
    { id: 'internal', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' },
    { id: 'external', source: 'private', sourceHandle: 'out:text', target: 'a', targetHandle: 'in:text' },
  ] }
  it('exports group descendants and internal wires without unselected node content', () => {
    const original = structuredClone(workflow)
    const exported = buildResourceExportWorkflow(workflow, ['g'])
    expect(exported.nodes.map((node) => node.id)).toEqual(['g', 'a', 'g2', 'b'])
    expect(exported.edges.map((edge) => edge.id)).toEqual(['internal'])
    expect(exported.name).toBe('g')
    expect(JSON.stringify(exported)).not.toContain('private')
    expect(workflow).toEqual(original)
  })
  it('detaches selected nested children with absolute coordinates and preserves actual assets', () => {
    const source = structuredClone(workflow)
    source.nodes[3].data.result = { kind: 'image', assetId: 'a'.repeat(43), mimeType: 'image/png', width: 512, height: 512 }
    const exported = buildResourceExportWorkflow(source, ['b'])
    expect(exported.nodes[0].parentId).toBeUndefined()
    expect(exported.nodes[0].position).toEqual({ x: 60, y: 90 })
    expect(exported.nodes[0].data.result).toEqual(source.nodes[3].data.result)
    expect(exported.edges).toEqual([])
    const loaded = parseWorkflowFile(serializeWorkflow(exported))!
    expect(loaded.nodes[0].data.result?.assetId).toBe('a'.repeat(43))
    expect(loaded.nodes[0].parentId).toBeUndefined()
  })
  it('detaches a selected subgroup at its absolute location while keeping its children relative', () => {
    const exported = buildResourceExportWorkflow(workflow, ['g2'])
    expect(exported.nodes.map((node) => node.id)).toEqual(['g2', 'b'])
    expect(exported.nodes[0].parentId).toBeUndefined()
    expect(exported.nodes[0].position).toEqual({ x: 40, y: 60 })
    expect(exported.nodes[1].parentId).toBe('g2')
    expect(exported.nodes[1].position).toEqual({ x: 20, y: 30 })
  })
  it('preserves the selected ordered multi-image batch without leaking another node result', () => {
    const source = structuredClone(workflow)
    const selected = source.nodes[3]
    selected.kind = 'image-grid-split'
    selected.data.result = { kind: 'image', assetId: 'b'.repeat(43) }
    selected.data.candidateAssetIds = ['a'.repeat(43), 'b'.repeat(43), 'c'.repeat(43)]
    source.nodes[4].data.result = { kind: 'image', assetId: 'z'.repeat(43) }
    const exported = parseWorkflowFile(serializeWorkflow(buildResourceExportWorkflow(source, ['g2'])))!
    expect(exported.nodes.find((node) => node.id === 'b')?.data.candidateAssetIds).toEqual(selected.data.candidateAssetIds)
    expect([...workflowAssetReferences(exported).keys()].sort()).toEqual(['a'.repeat(43), 'b'.repeat(43), 'c'.repeat(43)])
    expect(JSON.stringify(exported)).not.toContain('z'.repeat(43))
  })
  it('marks cut input chains stale while preserving the selected historical results', () => {
    const exported = buildResourceExportWorkflow(workflow, ['g'])
    expect(exported.nodes.filter((node) => node.data.dirty).map((node) => node.id)).toEqual(['a', 'b'])
    expect(workflow.nodes.every((node) => !node.data.dirty)).toBe(true)
  })
  it('does not duplicate descendants when both a group and its child are selected', () => {
    expect(buildResourceExportWorkflow(workflow, ['g', 'b']).nodes).toHaveLength(4)
    expect(() => buildResourceExportWorkflow(workflow, [])).toThrow('请先选择')
    expect(() => buildResourceExportWorkflow(workflow, ['missing'])).toThrow('请先选择')
  })
})

describe('resource mutations use document history', () => {
  it('preserves existing group configuration when grouping another group or siblings', () => {
    const existing = { id: 'existing', type: 'group', definitionVersion: 1, position: { x: 100, y: 200 }, data: { prompt: '', model: '', status: 'idle', settings: { title: '已命名分组', color: '#f0a050' } } }
    const nodes = [existing, { ...existing, id: 'sibling', type: 'prompt', position: { x: 500, y: 200 }, data: { ...existing.data, settings: { title: '提示词' } } }]
    const grouped = groupCanvasNodes(nodes, new Set(['existing', 'sibling']), { groupId: 'new' })!
    expect(grouped.find((node) => node.id === 'existing')?.data).toEqual(existing.data)
    expect(grouped.find((node) => node.id === 'existing')?.parentId).toBe('new')
    expect(buildResourceTree(grouped).rows.map((row) => row.title)).toEqual(['分组', '已命名分组', '提示词'])
  })
  it('renames, locks and groups through real commands with one-step undo and redo', () => {
    const nodes = [resource('a'), resource('b')].map((node) => ({ ...node, type: 'prompt', definitionVersion: 1, position: { x: node.id === 'a' ? 0 : 300, y: 0 } }))
    let history = createCanvasHistory({ ...createCanvasDocument(), nodes })
    history = applyCanvasCommand(history, { type: 'update-node-data', nodeId: 'a', patch: { settings: { title: '改名后' } } })
    expect(buildResourceTree(history.present.nodes).rows[0].title).toBe('改名后')
    expect(buildResourceTree(undoCanvasHistory(history).present.nodes).rows[0].title).toBe('a')
    history = applyCanvasCommand(history, { type: 'set-node-flags', nodeIds: ['a', 'b'], locked: true })
    expect(history.present.nodes.every((node) => node.locked)).toBe(true)
    expect(undoCanvasHistory(history).present.nodes.every((node) => !node.locked)).toBe(true)
    const grouped = groupCanvasNodes(history.present.nodes, new Set(['a', 'b']), { groupId: 'g' })!
    expect(validateParentGraph(grouped)).toBe(true)
    history = applyCanvasCommand(history, { type: 'replace-nodes', nodes: grouped })
    expect(history.present.nodes).toHaveLength(3)
    const undone = undoCanvasHistory(history)
    expect(undone.present.nodes).toHaveLength(2)
    expect(undone.present.nodes.every((node) => !node.parentId && node.locked)).toBe(true)
    expect(redoCanvasHistory(undone).present.nodes.map((node) => node.parentId)).toEqual([undefined, 'g', 'g'])
  })
})
