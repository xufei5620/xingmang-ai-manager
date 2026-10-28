import { parseWorkshopSourcePolicy, sanitizeWorkshopWorkflowForPolicy } from './workshop-source-policy'
import type { WorkflowFile } from '../model'
import type { CanvasWorkshopKind, WorkshopSourcePolicy } from './workshop-contract'
import { maximumWorkshopBytes, WorkshopError } from './workshop-sanitizer'

export interface WorkshopContentUpdateInput {
  operationId: string
  id: string
  kind: CanvasWorkshopKind
  expectedVersion: number
  workflow: WorkflowFile
  compareBindingsVersion?: 1
  sourcePolicy?: WorkshopSourcePolicy
}

export interface WorkshopContentOperationIdentity {
  operationId: string
  id: string
  kind: CanvasWorkshopKind
  expectedVersion: number
  requestDigest: string
  contentDigest: string
}

export interface WorkshopContentUpdateReceipt extends WorkshopContentOperationIdentity {
  committedVersion: number
  committedAt: string
}

export interface WorkshopContentCancellation extends WorkshopContentOperationIdentity { cancelledAt: string }

export type WorkshopContentOperation = { state: 'missing' } | { state: 'completed'; receipt: WorkshopContentUpdateReceipt } | { state: 'cancelled'; cancellation: WorkshopContentCancellation }

export interface WorkshopContentReceiptExpectation {
  operationId: string
  id: string
  kind?: CanvasWorkshopKind
  expectedVersion: number
  contentDigest: string
  requestDigest?: string
}

export type WorkshopContentErrorCode = 'WORKSHOP_CONTENT_CONFLICT' | 'WORKSHOP_CONTENT_OPERATION_REUSED' | 'WORKSHOP_CONTENT_CANCELLED' | 'WORKSHOP_CONTENT_UNCONFIRMED' | 'WORKSHOP_CONTENT_CLIENT_STALE'
export class WorkshopContentError extends WorkshopError {
  constructor(message: string, status: number, public readonly code: WorkshopContentErrorCode) { super(message, status) }
}

export const maximumWorkshopContentResponseBytes = 16 * 1024

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkshopError('工坊配置更新格式不正确')
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new WorkshopError('工坊配置更新含不支持的字段')
}

export function parseWorkshopContentOperationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new WorkshopError('工坊操作编号不正确')
  return value.toLowerCase()
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > Number.MAX_SAFE_INTEGER - 1) throw new WorkshopError('请读取工坊条目的最新版本后再更新', 409)
  return Number(value)
}

function stableJson(value: unknown, ancestors = new Set<object>(), depth = 0): string {
  if (depth > 64) throw new WorkshopError('节点配置嵌套过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new WorkshopError('节点配置必须是有限的 JSON 数据')
  ancestors.add(value)
  let result: string
  if (Array.isArray(value)) result = `[${value.map((entry) => stableJson(entry, ancestors, depth + 1)).join(',')}]`
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new WorkshopError('节点配置必须是普通 JSON 数据')
    const input = value as Record<string, unknown>
    result = `{${Object.keys(input).filter((key) => input[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(input[key], ancestors, depth + 1)}`).join(',')}}`
  }
  ancestors.delete(value)
  return result
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (entry) => entry.toString(16).padStart(2, '0')).join('')
}

/** Validate the graph without rewriting the frozen request's identity. The
 * target's kind and title are resolved separately by the owner-scoped service. */
export function parseWorkshopContentUpdateInput(value: unknown): WorkshopContentUpdateInput {
  const input = record(value)
  keys(input, ['operationId', 'id', 'kind', 'expectedVersion', 'workflow', 'compareBindingsVersion', 'sourcePolicy'])
  const operationId = parseWorkshopContentOperationId(input.operationId), id = parseWorkshopContentOperationId(input.id), expectedVersion = version(input.expectedVersion)
  if (input.kind !== 'node' && input.kind !== 'group') throw new WorkshopError('请选择同类型的工坊节点配置或编组模板')
  if (input.compareBindingsVersion !== undefined && input.compareBindingsVersion !== 1) throw new WorkshopError('请刷新页面后重新捕获工坊配置', 409)
  const sourcePolicy = parseWorkshopSourcePolicy(input.sourcePolicy)
  const raw = stableJson(input.workflow)
  if (new TextEncoder().encode(raw).byteLength > maximumWorkshopBytes) throw new WorkshopError('节点配置超过 512 KB，请缩小选区后保存', 413)
  const workflow: unknown = JSON.parse(raw)
  try { sanitizeWorkshopWorkflowForPolicy(workflow, input.kind, '工坊配置', sourcePolicy) }
  catch (error) { if (error instanceof WorkshopError) throw error; throw new WorkshopError(error instanceof Error ? error.message : '工坊配置格式不正确') }
  return { operationId, id, kind: input.kind, expectedVersion, workflow: workflow as WorkflowFile, ...(input.compareBindingsVersion === 1 ? { compareBindingsVersion: 1 } : {}), ...(sourcePolicy === 'owner-private' ? { sourcePolicy } : {}) }
}

/** Metadata titles are not graph content. A later rename must not invalidate a
 * historical receipt or change the digest a client prepared before sending. */
export async function workshopContentDigest(workflow: unknown, kind: CanvasWorkshopKind = 'group', sourcePolicy: WorkshopSourcePolicy = 'portable'): Promise<string> {
  const policy = parseWorkshopSourcePolicy(sourcePolicy), content = sanitizeWorkshopWorkflowForPolicy(workflow, kind, '工坊配置', policy)
  return digest(policy === 'owner-private' ? { sourcePolicy: policy, workflow: content } : content)
}

export async function workshopContentRequestDigest(value: unknown): Promise<string> {
  return digest({ action: 'updateWorkshopItemContent', ...parseWorkshopContentUpdateInput(value) })
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new WorkshopError('工坊配置回执摘要不正确')
  return value
}

function identity(input: Record<string, unknown>): WorkshopContentOperationIdentity {
  if (input.kind !== 'node' && input.kind !== 'group') throw new WorkshopError('工坊配置回执类型不正确')
  return { operationId: parseWorkshopContentOperationId(input.operationId), id: parseWorkshopContentOperationId(input.id), kind: input.kind, expectedVersion: version(input.expectedVersion), requestDigest: hash(input.requestDigest), contentDigest: hash(input.contentDigest) }
}

export function parseWorkshopContentOperationIdentity(value: unknown): WorkshopContentOperationIdentity {
  const input = record(value)
  keys(input, ['operationId', 'id', 'kind', 'expectedVersion', 'requestDigest', 'contentDigest'])
  return identity(input)
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new WorkshopError('工坊配置操作时间不正确')
  return value
}

export function parseWorkshopContentUpdateReceipt(value: unknown): WorkshopContentUpdateReceipt {
  const input = record(value)
  keys(input, ['operationId', 'id', 'kind', 'expectedVersion', 'committedVersion', 'requestDigest', 'contentDigest', 'committedAt'])
  const parsed = identity(input)
  if (input.committedVersion !== parsed.expectedVersion + 1) throw new WorkshopError('工坊配置提交版本无法对应原操作')
  return { ...parsed, committedVersion: parsed.expectedVersion + 1, committedAt: timestamp(input.committedAt) }
}

export function parseWorkshopContentCancellation(value: unknown): WorkshopContentCancellation {
  const input = record(value)
  keys(input, ['operationId', 'id', 'kind', 'expectedVersion', 'requestDigest', 'contentDigest', 'cancelledAt'])
  return { ...identity(input), cancelledAt: timestamp(input.cancelledAt) }
}

export function parseWorkshopContentOperation(value: unknown): WorkshopContentOperation {
  const input = record(value)
  if (input.state === 'missing') { keys(input, ['state']); return { state: 'missing' } }
  if (input.state === 'completed') { keys(input, ['state', 'receipt']); return { state: 'completed', receipt: parseWorkshopContentUpdateReceipt(input.receipt) } }
  if (input.state === 'cancelled') { keys(input, ['state', 'cancellation']); return { state: 'cancelled', cancellation: parseWorkshopContentCancellation(input.cancellation) } }
  throw new WorkshopError('工坊配置核对状态不正确')
}

export function assertWorkshopContentReceipt(value: unknown, expected: WorkshopContentReceiptExpectation): WorkshopContentUpdateReceipt {
  const receipt = parseWorkshopContentUpdateReceipt(value)
  if (receipt.operationId !== expected.operationId || receipt.id !== expected.id || receipt.expectedVersion !== expected.expectedVersion || expected.kind !== undefined && receipt.kind !== expected.kind || receipt.contentDigest !== expected.contentDigest || expected.requestDigest !== undefined && receipt.requestDigest !== expected.requestDigest) throw new WorkshopError('工坊配置回执与本次操作不一致，请保留原操作并重新核对', 503)
  return receipt
}

export function assertWorkshopContentCancellation(value: unknown, expected: WorkshopContentOperationIdentity): WorkshopContentCancellation {
  const cancellation = parseWorkshopContentCancellation(value)
  assertWorkshopContentIdentity(cancellation, expected)
  return cancellation
}

export function assertWorkshopContentIdentity(value: unknown, expected: WorkshopContentOperationIdentity): WorkshopContentOperationIdentity {
  const actual = identity(record(value))
  if (actual.operationId !== expected.operationId || actual.id !== expected.id || actual.kind !== expected.kind || actual.expectedVersion !== expected.expectedVersion || actual.contentDigest !== expected.contentDigest || actual.requestDigest !== expected.requestDigest) throw new WorkshopError('工坊配置操作身份与原操作不一致，请保留原操作并重新核对', 503)
  return actual
}
