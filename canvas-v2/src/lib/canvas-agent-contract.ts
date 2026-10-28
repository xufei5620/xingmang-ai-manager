import { assertRouterStrategyClientVersion } from './router-strategy-contract'
import { parseCanvasAgentMediaModels, assertCanvasAgentProposalMediaModels, canvasAgentMediaModelChoices, parseCanvasAgentRouteDecisions, parseCanvasAgentRoutingSources, type CanvasAgentMediaModels, type CanvasAgentRouteDecision, type CanvasAgentRoutingSource } from './canvas-agent-media-models'
import { parseCanvasAgentMcpCalls, parseCanvasAgentMcpResultSnapshots, parseCanvasAgentMcpToolSnapshots, type CanvasAgentMcpCallProposal } from './canvas-agent-mcp-context'
import type { CanvasMcpToolReference, CanvasMcpToolSnapshot, CanvasMcpResultReference, CanvasMcpResultSnapshot } from './canvas-mcp-contract'
import { parseCanvasAgentSkillSnapshots, type CanvasAgentSkillMethodMap, type CanvasAgentSkillReference, type CanvasAgentSkillSnapshot } from './canvas-agent-skill-contract'
import type { WorkflowEdge, WorkflowNode } from '../model'
import { canvasAgentLocalNodeKinds, parseCanvasAgentNodeSettings, type CanvasAgentNodeSettings } from './canvas-agent-node-settings'
import type { CanvasAgentExecutionMethodMap } from './canvas-agent-execution-contract'
import { parseCanvasAgentApprovalReference, type CanvasAgentApprovalMethodMap, type CanvasAgentApprovalReference, type CanvasAgentApprovalRequest } from './canvas-agent-approval-contract'
import type { CanvasMcpCall } from './canvas-mcp-contract'

export const maximumCanvasAgentPromptCharacters = 8_000
export const maximumCanvasAgentResponseBytes = 4 * 1024 * 1024
export const maximumCanvasAgentImageReferences = 4
export interface CanvasAgentNodeImageReference { nodeId: string; assetId: string }
export interface CanvasAgentLibraryImageReference { source: 'library'; slotId: string; assetId: string }
export type CanvasAgentImageReference = CanvasAgentNodeImageReference | CanvasAgentLibraryImageReference
export function isCanvasAgentLibraryImageReference(reference: CanvasAgentImageReference): reference is CanvasAgentLibraryImageReference { return 'source' in reference && reference.source === 'library' }
export interface CanvasAgentImageBinding { nodeId: string; imageRef: string; assetId: string }
export interface CanvasAgentApplicationValidation {
  turnId: string
  proposalDigest: string
  baseGraphDigest: string
  expectedResultGraphDigest: string
  imageBindingDigest: string
}
export const maximumCanvasAgentSessionReferences = 4
export const maximumCanvasAgentReferenceCharacters = 24_000
export interface CanvasAgentSessionReference { sessionId: string; turnId: string; contentDigest: string }
export interface CanvasAgentSessionReferenceSnapshot extends CanvasAgentSessionReference {
  projectId: string
  sessionTitle: string
  createdAt: string
  prompt: string
  reply: string
  characterCount: number
}
export interface CanvasAgentReferenceTurnSummary extends CanvasAgentSessionReference {
  sessionTitle: string
  archived: boolean
  state: 'ready' | 'applied'
  createdAt: string
  promptPreview: string
  replyPreview: string
  characterCount: number
}
export const canvasAgentNodeKinds = ['prompt', 'text-generate', 'image-generate', 'image-edit', 'video-generate', 'gallery', 'output', ...canvasAgentLocalNodeKinds] as const
export type CanvasAgentNodeKind = typeof canvasAgentNodeKinds[number]
export const maximumCanvasAgentFollowUps = 8
export type CanvasAgentFollowUpMode = 'queue' | 'steer'
export type CanvasAgentFollowUpBlockedReason = 'project-changed' | 'image-unavailable' | 'previous-running' | 'previous-unknown' | 'previous-cancelled' | 'session-archived'
export interface CanvasAgentFollowUpInput { version: 1; mode: CanvasAgentFollowUpMode; targetTurnId: string }
export interface CanvasAgentFollowUp extends CanvasAgentFollowUpInput { sequence: number; blockedReason?: CanvasAgentFollowUpBlockedReason }
export interface CanvasAgentFollowUpPage {
  version: 1
  projectId: string
  sessionId: string
  sessionVersion: number
  activeTurn?: CanvasAgentTurn
  eligibleTurnId?: string
  items: CanvasAgentTurn[]
}
export type CanvasAgentTurnState = 'waiting' | 'queued' | 'running' | 'ready' | 'failed' | 'cancelled' | 'interrupted' | 'applied'
export interface CanvasAgentNodePatch {
  nodeId: string
  title?: string
  data?: { model?: string; group?: string; prompt?: string; size?: string; quality?: string; imageResolution?: '1K' | '2K' | '4K'; seconds?: string; settings?: CanvasAgentNodeSettings }
}
export interface CanvasAgentProposal {
  routeDecisions?: CanvasAgentRouteDecision[]
  id: string
  digest: string
  baseProjectVersion: number
  baseGraphDigest: string
  expectedResultGraphDigest: string
  summary: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  updates: CanvasAgentNodePatch[]
  imageBindings?: CanvasAgentImageBinding[]
}
export interface CanvasAgentSession {
  id: string
  projectId: string
  title: string
  version: number
  createdAt: string
  updatedAt: string
  archivedAt?: string
}
export interface CanvasAgentTurn {
  routerStrategyVersion?: 1
  routingSources?: CanvasAgentRoutingSource[]
  approval?: CanvasAgentApprovalReference
  /** Missing identifies an immutable legacy seven-kind planning snapshot. */
  mediaModels?: CanvasAgentMediaModels
  planningVersion?: 2 | 3
  followUp?: CanvasAgentFollowUp
  supersededBy?: { version: 1; turnId: string }
  id: string
  projectId: string
  sessionId: string
  operationId: string
  sessionVersion: number
  state: CanvasAgentTurnState
  prompt: string
  providerId: string
  model: string
  baseProjectVersion: number
  baseGraphDigest: string
  selectedNodeIds: string[]
  imageReferences?: CanvasAgentImageReference[]
  sessionReferences?: CanvasAgentSessionReferenceSnapshot[]
  sessionContextDigest?: string
  skillReferences?: CanvasAgentSkillSnapshot[]
  skillContextVersion?: 1
  skillContextDigest?: string
  mcpTools?: CanvasMcpToolSnapshot[]
  mcpResults?: CanvasMcpResultSnapshot[]
  mcpContextVersion?: 1
  mcpContextDigest?: string
  mcpCalls?: CanvasAgentMcpCallProposal[]
  createdAt: string
  updatedAt: string
  runId?: string
  reply?: string
  proposal?: CanvasAgentProposal
  error?: string
  cancelRequested: boolean
  mayStillComplete: boolean
  appliedProjectVersion?: number
}
export interface CanvasAgentScope { projectId: string; sessionId: string }
export interface CanvasAgentTurnTarget extends CanvasAgentScope { turnId: string }
export interface CanvasAgentStartTurnInput extends CanvasAgentScope {
  routerStrategyVersion?: 1
  approval?: CanvasAgentApprovalRequest
  mediaModels?: CanvasAgentMediaModels
  followUp?: CanvasAgentFollowUpInput
  operationId: string
  expectedSessionVersion: number
  baseProjectVersion: number
  selectedNodeIds: string[]
  imageReferences?: CanvasAgentImageReference[]
  sessionReferences?: CanvasAgentSessionReference[]
  skillReferences?: CanvasAgentSkillReference[]
  mcpToolReferences?: CanvasMcpToolReference[]
  mcpResultReferences?: CanvasMcpResultReference[]
  prompt: string
  providerId: string
  model: string
}
export interface CanvasAgentMethodMap extends CanvasAgentSkillMethodMap, CanvasAgentExecutionMethodMap, CanvasAgentApprovalMethodMap {
  continueApprovedTurn: { input: CanvasAgentTurnTarget & { grantId: string; operationId: string; baseProjectVersion: number }; result: CanvasAgentTurn }
  executeApprovedMcpCall: { input: CanvasAgentTurnTarget & { grantId: string; proposalId: string }; result: CanvasMcpCall }
  listSessions: { input: { projectId: string; archived?: boolean; offset?: number; limit?: number }; result: { items: CanvasAgentSession[]; total: number; offset: number; limit: number } }
  createSession: { input: { projectId: string; operationId: string; title?: string }; result: CanvasAgentSession }
  readSession: { input: CanvasAgentScope & { offset?: number; limit?: number }; result: { session: CanvasAgentSession; turns: CanvasAgentTurn[]; total: number; offset: number; limit: number } }
  readFollowUps: { input: CanvasAgentScope; result: CanvasAgentFollowUpPage }
  listReferenceTurns: { input: { projectId: string; query?: string; excludeSessionId?: string; offset?: number; limit?: number }; result: { projectId: string; query: string; excludeSessionId?: string; items: CanvasAgentReferenceTurnSummary[]; total: number; offset: number; limit: number } }
  previewSessionReference: { input: CanvasAgentTurnTarget & { contentDigest?: string }; result: CanvasAgentSessionReferenceSnapshot }
  updateSession: { input: CanvasAgentScope & { expectedVersion: number; title?: string; archived?: boolean }; result: CanvasAgentSession }
  startTurn: { input: CanvasAgentStartTurnInput; result: CanvasAgentTurn }
  inspectTurn: { input: CanvasAgentScope & ({ operationId: string; turnId?: never } | { turnId: string; operationId?: never }); result: { state: 'missing' } | { state: 'found'; turn: CanvasAgentTurn } }
  executeTurn: { input: CanvasAgentTurnTarget & { continueQueue?: true }; result: CanvasAgentTurn }
  cancelTurn: { input: CanvasAgentTurnTarget; result: CanvasAgentTurn }
  validateApplication: { input: CanvasAgentTurnTarget & { proposalDigest: string }; result: CanvasAgentApplicationValidation }
  markApplied: { input: CanvasAgentTurnTarget & { proposalDigest: string; afterGraphDigest: string; appliedProjectVersion: number }; result: CanvasAgentTurn }
}
export type CanvasAgentMethod = keyof CanvasAgentMethodMap
export interface CanvasAgentClient {
  active(): boolean
  request<M extends CanvasAgentMethod>(method: M, input: CanvasAgentMethodMap[M]['input'], signal?: AbortSignal): Promise<CanvasAgentMethodMap[M]['result']>
}
export class CanvasAgentError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'CanvasAgentError' }
}
export function canvasAgentRecord(value: unknown, label = 'Agent 请求'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CanvasAgentError(`${label}格式不正确`)
  return value as Record<string, unknown>
}
export function canvasAgentKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new CanvasAgentError('Agent 请求包含不支持的字段')
}
export function canvasAgentText(value: unknown, label: string, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || !empty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new CanvasAgentError(`${label}格式不正确或超过 ${maximum} 字符`)
  return value.trim()
}
export function canvasAgentId(value: unknown, label = '编号'): string {
  const id = canvasAgentText(value, label, 128)
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new CanvasAgentError(`${label}格式不正确`)
  return id
}
export function canvasAgentOperationId(value: unknown): string {
  const id = canvasAgentText(value, '操作编号', 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new CanvasAgentError('操作编号格式不正确')
  return id.toLowerCase()
}
export function canvasAgentVersion(value: unknown, label = '版本'): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) >= Number.MAX_SAFE_INTEGER) throw new CanvasAgentError(`${label}格式不正确`)
  return Number(value)
}
export function canvasAgentDigestValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new CanvasAgentError('Agent 内容摘要格式不正确')
  return value
}

export function parseCanvasAgentFollowUpInput(value: unknown): CanvasAgentFollowUpInput | undefined {
  if (value === undefined) return undefined
  const raw = canvasAgentRecord(value, '跟进方式')
  canvasAgentKeys(raw, ['version', 'mode', 'targetTurnId'])
  if (raw.version !== 1 || raw.mode !== 'queue' && raw.mode !== 'steer') throw new CanvasAgentError('跟进方式版本或模式不受支持，请刷新页面')
  return { version: 1, mode: raw.mode, targetTurnId: canvasAgentId(raw.targetTurnId, '原消息编号') }
}
function parseCanvasAgentFollowUp(value: unknown): CanvasAgentFollowUp {
  const raw = canvasAgentRecord(value, '跟进消息')
  canvasAgentKeys(raw, ['version', 'mode', 'targetTurnId', 'sequence', 'blockedReason'])
  const input = parseCanvasAgentFollowUpInput({ version: raw.version, mode: raw.mode, targetTurnId: raw.targetTurnId })!
  const blocked = ['project-changed', 'image-unavailable', 'previous-running', 'previous-unknown', 'previous-cancelled', 'session-archived'] as const
  if (raw.blockedReason !== undefined && !blocked.includes(raw.blockedReason as typeof blocked[number])) throw new CanvasAgentError('跟进等待原因不受支持', 502)
  return { ...input, sequence: canvasAgentVersion(raw.sequence, '队列序号'), ...(raw.blockedReason !== undefined ? { blockedReason: raw.blockedReason as CanvasAgentFollowUpBlockedReason } : {}) }
}
export function assertCanvasAgentFollowUpClient(version: unknown, required: boolean): void {
  if (version !== undefined && version !== 1 || required && version !== 1) throw new CanvasAgentError('此会话含新版排队或方向调整，请刷新页面后核对原消息', 409)
}

/** Explicit image identities are pinned when selected; node titles or URLs grant no access. */
export function parseCanvasAgentImageReferences(value: unknown, selectedNodeIds: readonly string[]): CanvasAgentImageReference[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maximumCanvasAgentImageReferences) throw new CanvasAgentError('Agent 每次最多引用 4 张图片')
  const references = value.map((entry) => {
    const item = canvasAgentRecord(entry, '图片引用')
    if (typeof item.assetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item.assetId)) throw new CanvasAgentError('图片素材编号不正确')
    if (item.source === 'library') {
      canvasAgentKeys(item, ['source', 'slotId', 'assetId'])
      return { source: 'library' as const, slotId: canvasAgentOperationId(item.slotId), assetId: item.assetId }
    }
    canvasAgentKeys(item, ['nodeId', 'assetId'])
    const nodeId = canvasAgentId(item.nodeId, '图片节点编号')
    if (!selectedNodeIds.includes(nodeId)) throw new CanvasAgentError('图片引用必须属于本次明确选择的上下文节点')
    return { nodeId, assetId: item.assetId }
  })
  if (new Set(references.map((item) => isCanvasAgentLibraryImageReference(item) ? `library:${item.slotId}` : `node:${item.nodeId}`)).size !== references.length) throw new CanvasAgentError('同一节点或素材引用位置不能重复引用图片')
  return references.length ? references : undefined
}

export function parseCanvasAgentImageBindings(value: unknown, nodes: readonly WorkflowNode[]): CanvasAgentImageBinding[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new CanvasAgentError('Agent 图片绑定数量不正确', 502)
  const bindings = value.map((entry) => {
    const raw = canvasAgentRecord(entry, '图片绑定'); canvasAgentKeys(raw, ['nodeId', 'imageRef', 'assetId'])
    const nodeId = canvasAgentId(raw.nodeId)
    if (!nodes.some((node) => node.id === nodeId && node.kind === 'image-input') || typeof raw.imageRef !== 'string' || !/^a[0-3]$/.test(raw.imageRef) || typeof raw.assetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.assetId)) throw new CanvasAgentError('Agent 图片绑定身份不正确', 502)
    return { nodeId, imageRef: raw.imageRef, assetId: raw.assetId }
  })
  if (new Set(bindings.map((binding) => binding.nodeId)).size !== bindings.length) throw new CanvasAgentError('Agent 图片节点不能重复绑定', 502)
  return bindings
}

export function assertCanvasAgentTurnImageBindings(turn: Pick<CanvasAgentTurn, 'planningVersion' | 'imageReferences' | 'proposal'>): void {
  const bindings = turn.proposal?.imageBindings
  if (turn.planningVersion !== 3 && (bindings !== undefined || turn.imageReferences?.some(isCanvasAgentLibraryImageReference))) throw new CanvasAgentError('原规划版本不支持素材库图片绑定', 502)
  for (const binding of bindings ?? []) {
    if (turn.imageReferences?.[Number(binding.imageRef.slice(1))]?.assetId !== binding.assetId) throw new CanvasAgentError('Agent 图片绑定与明确选择的图片不一致', 502)
  }
}

export function parseCanvasAgentSessionReferences(value: unknown): CanvasAgentSessionReference[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maximumCanvasAgentSessionReferences) throw new CanvasAgentError('每次最多引用 4 条已完成的会话消息')
  const references = value.map((entry) => {
    const item = canvasAgentRecord(entry, '会话引用')
    canvasAgentKeys(item, ['sessionId', 'turnId', 'contentDigest'])
    return { sessionId: canvasAgentId(item.sessionId, '来源会话编号'), turnId: canvasAgentId(item.turnId, '来源消息编号'), contentDigest: canvasAgentDigestValue(item.contentDigest) }
  })
  if (new Set(references.map((item) => item.turnId)).size !== references.length) throw new CanvasAgentError('同一条会话消息不能重复引用')
  return references.length ? references : undefined
}

export function parseCanvasAgentSessionReferenceSnapshot(value: unknown): CanvasAgentSessionReferenceSnapshot {
  const item = canvasAgentRecord(value, '会话引用快照')
  canvasAgentKeys(item, ['projectId', 'sessionId', 'turnId', 'contentDigest', 'sessionTitle', 'createdAt', 'prompt', 'reply', 'characterCount'])
  const prompt = canvasAgentText(item.prompt, '引用需求', maximumCanvasAgentReferenceCharacters)
  const reply = canvasAgentText(item.reply, '引用回答', maximumCanvasAgentReferenceCharacters)
  const characterCount = prompt.length + reply.length
  if (item.characterCount !== characterCount) throw new CanvasAgentError('会话引用字数不一致，请重新预览')
  if (characterCount > maximumCanvasAgentReferenceCharacters) throw new CanvasAgentError(`引用需求和回答合计 ${characterCount} 字符，超过 ${maximumCanvasAgentReferenceCharacters} 字符上限；请减少引用`, 413)
  return { projectId: canvasAgentId(item.projectId), sessionId: canvasAgentId(item.sessionId), turnId: canvasAgentId(item.turnId), contentDigest: canvasAgentDigestValue(item.contentDigest), sessionTitle: canvasAgentText(item.sessionTitle, '来源会话名称', 100), createdAt: responseTime(item.createdAt), prompt, reply, characterCount }
}

export function parseCanvasAgentSessionReferenceSnapshots(value: unknown, projectId: string): CanvasAgentSessionReferenceSnapshot[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.length || value.length > maximumCanvasAgentSessionReferences) throw new CanvasAgentError('会话引用快照数量不正确')
  const snapshots = value.map(parseCanvasAgentSessionReferenceSnapshot)
  if (snapshots.some((item) => item.projectId !== projectId) || new Set(snapshots.map((item) => item.turnId)).size !== snapshots.length) throw new CanvasAgentError('会话引用快照归属不一致或重复')
  const count = snapshots.reduce((sum, item) => sum + item.characterCount, 0)
  if (count > maximumCanvasAgentReferenceCharacters) throw new CanvasAgentError(`引用需求和回答合计 ${count} 字符，超过 ${maximumCanvasAgentReferenceCharacters} 字符上限；请减少引用`, 413)
  return snapshots
}

export function responseBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new CanvasAgentError('Agent 回执状态不正确', 502)
  return value
}
export function responseTime(value: unknown): string {
  const text = canvasAgentText(value, '回执时间', 30)
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw new CanvasAgentError('Agent 回执时间不正确', 502)
  return text
}
export function responseInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) throw new CanvasAgentError('Agent 回执计数不正确', 502)
  return Number(value)
}
function responsePatchData(value: unknown): NonNullable<CanvasAgentNodePatch['data']> {
  const data = canvasAgentRecord(value); canvasAgentKeys(data, ['prompt', 'size', 'quality', 'imageResolution', 'seconds', 'settings', 'model', 'group'])
  const result: NonNullable<CanvasAgentNodePatch['data']> = {}
  if (data.model !== undefined) result.model = canvasAgentText(data.model, '媒体模型', 200)
  if (data.group !== undefined) result.group = canvasAgentId(data.group, '媒体模型来源')
  if (data.prompt !== undefined) result.prompt = canvasAgentText(data.prompt, '节点提示词', 8_000, true)
  if (data.size !== undefined) {
    const size = canvasAgentText(data.size, '节点尺寸', 20), parts = /^(\d{1,4})x(\d{1,4})$/.exec(size)
    if (!parts || Number(parts[1]) < 1 || Number(parts[2]) < 1 || Number(parts[1]) > 4096 || Number(parts[2]) > 4096) throw new CanvasAgentError('Agent 回执尺寸无效', 502)
    result.size = size
  }
  if (data.quality !== undefined) { if (!['low', 'medium', 'high', 'standard', 'hd'].includes(String(data.quality))) throw new CanvasAgentError('Agent 画质回执无效', 502); result.quality = String(data.quality) }
  if (data.imageResolution !== undefined) { if (!['1K', '2K', '4K'].includes(String(data.imageResolution))) throw new CanvasAgentError('Agent 分辨率回执无效', 502); result.imageResolution = data.imageResolution as '1K' | '2K' | '4K' }
  if (data.seconds !== undefined) { if (typeof data.seconds !== 'string' || !/^(?:[1-9]|1[0-5])$/.test(data.seconds)) throw new CanvasAgentError('Agent 时长回执无效', 502); result.seconds = data.seconds }
  if (data.settings !== undefined) result.settings = parseCanvasAgentNodeSettings(data.settings)
  return result
}
export function parseCanvasAgentProposal(value: unknown, mediaModels?: CanvasAgentMediaModels): CanvasAgentProposal {
  const raw = canvasAgentRecord(value, '规划提案'); canvasAgentKeys(raw, ['id', 'digest', 'baseProjectVersion', 'baseGraphDigest', 'expectedResultGraphDigest', 'summary', 'nodes', 'edges', 'updates', 'imageBindings', 'routeDecisions'])
  if (!Array.isArray(raw.nodes) || raw.nodes.length > 20 || !Array.isArray(raw.edges) || raw.edges.length > 40 || !Array.isArray(raw.updates) || raw.updates.length > 20 || raw.nodes.length + raw.edges.length + raw.updates.length === 0) throw new CanvasAgentError('Agent 提案数量不正确', 502)
  const id = canvasAgentId(raw.id)
  const nodes: WorkflowNode[] = raw.nodes.map((item, index) => {
    const node = canvasAgentRecord(item); canvasAgentKeys(node, ['id', 'kind', 'definitionVersion', 'position', 'data'])
    if (node.id !== `agent-${id}-n${index}` || !canvasAgentNodeKinds.includes(node.kind as CanvasAgentNodeKind) || node.definitionVersion !== 1) throw new CanvasAgentError('Agent 提案节点身份不正确', 502)
    const position = canvasAgentRecord(node.position); canvasAgentKeys(position, ['x', 'y'])
    if (![position.x, position.y].every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate) && Math.abs(coordinate) <= 1_000_000)) throw new CanvasAgentError('Agent 提案位置无效', 502)
    const data = canvasAgentRecord(node.data); canvasAgentKeys(data, ['prompt', 'model', 'group', 'status', 'settings', 'size', 'quality', 'imageResolution', 'seconds'])
    if (typeof data.model !== 'string' || data.model.length > 200 || data.status !== 'idle') throw new CanvasAgentError('Agent 提案不能预置模型身份或执行状态', 502)
    const settings = canvasAgentRecord(data.settings); canvasAgentKeys(settings, ['title', 'imageTransform', 'imageCollageInputOrder', 'imageCompare', 'imagePanorama', 'timestampSeconds', 'routerStrategy'])
    const { title, ...localSettings } = settings
    const parsedSettings = Object.keys(localSettings).length ? parseCanvasAgentNodeSettings(localSettings, String(node.kind)) : {}
    const { model: ignoredModel, status: ignoredStatus, settings: ignoredSettings, ...parameters } = data
    const patch = responsePatchData(parameters)
    return { id: String(node.id), kind: node.kind as CanvasAgentNodeKind, definitionVersion: 1, position: { x: Number(position.x), y: Number(position.y) }, data: { prompt: '', ...patch, model: data.model, status: 'idle', settings: { ...parsedSettings, title: canvasAgentText(title, '节点标题', 160) } } }
  })
  const edges: WorkflowEdge[] = raw.edges.map((item, index) => {
    const edge = canvasAgentRecord(item); canvasAgentKeys(edge, ['id', 'source', 'sourceHandle', 'target', 'targetHandle'])
    if (edge.id !== `agent-${id}-e${index}`) throw new CanvasAgentError('Agent 提案连线身份不正确', 502)
    return { id: String(edge.id), source: canvasAgentId(edge.source), sourceHandle: canvasAgentText(edge.sourceHandle, '输出端口', 40), target: canvasAgentId(edge.target), targetHandle: canvasAgentText(edge.targetHandle, '输入端口', 40) }
  })
  const updates = raw.updates.map((item) => {
    const patch = canvasAgentRecord(item); canvasAgentKeys(patch, ['nodeId', 'title', 'data'])
    if (patch.title === undefined && patch.data === undefined) throw new CanvasAgentError('Agent 节点更新为空', 502)
    return { nodeId: canvasAgentId(patch.nodeId), ...(patch.title !== undefined ? { title: canvasAgentText(patch.title, '节点标题', 160) } : {}), ...(patch.data !== undefined ? { data: responsePatchData(patch.data) } : {}) }
  })
  if (new Set(updates.map((item) => item.nodeId)).size !== updates.length) throw new CanvasAgentError('Agent 节点更新重复', 502)
  const imageBindings = parseCanvasAgentImageBindings(raw.imageBindings, nodes)
  const routeDecisions = parseCanvasAgentRouteDecisions(raw.routeDecisions)
  const result: CanvasAgentProposal = { id, digest: canvasAgentDigestValue(raw.digest), baseProjectVersion: canvasAgentVersion(raw.baseProjectVersion), baseGraphDigest: canvasAgentDigestValue(raw.baseGraphDigest), expectedResultGraphDigest: canvasAgentDigestValue(raw.expectedResultGraphDigest), summary: canvasAgentText(raw.summary, '提案摘要', 2_000), nodes, edges, updates, ...(imageBindings ? { imageBindings } : {}), ...(routeDecisions ? { routeDecisions } : {}) }
  assertCanvasAgentProposalMediaModels(result, mediaModels)
  return result
}
export function parseCanvasAgentSession(value: unknown): CanvasAgentSession {
  const raw = canvasAgentRecord(value, 'Agent 会话'); canvasAgentKeys(raw, ['id', 'projectId', 'title', 'version', 'createdAt', 'updatedAt', 'archivedAt'])
  return { id: canvasAgentId(raw.id), projectId: canvasAgentId(raw.projectId), title: canvasAgentText(raw.title, '会话名称', 100), version: canvasAgentVersion(raw.version), createdAt: responseTime(raw.createdAt), updatedAt: responseTime(raw.updatedAt), ...(raw.archivedAt !== undefined ? { archivedAt: responseTime(raw.archivedAt) } : {}) }
}
export function parseCanvasAgentTurn(value: unknown): CanvasAgentTurn {
  const raw = canvasAgentRecord(value, 'Agent 消息'); canvasAgentKeys(raw, ['routerStrategyVersion', 'approval', 'id', 'projectId', 'sessionId', 'operationId', 'sessionVersion', 'mediaModels', 'routingSources', 'planningVersion', 'skillReferences', 'skillContextVersion', 'skillContextDigest', 'mcpTools', 'mcpResults', 'mcpContextVersion', 'mcpContextDigest', 'mcpCalls', 'state', 'prompt', 'providerId', 'model', 'baseProjectVersion', 'baseGraphDigest', 'selectedNodeIds', 'imageReferences', 'sessionReferences', 'sessionContextDigest', 'createdAt', 'updatedAt', 'runId', 'reply', 'proposal', 'error', 'cancelRequested', 'mayStillComplete', 'appliedProjectVersion', 'followUp', 'supersededBy'])
  if (!['waiting', 'queued', 'running', 'ready', 'failed', 'cancelled', 'interrupted', 'applied'].includes(String(raw.state)) || !Array.isArray(raw.selectedNodeIds) || raw.selectedNodeIds.length > 40) throw new CanvasAgentError('Agent 消息状态不正确', 502)
  const turn: CanvasAgentTurn = { id: canvasAgentId(raw.id), projectId: canvasAgentId(raw.projectId), sessionId: canvasAgentId(raw.sessionId), operationId: canvasAgentOperationId(raw.operationId), sessionVersion: canvasAgentVersion(raw.sessionVersion), state: raw.state as CanvasAgentTurnState, prompt: canvasAgentText(raw.prompt, '需求', maximumCanvasAgentPromptCharacters), providerId: canvasAgentId(raw.providerId), model: canvasAgentText(raw.model, '模型', 200), baseProjectVersion: canvasAgentVersion(raw.baseProjectVersion), baseGraphDigest: canvasAgentDigestValue(raw.baseGraphDigest), selectedNodeIds: raw.selectedNodeIds.map((id) => canvasAgentId(id)), createdAt: responseTime(raw.createdAt), updatedAt: responseTime(raw.updatedAt), cancelRequested: responseBoolean(raw.cancelRequested), mayStillComplete: responseBoolean(raw.mayStillComplete),
    ...(raw.runId !== undefined ? { runId: canvasAgentId(raw.runId) } : {}), ...(raw.reply !== undefined ? { reply: canvasAgentText(raw.reply, '答复', 16_000) } : {}), ...(raw.error !== undefined ? { error: canvasAgentText(raw.error, '错误说明', 2_000) } : {}), ...(raw.proposal !== undefined ? { proposal: parseCanvasAgentProposal(raw.proposal, parseCanvasAgentMediaModels(raw.mediaModels)) } : {}), ...(raw.appliedProjectVersion !== undefined ? { appliedProjectVersion: canvasAgentVersion(raw.appliedProjectVersion) } : {}) }
  if (Object.hasOwn(raw, 'routerStrategyVersion')) { try { assertRouterStrategyClientVersion(raw.routerStrategyVersion, true) } catch { throw new CanvasAgentError('原消息路由策略版本不受支持', 502) }; turn.routerStrategyVersion = 1 }
  if (Object.hasOwn(raw, 'mediaModels')) turn.mediaModels = parseCanvasAgentMediaModels(raw.mediaModels)
  if (Object.hasOwn(raw, 'routingSources')) turn.routingSources = parseCanvasAgentRoutingSources(raw.routingSources)
  const routingProviderIds = [...new Set(canvasAgentMediaModelChoices(turn.mediaModels).map((choice) => choice.providerId))]
  if (turn.mediaModels?.version === 3 ? !turn.routingSources || routingProviderIds.length !== turn.routingSources.length || routingProviderIds.some((providerId) => !turn.routingSources!.some((source) => source.providerId === providerId)) : turn.routingSources !== undefined) throw new CanvasAgentError('原消息内容模型来源快照不完整或版本不一致', 502)
  if (Object.hasOwn(raw, 'approval')) turn.approval = parseCanvasAgentApprovalReference(raw.approval)
  if (turn.approval && (turn.approval.version === 2) !== (turn.mediaModels?.version === 3)) throw new CanvasAgentError('原消息授权与内容模型协议版本不一致', 502)
  if (turn.proposal) assertCanvasAgentProposalMediaModels(turn.proposal, turn.mediaModels)
  if (raw.planningVersion !== undefined) {
    if (raw.planningVersion !== 2 && raw.planningVersion !== 3) throw new CanvasAgentError('Agent 规划版本不受支持', 502)
    turn.planningVersion = raw.planningVersion
  }
  if (raw.followUp !== undefined) turn.followUp = parseCanvasAgentFollowUp(raw.followUp)
  if (raw.supersededBy !== undefined) {
    const superseded = canvasAgentRecord(raw.supersededBy, '方向调整回执'); canvasAgentKeys(superseded, ['version', 'turnId'])
    if (superseded.version !== 1) throw new CanvasAgentError('方向调整回执版本不受支持', 502)
    turn.supersededBy = { version: 1, turnId: canvasAgentId(superseded.turnId) }
    if (turn.supersededBy.turnId === turn.id || !turn.cancelRequested || turn.state !== 'cancelled') throw new CanvasAgentError('方向调整回执与原任务不一致', 502)
  }
  if (turn.state === 'waiting' && (!turn.followUp || turn.runId || turn.cancelRequested) || turn.followUp?.targetTurnId === turn.id || turn.followUp && turn.followUp.sequence !== turn.sessionVersion || turn.followUp?.blockedReason && turn.state !== 'waiting') throw new CanvasAgentError('跟进消息状态不一致', 502)
  const imageReferences = parseCanvasAgentImageReferences(raw.imageReferences, turn.selectedNodeIds)
  if (imageReferences) turn.imageReferences = imageReferences
  const sessionReferences = parseCanvasAgentSessionReferenceSnapshots(raw.sessionReferences, turn.projectId)
  if (sessionReferences) {
    if (sessionReferences.some((item) => item.sessionId === turn.sessionId || item.turnId === turn.id)) throw new CanvasAgentError('会话引用不能递归或指向当前会话', 502)
    turn.sessionReferences = sessionReferences
    turn.sessionContextDigest = canvasAgentDigestValue(raw.sessionContextDigest)
  } else if (raw.sessionContextDigest !== undefined) throw new CanvasAgentError('会话引用快照缺失，请核对原规划', 502)
  const skills = parseCanvasAgentSkillSnapshots(raw.skillReferences)
  if (skills) {
    if (raw.skillContextVersion !== 1) throw new CanvasAgentError('Skill 上下文版本不受支持', 502)
    turn.skillReferences = skills; turn.skillContextVersion = 1; turn.skillContextDigest = canvasAgentDigestValue(raw.skillContextDigest)
  } else if (raw.skillContextVersion !== undefined || raw.skillContextDigest !== undefined) throw new CanvasAgentError('Skill 引用快照缺失', 502)
  const mcpTools = parseCanvasAgentMcpToolSnapshots(raw.mcpTools), mcpResults = parseCanvasAgentMcpResultSnapshots(raw.mcpResults)
  if (mcpTools || mcpResults) {
    if (raw.mcpContextVersion !== 1) throw new CanvasAgentError('MCP 上下文版本不受支持', 502)
    if (mcpTools) turn.mcpTools = mcpTools
    if (mcpResults) turn.mcpResults = mcpResults
    turn.mcpContextVersion = 1; turn.mcpContextDigest = canvasAgentDigestValue(raw.mcpContextDigest)
  } else if (raw.mcpContextVersion !== undefined || raw.mcpContextDigest !== undefined) throw new CanvasAgentError('MCP 冻结上下文缺失', 502)
  const mcpCalls = parseCanvasAgentMcpCalls(raw.mcpCalls, mcpTools, turn.id)
  if (mcpCalls) {
    if (!['ready', 'applied'].includes(turn.state) && !turn.supersededBy) throw new CanvasAgentError('未完成消息不能含工具提议', 502)
    turn.mcpCalls = mcpCalls
  }
  if (new Set(turn.selectedNodeIds).size !== turn.selectedNodeIds.length || turn.proposal && (turn.proposal.id !== turn.id || turn.proposal.baseGraphDigest !== turn.baseGraphDigest || turn.proposal.baseProjectVersion !== turn.baseProjectVersion) || turn.state === 'applied' && (!turn.proposal || !turn.appliedProjectVersion) || ['ready', 'applied'].includes(turn.state) && !turn.reply) throw new CanvasAgentError('Agent 消息与提案回执不一致', 502)
  if (turn.proposal) {
    if (canvasAgentProposalHasRouterStrategy(turn.proposal) && turn.routerStrategyVersion !== 1) throw new CanvasAgentError('原消息没有新版路由策略声明，不能升级旧提案', 502)
    if (turn.planningVersion === undefined && (turn.proposal.nodes.some((node) => !canvasAgentNodeKinds.slice(0, 7).some((kind) => kind === node.kind) || Object.keys(node.data.settings ?? {}).some((key) => key !== 'title')) || turn.proposal.updates.some((patch) => patch.data?.settings !== undefined))) throw new CanvasAgentError('原规划版本不支持高级节点提案', 502)
    const allowed = new Set([...turn.selectedNodeIds, ...turn.proposal.nodes.map((node) => node.id)])
    if (turn.proposal.updates.some((patch) => !turn.selectedNodeIds.includes(patch.nodeId)) || turn.proposal.edges.some((edge) => !allowed.has(edge.source) || !allowed.has(edge.target))) throw new CanvasAgentError('Agent 提案超出了已选择的节点范围', 502)
  }
  assertCanvasAgentTurnImageBindings(turn)
  return turn
}
export function compareCanvasAgentFollowUps(left: CanvasAgentFollowUp, right: CanvasAgentFollowUp): number {
  return left.mode === right.mode ? left.mode === 'steer' ? right.sequence - left.sequence : left.sequence - right.sequence : left.mode === 'steer' ? -1 : 1
}
export function parseCanvasAgentFollowUpPage(value: unknown): CanvasAgentFollowUpPage {
  const raw = canvasAgentRecord(value, '待处理消息')
  canvasAgentKeys(raw, ['version', 'projectId', 'sessionId', 'sessionVersion', 'activeTurn', 'eligibleTurnId', 'items'])
  if (raw.version !== 1 || !Array.isArray(raw.items) || raw.items.length > maximumCanvasAgentFollowUps) throw new CanvasAgentError('待处理消息回执不完整', 502)
  const projectId = canvasAgentId(raw.projectId), sessionId = canvasAgentId(raw.sessionId), items = raw.items.map(parseCanvasAgentTurn)
  const activeTurn = raw.activeTurn === undefined ? undefined : parseCanvasAgentTurn(raw.activeTurn)
  const eligibleTurnId = raw.eligibleTurnId === undefined ? undefined : canvasAgentId(raw.eligibleTurnId)
  if (items.some((turn) => turn.projectId !== projectId || turn.sessionId !== sessionId || turn.state !== 'waiting' || !turn.followUp) || new Set(items.map((turn) => turn.id)).size !== items.length || new Set(items.map((turn) => turn.followUp!.sequence)).size !== items.length || items.some((turn, index) => index > 0 && compareCanvasAgentFollowUps(items[index - 1].followUp!, turn.followUp!) >= 0) || activeTurn && (items.some((turn) => turn.id === activeTurn.id) || activeTurn.projectId !== projectId || activeTurn.sessionId !== sessionId || !['queued', 'running'].includes(activeTurn.state) || activeTurn.cancelRequested) || eligibleTurnId && (activeTurn || items[0]?.id !== eligibleTurnId || items[0]?.followUp?.blockedReason) || Boolean(eligibleTurnId) !== Boolean(items[0] && !items[0].followUp?.blockedReason && !activeTurn) || [...items, ...(activeTurn ? [activeTurn] : [])].some((turn) => turn.sessionVersion > Number(raw.sessionVersion))) throw new CanvasAgentError('待处理消息顺序或归属不一致', 502)
  return { version: 1, projectId, sessionId, sessionVersion: canvasAgentVersion(raw.sessionVersion), ...(activeTurn ? { activeTurn } : {}), ...(eligibleTurnId ? { eligibleTurnId } : {}), items }
}

export function canvasAgentProposalHasRouterStrategy(proposal: CanvasAgentProposal): boolean {
  return proposal.nodes.some((node) => Object.hasOwn(node.data.settings ?? {}, 'routerStrategy')) || proposal.updates.some((patch) => Object.hasOwn(patch.data?.settings ?? {}, 'routerStrategy'))
}
