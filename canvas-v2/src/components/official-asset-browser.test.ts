import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasImageAssetSummary, OfficialAssetAcquisition, OfficialAssetItem, OfficialAssetPage } from '../host'
const runtime = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef(initial: unknown) { const index = runtime.cursor++; runtime.slots[index] ??= { current: initial }; return runtime.slots[index] },
  useState(initial: unknown) { const index = runtime.cursor++; if (!(index in runtime.slots)) runtime.slots[index] = typeof initial === 'function' ? initial() : initial; return [runtime.slots[index], (value: unknown) => { runtime.slots[index] = typeof value === 'function' ? value(runtime.slots[index]) : value }] },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) { const index = runtime.cursor++, previous = runtime.slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined; if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return; runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } }) },
}))
import { AssetSourceTabs } from './AssetSourceTabs'
import { OfficialAssetBrowser } from './OfficialAssetBrowser'
import { acquiredOfficialImage, acquireOfficialSelection, officialAssetKey, orderedOfficialSelection } from './official-asset-browser-model'

function item(id = 'original-one'): OfficialAssetItem { return { id, version: 1, title: id, category: 'prop', tags: ['原创'], description: '自有形状组合', path: `/official-assets/v1/${id}.png`, sha256: 'a'.repeat(64), bytes: 100, width: 640, height: 480, attribution: '星芒原创', licenseLabel: '可创作使用' } }
function result(source = item()): OfficialAssetAcquisition { const assetId = source.id === 'original-one' ? 'a'.repeat(43) : 'b'.repeat(43); return { asset: { assetId, mediaType: 'image', mimeType: 'image/png', source: 'imported', fileName: `${source.id}.png`, displayName: source.title, localUrl: `xingmang-asset://image/${assetId}`, thumbnailUrl: `xingmang-asset://image/${assetId}`, createdAt: '2026-10-16T00:00:00Z' }, receipt: { id: source.id, version: source.version, sha256: source.sha256, bytes: source.bytes, operationId: '12345678-1234-1234-1234-123456789abc' } } }
function page(): OfficialAssetPage { return { items: [item(), item('original-two')], total: 2, offset: 0, limit: 24, hasMore: false, counts: { all: 2, character: 0, prop: 2, clothing: 0, other: 0 } } }
interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type: unknown): ElementShape[] { if (Array.isArray(value)) return value.flatMap((entry) => elements(entry, type)); if (!value || typeof value !== 'object' || !('props' in value)) return []; const entry = value as ElementShape; return [...(entry.type === type ? [entry] : []), ...elements(entry.props.children, type)] }
function text(value: unknown): string { if (typeof value === 'string' || typeof value === 'number') return String(value); if (Array.isArray(value)) return value.map(text).join(''); return value && typeof value === 'object' && 'props' in value ? text((value as ElementShape).props.children) : '' }
function button(tree: unknown, label: string) { const entry = elements(tree, 'button').find((entry) => entry.props['aria-label'] === label || text(entry.props.children) === label); expect(entry, label).toBeDefined(); return entry! }
function click(tree: unknown, label: string, event?: unknown) { const entry = button(tree, label); expect(entry.props.disabled).not.toBe(true); (entry.props.onClick as (event?: unknown) => void)(event) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
async function settle() { for (let index = 0; index < 20; index++) await Promise.resolve() }
function fixture(single = false) {
  const props: Parameters<typeof OfficialAssetBrowser>[0] = { access: { list: vi.fn(async () => page()), acquire: vi.fn(async (identity) => result(item(identity.id))), inspect: vi.fn(async (identity) => result(item(identity.id))) }, scopeKey: 'owner-a:project-a', single, onUse: vi.fn(async () => undefined), onAcquired: vi.fn(), readOnly: false }
  function render() { runtime.cursor = 0; OfficialAssetBrowser(props); runtime.effects.splice(0).forEach((effect) => effect()); runtime.cursor = 0; const tree = OfficialAssetBrowser(props); runtime.effects.splice(0).forEach((effect) => effect()); return tree }
  function close() { for (const slot of runtime.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup(): void }).cleanup() }
  async function ready() { render(); await vi.advanceTimersByTimeAsync(300); return render() }
  return { props, render, ready, close }
}
beforeEach(() => { runtime.cursor = 0; runtime.slots = []; runtime.effects = []; vi.useFakeTimers() })
afterEach(() => { for (const slot of runtime.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup(): void }).cleanup(); vi.useRealTimers() })

describe('official acquisition selection', () => {
  it('does not invalidate a list when its already selected source is clicked', () => {
    const onChange = vi.fn(), tree = AssetSourceTabs({ value: 'mine', onChange })
    click(tree, '我的素材'); expect(onChange).not.toHaveBeenCalled(); click(tree, '官方素材'); expect(onChange).toHaveBeenCalledExactlyOnceWith('official')
  })
  it('uses catalog order and only accepts private image identities matching the receipt', () => {
    const first = item(), second = item('original-two')
    expect(orderedOfficialSelection([first, second], [officialAssetKey(second), officialAssetKey(first)])).toEqual([first, second])
    expect(acquiredOfficialImage(first, result())).toEqual(result().asset)
    expect(() => acquiredOfficialImage(first, { ...result(), asset: { ...result().asset, localUrl: first.path } })).toThrow('回执')
    expect(() => acquiredOfficialImage(first, { ...result(), receipt: { ...result().receipt, version: 2 } })).toThrow('回执')
  })
  it('stops after partial acquisition failure and remembers only confirmed private copies', async () => {
    const remember = vi.fn(), acquire = vi.fn().mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error('连接中断'))
    await expect(acquireOfficialSelection({ items: page().items, access: { acquire, list: vi.fn(), inspect: vi.fn() }, signal: new AbortController().signal, current: () => true, remember, progress: vi.fn() })).rejects.toThrow('连接中断')
    expect(remember).toHaveBeenCalledExactlyOnceWith(item(), result().asset)
  })
})
describe('actual official asset browser interactions', () => {
  it('acquires the selected set in catalog order before using any private assets and deduplicates a double click', async () => {
    const f = fixture(); await f.ready(); click(f.render(), '选择官方素材：original-two'); click(f.render(), '选择官方素材：original-one')
    const callback = button(f.render(), '取得并加入画布').props.onClick as () => void; callback(); callback(); await settle()
    expect(f.props.access.acquire).toHaveBeenCalledTimes(2)
    expect(f.props.onUse).toHaveBeenCalledExactlyOnceWith([result().asset, result(item('original-two')).asset])
    expect(text(f.render())).toContain('已取得 2 份本人副本并加入画布'); f.close()
  })
  it('never uses partial results and offers an explicit read-only acquisition inspection', async () => {
    const f = fixture(); await f.ready(); vi.mocked(f.props.access.acquire).mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error('网络结果未确认'))
    click(f.render(), '全选本页'); click(f.render(), '取得并加入画布'); await settle()
    expect(f.props.onUse).not.toHaveBeenCalled(); expect(text(f.render())).toContain('网络结果未确认')
    click(f.render(), '核对取得结果'); await settle()
    expect(f.props.access.inspect).toHaveBeenCalledTimes(1); expect(f.props.access.acquire).toHaveBeenCalledTimes(2); expect(f.props.onUse).not.toHaveBeenCalled()
  })
  it.each(['scope', 'filter', 'readonly', 'close'] as const)('withholds a delayed acquired copy after %s changes', async (change) => {
    const f = fixture(true), gate = deferred<OfficialAssetAcquisition>(); f.props.access.acquire = vi.fn(() => gate.promise)
    await f.ready(); click(f.render(), '取得并选用')
    if (change === 'scope') { f.props.scopeKey = 'owner-b:project-b'; f.render() }
    else if (change === 'filter') { const search = elements(f.render(), 'input')[0]; (search.props.onChange as (event: unknown) => void)({ target: { value: 'different' } }); f.render() }
    else if (change === 'readonly') { f.props.readOnly = true; f.render() }
    else f.close()
    gate.resolve(result()); await settle(); expect(f.props.onUse).not.toHaveBeenCalled(); expect(f.props.onAcquired).not.toHaveBeenCalled()
  })
  it('keeps the catalog usable when clicking its already active category', async () => {
    const f = fixture(); await f.ready(); click(f.render(), '全部2'); await f.ready(); expect(elements(f.render(), 'article')).toHaveLength(2)
  })
  it('ignores a superseded catalog read and shows a retry for current read failures', async () => {
    const f = fixture(), gate = deferred<OfficialAssetPage>(); f.props.access.list = vi.fn().mockReturnValueOnce(gate.promise).mockRejectedValueOnce(new Error('当前目录离线'))
    f.render(); await vi.advanceTimersByTimeAsync(1)
    const search = elements(f.render(), 'input')[0]; (search.props.onChange as (event: unknown) => void)({ target: { value: 'new' } }); f.render(); await vi.advanceTimersByTimeAsync(300)
    gate.resolve(page()); await settle(); expect(text(f.render())).toContain('当前目录离线'); expect(elements(f.render(), 'article')).toHaveLength(0); expect(button(f.render(), '重新读取')).toBeDefined()
  })
  it('keeps a confirmed acquisition distinct from a failed canvas insertion', async () => {
    const f = fixture(true); f.props.onUse = vi.fn().mockRejectedValue(new Error('当前工程不可编辑')); await f.ready(); click(f.render(), '取得并选用'); await settle()
    expect(text(f.render())).toContain('当前工程不可编辑'); expect(text(f.render())).not.toContain('核对取得结果'); expect(button(f.render(), '使用本人副本')).toBeDefined()
  })
})
