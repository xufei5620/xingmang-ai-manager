import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageEditMask } from './image-edit-mask'
import type { ImageMaskPng } from './image-mask-png'
import type { MaskAssetSaveMode } from './mask-asset-export'

interface Effect { deps: readonly unknown[]; cleanup?: () => void }
const runtime = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], effects: new Map<number, Effect>(), pending: [] as Array<() => void>, encode: vi.fn() }))
vi.mock('react-dom', () => ({ createPortal: (tree: unknown) => tree }))
vi.mock('./image-mask-png', () => ({ encodeImageMaskPng: (...args: unknown[]) => runtime.encode(...args) }))
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>()
  return { ...actual,
    useRef(initial: unknown) { const id = runtime.cursor++; if (!(id in runtime.values)) runtime.values[id] = { current: initial }; return runtime.values[id] },
    useState(initial: unknown) { const id = runtime.cursor++; if (!(id in runtime.values)) runtime.values[id] = typeof initial === 'function' ? initial() : initial; return [runtime.values[id], (next: unknown) => { runtime.values[id] = typeof next === 'function' ? next(runtime.values[id]) : next }] },
    useId() { runtime.cursor++; return 'mask-save-test' },
    useMemo(factory: () => unknown, deps: readonly unknown[]) { const id = runtime.cursor++, old = runtime.values[id] as { deps: readonly unknown[]; value: unknown } | undefined; if (!old || deps.some((value, index) => value !== old.deps[index])) runtime.values[id] = { deps, value: factory() }; return (runtime.values[id] as { value: unknown }).value },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) { const id = runtime.cursor++, old = runtime.effects.get(id); if (!old || deps.some((value, index) => value !== old.deps[index])) { runtime.effects.set(id, { deps, cleanup: old?.cleanup }); runtime.pending.push(() => { old?.cleanup?.(); const cleanup = effect(); const current = runtime.effects.get(id); if (current) current.cleanup = typeof cleanup === 'function' ? cleanup : undefined }) } },
  }
})
import { ImageMaskEditor } from './ImageMaskEditor'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function find(tree: unknown, predicate: (element: ElementShape) => boolean): ElementShape | null {
  if (Array.isArray(tree)) { for (const entry of tree) { const result = find(entry, predicate); if (result) return result } return null }
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return null
  const element = tree as ElementShape; return predicate(element) ? element : find(element.props.children, predicate)
}
function text(tree: unknown): string { return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' && 'props' in tree ? text((tree as ElementShape).props.children) : '' }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function recipe(): ImageEditMask { return { version: 1, sourceAssetId: 'a'.repeat(43), width: 20, height: 12, strokes: [{ tool: 'brush', size: .6, points: [{ x: .4, y: .5 }] }] } }
const png: ImageMaskPng = { blob: new Blob(['synthetic unit PNG'], { type: 'image/png' }), width: 20, height: 12 }
function harness(options: { initial?: ImageEditMask; omitSave?: boolean; deferEffects?: boolean; allowLinkedAsset?: boolean; allowReplaceAsset?: boolean; allowDownload?: boolean } = {}) {
  runtime.cursor = 0; runtime.values = []; runtime.effects = new Map(); runtime.pending = []; runtime.encode.mockReset(); runtime.encode.mockResolvedValue(png)
  const onApply = vi.fn(), onClose = vi.fn(), onSaveAsset = vi.fn(async (_mask: ImageEditMask, _png: ImageMaskPng, _signal: AbortSignal, _mode?: MaskAssetSaveMode): Promise<void> => undefined)
  let assetId = 'a'.repeat(43), tree: unknown
  let allowLinkedAsset = options.allowLinkedAsset, allowReplaceAsset = options.allowReplaceAsset
  class Element { closest() { return null } }
  vi.stubGlobal('HTMLElement', Element); vi.stubGlobal('document', { body: {}, activeElement: undefined, createElement: vi.fn(() => ({ click: vi.fn(), href: '', download: '' })) })
  vi.stubGlobal('requestAnimationFrame', vi.fn()); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  function effects() { runtime.pending.splice(0).forEach((run) => run()) }
  function render(passive = true) { runtime.cursor = 0; tree = ImageMaskEditor({ asset: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}` }, initial: options.initial ?? recipe(), onApply, onClose, allowLinkedAsset, allowReplaceAsset, ...(options.allowDownload === undefined ? {} : { allowDownload: options.allowDownload }), ...(options.omitSave ? {} : { onSaveAsset }) }); if (passive) effects() }
  function element(predicate: (entry: ElementShape) => boolean) { const found = find(tree, predicate); if (!found) throw new Error('Missing element'); return found }
  function button(label: string) { return element((entry) => entry.type === 'button' && (text(entry.props.children) === label || entry.props['aria-label'] === label)) }
  function rawClick(label: string) { return button(label).props.onClick as () => void }
  function selection() { return element((entry) => entry.type === 'select' && entry.props['aria-label'] === '图片保存方式') }
  function rawModeChange() { return selection().props.onChange as (event: { target: { value: string } }) => void }
  function chooseMode(mode: string) { const target = selection(); if (target.props.disabled) throw new Error('Disabled mode selection'); rawModeChange()({ target: { value: mode } }); render() }
  function click(label: string) { const target = button(label); if (target.props.disabled) throw new Error('Disabled: ' + label); (target.props.onClick as () => void)(); render() }
  function load(passive = true) { (element((entry) => entry.props.alt === '局部修改原图').props.onLoad as (event: unknown) => void)({ currentTarget: { naturalWidth: 20, naturalHeight: 12 } }); render(passive) }
  function failLoad() { (element((entry) => entry.props.alt === '局部修改原图').props.onError as () => void)(); render() }
  function key(value: string, mods: Record<string, boolean> = {}) { (element((entry) => entry.type === 'section').props.onKeyDown as (event: unknown) => void)({ key: value, target: new Element(), preventDefault() {}, stopPropagation() {}, ...mods }); render() }
  function unmount() { for (const effect of runtime.effects.values()) effect.cleanup?.() }
  render(!options.deferEffects)
  return { onApply, onClose, onSaveAsset, render, effects, button, rawClick, selection, rawModeChange, chooseMode, click, load, failLoad, key, unmount, text: () => text(tree), changeAsset: (id: string, passive = true) => { assetId = id; render(passive) }, changeAllowed: (linked: boolean | undefined, replace: boolean | undefined, passive = true) => { allowLinkedAsset = linked; allowReplaceAsset = replace; render(passive) } }
}
async function settled() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
afterEach(() => vi.unstubAllGlobals())

describe('actual mask editor standalone PNG save events', () => {
  it('requires a loaded matching nonempty source and keeps AI apply separate', async () => {
    const editor = harness()
    expect(() => editor.selection()).toThrow('Missing')
    expect(() => editor.click('另存为蒙版图片节点')).toThrow('Disabled')
    editor.load(); editor.click('另存为蒙版图片节点'); await settled()
    expect(editor.onSaveAsset).toHaveBeenCalledExactlyOnceWith(recipe(), png, expect.any(AbortSignal)); expect(editor.onApply).not.toHaveBeenCalled(); expect(editor.onClose).toHaveBeenCalledOnce()
  })
  it('defaults to linked saving only when the caller permits it', () => {
    const linked = harness({ allowLinkedAsset: true, allowReplaceAsset: false })
    expect(linked.selection().props.value).toBe('linked')
    expect(linked.text()).toContain('另存为关联图片节点'); expect(linked.text()).toContain('另存为独立图片节点')
    expect(linked.text()).not.toContain('保存至当前节点'); expect(linked.text()).toContain('之后填写修改指令并明确运行，才会调用模型')
    const replaceOnly = harness({ allowReplaceAsset: true })
    expect(replaceOnly.selection().props.value).toBe('new'); expect(replaceOnly.text()).not.toContain('另存为关联图片节点')
    expect(replaceOnly.text()).toContain('保存至当前节点'); expect(replaceOnly.text()).toContain('零 AI 下游直接复用')
  })
  it.each([
    { mode: 'new', label: '另存为蒙版图片节点', note: '零 AI 下游直接复用' },
    { mode: 'linked', label: '另存为关联图片节点', note: '保留原图输入' },
    { mode: 'replace', label: '保存至当前节点', note: '旧笔迹不会继续编辑，可在画布撤销' },
  ] as const)('saves the exact original mask and PNG with explicit $mode identity', async ({ mode, label, note }) => {
    const editor = harness({ allowLinkedAsset: true, allowReplaceAsset: true }); editor.load(); editor.chooseMode(mode)
    expect(editor.selection().props.value).toBe(mode); expect(editor.text()).toContain(note)
    editor.click(label); await settled()
    expect(editor.onSaveAsset).toHaveBeenCalledExactlyOnceWith(recipe(), png, expect.any(AbortSignal), mode)
    expect(editor.onSaveAsset.mock.calls[0][1]).toBe(png); expect(editor.onApply).not.toHaveBeenCalled(); expect(editor.onClose).toHaveBeenCalledOnce()
  })
  it('ignores unavailable and unknown select values without changing the selected intent', () => {
    const editor = harness({ allowLinkedAsset: true, allowReplaceAsset: false }); editor.load()
    editor.chooseMode('replace'); editor.chooseMode('unrecognized')
    expect(editor.selection().props.value).toBe('linked'); expect(editor.text()).not.toContain('保存至当前节点')
    expect(editor.onSaveAsset).not.toHaveBeenCalled(); expect(runtime.encode).not.toHaveBeenCalled()
  })
  it('captures the latest selection even when an older enabled save handler is invoked', async () => {
    const editor = harness({ allowLinkedAsset: true, allowReplaceAsset: true }); editor.load()
    const previousSave = editor.rawClick('另存为关联图片节点'); editor.chooseMode('replace'); previousSave(); await settled()
    expect(editor.onSaveAsset).toHaveBeenCalledExactlyOnceWith(recipe(), png, expect.any(AbortSignal), 'replace')
  })
  it('locks the select through encoding and saving and keeps the captured mode', async () => {
    const editor = harness({ allowLinkedAsset: true, allowReplaceAsset: true }), encoded = deferred<ImageMaskPng>(), saved = deferred<void>()
    runtime.encode.mockReturnValue(encoded.promise); editor.onSaveAsset.mockReturnValue(saved.promise); editor.load(); editor.chooseMode('replace')
    const staleChange = editor.rawModeChange(); editor.click('保存至当前节点')
    expect(editor.selection().props.disabled).toBe(true); expect(() => editor.chooseMode('new')).toThrow('Disabled')
    staleChange({ target: { value: 'new' } }); editor.render(); expect(editor.selection().props.value).toBe('replace')
    encoded.resolve(png); await settled(); editor.render()
    expect(editor.onSaveAsset).toHaveBeenCalledExactlyOnceWith(recipe(), png, expect.any(AbortSignal), 'replace')
    expect(editor.selection().props.disabled).toBe(true); staleChange({ target: { value: 'linked' } }); editor.render()
    expect(editor.selection().props.value).toBe('replace'); expect(runtime.encode).toHaveBeenCalledOnce()
    saved.resolve(); await settled(); expect(editor.onClose).toHaveBeenCalledOnce()
  })
  it('keeps the explicit new-mode invocation captured before unrelated permissions disappear', async () => {
    const editor = harness({ allowLinkedAsset: true, allowReplaceAsset: true }), encoded = deferred<ImageMaskPng>()
    runtime.encode.mockReturnValue(encoded.promise); editor.load(); editor.chooseMode('new'); editor.click('另存为蒙版图片节点')
    editor.changeAllowed(undefined, undefined); encoded.resolve(png); await settled()
    expect(editor.onSaveAsset).toHaveBeenCalledExactlyOnceWith(recipe(), png, expect.any(AbortSignal), 'new')
  })
  it.each(['linked', 'replace'] as const)('aborts $0 encoding when that save permission is withdrawn and requires a new selection', async (mode) => {
    const editor = harness({ allowLinkedAsset: true, allowReplaceAsset: true }), encoded = deferred<ImageMaskPng>()
    runtime.encode.mockReturnValue(encoded.promise); editor.load(); editor.chooseMode(mode); const label = mode === 'linked' ? '另存为关联图片节点' : '保存至当前节点'
    const staleSave = editor.rawClick(label); editor.click(label); const signal = runtime.encode.mock.calls[0][1].signal as AbortSignal
    editor.changeAllowed(mode !== 'linked', mode !== 'replace'); expect(signal.aborted).toBe(true)
    encoded.resolve(png); await settled(); editor.render()
    expect(editor.onSaveAsset).not.toHaveBeenCalled(); expect(editor.onClose).not.toHaveBeenCalled(); expect(editor.text()).toContain('原保存方式已不可用'); expect(editor.text()).toContain('1 / 128 笔')
    expect(editor.button(label).props.disabled).toBe(true); staleSave(); await settled(); expect(editor.onSaveAsset).not.toHaveBeenCalled()
    editor.chooseMode('new'); editor.click('另存为蒙版图片节点'); await settled()
    expect(editor.onSaveAsset).toHaveBeenCalledExactlyOnceWith(recipe(), png, expect.any(AbortSignal), 'new')
  })
  it('rejects a withdrawn mode before passive effects can abort the pending encoding', async () => {
    const editor = harness({ allowLinkedAsset: true }), encoded = deferred<ImageMaskPng>()
    runtime.encode.mockReturnValue(encoded.promise); editor.load(); editor.click('另存为关联图片节点'); editor.changeAllowed(false, undefined, false)
    encoded.resolve(png); await settled(); expect(editor.onSaveAsset).not.toHaveBeenCalled(); expect(editor.onClose).not.toHaveBeenCalled()
    editor.effects(); editor.render(); expect(editor.text()).toContain('原保存方式已不可用'); expect(editor.button('另存为关联图片节点').props.disabled).toBe(true)
  })
  it('requires an explicit new selection if both mode props disappear and then restores the legacy call', async () => {
    const editor = harness({ allowLinkedAsset: true, allowReplaceAsset: true }); editor.load(); editor.chooseMode('replace'); editor.changeAllowed(undefined, undefined)
    expect(editor.selection().props.value).toBe('replace'); expect(editor.button('保存至当前节点').props.disabled).toBe(true); expect(editor.text()).toContain('请重新选择保存方式')
    editor.chooseMode('new'); expect(() => editor.selection()).toThrow('Missing'); editor.click('另存为蒙版图片节点'); await settled()
    expect(editor.onSaveAsset).toHaveBeenCalledExactlyOnceWith(recipe(), png, expect.any(AbortSignal))
  })
  it.each(['linked', 'replace'] as const)('aborts a pending $0 callback and ignores its late failure after permission withdrawal', async (mode) => {
    const editor = harness({ allowLinkedAsset: true, allowReplaceAsset: true }), saved = deferred<void>(); editor.onSaveAsset.mockReturnValue(saved.promise)
    editor.load(); editor.chooseMode(mode); editor.click(mode === 'linked' ? '另存为关联图片节点' : '保存至当前节点'); await settled()
    const signal = editor.onSaveAsset.mock.calls[0][2]; editor.changeAllowed(mode !== 'linked', mode !== 'replace')
    expect(signal.aborted).toBe(true); saved.reject(new Error('迟到模式保存失败')); await settled(); editor.render()
    expect(editor.onClose).not.toHaveBeenCalled(); expect(editor.text()).not.toContain('迟到模式保存失败'); expect(editor.text()).toContain('1 / 128 笔')
  })
  it.each([
    { mode: 'new', label: '另存为蒙版图片节点' },
    { mode: 'linked', label: '另存为关联图片节点' },
    { mode: 'replace', label: '保存至当前节点' },
  ] as const)('rejects a source replacement during $mode encoding without substituting the new source', async ({ mode, label }) => {
    const editor = harness({ allowLinkedAsset: true, allowReplaceAsset: true }), encoded = deferred<ImageMaskPng>()
    runtime.encode.mockReturnValue(encoded.promise); editor.load(); editor.chooseMode(mode); editor.click(label)
    const signal = runtime.encode.mock.calls[0][1].signal as AbortSignal; editor.changeAsset('b'.repeat(43)); editor.load(); encoded.resolve(png); await settled(); editor.render()
    expect(signal.aborted).toBe(true); expect(editor.onSaveAsset).not.toHaveBeenCalled(); expect(editor.onClose).not.toHaveBeenCalled()
    expect(editor.text()).toContain('原图或尺寸已变化'); expect(editor.button(label).props.disabled).toBe(true)
  })
  it.each([
    { mode: 'linked', label: '另存为关联图片节点' },
    { mode: 'replace', label: '保存至当前节点' },
  ] as const)('preserves $mode intent and strokes on failure and suppresses a late reply after close', async ({ mode, label }) => {
    const editor = harness({ allowLinkedAsset: true, allowReplaceAsset: true }); editor.onSaveAsset.mockRejectedValueOnce(new Error('模式保存失败'))
    editor.load(); editor.chooseMode(mode); editor.click(label); await settled(); editor.render()
    expect(editor.text()).toContain('模式保存失败'); expect(editor.text()).toContain('1 / 128 笔'); expect(editor.selection().props.value).toBe(mode); expect(editor.onClose).not.toHaveBeenCalled()
    const saved = deferred<void>(); editor.onSaveAsset.mockReturnValueOnce(saved.promise); editor.click(label); await settled()
    const signal = editor.onSaveAsset.mock.calls[1][2]; editor.click('取消'); expect(signal.aborted).toBe(true)
    saved.reject(new Error('关闭后的迟到失败')); await settled(); editor.render()
    expect(editor.onClose).toHaveBeenCalledOnce(); expect(editor.onApply).not.toHaveBeenCalled(); expect(editor.text()).not.toContain('关闭后的迟到失败')
  })
  it('synchronizes the busy ref before rerender so repeated clicks submit once', async () => {
    const editor = harness(), wait = deferred<void>(); editor.onSaveAsset.mockReturnValue(wait.promise); editor.load()
    const click = editor.rawClick('另存为蒙版图片节点'); click(); click(); await settled(); editor.render()
    expect(runtime.encode).toHaveBeenCalledOnce(); expect(editor.onSaveAsset).toHaveBeenCalledOnce()
    expect(editor.text()).toContain('已上传素材仍可在素材库核对')
    expect(editor.button('画笔').props.disabled).toBe(true); expect(editor.button('保存蒙版').props.disabled).toBe(true)
    editor.key('z', { ctrlKey: true }); editor.key('b'); expect(editor.text()).toContain('1 / 128 笔')
    wait.resolve(); await settled(); expect(editor.onClose).toHaveBeenCalledOnce()
  })
  it('preserves strokes and permits explicit retry after an encoding failure', async () => {
    const editor = harness(); runtime.encode.mockRejectedValueOnce(new Error('合成编码失败')); editor.load(); editor.click('另存为蒙版图片节点'); await settled(); editor.render()
    expect(editor.onSaveAsset).not.toHaveBeenCalled(); expect(editor.onClose).not.toHaveBeenCalled(); expect(editor.text()).toContain('合成编码失败'); expect(editor.text()).toContain('1 / 128 笔')
    editor.click('另存为蒙版图片节点'); await settled(); expect(editor.onSaveAsset).toHaveBeenCalledOnce()
  })
  it('preserves strokes and error after a save failure rather than closing or applying AI', async () => {
    const editor = harness(); editor.onSaveAsset.mockRejectedValueOnce(new Error('保存回执待核对，请核对素材库')); editor.load(); editor.click('另存为蒙版图片节点'); await settled(); editor.render()
    expect(editor.text()).toContain('保存回执待核对'); expect(editor.text()).toContain('1 / 128 笔'); expect(editor.onClose).not.toHaveBeenCalled(); expect(editor.onApply).not.toHaveBeenCalled()
    expect(editor.button('另存为蒙版图片节点').props.disabled).toBe(false)
  })
  it('aborts encoding on Escape and ignores an encoder that resolves after close', async () => {
    const editor = harness(), wait = deferred<ImageMaskPng>(); runtime.encode.mockReturnValue(wait.promise); editor.load(); editor.click('另存为蒙版图片节点')
    const signal = runtime.encode.mock.calls[0][1].signal as AbortSignal
    editor.key('Escape'); expect(signal.aborted).toBe(true); expect(editor.onClose).toHaveBeenCalledOnce()
    wait.resolve(png); await settled(); expect(editor.onSaveAsset).not.toHaveBeenCalled(); expect(editor.onClose).toHaveBeenCalledOnce()
  })
  it('aborts pending callback on unmount and does not close or replace UI after late failure', async () => {
    const editor = harness(), wait = deferred<void>(); editor.onSaveAsset.mockReturnValue(wait.promise); editor.load(); editor.click('另存为蒙版图片节点'); await settled()
    const signal = editor.onSaveAsset.mock.calls[0][2]; editor.unmount(); expect(signal.aborted).toBe(true)
    wait.reject(new Error('迟到保存失败')); await settled(); expect(editor.onClose).not.toHaveBeenCalled(); expect(editor.text()).not.toContain('迟到保存失败')
  })
  it('invalidates source failures even when a stale enabled button callback is invoked', async () => {
    const editor = harness(); editor.load(); const click = editor.rawClick('另存为蒙版图片节点'); editor.failLoad(); click(); await settled(); editor.render()
    expect(editor.onSaveAsset).not.toHaveBeenCalled(); expect(runtime.encode).not.toHaveBeenCalled(); expect(editor.text()).toContain('原图尚未就绪'); expect(() => editor.click('保存蒙版')).toThrow('Disabled')
    expect(editor.text()).not.toContain('正在读取原图尺寸')
  })
  it('rejects source changes during encoding and keeps the prior recipe until explicit adaptation', async () => {
    const editor = harness(), wait = deferred<ImageMaskPng>(); runtime.encode.mockReturnValue(wait.promise); editor.load(); editor.click('另存为蒙版图片节点')
    const signal = runtime.encode.mock.calls[0][1].signal as AbortSignal; editor.changeAsset('b'.repeat(43)); editor.load()
    expect(signal.aborted).toBe(true); wait.resolve(png); await settled(); editor.render()
    expect(editor.onSaveAsset).not.toHaveBeenCalled(); expect(editor.text()).toContain('原图或尺寸已变化'); expect(() => editor.click('另存为蒙版图片节点')).toThrow('Disabled')
  })
  it('keeps a cached onLoad verified before initial passive effects', async () => {
    const editor = harness({ deferEffects: true }); editor.load(false); editor.effects(); editor.render()
    expect(editor.button('另存为蒙版图片节点').props.disabled).toBe(false); editor.click('另存为蒙版图片节点'); await settled(); expect(editor.onSaveAsset).toHaveBeenCalledOnce()
  })
  it('downloads the same encoded blob at its original dimensions without invoking save or AI', async () => {
    const editor = harness(), create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-mask'), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.useFakeTimers()
    try {
      editor.load(); editor.click('下载黑白蒙版'); await settled(); editor.render()
      expect(runtime.encode).toHaveBeenCalledExactlyOnceWith(recipe(), { signal: expect.any(AbortSignal) }); expect(create).toHaveBeenCalledExactlyOnceWith(png.blob)
      expect(editor.onSaveAsset).not.toHaveBeenCalled(); expect(editor.onApply).not.toHaveBeenCalled(); expect(editor.onClose).not.toHaveBeenCalled()
      const documentMock = document as unknown as { createElement: ReturnType<typeof vi.fn> }, link = documentMock.createElement.mock.results[0].value
      expect(link.download).toBe('蒙版-20x12.png'); expect(link.click).toHaveBeenCalledOnce(); await vi.runAllTimersAsync(); expect(revoke).toHaveBeenCalledWith('blob:synthetic-mask')
    } finally { vi.useRealTimers(); create.mockRestore(); revoke.mockRestore() }
  })
  it('downloads the selected replace-mode PNG without a save and without depending on asset-mode permission', async () => {
    const editor = harness({ allowLinkedAsset: true, allowReplaceAsset: true }), encoded = deferred<ImageMaskPng>()
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mode-download'), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.useFakeTimers()
    try {
      runtime.encode.mockReturnValue(encoded.promise); editor.load(); editor.chooseMode('replace'); editor.click('下载黑白蒙版')
      const signal = runtime.encode.mock.calls[0][1].signal as AbortSignal; expect(editor.selection().props.disabled).toBe(true)
      editor.changeAllowed(false, false); expect(signal.aborted).toBe(false); encoded.resolve(png); await settled(); editor.render()
      expect(create).toHaveBeenCalledExactlyOnceWith(png.blob); expect(editor.onSaveAsset).not.toHaveBeenCalled(); expect(editor.onApply).not.toHaveBeenCalled(); expect(editor.onClose).not.toHaveBeenCalled()
      expect(editor.text()).toContain('原保存方式已不可用'); await vi.runAllTimersAsync(); expect(revoke).toHaveBeenCalledWith('blob:mode-download')
    } finally { vi.useRealTimers(); create.mockRestore(); revoke.mockRestore() }
  })
  it('keeps cached source success on an asset change before that scope passive effect', () => {
    const editor = harness(); editor.load(); editor.changeAsset('b'.repeat(43), false); editor.load(false); editor.effects(); editor.render()
    expect(editor.text()).toContain('原图或尺寸已变化'); expect(editor.text()).not.toContain('正在读取原图尺寸')
    editor.click('确认适配当前原图'); expect(editor.button('另存为蒙版图片节点').props.disabled).toBe(false)
  })
  it('disables a fully erased mask and preserves legacy apply when standalone saving is absent', () => {
    const erased = recipe(); erased.strokes.push({ ...erased.strokes[0], tool: 'erase' })
    const empty = harness({ initial: erased }); empty.load(); expect(() => empty.click('另存为蒙版图片节点')).toThrow('Disabled'); expect(() => empty.click('下载黑白蒙版')).toThrow('Disabled')
    const legacy = harness({ omitSave: true }); legacy.load(); expect(() => legacy.button('另存为蒙版图片节点')).toThrow('Missing'); legacy.click('保存蒙版'); expect(legacy.onApply).toHaveBeenCalledExactlyOnceWith(recipe()); expect(runtime.encode).not.toHaveBeenCalled()
  })

  it('offers no mask download when the host blocks page downloads', () => {
    const editor = harness({ allowDownload: false }); editor.load()
    expect(() => editor.button('下载黑白蒙版')).toThrow('Missing'); expect(editor.text()).toContain('另存为蒙版图片节点')
  })
})
