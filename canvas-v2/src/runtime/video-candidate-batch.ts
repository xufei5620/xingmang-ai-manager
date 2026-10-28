import type { CanvasRunCandidate, CanvasRunRecord } from '../host'
import { supportsVideoCandidateCount } from './video-candidate-count'

type RunNode = CanvasRunRecord['nodes'][number]
type RunAttempt = RunNode['attempts'][number]
export interface VideoCandidateBatch { batchId: string; index: 1 | 2 | 3 | 4; count: 1 | 2 | 3 | 4 }

export function parseVideoCandidateBatch(value: unknown): VideoCandidateBatch | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('视频批次记录格式不正确')
  const data = value as Record<string, unknown>
  if (Object.keys(data).some((key) => !['batchId', 'index', 'count'].includes(key)) || typeof data.batchId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.batchId)
    || !Number.isInteger(data.index) || !Number.isInteger(data.count) || Number(data.index) < 1 || Number(data.index) > Number(data.count) || Number(data.count) > 4) throw new Error('视频批次记录格式不正确')
  return { batchId: data.batchId, index: data.index as VideoCandidateBatch['index'], count: data.count as VideoCandidateBatch['count'] }
}

/** Preserve every original task/attempt identity when replaying a full batch. */
export function latestVideoBatchAttempts(attempts: readonly RunAttempt[]): readonly RunAttempt[] {
  const latest = attempts.at(-1)
  if (!latest) return []
  const batch = latest.videoBatch
  return batch ? attempts.filter((attempt) => attempt.videoBatch?.batchId === batch.batchId) : [latest]
}

export function latestVideoBatchCandidates(attempts: readonly RunAttempt[]): CanvasRunCandidate[] {
  return latestVideoBatchAttempts(attempts).flatMap((attempt) => attempt.candidates)
}

export function completeVideoBatchAttempts(node: RunNode, fingerprint: string, count: number): RunAttempt[] | null {
  if (!supportsVideoCandidateCount(node.kind) || !['succeeded', 'cached'].includes(node.state)) return null
  const attempts = [...latestVideoBatchAttempts(node.attempts)]
  if (attempts.length !== count) return null
  const first = attempts[0]
  if (!first) return null
  const attemptIds = new Set<string>(), taskIds = new Set<string>(), candidateIds = new Set<string>()
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index]
    let batch: VideoCandidateBatch | undefined
    try { batch = parseVideoCandidateBatch(attempt.videoBatch) } catch { return null }
    if (!batch || batch.batchId !== first.videoBatch?.batchId || batch.index !== index + 1 || batch.count !== count
      || attempt.fingerprint !== fingerprint || attempt.group !== first.group || attempt.model !== first.model
      || JSON.stringify(attempt.inputAssetIds ?? []) !== JSON.stringify(first.inputAssetIds ?? [])
      || !['succeeded', 'cached'].includes(attempt.state) || attempt.candidates.length !== 1 || !attempt.videoTaskId
      || attemptIds.has(attempt.attemptId) || taskIds.has(attempt.videoTaskId)) return null
    const candidate = attempt.candidates[0]
    if (candidate.attemptId !== attempt.attemptId || candidate.asset.kind !== 'video' || candidate.asset.taskId !== attempt.videoTaskId || candidateIds.has(candidate.candidateId)) return null
    attemptIds.add(attempt.attemptId)
    taskIds.add(attempt.videoTaskId)
    candidateIds.add(candidate.candidateId)
  }
  return attempts
}
