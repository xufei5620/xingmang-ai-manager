import type { CanvasRunCandidate, CanvasRunRecord } from '../host'

type RunNode = CanvasRunRecord['nodes'][number]
type RunAttempt = RunNode['attempts'][number]
export interface ImageCandidateBatch { batchId: string; index: 1 | 2 | 3 | 4; count: 1 | 2 | 3 | 4 }

export function parseImageCandidateBatch(value: unknown): ImageCandidateBatch | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('图片批次记录格式不正确')
  const data = value as Record<string, unknown>
  if (Object.keys(data).some((key) => !['batchId', 'index', 'count'].includes(key)) || typeof data.batchId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.batchId)
    || !Number.isInteger(data.index) || !Number.isInteger(data.count) || Number(data.index) < 1 || Number(data.index) > Number(data.count) || Number(data.count) > 4) throw new Error('图片批次记录格式不正确')
  return { batchId: data.batchId, index: data.index as ImageCandidateBatch['index'], count: data.count as ImageCandidateBatch['count'] }
}

/** Every request keeps its real attempt/receipt identity, including in caches. */
export function latestImageBatchAttempts(attempts: readonly RunAttempt[]): readonly RunAttempt[] {
  const latest = attempts.at(-1)
  if (!latest) return []
  const batch = latest.imageBatch
  return batch ? attempts.filter((attempt) => attempt.imageBatch?.batchId === batch.batchId) : [latest]
}

export function latestImageBatchCandidates(attempts: readonly RunAttempt[]): CanvasRunCandidate[] {
  return latestImageBatchAttempts(attempts).flatMap((attempt) => attempt.candidates)
}

export function completeImageBatchAttempts(node: RunNode, fingerprint: string, count: number): RunAttempt[] | null {
  if (!['succeeded', 'cached'].includes(node.state)) return null
  const attempts = [...latestImageBatchAttempts(node.attempts)]
  if (attempts.length !== count) return null
  const first = attempts[0]
  if (!first) return null
  const ids = new Set<string>()
  const candidateIds = new Set<string>()
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index]
    let batch: ImageCandidateBatch | undefined
    try { batch = parseImageCandidateBatch(attempt.imageBatch) } catch { return null }
    if (!batch || batch.batchId !== first.imageBatch?.batchId || batch.index !== index + 1 || batch.count !== count
      || attempt.fingerprint !== fingerprint || attempt.group !== first.group || attempt.model !== first.model
      || JSON.stringify(attempt.inputAssetIds ?? []) !== JSON.stringify(first.inputAssetIds ?? [])
      || !['succeeded', 'cached'].includes(attempt.state) || !attempt.candidates.length || attempt.candidates.length > 4 || ids.has(attempt.attemptId)) return null
    ids.add(attempt.attemptId)
    for (const candidate of attempt.candidates) {
      if (candidate.attemptId !== attempt.attemptId || candidate.asset.kind !== 'image' || candidateIds.has(candidate.candidateId)) return null
      candidateIds.add(candidate.candidateId)
    }
  }
  return attempts
}
