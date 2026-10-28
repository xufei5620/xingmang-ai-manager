import { describe, expect, it } from 'vitest'
import { editorNodeToCanvasNode, toCanvasNode, toCanvasRunGraph, toWorkflowNode, workflowNodeData } from '../App'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow } from '../model'

const marker = { version: 1 as const, strategy: 'first-available' as const }
function node(settings: Record<string, unknown>) { return { id: 'route', kind: 'router' as const, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle' as const, settings } } }

describe('actual App versioned router graph boundary', () => {
  it('adds the new strategy only for an explicitly fresh node and preserves old template interpretation', () => {
    expect(workflowNodeData('router', {}, true).settings?.routerStrategy).toEqual(marker)
    expect(workflowNodeData('router', { strategy: 'first-available' }).settings?.routerStrategy).toBeUndefined()
    expect(workflowNodeData('router', {}).settings?.routerStrategy).toBeUndefined()
    expect(workflowNodeData('router', { routerStrategy: marker }).settings?.routerStrategy).toEqual(marker)
  })
  it('preserves legacy settings across editor hydration, persistence and run translation', () => {
    const original = node({ strategy: 'first-available' }), restored = editorNodeToCanvasNode({ ...original, type: original.kind })
    expect(toWorkflowNode(restored).data.settings).toEqual(original.data.settings)
    expect(toCanvasRunGraph([restored], [], { image: '', video: '' }).nodes[0].data.routerStrategy).toBeUndefined()
  })
  it('roundtrips the explicit mode into the real run graph and retains original incoming edge order', () => {
    const original = { ...createEmptyWorkflow('New router'), nodes: [node({ routerStrategy: marker })] }, parsed = parseWorkflowFile(serializeWorkflow(original))!
    expect(parsed.nodes[0].data.settings?.routerStrategy).toEqual(marker)
    const sourceA = { ...node({}), id: 'a', kind: 'prompt' as const }, sourceB = { ...node({}), id: 'b', kind: 'prompt' as const }
    const edges = [{ id: 'z-first', source: 'b', sourceHandle: 'out:text', target: 'route', targetHandle: 'in:text' }, { id: 'a-second', source: 'a', sourceHandle: 'out:text', target: 'route', targetHandle: 'in:text' }]
    const graph = toCanvasRunGraph([sourceA, sourceB, ...parsed.nodes].map(toCanvasNode), edges, { image: '', video: '' })
    expect(graph.nodes.find((entry) => entry.id === 'route')?.data.routerStrategy).toEqual(marker)
    expect(graph.edges.map((edge) => edge.id)).toEqual(['z-first', 'a-second'])
  })
  it.each([null, false, { version: 2, strategy: 'all' }, { version: 1, strategy: 'other' }])('rejects invalid editor mode %s before run translation can erase it', (value) => {
    expect(() => toCanvasRunGraph([toCanvasNode(node({ routerStrategy: value }))], [], { image: '', video: '' })).toThrow()
  })
})
