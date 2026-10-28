import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasImageAssetSummary } from '../host'
import { defaultInteriorTask, buildInteriorTaskPrompt } from '../interior/interior-task'

const runtime = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef(initial: unknown) { const index = runtime.cursor++; runtime.slots[index] ??= { current: initial }; return runtime.slots[index] },
  useState(initial: unknown) { const index = runtime.cursor++; if (!(index in runtime.slots)) runtime.slots[index] = typeof initial === 'function' ? initial() : initial; return [runtime.slots[index], (value: unknown) => { runtime.slots[index] = typeof value === 'function' ? value(runtime.slots[index]) : value }] },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) { const index = runtime.cursor++, previous = runtime.slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined; if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return; runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } }) },
}))
vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), createPortal: (element: unknown) => element }))
import { InteriorTaskDialog, type InteriorTaskDialogProps } from './InteriorTaskDialog'
import { TemplateAssetPicker } from './TemplateAssetPicker'
import { chooseInteriorTaskAsset } from './interior-task-ui'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type: unknown): ElementShape[] { if (Array.isArray(value)) return value.flatMap((item) => elements(item, type)); if (!value || typeof value !== 'object' || !('props' in value)) return []; const element = value as ElementShape; return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)] }
function textOf(value: unknown): string { if (typeof value === 'string' || typeof value === 'number') return String(value); if (Array.isArray(value)) return value.map(textOf).join(''); return value && typeof value === 'object' && 'props' in value ? textOf((value as ElementShape).props.children) : '' }
function control(tree: unknown, type: string, label: string): ElementShape { const found = elements(tree, type).find((element) => element.props['aria-label'] === label || textOf(element.props.children) === label); expect(found, label).toBeDefined(); return found! }
function click(tree: unknown, label: string) { const button = control(tree, 'button', label); expect(button.props.disabled).not.toBe(true); (button.props.onClick as () => void)() }
function change(tree: unknown, type: string, label: string, value: string) { (control(tree, type, label).props.onChange as (event: unknown) => void)({ target: { value } }) }
function image(id = 'a'.repeat(43)): CanvasImageAssetSummary { return { assetId: id, mediaType: 'image', localUrl: `xingmang-asset://image/${id}`, thumbnailUrl: `xingmang-asset://thumb/v2/image/${id}`, mimeType: 'image/png', fileName: '室内.png', createdAt: '2026-10-16T00:00:00.000Z', width: 1024, height: 768 } }
function withoutSize(id = 'b'.repeat(43)): CanvasImageAssetSummary { const { width: _width, height: _height, ...asset } = image(id); return asset }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept }); return { promise, resolve } }
function props() { return { mode: 'create' as const, scopeKey: 'owner:project:1', isCurrent: (): boolean => true, initialTask: defaultInteriorTask(), initialSource: chooseInteriorTaskAsset(image()), initialPrompt: '保留原有壁炉', initialGeneration: { model: 'gpt-image-2', size: '1024x1024', imageResolution: '1K' as const, quality: 'low', imageCandidateCount: 2 as const }, assets: { items: [], total: 0, offset: 0, limit: 24, hasMore: false, facets: { tags: [] } }, imageModels: [{ id: 'gpt-image-2', label: 'GPT Image 2' }], onPickAsset: vi.fn(async (): Promise<CanvasImageAssetSummary | null> => image('b'.repeat(43))), onReadAsset: vi.fn(async (assetId: string, _signal?: AbortSignal) => image(assetId)), onApply: vi.fn(async (_draft: Parameters<InteriorTaskDialogProps['onApply']>[0]): Promise<void> => undefined), onClose: vi.fn() } satisfies InteriorTaskDialogProps }
function harness(value: InteriorTaskDialogProps) {
  vi.stubGlobal('document', { activeElement: null, body: {} }); vi.stubGlobal('HTMLElement', class {})
  runtime.cursor = 0; runtime.slots = []; runtime.effects = []
  return { render() { runtime.cursor = 0; InteriorTaskDialog(value); runtime.effects.splice(0).forEach((effect) => effect()); runtime.cursor = 0; const tree = InteriorTaskDialog(value); runtime.effects.splice(0).forEach((effect) => effect()); return tree }, close() { for (const slot of runtime.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup(): void }).cleanup() } }
}
function choose(tree: unknown, asset: CanvasImageAssetSummary): Promise<void> { return (elements(tree, TemplateAssetPicker)[0].props.onChoose as (asset: CanvasImageAssetSummary) => Promise<void>)(asset) }
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
afterEach(() => vi.unstubAllGlobals())

describe('interior task actual dialog callbacks', () => {
  it('previews complete instructions and submits current controls once without calling any model or asset mutation', async () => {
    const value = props(), pending = deferred<void>(); value.onApply.mockImplementation(() => pending.promise); const ui = harness(value)
    let tree = ui.render(); change(tree, 'select', '室内天气', 'rainy'); tree = ui.render(); change(tree, 'textarea', '室内渲染补充要求', '保留楼梯'); tree = ui.render()
    expect(textOf(tree)).toContain(buildInteriorTaskPrompt({ ...defaultInteriorTask(), weather: 'rainy' }, '保留楼梯'))
    const apply = control(tree, 'button', '创建室内任务').props.onClick as () => void; apply(); apply(); ui.render()
    expect(value.onApply).toHaveBeenCalledOnce(); expect(value.onApply.mock.calls[0][0]).toMatchObject({ mode: 'create', task: { weather: 'rainy' }, prompt: '保留楼梯', imageCandidateCount: 2, source: { binding: { kind: 'asset', assetId: image().assetId } } })
    expect(value.onPickAsset).not.toHaveBeenCalled(); expect(value.onReadAsset).not.toHaveBeenCalled(); expect(value.onClose).not.toHaveBeenCalled()
    pending.resolve(); await settle(); apply(); expect(value.onApply).toHaveBeenCalledOnce(); expect(value.onClose).toHaveBeenCalledOnce(); ui.close()
  })
  it('preserves a dirty draft while confirming close and discards only after an explicit choice', () => {
    const value = props(), ui = harness(value); let tree = ui.render(); change(tree, 'textarea', '室内渲染补充要求', '新的补充'); click(ui.render(), '取消'); tree = ui.render()
    expect(textOf(tree)).toContain('保留当前配置继续编辑'); expect(value.onClose).not.toHaveBeenCalled(); click(tree, '继续编辑'); tree = ui.render()
    expect(control(tree, 'textarea', '室内渲染补充要求').props.value).toBe('新的补充'); click(tree, '取消'); click(ui.render(), '放弃修改并关闭')
    expect(value.onClose).toHaveBeenCalledOnce(); expect(value.onApply).not.toHaveBeenCalled(); ui.close()
  })
  it('keeps all edit parameters, supplement and exact existing source slot until one explicit save', async () => {
    const value = { ...props(), mode: 'edit' as const, initialSource: { binding: { kind: 'existing' as const, edgeId: 'original-edge', outputIndex: 2 } }, initialTask: { ...defaultInteriorTask(), filter: 'film' as const, addDecor: true }, initialGeneration: { model: '', size: '1536x1024', quality: 'high', imageResolution: '2K' as const, imageCandidateCount: 4 as const } }, ui = harness(value)
    const tree = ui.render(); expect(textOf(tree)).toContain('原有结果保留'); expect(control(tree, 'select', '室内滤镜方向').props.value).toBe('film')
    click(tree, '保存室内配置'); await settle()
    expect(value.onApply).toHaveBeenCalledExactlyOnceWith({ mode: 'edit', task: value.initialTask, source: { binding: value.initialSource.binding }, prompt: value.initialPrompt, ...value.initialGeneration }); ui.close()
  })
  it('returns from the source picker without losing current task fields', () => {
    const value = props(), ui = harness(value); change(ui.render(), 'select', '室内外景', 'garden'); click(ui.render(), '从素材库选择'); let tree = ui.render()
    expect(elements(tree, TemplateAssetPicker)[0].props.searchLabel).toBe('搜索室内原图'); click(tree, '返回配置'); tree = ui.render()
    expect(control(tree, 'select', '室内外景').props.value).toBe('garden'); expect(value.onApply).not.toHaveBeenCalled(); ui.close()
  })
  it('hydrates only an explicitly chosen incomplete image and blocks duplicate selection until it is resolved', async () => {
    const value = props(), pending = deferred<CanvasImageAssetSummary>(); value.onReadAsset.mockImplementation(() => pending.promise); const ui = harness(value); click(ui.render(), '从素材库选择'); let tree = ui.render()
    const selection = choose(tree, withoutSize()); await expect(choose(tree, image())).rejects.toThrow('正在核对')
    expect(value.onReadAsset).toHaveBeenCalledExactlyOnceWith('b'.repeat(43), expect.any(AbortSignal)); pending.resolve(image('b'.repeat(43))); await selection; tree = ui.render()
    expect(elements(tree, TemplateAssetPicker)).toHaveLength(0); click(tree, '创建室内任务'); await settle()
    expect(value.onApply.mock.calls[0][0].source.binding).toEqual({ kind: 'asset', assetId: 'b'.repeat(43) }); ui.close()
  })
  it.each(['account', 'project', 'permission', 'unmount'] as const)('drops a late uploaded image after %s changes', async (kind) => {
    const value = props(), pending = deferred<CanvasImageAssetSummary | null>(); value.onPickAsset.mockImplementation(() => pending.promise); const ui = harness(value)
    click(ui.render(), '上传图片'); if (kind === 'account' || kind === 'project') value.scopeKey = kind; else if (kind === 'permission') value.isCurrent = () => false; else ui.close()
    pending.resolve(image('b'.repeat(43))); await settle()
    if (kind !== 'unmount') expect(ui.render()).toBeNull()
    expect(value.onApply).not.toHaveBeenCalled(); expect(value.onClose).not.toHaveBeenCalled(); expect(value.onReadAsset).not.toHaveBeenCalled(); ui.close()
  })
  it('does not let a cancelled old detail response clear or replace a newer source choice', async () => {
    const value = props(), old = deferred<CanvasImageAssetSummary>(), next = deferred<CanvasImageAssetSummary>(); value.onReadAsset.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise)
    const ui = harness(value); click(ui.render(), '从素材库选择'); let tree = ui.render(); const first = choose(tree, withoutSize()), rejection = expect(first).rejects.toThrow('选择已取消')
    const signal = value.onReadAsset.mock.calls[0][1]; click(ui.render(), '返回配置'); expect(signal?.aborted).toBe(true); click(ui.render(), '从素材库选择'); const second = choose(ui.render(), withoutSize('c'.repeat(43)))
    old.resolve(image('b'.repeat(43))); await rejection; next.resolve(image('c'.repeat(43))); await second
    click(ui.render(), '创建室内任务'); await settle(); expect(value.onApply.mock.calls[0][0].source.binding).toEqual({ kind: 'asset', assetId: 'c'.repeat(43) }); ui.close()
  })
  it('rejects a detached picker callback after returning to the form', async () => {
    const value = props(), ui = harness(value); click(ui.render(), '从素材库选择'); const previousPicker = ui.render(); click(previousPicker, '返回配置')
    await expect(choose(previousPicker, image('b'.repeat(43)))).rejects.toThrow('选择已关闭')
    expect(value.onReadAsset).not.toHaveBeenCalled(); click(ui.render(), '创建室内任务'); await settle()
    expect(value.onApply.mock.calls[0][0].source.binding).toEqual({ kind: 'asset', assetId: image().assetId }); ui.close()
  })
  it('keeps the prior source on detail identity failure and makes the error visible', async () => {
    const value = props(); value.onReadAsset.mockResolvedValueOnce(image('c'.repeat(43))); const ui = harness(value); click(ui.render(), '从素材库选择')
    await expect(choose(ui.render(), withoutSize())).rejects.toThrow('不一致'); expect(textOf(ui.render())).toContain('不一致'); click(ui.render(), '返回配置'); click(ui.render(), '创建室内任务'); await settle()
    expect(value.onApply.mock.calls[0][0].source.binding).toEqual({ kind: 'asset', assetId: image().assetId }); ui.close()
  })
  it('uploads only once and rejects its late completion after closing without claiming the upload was undone', async () => {
    const value = props(), pending = deferred<CanvasImageAssetSummary | null>(); value.onPickAsset.mockImplementation(() => pending.promise); const ui = harness(value), tree = ui.render(), upload = control(tree, 'button', '上传图片').props.onClick as () => void
    upload(); upload(); expect(value.onPickAsset).toHaveBeenCalledOnce(); expect(textOf(ui.render())).toContain('不会撤销已提交'); click(ui.render(), '取消'); expect(value.onClose).toHaveBeenCalledOnce()
    pending.resolve(image('b'.repeat(43))); await settle(); expect(value.onApply).not.toHaveBeenCalled(); expect(value.onReadAsset).not.toHaveBeenCalled(); ui.close()
  })
  it('retains the draft on a failed save and prevents a late success from closing another scope', async () => {
    const value = props(); value.onApply.mockRejectedValueOnce(new Error('配置未确认')); const ui = harness(value); click(ui.render(), '创建室内任务'); await settle()
    expect(textOf(ui.render())).toContain('配置未确认'); expect(value.onClose).not.toHaveBeenCalled()
    const pending = deferred<void>(); value.onApply.mockImplementation(() => pending.promise); click(ui.render(), '创建室内任务'); value.scopeKey = 'other-project'; pending.resolve(); await settle()
    expect(value.onApply).toHaveBeenCalledTimes(2); expect(value.onClose).not.toHaveBeenCalled(); ui.close()
  })
  it('never handles Escape as close during input method composition', () => {
    const value = props(), ui = harness(value), section = elements(ui.render(), 'section').find((entry) => entry.props.role === 'dialog')!, event = { key: 'Escape', nativeEvent: { isComposing: true }, stopPropagation: vi.fn(), preventDefault: vi.fn() }
    ;(section.props.onKeyDown as (event: unknown) => void)(event); expect(value.onClose).not.toHaveBeenCalled(); expect(event.preventDefault).not.toHaveBeenCalled(); ui.close()
  })
})
