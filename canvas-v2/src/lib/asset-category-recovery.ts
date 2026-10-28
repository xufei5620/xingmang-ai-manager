import { isCanvasPublicAccountId } from './canvas-account-contract'
import { isAssetCategoryClientRejected } from './asset-category-client-error'
import { assetCategoryRequestDigest, confirmAssetCategoryResult, isAssetCategoryResult, parseAssetCategoryInput, type AssetCategoryInput, type AssetCategoryOperationInspection, type AssetCategoryResult } from './asset-category-contract'

export interface AssetCategoryRecoveryRecord {
  version: 1
  ownerId: string
  operationId: string
  requestDigest: string
  createdAt: string
  attempt: number
  input: AssetCategoryInput
}

export interface AssetCategoryRecoveryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface AssetCategoryRecoveryLock {
  run<T>(name: string, signal: AbortSignal, work: () => Promise<T>): Promise<T>
}

export interface AssetCategoryRecoveryOptions {
  ownerId: string
  active(): boolean
  apply(input: AssetCategoryInput, signal?: AbortSignal): Promise<AssetCategoryResult>
  inspect(input: AssetCategoryInput, signal?: AbortSignal): Promise<AssetCategoryOperationInspection>
  storage?: () => AssetCategoryRecoveryStorage | null
  lock?: AssetCategoryRecoveryLock | null
  timeoutMs?: number
  now?: () => string
}

export interface AssetCategoryRecoveryState {
  record: AssetCategoryRecoveryRecord | null
  pending: AssetCategoryInput | undefined
  ready: boolean
  loading: boolean
  error: string
  writeAvailable: boolean
  writeError: string
}

export interface AssetCategoryRecoveryPort {
  key: string
  snapshot(): AssetCategoryRecoveryState
  subscribe(listener: (state: AssetCategoryRecoveryState) => void): () => void
  load(signal?: AbortSignal): Promise<AssetCategoryRecoveryRecord | null>
  submit(input: AssetCategoryInput, signal?: AbortSignal): Promise<AssetCategoryResult>
  inspect(input: AssetCategoryInput, signal?: AbortSignal): Promise<AssetCategoryOperationInspection>
  retry(input: AssetCategoryInput, signal?: AbortSignal): Promise<AssetCategoryResult>
  dispose(): void
}

export const assetCategoryRecoveryLimits = { recordBytes: 16 * 1024, pendingPerOwner: 1, maximumAttempts: 1000, timeoutMs: 30_000 } as const

export class AssetCategoryRecoveryNotSubmittedError extends Error {
  readonly requestSent = false
  constructor(message: string) { super(message); this.name = 'AssetCategoryRecoveryNotSubmittedError' }
}

export function isAssetCategoryRecoveryNotSubmitted(error: unknown): error is AssetCategoryRecoveryNotSubmittedError {
  return error instanceof AssetCategoryRecoveryNotSubmittedError
}

function browserStorage(): AssetCategoryRecoveryStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

function browserLock(): AssetCategoryRecoveryLock | null {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return null
  return { async run<T>(name: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> { return await navigator.locks.request(name, { mode: 'exclusive', signal }, work) } }
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function invalidRecord(): never { throw new Error('本机分类恢复记录损坏、版本不受支持或所属账号不一致；请保留记录并核对，尚未提交新操作。') }
function aborted(): Error { return new Error('当前分类操作等待已停止；已发送的操作仍保留原记录，请重新核对原结果。') }

export function assetCategoryRecoveryKey(ownerId: string): string {
  if (!isCanvasPublicAccountId(ownerId)) throw new Error('分类恢复所属账号无法确认，请重新进入素材库。')
  return `xingmang:asset-category-recovery:v1:${ownerId.toLowerCase()}`
}

export async function parseAssetCategoryRecoveryRecord(value: unknown, ownerId: string): Promise<AssetCategoryRecoveryRecord> {
  assetCategoryRecoveryKey(ownerId)
  if (!object(value) || Object.keys(value).some((key) => !['version', 'ownerId', 'operationId', 'requestDigest', 'createdAt', 'attempt', 'input'].includes(key))
    || value.version !== 1 || value.ownerId !== ownerId.toLowerCase() || typeof value.operationId !== 'string'
    || typeof value.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestDigest)
    || typeof value.createdAt !== 'string' || value.createdAt.length > 32 || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.attempt !== 'number' || !Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > assetCategoryRecoveryLimits.maximumAttempts) invalidRecord()
  let input: AssetCategoryInput
  try { input = parseAssetCategoryInput(value.input) } catch { invalidRecord() }
  if (input.operationId !== value.operationId || JSON.stringify(input) !== JSON.stringify(value.input) || await assetCategoryRequestDigest(input) !== value.requestDigest) invalidRecord()
  const record: AssetCategoryRecoveryRecord = { version: 1, ownerId: ownerId.toLowerCase(), operationId: input.operationId, requestDigest: value.requestDigest, createdAt: value.createdAt, attempt: value.attempt, input }
  if (new TextEncoder().encode(JSON.stringify(record)).byteLength > assetCategoryRecoveryLimits.recordBytes) invalidRecord()
  return record
}

/** One owner-wide exclusive lock protects the complete write, receipt and clear
 * sequence. A different tab cannot replace an unresolved operation, consume a
 * stale missing receipt, or clear a newer attempt on an old response. */
export function createAssetCategoryRecovery(options: AssetCategoryRecoveryOptions): AssetCategoryRecoveryPort {
  const key = assetCategoryRecoveryKey(options.ownerId), ownerId = options.ownerId.toLowerCase()
  const storage = options.storage ?? browserStorage, lock = options.lock === undefined ? browserLock() : options.lock
  const timeoutMs = options.timeoutMs ?? assetCategoryRecoveryLimits.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('分类恢复等待期限无效。')
  let generation = 0, disposed = false, loadGeneration = 0, missingPermit: string | null = null
  let state: AssetCategoryRecoveryState = { record: null, pending: undefined, ready: false, loading: true, error: '', writeAvailable: !!lock, writeError: lock ? '' : '当前浏览器不支持安全的跨页面分类写入锁；仍可读取素材、分类及核对原操作。' }
  const listeners = new Set<(state: AssetCategoryRecoveryState) => void>(), controllers = new Set<AbortController>()
  function snapshot(): AssetCategoryRecoveryState { return structuredClone(state) }
  function emit(change: Partial<AssetCategoryRecoveryState>) {
    if (disposed || !options.active()) return
    state = { ...state, ...change }
    for (const listener of listeners) { try { listener(snapshot()) } catch { /* Other views still receive the durable state. */ } }
  }
  function assertCurrent(signal?: AbortSignal, epoch = generation) {
    if (disposed || epoch !== generation || !options.active() || signal?.aborted) throw aborted()
  }
  function target(): AssetCategoryRecoveryStorage {
    const result = storage()
    if (!result) throw new Error('浏览器暂不能读取本机分类恢复记录，请允许站点存储后重读；尚未提交新操作。')
    return result
  }
  async function read(signal?: AbortSignal): Promise<{ record: AssetCategoryRecoveryRecord; raw: string } | null> {
    const epoch = generation
    assertCurrent(signal, epoch)
    let raw: string | null
    try { raw = target().getItem(key) } catch { throw new Error('本机分类恢复记录无法读取，请检查浏览器存储后重读；尚未提交新操作。') }
    if (raw === null) return null
    if (new TextEncoder().encode(raw).byteLength > assetCategoryRecoveryLimits.recordBytes) invalidRecord()
    let value: unknown
    try { value = JSON.parse(raw) } catch { invalidRecord() }
    const record = await parseAssetCategoryRecoveryRecord(value, ownerId)
    assertCurrent(signal, epoch)
    if (target().getItem(key) !== raw) throw new Error('另一页面已更新分类恢复记录，请重新读取原操作。')
    return { record, raw }
  }
  function show(record: AssetCategoryRecoveryRecord | null) { emit({ record, pending: record?.input, ready: true, loading: false, error: '' }) }
  async function load(signal?: AbortSignal) {
    const revision = ++loadGeneration
    emit({ loading: true })
    try {
      const current = await read(signal)
      if (revision === loadGeneration) show(current?.record ?? null)
      return current?.record ?? null
    } catch (error) {
      if (!signal?.aborted && revision === loadGeneration) emit({ ready: false, loading: false, error: error instanceof Error ? error.message : '分类恢复记录尚未读取，请重试。' })
      throw error
    }
  }
  function write(record: AssetCategoryRecoveryRecord, expected: string | null) {
    const raw = JSON.stringify(record), current = target()
    if (current.getItem(key) !== expected) throw new AssetCategoryRecoveryNotSubmittedError('另一页面已更新分类恢复记录，请先核对原操作；本次尚未提交。')
    try { current.setItem(key, raw); if (current.getItem(key) !== raw) throw new Error('Storage verification failed') }
    catch {
      const message = '无法完整保存本机分类恢复记录，本次尚未提交；请检查浏览器存储容量后重读。'
      emit({ ready: false, loading: false, error: message })
      throw new AssetCategoryRecoveryNotSubmittedError(message)
    }
    missingPermit = null; ++loadGeneration; show(record)
    return raw
  }
  function clear(expected: string) {
    const current = target()
    if (current.getItem(key) !== expected) throw new Error('分类原操作已确认，但本机记录被另一页面更新；请保留记录并重新核对。')
    try { current.removeItem(key); if (current.getItem(key) !== null) throw new Error('Storage verification failed') }
    catch { throw new Error('分类原操作已确认，但本机记录尚未清除；请再次核对原操作，不要新建请求。') }
    missingPermit = null; ++loadGeneration; show(null)
  }
  async function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) { void promise.catch(() => undefined); throw aborted() }
    let cancel: (() => void) | undefined
    const stopped = new Promise<never>((_resolve, reject) => { cancel = () => reject(aborted()); signal.addEventListener('abort', cancel, { once: true }) })
    try { return await Promise.race([promise, stopped]) } finally { if (cancel) signal.removeEventListener('abort', cancel) }
  }
  async function waiting<T>(signal: AbortSignal | undefined, work: (active: AbortSignal) => Promise<T>) {
    const controller = new AbortController(), epoch = generation
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    controllers.add(controller)
    const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try { assertCurrent(active, epoch); const result = await waitFor(work(active), active); assertCurrent(active, epoch); return result }
    finally { clearTimeout(timer); controllers.delete(controller) }
  }
  async function locked<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (!lock) throw new AssetCategoryRecoveryNotSubmittedError(state.writeError)
    return await waitFor(lock.run(key, signal, async () => { assertCurrent(signal); return await work() }), signal)
  }
  async function requireRecord(input: AssetCategoryInput, signal: AbortSignal) {
    const current = await read(signal)
    if (!current || JSON.stringify(current.record.input) !== JSON.stringify(input)) throw new AssetCategoryRecoveryNotSubmittedError('原分类恢复记录不再匹配，请重新读取并核对原操作；本次尚未提交。')
    show(current.record)
    return current
  }
  async function confirm(input: AssetCategoryInput, digest: string, result: AssetCategoryResult) {
    if (!isAssetCategoryResult(result) || result.requestDigest !== digest) throw new Error('分类结果摘要与原请求不一致，请保留原操作并重新核对。')
    confirmAssetCategoryResult(input, result)
  }
  async function send(inputValue: AssetCategoryInput, signal: AbortSignal | undefined, retry: boolean) {
    let sent = false
    try {
      const input = parseAssetCategoryInput(inputValue)
      return await waiting(signal, (active) => locked(active, async () => {
        let raw: string, record: AssetCategoryRecoveryRecord
        const current = await read(active)
        if (retry) {
          if (current) show(current.record)
          if (!current || missingPermit !== current.raw || JSON.stringify(input) !== JSON.stringify(current.record.input)) throw new AssetCategoryRecoveryNotSubmittedError('原操作尚未确认缺失或已被另一页面更新，请先重新核对原结果；本次尚未提交。')
          if (current.record.attempt >= assetCategoryRecoveryLimits.maximumAttempts) throw new AssetCategoryRecoveryNotSubmittedError('原分类操作重试次数已达安全上限，请保留记录并联系支持。')
          record = { ...current.record, attempt: current.record.attempt + 1 }
          raw = write(record, current.raw)
        } else {
          if (current) { show(current.record); throw new AssetCategoryRecoveryNotSubmittedError('还有一项分类操作待核对，请先核对原操作；本次没有覆盖或重复提交。') }
          const requestDigest = await assetCategoryRequestDigest(input)
          assertCurrent(active)
          record = { version: 1, ownerId, operationId: input.operationId, requestDigest, createdAt: options.now?.() ?? new Date().toISOString(), attempt: 1, input }
          await parseAssetCategoryRecoveryRecord(record, ownerId)
          assertCurrent(active); raw = write(record, null)
        }
        assertCurrent(active); sent = true
        try {
          const result = await waitFor(Promise.resolve().then(() => { assertCurrent(active); return options.apply(structuredClone(input), active) }), active)
          assertCurrent(active); await confirm(input, record.requestDigest, result); assertCurrent(active)
          clear(raw)
          return result
        } catch (error) {
          if (!active.aborted && !disposed && options.active() && isAssetCategoryClientRejected(error)) clear(raw)
          throw error
        }
      }))
    } catch (error) {
      if (error instanceof AssetCategoryRecoveryNotSubmittedError) throw error
      if (!sent) {
        const message = error instanceof Error ? error.message : '无法保存原分类操作，本次尚未提交。'
        emit({ ready: false, loading: false, error: message })
        throw new AssetCategoryRecoveryNotSubmittedError(message)
      }
      throw error
    }
  }
  return {
    key, snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    load,
    submit(input, signal) { return send(input, signal, false) },
    retry(input, signal) { return send(input, signal, true) },
    async inspect(inputValue, signal) {
      const input = parseAssetCategoryInput(inputValue)
      return await waiting(signal, async (active) => {
        const current = await requireRecord(input, active)
        const result = await waitFor(Promise.resolve().then(() => { assertCurrent(active); return options.inspect(structuredClone(input), active) }), active)
        assertCurrent(active)
        if (result.operationId !== current.record.operationId || result.requestDigest !== current.record.requestDigest || !['missing', 'applied'].includes(result.status)) throw new Error('原分类操作核对回执不一致，请保留记录后重读。')
        if (result.status === 'applied') {
          await confirm(input, current.record.requestDigest, result.result); assertCurrent(active)
          if (!lock) throw new Error('原分类操作已确认成功；此浏览器缺少安全写入锁，本机记录仍保留，请在支持的浏览器中继续核对。')
          await locked(active, async () => { const latest = await requireRecord(input, active); if (latest.raw !== current.raw) throw new Error('另一页面已更新原分类操作，请重新核对最新尝试。'); clear(current.raw) })
        } else {
          const latest = await requireRecord(input, active)
          if (latest.raw !== current.raw) throw new Error('另一页面已更新原分类操作，请重新核对最新尝试。')
          missingPermit = current.raw
        }
        return result
      })
    },
    dispose() { disposed = true; ++generation; ++loadGeneration; missingPermit = null; for (const controller of controllers) controller.abort(); controllers.clear(); listeners.clear() },
  }
}
