import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowNodeData } from '../model'
import { VideoParameterFields } from './VideoParameterFields'
interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(tree: unknown): ElementShape[] {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return []
  const element = tree as ElementShape
  return [element, ...elements(element.props.children)]
}
function fixture(model = 'minimax-h3-mini', data: Partial<WorkflowNodeData> = {}, disabled = false) {
  const onChange = vi.fn(), onReset = vi.fn(), props = { model, data: { prompt: '已保存的完整提示词', model, status: 'idle' as const, ...data }, disabled, onChange, onReset }
  return { props, onChange, onReset, tree: VideoParameterFields(props), html: () => renderToStaticMarkup(createElement(VideoParameterFields, props)) }
}
function select(tree: unknown, label: string) { const found = elements(tree).find((element) => element.type === 'select' && element.props['aria-label'] === label); if (!found) throw new Error(`Missing ${label}`); return found }

describe('actual video parameter fields', () => {
  it('renders exactly one set of model-specific parameters and every supported duration', () => {
    const minimax = fixture(), grok = fixture('grok-imagine-video')
    expect(elements(minimax.tree).filter((element) => element.type === 'select')).toHaveLength(4)
    expect(elements(grok.tree).filter((element) => element.type === 'select')).toHaveLength(2)
    expect(elements(select(minimax.tree, '视频时长')).filter((element) => element.type === 'option').map((element) => element.props.value)).toEqual(Array.from({ length: 11 }, (_, index) => String(index + 5)))
    expect(elements(select(grok.tree, '视频时长')).filter((element) => element.type === 'option').map((element) => element.props.value)).toEqual(Array.from({ length: 15 }, (_, index) => String(index + 1)))
    expect(grok.html()).not.toContain('MiniMax 生成模式'); expect(minimax.html()).not.toContain('aria-label="视频比例"')
  })
  it('preserves invalid saved options and offers a separate explicit reset', () => {
    const f = fixture('minimax-h3-mini', { seconds: '2', settings: { videoMode: 'old-mode', videoResolution: '1080p', videoAspectRatio: '7:9' } })
    for (const [label, expected] of [['视频时长', '2'], ['MiniMax 生成模式', 'old-mode'], ['MiniMax 视频分辨率', '1080p'], ['MiniMax 视频比例', '7:9']]) {
      const field = select(f.tree, label); expect(field.props.value).toBe(expected)
      expect(elements(field).find((element) => element.type === 'option' && element.props.value === expected)?.props.disabled).toBe(true)
    }
    const html = f.html(); expect(html).toContain('已保存，当前不支持'); expect(html).toContain('按当前模型重置视频参数'); expect(f.onReset).not.toHaveBeenCalled(); expect(f.onChange).not.toHaveBeenCalled()
    const reset = elements(f.tree).find((element) => element.type === 'button')!
    ;(reset.props.onClick as () => void)(); expect(f.onReset).toHaveBeenCalledOnce(); expect(f.onChange).not.toHaveBeenCalled()
  })
  it('does not fabricate Grok controls or an automatic reset for an unknown model', () => {
    const f = fixture('future-unverified-video', { seconds: '8', size: '2048x1152', settings: { videoMode: 'fl2va' } })
    expect(elements(f.tree).filter((element) => element.type === 'select')).toHaveLength(0)
    expect(f.html()).toContain('中转请求协议尚未接通'); expect(f.html()).not.toContain('按当前模型重置')
    expect(f.html()).toContain('已保存的视频参数'); expect(f.html()).toContain('2048x1152'); expect(f.html()).toContain('fl2va')
    expect(f.onChange).not.toHaveBeenCalled(); expect(f.onReset).not.toHaveBeenCalled()
  })
  it('dispatches only the chosen field and leaves all other saved values intact', () => {
    const f = fixture(), before = structuredClone(f.props.data)
    ;(select(f.tree, 'MiniMax 生成模式').props.onChange as (event: unknown) => void)({ target: { value: 'fl2va' } })
    ;(select(f.tree, '视频时长').props.onChange as (event: unknown) => void)({ target: { value: '9' } })
    const toggle = elements(f.tree).find((element) => element.type === 'input')!
    ;(toggle.props.onChange as (event: unknown) => void)({ target: { checked: true } })
    expect(f.onChange.mock.calls).toEqual([[{ videoMode: 'fl2va' }], [{ seconds: '9' }], [{ promptOptimization: true }]])
    expect(f.props.data).toEqual(before)
  })
  it('disables every editable field and reset when editing is unavailable', () => {
    const f = fixture('minimax-h3-mini', { seconds: '2', settings: { videoResolution: '1080p' } }, true)
    const controls = elements(f.tree).filter((element) => ['select', 'input', 'button'].includes(String(element.type)))
    expect(controls.length).toBeGreaterThan(4); expect(controls.every((element) => element.props.disabled === true)).toBe(true)
  })
  it('does not replace a saved Grok size with a visually valid default', () => {
    const f = fixture('grok-imagine-video', { size: '1920x1080' }), field = select(f.tree, '视频比例')
    expect(field.props.value).toBe('1920x1080'); expect(f.html()).toContain('1920x1080（已保存，当前不支持）')
    expect(f.onChange).not.toHaveBeenCalled()
  })
  it('shows every inactive saved value before an explicit model reset', () => {
    const f = fixture('grok-imagine-video', { seconds: '8', size: '1280x720', settings: { videoMode: 'fl2va', videoResolution: '480p', videoAspectRatio: '9:16', promptOptimization: true } })
    const html = f.html()
    expect(html).toContain('已保存的视频参数')
    for (const value of ['fl2va', '480p', '9:16', '开启', '1280x720']) expect(html).toContain(value)
    expect(html).toContain('将重置：'); expect(f.onReset).not.toHaveBeenCalled()
    expect(elements(f.tree).filter((element) => element.type === 'select')).toHaveLength(2)
  })
  it('changes independent task count without resetting model parameters or fabricating prices', () => {
    const f = fixture('minimax-h3-mini', { videoCandidateCount: 3, settings: { videoMode: 'fl2va' } }), onCandidateCountChange = vi.fn()
    const props = { ...f.props, onCandidateCountChange }, tree = VideoParameterFields(props), field = select(tree, '视频生成数量')
    expect(field.props.value).toBe(3)
    expect(elements(field).filter((element) => element.type === 'option').map((element) => element.props.value)).toEqual([1, 2, 3, 4])
    ;(field.props.onChange as (event: unknown) => void)({ target: { value: '4' } })
    expect(onCandidateCountChange).toHaveBeenCalledExactlyOnceWith(4)
    expect(f.onChange).not.toHaveBeenCalled(); expect(f.onReset).not.toHaveBeenCalled()
    const html = renderToStaticMarkup(createElement(VideoParameterFields, props))
    expect(html).toContain('最多依次提交 3 个独立视频任务，按次计费；具体金额以所选服务为准')
    expect(html).not.toContain('积分'); expect(html).not.toContain('免费')
  })
  it('guards task count changes while locked or running even when called directly', () => {
    const f = fixture('grok-imagine-video', {}, true), onCandidateCountChange = vi.fn()
    const field = select(VideoParameterFields({ ...f.props, onCandidateCountChange }), '视频生成数量')
    expect(field.props.value).toBe(1); expect(field.props.disabled).toBe(true)
    ;(field.props.onChange as (event: unknown) => void)({ target: { value: '4' } })
    expect(onCandidateCountChange).not.toHaveBeenCalled()
  })
})


function render(model: string, settings: Record<string, unknown> = {}, native = true, imageCount = 0, disabled = false) {
  const data: WorkflowNodeData = { model, prompt: '', status: 'idle', settings }
  return renderToStaticMarkup(createElement(VideoParameterFields, { model, data, videoProtocol: native ? 'xai-native' : 'relay-videos', imageCount, disabled, onChange() {}, onReset() {} }))
}

describe('native video parameter controls', () => {
  it('exposes explicit audio choices and preserves the silent selection', () => {
    const html = render('grok-imagine-video-1.5', { generateAudio: false })
    expect(html).toContain('aria-label="生成音频"')
    expect(html).toMatch(/aria-pressed="true"[^>]*>关闭<\/button>/)
    expect(html).toContain('将明确请求无声视频')
    expect(html).toContain('value="1080p"')
    expect(html).toContain('value="5:2"')
    expect(render('grok-imagine-video')).not.toContain('value="1080p"')
    expect(render('grok-imagine-video-1.5-lite')).toContain('1080p · 升采样')
  })
  it('uses the input aspect ratio and explains incompatible retained values', () => {
    const html = render('grok-imagine-video-1.5', { videoAspectRatio: '9:16' }, true, 1)
    expect(html).toContain('跟随首帧图片')
    expect(html).not.toContain('aria-label="xAI 视频比例"')
    expect(html).toContain('显式视频比例不会生效')
    expect(html).toContain('按当前模型重置视频参数')
  })
  it('does not pretend a relay supports audio and disables native changes while running', () => {
    const relay = render('grok-imagine-video', { generateAudio: false }, false)
    expect(relay).not.toContain('role="group" aria-label="生成音频"')
    expect(relay).toContain('已保留原设置')
    expect(relay).toContain('生成音频开关')
    const locked = render('grok-imagine-video-1.5', {}, true, 0, true)
    expect(locked).toMatch(/aria-pressed="true" disabled=""[^>]*>默认/)
  })
})

function arkFixture(data: Partial<WorkflowNodeData> = {}, disabled = false) {
  const f = fixture('doubao-seedance-2-0-mini-260615', data, disabled)
  const props = { ...f.props, videoProtocol: 'ark-seedance' as const }
  return { ...f, props, tree: VideoParameterFields(props), html: () => renderToStaticMarkup(createElement(VideoParameterFields, props)) }
}

describe('Ark Seedance parameter callbacks', () => {
  it('offers only verified modes, durations and resolutions with adaptive dimensions', () => {
    const f = arkFixture()
    function values(label: string) { return elements(select(f.tree, label)).filter((e) => e.type === 'option').map((e) => e.props.value) }
    expect(values('Seedance 生成模式')).toEqual(['auto', 't2va', 'i2va', 'fl2va', 'ref2va'])
    expect(values('Seedance 视频分辨率')).toEqual(['480p', '720p'])
    expect(values('Seedance 视频比例')).toEqual(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'])
    expect(values('视频时长')).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 4)))
    expect(select(f.tree, 'Seedance 视频比例').props.value).toBe('adaptive')
    expect(select(f.tree, '视频时长').props.value).toBe('5')
    expect(f.html()).not.toContain('优化提示词</span>')
    expect(f.html()).toContain('65 分钟')
    expect(f.onChange).not.toHaveBeenCalled()
  })
  it('patches only explicit choices, clears stale fixed dimensions on ratio change, and preserves false audio', () => {
    const f = arkFixture({ size: '1280x720' }), before = structuredClone(f.props.data)
    for (const [label, value] of [['Seedance 生成模式', 'ref2va'], ['Seedance 视频分辨率', '480p'], ['Seedance 视频比例', '9:16'], ['视频时长', '15']]) {
      ;(select(f.tree, label).props.onChange as (event: unknown) => void)({ target: { value } })
    }
    const off = elements(f.tree).find((e) => e.type === 'button' && e.props.children === '关闭')!
    ;(off.props.onClick as () => void)()
    expect(f.onChange.mock.calls).toEqual([[{ videoMode: 'ref2va' }], [{ videoResolution: '480p' }], [{ videoAspectRatio: '9:16', size: 'auto' }], [{ seconds: '15' }], [{ generateAudio: false }]])
    expect(f.props.data).toEqual(before)
  })
  it('keeps unsupported saved values visible until explicit reset and never changes data while locked', () => {
    const f = arkFixture({ seconds: '2', settings: { videoMode: 'l2va', videoResolution: '1080p', promptOptimization: true, generateAudio: false } }, true)
    expect(select(f.tree, 'Seedance 生成模式').props.value).toBe('l2va')
    expect(f.html()).toContain('已保存，当前不支持')
    expect(f.html()).toContain('提示词优化')
    for (const field of elements(f.tree).filter((e) => e.type === 'select')) {
      expect(field.props.disabled).toBe(true)
      ;(field.props.onChange as (event: unknown) => void)({ target: { value: 'auto' } })
    }
    for (const audio of elements(f.tree).filter((e) => e.type === 'button' && ['默认', '开启', '关闭'].includes(String(e.props.children)))) {
      expect(audio.props.disabled).toBe(true)
      ;(audio.props.onClick as () => void)()
    }
    expect(f.onChange).not.toHaveBeenCalled()
  })
  it('does not invent native controls for an unverified Seedance alias or use Grok controls', () => {
    const f = fixture('seedance-2-mini')
    for (const videoProtocol of ['relay-videos', 'ark-seedance'] as const) {
      const tree = VideoParameterFields({ ...f.props, videoProtocol })
      expect(elements(tree).filter((e) => e.type === 'select')).toHaveLength(0)
    }
  })
})
