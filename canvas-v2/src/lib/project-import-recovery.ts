import type { CanvasProjectPreview } from '../host'
import { isWorkspaceProjectSummary, type WorkspaceProjectSummary } from './workspace-project-summary'

export interface ProjectImportRecoveryAsset {
  sourceAssetId: string
  sha256: string
  mediaType: 'image' | 'video' | 'audio'
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4' | 'audio/mpeg' | 'audio/wav'
  byteSize: number
  width?: number
  height?: number
  durationSeconds?: number
}

/** Only identity metadata is durable. Workflow text and media bytes remain in the selected file. */
export interface ProjectImportRecoveryRecord {
  version: 1
  ownerId: string
  operationId: string
  fileName: string
  fileSha256: string
  fileBytes: number
  createdAt: string
  policy: 'drop' | 'reject'
  phase: 'assets' | 'commit'
  assets: ProjectImportRecoveryAsset[]
  creationDigest?: string
}

export type ProjectImportInspection =
  | { state: 'missing' }
  | { state: 'verification-required'; operationId: string }
  | { state: 'confirmed'; project: WorkspaceProjectSummary }
  | { state: 'deleted'; operationId: string; deletedAt: string }

export type ProjectImportRecoveryInspection = ProjectImportInspection & {
  assets: Array<{ sourceAssetId: string; state: 'ready' | 'missing' | 'pending' }>
}

export interface ProjectImportRecoveryPort {
  list(): ProjectImportRecoveryRecord[]
  inspect(operationId: string): Promise<ProjectImportRecoveryInspection>
  reselectFile(operationId: string, file: File): Promise<CanvasProjectPreview>
  finish(operationId: string): Promise<void>
}

export type ProjectImportRecoveryStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>
export const projectImportRecoveryLimits = { records: 12, recordBytes: 64 * 1024, fileBytes: 96 * 1024 * 1024, assets: 64 } as const
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sha = /^[0-9a-f]{64}$/

export class ProjectImportRecoveryRequiredError extends Error {
  readonly code = 'PROJECT_IMPORT_RECOVERY_REQUIRED'
  constructor(readonly operationId: string) { super('这个文件已有原导入操作，请先核对或继续原操作；不会创建另一份工程') }
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum }
function failed(): never { throw new Error('本机导入恢复记录无法读取，请保留原文件与记录后核对；尚未提交新的导入') }
function identifier(value: string): string { if (!uuid.test(value)) failed(); return value }
function prefix(ownerId: string): string { return `xingmang:project-import:v1:${identifier(ownerId)}:` }
function key(ownerId: string, operationId: string): string { return `${prefix(ownerId)}${identifier(operationId)}` }

export function parseProjectImportRecoveryRecord(value: unknown, ownerId: string): ProjectImportRecoveryRecord {
  if (!object(value) || Object.keys(value).some((name) => !['version', 'ownerId', 'operationId', 'fileName', 'fileSha256', 'fileBytes', 'createdAt', 'policy', 'phase', 'assets', 'creationDigest'].includes(name))
    || value.version !== 1 || value.ownerId !== identifier(ownerId) || typeof value.operationId !== 'string' || !uuid.test(value.operationId)
    || typeof value.fileName !== 'string' || !value.fileName.length || value.fileName.length > 240 || /[\u0000-\u001f\u007f/\\]/.test(value.fileName)
    || typeof value.fileSha256 !== 'string' || !sha.test(value.fileSha256) || !integer(value.fileBytes, 1, projectImportRecoveryLimits.fileBytes)
    || typeof value.createdAt !== 'string' || value.createdAt.length > 32 || !Number.isFinite(Date.parse(value.createdAt))
    || !['drop', 'reject'].includes(String(value.policy)) || !['assets', 'commit'].includes(String(value.phase))
    || (value.phase === 'commit' ? typeof value.creationDigest !== 'string' || !sha.test(value.creationDigest) : value.creationDigest !== undefined)
    || !Array.isArray(value.assets) || value.assets.length > projectImportRecoveryLimits.assets) failed()
  const ids = new Set<string>()
  let total = 0
  for (const asset of value.assets) {
    if (!object(asset) || Object.keys(asset).some((name) => !['sourceAssetId', 'sha256', 'mediaType', 'mimeType', 'byteSize', 'width', 'height', 'durationSeconds'].includes(name))
      || typeof asset.sourceAssetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(asset.sourceAssetId) || ids.has(asset.sourceAssetId)
      || typeof asset.sha256 !== 'string' || !sha.test(asset.sha256) || !integer(asset.byteSize, 1, 32 * 1024 * 1024)
      || !(asset.mediaType === 'image' && ['image/png', 'image/jpeg', 'image/webp'].includes(String(asset.mimeType)) || asset.mediaType === 'video' && asset.mimeType === 'video/mp4' || asset.mediaType === 'audio' && ['audio/mpeg', 'audio/wav'].includes(String(asset.mimeType)))
      || (asset.mediaType === 'audio' && (asset.width !== undefined || asset.height !== undefined))
      || (asset.mediaType === 'image' && (asset.width === undefined || asset.height === undefined))
      || (asset.width !== undefined && !integer(asset.width, 1, 16384)) || (asset.height !== undefined && !integer(asset.height, 1, 16384))
      || (typeof asset.width === 'number' && typeof asset.height === 'number' && asset.width * asset.height > 32_000_000)
      || (asset.durationSeconds !== undefined && (typeof asset.durationSeconds !== 'number' || !Number.isFinite(asset.durationSeconds) || asset.durationSeconds <= 0))) failed()
    ids.add(asset.sourceAssetId)
    total += asset.byteSize
  }
  if (total > projectImportRecoveryLimits.fileBytes) failed()
  return structuredClone(value) as unknown as ProjectImportRecoveryRecord
}

export function readProjectImportRecovery(storage: ProjectImportRecoveryStorage, ownerId: string, operationId: string): ProjectImportRecoveryRecord | null {
  try {
    const raw = storage.getItem(key(ownerId, operationId))
    if (raw === null) return null
    if (raw.length > projectImportRecoveryLimits.recordBytes) failed()
    const record = parseProjectImportRecoveryRecord(JSON.parse(raw), ownerId)
    if (record.operationId !== operationId) failed()
    return record
  } catch { failed() }
}

export function listProjectImportRecoveries(storage: ProjectImportRecoveryStorage, ownerId: string): ProjectImportRecoveryRecord[] {
  try {
    const start = prefix(ownerId)
    const records: ProjectImportRecoveryRecord[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const name = storage.key(index)
      if (!name?.startsWith(start)) continue
      const record = readProjectImportRecovery(storage, ownerId, name.slice(start.length))
      if (!record || records.length >= projectImportRecoveryLimits.records) failed()
      records.push(record)
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.operationId.localeCompare(right.operationId))
  } catch { failed() }
}

export function writeProjectImportRecovery(storage: ProjectImportRecoveryStorage, input: ProjectImportRecoveryRecord): void {
  const record = parseProjectImportRecoveryRecord(input, input.ownerId)
  const records = listProjectImportRecoveries(storage, record.ownerId)
  const previous = records.find((item) => item.operationId === record.operationId)
  if (previous) {
    const immutable = (item: ProjectImportRecoveryRecord) => JSON.stringify({ ...item, phase: undefined, creationDigest: undefined })
    if (immutable(previous) !== immutable(record) || previous.phase === 'commit' && previous.creationDigest !== record.creationDigest) throw new Error('原导入身份或最终摘要已变化，请核对原操作；尚未重复提交')
  } else {
    const same = records.find((item) => item.fileSha256 === record.fileSha256 && item.fileBytes === record.fileBytes)
    if (same) throw new ProjectImportRecoveryRequiredError(same.operationId)
    if (records.length >= projectImportRecoveryLimits.records) throw new Error('本机待核对导入已达上限，请先核对原操作')
  }
  const raw = JSON.stringify(record)
  if (new TextEncoder().encode(raw).byteLength > projectImportRecoveryLimits.recordBytes) failed()
  try {
    storage.setItem(key(record.ownerId, record.operationId), raw)
    if (storage.getItem(key(record.ownerId, record.operationId)) !== raw) failed()
  } catch { throw new Error('无法保存本机导入恢复记录，尚未继续上传或创建；请检查浏览器存储后重试') }
}

export function clearProjectImportRecovery(storage: ProjectImportRecoveryStorage, expected: ProjectImportRecoveryRecord): void {
  const current = readProjectImportRecovery(storage, expected.ownerId, expected.operationId)
  if (!current) return
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('原导入恢复记录已被另一页面更新，请重新核对后结束')
  try { storage.removeItem(key(expected.ownerId, expected.operationId)); if (storage.getItem(key(expected.ownerId, expected.operationId)) !== null) failed() }
  catch { throw new Error('本机导入记录尚未清除，请继续保留原操作并核对') }
}

export function parseProjectImportInspection(value: unknown, operationId: string, hasDigest: boolean): ProjectImportInspection {
  if (!object(value)) failed()
  if (value.state === 'missing' && Object.keys(value).length === 1) return { state: 'missing' }
  if (value.state === 'confirmed' && hasDigest && Object.keys(value).length === 2 && isWorkspaceProjectSummary(value.project) && value.project.id === operationId) return { state: 'confirmed', project: value.project }
  if (value.state === 'verification-required' && !hasDigest && Object.keys(value).length === 2 && value.operationId === operationId) return { state: 'verification-required', operationId }
  if (value.state === 'deleted' && Object.keys(value).length === 3 && value.operationId === operationId && typeof value.deletedAt === 'string' && value.deletedAt.length <= 64 && Number.isFinite(Date.parse(value.deletedAt))) return { state: 'deleted', operationId, deletedAt: value.deletedAt }
  failed()
}
