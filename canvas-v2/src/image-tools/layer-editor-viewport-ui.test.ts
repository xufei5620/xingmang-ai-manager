import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import * as geometry from './layer-editor-viewport'
import { createLayerEditorState, defaultEditorImageLayer, editorLayerEffectiveState, finishLayerEditorTransaction, groupEditorLayers, moveEditorLayer, patchEditorGroup, patchEditorLayer, resizeEditorLayer, selectEditorLayer } from './layer-editor-state'
import { buildCanvasSelection, createLayerFilterStroke, createLayerPaintStroke, isLayerGesturePointer, layerPaintTargetError, outputPointToLayerPoint, remainingLayerPaintBudget, shouldAppendPaintPoint } from './layer-paint-state'
import { assertLayerFilterSize } from './layer-filter-raster'
import type { ImageLayerRecipe } from './recipe'

const sources = Object.fromEntries(['LayerEditor', 'LayerEditorViewport'].map((file) => [file, ts.createSourceFile(`${file}.tsx`, readFileSync(new URL(`./${file}.tsx`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)]))
function actual<T>(file: string, names: readonly string[], environment: Record<string, unknown>): T {
  const declarations: string[] = []
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) declarations.push(node.getText(sources[file])); ts.forEachChild(node, visit) }
  visit(sources[file]); if (declarations.length !== names.length) throw new Error('Missing actual callback')
  return new Function(...Object.keys(environment), ts.transpileModule(`${declarations.join('\n')}\nreturn {${names.join(',')}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function effect(needle: string, environment: Record<string, unknown>): () => void | (() => void) {
  const source = sources.LayerEditorViewport
  let expression = ''
  function visit(node: ts.Node) { if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes(needle)) expression = node.arguments[0].getText(source); ts.forEachChild(node, visit) }
  visit(source); if (!expression) throw new Error('Missing actual viewport effect')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment))
}
class Target {
  input = false
  closest() { return this.input ? this : null }
  contains(other: unknown) { return other === this }
}
function pointer(overrides: Record<string, unknown> = {}) { return { button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, pointerId: 1, clientX: 250, clientY: 200, nativeEvent: {}, target: new Target(), currentTarget: { setPointerCapture: vi.fn() }, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides } }
function viewportFixture() {
  const element = Object.assign(new Target(), { clientWidth: 500, clientHeight: 350, clientLeft: 0, clientTop: 0, getBoundingClientRect: () => ({ left: 20, top: 30 }), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn(), focus: vi.fn() })
  const viewRef = { current: { zoom: 1, x: -100, y: -100 } }, size = { current: { width: 500, height: 350 } }, fitted = { current: false }
  const pan: { current: null | { pointerId: number; x: number; y: number; before: geometry.LayerEditorViewport; wasFit: boolean } } = { current: null }
  const current = { current: { output: { width: 800, height: 600 }, onInterrupt: vi.fn(), onScaleChange: vi.fn(), onHandChange: vi.fn() } }
  const env = { ...geometry, viewRef, size, fitted, pan, current, viewport: { current: element }, alive: { current: true }, pointers: { current: new Set<number>() }, blocked: { current: false }, handRef: { current: false }, spaceRef: { current: false }, Node: Target, Element: Target, setView: vi.fn(), setPanning: vi.fn(), setNotice: vi.fn(), setSpace: vi.fn(), setHand: vi.fn(), queueMicrotask }
  const names = ['update', 'release', 'cancelPan', 'interrupt', 'setHandTool', 'changeZoom', 'fit', 'measure', 'wheel', 'down', 'move', 'up', 'keyDown', 'keyUp', 'releaseSpace', 'focusLeft', 'windowBlur', 'pointerStarted', 'pointerFinished', 'pointerCancelled'] as const
  const calls = actual<Record<typeof names[number], (...args: unknown[]) => void>>('LayerEditorViewport', names, env)
  return { ...env, element, ...calls }
}

describe('actual layer viewport event routing', () => {
  it('zooms about the wheel pointer in local CSS pixels and stops page/canvas scrolling', () => {
    const f = viewportFixture(), before = f.viewRef.current, event = { ...pointer(), deltaY: -100, deltaMode: 0 }
    f.wheel(event)
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect((230 - f.viewRef.current.x) / f.viewRef.current.zoom).toBeCloseTo((230 - before.x) / before.zoom)
    expect((170 - f.viewRef.current.y) / f.viewRef.current.zoom).toBeCloseTo((170 - before.y) / before.zoom)
    expect(f.current.current.onInterrupt).toHaveBeenCalledOnce(); expect(f.fitted.current).toBe(false)
  })
  it.each(['mouse', 'touch', 'pen'])('leaves ordinary %s edits to the stage and captures hand pans instead', (pointerType) => {
    const f = viewportFixture(), edit = pointer({ pointerType }); f.down(edit)
    expect(edit.stopPropagation).not.toHaveBeenCalled(); expect(f.pan.current).toBeNull(); expect(f.current.current.onInterrupt).not.toHaveBeenCalled()
    f.setHandTool(true); const drag = pointer({ pointerType }); f.down(drag)
    expect(drag.stopPropagation).toHaveBeenCalledOnce(); expect(drag.currentTarget.setPointerCapture).toHaveBeenCalledWith(1)
    f.move(pointer({ clientX: 300, clientY: 240 })); expect(f.viewRef.current).toEqual({ zoom: 1, x: -50, y: -60 })
    f.up(pointer({ clientX: 300, clientY: 240 })); expect(f.pan.current).toBeNull(); expect(f.element.releasePointerCapture).toHaveBeenCalledWith(1)
  })
  it('supports middle button pan and restores the previous view when cancelled', () => {
    const f = viewportFixture(), before = f.viewRef.current; f.down(pointer({ button: 1 })); f.move(pointer({ buttons: 4, clientX: 300 })); expect(f.viewRef.current).not.toEqual(before)
    f.pointerCancelled(pointer()); expect(f.viewRef.current).toEqual(before); expect(f.pan.current).toBeNull()
    f.up(pointer({ clientX: 310 })); expect(f.viewRef.current).toEqual(before)
  })
  it('cancels a live edit for a second pointer and blocks both tails until their up handlers finish', async () => {
    const f = viewportFixture(); f.pointerStarted(pointer({ target: f.element })); f.pointerStarted(pointer({ pointerId: 2, isPrimary: false }))
    expect(f.current.current.onInterrupt).toHaveBeenCalledOnce(); expect(f.blocked.current).toBe(true)
    const move = pointer(); f.move(move); expect(move.stopPropagation).toHaveBeenCalledOnce()
    f.pointerFinished(pointer({ pointerId: 2 })); f.pointerFinished(pointer()); const up = pointer(); f.up(up); expect(up.stopPropagation).toHaveBeenCalledOnce()
    await Promise.resolve(); expect(f.blocked.current).toBe(false)
    const next = pointer(); f.down(next); expect(next.stopPropagation).not.toHaveBeenCalled()
  })
  it('releases temporary Space after focus moves outside and never steals typing', () => {
    const f = viewportFixture(), input = new Target(); input.input = true
    f.keyDown({ ...pointer({ target: input }), key: ' ', keyCode: 32 }); expect(f.spaceRef.current).toBe(false)
    f.keyDown({ ...pointer(), key: ' ', keyCode: 32 }); expect(f.spaceRef.current).toBe(true)
    f.releaseSpace({ key: ' ' }); expect(f.spaceRef.current).toBe(false)
    const event = pointer(); f.down(event); expect(event.stopPropagation).not.toHaveBeenCalled()
  })
  it('cancels on external focus or window blur but keeps internal stage focus', () => {
    const f = viewportFixture(); f.focusLeft({ currentTarget: f.element, relatedTarget: f.element }); expect(f.current.current.onInterrupt).not.toHaveBeenCalled()
    f.focusLeft({ currentTarget: f.element, relatedTarget: new Target() }); expect(f.current.current.onInterrupt).toHaveBeenCalledOnce()
    f.down(pointer({ button: 1 })); f.move(pointer({ buttons: 4, clientX: 290 })); f.spaceRef.current = true; f.windowBlur()
    expect(f.pan.current).toBeNull(); expect(f.spaceRef.current).toBe(false); expect(f.viewRef.current).toEqual({ zoom: 1, x: -100, y: -100 })
  })
  it('refits on resize only in fit mode and keeps native 100 percent after a manual resize', () => {
    const f = viewportFixture(); f.fit(); const fitted = f.viewRef.current.zoom
    f.element.clientWidth = 360; f.measure(); expect(f.viewRef.current.zoom).toBeLessThan(fitted)
    f.changeZoom(1); expect(f.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('100% 原始像素')); f.element.clientWidth = 440; f.measure(); expect(f.viewRef.current.zoom).toBe(1)
    expect(f.current.current.onScaleChange).toHaveBeenLastCalledWith(1)
  })
  it('installs cancellable native listeners and removes them with the resize observer on unmount', () => {
    const f = viewportFixture(), listeners = { addEventListener: vi.fn(), removeEventListener: vi.fn() }, document = { ...listeners, hidden: false }
    Object.assign(f.element, { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    const disconnect = vi.fn(), observe = vi.fn()
    class Observer { observe = observe; disconnect = disconnect }
    const cleanup = effect('new ResizeObserver', { ...f, window: listeners, document, ResizeObserver: Observer })()
    expect(observe).toHaveBeenCalledWith(f.element); expect(listeners.addEventListener).toHaveBeenCalledWith('keyup', f.releaseSpace)
    expect(listeners.addEventListener).toHaveBeenCalledWith('pointercancel', f.pointerCancelled, true)
    if (!cleanup) throw new Error('Missing cleanup')
    cleanup(); expect(f.alive.current).toBe(false); expect(disconnect).toHaveBeenCalledOnce()
    for (const [name, listener, capture] of listeners.addEventListener.mock.calls) {
      expect(listeners.removeEventListener).toHaveBeenCalledWith(...(capture === undefined ? [name, listener] : [name, listener, capture]))
    }
    const before = f.viewRef.current; f.element.clientWidth = 300; f.measure(); expect(f.viewRef.current).toBe(before)
  })
  it('resets the view and cancels live interactions on output or source changes only', () => {
    const f = viewportFixture(); f.down(pointer({ button: 1 })); f.move(pointer({ buttons: 4, clientX: 300 }))
    effect('size.current.width && size.current.height', f)()
    expect(f.pan.current).toBeNull(); expect(f.fitted.current).toBe(true)
    expect(f.viewRef.current).toEqual(geometry.fitLayerEditorViewport(f.size.current, f.current.current.output))
  })
  it('ignores retained wheel, pointer and resize callbacks after unmount', () => {
    const f = viewportFixture(), before = f.viewRef.current; f.alive.current = false
    f.wheel({ ...pointer(), deltaY: -100 }); f.down(pointer({ button: 1 })); f.move(pointer()); f.up(pointer()); f.measure()
    expect(f.viewRef.current).toBe(before); expect(f.current.current.onInterrupt).not.toHaveBeenCalled()
  })
})

function toolFixture(tool = 'brush', zoom = 2) {
  const recipe: ImageLayerRecipe = { kind: 'layer', explicitLayers: true, outputWidth: 800, outputHeight: 600, background: 'transparent', layers: [defaultEditorImageLayer(0)] }
  const stateRef = { current: createLayerEditorState(recipe, 1) }
  class Point { constructor(public x: number, public y: number) {} matrixTransform() { return { x: (this.x - 70) / zoom, y: (this.y - 40) / zoom } } }
  const env = { cropSessionRef: { current: null }, cancelDocumentCropGesture: vi.fn(), DOMPoint: Point, svg: { current: { getScreenCTM: () => ({ inverse: () => ({}) }) } }, tool, pixelTool: ['select-wand', 'bucket'].includes(tool), recipe, stateRef, stage: { current: { focus: vi.fn() } }, sourcesKeyRef: { current: 'source' }, selectionRef: { current: null }, selection: null, combination: 'replace', backgroundColor: '#ffffff', paintSettings: { color: '#ff0000', opacity: 1, size: 20, hardness: 1 }, filterSettings: { size: 20, strength: 1 }, quickGesture: { current: null as unknown }, paintGesture: { current: null as unknown }, selectionGesture: { current: null as unknown }, gesture: { current: null as unknown }, gradientGesture: { current: null as unknown }, penGesture: { current: null as unknown }, finishLayerEditorTransaction, editorLayerEffectiveState, layerPaintTargetError, remainingLayerPaintBudget, assertLayerFilterSize, createLayerFilterStroke, createLayerPaintStroke, outputPointToLayerPoint, shouldAppendPaintPoint, isLayerGesturePointer, buildCanvasSelection, layerSelectionCombination: () => 'replace', beginQuickSelection: vi.fn(), pickColor: vi.fn(), previewColorRange: vi.fn(), selectPixels: vi.fn(), addPenAnchor: vi.fn(), previewPaint: vi.fn(), setGradientGuide: vi.fn(), setSelection: vi.fn(), cancelExport: vi.fn(), cancelSampling: vi.fn(), cancelPaint: vi.fn(), setError: vi.fn(), setStatus: vi.fn(), setState: vi.fn(), previewGradient: vi.fn(), movePenHandle: vi.fn(), moveQuickSelection: vi.fn(), moveEditorLayer: vi.fn(moveEditorLayer), resizeEditorLayer: vi.fn(resizeEditorLayer), patchEditorLayer }
  const callbacks = actual<Record<'pointAt' | 'appendPoint' | 'pointerDown' | 'pointerMove' | 'interruptForViewport', (...args: unknown[]) => void>>('LayerEditor', ['pointAt', 'appendPoint', 'pointerDown', 'pointerMove', 'interruptForViewport'], { ...env, cancelGesture: vi.fn() })
  return { ...env, ...callbacks }
}

describe('actual transformed layer tool coordinates', () => {
  it.each(['brush', 'gradient', 'bucket'])('does not mutate a leaf through an actually locked parent group with %s pointer input', (tool) => {
    const f = toolFixture(tool)
    const grouped = groupEditorLayers(f.stateRef.current, '父组'), locked = patchEditorGroup(grouped, grouped.present.selectedGroupId!, { locked: true })
    f.stateRef.current = selectEditorLayer(locked, locked.present.ids[0])
    const before = f.stateRef.current, document = structuredClone(before.present.recipe)
    expect(before.present.recipe.layers[0].locked).toBeUndefined()
    expect(editorLayerEffectiveState(before.present, before.present.ids[0]).locked).toBe(true)
    f.pointerDown(pointer({ clientX: 470, clientY: 340 })); f.pointerMove(pointer({ clientX: 870, clientY: 640 }))
    expect(f.stateRef.current).toBe(before)
    expect(f.stateRef.current.present.recipe).toEqual(document)
    expect(f.paintGesture.current).toBeNull(); expect(f.gradientGesture.current).toBeNull()
    expect(f.selectPixels).not.toHaveBeenCalled(); expect(f.previewPaint).not.toHaveBeenCalled(); expect(f.setState).not.toHaveBeenCalled()
    expect(f.setError).toHaveBeenLastCalledWith(expect.stringContaining('锁定'))
  })
  it.each(['picker', 'select-color-range', 'select-wand', 'bucket', 'select-quick', 'pen'])('maps %s clicks through the SVG inverse screen matrix', (tool) => {
    const f = toolFixture(tool), target = { picker: f.pickColor, 'select-color-range': f.previewColorRange, 'select-wand': f.selectPixels, bucket: f.selectPixels, 'select-quick': f.beginQuickSelection, pen: f.addPenAnchor }[tool]!
    f.pointerDown(pointer({ clientX: 470, clientY: 340 })); expect(target.mock.calls[0][0]).toEqual({ x: 200, y: 150 })
  })
  it.each(['brush', 'eraser', 'blur', 'sharpen'])('preserves original-pixel %s points and diameter after zoom and translation', (tool) => {
    const f = toolFixture(tool); f.pointerDown(pointer({ clientX: 470, clientY: 340 }))
    expect(f.paintGesture.current).toMatchObject({ stroke: { points: [[2500, 2500]] } })
    f.pointerMove(pointer({ clientX: 870, clientY: 640 }))
    expect(f.paintGesture.current).toMatchObject({ stroke: { points: [[2500, 2500], [5000, 5000]] } })
    const unzoomed = toolFixture(tool, 1); unzoomed.pointerDown(pointer({ clientX: 270, clientY: 190 }))
    expect((f.paintGesture.current as { stroke: { size: number } }).stroke.size).toEqual((unzoomed.paintGesture.current as { stroke: { size: number } }).stroke.size)
  })
  it.each(['select-rectangle', 'select-ellipse', 'gradient'])('maps both endpoints for %s', (tool) => {
    const f = toolFixture(tool); f.pointerDown(pointer({ clientX: 270, clientY: 240 })); f.pointerMove(pointer({ clientX: 670, clientY: 440 }))
    if (tool === 'gradient') expect(f.gradientGesture.current).toMatchObject({ from: { x: 100, y: 100 }, to: { x: 300, y: 200 } })
    else expect(f.setSelection).toHaveBeenLastCalledWith(expect.objectContaining({ x: .125, y: 1 / 6, width: .25, height: 1 / 6 }))
  })
  it.each([undefined, 'se'])('maps move and resize deltas using the transformed SVG dimensions (%s)', (handle) => {
    const f = toolFixture('move'); f.gesture.current = { pointerId: 1, id: f.stateRef.current.present.ids[0], layer: f.recipe.layers[0], handle, x: 70, y: 40, width: 1600, height: 1200, output: { outputWidth: 800, outputHeight: 600 } }
    f.pointerMove(pointer({ clientX: 270, clientY: 140 })); const calls = handle ? f.resizeEditorLayer.mock.calls[0].slice(2, 4) : f.moveEditorLayer.mock.calls[0].slice(1, 3)
    expect(calls).toEqual([100, 50])
  })
  it('cancels active edits on a view change while preserving an idle pen draft', () => {
    const refs = Object.fromEntries(['quickGesture', 'paintGesture', 'selectionGesture', 'gesture', 'gradientGesture', 'penGesture'].map((name) => [name, { current: null as unknown }]))
    const cancelSampling = vi.fn(), cancelGesture = vi.fn(), penDraft = { current: { points: [{ x: 10, y: 20 }] } }
    const { interruptForViewport } = actual<{ interruptForViewport(): void }>('LayerEditor', ['interruptForViewport'], { ...refs, penDraft, cancelSampling, cancelGesture, cancelDocumentCropGesture: vi.fn() })
    interruptForViewport(); expect(cancelGesture).not.toHaveBeenCalled(); expect(penDraft.current.points).toHaveLength(1)
    for (const ref of Object.values(refs)) { ref.current = { pointerId: 1 }; interruptForViewport(); ref.current = null }
    expect(cancelGesture).toHaveBeenCalledTimes(6); expect(cancelSampling).toHaveBeenCalledTimes(7)
  })
})
