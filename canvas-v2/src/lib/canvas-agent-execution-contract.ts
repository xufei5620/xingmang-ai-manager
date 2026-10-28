import type { CanvasRunGraph, CanvasRunRecord, CanvasRunScope } from '../host'
import { CanvasAgentError, canvasAgentDigestValue, canvasAgentId, canvasAgentKeys, canvasAgentOperationId, canvasAgentRecord } from './canvas-agent-contract'

export interface CanvasAgentExecutionOrigin { version: 1; sessionId: string; turnId: string; proposalDigest: string }
export interface CanvasAgentExecution {
  version: 1
  id: string
  projectId: string
  origin: CanvasAgentExecutionOrigin
  operationId: string
  requestDigest: string
  targetNodeIds: string[]
  createdAt: string
  state: 'pending' | 'linked'
  runId?: string
  graphRevision?: string
}
export const canvasAgentExecutionRunCapabilities = ['imageEditMaskVersion', 'textWebSearchVersion', 'videoReferenceVersion', 'tileInputVersion', 'colorGradeVersion', 'colorLutVersion', 'colorGradeDetailVersion', 'colorGradePresenceVersion', 'colorGradeCalibrationVersion', 'layerGroupsVersion', 'nodeMediaSourceVersion', 'liquifyVersion', 'documentFrameVersion', 'wholeFilterVersion', 'imageTaskVersion', 'interiorTaskVersion', 'exteriorTaskVersion', 'storyboardTaskVersion', 'videoCandidateVersion', 'videoAudioVersion', 'videoNativeVersion', 'routerStrategyVersion'] as const
export type CanvasAgentExecutionRunInput = { operationId: string; graph: CanvasRunGraph; scope: CanvasRunScope; nodeMediaSourceVersion?: 1 | 2 } & Partial<Record<Exclude<typeof canvasAgentExecutionRunCapabilities[number], 'nodeMediaSourceVersion'>, 1>>
export interface CanvasAgentStartExecutionInput { projectId: string; origin: CanvasAgentExecutionOrigin; operationId: string; run: CanvasAgentExecutionRunInput }
export interface CanvasAgentExecutionTarget { projectId: string; sessionId: string; turnId: string }
export interface CanvasAgentExecutionPage extends CanvasAgentExecutionTarget { items: CanvasAgentExecution[]; total: number; offset: number; limit: number }
export interface CanvasAgentExecutionDetail { execution: CanvasAgentExecution; record?: CanvasRunRecord; mayStillComplete?: boolean }
export interface CanvasAgentExecutionMethodMap {
  startExecution: { input: CanvasAgentStartExecutionInput; result: { execution: CanvasAgentExecution; runId: string; graphRevision: string } }
  listExecutions: { input: CanvasAgentExecutionTarget & { offset?: number; limit?: number }; result: CanvasAgentExecutionPage }
  readExecution: { input: CanvasAgentExecutionTarget & { executionId: string }; result: CanvasAgentExecutionDetail }
  inspectExecution: { input: CanvasAgentStartExecutionInput; result: { state: 'missing' } | ({ state: 'found' } & CanvasAgentExecutionDetail) }
}
export type CanvasAgentExecutionMethod = keyof CanvasAgentExecutionMethodMap
export const canvasAgentExecutionMethods: readonly CanvasAgentExecutionMethod[] = ['startExecution', 'listExecutions', 'readExecution', 'inspectExecution']
export function isCanvasAgentExecutionMethod(value: string): value is CanvasAgentExecutionMethod { return canvasAgentExecutionMethods.includes(value as CanvasAgentExecutionMethod) }
function fail(message = '媒体执行关联回执不正确'): never { throw new CanvasAgentError(message, 502) }
function time(value: unknown): string { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(); return value }
export function parseCanvasAgentExecutionOrigin(value: unknown): CanvasAgentExecutionOrigin {
  const input = canvasAgentRecord(value, '原消息关联')
  canvasAgentKeys(input, ['version', 'sessionId', 'turnId', 'proposalDigest'])
  if (input.version !== 1) throw new CanvasAgentError('此媒体执行关联版本不受支持，请刷新后核对原任务', 409)
  return { version: 1, sessionId: canvasAgentId(input.sessionId), turnId: canvasAgentId(input.turnId), proposalDigest: canvasAgentDigestValue(input.proposalDigest) }
}
export function parseCanvasAgentExecutionTarget(value: unknown): CanvasAgentExecutionTarget {
  const input = canvasAgentRecord(value)
  return { projectId: canvasAgentId(input.projectId), sessionId: canvasAgentId(input.sessionId), turnId: canvasAgentId(input.turnId) }
}
export function parseCanvasAgentStartExecutionInput(value: unknown): CanvasAgentStartExecutionInput {
  const input = canvasAgentRecord(value)
  canvasAgentKeys(input, ['projectId', 'origin', 'operationId', 'run'])
  const run = canvasAgentRecord(input.run, '媒体运行请求')
  canvasAgentKeys(run, ['operationId', 'graph', 'scope', ...canvasAgentExecutionRunCapabilities])
  const operationId = canvasAgentOperationId(input.operationId)
  if (canvasAgentOperationId(run.operationId) !== operationId) throw new CanvasAgentError('媒体运行与关联操作编号不一致', 409)
  for (const key of canvasAgentExecutionRunCapabilities) if (Object.hasOwn(run, key) && run[key] !== 1 && !(key === 'nodeMediaSourceVersion' && run[key] === 2)) throw new CanvasAgentError('媒体运行能力版本不受支持，请刷新后核对原操作', 409)
  const scope = canvasAgentRecord(run.scope, '原消息运行范围')
  canvasAgentKeys(scope, ['kind', 'nodeIds'])
  if (scope.kind !== 'selection' || !Array.isArray(scope.nodeIds) || !scope.nodeIds.length || scope.nodeIds.length > 5_000) throw new CanvasAgentError('原消息媒体运行必须明确选择提案内的目标节点')
  const nodeIds = scope.nodeIds.map((id) => canvasAgentId(id))
  if (new Set(nodeIds).size !== nodeIds.length) throw new CanvasAgentError('媒体执行范围包含重复节点')
  const graph = canvasAgentRecord(run.graph, '媒体工作流')
  canvasAgentKeys(graph, ['nodes', 'edges'])
  if (!Array.isArray(graph.nodes) || graph.nodes.length > 5_000 || !Array.isArray(graph.edges) || graph.edges.length > 20_000) throw new CanvasAgentError('媒体工作流超过可用范围')
  const bytes = new TextEncoder().encode(JSON.stringify(run))
  if (bytes.length > 6 * 1024 * 1024) throw new CanvasAgentError('媒体执行请求超过 6 MB，请拆分工程', 413)
  return { projectId: canvasAgentId(input.projectId), origin: parseCanvasAgentExecutionOrigin(input.origin), operationId, run: { ...run, operationId, graph: JSON.parse(JSON.stringify(graph)) as CanvasRunGraph, scope: { kind: 'selection', nodeIds } } as CanvasAgentExecutionRunInput }
}
export function parseCanvasAgentExecution(value: unknown): CanvasAgentExecution {
  const input = canvasAgentRecord(value, '媒体执行关联')
  canvasAgentKeys(input, ['version', 'id', 'projectId', 'origin', 'operationId', 'requestDigest', 'targetNodeIds', 'createdAt', 'state', 'runId', 'graphRevision'])
  if (input.version !== 1 || !['pending', 'linked'].includes(String(input.state)) || !Array.isArray(input.targetNodeIds) || !input.targetNodeIds.length || input.targetNodeIds.length > 5_000) fail()
  const targetNodeIds = input.targetNodeIds.map((id) => canvasAgentId(id))
  if (new Set(targetNodeIds).size !== targetNodeIds.length || (input.state === 'linked') !== (input.runId !== undefined && input.graphRevision !== undefined) || input.state === 'pending' && (Object.hasOwn(input, 'runId') || Object.hasOwn(input, 'graphRevision'))) fail()
  return { version: 1, id: canvasAgentId(input.id), projectId: canvasAgentId(input.projectId), origin: parseCanvasAgentExecutionOrigin(input.origin), operationId: canvasAgentOperationId(input.operationId), requestDigest: canvasAgentDigestValue(input.requestDigest), targetNodeIds, createdAt: time(input.createdAt), state: input.state as CanvasAgentExecution['state'], ...(input.state === 'linked' ? { runId: canvasAgentId(input.runId), graphRevision: canvasAgentDigestValue(input.graphRevision) } : {}) }
}
