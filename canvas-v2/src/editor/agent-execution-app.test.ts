import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasAgentExecution, CanvasAgentExecutionDetail, CanvasAgentExecutionOrigin } from '../lib/canvas-agent-execution-contract'
import { assertBatchAssetAvailable } from '../lib/asset-batch-checks'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasAssetSummary, CanvasGroupSummary, CanvasPreparedGroup, CanvasRunGraph, CanvasRunRecord, CanvasRunScope } from '../host'
import { layerEditorScopeToken } from '../image-tools/layer-editor-scope'
import { imageTransformRecipeForNode, isImageTransformNodeKind } from '../image-tools/recipe'
import { dramaPreflightBlockReasons } from '../library/drama-graph'
import { fixedCanvasNodeSourceNames, prepareCanvasNodeSources, type CanvasNodeSourceCatalog } from '../library/node-model-availability'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { RunPreflight } from '../components/RunPreflight'
import { buildAgentExecutionResumePreflight } from '../runtime/agent-execution-preflight'
import { cachedNodeIdsForPreflight } from '../runtime/pinned-reuse'
import { parseImageCandidateCount } from '../runtime/image-candidate-count'
import { buildCanvasRunPreflight, sameCanvasRunGraphSnapshot, selectCanvasRunNodeIds, type CanvasRunPreflight } from '../runtime/run-preflight'
import { parseTextWebSearch } from '../runtime/text-web-search'
import { parseVideoGenerateAudio } from '../runtime/video-audio'
import { parseVideoCandidateCount } from '../runtime/video-candidate-count'
import { createCanvasDocument } from '../store/canvas-state'
import { useCanvasDocument, type CanvasDocumentController } from '../store/use-canvas-document'
import { parseVideoReferenceOrder } from '../video-tools/video-reference-order'
import { fullCanvasCapabilityProfile } from '../host-capabilities.test-fixture'
import { canvasRunInputForHost } from '../runtime/host-run-compatibility'

const app = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const expressions = new Map<string, string>()
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name) expressions.set(node.name.text, node.getText(app).replace(/^export\s+/, ''))
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    if (ts.isCallExpression(node.initializer) && ['useCallback', 'useMemo'].includes(node.initializer.expression.getText(app))) expressions.set(node.name.text, node.initializer.arguments[0].getText(app))
    else if (ts.isArrowFunction(node.initializer)) expressions.set(node.name.text, node.initializer.getText(app))
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(app) === 'saveBeforeRunRef.current') expressions.set('saveBeforeRun', node.right.getText(app))
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(app) === 'RunPreflight') {
    for (const prop of node.attributes.properties) if (ts.isJsxAttribute(prop) && prop.initializer && ts.isJsxExpression(prop.initializer) && prop.initializer.expression) expressions.set(`RunPreflight.${prop.name.getText(app)}`, prop.initializer.expression.getText(app))
  }
  ts.forEachChild(node, visit)
}
visit(app)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  const expression = expressions.get(name)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function deferred<T>() { let resolve: (value: T) => void = () => {}; let reject: (reason: Error) => void = () => {}; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const projectId = '11111111-1111-4111-8111-111111111111'
const origin: CanvasAgentExecutionOrigin = { version: 1, sessionId: 'session-a', turnId: 'turn-a', proposalDigest: 'a'.repeat(64) }
interface Pending { graph: CanvasRunGraph; scope: CanvasRunScope; agentExecution?: { origin: CanvasAgentExecutionOrigin; scopeKey: string; label: string } }
function execution(): CanvasAgentExecution { return { version: 1, id: 'execution-a', projectId, origin: { ...origin }, operationId: 'operation-a', requestDigest: 'c'.repeat(64), targetNodeIds: ['image'], createdAt: '2026-10-18T00:00:00.000Z', state: 'linked', runId: 'original-run', graphRevision: 'b'.repeat(64) } }
function record(): CanvasRunRecord { return { version: 1, userId: 22, ownerId: 22, projectId, runId: 'original-run', graphRevision: 'b'.repeat(64), purpose: 'agent-execution', scope: { kind: 'selection', nodeIds: ['image'] }, status: 'running', createdAt: '2026-10-18T00:00:00.000Z', startedAt: '2026-10-18T00:00:00.000Z', events: [], nodes: [{ nodeId: 'image', kind: 'image-generate', state: 'queued', attempts: [] }] } }

function fixture() {
  let captured: CanvasDocumentController | undefined
  function project(node: EditorNodeRecord): CanvasNode { return { ...node, type: node.type as CanvasNode['type'], data: { prompt: '', model: '', status: 'idle', ...node.data } } }
  function Capture() { captured = useCanvasDocument(project); return null }
  renderToStaticMarkup(createElement(Capture)); if (!captured) throw new Error('Missing actual document')
  const document = captured
  document.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: [
    { id: 'brief', type: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: 'An original synthetic still life', model: '' } },
    { id: 'image', type: 'image-generate', definitionVersion: 1, position: { x: 300, y: 0 }, data: { prompt: 'A product image', group: 'image-source', model: 'gpt-image-1', size: '1024x1024', imageCandidateCount: 1 } },
  ], edges: [{ id: 'brief-image', source: 'brief', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' }] } })
  const activeProjectIdRef = { current: projectId }, projectEpochRef = { current: 1 }, layerEditorOwnerRef = { current: { ownerId: 22, accountId: 'owner-a' } }, draftActionsEnabledRef = { current: true }, projectCanRunRef = { current: true }, projectTransitionRef = { current: false }, saveConflictRef = { current: false }, draftRecoveryPendingRef = { current: false }, agentMountedRef = { current: true }, startingRunsRef = { current: 0 }
  const state = { pending: null as Pending | null, preflight: null as CanvasRunPreflight | null, banner: null as string | null, refresh: 0, starting: 0, mediaConfig: false }
  const sourceCatalog: CanvasNodeSourceCatalog = { 'image-source': { state: 'ready', purposes: ['image'], models: ['gpt-image-1'] } }
  const nodeSourceCatalogRef = { current: sourceCatalog }
  const groups: CanvasGroupSummary[] = [{ name: 'image-source', description: 'Current canvas source B', ratio: 1, purposes: ['image'], revision: 1, connectionStatus: 'ready' }]
  const prepared: Record<string, CanvasPreparedGroup> = { 'image-source': { group: 'image-source', models: ['gpt-image-1'], purposes: ['image'], revision: 1, keyCreated: false } }
  const readGroupCatalog = vi.fn<(_refresh?: boolean) => Promise<CanvasGroupSummary[]>>(async () => structuredClone(groups))
  const access = { current: { denied: false, access: { canRun: true } } }
  const host = { startRun: vi.fn<(_input: { graph: CanvasRunGraph; scope: CanvasRunScope; agentExecution?: CanvasAgentExecutionOrigin }) => Promise<{ runId: string; graphRevision: string }>>().mockResolvedValue({ runId: 'original-run', graphRevision: 'b'.repeat(64) }), refreshProjectAccess: vi.fn<() => Promise<void>>().mockResolvedValue(undefined), getProjectAccess: vi.fn(() => access.current), getRunInputGraph: vi.fn<(_id: string) => Promise<CanvasRunGraph>>(), prepareGroup: vi.fn<(_name: string) => Promise<CanvasPreparedGroup>>(async (name) => structuredClone(prepared[name])), resumeRun: vi.fn<(_id: string) => Promise<boolean>>().mockResolvedValue(true), cancelRun: vi.fn<(_id: string) => Promise<boolean>>().mockResolvedValue(true) }
  const queueProjectSave = vi.fn<() => Promise<void>>().mockResolvedValue(undefined), saveBeforeRunRef = { current: async (_graph: CanvasRunGraph) => {} }, autoSaveRevisionRef = { current: 0 }
  const latestBrowserSnapshotRef = { current: { project: { id: projectId, name: 'Synthetic Agent project' }, content: '{"synthetic":true}' } }
  const activeRunsRef = { current: new Set<string>() }, rememberActiveRun = vi.fn(), openInspectorTab = vi.fn(), refreshRuns = vi.fn(), setBanner = vi.fn((value: string | null) => { state.banner = value })
  const detail = { current: { execution: execution(), record: record(), mayStillComplete: false } as CanvasAgentExecutionDetail }
  const request = vi.fn<(_method: string, _input: unknown) => Promise<CanvasAgentExecutionDetail>>(async () => detail.current)
  const assetId = 'i'.repeat(43)
  const asset: CanvasAssetSummary = { assetId, localUrl: `xingmang-asset://image/${assetId}`, thumbnailUrl: `xingmang-asset://image/${assetId}`, mediaType: 'image', mimeType: 'image/png', source: 'generated', fileName: 'synthetic.png', createdAt: '2026-10-18T00:00:00.000Z', width: 64, height: 64 }
  const readCanvasAssetDetail = vi.fn<(_id: string, _signal?: AbortSignal) => Promise<CanvasAssetSummary>>().mockResolvedValue(asset)
  const env: Record<string, unknown> = {
    builtinNodeRegistry, parseImageCandidateCount, parseVideoCandidateCount, parseTextWebSearch, parseVideoGenerateAudio, parseVideoReferenceOrder, isImageTransformNodeKind, imageTransformRecipeForNode,
    buildCanvasRunPreflight, buildAgentExecutionResumePreflight, canvasCapabilities: () => fullCanvasCapabilityProfile, canvasRunInputForHost, sameCanvasRunGraphSnapshot, selectCanvasRunNodeIds, fixedCanvasNodeSourceNames, prepareCanvasNodeSources, cachedNodeIdsForPreflight, dramaPreflightBlockReasons, layerEditorScopeToken, assertBatchAssetAvailable, readGroupCatalog,
    activeProjectIdRef, projectEpochRef, layerEditorOwnerRef, draftActionsEnabledRef, projectCanRunRef, projectTransitionRef, saveConflictRef, draftRecoveryPendingRef, agentMountedRef, startingRunsRef, activeRunsRef, nodeSourceCatalogRef, saveBeforeRunRef, latestBrowserSnapshotRef, autoSaveRevisionRef, queueProjectSave,
    agentScope: { projectId, active: () => agentMountedRef.current && activeProjectIdRef.current === projectId && layerEditorOwnerRef.current.accountId === 'owner-a' },
    imageGroup: 'image-source', videoGroup: undefined, textGroup: undefined, videoProtocol: undefined, mediaGroups: {}, mediaModelsRef: { current: { image: ['gpt-image-1'], video: [], text: [] } }, imageAssetDimensions: {},
    hostBridge: () => host, getGraphSnapshot: document.getGraphSnapshot, setBanner, openInspectorTab, rememberActiveRun, refreshRuns, readCanvasAssetDetail, agentClient: { request },
    outputPlacementAdapterRef: { current: null }, outputPlacementCoordinator: { begin: vi.fn(), attach: vi.fn(), cancel: vi.fn() },
    rejectPendingMedia: vi.fn(() => false), rejectUnavailableGroups: vi.fn(() => false), resumingTaskIdsRef: { current: new Set<string>() },
    setPendingCanvasRun: (value: Pending | null) => { state.pending = value }, setRunPreflight: (value: CanvasRunPreflight | null) => { state.preflight = value }, setStartingRuns: (value: number) => { state.starting = value }, setAgentExecutionRefreshKey: (update: (previous: number) => number) => { state.refresh = update(state.refresh) }, setMediaConfigOpen: (value: boolean) => { state.mediaConfig = value },
  }
  Object.defineProperties(env, { nodes: { enumerable: true, get: () => document.getGraphSnapshot().nodes }, edges: { enumerable: true, get: () => document.getGraphSnapshot().edges }, pendingCanvasRun: { enumerable: true, get: () => state.pending } })
  for (const name of ['isCanvasGraphNode', 'isCanvasRunnableTarget', 'toWorkflowEdge', 'toCanvasRunGraph', 'currentWorkshopSetupScope']) env[name] = actual(name, env)
  env.inspectPendingAgentExecution = (pending: Pending) => actual<(value: Pending) => CanvasAgentExecutionOrigin | undefined>('inspectPendingAgentExecution', env)(pending)
  env.confirmedRunGroups = () => ({ image: 'image-source', video: '', text: '' })
  saveBeforeRunRef.current = actual('saveBeforeRun', env)
  function call<T>(name: string, ...args: unknown[]): T { return actual<(...input: unknown[]) => T>(name, env)(...args) }
  function graph() { return call<CanvasRunGraph>('toCanvasRunGraph', document.getGraphSnapshot().nodes, document.getGraphSnapshot().edges, { image: 'image-source', video: '' }, sourceCatalog) }
  function pending(agent = true): Pending { return { graph: graph(), scope: { kind: 'selection', nodeIds: ['image'] }, ...(agent ? { agentExecution: { origin: { ...origin }, scopeKey: call<string>('currentWorkshopSetupScope'), label: 'Original reviewed request' } } : {}) } }
  function open(agent = true) { state.pending = pending(agent); state.preflight = buildCanvasRunPreflight({ graph: state.pending.graph, scope: state.pending.scope, sourceCatalog, imageModels: ['gpt-image-1'], videoModels: [] }); expect(state.preflight.canStart).toBe(true) }
  function patchImage(changes: Partial<CanvasNode>) { document.setNodes((nodes) => nodes.map((node) => node.id === 'image' ? { ...node, ...changes } : node)) }
  return { state, env, call, pending, open, graph, patchImage, document, host, access, detail, request, asset, readCanvasAssetDetail, queueProjectSave, setBanner, rememberActiveRun, refreshRuns, openInspectorTab, startingRunsRef, saveBeforeRunRef, activeProjectIdRef, projectEpochRef, layerEditorOwnerRef, projectCanRunRef, projectTransitionRef, saveConflictRef, draftRecoveryPendingRef, agentMountedRef, nodeSourceCatalogRef, groups, prepared, readGroupCatalog }
}

describe('actual App Agent execution callbacks', () => {
  beforeEach(() => vi.stubGlobal('window', { xingmangCanvasHost: {} }))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  it('reviews the exact target scope without saving or starting, and cancels without requests', async () => {
    const f = fixture(), input = f.pending()
    await f.call<Promise<void>>('run', input.scope, input.agentExecution)
    expect(f.state.pending).toEqual(input); expect(f.state.preflight?.selectedNodeIds).toEqual(['brief', 'image'])
    f.call('RunPreflight.onCancel')
    expect(f.state.pending).toBeNull(); expect(f.state.preflight).toBeNull()
    expect(f.queueProjectSave).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it('passes the immutable Agent origin only on its branch and keeps ordinary inspector behavior', async () => {
    const f = fixture(); f.open(); await f.call<Promise<void>>('confirmCanvasRun')
    expect(f.host.startRun).toHaveBeenCalledExactlyOnceWith({ graph: f.graph(), scope: { kind: 'selection', nodeIds: ['image'] }, agentExecution: origin })
    expect(f.queueProjectSave).toHaveBeenCalledOnce(); expect(f.openInspectorTab).not.toHaveBeenCalled(); expect(f.state.refresh).toBe(1)
    const ordinary = fixture(); ordinary.open(false); await ordinary.call<Promise<void>>('confirmCanvasRun')
    expect(ordinary.host.startRun).toHaveBeenCalledExactlyOnceWith({ graph: ordinary.graph(), scope: { kind: 'selection', nodeIds: ['image'] } })
    expect(ordinary.openInspectorTab).toHaveBeenCalledExactlyOnceWith('runs'); expect(ordinary.state.refresh).toBe(0)
  })
  it('blocks a second stale confirmation while the first save is unresolved', async () => {
    const f = fixture(), wait = deferred<void>(); f.queueProjectSave.mockReturnValue(wait.promise); f.open()
    const confirm = actual<() => Promise<void>>('confirmCanvasRun', f.env), first = confirm(); await confirm()
    expect(f.queueProjectSave).toHaveBeenCalledOnce(); expect(f.host.startRun).not.toHaveBeenCalled()
    wait.resolve(); await first
    expect(f.host.startRun).toHaveBeenCalledOnce(); expect(f.startingRunsRef.current).toBe(0)
  })
  it.each(['permission', 'transition', 'conflict', 'recovery', 'account', 'epoch'] as const)('rejects %s invalidation before saving', async (kind) => {
    const f = fixture(); f.open()
    if (kind === 'permission') f.projectCanRunRef.current = false
    if (kind === 'transition') f.projectTransitionRef.current = true
    if (kind === 'conflict') f.saveConflictRef.current = true
    if (kind === 'recovery') f.draftRecoveryPendingRef.current = true
    if (kind === 'account') f.layerEditorOwnerRef.current.accountId = 'owner-b'
    if (kind === 'epoch') f.projectEpochRef.current++
    await f.call<Promise<void>>('confirmCanvasRun')
    expect(f.queueProjectSave).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it.each(['deleted', 'disabled'] as const)('rejects a %s original target before saving', async (kind) => {
    const f = fixture(); f.open()
    if (kind === 'deleted') f.document.setNodes((nodes) => nodes.filter((node) => node.id !== 'image'))
    else f.patchImage({ disabled: true })
    await f.call<Promise<void>>('confirmCanvasRun')
    expect(f.state.banner).toContain('已删除、停用'); expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.queueProjectSave).not.toHaveBeenCalled()
  })
  it('requires a renewed review after a graph edit instead of submitting the old preflight', async () => {
    const f = fixture(); f.open(); f.patchImage({ data: { ...f.document.getGraphSnapshot().nodes[1].data, prompt: 'A changed product image' } })
    await f.call<Promise<void>>('confirmCanvasRun')
    expect(f.state.banner).toContain('再次确认'); expect(f.state.pending?.graph).toEqual(f.graph()); expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.queueProjectSave).not.toHaveBeenCalled()
  })
  it.each(['permission', 'epoch', 'graph'] as const)('rechecks %s after the real save barrier before start', async (kind) => {
    const f = fixture(), wait = deferred<void>(); f.queueProjectSave.mockReturnValue(wait.promise); f.open()
    const result = f.call<Promise<void>>('confirmCanvasRun')
    expect(f.queueProjectSave).toHaveBeenCalledOnce()
    if (kind === 'permission') f.projectCanRunRef.current = false
    if (kind === 'epoch') f.projectEpochRef.current++
    if (kind === 'graph') f.patchImage({ data: { ...f.document.getGraphSnapshot().nodes[1].data, prompt: 'Changed during save' } })
    wait.resolve(); await result
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.rememberActiveRun).not.toHaveBeenCalled(); expect(f.startingRunsRef.current).toBe(0)
  })
  it.each(['resolve', 'reject'] as const)('does not clear a newer project modal after a late start %s', async (outcome) => {
    const f = fixture(), wait = deferred<{ runId: string; graphRevision: string }>(); f.host.startRun.mockReturnValue(wait.promise); f.open()
    const result = f.call<Promise<void>>('confirmCanvasRun'); await vi.waitFor(() => expect(f.host.startRun).toHaveBeenCalledOnce())
    f.projectEpochRef.current++; f.activeProjectIdRef.current = 'another-project'
    const newPending = f.pending(false); f.state.pending = newPending; const newPreflight = { ...f.state.preflight, canStart: true } as CanvasRunPreflight; f.state.preflight = newPreflight; f.state.banner = 'New project message'
    if (outcome === 'resolve') wait.resolve({ runId: 'late-original', graphRevision: 'b'.repeat(64) }); else wait.reject(new Error('Late start error'))
    await result
    expect(f.state.pending).toBe(newPending); expect(f.state.preflight).toBe(newPreflight); expect(f.state.banner).toBe('New project message'); expect(f.state.refresh).toBe(0); expect(f.rememberActiveRun).not.toHaveBeenCalled()
  })
  it('does not project a late registered run after permission revocation', async () => {
    const f = fixture(), wait = deferred<{ runId: string; graphRevision: string }>(); f.host.startRun.mockReturnValue(wait.promise); f.open()
    const pending = f.call<Promise<void>>('confirmCanvasRun'); await vi.waitFor(() => expect(f.host.startRun).toHaveBeenCalledOnce())
    f.projectCanRunRef.current = false; wait.resolve({ runId: 'original-run', graphRevision: 'b'.repeat(64) }); await pending
    expect(f.rememberActiveRun).not.toHaveBeenCalled(); expect(f.refreshRuns).not.toHaveBeenCalled(); expect(f.state.banner).toContain('访问权限已变化')
  })
  it('reads an available original asset without executing and rejects late scope changes', async () => {
    const f = fixture(); expect(await f.call<Promise<CanvasAssetSummary>>('readAgentExecutionAsset', f.asset.assetId)).toEqual(f.asset)
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.resumeRun).not.toHaveBeenCalled(); expect(f.queueProjectSave).not.toHaveBeenCalled()
    const wait = deferred<CanvasAssetSummary>(); f.readCanvasAssetDetail.mockReturnValue(wait.promise)
    const pending = f.call<Promise<CanvasAssetSummary>>('readAgentExecutionAsset', f.asset.assetId), rejected = expect(pending).rejects.toThrow('账号或工程已变化')
    f.projectEpochRef.current++; wait.resolve(f.asset); await rejected
  })
  it('rejects mismatched and recycled original assets and respects pre-abort without I/O', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort()
    await expect(f.call<Promise<CanvasAssetSummary>>('readAgentExecutionAsset', f.asset.assetId, controller.signal)).rejects.toThrow('原账号和工程')
    expect(f.readCanvasAssetDetail).not.toHaveBeenCalled()
    f.readCanvasAssetDetail.mockResolvedValue({ ...f.asset, assetId: 'j'.repeat(43) })
    await expect(f.call<Promise<CanvasAssetSummary>>('readAgentExecutionAsset', f.asset.assetId)).rejects.toThrow('编号不一致')
    f.readCanvasAssetDetail.mockResolvedValue({ ...f.asset, deletedAt: '2026-10-18T00:00:00.000Z' })
    await expect(f.call<Promise<CanvasAssetSummary>>('readAgentExecutionAsset', f.asset.assetId)).rejects.toThrow('已回收')
  })
  it.each(['resume', 'cancel'] as const)('explicitly %ss only the freshly read original run', async (action) => {
    const f = fixture(); expect(await f.call<Promise<boolean>>('controlAgentExecution', execution(), action)).toBe(true)
    expect(f.request).toHaveBeenCalledExactlyOnceWith('readExecution', { projectId, sessionId: origin.sessionId, turnId: origin.turnId, executionId: 'execution-a' })
    expect(f.host[action === 'resume' ? 'resumeRun' : 'cancelRun']).toHaveBeenCalledExactlyOnceWith('original-run')
    expect(f.host[action === 'resume' ? 'cancelRun' : 'resumeRun']).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.state.refresh).toBe(1)
  })
  it('rejects a different run receipt and does not resume a completed or cancelling run', async () => {
    const f = fixture(); f.detail.current.record = { ...record(), runId: 'different-run' }
    await expect(f.call<Promise<boolean>>('controlAgentExecution', execution(), 'resume')).rejects.toThrow('完整核对')
    f.detail.current.record = { ...record(), status: 'succeeded' }; expect(await f.call<Promise<boolean>>('controlAgentExecution', execution(), 'resume')).toBe(false)
    f.detail.current.record = { ...record(), cancelRequested: true }; expect(await f.call<Promise<boolean>>('controlAgentExecution', execution(), 'resume')).toBe(false)
    expect(f.host.resumeRun).not.toHaveBeenCalled(); expect(f.host.cancelRun).not.toHaveBeenCalled()
  })
  it('rechecks scope and access after both control awaits before continuing the original run', async () => {
    const f = fixture(), read = deferred<CanvasAgentExecutionDetail>(); f.request.mockReturnValue(read.promise)
    const pending = f.call<Promise<boolean>>('controlAgentExecution', execution(), 'resume'), rejected = expect(pending).rejects.toThrow('完整核对')
    f.projectEpochRef.current++; read.resolve({ execution: execution(), record: record(), mayStillComplete: false }); await rejected
    expect(f.host.refreshProjectAccess).not.toHaveBeenCalled(); expect(f.host.resumeRun).not.toHaveBeenCalled()
    const other = fixture(), access = deferred<void>(); other.host.refreshProjectAccess.mockReturnValue(access.promise)
    const control = other.call<Promise<boolean>>('controlAgentExecution', execution(), 'resume'), denied = expect(control).rejects.toThrow('权限已变化')
    await vi.waitFor(() => expect(other.host.refreshProjectAccess).toHaveBeenCalledOnce()); other.access.current.denied = true; access.resolve(); await denied
    expect(other.host.resumeRun).not.toHaveBeenCalled()
  })
  it('does not refresh a new project after an accepted late original-run control', async () => {
    const f = fixture(), wait = deferred<boolean>(); f.host.cancelRun.mockReturnValue(wait.promise)
    const pending = f.call<Promise<boolean>>('controlAgentExecution', execution(), 'cancel'), rejected = expect(pending).rejects.toThrow('回到原消息')
    await vi.waitFor(() => expect(f.host.cancelRun).toHaveBeenCalledExactlyOnceWith('original-run'))
    f.projectEpochRef.current++; wait.resolve(true); await rejected
    expect(f.state.refresh).toBe(0); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it('preflights the immutable original scope and queued model while retaining completed unavailable sources without requests', async () => {
    const f = fixture()
    const original: CanvasRunGraph = { nodes: [
      { id: 'old-text', kind: 'text-generate', definitionVersion: 1, data: { prompt: 'Original completed text', model: 'original-text-alias', group: 'deleted-old-source' } },
      { id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'Original image prompt', model: 'gpt-image-2', group: 'original-image-source', size: '1024x1024', imageCandidateCount: 2 } },
      { id: 'outside', kind: 'video-generate', definitionVersion: 1, data: { prompt: '', model: 'invalid-outside-model', group: 'absent-outside-source' } },
    ], edges: [{ id: 'original-edge', source: 'old-text', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' }] }
    f.host.getRunInputGraph.mockResolvedValue(original)
    const currentCatalog = f.nodeSourceCatalogRef.current
    f.groups.push({ name: 'original-image-source', description: 'Original saved source A', ratio: 1, purposes: ['image'], revision: 7, connectionStatus: 'ready' })
    f.prepared['original-image-source'] = { group: 'original-image-source', models: ['gpt-image-2'], purposes: ['image'], revision: 7, keyCreated: false }
    f.detail.current.record = { ...record(), nodes: [{ nodeId: 'old-text', kind: 'text-generate', state: 'succeeded', attempts: [] }, { nodeId: 'image', kind: 'image-generate', state: 'queued', attempts: [] }] }
    f.patchImage({ data: { ...f.document.getGraphSnapshot().nodes[1].data, model: 'invalid-current-model', imageCandidateCount: 4 } })
    const currentGraph = structuredClone(f.document.getGraphSnapshot())
    const preflight = await f.call<Promise<CanvasRunPreflight>>('prepareAgentExecutionResume', execution())
    expect(preflight.scope).toEqual({ kind: 'selection', nodeIds: ['image'] }); expect(preflight.selectedNodeIds).toEqual(['old-text', 'image'])
    expect(preflight).toMatchObject({ canStart: true, blockedCount: 0, requestCount: 2, imageRequestCount: 2, textRequestCount: 0, paidRequestCount: 2, cacheHitCount: 1 })
    expect(preflight.items).toEqual([expect.objectContaining({ nodeId: 'old-text', action: 'cached', requestCount: 0 }), expect.objectContaining({ nodeId: 'image', model: 'gpt-image-2', group: 'original-image-source', action: 'execute', requestCount: 2 })])
    expect(f.host.getRunInputGraph).toHaveBeenCalledExactlyOnceWith('original-run'); expect(f.host.refreshProjectAccess).toHaveBeenCalledOnce()
    expect(f.readGroupCatalog).toHaveBeenCalledExactlyOnceWith(true); expect(f.host.prepareGroup).toHaveBeenCalledExactlyOnceWith('original-image-source')
    expect(f.nodeSourceCatalogRef.current).toBe(currentCatalog); expect(f.nodeSourceCatalogRef.current['original-image-source']).toBeUndefined()
    expect(f.document.getGraphSnapshot()).toEqual(currentGraph)
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.resumeRun).not.toHaveBeenCalled(); expect(f.host.cancelRun).not.toHaveBeenCalled(); expect(f.queueProjectSave).not.toHaveBeenCalled()
    const markup = renderToStaticMarkup(createElement(RunPreflight, { preflight, originalRunId: 'original-run', onCancel: vi.fn(), onConfirm: vi.fn(), onConfigure: vi.fn(), onLocateNode: vi.fn() }))
    expect(markup).toContain('继续原运行 original-run'); expect(markup).toContain('使用已保存的原图参数'); expect(markup).toContain('确认继续原运行'); expect(markup).toContain('gpt-image-2'); expect(markup).not.toContain('invalid-current-model')
  })
  it('blocks an unavailable queued original model even when the current canvas model is usable', async () => {
    const f = fixture(); f.host.getRunInputGraph.mockResolvedValue({ nodes: [{ id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'Original request', model: 'gpt-image-2', group: 'missing-original-source', size: '1024x1024' } }], edges: [] })
    const preflight = await f.call<Promise<CanvasRunPreflight>>('prepareAgentExecutionResume', execution())
    expect(preflight.canStart).toBe(false); expect(preflight.items[0]).toMatchObject({ nodeId: 'image', model: 'gpt-image-2', action: 'blocked', reasonCode: 'unavailable-source' })
    expect(f.host.resumeRun).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it.each(['getRunInputGraph', 'resumeRun'] as const)('rejects resume preparation without the %s bridge capability', async (method) => {
    const f = fixture(); Reflect.deleteProperty(f.host, method)
    await expect(f.call<Promise<CanvasRunPreflight>>('prepareAgentExecutionResume', execution())).rejects.toThrow('不能核对原运行输入')
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.queueProjectSave).not.toHaveBeenCalled()
  })
  it('rejects invalid origin scope before reading and stale record identity before reading input', async () => {
    const f = fixture()
    await expect(f.call<Promise<CanvasRunPreflight>>('prepareAgentExecutionResume', { ...execution(), projectId: 'wrong-project' })).rejects.toThrow('原账号和工程')
    expect(f.request).not.toHaveBeenCalled()
    f.detail.current.record = { ...record(), runId: 'different-run' }
    await expect(f.call<Promise<CanvasRunPreflight>>('prepareAgentExecutionResume', execution())).rejects.toThrow('原运行状态已变化')
    expect(f.host.getRunInputGraph).not.toHaveBeenCalled(); expect(f.host.resumeRun).not.toHaveBeenCalled()
  })
  it.each(['record', 'input', 'access'] as const)('rejects a late %s reply when the original project epoch changes', async (stage) => {
    const f = fixture(), wait = deferred<void>()
    f.host.getRunInputGraph.mockResolvedValue(f.graph())
    if (stage === 'record') f.request.mockImplementation(async () => { await wait.promise; return f.detail.current })
    if (stage === 'input') f.host.getRunInputGraph.mockImplementation(async () => { await wait.promise; return f.graph() })
    if (stage === 'access') f.host.refreshProjectAccess.mockReturnValue(wait.promise)
    const pending = f.call<Promise<CanvasRunPreflight>>('prepareAgentExecutionResume', execution()), rejected = expect(pending).rejects.toThrow(stage === 'record' ? '原运行状态已变化' : stage === 'input' ? '原运行检查已取消' : '工程权限已变化')
    if (stage === 'input') await vi.waitFor(() => expect(f.host.getRunInputGraph).toHaveBeenCalledOnce())
    if (stage === 'access') await vi.waitFor(() => expect(f.host.refreshProjectAccess).toHaveBeenCalledOnce())
    f.projectEpochRef.current++; wait.resolve(); await rejected
    if (stage === 'record') expect(f.host.getRunInputGraph).not.toHaveBeenCalled()
    if (stage !== 'access') expect(f.host.refreshProjectAccess).not.toHaveBeenCalled()
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.resumeRun).not.toHaveBeenCalled()
  })
  it('rejects access revocation discovered by the read-only resume preflight', async () => {
    const f = fixture(); f.host.getRunInputGraph.mockResolvedValue(f.graph()); f.host.refreshProjectAccess.mockImplementation(async () => { f.access.current.access.canRun = false })
    await expect(f.call<Promise<CanvasRunPreflight>>('prepareAgentExecutionResume', execution())).rejects.toThrow('工程权限已变化')
    expect(f.host.resumeRun).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.queueProjectSave).not.toHaveBeenCalled()
  })
  it.each(['metadata', 'prepared'] as const)('discards late %s replies for the original source after a same-project reopen', async (stage) => {
    const f = fixture(), wait = deferred<void>(); f.host.getRunInputGraph.mockResolvedValue(f.graph())
    if (stage === 'metadata') f.readGroupCatalog.mockImplementation(async () => { await wait.promise; return f.groups })
    else f.host.prepareGroup.mockImplementation(async (name) => { await wait.promise; return f.prepared[name] })
    const pending = f.call<Promise<CanvasRunPreflight>>('prepareAgentExecutionResume', execution()), rejected = expect(pending).rejects.toThrow('原来源检查已取消')
    await vi.waitFor(() => expect(stage === 'metadata' ? f.readGroupCatalog : f.host.prepareGroup).toHaveBeenCalledOnce())
    const currentCatalog = f.nodeSourceCatalogRef.current; f.projectEpochRef.current++; wait.resolve(); await rejected
    expect(f.nodeSourceCatalogRef.current).toBe(currentCatalog); expect(f.host.resumeRun).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
    if (stage === 'metadata') expect(f.host.prepareGroup).not.toHaveBeenCalled()
  })
  it('blocks a prepared source revision mismatch instead of using the current default', async () => {
    const f = fixture(); f.host.getRunInputGraph.mockResolvedValue(f.graph()); f.prepared['image-source'].revision = 2
    const preflight = await f.call<Promise<CanvasRunPreflight>>('prepareAgentExecutionResume', execution())
    expect(preflight.canStart).toBe(false); expect(preflight.items.find((item) => item.nodeId === 'image')).toMatchObject({ action: 'blocked', reasonCode: 'unavailable-source', reason: expect.stringContaining('核对期间已变化') })
    expect(f.nodeSourceCatalogRef.current['image-source'].state).toBe('ready'); expect(f.host.resumeRun).not.toHaveBeenCalled()
  })
  it('rejects access revocation that arrives while preparing the original source', async () => {
    const f = fixture(); f.host.getRunInputGraph.mockResolvedValue(f.graph()); f.host.prepareGroup.mockImplementation(async (name) => { f.access.current.denied = true; return f.prepared[name] })
    await expect(f.call<Promise<CanvasRunPreflight>>('prepareAgentExecutionResume', execution())).rejects.toThrow('访问权限已变化')
    expect(f.host.resumeRun).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
})
