import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defaultStoryboardTask } from '../storyboard/storyboard-task'
import type { UpstreamMediaReference } from './upstream-references'
import { StoryboardTaskControls, inspectStoryboardTaskControls } from './StoryboardTaskControls'

function reference(edgeId: string, id = 'a'.repeat(43)): UpstreamMediaReference { return { edgeId, outputIndex: 0, sourceNodeId: `${edgeId}-node`, targetHandle: 'in:images', kind: 'image', label: edgeId, mention: '@图', relationLabel: '图像输入', status: 'ready', asset: { kind: 'image', assetId: id, localUrl: `xingmang-asset://image/${id}` } } }
function settings(count = 1, automaticPlot = true): Record<string, unknown> { return { storyboardTask: { ...defaultStoryboardTask(), automaticPlot, panels: 25 }, imageReferenceOrder: { version: 1, slots: Array.from({ length: count }, (_, index) => ({ role: index === 0 ? 'source' : 'reference', edgeId: `image-${index}`, outputIndex: 0 })) } } }

describe('storyboard node configuration controls', () => {
  it('preserves the exact ordered four image positions and reports lost/new references without silent replacement', () => {
    const config = settings(4), refs = ['a', 'b', 'c', 'd'].map((id, index) => reference(`image-${index}`, id.repeat(43)))
    expect(inspectStoryboardTaskControls(config, refs, '').sources.map((entry) => entry.state)).toEqual(['ready', 'ready', 'ready', 'ready'])
    expect(inspectStoryboardTaskControls(config, [refs[0], refs[2], refs[3]], '').sources.map((entry) => entry.state)).toEqual(['ready', 'missing', 'ready', 'ready'])
    expect(inspectStoryboardTaskControls(config, [...refs, reference('unassigned', 'e'.repeat(43))], '').error).toContain('尚未分配位置')
    expect(inspectStoryboardTaskControls(config, [refs[0], { ...refs[1], status: 'waiting', asset: undefined }, refs[2], refs[3]], '').sources[1].state).toBe('waiting')
  })
  it('rejects duplicate actual assets, missing role contracts and conflicting tasks', () => {
    expect(inspectStoryboardTaskControls(settings(2), [reference('image-0'), reference('image-1')], '').error).toContain('重复使用')
    expect(inspectStoryboardTaskControls({ ...settings(), exteriorTask: {} }, [reference('image-0')], '').error).toContain('不能同时配置')
    expect(inspectStoryboardTaskControls({ storyboardTask: defaultStoryboardTask() }, [reference('image-0')], '').error).toContain('1–4')
    expect(inspectStoryboardTaskControls(settings(1, false), [reference('image-0')], '').error).toContain('剧情为空')
  })
  it('displays separate image and text request counts instead of multiplying by the panel layout', () => {
    const html = renderToStaticMarkup(createElement(StoryboardTaskControls, { settings: settings(2), references: [reference('image-0'), reference('image-1', 'b'.repeat(43))], prompt: '小猫回家', requestCandidateCount: 2, candidateCount: 3, onEdit() {}, onCompare() {} }))
    for (const text of ['25 格', '5 × 5', '2 张有序输入', '2 次图片请求', '+ 1 次文字请求', '不自动拆图', '小猫回家', '配置故事板任务', '对比故事板候选（3 张）']) expect(html).toContain(text)
    expect(html).not.toContain('25 次图片请求')
    const manual = renderToStaticMarkup(createElement(StoryboardTaskControls, { settings: settings(1, false), references: [reference('image-0')], prompt: '明确的手动剧情', requestCandidateCount: 1, candidateCount: 1, onEdit() {}, onCompare() {} }))
    expect(manual).toContain('0 次文字请求'); expect(manual).not.toContain('对比故事板候选')
  })
  it('does not expose unavailable actions or render configuration on unrelated nodes', () => {
    const props = { references: [], prompt: '', candidateCount: 2 }
    expect(renderToStaticMarkup(createElement(StoryboardTaskControls, props))).toBe('')
    const locked = renderToStaticMarkup(createElement(StoryboardTaskControls, { ...props, settings: settings(), disabled: true, onEdit() {}, onCompare() {} }))
    expect(locked).toContain('disabled=""'); expect(locked).toContain('绑定已失效')
    expect(renderToStaticMarkup(createElement(StoryboardTaskControls, { ...props, settings: settings() }))).not.toContain('对比故事板候选')
  })
})
