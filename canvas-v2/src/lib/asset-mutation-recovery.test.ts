import { describe, expect, it, vi } from 'vitest'
import { assetMutationInputIds, assetMutationRequestDigest, type AssetMutationInput, type AssetMutationResult } from './asset-mutation-contract'
import { AssetMutationNotSubmittedError, assetMutationRecoveryKey, createAssetMutationRecovery, parseAssetMutationJournal, type AssetMutationRecoveryLock, type AssetMutationRecoveryStorage } from './asset-mutation-recovery'

const owner = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const at = '2026-10-19T00:00:00.000Z'
const A = 'a'.repeat(43), B = 'b'.repeat(43)
function input(index = 1): AssetMutationInput { return { operationId: '10000000-0000-4000-8000-' + String(index).padStart(12, '0'), action: 'delete', assetIds: [A, B] } }
function deferred<T>() { let resolve: (value: T) => void = () => {}; let reject: (value: unknown) => void = () => {}; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function memory() {
  const values = new Map<string, string>()
  const storage: AssetMutationRecoveryStorage = { getItem(key) { return values.get(key) ?? null }, setItem(key, value) { values.set(key, value) }, removeItem(key) { values.delete(key) } }
  return { storage, values }
}
function lock(): AssetMutationRecoveryLock {
  let tail: Promise<unknown> = Promise.resolve()
  return { run<T>(_name: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> { const result = tail.catch(() => undefined).then(() => { signal.throwIfAborted(); return work() }); tail = result.catch(() => undefined); return result } }
}
async function result(value: AssetMutationInput): Promise<AssetMutationResult> {
  return { version: 1, operationId: value.operationId, requestDigest: await assetMutationRequestDigest(value), action: value.action, createdAt: at,
    outcomes: assetMutationInputIds(value).map((assetId, index) => ({ assetId, displayName: 'Own ' + index, state: index === 0 ? 'succeeded' : 'rejected', changed: index === 0, undoable: index === 0 && value.action !== 'undo', message: index === 0 ? '已完成' : '共享保护，未改动' })),
    ...(value.action === 'undo' ? { undoOf: { operationId: value.originalOperationId, requestDigest: value.originalRequestDigest } } : {}),
  }
}
function fixture(shared = memory(), sharedLock: AssetMutationRecoveryLock | null = lock(), account = owner) {
  let active = true
  const receipts = new Map<string, AssetMutationResult>()
  const apply = vi.fn(async (value: AssetMutationInput) => { const receipt = await result(value); receipts.set(value.operationId, receipt); return receipt })
  const inspect = vi.fn(async (value: AssetMutationInput) => {
    const found = receipts.get(value.operationId), requestDigest = await assetMutationRequestDigest(value)
    return found ? { status: 'applied' as const, operationId: value.operationId, requestDigest, result: found } : { status: 'missing' as const, operationId: value.operationId, requestDigest }
  })
  function port() { return createAssetMutationRecovery({ ownerId: account, active: () => active, apply, inspect, storage: () => shared.storage, lock: sharedLock, now: () => at }) }
  return { ...shared, receipts, apply, inspect, port, inactive() { active = false } }
}

describe('ordinary asset durable original operation recovery', () => {
  it('persists identity before the first request and retains partial receipts across a fresh controller', async () => {
    const f = fixture(), p = f.port(), original = input()
    f.apply.mockImplementationOnce(async (value) => {
      const saved = JSON.parse(f.values.get(p.key)!)
      expect(saved.ownerId).toBe(owner)
      expect(saved.entries[0].input).toEqual(value)
      expect(saved.entries[0].phase).toBe('pending')
      const receipt = await result(value); f.receipts.set(value.operationId, receipt); return receipt
    })
    const receipt = await p.submit(original)
    expect(receipt.outcomes.map((item) => item.state)).toEqual(['succeeded', 'rejected'])
    p.dispose()
    const reopened = f.port()
    const entries = await reopened.load()
    expect(entries[0].phase).toBe('confirmed')
    expect(f.apply).toHaveBeenCalledTimes(1)
    expect(reopened.snapshot().result).toBeNull()
    await reopened.inspect(entries[0].input)
    expect(reopened.snapshot().result).toEqual(receipt)
    expect(f.apply).toHaveBeenCalledTimes(1)
  })

  it('recovers a committed request whose response was lost without a second write', async () => {
    const f = fixture(), p = f.port(), original = input()
    f.apply.mockImplementationOnce(async (value) => { f.receipts.set(value.operationId, await result(value)); throw new Error('lost response after commit') })
    await expect(p.submit(original)).rejects.toThrow('lost response')
    p.dispose()
    const reopened = f.port(); await reopened.load()
    expect(reopened.snapshot().pending).toEqual(original)
    await expect(reopened.submit(input(2))).rejects.toThrow('待核对')
    await reopened.inspect(original)
    expect(reopened.snapshot().pending).toBeUndefined()
    expect(reopened.snapshot().result?.operationId).toBe(original.operationId)
    expect(f.apply).toHaveBeenCalledTimes(1)
  })

  it('requires a fresh missing inspection and retries only the same immutable input', async () => {
    const f = fixture(), p = f.port(), original = input()
    f.apply.mockRejectedValueOnce(new Error('disconnected before receipt'))
    await expect(p.submit(original)).rejects.toThrow()
    await expect(p.retry(original)).rejects.toThrow('尚未核对')
    await p.inspect(original)
    expect(p.snapshot().retryAvailable).toBe(true)
    await expect(p.retry({ operationId: original.operationId, action: 'delete', assetIds: [B, A] })).rejects.toThrow('尚未核对')
    await p.retry(original)
    expect(f.apply).toHaveBeenCalledTimes(2)
    expect(f.apply.mock.calls.map(([value]) => value)).toEqual([original, original])
    expect(p.snapshot().entries[0].attempt).toBe(2)
  })

  it('does not convert a missing confirmed receipt into permission to replay an old mutation', async () => {
    const f = fixture(), p = f.port(), original = input()
    await p.submit(original); f.receipts.clear()
    await expect(p.inspect(original)).rejects.toThrow('曾被确认')
    expect(p.snapshot().retryAvailable).toBe(false)
    await expect(p.retry(original)).rejects.toThrow()
    expect(f.apply).toHaveBeenCalledTimes(1)
  })

  it('blocks new writes for corrupt, oversized, foreign and unavailable journals', async () => {
    for (const raw of ['{broken', 'x'.repeat(128 * 1024 + 1), JSON.stringify({ version: 1, ownerId: other, entries: [] })]) {
      const f = fixture(), p = f.port(); f.values.set(p.key, raw)
      await expect(p.load()).rejects.toThrow()
      await expect(p.submit(input())).rejects.toThrow()
      expect(f.apply).not.toHaveBeenCalled()
      expect(f.values.get(p.key)).toBe(raw)
    }
    const f = fixture(), p = createAssetMutationRecovery({ ownerId: owner, active: () => true, apply: f.apply, inspect: f.inspect, storage: () => null, lock: lock() })
    await expect(p.submit(input())).rejects.toThrow()
    expect(f.apply).not.toHaveBeenCalled()
  })

  it('does not submit when storage silently discards or rejects the pending identity', async () => {
    for (const setItem of [() => {}, () => { throw new Error('quota') }]) {
      const f = fixture(), p = createAssetMutationRecovery({ ownerId: owner, active: () => true, apply: f.apply, inspect: f.inspect, storage: () => ({ getItem: () => null, setItem, removeItem() {} }), lock: lock() })
      await expect(p.submit(input())).rejects.toThrow('保存')
      expect(f.apply).not.toHaveBeenCalled()
    }
  })

  it('retains pending identity when saving a confirmed result fails and later inspects the original', async () => {
    const f = fixture(), originalSet = f.storage.setItem
    f.storage.setItem = (key, value) => { if (JSON.parse(value).entries.some((entry: { phase: string }) => entry.phase === 'confirmed')) throw new Error('quota after commit'); originalSet(key, value) }
    const p = f.port(), original = input()
    const error = await p.submit(original).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(AssetMutationNotSubmittedError)
    expect(JSON.parse(f.values.get(p.key)!).entries[0].phase).toBe('pending')
    expect(p.snapshot().result?.operationId).toBe(original.operationId)
    f.storage.setItem = originalSet
    const reopened = f.port(); await reopened.load(); await reopened.inspect(original)
    expect(reopened.snapshot().pending).toBeUndefined()
    expect(f.apply).toHaveBeenCalledTimes(1)
  })

  it('rejects wrong digests, ordering and undo origin instead of acknowledging a different receipt', async () => {
    for (const tamper of [
      (receipt: AssetMutationResult) => { receipt.requestDigest = '0'.repeat(64) },
      (receipt: AssetMutationResult) => { receipt.outcomes.reverse() },
    ]) {
      const f = fixture(), p = f.port()
      f.apply.mockImplementationOnce(async (value) => { const receipt = await result(value); tamper(receipt); return receipt })
      await expect(p.submit(input())).rejects.toThrow()
      expect(p.snapshot().pending?.operationId).toBe(input().operationId)
    }
    const f = fixture(), p = f.port()
    await p.submit(input())
    const inverse: AssetMutationInput = { operationId: input(2).operationId, action: 'undo', assetIds: [A], originalOperationId: input().operationId, originalRequestDigest: await assetMutationRequestDigest(input()) }
    f.apply.mockImplementationOnce(async (value) => ({ ...await result(value), undoOf: { operationId: input(3).operationId, requestDigest: '1'.repeat(64) } }))
    await expect(p.submit(inverse)).rejects.toThrow()
    expect(p.snapshot().pending).toEqual(inverse)
  })

  it('isolates account keys and fences a late response after close or account invalidation', async () => {
    expect(assetMutationRecoveryKey(owner)).not.toBe(assetMutationRecoveryKey(other))
    for (const invalidate of ['close', 'account'] as const) {
      const f = fixture(), p = f.port(), wait = deferred<AssetMutationResult>(), started = deferred<void>()
      f.apply.mockImplementationOnce(async () => { started.resolve(); return await wait.promise })
      const pending = p.submit(input()), rejected = expect(pending).rejects.toThrow(); await started.promise
      if (invalidate === 'close') p.dispose(); else f.inactive()
      wait.resolve(await result(input()))
      await rejected
      expect(JSON.parse(f.values.get(p.key)!).entries[0].phase).toBe('pending')
    }
  })

  it('stops waiting without removing or auto-resubmitting the original operation', async () => {
    const f = fixture(), p = f.port(), wait = deferred<AssetMutationResult>(), started = deferred<void>()
    f.apply.mockImplementationOnce(async () => { started.resolve(); return await wait.promise })
    const pending = p.submit(input()); await started.promise; p.stopWaiting()
    await expect(pending).rejects.toThrow('停止等待')
    wait.resolve(await result(input()))
    expect(JSON.parse(f.values.get(p.key)!).entries[0].phase).toBe('pending')
    expect(f.apply).toHaveBeenCalledTimes(1)
  })

  it('serializes competing tabs and prevents the second from replacing an unresolved request', async () => {
    const shared = memory(), sharedLock = lock(), f = fixture(shared, sharedLock), a = f.port(), b = f.port(), started = deferred<void>(), wait = deferred<AssetMutationResult>()
    f.apply.mockImplementationOnce(async () => { started.resolve(); return await wait.promise })
    const first = a.submit(input()); await started.promise
    const second = b.submit(input(2))
    a.stopWaiting(); await expect(first).rejects.toThrow()
    await expect(second).rejects.toThrow('待核对')
    wait.resolve(await result(input()))
    expect(JSON.parse(f.values.get(a.key)!).entries[0].input).toEqual(input())
    expect(f.apply).toHaveBeenCalledTimes(1)
  })

  it('does not consume a missing permit after another tab changes the journal', async () => {
    const f = fixture(), p = f.port()
    f.apply.mockRejectedValueOnce(new Error('offline')); await expect(p.submit(input())).rejects.toThrow()
    await p.inspect(input())
    const stored = JSON.parse(f.values.get(p.key)!); stored.entries[0].attempt = 2; f.values.set(p.key, JSON.stringify(stored))
    await expect(p.retry(input())).rejects.toThrow('尚未核对')
    expect(f.apply).toHaveBeenCalledTimes(1)
  })

  it('keeps the selected newer receipt when an older inspection arrives late', async () => {
    const f = fixture(), p = f.port()
    await p.submit(input()); await p.submit(input(2))
    const wait = deferred<Awaited<ReturnType<typeof f.inspect>>>(), started = deferred<void>()
    f.inspect.mockImplementationOnce(async () => { started.resolve(); return await wait.promise })
    const pending = p.inspect(input()); await started.promise
    p.select(input(2).operationId)
    wait.resolve({ status: 'applied', operationId: input().operationId, requestDigest: await assetMutationRequestDigest(input()), result: await result(input()) })
    await pending
    expect(p.snapshot().selectedOperationId).toBe(input(2).operationId)
    expect(p.snapshot().result?.operationId).toBe(input(2).operationId)
  })

  it('retains only bounded confirmed history and never evicts an unresolved request', async () => {
    const f = fixture(), p = f.port()
    for (let index = 1; index <= 22; index++) await p.submit(input(index))
    expect(p.snapshot().entries).toHaveLength(20)
    expect(p.snapshot().entries[0].input.operationId).toBe(input(3).operationId)
    f.apply.mockRejectedValueOnce(new Error('offline')); await expect(p.submit(input(23))).rejects.toThrow()
    await expect(p.submit(input(24))).rejects.toThrow('待核对')
    expect(p.snapshot().entries.at(-1)?.input).toEqual(input(23))
    expect(p.snapshot().entries).toHaveLength(20)
  })

  it('allows read-only receipt inspection without Web Locks while prohibiting mutation', async () => {
    const shared = memory(), f = fixture(shared), original = f.port()
    await original.submit(input())
    const readOnly = fixture(shared, null); readOnly.receipts.set(input().operationId, await result(input()))
    const p = readOnly.port(); await p.load(); await p.inspect(input())
    expect(p.snapshot().writeAvailable).toBe(false)
    expect(p.snapshot().result?.operationId).toBe(input().operationId)
    await expect(p.submit(input(2))).rejects.toThrow('跨页面')
    expect(readOnly.apply).not.toHaveBeenCalled()
  })

  it('strictly rejects multiple pending entries and input digest substitutions', async () => {
    const item = { input: input(), requestDigest: await assetMutationRequestDigest(input()), createdAt: at, attempt: 1, phase: 'pending' }
    await expect(parseAssetMutationJournal({ version: 1, ownerId: owner, entries: [item, { ...item, input: input(2), requestDigest: await assetMutationRequestDigest(input(2)) }] }, owner)).rejects.toThrow()
    await expect(parseAssetMutationJournal({ version: 1, ownerId: owner, entries: [{ ...item, input: { ...input(), assetIds: [B, A] } }] }, owner)).rejects.toThrow()
  })
})
