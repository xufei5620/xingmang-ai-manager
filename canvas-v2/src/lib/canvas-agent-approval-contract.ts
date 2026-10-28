import { CanvasAgentError, canvasAgentDigestValue, canvasAgentId, canvasAgentKeys, canvasAgentNodeKinds, canvasAgentOperationId, canvasAgentRecord, canvasAgentVersion, type CanvasAgentTurnTarget } from './canvas-agent-contract'

export type CanvasAgentApprovalMode = 'manual' | 'auto' | 'full'
export type CanvasAgentApprovalVersion = 1 | 2
export interface CanvasAgentApprovalLimits {
  applications: number
  localSteps: number
  planningRequests: number
  textCandidates: number
  imageCandidates: number
  videoCandidates: number
  mcpCalls: number
  totalSteps: number
}
export interface CanvasAgentApprovalRequest { version: CanvasAgentApprovalVersion; mode: 'auto' | 'full'; expiresInMinutes: number; limits: CanvasAgentApprovalLimits; allowedNodeKinds: string[] }
export interface CanvasAgentApprovalReference { version: CanvasAgentApprovalVersion; grantId: string; rootTurnId: string }
export type CanvasAgentApprovalBinding = CanvasAgentApprovalReference
export type CanvasAgentApprovalStepKind = 'apply' | 'local' | 'planning' | 'text' | 'image' | 'video' | 'mcp'
export type CanvasAgentApprovalStepState = 'reserved' | 'dispatching' | 'succeeded' | 'failed' | 'unknown'
export interface CanvasAgentApprovalStep {
  version: 1; id: string; grantId: string; turnId: string; operationId: string; kind: CanvasAgentApprovalStepKind; inputDigest: string; units: number
  state: CanvasAgentApprovalStepState; createdAt: string; updatedAt: string
}
export interface CanvasAgentApprovalGrant {
  version: CanvasAgentApprovalVersion; id: string; projectId: string; sessionId: string; rootTurnId: string; mode: 'auto' | 'full'
  state: 'active' | 'paused' | 'revoked' | 'expired' | 'completed'; revision: number
  limits: CanvasAgentApprovalLimits; used: CanvasAgentApprovalLimits; allowedNodeKinds: string[]; selectedNodeIds: string[]
  createdAt: string; updatedAt: string; expiresAt: string; steps: CanvasAgentApprovalStep[]
}
export interface CanvasAgentApprovalStepTarget extends CanvasAgentTurnTarget { grantId: string; stepId: string }
export interface CanvasAgentApprovalPrepareInput extends CanvasAgentTurnTarget { grantId: string; operationId: string; kind: 'apply' | 'local'; inputDigest: string; nodeIds?: string[] }
export interface CanvasAgentApprovalControlInput extends CanvasAgentTurnTarget { grantId: string; expectedRevision: number; action: 'pause' | 'resume' | 'revoke' | 'complete' }
export interface CanvasAgentApprovalCompleteInput extends CanvasAgentApprovalStepTarget { state: 'succeeded' | 'failed' | 'unknown' }
export interface CanvasAgentApprovalMethodMap {
  readApproval: { input: CanvasAgentTurnTarget; result: CanvasAgentApprovalGrant }
  controlApproval: { input: CanvasAgentApprovalControlInput; result: CanvasAgentApprovalGrant }
  prepareApprovalStep: { input: CanvasAgentApprovalPrepareInput; result: { step: CanvasAgentApprovalStep; created: boolean } }
  authorizeApprovalStep: { input: CanvasAgentApprovalStepTarget; result: { step: CanvasAgentApprovalStep; authorized: boolean } }
  completeApprovalStep: { input: CanvasAgentApprovalCompleteInput; result: CanvasAgentApprovalStep }
}
export type CanvasAgentApprovalMethod = keyof CanvasAgentApprovalMethodMap
export const canvasAgentApprovalMethods: readonly CanvasAgentApprovalMethod[] = ['readApproval', 'controlApproval', 'prepareApprovalStep', 'authorizeApprovalStep', 'completeApprovalStep']
export function isCanvasAgentApprovalMethod(value: string): value is CanvasAgentApprovalMethod { return canvasAgentApprovalMethods.includes(value as CanvasAgentApprovalMethod) }
export function assertCanvasAgentApprovalClient(version: unknown, required = false, semanticVersion: CanvasAgentApprovalVersion = 1): void {
  if (semanticVersion !== 1 && semanticVersion !== 2 || version !== undefined && version !== 1 && version !== 2 || required && version !== 1 && version !== 2 || semanticVersion === 2 && version !== 2) throw new CanvasAgentError('此消息含新版自动执行授权，请刷新页面后核对原消息', 409)
}
export async function canvasAgentApprovedContinuationOperationId(turnId: string, grantId: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ kind: 'agent-approved-continuation-v1', turnId: canvasAgentId(turnId), grantId: canvasAgentId(grantId) }))
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}
export async function canvasAgentApprovedExecutionOperationId(turnId: string, grantId: string, proposalDigest: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ kind: 'agent-approved-execution-v1', turnId: canvasAgentId(turnId), grantId: canvasAgentId(grantId), proposalDigest: canvasAgentDigestValue(proposalDigest) }))
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}
function integer(value: unknown, maximum: number, minimum = 0): number { if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new CanvasAgentError('自动执行预算超出支持范围'); return Number(value) }
function time(value: unknown): string { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new CanvasAgentError('自动执行时间格式不正确', 502); return value }
export function parseCanvasAgentApprovalLimits(value: unknown, usage = false): CanvasAgentApprovalLimits {
  const raw = canvasAgentRecord(value, '自动执行预算'); canvasAgentKeys(raw, ['applications', 'localSteps', 'planningRequests', 'textCandidates', 'imageCandidates', 'videoCandidates', 'mcpCalls', 'totalSteps'])
  return { applications: integer(raw.applications, 8, usage ? 0 : 1), localSteps: integer(raw.localSteps, 100), planningRequests: integer(raw.planningRequests, 8, usage ? 0 : 1), textCandidates: integer(raw.textCandidates, 16), imageCandidates: integer(raw.imageCandidates, 16), videoCandidates: integer(raw.videoCandidates, 8), mcpCalls: integer(raw.mcpCalls, 4), totalSteps: integer(raw.totalSteps, 160, usage ? 0 : 1) }
}
export function parseCanvasAgentApprovalRequest(value: unknown): CanvasAgentApprovalRequest | undefined {
  if (value === undefined) return undefined
  const raw = canvasAgentRecord(value, '本条消息授权'); canvasAgentKeys(raw, ['version', 'mode', 'expiresInMinutes', 'limits', 'allowedNodeKinds'])
  if (raw.version !== 1 && raw.version !== 2 || raw.mode !== 'auto' && raw.mode !== 'full') throw new CanvasAgentError('本条消息授权版本或模式不受支持，请刷新页面', 409)
  if (!Array.isArray(raw.allowedNodeKinds) || raw.allowedNodeKinds.length > canvasAgentNodeKinds.length || raw.allowedNodeKinds.some((kind) => !canvasAgentNodeKinds.some((allowed) => allowed === kind)) || new Set(raw.allowedNodeKinds).size !== raw.allowedNodeKinds.length) throw new CanvasAgentError('允许的节点种类不正确')
  const limits = parseCanvasAgentApprovalLimits(raw.limits)
  if (limits.applications > limits.planningRequests) throw new CanvasAgentError('应用次数不能超过规划请求预算')
  return { version: raw.version, mode: raw.mode, expiresInMinutes: integer(raw.expiresInMinutes, 60, 1), limits, allowedNodeKinds: [...raw.allowedNodeKinds] as string[] }
}
export function parseCanvasAgentApprovalReference(value: unknown): CanvasAgentApprovalReference | undefined {
  if (value === undefined) return undefined
  const raw = canvasAgentRecord(value, '原消息授权关联'); canvasAgentKeys(raw, ['version', 'grantId', 'rootTurnId'])
  if (raw.version !== 1 && raw.version !== 2) throw new CanvasAgentError('原消息授权关联版本不受支持，请刷新后核对原任务', 409)
  return { version: raw.version, grantId: canvasAgentId(raw.grantId), rootTurnId: canvasAgentId(raw.rootTurnId) }
}
export function parseCanvasAgentApprovalTarget(value: unknown): CanvasAgentTurnTarget {
  const raw = canvasAgentRecord(value)
  return { projectId: canvasAgentId(raw.projectId), sessionId: canvasAgentId(raw.sessionId), turnId: canvasAgentId(raw.turnId) }
}
export function parseCanvasAgentApprovalStep(value: unknown): CanvasAgentApprovalStep {
  const raw = canvasAgentRecord(value, '自动执行步骤'); canvasAgentKeys(raw, ['version', 'id', 'grantId', 'turnId', 'operationId', 'kind', 'inputDigest', 'units', 'state', 'createdAt', 'updatedAt'])
  if (raw.version !== 1 || !['apply', 'local', 'planning', 'text', 'image', 'video', 'mcp'].includes(String(raw.kind)) || !['reserved', 'dispatching', 'succeeded', 'failed', 'unknown'].includes(String(raw.state))) throw new CanvasAgentError('自动执行步骤版本或状态不受支持', 502)
  return { version: 1, id: canvasAgentId(raw.id), grantId: canvasAgentId(raw.grantId), turnId: canvasAgentId(raw.turnId), operationId: canvasAgentOperationId(raw.operationId), kind: raw.kind as CanvasAgentApprovalStepKind, inputDigest: canvasAgentDigestValue(raw.inputDigest), units: integer(raw.units, 100, 1), state: raw.state as CanvasAgentApprovalStepState, createdAt: time(raw.createdAt), updatedAt: time(raw.updatedAt) }
}
export function parseCanvasAgentApprovalGrant(value: unknown): CanvasAgentApprovalGrant {
  const raw = canvasAgentRecord(value, '原消息授权'); canvasAgentKeys(raw, ['version', 'id', 'projectId', 'sessionId', 'rootTurnId', 'mode', 'state', 'revision', 'limits', 'used', 'allowedNodeKinds', 'selectedNodeIds', 'createdAt', 'updatedAt', 'expiresAt', 'steps'])
  if (raw.version !== 1 && raw.version !== 2 || raw.mode !== 'auto' && raw.mode !== 'full' || !['active', 'paused', 'revoked', 'expired', 'completed'].includes(String(raw.state)) || !Array.isArray(raw.steps) || raw.steps.length > 160 || !Array.isArray(raw.selectedNodeIds) || raw.selectedNodeIds.length > 40) throw new CanvasAgentError('原消息授权回执版本或范围不受支持', 502)
  const request = parseCanvasAgentApprovalRequest({ version: raw.version, mode: raw.mode, expiresInMinutes: 1, limits: raw.limits, allowedNodeKinds: raw.allowedNodeKinds })!
  const steps = raw.steps.map(parseCanvasAgentApprovalStep), id = canvasAgentId(raw.id), selectedNodeIds = raw.selectedNodeIds.map((node) => canvasAgentId(node))
  if (new Set(steps.map((step) => step.id)).size !== steps.length || steps.some((step) => step.grantId !== id) || new Set(selectedNodeIds).size !== selectedNodeIds.length) throw new CanvasAgentError('原消息授权回执关联不一致', 502)
  const used = parseCanvasAgentApprovalLimits(raw.used, true)
  if ((Object.keys(used) as (keyof CanvasAgentApprovalLimits)[]).some((key) => used[key] > request.limits[key])) throw new CanvasAgentError('自动执行预算回执不一致', 502)
  return { version: raw.version, id, projectId: canvasAgentId(raw.projectId), sessionId: canvasAgentId(raw.sessionId), rootTurnId: canvasAgentId(raw.rootTurnId), mode: raw.mode, state: raw.state as CanvasAgentApprovalGrant['state'], revision: canvasAgentVersion(raw.revision), limits: request.limits, used, allowedNodeKinds: request.allowedNodeKinds, selectedNodeIds, createdAt: time(raw.createdAt), updatedAt: time(raw.updatedAt), expiresAt: time(raw.expiresAt), steps }
}
export function parseCanvasAgentApprovalResponse(method: CanvasAgentApprovalMethod, value: unknown): CanvasAgentApprovalMethodMap[CanvasAgentApprovalMethod]['result'] {
  if (method === 'readApproval' || method === 'controlApproval') return parseCanvasAgentApprovalGrant(value)
  if (method === 'completeApprovalStep') return parseCanvasAgentApprovalStep(value)
  const raw = canvasAgentRecord(value); const field = method === 'prepareApprovalStep' ? 'created' : 'authorized'; canvasAgentKeys(raw, ['step', field])
  if (typeof raw[field] !== 'boolean') throw new CanvasAgentError('自动执行步骤回执不正确', 502)
  const step = parseCanvasAgentApprovalStep(raw.step)
  return field === 'created' ? { step, created: raw[field] as boolean } : { step, authorized: raw[field] as boolean }
}
