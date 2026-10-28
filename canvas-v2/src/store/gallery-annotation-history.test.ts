import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { editorNodeToCanvasNode, toCanvasNode, toWorkflowNode } from '../App'
import type { CanvasAssetSummary, CanvasImageAssetSummary } from '../host'
import { replaceAnnotatedImage } from '../image-tools/annotation-workflow'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow } from '../model'
import { currentNodeCandidates } from '../runtime/current-batch-candidates'
import { createCanvasDocument } from './canvas-state'
import { canvasNodeDocumentRecord, useCanvasDocument, type CanvasDocumentController } from './use-canvas-document'

const ids = ['a', 'b', 'c', 'd'].map((value) => value.repeat(43))

function image(assetId: string): CanvasImageAssetSummary {
  return { assetId, mediaType: 'image', localUrl: `xingmang-asset://image/${assetId}`, thumbnailUrl: '', mimeType: 'image/png', fileName: 'image.png', width: 640, height: 480, createdAt: '' }
}

function controller(): CanvasDocumentController {
  let captured: CanvasDocumentController | undefined
  function Capture() { captured = useCanvasDocument(editorNodeToCanvasNode); return null }
  renderToStaticMarkup(createElement(Capture))
  if (!captured) throw new Error('Missing controller')
  return captured
}

describe('gallery annotation document history', () => {
  it('restores mixed candidate order and descendants through replacement undo redo deletion and serialization', () => {
    const assets: CanvasAssetSummary[] = [image(ids[0]), image(ids[1]), image(ids[3]),
      { assetId: ids[2], mediaType: 'video', localUrl: `xingmang-asset://video/${ids[2]}`, thumbnailUrl: '', mimeType: 'video/mp4', fileName: 'clip.mp4', taskId: 'fixture-video', createdAt: '', durationSeconds: 5 }]
    const gallery = toCanvasNode({ id: 'gallery', kind: 'gallery', position: { x: 0, y: 0 }, data: {
      prompt: '', model: '', status: 'succeeded', candidateAssetIds: ids.slice(0, 3),
      result: { kind: 'image', assetId: ids[1], localUrl: `xingmang-asset://image/${ids[1]}` },
      candidates: assets.slice(0, 2).concat(assets[3]).map((asset, index) => ({ candidateId: `paid-${index}`, attemptId: `original-${index}`, createdAt: '', asset: { kind: asset.mediaType, assetId: asset.assetId, localUrl: asset.localUrl } })),
    } })
    const child = toCanvasNode({ id: 'child', kind: 'gallery', position: { x: 500, y: 0 }, data: { prompt: '', model: '', status: 'succeeded', dirty: false } })
    const edges = [{ id: 'edge', source: 'gallery', sourceHandle: 'out:images', target: 'child', targetHandle: 'in:images' }]
    const target = controller()
    target.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: [gallery, child].map(canvasNodeDocumentRecord), edges } })
    target.setNodes([gallery, child])
    const updated = replaceAnnotatedImage(target.getGraphSnapshot().nodes, edges, 'gallery', ids[1], image(ids[3]))
    target.execute({ type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord) })
    target.setNodes(updated)
    function assertBatch(expected: string[], selected: string, dirty: boolean) {
      const nodes = target.getGraphSnapshot().nodes
      expect(nodes[0].data.candidateAssetIds).toEqual(expected)
      expect(nodes[0].data.result?.assetId).toBe(selected)
      expect(currentNodeCandidates('gallery', 'gallery', nodes[0].data, assets).map((candidate) => candidate.asset.assetId)).toEqual(expected)
      expect(currentNodeCandidates('gallery', 'gallery', nodes[0].data, assets).map((candidate) => candidate.asset.kind)).toEqual(['image', 'image', 'video'])
      expect(nodes[1].data.dirty === true).toBe(dirty)
    }
    assertBatch([ids[0], ids[3], ids[2]], ids[3], true)
    target.undo()
    assertBatch(ids.slice(0, 3), ids[1], false)
    target.redo()
    assertBatch([ids[0], ids[3], ids[2]], ids[3], true)
    target.execute({ type: 'delete-elements', nodeIds: ['gallery'] })
    target.undo()
    assertBatch([ids[0], ids[3], ids[2]], ids[3], true)
    const workflow = { ...createEmptyWorkflow(), nodes: target.getGraphSnapshot().nodes.map(toWorkflowNode), edges }
    const reopened = parseWorkflowFile(serializeWorkflow(workflow))!
    const restored = toCanvasNode(reopened.nodes[0])
    expect(restored.data.candidates).toBeUndefined()
    expect(currentNodeCandidates('gallery', 'gallery', restored.data, assets).map((candidate) => candidate.asset.kind)).toEqual(['image', 'image', 'video'])
    expect(restored.data.candidateAssetIds).toEqual([ids[0], ids[3], ids[2]])
    expect(restored.data.result?.assetId).toBe(ids[3])
  })
})
