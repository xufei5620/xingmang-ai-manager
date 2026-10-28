import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ cursor: 0, states: [] as unknown[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useMemo: (factory: () => unknown) => factory(),
  useRef: (value: unknown) => ({ current: value }),
  useEffect: () => undefined,
  useState(initial: unknown) { const index = runtime.cursor++; if (!(index in runtime.states)) runtime.states[index] = initial; return [runtime.states[index], (value: unknown) => { runtime.states[index] = typeof value === 'function' ? value(runtime.states[index]) : value }] },
}))
import { QuickInsert } from './QuickInsert'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type: unknown): ElementShape[] { if (Array.isArray(value)) return value.flatMap((child) => elements(child, type)); if (!value || typeof value !== 'object' || !('props' in value)) return []; const element = value as ElementShape; return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)] }
function props() { return { open: true, anchor: { x: 20, y: 30 }, hasNodes: false, hasSelection: false, canvasNodes: [], onAddNode: vi.fn(), onLoadTemplate: vi.fn(), onCommand: vi.fn(), onLocateNode: vi.fn(), onClose: vi.fn(), onInteriorTask: vi.fn() } }
function render(value: Parameters<typeof QuickInsert>[0]) { runtime.cursor = 0; return QuickInsert(value) }
function interior(tree: unknown) { return elements(tree, 'button').find((element) => element.props.id === 'quick-insert-command-interior-task') }
beforeEach(() => { runtime.states = []; runtime.cursor = 0 })

describe('interior quick insertion command callbacks', () => {
  it('opens the explicit dialog and closes the palette without inserting a generic node or template', () => {
    const value = props(), tree = render(value), entry = interior(tree)
    expect(entry).toBeDefined(); expect(value.onInteriorTask).not.toHaveBeenCalled()
    ;(entry!.props.onClick as () => void)()
    expect(value.onInteriorTask).toHaveBeenCalledOnce(); expect(value.onClose).toHaveBeenCalledOnce()
    expect(value.onAddNode).not.toHaveBeenCalled(); expect(value.onLoadTemplate).not.toHaveBeenCalled(); expect(value.onCommand).not.toHaveBeenCalled()
  })
  it.each([{ allowedNodeTypes: [] }, { allowedNodeTypes: ['image-generate'] }, { allowedNodeTypes: ['image-input', 'image-edit'] }])('hides the task command in constrained connection menus: $allowedNodeTypes', ({ allowedNodeTypes }) => {
    expect(interior(render({ ...props(), allowedNodeTypes }))).toBeUndefined()
  })
  it('hides the command for an older host without the optional callback or a closed menu', () => {
    expect(interior(render({ ...props(), onInteriorTask: undefined }))).toBeUndefined()
    expect(render({ ...props(), open: false })).toBeNull()
  })
  it('keeps the real command searchable by interior and weather without changing node definitions', () => {
    const value = props()
    for (const query of ['interior', '天气', '室内']) {
      const input = elements(render(value), 'input')[0]
      ;(input.props.onChange as (event: unknown) => void)({ target: { value: query } })
      expect(interior(render(value))).toBeDefined()
    }
    expect(value.onInteriorTask).not.toHaveBeenCalled(); expect(value.onAddNode).not.toHaveBeenCalled()
  })
})
