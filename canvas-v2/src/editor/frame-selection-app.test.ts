import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasVideoAssetSummary } from '../host'
import { assertLayerEditorScope, layerEditorScopeToken } from '../image-tools/layer-editor-scope'
import type { WorkflowNodeData } from '../model'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { markNodeAndDescendantsDirty } from '../runtime/run-projection'
import { createCanvasDocument } from '../store/canvas-state'
import { canvasNodeDocumentRecord, useCanvasDocument, type CanvasDocumentController } from '../store/use-canvas-document'
import { assertFrameSelection, captureFrameSelection, type FrameSelectionSnapshot } from './frame-selection-session'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(source)
    if (name === 'closeFrameSelection' && ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'VideoFrameEditor') {
      const attribute = node.attributes.properties.find((entry) => ts.isJsxAttribute(entry) && entry.name.getText(source) === 'onClose')
      if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) expression = attribute.initializer.expression?.getText(source) ?? ''
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
interface Session { snapshot: FrameSelectionSnapshot; asset: CanvasVideoAssetSummary; scope: string }
function fixture() {
  let controller: CanvasDocumentController | undefined
  function project(record: EditorNodeRecord): CanvasNode {
    if (record.type !== 'video-input' && record.type !== 'frame-extract' && record.type !== 'image-collage') throw new Error('Unexpected test node')
    return { ...record, type: record.type, ...(record.locked ? { draggable: false } : {}), data: { prompt: '', model: '', status: 'idle', ...record.data } }
  }
  function Capture() { controller = useCanvasDocument(project); return null }
  renderToStaticMarkup(createElement(Capture)); if (!controller) throw new Error('Missing document')
  const target = controller, videoId = 'v'.repeat(43), imageId = 'i'.repeat(43)
  target.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: [
    { id: 'video', type: 'video-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { result: { kind: 'video', assetId: videoId }, dirty: false } },
    { id: 'frame', type: 'frame-extract', definitionVersion: 1, position: { x: 400, y: 0 }, data: { settings: { timestampSeconds: 1.25, title: '关键画面' }, result: { kind: 'image', assetId: imageId }, dirty: false } },
    { id: 'collage', type: 'image-collage', definitionVersion: 1, position: { x: 800, y: 0 }, data: { result: { kind: 'image', assetId: imageId }, dirty: false } },
  ], edges: [
    { id: 'video-frame', source: 'video', sourceHandle: 'out:video', target: 'frame', targetHandle: 'in:video' },
    { id: 'frame-collage', source: 'frame', sourceHandle: 'out:image', target: 'collage', targetHandle: 'in:images' },
  ] } })
  const asset: CanvasVideoAssetSummary = { assetId: videoId, mediaType: 'video', mimeType: 'video/mp4', localUrl: '/video.mp4', thumbnailUrl: '', fileName: 'video.mp4', createdAt: '', taskId: 'video-task', width: 640, height: 480, durationSeconds: 10 }
  const blob = new Blob(['video'], { type: 'video/mp4' })
  const host = { getAssetDetail: vi.fn().mockResolvedValue(asset), readVideoForFramePreview: vi.fn().mockResolvedValue(blob) }
  const layerEditorOwnerRef = { current: { ownerId: 7, accountId: 'account-a' } }, activeProjectIdRef = { current: 'project-a' }, projectEpochRef = { current: 1 }, draftActionsEnabledRef = { current: true }, projectTransitionRef = { current: false }, mediaPreparationMountedRef = { current: true }
  const activeRunsRef = { current: new Set<string>() }, startingRunsRef = { current: 0 }, pendingRunProjectionIdsRef = { current: new Set<string>() }
  const frameLoadingRef: { current: AbortController | null } = { current: null }, frameSessionRef: { current: Session | null } = { current: null }
  const setFrameSession = vi.fn(), setBanner = vi.fn(), execute = vi.fn(target.execute), setDirtyNodeIds = vi.fn()
  const graphRef = { get current() { return target.getGraphSnapshot() }, set current(_value: ReturnType<typeof target.getGraphSnapshot>) {} }
  const environment = { frameLoadingRef, frameSessionRef, layerEditorOwnerRef, activeProjectIdRef, projectEpochRef, draftActionsEnabledRef, projectTransitionRef, mediaPreparationMountedRef, activeRunsRef, startingRunsRef, pendingRunProjectionIdsRef,
    getGraphSnapshot: target.getGraphSnapshot, hostBridge: () => host, setFrameSession, setBanner, assertLayerEditorScope, layerEditorScopeToken, captureFrameSelection, assertFrameSelection, graphRef, execute, setDirtyNodeIds, canvasNodeDocumentRecord, markNodeAndDescendantsDirty,
  }
  const markDirtyFrom = actual<(nodeId: string, patch: Partial<WorkflowNodeData>, discrete: boolean) => void>('markDirtyFrom', environment)
  const open = actual<(nodeId: string) => void>('openFrameSelection', environment)
  const load = actual<(assetId: string, signal: AbortSignal) => Promise<Blob>>('loadFrameVideo', environment)
  const close = actual<() => void>('closeFrameSelection', environment)
  function apply(value: number, signal = new AbortController().signal) { return actual<(value: number, signal: AbortSignal) => Promise<void>>('applyFrameSelection', { ...environment, markDirtyFrom, frameSession: frameSessionRef.current })(value, signal) }
  async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve() }
  async function opened() { open('frame'); await settle(); if (!frameSessionRef.current) throw new Error(`Session did not open: ${JSON.stringify(setBanner.mock.calls)}`); return frameSessionRef.current }
  function patch(id: string, value: Partial<CanvasNode>) { target.setNodes((nodes) => nodes.map((node) => node.id === id ? { ...node, ...value } : node)) }
  function data(id: string, value: Partial<WorkflowNodeData>) { target.setNodes((nodes) => nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, ...value } } : node)) }
  return { ...environment, target, asset, blob, host, open, opened, load, close, apply, settle, patch, data, current: target.getGraphSnapshot }
}
type Fixture = ReturnType<typeof fixture>
function change(f: Fixture, kind: string) {
  if (kind === 'owner') f.layerEditorOwnerRef.current.ownerId++
  if (kind === 'account') f.layerEditorOwnerRef.current.accountId = 'account-b'
  if (kind === 'project') f.activeProjectIdRef.current = 'project-b'
  if (kind === 'epoch') f.projectEpochRef.current++
  if (kind === 'disabled') f.draftActionsEnabledRef.current = false
  if (kind === 'unmounted') f.mediaPreparationMountedRef.current = false
  if (kind === 'transition') f.projectTransitionRef.current = true
  if (kind === 'running') f.activeRunsRef.current.add('run')
  if (kind === 'starting') f.startingRunsRef.current++
  if (kind === 'projection') f.pendingRunProjectionIdsRef.current.add('pending')
  if (kind === 'asset') f.data('video', { result: { kind: 'video', assetId: 'b'.repeat(43) } })
  if (kind === 'edge') f.target.setEdges((edges) => edges.map((edge) => edge.id === 'video-frame' ? { ...edge, id: 'new-edge' } : edge))
  if (kind === 'time') f.data('frame', { settings: { timestampSeconds: 3 } })
  if (kind === 'deleted') f.target.setNodes((nodes) => nodes.filter((node) => node.id !== 'frame'))
  if (kind === 'locked') f.patch('frame', { draggable: false })
  if (kind === 'node-disabled') f.patch('frame', { disabled: true })
  if (kind === 'cancelled') f.close()
}
const staleCases = ['owner', 'account', 'project', 'epoch', 'disabled', 'unmounted', 'transition', 'running', 'starting', 'projection', 'asset', 'edge', 'time', 'deleted', 'locked', 'node-disabled'] as const

describe('actual App video frame selection callbacks', () => {
  it('opens the real upstream video and updates only the timestamp with one undo preserving old results', async () => {
    const f = fixture(), before = structuredClone(f.current()); await f.opened()
    expect(f.host.getAssetDetail).toHaveBeenCalledExactlyOnceWith(f.asset.assetId, expect.any(AbortSignal)); expect(f.execute).not.toHaveBeenCalled()
    expect(f.frameSessionRef.current?.snapshot).toMatchObject({ sourceAssetId: f.asset.assetId, nodeId: 'frame', timestampSeconds: 1.25 })
    const signal = new AbortController().signal
    await expect(f.load(f.asset.assetId, signal)).resolves.toBe(f.blob); expect(f.host.readVideoForFramePreview).toHaveBeenCalledWith(f.asset.assetId, signal)
    await f.apply(2.375); expect(f.execute).toHaveBeenCalledOnce(); expect(f.current().edges).toEqual(before.edges)
    expect(f.current().nodes[1].data).toMatchObject({ settings: { timestampSeconds: 2.375, title: '关键画面' }, result: before.nodes[1].data.result, dirty: true })
    expect(f.current().nodes[2].data).toMatchObject({ result: before.nodes[2].data.result, dirty: true }); expect(f.current().nodes[0].data).toEqual(before.nodes[0].data)
    expect(f.frameSessionRef.current).toBeNull(); f.target.undo(); expect(f.current()).toEqual(before)
    f.target.redo(); expect(f.current().nodes[1].data.settings?.timestampSeconds).toBe(2.375)
  })
  it('cancels without touching history and closes an unchanged selection without a redundant command', async () => {
    const f = fixture(), before = structuredClone(f.current()); await f.opened(); f.close()
    expect(f.frameSessionRef.current).toBeNull(); expect(f.current()).toEqual(before); expect(f.execute).not.toHaveBeenCalled()
    await f.opened(); await f.apply(1.25); expect(f.execute).not.toHaveBeenCalled(); expect(f.current()).toEqual(before)
    await expect(f.apply(2)).rejects.toThrow('会话已关闭')
  })
  it.each(staleCases)('rejects a stale %s session before mutating graph or history', async (kind) => {
    const f = fixture(); await f.opened(); change(f, kind); const afterChange = structuredClone(f.current())
    await expect(f.apply(2)).rejects.toThrow(); expect(f.execute).not.toHaveBeenCalled(); expect(f.current()).toEqual(afterChange)
  })
  it.each(['running', 'starting', 'projection', 'unmounted', 'transition', 'disabled', 'locked', 'node-disabled'] as const)('refuses to open while %s', async (kind) => {
    const f = fixture(); change(f, kind); f.open('frame'); await f.settle()
    expect(f.host.getAssetDetail).not.toHaveBeenCalled(); expect(f.frameSessionRef.current).toBeNull(); expect(f.execute).not.toHaveBeenCalled()
  })
  it.each(staleCases)('does not show metadata that resolves after %s changes', async (kind) => {
    const f = fixture(), pending = deferred<CanvasVideoAssetSummary>(); f.host.getAssetDetail.mockReturnValueOnce(pending.promise)
    f.open('frame'); change(f, kind); pending.resolve(f.asset); await f.settle()
    expect(f.frameSessionRef.current).toBeNull(); expect(f.setFrameSession).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  })
  it('aborts superseded metadata reads and ignores their later success', async () => {
    const f = fixture(), first = deferred<CanvasVideoAssetSummary>(); f.host.getAssetDetail.mockReturnValueOnce(first.promise)
    f.open('frame'); const signal = f.host.getAssetDetail.mock.calls[0][1] as AbortSignal
    f.open('frame'); await f.settle(); const current = f.frameSessionRef.current; expect(signal.aborted).toBe(true); expect(current).not.toBeNull()
    first.resolve(f.asset); await f.settle(); expect(f.frameSessionRef.current).toBe(current); expect(f.setFrameSession).toHaveBeenCalledOnce()
  })
  it.each(['recycled', 'wrong-asset', 'wrong-media'] as const)('rejects %s host metadata without opening the editor', async (kind) => {
    const f = fixture(); f.host.getAssetDetail.mockResolvedValueOnce({ ...f.asset, ...(kind === 'recycled' ? { deletedAt: 'now' } : kind === 'wrong-asset' ? { assetId: 'x'.repeat(43) } : { mediaType: 'image' }) })
    f.open('frame'); await f.settle(); expect(f.frameSessionRef.current).toBeNull(); expect(f.setBanner).toHaveBeenLastCalledWith(expect.stringContaining('已回收或不可读取'))
  })
  it.each([...staleCases, 'cancelled'])('rejects video bytes that finish after %s changes', async (kind) => {
    const f = fixture(); await f.opened(); const pending = deferred<Blob>(); f.host.readVideoForFramePreview.mockReturnValueOnce(pending.promise)
    const read = f.load(f.asset.assetId, new AbortController().signal); change(f, kind); pending.resolve(f.blob)
    await expect(read).rejects.toThrow(); expect(f.execute).not.toHaveBeenCalled()
  })
  it.each(['unmounted', 'transition', 'running', 'starting', 'projection', 'asset', 'edge', 'time', 'cancelled'])('rejects a %s preview before contacting the host', async (kind) => {
    const f = fixture(); await f.opened(); change(f, kind)
    await expect(Promise.resolve().then(() => f.load(f.asset.assetId, new AbortController().signal))).rejects.toThrow()
    expect(f.host.readVideoForFramePreview).not.toHaveBeenCalled()
  })
  it('rejects forged asset requests, invalid seconds and aborted reads or applies', async () => {
    const f = fixture(); await f.opened(); const controller = new AbortController()
    await expect(Promise.resolve().then(() => f.load('x'.repeat(43), controller.signal))).rejects.toThrow()
    for (const value of [NaN, Infinity, -1, 86_401]) await expect(f.apply(value)).rejects.toThrow('时间点无效')
    controller.abort(); await expect(f.apply(2, controller.signal)).rejects.toThrow()
    await expect(Promise.resolve().then(() => f.load(f.asset.assetId, controller.signal))).rejects.toThrow(); expect(f.execute).not.toHaveBeenCalled()
  })
})
