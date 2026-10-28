import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasVideoAssetSummary } from '../host'
import { assertLayerEditorScope, layerEditorScopeToken } from '../image-tools/layer-editor-scope'
import { parseImageCollageInputOrder } from '../image-tools/collage-input-order'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { parseWorkflowFile, serializeWorkflow } from '../persistence/workflow-serializer'
import { createCanvasDocument } from '../store/canvas-state'
import { canvasNodeDocumentRecord, useCanvasDocument, type CanvasDocumentController } from '../store/use-canvas-document'
import { assertFrameSequenceSource, buildFrameSequenceGraph, captureFrameSequenceSource, type FrameSequenceSnapshot } from '../video-tools/frame-sequence'
import type { FrameEditorMetadata } from '../video-tools/frame-editor-state'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(source)
    if (name === 'closeFrameSequence' && ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'VideoFrameEditor' && node.attributes.properties.some((entry) => ts.isJsxAttribute(entry) && entry.name.getText(source) === 'onApplySequence')) {
      const attribute = node.attributes.properties.find((entry) => ts.isJsxAttribute(entry) && entry.name.getText(source) === 'onClose')
      if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) expression = attribute.initializer.expression?.getText(source) ?? ''
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function sequenceResetEffect(environment: Record<string, unknown>) {
  let effect = '', dependencies: string[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('frameSequenceLoadingRef.current?.abort()')) {
      effect = node.arguments[0].getText(source)
      const values = node.arguments[1]
      if (values && ts.isArrayLiteralExpression(values)) dependencies = values.elements.map((entry) => entry.getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!effect) throw new Error('Missing sequence reset effect')
  const run = new Function(...Object.keys(environment), ts.transpileModule(`return (${effect})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as () => () => void
  return { run, dependencies }
}
function deferred<T>() { let resolve: (value: T) => void = () => {}; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
interface Session { snapshot: FrameSequenceSnapshot; asset: CanvasVideoAssetSummary; scope: string }
function fixture() {
  let document: CanvasDocumentController | undefined, serial = 0
  function project(record: EditorNodeRecord): CanvasNode {
    if (record.type !== 'video-input' && record.type !== 'frame-extract' && record.type !== 'image-collage') throw new Error('Unexpected test node')
    return { ...record, type: record.type, ...(record.locked ? { draggable: false } : {}), data: { prompt: '', model: '', status: 'idle', ...record.data } }
  }
  function Capture() { document = useCanvasDocument(project); return null }
  renderToStaticMarkup(createElement(Capture)); if (!document) throw new Error('Missing document')
  const target = document, videoId = 'v'.repeat(43)
  target.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: [{ id: 'video', type: 'video-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { result: { kind: 'video', assetId: videoId }, dirty: false } }] } })
  const asset: CanvasVideoAssetSummary = { assetId: videoId, mediaType: 'video', mimeType: 'video/mp4', localUrl: '/video.mp4', thumbnailUrl: '', fileName: 'video.mp4', createdAt: '', taskId: 'video-task', width: 640, height: 480, durationSeconds: 2 }
  const metadata = { width: 640, height: 480, duration: 2 }, blob = new Blob(['video'], { type: 'video/mp4' })
  const host = { getAssetDetail: vi.fn().mockResolvedValue(asset), readVideoForFramePreview: vi.fn().mockResolvedValue(blob), startRun: vi.fn(), generateVideo: vi.fn(), generateImage: vi.fn() }
  const layerEditorOwnerRef = { current: { ownerId: 7, accountId: 'account-a' } }, activeProjectIdRef = { current: 'project-a' }, projectEpochRef = { current: 1 }, draftActionsEnabledRef = { current: true }, projectCanEditRef = { current: true }, projectTransitionRef = { current: false }, mediaPreparationMountedRef = { current: true }
  const activeRunsRef = { current: new Set<string>() }, startingRunsRef = { current: 0 }, pendingRunProjectionIdsRef = { current: new Set<string>() }
  const frameSequenceLoadingRef: { current: AbortController | null } = { current: null }, frameSequenceSessionRef: { current: Session | null } = { current: null }
  const setFrameSequenceSession = vi.fn(), setBanner = vi.fn(), execute = vi.fn(target.execute), reactFlow = { fitView: vi.fn().mockResolvedValue(undefined) }, animations: Array<() => void> = []
  const environment = { frameSequenceLoadingRef, frameSequenceSessionRef, layerEditorOwnerRef, activeProjectIdRef, projectEpochRef, draftActionsEnabledRef, projectCanEditRef, projectTransitionRef, mediaPreparationMountedRef, activeRunsRef, startingRunsRef, pendingRunProjectionIdsRef,
    getGraphSnapshot: target.getGraphSnapshot, hostBridge: () => host, setFrameSequenceSession, setBanner, assertLayerEditorScope, layerEditorScopeToken, captureFrameSequenceSource, assertFrameSequenceSource, buildFrameSequenceGraph, execute, setNodes: target.setNodes, reactFlow,
    nextNodeId: () => `frame-sequence-${++serial}`, window: { requestAnimationFrame: (callback: () => void) => { animations.push(callback); return animations.length } },
  }
  const open = actual<(nodeId: string) => void>('openFrameSequence', environment), close = actual<() => void>('closeFrameSequence', environment)
  const load = actual<(assetId: string, signal: AbortSignal) => Promise<Blob>>('loadFrameSequenceVideo', environment)
  function apply(values = [0, 1, 1.9], dimensions: FrameEditorMetadata = metadata, signal = new AbortController().signal) {
    return actual<(values: number[], dimensions: FrameEditorMetadata, signal: AbortSignal) => Promise<void>>('applyFrameSequence', { ...environment, frameSequenceSession: frameSequenceSessionRef.current })(values, dimensions, signal)
  }
  async function settle() { for (let count = 0; count < 10; count++) await Promise.resolve() }
  async function opened() { open('video'); await settle(); if (!frameSequenceSessionRef.current) throw new Error(`Session did not open: ${JSON.stringify(setBanner.mock.calls)}`); return frameSequenceSessionRef.current }
  function patch(value: Partial<CanvasNode>) { target.setNodes((nodes) => nodes.map((node) => node.id === 'video' ? { ...node, ...value } : node)) }
  function changeAsset() { target.setNodes((nodes) => nodes.map((node) => node.id === 'video' ? { ...node, data: { ...node.data, result: { kind: 'video', assetId: 'b'.repeat(43) } } } : node)) }
  return { ...environment, target, asset, blob, host, open, close, load, apply, settle, opened, patch, changeAsset, animations, current: target.getGraphSnapshot }
}
type Fixture = ReturnType<typeof fixture>
const changes: Array<[string, (f: Fixture) => void]> = [
  ['account', (f) => { f.layerEditorOwnerRef.current.accountId = 'account-b' }],
  ['project reopen', (f) => { f.projectEpochRef.current++ }],
  ['permission', (f) => { f.projectCanEditRef.current = false }],
  ['locked source', (f) => f.patch({ draggable: false })],
  ['source asset', (f) => f.changeAsset()],
]

describe('actual App video sequence callbacks', () => {
  it('reads the selected video, inserts one undoable graph and persists its ordinary node settings without running models', async () => {
    const f = fixture(), before = structuredClone(f.current())
    await f.opened(); await expect(f.load(f.asset.assetId, new AbortController().signal)).resolves.toBe(f.blob)
    expect(f.host.getAssetDetail).toHaveBeenCalledExactlyOnceWith(f.asset.assetId, expect.any(AbortSignal))
    await f.apply(); expect(f.execute).toHaveBeenCalledOnce()
    const created = f.current(), frames = created.nodes.filter((node) => node.type === 'frame-extract'), collage = created.nodes.find((node) => node.type === 'image-collage')!
    expect(frames.map((node) => node.data.settings?.timestampSeconds)).toEqual([0, 1, 1.9])
    expect(created.edges).toHaveLength(6); expect(f.frameSequenceSessionRef.current).toBeNull()
    expect(created.nodes.filter((node) => node.selected)).toHaveLength(4); expect(created.nodes[0].selected).toBe(false)
    const order = parseImageCollageInputOrder(collage.data.settings?.imageCollageInputOrder)
    expect(order.slots.map((slot) => created.edges.find((edge) => edge.id === slot.edgeId)?.source)).toEqual(frames.map((node) => node.id))
    const restored = parseWorkflowFile(JSON.stringify({ schemaVersion: 2, name: 'Storyboard', nodes: created.nodes.map(canvasNodeDocumentRecord).map(({ type, ...node }) => ({ ...node, kind: type })), edges: created.edges }))
    if (!restored) throw new Error('Expected ordinary persistent graph')
    expect(parseWorkflowFile(serializeWorkflow(restored))!.nodes.filter((node) => node.kind === 'frame-extract').map((node) => node.data.settings?.timestampSeconds)).toEqual([0, 1, 1.9])
    f.target.undo(); expect(f.current().nodes.map((node) => node.id)).toEqual(before.nodes.map((node) => node.id)); expect(f.current().edges).toEqual(before.edges)
    f.target.redo(); expect(f.current().nodes.map((node) => node.id)).toEqual(created.nodes.map((node) => node.id)); expect(f.current().edges).toEqual(created.edges)
    for (const callback of f.animations) callback()
    expect(f.reactFlow.fitView).toHaveBeenCalledOnce()
    expect(f.host.startRun).not.toHaveBeenCalled(); expect(f.host.generateVideo).not.toHaveBeenCalled(); expect(f.host.generateImage).not.toHaveBeenCalled()
  })
  it('cancels without edits and ignores metadata superseded by a second opening', async () => {
    const f = fixture(), pending = deferred<CanvasVideoAssetSummary>()
    f.host.getAssetDetail.mockReturnValueOnce(pending.promise)
    f.open('video'); const signal = f.host.getAssetDetail.mock.calls[0][1] as AbortSignal
    await f.opened(); const session = f.frameSequenceSessionRef.current
    expect(signal.aborted).toBe(true)
    pending.resolve(f.asset); await f.settle(); expect(f.frameSequenceSessionRef.current).toBe(session)
    f.close(); expect(f.frameSequenceSessionRef.current).toBeNull(); expect(f.execute).not.toHaveBeenCalled()
    await expect(f.apply()).rejects.toThrow('会话已关闭')
  })
  it('refuses metadata that resolves after scope, permission or source changes', async () => {
    for (const [, change] of changes) {
      const f = fixture(), pending = deferred<CanvasVideoAssetSummary>(); f.host.getAssetDetail.mockReturnValueOnce(pending.promise)
      f.open('video'); change(f); pending.resolve(f.asset); await f.settle()
      expect(f.frameSequenceSessionRef.current).toBeNull(); expect(f.setFrameSequenceSession).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
    }
  })
  it('rejects a late video read or stale apply while preserving the latest graph', async () => {
    for (const [, change] of changes) {
      const f = fixture(); await f.opened(); const pending = deferred<Blob>(); f.host.readVideoForFramePreview.mockReturnValueOnce(pending.promise)
      const read = f.load(f.asset.assetId, new AbortController().signal); change(f); const graph = structuredClone(f.current()); pending.resolve(f.blob)
      await expect(read).rejects.toThrow(); await expect(f.apply()).rejects.toThrow()
      expect(f.execute).not.toHaveBeenCalled(); expect(f.current()).toEqual(graph)
    }
  })
  it('rejects read-only or busy openings before reading assets and rejects malformed metadata receipts', async () => {
    for (const busy of ['readonly', 'running', 'starting', 'projection', 'transition', 'unmounted'] as const) {
      const f = fixture()
      if (busy === 'readonly') f.projectCanEditRef.current = false
      if (busy === 'running') f.activeRunsRef.current.add('run')
      if (busy === 'starting') f.startingRunsRef.current++
      if (busy === 'projection') f.pendingRunProjectionIdsRef.current.add('run')
      if (busy === 'transition') f.projectTransitionRef.current = true
      if (busy === 'unmounted') f.mediaPreparationMountedRef.current = false
      f.open('video'); await f.settle(); expect(f.host.getAssetDetail).not.toHaveBeenCalled(); expect(f.frameSequenceSessionRef.current).toBeNull()
    }
    const f = fixture(); f.host.getAssetDetail.mockResolvedValueOnce({ ...f.asset, assetId: 'x'.repeat(43) })
    f.open('video'); await f.settle(); expect(f.frameSequenceSessionRef.current).toBeNull(); expect(f.setBanner).toHaveBeenLastCalledWith(expect.stringContaining('不可读取'))
  })
  it('preserves the open draft when times, dimensions or cancellation prevent a valid atomic graph', async () => {
    const f = fixture(); await f.opened(); const before = structuredClone(f.current()), session = f.frameSequenceSessionRef.current
    await expect(f.apply([1, 0])).rejects.toThrow('从早到晚')
    await expect(f.apply([0, 1, 1.9], { width: 4096, height: 4096, duration: 2 })).rejects.toThrow('最多支持 2 张')
    const abort = new AbortController(); abort.abort()
    await expect(f.apply([0, 1], undefined, abort.signal)).rejects.toThrow()
    await expect(f.load('forged', new AbortController().signal)).rejects.toThrow('会话已变化')
    expect(f.frameSequenceSessionRef.current).toBe(session); expect(f.execute).not.toHaveBeenCalled(); expect(f.current()).toEqual(before)
  })
  it('does not refocus a different project when the post-insertion animation executes late', async () => {
    const f = fixture(); await f.opened(); await f.apply(); f.projectEpochRef.current++
    for (const callback of f.animations) callback()
    expect(f.reactFlow.fitView).not.toHaveBeenCalled(); expect(f.execute).toHaveBeenCalledOnce()
  })
  it('clears an existing session and aborts pending metadata when edit permission changes', async () => {
    const f = fixture(); await f.opened(); const oldSession = f.frameSequenceSessionRef.current
    const pending = deferred<CanvasVideoAssetSummary>(); f.host.getAssetDetail.mockReturnValueOnce(pending.promise); f.open('video')
    const signal = f.host.getAssetDetail.mock.calls.at(-1)![1] as AbortSignal, effect = sequenceResetEffect(f)
    expect(effect.dependencies).toEqual(expect.arrayContaining(['layerEditorScope', 'projectCanEdit']))
    f.projectCanEditRef.current = false; effect.run()
    expect(signal.aborted).toBe(true); expect(f.frameSequenceSessionRef.current).toBeNull(); expect(f.frameSequenceLoadingRef.current).toBeNull()
    expect(f.setFrameSequenceSession).toHaveBeenLastCalledWith(null)
    pending.resolve(f.asset); await f.settle(); expect(f.frameSequenceSessionRef.current).toBeNull()
    f.projectCanEditRef.current = true; effect.run(); expect(f.frameSequenceSessionRef.current).toBeNull()
    await f.opened(); expect(f.frameSequenceSessionRef.current).not.toBe(oldSession); expect(f.execute).not.toHaveBeenCalled()
  })
})
