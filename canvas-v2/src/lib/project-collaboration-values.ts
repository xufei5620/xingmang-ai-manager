import { parseProjectAccessSnapshot } from './project-access-contract'
import { isCanvasPublicAccountId } from './canvas-account-contract'
import { maximumProjectContentBytes, maximumProjectEdges, maximumProjectNodes, utf8ByteLength } from './canvas-limits'
import { assertProjectCollaborationVersion, ProjectCollaborationError, projectCollaborationLimits,
  type ProjectCollaborationActor, type ProjectCollaborationChange, type ProjectCollaborationEvent,
  type ProjectCollaborationFeed, type ProjectCollaborationFeedInput, type ProjectCollaborationHead,
  type ProjectCollaborationHistory, type ProjectCollaborationInspection, type ProjectCollaborationJoinInput,
  type ProjectCollaborationJoinResult, type ProjectCollaborationMutationInput, type ProjectCollaborationMutationResult,
  type ProjectCollaborationNode, type ProjectCollaborationNodeProperties, type ProjectCollaborationPresence,
  type ProjectCollaborationPresenceInput, type ProjectCollaborationPresenceResult, type ProjectCollaborationReadOptions,
  type ProjectCollaborationReceipt, type ProjectCollaborationSnapshot } from './project-collaboration-contract'

export function collaborationRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectCollaborationError('协作资料格式不正确')
  return value as Record<string, unknown>
}
export function collaborationKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ProjectCollaborationError('协作资料包含不支持的字段，请刷新并保留本机草稿')
}
export function collaborationText(value: unknown, maximum = 256, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || !empty && !value || /\u0000/.test(value)) throw new ProjectCollaborationError('协作文字或编号不正确')
  return value
}
export function collaborationInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) >= Number.MAX_SAFE_INTEGER) throw new ProjectCollaborationError('协作版本或数量不正确')
  return Number(value)
}
export function collaborationUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ProjectCollaborationError('协作操作或会话编号不正确')
  return value.toLowerCase()
}
function digest(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new ProjectCollaborationError('协作摘要不正确'); return value }
function date(value: unknown): string { const text = collaborationText(value, 40); if (!Number.isFinite(Date.parse(text))) throw new ProjectCollaborationError('协作时间不正确'); return text }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new ProjectCollaborationError('协作状态不正确'); return value }
function point(value: unknown) {
  const v = collaborationRecord(value); collaborationKeys(v, ['x', 'y'])
  if (![v.x, v.y].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10_000_000)) throw new ProjectCollaborationError('协作坐标不正确')
  return { x: Number(v.x), y: Number(v.y) }
}
function strings(value: unknown, maximum: number, length = 256): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new ProjectCollaborationError('协作列表超过上限')
  const result = value.map(v => collaborationText(v, length)); if (new Set(result).size !== result.length) throw new ProjectCollaborationError('协作列表包含重复编号'); return result
}
function json(value: unknown, depth = 0): void {
  if (depth > 32) throw new ProjectCollaborationError('协作配置嵌套超过上限')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) { for (const item of value) json(item, depth + 1); return }
  const v = collaborationRecord(value)
  for (const [key, item] of Object.entries(v)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new ProjectCollaborationError('协作配置包含不支持的键'); json(item, depth + 1) }
}
function bounded(value: unknown, maximum: number): void { json(value); if (utf8ByteLength(JSON.stringify(value)) > maximum) throw new ProjectCollaborationError('单次协作变更超过容量，请保留草稿并缩小操作范围；不会改用整图覆盖', 422) }
const nodeKeys = ['id', 'kind', 'definitionVersion', 'disabled', 'parentId', 'width', 'height', 'locked', 'position', 'data'] as const
const dataKeys = ['prompt', 'promptReferences', 'outputText', 'textWebSearch', 'dirty', 'model', 'group', 'quality', 'size', 'imageResolution', 'imageCandidateCount', 'videoCandidateCount', 'seconds', 'result', 'settings', 'candidateAssetIds'] as const
function properties(value: unknown): ProjectCollaborationNodeProperties {
  const v = collaborationRecord(value); collaborationKeys(v, nodeKeys.filter(key => !['id', 'position', 'data'].includes(key)))
  collaborationText(v.kind, 128); collaborationInteger(v.definitionVersion, 1)
  for (const key of ['disabled', 'locked']) if (v[key] !== undefined) boolean(v[key])
  if (v.parentId !== undefined) collaborationText(v.parentId)
  for (const key of ['width', 'height']) if (v[key] !== undefined && (typeof v[key] !== 'number' || !Number.isFinite(v[key]) || Number(v[key]) <= 0 || Number(v[key]) > 10_000_000)) throw new ProjectCollaborationError('协作节点尺寸不正确')
  json(v); return structuredClone(v) as unknown as ProjectCollaborationNodeProperties
}
function data(value: unknown): ProjectCollaborationNode['data'] {
  const v = collaborationRecord(value); collaborationKeys(v, dataKeys); collaborationText(v.prompt, 100_000, true); collaborationText(v.model, 512, true)
  for (const key of ['group', 'quality', 'size', 'seconds']) if (v[key] !== undefined) collaborationText(v[key], key === 'group' ? 128 : 128, true)
  if (v.outputText !== undefined) collaborationText(v.outputText, 32_000, true)
  for (const key of ['textWebSearch', 'dirty']) if (v[key] !== undefined) boolean(v[key])
  if (v.imageResolution !== undefined && !['1K', '2K', '4K'].includes(String(v.imageResolution))) throw new ProjectCollaborationError('协作图片清晰度版本不正确')
  for (const key of ['imageCandidateCount', 'videoCandidateCount']) if (v[key] !== undefined && (collaborationInteger(v[key], 1) > 16)) throw new ProjectCollaborationError('协作候选数量不正确')
  if (v.candidateAssetIds !== undefined) strings(v.candidateAssetIds, 16, 128)
  if (v.settings !== undefined) collaborationRecord(v.settings)
  if (v.promptReferences !== undefined && (!Array.isArray(v.promptReferences) || v.promptReferences.length > 100)) throw new ProjectCollaborationError('协作提示词引用不正确')
  if (v.result !== undefined) {
    const a = collaborationRecord(v.result); collaborationKeys(a, ['kind', 'assetId', 'localUrl', 'mimeType', 'width', 'height', 'durationSeconds', 'taskId'])
    if (!['image', 'video', 'audio'].includes(String(a.kind))) throw new ProjectCollaborationError('协作素材类型不正确')
    if (a.assetId !== undefined && (typeof a.assetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(a.assetId))) throw new ProjectCollaborationError('协作素材编号不正确')
    if (a.localUrl !== undefined && a.localUrl !== `xingmang-asset://${a.kind}/${a.assetId}`) throw new ProjectCollaborationError('协作素材地址不正确')
    for (const key of ['width', 'height', 'durationSeconds']) if (a[key] !== undefined && (typeof a[key] !== 'number' || !Number.isFinite(a[key]) || Number(a[key]) < 0)) throw new ProjectCollaborationError('协作素材尺寸不正确')
    if (a.mimeType !== undefined) collaborationText(a.mimeType, 128); if (a.taskId !== undefined) collaborationText(a.taskId, 512)
  }
  json(v); return structuredClone(v) as unknown as ProjectCollaborationNode['data']
}
export function parseProjectCollaborationNode(value: unknown): ProjectCollaborationNode {
  const v = collaborationRecord(value); collaborationKeys(v, nodeKeys)
  const { id, position, data: nodeData, ...rest } = v
  return { id: collaborationText(id), ...properties(rest), position: point(position), data: data(nodeData) }
}
function edges(value: unknown) {
  if (!Array.isArray(value) || value.length > maximumProjectEdges) throw new ProjectCollaborationError('协作连线数量超过上限')
  const result = value.map(item => { const v = collaborationRecord(item); collaborationKeys(v, ['id', 'source', 'sourceHandle', 'target', 'targetHandle']); return { id: collaborationText(v.id), source: collaborationText(v.source), sourceHandle: collaborationText(v.sourceHandle), target: collaborationText(v.target), targetHandle: collaborationText(v.targetHandle) } })
  if (new Set(result.map(item => item.id)).size !== result.length) throw new ProjectCollaborationError('协作连线编号重复'); return result
}
function mediaGroups(value: unknown) {
  if (value === null) return null
  const v = collaborationRecord(value); collaborationKeys(v, ['image', 'video', 'text', 'imageModel', 'videoModel', 'textModel'])
  for (const [key, item] of Object.entries(v)) collaborationText(item, key.endsWith('Model') ? 512 : 128)
  return structuredClone(v) as NonNullable<import('../model').WorkflowFile['mediaGroups']>
}
export function parseProjectCollaborationChange(value: unknown): ProjectCollaborationChange {
  const v = collaborationRecord(value)
  if (v.kind === 'node-add' || v.kind === 'node-remove') { collaborationKeys(v, ['kind', 'node']); return { kind: v.kind, node: parseProjectCollaborationNode(v.node) } }
  if (v.kind === 'node-set') {
    collaborationKeys(v, ['kind', 'nodeId', 'slot', 'before', 'after']); const nodeId = collaborationText(v.nodeId)
    if (v.slot === 'position') return { kind: 'node-set', nodeId, slot: 'position', before: point(v.before), after: point(v.after) }
    if (v.slot === 'data') return { kind: 'node-set', nodeId, slot: 'data', before: data(v.before), after: data(v.after) }
    if (v.slot === 'properties') return { kind: 'node-set', nodeId, slot: 'properties', before: properties(v.before), after: properties(v.after) }
  }
  if (v.kind === 'node-order-set') { collaborationKeys(v, ['kind', 'before', 'after']); return { kind: 'node-order-set', before: strings(v.before, maximumProjectNodes), after: strings(v.after, maximumProjectNodes) } }
  if (v.kind === 'edges-set') { collaborationKeys(v, ['kind', 'before', 'after']); return { kind: 'edges-set', before: edges(v.before), after: edges(v.after) } }
  if (v.kind === 'document-set') {
    collaborationKeys(v, ['kind', 'slot', 'before', 'after'])
    if (v.slot === 'name') return { kind: 'document-set', slot: 'name', before: collaborationText(v.before), after: collaborationText(v.after) }
    if (v.slot === 'mediaGroups') return { kind: 'document-set', slot: 'mediaGroups', before: mediaGroups(v.before), after: mediaGroups(v.after) }
  }
  throw new ProjectCollaborationError('协作变更种类或字段不受支持')
}
export function parseProjectCollaborationChanges(value: unknown, allowEmpty = false): ProjectCollaborationChange[] {
  if (!Array.isArray(value) || value.length > projectCollaborationLimits.changes || !allowEmpty && !value.length) throw new ProjectCollaborationError('协作变更数量不正确')
  bounded(value, projectCollaborationLimits.requestBytes); return value.map(parseProjectCollaborationChange)
}
export function parseProjectCollaborationReadOptions(value: unknown): ProjectCollaborationReadOptions {
  const v = collaborationRecord(value); collaborationKeys(v, ['version', 'expectedAccessVersion', 'clientId']); assertProjectCollaborationVersion(v.version)
  return { version: 1, ...(v.expectedAccessVersion === undefined ? {} : { expectedAccessVersion: collaborationInteger(v.expectedAccessVersion) }), ...(v.clientId === undefined ? {} : { clientId: collaborationUuid(v.clientId) }) }
}
export function parseProjectCollaborationJoinInput(value: unknown): ProjectCollaborationJoinInput {
  bounded(value, projectCollaborationLimits.requestBytes); const v = collaborationRecord(value); collaborationKeys(v, ['version', 'action', 'operationId', 'clientId', 'expectedAccessVersion', 'expectedProjectVersion', 'contentDigest', 'epoch']); assertProjectCollaborationVersion(v.version)
  if (v.action !== 'join' && v.action !== 'resync') throw new ProjectCollaborationError('协作加入操作不正确')
  return { version: 1, action: v.action, operationId: collaborationUuid(v.operationId), clientId: collaborationUuid(v.clientId), expectedAccessVersion: collaborationInteger(v.expectedAccessVersion, 1), expectedProjectVersion: collaborationInteger(v.expectedProjectVersion, 1), contentDigest: digest(v.contentDigest), ...(v.epoch === undefined ? {} : { epoch: collaborationUuid(v.epoch) }) }
}
export function parseProjectCollaborationFeedInput(value: unknown): ProjectCollaborationFeedInput {
  const v = collaborationRecord(value); collaborationKeys(v, ['version', 'clientId', 'epoch', 'expectedAccessVersion', 'afterSequence', 'afterProjectVersion', 'limit']); assertProjectCollaborationVersion(v.version)
  const limit = v.limit === undefined ? undefined : collaborationInteger(v.limit, 1); if (limit && limit > projectCollaborationLimits.events) throw new ProjectCollaborationError('协作增量分页超过上限')
  return { version: 1, ...(v.clientId === undefined ? {} : { clientId: collaborationUuid(v.clientId) }), epoch: collaborationUuid(v.epoch), expectedAccessVersion: collaborationInteger(v.expectedAccessVersion, 1), afterSequence: collaborationInteger(v.afterSequence), afterProjectVersion: collaborationInteger(v.afterProjectVersion, 1), ...(limit ? { limit } : {}) }
}
export function parseProjectCollaborationMutationInput(value: unknown): ProjectCollaborationMutationInput {
  bounded(value, projectCollaborationLimits.requestBytes); const v = collaborationRecord(value); collaborationKeys(v, ['version', 'operationId', 'clientId', 'epoch', 'expectedAccessVersion', 'baseProjectVersion', 'expectedActorSequence', 'action', 'changes', 'targetOperationId']); assertProjectCollaborationVersion(v.version)
  const base = { version: 1 as const, operationId: collaborationUuid(v.operationId), clientId: collaborationUuid(v.clientId), epoch: collaborationUuid(v.epoch), expectedAccessVersion: collaborationInteger(v.expectedAccessVersion, 1), baseProjectVersion: collaborationInteger(v.baseProjectVersion, 1), expectedActorSequence: collaborationInteger(v.expectedActorSequence) }
  if (v.action === 'edit' && v.targetOperationId === undefined) return { ...base, action: 'edit', changes: parseProjectCollaborationChanges(v.changes) }
  if ((v.action === 'undo' || v.action === 'redo') && v.changes === undefined) return { ...base, action: v.action, targetOperationId: collaborationUuid(v.targetOperationId) }
  if (v.action === 'end-epoch' && v.changes === undefined && v.targetOperationId === undefined) return { ...base, action: 'end-epoch' }
  throw new ProjectCollaborationError('协作操作必须使用明确的编辑或本人原操作撤销类型')
}
export function parseProjectCollaborationPresenceInput(value: unknown): ProjectCollaborationPresenceInput {
  const v = collaborationRecord(value); collaborationKeys(v, ['version', 'action', 'clientId', 'epoch', 'expectedAccessVersion', 'selectedNodeIds', 'cursor']); assertProjectCollaborationVersion(v.version)
  if (v.action !== 'heartbeat' && v.action !== 'leave') throw new ProjectCollaborationError('协作在线状态操作不正确')
  return { version: 1, action: v.action, clientId: collaborationUuid(v.clientId), epoch: collaborationUuid(v.epoch), expectedAccessVersion: collaborationInteger(v.expectedAccessVersion, 1), selectedNodeIds: strings(v.selectedNodeIds, projectCollaborationLimits.selectedNodes), ...(v.cursor === undefined ? {} : { cursor: point(v.cursor) }) }
}
function actor(value: unknown): ProjectCollaborationActor {
  const v = collaborationRecord(value); collaborationKeys(v, ['accountId', 'displayName']); if (!isCanvasPublicAccountId(v.accountId)) throw new ProjectCollaborationError('协作账户公共编号不正确'); return { accountId: v.accountId, ...(v.displayName === undefined ? {} : { displayName: collaborationText(v.displayName, 256) }) }
}
function head(value: unknown): ProjectCollaborationHead {
  const v = collaborationRecord(value); collaborationKeys(v, ['version', 'epoch', 'sequence', 'baselineProjectVersion', 'projectVersion', 'endedAt']); assertProjectCollaborationVersion(v.version)
  const result = { version: 1 as const, epoch: collaborationUuid(v.epoch), sequence: collaborationInteger(v.sequence), baselineProjectVersion: collaborationInteger(v.baselineProjectVersion, 1), projectVersion: collaborationInteger(v.projectVersion, 1), ...(v.endedAt === undefined ? {} : { endedAt: date(v.endedAt) }) }
  if (result.baselineProjectVersion > result.projectVersion) throw new ProjectCollaborationError('协作工程基线不一致'); return result
}
function history(value: unknown): ProjectCollaborationHistory {
  const v = collaborationRecord(value); collaborationKeys(v, ['actorSequence', 'undo', 'redo'])
  function tip(raw: unknown) { const t = collaborationRecord(raw); collaborationKeys(t, ['operationId', 'projectVersion']); return { operationId: collaborationUuid(t.operationId), projectVersion: collaborationInteger(t.projectVersion, 1) } }
  return { actorSequence: collaborationInteger(v.actorSequence), ...(v.undo === undefined ? {} : { undo: tip(v.undo) }), ...(v.redo === undefined ? {} : { redo: tip(v.redo) }) }
}
function presence(value: unknown): ProjectCollaborationPresence[] {
  if (!Array.isArray(value) || value.length > projectCollaborationLimits.clientsPerProject) throw new ProjectCollaborationError('协作在线成员超过上限')
  return value.map(raw => { const v = collaborationRecord(raw); collaborationKeys(v, ['version', 'clientId', 'actor', 'selectedNodeIds', 'cursor', 'expiresAt']); assertProjectCollaborationVersion(v.version); return { version: 1, clientId: collaborationUuid(v.clientId), actor: actor(v.actor), selectedNodeIds: strings(v.selectedNodeIds, projectCollaborationLimits.selectedNodes), ...(v.cursor === undefined ? {} : { cursor: point(v.cursor) }), expiresAt: date(v.expiresAt) } })
}
function project(value: unknown): ProjectCollaborationSnapshot['project'] {
  const v = collaborationRecord(value); collaborationKeys(v, ['id', 'name', 'version', 'createdAt', 'updatedAt', 'lastOpenedAt', 'nodeCount', 'assetCount', 'workspaceConfigured', 'workspaceStatus', 'workspaceName', 'metadataVersion', 'categoryId', 'cover', 'summaryStatus', 'previewAsset', 'archivedAt', 'access'])
  collaborationText(v.id, 80); collaborationText(v.name); collaborationInteger(v.version, 1); date(v.createdAt); date(v.updatedAt); date(v.lastOpenedAt); boolean(v.workspaceConfigured)
  if (!['ready', 'missing', 'legacy'].includes(String(v.workspaceStatus))) throw new ProjectCollaborationError('协作工程目录状态不正确')
  for (const k of ['nodeCount', 'assetCount']) if (v[k] !== null) collaborationInteger(v[k])
  for (const k of ['workspaceName', 'categoryId']) if (v[k] !== undefined) collaborationText(v[k])
  if (v.metadataVersion !== undefined) collaborationInteger(v.metadataVersion)
  if (v.summaryStatus !== undefined && !['ready', 'unavailable'].includes(String(v.summaryStatus))) throw new ProjectCollaborationError('协作工程摘要状态不正确')
  if (v.archivedAt !== undefined) date(v.archivedAt)
  if (v.previewAsset !== undefined) { const a = collaborationRecord(v.previewAsset); collaborationKeys(a, ['kind', 'assetId', 'localUrl']); if (!['image', 'video', 'audio'].includes(String(a.kind)) || typeof a.assetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(a.assetId) || a.localUrl !== `xingmang-asset://${a.kind}/${a.assetId}`) throw new ProjectCollaborationError('协作工程预览地址不正确') }
  if (v.cover !== undefined) { const c = collaborationRecord(v.cover); collaborationKeys(c, ['assetId', 'positionX', 'positionY', 'zoom']); if (typeof c.assetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(c.assetId) || ![c.positionX, c.positionY, c.zoom].every(x => typeof x === 'number' && Number.isFinite(x)) || Number(c.positionX) < 0 || Number(c.positionX) > 1 || Number(c.positionY) < 0 || Number(c.positionY) > 1 || Number(c.zoom) < 1 || Number(c.zoom) > 5) throw new ProjectCollaborationError('协作工程封面不正确') }
  const access = parseProjectAccessSnapshot(v.access); if (access.projectId !== v.id || access.projectVersion !== v.version) throw new ProjectCollaborationError('协作工程权限与内容版本不一致')
  return { ...structuredClone(v), access } as unknown as ProjectCollaborationSnapshot['project']
}
export function parseProjectCollaborationSnapshot(value: unknown): ProjectCollaborationSnapshot {
  bounded(value, projectCollaborationLimits.responseBytes); const v = collaborationRecord(value); collaborationKeys(v, ['version', 'projectId', 'state', 'project', 'content', 'contentDigest', 'actor', 'head', 'canJoin', 'history', 'presence']); assertProjectCollaborationVersion(v.version)
  if (!['ready', 'not-started', 'resync-required', 'ended'].includes(String(v.state))) throw new ProjectCollaborationError('协作快照状态不正确')
  const result: ProjectCollaborationSnapshot = { version: 1, projectId: collaborationText(v.projectId, 80), state: v.state as ProjectCollaborationSnapshot['state'], project: project(v.project), content: collaborationText(v.content, maximumProjectContentBytes), contentDigest: digest(v.contentDigest), actor: actor(v.actor), ...(v.head === undefined ? {} : { head: head(v.head) }), canJoin: boolean(v.canJoin), history: history(v.history), presence: presence(v.presence) }
  if (utf8ByteLength(result.content) > maximumProjectContentBytes || result.projectId !== result.project.id || result.canJoin && !result.project.access.canEdit || result.state === 'ready' && (!result.head || result.head.endedAt || result.head.projectVersion !== result.project.version) || result.state === 'ended' && !result.head?.endedAt) throw new ProjectCollaborationError('协作快照工程范围或版本不一致')
  return result
}
export function parseProjectCollaborationReceipt(value: unknown): ProjectCollaborationReceipt {
  bounded(value, projectCollaborationLimits.receiptBytes); const v = collaborationRecord(value); collaborationKeys(v, ['version', 'projectId', 'operationId', 'requestDigest', 'action', 'epoch', 'sequence', 'accessVersion', 'previousProjectVersion', 'projectVersion', 'baseProjectVersion', 'contentDigest', 'targetOperationId']); assertProjectCollaborationVersion(v.version)
  if (!['join', 'resync', 'edit', 'undo', 'redo', 'end-epoch'].includes(String(v.action))) throw new ProjectCollaborationError('协作回执种类不正确')
  const result: ProjectCollaborationReceipt = { version: 1, projectId: collaborationText(v.projectId, 80), operationId: collaborationUuid(v.operationId), requestDigest: digest(v.requestDigest), action: v.action as ProjectCollaborationReceipt['action'], epoch: collaborationUuid(v.epoch), sequence: collaborationInteger(v.sequence, 1), accessVersion: collaborationInteger(v.accessVersion, 1), previousProjectVersion: collaborationInteger(v.previousProjectVersion, 1), projectVersion: collaborationInteger(v.projectVersion, 1), baseProjectVersion: collaborationInteger(v.baseProjectVersion, 1), contentDigest: digest(v.contentDigest), ...(v.targetOperationId === undefined ? {} : { targetOperationId: collaborationUuid(v.targetOperationId) }) }
  if (result.baseProjectVersion > result.previousProjectVersion || result.projectVersion !== result.previousProjectVersion + (['edit', 'undo', 'redo'].includes(result.action) ? 1 : 0) || ['undo', 'redo'].includes(result.action) !== Boolean(result.targetOperationId)) throw new ProjectCollaborationError('协作原操作回执版本不一致')
  return result
}
export function parseProjectCollaborationEvent(value: unknown): ProjectCollaborationEvent {
  const v = collaborationRecord(value); collaborationKeys(v, ['version', 'receipt', 'actor', 'changes', 'createdAt']); assertProjectCollaborationVersion(v.version)
  const receipt = parseProjectCollaborationReceipt(v.receipt), changes = parseProjectCollaborationChanges(v.changes, !['edit', 'undo', 'redo'].includes(receipt.action))
  if (!['edit', 'undo', 'redo'].includes(receipt.action) && changes.length) throw new ProjectCollaborationError('协作控制事件不能夹带工程变更')
  return { version: 1, receipt, actor: actor(v.actor), changes, createdAt: date(v.createdAt) }
}
export function parseProjectCollaborationInspection(value: unknown): ProjectCollaborationInspection {
  const v = collaborationRecord(value); assertProjectCollaborationVersion(v.version)
  if (v.state === 'missing') { collaborationKeys(v, ['version', 'state']); return { version: 1, state: 'missing' } }
  collaborationKeys(v, ['version', 'state', 'receipt', 'payloadState', 'event']); if (v.state !== 'found' || !['retained', 'compacted', 'unavailable'].includes(String(v.payloadState))) throw new ProjectCollaborationError('协作原操作核对状态不正确')
  const receipt = parseProjectCollaborationReceipt(v.receipt), event = v.event === undefined ? undefined : parseProjectCollaborationEvent(v.event)
  if ((v.payloadState === 'retained') !== Boolean(event) || event && JSON.stringify(event.receipt) !== JSON.stringify(receipt)) throw new ProjectCollaborationError('协作事件与原操作回执不一致')
  return { version: 1, state: 'found', receipt, payloadState: v.payloadState as 'retained' | 'compacted' | 'unavailable', ...(event ? { event } : {}) }
}
export function parseProjectCollaborationJoinResult(value: unknown): ProjectCollaborationJoinResult {
  const v = collaborationRecord(value); collaborationKeys(v, ['version', 'receipt', 'snapshot', 'clientId', 'leaseState', 'expiresAt']); assertProjectCollaborationVersion(v.version)
  const receipt = parseProjectCollaborationReceipt(v.receipt), snapshot = parseProjectCollaborationSnapshot(v.snapshot)
  if (!['join', 'resync'].includes(receipt.action) || receipt.projectId !== snapshot.projectId || !['active', 'expired', 'left', 'ended'].includes(String(v.leaseState))) throw new ProjectCollaborationError('协作加入回执不一致')
  return { version: 1, receipt, snapshot, clientId: collaborationUuid(v.clientId), leaseState: v.leaseState as ProjectCollaborationJoinResult['leaseState'], expiresAt: date(v.expiresAt) }
}
export function parseProjectCollaborationMutationResult(value: unknown): ProjectCollaborationMutationResult {
  const v = collaborationRecord(value); collaborationKeys(v, ['version', 'receipt', 'event', 'snapshot']); assertProjectCollaborationVersion(v.version)
  const receipt = parseProjectCollaborationReceipt(v.receipt), snapshot = parseProjectCollaborationSnapshot(v.snapshot), event = v.event === undefined ? undefined : parseProjectCollaborationEvent(v.event)
  if (receipt.projectId !== snapshot.projectId || event && JSON.stringify(event.receipt) !== JSON.stringify(receipt)) throw new ProjectCollaborationError('协作提交回执与当前工程不一致')
  return { version: 1, receipt, snapshot, ...(event ? { event } : {}) }
}
export function parseProjectCollaborationFeed(value: unknown): ProjectCollaborationFeed {
  bounded(value, projectCollaborationLimits.responseBytes); const v = collaborationRecord(value); assertProjectCollaborationVersion(v.version)
  if (v.state === 'resync-required') {
    collaborationKeys(v, ['version', 'state', 'projectId', 'reason', 'projectVersion']); if (!['external-save', 'epoch-changed', 'history-compacted', 'ended', 'authority-changed', 'shared-unavailable'].includes(String(v.reason))) throw new ProjectCollaborationError('协作重同步原因不正确')
    return { version: 1, state: 'resync-required', projectId: collaborationText(v.projectId, 80), reason: v.reason as Extract<ProjectCollaborationFeed, { state: 'resync-required' }>['reason'], projectVersion: collaborationInteger(v.projectVersion, 1) }
  }
  collaborationKeys(v, ['version', 'state', 'projectId', 'epoch', 'events', 'sequence', 'projectVersion', 'hasMore', 'history', 'presence']); if (v.state !== 'events' || !Array.isArray(v.events) || v.events.length > projectCollaborationLimits.events) throw new ProjectCollaborationError('协作增量流格式不正确')
  const projectId = collaborationText(v.projectId, 80), epoch = collaborationUuid(v.epoch), events = v.events.map(parseProjectCollaborationEvent), sequence = collaborationInteger(v.sequence), projectVersion = collaborationInteger(v.projectVersion, 1)
  if (events.some((e, i) => e.receipt.projectId !== projectId || e.receipt.epoch !== epoch || i > 0 && (e.receipt.sequence !== events[i - 1].receipt.sequence + 1 || e.receipt.previousProjectVersion !== events[i - 1].receipt.projectVersion)) || events.length && (events.at(-1)!.receipt.sequence !== sequence || events.at(-1)!.receipt.projectVersion !== projectVersion)) throw new ProjectCollaborationError('协作增量顺序或工程身份不一致')
  return { version: 1, state: 'events', projectId, epoch, events, sequence, projectVersion, hasMore: boolean(v.hasMore), history: history(v.history), presence: presence(v.presence) }
}
export function parseProjectCollaborationPresenceResult(value: unknown): ProjectCollaborationPresenceResult {
  const v = collaborationRecord(value); collaborationKeys(v, ['version', 'state', 'expiresAt']); assertProjectCollaborationVersion(v.version)
  if (v.state !== 'active' && v.state !== 'left' || (v.state === 'active') !== (v.expiresAt !== undefined)) throw new ProjectCollaborationError('协作在线状态回执不正确')
  return { version: 1, state: v.state, ...(v.expiresAt === undefined ? {} : { expiresAt: date(v.expiresAt) }) }
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)]))
  return value
}
export async function projectCollaborationContentDigest(content: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)); return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}
export function projectCollaborationCanonicalRequest(projectId: string, input: ProjectCollaborationJoinInput | ProjectCollaborationMutationInput): string {
  collaborationText(projectId, 80)
  const parsed = ['join', 'resync'].includes(input.action) ? parseProjectCollaborationJoinInput(input) : parseProjectCollaborationMutationInput(input)
  return JSON.stringify(stable({ domain: 'xingmang-project-collaboration-v1', projectId, input: parsed }))
}
export async function projectCollaborationRequestDigest(projectId: string, input: ProjectCollaborationJoinInput | ProjectCollaborationMutationInput): Promise<string> { return projectCollaborationContentDigest(projectCollaborationCanonicalRequest(projectId, input)) }
