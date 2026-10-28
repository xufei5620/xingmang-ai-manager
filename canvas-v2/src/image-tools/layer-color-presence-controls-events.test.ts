import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayerColorPresenceControlsProps } from './LayerColorPresenceControls'
const runtime = vi.hoisted(() => ({ ref: { current: undefined as unknown } }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useRef(value: unknown) { runtime.ref.current ??= value; return runtime.ref } }))
import { LayerColorPresenceControls } from './LayerColorPresenceControls'
import { defaultImageLayerColorPresence } from './layer-color-presence'
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

describe('actual texture clarity and dehaze callbacks', () => {
  it('creates a full configuration only after an actual edit and keeps all latest fields', () => {
    let props: LayerColorPresenceControlsProps = { onChange: vi.fn((value) => { props = { ...props, value } }) }
    const tree = LayerColorPresenceControls(props); expect(props.onChange).not.toHaveBeenCalled()
    const oldTexture = input(tree, '纹理')
    set(oldTexture, 60); set(input(LayerColorPresenceControls(props), '清晰度'), -40); set(input(LayerColorPresenceControls(props), '去除薄雾'), 30)
    LayerColorPresenceControls(props); set(oldTexture, -20)
    expect(props.value).toEqual({ version: 1, enabled: true, texture: -20, clarity: -40, dehaze: 30 }); expect(props.onChange).toHaveBeenCalledTimes(4)
  })
  it('preserves latent settings when disabling, editing and reenabling without resetting any other field', () => {
    let props: LayerColorPresenceControlsProps = { value: { ...defaultImageLayerColorPresence(), texture: 60, clarity: 40, dehaze: 30 }, onChange: vi.fn((value) => { props = { ...props, value } }) }
    function toggle(enabled: boolean) { (input(LayerColorPresenceControls(props), '启用质感与去雾').props.onChange as (event: unknown) => void)({ currentTarget: { checked: enabled } }) }
    toggle(false); set(input(LayerColorPresenceControls(props), '清晰度滑杆'), -25)
    expect(props.value).toEqual({ version: 1, enabled: false, texture: 60, clarity: -25, dehaze: 30 })
    toggle(true); expect(props.value).toEqual({ version: 1, enabled: true, texture: 60, clarity: -25, dehaze: 30 })
  })
  it('bounds keyboard numeric edits, ignores nonfinite drafts and blocks retained callbacks after permission changes', () => {
    let props: LayerColorPresenceControlsProps = { onChange: vi.fn((value) => { props = { ...props, value } }) }
    set(input(LayerColorPresenceControls(props), '纹理'), 999); set(input(LayerColorPresenceControls(props), '清晰度'), -999); set(input(LayerColorPresenceControls(props), '去除薄雾'), 12.6)
    expect(props.value).toEqual({ version: 1, enabled: true, texture: 100, clarity: -100, dehaze: 13 })
    const old = input(LayerColorPresenceControls(props), '纹理'), count = vi.mocked(props.onChange).mock.calls.length
    set(old, NaN); set(old, Infinity); expect(props.onChange).toHaveBeenCalledTimes(count)
    props = { ...props, disabled: true }; LayerColorPresenceControls(props); set(old, 0)
    expect(props.onChange).toHaveBeenCalledTimes(count)
  })
})
