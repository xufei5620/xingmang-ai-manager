import { parseWorkflowFile } from '../model'

export interface TemplateProjectSubmission { operationId: string; signature: string; content: string }

export interface SavedTemplateProjectSubmission extends TemplateProjectSubmission {
  version: 1
  ownerId: number
  templateId: string
}

export interface TemplateProjectSubmissionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const maximumTemplateContentBytes = 2 * 1024 * 1024
const maximumSavedSubmissionBytes = maximumTemplateContentBytes * 8 + 2048
const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const savedFields = new Set(['version', 'ownerId', 'operationId', 'templateId', 'signature', 'content'])
const storageReadError = '本地模板恢复记录无法读取，请保留浏览器数据并核对原工程；当前不会重新提交创建。'
const storageWriteError = '本地模板配置保存失败，浏览器存储空间不足或存储被禁用。请保留当前配置并检查存储权限；当前尚未提交创建。'

function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength }

function submissionKey(ownerId: number, operationId: string): string {
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || typeof operationId !== 'string' || operationId.length !== 36 || !operationIdPattern.test(operationId)) throw new Error('模板恢复账号或操作编号无效，请保留原配置并重新核对。')
  return `xingmang:canvas-template-submission:v1:${ownerId}:${operationId}`
}

function validateSavedSubmission(value: unknown): SavedTemplateProjectSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模板恢复记录格式无效，请保留原配置并重新核对。')
  const raw = value as Record<string, unknown>
  const keys = Object.keys(raw)
  if (keys.length !== savedFields.size || keys.some((key) => !savedFields.has(key)) || raw.version !== 1
    || typeof raw.ownerId !== 'number' || typeof raw.operationId !== 'string'
    || typeof raw.templateId !== 'string' || raw.templateId.trim() !== raw.templateId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw.templateId)
    || typeof raw.signature !== 'string' || !raw.signature.trim() || typeof raw.content !== 'string') throw new Error('模板恢复记录格式无效，请保留原配置并重新核对。')
  submissionKey(raw.ownerId, raw.operationId)
  if (raw.signature.length > maximumTemplateContentBytes || byteLength(raw.signature) > maximumTemplateContentBytes) throw new Error('模板配置超过本地恢复记录的 2 MB 上限，请减少内容后重试。')
  if (raw.content.length > maximumTemplateContentBytes || byteLength(raw.content) > maximumTemplateContentBytes) throw new Error('模板工作流超过本地恢复记录的 2 MB 上限，请减少内容后重试。')
  if (!parseWorkflowFile(raw.content)) throw new Error('模板工作流无法安全保存，请保留当前配置并检查节点内容。')
  return { version: 1, ownerId: raw.ownerId, operationId: raw.operationId, templateId: raw.templateId, signature: raw.signature, content: raw.content }
}

function equalSubmission(left: SavedTemplateProjectSubmission, right: SavedTemplateProjectSubmission): boolean {
  return left.version === right.version && left.ownerId === right.ownerId && left.operationId === right.operationId
    && left.templateId === right.templateId && left.signature === right.signature && left.content === right.content
}

export function readSavedTemplateProjectSubmission(storage: TemplateProjectSubmissionStorage, ownerId: number, operationId: string): SavedTemplateProjectSubmission | null {
  const key = submissionKey(ownerId, operationId)
  let encoded: string | null
  try { encoded = storage.getItem(key) } catch { throw new Error(storageReadError) }
  if (encoded === null) return null
  try {
    if (typeof encoded !== 'string' || encoded.length > maximumSavedSubmissionBytes || byteLength(encoded) > maximumSavedSubmissionBytes) throw new Error(storageReadError)
    const saved = validateSavedSubmission(JSON.parse(encoded))
    if (saved.ownerId !== ownerId || saved.operationId !== operationId) throw new Error(storageReadError)
    return saved
  } catch { throw new Error(storageReadError) }
}

export function writeSavedTemplateProjectSubmission(storage: TemplateProjectSubmissionStorage, input: SavedTemplateProjectSubmission): void {
  const saved = validateSavedSubmission(input)
  const key = submissionKey(saved.ownerId, saved.operationId)
  const existing = readSavedTemplateProjectSubmission(storage, saved.ownerId, saved.operationId)
  if (existing) {
    if (!equalSubmission(existing, saved)) throw new Error('原模板创建结果尚未确认，本地恢复记录不会覆盖为其他配置；请先核对原操作。')
    return
  }
  try { storage.setItem(key, JSON.stringify(saved)) } catch { throw new Error(storageWriteError) }
  const confirmed = readSavedTemplateProjectSubmission(storage, saved.ownerId, saved.operationId)
  if (!confirmed || !equalSubmission(confirmed, saved)) throw new Error(storageWriteError)
}

export function clearSavedTemplateProjectSubmission(storage: TemplateProjectSubmissionStorage, input: SavedTemplateProjectSubmission): void {
  const saved = validateSavedSubmission(input)
  const key = submissionKey(saved.ownerId, saved.operationId)
  const existing = readSavedTemplateProjectSubmission(storage, saved.ownerId, saved.operationId)
  // A late acknowledgement cannot clear a newer or differently scoped record.
  if (!existing || !equalSubmission(existing, saved)) return
  const cleanupError = '原工程已确认，但本地模板恢复记录暂未清除；请检查浏览器存储权限后再核对。'
  try { storage.removeItem(key) } catch { throw new Error(cleanupError) }
  const remaining = readSavedTemplateProjectSubmission(storage, saved.ownerId, saved.operationId)
  if (remaining && equalSubmission(remaining, saved)) throw new Error(cleanupError)
}

/** Keep the exact first submission after an unknown response; retries cannot create a second project. */
export function createTemplateProjectSubmission() {
  let pending: TemplateProjectSubmission | null = null
  let busy = false
  return {
    prepare(operationId: string, signature: string, build: () => string): TemplateProjectSubmission {
      if (busy) throw new Error('模板工程仍在创建，请等待当前结果')
      if (pending && (pending.operationId !== operationId || pending.signature !== signature)) throw new Error('上次模板创建结果尚未确认，请先按原配置重试核对，或返回项目中心查看原工程')
      if (!pending) pending = { operationId, signature, content: build() }
      busy = true
      return pending
    },
    settled() { busy = false },
    confirmed() { busy = false; pending = null },
  }
}

export function templateProjectOperationId(search: URLSearchParams, createId: () => string): string {
  const existing = search.get('templateOperation')
  return existing && existing.length === 36 && operationIdPattern.test(existing.toLowerCase()) ? existing.toLowerCase() : createId()
}
