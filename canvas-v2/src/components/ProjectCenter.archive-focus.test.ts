import { describe, expect, it, vi } from 'vitest'
import type { CanvasStoredProjectSummary } from '../host'

// 桌面 Mac 验收 R16：归档框里没有输入框，焦点还留在背后的「归档项目」图标上，按回车没反应。
// 这里没有 DOM：照 asset-category-ui-events.test.ts 的办法替掉 React 的几个 hook，直接调组件、点按钮、跑 effect，
// 按 React 的顺序先接上 ref 再跑 effect，看焦点有没有交给「确认归档」。

const runtime = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as Array<() => void> }))
vi.mock('react', async () => ({
  ...await vi.importActual<object>('react'),
  useMemo(factory: () => unknown) { runtime.cursor++; return factory() },
  useRef(value: unknown) { const index = runtime.cursor++; if (!(index in runtime.slots)) runtime.slots[index] = { current: value }; return runtime.slots[index] },
  useState(initial: unknown) { const index = runtime.cursor++; if (!(index in runtime.slots)) runtime.slots[index] = typeof initial === 'function' ? initial() : initial; return [runtime.slots[index], (value: unknown) => { runtime.slots[index] = typeof value === 'function' ? value(runtime.slots[index]) : value }] },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) {
    const index = runtime.cursor++, previous = runtime.slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined
    if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return
    runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } })
  },
}))
import { ProjectCenter } from './ProjectCenter'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand)
  if (!value || typeof value !== 'object' || !('props' in value) || !('type' in value)) return value
  const element = value as ElementShape
  if (typeof element.type === 'function') return expand(element.type(element.props))
  return { ...element, props: { ...element.props, children: expand(element.props.children) } }
}
function elements(value: unknown, type: unknown): ElementShape[] {
  if (Array.isArray(value)) return value.flatMap((item) => elements(item, type))
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const element = value as ElementShape
  return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)]
}
function textOf(value: unknown): string { if (typeof value === 'string' || typeof value === 'number') return String(value); if (Array.isArray(value)) return value.map(textOf).join(''); return value && typeof value === 'object' && 'props' in value ? textOf((value as ElementShape).props.children) : '' }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve() }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

const active: CanvasStoredProjectSummary = { id: 'now', name: '在做的海报', createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z', lastOpenedAt: '2026-11-09T00:00:00.000Z', nodeCount: 0, assetCount: 0, workspaceConfigured: true, workspaceStatus: 'ready' }

function harness(onSetArchived: (projectId: string, archived: boolean) => Promise<boolean>) {
  runtime.cursor = 0; runtime.slots = []; runtime.effects = []
  // 「确认归档」按钮在页面上的样子：一次渲染接一次 ref，跟 React 一样在 effect 之前。
  const confirmButton = { focus: vi.fn() }
  const props: Parameters<typeof ProjectCenter>[0] = {
    projects: [active], loading: false, error: null, onCreate: async () => true, onOpen: () => undefined,
    onRename: async () => true, onDuplicate: async () => true, onSetArchived,
  }
  let tree: unknown = null
  function render() {
    runtime.cursor = 0
    tree = expand(ProjectCenter(props))
    for (const button of elements(tree, 'button')) {
      const ref = button.props.ref as { current: unknown } | undefined
      if (ref && typeof ref === 'object') ref.current = button.props.type === 'submit' ? confirmButton : { focus: vi.fn() }
    }
    runtime.effects.splice(0).forEach((effect) => effect())
    return tree
  }
  function click(label: string) {
    const button = elements(tree, 'button').find((item) => item.props['aria-label'] === label)
    expect(button, label).toBeDefined()
    ;(button!.props.onClick as () => void)()
  }
  function dialog() { return elements(tree, 'form').find((item) => item.props['aria-label'] !== '新建项目') }
  function submit() { (dialog()!.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() }) }
  return { render, click, dialog, submit, confirmButton }
}


describe('archive project dialog focus', () => {
  it('moves focus to the confirm button when the archive dialog opens so Enter archives', () => {
    const ui = harness(async () => true)
    ui.render()
    expect(ui.dialog()).toBeUndefined()
    expect(ui.confirmButton.focus).not.toHaveBeenCalled()

    ui.click('归档项目：在做的海报')
    ui.render()
    const form = ui.dialog()
    expect(form?.props['aria-label']).toBe('归档项目')
    const submits = elements(form, 'button').filter((item) => item.props.type === 'submit')
    expect(submits).toHaveLength(1)
    expect(textOf(submits[0].props.children)).toBe('确认归档')
    expect(submits[0].props.disabled).toBe(false)
    expect(ui.confirmButton.focus).toHaveBeenCalledOnce()

    // Re-rendering the open dialog does not keep stealing focus.
    ui.render()
    expect(ui.confirmButton.focus).toHaveBeenCalledOnce()
  })

  it('leaves the name field focused in the rename and duplicate dialogs', () => {
    for (const label of ['重命名项目：在做的海报', '复制项目：在做的海报']) {
      const ui = harness(async () => true)
      ui.render()
      ui.click(label)
      ui.render()
      expect(elements(ui.dialog(), 'input')[0]?.props.autoFocus).toBe(true)
      expect(ui.confirmButton.focus).not.toHaveBeenCalled()
    }
  })

  it('puts focus back on the confirm button after a failed archive so Enter can retry', async () => {
    const pending = deferred<boolean>()
    const onSetArchived = vi.fn(() => pending.promise)
    const ui = harness(onSetArchived)
    ui.render()
    ui.click('归档项目：在做的海报')
    ui.render()
    expect(ui.confirmButton.focus).toHaveBeenCalledOnce()

    ui.submit()
    ui.render()
    expect(onSetArchived).toHaveBeenCalledExactlyOnceWith('now', true)
    expect(textOf(ui.dialog()!.props.children)).toContain('处理中…')
    expect(ui.confirmButton.focus).toHaveBeenCalledOnce()

    pending.reject(new Error('项目没有归档成功，请稍后再试'))
    await settle()
    ui.render()
    expect(textOf(ui.dialog()!.props.children)).toContain('项目没有归档成功，请稍后再试')
    expect(ui.confirmButton.focus).toHaveBeenCalledTimes(2)

    // Enter on the refocused button submits the same form again.
    onSetArchived.mockResolvedValueOnce(true)
    ui.submit()
    await settle()
    ui.render()
    expect(onSetArchived).toHaveBeenCalledTimes(2)
    expect(ui.dialog()).toBeUndefined()
    expect(ui.confirmButton.focus).toHaveBeenCalledTimes(2)
  })
})
