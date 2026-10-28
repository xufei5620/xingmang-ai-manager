import { graphHasNodeMediaSource } from './node-model-source-contract'
import { parseWorkflowFile, type NodeKind, type WorkflowFile } from '../model'
import { workshopText } from './workshop-sanitizer'
import { parseCommunityExampleGallery, parseCommunityExampleSelection, type CommunityExampleGallery, type CommunityExampleSelection } from './community-example-contract'

export type CommunityWorkshopKind = 'prompt' | 'node' | 'group'
export interface CommunityWorkshopOrigin { source: 'community'; publicationId: string; publicationVersion: 1; authorName: string }
export interface CommunityWorkshopOwned { kind: CommunityWorkshopKind; id: string; state: 'active' | 'trash' | 'missing' }
export interface CommunityWorkshopSnapshot {
  kind: CommunityWorkshopKind
  name: string
  description: string
  category: string
  tags: string[]
  nodeCount: number
  edgeCount: number
  nodeKinds: NodeKind[]
  workflow?: WorkflowFile
  prompt?: string
  promptGroup?: string
  exampleGallery?: CommunityExampleGallery
}
export interface CommunityWorkshopSummary extends Omit<CommunityWorkshopSnapshot, 'workflow' | 'prompt' | 'promptGroup'> {
  id: string
  source: 'community'
  authorName: string
  version: number
  state: 'published' | 'withdrawn'
  createdAt: string
  withdrawnAt?: string
  acquisitionCount: number
  owned?: CommunityWorkshopOwned
  /** Only returned to the author; never expose another account's private IDs. */
  sourceItem?: { kind: CommunityWorkshopKind; id: string; version: number }
}
export interface CommunityWorkshopDetail extends CommunityWorkshopSummary { workflow?: WorkflowFile; prompt?: string; promptGroup?: string }
export interface CommunityWorkshopQuery { view?: 'community' | 'published' | 'acquired'; kind?: 'all' | CommunityWorkshopKind; q?: string; category?: string; offset?: number; limit?: number }
export interface CommunityWorkshopPage { items: CommunityWorkshopSummary[]; total: number; offset: number; limit: number }
export interface CommunityPublicationSource { sourceKind: CommunityWorkshopKind; sourceId: string; expectedSourceVersion: number; authorName: string; exampleSelection?: CommunityExampleSelection }
export interface CommunityPublicationPreview extends CommunityPublicationSource { previewDigest: string; snapshot: CommunityWorkshopSnapshot }
export interface CommunityPublicationInput extends CommunityPublicationSource { operationId: string; previewDigest: string; confirmPublic: true }
export interface CommunityWorkshopMutationInput { operationId: string; id: string; expectedVersion: number }
export interface CommunityWorkshopReceipt { action: 'publish' | 'withdraw' | 'acquire'; operationId: string; publicationId: string; publicationVersion: number; owned?: CommunityWorkshopOwned }
export type CommunityWorkshopOperation = { state: 'missing' } | { state: 'completed'; receipt: CommunityWorkshopReceipt }
export interface CommunityWorkshopOperationIdentity { operationId: string; requestDigest: string }
export type CommunityWorkshopInspection = CommunityWorkshopOperationIdentity & ({ state: 'missing' } | { state: 'completed'; receipt: CommunityWorkshopReceipt })
export const maximumCommunityResponseBytes = 2 * 1024 * 1024

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('社区工坊资料格式不完整，请重新读取。'); return value as Record<string, unknown> }
function text(value: unknown, maximum: number, empty = false): string { if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (!empty && !value.trim())) throw new Error('社区工坊资料格式不完整，请重新读取。'); return value }
function count(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error('社区工坊计数或版本不完整，请重新读取。'); return Number(value) }
function id(value: unknown): string { const result = text(value, 36); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw new Error('社区工坊编号不完整，请重新读取。'); return result }
function kind(value: unknown): CommunityWorkshopKind { if (value !== 'prompt' && value !== 'node' && value !== 'group') throw new Error('社区工坊类型不完整，请重新读取。'); return value }
function date(value: unknown): string { const result = text(value, 40); if (!Number.isFinite(Date.parse(result))) throw new Error('社区工坊时间不完整，请重新读取。'); return result }
function strings(value: unknown, limit: number, length: number): string[] { if (!Array.isArray(value) || value.length > limit) throw new Error('社区工坊列表字段不完整，请重新读取。'); return value.map((entry) => text(entry, length)) }
export function parseCommunityWorkshopOrigin(value: unknown): CommunityWorkshopOrigin { const v = object(value); if (v.source !== 'community' || v.publicationVersion !== 1) throw new Error('社区来源信息不完整。'); return { source: 'community', publicationId: id(v.publicationId), publicationVersion: 1, authorName: text(v.authorName, 80) } }
function owned(value: unknown): CommunityWorkshopOwned { const v = object(value); if (v.state !== 'active' && v.state !== 'trash' && v.state !== 'missing') throw new Error('已获取副本状态无法确认，请重新读取。'); return { id: id(v.id), kind: kind(v.kind), state: v.state } }
function metadata(value: unknown): Omit<CommunityWorkshopSnapshot, 'workflow' | 'prompt' | 'promptGroup'> { const v = object(value); return { kind: kind(v.kind), name: text(v.name, 160), description: text(v.description, 4000, true), category: text(v.category, 64), tags: strings(v.tags, 20, 40), nodeCount: count(v.nodeCount, 0, 200), edgeCount: count(v.edgeCount, 0, 800), nodeKinds: strings(v.nodeKinds, 200, 64) as NodeKind[], ...(v.exampleGallery === undefined ? {} : { exampleGallery: parseCommunityExampleGallery(v.exampleGallery) }) } }
export function parseCommunityWorkshopSnapshot(value: unknown): CommunityWorkshopSnapshot {
  const v = object(value), meta = metadata(v)
  if (meta.kind === 'prompt') { if (meta.nodeCount || meta.edgeCount || meta.nodeKinds.length || v.workflow !== undefined) throw new Error('提示词快照格式不正确。'); return { ...meta, prompt: text(v.prompt, 24_000), promptGroup: text(v.promptGroup ?? '', 64, true) } }
  if (graphHasNodeMediaSource(v.workflow)) throw new Error('公开节点快照不能包含本人固定模型来源，请从个人原档重新生成无来源副本。')
  const workflow = parseWorkflowFile(JSON.stringify(v.workflow))
  if (!workflow || workflow.nodes.length !== meta.nodeCount || workflow.edges.length !== meta.edgeCount || !meta.nodeCount || (meta.kind === 'node' && meta.nodeCount !== 1) || v.prompt !== undefined) throw new Error('节点快照无法完整读取。')
  return { ...meta, workflow }
}
export function parseCommunityWorkshopSummary(value: unknown): CommunityWorkshopSummary {
  const v = object(value)
  if (v.source !== 'community' || (v.state !== 'published' && v.state !== 'withdrawn')) throw new Error('社区发布状态无法确认。')
  const result: CommunityWorkshopSummary = { ...metadata(v), id: id(v.id), source: 'community', authorName: text(v.authorName, 80), version: count(v.version, 1), state: v.state, createdAt: date(v.createdAt), acquisitionCount: count(v.acquisitionCount) }
  if (v.withdrawnAt !== undefined) result.withdrawnAt = date(v.withdrawnAt)
  if (v.owned !== undefined) { result.owned = owned(v.owned); if (result.owned.kind !== result.kind) throw new Error('已获取副本类型不一致。') }
  if (v.sourceItem !== undefined) { const source = object(v.sourceItem); result.sourceItem = { kind: kind(source.kind), id: id(source.id), version: count(source.version, 1) }; if (result.sourceItem.kind !== result.kind) throw new Error('发布源类型不一致。') }
  return result
}
export function parseCommunityWorkshopDetail(value: unknown): CommunityWorkshopDetail { return { ...parseCommunityWorkshopSummary(value), ...parseCommunityWorkshopSnapshot(value) } }
export function parseCommunityWorkshopPage(value: unknown): CommunityWorkshopPage {
  const v = object(value)
  if (!Array.isArray(v.items) || v.items.length > 100) throw new Error('社区工坊列表无法完整读取。')
  const result = { items: v.items.map(parseCommunityWorkshopSummary), total: count(v.total), offset: count(v.offset, 0, 2_147_483_647), limit: count(v.limit, 1, 100) }
  if (result.items.length > result.limit || result.items.length > Math.max(0, result.total - result.offset) || new Set(result.items.map((item) => item.id)).size !== result.items.length) throw new Error('社区工坊分页回执不完整。')
  return result
}
export function parseCommunityPublicationPreview(value: unknown): CommunityPublicationPreview { const v = object(value), previewDigest = text(v.previewDigest, 64); if (!/^[a-f0-9]{64}$/.test(previewDigest)) throw new Error('发布预览摘要无法确认。'); const snapshot = parseCommunityWorkshopSnapshot(v.snapshot), sourceKind = kind(v.sourceKind), exampleSelection = v.exampleSelection === undefined ? undefined : parseCommunityExampleSelection(v.exampleSelection); if (sourceKind !== snapshot.kind) throw new Error('发布预览类型不一致。'); if (Boolean(exampleSelection) !== Boolean(snapshot.exampleGallery) || exampleSelection && (exampleSelection.items.length !== snapshot.exampleGallery!.items.length || exampleSelection.items.some((item, index) => item.alt !== snapshot.exampleGallery!.items[index].alt))) throw new Error('样图预览与选择不一致，请重新核对。'); return { sourceKind, sourceId: id(v.sourceId), expectedSourceVersion: count(v.expectedSourceVersion, 1), authorName: text(v.authorName, 80), ...(exampleSelection ? { exampleSelection } : {}), previewDigest, snapshot } }
export function parseCommunityWorkshopReceipt(value: unknown): CommunityWorkshopReceipt { const v = object(value); if (v.action !== 'publish' && v.action !== 'withdraw' && v.action !== 'acquire') throw new Error('社区工坊操作回执不完整。'); const result: CommunityWorkshopReceipt = { action: v.action, operationId: id(v.operationId), publicationId: id(v.publicationId), publicationVersion: count(v.publicationVersion, 1) }; if (v.owned !== undefined) result.owned = owned(v.owned); if ((v.action === 'acquire') !== Boolean(result.owned)) throw new Error('社区工坊获取回执不完整。'); return result }
export function parseCommunityWorkshopOperation(value: unknown): CommunityWorkshopOperation { const v = object(value); if (v.state === 'missing') return { state: 'missing' }; if (v.state !== 'completed') throw new Error('社区工坊操作结果无法确认。'); return { state: 'completed', receipt: parseCommunityWorkshopReceipt(v.receipt) } }

export function parseCommunityWorkshopOperationIdentity(value: unknown): CommunityWorkshopOperationIdentity {
  const v = object(value)
  if (Object.keys(v).some((key) => key !== 'operationId' && key !== 'requestDigest') || typeof v.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.requestDigest)) throw new Error('原社区工坊操作身份不完整，请保留记录并重新核对。')
  return { operationId: id(v.operationId).toLowerCase(), requestDigest: v.requestDigest }
}
export function parseCommunityWorkshopInspection(value: unknown): CommunityWorkshopInspection {
  const v = object(value), identity = parseCommunityWorkshopOperationIdentity({ operationId: v.operationId, requestDigest: v.requestDigest })
  if (Object.keys(v).some((key) => !['state', 'operationId', 'requestDigest', 'receipt'].includes(key))) throw new Error('社区工坊核对回执不完整。')
  if (v.state === 'missing' && v.receipt === undefined) return { ...identity, state: 'missing' }
  if (v.state !== 'completed') throw new Error('社区工坊操作结果无法确认。')
  const receipt = parseCommunityWorkshopReceipt(v.receipt)
  if (receipt.operationId !== identity.operationId) throw new Error('社区工坊核对回执与原操作编号不一致。')
  return { ...identity, state: 'completed', receipt }
}
/** Preserve the deployed digest layout, including the legacy mutation ID field. */
export async function communityWorkshopRequestDigest(action: CommunityWorkshopReceipt['action'], value: unknown): Promise<string> {
  const v = object(value)
  let request: unknown
  if (action === 'publish') {
    const authorName = workshopText(v.authorName, '公开作者名', 80)
    if (/[\r\n\t]/.test(authorName) || v.confirmPublic !== true || typeof v.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.previewDigest)) throw new Error('请先核对完整发布预览，并明确确认公开内容')
    id(v.operationId)
    request = { action, sourceKind: kind(v.sourceKind), sourceId: id(v.sourceId).toLowerCase(), expectedSourceVersion: count(v.expectedSourceVersion, 1, Number.MAX_SAFE_INTEGER - 1), authorName, ...(v.exampleSelection === undefined ? {} : { exampleSelection: parseCommunityExampleSelection(v.exampleSelection) }), previewDigest: v.previewDigest }
  } else if (action === 'withdraw' || action === 'acquire') {
    request = { action, operationId: id(v.operationId).toLowerCase(), id: id(v.id).toLowerCase(), expectedVersion: count(v.expectedVersion, 1, Number.MAX_SAFE_INTEGER - 1) }
  } else throw new Error('社区工坊操作不受支持')
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(request))))].map((part) => part.toString(16).padStart(2, '0')).join('')
}
