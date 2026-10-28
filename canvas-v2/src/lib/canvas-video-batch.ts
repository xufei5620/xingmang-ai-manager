import type { CanvasRunRecord } from '../host'
import { parseVideoCandidateBatch } from '../runtime/video-candidate-batch'

type RunNode = CanvasRunRecord['nodes'][number]
type RunAttempt = RunNode['attempts'][number]

/** A resumed batch may have a saved prefix and at most one original task. */
export function inspectPendingVideoBatch(node: RunNode, expected: { fingerprint: string; count: number; group: string; model: string; sourceAssetIds: readonly string[] }): { batchId?: string; nextIndex: number; active?: RunAttempt } {
  if (!node.attempts.length) {
    if (node.state !== 'queued') throw new Error('原视频批次缺少尝试记录，请核对原任务；不会重新提交')
    return { nextIndex: 1 }
  }
  if (node.state !== 'running' || node.attempts.length > expected.count) throw new Error('原视频批次状态无法确认，请核对原任务；不会重新提交')
  const batchId = parseVideoCandidateBatch(node.attempts[0].videoBatch)?.batchId
  if (!batchId) throw new Error('原视频批次身份无法确认，请核对原任务；不会重新提交')
  const attemptIds = new Set<string>(), taskIds = new Set<string>()
  let active: RunAttempt | undefined
  for (const [index, attempt] of node.attempts.entries()) {
    const batch = parseVideoCandidateBatch(attempt.videoBatch)
    if (!batch || batch.batchId !== batchId || batch.count !== expected.count || batch.index !== index + 1
      || attempt.fingerprint !== expected.fingerprint || attempt.group !== expected.group || attempt.model !== expected.model
      || JSON.stringify(attempt.inputAssetIds ?? []) !== JSON.stringify(expected.sourceAssetIds) || attemptIds.has(attempt.attemptId)
      || attempt.videoTaskId && taskIds.has(attempt.videoTaskId)) throw new Error('原视频批次输入或任务身份已变化，请核对原任务；不会重新提交')
    attemptIds.add(attempt.attemptId)
    if (attempt.videoTaskId) taskIds.add(attempt.videoTaskId)
    if (attempt.state === 'running' && index === node.attempts.length - 1 && attempt.candidates.length === 0) active = attempt
    else if (attempt.state !== 'succeeded' || !attempt.videoTaskId || attempt.candidates.length !== 1
      || attempt.candidates[0].attemptId !== attempt.attemptId || attempt.candidates[0].asset.kind !== 'video'
      || attempt.candidates[0].asset.taskId !== attempt.videoTaskId) throw new Error('原视频批次有未确认的结果，请核对原任务；不会补交剩余任务')
  }
  return { batchId, nextIndex: active ? node.attempts.length : node.attempts.length + 1, ...(active ? { active } : {}) }
}
