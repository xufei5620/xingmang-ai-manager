import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasAssetSummary } from '../host'
import type { NodeKind } from '../model'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { createCanvasDocument } from '../store/canvas-state'
import { canvasNodeDocumentRecord, useCanvasDocument, type CanvasDocumentController } from '../store/use-canvas-document'
import { buildCanvasMediaAssetBinding } from './bind-media-asset'
import { completeCanvasMediaImport } from './media-import-completion'

function node(id: string, type: NodeKind = 'prompt'): CanvasNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: id, model: '', status: 'idle', dirty: false } }
}

function edge(id: string, source: string, target: string): Edge {
  return { id, source, target, sourceHandle: 'out:image', targetHandle: 'in:images' }
}

function asset(kind: 'image' | 'video' | 'audio' = 'image'): CanvasAssetSummary {
  const base = { assetId: 'a'.repeat(43), localUrl: `xingmang-asset://${kind}/${'a'.repeat(43)}`, thumbnailUrl: '', createdAt: '2026-10-10T12:00:00.000Z' }
  if (kind === 'video') return { ...base, mediaType: kind, mimeType: 'video/mp4', fileName: 'movie.mp4', taskId: 'imported', durationSeconds: 2, width: 320, height: 180 }
  if (kind === 'audio') return { ...base, mediaType: kind, mimeType: 'audio/wav', fileName: 'tone.wav', durationSeconds: 2 }
  return { ...base, mediaType: kind, mimeType: 'image/png', fileName: 'picture.png', width: 320, height: 180 }
}

function canvasNode(record: EditorNodeRecord): CanvasNode {
  return {
    id: record.id, type: record.type as NodeKind, definitionVersion: record.definitionVersion,
    position: record.position, width: record.width, height: record.height,
    data: { prompt: '', model: '', status: 'idle', ...record.data },
  }
}

function controller(nodes: CanvasNode[], edges: Edge[]): CanvasDocumentController {
  let captured: CanvasDocumentController | undefined
  function Capture() {
    captured = useCanvasDocument(canvasNode)
    return null
  }
  // No DOM is needed: live refs and command history must be correct even
  // before React commits the next render, as when an upload resolves late.
  renderToStaticMarkup(createElement(Capture))
  if (!captured) throw new Error('Missing document controller')
  captured.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: nodes.map(canvasNodeDocumentRecord), edges: edges.map((entry) => ({ ...entry, sourceHandle: entry.sourceHandle ?? '', targetHandle: entry.targetHandle ?? '' })) } })
  return captured
}

function bindCurrent(target: CanvasDocumentController, id: string, media = asset()) {
  const current = target.getGraphSnapshot()
  const binding = buildCanvasMediaAssetBinding(current.nodes, current.edges, id, media)
  if (binding.status === 'bound') {
    target.execute({ type: 'replace-nodes', nodes: binding.nodes.map(canvasNodeDocumentRecord) })
    target.setNodes(binding.nodes)
  }
  return binding
}

function pendingImport() {
  let finish: (media: CanvasAssetSummary | null) => void = () => undefined
  const pending = new Promise<CanvasAssetSummary | null>((resolve) => { finish = resolve })
  return { pending, finish(media: CanvasAssetSummary | null) { finish(media) } }
}

describe('late media asset binding', () => {
  it('preserves edits, moves, additions, deletions and current wiring made while an upload waits', () => {
    const target = controller([node('source', 'image-input'), node('old-branch', 'gallery'), node('edited'), node('removed')], [edge('old-wire', 'source', 'old-branch')])
    const finishUpload = () => bindCurrent(target, 'source')
    target.execute({ type: 'move-nodes', positions: { edited: { x: 600, y: 300 } } })
    target.setNodes((current) => current.map((entry) => entry.id === 'edited' ? { ...entry, data: { ...entry.data, prompt: 'new draft', dirty: true }, selected: true } : entry))
    target.execute({ type: 'add-nodes', nodes: [canvasNodeDocumentRecord(node('new-branch', 'gallery'))] })
    target.execute({ type: 'delete-elements', nodeIds: ['removed'] })
    target.execute({ type: 'disconnect', edgeIds: ['old-wire'] })
    target.execute({ type: 'connect', edge: { ...edge('new-wire', 'source', 'new-branch'), sourceHandle: 'out:image', targetHandle: 'in:images' } })
    const before = structuredClone(target.getGraphSnapshot())
    expect(finishUpload()).toMatchObject({ status: 'bound', downstreamNodeIds: ['new-branch'] })
    const after = target.getGraphSnapshot()
    expect(after.nodes.map((entry) => entry.id)).toEqual(['source', 'old-branch', 'edited', 'new-branch'])
    expect(after.nodes.find((entry) => entry.id === 'edited')).toMatchObject({ position: { x: 600, y: 300 }, selected: true, data: { prompt: 'new draft', dirty: true } })
    expect(after.nodes.find((entry) => entry.id === 'source')?.data).toMatchObject({ status: 'succeeded', dirty: false, result: { assetId: asset().assetId } })
    expect(after.nodes.find((entry) => entry.id === 'new-branch')?.data.dirty).toBe(true)
    expect(after.nodes.find((entry) => entry.id === 'old-branch')?.data.dirty).toBe(false)
    expect(after.edges).toEqual(before.edges)
    target.undo()
    expect(target.getGraphSnapshot()).toEqual(before)
    target.redo()
    expect(target.getGraphSnapshot().nodes.find((entry) => entry.id === 'source')?.data.result?.assetId).toBe(asset().assetId)
    expect(target.getGraphSnapshot().edges).toEqual(before.edges)
  })

  it('does not resurrect a deleted upload target or write another undo entry', () => {
    const target = controller([node('source', 'image-input'), node('keep')], [])
    const finishUpload = () => bindCurrent(target, 'source')
    target.execute({ type: 'delete-elements', nodeIds: ['source'] })
    const before = target.getGraphSnapshot()
    expect(finishUpload()).toEqual({ status: 'missing-target' })
    expect(target.getGraphSnapshot()).toEqual(before)
    target.undo()
    expect(target.getGraphSnapshot().nodes.map((entry) => entry.id)).toEqual(['source', 'keep'])
    expect(target.getGraphSnapshot().nodes[0].data.result).toBeUndefined()
  })

  it.each(['video-input', 'audio-input', 'prompt'] as const)('rejects a target changed to %s while preserving its new data', (type) => {
    const target = controller([node('source', 'image-input'), node('keep')], [])
    const finishUpload = () => bindCurrent(target, 'source')
    target.setNodes((current) => current.map((entry) => entry.id === 'source' ? { ...entry, type, data: { ...entry.data, prompt: 'replacement configuration' } } : entry))
    const before = target.getGraphSnapshot()
    expect(finishUpload()).toEqual({ status: 'type-mismatch' })
    expect(target.getGraphSnapshot().nodes).toBe(before.nodes)
    expect(target.getGraphSnapshot().edges).toBe(before.edges)
    expect(target.getGraphSnapshot()).toEqual(before)
    expect(target.getGraphSnapshot().nodes[0].data.result).toBeUndefined()
  })

  it.each(['image', 'video', 'audio'] as const)('binds actual %s metadata and marks only current descendants dirty without mutating the source graph', (kind) => {
    const nodes = [node('source', `${kind}-input`), node('child', 'gallery'), node('unrelated')]
    const edges = [edge('current', 'source', 'child')]
    const before = structuredClone({ nodes, edges })
    const binding = buildCanvasMediaAssetBinding(nodes, edges, 'source', asset(kind))
    expect(binding.status).toBe('bound')
    if (binding.status !== 'bound') throw new Error('Expected binding')
    expect(binding.nodes[0].data.result).toMatchObject({ kind, assetId: asset(kind).assetId, mimeType: asset(kind).mimeType })
    if (kind !== 'image') expect(binding.nodes[0].data.result?.durationSeconds).toBe(2)
    if (kind === 'video') expect(binding.nodes[0].data.result?.taskId).toBe('imported')
    expect(binding.downstreamNodeIds).toEqual(['child'])
    expect(binding.nodes[2]).toBe(nodes[2])
    expect({ nodes, edges }).toEqual(before)
  })

  it('reads functional updates through a captured getter before any rerender', () => {
    const target = controller([node('source', 'image-input')], [])
    const read = target.getGraphSnapshot
    target.setNodes((current) => [...current, node('first')])
    target.setNodes((current) => [...current, node('second')])
    target.setEdges((current) => [...current, edge('one', 'source', 'first')])
    target.setEdges((current) => [...current, edge('two', 'first', 'second')])
    expect(read().nodes.map((entry) => entry.id)).toEqual(['source', 'first', 'second'])
    expect(read().edges.map((entry) => entry.id)).toEqual(['one', 'two'])
    expect(bindCurrent(target, 'source')).toMatchObject({ status: 'bound', downstreamNodeIds: ['first', 'second'] })
  })

  it.each(['bind', 'add'] as const)('does not %s an old upload after the same project is reopened with matching node identifiers', async (action) => {
    const target = controller([node('source', 'image-input'), node('old-edit')], [])
    const upload = pendingImport()
    let projectEpoch = 1
    let applied = 0
    const completed = completeCanvasMediaImport(upload.pending, projectEpoch, () => projectEpoch, (media) => {
      applied++
      if (action === 'bind' && 'mediaType' in media) bindCurrent(target, 'source', media)
      else target.execute({ type: 'add-nodes', nodes: [canvasNodeDocumentRecord(node('imported', 'image-input'))] })
    })
    projectEpoch++
    target.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument('same project'), nodes: [node('source', 'image-input'), node('cloud-edit')].map(canvasNodeDocumentRecord), edges: [{ ...edge('cloud-wire', 'source', 'cloud-edit'), sourceHandle: 'out:image', targetHandle: 'in:images' }] } })
    const cloudGraph = target.getGraphSnapshot()
    upload.finish(asset())
    await expect(completed).resolves.toBe('stale')
    expect(applied).toBe(0)
    expect(target.getGraphSnapshot()).toEqual(cloudGraph)
    expect(target.getGraphSnapshot().nodes[0].data.result).toBeUndefined()
    target.undo()
    expect(target.getGraphSnapshot()).toEqual(cloudGraph)
  })

  it('applies an awaited upload to the latest graph when the same session only receives ordinary edits', async () => {
    const target = controller([node('source', 'image-input'), node('other')], [])
    const upload = pendingImport()
    const projectEpoch = 3
    const completed = completeCanvasMediaImport(upload.pending, projectEpoch, () => projectEpoch, (media) => {
      if ('mediaType' in media) bindCurrent(target, 'source', media)
    })
    target.execute({ type: 'move-nodes', positions: { other: { x: 777, y: 123 } } })
    target.setNodes((current) => current.map((entry) => entry.id === 'other' ? { ...entry, data: { ...entry.data, prompt: 'latest text' } } : entry))
    upload.finish(asset())
    await expect(completed).resolves.toBe('applied')
    expect(target.getGraphSnapshot().nodes[0].data.result?.assetId).toBe(asset().assetId)
    expect(target.getGraphSnapshot().nodes[1]).toMatchObject({ position: { x: 777, y: 123 }, data: { prompt: 'latest text' } })
  })

  it('keeps cancelled selection silent and propagates upload failure without applying a node change', async () => {
    const target = controller([node('source', 'image-input')], [])
    let applied = 0
    const apply = () => { applied++; bindCurrent(target, 'source') }
    await expect(completeCanvasMediaImport(Promise.resolve(null), 1, () => 2, apply)).resolves.toBe('cancelled')
    const failure = new Error('上传结果未确认，请到素材库核对')
    await expect(completeCanvasMediaImport(Promise.reject(failure), 1, () => 1, apply)).rejects.toBe(failure)
    expect(applied).toBe(0)
    expect(target.getGraphSnapshot().nodes[0].data.result).toBeUndefined()
  })
})
