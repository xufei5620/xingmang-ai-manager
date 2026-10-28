import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { editorNodeToCanvasNode, toCanvasNode, toCanvasRunGraph, toWorkflowNode, workflowNodeData } from '../App'
import type { WorkflowNode } from '../model'
import { createEmptyWorkflow } from '../model'
import { parseWorkflowFile, serializeWorkflow } from '../persistence/workflow-serializer'
import { buildCanvasRunPreflight, sameCanvasRunGraphSnapshot } from './run-preflight'
import { cachedNodeIdsForPreflight } from './pinned-reuse'
import { inspectSelectedNodeRun } from '../components/node-run-actions'
import { canvasNodeMediaKind, prepareCanvasNodeSources, type CanvasNodeSourceCatalog } from '../library/node-model-availability'
import { pendingCanvasMediaRunKinds } from '../library/media-progress-scope'
import { buildWorkshopSelection, instantiateWorkshopGraph } from '../editor/workshop-graph'
import { createHostExecutors } from '../engine/executors'
import type { CanvasHostBridge } from '../host'
import { fullCanvasCapabilityProfile } from '../host-capabilities.test-fixture'
import { canvasRunInputForHost } from './host-run-compatibility'

const defaults = { image: 'project-image', video: 'project-ark', text: 'project-text', imageModel: 'gpt-image-2', videoModel: 'doubao-seedance-1-0-pro-250528', textModel: 'gpt-4.1', videoProtocol: 'ark-seedance' as const }
const catalog: CanvasNodeSourceCatalog = { fixed: { state: 'ready', models: ['gpt-image-1', 'grok-imagine-video'], purposes: ['image', 'video'], videoProtocol: 'relay-videos' } }
const unavailableCatalogs: CanvasNodeSourceCatalog[] = [{}, { fixed: { state: 'pending', models: [] } }, { fixed: { state: 'error', models: [], error: '本人来源已删除' } }, { fixed: { state: 'ready', models: ['grok-imagine-video'], purposes: ['image'] } }]
function workflowNode(kind: 'image-generate' | 'video-generate' = 'video-generate', group: string | undefined = 'fixed'): WorkflowNode {
  return { id: 'generation', kind, definitionVersion: 1, position: { x: 10, y: 20 }, data: { prompt: '自有测试', model: kind === 'video-generate' ? 'grok-imagine-video' : 'gpt-image-1', status: 'idle', size: '1280x720', seconds: '6', ...(group === undefined ? {} : { group }) } }
}
function preflight(sourceCatalog: CanvasNodeSourceCatalog = catalog, node = workflowNode()) {
  const graph = toCanvasRunGraph([toCanvasNode(node)], [], defaults, sourceCatalog)
  return { graph, result: buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, sourceCatalog, imageGroup: defaults.image, videoGroup: defaults.video, textGroup: defaults.text, videoProtocol: defaults.videoProtocol, imageModels: ['gpt-image-2'], videoModels: [defaults.videoModel], textModels: ['gpt-4.1'] }) }
}
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(source)
    if (name === 'fixedSourceEffect' && ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('prepareCanvasNodeSources({')) expression = node.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source); if (!expression) throw new Error(`Missing callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}

describe('actual fixed media source projections and preflight', () => {
  it.each(['image-generate', 'video-generate'] as const)('preserves fixed group in %s save and reload rather than selecting the project source', (kind) => {
    const original = workflowNode(kind), document = { ...createEmptyWorkflow('固定来源'), nodes: [toWorkflowNode(toCanvasNode(original))] }
    const restored = parseWorkflowFile(serializeWorkflow(document))!
    expect(restored.nodes[0].data.group).toBe('fixed'); expect(restored.nodes[0].data.model).toBe(original.data.model)
    const graph = toCanvasRunGraph(restored.nodes.map(toCanvasNode), [], defaults, catalog)
    expect(graph.nodes[0].data.group).toBe('fixed'); expect(graph.nodes[0].data.model).toBe(original.data.model)
    expect(document.mediaGroups).toBeUndefined()
    const edited = editorNodeToCanvasNode({ id: original.id, type: kind, definitionVersion: 1, position: original.position, data: { ...original.data } })
    expect(toWorkflowNode(edited).data.group).toBe('fixed')
    expect(workflowNodeData(kind, { model: original.data.model, group: 'fixed' }).group).toBe('fixed')
    expect(workflowNodeData(kind, { group: 'fixed' }).settings ?? {}).not.toHaveProperty('group')
  })
  it('uses the fixed relay protocol with a global Ark video source and distinct saved catalog', () => {
    const { graph, result } = preflight()
    expect(graph.nodes[0].data.videoProtocol).toBe('relay-videos'); expect(result.canStart).toBe(true); expect(result.videoRequestCount).toBe(1); expect(result.groups).toEqual(['fixed'])
    expect(pendingCanvasMediaRunKinds(result, ['video'], defaults)).toEqual([])
  })
  it.each(unavailableCatalogs)('blocks missing, pending, failed and wrong-purpose fixed sources even if the model is present globally: %j', (current) => {
    const { graph, result } = preflight(current)
    expect(graph.nodes[0].data.group).toBe('fixed'); expect(graph.nodes[0].data.videoProtocol).not.toBe('ark-seedance'); expect(result.canStart).toBe(false); expect(result.videoRequestCount).toBe(0); expect(result.items[0].reasonCode).toBe('unavailable-source')
  })
  it('keeps a withdrawn fixed-source model unavailable instead of using the default or another saved provider', () => {
    const { result } = preflight({ fixed: { ...catalog.fixed, models: ['different-video'] }, other: { ...catalog.fixed } })
    expect(result.canStart).toBe(false); expect(result.items[0].reasonCode).toBe('unavailable-model')
  })
  it('does not fill an explicitly pinned empty model from global defaults', () => {
    const node = workflowNode(); node.data.model = ''
    const { graph, result } = preflight(catalog, node); expect(graph.nodes[0].data.model).toBe(''); expect(result.canStart).toBe(false)
  })
  it('retains original global inheritance when there is no pin and does not rewrite the document', () => {
    const node = workflowNode('video-generate', undefined); delete node.data.group; node.data.model = ''
    const graph = toCanvasRunGraph([toCanvasNode(node)], [], defaults, catalog)
    expect(graph.nodes[0].data.group).toBe(defaults.video); expect(graph.nodes[0].data.model).toBe(defaults.videoModel); expect(graph.nodes[0].data.videoProtocol).toBe('ark-seedance')
    expect(toWorkflowNode(toCanvasNode(node)).data).not.toHaveProperty('group')
  })
  it('retains the pin through workshop selection and insertion, then blocks a foreign-owner source until explicitly reassigned', () => {
    const original = { ...createEmptyWorkflow('原工程'), nodes: [workflowNode()] }
    const selection = buildWorkshopSelection(original, ['generation']), portable = parseWorkflowFile(serializeWorkflow(selection))!
    const inserted = instantiateWorkshopGraph(portable, () => 'inserted-source')
    const loaded = inserted.nodes.map((node) => editorNodeToCanvasNode({ id: node.id, type: node.kind, definitionVersion: 1, position: node.position, data: { ...node.data } }))
    expect(loaded[0].data.group).toBe('fixed'); expect(toWorkflowNode(loaded[0]).data.group).toBe('fixed')
    const graph = toCanvasRunGraph(loaded, [], defaults, {})
    const result = buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, sourceCatalog: {}, imageGroup: defaults.image, videoGroup: defaults.video, imageModels: [], videoModels: ['grok-imagine-video'] })
    expect(result.canStart).toBe(false); expect(result.items[0].reasonCode).toBe('unavailable-source')
  })
  it('keeps selection toolbar availability aligned with the fixed source instead of project models', () => {
    const node = toCanvasNode(workflowNode())
    expect(inspectSelectedNodeRun(node, { connected: true, imageModels: [], videoModels: [], textModels: [], sourceCatalog: catalog })).toEqual({})
    expect(inspectSelectedNodeRun(node, { connected: true, imageModels: [], videoModels: ['grok-imagine-video'], textModels: [], sourceCatalog: {} })?.disabledReason).toContain('固定来源')
  })
  it('submits exactly the source-specific graph through the actual App confirmation callback', async () => {
    const nodes = [toCanvasNode(workflowNode())], graph = toCanvasRunGraph(nodes, [], defaults, catalog), startRun = vi.fn(async () => ({ runId: 'run', graphRevision: 'revision' })), save = vi.fn(async () => undefined)
    const env = { projectCanRunRef: { current: true }, pendingCanvasRun: { graph, scope: { kind: 'all' } }, projectTransitionRef: { current: false }, startingRunsRef: { current: 0 }, nodes, edges: [], imageGroup: defaults.image, videoGroup: defaults.video, textGroup: defaults.text, videoProtocol: defaults.videoProtocol, mediaGroups: defaults, imageAssetDimensions: {}, nodeSourceCatalogRef: { current: catalog }, mediaModelsRef: { current: { image: ['gpt-image-2'], video: [defaults.videoModel], text: ['gpt-4.1'] } }, toCanvasRunGraph, buildCanvasRunPreflight, canvasCapabilities: () => fullCanvasCapabilityProfile, canvasRunInputForHost, cachedNodeIdsForPreflight, sameCanvasRunGraphSnapshot, dramaPreflightBlockReasons: () => ({}), rejectPendingMedia: () => false, rejectUnavailableGroups: () => false, setPendingCanvasRun: vi.fn(), setRunPreflight: vi.fn(), setBanner: vi.fn(), setStartingRuns: vi.fn(), saveBeforeRunRef: { current: save }, hostBridge: () => ({ startRun }), rememberActiveRun: vi.fn(), activeProjectIdRef: { current: 'project' }, openInspectorTab: vi.fn(), activeRunsRef: { current: new Map() }, refreshRuns: vi.fn(), outputPlacementCoordinator: { cancel: vi.fn() } }
    const inspectPendingAgentExecution = actual<(pending: typeof env.pendingCanvasRun) => unknown>('inspectPendingAgentExecution', env)
    await actual<() => Promise<void>>('confirmCanvasRun', { ...env, inspectPendingAgentExecution })()
    expect(save).toHaveBeenCalledExactlyOnceWith(graph); expect(startRun).toHaveBeenCalledExactlyOnceWith({ graph, scope: { kind: 'all' } })
    env.nodeSourceCatalogRef.current = {}; await actual<() => Promise<void>>('confirmCanvasRun', { ...env, inspectPendingAgentExecution })(); expect(startRun).toHaveBeenCalledTimes(1)
  })
  it('changes or clears a pin only through the actual guarded source handler while retaining model and results', () => {
    const node = toCanvasNode(workflowNode()), markDirtyFrom = vi.fn(), setBanner = vi.fn()
    const env = { draftActionsEnabledRef: { current: true }, projectCanEditRef: { current: true }, projectTransitionRef: { current: false }, activeRunsRef: { current: new Set() }, startingRunsRef: { current: 0 }, pendingRunProjectionIdsRef: { current: new Set() }, getGraphSnapshot: () => ({ nodes: [node], edges: [] }), canvasNodeMediaKind, groupsRef: { current: [{ name: 'owned', purposes: ['video'], connectionStatus: 'ready' }, { name: 'text-only', purposes: ['text'], connectionStatus: 'ready' }] }, markDirtyFrom, setBanner }
    const change = actual<(id: string, group: string | undefined) => void>('changeNodeModelSource', env)
    change(node.id, 'owned'); expect(markDirtyFrom).toHaveBeenLastCalledWith(node.id, { group: 'owned' }, true)
    change(node.id, undefined); expect(markDirtyFrom).toHaveBeenLastCalledWith(node.id, { group: undefined }, true)
    change(node.id, 'foreign'); change(node.id, 'text-only'); expect(markDirtyFrom).toHaveBeenCalledTimes(2); expect(node.data.model).toBe('grok-imagine-video'); expect(node.data.group).toBe('fixed')
    env.projectCanEditRef.current = false; change(node.id, 'owned'); expect(markDirtyFrom).toHaveBeenCalledTimes(2)
  })
  it('keeps fixed image, edit and video routes in the lightweight executor and refuses an empty pin', async () => {
    const asset = { assetId: 'a'.repeat(43), localUrl: '/local.png', mimeType: 'image/png' as const, fileName: 'owned.png' }
    const host = { generateImage: vi.fn(async (_input: Parameters<CanvasHostBridge['generateImage']>[0]) => [asset]), editImage: vi.fn(async (_input: Parameters<CanvasHostBridge['editImage']>[0]) => [asset]), generateVideo: vi.fn(async (_input: Parameters<CanvasHostBridge['generateVideo']>[0]) => ({ assetId: 'v'.repeat(43), localUrl: '/local.mp4', mimeType: 'video/mp4' as const, fileName: 'owned.mp4', taskId: 'task' })), cancelRequest: vi.fn(async () => ({ canceled: true, mayStillComplete: false })) }
    const executors = createHostExecutors({ host, imageGroup: 'default-image', videoGroup: 'default-video' }), signal = new AbortController().signal
    const image = workflowNode('image-generate'); image.data.size = '1024x1024'
    await executors['image-generate'](image, {}, signal)
    await executors['image-edit']({ ...image, kind: 'image-edit' }, { image: { kind: 'image', assetId: 'b'.repeat(43) } }, signal)
    await executors['video-generate'](workflowNode(), {}, signal)
    expect(host.generateImage.mock.calls[0][0]).toMatchObject({ group: 'fixed', model: 'gpt-image-1' })
    expect(host.editImage.mock.calls[0][0]).toMatchObject({ group: 'fixed', model: 'gpt-image-1' })
    expect(host.generateVideo.mock.calls[0][0]).toMatchObject({ group: 'fixed', model: 'grok-imagine-video' })
    image.data.group = ''; await expect(executors['image-generate'](image, {}, signal)).rejects.toThrow('选择生图分组'); expect(host.generateImage).toHaveBeenCalledOnce()
  })
  it.each(['project', 'source-aba', 'access', 'close'] as const)('rejects the actual catalog effect late response after %s changes', async (change) => {
    let finish!: (value: { group: string; models: string[]; revision: number; keyCreated: boolean }) => void
    const pending = new Promise<{ group: string; models: string[]; revision: number; keyCreated: boolean }>((resolve) => { finish = resolve }), prepareGroup = vi.fn(() => pending), setNodeSourceSnapshot = vi.fn()
    const env = { groupsLoaded: true, draftActionsEnabled: true, projectCanRun: true, window: { xingmangCanvasHost: {} }, fixedNodeSourceNames: ['fixed'], groups: [{ name: 'fixed', description: '本人来源', ratio: 1, revision: 2, connectionStatus: 'ready' }], prepareCanvasNodeSources, hostBridge: () => ({ prepareGroup }), nodeSourceScopeRef: { current: { revision: 0 } }, projectEpochRef: { current: 1 }, activeProjectIdRef: { current: 'project' }, draftActionsEnabledRef: { current: true }, nodeSourceCatalogRef: { current: {} as CanvasNodeSourceCatalog }, nodeSourceKey: 'scope-fixed-v2', setNodeSourceSnapshot }
    const cleanup = actual<() => (() => void)>('fixedSourceEffect', env)(); expect(prepareGroup).toHaveBeenCalledOnce(); expect(setNodeSourceSnapshot).toHaveBeenCalledOnce()
    if (change === 'project') env.projectEpochRef.current++
    if (change === 'source-aba') env.nodeSourceScopeRef.current.revision += 2
    if (change === 'access') env.draftActionsEnabledRef.current = false
    if (change === 'close') cleanup()
    finish({ group: 'fixed', models: ['gpt-image-1'], revision: 2, keyCreated: false })
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(setNodeSourceSnapshot).toHaveBeenCalledOnce(); expect(env.nodeSourceCatalogRef.current.fixed.state).toBe('pending')
    cleanup()
  })
})
