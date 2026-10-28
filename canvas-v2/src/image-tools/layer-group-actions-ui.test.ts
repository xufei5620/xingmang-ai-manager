import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import * as model from './layer-editor-state'
import * as mergeModel from './layer-editor-merge'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from './recipe'

const source = ts.createSourceFile('LayerEditor.tsx', readFileSync(new URL('./LayerEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>, file = source): T {
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(file); ts.forEachChild(node, visit) }
  visit(file)
  if (!declaration) throw new Error(`Missing production function ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}

function fixture(group = true) {
  const recipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe
  let state = model.createLayerEditorState(recipe, 3)
  for (const [index, id] of state.present.ids.entries()) state = model.patchEditorLayer(state, id, { name: ['Photo', 'Title', 'Outside'][index] })
  state = model.selectEditorLayer(state, state.present.ids[0])
  state = model.selectEditorLayer(state, state.present.ids[1], { toggle: true })
  if (group) state = model.groupEditorLayers(state, 'Poster')
  const stateRef: { current: model.LayerEditorState } = { current: { ...state, past: [], future: [] } }, collapsed = { current: new Set<string>() }
  const environment: Record<string, unknown> = { ...model, stateRef, cancelGesture: vi.fn(), setTool: vi.fn(), setError: vi.fn(), setStatus: vi.fn(), setCollapsedGroups: (action: (previous: ReadonlySet<string>) => Set<string>) => { collapsed.current = action(collapsed.current) }, change: (action: (state: model.LayerEditorState) => model.LayerEditorState) => { stateRef.current = action(stateRef.current) } }
  const perform = actual<(action: 'group' | 'ungroup') => void>('performGroupAction', environment)
  environment.performGroupAction = perform
  return { stateRef, environment, collapsed, perform, batch: actual<(action: 'visible' | 'locked' | 'delete' | 'duplicate' | 'up' | 'down') => void>('performLayerBatch', environment) }
}

describe('actual LayerEditor group actions', () => {
  it('selects a real group and folds its rows without adding document history', () => {
    const f = fixture(), group = model.selectedEditorGroup(f.stateRef.current.present)!, row = model.editorLayerTreeRows(f.stateRef.current.present).find((item) => item.id === group.id)!
    f.stateRef.current = model.selectEditorLayer(f.stateRef.current, f.stateRef.current.present.ids[2])
    actual<(row: model.EditorLayerTreeRow, modifiers: object) => void>('selectTreeRow', { ...f.environment, selectLayer: vi.fn() })(row, {})
    expect(f.stateRef.current.present.selectedGroupId).toBe(group.id)
    expect(f.stateRef.current.present.selectedId).toBeNull()
    expect(f.stateRef.current.past).toHaveLength(0)
    const fold = actual<(id: string) => void>('toggleGroupCollapse', f.environment), before = f.stateRef.current.present
    fold(group.id); expect(f.collapsed.current.has(group.id)).toBe(true)
    fold(group.id); expect(f.collapsed.current.has(group.id)).toBe(false)
    expect(f.stateRef.current.present).toBe(before)
  })

  it('creates and ungroups editable members in one reversible action each', () => {
    const f = fixture(false), original = f.stateRef.current.present.recipe
    f.perform('group')
    const grouped = f.stateRef.current.present.recipe
    expect(grouped.layerGroups?.groups).toHaveLength(1)
    expect(f.stateRef.current.past).toHaveLength(1)
    expect(model.undoLayerEditor(f.stateRef.current).present.recipe).toEqual(original)
    expect(model.redoLayerEditor(model.undoLayerEditor(f.stateRef.current)).present.recipe).toEqual(grouped)
    f.perform('ungroup')
    expect(f.stateRef.current.present.recipe.layerGroups?.groups ?? []).toHaveLength(0)
    expect(f.stateRef.current.present.recipe.layers).toEqual(original.layers)
    expect(f.stateRef.current.past).toHaveLength(2)
    expect(model.undoLayerEditor(f.stateRef.current).present.recipe).toEqual(grouped)
  })

  it('toggles group visibility without replacing a child own hidden state', () => {
    const f = fixture(), child = f.stateRef.current.present.ids[0]
    f.stateRef.current = model.patchEditorLayer(f.stateRef.current, child, { visible: false })
    f.stateRef.current.past = []
    const before = f.stateRef.current.present.recipe
    f.batch('visible')
    expect(model.selectedEditorGroup(f.stateRef.current.present)?.visible).toBe(false)
    expect(f.stateRef.current.present.recipe.layers).toEqual(before.layers)
    expect(f.stateRef.current.past).toHaveLength(1)
    f.batch('visible')
    expect(model.selectedEditorGroup(f.stateRef.current.present)?.visible).toBe(true)
    expect(f.stateRef.current.present.recipe.layers[0].visible).toBe(false)
  })

  it('aggregates mixed group and outside-leaf own flags instead of child flags', () => {
    const f = fixture(), group = model.selectedEditorGroup(f.stateRef.current.present)!, ids = f.stateRef.current.present.ids
    f.stateRef.current = model.patchEditorGroup(f.stateRef.current, group.id, { visible: false })
    f.stateRef.current = model.selectEditorLayer(f.stateRef.current, ids[2], { toggle: true })
    f.stateRef.current.past = []
    const originalLeaves = f.stateRef.current.present.recipe.layers
    f.batch('visible')
    expect(f.stateRef.current.present.recipe.layerGroups?.groups.find((item) => item.id === group.id)?.visible).toBe(true)
    expect(f.stateRef.current.present.recipe.layers).toEqual(originalLeaves)
    expect(f.stateRef.current.past).toHaveLength(1)
  })

  it('copies the group hierarchy while keeping the outside layer unchanged', () => {
    const f = fixture(), before = f.stateRef.current.present.recipe, outside = before.layers[2]
    f.batch('duplicate')
    expect(f.stateRef.current.present.recipe.layerGroups?.groups).toHaveLength(2)
    expect(f.stateRef.current.present.recipe.layers).toHaveLength(5)
    expect(f.stateRef.current.present.recipe.layers.find((item) => item.name === 'Outside')).toBe(outside)
    expect(f.stateRef.current.past).toHaveLength(1)
    expect(model.undoLayerEditor(f.stateRef.current).present.recipe).toEqual(before)
  })

  it('refuses a child unlock through an inherited group lock', () => {
    const f = fixture(), group = model.selectedEditorGroup(f.stateRef.current.present)!
    f.stateRef.current = model.patchEditorGroup(f.stateRef.current, group.id, { locked: true })
    f.stateRef.current.past = []
    const child = model.editorLayerTreeRows(f.stateRef.current.present).find((row) => row.kind === 'layer' && row.parentId === group.id)!, before = f.stateRef.current.present
    actual<(row: model.EditorLayerTreeRow, key: string) => void>('toggleTreeRow', f.environment)(child, 'locked')
    expect(f.stateRef.current.present).toBe(before)
    expect(f.stateRef.current.past).toHaveLength(0)
    expect(f.environment.setError).toHaveBeenCalledWith('请先解锁上级编组')
  })

  it('ungroups an own hidden and locked group without unexpectedly showing or unlocking children', () => {
    const f = fixture(), group = model.selectedEditorGroup(f.stateRef.current.present)!
    f.stateRef.current = model.patchEditorGroup(f.stateRef.current, group.id, { visible: false, locked: true })
    const before = f.stateRef.current.present.recipe
    f.stateRef.current.past = []
    f.perform('ungroup')
    expect(f.stateRef.current.present.recipe.layers.slice(0, 2).every((layer) => !layer.visible && layer.locked)).toBe(true)
    expect(f.stateRef.current.present.recipe.layers[2]).toBe(before.layers[2])
    expect(f.stateRef.current.past).toHaveLength(1)
    expect(model.undoLayerEditor(f.stateRef.current).present.recipe).toEqual(before)
  })

  it('moves a group from the original drag snapshot and cancels it without a history entry', () => {
    const f = fixture(), before = f.stateRef.current, group = model.selectedEditorGroup(before.present)!, ids = model.selectedEditorLayerIds(before.present), snapshot = model.beginLayerEditorTransaction(before)
    const gesture = { current: { pointerId: 17, id: ids[0], groupId: group.id, layer: before.present.recipe.layers[0], x: 0, y: 0, width: 1024, height: 1024, output: { outputWidth: 1024, outputHeight: 1024 }, snapshot, selectedIds: ids } }
    const environment = { ...f.environment, gesture, quickGesture: { current: null }, gradientGesture: { current: null }, penGesture: { current: null }, paintGesture: { current: null }, selectionGesture: { current: null }, isLayerGesturePointer: (start: { pointerId: number } | null, id: number) => start?.pointerId === id, setState: (state: model.LayerEditorState) => { f.stateRef.current = state } }
    const move = actual<(event: unknown) => void>('pointerMove', environment)
    for (const [clientX, clientY] of [[10, 20], [30, 40]]) move({ pointerId: 17, clientX, clientY, preventDefault: vi.fn(), stopPropagation: vi.fn() })
    const finished = model.finishLayerEditorTransaction(f.stateRef.current)
    expect(finished.past).toHaveLength(1)
    expect(finished.present.recipe.layers[0]).toMatchObject({ x: 30 / 1024, y: 40 / 1024 })
    expect(finished.present.recipe.layers[2]).toBe(before.present.recipe.layers[2])
    expect(model.undoLayerEditor(finished).present.recipe).toEqual(before.present.recipe)
    expect(model.finishLayerEditorTransaction(f.stateRef.current, true).present).toBe(before.present)
  })

  it('keeps a one-leaf group primary when its canvas member begins a drag', () => {
    const f = fixture(false)
    f.stateRef.current = model.selectEditorLayer(f.stateRef.current, f.stateRef.current.present.ids[0])
    f.stateRef.current = model.groupEditorLayers(f.stateRef.current, 'Single')
    f.stateRef.current.past = []
    const group = model.selectedEditorGroup(f.stateRef.current.present)!, gesture: { current: { groupId?: string } | null } = { current: null }, selectLayer = vi.fn()
    class Target { closest(selector: string) { return selector === '[data-layer-index]' ? { getAttribute: () => '0' } : null } }
    const environment = { ...f.environment, selectLayer, Element: Target, cropSessionRef: { current: null }, quickGesture: { current: null }, paintGesture: { current: null }, selectionGesture: { current: null }, gradientGesture: { current: null }, penGesture: { current: null }, gesture, tool: 'move', pixelTool: false, stage: { current: { focus: vi.fn() } }, cancelExport: vi.fn(), cancelSampling: vi.fn(), pointAt: () => ({ x: 0, y: 0 }), svg: { current: { getBoundingClientRect: () => ({ width: 1024, height: 1024 }) } }, recipe: f.stateRef.current.present.recipe, setState: (state: model.LayerEditorState) => { f.stateRef.current = state }, closeLayerMerge: vi.fn() }
    actual<(event: unknown) => void>('pointerDown', environment)({ button: 0, target: new Target(), currentTarget: { setPointerCapture: vi.fn() }, detail: 1, pointerId: 17, clientX: 0, clientY: 0, preventDefault: vi.fn(), stopPropagation: vi.fn() })
    expect(selectLayer).not.toHaveBeenCalled()
    expect(f.stateRef.current.present.selectedGroupId).toBe(group.id)
    expect(gesture.current?.groupId).toBe(group.id)
    expect(f.stateRef.current.past).toHaveLength(0)
  })

  it('handles group shortcuts and keyboard movement without requiring a primary leaf', () => {
    const f = fixture(), group = model.selectedEditorGroup(f.stateRef.current.present)!, before = f.stateRef.current.present.recipe
    const environment = { ...f.environment, Element: class {}, cropSessionRef: { current: null }, exportRequest: { current: null }, quickGesture: { current: null }, paintGesture: { current: null }, selectionGesture: { current: null }, gradientGesture: { current: null }, gesture: { current: null }, penDraft: { current: null }, sampling: { current: null }, tool: 'move', toolMenu: null, selectionAdjust: false, selectedId: null, selected: undefined, selectedGroup: group, selection: null, cancelExport: vi.fn(), setState: (action: (state: model.LayerEditorState) => model.LayerEditorState) => { f.stateRef.current = action(f.stateRef.current) } }
    const keyboard = actual<(event: unknown) => void>('keyboard', environment), stopPropagation = vi.fn()
    keyboard({ key: 'ArrowRight', nativeEvent: {}, target: {}, preventDefault: vi.fn(), stopPropagation })
    f.stateRef.current = model.finishLayerEditorTransaction(f.stateRef.current)
    expect(f.stateRef.current.present.recipe.layers[0].x).toBe(1 / 1024)
    expect(f.stateRef.current.present.recipe.layers[1].x).toBe(1 / 1024)
    expect(f.stateRef.current.present.recipe.layers[2]).toBe(before.layers[2])
    expect(f.stateRef.current.past).toHaveLength(1)
    expect(stopPropagation).toHaveBeenCalled()
    keyboard({ key: 'g', ctrlKey: true, nativeEvent: {}, target: {}, preventDefault: vi.fn(), stopPropagation })
    expect(f.stateRef.current.present.recipe.layerGroups?.groups).toHaveLength(2)
  })

  it('does not apply an old group rename callback to a new primary selection', () => {
    const f = fixture(), group = model.selectedEditorGroup(f.stateRef.current.present)!
    f.stateRef.current = model.selectEditorLayer(f.stateRef.current, f.stateRef.current.present.ids[2])
    const before = f.stateRef.current.present
    actual<(id: string, name: string) => void>('renameGroup', f.environment)(group.id, 'Late rename')
    expect(f.stateRef.current.present).toBe(before)
    expect(f.stateRef.current.past).toHaveLength(0)
  })

  it.each(['whole-group', 'member-leaves', 'nested-group'] as const)('discloses only the folders removed by the actual merge plan for %s', (mode) => {
    const f = fixture(), group = model.selectedEditorGroup(f.stateRef.current.present)!
    if (mode === 'member-leaves') {
      f.stateRef.current = model.selectEditorLayer(f.stateRef.current, f.stateRef.current.present.ids[0])
      f.stateRef.current = model.selectEditorLayer(f.stateRef.current, f.stateRef.current.present.ids[1], { toggle: true })
    }
    if (mode === 'nested-group') f.stateRef.current = model.groupEditorLayers(f.stateRef.current, 'Outer')
    const mergeSessionRef: { current: { groupNames?: string[] } | null } = { current: null }, before = f.stateRef.current.present
    const environment = { ...f.environment, ...mergeModel, importAlive: { current: true }, penDraft: { current: null }, gradientGesture: { current: null }, paintGesture: { current: null }, cancelSampling: vi.fn(), cancelExport: vi.fn(), closeLayerMerge: vi.fn(), setToolMenu: vi.fn(), setSelectionAdjust: vi.fn(), setState: (state: model.LayerEditorState) => { f.stateRef.current = state }, importAvailable: true, images: [{ label: 'Photo' }, { label: 'Title' }, { label: 'Outside' }], sourcesKeyRef: { current: 'sources-a' }, mergeSessionRef, setMergeSession: vi.fn(), setMergeBusy: vi.fn(), setMergeAccepted: vi.fn(), sampler: { current: { mergeReviewContext: {}, reviewLayerMerge: vi.fn() } }, reviewLayerMerge: vi.fn(), localFontRevision: 0, maximumImageTransformInputs: 20, layerName: actual('layerName', {}) }
    actual<() => void>('openLayerMerge', environment)()
    expect(mergeSessionRef.current?.groupNames).toEqual(mode === 'whole-group' ? [group.name] : mode === 'member-leaves' ? [] : ['Outer', group.name])
    expect(f.stateRef.current.present).toBe(before)
  })
})

describe('actual group name draft commit', () => {
  const tree = ts.createSourceFile('LayerTree.tsx', readFileSync(new URL('./LayerTree.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  it.each([{ draft: '  Poster  ', canceled: false, expected: 'Poster' }, { draft: '', canceled: false, expected: null }, { draft: 'Canceled', canceled: true, expected: null }])('commits only valid noncancelled names: $draft', ({ draft, canceled, expected }) => {
    const onCommit = vi.fn(), setDraft = vi.fn(), setError = vi.fn()
    actual<() => void>('commit', { draft, name: 'Original', id: 'group-a', cancel: { current: canceled }, onCommit, setDraft, setError }, tree)()
    if (expected) expect(onCommit).toHaveBeenCalledExactlyOnceWith('group-a', expected)
    else expect(onCommit).not.toHaveBeenCalled()
  })
})
