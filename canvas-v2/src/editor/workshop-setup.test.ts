import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph } from '../host'
import { defaultImageTransformRecipe } from '../image-tools/recipe'
import { buildCanvasRunPreflight } from '../runtime/run-preflight'
import { buildWorkshopSetup, type WorkshopSetupInput, type WorkshopSetupNode } from './workshop-setup'

function graphNode(id: string, kind: string, data: Partial<CanvasRunGraph['nodes'][number]['data']> = {}): CanvasRunGraph['nodes'][number] {
  return { id, kind, definitionVersion: 1, data: { prompt: '', model: '', ...data } }
}
function metadata(graph: CanvasRunGraph): WorkshopSetupNode[] {
  return graph.nodes.map((node) => ({ id: node.id, kind: node.kind, data: { prompt: node.data.prompt } }))
}
function inspect(graph: CanvasRunGraph, changes: Partial<WorkshopSetupInput> = {}) {
  return buildWorkshopSetup({ graph, nodes: metadata(graph), scope: { kind: 'all' }, configuration: { imageModels: ['gpt-image-1'], videoModels: [], textModels: ['gpt-4.1'] }, ...changes })
}
function localSequence(): CanvasRunGraph {
  const collage = defaultImageTransformRecipe('collage')
  if (collage.kind !== 'collage') throw new Error('Expected collage recipe')
  return { nodes: [graphNode('video', 'video-input'), ...[0, 1, 2].map((time) => graphNode(`frame-${time}`, 'frame-extract', { frameTimestampSeconds: time })), graphNode('collage', 'image-collage', { imageTransform: { ...collage, rows: 1, columns: 3 } }), graphNode('output', 'output')], edges: [
    ...[0, 1, 2].map((time) => ({ id: `video-${time}`, source: 'video', sourceHandle: 'out:video', target: `frame-${time}`, targetHandle: 'in:video' })),
    ...[0, 1, 2].map((time) => ({ id: `image-${time}`, source: `frame-${time}`, sourceHandle: 'out:image', target: 'collage', targetHandle: 'in:images' })),
    { id: 'final', source: 'collage', sourceHandle: 'out:image', target: 'output', targetHandle: 'in:image' },
  ] }
}

describe('current workshop setup', () => {
  it('converges media text and actual model configuration after current graph changes', () => {
    const graph: CanvasRunGraph = { nodes: [graphNode('image', 'image-input'), graphNode('prompt', 'prompt'), graphNode('generation', 'image-generate', { model: 'gpt-image-1', size: '1024x1024' })], edges: [
      { id: 'image-input', source: 'image', sourceHandle: 'out:image', target: 'generation', targetHandle: 'in:images' },
      { id: 'prompt-input', source: 'prompt', sourceHandle: 'out:text', target: 'generation', targetHandle: 'in:text' },
    ] }
    const empty = inspect(graph)
    expect(empty.canReviewRun).toBe(false)
    expect(empty.items.map((item) => item.category)).toEqual(['media', 'prompt', 'prompt', 'configuration'])
    graph.nodes[0].data.adoptedAssetId = 'owned-image'
    graph.nodes[1].data.prompt = '原创海报'
    const prepared = inspect(graph, { configuration: { imageGroup: 'images', imageModels: ['gpt-image-1'], videoModels: [] }, assetStates: { 'owned-image': { state: 'available' } } })
    expect(prepared.items).toEqual([])
    expect(prepared.canReviewRun).toBe(true)
    expect(prepared.preflight?.paidRequestCount).toBe(1)
    graph.nodes[1].data.prompt = ''
    expect(inspect(graph).items.some((item) => item.nodeId === 'prompt' && item.action === 'edit-prompt')).toBe(true)
  })
  it('permits the six-node local video frame collage after binding without account model loading', () => {
    const graph = localSequence()
    const initial = inspect(graph)
    expect(initial.items.filter((item) => item.blocking).map((item) => item.nodeId)).toEqual(['video'])
    expect(initial.canReviewRun).toBe(false)
    graph.nodes[0].data.adoptedAssetId = 'owned-video'
    const prepared = inspect(graph, { assetStates: { 'owned-video': { state: 'available' } } })
    expect(prepared.canReviewRun).toBe(true)
    expect(prepared.nodeIds).toHaveLength(6)
    expect(prepared.preflight?.paidRequestCount).toBe(0)
    expect(prepared.readyNodeCount).toBe(6)
    expect(prepared.items).toEqual([])
  })
  it('discloses unchecked and checking assets without claiming readability or blocking local review', () => {
    const graph = localSequence()
    graph.nodes[0].data.adoptedAssetId = 'owned-video'
    const unknown = inspect(graph)
    expect(unknown.canReviewRun).toBe(true)
    expect(unknown.items).toEqual([expect.objectContaining({ action: 'check-asset', assetId: 'owned-video', blocking: false })])
    expect(unknown.items[0].message).toContain('将在运行时核对')
    expect(unknown.blockingCount).toBe(0)
    expect(unknown.noticeCount).toBe(1)
    expect(inspect(graph, { assetStates: { 'owned-video': { state: 'checking' } } }).canReviewRun).toBe(true)
  })
  it('blocks explicitly missing and failed assets until rebinding or a successful check', () => {
    const graph = localSequence()
    graph.nodes[0].data.adoptedAssetId = 'owned-video'
    const missing = inspect(graph, { assetStates: { 'owned-video': { state: 'missing' } } })
    expect(missing.items[0]).toMatchObject({ action: 'pick-asset', assetId: 'owned-video', blocking: true })
    expect(missing.canReviewRun).toBe(false)
    const failed = inspect(graph, { assetStates: { 'owned-video': { state: 'failed', message: '读取失败，请重试' } } })
    expect(failed.items[0]).toMatchObject({ action: 'check-asset', blocking: true, message: '读取失败，请重试' })
    expect(failed.canReviewRun).toBe(false)
    expect(inspect(graph, { assetStates: { 'owned-video': { state: 'available' } } }).canReviewRun).toBe(true)
  })
  it('expands nested group selection and includes upstream dependencies without unrelated downstream nodes', () => {
    const graph: CanvasRunGraph = { nodes: [graphNode('source', 'prompt', { prompt: '已填写' }), graphNode('child', 'text-generate', { model: 'gpt-4.1', group: 'text' }), graphNode('unrelated', 'image-input')], edges: [{ id: 'text', source: 'source', sourceHandle: 'out:text', target: 'child', targetHandle: 'in:text' }] }
    const nodes = metadata(graph).map((node) => node.id === 'child' ? { ...node, parentId: 'inner' } : node)
    nodes.push({ id: 'outer', kind: 'group', data: { prompt: '' } }, { id: 'inner', kind: 'group', parentId: 'outer', data: { prompt: '' } })
    const setup = inspect(graph, { nodes, scope: { kind: 'selection', nodeIds: ['outer'] } })
    expect(setup.scopeNodeIds).toEqual(['child', 'outer', 'inner'])
    expect(setup.nodeIds).toEqual(['source', 'child'])
    expect(setup.items).toEqual([])
    expect(setup.canReviewRun).toBe(true)
  })
  it('keeps inserted scope identities across removal undo and redo', () => {
    const graph: CanvasRunGraph = { nodes: [graphNode('prompt', 'prompt', { prompt: '自编正文' })], edges: [] }
    const scope = { kind: 'inserted' as const, nodeIds: ['prompt', 'prompt'] }
    expect(inspect(graph, { scope }).canReviewRun).toBe(true)
    const removed = inspect({ nodes: [], edges: [] }, { scope })
    expect(removed.missingNodeIds).toEqual(['prompt'])
    expect(removed.scope).toEqual(scope)
    expect(removed.canReviewRun).toBe(false)
    expect(inspect(graph, { scope }).missingNodeIds).toEqual([])
    expect(inspect(graph, { scope }).canReviewRun).toBe(true)
  })
  it('does not silently discard missing members while other inserted nodes remain', () => {
    const graph: CanvasRunGraph = { nodes: [graphNode('kept', 'prompt', { prompt: '已填写' })], edges: [] }
    const setup = inspect(graph, { scope: { kind: 'inserted', nodeIds: ['kept', 'removed'] } })
    expect(setup.nodeIds).toEqual(['kept'])
    expect(setup.missingNodeIds).toEqual(['removed'])
    expect(setup.canReviewRun).toBe(false)
  })
  it('inherits nested parent locks without looping on malformed parent relationships', () => {
    const graph: CanvasRunGraph = { nodes: [graphNode('child', 'image-input')], edges: [] }
    const nodes: WorkshopSetupNode[] = [{ ...metadata(graph)[0], parentId: 'inner' }, { id: 'inner', kind: 'group', parentId: 'outer', data: { prompt: '' } }, { id: 'outer', kind: 'group', locked: true, data: { prompt: '' } }]
    expect(inspect(graph, { nodes }).items[0].locked).toBe(true)
    nodes[2].locked = false
    nodes[2].parentId = 'inner'
    expect(inspect(graph, { nodes }).items[0].locked).toBeUndefined()
  })
  it('uses shared preflight for disabled branches and excludes them from preparation', () => {
    const graph: CanvasRunGraph = { nodes: [{ ...graphNode('disabled', 'prompt', { prompt: '不可用正文' }), disabled: true }, graphNode('child', 'text-generate'), graphNode('enabled', 'prompt', { prompt: '独立正文' })], edges: [{ id: 'text', source: 'disabled', sourceHandle: 'out:text', target: 'child', targetHandle: 'in:text' }] }
    const setup = inspect(graph)
    expect(setup.skippedNodeCount).toBe(2)
    expect(setup.items).toEqual([])
    expect(setup.nodeIds).toEqual(['disabled', 'child', 'enabled'])
    expect(setup.readyNodeCount).toBe(1)
    graph.nodes[2].disabled = true
    expect(inspect(graph).canReviewRun).toBe(false)
  })
  it('requires a compatible text input rather than treating any connected prompt as content', () => {
    const graph: CanvasRunGraph = { nodes: [graphNode('source', 'prompt', { prompt: '来源正文' }), graphNode('generation', 'image-generate', { model: 'gpt-image-1', group: 'images', size: '1024x1024' })], edges: [{ id: 'wrong-input', source: 'source', sourceHandle: 'out:text', target: 'generation', targetHandle: 'in:images' }] }
    expect(inspect(graph).items.find((item) => item.nodeId === 'generation' && item.action === 'edit-prompt')).toBeDefined()
    graph.edges[0].targetHandle = 'in:text'
    expect(inspect(graph).items.find((item) => item.nodeId === 'generation' && item.action === 'edit-prompt')).toBeUndefined()
  })
  it('shares current invalid parameter reasons rather than accepting template-only model hints', () => {
    const graph = localSequence()
    graph.nodes[0].data.adoptedAssetId = 'owned-video'
    graph.nodes[1].data.frameTimestampSeconds = -1
    const setup = inspect(graph)
    const original = buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: ['gpt-image-1'], videoModels: [], textModels: ['gpt-4.1'] })
    expect(setup.preflight).toEqual(original)
    expect(setup.items.find((item) => item.nodeId === 'frame-0')).toMatchObject({ action: 'inspect-node', message: original.items.find((item) => item.nodeId === 'frame-0')?.reason })
    expect(setup.canReviewRun).toBe(false)
  })
  it('reports cyclic graph errors and preserves the source snapshot', () => {
    const graph: CanvasRunGraph = { nodes: [graphNode('a', 'prompt'), graphNode('b', 'prompt')], edges: [{ id: 'a-b', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' }, { id: 'b-a', source: 'b', sourceHandle: 'out:text', target: 'a', targetHandle: 'in:text' }] }
    const before = structuredClone(graph)
    expect(inspect(graph).error).toContain('循环')
    expect(inspect(graph).canReviewRun).toBe(false)
    expect(graph).toEqual(before)
  })
  it('keeps empty selections empty instead of implicitly checking all nodes', () => {
    const graph: CanvasRunGraph = { nodes: [graphNode('prompt', 'prompt', { prompt: '正文' })], edges: [] }
    expect(inspect(graph, { scope: { kind: 'selection', nodeIds: [] } })).toMatchObject({ nodeIds: [], scopeNodeIds: [], items: [], canReviewRun: false })
  })
  it('preserves custom human titles and stable action identities after other requirements disappear', () => {
    const graph: CanvasRunGraph = { nodes: [graphNode('a', 'image-input'), graphNode('b', 'prompt')], edges: [] }
    const nodes = metadata(graph)
    nodes[1].data.settings = { title: '  产品说明  ' }
    const before = inspect(graph, { nodes }).items.find((item) => item.nodeId === 'b')!
    graph.nodes[0].data.adoptedAssetId = 'bound'
    const after = inspect(graph, { nodes, assetStates: { bound: { state: 'available' } } }).items.find((item) => item.nodeId === 'b')!
    expect(after.nodeTitle).toBe('产品说明')
    expect(after.id).toBe(before.id)
  })
})
