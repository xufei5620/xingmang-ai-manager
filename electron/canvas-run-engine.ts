import { randomUUID as nodeRandomUUID } from 'node:crypto'
import {
  canvasRunContractVersion,
  canvasRunImageToolNodeLabels,
  canvasRunKernelOnlyNodeLabels,
  canvasRunTimelineLimit,
  type CanvasRunAsset,
  type CanvasRunAttempt,
  type CanvasRunCacheEntry,
  type CanvasRunCandidate,
  type CanvasRunEvent,
  type CanvasFramePreparation,
  type CanvasImagePreparation,
  type CanvasRunGraph,
  type CanvasRunGraphNode,
  type CanvasRunImageBatch,
  type CanvasRunImageCandidateCount,
  type CanvasRunNodeKind,
  type CanvasRunNodeRecord,
  type CanvasRunNodeStage,
  type CanvasRunNodeState,
  type CanvasRunOutcome,
  type CanvasRunRecord,
  type CanvasRunScope,
  type CanvasRunStatus,
} from './canvas-run-contract'
import { canvasImageCandidateCacheKey, computeCanvasNodeFingerprint } from './canvas-fingerprint'
import { canvasImageTransformKindForNode, type CanvasImageToolSource } from './canvas-image-tools'
import type { AiRelayBillingObserver } from './ai-operation-progress'
import { createCanvasRelayBillingRecorder, type CanvasRelayBillingRecorder } from './canvas-run-charges'

const DEFAULT_MAX_CONCURRENCY = 20
const MAXIMUM_ERROR_LENGTH = 300
// 剧本的角色、场景、道具节点读的是用户当前绑定的图，本身不花钱。它们的指纹不含
// 绑定的图，换图后命中缓存会一直交出旧图（#541）。这里让它们每次都重读，而不是
// 把绑定的图加进指纹：改指纹会让升级后所有下游节点的缓存一起失效、整批重跑重复扣费。
// 下游指纹本来就含上游交出的图，图没换时下游照常命中缓存。
const nonCacheableCanvasNodeKinds = new Set<CanvasRunNodeKind>([
  'gallery', 'router', 'output', 'drama-character', 'drama-scene', 'drama-prop',
])

export function isCanvasNodeCacheEligible(kind: CanvasRunNodeKind): boolean {
  return !nonCacheableCanvasNodeKinds.has(kind)
}

// 生成类节点把画布上正在用的那张图放在 adoptedAssetId 里交过来，但指纹有意不含它
// （canvas-fingerprint.ts），同一指纹的缓存又只留最新一条；指纹还含项目编号，复制出来的
// 项目永远查不到原项目的缓存。于是切回旧候选后下游拿到的是最新那张，副本里一运行就整批
// 重新付费，而画布确认框写的是「复用」（O04、O06）。这几类节点先认画布上那张图。
function reusesAdoptedAsset(kind: CanvasRunNodeKind): boolean {
  return kind === 'image'
    || kind === 'video'
    || kind === 'image-generate'
    || kind === 'image-edit'
    || kind === 'video-generate'
}

// 画布上那张图能不能证明是按现在的输入生成的。证明只能来自运行记录（只留最近
// 100 次），记录被挤掉或读不出来时，缓存里那张未必就是客户选的那张（O06）。
type AdoptedAssetProof =
  | { state: 'proven'; entry: CanvasRunCacheEntry }
  // Every remembered attempt that made it ran under other inputs: the shown
  // result is out of date, so the ordinary cache or a new run is the answer.
  | { state: 'outdated' }
  // Nothing remembered says which inputs made it.
  | { state: 'unproven' }

// 选的是 A、缓存里是 B、又证明不了 A 时，宁可停下也不拿 B 往下游交：画面上显示的
// 是 A，下游悄悄用 B，客户看不出来。这一步什么都没提交，所以不扣费。
// What a multi-image node does in this run: replay and send the batch, reuse
// the image the canvas shows, or stop before any request.
type ImageBatchPlan =
  | { kind: 'cancelled' }
  | { kind: 'failed'; errorMessage: string }
  // remember: also cache it as request 1, which is safe only when every other
  // request is already cached (otherwise the next run would send the rest
  // while the canvas says it reuses the image).
  | { kind: 'adopted'; entry: CanvasRunCacheEntry; remember: boolean }
  | { kind: 'batch'; hits: Map<CanvasRunImageCandidateCount, CanvasRunCacheEntry> }

function unprovenAdoptedAssetMessage(kind: CanvasRunNodeKind): string {
  return kind === 'video' || kind === 'video-generate'
    ? '找不到你选中的这段视频当初的生成记录，没法确认它跟现在的设置对得上，所以这个节点先停下了，没有扣费。想接着用，请换选这个节点最新生成的那段；想要新视频，在这个节点上点「运行到此」重新生成（会扣费）。'
    : '找不到你选中的这张图当初的生成记录，没法确认它跟现在的设置对得上，所以这个节点先停下了，没有扣费。想接着用，请换选这个节点最新生成的那张；想要新图，在这个节点上点「运行到此」重新生成（会扣费）。'
}

/**
 * One earlier attempt that produced or reused an asset: the fingerprint that
 * attempt ran under, and the project that fingerprint was computed for.
 */
export interface CanvasRunAssetOrigin {
  fingerprint: string
  projectId?: string
  candidate: CanvasRunCandidate
  outputText?: string
}

export interface CanvasNodeInputs {
  text?: string
  image?: CanvasRunAsset
  images?: CanvasRunAsset[]
  /**
   * The same pictures as images, each named by the connection it came over
   * (画布完善第 7 条第三步): a collage orders them and a tile picks one the
   * way the kernel names them.
   */
  imageSources?: CanvasImageToolSource<CanvasRunAsset>[]
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
  /** Hand to every paid request this attempt makes; the run's 实扣 is matched by what it records. */
  billing?: AiRelayBillingObserver
  reportStage?(
    stage: Extract<CanvasRunNodeStage, 'processing' | 'downloading' | 'saving'>,
    progress?: { value?: number; mode?: 'determinate' | 'indeterminate'; health?: 'normal' | 'delayed' },
  ): Promise<void>
  /**
   * Tells the page a frame is (waiting true) or no longer is (false) waiting
   * for it to decode (画布完善第 7 条第二步). Each change goes out as a
   * run-waiting event with every frame the run still waits on.
   */
  reportFramePreparation?(preparation: CanvasFramePreparation, waiting: boolean): Promise<void>
  /** The same for the pictures an image-tool node asks the page to make (第三步). */
  reportImagePreparation?(preparation: CanvasImagePreparation, waiting: boolean): Promise<void>
}

export type CanvasNodeExecutor = (
  context: CanvasNodeExecutionContext,
) => Promise<CanvasNodeExecutionResult>

export type CanvasNodeExecutors = Record<'text' | 'image' | 'video', CanvasNodeExecutor>
  & Partial<Record<Exclude<CanvasRunNodeKind, 'text' | 'image' | 'video'>, CanvasNodeExecutor>>

function isCanvasRunKernelOnlyNodeKind(kind: CanvasRunNodeKind): boolean {
  return Object.prototype.hasOwnProperty.call(canvasRunKernelOnlyNodeLabels, kind)
}

function isCanvasRunImageToolNodeKind(kind: CanvasRunNodeKind): kind is keyof typeof canvasRunImageToolNodeLabels {
  return Object.prototype.hasOwnProperty.call(canvasRunImageToolNodeLabels, kind)
}

/**
 * The run file keeps a waiting event without its image preparations: a layer
 * recipe can be hundreds of KB and every change resends the whole list, while
 * the file has 8 MB for all runs. The page gets the full event; a reloaded
 * page reads the list from the run service, which holds it in memory.
 */
function timelineEvent(event: CanvasRunEvent): CanvasRunEvent {
  if (event.type !== 'run-waiting' || event.imagePreparations === undefined) return event
  const { imagePreparations: _imagePreparations, ...rest } = event
  return rest
}

/**
 * A frame-extract node has its own executor or none: falling back to the
 * video executor would turn a local frame into a paid video request.
 */
function executorFor(executors: CanvasNodeExecutors, kind: CanvasRunNodeKind): CanvasNodeExecutor {
  if (kind === 'frame-extract') {
    const executor = executors['frame-extract']
    if (!executor) throw new Error('「视频抽帧」节点桌面版暂不支持，本次没有提交任何付费请求')
    return executor
  }
  // Same for image tools: a crop is made on the page, never by a paid video request.
  if (isCanvasRunImageToolNodeKind(kind)) {
    const executor = executors[kind]
    if (!executor) throw new Error(`「${canvasRunImageToolNodeLabels[kind]}」节点桌面版暂不支持，本次没有提交任何付费请求`)
    return executor
  }
  return executors[kind] ?? executors[fallbackExecutorKind(kind)]
}

function fallbackExecutorKind(kind: CanvasRunNodeKind): 'text' | 'image' | 'video' {
  if (kind === 'prompt' || kind === 'note' || kind === 'drama-bible' || kind === 'drama-script' || kind === 'drama-parse' || kind === 'drama-shot' || kind === 'text-generate') return 'text'
  if (kind === 'image-generate' || kind === 'image-edit' || kind === 'drama-character' || kind === 'drama-scene' || kind === 'drama-prop') return 'image'
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
  resolveAssetOrigin?: (
    assetId: string,
    matches: (origin: CanvasRunAssetOrigin) => boolean,
  ) => Promise<CanvasRunAssetOrigin | null>
  admitRecord?: (record: CanvasRunRecord) => Promise<void>
  persistRecord?: (record: CanvasRunRecord) => Promise<void>
  /**
   * Saves a snapshot whose only news is a stage or progress change, or the
   * opening `queued` entries. It may keep the snapshot in memory for a while;
   * leaving it out sends these through `persistRecord` like everything else.
   */
  persistProgress?: (record: CanvasRunRecord) => Promise<void>
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
  /** What a single-picture connection hands on: the candidate the canvas shows. */
  asset?: CanvasRunAsset
  /**
   * Present when the node made more than one: all of them in the order they
   * were made, whichever is shown. A batch connection (a grid split's
   * out:images) hands these on.
   */
  assets?: CanvasRunAsset[]
}

/** The grid split's port that hands on every slice (xingmang-canvas builtin-node-definitions.ts). */
const batchImageHandle = 'out:images'

/**
 * xingmang-canvas lib/canvas-runs.ts buildPreferredRunCandidates, for image
 * tools: the picture the canvas shows first (the adopted one, else for a grid
 * split the selected slice), then the rest in their order. Only candidates
 * this node made are eligible, so a stale or forged choice names nothing else.
 */
function preferredImageToolCandidates(node: CanvasRunGraphNode, candidates: CanvasRunCandidate[]): CanvasRunCandidate[] {
  if (!isCanvasRunImageToolNodeKind(node.kind)) return candidates
  const adopted = node.data.adoptedAssetId ? candidates.findIndex((candidate) => candidate.asset.assetId === node.data.adoptedAssetId) : -1
  const selected = adopted >= 0 ? adopted : candidates.findIndex((candidate) => candidate.outputIndex === (node.data.imageOutputIndex ?? 0))
  if (selected <= 0) return candidates
  return [candidates[selected], ...candidates.slice(0, selected), ...candidates.slice(selected + 1)]
}

function nodeOutputAssets(candidates: readonly CanvasRunCandidate[]): Pick<NodeOutput, 'asset' | 'assets'> {
  if (candidates.length === 0) return {}
  if (candidates.length === 1) return { asset: candidates[0].asset }
  const made = candidates.every((candidate) => candidate.outputIndex !== undefined)
    ? [...candidates].sort((left, right) => (left.outputIndex as number) - (right.outputIndex as number))
    : candidates
  return { asset: candidates[0].asset, assets: made.map((candidate) => candidate.asset) }
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
  const roots = scope.kind === 'to-node' || scope.kind === 'from-node' ? [scope.nodeId] : scope.nodeIds
  if (roots.length === 0) throw new Error('运行范围不能为空')
  for (const root of new Set(roots)) {
    if (!index.nodesById.has(root)) throw new Error(`运行范围包含不存在的节点：${root}`)
  }
  const selected = new Set<string>()
  const queue = [...new Set(roots)]
  if (scope.kind === 'from-node') {
    while (queue.length > 0) {
      const current = queue.pop() as string
      if (selected.has(current)) continue
      selected.add(current)
      for (const edge of index.outgoing.get(current) ?? []) queue.push(edge.target)
    }
    const dependencies = [...selected]
    while (dependencies.length > 0) {
      const current = dependencies.pop() as string
      for (const edge of index.incoming.get(current) ?? []) {
        if (selected.has(edge.source)) continue
        selected.add(edge.source)
        dependencies.push(edge.source)
      }
    }
    return selected
  }
  while (queue.length > 0) {
    const current = queue.pop() as string
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
    || kind === 'drama-parse'
    || kind === 'text-generate'
}

/**
 * How many independent requests this node sends: 2-4 for an image node whose
 * count the parser passed on, otherwise one. Each request asks for one image.
 */
export function canvasRunImageCandidateCount(node: CanvasRunGraphNode): CanvasRunImageCandidateCount {
  const count = node.data.imageCandidateCount
  if ((node.kind !== 'image' && node.kind !== 'image-generate' && node.kind !== 'image-edit') || count === undefined) return 1
  return count === 2 || count === 3 || count === 4 ? count : 1
}

function imageCandidateIndexes(count: CanvasRunImageCandidateCount): CanvasRunImageCandidateCount[] {
  return ([1, 2, 3, 4] as const).filter((index) => index <= count)
}

// 一组没出齐时节点上的那句话。没出来的那几张各自的原因留在各自的记录里，
// 这里只带第一条，免得一句话太长。
export function canvasImageBatchFailureMessage(count: number, succeeded: number, reason: string): string {
  const message = succeeded === 0
    ? `这次要出 ${count} 张，一张都没出来：${reason}`
    : `这次要出 ${count} 张，出来 ${succeeded} 张，${count - succeeded} 张没出来：${reason}`
  return message.slice(0, MAXIMUM_ERROR_LENGTH)
}

function cachedAttempt(
  entry: CanvasRunCacheEntry,
  fingerprint: string,
  attemptId: string,
  inputAssetIds: string[],
  at: Date,
  imageBatch?: CanvasRunImageBatch,
): CanvasRunAttempt {
  return {
    attemptId,
    fingerprint,
    state: 'cached',
    startedAt: at.toISOString(),
    completedAt: at.toISOString(),
    durationMs: 0,
    cached: true,
    ...(inputAssetIds.length > 0 ? { inputAssetIds } : {}),
    candidates: entry.candidates ? structuredClone(entry.candidates) : entry.candidate ? [structuredClone(entry.candidate)] : [],
    ...(entry.outputText !== undefined ? { outputText: entry.outputText } : {}),
    ...(entry.candidate?.costQuota !== undefined ? { costQuota: entry.candidate.costQuota } : {}),
    ...(entry.candidate?.group ? { group: entry.candidate.group } : {}),
    ...(entry.candidate?.model ? { model: entry.candidate.model } : {}),
    ...(imageBatch ? { imageBatch } : {}),
  }
}

export function canvasRunExclusiveNodeIds(graph: CanvasRunGraph, scope: CanvasRunScope): string[] {
  const index = validateGraph(graph)
  if (scope.kind === 'to-node') {
    if (!index.nodesById.has(scope.nodeId)) throw new Error(`运行范围包含不存在的节点：${scope.nodeId}`)
    return [scope.nodeId]
  }
  const selected = selectScope(index, scope)
  const remote = index.topological.filter((nodeId) => {
    if (!selected.has(nodeId)) return false
    const node = index.nodesById.get(nodeId)!
    return usesRemoteGeneration(node.kind) && !node.disabled
  })
  if (remote.length > 0) return remote
  return index.topological.filter((nodeId) => selected.has(nodeId))
}

export function canvasRunRemoteGenerationUpperBound(graph: CanvasRunGraph, scope: CanvasRunScope): number {
  const index = validateGraph(graph)
  const selected = selectScope(index, scope)
  const skipped = new Set<string>()
  let remoteCount = 0
  for (const nodeId of index.topological) {
    if (!selected.has(nodeId)) continue
    const node = index.nodesById.get(nodeId)!
    const upstreamSkipped = (index.incoming.get(nodeId) ?? [])
      .some((edge) => selected.has(edge.source) && skipped.has(edge.source))
    if (node.disabled || upstreamSkipped) {
      skipped.add(nodeId)
      continue
    }
    // A multi-image node sends one paid request per image.
    if (usesRemoteGeneration(node.kind)) remoteCount += canvasRunImageCandidateCount(node)
  }
  return remoteCount
}

/**
 * The first reason a node that this run would actually execute cannot run on
 * the desktop. Disabled nodes and everything downstream of them are skipped
 * without calling an executor, so they do not block the run; nodes outside
 * the scope are never touched. Callers refuse the whole run on a reason,
 * before a single paid request goes out.
 */
export function canvasRunDesktopUnsupportedReason(graph: CanvasRunGraph, scope: CanvasRunScope): string | undefined {
  const index = validateGraph(graph)
  const selected = selectScope(index, scope)
  const skipped = new Set<string>()
  for (const nodeId of index.topological) {
    if (!selected.has(nodeId)) continue
    const node = index.nodesById.get(nodeId)!
    const upstreamSkipped = (index.incoming.get(nodeId) ?? [])
      .some((edge) => selected.has(edge.source) && skipped.has(edge.source))
    if (node.disabled || upstreamSkipped) {
      skipped.add(nodeId)
      continue
    }
    if (node.desktopUnsupported) return node.desktopUnsupported
  }
  return undefined
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
    assets?: CanvasRunAsset[]
  }>
} {
  const inputs: CanvasNodeInputs = {}
  const images: CanvasRunAsset[] = []
  const imageSources: CanvasImageToolSource<CanvasRunAsset>[] = []
  const videos: CanvasRunAsset[] = []
  const audios: CanvasRunAsset[] = []
  const fingerprintInputs = []
  for (const edge of index.incoming.get(nodeId) ?? []) {
    const output = outputs.get(edge.source)
    if (!output) continue
    if (output.text !== undefined) inputs.text = inputs.text === undefined ? output.text : `${inputs.text}\n${output.text}`
    // A batch connection hands on every picture the node made, each named by
    // its place in the batch, as the web host does; any other connection
    // hands on the one picture the canvas shows.
    const batch = edge.sourceHandle === batchImageHandle
    const pictures = batch
      ? (output.assets ?? (output.asset ? [output.asset] : [])).filter((asset) => asset.kind === 'image')
      : output.asset?.kind === 'image' ? [output.asset] : []
    for (const [outputIndex, asset] of pictures.entries()) {
      inputs.image ??= asset
      images.push(asset)
      imageSources.push({ edgeId: edge.id, outputIndex, asset })
    }
    if (!batch && output.asset?.kind === 'video') {
      inputs.video ??= output.asset
      videos.push(output.asset)
    }
    if (!batch && output.asset?.kind === 'audio') {
      inputs.audio ??= output.asset
      audios.push(output.asset)
    }
    fingerprintInputs.push({
      sourceNodeId: edge.source,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      fingerprint: output.fingerprint,
      ...(output.text !== undefined ? { text: output.text } : {}),
      // Which slice the canvas shows does not change what a batch hands on,
      // so choosing another one leaves a batch connection's key alone (the
      // kernel's run-input-matching.ts does not mark it stale either).
      ...(batch ? { assets: pictures } : output.asset ? { asset: output.asset } : {}),
    })
  }
  if (images.length > 0) {
    inputs.images = images
    inputs.imageSources = imageSources
  }
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
  let latestPersistenceError: unknown

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
        nodeRecord.latestProgress = complete.progress
        nodeRecord.latestProgressMode = complete.progressMode
        nodeRecord.latestHealth = complete.health
      }
    }
    appendCanvasRunTimelineEvent(record.events, timelineEvent(complete))
    const snapshot = cloneRecord(record)
    // A video reports progress every few seconds, and several run side by
    // side; writing the whole run file for each report stalled the main
    // process (R-1). Only these reports may wait. The running state written
    // before a paid request, the result and the terminal state still reach
    // the disk before anything proceeds.
    const progressOnly = complete.type === 'node-stage' || (complete.type === 'node-state' && complete.state === 'queued')
    const persist = progressOnly && options.persistProgress ? options.persistProgress : options.persistRecord
    eventQueue = eventQueue.then(async () => {
      try {
        await persist?.(snapshot)
        latestPersistenceError = undefined
      } catch (error) {
        // A later snapshot contains the complete event stream, including this
        // event. Keep the queue usable so a transient write failure cannot
        // replay a paid executor or suppress every subsequent checkpoint.
        latestPersistenceError = error
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
    if (isTerminalState(state)) {
      delete nodeRecord.latestStage
      delete nodeRecord.latestStageAt
      delete nodeRecord.latestStageSequence
      delete nodeRecord.latestProgress
      delete nodeRecord.latestProgressMode
      delete nodeRecord.latestHealth
    }
    await emit({ type: 'node-state', nodeId, state, ...details })
    return true
  }

  async function updateStage(
    nodeId: string,
    stage: CanvasRunNodeStage,
    attemptId?: string,
    progress?: { value?: number; mode?: 'determinate' | 'indeterminate'; health?: 'normal' | 'delayed' },
  ): Promise<boolean> {
    const nodeRecord = nodeRecords.get(nodeId)!
    if (isTerminalState(nodeRecord.state)) return false
    const normalizedProgress = progress?.value === undefined
      ? undefined
      : Math.max(0, Math.min(100, progress.value))
    const unchanged = nodeRecord.latestStage === stage
      && nodeRecord.latestProgress === normalizedProgress
      && nodeRecord.latestProgressMode === progress?.mode
      && nodeRecord.latestHealth === progress?.health
    if (unchanged) return false
    await emit({
      type: 'node-stage', nodeId, stage,
      ...(attemptId ? { attemptId } : {}),
      ...(normalizedProgress === undefined ? {} : { progress: normalizedProgress }),
      ...(progress?.mode ? { progressMode: progress.mode } : {}),
      ...(progress?.health ? { health: progress.health } : {}),
    })
    return true
  }

  // Frames the page still has to decode. Every change is sent whole, the way
  // the web host's run-waiting events are, so a reloaded page reads the
  // current list from the record and an empty list clears the banner.
  const framePreparations = new Map<string, CanvasFramePreparation>()
  // Pictures the page still has to make (第三步). Never put on the record:
  // see timelineEvent. Once a run has asked for one, every waiting event
  // carries the list, so an empty one clears the page's banner too.
  const imagePreparations = new Map<string, CanvasImagePreparation>()
  let imagePreparationsReported = false
  function waitingEvent(): CanvasRunEventPayload {
    const frames = [...framePreparations.values()].map((entry) => structuredClone(entry))
    if (frames.length) record.framePreparations = frames
    else delete record.framePreparations
    return {
      type: 'run-waiting',
      waitingForVideo: false,
      framePreparations: frames,
      ...(imagePreparationsReported ? { imagePreparations: [...imagePreparations.values()].map((entry) => structuredClone(entry)) } : {}),
    }
  }
  async function reportFramePreparation(nodeId: string, preparation: CanvasFramePreparation, waiting: boolean): Promise<void> {
    if (preparation.nodeId !== nodeId) throw new Error('视频帧不属于这个节点')
    if (waiting) {
      if (isTerminalState(nodeRecords.get(nodeId)!.state)) return
      framePreparations.set(preparation.operationId, structuredClone(preparation))
    } else if (!framePreparations.delete(preparation.operationId)) {
      return
    }
    await emit(waitingEvent())
  }
  async function reportImagePreparation(nodeId: string, preparation: CanvasImagePreparation, waiting: boolean): Promise<void> {
    if (preparation.nodeId !== nodeId || preparation.runId !== options.runId) throw new Error('图片处理不属于这个节点')
    if (waiting) {
      if (isTerminalState(nodeRecords.get(nodeId)!.state)) return
      imagePreparations.set(preparation.operationId, structuredClone(preparation))
      imagePreparationsReported = true
    } else if (!imagePreparations.delete(preparation.operationId)) {
      return
    }
    await emit(waitingEvent())
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
  // A stopped request can still be answered after its attempt is recorded, so
  // each paid attempt's request ids are read once more before the terminal save.
  const relayBillings: { attempt: CanvasRunAttempt; recorder: CanvasRelayBillingRecorder }[] = []
  function withRelayBilling(attempt: CanvasRunAttempt, recorder: CanvasRelayBillingRecorder | undefined): CanvasRunAttempt {
    if (!recorder) return attempt
    relayBillings.push({ attempt, recorder })
    const relayBilling = recorder.snapshot()
    if (relayBilling) attempt.relayBilling = relayBilling
    return attempt
  }

  function upstreamSettled(nodeId: string): Promise<void>[] {
    return (index.incoming.get(nodeId) ?? [])
      .filter((edge) => selected.has(edge.source))
      .map((edge) => settled.get(edge.source) ?? Promise.resolve())
  }

  const projectFingerprints = new Map<string, string>()

  // The fingerprint a node would have had in another project, given the inputs
  // it receives in this run. A duplicated project keeps node ids and results
  // but gets a new project id, so none of its fingerprints meet the original's.
  // Recomputing the chain under the origin's project id lets an adopted result
  // prove it came from these exact inputs without changing any stored
  // fingerprint (changing one re-runs and re-charges every cache on upgrade).
  // Only settled upstream nodes have outputs, so a memoized value never changes.
  function fingerprintInProject(nodeId: string, projectId: string | undefined): string {
    const memoKey = (id: string) => JSON.stringify([projectId ?? null, id])
    const needed = new Set<string>()
    const pending = [nodeId]
    while (pending.length > 0) {
      const current = pending.pop() as string
      if (needed.has(current) || projectFingerprints.has(memoKey(current))) continue
      needed.add(current)
      for (const edge of index.incoming.get(current) ?? []) {
        if (outputs.has(edge.source)) pending.push(edge.source)
      }
    }
    for (const current of index.topological) {
      if (!needed.has(current)) continue
      const { fingerprintInputs } = collectInputs(current, index, outputs)
      projectFingerprints.set(memoKey(current), computeCanvasNodeFingerprint({
        projectId,
        node: index.nodesById.get(current)!,
        upstream: fingerprintInputs.map((entry) => ({
          ...entry,
          fingerprint: projectFingerprints.get(memoKey(entry.sourceNodeId))!,
        })),
      }))
    }
    return projectFingerprints.get(memoKey(nodeId))!
  }

  // The asset the canvas shows on this node, as a cache entry for the current
  // fingerprint — but only when an earlier attempt produced it from the same
  // inputs. Remembered attempts that all ran under other inputs mean the inputs
  // were edited; no remembered attempt at all (history evicted) or a failed
  // lookup proves nothing either way. A cancelled lookup also lands there, so
  // the caller checks the signal before acting on the answer.
  async function inspectAdoptedAsset(
    node: CanvasRunGraphNode,
    assetId: string,
    resolveAssetOrigin: NonNullable<CanvasRunEngineOptions['resolveAssetOrigin']>,
    fingerprint: string,
  ): Promise<AdoptedAssetProof> {
    // One verdict per remembered attempt the store offers. A match whose asset
    // can no longer be read still comes back null, and is not an edit.
    const verdicts: boolean[] = []
    let found: CanvasRunAssetOrigin | null
    try {
      found = await raceWithAbort(resolveAssetOrigin(assetId, (origin) => {
        const matches = origin.candidate.asset.assetId === assetId
          && origin.fingerprint === (origin.projectId === options.projectId
            ? fingerprint
            : fingerprintInProject(node.id, origin.projectId))
        verdicts.push(matches)
        return matches
      }), options.signal)
    } catch {
      return { state: 'unproven' }
    }
    if (!found) return verdicts.length > 0 && !verdicts.includes(true) ? { state: 'outdated' } : { state: 'unproven' }
    const usedAt = now().toISOString()
    return {
      state: 'proven',
      entry: {
        version: canvasRunContractVersion,
        fingerprint,
        nodeKind: node.kind,
        candidate: structuredClone(found.candidate),
        ...(found.outputText !== undefined ? { outputText: found.outputText } : {}),
        createdAt: usedAt,
        lastUsedAt: usedAt,
      },
    }
  }

  // Which requests of a multi-image node are already cached, under one key
  // per request (canvasImageCandidateCacheKey), and whether the image the
  // canvas shows decides instead. Mirrors the one-image path below: the
  // adopted image is only weighed when the cache alone would show something
  // else (all cached) or nothing (none cached).
  async function planImageBatch(
    node: CanvasRunGraphNode,
    count: CanvasRunImageCandidateCount,
    fingerprint: string,
    bypassCache: boolean,
  ): Promise<ImageBatchPlan> {
    const hits = new Map<CanvasRunImageCandidateCount, CanvasRunCacheEntry>()
    if (bypassCache) return { kind: 'batch', hits }
    if (options.resolveCache) {
      const seenAssets = new Set<string>()
      const seenAttempts = new Set<string>()
      for (const index of imageCandidateIndexes(count)) {
        let entry: CanvasRunCacheEntry | null
        try {
          entry = await raceWithAbort(options.resolveCache(canvasImageCandidateCacheKey(fingerprint, index), node), options.signal)
        } catch {
          if (options.signal.aborted) return { kind: 'cancelled' }
          entry = null
        }
        const candidate = entry?.candidate
        // An image adopted by a one-image run is cached as request 1 and may
        // also be another request's result. One image never fills two places.
        if (!entry || !candidate || candidate.asset.kind !== 'image') continue
        if (seenAssets.has(candidate.asset.assetId) || seenAttempts.has(candidate.attemptId)) continue
        seenAssets.add(candidate.asset.assetId)
        seenAttempts.add(candidate.attemptId)
        hits.set(index, entry)
      }
    }
    const adoptedAssetId = node.data.adoptedAssetId
    const adoptedCached = [...hits.values()].some((entry) => entry.candidate?.asset.assetId === adoptedAssetId)
    // Partly cached means more images were asked for than are kept (a larger
    // count, or a batch that partly failed): the missing requests run and,
    // like any new paid batch, its first image replaces the one shown.
    if (!adoptedAssetId || adoptedCached || !options.resolveAssetOrigin || (hits.size > 0 && hits.size < count)) {
      return { kind: 'batch', hits }
    }
    const proof = await inspectAdoptedAsset(node, adoptedAssetId, options.resolveAssetOrigin, fingerprint)
    if (options.signal.aborted) return { kind: 'cancelled' }
    if (proof.state === 'proven') return { kind: 'adopted', entry: proof.entry, remember: hits.size === count }
    if (proof.state === 'unproven' && hits.size === count) return { kind: 'failed', errorMessage: unprovenAdoptedAssetMessage(node.kind) }
    return { kind: 'batch', hits }
  }

  // A multi-image node: one independent request per missing image, each with
  // its own attempt id (and so its own request id), cache entry and failure.
  // One request failing never stops or repeats another; the node succeeds
  // only when every image is there.
  async function runImageBatch(
    node: CanvasRunGraphNode,
    count: CanvasRunImageCandidateCount,
    fingerprint: string,
    inputs: CanvasNodeInputs,
    inputAssetIds: string[],
    hits: ReadonlyMap<CanvasRunImageCandidateCount, CanvasRunCacheEntry>,
  ): Promise<void> {
    const nodeId = node.id
    const nodeRecord = nodeRecords.get(nodeId)!
    const batchId = randomUUID()
    function keep(attempt: CanvasRunAttempt): void {
      nodeRecord.attempts.push(attempt)
      // The kernel lists a batch in attempt order and falls back to its first
      // image; the output below falls back the same way.
      nodeRecord.attempts.sort((left, right) => (left.imageBatch?.index ?? 0) - (right.imageBatch?.index ?? 0))
    }
    const cachedAt = now()
    for (const [index, entry] of hits) {
      keep(cachedAttempt(entry, fingerprint, entry.candidate!.attemptId, inputAssetIds, cachedAt, { batchId, index, count }))
    }
    const missing = imageCandidateIndexes(count).filter((index) => !hits.has(index))
    if (missing.length > 0) await updateStage(nodeId, 'waiting-slot')
    // Requests run side by side; only the lowest one still running reports
    // its stage, so the node does not flicker between theirs.
    const running = new Set<number>()
    const leads = (index: number) => Math.min(...running) === index
    // Every request waits until the running state is on disk, not only the
    // first one: a crash after a later request went out must still leave a
    // record that says the node was running and may have been charged.
    let runningSaved: Promise<boolean> | undefined
    await Promise.all(missing.map(async (index) => {
      let release: () => void
      try {
        release = await semaphore.acquire(options.signal)
      } catch {
        return
      }
      const attemptId = randomUUID()
      const attemptStartedAt = now()
      const billing = createCanvasRelayBillingRecorder()
      running.add(index)
      try {
        runningSaved ??= updateNode(nodeId, 'running', { attemptId, fingerprint })
        await runningSaved
        if (leads(index)) await updateStage(nodeId, 'submitting', attemptId)
        // Same window as the one-image path: a stop pressed while the stage
        // was being persisted must not let this request go out.
        if (options.signal.aborted) throw options.signal.reason ?? new Error('运行已取消')
        const executor = executorFor(options.executors, node.kind)
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
          inputs,
          signal: options.signal,
          billing: billing.observer,
          reportStage: async (stage, progress) => {
            await stageReportingReady
            if (leads(index)) await updateStage(nodeId, stage, attemptId, progress)
          },
        })
        void executorPromise.catch(() => undefined)
        if (leads(index)) await updateStage(nodeId, 'processing', attemptId)
        releaseStageReporting()
        const result = await raceWithAbort(executorPromise, options.signal)
        const completedAt = now()
        const candidates: CanvasRunCandidate[] = (result.assets ?? []).filter((asset) => asset.kind === 'image').map((asset) => ({
          candidateId: randomUUID(),
          attemptId,
          createdAt: completedAt.toISOString(),
          asset: structuredClone(asset),
          ...(result.group ? { group: result.group } : {}),
          ...(result.model ? { model: result.model } : {}),
          ...(result.costQuota !== undefined ? { costQuota: result.costQuota } : {}),
        }))
        if (candidates.length === 0) throw new Error('这一张没有拿到图片')
        keep(withRelayBilling({
          attemptId,
          fingerprint,
          state: 'succeeded',
          startedAt: attemptStartedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs: Math.max(0, completedAt.getTime() - attemptStartedAt.getTime()),
          cached: false,
          ...(inputAssetIds.length > 0 ? { inputAssetIds } : {}),
          candidates,
          ...(result.costQuota !== undefined ? { costQuota: result.costQuota } : {}),
          ...(result.group ? { group: result.group } : {}),
          ...(result.model ? { model: result.model } : {}),
          imageBatch: { batchId, index, count },
        }, billing))
        try {
          await options.storeCache?.({
            version: canvasRunContractVersion,
            fingerprint: canvasImageCandidateCacheKey(fingerprint, index),
            nodeKind: node.kind,
            candidate: candidates[0],
            createdAt: completedAt.toISOString(),
            lastUsedAt: completedAt.toISOString(),
          })
        } catch {
          // As on the one-image path: the run record keeps the paid image.
        }
      } catch (error) {
        const completedAt = now()
        const cancelled = options.signal.aborted
        keep(withRelayBilling({
          attemptId,
          fingerprint,
          state: cancelled ? 'cancelled' : 'failed',
          startedAt: attemptStartedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs: Math.max(0, completedAt.getTime() - attemptStartedAt.getTime()),
          cached: false,
          ...(inputAssetIds.length > 0 ? { inputAssetIds } : {}),
          candidates: [],
          ...(cancelled ? {} : { errorMessage: sanitizeRunError(error) }),
          ...(node.data.group ? { group: node.data.group } : {}),
          ...(node.data.model ? { model: node.data.model } : {}),
          imageBatch: { batchId, index, count },
        }, billing))
      } finally {
        running.delete(index)
        release()
      }
    }))
    const done = nodeRecord.attempts.filter((attempt) => attempt.state === 'succeeded' || attempt.state === 'cached')
    if (options.signal.aborted) {
      await updateNode(nodeId, 'cancelled', { fingerprint })
      return
    }
    if (done.length < count) {
      const reason = nodeRecord.attempts.find((attempt) => attempt.state === 'failed')?.errorMessage ?? '节点执行失败'
      await updateNode(nodeId, 'failed', { fingerprint, errorMessage: canvasImageBatchFailureMessage(count, done.length, reason) })
      return
    }
    const candidates = done.flatMap((attempt) => attempt.candidates)
    const output = candidates.find((candidate) => candidate.asset.assetId === node.data.adoptedAssetId) ?? candidates[0]
    outputs.set(nodeId, { fingerprint, asset: output.asset })
    const paid = done.filter((attempt) => !attempt.cached)
    const costQuota = paid.reduce<number | undefined>((total, attempt) => attempt.costQuota === undefined ? total : (total ?? 0) + attempt.costQuota, undefined)
    await updateNode(nodeId, paid.length === 0 ? 'cached' : 'succeeded', {
      attemptId: (paid.at(-1) ?? done[0]).attemptId,
      fingerprint,
      candidateIds: candidates.map((candidate) => candidate.candidateId),
      ...(costQuota !== undefined ? { costQuota } : {}),
    })
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
      // The run service refuses these runs up front. This stays as a second
      // line in case a caller skips that check: a kernel-only kind would
      // otherwise fall back to the video executor and spend money.
      if (node.desktopUnsupported || isCanvasRunKernelOnlyNodeKind(node.kind)) {
        await updateNode(nodeId, 'failed', { errorMessage: sanitizeRunError(node.desktopUnsupported ?? '该节点桌面版暂不支持，本次没有提交任何付费请求') })
        return
      }

      const collected = collectInputs(nodeId, index, outputs)
      const inputAssetIds = collectedInputAssetIds(collected.inputs)
      const fingerprint = computeCanvasNodeFingerprint({ projectId: options.projectId, node, upstream: collected.fingerprintInputs })
      await updateStage(nodeId, 'resolving-cache')
      let cached: CanvasRunCacheEntry | null | undefined
      // 「运行到此」点在哪个节点，那个节点就必须真的跑一遍。上游已固定的
      // 产物仍走缓存，否则下游单独运行会把前面的图再付费生成一次。
      const bypassCache = options.scope.kind === 'to-node' && options.scope.nodeId === nodeId
      let reusedAdopted = false
      let rememberAdopted = true
      const imageCandidateCount = canvasRunImageCandidateCount(node)
      if (imageCandidateCount > 1) {
        const plan = await planImageBatch(node, imageCandidateCount, fingerprint, bypassCache)
        if (plan.kind === 'cancelled') {
          await updateNode(nodeId, 'cancelled')
          return
        }
        if (plan.kind === 'failed') {
          await updateNode(nodeId, 'failed', { errorMessage: plan.errorMessage })
          return
        }
        if (plan.kind === 'batch') {
          await runImageBatch(node, imageCandidateCount, fingerprint, collected.inputs, inputAssetIds, plan.hits)
          return
        }
        // The image on the canvas came from these inputs: reuse it as one
        // cached attempt, exactly as a one-image node would.
        cached = plan.entry
        reusedAdopted = true
        rememberAdopted = plan.remember
      } else {
        try {
          cached = !bypassCache && isCanvasNodeCacheEligible(node.kind) && options.resolveCache
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
        const adoptedAssetId = reusesAdoptedAsset(node.kind) ? node.data.adoptedAssetId : undefined
        if (!bypassCache && adoptedAssetId && options.resolveAssetOrigin && cached?.candidate?.asset.assetId !== adoptedAssetId) {
          const proof = await inspectAdoptedAsset(node, adoptedAssetId, options.resolveAssetOrigin, fingerprint)
          if (options.signal.aborted) {
            await updateNode(nodeId, 'cancelled')
            return
          }
          if (proof.state === 'proven') {
            cached = proof.entry
            reusedAdopted = true
          } else if (proof.state === 'unproven' && cached?.candidate) {
            await updateNode(nodeId, 'failed', { errorMessage: unprovenAdoptedAssetMessage(node.kind) })
            return
          }
          // Outdated: the cache answers for the current inputs, as before.
          // Unproven with nothing cached: the node runs again, which the run
          // confirmation already disclosed as a possible charge.
        }
      }
      if (cached && (cached.outputText !== undefined || cached.candidate)) {
        const attempt = cachedAttempt(cached, fingerprint, cached.candidate?.attemptId ?? randomUUID(), inputAssetIds, now())
        // The slice shown may have changed since; it is not in the fingerprint.
        attempt.candidates = preferredImageToolCandidates(node, attempt.candidates)
        nodeRecords.get(nodeId)!.attempts.push(attempt)
        outputs.set(nodeId, {
          fingerprint,
          ...(cached.outputText !== undefined ? { text: cached.outputText } : {}),
          ...nodeOutputAssets(attempt.candidates),
        })
        if (reusedAdopted && rememberAdopted) {
          try {
            // The next run then hits the ordinary cache, even after the run
            // history that proved this adoption has been evicted.
            await options.storeCache?.(cached)
          } catch {
            // Reuse already happened; the cache only saves a lookup next time.
          }
        }
        await updateNode(nodeId, 'cached', {
          attemptId: attempt.attemptId,
          fingerprint,
          ...(attempt.candidates.length > 0 ? { candidateIds: attempt.candidates.map((candidate) => candidate.candidateId) } : {}),
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
      const billing = usesRemoteGeneration(node.kind) ? createCanvasRelayBillingRecorder() : undefined
      await updateNode(nodeId, 'running', { attemptId, fingerprint })
      try {
        const executor = executorFor(options.executors, node.kind)
        if (usesRemoteGeneration(node.kind)) await updateStage(nodeId, 'submitting', attemptId)
        // Persisting running awaits disk, and running/submitting both await
        // event projection. A stop pressed during that window has already
        // fired its abort event, which executors only subscribe to later, so
        // re-check before any paid request can be dispatched.
        if (options.signal.aborted) throw options.signal.reason ?? new Error('运行已取消')
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
          ...(billing ? { billing: billing.observer } : {}),
          reportStage: async (stage, progress) => {
            await stageReportingReady
            await updateStage(nodeId, stage, attemptId, progress)
          },
          reportFramePreparation: async (preparation, waiting) => {
            await stageReportingReady
            await reportFramePreparation(nodeId, preparation, waiting)
          },
          reportImagePreparation: async (preparation, waiting) => {
            await stageReportingReady
            await reportImagePreparation(nodeId, preparation, waiting)
          },
        })
        // raceWithAbort below observes the outcome, but only after the
        // processing stage is persisted. An executor that fails fast (an
        // account without video, a node missing its prompt) settles during
        // that write, and Node reports a rejection still unobserved at the end
        // of a tick as unhandled; main.ts forwards those to crash reporting.
        void executorPromise.catch(() => undefined)
        await updateStage(nodeId, 'processing', attemptId)
        releaseStageReporting()
        const result = await raceWithAbort(executorPromise, options.signal)
        if (options.signal.aborted || isTerminalState(nodeRecords.get(nodeId)!.state)) return
        const completedAt = now()
        // A page-made picture keeps its place in what the node made (the web
        // host numbers the same kinds), so a slice is found again after reordering.
        const numbered = canvasImageTransformKindForNode(node.kind) !== null
        const candidates: CanvasRunCandidate[] = preferredImageToolCandidates(node, (result.assets ?? []).map((asset, outputIndex) => ({
          ...(numbered ? { outputIndex } : {}),
          candidateId: randomUUID(),
          attemptId,
          createdAt: completedAt.toISOString(),
          asset: structuredClone(asset),
          ...(result.group ? { group: result.group } : {}),
          ...(result.model ? { model: result.model } : {}),
          ...(result.costQuota !== undefined ? { costQuota: result.costQuota } : {}),
        })))
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
        nodeRecords.get(nodeId)!.attempts.push(withRelayBilling(attempt, billing))
        outputs.set(nodeId, {
          fingerprint,
          ...(result.outputText !== undefined ? { text: result.outputText } : {}),
          ...nodeOutputAssets(candidates),
        })
        try {
          if (isCanvasNodeCacheEligible(node.kind)) {
            await options.storeCache?.({
              version: canvasRunContractVersion,
              fingerprint,
              nodeKind: node.kind,
              ...(candidates[0] ? { candidate: candidates[0] } : {}),
              ...(candidates.length > 1 ? { candidates } : {}),
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
          nodeRecords.get(nodeId)!.attempts.push(withRelayBilling({
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
          }, billing))
          await updateNode(nodeId, 'cancelled', { attemptId, fingerprint })
        } else {
          const errorMessage = sanitizeRunError(error)
          const completedAt = now()
          nodeRecords.get(nodeId)!.attempts.push(withRelayBilling({
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
          }, billing))
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
  for (const { attempt, recorder } of relayBillings) {
    const relayBilling = recorder.snapshot()
    if (relayBilling) attempt.relayBilling = relayBilling
  }
  // Every frame executor clears its own entry; a finished run waits on nothing.
  framePreparations.clear()
  imagePreparations.clear()
  delete record.framePreparations
  const completedAt = now()
  record.status = runStatus(outcome)
  record.completedAt = completedAt.toISOString()
  record.durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime())
  record.outcome = outcome
  await emit({ type: 'run-terminal', status: record.status, outcome })
  await eventQueue
  if (latestPersistenceError !== undefined && options.persistRecord) {
    try {
      await options.persistRecord(cloneRecord(record))
      latestPersistenceError = undefined
    } catch (error) {
      latestPersistenceError = error
    }
  }
  if (latestPersistenceError !== undefined) {
    throw new Error(`画布运行记录持久化失败：${sanitizeRunError(latestPersistenceError)}`)
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
