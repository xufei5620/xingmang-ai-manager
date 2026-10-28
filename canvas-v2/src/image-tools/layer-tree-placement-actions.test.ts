import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LayerTree, type LayerTreeProps } from './LayerTree'
import * as model from './layer-editor-state'
import type { ImageLayerRecipe } from './recipe'

const source = ts.createSourceFile('LayerEditor.tsx', readFileSync(new URL('./LayerEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
const runtime = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useId: () => 'tree-ui',
  useRef(initial: unknown) { const index = runtime.cursor++; runtime.slots[index] ??= { current: initial }; return runtime.slots[index] },
  useState(initial: unknown) { const index = runtime.cursor++, slots = runtime.slots; if (!(index in slots)) { const state = { value: typeof initial === 'function' ? initial() : initial, update(value: unknown) { state.value = typeof value === 'function' ? value(state.value) : value } }; slots[index] = state }; const state = slots[index] as { value: unknown; update(value: unknown): void }; return [state.value, state.update] },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) { const index = runtime.cursor++, slots = runtime.slots, previous = slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined; if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, at) => Object.is(value, previous.dependencies[at]))) return; runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } }) },
}))
interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type: unknown): ElementShape[] { if (Array.isArray(value)) return value.flatMap((item) => elements(item, type)); if (!value || typeof value !== 'object' || !('props' in value)) return []; const item = value as ElementShape; return [...(item.type === type ? [item] : []), ...elements(item.props.children, type)] }
function textOf(value: unknown): string { if (typeof value === 'string' || typeof value === 'number') return String(value); if (Array.isArray(value)) return value.map(textOf).join(''); return value && typeof value === 'object' && 'props' in value ? textOf((value as ElementShape).props.children) : '' }
function button(tree: unknown, label: string) { const item = elements(tree, 'button').find((value) => value.props['aria-label'] === label || textOf(value.props.children) === label); expect(item, label).toBeDefined(); return item! }
function fixture() {
  const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 100, outputHeight: 80, explicitLayers: true, background: 'transparent', layers: Array.from({ length: 4 }, (_, index) => ({ ...model.defaultEditorImageLayer(0), name: `Leaf ${index + 1}`, content: { kind: 'paint' } })) }
  let state = model.createLayerEditorState(recipe, 1)
  state = model.groupEditorLayers(model.selectEditorLayer(model.selectEditorLayer(state, 'layer-1'), 'layer-2', { toggle: true }), 'Product')
  const a = state.present.selectedGroupId!
  state = model.groupEditorLayers(model.selectEditorLayer(model.selectEditorLayer(state, 'layer-3'), 'layer-4', { toggle: true }), 'Copy')
  const b = state.present.selectedGroupId!
  state = model.selectEditorLayer(state, 'layer-1'); state = { ...state, past: [], future: [] }
  const original = state, stateRef = { current: state }, collapsed = { current: new Set([b]) }, setError = vi.fn(), setStatus = vi.fn()
  const environment = { ...model, stateRef, cancelGesture: vi.fn(), closeLayerMerge: vi.fn(), cancelSampling: vi.fn(), cancelExport: vi.fn(), cancelVectorTools: vi.fn(), setState: (next: model.LayerEditorState) => { stateRef.current = next }, setError, setStatus, change: (action: (value: model.LayerEditorState) => model.LayerEditorState) => { stateRef.current = action(stateRef.current) }, setCollapsedGroups: (action: (previous: ReadonlySet<string>) => Set<string>) => { collapsed.current = action(collapsed.current) } }
  const begin = actual<NonNullable<LayerTreeProps['onMoveStart']>>('beginTreeMove', environment), inspect = actual<NonNullable<LayerTreeProps['onInspectMove']>>('inspectTreeMove', environment), place = actual<NonNullable<LayerTreeProps['onMove']>>('placeTreeSelection', environment)
  return { stateRef, original, a, b, collapsed, begin, inspect, place, setError, setStatus, props(): LayerTreeProps { const current = stateRef.current.present; return { recipe: current.recipe, rows: model.editorLayerTreeRows(current), images: [], selectedIds: model.selectedEditorLayerIds(current), selectedId: current.selectedId, selectedGroupId: current.selectedGroupId, collapsed: collapsed.current, name: (index) => current.recipe.layers[index].name || '', onSelect: (row, modifiers) => { stateRef.current = row.kind === 'group' ? model.selectEditorGroup(stateRef.current, row.id, modifiers) : model.selectEditorLayer(stateRef.current, row.id, modifiers) }, onCollapse: vi.fn(), onVisibility: vi.fn(), onLock: vi.fn(), onMoveStart: begin, onInspectMove: inspect, onMove: place } } }
}
function treeHarness(f: ReturnType<typeof fixture>) {
  const owned = { slots: [] as unknown[], effects: [] as (() => void)[] }, frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length }); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  function pass() { runtime.cursor = 0; runtime.slots = owned.slots; runtime.effects = owned.effects; const tree = LayerTree(f.props()); owned.effects.splice(0).forEach((effect) => effect()); return tree }
  return { render() { pass(); return pass() }, frames, close() { for (const slot of owned.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup(): void }).cleanup() } }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('actual editor placement actions', () => {
  it('prechecks a cross-parent move without history then applies membership and reveal in one reversible action', () => {
    const f = fixture(), snapshot = f.begin()!
    expect(f.inspect(snapshot, f.b, 'inside')).toBe(''); expect(f.stateRef.current).toBe(f.original)
    expect(f.place(snapshot, f.b, 'inside').ok).toBe(true)
    expect(model.editorLayerEffectiveState(f.stateRef.current.present, 'layer-1').parentId).toBe(f.b)
    expect(f.stateRef.current.past).toHaveLength(1); expect(f.collapsed.current.has(f.b)).toBe(false)
    expect(model.undoLayerEditor(f.stateRef.current).present).toEqual(f.original.present)
  })

  it('does not add history for an already-correct placement', () => {
    const f = fixture(), snapshot = f.begin()!
    expect(f.place(snapshot, 'layer-2', 'before')).toMatchObject({ ok: true, message: expect.stringContaining('没有新增修改') })
    expect(f.stateRef.current).toBe(f.original); expect(f.stateRef.current.past).toHaveLength(0)
  })

  it('rejects a drop captured before selection changes without touching the new selection', () => {
    const f = fixture(), snapshot = f.begin()!
    f.stateRef.current = model.selectEditorLayer(f.stateRef.current, 'layer-3'); const current = f.stateRef.current
    expect(f.inspect(snapshot, f.b, 'inside')).toContain('已变化'); expect(f.place(snapshot, f.b, 'inside').ok).toBe(false)
    expect(f.stateRef.current).toBe(current); expect(current.past).toHaveLength(0)
  })

  it('promotes an explicitly grabbed folder to group primary rather than moving its directly selected leaves', () => {
    const f = fixture(); f.stateRef.current = model.selectEditorLayer(f.stateRef.current, 'layer-2', { toggle: true })
    const row = model.editorLayerTreeRows(f.stateRef.current.present).find((item) => item.id === f.a)!
    const snapshot = f.begin(row)!
    expect(snapshot.selectedGroupId).toBe(f.a); expect(snapshot.selectedId).toBeNull(); expect(f.stateRef.current.past).toHaveLength(0)
    expect(f.place(snapshot, f.b, 'inside').ok).toBe(true)
    expect(model.editorLayerTreeRows(f.stateRef.current.present).find((item) => item.id === f.a)?.parentId).toBe(f.b)
  })

  it('retains locks and refuses a stale or protected target without a partial history entry', () => {
    const f = fixture(); f.stateRef.current = model.patchEditorGroup(f.stateRef.current, f.b, { locked: true }); f.stateRef.current.past = []
    const snapshot = f.begin()!, before = f.stateRef.current
    expect(f.inspect(snapshot, f.b, 'inside')).not.toBe(''); expect(f.place(snapshot, f.b, 'inside').ok).toBe(false)
    expect(f.stateRef.current).toBe(before); expect(before.past).toHaveLength(0)
  })
})

describe('real tree pointer and keyboard placement events', () => {
  it('moves through the keyboard target and position controls using the same validated action', () => {
    const f = fixture(), ui = treeHarness(f); let tree = ui.render()
    ;(button(tree, '移动到…').props.onClick as () => void)(); tree = ui.render()
    const target = elements(tree, 'select').find((item) => item.props['aria-label'] === '移动目标')!
    ;(target.props.onChange as (event: unknown) => void)({ target: { value: f.b } }); tree = ui.render()
    ;(button(tree, '确认移动').props.onClick as () => void)(); tree = ui.render()
    expect(model.editorLayerEffectiveState(f.stateRef.current.present, 'layer-1').parentId).toBe(f.b)
    expect(f.stateRef.current.past).toHaveLength(1); expect(elements(tree, 'select')).toHaveLength(0); ui.close()
  })

  it('maps pointer hover to a group inside drop and commits only on pointer release', () => {
    const f = fixture(), ui = treeHarness(f); let tree = ui.render()
    const list = elements(tree, 'ul').find((item) => item.props['aria-label'] === '图层与编组')!
    const hit = { dataset: { layerTreeRow: f.b }, getBoundingClientRect: () => ({ top: 40, height: 40 }) }
    vi.stubGlobal('document', { elementFromPoint: () => ({ closest: (selector: string) => selector === '[data-layer-tree-row]' ? hit : null }) })
    ;(list.props.ref as { current: unknown }).current = { contains: () => true, parentElement: { contains: () => true }, querySelectorAll: () => [] }
    const handle = { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() }, event = { button: 0, pointerId: 7, clientX: 10, clientY: 20, currentTarget: handle, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    ;(button(tree, '拖动移动图层 Leaf 1').props.onPointerDown as (event: unknown) => void)(event); tree = ui.render()
    ;(button(tree, '拖动移动图层 Leaf 1').props.onPointerMove as (event: unknown) => void)({ ...event, clientY: 60 }); tree = ui.render()
    expect(f.stateRef.current.past).toHaveLength(0); expect(textOf(tree)).toContain('移入 Copy 最上方')
    ;(button(tree, '拖动移动图层 Leaf 1').props.onPointerUp as (event: unknown) => void)({ ...event, clientY: 60 }); ui.render()
    expect(f.stateRef.current.past).toHaveLength(1); expect(model.editorLayerEffectiveState(f.stateRef.current.present, 'layer-1').parentId).toBe(f.b)
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7); ui.close()
  })

  it('cancels pointer capture through Escape without changing hierarchy or history', () => {
    const f = fixture(), ui = treeHarness(f); let tree = ui.render()
    const handle = { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() }
    ;(button(tree, '拖动移动图层 Leaf 1').props.onPointerDown as (event: unknown) => void)({ button: 0, pointerId: 9, clientX: 0, clientY: 0, currentTarget: handle, preventDefault: vi.fn(), stopPropagation: vi.fn() })
    tree = ui.render(); const root = elements(tree, 'div').find((item) => String(item.props.className).startsWith('layer-editor-tree-wrap'))!
    const stop = vi.fn(); (root.props.onKeyDown as (event: unknown) => void)({ key: 'Escape', nativeEvent: {}, preventDefault: vi.fn(), stopPropagation: stop })
    expect(f.stateRef.current).toBe(f.original); expect(handle.releasePointerCapture).toHaveBeenCalledWith(9); expect(stop).toHaveBeenCalledOnce(); ui.close()
  })
})
