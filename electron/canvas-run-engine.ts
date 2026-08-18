import { randomUUID as nodeRandomUUID } from 'node:crypto'
import {
  canvasRunContractVersion,
  canvasRunTimelineLimit,
  type CanvasRunAsset,
  type CanvasRunAttempt,
  type CanvasRunCacheEntry,
  type CanvasRunCandidate,
  type CanvasRunEvent,
  type CanvasRunGraph,
  type CanvasRunGraphNode,
  type CanvasRunNodeKind,
  type CanvasRunNodeRecord,
  type CanvasRunNodeStage,
  type CanvasRunNodeState,
  type CanvasRunOutcome,
  type CanvasRunRecord,
  type CanvasRunScope,
  type CanvasRunStatus,
} from './canvas-run-contract'
import { computeCanvasNodeFingerprint } from './canvas-fingerprint'

const DEFAULT_MAX_CONCURRENCY = 2
const MAXIMUM_ERROR_LENGTH = 300
const nonCacheableCanvasNodeKinds = new Set<CanvasRunNodeKind>(['gallery', 'router', 'output'])

export function isCanvasNodeCacheEligible(kind: CanvasRunNodeKind): boolean {
  return !nonCacheableCanvasNodeKinds.has(kind)
}

export interface CanvasNodeInputs {
  text?: string
  image?: CanvasRunAsset
  images?: CanvasRunAsset[]
  video?: CanvasRunAsset
  videos?: CanvasRunAsset[]
  audio?: CanvasRunAsset
  audios?: CanvasRunAsset[]
}

export interface CanvasNodeExecutionResult {
  outputText?: string
  assets?: CanvasRunAsset[]
  costQuota?: number
  group?: string
  model?: string
}

export interface CanvasNodeExecutionContext {
  runId: string
  graphRevision: string
  attemptId: string
  ownerId: number
  userId: number
  projectId?: string
  node: CanvasRunGraphNode
  inputs: CanvasNodeInputs
  signal: AbortSignal
  reportStage?(stage: Extract<CanvasRunNodeStage, 'processing' | 'downloading' | 'saving'>): Promise<void>
}

export type CanvasNodeExecutor = (
  context: CanvasNodeExecutionContext,
) => Promise<CanvasNodeExecutionResult>

export type CanvasNodeExecutors = Record<'text' | 'image' | 'video', CanvasNodeExecutor>
  & Partial<Record<Exclude<CanvasRunNodeKind, 'text' | 'image' | 'video'>, CanvasNodeExecutor>>

function fallbackExecutorKind(kind: CanvasRunNodeKind): 'text' | 'image' | 'video' {
  if (kind === 'prompt' || kind === 'note') return 'text'
  if (kind === 'image-generate' || kind === 'image-edit') return 'image'
  return 'video'
}

export interface CanvasRunEngineOptions {
  userId: number
  ownerId: number
  projectId?: string
  runId: string
  graphRevision: string
  graph: CanvasRunGraph
  scope: CanvasRunScope
  executors: CanvasNodeExecutors
  signal: AbortSignal
  maxConcurrency?: number
  now?: () => Date
  randomUUID?: () => string
  resolveCache?: (fingerprint: string, node: CanvasRunGraphNode) => Promise<CanvasRunCacheEntry | null>
  storeCache?: (entry: CanvasRunCacheEntry) => Promise<void>
  admitRecord?: (record: CanvasRunRecord) => Promise<void>
  persistRecord?: (record: CanvasRunRecord) => Promise<void>
  onEvent?: (event: CanvasRunEvent, record: CanvasRunRecord) => void | Promise<void>
}

interface GraphIndex {
  nodesById: Map<string, CanvasRunGraphNode>
  incoming: Map<string, CanvasRunGraph['edges']>
  outgoing: Map<string, CanvasRunGraph['edges']>
  topological: string[]
}

interface NodeOutput {
  fingerprint: string
  text?: string
  asset?: CanvasRunAsset
}

function collectedInputAssetIds(inputs: CanvasNodeInputs): string[] {
  return [...new Set([
    ...(inputs.images ?? (inputs.image ? [inputs.image] : [])),
    ...(inputs.videos ?? (inputs.video ? [inputs.video] : [])),
    ...(inputs.audios ?? (inputs.audio ? [inputs.audio] : [])),
  ].map((asset) => asset.assetId))].slice(0, 256)
}

interface Semaphore {
  acquire(signal: AbortSignal): Promise<() => void>
}

type CanvasRunEventPayload = CanvasRunEvent extends infer Event
  ? Event extends CanvasRunEvent
    ? Omit<Event, 'version' | 'runId' | 'graphRevision' | 'sequence' | 'at'>
    : never
  : never

function requireIdentifier(value: string, label: string): string {
  if (!value || value.length > 256 || /[\x00-\x1F\x7F]/.test(value)) throw new Error(`${label}格式错误`)
  return value
}

function validateUserId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}格式错误`)
}

function validateGraph(graph: CanvasRunGraph): GraphIndex {
  if (graph.nodes.length > 5_000 || graph.edges.length > 20_000) throw new Error('工作流规模超过安全上限')
  const nodesById = new Map<string, CanvasRunGraphNode>()
  const incoming = new Map<string, CanvasRunGraph['edges']>()
  const outgoing = new Map<string, CanvasRunGraph['edges']>()
  for (const node of graph.nodes) {
    requireIdentifier(node.id, '节点标识')
    if (nodesById.has(node.id)) throw new Error(`工作流包含重复节点标识：${node.id}`)
    if (!Number.isSafeInteger(node.definitionVersion) || node.definitionVersion < 1) {
      throw new Error(`节点定义版本无效：${node.id}`)
    }
    nodesById.set(node.id, node)
  }
  const edgeIds = new Set<string>()
  for (const edge of graph.edges) {
    requireIdentifier(edge.id, '连线标识')
    if (edgeIds.has(edge.id)) throw new Error(`工作流包含重复连线标识：${edge.id}`)
    edgeIds.add(edge.id)
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) {
      throw new Error(`连线引用了不存在的节点：${edge.id}`)
    }
    if (edge.source === edge.target) throw new Error(`工作流包含自连接：${edge.id}`)
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge])
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge])
  }
  const inDegree = new Map(graph.nodes.map((node) => [node.id, incoming.get(node.id)?.length ?? 0]))
  const ready = graph.nodes.filter((node) => inDegree.get(node.id) === 0).map((node) => node.id)
  const topological: string[] = []
  while (ready.length > 0) {
    const current = ready.shift() as string
    topological.push(current)
    for (const edge of outgoing.get(current) ?? []) {
      const remaining = (inDegree.get(edge.target) ?? 0) - 1
      inDegree.set(edge.target, remaining)
      if (remaining === 0) ready.push(edge.target)
    }
  }
  if (topological.length !== graph.nodes.length) throw new Error('工作流中存在循环连接，请先断开成环的连线')
  return { nodesById, incoming, outgoing, topological }
}

function selectScope(index: GraphIndex, scope: CanvasRunScope): Set<string> {
  if (scope.kind === 'all') return new Set(index.topological)
  const roots = scope.kind === 'to-node' ? [scope.nodeId] : scope.nodeIds
  if (roots.length === 0) throw new Error('运行范围不能为空')
  const selected = new Set<string>()
  const queue = [...new Set(roots)]
  while (queue.length > 0) {
    const current = queue.pop() as string
    if (!index.nodesById.has(current)) throw new Error(`运行范围包含不存在的节点：${current}`)
    if (selected.has(current)) continue
    selected.add(current)
    for (const edge of index.incoming.get(current) ?? []) queue.push(edge.source)
  }
  return selected
}

function sanitizeRunError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const sanitized = raw
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[a-z0-9._-]{8,}\b/gi, '[REDACTED]')
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"']+[\\/])+[^\s"']*/g, '[本地路径]')
    .replace(/https?:\/\/\S+/gi, '[远程地址]')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .trim()
  return (sanitized || '节点执行失败').slice(0, MAXIMUM_ERROR_LENGTH)
}

function createSemaphore(limit: number): Semaphore {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error('工作流并发上限无效')
  let active = 0
  const waiters: Array<{
    signal: AbortSignal
    resolve: (release: () => void) => void
    reject: (error: unknown) => void
    onAbort: () => void
  }> = []

  function dispatch(): void {
    while (active < limit && waiters.length > 0) {
      const waiter = waiters.shift()!
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason)
        continue
      }
      active += 1
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        active -= 1
        dispatch()
      })
    }
  }

  return {
    acquire(signal) {
      if (signal.aborted) return Promise.reject(signal.reason)
      return new Promise<() => void>((resolve, reject) => {
        const waiter = {
          signal,
          resolve,
          reject,
          onAbort: () => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            reject(signal.reason)
          },
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
        waiters.push(waiter)
        dispatch()
      })
    },
  }
}

function isTerminalState(state: CanvasRunNodeState): boolean {
  return state === 'succeeded'
    || state === 'failed'
    || state === 'skipped'
    || state === 'cancelled'
    || state === 'cached'
    || state === 'interrupted'
}

function usesRemoteGeneration(kind: CanvasRunNodeKind): boolean {
  return kind === 'image'
    || kind === 'video'
    || kind === 'image-generate'
    || kind === 'image-edit'
    || kind === 'video-generate'
}

export function appendCanvasRunTimelineEvent(
  events: CanvasRunEvent[],
  event: CanvasRunEvent,
  maximum = canvasRunTimelineLimit,
): void {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('画布运行时间线上限无效')
  events.push(event)
  const overflow = events.length - maximum
  if (overflow > 0) events.splice(0, overflow)
}

function runStatus(outcome: CanvasRunOutcome): Exclude<CanvasRunStatus, 'running'> {
  if (outcome.cancelled.length > 0) return 'cancelled'
  if (outcome.failed.length > 0 && outcome.succeeded.length + outcome.cached.length > 0) return 'partial'
  if (outcome.failed.length > 0) return 'failed'
  return 'succeeded'
}

function cloneRecord(record: CanvasRunRecord): CanvasRunRecord {
  return structuredClone(record)
}

function collectInputs(nodeId: string, index: GraphIndex, outputs: Map<string, NodeOutput>): {
  inputs: CanvasNodeInputs
  fingerprintInputs: Array<{
    sourceNodeId: string
    sourceHandle: string
    targetHandle: string
    fingerprint: string
    text?: string
    asset?: CanvasRunAsset
  }>
} {
  const inputs: CanvasNodeInputs = {}
  const images: CanvasRunAsset[] = []
  const videos: CanvasRunAsset[] = []
  const audios: CanvasRunAsset[] = []
  const fingerprintInputs = []
  for (const edge of index.incoming.get(nodeId) ?? []) {
    const output = outputs.get(edge.source)
    if (!output) continue
    if (output.text !== undefined) inputs.text = inputs.text === undefined ? output.text : `${inputs.text}\n${output.text}`
    if (output.asset?.kind === 'image') {
      inputs.image ??= output.asset
      images.push(output.asset)
    }
    if (output.asset?.kind === 'video') {
      inputs.video ??= output.asset
      videos.push(output.asset)
    }
    if (output.asset?.kind === 'audio') {
      inputs.audio ??= output.asset
      audios.push(output.asset)
    }
    fingerprintInputs.push({
      sourceNodeId: edge.source,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      fingerprint: output.fingerprint,
      ...(output.text !== undefined ? { text: output.text } : {}),
      ...(output.asset ? { asset: output.asset } : {}),
    })
  }
  if (images.length > 0) inputs.images = images
  if (videos.length > 0) inputs.videos = videos
  if (audios.length > 0) inputs.audios = audios
  return { inputs, fingerprintInputs }
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export async function executeCanvasRun(options: CanvasRunEngineOptions): Promise<CanvasRunRecord> {
  validateUserId(options.userId, '画布账号标识')
  validateUserId(options.ownerId, '画布窗口标识')
  if (options.projectId) requireIdentifier(options.projectId, '画布项目标识')
  requireIdentifier(options.runId, '运行标识')
  requireIdentifier(options.graphRevision, '工作流版本')
  const index = validateGraph(options.graph)
  const selected = selectScope(index, options.scope)
  const admitted = index.topological.filter((nodeId) => selected.has(nodeId))
  const now = options.now ?? (() => new Date())
  const randomUUID = options.randomUUID ?? nodeRandomUUID
  const startedAt = now()
  const nodeRecords = new Map<string, CanvasRunNodeRecord>(admitted.map((nodeId) => {
    const node = index.nodesById.get(nodeId)!
    return [nodeId, { nodeId, kind: node.kind, state: 'queued', attempts: [] }]
  }))
  const record: CanvasRunRecord = {
    version: canvasRunContractVersion,
    userId: options.userId,
    ownerId: options.ownerId,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    runId: options.runId,
    graphRevision: options.graphRevision,
    scope: structuredClone(options.scope),
    status: 'running',
    createdAt: startedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    nodes: admitted.map((nodeId) => nodeRecords.get(nodeId)!),
    events: [],
  }
  try {
    await options.admitRecord?.(cloneRecord(record))
  } catch (error) {
    throw new Error(`画布运行初始化持久化失败：${sanitizeRunError(error)}`)
  }
  let sequence = 0
  let eventQueue = Promise.resolve()
  let firstPersistenceError: unknown

  function emit(event: CanvasRunEventPayload): Promise<void> {
    const complete = {
      ...event,
      version: canvasRunContractVersion,
      runId: options.runId,
      graphRevision: options.graphRevision,
      sequence: ++sequence,
      at: now().toISOString(),
    } as CanvasRunEvent
    if (complete.type === 'node-stage') {
      const nodeRecord = nodeRecords.get(complete.nodeId)
      if (nodeRecord) {
        nodeRecord.latestStage = complete.stage
        nodeRecord.latestStageAt = complete.at
        nodeRecord.latestStageSequence = complete.sequence
      }
    }
    appendCanvasRunTimelineEvent(record.events, complete)
    const snapshot = cloneRecord(record)
    eventQueue = eventQueue.then(async () => {
      try {
        await options.persistRecord?.(snapshot)
      } catch (error) {
        // A later snapshot contains the complete event stream, including this
        // event. Keep the queue usable so a transient write failure cannot
        // replay a paid executor or suppress every subsequent checkpoint.
        firstPersistenceError ??= error
        return
      }
      try {
        await options.onEvent?.(structuredClone(complete), snapshot)
      } catch {
        // Projection callbacks are best-effort. Execution ownership and the
        // durable event stream must not depend on renderer callback health.
      }
    })
    return eventQueue
  }

  async function updateNode(
    nodeId: string,
    state: CanvasRunNodeState,
    details: Partial<Omit<Extract<CanvasRunEvent, { type: 'node-state' }>, 'type' | 'version' | 'runId' | 'graphRevision' | 'sequence' | 'at' | 'nodeId' | 'state'>> = {},
  ): Promise<boolean> {
    const nodeRecord = nodeRecords.get(nodeId)!
    if (isTerminalState(nodeRecord.state)) return false
    nodeRecord.state = state
    if (details.errorMessage) nodeRecord.errorMessage = details.errorMessage
    await emit({ type: 'node-state', nodeId, state, ...details })
    return true
  }

  async function updateStage(
    nodeId: string,
    stage: CanvasRunNodeStage,
    attemptId?: string,
  ): Promise<boolean> {
    const nodeRecord = nodeRecords.get(nodeId)!
    if (isTerminalState(nodeRecord.state) || nodeRecord.latestStage === stage) return false
    await emit({ type: 'node-stage', nodeId, stage, ...(attemptId ? { attemptId } : {}) })
    return true
  }

  for (const nodeId of admitted) await emit({ type: 'node-state', nodeId, state: 'queued' })

  let cancellationProjection = Promise.resolve()
  const projectCancellation = () => {
    cancellationProjection = Promise.all(record.nodes
      .filter((node) => node.state === 'running')
      .map((node) => updateNode(node.nodeId, 'cancelling')))
      .then(() => undefined)
  }
  options.signal.addEventListener('abort', projectCancellation, { once: true })
  if (options.signal.aborted) projectCancellation()

  const outputs = new Map<string, NodeOutput>()
  const settled = new Map<string, Promise<void>>()
  const semaphore = createSemaphore(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY)

  function upstreamSettled(nodeId: string): Promise<void>[] {
    return (index.incoming.get(nodeId) ?? [])
      .filter((edge) => selected.has(edge.source))
      .map((edge) => settled.get(edge.source) ?? Promise.resolve())
  }

  for (const nodeId of admitted) {
    const node = index.nodesById.get(nodeId)!
    const task = (async () => {
      await Promise.all(upstreamSettled(nodeId))
      await updateStage(nodeId, 'validating')
      if (options.signal.aborted) {
        await updateNode(nodeId, 'cancelled')
        return
      }
      const upstreamRecords = (index.incoming.get(nodeId) ?? [])
        .filter((edge) => selected.has(edge.source))
        .map((edge) => nodeRecords.get(edge.source)!)
      if (upstreamRecords.some((upstream) => upstream.state === 'cancelled' || upstream.state === 'interrupted')) {
        await updateNode(nodeId, 'cancelled')
        return
      }
      if (upstreamRecords.some((upstream) => upstream.state === 'failed' || upstream.state === 'skipped')) {
        await updateNode(nodeId, 'skipped', { errorMessage: '上游节点未成功，已跳过' })
        return
      }
      if (node.disabled) {
        await updateNode(nodeId, 'skipped', { errorMessage: '节点已禁用' })
        return
      }

      const collected = collectInputs(nodeId, index, outputs)
      const inputAssetIds = collectedInputAssetIds(collected.inputs)
      const fingerprint = computeCanvasNodeFingerprint({ projectId: options.projectId, node, upstream: collected.fingerprintInputs })
      await updateStage(nodeId, 'resolving-cache')
      let cached: CanvasRunCacheEntry | null | undefined
      try {
        cached = isCanvasNodeCacheEligible(node.kind) && options.resolveCache
          ? await raceWithAbort(options.resolveCache(fingerprint, node), options.signal)
          : undefined
      } catch {
        if (options.signal.aborted) {
          await updateNode(nodeId, 'cancelled')
          return
        }
        // Cache is an optimization. A damaged or temporarily unavailable
        // cache must not abort an explicitly requested run; proceed as a miss.
        cached = null
      }
      if (cached && (cached.outputText !== undefined || cached.candidate)) {
        const completedAt = now()
        const attempt: CanvasRunAttempt = {
          attemptId: cached.candidate?.attemptId ?? randomUUID(),
          fingerprint,
          state: 'cached',
          startedAt: completedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs: 0,
          cached: true,
          ...(inputAssetIds.length > 0 ? { inputAssetIds } : {}),
          candidates: cached.candidate ? [structuredClone(cached.candidate)] : [],
          ...(cached.outputText !== undefined ? { outputText: cached.outputText } : {}),
          ...(cached.candidate?.costQuota !== undefined ? { costQuota: cached.candidate.costQuota } : {}),
          ...(cached.candidate?.group ? { group: cached.candidate.group } : {}),
          ...(cached.candidate?.model ? { model: cached.candidate.model } : {}),
        }
        nodeRecords.get(nodeId)!.attempts.push(attempt)
        outputs.set(nodeId, {
          fingerprint,
          ...(cached.outputText !== undefined ? { text: cached.outputText } : {}),
          ...(cached.candidate ? { asset: cached.candidate.asset } : {}),
        })
        await updateNode(nodeId, 'cached', {
          attemptId: attempt.attemptId,
          fingerprint,
          ...(cached.candidate ? { candidateIds: [cached.candidate.candidateId] } : {}),
        })
        return
      }

      let release: (() => void) | undefined
      try {
        await updateStage(nodeId, 'waiting-slot')
        release = await semaphore.acquire(options.signal)
      } catch {
        await updateNode(nodeId, 'cancelled')
        return
      }
      const attemptId = randomUUID()
      const attemptStartedAt = now()
      await updateNode(nodeId, 'running', { attemptId, fingerprint })
      try {
        const executor = options.executors[node.kind] ?? options.executors[fallbackExecutorKind(node.kind)]
        if (usesRemoteGeneration(node.kind)) await updateStage(nodeId, 'submitting', attemptId)
        let releaseStageReporting!: () => void
        const stageReportingReady = new Promise<void>((resolve) => { releaseStageReporting = resolve })
        const executorPromise = executor({
          runId: options.runId,
          graphRevision: options.graphRevision,
          attemptId,
          ownerId: options.ownerId,
          userId: options.userId,
          projectId: options.projectId,
          node,
          inputs: collected.inputs,
          signal: options.signal,
          reportStage: async (stage) => {
            await stageReportingReady
            await updateStage(nodeId, stage, attemptId)
          },
        })
        await updateStage(nodeId, 'processing', attemptId)
        releaseStageReporting()
        const result = await raceWithAbort(executorPromise, options.signal)
        if (options.signal.aborted || isTerminalState(nodeRecords.get(nodeId)!.state)) return
        const completedAt = now()
        const candidates: CanvasRunCandidate[] = (result.assets ?? []).map((asset) => ({
          candidateId: randomUUID(),
          attemptId,
          createdAt: completedAt.toISOString(),
          asset: structuredClone(asset),
          ...(result.group ? { group: result.group } : {}),
          ...(result.model ? { model: result.model } : {}),
          ...(result.costQuota !== undefined ? { costQuota: result.costQuota } : {}),
        }))
        const attempt: CanvasRunAttempt = {
          attemptId,
          fingerprint,
          state: 'succeeded',
          startedAt: attemptStartedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs: Math.max(0, completedAt.getTime() - attemptStartedAt.getTime()),
          cached: false,
          ...(inputAssetIds.length > 0 ? { inputAssetIds } : {}),
          candidates,
          ...(result.outputText !== undefined ? { outputText: result.outputText } : {}),
          ...(result.costQuota !== undefined ? { costQuota: result.costQuota } : {}),
          ...(result.group ? { group: result.group } : {}),
          ...(result.model ? { model: result.model } : {}),
        }
        nodeRecords.get(nodeId)!.attempts.push(attempt)
        outputs.set(nodeId, {
          fingerprint,
          ...(result.outputText !== undefined ? { text: result.outputText } : {}),
          ...(candidates[0] ? { asset: candidates[0].asset } : {}),
        })
        try {
          if (isCanvasNodeCacheEligible(node.kind)) {
            await options.storeCache?.({
              version: canvasRunContractVersion,
              fingerprint,
              nodeKind: node.kind,
              ...(candidates[0] ? { candidate: candidates[0] } : {}),
              ...(result.outputText !== undefined ? { outputText: result.outputText } : {}),
              createdAt: completedAt.toISOString(),
              lastUsedAt: completedAt.toISOString(),
            })
          }
        } catch {
          // Cache availability never changes the result of paid work. The
          // terminal run record still retains its owned asset candidates.
        }
        await updateNode(nodeId, 'succeeded', {
          attemptId,
          fingerprint,
          candidateIds: candidates.map((candidate) => candidate.candidateId),
          ...(result.costQuota !== undefined ? { costQuota: result.costQuota } : {}),
        })
      } catch (error) {
        if (options.signal.aborted) {
          const completedAt = now()
          nodeRecords.get(nodeId)!.attempts.push({
            attemptId,
            fingerprint,
            state: 'cancelled',
            startedAt: attemptStartedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            durationMs: Math.max(0, completedAt.getTime() - attemptStartedAt.getTime()),
            cached: false,
            ...(inputAssetIds.length > 0 ? { inputAssetIds } : {}),
            candidates: [],
            ...(node.data.group ? { group: node.data.group } : {}),
            ...(node.data.model ? { model: node.data.model } : {}),
          })
          await updateNode(nodeId, 'cancelled', { attemptId, fingerprint })
        } else {
          const errorMessage = sanitizeRunError(error)
          const completedAt = now()
          nodeRecords.get(nodeId)!.attempts.push({
            attemptId,
            fingerprint,
            state: 'failed',
            startedAt: attemptStartedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            durationMs: Math.max(0, completedAt.getTime() - attemptStartedAt.getTime()),
            cached: false,
            ...(inputAssetIds.length > 0 ? { inputAssetIds } : {}),
            candidates: [],
            errorMessage,
            ...(node.data.group ? { group: node.data.group } : {}),
            ...(node.data.model ? { model: node.data.model } : {}),
          })
          await updateNode(nodeId, 'failed', { attemptId, fingerprint, errorMessage })
        }
      } finally {
        release?.()
      }
    })()
    settled.set(nodeId, task)
  }

  await Promise.all(settled.values())
  await cancellationProjection
  options.signal.removeEventListener('abort', projectCancellation)
  const outcome: CanvasRunOutcome = {
    succeeded: record.nodes.filter((node) => node.state === 'succeeded').map((node) => node.nodeId),
    failed: record.nodes.filter((node) => node.state === 'failed').map((node) => node.nodeId),
    skipped: record.nodes.filter((node) => node.state === 'skipped').map((node) => node.nodeId),
    cancelled: record.nodes.filter((node) => node.state === 'cancelled').map((node) => node.nodeId),
    cached: record.nodes.filter((node) => node.state === 'cached').map((node) => node.nodeId),
  }
  const completedAt = now()
  record.status = runStatus(outcome)
  record.completedAt = completedAt.toISOString()
  record.durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime())
  record.outcome = outcome
  await emit({ type: 'run-terminal', status: record.status, outcome })
  await eventQueue
  if (firstPersistenceError !== undefined) {
    throw new Error(`画布运行记录持久化失败：${sanitizeRunError(firstPersistenceError)}`)
  }
  return cloneRecord(record)
}

export function canvasRunDescendants(graph: CanvasRunGraph, nodeIds: readonly string[]): string[] {
  const index = validateGraph(graph)
  const descendants = new Set<string>()
  const queue = [...nodeIds]
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (!index.nodesById.has(current)) throw new Error(`节点不存在：${current}`)
    for (const edge of index.outgoing.get(current) ?? []) {
      if (descendants.has(edge.target)) continue
      descendants.add(edge.target)
      queue.push(edge.target)
    }
  }
  return index.topological.filter((nodeId) => descendants.has(nodeId))
}
