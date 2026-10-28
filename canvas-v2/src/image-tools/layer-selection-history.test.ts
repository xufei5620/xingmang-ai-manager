import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowFile } from '../model'
import { beginLayerEditorTransaction, finishLayerEditorTransaction, createLayerEditorState, defaultEditorImageLayer, patchEditorLayer, redoLayerEditor, undoLayerEditor, type LayerEditorState } from './layer-editor-state'
import { appendEditorLayerFill, layerSelectionSnapshot, type LayerCanvasSelection } from './layer-paint-state'
import { updateEditorCanvasSelection } from './layer-selection-history'
import { parseImageTransformRecipe, type ImageLayerRecipe } from './recipe'

function fixture() {
  const recipe: ImageLayerRecipe = { kind: 'layer', explicitLayers: true, outputWidth: 8, outputHeight: 6, background: 'transparent', layers: [{ ...defaultEditorImageLayer(0), content: { kind: 'paint' }, mask: { kind: 'rectangle', transform: [0.5, 0, 0, 1, 0, 0], inverted: false } }] }
  return createLayerEditorState(recipe, 0)
}
function selection(offset = 0): LayerCanvasSelection { return { kind: 'raster', inverted: false, raster: { width: 8, height: 6, runs: [offset, 2, 8 + offset, 2] } } }
const source = ts.createSourceFile('LayerEditor.tsx', readFileSync(new URL('./LayerEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  environment = { closeLayerMerge: vi.fn(), ...environment }
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!declaration) throw new Error(`Missing actual handler ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}

describe('session-only canvas selection history', () => {
  it('commits a completed selection once without modifying any existing recipe or mask', () => {
    const before = fixture(), encoded = JSON.stringify(before.present.recipe)
    const after = updateEditorCanvasSelection(before, selection(), true)
    expect(after.present.recipe).toBe(before.present.recipe)
    expect(JSON.stringify(after.present.recipe)).toBe(encoded)
    expect(after.past).toEqual([before.present])
    expect(undoLayerEditor(after).present.canvasSelection ?? null).toBeNull()
    expect(redoLayerEditor(undoLayerEditor(after)).present.canvasSelection).toEqual(selection())
  })

  it('orders selection and applied mask history without erasing the earlier mask', () => {
    const before = fixture(), selected = updateEditorCanvasSelection(before, selection(1), true)
    const mask = layerSelectionSnapshot(selected.present.recipe.layers[0], selected.present.recipe, selected.present.canvasSelection!)
    const applied = patchEditorLayer(selected, selected.present.selectedId!, { mask })
    expect(applied.past).toHaveLength(2)
    const undoMask = undoLayerEditor(applied)
    expect(undoMask.present.recipe).toEqual(before.present.recipe)
    expect(undoMask.present.canvasSelection).toEqual(selection(1))
    const undoSelection = undoLayerEditor(undoMask)
    expect(undoSelection.present).toEqual(before.present)
    expect(redoLayerEditor(redoLayerEditor(undoSelection)).present).toEqual(applied.present)
  })

  it('preserves selection snapshots on reversible fill edits', () => {
    const chosen = updateEditorCanvasSelection(fixture(), selection(), true)
    const filled = appendEditorLayerFill(chosen, chosen.present.selectedId!, '#ff0000', 1, chosen.present.canvasSelection!)
    const changed = updateEditorCanvasSelection(filled, selection(3), true)
    expect(undoLayerEditor(changed).present).toEqual(filled.present)
    expect(undoLayerEditor(undoLayerEditor(changed)).present).toEqual(chosen.present)
    const operation = filled.present.recipe.layers[0].edits!.operations[0]
    if (operation.mode !== 'fill') throw new Error('expected fill')
    expect(operation.selection).toEqual(layerSelectionSnapshot(chosen.present.recipe.layers[0], chosen.present.recipe, selection()))
  })

  it('discards preview changes without consuming undo or destroying redo', () => {
    const original = fixture(), committed = updateEditorCanvasSelection(original, selection(), true), undone = undoLayerEditor(committed)
    let preview = undone
    for (let i = 0; i < 30; i++) preview = updateEditorCanvasSelection(preview, selection(i % 5))
    const cancelled = updateEditorCanvasSelection(preview, undone.present.canvasSelection ?? null)
    expect(cancelled.past).toEqual(undone.past)
    expect(cancelled.future).toEqual(undone.future)
    expect(redoLayerEditor(cancelled).present).toEqual(committed.present)
    expect(cancelled.present.recipe).toBe(original.present.recipe)
  })

  it('retains explicit empty pixel selections and avoids duplicate or no-op history', () => {
    const before = fixture(), empty: LayerCanvasSelection = { kind: 'raster', raster: { width: 8, height: 6, runs: [] }, inverted: false }
    const after = updateEditorCanvasSelection(before, empty, true)
    expect(after.present.canvasSelection).toEqual(empty)
    expect(updateEditorCanvasSelection(after, structuredClone(empty), true)).toBe(after)
    expect(updateEditorCanvasSelection(before, null, true)).toBe(before)
    expect(updateEditorCanvasSelection(after, null, true).past).toHaveLength(2)
  })

  it('bounds mixed session history and clears redo on a new completed selection', () => {
    let state = fixture()
    for (let i = 0; i < 100; i++) state = updateEditorCanvasSelection(state, selection(i % 5), true)
    expect(state.past).toHaveLength(60)
    const undone = undoLayerEditor(state)
    expect(undone.future).toHaveLength(1)
    expect(updateEditorCanvasSelection(undone, selection(5), true).future).toHaveLength(0)
  })

  it('persists applied selections while excluding transient selection and history from project and workshop', () => {
    const before = fixture(), state = updateEditorCanvasSelection(before, selection(2), true)
    const workflow: WorkflowFile = { ...createEmptyWorkflow('Selection history'), nodes: [{ id: 'layer', kind: 'image-layer', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings: { imageTransform: state.present.recipe } } }] }
    const encoded = serializeWorkflow(workflow), restored = parseWorkflowFile(encoded)!
    const workshop = sanitizeWorkshopWorkflow(restored, 'node', 'Reusable layer')
    expect(workshop.nodes[0].data.settings?.imageTransform).toEqual(before.present.recipe)
    expect(encoded).not.toContain('canvasSelection')
    expect(JSON.stringify(workshop)).not.toMatch(/canvasSelection|"past"|"future"/)
  })

  it('actual setSelection and change handlers update refs together for delayed jobs and undo', () => {
    const stateRef = { current: fixture() }, selectionRef: { current: LayerCanvasSelection | null } = { current: null }, setState = vi.fn()
    const environment = { stateRef, selectionRef, setState, updateEditorCanvasSelection, cancelSampling: vi.fn(), cancelExport: vi.fn(), cancelVectorTools: vi.fn(), closeLayerMerge: vi.fn(), setError: vi.fn(), setStatus: vi.fn() }
    const setSelection = actual<(next: LayerCanvasSelection | null, remember?: boolean) => void>('setSelection', environment)
    const change = actual<(action: (state: LayerEditorState) => LayerEditorState) => void>('change', environment)
    setSelection(selection(), true)
    expect(stateRef.current.past).toHaveLength(1)
    expect(selectionRef.current).toBe(stateRef.current.present.canvasSelection)
    change(undoLayerEditor)
    expect(selectionRef.current).toBeNull()
    change(redoLayerEditor)
    expect(selectionRef.current).toEqual(selection())
  })

  it('actual synchronous setter preserves begin patch finish and consecutive undo before React renders', () => {
    const initial = fixture(), stateRef = { current: initial }, selectionRef = { current: null as LayerCanvasSelection | null }, setReactState = vi.fn(), gesture = { current: null }
    const setState = actual<(value: LayerEditorState | ((state: LayerEditorState) => LayerEditorState)) => void>('setState', { stateRef, selectionRef, setReactState })
    const environment = { stateRef, selectionRef, setState, updateEditorCanvasSelection, gesture, cancelSampling: vi.fn(), cancelExport: vi.fn(), cancelVectorTools: vi.fn(), closeLayerMerge: vi.fn(), setError: vi.fn(), setStatus: vi.fn(), beginLayerEditorTransaction, finishLayerEditorTransaction }
    const begin = actual<() => void>('begin', environment), finish = actual<() => void>('finish', environment)
    const change = actual<(action: (state: LayerEditorState) => LayerEditorState) => void>('change', environment)
    const setSelection = actual<(next: LayerCanvasSelection | null, remember?: boolean) => void>('setSelection', environment)
    begin()
    change((state) => patchEditorLayer(state, state.present.selectedId!, { x: 0.25 }))
    change((state) => patchEditorLayer(state, state.present.selectedId!, { y: 0.5 }))
    finish()
    expect(stateRef.current.past).toHaveLength(1)
    expect(stateRef.current.transaction).toBeNull()
    expect(stateRef.current.present.recipe.layers[0]).toMatchObject({ x: 0.25, y: 0.5 })
    setSelection(selection(), true)
    change(undoLayerEditor)
    change(undoLayerEditor)
    expect(stateRef.current.present).toEqual(initial.present)
    change(redoLayerEditor)
    change(redoLayerEditor)
    expect(selectionRef.current).toEqual(selection())
    expect(setReactState.mock.lastCall?.[0]).toBe(stateRef.current)
  })

  it('actual cancel selection then finish then change does not retain a pending preview or lose a mask update', () => {
    const initial = updateEditorCanvasSelection(fixture(), selection(), true), stateRef = { current: initial }, selectionRef = { current: initial.present.canvasSelection ?? null }, setReactState = vi.fn()
    const setState = actual<(value: LayerEditorState | ((state: LayerEditorState) => LayerEditorState)) => void>('setState', { stateRef, selectionRef, setReactState })
    const environment = { stateRef, selectionRef, setState, updateEditorCanvasSelection, gesture: { current: null }, cancelSampling: vi.fn(), cancelExport: vi.fn(), cancelVectorTools: vi.fn(), closeLayerMerge: vi.fn(), setError: vi.fn(), setStatus: vi.fn(), finishLayerEditorTransaction }
    const setSelection = actual<(next: LayerCanvasSelection | null, remember?: boolean) => void>('setSelection', environment)
    const selectionGesture = { current: { previous: initial.present.canvasSelection } as { previous: LayerCanvasSelection } | null }
    const cancelSelection = actual<() => void>('cancelSelection', { setSelection, selectionGesture })
    const finish = actual<() => void>('finish', environment), change = actual<(action: (state: LayerEditorState) => LayerEditorState) => void>('change', environment)
    setSelection(selection(3))
    cancelSelection(); finish()
    change((state) => patchEditorLayer(state, state.present.selectedId!, { opacity: 0.5 }))
    expect(selectionRef.current).toBe(initial.present.canvasSelection)
    expect(stateRef.current.present.recipe.layers[0].opacity).toBe(0.5)
    expect(stateRef.current.past).toHaveLength(2)
    change(undoLayerEditor)
    expect(stateRef.current.present).toEqual(initial.present)
  })

  it('actual editor apply sends only the changed recipe and preserves the existing mask', () => {
    const before = fixture(), changed = patchEditorLayer(before, before.present.ids[0], { opacity: .5 }), stateRef = { current: updateEditorCanvasSelection(changed, selection(2), true) }, onApply = vi.fn(), onClose = vi.fn()
    const apply = actual<() => void>('apply', { cropSessionRef: { current: null }, sourcesKeyRef: { current: 'same' }, initialApplySnapshot: { current: { recipe: before.present.recipe, sourcesKey: 'same' } }, stateRef, penDraft: { current: null }, gradientGesture: { current: null }, cancelSampling: vi.fn(), cancelExport: vi.fn(), cancelGesture: vi.fn(), parseImageTransformRecipe, finishLayerEditorTransaction: (state: LayerEditorState) => state, images: [], importedAssetsRef: { current: [] }, onApply, onClose, setError: vi.fn() })
    apply()
    expect(onApply).toHaveBeenCalledExactlyOnceWith(changed.present.recipe)
    expect(changed.present.recipe.layers[0].mask).toEqual(before.present.recipe.layers[0].mask)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
