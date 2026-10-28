import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defaultExteriorTask } from '../exterior/exterior-task'
import type { UpstreamMediaReference } from './upstream-references'
import { ExteriorTaskControls, inspectExteriorTaskControls } from './ExteriorTaskControls'

function reference(edgeId: string, id = 'a'.repeat(43)): UpstreamMediaReference { return { edgeId, outputIndex: 0, sourceNodeId: edgeId + '-node', targetHandle: 'in:images', kind: 'image', label: edgeId, mention: '@图', relationLabel: '图像输入', status: 'ready', asset: { kind: 'image', assetId: id, localUrl: `xingmang-asset://image/${id}` } } }
function settings(automatic = false): Record<string, unknown> { return { exteriorTask: defaultExteriorTask(automatic ? 'landscape-redesign' : 'exterior-render'), imageReferenceOrder: { version: 1, slots: automatic ? [{ role: 'source', edgeId: 'original', outputIndex: 0 }, { role: 'reference', edgeId: 'reference', outputIndex: 0 }] : [{ role: 'source', edgeId: 'original', outputIndex: 0 }] } } }

describe('exterior task node controls', () => {
  it('shows exact role readiness and refuses to relabel new or missing image edges', () => {
    const value = settings(true), refs = [reference('original'), reference('reference', 'b'.repeat(43))]
    expect(inspectExteriorTaskControls(value, refs, '').sources.map((source) => [source.role, source.state])).toEqual([['source', 'ready'], ['reference', 'ready']])
    expect(inspectExteriorTaskControls(value, [refs[0]], '').sources[1].state).toBe('missing')
    expect(inspectExteriorTaskControls(value, [...refs, reference('new', 'c'.repeat(43))], '').error).toContain('尚未分配角色')
    expect(inspectExteriorTaskControls(value, [refs[0], { ...refs[1], status: 'waiting', asset: undefined }], '').sources[1].state).toBe('waiting')
  })
  it('detects duplicate actual images and conflicting task envelopes', () => {
    expect(inspectExteriorTaskControls(settings(true), [reference('original'), reference('reference')], '').error).toContain('不同的实际图片')
    expect(inspectExteriorTaskControls({ ...settings(), interiorTask: {} }, [reference('original')], '').error).toContain('不能同时配置')
    expect(inspectExteriorTaskControls({ exteriorTask: defaultExteriorTask('exterior-render') }, [reference('original')], '').error).toContain('明确绑定')
  })
  it('keeps result comparison available only for actual multiple results with an action', () => {
    const props = { settings: settings(), references: [reference('original')], prompt: '保留原图', requestCandidateCount: 4, onEdit() {}, onCompare() {} }
    const two = renderToStaticMarkup(createElement(ExteriorTaskControls, { ...props, candidateCount: 2 }))
    expect(two).toContain('配置室外任务'); expect(two).toContain('对比室外候选（2 张）'); expect(two).toContain('4 次图片请求')
    expect(two).toContain('保留原图'); expect(two).toContain('当前节点的室外创作指令')
    expect(renderToStaticMarkup(createElement(ExteriorTaskControls, { ...props, candidateCount: 1 }))).not.toContain('对比室外候选')
    expect(renderToStaticMarkup(createElement(ExteriorTaskControls, { ...props, candidateCount: 2, onCompare: undefined }))).not.toContain('对比室外候选')
  })
  it('discloses the separate automatic analysis request and keeps inherited nodes untouched', () => {
    const props = { references: [reference('original'), reference('reference', 'b'.repeat(43))], prompt: '', candidateCount: 2 }
    const html = renderToStaticMarkup(createElement(ExteriorTaskControls, { ...props, settings: settings(true) }))
    expect(html).toContain('独立图片分析文字节点'); expect(html).toContain('+ 1 次文字请求'); expect(html).toContain('分析两张')
    expect(renderToStaticMarkup(createElement(ExteriorTaskControls, props))).toBe('')
  })
})
