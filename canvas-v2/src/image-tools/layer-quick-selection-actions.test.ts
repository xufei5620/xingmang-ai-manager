import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { canvasRasterSelectionCount, combineCanvasSelections, isCurrentLayerPixelRequest, layerSelectionCombination, type LayerPixelRequest } from './layer-canvas-selection'
import { createLayerEditorState, defaultEditorImageLayer, finishLayerEditorTransaction, undoLayerEditor, redoLayerEditor, type LayerEditorState } from './layer-editor-state'
import { isLayerGesturePointer, type LayerCanvasSelection, type LayerCanvasTool, type LayerColorSampleRequest } from './layer-paint-state'
import { appendLayerQuickPoint, appendLayerQuickStroke, clampLayerQuickPoint, layerQuickPixelsCurrent, layerQuickRegion, layerQuickSessionCurrent, type LayerQuickPixels, type LayerQuickSelectionGuide, type LayerQuickSelectionMode, type LayerQuickSelectionSession } from './layer-quick-selection-state'
import { updateEditorCanvasSelection } from './layer-selection-history'
import type { LayerGrabCutInput } from './layer-grabcut-selection'
import type { LayerGrabCutOptions } from './layer-grabcut-client'
import type { LayerPreviewSampler } from './layerpreview'
import type { ImageLayerRecipe } from './recipe'
import type { LayerRasterSelection } from './layer-raster-selection'

const source = ts.createSourceFile('LayerEditor.tsx', readFileSync(new URL('./LayerEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  environment = { cropSessionRef: { current: null }, ...environment }
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!declaration) throw new Error(`Missing actual handler ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
interface QuickGesture extends LayerQuickSelectionGuide { pointerId: number; request: LayerPixelRequest; source: 'current' | 'composite'; sampler: LayerPreviewSampler; session?: LayerQuickSelectionSession; combination: 'replace' | 'add' | 'subtract' | 'intersect' }
function fixture(mode: LayerQuickSelectionMode = 'region') {
  const recipe: ImageLayerRecipe = { kind: 'layer', explicitLayers: true, outputWidth: 32, outputHeight: 24, background: 'transparent', layers: [defaultEditorImageLayer(0)] }
  const stateRef = { current: createLayerEditorState(recipe, 1) }, sourcesKeyRef = { current: 'source-1' }, selectionRef = { current: null as LayerCanvasSelection | null }, toolRef = { current: 'select-quick' as LayerCanvasTool }
  const quickPixels = { current: null as LayerQuickPixels | null }, quickSessions = { current: new WeakMap<LayerCanvasSelection, LayerQuickSelectionSession>() }, quickGesture = { current: null as QuickGesture | null }, quickSourceRef = { current: 'composite' as 'composite' | 'current' }, sampling = { current: null as LayerColorSampleRequest | null }
  const sampled = { width: 32, height: 24, data: new Uint8ClampedArray(32 * 24 * 4) }
  const sampler = { current: { samplePixels: vi.fn(async () => sampled), sampleColor: vi.fn(async () => '#000000') } }
  const runLayerGrabCutSelection = vi.fn(async (_input: LayerGrabCutInput, _options: LayerGrabCutOptions): Promise<LayerRasterSelection> => ({ width: 32, height: 24, runs: [67, 10, 99, 10] }))
  const environment = {
    stateRef, sourcesKeyRef, selectionRef, toolRef, quickPixels, quickSessions, quickGesture, quickSourceRef, sampling, sampler, runLayerGrabCutSelection,
    setReactState: vi.fn(), setQuickGuide: vi.fn(), setQuickMode: vi.fn(), setPicking: vi.fn(), setError: vi.fn(), setStatus: vi.fn(), cancelExport: vi.fn(), stage: { current: { focus: vi.fn() } },
    appendLayerQuickPoint, appendLayerQuickStroke, clampLayerQuickPoint, layerQuickPixelsCurrent, layerQuickRegion, layerQuickSessionCurrent, updateEditorCanvasSelection, isCurrentLayerPixelRequest, isLayerGesturePointer, layerSelectionCombination, canvasRasterSelectionCount, combineCanvasSelections, finishLayerEditorTransaction,
    quickMode: mode, quickDiameter: 8, combination: 'replace', tool: 'select-quick',
    paintGesture: { current: null }, selectionGesture: { current: null }, gesture: { current: null }, gradientGesture: { current: null }, penGesture: { current: null },
    pointAt: (x: number, y: number) => ({ x, y }), cancelPaint: vi.fn(), cancelSelection: vi.fn(), cancelVectorTools: vi.fn(),
  }
  const setState = actual<(next: LayerEditorState | ((state: LayerEditorState) => LayerEditorState)) => void>('setState', environment)
  const setSelection = actual<(next: LayerCanvasSelection | null, remember?: boolean, recordEqual?: boolean) => void>('setSelection', { ...environment, setState })
  const cancelQuickGesture = actual<() => void>('cancelQuickGesture', environment)
  const cancelSampling = actual<() => void>('cancelSampling', { ...environment, cancelQuickGesture })
  const all = { ...environment, setState, setSelection, cancelQuickGesture, cancelSampling }
  const begin = (point = { x: 1, y: 1 }, mode: LayerQuickSelectionMode = environment.quickMode, modifiers = { shiftKey: false, altKey: false }) => actual<(point: { x: number; y: number }, id: number, modifiers: { shiftKey: boolean; altKey: boolean }) => void>('beginQuickSelection', { ...all, quickMode: mode })(point, 1, modifiers)
  const move = actual<(point: { x: number; y: number }, force?: boolean) => void>('moveQuickSelection', all)
  const complete = actual<(active: QuickGesture) => Promise<void>>('completeQuickSelection', all)
  async function release() { const gesture = quickGesture.current; quickGesture.current = null; if (gesture) await complete(gesture) }
  return { ...all, begin, move, complete, release, sampled }
}
function pointer(x: number, y: number, pointerId = 1) { return { button: 0, clientX: x, clientY: y, pointerId, preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: { setPointerCapture: vi.fn() } } }

describe('actual quick selection handlers', () => {
  it('samples once per frozen source and commits each full correction as one history entry', async () => {
    const f = fixture(), original = f.stateRef.current.present.recipe
    f.begin(); f.move({ x: 30, y: 22 })
    expect(f.sampler.current.samplePixels).not.toHaveBeenCalled()
    expect(f.stateRef.current.past).toHaveLength(0)
    await f.release()
    const firstSelection = f.selectionRef.current!, firstSession = f.quickSessions.current.get(firstSelection)!
    expect(f.stateRef.current.past).toHaveLength(1)
    expect(firstSession.region).toEqual({ x: 1, y: 1, width: 29, height: 21 })
    f.begin({ x: 8, y: 8 }, 'foreground'); f.move({ x: 16, y: 8 }); await f.release()
    const second = f.selectionRef.current!, secondSession = f.quickSessions.current.get(second)!
    f.begin({ x: 10, y: 12 }, 'background'); f.move({ x: 18, y: 12 }); await f.release()
    expect(f.sampler.current.samplePixels).toHaveBeenCalledTimes(1)
    expect(f.runLayerGrabCutSelection).toHaveBeenCalledTimes(3)
    expect(f.runLayerGrabCutSelection.mock.calls[2][0]).toMatchObject({ data: f.sampled.data, region: firstSession.region, strokes: [{ mode: 'foreground', diameter: 8, points: [{ x: 8, y: 8 }, { x: 16, y: 8 }] }, { mode: 'background', diameter: 8, points: [{ x: 10, y: 12 }, { x: 18, y: 12 }] }] })
    expect(f.stateRef.current.past).toHaveLength(3)
    expect(f.stateRef.current.present.recipe).toBe(original)
    f.setState(undoLayerEditor)
    expect(f.selectionRef.current).toBe(second)
    expect(f.quickSessions.current.get(f.selectionRef.current!)).toBe(secondSession)
    f.setState(undoLayerEditor)
    expect(f.quickSessions.current.get(f.selectionRef.current!)).toBe(firstSession)
    f.setState(redoLayerEditor)
    expect(f.quickSessions.current.get(f.selectionRef.current!)).toBe(secondSession)
  })

  it('routes pointer release exactly once and does not cancel the submitted job on lost capture', async () => {
    const f = fixture(), jobs: Promise<void>[] = []
    const beginQuickSelection = actual<(point: { x: number; y: number }, pointerId: number, modifiers: { shiftKey: boolean; altKey: boolean }) => void>('beginQuickSelection', f)
    const completeQuickSelection = vi.fn((active: QuickGesture) => { const job = f.complete(active); jobs.push(job); return job })
    const environment = { ...f, beginQuickSelection, moveQuickSelection: f.move, completeQuickSelection }
    const down = actual<(event: unknown) => void>('pointerDown', environment), move = actual<(event: unknown) => void>('pointerMove', environment), up = actual<(event: unknown) => void>('pointerUp', environment), cancel = actual<(event: unknown) => void>('cancelGesture', environment)
    down(pointer(1, 1)); move(pointer(22, 20)); up(pointer(25, 22, 2))
    expect(completeQuickSelection).not.toHaveBeenCalled()
    up(pointer(25, 22)); cancel(pointer(25, 22)); up(pointer(25, 22))
    await Promise.all(jobs)
    expect(completeQuickSelection).toHaveBeenCalledTimes(1)
    expect(f.runLayerGrabCutSelection.mock.calls[0][0].region).toEqual({ x: 1, y: 1, width: 24, height: 21 })
    expect(f.runLayerGrabCutSelection.mock.calls[0][1].signal?.aborted).toBe(false)
    expect(f.stateRef.current.past).toHaveLength(1)
  })

  it('uses the frozen original selection when repeated subtraction corrections recalculate', async () => {
    const f = fixture()
    f.setSelection({ kind: 'rectangle', x: 0, y: 0, width: 1, height: 1, inverted: false }, true)
    const base = f.selectionRef.current
    f.begin({ x: 1, y: 1 }, 'region', { shiftKey: false, altKey: true }); f.move({ x: 30, y: 22 }); await f.release()
    const first = f.selectionRef.current!
    f.begin({ x: 8, y: 8 }, 'foreground'); f.move({ x: 16, y: 8 }); await f.release()
    expect(f.selectionRef.current).toEqual(first)
    expect(f.quickSessions.current.get(f.selectionRef.current!)?.baseSelection).toBe(base)
    expect(f.quickSessions.current.get(f.selectionRef.current!)?.combination).toBe('subtract')
  })

  it.each(['recipe', 'layer', 'source', 'sampleSource', 'selection', 'tool', 'cancel', 'unmount'] as const)('discards late segmentation after %s changes', async (change) => {
    const f = fixture(), pending = deferred<LayerRasterSelection>()
    f.runLayerGrabCutSelection.mockImplementationOnce(() => pending.promise)
    f.begin(); f.move({ x: 30, y: 22 })
    const running = f.release()
    await vi.waitFor(() => expect(f.runLayerGrabCutSelection).toHaveBeenCalledOnce())
    const before = f.stateRef.current
    if (change === 'recipe') f.setState({ ...before, present: { ...before.present, recipe: structuredClone(before.present.recipe) } })
    if (change === 'layer') f.setState({ ...before, present: { ...before.present, selectedId: null } })
    if (change === 'source') f.sourcesKeyRef.current = 'source-2'
    if (change === 'sampleSource') f.quickSourceRef.current = 'current'
    if (change === 'selection') f.setSelection({ kind: 'rectangle', x: 0, y: 0, width: 0.5, height: 0.5, inverted: false })
    if (change === 'tool') f.toolRef.current = 'brush'
    if (change === 'cancel') f.cancelSampling()
    if (change === 'unmount') { f.sampling.current?.controller.abort(); f.sampling.current = null }
    const retained = f.selectionRef.current
    pending.resolve({ width: 32, height: 24, runs: [67, 10] }); await running
    expect(f.selectionRef.current).toBe(retained)
    expect(f.stateRef.current.past).toHaveLength(0)
    expect(f.setStatus).not.toHaveBeenCalledWith(expect.stringContaining('已完成前景分割'))
  })

  it('does not run the worker if a slow pixel sample belongs to a replaced asset', async () => {
    const f = fixture(), pending = deferred<typeof f.sampled>()
    f.sampler.current.samplePixels.mockImplementationOnce(() => pending.promise)
    f.begin(); f.move({ x: 30, y: 22 }); const running = f.release()
    f.sourcesKeyRef.current = 'changed'
    pending.resolve(f.sampled); await running
    expect(f.runLayerGrabCutSelection).not.toHaveBeenCalled()
    expect(f.quickPixels.current).toBeNull()
    expect(f.stateRef.current.past).toHaveLength(0)
  })

  it('retains a previous selection through pointer cancellation and ignores other pointers', () => {
    const f = fixture()
    const selected: LayerCanvasSelection = { kind: 'rectangle', x: 0.1, y: 0.1, width: 0.5, height: 0.5, inverted: false }
    f.setSelection(selected, true)
    const down = actual<(event: unknown) => void>('pointerDown', { ...f, beginQuickSelection: actual('beginQuickSelection', f) })
    const move = actual<(event: unknown) => void>('pointerMove', { ...f, moveQuickSelection: f.move })
    const cancel = actual<(event: unknown) => void>('cancelGesture', f)
    down(pointer(2, 2)); move(pointer(20, 20, 2))
    expect(f.quickGesture.current?.end).toEqual({ x: 2, y: 2 })
    cancel(pointer(20, 20, 2)); expect(f.quickGesture.current).not.toBeNull()
    move(pointer(20, 20)); cancel(pointer(20, 20))
    expect(f.quickGesture.current).toBeNull()
    expect(f.selectionRef.current).toBe(selected)
    expect(f.stateRef.current.past).toHaveLength(1)
    expect(f.runLayerGrabCutSelection).not.toHaveBeenCalled()
  })

  it('validates size before sampling and reports failure without modifying previous masks', async () => {
    const f = fixture(), original = f.stateRef.current
    f.begin(); f.move({ x: 2, y: 2 }); await f.release()
    expect(f.sampler.current.samplePixels).not.toHaveBeenCalled()
    expect(f.setError).toHaveBeenLastCalledWith(expect.stringContaining('3 × 3'))
    f.runLayerGrabCutSelection.mockRejectedValueOnce(new Error('前景分割超过时间限制'))
    f.begin(); f.move({ x: 30, y: 22 }); await f.release()
    expect(f.stateRef.current).toBe(original)
    expect(f.setError).toHaveBeenLastCalledWith('前景分割超过时间限制')
    expect(f.sampling.current).toBeNull()
    expect(f.setPicking).toHaveBeenLastCalledWith(false)
  })

  it('requires a current completed session for correction and rejects out-of-region starts', async () => {
    const f = fixture('foreground')
    f.begin({ x: 8, y: 8 })
    expect(f.quickGesture.current).toBeNull()
    expect(f.setError).toHaveBeenLastCalledWith(expect.stringContaining('请先框住主体'))
    f.begin({ x: 5, y: 5 }, 'region'); f.move({ x: 25, y: 20 }); await f.release()
    f.begin({ x: 1, y: 1 }, 'foreground')
    expect(f.quickGesture.current).toBeNull()
    expect(f.setError).toHaveBeenLastCalledWith(expect.stringContaining('虚线处理框'))
  })

  it('keeps W compatibility and Shift W out of text and IME while Escape cancels only the unfinished gesture', () => {
    class FakeElement { constructor(readonly input = false) {} closest(selector: string) { return this.input && selector.includes('input') ? this : null } }
    const f = fixture(), chooseTool = vi.fn()
    const keyboard = actual<(event: unknown) => void>('keyboard', { ...f, Element: FakeElement, chooseTool, exportRequest: { current: null }, toolMenu: null, selectionAdjust: false })
    const key = { key: 'W', shiftKey: true, metaKey: false, ctrlKey: false, target: new FakeElement(), preventDefault: vi.fn(), stopPropagation: vi.fn() }
    keyboard(key); expect(chooseTool).toHaveBeenLastCalledWith('select-quick')
    keyboard({ ...key, shiftKey: false }); expect(chooseTool).toHaveBeenLastCalledWith('select-wand')
    chooseTool.mockClear()
    keyboard({ ...key, target: new FakeElement(true) }); keyboard({ ...key, nativeEvent: { isComposing: true } }); keyboard({ ...key, keyCode: 229 })
    expect(chooseTool).not.toHaveBeenCalled()
    f.begin(); keyboard({ ...key, key: 'Escape' })
    expect(f.quickGesture.current).toBeNull()
    expect(f.stateRef.current.past).toHaveLength(0)
  })
})
