import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isWorkshopLibraryAsset } from '../components/workshop-media-picker-model'
import { clipPromptEditorValue } from '../components/prompt-mentions'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { canvasNodeDisplayGeometry } from '../domain/node-display-geometry'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasAssetSummary, CanvasGroupSummary, CanvasRunGraph, CanvasVideoAssetSummary, CanvasWorkshopItem } from '../host'
import { parseImageCollageInputOrder } from '../image-tools/collage-input-order'
import { parseNodeImageEditMask } from '../image-tools/image-mask-workflow'
import { layerEditorScopeToken } from '../image-tools/layer-editor-scope'
import { imageTransformRecipeForNode, isImageTransformNodeKind } from '../image-tools/recipe'
import { buildCanvasMediaAssetBinding } from '../library/bind-media-asset'
import { dramaPreflightBlockReasons } from '../library/drama-graph'
import { parsePromptReferences } from '../library/prompt-references'
import { completeCanvasMediaImport } from '../library/media-import-completion'
import type { CanvasNodeSourceCatalog } from '../library/node-model-availability'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { createEmptyWorkflow } from '../model'
import { maximumOutputTextLength } from '../persistence/workflow-schema'
import { parseImageCandidateCount } from '../runtime/image-candidate-count'
import { cachedNodeIdsForPreflight } from '../runtime/pinned-reuse'
import { parseTextWebSearch } from '../runtime/text-web-search'
import { parseVideoGenerateAudio } from '../runtime/video-audio'
import { parseVideoCandidateCount } from '../runtime/video-candidate-count'
import { createCanvasDocument } from '../store/canvas-state'
import { canvasNodeDocumentRecord, useCanvasDocument, type CanvasDocumentController } from '../store/use-canvas-document'
import { parseVideoReferenceOrder } from '../video-tools/video-reference-order'
import { instantiateWorkshopGraph } from './workshop-graph'
import { buildWorkshopPortableSnapshot } from '../components/workshop-save-model'
import { buildWorkshopSetup, type WorkshopSetup, type WorkshopSetupAssetState, type WorkshopSetupItem, type WorkshopSetupScope } from './workshop-setup'
import { canvasNodeKindAvailable } from '../host-capabilities'
import { fullCanvasCapabilityProfile } from '../host-capabilities.test-fixture'
import { canvasRunInputForHost, withoutHostDisabledDefaults } from '../runtime/host-run-compatibility'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const expressions = new Map<string, string>()
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name) expressions.set(node.name.text, node.getText(source).replace(/^export\s+/, ''))
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && ['useCallback', 'useMemo'].includes(node.initializer.expression.getText(source))) expressions.set(node.name.text, node.initializer.arguments[0].getText(source))
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('workshopSetupSessionRef.current?.scopeKey === layerEditorScope')) expressions.set('resetWorkshopSetup', node.arguments[0].getText(source))
  ts.forEachChild(node, visit)
}
visit(source)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  const expression = expressions.get(name)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function deferred<T>() { let resolve: (value: T) => void = () => {}; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function libraryAsset(mediaType: CanvasAssetSummary['mediaType']): CanvasAssetSummary {
  const assetId = mediaType[0].repeat(43), localUrl = `xingmang-asset://${mediaType}/${assetId}`
  const common = { assetId, localUrl, thumbnailUrl: localUrl, fileName: `owned-${mediaType}`, createdAt: '2026-10-18T00:00:00.000Z' }
  if (mediaType === 'video') return { ...common, mediaType, mimeType: 'video/mp4', taskId: 'imported', width: 320, height: 180, durationSeconds: 2 }
  if (mediaType === 'audio') return { ...common, mediaType, mimeType: 'audio/wav', durationSeconds: 2 }
  return { ...common, mediaType, mimeType: 'image/png', width: 640, height: 480 }
}
type Session = { scopeKey: string; scope: WorkshopSetupScope; insertedNodeIds?: readonly string[] }
type MappingSession = { token: number; scopeKey: string; setupSession: Session; nodeIds: string[]; graphSignature: string; sourceSignature: string; groups: CanvasGroupSummary[] }
type HostAccessState = { projectId: string; denied?: boolean; access?: { projectId: string; canEdit: boolean } } | null
function fixture() {
  let controller: CanvasDocumentController | undefined, serial = 0
  const project = actual<(record: EditorNodeRecord) => CanvasNode>('editorNodeToCanvasNode', { clipPromptEditorValue, parsePromptReferences, parseImageCandidateCount, parseVideoCandidateCount, parseTextWebSearch, maximumOutputTextLength, toCanvasNode: actual('toCanvasNode', { canvasNodeDisplayGeometry }) })
  function Capture() { controller = useCanvasDocument(project); return null }
  renderToStaticMarkup(createElement(Capture)); if (!controller) throw new Error('Missing document')
  const documentController = controller
  documentController.execute({ type: 'replace-document', resetHistory: true, document: createCanvasDocument() })
  const state = { session: null as Session | null, open: false, busy: false, assets: {} as Record<string, WorkshopSetupAssetState>, error: undefined as string | undefined }
  const workshopSetupSessionRef = { current: null as Session | null }, workshopSetupAssetCheckRef = { current: null as AbortController | null }, workshopSetupActionRevisionRef = { current: 0 }, workshopSetupActionBusyRef = { current: false }
  const mappingState = { session: null as MappingSession | null, catalog: {} as CanvasNodeSourceCatalog, busy: false }
  const workshopModelMappingRevisionRef = { current: 0 }, workshopModelMappingSessionRef = { current: null as MappingSession | null }, workshopModelMappingCatalogRef = { current: {} as CanvasNodeSourceCatalog }, workshopModelMappingBusyRef = { current: false }
  const layerEditorOwnerRef = { current: { ownerId: 7, accountId: 'account-a' } }, activeProjectIdRef = { current: 'project-a' }, projectEpochRef = { current: 1 }
  const draftActionsEnabledRef = { current: true }, projectCanEditRef = { current: true }, projectCanRunRef = { current: true }, projectTransitionRef = { current: false }, draftRecoveryPendingRef = { current: false }, saveConflictRef = { current: false }, agentMountedRef = { current: true }
  const activeRunsRef = { current: new Set<string>() }, pendingRunProjectionIdsRef = { current: new Set<string>() }, resumingTaskIdsRef = { current: new Set<string>() }, startingRunsRef = { current: 0 }
  const asset: CanvasVideoAssetSummary = { assetId: 'v'.repeat(43), mediaType: 'video', mimeType: 'video/mp4', localUrl: '/video.mp4', thumbnailUrl: '', fileName: 'video.mp4', createdAt: '', taskId: 'video-task', width: 640, height: 480, durationSeconds: 2 }
  const host = { getAssetDetail: vi.fn<(...args: unknown[]) => Promise<CanvasAssetSummary | null>>().mockResolvedValue(asset), refreshProjectAccess: vi.fn().mockResolvedValue(undefined), getProjectAccess: vi.fn<() => HostAccessState>(() => ({ projectId: 'project-a', access: { projectId: 'project-a', canEdit: true } })), pickAsset: vi.fn<(...args: unknown[]) => Promise<CanvasAssetSummary | null>>().mockResolvedValue(asset), startRun: vi.fn(), generateImage: vi.fn(), generateVideo: vi.fn() }
  const execute = vi.fn(documentController.execute), getGraphSnapshot = documentController.getGraphSnapshot, graphRef = { current: getGraphSnapshot() }, assetCatalog: CanvasAssetSummary[] = [], mediaModelsRef = { current: { image: ['gpt-image-1'], video: [], text: ['gpt-4.1'] } }
  const configuration = { image: '', video: '', text: '', imageModel: '', videoModel: '', textModel: '' }, confirmedRunGroups = vi.fn(() => configuration)
  const setters = { setMoreActionsOpen: vi.fn(), setRunMenuOpen: vi.fn(), setQuickInsert: vi.fn(), setMediaConfigOpen: vi.fn(), setWorkshopCatalog: vi.fn(), setBanner: vi.fn(), setAgentOpen: vi.fn(), locateNode: vi.fn(), setRunPreflight: vi.fn(), setPendingCanvasRun: vi.fn(), setDirtyNodeIds: vi.fn(), markCanvasAssetUsed: vi.fn().mockResolvedValue(undefined), refreshAssets: vi.fn().mockResolvedValue(undefined) }
  const animations: Array<() => void> = [], reactFlow = { fitView: vi.fn().mockResolvedValue(undefined), getViewport: () => ({ x: 0, y: 0, zoom: 1 }) }
  const workshopAssetPickerRef = { current: null as { scopeKey: string; nodeId: string; title: string; mediaType: CanvasAssetSummary['mediaType']; current(): boolean } | null }
  const environment: Record<string, unknown> = {
    imageAssetDimensions: {}, nodeSourceCatalogRef: { current: {} }, editorNodeToCanvasNode: project, focusInsertedNodes: vi.fn(),
    workshopModelMappingRevisionRef, workshopModelMappingSessionRef, workshopModelMappingCatalogRef, workshopModelMappingBusyRef,
    setWorkshopModelMappingSession: (value: MappingSession | null) => { mappingState.session = value }, setWorkshopModelMappingCatalog: (value: CanvasNodeSourceCatalog) => { mappingState.catalog = value }, setWorkshopModelMappingBusy: (value: boolean) => { mappingState.busy = value },
    workshopAssetPickerRef, setWorkshopAssetPicker: (value: typeof workshopAssetPickerRef.current) => { workshopAssetPickerRef.current = value },
    setAssetCatalog: (update: (previous: CanvasAssetSummary[]) => CanvasAssetSummary[]) => { const next = update(assetCatalog); assetCatalog.splice(0, assetCatalog.length, ...next) },
    ...setters, workshopSetupSessionRef, workshopSetupAssetCheckRef, workshopSetupActionRevisionRef, workshopSetupActionBusyRef, layerEditorOwnerRef, activeProjectIdRef, projectEpochRef, draftActionsEnabledRef, projectCanEditRef, projectCanRunRef, projectTransitionRef, draftRecoveryPendingRef, saveConflictRef, agentMountedRef,
    activeRunsRef, pendingRunProjectionIdsRef, resumingTaskIdsRef, startingRunsRef, assetCatalog, mediaModelsRef, confirmedRunGroups, documentController, execute, getGraphSnapshot, graphRef, reactFlow,
    canvasCapabilities: () => fullCanvasCapabilityProfile, canvasNodeKindAvailable, canvasRunInputForHost, withoutHostDisabledDefaults, layerEditorScopeToken, buildWorkshopSetup, builtinNodeRegistry, cachedNodeIdsForPreflight, dramaPreflightBlockReasons, parseImageCandidateCount, parseVideoCandidateCount, parseTextWebSearch, parseVideoGenerateAudio, parseVideoReferenceOrder, parseNodeImageEditMask, imageTransformRecipeForNode, isImageTransformNodeKind, parseImageCollageInputOrder, maximumOutputTextLength, canvasNodeDocumentRecord, canvasNodeDisplayGeometry, instantiateWorkshopGraph, completeCanvasMediaImport, buildCanvasMediaAssetBinding, isWorkshopLibraryAsset,
    setWorkshopSetupSession: (value: Session | null) => { state.session = value }, setWorkshopSetupOpen: (value: boolean) => { state.open = value }, setWorkshopSetupBusy: (value: boolean) => { state.busy = value }, setWorkshopSetupError: (value: string | undefined) => { state.error = value },
    setWorkshopSetupAssets: (value: Record<string, WorkshopSetupAssetState> | ((previous: Record<string, WorkshopSetupAssetState>) => Record<string, WorkshopSetupAssetState>)) => { state.assets = typeof value === 'function' ? value(state.assets) : value },
    get workshopSetupAssets() { return state.assets }, get workshopSetupSession() { return state.session }, get workshopSetupOpen() { return state.open }, get nodes() { return getGraphSnapshot().nodes }, get edges() { return getGraphSnapshot().edges },
    get layerEditorScope() { return layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current }) },
    get draftActionsEnabled() { return draftActionsEnabledRef.current },
    hostBridge: () => host, window: { xingmangCanvasHost: host, location: { href: 'http://fixture.invalid/canvas?project=project-a' }, requestAnimationFrame: (callback: () => void) => { animations.push(callback); return animations.length } },
    setNodes: documentController.setNodes, assetQuery: {}, activeProject: { id: 'project-a' }, workshopProjectEpoch: 1, mediaGroups: {}, templateCreatedProjectRef: { current: null }, templateProjectSubmissionRef: { current: { settled: vi.fn() } }, nextNodeId: () => `inserted-${++serial}`,
    rejectPendingMedia: vi.fn(() => false), rejectUnavailableGroups: vi.fn(() => false),
  }
  for (const name of ['toCanvasNode', 'toWorkflowEdge', 'isCanvasGraphNode', 'toWorkflowNode', 'toCanvasRunGraph', 'importedAssetSummary', 'currentWorkshopSetupScope']) environment[name] = actual(name, environment)
  for (const name of ['openWorkshopSetup', 'openCreatedWorkshopSetup', 'closeWorkshopSetup', 'changeWorkshopSetupScope', 'readWorkshopSetup', 'locateWorkshopSetupNode', 'bindAssetToNode', 'pickAssetForNode', 'closeWorkshopAssetPicker']) environment[name] = (...args: unknown[]) => actual<(...values: unknown[]) => unknown>(name, environment)(...args)
  function call<T>(name: string, ...args: unknown[]): T { return actual<(...values: unknown[]) => T>(name, environment)(...args) }
  function patch(id: string, changes: Partial<CanvasNode>) { documentController.setNodes((nodes) => nodes.map((node) => node.id === id ? { ...node, ...changes } : node)) }
  function add(id: string, type = 'prompt', data: Record<string, unknown> = {}) { execute({ type: 'add-nodes', nodes: [{ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', ...data } }] }) }
  function read() { return call<{ setup: WorkshopSetup; graph: CanvasRunGraph | null } | null>('readWorkshopSetup') }
  function open(scope?: WorkshopSetupScope) { call('openWorkshopSetup', scope) }
  function item(action: WorkshopSetupItem['action']) { const found = read()?.setup.items.find((entry) => entry.action === action); if (!found) throw new Error(`No ${action}: ${JSON.stringify(read())}`); return found }
  async function act(value: WorkshopSetupItem) { await call<Promise<void>>('actOnWorkshopSetup', value) }
  return { ...setters, state, mappingState, workshopModelMappingRevisionRef, workshopModelMappingSessionRef, workshopModelMappingCatalogRef, workshopModelMappingBusyRef, environment, call, patch, add, read, open, item, act, host, asset, execute, assetCatalog, mediaModelsRef, configuration, confirmedRunGroups, animations, reactFlow, current: getGraphSnapshot, documentController,
    workshopSetupSessionRef, workshopSetupAssetCheckRef, workshopSetupActionRevisionRef, workshopSetupActionBusyRef, layerEditorOwnerRef, activeProjectIdRef, projectEpochRef, draftActionsEnabledRef, projectCanEditRef, projectCanRunRef, projectTransitionRef, draftRecoveryPendingRef, agentMountedRef, activeRunsRef, pendingRunProjectionIdsRef, resumingTaskIdsRef, startingRunsRef }
}
type Fixture = ReturnType<typeof fixture>
const scopeChanges: Array<[string, (f: Fixture) => void]> = [
  ['account', (f) => { f.layerEditorOwnerRef.current.accountId = 'account-b' }],
  ['same-project reload', (f) => { f.projectEpochRef.current++ }],
  ['permission', (f) => { f.projectCanEditRef.current = false }],
  ['close', (f) => { f.call('closeWorkshopSetup') }],
  ['removed target', (f) => { f.documentController.setNodes([]) }],
  ['rebound target', (f) => { const node = f.current().nodes[0]; f.patch(node.id, { data: { ...node.data, result: { kind: 'video', assetId: 'other' } } }) }],
]

describe('actual App workshop preparation callbacks', () => {
  it('inserts an owner-private image and video graph with exact pins and removes it in one undo without generation', async () => {
    const f = fixture(), workflow = createEmptyWorkflow('Private image and video')
    workflow.nodes = [{ id: 'image', kind: 'image-generate', position: { x: 0, y: 0 }, data: { prompt: 'Image prompt', model: 'original-image', group: 'removed-image-source', status: 'idle' } }, { id: 'video', kind: 'video-generate', position: { x: 500, y: 0 }, data: { prompt: 'Video prompt', model: 'original-video', group: 'owned-video-source', status: 'idle', seconds: '6' } }]
    workflow.edges = [{ id: 'image-video', source: 'image', sourceHandle: 'out:image', target: 'video', targetHandle: 'in:images' }]
    const privateWorkflow = buildWorkshopPortableSnapshot(workflow, 'group', workflow.name, { sourcePolicy: 'owner-private' }), before = structuredClone(privateWorkflow)
    const item: CanvasWorkshopItem = { id: 'owned-workshop', version: 1, kind: 'group', name: workflow.name, description: '', tags: [], category: 'general', nodeCount: 2, edgeCount: 1, nodeKinds: ['image-generate', 'video-generate'], createdAt: '', updatedAt: '', sourcePolicy: 'owner-private', workflow: privateWorkflow }
    f.environment.mediaGroups = { image: 'different-project-image', video: 'different-project-video' }
    await f.call<Promise<void>>('insertWorkshopItem', item)
    expect(f.current().nodes.map((node) => [node.data.group, node.data.model])).toEqual([['removed-image-source', 'original-image'], ['owned-video-source', 'original-video']])
    expect(f.current().edges).toHaveLength(1); expect(f.state.open).toBe(true); expect(f.read()?.setup.scopeNodeIds).toEqual(['inserted-1', 'inserted-2'])
    expect(f.execute).toHaveBeenCalledOnce(); f.documentController.undo(); expect(f.current().nodes).toEqual([]); expect(f.current().edges).toEqual([])
    f.documentController.redo(); expect(f.current().nodes[0].data.group).toBe('removed-image-source')
    expect(privateWorkflow).toEqual(before); expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.generateImage).not.toHaveBeenCalled(); expect(f.host.generateVideo).not.toHaveBeenCalled()
  })
  it('opens one stable inserted scope and follows real undo redo without network reads', async () => {
    const f = fixture(), workflow = createEmptyWorkflow('视频素材')
    workflow.nodes = [{ id: 'source', kind: 'video-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle' } }]
    const item: CanvasWorkshopItem = { id: 'workshop-fixture', version: 1, kind: 'node', name: workflow.name, description: '', tags: [], category: 'general', nodeCount: 1, edgeCount: 0, nodeKinds: ['video-input'], createdAt: '', updatedAt: '', workflow }
    await f.call<Promise<void>>('insertWorkshopItem', item)
    expect(f.state.open).toBe(true); expect(f.read()?.setup.scope).toEqual({ kind: 'inserted', nodeIds: ['inserted-1'] })
    expect(f.item('pick-asset').nodeId).toBe('inserted-1')
    f.documentController.undo(); expect(f.read()?.setup).toMatchObject({ missingNodeIds: ['inserted-1'], canReviewRun: false })
    f.documentController.redo(); expect(f.read()?.setup.missingNodeIds).toEqual([])
    const before = structuredClone(f.current()); f.call('closeWorkshopSetup'); f.open()
    expect(f.current()).toEqual(before); expect(f.read()?.setup.scope).toEqual({ kind: 'inserted', nodeIds: ['inserted-1'] })
    expect(f.host.getAssetDetail).not.toHaveBeenCalled(); expect(f.host.pickAsset).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it('retains the insertion scope when switching to all or a current selection', () => {
    const f = fixture(); f.add('one'); f.add('two'); f.open({ kind: 'inserted', nodeIds: ['one'] })
    f.call('changeWorkshopSetupScope', 'all'); expect(f.read()?.setup.scopeNodeIds).toEqual(['one', 'two'])
    f.patch('two', { selected: true }); f.call('changeWorkshopSetupScope', 'selection'); expect(f.read()?.setup.scopeNodeIds).toEqual(['two'])
    f.call('changeWorkshopSetupScope', 'inserted'); expect(f.read()?.setup.scopeNodeIds).toEqual(['one'])
  })
  it('uses the graph actually loaded by template creation and rejects late foreign completions', () => {
    const f = fixture(); f.add('persisted-node', 'video-input')
    const request = { ...f.layerEditorOwnerRef.current, projectEpoch: 1 }
    f.projectEpochRef.current = 2
    f.call('openCreatedWorkshopSetup', 'project-a', request)
    expect(f.read()?.setup.scope).toEqual({ kind: 'inserted', nodeIds: ['persisted-node'] })
    f.call('closeWorkshopSetup'); f.projectEpochRef.current++
    f.call('openCreatedWorkshopSetup', 'project-a', request); expect(f.state.open).toBe(false)
    f.projectEpochRef.current = 2; f.layerEditorOwnerRef.current.accountId = 'other'
    f.call('openCreatedWorkshopSetup', 'project-a', request); expect(f.state.open).toBe(false)
    f.layerEditorOwnerRef.current.accountId = request.accountId
    f.call('openCreatedWorkshopSetup', 'project-other', request); expect(f.state.open).toBe(false)
  })
  it('does no hidden graph preparation when closed and clears retained state on account changes', () => {
    const f = fixture(); f.add('source'); f.open(); f.call('workshopSetup'); expect(f.confirmedRunGroups).toHaveBeenCalledOnce()
    f.call('closeWorkshopSetup'); f.confirmedRunGroups.mockClear()
    f.patch('source', { position: { x: 40, y: 80 } }); expect(f.call('workshopSetup')).toBeNull(); expect(f.confirmedRunGroups).not.toHaveBeenCalled()
    const setupSession = f.workshopSetupSessionRef.current
    if (!setupSession) throw new Error('Missing actual preparation session')
    const mappingSession: MappingSession = { token: 5, scopeKey: setupSession.scopeKey, setupSession, nodeIds: ['source'], graphSignature: 'reviewed graph', sourceSignature: 'reviewed sources', groups: [] }
    const catalog: CanvasNodeSourceCatalog = { source: { state: 'pending', models: [] } }
    const controller = new AbortController()
    f.workshopModelMappingRevisionRef.current = 5
    f.workshopModelMappingSessionRef.current = mappingSession; f.mappingState.session = mappingSession
    f.workshopModelMappingCatalogRef.current = catalog; f.mappingState.catalog = catalog
    f.workshopModelMappingBusyRef.current = true; f.mappingState.busy = true
    f.workshopSetupAssetCheckRef.current = controller; f.workshopSetupActionBusyRef.current = true
    const actionRevision = f.workshopSetupActionRevisionRef.current
    f.call('resetWorkshopSetup')
    expect(f.workshopModelMappingRevisionRef.current).toBe(5); expect(f.mappingState.session).toBe(mappingSession)
    expect(f.workshopModelMappingSessionRef.current).toBe(mappingSession); expect(f.mappingState.catalog).toBe(catalog); expect(f.mappingState.busy).toBe(true)
    expect(controller.signal.aborted).toBe(false)
    f.layerEditorOwnerRef.current.accountId = 'next-account'; f.call('resetWorkshopSetup')
    expect(f.state.session).toBeNull(); expect(f.state.assets).toEqual({}); expect(f.state.open).toBe(false)
    expect(f.workshopModelMappingRevisionRef.current).toBe(6)
    expect(f.workshopModelMappingSessionRef.current).toBeNull(); expect(f.mappingState.session).toBeNull()
    expect(f.workshopModelMappingCatalogRef.current).toEqual({}); expect(f.mappingState.catalog).toEqual({})
    expect(f.workshopModelMappingBusyRef.current).toBe(false); expect(f.mappingState.busy).toBe(false)
    expect(controller.signal.aborted).toBe(true); expect(f.workshopSetupAssetCheckRef.current).toBeNull()
    expect(f.workshopSetupActionRevisionRef.current).toBe(actionRevision + 1); expect(f.workshopSetupActionBusyRef.current).toBe(false)
  })
  it('shows invalid imported recipes and graph failures without throwing or opening run confirmation', () => {
    const f = fixture(); f.add('bad-crop', 'image-crop', { settings: { imageTransform: { kind: 'unsupported' } } }); f.open()
    expect(() => f.call('workshopSetup')).not.toThrow(); expect(f.read()?.setup.error).toBeTruthy(); expect(f.read()?.graph).toBeNull()
    f.call('reviewWorkshopSetupRun'); expect(f.setPendingCanvasRun).not.toHaveBeenCalled()
    f.documentController.setNodes([]); f.add('a'); f.add('b')
    f.documentController.setEdges([{ id: 'a-b', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' }, { id: 'b-a', source: 'b', sourceHandle: 'out:text', target: 'a', targetHandle: 'in:text' }])
    expect(() => f.read()).not.toThrow(); expect(f.read()?.setup.error).toContain('循环')
    f.confirmedRunGroups.mockImplementationOnce(() => { throw new Error('当前来源无效') })
    expect(f.read()?.setup.error).toBe('当前来源无效'); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it('binds a local upload through the existing picker and only opens the existing run confirmation', async () => {
    const f = fixture(); f.add('video', 'video-input'); f.open({ kind: 'inserted', nodeIds: ['video'] })
    await f.act(f.item('pick-asset'))
    expect(f.host.pickAsset).toHaveBeenCalledExactlyOnceWith({ mediaType: 'video' })
    expect(f.current().nodes[0].data.result?.assetId).toBe(f.asset.assetId)
    expect(f.read()?.setup).toMatchObject({ canReviewRun: true, items: [] })
    f.call('reviewWorkshopSetupRun'); expect(f.state.open).toBe(false)
    expect(f.setPendingCanvasRun).toHaveBeenCalledExactlyOnceWith({ graph: expect.objectContaining({ nodes: [expect.objectContaining({ id: 'video', data: expect.objectContaining({ adoptedAssetId: f.asset.assetId }) })] }), scope: { kind: 'selection', nodeIds: ['video'] } })
    expect(f.setRunPreflight).toHaveBeenCalledOnce(); expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.generateImage).not.toHaveBeenCalled(); expect(f.host.generateVideo).not.toHaveBeenCalled()
  })
  it.each(scopeChanges)('does not bind a delayed upload after %s changes', async (_name, change) => {
    const f = fixture(); f.add('video', 'video-input'); f.open(); const pending = deferred<CanvasAssetSummary | null>()
    f.host.pickAsset.mockReturnValueOnce(pending.promise)
    const action = f.act(f.item('pick-asset')); change(f); const before = structuredClone(f.current()); pending.resolve(f.asset); await action
    expect(f.current()).toEqual(before); expect(f.markCanvasAssetUsed).not.toHaveBeenCalled(); expect(f.refreshAssets).not.toHaveBeenCalled()
  })
  it('prevents duplicate local uploads and refuses inherited locks without starting the picker', async () => {
    const f = fixture(); f.add('video', 'video-input'); f.open(); const pending = deferred<CanvasAssetSummary | null>(), item = f.item('pick-asset')
    f.host.pickAsset.mockReturnValueOnce(pending.promise)
    const first = f.act(item); await f.act(item); expect(f.host.pickAsset).toHaveBeenCalledOnce()
    pending.resolve(null); await first; expect(f.state.busy).toBe(false)
    f.add('group', 'group'); f.patch('group', { draggable: false }); f.patch('video', { parentId: 'group' })
    await f.act(f.item('pick-asset')); expect(f.host.pickAsset).toHaveBeenCalledOnce(); expect(f.state.error).toContain('权限已变化')
  })
  it('checks only explicitly requested unknown assets and discards cancelled or superseded results', async () => {
    const f = fixture(); f.add('video', 'video-input', { result: { kind: 'video', assetId: f.asset.assetId } }); f.open()
    expect(f.read()?.setup.canReviewRun).toBe(true); expect(f.host.getAssetDetail).not.toHaveBeenCalled()
    const pending = deferred<CanvasAssetSummary | null>(); f.host.getAssetDetail.mockReturnValueOnce(pending.promise)
    const action = f.act(f.item('check-asset')), signal = f.host.getAssetDetail.mock.calls[0][1] as AbortSignal
    expect(f.state.busy).toBe(true); f.call('closeWorkshopSetup'); f.open(); expect(signal.aborted).toBe(true)
    expect(f.state.assets[f.asset.assetId]).toBeUndefined(); pending.resolve(null); await action
    expect(f.read()?.setup.canReviewRun).toBe(true); expect(f.item('check-asset').blocking).toBe(false)
    f.host.getAssetDetail.mockResolvedValueOnce(null); await f.act(f.item('check-asset'))
    expect(f.item('pick-asset').blocking).toBe(true); expect(f.read()?.setup.canReviewRun).toBe(false)
    await f.act(f.item('pick-asset')); expect(f.read()?.setup.canReviewRun).toBe(true); expect(f.state.assets[f.asset.assetId].state).toBe('available')
  })
  it('uses loaded asset metadata and live model configuration without reloading account state', async () => {
    const f = fixture(); f.add('video', 'video-input', { result: { kind: 'video', assetId: f.asset.assetId } }); f.assetCatalog.push(f.asset); f.open()
    expect(f.read()?.setup.items).toEqual([]); expect(f.host.getAssetDetail).not.toHaveBeenCalled()
    f.add('generation', 'image-generate', { prompt: '产品海报', model: 'gpt-image-1', size: '1024x1024' })
    await f.act(f.item('configure-model')); expect(f.setMediaConfigOpen).toHaveBeenCalledWith(true)
    f.configuration.image = 'provider'; f.open(); expect(f.read()?.setup.canReviewRun).toBe(true)
    f.mediaModelsRef.current.image = ['gpt-image-2']; f.configuration.imageModel = 'gpt-image-2'
    const unavailable = f.item('inspect-node'); expect(unavailable.message).toContain('此节点的模型选择')
    f.setMediaConfigOpen.mockClear(); await f.act(unavailable)
    expect(f.locateNode).toHaveBeenCalledExactlyOnceWith('generation'); expect(f.setMediaConfigOpen).not.toHaveBeenCalledWith(true)
    const generation = f.current().nodes.find((node) => node.id === 'generation')!; f.patch('generation', { data: { ...generation.data, model: 'gpt-image-2' } }); f.open()
    expect(f.read()?.setup.canReviewRun).toBe(true); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it.each(['active', 'starting', 'projection', 'resuming', 'transition', 'no-host', 'no-run-permission'] as const)('rejects run review while %s', (condition) => {
    const f = fixture(); f.add('prompt', 'prompt', { prompt: '原创构想' }); f.open()
    expect(f.read()?.setup.canReviewRun).toBe(true)
    if (condition === 'active') f.activeRunsRef.current.add('active')
    if (condition === 'starting') f.startingRunsRef.current++
    if (condition === 'projection') f.pendingRunProjectionIdsRef.current.add('projection')
    if (condition === 'resuming') f.resumingTaskIdsRef.current.add('resuming')
    if (condition === 'transition') f.projectTransitionRef.current = true
    if (condition === 'no-host') f.environment.window = {}
    if (condition === 'no-run-permission') f.projectCanRunRef.current = false
    f.call('reviewWorkshopSetupRun'); expect(f.setPendingCanvasRun).not.toHaveBeenCalled(); expect(f.setRunPreflight).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.state.error).toBeTruthy()
  })
})


describe('actual workshop library image binding', () => {
  it('opens the shared picker and binds a confirmed private image once without generation', async () => {
    const f = fixture(); f.add('input', 'image-input'); f.open({ kind: 'inserted', nodeIds: ['input'] })
    await f.call('actOnWorkshopSetup', f.item('pick-asset'), true)
    expect(f.state.open).toBe(false)
    const picker = f.environment.workshopAssetPickerRef as { current: { nodeId: string } | null }
    expect(picker.current?.nodeId).toBe('input'); expect(f.host.pickAsset).not.toHaveBeenCalled()
    const image = { assetId: 'a'.repeat(43), mediaType: 'image' as const, mimeType: 'image/png' as const, localUrl: `xingmang-asset://image/${'a'.repeat(43)}`, thumbnailUrl: `xingmang-asset://image/${'a'.repeat(43)}`, fileName: 'own.png', createdAt: '2026-10-16' }
    f.host.getAssetDetail.mockResolvedValue(image)
    await f.call('chooseWorkshopAsset', image)
    expect(f.current().nodes[0].data.result?.assetId).toBe(image.assetId)
    expect(picker.current).toBeNull(); expect(f.state.open).toBe(true)
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.generateImage).not.toHaveBeenCalled()
    f.documentController.undo(); expect(f.current().nodes[0].data.result).toBeUndefined()
  })
  it.each(['account', 'close', 'lock'] as const)('rejects a late picked image after %s change', async (change) => {
    const f = fixture(); f.add('input', 'image-input'); f.open(); await f.call('actOnWorkshopSetup', f.item('pick-asset'), true)
    const deferredRead = deferred<CanvasAssetSummary | null>(); f.host.getAssetDetail.mockReturnValue(deferredRead.promise)
    const image = libraryAsset('image')
    const pending = f.call<Promise<void>>('chooseWorkshopAsset', image); await Promise.resolve()
    if (change === 'account') f.layerEditorOwnerRef.current.accountId = 'changed'
    else if (change === 'close') f.call('closeWorkshopAssetPicker')
    else f.patch('input', { draggable: false })
    deferredRead.resolve(image)
    await expect(pending).rejects.toThrow('变化'); expect(f.current().nodes[0].data.result).toBeUndefined()
  })
})

describe('actual workshop typed media library binding', () => {
  it('preserves existing typed edges and downstream results while one binding dirties the downstream node', async () => {
    const f = fixture(), asset = libraryAsset('video'), oldImage = libraryAsset('image')
    f.add('input', 'video-input'); f.add('frame', 'frame-extract', { settings: { timestampSeconds: 1 }, result: { kind: 'image', assetId: oldImage.assetId, localUrl: oldImage.localUrl } }); f.add('note', 'note', { prompt: 'Keep this note' })
    f.execute({ type: 'add-nodes', nodes: [], edges: [{ id: 'video-to-frame', source: 'input', target: 'frame', sourceHandle: 'out:video', targetHandle: 'in:video' }] })
    f.open({ kind: 'inserted', nodeIds: ['input', 'frame'] })
    const before = structuredClone(f.current()); f.execute.mockClear()
    await f.call('actOnWorkshopSetup', f.item('pick-asset'), true); f.host.getAssetDetail.mockResolvedValue(asset)
    await f.call('chooseWorkshopAsset', asset)
    const after = f.current()
    expect(after.edges).toEqual(before.edges); expect(after.nodes[2]).toEqual(before.nodes[2])
    expect(after.nodes[1].data.dirty).toBe(true); expect(after.nodes[1].data.result).toEqual(before.nodes[1].data.result); expect(after.nodes[1].data.settings).toEqual(before.nodes[1].data.settings)
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.current().nodes[0].data.status).toBe('succeeded')
    f.documentController.undo(); expect(f.current().nodes[0].data.result).toBeUndefined(); expect(f.current().nodes[1].data.dirty).toBeUndefined()
    f.documentController.redo(); expect(f.current().nodes[0].data.result?.assetId).toBe(asset.assetId); expect(f.current().nodes[1].data.dirty).toBe(true)
  })

  it.each(['image', 'video', 'audio'] as const)('binds an owned %s through the checklist with one undoable command and no model request', async (mediaType) => {
    const f = fixture(), asset = libraryAsset(mediaType)
    f.add('input', `${mediaType}-input`); f.add('unrelated', 'note', { prompt: 'Keep this note' }); f.open({ kind: 'inserted', nodeIds: ['input'] })
    const before = structuredClone(f.current()); f.execute.mockClear()
    await f.call('actOnWorkshopSetup', f.item('pick-asset'), true)
    const picker = f.environment.workshopAssetPickerRef as { current: { nodeId: string; mediaType: string } | null }
    expect(picker.current).toMatchObject({ nodeId: 'input', mediaType }); expect(f.host.pickAsset).not.toHaveBeenCalled()
    f.host.getAssetDetail.mockResolvedValue(asset)
    await f.call('chooseWorkshopAsset', asset)
    expect(f.current().nodes[0].data.result).toMatchObject({ kind: mediaType, assetId: asset.assetId, localUrl: asset.localUrl })
    expect(f.current().nodes[1]).toEqual(before.nodes[1]); expect(f.current().edges).toEqual(before.edges)
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.markCanvasAssetUsed).toHaveBeenCalledExactlyOnceWith(asset.assetId)
    expect(picker.current).toBeNull(); expect(f.state.open).toBe(true)
    f.documentController.undo(); expect(f.current().nodes[0].data.result).toBeUndefined()
    f.documentController.redo(); expect(f.current().nodes[0].data.result?.assetId).toBe(asset.assetId)
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.generateImage).not.toHaveBeenCalled(); expect(f.host.generateVideo).not.toHaveBeenCalled()
  })

  it('keeps the picker and graph unchanged when the document rejects a confirmed binding', async () => {
    const f = fixture(), asset = libraryAsset('image')
    f.add('input', 'image-input'); f.open(); await f.call('actOnWorkshopSetup', f.item('pick-asset'), true)
    const before = structuredClone(f.current()), picker = (f.environment.workshopAssetPickerRef as { current: unknown }).current
    f.host.getAssetDetail.mockResolvedValue(asset); f.execute.mockImplementationOnce(() => null)
    await expect(f.call<Promise<void>>('chooseWorkshopAsset', asset)).rejects.toThrow('尚未绑定')
    expect(f.current()).toEqual(before); expect((f.environment.workshopAssetPickerRef as { current: unknown }).current).toBe(picker)
    expect(f.assetCatalog).toEqual([]); expect(f.markCanvasAssetUsed).not.toHaveBeenCalled(); expect(f.state.open).toBe(false)
    await f.call('chooseWorkshopAsset', asset)
    expect(f.current().nodes[0].data.result?.assetId).toBe(asset.assetId)
    expect(f.markCanvasAssetUsed).toHaveBeenCalledOnce()
  })

  it.each(['foreign-url', 'wrong-mime', 'recycled', 'wrong-id'] as const)('refuses a %s detail without mutating the graph or claiming success', async (condition) => {
    const f = fixture(), selected = libraryAsset('image')
    f.add('input', 'image-input'); f.open(); await f.call('actOnWorkshopSetup', f.item('pick-asset'), true)
    const before = structuredClone(f.current()), detail = { ...selected }
    if (condition === 'foreign-url') detail.localUrl = 'https://foreign.invalid/private.png'
    if (condition === 'wrong-mime') Object.assign(detail, { mimeType: 'video/mp4' })
    if (condition === 'recycled') detail.deletedAt = '2026-10-18T01:00:00.000Z'
    if (condition === 'wrong-id') detail.assetId = 'z'.repeat(43)
    f.host.getAssetDetail.mockResolvedValue(detail)
    await expect(f.call<Promise<void>>('chooseWorkshopAsset', selected)).rejects.toThrow()
    expect(f.current()).toEqual(before); expect(f.assetCatalog).toEqual([]); expect(f.markCanvasAssetUsed).not.toHaveBeenCalled()
  })

  it.each(['active', 'starting', 'projection', 'resuming'] as const)('keeps an existing picker from applying while a %s operation starts', async (condition) => {
    const f = fixture(), asset = libraryAsset('image')
    f.add('input', 'image-input'); f.open(); await f.call('actOnWorkshopSetup', f.item('pick-asset'), true)
    const wait = deferred<CanvasAssetSummary | null>(); f.host.getAssetDetail.mockReturnValue(wait.promise)
    const pending = f.call<Promise<void>>('chooseWorkshopAsset', asset); await Promise.resolve()
    if (condition === 'active') f.activeRunsRef.current.add('running')
    if (condition === 'starting') f.startingRunsRef.current++
    if (condition === 'projection') f.pendingRunProjectionIdsRef.current.add('pending')
    if (condition === 'resuming') f.resumingTaskIdsRef.current.add('recovering')
    wait.resolve(asset)
    await expect(pending).rejects.toThrow('变化')
    expect(f.current().nodes[0].data.result).toBeUndefined(); expect(f.markCanvasAssetUsed).not.toHaveBeenCalled()
  })

  it.each(['image', 'video', 'audio'] as const)('rejects a mismatched %s picker selection before reading another asset', async (mediaType) => {
    const f = fixture(), asset = libraryAsset(mediaType === 'image' ? 'video' : 'image')
    f.add('input', `${mediaType}-input`); f.open(); await f.call('actOnWorkshopSetup', f.item('pick-asset'), true)
    f.host.getAssetDetail.mockClear()
    await expect(f.call<Promise<void>>('chooseWorkshopAsset', asset)).rejects.toThrow('类型或信息不匹配')
    expect(f.host.refreshProjectAccess).not.toHaveBeenCalled(); expect(f.host.getAssetDetail).not.toHaveBeenCalled()
    expect(f.current().nodes[0].data.result).toBeUndefined()
  })

  it('uses the current checklist item rather than a forged media type', async () => {
    const f = fixture(); f.add('input', 'video-input'); f.open()
    await f.call('actOnWorkshopSetup', { ...f.item('pick-asset'), mediaType: 'image' }, true)
    expect((f.environment.workshopAssetPickerRef as { current: unknown }).current).toBeNull()
    expect(f.host.pickAsset).not.toHaveBeenCalled(); expect(f.state.error).toContain('变化')
  })

  it('checks refreshed server editing permission before fetching or binding a selected asset', async () => {
    const f = fixture(), asset = libraryAsset('image')
    f.add('input', 'image-input'); f.open(); await f.call('actOnWorkshopSetup', f.item('pick-asset'), true)
    f.host.getProjectAccess.mockReturnValue({ projectId: 'project-a', access: { projectId: 'project-a', canEdit: false } })
    await expect(f.call<Promise<void>>('chooseWorkshopAsset', asset)).rejects.toThrow('编辑权限已变化')
    expect(f.host.refreshProjectAccess).toHaveBeenCalledOnce(); expect(f.host.getAssetDetail).not.toHaveBeenCalled()
    expect(f.current().nodes[0].data.result).toBeUndefined(); expect(f.markCanvasAssetUsed).not.toHaveBeenCalled()
  })

  it.each(['image', 'video', 'audio'] as const)('does not apply a late %s selection after any owner, project, target or permission change', async (mediaType) => {
    for (const change of ['account', 'project', 'reload', 'close', 'lock', 'parent-lock', 'delete', 'permission', 'draft-recovery', 'save-conflict']) {
      const f = fixture(), asset = libraryAsset(mediaType)
      f.add('parent', 'group'); f.add('input', `${mediaType}-input`); f.patch('input', { parentId: 'parent' }); f.open({ kind: 'inserted', nodeIds: ['input'] })
      await f.call('actOnWorkshopSetup', f.item('pick-asset'), true)
      const wait = deferred<CanvasAssetSummary | null>(); f.host.getAssetDetail.mockReturnValue(wait.promise)
      const pending = f.call<Promise<void>>('chooseWorkshopAsset', asset)
      await vi.waitFor(() => expect(f.host.getAssetDetail).toHaveBeenCalledOnce())
      if (change === 'account') f.layerEditorOwnerRef.current.accountId = 'other'
      if (change === 'project') f.activeProjectIdRef.current = 'project-b'
      if (change === 'reload') f.projectEpochRef.current++
      if (change === 'close') f.call('closeWorkshopAssetPicker')
      if (change === 'lock') f.patch('input', { draggable: false })
      if (change === 'parent-lock') f.patch('parent', { draggable: false })
      if (change === 'delete') f.documentController.execute({ type: 'delete-elements', nodeIds: ['input'] })
      if (change === 'permission') f.projectCanEditRef.current = false
      if (change === 'draft-recovery') f.draftRecoveryPendingRef.current = true
      if (change === 'save-conflict') (f.environment.saveConflictRef as { current: boolean }).current = true
      const unchanged = structuredClone(f.current()); wait.resolve(asset)
      await expect(pending, change).rejects.toThrow('变化')
      expect(f.current(), change).toEqual(unchanged); expect(f.assetCatalog, change).toEqual([]); expect(f.markCanvasAssetUsed, change).not.toHaveBeenCalled()
      expect(f.host.startRun, change).not.toHaveBeenCalled(); expect(f.host.generateVideo, change).not.toHaveBeenCalled()
    }
  })

  it.each(['denied', 'readonly', 'foreign-project', 'foreign-access', 'missing'] as const)('rejects a late host %s state even while React permission refs are still stale', async (change) => {
    const f = fixture(), asset = libraryAsset('video')
    f.add('input', 'video-input'); f.open(); await f.call('actOnWorkshopSetup', f.item('pick-asset'), true)
    const wait = deferred<CanvasAssetSummary | null>(); f.host.getAssetDetail.mockReturnValue(wait.promise)
    const pending = f.call<Promise<void>>('chooseWorkshopAsset', asset)
    await vi.waitFor(() => expect(f.host.getAssetDetail).toHaveBeenCalledOnce())
    const state: HostAccessState = change === 'missing' ? null : { projectId: change === 'foreign-project' ? 'project-b' : 'project-a', ...(change === 'denied' ? { denied: true } : { access: { projectId: change === 'foreign-access' ? 'project-b' : 'project-a', canEdit: change !== 'readonly' } }) }
    f.host.getProjectAccess.mockReturnValue(state)
    const before = structuredClone(f.current()); f.execute.mockClear(); wait.resolve(asset)
    await expect(pending).rejects.toThrow('编辑权限已变化')
    expect(f.projectCanEditRef.current).toBe(true); expect(f.current()).toEqual(before)
    expect(f.execute).not.toHaveBeenCalled(); expect(f.markCanvasAssetUsed).not.toHaveBeenCalled(); expect(f.state.open).toBe(false)
    expect((f.environment.workshopAssetPickerRef as { current: unknown }).current).not.toBeNull()
  })
})
