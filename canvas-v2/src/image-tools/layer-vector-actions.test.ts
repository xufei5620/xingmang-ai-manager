import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createLayerEditorState, defaultEditorImageLayer, editorLayerEffectiveState, finishLayerEditorTransaction, redoLayerEditor, undoLayerEditor } from './layer-editor-state'
import { addEditorPathLayer, appendEditorLayerOperation, createLayerGradient, isCurrentLayerColorSample, isLayerGesturePointer, layerPaintTargetError, outputPointToLayerPoint, remainingLayerPaintBudget, type LayerCanvasSelection, type LayerColorSampleRequest } from './layer-paint-state'
import { appendLayerPenAnchor, dragLayerPenHandles, hasLayerGradientDistance, isCurrentLayerVectorScope, type LayerPenAnchor, type LayerVectorScope } from './layer-vector-gesture'
import { buildLayerEditorPsdExport } from './layer-editor-export'
import { maximumImageLayerPathPoints, maximumImageTransformInputs, type ImageLayer, type ImageLayerRecipe } from './recipe'

const source = ts.createSourceFile('LayerEditor.tsx', readFileSync(new URL('./LayerEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  environment = { cropSessionRef: { current: null }, ...environment }
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!declaration) throw new Error(`Missing actual handler ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function actualEffect(needle: string, environment: Record<string, unknown>): () => void | (() => void) {
  let expression = ''
  function visit(node: ts.Node) { if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes(needle)) expression = node.arguments[0].getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!expression) throw new Error(`Missing actual effect ${needle}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as () => void | (() => void)
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
interface GradientGesture extends LayerVectorScope { pointerId: number; id: string; layer: ImageLayer; from: { x: number; y: number }; to: { x: number; y: number }; settings: { startColor: string; endColor: string; opacity: number } }
interface PenDraft extends LayerVectorScope { points: LayerPenAnchor[] }
interface PenGesture { pointerId: number; index: number; anchor: LayerPenAnchor }
function pointer(x: number, y: number, pointerId = 1) { return { button: 0, clientX: x, clientY: y, pointerId, preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: { setPointerCapture: vi.fn() } } }
function fixture(tool = 'gradient') {
  const recipe: ImageLayerRecipe = { kind: 'layer', explicitLayers: true, outputWidth: 400, outputHeight: 300, background: 'transparent', layers: [{ ...defaultEditorImageLayer(0), content: { kind: 'paint' } }] }
  const stateRef = { current: createLayerEditorState(recipe, 0) }, sourcesKeyRef = { current: 'images-v1' }
  const selectionRef: { current: LayerCanvasSelection | null } = { current: null }
  const gradientGesture: { current: GradientGesture | null } = { current: null }, penDraft: { current: PenDraft | null } = { current: null }, penGesture: { current: PenGesture | null } = { current: null }
  const frames = new Map<number, FrameRequestCallback>(), paintFrame: { current: number | null } = { current: null }
  let nextFrame = 1
  const environment = {
    stateRef, sourcesKeyRef, selectionRef, gradientGesture, penDraft, penGesture, paintFrame, tool, pixelTool: false,
    quickGesture: { current: null }, quickPixels: { current: null }, cancelQuickGesture: vi.fn(), paintGesture: { current: null }, selectionGesture: { current: null }, gesture: { current: null }, stage: { current: null },
    requestAnimationFrame: (callback: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, callback); return id }, cancelAnimationFrame: (id: number) => frames.delete(id),
    pointAt: (x: number, y: number) => ({ x, y }), setTransient: vi.fn(), setGradientGuide: vi.fn(), setPenAnchors: vi.fn(), setState: vi.fn(), setStatus: vi.fn(), setError: vi.fn(), cancelSampling: vi.fn(), cancelExport: vi.fn(), cancelPaint: vi.fn(), cancelSelection: vi.fn(),
    paintSettings: { color: '#ff000080', opacity: 0.7 }, backgroundColor: '#0000ffff', penStyle: { fill: '#00ff00', stroke: '#000000', strokeWidth: 2 },
    isCurrentLayerVectorScope, hasLayerGradientDistance, outputPointToLayerPoint, createLayerGradient, isLayerGesturePointer, finishLayerEditorTransaction, editorLayerEffectiveState, appendEditorLayerOperation, appendLayerPenAnchor, maximumImageTransformInputs, maximumImageLayerPathPoints, dragLayerPenHandles, addEditorPathLayer, layerPaintTargetError, remainingLayerPaintBudget,
  }
  const cancelGradient = actual<() => void>('cancelGradient', environment), cancelPen = actual<() => void>('cancelPen', environment)
  const cancelVectorTools = actual<() => void>('cancelVectorTools', { cancelGradient, cancelPen })
  const previewGradient = actual<(gesture: GradientGesture) => void>('previewGradient', { ...environment, cancelGradient })
  const addPenAnchor = actual<(point: { x: number; y: number }, pointerId: number) => void>('addPenAnchor', { ...environment, cancelPen })
  const movePenHandle = actual<(point: { x: number; y: number }) => void>('movePenHandle', { ...environment, cancelPen })
  const completePen = actual<() => void>('completePen', { ...environment, cancelPen })
  const all = { ...environment, cancelGradient, cancelPen, cancelVectorTools, previewGradient, addPenAnchor, movePenHandle, completePen }
  const pointerDown = actual<(event: ReturnType<typeof pointer>) => void>('pointerDown', all), pointerMove = actual<(event: ReturnType<typeof pointer>) => void>('pointerMove', all), pointerUp = actual<(event: ReturnType<typeof pointer>) => void>('pointerUp', all), cancelGesture = actual<(event?: ReturnType<typeof pointer>) => void>('cancelGesture', all)
  return { ...all, pointerDown, pointerMove, pointerUp, cancelGesture, flush: () => { const queued = [...frames.values()]; frames.clear(); queued.forEach((callback) => callback(0)) } }
}

describe('actual vector tool actions', () => {
  it('previews a selected gradient without history and commits exactly one reversible operation', () => {
    const f = fixture(), before = f.stateRef.current
    f.selectionRef.current = { kind: 'rectangle', x: 0.025, y: 1 / 30, width: 0.25, height: 1 / 3, inverted: false }
    f.pointerDown(pointer(20, 20)); f.pointerMove(pointer(100, 80)); f.pointerMove(pointer(220, 120)); f.flush()
    expect(f.stateRef.current).toBe(before)
    expect(f.setTransient).toHaveBeenLastCalledWith({ id: before.present.selectedId, stroke: expect.objectContaining({ mode: 'gradient', startColor: '#ff000080', endColor: '#0000ffff', selection: expect.objectContaining({ kind: 'rectangle' }) }) })
    f.pointerUp(pointer(220, 120))
    const after = f.stateRef.current
    expect(after.past).toHaveLength(1)
    expect(after.present.recipe.layers[0].edits?.operations).toHaveLength(1)
    expect(after.present.recipe.layers[0].edits?.operations[0]).toMatchObject({ mode: 'gradient', from: [500, 667], to: [5500, 4000], opacity: 0.7 })
    expect(undoLayerEditor(after).present.recipe).toEqual(before.present.recipe)
    expect(redoLayerEditor(undoLayerEditor(after)).present.recipe).toEqual(after.present.recipe)
  })

  it('ignores secondary pointers and cancels the owner without resurrecting the queued preview', () => {
    const f = fixture(), before = f.stateRef.current
    f.pointerDown(pointer(20, 20)); f.pointerMove(pointer(200, 150))
    f.pointerMove(pointer(300, 200, 2)); f.pointerUp(pointer(300, 200, 2)); f.cancelGesture(pointer(0, 0, 2))
    expect(f.gradientGesture.current?.to).toEqual({ x: 200, y: 150 })
    f.cancelGesture(pointer(0, 0)); f.flush(); f.pointerUp(pointer(200, 150))
    expect(f.stateRef.current).toBe(before)
    expect(f.gradientGesture.current).toBeNull()
    expect(f.setTransient).not.toHaveBeenCalledWith(expect.objectContaining({ stroke: expect.anything() }))
  })

  it.each(['recipe', 'layer', 'source', 'selection'] as const)('rejects a gradient commit after %s changes', (change) => {
    const f = fixture()
    f.pointerDown(pointer(20, 20))
    if (change === 'recipe') f.stateRef.current = { ...f.stateRef.current, present: { ...f.stateRef.current.present, recipe: structuredClone(f.stateRef.current.present.recipe) } }
    if (change === 'layer') f.stateRef.current = { ...f.stateRef.current, present: { ...f.stateRef.current.present, selectedId: null } }
    if (change === 'source') f.sourcesKeyRef.current = 'images-v2'
    if (change === 'selection') f.selectionRef.current = { kind: 'raster', inverted: false, raster: { width: 400, height: 300, runs: [] } }
    f.pointerUp(pointer(220, 120))
    expect(f.stateRef.current.past).toHaveLength(0)
    expect(f.setError).toHaveBeenLastCalledWith('画布已变化，本次渐变已取消')
  })

  it('does not change a locked layer or commit a zero-length drag', () => {
    const f = fixture(), before = f.stateRef.current
    f.pointerDown(pointer(20, 20)); f.pointerUp(pointer(20, 20))
    expect(f.stateRef.current).toBe(before)
    before.present.recipe.layers[0].locked = true
    f.pointerDown(pointer(20, 20))
    expect(f.gradientGesture.current).toBeNull()
    expect(f.setError).toHaveBeenLastCalledWith(expect.stringContaining('锁定'))
  })

  it('creates an independent cubic path layer with a selection mask in one undo', () => {
    const f = fixture('pen'), before = f.stateRef.current
    f.selectionRef.current = { kind: 'rectangle', x: 0.05, y: 1 / 15, width: 0.5, height: 0.5, inverted: false }
    f.pointerDown(pointer(50, 60)); f.pointerMove(pointer(70, 30)); f.pointerUp(pointer(70, 30))
    f.pointerDown(pointer(250, 60)); f.pointerUp(pointer(250, 60))
    f.pointerDown(pointer(140, 220)); f.pointerUp(pointer(140, 220))
    const draft = f.penDraft.current
    expect(draft?.points[0]).toEqual({ x: 50, y: 60, in: { x: 30, y: 90 }, out: { x: 70, y: 30 } })
    expect(f.stateRef.current).toBe(before)
    f.completePen()
    const after = f.stateRef.current
    expect(after.present.recipe.layers).toHaveLength(2)
    expect(after.past).toHaveLength(1)
    expect(after.present.recipe.layers[1]).toMatchObject({ content: { kind: 'path', handles: [expect.objectContaining({ in: expect.any(Array), out: expect.any(Array) }), {}, {}] }, mask: { kind: 'rectangle' } })
    const layer = after.present.recipe.layers[1], content = layer.content
    if (content?.kind !== 'path') throw new Error('Expected the actual pen content')
    function output(point: [number, number]) { return { x: (layer.x + point[0] / 10000 * layer.width) * 400, y: (layer.y + point[1] / 10000 * layer.height) * 300 } }
    for (const [point, expected] of [[content.points[0], { x: 50, y: 60 }], [content.handles![0].in!, { x: 30, y: 90 }], [content.handles![0].out!, { x: 70, y: 30 }]] as const) {
      expect(Math.abs(output(point).x - expected.x)).toBeLessThan(0.03)
      expect(Math.abs(output(point).y - expected.y)).toBeLessThan(0.03)
    }
    expect(f.penDraft.current).toBeNull()
    expect(undoLayerEditor(after).present.recipe).toEqual(before.present.recipe)
    expect(redoLayerEditor(undoLayerEditor(after)).present.recipe).toEqual(after.present.recipe)
  })

  it('keeps too few pen anchors editable and does not duplicate the last point on double click', () => {
    const f = fixture('pen')
    f.pointerDown(pointer(50, 60)); f.pointerUp(pointer(70, 30)); f.completePen()
    expect(f.stateRef.current.past).toHaveLength(0)
    expect(f.penDraft.current?.points).toHaveLength(1)
    const point = f.penDraft.current?.points[0]
    f.pointerDown(pointer(50, 60)); f.pointerUp(pointer(50, 60))
    expect(f.penDraft.current?.points[0]).toEqual(point)
    f.sourcesKeyRef.current = 'changed'
    f.completePen()
    expect(f.penDraft.current).toBeNull()
    expect(f.stateRef.current.past).toHaveLength(0)
  })

  it('supports P X D and pen Enter Backspace Escape without stealing text input', () => {
    class FakeElement { constructor(readonly input = false) {} closest(selector: string) { return this.input && selector.includes('input') ? this : null } }
    const f = fixture('pen'), chooseTool = vi.fn(), swapColors = vi.fn()
    const keyboard = actual<(event: unknown) => void>('keyboard', { ...f, Element: FakeElement, exportRequest: { current: null }, toolMenu: null, selectionAdjust: false, sampling: { current: null }, chooseTool, swapColors })
    function key(key: string, input = false) { return { key, target: new FakeElement(input), preventDefault: vi.fn(), stopPropagation: vi.fn() } }
    for (const value of ['p', 'x', 'd']) keyboard(key(value, true))
    expect(chooseTool).not.toHaveBeenCalled(); expect(swapColors).not.toHaveBeenCalled()
    keyboard(key('p')); keyboard(key('x')); keyboard(key('d'))
    expect(chooseTool).toHaveBeenCalledExactlyOnceWith('pen')
    expect(swapColors.mock.calls).toEqual([[false], [true]])
    f.addPenAnchor({ x: 50, y: 60 }, 1); f.penGesture.current = null
    f.addPenAnchor({ x: 200, y: 60 }, 1); f.penGesture.current = null
    keyboard(key('Backspace')); expect(f.penDraft.current?.points).toHaveLength(1)
    keyboard(key('Enter')); expect(f.stateRef.current.past).toHaveLength(0)
    keyboard(key('Escape')); expect(f.penDraft.current).toBeNull()
  })
})

describe('actual PSD export request lifecycle', () => {
  it.each(['cancel', 'close', 'recipe', 'layer', 'sources'] as const)('does not report a late export after %s invalidates it', async (change) => {
    const f = fixture(), pending = deferred<{ fileName: string; byteSize: number; layerCount: number }>()
    const exportRequest: { current: LayerColorSampleRequest | null } = { current: null }, setExporting = vi.fn(), exportLayerPsd = vi.fn(() => pending.promise)
    const environment = { ...f, exportRequest, setExporting, isCurrentLayerColorSample, buildLayerEditorPsdExport, images: [], hostBridge: () => ({ exportLayerPsd }) }
    const cancelExport = actual<() => void>('cancelExport', environment), exportPsd = actual<() => Promise<void>>('exportPsd', environment)
    const before = f.stateRef.current
    const work = exportPsd(); await exportPsd()
    expect(exportLayerPsd).toHaveBeenCalledTimes(1)
    const request = exportRequest.current!
    expect(exportLayerPsd.mock.calls[0]).toEqual([expect.objectContaining({ sourceAssetIds: [] }), request.controller.signal])
    if (change === 'cancel') cancelExport()
    if (change === 'close') {
      const cleanup = actualEffect('exportRequest.current?.controller.abort()', { ...environment, sampling: { current: null } })()
      expect(typeof cleanup).toBe('function')
      if (typeof cleanup === 'function') cleanup()
    }
    if (change === 'recipe') f.stateRef.current = { ...before, present: { ...before.present, recipe: structuredClone(before.present.recipe) } }
    if (change === 'layer') f.stateRef.current = { ...before, present: { ...before.present, selectedId: null } }
    if (change === 'sources') f.sourcesKeyRef.current = 'new-source'
    if (change === 'recipe' || change === 'layer' || change === 'sources') actualEffect('const request = exportRequest.current', { ...environment, cancelExport })()
    pending.resolve({ fileName: 'test.psd', byteSize: 1024, layerCount: 1 }); await work
    expect(f.setStatus).not.toHaveBeenCalledWith(expect.stringContaining('已导出'))
    expect(f.setState).not.toHaveBeenCalled()
    expect(request.controller.signal.aborted).toBe(true)
  })

  it('exports the edit snapshot without applying it and refuses an unfinished pen draft', async () => {
    const f = fixture('pen'), exportRequest = { current: null }, setExporting = vi.fn(), exportLayerPsd = vi.fn(async () => ({ fileName: 'test.psd', byteSize: 1024, layerCount: 1 }))
    const exportPsd = actual<() => Promise<void>>('exportPsd', { ...f, exportRequest, setExporting, isCurrentLayerColorSample, buildLayerEditorPsdExport, images: [], hostBridge: () => ({ exportLayerPsd }) })
    f.addPenAnchor({ x: 10, y: 10 }, 1)
    await exportPsd(); expect(exportLayerPsd).not.toHaveBeenCalled()
    f.cancelPen(); await exportPsd()
    expect(exportLayerPsd).toHaveBeenCalledTimes(1)
    expect(f.setStatus).toHaveBeenLastCalledWith(expect.stringContaining('未自动应用到节点'))
    expect(f.setState).not.toHaveBeenCalled()
  })
})
