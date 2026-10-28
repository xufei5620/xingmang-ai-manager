import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetColorLutSource, ColorLutSelection } from './layer-color-lut-selection'

const runtime = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef(initial: unknown) { const index = runtime.cursor++; runtime.slots[index] ??= { current: initial }; return runtime.slots[index] },
  useState(initial: unknown) { const index = runtime.cursor++; if (!(index in runtime.slots)) runtime.slots[index] = typeof initial === 'function' ? initial() : initial; return [runtime.slots[index], (next: unknown) => { runtime.slots[index] = typeof next === 'function' ? next(runtime.slots[index]) : next }] },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) { const index = runtime.cursor++, previous = runtime.slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined; if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, at) => Object.is(value, previous.dependencies[at]))) return; runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } }) },
}))
import { LayerColorLutControls, type LayerColorLutControlsProps } from './LayerColorLutControls'
import { buildColorLutSelection } from './layer-color-lut-selection'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type: unknown): ElementShape[] { if (Array.isArray(value)) return value.flatMap((item) => elements(item, type)); if (!value || typeof value !== 'object' || !('props' in value)) return []; const element = value as ElementShape; return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)] }
function textOf(value: unknown): string { if (typeof value === 'string' || typeof value === 'number') return String(value); if (Array.isArray(value)) return value.map(textOf).join(''); return value && typeof value === 'object' && 'props' in value ? textOf((value as ElementShape).props.children) : '' }
function control(tree: unknown, type: string, label: string): ElementShape { const found = elements(tree, type).find((element) => element.props['aria-label'] === label || textOf(element.props.children) === label); expect(found, label).toBeDefined(); return found! }
function click(tree: unknown, label: string) { const button = control(tree, 'button', label); expect(button.props.disabled).not.toBe(true); (button.props.onClick as () => void)() }
function event(tree: unknown, type: string, label: string, values: Record<string, unknown>) { (control(tree, type, label).props.onChange as (event: unknown) => void)({ currentTarget: values }) }
function asset(name = '我自己的 LUT', id = 'a'): AssetColorLutSource { return { kind: 'asset', lutAssetId: id.repeat(43), digest: id.repeat(64), name, domainMin: [0, 0, 0], domainMax: [1, 1, 1] } }
function initial(): ColorLutSelection { return { ...buildColorLutSelection({ kind: 'builtin', presetId: 'xm-lut-soft-film-v1' }), strength: 37 } }
function props() {
  const callbacks = { onChange: vi.fn((_next: ColorLutSelection | undefined) => {}), onImport: vi.fn(async (_file: File, _signal: AbortSignal): Promise<AssetColorLutSource> => asset()), onReadingChange: vi.fn((_reading: boolean) => {}) }
  const value: LayerColorLutControlsProps = { value: initial(), disabled: false, revision: 0, scope: {}, ...callbacks }
  return Object.assign(value, callbacks)
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: Error) => void; const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail }); return { promise, resolve, reject } }
function harness(value: LayerColorLutControlsProps) {
  runtime.cursor = 0; runtime.slots = []; runtime.effects = []
  return { render(flushEffects = true) { runtime.cursor = 0; let tree = LayerColorLutControls(value); if (flushEffects) { runtime.effects.splice(0).forEach((effect) => effect()); runtime.cursor = 0; tree = LayerColorLutControls(value); runtime.effects.splice(0).forEach((effect) => effect()) } return tree }, close() { for (const slot of runtime.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup(): void }).cleanup() } }
}
function upload(tree: unknown, file = new File(['test'], 'my-look.cube')) { const currentTarget = { files: [file], value: file.name }; event(tree, 'input', '选择自定义 LUT 文件', currentTarget); expect(currentTarget.value).toBe('') }
async function settle() { for (let at = 0; at < 6; at++) await Promise.resolve() }
afterEach(() => vi.restoreAllMocks())

describe('actual layer LUT control callbacks', () => {
  it('changes original presets without reading a file and retains the current strength', () => {
    const value = props(), ui = harness(value)
    event(ui.render(), 'select', 'LUT 原创预设', { value: 'xm-lut-movie-tone-v1' })
    expect(value.onChange).toHaveBeenCalledExactlyOnceWith({ version: 1, enabled: true, strength: 37, source: { kind: 'builtin', presetId: 'xm-lut-movie-tone-v1' } })
    expect(value.onImport).not.toHaveBeenCalled(); expect(value.onReadingChange).not.toHaveBeenCalled(); ui.close()
  })
  it('changes enable and strength while preserving the exact custom source, then clears only the LUT', () => {
    const value = props(); value.value = buildColorLutSelection(asset()); const ui = harness(value)
    event(ui.render(), 'input', '启用 LUT', { checked: false })
    expect(value.onChange.mock.lastCall?.[0]).toEqual({ ...value.value, enabled: false })
    event(ui.render(), 'input', 'LUT 强度滑杆', { valueAsNumber: 22 })
    expect(value.onChange.mock.lastCall?.[0]).toEqual({ ...value.value, strength: 22 })
    event(ui.render(), 'input', 'LUT 强度', { valueAsNumber: 130 })
    expect(value.onChange.mock.lastCall?.[0]?.strength).toBe(100)
    event(ui.render(), 'input', 'LUT 强度', { valueAsNumber: -10 })
    expect(value.onChange.mock.lastCall?.[0]?.strength).toBe(0)
    const calls = value.onChange.mock.calls.length
    event(ui.render(), 'input', 'LUT 强度', { valueAsNumber: NaN })
    expect(value.onChange).toHaveBeenCalledTimes(calls)
    click(ui.render(), '清除 LUT'); expect(value.onChange.mock.lastCall?.[0]).toBeUndefined(); ui.close()
  })
  it('loads a validated account asset once, preserving strength and reporting the full busy lifecycle', async () => {
    const value = props(), pending = deferred<AssetColorLutSource>(); value.onImport.mockImplementation(() => pending.promise); const ui = harness(value)
    const file = new File(['test'], 'Own-look.CUBE'); upload(ui.render(), file)
    const tree = ui.render(), signal = value.onImport.mock.calls[0][1]
    expect(value.onImport).toHaveBeenCalledExactlyOnceWith(file, signal)
    expect(signal.aborted).toBe(false); expect(value.onReadingChange.mock.calls).toEqual([[true]])
    expect(textOf(tree)).toContain('正在读取 LUT')
    for (const [type, label] of [['select', 'LUT 原创预设'], ['input', '启用 LUT'], ['input', 'LUT 强度'], ['input', '选择自定义 LUT 文件'], ['button', '清除 LUT'], ['button', '导入 .cube']]) expect(control(tree, type, label).props.disabled).toBe(true)
    pending.resolve(asset()); await settle()
    expect(value.onChange).toHaveBeenCalledExactlyOnceWith({ version: 1, enabled: true, strength: 37, source: asset() })
    expect(value.onReadingChange.mock.calls).toEqual([[true], [false]])
    expect(textOf(ui.render())).toContain('完成调整后应用到图层'); ui.close()
    expect(value.onReadingChange.mock.calls).toEqual([[true], [false]])
  })
  it('creates a first custom LUT at full strength instead of needing an existing setting', async () => {
    const value = props(); value.value = undefined; const ui = harness(value)
    upload(ui.render()); await settle()
    expect(value.onChange).toHaveBeenCalledExactlyOnceWith({ version: 1, enabled: true, strength: 100, source: asset() }); ui.close()
  })
  it('cancels a pending import without changing the original setting or accepting a late success', async () => {
    const value = props(), before = structuredClone(value.value), pending = deferred<AssetColorLutSource>(); value.onImport.mockImplementation(() => pending.promise); const ui = harness(value)
    upload(ui.render()); click(ui.render(), '取消读取 LUT')
    expect(value.onImport.mock.calls[0][1].aborted).toBe(true)
    pending.resolve(asset()); await settle()
    expect(value.value).toEqual(before); expect(value.onChange).not.toHaveBeenCalled(); expect(value.onReadingChange.mock.calls).toEqual([[true], [false]])
    expect(textOf(ui.render())).toContain('原 LUT 配置保留'); ui.close()
  })
  it.each(['scope', 'revision', 'value', 'disabled', 'unmount'] as const)('aborts a read after %s changes and rejects its late success', async (condition) => {
    const value = props(), pending = deferred<AssetColorLutSource>(); value.onImport.mockImplementation(() => pending.promise); const ui = harness(value)
    upload(ui.render()); const signal = value.onImport.mock.calls[0][1]
    if (condition === 'scope') value.scope = {}; else if (condition === 'revision') value.revision++; else if (condition === 'value') value.value = { ...initial(), strength: 80 }; else if (condition === 'disabled') value.disabled = true
    if (condition === 'unmount') ui.close(); else ui.render()
    expect(signal.aborted).toBe(true)
    pending.resolve(asset()); await settle(); expect(value.onChange).not.toHaveBeenCalled()
    expect(value.onReadingChange.mock.calls).toEqual([[true], [false]])
    if (condition !== 'unmount') ui.close()
  })
  it.each(['scope', 'revision', 'value', 'disabled'] as const)('guards a late resolution against a rendered %s change before effect cleanup runs', async (condition) => {
    const value = props(), pending = deferred<AssetColorLutSource>(); value.onImport.mockImplementation(() => pending.promise); const ui = harness(value)
    upload(ui.render())
    if (condition === 'scope') value.scope = {}; else if (condition === 'revision') value.revision++; else if (condition === 'value') value.value = undefined; else value.disabled = true
    ui.render(false); pending.resolve(asset()); await settle()
    expect(value.onChange).not.toHaveBeenCalled(); expect(value.onReadingChange.mock.calls).toEqual([[true], [false]])
    expect(value.onImport.mock.calls[0][1].aborted).toBe(true)
    ui.render(); ui.close()
  })
  it('keeps a semantically unchanged cloned selection from cancelling a valid import', async () => {
    const value = props(), pending = deferred<AssetColorLutSource>(); value.onImport.mockImplementation(() => pending.promise); const ui = harness(value)
    upload(ui.render()); value.value = structuredClone(value.value); ui.render()
    expect(value.onImport.mock.calls[0][1].aborted).toBe(false)
    pending.resolve(asset()); await settle(); expect(value.onChange).toHaveBeenCalledOnce(); ui.close()
  })
  it('supersedes an earlier file without letting its late finally mark a newer read idle', async () => {
    const value = props(), old = deferred<AssetColorLutSource>(), next = deferred<AssetColorLutSource>(); value.onImport.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise); const ui = harness(value)
    upload(ui.render(), new File(['old'], 'old.cube')); upload(ui.render(), new File(['new'], 'new.cube'))
    expect(value.onImport.mock.calls[0][1].aborted).toBe(true)
    expect(value.onReadingChange.mock.calls).toEqual([[true], [false], [true]])
    old.resolve(asset('旧文件', 'b')); await settle()
    expect(value.onChange).not.toHaveBeenCalled(); expect(value.onReadingChange.mock.calls).toEqual([[true], [false], [true]])
    expect(textOf(ui.render())).toContain('正在读取 LUT')
    next.resolve(asset('新文件', 'c')); await settle()
    expect(value.onChange).toHaveBeenCalledExactlyOnceWith({ ...initial(), enabled: true, source: asset('新文件', 'c') })
    expect(value.onReadingChange.mock.calls).toEqual([[true], [false], [true], [false]]); ui.close()
  })
  it('does not accept old enable, preset, strength, clear or file callbacks in a new scope', async () => {
    const value = props(), ui = harness(value), old = ui.render()
    value.scope = {}; ui.render()
    event(old, 'input', '启用 LUT', { checked: false }); event(old, 'select', 'LUT 原创预设', { value: 'xm-lut-cool-tone-v1' }); event(old, 'input', 'LUT 强度', { valueAsNumber: 80 }); click(old, '清除 LUT'); upload(old)
    await settle(); expect(value.onChange).not.toHaveBeenCalled(); expect(value.onImport).not.toHaveBeenCalled(); ui.close()
  })
  it('does not apply retained edit callbacks during reading even when a disabled DOM control is invoked', () => {
    const value = props(), pending = deferred<AssetColorLutSource>(); value.onImport.mockImplementation(() => pending.promise); const ui = harness(value), old = ui.render()
    upload(old); event(old, 'input', '启用 LUT', { checked: false }); event(old, 'input', 'LUT 强度', { valueAsNumber: 80 }); event(old, 'select', 'LUT 原创预设', { value: 'xm-lut-cool-tone-v1' }); click(old, '清除 LUT')
    expect(value.onChange).not.toHaveBeenCalled(); ui.close()
  })
  it('retains the prior setting and presents a local import failure without stale error leakage', async () => {
    const value = props(), pending = deferred<AssetColorLutSource>(); value.onImport.mockImplementation(() => pending.promise); const ui = harness(value)
    upload(ui.render()); pending.reject(new Error('LUT 数据包含无效数值，当前调整保留')); await settle()
    expect(value.onChange).not.toHaveBeenCalled(); expect(textOf(ui.render())).toContain('LUT 数据包含无效数值')
    expect(value.onReadingChange.mock.calls).toEqual([[true], [false]])
    event(ui.render(), 'select', 'LUT 原创预设', { value: 'xm-lut-cool-tone-v1' }); expect(textOf(ui.render())).not.toContain('无效数值'); ui.close()
  })
  it('does not show the error from a cancelled read after a newer file succeeds', async () => {
    const value = props(), old = deferred<AssetColorLutSource>(); value.onImport.mockImplementationOnce(() => old.promise); const ui = harness(value)
    upload(ui.render()); click(ui.render(), '取消读取 LUT'); upload(ui.render()); await settle(); old.reject(new Error('旧文件失败')); await settle()
    expect(value.onChange).toHaveBeenCalledOnce(); expect(textOf(ui.render())).not.toContain('旧文件失败'); ui.close()
  })
  it('does not let a retained old cancel button cancel a newer read', async () => {
    const value = props(), old = deferred<AssetColorLutSource>(), next = deferred<AssetColorLutSource>(); value.onImport.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise); const ui = harness(value)
    upload(ui.render()); const oldCancel = control(ui.render(), 'button', '取消读取 LUT').props.onClick as () => void
    upload(ui.render(), new File(['next'], 'next.cube')); oldCancel()
    expect(value.onImport.mock.calls[1][1].aborted).toBe(false); expect(textOf(ui.render())).toContain('正在读取 LUT')
    next.resolve(asset()); old.resolve(asset('旧的', 'b')); await settle(); expect(value.onChange).toHaveBeenCalledOnce(); ui.close()
  })
  it.each(['not-a-lut.json', 'look.cube.exe'])('rejects the wrong file type before invoking the parent reader: %s', async (name) => {
    const value = props(), ui = harness(value); upload(ui.render(), new File(['test'], name)); await settle()
    expect(value.onImport).not.toHaveBeenCalled(); expect(value.onChange).not.toHaveBeenCalled(); expect(textOf(ui.render())).toContain('请选择 .cube 格式')
    expect(value.onReadingChange.mock.calls).toEqual([[true], [false]]); ui.close()
  })
  it('rejects an oversized file before parent I/O and a malformed returned asset before applying it', async () => {
    const value = props(), ui = harness(value), file = new File(['test'], 'big.cube'); Object.defineProperty(file, 'size', { value: 24 * 1024 * 1024 + 1 })
    upload(ui.render(), file); await settle(); expect(value.onImport).not.toHaveBeenCalled(); expect(textOf(ui.render())).toContain('24 MiB')
    value.onImport.mockResolvedValue({ ...asset(), digest: 'invalid' }); upload(ui.render()); await settle()
    expect(value.onChange).not.toHaveBeenCalled(); expect(textOf(ui.render())).toContain('文件摘要无效'); ui.close()
  })
  it('reports a parent commit error while leaving the controlled value unchanged and idle', async () => {
    const value = props(), ui = harness(value); value.onChange.mockImplementation(() => { throw new Error('当前图层已锁定') })
    upload(ui.render()); await settle(); expect(textOf(ui.render())).toContain('当前图层已锁定'); expect(value.value).toEqual(initial())
    expect(value.onReadingChange.mock.calls).toEqual([[true], [false]]); ui.close()
  })
  it('rechecks scope when the parent reacts synchronously to the idle callback', async () => {
    const value = props(), ui = harness(value)
    value.onReadingChange.mockImplementation((reading) => { if (!reading) { value.scope = {}; ui.render() } })
    upload(ui.render()); await settle(); expect(value.onImport).toHaveBeenCalledOnce(); expect(value.onChange).not.toHaveBeenCalled(); ui.close()
  })
  it('does not start parent I/O after the busy callback synchronously revokes editing', async () => {
    const value = props(), ui = harness(value)
    value.onReadingChange.mockImplementation((reading) => { if (reading) { value.disabled = true; ui.render() } })
    upload(ui.render()); await settle(); expect(value.onImport).not.toHaveBeenCalled(); expect(value.onChange).not.toHaveBeenCalled()
    expect(value.onReadingChange.mock.calls).toEqual([[true], [false]]); ui.close()
  })
})
