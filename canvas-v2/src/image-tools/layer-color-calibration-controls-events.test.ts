import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayerColorCalibrationControlsProps } from './LayerColorCalibrationControls'
const runtime = vi.hoisted(() => ({ ref: { current: undefined as unknown } }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useRef(value: unknown) { runtime.ref.current ??= value; return runtime.ref } }))
import { LayerColorCalibrationControls } from './LayerColorCalibrationControls'
import { defaultImageLayerColorCalibration } from './layer-color-calibration'
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

describe('actual calibration controls callbacks', () => {
  it('keeps all seven latest values when an earlier field callback is retained', () => {
    let props: LayerColorCalibrationControlsProps = { onChange: vi.fn((value) => { props = { ...props, value } }) }
    const old = input(LayerColorCalibrationControls(props), '阴影色调'); expect(props.onChange).not.toHaveBeenCalled()
    const changes = [['阴影色调', 25], ['红原色色相', 40], ['红原色饱和度', -30], ['绿原色色相', -35], ['绿原色饱和度', 20], ['蓝原色色相', 30], ['蓝原色饱和度', -25]] as const
    for (const [label, value] of changes) set(input(LayerColorCalibrationControls(props), label), value)
    LayerColorCalibrationControls(props); set(old, -20)
    expect(props.value).toEqual({ version: 1, enabled: true, shadowTint: -20, redHue: 40, redSaturation: -30, greenHue: -35, greenSaturation: 20, blueHue: 30, blueSaturation: -25 })
    expect(props.onChange).toHaveBeenCalledTimes(8)
  })
  it('preserves zero and latent values when disabling and reenabling and allows editing while bypassed', () => {
    let props: LayerColorCalibrationControlsProps = { value: { ...defaultImageLayerColorCalibration(), redHue: 40, greenSaturation: -60 }, onChange: vi.fn((value) => { props = { ...props, value } }) }
    function toggle(enabled: boolean) { (input(LayerColorCalibrationControls(props), '启用校准').props.onChange as (event: unknown) => void)({ currentTarget: { checked: enabled } }) }
    toggle(false); set(input(LayerColorCalibrationControls(props), '红原色色相滑杆'), 0)
    expect(props.value).toEqual({ ...defaultImageLayerColorCalibration(), enabled: false, greenSaturation: -60 })
    toggle(true); expect(props.value).toEqual({ ...defaultImageLayerColorCalibration(), greenSaturation: -60 })
  })
  it('bounds finite numeric edits and rejects retained callbacks after the parent revokes editing', () => {
    let props: LayerColorCalibrationControlsProps = { onChange: vi.fn((value) => { props = { ...props, value } }) }
    set(input(LayerColorCalibrationControls(props), '红原色色相'), 999); set(input(LayerColorCalibrationControls(props), '绿原色色相'), -999); set(input(LayerColorCalibrationControls(props), '蓝原色色相'), 12.6)
    expect(props.value).toMatchObject({ redHue: 100, greenHue: -100, blueHue: 13 })
    const old = input(LayerColorCalibrationControls(props), '红原色色相'), count = vi.mocked(props.onChange).mock.calls.length
    set(old, NaN); set(old, Infinity); expect(props.onChange).toHaveBeenCalledTimes(count)
    props = { ...props, disabled: true }; LayerColorCalibrationControls(props); set(old, 0)
    expect(props.onChange).toHaveBeenCalledTimes(count)
  })
})
