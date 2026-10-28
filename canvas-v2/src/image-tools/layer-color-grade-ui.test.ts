import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { beginLayerEditorTransaction, createLayerEditorState, editorLayerEffectiveState, finishLayerEditorTransaction, patchEditorLayer, redoLayerEditor, undoLayerEditor, type LayerEditorState } from './layer-editor-state'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from './recipe'
import { defaultImageLayerColorDetail } from './layer-color-detail'
import { defaultImageLayerColorPresence } from './layer-color-presence'
import { defaultImageLayerColorCalibration } from './layer-color-calibration'
import { defaultImageLayerColorGrade, isNeutralImageLayerColorGrade, parseImageLayerColorGrade } from './layer-color-grade'

const source = ts.createSourceFile('LayerEditor.tsx', readFileSync(new URL('./LayerEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  environment = { closeLayerMerge: vi.fn(), ...environment }
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source); if (!declaration) throw new Error(`Missing LayerEditor function ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function fixture() {
  const recipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe, stateRef = { current: createLayerEditorState(recipe, 1) }
  const colorGradeSessionRef = { current: null as { id: string; index: number; layer: unknown; recipe: ImageLayerRecipe; sourcesKey: string } | null }, sourcesKeyRef = { current: 'source-a' }, importAlive = { current: true }
  const change = vi.fn((action: (value: LayerEditorState) => LayerEditorState) => { stateRef.current = action(stateRef.current) })
  const environment: Record<string, unknown> = { editorLayerEffectiveState, stateRef, colorGradeSessionRef, sourcesKeyRef, importAlive, change, patchEditorLayer, finishLayerEditorTransaction, setState: (action: (current: LayerEditorState) => LayerEditorState) => { stateRef.current = action(stateRef.current) }, isNeutralImageLayerColorGrade, parseImageLayerColorGrade, cancelSampling: vi.fn(), cancelExport: vi.fn(), cancelGesture: vi.fn(), cancelVectorTools: vi.fn(), setToolMenu: vi.fn(), setError: vi.fn(), setStatus: vi.fn(), setColorGradeSession: vi.fn() }
  environment.closeColorGrade = actual('closeColorGrade', environment)
  function open() { actual<() => void>('openColorGrade', environment)(); return colorGradeSessionRef.current! }
  function apply(session = colorGradeSessionRef.current, grade = { ...defaultImageLayerColorGrade(), exposure: 1 }) { actual<(session: unknown, grade: unknown) => void>('applyColorGrade', environment)(session, grade) }
  return { stateRef, colorGradeSessionRef, sourcesKeyRef, importAlive, change, environment, open, apply, close: environment.closeColorGrade as () => void }
}

describe('actual LayerEditor image adjustment handoff', () => {
  it.each([{ enabled: false, redHue: 40, shadowTint: 25 }, { enabled: true, redHue: 0, shadowTint: 0 }])('retains explicit dormant calibration through one actual parent history entry and undo redo: %j', (values) => {
    const f = fixture(), initial = f.stateRef.current, grade = { ...defaultImageLayerColorGrade(), calibration: { ...defaultImageLayerColorCalibration(), ...values } }
    expect(isNeutralImageLayerColorGrade(grade)).toBe(true)
    f.apply(f.open(), grade)
    expect(f.stateRef.current.present.recipe.layers[0].colorGrade).toEqual(grade); expect(f.stateRef.current.past).toHaveLength(1)
    const undo = undoLayerEditor(f.stateRef.current); expect(undo.present.recipe).toEqual(initial.present.recipe)
    expect(redoLayerEditor(undo).present.recipe.layers[0].colorGrade).toEqual(grade)
    f.open(); f.close(); expect(f.stateRef.current.present.recipe.layers[0].colorGrade).toEqual(grade)
  })
  it.each([{ enabled: false, texture: 60, clarity: 40, dehaze: 30 }, { enabled: true, texture: 0, clarity: 0, dehaze: 0 }])('retains explicit inactive presence through one actual parent transaction and undo redo: %j', (values) => {
    const f = fixture(), initial = f.stateRef.current, grade = { ...defaultImageLayerColorGrade(), presence: { ...defaultImageLayerColorPresence(), ...values } }
    expect(isNeutralImageLayerColorGrade(grade)).toBe(true)
    f.apply(f.open(), grade)
    expect(f.stateRef.current.present.recipe.layers[0].colorGrade).toEqual(grade); expect(f.stateRef.current.past).toHaveLength(1)
    const undo = undoLayerEditor(f.stateRef.current); expect(undo.present.recipe).toEqual(initial.present.recipe)
    expect(redoLayerEditor(undo).present.recipe.layers[0].colorGrade).toEqual(grade)
    f.open(); f.close(); expect(f.stateRef.current.present.recipe.layers[0].colorGrade).toEqual(grade)
  })
  it('keeps opening and cancellation out of history and applies the finished adjustment exactly once', () => {
    const f = fixture(), initial = f.stateRef.current
    f.open(); f.close(); expect(f.stateRef.current).toBe(initial); expect(f.change).not.toHaveBeenCalled()
    const session = f.open(); f.apply(session)
    expect(f.stateRef.current.past).toHaveLength(1); expect(f.stateRef.current.present.recipe.layers[0].colorGrade?.exposure).toBe(1)
    const after = f.stateRef.current; expect(() => f.apply(session)).toThrow('图层或素材已变化'); expect(f.stateRef.current).toBe(after)
    expect(undoLayerEditor(after).present.recipe).toEqual(initial.present.recipe); expect(redoLayerEditor(undoLayerEditor(after)).present.recipe).toEqual(after.present.recipe)
  })
  it.each([false, true])('preserves an explicit dormant detail configuration and one parent undo when enabled=%s', (enabled) => {
    const f = fixture(), initial = f.stateRef.current, detail = { ...defaultImageLayerColorDetail(), enabled }
    detail.sharpening.detail = 73
    const grade = { ...defaultImageLayerColorGrade(), detail }
    expect(isNeutralImageLayerColorGrade(grade)).toBe(true)
    f.apply(f.open(), grade)
    expect(f.stateRef.current.present.recipe.layers[0].colorGrade).toEqual(grade)
    expect(f.stateRef.current.past).toHaveLength(1)
    expect(undoLayerEditor(f.stateRef.current).present.recipe).toEqual(initial.present.recipe)
    expect(redoLayerEditor(undoLayerEditor(f.stateRef.current)).present.recipe.layers[0].colorGrade).toEqual(grade)
  })
  it.each(['source', 'layer', 'locked', 'hidden', 'selection', 'output', 'closed', 'unmounted'] as const)('rejects a retained apply callback after %s changes without adding history', (condition) => {
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
  it('refuses opening on a locked or hidden layer and does not turn a neutral result into a history entry', () => {
    const f = fixture(), layer = f.stateRef.current.present.recipe.layers[0]
    layer.locked = true; expect(f.open()).toBeNull(); layer.locked = false; layer.visible = false; expect(f.open()).toBeNull()
    layer.visible = true; f.apply(f.open(), defaultImageLayerColorGrade()); expect(f.stateRef.current.past).toHaveLength(0); expect(f.stateRef.current.present.recipe.layers[0].colorGrade).toBeUndefined()
  })
  it.each([{ enabled: false, strength: 100 }, { enabled: true, strength: 0 }])('retains an inactive LUT choice as an editable grade and supports one undo: %j', (state) => {
    const f = fixture(), initial = f.stateRef.current, grade = { ...defaultImageLayerColorGrade(), lut: { version: 1 as const, ...state, source: { kind: 'builtin' as const, presetId: 'xm-lut-movie-tone-v1' } } }
    expect(isNeutralImageLayerColorGrade(grade)).toBe(true)
    f.apply(f.open(), grade)
    expect(f.stateRef.current.present.recipe.layers[0].colorGrade).toEqual(grade)
    expect(f.stateRef.current.past).toHaveLength(1)
    expect(undoLayerEditor(f.stateRef.current).present.recipe).toEqual(initial.present.recipe)
    expect(redoLayerEditor(undoLayerEditor(f.stateRef.current)).present.recipe.layers[0].colorGrade).toEqual(grade)
  })
  it('settles an earlier parameter gesture before opening and does not merge grading into that gesture', () => {
    const f = fixture(), id = f.stateRef.current.present.ids[0]
    f.stateRef.current = patchEditorLayer(beginLayerEditorTransaction(f.stateRef.current), id, { opacity: .6 })
    expect(f.stateRef.current.transaction).toBeTruthy(); f.open(); expect(f.stateRef.current.transaction).toBeNull()
    expect(f.environment.cancelGesture).toHaveBeenCalledOnce(); f.apply(); expect(f.stateRef.current.past).toHaveLength(2)
    const undo = undoLayerEditor(f.stateRef.current); expect(undo.present.recipe.layers[0].opacity).toBe(.6); expect(undo.present.recipe.layers[0].colorGrade).toBeUndefined()
  })
})
