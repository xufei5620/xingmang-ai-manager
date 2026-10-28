import { parseImageCandidateCount } from '../runtime/image-candidate-count'
import { parseVideoCandidateCount } from '../runtime/video-candidate-count'
import { parseVideoGenerateAudio } from '../runtime/video-audio'
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasImageAssetSummary, CanvasRunGraph, CanvasRunRecord, CanvasRunScope } from '../host'
import { layerEditorScopeToken } from '../image-tools/layer-editor-scope'
import { defaultImageTransformRecipe, imageTransformRecipeForNode, isImageTransformNodeKind } from '../image-tools/recipe'
import { parseImageCollageInputOrder } from '../image-tools/collage-input-order'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { createOutputImagePlacementCoordinator } from '../runtime/output-image-placement'
import { cachedNodeIdsForPreflight } from '../runtime/pinned-reuse'
import { buildCanvasRunPreflight, sameCanvasRunGraphSnapshot, type CanvasRunPreflight } from '../runtime/run-preflight'
import type { CanvasCommand } from '../store/canvas-command'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { createdNodeFocusZoom } from './node-focus'
import { buildOutputImageNodes, nodeOutputImageIds } from './output-image-nodes'
import { canvasNodeKindAvailable } from '../host-capabilities'
import { fullCanvasCapabilityProfile } from '../host-capabilities.test-fixture'
import { canvasRunInputForHost, withoutHostDisabledDefaults } from '../runtime/host-run-compatibility'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(source)
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source).replace(/^export /, '')
    if (ts.isBinaryExpression(node) && node.left.getText(source) === name && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) expression = node.right.getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
const firstId = 'a'.repeat(43), secondId = 'b'.repeat(43)
function asset(assetId = firstId): CanvasImageAssetSummary & { displayName: string } { return { assetId, mediaType: 'image', mimeType: 'image/png', localUrl: `xingmang-asset://image/${assetId}`, thumbnailUrl: '', fileName: 'image.png', displayName: '测试成品', width: 960, height: 720, createdAt: '' } }
function deferred<T>() { let resolve: (value: T) => void = () => undefined; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function toCanvas(node: EditorNodeRecord): CanvasNode { return { ...node, type: node.type as CanvasNode['type'], draggable: !node.locked, data: { prompt: '', model: '', status: 'idle', ...node.data } } }
type Adapter = Parameters<typeof createOutputImagePlacementCoordinator>[0]
interface Pending { graph: CanvasRunGraph; scope: CanvasRunScope; outputPlacement?: { nodeId: string; editorScope: string } }
function fixture(kind: 'image-collage' | 'image-grid-split' = 'image-collage', paid = false) {
  const initial: EditorNodeRecord[] = [
    { ...builtinNodeRegistry.create(paid ? 'image-generate' : 'image-input', 'input', { x: 0, y: 0 }), data: { prompt: 'test', model: paid ? 'gpt-image-1' : '', size: '1024x1024', quality: 'low', status: 'succeeded', result: { kind: 'image', assetId: firstId } } },
    { ...builtinNodeRegistry.create(kind, 'tool', { x: 500, y: 0 }), data: { prompt: '', model: '', status: 'succeeded', result: { kind: 'image', assetId: firstId }, candidateAssetIds: [firstId, secondId], settings: { imageTransform: defaultImageTransformRecipe(kind === 'image-collage' ? 'collage' : 'grid-split') } } },
  ]
  let history = createCanvasHistory({ ...createCanvasDocument(), nodes: initial, edges: [{ id: 'edge', source: 'input', sourceHandle: 'out:image', target: 'tool', targetHandle: kind === 'image-collage' ? 'in:images' : 'in:image' }] })
  let current = initial.map(toCanvas), sequence = 0
  const execute = vi.fn((command: CanvasCommand) => { history = applyCanvasCommand(history, command); current = history.present.nodes.map(toCanvas) })
  const getGraphSnapshot = () => ({ nodes: current, edges: history.present.edges })
  const setNodes = (update: (nodes: CanvasNode[]) => CanvasNode[]) => { current = update(current) }
  const groups = { image: 'images', video: '', text: '', videoProtocol: 'relay-videos' as const }
  const toCanvasRunGraph = actual<(nodes: CanvasNode[], edges: typeof history.present.edges, selectedGroups: typeof groups) => CanvasRunGraph>('toCanvasRunGraph', { parseImageCandidateCount, parseVideoCandidateCount, parseVideoGenerateAudio, isCanvasGraphNode: actual('isCanvasGraphNode', { builtinNodeRegistry }), toWorkflowEdge: actual('toWorkflowEdge', {}), isImageTransformNodeKind, imageTransformRecipeForNode, parseImageCollageInputOrder })
  const getAssetDetail = vi.fn(async (id: string) => asset(id)), verifyOutputImageReadable = vi.fn(async (): Promise<void> => undefined), startRun = vi.fn(async () => ({ runId: 'run', graphRevision: 'revision' }))
  const setBanner = vi.fn(), markCanvasAssetUsed = vi.fn(), frames: Array<() => void> = []
  const owner = { ownerId: 7, accountId: 'account' }, projectEpochRef = { current: 1 }, activeProjectIdRef = { current: 'project' }
  const outputPlacementAdapterRef: { current: Adapter | null } = { current: null }
  const env = {
    projectCanRunRef: { current: true }, saveBeforeRunRef: { current: vi.fn(async (_graph: CanvasRunGraph): Promise<void> => undefined) },
    outputPlacementAdapterRef, mediaPreparationMountedRef: { current: true }, draftActionsEnabledRef: { current: true }, projectTransitionRef: { current: false }, projectEpochRef, activeProjectIdRef, layerEditorOwnerRef: { current: owner }, layerEditorScopeToken,
    getGraphSnapshot, toCanvasRunGraph, runGroupsRef: { current: groups }, nodeOutputImageIds, buildOutputImageNodes, canvasNodeDocumentRecord, nextNodeId: () => `new-${++sequence}`, execute, setNodes,
    hostBridge: () => ({ getAssetDetail, startRun }), verifyOutputImageReadable, markCanvasAssetUsed, setOutputPendingNodeIds: vi.fn(), setBanner,
    createdNodeFocusRef: { current: { start: vi.fn((_id: string, _size: unknown, callback: (value: unknown) => void) => { frames.push(() => callback({ x: 0, y: 0, width: 280, height: 210 })) }) } },
    currentReactFlowRef: { current: { setCenter: vi.fn(), getViewport: () => ({ zoom: 1 }) } }, createdNodeFocusZoom,
    nodes: current, edges: history.present.edges, imageGroup: groups.image, videoGroup: groups.video, videoProtocol: groups.videoProtocol, textGroup: groups.text, mediaGroups: {}, mediaModelsRef: { current: { image: ['gpt-image-1'], video: [], text: [] } },
    canvasCapabilities: () => fullCanvasCapabilityProfile, canvasNodeKindAvailable, canvasRunInputForHost, withoutHostDisabledDefaults, startingRunsRef: { current: 0 }, resumingTaskIdsRef: { current: new Set() }, buildCanvasRunPreflight, cachedNodeIdsForPreflight, dramaPreflightBlockReasons: () => ({}), rejectPendingMedia: () => false, rejectUnavailableGroups: () => false,
    layerEditorScope: layerEditorScopeToken({ ...owner, projectEpoch: 1, projectId: 'project', enabled: true }),
    imageAssetDimensions: {}, nodeSourceCatalogRef: { current: {} },
    pendingCanvasRun: null as Pending | null, preflight: null as CanvasRunPreflight | null,
    setPendingCanvasRun: (value: Pending | null) => { env.pendingCanvasRun = value }, setRunPreflight: (value: CanvasRunPreflight | null) => { env.preflight = value },
    sameCanvasRunGraphSnapshot, setStartingRuns: vi.fn(), rememberActiveRun: vi.fn(), openInspectorTab: vi.fn(), activeRunsRef: { current: new Map() }, refreshRuns: vi.fn(),
  }
  outputPlacementAdapterRef.current = actual<Adapter>('outputPlacementAdapterRef.current', env)
  const outputPlacementCoordinator = createOutputImagePlacementCoordinator(outputPlacementAdapterRef.current)
  function currentEnvironment() { return { ...env, nodes: current, edges: history.present.edges, outputPlacementCoordinator, inspectPendingAgentExecution: actual<(pending: Pending) => unknown>('inspectPendingAgentExecution', env) } }
  vi.stubGlobal('window', { xingmangCanvasHost: {} }); vi.stubGlobal('document', { querySelector: () => ({ getBoundingClientRect: () => ({ width: 1280, height: 800 }) }) })
  return { env, outputPlacementCoordinator, frames, current: () => current, history: () => history, getAssetDetail, verifyOutputImageReadable, startRun, execute,
    place: actual<(id: string, selection: 'current' | 'all') => void>('placeNodeOutput', currentEnvironment()),
    request: () => actual<(id: string, kind: 'to-node', place: boolean) => boolean>('requestNodeScopeRun', currentEnvironment())('tool', 'to-node', true),
    confirm: () => actual<() => Promise<void>>('confirmCanvasRun', currentEnvironment())(),
    undo: () => { history = undoCanvasHistory(history); current = history.present.nodes.map(toCanvas) }, redo: () => { history = redoCanvasHistory(history); current = history.present.nodes.map(toCanvas) },
    change: (update: (nodes: CanvasNode[]) => CanvasNode[]) => { current = update(current) },
  }
}
async function settled() { await new Promise<void>((resolve) => setTimeout(resolve, 0)) }
function completed(): CanvasRunRecord { return { version: 1, userId: 7, ownerId: 7, runId: 'run', graphRevision: 'revision', projectId: 'project', scope: { kind: 'to-node', nodeId: 'tool' }, status: 'succeeded', createdAt: '', startedAt: '', nodes: [{ nodeId: 'tool', kind: 'image-collage', state: 'succeeded', attempts: [{ attemptId: 'attempt', fingerprint: '', state: 'succeeded', startedAt: '', completedAt: '', durationMs: 1, cached: false, candidates: [{ candidateId: 'candidate', attemptId: 'attempt', createdAt: '', asset: { kind: 'image', assetId: secondId, localUrl: asset(secondId).localUrl } }] }] }], events: [] } }
afterEach(() => vi.unstubAllGlobals())

describe('actual App output image actions', () => {
  it('blocks viewer preflight and stops a formerly permitted confirmation without any save or model request', async () => {
    const f = fixture(); f.env.projectCanRunRef.current = false
    expect(f.request()).toBe(false); expect(f.env.preflight).toBeNull()
    f.env.projectCanRunRef.current = true; f.request(); f.env.projectCanRunRef.current = false
    await f.confirm(); expect(f.startRun).not.toHaveBeenCalled(); expect(f.env.saveBeforeRunRef.current).not.toHaveBeenCalled()
  })
  it('waits for cloud save before requesting execution and preserves the draft when access changes while saving', async () => {
    const f = fixture(), saved = deferred<void>(); f.env.saveBeforeRunRef.current.mockImplementation(() => saved.promise)
    f.request(); const confirming = f.confirm(); expect(f.startRun).not.toHaveBeenCalled()
    f.env.projectCanRunRef.current = false; saved.resolve(); await confirming
    expect(f.startRun).not.toHaveBeenCalled(); expect(f.current()).toHaveLength(2); expect(f.env.setBanner).toHaveBeenCalledWith(expect.stringContaining('权限'))
  })
  it('does not start a run after an authoritative cloud conflict and keeps all original nodes', async () => {
    const f = fixture(); f.env.saveBeforeRunRef.current.mockRejectedValueOnce(new Error('云端版本已变化，草稿保留'))
    f.request(); await f.confirm(); expect(f.startRun).not.toHaveBeenCalled(); expect(f.current()).toHaveLength(2)
    expect(f.env.setBanner).toHaveBeenCalledWith('云端版本已变化，草稿保留')
  })
  it('validates the actual save-before-run graph again after the asynchronous CAS save', async () => {
    const f = fixture(), saved = deferred<void>(), graph = f.env.toCanvasRunGraph(f.current(), f.history().present.edges, f.env.runGroupsRef.current)
    const queueProjectSave = vi.fn(() => saved.promise)
    const save = actual<(graph: CanvasRunGraph) => Promise<void>>('saveBeforeRunRef.current', { ...f.env, latestBrowserSnapshotRef: { current: { project: { id: 'project' }, content: 'exact serialized draft' } }, confirmedRunGroups: () => f.env.runGroupsRef.current, queueProjectSave, autoSaveRevisionRef: { current: 0 } })
    const waiting = save(graph); expect(queueProjectSave).toHaveBeenCalledWith({ id: 'project' }, 'exact serialized draft', 1)
    f.change((nodes) => nodes.map((node) => node.id === 'input' ? { ...node, data: { ...node.data, prompt: 'changed after confirmation' } } : node))
    saved.resolve(); await expect(waiting).rejects.toThrow('保存期间工程或权限已变化')
    expect(f.current()[0].data.prompt).toBe('changed after confirmation'); expect(f.startRun).not.toHaveBeenCalled()
  })

  it('places an existing result only after content verification, without starting a run, and supports undo/redo', async () => {
    const f = fixture(), pending = deferred<void>(); f.verifyOutputImageReadable.mockReturnValue(pending.promise)
    f.place('tool', 'current'); f.place('tool', 'current'); await settled(); expect(f.current()).toHaveLength(2)
    pending.resolve(); await settled(); expect(f.current()).toHaveLength(3); expect(f.startRun).not.toHaveBeenCalled(); expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.current()[2].data.result?.assetId).toBe(firstId); expect(f.current()[2].selected).toBe(true)
    f.undo(); expect(f.current()).toHaveLength(2); f.redo(); expect(f.current()).toHaveLength(3); expect(f.getAssetDetail).toHaveBeenCalledTimes(1)
  })
  it('distinguishes current and all grid outputs and places an entire batch in one history entry', async () => {
    const f = fixture('image-grid-split'); f.change((nodes) => nodes.map((node) => node.id === 'tool' ? { ...node, data: { ...node.data, result: { kind: 'image', assetId: secondId }, dirty: true } } : node))
    f.place('tool', 'current'); await settled(); expect(f.current().at(-1)?.data.result?.assetId).toBe(secondId); f.undo()
    f.place('tool', 'all'); await settled(); expect(f.current().slice(2).map((node) => node.data.result?.assetId)).toEqual([firstId, secondId]); f.undo(); expect(f.current()).toHaveLength(2); f.redo(); expect(f.current()).toHaveLength(4)
  })
  it.each(['project', 'account', 'reopen', 'unmounted', 'transition', 'input', 'deleted'] as const)('does not place a late asset after %s changes', async (change) => {
    const f = fixture(), pending = deferred<void>(); f.verifyOutputImageReadable.mockReturnValue(pending.promise); f.place('tool', 'current'); await settled()
    if (change === 'project') f.env.activeProjectIdRef.current = 'other'
    if (change === 'account') f.env.layerEditorOwnerRef.current = { ownerId: 8, accountId: 'other' }
    if (change === 'reopen') f.env.projectEpochRef.current++
    if (change === 'unmounted') f.env.mediaPreparationMountedRef.current = false
    if (change === 'transition') f.env.projectTransitionRef.current = true
    if (change === 'input') f.change((nodes) => nodes.map((node) => node.id === 'input' ? { ...node, data: { ...node.data, result: { kind: 'image', assetId: secondId } } } : node))
    if (change === 'deleted') f.change((nodes) => nodes.filter((node) => node.id !== 'tool'))
    pending.resolve(); await settled(); expect(f.execute).not.toHaveBeenCalled()
  })
  it('requires preflight confirmation, catches fast terminal completion, and never reruns on undo/redo', async () => {
    const f = fixture(); expect(f.request()).toBe(true); expect(f.env.preflight?.paidRequestCount).toBe(0); expect(f.startRun).not.toHaveBeenCalled()
    f.env.refreshRuns.mockImplementation(() => { f.outputPlacementCoordinator.accept(completed()) })
    await f.confirm(); await settled(); expect(f.current()).toHaveLength(3); expect(f.current()[2].data.result?.assetId).toBe(secondId)
    f.outputPlacementCoordinator.accept(completed()); await settled(); expect(f.current()).toHaveLength(3)
    f.undo(); f.redo(); expect(f.startRun).toHaveBeenCalledTimes(1)
  })
  it('discloses a paid upstream and does not start it from the output button alone', async () => {
    const f = fixture('image-collage', true); expect(f.request()).toBe(true); expect(f.env.preflight?.paidRequestCount).toBe(1); expect(f.startRun).not.toHaveBeenCalled(); expect(f.current()).toHaveLength(2)
  })
  it('uses the latest measured tool size while leaving its content unchanged', async () => {
    const f = fixture(); f.change((nodes) => nodes.map((node) => node.id === 'tool' ? { ...node, measured: { width: 1000, height: 1100 } } : node))
    const before = structuredClone(f.current()); f.place('tool', 'current'); await settled()
    expect(f.current()[2].position.x).toBeGreaterThanOrEqual(1528)
    expect(f.current().slice(0, 2).map((node) => ({ id: node.id, position: node.position, data: node.data }))).toEqual(before.map((node) => ({ id: node.id, position: node.position, data: node.data })))
  })
  it('does not place a failed image read or a completed run whose upstream changed', async () => {
    const f = fixture(); f.verifyOutputImageReadable.mockRejectedValueOnce(new Error('图片不可读取')); f.place('tool', 'current'); await settled(); expect(f.execute).not.toHaveBeenCalled()
    f.request(); await f.confirm(); f.change((nodes) => nodes.map((node) => node.id === 'input' ? { ...node, data: { ...node.data, result: { kind: 'image', assetId: secondId } } } : node))
    f.outputPlacementCoordinator.accept(completed()); await settled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.outputPlacementCoordinator.pending('tool')).toBe(false)
  })
  it('does not confirm a placement from another editor session or submit twice while starting', async () => {
    const stale = fixture(); stale.request(); stale.env.projectEpochRef.current++; await stale.confirm(); expect(stale.startRun).not.toHaveBeenCalled()
    const f = fixture(), pending = deferred<{ runId: string; graphRevision: string }>(); f.startRun.mockReturnValue(pending.promise); f.request(); const first = f.confirm(); await f.confirm(); expect(f.startRun).toHaveBeenCalledTimes(1)
    pending.resolve({ runId: 'run', graphRevision: 'revision' }); await first
  })
  it('preserves placement intent but requires reconfirmation if the graph changes in the dialog', async () => {
    const f = fixture(); f.request(); f.change((nodes) => nodes.map((node) => node.id === 'tool' ? { ...node, data: { ...node.data, settings: { imageTransform: { ...defaultImageTransformRecipe('collage'), gap: 20 } } } } : node))
    await f.confirm(); expect(f.startRun).not.toHaveBeenCalled(); expect(f.env.pendingCanvasRun?.outputPlacement?.nodeId).toBe('tool')
    await f.confirm(); expect(f.startRun).toHaveBeenCalledTimes(1)
  })
})
