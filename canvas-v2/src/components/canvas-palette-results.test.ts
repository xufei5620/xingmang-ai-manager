import { beforeEach, describe, expect, it, vi } from 'vitest'
import { searchCanvasNodes } from '../editor/node-search'
import { searchExistingCanvasNodes } from '../editor/command-palette'
import type { CanvasNode } from '../nodes/WorkflowNodes'

const runtime = vi.hoisted(() => ({ cursor: 0, states: [] as unknown[], refs: [] as { current: unknown }[], refCursor: 0 }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useMemo: (factory: () => unknown) => factory(), useEffect: () => undefined, useId: () => 'palette-test',
  useRef(initial: unknown) { const index = runtime.refCursor++; return runtime.refs[index] ??= { current: initial } },
  useState(initial: unknown) { const index = runtime.cursor++; if (!(index in runtime.states)) runtime.states[index] = initial; return [runtime.states[index], (value: unknown) => { runtime.states[index] = typeof value === 'function' ? value(runtime.states[index]) : value }] },
}))
import { NodeSearchPalette } from './NodeSearchPalette'
import { QuickInsert } from './QuickInsert'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type?: unknown): ElementShape[] {
  if (Array.isArray(value)) return value.flatMap((child) => elements(child, type))
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const element = value as ElementShape
  return [...(type === undefined || element.type === type ? [element] : []), ...elements(element.props.children, type)]
}
function text(value: unknown): string { if (Array.isArray(value)) return value.map(text).join(''); if (value && typeof value === 'object' && 'props' in value) return text((value as ElementShape).props.children); return typeof value === 'string' || typeof value === 'number' ? String(value) : '' }
function nodes(): CanvasNode[] { return Array.from({ length: 124 }, (_, index) => ({ id: `product-${String(index + 1).padStart(3, '0')}`, type: 'image-generate', definitionVersion: 1, position: { x: index * 600, y: 0 }, data: { prompt: `${'前文'.repeat(130)}最后的商品提示词`, model: 'gpt-image-1', status: 'idle', settings: { title: '商品图' } } })) }
function mount(kind: 'find' | 'quick') {
  let all = nodes()
  const jump = vi.fn(), close = vi.fn()
  function render() { runtime.cursor = 0; runtime.refCursor = 0; return kind === 'find'
    ? NodeSearchPalette({ nodes: all.map((node) => ({ id: node.id, title: '商品图', kind: node.type!, prompt: node.data.prompt, model: node.data.model })), onJump: jump, onClose: close })
    : QuickInsert({ open: true, anchor: { x: 20, y: 20 }, hasNodes: true, hasSelection: true, canvasNodes: all, onAddNode: vi.fn(), onLoadTemplate: vi.fn(), onCommand: vi.fn(), onLocateNode: jump, onClose: close }) }
  function tree() { const current = render(), input = elements(current, 'input')[0]; (input.props.ref as { current: unknown }).current = { focus: vi.fn() }; return current }
  function query(value: string) { const input = elements(tree(), 'input')[0]; (input.props.onChange as (event: unknown) => void)({ target: { value } }) }
  function key(value: string, options: { target?: unknown; composing?: boolean; code?: number } = {}) {
    const current = tree(), input = elements(current, 'input')[0]
    const event = { key: value, nativeEvent: { isComposing: options.composing ?? false, keyCode: options.code ?? 0 }, target: options.target ?? (input.props.ref as { current: unknown }).current, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    ;(elements(current).find((element) => element.props.role === 'dialog')!.props.onKeyDown as (event: unknown) => void)(event)
    return event
  }
  function options() { return elements(tree(), 'button').filter((element) => element.props.role === 'option') }
  return { tree, query, key, options, jump, close, replaceNodes: (next: CanvasNode[]) => { all = next } }
}
beforeEach(() => { runtime.cursor = 0; runtime.refCursor = 0; runtime.states = []; runtime.refs = [] })

describe('complete bounded canvas palette results and keyboard ownership', () => {
  it('indexes every matching node consistently, including a long prompt suffix', () => {
    const all = nodes()
    expect(searchCanvasNodes(all.map((node) => ({ id: node.id, title: '商品图', kind: node.type!, prompt: node.data.prompt, model: node.data.model })), '商品图')).toHaveLength(124)
    expect(searchExistingCanvasNodes(all, '商品图')).toHaveLength(124)
    expect(searchExistingCanvasNodes(all, '最后的商品提示词')).toHaveLength(124)
    for (const query of ['product-', 'gpt-image-1', 'image-generate', 'idle', '待运行']) {
      expect(searchExistingCanvasNodes(all, query).map((hit) => hit.id)).toEqual(searchCanvasNodes(all.map((node) => ({ id: node.id, title: '商品图', kind: node.type!, kindLabel: '图像节点', prompt: node.data.prompt, model: node.data.model, status: node.data.status })), query).map((hit) => hit.id))
    }
  })
  it.each(['find', 'quick'] as const)('keeps %s DOM bounded while reaching the last of 124 matches by End and Enter', (kind) => {
    const f = mount(kind); f.query('商品图')
    expect(text(f.tree())).toContain('124')
    expect(f.options().length).toBeLessThanOrEqual(20)
    f.key('End')
    expect(f.options().some((element) => element.props['aria-selected'] === true && text(element).includes('product-124'))).toBe(true)
    f.key('Enter'); expect(f.jump).toHaveBeenCalledExactlyOnceWith('product-124'); expect(f.close).toHaveBeenCalledOnce()
  })
  it.each(['find', 'quick'] as const)('moves %s across pages, wraps all results and keeps Home consistent', (kind) => {
    const f = mount(kind); f.query('商品图')
    f.key('PageDown'); expect(f.options().some((element) => element.props['aria-selected'] === true && text(element).includes('product-021'))).toBe(true)
    f.key('End'); f.key('ArrowDown'); f.key('Enter'); expect(f.jump).toHaveBeenCalledExactlyOnceWith('product-001')
    f.key('End'); f.key('Home'); expect(f.options().some((element) => element.props['aria-selected'] === true && text(element).includes('product-001'))).toBe(true)
  })
  it.each(['find', 'quick'] as const)('contains unhandled %s keys without preventing native editing, button Enter or Tab', (kind) => {
    const f = mount(kind); f.query('商品图')
    for (const key of ['Delete', 'Backspace', 'Tab', 'Enter', 'c', 'v', 'z']) {
      const event = f.key(key, { target: { tagName: 'BUTTON' } })
      expect(event.stopPropagation).toHaveBeenCalledOnce(); expect(event.preventDefault).not.toHaveBeenCalled()
    }
    const ime = f.key('Enter', { composing: true, code: 229 }); expect(ime.stopPropagation).toHaveBeenCalledOnce(); expect(ime.preventDefault).not.toHaveBeenCalled(); expect(f.jump).not.toHaveBeenCalled()
    const legacyIme = f.key('Enter', { code: 229 }); expect(legacyIme.stopPropagation).toHaveBeenCalledOnce(); expect(legacyIme.preventDefault).not.toHaveBeenCalled(); expect(f.jump).not.toHaveBeenCalled()
    f.key('Escape'); expect(f.close).toHaveBeenCalledOnce()
  })
  it.each(['find', 'quick'] as const)('uses native page buttons to reach every %s result without growing the result DOM', (kind) => {
    const f = mount(kind); f.query('商品图')
    const visited = new Set<string>()
    for (let page = 0; page < 7; page += 1) {
      const options = f.options(); expect(options.length).toBeLessThanOrEqual(20)
      for (const option of options) { const identity = text(option).match(/product-\d+/)?.[0]; if (identity) visited.add(identity) }
      const next = elements(f.tree(), 'button').find((element) => String(element.props['aria-label']).startsWith('下一页'))!
      if (!next.props.disabled) (next.props.onClick as () => void)()
    }
    expect(visited.size).toBe(124)
  })
  it.each(['find', 'quick'] as const)('clamps %s selection after deletion and never activates a stale empty result', (kind) => {
    const f = mount(kind); f.query('商品图'); f.key('End')
    f.replaceNodes(nodes().slice(0, 123)); f.key('Enter'); expect(f.jump).toHaveBeenCalledExactlyOnceWith('product-123')
    f.jump.mockClear(); f.replaceNodes([]); f.key('Enter'); expect(f.jump).not.toHaveBeenCalled(); expect(f.options()).toHaveLength(0)
  })
})
