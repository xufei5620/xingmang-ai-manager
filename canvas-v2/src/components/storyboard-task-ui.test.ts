import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasImageAssetSummary } from '../host'
import { defaultStoryboardTask, parseStoryboardTask, storyboardStyleOptions } from '../storyboard/storyboard-task'
import { StoryboardTaskDialog, type StoryboardTaskDialogProps } from './StoryboardTaskDialog'
import { addStoryboardTaskReference, removeStoryboardTaskReference, moveStoryboardTaskReference, buildStoryboardTaskSubmission, chooseStoryboardTaskAsset, initialStoryboardAnalysis, initialStoryboardGeneration, storyboardTaskDraftKey, storyboardTaskFromRoute, storyboardTaskReferences, type StoryboardTaskForm } from './storyboard-task-ui'

function image(id = 'a'.repeat(43)): CanvasImageAssetSummary { return { assetId: id, mediaType: 'image', localUrl: `xingmang-asset://image/${id}`, thumbnailUrl: `xingmang-asset://thumb/v2/image/${id}`, mimeType: 'image/png', fileName: '故事原图.png', createdAt: '2026-10-18T00:00:00Z', width: 640, height: 480 } }
function form(): StoryboardTaskForm {
  const task = defaultStoryboardTask()
  return { task, references: chooseStoryboardTaskAsset(storyboardTaskReferences(task, []), 0, image()), prompt: '小猫在雨中找到回家的路', generation: initialStoryboardGeneration({ model: 'gpt-image-2', imageCandidateCount: 2 }), analysis: { model: 'gpt-4.1-mini' } }
}
function props(value = form()): StoryboardTaskDialogProps { return { mode: 'create', scopeKey: 'owner:project', isCurrent: () => true, initialTask: value.task, initialReferences: value.references, initialPrompt: value.prompt, initialGeneration: value.generation, initialAnalysis: value.analysis, assets: { items: [], total: 0, offset: 0, limit: 24, hasMore: false, facets: { tags: [] } }, imageModels: [{ id: 'gpt-image-2', label: 'GPT Image 2' }], textModels: [{ id: 'gpt-4.1-mini', label: 'GPT 4.1 mini' }], onPickAsset: vi.fn(async () => null), onApply: vi.fn(async () => {}), onClose: vi.fn() } }

describe('storyboard creation form and SSR', () => {
  it('routes only the explicit storyboard request and preserves intentional empty model fields', () => {
    expect(storyboardTaskFromRoute('storyboard')).toEqual(defaultStoryboardTask())
    for (const value of ['frame-extract', 'storyboard-video', '', null, undefined, {}]) expect(storyboardTaskFromRoute(value)).toBeNull()
    expect(initialStoryboardGeneration({ model: '' }, [{ id: 'gpt-image-2' }]).model).toBe('')
    expect(initialStoryboardAnalysis({ model: '' }, [{ id: 'gpt-4.1-mini' }]).model).toBe('')
    expect(initialStoryboardGeneration({}, [{ id: 'gpt-4.1-mini' }, { id: 'gpt-image-2' }]).model).toBe('gpt-image-2')
  })
  it('distinguishes panels per sheet from separately priced image candidates and visible vision analysis', () => {
    const value = form(); value.task = parseStoryboardTask({ ...value.task, automaticPlot: true, panels: 25 })
    const draft = buildStoryboardTaskSubmission('create', value)
    expect(draft.task.panels).toBe(25); expect(draft.imageCandidateCount).toBe(2); expect(draft.analysis).toEqual({ model: 'gpt-4.1-mini' })
    expect(draft.references).toEqual([{ role: 'source', binding: { kind: 'asset', assetId: image().assetId } }])
    const p = props(value), html = renderToStaticMarkup(createElement(StoryboardTaskDialog, p))
    for (const text of ['4 格', '9 格', '16 格', '25 格', '故事板宫格数', '故事板创作候选数量', '2 次图片请求', '每张要求 25 格', '1 次文字请求', '不会自动拆图', '查看完整创作指令']) expect(html).toContain(text)
    for (const option of storyboardStyleOptions) expect(html).toContain(option.label)
    expect(html).not.toContain('25 次图片请求'); expect(html).not.toContain('25 张图片输入')
    expect(p.onApply).not.toHaveBeenCalled(); expect(p.onPickAsset).not.toHaveBeenCalled()
  })
  it('requires explicit manual plot and removes any analysis model from manual submission', () => {
    const value = form(); value.task = { ...value.task, automaticPlot: false }; value.prompt = ''
    expect(() => buildStoryboardTaskSubmission('create', value)).toThrow('手动模式请填写剧情内容')
    const html = renderToStaticMarkup(createElement(StoryboardTaskDialog, props(value)))
    expect(html).toContain('剧情内容 · 必填'); expect(html).toContain('class="is-primary" disabled=""')
    value.prompt = '远景建立场景，中景遇到伙伴，近景发现线索，最后回家'
    const draft = buildStoryboardTaskSubmission('create', value)
    expect(draft.analysis).toBeUndefined(); expect(draft.prompt).toBe(value.prompt)
  })
  it('preserves an exact existing image occurrence on edit and rejects it on create', () => {
    const value = form(); value.references = [{ role: 'source', binding: { kind: 'existing', edgeId: 'source-edge', outputIndex: 3 } }]
    expect(buildStoryboardTaskSubmission('edit', value).references).toEqual([{ role: 'source', binding: { kind: 'existing', edgeId: 'source-edge', outputIndex: 3 } }])
    expect(() => buildStoryboardTaskSubmission('create', value)).toThrow('新建故事板')
  })
  it('rejects unavailable or mismatched images and incompatible model choices', () => {
    const value = form(); value.references[0].asset = image('b'.repeat(43))
    expect(() => buildStoryboardTaskSubmission('create', value)).toThrow('尚未核对')
    const missing = form(); missing.references[0].binding = { kind: 'missing' }
    expect(() => buildStoryboardTaskSubmission('create', missing)).toThrow('绑定输入 1')
    const wrong = form(); wrong.generation.model = 'gpt-4.1-mini'
    expect(() => buildStoryboardTaskSubmission('create', wrong)).toThrow('文字或视频模型')
    const noVision = form(); noVision.task.automaticPlot = true; noVision.analysis.model = ''
    expect(() => buildStoryboardTaskSubmission('create', noVision)).toThrow('自动剧情需要选择')
  })
  it('retains an explicit missing analysis model on edit and exposes source loading without clearing the plot', () => {
    const value = form(); value.task.automaticPlot = true
    const p = props(value), html = renderToStaticMarkup(createElement(StoryboardTaskDialog, { ...p, mode: 'edit', initialAnalysis: { model: '' } }))
    expect(html).toContain('value=""'); expect(html).toContain('请选择已支持图片理解'); expect(html).toContain('原有候选保留')
    const loading = renderToStaticMarkup(createElement(StoryboardTaskDialog, { ...p, sourceLoading: true, imageModels: [], textModels: [], imageSources: [{ id: 'image-source', label: '图像来源' }], textSources: [{ id: 'text-source', label: '文字来源' }] }))
    expect(loading).toContain(value.prompt); expect(loading).toContain('正在读取模型来源'); expect(loading).toContain('class="is-primary" disabled=""')
    expect(loading).toContain('故事板创作图像来源'); expect(loading).toContain('故事板自动剧情文字来源')
  })
  it('tracks task, input occurrence, plot and active analysis edits while ignoring inactive analysis configuration', () => {
    const value = form(), key = storyboardTaskDraftKey(value)
    expect(storyboardTaskDraftKey({ ...value, task: { ...value.task, panels: value.task.panels === 4 ? 9 : 4 } })).not.toBe(key)
    expect(storyboardTaskDraftKey({ ...value, prompt: `${value.prompt}。` })).not.toBe(key)
    const manual = { ...value, task: { ...value.task, automaticPlot: false } }
    expect(storyboardTaskDraftKey({ ...manual, analysis: { model: 'other-model' } })).toBe(storyboardTaskDraftKey(manual))
    const automatic = { ...value, task: { ...value.task, automaticPlot: true } }
    expect(storyboardTaskDraftKey({ ...automatic, analysis: { model: 'gpt-4.1' } })).not.toBe(storyboardTaskDraftKey(automatic))
  })
  it('preserves four ordered slots, missing placeholders and stable repeated reference roles through reorder/remove', () => {
    const value = form()
    for (const id of ['b', 'c', 'd']) { value.references = addStoryboardTaskReference(value.references); value.references = chooseStoryboardTaskAsset(value.references, value.references.length - 1, image(id.repeat(43))) }
    expect(value.references.map((entry) => entry.role)).toEqual(['source', 'reference', 'reference', 'reference'])
    expect(() => addStoryboardTaskReference(value.references)).toThrow('最多支持 4')
    const reordered = moveStoryboardTaskReference(value.references, 2, -1)
    expect(reordered.map((entry) => entry.asset?.assetId)).toEqual(['a', 'c', 'b', 'd'].map((id) => id.repeat(43)))
    value.references = removeStoryboardTaskReference(reordered, 0)
    expect(value.references.map((entry) => entry.role)).toEqual(['source', 'reference', 'reference'])
    expect(buildStoryboardTaskSubmission('create', value).references.map((entry) => entry.binding)).toEqual(['c', 'b', 'd'].map((id) => ({ kind: 'asset', assetId: id.repeat(43) })))
    expect(() => chooseStoryboardTaskAsset(value.references, 1, image('c'.repeat(43)))).toThrow('不能重复')
    value.references = addStoryboardTaskReference(value.references)
    expect(() => buildStoryboardTaskSubmission('create', value)).toThrow('绑定输入 4')
    expect(storyboardTaskReferences(value.task, value.references)).toHaveLength(4)
  })
  it('rejects duplicate existing occurrences without silently rebinding a missing slot', () => {
    const value = form(); value.references = [{ role: 'source', binding: { kind: 'existing', edgeId: 'edge', outputIndex: 0 } }, { role: 'reference', binding: { kind: 'existing', edgeId: 'edge', outputIndex: 0 } }]
    expect(() => buildStoryboardTaskSubmission('edit', value)).toThrow('同一连线位置')
    value.references[1] = { role: 'reference', binding: { kind: 'missing' } }
    expect(() => buildStoryboardTaskSubmission('edit', value)).toThrow('绑定输入 2')
  })

})
