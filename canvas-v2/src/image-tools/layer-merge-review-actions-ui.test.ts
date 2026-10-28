import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import * as model from './layer-editor-state'
import * as merge from './layer-editor-merge'
import type { BrowserEditorLayerMergeReview } from '../library/browser-layer-merge-review'
import type { BrowserLayerPsdDocument } from '../library/browser-layer-psd-import'
import type { CanvasImageAssetSummary } from '../host'
import type { ImageLayerRecipe } from './recipe'

const source = ts.createSourceFile('LayerEditor.tsx', readFileSync(new URL('./LayerEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!declaration) throw new Error(`Missing production function ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
interface Session {
  plan: merge.EditorLayerMergePlan; snapshot: model.LayerEditorSnapshot; sourcesKey: string; sourceOffset: number; replacementId: string; context: object; fontRevision: number
  controller: AbortController; started: boolean; accepted: boolean; review?: BrowserEditorLayerMergeReview; reviewError: string; phase: 'reviewing' | 'ready' | 'failed' | 'uploading'; placement: 'upper' | 'lower'
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function settle() { for (let index = 0; index < 5; index++) await new Promise<void>((resolve) => setImmediate(resolve)) }
function reviewFor(plan: merge.EditorLayerMergePlan, sourceIndex: number, replacementId: string, changed = 4): BrowserEditorLayerMergeReview {
  const blob = new Blob(['the exact prepared PNG'], { type: 'image/png' })
  return { output: { blob, width: plan.width, height: plan.height }, before: blob, after: blob, difference: blob, comparison: { width: 8, height: 6, totalPixels: 48, changedPixels: changed, maxChannelDelta: changed ? 70 : 0, meanChannelDelta: changed ? 3 : 0, rawChangedPixels: 9, rawMaxChannelDelta: 90 }, candidate: merge.buildEditorLayerMergeCandidate(plan, { sourceIndex, replacementId }) }
}
function fixture() {
  const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 8, outputHeight: 6, background: '#102030', explicitLayers: true, layers: Array.from({ length: 3 }, (_, index) => ({ ...model.defaultEditorImageLayer(0), name: ['Bottom', 'Unselected middle', 'Top'][index], blend: index === 2 ? 'multiply' : 'source-over', content: { kind: 'shape', shape: 'rectangle', fill: '#aabbcc', stroke: 'transparent', strokeWidth: 0 } })) }
  let state = model.createLayerEditorState(recipe, 1)
  state = model.selectEditorLayer(model.selectEditorLayer(state, state.present.ids[0]), state.present.ids[2], { toggle: true })
  const original = state, stateRef = { current: state }, sessionRef: { current: Session | null } = { current: null }, frames: FrameRequestCallback[] = []
  const read = vi.fn(async (plan: merge.EditorLayerMergePlan, sourceIndex: number, replacementId: string, _signal: AbortSignal) => reviewFor(plan, sourceIndex, replacementId))
  const sampler = { current: { mergeReviewContext: {}, reviewLayerMerge: read } }
  const asset = { assetId: 'a'.repeat(43), width: 8, height: 6, mimeType: 'image/png', mediaType: 'image', localUrl: `xingmang-asset://image/${'a'.repeat(43)}` } as CanvasImageAssetSummary
  const upload = vi.fn(async (_document: BrowserLayerPsdDocument, _signal: AbortSignal) => [asset]), commit = vi.fn(merge.commitEditorLayerMerge)
  const setMergeBusy = vi.fn(), setMergeAccepted = vi.fn(), setError = vi.fn(), setStatus = vi.fn(), importedAssetsRef = { current: [] as CanvasImageAssetSummary[] }
  const trigger = { disabled: false, isConnected: true, closest: () => null, focus: vi.fn() }
  const environment: Record<string, unknown> = { ...model, ...merge, commitEditorLayerMerge: commit, importAlive: { current: true }, penDraft: { current: null }, gradientGesture: { current: null }, paintGesture: { current: null }, cancelSampling: vi.fn(), cancelExport: vi.fn(), cancelGesture: vi.fn(), setToolMenu: vi.fn(), setSelectionAdjust: vi.fn(), stateRef, setState: (value: model.LayerEditorState) => { stateRef.current = value }, importAvailable: true, images: [{ label: 'Owned source' }], sourcesKeyRef: { current: 'owned-scope' }, mergeSessionRef: sessionRef, setMergeSession: vi.fn(), setMergeBusy, setMergeAccepted, setError, setStatus, maximumImageTransformInputs: 20, sampler, localFontRevision: 0, onApplyWithImports: vi.fn(), importedAssetsRef, setImportedAssets: vi.fn(), hostBridge: () => ({ importLayerPsd: upload }), mergeTrigger: { current: trigger }, stage: { current: null }, requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length } }
  environment.layerName = actual('layerName', {})
  environment.closeLayerMerge = actual('closeLayerMerge', environment)
  environment.currentLayerMerge = actual('currentLayerMerge', environment)
  environment.reviewLayerMerge = actual('reviewLayerMerge', environment)
  const open = actual<(placement?: 'upper' | 'lower') => void>('openLayerMerge', environment)
  const confirm = actual<(session: Session) => Promise<void>>('confirmLayerMerge', environment)
  const close = environment.closeLayerMerge as (session?: Session, focus?: boolean) => void
  return { original, stateRef, sessionRef, read, sampler, upload, commit, asset, setMergeBusy, setMergeAccepted, setError, setStatus, importedAssetsRef, environment, frames, trigger, open, confirm, close }
}

describe('actual merge review lifecycle and exact candidate commit', () => {
  it('prepares the disjoint blended selection without uploading, allocating history or replacing layers', async () => {
    const f = fixture(); f.open()
    expect(f.sessionRef.current?.phase).toBe('reviewing'); expect(f.upload).not.toHaveBeenCalled()
    await settle()
    expect(f.sessionRef.current?.phase).toBe('ready'); expect(f.sessionRef.current?.review?.comparison.changedPixels).toBe(4)
    expect(f.stateRef.current).toBe(f.original); expect(f.stateRef.current.past).toHaveLength(0); expect(f.upload).not.toHaveBeenCalled()
  })

  it('requires explicit acceptance and uploads the cached PNG once with the exact reviewed candidate', async () => {
    const f = fixture(); f.open(); await settle(); const session = f.sessionRef.current!, review = session.review!
    await f.confirm(session); expect(f.upload).not.toHaveBeenCalled()
    session.accepted = true
    await f.confirm(session); await f.confirm(session)
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.upload).toHaveBeenCalledTimes(1)
    expect(f.upload.mock.calls[0][0].layers[0].blob).toBe(review.output.blob)
    expect(f.commit.mock.calls[0][3]).toBe(review.candidate)
    expect(f.stateRef.current.past).toHaveLength(1); expect(f.stateRef.current.present.recipe).toEqual(review.candidate.recipe)
    expect(model.undoLayerEditor(f.stateRef.current).present).toEqual(f.original.present)
    expect(model.redoLayerEditor(model.undoLayerEditor(f.stateRef.current)).present.recipe).toEqual(review.candidate.recipe)
  })

  it('still requires final confirmation for zero visible difference while raw transparent RGB alone needs no consent', async () => {
    const f = fixture(); f.read.mockImplementation(async (plan, sourceIndex, replacementId) => reviewFor(plan, sourceIndex, replacementId, 0))
    f.open(); await settle(); expect(f.upload).not.toHaveBeenCalled()
    await f.confirm(f.sessionRef.current!); expect(f.upload).toHaveBeenCalledTimes(1)
  })

  it('rebuilds placement and acceptance while discarding the previous pending preview result', async () => {
    const f = fixture(), first = deferred<BrowserEditorLayerMergeReview>()
    f.read.mockImplementationOnce(() => first.promise); f.open('upper'); const old = f.sessionRef.current!
    old.accepted = true; f.open('lower'); const current = f.sessionRef.current!
    expect(old.controller.signal.aborted).toBe(true); expect(current.accepted).toBe(false); expect(current.review).toBeUndefined(); expect(current.placement).toBe('lower')
    await settle(); const prepared = current.review
    first.resolve(reviewFor(old.plan, old.sourceOffset, old.replacementId)); await settle()
    expect(f.sessionRef.current).toBe(current); expect(current.review).toBe(prepared); expect(f.upload).not.toHaveBeenCalled(); expect(f.stateRef.current).toBe(f.original)
  })

  it('cancels a pending review and never uploads its late result', async () => {
    const f = fixture(), pending = deferred<BrowserEditorLayerMergeReview>(); f.read.mockImplementation(() => pending.promise)
    f.open(); const session = f.sessionRef.current!; f.close(session, true)
    pending.resolve(reviewFor(session.plan, session.sourceOffset, session.replacementId)); await settle(); await f.confirm(session)
    expect(session.controller.signal.aborted).toBe(true); expect(f.sessionRef.current).toBeNull(); expect(f.upload).not.toHaveBeenCalled(); expect(f.stateRef.current).toBe(f.original)
  })

  it.each(['selection', 'source', 'context', 'font'] as const)('does not upload a cached review after its %s changes', async (kind) => {
    const f = fixture(); f.open(); await settle(); const session = f.sessionRef.current!; session.accepted = true
    if (kind === 'selection') f.stateRef.current = model.selectEditorLayer(f.stateRef.current, f.stateRef.current.present.ids[1])
    if (kind === 'source') (f.environment.sourcesKeyRef as { current: string }).current = 'another-account-source'
    if (kind === 'context') f.sampler.current.mergeReviewContext = {}
    if (kind === 'font') session.fontRevision++
    await f.confirm(session); expect(f.upload).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
  })

  it('invalidates the cached review immediately on a font or LUT context callback', async () => {
    const f = fixture(); f.open(); await settle(); const session = f.sessionRef.current!
    actual<(context: object) => void>('mergeReviewContextChanged', f.environment)(session.context)
    expect(f.sessionRef.current).toBe(session)
    f.sampler.current.mergeReviewContext = {}
    actual<(context: object) => void>('mergeReviewContextChanged', f.environment)(f.sampler.current.mergeReviewContext)
    expect(f.sessionRef.current).toBeNull(); expect(session.controller.signal.aborted).toBe(true); expect(f.upload).not.toHaveBeenCalled()
  })

  it('exposes a failed preview for explicit retry instead of permitting final upload', async () => {
    const f = fixture(); f.read.mockRejectedValueOnce(new Error('Preview failed'))
    f.open(); await settle(); const old = f.sessionRef.current!
    expect(old.phase).toBe('failed'); expect(old.reviewError).toBe('Preview failed'); await f.confirm(old); expect(f.upload).not.toHaveBeenCalled()
    f.open(); await settle(); expect(f.sessionRef.current?.phase).toBe('ready'); expect(f.read).toHaveBeenCalledTimes(2); expect(old.controller.signal.aborted).toBe(true)
  })

  it('does not apply a canceled in-flight upload and does not rerender the cached PNG', async () => {
    const f = fixture(), pending = deferred<CanvasImageAssetSummary[]>(); f.upload.mockImplementation(() => pending.promise)
    f.open(); await settle(); const session = f.sessionRef.current!; session.accepted = true
    const saving = f.confirm(session); f.close(session, true); pending.resolve([f.asset]); await saving
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.commit).not.toHaveBeenCalled(); expect(f.stateRef.current).toBe(f.original); expect(f.importedAssetsRef.current).toEqual([])
  })

  it('restores focus after inert removal and does not steal focus from a newly opened merge', async () => {
    const f = fixture(); f.open(); await settle(); f.close(f.sessionRef.current!, true)
    expect(f.trigger.focus).not.toHaveBeenCalled(); f.frames.shift()!(0); expect(f.trigger.focus).toHaveBeenCalledOnce()
    f.open(); await settle(); f.close(f.sessionRef.current!, true); f.open(); f.frames.shift()!(0)
    expect(f.trigger.focus).toHaveBeenCalledOnce()
  })
})
