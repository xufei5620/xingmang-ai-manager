import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserFrameOptions, BrowserFrameResult } from '../library/browser-frame'
const runtime = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], pending: [] as Array<() => void>, cleanups: new Map<number, () => void>(), extract: vi.fn() }))
vi.mock('react-dom', () => ({ createPortal: (tree: unknown) => tree }))
vi.mock('../library/browser-frame', () => ({ extractBrowserVideoFrame: runtime.extract }))
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return { ...actual,
    useRef(initial: unknown) { const index = runtime.cursor++; runtime.values[index] ??= { current: initial }; return runtime.values[index] },
    useState(initial: unknown) { const index = runtime.cursor++; if (!(index in runtime.values)) runtime.values[index] = typeof initial === 'function' ? initial() : initial; return [runtime.values[index], (value: unknown) => { runtime.values[index] = typeof value === 'function' ? value(runtime.values[index]) : value }] },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = runtime.cursor++, previous = runtime.values[index] as readonly unknown[] | undefined
      if (!previous || previous.length !== deps.length || deps.some((dep, i) => dep !== previous[i])) {
        runtime.values[index] = deps
        runtime.pending.push(() => { runtime.cleanups.get(index)?.(); runtime.cleanups.delete(index); const cleanup = effect(); if (cleanup) runtime.cleanups.set(index, cleanup) })
      }
    },
  }
})
import { VideoFrameEditor, type VideoFrameEditorProps } from './VideoFrameEditor'
interface ElementShape { type: unknown; props: Record<string, unknown> }
function find(tree: unknown, predicate: (element: ElementShape) => boolean): ElementShape | null {
  if (Array.isArray(tree)) { for (const child of tree) { const value = find(child, predicate); if (value) return value } return null }
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return null
  const element = tree as ElementShape
  return predicate(element) ? element : find(element.props.children, predicate)
}
function text(tree: unknown): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join('')
  return tree && typeof tree === 'object' && 'props' in tree ? text((tree as ElementShape).props.children) : ''
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {}, reject: (error: Error) => void = () => {}
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function decoded(time: number): BrowserFrameResult { return { blob: new Blob(['png'], { type: 'image/png' }), width: 640, height: 480, requestedTimestampSeconds: time, decodedTimestampSeconds: time + .01 } }
function cleanup() { for (const dispose of runtime.cleanups.values()) dispose(); runtime.cleanups.clear() }

beforeEach(() => {
  vi.useFakeTimers(); runtime.cursor = 0; runtime.values = []; runtime.pending = []; runtime.cleanups.clear(); runtime.extract.mockReset()
  runtime.extract.mockImplementation((_blob: Blob, options: BrowserFrameOptions) => Promise.resolve(decoded(options.timestampSeconds)))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function harness(overrides: Partial<VideoFrameEditorProps> = {}) {
  const blob = new Blob(['owned video'], { type: 'video/mp4' })
  const props: VideoFrameEditorProps = { asset: { assetId: 'a'.repeat(43), mediaType: 'video', mimeType: 'video/mp4', localUrl: 'untrusted-remote-url', thumbnailUrl: '', fileName: 'sample.mp4', width: 1, height: 1, durationSeconds: 1, createdAt: '', taskId: 'video-task' }, initialTimestampSeconds: 1.25, loadVideo: vi.fn().mockResolvedValue(blob), onApply: vi.fn().mockResolvedValue(undefined), onClose: vi.fn(), ...overrides }
  class Element {
    isConnected = true; focus = vi.fn(); kind = 'panel'
    querySelectorAll(): Element[] { return [] }
    getClientRects() { return [{}] }
    closest(selector: string) { return this.kind === 'input' && selector.includes('input') || this.kind === 'button' && selector.includes('button') ? this : null }
  }
  class Video extends Element { duration = 12.345; videoWidth = 640; videoHeight = 480; currentTime = 0; pause = vi.fn(); play = vi.fn().mockResolvedValue(undefined); load = vi.fn(); removeAttribute = vi.fn() }
  const previous = new Element(), panel = new Element(), input = new Element(), button = new Element(); input.kind = 'input'; button.kind = 'button'
  vi.stubGlobal('HTMLElement', Element); vi.stubGlobal('document', { body: {}, activeElement: previous })
  let urlId = 0
  const created = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:local-${++urlId}`), revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  let tree: unknown, video: Video = new Video(), videoURL: unknown
  function render() {
    runtime.cursor = 0; tree = VideoFrameEditor(props)
    const section = find(tree, (entry) => entry.type === 'section'); if (section) (section.props.ref as { current: unknown }).current = panel
    const media = find(tree, (entry) => entry.type === 'video')
    if (media) { if (media.props.src !== videoURL) { video = new Video(); videoURL = media.props.src }; (media.props.ref as { current: unknown }).current = video }
    runtime.pending.splice(0).forEach((effect) => effect())
  }
  function element(predicate: (entry: ElementShape) => boolean) { const result = find(tree, predicate); if (!result) throw new Error('Element missing'); return result }
  function action(entry: ElementShape, name: string, event: unknown = {}) { (entry.props[name] as (event: unknown) => void)(event); render() }
  function click(label: string) { const entry = element((item) => item.type === 'button' && (item.props['aria-label'] === label || text(item.props.children) === label)); if (entry.props.disabled) throw new Error(`Disabled: ${label}`); action(entry, 'onClick') }
  function edit(value: string) { action(element((entry) => entry.props['aria-label'] === '精确抽帧时间（秒）'), 'onChange', { target: { value } }) }
  function editField(label: string, value: string) { action(element((entry) => entry.props['aria-label'] === label), 'onChange', { target: { value } }) }
  function key(key: string, modifiers: Record<string, unknown> = {}) { const event = { key, target: panel, preventDefault: vi.fn(), stopPropagation: vi.fn(), nativeEvent: {}, ...modifiers }; action(element((entry) => entry.type === 'section'), 'onKeyDown', event); return event }
  function inputKey(key: string, modifiers: Record<string, unknown> = {}) {
    const control = element((entry) => entry.props['aria-label'] === '精确抽帧时间（秒）')
    const event = { key, target: input, currentTarget: { value: control.props.value }, preventDefault: vi.fn(), stopPropagation: vi.fn(), nativeEvent: {}, ...modifiers }
    const inputHandler = control.props.onKeyDown as (event: unknown) => void
    const dialogHandler = element((entry) => entry.type === 'section').props.onKeyDown as (event: unknown) => void
    inputHandler(event); dialogHandler(event)
    render(); return event
  }
  function composition(start: boolean, value = '') { action(element((entry) => entry.props['aria-label'] === '精确抽帧时间（秒）'), start ? 'onCompositionStart' : 'onCompositionEnd', { currentTarget: { value } }) }
  function mediaEvent(name: string) { action(element((entry) => entry.type === 'video'), name, { currentTarget: video }) }
  async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); render() }
  async function tick(ms: number) { await vi.advanceTimersByTimeAsync(ms); await settle() }
  async function ready() { await settle(); mediaEvent('onLoadedMetadata'); await tick(0) }
  render(); render()
  return { props, blob, previous, input, button, panel, created, revoked, render, element, click, edit, editField, key, inputKey, composition, mediaEvent, settle, tick, ready, text: () => text(tree), video: () => video, unmount: cleanup, value: () => element((entry) => entry.props['aria-label'] === '精确抽帧时间（秒）').props.value }
}

describe('actual video frame editor callbacks', () => {
  it('decodes an owned blob using actual metadata and applies an exact draft once after confirmation', async () => {
    const save = deferred<void>(), onApply = vi.fn((_time: number, _signal: AbortSignal) => save.promise), e = harness({ onApply })
    expect(() => e.click('应用时间点')).toThrow('Disabled'); await e.ready()
    expect(e.props.loadVideo).toHaveBeenCalledWith(e.props.asset.assetId, expect.any(AbortSignal))
    expect(e.element((entry) => entry.type === 'video').props.src).toBe('blob:local-1'); expect(e.text()).toContain('640 × 480')
    expect(runtime.extract).toHaveBeenCalledWith(e.blob, expect.objectContaining({ timestampSeconds: 1.25, timeoutMs: 20_000, maxEdge: 4096 }))
    e.edit('5.1254'); expect(onApply).not.toHaveBeenCalled(); expect(() => e.click('应用时间点')).toThrow('Disabled')
    await e.tick(180); expect(e.text()).toContain('解码画面'); e.click('应用时间点'); e.key('Enter', { metaKey: true })
    expect(onApply).toHaveBeenCalledExactlyOnceWith(5.1254, expect.any(AbortSignal)); expect(e.props.onClose).not.toHaveBeenCalled()
    save.resolve(); await e.settle(); expect(e.props.onClose).toHaveBeenCalledOnce()
  })
  it('debounces scrubbing and rejects late frames from an aborted request', async () => {
    const old = deferred<BrowserFrameResult>(), current = deferred<BrowserFrameResult>()
    runtime.extract.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise)
    const e = harness(); await e.ready(); const oldSignal = runtime.extract.mock.calls[0][1].signal as AbortSignal
    e.edit('2'); e.edit('3'); expect(oldSignal.aborted).toBe(true); old.resolve(decoded(1.25)); await e.settle()
    expect(() => e.click('应用时间点')).toThrow('Disabled'); await e.tick(180)
    expect(runtime.extract).toHaveBeenCalledTimes(2); expect(runtime.extract.mock.calls[1][1].timestampSeconds).toBe(3)
    current.resolve(decoded(3)); await e.settle(); e.click('应用时间点'); await e.settle()
    expect(e.props.onApply).toHaveBeenCalledExactlyOnceWith(3, expect.any(AbortSignal))
  })
  it('cancels without submitting and frees both the source URL and decoded PNG', async () => {
    const e = harness(); await e.ready(); expect(e.created).toHaveBeenCalledTimes(2)
    e.edit('4'); await e.tick(180); expect(e.revoked).toHaveBeenCalledWith('blob:local-2')
    e.key('Escape'); expect(e.props.onClose).toHaveBeenCalledOnce(); expect(e.props.onApply).not.toHaveBeenCalled()
    e.unmount(); expect(e.revoked).toHaveBeenCalledWith('blob:local-1'); expect(e.revoked).toHaveBeenCalledWith('blob:local-3'); expect(e.previous.focus).toHaveBeenCalledOnce()
  })
  it('aborts close before reading and ignores a read that finishes after cancellation', async () => {
    const e = harness(); e.click('取消'); await e.settle(); expect(e.props.loadVideo).not.toHaveBeenCalled(); e.unmount()
    runtime.values = []; runtime.cursor = 0
    const pending = deferred<Blob>(), loadVideo = vi.fn((_id: string, _signal: AbortSignal) => pending.promise), next = harness({ loadVideo })
    await next.settle(); next.click('取消'); expect(loadVideo.mock.calls[0][1].aborted).toBe(true)
    pending.resolve(new Blob(['late'], { type: 'video/mp4' })); await next.settle(); expect(next.created).not.toHaveBeenCalled(); expect(next.props.onApply).not.toHaveBeenCalled()
  })
  it('fences an old source and cancels an in-flight apply when the asset changes', async () => {
    const pending = deferred<void>(), onApply = vi.fn((_time: number, _signal: AbortSignal) => pending.promise), e = harness({ onApply })
    await e.ready(); e.click('应用时间点'); const signal = onApply.mock.calls[0][1]
    e.props.asset = { ...e.props.asset, assetId: 'b'.repeat(43) }; e.props.initialTimestampSeconds = 2.5; e.render(); e.render(); await e.settle()
    expect(signal.aborted).toBe(true); pending.resolve(); await e.settle(); expect(e.props.onClose).not.toHaveBeenCalled()
    expect(() => e.click('应用时间点')).toThrow('Disabled'); expect(e.value()).toBe('2.5'); e.mediaEvent('onLoadedMetadata'); await e.tick(0)
    e.click('应用时间点'); await e.settle(); expect(onApply.mock.calls[1][0]).toBe(2.5)
  })
  it('reports read and metadata timeouts without allowing late metadata to enable apply', async () => {
    const pending = deferred<Blob>(), loadVideo = vi.fn((_id: string, _signal: AbortSignal) => pending.promise), e = harness({ loadVideo })
    await e.settle(); await e.tick(20_000); expect(e.text()).toContain('读取视频超时'); expect(loadVideo.mock.calls[0][1].aborted).toBe(true)
    pending.resolve(new Blob(['late'], { type: 'video/mp4' })); await e.settle(); expect(e.created).not.toHaveBeenCalled(); e.unmount()
    runtime.values = []; runtime.cursor = 0
    const next = harness(); await next.settle(); await next.tick(20_000); next.mediaEvent('onLoadedMetadata'); await next.tick(0)
    expect(next.text()).toContain('读取视频超时'); expect(runtime.extract).not.toHaveBeenCalled(); expect(() => next.click('应用时间点')).toThrow('Disabled')
  })
  it('retains decoder errors instead of replacing them with a later metadata timeout', async () => {
    const e = harness(); await e.settle(); e.mediaEvent('onError'); await e.tick(20_000)
    expect(e.text()).toContain('视频无法解码'); expect(e.text()).not.toContain('读取视频超时'); expect(() => e.click('应用时间点')).toThrow('Disabled')
    e.click('重试'); await e.ready(); expect(e.text()).toContain('画面已核对')
  })
  it('contains keyboard shortcuts, ignores IME and leaves text-field arrow movement native', async () => {
    const e = harness(); await e.ready(); e.composition(true); e.edit('2')
    const ime = e.key('Escape', { nativeEvent: { isComposing: true } }); e.key('Enter', { metaKey: true, nativeEvent: { keyCode: 229 } })
    expect(ime.stopPropagation).toHaveBeenCalled(); expect(e.props.onClose).not.toHaveBeenCalled(); expect(e.props.onApply).not.toHaveBeenCalled()
    e.composition(false, '2'); await e.tick(180); e.key('ArrowRight', { target: e.input }); expect(e.value()).toBe('2')
    const arrow = e.key('ArrowRight', { shiftKey: true }); expect(arrow.preventDefault).toHaveBeenCalled(); expect(e.value()).toBe('3')
    await e.tick(180); e.key('Enter', { ctrlKey: true }); await e.settle(); expect(e.props.onApply).toHaveBeenCalledWith(3, expect.any(AbortSignal))
  })
  it('pauses playback to decode the selected time and never enables apply on a moving preview', async () => {
    const e = harness(); await e.ready(); e.click('播放视频'); await e.settle()
    expect(e.video().play).toHaveBeenCalledOnce(); expect(() => e.click('应用时间点')).toThrow('Disabled')
    e.video().currentTime = 4.75; e.mediaEvent('onTimeUpdate'); expect(e.value()).toBe('4.75'); e.click('暂停并选择当前画面'); await e.tick(180)
    e.click('应用时间点'); await e.settle(); expect(e.props.onApply).toHaveBeenCalledWith(4.75, expect.any(AbortSignal))
  })
  it.each(['metaKey', 'ctrlKey'])('applies a confirmed time with %s Enter from inside the seconds input', async (modifier) => {
    const e = harness(); await e.ready(); const event = e.inputKey('Enter', { [modifier]: true }); await e.settle()
    expect(e.props.onApply).toHaveBeenCalledExactlyOnceWith(1.25, expect.any(AbortSignal))
    expect(event.preventDefault).toHaveBeenCalled(); expect(event.stopPropagation).toHaveBeenCalled(); expect(runtime.extract).toHaveBeenCalledOnce()
  })
  it('uses plain Enter only to recheck a typed time and ignores input composition confirmation', async () => {
    const e = harness(); await e.ready(); e.inputKey('Enter', { nativeEvent: { keyCode: 229 } }); expect(runtime.extract).toHaveBeenCalledOnce()
    e.inputKey('Enter'); expect(() => e.click('应用时间点')).toThrow('Disabled'); await e.tick(180)
    expect(runtime.extract).toHaveBeenCalledTimes(2); expect(e.props.onApply).not.toHaveBeenCalled(); expect(e.text()).toContain('画面已核对')
  })
  it('keeps invalid or failed drafts without silently clamping or claiming a save', async () => {
    const e = harness({ onApply: vi.fn().mockRejectedValue(new Error('节点输入已变化')) }); await e.ready()
    e.edit('99'); await e.tick(180); expect(e.value()).toBe('99'); expect(e.text()).toContain('时间点必须小于'); expect(runtime.extract).toHaveBeenCalledOnce()
    e.edit('2.5'); await e.tick(180); e.click('应用时间点'); await e.settle()
    expect(e.value()).toBe('2.5'); expect(e.text()).toContain('节点输入已变化'); expect(e.props.onClose).not.toHaveBeenCalled()
  })
  it('rejects non-MP4 blobs and unsupported metadata before starting extraction', async () => {
    const e = harness({ loadVideo: vi.fn().mockResolvedValue(new Blob(['bad'], { type: 'video/webm' })) }); await e.settle()
    expect(e.text()).toContain('请选择本账户可读取的 MP4'); expect(runtime.extract).not.toHaveBeenCalled(); expect(e.created).not.toHaveBeenCalled(); e.unmount()
    runtime.values = []; runtime.cursor = 0
    const next = harness(); await next.settle(); next.video().videoWidth = 8192; next.mediaEvent('onLoadedMetadata'); await next.tick(0)
    expect(next.text()).toContain('4096'); expect(runtime.extract).not.toHaveBeenCalled()
  })
})

describe('video storyboard editor callbacks', () => {
  it('initializes bounded sampling only after decoded metadata and applies a queue independent of the preview draft', async () => {
    const onApplySequence = vi.fn().mockResolvedValue(undefined), e = harness({ onApplySequence })
    expect(e.text()).toContain('创建视频分镜'); expect(e.text()).toContain('创建后会添加抽帧节点和有序拼图')
    expect(() => e.click('创建 0 帧分镜')).toThrow('Disabled'); await e.ready()
    e.edit('99'); e.click('创建 4 帧分镜'); await e.settle()
    expect(onApplySequence).toHaveBeenCalledExactlyOnceWith([0, 4.115, 8.229, 12.344], { duration: 12.345, width: 640, height: 480 }, expect.any(AbortSignal))
    expect(e.props.onApply).not.toHaveBeenCalled(); expect(e.props.onClose).toHaveBeenCalledOnce()
  })
  it('requires a decoded current frame before adding and keeps additions sorted without duplicates', async () => {
    const onApplySequence = vi.fn().mockResolvedValue(undefined), e = harness({ onApplySequence }); await e.ready()
    e.edit('6'); expect(() => e.click('加入当前画面')).toThrow('Disabled'); await e.tick(180); e.click('加入当前画面')
    expect(() => e.click('加入当前画面')).toThrow('Disabled'); e.click('预览第 3 帧，6 秒'); await e.tick(180)
    expect(e.value()).toBe('6'); e.click('创建 5 帧分镜'); await e.settle()
    expect(onApplySequence.mock.calls[0][0]).toEqual([0, 4.115, 6, 8.229, 12.344])
  })
  it('validates sampling drafts and replaces the queue only on explicit fill', async () => {
    const onApplySequence = vi.fn().mockResolvedValue(undefined), e = harness({ onApplySequence }); await e.ready()
    e.editField('等距取样帧数', '17'); expect(() => e.click('等距填入')).toThrow('Disabled'); expect(e.text()).toContain('创建 4 帧分镜')
    e.editField('等距取样帧数', '3'); e.editField('等距取样起始时间（秒）', '2'); e.editField('等距取样结束时间（秒）', '12.345')
    expect(() => e.click('等距填入')).toThrow('Disabled'); expect(e.text()).toContain('结束时间：时间点必须小于')
    e.editField('等距取样结束时间（秒）', '1'); expect(() => e.click('等距填入')).toThrow('Disabled')
    e.editField('等距取样结束时间（秒）', '8'); expect(e.text()).toContain('创建 4 帧分镜'); e.click('等距填入')
    expect(e.text()).toContain('创建 3 帧分镜'); e.click('创建 3 帧分镜'); await e.settle()
    expect(onApplySequence.mock.calls[0][0]).toEqual([2, 5, 8])
  })
  it('rejects queues below two frames and does not refill a cleared queue on duplicate metadata events', async () => {
    const onApplySequence = vi.fn().mockResolvedValue(undefined), e = harness({ onApplySequence }); await e.ready()
    for (const time of ['12.344', '8.229', '4.115']) e.click(`移除第 ${time === '12.344' ? 4 : time === '8.229' ? 3 : 2} 帧，${time} 秒`)
    expect(() => e.click('创建 1 帧分镜')).toThrow('Disabled'); e.key('Enter', { ctrlKey: true }); expect(onApplySequence).not.toHaveBeenCalled()
    e.click('移除第 1 帧，0 秒'); e.mediaEvent('onLoadedMetadata'); await e.tick(0)
    expect(e.text()).toContain('创建 0 帧分镜'); expect(() => e.click('创建 0 帧分镜')).toThrow('Disabled')
  })
  it('freezes queue actions during creation and aborts a cancelled callback without a second close', async () => {
    const pending = deferred<void>(), onApplySequence = vi.fn((_times: number[], _metadata: unknown, _signal: AbortSignal) => pending.promise), e = harness({ onApplySequence }); await e.ready()
    e.click('播放视频'); e.video().currentTime = 5; e.mediaEvent('onTimeUpdate'); e.click('创建 4 帧分镜')
    expect(e.video().pause).toHaveBeenCalled(); expect(e.element((entry) => entry.type === 'fieldset').props.disabled).toBe(true)
    expect(() => e.click('移除第 1 帧，0 秒')).toThrow('Disabled'); expect(() => e.click('等距填入')).toThrow('Disabled')
    e.key('Enter', { metaKey: true }); expect(onApplySequence).toHaveBeenCalledOnce()
    e.click('取消'); expect(onApplySequence.mock.calls[0][2].aborted).toBe(true); pending.resolve(); await e.settle()
    expect(e.props.onClose).toHaveBeenCalledOnce(); expect(e.props.onApply).not.toHaveBeenCalled()
  })
  it('fences a changed source, clears old timepoints, and retains a rejected creation for retry', async () => {
    const pending = deferred<void>(), onApplySequence = vi.fn().mockImplementationOnce(() => pending.promise).mockRejectedValueOnce(new Error('视频输入已经改变')).mockResolvedValue(undefined), e = harness({ onApplySequence }); await e.ready()
    e.click('创建 4 帧分镜'); const signal = onApplySequence.mock.calls[0][2] as AbortSignal
    e.props.asset = { ...e.props.asset, assetId: 'b'.repeat(43) }; e.render(); e.render(); await e.settle()
    expect(signal.aborted).toBe(true); pending.resolve(); await e.settle(); expect(e.props.onClose).not.toHaveBeenCalled()
    expect(() => e.click('创建 0 帧分镜')).toThrow('Disabled'); e.video().duration = 2; e.mediaEvent('onLoadedMetadata'); await e.tick(0)
    e.click('创建 4 帧分镜'); await e.settle(); expect(e.text()).toContain('视频输入已经改变'); expect(e.props.onClose).not.toHaveBeenCalled()
    e.click('创建 4 帧分镜'); await e.settle(); expect(onApplySequence.mock.calls[2][0]).toEqual([0, .666, 1.333, 1.999]); expect(e.props.onClose).toHaveBeenCalledOnce()
  })
  it('retains the edited queue and sampling draft when the same video is retried after a decoder error', async () => {
    const onApplySequence = vi.fn().mockResolvedValue(undefined), e = harness({ onApplySequence }); await e.ready()
    e.editField('等距取样帧数', '3'); e.editField('等距取样起始时间（秒）', '2'); e.editField('等距取样结束时间（秒）', '8'); e.click('等距填入')
    e.edit('5'); await e.tick(180); e.mediaEvent('onError'); expect(() => e.click('创建 3 帧分镜')).toThrow('Disabled')
    e.click('重试'); await e.ready()
    expect(e.value()).toBe('5')
    expect(e.element((entry) => entry.props['aria-label'] === '等距取样帧数').props.value).toBe('3')
    expect(e.element((entry) => entry.props['aria-label'] === '等距取样起始时间（秒）').props.value).toBe('2')
    expect(e.element((entry) => entry.props['aria-label'] === '等距取样结束时间（秒）').props.value).toBe('8')
    e.click('创建 3 帧分镜'); await e.settle(); expect(onApplySequence.mock.calls[0][0]).toEqual([2, 5, 8])
  })
  it('rejects unsupported metadata and never sends model or asset writes through the modal', async () => {
    const onApplySequence = vi.fn().mockResolvedValue(undefined), e = harness({ onApplySequence }); await e.settle()
    e.video().duration = Number.POSITIVE_INFINITY; e.mediaEvent('onLoadedMetadata'); await e.tick(0)
    expect(() => e.click('创建 0 帧分镜')).toThrow('Disabled'); expect(onApplySequence).not.toHaveBeenCalled(); expect(runtime.extract).not.toHaveBeenCalled()
    expect(e.props.onApply).not.toHaveBeenCalled(); expect(e.props.loadVideo).toHaveBeenCalledOnce()
  })
  it('caps the queue at sixteen distinct times and refuses a seventeenth current-frame addition', async () => {
    const onApplySequence = vi.fn().mockResolvedValue(undefined), e = harness({ onApplySequence }); await e.ready()
    e.editField('等距取样帧数', '16'); e.click('等距填入'); expect(() => e.click('加入当前画面')).toThrow('Disabled')
    e.click('创建 16 帧分镜'); await e.settle()
    const values = onApplySequence.mock.calls[0][0] as number[]
    expect(values).toHaveLength(16); expect(new Set(values).size).toBe(16); expect(values[0]).toBe(0); expect(values.at(-1)).toBe(12.344)
  })
  it('aborts an unfinished preview when creating prepared nodes and ignores its late decoded image', async () => {
    const preview = deferred<BrowserFrameResult>(); runtime.extract.mockImplementation(() => preview.promise)
    const onApplySequence = vi.fn().mockResolvedValue(undefined), e = harness({ onApplySequence }); await e.ready()
    const previewSignal = runtime.extract.mock.calls[0][1].signal as AbortSignal
    e.click('创建 4 帧分镜'); expect(previewSignal.aborted).toBe(true); preview.resolve(decoded(1.25)); await e.settle()
    expect(onApplySequence).toHaveBeenCalledOnce(); expect(e.created).toHaveBeenCalledOnce(); expect(e.props.onClose).toHaveBeenCalledOnce()
  })
  it('keeps keyboard focus within the sequence dialog and ignores composing submission', async () => {
    const onApplySequence = vi.fn().mockResolvedValue(undefined), e = harness({ onApplySequence }); await e.ready()
    e.panel.querySelectorAll = () => [e.input, e.button]
    vi.stubGlobal('document', { body: {}, activeElement: e.input })
    const backward = e.key('Tab', { shiftKey: true }); expect(backward.preventDefault).toHaveBeenCalled(); expect(e.button.focus).toHaveBeenCalledOnce()
    vi.stubGlobal('document', { body: {}, activeElement: e.button })
    const forward = e.key('Tab'); expect(forward.preventDefault).toHaveBeenCalled(); expect(e.input.focus).toHaveBeenCalledOnce()
    e.key('Enter', { ctrlKey: true, nativeEvent: { isComposing: true } }); expect(onApplySequence).not.toHaveBeenCalled()
  })
})
