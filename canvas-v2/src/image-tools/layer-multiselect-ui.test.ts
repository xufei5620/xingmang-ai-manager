import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as mergeModel from './layer-editor-merge'
import { LayerMergeConfirmation } from './LayerMergeConfirmation'
import { describe, expect, it, vi } from 'vitest'
import * as layerState from './layer-editor-state'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from './recipe'
import type { BrowserEditorLayerMergeReview } from '../library/browser-layer-merge-review'
import type { BrowserLayerPsdDocument } from '../library/browser-layer-psd-import'

const source = ts.createSourceFile('LayerEditor.tsx', readFileSync(new URL('./LayerEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!declaration) throw new Error(`Missing LayerEditor function ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function fixture() {
  const recipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe
  let initial = layerState.createLayerEditorState(recipe, 3)
  initial = layerState.patchEditorLayer(initial, initial.present.ids[0], { name: 'A' })
  initial = layerState.patchEditorLayer(initial, initial.present.ids[1], { name: 'B' })
  initial = layerState.patchEditorLayer(initial, initial.present.ids[2], { name: 'C' })
  const stateRef: { current: layerState.LayerEditorState } = { current: { ...initial, past: [], future: [] } }, stage = { current: { focus: vi.fn() } }
  const environment: Record<string, unknown> = { ...layerState, stateRef, stage, maximumImageTransformInputs: 20, cancelGesture: vi.fn(), cancelSampling: vi.fn(), cancelExport: vi.fn(), cancelVectorTools: vi.fn(), closeLayerMerge: vi.fn(), setToolMenu: vi.fn(), setSelectionAdjust: vi.fn(), setError: vi.fn(), setStatus: vi.fn(), change: (action: (state: layerState.LayerEditorState) => layerState.LayerEditorState) => { stateRef.current = action(stateRef.current) } }
  return { stateRef, environment, stage }
}

describe('actual LayerEditor multi-selection actions', () => {
  it('selects, toggles and range-selects layers without creating document history', () => {
    const f = fixture(), select = actual<(id: string | null, modifiers?: { toggle?: boolean; range?: boolean }) => void>('selectLayer', f.environment), ids = f.stateRef.current.present.ids
    select(ids[0]); select(ids[1], { toggle: true }); select(ids[2], { range: true })
    expect(f.stateRef.current.present.selectedId).toBe(ids[2])
    expect(layerState.selectedEditorLayerIds(f.stateRef.current.present)).toEqual([ids[1], ids[2]])
    expect(f.stateRef.current.past).toHaveLength(0)
    expect(f.environment.cancelGesture).toHaveBeenCalled()
  })
  it('copies the whole selected set in one reversible edit and preserves unselected layers', () => {
    const f = fixture(), ids = f.stateRef.current.present.ids
    const select = actual<(id: string | null, modifiers?: { toggle?: boolean }) => void>('selectLayer', f.environment)
    select(ids[0]); select(ids[1], { toggle: true })
    const before = f.stateRef.current
    actual<(action: string) => void>('performLayerBatch', f.environment)('duplicate')
    expect(f.stateRef.current.present.recipe.layers).toHaveLength(5)
    expect(f.stateRef.current.past).toHaveLength(1)
    expect(f.stateRef.current.present.recipe.layers.find((layer) => layer.name === 'C')).toEqual(before.present.recipe.layers[2])
    expect(layerState.undoLayerEditor(f.stateRef.current).present.recipe).toEqual(before.present.recipe)
  })
  it('moves the selected block from its drag snapshot without compounding displacement or histories', () => {
    const f = fixture(), ids = f.stateRef.current.present.ids
    f.stateRef.current = layerState.selectEditorLayer(f.stateRef.current, ids[0])
    f.stateRef.current = layerState.selectEditorLayer(f.stateRef.current, ids[1], { toggle: true })
    const before = f.stateRef.current, snapshot = layerState.beginLayerEditorTransaction(before)
    const gesture = { current: { pointerId: 17, id: ids[1], layer: before.present.recipe.layers[1], x: 0, y: 0, width: 1024, height: 1024, output: { outputWidth: 1024, outputHeight: 1024 }, snapshot, selectedIds: ids.slice(0, 2) } }
    const environment = { ...f.environment, gesture, quickGesture: { current: null }, gradientGesture: { current: null }, penGesture: { current: null }, paintGesture: { current: null }, selectionGesture: { current: null }, isLayerGesturePointer: (start: { pointerId: number } | null, id: number) => start?.pointerId === id, setState: (state: layerState.LayerEditorState) => { f.stateRef.current = state } }
    const move = actual<(event: unknown) => void>('pointerMove', environment)
    move({ pointerId: 17, clientX: 10, clientY: 20, preventDefault: vi.fn(), stopPropagation: vi.fn() })
    move({ pointerId: 17, clientX: 30, clientY: 40, preventDefault: vi.fn(), stopPropagation: vi.fn() })
    f.stateRef.current = layerState.finishLayerEditorTransaction(f.stateRef.current)
    expect(f.stateRef.current.past).toHaveLength(1)
    for (const index of [0, 1]) expect(f.stateRef.current.present.recipe.layers[index]).toMatchObject({ x: 30 / 1024, y: 40 / 1024 })
    expect(f.stateRef.current.present.recipe.layers[2]).toBe(before.present.recipe.layers[2])
    expect(layerState.undoLayerEditor(f.stateRef.current).present.recipe).toEqual(before.present.recipe)
  })
  it('owns keyboard bubbling before composition and editable-target exits', () => {
    const f = fixture(), event = { key: 'Process', keyCode: 229, nativeEvent: { isComposing: true }, stopPropagation: vi.fn() }
    actual<(event: unknown) => void>('keyboard', f.environment)(event)
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(f.stateRef.current.past).toHaveLength(0)
  })
})

interface TestMergeSession {
  plan: mergeModel.EditorLayerMergePlan
  snapshot: layerState.LayerEditorSnapshot
  sourcesKey: string
  sourceOffset: number
  names: string[]
  controller: AbortController
  started: boolean
  context: object
  fontRevision: number
  replacementId: string
  placement: 'upper' | 'lower'
  review?: BrowserEditorLayerMergeReview
  reviewError: string
  accepted: boolean
  phase: 'reviewing' | 'ready' | 'failed' | 'uploading'
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
async function settleReview() { for (let index = 0; index < 4; index++) await new Promise<void>((resolve) => setImmediate(resolve)) }
function mergeFixture() {
  const f = fixture(), ids = f.stateRef.current.present.ids
  f.stateRef.current = layerState.selectEditorLayer(f.stateRef.current, ids[0])
  f.stateRef.current = layerState.selectEditorLayer(f.stateRef.current, ids[1], { toggle: true })
  const mergeSessionRef: { current: TestMergeSession | null } = { current: null }, sourcesKeyRef = { current: 'source-a' }, importAlive = { current: true }
  const importedAssetsRef: { current: Array<{ assetId: string }> } = { current: [] }, mergeTrigger = { current: { disabled: false, isConnected: true, closest: () => null, focus: vi.fn() } }, frames: FrameRequestCallback[] = []
  const rendered = { blob: new Blob(['unit-png'], { type: 'image/png' }), width: 1024, height: 1024 }
  const asset = { assetId: 'a'.repeat(43), mediaType: 'image', mimeType: 'image/png', localUrl: `xingmang-asset://image/${'a'.repeat(43)}`, width: 1024, height: 1024 }
  function prepared(plan: mergeModel.EditorLayerMergePlan, sourceIndex: number, replacementId: string): BrowserEditorLayerMergeReview {
    return { output: rendered, before: rendered.blob, after: rendered.blob, difference: rendered.blob, comparison: { width: 1024, height: 1024, totalPixels: 1024 * 1024, changedPixels: 0, maxChannelDelta: 0, meanChannelDelta: 0, rawChangedPixels: 0, rawMaxChannelDelta: 0 }, candidate: mergeModel.buildEditorLayerMergeCandidate(plan, { sourceIndex, replacementId }) }
  }
  const mergeLayers = vi.fn(async () => rendered), reviewLayerMerge = vi.fn(async (plan: mergeModel.EditorLayerMergePlan, sourceIndex: number, replacementId: string, _signal: AbortSignal) => prepared(plan, sourceIndex, replacementId)), upload = vi.fn(async (_document: BrowserLayerPsdDocument, _signal: AbortSignal) => [asset])
  const sampler = { current: { mergeLayers, reviewLayerMerge, mergeReviewContext: {} } }, commit = vi.fn(mergeModel.commitEditorLayerMerge)
  const environment: Record<string, unknown> = { ...f.environment, ...mergeModel, commitEditorLayerMerge: commit, mergeSessionRef, sourcesKeyRef, importAlive, importedAssetsRef, mergeTrigger, importAvailable: true, images: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], sampler, localFontRevision: 0, penDraft: { current: null }, gradientGesture: { current: null }, paintGesture: { current: null }, setMergeSession: vi.fn(), setMergeBusy: vi.fn(), setMergeAccepted: vi.fn(), setImportedAssets: vi.fn(), requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length }, onApplyWithImports: vi.fn(), hostBridge: () => ({ importLayerPsd: upload }), setState: (state: layerState.LayerEditorState | ((current: layerState.LayerEditorState) => layerState.LayerEditorState)) => { f.stateRef.current = typeof state === 'function' ? state(f.stateRef.current) : state }, layerName: actual('layerName', {}) }
  environment.closeLayerMerge = actual('closeLayerMerge', environment)
  environment.currentLayerMerge = actual('currentLayerMerge', environment)
  environment.reviewLayerMerge = actual('reviewLayerMerge', environment)
  const openActual = actual<() => void>('openLayerMerge', environment), close = environment.closeLayerMerge as (session?: TestMergeSession, focus?: boolean) => void
  function open() { openActual(); expect(mergeSessionRef.current).not.toBeNull(); expect(mergeSessionRef.current?.phase).toBe('reviewing') }
  async function ready() { await settleReview(); const session = mergeSessionRef.current; expect(session?.phase).toBe('ready'); expect(session?.review?.candidate.replacementId).toBe(session?.replacementId); return session! }
  const confirm = actual<(session: TestMergeSession) => Promise<void>>('confirmLayerMerge', environment)
  return { ...f, environment, mergeSessionRef, sourcesKeyRef, importAlive, importedAssetsRef, mergeTrigger, mergeLayers, reviewLayerMerge, prepared, upload, commit, rendered, asset, frames, sampler, open, ready, close, confirm }
}

describe('actual LayerEditor merge confirmation and delayed results', () => {
  it('renders explicit rasterization and material-saving disclosure before confirmation', () => {
    const html = renderToStaticMarkup(createElement(LayerMergeConfirmation, { names: ['文字 A', '图片 B'], busy: true, uploading: true, onConfirm: vi.fn(), onCancel: vi.fn() }))
    expect(html).toContain('栅格化为一张透明 PNG')
    expect(html).toContain('无法分别编辑')
    expect(html).toContain('一次撤销')
    expect(html).toContain('本人素材库')
    expect(html).toContain('正在保存已核对的同一张 PNG…')
    expect(html).toContain('disabled=""')
    expect(html).toContain('取消合并')
  })
  it('opens and cancels without uploads or undo history and returns focus', () => {
    const f = mergeFixture(), before = f.stateRef.current
    f.open(); expect(f.mergeSessionRef.current?.names).toEqual(['A', 'B'])
    f.close(f.mergeSessionRef.current!, true)
    expect(f.stateRef.current.present).toBe(before.present)
    expect(f.stateRef.current.past).toHaveLength(0)
    expect(f.reviewLayerMerge).toHaveBeenCalledOnce(); expect(f.mergeLayers).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled()
    expect(f.mergeTrigger.current.focus).not.toHaveBeenCalled()
    f.frames.shift()!(0)
    expect(f.mergeTrigger.current.focus).toHaveBeenCalledOnce()
  })
  it('saves one confirmed image and replaces only selected layers with one undo boundary', async () => {
    const f = mergeFixture(), before = f.stateRef.current, remaining = before.present.recipe.layers[2]
    f.open(); const session = await f.ready(), reviewed = session.review!
    await f.confirm(session)
    expect(f.upload).toHaveBeenCalledOnce()
    expect(f.upload.mock.calls[0][0].layers[0].blob).toBe(reviewed.output.blob)
    expect(f.commit.mock.calls[0][3]).toBe(reviewed.candidate)
    expect(f.reviewLayerMerge).toHaveBeenCalledOnce(); expect(f.mergeLayers).not.toHaveBeenCalled()
    expect(f.stateRef.current.present.recipe.layers).toHaveLength(2)
    expect(f.stateRef.current.present.recipe.layers[1]).toBe(remaining)
    expect(f.stateRef.current.past).toHaveLength(1)
    expect(f.importedAssetsRef.current).toEqual([f.asset])
    expect(layerState.undoLayerEditor(f.stateRef.current).present.recipe).toEqual(before.present.recipe)
    await f.confirm(session); expect(f.upload).toHaveBeenCalledOnce()
  })
  it('rejects selected-layer changes before confirmation without rerendering or uploading', async () => {
    const f = mergeFixture(); f.open(); const session = f.mergeSessionRef.current!
    f.stateRef.current = layerState.selectEditorLayer(f.stateRef.current, f.stateRef.current.present.ids[2])
    await f.confirm(session)
    await settleReview()
    expect(f.reviewLayerMerge).toHaveBeenCalledOnce(); expect(f.mergeLayers).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled()
    expect(f.stateRef.current.past).toHaveLength(0)
  })
  it.each(['source', 'selection', 'unmounted'] as const)('ignores late review raster completion after %s changes', async (scope) => {
    const f = mergeFixture(), pending = deferred<BrowserEditorLayerMergeReview>()
    f.reviewLayerMerge.mockImplementation(() => pending.promise)
    f.open(); const session = f.mergeSessionRef.current!
    if (scope === 'source') f.sourcesKeyRef.current = 'source-b'
    if (scope === 'selection') f.stateRef.current = layerState.selectEditorLayer(f.stateRef.current, f.stateRef.current.present.ids[2])
    if (scope === 'unmounted') f.importAlive.current = false
    pending.resolve(f.prepared(session.plan, session.sourceOffset, session.replacementId)); await settleReview(); await f.confirm(session)
    expect(session.review).toBeUndefined(); expect(f.reviewLayerMerge).toHaveBeenCalledOnce()
    expect(f.upload).not.toHaveBeenCalled(); expect(f.importedAssetsRef.current).toEqual([])
    expect(f.stateRef.current.past).toHaveLength(0)
  })
  it('does not apply a successful but cancelled upload or submit a concurrent confirmation twice', async () => {
    const f = mergeFixture(), pending = deferred<typeof f.asset[]>()
    f.upload.mockImplementation(() => pending.promise)
    f.open(); const session = await f.ready(), result = f.confirm(session)
    await Promise.resolve(); await Promise.resolve()
    expect(f.upload).toHaveBeenCalledOnce()
    await f.confirm(session); expect(f.upload).toHaveBeenCalledOnce()
    f.close(session); expect(session.controller.signal.aborted).toBe(true)
    pending.resolve([f.asset]); await result
    expect(f.importedAssetsRef.current).toEqual([]); expect(f.stateRef.current.past).toHaveLength(0)
  })
  it('does not let an old cancel callback dismiss a newly opened confirmation', () => {
    const f = mergeFixture(); f.open(); const first = f.mergeSessionRef.current!
    f.close(first); f.open(); const second = f.mergeSessionRef.current
    f.close(first); expect(f.mergeSessionRef.current).toBe(second)
  })
  it.each(['openColorGrade', 'openWholeFilter', 'openLiquify', 'openPsdImport'])('cancels the original confirmation synchronously when %s opens', (name) => {
    const f = mergeFixture(); f.open(); const session = f.mergeSessionRef.current!, before = f.stateRef.current.present
    const environment = { ...f.environment, colorGradeSessionRef: { current: null }, wholeFilterSessionRef: { current: null }, liquifySessionRef: { current: null }, setColorGradeSession: vi.fn(), setWholeFilterSession: vi.fn(), setLiquifySession: vi.fn(), setPsdImportOpen: vi.fn(), layerWholeFilterSpace: vi.fn(), layerLiquifySpace: vi.fn() }
    actual<() => void>(name, environment)()
    expect(session.controller.signal.aborted).toBe(true)
    expect(f.mergeSessionRef.current).toBeNull()
    expect(f.stateRef.current.present).toBe(before); expect(f.stateRef.current.past).toHaveLength(0)
    expect(f.upload).not.toHaveBeenCalled()
  })
  it('cancels waiting merge work before an outer apply can dispatch or fail another editor guard', () => {
    const f = mergeFixture(); f.open(); const session = f.mergeSessionRef.current!, before = f.stateRef.current.present
    actual<() => void>('apply', { ...f.environment, cropSessionRef: { current: {} } })()
    expect(session.controller.signal.aborted).toBe(true); expect(f.mergeSessionRef.current).toBeNull()
    expect(f.stateRef.current.present).toBe(before); expect(f.upload).not.toHaveBeenCalled()
  })
  it('rejects wrong saved-image dimensions without replacing original layers', async () => {
    const f = mergeFixture(), before = f.stateRef.current
    f.upload.mockResolvedValue([{ ...f.asset, width: 1 }])
    f.open(); await f.confirm(await f.ready())
    expect(f.stateRef.current.present).toBe(before.present); expect(f.importedAssetsRef.current).toEqual([])
    expect(f.environment.setError).toHaveBeenCalledWith(expect.stringContaining('回执不一致'))
  })
})
