import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LayerRecipePreview } from './layerpreview'
import { layerFilterRecipeFixture } from './layer-filter.test-fixture'
import { createLayerEditorState, finishLayerEditorTransaction, undoLayerEditor, redoLayerEditor, type LayerEditorState } from './layer-editor-state'
import { appendEditorPaintStroke, isLayerGesturePointer } from './layer-paint-state'

const source = ts.createSourceFile('LayerEditor.tsx', readFileSync(new URL('./LayerEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!declaration) throw new Error(`Missing ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function fixture() {
  const recipe = layerFilterRecipeFixture(), stroke = recipe.layers[0].edits!.operations[0]; delete recipe.layers[0].edits
  const stateRef = { current: createLayerEditorState(recipe, 1) }, initial = stateRef.current
  const paintGesture = { current: { id: initial.present.ids[0], layer: initial.present.recipe.layers[0], recipe: initial.present.recipe, stroke, sourcesKey: 'asset-a', pointerId: 17 } as object | null }
  const env = {
    stateRef, paintGesture, sourcesKeyRef: { current: 'asset-a' }, quickGesture: { current: null }, gradientGesture: { current: null }, penGesture: { current: null }, selectionGesture: { current: null }, gesture: { current: null },
    isLayerGesturePointer, finishLayerEditorTransaction, appendEditorPaintStroke, appendPoint: vi.fn(() => true), setState: vi.fn((value: LayerEditorState) => { stateRef.current = value }), setError: vi.fn(), setTransient: vi.fn(), paintFrame: { current: null }, cancelAnimationFrame: vi.fn(), cancelPaint: () => {},
  }
  env.cancelPaint = actual('cancelPaint', env)
  const pointerUp = actual<(event: object) => void>('pointerUp', env), event = { pointerId: 17, clientX: 200, clientY: 100, preventDefault: vi.fn(), stopPropagation: vi.fn() }
  return { env, initial, pointerUp, event }
}

describe('actual local filter editor handlers', () => {
  it('commits one pointer stroke once, survives an immediate second pointerup and supports exact undo/redo', () => {
    const f = fixture(); f.pointerUp(f.event); f.pointerUp(f.event)
    expect(f.env.stateRef.current.past).toHaveLength(1)
    expect(f.env.stateRef.current.present.recipe.layers[0].edits?.operations[0].mode).toBe('blur')
    expect(undoLayerEditor(f.env.stateRef.current).present.recipe).toEqual(f.initial.present.recipe)
    expect(redoLayerEditor(undoLayerEditor(f.env.stateRef.current)).present).toEqual(f.env.stateRef.current.present)
    expect(f.env.paintGesture.current).toBeNull()
  })
  it.each(['source', 'layer', 'selection', 'size'] as const)('refuses stale %s changes before committing a stroke', (changed) => {
    const f = fixture(), present = f.env.stateRef.current.present
    if (changed === 'source') f.env.sourcesKeyRef.current = 'asset-b'
    if (changed === 'layer') f.env.stateRef.current = { ...f.initial, present: { ...present, recipe: { ...present.recipe, layers: [{ ...present.recipe.layers[0], locked: true }] } } }
    if (changed === 'selection') f.env.stateRef.current = { ...f.initial, present: { ...present, selectedId: null } }
    if (changed === 'size') f.env.stateRef.current = { ...f.initial, present: { ...present, recipe: { ...present.recipe, outputWidth: 800 } } }
    f.pointerUp(f.event)
    expect(f.env.stateRef.current.past).toEqual([])
    expect(f.env.setError).toHaveBeenCalledWith('绘制期间图层已变化，本次笔迹已取消')
  })
  it('ignores other pointers and cancels the gesture without adding recipe edits', () => {
    const f = fixture(); f.pointerUp({ ...f.event, pointerId: 18 })
    expect(f.env.paintGesture.current).not.toBeNull()
    f.env.cancelPaint(); f.pointerUp(f.event)
    expect(f.env.stateRef.current).toBe(f.initial)
    expect(f.env.setTransient).toHaveBeenCalledWith(null)
  })
  it('uses original output raster preview for both saved and transient filters on a rotated layer', () => {
    const recipe = layerFilterRecipeFixture(); Object.assign(recipe.layers[0], { rotation: 37, flipX: true, content: { kind: 'shape', shape: 'rectangle', fill: '#ffffff', stroke: '#000000', strokeWidth: 2 } })
    expect(renderToStaticMarkup(createElement(LayerRecipePreview, { recipe, images: [] }))).toContain('输出坐标描边与绘画预览')
    const stroke = recipe.layers[0].edits!.operations[0]; delete recipe.layers[0].edits
    if (stroke.mode !== 'blur' && stroke.mode !== 'sharpen') throw new Error('expected filter')
    expect(renderToStaticMarkup(createElement(LayerRecipePreview, { recipe, images: [], transient: { index: 0, stroke } }))).toContain('输出坐标描边与绘画预览')
  })
})
