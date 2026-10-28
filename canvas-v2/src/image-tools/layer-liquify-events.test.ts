import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLayerEditorState } from './layer-editor-state'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from './recipe'
import { layerLiquifyLimits, type ImageLayerLiquifyOperation, type ImageLayerLiquifyStroke } from './layer-liquify'
import { appendLiquifyPoint, appendLiquifyRecipe, buildLiquifyOperation, hasLiquifyStroke, liquifyHistoryChange, liquifyHistoryStep, liquifyPoint, type LiquifyHistory, type LiquifyView } from './layer-liquify-editor-state'

const source = ts.createSourceFile('LayerLiquifyEditor.tsx', readFileSync(new URL('./LayerLiquifyEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source); if (!declaration) throw new Error(`Missing liquify function ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
type Gesture = { kind: 'stroke'; pointerId: number; stroke: ImageLayerLiquifyStroke } | { kind: 'pan'; pointerId: number; start: { x: number; y: number }; before: LiquifyView }
function fixture(options: { before?: boolean; hand?: boolean } = {}) {
  const recipe = createLayerEditorState(defaultImageTransformRecipe('layer') as ImageLayerRecipe, 1).present.recipe
  const environment = {
    recipe, layerIndex: 0, space: { width: 1000, height: 1000 }, initial: { current: { recipe, scope: 'source-a' } }, current: { current: { recipe, scope: 'source-a' } }, alive: { current: true }, completed: { current: false },
    historyRef: { current: { past: [], strokes: [], future: [] } as LiquifyHistory }, gesture: { current: null as Gesture | null }, pointers: { current: new Set<number>() }, previewTimer: { current: null as ReturnType<typeof setTimeout> | null }, pendingOperation: { current: null as ImageLayerLiquifyOperation | null },
    shownOperationRef: { current: null as ImageLayerLiquifyOperation | null }, readyOperation: { current: null as ImageLayerLiquifyOperation | null }, beforeRef: { current: options.before ?? false }, setPreviewError: vi.fn(), setPreviewBusy: vi.fn(),
    viewRef: { current: { zoom: 1, x: 0, y: 0 } }, stage: { current: { hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn(), focus: vi.fn() } }, hand: options.hand ?? false, spaceHeld: false, before: options.before ?? false, tool: 'push', radius: 50, strength: .5,
    appendLiquifyPoint, appendLiquifyRecipe, buildLiquifyOperation, hasLiquifyStroke, liquifyHistoryChange, liquifyHistoryStep, liquifyPoint, layerLiquifyLimits,
    setShownOperation: vi.fn(), setHistory: vi.fn(), setDrawing: vi.fn(), setCursor: vi.fn(), setView: vi.fn(), setError: vi.fn(), setNotice: vi.fn(), setSpaceHeld: vi.fn(), onApply: vi.fn(), onClose: vi.fn(),
    pointAt: (x: number, y: number) => x >= 0 && y >= 0 && x <= 1000 && y <= 1000 ? { x, y } : null,
  }
  environment.setShownOperation.mockImplementation((operation) => { environment.shownOperationRef.current = operation })
  const env: Record<string, unknown> = environment
  for (const name of ['active', 'operation', 'preview', 'receivePreviewStatus', 'updateHistory', 'release', 'cancelGesture', 'close', 'apply', 'pointerDown', 'pointerMove', 'pointerUp', 'step', 'reset', 'down', 'blur']) env[name] = actual(name, env)
  function call(name: string, ...args: unknown[]) { return (env[name] as (...args: unknown[]) => void)(...args) }
  function event(x = 200, y = 200, extra: Record<string, unknown> = {}) { return { clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1, isPrimary: true, preventDefault: vi.fn(), currentTarget: { setPointerCapture: vi.fn() }, ...extra } }
  function draw(ready = true) { call('pointerDown', event()); call('pointerMove', event(500, 500)); call('pointerUp', event(500, 500, { buttons: 0 })); if (ready) call('receivePreviewStatus', { busy: false, error: '' }, environment.pendingOperation.current) }
  return { environment, call, event, draw }
}
afterEach(() => vi.useRealTimers())

describe('actual liquify gesture and preview callbacks', () => {
  it('uses the inverse displayed SVG transform to keep radius coordinates independent of zoom and pan', () => {
    const inverse = vi.fn(() => ({ a: .5, d: .5, e: -50, f: -25 }))
    class Point { constructor(readonly x: number, readonly y: number) {} matrixTransform(matrix: { a: number; d: number; e: number; f: number }) { return { x: this.x * matrix.a + matrix.e, y: this.y * matrix.d + matrix.f } } }
    const pointAt = actual<(x: number, y: number) => { x: number; y: number } | null>('pointAt', { svg: { current: { getScreenCTM: () => ({ inverse }) } }, DOMPoint: Point, liquifyPoint, space: { width: 1000, height: 500 } })
    expect(pointAt(1100, 550)).toEqual({ x: 500, y: 250 }); expect(inverse).toHaveBeenCalledOnce(); expect(pointAt(50, 50)).toBeNull()
  })
  it('previews a moving stroke but writes draft history only on matching pointer release', () => {
    vi.useFakeTimers(); const f = fixture()
    f.call('pointerDown', f.event()); f.call('pointerMove', f.event(500, 500)); expect(f.environment.historyRef.current.strokes).toHaveLength(0)
    vi.advanceTimersByTime(90); expect(f.environment.setShownOperation).toHaveBeenLastCalledWith(expect.objectContaining({ strokes: [expect.objectContaining({ points: [[2000, 2000], [5000, 5000]] })] }))
    f.call('pointerUp', f.event(500, 500, { pointerId: 2 })); expect(f.environment.historyRef.current.strokes).toHaveLength(0)
    f.call('pointerUp', f.event(600, 600)); expect(f.environment.historyRef.current.strokes[0].points.at(-1)).toEqual([6000, 6000]); expect(f.environment.historyRef.current.past).toHaveLength(1); expect(f.environment.onApply).not.toHaveBeenCalled()
  })
  it('cancels the active stroke without removing an earlier committed stroke', () => {
    const f = fixture(); f.draw(); const committed = f.environment.historyRef.current
    f.call('pointerDown', f.event()); f.call('pointerMove', f.event(700, 700)); f.call('step')
    expect(f.environment.gesture.current).toBeNull(); expect(f.environment.historyRef.current).toBe(committed); expect(f.environment.setShownOperation).toHaveBeenLastCalledWith(expect.objectContaining({ strokes: committed.strokes }))
    f.call('step'); expect(f.environment.historyRef.current.strokes).toHaveLength(0); f.call('step', true); expect(f.environment.historyRef.current.strokes).toEqual(committed.strokes)
  })
  it.each(['cancelGesture', 'blur', 'second-pointer'] as const)('rejects a late pointer release after %s interrupts a draft', (method) => {
    const f = fixture(); f.call('pointerDown', f.event()); f.call('pointerMove', f.event(500, 500))
    if (method === 'second-pointer') { f.environment.pointers.current.add(1); f.call('down', { pointerId: 2 }) } else f.call(method)
    f.call('pointerUp', f.event(700, 700)); expect(f.environment.historyRef.current.strokes).toHaveLength(0); expect(f.environment.gesture.current).toBeNull(); expect(f.environment.onApply).not.toHaveBeenCalled()
  })
  it.each(['source', 'recipe', 'unmounted', 'closed'] as const)('does not publish a throttled frame or apply when the session becomes %s', (condition) => {
    vi.useFakeTimers(); const f = fixture(); f.call('pointerDown', f.event()); f.call('pointerMove', f.event(500, 500))
    if (condition === 'source') f.environment.current.current.scope = 'source-b'
    if (condition === 'recipe') f.environment.current.current.recipe = { ...f.environment.recipe }
    if (condition === 'unmounted') f.environment.alive.current = false
    if (condition === 'closed') f.call('close')
    const count = f.environment.setShownOperation.mock.calls.length; vi.advanceTimersByTime(100); expect(f.environment.setShownOperation).toHaveBeenCalledTimes(count)
    f.call('apply'); expect(f.environment.onApply).not.toHaveBeenCalled()
  })
  it('coalesces repeated move frames without starving an ongoing gesture', () => {
    vi.useFakeTimers(); const f = fixture(); f.call('pointerDown', f.event()); f.call('pointerMove', f.event(300, 300)); vi.advanceTimersByTime(50); f.call('pointerMove', f.event(400, 400)); vi.advanceTimersByTime(40)
    expect(f.environment.setShownOperation).toHaveBeenCalledOnce(); expect(f.environment.setShownOperation.mock.calls[0][0].strokes[0].points.at(-1)).toEqual([4000, 4000])
    f.call('pointerMove', f.event(500, 500)); vi.advanceTimersByTime(90); expect(f.environment.setShownOperation).toHaveBeenCalledTimes(2)
    f.call('cancelGesture')
  })
  it('does not create push history for a click and prevents secondary or before-view drawing', () => {
    const f = fixture(); f.call('pointerDown', f.event()); f.call('pointerUp', f.event()); expect(f.environment.historyRef.current.strokes).toHaveLength(0)
    f.call('pointerDown', f.event(200, 200, { isPrimary: false })); expect(f.environment.gesture.current).toBeNull()
    const g = fixture(); g.environment.pointers.current.add(1); g.environment.pointers.current.add(2); g.call('pointerDown', g.event()); expect(g.environment.gesture.current).toBeNull()
    const before = fixture({ before: true }); before.call('pointerDown', before.event()); expect(before.environment.gesture.current).toBeNull(); expect(before.environment.setNotice).toHaveBeenCalledWith(expect.stringContaining('液化前'))
  })
  it('validates the whole layer budget before committing and keeps prior content untouched on overflow', () => {
    const f = fixture(); f.environment.recipe.layers[0].edits = { version: 1, operations: Array.from({ length: 256 }, () => ({ mode: 'fill', color: '#ffffff', opacity: 1 })) }
    f.call('pointerDown', f.event()); f.call('pointerMove', f.event(500, 500)); f.call('pointerUp', f.event(500, 500))
    expect(f.environment.historyRef.current.strokes).toHaveLength(0); expect(f.environment.recipe.layers[0].edits.operations).toHaveLength(256); expect(f.environment.setError).toHaveBeenCalled(); expect(f.environment.onApply).not.toHaveBeenCalled()
  })
  it('applies exactly once even with reentrant callbacks and preserves a rejected draft for retry', () => {
    const f = fixture(); f.draw(); f.environment.onApply.mockImplementationOnce(() => { throw new Error('图层已锁定') }); f.call('apply')
    expect(f.environment.completed.current).toBe(false); expect(f.environment.onClose).not.toHaveBeenCalled(); expect(f.environment.historyRef.current.strokes).toHaveLength(1)
    f.environment.onApply.mockImplementationOnce(() => f.call('apply')); f.call('apply'); f.call('apply'); expect(f.environment.onApply).toHaveBeenCalledTimes(2); expect(f.environment.onClose).toHaveBeenCalledOnce()
  })
  it('blocks apply during a live stroke and prevents retained close callbacks after unmount', () => {
    const f = fixture(); f.draw(); f.call('pointerDown', f.event()); f.call('apply'); expect(f.environment.onApply).not.toHaveBeenCalled(); expect(f.environment.setError).toHaveBeenLastCalledWith('请先松开笔刷，再应用液化')
    f.environment.alive.current = false; f.call('close'); expect(f.environment.onClose).not.toHaveBeenCalled()
  })
  it('requires successful raster completion for the exact current draft and keeps render failures editable', () => {
    const f = fixture(); f.draw(false); f.call('apply'); expect(f.environment.onApply).not.toHaveBeenCalled()
    const pending = f.environment.pendingOperation.current
    f.call('receivePreviewStatus', { busy: false, error: '液化路径过长，请增大笔径或分次应用' }, pending); f.call('apply'); expect(f.environment.onApply).not.toHaveBeenCalled(); expect(f.environment.historyRef.current.strokes).toHaveLength(1)
    f.call('receivePreviewStatus', { busy: false, error: '' }, pending); f.call('apply'); expect(f.environment.onApply).toHaveBeenCalledOnce()
  })
  it('does not let a late successful raster authorize a newer or cancelled draft', () => {
    const f = fixture(); f.draw(); const previous = f.environment.readyOperation.current
    f.call('reset'); f.call('receivePreviewStatus', { busy: false, error: '' }, previous); expect(f.environment.readyOperation.current).toBeNull()
    f.draw(false); f.call('receivePreviewStatus', { busy: false, error: '' }, previous); f.call('apply'); expect(f.environment.onApply).not.toHaveBeenCalled()
    f.call('close'); f.call('receivePreviewStatus', { busy: false, error: '' }, f.environment.pendingOperation.current); expect(f.environment.readyOperation.current).toBeNull()
  })
  it('pans without drawing and restores the view when a pan is interrupted', () => {
    const f = fixture({ hand: true }); f.call('pointerDown', f.event()); f.call('pointerMove', f.event(500, 300)); expect(f.environment.viewRef.current).toEqual({ zoom: 1, x: 300, y: 100 })
    f.call('cancelGesture'); expect(f.environment.viewRef.current).toEqual({ zoom: 1, x: 0, y: 0 }); expect(f.environment.historyRef.current.strokes).toHaveLength(0)
  })
})
