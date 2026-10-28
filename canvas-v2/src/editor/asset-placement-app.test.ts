import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { canvasNodeDisplayGeometry } from '../domain/node-display-geometry'
import type { CanvasAssetSummary } from '../host'
import { assetInputNodeKind, mediaAssetNodeDimensions, requestedClipDurationSeconds, unresolvedMediaPlacementDimensions } from '../library/media-assets'
import { completeCanvasMediaImport } from '../library/media-import-completion'
import type { NodeKind, WorkflowNode } from '../model'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { usesMediaBoundLayout } from '../nodes/media-bound'
import { createCanvasDocument } from '../store/canvas-state'
import { canvasNodeDocumentRecord, useCanvasDocument, type CanvasDocumentController } from '../store/use-canvas-document'
import { createCreatedNodeFocusCoordinator, createdNodeFocusZoom } from './node-focus'
import { findAvailableCanvasPosition } from './node-placement'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(source)
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source).replace(/^export\s+/, '')
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name && ts.isArrowFunction(node.initializer)) expression = node.initializer.getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}

function asset(index = 0, width = 640, height = 480): CanvasAssetSummary {
  const assetId = String.fromCharCode(97+index).repeat(43)
  return { assetId, mediaType: 'image', localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png', thumbnailUrl: '', fileName: `original-${index}.png`, createdAt: '2026-10-14T12:00:00.000Z', width, height }
}

function unknownAsset(index = 0): CanvasAssetSummary {
  const result = asset(index)
  Reflect.deleteProperty(result, 'width')
  Reflect.deleteProperty(result, 'height')
  return result
}

function deferred() {
  let resolve: (value: CanvasAssetSummary | null) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<CanvasAssetSummary | null>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture(initial: EditorNodeRecord[] = []) {
  const toCanvasNode = actual<(node: WorkflowNode) => CanvasNode>('toCanvasNode', { canvasNodeDisplayGeometry })
  function projectNode(record: EditorNodeRecord): CanvasNode {
    return toCanvasNode({ ...record, kind: record.type as NodeKind, data: { prompt: '', model: '', status: 'idle', ...record.data } })
  }
  let captured: CanvasDocumentController | undefined
  function Capture() { captured = useCanvasDocument(projectNode); return null }
  renderToStaticMarkup(createElement(Capture))
  if (!captured) throw new Error('Missing document controller')
  const target = captured
  target.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: initial } })
  const frames = new Map<number, () => void>()
  let sequence = 0, frameSequence = 0
  const projectEpochRef = { current: 1 }, activeProjectIdRef = { current: 'project-a' }
  const layerEditorOwnerRef = { current: { ownerId: 1, accountId: 'owner-a' } }
  const draftActionsEnabledRef = { current: true }, mediaPreparationMountedRef = { current: true }, projectTransitionRef = { current: false }
  const setCenter = vi.fn(), refreshAssets = vi.fn(), setBanner = vi.fn(), pickAsset = vi.fn(), importAssetFile = vi.fn()
  const flow = { screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }), setCenter, getViewport: () => ({ x: 0, y: 0, zoom: 1 }) }
  const createdNodeFocusRef = { current: createCreatedNodeFocusCoordinator({
    schedule: (callback) => { frames.set(++frameSequence, callback); return frameSequence }, cancel: (handle) => { frames.delete(handle) },
    scope: () => ({ projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current }),
    readNode: (id) => target.getGraphSnapshot().nodes.find((node) => node.id === id),
  }) }
  vi.stubGlobal('document', { querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }) }) })
  const environment = { nodes: [], getGraphSnapshot: target.getGraphSnapshot, setNodes: target.setNodes, execute: vi.fn(target.execute), builtinNodeRegistry, assetInputNodeKind, mediaAssetNodeDimensions, requestedClipDurationSeconds, unresolvedMediaPlacementDimensions, usesMediaBoundLayout, findAvailableCanvasPosition, nextNodeId: () => `import-${++sequence}`, toCanvasNode, canvasNodeDocumentRecord,
    mediaAssetRef: actual('mediaAssetRef', {}), currentReactFlowRef: { current: flow }, createdNodeFocusRef, createdNodeFocusZoom,
    projectEpochRef, activeProjectIdRef, layerEditorOwnerRef, draftActionsEnabledRef, mediaPreparationMountedRef, projectTransitionRef, setBanner,
    hostBridge: () => ({ pickAsset, importAssetFile }), completeCanvasMediaImport, importedAssetSummary: actual('importedAssetSummary', {}), refreshAssets, assetQuery: { offset: 20 } }
  const create = actual<(asset: CanvasAssetSummary, position?: { x: number; y: number }) => void>('createAssetNode', environment)
  const captureAssetImportScope = actual<() => { epoch: number; current(): number }>('captureAssetImportScope', environment)
  const connected = { ...environment, createAssetNode: create, captureAssetImportScope }
  return { ...environment, target, create, pickAsset, importAssetFile, setCenter, frames,
    pick: actual<() => Promise<void>>('pickAssetToCanvas', connected),
    drop: actual<(file: File, position: { x: number; y: number }) => Promise<void>>('importAssetToCanvas', connected),
    metadata: actual<(nodeId: string, assetId: string, width: number, height: number, durationSeconds?: number) => void>('onMediaMetadata', connected),
    tick() { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback()) },
  }
}

function noOverlap(nodes: readonly CanvasNode[]): boolean {
  return nodes.every((node, i) => nodes.slice(i+1).every((other) => node.position.x + (node.width ?? 0) + 28 <= other.position.x
    || other.position.x + (other.width ?? 0) + 28 <= node.position.x
    || node.position.y + (node.height ?? 0) + 28 <= other.position.y
    || other.position.y + (other.height ?? 0) + 28 <= node.position.y))
}

afterEach(() => vi.unstubAllGlobals())

describe('actual App asset insertion placement', () => {
  it('refreshes through the current-query reader after an asynchronous import instead of submitting the captured old filter', async () => {
    const f = fixture(), pending = deferred()
    f.pickAsset.mockReturnValueOnce(pending.promise)
    const request = f.pick()
    pending.resolve(asset())
    await request
    expect(f.refreshAssets).toHaveBeenCalledExactlyOnceWith()
  })
  it('uses default collision placement for five sequential picker uploads without a rerender', async () => {
    const f = fixture()
    for (const [index, size] of [[640, 480], [480, 640], [512, 512], [960, 320], [1024, 512]].entries()) {
      f.pickAsset.mockResolvedValueOnce(asset(index, size[0], size[1]))
      await f.pick()
    }
    const nodes = f.target.getGraphSnapshot().nodes
    expect(nodes).toHaveLength(5)
    expect(noOverlap(nodes)).toBe(true)
    expect(f.execute).toHaveBeenCalledTimes(5)
    expect(f.refreshAssets).toHaveBeenCalledTimes(5)
    expect(f.frames.size).toBe(1)
    const beforeUndo = structuredClone(nodes)
    f.target.undo()
    expect(f.target.getGraphSnapshot().nodes).toEqual(beforeUndo.slice(0, 4))
    f.target.redo()
    expect(f.target.getGraphSnapshot().nodes).toEqual(beforeUndo)
  })

  it('uses the latest graph when concurrent picker completions arrive in reverse order', async () => {
    const f = fixture(), first = deferred(), second = deferred(), third = deferred()
    f.pickAsset.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise)
    const requests = [f.pick(), f.pick(), f.pick()]
    third.resolve(asset(2, 96, 480)); second.resolve(asset(1, 1200, 200)); first.resolve(asset(0))
    await Promise.all(requests)
    const nodes = f.target.getGraphSnapshot().nodes
    expect(nodes.map((node) => node.data.result?.assetId)).toEqual([asset(2).assetId, asset(1).assetId, asset(0).assetId])
    expect(noOverlap(nodes)).toBe(true)
  })

  it('avoids a node moved and enlarged while upload waits without moving or rewriting it', async () => {
    const initial: EditorNodeRecord = { id: 'existing', type: 'group', definitionVersion: 1, position: { x: -2000, y: -2000 }, width: 300, height: 300, data: { prompt: '', model: '', settings: { title: 'Keep me' } } }
    const f = fixture([initial]), pending = deferred()
    f.pickAsset.mockReturnValueOnce(pending.promise)
    const request = f.pick()
    f.target.execute({ type: 'move-nodes', positions: { existing: { x: 0, y: 0 } } })
    f.target.execute({ type: 'set-node-flags', nodeIds: ['existing'], locked: true })
    f.target.setNodes((nodes) => nodes.map((node) => ({ ...node, measured: { width: 1200, height: 800 } })))
    const existing = structuredClone(f.target.getGraphSnapshot().nodes[0])
    pending.resolve(asset())
    await request
    const nodes = f.target.getGraphSnapshot().nodes
    expect(nodes[0]).toEqual(existing)
    const added = nodes[1]
    expect(added.position.x + added.width! + 28 <= 0 || added.position.x >= 1228 || added.position.y + added.height! + 28 <= 0 || added.position.y >= 828).toBe(true)
  })

  it('keeps an explicit drop coordinate even on an occupied rectangle and does not auto-focus', async () => {
    const f = fixture(), point = { x: 123.5, y: -88.25 }
    f.create(asset(0), point)
    f.importAssetFile.mockResolvedValueOnce(asset(1))
    await f.drop(new File(['synthetic'], 'test.png', { type: 'image/png' }), point)
    expect(f.target.getGraphSnapshot().nodes.map((node) => node.position)).toEqual([point, point])
    expect(f.frames.size).toBe(0)
    expect(f.setCenter).not.toHaveBeenCalled()
  })

  it('uses definition dimensions before an existing non-media node has been measured', () => {
    const f = fixture([{ id: 'unmeasured-text', type: 'text-generate', definitionVersion: 1, position: { x: 450, y: 0 }, data: { prompt: '', model: '' } }])
    expect(f.target.getGraphSnapshot().nodes[0].height).toBeUndefined()
    f.create(asset())
    const added = f.target.getGraphSnapshot().nodes[1]
    expect(added.position.x + added.width! + 28 <= 450 || added.position.x >= 798 || added.position.y + added.height! + 28 <= 0 || added.position.y >= 388).toBe(true)
  })

  it.each(['reload', 'project', 'owner', 'account', 'locked', 'unmounted', 'transition'] as const)('discards a picker completion after the %s scope changes', async (change) => {
    const f = fixture(), pending = deferred()
    f.pickAsset.mockReturnValueOnce(pending.promise)
    const request = f.pick()
    if (change === 'reload') f.projectEpochRef.current++
    if (change === 'project') f.activeProjectIdRef.current = 'project-b'
    if (change === 'owner') f.layerEditorOwnerRef.current = { ownerId: 2, accountId: 'owner-a' }
    if (change === 'account') f.layerEditorOwnerRef.current = { ownerId: 1, accountId: 'owner-b' }
    if (change === 'locked') f.draftActionsEnabledRef.current = false
    if (change === 'unmounted') f.mediaPreparationMountedRef.current = false
    if (change === 'transition') f.projectTransitionRef.current = true
    pending.resolve(asset())
    await request
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.refreshAssets).not.toHaveBeenCalled()
    expect(f.frames.size).toBe(0)
  })

  it('does not report stale upload failure over the new account notice', async () => {
    const f = fixture(), pending = deferred()
    f.pickAsset.mockReturnValueOnce(pending.promise)
    const request = f.pick()
    f.draftActionsEnabledRef.current = false
    f.setBanner('new account notice')
    pending.reject(new Error('old private upload error'))
    await request
    expect(f.setBanner).toHaveBeenCalledExactlyOnceWith('new account notice')
  })

  it('focuses only the latest insertion and drops deferred focus after project reopen', () => {
    const f = fixture()
    f.create(asset(0)); f.create(asset(1))
    f.target.setNodes((nodes) => nodes.map((node) => ({ ...node, measured: { width: node.width, height: node.height } })))
    f.tick()
    expect(f.setCenter).toHaveBeenCalledTimes(1)
    const latest = f.target.getGraphSnapshot().nodes[1]
    expect(f.setCenter.mock.calls[0].slice(0, 2)).toEqual([latest.position.x + latest.width!/2, latest.position.y + latest.height!/2])
    f.create(asset(2))
    f.projectEpochRef.current++
    f.tick()
    expect(f.setCenter).toHaveBeenCalledTimes(1)
  })

  it('undoes the latest upload once after asynchronous image loads enrich all imported metadata', async () => {
    const f = fixture()
    for (let index = 0; index < 3; index++) {
      f.pickAsset.mockResolvedValueOnce(unknownAsset(index))
      await f.pick()
    }
    expect(f.target.getGraphSnapshot().nodes).toHaveLength(3)
    await Promise.resolve()
    // All handlers use the same old render closure, as late image loads do.
    for (let index = 0; index < 3; index++) f.metadata(`import-${index + 1}`, asset(index).assetId, 512, 512)
    expect(f.execute).toHaveBeenCalledTimes(3)
    expect(f.target.getGraphSnapshot().nodes.map((node) => node.data.result?.width)).toEqual([512, 512, 512])
    f.target.undo()
    expect(f.target.getGraphSnapshot().nodes.map((node) => node.id)).toEqual(['import-1', 'import-2'])
    f.metadata('import-3', asset(2).assetId, 2048, 2048)
    expect(f.target.getGraphSnapshot().nodes).toHaveLength(2)
    f.target.redo()
    expect(f.target.getGraphSnapshot().nodes[2].data.result).toMatchObject({ width: 512, height: 512 })
  })

  it('preserves intervening rename and move undo boundaries when metadata finishes late', () => {
    const f = fixture()
    f.create(unknownAsset(0))
    const originalPosition = { ...f.target.getGraphSnapshot().nodes[0].position }
    f.target.execute({ type: 'update-node-data', nodeId: 'import-1', patch: { settings: { title: 'User rename' } } })
    f.target.execute({ type: 'move-nodes', positions: { 'import-1': { x: 1600, y: 700 } } })
    f.metadata('import-1', asset().assetId, 640, 480)
    expect(f.target.getGraphSnapshot().nodes[0]).toMatchObject({ position: { x: 1600, y: 700 }, data: { settings: { title: 'User rename' }, result: { width: 640, height: 480 } } })
    f.target.undo()
    expect(f.target.getGraphSnapshot().nodes[0]).toMatchObject({ position: originalPosition, data: { settings: { title: 'User rename' } } })
    f.target.undo()
    expect(f.target.getGraphSnapshot().nodes[0].data.settings?.title).toBeUndefined()
    f.target.undo()
    expect(f.target.getGraphSnapshot().nodes).toHaveLength(0)
    f.target.redo(); f.target.redo(); f.target.redo()
    expect(f.target.getGraphSnapshot().nodes[0]).toMatchObject({ position: { x: 1600, y: 700 }, data: { result: { width: 640, height: 480 }, settings: { title: 'User rename' } } })
  })

  it('ignores metadata for an old binding and leaves replacement itself as one undoable user edit', () => {
    const f = fixture()
    f.create(asset(0))
    const original = structuredClone(f.target.getGraphSnapshot().nodes[0])
    const replacement = { ...original.data.result!, assetId: asset(1).assetId, width: undefined, height: undefined }
    f.target.execute({ type: 'update-node-data', nodeId: 'import-1', patch: { result: replacement } })
    const before = f.target.getGraphSnapshot().nodes
    f.metadata('import-1', asset(0).assetId, 1200, 400)
    expect(f.target.getGraphSnapshot().nodes).toBe(before)
    f.metadata('import-1', asset(1).assetId, 400, 1200)
    expect(f.target.getGraphSnapshot().nodes[0].data.result).toMatchObject({ assetId: asset(1).assetId, width: 400, height: 1200 })
    f.target.undo()
    expect(f.target.getGraphSnapshot().nodes[0]).toEqual(original)
    f.target.redo()
    expect(f.target.getGraphSnapshot().nodes[0].data.result).toMatchObject({ assetId: asset(1).assetId, width: 400, height: 1200 })
  })

  it('enriches an opened project without creating an undo action or clearing a pending redo', () => {
    const seed = fixture()
    seed.create(unknownAsset(0))
    const f = fixture(seed.target.getGraphSnapshot().nodes.map(canvasNodeDocumentRecord))
    f.metadata('import-1', asset().assetId, 640, 480)
    const enriched = structuredClone(f.target.getGraphSnapshot().nodes)
    f.target.undo()
    expect(f.target.getGraphSnapshot().nodes).toEqual(enriched)
    f.target.execute({ type: 'update-node-data', nodeId: 'import-1', patch: { prompt: 'Kept draft' } })
    f.target.undo()
    f.metadata('import-1', asset().assetId, 1280, 960)
    f.target.redo()
    expect(f.target.getGraphSnapshot().nodes[0].data.prompt).toBe('Kept draft')
  })

  it('does not overwrite a newer graph or an account lock with a retained metadata callback', () => {
    const f = fixture()
    f.create(unknownAsset(0))
    f.create(unknownAsset(1))
    f.target.execute({ type: 'move-nodes', positions: { 'import-2': { x: 1700, y: 900 } } })
    f.metadata('import-1', asset().assetId, 512, 512)
    expect(f.target.getGraphSnapshot().nodes[1].position).toEqual({ x: 1700, y: 900 })
    f.draftActionsEnabledRef.current = false
    const before = f.target.getGraphSnapshot().nodes
    f.metadata('import-2', asset(1).assetId, 900, 1600)
    expect(f.target.getGraphSnapshot().nodes).toBe(before)
  })

  it('reserves room above a landscape image before an unknown uploaded portrait loads', async () => {
    const image = asset(0)
    const landscape: EditorNodeRecord = { id: 'landscape', type: 'image-input', definitionVersion: 1, position: { x: 2000, y: 620 }, width: 280, height: 210, data: { prompt: '', model: '', result: { kind: 'image', assetId: image.assetId, width: 640, height: 480 } } }
    const leftBlocker: EditorNodeRecord = { id: 'left', type: 'group', definitionVersion: 1, position: { x: 1692, y: 312 }, width: 280, height: 280, data: { prompt: '', model: '' } }
    const f = fixture([landscape, leftBlocker])
    const before = structuredClone(f.target.getGraphSnapshot().nodes)
    f.currentReactFlowRef.current.screenToFlowPosition = () => ({ x: 2140, y: 760 })
    // The previous placeholder calculation picked y=312: after loading 373px
    // tall, its lower 65px overlapped the landscape at y=620.
    expect(findAvailableCanvasPosition(before, { x: 2140, y: 760 }, { width: 280, height: 280 })).toEqual({ x: 2000, y: 312 })
    f.pickAsset.mockResolvedValueOnce(unknownAsset(1))
    await f.pick()
    const placed = f.target.getGraphSnapshot().nodes[2]
    expect(placed.width).toBe(280)
    expect(placed.height).toBe(280)
    expect(placed.data.result?.width).toBeUndefined()
    const placedPosition = { ...placed.position }
    f.metadata(placed.id, asset(1).assetId, 480, 640)
    const loaded = f.target.getGraphSnapshot().nodes
    expect(loaded[2].height).toBe(373)
    expect(loaded[2].position).toEqual(placedPosition)
    expect(loaded.slice(0, 2)).toEqual(before)
    expect(noOverlap(loaded)).toBe(true)
    f.target.undo()
    expect(f.target.getGraphSnapshot().nodes).toEqual(before)
    f.target.redo()
    expect(noOverlap(f.target.getGraphSnapshot().nodes)).toBe(true)
  })

  it('reserves existing unknown library assets despite a measured square placeholder', () => {
    const f = fixture()
    f.create(unknownAsset(0), { x: 0, y: 0 })
    f.target.setNodes((nodes) => nodes.map((node) => ({ ...node, measured: { width: 280, height: 280 } })))
    f.currentReactFlowRef.current.screenToFlowPosition = () => ({ x: 448, y: 160 })
    f.create(asset(1))
    const positions = f.target.getGraphSnapshot().nodes.map((node) => ({ ...node.position }))
    f.metadata('import-1', asset(0).assetId, 960, 320)
    const nodes = f.target.getGraphSnapshot().nodes
    expect(nodes[0]).toMatchObject({ position: { x: 0, y: 0 }, width: 420, height: 140 })
    expect(nodes.map((node) => node.position)).toEqual(positions)
    expect(noOverlap(nodes)).toBe(true)
  })

  it('keeps reverse unknown upload completions separate after portrait and panorama loads in another order', async () => {
    const f = fixture(), first = deferred(), second = deferred(), third = deferred()
    f.pickAsset.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise)
    const requests = [f.pick(), f.pick(), f.pick()]
    third.resolve(unknownAsset(2)); second.resolve(unknownAsset(1)); first.resolve(unknownAsset(0))
    await Promise.all(requests)
    const positions = f.target.getGraphSnapshot().nodes.map((node) => ({ ...node.position }))
    f.metadata('import-2', asset(1).assetId, 480, 640)
    f.metadata('import-3', asset(0).assetId, 2048, 128)
    f.metadata('import-1', asset(2).assetId, 128, 2048)
    expect(f.target.getGraphSnapshot().nodes.map((node) => node.position)).toEqual(positions)
    expect(noOverlap(f.target.getGraphSnapshot().nodes)).toBe(true)
    expect(f.execute).toHaveBeenCalledTimes(3)
    f.target.undo()
    expect(f.target.getGraphSnapshot().nodes).toHaveLength(2)
    f.target.redo()
    expect(noOverlap(f.target.getGraphSnapshot().nodes)).toBe(true)
  })

  it('keeps explicit unknown drops and subsequent user moves unchanged when native metadata arrives', async () => {
    const f = fixture(), point = { x: 123.5, y: -88.25 }
    f.importAssetFile.mockResolvedValueOnce(unknownAsset(0))
    await f.drop(new File(['synthetic'], 'portrait.png', { type: 'image/png' }), point)
    expect(f.target.getGraphSnapshot().nodes[0].position).toEqual(point)
    f.target.execute({ type: 'move-nodes', positions: { 'import-1': { x: 1700, y: 900 } } })
    f.metadata('import-1', asset().assetId, 480, 640)
    expect(f.target.getGraphSnapshot().nodes[0]).toMatchObject({ position: { x: 1700, y: 900 }, width: 280, height: 373 })
    expect(f.frames.size).toBe(0)
    f.target.undo()
    expect(f.target.getGraphSnapshot().nodes[0].position).toEqual(point)
    f.target.undo()
    expect(f.target.getGraphSnapshot().nodes).toHaveLength(0)
  })

  it('uses updated native geometry before ResizeObserver replaces the old square measurement', () => {
    const f = fixture()
    f.create(unknownAsset(0), { x: 0, y: 0 })
    f.target.setNodes((nodes) => nodes.map((node) => ({ ...node, measured: { width: 280, height: 280 } })))
    f.metadata('import-1', asset().assetId, 480, 640)
    expect(f.target.getGraphSnapshot().nodes[0]).toMatchObject({ height: 373, measured: { height: 280 } })
    f.currentReactFlowRef.current.screenToFlowPosition = () => ({ x: 140, y: 413 })
    f.create(asset(1))
    const nodes = f.target.getGraphSnapshot().nodes
    expect(nodes[0].position).toEqual({ x: 0, y: 0 })
    expect(nodes[1].position).not.toEqual({ x: 0, y: 308 })
    expect(noOverlap(nodes)).toBe(true)
  })
})
