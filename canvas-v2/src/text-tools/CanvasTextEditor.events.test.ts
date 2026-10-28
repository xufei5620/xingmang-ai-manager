import { afterEach, describe, expect, it, vi } from 'vitest'
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], pending: [] as Array<() => void | (() => void)>, cleanup: [] as Array<() => void> }))
vi.mock('react-dom', () => ({ createPortal: (tree: unknown) => tree }))
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return { ...actual,
    useRef(initial: unknown) { const index = hooks.cursor++; hooks.values[index] ??= { current: initial }; return hooks.values[index] },
    useState(initial: unknown) { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial; return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value }] },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) { const index = hooks.cursor++; const old = hooks.values[index] as readonly unknown[] | undefined; if (!old || deps.some((dep, i) => dep !== old[i])) { hooks.values[index] = deps; hooks.pending.push(effect) } },
  }
})
import { CanvasTextEditor, type CanvasTextEditorProps } from './CanvasTextEditor'
interface ElementShape { type: unknown; props: Record<string, unknown> }
function find(tree: unknown, predicate: (element: ElementShape) => boolean): ElementShape | null {
  if (Array.isArray(tree)) { for (const child of tree) { const value = find(child, predicate); if (value) return value } return null }
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return null
  const element = tree as ElementShape
  return predicate(element) ? element : find(element.props.children, predicate)
}
function text(tree: unknown): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join('')
  return tree && typeof tree === 'object' && 'props' in tree ? text((tree as ElementShape).props.children) : ''
}
function harness(overrides: Partial<CanvasTextEditorProps> = {}) {
  hooks.cursor = 0; hooks.values = []; hooks.pending = []; hooks.cleanup = []
  const props: CanvasTextEditorProps = { title: '商品文案', value: '原始文字', onCopy: vi.fn().mockResolvedValue(undefined), onDownload: vi.fn().mockResolvedValue(undefined), onCreateText: vi.fn().mockResolvedValue(undefined), onSavePreset: vi.fn().mockResolvedValue(undefined), onSave: vi.fn().mockResolvedValue(undefined), onClose: vi.fn(), ...overrides }
  class Element { isConnected = true; focus = vi.fn(); querySelectorAll() { return [] }; querySelector() { return null } }
  const previous = new Element(), panel = new Element(), document = { body: {}, activeElement: previous }
  vi.stubGlobal('HTMLElement', Element); vi.stubGlobal('window', { document }); vi.stubGlobal('document', document)
  const frames = new Map<number, () => void>(); let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.set(++frameId, callback); return frameId }); vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  const input = { value: props.value, selectionStart: 0, selectionEnd: 0, focus: vi.fn(), setSelectionRange(start: number, end: number) { input.selectionStart = start; input.selectionEnd = end } }
  let tree: unknown
  function render() {
    hooks.cursor = 0; tree = CanvasTextEditor(props)
    const textarea = find(tree, (entry) => entry.type === 'textarea'); if (textarea) { (textarea.props.ref as { current: unknown }).current = input; input.value = String(textarea.props.value) }
    const section = find(tree, (entry) => entry.type === 'section'); if (section) (section.props.ref as { current: unknown }).current = panel
    hooks.pending.splice(0).forEach((effect) => { const cleanup = effect(); if (cleanup) hooks.cleanup.push(cleanup) })
  }
  function element(predicate: (entry: ElementShape) => boolean) { const result = find(tree, predicate); if (!result) throw new Error('Element missing'); return result }
  function action(entry: ElementShape, name: string, event: unknown = {}) { (entry.props[name] as (event: unknown) => void)(event); render() }
  function click(label: string) { const entry = element((item) => item.type === 'button' && (item.props['aria-label'] === label || text(item.props.children) === label)); if (entry.props.disabled) throw new Error(`Disabled: ${label}`); action(entry, 'onClick') }
  function select(start: number, end = start) { input.selectionStart = start; input.selectionEnd = end; action(element((entry) => entry.type === 'textarea'), 'onSelect') }
  function edit(value: string, start = value.length, end = start) { input.value = value; input.selectionStart = start; input.selectionEnd = end; action(element((entry) => entry.type === 'textarea'), 'onChange', { currentTarget: input }) }
  function key(key: string, modifiers: Record<string, unknown> = {}) { const event = { key, preventDefault: vi.fn(), stopPropagation: vi.fn(), nativeEvent: {}, ...modifiers }; action(element((entry) => entry.type === 'section'), 'onKeyDown', event); return event }
  function composition(start: boolean) { action(element((entry) => entry.type === 'textarea'), start ? 'onCompositionStart' : 'onCompositionEnd', { currentTarget: input }) }
  function paste(value: string) { const event = { preventDefault: vi.fn(), clipboardData: { getData: (type: string) => type === 'text/plain' ? value : '<b>HTML</b>' } }; action(element((entry) => entry.type === 'textarea'), 'onPaste', event); return event }
  function flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach((frame) => frame()); render() }
  async function settle() { await Promise.resolve(); await Promise.resolve(); render() }
  render()
  return { props, previous, input, click, edit, select, key, composition, paste, render, element, flush, settle, text: () => text(tree), value: () => input.value, unmount: () => hooks.cleanup.splice(0).forEach((cleanup) => cleanup()) }
}
afterEach(() => vi.unstubAllGlobals())

describe('actual isolated text editor callbacks', () => {
  it('keeps draft changes private and closes only after one successful explicit save', async () => {
    let done: () => void = () => {}
    const save = vi.fn(() => new Promise<void>((resolve) => { done = resolve })), e = harness({ onSave: save })
    e.edit('新的正文'); expect(save).not.toHaveBeenCalled(); expect(e.text()).toContain('有未保存的修改')
    e.click('保存并关闭'); e.key('s', { metaKey: true }); expect(save).toHaveBeenCalledOnce(); expect(e.props.onClose).not.toHaveBeenCalled()
    expect(save.mock.calls[0]).toEqual(['新的正文', expect.any(AbortSignal)])
    done(); await e.settle(); expect(e.props.onClose).toHaveBeenCalledOnce()
  })
  it('confirms dirty cancel, keeps drafts on continued editing and discards without saving', () => {
    const e = harness(); e.edit('草稿'); e.key('Escape'); expect(e.text()).toContain('保留这次修改？')
    e.click('继续编辑'); expect(e.value()).toBe('草稿'); expect(e.props.onClose).not.toHaveBeenCalled()
    e.click('取消'); e.click('放弃修改'); expect(e.props.onSave).not.toHaveBeenCalled(); expect(e.props.onClose).toHaveBeenCalledOnce()
  })
  it('handles save failure without losing the draft or claiming success', async () => {
    const e = harness({ onSave: vi.fn().mockRejectedValue(new Error('保存失败，请重试')) }); e.edit('待保存正文'); e.click('取消'); e.click('保存并关闭'); await e.settle()
    expect(e.value()).toBe('待保存正文'); expect(e.text()).toContain('保存失败，请重试'); expect(e.props.onClose).not.toHaveBeenCalled()
  })
  it('preserves selection across format, undo and redo without leaking canvas shortcuts', () => {
    const e = harness({ value: '商品陶瓷杯' }); e.select(2, 5); e.click('粗体'); e.flush()
    expect(e.value()).toBe('商品**陶瓷杯**'); expect([e.input.selectionStart, e.input.selectionEnd]).toEqual([4, 7])
    const undo = e.key('z', { metaKey: true }); e.flush(); expect(e.value()).toBe('商品陶瓷杯'); expect(undo.preventDefault).toHaveBeenCalled(); expect(undo.stopPropagation).toHaveBeenCalled()
    e.key('y', { ctrlKey: true }); e.flush(); expect(e.value()).toBe('商品**陶瓷杯**')
    e.props.value = '旧props回显'; e.render(); e.key('z', { ctrlKey: true }); e.flush(); expect(e.value()).toBe('商品陶瓷杯')
  })
  it('keeps IME edits atomic and ignores save or close shortcuts during composition', () => {
    const e = harness({ value: '' }); e.composition(true); e.edit('pin'); e.edit('品牌')
    e.key('s', { ctrlKey: true, nativeEvent: { isComposing: true } }); e.key('Escape', { nativeEvent: { keyCode: 229 } }); expect(e.props.onSave).not.toHaveBeenCalled(); expect(e.text()).not.toContain('保留这次修改？')
    e.composition(false); e.key('z', { metaKey: true }); e.flush(); expect(e.value()).toBe('')
    e.key('z', { metaKey: true, shiftKey: true }); e.flush(); expect(e.value()).toBe('品牌')
  })
  it('pastes plain text, rejects over-capacity paste as a whole and retains undo', () => {
    const e = harness({ value: '正文', maxLength: 8 }); e.select(2); e.paste('<b>x</b>'); expect(e.value()).toBe('正文'); expect(e.text()).toContain('未插入')
    const paste = e.paste('☕\n中文'); e.flush(); expect(paste.preventDefault).toHaveBeenCalled(); expect(e.value()).toBe('正文☕\n中文')
    e.key('z', { metaKey: true }); e.flush(); expect(e.value()).toBe('正文')
  })
  it('reads and exports exact full results without editing the original or closing the reader', async () => {
    const value = '模型结果\n'.repeat(5_000), e = harness({ value, readOnly: true })
    e.click('源码'); expect(e.element((entry) => entry.type === 'textarea').props.readOnly).toBe(true)
    e.edit('forbidden'); expect(e.value()).toBe(value)
    for (const [label, callback] of [['复制全文', e.props.onCopy], ['下载 TXT', e.props.onDownload], ['另存文本节点', e.props.onCreateText]] as const) { e.click(label); await e.settle(); expect(callback).toHaveBeenCalledWith(value, expect.any(AbortSignal)) }
    expect(e.props.onSave).not.toHaveBeenCalled(); expect(e.props.onClose).not.toHaveBeenCalled(); expect(e.text()).toContain('已另存为文本节点')
  })
  it('disables oversized presets dynamically while retaining full text actions', async () => {
    const e = harness({ value: '字'.repeat(24_000) }); e.click('存为提示词'); await e.settle(); expect(e.props.onSavePreset).toHaveBeenCalledOnce()
    e.edit('字'.repeat(24_001)); expect(() => e.click('存为提示词')).toThrow('Disabled'); expect(e.text()).toContain('不会截断')
    e.click('复制全文'); await e.settle(); expect(e.props.onCopy).toHaveBeenCalledWith('字'.repeat(24_001), expect.any(AbortSignal))
  })
  it('mentions downloading the oversized text only when the host lets the page download', () => {
    const value = '字'.repeat(24_001)
    const web = harness({ value })
    expect(web.element((entry) => entry.type === 'button' && text(entry.props.children) === '存为提示词').props.title).toBe('提示词最多 24,000 字符，正文不会截断；请先精简或下载全文')
    expect(web.text()).toContain('提示词上限 24,000 字符；当前全文可复制、下载或另存文本节点，不会截断。')
    const desktop = harness({ value, onDownload: undefined })
    expect(desktop.element((entry) => entry.type === 'button' && text(entry.props.children) === '存为提示词').props.title).toBe('提示词最多 24,000 字符，正文不会截断；请先精简或复制全文')
    expect(desktop.text()).toContain('提示词上限 24,000 字符；当前全文可复制或另存文本节点，不会截断。')
    expect(desktop.text()).not.toContain('下载')
  })
  it('honors disabled scope reasons and exposes clipboard failures', async () => {
    const e = harness({ readOnly: true, createTextDisabledReason: '运行中', savePresetDisabledReason: '运行中', onCopy: vi.fn().mockRejectedValue(new Error('无法访问系统剪贴板')) })
    expect(() => e.click('另存文本节点')).toThrow('Disabled'); expect(() => e.click('存为提示词')).toThrow('Disabled')
    e.click('复制全文'); await e.settle(); expect(e.text()).toContain('无法访问系统剪贴板'); expect(e.text()).not.toContain('已复制全文')
  })
  it('aborts pending work on close or unmount and ignores late completion', async () => {
    let finish: () => void = () => {}
    const download = vi.fn(() => new Promise<void>((resolve) => { finish = resolve })), e = harness({ readOnly: true, onDownload: download })
    e.click('下载 TXT'); e.click('关闭'); expect((download.mock.calls[0] as unknown as [string, AbortSignal])[1].aborted).toBe(true)
    finish(); await e.settle(); expect(e.text()).not.toContain('已下载 TXT'); expect(e.props.onClose).toHaveBeenCalledOnce()
    e.unmount(); expect(e.previous.focus).toHaveBeenCalledOnce()
  })

  it('offers no TXT download when the host blocks page downloads', () => {
    const e = harness({ onDownload: undefined })
    expect(e.text()).toContain('复制全文'); expect(e.text()).not.toContain('下载 TXT')
    e.unmount()
  })
})
