import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkshopOperationRecovery, parseWorkshopOperationJournal, parseWorkshopOperationGalleryJournal, parseWorkshopOperationRequest, workshopOperationRecoveryGalleryKey, workshopOperationRecoveryKey, workshopOperationRequestDigest, type WorkshopOperationCompletion, type WorkshopOperationRecoveryOptions, type WorkshopOperationRecoveryRecord, type WorkshopOperationRequest } from './workshop-operation-recovery'
import { parseCommunityWorkshopInspection, parseCommunityWorkshopReceipt } from './community-workshop-contract'
import { parseWorkshopTransferInspection, parseWorkshopTransferReceipt } from './workshop-transfer-contract'
import type { AssetMutationRecoveryLock, AssetMutationRecoveryStorage } from './asset-mutation-recovery'

const owner = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002', now = '2026-10-23T12:00:00.000Z'
const token = 's'.repeat(43), anotherToken = 't'.repeat(43)
function id(index = 1, prefix = '1') { return prefix + '0000000-0000-4000-8000-' + String(index).padStart(12, '0') }
function request(index = 1, variant: 'publish' | 'withdraw' | 'community-acquire' | 'share' | 'revoke' | 'share-acquire' = 'withdraw'): WorkshopOperationRequest {
  const operationId = id(index)
  if (variant === 'publish') return { family: 'community', action: 'publish', input: { operationId, sourceKind: 'prompt', sourceId: id(index, '3'), expectedSourceVersion: 1, authorName: '合成作者', previewDigest: 'a'.repeat(64), confirmPublic: true } }
  if (variant === 'withdraw' || variant === 'community-acquire') return { family: 'community', action: variant === 'withdraw' ? 'withdraw' : 'acquire', input: { operationId, id: id(index, '2'), expectedVersion: 1 } }
  if (variant === 'share') return { family: 'transfer', action: 'share', input: { operationId, source: { kind: 'prompt', id: id(index, '3'), expectedVersion: 1 }, authorName: '合成作者', onlyUse: true, limitAcquisitions: 3, previewDigest: 'b'.repeat(64), confirmShare: true } }
  if (variant === 'revoke') return { family: 'transfer', action: 'revoke', input: { operationId, id: id(index, '2'), expectedVersion: 1 } }
  return { family: 'transfer', action: 'acquire', input: { operationId, token, expectedVersion: 1 } }
}
function completion(value: WorkshopOperationRequest): WorkshopOperationCompletion {
  const operationId = value.input.operationId
  if (value.family === 'community') return { family: 'community', receipt: parseCommunityWorkshopReceipt({ action: value.action, operationId, publicationId: 'id' in value.input ? value.input.id : id(1, '2'), publicationVersion: value.action === 'withdraw' ? 2 : 1, ...(value.action === 'acquire' ? { owned: { id: id(1, '4'), kind: 'prompt', state: 'active' } } : {}) }) }
  return { family: 'transfer', receipt: parseWorkshopTransferReceipt({ action: value.action, operationId, shareId: 'id' in value.input ? value.input.id : id(1, '2'), ...(value.action === 'share' ? { share: { id: id(1, '2'), name: '合成分享', kind: 'prompt', authorName: '合成作者', onlyUse: true, limitAcquisitions: 3, acquisitionCount: 0, version: 1, createdAt: now, state: 'active', token } } : {}), ...(value.action === 'acquire' ? { owned: { id: id(1, '4'), kind: 'prompt', state: 'active' } } : {}) }) }
}
function memory() {
  const values = new Map<string, string>(), storage: AssetMutationRecoveryStorage = { getItem(key) { return values.get(key) ?? null }, setItem(key, value) { values.set(key, value) }, removeItem(key) { values.delete(key) } }
  return { values, storage }
}
function lock(): AssetMutationRecoveryLock {
  let tail: Promise<unknown> = Promise.resolve()
  return { run<T>(_name: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> { const result = tail.catch(() => undefined).then(() => { signal.throwIfAborted(); return work() }); tail = result.catch(() => undefined); return result } }
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(shared = memory(), sharedLock: AssetMutationRecoveryLock | null = lock(), account = owner, extras: Partial<WorkshopOperationRecoveryOptions> = {}) {
  let active = true
  const receipts = new Map<string, WorkshopOperationCompletion>()
  const apply = vi.fn(async (value: WorkshopOperationRequest) => { const result = completion(value); receipts.set(value.input.operationId, result); return result })
  const inspect = vi.fn(async (record: WorkshopOperationRecoveryRecord) => {
    const found = receipts.get(record.request.input.operationId), response = { operationId: record.request.input.operationId.toLowerCase(), requestDigest: record.requestDigest, ...(found ? { state: 'completed', receipt: found.receipt } : { state: 'missing' }) }
    return record.request.family === 'community' ? parseCommunityWorkshopInspection(response) : parseWorkshopTransferInspection(response)
  })
  function port() { return createWorkshopOperationRecovery({ ownerId: account, active: () => active, apply, inspect, storage: () => shared.storage, lock: sharedLock, now: () => now, ...extras }) }
  return { ...shared, receipts, apply, inspect, port, inactive() { active = false } }
}
function journal(f: ReturnType<typeof fixture>, key: string) { return JSON.parse(f.values.get(key)!) as { version: number; ownerId: string; entries: WorkshopOperationRecoveryRecord[] } }
afterEach(() => vi.useRealTimers())

describe('durable workshop publication and share operation recovery', () => {
  it.each(['publish', 'withdraw', 'community-acquire', 'share', 'revoke', 'share-acquire'] as const)('persists identity before inspection and submission and recovers %s through a fresh controller', async (variant) => {
    const f = fixture(), p = f.port(), original = request(1, variant)
    f.apply.mockImplementationOnce(async (value) => {
      const record = journal(f, p.key).entries[0]
      expect(record.phase).toBe('pending'); expect(record.requestDigest).toBe(await workshopOperationRequestDigest(value)); expect(record.request.input.operationId).toBe(value.input.operationId)
      expect(f.inspect).toHaveBeenCalledOnce()
      const result = completion(value); f.receipts.set(value.input.operationId, result); return result
    })
    const result = await p.submit(original)
    expect(journal(f, p.key).entries[0].phase).toBe('confirmed'); expect(f.apply).toHaveBeenCalledOnce(); expect(f.inspect).toHaveBeenCalledTimes(2)
    p.dispose()
    const reopened = f.port(); await reopened.reload()
    expect(reopened.snapshot().result).toBeNull()
    expect(await reopened.inspect(original.input.operationId)).toEqual(result)
    expect(reopened.snapshot().result).toEqual(result); expect(f.apply).toHaveBeenCalledOnce()
  })
  it('recovers a committed lost response without POST after reopening or from a second page', async () => {
    const f = fixture(), p = f.port(), original = request()
    f.apply.mockImplementationOnce(async (value) => { f.receipts.set(value.input.operationId, completion(value)); throw new Error('lost after commit') })
    await expect(p.submit(original)).rejects.toThrow('lost after commit')
    expect(journal(f, p.key).entries[0].phase).toBe('pending'); p.dispose()
    const b = f.port(); await b.reload(); await expect(b.submit(request(2))).rejects.toThrow('待核对')
    expect(await b.inspect()).toEqual(completion(original)); expect(b.snapshot().pending).toBeNull(); expect(f.apply).toHaveBeenCalledOnce()
  })
  it('requires a fresh missing permit and retries only the exact original operation and content', async () => {
    const f = fixture(), p = f.port(), original = request()
    f.apply.mockRejectedValueOnce(new Error('offline before commit'))
    await expect(p.submit(original)).rejects.toThrow('offline')
    await expect(p.retry()).rejects.toThrow('尚未核对')
    await p.inspect(); expect(p.snapshot().retryAvailable).toBe(true)
    await expect(p.retry(undefined, request(2))).rejects.toThrow('原内容')
    await p.inspect()
    const changed = { ...original, input: { ...original.input, expectedVersion: 2 } } as WorkshopOperationRequest
    await expect(p.retry(undefined, changed)).rejects.toThrow('原内容')
    await p.inspect(); await p.retry()
    expect(f.apply.mock.calls.map(([value]) => value)).toEqual([original, original]); expect(journal(f, p.key).entries[0].attempt).toBe(2)
  })
  it('never persists a share token or a token-bearing managed receipt and requires the original link for an acquisition retry', async () => {
    const f = fixture(), p = f.port(), original = request(1, 'share-acquire')
    f.apply.mockRejectedValueOnce(new Error('disconnected'))
    await expect(p.submit(original)).rejects.toThrow()
    expect(f.values.get(p.key)).not.toContain(token); expect(journal(f, p.key).entries[0].request.input).toEqual({ operationId: original.input.operationId, expectedVersion: 1 })
    p.dispose(); const reopened = f.port(); await reopened.reload(); await reopened.inspect()
    await expect(reopened.retry()).rejects.toThrow('原分享链接')
    const wrong = { ...original, input: { ...original.input, token: anotherToken } } as WorkshopOperationRequest
    await expect(reopened.retry(undefined, wrong)).rejects.toThrow('原内容')
    await reopened.inspect(); await reopened.retry(undefined, original)
    expect(f.values.get(p.key)).not.toContain(token); expect(f.apply.mock.calls.map(([value]) => value)).toEqual([original, original])
    const creator = fixture(), creatorPort = creator.port(); await creatorPort.submit(request(2, 'share'))
    expect(creatorPort.snapshot().result?.receipt).toHaveProperty('share.token', token)
    expect(creator.values.get(creatorPort.key)).not.toContain(token); expect(creator.values.get(creatorPort.key)).not.toContain('receipt')
  })
  it('does not POST when strong inspection is unsupported, malformed or bound to a different digest', async () => {
    for (const response of [new Error('404 old server'), { state: 'missing' }, { state: 'missing', operationId: id(), requestDigest: '0'.repeat(64) }]) {
      const f = fixture(), p = f.port()
      f.inspect.mockImplementationOnce(async () => { if (response instanceof Error) throw response; return response as Awaited<ReturnType<typeof f.inspect>> })
      await expect(p.submit(request())).rejects.toThrow(); expect(f.apply).not.toHaveBeenCalled(); expect(journal(f, p.key).entries[0].phase).toBe('pending')
    }
  })
  it('recovers an already committed server operation before POST even with a newly written local record', async () => {
    const f = fixture(), p = f.port(), original = request(1, 'publish'); f.receipts.set(original.input.operationId, completion(original))
    expect(await p.submit(original)).toEqual(completion(original)); expect(f.apply).not.toHaveBeenCalled(); expect(p.snapshot().pending).toBeNull()
  })
  it('does not resend confirmed history when the server later reports its receipt missing', async () => {
    const f = fixture(), p = f.port(); await p.submit(request()); f.receipts.clear()
    await expect(p.inspect()).rejects.toThrow('曾被确认'); expect(p.snapshot().retryAvailable).toBe(false)
    await expect(p.retry()).rejects.toThrow(); expect(f.apply).toHaveBeenCalledOnce()
  })
  it('returns the current managed share state from the original operation without replacing its identity', async () => {
    const f = fixture(), p = f.port(), original = request(1, 'share'); await p.submit(original)
    const first = f.receipts.get(original.input.operationId)!
    if (first.family !== 'transfer' || !first.receipt.share) throw new Error('fixture')
    first.receipt.share.state = 'revoked'; first.receipt.share.version = 2; first.receipt.share.revokedAt = now
    expect(await p.inspect()).toMatchObject({ family: 'transfer', receipt: { operationId: original.input.operationId, share: { state: 'revoked', version: 2 } } })
    expect(f.apply).toHaveBeenCalledOnce(); expect(journal(f, p.key).entries[0].requestDigest).toBe(await workshopOperationRequestDigest(original))
  })
  it('blocks corrupt, oversized, foreign-owner and digest-substituted records without overwriting them', async () => {
    for (const raw of ['{broken', 'x'.repeat(32 * 1024 + 1), JSON.stringify({ version: 1, ownerId: other, entries: [] })]) {
      const f = fixture(), p = f.port(); f.values.set(p.key, raw)
      await expect(p.reload()).rejects.toThrow(); await expect(p.submit(request())).rejects.toThrow()
      expect(f.apply).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled(); expect(f.values.get(p.key)).toBe(raw)
    }
    const f = fixture(), p = f.port(); f.apply.mockRejectedValueOnce(new Error('offline')); await expect(p.submit(request())).rejects.toThrow()
    const saved = journal(f, p.key); saved.entries[0].requestDigest = '0'.repeat(64); const raw = JSON.stringify(saved); f.values.set(p.key, raw)
    await expect(p.reload()).rejects.toThrow(); expect(f.values.get(p.key)).toBe(raw); expect(f.apply).toHaveBeenCalledOnce()
  })
  it('does not inspect or submit when pending identity cannot be durably written and read back', async () => {
    for (const setItem of [() => undefined, () => { throw new Error('quota') }]) {
      const f = fixture(), p = f.port()
      f.storage.setItem = setItem
      await expect(p.submit(request())).rejects.toThrow('保存'); expect(f.inspect).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled()
    }
    const f = fixture(), p = fixture(memory(), lock(), owner, { storage: () => null, apply: f.apply, inspect: f.inspect }).port()
    await expect(p.submit(request())).rejects.toThrow('存储'); expect(f.apply).not.toHaveBeenCalled()
  })
  it('keeps a committed result recoverable when the confirmed local write fails', async () => {
    const f = fixture(), originalSet = f.storage.setItem
    f.storage.setItem = (key, value) => { if (JSON.parse(value).entries.some((entry: { phase: string }) => entry.phase === 'confirmed')) throw new Error('quota after commit'); originalSet(key, value) }
    const p = f.port(); await expect(p.submit(request())).rejects.toThrow('保存')
    expect(journal(f, p.key).entries[0].phase).toBe('pending'); expect(f.apply).toHaveBeenCalledOnce()
    f.storage.setItem = originalSet
    const reopened = f.port(); await reopened.reload(); expect(await reopened.inspect()).toEqual(completion(request())); expect(reopened.snapshot().pending).toBeNull(); expect(f.apply).toHaveBeenCalledOnce()
  })
  it('allows read-only inspection without Web Locks and does not mutate the durable journal', async () => {
    const shared = memory(), f = fixture(shared), writer = f.port(); await writer.submit(request())
    const raw = f.values.get(writer.key), readOnly = fixture(shared, null); readOnly.receipts.set(id(), completion(request()))
    const p = readOnly.port(); await p.reload(); await p.inspect()
    expect(p.snapshot().result).toEqual(completion(request())); expect(p.snapshot().writeAvailable).toBe(false); expect(f.values.get(writer.key)).toBe(raw)
    await expect(p.submit(request(2))).rejects.toThrow('跨页面安全写入锁'); await expect(p.retry()).rejects.toThrow(); expect(readOnly.apply).not.toHaveBeenCalled()
  })
  it('serializes competing pages and keeps the unresolved original when a wait is stopped', async () => {
    const f = fixture(), a = f.port(), b = f.port(), started = deferred<void>(), late = deferred<WorkshopOperationCompletion>()
    f.apply.mockImplementationOnce(async () => { started.resolve(); return await late.promise })
    const first = a.submit(request()), firstRejection = expect(first).rejects.toThrow('停止等待'); await started.promise
    const second = b.submit(request(2)), secondRejection = expect(second).rejects.toThrow('待核对')
    a.stopWaiting(); await firstRejection; await secondRejection
    expect(journal(f, a.key).entries[0].request).toEqual(request()); expect(f.apply).toHaveBeenCalledOnce()
    late.resolve(completion(request()))
  })
  it('aborts a caller wait or times out without losing, confirming or automatically resubmitting the original', async () => {
    for (const mode of ['caller', 'timeout'] as const) {
      vi.useFakeTimers()
      const f = fixture(memory(), lock(), owner, { timeoutMs: 30 }), p = f.port(), started = deferred<void>(), late = deferred<WorkshopOperationCompletion>(), controller = new AbortController()
      f.apply.mockImplementationOnce(async () => { started.resolve(); return await late.promise })
      const pending = p.submit(request(), controller.signal), rejected = expect(pending).rejects.toThrow('停止等待'); await started.promise
      if (mode === 'caller') controller.abort(); else await vi.advanceTimersByTimeAsync(31)
      await rejected
      expect(journal(f, p.key).entries[0].phase).toBe('pending'); expect(p.snapshot().busy).toBe(false); expect(f.apply).toHaveBeenCalledOnce()
      late.resolve(completion(request())); await vi.advanceTimersByTimeAsync(0)
      expect(journal(f, p.key).entries[0].phase).toBe('pending'); vi.useRealTimers()
    }
  })
  it('fences late results after disposal or account invalidation and keeps owner journals isolated', async () => {
    expect(workshopOperationRecoveryKey(owner)).not.toBe(workshopOperationRecoveryKey(other)); expect(workshopOperationRecoveryKey(owner.toUpperCase())).toBe(workshopOperationRecoveryKey(owner))
    for (const invalidate of ['dispose', 'account'] as const) {
      const f = fixture(), p = f.port(), started = deferred<void>(), late = deferred<WorkshopOperationCompletion>()
      f.apply.mockImplementationOnce(async () => { started.resolve(); return await late.promise })
      const pending = p.submit(request()), rejected = expect(pending).rejects.toThrow('停止等待'); await started.promise
      if (invalidate === 'dispose') p.dispose(); else f.inactive()
      late.resolve(completion(request())); await rejected
      expect(journal(f, p.key).entries[0].phase).toBe('pending')
    }
  })
  it('does not consume a stale missing permit after reload or another page changes the attempt', async () => {
    for (const change of ['reload', 'storage'] as const) {
      const f = fixture(), p = f.port(); f.apply.mockRejectedValueOnce(new Error('offline')); await expect(p.submit(request())).rejects.toThrow(); await p.inspect()
      expect(p.snapshot().retryAvailable).toBe(true)
      if (change === 'reload') await p.reload(); else { const saved = journal(f, p.key); saved.entries[0].attempt = 2; f.values.set(p.key, JSON.stringify(saved)) }
      await expect(p.retry()).rejects.toThrow('尚未核对'); expect(f.apply).toHaveBeenCalledOnce()
    }
  })
  it('retains only bounded history and refuses to evict or over-retry an unresolved record', async () => {
    const f = fixture(), p = f.port()
    for (let index = 1; index <= 22; index++) await p.submit(request(index))
    expect(p.snapshot().entries).toHaveLength(20); expect(p.snapshot().entries[0].request.input.operationId).toBe(id(3))
    f.apply.mockRejectedValueOnce(new Error('offline')); await expect(p.submit(request(23))).rejects.toThrow()
    await expect(p.submit(request(24))).rejects.toThrow('待核对'); expect(journal(f, p.key).entries.at(-1)?.request.input.operationId).toBe(id(23))
    const saved = journal(f, p.key); saved.entries[saved.entries.length - 1].attempt = 8; f.values.set(p.key, JSON.stringify(saved))
    await p.reload(); await p.inspect(); await expect(p.retry()).rejects.toThrow('重试已达上限'); expect(f.apply).toHaveBeenCalledTimes(23)
  })
  it('keeps a definitive rejection visible without allowing its operation ID to be reused', async () => {
    const known = new Error('known 409'), f = fixture(memory(), lock(), owner, { rejected: (error) => error === known }), p = f.port()
    f.apply.mockRejectedValueOnce(known); await expect(p.submit(request())).rejects.toThrow('known 409')
    expect(journal(f, p.key).entries[0].phase).toBe('rejected'); await p.inspect(); expect(p.snapshot().retryAvailable).toBe(false)
    await expect(p.retry()).rejects.toThrow(); await expect(p.submit(request())).rejects.toThrow('编号已在记录'); await p.submit(request(2)); expect(f.apply).toHaveBeenCalledTimes(2)
  })
  it('times out a non-cooperative initial lookup without issuing a POST or discarding its identity', async () => {
    vi.useFakeTimers()
    const f = fixture(memory(), lock(), owner, { timeoutMs: 30 }), p = f.port(), started = deferred<void>(), late = deferred<Awaited<ReturnType<typeof f.inspect>>>()
    f.inspect.mockImplementationOnce(async () => { started.resolve(); return await late.promise })
    const pending = p.submit(request()), rejected = expect(pending).rejects.toThrow('停止等待'); await started.promise
    await vi.advanceTimersByTimeAsync(31); await rejected
    expect(f.apply).not.toHaveBeenCalled(); expect(journal(f, p.key).entries[0].phase).toBe('pending')
    late.resolve(parseCommunityWorkshopInspection({ state: 'missing', operationId: id(), requestDigest: await workshopOperationRequestDigest(request()) }))
    await vi.advanceTimersByTimeAsync(0); expect(f.apply).not.toHaveBeenCalled()
  })
  it('rejects a pre-aborted submission before storage, inspection or POST', async () => {
    const f = fixture(), p = f.port(), controller = new AbortController(); controller.abort()
    await expect(p.submit(request(), controller.signal)).rejects.toThrow('停止等待')
    expect(f.values.has(p.key)).toBe(false); expect(f.inspect).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled()
  })
  it('captures an immutable request before awaiting the original lookup', async () => {
    const f = fixture(), p = f.port(), original = request(1, 'share'), before = structuredClone(original), started = deferred<void>(), late = deferred<Awaited<ReturnType<typeof f.inspect>>>()
    f.inspect.mockImplementationOnce(async () => { started.resolve(); return await late.promise })
    const pending = p.submit(original); await started.promise
    if (original.family !== 'transfer' || original.action !== 'share') throw new Error('fixture')
    original.input.source.id = id(7, '3'); original.input.onlyUse = false; original.input.authorName = '修改后的署名'
    late.resolve(parseWorkshopTransferInspection({ state: 'missing', operationId: before.input.operationId, requestDigest: await workshopOperationRequestDigest(before) }))
    await pending; expect(f.apply.mock.calls[0][0]).toEqual(before); expect(journal(f, p.key).entries[0].request).toEqual(before)
  })
  it('fences a scope withdrawal before effect cleanup aborts the request signal', async () => {
    const f = fixture(), p = f.port(), started = deferred<void>(), late = deferred<Awaited<ReturnType<typeof f.inspect>>>(), caller = new AbortController()
    let permitted = true
    f.inspect.mockImplementationOnce(async () => { started.resolve(); return await late.promise })
    const pending = p.submit(request(), caller.signal, () => permitted), rejected = expect(pending).rejects.toThrow('停止等待'); await started.promise
    permitted = false
    expect(caller.signal.aborted).toBe(false)
    late.resolve(parseCommunityWorkshopInspection({ state: 'missing', operationId: id(), requestDigest: await workshopOperationRequestDigest(request()) }))
    await rejected
    expect(f.apply).not.toHaveBeenCalled(); expect(journal(f, p.key).entries[0].phase).toBe('pending')
  })
  it('does not confirm a late server receipt after scope withdrawal and later recovers it using a new scope', async () => {
    const f = fixture(), p = f.port(), started = deferred<void>(), late = deferred<Awaited<ReturnType<typeof f.inspect>>>(), caller = new AbortController()
    let permitted = true
    f.inspect.mockImplementationOnce(async (record) => parseCommunityWorkshopInspection({ state: 'missing', operationId: record.request.input.operationId, requestDigest: record.requestDigest }))
    f.inspect.mockImplementationOnce(async () => { started.resolve(); return await late.promise })
    const pending = p.submit(request(), caller.signal, () => permitted), rejected = expect(pending).rejects.toThrow('停止等待'); await started.promise
    permitted = false
    late.resolve(parseCommunityWorkshopInspection({ state: 'completed', operationId: id(), requestDigest: await workshopOperationRequestDigest(request()), receipt: completion(request()).receipt }))
    await rejected
    expect(journal(f, p.key).entries[0].phase).toBe('pending'); expect(p.snapshot().result).toBeNull(); expect(f.apply).toHaveBeenCalledOnce()
    const current = new AbortController()
    expect(await p.inspect(undefined, current.signal, () => true)).toEqual(completion(request()))
    expect(journal(f, p.key).entries[0].phase).toBe('confirmed'); expect(f.apply).toHaveBeenCalledOnce()
  })
  it('retains each aborted requests scope guard while a newer inspection uses the same controller port', async () => {
    const f = fixture(), p = f.port(), started = deferred<void>(), late = deferred<Awaited<ReturnType<typeof f.inspect>>>(), caller = new AbortController()
    let previousScope = true
    f.inspect.mockImplementationOnce(async () => { started.resolve(); return await late.promise })
    const pending = p.submit(request(), caller.signal, () => previousScope), rejected = expect(pending).rejects.toThrow(); await started.promise
    previousScope = false; caller.abort(); await rejected
    await p.inspect(undefined, new AbortController().signal, () => true)
    expect(p.snapshot().retryAvailable).toBe(true)
    late.resolve(parseCommunityWorkshopInspection({ state: 'missing', operationId: id(), requestDigest: await workshopOperationRequestDigest(request()) }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(p.snapshot().retryAvailable).toBe(true); expect(f.apply).not.toHaveBeenCalled()
  })
  it('honors an explicitly withdrawn reload scope even without a caller AbortSignal', async () => {
    const f = fixture(), p = f.port(); await p.submit(request())
    await expect(p.reload(undefined, () => false)).rejects.toThrow('停止等待')
  })
  it('strictly rejects multiple pending records and secret-bearing transfer records on journal reload', async () => {
    const first = request(), second = request(2), entry = { version: 1, request: first, requestDigest: await workshopOperationRequestDigest(first), createdAt: now, attempt: 1, phase: 'pending' }
    await expect(parseWorkshopOperationJournal({ version: 1, ownerId: owner, entries: [entry, { ...entry, request: second, requestDigest: await workshopOperationRequestDigest(second) }] }, owner)).rejects.toThrow()
    const acquire = request(1, 'share-acquire')
    await expect(parseWorkshopOperationJournal({ version: 1, ownerId: owner, entries: [{ ...entry, request: acquire, requestDigest: await workshopOperationRequestDigest(acquire) }] }, owner)).rejects.toThrow()
  })
  it('keeps the newly selected receipt when an older inspection completes late', async () => {
    const f = fixture(), p = f.port(); await p.submit(request()); await p.submit(request(2))
    const late = deferred<Awaited<ReturnType<typeof f.inspect>>>(), started = deferred<void>()
    f.inspect.mockImplementationOnce(async () => { started.resolve(); return await late.promise })
    const pending = p.inspect(id()); await started.promise; p.select(id(2))
    late.resolve(parseCommunityWorkshopInspection({ state: 'completed', operationId: id(), requestDigest: await workshopOperationRequestDigest(request()), receipt: completion(request()).receipt }))
    await pending
    expect(p.snapshot().selected?.request.input.operationId).toBe(id(2)); expect(p.snapshot().result?.receipt.operationId).toBe(id(2))
  })
  it('does not clear a newer selected receipt when an older pending inspection reports missing', async () => {
    const f = fixture(), p = f.port(); await p.submit(request())
    f.apply.mockRejectedValueOnce(new Error('offline')); await expect(p.submit(request(2))).rejects.toThrow()
    const late = deferred<Awaited<ReturnType<typeof f.inspect>>>(), started = deferred<void>()
    f.inspect.mockImplementationOnce(async () => { started.resolve(); return await late.promise })
    const pending = p.inspect(id(2)); await started.promise; p.select(id())
    late.resolve(parseCommunityWorkshopInspection({ state: 'missing', operationId: id(2), requestDigest: await workshopOperationRequestDigest(request(2)) }))
    await pending
    expect(p.snapshot().selected?.request.input.operationId).toBe(id()); expect(p.snapshot().result?.receipt.operationId).toBe(id())
    expect(p.snapshot().missing).toBe(false); expect(p.snapshot().retryAvailable).toBe(false)
    p.select(id(2)); expect(p.snapshot().missing).toBe(true); expect(p.snapshot().retryAvailable).toBe(true)
  })
  it('does not POST if another page replaces the saved identity during the pre-submit inspection', async () => {
    const f = fixture(), p = f.port()
    f.inspect.mockImplementationOnce(async (record) => {
      f.values.set(p.key, JSON.stringify({ version: 1, ownerId: owner, entries: [] }))
      return parseCommunityWorkshopInspection({ state: 'missing', operationId: record.request.input.operationId, requestDigest: record.requestDigest })
    })
    await expect(p.submit(request())).rejects.toThrow()
    expect(f.apply).not.toHaveBeenCalled()
    expect(journal(f, p.key).entries).toEqual([])
  })
})


function galleryRequest(index = 1): WorkshopOperationRequest {
  const value = request(index, 'publish')
  if (value.family !== 'community' || value.action !== 'publish') throw new Error('fixture')
  return { ...value, input: { ...value.input, exampleSelection: { version: 1, items: [{ assetId: 'A'.repeat(43), alt: '封面说明' }, { assetId: 'B'.repeat(43), alt: '第二张' }] } } }
}
async function seededRecord(value: WorkshopOperationRequest, version: 1 | 2, phase: WorkshopOperationRecoveryRecord['phase'] = 'pending'): Promise<WorkshopOperationRecoveryRecord> {
  return { version, request: value, requestDigest: await workshopOperationRequestDigest(value), createdAt: now, attempt: 1, phase }
}
function seedCarrier(f: ReturnType<typeof fixture>, version: 1 | 2, entries: WorkshopOperationRecoveryRecord[], spacing?: number) {
  const key = version === 1 ? workshopOperationRecoveryKey(owner) : workshopOperationRecoveryGalleryKey(owner)
  const raw = JSON.stringify({ version, ownerId: owner, entries }, null, spacing)
  f.values.set(key, raw); return raw
}
describe('independent gallery publication recovery carrier', () => {
  it('preserves the exact deployed seven-field v1 request and original journal bytes', async () => {
    const f = fixture(), original = request(1, 'publish')
    const raw = seedCarrier(f, 1, [await seededRecord(original, 1, 'confirmed')], 2)
    const p = f.port(), value = galleryRequest(2), key = workshopOperationRecoveryGalleryKey(owner)
    await p.submit(value)
    expect(f.values.get(p.key)).toBe(raw)
    expect(journal(f, key)).toMatchObject({ version: 2, entries: [{ version: 2, phase: 'confirmed', request: value }] })
    expect(p.keys).toEqual([p.key, key])
    expect(Object.keys(parseWorkshopOperationRequest(original).input)).toHaveLength(7)
    expect(() => parseWorkshopOperationRequest(value)).toThrow()
    const old = original.family === 'community' && original.action === 'publish' ? original.input : null
    if (!old) throw new Error('fixture')
    const legacyDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ action: 'publish', sourceKind: old.sourceKind, sourceId: old.sourceId, expectedSourceVersion: old.expectedSourceVersion, authorName: old.authorName, previewDigest: old.previewDigest }))))].map((v) => v.toString(16).padStart(2, '0')).join('')
    expect(await workshopOperationRequestDigest(original)).toBe(legacyDigest)
    expect(await workshopOperationRequestDigest(value)).not.toBe(legacyDigest)
  })
  it('recovers a committed gallery response with only GET and does not modify legacy history', async () => {
    const f = fixture(), original = galleryRequest(), p = f.port(), key = workshopOperationRecoveryGalleryKey(owner)
    const legacy = seedCarrier(f, 1, [await seededRecord(request(7), 1, 'confirmed')], 2)
    f.apply.mockImplementationOnce(async (value) => { f.receipts.set(value.input.operationId, completion(value)); throw new Error('lost gallery commit response') })
    await expect(p.submit(original)).rejects.toThrow('lost gallery')
    const pending = f.values.get(key); p.dispose()
    const reopened = f.port(); await reopened.reload()
    expect(f.values.get(key)).toBe(pending); expect(f.apply).toHaveBeenCalledOnce()
    expect(await reopened.inspect()).toEqual(completion(original))
    expect(f.apply).toHaveBeenCalledOnce(); expect(f.values.get(p.key)).toBe(legacy)
    expect(journal(f, key).entries[0].phase).toBe('confirmed')
  })
  it('requires explicit missing inspection and retries the frozen gallery order, author and source', async () => {
    const f = fixture(), original = galleryRequest(), p = f.port(), key = workshopOperationRecoveryGalleryKey(owner)
    f.apply.mockRejectedValueOnce(new Error('offline'))
    await expect(p.submit(original)).rejects.toThrow('offline'); p.dispose()
    const reopened = f.port(); await reopened.reload()
    await expect(reopened.retry()).rejects.toThrow('尚未核对')
    const mutations: Array<(input: Record<string, unknown>) => void> = [
      (input) => { const selection = input.exampleSelection as { items: unknown[] }; selection.items.reverse() },
      (input) => { const selection = input.exampleSelection as { items: Array<{ alt: string }> }; selection.items[0].alt = 'changed' },
      (input) => { input.authorName = 'changed' }, (input) => { input.expectedSourceVersion = 2 }, (input) => { input.sourceId = id(8, '3') },
    ]
    for (const mutate of mutations) {
      await reopened.inspect()
      const changed = structuredClone(original); mutate(changed.input as unknown as Record<string, unknown>)
      await expect(reopened.retry(undefined, changed)).rejects.toThrow('原内容')
    }
    await reopened.inspect(); await reopened.retry()
    expect(f.apply.mock.calls.map(([value]) => value)).toEqual([original, original])
    expect(journal(f, key).entries[0].attempt).toBe(2)
    expect(f.values.has(p.key)).toBe(false)
  })
  it('exposes two pending carriers separately without overriding either, and blocks only unresolved history', async () => {
    const f = fixture(), legacyRequest = request(1), gallery = galleryRequest(2)
    seedCarrier(f, 1, [await seededRecord(legacyRequest, 1)])
    const galleryRaw = seedCarrier(f, 2, [await seededRecord(gallery, 2)], 2)
    const p = f.port(); await p.reload()
    expect(p.snapshot().entries).toHaveLength(2)
    expect(p.snapshot().pending?.request.input.operationId).toBe(legacyRequest.input.operationId)
    expect(p.snapshot().selected?.request.input.operationId).toBe(legacyRequest.input.operationId)
    await expect(p.submit(request(3))).rejects.toThrow('待核对')
    p.select(gallery.input.operationId); await p.inspect(gallery.input.operationId)
    expect(f.values.get(workshopOperationRecoveryGalleryKey(owner))).toBe(galleryRaw)
    f.receipts.set(gallery.input.operationId, completion(gallery)); await p.inspect(gallery.input.operationId)
    expect(p.snapshot().pending?.request.input.operationId).toBe(legacyRequest.input.operationId)
    await expect(p.submit(request(3))).rejects.toThrow('待核对')
    f.receipts.set(legacyRequest.input.operationId, completion(legacyRequest)); await p.inspect(legacyRequest.input.operationId)
    expect(p.snapshot().pending).toBeNull()
    await p.submit(request(3)); expect(f.apply).toHaveBeenCalledOnce()
  })
  it('preserves corrupt, foreign, incompatible and duplicate-operation carriers without POST or overwrite', async () => {
    const good = fixture(), legacy = seedCarrier(good, 1, [await seededRecord(request(3), 1, 'confirmed')], 2)
    const saved = { version: 2, ownerId: owner, entries: [await seededRecord(galleryRequest(), 2)] }
    for (const bad of ['{broken', 'x'.repeat(32769), JSON.stringify({ ...saved, ownerId: other }), JSON.stringify({ ...saved, version: 1 }), JSON.stringify({ ...saved, entries: [{ ...saved.entries[0], request: request(1, 'publish') }] })]) {
      const f = fixture(), p = f.port(), key = workshopOperationRecoveryGalleryKey(owner)
      f.values.set(p.key, legacy); f.values.set(key, bad)
      await expect(p.reload()).rejects.toThrow(); await expect(p.submit(request(8))).rejects.toThrow()
      expect(f.values.get(p.key)).toBe(legacy); expect(f.values.get(key)).toBe(bad)
      expect(f.apply).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled()
    }
    const f = fixture(), p = f.port()
    const first = seedCarrier(f, 1, [await seededRecord(request(1, 'publish'), 1)])
    const second = seedCarrier(f, 2, [await seededRecord(galleryRequest(1), 2)])
    await expect(p.reload()).rejects.toThrow('冲突'); await expect(p.submit(request(9))).rejects.toThrow('冲突')
    expect(f.values.get(p.key)).toBe(first); expect(f.values.get(workshopOperationRecoveryGalleryKey(owner))).toBe(second)
    expect(f.apply).not.toHaveBeenCalled()
  })
  it('does not POST if the other carrier changes during gallery preflight, and invalidates stale retry permits', async () => {
    const f = fixture(), p = f.port(), initialInspect = f.inspect.getMockImplementation()!
    f.inspect.mockImplementationOnce(async (record) => { seedCarrier(f, 1, []); return await initialInspect(record) })
    await expect(p.submit(galleryRequest())).rejects.toThrow('已变化')
    expect(f.apply).not.toHaveBeenCalled()
    await p.inspect(); const before = f.values.get(workshopOperationRecoveryGalleryKey(owner))
    f.values.set(p.key, JSON.stringify({ version: 1, ownerId: owner, entries: [] }, null, 2))
    await expect(p.retry()).rejects.toThrow('尚未核对')
    expect(f.values.get(workshopOperationRecoveryGalleryKey(owner))).toBe(before)
    expect(f.apply).not.toHaveBeenCalled()
  })
  it('keeps both raw carriers unchanged during lockless inspection and prunes only the destination carrier', async () => {
    const shared = memory(), f = fixture(shared), p = f.port()
    const legacy = seedCarrier(f, 1, [await seededRecord(request(50), 1, 'confirmed')], 2)
    for (let index = 1; index <= 21; index += 1) await p.submit(galleryRequest(index))
    const key = workshopOperationRecoveryGalleryKey(owner), raw = f.values.get(key)
    expect(journal(f, key).entries).toHaveLength(20); expect(f.values.get(p.key)).toBe(legacy)
    const reader = fixture(shared, null); reader.receipts.set(id(21), completion(galleryRequest(21)))
    const reopened = reader.port(); await reopened.reload(); await reopened.inspect(id(21))
    expect(reopened.snapshot().result).toEqual(completion(galleryRequest(21)))
    expect(f.values.get(key)).toBe(raw); expect(f.values.get(p.key)).toBe(legacy); expect(reader.apply).not.toHaveBeenCalled()
  })
  it('rejects an invalid gallery owner and malformed canonical selection in the v2 parser', async () => {
    const record = await seededRecord(galleryRequest(), 2)
    await expect(parseWorkshopOperationGalleryJournal({ version: 2, ownerId: owner, entries: [record] }, 'invalid')).rejects.toThrow()
    const request = structuredClone(record.request)
    if (request.family !== 'community' || request.action !== 'publish' || !request.input.exampleSelection) throw new Error('fixture')
    request.input.exampleSelection.items[0].alt = ' trimmed '
    await expect(parseWorkshopOperationGalleryJournal({ version: 2, ownerId: owner, entries: [{ ...record, request }] }, owner)).rejects.toThrow()
  })
})
