import { afterEach, describe, expect, it, vi } from 'vitest'
import { officialPromptSnapshot, projectPrompt, promptDocument, type PromptDocument } from '../library/prompt-references'

// Drive the real component callbacks and effect ordering without installing a
// DOM environment. In particular, React Flow may render old node props after
// context changes before it echoes an edit back to the controlled textarea.
const runtime = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], pending: [] as (() => void)[], frames: [] as (() => void)[], catalog: { items: [], loading: false, loaded: true, error: null, enabled: true, load: async () => {} } }))
vi.mock('./PromptCatalogContext', () => ({ usePromptCatalogValue: () => runtime.catalog }))
vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), flushSync: (callback: () => void) => callback() }))
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return { ...actual,
    useRef(initial: unknown) { const index = runtime.cursor++; runtime.slots[index] ??= { current: initial }; return runtime.slots[index] },
    useState(initial: unknown) {
      const index = runtime.cursor++
      if (!(index in runtime.slots)) runtime.slots[index] = typeof initial === 'function' ? initial() : initial
      return [runtime.slots[index], (value: unknown) => { runtime.slots[index] = typeof value === 'function' ? value(runtime.slots[index]) : value }]
    },
    useMemo(factory: () => unknown) { runtime.cursor++; return factory() },
    useId() { runtime.cursor++; return 'prompt-test' },
    useLayoutEffect() { runtime.cursor++ },
    useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]) {
      const index = runtime.cursor++
      const previous = runtime.slots[index] as { dependencies?: readonly unknown[]; cleanup?: () => void } | undefined
      if (previous && dependencies && previous.dependencies && dependencies.every((value, entry) => Object.is(value, previous.dependencies![entry]))) return
      runtime.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } })
    },
  }
})

import { PromptEditor } from './PromptEditor'
import { PromptShortcutMenu } from './PromptShortcutMenu'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function findElement(value: unknown, type: unknown): ElementShape | null {
  if (Array.isArray(value)) { for (const entry of value) { const found = findElement(entry, type); if (found) return found } return null }
  if (!value || typeof value !== 'object' || !('props' in value)) return null
  const element = value as ElementShape
  return element.type === type ? element : findElement(element.props.children, type)
}
function harness(initial: PromptDocument) {
  runtime.cursor = 0; runtime.slots = []; runtime.pending = []; runtime.frames = []
  vi.stubGlobal('window', { requestAnimationFrame(callback: () => void) { runtime.frames.push(callback) } })
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} })
  let owner = initial
  let published = initial
  let tree: unknown
  let textarea: ElementShape
  const input = { value: '', selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', focus() {}, setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end } }
  function render() {
    runtime.cursor = 0
    tree = PromptEditor({ label: 'Prompt', value: owner.prompt, promptReferences: owner.references, placeholder: 'Write', references: [],
      onChange: (prompt, references) => { published = promptDocument(prompt, references) },
      onInsert: (prompt, references) => { published = promptDocument(prompt, references) },
      onCommit: (prompt, references) => { published = promptDocument(prompt, references) },
    })
    textarea = findElement(tree, 'textarea')!
    ;(textarea.props.ref as { current: unknown }).current = input
    input.value = textarea.props.value as string
    const pending = runtime.pending.splice(0)
    pending.forEach((effect) => effect())
    runtime.frames.splice(0).forEach((frame) => frame())
  }
  function key(key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) {
    const event = { key, currentTarget: input, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...modifiers }
    ;(textarea.props.onKeyDown as (event: unknown) => void)(event)
    render()
    return event
  }
  render()
  return {
    input, key, render,
    draft: () => input.value,
    published: () => published,
    menu: () => findElement(tree, PromptShortcutMenu),
    type(value: string, caret = value.length) {
      input.value = value; input.setSelectionRange(caret, caret)
      ;(textarea.props.onChange as (event: unknown) => void)({ target: input })
      render()
    },
    acknowledge() { owner = published; render() },
    receive(document: PromptDocument) { owner = document; render() },
  }
}
afterEach(() => vi.unstubAllGlobals())

describe('actual PromptEditor event and parent echo ordering', () => {
  it.each(['metaKey', 'ctrlKey'] as const)('keeps ordinary typing history across stale props and new callbacks for %s undo and redo', (modifier) => {
    const editor = harness(promptDocument('原文'))
    editor.type('原文新增')
    // The parent still supplies old text and newly allocated callback/asset
    // arrays. This used to clear the local undo stack on every edit.
    editor.render()
    expect(editor.draft()).toBe('原文新增')
    editor.acknowledge()
    const event = editor.key('z', { [modifier]: true })
    expect(event.preventDefault).toHaveBeenCalled()
    expect(editor.published().prompt).toBe('原文')
    editor.acknowledge()
    editor.key('z', { [modifier]: true, shiftKey: true })
    expect(editor.published().prompt).toBe('原文新增')
  })

  it('restores a deleted whole tag with Meta+Z after the controlled parent acknowledges deletion', () => {
    const snapshot = officialPromptSnapshot('xingmang-product-studio')!
    const initial = promptDocument(`前文 ${snapshot.prompt} 后文`, [{ ...snapshot, start: 3, end: 3 + snapshot.prompt.length }])
    const editor = harness(initial)
    const range = projectPrompt(initial).ranges[0]
    editor.input.setSelectionRange(range.end, range.end)
    editor.key('Backspace')
    expect(editor.published()).toEqual({ prompt: '前文  后文', references: [] })
    editor.acknowledge()
    editor.key('z', { metaKey: true })
    expect(editor.published()).toEqual(initial)
    editor.acknowledge()
    expect(editor.draft()).toBe('前文 #商品棚拍 官方 后文')
  })

  it.each(['#', '方', '#商品棚拍', '新正文🌟'])('preserves a whole-tag selection replaced by %s in the real onChange callback', (replacement) => {
    const snapshot = officialPromptSnapshot('xingmang-product-studio')!
    const editor = harness(promptDocument(snapshot.prompt, [{ ...snapshot, start: 0, end: snapshot.prompt.length }]))
    editor.input.setSelectionRange(0, editor.draft().length)
    editor.type(replacement)
    expect(editor.published()).toEqual({ prompt: replacement, references: [] })
    editor.acknowledge()
    expect(editor.draft()).toBe(replacement)
    if (replacement === '#') expect(editor.menu()?.props.query).toBe('')
  })

  it('opens the picker for a new hash immediately before an existing official tag', () => {
    const snapshot = officialPromptSnapshot('xingmang-product-studio')!
    const initial = promptDocument(snapshot.prompt, [{ ...snapshot, start: 0, end: snapshot.prompt.length }])
    const editor = harness(initial)
    editor.type('#' + editor.draft(), 1)
    expect(editor.published().prompt).toBe('#' + snapshot.prompt)
    expect(editor.published().references[0].start).toBe(1)
    expect(editor.menu()?.props.query).toBe('')
  })

  it('retains the front-hash picker and undo across delayed parent acknowledgement and unrelated renders', async () => {
    const snapshot = officialPromptSnapshot('xingmang-product-studio')!
    const initial = promptDocument(snapshot.prompt, [{ ...snapshot, start: 0, end: snapshot.prompt.length }])
    const editor = harness(initial)
    editor.type('#' + editor.draft(), 1)
    await Promise.resolve()
    editor.render()
    expect(editor.menu()?.props.query).toBe('')
    editor.acknowledge()
    await Promise.resolve()
    editor.render()
    expect(editor.menu()?.props.query).toBe('')
    editor.key('z', { metaKey: true })
    expect(editor.published()).toEqual(initial)
    editor.acknowledge()
    editor.key('z', { metaKey: true, shiftKey: true })
    expect(editor.published().prompt).toBe('#' + snapshot.prompt)
  })

  it('does not overwrite a newer edit when an intermediate self-published value arrives late', () => {
    const editor = harness(promptDocument('原'))
    editor.type('原一')
    const intermediate = editor.published()
    editor.type('原一二')
    editor.receive(intermediate)
    expect(editor.draft()).toBe('原一二')
    editor.acknowledge()
    editor.key('z', { metaKey: true })
    expect(editor.published().prompt).toBe('原一')
  })

  it('accepts a genuine external document change and discards history from the prior document', () => {
    const editor = harness(promptDocument('原'))
    editor.type('原一')
    editor.acknowledge()
    editor.receive(promptDocument('另一个外部版本'))
    editor.render()
    expect(editor.draft()).toBe('另一个外部版本')
    editor.key('z', { metaKey: true })
    expect(editor.draft()).toBe('另一个外部版本')
  })
})
