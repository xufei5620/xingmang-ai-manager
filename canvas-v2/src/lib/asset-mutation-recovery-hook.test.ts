import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assetMutationInputIds, assetMutationRequestDigest, type AssetMutationInput, type AssetMutationInspection, type AssetMutationResult } from './asset-mutation-contract'
import { assetMutationRecoveryKey, type AssetMutationRecoveryLock, type AssetMutationRecoveryStorage } from './asset-mutation-recovery'

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef(initial: unknown) { const index = hooks.cursor++; hooks.slots[index] ??= { current: initial }; return hooks.slots[index] },
  useState(initial: unknown) { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial; return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value }] },
  useCallback(callback: unknown, dependencies: readonly unknown[]) { const index = hooks.cursor++, previous = hooks.slots[index] as { dependencies: readonly unknown[]; value: unknown } | undefined; if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return previous.value; hooks.slots[index] = { dependencies, value: callback }; return callback },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) { const index = hooks.cursor++, previous = hooks.slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void; effect: typeof effect } | undefined; if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return; hooks.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.slots[index] = { dependencies, effect, ...(typeof cleanup === 'function' ? { cleanup } : {}) } }) },
}))
import { useAssetMutationRecovery, type AssetMutationRecoveryHookOptions } from './asset-mutation-recovery-hook'

const owner = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002', at = '2026-10-19T00:00:00.000Z'
const input: AssetMutationInput = { operationId: '10000000-0000-4000-8000-000000000001', action: 'delete', assetIds: ['a'.repeat(43)] }
let surface: EventTarget
function close() { for (const slot of hooks.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot && typeof slot.cleanup === 'function') slot.cleanup() }
function render(options: AssetMutationRecoveryHookOptions, effects = true) { hooks.cursor = 0; const state = useAssetMutationRecovery(options); if (effects) hooks.effects.splice(0).forEach((effect) => effect()); return state }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes }); return { promise, resolve } }
async function reply(): Promise<AssetMutationResult> { return { version: 1, operationId: input.operationId, requestDigest: await assetMutationRequestDigest(input), action: input.action, createdAt: at, outcomes: assetMutationInputIds(input).map((assetId) => ({ assetId, displayName: '本人素材', state: 'succeeded', changed: true, undoable: true, message: '已移入回收站' })) } }
function fixture() {
  const values = new Map<string, string>(), storage: AssetMutationRecoveryStorage = { getItem(key) { return values.get(key) ?? null }, setItem(key, value) { values.set(key, value) }, removeItem(key) { values.delete(key) } }
  const lock: AssetMutationRecoveryLock = { async run(_key, signal, work) { signal.throwIfAborted(); return await work() } }
  const apply = vi.fn(async () => await reply()), inspect = vi.fn(async (): Promise<AssetMutationInspection> => ({ status: 'missing', operationId: input.operationId, requestDigest: await assetMutationRequestDigest(input) }))
  const options: AssetMutationRecoveryHookOptions = { ownerId: owner, active: true, storage: () => storage, lock, apply, inspect, now: () => at }
  return { values, storage, apply, inspect, options }
}
async function seed(values: Map<string, string>, phase: 'pending' | 'confirmed' = 'pending') { values.set(assetMutationRecoveryKey(owner), JSON.stringify({ version: 1, ownerId: owner, entries: [{ input, requestDigest: await assetMutationRequestDigest(input), createdAt: at, attempt: 1, phase }] })) }
async function settled(options: AssetMutationRecoveryHookOptions) { await vi.waitFor(() => { const state = render(options); expect(state.loading || state.busy).toBe(false) }); return render(options) }
function storageEvent(key: string | null) { const event = new Event('storage'); Object.defineProperty(event, 'key', { value: key }); surface.dispatchEvent(event) }
beforeEach(() => { hooks.cursor = 0; hooks.slots = []; hooks.effects = []; surface = new EventTarget(); vi.stubGlobal('window', surface) })
afterEach(() => { close(); vi.unstubAllGlobals() })

describe('actual ordinary asset recovery hook', () => {
  it('rehydrates a pending original identity and only reads its receipt on mount', async () => {
    const f = fixture(); await seed(f.values)
    f.inspect.mockResolvedValue({ status: 'applied', operationId: input.operationId, requestDigest: await assetMutationRequestDigest(input), result: await reply() })
    render(f.options); const state = await settled(f.options)
    expect(state.ready).toBe(true); expect(state.pending).toBeUndefined(); expect(state.result?.operationId).toBe(input.operationId)
    expect(f.inspect).toHaveBeenCalledOnce(); expect(f.apply).not.toHaveBeenCalled()
    expect(JSON.parse(f.values.get(assetMutationRecoveryKey(owner))!).entries[0].phase).toBe('confirmed')
  })
  it('does not replay a missing original until an explicit same-input retry', async () => {
    const f = fixture(); await seed(f.values); render(f.options); const state = await settled(f.options)
    expect(state.pending).toEqual(input); expect(state.retryAvailable).toBe(true)
    expect(f.apply).not.toHaveBeenCalled(); expect(f.inspect).toHaveBeenCalledOnce()
    await state.retry(input)
    expect(f.apply).toHaveBeenCalledOnce(); expect(render(f.options).pending).toBeUndefined()
  })
  it('uses latest endpoint callbacks without remounting on parent renders', async () => {
    const f = fixture(); await seed(f.values); render(f.options); const state = await settled(f.options)
    const add = vi.spyOn(surface, 'addEventListener'), apply = vi.fn(async () => await reply()), inspect = vi.fn(async (value: AssetMutationInput, signal?: AbortSignal) => await f.options.inspect(value, signal))
    const newer = render({ ...f.options, apply, inspect })
    expect(newer.retry).toBe(state.retry); expect(add).not.toHaveBeenCalled()
    await newer.retry(input)
    expect(apply).toHaveBeenCalledOnce(); expect(f.apply).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled()
  })
  it('ignores a foreign owner storage event and reloads this owner with reads only', async () => {
    const f = fixture(); render(f.options); await settled(f.options); await seed(f.values)
    storageEvent(assetMutationRecoveryKey(other)); expect(render(f.options).entries).toHaveLength(0)
    storageEvent(assetMutationRecoveryKey(owner)); await vi.waitFor(() => expect(render(f.options).pending).toEqual(input)); await settled(f.options)
    expect(f.inspect).toHaveBeenCalledOnce(); expect(f.apply).not.toHaveBeenCalled()
  })
  it('hides old owner state and rejects captured callbacks through owner ABA before effects run', async () => {
    const f = fixture(); await seed(f.values); render(f.options); const old = await settled(f.options)
    expect(render({ ...f.options, ownerId: other }, false).entries).toHaveLength(0)
    expect(render(f.options, false).ready).toBe(false)
    await expect(old.retry(input)).rejects.toThrow('账号或权限已变化')
    expect(f.apply).not.toHaveBeenCalled()
  })
  it('retains original pending identity when a late mutation resolves after access withdrawal', async () => {
    const f = fixture(), gate = deferred<AssetMutationResult>(); f.apply.mockImplementation(() => gate.promise)
    render(f.options); const state = await settled(f.options), sending = state.submit(input), rejected = expect(sending).rejects.toThrow()
    await vi.waitFor(() => expect(f.apply).toHaveBeenCalledOnce())
    render({ ...f.options, active: false }); expect(render({ ...f.options, active: false }).entries).toHaveLength(0)
    render(f.options); gate.resolve(await reply()); await rejected
    const restored = await settled(f.options)
    expect(restored.pending).toEqual(input)
    expect(JSON.parse(f.values.get(assetMutationRecoveryKey(owner))!).entries[0].phase).toBe('pending')
  })
  it('creates a fresh usable controller after StrictMode effect replay', async () => {
    const f = fixture(); await seed(f.values); render(f.options); await settled(f.options)
    for (const slot of hooks.slots) if (slot && typeof slot === 'object' && 'effect' in slot && 'dependencies' in slot) {
      const entry = slot as { effect(): void | (() => void); cleanup?: () => void }; entry.cleanup?.(); const cleanup = entry.effect(); entry.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
    const state = await settled(f.options)
    expect(state.pending).toEqual(input); expect(state.retryAvailable).toBe(true)
    await state.retry(input); expect(f.apply).toHaveBeenCalledOnce()
  })
  it('keeps a damaged journal intact and never invokes an endpoint on mount', async () => {
    const f = fixture(); f.values.set(assetMutationRecoveryKey(owner), '{broken'); render(f.options); const state = await settled(f.options)
    expect(state.ready).toBe(false); expect(state.error).toContain('记录')
    expect(f.values.get(assetMutationRecoveryKey(owner))).toBe('{broken')
    expect(f.apply).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled()
  })
})
