import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayerColorDetailControlsProps } from './LayerColorDetailControls'
const runtime = vi.hoisted(() => ({ ref: { current: undefined as unknown } }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useRef(value: unknown) { runtime.ref.current ??= value; return runtime.ref } }))
import { LayerColorDetailControls } from './LayerColorDetailControls'
import { defaultImageLayerColorDetail } from './layer-color-detail'
interface Element { type: unknown; props: Record<string, unknown> }
function inputs(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(inputs)
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const node = value as Element
  if (typeof node.type === 'function') return inputs(node.type(node.props))
  return [...(node.type === 'input' ? [node] : []), ...inputs(node.props.children)]
}
function input(tree: unknown, label: string) { const field = inputs(tree).find((node) => node.props['aria-label'] === label); expect(field, label).toBeDefined(); return field! }
function set(field: Element, value: number) { (field.props.onChange as (event: unknown) => void)({ currentTarget: { valueAsNumber: value } }) }
beforeEach(() => { runtime.ref = { current: undefined } })

describe('actual color detail control callbacks', () => {
  it('creates an explicit complete configuration only after an actual control edit', () => {
    const props: LayerColorDetailControlsProps = { onChange: vi.fn() }, tree = LayerColorDetailControls(props)
    expect(props.onChange).not.toHaveBeenCalled()
    set(input(tree, '锐化数量'), 80)
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ ...defaultImageLayerColorDetail(), sharpening: { amount: 80, radius: 1, detail: 25, masking: 0 } })
  })
  it('routes all ten number controls to their own fields while retaining the newest other controls', () => {
    let props: LayerColorDetailControlsProps = { value: defaultImageLayerColorDetail(), onChange: vi.fn((value) => { props = { ...props, value } }) }
    const changes = [['锐化数量', 80], ['锐化半径', 1.5], ['锐化细节', 40], ['锐化蒙版', 35], ['明亮度降噪', 70], ['明亮度细节', 45], ['明亮度对比度', 20], ['颜色降噪', 60], ['颜色细节', 55], ['颜色平滑度', 65]] as const
    for (const [label, value] of changes) set(input(LayerColorDetailControls(props), label), value)
    expect(props.value).toEqual({ version: 1, enabled: true, sharpening: { amount: 80, radius: 1.5, detail: 40, masking: 35 }, luminance: { amount: 70, detail: 45, contrast: 20 }, color: { amount: 60, detail: 55, smoothness: 65 } })
    expect(props.onChange).toHaveBeenCalledTimes(10)
  })
  it('keeps disabled and zero-amount settings editable and preserves latent values when toggled', () => {
    let props: LayerColorDetailControlsProps = { value: { ...defaultImageLayerColorDetail(), enabled: false }, onChange: vi.fn((value) => { props = { ...props, value } }) }
    set(input(LayerColorDetailControls(props), '锐化细节'), 67)
    expect(props.value?.enabled).toBe(false); expect(props.value?.sharpening.amount).toBe(0)
    const toggle = input(LayerColorDetailControls(props), '启用细节与降噪')
    const onChange = toggle.props.onChange as (event: unknown) => void
    onChange({ currentTarget: { checked: true } })
    expect(props.value).toMatchObject({ enabled: true, sharpening: { amount: 0, detail: 67 } })
  })
  it('bounds controls, ignores invalid numeric edits, and refuses a retained callback after editing is disabled', () => {
    let props: LayerColorDetailControlsProps = { onChange: vi.fn((value) => { props = { ...props, value } }) }
    let tree = LayerColorDetailControls(props)
    set(input(tree, '锐化数量'), 999); tree = LayerColorDetailControls(props); expect(props.value?.sharpening.amount).toBe(150)
    set(input(tree, '锐化半径'), .1); tree = LayerColorDetailControls(props); expect(props.value?.sharpening.radius).toBe(.5)
    const old = input(tree, '颜色降噪'), count = vi.mocked(props.onChange).mock.calls.length
    set(old, NaN); expect(props.onChange).toHaveBeenCalledTimes(count)
    props = { ...props, disabled: true }; LayerColorDetailControls(props); set(old, 90)
    expect(props.onChange).toHaveBeenCalledTimes(count)
  })
})
