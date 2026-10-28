import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasGroupSummary, CanvasPreparedGroup } from '../host'
import { parseImageCollageInputOrder } from '../image-tools/collage-input-order'
import { parseNodeImageEditMask } from '../image-tools/image-mask-workflow'
import { layerEditorScopeToken } from '../image-tools/layer-editor-scope'
import { imageTransformRecipeForNode, isImageTransformNodeKind } from '../image-tools/recipe'
import { dramaPreflightBlockReasons } from '../library/drama-graph'
import { prepareCanvasNodeSources, type CanvasNodeSourceCatalog } from '../library/node-model-availability'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { maximumOutputTextLength } from '../persistence/workflow-schema'
import { parseImageCandidateCount } from '../runtime/image-candidate-count'
import { cachedNodeIdsForPreflight } from '../runtime/pinned-reuse'
import { downstreamNodeIds, markNodeAndDescendantsDirty } from '../runtime/run-projection'
import { buildCanvasRunPreflight } from '../runtime/run-preflight'
import { parseTextWebSearch } from '../runtime/text-web-search'
import { parseVideoGenerateAudio } from '../runtime/video-audio'
import { parseVideoCandidateCount } from '../runtime/video-candidate-count'
import { createCanvasDocument } from '../store/canvas-state'
import { canvasNodeDocumentRecord, useCanvasDocument, type CanvasDocumentController } from '../store/use-canvas-document'
import { parseVideoReferenceOrder } from '../video-tools/video-reference-order'
import { buildWorkshopSetup, type WorkshopSetupScope } from './workshop-setup'
import { buildWorkshopModelMapping, planWorkshopModelMapping, type WorkshopModelMappingChoice, type WorkshopModelMappingIssue } from './workshop-model-mapping'
import { workshopModelMappingGraphSignature, workshopModelMappingNodes, workshopModelMappingSourceSignature } from './workshop-model-mapping-snapshot'
import { canvasNodeKindAvailable } from '../host-capabilities'
import { fullCanvasCapabilityProfile } from '../host-capabilities.test-fixture'
import { canvasRunInputForHost, withoutHostDisabledDefaults } from '../runtime/host-run-compatibility'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const expressions = new Map<string, string>()
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name) expressions.set(node.name.text, node.getText(source).replace(/^export\s+/, ''))
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && ['useCallback', 'useMemo'].includes(node.initializer.expression.getText(source))) expressions.set(node.name.text, node.initializer.arguments[0].getText(source))
  ts.forEachChild(node, visit)
}
visit(source)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  const expression = expressions.get(name)
  if (!expression) throw Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function deferred<T>() { let resolve: (value: T) => void = () => {}; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
interface SetupSession { scopeKey: string; scope: WorkshopSetupScope; insertedNodeIds?: readonly string[] }
interface MappingSession { token: number; scopeKey: string; setupSession: SetupSession; nodeIds: string[]; graphSignature: string; sourceSignature: string; groups: CanvasGroupSummary[] }
interface MappingReview { choicesSignature: string; issues: WorkshopModelMappingIssue[] }

function fixture() {
  let controller: CanvasDocumentController | undefined
  function project(record: EditorNodeRecord): CanvasNode { return { ...record, type: record.type as CanvasNode['type'], ...(record.locked ? { draggable: false } : {}), data: { prompt: '', model: '', status: 'idle', ...record.data } } }
  function Capture() { controller = useCanvasDocument(project); return null }
  renderToStaticMarkup(createElement(Capture)); if (!controller) throw Error('Missing real document controller')
  const documentController = controller, current = controller.getGraphSnapshot
  const groupA: CanvasGroupSummary = { name: 'source-a', description: '本人多用途 A', ratio: 1, purposes: ['image', 'video', 'text'], revision: 7, connectionStatus: 'ready', videoProtocol: 'relay-videos' }
  const groupB: CanvasGroupSummary = { name: 'source-b', description: '本人图片 B', ratio: 1, purposes: ['image'], revision: 3, connectionStatus: 'ready' }
  const groupsRef = { current: [groupA, groupB] }, prepared: Record<string, CanvasPreparedGroup> = {
    'source-a': { group: groupA.name, models: ['gpt-4o-mini', 'gpt-image-1', 'grok-imagine-video'], purposes: groupA.purposes, videoProtocol: groupA.videoProtocol, revision: groupA.revision, keyCreated: false },
    'source-b': { group: groupB.name, models: ['gpt-image-2'], purposes: groupB.purposes, revision: groupB.revision, keyCreated: false },
  }
  const access = { current: { projectId: 'project-a', denied: false, access: { canEdit: true, canRun: true } } }
  const host = { prepareGroup: vi.fn<(name: string) => Promise<CanvasPreparedGroup>>(async (name) => structuredClone(prepared[name])), refreshProjectAccess: vi.fn<() => Promise<void>>().mockResolvedValue(undefined), getProjectAccess: vi.fn(() => access.current), startRun: vi.fn(), generateImage: vi.fn(), generateVideo: vi.fn() }
  const readGroupCatalog = vi.fn<(refresh?: boolean) => Promise<CanvasGroupSummary[]>>(async () => structuredClone(groupsRef.current))
  const workshopModelMappingSessionRef = { current: null as MappingSession | null }, workshopModelMappingRevisionRef = { current: 0 }, workshopModelMappingBusyRef = { current: false }, workshopModelMappingCatalogRef = { current: {} as CanvasNodeSourceCatalog }, workshopModelMappingChoicesRef = { current: [] as WorkshopModelMappingChoice[] }, workshopModelMappingReviewRef = { current: null as MappingReview | null }
  const workshopSetupSessionRef = { current: null as SetupSession | null }, layerEditorOwnerRef = { current: { ownerId: 22, accountId: 'account-a' } }, activeProjectIdRef = { current: 'project-a' }, projectEpochRef = { current: 1 }, draftActionsEnabledRef = { current: true }, projectCanEditRef = { current: true }, projectCanRunRef = { current: true }, projectTransitionRef = { current: false }, draftRecoveryPendingRef = { current: false }, saveConflictRef = { current: false }, agentMountedRef = { current: true }
  const activeRunsRef = { current: new Set<string>() }, startingRunsRef = { current: 0 }, pendingRunProjectionIdsRef = { current: new Set<string>() }, resumingTaskIdsRef = { current: new Set<string>() }
  const state = { session: null as MappingSession | null, catalog: {} as CanvasNodeSourceCatalog, choices: [] as WorkshopModelMappingChoice[], review: null as MappingReview | null, busy: false, error: undefined as string | undefined, setupOpen: true, setupError: undefined as string | undefined, dirty: new Set<string>() }
  const execute = vi.fn(documentController.execute), graphRef = { current: current() }, setBanner = vi.fn()
  const environment: Record<string, unknown> = {
    builtinNodeRegistry, parseImageCandidateCount, parseVideoCandidateCount, parseTextWebSearch, parseVideoGenerateAudio, parseVideoReferenceOrder, parseNodeImageEditMask, imageTransformRecipeForNode, isImageTransformNodeKind, parseImageCollageInputOrder, maximumOutputTextLength, cachedNodeIdsForPreflight, dramaPreflightBlockReasons, buildWorkshopSetup,
    canvasCapabilities: () => fullCanvasCapabilityProfile, canvasNodeKindAvailable, canvasRunInputForHost, withoutHostDisabledDefaults, buildWorkshopModelMapping, planWorkshopModelMapping, workshopModelMappingGraphSignature, workshopModelMappingNodes, workshopModelMappingSourceSignature, prepareCanvasNodeSources, buildCanvasRunPreflight, markNodeAndDescendantsDirty, downstreamNodeIds, canvasNodeDocumentRecord, layerEditorScopeToken,
    workshopModelMappingSessionRef, workshopModelMappingRevisionRef, workshopModelMappingBusyRef, workshopModelMappingCatalogRef, workshopModelMappingChoicesRef, workshopModelMappingReviewRef, workshopSetupSessionRef,
    layerEditorOwnerRef, activeProjectIdRef, projectEpochRef, draftActionsEnabledRef, projectCanEditRef, projectCanRunRef, projectTransitionRef, draftRecoveryPendingRef, saveConflictRef, agentMountedRef, activeRunsRef, startingRunsRef, pendingRunProjectionIdsRef, resumingTaskIdsRef, groupsRef, readGroupCatalog,
    hostBridge: () => host, getGraphSnapshot: current, execute, graphRef, setBanner,
    nodeSourceCatalogRef: { current: {} }, mediaModelsRef: { current: { image: ['gpt-image-1'], video: ['grok-imagine-video'], text: ['gpt-4o-mini'] } }, imageAssetDimensions: {}, assetCatalog: [], workshopSetupAssets: {},
    confirmedRunGroups: () => ({ image: 'source-a', video: 'source-a', text: 'source-a', videoProtocol: 'relay-videos' }),
    setWorkshopModelMappingSession: (value: MappingSession | null) => { state.session = value }, setWorkshopModelMappingCatalog: (value: CanvasNodeSourceCatalog) => { state.catalog = value }, setWorkshopModelMappingChoices: (value: WorkshopModelMappingChoice[]) => { state.choices = value }, setWorkshopModelMappingReview: (value: MappingReview | null) => { state.review = value }, setWorkshopModelMappingBusy: (value: boolean) => { state.busy = value }, setWorkshopModelMappingError: (value: string | undefined) => { state.error = value }, setWorkshopSetupOpen: (value: boolean) => { state.setupOpen = value }, setWorkshopSetupError: (value: string | undefined) => { state.setupError = value }, setDirtyNodeIds: (update: (previous: Set<string>) => Set<string>) => { state.dirty = update(state.dirty) },
  }
  for (const name of ['isCanvasGraphNode', 'toWorkflowEdge', 'toWorkflowNode', 'toCanvasRunGraph', 'currentWorkshopSetupScope']) environment[name] = actual(name, environment)
  for (const name of ['readWorkshopSetup', 'inspectWorkshopModelMapping', 'closeWorkshopModelMapping']) environment[name] = (...args: unknown[]) => actual<(...values: unknown[]) => unknown>(name, environment)(...args)
  function call<T>(name: string, ...args: unknown[]): T { return actual<(...values: unknown[]) => T>(name, environment)(...args) }
  function patch(id: string, changes: Partial<CanvasNode>) { documentController.setNodes((nodes) => nodes.map((node) => node.id === id ? { ...node, ...changes } : node)) }
  function patchData(id: string, data: Partial<CanvasNode['data']>) { const node = current().nodes.find((node) => node.id === id); if (!node) throw Error('Fixture node absent'); patch(id, { data: { ...node.data, ...data } }) }
  const mediaResult = { kind: 'image' as const, assetId: 'i'.repeat(43), localUrl: '/synthetic.png' }
  const initial: EditorNodeRecord[] = [
    { id: 'parent', type: 'group', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', settings: { title: '祖先分组' } } },
    { id: 'brief', type: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: 'R76 brief', model: '' } },
    { id: 'text', type: 'text-generate', definitionVersion: 1, position: { x: 300, y: 0 }, data: { prompt: 'R76 text', model: 'gpt-4.1-mini', outputText: 'old complete text' } },
    ...['image-a', 'image-b'].map((id, index) => ({ id, type: 'image-generate', definitionVersion: 1, ...(index === 0 ? { parentId: 'parent' } : {}), position: { x: 600, y: index * 300 }, data: { prompt: `R76 ${id}`, model: 'gpt-image-2', size: '1024x1024', quality: 'low', imageResolution: '1K', imageCandidateCount: 1, result: mediaResult, candidateAssetIds: [mediaResult.assetId], settings: { title: id } } })),
    { id: 'video', type: 'video-generate', definitionVersion: 1, position: { x: 1000, y: 0 }, data: { prompt: 'R76 video', model: 'grok-imagine-video-1.5', size: '1280x720', seconds: '2', settings: { videoMode: 't2va', videoResolution: '720p', videoAspectRatio: '16:9' } } },
    { id: 'downstream', type: 'gallery', definitionVersion: 1, position: { x: 1000, y: 400 }, data: { prompt: '', model: '', result: mediaResult } },
    { id: 'outside', type: 'image-generate', definitionVersion: 1, position: { x: 1400, y: 0 }, data: { prompt: 'out of scope', model: 'gpt-image-2', group: 'source-b', size: '1536x1152', result: mediaResult } },
  ]
  const edges = [{ id: 'brief-text', source: 'brief', sourceHandle: 'out:text', target: 'text', targetHandle: 'in:text' }, ...['image-a', 'image-b', 'video'].map((target) => ({ id: `text-${target}`, source: 'text', sourceHandle: 'out:text', target, targetHandle: 'in:text' })), { id: 'image-gallery', source: 'image-a', sourceHandle: 'out:image', target: 'downstream', targetHandle: 'in:images' }]
  documentController.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: initial, edges } }); execute.mockClear()
  function scope(ids = ['brief', 'text', 'image-a', 'image-b', 'video']) { const scopeKey = call<string>('currentWorkshopSetupScope'); workshopSetupSessionRef.current = { scopeKey, scope: { kind: 'inserted', nodeIds: ids }, insertedNodeIds: ids } }
  scope()
  async function open() { await call<Promise<void>>('openWorkshopModelMapping') }
  function choices() {
    if (!workshopModelMappingSessionRef.current) throw Error('Mapping not open')
    const input = { nodes: workshopModelMappingNodes(current().nodes), nodeIds: workshopModelMappingSessionRef.current.nodeIds, groups: workshopModelMappingSessionRef.current.groups, catalog: workshopModelMappingCatalogRef.current }
    return buildWorkshopModelMapping(input).rows.map((row) => ({ rowId: row.id, group: 'source-a', model: row.purpose === 'image' ? 'gpt-image-1' : row.purpose === 'video' ? 'grok-imagine-video' : 'gpt-4o-mini' }))
  }
  async function review() { await open(); call('changeWorkshopModelMapping', choices()); call('reviewWorkshopModelMapping'); expect(state.review, state.error).not.toBeNull() }
  return { state, call, current, patch, patchData, scope, open, review, choices, host, access, prepared, readGroupCatalog, groupsRef, execute, documentController, graphRef, setBanner, workshopModelMappingSessionRef, workshopModelMappingBusyRef, workshopModelMappingReviewRef, workshopModelMappingChoicesRef, workshopSetupSessionRef, layerEditorOwnerRef, activeProjectIdRef, projectEpochRef, draftActionsEnabledRef, projectCanEditRef, projectCanRunRef, projectTransitionRef, draftRecoveryPendingRef, saveConflictRef, agentMountedRef, activeRunsRef, startingRunsRef, pendingRunProjectionIdsRef, resumingTaskIdsRef }
}
type Fixture = ReturnType<typeof fixture>

describe('actual App workshop bulk model mapping callbacks', () => {
  it('prepares saved catalogs once per source and cancels without mutation or generation', async () => {
    const f = fixture(), before = structuredClone(f.current())
    await f.open(); expect(f.host.prepareGroup).toHaveBeenCalledTimes(2); expect(f.state.session?.nodeIds).toEqual(['brief', 'text', 'image-a', 'image-b', 'video'])
    f.call('changeWorkshopModelMapping', f.choices()); f.call('reviewWorkshopModelMapping'); f.call('closeWorkshopModelMapping')
    expect(f.current()).toEqual(before); expect(f.execute).not.toHaveBeenCalled(); expect(f.state.setupOpen).toBe(true)
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.generateImage).not.toHaveBeenCalled(); expect(f.host.generateVideo).not.toHaveBeenCalled()
  })
  it('changes only explicit routes in one real history command and preserves parameters results and outside scope', async () => {
    const f = fixture(), before = structuredClone(f.current())
    await f.review(); await f.call<Promise<void>>('applyWorkshopModelMapping')
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.execute.mock.calls[0][0].type).toBe('replace-nodes')
    const after = structuredClone(f.current())
    for (const id of ['text', 'image-a', 'image-b', 'video']) {
      const original = before.nodes.find((node) => node.id === id)!, changed = after.nodes.find((node) => node.id === id)!
      expect(changed.data.group).toBe('source-a'); expect(changed.data.model).toBe(id === 'text' ? 'gpt-4o-mini' : id === 'video' ? 'grok-imagine-video' : 'gpt-image-1')
      for (const key of ['prompt', 'size', 'quality', 'imageResolution', 'imageCandidateCount', 'seconds', 'result', 'candidateAssetIds', 'outputText', 'settings'] as const) expect(changed.data[key]).toEqual(original.data[key])
    }
    expect(after.nodes.find((node) => node.id === 'outside')).toEqual(before.nodes.find((node) => node.id === 'outside'))
    expect(after.nodes.find((node) => node.id === 'downstream')?.data).toMatchObject({ dirty: true, result: before.nodes.find((node) => node.id === 'downstream')?.data.result })
    expect(f.state.dirty).toEqual(new Set(['text', 'image-a', 'image-b', 'video', 'downstream']))
    f.documentController.undo(); expect(f.current()).toEqual(before)
    f.documentController.redo(); expect(f.current()).toEqual(after)
    expect(f.host.refreshProjectAccess).toHaveBeenCalledOnce(); expect(f.readGroupCatalog).toHaveBeenLastCalledWith(true); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it('retains an incompatible size as a visible pending draft without starting a run', async () => {
    const f = fixture(); f.patchData('image-b', { size: '1536x1152' }); await f.review()
    expect(f.state.review?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'image-b', message: expect.stringContaining('GPT Image 1 仅支持 1024x1024、1024x1536、1536x1024 或 auto') })]))
    await f.call<Promise<void>>('applyWorkshopModelMapping')
    expect(f.current().nodes.find((node) => node.id === 'image-b')?.data).toMatchObject({ model: 'gpt-image-1', size: '1536x1152' })
    expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it('does not invalidate review for selection camera or refreshed source-list ordering', async () => {
    const f = fixture(); await f.review()
    f.patch('image-a', { selected: true }); f.documentController.setViewport({ x: 500, y: -120, zoom: .5 }); f.groupsRef.current = [...f.groupsRef.current].reverse()
    await f.call<Promise<void>>('applyWorkshopModelMapping'); expect(f.execute).toHaveBeenCalledOnce(); expect(f.state.error).toBeUndefined()
    expect(f.current().nodes.find((node) => node.id === 'image-a')?.selected).toBe(true)
  })
  const boundaryChanges: Array<[string, (f: Fixture) => void]> = [
    ['account', (f) => { f.layerEditorOwnerRef.current.accountId = 'account-b' }],
    ['owner', (f) => { f.layerEditorOwnerRef.current.ownerId = 23 }],
    ['project', (f) => { f.activeProjectIdRef.current = 'project-b' }],
    ['same-project reload', (f) => { f.projectEpochRef.current++ }],
    ['edit permission', (f) => { f.projectCanEditRef.current = false }],
    ['run permission', (f) => { f.projectCanRunRef.current = false }],
    ['account disabled', (f) => { f.draftActionsEnabledRef.current = false }],
    ['unmount', (f) => { f.agentMountedRef.current = false }],
    ['transition', (f) => { f.projectTransitionRef.current = true }],
    ['draft recovery', (f) => { f.draftRecoveryPendingRef.current = true }],
    ['save conflict', (f) => { f.saveConflictRef.current = true }],
    ['active run', (f) => { f.activeRunsRef.current.add('run') }],
    ['run submission', (f) => { f.startingRunsRef.current = 1 }],
    ['pending result', (f) => { f.pendingRunProjectionIdsRef.current.add('node') }],
    ['resuming task', (f) => { f.resumingTaskIdsRef.current.add('task') }],
    ['scope replaced', (f) => { f.scope(['outside']) }],
    ['dialog closed', (f) => { f.call('closeWorkshopModelMapping') }],
  ]
  it.each(boundaryChanges)('rejects late catalog preparation after %s changes', async (_label, change) => {
    const f = fixture(), pending = deferred<CanvasPreparedGroup>(); f.host.prepareGroup.mockReturnValueOnce(pending.promise)
    const opening = f.open(); await Promise.resolve(); await Promise.resolve(); expect(f.host.prepareGroup).toHaveBeenCalled(); change(f)
    const before = structuredClone(f.current()); pending.resolve(f.prepared['source-a']); await opening
    expect(f.current()).toEqual(before); expect(f.execute).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
    if (!f.state.session) expect(f.state.catalog).toEqual({})
  })
  it.each(boundaryChanges)('rejects late access refresh after %s changes', async (_label, change) => {
    const f = fixture(); await f.review(); const pending = deferred<void>(); f.host.refreshProjectAccess.mockReturnValueOnce(pending.promise)
    const applying = f.call<Promise<void>>('applyWorkshopModelMapping'); change(f); const before = structuredClone(f.current()); pending.resolve(); await applying
    expect(f.current()).toEqual(before); expect(f.execute).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  const documentChanges: Array<[string, (f: Fixture) => void]> = [
    ['model', (f) => f.patchData('image-a', { model: 'gpt-image-1' })],
    ['fixed group', (f) => f.patchData('image-a', { group: 'source-b' })],
    ['parameter', (f) => f.patchData('image-a', { quality: 'high' })],
    ['prompt', (f) => f.patchData('image-a', { prompt: 'changed independently' })],
    ['ancestor lock', (f) => f.patch('parent', { draggable: false })],
    ['edge', (f) => f.documentController.setEdges((edges) => edges.filter((edge) => edge.id !== 'text-image-a'))],
    ['scope node deleted', (f) => f.documentController.setNodes((nodes) => nodes.filter((node) => node.id !== 'image-a'))],
  ]
  it.each(documentChanges)('preserves intervening %s changes instead of overwriting them', async (_label, change) => {
    const f = fixture(); await f.review(); change(f); const before = structuredClone(f.current()); await f.call<Promise<void>>('applyWorkshopModelMapping')
    expect(f.current()).toEqual(before); expect(f.execute).not.toHaveBeenCalled(); expect(f.state.error).toMatch(/画布内容已变化/)
  })
  it.each(['revision', 'purposes', 'videoProtocol'] as const)('rejects a source %s change and retains the canvas', async (key) => {
    const f = fixture(); await f.review(); const before = structuredClone(f.current())
    f.groupsRef.current = f.groupsRef.current.map((group) => group.name !== 'source-a' ? group : key === 'revision' ? { ...group, revision: 8 } : key === 'purposes' ? { ...group, purposes: ['image'] } : { ...group, videoProtocol: 'xai-native' })
    await f.call<Promise<void>>('applyWorkshopModelMapping'); expect(f.current()).toEqual(before); expect(f.execute).not.toHaveBeenCalled(); expect(f.state.error).toContain('来源目录已变化')
  })
  it('rejects refreshed model-list changes even when source metadata revision was not updated', async () => {
    const f = fixture(); await f.review(); const before = structuredClone(f.current()); f.prepared['source-a'].models = ['gpt-image-1', 'grok-imagine-video']
    await f.call<Promise<void>>('applyWorkshopModelMapping'); expect(f.current()).toEqual(before); expect(f.execute).not.toHaveBeenCalled(); expect(f.state.error).toContain('模型目录已变化')
  })
  it.each(['denied', 'edit', 'run', 'project'] as const)('honors refreshed host access %s before committing', async (key) => {
    const f = fixture(); await f.review(); const before = structuredClone(f.current())
    if (key === 'denied') f.access.current.denied = true
    if (key === 'edit') f.access.current.access.canEdit = false
    if (key === 'run') f.access.current.access.canRun = false
    if (key === 'project') f.access.current.projectId = 'project-b'
    await f.call<Promise<void>>('applyWorkshopModelMapping'); expect(f.current()).toEqual(before); expect(f.execute).not.toHaveBeenCalled(); expect(f.state.error).toContain('权限已变化')
  })
  it('requires the exact previewed choices and guards double apply with one history transaction', async () => {
    const f = fixture(); await f.open(); f.call('changeWorkshopModelMapping', f.choices()); await f.call<Promise<void>>('applyWorkshopModelMapping'); expect(f.execute).not.toHaveBeenCalled(); expect(f.state.error).toContain('请先预览')
    f.call('reviewWorkshopModelMapping'); const pending = deferred<void>(); f.host.refreshProjectAccess.mockReturnValueOnce(pending.promise)
    const first = f.call<Promise<void>>('applyWorkshopModelMapping'), second = f.call<Promise<void>>('applyWorkshopModelMapping')
    expect(f.host.refreshProjectAccess).toHaveBeenCalledOnce(); pending.resolve(); await Promise.all([first, second]); expect(f.execute).toHaveBeenCalledOnce(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it('keeps one failed catalog visible while allowing explicit choices from another ready source', async () => {
    const f = fixture(); f.host.prepareGroup.mockImplementation(async (name) => { if (name === 'source-b') throw Error('synthetic saved catalog read failed'); return structuredClone(f.prepared[name]) })
    await f.open(); expect(f.state.error).toContain('1 个来源未能读取'); expect(f.state.catalog['source-b'].state).toBe('error')
    f.call('changeWorkshopModelMapping', f.choices()); f.call('reviewWorkshopModelMapping'); await f.call<Promise<void>>('applyWorkshopModelMapping'); expect(f.execute).toHaveBeenCalledOnce(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it('does not let an old delayed catalog repopulate a reopened mapping session', async () => {
    const f = fixture(), pending = deferred<CanvasPreparedGroup>(); f.host.prepareGroup.mockReturnValueOnce(pending.promise)
    const oldOpen = f.open(); await Promise.resolve(); await Promise.resolve(); expect(f.host.prepareGroup).toHaveBeenCalled()
    f.call('closeWorkshopModelMapping'); await f.open(); const session = f.state.session, catalog = structuredClone(f.state.catalog)
    pending.resolve({ ...f.prepared['source-a'], models: ['stale-old-model'] }); await oldOpen
    expect(f.state.session).toBe(session); expect(f.state.catalog).toEqual(catalog); expect(f.state.busy).toBe(false); expect(f.execute).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it.each([['scope', (f: Fixture) => { f.activeProjectIdRef.current = 'other' }], ['document', (f: Fixture) => { f.patchData('image-a', { size: '1024x1536' }) }], ['close', (f: Fixture) => { f.call('closeWorkshopModelMapping') }]] as const)('rejects a delayed final selected-source preparation after %s changes', async (_label, change) => {
    const f = fixture(); await f.review(); const pending = deferred<CanvasPreparedGroup>(); f.host.prepareGroup.mockClear(); f.host.prepareGroup.mockReturnValueOnce(pending.promise)
    const applying = f.call<Promise<void>>('applyWorkshopModelMapping')
    for (let tick = 0; tick < 6; tick++) await Promise.resolve()
    expect(f.host.prepareGroup).toHaveBeenCalledOnce(); change(f); const before = structuredClone(f.current()); pending.resolve(f.prepared['source-a']); await applying
    expect(f.current()).toEqual(before); expect(f.execute).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it('surfaces saved source-list and fresh access failures without losing the document or starting a run', async () => {
    const f = fixture(), before = structuredClone(f.current()); f.readGroupCatalog.mockRejectedValueOnce(Error('synthetic source listing failed')); await f.open()
    expect(f.state.error).toBe('synthetic source listing failed'); expect(f.state.busy).toBe(false); expect(f.current()).toEqual(before)
    await f.review(); f.host.refreshProjectAccess.mockRejectedValueOnce(Error('synthetic permission refresh failed')); await f.call<Promise<void>>('applyWorkshopModelMapping')
    expect(f.state.error).toBe('synthetic permission refresh failed'); expect(f.current()).toEqual(before); expect(f.execute).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it.each(['edit', 'run', 'transition', 'recovery', 'conflict', 'active-run'] as const)('does not even read model catalogs when opening is blocked by %s', async (kind) => {
    const f = fixture()
    if (kind === 'edit') f.projectCanEditRef.current = false
    if (kind === 'run') f.projectCanRunRef.current = false
    if (kind === 'transition') f.projectTransitionRef.current = true
    if (kind === 'recovery') f.draftRecoveryPendingRef.current = true
    if (kind === 'conflict') f.saveConflictRef.current = true
    if (kind === 'active-run') f.activeRunsRef.current.add('run')
    await f.open(); expect(f.readGroupCatalog).not.toHaveBeenCalled(); expect(f.host.prepareGroup).not.toHaveBeenCalled(); expect(f.state.session).toBeNull(); expect(f.state.setupError).toBeTruthy(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
})
