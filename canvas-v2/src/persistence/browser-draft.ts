import { parseWorkflowFile, serializeWorkflow } from '../model'
import { workflowHasExtendedViewport } from '../lib/viewport-range-contract'

export interface CanvasBrowserDraft {
  format: 1
  ownerId: number
  projectId: string
  writerId: string
  revision: string
  cloudVersion: number
  updatedAt: string
  content: string
}

export type CanvasBrowserDraftIdentity = Pick<CanvasBrowserDraft, 'ownerId' | 'projectId' | 'writerId' | 'revision'>
export type CanvasBrowserDraftSelection = Pick<CanvasBrowserDraft, 'writerId' | 'revision'>

export function isSameCanvasBrowserDraftIdentity(left: CanvasBrowserDraftIdentity | null | undefined, right: CanvasBrowserDraftIdentity | null | undefined): boolean {
  return Boolean(left && right && left.ownerId === right.ownerId && left.projectId === right.projectId && left.writerId === right.writerId && left.revision === right.revision)
}

export function isCanvasBrowserDraftSelected(draft: CanvasBrowserDraftIdentity, selection: CanvasBrowserDraftSelection | null | undefined): boolean {
  return Boolean(selection && draft.writerId === selection.writerId && draft.revision === selection.revision)
}

export function selectCanvasBrowserDraft(drafts: readonly CanvasBrowserDraft[], selection: CanvasBrowserDraftSelection | null | undefined): CanvasBrowserDraft | null {
  return drafts.find((draft) => isCanvasBrowserDraftSelected(draft, selection)) ?? null
}

export interface CanvasDraftStorage {
  length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface CanvasBrowserDraftWriterRotation {
  writerId: string
  revisionSequence: 0
}

const storagePrefix = 'xingmang:canvas-draft:v1:'
const extendedStoragePrefix = 'xingmang:canvas-draft:v2:'
const maximumContentBytes = 2 * 1024 * 1024
const maximumOwnerDraftBytes = 4 * 1024 * 1024
const maximumProjectWriters = 4
const sensitiveField = /(?:key|password|token|authorization|cookie|secret|credential)/i
const storageReadError = '无法读取本地草稿，请检查浏览器存储权限；当前编辑内容请先导出工作流保存'
const storageWriteError = '本地草稿保存失败，浏览器存储空间不足或存储被禁用。请立即导出工作流，再检查浏览器存储权限后重试'

function byteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength
}

function validateIdentity(ownerId: number, projectId: string, writerId?: string, revision?: string): void {
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0
    || typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)
    || (writerId !== undefined && (typeof writerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(writerId)))
    || (revision !== undefined && (typeof revision !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(revision)))) {
    throw new Error('本地草稿标识无效，请导出当前工作流后重新打开工程')
  }
}

function ownerPrefix(ownerId: number, extended = false): string {
  return `${extended ? extendedStoragePrefix : storagePrefix}${ownerId}:`
}

function projectPrefix(ownerId: number, projectId: string, extended = false): string {
  return `${ownerPrefix(ownerId, extended)}${projectId}:`
}

function legacyDraftKey(draft: Pick<CanvasBrowserDraft, 'ownerId' | 'projectId' | 'writerId'>): string {
  return `${projectPrefix(draft.ownerId, draft.projectId)}${draft.writerId}`
}

function oldRevisionKey(draft: CanvasBrowserDraftIdentity): string {
  return `${projectPrefix(draft.ownerId, draft.projectId)}${draft.writerId}:${draft.revision}`
}

function draftKey(draft: CanvasBrowserDraft): string {
  // localStorage has no compare-and-delete primitive. Separate immutable
  // revision keys ensure deleting an acknowledged version cannot delete a
  // newer version written by its originating tab during the same operation.
  return `${projectPrefix(draft.ownerId, draft.projectId, workflowHasExtendedViewport(draft.content))}${draft.writerId}:${draft.revision}`
}

/** A preserved writer must never become the key for subsequent cloud edits. */
export function buildCanvasBrowserDraftWriterRotation(currentWriterId: string, nextWriterId: string): CanvasBrowserDraftWriterRotation {
  if (typeof currentWriterId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(currentWriterId)
    || typeof nextWriterId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(nextWriterId) || nextWriterId === currentWriterId) {
    throw new Error('新的草稿写入标识无效，当前画布与草稿仍保留，请导出工作流后重试')
  }
  return { writerId: nextWriterId, revisionSequence: 0 }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stripSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitiveFields)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !sensitiveField.test(key))
    .map(([key, entry]) => [key, stripSensitiveFields(entry)]))
}

function sanitizeContent(content: string): string {
  const oversizeError = '当前工作流超过本地草稿的 2 MB 上限，请先导出工作流，减少内容后再重试'
  if (typeof content !== 'string') throw new Error('本地草稿内容无效，请导出当前工作流后重新打开工程')
  if (content.length > maximumContentBytes || byteLength(content) > maximumContentBytes) throw new Error(oversizeError)
  const workflow = parseWorkflowFile(content)
  if (!workflow) throw new Error('本地草稿内容无法安全保存，请先导出工作流并检查节点内容')
  // The workflow schema permits arbitrary settings. Its existing sanitizer
  // strips API credentials, but generic settings.key/settings.token must also
  // be excluded from browser persistence, including nested objects.
  const safeWorkflow = parseWorkflowFile(JSON.stringify(stripSensitiveFields(JSON.parse(serializeWorkflow(workflow)))))
  if (!safeWorkflow) throw new Error('本地草稿内容无法安全保存，请先导出工作流并检查节点内容')
  const normalized = serializeWorkflow(safeWorkflow)
  if (byteLength(normalized) > maximumContentBytes) throw new Error(oversizeError)
  return normalized
}

export function createCanvasBrowserDraft(input: {
  ownerId: number
  projectId: string
  writerId: string
  revision: string
  cloudVersion: number
  content: string
  updatedAt?: string
}): CanvasBrowserDraft {
  validateIdentity(input.ownerId, input.projectId, input.writerId, input.revision)
  if (typeof input.writerId !== 'string' || typeof input.revision !== 'string'
    || !Number.isSafeInteger(input.cloudVersion) || input.cloudVersion < 0) {
    throw new Error('本地草稿版本无效，请导出当前工作流后重新打开工程')
  }
  const updatedAt = input.updatedAt === undefined ? new Date().toISOString() : input.updatedAt
  if (typeof updatedAt !== 'string' || updatedAt.length > 40 || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error('本地草稿时间无效，请导出当前工作流后重新打开工程')
  }
  return {
    format: 1,
    ownerId: input.ownerId,
    projectId: input.projectId,
    writerId: input.writerId,
    revision: input.revision,
    cloudVersion: input.cloudVersion,
    updatedAt: new Date(updatedAt).toISOString(),
    content: sanitizeContent(input.content),
  }
}

function readStorageKeys(storage: CanvasDraftStorage, prefix: string): string[] {
  try {
    const length = storage.length
    if (!Number.isSafeInteger(length) || length < 0) throw new Error(storageReadError)
    const keys = new Set<string>()
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index)
      if (typeof key === 'string' && key.startsWith(prefix)) keys.add(key)
    }
    return [...keys]
  } catch { throw new Error(storageReadError) }
}

function readStorageValue(storage: CanvasDraftStorage, key: string): string | null {
  try { return storage.getItem(key) }
  catch { throw new Error(storageReadError) }
}

function parseStoredDraft(content: string, key: string): CanvasBrowserDraft {
  try {
    if (content.length > maximumOwnerDraftBytes || byteLength(content) > maximumOwnerDraftBytes) throw new Error(storageReadError)
    const raw: unknown = JSON.parse(content)
    if (!isRecord(raw) || raw.format !== 1
      || typeof raw.ownerId !== 'number' || typeof raw.projectId !== 'string'
      || typeof raw.writerId !== 'string' || typeof raw.revision !== 'string'
      || typeof raw.cloudVersion !== 'number' || typeof raw.updatedAt !== 'string'
      || typeof raw.content !== 'string') throw new Error(storageReadError)
    const draft = createCanvasBrowserDraft({
      ownerId: raw.ownerId, projectId: raw.projectId, writerId: raw.writerId,
      revision: raw.revision, cloudVersion: raw.cloudVersion,
      updatedAt: raw.updatedAt, content: raw.content,
    })
    if (draftKey(draft) !== key && oldRevisionKey(draft) !== key && legacyDraftKey(draft) !== key) throw new Error(storageReadError)
    return draft
  } catch { throw new Error('本地草稿无法读取或内容超过限制，请保留浏览器数据并先导出当前工作流后重试') }
}

/** Confirm the disk copy before an action replaces the in-memory graph. */
export function assertCanvasBrowserDraftStored(storage: CanvasDraftStorage, draft: CanvasBrowserDraft): void {
  validateIdentity(draft.ownerId, draft.projectId, draft.writerId, draft.revision)
  let key = draftKey(draft)
  let value = readStorageValue(storage, key)
  if (value === null) { key = oldRevisionKey(draft); value = readStorageValue(storage, key) }
  if (value === null) {
    key = legacyDraftKey(draft)
    value = readStorageValue(storage, key)
  }
  const error = '旧编辑尚未确认保存在本地，请保留当前画布并先导出工作流，再重新读取云端'
  if (value === null || draft.format !== 1) throw new Error(error)
  let stored: CanvasBrowserDraft
  try { stored = parseStoredDraft(value, key) }
  catch { throw new Error(error) }
  if (stored.revision !== draft.revision || stored.cloudVersion !== draft.cloudVersion || stored.content !== draft.content) throw new Error(error)
}

export function listCanvasBrowserDrafts(storage: CanvasDraftStorage, ownerId: number, projectId: string): CanvasBrowserDraft[] {
  validateIdentity(ownerId, projectId)
  const drafts: CanvasBrowserDraft[] = []
  const keys = [...readStorageKeys(storage, projectPrefix(ownerId, projectId, true)), ...readStorageKeys(storage, projectPrefix(ownerId, projectId))]
  for (const key of keys) {
    const value = readStorageValue(storage, key)
    if (value === null) continue
    const draft = parseStoredDraft(value, key)
    if (draft.ownerId !== ownerId || draft.projectId !== projectId) continue
    if (key.startsWith(storagePrefix) && workflowHasExtendedViewport(draft.content)) {
      // Older pages enumerate only v1. Preserve that original record and copy
      // only a verified owner/project draft through the same bounded admission
      // checks before offering it for recovery. No cloud write is performed.
      try { writeCanvasBrowserDraftRecord(storage, draft, true) }
      catch { throw new Error('旧版视口草稿迁入保护空间失败，原记录仍保留；请导出草稿并核对浏览器空间或同版本冲突后重试') }
    }
    const duplicate = drafts.find((entry) => isSameCanvasBrowserDraftIdentity(entry, draft))
    if (duplicate) {
      if (duplicate.content !== draft.content || duplicate.cloudVersion !== draft.cloudVersion || duplicate.updatedAt !== draft.updatedAt) throw new Error('本地草稿同一版本存在不同内容，请保留浏览器数据并先导出当前工作流后核对')
    } else drafts.push(draft)
  }
  return drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.writerId.localeCompare(right.writerId) || left.revision.localeCompare(right.revision))
}

export function writeCanvasBrowserDraft(storage: CanvasDraftStorage, draft: CanvasBrowserDraft): CanvasBrowserDraft {
  return writeCanvasBrowserDraftRecord(storage, draft, false)
}

function writeCanvasBrowserDraftRecord(storage: CanvasDraftStorage, draft: CanvasBrowserDraft, retainWriterRevisions: boolean): CanvasBrowserDraft {
  if (draft.format !== 1) throw new Error('本地草稿格式无效，请导出当前工作流后重新打开工程')
  const normalized = createCanvasBrowserDraft(draft)
  const key = draftKey(normalized)
  const value = JSON.stringify(normalized)
  const ownProjectPrefixes = [projectPrefix(normalized.ownerId, normalized.projectId), projectPrefix(normalized.ownerId, normalized.projectId, true)]
  const existingWriters = new Set<string>()
  const superseded: Array<{ key: string; value: string }> = []
  let totalBytes = byteLength(value)
  // Budget all projects of this account without reading another account's
  // values. Browser-wide quota failure remains a visible error and never
  // justifies evicting another writer's only unsaved copy.
  // These synchronous admission checks are not a cross-tab transaction:
  // simultaneous new writers may each see room. Revision-specific keys
  // protect existing copies, while the actual browser quota remains final.
  for (const existingKey of [...readStorageKeys(storage, ownerPrefix(normalized.ownerId)), ...readStorageKeys(storage, ownerPrefix(normalized.ownerId, true))]) {
    const existingValue = readStorageValue(storage, existingKey)
    if (existingValue === null) continue
    if (existingKey === key) {
      if (existingValue !== value) throw new Error('此草稿版本已经保存了不同内容，请保留原草稿并使用新的版本标识重试')
      continue
    }
    if (ownProjectPrefixes.some((prefix) => existingKey.startsWith(prefix))) {
      const previous = parseStoredDraft(existingValue, existingKey)
      if (!retainWriterRevisions && previous.writerId === normalized.writerId && existingKey === draftKey(previous) && existingKey !== oldRevisionKey(previous)) {
        superseded.push({ key: existingKey, value: existingValue })
        continue
      }
      if (!retainWriterRevisions && previous.writerId === normalized.writerId && !workflowHasExtendedViewport(previous.content) && existingKey === oldRevisionKey(previous)) { superseded.push({ key: existingKey, value: existingValue }); continue }
      if (previous.writerId !== normalized.writerId) existingWriters.add(previous.writerId)
    }
    totalBytes += byteLength(existingValue)
  }
  if (existingWriters.size >= maximumProjectWriters) {
    throw new Error('此工程已有 4 份未保存或保留草稿，请先管理已有草稿；导出需要保留的内容后，可明确删除支持安全清理的草稿再重试')
  }
  if (totalBytes > maximumOwnerDraftBytes) {
    throw new Error('本账户的本地草稿超过 4 MB 上限，请先管理已有草稿；导出需要保留的内容后，可明确删除支持安全清理的草稿再重试')
  }
  try { storage.setItem(key, value) }
  catch { throw new Error(storageWriteError) }
  if (readStorageValue(storage, key) !== value) throw new Error('本地草稿保存结果尚未确认，请立即导出当前工作流并重新读取草稿；已有副本仍保留')
  // Updating this writer is the existing replacement operation, not eviction
  // of another writer. Its old immutable keys are removed only after the new
  // copy is confirmed; writer-only legacy keys remain untouched because an
  // older application tab may still replace them concurrently.
  for (const previous of superseded) {
    const current = readStorageValue(storage, previous.key)
    if (current === null) continue
    if (current !== previous.value) throw new Error('旧草稿清理尚未确认，新旧副本均需核对；请先导出当前工作流后重新读取草稿')
    try { storage.removeItem(previous.key) }
    catch { throw new Error('新草稿已持有，旧草稿清理失败，请检查浏览器存储权限后重新核对；未自动删除其他草稿') }
    if (readStorageValue(storage, previous.key) !== null) throw new Error('旧草稿清理尚未确认，新旧副本均需核对；请先导出当前工作流后重新读取草稿')
  }
  return normalized
}

function removeCanvasBrowserDraft(storage: CanvasDraftStorage, draft: CanvasBrowserDraft, requireSnapshot: boolean): boolean {
  validateIdentity(draft.ownerId, draft.projectId, draft.writerId, draft.revision)
  if (draft.format !== 1 || typeof draft.writerId !== 'string' || typeof draft.revision !== 'string') {
    throw new Error('本地草稿标识无效，请导出当前工作流后重新打开工程')
  }
  const key = draftKey(draft)
  let value = readStorageValue(storage, key)
  if (value === null && key !== oldRevisionKey(draft)) {
    // A legacy copy cannot be mistaken for a protected-v2 removal receipt.
    if (readStorageValue(storage, oldRevisionKey(draft)) !== null) return false
  }
  if (value === null) return false
  let stored: unknown
  try { stored = JSON.parse(value) }
  catch { throw new Error(storageReadError) }
  // A cloud save only confirms the revision that was actually sent. Keeping
  // this check on the original writer also protects a draft recovered by a
  // different tab when its originating tab has already written newer edits.
  if (!isRecord(stored) || stored.format !== 1 || stored.ownerId !== draft.ownerId
    || stored.projectId !== draft.projectId || stored.writerId !== draft.writerId
    || stored.revision !== draft.revision || stored.content !== draft.content
    || (requireSnapshot && (stored.cloudVersion !== draft.cloudVersion || stored.updatedAt !== draft.updatedAt))) return false
  const legacyValue = readStorageValue(storage, legacyDraftKey(draft))
  if (key !== oldRevisionKey(draft) && readStorageValue(storage, oldRevisionKey(draft)) !== null) return false
  if (legacyValue !== null) {
    // Even a matching legacy copy is not safe to delete with localStorage.
    // Do not report a version removed while this unconfirmed copy remains.
    let legacy: unknown
    try { legacy = JSON.parse(legacyValue) } catch { throw new Error(storageReadError) }
    if (isRecord(legacy) && legacy.revision === draft.revision) return false
  }
  try { storage.removeItem(key) }
  catch { throw new Error('本地草稿清理失败，请检查浏览器存储权限后重试；已有草稿仍保留') }
  return readStorageValue(storage, key) === null
}

export function clearCanvasBrowserDraft(storage: CanvasDraftStorage, draft: CanvasBrowserDraft): boolean {
  return removeCanvasBrowserDraft(storage, draft, false)
}

export function confirmRemoveCanvasBrowserDraft(storage: CanvasDraftStorage, draft: CanvasBrowserDraft, confirmed: boolean): boolean {
  if (confirmed !== true) return false
  return removeCanvasBrowserDraft(storage, draft, true)
}
