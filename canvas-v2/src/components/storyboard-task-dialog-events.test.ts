import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasImageAssetSummary } from '../host'
import { defaultStoryboardTask, buildStoryboardTaskPrompt } from '../storyboard/storyboard-task'

const runtime = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef(initial: unknown) { const index = runtime.cursor++; runtime.slots[index] ??= { current: initial }; return runtime.slots[index] },
  useState(initial: unknown) { const index = runtime.cursor++; if (!(index in runtime.slots)) runtime.slots[index] = typeof initial === 'function' ? initial() : initial; return [runtime.slots[index], (value: unknown) => { runtime.slots[index] = typeof value === 'function' ? value(runtime.slots[index]) : value }] },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) { const index = runtime.cursor++, previous = runtime.slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined; if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return; runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } }) },
}))
vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), createPortal: (element: unknown) => element }))
import { StoryboardTaskDialog, type StoryboardTaskDialogProps } from './StoryboardTaskDialog'
import { TemplateAssetPicker } from './TemplateAssetPicker'
import { chooseStoryboardTaskAsset, storyboardTaskReferences } from './storyboard-task-ui'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type: unknown): ElementShape[] { if (Array.isArray(value)) return value.flatMap((item) => elements(item, type)); if (!value || typeof value !== 'object' || !('props' in value)) return []; const element = value as ElementShape; return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)] }
function textOf(value: unknown): string { if (typeof value === 'string' || typeof value === 'number') return String(value); if (Array.isArray(value)) return value.map(textOf).join(''); return value && typeof value === 'object' && 'props' in value ? textOf((value as ElementShape).props.children) : '' }
function control(tree: unknown, type: string, label: string): ElementShape { const found = elements(tree, type).find((element) => element.props['aria-label'] === label || textOf(element.props.children) === label); expect(found, label).toBeDefined(); return found! }
function click(tree: unknown, label: string) { const button = control(tree, 'button', label); expect(button.props.disabled).not.toBe(true); (button.props.onClick as () => void)() }
function change(tree: unknown, type: string, label: string, value: string) { (control(tree, type, label).props.onChange as (event: unknown) => void)({ target: { value } }) }
function image(id = 'a'.repeat(43)): CanvasImageAssetSummary { return { assetId: id, mediaType: 'image', localUrl: `xingmang-asset://image/${id}`, thumbnailUrl: `xingmang-asset://thumb/v2/image/${id}`, mimeType: 'image/png', fileName: '建筑.png', createdAt: '2026-10-16T00:00:00.000Z', width: 1024, height: 768 } }
function withoutSize(id = 'b'.repeat(43)): CanvasImageAssetSummary { const { width: _width, height: _height, ...asset } = image(id); return asset }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept }); return { promise, resolve } }
function props() {
  const task = defaultStoryboardTask()
  const references = chooseStoryboardTaskAsset(storyboardTaskReferences(task, []), 0, image())
  return { mode: 'create' as const, scopeKey: 'owner:project:1', isCurrent: (): boolean => true, initialTask: task, initialReferences: references, initialPrompt: '小猫走进森林，找到回家的路', initialGeneration: { model: 'gpt-image-2', size: '1024x1024', imageResolution: '1K' as const, quality: 'low', imageCandidateCount: 2 as const }, initialAnalysis: { model: 'gpt-4.1-mini' }, assets: { items: [], total: 0, offset: 0, limit: 24, hasMore: false, facets: { tags: [] } }, imageModels: [{ id: 'gpt-image-2', label: 'GPT Image 2' }], textModels: [{ id: 'gpt-4.1-mini', label: 'GPT 4.1 mini' }], onPickAsset: vi.fn(async (): Promise<CanvasImageAssetSummary | null> => image('c'.repeat(43))), onReadAsset: vi.fn(async (assetId: string, _signal?: AbortSignal) => image(assetId)), onApply: vi.fn(async (_draft: Parameters<StoryboardTaskDialogProps['onApply']>[0]): Promise<void> => undefined), onClose: vi.fn() } satisfies StoryboardTaskDialogProps
}
function harness(value: StoryboardTaskDialogProps) {
  vi.stubGlobal('document', { activeElement: null, body: {} }); vi.stubGlobal('HTMLElement', class {})
  runtime.cursor = 0; runtime.slots = []; runtime.effects = []
  return { render() { runtime.cursor = 0; StoryboardTaskDialog(value); runtime.effects.splice(0).forEach((effect) => effect()); runtime.cursor = 0; const tree = StoryboardTaskDialog(value); runtime.effects.splice(0).forEach((effect) => effect()); return tree }, close() { for (const slot of runtime.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup(): void }).cleanup() } }
}
function choose(tree: unknown, asset: CanvasImageAssetSummary): Promise<void> { return (elements(tree, TemplateAssetPicker)[0].props.onChoose as (asset: CanvasImageAssetSummary) => Promise<void>)(asset) }
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
afterEach(() => vi.unstubAllGlobals())


function clickAt(tree: unknown, label: string, index: number) { const button = elements(tree, 'button').filter((element) => textOf(element.props.children) === label)[index]; expect(button).toBeDefined(); expect(button.props.disabled).not.toBe(true); (button.props.onClick as () => void)() }

describe('storyboard actual dialog callbacks', () => {
  it('submits the latest plot and panel count once while keeping candidates independent of panels', async () => {
    const value = props(), pending = deferred<void>(); value.onApply.mockImplementation(() => pending.promise); const ui = harness(value)
    change(ui.render(), 'select', '故事板宫格数', '25'); change(ui.render(), 'textarea', '故事板剧情内容', 'R67 手动补充剧情')
    const tree = ui.render(); expect(textOf(tree)).toContain(buildStoryboardTaskPrompt({ ...value.initialTask, panels: 25 }, 'R67 手动补充剧情'))
    const apply = control(tree, 'button', '创建故事板任务').props.onClick as () => void; apply(); apply(); ui.render()
    expect(value.onApply).toHaveBeenCalledOnce(); expect(value.onApply.mock.calls[0][0]).toMatchObject({ task: { panels: 25, automaticPlot: true }, prompt: 'R67 手动补充剧情', imageCandidateCount: 2, analysis: { model: 'gpt-4.1-mini' } })
    pending.resolve(); await settle(); apply(); expect(value.onApply).toHaveBeenCalledOnce(); expect(value.onClose).toHaveBeenCalledOnce(); ui.close()
  })
  it('allows manual plots without a vision call and preserves a dirty draft until explicit discard', async () => {
    const value = { ...props(), initialPrompt: '' }, ui = harness(value)
    const checkbox = elements(ui.render(), 'input').find((element) => element.props.type === 'checkbox')!
    ;(checkbox.props.onChange as (event: unknown) => void)({ target: { checked: false } })
    expect(control(ui.render(), 'button', '创建故事板任务').props.disabled).toBe(true)
    change(ui.render(), 'textarea', '故事板剧情内容', '先遇到伙伴，再一起回家')
    expect(textOf(ui.render())).toContain('0 次文字请求'); click(ui.render(), '取消'); expect(value.onClose).not.toHaveBeenCalled()
    click(ui.render(), '继续编辑'); expect(control(ui.render(), 'textarea', '故事板剧情内容').props.value).toBe('先遇到伙伴，再一起回家')
    click(ui.render(), '创建故事板任务'); await settle(); expect(value.onApply.mock.calls[0][0].analysis).toBeUndefined(); ui.close()
  })
  it('adds ordered slots, fills the second, moves it first and removes the former source without losing bindings', async () => {
    const value = props(), ui = harness(value); click(ui.render(), '添加图片'); clickAt(ui.render(), '素材库', 1)
    await choose(ui.render(), image('b'.repeat(43))); click(ui.render(), '上移输入 2'); click(ui.render(), '移除输入 2')
    expect(textOf(ui.render())).toContain('1 / 4'); click(ui.render(), '创建故事板任务'); await settle()
    expect(value.onApply.mock.calls[0][0].references).toEqual([{ role: 'source', binding: { kind: 'asset', assetId: 'b'.repeat(43) } }]); ui.close()
  })
  it('retains a missing slot until it is filled instead of submitting the remaining image alone', async () => {
    const value = props(), ui = harness(value); click(ui.render(), '添加图片'); click(ui.render(), '创建故事板任务'); await settle()
    expect(value.onApply).not.toHaveBeenCalled(); expect(textOf(ui.render())).toContain('绑定输入 2')
    clickAt(ui.render(), '素材库', 1); await expect(choose(ui.render(), image())).rejects.toThrow('不能重复')
    click(ui.render(), '返回配置'); click(ui.render(), '移除输入 2'); click(ui.render(), '创建故事板任务'); await settle(); expect(value.onApply).toHaveBeenCalledOnce(); ui.close()
  })
  it.each(['account', 'project', 'permission', 'unmount'] as const)('drops a late uploaded image after %s changes', async (condition) => {
    const value = props(), pending = deferred<CanvasImageAssetSummary | null>(); value.onPickAsset.mockImplementation(() => pending.promise); const ui = harness(value)
    clickAt(ui.render(), '上传图片', 0)
    if (condition === 'account' || condition === 'project') value.scopeKey = condition; else if (condition === 'permission') value.isCurrent = () => false; else ui.close()
    pending.resolve(image('c'.repeat(43))); await settle(); if (condition !== 'unmount') expect(ui.render()).toBeNull()
    expect(value.onApply).not.toHaveBeenCalled(); expect(value.onClose).not.toHaveBeenCalled(); expect(value.onReadAsset).not.toHaveBeenCalled(); ui.close()
  })
  it('blocks a retained picker callback after close and reopen at the same numbered slot', async () => {
    const value = props(), ui = harness(value); clickAt(ui.render(), '素材库', 0); const oldTree = ui.render(); click(oldTree, '返回配置'); clickAt(ui.render(), '素材库', 0)
    await expect(choose(oldTree, image('b'.repeat(43)))).rejects.toThrow('选择已关闭')
    await choose(ui.render(), image('c'.repeat(43))); click(ui.render(), '创建故事板任务'); await settle()
    expect(value.onApply.mock.calls[0][0].references[0].binding).toEqual({ kind: 'asset', assetId: 'c'.repeat(43) }); ui.close()
  })
  it('cancels old image detail resolution without overwriting a newer selection', async () => {
    const value = props(), old = deferred<CanvasImageAssetSummary>(), next = deferred<CanvasImageAssetSummary>(); value.onReadAsset.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise)
    const ui = harness(value); clickAt(ui.render(), '素材库', 0); const first = choose(ui.render(), withoutSize('b'.repeat(43))), rejected = expect(first).rejects.toThrow('选择已取消')
    click(ui.render(), '返回配置'); clickAt(ui.render(), '素材库', 0); const second = choose(ui.render(), withoutSize('c'.repeat(43)))
    old.resolve(image('b'.repeat(43))); await rejected; next.resolve(image('c'.repeat(43))); await second
    click(ui.render(), '创建故事板任务'); await settle(); expect(value.onApply.mock.calls[0][0].references[0].binding).toEqual({ kind: 'asset', assetId: 'c'.repeat(43) }); ui.close()
  })
  it('keeps input upload single-flight including input zero and shows pending upload before closing', async () => {
    const value = props(), pending = deferred<CanvasImageAssetSummary | null>(); value.onPickAsset.mockImplementation(() => pending.promise); const ui = harness(value)
    const upload = control(ui.render(), 'button', '上传图片').props.onClick as () => void; upload(); upload(); expect(value.onPickAsset).toHaveBeenCalledOnce()
    expect(textOf(ui.render())).toContain('不会撤销已提交'); expect(control(ui.render(), 'button', '添加图片').props.disabled).toBe(true)
    click(ui.render(), '取消'); pending.resolve(image('c'.repeat(43))); await settle(); expect(value.onClose).toHaveBeenCalledOnce(); expect(value.onApply).not.toHaveBeenCalled(); ui.close()
  })
  it('retains explicit empty existing models on edit instead of inventing a connected analysis node', async () => {
    const value = { ...props(), mode: 'edit' as const, initialAnalysis: { model: '' }, initialGeneration: { ...props().initialGeneration, model: '' } }, ui = harness(value)
    expect(control(ui.render(), 'select', '故事板创作图像模型').props.value).toBe(''); expect(control(ui.render(), 'select', '故事板自动剧情文字模型').props.value).toBe('')
    const apply = control(ui.render(), 'button', '保存故事板配置'); expect(apply.props.disabled).toBe(true); (apply.props.onClick as () => void)(); await settle(); expect(value.onApply).not.toHaveBeenCalled(); ui.close()
  })
  it('keeps plot and models through source changes and blocks an old save callback until a valid replacement is selected', async () => {
    const value = Object.assign(props(), { imageSources: [{ id: 'a', label: '来源A' }, { id: 'b', label: '来源B' }], imageSource: 'a', sourceLoading: false, onSelectSource: vi.fn((_kind: 'image' | 'text', _source: string) => {}) }), ui = harness(value)
    const oldApply = control(ui.render(), 'button', '创建故事板任务').props.onClick as () => void
    change(ui.render(), 'select', '故事板创作图像来源', 'b'); oldApply(); await settle(); expect(value.onApply).not.toHaveBeenCalled()
    value.imageSource = 'b'; value.sourceLoading = true; value.imageModels = []; let tree = ui.render(); expect(textOf(tree)).toContain('正在读取模型来源'); expect(control(tree, 'textarea', '故事板剧情内容').props.disabled).toBe(false)
    change(tree, 'textarea', '故事板剧情内容', '切源后仍保留新剧情'); value.sourceLoading = false; value.imageModels = [{ id: 'gpt-image-1', label: 'GPT Image 1' }]; tree = ui.render()
    expect(control(tree, 'select', '故事板创作图像模型').props.value).toBe('gpt-image-2'); expect(control(tree, 'button', '创建故事板任务').props.disabled).toBe(true)
    change(tree, 'select', '故事板创作图像模型', 'gpt-image-1'); click(ui.render(), '创建故事板任务'); await settle()
    expect(value.onApply.mock.calls[0][0]).toMatchObject({ model: 'gpt-image-1', prompt: '切源后仍保留新剧情', references: [{ role: 'source', binding: { assetId: 'a'.repeat(43) } }] }); ui.close()
  })
  it('rechecks late model availability and keeps failed saves editable without closing another scope', async () => {
    const value = props(), ui = harness(value), oldApply = control(ui.render(), 'button', '创建故事板任务').props.onClick as () => void
    value.textModels = []; ui.render(); oldApply(); await settle(); expect(value.onApply).not.toHaveBeenCalled(); expect(textOf(ui.render())).toContain('当前来源不可用')
    value.textModels = [{ id: 'gpt-4.1-mini', label: 'GPT4.1 mini' }]; value.onApply.mockRejectedValueOnce(new Error('配置未确认')); click(ui.render(), '创建故事板任务'); await settle(); expect(textOf(ui.render())).toContain('配置未确认')
    const pending = deferred<void>(); value.onApply.mockImplementation(() => pending.promise); click(ui.render(), '创建故事板任务'); value.scopeKey = 'other-project'; pending.resolve(); await settle(); expect(value.onClose).not.toHaveBeenCalled(); ui.close()
  })
  it('does not treat Escape during IME composition as abandoning the draft', () => {
    const value = props(), ui = harness(value), section = elements(ui.render(), 'section').find((entry) => entry.props.role === 'dialog')!, event = { key: 'Escape', nativeEvent: { isComposing: true }, stopPropagation: vi.fn(), preventDefault: vi.fn() }
    ;(section.props.onKeyDown as (event: unknown) => void)(event); expect(value.onClose).not.toHaveBeenCalled(); expect(event.preventDefault).not.toHaveBeenCalled(); ui.close()
  })
  it('retains four exact existing occurrences on edit and fills a missing slot without dropping the others', async () => {
    const value = { ...props(), mode: 'edit' as const, initialReferences: [{ role: 'source' as const, binding: { kind: 'existing' as const, edgeId: 'edge-a', outputIndex: 3 } }, { role: 'reference' as const, binding: { kind: 'existing' as const, edgeId: 'edge-b', outputIndex: 2 } }, { role: 'reference' as const, binding: { kind: 'missing' as const } }, { role: 'reference' as const, binding: { kind: 'existing' as const, edgeId: 'edge-d', outputIndex: 1 } }] }, ui = harness(value)
    expect(textOf(ui.render())).toContain('4 / 4'); expect(control(ui.render(), 'button', '添加图片').props.disabled).toBe(true)
    click(ui.render(), '保存故事板配置'); await settle(); expect(value.onApply).not.toHaveBeenCalled(); expect(textOf(ui.render())).toContain('绑定输入 3')
    clickAt(ui.render(), '素材库', 2); await choose(ui.render(), image('c'.repeat(43))); click(ui.render(), '保存故事板配置'); await settle()
    expect(value.onApply.mock.calls[0][0].references).toEqual([value.initialReferences[0], value.initialReferences[1], { role: 'reference', binding: { kind: 'asset', assetId: 'c'.repeat(43) } }, value.initialReferences[3]])
    ui.close()
  })
  it('retains ordered images and the original vision model while a different text source loads', async () => {
    const value = Object.assign(props(), { textSources: [{ id: 'a', label: '来源A' }, { id: 'b', label: '来源B' }], textSource: 'a', sourceLoading: false, onSelectSource: vi.fn((_kind: 'image' | 'text', _source: string) => {}) }), ui = harness(value)
    click(ui.render(), '添加图片'); clickAt(ui.render(), '素材库', 1); await choose(ui.render(), image('b'.repeat(43)))
    change(ui.render(), 'select', '故事板自动剧情文字来源', 'b'); value.textSource = 'b'; value.sourceLoading = true; value.textModels = []; ui.render()
    value.sourceLoading = false; value.textModels = [{ id: 'gpt-4.1', label: 'GPT4.1' }]; let tree = ui.render()
    expect(control(tree, 'select', '故事板自动剧情文字模型').props.value).toBe('gpt-4.1-mini'); expect(control(tree, 'button', '创建故事板任务').props.disabled).toBe(true)
    change(tree, 'select', '故事板自动剧情文字模型', 'gpt-4.1'); tree = ui.render(); click(tree, '创建故事板任务'); await settle()
    expect(value.onApply.mock.calls[0][0]).toMatchObject({ analysis: { model: 'gpt-4.1' }, references: [{ role: 'source', binding: { assetId: 'a'.repeat(43) } }, { role: 'reference', binding: { assetId: 'b'.repeat(43) } }] }); ui.close()
  })
  it('reports rejected source changes without clearing the plot and cannot switch after permission changes', async () => {
    const value = Object.assign(props(), { imageSources: [{ id: 'a', label: '来源A' }, { id: 'b', label: '来源B' }], imageSource: 'a', onSelectSource: vi.fn((_kind: 'image' | 'text', _source: string) => { throw new Error('此来源无图片用途') }) }), ui = harness(value)
    change(ui.render(), 'select', '故事板创作图像来源', 'b'); expect(textOf(ui.render())).toContain('此来源无图片用途')
    expect(control(ui.render(), 'select', '故事板创作图像来源').props.value).toBe('a'); expect(control(ui.render(), 'textarea', '故事板剧情内容').props.value).toBe(value.initialPrompt)
    const oldSelect = control(ui.render(), 'select', '故事板创作图像来源').props.onChange as (event: unknown) => void
    value.isCurrent = () => false; oldSelect({ target: { value: 'b' } }); expect(value.onSelectSource).toHaveBeenCalledOnce(); expect(value.onApply).not.toHaveBeenCalled(); ui.close()
  })
  it('stops waiting for pending text when automatic plot is turned off, including an explicit text source switch', async () => {
    const value = Object.assign(props(), { sourceLoading: false, imageSourceLoading: false, textSourceLoading: false, textSources: [{ id: 'a', label: '文字来源A' }, { id: 'b', label: '文字来源B' }], textSource: 'a', onSelectSource: vi.fn((_kind: 'image' | 'text', _source: string) => {}) }), ui = harness(value)
    change(ui.render(), 'select', '故事板自动剧情文字来源', 'b'); value.textSourceLoading = true; value.textModels = []; let tree = ui.render()
    expect(control(tree, 'button', '创建故事板任务').props.disabled).toBe(true)
    const checkbox = elements(tree, 'input').find((entry) => entry.props.type === 'checkbox')!
    ;(checkbox.props.onChange as (event: unknown) => void)({ target: { checked: false } })
    tree = ui.render(); expect(control(tree, 'button', '创建故事板任务').props.disabled).toBe(false); expect(textOf(tree)).toContain('0 次文字请求')
    click(tree, '创建故事板任务'); await settle(); expect(value.onApply).toHaveBeenCalledOnce(); expect(value.onApply.mock.calls[0][0].analysis).toBeUndefined(); ui.close()
  })
  it('starts waiting for pending text immediately when a manual draft enables automatic plot, even through an old save callback', async () => {
    const value = Object.assign(props(), { initialTask: { ...defaultStoryboardTask(), automaticPlot: false }, sourceLoading: false, imageSourceLoading: false, textSourceLoading: true }), ui = harness(value)
    const tree = ui.render(), oldApply = control(tree, 'button', '创建故事板任务').props.onClick as () => void
    expect(control(tree, 'button', '创建故事板任务').props.disabled).toBe(false)
    const checkbox = elements(tree, 'input').find((entry) => entry.props.type === 'checkbox')!
    ;(checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } })
    oldApply(); await settle(); expect(value.onApply).not.toHaveBeenCalled(); expect(control(ui.render(), 'button', '创建故事板任务').props.disabled).toBe(true)
    value.textSourceLoading = false; click(ui.render(), '创建故事板任务'); await settle(); expect(value.onApply.mock.calls[0][0].analysis).toEqual({ model: 'gpt-4.1-mini' }); ui.close()
  })
  it('always waits for image loading in both plot modes while text loading matters only in automatic mode', async () => {
    const value = Object.assign(props(), { sourceLoading: false, imageSourceLoading: false, textSourceLoading: true }), ui = harness(value)
    expect(control(ui.render(), 'button', '创建故事板任务').props.disabled).toBe(true)
    value.textSourceLoading = false; value.imageSourceLoading = true; let tree = ui.render(); expect(control(tree, 'button', '创建故事板任务').props.disabled).toBe(true)
    const checkbox = elements(tree, 'input').find((entry) => entry.props.type === 'checkbox')!
    ;(checkbox.props.onChange as (event: unknown) => void)({ target: { checked: false } }); tree = ui.render(); expect(control(tree, 'button', '创建故事板任务').props.disabled).toBe(true)
    value.imageSourceLoading = false; click(ui.render(), '创建故事板任务'); await settle(); expect(value.onApply).toHaveBeenCalledOnce(); ui.close()
  })
  it('does not mistake unrelated image loading for a completed text source selection', async () => {
    const value = Object.assign(props(), { sourceLoading: false, imageSourceLoading: true, textSourceLoading: false, textSources: [{ id: 'a', label: '文字来源A' }, { id: 'b', label: '文字来源B' }], textSource: 'a', onSelectSource: vi.fn((_kind: 'image' | 'text', _source: string) => {}) }), ui = harness(value)
    change(ui.render(), 'select', '故事板自动剧情文字来源', 'b'); ui.render(); value.imageSourceLoading = false
    let tree = ui.render(); expect(textOf(tree)).not.toContain('来源尚未切换成功'); expect(control(tree, 'button', '创建故事板任务').props.disabled).toBe(true)
    value.textSourceLoading = true; ui.render(); value.textSourceLoading = false; value.textSource = 'b'; tree = ui.render()
    expect(textOf(tree)).not.toContain('来源尚未切换成功'); click(tree, '创建故事板任务'); await settle(); expect(value.onApply).toHaveBeenCalledOnce(); ui.close()
  })
})

