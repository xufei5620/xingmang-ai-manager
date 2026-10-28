import type { CanvasAssetSummary, CanvasRunRecord, CanvasRunSummary } from '../host'
import type { RunCollectionReference } from './run-result-collection'
export function collectionAssetId(index = 1): string { return String(index).padStart(43, 'a') }
export function collectionReference(index = 1, runId = 'run-a'): RunCollectionReference { return { assetId: collectionAssetId(index), runId, nodeId: `node-${index}`, attemptId: `attempt-${index}`, candidateId: `candidate-${index}` } }
export function collectionAsset(index = 1, mediaType: 'image' | 'video' | 'audio' = 'image'): CanvasAssetSummary {
  const assetId = collectionAssetId(index)
  const common = { assetId, localUrl: `xingmang-asset://${mediaType}/${assetId}`, thumbnailUrl: `xingmang-asset://${mediaType}/${assetId}`, fileName: `结果${index}`, createdAt: '2026-10-16T00:00:00Z' }
  if (mediaType === 'audio') return { ...common, mediaType, mimeType: 'audio/wav' }
  if (mediaType === 'video') return { ...common, mediaType, mimeType: 'video/mp4', taskId: 'task', width: 640, height: 480 }
  return { ...common, mediaType, mimeType: 'image/png', width: 640, height: 480 }
}
export function collectionRun(runId = 'run-a', indices = [1, 2], projectId = 'project'): CanvasRunRecord {
  const createdAt = '2026-10-16T00:00:00Z'
  return { version: 1, userId: 1, ownerId: 1, projectId, runId, graphRevision: 'graph', scope: { kind: 'all' }, status: 'succeeded', createdAt, startedAt: createdAt, events: [], nodes: indices.map((index) => {
    const reference = collectionReference(index, runId), kind = index % 3 === 0 ? 'audio' as const : index % 3 === 2 ? 'video' as const : 'image' as const
    return { nodeId: reference.nodeId, kind: `${kind}-generate`, state: 'succeeded', attempts: [{ attemptId: reference.attemptId, fingerprint: 'f', state: 'succeeded', startedAt: createdAt, completedAt: createdAt, durationMs: 20, cached: false, candidates: [{ candidateId: reference.candidateId, attemptId: reference.attemptId, createdAt, asset: { kind, assetId: reference.assetId, localUrl: `xingmang-asset://${kind}/${reference.assetId}` } }] }] }
  }) }
}
export function collectionSummary(runId = 'run-a'): CanvasRunSummary { return { runId, projectId: 'project', graphRevision: 'graph', status: 'succeeded', scope: { kind: 'all' }, createdAt: '2026-10-16T00:00:00Z', startedAt: '2026-10-16T00:00:00Z', totalNodes: 2, nodeCounts: { queued: 0, running: 0, cancelling: 0, succeeded: 2, failed: 0, skipped: 0, cancelled: 0, cached: 0, interrupted: 0 }, mayStillComplete: false, cancelRequested: false } }
export function collectionStorage() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } }
export async function settleCollection() { for (let count = 0; count < 16; count++) await Promise.resolve() }
