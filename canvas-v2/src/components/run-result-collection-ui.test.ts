import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasAssetSummary, CanvasRunCandidate } from '../host'
import { RunResultCollectionDialog, RunCollectionMedia, type RunResultCollectionDialogProps } from './RunResultCollectionDialog'
import { useRunResultCollection, type RunCollectionAccess, type RunCollectionEnvironment, type RunCollectionLock } from './use-run-result-collection'
import { collectionAsset, collectionReference, collectionRun, collectionStorage, collectionSummary, settleCollection } from './run-result-collection.test-fixture'
import { runCollectionScopeKey, writeRunCollection } from './run-result-collection'
const runtime = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef(initial: unknown) { const index = runtime.cursor++; runtime.slots[index] ??= { current: initial }; return runtime.slots[index] },
  useState(initial: unknown) { const index = runtime.cursor++, slots = runtime.slots; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) {
    const index = runtime.cursor++, slots = runtime.slots, previous = slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined
    if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return
    runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } })
  },
}))
vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), createPortal: (children: unknown) => children }))
function harness<T>(render: () => T) {
  const owned = { slots: [] as unknown[], effects: [] as (() => void)[] }
  function activate() { runtime.cursor = 0; runtime.slots = owned.slots; runtime.effects = owned.effects }
  return {
    render() { activate(); render(); owned.effects.splice(0).forEach((effect) => effect()); activate(); const result = render(); owned.effects.splice(0).forEach((effect) => effect()); return result },
    close() { for (const slot of owned.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup(): void }).cleanup() },
  }
}
const immediateLock: RunCollectionLock = { run<T>(_name: string, _signal: AbortSignal, work: () => T): Promise<T> { try { return Promise.resolve(work()) } catch (cause) { return Promise.reject(cause) } } }
function fixture(environment: RunCollectionEnvironment = { lock: immediateLock }, sharedStorage = collectionStorage()) {
  const storage = sharedStorage, access: RunCollectionAccess = { scope: { accountId: 1, projectId: 'project' }, runtimeScope: 'epoch-1', onReadRun: vi.fn(async (id: string) => collectionRun(id, [1, 2, 3])), onReadAsset: vi.fn(async (id: string) => { const index = Number(id.replace(/a/g, '')); return collectionAsset(index, index % 3 === 0 ? 'audio' : index % 3 === 2 ? 'video' : 'image') }), onAddMany: vi.fn().mockResolvedValue(undefined), onDownloadMany: vi.fn().mockResolvedValue(undefined) }
  return { storage, access, ui: harness(() => useRunResultCollection(access, storage, environment)) }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('actual persistent cross-run basket state', () => {
  it('syncs clean pages through storage notifications and refuses a stale edit until explicitly retried against the latest basket', async () => {
    const storage = collectionStorage(), listeners = new Set<() => void>()
    const environment: RunCollectionEnvironment = { lock: immediateLock, subscribe(_scope, listener) { listeners.add(listener); return () => { listeners.delete(listener) } } }
    const a = fixture(environment, storage), b = fixture(environment, storage)
    a.ui.render(); b.ui.render(); a.ui.render().add([collectionReference(1)]); await settleCollection()
    listeners.forEach((listener) => listener()); expect(b.ui.render().references).toEqual([collectionReference(1)])
    b.ui.render().remove(collectionReference(1).assetId); await settleCollection()
    a.ui.render().add([collectionReference(2)]); await settleCollection()
    expect(a.ui.render().conflict).toMatchObject({ latestCount: 0, changes: '加入 1 项' })
    expect(JSON.parse(storage.getItem(runCollectionScopeKey(a.access.scope))!).references).toEqual([])
    expect(a.ui.render().references).toEqual([collectionReference(1), collectionReference(2)])
    a.ui.render().retryChanges(); await settleCollection()
    expect(a.ui.render().references).toEqual([collectionReference(2)])
    expect(a.ui.render().conflict).toBeNull()
    listeners.forEach((listener) => listener()); expect(b.ui.render().references).toEqual([collectionReference(2)])
    expect(a.access.onAddMany).not.toHaveBeenCalled(); a.ui.close(); b.ui.close(); expect(listeners.size).toBe(0)
  })
  it('never resurrects removed results or an old full order when explicitly retrying a stale move intent', async () => {
    const storage = collectionStorage(); writeRunCollection({ accountId: 1, projectId: 'project' }, [collectionReference(1), collectionReference(2), collectionReference(3)], storage)
    const a = fixture({ lock: immediateLock }, storage), b = fixture({ lock: immediateLock }, storage)
    a.ui.render(); b.ui.render(); b.ui.render().remove(collectionReference(2).assetId); b.ui.render().move(collectionReference(3).assetId, -1); await settleCollection()
    a.ui.render().move(collectionReference(1).assetId, 1); await settleCollection(); expect(a.ui.render().conflict).not.toBeNull()
    a.ui.render().retryChanges(); await settleCollection()
    expect(a.ui.render().references).toEqual([collectionReference(3), collectionReference(1)])
    a.ui.close(); b.ui.close()
  })
  it('serializes simultaneous page writes with a lock and never merges the losing page automatically', async () => {
    const queued: (() => void)[] = [], storage = collectionStorage()
    const lock: RunCollectionLock = { run<T>(_name: string, signal: AbortSignal, work: () => T) { return new Promise<T>((resolve, reject) => { queued.push(() => { try { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); resolve(work()) } catch (cause) { reject(cause) } }) }) } }
    const a = fixture({ lock }, storage), b = fixture({ lock }, storage)
    a.ui.render(); b.ui.render(); a.ui.render().add([collectionReference(1)]); b.ui.render().add([collectionReference(2)])
    expect(storage.values.size).toBe(0); expect(a.ui.render().saving).toBe(true); expect(queued).toHaveLength(2)
    queued.shift()!(); await settleCollection(); queued.shift()!(); await settleCollection()
    expect(a.ui.render().conflict).toBeNull(); expect(b.ui.render().conflict).not.toBeNull()
    expect(JSON.parse(storage.getItem(runCollectionScopeKey(a.access.scope))!).references).toEqual([collectionReference(1)])
    b.ui.render().retryChanges(); expect(queued).toHaveLength(1); queued.shift()!(); await settleCollection()
    expect(b.ui.render().references).toEqual([collectionReference(1), collectionReference(2)])
    a.ui.close(); b.ui.close()
  })
  it('uses a clearly temporary basket without writing shared storage when safe browser locks are unavailable', async () => {
    const storage = collectionStorage(); writeRunCollection({ accountId: 1, projectId: 'project' }, [collectionReference(1)], storage)
    const before = [...storage.values], write = vi.spyOn(storage, 'setItem'), f = fixture({ lock: null }, storage)
    expect(f.ui.render().temporary).toBe(true); f.ui.render().add([collectionReference(2)]); f.ui.render().remove(collectionReference(1).assetId); f.ui.render().reload()
    expect(f.ui.render().references).toEqual([collectionReference(2)]); expect(f.ui.render().storageError).toContain('不会覆盖其他页面')
    expect(write).not.toHaveBeenCalled(); expect([...storage.values]).toEqual(before); f.ui.close()
    const reopened = fixture({ lock: null }, storage); expect(reopened.ui.render().references).toEqual([collectionReference(1)]); reopened.ui.close()
  })
  it.each(['account', 'project', 'unmount'] as const)('does not commit a waiting lock after %s changes', async (reason) => {
    let release!: () => void
    const lock: RunCollectionLock = { run<T>(_name: string, _signal: AbortSignal, work: () => T) { return new Promise<T>((resolve) => { release = () => resolve(work()) }) } }
    const f = fixture({ lock }); f.ui.render().add([collectionReference(1)])
    if (reason === 'unmount') f.ui.close()
    else { f.access.scope = { ...f.access.scope, ...(reason === 'account' ? { accountId: 2 } : { projectId: 'other' }) }; f.ui.render() }
    release(); await settleCollection(); expect(f.storage.values.size).toBe(0); if (reason !== 'unmount') f.ui.close()
  })
  it('retains a frozen already-accepted host transaction when another page updates the basket', async () => {
    let notify!: () => void, finish!: () => void
    const f = fixture({ lock: immediateLock, subscribe(_scope, listener) { notify = listener; return () => {} } })
    f.ui.render().add([collectionReference(1)]); f.ui.render(); await settleCollection()
    vi.mocked(f.access.onAddMany!).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const operation = f.ui.render().run('add'); await settleCollection(); expect(f.ui.render().action.phase).toBe('accepted-add')
    writeRunCollection(f.access.scope, [], f.storage); notify()
    expect(f.ui.render().references).toEqual([]); expect(f.ui.render().action.phase).toBe('accepted-add')
    finish(); await operation; expect(f.access.onAddMany).toHaveBeenCalledExactlyOnceWith([collectionReference(1).assetId]); expect(f.ui.render().action.notice).toContain('一次撤销'); f.ui.close()
  })
  it('adopts the newest basket only after an explicit choice and keeps the rejected local draft out of storage', async () => {
    const f = fixture(); f.ui.render().add([collectionReference(1)]); await settleCollection()
    writeRunCollection(f.access.scope, [collectionReference(2, 'external-first')], f.storage)
    f.ui.render().clear(); await settleCollection(); expect(f.ui.render().conflict).toMatchObject({ clearsLatest: true })
    expect(f.ui.render().references).toEqual([]); f.ui.render().adoptLatest()
    expect(f.ui.render().references).toEqual([collectionReference(2, 'external-first')]); expect(f.ui.render().action.notice).toContain('已放弃'); f.ui.close()
  })

  it('binds real browser storage and focus notifications to only the current storage area and project', async () => {
    const f = fixture(); f.ui.close()
    const listeners = new Map<string, Set<(event: unknown) => void>>()
    const windowEvents = { localStorage: f.storage, addEventListener(type: string, listener: (event: unknown) => void) { const entries = listeners.get(type) ?? new Set(); entries.add(listener); listeners.set(type, entries) }, removeEventListener(type: string, listener: (event: unknown) => void) { listeners.get(type)?.delete(listener) } }
    vi.stubGlobal('window', windowEvents); vi.stubGlobal('navigator', { locks: { request: <T,>(name: string, options: { signal: AbortSignal }, work: () => T) => immediateLock.run(name, options.signal, work) } })
    const ui = harness(() => useRunResultCollection(f.access, f.storage)); ui.render()
    writeRunCollection(f.access.scope, [collectionReference(1)], f.storage)
    function emit(type: string, value: unknown) { listeners.get(type)?.forEach((listener) => listener(value)) }
    emit('storage', { key: runCollectionScopeKey({ ...f.access.scope, projectId: 'other' }), storageArea: f.storage }); expect(ui.render().references).toEqual([])
    emit('storage', { key: runCollectionScopeKey(f.access.scope), storageArea: collectionStorage() }); expect(ui.render().references).toEqual([])
    emit('storage', { key: runCollectionScopeKey(f.access.scope), storageArea: f.storage }); expect(ui.render().references).toEqual([collectionReference(1)])
    writeRunCollection(f.access.scope, [collectionReference(2)], f.storage); emit('focus', {}); expect(ui.render().references).toEqual([collectionReference(2)])
    ui.close(); expect([...listeners.values()].every((entries) => entries.size === 0)).toBe(true)
  })
  it('keeps an explicitly cleared temporary basket when storage reads fail even if browser locks exist', () => {
    const f = fixture(); f.ui.close(); const write = vi.fn(), ui = harness(() => useRunResultCollection(f.access, { getItem() { throw Error('blocked') }, setItem: write }, { lock: immediateLock }))
    expect(ui.render().corrupt).toBe(true); ui.render().clear(); ui.render().add([collectionReference(2)])
    expect(ui.render().temporary).toBe(true); expect(ui.render().references).toEqual([collectionReference(2)]); expect(ui.render().storageError).toContain('仅临时保留'); expect(write).not.toHaveBeenCalled(); ui.close()
  })
  it('times out a waiting lock without leaving controls stuck and ignores a later ignored-abort grant', async () => {
    vi.useFakeTimers(); let release!: () => void
    const lock: RunCollectionLock = { run<T>(_name: string, _signal: AbortSignal, work: () => T) { return new Promise<T>((resolve) => { release = () => resolve(work()) }) } }
    const f = fixture({ lock }); f.ui.render().add([collectionReference(1)])
    expect(f.ui.render().saving).toBe(true); await vi.advanceTimersByTimeAsync(8_000)
    expect(f.ui.render().saving).toBe(false); expect(f.ui.render().storageError).toContain('超时'); expect(f.ui.render().references).toEqual([collectionReference(1)])
    release(); await settleCollection(); expect(f.storage.values.size).toBe(0); f.ui.close()
  })
  it('checks both legacy and new archives while holding the lock before migrating a basket', async () => {
    let release!: () => void
    const lock: RunCollectionLock = { run<T>(_name: string, _signal: AbortSignal, work: () => T) { return new Promise<T>((resolve, reject) => { release = () => { try { resolve(work()) } catch (cause) { reject(cause) } } }) } }
    const storage = collectionStorage(), legacyKey = 'xingmang.canvas.run-collection.v1.1.project'
    storage.setItem(legacyKey, JSON.stringify({ version: 1, references: [collectionReference(1)] }))
    const f = fixture({ lock }, storage); f.ui.render().add([collectionReference(2)])
    const legacyChanged = JSON.stringify({ version: 1, references: [collectionReference(3)] }); storage.setItem(legacyKey, legacyChanged)
    release(); await settleCollection(); expect(f.ui.render().conflict).not.toBeNull(); expect(storage.getItem(runCollectionScopeKey(f.access.scope))).toBeNull()
    f.ui.render().retryChanges(); release(); await settleCollection(); expect(f.ui.render().references).toEqual([collectionReference(3), collectionReference(2)]); expect(storage.getItem(legacyKey)).toBe(legacyChanged); f.ui.close()
  })
  it('leaves the entire newest fifty-item basket untouched when explicit retry exceeds its limit', async () => {
    const f = fixture(); f.ui.render()
    const latest = Array.from({ length: 50 }, (_, index) => collectionReference(index + 1))
    writeRunCollection(f.access.scope, latest, f.storage); const raw = f.storage.getItem(runCollectionScopeKey(f.access.scope))
    f.ui.render().add([collectionReference(51)]); await settleCollection(); expect(f.ui.render().conflict).not.toBeNull()
    f.ui.render().retryChanges(); await settleCollection(); expect(f.ui.render().storageError).toContain('整批未加入'); expect(f.storage.getItem(runCollectionScopeKey(f.access.scope))).toBe(raw); expect(f.ui.render().references).toEqual([collectionReference(51)]); f.ui.close()
  })
  it('persists ordered choices across sources, close reopen and page reload without storing media bodies', async () => {
    const f = fixture(); f.ui.render().add([collectionReference(2, 'older')]); f.ui.render().add([collectionReference(1)])
    let state = f.ui.render(); expect(state.references).toEqual([collectionReference(2, 'older'), collectionReference(1)])
    state.move(collectionReference(1).assetId, -1); state = f.ui.render(); expect(state.references[0]).toEqual(collectionReference(1))
    await settleCollection(); f.ui.close(); const reopened = harness(() => useRunResultCollection(f.access, f.storage, { lock: immediateLock })); state = reopened.render(); expect(state.references).toEqual([collectionReference(1), collectionReference(2, 'older')])
    expect(state.verification.loading).toBe(true); await settleCollection(); expect(reopened.render().verification.entries.every((entry) => entry.asset)).toBe(true)
    expect([...f.storage.values.values()].join('')).not.toMatch(/localUrl|https:|base64|model|prompt/); reopened.close()
  })
  it('makes the latest synchronous basket authoritative for rapid adds and rejects an oversized batch atomically', () => {
    const f = fixture(); const state = f.ui.render(); state.add([collectionReference(1)]); state.add([collectionReference(2)]); expect(f.ui.render().references).toHaveLength(2)
    state.add(Array.from({ length: 50 }, (_, index) => collectionReference(index + 3)))
    expect(f.ui.render().references).toHaveLength(2); expect(f.ui.render().action.error).toContain('整批未加入'); f.ui.close()
  })
  it.each(['account', 'project', 'runtime'] as const)('hides and invalidates original source validation immediately after %s changes', async (reason) => {
    const f = fixture(); let resolve!: (value: ReturnType<typeof collectionRun>) => void
    vi.mocked(f.access.onReadRun).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    f.ui.render().add([collectionReference()]); f.ui.render(); const signal = vi.mocked(f.access.onReadRun).mock.calls[0][1]
    if (reason === 'account') f.access.scope = { ...f.access.scope, accountId: 2 }
    if (reason === 'project') f.access.scope = { ...f.access.scope, projectId: 'other' }
    if (reason === 'runtime') f.access.runtimeScope = 'epoch-2'
    const state = f.ui.render(); expect(signal.aborted).toBe(true); expect(state.verification.entries).toEqual([])
    if (reason !== 'runtime') expect(state.references).toEqual([])
    resolve(collectionRun()); await settleCollection()
    expect(f.access.onAddMany).not.toHaveBeenCalled(); f.ui.close()
  })
  it('keeps corrupt storage untouched until explicit clear and still allows a clearly labelled temporary basket when storage is blocked', () => {
    const f = fixture(), key = runCollectionScopeKey(f.access.scope); f.storage.setItem(key, '{broken')
    expect(f.ui.render().corrupt).toBe(true); f.ui.render().add([collectionReference()]); expect(f.storage.getItem(key)).toBe('{broken'); expect(f.ui.render().references).toEqual([])
    f.ui.render().clear(); expect(f.ui.render().corrupt).toBe(false); f.ui.render().add([collectionReference()]); expect(f.ui.render().references).toHaveLength(1); f.ui.close()
    const blocked = harness(() => useRunResultCollection(f.access, { getItem() { throw Error('blocked') }, setItem() { throw Error('quota') } }, { lock: null }))
    expect(blocked.render().storageError).toContain('blocked'); blocked.render().clear(); blocked.render().add([collectionReference()])
    expect(blocked.render().references).toHaveLength(1); blocked.render().reload(); expect(blocked.render().references).toHaveLength(1); expect(blocked.render().storageError).toContain('本页'); blocked.close()
  })
  it('freezes the ordered basket, rereads original runs then dispatches exactly one existing add transaction', async () => {
    const f = fixture(); f.ui.render().add([collectionReference(3, 'older'), collectionReference(1)]); f.ui.render(); await settleCollection()
    vi.mocked(f.access.onReadRun).mockClear(); vi.mocked(f.access.onReadAsset).mockClear()
    const pending = f.ui.render().run('add'); f.ui.render().remove(collectionReference(1).assetId); f.ui.render().move(collectionReference(1).assetId, -1)
    await pending; expect(f.access.onReadRun).toHaveBeenCalledTimes(2)
    expect(f.access.onAddMany).toHaveBeenCalledExactlyOnceWith([collectionReference(3).assetId, collectionReference(1).assetId]); expect(f.ui.render().references).toHaveLength(2)
    expect(f.ui.render().action.notice).toContain('一次撤销'); expect(f.access.onDownloadMany).not.toHaveBeenCalled(); f.ui.close()
  })
  it('never dispatches a partial basket when one source or owner file fails during the final check', async () => {
    const f = fixture(); f.ui.render().add([collectionReference(1), collectionReference(2)]); f.ui.render(); await settleCollection()
    vi.mocked(f.access.onReadAsset).mockRejectedValueOnce(Error('文件已回收'))
    await f.ui.render().run('download'); expect(f.access.onDownloadMany).not.toHaveBeenCalled(); expect(f.ui.render().references).toHaveLength(2); expect(f.ui.render().action.error).toContain('整批未提交'); f.ui.close()
  })
  it('cancels only read verification and discards ignored-abort responses without submitting', async () => {
    const f = fixture(); f.ui.render().add([collectionReference()]); f.ui.render(); await settleCollection()
    let resolve!: (value: ReturnType<typeof collectionRun>) => void
    vi.mocked(f.access.onReadRun).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = f.ui.render().run('add'); f.ui.render().cancelCheck(); resolve(collectionRun()); await pending
    expect(f.access.onAddMany).not.toHaveBeenCalled(); expect(f.ui.render().action.notice).toContain('未提交'); expect(f.ui.render().references).toHaveLength(1); f.ui.close()
  })
  it('does not mislabel an accepted transaction as cancelled or mutate the next runtime after a late receipt', async () => {
    const f = fixture(); f.ui.render().add([collectionReference()]); f.ui.render(); await settleCollection()
    let finish!: () => void; vi.mocked(f.access.onDownloadMany!).mockImplementationOnce(() => new Promise((done) => { finish = done }))
    const pending = f.ui.render().run('download'); await settleCollection(); expect(f.ui.render().action.phase).toBe('accepted-download')
    f.ui.render().cancelCheck(); expect(f.ui.render().action.phase).toBe('accepted-download')
    f.access.runtimeScope = 'epoch-2'; f.ui.render(); finish(); await pending; expect(f.ui.render().action.notice).toBe(''); expect(f.access.onDownloadMany).toHaveBeenCalledOnce(); f.ui.close()
  })
  it('permits read-only download but never inserts nodes when no add port was granted', async () => {
    const f = fixture(); f.access.onAddMany = undefined; f.ui.render().add([collectionReference()]); f.ui.render(); await settleCollection()
    await f.ui.render().run('add'); expect(f.access.onDownloadMany).not.toHaveBeenCalled()
    await f.ui.render().run('download'); expect(f.access.onDownloadMany).toHaveBeenCalledOnce(); expect(f.ui.render().action.notice).toContain('打包窗口已结束'); expect(f.ui.render().action.notice).not.toMatch(/下载完成|已下载|下载事务已完成/); f.ui.close()
  })
})

interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type: unknown): ElementShape[] {
  if (Array.isArray(value)) return value.flatMap((item) => elements(item, type))
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const element = value as ElementShape
  return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)]
}
function textOf(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(textOf).join('')
  return value && typeof value === 'object' && 'props' in value ? textOf((value as ElementShape).props.children) : ''
}
function click(tree: unknown, label: string) { const found = elements(tree, 'button').find((item) => item.props['aria-label'] === label || textOf(item.props.children) === label); expect(found, label).toBeDefined(); (found!.props.onClick as () => void)() }
function dialogFixture() {
  const f = fixture(); f.ui.close(); vi.stubGlobal('window', { localStorage: f.storage }); vi.stubGlobal('navigator', { locks: { request: <T,>(_name: string, _options: unknown, work: () => T) => immediateLock.run(_name, new AbortController().signal, work) } }); vi.stubGlobal('HTMLElement', class {}); vi.stubGlobal('document', { activeElement: null, body: {} })
  const props: RunResultCollectionDialogProps = { ...f.access, onListHistory: vi.fn(async () => ({ items: [collectionSummary()], nextCursor: 'next-page', hasMore: true })), onPreviewAsset: vi.fn(), onClose: vi.fn() }
  return { ...f, props, dialog: harness(() => RunResultCollectionDialog(props)) }
}
describe('actual cross-run collection dialog controls', () => {
  it('shows explicit conflict choices and retries the local operation without restoring a removed old item', async () => {
    vi.useFakeTimers(); const f = dialogFixture(); f.dialog.render(); await vi.runAllTimersAsync(); f.dialog.render(); await settleCollection(); let tree = f.dialog.render()
    click(tree, '收集本次全部候选'); await settleCollection(); tree = f.dialog.render()
    writeRunCollection(f.props.scope, [collectionReference(2)], f.storage)
    click(tree, '移除收集素材 1'); await settleCollection(); tree = f.dialog.render()
    expect(textOf(tree)).toContain('其他页面已更新收集篮'); expect(textOf(tree)).toContain('采用最新收集篮')
    expect(elements(tree, 'button').find((item) => textOf(item.props.children) === '按顺序加入画布')?.props.disabled).toBe(true)
    click(tree, '按最新内容重试本页修改'); await settleCollection(); tree = f.dialog.render()
    expect(textOf(tree)).not.toContain('其他页面已更新收集篮'); expect(textOf(tree)).toContain('收集篮 1 / 50')
    expect(JSON.parse(f.storage.getItem(runCollectionScopeKey(f.props.scope))!).references).toEqual([collectionReference(2)]); expect(f.props.onAddMany).not.toHaveBeenCalled(); f.dialog.close()
  })
  it('does not describe an unreadable latest archive as an empty basket or offer blind retry', async () => {
    vi.useFakeTimers(); const f = dialogFixture(); f.dialog.render(); await vi.runAllTimersAsync(); f.dialog.render(); await settleCollection(); let tree = f.dialog.render()
    click(tree, '收集本次全部候选'); await settleCollection(); tree = f.dialog.render()
    f.storage.setItem(runCollectionScopeKey(f.props.scope), '{broken-newest')
    click(tree, '移除收集素材 1'); await settleCollection(); tree = f.dialog.render()
    expect(textOf(tree)).toContain('最新收集篮暂时无法读取'); expect(textOf(tree)).not.toContain('最新收集篮 0 项')
    expect(elements(tree, 'button').find((item) => textOf(item.props.children) === '按最新内容重试本页修改')?.props.disabled).toBe(true)
    expect(f.storage.getItem(runCollectionScopeKey(f.props.scope))).toBe('{broken-newest'); f.dialog.close()
  })
  it('keeps keyboard focus out of hidden source actions in a closed details element', () => {
    const f = dialogFixture(), tree = f.dialog.render()
    const first = { parentElement: null, getClientRects: () => [{}], focus: vi.fn() }, lastVisible = { parentElement: null, getClientRects: () => [{}], focus: vi.fn() }
    const details = { tagName: 'DETAILS', hasAttribute: () => false, querySelector: () => ({}), parentElement: null }
    const hidden = { parentElement: details, getClientRects: () => [{}], focus: vi.fn() }
    Object.assign(document, { activeElement: first })
    const section = elements(tree, 'section').find((item) => item.props.role === 'dialog')!
    ;(section.props.onKeyDown as (event: unknown) => void)({ key: 'Tab', shiftKey: true, stopPropagation: vi.fn(), preventDefault: vi.fn(), currentTarget: { querySelectorAll: () => [first, lastVisible, hidden] } })
    expect(lastVisible.focus).toHaveBeenCalledOnce(); expect(hidden.focus).not.toHaveBeenCalled(); f.dialog.close()
  })

  it('paginates summaries with cursors rather than retaining the last thirty records and reads selected detail on demand', async () => {
    vi.useFakeTimers(); const f = dialogFixture(); f.dialog.render(); await vi.runAllTimersAsync(); let tree = f.dialog.render(); await settleCollection(); tree = f.dialog.render()
    expect(f.props.onListHistory).toHaveBeenCalledWith({ q: '', limit: 25 }, expect.any(AbortSignal)); expect(f.props.onReadRun).toHaveBeenCalledWith('run-a', expect.any(AbortSignal))
    vi.mocked(f.props.onListHistory).mockResolvedValueOnce({ items: [collectionSummary('run-old-60')], nextCursor: null, hasMore: false })
    click(tree, '下一页运行历史'); f.dialog.render(); await vi.runAllTimersAsync(); tree = f.dialog.render()
    expect(f.props.onListHistory).toHaveBeenLastCalledWith({ q: '', cursor: 'next-page', limit: 25 }, expect.any(AbortSignal))
    const select = elements(tree, 'select').find((item) => item.props['aria-label'] === '选择收集来源运行')!
    ;(select.props.onChange as (event: unknown) => void)({ target: { value: 'run-old-60' } }); f.dialog.render(); await settleCollection(); tree = f.dialog.render()
    expect(f.props.onReadRun).toHaveBeenCalledWith('run-old-60', expect.any(AbortSignal)); expect(elements(tree, RunCollectionMedia).length).toBeGreaterThan(0); f.dialog.close()
  })
  it('debounces summary search and ignores a late prior query after runtime scope changes', async () => {
    vi.useFakeTimers(); const f = dialogFixture(); let resolve!: (value: Awaited<ReturnType<typeof f.props.onListHistory>>) => void
    vi.mocked(f.props.onListHistory).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    let tree = f.dialog.render(); await vi.runAllTimersAsync(); const signal = vi.mocked(f.props.onListHistory).mock.calls[0][1]
    const input = elements(tree, 'input')[0]; (input.props.onChange as (event: unknown) => void)({ target: { value: '原运行编号' } }); f.dialog.render()
    expect(signal.aborted).toBe(true); await vi.advanceTimersByTimeAsync(299); expect(f.props.onListHistory).toHaveBeenCalledOnce()
    f.props.runtimeScope = 'new'; tree = f.dialog.render(); resolve({ items: [collectionSummary('obsolete')], nextCursor: null, hasMore: false }); await settleCollection(); tree = f.dialog.render()
    expect(textOf(tree)).not.toContain('obsolete'); f.dialog.close()
  })
  it('collects a full run without changing candidates and exposes independent source and order controls', async () => {
    vi.useFakeTimers(); const f = dialogFixture(); f.dialog.render(); await vi.runAllTimersAsync(); f.dialog.render(); await settleCollection(); let tree = f.dialog.render()
    click(tree, '收集本次全部候选'); tree = f.dialog.render(); await settleCollection(); tree = f.dialog.render()
    expect(textOf(tree)).toContain('收集篮 3 / 50'); expect(f.props.onAddMany).not.toHaveBeenCalled(); expect(f.props.onDownloadMany).not.toHaveBeenCalled()
    click(tree, '前移收集素材 3'); tree = f.dialog.render(); click(tree, '移除收集素材 1'); tree = f.dialog.render(); expect(textOf(tree)).toContain('收集篮 2 / 50')
    click(tree, '关闭结果收集'); expect(f.props.onClose).toHaveBeenCalledOnce(); f.dialog.close()
  })
  it('supports all three media preview kinds using only freshly verified metadata', () => {
    const preview = vi.fn<(asset: CanvasRunCandidate['asset']) => void>()
    for (const [index, kind] of ['image', 'video', 'audio'].entries()) {
      const asset = collectionAsset(index + 1, kind as CanvasAssetSummary['mediaType']), entry = { reference: collectionReference(index + 1), asset }
      const tree = RunCollectionMedia({ entry, onPreview: preview, onError: vi.fn() })
      if (kind === 'image') click(tree, '预览收集图片'); else click(tree, '打开完整预览')
      expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind, assetId: asset.assetId, localUrl: asset.localUrl }))
    }
  })
})
