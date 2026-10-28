import { describe, expect, it, vi } from 'vitest'
import { editorNodeToCanvasNode, toCanvasNode, toCanvasRunGraph, toWorkflowNode, workflowNodeData } from '../App'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowFile } from '../model'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { toPersistedWorkflowV2 } from '../persistence/workflow-schema'
import { sanitizeWorkflowV2 } from '../persistence/workflow-sanitizer'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { analyzeWorkshopReadiness } from '../lib/workshop-readiness'
import { buildWorkshopTransferFile, parseWorkshopTransferFile, serializeWorkshopTransferFile } from '../lib/workshop-transfer-format'
import { instantiateWorkshopGraph } from '../editor/workshop-graph'
import { buildCanvasRunPreflight } from '../runtime/run-preflight'
import { createHostExecutors } from '../engine/executors'
import { parseNodeImageEditMask, resolveImageMaskSource, imageMaskConfigurationError } from './image-mask-workflow'
import { portableImageEditMask, type ImageEditMask } from './image-edit-mask'

const first = 'a'.repeat(43), selected = 'b'.repeat(43)
function recipe(): ImageEditMask { return { version: 1, sourceAssetId: selected, width: 384, height: 256, strokes: [{ tool: 'brush', size: .1, points: Array.from({ length: 300 }, (_, i) => ({ x: i / 300, y: .5 })) }] } }
function workflow(): WorkflowFile {
  return { ...createEmptyWorkflow('Mask'), nodes: [
    { id: 'source', kind: 'image-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'succeeded', result: { kind: 'image', assetId: selected, localUrl: `xingmang-asset://image/${selected}`, width: 384, height: 256 } } },
    { id: 'edit', kind: 'image-edit', definitionVersion: 1, position: { x: 500, y: 0 }, data: { prompt: 'Change the handle', model: 'gpt-image-1', status: 'idle', imageCandidateCount: 3, settings: { imageEditMask: recipe() } } },
  ], edges: [{ id: 'edge', source: 'source', sourceHandle: 'out:image', target: 'edit', targetHandle: 'in:images' }] }
}

describe('image mask configuration chain', () => {
  it('preserves over 256 points through editor hydration, save, refresh, and actual run graph without a second top-level field', () => {
    const original = workflow()
    const live = original.nodes.map(toCanvasNode).map((node) => editorNodeToCanvasNode(canvasNodeDocumentRecord(node)))
    const saved = parseWorkflowFile(serializeWorkflow({ ...original, nodes: live.map(toWorkflowNode) }))!
    expect(saved.nodes[1].data.settings?.imageEditMask).toEqual(recipe())
    expect(saved.nodes[1].data).not.toHaveProperty('imageEditMask')
    expect(workflowNodeData('image-edit', { imageEditMask: recipe() }).settings?.imageEditMask).toEqual(recipe())
    const graph = toCanvasRunGraph(live, original.edges, { image: 'provider', video: '' })
    expect(graph.nodes[1].data.imageEditMask).toEqual(recipe())
    expect(buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: ['gpt-image-1'], videoModels: [] })).toMatchObject({ canStart: true, imageRequestCount: 3 })
  })

  it.each(['node', 'group'] as const)('keeps a portable editable recipe through %s workshop file import, requiring explicit source adaptation', (kind) => {
    const original = workflow()
    if (kind === 'node') { original.nodes = [original.nodes[1]]; original.edges = [] }
    const clean = sanitizeWorkshopWorkflow(original, kind, 'Mask recipe')
    const mask = clean.nodes.find((node) => node.kind === 'image-edit')!.data.settings?.imageEditMask
    expect(mask).toEqual(portableImageEditMask(recipe()))
    expect(JSON.stringify(clean)).not.toContain(selected)
    const transfer = buildWorkshopTransferFile({ kind, name: 'Mask recipe', description: '', category: 'general', tags: [], nodeCount: clean.nodes.length, edgeCount: clean.edges.length, nodeKinds: clean.nodes.map((node) => node.kind), workflow: clean }, { kind: 'personal' })
    const imported = parseWorkshopTransferFile(serializeWorkshopTransferFile(transfer))
    let id = 0
    const instance = instantiateWorkshopGraph(imported.snapshot.workflow!, () => `inserted-${++id}`)
    expect(instance.nodes.find((node) => node.kind === 'image-edit')!.data.settings?.imageEditMask).toEqual(mask)
    expect(analyzeWorkshopReadiness(clean).requirements.some((entry) => entry.message.includes('确认适配当前原图'))).toBe(true)
    expect(imageMaskConfigurationError(mask, 'image-edit', 'gpt-image-1', [{ assetId: selected }], true)).toContain('绑定当前原图')
  })

  it.each([null, {}, { ...recipe(), version: 2 }, { ...recipe(), width: 0 }, { ...recipe(), strokes: [{ tool: 'brush', size: 0, points: [] }] }])('rejects malformed masks at all file boundaries instead of stripping them', (mask) => {
    const original = workflow(); original.nodes[1].data.settings = { imageEditMask: mask }
    expect(() => toPersistedWorkflowV2(original)).toThrow()
    expect(sanitizeWorkflowV2(original)).toBeNull()
    expect(parseWorkflowFile(JSON.stringify(original))).toBeNull()
    expect(() => sanitizeWorkshopWorkflow(original, 'group', 'Bad mask')).toThrow()
  })

  it.each(['image-generate', 'prompt', 'image-input', 'unknown'] as const)('rejects masks on unrelated %s nodes', (kind) => {
    const original = workflow(); original.nodes[1].kind = kind
    expect(() => parseNodeImageEditMask(kind, recipe())).toThrow('只能')
    expect(() => toPersistedWorkflowV2(original)).toThrow('只能')
    expect(sanitizeWorkflowV2(original)).toBeNull()
    expect(() => sanitizeWorkshopWorkflow(original, 'group', 'Bad kind')).toThrow()
  })

  it('resolves exactly the selected second candidate and blocks whole-group or multi-gallery input', () => {
    const original = workflow(), nodes = original.nodes.map(toCanvasNode)
    nodes[0].type = 'image-generate'
    nodes[0].data.candidateAssetIds = [first, selected]
    expect(resolveImageMaskSource(nodes, original.edges, 'source', 'output').asset.assetId).toBe(selected)
    expect(resolveImageMaskSource(nodes, original.edges, 'edit', 'input').asset.assetId).toBe(selected)
    expect(() => resolveImageMaskSource(nodes, [{ ...original.edges[0], sourceHandle: 'out:images' }], 'edit', 'input')).toThrow('唯一图片')
    nodes[0].type = 'gallery'
    expect(() => resolveImageMaskSource(nodes, original.edges, 'source', 'output')).toThrow('画廊含多张')
  })

  it('blocks stale or unsupported masks before costs, including erased, unbound and batch inputs', () => {
    const original = workflow(), initial = toCanvasRunGraph(original.nodes.map(toCanvasNode), original.edges, { image: 'provider', video: '' })
    for (const change of [
      (graph: typeof initial) => { graph.nodes[0].data.adoptedAssetId = first },
      (graph: typeof initial) => { graph.nodes[1].data.model = 'dall-e-2' },
      (graph: typeof initial) => { graph.nodes[1].data.imageEditMask = portableImageEditMask(recipe()) },
      (graph: typeof initial) => { graph.edges[0].sourceHandle = 'out:images' },
      (graph: typeof initial) => { graph.nodes[1].data.imageEditMask = { ...recipe(), strokes: [{ tool: 'brush', size: 1, points: [{ x: .5, y: .5 }] }, { tool: 'erase', size: 1, points: [{ x: .5, y: .5 }] }] } },
    ]) {
      const graph = structuredClone(initial); change(graph)
      const plan = buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: ['gpt-image-1', 'dall-e-2'], videoModels: [], cachedNodeIds: ['edit'] })
      expect(plan).toMatchObject({ canStart: false, paidRequestCount: 0 })
      expect(plan.items.find((item) => item.nodeId === 'edit')?.reasonCode).toBe('invalid-parameters')
    }
  })

  it('never degrades a mask to an unmasked legacy request', async () => {
    const host = { generateImage: vi.fn(), editImage: vi.fn(), generateVideo: vi.fn(), cancelRequest: vi.fn() }
    const executors = createHostExecutors({ imageGroup: 'provider', videoGroup: '', host })
    for (const kind of ['image', 'image-generate', 'image-edit'] as const) {
      const node = { ...workflow().nodes[1], kind, data: { ...workflow().nodes[1].data, imageCandidateCount: 1 as const } }
      await expect(executors[kind](node, {}, new AbortController().signal)).rejects.toThrow('不会退回普通图像编辑')
    }
    expect(host.generateImage).not.toHaveBeenCalled(); expect(host.editImage).not.toHaveBeenCalled()
  })
})
