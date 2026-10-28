import { readFileSync } from 'node:fs'
import { createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelectionToolbar, type SelectionToolbarProps } from './SelectionToolbar'
import { SelectionToolbarMenuItems } from './SelectionToolbarMenu'
import { selectionMenuKey, selectionToolbarActions, type SelectionToolbarActionId, type SelectionToolbarMenuKind } from './selection-toolbar-model'

function fixture(overrides: Partial<SelectionToolbarProps> = {}): SelectionToolbarProps {
  return { count: 14, canGroup: true, canUngroup: true, allLocked: false, canToggleDisabled: true, allDisabled: false, onAlign: vi.fn(), onDistribute: vi.fn(), onCopy: vi.fn(), onDuplicate: vi.fn(), onGroup: vi.fn(), onUngroup: vi.fn(), onToggleLocked: vi.fn(), onToggleDisabled: vi.fn(), onFocus: vi.fn(), onInspect: vi.fn(), onSaveWorkshop: vi.fn(), onSendAgent: vi.fn(), onDelete: vi.fn(), ...overrides }
}
function actual<T>(file: string, name: string, environment: Record<string, unknown>): T {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source)
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'useCallback') expression = node.initializer.arguments[0].getText(source)
    if (name === 'menuEffect' && ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') expression = node.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
interface MenuButton { 'aria-label': string; 'aria-disabled': boolean; onClick(): void }
function menuButtons(node: ReactNode): MenuButton[] {
  if (Array.isArray(node)) return node.flatMap(menuButtons)
  if (!isValidElement<{ children?: ReactNode } & MenuButton>(node)) return []
  return node.type === 'button' ? [node.props] : menuButtons(node.props.children)
}
function actions(props: SelectionToolbarProps, kind: SelectionToolbarMenuKind) { return selectionToolbarActions({ ...props, canSaveWorkshop: Boolean(props.onSaveWorkshop), canSendAgent: Boolean(props.onSendAgent), hasRunActions: Boolean(props.onRunTo && props.onRunFrom) }, kind) }
function event(key: string, extra: object = {}) { return { key, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra } }
afterEach(() => vi.unstubAllGlobals())

describe('selection toolbar responsive operation entry', () => {
  it.each([1, 2, 14, 2000])('renders only four named controls for %s selected nodes', (count) => {
    const html = renderToStaticMarkup(createElement(SelectionToolbar, fixture({ count })))
    expect(html.match(/<button /g)).toHaveLength(4)
    for (const name of ['详情', '聚焦', '布局', '更多']) expect(html).toContain(`>${name}</span>`)
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(2)
    expect(html).not.toContain('overflow-x')
  })
  it('removes the toolbar when the selection becomes empty', () => {
    expect(renderToStaticMarkup(createElement(SelectionToolbar, fixture({ count: 0 })))).toBe('')
  })
  it('adds one compact run menu only for a single runnable node', () => {
    const props = fixture({ count: 1, onRunTo: vi.fn(), onRunFrom: vi.fn() })
    const html = renderToStaticMarkup(createElement(SelectionToolbar, props))
    expect(html.match(/<button /g)).toHaveLength(5)
    expect(html).toContain('aria-label="选中节点运行"'); expect(html).not.toContain('bottom:56')
    expect(renderToStaticMarkup(createElement(SelectionToolbar, { ...props, count: 2 }))).not.toContain('aria-label="选中节点运行"')
  })
  it('constrains the short toolbar to the canvas and allows wrapping instead of clipping actions', () => {
    const css = readFileSync(new URL('./selection-toolbar.css', import.meta.url), 'utf8')
    const rule = css.match(/\.canvas-selection-toolbar \{([^}]+)\}/)?.[1] ?? ''
    expect(rule).toContain('max-width: calc(100% - 16px)')
    expect(rule).toContain('flex-wrap: wrap')
    expect(rule).not.toMatch(/overflow|width: 602/)
    expect(css).toContain('position: fixed')
    expect(css).toContain('overflow-y: auto')
    expect(css).toContain('overscroll-behavior: contain')
    expect(readFileSync(new URL('../styles.css', import.meta.url), 'utf8')).not.toContain('.canvas-selection-toolbar')
  })
})

describe('selection menu actual action callbacks', () => {
  it.each([['run-to', 'onRunTo'], ['run-from', 'onRunFrom']] as const)('routes %s from the unified toolbar and preserves disabled explanations', (id, callback) => {
    const props = fixture({ count: 1, onRunTo: vi.fn(), onRunFrom: vi.fn() }), close = vi.fn()
    const available = actions(props, 'run')
    const activate = actual<(id: SelectionToolbarActionId) => void>('./SelectionToolbar.tsx', 'activate', { actions: available, close, props })
    const button = menuButtons(SelectionToolbarMenuItems({ id: 'run', actions: available, onActivate: activate })).find((item) => item['aria-label'] === available.find((item) => item.id === id)?.ariaLabel)!
    button.onClick(); expect(props[callback]).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledWith(true)
    const disabled = actions({ ...props, runDisabledReason: '此节点正在运行' }, 'run')
    const blocked = actual<(id: SelectionToolbarActionId) => void>('./SelectionToolbar.tsx', 'activate', { actions: disabled, close, props })
    blocked(id); expect(props[callback]).toHaveBeenCalledOnce()
    expect(renderToStaticMarkup(SelectionToolbarMenuItems({ id: 'run', actions: disabled, onActivate: blocked }))).toContain('此节点正在运行')
  })
  const expected: [SelectionToolbarActionId, keyof SelectionToolbarProps, string?][] = [
    ['agent', 'onSendAgent'], ['inspect', 'onInspect'], ['focus', 'onFocus'], ['copy', 'onCopy'], ['duplicate', 'onDuplicate'], ['save', 'onSaveWorkshop'], ['lock', 'onToggleLocked'], ['disable', 'onToggleDisabled'], ['group', 'onGroup'], ['ungroup', 'onUngroup'], ['delete', 'onDelete'],
    ['align:left', 'onAlign', 'left'], ['align:horizontal-center', 'onAlign', 'horizontal-center'], ['align:right', 'onAlign', 'right'], ['align:top', 'onAlign', 'top'], ['align:vertical-center', 'onAlign', 'vertical-center'], ['align:bottom', 'onAlign', 'bottom'], ['distribute:horizontal', 'onDistribute', 'horizontal'], ['distribute:vertical', 'onDistribute', 'vertical'],
  ]
  it.each(expected)('routes %s to its existing document callback exactly once after closing', (id, callback, argument) => {
    const props = fixture(), close = vi.fn()
    const available = actions(props, id.startsWith('align:') || id.startsWith('distribute:') ? 'layout' : 'more')
    const activate = actual<(id: SelectionToolbarActionId) => void>('./SelectionToolbar.tsx', 'activate', { actions: available, close, props })
    const button = menuButtons(SelectionToolbarMenuItems({ id: 'test', actions: available, onActivate: activate })).find((item) => item['aria-label'] === available.find((item) => item.id === id)?.ariaLabel)
    expect(button).toBeDefined()
    button!.onClick()
    expect(close).toHaveBeenCalledExactlyOnceWith(true)
    expect(props[callback]).toHaveBeenCalledTimes(1)
    if (argument) expect(props[callback]).toHaveBeenCalledWith(argument)
    else expect(props[callback]).toHaveBeenCalledWith()
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(props[callback] as () => void).mock.invocationCallOrder[0])
  })
  it('keeps disabled explanations keyboard-readable while preventing mouse and retained callback mutations', () => {
    const props = fixture({ count: 1, canGroup: false, canUngroup: false, canToggleDisabled: false })
    for (const kind of ['layout', 'more'] as const) {
      const available = actions(props, kind), close = vi.fn()
      const activate = actual<(id: SelectionToolbarActionId) => void>('./SelectionToolbar.tsx', 'activate', { actions: available, close, props })
      const tree = SelectionToolbarMenuItems({ id: 'disabled', actions: available, onActivate: activate })
      const html = renderToStaticMarkup(tree)
      expect(html).toContain('aria-disabled="true"')
      expect(html).toContain('aria-describedby="disabled-')
      expect(html).not.toContain(' disabled=""')
      for (const button of menuButtons(tree).filter((item) => item['aria-disabled'])) button.onClick()
      for (const action of available.filter((item) => item.disabledReason)) activate(action.id)
      expect(close).not.toHaveBeenCalled()
    }
    for (const value of Object.values(props)) if (vi.isMockFunction(value)) expect(value).not.toHaveBeenCalled()
  })
  it('never invents a workshop capability or invokes an action absent from the current menu', () => {
    const props = fixture({ onSaveWorkshop: undefined }), close = vi.fn()
    const activate = actual<(id: SelectionToolbarActionId) => void>('./SelectionToolbar.tsx', 'activate', { actions: actions(props, 'layout'), close, props })
    activate('delete'); activate('save')
    expect(close).not.toHaveBeenCalled()
    expect(props.onDelete).not.toHaveBeenCalled()
  })
})

describe('selection menu actual keyboard and focus lifecycle', () => {
  function keyboard() {
    const items = Array.from({ length: 8 }, () => ({ focus: vi.fn(), scrollIntoView: vi.fn() }))
    const onClose = { current: vi.fn() }
    vi.stubGlobal('document', { activeElement: items[0] })
    const keyDown = actual<(value: ReturnType<typeof event>) => void>('./SelectionToolbarMenu.tsx', 'keyDown', { menu: { current: { querySelectorAll: () => items } }, onClose, selectionMenuKey, document })
    return { keyDown, items, onClose }
  }
  it('focuses and scrolls the requested row with arrows and Home/End', () => {
    const { keyDown, items } = keyboard()
    for (const [key, index] of [['ArrowUp', 7], ['ArrowDown', 1], ['End', 7], ['Home', 0]] as const) {
      const input = event(key); keyDown(input)
      expect(input.stopPropagation).toHaveBeenCalledOnce()
      expect(input.preventDefault).toHaveBeenCalledOnce()
      expect(items[index].focus).toHaveBeenCalledWith({ preventScroll: true })
      expect(items[index].scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    }
  })
  it('returns focus on Escape and Tab while preserving native Tab and button activation', () => {
    const { keyDown, onClose } = keyboard()
    const escape = event('Escape'); keyDown(escape)
    expect(onClose.current).toHaveBeenLastCalledWith(true)
    expect(escape.preventDefault).toHaveBeenCalledOnce()
    for (const shiftKey of [true, false]) {
      const tab = event('Tab', { shiftKey }); keyDown(tab)
      expect(onClose.current).toHaveBeenLastCalledWith(true)
      expect(tab.preventDefault).not.toHaveBeenCalled()
    }
    const closeCount = onClose.current.mock.calls.length
    for (const key of ['Enter', ' ', 'Delete', 'Backspace', 'a', 'z']) {
      const input = event(key); keyDown(input)
      expect(input.stopPropagation).toHaveBeenCalledOnce()
      expect(input.preventDefault).not.toHaveBeenCalled()
    }
    expect(onClose.current).toHaveBeenCalledTimes(closeCount)
  })
  it('does not navigate or close while an IME composition owns the key', () => {
    const { keyDown, onClose, items } = keyboard()
    const input = event('Escape', { nativeEvent: { isComposing: true } }); keyDown(input)
    expect(input.stopPropagation).toHaveBeenCalledOnce()
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(onClose.current).not.toHaveBeenCalled()
    expect(items.every((item) => item.focus.mock.calls.length === 0)).toBe(true)
  })
  it('isolates toolbar Delete and modified canvas commands without firing a document action', () => {
    const items = Array.from({ length: 4 }, () => ({ focus: vi.fn() }))
    vi.stubGlobal('document', { activeElement: items[1] })
    const toolbarKey = actual<(input: ReturnType<typeof event>) => void>('./SelectionToolbar.tsx', 'toolbarKey', { toolbarRef: { current: { querySelectorAll: () => items } }, document })
    for (const key of ['Delete', 'Backspace', 'a', 'z', 'Enter']) { const input = event(key, { ctrlKey: true }); toolbarKey(input); expect(input.stopPropagation).toHaveBeenCalledOnce(); expect(input.preventDefault).not.toHaveBeenCalled() }
    toolbarKey(event('ArrowRight'))
    expect(items[2].focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
  })
  it('waits until the portal is visible before focusing and releases outside listeners on cleanup', () => {
    class Target {}
    vi.stubGlobal('Node', Target)
    const inside = new Target(), trigger = new Target(), outside = new Target()
    const first = { focus: vi.fn() }, last = { focus: vi.fn() }
    const listeners = new Map<string, (event: { target: unknown }) => void>()
    const doc = { addEventListener: vi.fn((name, callback) => listeners.set(name, callback)), removeEventListener: vi.fn() }
    const onClose = { current: vi.fn() }
    const environment = { menu: { current: { querySelectorAll: () => [first, last], contains: (target: unknown) => target === inside } }, props: { focusEdge: 'last', anchorRef: { current: { contains: (target: unknown) => target === trigger } } }, onClose, document: doc, Node: Target }
    expect(actual<() => unknown>('./SelectionToolbarMenu.tsx', 'menuEffect', { ...environment, positioned: false })()).toBeUndefined()
    expect(last.focus).not.toHaveBeenCalled()
    const cleanup = actual<() => () => void>('./SelectionToolbarMenu.tsx', 'menuEffect', { ...environment, positioned: true })()
    expect(last.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
    listeners.get('pointerdown')!({ target: inside }); listeners.get('focusin')!({ target: trigger })
    expect(onClose.current).not.toHaveBeenCalled()
    listeners.get('pointerdown')!({ target: outside })
    expect(onClose.current).toHaveBeenCalledExactlyOnceWith(false)
    cleanup()
    expect(doc.removeEventListener).toHaveBeenCalledTimes(2)
  })
  it('returns focus to the correct trigger before dispatching an action', () => {
    for (const menu of ['layout', 'more', 'run']) {
      const setMenu = vi.fn(), layoutRef = { current: { focus: vi.fn() } }, moreRef = { current: { focus: vi.fn() } }, runRef = { current: { focus: vi.fn() } }
      const close = actual<(restore?: boolean) => void>('./SelectionToolbar.tsx', 'close', { setMenu, menu, layoutRef, moreRef, runRef })
      close(false)
      expect(layoutRef.current.focus).not.toHaveBeenCalled(); expect(moreRef.current.focus).not.toHaveBeenCalled()
      close(true)
      expect(setMenu).toHaveBeenLastCalledWith(null)
      expect((menu === 'layout' ? layoutRef : menu === 'run' ? runRef : moreRef).current.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
    }
  })
})
