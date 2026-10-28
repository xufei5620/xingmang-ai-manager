import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageEditMask } from './image-edit-mask'

const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], pending: [] as Array<() => void>, rasterCalls: 0 }))
vi.mock('react-dom', () => ({ createPortal: (tree: unknown) => tree }))
vi.mock('./image-edit-mask', async (original) => {
  const actual = await original<typeof import('./image-edit-mask')>()
  return { ...actual, rasterizeImageEditMask: (...args: Parameters<typeof actual.rasterizeImageEditMask>) => { hooks.rasterCalls++; return actual.rasterizeImageEditMask(...args) } }
})
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return { ...actual,
    useRef(initial: unknown) { const index = hooks.cursor++; hooks.values[index] ??= { current: initial }; return hooks.values[index] },
    useState(initial: unknown) { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial; return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value }] },
    useId() { hooks.cursor++; return 'mask-test' },
    useMemo(factory: () => unknown, deps: readonly unknown[]) { const index = hooks.cursor++; const old = hooks.values[index] as { deps: readonly unknown[]; value: unknown } | undefined; if (!old || deps.some((dep, i) => dep !== old.deps[i])) hooks.values[index] = { deps, value: factory() }; return (hooks.values[index] as { value: unknown }).value },
    useEffect(effect: () => void, deps: readonly unknown[]) { const index = hooks.cursor++; const old = hooks.values[index] as readonly unknown[] | undefined; if (!old || deps.some((dep, i) => dep !== old[i])) { hooks.values[index] = deps; hooks.pending.push(effect) } },
  }
})
import { ImageMaskEditor } from './ImageMaskEditor'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function findElement(tree: unknown, predicate: (element: ElementShape) => boolean): ElementShape | null {
  if (Array.isArray(tree)) { for (const child of tree) { const found = findElement(child, predicate); if (found) return found } return null }
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return null
  const element = tree as ElementShape
  return predicate(element) ? element : findElement(element.props.children, predicate)
}
function text(tree: unknown): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join('')
  return tree && typeof tree === 'object' && 'props' in tree ? text((tree as ElementShape).props.children) : ''
}
function harness(initial?: ImageEditMask, dimensions = { width: 4096, height: 256 }) {
  hooks.cursor = 0; hooks.values = []; hooks.pending = []; hooks.rasterCalls = 0
  const assetId = 'a'.repeat(43), onApply = vi.fn(), onClose = vi.fn()
  const frames = new Map<number, () => void>(); let nextFrame = 0
  class Element { closest() { return null } }
  vi.stubGlobal('HTMLElement', Element)
  vi.stubGlobal('document', { body: {}, activeElement: undefined })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  let tree: unknown
  function render() { hooks.cursor = 0; tree = ImageMaskEditor({ asset: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}` }, initial, onApply, onClose }); hooks.pending.splice(0).forEach((effect) => effect()) }
  function element(predicate: (element: ElementShape) => boolean) { const found = findElement(tree, predicate); if (!found) throw new Error('Missing element'); return found }
  function action(el: ElementShape, name: string, event: unknown = {}) { (el.props[name] as (event: unknown) => void)(event); render() }
  function click(label: string) { const el = element((entry) => entry.type === 'button' && (entry.props['aria-label'] === label || text(entry.props.children) === label)); if (el.props.disabled) throw new Error(`Disabled: ${label}`); action(el, 'onClick') }
  function key(key: string, modifiers: Record<string, boolean> = {}) { action(element((entry) => entry.type === 'section'), 'onKeyDown', { key, target: new Element(), preventDefault() {}, stopPropagation() {}, ...modifiers }) }
  const captured = new Set<number>()
  const target = { getBoundingClientRect: () => ({ left: 80, top: 100, width: 800, height: 50 }), setPointerCapture: (id: number) => captured.add(id), hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: (id: number) => captured.delete(id) }
  function pointer(name: string, x: number, y: number, pointerId = 1) { action(element((entry) => entry.props['aria-label'] === '蒙版绘制区'), name, { button: 0, pointerId, clientX: x, clientY: y, currentTarget: target, preventDefault() {}, stopPropagation() {} }) }
  render()
  function load() { action(element((entry) => entry.props.alt === '局部修改原图'), 'onLoad', { currentTarget: { naturalWidth: dimensions.width, naturalHeight: dimensions.height } }); render() }
  return { load, click, key, pointer, onApply, onClose, text: () => text(tree), render, frameCount: () => frames.size, flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((frame) => frame()); render() }, element }
}
afterEach(() => vi.unstubAllGlobals())

describe('actual mask editor interactions', () => {
  it('draws a bounded stroke on a 4096px wide image without rasterizing during pointer moves and preserves undo/redo', () => {
    const editor = harness(); editor.load()
    const calls = hooks.rasterCalls
    editor.pointer('onPointerDown', 160, 125)
    for (let index = 0; index < 20; index++) editor.pointer('onPointerMove', 180 + index * 30, 125)
    expect(editor.frameCount()).toBe(1); expect(hooks.rasterCalls).toBe(calls)
    editor.flush(); expect(hooks.rasterCalls).toBe(calls)
    editor.pointer('onPointerUp', 1000, 125)
    expect(hooks.rasterCalls).toBe(calls + 1); expect(editor.frameCount()).toBe(0)
    expect(editor.text()).toContain('红色区域待重绘')
    editor.key('z', { metaKey: true }); expect(editor.text()).toContain('0 / 128 笔')
    editor.key('y', { ctrlKey: true }); expect(editor.text()).toContain('1 / 128 笔')
    editor.click('黑白预览'); expect(editor.text()).toContain('白色区域待重绘')
    editor.click('保存蒙版')
    const saved = editor.onApply.mock.calls[0][0] as ImageEditMask
    expect(saved).toMatchObject({ width: 4096, height: 256, sourceAssetId: 'a'.repeat(43) })
    expect(saved.strokes[0].size).toBe(32 / 256)
    expect(saved.strokes[0].points[0]).toEqual({ x: .1, y: .5 }); expect(saved.strokes[0].points.at(-1)).toEqual({ x: 1, y: .5 })
  })

  it('isolates cancelled pointer gestures and B/E tools, clear, undo, and modal cancellation', () => {
    const editor = harness(undefined, { width: 800, height: 50 }); editor.load()
    editor.pointer('onPointerDown', 480, 125); editor.pointer('onPointerCancel', 600, 125)
    expect(editor.text()).toContain('0 / 128 笔')
    editor.key('e'); editor.pointer('onPointerDown', 480, 125); editor.pointer('onPointerUp', 500, 125)
    editor.key('b'); editor.pointer('onPointerDown', 480, 125); editor.pointer('onPointerMove', 560, 125, 2); editor.pointer('onPointerUp', 480, 125)
    editor.click('清空'); expect(editor.text()).toContain('0 / 128 笔')
    editor.key('z', { ctrlKey: true }); expect(editor.text()).toContain('2 / 128 笔')
    editor.click('保存蒙版')
    const saved = editor.onApply.mock.calls[0][0] as ImageEditMask
    expect(saved.strokes.map((stroke) => stroke.tool)).toEqual(['erase', 'brush'])
    expect(saved.strokes[1].points).toHaveLength(1)
    const cancelled = harness(); cancelled.load(); cancelled.key('Escape'); expect(cancelled.onApply).not.toHaveBeenCalled(); expect(cancelled.onClose).toHaveBeenCalledOnce()
  })

  it('requires explicit adaptation of a portable recipe and disables oversized source images', () => {
    const initial: ImageEditMask = { version: 1, width: 100, height: 100, strokes: [{ tool: 'brush', size: .2, points: [{ x: .5, y: .5 }] }] }
    const editor = harness(initial, { width: 400, height: 200 }); editor.load()
    expect(editor.text()).toContain('此蒙版尚未绑定原图')
    expect(() => editor.click('保存蒙版')).toThrow('Disabled')
    editor.click('确认适配当前原图'); editor.click('保存蒙版')
    expect(editor.onApply.mock.calls[0][0]).toEqual({ ...initial, sourceAssetId: 'a'.repeat(43), width: 400, height: 200 })
    const invalid = harness(undefined, { width: 4097, height: 100 }); invalid.load()
    expect(invalid.text()).toContain('4096'); expect(() => invalid.click('保存蒙版')).toThrow('Disabled')
  })
})
