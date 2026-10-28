import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { toCanvasNode, toWorkflowNode } from '../App'
import type { CanvasImageAssetSummary } from '../host'
import type { InteriorTaskDialogDraft, InteriorTaskSourceDraft } from '../components/interior-task-ui'
import { isTemplateImageAsset } from '../components/template-asset-picker-model'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { buildInteriorWorkflow } from './interior-workflow'
import { defaultInteriorTask } from './interior-task'
import { buildInteriorNodeEdit } from './interior-edit-application'
import { buildCanvasUpstreamReferences } from '../components/upstream-references'
import { dirtyCanvasNodeIds, markNodeAndDescendantsDirty } from '../runtime/run-projection'
import { createEmptyWorkflow, type WorkflowEdge } from '../model'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actualApply(environment: Record<string, unknown>): (draft: InteriorTaskDialogDraft) => Promise<void> {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'applyInteriorDraft' && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error('Missing actual App interior callback')
  const code = ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(environment), code)(...Object.values(environment))
}
function deferred<T>() { let resolve: (value: T) => void = () => {}; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function actualWorkflowEdge(): (edge: WorkflowEdge) => WorkflowEdge {
  const declaration = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'toWorkflowEdge')
  if (!declaration) throw new Error('Missing actual App edge projection')
  return new Function(ts.transpileModule(`${declaration.getText(source)}\nreturn toWorkflowEdge`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)() as (edge: WorkflowEdge) => WorkflowEdge
}
function fixture() {
  const assetId = 'a'.repeat(43)
  // The web asset list returns protocol addresses (lib/asset-details.ts); an older web address is accepted only when a host recognises it.
  const asset: CanvasImageAssetSummary = { assetId, mediaType: 'image', mimeType: 'image/png', localUrl: `xingmang-asset://image/${assetId}`, thumbnailUrl: `xingmang-asset://image/${assetId}`, fileName: 'room.png', createdAt: '2026-10-16T00:00:00Z', width: 1200, height: 800 }
  const session = { scope: 'owner:project:1', task: defaultInteriorTask(), source: { binding: { kind: 'asset' as const, assetId }, asset } as InteriorTaskSourceDraft, group: 'original-source', models: ['gpt-image-1'] }
  const interiorSessionRef = { current: session as typeof session | null }, mediaGroupsRef = { current: { image: 'original-source', imageModel: 'gpt-image-1' } }
  let currentScope = session.scope, serial = 0
  const execute = vi.fn(), finishTemplateProjectCreation = vi.fn(), settled = vi.fn(), setBanner = vi.fn(), setInteriorSession = vi.fn()
  const host = { getAssetDetail: vi.fn<(...args: unknown[]) => Promise<CanvasImageAssetSummary | null>>().mockResolvedValue(asset), refreshProjectAccess: vi.fn().mockResolvedValue(undefined), getProjectAccess: vi.fn<() => unknown>().mockReturnValue({ denied: false, access: { canEdit: true } }), startRun: vi.fn(), generateImage: vi.fn() }
  const environment: Record<string, unknown> = {
    interiorSessionRef, mediaGroupsRef, assertCommerceCurrent: (scope: string) => { if (scope !== currentScope) throw new Error('账号或工程已变化') },
    hostBridge: () => host, getGraphSnapshot: () => ({ nodes: [], edges: [] }), activeProject: { id: 'project-a', name: '室内流程' }, assetCatalog: [], execute, setBanner, setInteriorSession,
    setAssetCatalog: vi.fn(), setNodes: vi.fn(), reactFlow: { fitView: vi.fn().mockResolvedValue(undefined) }, isTemplateImageAsset, buildInteriorWorkflow, canvasNodeDocumentRecord, toCanvasNode, toWorkflowNode,
    nextNodeId: () => `created-${++serial}`, templateProjectSubmissionRef: { current: { settled } }, draftOwnerId: 22, finishTemplateProjectCreation,
    window: { location: { href: 'http://fixture.invalid/canvas?project=project-a', search: '?project=project-a' }, localStorage: {} },
  }
  const draft: InteriorTaskDialogDraft = { mode: 'create', task: { ...defaultInteriorTask(), addDecor: true, exterior: 'garden' }, source: { binding: { kind: 'asset', assetId } }, prompt: '保留木色柜体', model: 'gpt-image-1', size: '1536x1024', imageResolution: '1K', quality: 'high', imageCandidateCount: 2 }
  return { asset, session, interiorSessionRef, mediaGroupsRef, environment, host, execute, finishTemplateProjectCreation, settled, setBanner, setInteriorSession, draft, changeScope: () => { currentScope = 'other-owner' }, apply: () => actualApply(environment)(draft) }
}
function editFixture() {
  const f = fixture()
  let serial = 0
  const workflow = buildInteriorWorkflow({ task: defaultInteriorTask(), source: { assetId: f.asset.assetId, width: 1200, height: 800 }, prompt: '原补充', model: 'gpt-image-1', candidateCount: 2, createId: () => `edit-${++serial}` })
  workflow.nodes[1].data.status = 'succeeded'
  workflow.nodes[1].data.result = { kind: 'image', assetId: 'c'.repeat(43), localUrl: `xingmang-asset://image/${'c'.repeat(43)}` }
  workflow.nodes[1].data.candidateAssetIds = ['c'.repeat(43), 'd'.repeat(43)]
  const graph = { nodes: workflow.nodes.map(toCanvasNode), edges: workflow.edges }
  const edge = workflow.edges[0], node = graph.nodes[1]
  const toWorkflowEdge = actualWorkflowEdge()
  const upstream = buildCanvasUpstreamReferences(graph.nodes, graph.edges, []).get(node.id) ?? []
  Object.assign(f.session, { nodeId: node.id, source: { binding: { kind: 'existing', edgeId: edge.id, outputIndex: 0 }, asset: f.asset }, signature: JSON.stringify([toWorkflowNode(node), graph.edges.filter((entry) => entry.target === node.id).map(toWorkflowEdge), upstream]) })
  f.draft.mode = 'edit'; f.draft.source.binding = { kind: 'existing', edgeId: edge.id, outputIndex: 0 }
  Object.assign(f.environment, { getGraphSnapshot: () => graph, buildCanvasUpstreamReferences, toWorkflowEdge, buildInteriorNodeEdit, createEmptyWorkflow, markNodeAndDescendantsDirty, dirtyCanvasNodeIds, graphRef: { current: graph }, setDirtyNodeIds: vi.fn() })
  return { ...f, graph, node }
}

describe('actual App interior task application', () => {
  it('creates one editable graph after fresh source and permission checks without running a model', async () => {
    const f = fixture(); await f.apply()
    expect(f.host.getAssetDetail).toHaveBeenCalledExactlyOnceWith(f.asset.assetId)
    expect(f.host.refreshProjectAccess).toHaveBeenCalledOnce()
    expect(f.execute).toHaveBeenCalledOnce()
    const command = f.execute.mock.calls[0][0]
    expect(command).toMatchObject({ type: 'add-nodes' }); expect(command.nodes).toHaveLength(3); expect(command.edges).toHaveLength(2)
    expect(command.nodes.find((node: { data: { settings?: Record<string, unknown> } }) => node.data.settings?.interiorTask).data).toMatchObject({ prompt: f.draft.prompt, imageCandidateCount: 2, settings: { interiorTask: f.draft.task } })
    expect(f.interiorSessionRef.current).toBeNull(); expect(f.host.generateImage).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
  })

  it('ignores a late source read after the account or project changes', async () => {
    const f = fixture(), read = deferred<CanvasImageAssetSummary | null>(); f.host.getAssetDetail.mockReturnValueOnce(read.promise)
    const request = f.apply(); f.changeScope(); read.resolve(f.asset)
    await expect(request).rejects.toThrow(/变化/)
    expect(f.execute).not.toHaveBeenCalled(); expect(f.interiorSessionRef.current).toBe(f.session)
  })

  it('ignores a late source read after the dialog is closed or replaced', async () => {
    const f = fixture(), read = deferred<CanvasImageAssetSummary | null>(); f.host.getAssetDetail.mockReturnValueOnce(read.promise)
    const request = f.apply(); f.interiorSessionRef.current = null; read.resolve(f.asset)
    await expect(request).rejects.toThrow(/关闭/); expect(f.execute).not.toHaveBeenCalled()
  })

  it.each(['recycled source', 'wrong returned source', 'edit permission revoked'] as const)('retains the draft and avoids all graph writes on %s', async (cause) => {
    const f = fixture()
    if (cause === 'recycled source') f.host.getAssetDetail.mockResolvedValueOnce(null)
    if (cause === 'wrong returned source') f.host.getAssetDetail.mockResolvedValueOnce({ ...f.asset, assetId: 'b'.repeat(43) })
    if (cause === 'edit permission revoked') f.host.getProjectAccess.mockReturnValueOnce({ access: { canEdit: false } })
    await expect(f.apply()).rejects.toThrow()
    expect(f.execute).not.toHaveBeenCalled(); expect(f.interiorSessionRef.current).toBe(f.session); expect(f.host.generateImage).not.toHaveBeenCalled()
  })

  it('prevents changing provider while an existing creation draft is open', async () => {
    const f = fixture(); f.mediaGroupsRef.current.image = 'new-source'
    await expect(f.apply()).rejects.toThrow(/来源已切换/)
    expect(f.host.getAssetDetail).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  })

  it.each([['', 'new-source'], ['original-source', '']] as const)('requires a new review when provider changes from %j to %j', async (before, after) => {
    const f = fixture(); f.session.group = before; f.mediaGroupsRef.current.image = after
    await expect(f.apply()).rejects.toThrow('来源已切换')
    expect(f.host.getAssetDetail).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.interiorSessionRef.current).toBe(f.session)
  })

  it('rejects a provider change that occurs while fresh source details are loading', async () => {
    const f = editFixture(), read = deferred<CanvasImageAssetSummary | null>(); f.host.getAssetDetail.mockReturnValueOnce(read.promise)
    const pending = f.apply(); f.mediaGroupsRef.current.image = 'replacement-source'; read.resolve(f.asset)
    await expect(pending).rejects.toThrow('来源已切换')
    expect(f.execute).not.toHaveBeenCalled(); expect(f.interiorSessionRef.current).toBe(f.session)
  })

  it('rechecks scope after asynchronous permission refresh before writing any graph', async () => {
    const f = fixture(), permission = deferred<void>(); f.host.refreshProjectAccess.mockReturnValueOnce(permission.promise)
    const pending = f.apply(); await Promise.resolve(); f.changeScope(); permission.resolve()
    await expect(pending).rejects.toThrow('变化')
    expect(f.execute).not.toHaveBeenCalled(); expect(f.interiorSessionRef.current).toBe(f.session)
  })

  it('rereads the existing owned source and commits one undoable dirty edit while retaining its previous candidates', async () => {
    const f = editFixture(), original = structuredClone(f.graph.nodes.map(toWorkflowNode))
    await f.apply()
    expect(f.host.getAssetDetail).toHaveBeenCalledExactlyOnceWith(f.asset.assetId)
    expect(f.execute).toHaveBeenCalledOnce()
    const command = f.execute.mock.calls[0][0]
    expect(command.type).toBe('replace-graph')
    const target = command.nodes.find((node: { id: string }) => node.id === f.node.id)
    expect(target.data).toMatchObject({ dirty: true, result: original[1].data.result, candidateAssetIds: original[1].data.candidateAssetIds, prompt: f.draft.prompt, imageCandidateCount: 2 })
    expect(command.nodes[0].data.dirty).not.toBe(true); expect(command.nodes[2].data.dirty).toBe(true)
    expect(f.graph.nodes.map(toWorkflowNode)).toEqual(original)
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.generateImage).not.toHaveBeenCalled()
  })

  it('preserves an existing edit draft when the source is recycled or its frozen graph changes during the read', async () => {
    const missing = editFixture(); missing.host.getAssetDetail.mockResolvedValueOnce(null)
    await expect(missing.apply()).rejects.toThrow('图片已失效'); expect(missing.execute).not.toHaveBeenCalled()
    const changed = editFixture(), read = deferred<CanvasImageAssetSummary | null>(); changed.host.getAssetDetail.mockReturnValueOnce(read.promise)
    const pending = changed.apply(); changed.node.data.prompt = '另一次编辑'; read.resolve(changed.asset)
    await expect(pending).rejects.toThrow('节点、图片或连接已变化')
    expect(changed.execute).not.toHaveBeenCalled(); expect(changed.interiorSessionRef.current).toBe(changed.session)
  })

  it('resumes an uncertain original project creation without rebuilding or generating', async () => {
    const f = fixture(), saved = { templateId: 'interior-render', signature: JSON.stringify(f.draft), operationId: 'original-operation' }
    f.environment.activeProject = null
    f.environment.window = { location: { search: '?interiorTask=render&templateOperation=original-operation' }, localStorage: {} }
    const readSaved = vi.fn().mockReturnValue(saved); f.environment.readSavedTemplateProjectSubmission = readSaved
    await f.apply()
    expect(readSaved).toHaveBeenCalledWith({}, 22, 'original-operation')
    expect(f.finishTemplateProjectCreation).toHaveBeenCalledExactlyOnceWith(saved)
    expect(f.host.getAssetDetail).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.host.generateImage).not.toHaveBeenCalled(); expect(f.settled).toHaveBeenCalledOnce()
  })

  it('does not duplicate an uncertain project with altered source or parameters', async () => {
    const f = fixture(); f.environment.activeProject = null
    f.environment.window = { location: { search: '?templateOperation=original-operation' }, localStorage: {} }
    f.environment.readSavedTemplateProjectSubmission = () => ({ templateId: 'interior-render', signature: 'different-draft' })
    await expect(f.apply()).rejects.toThrow(/不会换图重复创建/)
    expect(f.finishTemplateProjectCreation).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.host.getAssetDetail).not.toHaveBeenCalled()
  })

  it('retains the original uncertain creation journal and dialog when recovery itself has an unknown outcome', async () => {
    const f = fixture(), saved = { templateId: 'interior-render', signature: JSON.stringify(f.draft), operationId: 'original-operation' }
    f.environment.activeProject = null
    f.environment.window = { location: { search: '?interiorTask=render&templateOperation=original-operation' }, localStorage: {} }
    f.environment.readSavedTemplateProjectSubmission = () => saved
    f.finishTemplateProjectCreation.mockRejectedValueOnce(new Error('原操作仍未确认'))
    await expect(f.apply()).rejects.toThrow('原操作仍未确认')
    expect(f.finishTemplateProjectCreation).toHaveBeenCalledExactlyOnceWith(saved)
    expect(f.interiorSessionRef.current).toBe(f.session); expect(f.settled).toHaveBeenCalledOnce()
    expect(f.host.getAssetDetail).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.host.startRun).not.toHaveBeenCalled()
  })
})
