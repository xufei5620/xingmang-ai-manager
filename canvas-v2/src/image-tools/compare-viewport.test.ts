import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { CompareViewport } from './CompareViewport'
import { createCompareViewportInteraction } from './compare-viewport-state'
import { compareSliderPosition, createCompareViewState, type CompareViewState } from './compare-view-state'

const source = ts.createSourceFile('CompareViewport.tsx', readFileSync(new URL('./CompareViewport.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const previewSource = ts.createSourceFile('ComparePreview.tsx', readFileSync(new URL('./ComparePreview.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function sliderHandlers() {
  const view = createCompareViewState([{ key: '0', label: 'A', dimensions: { width: 400, height: 300 } }, { key: '1', label: 'B', dimensions: { width: 400, height: 300 } }])
  const drag = { current: null }, onChange = vi.fn(), onCommit = vi.fn()
  const environment: Record<string, unknown> = { view, drag, onChange, onCommit, canSlide: true, scopeKey: '', compareSliderPosition }
  for (const name of ['currentGesture', 'beginGesture', 'changePosition', 'finishGesture', 'pointPosition', 'pointerDown', 'pointerEnd']) {
    let found = ''
    function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(previewSource); ts.forEachChild(node, visit) }
    visit(previewSource)
    if (!found) throw new Error(`Missing slider handler ${name}`)
    environment[name] = new Function(...Object.keys(environment), ts.transpileModule(`return (${found});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment))
  }
  return { view, onChange, onCommit, down: environment.pointerDown as (event: ReturnType<typeof pointer>) => void, up: environment.pointerEnd as (event: ReturnType<typeof pointer>) => void }
}
function actual<T>(kind: 'function' | 'attribute' | 'effect', name: string, environment: Record<string, unknown>): T {
  let found = ''
  function visit(node: ts.Node) {
    if (kind === 'function' && ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(source)
    if (kind === 'attribute' && ts.isJsxAttribute(node) && node.name.getText(source) === name && node.initializer && ts.isJsxExpression(node.initializer)) found = node.initializer.expression?.getText(source) ?? ''
    if (kind === 'effect' && ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') found = node.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!found) throw new Error(`Missing actual viewport ${kind} ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${found});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function pointer(pointerId = 1, clientX = 10, clientY = 10) { return { pointerId, clientX, clientY, button: 0, isPrimary: true, preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: { focus: vi.fn(), setPointerCapture: vi.fn(), getBoundingClientRect: () => ({ left: 0, width: 100 }) } } }
function setup(panMode = true) {
  const controller = createCompareViewportInteraction(vi.fn()); controller.sync('a', true); controller.scale(2, { width: 120, height: 300 })
  const current = { current: { scopeKey: 'a', disabled: false } }
  const stage = { current: { querySelector: vi.fn(() => ({ getBoundingClientRect: () => ({ width: 120, height: 300 }) })), getBoundingClientRect: () => ({ width: 1200, height: 300 }) } }
  const bounds = actual<() => { width: number; height: number }>('function', 'bounds', { stage })
  const environment = { interaction: { current: controller }, current, scopeKey: 'a', active: () => current.current.scopeKey === 'a' && !current.current.disabled, panMode, bounds, setSpace: vi.fn(), setHand: vi.fn() }
  return { controller, current, bounds, stage, environment,
    down: actual<(event: ReturnType<typeof pointer>) => void>('attribute', 'onPointerDownCapture', environment),
    move: actual<(event: ReturnType<typeof pointer>) => void>('attribute', 'onPointerMoveCapture', environment),
    up: actual<(event: ReturnType<typeof pointer>) => void>('attribute', 'onPointerUpCapture', environment),
    cancel: actual<(event: ReturnType<typeof pointer>) => void>('attribute', 'onPointerCancel', environment),
    lost: actual<(event: ReturnType<typeof pointer>) => void>('attribute', 'onLostPointerCapture', environment),
  }
}

describe('actual comparison viewport controls', () => {
  it('uses the inner clipping area instead of the wider surrounding fullscreen column', () => {
    const f = setup(); expect(f.bounds()).toEqual({ width: 120, height: 300 })
    f.down(pointer()); f.move(pointer(1, 1000, 1000)); f.up(pointer())
    expect(f.controller.read()).toEqual({ scale: 2, x: 60, y: 150 })
    expect(f.stage.current.querySelector).toHaveBeenCalledWith('.image-compare-stage, .image-compare-cell')
  })

  it('leaves normal slider gestures to the child but captures explicit hand or Space panning', () => {
    const slider = setup(false), normal = pointer(); slider.down(normal)
    expect(normal.stopPropagation).not.toHaveBeenCalled()
    expect(normal.currentTarget.setPointerCapture).not.toHaveBeenCalled()
    expect(slider.controller.pending()).toBeNull()
    const hand = setup(true), event = pointer(); hand.down(event)
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(event.currentTarget.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1)
    hand.move(pointer(1, 45, 40)); hand.up(pointer(1)); hand.lost(pointer(1))
    expect(hand.controller.read()).toEqual({ scale: 2, x: 35, y: 30 })
  })

  it.each(['hand', 'Space'])('blocks the actual child slider while %s is active at fit scale', () => {
    const f = setup(true), child = sliderHandlers(), event = pointer(1, 80, 20)
    f.controller.reset(); f.down(event)
    if (!event.stopPropagation.mock.calls.length) child.down(event)
    child.up(event)
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(event.currentTarget.setPointerCapture).not.toHaveBeenCalled()
    expect(child.onChange).not.toHaveBeenCalled()
    expect(child.onCommit).not.toHaveBeenCalled()
    expect(f.controller.read()).toEqual({ scale: 1, x: 0, y: 0 })
    // Without hand/Space the identical press still edits the persistent slider.
    const normal = setup(false), press = pointer(1, 80, 20)
    normal.controller.reset(); normal.down(press)
    if (!press.stopPropagation.mock.calls.length) child.down(press)
    child.up(press)
    expect(child.onCommit).toHaveBeenCalledExactlyOnceWith({ ...child.view, position: 80 } satisfies CompareViewState)
  })

  it.each([false, true])('blocks a nonprimary pointer before the child slider with pan mode %s', (panMode) => {
    const f = setup(panMode), child = sliderHandlers(), second = { ...pointer(2, 80, 20), isPrimary: false }
    f.controller.reset(); f.down(second)
    if (!second.stopPropagation.mock.calls.length) child.down(second)
    child.up(second)
    expect(second.stopPropagation).toHaveBeenCalledOnce()
    expect(second.currentTarget.setPointerCapture).not.toHaveBeenCalled()
    expect(child.onChange).not.toHaveBeenCalled()
    expect(child.onCommit).not.toHaveBeenCalled()
  })

  it('ignores a second pointer cancellation and restores pan on owned pointer loss', () => {
    const f = setup(); f.down(pointer()); f.move(pointer(1, 40, 30)); f.cancel(pointer(2))
    expect(f.controller.pending()).toBe(1)
    f.lost(pointer(1)); expect(f.controller.read()).toEqual({ scale: 2, x: 0, y: 0 })
    f.current.current.scopeKey = 'new-source'
    const event = pointer(); f.down(event)
    expect(event.currentTarget.setPointerCapture).not.toHaveBeenCalled()
  })

  it('keeps Space transient and lets Escape close the dialog when no gesture is active', () => {
    const f = setup(), keydown = actual<(event: { key: string; nativeEvent: { isComposing: boolean }; ctrlKey?: boolean; preventDefault(): void; stopPropagation(): void }) => void>('attribute', 'onKeyDown', f.environment)
    const event = { key: ' ', nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    keydown(event); expect(f.environment.setSpace).toHaveBeenCalledExactlyOnceWith(true)
    event.key = 'Escape'; event.stopPropagation.mockClear(); keydown(event)
    expect(event.stopPropagation).not.toHaveBeenCalled()
    f.down(pointer()); f.move(pointer(1, 40, 30)); keydown(event)
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(f.controller.read()).toEqual({ scale: 2, x: 0, y: 0 })
    f.environment.setSpace.mockClear(); event.key = ' '; keydown({ ...event, ctrlKey: true })
    expect(f.environment.setSpace).not.toHaveBeenCalled()
  })

  it('does not let an old effect cleanup disable the next source and reactivates strict effect setup', () => {
    const f = setup(), target = { addEventListener: vi.fn(), removeEventListener: vi.fn() }, environment = { ...f.environment, stage: { current: target } }
    const effect = actual<() => () => void>('effect', '', environment), cleanup = effect()
    expect(target.addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false })
    f.current.current.scopeKey = 'b'; f.controller.sync('b', true); f.controller.scale(3, f.bounds()); cleanup()
    expect(f.controller.read().scale).toBe(3)
    expect(f.controller.zoom(-10, f.bounds())).toBe(true)
    f.current.current.scopeKey = 'a'; effect()(); effect()
    expect(f.controller.zoom(-10, f.bounds())).toBe(true)
  })

  it('renders keyboard-accessible fit, zoom and explicit slider hand controls without persistent state', () => {
    const html = renderToStaticMarkup(createElement(CompareViewport, { label: '双图', scopeKey: 'a', disabled: false, slider: true, children: (style) => createElement('img', { alt: 'preview', style }) }))
    expect(html).toContain('role="region" tabindex="0"')
    expect(html).toContain('aria-label="平移对比图片"')
    expect(html).toContain('transform:translate(0px, 0px) scale(1)')
    expect(html).toContain('aria-label="适配双图"')
    const disabled = renderToStaticMarkup(createElement(CompareViewport, { label: 'C', scopeKey: 'a', disabled: true, children: () => null }))
    expect(disabled).toContain('tabindex="-1"')
    expect(disabled.match(/<button[^>]*disabled=""/g)).toHaveLength(3)
  })
})
