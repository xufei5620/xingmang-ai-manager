import type { CanvasRunNodeState, CanvasRunStatus } from '../host'
import { maximumProjectContentBytes, utf8ByteLength } from './canvas-limits'

export const maximumAssetOriginResponseBytes = 8 * 1024 * 1024
export type CanvasAssetOriginUnavailableCode = 'no-origin' | 'asset-removed' | 'origin-unavailable' | 'project-unavailable'
export interface CanvasAssetOriginProject {
  id: string; name: string; version: number; content: string; createdAt: string; updatedAt: string; lastOpenedAt: string
}
export interface CanvasAssetOriginRunSnapshot {
  runId: string; graphRevision: string; status: CanvasRunStatus; createdAt: string; updatedAt: string
  nodeState: CanvasRunNodeState; attemptId: string; attemptState: CanvasRunNodeState; candidateId: string
  prompt: string; model: string
  asset: { kind: 'image' | 'video' | 'audio'; assetId: string; localUrl: string; mimeType?: string; width?: number; height?: number; durationSeconds?: number }
}
export type CanvasAssetOriginResult =
  | { version: 1; assetId: string; state: 'unavailable'; code: CanvasAssetOriginUnavailableCode; reason: string }
  | { version: 1; assetId: string; state: 'available'; project: CanvasAssetOriginProject; node: { id: string; kind: string; current: 'present' | 'missing' }; run?: CanvasAssetOriginRunSnapshot }

export class AssetOriginError extends Error {
  constructor(message: string, readonly status = 503) { super(message); this.name = 'AssetOriginError' }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssetOriginError('素材来源信息格式不正确')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new AssetOriginError('素材来源信息包含不支持的字段')
}
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || value.length > limit || !empty && !value) throw new AssetOriginError('素材来源信息不完整')
  return value
}
function id(value: unknown): string {
  const result = text(value, 128)
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new AssetOriginError('素材来源编号不正确')
  return result
}
export function parseAssetOriginAssetId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new AssetOriginError('素材编号格式错误', 400)
  return value
}
function time(value: unknown): string {
  const result = text(value, 64)
  if (!Number.isFinite(Date.parse(result))) throw new AssetOriginError('素材来源时间不正确')
  return result
}
function state(value: unknown): CanvasRunNodeState {
  if (!['queued', 'running', 'cancelling', 'succeeded', 'failed', 'skipped', 'cancelled', 'cached', 'interrupted'].includes(String(value))) throw new AssetOriginError('素材来源状态不正确')
  return value as CanvasRunNodeState
}
export function parseCanvasAssetOrigin(value: unknown, expectedAssetId: string): CanvasAssetOriginResult {
  const raw = record(value), assetId = parseAssetOriginAssetId(raw.assetId)
  if (raw.version !== 1 || assetId !== parseAssetOriginAssetId(expectedAssetId)) throw new AssetOriginError('素材来源版本或编号不一致')
  if (raw.state === 'unavailable') {
    keys(raw, ['version', 'assetId', 'state', 'code', 'reason'])
    if (!['no-origin', 'asset-removed', 'origin-unavailable', 'project-unavailable'].includes(String(raw.code))) throw new AssetOriginError('素材来源不可用状态不正确')
    return { version: 1, assetId, state: 'unavailable', code: raw.code as CanvasAssetOriginUnavailableCode, reason: text(raw.reason, 500) }
  }
  if (raw.state !== 'available') throw new AssetOriginError('素材来源状态不正确')
  keys(raw, ['version', 'assetId', 'state', 'project', 'node', 'run'])
  const p = record(raw.project), n = record(raw.node)
  keys(p, ['id', 'name', 'version', 'content', 'createdAt', 'updatedAt', 'lastOpenedAt']); keys(n, ['id', 'kind', 'current'])
  if (!Number.isSafeInteger(p.version) || Number(p.version) < 1 || typeof p.content !== 'string' || utf8ByteLength(p.content) > maximumProjectContentBytes || !['present', 'missing'].includes(String(n.current))) throw new AssetOriginError('原工程快照不完整')
  const project: CanvasAssetOriginProject = { id: id(p.id), name: text(p.name, 256), version: Number(p.version), content: p.content, createdAt: time(p.createdAt), updatedAt: time(p.updatedAt), lastOpenedAt: time(p.lastOpenedAt) }
  const node = { id: id(n.id), kind: id(n.kind), current: n.current as 'present' | 'missing' }
  if (raw.run === undefined) return { version: 1, assetId, state: 'available', project, node }
  const r = record(raw.run), a = record(r.asset)
  keys(r, ['runId', 'graphRevision', 'status', 'createdAt', 'updatedAt', 'nodeState', 'attemptId', 'attemptState', 'candidateId', 'prompt', 'model', 'asset'])
  keys(a, ['kind', 'assetId', 'localUrl', 'mimeType', 'width', 'height', 'durationSeconds'])
  if (!['running', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted'].includes(String(r.status)) || typeof r.graphRevision !== 'string' || !/^[0-9a-f]{64}$/.test(r.graphRevision) || !['image', 'video', 'audio'].includes(String(a.kind)) || a.assetId !== assetId || a.localUrl !== `xingmang-asset://${a.kind}/${assetId}`) throw new AssetOriginError('原尝试素材快照不一致')
  const asset: CanvasAssetOriginRunSnapshot['asset'] = { kind: a.kind as 'image' | 'video' | 'audio', assetId, localUrl: a.localUrl as string }
  if (a.mimeType !== undefined) asset.mimeType = text(a.mimeType, 80)
  for (const k of ['width', 'height', 'durationSeconds'] as const) if (a[k] !== undefined) {
    const value = a[k]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || k !== 'durationSeconds' && (!Number.isSafeInteger(value) || value > 16384)) throw new AssetOriginError('原尝试素材尺寸不正确')
    asset[k] = value
  }
  const run: CanvasAssetOriginRunSnapshot = { runId: id(r.runId), graphRevision: r.graphRevision, status: r.status as CanvasRunStatus, createdAt: time(r.createdAt), updatedAt: time(r.updatedAt), nodeState: state(r.nodeState), attemptId: id(r.attemptId), attemptState: state(r.attemptState), candidateId: text(r.candidateId, 200), prompt: text(r.prompt, 100000, true), model: text(r.model, 256, true), asset }
  return { version: 1, assetId, state: 'available', project, node, run }
}
