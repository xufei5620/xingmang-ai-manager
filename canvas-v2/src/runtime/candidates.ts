export type AttemptStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type RuntimeNodeStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed'
export type RunScope =
  | { kind: 'all' }
  | { kind: 'dirty' }
  | { kind: 'selection'; nodeIds: readonly string[] }
  | { kind: 'to-node'; nodeId: string }

export interface AttemptError {
  code?: string
  message: string
  retryable: boolean
}

export interface AttemptUsage {
  quota?: number
}

export interface NodeAttempt {
  id: string
  runId: string
  nodeId: string
  ordinal: number
  status: AttemptStatus
  requestSnapshot: Readonly<Record<string, unknown>>
  taskId?: string
  candidateIds: readonly string[]
  startedAt?: string
  finishedAt?: string
  error?: AttemptError
  usage?: AttemptUsage
}

export interface Candidate {
  id: string
  nodeId: string
  attemptId: string
  assetId: string
  index: number
  createdAt: string
}

export interface NodeRuntimeState {
  nodeId: string
  status: RuntimeNodeStatus
  dirty: boolean
  latestAttemptId?: string
  selectedCandidateId?: string
}

export interface CandidateState {
  attempts: Readonly<Record<string, NodeAttempt>>
  candidates: Readonly<Record<string, Candidate>>
  nodes: Readonly<Record<string, NodeRuntimeState>>
}

export interface RuntimeEdge {
  source: string
  target: string
}

export interface BeginAttemptInput {
  id: string
  runId: string
  nodeId: string
  requestSnapshot: Readonly<Record<string, unknown>>
  taskId?: string
}

export interface CompleteCandidateInput {
  id: string
  assetId: string
  createdAt: string
}

const maximumIdentifierLength = 256
const maximumErrorMessageLength = 2_000
const maximumCandidatesPerAttempt = 16

function assertIdentifier(value: string, label: string): void {
  if (!value || value.length > maximumIdentifierLength || value.includes('\0')) {
    throw new Error(`${label}无效`)
  }
}

function assertAttemptTransition(attempt: NodeAttempt, allowed: readonly AttemptStatus[]): void {
  if (!allowed.includes(attempt.status)) throw new Error(`任务 ${attempt.id} 已结束，不能再次更新`)
}

function nextOrdinal(state: CandidateState, nodeId: string): number {
  let ordinal = 0
  for (const attempt of Object.values(state.attempts)) {
    if (attempt.nodeId === nodeId) ordinal = Math.max(ordinal, attempt.ordinal)
  }
  return ordinal + 1
}

function runtimeNode(state: CandidateState, nodeId: string): NodeRuntimeState {
  return state.nodes[nodeId] ?? { nodeId, status: 'idle', dirty: true }
}

function terminalStatus(status: AttemptStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

function updateAttempt(
  state: CandidateState,
  attempt: NodeAttempt,
  node: NodeRuntimeState,
  candidates: CandidateState['candidates'] = state.candidates,
): CandidateState {
  return {
    attempts: { ...state.attempts, [attempt.id]: attempt },
    candidates,
    nodes: { ...state.nodes, [node.nodeId]: node },
  }
}

export function createCandidateState(nodeIds: readonly string[] = []): CandidateState {
  const nodes: Record<string, NodeRuntimeState> = {}
  for (const nodeId of nodeIds) {
    assertIdentifier(nodeId, '节点 ID')
    if (nodes[nodeId]) throw new Error(`节点 ID 重复：${nodeId}`)
    nodes[nodeId] = { nodeId, status: 'idle', dirty: true }
  }
  return { attempts: {}, candidates: {}, nodes }
}

export function beginAttempt(state: CandidateState, input: BeginAttemptInput): CandidateState {
  assertIdentifier(input.id, '任务 ID')
  assertIdentifier(input.runId, '运行 ID')
  assertIdentifier(input.nodeId, '节点 ID')
  if (input.taskId !== undefined) assertIdentifier(input.taskId, '异步任务 ID')
  if (state.attempts[input.id]) throw new Error(`任务 ID 重复：${input.id}`)

  const attempt: NodeAttempt = {
    id: input.id,
    runId: input.runId,
    nodeId: input.nodeId,
    ordinal: nextOrdinal(state, input.nodeId),
    status: 'queued',
    requestSnapshot: structuredClone(input.requestSnapshot),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    candidateIds: [],
  }
  const current = runtimeNode(state, input.nodeId)
  return updateAttempt(state, attempt, {
    ...current,
    status: 'queued',
    latestAttemptId: attempt.id,
  })
}

export function startAttempt(state: CandidateState, attemptId: string, startedAt: string): CandidateState {
  const attempt = state.attempts[attemptId]
  if (!attempt) throw new Error(`找不到任务：${attemptId}`)
  assertAttemptTransition(attempt, ['queued'])
  const nextAttempt: NodeAttempt = { ...attempt, status: 'running', startedAt }
  const current = runtimeNode(state, attempt.nodeId)
  return updateAttempt(state, nextAttempt, { ...current, status: 'running' })
}

export function completeAttempt(
  state: CandidateState,
  attemptId: string,
  candidateInputs: readonly CompleteCandidateInput[],
  finishedAt: string,
  usage?: AttemptUsage,
): CandidateState {
  const attempt = state.attempts[attemptId]
  if (!attempt) throw new Error(`找不到任务：${attemptId}`)
  assertAttemptTransition(attempt, ['queued', 'running'])
  if (candidateInputs.length === 0 || candidateInputs.length > maximumCandidatesPerAttempt) {
    throw new Error(`候选结果数量必须为 1-${maximumCandidatesPerAttempt}`)
  }

  const candidates = { ...state.candidates }
  const candidateIds: string[] = []
  candidateInputs.forEach((input, index) => {
    assertIdentifier(input.id, '候选 ID')
    assertIdentifier(input.assetId, '资产 ID')
    if (candidates[input.id]) throw new Error(`候选 ID 重复：${input.id}`)
    candidates[input.id] = {
      id: input.id,
      nodeId: attempt.nodeId,
      attemptId,
      assetId: input.assetId,
      index,
      createdAt: input.createdAt,
    }
    candidateIds.push(input.id)
  })

  const nextAttempt: NodeAttempt = {
    ...attempt,
    status: 'succeeded',
    candidateIds,
    finishedAt,
    ...(usage ? { usage: { ...usage } } : {}),
  }
  const current = runtimeNode(state, attempt.nodeId)
  return updateAttempt(state, nextAttempt, {
    ...current,
    status: 'succeeded',
    dirty: false,
  }, candidates)
}

export function failAttempt(
  state: CandidateState,
  attemptId: string,
  error: AttemptError,
  finishedAt: string,
): CandidateState {
  const attempt = state.attempts[attemptId]
  if (!attempt) throw new Error(`找不到任务：${attemptId}`)
  assertAttemptTransition(attempt, ['queued', 'running'])
  const message = error.message.trim().slice(0, maximumErrorMessageLength) || '生成失败'
  const nextAttempt: NodeAttempt = {
    ...attempt,
    status: 'failed',
    error: { ...error, message },
    finishedAt,
  }
  const current = runtimeNode(state, attempt.nodeId)
  return updateAttempt(state, nextAttempt, { ...current, status: 'failed', dirty: true })
}

export function cancelAttempt(state: CandidateState, attemptId: string, finishedAt: string): CandidateState {
  const attempt = state.attempts[attemptId]
  if (!attempt) throw new Error(`找不到任务：${attemptId}`)
  if (terminalStatus(attempt.status)) return state
  const nextAttempt: NodeAttempt = { ...attempt, status: 'cancelled', finishedAt }
  const current = runtimeNode(state, attempt.nodeId)
  return updateAttempt(state, nextAttempt, { ...current, status: 'idle', dirty: true })
}

export function adoptCandidate(
  state: CandidateState,
  candidateId: string,
  edges: readonly RuntimeEdge[],
): CandidateState {
  const candidate = state.candidates[candidateId]
  if (!candidate) throw new Error(`找不到候选结果：${candidateId}`)
  const attempt = state.attempts[candidate.attemptId]
  if (!attempt || attempt.status !== 'succeeded') throw new Error('只能采纳已完成任务的候选结果')

  const nodes = { ...state.nodes }
  const owner = runtimeNode(state, candidate.nodeId)
  nodes[candidate.nodeId] = {
    ...owner,
    status: 'succeeded',
    dirty: false,
    selectedCandidateId: candidate.id,
  }

  const queue = [candidate.nodeId]
  const visited = new Set<string>(queue)
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const edge of edges) {
      if (edge.source !== current || visited.has(edge.target)) continue
      visited.add(edge.target)
      queue.push(edge.target)
      const downstream = runtimeNode({ ...state, nodes }, edge.target)
      nodes[edge.target] = { ...downstream, dirty: true }
    }
  }
  return { ...state, nodes }
}

export function markNodesDirty(
  state: CandidateState,
  changedNodeIds: readonly string[],
  edges: readonly RuntimeEdge[],
): CandidateState {
  const nodes = { ...state.nodes }
  const queue = [...changedNodeIds]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (visited.has(current)) continue
    visited.add(current)
    const node = runtimeNode({ ...state, nodes }, current)
    nodes[current] = { ...node, dirty: true }
    for (const edge of edges) if (edge.source === current) queue.push(edge.target)
  }
  return { ...state, nodes }
}

export function resolveRunScope(
  state: CandidateState,
  allNodeIds: readonly string[],
  edges: readonly RuntimeEdge[],
  scope: RunScope,
): string[] {
  const all = new Set(allNodeIds)
  if (scope.kind === 'all') return [...all]
  if (scope.kind === 'dirty') return [...all].filter((nodeId) => runtimeNode(state, nodeId).dirty)

  const targets = scope.kind === 'selection' ? scope.nodeIds : [scope.nodeId]
  const selected = new Set<string>()
  const queue = [...targets]
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (!all.has(current) || selected.has(current)) continue
    selected.add(current)
    for (const edge of edges) if (edge.target === current) queue.push(edge.source)
  }
  return allNodeIds.filter((nodeId) => selected.has(nodeId))
}
