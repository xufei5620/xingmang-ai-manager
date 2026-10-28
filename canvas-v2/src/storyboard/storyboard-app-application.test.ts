import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { storyboardTaskEditSignature, storyboardTaskInitialSourceCurrent, storyboardTaskSourceSignature, toCanvasNode, toWorkflowNode } from '../App'
import type { CanvasGroupSummary, CanvasImageAssetSummary } from '../host'
import type { StoryboardTaskDialogDraft, StoryboardTaskReferenceDraft } from '../components/storyboard-task-ui'
import type { WorkflowEdge } from '../model'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { isTemplateImageAsset } from '../components/template-asset-picker-model'
import { buildCanvasUpstreamReferences } from '../components/upstream-references'
import { canvasNodeDocumentRecord, canvasNodeRuntimePatch } from '../store/use-canvas-document'
import { dirtyCanvasNodeIds, markNodeAndDescendantsDirty } from '../runtime/run-projection'
import { validateTextImageInputConfiguration } from '../runtime/text-image-input'
import { parseNodeImageReferenceOrder, parseImageReferenceOrder } from '../commerce/image-reference-order'
import { createEmptyWorkflow } from '../model'
import { buildStoryboardWorkflow } from './storyboard-workflow'
import { assertStoryboardNodeEditable, buildStoryboardNodeEdit } from './storyboard-edit-application'
import { buildStoryboardAnalysisPrompt, defaultStoryboardTask, parseNodeStoryboardTask, storyboardTaskRoles, storyboardTaskUsesAnalysis, type StoryboardTask } from './storyboard-task'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function actualFunction<T>(name: string, environment: Record<string, unknown> = {}): T {
  const declaration = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  if (!declaration) throw new Error(`Missing actual App function ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`${declaration.getText(source)}\nreturn ${name}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function deferred<T>() { let resolve: (value: T) => void = () => {}; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function asset(id: string): CanvasImageAssetSummary {
  const assetId = id.repeat(43)
  return { assetId, mediaType: 'image', mimeType: 'image/png', localUrl: `xingmang-asset://image/${assetId}`, thumbnailUrl: `xingmang-asset://image/${assetId}`, fileName: `${id}.png`, createdAt: '2026-10-18T00:00:00Z', width: 1200, height: 800 }
}
interface Session { scope: string; task: StoryboardTask; references: StoryboardTaskReferenceDraft[]; imageSource: string; textSource: string; analysis?: { model: string }; nodeId?: string; signature?: string }
function fixture(count = 2) {
  const assets = ['a', 'b', 'c', 'd'].slice(0, count).map(asset)
  const groupsRef = { current: [{ name: 'image-source', description: '图片', ratio: 1, revision: 1 }, { name: 'text-source', description: '文字', ratio: 1, revision: 1 }] as CanvasGroupSummary[] }
  const mediaGroupsRef = { current: { image: 'image-source', text: 'text-source', imageModel: 'gpt-image-1', textModel: 'gpt-4.1' } }
  const mediaModelsRef = { current: { image: ['gpt-image-1'], text: ['gpt-4.1', 'gpt-4.1-mini'] } }, mediaPreparationErrorsRef = { current: {} as { text?: string } }
  const task = defaultStoryboardTask(), references: StoryboardTaskReferenceDraft[] = assets.map((entry, index) => ({ role: index === 0 ? 'source' : 'reference', binding: { kind: 'asset', assetId: entry.assetId }, asset: entry }))
  const session: Session = { scope: 'owner:project:1', task, references, imageSource: storyboardTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.image), textSource: storyboardTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.text), analysis: { model: 'gpt-4.1' } }
  const storyboardSessionRef = { current: session as Session | null }, storyboardOpenRevisionRef = { current: 0 }, graph: { nodes: CanvasNode[]; edges: WorkflowEdge[] } = { nodes: [], edges: [] }
  let currentScope = session.scope, serial = 0
  const execute = vi.fn(), finishTemplateProjectCreation = vi.fn(), settled = vi.fn(), setBanner = vi.fn(), setStoryboardSession = vi.fn(), setAssetCatalog = vi.fn()
  const host = { getAssetDetail: vi.fn<(id: string) => Promise<CanvasImageAssetSummary | null>>().mockImplementation(async (id) => assets.find((entry) => entry.assetId === id) ?? null), refreshProjectAccess: vi.fn<() => Promise<void>>().mockResolvedValue(undefined), getProjectAccess: vi.fn<() => { denied?: boolean; access?: { canEdit: boolean } }>().mockReturnValue({ denied: false, access: { canEdit: true } }), createTemplateProject: vi.fn(), startRun: vi.fn(), generateImage: vi.fn(), generateText: vi.fn() }
  const toWorkflowEdge = actualFunction<(edge: WorkflowEdge) => WorkflowEdge>('toWorkflowEdge')
  const environment: Record<string, unknown> = {
    storyboardSessionRef, storyboardOpenRevisionRef, groupsRef, mediaGroupsRef, mediaModelsRef, mediaPreparationErrorsRef,
    assertCommerceCurrent: (scope: string) => { if (scope !== currentScope) throw new Error('账号、工程或编辑权限已变化') }, currentWorkshopSetupScope: () => currentScope,
    hostBridge: () => host, getGraphSnapshot: () => graph, activeProject: { id: 'project-a', name: '故事板流程' }, assetCatalog: assets, execute, setBanner, setStoryboardSession,
    setAssetCatalog, setNodes: vi.fn(), reactFlow: { fitView: vi.fn().mockResolvedValue(undefined) }, isTemplateImageAsset, buildStoryboardWorkflow, buildStoryboardNodeEdit, assertStoryboardNodeEditable, canvasNodeDocumentRecord, toCanvasNode, toWorkflowNode, toWorkflowEdge,
    storyboardTaskSourceSignature, storyboardTaskInitialSourceCurrent, storyboardTaskEditSignature, storyboardTaskUsesAnalysis, storyboardTaskRoles, parseNodeStoryboardTask, parseNodeImageReferenceOrder, validateTextImageInputConfiguration,
    buildCanvasUpstreamReferences, createEmptyWorkflow, markNodeAndDescendantsDirty, dirtyCanvasNodeIds, graphRef: { current: graph }, setDirtyNodeIds: vi.fn(), snapBoxOfCanvasNode: actualFunction('snapBoxOfCanvasNode', { builtinNodeRegistry }),
    nextNodeId: () => `created-${++serial}`, templateProjectSubmissionRef: { current: { settled, prepare: vi.fn() } }, draftOwnerId: 22, finishTemplateProjectCreation,
    window: { location: { href: 'http://fixture.invalid/canvas?project=project-a', search: '?project=project-a' }, localStorage: {} },
  }
  const draft: StoryboardTaskDialogDraft = { mode: 'create', task: { ...task, style: 'hand-drawn', panels: 25 }, references: references.map(({ role, binding }) => ({ role, binding: { ...binding } })), prompt: '主角从车站走向海边', model: 'gpt-image-1', size: '1536x1024', imageResolution: '1K', quality: 'high', imageCandidateCount: 2, analysis: { model: 'gpt-4.1-mini' } }
  return { assets, session, storyboardSessionRef, storyboardOpenRevisionRef, groupsRef, mediaGroupsRef, mediaModelsRef, mediaPreparationErrorsRef, environment, host, graph, execute, finishTemplateProjectCreation, settled, setBanner, setStoryboardSession, setAssetCatalog, draft,
    changeScope: () => { currentScope = 'other-owner' }, apply: () => actual<(draft: StoryboardTaskDialogDraft) => Promise<void>>('applyStoryboardDraft', environment)(draft),
    open: (nodeId: string) => actual<(nodeId: string, scope: string) => Promise<void>>('openStoryboardEdit', environment)(nodeId, session.scope) }
}
function editFixture(count = 3) {
  const f = fixture(count)
  let serial = 0
  const workflow = buildStoryboardWorkflow({ task: f.session.task, sources: f.assets, prompt: '原始剧情', model: 'gpt-image-1', size: '1536x1024', quality: 'high', imageResolution: '1K', candidateCount: 2, analysis: { model: 'gpt-4.1', group: 'text-source' }, createId: () => `old-${++serial}` })
  f.graph.nodes = workflow.nodes.map(toCanvasNode); f.graph.edges = workflow.edges
  const node = f.graph.nodes.find((entry) => entry.data.settings?.storyboardTask)!, order = parseImageReferenceOrder(node.data.settings?.imageReferenceOrder)
  node.data.status = 'succeeded'; node.data.result = { kind: 'image', assetId: 'z'.repeat(43), localUrl: `xingmang-asset://image/${'z'.repeat(43)}` }; node.data.candidateAssetIds = ['y'.repeat(43), 'z'.repeat(43)]; node.data.adoptedCandidateId = 'old-candidate'
  f.session.nodeId = node.id
  f.session.references = order.slots.map((slot, index) => { if (!('edgeId' in slot)) throw new Error('Missing fixture'); return { role: slot.role, binding: { kind: 'existing', edgeId: slot.edgeId, outputIndex: slot.outputIndex }, asset: f.assets[index] } })
  const upstream = buildCanvasUpstreamReferences(f.graph.nodes, f.graph.edges, f.assets).get(node.id) ?? []
  f.session.signature = storyboardTaskEditSignature(f.graph.nodes.map(toWorkflowNode), f.graph.edges.map(actualFunction<(edge: WorkflowEdge) => WorkflowEdge>('toWorkflowEdge')), node.id, upstream)
  f.draft.mode = 'edit'; f.draft.references = f.session.references.map(({ role, binding }) => ({ role, binding: { ...binding } }))
  return { ...f, node }
}
function orderedAssets(nodes: Array<{ id: string; data: { result?: { assetId?: string }; settings?: Record<string, unknown> } }>, edges: WorkflowEdge[], target: { data: { settings?: Record<string, unknown> } }): unknown[] {
  return parseImageReferenceOrder(target.data.settings?.imageReferenceOrder).slots.map((slot) => { if (!('edgeId' in slot)) throw new Error('Missing bound slot'); const edge = edges.find((entry) => entry.id === slot.edgeId)!; return [slot.role, nodes.find((entry) => entry.id === edge.source)?.data.result?.assetId, slot.outputIndex] })
}

describe('actual App storyboard create and edit callbacks', () => {
  it.each([1, 2, 3, 4])('creates %i ordered images with one visible analysis and one undoable graph command', async (count) => {
    const f = fixture(count)
    f.draft.references.reverse()
    f.draft.references = f.draft.references.map((reference, index) => ({ ...reference, role: index === 0 ? 'source' : 'reference' }))
    await f.apply()
    expect(f.host.getAssetDetail.mock.calls.map(([id]) => id)).toEqual(f.assets.map((entry) => entry.assetId).reverse())
    expect(f.host.refreshProjectAccess).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce()
    const command = f.execute.mock.calls[0][0]
    expect(command.type).toBe('add-nodes'); expect(command.nodes).toHaveLength(count + 3)
    const target = command.nodes.find((node: CanvasNode) => node.data.settings?.storyboardTask), analysis = command.nodes.find((node: { type: string }) => node.type === 'text-generate')
    expect(target.data).toMatchObject({ prompt: f.draft.prompt, imageCandidateCount: 2, settings: { storyboardTask: f.draft.task } })
    expect(analysis.data).toMatchObject({ prompt: buildStoryboardAnalysisPrompt(f.draft.task, f.draft.prompt), model: 'gpt-4.1-mini', group: 'text-source' })
    expect(orderedAssets(command.nodes, command.edges, target)).toEqual([...f.assets].reverse().map((entry, index) => [index === 0 ? 'source' : 'reference', entry.assetId, 0]))
    expect(orderedAssets(command.nodes, command.edges, analysis)).toEqual(orderedAssets(command.nodes, command.edges, target))
    expect(f.storyboardSessionRef.current).toBeNull(); expect(f.settled).toHaveBeenCalledOnce()
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.generateImage).not.toHaveBeenCalled(); expect(f.host.generateText).not.toHaveBeenCalled(); expect(f.host.createTemplateProject).not.toHaveBeenCalled()
  })
  it('rereads each existing occurrence by edge and output index rather than the repeated reference role', async () => {
    const f = editFixture(4)
    f.draft.references = [f.draft.references[3], f.draft.references[1], f.draft.references[0], f.draft.references[2]].map((reference, index) => ({ ...reference, role: index === 0 ? 'source' : 'reference' }))
    const before = structuredClone(f.graph)
    await f.apply()
    expect(f.host.getAssetDetail.mock.calls.map(([id]) => id)).toEqual([f.assets[3].assetId, f.assets[1].assetId, f.assets[0].assetId, f.assets[2].assetId])
    expect(f.execute).toHaveBeenCalledOnce()
    const command = f.execute.mock.calls[0][0], target = command.nodes.find((node: { id: string }) => node.id === f.node.id)
    expect(command.type).toBe('replace-graph')
    expect(target.data).toMatchObject({ dirty: true, result: f.node.data.result, candidateAssetIds: f.node.data.candidateAssetIds })
    expect(canvasNodeRuntimePatch(f.node, target)).toMatchObject({ status: 'succeeded', adoptedCandidateId: 'old-candidate' })
    expect(orderedAssets(command.nodes, command.edges, target).map((entry) => (entry as unknown[])[1])).toEqual([f.assets[3].assetId, f.assets[1].assetId, f.assets[0].assetId, f.assets[2].assetId])
    expect(f.graph).toEqual(before); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it('opens four existing roles using their slot index and retains an explicitly missing analysis model', async () => {
    const f = editFixture(4), analysis = f.graph.nodes.find((entry) => entry.type === 'text-generate')!
    analysis.data.model = ''
    await f.open(f.node.id)
    expect(f.setBanner).not.toHaveBeenCalled()
    const opened = f.storyboardSessionRef.current!
    expect(opened.references.map((reference) => reference.asset?.assetId)).toEqual(f.assets.map((entry) => entry.assetId))
    expect(opened.references.map((reference) => reference.binding)).toEqual(f.session.references.map((reference) => reference.binding))
    expect(opened.analysis?.model).toBe('')
  })
  it.each(['missing', 'wrong-id', 'wrong-media', 'deleted'])('retains draft without graph writes for a %s owned source response', async (cause) => {
    const f = editFixture()
    if (cause === 'missing') f.host.getAssetDetail.mockResolvedValueOnce(null)
    if (cause === 'wrong-id') f.host.getAssetDetail.mockResolvedValueOnce({ ...f.assets[0], assetId: 'x'.repeat(43) })
    if (cause === 'wrong-media') f.host.getAssetDetail.mockResolvedValueOnce({ ...f.assets[0], mediaType: 'video' } as unknown as CanvasImageAssetSummary)
    if (cause === 'deleted') f.host.getAssetDetail.mockResolvedValueOnce({ ...f.assets[0], deletedAt: '2026-10-18T00:00:00Z' })
    await expect(f.apply()).rejects.toThrow('图片已失效')
    expect(f.execute).not.toHaveBeenCalled(); expect(f.storyboardSessionRef.current).toBe(f.session); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it('marks wrong or missing details unavailable when opening rather than attaching them to another role', async () => {
    const f = editFixture(3)
    f.host.getAssetDetail.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...f.assets[1], assetId: 'x'.repeat(43) })
    await f.open(f.node.id)
    const opened = f.storyboardSessionRef.current!
    expect(opened.references.slice(0, 2).every((entry) => !entry.asset && entry.unavailableReason)).toBe(true)
    expect(opened.references[2].asset?.assetId).toBe(f.assets[2].assetId)
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('rejects duplicate actual assets before any graph or project write', async () => {
    const f = fixture(3); f.draft.references[2].binding = { kind: 'asset', assetId: f.assets[0].assetId }
    await expect(f.apply()).rejects.toThrow('不同的实际图片')
    expect(f.execute).not.toHaveBeenCalled(); expect(f.host.createTemplateProject).not.toHaveBeenCalled(); expect(f.storyboardSessionRef.current).toBe(f.session)
  })
  it.each(['scope', 'closed', 'replaced', 'image-source', 'text-source', 'source-revision', 'image-model-list', 'text-model-list', 'text-preparation'])('rejects a late source read after %s changes', async (cause) => {
    const f = editFixture(), read = deferred<CanvasImageAssetSummary | null>(); f.host.getAssetDetail.mockReturnValueOnce(read.promise)
    const pending = f.apply()
    if (cause === 'scope') f.changeScope()
    if (cause === 'closed') f.storyboardSessionRef.current = null
    if (cause === 'replaced') f.storyboardSessionRef.current = { ...f.session }
    if (cause === 'image-source') f.mediaGroupsRef.current.image = 'replacement-image'
    if (cause === 'text-source') f.mediaGroupsRef.current.text = 'replacement-text'
    if (cause === 'source-revision') f.groupsRef.current[0] = { ...f.groupsRef.current[0], revision: 2 }
    if (cause === 'image-model-list') f.mediaModelsRef.current.image = []
    if (cause === 'text-model-list') f.mediaModelsRef.current.text = ['gpt-4.1']
    if (cause === 'text-preparation') f.mediaPreparationErrorsRef.current.text = '来源不可用'
    read.resolve(f.assets[0])
    await expect(pending).rejects.toThrow()
    expect(f.execute).not.toHaveBeenCalled(); expect(f.host.createTemplateProject).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it.each(['image-source', 'text-source', 'source-revision', 'image-model', 'missing-analysis', 'unknown-analysis', 'analysis-error'])('refuses stale %s before reading source assets', async (cause) => {
    const f = fixture()
    if (cause === 'image-source') f.mediaGroupsRef.current.image = 'other-image'
    if (cause === 'text-source') f.mediaGroupsRef.current.text = 'other-text'
    if (cause === 'source-revision') f.groupsRef.current[0] = { ...f.groupsRef.current[0], revision: 2 }
    if (cause === 'image-model') f.draft.model = 'removed-image-model'
    if (cause === 'missing-analysis') delete f.draft.analysis
    if (cause === 'unknown-analysis') { f.draft.analysis = { model: 'unknown-vision' }; f.mediaModelsRef.current.text.push('unknown-vision') }
    if (cause === 'analysis-error') f.mediaPreparationErrorsRef.current.text = '检查失败'
    await expect(f.apply()).rejects.toThrow()
    expect(f.host.getAssetDetail).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  })
  it('accepts a first settled source default but freezes its revision once loading starts', async () => {
    const f = fixture(1); f.session.imageSource = storyboardTaskSourceSignature([]); f.session.textSource = storyboardTaskSourceSignature([])
    await f.apply(); expect(f.execute).toHaveBeenCalledOnce()
    const changed = fixture(1), read = deferred<CanvasImageAssetSummary | null>()
    changed.session.imageSource = storyboardTaskSourceSignature([]); changed.host.getAssetDetail.mockReturnValueOnce(read.promise)
    const pending = changed.apply(); changed.groupsRef.current[0].revision = 3; read.resolve(changed.assets[0])
    await expect(pending).rejects.toThrow('来源已变化'); expect(changed.execute).not.toHaveBeenCalled()
  })
  it.each(['denied', 'revoked', 'scope', 'closed', 'model-list', 'undo'])('rechecks %s after permission refresh before committing', async (cause) => {
    const f = editFixture(1), permission = deferred<void>(); f.host.refreshProjectAccess.mockReturnValueOnce(permission.promise)
    const pending = f.apply(); await Promise.resolve(); expect(f.host.refreshProjectAccess).toHaveBeenCalledOnce()
    if (cause === 'denied') f.host.getProjectAccess.mockReturnValue({ denied: true })
    if (cause === 'revoked') f.host.getProjectAccess.mockReturnValue({ access: { canEdit: false } })
    if (cause === 'scope') f.changeScope()
    if (cause === 'closed') f.storyboardSessionRef.current = null
    if (cause === 'model-list') f.mediaModelsRef.current.image = []
    if (cause === 'undo') f.node.data.prompt = '撤销恢复的另一版剧情'
    permission.resolve()
    await expect(pending).rejects.toThrow()
    expect(f.execute).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
  it.each(['target', 'analysis', 'edge', 'source-result', 'ancestor-lock'])('rejects a frozen %s change while the source is loading', async (cause) => {
    const f = editFixture(1)
    if (cause === 'ancestor-lock') { f.node.parentId = 'parent'; f.graph.nodes.push(toCanvasNode({ id: 'parent', kind: 'group', position: { x: 100, y: 100 }, data: { prompt: '', model: '', status: 'idle' } })); const upstream = buildCanvasUpstreamReferences(f.graph.nodes, f.graph.edges, f.assets).get(f.node.id) ?? []; f.session.signature = storyboardTaskEditSignature(f.graph.nodes.map(toWorkflowNode), f.graph.edges.map(actualFunction<(edge: WorkflowEdge) => WorkflowEdge>('toWorkflowEdge')), f.node.id, upstream) }
    const read = deferred<CanvasImageAssetSummary | null>(); f.host.getAssetDetail.mockReturnValueOnce(read.promise)
    const pending = f.apply()
    if (cause === 'target') f.node.data.prompt = '另一次修改'
    if (cause === 'analysis') f.graph.nodes.find((node) => node.type === 'text-generate')!.data.prompt += '外来分析'
    if (cause === 'edge') f.graph.edges.find((edge) => edge.target === f.node.id && edge.targetHandle === 'in:text')!.sourceHandle = 'out:image'
    if (cause === 'source-result') f.graph.nodes.find((node) => node.type === 'image-input')!.data.result!.assetId = 'x'.repeat(43)
    if (cause === 'ancestor-lock') f.graph.nodes.find((node) => node.id === 'parent')!.draggable = false
    read.resolve(f.assets[0])
    await expect(pending).rejects.toThrow('节点、图片、分析或连接已变化')
    expect(f.execute).not.toHaveBeenCalled(); expect(f.storyboardSessionRef.current).toBe(f.session)
  })
  it('keeps manual creation free of text analysis and ignores irrelevant text catalog changes', async () => {
    const f = fixture(2); f.draft.task.automaticPlot = false; delete f.draft.analysis; f.mediaModelsRef.current.text = []; f.mediaGroupsRef.current.text = 'other-text'; f.mediaPreparationErrorsRef.current.text = '不可用'
    await f.apply()
    expect(f.execute.mock.calls[0][0].nodes.some((node: { type: string }) => node.type === 'text-generate')).toBe(false)
    expect(f.host.generateText).not.toHaveBeenCalled()
  })
})

describe('actual App uncertain storyboard creation recovery', () => {
  it('resumes the exact original journal signature before any source reread or new creation', async () => {
    const f = fixture(), operationId = 'unknown-storyboard-operation', saved = { templateId: 'storyboard-creation', signature: JSON.stringify(f.draft), operationId }
    f.environment.activeProject = null; f.environment.window = { location: { search: `?storyboardTask=storyboard&templateOperation=${operationId}` }, localStorage: {} }
    const readSaved = vi.fn().mockReturnValue(saved); f.environment.readSavedTemplateProjectSubmission = readSaved
    await f.apply()
    expect(readSaved).toHaveBeenCalledExactlyOnceWith({}, 22, operationId)
    expect(f.finishTemplateProjectCreation).toHaveBeenCalledExactlyOnceWith(saved)
    expect(f.host.getAssetDetail).not.toHaveBeenCalled(); expect(f.host.refreshProjectAccess).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.host.createTemplateProject).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.settled).toHaveBeenCalledOnce()
    expect(f.storyboardSessionRef.current).toBeNull()
  })
  it.each(['signature', 'kind', 'missing'])('refuses an uncertain journal with %s mismatch without creating another project', async (cause) => {
    const f = fixture(), saved = { templateId: 'storyboard-creation', signature: JSON.stringify(f.draft), operationId: 'unknown-op' }
    f.environment.activeProject = null; f.environment.window = { location: { search: '?templateOperation=unknown-op' }, localStorage: {} }
    if (cause === 'signature') f.draft.references.reverse()
    if (cause === 'kind') saved.templateId = 'interior-render'
    f.environment.readSavedTemplateProjectSubmission = () => cause === 'missing' ? null : saved
    await expect(f.apply()).rejects.toThrow('不会换图重复创建')
    expect(f.finishTemplateProjectCreation).not.toHaveBeenCalled(); expect(f.host.getAssetDetail).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.host.createTemplateProject).not.toHaveBeenCalled(); expect(f.storyboardSessionRef.current).toBe(f.session)
  })
  it('keeps the original journal and draft when recovery outcome is still unknown', async () => {
    const f = fixture(), saved = { templateId: 'storyboard-creation', signature: JSON.stringify(f.draft), operationId: 'unknown-op' }
    f.environment.activeProject = null; f.environment.window = { location: { search: '?templateOperation=unknown-op' }, localStorage: {} }; f.environment.readSavedTemplateProjectSubmission = () => saved
    f.finishTemplateProjectCreation.mockRejectedValueOnce(new Error('原创建结果仍未知'))
    await expect(f.apply()).rejects.toThrow('原创建结果仍未知')
    expect(f.finishTemplateProjectCreation).toHaveBeenCalledExactlyOnceWith(saved); expect(f.settled).toHaveBeenCalledOnce(); expect(f.storyboardSessionRef.current).toBe(f.session)
    expect(f.host.getAssetDetail).not.toHaveBeenCalled(); expect(f.host.createTemplateProject).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  })
})
