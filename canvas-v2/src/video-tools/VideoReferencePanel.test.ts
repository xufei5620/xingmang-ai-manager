import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: (initial: unknown) => [initial, vi.fn()] }))
import { VideoReferencePanel, type VideoReferencePanelProps } from './VideoReferencePanel'
import type { UpstreamMediaReference } from '../components/upstream-references'
interface ElementShape { type: unknown; key?: string; props: Record<string, unknown> }
function elements(tree: unknown): ElementShape[] {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return []
  const element = tree as ElementShape
  return [element, ...elements(element.props.children)]
}
function reference(edgeId: string, kind: 'image' | 'audio' | 'video' = 'image', changes: Partial<UpstreamMediaReference> = {}): UpstreamMediaReference {
  return { edgeId, outputIndex: 0, sourceNodeId: edgeId, kind, label: `${edgeId}素材`, mention: `@${edgeId}`, relationLabel: kind === 'image' ? '图像输入' : kind === 'audio' ? '音频输入' : '视频输入', status: 'ready', asset: { kind, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://${kind}/${'a'.repeat(43)}` }, ...changes }
}
function fixture(overrides: Partial<VideoReferencePanelProps> = {}): VideoReferencePanelProps { return { model: 'minimax-h3-mini', references: [reference('a'), reference('b')], onOrderChange: vi.fn(), ...overrides } }
function button(tree: unknown, label: string) { const found = elements(tree).find((element) => element.type === 'button' && (element.props['aria-label'] === label || element.props.title === label)); if (!found) throw new Error(`Missing button ${label}`); return found }
function call(element: ElementShape, eventName: string, event: unknown = {}) { (element.props[eventName] as (event: unknown) => void)(event) }

describe('video reference panel', () => {
  it('takes no order on a host without explicit order, by click or keyboard', () => {
    const reason = '当前客户端不支持调整素材顺序'
    const swap = fixture({ reorderUnavailableReason: reason }), swapTree = VideoReferencePanel(swap)
    expect(button(swapTree, reason).props.disabled).toBe(true)
    call(button(swapTree, reason), 'onClick')
    const keyed = fixture({ reorderUnavailableReason: reason, references: [reference('a'), reference('sound', 'audio'), reference('b')] })
    const row = elements(VideoReferencePanel(keyed)).find((element) => element.type === 'article')!
    call(row, 'onKeyDown', { key: 'ArrowDown', altKey: true, nativeEvent: {}, preventDefault: vi.fn(), stopPropagation: vi.fn() })
    expect(swap.onOrderChange).not.toHaveBeenCalled()
    expect(keyed.onOrderChange).not.toHaveBeenCalled()
  })
  it('shows adjacent role cards and applies a single versioned swap with stable item keys', () => {
    const props = fixture(), tree = VideoReferencePanel(props), articles = elements(tree).filter((element) => element.type === 'article')
    expect(articles.map((item) => item.props['aria-label'])).toEqual(['首帧：a素材', '尾帧：b素材'])
    call(button(tree, '调换首尾帧'), 'onClick')
    expect(props.onOrderChange).toHaveBeenCalledExactlyOnceWith({ version: 1, slots: [{ edgeId: 'b', outputIndex: 0 }, { edgeId: 'a', outputIndex: 0 }] })
    props.order = { version: 1, slots: [{ edgeId: 'b', outputIndex: 0 }, { edgeId: 'a', outputIndex: 0 }] }
    const reordered = elements(VideoReferencePanel(props)).filter((item) => item.type === 'article')
    expect(reordered.map((item) => item.key)).toEqual(articles.map((item) => item.key).reverse())
  })
  it('supports keyboard ordering without bubbling to canvas and ignores IME or system chords', () => {
    const props = fixture({ references: [reference('a'), reference('sound', 'audio'), reference('b')] }), tree = VideoReferencePanel(props), row = elements(tree).find((element) => element.type === 'article')!
    function key(event: Record<string, unknown>) { const value = { key: 'ArrowDown', altKey: true, nativeEvent: {}, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...event }; call(row, 'onKeyDown', value); return value }
    key({ nativeEvent: { isComposing: true } }); key({ nativeEvent: { keyCode: 229 } }); key({ metaKey: true }); key({ altKey: false })
    expect(props.onOrderChange).not.toHaveBeenCalled()
    const moved = key({}); expect(moved.stopPropagation).toHaveBeenCalled(); expect(moved.preventDefault).toHaveBeenCalled()
    expect(props.onOrderChange).toHaveBeenCalledExactlyOnceWith({ version: 1, slots: [{ edgeId: 'sound', outputIndex: 0 }, { edgeId: 'a', outputIndex: 0 }, { edgeId: 'b', outputIndex: 0 }] })
    const section = elements(tree).find((element) => element.type === 'section')!, stopPropagation = vi.fn()
    call(section, 'onKeyDown', { key: 'Backspace', stopPropagation }); expect(stopPropagation).toHaveBeenCalledOnce()
  })
  it('disables unsupported swaps and all mutation callbacks while locked', () => {
    const props = fixture({ disabled: true, disabledReason: '运行中，请稍后修改', onRemove: vi.fn() }), tree = VideoReferencePanel(props), swap = button(tree, '运行中，请稍后修改')
    expect(swap.props.disabled).toBe(true); call(swap, 'onClick')
    call(button(tree, '移除a素材'), 'onClick')
    const row = elements(tree).find((element) => element.type === 'article')!
    call(row, 'onKeyDown', { key: 'ArrowDown', altKey: true, nativeEvent: {}, preventDefault: vi.fn(), stopPropagation: vi.fn() })
    expect(props.onOrderChange).not.toHaveBeenCalled(); expect(props.onRemove).not.toHaveBeenCalled()
    const dynamic = VideoReferencePanel(fixture({ videoMode: 'fl2va', references: [reference('batch', 'image', { batch: true, status: 'waiting', asset: undefined })] }))
    expect(elements(dynamic).find((item) => item.props.className === 'video-reference-swap')?.props.disabled).toBe(true)
  })
  it('previews only ready references and removes a batch through its edge with an explicit whole-group label', () => {
    const ready = reference('batch', 'image', { batch: true, batchSize: 2 }), onPreview = vi.fn(), onRemove = vi.fn(), props = fixture({ references: [ready, reference('b', 'image', { status: 'waiting', asset: undefined })], onPreview, onRemove }), tree = VideoReferencePanel(props)
    call(button(tree, '预览首帧：batch素材'), 'onClick'); expect(onPreview).toHaveBeenCalledExactlyOnceWith(ready)
    const waiting = button(tree, '预览尾帧：b素材'); expect(waiting.props.disabled).toBe(true); call(waiting, 'onClick'); expect(onPreview).toHaveBeenCalledOnce()
    call(button(tree, '移除整组输入（2 张）：batch素材'), 'onClick'); expect(onRemove).toHaveBeenCalledExactlyOnceWith('batch')
  })
  it('requires explicit removal of a missing slot and does not mutate simply by rendering', () => {
    const props = fixture({ videoMode: 'fl2va', references: [reference('b')], order: { version: 1, slots: [{ edgeId: 'a', outputIndex: 0 }, { edgeId: 'b', outputIndex: 0 }] } }), tree = VideoReferencePanel(props)
    expect(props.onOrderChange).not.toHaveBeenCalled(); expect(elements(tree).some((item) => item.props['aria-label'] === '尾帧：b素材')).toBe(true)
    call(button(tree, '移除失效位置：首帧'), 'onClick')
    expect(props.onOrderChange).toHaveBeenCalledExactlyOnceWith({ version: 1, slots: [{ edgeId: 'b', outputIndex: 0 }] })
  })
  it('renders escaped names, local image previews and readable status without exposing identities', () => {
    const props = fixture({ references: [reference('secret-edge', 'image', { label: '<script>alert(1)</script>' }), reference('b')], onPreview: vi.fn() })
    const markup = renderToStaticMarkup(createElement(VideoReferencePanel, props))
    expect(markup).toContain('&lt;script&gt;'); expect(markup).not.toContain('<script>'); expect(markup).not.toContain('secret-edge')
    expect(markup).toContain('首帧'); expect(markup).toContain('尾帧'); expect(markup).toContain('aria-live="polite"')
    expect(markup).not.toContain('<video'); expect(markup).not.toContain('<audio')
  })
})


describe('Ark mixed-media reference callbacks', () => {
  it('previews owned video and audio through the host callback without embedding playback URLs', () => {
    const video = reference('v', 'video'), audio = reference('a', 'audio'), onPreview = vi.fn()
    const props = fixture({ model: 'doubao-seedance-2-0-mini-260615', videoProtocol: 'ark-seedance', references: [video, audio, reference('i')], onPreview })
    const tree = VideoReferencePanel(props)
    call(button(tree, '预览参考视频 1：v素材'), 'onClick')
    call(button(tree, '预览参考音频 1：a素材'), 'onClick')
    expect(onPreview.mock.calls).toEqual([[video], [audio]])
    call(button(tree, '后移参考视频 1：v素材'), 'onClick')
    expect(props.onOrderChange).toHaveBeenCalledExactlyOnceWith({ version: 1, slots: [{ edgeId: 'a', outputIndex: 0 }, { edgeId: 'v', outputIndex: 0 }, { edgeId: 'i', outputIndex: 0 }] })
    const html = renderToStaticMarkup(createElement(VideoReferencePanel, props))
    expect(html).toContain('本站总数上限 12 项')
    expect(html).not.toContain('不支持参考视频')
    expect(html).not.toContain('xingmang-asset://video/')
    expect(html).not.toContain('xingmang-asset://audio/')
  })
})
