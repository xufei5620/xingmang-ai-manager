import { projectCollaborationLimits, type ProjectCollaborationJoinInput, type ProjectCollaborationMutationInput } from '../lib/project-collaboration-contract'

export type CollaborationJournalMethod = 'join' | 'mutate'
export type CollaborationJournalRequest = ProjectCollaborationJoinInput | ProjectCollaborationMutationInput
export interface CollaborationJournalStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
export interface CollaborationJournalRecord {
  version: 1
  ownerId: string
  projectId: string
  operationId: string
  method: CollaborationJournalMethod
  requestJson: string
  payloadDigest: string
  createdAt: number
}
interface JournalDependencies {
  ownerId: string
  projectId: string
  storage: CollaborationJournalStorage
  parseRequest(method: CollaborationJournalMethod, value: unknown): CollaborationJournalRequest
  active(): boolean
  now?(): number
}

const maximumKeys = 10_000
const maximumRecords = 8
const readError = '原协作操作记录无法核对，请保留浏览器数据；当前不会重发或改用整图保存。'
const writeError = '协作操作未能可靠保存在本机，尚未提交；请保留当前编辑并检查浏览器存储。'

function identity(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength }
async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function hasProjectCollaborationJournal(storage: CollaborationJournalStorage, ownerId: string, projectId: string): boolean {
  if (!identity(ownerId) || !identity(projectId) || !Number.isSafeInteger(storage.length) || storage.length < 0 || storage.length > maximumKeys) throw new Error(readError)
  const prefix = `xingmang:project-collaboration:${ownerId}:${projectId}:`
  for (let index = 0; index < storage.length; index++) if (storage.key(index)?.startsWith(prefix)) return true
  return false
}

/** The local byte digest is not the server's requestDigest or an authorization. */
export function createProjectCollaborationJournal(dependencies: JournalDependencies) {
  const { storage, ownerId, projectId } = dependencies
  if (!identity(ownerId) || !identity(projectId)) throw new Error(readError)
  const scopePrefix = `xingmang:project-collaboration:${ownerId}:${projectId}:`
  const prefix = `${scopePrefix}v1:`
  const archivePrefix = `xingmang:project-collaboration-abandoned:${ownerId}:${projectId}:v1:`
  function active() { if (!dependencies.active()) throw new Error('账号或工程已变化，协作记录保留在原范围，当前操作已停止。') }
  function key(operationId: string) { if (!identity(operationId)) throw new Error(readError); return prefix + operationId }
  function encoded(record: CollaborationJournalRecord) { return JSON.stringify(record) }
  function assertStored(record: CollaborationJournalRecord): void {
    active()
    if (record.version !== 1 || record.ownerId !== ownerId || record.projectId !== projectId) throw new Error(readError)
    if (storage.getItem(key(record.operationId)) !== encoded(record)) throw new Error(readError)
  }
  function request(record: CollaborationJournalRecord): CollaborationJournalRequest {
    const parsed = dependencies.parseRequest(record.method, JSON.parse(record.requestJson))
    if (parsed.operationId !== record.operationId || (record.method === 'join') !== (parsed.action === 'join' || parsed.action === 'resync')) throw new Error(readError)
    return parsed
  }
  async function parse(raw: string, storageKey: string): Promise<CollaborationJournalRecord> {
    if (byteLength(raw) > projectCollaborationLimits.requestBytes * 2 + 4096) throw new Error(readError)
    let value: unknown
    try { value = JSON.parse(raw) } catch { throw new Error(readError) }
    if (!object(value) || Object.keys(value).length !== 8 || Object.keys(value).some((field) => !['version', 'ownerId', 'projectId', 'operationId', 'method', 'requestJson', 'payloadDigest', 'createdAt'].includes(field))) throw new Error(readError)
    if (value.version !== 1 || value.ownerId !== ownerId || value.projectId !== projectId || !identity(value.operationId) || storageKey !== key(value.operationId)
      || !['join', 'mutate'].includes(String(value.method)) || typeof value.requestJson !== 'string' || byteLength(value.requestJson) > projectCollaborationLimits.requestBytes
      || typeof value.payloadDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.payloadDigest)
      || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw new Error(readError)
    const record: CollaborationJournalRecord = { version: 1, ownerId, projectId, operationId: value.operationId, method: value.method as CollaborationJournalMethod, requestJson: value.requestJson, payloadDigest: value.payloadDigest, createdAt: value.createdAt }
    request(record)
    if (await digest(record.requestJson) !== record.payloadDigest) throw new Error(readError)
    active()
    if (storage.getItem(storageKey) !== raw) throw new Error(readError)
    return Object.freeze(record)
  }
  async function read(): Promise<CollaborationJournalRecord[]> {
    active()
    if (!Number.isSafeInteger(storage.length) || storage.length < 0 || storage.length > maximumKeys) throw new Error(readError)
    const entries: Array<[string, string]> = []
    for (let index = 0; index < storage.length; index++) {
      const name = storage.key(index)
      if (!name?.startsWith(scopePrefix)) continue
      if (!name.startsWith(prefix)) throw new Error(readError)
      const raw = storage.getItem(name)
      if (raw === null || entries.length >= maximumRecords) throw new Error(readError)
      entries.push([name, raw])
    }
    const records: CollaborationJournalRecord[] = []
    for (const [name, raw] of entries) records.push(await parse(raw, name))
    active()
    return records.sort((left, right) => left.createdAt - right.createdAt || left.operationId.localeCompare(right.operationId))
  }
  return {
    read,
    request,
    assertStored,
    async prepare(method: CollaborationJournalMethod, input: CollaborationJournalRequest): Promise<CollaborationJournalRecord> {
      active()
      const parsed = dependencies.parseRequest(method, input)
      if (!identity(parsed.operationId) || (method === 'join') !== (parsed.action === 'join' || parsed.action === 'resync')) throw new Error(readError)
      if (storage.getItem(archivePrefix + parsed.operationId) !== null) throw new Error('这条原操作已明确放弃本页重试，原档仍保留；不能再次发送。')
      const requestJson = JSON.stringify(parsed)
      if (byteLength(requestJson) > projectCollaborationLimits.requestBytes) throw new Error(writeError)
      const records = await read()
      const existing = records.find((record) => record.operationId === parsed.operationId)
      if (existing) {
        if (existing.method !== method || existing.requestJson !== requestJson) throw new Error(readError)
        assertStored(existing)
        return existing
      }
      if (records.length) throw new Error('原协作操作尚未确认，请先核对；当前编辑不会替换或重发原操作。')
      const payloadDigest = await digest(requestJson)
      active()
      // Another tab can write during the digest await. Never replace its operation.
      if ((await read()).length || storage.getItem(key(parsed.operationId)) !== null) throw new Error(readError)
      const createdAt = dependencies.now?.() ?? Date.now()
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error(writeError)
      const record: CollaborationJournalRecord = Object.freeze({ version: 1, ownerId, projectId, operationId: parsed.operationId, method, requestJson, payloadDigest, createdAt })
      try { storage.setItem(key(record.operationId), encoded(record)); assertStored(record) }
      catch { throw new Error(writeError) }
      return record
    },
    confirm(record: CollaborationJournalRecord): void {
      assertStored(record)
      storage.removeItem(key(record.operationId))
      active()
      if (storage.getItem(key(record.operationId)) !== null) throw new Error('协作回执已确认，但本机原记录尚未清理；请保留记录并再次核对。')
    },
    archiveRejected(record: CollaborationJournalRecord): void {
      assertStored(record)
      const name = archivePrefix + record.operationId, raw = encoded(record), previous = storage.getItem(name)
      if (previous !== null && previous !== raw) throw new Error(readError)
      storage.setItem(name, raw)
      active()
      if (storage.getItem(name) !== raw) throw new Error('原操作尚未可靠留档，未放弃重试；请保留全部记录。')
      assertStored(record)
      storage.removeItem(key(record.operationId))
      active()
      if (storage.getItem(key(record.operationId)) !== null) throw new Error('原档已保留，但待核对记录尚未清理；请重新核对。')
    },
  }
}
