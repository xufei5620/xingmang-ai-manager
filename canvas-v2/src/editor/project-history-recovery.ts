import type { CanvasProjectRestoreInput } from '../lib/project-history-contract'

export interface ProjectHistoryRecoveryRecord {
  version: 1
  ownerId: string
  projectId: string
  input: CanvasProjectRestoreInput
  createdAt: string
}

export interface ProjectHistoryRecoveryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ProjectHistoryRecoveryLock {
  run<T>(key: string, work: () => Promise<T>): Promise<T>
}

export const projectHistoryRecoveryEvent = 'xingmang:project-history-recovery'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const invalidMessage = '本机版本恢复记录无法可靠读取或已变化，请保留浏览器数据并核对原操作；当前不会提交新的恢复。'

function invalid(): never { throw new Error(invalidMessage) }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function exactKeys(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) invalid() }

export function projectHistoryRecoveryKey(ownerId: string, projectId: string): string {
  if (!uuid.test(ownerId) || !uuid.test(projectId)) invalid()
  return `xingmang:project-history-recovery:v1:${ownerId}:${projectId}`
}

/** Only the immutable restore identity is durable. The existing draft store
 * protects document content; this journal never duplicates private workflows. */
export function parseProjectHistoryRecoveryRecord(value: unknown, ownerId: string, projectId: string): ProjectHistoryRecoveryRecord {
  projectHistoryRecoveryKey(ownerId, projectId)
  if (!object(value)) invalid()
  exactKeys(value, ['version', 'ownerId', 'projectId', 'input', 'createdAt'])
  if (value.version !== 1 || value.ownerId !== ownerId || value.projectId !== projectId || !object(value.input)) invalid()
  exactKeys(value.input, ['operationId', 'revisionId', 'expectedVersion'])
  if (typeof value.input.operationId !== 'string' || !operationId.test(value.input.operationId)
    || typeof value.input.revisionId !== 'string' || !/^[0-9a-f]{32}$/.test(value.input.revisionId)
    || typeof value.input.expectedVersion !== 'number' || !Number.isSafeInteger(value.input.expectedVersion) || value.input.expectedVersion < 1 || value.input.expectedVersion >= Number.MAX_SAFE_INTEGER
    || typeof value.createdAt !== 'string' || value.createdAt.length > 32 || !Number.isFinite(Date.parse(value.createdAt))) invalid()
  return { version: 1, ownerId, projectId, input: { operationId: value.input.operationId, revisionId: value.input.revisionId, expectedVersion: value.input.expectedVersion }, createdAt: value.createdAt }
}

export function readProjectHistoryRecovery(storage: ProjectHistoryRecoveryStorage, ownerId: string, projectId: string): ProjectHistoryRecoveryRecord | null {
  try {
    const raw = storage.getItem(projectHistoryRecoveryKey(ownerId, projectId))
    if (raw === null) return null
    if (raw.length > 2048) invalid()
    return parseProjectHistoryRecoveryRecord(JSON.parse(raw), ownerId, projectId)
  } catch { invalid() }
}

export function assertProjectHistoryRecoveryStored(storage: ProjectHistoryRecoveryStorage, record: ProjectHistoryRecoveryRecord): void {
  const canonical = parseProjectHistoryRecoveryRecord(record, record.ownerId, record.projectId)
  const actual = readProjectHistoryRecovery(storage, canonical.ownerId, canonical.projectId)
  if (!actual || JSON.stringify(actual) !== JSON.stringify(canonical)) invalid()
}

function changed() { if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event(projectHistoryRecoveryEvent)) }

export function writeProjectHistoryRecovery(storage: ProjectHistoryRecoveryStorage, record: ProjectHistoryRecoveryRecord): ProjectHistoryRecoveryRecord {
  const canonical = parseProjectHistoryRecoveryRecord(record, record.ownerId, record.projectId)
  const previous = readProjectHistoryRecovery(storage, canonical.ownerId, canonical.projectId)
  if (previous && JSON.stringify(previous) !== JSON.stringify(canonical)) throw new Error('这个工程还有一项版本恢复待核对；本次没有提交新的恢复。')
  try {
    storage.setItem(projectHistoryRecoveryKey(canonical.ownerId, canonical.projectId), JSON.stringify(canonical))
    assertProjectHistoryRecoveryStored(storage, canonical)
  } catch { throw new Error('本机版本恢复记录尚未可靠保存，恢复请求未提交；请检查浏览器存储后重试。') }
  changed()
  return canonical
}

export function clearProjectHistoryRecovery(storage: ProjectHistoryRecoveryStorage, record: ProjectHistoryRecoveryRecord): void {
  // The caller holds the same cross-page lease as submission. Readback alone
  // cannot make a storage read/remove sequence atomic across browser processes.
  assertProjectHistoryRecoveryStored(storage, record)
  try {
    const key = projectHistoryRecoveryKey(record.ownerId, record.projectId)
    storage.removeItem(key)
    if (storage.getItem(key) !== null) invalid()
  } catch { throw new Error('原恢复结果已返回，但本机记录尚未清除；请继续保留记录核对，不会自动提交另一项恢复。') }
  changed()
}

export function browserProjectHistoryRecoveryLock(): ProjectHistoryRecoveryLock | null {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return null
  return { async run<T>(key: string, work: () => Promise<T>): Promise<T> { return await navigator.locks.request(key, { mode: 'exclusive' }, work) } }
}

export async function withProjectHistoryRecoveryLock<T>(ownerId: string, projectId: string, current: () => boolean, work: () => Promise<T>, lock = browserProjectHistoryRecoveryLock()): Promise<T> {
  const key = projectHistoryRecoveryKey(ownerId, projectId)
  if (!lock) throw new Error('当前浏览器不支持跨页面协调版本恢复；可核对原结果，请使用支持安全协调的浏览器再提交或重试。')
  return await lock.run(key, async () => {
    if (!current()) throw new Error('工程、账号或窗口已变化，版本恢复请求未提交；原操作记录仍保留。')
    return await work()
  })
}
