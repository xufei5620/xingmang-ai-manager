import { afterEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef(initial: unknown) { const index = runtime.cursor++; runtime.slots[index] ??= { current: initial }; return runtime.slots[index] },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) {
    const index = runtime.cursor++, previous = runtime.slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined
    if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return
    runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } })
  },
}))
import { CanvasContextMenu, type CanvasContextMenuState } from './CanvasContextMenu'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type: unknown): ElementShape[] {
  if (Array.isArray(value)) return value.flatMap((item) => elements(item, type))
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const element = value as ElementShape
  return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)]
}
function state(): CanvasContextMenuState {
  return { target: 'node', nodeId: 'node-a', nodeIds: ['node-a'], x: 120, y: 80, selectionCount: 1, executable: true, running: false, hasGroup: false, allLocked: false, allDisabled: false, canDisable: true }
}
function harness() {
  type Listener = (event: { target: unknown }) => void
  const listeners = new Map<string, Set<Listener>>()
  const doc = {
    activeElement: null as FakeElement | null,
    addEventListener: vi.fn((name: string, listener: Listener) => { const entries = listeners.get(name) ?? new Set<Listener>(); entries.add(listener); listeners.set(name, entries) }),
    removeEventListener: vi.fn((name: string, listener: Listener) => { listeners.get(name)?.delete(listener) }),
  }
  class FakeElement {
    isConnected = true
    visible = true
    tagName = 'BUTTON'
    open = false
    parentElement: FakeElement | null = null
    children: FakeElement[] = []
    focus = vi.fn((_options?: FocusOptions) => {
      // Chromium can report layout rects for controls inside a closed details
      // while refusing focus on anything except its own first summary.
      for (let parent = this.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open && parent.children[0] !== this) return
      doc.activeElement = this; dispatch('focusin', { target: this })
    })
    scrollIntoView = vi.fn()
    contains(target: unknown): boolean { return target === this || this.children.some((item) => item.contains(target)) }
    matches(selector: string) { return selector.includes('details') && this.tagName === 'DETAILS' && (!selector.includes(':not([open])') || !this.open) || selector.includes('summary') && this.tagName === 'SUMMARY' }
    hasAttribute(name: string) { return name === 'open' && this.open }
    closest(selector: string): FakeElement | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null }
    querySelector(selector: string) { return this.querySelectorAll().find((item) => item.visible && (!selector.startsWith(':scope') || item.parentElement === this) && (!selector.includes('summary') || selector.includes('button') || item.tagName === 'SUMMARY')) }
    querySelectorAll(): FakeElement[] { return this.children.flatMap((item) => [...(item.tagName === 'DETAILS' ? [] : [item]), ...item.querySelectorAll()]) }
    getClientRects() { return this.visible ? [{}] : [] }
  }
  function dispatch(name: string, event: { target: unknown }) { for (const listener of [...(listeners.get(name) ?? [])]) listener(event) }
  vi.stubGlobal('document', doc); vi.stubGlobal('Node', FakeElement); vi.stubGlobal('HTMLElement', FakeElement)
  runtime.cursor = 0; runtime.slots = []; runtime.effects = []
  const trigger = new FakeElement(), outside = new FakeElement(), menu = new FakeElement()
  const items = Array.from({ length: 5 }, () => new FakeElement()); items[2].visible = false; menu.children = items
  doc.activeElement = trigger
  const props = { state: state(), onAction: vi.fn(), onClose: vi.fn() }
  let tree: ElementShape
  function render() {
    runtime.cursor = 0; tree = CanvasContextMenu(props) as ElementShape
    ;(tree.props.ref as { current: unknown }).current = menu
    runtime.effects.splice(0).forEach((effect) => effect())
    return tree
  }
  function key(key: string, extra: object = {}) {
    let stopped = false
    const event = { key, target: doc.activeElement, nativeEvent: { isComposing: false, keyCode: 0 }, preventDefault: vi.fn(), stopPropagation: vi.fn(() => { stopped = true }), ...extra }
    ;(tree.props.onKeyDown as (event: unknown) => void)(event)
    if (!stopped) dispatch('keydown', event)
    return event
  }
  function cleanup() { for (const slot of runtime.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup(): void }).cleanup() }
  render()
  return { render, key, cleanup, props, doc, menu, trigger, outside, items, listeners, dispatch, tree: () => tree, element(tagName: string, parent?: FakeElement) { const value = new FakeElement(); value.tagName = tagName; if (parent) { value.parentElement = parent; parent.children.push(value) }; return value } }
}
afterEach(() => vi.unstubAllGlobals())

describe('canvas context menu actual keyboard and focus lifecycle', () => {
  it('preserves the focused row across background rerenders and uses the newest close callback', () => {
    const ui = harness(), oldClose = ui.props.onClose
    ui.items[3].focus(); ui.props.onClose = vi.fn(); ui.render()
    expect(ui.doc.activeElement === ui.items[3]).toBe(true)
    ui.key('Escape')
    expect(oldClose).not.toHaveBeenCalled(); expect(ui.props.onClose).toHaveBeenCalledOnce()
    ui.cleanup()
  })
  it('navigates only visible controls and scrolls keyboard targets into view', () => {
    const ui = harness()
    for (const [key, index] of [['ArrowUp', 4], ['ArrowDown', 0], ['End', 4], ['Home', 0], ['ArrowDown', 1], ['ArrowDown', 3]] as const) {
      const event = ui.key(key)
      expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce()
      expect(ui.doc.activeElement === ui.items[index]).toBe(true); expect(ui.items[index].scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
    }
    ui.cleanup()
  })
  it('skips closed details buttons even when Chromium reports layout rects and restores their navigation when opened', () => {
    const ui = harness(); ui.menu.children = []
    const details = ui.element('DETAILS', ui.menu), summary = ui.element('SUMMARY', details), first = ui.element('BUTTON', details), second = ui.element('BUTTON', details), next = ui.element('BUTTON', ui.menu)
    expect(first.getClientRects()).toHaveLength(1); expect(second.getClientRects()).toHaveLength(1)
    summary.focus(); ui.key('ArrowDown')
    expect(ui.doc.activeElement === next).toBe(true); expect(first.focus).not.toHaveBeenCalled(); expect(second.focus).not.toHaveBeenCalled()
    ui.key('Home'); expect(ui.doc.activeElement === summary).toBe(true)
    details.open = true
    ui.key('ArrowDown'); expect(ui.doc.activeElement === first).toBe(true)
    ui.key('ArrowDown'); expect(ui.doc.activeElement === second).toBe(true)
    ui.key('ArrowDown'); expect(ui.doc.activeElement === next).toBe(true); ui.cleanup()
  })
  it('checks every closed details ancestor while retaining its own summary as a navigable control', () => {
    const ui = harness(); ui.menu.children = []
    const outer = ui.element('DETAILS', ui.menu), outerSummary = ui.element('SUMMARY', outer), inner = ui.element('DETAILS', outer), innerSummary = ui.element('SUMMARY', inner), child = ui.element('BUTTON', inner), next = ui.element('BUTTON', ui.menu)
    inner.open = true; outerSummary.focus(); ui.key('ArrowDown')
    expect(ui.doc.activeElement === next).toBe(true); expect(innerSummary.focus).not.toHaveBeenCalled(); expect(child.focus).not.toHaveBeenCalled()
    outer.open = true; inner.open = false; outerSummary.focus(); ui.key('ArrowDown')
    expect(ui.doc.activeElement === innerSummary).toBe(true)
    ui.key('ArrowDown'); expect(ui.doc.activeElement === next).toBe(true); expect(child.focus).not.toHaveBeenCalled(); ui.cleanup()
  })
  it('returns focus on Escape once without letting a canvas shortcut handle the same key', () => {
    const ui = harness(), event = ui.key('Escape')
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(ui.doc.activeElement === ui.trigger).toBe(true); expect(ui.props.onClose).toHaveBeenCalledOnce()
    ui.key('Escape'); expect(ui.props.onClose).toHaveBeenCalledOnce(); ui.cleanup()
  })
  it.each([true, false])('closes on Tab with shift=%s without stealing native traversal focus', (shiftKey) => {
    const ui = harness(), current = ui.doc.activeElement, event = ui.key('Tab', { shiftKey })
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(ui.doc.activeElement === current).toBe(true); expect(ui.trigger.focus).not.toHaveBeenCalled(); expect(ui.props.onClose).toHaveBeenCalledOnce(); ui.cleanup()
  })
  it('dismisses after outside focus without reclaiming focus or retaining document keyboard interception', () => {
    const ui = harness()
    ui.outside.focus()
    expect(ui.props.onClose).toHaveBeenCalledOnce(); expect(ui.doc.activeElement === ui.outside).toBe(true)
    expect(ui.listeners.get('keydown')?.size ?? 0).toBe(0)
    ui.dispatch('keydown', { target: ui.outside }); expect(ui.doc.activeElement === ui.outside).toBe(true); ui.cleanup()
  })
  it('dismisses outside pointer input without restoring focus over the clicked control', () => {
    const ui = harness()
    ui.dispatch('pointerdown', { target: ui.items[1] }); expect(ui.props.onClose).not.toHaveBeenCalled()
    ui.dispatch('pointerdown', { target: ui.outside }); ui.outside.focus()
    expect(ui.props.onClose).toHaveBeenCalledOnce(); expect(ui.doc.activeElement === ui.outside).toBe(true); expect(ui.trigger.focus).not.toHaveBeenCalled(); ui.cleanup()
  })
  it('preserves native summary and button activation while isolating canvas document shortcuts', () => {
    const ui = harness()
    for (const key of ['Enter', ' ', 'Delete', 'Backspace', 'a', 'z']) {
      const event = ui.key(key, { ctrlKey: true })
      expect(event.stopPropagation).toHaveBeenCalledOnce(); expect(event.preventDefault).not.toHaveBeenCalled()
    }
    expect(ui.props.onClose).not.toHaveBeenCalled(); expect(ui.props.onAction).not.toHaveBeenCalled(); ui.cleanup()
  })
  it.each([{ isComposing: true, keyCode: 0 }, { isComposing: false, keyCode: 229 }])('leaves IME keys alone for %j', (nativeEvent) => {
    const ui = harness(), current = ui.doc.activeElement
    for (const key of ['Escape', 'ArrowDown', 'Enter']) {
      const event = ui.key(key, { nativeEvent })
      expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).toHaveBeenCalledOnce()
    }
    expect(ui.props.onClose).not.toHaveBeenCalled(); expect(ui.doc.activeElement === current).toBe(true); ui.cleanup()
  })
  it('keeps action clicks ordered and prevents disabled actions from closing the menu', () => {
    const ui = harness(); ui.props.state = { ...ui.props.state, running: true, batchImages: { disabledReason: '请先选择至少两张图片' } }; const tree = ui.render()
    const buttons = elements(tree, 'button'), batch = buttons.find((item) => item.props['aria-disabled'] === true)!
    ;(batch.props.onClick as () => void)(); expect(ui.props.onClose).not.toHaveBeenCalled(); expect(ui.props.onAction).not.toHaveBeenCalled()
    const copy = buttons.find((item) => item.props.children === '复制')!
    ;(copy.props.onClick as () => void)()
    expect(ui.props.onClose).toHaveBeenCalledOnce(); expect(ui.props.onAction).toHaveBeenCalledExactlyOnceWith('copy', 'node-a')
    expect(ui.props.onClose.mock.invocationCallOrder[0]).toBeLessThan(ui.props.onAction.mock.invocationCallOrder[0]); ui.cleanup()
  })
  it('removes its owned outside listeners on unmount and ignores detached focus targets', () => {
    const ui = harness(); ui.trigger.isConnected = false
    ui.key('Escape'); expect(ui.trigger.focus).not.toHaveBeenCalled(); ui.cleanup()
    expect([...ui.listeners.values()].every((entries) => entries.size === 0)).toBe(true)
  })
  it('ignores retained callbacks after unmount or after an action has already closed the menu', () => {
    for (const unmount of [false, true]) {
      const ui = harness(), copy = elements(ui.tree(), 'button').find((item) => item.props.children === '复制')!
      const click = copy.props.onClick as () => void
      if (unmount) ui.cleanup()
      else click()
      click()
      expect(ui.props.onAction).toHaveBeenCalledTimes(unmount ? 0 : 1); expect(ui.props.onClose).toHaveBeenCalledTimes(unmount ? 0 : 1)
      if (!unmount) ui.cleanup()
    }
  })
})
