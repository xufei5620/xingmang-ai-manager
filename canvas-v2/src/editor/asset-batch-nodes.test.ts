import { describe, expect, it } from 'vitest'
import type { CanvasListedAssetSummary } from '../host'
import { buildAssetBatchNodes, buildAssetBatchWorkflow } from './asset-batch-nodes'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { parseWorkflowFile, serializeWorkflow } from '../persistence/workflow-serializer'

function assets(): CanvasListedAssetSummary[] {
  return [
    { assetId: 'a'.repeat(43), mediaType: 'image', mimeType: 'image/png', width: 480, height: 640 },
    { assetId: 'b'.repeat(43), mediaType: 'video', mimeType: 'video/mp4', durationSeconds: 3 },
    { assetId: 'c'.repeat(43), mediaType: 'audio', mimeType: 'audio/wav', durationSeconds: 4 },
  ].map((asset, index) => ({ ...asset, displayName: `素材 ${index}`, fileName: 'file', localUrl: `xingmang-asset://${asset.mediaType}/${asset.assetId}`, thumbnailUrl: '', createdAt: '2026-10-15T00:00:00Z' })) as CanvasListedAssetSummary[]
}

describe('atomic mixed media node batches', () => {
  it('preserves selection order and media metadata with a single undo and redo', () => {
    const command = buildAssetBatchNodes([], assets(), ['image', 'video', 'audio'], { x: 500, y: 500 })
    expect(command.nodes[0].position.y).toBe(command.nodes[2].position.y)
    expect(command.nodes[0].position.x).toBeLessThan(command.nodes[1].position.x)
    expect(command.nodes[1].position.x).toBeLessThan(command.nodes[2].position.x)
    expect(command.nodes.map((node) => node.type)).toEqual(['image-input', 'video-input', 'audio-input'])
    expect(command.nodes[0].data.result).toMatchObject({ width: 480, height: 640 })
    expect(command.nodes[1].data.result).not.toHaveProperty('width')
    expect(command.nodes[2].data.result).toMatchObject({ kind: 'audio', durationSeconds: 4 })
    let history = applyCanvasCommand(createCanvasHistory(createCanvasDocument()), command)
    expect(history.present.nodes).toHaveLength(3)
    history = undoCanvasHistory(history); expect(history.present.nodes).toHaveLength(0)
    history = redoCanvasHistory(history); expect(history.present.nodes).toEqual(command.nodes)
  })
  it('rejects the complete batch for recycled, external, duplicate or invalid entries', () => {
    const value = assets()
    for (const invalid of [[value[0], { ...value[1], deletedAt: 'now' }], [value[0], { ...value[1], localUrl: 'https://elsewhere.invalid/file' }], [value[0], value[0]]]) expect(() => buildAssetBatchNodes([], invalid, ['a', 'b'], { x: 0, y: 0 })).toThrow()
    expect(value).toEqual(assets())
  })
  it('round trips workspace creation through the existing persisted workflow schema without running models', () => {
    let id = 0
    const workflow = buildAssetBatchWorkflow(assets(), () => `node-${++id}`)
    const parsed = parseWorkflowFile(serializeWorkflow(workflow))!
    expect(parsed.nodes.map((node) => node.kind)).toEqual(['image-input', 'video-input', 'audio-input'])
    expect(parsed.edges).toEqual([])
    expect(parsed.nodes.map((node) => node.data.result?.assetId)).toEqual(assets().map((asset) => asset.assetId))
  })
})
