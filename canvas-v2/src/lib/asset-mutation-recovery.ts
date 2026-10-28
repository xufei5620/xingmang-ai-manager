import { isCanvasPublicAccountId } from './canvas-account-contract'
import { assetMutationRequestDigest, confirmAssetMutationResult, isAssetMutationResult, parseAssetMutationInput, parseAssetMutationInspection, type AssetMutationInput, type AssetMutationInspection, type AssetMutationResult } from './asset-mutation-contract'

export const assetMutationRecoveryLimits = { version: 1, entries: 20, bytes: 128 * 1024, attempts: 8, timeoutMs: 15_000 } as const
export interface AssetMutationJournalEntry {
  input: AssetMutationInput
  requestDigest: string
  createdAt: string
  attempt: number
  phase: 'pending' | 'confirmed'
}
export interface AssetMutationJournal {
  version: 1
  ownerId: string
  entries: AssetMutationJournalEntry[]
}
export interface AssetMutationRecoveryStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface AssetMutationRecoveryLock { run<T>(name: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> }
export interface AssetMutationRecoveryOptions {
  ownerId: string
  active(): boolean
  apply(input: AssetMutationInput, signal?: AbortSignal): Promise<AssetMutationResult>
  inspect(input: AssetMutationInput, signal?: AbortSignal): Promise<AssetMutationInspection>
  storage?: () => AssetMutationRecoveryStorage | null
  lock?: AssetMutationRecoveryLock | null
  timeoutMs?: number
  now?(): string
}
export interface AssetMutationRecoveryState {
  entries: AssetMutationJournalEntry[]
  pending?: AssetMutationInput
  selectedOperationId?: string
  result: AssetMutationResult | null
  ready: boolean
  loading: boolean
  busy: boolean
  error: string
  writeAvailable: boolean
  writeError: string
  retryAvailable: boolean
}
export interface AssetMutationRecoveryPort {
  key: string
  snapshot(): AssetMutationRecoveryState
  subscribe(listener: (state: AssetMutationRecoveryState) => void): () => void
  load(signal?: AbortSignal): Promise<AssetMutationJournalEntry[]>
  select(operationId: string): void
  submit(input: AssetMutationInput, signal?: AbortSignal): Promise<AssetMutationResult>
  inspect(input: AssetMutationInput, signal?: AbortSignal): Promise<AssetMutationInspection>
  retry(input: AssetMutationInput, signal?: AbortSignal): Promise<AssetMutationResult>
  stopWaiting(): void
  dispose(): void
}
export class AssetMutationNotSubmittedError extends Error {}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function invalid(): never { throw new Error('本机素材操作记录损坏、版本不受支持或账号不一致；请保留记录并重新核对，尚未提交新操作。') }
function stopped(): Error { return new Error('已停止等待，原素材操作记录仍保留；已经提交的操作不会因此撤销，请核对原结果。') }
function browserStorage(): AssetMutationRecoveryStorage | null { try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null } }
function browserLock(): AssetMutationRecoveryLock | null {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return null
  return { async run<T>(name: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> { return await navigator.locks.request(name, { mode: 'exclusive', signal }, work) } }
}
export function assetMutationRecoveryKey(ownerId: string): string {
  if (!isCanvasPublicAccountId(ownerId)) throw new Error('素材操作所属账号无法确认，请重新进入工作区。')
  return 'xingmang:asset-mutation-recovery:v1:' + ownerId.toLowerCase()
}
export async function parseAssetMutationJournal(value: unknown, ownerId: string): Promise<AssetMutationJournal> {
  assetMutationRecoveryKey(ownerId)
  if (!object(value) || Object.keys(value).some((key) => !['version', 'ownerId', 'entries'].includes(key)) || value.version !== 1 || value.ownerId !== ownerId.toLowerCase() || !Array.isArray(value.entries) || value.entries.length > assetMutationRecoveryLimits.entries) invalid()
  const entries: AssetMutationJournalEntry[] = []
  for (const item of value.entries) {
    if (!object(item) || Object.keys(item).some((key) => !['input', 'requestDigest', 'createdAt', 'attempt', 'phase'].includes(key))
      || typeof item.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.requestDigest)
      || typeof item.createdAt !== 'string' || item.createdAt.length > 32 || !Number.isFinite(Date.parse(item.createdAt))
      || typeof item.attempt !== 'number' || !Number.isSafeInteger(item.attempt) || item.attempt < 1 || item.attempt > assetMutationRecoveryLimits.attempts
      || item.phase !== 'pending' && item.phase !== 'confirmed') invalid()
    let input: AssetMutationInput
    try { input = parseAssetMutationInput(item.input) } catch { invalid() }
    if (JSON.stringify(input) !== JSON.stringify(item.input) || await assetMutationRequestDigest(input) !== item.requestDigest) invalid()
    entries.push({ input, requestDigest: item.requestDigest, createdAt: item.createdAt, attempt: item.attempt, phase: item.phase })
  }
  if (new Set(entries.map((item) => item.input.operationId)).size !== entries.length || entries.filter((item) => item.phase === 'pending').length > 1) invalid()
  const journal: AssetMutationJournal = { version: 1, ownerId: ownerId.toLowerCase(), entries }
  if (new TextEncoder().encode(JSON.stringify(journal)).byteLength > assetMutationRecoveryLimits.bytes) invalid()
  return journal
}

/** Browser persistence preserves identities, never substitutes current asset
 * state for an original receipt. An unresolved write is never evicted, retried
 * automatically, or replaced by a new operation after a missing observation. */
export function createAssetMutationRecovery(options: AssetMutationRecoveryOptions): AssetMutationRecoveryPort {
  const key = assetMutationRecoveryKey(options.ownerId), ownerId = options.ownerId.toLowerCase()
  const storage = options.storage ?? browserStorage, lock = options.lock === undefined ? browserLock() : options.lock
  const timeoutMs = options.timeoutMs ?? assetMutationRecoveryLimits.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('素材操作等待期限无效。')
  let disposed = false, generation = 0, loadGeneration = 0, viewGeneration = 0, inFlight = false
  let missingPermit: { raw: string; operationId: string } | null = null
  const listeners = new Set<(state: AssetMutationRecoveryState) => void>(), controllers = new Set<AbortController>(), results = new Map<string, AssetMutationResult>()
  let state: AssetMutationRecoveryState = { entries: [], result: null, ready: false, loading: true, busy: false, error: '', writeAvailable: !!lock, writeError: lock ? '' : '当前浏览器不支持安全的跨页面素材写入锁；仍可浏览素材和核对原操作。', retryAvailable: false }
  function snapshot(): AssetMutationRecoveryState { return structuredClone(state) }
  function current(signal?: AbortSignal, epoch = generation) { if (disposed || generation !== epoch || !options.active() || signal?.aborted) throw stopped() }
  function emit(change: Partial<AssetMutationRecoveryState>) {
    if (disposed || !options.active()) return
    state = { ...state, ...change }
    for (const listener of listeners) { try { listener(snapshot()) } catch { /* Other surfaces must still receive the original receipt. */ } }
  }
  function target(): AssetMutationRecoveryStorage {
    const result = storage()
    if (!result) throw new Error('浏览器暂不能读取本机素材操作记录；请允许站点存储后重读，尚未提交新操作。')
    return result
  }
  async function read(signal?: AbortSignal): Promise<{ journal: AssetMutationJournal; raw: string | null }> {
    const epoch = generation
    current(signal, epoch)
    let raw: string | null
    try { raw = target().getItem(key) } catch { throw new Error('本机素材操作记录无法读取，请检查浏览器存储后重读；尚未提交新操作。') }
    if (raw === null) return { journal: { version: 1, ownerId, entries: [] }, raw }
    if (new TextEncoder().encode(raw).byteLength > assetMutationRecoveryLimits.bytes) invalid()
    let value: unknown
    try { value = JSON.parse(raw) } catch { invalid() }
    const journal = await parseAssetMutationJournal(value, ownerId)
    current(signal, epoch)
    if (target().getItem(key) !== raw) throw new Error('另一页面已更新素材操作记录，请重新读取原记录。')
    return { journal, raw }
  }
  function show(journal: AssetMutationJournal) {
    const retained = new Set(journal.entries.map((item) => item.input.operationId))
    for (const operationId of results.keys()) if (!retained.has(operationId)) results.delete(operationId)
    const pending = journal.entries.find((item) => item.phase === 'pending')?.input
    const selectedOperationId = journal.entries.some((item) => item.input.operationId === state.selectedOperationId) ? state.selectedOperationId : pending?.operationId ?? journal.entries.at(-1)?.input.operationId
    emit({ entries: journal.entries, pending, selectedOperationId, result: selectedOperationId ? results.get(selectedOperationId) ?? null : null, ready: true, loading: false, retryAvailable: false })
  }
  function write(journal: AssetMutationJournal, expected: string | null, confirmed = false): string {
    const raw = JSON.stringify(journal), destination = target()
    function failure(message: string): never { if (confirmed) throw new Error('素材原操作已确认，但本机记录未能同步；' + message + ' 请重新核对原回执，不要另建请求。'); throw new AssetMutationNotSubmittedError(message + ' 本次尚未提交。') }
    if (new TextEncoder().encode(raw).byteLength > assetMutationRecoveryLimits.bytes) failure('本机素材操作记录超过上限。')
    if (destination.getItem(key) !== expected) failure('另一页面已更新素材操作记录，本次未覆盖。')
    try { destination.setItem(key, raw); if (destination.getItem(key) !== raw) throw new Error('Storage verification failed') }
    catch { emit({ ready: false, error: '素材操作记录无法完整保存；请检查浏览器存储后重读，不要另建请求。' }); failure('本机素材操作记录保存未确认。') }
    missingPermit = null; ++loadGeneration; show(journal)
    return raw
  }
  function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false
      function abort() { if (done) return; done = true; signal.removeEventListener('abort', abort); reject(stopped()) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      promise.then((value) => { if (done) return; done = true; signal.removeEventListener('abort', abort); resolve(value) }, (error) => { if (done) return; done = true; signal.removeEventListener('abort', abort); reject(error) })
    })
  }
  async function waiting<T>(signal: AbortSignal | undefined, work: (active: AbortSignal) => Promise<T>): Promise<T> {
    if (inFlight) throw new AssetMutationNotSubmittedError('正在核对另一项素材原操作，请等待当前核对结束。')
    inFlight = true
    const controller = new AbortController(), epoch = generation, timer = setTimeout(() => controller.abort(), timeoutMs)
    const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    controllers.add(controller); emit({ busy: true, error: '' })
    try { current(active, epoch); const value = await waitFor(Promise.resolve().then(() => { current(active, epoch); return work(active) }), active); current(active, epoch); return value }
    catch (error) { if (!disposed && options.active()) emit({ error: error instanceof Error ? error.message : '素材原操作尚未确认，请重新核对。' }); throw error }
    finally { clearTimeout(timer); controllers.delete(controller); inFlight = false; emit({ busy: false }) }
  }
  async function locked<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (!lock) throw new AssetMutationNotSubmittedError(state.writeError)
    return await waitFor(lock.run(key, signal, async () => { current(signal); return await work() }), signal)
  }
  function select(operationId: string) {
    if (!state.entries.some((item) => item.input.operationId === operationId)) throw new Error('素材原操作不在当前账号记录中，请重新读取。')
    ++viewGeneration
    emit({ selectedOperationId: operationId, result: results.get(operationId) ?? null, retryAvailable: !!missingPermit && missingPermit.operationId === operationId })
  }
  async function load(signal?: AbortSignal) {
    const revision = ++loadGeneration
    missingPermit = null; emit({ loading: true, retryAvailable: false })
    try { const loaded = await read(signal); if (revision === loadGeneration) { show(loaded.journal); emit({ error: '' }) }; return structuredClone(loaded.journal.entries) }
    catch (error) { if (!signal?.aborted && revision === loadGeneration) emit({ ready: false, loading: false, error: error instanceof Error ? error.message : '素材操作记录尚未读取，请重试。' }); throw error }
  }
  async function confirm(input: AssetMutationInput, requestDigest: string, result: AssetMutationResult, signal: AbortSignal) {
    if (!isAssetMutationResult(result)) throw new Error('素材原操作回执格式不完整，请保留记录重新核对。')
    confirmAssetMutationResult(input, result, requestDigest); current(signal)
    results.set(input.operationId, structuredClone(result))
    if (state.selectedOperationId === input.operationId) emit({ result })
    const stored = await read(signal)
    const entry = stored.journal.entries.find((item) => item.input.operationId === input.operationId)
    if (!entry || JSON.stringify(entry.input) !== JSON.stringify(input) || entry.requestDigest !== requestDigest) throw new Error('原素材回执已确认，但本机记录已变化；请重新读取原记录，不要覆盖其他操作。')
    if (entry.phase === 'pending') {
      entry.phase = 'confirmed'
      current(signal); write(stored.journal, stored.raw, true)
    } else show(stored.journal)
    if (state.selectedOperationId === input.operationId) emit({ result })
  }
  async function send(value: AssetMutationInput, signal: AbortSignal | undefined, retry: boolean): Promise<AssetMutationResult> {
    const input = parseAssetMutationInput(value)
    let sent = false
    try {
      return await waiting(signal, (active) => locked(active, async () => {
        const stored = await read(active)
        let entry: AssetMutationJournalEntry
        if (retry) {
          const previous = stored.journal.entries.find((item) => item.input.operationId === input.operationId)
          if (!previous || previous.phase !== 'pending' || missingPermit?.raw !== stored.raw || missingPermit.operationId !== input.operationId || JSON.stringify(previous.input) !== JSON.stringify(input)) throw new AssetMutationNotSubmittedError('尚未核对到相同原操作缺失，或记录已被另一页面更新；本次没有重新提交。')
          if (previous.attempt >= assetMutationRecoveryLimits.attempts) throw new AssetMutationNotSubmittedError('原素材操作重试已达上限，请保留记录并联系支持。')
          entry = { ...previous, attempt: previous.attempt + 1 }
          stored.journal.entries = stored.journal.entries.map((item) => item === previous ? entry : item)
        } else {
          if (stored.journal.entries.some((item) => item.phase === 'pending')) { show(stored.journal); throw new AssetMutationNotSubmittedError('还有一项素材原操作待核对；本次没有覆盖或另建请求。') }
          if (stored.journal.entries.some((item) => item.input.operationId === input.operationId)) throw new AssetMutationNotSubmittedError('该素材操作已在本机记录中，请核对原回执。')
          const requestDigest = await assetMutationRequestDigest(input)
          current(active)
          entry = { input, requestDigest, createdAt: options.now?.() ?? new Date().toISOString(), attempt: 1, phase: 'pending' }
          stored.journal.entries = [...stored.journal.entries, entry].slice(-assetMutationRecoveryLimits.entries)
        }
        await parseAssetMutationJournal(stored.journal, ownerId); current(active)
        write(stored.journal, stored.raw)
        ++viewGeneration; emit({ selectedOperationId: input.operationId, result: null, retryAvailable: false })
        current(active); sent = true
        const result = await waitFor(Promise.resolve().then(() => { current(active); return options.apply(structuredClone(input), active) }), active)
        current(active); await confirm(input, entry.requestDigest, result, active)
        return structuredClone(result)
      }))
    } catch (error) {
      if (!sent && !(error instanceof AssetMutationNotSubmittedError)) throw new AssetMutationNotSubmittedError(error instanceof Error ? error.message : '本次素材操作尚未提交。')
      throw error
    }
  }
  async function inspect(value: AssetMutationInput, signal?: AbortSignal): Promise<AssetMutationInspection> {
    const input = parseAssetMutationInput(value)
    return await waiting(signal, async (active) => {
      const inspectWork = async () => {
        const stored = await read(active), entry = stored.journal.entries.find((item) => item.input.operationId === input.operationId)
        if (!entry || JSON.stringify(entry.input) !== JSON.stringify(input)) throw new Error('素材原操作记录已变化，请重新读取，尚未发送新操作。')
        const view = ++viewGeneration
        missingPermit = null; emit({ selectedOperationId: input.operationId, retryAvailable: false, result: results.get(input.operationId) ?? null })
        const receipt = parseAssetMutationInspection(await waitFor(options.inspect(structuredClone(input), active), active))
        current(active)
        if (receipt.operationId !== input.operationId || receipt.requestDigest !== entry.requestDigest) throw new Error('素材原操作回执身份不一致，请保留记录并重新核对。')
        if (receipt.status === 'applied') {
          if (lock) await confirm(input, entry.requestDigest, receipt.result, active)
          else { confirmAssetMutationResult(input, receipt.result, entry.requestDigest); results.set(input.operationId, receipt.result); if (view === viewGeneration) emit({ result: receipt.result }) }
        } else if (entry.phase === 'pending') {
          if (target().getItem(key) !== stored.raw) throw new Error('素材记录已被另一页面更新，请重新核对。')
          if (lock && stored.raw !== null) missingPermit = { raw: stored.raw, operationId: input.operationId }
          if (view === viewGeneration) emit({ retryAvailable: !!lock, result: null })
        } else throw new Error('该素材操作曾被确认，但服务器目前无法找回原回执；不会重发，请保留记录核对服务状态。')
        return receipt
      }
      // Browsers without Web Locks may still read receipts, but cannot clear or
      // overwrite a durable identity that another page could be using.
      return lock ? await locked(active, inspectWork) : await inspectWork()
    })
  }
  return {
    key, snapshot, load, select, inspect,
    submit: (input, signal) => send(input, signal, false),
    retry: (input, signal) => send(input, signal, true),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    stopWaiting() { for (const controller of controllers) controller.abort(); missingPermit = null; emit({ retryAvailable: false }) },
    dispose() { disposed = true; ++generation; ++loadGeneration; ++viewGeneration; for (const controller of controllers) controller.abort(); listeners.clear(); results.clear(); missingPermit = null },
  }
}
