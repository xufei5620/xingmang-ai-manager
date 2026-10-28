import { afterEach, describe, expect, it, vi } from 'vitest'
import { LayerMergeConfirmation, canConfirmLayerMergeReview, type LayerMergeConfirmationProps } from './LayerMergeConfirmation'
import { buildEditorLayerMergeCandidate, buildEditorLayerMergePlan } from './layer-editor-merge'
import { createLayerEditorState, defaultEditorImageLayer, selectEditorLayer } from './layer-editor-state'
import type { BrowserEditorLayerMergeReview } from '../library/browser-layer-merge-review'

const runtime = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef(initial: unknown) { const index = runtime.cursor++; runtime.slots[index] ??= { current: initial }; return runtime.slots[index] },
  useState(initial: unknown) { const index = runtime.cursor++, slots = runtime.slots; if (!(index in slots)) { const state = { value: typeof initial === 'function' ? initial() : initial, update(value: unknown) { state.value = typeof value === 'function' ? value(state.value) : value } }; slots[index] = state }; const state = slots[index] as { value: unknown; update(value: unknown): void }; return [state.value, state.update] },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) { const index = runtime.cursor++, slots = runtime.slots, previous = slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined; if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, at) => Object.is(value, previous.dependencies[at]))) return; runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } }) },
}))
vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), createPortal: (children: unknown) => children }))
interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type: unknown): ElementShape[] { if (Array.isArray(value)) return value.flatMap((item) => elements(item, type)); if (!value || typeof value !== 'object' || !('props' in value)) return []; const item = value as ElementShape; return [...(item.type === type ? [item] : []), ...elements(item.props.children, type)] }
function textOf(value: unknown): string { if (typeof value === 'string' || typeof value === 'number') return String(value); if (Array.isArray(value)) return value.map(textOf).join(''); return value && typeof value === 'object' && 'props' in value ? textOf((value as ElementShape).props.children) : '' }
function button(tree: unknown, label: string): ElementShape { const value = elements(tree, 'button').find((item) => item.props['aria-label'] === label || textOf(item.props.children) === label); expect(value, label).toBeDefined(); return value! }
function click(tree: unknown, label: string) { (button(tree, label).props.onClick as () => void)() }
function review(changed = 3): BrowserEditorLayerMergeReview {
  let state = createLayerEditorState({ kind: 'layer', outputWidth: 8, outputHeight: 6, background: 'transparent', explicitLayers: true, layers: [defaultEditorImageLayer(0), defaultEditorImageLayer(0)] }, 1)
  state = selectEditorLayer(state, 'layer-1'); state = selectEditorLayer(state, 'layer-2', { toggle: true })
  const plan = buildEditorLayerMergePlan(state.present), blob = new Blob(['image'], { type: 'image/png' })
  return { output: { blob, width: 8, height: 6 }, before: blob, after: blob, difference: blob, comparison: { width: 8, height: 6, totalPixels: 48, changedPixels: changed, maxChannelDelta: changed ? 15 : 0, meanChannelDelta: .125, rawChangedPixels: 12, rawMaxChannelDelta: 90, outputWindow: { width: 4, height: 3, x: 2, y: 1 } }, candidate: buildEditorLayerMergeCandidate(plan, { sourceIndex: 1, replacementId: 'layer-3' }) }
}
function fixture(value = review()) {
  const props: LayerMergeConfirmationProps = { names: ['Photo', 'Title'], groupNames: ['Poster'], placement: 'upper', destination: 'Root', review: value, busy: false, accepted: false, onAcceptedChange: vi.fn((accepted: boolean) => { props.accepted = accepted }), onPlacementChange: vi.fn(), onRetry: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn() }
  const owned = { slots: [] as unknown[], effects: [] as (() => void)[] }
  function pass() { runtime.cursor = 0; runtime.slots = owned.slots; runtime.effects = owned.effects; const result = LayerMergeConfirmation(props); owned.effects.splice(0).forEach((effect) => effect()); return result }
  const ui = { render() { pass(); return pass() }, close() { for (const slot of owned.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup(): void }).cleanup() } }
  vi.stubGlobal('document', { body: {}, activeElement: null })
  let number = 0; const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:review-${++number}`), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return { props, ui, create, revoke }
}
function decode(tree: unknown) { for (const image of elements(tree, 'img')) (image.props.onLoad as () => void)() }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('real merge review rendering and controls', () => {
  it('requires a complete review and all three decoded views before explicit changed-image acceptance', () => {
    const f = fixture(); let tree = f.ui.render()
    expect(button(tree, '确认栅格化并合并').props.disabled).toBe(true); expect(elements(tree, 'img')).toHaveLength(3)
    const images = elements(tree, 'img'); (images[0].props.onLoad as () => void)(); (images[1].props.onLoad as () => void)(); tree = f.ui.render()
    expect(button(tree, '确认栅格化并合并').props.disabled).toBe(true)
    ;(images[2].props.onLoad as () => void)(); tree = f.ui.render()
    expect(button(tree, '确认栅格化并合并').props.disabled).toBe(true)
    const consent = elements(tree, 'input').find((item) => item.props.type === 'checkbox')!
    ;(consent.props.onChange as (event: unknown) => void)({ target: { checked: true } }); tree = f.ui.render()
    expect(button(tree, '确认栅格化并合并').props.disabled).toBe(false); expect(f.props.onConfirm).not.toHaveBeenCalled()
    click(tree, '确认栅格化并合并'); expect(f.props.onConfirm).toHaveBeenCalledOnce(); f.ui.close()
  })

  it('requires a final click for a zero-difference candidate and shows document and output sizes separately', () => {
    const f = fixture(review(0)); let tree = f.ui.render(); decode(tree); tree = f.ui.render()
    expect(elements(tree, 'input')).toHaveLength(0); expect(button(tree, '确认栅格化并合并').props.disabled).toBe(false)
    expect(textOf(tree)).toContain('8 × 6 px'); expect(textOf(tree)).toContain('4 × 3 px'); expect(textOf(tree)).toContain('@ 2, 1'); expect(textOf(tree)).toContain('含文档裁剪外保留范围')
    expect(f.props.onConfirm).not.toHaveBeenCalled(); click(tree, '确认栅格化并合并'); expect(f.props.onConfirm).toHaveBeenCalledOnce(); f.ui.close()
  })

  it('shares pan and zoom between before, after and difference without changing acceptance', () => {
    const f = fixture(); let tree = f.ui.render(); decode(tree); tree = f.ui.render(); click(tree, '放大合并预览'); tree = f.ui.render()
    click(tree, '合并前'); tree = f.ui.render()
    expect(button(tree, '合并前').props['aria-pressed']).toBe(true)
    expect(elements(tree, 'img').map((image) => (image.props.style as { transform: string }).transform)).toEqual(Array(3).fill('translate(0px, 0px) scale(1.5)'))
    click(tree, '差异'); tree = f.ui.render(); expect(button(tree, '差异').props['aria-pressed']).toBe(true); expect(f.props.accepted).toBe(false)
    click(tree, '适应合并预览'); tree = f.ui.render(); expect(button(tree, '缩小合并预览').props.disabled).toBe(true); f.ui.close()
  })

  it('clears decoded readiness and object URLs on a replacement review and ignores late image events', () => {
    const f = fixture(); let tree = f.ui.render(); const old = elements(tree, 'img'); decode(tree); tree = f.ui.render()
    f.props.review = review(9); f.props.accepted = false; tree = f.ui.render()
    expect(f.revoke).toHaveBeenCalledTimes(3); expect(f.create).toHaveBeenCalledTimes(6)
    old.forEach((image) => (image.props.onLoad as () => void)()); tree = f.ui.render()
    expect(button(tree, '确认栅格化并合并').props.disabled).toBe(true)
    expect(elements(tree, 'input')[0].props.disabled).toBe(true)
    decode(tree); tree = f.ui.render(); expect(elements(tree, 'input')[0].props.disabled).toBe(false)
    f.ui.close(); expect(f.revoke).toHaveBeenCalledTimes(6)
  })

  it('blocks final confirmation on decode failure and offers explicit regeneration', () => {
    const f = fixture(); let tree = f.ui.render(); decode(tree); f.props.accepted = true; tree = f.ui.render()
    ;(elements(tree, 'img')[1].props.onError as () => void)(); tree = f.ui.render()
    expect(button(tree, '确认栅格化并合并').props.disabled).toBe(true); click(tree, '重新生成预览'); expect(f.props.onRetry).toHaveBeenCalledOnce()
    click(tree, '确认栅格化并合并'); expect(f.props.onConfirm).not.toHaveBeenCalled(); f.ui.close()
  })

  it('routes placement changes to a new review and keeps cancellation available during loading and upload', () => {
    const f = fixture(); f.props.busy = true; f.props.review = undefined; let tree = f.ui.render()
    const select = elements(tree, 'select')[0]; (select.props.onChange as (event: unknown) => void)({ target: { value: 'lower' } })
    expect(f.props.onPlacementChange).toHaveBeenCalledWith('lower'); expect(button(tree, '确认栅格化并合并').props.disabled).toBe(true)
    click(tree, '保留原图层'); expect(f.props.onCancel).toHaveBeenCalledOnce()
    f.props.uploading = true; tree = f.ui.render(); expect(elements(tree, 'select')[0].props.disabled).toBe(true); click(tree, '取消合并'); expect(f.props.onCancel).toHaveBeenCalledTimes(2); f.ui.close()
  })

  it('contains Escape and Tab in the topmost review while respecting IME input', () => {
    const f = fixture(); const tree = f.ui.render(), dialog = elements(tree, 'section').find((item) => item.props.role === 'dialog')!
    const handle = dialog.props.onKeyDown as (event: unknown) => void, stop = vi.fn(), prevent = vi.fn()
    handle({ key: 'Escape', nativeEvent: { isComposing: true }, stopPropagation: stop, preventDefault: prevent })
    expect(f.props.onCancel).not.toHaveBeenCalled()
    handle({ key: 'Escape', nativeEvent: {}, stopPropagation: stop, preventDefault: prevent })
    expect(f.props.onCancel).toHaveBeenCalledOnce(); expect(prevent).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledTimes(2)
    const first = { closest: () => null, getClientRects: () => [{}], focus: vi.fn() }, last = { ...first, focus: vi.fn() }
    ;(dialog.props.ref as { current: unknown }).current = { querySelectorAll: () => [first, last] }
    ;(document as unknown as { activeElement: unknown }).activeElement = last
    handle({ key: 'Tab', nativeEvent: {}, stopPropagation: stop, preventDefault: prevent }); expect(first.focus).toHaveBeenCalledOnce()
    ;(document as unknown as { activeElement: unknown }).activeElement = first
    handle({ key: 'Tab', shiftKey: true, nativeEvent: {}, stopPropagation: stop, preventDefault: prevent }); expect(last.focus).toHaveBeenCalledOnce(); f.ui.close()
  })

  it('never treats accepted consent as a substitute for a ready, visible and nonbusy review', () => {
    expect(canConfirmLayerMergeReview(undefined, true, false)).toBe(false)
    expect(canConfirmLayerMergeReview(review(), true, true)).toBe(false)
    expect(canConfirmLayerMergeReview(review(), true, false, false)).toBe(false)
    expect(canConfirmLayerMergeReview(review(), false, false)).toBe(false)
    expect(canConfirmLayerMergeReview(review(), true, false)).toBe(true)
    expect(canConfirmLayerMergeReview(review(0), false, false)).toBe(true)
  })
})
