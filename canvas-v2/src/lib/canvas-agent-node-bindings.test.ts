import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, type NodeKind, type WorkflowNode } from '../model'
import { defaultImageTransformRecipe } from '../image-tools/recipe'
import { assertCanvasAgentNodeBindings, canvasAgentInputSourcesContext, resolveCanvasAgentModelSettings } from './canvas-agent-node-bindings'

function node(id: string, kind: NodeKind, settings: Record<string, unknown> = {}): WorkflowNode {
  return { id, kind, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings } }
}
function fixture() {
  const a = node('a', 'image-input'), b = node('b', 'image-input'), route = node('route', 'router', { routerStrategy: { version: 1, strategy: 'all' } })
  a.data.result = { kind: 'image', assetId: 'a'.repeat(43), localUrl: '/a' }; b.data.result = { kind: 'image', assetId: 'b'.repeat(43), localUrl: '/b' }
  const collage = node('collage', 'image-collage', { imageTransform: { ...defaultImageTransformRecipe('collage'), layout: 'template-balanced' } })
  const edges = [
    { id: 'b-route', source: 'b', sourceHandle: 'out:image', target: 'route', targetHandle: 'in:images' },
    { id: 'a-route', source: 'a', sourceHandle: 'out:image', target: 'route', targetHandle: 'in:images' },
    { id: 'routed', source: 'route', sourceHandle: 'out:image', target: 'collage', targetHandle: 'in:images' },
  ]
  return { a, b, route, collage, workflow: { ...createEmptyWorkflow('Routed'), nodes: [a, b, route, collage], edges } }
}

describe('Agent actual router image positions', () => {
  it('resolves the second typed all-router output and validates the fixed two-image resulting graph', () => {
    const f = fixture(), before = structuredClone(f.workflow)
    const settings = resolveCanvasAgentModelSettings({ imageCollageInputOrder: { version: 1, slots: [1, 0].map((outputIndex) => ({ source: 's0', sourceHandle: 'out:image', outputIndex })) } }, f.collage, new Map([['s0', f.route], ['s1', f.a], ['s2', f.b]]), f.workflow.edges)
    expect(settings.imageCollageInputOrder?.slots).toEqual([{ edgeId: 'routed', outputIndex: 1 }, { edgeId: 'routed', outputIndex: 0 }])
    expect(() => assertCanvasAgentNodeBindings(f.collage, f.workflow, settings)).not.toThrow()
    expect(f.workflow).toEqual(before)
    f.route.data.settings!.routerStrategy = { version: 1, strategy: 'first-available' }
    expect(() => assertCanvasAgentNodeBindings(f.collage, f.workflow, settings)).toThrow('图片输入或批次已变化')
  })
  it('keeps selected router counts unknown when the authorizing context omits upstream private nodes', () => {
    const f = fixture()
    expect(canvasAgentInputSourcesContext(f.collage, f.workflow, [f.route, f.a, f.b])[0]).toMatchObject({ source: 's0', imageStartIndex: 0, imageCount: 2 })
    expect(canvasAgentInputSourcesContext(f.collage, f.workflow, [f.route])[0]).toMatchObject({ source: 's0', imageStartIndex: 0, imageCount: null })
    expect(() => resolveCanvasAgentModelSettings({ imageCollageInputOrder: { version: 1, slots: [{ source: 's0', sourceHandle: 'out:image', outputIndex: 1 }] } }, f.collage, new Map([['s0', f.route]]), f.workflow.edges)).toThrow('不能猜测')
  })
})
