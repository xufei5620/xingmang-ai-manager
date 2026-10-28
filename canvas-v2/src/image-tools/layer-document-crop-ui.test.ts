import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { LayerDocumentCropOverlay, type LayerDocumentCropDrag } from './LayerDocumentCropOverlay'
import { buildLayerDocumentCropRatio, fitLayerDocumentCropRatio, resizeLayerDocumentCropRatio, type LayerDocumentCropRatio } from './layer-document-crop-ratio'
import { buildLayerDocumentCrop, moveLayerDocumentCrop, normalizeLayerDocumentCrop, resizeLayerDocumentCrop, type LayerDocumentCropRect } from './layer-document-crop'
import { applyEditorDocumentCrop, createLayerEditorState, defaultEditorImageLayer, finishLayerEditorTransaction, patchEditorRecipe, redoLayerEditor, undoLayerEditor, type LayerEditorState } from './layer-editor-state'
import type { ImageLayerRecipe } from './recipe'

const source = ts.createSourceFile('LayerEditor.tsx', readFileSync(new URL('./LayerEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(names: readonly string[], environment: Record<string, unknown>): T {
  const declarations: string[] = []
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) declarations.push(node.getText(source)); ts.forEachChild(node, visit) }
  visit(source); if (declarations.length !== names.length) throw new Error('Missing actual crop action')
  return new Function(...Object.keys(environment), ts.transpileModule(`${declarations.join('\n')}\nreturn {${names.join(',')}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
interface Session { recipe: ImageLayerRecipe; sourcesKey: string; rect: LayerDocumentCropRect | null }
interface Gesture { pointerId: number; target: object; mode: LayerDocumentCropDrag; start: { x: number; y: number }; before: LayerDocumentCropRect | null; session: Session; ratio: LayerDocumentCropRatio | null }
function fixture() {
  const recipe: ImageLayerRecipe = { kind: 'layer', explicitLayers: true, outputWidth: 640, outputHeight: 480, background: 'transparent', layers: [{ ...defaultEditorImageLayer(0), rotation: 25, opacity: .7 }] }
  const stateRef = { current: createLayerEditorState(recipe, 1) }, sourcesKeyRef = { current: 'original' }, cropSessionRef = { current: null as Session | null }, cropGesture = { current: null as Gesture | null }
  const target = { hasPointerCapture: vi.fn(() => true), setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() }
  const environment = { cropRatioRef: { current: null as LayerDocumentCropRatio | null }, setCropRatio: vi.fn(), buildLayerDocumentCropRatio, fitLayerDocumentCropRatio, resizeLayerDocumentCropRatio, stateRef, sourcesKeyRef, cropSessionRef, cropGesture, setCropSession: vi.fn(), setError: vi.fn(), setStatus: vi.fn(), stage: { current: { focus: vi.fn() } }, viewportController: { current: { exitHand: vi.fn() } }, setToolMenu: vi.fn(), setSelectionAdjust: vi.fn(), cancelSampling: vi.fn(), cancelExport: vi.fn(), cancelGesture: vi.fn(), cancelVectorTools: vi.fn(), finishLayerEditorTransaction, normalizeLayerDocumentCrop, buildLayerDocumentCrop, moveLayerDocumentCrop, resizeLayerDocumentCrop, applyEditorDocumentCrop, patchEditorRecipe, pointAt: (x: number, y: number) => ({ x: (x - 70) / 2, y: (y - 40) / 2 }), setState: vi.fn((next: LayerEditorState) => { stateRef.current = next }), change: (action: (state: LayerEditorState) => LayerEditorState) => { stateRef.current = action(stateRef.current) } }
  const names = ['setDocumentCrop', 'cancelDocumentCropGesture', 'closeDocumentCrop', 'openDocumentCrop', 'currentDocumentCrop', 'updateDocumentCrop', 'startDocumentCrop', 'moveDocumentCrop', 'endDocumentCrop', 'nudgeDocumentCrop', 'applyDocumentCrop', 'setDocumentOutputSize', 'changeDocumentCropRatio', 'changeDocumentCropField'] as const
  const callbacks = actual<Record<typeof names[number], (...args: unknown[]) => void>>(names, environment)
  function event(x: number, y: number, pointerId = 1) { return { button: 0, pointerId, clientX: x * 2 + 70, clientY: y * 2 + 40, currentTarget: target, preventDefault: vi.fn(), stopPropagation: vi.fn() } }
  return { ...environment, ...callbacks, target, event }
}

describe('actual layer document crop actions', () => {
  it('keeps draw drafts separate and applies dimensions and positions as one reversible edit', () => {
    const f = fixture(), before = f.stateRef.current
    f.openDocumentCrop(); f.startDocumentCrop(f.event(100, 80), 'draw'); f.moveDocumentCrop(f.event(300, 240)); f.endDocumentCrop(f.event(300, 240))
    expect(f.cropSessionRef.current?.rect).toEqual({ x: 100, y: 80, width: 200, height: 160 }); expect(f.stateRef.current).toBe(before)
    expect(f.target.setPointerCapture).toHaveBeenCalledWith(1); expect(f.target.releasePointerCapture).toHaveBeenCalledWith(1)
    f.applyDocumentCrop(); const after = f.stateRef.current
    expect(after.past).toHaveLength(1); expect(after.present.recipe).toMatchObject({ outputWidth: 200, outputHeight: 160, layers: [{ x: -.5, y: -.5, width: 3.2, height: 3, rotation: 25, opacity: .7 }] })
    expect(f.cropSessionRef.current).toBeNull(); expect(undoLayerEditor(after).present).toEqual(before.present); expect(redoLayerEditor(undoLayerEditor(after)).present).toEqual(after.present)
    f.applyDocumentCrop(); expect(f.stateRef.current).toBe(after)
  })
  it('restores the previous rectangle on cancellation and ignores late pointer-up', () => {
    const f = fixture(), before = f.stateRef.current; f.openDocumentCrop(); const rect = { x: 100, y: 80, width: 200, height: 160 }; f.updateDocumentCrop(rect)
    f.startDocumentCrop(f.event(150, 120), 'move'); f.moveDocumentCrop(f.event(190, 150)); expect(f.cropSessionRef.current?.rect?.x).toBe(140)
    f.cancelDocumentCropGesture(2); expect(f.cropGesture.current).not.toBeNull()
    f.cancelDocumentCropGesture(1); expect(f.cropSessionRef.current?.rect).toEqual(rect)
    f.endDocumentCrop(f.event(220, 180)); expect(f.cropSessionRef.current?.rect).toEqual(rect); expect(f.stateRef.current).toBe(before)
    f.closeDocumentCrop(); expect(f.cropSessionRef.current).toBeNull(); expect(f.stateRef.current).toBe(before)
  })
  it('resizes through edge and corner handles, including keyboard nudges, without changing the view', () => {
    const f = fixture(); f.openDocumentCrop(); f.updateDocumentCrop({ x: 100, y: 80, width: 200, height: 160 })
    f.startDocumentCrop(f.event(100, 80), 'nw'); f.endDocumentCrop(f.event(110, 100))
    expect(f.cropSessionRef.current?.rect).toEqual({ x: 110, y: 100, width: 190, height: 140 })
    f.nudgeDocumentCrop('e', 10, 0); expect(f.cropSessionRef.current?.rect).toEqual({ x: 110, y: 100, width: 200, height: 140 })
    f.nudgeDocumentCrop('move', -1, 10); expect(f.cropSessionRef.current?.rect).toEqual({ x: 109, y: 110, width: 200, height: 140 }); expect(f.stateRef.current.past).toHaveLength(0)
  })
  it('supports a one-pixel crop without clamping the underlying layer geometry', () => {
    const f = fixture(); f.openDocumentCrop(); f.updateDocumentCrop({ x: 500, y: 400, width: 1, height: 1 }); f.applyDocumentCrop()
    expect(f.stateRef.current.present.recipe).toMatchObject({ outputWidth: 1, outputHeight: 1, layers: [{ x: -500, y: -400, width: 640, height: 480 }] })
    expect(f.setError).toHaveBeenLastCalledWith('')
  })
  it.each(['source', 'recipe'])('discards a retained draft when the %s changes', (changed) => {
    const f = fixture(); f.openDocumentCrop(); f.startDocumentCrop(f.event(10, 10), 'draw'); f.moveDocumentCrop(f.event(100, 100))
    if (changed === 'source') f.sourcesKeyRef.current = 'replacement'
    else f.stateRef.current = patchEditorRecipe(f.stateRef.current, { background: '#ffffff' })
    const latest = f.stateRef.current; f.endDocumentCrop(f.event(200, 200)); f.applyDocumentCrop()
    expect(f.cropSessionRef.current).toBeNull(); expect(f.cropGesture.current).toBeNull(); expect(f.stateRef.current).toBe(latest)
  })
  it('ignores non-owner drag tails and leaves the original document unchanged after capture failure', () => {
    const f = fixture(); f.openDocumentCrop(); f.startDocumentCrop(f.event(10, 10), 'draw'); f.moveDocumentCrop(f.event(100, 100, 2)); expect(f.cropSessionRef.current?.rect).toBeNull()
    f.cancelDocumentCropGesture(); f.target.setPointerCapture.mockImplementation(() => { throw new Error('capture') }); f.startDocumentCrop(f.event(20, 20), 'draw')
    expect(f.cropGesture.current).toBeNull(); expect(f.stateRef.current.past).toHaveLength(0); expect(f.setError).toHaveBeenLastCalledWith('裁剪拖动已中断，请重试')
  })
  it('does not commit an empty draft or an unchanged full-document rectangle', () => {
    const f = fixture(), initial = f.stateRef.current; f.openDocumentCrop(); f.applyDocumentCrop(); expect(f.cropSessionRef.current).not.toBeNull(); expect(f.stateRef.current).toBe(initial)
    f.updateDocumentCrop({ x: 0, y: 0, width: 640, height: 480 }); f.applyDocumentCrop(); expect(f.stateRef.current).toBe(initial); expect(f.cropSessionRef.current).toBeNull()
  })
  it('shows a bounded error when manual output resizing exceeds the preserved frame', () => {
    const f = fixture(); f.openDocumentCrop(); f.updateDocumentCrop({ x: 500, y: 400, width: 1, height: 1 }); f.applyDocumentCrop()
    const before = f.stateRef.current; f.setDocumentOutputSize('outputWidth', 4096)
    expect(f.stateRef.current).toBe(before); expect(f.setError).toHaveBeenLastCalledWith(expect.stringContaining('4096'))
  })
  it('locks a real 16:9 drag and all field/handle changes until free ratio is selected', () => {
    const f = fixture(); f.openDocumentCrop(); f.changeDocumentCropRatio('16:9'); f.updateDocumentCrop(null)
    f.startDocumentCrop(f.event(80, 70), 'draw'); f.endDocumentCrop(f.event(400, 250))
    expect(f.cropSessionRef.current?.rect).toEqual({ x: 80, y: 70, width: 320, height: 180 })
    f.nudgeDocumentCrop('e', 1, 0); expect(f.cropSessionRef.current?.rect).toMatchObject({ width: 336, height: 189 })
    f.changeDocumentCropField('width', 160); expect(f.cropSessionRef.current?.rect).toMatchObject({ width: 160, height: 90 })
    f.changeDocumentCropField('x', 600); expect(f.cropSessionRef.current?.rect).toMatchObject({ x: 480, width: 160, height: 90 })
    f.changeDocumentCropRatio('free'); f.changeDocumentCropField('width', 1); f.changeDocumentCropField('height', 1)
    expect(f.cropRatioRef.current).toBeNull(); expect(f.cropSessionRef.current?.rect).toMatchObject({ width: 1, height: 1 }); expect(f.stateRef.current.past).toHaveLength(0)
  })
  it('rejects an unavailable ratio on a tiny document without replacing its valid free crop', () => {
    const f = fixture(); f.openDocumentCrop(); f.updateDocumentCrop({ x: 1, y: 1, width: 1, height: 1 }); f.applyDocumentCrop(); f.openDocumentCrop()
    f.updateDocumentCrop({ x: 0, y: 0, width: 1, height: 1 }); f.changeDocumentCropRatio('16:9')
    expect(f.cropRatioRef.current).toBeNull(); expect(f.cropSessionRef.current?.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 }); expect(f.setError).toHaveBeenLastCalledWith(expect.stringContaining('自由比例'))
  })
  it('exposes eight accessible handles with view-independent hit targets', () => {
    const callbacks = { onStart: vi.fn(), onMove: vi.fn(), onEnd: vi.fn(), onCancel: vi.fn(), onNudge: vi.fn() }
    const html = renderToStaticMarkup(createElement('svg', null, createElement(LayerDocumentCropOverlay, { rect: { x: 100, y: 80, width: 200, height: 160 }, width: 640, height: 480, scale: 2, ...callbacks })))
    expect((html.match(/调整裁剪[^\"]+，方向键微调/g) ?? [])).toHaveLength(8)
    expect(html).toContain('width="10" height="10" fill="transparent"'); expect(html).toContain('fill-rule="evenodd"'); expect(html).toContain('data-document-crop="draw"')
    expect(callbacks.onStart).not.toHaveBeenCalled(); expect(callbacks.onNudge).not.toHaveBeenCalled()
  })
})
