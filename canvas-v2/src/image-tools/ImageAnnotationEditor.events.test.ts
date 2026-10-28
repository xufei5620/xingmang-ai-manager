import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageLayerRecipe } from './recipe'

const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], pending: [] as Array<() => void>, rasterCalls: 0 }))
vi.mock('react-dom', () => ({ createPortal: (tree: unknown) => tree }))
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
import { ImageAnnotationEditor } from './ImageAnnotationEditor'

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
function harness(dimensions = { width: 640, height: 480 }, save = vi.fn().mockResolvedValue(undefined), withDownload = true) {
  hooks.cursor = 0; hooks.values = []; hooks.pending = []
  const onClose = vi.fn(), onDownload = vi.fn().mockResolvedValue(undefined)
  const frames = new Map<number, () => void>(); let nextFrame = 0
  class Element { closest() { return null } }
  vi.stubGlobal('HTMLElement', Element)
  const document = { body: {}, activeElement: undefined, createElement: () => ({ getContext: () => ({ font: '', measureText: (text: string) => ({ width: Array.from(text).length * 16 }) }) }) }
  vi.stubGlobal('window', { document }); vi.stubGlobal('document', document)
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  let tree: unknown
  function render() { hooks.cursor = 0; tree = ImageAnnotationEditor({ asset: { assetId: 'a'.repeat(43), localUrl: '/asset.png', mimeType: 'image/png', fileName: 'sample.png', thumbnailUrl: '', mediaType: 'image', createdAt: '', width: 1, height: 1 }, onSave: save, onDownload: withDownload ? onDownload : undefined, onClose }); hooks.pending.splice(0).forEach((effect) => effect()) }
  function element(predicate: (element: ElementShape) => boolean) { const found = findElement(tree, predicate); if (!found) throw new Error('Missing element'); return found }
  function action(el: ElementShape, name: string, event: unknown = {}) { (el.props[name] as (event: unknown) => void)(event); render() }
  function click(label: string) { const el = element((entry) => entry.type === 'button' && (entry.props['aria-label'] === label || text(entry.props.children) === label)); if (el.props.disabled) throw new Error(`Disabled: ${label}`); action(el, 'onClick') }
  function key(key: string, modifiers: Record<string, boolean> = {}) { action(element((entry) => entry.type === 'section'), 'onKeyDown', { key, target: new Element(), preventDefault() {}, stopPropagation() {}, ...modifiers }) }
  function input(label: string, value: string) { action(element((entry) => entry.props['aria-label'] === label), 'onChange', { target: { value } }) }
  function blur(label: string) { action(element((entry) => entry.props['aria-label'] === label), 'onBlur') }
  function inputKey(label: string, key: string, isComposing: boolean, keyCode = 0) { action(element((entry) => entry.props['aria-label'] === label), 'onKeyDown', { key, shiftKey: false, nativeEvent: { isComposing, keyCode }, preventDefault() {} }) }
  const captured = new Set<number>()
  const target = { getBoundingClientRect: () => ({ left: 0, top: 0, width: dimensions.width, height: dimensions.height }), setPointerCapture: (id: number) => captured.add(id), hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: (id: number) => captured.delete(id) }
  function pointer(name: string, x: number, y: number, pointerId = 1) { action(element((entry) => entry.props['aria-label'] === '图片标注画布'), name, { button: 0, pointerId, clientX: x, clientY: y, currentTarget: target, preventDefault() {}, stopPropagation() {} }) }
  render()
  function load() { action(element((entry) => entry.props.alt === '标注原图'), 'onLoad', { currentTarget: { naturalWidth: dimensions.width, naturalHeight: dimensions.height } }); render() }
  return { load, click, key, pointer, input, blur, inputKey, onSave: save, onDownload, onClose, text: () => text(tree), render, frameCount: () => frames.size, flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((frame) => frame()); render() }, element }
}
afterEach(() => vi.unstubAllGlobals())

describe('actual annotation editor callbacks', () => {
  it('uses decoded dimensions, frames pointer previews and exports undoable bounded strokes', async () => {
    const e = harness({ width: 4096, height: 256 }); e.load()
    e.pointer('onPointerDown', 100, 120)
    for (let x = 120; x < 600; x += 10) e.pointer('onPointerMove', x, 120)
    expect(e.frameCount()).toBe(1); expect(e.text()).toContain('0 条标注')
    e.flush(); expect(e.text()).toContain('0 条标注')
    e.pointer('onPointerUp', 5000, 120); expect(e.text()).toContain('1 条标注')
    e.key('z', { metaKey: true }); expect(e.text()).toContain('0 条标注')
    e.key('y', { ctrlKey: true }); expect(e.text()).toContain('1 条标注')
    e.click('下载 PNG'); await Promise.resolve()
    const recipe = e.onDownload.mock.calls[0][0] as ImageLayerRecipe
    expect(recipe.outputWidth).toBe(4096); expect(recipe.outputHeight).toBe(256)
    expect(recipe.layers[1].edits?.operations[0]).toMatchObject({ points: expect.arrayContaining([[10000, 4688]]) })
    expect(e.onClose).not.toHaveBeenCalled()
  })
  it('cancels foreign pointers and gestures, erases only marks and restores clear through undo', async () => {
    const e = harness(); e.load(); e.pointer('onPointerDown', 40, 40); e.pointer('onPointerCancel', 100, 100)
    expect(e.text()).toContain('0 条标注')
    e.pointer('onPointerDown', 40, 40); e.pointer('onPointerMove', 80, 80, 2); e.pointer('onPointerUp', 40, 40)
    e.key('e'); e.pointer('onPointerDown', 40, 40); e.pointer('onPointerUp', 40, 40)
    e.click('清空'); e.click('确认清空全部标注'); expect(e.text()).toContain('0 条标注')
    e.key('z', { ctrlKey: true }); expect(e.text()).toContain('1 条标注')
    e.click('下载 PNG'); await Promise.resolve()
    const recipe = e.onDownload.mock.calls[0][0] as ImageLayerRecipe
    expect(recipe.layers[0].edits).toBeUndefined(); expect(recipe.layers[1].edits?.operations.map((op) => op.mode)).toEqual(['paint', 'erase'])
  })
  it('places text at a click, updates an existing label without duplicating and moves its whole group', async () => {
    const e = harness(); e.load(); e.click('标签'); e.pointer('onPointerDown', 40, 40)
    expect(e.text()).toContain('1 条标注')
    e.input('标签文字', '修改后的标签'); e.blur('标签文字'); expect(e.text()).toContain('1 条标注')
    e.pointer('onPointerDown', 50, 50); e.pointer('onPointerMove', 150, 150); e.pointer('onPointerUp', 150, 150)
    e.key('t'); e.pointer('onPointerDown', 40, 350); e.input('画面文字', 'Clicked text'); e.blur('画面文字')
    expect(e.text()).toContain('2 条标注')
    e.click('保存至当前节点'); await Promise.resolve()
    const recipe = e.onSave.mock.calls[0][0] as ImageLayerRecipe
    const labels = recipe.layers.filter((layer) => layer.content?.kind === 'text')
    expect(labels).toHaveLength(2); expect(labels[0].content).toMatchObject({ text: '修改后的标签' }); expect(labels[0].x).toBeGreaterThan(140 / 640)
    expect(labels[1].y).toBe(350 / 480); expect(e.onSave.mock.calls[0][1]).toBe('replace'); expect(e.onClose).toHaveBeenCalledOnce()
  })

  it('matches soft brush preview core and blur with exported paint semantics', async () => {
    const e = harness(); e.load(); e.input('画笔类型', 'soft'); e.input('标注线宽', '60')
    e.pointer('onPointerDown', 100, 100); e.pointer('onPointerUp', 200, 100)
    const visual = e.element((entry) => typeof entry.type === 'function' && !!entry.props.object && !!entry.props.document)
    const visualTree = (visual.type as (props: Record<string, unknown>) => unknown)(visual.props)
    const stroke = findElement(visualTree, (entry) => typeof entry.type === 'function' && entry.props.hardness === .15)!
    const strokeTree = (stroke.type as (props: Record<string, unknown>) => unknown)(stroke.props)
    expect(findElement(strokeTree, (entry) => entry.type === 'path')?.props.strokeWidth).toBe(9)
    expect(findElement(strokeTree, (entry) => entry.type === 'filter')?.props.filterUnits).toBe('userSpaceOnUse')
    expect(findElement(strokeTree, (entry) => entry.type === 'feGaussianBlur')?.props.stdDeviation).toBe(8.5)
    e.click('下载 PNG'); await Promise.resolve()
    const recipe = e.onDownload.mock.calls[0][0] as ImageLayerRecipe
    expect(recipe.layers[1].edits?.operations[0]).toMatchObject({ size: 60, hardness: .15 })
  })

  it('preserves IME composition and flushes a pending label draft on save', async () => {
    const e = harness(); e.load(); expect(() => e.click('保存至当前节点')).toThrow('Disabled')
    e.key('t'); e.pointer('onPointerDown', 50, 50); e.input('画面文字', '商品')
    e.inputKey('画面文字', 'Enter', true); expect(e.text()).toContain('0 条标注')
    e.inputKey('画面文字', 'Enter', false, 229); expect(e.text()).toContain('0 条标注')
    e.inputKey('画面文字', 'Enter', false); expect(e.text()).toContain('1 条标注')
    e.click('清空'); e.click('取消清空'); expect(e.text()).toContain('1 条标注')
    e.click('标签'); e.pointer('onPointerDown', 150, 150); e.input('标签文字', '未失焦的标签正文')
    e.click('保存至当前节点'); await Promise.resolve()
    const recipe = e.onSave.mock.calls[0][0] as ImageLayerRecipe
    expect(recipe.layers.some((layer) => layer.content?.kind === 'text' && layer.content.text === '未失焦的标签正文')).toBe(true)
  })
  it('disables inapplicable text controls for selected geometry and enables label styling', () => {
    const e = harness(); e.load(); e.pointer('onPointerDown', 40, 40); e.pointer('onPointerUp', 80, 80)
    e.key('v'); e.pointer('onPointerDown', 40, 40); e.pointer('onPointerUp', 40, 40)
    for (const label of ['标签文字', '标注字号', '文字颜色', '标签背景颜色', '标签背景透明度', '标签圆角']) expect(e.element((entry) => entry.props['aria-label'] === label).props.disabled).toBe(true)
    e.click('标签'); e.pointer('onPointerDown', 180, 180)
    for (const label of ['标签文字', '标注字号', '文字颜色', '标签背景颜色', '标签背景透明度', '标签圆角']) expect(e.element((entry) => entry.props['aria-label'] === label).props.disabled).toBe(false)
  })

  it('keeps failed drafts, gates repeated saves and aborts in-flight work on close', async () => {
    let finish: () => void = () => {}
    const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const e = harness(undefined, save); e.load(); e.pointer('onPointerDown', 40, 40); e.pointer('onPointerUp', 80, 80)
    e.click('另存为新节点'); expect(save).toHaveBeenCalledOnce()
    e.click('关闭标注编辑器'); expect((save.mock.calls[0] as unknown as [ImageLayerRecipe, string, AbortSignal])[2].aborted).toBe(true)
    finish(); await Promise.resolve(); expect(e.onClose).toHaveBeenCalledOnce()
    const failed = harness(undefined, vi.fn().mockRejectedValue(new Error('测试导出失败'))); failed.load(); failed.pointer('onPointerDown', 40, 40); failed.pointer('onPointerUp', 80, 80); failed.click('另存为新节点')
    await Promise.resolve(); await Promise.resolve(); failed.render()
    expect(failed.text()).toContain('测试导出失败'); expect(failed.text()).toContain('1 条标注'); expect(failed.onClose).not.toHaveBeenCalled()
  })

  it('offers no PNG download when the host blocks page downloads', () => {
    const e = harness(undefined, undefined, false); e.load()
    expect(e.text()).toContain('另存为新节点'); expect(e.text()).not.toContain('下载 PNG')
  })
})
