import { parseCanvasAgentApprovalRequest } from '../lib/canvas-agent-approval-contract'
import { parseCanvasAgentMediaModels, type CanvasAgentMediaModels } from '../lib/canvas-agent-media-models'
import type { CanvasMcpToolReference, CanvasMcpResultReference } from '../lib/canvas-mcp-contract'
import { parseAgentDraftMcpTools, parseAgentDraftMcpResults } from './canvas-agent-mcp-context'
import type { CanvasAgentImageReference, CanvasAgentSession, CanvasAgentSessionReference, CanvasAgentStartTurnInput, CanvasAgentTurn, CanvasAgentTurnTarget } from '../lib/canvas-agent-contract'
import { maximumCanvasAgentPromptCharacters } from '../lib/canvas-agent-contract'
import { parseAgentDraftImages } from './canvas-agent-context'
import { parseAgentDraftSessionReferences } from './canvas-agent-session-context'
import type { CanvasAgentSkillReference } from '../lib/canvas-agent-skill-contract'
import { parseAgentDraftSkills } from './canvas-agent-skill-context'

export interface CanvasAgentPanelScope {
  /** Changes whenever the account, project, or project lifetime changes. */
  key: string
  ownerId: string
  projectId: string
  active(): boolean
}
export interface CanvasAgentContextNode { id: string; title: string; kind: string; imageAssetId?: string; imageUnavailableReason?: string }
export interface CanvasAgentContextRequest { id: number; scopeKey: string; nodeIds: string[]; imageReferences: CanvasAgentImageReference[] }
export type CanvasAgentPendingAction = { kind: 'start'; input: CanvasAgentStartTurnInput; draftRevision?: number }
  | { kind: 'execute' | 'cancel'; input: CanvasAgentTurnTarget }
export interface CanvasAgentDraft {
  mediaModels?: CanvasAgentMediaModels
  mediaModelError?: string
  pendingMediaModelError?: string
  text: string
  selectedNodeIds: string[]
  imageReferences?: CanvasAgentImageReference[]
  imageReferenceError?: string
  pendingImageError?: string
  sessionReferences?: CanvasAgentSessionReference[]
  sessionReferenceError?: string
  pendingReferenceError?: string
  skillReferences?: CanvasAgentSkillReference[]
  skillReferenceError?: string
  pendingSkillError?: string
  mcpToolReferences?: CanvasMcpToolReference[]
  mcpResultReferences?: CanvasMcpResultReference[]
  mcpReferenceError?: string
  pendingMcpError?: string
  model: string
  providerId?: string
  pending?: CanvasAgentPendingAction
  revision?: number
  pendingFollowUpError?: string
  pendingApprovalError?: string
  pendingRouterStrategyError?: string
}
export interface CanvasAgentProjectMemory {
  selectedSessionId?: string
  width?: number
  pendingCreate?: { operationId: string; title: string }
}
export interface CanvasAgentDraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const identifier = /^[A-Za-z0-9_-]{1,128}$/
const operation = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function storageOrNull(storage?: CanvasAgentDraftStorage): CanvasAgentDraftStorage | null {
  if (storage) return storage
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}
function storageKey(scope: Pick<CanvasAgentPanelScope, 'ownerId' | 'projectId'>, sessionId?: string, version = 1): string {
  return `xingmang.canvas.agent.v${version}.${encodeURIComponent(scope.ownerId)}.${encodeURIComponent(scope.projectId)}.${sessionId ? encodeURIComponent(sessionId) : 'project'}`
}
function mediaPoolDraftMarker(raw: string | null | undefined): boolean {
  if (!raw || raw.length > 128 * 1024) return false
  try { const value: unknown = JSON.parse(raw); return record(value) && typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version >= 8 } catch { return false }
}
function approvalDraftMarker(raw: string | null | undefined): boolean {
  if (!raw || raw.length > 128 * 1024) return false
  try { const value: unknown = JSON.parse(raw); return record(value) && typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version >= 9 } catch { return false }
}
function contentModelDraftMarker(raw: string | null | undefined): boolean {
  if (!raw || raw.length > 128 * 1024) return false
  try { const value: unknown = JSON.parse(raw); return record(value) && typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version >= 10 } catch { return false }
}
function routerStrategyDraftMarker(raw: string | null | undefined): boolean {
  if (!raw || raw.length > 128 * 1024) return false
  try { const value: unknown = JSON.parse(raw); return record(value) && typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version >= 11 } catch { return false }
}
function parsePending(value: unknown, projectId: string, sessionId: string): CanvasAgentPendingAction | undefined {
  if (!record(value) || !record(value.input) || value.input.projectId !== projectId || value.input.sessionId !== sessionId) return
  const input = value.input
  if (Object.hasOwn(input, 'routerStrategyVersion') && input.routerStrategyVersion !== 1) return
  if (value.kind === 'execute' || value.kind === 'cancel') {
    if (typeof input.turnId === 'string' && identifier.test(input.turnId)) return { kind: value.kind, input: { projectId, sessionId, turnId: input.turnId } }
    return
  }
  if (value.kind !== 'start' || typeof input.operationId !== 'string' || !operation.test(input.operationId)
    || !Number.isSafeInteger(input.expectedSessionVersion) || Number(input.expectedSessionVersion) < 1
    || !Number.isSafeInteger(input.baseProjectVersion) || Number(input.baseProjectVersion) < 1
    || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > maximumCanvasAgentPromptCharacters
    || typeof input.providerId !== 'string' || input.providerId.length > 128 || !input.providerId
    || typeof input.model !== 'string' || input.model.length > 200 || !input.model
    || !Array.isArray(input.selectedNodeIds) || input.selectedNodeIds.length > 40 || input.selectedNodeIds.some((id) => typeof id !== 'string' || !identifier.test(id))) return
  const selectedNodeIds = [...new Set(input.selectedNodeIds as string[])]
  let imageReferences: CanvasAgentImageReference[]
  try { imageReferences = parseAgentDraftImages(input.imageReferences, selectedNodeIds) } catch { return }
  let sessionReferences: CanvasAgentSessionReference[]
  try { sessionReferences = parseAgentDraftSessionReferences(input.sessionReferences) } catch { return }
  let skillReferences: CanvasAgentSkillReference[]
  try { skillReferences = parseAgentDraftSkills(input.skillReferences) } catch { return }
  let mcpToolReferences: CanvasMcpToolReference[], mcpResultReferences: CanvasMcpResultReference[]
  try { mcpToolReferences = parseAgentDraftMcpTools(input.mcpToolReferences); mcpResultReferences = parseAgentDraftMcpResults(input.mcpResultReferences) } catch { return }
  let mediaModels: CanvasAgentMediaModels | undefined
  try { mediaModels = parseCanvasAgentMediaModels(input.mediaModels) } catch { return }
  let approval: CanvasAgentStartTurnInput['approval']
  try { approval = parseCanvasAgentApprovalRequest(input.approval); if (mediaModels?.version === 3 && approval && approval.version !== 2) return; if (approval?.version === 2 && mediaModels?.version !== 3) return } catch { return }
  let followUp: CanvasAgentStartTurnInput['followUp']
  if (input.followUp !== undefined) {
    const follow = input.followUp
    if (!record(follow) || follow.version !== 1 || !['queue', 'steer'].includes(String(follow.mode)) || typeof follow.targetTurnId !== 'string' || !identifier.test(follow.targetTurnId) || Object.keys(follow).some((key) => !['version', 'mode', 'targetTurnId'].includes(key))) return
    followUp = { version: 1, mode: follow.mode as 'queue' | 'steer', targetTurnId: follow.targetTurnId }
  }
  return { kind: 'start', ...(Number.isSafeInteger(value.draftRevision) && Number(value.draftRevision) >= 0 ? { draftRevision: Number(value.draftRevision) } : {}), input: { projectId, sessionId, ...(Object.hasOwn(input, 'routerStrategyVersion') ? { routerStrategyVersion: 1 } : {}), ...(approval ? { approval } : {}), ...(followUp ? { followUp } : {}), ...(mediaModels ? { mediaModels } : {}), operationId: input.operationId, expectedSessionVersion: Number(input.expectedSessionVersion), baseProjectVersion: Number(input.baseProjectVersion), prompt: input.prompt, providerId: input.providerId, model: input.model, selectedNodeIds, ...(imageReferences.length ? { imageReferences } : {}), ...(sessionReferences.length ? { sessionReferences } : {}), ...(skillReferences.length ? { skillReferences } : {}), ...(mcpToolReferences.length ? { mcpToolReferences } : {}), ...(mcpResultReferences.length ? { mcpResultReferences } : {}) } }
}
export function readCanvasAgentDraft(scope: Pick<CanvasAgentPanelScope, 'ownerId' | 'projectId'>, sessionId: string, storage?: CanvasAgentDraftStorage): CanvasAgentDraft {
  const empty: CanvasAgentDraft = { text: '', selectedNodeIds: [], model: '' }
  try {
    const target = storageOrNull(storage), eleventh = target?.getItem(storageKey(scope, sessionId, 11)), tenth = target?.getItem(storageKey(scope, sessionId, 10)), ninth = target?.getItem(storageKey(scope, sessionId, 9)), eighth = target?.getItem(storageKey(scope, sessionId, 8)), seventh = target?.getItem(storageKey(scope, sessionId, 7)), sixth = target?.getItem(storageKey(scope, sessionId, 6)), fifth = target?.getItem(storageKey(scope, sessionId, 5)), current = target?.getItem(storageKey(scope, sessionId, 4)), third = target?.getItem(storageKey(scope, sessionId, 3)), previous = target?.getItem(storageKey(scope, sessionId, 2)), first = target?.getItem(storageKey(scope, sessionId))
    if (eleventh == null && [tenth, ninth, eighth, seventh, sixth, fifth, current, third, previous, first].some(routerStrategyDraftMarker)) return { ...empty, pendingRouterStrategyError: '新版路由策略完整草稿缺失，不能剥离原声明后重新发送；请核对原会话。' }
    if (eleventh == null && tenth == null && [ninth, eighth, seventh, sixth, fifth, current, third, previous, first].some(contentModelDraftMarker)) return { ...empty, mediaModelError: '新版内容模型完整草稿缺失，不能回退默认来源。', pendingMediaModelError: '原内容模型操作记录不完整，不能重新发送。', pendingApprovalError: '原消息内容模型授权无法核对，请查看原会话。' }
    if (eleventh == null && tenth == null && ninth == null && [eighth, seventh, sixth, fifth, current, third, previous, first].some(approvalDraftMarker)) return { ...empty, mediaModelError: '新版完整草稿缺失或无法读取，不能回退默认模型。', pendingMediaModelError: '原操作记录不完整，不能重新发送。', pendingApprovalError: '本条自动执行授权记录缺失，不能恢复成手动消息重发；请核对原会话或新建会话。' }
    if (eleventh == null && tenth == null && ninth == null && eighth == null && [seventh, sixth, fifth, current, third, previous, first].some(mediaPoolDraftMarker)) return { ...empty, mediaModelError: '候选池完整草稿缺失或无法读取，旧版标记不能恢复成默认选择。', pendingMediaModelError: '候选池原操作记录不完整，请恢复本机记录并核对原操作，或新建会话；不能重新发送。' }
    const raw = eleventh ?? tenth ?? ninth ?? eighth ?? seventh ?? sixth ?? fifth ?? current ?? third ?? previous ?? first
    const version = eleventh != null ? 11 : tenth != null ? 10 : ninth != null ? 9 : eighth != null ? 8 : seventh != null ? 7 : sixth != null ? 6 : fifth != null ? 5 : current != null ? 4 : third != null ? 3 : previous != null ? 2 : 1
    // Four full resource-path selectors may occur twice while a send is pending.
    // Field parsers still enforce their individual bounds after this envelope cap.
    if (!raw || raw.length > 128 * 1024) return version >= 11 ? { ...empty, pendingRouterStrategyError: '原路由策略草稿无法完整读取，请核对原操作；不能重新发送。' } : version >= 9 ? { ...empty, pendingApprovalError: '本条授权草稿无法完整读取，请核对原操作；不能重新发送。' } : version >= 7 ? { ...empty, mediaModelError: '新版媒体模型草稿无法读取，请明确清除选择后再发送', ...(version === 8 ? { pendingMediaModelError: '候选池记录无法完整核对，请查看原会话操作或新建会话；不能重新发送。' } : {}) } : empty
    const value: unknown = JSON.parse(raw)
    if (!record(value) || value.version !== version || typeof value.text !== 'string' || value.text.length > maximumCanvasAgentPromptCharacters) return version >= 11 ? { ...empty, pendingRouterStrategyError: '原路由策略草稿无法完整读取，请核对原操作；不能重新发送。' } : version >= 9 ? { ...empty, pendingApprovalError: '本条授权草稿无法完整读取，请核对原操作；不能重新发送。' } : version >= 7 ? { ...empty, mediaModelError: '新版媒体模型草稿无法读取，请明确清除选择后再发送', ...(version === 8 ? { pendingMediaModelError: '候选池记录无法完整核对，请查看原会话操作或新建会话；不能重新发送。' } : {}) } : empty
    let pendingRouterStrategyError = value.pendingRouterStrategyError ? '原发送请求的路由策略声明无法核对，请查看原操作；不能重新发送。' : undefined
    if (record(value.pending) && value.pending.kind === 'start' && record(value.pending.input)) {
      const hasMarker = Object.hasOwn(value.pending.input, 'routerStrategyVersion')
      if (version >= 11 && (!hasMarker || value.pending.input.routerStrategyVersion !== 1) || version < 11 && hasMarker) pendingRouterStrategyError = '原发送请求的路由策略声明无法核对，请查看原操作；不能重新发送。'
    }
    let mediaModels: CanvasAgentMediaModels | undefined, mediaModelError = value.mediaModelError ? '媒体模型草稿需要重新选择或明确清除' : undefined
    try {
      mediaModels = parseCanvasAgentMediaModels(value.mediaModels)
      if (version < 10 && mediaModels?.version === 3) throw new Error('旧草稿载体不能承载内容模型池')
      if (version < 8 && mediaModels?.version === 2) throw new Error('旧草稿载体不能承载候选池')
    } catch { mediaModels = undefined; mediaModelError = '媒体模型草稿需要重新选择或明确清除' }
    let pendingMediaModelError = value.pendingMediaModelError ? '原发送请求的媒体模型已损坏，请核对原操作；不能重新发送' : undefined
    try {
      if (record(value.pending) && value.pending.kind === 'start' && record(value.pending.input)) {
        const models = parseCanvasAgentMediaModels(value.pending.input.mediaModels)
        if (version < 10 && models?.version === 3) throw new Error('旧草稿载体不能承载内容模型池')
        if (version < 8 && models?.version === 2) throw new Error('旧草稿载体不能承载候选池')
      }
    } catch { pendingMediaModelError = '原发送请求的媒体模型已损坏，请核对原操作；不能重新发送' }
    const selectedNodeIds = Array.isArray(value.selectedNodeIds) ? [...new Set(value.selectedNodeIds.filter((id): id is string => typeof id === 'string' && identifier.test(id)))].slice(0, 40) : []
    let imageReferences: CanvasAgentImageReference[] = [], imageReferenceError = value.imageReferenceError ? '图片草稿需要重新核对，请移除图片后重新选择' : undefined
    try { imageReferences = parseAgentDraftImages(value.imageReferences, selectedNodeIds) } catch { imageReferenceError = '图片草稿需要重新核对，请移除图片后重新选择' }
    let pendingImageError = value.pendingImageError ? '原发送请求的图片引用已损坏，请核对原操作或新建会话；不能作为新请求重发' : undefined
    try { if (record(value.pending) && value.pending.kind === 'start' && record(value.pending.input)) parseAgentDraftImages(value.pending.input.imageReferences, Array.isArray(value.pending.input.selectedNodeIds) ? value.pending.input.selectedNodeIds as string[] : []) } catch { pendingImageError = '原发送请求的图片引用已损坏，请核对原操作或新建会话；不能作为新请求重发' }
    let sessionReferences: CanvasAgentSessionReference[] = [], sessionReferenceError = value.sessionReferenceError ? '历史引用草稿需要重新核对，请移除后重新选择' : undefined
    try {
      sessionReferences = parseAgentDraftSessionReferences(value.sessionReferences)
    } catch { sessionReferenceError = '历史引用草稿需要重新核对，请移除后重新选择' }
    let pendingReferenceError = value.pendingReferenceError ? '原发送请求的历史引用已损坏，不能作为新请求重发；请刷新会话核对原操作，或新建会话继续' : undefined
    try { if (record(value.pending) && value.pending.kind === 'start' && record(value.pending.input)) parseAgentDraftSessionReferences(value.pending.input.sessionReferences) } catch { pendingReferenceError = '原发送请求的历史引用已损坏，不能作为新请求重发；请刷新会话核对原操作，或新建会话继续' }
    let skillReferences: CanvasAgentSkillReference[] = [], skillReferenceError = value.skillReferenceError ? '技能草稿需要重新核对，请移除后重新选择' : undefined
    try { skillReferences = parseAgentDraftSkills(value.skillReferences) } catch { skillReferenceError = '技能草稿需要重新核对，请移除后重新选择' }
    let pendingSkillError = value.pendingSkillError ? '原发送请求的技能引用已损坏，不能作为新请求重发；请刷新会话核对原操作，或新建会话继续' : undefined
    try { if (record(value.pending) && value.pending.kind === 'start' && record(value.pending.input)) parseAgentDraftSkills(value.pending.input.skillReferences) } catch { pendingSkillError = '原发送请求的技能引用已损坏，不能作为新请求重发；请刷新会话核对原操作，或新建会话继续' }
    let mcpToolReferences: CanvasMcpToolReference[] = [], mcpResultReferences: CanvasMcpResultReference[] = [], mcpReferenceError = value.mcpReferenceError ? 'MCP 草稿需要重新核对，请移除后重新选择' : undefined
    try { mcpToolReferences = parseAgentDraftMcpTools(value.mcpToolReferences); mcpResultReferences = parseAgentDraftMcpResults(value.mcpResultReferences) } catch { mcpReferenceError = 'MCP 草稿需要重新核对，请移除后重新选择' }
    let pendingMcpError = value.pendingMcpError ? '原发送请求的 MCP 引用已损坏，不能作为新请求重发；请核对原操作或新建会话' : undefined
    try { if (record(value.pending) && value.pending.kind === 'start' && record(value.pending.input)) { parseAgentDraftMcpTools(value.pending.input.mcpToolReferences); parseAgentDraftMcpResults(value.pending.input.mcpResultReferences) } } catch { pendingMcpError = '原发送请求的 MCP 引用已损坏，不能作为新请求重发；请核对原操作或新建会话' }
    let pendingApprovalError = value.pendingApprovalError ? '原发送请求的自动执行授权已损坏，请核对原操作；不能重新发送' : undefined
    try { if (record(value.pending) && value.pending.kind === 'start' && record(value.pending.input) && Object.hasOwn(value.pending.input, 'approval')) { if (version < 9) throw new Error('旧草稿不能保存授权'); const approval = parseCanvasAgentApprovalRequest(value.pending.input.approval); if (version < 10 && approval?.version === 2) throw new Error('旧草稿不能保存内容模型授权') } } catch { pendingApprovalError = '原发送请求的自动执行授权已损坏，请核对原操作；不能重新发送' }
    const parsedPending = pendingRouterStrategyError || pendingMediaModelError || pendingApprovalError ? undefined : parsePending(value.pending, scope.projectId, sessionId)
    if (version >= 11 && value.pending !== undefined && !parsedPending) pendingRouterStrategyError = '原路由策略操作记录不完整，请查看原会话；不能重新发送。'
    const pendingFollowUpError = value.pendingFollowUpError || (!parsedPending && record(value.pending) && record(value.pending.input) && value.pending.input.followUp !== undefined) ? '原跟进操作记录已损坏，请刷新会话核对；不能作为新需求重新发送' : undefined
    if (!parsedPending && record(value.pending) && record(value.pending.input) && Object.hasOwn(value.pending.input, 'skillReferences')) pendingSkillError = '原发送请求的技能引用或操作记录已损坏，不能作为新请求重发；请刷新会话核对原操作，或新建会话继续'
    if (!parsedPending && record(value.pending) && record(value.pending.input) && (Object.hasOwn(value.pending.input, 'mcpToolReferences') || Object.hasOwn(value.pending.input, 'mcpResultReferences'))) pendingMcpError = '原发送请求的 MCP 引用或操作记录已损坏，不能作为新请求重发；请核对原操作或新建会话'
    if (!parsedPending && record(value.pending) && record(value.pending.input) && Object.hasOwn(value.pending.input, 'imageReferences')) pendingImageError = '原发送请求的图片引用或操作记录已损坏，请核对原操作或新建会话'
    if (!parsedPending && record(value.pending) && record(value.pending.input) && Object.hasOwn(value.pending.input, 'mediaModels')) pendingMediaModelError = '原发送请求的媒体模型或操作记录已损坏，请核对原操作；不能重新发送'
    if (!parsedPending && record(value.pending) && record(value.pending.input) && Object.hasOwn(value.pending.input, 'approval')) pendingApprovalError = '原自动执行操作记录不完整，请核对原操作；不能作为手动消息重新发送'
    return { text: value.text, ...(pendingRouterStrategyError ? { pendingRouterStrategyError } : {}), ...(pendingApprovalError ? { pendingApprovalError } : {}), selectedNodeIds, ...(mediaModels ? { mediaModels } : {}), ...(mediaModelError ? { mediaModelError } : {}), ...(pendingMediaModelError ? { pendingMediaModelError } : {}), ...(Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 ? { revision: Number(value.revision) } : {}), ...(pendingFollowUpError ? { pendingFollowUpError } : {}), ...(pendingImageError ? { pendingImageError } : {}), ...(mcpToolReferences.length ? { mcpToolReferences } : {}), ...(mcpResultReferences.length ? { mcpResultReferences } : {}), ...(mcpReferenceError ? { mcpReferenceError } : {}), ...(pendingMcpError ? { pendingMcpError } : {}), ...(skillReferences.length ? { skillReferences } : {}), ...(skillReferenceError ? { skillReferenceError } : {}), ...(pendingSkillError ? { pendingSkillError } : {}), ...(pendingReferenceError ? { pendingReferenceError } : {}), ...(imageReferences.length ? { imageReferences } : {}), ...(imageReferenceError ? { imageReferenceError } : {}), ...(sessionReferences.length ? { sessionReferences } : {}), ...(sessionReferenceError ? { sessionReferenceError } : {}), model: typeof value.model === 'string' && value.model.length <= 200 ? value.model : '', ...(typeof value.providerId === 'string' && identifier.test(value.providerId) ? { providerId: value.providerId } : {}), pending: parsedPending }
  } catch {
    try {
      const target = storageOrNull(storage)
      if (target?.getItem(storageKey(scope, sessionId, 11)) != null) return { ...empty, pendingRouterStrategyError: '原路由策略草稿无法完整读取，请核对原操作；不能重新发送。' }
      if (target?.getItem(storageKey(scope, sessionId, 10)) != null) return { ...empty, mediaModelError: '内容模型草稿无法完整读取，请重新核对。', pendingMediaModelError: '原内容模型操作记录无法核对，不能重新发送。', pendingApprovalError: '原授权记录无法核对，不能重新发送。' }
      if (target?.getItem(storageKey(scope, sessionId, 9)) != null) return { ...empty, pendingApprovalError: '本条授权草稿无法完整读取，请核对原操作；不能重新发送。' }
      if (target?.getItem(storageKey(scope, sessionId, 8)) != null) return { ...empty, mediaModelError: '新版媒体模型草稿无法读取，请明确清除选择后再发送', pendingMediaModelError: '候选池记录无法完整核对，请查看原会话操作或新建会话；不能重新发送。' }
      if (target?.getItem(storageKey(scope, sessionId, 7)) != null) return { ...empty, mediaModelError: '新版媒体模型草稿无法读取，请明确清除选择后再发送' }
    } catch { return { ...empty, mediaModelError: '本机模型草稿存储不可读取，请核对原会话；当前不会默认发送。', pendingMediaModelError: '本机原操作记录无法核对，请恢复存储后重开会话或新建会话继续。' } }
    return empty
  }
}
export function writeCanvasAgentDraft(scope: Pick<CanvasAgentPanelScope, 'ownerId' | 'projectId'>, sessionId: string, value: CanvasAgentDraft, storage?: CanvasAgentDraftStorage): boolean {
  try {
    const target = storageOrNull(storage)
    if (!target) return false
    const selectedNodeIds = value.selectedNodeIds.slice(0, 40)
    const imageReferences = parseAgentDraftImages(value.imageReferences, selectedNodeIds)
    const sessionReferences = parseAgentDraftSessionReferences(value.sessionReferences)
    const skillReferences = parseAgentDraftSkills(value.skillReferences)
    const mcpToolReferences = parseAgentDraftMcpTools(value.mcpToolReferences), mcpResultReferences = parseAgentDraftMcpResults(value.mcpResultReferences)
    const mediaModels = parseCanvasAgentMediaModels(value.mediaModels)
    const routed = Boolean(mediaModels || value.mediaModelError || value.pendingMediaModelError || value.pending?.kind === 'start' && value.pending.input.mediaModels || target.getItem(storageKey(scope, sessionId, 7)))
    const pooled = mediaModels?.version === 2 || value.pending?.kind === 'start' && value.pending.input.mediaModels?.version === 2 || target.getItem(storageKey(scope, sessionId, 8)) != null || [1, 2, 3, 4, 5, 6, 7].some((version) => mediaPoolDraftMarker(target.getItem(storageKey(scope, sessionId, version))))
    const approved = Boolean(value.pendingApprovalError || value.pending?.kind === 'start' && value.pending.input.approval || target.getItem(storageKey(scope, sessionId, 9)) != null || [1, 2, 3, 4, 5, 6, 7, 8].some((version) => approvalDraftMarker(target.getItem(storageKey(scope, sessionId, version)))))
    if (value.pending?.kind === 'start') {
      const approval = parseCanvasAgentApprovalRequest(value.pending.input.approval), pendingModels = parseCanvasAgentMediaModels(value.pending.input.mediaModels)
      if (approval && pendingModels?.version === 3 && approval.version !== 2 || approval?.version === 2 && pendingModels?.version !== 3) return false
    }
    const hasPendingRouterStrategy = value.pending?.kind === 'start' && Object.hasOwn(value.pending.input, 'routerStrategyVersion')
    if (hasPendingRouterStrategy && value.pending?.kind === 'start' && value.pending.input.routerStrategyVersion !== 1) return false
    const routerRouted = Boolean(hasPendingRouterStrategy || value.pendingRouterStrategyError || target.getItem(storageKey(scope, sessionId, 11)) != null || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].some((version) => routerStrategyDraftMarker(target.getItem(storageKey(scope, sessionId, version)))))
    if (routerRouted && value.pending?.kind === 'start' && !hasPendingRouterStrategy) return false
    const contentRouted = mediaModels?.version === 3 || value.pending?.kind === 'start' && (value.pending.input.mediaModels?.version === 3 || value.pending.input.approval?.version === 2) || target.getItem(storageKey(scope, sessionId, 10)) != null || [1, 2, 3, 4, 5, 6, 7, 8, 9].some((version) => contentModelDraftMarker(target.getItem(storageKey(scope, sessionId, version))))
    const version = routerRouted ? 11 : contentRouted ? 10 : approved ? 9 : pooled ? 8 : routed ? 7 : 6
    target.setItem(storageKey(scope, sessionId, version), JSON.stringify({ version, ...(value.pendingRouterStrategyError ? { pendingRouterStrategyError: true } : {}), ...(value.pendingApprovalError ? { pendingApprovalError: true } : {}), ...(mediaModels ? { mediaModels } : {}), ...(value.mediaModelError ? { mediaModelError: true } : {}), ...(value.pendingMediaModelError ? { pendingMediaModelError: true } : {}), ...(value.revision !== undefined ? { revision: value.revision } : {}), ...(value.pendingFollowUpError ? { pendingFollowUpError: true } : {}), ...(value.pendingImageError ? { pendingImageError: true } : {}), ...(mcpToolReferences.length ? { mcpToolReferences } : {}), ...(mcpResultReferences.length ? { mcpResultReferences } : {}), ...(value.mcpReferenceError ? { mcpReferenceError: true } : {}), ...(value.pendingMcpError ? { pendingMcpError: true } : {}), text: value.text.slice(0, maximumCanvasAgentPromptCharacters), selectedNodeIds, ...(imageReferences.length ? { imageReferences } : {}), ...(value.imageReferenceError ? { imageReferenceError: true } : {}), ...(sessionReferences.length ? { sessionReferences } : {}), ...(value.sessionReferenceError ? { sessionReferenceError: true } : {}), ...(value.pendingReferenceError ? { pendingReferenceError: true } : {}), ...(skillReferences.length ? { skillReferences } : {}), ...(value.skillReferenceError ? { skillReferenceError: true } : {}), ...(value.pendingSkillError ? { pendingSkillError: true } : {}), model: value.model.slice(0, 200), ...(value.providerId ? { providerId: value.providerId } : {}), ...(value.pending ? { pending: value.pending } : {}) }))
    if (routerRouted) target.setItem(storageKey(scope, sessionId, 10), JSON.stringify({ version }))
    if (routerRouted || contentRouted) target.setItem(storageKey(scope, sessionId, 9), JSON.stringify({ version }))
    if (routerRouted || contentRouted || approved) target.setItem(storageKey(scope, sessionId, 8), JSON.stringify({ version }))
    if (routerRouted || contentRouted || approved || pooled) target.setItem(storageKey(scope, sessionId, 7), JSON.stringify({ version }))
    if (routerRouted || contentRouted || approved || routed || pooled) target.setItem(storageKey(scope, sessionId, 6), JSON.stringify({ version }))
    // Old readers reject version 6 instead of dropping frozen follow-up intent.
    // Keep the durable new key separate so an already-open old page cannot overwrite it.
    target.setItem(storageKey(scope, sessionId, 5), JSON.stringify({ version }))
    target.setItem(storageKey(scope, sessionId, 4), JSON.stringify({ version }))
    target.setItem(storageKey(scope, sessionId, 3), JSON.stringify({ version }))
    target.setItem(storageKey(scope, sessionId, 2), JSON.stringify({ version }))
    target.setItem(storageKey(scope, sessionId), JSON.stringify({ version }))
    return true
  } catch { return false }
}
export function readCanvasAgentProjectMemory(scope: Pick<CanvasAgentPanelScope, 'ownerId' | 'projectId'>, storage?: CanvasAgentDraftStorage): CanvasAgentProjectMemory {
  try {
    const raw = storageOrNull(storage)?.getItem(storageKey(scope))
    if (!raw || raw.length > 2_000) return {}
    const value: unknown = JSON.parse(raw)
    if (!record(value)) return {}
    return { selectedSessionId: typeof value.selectedSessionId === 'string' && identifier.test(value.selectedSessionId) ? value.selectedSessionId : undefined,
      width: typeof value.width === 'number' && Number.isFinite(value.width) ? canvasAgentPanelWidth(value.width, 2_000) : undefined,
      pendingCreate: record(value.pendingCreate) && typeof value.pendingCreate.operationId === 'string' && operation.test(value.pendingCreate.operationId) && typeof value.pendingCreate.title === 'string' && value.pendingCreate.title.length <= 100 ? { operationId: value.pendingCreate.operationId, title: value.pendingCreate.title } : undefined }
  } catch { return {} }
}
export function writeCanvasAgentProjectMemory(scope: Pick<CanvasAgentPanelScope, 'ownerId' | 'projectId'>, value: CanvasAgentProjectMemory, storage?: CanvasAgentDraftStorage): boolean {
  try { const target = storageOrNull(storage); if (!target) return false; target.setItem(storageKey(scope), JSON.stringify(value)); return true } catch { return false }
}
export function canvasAgentPanelWidth(width: number, availableWidth: number): number {
  const maximum = Math.max(240, Math.min(640, availableWidth - 48))
  return Math.round(Math.min(maximum, Math.max(Math.min(320, maximum), Number.isFinite(width) ? width : 380)))
}
export function canvasAgentDraftModel(draft: CanvasAgentDraft, providerId: string | null, models: readonly string[], preferred?: string | null): string {
  if (draft.model && (!draft.providerId || draft.providerId === providerId)) return draft.model
  return preferred && models.includes(preferred) ? preferred : models[0] ?? ''
}
export function mergeCanvasAgentTurns(current: readonly CanvasAgentTurn[], incoming: readonly CanvasAgentTurn[]): CanvasAgentTurn[] {
  const entries = new Map(current.map((turn) => [turn.id, turn]))
  for (const turn of incoming) {
    const old = entries.get(turn.id)
    if (old?.supersededBy && !turn.supersededBy || old?.state === 'cancelled' && !turn.cancelRequested || old && turn.sessionVersion < old.sessionVersion) continue
    if (!old || turn.updatedAt >= old.updatedAt) entries.set(turn.id, turn)
  }
  return [...entries.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}
export function canvasAgentTurnActive(turn: CanvasAgentTurn): boolean { return turn.state === 'waiting' || turn.state === 'queued' || turn.state === 'running' }
export function canvasAgentDefiniteRejection(cause: unknown): boolean {
  return record(cause) && typeof cause.status === 'number' && [400, 401, 403, 404, 409, 413, 422].includes(cause.status)
}
export function canvasAgentErrorText(cause: unknown): string { return cause instanceof Error && cause.message ? cause.message : '请求暂时无法完成，请稍后核对原操作' }
export function canvasAgentSessionMatches(session: CanvasAgentSession, projectId: string, sessionId?: string): boolean { return session.projectId === projectId && (!sessionId || session.id === sessionId) }
export function canvasAgentPendingMatchesTurn(pending: CanvasAgentPendingAction, turn: CanvasAgentTurn): boolean {
  if (pending.input.projectId !== turn.projectId || pending.input.sessionId !== turn.sessionId) return false
  if (pending.kind !== 'start') return pending.input.turnId === turn.id
  try { return pending.input.operationId === turn.operationId && pending.input.routerStrategyVersion === turn.routerStrategyVersion && Boolean(pending.input.approval) === Boolean(turn.approval) && pending.input.approval?.version === turn.approval?.version && (!turn.approval || turn.approval.rootTurnId === turn.id) && JSON.stringify(parseCanvasAgentMediaModels(pending.input.mediaModels)) === JSON.stringify(parseCanvasAgentMediaModels(turn.mediaModels)) } catch { return false }
}
