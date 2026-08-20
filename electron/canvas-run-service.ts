import { randomUUID as nodeRandomUUID } from 'node:crypto'
import type {
  CanvasRunEvent,
  CanvasRunGraph,
  CanvasRunRecord,
  CanvasRunScope,
} from './canvas-run-contract'
import { computeCanvasGraphRevision } from './canvas-fingerprint'
import {
  canvasRunDescendants,
  canvasRunExclusiveNodeIds,
  canvasRunRemoteGenerationUpperBound,
  executeCanvasRun,
  type CanvasNodeExecutors,
} from './canvas-run-engine'
import type { CanvasRunStore } from './canvas-run-store'

export interface CanvasRunServiceOptions {
  store: Pick<CanvasRunStore, 'initializeUser' | 'listRuns' | 'getRun' | 'getAssetLineage' | 'listAssetIdsByLineage' | 'saveRun' | 'resolveCache' | 'storeCache' | 'reconcileAssets'>
  executors: CanvasNodeExecutors
  maxConcurrency?: number
  maxActiveRuns?: number
  maxRemoteGenerationsPerRun?: number
  now?: () => Date
  randomUUID?: () => string
}

export interface StartCanvasRunInput {
  userId: number
  ownerId: number
  projectId?: string
  graphRevision: string
  graph: CanvasRunGraph
  scope: CanvasRunScope
}

export interface CanvasRunHandle {
  runId: string
  graphRevision: string
  promise: Promise<CanvasRunRecord>
  cancel(): boolean
}

interface ActiveRun {
  userId: number
  ownerId: number
  lockKey: string
  exclusiveNodeIds: string[]
  controller: AbortController
  handle: CanvasRunHandle
}

export interface CanvasRunPublication {
  event: CanvasRunEvent
  userId: number
  ownerId: number
}

export function createCanvasRunService(options: CanvasRunServiceOptions) {
  const randomUUID = options.randomUUID ?? nodeRandomUUID
  const maxRemoteGenerationsPerRun = options.maxRemoteGenerationsPerRun ?? 64
  const maxActiveRuns = options.maxActiveRuns ?? 20
  if (!Number.isSafeInteger(maxRemoteGenerationsPerRun) || maxRemoteGenerationsPerRun < 1 || maxRemoteGenerationsPerRun > 1_000) {
    throw new Error('单次画布远程生成上限无效')
  }
  if (!Number.isSafeInteger(maxActiveRuns) || maxActiveRuns < 1 || maxActiveRuns > 64) {
    throw new Error('画布并行运行上限无效')
  }
  const active = new Map<string, ActiveRun>()
  const nodeLocks = new Map<string, string>()

  function nodeLockId(lockKey: string, nodeId: string): string {
    return `${lockKey}\u0000${nodeId}`
  }
  const listeners = new Set<(publication: CanvasRunPublication) => void | Promise<void>>()

  function activeRunLockKey(input: Pick<StartCanvasRunInput, 'userId' | 'ownerId' | 'projectId'>): string {
    return JSON.stringify([input.userId, input.ownerId, input.projectId ?? null])
  }

  async function publish(event: CanvasRunEvent, userId: number, ownerId: number): Promise<void> {
    for (const listener of listeners) {
      try {
        await listener({ event: structuredClone(event), userId, ownerId })
      } catch {
        // UI projection failures cannot change durable run ownership or cause
        // a paid executor to be replayed.
      }
    }
  }

  async function start(input: StartCanvasRunInput): Promise<CanvasRunHandle> {
    const expectedRevision = computeCanvasGraphRevision(input.graph)
    if (expectedRevision !== input.graphRevision) throw new Error('工作流已发生变化，请重新发起运行')
    const remoteGenerations = canvasRunRemoteGenerationUpperBound(input.graph, input.scope)
    if (remoteGenerations > maxRemoteGenerationsPerRun) {
      throw new Error(`单次运行最多允许 ${maxRemoteGenerationsPerRun} 个远程生成节点，请拆分后重试`)
    }
    const lockKey = activeRunLockKey(input)
    const exclusiveNodeIds = canvasRunExclusiveNodeIds(input.graph, input.scope)
    if (exclusiveNodeIds.some((nodeId) => nodeLocks.has(nodeLockId(lockKey, nodeId)))) {
      throw new Error('这些节点已在生成中，请等待结束或先取消后再运行')
    }
    const activeForProject = [...active.values()].filter((run) => run.lockKey === lockKey).length
    if (activeForProject >= maxActiveRuns) throw new Error('当前生成任务过多，请等待已有任务完成')
    const runId = randomUUID()
    const controller = new AbortController()
    const handle = {} as CanvasRunHandle
    const activeRun = { userId: input.userId, ownerId: input.ownerId, lockKey, exclusiveNodeIds, controller, handle }
    active.set(runId, activeRun)
    for (const nodeId of exclusiveNodeIds) nodeLocks.set(nodeLockId(lockKey, nodeId), runId)
    let admissionSettled = false
    let resolveAdmission!: () => void
    let rejectAdmission!: (error: unknown) => void
    const admission = new Promise<void>((resolve, reject) => {
      resolveAdmission = resolve
      rejectAdmission = reject
    })
    const promise = executeCanvasRun({
      userId: input.userId,
      ownerId: input.ownerId,
      projectId: input.projectId,
      runId,
      graphRevision: input.graphRevision,
      graph: structuredClone(input.graph),
      scope: structuredClone(input.scope),
      executors: options.executors,
      signal: controller.signal,
      maxConcurrency: options.maxConcurrency,
      now: options.now,
      randomUUID,
      resolveCache: (fingerprint) => options.store.resolveCache(input.userId, fingerprint),
      storeCache: (entry) => options.store.storeCache(input.userId, entry),
      admitRecord: async (record) => {
        await options.store.saveRun(input.userId, record)
        admissionSettled = true
        resolveAdmission()
      },
      persistRecord: (record) => options.store.saveRun(input.userId, record),
      onEvent: (event) => publish(event, input.userId, input.ownerId),
    }).finally(() => {
      if (active.get(runId)?.handle === handle) active.delete(runId)
      for (const nodeId of exclusiveNodeIds) {
        const key = nodeLockId(lockKey, nodeId)
        if (nodeLocks.get(key) === runId) nodeLocks.delete(key)
      }
    })
    Object.assign(handle, {
      runId,
      graphRevision: input.graphRevision,
      promise,
      cancel: () => {
        const current = active.get(runId)
        if (!current || current.controller.signal.aborted) return false
        current.controller.abort(new Error('用户取消画布运行'))
        return true
      },
    })
    void promise.catch((error) => {
      if (admissionSettled) return
      admissionSettled = true
      rejectAdmission(error)
    })
    try {
      await admission
    } catch (error) {
      await promise.catch(() => undefined)
      throw error
    }
    return handle
  }

  function cancel(runId: string, ownerId: number): boolean {
    const run = active.get(runId)
    if (!run || run.ownerId !== ownerId || run.controller.signal.aborted) return false
    run.controller.abort(new Error('用户取消画布运行'))
    return true
  }

  function cancelOwner(ownerId: number): number {
    let count = 0
    for (const run of active.values()) {
      if (run.ownerId !== ownerId || run.controller.signal.aborted) continue
      run.controller.abort(new Error('画布窗口已关闭'))
      count += 1
    }
    return count
  }

  function cancelUser(userId: number): number {
    let count = 0
    for (const run of active.values()) {
      if (run.userId !== userId || run.controller.signal.aborted) continue
      run.controller.abort(new Error('账号已切换'))
      count += 1
    }
    return count
  }

  function shutdown(): number {
    let count = 0
    for (const run of active.values()) {
      if (run.controller.signal.aborted) continue
      run.controller.abort(new Error('应用正在退出'))
      count += 1
    }
    return count
  }

  function subscribe(listener: (publication: CanvasRunPublication) => void | Promise<void>): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return {
    initializeUser: (userId: number) => options.store.initializeUser(userId),
    listRuns: async (userId: number, projectId?: string) => {
      const runs = await options.store.listRuns(userId)
      return projectId ? runs.filter((run) => run.projectId === projectId) : runs
    },
    getRun: (userId: number, runId: string) => options.store.getRun(userId, runId),
    getAssetLineage: (userId: number, assetIds: readonly string[]) => options.store.getAssetLineage(userId, assetIds),
    listAssetIdsByLineage: (userId: number, selector: { runId?: string; nodeId?: string }) => options.store.listAssetIdsByLineage(userId, selector),
    reconcileAssets: (userId: number) => options.store.reconcileAssets(userId),
    start,
    cancel,
    cancelOwner,
    cancelUser,
    shutdown,
    subscribe,
    descendants: canvasRunDescendants,
  }
}

export type CanvasRunService = ReturnType<typeof createCanvasRunService>
