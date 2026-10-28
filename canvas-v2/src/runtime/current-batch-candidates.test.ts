import { describe, expect, it } from 'vitest'
import type { CanvasAssetSummary, CanvasImageAssetSummary } from '../host'
import { editorNodeToCanvasNode, toCanvasNode, toWorkflowNode } from '../App'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowNodeData } from '../model'
import { defaultImageTransformRecipe } from '../image-tools/recipe'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, undoCanvasHistory } from '../store/history'
import { currentNodeCandidates } from './current-batch-candidates'
import { selectNodeCandidate } from './run-projection'

const ids = Array.from({ length: 9 }, (_, index) => String.fromCharCode(97 + index).repeat(43))

function data(): WorkflowNodeData {
  return { prompt: '', model: '', status: 'succeeded', candidateAssetIds: [...ids], result: { kind: 'image', assetId: ids[4], localUrl: `xingmang-asset://image/${ids[4]}` }, settings: { imageTransform: { ...defaultImageTransformRecipe('grid-split'), rows: 3, columns: 3 } } }
}

function catalog(): CanvasImageAssetSummary[] {
  return ids.map((assetId, index) => ({ assetId, mediaType: 'image', localUrl: `xingmang-asset://image/${assetId}`, thumbnailUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png', fileName: `${index}.png`, width: 201, height: index < 3 ? 133 : 134, createdAt: '2026-10-14T10:00:00.000Z' }))
}

function node() {
  return toCanvasNode({ id: 'grid', kind: 'image-grid-split', definitionVersion: 1, position: { x: 0, y: 0 }, data: data() })
}

describe('restoring the current grid output candidates', () => {
  it('restores all nine selectable outputs after deleting and undoing the actual document node', () => {
    const document = { ...createCanvasDocument(), nodes: [canvasNodeDocumentRecord(node())] }
    const deleted = applyCanvasCommand(createCanvasHistory(document), { type: 'delete-elements', nodeIds: ['grid'] })
    const restored = editorNodeToCanvasNode(undoCanvasHistory(deleted).present.nodes[0])
    expect(restored.data.candidates).toBeUndefined()
    const candidates = currentNodeCandidates(restored.id, restored.type, restored.data, catalog().reverse())
    expect(candidates.map((candidate) => candidate.asset.assetId)).toEqual(ids)
    expect(candidates.map((candidate) => candidate.outputIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(candidates[4].asset).toMatchObject({ width: 201, height: 134 })
    expect(restored.data.result?.assetId).toBe(ids[4])
  })

  it('rebuilds the same batch after project serialization without inventing run history', () => {
    const original = { ...createEmptyWorkflow(), nodes: [toWorkflowNode(node())] }
    const reopened = parseWorkflowFile(serializeWorkflow(original))!
    const restored = toCanvasNode(reopened.nodes[0])
    const candidates = currentNodeCandidates(restored.id, restored.type, restored.data)
    expect(candidates).toHaveLength(9)
    expect(candidates.every((candidate) => candidate.candidateId.startsWith('document:') && candidate.createdAt === '')).toBe(true)
    expect(candidates.map((candidate) => candidate.asset.localUrl)).toEqual(ids.map((id) => `xingmang-asset://image/${id}`))
    expect(restored.data.result?.assetId).toBe(ids[4])
    expect(restored.data.attemptCount).toBeUndefined()
  })

  it('excludes historical run candidates and unrelated catalog assets from the saved batch', () => {
    const current = data()
    current.candidates = [
      { candidateId: 'old', attemptId: 'old-run-attempt', createdAt: 'old', asset: { kind: 'image', assetId: 'z'.repeat(43) } },
      { candidateId: 'current-five', attemptId: 'real-attempt', createdAt: 'real-time', outputIndex: 4, asset: { kind: 'image', assetId: ids[4] } },
    ]
    const candidates = currentNodeCandidates('grid', 'image-grid-split', current, [...catalog(), { ...catalog()[0], assetId: 'z'.repeat(43) }])
    expect(candidates.map((candidate) => candidate.asset.assetId)).toEqual(ids)
    expect(candidates[4]).toMatchObject({ candidateId: 'current-five', attemptId: 'real-attempt', createdAt: 'real-time', outputIndex: 4 })
    expect(candidates.some((candidate) => candidate.candidateId === 'old')).toBe(false)
  })

  it('selects a reconstructed output while preserving batch successors and one-step undo', () => {
    const nodes = [node(), ...['single', 'batch'].map((id) => toCanvasNode({ id, kind: 'image-collage', position: { x: 500, y: 0 }, data: { prompt: '', model: '', status: 'succeeded', dirty: false } }))]
    const edges = [
      { id: 'single-edge', source: 'grid', target: 'single', sourceHandle: 'out:image', targetHandle: 'in:images' },
      { id: 'batch-edge', source: 'grid', target: 'batch', sourceHandle: 'out:images', targetHandle: 'in:images' },
    ]
    const candidates = currentNodeCandidates('grid', 'image-grid-split', nodes[0].data, catalog())
    const changed = selectNodeCandidate(nodes, edges, 'grid', candidates[7])
    expect(changed[0].data.result?.assetId).toBe(ids[7])
    expect(changed[0].data.candidateAssetIds).toEqual(ids)
    expect(changed[1].data.dirty).toBe(true)
    expect(changed[2].data.dirty).toBe(false)
    expect(currentNodeCandidates('grid', 'image-grid-split', changed[0].data, catalog())).toHaveLength(9)
    const history = createCanvasHistory({ ...createCanvasDocument(), nodes: nodes.map(canvasNodeDocumentRecord), edges })
    const updated = applyCanvasCommand(history, { type: 'replace-nodes', nodes: changed.map(canvasNodeDocumentRecord) })
    const restored = editorNodeToCanvasNode(undoCanvasHistory(updated).present.nodes[0])
    expect(restored.data.result?.assetId).toBe(ids[4])
    expect(currentNodeCandidates('grid', 'image-grid-split', restored.data, catalog())).toHaveLength(9)
  })

  it('keeps the existing candidate behavior for other node kinds and ignores malformed asset IDs', () => {
    const original = data()
    original.candidates = []
    expect(currentNodeCandidates('output', 'output', original, catalog())).toBe(original.candidates)
    expect(currentNodeCandidates('grid', 'image-grid-split', { ...original, candidateAssetIds: ['../../other', ids[0]] }).map((candidate) => candidate.asset.assetId)).toEqual([ids[0]])
  })
})

describe('restoring a mixed-media gallery batch', () => {
  it('uses real asset types and document identities in saved order', () => {
    const assets: CanvasAssetSummary[] = [catalog()[0],
      { assetId: ids[1], mediaType: 'video', localUrl: `xingmang-asset://video/${ids[1]}`, thumbnailUrl: '', mimeType: 'video/mp4', fileName: 'clip.mp4', taskId: 'fixture-video', createdAt: '', width: 640, height: 360, durationSeconds: 8 },
      { assetId: ids[2], mediaType: 'audio', localUrl: `xingmang-asset://audio/${ids[2]}`, thumbnailUrl: '', mimeType: 'audio/wav', fileName: 'sound.wav', createdAt: '', durationSeconds: 3 }]
    const candidates = currentNodeCandidates('gallery', 'gallery', { ...data(), candidateAssetIds: [ids[2], ids[0], ids[1]], result: undefined }, assets)
    expect(candidates.map((candidate) => candidate.asset.kind)).toEqual(['audio', 'image', 'video'])
    expect(candidates.map((candidate) => candidate.asset.assetId)).toEqual([ids[2], ids[0], ids[1]])
    expect(candidates[0].asset.durationSeconds).toBe(3)
    expect(candidates[2].asset).toMatchObject({ width: 640, height: 360, durationSeconds: 8 })
    expect(candidates.every((candidate) => candidate.candidateId.startsWith('document:') && candidate.attemptId === 'document:gallery')).toBe(true)
  })

  it('does not guess an unknown gallery asset type or include historical candidates', () => {
    const current = { ...data(), candidateAssetIds: [ids[0], ids[1], ids[2]], result: { kind: 'image' as const, assetId: ids[2] }, candidates: [
      { candidateId: 'real-video', attemptId: 'real-attempt', createdAt: 'then', asset: { kind: 'video' as const, assetId: ids[1] } },
      { candidateId: 'historical', attemptId: 'old', createdAt: 'old', asset: { kind: 'image' as const, assetId: ids[3] } },
    ] }
    const candidates = currentNodeCandidates('gallery', 'gallery', current)
    expect(candidates.map((candidate) => candidate.asset.assetId)).toEqual([ids[1], ids[2]])
    expect(candidates.map((candidate) => candidate.asset.kind)).toEqual(['video', 'image'])
    expect(candidates[0]).toMatchObject({ candidateId: 'real-video', attemptId: 'real-attempt', createdAt: 'then' })
    expect(current.candidateAssetIds).toEqual([ids[0], ids[1], ids[2]])
  })
})
