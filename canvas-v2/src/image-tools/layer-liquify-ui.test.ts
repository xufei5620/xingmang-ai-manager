import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { beginLayerEditorTransaction, createLayerEditorState, editorLayerEffectiveState, finishLayerEditorTransaction, patchEditorLayer, redoLayerEditor, undoLayerEditor, type LayerEditorState } from './layer-editor-state'
import { appendEditorLayerOperation } from './layer-paint-state'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from './recipe'
import { parseImageLayerLiquifyOperation } from './layer-liquify'
import { layerLiquifySpace } from './layer-liquify-editor-state'
import { LayerRecipePreview } from './layerpreview'

const source = ts.createSourceFile('LayerEditor.tsx', readFileSync(new URL('./LayerEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  environment = { closeLayerMerge: vi.fn(), ...environment }
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source); if (!declaration) throw new Error(`Missing LayerEditor function ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
const operation = parseImageLayerLiquifyOperation({ mode: 'liquify', version: 1, space: { width: 1000, height: 1000 }, strokes: [{ tool: 'push', radius: 40, strength: .5, points: [[2000, 2000], [5000, 5000]] }] })
function fixture() {
  const recipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe, stateRef = { current: createLayerEditorState(recipe, 1) }
  const liquifySessionRef = { current: null as { id: string; index: number; layer: unknown; recipe: ImageLayerRecipe; sourcesKey: string } | null }, sourcesKeyRef = { current: 'source-a' }, importAlive = { current: true }
  const change = vi.fn((action: (value: LayerEditorState) => LayerEditorState) => { stateRef.current = action(stateRef.current) })
  const environment: Record<string, unknown> = { editorLayerEffectiveState, stateRef, liquifySessionRef, sourcesKeyRef, importAlive, change, appendEditorLayerOperation, finishLayerEditorTransaction, layerLiquifySpace, parseImageLayerLiquifyOperation, setState: (action: (current: LayerEditorState) => LayerEditorState) => { stateRef.current = action(stateRef.current) }, cancelSampling: vi.fn(), cancelExport: vi.fn(), cancelGesture: vi.fn(), cancelVectorTools: vi.fn(), setToolMenu: vi.fn(), setError: vi.fn(), setStatus: vi.fn(), setLiquifySession: vi.fn() }
  environment.closeLiquify = actual('closeLiquify', environment)
  function open() { actual<() => void>('openLiquify', environment)(); return liquifySessionRef.current! }
  function apply(session = liquifySessionRef.current, value: unknown = operation) { actual<(session: unknown, value: unknown) => void>('applyLiquify', environment)(session, value) }
  return { stateRef, liquifySessionRef, sourcesKeyRef, importAlive, change, environment, open, apply, close: environment.closeLiquify as (session?: unknown) => void }
}

describe('actual LayerEditor liquify handoff', () => {
  it('opens and cancels without history and appends all draft strokes as one reversible edit', () => {
    const f = fixture(), initial = f.stateRef.current
    f.open(); f.close(); expect(f.stateRef.current).toBe(initial); expect(f.change).not.toHaveBeenCalled()
    const session = f.open(); f.apply(session)
    const after = f.stateRef.current; expect(after.past).toHaveLength(1); expect(after.present.recipe.layers[0].edits?.operations).toEqual([operation])
    expect(() => f.apply(session)).toThrow('图层或素材已变化'); expect(f.stateRef.current).toBe(after)
    expect(undoLayerEditor(after).present.recipe).toEqual(initial.present.recipe); expect(redoLayerEditor(undoLayerEditor(after)).present.recipe).toEqual(after.present.recipe)
  })
  it.each(['source', 'layer', 'locked', 'hidden', 'selection', 'output', 'closed', 'unmounted'] as const)('rejects a retained apply callback after %s changes', (condition) => {
    const f = fixture(), session = f.open(), present = f.stateRef.current.present
    if (condition === 'source') f.sourcesKeyRef.current = 'source-b'
    if (condition === 'layer') f.stateRef.current = { ...f.stateRef.current, present: { ...present, recipe: { ...present.recipe, layers: [] } } }
    if (condition === 'locked' || condition === 'hidden') f.stateRef.current = { ...f.stateRef.current, present: { ...present, recipe: { ...present.recipe, layers: [{ ...present.recipe.layers[0], ...(condition === 'locked' ? { locked: true } : { visible: false }) }] } } }
    if (condition === 'selection') f.stateRef.current = { ...f.stateRef.current, present: { ...present, selectedId: null } }
    if (condition === 'output') f.stateRef.current = { ...f.stateRef.current, present: { ...present, recipe: { ...present.recipe, outputWidth: 900 } } }
    if (condition === 'closed') f.close()
    if (condition === 'unmounted') f.importAlive.current = false
    const before = f.stateRef.current; expect(() => f.apply(session)).toThrow(); expect(f.stateRef.current).toBe(before); expect(f.change).not.toHaveBeenCalled()
  })
  it('rejects unsupported layer sizes and malformed operations while leaving the editor intact', () => {
    const f = fixture(), layer = f.stateRef.current.present.recipe.layers[0]
    layer.width = 8; expect(f.open()).toBeNull(); expect(f.environment.setError).toHaveBeenCalledWith(expect.stringContaining('4096'))
    layer.width = 1; const session = f.open(); expect(() => f.apply(session, { ...operation, strokes: [] })).toThrow(); expect(f.change).not.toHaveBeenCalled(); expect(f.liquifySessionRef.current).toBe(session)
  })
  it('does not let a stale close callback dismiss a newer liquify session', () => {
    const f = fixture(), first = f.open(); f.close(first); const second = f.open(); f.close(first); expect(f.liquifySessionRef.current).toBe(second)
  })
  it('settles previous gestures before liquify and preserves prior edits on undo', () => {
    const f = fixture(), id = f.stateRef.current.present.ids[0]
    f.stateRef.current = patchEditorLayer(beginLayerEditorTransaction(f.stateRef.current), id, { opacity: .6 })
    f.open(); expect(f.stateRef.current.transaction).toBeNull(); expect(f.environment.cancelGesture).toHaveBeenCalledOnce()
    f.apply(); expect(f.stateRef.current.past).toHaveLength(2); expect(undoLayerEditor(f.stateRef.current).present.recipe.layers[0].opacity).toBe(.6)
  })
  it('renders liquified layers using the cancellable original-resolution world painter', () => {
    const f = fixture(); f.apply(f.open()); const recipe = f.stateRef.current.present.recipe
    recipe.layers[0] = { ...recipe.layers[0], content: { kind: 'shape', shape: 'rectangle', fill: '#ff0000', stroke: 'transparent', strokeWidth: 0 }, rotation: 45 }
    const html = renderToStaticMarkup(createElement(LayerRecipePreview, { recipe, images: [] }))
    expect(html).toContain('输出坐标描边与绘画预览'); expect(html).toContain('<foreignObject x="0" y="0"'); expect(html).toContain('data-layer-hit-area="true"')
  })
  it('opens the filter context menu without leaking the gesture to the enclosing canvas', () => {
    let expression = ''
    function visit(node: ts.Node) { if (ts.isJsxAttribute(node) && node.name.getText(source) === 'onContextMenu' && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression?.getText(source).includes('toolMenuTrigger.current')) expression = node.initializer.expression.getText(source); ts.forEachChild(node, visit) }
    visit(source); expect(expression).not.toBe('')
    const toolMenuTrigger = { current: null }, setToolMenu = vi.fn(), event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: {} }
    const handler = new Function('toolMenuTrigger', 'setToolMenu', 'toolMenu', ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(toolMenuTrigger, setToolMenu, null)
    handler(event); expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce(); expect(setToolMenu).toHaveBeenCalledWith('filter'); expect(toolMenuTrigger.current).toBe(event.currentTarget)
  })
})
