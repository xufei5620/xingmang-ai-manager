import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { canvasNodeDisplayGeometry } from '../domain/node-display-geometry'
import { createdNodeFocusZoom } from '../editor/node-focus'
import { findAvailableCanvasPosition } from '../editor/node-placement'
import type { CanvasAssetSummary, CanvasImageAssetSummary } from '../host'
import { assetInputNodeKind, mediaAssetNodeDimensions, unresolvedMediaPlacementDimensions } from '../library/media-assets'
import type { NodeKind, WorkflowNode } from '../model'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { currentNodeCandidates } from '../runtime/current-batch-candidates'
import { dirtyCanvasNodeIds } from '../runtime/run-projection'
import { createCanvasDocument } from '../store/canvas-state'
import { canvasNodeDocumentRecord, useCanvasDocument, type CanvasDocumentController } from '../store/use-canvas-document'
import { assertAnnotationTarget, replaceAnnotatedImage } from './annotation-workflow'
import { assertLayerEditorScope, layerEditorScopeToken } from './layer-editor-scope'
import type { ImageLayerRecipe } from './recipe'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0].getText(source) : node.initializer.getText(source)
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source).replace(/^export\s+/, '')
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name && ts.isArrowFunction(node.initializer)) expression = node.initializer.getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}

const first = 'a'.repeat(43), selected = 'b'.repeat(43), third = 'c'.repeat(43), annotated = 'd'.repeat(43)
function asset(id = selected): CanvasImageAssetSummary { return { assetId: id, mediaType: 'image', localUrl: `xingmang-asset://image/${id}`, mimeType: 'image/png', thumbnailUrl: '', fileName: 'original.png', createdAt: '2026-10-15T00:00:00.000Z', width: 640, height: 480 } }
function output() { return { blob: new Blob(['rendered PNG'], { type: 'image/png' }), width: 640, height: 480 } }
function recipe(): ImageLayerRecipe { return { kind: 'layer', explicitLayers: true, outputWidth: 640, outputHeight: 480, background: 'transparent', layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true }] } }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { resolve, reject, promise } }
type Session = { nodeId: string; asset: CanvasImageAssetSummary; scope: string }
type SaveMode = 'replace' | 'new' | 'download'

function fixture() {
  const toCanvasNode = actual<(node: WorkflowNode) => CanvasNode>('toCanvasNode', { canvasNodeDisplayGeometry })
  function projectNode(record: EditorNodeRecord): CanvasNode { return toCanvasNode({ ...record, kind: record.type as NodeKind, data: { prompt: '', model: '', status: 'idle', ...record.data } }) }
  let captured: CanvasDocumentController | undefined
  function Capture() { captured = useCanvasDocument(projectNode); return null }
  renderToStaticMarkup(createElement(Capture))
  if (!captured) throw new Error('Missing actual document controller')
  const target = captured
  const mediaAssetRef = actual<(asset: CanvasAssetSummary) => NonNullable<WorkflowNode['data']['result']>>('mediaAssetRef', {})
  const sourceNode: EditorNodeRecord = { id: 'source', type: 'image-generate', definitionVersion: 1, position: { x: 0, y: 0 }, data: {
    prompt: 'pending input edit', model: 'gpt-image-1', status: 'succeeded', dirty: true, result: mediaAssetRef(asset()), candidateAssetIds: [first, selected, third],
    selectedCandidateId: 'candidate-2', adoptedCandidateId: 'candidate-2', fromCache: true,
    candidates: [first, selected, third].map((id, index) => ({ candidateId: `candidate-${index+1}`, attemptId: `paid-${index+1}`, createdAt: '', asset: mediaAssetRef(asset(id)) })),
  } }
  const child: EditorNodeRecord = { id: 'child', type: 'image-collage', definitionVersion: 1, position: { x: 700, y: 0 }, data: { prompt: '', model: '', dirty: false, result: mediaAssetRef(asset(third)), status: 'succeeded' } }
  const unrelated: EditorNodeRecord = { id: 'unrelated', type: 'image-input', definitionVersion: 1, position: { x: 0, y: 600 }, data: { prompt: '', model: '', dirty: false, result: mediaAssetRef(asset(first)), status: 'succeeded' } }
  target.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: [sourceNode, child, unrelated], edges: [{ id: 'edge', source: 'source', sourceHandle: 'out:image', target: 'child', targetHandle: 'in:images' }] } })
  const layerEditorOwnerRef = { current: { ownerId: 7, accountId: 'owner-a' } }, activeProjectIdRef = { current: 'project-a' }, projectEpochRef = { current: 1 }
  const draftActionsEnabledRef = { current: true }, projectTransitionRef = { current: false }, mediaPreparationMountedRef = { current: true }
  const activeRunsRef = { current: new Set<string>() }, pendingRunProjectionIdsRef = { current: new Set<string>() }, startingRunsRef = { current: false }
  const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: true })
  const session: Session = { nodeId: 'source', asset: asset(), scope }
  const annotationSessionRef = { current: session as Session | null }, annotationLoadingRef = { current: null as AbortController | null }, annotationSavingRef = { current: false }
  const renderImageAnnotation = vi.fn<(input: { sourceAssetId: string; recipe: ImageLayerRecipe }, signal?: AbortSignal) => Promise<ReturnType<typeof output>>>().mockResolvedValue(output())
  const importAssetFile = vi.fn<(file: File) => Promise<CanvasAssetSummary>>().mockResolvedValue(asset(annotated))
  const getAssetDetail = vi.fn<(id: string, signal?: AbortSignal) => Promise<CanvasAssetSummary>>().mockResolvedValue(asset())
  const host = { renderImageAnnotation, importAssetFile, getAssetDetail, startRun: vi.fn(), generateImage: vi.fn() }
  const execute = vi.fn(target.execute), setBanner = vi.fn(), setDirtyNodeIds = vi.fn(), markCanvasAssetUsed = vi.fn().mockResolvedValue(undefined), refreshAssets = vi.fn().mockResolvedValue(undefined), downloadAnnotationPng = vi.fn(), setAnnotationSession = vi.fn()
  vi.stubGlobal('document', { querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }) }) })
  let sequence = 0
  const environment = { layerEditorOwnerRef, activeProjectIdRef, projectEpochRef, draftActionsEnabledRef, projectTransitionRef, mediaPreparationMountedRef, activeRunsRef, pendingRunProjectionIdsRef, startingRunsRef,
    annotationSessionRef, annotationLoadingRef, annotationSavingRef, assertAnnotationTarget, assertLayerEditorScope, layerEditorScopeToken, replaceAnnotatedImage,
    getGraphSnapshot: target.getGraphSnapshot, setNodes: target.setNodes, execute, graphRef: { current: target.getGraphSnapshot() }, setDirtyNodeIds, dirtyCanvasNodeIds, canvasNodeDocumentRecord,
    hostBridge: () => host, importedAssetSummary: actual('importedAssetSummary', {}), markCanvasAssetUsed, refreshAssets, assetQuery: { offset: 20 }, setBanner, downloadAnnotationPng, setAnnotationSession,
    builtinNodeRegistry, assetInputNodeKind, mediaAssetNodeDimensions, unresolvedMediaPlacementDimensions, findAvailableCanvasPosition, toCanvasNode, mediaAssetRef, nextNodeId: () => `annotated-node-${++sequence}`,
    currentReactFlowRef: { current: { screenToFlowPosition: (point: { x: number; y: number }) => point } }, createdNodeFocusRef: { current: { start: vi.fn() } }, createdNodeFocusZoom,
  }
  const createAssetNode = actual<(value: CanvasAssetSummary) => void>('createAssetNode', environment)
  const save = actual<(recipe: ImageLayerRecipe, mode: SaveMode, signal: AbortSignal) => Promise<void>>('saveImageAnnotation', { ...environment, annotationSession: session, createAssetNode })
  const open = actual<(nodeId: string) => void>('onAnnotateImage', environment)
  return { ...environment, target, host, session, save, open, renderImageAnnotation, importAssetFile, getAssetDetail,
    current: () => target.getGraphSnapshot(), mutate: target.setNodes,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('actual App image annotation transactions', () => {
  it('replaces only the adopted second slot, preserves pending edits and dirties downstream in one undoable command', async () => {
    const f = fixture(), before = structuredClone(f.current()), controller = new AbortController()
    await f.save(recipe(), 'replace', controller.signal)
    const after = f.current()
    expect(f.renderImageAnnotation).toHaveBeenCalledExactlyOnceWith({ sourceAssetId: selected, recipe: recipe() }, controller.signal)
    expect(f.importAssetFile).toHaveBeenCalledOnce()
    expect(after.nodes).toHaveLength(3)
    expect(after.nodes[0].data).toMatchObject({ result: { assetId: annotated }, prompt: 'pending input edit', model: 'gpt-image-1', dirty: true, candidateAssetIds: [first, annotated, third] })
    expect(after.nodes[0].data.candidates).toHaveLength(3)
    expect(after.nodes[0].data.candidates?.[0]).toEqual(before.nodes[0].data.candidates?.[0])
    expect(after.nodes[0].data.candidates?.[2]).toEqual(before.nodes[0].data.candidates?.[2])
    expect(after.nodes[0].data.candidates?.[1]).toEqual({
      candidateId: `document:source:annotation:${annotated}`, attemptId: 'document:source',
      createdAt: asset(annotated).createdAt, asset: after.nodes[0].data.result,
    })
    expect(after.nodes[0].data.selectedCandidateId).toBeUndefined(); expect(after.nodes[0].data.adoptedCandidateId).toBeUndefined(); expect(after.nodes[0].data.fromCache).toBeUndefined()
    expect(after.nodes[1].data.dirty).toBe(true)
    expect(after.nodes[2]).toEqual(before.nodes[2]); expect(after.edges).toEqual(before.edges)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.setDirtyNodeIds).toHaveBeenCalledWith(new Set(['source', 'child']))
    f.target.undo()
    expect(f.current().nodes[0].data.result?.assetId).toBe(selected)
    expect(f.current().nodes[0].data.candidateAssetIds).toEqual([first, selected, third])
    const undoneCandidates = currentNodeCandidates('source', 'image-generate', f.current().nodes[0].data)
    expect(undoneCandidates.map((candidate) => candidate.asset.assetId)).toEqual([first, selected, third])
    expect(undoneCandidates[0]).toEqual(before.nodes[0].data.candidates?.[0])
    expect(undoneCandidates[2]).toEqual(before.nodes[0].data.candidates?.[2])
    expect(undoneCandidates[1].asset).toEqual(before.nodes[0].data.result)
    expect(f.current().nodes[1].data.dirty).toBe(false)
    f.target.redo()
    expect(f.current().nodes[0].data.result?.assetId).toBe(annotated)
    expect(f.current().nodes[0].data.candidates).toEqual(after.nodes[0].data.candidates)
    expect(f.importAssetFile).toHaveBeenCalledOnce(); expect(f.renderImageAnnotation).toHaveBeenCalledOnce()
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.generateImage).not.toHaveBeenCalled()
  })

  it('creates an independent image input without changing the source or connecting fake generation edges', async () => {
    const f = fixture()
    f.mutate((nodes) => nodes.map((node) => ({ ...node, selected: node.id === 'source' })))
    const before = structuredClone(f.current())
    await f.save(recipe(), 'new', new AbortController().signal)
    const after = f.current(), node = after.nodes[3]
    expect(after.nodes.slice(0, 3)).toEqual(before.nodes.map((node) => ({ ...node, selected: false }))); expect(after.edges).toEqual(before.edges)
    expect(node.type).toBe('image-input'); expect(node.data.result?.assetId).toBe(annotated)
    expect(node.selected).toBe(true)
    expect(after.nodes.filter((entry) => entry.selected).map((entry) => entry.id)).toEqual([node.id])
    expect(node.data.prompt).toBe(''); expect(node.data.model).toBe('')
    expect(f.execute).toHaveBeenCalledOnce()
    f.target.undo(); expect(f.current().nodes).toHaveLength(3)
    f.target.redo(); expect(f.current().nodes[3].data.result?.assetId).toBe(annotated)
    expect(f.importAssetFile).toHaveBeenCalledOnce(); expect(f.host.startRun).not.toHaveBeenCalled()
  })

  it('downloads the rendered PNG without uploading, writing a command, or changing asset usage', async () => {
    const f = fixture(), before = structuredClone(f.current())
    await f.save(recipe(), 'download', new AbortController().signal)
    expect(f.downloadAnnotationPng).toHaveBeenCalledExactlyOnceWith(expect.any(Blob))
    expect(f.importAssetFile).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.markCanvasAssetUsed).not.toHaveBeenCalled(); expect(f.refreshAssets).not.toHaveBeenCalled()
    expect(f.current()).toEqual(before)
  })

  for (const mode of ['replace', 'new'] as const) {
    it.each(['both', 'width', 'height'] as const)(`uses verified rendered PNG dimensions for omitted %s upload metadata when saving ${mode}`, async (missing) => {
      const f = fixture(), uploaded = asset(annotated)
      if (missing !== 'height') delete uploaded.width
      if (missing !== 'width') delete uploaded.height
      f.importAssetFile.mockResolvedValueOnce(uploaded)
      await f.save(recipe(), mode, new AbortController().signal)
      const saved = mode === 'replace' ? f.current().nodes[0] : f.current().nodes[3]
      expect(saved.data.result).toMatchObject({ assetId: annotated, kind: 'image', mimeType: 'image/png', width: 640, height: 480 })
      expect(f.importAssetFile).toHaveBeenCalledOnce()
      expect(f.renderImageAnnotation).toHaveBeenCalledOnce()
      expect(f.getAssetDetail).not.toHaveBeenCalled()
      expect(f.execute).toHaveBeenCalledOnce()
      expect(f.host.startRun).not.toHaveBeenCalled()
    })
  }

  it.each([{ width: 641, height: undefined }, { width: undefined, height: 481 }])('rejects conflicting present upload dimensions without replacing the canvas', async (dimensions) => {
    const f = fixture(), before = structuredClone(f.current())
    f.importAssetFile.mockResolvedValueOnce({ ...asset(annotated), ...dimensions })
    await expect(f.save(recipe(), 'replace', new AbortController().signal)).rejects.toThrow('不一致')
    expect(f.current()).toEqual(before)
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.importAssetFile).toHaveBeenCalledOnce()
    expect(f.renderImageAnnotation).toHaveBeenCalledOnce()
  })

  it.each([{ mimeType: 'image/jpeg' as const }, { assetId: 'not-a-saved-asset' }, { localUrl: 'https://example.invalid/unrelated.png' }, { deletedAt: '2026-10-15T01:00:00.000Z' }])('does not create a node from an invalid upload receipt', async (invalid) => {
    const f = fixture(), before = structuredClone(f.current())
    f.importAssetFile.mockResolvedValueOnce({ ...asset(annotated), ...invalid })
    await expect(f.save(recipe(), 'new', new AbortController().signal)).rejects.toThrow('不一致')
    expect(f.current()).toEqual(before)
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.markCanvasAssetUsed).not.toHaveBeenCalled()
    expect(f.importAssetFile).toHaveBeenCalledOnce()
    expect(f.renderImageAnnotation).toHaveBeenCalledOnce()
  })

  for (const phase of ['render', 'upload'] as const) {
    it.each(['close', 'candidate', 'locked', 'deleted', 'project', 'reload', 'owner', 'account', 'disabled', 'transition', 'running', 'starting', 'projection', 'cancel'] as const)(`rejects ${phase} completion after %s without committing`, async (change) => {
      const f = fixture(), rendered = deferred<ReturnType<typeof output>>(), uploaded = deferred<CanvasAssetSummary>(), controller = new AbortController()
      if (phase === 'render') f.renderImageAnnotation.mockReturnValue(rendered.promise)
      else f.importAssetFile.mockReturnValue(uploaded.promise)
      const operation = f.save(recipe(), 'replace', controller.signal), assertion = expect(operation).rejects.toThrow()
      await vi.waitFor(() => expect(phase === 'render' ? f.renderImageAnnotation : f.importAssetFile).toHaveBeenCalledOnce())
      if (change === 'close') f.annotationSessionRef.current = null
      if (change === 'candidate') f.mutate((nodes) => nodes.map((node) => node.id === 'source' ? { ...node, data: { ...node.data, result: { ...node.data.result!, assetId: first } } } : node))
      if (change === 'locked') f.mutate((nodes) => nodes.map((node) => node.id === 'source' ? { ...node, draggable: false } : node))
      if (change === 'deleted') f.mutate((nodes) => nodes.filter((node) => node.id !== 'source'))
      if (change === 'project') f.activeProjectIdRef.current = 'project-b'
      if (change === 'reload') f.projectEpochRef.current++
      if (change === 'owner') f.layerEditorOwnerRef.current.ownerId++
      if (change === 'account') f.layerEditorOwnerRef.current.accountId = 'owner-b'
      if (change === 'disabled') f.draftActionsEnabledRef.current = false
      if (change === 'transition') f.projectTransitionRef.current = true
      if (change === 'running') f.activeRunsRef.current.add('run')
      if (change === 'starting') f.startingRunsRef.current = true
      if (change === 'projection') f.pendingRunProjectionIdsRef.current.add('run')
      if (change === 'cancel') controller.abort()
      const expected = structuredClone(f.current())
      rendered.resolve(output()); uploaded.resolve(asset(annotated))
      await assertion
      expect(f.current()).toEqual(expected); expect(f.execute).not.toHaveBeenCalled(); expect(f.downloadAnnotationPng).not.toHaveBeenCalled(); expect(f.markCanvasAssetUsed).not.toHaveBeenCalled()
      expect(f.importAssetFile).toHaveBeenCalledTimes(phase === 'render' ? 0 : 1)
      expect(f.annotationSavingRef.current).toBe(false)
    })
  }

  it('rejects double saving while the first upload waits and commits only its receipt once', async () => {
    const f = fixture(), pending = deferred<CanvasAssetSummary>(), controller = new AbortController()
    f.importAssetFile.mockReturnValue(pending.promise)
    const firstSave = f.save(recipe(), 'new', controller.signal)
    await vi.waitFor(() => expect(f.importAssetFile).toHaveBeenCalledOnce())
    await expect(f.save(recipe(), 'new', controller.signal)).rejects.toThrow('正在保存')
    pending.resolve(asset(annotated)); await firstSave
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.renderImageAnnotation).toHaveBeenCalledOnce(); expect(f.importAssetFile).toHaveBeenCalledOnce()
  })

  it('keeps the original graph when uploading fails or returned dimensions mismatch', async () => {
    const f = fixture(), before = structuredClone(f.current())
    f.importAssetFile.mockRejectedValueOnce(new Error('upload outcome unknown'))
    await expect(f.save(recipe(), 'replace', new AbortController().signal)).rejects.toThrow('unknown')
    expect(f.current()).toEqual(before); expect(f.execute).not.toHaveBeenCalled(); expect(f.annotationSavingRef.current).toBe(false)
    f.importAssetFile.mockResolvedValueOnce({ ...asset(annotated), width: 641 })
    await expect(f.save(recipe(), 'replace', new AbortController().signal)).rejects.toThrow('不一致')
    expect(f.current()).toEqual(before); expect(f.execute).not.toHaveBeenCalled()
  })

  it('opens the selected second asset and does not render or upload until an explicit action', async () => {
    const f = fixture(); f.annotationSessionRef.current = null
    f.open('source')
    await vi.waitFor(() => expect(f.setAnnotationSession).toHaveBeenCalledOnce())
    expect(f.getAssetDetail).toHaveBeenCalledExactlyOnceWith(selected, expect.any(AbortSignal))
    expect(f.annotationSessionRef.current).toMatchObject({ nodeId: 'source', asset: { assetId: selected }, scope: f.session.scope })
    expect(f.renderImageAnnotation).not.toHaveBeenCalled(); expect(f.importAssetFile).not.toHaveBeenCalled()
  })

  it.each(['candidate', 'deleted', 'locked', 'project', 'running', 'wrong-asset', 'trashed'] as const)('does not open a stale or invalid source after %s', async (change) => {
    const f = fixture(), pending = deferred<CanvasAssetSummary>()
    f.annotationSessionRef.current = null; f.getAssetDetail.mockReturnValue(pending.promise)
    f.open('source')
    if (change === 'candidate') f.mutate((nodes) => nodes.map((node) => node.id === 'source' ? { ...node, data: { ...node.data, result: { ...node.data.result!, assetId: first } } } : node))
    if (change === 'deleted') f.mutate((nodes) => nodes.filter((node) => node.id !== 'source'))
    if (change === 'locked') f.mutate((nodes) => nodes.map((node) => node.id === 'source' ? { ...node, draggable: false } : node))
    if (change === 'project') f.projectEpochRef.current++
    if (change === 'running') f.activeRunsRef.current.add('run')
    pending.resolve(change === 'wrong-asset' ? asset(first) : change === 'trashed' ? { ...asset(), deletedAt: 'now' } : asset())
    await vi.waitFor(() => expect(f.annotationLoadingRef.current).toBeNull())
    expect(f.setAnnotationSession).not.toHaveBeenCalled(); expect(f.annotationSessionRef.current).toBeNull(); expect(f.execute).not.toHaveBeenCalled()
  })

  it('supersedes a pending open without letting its late details replace the next selected asset', async () => {
    const f = fixture(), firstRead = deferred<CanvasAssetSummary>(), secondRead = deferred<CanvasAssetSummary>()
    f.annotationSessionRef.current = null; f.getAssetDetail.mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(secondRead.promise)
    f.open('source'); const originalSignal = f.getAssetDetail.mock.calls[0][1]
    f.open('unrelated')
    expect(originalSignal?.aborted).toBe(true)
    secondRead.resolve(asset(first))
    await vi.waitFor(() => expect(f.setAnnotationSession).toHaveBeenCalledOnce())
    firstRead.resolve(asset())
    await Promise.resolve(); await Promise.resolve()
    expect(f.setAnnotationSession).toHaveBeenCalledOnce()
    expect(f.annotationSessionRef.current).toMatchObject({ nodeId: 'unrelated', asset: { assetId: first } })
  })
})
