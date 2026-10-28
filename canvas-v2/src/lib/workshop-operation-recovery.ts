import { parseCommunityExampleSelection } from './community-example-contract'
import { isCanvasPublicAccountId } from './canvas-account-contract'
import { communityWorkshopRequestDigest, parseCommunityWorkshopInspection, type CommunityPublicationInput, type CommunityWorkshopMutationInput, type CommunityWorkshopReceipt } from './community-workshop-contract'
import { workshopTransferRequestDigest, parseWorkshopTransferInspection, parseWorkshopShareInput, type WorkshopTransferMethodMap, type WorkshopTransferReceipt } from './workshop-transfer-contract'
import { workshopText } from './workshop-sanitizer'
import type { AssetMutationRecoveryLock, AssetMutationRecoveryStorage } from './asset-mutation-recovery'

export type WorkshopOperationRequest =
  | { family: 'community'; action: 'publish'; input: CommunityPublicationInput }
  | { family: 'community'; action: 'withdraw' | 'acquire'; input: CommunityWorkshopMutationInput }
  | { family: 'transfer'; action: 'share'; input: WorkshopTransferMethodMap['createWorkshopShare']['input'] }
  | { family: 'transfer'; action: 'revoke'; input: WorkshopTransferMethodMap['revokeWorkshopShare']['input'] }
  | { family: 'transfer'; action: 'acquire'; input: WorkshopTransferMethodMap['acquireWorkshopShare']['input'] }
export type WorkshopStoredRequest = Exclude<WorkshopOperationRequest, { family: 'transfer'; action: 'acquire' }> | { family: 'transfer'; action: 'acquire'; input: { operationId: string; expectedVersion: number } }
export type WorkshopOperationCompletion = { family: 'community'; receipt: CommunityWorkshopReceipt } | { family: 'transfer'; receipt: WorkshopTransferReceipt }
export interface WorkshopOperationRecoveryRecord {
  version: 1 | 2
  request: WorkshopStoredRequest
  requestDigest: string
  createdAt: string
  attempt: number
  phase: 'pending' | 'confirmed' | 'rejected'
}
interface Journal { version: 1 | 2; ownerId: string; entries: WorkshopOperationRecoveryRecord[] }
export interface WorkshopOperationRecoveryState {
  entries: WorkshopOperationRecoveryRecord[]
  pending: WorkshopOperationRecoveryRecord | null
  selected: WorkshopOperationRecoveryRecord | null
  result: WorkshopOperationCompletion | null
  ready: boolean
  busy: boolean
  missing: boolean
  error: string
  writeAvailable: boolean
  retryAvailable: boolean
}
export interface WorkshopOperationRecoveryPort {
  key: string
  keys?: readonly string[]
  snapshot(): WorkshopOperationRecoveryState
  subscribe(listener: (state: WorkshopOperationRecoveryState) => void): () => void
  reload(signal?: AbortSignal, scopeActive?: () => boolean): Promise<WorkshopOperationRecoveryRecord[]>
  submit(request: WorkshopOperationRequest, signal?: AbortSignal, scopeActive?: () => boolean): Promise<WorkshopOperationCompletion>
  inspect(operationId?: string, signal?: AbortSignal, scopeActive?: () => boolean): Promise<WorkshopOperationCompletion | null>
  retry(operationId?: string, request?: WorkshopOperationRequest, signal?: AbortSignal, scopeActive?: () => boolean): Promise<WorkshopOperationCompletion | null>
  select(operationId: string): void
  stopWaiting(): void
  dispose(): void
}
export interface WorkshopOperationRecoveryOptions {
  ownerId: string
  active(): boolean
  apply(request: WorkshopOperationRequest, signal: AbortSignal): Promise<WorkshopOperationCompletion>
  inspect(record: WorkshopOperationRecoveryRecord, signal: AbortSignal): Promise<unknown>
  rejected?(error: unknown): boolean
  storage?: () => AssetMutationRecoveryStorage | null
  lock?: AssetMutationRecoveryLock | null
  timeoutMs?: number
  now?(): string
}
export const workshopOperationRecoveryLimits = { version: 1, entries: 20, bytes: 32 * 1024, attempts: 8, timeoutMs: 30_000 } as const
export const workshopOperationRecoveryEvent = 'xingmang:workshop-operation-recovery'
export class WorkshopOperationNotSubmittedError extends Error {}

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown> }
function invalid(): never { throw new Error('本机工坊操作记录损坏、版本不受支持或账号不一致；请保留记录重新核对，本次操作未提交。') }
function keys(value: Record<string, unknown>, expected: string[]) { if (Object.keys(value).length !== expected.length || Object.keys(value).some((key) => !expected.includes(key))) invalid() }
function uuid(value: unknown): string { if (!isCanvasPublicAccountId(value)) invalid(); return value }
function version(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) >= Number.MAX_SAFE_INTEGER) invalid(); return Number(value) }
function hash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); return value }
function kind(value: unknown): 'prompt' | 'node' | 'group' { if (value !== 'prompt' && value !== 'node' && value !== 'group') invalid(); return value }
function cleanAuthor(value: unknown): string { const author = workshopText(value, '公开署名', 80); if (author !== value || /[\r\n\t]/.test(author)) invalid(); return author }
function browserStorage(): AssetMutationRecoveryStorage | null { try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null } }
function browserLock(): AssetMutationRecoveryLock | null {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return null
  return { async run<T>(name: string, signal: AbortSignal, work: () => Promise<T>) { return await navigator.locks.request(name, { mode: 'exclusive', signal }, work) } }
}
function stopped(): Error { return new Error('已停止等待，工坊原操作记录仍保留；已提交的操作不会因此撤销，请核对原结果。') }
export function workshopOperationRecoveryKey(ownerId: string): string { if (!isCanvasPublicAccountId(ownerId)) invalid(); return 'xingmang:workshop-operation-recovery:v1:' + ownerId.toLowerCase() }
export function workshopOperationRecoveryGalleryKey(ownerId: string): string { if (!isCanvasPublicAccountId(ownerId)) invalid(); return 'xingmang:workshop-operation-recovery:v2:' + ownerId.toLowerCase() }

function parseGalleryOperationRequest(value: unknown): WorkshopOperationRequest {
  const request = object(value); keys(request, ['family', 'action', 'input'])
  const input = object(request.input)
  if (request.family !== 'community' || request.action !== 'publish' || input.exampleSelection === undefined) invalid()
  keys(input, ['operationId', 'sourceKind', 'sourceId', 'expectedSourceVersion', 'authorName', 'previewDigest', 'confirmPublic', 'exampleSelection'])
  const { exampleSelection, ...legacyInput } = input
  const legacy = parseWorkshopOperationRequest({ family: request.family, action: request.action, input: legacyInput })
  if (legacy.family !== 'community' || legacy.action !== 'publish') invalid()
  const selection = parseCommunityExampleSelection(exampleSelection)
  if (JSON.stringify(selection) !== JSON.stringify(exampleSelection)) invalid()
  return { ...legacy, input: { ...legacy.input, exampleSelection: selection } }
}
function usesGallery(request: WorkshopOperationRequest): boolean { return request.family === 'community' && request.action === 'publish' && request.input.exampleSelection !== undefined }

export function parseWorkshopOperationRequest(value: unknown, stored = false): WorkshopStoredRequest | WorkshopOperationRequest {
  const request = object(value); keys(request, ['family', 'action', 'input'])
  const input = object(request.input), operationId = uuid(input.operationId)
  if (request.family === 'community' && request.action === 'publish') {
    keys(input, ['operationId', 'sourceKind', 'sourceId', 'expectedSourceVersion', 'authorName', 'previewDigest', 'confirmPublic'])
    if (input.confirmPublic !== true) invalid()
    return { family: 'community', action: 'publish', input: { operationId, sourceKind: kind(input.sourceKind), sourceId: uuid(input.sourceId), expectedSourceVersion: version(input.expectedSourceVersion), authorName: cleanAuthor(input.authorName), previewDigest: hash(input.previewDigest), confirmPublic: true } }
  }
  if (request.family === 'community' && (request.action === 'withdraw' || request.action === 'acquire') || request.family === 'transfer' && request.action === 'revoke') {
    keys(input, ['operationId', 'id', 'expectedVersion'])
    const parsed = { operationId, id: uuid(input.id), expectedVersion: version(input.expectedVersion) }
    return request.family === 'community' ? { family: 'community', action: request.action as 'withdraw' | 'acquire', input: parsed } : { family: 'transfer', action: 'revoke', input: parsed }
  }
  if (request.family === 'transfer' && request.action === 'share') {
    keys(input, ['operationId', 'source', 'authorName', 'onlyUse', 'limitAcquisitions', 'previewDigest', 'confirmShare'])
    keys(object(input.source), ['kind', 'id', 'expectedVersion'])
    if (input.confirmShare !== true) invalid()
    cleanAuthor(input.authorName)
    return { family: 'transfer', action: 'share', input: { operationId, ...parseWorkshopShareInput(input), previewDigest: hash(input.previewDigest), confirmShare: true } }
  }
  if (request.family === 'transfer' && request.action === 'acquire') {
    keys(input, stored ? ['operationId', 'expectedVersion'] : ['operationId', 'expectedVersion', 'token'])
    const expectedVersion = version(input.expectedVersion)
    if (stored) return { family: 'transfer', action: 'acquire', input: { operationId, expectedVersion } }
    if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) invalid()
    return { family: 'transfer', action: 'acquire', input: { operationId, expectedVersion, token: input.token } }
  }
  return invalid()
}
function storedRequest(request: WorkshopOperationRequest): WorkshopStoredRequest {
  if (request.family === 'transfer' && request.action === 'acquire') return { family: 'transfer', action: 'acquire', input: { operationId: request.input.operationId, expectedVersion: request.input.expectedVersion } }
  return structuredClone(request)
}
export async function workshopOperationRequestDigest(request: WorkshopOperationRequest): Promise<string> { return request.family === 'community' ? await communityWorkshopRequestDigest(request.action, request.input) : await workshopTransferRequestDigest(request.action, request.input) }
function fullRequest(request: WorkshopStoredRequest): WorkshopOperationRequest {
  if (request.family === 'transfer' && request.action === 'acquire') throw new WorkshopOperationNotSubmittedError('请重新打开原分享链接并明确继续获取；分享凭据没有保存在本机操作记录中，本次操作未提交。')
  return structuredClone(request)
}
export async function parseWorkshopOperationJournal(value: unknown, ownerId: string): Promise<Journal> {
  workshopOperationRecoveryKey(ownerId)
  const journal = object(value); keys(journal, ['version', 'ownerId', 'entries'])
  if (journal.version !== 1 || journal.ownerId !== ownerId.toLowerCase() || !Array.isArray(journal.entries) || journal.entries.length > workshopOperationRecoveryLimits.entries) invalid()
  const entries: WorkshopOperationRecoveryRecord[] = []
  for (const item of journal.entries) {
    const record = object(item); keys(record, ['version', 'request', 'requestDigest', 'createdAt', 'attempt', 'phase'])
    if (record.version !== 1 || typeof record.createdAt !== 'string' || record.createdAt.length > 32 || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isSafeInteger(record.attempt) || Number(record.attempt) < 1 || Number(record.attempt) > workshopOperationRecoveryLimits.attempts || !['pending', 'confirmed', 'rejected'].includes(String(record.phase))) invalid()
    const request = parseWorkshopOperationRequest(record.request, true) as WorkshopStoredRequest, requestDigest = hash(record.requestDigest)
    if (!(request.family === 'transfer' && request.action === 'acquire') && await workshopOperationRequestDigest(fullRequest(request)) !== requestDigest) invalid()
    entries.push({ version: 1, request, requestDigest, createdAt: record.createdAt, attempt: Number(record.attempt), phase: record.phase as WorkshopOperationRecoveryRecord['phase'] })
  }
  if (new Set(entries.map((entry) => entry.request.input.operationId.toLowerCase())).size !== entries.length || entries.filter((entry) => entry.phase === 'pending').length > 1) invalid()
  const result: Journal = { version: 1, ownerId: ownerId.toLowerCase(), entries }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > workshopOperationRecoveryLimits.bytes) invalid()
  return result
}

/** Gallery requests use an independent carrier. The deployed v1 parser remains
 * strict and cannot silently discard the publication's selected image list. */
export async function parseWorkshopOperationGalleryJournal(value: unknown, ownerId: string): Promise<Journal> {
  workshopOperationRecoveryGalleryKey(ownerId)
  const journal = object(value); keys(journal, ['version', 'ownerId', 'entries'])
  if (journal.version !== 2 || journal.ownerId !== ownerId.toLowerCase() || !Array.isArray(journal.entries) || journal.entries.length > workshopOperationRecoveryLimits.entries) invalid()
  const entries: WorkshopOperationRecoveryRecord[] = []
  for (const value of journal.entries) {
    const record = object(value); keys(record, ['version', 'request', 'requestDigest', 'createdAt', 'attempt', 'phase'])
    if (record.version !== 2 || typeof record.createdAt !== 'string' || record.createdAt.length > 32 || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isSafeInteger(record.attempt) || Number(record.attempt) < 1 || Number(record.attempt) > workshopOperationRecoveryLimits.attempts || !['pending', 'confirmed', 'rejected'].includes(String(record.phase))) invalid()
    const request = parseGalleryOperationRequest(record.request), requestDigest = hash(record.requestDigest)
    if (await workshopOperationRequestDigest(request) !== requestDigest) invalid()
    entries.push({ version: 2, request, requestDigest, createdAt: record.createdAt, attempt: Number(record.attempt), phase: record.phase as WorkshopOperationRecoveryRecord['phase'] })
  }
  if (new Set(entries.map((entry) => entry.request.input.operationId.toLowerCase())).size !== entries.length || entries.filter((entry) => entry.phase === 'pending').length > 1) invalid()
  const result: Journal = { version: 2, ownerId: ownerId.toLowerCase(), entries }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > workshopOperationRecoveryLimits.bytes) invalid()
  return result
}

/** Only identities and non-secret replay fields are durable. A missing result
 * permits an explicit replay of the exact original request, never a new ID. */
export function createWorkshopOperationRecovery(options: WorkshopOperationRecoveryOptions): WorkshopOperationRecoveryPort {
  const key = workshopOperationRecoveryKey(options.ownerId), galleryKey = workshopOperationRecoveryGalleryKey(options.ownerId), ownerId = options.ownerId.toLowerCase()
  const storage = options.storage ?? browserStorage, lock = options.lock === undefined ? browserLock() : options.lock
  const timeoutMs = options.timeoutMs ?? workshopOperationRecoveryLimits.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) invalid()
  let disposed = false, generation = 0, inFlight = false, loadGeneration = 0
  let missingPermit: { raw: string; operationId: string } | null = null
  const listeners = new Set<(state: WorkshopOperationRecoveryState) => void>(), controllers = new Set<AbortController>(), results = new Map<string, WorkshopOperationCompletion>()
  const requestScopes = new WeakMap<AbortSignal, () => boolean>()
  let state: WorkshopOperationRecoveryState = { entries: [], pending: null, selected: null, result: null, ready: false, busy: false, missing: false, error: '', writeAvailable: !!lock, retryAvailable: false }
  function snapshot() { return structuredClone(state) }
  function current(signal?: AbortSignal, epoch = generation) { if (disposed || generation !== epoch || !options.active() || signal?.aborted || signal && requestScopes.get(signal)?.() === false) throw stopped() }
  function emit(change: Partial<WorkshopOperationRecoveryState>) {
    if (disposed || !options.active()) return
    state = { ...state, ...change }
    for (const listener of listeners) { try { listener(snapshot()) } catch { /* One closed surface cannot hide a receipt from another. */ } }
  }
  function destination(): AssetMutationRecoveryStorage { const result = storage(); if (!result) throw new WorkshopOperationNotSubmittedError('浏览器暂不能保存工坊恢复记录，请允许站点存储后重读；本次操作未提交。'); return result }
  const origins = new WeakMap<Journal, { legacyRaw: string | null; galleryRaw: string | null; legacyCanonical: string; galleryCanonical: string }>()
  function rawIdentity(legacyRaw: string | null, galleryRaw: string | null): string | null { return galleryRaw === null ? legacyRaw : 'v2:' + JSON.stringify([legacyRaw, galleryRaw]) }
  function currentRaw(): string | null { const target = destination(); return rawIdentity(target.getItem(key), target.getItem(galleryKey)) }
  async function read(signal?: AbortSignal) {
    const epoch = generation; current(signal, epoch)
    const target = destination(), legacyRaw = target.getItem(key), galleryRaw = target.getItem(galleryKey)
    async function parse(raw: string | null, version: 1 | 2): Promise<Journal> {
      if (raw === null) return { version, ownerId, entries: [] }
      if (new TextEncoder().encode(raw).byteLength > workshopOperationRecoveryLimits.bytes) invalid()
      let value: unknown
      try { value = JSON.parse(raw) } catch { invalid() }
      return version === 1 ? await parseWorkshopOperationJournal(value, ownerId) : await parseWorkshopOperationGalleryJournal(value, ownerId)
    }
    const legacy = await parse(legacyRaw, 1), gallery = await parse(galleryRaw, 2); current(signal, epoch)
    const journal: Journal = { version: 1, ownerId, entries: [...legacy.entries, ...gallery.entries] }
    // Same ID in different carriers is never resolved by a last-write-wins rule.
    if (new Set(journal.entries.map((entry) => entry.request.input.operationId.toLowerCase())).size !== journal.entries.length) throw new Error('两版工坊记录包含冲突的原操作编号，请保留两份记录核对；没有提交或覆盖任何操作。')
    const raw = rawIdentity(legacyRaw, galleryRaw)
    if (currentRaw() !== raw) throw new Error('其他页面已更新工坊操作记录，请重新读取原记录。')
    origins.set(journal, { legacyRaw, galleryRaw, legacyCanonical: JSON.stringify(legacy), galleryCanonical: JSON.stringify(gallery) })
    return { raw, journal }
  }
  function show(journal: Journal) {
    const retained = new Set(journal.entries.map((entry) => entry.request.input.operationId))
    for (const id of results.keys()) if (!retained.has(id)) results.delete(id)
    const pending = journal.entries.find((entry) => entry.phase === 'pending') ?? null
    const selected = journal.entries.find((entry) => entry.request.input.operationId === state.selected?.request.input.operationId) ?? pending ?? [...journal.entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null
    emit({ entries: journal.entries, pending, selected, result: selected ? results.get(selected.request.input.operationId) ?? null : null, ready: true, missing: false, retryAvailable: false })
  }
  function write(journal: Journal, expected: string | null) {
    const target = destination(), origin = origins.get(journal)
    if (!origin || currentRaw() !== expected) throw new WorkshopOperationNotSubmittedError('本机记录已变化，未覆盖其他工坊操作；请重新核对，本次操作未提交。')
    const legacy = JSON.stringify({ version: 1, ownerId, entries: journal.entries.filter((entry) => entry.version === 1) })
    const gallery = JSON.stringify({ version: 2, ownerId, entries: journal.entries.filter((entry) => entry.version === 2) })
    const legacyChanged = legacy !== origin.legacyCanonical, galleryChanged = gallery !== origin.galleryCanonical
    if (legacyChanged && galleryChanged || new TextEncoder().encode(legacy).byteLength > workshopOperationRecoveryLimits.bytes || new TextEncoder().encode(gallery).byteLength > workshopOperationRecoveryLimits.bytes) throw new WorkshopOperationNotSubmittedError('工坊记录超出上限或跨版本发生冲突，两份原记录均已保留；本次操作未提交。')
    const changedKey = galleryChanged ? galleryKey : key, raw = galleryChanged ? gallery : legacy
    try { if (legacyChanged || galleryChanged) { target.setItem(changedKey, raw); if (target.getItem(changedKey) !== raw) throw new Error('Storage readback failed') } }
    catch { emit({ ready: false }); throw new Error('工坊操作记录未能完整保存，请保留原操作并重新核对，不要另建请求。') }
    origins.set(journal, { legacyRaw: legacyChanged ? legacy : origin.legacyRaw, galleryRaw: galleryChanged ? gallery : origin.galleryRaw, legacyCanonical: legacy, galleryCanonical: gallery })
    ++loadGeneration; missingPermit = null; show(journal)
    return currentRaw()
  }
  function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false
      function abort() { if (done) return; done = true; signal.removeEventListener('abort', abort); reject(stopped()) }
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      promise.then((value) => { if (done) return; done = true; signal.removeEventListener('abort', abort); resolve(value) }, (error) => { if (done) return; done = true; signal.removeEventListener('abort', abort); reject(error) })
    })
  }
  async function waiting<T>(signal: AbortSignal | undefined, work: (active: AbortSignal) => Promise<T>, scopeActive?: () => boolean) {
    if (inFlight) throw new WorkshopOperationNotSubmittedError('正在核对工坊原操作，请等待本次操作结束。')
    inFlight = true
    const controller = new AbortController(), epoch = generation, timer = setTimeout(() => controller.abort(), timeoutMs)
    const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    if (scopeActive) requestScopes.set(active, scopeActive)
    controllers.add(controller); emit({ busy: true, error: '' })
    try { current(active, epoch); const result = await waitFor(Promise.resolve().then(() => { current(active, epoch); return work(active) }), active); current(active, epoch); return result }
    catch (error) { emit({ error: error instanceof Error ? error.message : '工坊原操作尚未确认，请重新核对。' }); throw error }
    finally { clearTimeout(timer); controllers.delete(controller); inFlight = false; emit({ busy: false }) }
  }
  async function locked<T>(signal: AbortSignal, work: () => Promise<T>) { if (!lock) throw new WorkshopOperationNotSubmittedError('当前浏览器不支持跨页面安全写入锁，仍可核对原结果；本次操作未提交。'); return await waitFor(lock.run(key, signal, async () => { current(signal); return await work() }), signal) }
  function identity(record: WorkshopOperationRecoveryRecord, response: unknown): WorkshopOperationCompletion | null {
    const parsed = record.request.family === 'community' ? parseCommunityWorkshopInspection(response) : parseWorkshopTransferInspection(response)
    if (parsed.operationId !== record.request.input.operationId.toLowerCase() || parsed.requestDigest !== record.requestDigest) throw new Error('工坊原操作编号或请求摘要不一致，请保留记录重新核对。')
    if (parsed.state === 'missing') return null
    if (parsed.receipt.operationId !== record.request.input.operationId.toLowerCase() || parsed.receipt.action !== record.request.action) throw new Error('工坊原操作回执与本次确认不一致。')
    if ('id' in record.request.input) {
      const targetId = record.request.family === 'community' && 'publicationId' in parsed.receipt ? parsed.receipt.publicationId : 'shareId' in parsed.receipt ? parsed.receipt.shareId : undefined
      if (targetId !== record.request.input.id.toLowerCase()) throw new Error('工坊原操作回执指向其他条目，请重新核对。')
    }
    return record.request.family === 'community' ? { family: 'community', receipt: parsed.receipt as CommunityWorkshopReceipt } : { family: 'transfer', receipt: parsed.receipt as WorkshopTransferReceipt }
  }
  async function confirm(record: WorkshopOperationRecoveryRecord, completion: WorkshopOperationCompletion, signal: AbortSignal) {
    current(signal)
    const stored = await read(signal), entry = stored.journal.entries.find((value) => value.request.input.operationId === record.request.input.operationId)
    if (!entry || entry.requestDigest !== record.requestDigest || JSON.stringify(entry.request) !== JSON.stringify(record.request)) throw new Error('原结果已确认，但本机工坊记录发生变化；请重读原记录，不会覆盖其他操作。')
    results.set(entry.request.input.operationId, structuredClone(completion))
    if (lock && entry.phase !== 'confirmed') { entry.phase = 'confirmed'; write(stored.journal, stored.raw) } else show(stored.journal)
    if (state.selected?.request.input.operationId === record.request.input.operationId) emit({ result: completion })
  }
  async function lookup(record: WorkshopOperationRecoveryRecord, signal: AbortSignal) { current(signal); const response = await waitFor(options.inspect(structuredClone(record), signal), signal); current(signal); return identity(record, response) }
  async function reload(signal?: AbortSignal, scopeActive?: () => boolean) {
    if (scopeActive) { signal = signal ? AbortSignal.any([signal]) : new AbortController().signal; requestScopes.set(signal, scopeActive) }
    const revision = ++loadGeneration
    missingPermit = null; emit({ retryAvailable: false, missing: false })
    try { const loaded = await read(signal); if (revision === loadGeneration) { show(loaded.journal); emit({ error: '' }) }; return structuredClone(loaded.journal.entries) }
    catch (error) { if (revision === loadGeneration && !signal?.aborted) emit({ ready: false, error: error instanceof Error ? error.message : '本机工坊记录尚未读取。' }); throw error }
  }
  function select(operationId: string) { const selected = state.entries.find((entry) => entry.request.input.operationId === operationId); if (!selected) throw new Error('工坊原操作不在当前账号记录中。'); emit({ selected, result: results.get(operationId) ?? null, missing: missingPermit?.operationId === operationId, retryAvailable: !!lock && missingPermit?.operationId === operationId }) }
  async function inspect(operationId?: string, signal?: AbortSignal, scopeActive?: () => boolean) {
    return await waiting(signal, async (active) => {
      const work = async () => {
        const stored = await read(active), id = operationId ?? state.pending?.request.input.operationId ?? state.selected?.request.input.operationId
        const entry = stored.journal.entries.find((value) => value.request.input.operationId === id)
        if (!entry) { show(stored.journal); return null }
        missingPermit = null; show(stored.journal); select(entry.request.input.operationId)
        const completion = await lookup(entry, active)
        if (completion) await confirm(entry, completion, active)
        else if (entry.phase === 'confirmed') throw new Error('该工坊操作曾被确认，但服务器目前无法找回原回执；不会重发，请保留记录核对服务状态。')
        else {
          if (currentRaw() !== stored.raw) throw new Error('其他页面已更新原记录，请重新核对。')
          if (entry.phase === 'pending' && lock && stored.raw !== null) missingPermit = { raw: stored.raw, operationId: entry.request.input.operationId }
          if (state.selected?.request.input.operationId === entry.request.input.operationId) emit({ missing: true, retryAvailable: !!missingPermit, result: null })
        }
        return completion
      }
      return lock ? await locked(active, work) : await work()
    }, scopeActive)
  }
  async function send(value: WorkshopOperationRequest, signal?: AbortSignal, retryId?: string, scopeActive?: () => boolean) {
    const request = (usesGallery(value) ? parseGalleryOperationRequest(value) : parseWorkshopOperationRequest(value)) as WorkshopOperationRequest
    return await waiting(signal, (active) => locked(active, async () => {
      const stored = await read(active), requestDigest = await workshopOperationRequestDigest(request); current(active)
      let entry: WorkshopOperationRecoveryRecord
      if (retryId) {
        const previous = stored.journal.entries.find((record) => record.request.input.operationId === retryId)
        if (!previous || previous.phase !== 'pending' || request.input.operationId !== retryId || previous.requestDigest !== requestDigest || JSON.stringify(previous.request) !== JSON.stringify(storedRequest(request)) || missingPermit?.raw !== stored.raw || missingPermit.operationId !== retryId) throw new WorkshopOperationNotSubmittedError('尚未核对到相同原操作缺失，或原内容已改变；本次操作未提交。')
        if (previous.attempt >= workshopOperationRecoveryLimits.attempts) throw new WorkshopOperationNotSubmittedError('原操作重试已达上限，请保留记录联系支持。')
        entry = { ...previous, attempt: previous.attempt + 1 }
        stored.journal.entries = stored.journal.entries.map((record) => record === previous ? entry : record)
      } else {
        if (stored.journal.entries.some((record) => record.phase === 'pending')) { show(stored.journal); throw new WorkshopOperationNotSubmittedError('还有工坊原操作待核对，请先完成核对；本次操作未提交。') }
        if (stored.journal.entries.some((record) => record.request.input.operationId.toLowerCase() === request.input.operationId.toLowerCase())) throw new WorkshopOperationNotSubmittedError('该工坊操作编号已在记录中，请核对原回执；本次操作未提交。')
        entry = { version: usesGallery(request) ? 2 : 1, request: storedRequest(request), requestDigest, createdAt: options.now?.() ?? new Date().toISOString(), attempt: 1, phase: 'pending' }
        stored.journal.entries = [...stored.journal.entries.filter((record) => record.version !== entry.version), ...stored.journal.entries.filter((record) => record.version === entry.version).concat(entry).slice(-workshopOperationRecoveryLimits.entries)]
      }
      await parseWorkshopOperationJournal({ version: 1, ownerId, entries: stored.journal.entries.filter((record) => record.version === 1) }, ownerId)
      await parseWorkshopOperationGalleryJournal({ version: 2, ownerId, entries: stored.journal.entries.filter((record) => record.version === 2) }, ownerId); current(active)
      const admittedRaw = write(stored.journal, stored.raw)
      select(entry.request.input.operationId)
      // A strong read proves server support before any mutation. It may also
      // recover a late original commit without issuing another POST.
      const existing = await lookup(entry, active)
      if (existing) { await confirm(entry, existing, active); return existing }
      current(active)
      if (currentRaw() !== admittedRaw) throw new WorkshopOperationNotSubmittedError('核对期间本机原记录已变化，请重新读取原操作；本次操作未提交。')
      try { await waitFor(Promise.resolve().then(() => { current(active); return options.apply(structuredClone(request), active) }), active) }
      catch (error) {
        if (options.rejected?.(error) && !active.aborted && options.active()) {
          const latest = await read(active), record = latest.journal.entries.find((item) => item.request.input.operationId === entry.request.input.operationId)
          if (record?.phase === 'pending' && record.requestDigest === entry.requestDigest) { record.phase = 'rejected'; write(latest.journal, latest.raw) }
        }
        throw error
      }
      current(active)
      const completion = await lookup(entry, active)
      if (!completion) throw new Error('已提交的工坊操作尚未找到原回执，请保留记录继续核对，不会自动重发。')
      await confirm(entry, completion, active)
      return structuredClone(completion)
    }), scopeActive)
  }
  async function retry(operationId?: string, request?: WorkshopOperationRequest, signal?: AbortSignal, scopeActive?: () => boolean) {
    const id = operationId ?? state.pending?.request.input.operationId ?? state.selected?.request.input.operationId
    const entry = state.entries.find((record) => record.request.input.operationId === id)
    if (!entry) throw new WorkshopOperationNotSubmittedError('未找到原工坊操作，请重新读取；本次操作未提交。')
    return await send(request ?? fullRequest(entry.request), signal, entry.request.input.operationId, scopeActive)
  }
  return {
    key, keys: [key, galleryKey], snapshot, reload, submit: (request, signal, scopeActive) => send(request, signal, undefined, scopeActive), inspect, retry, select,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    stopWaiting() { for (const controller of controllers) controller.abort(); missingPermit = null; emit({ retryAvailable: false }) },
    dispose() { disposed = true; ++generation; ++loadGeneration; for (const controller of controllers) controller.abort(); listeners.clear(); results.clear(); missingPermit = null },
  }
}
