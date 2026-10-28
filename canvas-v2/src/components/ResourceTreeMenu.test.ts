import { afterEach, describe, expect, it, vi } from 'vitest'
const runtime = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useMemo(factory: () => unknown) { return factory() },
  useState(initial: unknown) { const index = runtime.cursor++; if (!(index in runtime.slots)) runtime.slots[index] = typeof initial === 'function' ? initial() : initial; return [runtime.slots[index], (value: unknown) => { runtime.slots[index] = typeof value === 'function' ? value(runtime.slots[index]) : value }] },
  useRef(initial: unknown) { const index = runtime.cursor++; runtime.slots[index] ??= { current: initial }; return runtime.slots[index] },
  useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
    const index = runtime.cursor++, previous = runtime.slots[index] as { deps: readonly unknown[]; cleanup?: () => void } | undefined
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
    runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index] = { deps, ...(typeof cleanup === 'function' ? { cleanup } : {}) } })
  },
}))
import { ResourceTreeMenu } from './ResourceTreeMenu'
import { ResourceTree } from './ResourceTree'
interface Element { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap((entry) => elements(entry, type))
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const item = value as Element
  return [...(item.type === type ? [item] : []), ...elements(item.props.children, type)]
}
function reset() { runtime.cursor = 0; runtime.slots = []; runtime.effects = [] }
function cleanup() { for (const value of runtime.slots) if (value && typeof value === 'object' && 'cleanup' in value) (value as { cleanup(): void }).cleanup() }
function event(key: string, extra: object = {}) { return { key, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra } }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('resource tree keyboard ownership', () => {
  it('does not let focused resource controls delete or duplicate a separately selected canvas node', () => {
    reset()
    const props = { nodes: [{ id: 'a', type: 'prompt', selected: true, data: {} }, { id: 'b', type: 'image-input', data: {} }], onSelect: vi.fn(), onRename: vi.fn(), onGroup: vi.fn(), onLock: vi.fn(), onExport: vi.fn(), canExport: true }
    const tree = ResourceTree(props) as Element, canvasDelete = vi.fn(), canvasDuplicate = vi.fn()
    for (const key of ['Delete', 'Backspace', 'd', 'z', 'a']) {
      const input = event(key, { ctrlKey: true })
      ;(tree.props.onKeyDown as (value: unknown) => void)(input)
      if (!input.stopPropagation.mock.calls.length) { if (key === 'Delete') canvasDelete('a'); if (key === 'd') canvasDuplicate('a') }
      expect(input.stopPropagation).toHaveBeenCalledOnce()
      expect(input.preventDefault).not.toHaveBeenCalled()
    }
    expect(canvasDelete).not.toHaveBeenCalled(); expect(canvasDuplicate).not.toHaveBeenCalled(); expect(props.onSelect).not.toHaveBeenCalled()
  })
  it('keeps the existing selection and applies explicit menu actions to the opened row', () => {
    reset()
    const props = { nodes: [{ id: 'a', type: 'prompt', selected: true, data: {} }, { id: 'b', type: 'image-input', data: {} }], onSelect: vi.fn(), onRename: vi.fn(), onGroup: vi.fn(), onLock: vi.fn(), onExport: vi.fn(), canExport: true }
    let tree = ResourceTree(props) as Element
    const trigger = { isConnected: true, focus: vi.fn() }
    ;(elements(tree, 'button').find((entry) => entry.props['aria-label'] === '图片素材的资源操作')!.props.onClick as (e: unknown) => void)({ currentTarget: trigger })
    runtime.cursor = 0; tree = ResourceTree(props) as Element
    const panel = elements(tree, ResourceTreeMenu)[0]
    expect(panel.props.title).toBe('图片素材')
    const actions = elements(panel, 'button')
    ;(actions[0].props.onClick as () => void)()
    expect(props.onRename).toHaveBeenCalledExactlyOnceWith('b')
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true })
  })
  it('offers package export in the selection bar and row menu only when the host can export packages', () => {
    for (const canExport of [true, false]) {
      reset()
      const props = { nodes: [{ id: 'a', type: 'prompt', selected: true, data: {} }, { id: 'b', type: 'image-input', data: {} }], onSelect: vi.fn(), onRename: vi.fn(), onGroup: vi.fn(), onLock: vi.fn(), onExport: vi.fn(), canExport }
      let tree = ResourceTree(props) as Element
      expect(elements(tree, 'button').some((entry) => entry.props.title === '打包选中节点、整组子项与内部连线，预检后携带可用的图片、视频与音频')).toBe(canExport)
      ;(elements(tree, 'button').find((entry) => entry.props['aria-label'] === '图片素材的资源操作')!.props.onClick as (e: unknown) => void)({ currentTarget: { isConnected: true, focus: vi.fn() } })
      runtime.cursor = 0; tree = ResourceTree(props) as Element
      const labels = elements(elements(tree, ResourceTreeMenu)[0], 'button').map((entry) => JSON.stringify(entry.props.children))
      expect(labels.some((label) => label.includes('打包导出'))).toBe(canExport)
      expect(labels.some((label) => label.includes('重命名'))).toBe(true)
    }
  })
  it('removes an open menu when filtering hides its original row', () => {
    reset()
    const props = { nodes: [{ id: 'a', type: 'prompt', data: {} }], onSelect: vi.fn(), onRename: vi.fn(), onGroup: vi.fn(), onLock: vi.fn(), onExport: vi.fn(), canExport: true }
    let tree = ResourceTree(props) as Element
    ;(elements(tree, 'button').find((entry) => entry.props['aria-label'] === '提示词的资源操作')!.props.onClick as (e: unknown) => void)({ currentTarget: { isConnected: true, focus: vi.fn() } })
    runtime.cursor = 0; tree = ResourceTree(props) as Element
    ;(elements(tree, 'input')[0].props.onChange as (e: unknown) => void)({ target: { value: 'missing' } })
    runtime.effects = []; runtime.cursor = 0; tree = ResourceTree(props) as Element
    runtime.effects.splice(0).forEach((effect) => effect())
    runtime.cursor = 0; tree = ResourceTree(props) as Element
    expect(elements(tree, ResourceTreeMenu)).toHaveLength(0)
    expect(props.onRename).not.toHaveBeenCalled()
  })
})

function menuHarness(edge: 'first' | 'last' = 'first', count = 3) {
  reset()
  class Target { contains(target: unknown): boolean { return target === this } }
  const listeners = new Map<string, (event: { target: unknown }) => void>()
  const items = Array.from({ length: count }, () => ({ focus: vi.fn(), scrollIntoView: vi.fn() }))
  const menu = Object.assign(new Target(), { querySelectorAll: () => items, focus: vi.fn() })
  const trigger = new Target(), outside = new Target()
  const doc = { activeElement: items[0], addEventListener: vi.fn((name: string, callback) => listeners.set(name, callback)), removeEventListener: vi.fn() }
  vi.stubGlobal('document', doc); vi.stubGlobal('Node', Target)
  const props = { id: 'test', title: 'B', triggerRef: { current: trigger as unknown as HTMLButtonElement }, focusEdge: edge, onClose: vi.fn(), children: null }
  let tree: Element
  function render() {
    runtime.cursor = 0; tree = ResourceTreeMenu(props) as Element
    ;(tree.props.ref as { current: unknown }).current = menu
    runtime.effects.splice(0).forEach((effect) => effect())
  }
  function key(key: string, extra: object = {}) { const input = event(key, extra); (tree.props.onKeyDown as (value: unknown) => void)(input); return input }
  render()
  return { props, items, menu, trigger, outside, doc, listeners, render, key }
}
describe('resource menu keyboard and focus lifecycle', () => {
  it.each(['first', 'last'] as const)('focuses the requested enabled edge %s without taking a canvas action', (edge) => {
    const ui = menuHarness(edge)
    expect(ui.items[edge === 'first' ? 0 : 2].focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
    for (const [key, index] of [['ArrowUp', 2], ['ArrowDown', 1], ['End', 2], ['Home', 0]] as const) {
      const input = ui.key(key)
      expect(input.stopPropagation).toHaveBeenCalledOnce(); expect(input.preventDefault).toHaveBeenCalledOnce()
      expect(ui.items[index].focus).toHaveBeenLastCalledWith({ preventScroll: true })
    }
  })
  it('owns Delete and modifier keys while retaining native Enter, Space and Tab', () => {
    const ui = menuHarness()
    for (const key of ['Delete', 'Backspace', 'd', 'z', 'Enter', ' ']) {
      const input = ui.key(key, { metaKey: true })
      expect(input.stopPropagation).toHaveBeenCalledOnce(); expect(input.preventDefault).not.toHaveBeenCalled()
    }
    const escape = ui.key('Escape'); expect(escape.preventDefault).toHaveBeenCalledOnce(); expect(ui.props.onClose).toHaveBeenLastCalledWith(true)
    const tab = ui.key('Tab'); expect(tab.preventDefault).not.toHaveBeenCalled(); expect(ui.props.onClose).toHaveBeenLastCalledWith(true)
  })
  it('does not close or navigate on composition keys', () => {
    const ui = menuHarness(), input = ui.key('Escape', { nativeEvent: { isComposing: true } })
    expect(input.stopPropagation).toHaveBeenCalledOnce(); expect(input.preventDefault).not.toHaveBeenCalled(); expect(ui.props.onClose).not.toHaveBeenCalled()
  })
  it('dismisses outside pointer and focus without reclaiming focus or retaining listeners', () => {
    const ui = menuHarness()
    ui.listeners.get('pointerdown')!({ target: ui.menu }); ui.listeners.get('focusin')!({ target: ui.trigger })
    expect(ui.props.onClose).not.toHaveBeenCalled()
    ui.listeners.get('pointerdown')!({ target: ui.outside }); expect(ui.props.onClose).toHaveBeenLastCalledWith(false)
    ui.listeners.get('focusin')!({ target: ui.outside }); expect(ui.props.onClose).toHaveBeenLastCalledWith(false)
    cleanup(); expect(ui.doc.removeEventListener).toHaveBeenCalledTimes(2)
  })
  it('uses the latest close callback without refocusing on background rerenders', () => {
    const ui = menuHarness(), old = ui.props.onClose
    ui.props.onClose = vi.fn(); ui.render(); ui.key('Escape')
    expect(ui.items[0].focus).toHaveBeenCalledOnce(); expect(old).not.toHaveBeenCalled(); expect(ui.props.onClose).toHaveBeenCalledWith(true)
  })
  it('can focus the menu itself when every action is unavailable', () => {
    const ui = menuHarness('first', 0)
    expect(ui.menu.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
    expect(ui.key('ArrowDown').preventDefault).not.toHaveBeenCalled()
    ui.key('Escape'); expect(ui.props.onClose).toHaveBeenCalledWith(true)
  })
})
