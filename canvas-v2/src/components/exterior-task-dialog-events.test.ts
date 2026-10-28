import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasImageAssetSummary } from '../host'
import { defaultExteriorTask, buildExteriorTaskPrompt, type ExteriorTaskKind } from '../exterior/exterior-task'

const runtime = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef(initial: unknown) { const index = runtime.cursor++; runtime.slots[index] ??= { current: initial }; return runtime.slots[index] },
  useState(initial: unknown) { const index = runtime.cursor++; if (!(index in runtime.slots)) runtime.slots[index] = typeof initial === 'function' ? initial() : initial; return [runtime.slots[index], (value: unknown) => { runtime.slots[index] = typeof value === 'function' ? value(runtime.slots[index]) : value }] },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) { const index = runtime.cursor++, previous = runtime.slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined; if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return; runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } }) },
}))
vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), createPortal: (element: unknown) => element }))
import { ExteriorTaskDialog, type ExteriorTaskDialogProps } from './ExteriorTaskDialog'
import { TemplateAssetPicker } from './TemplateAssetPicker'
import { chooseExteriorTaskAsset, exteriorTaskReferences } from './exterior-task-ui'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type: unknown): ElementShape[] { if (Array.isArray(value)) return value.flatMap((item) => elements(item, type)); if (!value || typeof value !== 'object' || !('props' in value)) return []; const element = value as ElementShape; return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)] }
function textOf(value: unknown): string { if (typeof value === 'string' || typeof value === 'number') return String(value); if (Array.isArray(value)) return value.map(textOf).join(''); return value && typeof value === 'object' && 'props' in value ? textOf((value as ElementShape).props.children) : '' }
function control(tree: unknown, type: string, label: string): ElementShape { const found = elements(tree, type).find((element) => element.props['aria-label'] === label || textOf(element.props.children) === label); expect(found, label).toBeDefined(); return found! }
function click(tree: unknown, label: string) { const button = control(tree, 'button', label); expect(button.props.disabled).not.toBe(true); (button.props.onClick as () => void)() }
function change(tree: unknown, type: string, label: string, value: string) { (control(tree, type, label).props.onChange as (event: unknown) => void)({ target: { value } }) }
function image(id = 'a'.repeat(43)): CanvasImageAssetSummary { return { assetId: id, mediaType: 'image', localUrl: `xingmang-asset://image/${id}`, thumbnailUrl: `xingmang-asset://thumb/v2/image/${id}`, mimeType: 'image/png', fileName: '建筑.png', createdAt: '2026-10-16T00:00:00.000Z', width: 1024, height: 768 } }
function withoutSize(id = 'b'.repeat(43)): CanvasImageAssetSummary { const { width: _width, height: _height, ...asset } = image(id); return asset }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept }); return { promise, resolve } }
function props(kind: ExteriorTaskKind = 'exterior-render') {
  const task = defaultExteriorTask(kind)
  let references = exteriorTaskReferences(task, [])
  references = chooseExteriorTaskAsset(references, 'source', image())
  if (references.length === 2) references = chooseExteriorTaskAsset(references, 'reference', image('b'.repeat(43)))
  return { mode: 'create' as const, scopeKey: 'owner:project:1', isCurrent: (): boolean => true, initialTask: task, initialReferences: references, initialPrompt: '保留建筑入口', initialGeneration: { model: 'gpt-image-2', size: '1024x1024', imageResolution: '1K' as const, quality: 'low', imageCandidateCount: 2 as const }, initialAnalysis: { model: 'gpt-4.1-mini' }, assets: { items: [], total: 0, offset: 0, limit: 24, hasMore: false, facets: { tags: [] } }, imageModels: [{ id: 'gpt-image-2', label: 'GPT Image 2' }], textModels: [{ id: 'gpt-4.1-mini', label: 'GPT 4.1 mini' }], onPickAsset: vi.fn(async (): Promise<CanvasImageAssetSummary | null> => image('c'.repeat(43))), onReadAsset: vi.fn(async (assetId: string, _signal?: AbortSignal) => image(assetId)), onApply: vi.fn(async (_draft: Parameters<ExteriorTaskDialogProps['onApply']>[0]): Promise<void> => undefined), onClose: vi.fn() } satisfies ExteriorTaskDialogProps
}
function harness(value: ExteriorTaskDialogProps) {
  vi.stubGlobal('document', { activeElement: null, body: {} }); vi.stubGlobal('HTMLElement', class {})
  runtime.cursor = 0; runtime.slots = []; runtime.effects = []
  return { render() { runtime.cursor = 0; ExteriorTaskDialog(value); runtime.effects.splice(0).forEach((effect) => effect()); runtime.cursor = 0; const tree = ExteriorTaskDialog(value); runtime.effects.splice(0).forEach((effect) => effect()); return tree }, close() { for (const slot of runtime.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup(): void }).cleanup() } }
}
function choose(tree: unknown, asset: CanvasImageAssetSummary): Promise<void> { return (elements(tree, TemplateAssetPicker)[0].props.onChoose as (asset: CanvasImageAssetSummary) => Promise<void>)(asset) }
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
afterEach(() => vi.unstubAllGlobals())


function clickAt(tree: unknown, label: string, index: number) { const button = elements(tree, 'button').filter((element) => textOf(element.props.children) === label)[index]; expect(button).toBeDefined(); expect(button.props.disabled).not.toBe(true); (button.props.onClick as () => void)() }

describe('exterior task actual dialog callbacks', () => {
  it('submits current render controls once and suppresses in-flight and completed duplicate clicks', async () => {
    const value = props(), pending = deferred<void>(); value.onApply.mockImplementation(() => pending.promise); const ui = harness(value)
    change(ui.render(), 'select', '室外天气', 'rainy'); change(ui.render(), 'textarea', '室外创作要求', '保留楼梯')
    const tree = ui.render(); if (value.initialTask.kind !== 'exterior-render') throw new Error('Expected render fixture')
    expect(textOf(tree)).toContain(buildExteriorTaskPrompt({ ...value.initialTask, weather: 'rainy' }, '保留楼梯'))
    const apply = control(tree, 'button', '创建室外任务').props.onClick as () => void; apply(); apply(); ui.render()
    expect(value.onApply).toHaveBeenCalledOnce(); expect(value.onApply.mock.calls[0][0]).toMatchObject({ mode: 'create', task: { weather: 'rainy' }, prompt: '保留楼梯', imageCandidateCount: 2, references: [{ role: 'source', binding: { kind: 'asset', assetId: image().assetId } }] })
    expect(value.onPickAsset).not.toHaveBeenCalled(); expect(value.onReadAsset).not.toHaveBeenCalled(); expect(value.onClose).not.toHaveBeenCalled()
    pending.resolve(); await settle(); apply(); expect(value.onApply).toHaveBeenCalledOnce(); expect(value.onClose).toHaveBeenCalledOnce(); ui.close()
  })
  it('preserves a dirty draft until an explicit discard and never mutates the graph on cancel', () => {
    const value = props(), ui = harness(value); change(ui.render(), 'textarea', '室外创作要求', '新的补充'); click(ui.render(), '取消')
    expect(value.onClose).not.toHaveBeenCalled(); click(ui.render(), '继续编辑')
    expect(control(ui.render(), 'textarea', '室外创作要求').props.value).toBe('新的补充'); click(ui.render(), '取消'); click(ui.render(), '放弃修改并关闭')
    expect(value.onClose).toHaveBeenCalledOnce(); expect(value.onApply).not.toHaveBeenCalled(); ui.close()
  })
  it('keeps explicit empty image model and exact existing source slot while editing', async () => {
    const value = { ...props(), mode: 'edit' as const, initialReferences: [{ role: 'source' as const, binding: { kind: 'existing' as const, edgeId: 'original-edge', outputIndex: 2 } }], initialGeneration: { model: '', size: '1536x1024', quality: 'high', imageResolution: '2K' as const, imageCandidateCount: 4 as const } }, ui = harness(value)
    const tree = ui.render(); expect(control(tree, 'select', '室外创作图像模型').props.value).toBe(''); expect(textOf(tree)).toContain('原有候选保留')
    click(tree, '保存室外配置'); await settle()
    expect(value.onApply).toHaveBeenCalledExactlyOnceWith({ mode: 'edit', task: value.initialTask, references: value.initialReferences, prompt: value.initialPrompt, ...value.initialGeneration }); ui.close()
  })
  it('hydrates the chosen reference role only and blocks duplicate selection during its read', async () => {
    const value = props('landscape-redesign'), pending = deferred<CanvasImageAssetSummary>(); value.onReadAsset.mockImplementation(() => pending.promise); const ui = harness(value)
    clickAt(ui.render(), '素材库', 1); const tree = ui.render(); const selection = choose(tree, withoutSize('c'.repeat(43)))
    await expect(choose(tree, image('d'.repeat(43)))).rejects.toThrow('正在核对')
    pending.resolve(image('c'.repeat(43))); await selection; click(ui.render(), '创建室外任务'); await settle()
    expect(value.onApply.mock.calls[0][0].references).toEqual([{ role: 'source', binding: { kind: 'asset', assetId: image().assetId } }, { role: 'reference', binding: { kind: 'asset', assetId: 'c'.repeat(43) } }]); ui.close()
  })
  it.each(['account', 'project', 'permission', 'unmount'] as const)('drops a late reference upload after %s changes', async (kind) => {
    const value = props('storefront-redesign'), pending = deferred<CanvasImageAssetSummary | null>(); value.onPickAsset.mockImplementation(() => pending.promise); const ui = harness(value)
    clickAt(ui.render(), '上传图片', 1); if (kind === 'account' || kind === 'project') value.scopeKey = kind; else if (kind === 'permission') value.isCurrent = () => false; else ui.close()
    pending.resolve(image('c'.repeat(43))); await settle()
    if (kind !== 'unmount') expect(ui.render()).toBeNull()
    expect(value.onApply).not.toHaveBeenCalled(); expect(value.onClose).not.toHaveBeenCalled(); expect(value.onReadAsset).not.toHaveBeenCalled(); ui.close()
  })
  it('does not let a cancelled old detail response replace a newer reference selection', async () => {
    const value = props('facade-renovation'), old = deferred<CanvasImageAssetSummary>(), next = deferred<CanvasImageAssetSummary>(); value.onReadAsset.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise)
    const ui = harness(value); clickAt(ui.render(), '素材库', 1); const first = choose(ui.render(), withoutSize('c'.repeat(43))), rejected = expect(first).rejects.toThrow('选择已取消')
    const signal = value.onReadAsset.mock.calls[0][1]; click(ui.render(), '返回配置'); expect(signal?.aborted).toBe(true)
    clickAt(ui.render(), '素材库', 1); const second = choose(ui.render(), withoutSize('d'.repeat(43)))
    old.resolve(image('c'.repeat(43))); await rejected; next.resolve(image('d'.repeat(43))); await second
    click(ui.render(), '创建室外任务'); await settle(); expect(value.onApply.mock.calls[0][0].references[1].binding).toEqual({ kind: 'asset', assetId: 'd'.repeat(43) }); ui.close()
  })
  it('rejects a detached picker callback after closing the asset picker', async () => {
    const value = props(), ui = harness(value); clickAt(ui.render(), '素材库', 0); const previous = ui.render(); click(previous, '返回配置')
    await expect(choose(previous, image('c'.repeat(43)))).rejects.toThrow('选择已关闭')
    expect(value.onReadAsset).not.toHaveBeenCalled(); click(ui.render(), '创建室外任务'); await settle()
    expect(value.onApply.mock.calls[0][0].references[0].binding).toEqual({ kind: 'asset', assetId: image().assetId }); ui.close()
  })
  it('retains both images when selected detail identity mismatches', async () => {
    const value = props('exterior-style-transfer'); value.onReadAsset.mockResolvedValueOnce(image('d'.repeat(43))); const ui = harness(value); clickAt(ui.render(), '素材库', 1)
    await expect(choose(ui.render(), withoutSize('c'.repeat(43)))).rejects.toThrow('不一致'); expect(textOf(ui.render())).toContain('不一致'); click(ui.render(), '返回配置'); click(ui.render(), '创建室外任务'); await settle()
    expect(value.onApply.mock.calls[0][0].references[1].binding).toEqual({ kind: 'asset', assetId: 'b'.repeat(43) }); ui.close()
  })
  it('uploads only once and ignores a late completion after closing the clean form', async () => {
    const value = props(), pending = deferred<CanvasImageAssetSummary | null>(); value.onPickAsset.mockImplementation(() => pending.promise); const ui = harness(value), tree = ui.render(), upload = control(tree, 'button', '上传图片').props.onClick as () => void
    upload(); upload(); expect(value.onPickAsset).toHaveBeenCalledOnce(); expect(textOf(ui.render())).toContain('不会撤销已提交'); click(ui.render(), '取消'); expect(value.onClose).toHaveBeenCalledOnce()
    pending.resolve(image('c'.repeat(43))); await settle(); expect(value.onApply).not.toHaveBeenCalled(); expect(value.onReadAsset).not.toHaveBeenCalled(); ui.close()
  })
  it('retains failed save inputs and prevents a late success from closing another scope', async () => {
    const value = props(); value.onApply.mockRejectedValueOnce(new Error('配置未确认')); const ui = harness(value); click(ui.render(), '创建室外任务'); await settle()
    expect(textOf(ui.render())).toContain('配置未确认'); expect(value.onClose).not.toHaveBeenCalled()
    const pending = deferred<void>(); value.onApply.mockImplementation(() => pending.promise); click(ui.render(), '创建室外任务'); value.scopeKey = 'other-project'; pending.resolve(); await settle()
    expect(value.onApply).toHaveBeenCalledTimes(2); expect(value.onClose).not.toHaveBeenCalled(); ui.close()
  })
  it('rechecks current visual model availability even if an older enabled save callback is retained', async () => {
    const value = props('landscape-redesign'), ui = harness(value); const apply = control(ui.render(), 'button', '创建室外任务').props.onClick as () => void
    value.textModels = []; ui.render(); apply(); await settle()
    expect(value.onApply).not.toHaveBeenCalled(); expect(textOf(ui.render())).toContain('当前来源不可用'); ui.close()
  })
  it('keeps an explicit empty analysis model on edit rather than inventing a connected analysis node', async () => {
    const value = { ...props('landscape-redesign'), mode: 'edit' as const, initialAnalysis: { model: '' } }, ui = harness(value)
    const tree = ui.render(); expect(control(tree, 'select', '室外自动提示文字模型').props.value).toBe(''); expect(control(tree, 'button', '保存室外配置').props.disabled).toBe(true)
    ;(control(tree, 'button', '保存室外配置').props.onClick as () => void)(); await settle(); expect(value.onApply).not.toHaveBeenCalled(); ui.close()
  })
  it('requires manual instructions immediately after disabling automatic prompting', async () => {
    const value = { ...props('landscape-redesign'), initialPrompt: '' }, ui = harness(value)
    const checkbox = elements(ui.render(), 'input').find((element) => element.props.type === 'checkbox')!
    ;(checkbox.props.onChange as (event: unknown) => void)({ target: { checked: false } }); let tree = ui.render()
    expect(textOf(tree)).toContain('手动模式请填写'); expect(control(tree, 'button', '创建室外任务').props.disabled).toBe(true)
    change(tree, 'textarea', '室外创作要求', '保留原场地边界，增加步道'); tree = ui.render(); expect(textOf(tree)).toContain('0 次文字请求'); click(tree, '创建室外任务'); await settle()
    expect(value.onApply.mock.calls[0][0].analysis).toBeUndefined(); expect(value.onApply.mock.calls[0][0].task).toMatchObject({ automaticPrompt: false }); ui.close()
  })
  it('keeps Escape inside an active input-method composition', () => {
    const value = props(), ui = harness(value), section = elements(ui.render(), 'section').find((entry) => entry.props.role === 'dialog')!, event = { key: 'Escape', nativeEvent: { isComposing: true }, stopPropagation: vi.fn(), preventDefault: vi.fn() }
    ;(section.props.onKeyDown as (event: unknown) => void)(event); expect(value.onClose).not.toHaveBeenCalled(); expect(event.preventDefault).not.toHaveBeenCalled(); ui.close()
  })
  it('keeps the entire form and original model through a source switch, blocks pending saves and requires an available replacement', async () => {
    const value = Object.assign(props(), { imageSources: [{ id: 'image-a', label: '图片来源 A' }, { id: 'image-b', label: '图片来源 B' }], imageSource: 'image-a', sourceLoading: false, onSelectSource: vi.fn((_kind: 'image' | 'text', _source: string) => {}) }), ui = harness(value)
    change(ui.render(), 'select', '室外天气', 'rainy'); change(ui.render(), 'textarea', '室外创作要求', '保留全部台阶')
    const oldApply = control(ui.render(), 'button', '创建室外任务').props.onClick as () => void
    change(ui.render(), 'select', '室外创作图像来源', 'image-b')
    expect(value.onSelectSource).toHaveBeenCalledExactlyOnceWith('image', 'image-b'); oldApply(); await settle(); expect(value.onApply).not.toHaveBeenCalled()
    value.imageSource = 'image-b'; value.sourceLoading = true; value.imageModels = []; let tree = ui.render()
    expect(textOf(tree)).toContain('正在读取模型来源'); expect(control(tree, 'button', '创建室外任务').props.disabled).toBe(true)
    expect(control(tree, 'textarea', '室外创作要求').props.disabled).toBe(false); change(tree, 'textarea', '室外创作要求', '仍保留全部台阶')
    value.sourceLoading = false; value.imageModels = [{ id: 'gpt-image-1', label: 'GPT Image 1' }]; tree = ui.render()
    expect(control(tree, 'select', '室外创作图像模型').props.value).toBe('gpt-image-2'); expect(control(tree, 'select', '室外天气').props.value).toBe('rainy')
    expect(control(tree, 'textarea', '室外创作要求').props.value).toBe('仍保留全部台阶'); expect(textOf(tree)).toContain('当前来源不可用，请重新选择')
    expect(control(tree, 'button', '创建室外任务').props.disabled).toBe(true); oldApply(); await settle(); expect(value.onApply).not.toHaveBeenCalled()
    change(ui.render(), 'select', '室外创作图像模型', 'gpt-image-1'); click(ui.render(), '创建室外任务'); await settle()
    expect(value.onApply.mock.calls[0][0]).toMatchObject({ task: { weather: 'rainy' }, prompt: '仍保留全部台阶', model: 'gpt-image-1', references: [{ role: 'source', binding: { kind: 'asset', assetId: image().assetId } }] }); ui.close()
  })
  it('keeps both images and the original analysis model when changing a text source until the user selects a valid model', async () => {
    const value = Object.assign(props('landscape-redesign'), { textSources: [{ id: 'text-a', label: '文字来源 A' }, { id: 'text-b', label: '文字来源 B' }], textSource: 'text-a', sourceLoading: false, onSelectSource: vi.fn((_kind: 'image' | 'text', _source: string) => {}) }), ui = harness(value)
    change(ui.render(), 'select', '室外自动提示文字来源', 'text-b'); value.textSource = 'text-b'; value.sourceLoading = true; value.textModels = []; ui.render()
    value.textModels = [{ id: 'gpt-4.1', label: 'GPT 4.1' }]; value.sourceLoading = false; let tree = ui.render()
    expect(value.onSelectSource).toHaveBeenCalledExactlyOnceWith('text', 'text-b'); expect(control(tree, 'select', '室外自动提示文字模型').props.value).toBe('gpt-4.1-mini')
    expect(control(tree, 'button', '创建室外任务').props.disabled).toBe(true); change(tree, 'select', '室外自动提示文字模型', 'gpt-4.1'); tree = ui.render(); click(tree, '创建室外任务'); await settle()
    expect(value.onApply.mock.calls[0][0]).toMatchObject({ analysis: { model: 'gpt-4.1' }, references: [{ role: 'source', binding: { assetId: 'a'.repeat(43) } }, { role: 'reference', binding: { assetId: 'b'.repeat(43) } }] }); ui.close()
  })
  it('reports a rejected source selection locally without clearing the form', async () => {
    const value = Object.assign(props(), { imageSources: [{ id: 'image-a', label: '原来源' }, { id: 'image-b', label: '新来源' }], imageSource: 'image-a', onSelectSource: vi.fn((_kind: 'image' | 'text', _source: string) => { throw new Error('所选来源没有图片用途') }) }), ui = harness(value)
    change(ui.render(), 'select', '室外创作图像来源', 'image-b'); let tree = ui.render()
    expect(textOf(tree)).toContain('所选来源没有图片用途'); expect(control(tree, 'select', '室外创作图像来源').props.value).toBe('image-a'); expect(control(tree, 'textarea', '室外创作要求').props.value).toBe(value.initialPrompt)
    click(tree, '创建室外任务'); await settle(); expect(value.onApply).toHaveBeenCalledOnce(); ui.close()
  })
  it('releases a failed source load back to the confirmed source and retains editable draft fields', () => {
    const value = Object.assign(props(), { imageSources: [{ id: 'image-a', label: '原来源' }, { id: 'image-b', label: '新来源' }], imageSource: 'image-a', sourceLoading: false, onSelectSource: vi.fn((_kind: 'image' | 'text', _source: string) => {}) }), ui = harness(value)
    change(ui.render(), 'select', '室外创作图像来源', 'image-b'); value.sourceLoading = true; ui.render(); value.sourceLoading = false
    const tree = ui.render(); expect(textOf(tree)).toContain('来源尚未切换成功'); expect(control(tree, 'select', '室外创作图像来源').props.value).toBe('image-a')
    expect(control(tree, 'button', '创建室外任务').props.disabled).toBe(false); expect(control(tree, 'select', '室外创作图像模型').props.value).toBe('gpt-image-2'); ui.close()
  })
  it('keeps source selectors inside editability and permission guards even through detached callbacks', async () => {
    const value = Object.assign(props(), { imageSources: [{ id: 'image-a', label: '原来源' }, { id: 'image-b', label: '新来源' }], imageSource: 'image-a', onSelectSource: vi.fn((_kind: 'image' | 'text', _source: string) => {}) }), ui = harness(value)
    const changeSource = control(ui.render(), 'select', '室外创作图像来源').props.onChange as (event: unknown) => void
    value.isCurrent = () => false; changeSource({ target: { value: 'image-b' } }); expect(value.onSelectSource).not.toHaveBeenCalled(); ui.close()
    const next = Object.assign(props(), { imageSources: value.imageSources, imageSource: 'image-a', onSelectSource: vi.fn((_kind: 'image' | 'text', _source: string) => {}) }), pending = deferred<void>(), other = harness(next)
    next.onApply.mockImplementation(() => pending.promise); click(other.render(), '创建室外任务'); change(other.render(), 'select', '室外创作图像来源', 'image-b')
    expect(next.onSelectSource).not.toHaveBeenCalled(); pending.resolve(); await settle(); other.close()
  })

})
