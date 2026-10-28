import { describe, expect, it, vi } from 'vitest'
import { editorNodeToCanvasNode, toCanvasNode, toCanvasRunGraph, toWorkflowNode, workflowNodeData } from '../App'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type NodeKind, type WorkflowFile } from '../model'
import type { CanvasVideoAssetSummary } from '../host'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { toPersistedWorkflowV2 } from '../persistence/workflow-schema'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { analyzeWorkshopReadiness } from '../lib/workshop-readiness'
import { buildWorkshopTransferFile, parseWorkshopTransferFile, serializeWorkshopTransferFile } from '../lib/workshop-transfer-format'
import { instantiateWorkshopGraph } from '../editor/workshop-graph'
import { parseVideoCandidateCount, videoCandidateCounts, type VideoCandidateCount } from './video-candidate-count'
import { buildCanvasRunPreflight } from './run-preflight'
import { currentNodeCandidates } from './current-batch-candidates'
import { selectNodeCandidate } from './run-projection'
import { createHostExecutors } from '../engine/executors'

const ids = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(43))
function workflow(count?: VideoCandidateCount, kind: NodeKind = 'video-generate'): WorkflowFile {
  return { ...createEmptyWorkflow('Video candidates'), nodes: [{ id: 'video', kind, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: 'A ceramic cup on a rotating table', model: 'grok-imagine-video', seconds: '3', size: '1280x720', status: 'idle', ...(count === undefined ? {} : { videoCandidateCount: count }) } }] }
}
function assets(): CanvasVideoAssetSummary[] { return ids.map((assetId, index) => ({ mediaType: 'video', assetId, localUrl: `xingmang-asset://video/${assetId}`, mimeType: 'video/mp4', taskId: `task-${index}`, thumbnailUrl: '', createdAt: '', width: 320, height: 180, durationSeconds: 3, fileName: `video-${index}.mp4` })) }
function preflight(file: WorkflowFile) { return buildCanvasRunPreflight({ graph: toCanvasRunGraph(file.nodes.map(toCanvasNode), file.edges, { image: '', video: 'provider' }), scope: { kind: 'all' }, imageModels: [], videoModels: ['grok-imagine-video'] }) }

describe('video candidate document and workshop workflow', () => {
  it.each(videoCandidateCounts)('retains explicit quantity %s through document hydration, save, reload and the run graph', (count) => {
    const original = workflow(count), live = toCanvasNode(original.nodes[0])
    const hydrated = editorNodeToCanvasNode(canvasNodeDocumentRecord(live))
    const restored = parseWorkflowFile(serializeWorkflow({ ...original, nodes: [toWorkflowNode(hydrated)] }))!
    expect(restored.nodes[0].data.videoCandidateCount).toBe(count)
    expect(workflowNodeData('video-generate', { videoCandidateCount: count }).videoCandidateCount).toBe(count)
    expect(workflowNodeData('video-generate', { videoCandidateCount: count }).settings ?? {}).not.toHaveProperty('videoCandidateCount')
    expect(toCanvasRunGraph([hydrated], [], { image: '', video: 'provider' }).nodes[0].data.videoCandidateCount).toBe(count)
    expect(preflight(restored)).toMatchObject({ canStart: true, requestCount: count, paidRequestCount: count, videoRequestCount: count })
  })
  it('preserves legacy omission while planning one independent task', () => {
    const restored = parseWorkflowFile(serializeWorkflow(workflow()))!
    expect(restored.nodes[0].data).not.toHaveProperty('videoCandidateCount')
    expect(preflight(restored)).toMatchObject({ requestCount: 1, paidRequestCount: 1, videoRequestCount: 1 })
  })
  it.each([0, 5, -1, 1.5, '2', null, true, NaN, Infinity])('rejects invalid quantity %s before persistence, workshop or execution', (value) => {
    const original = workflow(); Object.assign(original.nodes[0].data, { videoCandidateCount: value })
    expect(() => parseVideoCandidateCount(value, 'video-generate')).toThrow('1 到 4')
    expect(() => toPersistedWorkflowV2(original)).toThrow('1 到 4')
    expect(() => sanitizeWorkshopWorkflow(original, 'node', 'Invalid')).toThrow()
    expect(() => workflowNodeData('video-generate', { videoCandidateCount: value })).toThrow('1 到 4')
  })
  it.each(['prompt', 'video-input', 'image-generate', 'text-generate', 'frame-extract'] as const)('does not silently accept video quantity on %s', (kind) => {
    expect(() => parseVideoCandidateCount(2, kind)).toThrow('此节点不支持')
    expect(() => toPersistedWorkflowV2(workflow(2, kind))).toThrow('此节点不支持')
    expect(() => sanitizeWorkshopWorkflow(workflow(2, kind), 'node', 'Invalid')).toThrow()
  })
  it.each(['node', 'group'] as const)('retains count in portable %s configurations but strips private candidates and runtime progress', (kind) => {
    const original = workflow(3)
    Object.assign(original.nodes[0].data, { result: { kind: 'video', assetId: ids[1], taskId: 'private-task' }, candidateAssetIds: ids, videoBatchProgress: { completed: 2, submitted: 3, total: 3 } })
    const portable = sanitizeWorkshopWorkflow(original, kind, 'Three videos')
    const transfer = buildWorkshopTransferFile({ kind, name: 'Three videos', description: '', category: 'general', tags: [], nodeCount: 1, edgeCount: 0, nodeKinds: ['video-generate'], workflow: portable }, { kind: 'personal' })
    const serialized = serializeWorkshopTransferFile(transfer)
    const imported = parseWorkshopTransferFile(serialized).snapshot.workflow!
    const instance = instantiateWorkshopGraph(imported, () => 'inserted')
    expect(instance.nodes[0].data.videoCandidateCount).toBe(3)
    for (const key of ['result', 'candidateAssetIds', 'candidates', 'videoBatchProgress', 'group']) expect(instance.nodes[0].data).not.toHaveProperty(key)
    for (const secret of [...ids, 'private-task', 'private-provider']) expect(serialized).not.toContain(secret)
    const readiness = analyzeWorkshopReadiness(imported)
    expect(readiness.modelNodeCounts.video).toBe(1); expect(readiness.requestCounts.video).toBe(3)
    expect(readiness.nodes.find((node) => node.nodeId === imported.nodes[0].id)?.maximumRequestCount).toBe(3)
  })
  it('excludes disabled video batches while counting enabled task maxima independently from nodes', () => {
    const original = workflow(3)
    original.nodes.push({ ...workflow(4).nodes[0], id: 'disabled', disabled: true })
    expect(preflight(original)).toMatchObject({ canStart: true, requestCount: 3, paidRequestCount: 3, videoRequestCount: 3, skippedCount: 1 })
    expect(analyzeWorkshopReadiness(original)).toMatchObject({ modelNodeCounts: { video: 1 }, requestCounts: { video: 3 }, skippedNodeCount: 1 })
  })
  it.each(['video', 'video-generate'] as const)('restores candidate identities and selected output across save, hydration and one-step undo for %s', (kind) => {
    const original = workflow(4, kind)
    original.nodes[0].data.candidateAssetIds = ids
    original.nodes[0].data.result = { kind: 'video', assetId: ids[1], localUrl: `xingmang-asset://video/${ids[1]}`, taskId: 'task-1', width: 320, height: 180, durationSeconds: 3 }
    const restored = parseWorkflowFile(serializeWorkflow(original))!.nodes.map(toCanvasNode)
    const candidates = currentNodeCandidates('video', kind, restored[0].data, assets())
    expect(candidates.map((candidate) => candidate.asset.assetId)).toEqual(ids)
    expect(candidates.every((candidate) => candidate.outputIndex === undefined && candidate.attemptId === 'document:video')).toBe(true)
    expect(candidates[1].asset).toMatchObject({ kind: 'video', taskId: 'task-1', width: 320, height: 180, durationSeconds: 3 })
    const live = [{ ...restored[0], data: { ...restored[0].data, candidates, videoBatchProgress: { completed: 4, submitted: 4, total: 4 } } }]
    const before = canvasNodeDocumentRecord(live[0]); expect(before.data).not.toHaveProperty('videoBatchProgress')
    const changed = selectNodeCandidate(live, [], 'video', candidates[3])
    let history = createCanvasHistory({ ...createCanvasDocument(), nodes: [before] })
    history = applyCanvasCommand(history, { type: 'replace-nodes', nodes: changed.map(canvasNodeDocumentRecord) })
    expect(editorNodeToCanvasNode(history.present.nodes[0]).data.result?.assetId).toBe(ids[3])
    const undone = undoCanvasHistory(history), undoneNode = editorNodeToCanvasNode(undone.present.nodes[0])
    expect(undoneNode.data.result?.assetId).toBe(ids[1]); expect(undoneNode.data.candidateAssetIds).toEqual(ids)
    expect(currentNodeCandidates('video', kind, undoneNode.data, assets())).toHaveLength(4)
    expect(editorNodeToCanvasNode(redoCanvasHistory(undone).present.nodes[0]).data.result?.assetId).toBe(ids[3])
    const reopened = parseWorkflowFile(serializeWorkflow({ ...original, nodes: changed.map(toWorkflowNode) }))!.nodes[0]
    expect(reopened.data.result?.assetId).toBe(ids[3]); expect(reopened.data.candidateAssetIds).toEqual(ids)
  })
  it('rejects a wrong-media catalog entry instead of restoring it as a video', () => {
    const data = { ...workflow(2).nodes[0].data, candidateAssetIds: ids.slice(0, 2) }
    const candidates = currentNodeCandidates('video', 'video-generate', data, [{ ...assets()[0], mediaType: 'image', mimeType: 'image/png' }])
    expect(candidates.map((candidate) => candidate.asset.assetId)).toEqual([ids[1]])
  })
  it('refuses to collapse a video batch to one request in the lightweight executor', async () => {
    const host = { generateImage: vi.fn(), editImage: vi.fn(), generateVideo: vi.fn(), cancelRequest: vi.fn() }
    const executors = createHostExecutors({ imageGroup: '', videoGroup: 'provider', host })
    for (const kind of ['video', 'video-generate'] as const) await expect(executors[kind](workflow(3, kind).nodes[0], {}, new AbortController().signal)).rejects.toThrow('安全运行服务')
    expect(host.generateVideo).not.toHaveBeenCalled()
  })
})
