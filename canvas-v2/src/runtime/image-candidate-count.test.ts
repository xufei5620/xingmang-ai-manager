import { describe, expect, it, vi } from 'vitest'
import { editorNodeToCanvasNode, toCanvasNode, toCanvasRunGraph, toWorkflowNode, workflowNodeData } from '../App'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowFile, type NodeKind } from '../model'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, undoCanvasHistory } from '../store/history'
import { sanitizeWorkflowV2 } from '../persistence/workflow-sanitizer'
import { toPersistedWorkflowV2 } from '../persistence/workflow-schema'
import { instantiateWorkshopGraph } from '../editor/workshop-graph'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { buildWorkshopTransferFile, parseWorkshopTransferFile, serializeWorkshopTransferFile } from '../lib/workshop-transfer-format'
import { buildCanvasRunPreflight } from './run-preflight'
import { buildImageRequestParameters } from './image-request-parameters'
import { imageCandidateCounts, parseImageCandidateCount, type ImageCandidateCount } from './image-candidate-count'
import { currentNodeCandidates } from './current-batch-candidates'
import { selectNodeCandidate } from './run-projection'
import { createHostExecutors } from '../engine/executors'

const assetIds = Array.from({ length: 16 }, (_, index) => String.fromCharCode(97 + index).repeat(43))

function workflow(imageCandidateCount?: ImageCandidateCount, kind: NodeKind = 'image-generate'): WorkflowFile {
  return { ...createEmptyWorkflow('Candidate count'), nodes: [{ id: 'image', kind, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: 'A ceramic cup', model: 'gpt-image-1', status: 'idle', ...(imageCandidateCount !== undefined ? { imageCandidateCount } : {}) } }] }
}

describe('independent image request count', () => {
  it.each(imageCandidateCounts)('preserves %s through editor hydration, file save and the run graph', (count) => {
    const original = workflow(count)
    const live = toCanvasNode(original.nodes[0])
    const hydrated = editorNodeToCanvasNode(canvasNodeDocumentRecord(live))
    const restored = parseWorkflowFile(serializeWorkflow({ ...original, nodes: [toWorkflowNode(hydrated)] }))!
    expect(restored.nodes[0].data.imageCandidateCount).toBe(count)
    expect(workflowNodeData('image-generate', { imageCandidateCount: count }).imageCandidateCount).toBe(count)
    expect(workflowNodeData('image-generate', { imageCandidateCount: count }).settings ?? {}).not.toHaveProperty('imageCandidateCount')
    const graph = toCanvasRunGraph([hydrated], [], { image: 'provider', video: '' })
    expect(graph.nodes[0].data.imageCandidateCount).toBe(count)
    expect(buildImageRequestParameters(graph.nodes[0].data).n).toBe(1)
    const preflight = buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: ['gpt-image-1'], videoModels: [], cachedNodeIds: ['image'] })
    expect(preflight).toMatchObject({ canStart: true, requestCount: count, paidRequestCount: count, imageRequestCount: count })
    expect(preflight.items[0].requestCount).toBe(count)
    expect(preflight.warnings.join(' ')).toContain(`最多提交 ${count} 个付费生成请求`)
  })

  it('keeps legacy omitted counts omitted while disclosing one possible request', () => {
    const original = workflow()
    const restored = parseWorkflowFile(serializeWorkflow(original))!
    expect(restored.nodes[0].data).not.toHaveProperty('imageCandidateCount')
    expect(parseImageCandidateCount(undefined, 'prompt')).toBeUndefined()
    const graph = toCanvasRunGraph(restored.nodes.map(toCanvasNode), [], { image: 'provider', video: '' })
    expect(buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: ['gpt-image-1'], videoModels: [] }).paidRequestCount).toBe(1)
  })

  it.each([0, 5, -1, 1.5, '2', null, true, NaN, Infinity])('rejects malformed count %s at executable and persistence boundaries', (value) => {
    expect(() => parseImageCandidateCount(value, 'image-generate')).toThrow('1 到 4')
    const original = workflow()
    Object.assign(original.nodes[0].data, { imageCandidateCount: value })
    expect(() => toPersistedWorkflowV2(original)).toThrow('1 到 4')
    expect(sanitizeWorkflowV2(original)?.workflow.nodes ?? []).toHaveLength(0)
    expect(() => sanitizeWorkshopWorkflow(original, 'node', 'Invalid count')).toThrow()
    expect(() => workflowNodeData('image-generate', { imageCandidateCount: value })).toThrow('1 到 4')
    const graph = { nodes: [{ id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'cup', model: 'gpt-image-1', group: 'provider' } }], edges: [] }
    Object.assign(graph.nodes[0].data, { imageCandidateCount: value })
    expect(buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: ['gpt-image-1'], videoModels: [] })).toMatchObject({ canStart: false, paidRequestCount: 0, blockedCount: 1 })
  })

  it.each(['prompt', 'image-input', 'image-grid-split', 'video-generate', 'text-generate', 'unknown'] as const)('rejects counts on unrelated %s nodes', (kind) => {
    expect(() => parseImageCandidateCount(2, kind)).toThrow('此节点不支持')
    const original = workflow(2, kind)
    expect(() => toPersistedWorkflowV2(original)).toThrow('此节点不支持')
    expect(sanitizeWorkflowV2(original)?.workflow.nodes ?? []).toHaveLength(0)
    expect(() => sanitizeWorkshopWorkflow(original, 'node', 'Unrelated count')).toThrow()
  })

  it.each(['node', 'group'] as const)('retains requested count in %s workshop import and removes result assets', (kind) => {
    const original = workflow(4)
    original.nodes[0].data.candidateAssetIds = assetIds
    original.nodes[0].data.result = { kind: 'image', assetId: assetIds[3] }
    const clean = sanitizeWorkshopWorkflow(original, kind, 'Four candidates')
    const instance = instantiateWorkshopGraph(clean, () => 'inserted')
    expect(instance.nodes[0].data.imageCandidateCount).toBe(4)
    expect(instance.nodes[0].data).not.toHaveProperty('result')
    expect(instance.nodes[0].data).not.toHaveProperty('candidateAssetIds')
    const transfer = buildWorkshopTransferFile({ kind, name: 'Four candidates', description: '', category: 'general', tags: [], nodeCount: 1, edgeCount: 0, nodeKinds: ['image-generate'], workflow: clean }, { kind: 'personal' })
    const imported = parseWorkshopTransferFile(serializeWorkshopTransferFile(transfer))
    expect(imported.snapshot.workflow?.nodes[0].data.imageCandidateCount).toBe(4)
  })

  it('counts mixed planned requests and excludes disabled image batches', () => {
    const original = workflow(4)
    const disabled = { ...original.nodes[0], id: 'disabled', disabled: true }
    const prompt = { ...workflow(undefined, 'prompt').nodes[0], id: 'prompt' }
    const graph = toCanvasRunGraph([original.nodes[0], disabled, prompt].map(toCanvasNode), [], { image: 'provider', video: '' })
    expect(buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: ['gpt-image-1'], videoModels: [] })).toMatchObject({ requestCount: 5, paidRequestCount: 4, imageRequestCount: 4, skippedCount: 1 })
  })

  it('restores the requested count when undoing a parameter change without dropping prior candidates', () => {
    const node = toCanvasNode(workflow(2).nodes[0])
    node.data.candidateAssetIds = assetIds
    const history = createCanvasHistory({ ...createCanvasDocument(), nodes: [canvasNodeDocumentRecord(node)] })
    const changed = { ...node, data: { ...node.data, imageCandidateCount: 4 as const, dirty: true } }
    const applied = applyCanvasCommand(history, { type: 'replace-nodes', nodes: [canvasNodeDocumentRecord(changed)] })
    expect(editorNodeToCanvasNode(applied.present.nodes[0]).data.imageCandidateCount).toBe(4)
    const undone = editorNodeToCanvasNode(undoCanvasHistory(applied).present.nodes[0])
    expect(undone.data.imageCandidateCount).toBe(2)
    expect(undone.data.candidateAssetIds).toEqual(assetIds)
  })

  it.each(['image', 'image-generate', 'image-edit'] as const)('restores and selects all persisted %s candidates without fabricating batch output ports', (kind) => {
    const original = workflow(4, kind)
    original.nodes[0].data.candidateAssetIds = assetIds
    original.nodes[0].data.result = { kind: 'image', assetId: assetIds[3] }
    const restored = parseWorkflowFile(serializeWorkflow(original))!.nodes.map(toCanvasNode)
    const candidates = currentNodeCandidates(restored[0].id, kind, restored[0].data)
    expect(candidates.map((candidate) => candidate.asset.assetId)).toEqual(assetIds)
    expect(candidates.every((candidate) => candidate.outputIndex === undefined)).toBe(true)
    expect(candidates.every((candidate) => candidate.attemptId === 'document:image')).toBe(true)
    const hydrated = [{ ...restored[0], data: { ...restored[0].data, candidates } }]
    const changed = selectNodeCandidate(hydrated, [], 'image', candidates[12])
    expect(changed[0].data.result?.assetId).toBe(assetIds[12])
    expect(changed[0].data.candidateAssetIds).toEqual(assetIds)
    const history = createCanvasHistory({ ...createCanvasDocument(), nodes: restored.map(canvasNodeDocumentRecord) })
    const applied = applyCanvasCommand(history, { type: 'replace-nodes', nodes: changed.map(canvasNodeDocumentRecord) })
    const undone = editorNodeToCanvasNode(undoCanvasHistory(applied).present.nodes[0])
    expect(undone.data.result?.assetId).toBe(assetIds[3])
    expect(currentNodeCandidates(undone.id, kind, undone.data)).toHaveLength(16)
  })

  it('never silently submits a single request through the legacy lightweight executor', async () => {
    const host = { generateImage: vi.fn(), editImage: vi.fn(), generateVideo: vi.fn(), cancelRequest: vi.fn() }
    const executors = createHostExecutors({ imageGroup: 'provider', videoGroup: '', host })
    for (const kind of ['image-generate', 'image-edit'] as const) await expect(executors[kind](workflow(2, kind).nodes[0], {}, new AbortController().signal)).rejects.toThrow('安全运行服务')
    expect(host.generateImage).not.toHaveBeenCalled()
    expect(host.editImage).not.toHaveBeenCalled()
  })
})
