import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CanvasRunCandidate, CanvasRunRecord } from '../host'
import type { AssetRef, WorkflowNode } from '../model'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow } from '../model'
import { editorNodeToCanvasNode, toCanvasNode, toWorkflowNode } from '../App'
import { RunInspector } from '../components/RunInspector'
import { fixNodeCandidate, projectRunRecordToNodes, selectNodeCandidate } from '../runtime/run-projection'
import { mergeKnownCanvasMediaMetadata, sameCanvasMediaAsset } from './media-result'

const at = '2026-10-10T12:00:00.000Z'
const videoId = 'a'.repeat(43)

function video(metadata: Partial<AssetRef> = {}): AssetRef {
  return { kind: 'video', assetId: videoId, localUrl: `xingmang-asset://video/${videoId}`, mimeType: 'video/mp4', ...metadata }
}

function candidate(asset: AssetRef = video()): CanvasRunCandidate {
  if (!asset.assetId || !asset.localUrl) throw new Error('test candidate must have a complete media reference')
  return { candidateId: 'candidate', attemptId: 'attempt', createdAt: at, asset: { ...asset, assetId: asset.assetId, localUrl: asset.localUrl } }
}

function run(asset: AssetRef = video(), cached = false): CanvasRunRecord {
  return {
    version: 1, runId: 'run', userId: 1, ownerId: 1, graphRevision: 'revision', scope: { kind: 'all' }, status: 'succeeded', createdAt: at, startedAt: at, events: [],
    nodes: [{ nodeId: 'video', kind: 'video-input', state: cached ? 'cached' : 'succeeded', attempts: [{ attemptId: 'attempt', fingerprint: 'fingerprint', state: cached ? 'cached' : 'succeeded', startedAt: at, completedAt: at, durationMs: 10, cached, candidates: [candidate(asset)] }] }],
  }
}

function videoNode(result: AssetRef = video({ width: 320, height: 180, durationSeconds: 2 })): WorkflowNode {
  return { id: 'video', kind: 'video-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'succeeded', result } }
}

function inspectorHtml(record: CanvasRunRecord, result: AssetRef | undefined): string {
  return renderToStaticMarkup(createElement(RunInspector, {
    open: true, records: [record], selectedRunId: record.runId, resultAssets: { video: result }, selectedScope: 'all', dirtyCount: 0, selectionCount: 0, loading: false,
    onScopeChange: () => undefined, onRefresh: () => undefined, onSelectRun: () => undefined, onUseCandidate: () => undefined, onPreviewAsset: () => undefined, onAssetMenu: () => undefined, onLocateNode: () => undefined, onClose: () => undefined,
  }))
}

describe('owned media result metadata', () => {
  it.each(['image', 'video', 'audio'] as const)('retains decoded %s facts through repeated terminal and cached projection', (kind) => {
    const known = { ...video(), kind, width: kind === 'audio' ? undefined : 320, height: kind === 'audio' ? undefined : 180, durationSeconds: kind === 'image' ? undefined : 2 }
    const incoming = { ...video(), kind }
    const original = [videoNode(known)]
    const projected = projectRunRecordToNodes(original, run(incoming))
    const repeated = projectRunRecordToNodes(projected, run(incoming, true))
    expect(repeated[0].data.result).toEqual(known)
    expect(repeated[0].data.candidates?.[0].asset).toEqual(known)
    expect(repeated[0].data.dirty).toBe(false)
    expect(original[0].data.result).toEqual(known)
  })

  it('prefers valid incoming metadata without retaining old URLs or task information', () => {
    const previous = video({ width: 320, height: 180, durationSeconds: 2, remoteUrl: 'https://old.invalid/private', taskId: 'old-task' })
    const incoming = video({ width: 640, height: 360, durationSeconds: 3, localUrl: `/api/assets/${videoId}/content` })
    expect(mergeKnownCanvasMediaMetadata(incoming, [previous])).toEqual(incoming)
  })

  it('fills each missing fact from the same asset while rejecting invalid metadata', () => {
    const incoming = video({ width: 0, height: Number.NaN, durationSeconds: Number.POSITIVE_INFINITY })
    const result = mergeKnownCanvasMediaMetadata(incoming, [video({ width: 320, durationSeconds: -1 }), video({ height: 180, durationSeconds: 2 })])
    expect(result).toMatchObject({ width: 320, height: 180, durationSeconds: 2 })
    expect(mergeKnownCanvasMediaMetadata(video({ width: -1, height: 1.5, durationSeconds: 86_401 }), [])).toEqual(video())
  })

  it.each([
    video({ assetId: 'b'.repeat(43) }),
    { ...video(), kind: 'image' as const },
    video({ assetId: undefined }),
    video({ assetId: '' }),
    video({ assetId: ' ' }),
  ])('does not inherit measurements across missing or different media identities', (incoming) => {
    expect(mergeKnownCanvasMediaMetadata(incoming, [video({ width: 320, height: 180, durationSeconds: 2 })])).toEqual(incoming)
    expect(sameCanvasMediaAsset(incoming, video())).toBe(false)
  })

  it('enriches stale candidates without replacing the current asset or clearing dirty', () => {
    const current = videoNode(video({ assetId: 'b'.repeat(43), width: 640, height: 360, durationSeconds: 4 }))
    current.data.dirty = true
    current.data.candidates = [{ ...candidate(video({ width: 320, height: 180, durationSeconds: 2 })) }]
    const projected = projectRunRecordToNodes([current], run(), [], new Set())
    expect(projected[0].data.result).toEqual(current.data.result)
    expect(projected[0].data.dirty).toBe(true)
    expect(projected[0].data.candidates?.[0].asset).toMatchObject({ width: 320, height: 180, durationSeconds: 2 })
  })

  it('does not dirty descendants or replace decoded facts when selecting the same asset after reopening', () => {
    const owner = videoNode()
    const downstream: WorkflowNode = { id: 'gallery', kind: 'gallery', position: { x: 400, y: 0 }, data: { prompt: '', model: '', status: 'succeeded', dirty: false } }
    const nodes = [owner, downstream]
    const edges = [{ id: 'edge', source: 'video', sourceHandle: 'out:video', target: 'gallery', targetHandle: 'in:video' }]
    expect(selectNodeCandidate(nodes, edges, 'video', candidate())).toEqual(nodes)
    expect(selectNodeCandidate(nodes, edges, 'video', candidate())[0]).toBe(owner)
    owner.data.candidates = [candidate()]
    expect(fixNodeCandidate(nodes, edges, 'video', 'candidate')).toEqual(nodes)
    expect(nodes[1].data.dirty).toBe(false)
  })

  it('keeps same-asset candidate facts when switching from a different current asset', () => {
    const owner = videoNode(video({ assetId: 'b'.repeat(43), width: 640, height: 360, durationSeconds: 4 }))
    owner.data.candidates = [candidate(video({ width: 320, height: 180, durationSeconds: 2 }))]
    const selected = selectNodeCandidate([owner], [], 'video', 'candidate')
    expect(selected[0].data.result).toMatchObject({ assetId: videoId, width: 320, height: 180, durationSeconds: 2 })
  })

  it('renders the actual saved asset as current after persistence and editor roundtrip without candidate IDs', () => {
    const projected = projectRunRecordToNodes([videoNode()], run())
    const workflow = createEmptyWorkflow('video metadata')
    workflow.nodes = projected.map((node) => toWorkflowNode(toCanvasNode(node)))
    const restored = parseWorkflowFile(serializeWorkflow(workflow))
    if (!restored) throw new Error('test workflow did not restore')
    const node = restored.nodes[0]
    const reopened = editorNodeToCanvasNode({ id: node.id, type: node.kind, definitionVersion: node.definitionVersion ?? 1, position: node.position, data: { ...node.data } })
    expect(reopened.data.adoptedCandidateId).toBeUndefined()
    expect(reopened.data.result).toMatchObject({ kind: 'video', assetId: videoId, width: 320, height: 180, durationSeconds: 2 })
    const html = inspectorHtml(run(), reopened.data.result)
    expect(html).toContain('当前产物')
    expect(html).not.toContain('>设为产物<')
    expect(html).toContain('disabled=""')
  })

  it('ignores measurement differences for current-product identity but rejects another kind or asset', () => {
    expect(sameCanvasMediaAsset(video({ width: 320, height: 180, durationSeconds: 2 }), video())).toBe(true)
    expect(inspectorHtml(run(), video({ assetId: 'b'.repeat(43) }))).toContain('设为产物')
    expect(inspectorHtml(run(), { ...video(), kind: 'image' })).toContain('设为产物')
  })
})
