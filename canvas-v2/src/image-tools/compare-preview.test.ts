import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ImageComparePreview } from './ComparePreview'
import { changeCompareParallelCount, changeCompareSelection, compareSliderPosition, createCompareViewState, resolveCompareSlot, type CompareImageSlot, type CompareSelectionTarget, type CompareViewState } from './compare-view-state'

function slots(): CompareImageSlot[] { return [0, 1, 2, 3, 4].map((index) => ({ key: String(index), label: `图片 ${index + 1}`, asset: { kind: 'image', localUrl: `xingmang-asset://image/${String(index).repeat(43)}` }, dimensions: { width: 400, height: 300 } })) }
const source = ts.createSourceFile('ComparePreview.tsx', readFileSync(new URL('./ComparePreview.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let found = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!found) throw new Error(`Missing actual compare handler ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${found});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function actualScopeEffect(environment: Record<string, unknown>): () => void {
  let found = ''
  function visit(node: ts.Node) { if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('current.before.a')) found = node.arguments[0].getText(source); ts.forEachChild(node, visit) }
  visit(source)
  if (!found) throw new Error('Missing actual compare scope effect')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${found});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment))
}
function pointer(clientX: number, pointerId = 1) { return { button: 0, clientX, pointerId, preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: { setPointerCapture: vi.fn(), getBoundingClientRect: () => ({ left: 100, width: 200 }) } } }
interface Gesture { kind: 'stage' | 'range'; pointerId: number | null; before: CompareViewState; next: CompareViewState; scopeKey: string; field: 'position' | 'opacity' }
function handlers(view: CompareViewState, disabled = false, drag = { current: null as Gesture | null }, onChange = vi.fn(), onCommit = vi.fn(), scopeKey = '') {
  const input = slots(), first = resolveCompareSlot(input, view.a), second = resolveCompareSlot(input, view.b)
  const environment = { slots: input, view, scopeKey, disabled, onChange, onCommit, drag, position: compareSliderPosition(view.position), canSlide: !disabled && first.status === 'ready' && second.status === 'ready', changeCompareSelection, changeCompareParallelCount, compareSliderPosition }
  const currentGesture = actual<() => Gesture | null>('currentGesture', environment)
  const beginGesture = actual<(kind: 'stage' | 'range', pointerId: number | null) => boolean>('beginGesture', environment)
  const changePosition = actual<(value: number) => void>('changePosition', { ...environment, currentGesture, beginGesture })
  const finishGesture = actual<() => void>('finishGesture', { ...environment, currentGesture })
  const cancelGesture = actual<() => void>('cancelGesture', { ...environment, currentGesture })
  const pointPosition = actual<(event: ReturnType<typeof pointer>) => void>('pointPosition', { ...environment, changePosition })
  return { drag, onChange, onCommit, changePosition, finishGesture, cancelGesture,
    changeSelection: actual<(target: CompareSelectionTarget, key: string | null) => void>('changeSelection', environment),
    changeParallelCount: actual<(count: 2 | 3) => void>('changeParallelCount', environment),
    swap: actual<() => void>('swap', environment),
    toggleOverlay: actual<() => void>('toggleOverlay', environment),
    pointerDown: actual<(event: ReturnType<typeof pointer>) => void>('pointerDown', { ...environment, pointPosition, beginGesture }),
    pointerMove: actual<(event: ReturnType<typeof pointer>) => void>('pointerMove', { ...environment, pointPosition, currentGesture }),
    pointerEnd: actual<(event: ReturnType<typeof pointer>) => void>('pointerEnd', { ...environment, pointPosition, finishGesture }),
    pointerCancel: actual<(event: ReturnType<typeof pointer>) => void>('pointerCancel', { ...environment, cancelGesture }),
    rangePointerDown: actual<(event: ReturnType<typeof pointer>) => void>('rangePointerDown', { ...environment, beginGesture }),
    rangeKeyDown: actual<(event: { key: string; preventDefault(): void; stopPropagation(): void }) => void>('rangeKeyDown', { ...environment, beginGesture, cancelGesture }),
    rangeKeyUp: actual<(event: { key: string }) => void>('rangeKeyUp', { ...environment, finishGesture }),
  }
}

describe('controlled comparison presentation', () => {
  it('uses identical selected images and slider position in the card and expanded view', () => {
    const input = slots(), view = { ...createCompareViewState(input), a: '3', b: '2', position: 80 }
    const card = renderToStaticMarkup(createElement(ImageComparePreview, { slots: input, view, onChange() {} }))
    const expanded = renderToStaticMarkup(createElement(ImageComparePreview, { slots: input, view, expanded: true, onChange() {} }))
    for (const html of [card, expanded]) {
      expect(html).toContain('alt="A · 图片 4"')
      expect(html).toContain('alt="B · 图片 3"')
      expect(html).toContain('value="80"')
      expect(html).not.toContain('alt="A · 图片 1"')
    }
    expect(expanded).toContain('image-compare-preview is-expanded')
  })

  it('clips both slider planes so transparent B pixels reveal the checker rather than image A', () => {
    const input = slots(), html = renderToStaticMarkup(createElement(ImageComparePreview, { slots: input, view: { ...createCompareViewState(input), position: 70 }, onChange() {} }))
    expect(html).toContain('class="image-compare-base" style="clip-path:inset(0 0 0 70%)"')
    expect(html).toContain('class="image-compare-reveal" style="clip-path:inset(0 30% 0 0)"')
  })

  it('preserves disconnected and waiting choices visibly without substituting later images', () => {
    const input = slots(), view = { ...createCompareViewState(input), a: 'missing:old', b: '1' }
    input[1].asset = undefined
    const html = renderToStaticMarkup(createElement(ImageComparePreview, { slots: input, view, onChange() {} }))
    expect(html).toContain('原输入已断开')
    expect(html).toContain('等待此输入图片就绪')
    expect(html).toContain('<option value="missing:old" selected="">')
    expect(html).not.toContain('<img')
    expect(html).toMatch(/aria-label="对比滑杆"[^>]*disabled=""/)
  })

  it('renders exactly four chosen grid positions and explains additional available inputs', () => {
    const input = slots(), view = { ...createCompareViewState(input, 'grid'), grid: ['4', '2', null, '0'] }
    const html = renderToStaticMarkup(createElement(ImageComparePreview, { slots: input, view, onChange() {} }))
    expect(html.match(/<figure/g)).toHaveLength(4)
    expect(html.match(/<img/g)).toHaveLength(3)
    expect(html).toContain('alt="格 1 · 图片 5"')
    expect(html).toContain('alt="格 4 · 图片 1"')
    expect(html).toContain('共 5 个输入')
    expect(html).toContain('最多同时显示 4 张')
    expect(html).not.toContain('alt="格 3 ·')
  })

  it('uses safe image handling and escapes user-supplied source labels', () => {
    const input = slots()
    input[0] = { ...input[0], label: '<script>unsafe</script>', asset: { kind: 'image', localUrl: 'https://untrusted.invalid/track.png' } }
    const html = renderToStaticMarkup(createElement(ImageComparePreview, { slots: input, view: createCompareViewState(input), onChange() {} }))
    expect(html).not.toContain('https://untrusted.invalid')
    expect(html).not.toContain('<script>unsafe')
    expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;')
    expect(html).toContain('A 图片无法读取')
  })

  it('renders three independently selected parallel images in both card and expanded views', () => {
    const input = slots(), view = { ...createCompareViewState(input, 'side-by-side'), sideBySideCount: 3 as const, a: '4', b: '2', c: '0' }
    for (const expanded of [false, true]) {
      const html = renderToStaticMarkup(createElement(ImageComparePreview, { slots: input, view, expanded, onChange() {} }))
      expect(html.match(/<figure/g)).toHaveLength(3)
      expect(html).toContain('image-compare-grid is-three')
      expect(html).toContain('alt="A · 图片 5"')
      expect(html).toContain('alt="B · 图片 3"')
      expect(html).toContain('alt="C · 图片 1"')
      expect(html).toContain('aria-label="对比图片 C"')
      expect(html).toContain('aria-pressed="true">三图并排')
    }
  })

  it('keeps missing or waiting C visible and does not replace it with another ready source', () => {
    const input = slots(), view = { ...createCompareViewState(input, 'side-by-side'), sideBySideCount: 3 as const, c: 'missing' }
    const missing = renderToStaticMarkup(createElement(ImageComparePreview, { slots: input, view, onChange() {} }))
    expect(missing.match(/<figure/g)).toHaveLength(3)
    expect(missing).toContain('<option value="missing" selected="">')
    expect(missing).not.toContain('alt="C ·')
    input[2].asset = undefined
    const waiting = renderToStaticMarkup(createElement(ImageComparePreview, { slots: input, view: { ...view, c: '2' }, onChange() {} }))
    expect(waiting).toContain('等待此输入图片就绪')
    expect(waiting).not.toContain('alt="C ·')
  })

  it('renders transparent A over B with independent opacity and preserves explicit zero', () => {
    const input = slots(), view = { ...createCompareViewState(input, 'opacity'), position: 72 }
    for (const [opacity, expected] of [[undefined, '.5'], [0, '0'], [79, '.79']] as const) {
      const html = renderToStaticMarkup(createElement(ImageComparePreview, { slots: input, view: { ...view, opacity }, onChange() {} }))
      expect(html.indexOf('alt="B · 底层')).toBeLessThan(html.indexOf('alt="A · 上层'))
      expect(html).toContain(`opacity:${expected === '0' ? '0' : `0${expected}`};visibility:visible`)
      expect(html).toContain('aria-label="叠加透明度"')
      expect(html).not.toContain('clip-path')
      expect(html).not.toContain('对比滑杆')
    }
  })

  it('renders an explicit toggle button and hides only the A overlay', () => {
    const input = slots(), view = { ...createCompareViewState(input, 'toggle'), overlayVisible: false }
    const html = renderToStaticMarkup(createElement(ImageComparePreview, { slots: input, view, expanded: true, onChange() {} }))
    expect(html).toContain('visibility:hidden')
    expect(html).toContain('aria-pressed="false">显示上层 A')
    expect(html.match(/image-compare-viewport-toolbar/g)).toHaveLength(1)
    expect(html).toContain('双图同步查看')
    expect(html).not.toContain('type="range"')
  })

  it('allocates one independent viewport per visible parallel cell and a blank fourth position', () => {
    const input = slots(), view = { ...createCompareViewState(input, 'side-by-side'), sideBySideCount: 3 as const, c: '2' }
    const html = renderToStaticMarkup(createElement(ImageComparePreview, { slots: input, view, expanded: true, onChange() {} }))
    expect(html.match(/image-compare-viewport-toolbar/g)).toHaveLength(3)
    expect(html).toContain('image-compare-unused-cell')
    expect(html).toContain('每格独立查看')
  })
})

describe('actual comparison interaction handlers', () => {
  it('commits opacity once per gesture without changing the separate slider position', () => {
    const view = { ...createCompareViewState(slots(), 'opacity'), position: 72, opacity: 50 }, f = handlers(view)
    f.rangePointerDown(pointer(100)); f.changePosition(60); f.changePosition(79)
    expect(f.onCommit).not.toHaveBeenCalled()
    f.pointerEnd(pointer(240)); f.finishGesture()
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith({ ...view, opacity: 79 })
    const cancel = handlers({ ...view, opacity: 0 })
    cancel.rangePointerDown(pointer(100)); cancel.changePosition(89); cancel.pointerCancel(pointer(100)); cancel.finishGesture()
    expect(cancel.onChange).toHaveBeenLastCalledWith({ ...view, opacity: 0 })
    expect(cancel.onCommit).not.toHaveBeenCalled()
  })

  it('commits opacity keyboard changes on release and invalidates a changed mode or external undo', () => {
    const view = { ...createCompareViewState(slots(), 'opacity'), opacity: 0 }, f = handlers(view)
    f.rangeKeyDown({ key: 'ArrowRight', preventDefault() {}, stopPropagation() {} }); f.changePosition(1); f.changePosition(2); f.rangeKeyUp({ key: 'ArrowRight' })
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith({ ...view, opacity: 2 })
    const g = handlers(view), previous = { current: 0 }
    const retain = actual<(drag: typeof g.drag, previous: { current: number }, value: CompareViewState, scope: string, ready: boolean) => void>('retainCompareGesture', {})
    g.changePosition(70); retain(g.drag, previous, { ...view, opacity: 70 }, '', true); retain(g.drag, previous, view, '', true); g.finishGesture()
    expect(g.onCommit).not.toHaveBeenCalled()
    g.changePosition(60); retain(g.drag, previous, { ...view, mode: 'slider' }, '', true); g.finishGesture()
    expect(g.onCommit).not.toHaveBeenCalled()
  })

  it('changes toggle visibility only through the explicit button and leaves view preferences intact', () => {
    const view = { ...createCompareViewState(slots(), 'toggle'), opacity: 79, position: 31 }, f = handlers(view)
    f.pointerDown(pointer(150)); f.pointerMove(pointer(270)); f.pointerEnd(pointer(270))
    expect(f.onChange).not.toHaveBeenCalled()
    f.toggleOverlay()
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith({ ...view, overlayVisible: false })
    const g = handlers({ ...view, overlayVisible: false })
    g.toggleOverlay()
    expect(g.onCommit).toHaveBeenCalledExactlyOnceWith({ ...view, overlayVisible: true })
    handlers(view, true, g.drag, g.onChange, g.onCommit).toggleOverlay()
    handlers({ ...view, mode: 'opacity' }, false, g.drag, g.onChange, g.onCommit).toggleOverlay()
    expect(g.onCommit).toHaveBeenCalledTimes(1)
  })
  it('commits third-slot opt-in and changes as discrete actions without losing existing choices', () => {
    const view = { ...createCompareViewState(slots(), 'side-by-side'), position: 72 }, f = handlers(view)
    f.changeParallelCount(2)
    expect(f.onCommit).not.toHaveBeenCalled()
    f.changeParallelCount(3)
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith({ ...view, sideBySideCount: 3, c: '2' })
    const next = handlers({ ...view, sideBySideCount: 3, c: '2' })
    next.changeSelection('c', '4')
    expect(next.onCommit).toHaveBeenCalledExactlyOnceWith({ ...view, sideBySideCount: 3, c: '4' })
    handlers(view, true, next.drag, next.onChange, next.onCommit).changeParallelCount(3)
    handlers({ ...view, mode: 'slider' }, false, next.drag, next.onChange, next.onCommit).changeParallelCount(3)
    expect(next.onCommit).toHaveBeenCalledTimes(1)
  })
  it('emits a controlled selection or swap without resetting the other view preferences', () => {
    const view = { ...createCompareViewState(slots()), position: 72 }, f = handlers(view)
    f.changeSelection('a', '4')
    expect(f.onChange).toHaveBeenLastCalledWith({ ...view, a: '4' })
    expect(f.onCommit).toHaveBeenLastCalledWith({ ...view, a: '4' })
    f.swap()
    expect(f.onChange).toHaveBeenLastCalledWith({ ...view, a: '1', b: '0' })
    f.changeSelection(2, null)
    expect(f.onChange).toHaveBeenLastCalledWith({ ...view, grid: ['0', '1', null, '3'] })
    expect(f.onCommit).toHaveBeenCalledTimes(3)
    f.onChange.mockClear(); f.changeSelection('b', 'missing'); f.changeSelection('a', '0')
    expect(f.onChange).not.toHaveBeenCalled()
  })

  it('routes range and direct drag updates through the same controlled position and respects the owner pointer', () => {
    const view = createCompareViewState(slots()), f = handlers(view)
    f.pointerDown(pointer(150))
    expect(f.onChange).toHaveBeenLastCalledWith({ ...view, position: 25 })
    f.onChange.mockClear(); f.pointerMove(pointer(290, 2)); f.pointerEnd(pointer(290, 2))
    expect(f.onChange).not.toHaveBeenCalled()
    expect(f.drag.current?.pointerId).toBe(1)
    f.pointerMove(pointer(260))
    expect(f.onChange).toHaveBeenLastCalledWith({ ...view, position: 80 })
    expect(f.onCommit).not.toHaveBeenCalled()
    f.pointerEnd(pointer(260)); f.onChange.mockClear(); f.pointerMove(pointer(290))
    expect(f.onChange).not.toHaveBeenCalled()
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith({ ...view, position: 80 })
    f.pointerCancel(pointer(260))
    expect(f.onChange).not.toHaveBeenCalled()
    expect(f.onCommit).toHaveBeenCalledTimes(1)
  })

  it('drops an in-progress direct drag after its selected input or mode changes', () => {
    const view = createCompareViewState(slots()), f = handlers(view)
    f.pointerDown(pointer(150)); f.onChange.mockClear()
    const changed = handlers({ ...view, a: '4' }, false, f.drag, f.onChange, f.onCommit)
    changed.pointerMove(pointer(290))
    expect(f.onChange).not.toHaveBeenCalled()
    expect(f.drag.current).toBeNull()
    changed.pointerDown(pointer(150)); f.onChange.mockClear()
    handlers({ ...view, a: '4', mode: 'grid' }, false, f.drag, f.onChange, f.onCommit).pointerMove(pointer(290))
    expect(f.onChange).not.toHaveBeenCalled()
    expect(f.onCommit).not.toHaveBeenCalled()
  })

  it('clears a detached slider gesture when its mode changes so switching back can start a new gesture', () => {
    const view = createCompareViewState(slots()), f = handlers(view)
    f.pointerDown(pointer(150)); f.onChange.mockClear()
    actualScopeEffect({ drag: f.drag, scopeKey: '', canSlide: true, view: { ...view, mode: 'grid' } })()
    expect(f.drag.current).toBeNull()
    expect(f.onChange).not.toHaveBeenCalled()
    expect(f.onCommit).not.toHaveBeenCalled()
    handlers(view, false, f.drag, f.onChange, f.onCommit).pointerDown(pointer(160))
    expect(f.onChange).toHaveBeenLastCalledWith({ ...view, position: 30 })
  })

  it.each(['pointerCancel', 'cancelGesture'] as const)('restores the starting position on %s without committing history', (method) => {
    const view = { ...createCompareViewState(slots()), position: 63 }, f = handlers(view)
    f.pointerDown(pointer(140)); f.pointerMove(pointer(270))
    expect(f.onChange).toHaveBeenLastCalledWith({ ...view, position: 85 })
    if (method === 'pointerCancel') f.pointerCancel(pointer(270))
    else f.cancelGesture()
    expect(f.onChange).toHaveBeenLastCalledWith(view)
    expect(f.onCommit).not.toHaveBeenCalled()
    f.pointerEnd(pointer(270))
    expect(f.onCommit).not.toHaveBeenCalled()
  })

  it('retains a controlled draft rerender but discards an external undo before passive effects', () => {
    const view = createCompareViewState(slots()), f = handlers(view), previousPosition = { current: view.position }
    const retain = actual<(drag: typeof f.drag, previous: { current: number }, view: CompareViewState, scopeKey: string, canSlide: boolean) => void>('retainCompareGesture', {})
    f.pointerDown(pointer(260))
    const draft = { ...view, position: 80 }
    retain(f.drag, previousPosition, draft, '', true)
    expect(f.drag.current?.next.position).toBe(80)
    // The undo uses the same A/B inputs and the old starting position.
    retain(f.drag, previousPosition, view, '', true)
    const afterUndo = handlers(view, false, f.drag, f.onChange, f.onCommit)
    afterUndo.pointerEnd(pointer(290))
    expect(f.onCommit).not.toHaveBeenCalled()
    expect(f.drag.current).toBeNull()
    afterUndo.pointerDown(pointer(180)); afterUndo.pointerEnd(pointer(180))
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith({ ...view, position: 40 })
  })

  it('discards a changed input scope even when its selected numeric slots are unchanged', () => {
    const view = createCompareViewState(slots()), f = handlers(view, false, undefined, undefined, undefined, 'old-inputs')
    f.rangePointerDown(pointer(100)); f.changePosition(70)
    const changed = handlers({ ...view, position: 70 }, false, f.drag, f.onChange, f.onCommit, 'new-inputs')
    changed.pointerEnd(pointer(240))
    expect(f.onCommit).not.toHaveBeenCalled()
    expect(f.drag.current).toBeNull()
  })

  it('commits native range pointer changes once and ignores the ensuing lost capture or blur', () => {
    const view = createCompareViewState(slots()), f = handlers(view)
    f.rangePointerDown(pointer(100)); f.changePosition(20); f.changePosition(75)
    expect(f.onCommit).not.toHaveBeenCalled()
    f.pointerEnd(pointer(250)); f.pointerCancel(pointer(250)); f.finishGesture()
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith({ ...view, position: 75 })
  })

  it('commits repeated range keyboard changes on keyup or blur, and lets Escape discard them', () => {
    const view = createCompareViewState(slots()), f = handlers(view)
    f.rangeKeyDown({ key: 'ArrowRight', preventDefault() {}, stopPropagation() {} }); f.changePosition(51); f.changePosition(52)
    expect(f.onCommit).not.toHaveBeenCalled()
    f.rangeKeyUp({ key: 'ArrowRight' }); f.finishGesture()
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith({ ...view, position: 52 })
    const next = handlers({ ...view, position: 52 })
    next.changePosition(70); next.finishGesture(); next.finishGesture()
    expect(next.onCommit).toHaveBeenCalledExactlyOnceWith({ ...view, position: 70 })
    const cancel = handlers(view), escape = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() }
    cancel.changePosition(70); cancel.rangeKeyDown(escape); cancel.rangeKeyUp({ key: 'ArrowRight' }); cancel.finishGesture()
    expect(cancel.onChange).toHaveBeenLastCalledWith(view)
    expect(cancel.onCommit).not.toHaveBeenCalled()
    expect(escape.stopPropagation).toHaveBeenCalledOnce()
  })

  it('does not mutate disabled comparisons or permit sliding when a selected input is missing', () => {
    const view = createCompareViewState(slots()), f = handlers(view, true)
    f.changeSelection('a', '4'); f.changePosition(70); f.swap(); f.pointerDown(pointer(150))
    expect(f.onChange).not.toHaveBeenCalled()
    const missing = handlers({ ...view, b: 'missing:old' })
    missing.changePosition(70); missing.pointerDown(pointer(150))
    expect(missing.onChange).not.toHaveBeenCalled()
  })
})
