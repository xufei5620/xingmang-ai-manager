import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { buildInteriorTaskPrompt, defaultInteriorTask } from '../interior/interior-task'
import { inspectInteriorTaskControls, InteriorTaskControls } from './InteriorTaskControls'
import type { UpstreamMediaReference } from './upstream-references'

function settings() { return { interiorTask: defaultInteriorTask(), imageReferenceOrder: { version: 1, slots: [{ role: 'source', edgeId: 'original', outputIndex: 2 }] } } }
function reference(overrides: Partial<UpstreamMediaReference> = {}): UpstreamMediaReference { return { edgeId: 'original', outputIndex: 2, sourceNodeId: 'source', kind: 'image', label: '客厅原图', mention: '@图1', relationLabel: '图像输入', status: 'ready', asset: { kind: 'image', assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }, ...overrides } }
interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type: unknown): ElementShape[] { if (Array.isArray(value)) return value.flatMap((child) => elements(child, type)); if (!value || typeof value !== 'object' || !('props' in value)) return []; const element = value as ElementShape; return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)] }

describe('interior node controls', () => {
  it('does not add controls or compiler instructions to ordinary image nodes', () => {
    expect(InteriorTaskControls({ settings: { other: true }, references: [reference()], prompt: 'ordinary' })).toBeNull()
    expect(inspectInteriorTaskControls(undefined, [reference()], 'ordinary').prompt).toBe('')
  })
  it('shows every saved option, a strictly matched batch source and the complete current supplement', () => {
    const task = { ...defaultInteriorTask(), addDecor: true, interiorLighting: true, weather: 'rainy' as const, time: 'night' as const, exterior: 'garden' as const, filter: 'film' as const }
    const saved = { ...settings(), interiorTask: task }, supplement = '保留原有木梁\n不要移动门窗 <exact>'
    const inspected = inspectInteriorTaskControls(saved, [reference({ outputIndex: 0, label: '错误的首图' }), reference()], supplement)
    expect(inspected).toMatchObject({ task, sourceState: 'ready', sourceLabel: '客厅原图 · 图片已就绪', error: '', prompt: buildInteriorTaskPrompt(task, supplement) })
    const html = renderToStaticMarkup(createElement(InteriorTaskControls, { settings: saved, references: [reference()], prompt: supplement }))
    for (const text of ['增加摆件', '增加人物', '封闭空间', '室内灯光', '开启', '未指定', '雨天', '深夜', '庭院', '复古胶片质感', '查看完整创作指令', '不要移动门窗 &lt;exact&gt;', '运行前核对']) expect(html).toContain(text)
    expect(html).toContain('<details'); expect(html).not.toContain('<details open')
  })
  it('preserves waiting and missing slots instead of falling back to another ready image', () => {
    expect(inspectInteriorTaskControls(settings(), [reference({ outputIndex: undefined, status: 'waiting', asset: undefined })], '').sourceState).toBe('waiting')
    const missing = inspectInteriorTaskControls(settings(), [reference({ edgeId: 'new-edge', label: '替代图' })], '')
    expect(missing.sourceState).toBe('missing'); expect(missing.sourceLabel).toContain('绑定已失效'); expect(missing.error).toContain('不会自动替换')
    expect(inspectInteriorTaskControls(settings(), [reference({ asset: undefined })], '').sourceLabel).toContain('素材不可用')
    expect(inspectInteriorTaskControls({ ...settings(), imageReferenceOrder: { version: 1, slots: [{ role: 'source', missing: true }] } }, [reference()], '').sourceState).toBe('missing')
  })
  it.each([
    { interiorTask: { ...defaultInteriorTask(), version: 2 } },
    { interiorTask: { ...defaultInteriorTask(), addPeople: 'true' } },
    { interiorTask: defaultInteriorTask() },
    { ...settings(), commerceTask: {} },
    { ...settings(), imageReferenceOrder: { version: 1, slots: [{ role: 'source', edgeId: 'original', outputIndex: 2 }, { role: 'reference', edgeId: 'other', outputIndex: 0 }] } },
  ])('reports malformed or conflicting configuration without throwing from render', (saved) => {
    expect(inspectInteriorTaskControls(saved, [reference()], '').error).not.toBe('')
    expect(() => renderToStaticMarkup(createElement(InteriorTaskControls, { settings: saved, references: [reference()], prompt: '' }))).not.toThrow()
  })
  it('keeps the selected source visible but warns about an unassigned extra incoming image', () => {
    const inspected = inspectInteriorTaskControls(settings(), [reference(), reference({ edgeId: 'extra' })], '')
    expect(inspected.sourceState).toBe('ready'); expect(inspected.sourceLabel).toContain('客厅原图'); expect(inspected.error).toContain('未分配为唯一原图')
  })
  it('invokes only explicit edit or comparison callbacks and suppresses both while disabled', () => {
    const onEdit = vi.fn(), onCompare = vi.fn(), props = { settings: settings(), references: [reference()], prompt: '', candidateCount: 2, onEdit, onCompare }
    const enabled = elements(InteriorTaskControls(props), 'button')
    expect(enabled).toHaveLength(2); expect(onEdit).not.toHaveBeenCalled(); expect(onCompare).not.toHaveBeenCalled()
    for (const button of enabled) (button.props.onClick as () => void)()
    expect(onEdit).toHaveBeenCalledOnce(); expect(onCompare).toHaveBeenCalledOnce()
    for (const button of elements(InteriorTaskControls({ ...props, disabled: true }), 'button')) { expect(button.props.disabled).toBe(true); (button.props.onClick as () => void)() }
    expect(onEdit).toHaveBeenCalledOnce(); expect(onCompare).toHaveBeenCalledOnce()
    expect(elements(InteriorTaskControls({ ...props, candidateCount: 1 }), 'button')).toHaveLength(1)
    expect(elements(InteriorTaskControls({ ...props, onCompare: undefined }), 'button')).toHaveLength(1)
  })
})
