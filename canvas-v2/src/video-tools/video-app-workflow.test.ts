import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import type { CanvasVideoAssetSummary } from '../host'
import { toCanvasNode, toCanvasRunGraph } from '../App'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { assetInputNodeKind, mediaAssetNodeDimensions, unresolvedMediaPlacementDimensions } from '../library/media-assets'
import { sameCanvasMediaAsset } from '../library/media-result'
import { resolveCanvasNodeModelAvailability, type CanvasNodeSourceCatalog } from '../library/node-model-availability'
import { findAvailableCanvasPosition } from '../editor/node-placement'
import { assertLayerEditorScope, layerEditorScopeToken } from '../image-tools/layer-editor-scope'
import { currentNodeCandidates } from '../runtime/current-batch-candidates'
import { selectNodeCandidate } from '../runtime/run-projection'
import type { VideoCandidateCount } from '../runtime/video-candidate-count'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasCommand } from '../store/canvas-command'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, undoCanvasHistory, redoCanvasHistory } from '../store/history'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { markNodeAndDescendantsDirty } from '../runtime/run-projection'
import { buildCanvasUpstreamReferences } from '../components/upstream-references'
import { parseImageCandidateCount } from '../runtime/image-candidate-count'
import { parseVideoCandidateCount } from '../runtime/video-candidate-count'
import { parseVideoReferenceOrder, videoReferenceIdentityKey, type VideoReferenceOrder } from './video-reference-order'
import { assertEditableVideoNode, buildVideoParameterPatch, inspectVideoNodeParameters, type VideoParameterPatch } from './video-node-parameters'
import { assertCanvasVideoInputCardinality, inspectCanvasVideoInputs } from './video-inputs'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(source)
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source).replace(/^export /, '')
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
const forward: VideoReferenceOrder = { version: 1, slots: [{ edgeId: 'a-video', outputIndex: 0 }, { edgeId: 'b-video', outputIndex: 0 }] }
const reverse: VideoReferenceOrder = { version: 1, slots: [...forward.slots].reverse() }
function fixture() {
  function project(record: EditorNodeRecord): CanvasNode { return { ...record, type: record.type as CanvasNode['type'], draggable: !record.locked, data: { prompt: '', status: 'idle', model: '', ...record.data } } }
  let history = createCanvasHistory({ ...createCanvasDocument(), nodes: [
    ...['a', 'b'].map((id) => ({ id, type: 'image-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { result: { kind: 'image', assetId: 'a'.repeat(43), localUrl: '/local.png' } } })),
    { id: 'video', type: 'video-generate', definitionVersion: 1, position: { x: 400, y: 0 }, data: { model: 'minimax-h3-mini', seconds: '5', size: '1280x720', dirty: false, result: { kind: 'video', assetId: 'v'.repeat(43) }, settings: { title: '演示', videoMode: 'fl2va', videoResolution: '480p', videoReferenceOrder: forward } } },
    { id: 'frame', type: 'frame-extract', definitionVersion: 1, position: { x: 800, y: 0 }, data: { dirty: false, settings: { timestampSeconds: 2 }, result: { kind: 'image', assetId: 'i'.repeat(43) } } },
  ], edges: [
    ...['a', 'b'].map((id) => ({ id: `${id}-video`, source: id, target: 'video', sourceHandle: 'out:image', targetHandle: 'in:images' })),
    { id: 'video-frame', source: 'video', target: 'frame', sourceHandle: 'out:video', targetHandle: 'in:video' },
  ] })
  const current = () => ({ nodes: history.present.nodes.map(project), edges: history.present.edges })
  const execute = vi.fn((command: CanvasCommand) => { history = applyCanvasCommand(history, command) })
  const inspectParameters = vi.fn(inspectVideoNodeParameters)
  const e = { getGraphSnapshot: current, graphRef: { get current() { return current() }, set current(_value: ReturnType<typeof current>) {} }, execute, setDirtyNodeIds: vi.fn(), setBanner: vi.fn(), canvasNodeDocumentRecord, markNodeAndDescendantsDirty,
    draftActionsEnabledRef: { current: true }, projectTransitionRef: { current: false }, activeRunsRef: { current: new Set<string>() }, startingRunsRef: { current: 0 }, pendingRunProjectionIdsRef: { current: new Set<string>() },
    runGroupsRef: { current: { videoModel: 'grok-imagine-video', videoProtocol: 'relay-videos' as const } },
    nodeSourceCatalogRef: { current: {} as CanvasNodeSourceCatalog }, mediaModelsRef: { current: { image: [], video: ['minimax-h3-mini', 'grok-imagine-video'], text: [] } }, resolveCanvasNodeModelAvailability,
    assetPage: { items: [] }, assertEditableVideoNode, buildVideoParameterPatch, inspectVideoNodeParameters: inspectParameters, assertCanvasVideoInputCardinality, inspectCanvasVideoInputs, toCanvasRunGraph, confirmedRunGroups: () => ({ image: '', video: '', videoProtocol: 'relay-videos' }), parseVideoCandidateCount, parseVideoReferenceOrder, videoReferenceIdentityKey, buildCanvasUpstreamReferences, toWorkflowEdge: (edge: unknown) => edge, dirtyCanvasNodeIds: (nodes: CanvasNode[]) => new Set(nodes.filter((node) => node.data.dirty).map((node) => node.id)),
  }
  const markDirtyFrom = actual<(nodeId: string, patch: object, discrete: boolean) => void>('markDirtyFrom', e)
  const change = actual<(nodeId: string, patch?: VideoParameterPatch) => void>('changeVideoParameters', { ...e, markDirtyFrom })
  const order = actual<(nodeId: string, order: VideoReferenceOrder) => void>('changeVideoReferenceOrder', { ...e, markDirtyFrom })
  const remove = actual<(nodeId: string, edgeId: string) => void>('removeVideoReference', e)
  const count = actual<(nodeId: string, count: VideoCandidateCount) => void>('changeVideoCandidateCount', { ...e, markDirtyFrom })
  function alter(mutator: (document: typeof history.present) => void) { const next = structuredClone(history.present); mutator(next); history = { ...history, present: next } }
  return { e, current, change, order, remove, count, history: () => history, alter }
}

describe('actual App video reference and parameter workflow', () => {
  it('resets from the actual all-router image count instead of the single connecting wire', () => {
    const f = fixture()
    f.alter((doc) => {
      doc.nodes.find((node) => node.id === 'b')!.data.result = { kind: 'image', assetId: 'b'.repeat(43), localUrl: '/second.png' }
      doc.nodes.push({ id: 'route', type: 'router', definitionVersion: 1, position: { x: 200, y: 0 }, data: { settings: { routerStrategy: { version: 1, strategy: 'all' } } } })
      doc.nodes.find((node) => node.id === 'video')!.data.settings = { title: 'Keep title' }
      doc.edges = [{ id: 'a-route', source: 'a', target: 'route', sourceHandle: 'out:image', targetHandle: 'in:images' }, { id: 'b-route', source: 'b', target: 'route', sourceHandle: 'out:image', targetHandle: 'in:images' }, { id: 'route-video', source: 'route', target: 'video', sourceHandle: 'out:image', targetHandle: 'in:images' }]
    })
    f.change('video')
    expect(f.e.inspectVideoNodeParameters).toHaveBeenCalledWith(expect.anything(), 'minimax-h3-mini', 'relay-videos', 2)
    expect(f.e.setBanner).not.toHaveBeenCalled()
  })

  it('refuses an unknown batch reset while keeping explicit user model editing available', () => {
    const f = fixture()
    f.alter((doc) => {
      const upstream = doc.nodes.find((node) => node.id === 'a')!
      upstream.type = 'image-generate'; upstream.data = { model: 'unknown-image-alias' }
      doc.edges = [{ id: 'a-video', source: 'a', target: 'video', sourceHandle: 'out:images', targetHandle: 'in:images' }]
      doc.nodes.find((node) => node.id === 'video')!.data.settings = {}
    })
    const before = structuredClone(f.history().present)
    f.change('video')
    expect(f.e.setBanner).toHaveBeenCalledWith(expect.stringContaining('展开数量尚未确认'))
    expect(f.e.execute).not.toHaveBeenCalled(); expect(f.history().present).toEqual(before)
    f.change('video', { model: 'grok-imagine-video' })
    expect(f.e.execute).toHaveBeenCalledOnce()
  })
  it('swaps repeated asset slots, invalidates descendants and preserves old outputs with one undo', () => {
    const f = fixture(), before = f.history().present
    f.order('video', reverse)
    expect(f.e.execute).toHaveBeenCalledOnce()
    expect(f.e.execute.mock.calls[0][0]).toMatchObject({ type: 'replace-nodes', mergeKey: undefined })
    const after = f.history().present
    expect(after.nodes.find((n) => n.id === 'video')?.data.settings).toMatchObject({ videoReferenceOrder: reverse, title: '演示' })
    for (const id of ['video', 'frame']) { expect(after.nodes.find((n) => n.id === id)?.data.dirty).toBe(true); expect(after.nodes.find((n) => n.id === id)?.data.result).toEqual(before.nodes.find((n) => n.id === id)?.data.result) }
    expect(undoCanvasHistory(f.history()).present).toEqual(before)
    expect(redoCanvasHistory(undoCanvasHistory(f.history())).present).toEqual(after)
    f.order('video', reverse); expect(f.e.execute).toHaveBeenCalledOnce()
  })
  it('preserves incompatible parameters across model switches and explicitly resets them in one separate undo', () => {
    const f = fixture(); f.change('video', { model: 'grok-imagine-video' })
    const beforeReset = f.history().present, video = f.current().nodes.find((n) => n.id === 'video')!
    expect(video.data.settings).toMatchObject({ videoMode: 'fl2va', videoResolution: '480p', videoReferenceOrder: forward })
    expect(inspectVideoNodeParameters(video.data, video.data.model).errors).toHaveLength(2)
    f.change('video')
    const reset = f.current().nodes.find((n) => n.id === 'video')!
    expect(reset.data.settings).toEqual({ title: '演示', videoReferenceOrder: forward })
    expect(reset.data.result).toEqual(video.data.result)
    expect(undoCanvasHistory(f.history()).present).toEqual(beforeReset)
    expect(f.e.execute).toHaveBeenCalledTimes(2)
    expect(f.e.setBanner).not.toHaveBeenCalled()
  })
  it('uses the fixed source catalog for a model switch and rejects a model that only exists in the canvas default', () => {
    const f = fixture()
    f.alter((doc) => { doc.nodes.find((node) => node.id === 'video')!.data.group = 'fixed-video' })
    f.e.mediaModelsRef.current.video = ['minimax-h3-mini']
    f.e.nodeSourceCatalogRef.current = { 'fixed-video': { state: 'ready', models: ['grok-imagine-video'], purposes: ['video'], videoProtocol: 'relay-videos' } }
    const before = structuredClone(f.history().present)
    f.change('video', { model: 'minimax-h3-mini' })
    expect(f.e.execute).not.toHaveBeenCalled(); expect(f.history().present).toEqual(before)
    expect(f.e.setBanner).toHaveBeenCalledWith('此节点来源不提供所选视频模型，请重新选择')
    f.change('video', { model: 'grok-imagine-video' })
    expect(f.e.execute).toHaveBeenCalledOnce()
    expect(f.current().nodes.find((node) => node.id === 'video')!.data).toMatchObject({ group: 'fixed-video', model: 'grok-imagine-video', settings: { videoMode: 'fl2va', videoResolution: '480p' } })
    expect(undoCanvasHistory(f.history()).present).toEqual(before)
    f.e.nodeSourceCatalogRef.current = {}
    f.change('video', { seconds: '8' })
    expect(f.e.execute).toHaveBeenCalledOnce()
    expect(f.e.setBanner).toHaveBeenLastCalledWith('节点固定来源尚未核对或已不存在，请刷新模型来源')
  })
  it.each(['disabled', 'transition', 'running', 'starting', 'projection', 'locked', 'node-disabled', 'queued', 'missing'] as const)('refuses both mutations while %s', (kind) => {
    const f = fixture()
    if (kind === 'disabled') f.e.draftActionsEnabledRef.current = false
    if (kind === 'transition') f.e.projectTransitionRef.current = true
    if (kind === 'running') f.e.activeRunsRef.current.add('run')
    if (kind === 'starting') f.e.startingRunsRef.current = 1
    if (kind === 'projection') f.e.pendingRunProjectionIdsRef.current.add('projection')
    f.alter((doc) => { const n = doc.nodes.find((n) => n.id === 'video')!; if (kind === 'locked') n.locked = true; if (kind === 'node-disabled') n.disabled = true; if (kind === 'queued') n.data.status = 'queued'; if (kind === 'missing') doc.nodes = doc.nodes.filter((n) => n.id !== 'video') })
    const before = structuredClone(f.history().present)
    f.change('video', { seconds: '8' }); f.order('video', reverse); f.remove('video', 'a-video')
    expect(f.e.execute).not.toHaveBeenCalled(); expect(f.history().present).toEqual(before); expect(f.e.setBanner).toHaveBeenCalledTimes(3)
  })
  it('removes an explicit reference and its saved slots atomically with a reversible graph change', () => {
    const f = fixture(), before = f.history().present
    f.remove('video', 'a-video')
    expect(f.e.execute).toHaveBeenCalledOnce()
    expect(f.history().present.edges.map((edge) => edge.id)).toEqual(['b-video', 'video-frame'])
    expect(f.current().nodes.find((node) => node.id === 'video')?.data.settings?.videoReferenceOrder).toEqual({ version: 1, slots: [{ edgeId: 'b-video', outputIndex: 0 }] })
    expect(undoCanvasHistory(f.history()).present).toEqual(before)
    f.remove('video', 'video-frame'); expect(f.e.execute).toHaveBeenCalledOnce()
  })
  it('rejects forged slots but allows deliberate removal of a disconnected saved position', () => {
    const f = fixture(); f.order('video', { version: 1, slots: [{ edgeId: 'forged', outputIndex: 0 }] })
    expect(f.e.execute).not.toHaveBeenCalled()
    f.alter((doc) => { doc.edges = doc.edges.filter((e) => e.id !== 'a-video') })
    f.order('video', { version: 1, slots: [{ edgeId: 'b-video', outputIndex: 0 }] })
    expect(f.e.execute).toHaveBeenCalledOnce()
  })
  it('serializes an explicit slot version for every new video run without changing asset inputs', () => {
    const f = fixture()
    const run = actual<(nodes: CanvasNode[], edges: unknown[], groups: object) => { nodes: Array<{ id: string; data: Record<string, unknown> }> }>('toCanvasRunGraph', { parseImageCandidateCount, parseVideoCandidateCount, isCanvasGraphNode: () => true, isImageTransformNodeKind: () => false, parseVideoReferenceOrder, toWorkflowEdge: (edge: unknown) => edge })
    const graph = run(f.current().nodes, f.current().edges, { image: '', video: 'qa' })
    expect(graph.nodes.find((n) => n.id === 'video')?.data.videoReferenceOrder).toEqual(forward)
    expect(graph.nodes.find((n) => n.id === 'a')?.data).not.toHaveProperty('videoReferenceOrder')
    f.alter((doc) => { delete (doc.nodes.find((n) => n.id === 'video')!.data.settings as Record<string, unknown>).videoReferenceOrder })
    expect(run(f.current().nodes, f.current().edges, { image: '', video: 'qa' }).nodes.find((n) => n.id === 'video')?.data.videoReferenceOrder).toEqual({ version: 1, slots: [] })
  })
})

describe('actual App video quantity history', () => {
  it('changes only the count and dirty flags in one transaction, retaining old videos and undoing once', () => {
    const f = fixture()
    f.alter((doc) => { Object.assign(doc.nodes.find((node) => node.id === 'video')!.data, { videoCandidateCount: 2, candidateAssetIds: ['v'.repeat(43), 'w'.repeat(43)] }) })
    const before = structuredClone(f.history().present)
    f.count('video', 4)
    const after = f.history().present, video = after.nodes.find((node) => node.id === 'video')!
    expect(f.e.execute).toHaveBeenCalledOnce(); expect(f.e.execute.mock.calls[0][0]).toMatchObject({ type: 'replace-nodes', mergeKey: undefined })
    expect(video.data.videoCandidateCount).toBe(4); expect(video.data.candidateAssetIds).toEqual(['v'.repeat(43), 'w'.repeat(43)])
    expect(video.data.result).toEqual(before.nodes.find((node) => node.id === 'video')!.data.result)
    expect(video.data.settings).toEqual(before.nodes.find((node) => node.id === 'video')!.data.settings)
    expect(after.nodes.find((node) => node.id === 'frame')!.data.dirty).toBe(true)
    expect(undoCanvasHistory(f.history()).present).toEqual(before)
    expect(redoCanvasHistory(undoCanvasHistory(f.history())).present).toEqual(after)
    f.count('video', 4); expect(f.e.execute).toHaveBeenCalledOnce()
  })
  it.each(['disabled', 'transition', 'running', 'starting', 'projection', 'locked', 'node-disabled', 'queued', 'missing', 'group-locked'] as const)('blocks quantity edits while %s', (kind) => {
    const f = fixture()
    if (kind === 'disabled') f.e.draftActionsEnabledRef.current = false
    if (kind === 'transition') f.e.projectTransitionRef.current = true
    if (kind === 'running') f.e.activeRunsRef.current.add('run')
    if (kind === 'starting') f.e.startingRunsRef.current = 1
    if (kind === 'projection') f.e.pendingRunProjectionIdsRef.current.add('projection')
    f.alter((doc) => {
      const node = doc.nodes.find((entry) => entry.id === 'video')!
      if (kind === 'locked') node.locked = true
      if (kind === 'node-disabled') node.disabled = true
      if (kind === 'queued') node.data.status = 'queued'
      if (kind === 'missing') doc.nodes = doc.nodes.filter((entry) => entry.id !== 'video')
      if (kind === 'group-locked') { node.parentId = 'locked-group'; doc.nodes.push({ id: 'locked-group', type: 'group', definitionVersion: 1, locked: true, position: { x: 0, y: 0 }, data: {} }) }
    })
    const before = structuredClone(f.history().present)
    f.count('video', 4)
    expect(f.e.execute).not.toHaveBeenCalled(); expect(f.history().present).toEqual(before)
    expect(f.e.setBanner).toHaveBeenCalledOnce()
  })
  it('rejects invalid quantity without mutating history or reinterpreting the input', () => {
    const f = fixture()
    // @ts-expect-error Exercise the actual runtime boundary, not the TypeScript union.
    f.count('video', 2.5)
    expect(f.e.execute).not.toHaveBeenCalled(); expect(f.e.setBanner).toHaveBeenCalledWith('视频生成数量必须为 1 到 4 的整数')
  })
})

const videoAssetIds = ['v'.repeat(43), 'w'.repeat(43)]
function videoAsset(assetId = videoAssetIds[1]): CanvasVideoAssetSummary {
  return { assetId, mediaType: 'video', mimeType: 'video/mp4', fileName: 'saved-video.mp4', taskId: `task-${assetId[0]}`, localUrl: `xingmang-asset://video/${assetId}`, thumbnailUrl: '', createdAt: '', width: 320, height: 180, durationSeconds: 3 }
}
function deferred<T>() { let resolve: (value: T) => void = () => undefined; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
async function settled() { await new Promise<void>((resolve) => setTimeout(resolve, 0)) }
function placementFixture() {
  const f = fixture()
  f.alter((doc) => { Object.assign(doc.nodes.find((node) => node.id === 'video')!.data, { videoCandidateCount: 2, candidateAssetIds: videoAssetIds }) })
  const getAssetDetail = vi.fn(async (id: string): Promise<CanvasVideoAssetSummary> => videoAsset(id)), generateVideo = vi.fn(), startRun = vi.fn()
  let sequence = 0
  const env = { ...f.e, getGraphSnapshot: f.current, currentNodeCandidates, selectNodeCandidate, sameCanvasMediaAsset,
    mediaPreparationMountedRef: { current: true }, layerEditorOwnerRef: { current: { ownerId: 7, accountId: 'qa' } }, activeProjectIdRef: { current: 'project' }, projectEpochRef: { current: 1 },
    layerEditorScopeToken, assertLayerEditorScope, videoPlacementPendingRef: { current: new Set<string>() }, assetCatalog: videoAssetIds.map((id) => videoAsset(id)),
    hostBridge: () => ({ getAssetDetail, generateVideo, startRun }),
    builtinNodeRegistry, assetInputNodeKind, mediaAssetNodeDimensions, unresolvedMediaPlacementDimensions, findAvailableCanvasPosition, toCanvasNode,
    mediaAssetRef: actual('mediaAssetRef', {}), nextNodeId: () => `placed-video-${++sequence}`, createdNodeFocusRef: { current: null }, document: { querySelector: () => null }, setNodes: vi.fn(),
  }
  const createAssetNode = actual<(asset: CanvasVideoAssetSummary) => void>('createAssetNode', env)
  const place = actual<(nodeId: string, candidateId: string) => void>('placeVideoCandidate', { ...env, createAssetNode })
  function candidates() { const node = f.current().nodes.find((entry) => entry.id === 'video')!; return currentNodeCandidates(node.id, node.type, node.data, env.assetCatalog) }
  function adopt(candidateId: string) { return actual<(nodeId: string, candidateId: string) => void>('useCandidate', { ...env, nodes: f.current().nodes, edges: f.current().edges })('video', candidateId) }
  return { ...f, env, getAssetDetail, generateVideo, startRun, place, candidates, adopt }
}

describe('actual App saved video candidate actions', () => {
  it('verifies the exact candidate once, places a separate video input and makes the whole action one undo step', async () => {
    const f = placementFixture(), pending = deferred<CanvasVideoAssetSummary>(), candidateId = f.candidates()[1].candidateId
    f.getAssetDetail.mockReturnValueOnce(pending.promise)
    const before = structuredClone(f.history().present)
    f.place('video', candidateId); f.place('video', candidateId)
    expect(f.getAssetDetail).toHaveBeenCalledExactlyOnceWith(videoAssetIds[1]); expect(f.e.execute).not.toHaveBeenCalled()
    pending.resolve(videoAsset()); await settled()
    expect(f.e.execute).toHaveBeenCalledOnce(); expect(f.e.execute.mock.calls[0][0]).toMatchObject({ type: 'add-nodes' })
    const after = f.history().present, added = after.nodes.at(-1)!
    expect(added.type).toBe('video-input'); expect(added.data.result).toMatchObject({ assetId: videoAssetIds[1], kind: 'video', durationSeconds: 3 })
    expect(after.nodes.slice(0, before.nodes.length)).toEqual(before.nodes); expect(after.edges).toEqual(before.edges)
    expect(undoCanvasHistory(f.history()).present).toEqual(before); expect(redoCanvasHistory(undoCanvasHistory(f.history())).present).toEqual(after)
    expect(f.generateVideo).not.toHaveBeenCalled(); expect(f.startRun).not.toHaveBeenCalled(); expect(f.env.videoPlacementPendingRef.current.size).toBe(0)
  })
  it.each(['project', 'account', 'owner', 'epoch', 'unmounted', 'disabled', 'transition', 'running', 'starting', 'projection', 'locked', 'group-locked', 'node-disabled', 'queued', 'missing', 'candidate-removed', 'candidate-rebound'] as const)('rejects a slow asset result after %s changes', async (change) => {
    const f = placementFixture(), pending = deferred<CanvasVideoAssetSummary>(), candidateId = f.candidates()[1].candidateId
    f.getAssetDetail.mockReturnValueOnce(pending.promise); f.place('video', candidateId)
    if (change === 'project') f.env.activeProjectIdRef.current = 'other'
    if (change === 'account') f.env.layerEditorOwnerRef.current.accountId = 'other'
    if (change === 'owner') f.env.layerEditorOwnerRef.current.ownerId = 9
    if (change === 'epoch') f.env.projectEpochRef.current++
    if (change === 'unmounted') f.env.mediaPreparationMountedRef.current = false
    if (change === 'disabled') f.env.draftActionsEnabledRef.current = false
    if (change === 'transition') f.env.projectTransitionRef.current = true
    if (change === 'running') f.env.activeRunsRef.current.add('run')
    if (change === 'starting') f.env.startingRunsRef.current = 1
    if (change === 'projection') f.env.pendingRunProjectionIdsRef.current.add('projection')
    f.alter((doc) => {
      const node = doc.nodes.find((entry) => entry.id === 'video')!
      if (change === 'locked') node.locked = true
      if (change === 'node-disabled') node.disabled = true
      if (change === 'queued') node.data.status = 'queued'
      if (change === 'missing') doc.nodes = doc.nodes.filter((entry) => entry.id !== 'video')
      if (change === 'candidate-removed') node.data.candidateAssetIds = [videoAssetIds[0]]
      if (change === 'candidate-rebound') { node.data.candidateAssetIds = [videoAssetIds[0], 'z'.repeat(43)]; node.data.candidates = [{ candidateId, attemptId: 'other', createdAt: '', asset: { kind: 'video', assetId: 'z'.repeat(43) } }] }
      if (change === 'group-locked') { node.parentId = 'locked-group'; doc.nodes.push({ id: 'locked-group', type: 'group', definitionVersion: 1, locked: true, position: { x: 0, y: 0 }, data: {} }) }
    })
    const beforeResolution = structuredClone(f.history().present)
    pending.resolve(videoAsset()); await settled()
    expect(f.e.execute).not.toHaveBeenCalled(); expect(f.history().present).toEqual(beforeResolution)
    expect(f.env.videoPlacementPendingRef.current.size).toBe(0); expect(f.generateVideo).not.toHaveBeenCalled()
  })
  it.each(['wrong-id', 'wrong-kind', 'deleted', 'rejected'] as const)('does not place an unverified asset on %s and clears pending for a deliberate retry', async (kind) => {
    const f = placementFixture(), candidateId = f.candidates()[1].candidateId
    if (kind === 'rejected') f.getAssetDetail.mockRejectedValueOnce(new Error('素材不属于当前账号'))
    else {
      const asset = videoAsset()
      if (kind === 'wrong-id') asset.assetId = videoAssetIds[0]
      if (kind === 'deleted') asset.deletedAt = '2026-10-15T00:00:00Z'
      if (kind === 'wrong-kind') Object.assign(asset, { mediaType: 'image' })
      f.getAssetDetail.mockResolvedValueOnce(asset)
    }
    f.place('video', candidateId); await settled()
    expect(f.e.execute).not.toHaveBeenCalled(); expect(f.env.videoPlacementPendingRef.current.size).toBe(0)
    f.place('video', candidateId); await settled(); expect(f.e.execute).toHaveBeenCalledOnce(); expect(f.getAssetDetail).toHaveBeenCalledTimes(2)
  })
  it('adopts a restored candidate with one undo and keeps the source video configuration intact', () => {
    const f = placementFixture(), before = structuredClone(f.history().present), target = f.candidates()[1]
    f.adopt(target.candidateId)
    expect(f.e.execute).toHaveBeenCalledOnce()
    const video = f.current().nodes.find((node) => node.id === 'video')!
    expect(video.data.result?.assetId).toBe(videoAssetIds[1]); expect(video.data.videoCandidateCount).toBe(2)
    expect(video.data.candidateAssetIds).toEqual(videoAssetIds); expect(f.current().nodes.find((node) => node.id === 'frame')?.data.dirty).toBe(true)
    expect(undoCanvasHistory(f.history()).present).toEqual(before)
    f.adopt(target.candidateId); expect(f.e.execute).toHaveBeenCalledOnce(); expect(f.getAssetDetail).not.toHaveBeenCalled(); expect(f.startRun).not.toHaveBeenCalled()
  })
  it.each(['disabled', 'transition', 'running', 'starting', 'projection', 'locked', 'queued'] as const)('protects adopted output while %s', (kind) => {
    const f = placementFixture(), candidateId = f.candidates()[1].candidateId
    if (kind === 'disabled') f.env.draftActionsEnabledRef.current = false
    if (kind === 'transition') f.env.projectTransitionRef.current = true
    if (kind === 'running') f.env.activeRunsRef.current.add('run')
    if (kind === 'starting') f.env.startingRunsRef.current = 1
    if (kind === 'projection') f.env.pendingRunProjectionIdsRef.current.add('projection')
    f.alter((doc) => { const node = doc.nodes.find((entry) => entry.id === 'video')!; if (kind === 'locked') node.locked = true; if (kind === 'queued') node.data.status = 'queued' })
    const before = structuredClone(f.history().present); f.adopt(candidateId)
    expect(f.e.execute).not.toHaveBeenCalled(); expect(f.history().present).toEqual(before)
  })
})
