import type { CanvasRunCandidate, CanvasRunNodeState, CanvasRunRecord } from '../host'
import type { WorkflowCandidateRef, WorkflowEdge, WorkflowNodeData } from '../model'

export interface ProjectableCanvasNode {
  id: string
  data: WorkflowNodeData
}

export type NodeResultStagingState = 'pending' | 'accepted' | 'empty'

export function nodeResultStagingState(data: WorkflowNodeData): NodeResultStagingState {
  const hasPendingCandidate = (data.candidates ?? []).some(
    (candidate) => candidate.candidateId !== data.adoptedCandidateId,
  )
  if (hasPendingCandidate) return 'pending'
  return data.result?.assetId ? 'accepted' : 'empty'
}

function nodeStatus(state: CanvasRunNodeState): WorkflowNodeData['status'] {
  if (state === 'queued') return 'queued'
  if (state === 'running' || state === 'cancelling') return 'running'
  if (state === 'succeeded' || state === 'cached') return 'succeeded'
  return 'failed'
}

function uniqueCandidates(record: CanvasRunRecord['nodes'][number]): CanvasRunCandidate[] {
  const seen = new Set<string>()
  const candidates: CanvasRunCandidate[] = []
  for (const attempt of record.attempts) {
    for (const candidate of attempt.candidates) {
      if (seen.has(candidate.candidateId)) continue
      seen.add(candidate.candidateId)
      candidates.push(candidate)
      if (candidates.length === 16) return candidates
    }
  }
  return candidates
}

function projectedError(state: CanvasRunNodeState, errorMessage?: string): string | undefined {
  if (errorMessage) return errorMessage
  if (state === 'skipped') return '上游节点未成功，已跳过'
  if (state === 'cancelled') return '运行已取消'
  if (state === 'interrupted') return '上次运行被应用退出中断'
  return undefined
}

export function projectRunRecordToNodes<T extends ProjectableCanvasNode>(
  nodes: readonly T[],
  run: CanvasRunRecord,
): T[] {
  const records = new Map(run.nodes.map((record) => [record.nodeId, record]))
  return nodes.map((node) => {
    const record = records.get(node.id)
    if (!record) return node
    const latestAttempt = record.attempts.at(-1)
    const candidates = uniqueCandidates(record)
    const existingCandidateId = node.data.adoptedCandidateId
    const adopted = candidates.find((candidate) => candidate.candidateId === existingCandidateId)
    const selectedCandidateId = candidates.some((candidate) => candidate.candidateId === node.data.selectedCandidateId)
      ? node.data.selectedCandidateId
      : candidates[0]?.candidateId
    const errorMessage = projectedError(record.state, record.errorMessage ?? latestAttempt?.errorMessage)
    const costQuota = record.attempts.reduce((total, attempt) => total + (attempt.costQuota ?? 0), 0)
    const terminalSuccess = record.state === 'succeeded' || record.state === 'cached'
    return {
      ...node,
      data: {
        ...node.data,
        status: nodeStatus(record.state),
        ...(record.latestStage ? { runStage: record.latestStage } : {}),
        dirty: !terminalSuccess,
        attemptCount: record.attempts.length,
        ...(latestAttempt ? { latestAttemptDurationMs: latestAttempt.durationMs } : {}),
        ...(errorMessage ? { errorMessage } : { errorMessage: undefined }),
        ...(costQuota > 0 ? { costQuota } : {}),
        ...(candidates.length > 0 ? {
          candidates: candidates.map((candidate) => ({
            candidateId: candidate.candidateId,
            attemptId: candidate.attemptId,
            createdAt: candidate.createdAt,
            asset: { ...candidate.asset },
            ...(candidate.group ? { group: candidate.group } : {}),
            ...(candidate.model ? { model: candidate.model } : {}),
            ...(candidate.costQuota !== undefined ? { costQuota: candidate.costQuota } : {}),
          })),
          candidateAssetIds: candidates.map((candidate) => candidate.asset.assetId),
          selectedCandidateId,
          adoptedCandidateId: adopted?.candidateId ?? node.data.adoptedCandidateId,
          result: adopted ? { ...adopted.asset } : node.data.result,
        } : {}),
      },
    }
  })
}

export function selectNodeCandidate<T extends ProjectableCanvasNode>(
  nodes: readonly T[],
  nodeId: string,
  candidate: string | WorkflowCandidateRef,
): T[] {
  return nodes.map((node) => {
    if (node.id !== nodeId) return node
    const candidateId = typeof candidate === 'string' ? candidate : candidate.candidateId
    const existing = node.data.candidates ?? []
    if (typeof candidate === 'string' && !existing.some((entry) => entry.candidateId === candidateId)) return node
    const candidates = typeof candidate === 'string' || existing.some((entry) => entry.candidateId === candidateId)
      ? existing
      : [...existing, { ...candidate, asset: { ...candidate.asset } }].slice(-16)
    return {
      ...node,
      data: {
        ...node.data,
        candidates,
        candidateAssetIds: candidates.flatMap((entry) => entry.asset.assetId ? [entry.asset.assetId] : []),
        selectedCandidateId: candidateId,
      },
    }
  })
}

export function adoptNodeCandidate<T extends ProjectableCanvasNode>(
  nodes: readonly T[],
  edges: readonly Pick<WorkflowEdge, 'source' | 'target'>[],
  nodeId: string,
  candidateId: string,
): T[] {
  const owner = nodes.find((node) => node.id === nodeId)
  const candidate = owner?.data.candidates?.find((entry) => entry.candidateId === candidateId)
  if (!owner || !candidate) return [...nodes]
  if (owner.data.adoptedCandidateId === candidateId
    && owner.data.result?.assetId === candidate.asset.assetId) return [...nodes]

  const descendants = new Set<string>()
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const edge of edges) {
      if (edge.source !== current || descendants.has(edge.target)) continue
      descendants.add(edge.target)
      queue.push(edge.target)
    }
  }

  return nodes.map((node) => {
    if (node.id === nodeId) {
      return {
        ...node,
        data: {
          ...node.data,
          result: { ...candidate.asset },
          selectedCandidateId: candidateId,
          adoptedCandidateId: candidateId,
          dirty: false,
          status: 'succeeded',
        },
      }
    }
    return descendants.has(node.id)
      ? { ...node, data: { ...node.data, dirty: true } }
      : node
  })
}

export function discardNodeCandidate<T extends ProjectableCanvasNode>(
  nodes: readonly T[],
  nodeId: string,
  candidateId: string,
): T[] {
  return nodes.map((node) => {
    if (node.id !== nodeId || node.data.adoptedCandidateId === candidateId) return node
    const candidates = node.data.candidates ?? []
    if (!candidates.some((candidate) => candidate.candidateId === candidateId)) return node
    const remaining = candidates.filter((candidate) => candidate.candidateId !== candidateId)
    const selectedCandidateId = node.data.selectedCandidateId === candidateId
      ? remaining.find((candidate) => candidate.candidateId === node.data.adoptedCandidateId)?.candidateId
        ?? remaining[0]?.candidateId
      : node.data.selectedCandidateId
    const candidateAssetIds = remaining.flatMap((candidate) => (
      candidate.asset.assetId ? [candidate.asset.assetId] : []
    ))
    return {
      ...node,
      data: {
        ...node.data,
        candidates: remaining,
        ...(candidateAssetIds.length > 0 ? { candidateAssetIds } : { candidateAssetIds: undefined }),
        ...(selectedCandidateId ? { selectedCandidateId } : { selectedCandidateId: undefined }),
      },
    }
  })
}

export function markNodeAndDescendantsDirty<T extends ProjectableCanvasNode>(
  nodes: readonly T[],
  edges: readonly Pick<WorkflowEdge, 'source' | 'target'>[],
  nodeId: string,
  patch: Partial<WorkflowNodeData> = {},
): T[] {
  const affected = new Set<string>([nodeId])
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const edge of edges) {
      if (edge.source !== current || affected.has(edge.target)) continue
      affected.add(edge.target)
      queue.push(edge.target)
    }
  }
  return nodes.map((node) => affected.has(node.id)
    ? { ...node, data: { ...node.data, ...(node.id === nodeId ? patch : {}), dirty: true } }
    : node)
}
