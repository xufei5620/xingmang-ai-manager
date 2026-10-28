import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { editorNodeToCanvasNode, toCanvasNode, toCanvasRunGraph, toWorkflowNode } from '../App'
import type { CanvasAssetSummary, CanvasImageAssetSummary } from '../host'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { createCanvasDocument } from '../store/canvas-state'
import type { CanvasCommand } from '../store/canvas-command'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { canvasNodeDocumentRecord, canvasNodeRuntimePatch } from '../store/use-canvas-document'
import { dirtyCanvasNodeIds } from '../runtime/run-projection'
import { buildCanvasRunPreflight } from '../runtime/run-preflight'
import { cachedNodeIdsForPreflight } from '../runtime/pinned-reuse'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow } from '../model'
import { assertLayerEditorScope, layerEditorScopeToken } from './layer-editor-scope'
import { parseImageEditMask, type ImageEditMask } from './image-edit-mask'
import { encodeImageMaskPng } from './image-mask-png'
import { resolveImageMaskSource } from './image-mask-workflow'
import { assertMaskAssetPng, assertMaskAssetSource, buildLinkedMaskAssetNode, buildMaskAssetNode, parseMaskAssetUpload, replaceMaskAssetNode, type ImageMaskAssetPng, type MaskAssetSaveMode } from './mask-asset-export'

const appSource = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(appSource) === name && node.initializer) expression = node.initializer.getText(appSource)
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(appSource).replace(/^export\s+/, '')
    ts.forEachChild(node, visit)
  }
  visit(appSource)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}

const first = 'a'.repeat(43), selected = 'b'.repeat(43), exported = 'c'.repeat(43)
function asset(id = exported): CanvasImageAssetSummary {
  return { assetId: id, mediaType: 'image', localUrl: `xingmang-asset://image/${id}`, thumbnailUrl: `xingmang-asset://image/${id}`, mimeType: 'image/png', fileName: 'mask.png', createdAt: '2026-10-18T00:00:00.000Z', width: 64, height: 48 }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
type Save = (mask: ImageEditMask, png: ImageMaskAssetPng, signal: AbortSignal, mode?: MaskAssetSaveMode) => Promise<void>

async function fixture(from: 'input' | 'output' = 'output') {
  const source = toCanvasNode({ id: 'source', kind: 'image-generate', definitionVersion: 1, position: { x: 100, y: 100 }, data: { prompt: 'Original input', model: 'gpt-image-1', status: 'succeeded', candidateAssetIds: [first, selected], result: { kind: 'image', assetId: selected, localUrl: `xingmang-asset://image/${selected}`, width: 64, height: 48 } } })
  const edit = toCanvasNode({ id: 'edit', kind: 'image-edit', definitionVersion: 1, position: { x: 600, y: 100 }, data: { prompt: 'Pending AI edit', model: 'gpt-image-1', status: 'idle', settings: { title: '保留修改草稿' } } })
  const initial = from === 'input' ? [source, edit] : [source]
  const edges = from === 'input' ? [{ id: 'original-edge', source: source.id, sourceHandle: 'out:image', target: edit.id, targetHandle: 'in:images' }] : []
  let history = createCanvasHistory({ ...createCanvasDocument(), nodes: initial.map(canvasNodeDocumentRecord), edges }), current = initial
  const getGraphSnapshot = () => ({ nodes: current, edges: history.present.edges })
  const execute = vi.fn((command: CanvasCommand) => {
    const previous = new Map(current.map((node) => [node.id, node]))
    history = applyCanvasCommand(history, command)
    current = history.present.nodes.map((record) => {
      const node = editorNodeToCanvasNode(record), before = previous.get(node.id)
      return before ? { ...node, selected: before.selected, data: { ...node.data, ...canvasNodeRuntimePatch(before, record) } } : node
    })
  })
  const setNodes = (update: (nodes: CanvasNode[]) => CanvasNode[]) => { current = update(current) }
  const layerEditorOwnerRef = { current: { ownerId: 7, accountId: 'owner-a' } }, activeProjectIdRef = { current: 'project-a' }, projectEpochRef = { current: 1 }
  const draftActionsEnabledRef = { current: true }, projectTransitionRef = { current: false }, activeRunsRef = { current: new Set<string>() }, startingRunsRef = { current: false }, pendingRunProjectionIdsRef = { current: new Set<string>() }
  const projectCanEditRef = { current: true }, mediaPreparationMountedRef = { current: true }
  const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: true })
  const session = { nodeId: from === 'input' ? edit.id : source.id, from, source: resolveImageMaskSource(current, edges, from === 'input' ? edit.id : source.id, from), scope }
  const imageMaskSessionRef = { current: session as typeof session | null }, imageMaskExportSavingRef = { current: false }
  const imageMaskExportReceiptsRef = { current: new Map<string, { status: 'unknown' } | { status: 'saved'; asset: CanvasImageAssetSummary }>() }
  const host = { importAssetFile: vi.fn<(file: File, options: { mediaType: string }) => Promise<CanvasAssetSummary>>().mockResolvedValue(asset()), getAssetDetail: vi.fn<(id: string, signal: AbortSignal) => Promise<CanvasAssetSummary>>().mockResolvedValue(asset()), startRun: vi.fn(), generateImage: vi.fn() }
  const setBanner = vi.fn(), markCanvasAssetUsed = vi.fn().mockResolvedValue(undefined), refreshAssets = vi.fn().mockResolvedValue(undefined), setImageMaskSession = vi.fn(), setDirtyNodeIds = vi.fn()
  let nextId = 0
  const nextNodeId = () => `mask-copy-${++nextId}`
  const createNode = vi.fn((type: string) => toCanvasNode({ id: nextNodeId(), kind: type as 'image-generate', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: 'gpt-image-1', group: 'provider', quality: 'low', size: '1024x1024', status: 'idle' } }))
  const environment = { imageMaskSessionRef, imageMaskExportSavingRef, imageMaskExportReceiptsRef, layerEditorOwnerRef, activeProjectIdRef, projectEpochRef, draftActionsEnabledRef, projectTransitionRef, activeRunsRef, startingRunsRef, pendingRunProjectionIdsRef, projectCanEditRef, mediaPreparationMountedRef,
    parseImageEditMask, assertLayerEditorScope, assertMaskAssetPng, assertMaskAssetSource, buildLinkedMaskAssetNode, buildMaskAssetNode, parseMaskAssetUpload, replaceMaskAssetNode, layerEditorScopeToken, canvasNodeDocumentRecord, dirtyCanvasNodeIds,
    getGraphSnapshot, execute, setNodes, graphRef: { current: getGraphSnapshot() }, hostBridge: () => host, importedAssetSummary: actual('importedAssetSummary', {}), nextNodeId, createNode,
    setBanner, markCanvasAssetUsed, refreshAssets, setImageMaskSession, setDirtyNodeIds, createdNodeFocusRef: { current: { start: vi.fn() } }, currentReactFlowRef: { current: null }, createdNodeFocusZoom: vi.fn(),
  }
  const bindSave = (nextSession = session) => actual<Save>('saveImageMaskAsset', { ...environment, imageMaskSession: nextSession })
  const mask: ImageEditMask = { version: 1, sourceAssetId: selected, width: 64, height: 48, strokes: [{ tool: 'brush', size: .2, points: [{ x: .2, y: .5 }, { x: .8, y: .5 }] }] }
  const png: ImageMaskAssetPng = await encodeImageMaskPng(mask)
  return { ...environment, host, session, save: bindSave(), bindSave, mask, png, current: getGraphSnapshot, history: () => history, mutate: setNodes,
    changeEdges: (next: typeof edges) => { history = { ...history, present: { ...history.present, edges: next } } },
  }
}

describe('actual App mask image asset export', () => {
  it.each(['output', 'input'] as const)('saves a linked bitmap with a real original input from %s without running a model', async (from) => {
    const f = await fixture(from), before = structuredClone(f.current())
    await f.save(f.mask, f.png, new AbortController().signal, 'linked')
    const after = f.current(), added = after.nodes.at(-1)!
    expect(after.nodes.slice(0, before.nodes.length)).toEqual(before.nodes.map((node) => ({ ...node, selected: false })))
    expect(added.type).toBe('image-generate')
    expect(added.data).toMatchObject({ prompt: '', model: 'gpt-image-1', group: 'provider', status: 'succeeded', result: { assetId: exported } })
    expect(added.data.settings?.imageEditMask).toBeUndefined(); expect(added.data.candidates).toBeUndefined(); expect(added.data.fromCache).toBeUndefined()
    expect(after.edges.slice(0, before.edges.length)).toEqual(before.edges)
    expect(after.edges.at(-1)).toMatchObject({ source: 'source', sourceHandle: 'out:image', target: added.id, targetHandle: 'in:images' })
    expect(f.host.importAssetFile).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce()
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.generateImage).not.toHaveBeenCalled()
    const undone = undoCanvasHistory(f.history())
    expect(undone.present.nodes).toHaveLength(before.nodes.length); expect(undone.present.edges).toEqual(before.edges)
    expect(redoCanvasHistory(undone).present.edges).toEqual(after.edges)
    const loaded = parseWorkflowFile(serializeWorkflow({ ...createEmptyWorkflow('Linked mask'), nodes: after.nodes.map(toWorkflowNode), edges: after.edges }))!
    expect(loaded.nodes.at(-1)?.data.result?.assetId).toBe(exported); expect(loaded.edges.at(-1)).toEqual(after.edges.at(-1))
    const graph = toCanvasRunGraph(after.nodes, after.edges, { image: 'provider', video: '' })
    const scope = { kind: 'to-node', nodeId: added.id } as const
    const plan = buildCanvasRunPreflight({ graph, scope, cachedNodeIds: cachedNodeIdsForPreflight(after.nodes, scope), imageModels: ['gpt-image-1'], videoModels: [] })
    expect(plan.canStart).toBe(false)
    expect(plan.items.find((item) => item.nodeId === added.id)).toMatchObject({ action: 'blocked', requestCount: 0, reasonCode: 'invalid-parameters' })
    graph.nodes.find((node) => node.id === added.id)!.data.prompt = 'Use the original image to create a new version'
    const ready = buildCanvasRunPreflight({ graph, scope, cachedNodeIds: [added.id], imageModels: ['gpt-image-1'], videoModels: [] })
    expect(ready.items.find((item) => item.nodeId === added.id)).toMatchObject({ action: 'execute', requestCount: 1, paid: true })
  })

  it('replaces only the selected candidate, retains inputs and parameters, and marks its downstream dirty', async () => {
    const f = await fixture()
    const ref = (assetId: string) => ({ kind: 'image' as const, assetId, localUrl: `xingmang-asset://image/${assetId}`, width: 64, height: 48 })
    const downstream = toCanvasNode({ id: 'downstream', kind: 'image-crop', definitionVersion: 1, position: { x: 900, y: 100 }, data: { prompt: '', model: '', status: 'succeeded', result: ref(first) } })
    f.execute({ type: 'add-nodes', nodes: [canvasNodeDocumentRecord(downstream)], edges: [{ id: 'downstream-edge', source: 'source', sourceHandle: 'out:image', target: 'downstream', targetHandle: 'in:image' }] })
    // Runtime candidate objects intentionally do not enter document history.
    f.mutate((nodes) => nodes.map((node) => {
      if (node.id !== 'source') return node
      return { ...node, data: { ...node.data,
        candidates: [first, selected].map((id, index) => ({ candidateId: `candidate-${index}`, attemptId: 'original-model-attempt', createdAt: asset().createdAt, outputIndex: index, asset: ref(id) })),
        selectedCandidateId: 'candidate-1', adoptedCandidateId: 'candidate-1', fromCache: true,
      } }
    }))
    f.execute.mockClear()
    const before = structuredClone(f.current())
    await f.save(f.mask, f.png, new AbortController().signal, 'replace')
    const after = f.current(), changed = after.nodes[0]
    expect(after.nodes).toHaveLength(before.nodes.length); expect(after.edges).toEqual(before.edges)
    expect(changed.data.result?.assetId).toBe(exported); expect(changed.data.candidateAssetIds).toEqual([first, exported])
    expect(changed.data.candidates?.[0]).toEqual(before.nodes[0].data.candidates?.[0])
    expect(changed.data.candidates?.[1]).toMatchObject({ candidateId: `document:source:mask:${exported}`, outputIndex: 1, asset: { assetId: exported } })
    expect(changed.data.candidates?.[1].attemptId).not.toBe('original-model-attempt')
    expect(changed.data.prompt).toBe(before.nodes[0].data.prompt); expect(changed.data.model).toBe(before.nodes[0].data.model); expect(changed.data.settings).toEqual(before.nodes[0].data.settings)
    expect(changed.data.selectedCandidateId).toBeUndefined(); expect(changed.data.adoptedCandidateId).toBeUndefined(); expect(changed.data.fromCache).toBeUndefined()
    expect(after.nodes[1].data.dirty).toBe(true); expect(f.setDirtyNodeIds).toHaveBeenCalledWith(new Set(['downstream']))
    expect(f.createdNodeFocusRef.current.start).not.toHaveBeenCalled(); expect(f.execute).toHaveBeenCalledOnce()
    const undone = undoCanvasHistory(f.history())
    expect(undone.present.nodes[0].data.result).toEqual(before.nodes[0].data.result)
    expect(editorNodeToCanvasNode(redoCanvasHistory(undone).present.nodes[0]).data.result?.assetId).toBe(exported)
    const loaded = parseWorkflowFile(serializeWorkflow({ ...createEmptyWorkflow('Replaced mask'), nodes: after.nodes.map(toWorkflowNode), edges: after.edges }))!
    expect(loaded.nodes[0].data.candidateAssetIds).toEqual([first, exported]); expect(loaded.nodes[1].data.dirty).toBe(true)
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.generateImage).not.toHaveBeenCalled()
  })

  it('rejects replacing an input-only edit session before uploading or changing its original', async () => {
    const f = await fixture('input'), before = structuredClone(f.current())
    await expect(f.save(f.mask, f.png, new AbortController().signal, 'replace')).rejects.toThrow('输入原图不会被替换')
    expect(f.host.importAssetFile).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.current()).toEqual(before)
  })

  it('retains the unknown upload identity across explicit save mode changes instead of POSTing again', async () => {
    const f = await fixture()
    f.host.importAssetFile.mockRejectedValueOnce(new Error('lost upload response'))
    await expect(f.save(f.mask, f.png, new AbortController().signal, 'linked')).rejects.toThrow('尚未确认')
    await expect(f.save(f.mask, f.png, new AbortController().signal, 'new')).rejects.toThrow('尚未确认')
    await expect(f.save(f.mask, f.png, new AbortController().signal, 'replace')).rejects.toThrow('尚未确认')
    expect(f.host.importAssetFile).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled()
  })

  it.each(['linked', 'replace'] as const)('keeps a %s draft and reuses its confirmed upload after the document refuses the command', async (mode) => {
    const f = await fixture(), before = structuredClone(f.current())
    f.execute.mockImplementationOnce(() => {})
    await expect(f.save(f.mask, f.png, new AbortController().signal, mode)).rejects.toThrow('节点尚未加入画布')
    expect(f.current()).toEqual(before); expect(f.imageMaskSessionRef.current).toBe(f.session); expect(f.setBanner).not.toHaveBeenCalled()
    await f.save(f.mask, f.png, new AbortController().signal, mode)
    expect(f.host.importAssetFile).toHaveBeenCalledOnce(); expect(f.host.getAssetDetail).toHaveBeenCalledOnce()
    expect(f.imageMaskSessionRef.current).toBeNull()
  })

  it.each(['linked', 'replace'] as const)('rejects a late %s save after edit permission is revoked', async (mode) => {
    const f = await fixture(), wait = deferred<CanvasAssetSummary>()
    f.host.importAssetFile.mockReturnValueOnce(wait.promise)
    const saving = f.save(f.mask, f.png, new AbortController().signal, mode), assertion = expect(saving).rejects.toThrow('没有编辑权限')
    await vi.waitFor(() => expect(f.host.importAssetFile).toHaveBeenCalledOnce())
    f.projectCanEditRef.current = false; wait.resolve(asset()); await assertion
    expect(f.execute).not.toHaveBeenCalled(); expect(f.setBanner).not.toHaveBeenCalled(); expect(f.setImageMaskSession).not.toHaveBeenCalled()
  })

  it.each(['output', 'input'] as const)('saves one real PNG and one independent image node from %s with one-step undo and redo', async (from) => {
    const f = await fixture(from), before = structuredClone(f.current()), signal = new AbortController().signal
    await f.save(f.mask, f.png, signal)
    const after = f.current(), added = after.nodes.at(-1)!
    expect(after.nodes.slice(0, before.nodes.length)).toEqual(before.nodes.map((node) => ({ ...node, selected: false })))
    expect(after.edges).toEqual(before.edges)
    expect(added.type).toBe('image-input'); expect(added.data.settings?.title).toContain('蒙版')
    expect(added.data.result).toMatchObject({ kind: 'image', assetId: exported, width: 64, height: 48, mimeType: 'image/png' })
    expect(added.data.prompt).toBe(''); expect(added.data.model).toBe(''); expect(added.data.candidates).toBeUndefined()
    expect(added.selected).toBe(true)
    expect(f.host.importAssetFile).toHaveBeenCalledOnce()
    const file = f.host.importAssetFile.mock.calls[0][0]
    expect(file.type).toBe('image/png'); expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(await f.png.blob.arrayBuffer()))
    expect(f.host.importAssetFile.mock.calls[0][1]).toEqual({ mediaType: 'image' })
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.markCanvasAssetUsed).toHaveBeenCalledExactlyOnceWith(exported)
    expect(f.refreshAssets).toHaveBeenCalledOnce(); expect(f.imageMaskSessionRef.current).toBeNull()
    const undone = undoCanvasHistory(f.history())
    expect(undone.present.nodes).toHaveLength(before.nodes.length)
    expect(redoCanvasHistory(undone).present.nodes.at(-1)?.data.result).toMatchObject({ assetId: exported })
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.generateImage).not.toHaveBeenCalled()
    await expect(f.save(f.mask, f.png, signal)).rejects.toThrow('已结束')
    expect(f.host.importAssetFile).toHaveBeenCalledOnce(); expect(f.imageMaskExportSavingRef.current).toBe(false)
  })

  it('does not POST twice while the first upload is pending', async () => {
    const f = await fixture(), pending = deferred<CanvasAssetSummary>()
    f.host.importAssetFile.mockReturnValue(pending.promise)
    const saving = f.save(f.mask, f.png, new AbortController().signal)
    await vi.waitFor(() => expect(f.host.importAssetFile).toHaveBeenCalledOnce())
    await expect(f.save(f.mask, f.png, new AbortController().signal)).rejects.toThrow('正在保存')
    pending.resolve(asset()); await saving
    expect(f.host.importAssetFile).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce()
  })

  it('retains an unknown upload outcome and refuses to invent another upload or node', async () => {
    const f = await fixture(), before = structuredClone(f.current())
    f.host.importAssetFile.mockRejectedValueOnce(new Error('connection lost after submission'))
    await expect(f.save(f.mask, f.png, new AbortController().signal)).rejects.toThrow('素材库核对')
    await expect(f.save(f.mask, f.png, new AbortController().signal)).rejects.toThrow('尚未确认')
    expect(f.host.importAssetFile).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled()
    expect(f.current()).toEqual(before); expect(f.imageMaskExportSavingRef.current).toBe(false)
  })

  it.each([{ assetId: 'wrong' }, { localUrl: 'https://example.invalid/mask.png' }, { mimeType: 'image/jpeg' }, { deletedAt: 'now' }, { width: 65 }, { height: 49 }])('keeps an unconfirmed upload receipt out of the graph: %j', async (invalid) => {
    const f = await fixture()
    f.host.importAssetFile.mockResolvedValueOnce({ ...asset(), ...invalid } as CanvasAssetSummary)
    await expect(f.save(f.mask, f.png, new AbortController().signal)).rejects.toThrow('尚未确认')
    await expect(f.save(f.mask, f.png, new AbortController().signal)).rejects.toThrow('尚未确认')
    expect(f.execute).not.toHaveBeenCalled(); expect(f.markCanvasAssetUsed).not.toHaveBeenCalled(); expect(f.host.importAssetFile).toHaveBeenCalledOnce()
  })

  it('uses the encoded PNG dimensions when upload metadata omits them', async () => {
    const f = await fixture(), uploaded = asset()
    delete uploaded.width; delete uploaded.height
    f.host.importAssetFile.mockResolvedValueOnce(uploaded)
    await f.save(f.mask, f.png, new AbortController().signal)
    expect(f.current().nodes.at(-1)?.data.result).toMatchObject({ width: 64, height: 48 })
  })

  it.each(['close', 'owner', 'account', 'project', 'epoch', 'disabled', 'transition', 'running', 'starting', 'projection', 'source', 'locked', 'deleted', 'cancel', 'readonly', 'unmount'] as const)('rejects a late upload after %s without adding a node', async (change) => {
    const f = await fixture(), pending = deferred<CanvasAssetSummary>(), controller = new AbortController()
    f.host.importAssetFile.mockReturnValueOnce(pending.promise)
    const operation = f.save(f.mask, f.png, controller.signal), assertion = expect(operation).rejects.toThrow()
    await vi.waitFor(() => expect(f.host.importAssetFile).toHaveBeenCalledOnce())
    if (change === 'close') f.imageMaskSessionRef.current = null
    if (change === 'owner') f.layerEditorOwnerRef.current.ownerId++
    if (change === 'account') f.layerEditorOwnerRef.current.accountId = 'owner-b'
    if (change === 'project') f.activeProjectIdRef.current = 'project-b'
    if (change === 'epoch') f.projectEpochRef.current++
    if (change === 'disabled') f.draftActionsEnabledRef.current = false
    if (change === 'transition') f.projectTransitionRef.current = true
    if (change === 'running') f.activeRunsRef.current.add('run')
    if (change === 'starting') f.startingRunsRef.current = true
    if (change === 'projection') f.pendingRunProjectionIdsRef.current.add('run')
    if (change === 'source') f.mutate((nodes) => nodes.map((node) => ({ ...node, data: { ...node.data, result: { ...node.data.result!, assetId: first } } })))
    if (change === 'locked') f.mutate((nodes) => nodes.map((node) => ({ ...node, draggable: false })))
    if (change === 'deleted') f.mutate(() => [])
    if (change === 'cancel') controller.abort()
    if (change === 'readonly') f.projectCanEditRef.current = false
    if (change === 'unmount') f.mediaPreparationMountedRef.current = false
    const beforeReply = structuredClone(f.current())
    pending.resolve(asset()); await assertion
    expect(f.current()).toEqual(beforeReply); expect(f.execute).not.toHaveBeenCalled(); expect(f.markCanvasAssetUsed).not.toHaveBeenCalled()
    expect(f.imageMaskExportSavingRef.current).toBe(false)
    expect([...f.imageMaskExportReceiptsRef.current.values()]).toEqual([{ status: 'saved', asset: asset() }])
  })

  it('reuses a confirmed upload after closing and explicitly reopening the same mask without a second POST', async () => {
    const f = await fixture(), pending = deferred<CanvasAssetSummary>(), controller = new AbortController()
    f.host.importAssetFile.mockReturnValueOnce(pending.promise)
    const operation = f.save(f.mask, f.png, controller.signal), assertion = expect(operation).rejects.toThrow()
    await vi.waitFor(() => expect(f.host.importAssetFile).toHaveBeenCalledOnce())
    f.imageMaskSessionRef.current = null; controller.abort(); pending.resolve(asset()); await assertion
    const reopened = { ...f.session }; f.imageMaskSessionRef.current = reopened
    await f.bindSave(reopened)(f.mask, f.png, new AbortController().signal)
    expect(f.host.getAssetDetail).toHaveBeenCalledExactlyOnceWith(exported, expect.any(AbortSignal))
    expect(f.host.importAssetFile).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce()
  })

  it('does not upload invalid, mismatched or cancelled PNG exports', async () => {
    const f = await fixture(), controller = new AbortController(); controller.abort()
    await expect(f.save(f.mask, f.png, controller.signal)).rejects.toThrow()
    await expect(f.save(f.mask, { ...f.png, width: 65 }, new AbortController().signal)).rejects.toThrow()
    await expect(f.save(f.mask, { ...f.png, blob: new Blob(['not PNG'], { type: 'image/png' }) }, new AbortController().signal)).rejects.toThrow()
    expect(f.host.importAssetFile).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  })

  it('refuses an initial read-only project without encoding or uploading', async () => {
    const f = await fixture(); f.projectCanEditRef.current = false
    await expect(f.save(f.mask, f.png, new AbortController().signal)).rejects.toThrow('没有编辑权限')
    expect(f.host.importAssetFile).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.setImageMaskSession).not.toHaveBeenCalled()
  })

  it('does not announce success or discard the mask when the document refuses its add command', async () => {
    const f = await fixture(), before = structuredClone(f.current())
    f.execute.mockImplementationOnce(() => {})
    await expect(f.save(f.mask, f.png, new AbortController().signal)).rejects.toThrow('节点尚未加入画布')
    expect(f.current()).toEqual(before); expect(f.imageMaskSessionRef.current).toBe(f.session)
    expect(f.markCanvasAssetUsed).not.toHaveBeenCalled(); expect(f.setImageMaskSession).not.toHaveBeenCalled(); expect(f.setBanner).not.toHaveBeenCalled()
    await f.save(f.mask, f.png, new AbortController().signal)
    expect(f.host.importAssetFile).toHaveBeenCalledOnce(); expect(f.host.getAssetDetail).toHaveBeenCalledOnce()
    expect(f.current().nodes).toHaveLength(before.nodes.length + 1)
  })

  it('does not mistake position, selection or replacement edge IDs for a different source', async () => {
    const f = await fixture('input')
    f.mutate((nodes) => nodes.map((node) => ({ ...node, position: { x: node.position.x + 40, y: node.position.y + 20 }, selected: true })))
    f.changeEdges(f.current().edges.map((edge) => ({ ...edge, id: 'recreated-edge' })))
    await f.save(f.mask, f.png, new AbortController().signal)
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.current().edges[0].id).toBe('recreated-edge')
  })
})
