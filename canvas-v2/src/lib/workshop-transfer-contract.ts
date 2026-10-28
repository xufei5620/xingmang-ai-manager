import { parseCommunityWorkshopSnapshot, type CommunityWorkshopKind, type CommunityWorkshopOwned, type CommunityWorkshopSnapshot } from './community-workshop-contract'

export interface WorkshopTransferSource { kind: CommunityWorkshopKind; id: string; expectedVersion: number }
export interface WorkshopTransferOrigin { source: 'file' | 'share'; onlyUse: boolean; authorName?: string }
export interface WorkshopItemPermissions { canEdit: boolean; canShare: boolean; canExport: boolean; canPublish: boolean }
export interface WorkshopTransferMetadata { transferOrigin?: WorkshopTransferOrigin; permissions?: WorkshopItemPermissions; origin?: unknown }
export interface WorkshopImportPreview { snapshot: CommunityWorkshopSnapshot; previewDigest: string }
export interface WorkshopExportPreview extends WorkshopImportPreview { source: WorkshopTransferSource; filename: string; content: string }
export interface WorkshopShareInput { source: WorkshopTransferSource; authorName: string; onlyUse: boolean; limitAcquisitions: number | null }
export interface WorkshopSharePreview extends WorkshopImportPreview, WorkshopShareInput { transferOrigin?: WorkshopTransferOrigin }
export interface WorkshopShareSummary {
  id: string; name: string; kind: CommunityWorkshopKind; authorName: string; onlyUse: boolean; limitAcquisitions: number | null; acquisitionCount: number; version: number; createdAt: string; revokedAt?: string; state: 'active' | 'full' | 'revoked'; transferOrigin?: WorkshopTransferOrigin
}
export interface WorkshopShareManaged extends WorkshopShareSummary { token: string }
export interface WorkshopSharePage { items: WorkshopShareManaged[]; total: number; offset: number; limit: number }
export interface WorkshopShareDetail extends WorkshopShareSummary { snapshot?: CommunityWorkshopSnapshot; isOwner: boolean; owned?: CommunityWorkshopOwned }
export interface WorkshopTransferReceipt { action: 'import' | 'share' | 'revoke' | 'acquire'; operationId: string; shareId?: string; share?: WorkshopShareManaged; owned?: CommunityWorkshopOwned }
export type WorkshopTransferOperation = { state: 'missing' } | { state: 'completed'; receipt: WorkshopTransferReceipt }
export interface WorkshopTransferOperationIdentity { operationId: string; requestDigest: string }
export type WorkshopTransferInspection = WorkshopTransferOperationIdentity & ({ state: 'missing' } | { state: 'completed'; receipt: WorkshopTransferReceipt })
export interface WorkshopTransferMethodMap {
  previewWorkshopExport: { input: WorkshopTransferSource; result: WorkshopExportPreview }
  previewWorkshopImport: { input: { content: string }; result: WorkshopImportPreview }
  importWorkshopFile: { input: { operationId: string; content: string; previewDigest: string; confirmImport: true }; result: WorkshopTransferReceipt }
  previewWorkshopShare: { input: WorkshopShareInput; result: WorkshopSharePreview }
  createWorkshopShare: { input: WorkshopShareInput & { operationId: string; previewDigest: string; confirmShare: true }; result: WorkshopTransferReceipt }
  listWorkshopShares: { input: { offset?: number; limit?: number; source?: WorkshopTransferSource }; result: WorkshopSharePage }
  readWorkshopShare: { input: { token: string }; result: WorkshopShareDetail }
  acquireWorkshopShare: { input: { operationId: string; token: string; expectedVersion: number }; result: WorkshopTransferReceipt }
  revokeWorkshopShare: { input: { operationId: string; id: string; expectedVersion: number }; result: WorkshopTransferReceipt }
  inspectWorkshopTransferOperation: { input: string; result: WorkshopTransferOperation }
  inspectWorkshopTransferOperationIdentity: { input: WorkshopTransferOperationIdentity; result: WorkshopTransferInspection }
}
export type WorkshopTransferMethod = keyof WorkshopTransferMethodMap
export const maximumWorkshopTransferResponseBytes = 17 * 1024 * 1024
export const maximumWorkshopShareAcquisitions = 10_000
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工坊传输回执不完整，请重新核对'); return value as Record<string, unknown> }
function text(value: unknown, maximum: number, empty = false): string { if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (!empty && !value.trim())) throw new Error('工坊传输内容格式不正确'); return value }
function uuid(value: unknown): string { const result = text(value, 36); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw new Error('工坊传输编号不正确'); return result }
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error('工坊传输数量或版本不正确'); return Number(value) }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('工坊传输权限不正确'); return value }
function kind(value: unknown): CommunityWorkshopKind { if (value !== 'prompt' && value !== 'node' && value !== 'group') throw new Error('工坊传输类型不正确'); return value }
export function parseWorkshopTransferOrigin(value: unknown): WorkshopTransferOrigin { const v = record(value); if (v.source !== 'file' && v.source !== 'share') throw new Error('工坊来源不正确'); return { source: v.source, onlyUse: boolean(v.onlyUse), ...(v.authorName === undefined ? {} : { authorName: text(v.authorName, 80) }) } }
export function parseWorkshopItemPermissions(value: unknown): WorkshopItemPermissions { const v = record(value); return { canEdit: boolean(v.canEdit), canShare: boolean(v.canShare), canExport: boolean(v.canExport), canPublish: boolean(v.canPublish) } }
export function workshopItemPermissions(item: WorkshopTransferMetadata): WorkshopItemPermissions {
  if (item.permissions) return parseWorkshopItemPermissions(item.permissions)
  const onlyUse = item.transferOrigin?.onlyUse === true
  return { canEdit: !onlyUse, canShare: !onlyUse && !item.origin, canExport: !onlyUse && !item.origin, canPublish: !onlyUse && !item.origin && !item.transferOrigin }
}
export function workshopOriginLabel(item: WorkshopTransferMetadata): string { return item.transferOrigin?.source === 'file' ? '文件导入 · 来源未验证' : item.transferOrigin?.source === 'share' ? `分享获取${item.transferOrigin.onlyUse ? ' · 仅使用' : ''}` : item.origin ? '社区获取' : '个人创建' }
export function parseWorkshopTransferSource(value: unknown): WorkshopTransferSource { const v = record(value); return { kind: kind(v.kind), id: uuid(v.id), expectedVersion: integer(v.expectedVersion, 1) } }
function digest(value: unknown): string { const result = text(value, 64); if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('工坊预览摘要不正确'); return result }
export function parseWorkshopImportPreview(value: unknown): WorkshopImportPreview { const v = record(value); return { snapshot: parseCommunityWorkshopSnapshot(v.snapshot), previewDigest: digest(v.previewDigest) } }
export function parseWorkshopExportPreview(value: unknown): WorkshopExportPreview { const v = record(value); const filename = text(v.filename, 200); if (/[\\/\x00-\x1f]/.test(filename) || !filename.endsWith('.workshop.json')) throw new Error('工坊文件名不正确'); const content = text(v.content, 16 * 1024 * 1024); if (new TextEncoder().encode(content).length > 16 * 1024 * 1024) throw new Error('工坊文件超过 16 MiB'); return { ...parseWorkshopImportPreview(v), source: parseWorkshopTransferSource(v.source), filename, content } }
export function parseWorkshopShareInput(value: unknown): WorkshopShareInput { const v = record(value); const authorName = text(v.authorName, 80).trim(); if (/[\x00-\x1f\x7f]/.test(authorName)) throw new Error('分享署名不能包含控制字符'); return { source: parseWorkshopTransferSource(v.source), authorName, onlyUse: boolean(v.onlyUse), limitAcquisitions: v.limitAcquisitions === null ? null : integer(v.limitAcquisitions, 1, maximumWorkshopShareAcquisitions) } }
export function parseWorkshopSharePreview(value: unknown): WorkshopSharePreview { const v = record(value); return { ...parseWorkshopImportPreview(v), ...parseWorkshopShareInput(v), ...(v.transferOrigin === undefined ? {} : { transferOrigin: parseWorkshopTransferOrigin(v.transferOrigin) }) } }
export function parseWorkshopShareToken(value: unknown): string { const result = text(value, 43); if (!/^[A-Za-z0-9_-]{43}$/.test(result)) throw new Error('分享链接不正确'); return result }
function owned(value: unknown): CommunityWorkshopOwned { const v = record(value); if (!['active', 'trash', 'missing'].includes(String(v.state))) throw new Error('获取条目状态不正确'); return { id: uuid(v.id), kind: kind(v.kind), state: v.state as CommunityWorkshopOwned['state'] } }
export function parseWorkshopShareSummary(value: unknown): WorkshopShareSummary {
  const v = record(value), createdAt = text(v.createdAt, 40)
  if (!Number.isFinite(Date.parse(createdAt)) || !['active', 'full', 'revoked'].includes(String(v.state))) throw new Error('分享状态不正确')
  return { id: uuid(v.id), name: text(v.name, 160), kind: kind(v.kind), authorName: text(v.authorName, 80), onlyUse: boolean(v.onlyUse), limitAcquisitions: v.limitAcquisitions === null ? null : integer(v.limitAcquisitions, 1, maximumWorkshopShareAcquisitions), acquisitionCount: integer(v.acquisitionCount, 0), version: integer(v.version, 1), createdAt, state: v.state as WorkshopShareSummary['state'], ...(v.revokedAt === undefined ? {} : { revokedAt: text(v.revokedAt, 40) }), ...(v.transferOrigin === undefined ? {} : { transferOrigin: parseWorkshopTransferOrigin(v.transferOrigin) }) }
}
export function parseWorkshopShareManaged(value: unknown): WorkshopShareManaged { const v = record(value); return { ...parseWorkshopShareSummary(v), token: parseWorkshopShareToken(v.token) } }
export function parseWorkshopShareDetail(value: unknown): WorkshopShareDetail { const v = record(value); const result = { ...parseWorkshopShareSummary(v), isOwner: boolean(v.isOwner), ...(v.owned === undefined ? {} : { owned: owned(v.owned) }), ...(v.snapshot === undefined ? {} : { snapshot: parseCommunityWorkshopSnapshot(v.snapshot) }) }; if (result.state !== 'revoked' && !result.snapshot) throw new Error('分享配置不完整'); if (result.owned && result.owned.kind !== result.kind) throw new Error('获取条目类型与分享不一致'); if (result.snapshot && result.snapshot.kind !== result.kind) throw new Error('分享配置类型不一致'); return result }
export function parseWorkshopSharePage(value: unknown): WorkshopSharePage { const v = record(value); if (!Array.isArray(v.items) || v.items.length > 100) throw new Error('分享列表不完整'); const items = v.items.map(parseWorkshopShareManaged); if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('分享列表有重复条目'); const total = integer(v.total, 0), offset = integer(v.offset, 0), limit = integer(v.limit, 1, 100); if (items.length > limit || (items.length > 0 && offset + items.length > total) || (offset < total && items.length !== Math.min(limit, total - offset)) || (offset >= total && items.length !== 0)) throw new Error('分享分页回执不完整'); return { items, total, offset, limit } }
export function parseWorkshopTransferReceipt(value: unknown): WorkshopTransferReceipt { const v = record(value); if (!['import', 'share', 'revoke', 'acquire'].includes(String(v.action))) throw new Error('工坊传输操作不正确'); const result = { action: v.action as WorkshopTransferReceipt['action'], operationId: uuid(v.operationId), ...(v.shareId === undefined ? {} : { shareId: uuid(v.shareId) }), ...(v.share === undefined ? {} : { share: parseWorkshopShareManaged(v.share) }), ...(v.owned === undefined ? {} : { owned: owned(v.owned) }) }; if ((result.action === 'import' || result.action === 'acquire') && !result.owned || result.action !== 'import' && !result.shareId || result.action === 'share' && (!result.share || result.share.id !== result.shareId)) throw new Error('工坊传输回执无法对应原操作'); return result }
export function parseWorkshopTransferOperation(value: unknown): WorkshopTransferOperation { const v = record(value); if (v.state === 'missing') return { state: 'missing' }; if (v.state === 'completed') return { state: 'completed', receipt: parseWorkshopTransferReceipt(v.receipt) }; throw new Error('工坊传输核对状态不正确') }
export function parseWorkshopTransferOperationIdentity(value: unknown): WorkshopTransferOperationIdentity {
  const v = record(value)
  if (Object.keys(v).some((key) => key !== 'operationId' && key !== 'requestDigest')) throw new Error('原工坊传输操作身份不完整')
  return { operationId: uuid(v.operationId).toLowerCase(), requestDigest: digest(v.requestDigest) }
}
export function parseWorkshopTransferInspection(value: unknown): WorkshopTransferInspection {
  const v = record(value), identity = parseWorkshopTransferOperationIdentity({ operationId: v.operationId, requestDigest: v.requestDigest })
  if (Object.keys(v).some((key) => !['state', 'operationId', 'requestDigest', 'receipt'].includes(key))) throw new Error('工坊传输核对回执不完整')
  if (v.state === 'missing' && v.receipt === undefined) return { ...identity, state: 'missing' }
  if (v.state !== 'completed') throw new Error('工坊传输核对状态不正确')
  const receipt = parseWorkshopTransferReceipt(v.receipt)
  if (receipt.operationId !== identity.operationId) throw new Error('工坊传输核对回执与原操作编号不一致')
  return { ...identity, state: 'completed', receipt }
}
/** These byte layouts are shared with already persisted transfer operations. */
export async function workshopTransferRequestDigest(action: WorkshopTransferReceipt['action'], value: unknown): Promise<string> {
  const v = record(value)
  uuid(v.operationId)
  let request: unknown
  if (action === 'share') {
    if (v.confirmShare !== true) throw new Error('请先确认分享预览')
    request = { action, ...parseWorkshopShareInput(v), previewDigest: digest(v.previewDigest) }
  } else if (action === 'revoke') request = { action, id: uuid(v.id).toLowerCase(), expectedVersion: integer(v.expectedVersion, 1, Number.MAX_SAFE_INTEGER - 1) }
  else if (action === 'acquire') request = { action, token: parseWorkshopShareToken(v.token), expectedVersion: integer(v.expectedVersion, 1, Number.MAX_SAFE_INTEGER - 1) }
  else if (action === 'import') request = { action, previewDigest: digest(v.previewDigest) }
  else throw new Error('工坊传输操作不受支持')
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(request))))].map((part) => part.toString(16).padStart(2, '0')).join('')
}
export function parseWorkshopTransferResponse<M extends WorkshopTransferMethod>(method: M, value: unknown): WorkshopTransferMethodMap[M]['result'] {
  const parsers = { previewWorkshopExport: parseWorkshopExportPreview, previewWorkshopImport: parseWorkshopImportPreview, importWorkshopFile: parseWorkshopTransferReceipt, previewWorkshopShare: parseWorkshopSharePreview, createWorkshopShare: parseWorkshopTransferReceipt, listWorkshopShares: parseWorkshopSharePage, readWorkshopShare: parseWorkshopShareDetail, acquireWorkshopShare: parseWorkshopTransferReceipt, revokeWorkshopShare: parseWorkshopTransferReceipt, inspectWorkshopTransferOperation: parseWorkshopTransferOperation, inspectWorkshopTransferOperationIdentity: parseWorkshopTransferInspection }
  return parsers[method](value) as WorkshopTransferMethodMap[M]['result']
}
