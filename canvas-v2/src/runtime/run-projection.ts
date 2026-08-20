import type { CanvasRunCandidate, CanvasRunNodeState, CanvasRunRecord } from '../host'
import type { WorkflowCandidateRef, WorkflowEdge, WorkflowNodeData } from '../model'

export interface ProjectableCanvasNode {
  id: string
  data: WorkflowNodeData
}

export type NodeResultStagingState = 'accepted' | 'empty'

/**
 * 2026-08-20 产品决策（老板拍板）：每次运行的最新候选自动成为节点产物，
 * 「先候选、后采纳」那一档取消。因此这里只有两种状态：有产物、没产物。
 */
export function nodeResultStagingState(data: WorkflowNodeData): NodeResultStagingState {
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

/** 最近一次真正产出东西的 attempt。失败重试不会抹掉上一次的候选。 */
function latestAttemptCandidates(record: CanvasRunRecord['nodes'][number]): readonly CanvasRunCandidate[] {
  for (let index = record.attempts.length - 1; index >= 0; index -= 1) {
    const candidates = record.attempts[index].candidates
    if (candidates.length > 0) return candidates
  }
  return []
}

/**
 * 自动固定为产物的那个候选。
 *
 * 取最新 attempt 的首个候选，但用户已经在运行检查器里切到同一次 attempt 的
 * 另一个候选时保留他的选择：同一条运行记录会被重复投影（运行终态事件、手动
 * 刷新历史），不能把人刚切过去的产物又拨回来。换了新的 attempt 就一律覆盖。
 */
function autoFixedCandidate(
  record: CanvasRunRecord['nodes'][number],
  data: WorkflowNodeData,
): CanvasRunCandidate | undefined {
  const candidates = latestAttemptCandidates(record)
  return candidates.find((candidate) => candidate.candidateId === data.adoptedCandidateId) ?? candidates[0]
}

/** 传递闭包里的下游节点，不含起点本身。 */
export function downstreamNodeIds(
  sources: Iterable<string>,
  edges: readonly Pick<WorkflowEdge, 'source' | 'target'>[],
): string[] {
  const affected = new Set<string>()
  const queue = [...sources]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const edge of edges) {
      if (edge.source !== current || affected.has(edge.target)) continue
      affected.add(edge.target)
      queue.push(edge.target)
    }
  }
  return [...affected]
}

/**
 * 自动固定产物后需要重新运行的下游节点。
 *
 * 参与了本次运行的节点不算：它们的状态由自己的运行结果决定，而且它们本来就是
 * 拿着这份新产物跑完的。真正会陈旧的是运行范围之外的下游——它们的输入换了，
 * 所以标记 dirty，但绝不自动触发新的付费请求。
 */
export function autoFixedDownstreamNodeIds<T extends ProjectableCanvasNode>(
  nodes: readonly T[],
  run: CanvasRunRecord,
  edges: readonly Pick<WorkflowEdge, 'source' | 'target'>[],
): string[] {
  const records = new Map(run.nodes.map((record) => [record.nodeId, record]))
  const replaced = nodes.flatMap((node) => {
    const record = records.get(node.id)
    if (!record) return []
    const fixed = autoFixedCandidate(record, node.data)
    return fixed && fixed.asset.assetId !== node.data.result?.assetId ? [node.id] : []
  })
  return downstreamNodeIds(replaced, edges).filter((nodeId) => !records.has(nodeId))
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
  edges: readonly Pick<WorkflowEdge, 'source' | 'target'>[] = [],
): T[] {
  const records = new Map(run.nodes.map((record) => [record.nodeId, record]))
  const staleDownstream = new Set(autoFixedDownstreamNodeIds(nodes, run, edges))
  return nodes.map((node) => {
    const record = records.get(node.id)
    if (!record) {
      return staleDownstream.has(node.id) && !node.data.dirty
        ? { ...node, data: { ...node.data, dirty: true } }
        : node
    }
    const latestAttempt = record.attempts.at(-1)
    const candidates = uniqueCandidates(record)
    const fixed = autoFixedCandidate(record, node.data)
    const errorMessage = projectedError(record.state, record.errorMessage ?? latestAttempt?.errorMessage)
    const costQuota = record.attempts.reduce((total, attempt) => total + (attempt.costQuota ?? 0), 0)
    const terminalSuccess = record.state === 'succeeded' || record.state === 'cached'
    const showRunProgress = record.state === 'running' || record.state === 'cancelling'
    const showRunTiming = record.state === 'queued' || showRunProgress
    return {
      ...node,
      data: {
        ...node.data,
        status: nodeStatus(record.state),
        runStartedAt: showRunTiming ? (latestAttempt?.startedAt ?? run.startedAt) : undefined,
        runStage: showRunProgress ? record.latestStage : undefined,
        runProgress: showRunProgress ? record.latestProgress : undefined,
        runProgressMode: showRunProgress ? record.latestProgressMode : undefined,
        runHealth: showRunProgress ? record.latestHealth : undefined,
        // Survives a reload: restoring from history must not silently turn a
        // cache hit into something that looks freshly generated.
        fromCache: record.state === 'cached',
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
          // 全部候选与每一次 attempt 都留在记录里，旧图可以从运行检查器回溯，
          // 这正是「永远自动覆盖产物」能成立的前提。
          selectedCandidateId: fixed?.candidateId ?? node.data.selectedCandidateId,
          adoptedCandidateId: fixed?.candidateId ?? node.data.adoptedCandidateId,
          result: fixed ? { ...fixed.asset } : node.data.result,
        } : {}),
      },
    }
  })
}

/**
 * 切换到别的候选：既是预览也是产物切换。旧模型里选择与采纳是两步，用户看到
 * 一张图却在下游拿到另一张；现在只有一份产物，切过去就是它。
 */
export function selectNodeCandidate<T extends ProjectableCanvasNode>(
  nodes: readonly T[],
  edges: readonly Pick<WorkflowEdge, 'source' | 'target'>[],
  nodeId: string,
  candidate: string | WorkflowCandidateRef,
): T[] {
  const candidateId = typeof candidate === 'string' ? candidate : candidate.candidateId
  const owner = nodes.find((node) => node.id === nodeId)
  if (!owner) return [...nodes]
  const existing = owner.data.candidates ?? []
  if (typeof candidate === 'string' && !existing.some((entry) => entry.candidateId === candidateId)) return [...nodes]
  const staged = typeof candidate === 'string' || existing.some((entry) => entry.candidateId === candidateId)
    ? nodes
    : nodes.map((node) => {
      if (node.id !== nodeId) return node
      const candidates = [...existing, { ...candidate, asset: { ...candidate.asset } }].slice(-16)
      return {
        ...node,
        data: {
          ...node.data,
          candidates,
          candidateAssetIds: candidates.flatMap((entry) => entry.asset.assetId ? [entry.asset.assetId] : []),
        },
      }
    })
  return fixNodeCandidate(staged, edges, nodeId, candidateId)
}

/** 把某个候选定为节点产物，并把下游标记为待重新运行（不自动运行）。 */
export function fixNodeCandidate<T extends ProjectableCanvasNode>(
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

  const descendants = new Set(downstreamNodeIds([nodeId], edges))
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

export function markNodeAndDescendantsDirty<T extends ProjectableCanvasNode>(
  nodes: readonly T[],
  edges: readonly Pick<WorkflowEdge, 'source' | 'target'>[],
  nodeId: string,
  patch: Partial<WorkflowNodeData> = {},
): T[] {
  const affected = new Set(downstreamNodeIds([nodeId], edges))
  affected.add(nodeId)
  return nodes.map((node) => affected.has(node.id)
    ? { ...node, data: { ...node.data, ...(node.id === nodeId ? patch : {}), dirty: true } }
    : node)
}
