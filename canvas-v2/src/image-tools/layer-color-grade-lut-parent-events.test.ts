import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ImageLayerColorGrade } from './layer-color-grade'
import type { ColorLutTable } from './layer-color-lut'
import type { LayerColorLutPreviewState } from './layer-color-lut-preview'
import type { CanvasHostBridge } from '../host'

const runtime = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], preview: { tables: new Map<string, ColorLutTable>(), busy: false, error: '', retry: vi.fn() } as LayerColorLutPreviewState, bridge: {} as Pick<CanvasHostBridge, 'importColorLutFile' | 'importColorLut' | 'readColorLut'>, preparedRecipes: [] as unknown[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef(initial: unknown) { const index = runtime.cursor++; runtime.slots[index] ??= { current: initial }; return runtime.slots[index] },
  useState(initial: unknown) { const index = runtime.cursor++; if (!(index in runtime.slots)) runtime.slots[index] = typeof initial === 'function' ? initial() : initial; return [runtime.slots[index], (next: unknown) => { runtime.slots[index] = typeof next === 'function' ? next(runtime.slots[index]) : next }] },
  useMemo(create: () => unknown, dependencies: readonly unknown[]) { const index = runtime.cursor++, previous = runtime.slots[index] as { dependencies: readonly unknown[]; value: unknown } | undefined; if (!previous || dependencies.length !== previous.dependencies.length || !dependencies.every((entry, at) => Object.is(entry, previous.dependencies[at]))) runtime.slots[index] = { dependencies, value: create() }; return (runtime.slots[index] as { value: unknown }).value },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) { const index = runtime.cursor++, previous = runtime.slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined; if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, at) => Object.is(value, previous.dependencies[at]))) return; runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } }) },
}))
vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), createPortal: (element: unknown) => element }))
vi.mock('../host', () => ({ hostBridge: () => runtime.bridge }))
vi.mock('./layer-color-lut-preview', () => ({ useLayerColorLutPreview: (recipe: unknown) => { runtime.preparedRecipes.push(recipe); return runtime.preview } }))
vi.mock('./layer-color-grade-raster', async (original) => { const real = await original<typeof import('./layer-color-grade-raster')>(); return { ...real, rasterizeLayerColorGrade: vi.fn(real.rasterizeLayerColorGrade) } })
import { LayerColorGradeEditor } from './LayerColorGradeEditor'
import { LayerColorLutControls } from './LayerColorLutControls'
import { LayerColorDetailControls } from './LayerColorDetailControls'
import { LayerColorPresenceControls } from './LayerColorPresenceControls'
import { LayerColorCalibrationControls } from './LayerColorCalibrationControls'
import { defaultImageLayerColorCalibration } from './layer-color-calibration'
import { defaultImageLayerColorDetail } from './layer-color-detail'
import { buildColorGradeHistogram } from './layer-color-grade-editor-state'
import { LayerRecipePreview } from './layerpreview'
import { rasterizeLayerColorGrade } from './layer-color-grade-raster'
import { defaultImageLayerColorGrade } from './layer-color-grade'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from './recipe'
import { createLayerColorLutPreset } from './layer-color-lut-presets'
import { colorLutSourceKey, type AssetColorLutSource } from './layer-color-lut-selection'
import { serializeColorLutResource, describeColorLutResource, type ColorLutResourceDescriptor } from '../lib/color-lut-resource-contract'
import { buildColorGradePresetTransfer } from '../lib/color-grade-preset-transfer'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type: unknown): ElementShape[] { if (Array.isArray(value)) return value.flatMap((item) => elements(item, type)); if (!value || typeof value !== 'object' || !('props' in value)) return []; const element = value as ElementShape; return [...(type === undefined || element.type === type ? [element] : []), ...elements(element.props.children, type)] }
function textOf(value: unknown): string { if (typeof value === 'string' || typeof value === 'number') return String(value); if (Array.isArray(value)) return value.map(textOf).join(''); return value && typeof value === 'object' && 'props' in value ? textOf((value as ElementShape).props.children) : '' }
function control(tree: unknown, type: string, label: string): ElementShape { const found = elements(tree, type).find((element) => element.props['aria-label'] === label || textOf(element.props.children) === label); expect(found, label).toBeDefined(); return found! }
function click(tree: unknown, label: string) { const button = control(tree, 'button', label); expect(button.props.disabled).not.toBe(true); (button.props.onClick as () => void)() }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept }); return { promise, resolve } }
async function settle() { for (let at = 0; at < 10; at++) await Promise.resolve() }
let table: ColorLutTable, descriptor: ColorLutResourceDescriptor, source: AssetColorLutSource, transfer: string
function customGrade(): ImageLayerColorGrade { return { ...defaultImageLayerColorGrade(), exposure: .5, lut: { version: 1, enabled: true, strength: 63, source: structuredClone(source) } } }
function props(grade = customGrade()) { const recipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe; recipe.layers = [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, colorGrade: grade }]; return { recipe, layerIndex: 0, images: [], onApply: vi.fn((_grade: ImageLayerColorGrade) => {}), onClose: vi.fn() } }
function detail(tree: unknown) { const found = elements(tree, LayerColorDetailControls)[0]; expect(found).toBeDefined(); return found.props as unknown as Parameters<typeof LayerColorDetailControls>[0] }
function presence(tree: unknown) { const found = elements(tree, LayerColorPresenceControls)[0]; expect(found).toBeDefined(); return found.props as unknown as Parameters<typeof LayerColorPresenceControls>[0] }
function calibration(tree: unknown) { const found = elements(tree, LayerColorCalibrationControls)[0]; expect(found).toBeDefined(); return found.props as unknown as Parameters<typeof LayerColorCalibrationControls>[0] }
function histogram(tree: unknown) { const found = elements(tree, undefined).find((element) => typeof element.type === 'function' && element.type.name === 'Histogram'); expect(found).toBeDefined(); return found!.props }
function preview(tree: unknown) { return elements(tree, LayerRecipePreview)[0].props }
function lut(tree: unknown) { const found = elements(tree, LayerColorLutControls)[0]; expect(found).toBeDefined(); return found.props as unknown as Parameters<typeof LayerColorLutControls>[0] }
function harness(value: Parameters<typeof LayerColorGradeEditor>[0]) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); vi.stubGlobal('document', { activeElement: null, body: {}, createElement: vi.fn() }); vi.stubGlobal('HTMLElement', class {})
  runtime.cursor = 0; runtime.slots = []; runtime.effects = []; runtime.preparedRecipes = []
  runtime.preview = { tables: new Map([[colorLutSourceKey(source), table]]), busy: false, error: '', retry: vi.fn() }; runtime.bridge = {}
  return { render() { runtime.cursor = 0; LayerColorGradeEditor(value); runtime.effects.splice(0).forEach((effect) => effect()); runtime.cursor = 0; const tree = LayerColorGradeEditor(value); runtime.effects.splice(0).forEach((effect) => effect()); return tree }, close() { for (const slot of runtime.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup(): void }).cleanup() } }
}
function uploadJson(tree: unknown, text: string | Promise<string>) { const target = { files: [{ name: 'owned.json', size: 100, text: async () => text }], value: 'owned.json' }; (control(tree, 'input', '载入图像调整 JSON 预设').props.onChange as (event: unknown) => void)({ currentTarget: target }); expect(target.value).toBe('') }
beforeAll(async () => {
  table = { ...createLayerColorLutPreset('xm-lut-soft-forest-v1'), name: '自有森系 LUT' }
  descriptor = { ...await describeColorLutResource(serializeColorLutResource(table)), assetId: 'a'.repeat(43) }
  source = { kind: 'asset', lutAssetId: descriptor.assetId, digest: descriptor.digest, name: descriptor.name, domainMin: [...descriptor.domainMin], domainMax: [...descriptor.domainMax] }
  transfer = await buildColorGradePresetTransfer('完整森系', customGrade(), async () => ({ descriptor, table }))
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('actual LUT parent editor integration', () => {
  it('keeps calibration edits and temporary section bypass in the draft while committing once and cancelling without application', async () => {
    const settings = { ...defaultImageLayerColorCalibration(), shadowTint: 25, redHue: 40, redSaturation: -30, greenHue: -35, greenSaturation: 20, blueHue: 30, blueSaturation: -25 }, value = props(defaultImageLayerColorGrade()), ui = harness(value)
    expect(calibration(ui.render()).value).toBeUndefined()
    calibration(ui.render()).onChange(settings); ui.render(); await vi.advanceTimersByTimeAsync(125); let tree = ui.render()
    expect((preview(tree).recipe as ImageLayerRecipe).layers[0].colorGrade?.calibration).toEqual(settings); expect(value.onApply).not.toHaveBeenCalled()
    click(tree, '临时隐藏校准效果'); tree = ui.render()
    expect((preview(tree).recipe as ImageLayerRecipe).layers[0].colorGrade?.calibration).toBeUndefined(); expect(calibration(tree).value).toEqual(settings)
    click(tree, '未调色'); tree = ui.render(); expect((preview(tree).recipe as ImageLayerRecipe).layers[0].colorGrade?.calibration).toBeUndefined()
    click(tree, '完成调整'); expect(value.onApply).toHaveBeenCalledExactlyOnceWith({ ...defaultImageLayerColorGrade(), calibration: settings }); ui.close()
    const canceled = props(defaultImageLayerColorGrade()), canceledUi = harness(canceled)
    calibration(canceledUi.render()).onChange(settings); click(canceledUi.render(), '取消图像调整')
    expect(canceled.onApply).not.toHaveBeenCalled(); expect(canceled.onClose).toHaveBeenCalledOnce(); canceledUi.close()
  })
  it('resets only calibration while preserving other settings and blocks retained calibration callbacks after closure', async () => {
    const grade = customGrade(); grade.calibration = { ...defaultImageLayerColorCalibration(), enabled: false, shadowTint: 25, redHue: 40 }; grade.presence = { version: 1, enabled: true, texture: 60, clarity: 40, dehaze: 30 }; grade.detail = defaultImageLayerColorDetail()
    const value = props(grade), ui = harness(value), retained = calibration(ui.render()).onChange
    click(ui.render(), '复位校准'); let tree = ui.render()
    expect(calibration(tree).value).toBeUndefined(); expect(presence(tree).value).toEqual(grade.presence); expect(detail(tree).value).toEqual(grade.detail); expect(lut(tree).value).toEqual(grade.lut)
    calibration(tree).onChange(defaultImageLayerColorCalibration()); click(ui.render(), '全部复位'); tree = ui.render()
    expect(calibration(tree).value).toBeUndefined(); expect(presence(tree).value).toBeUndefined(); expect(lut(tree).value).toBeUndefined(); expect(value.onApply).not.toHaveBeenCalled()
    click(tree, '取消图像调整'); retained(grade.calibration); await vi.advanceTimersByTimeAsync(125)
    expect(calibration(ui.render()).value).toBeUndefined(); expect(value.onApply).not.toHaveBeenCalled(); ui.close()
  })
  it('keeps presence edits and temporary effect hiding in the draft while completion commits once and cancel commits nothing', () => {
    const value = props(defaultImageLayerColorGrade()), ui = harness(value), settings = { version: 1 as const, enabled: false, texture: 60, clarity: -40, dehaze: 30 }
    expect(presence(ui.render()).value).toBeUndefined()
    presence(ui.render()).onChange(settings); let tree = ui.render()
    expect(presence(tree).value).toEqual(settings); expect(value.onApply).not.toHaveBeenCalled()
    click(tree, '临时隐藏效果'); tree = ui.render()
    expect((preview(tree).recipe as ImageLayerRecipe).layers[0].colorGrade?.presence).toBeUndefined(); expect(presence(tree).value).toEqual(settings)
    click(tree, '未调色'); click(ui.render(), '完成调整')
    expect(value.onApply).toHaveBeenCalledExactlyOnceWith({ ...defaultImageLayerColorGrade(), presence: settings }); ui.close()
    const canceled = props(defaultImageLayerColorGrade()), cancelUi = harness(canceled)
    presence(cancelUi.render()).onChange(settings); click(cancelUi.render(), '取消图像调整')
    expect(canceled.onApply).not.toHaveBeenCalled(); expect(canceled.onClose).toHaveBeenCalledOnce(); cancelUi.close()
  })
  it('resets the effect section including presence without resetting detail or LUT and blocks late callbacks after closure', async () => {
    const grade = customGrade(); grade.presence = { version: 1, enabled: true, texture: 60, clarity: 40, dehaze: 30 }; grade.detail = defaultImageLayerColorDetail(); grade.grain = 20
    const value = props(grade), ui = harness(value), retained = presence(ui.render()).onChange
    click(ui.render(), '复位效果'); let tree = ui.render()
    expect(presence(tree).value).toBeUndefined(); expect(detail(tree).value).toEqual(grade.detail); expect(lut(tree).value).toEqual(grade.lut)
    await vi.advanceTimersByTimeAsync(120); tree = ui.render()
    expect((preview(tree).recipe as ImageLayerRecipe).layers[0].colorGrade?.grain).toBe(0); expect(value.onApply).not.toHaveBeenCalled()
    click(tree, '取消图像调整'); retained({ version: 1, enabled: true, texture: -60, clarity: -40, dehaze: -30 })
    tree = ui.render(); expect(presence(tree).value).toBeUndefined(); expect(value.onApply).not.toHaveBeenCalled(); ui.close()
  })
  it('passes one prepared state to the sole visible preview and keeps a stable scope across equivalent renders', () => {
    const value = props(), ui = harness(value), tree = ui.render(), first = lut(tree)
    expect(elements(tree, LayerRecipePreview)).toHaveLength(1)
    for (const preview of elements(tree, LayerRecipePreview)) expect(preview.props.lutState).toBe(runtime.preview)
    expect(lut(ui.render()).scope).toBe(first.scope)
    expect(lut(ui.render()).revision).toBe(first.revision)
    ui.close()
  })
  it('isolates the complete nonzero selected layer from document crop, rotation and overlapping other layers', async () => {
    const value = props(), selected = { ...value.recipe.layers[0], sourceIndex: 1, x: -2, y: -3, width: 16, height: 480 / 28, rotation: 30, flipX: true, opacity: .5, adjustments: { brightness: 12, contrast: 4, saturation: 7, blur: 0, grayscale: 0 } }
    value.recipe = { ...value.recipe, outputWidth: 40, outputHeight: 28, documentFrame: { version: 1, width: 640, height: 480, offsetX: 200, offsetY: 140 }, background: '#ff0000', layers: [{ ...value.recipe.layers[0], sourceIndex: 0 }, selected, { ...value.recipe.layers[0], sourceIndex: 2, opacity: 1 }] }; value.layerIndex = 1
    const before = structuredClone(value.recipe), ui = harness(value), tree = ui.render(), local = preview(tree).recipe as ImageLayerRecipe
    expect(local.layers).toHaveLength(1); expect(local).not.toHaveProperty('documentFrame')
    expect(local).toMatchObject({ outputWidth: 640, outputHeight: 480, background: 'transparent', layers: [{ sourceIndex: 1, x: 0, y: 0, width: 1, height: 1, rotation: 0, flipX: false, opacity: 1, adjustments: selected.adjustments, colorGrade: customGrade() }] })
    expect(runtime.preparedRecipes.at(-1)).toEqual(local)
    const sampler = preview(tree).samplerRef as { current: unknown }, samplePixels = vi.fn(async () => ({ width: 640, height: 480, data: new Uint8ClampedArray(640 * 480 * 4) }))
    sampler.current = { samplePixels }; await vi.advanceTimersByTimeAsync(250); await settle()
    expect(samplePixels).toHaveBeenCalledExactlyOnceWith({ source: 'current', layerIndex: 0 }, expect.any(AbortSignal))
    click(ui.render(), '完成调整'); expect(value.onApply).toHaveBeenCalledExactlyOnceWith(customGrade()); expect(value.recipe).toEqual(before); ui.close()
  })
  it('blocks completion, resets and file operations while the child reads without disabling the child itself', () => {
    const value = props(), ui = harness(value), oldApply = control(ui.render(), 'button', '完成调整').props.onClick as () => void
    lut(ui.render()).onReadingChange?.(true); const tree = ui.render()
    expect(lut(tree).disabled).toBe(false)
    for (const label of ['完成调整', '全部复位', '保存到本机', '载入预设', '导入 XMP', '导出 XMP']) expect(control(tree, 'button', label).props.disabled).toBe(true)
    oldApply(); expect(value.onApply).not.toHaveBeenCalled()
    lut(tree).onReadingChange?.(false); click(ui.render(), '完成调整'); expect(value.onApply).toHaveBeenCalledExactlyOnceWith(customGrade()); ui.close()
  })
  it('rejects a retained completion while LUT is busy or failed and exposes the actual retry action', () => {
    const value = props(), ui = harness(value), oldApply = control(ui.render(), 'button', '完成调整').props.onClick as () => void
    runtime.preview.busy = true; const busy = ui.render(); expect(control(busy, 'button', '完成调整').props.disabled).toBe(true); oldApply(); expect(value.onApply).not.toHaveBeenCalled()
    runtime.preview.busy = false; runtime.preview.error = '当前账号没有此 LUT'; const failed = ui.render(); expect(textOf(failed)).toContain('当前账号没有此 LUT'); oldApply(); expect(value.onApply).not.toHaveBeenCalled()
    click(failed, '重新读取 LUT'); expect(runtime.preview.retry).toHaveBeenCalledOnce(); ui.close()
  })
  it('requires the current exact table even through an old completion callback and commits only once when ready', () => {
    const value = props(), ui = harness(value), apply = control(ui.render(), 'button', '完成调整').props.onClick as () => void
    runtime.preview.tables = new Map(); ui.render(); apply(); expect(value.onApply).not.toHaveBeenCalled(); expect(textOf(ui.render())).toContain('资源尚未准备完成')
    runtime.preview.tables = new Map([[colorLutSourceKey(source), table]]); ui.render(); apply(); apply(); expect(value.onApply).toHaveBeenCalledOnce(); expect(value.onClose).toHaveBeenCalledOnce(); ui.close()
  })
  it('keeps preparing the real draft while comparison or temporary LUT hiding changes only the preview', () => {
    const value = props(), ui = harness(value)
    click(ui.render(), '未调色'); let tree = ui.render()
    expect((elements(tree, LayerRecipePreview)[0].props.recipe as ImageLayerRecipe).layers[0].colorGrade?.lut).toBeUndefined()
    expect((runtime.preparedRecipes.at(-1) as ImageLayerRecipe).layers[0].colorGrade?.lut).toEqual(customGrade().lut)
    click(tree, '调整效果'); click(ui.render(), '临时隐藏LUT 调色效果'); tree = ui.render()
    expect((elements(tree, LayerRecipePreview)[0].props.recipe as ImageLayerRecipe).layers[0].colorGrade?.lut).toBeUndefined()
    click(tree, '完成调整'); expect(value.onApply).toHaveBeenCalledExactlyOnceWith(customGrade()); ui.close()
  })
  it('samples native completed grade pixels through the visible preview without grading the reduced bitmap again', async () => {
    const grade = customGrade(); grade.detail = { ...defaultImageLayerColorDetail(), sharpening: { amount: 80, radius: 1.5, detail: 40, masking: 35 } }; grade.presence = { version: 1, enabled: true, texture: 60, clarity: 40, dehaze: 30 }
    const value = props(grade), ui = harness(value), tree = ui.render(), data = new Uint8ClampedArray(512 * 512 * 4)
    for (let at = 0; at < data.length; at += 4) data.set([80, 120, 160, 255], at)
    const sampler = preview(tree).samplerRef as { current: unknown }, samplePixels = vi.fn(async () => ({ width: 512, height: 512, data }))
    sampler.current = { samplePixels }
    await vi.advanceTimersByTimeAsync(250); await settle()
    expect(samplePixels).toHaveBeenCalledExactlyOnceWith({ source: 'current', layerIndex: 0 }, expect.any(AbortSignal))
    expect(rasterizeLayerColorGrade).not.toHaveBeenCalled()
    const result = histogram(ui.render()).histogram as ReturnType<typeof buildColorGradeHistogram>
    expect(result.pixels).toBe(256 * 256)
    expect(result.red[Math.floor(80 / 4)]).toBe(256 * 256)
    expect(result.green[Math.floor(120 / 4)]).toBe(256 * 256)
    expect(result.blue[Math.floor(160 / 4)]).toBe(256 * 256)
    expect(elements(ui.render(), LayerRecipePreview)).toHaveLength(1); ui.close()
  })
  it('keeps detail changes in the draft, comparison and temporary hiding out of the committed value, and cancellation out of history', () => {
    const value = props(defaultImageLayerColorGrade()), ui = harness(value), settings = { ...defaultImageLayerColorDetail(), enabled: false, sharpening: { amount: 0, radius: 2, detail: 67, masking: 34 } }
    expect(detail(ui.render()).value).toBeUndefined()
    detail(ui.render()).onChange(settings); let tree = ui.render()
    expect(detail(tree).value).toEqual(settings); expect(value.onApply).not.toHaveBeenCalled()
    click(tree, '临时隐藏细节与降噪效果'); tree = ui.render()
    expect((preview(tree).recipe as ImageLayerRecipe).layers[0].colorGrade?.detail).toBeUndefined()
    expect(detail(tree).value).toEqual(settings)
    click(tree, '未调色'); tree = ui.render(); expect((preview(tree).recipe as ImageLayerRecipe).layers[0].colorGrade?.detail).toBeUndefined()
    click(tree, '完成调整'); expect(value.onApply).toHaveBeenCalledExactlyOnceWith({ ...defaultImageLayerColorGrade(), detail: settings }); ui.close()
    const canceled = props(defaultImageLayerColorGrade()), cancelUi = harness(canceled)
    detail(cancelUi.render()).onChange(settings); click(cancelUi.render(), '取消图像调整')
    expect(canceled.onApply).not.toHaveBeenCalled(); expect(canceled.onClose).toHaveBeenCalledOnce(); cancelUi.close()
  })
  it('resets only detail, supports all reset, and leaves both resets as draft changes until completion', () => {
    const grade = customGrade(); grade.detail = { ...defaultImageLayerColorDetail(), luminance: { amount: 70, detail: 45, contrast: 20 } }
    const value = props(grade), ui = harness(value)
    click(ui.render(), '复位细节与降噪'); let tree = ui.render()
    expect(detail(tree).value).toBeUndefined(); expect(lut(tree).value).toEqual(grade.lut)
    expect((runtime.preparedRecipes.at(-1) as ImageLayerRecipe).layers[0].colorGrade?.exposure).toBe(.5)
    detail(tree).onChange(grade.detail); click(ui.render(), '全部复位'); tree = ui.render()
    expect(detail(tree).value).toBeUndefined(); expect(lut(tree).value).toBeUndefined(); expect(value.onApply).not.toHaveBeenCalled()
    click(tree, '完成调整'); expect(value.onApply).toHaveBeenCalledExactlyOnceWith(defaultImageLayerColorGrade()); ui.close()
  })
  it('aborts old native sampling on a detail edit and never publishes the late result over the latest draft', async () => {
    const value = props(defaultImageLayerColorGrade()), ui = harness(value), pending = deferred<{ width: number; height: number; data: Uint8ClampedArray }>(), samplePixels = vi.fn(async (_input: unknown, _signal: AbortSignal) => pending.promise)
    const sampler = preview(ui.render()).samplerRef as { current: unknown }; sampler.current = { samplePixels }
    await vi.advanceTimersByTimeAsync(250); expect(samplePixels).toHaveBeenCalledOnce()
    const oldSignal = samplePixels.mock.calls[0][1]
    detail(ui.render()).onChange({ ...defaultImageLayerColorDetail(), color: { amount: 60, detail: 55, smoothness: 65 } })
    expect(oldSignal.aborted).toBe(true); ui.render()
    pending.resolve({ width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) }); await settle()
    expect(histogram(ui.render()).histogram).toBeNull()
    await vi.advanceTimersByTimeAsync(120); ui.render()
    const fresh = new Uint8ClampedArray([200, 180, 160, 255]); sampler.current = { samplePixels: vi.fn(async () => ({ width: 1, height: 1, data: fresh })) }
    await vi.advanceTimersByTimeAsync(250); await settle()
    expect(histogram(ui.render()).histogram).toEqual(buildColorGradeHistogram(fresh)); ui.close()
  })
  it.each(['scope', 'closed', 'unmounted', 'LUT loading'] as const)('invalidates native histogram sampling after %s', async (condition) => {
    const value = props(), ui = harness(value), pending = deferred<{ width: number; height: number; data: Uint8ClampedArray }>(), samplePixels = vi.fn(async (_input: unknown, _signal: AbortSignal) => pending.promise)
    const sampler = preview(ui.render()).samplerRef as { current: unknown }; sampler.current = { samplePixels }
    await vi.advanceTimersByTimeAsync(250)
    if (condition === 'scope') { value.layerIndex = 1; value.recipe.layers.push({ ...value.recipe.layers[0] }); ui.render() }
    else if (condition === 'closed') click(ui.render(), '取消图像调整')
    else if (condition === 'unmounted') ui.close()
    else { runtime.preview.busy = true; ui.render() }
    expect(samplePixels.mock.calls[0][1].aborted).toBe(true)
    pending.resolve({ width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) }); await settle()
    if (condition !== 'unmounted') { expect(histogram(ui.render()).histogram).toBeNull(); ui.close() }
    expect(value.onApply).not.toHaveBeenCalled()
  })
  it('keeps the active native histogram request when the already selected comparison mode is clicked again', async () => {
    const value = props(), ui = harness(value), pending = deferred<{ width: number; height: number; data: Uint8ClampedArray }>(), samplePixels = vi.fn(async (_input: unknown, _signal: AbortSignal) => pending.promise)
    const sampler = preview(ui.render()).samplerRef as { current: unknown }; sampler.current = { samplePixels }
    await vi.advanceTimersByTimeAsync(250); click(ui.render(), '调整效果')
    expect(samplePixels.mock.calls[0][1].aborted).toBe(false)
    pending.resolve({ width: 1, height: 1, data: new Uint8ClampedArray([40, 80, 120, 255]) }); await settle()
    expect(histogram(ui.render())).toMatchObject({ busy: false, histogram: { pixels: 1 } }); ui.close()
  })
  it('clears a failed native histogram and retries through the current preview sampler', async () => {
    const value = props(), ui = harness(value), sampler = preview(ui.render()).samplerRef as { current: unknown }
    sampler.current = { samplePixels: vi.fn(async () => { throw new Error('原尺寸像素无法读取') }) }
    await vi.advanceTimersByTimeAsync(250); await settle(); let tree = ui.render()
    expect(histogram(tree)).toMatchObject({ histogram: null, busy: false, error: '原尺寸像素无法读取' })
    click(tree, '重新读取直方图'); tree = ui.render()
    sampler.current = { samplePixels: vi.fn(async () => ({ width: 1, height: 1, data: new Uint8ClampedArray([40, 80, 120, 255]) })) }
    await vi.advanceTimersByTimeAsync(250); await settle()
    expect(histogram(ui.render())).toMatchObject({ busy: false, error: '', histogram: { pixels: 1 } }); ui.close()
  })
  it('updates the shown source immediately and leaves all changes in the draft until completion', () => {
    const value = props(), ui = harness(value), tree = ui.render(), next = { version: 1 as const, enabled: true, strength: 48, source: { kind: 'builtin' as const, presetId: 'xm-lut-movie-tone-v1' } }
    lut(tree).onChange(next); const changed = ui.render()
    expect((elements(changed, LayerRecipePreview)[0].props.recipe as ImageLayerRecipe).layers[0].colorGrade?.lut).toEqual(next)
    expect(value.onApply).not.toHaveBeenCalled(); expect(lut(changed).revision).toBe(1)
    click(changed, '完成调整'); expect(value.onApply).toHaveBeenCalledExactlyOnceWith({ ...customGrade(), lut: next }); ui.close()
  })
  it('resets just the LUT section while retaining exposure and waiting for the final single commit', () => {
    const value = props(), ui = harness(value)
    click(ui.render(), '复位LUT 调色'); const tree = ui.render()
    expect(lut(tree).value).toBeUndefined(); expect(value.onApply).not.toHaveBeenCalled()
    click(tree, '完成调整'); expect(value.onApply).toHaveBeenCalledExactlyOnceWith({ ...defaultImageLayerColorGrade(), exposure: .5 }); ui.close()
  })
  it('uses the real host callback for custom file imports and rejects it after the source session changes', async () => {
    const value = props(), ui = harness(value), reader = vi.fn(async () => source); runtime.bridge.importColorLutFile = reader
    const child = lut(ui.render()), file = new File(['own'], 'own.cube'), controller = new AbortController()
    expect(await child.onImport(file, controller.signal)).toEqual(source); expect(reader).toHaveBeenCalledExactlyOnceWith(file, controller.signal)
    value.layerIndex = 1; value.recipe.layers.push({ ...value.recipe.layers[0] }); ui.render()
    await expect(child.onImport(file, controller.signal)).rejects.toThrow('图层或素材已变化'); expect(reader).toHaveBeenCalledOnce(); ui.close()
  })
  it('imports a self-contained preset through the current-owner uploader before changing the draft', async () => {
    const value = props(), ui = harness(value), started = deferred<void>(), writer = vi.fn(async () => { started.resolve(); return { ...descriptor, assetId: 'z'.repeat(43) } }); runtime.bridge.importColorLut = writer
    uploadJson(ui.render(), transfer); await started.promise; await settle(); let tree = ui.render()
    expect(lut(tree).value?.source).toMatchObject({ kind: 'asset', lutAssetId: 'z'.repeat(43), digest: descriptor.digest })
    expect(value.onApply).not.toHaveBeenCalled()
    runtime.preview.tables = new Map([[`z${'z'.repeat(42)}:${descriptor.digest}`, table]]); tree = ui.render(); click(tree, '完成调整')
    expect(value.onApply).toHaveBeenCalledOnce(); expect(value.onApply.mock.calls[0][0].lut?.source).toMatchObject({ lutAssetId: 'z'.repeat(43) }); ui.close()
  })
  it('aborts a pending owner upload on cancel and drops its late result without replacing the current LUT', async () => {
    const value = props(), ui = harness(value), pending = deferred<ColorLutResourceDescriptor>(), started = deferred<void>(), writer = vi.fn(async (_table: ColorLutTable, _signal?: AbortSignal) => { started.resolve(); return pending.promise }); runtime.bridge.importColorLut = writer
    uploadJson(ui.render(), transfer); await started.promise; click(ui.render(), '取消读取')
    expect(writer.mock.calls[0][1]?.aborted).toBe(true)
    pending.resolve({ ...descriptor, assetId: 'z'.repeat(43) }); await settle()
    expect(lut(ui.render()).value).toEqual(customGrade().lut); expect(value.onApply).not.toHaveBeenCalled(); expect(control(ui.render(), 'button', '完成调整').props.disabled).toBe(false); ui.close()
  })
  it('does not start a host upload after a late file read from a closed editor', async () => {
    const value = props(), ui = harness(value), file = deferred<string>(), writer = vi.fn(); runtime.bridge.importColorLut = writer
    uploadJson(ui.render(), file.promise); click(ui.render(), '取消图像调整'); file.resolve(transfer); await settle()
    expect(writer).not.toHaveBeenCalled(); expect(value.onApply).not.toHaveBeenCalled(); expect(value.onClose).toHaveBeenCalledOnce(); ui.close()
  })
  it('downloads a verified self-contained JSON export without applying it to the layer', async () => {
    const value = props(), ui = harness(value), downloaded = deferred<void>(), clickDownload = vi.fn(() => downloaded.resolve()), anchor = { href: '', download: '', click: clickDownload }, objectUrl = vi.fn((_blob: Blob) => 'blob:owned-json')
    runtime.bridge.readColorLut = vi.fn(async () => ({ descriptor, table }))
    vi.stubGlobal('URL', { createObjectURL: objectUrl, revokeObjectURL: vi.fn() }); document.createElement = vi.fn(() => anchor) as unknown as typeof document.createElement
    click(ui.render(), '保存到本机'); await downloaded.promise; await settle()
    const exported = JSON.parse(await objectUrl.mock.calls[0][0].text())
    expect(exported).toMatchObject({ version: 2, settings: customGrade() }); expect(exported.resources).toHaveLength(1)
    expect(anchor.download).toBe('星芒-图像调整预设.json'); expect(value.onApply).not.toHaveBeenCalled(); ui.close()
  })
  it.each(['edited', 'source', 'closed', 'unmounted'] as const)('aborts an export resource read after %s and never downloads its late result', async (condition) => {
    const value = props(), ui = harness(value), pending = deferred<{ descriptor: ColorLutResourceDescriptor; table: ColorLutTable }>(), started = deferred<void>(), reader = vi.fn(async (_source: AssetColorLutSource, _signal?: AbortSignal) => { started.resolve(); return pending.promise }), createObjectURL = vi.fn()
    runtime.bridge.readColorLut = reader; vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    click(ui.render(), '保存到本机'); await started.promise
    if (condition === 'edited') {
      const field = elements(ui.render(), undefined).find((entry) => typeof entry.type === 'function' && entry.type.name === 'AdjustmentField' && entry.props.label === '曝光')
      expect(field).toBeDefined(); (field!.props.onChange as (value: number) => void)(1)
    } else if (condition === 'source') { value.layerIndex = 1; value.recipe.layers.push({ ...value.recipe.layers[0] }); ui.render() }
    else if (condition === 'closed') click(ui.render(), '取消图像调整')
    else ui.close()
    expect(reader.mock.calls[0][1]?.aborted).toBe(true)
    pending.resolve({ descriptor, table }); await settle(); expect(createObjectURL).not.toHaveBeenCalled(); expect(value.onApply).not.toHaveBeenCalled()
    if (condition !== 'unmounted') ui.close()
  })

  it('offers loading but no file exports when the host blocks page downloads', () => {
    const ui = harness({ ...props(), allowDownload: false }), labels = elements(ui.render(), 'button').map((element) => textOf(element.props.children))
    expect(labels).toContain('载入预设'); expect(labels).toContain('导入 XMP')
    expect(labels).not.toContain('保存到本机'); expect(labels).not.toContain('导出 XMP')
    ui.close()
  })
})
