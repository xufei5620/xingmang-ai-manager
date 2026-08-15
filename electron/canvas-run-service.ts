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
  executeCanvasRun,
  type CanvasNodeExecutors,
} from './canvas-run-engine'
import type { CanvasRunStore } from './canvas-run-store'

export interface CanvasRunServiceOptions {
  store: Pick<CanvasRunStore, 'initializeUser' | 'listRuns' | 'getRun' | 'saveRun' | 'resolveCache' | 'storeCache' | 'reconcileAssets'>
  executors: CanvasNodeExecutors
  maxConcurrency?: number
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
  const active = new Map<string, ActiveRun>()
  const listeners = new Set<(publication: CanvasRunPublication) => void | Promise<void>>()

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

  function start(input: StartCanvasRunInput): CanvasRunHandle {
    const expectedRevision = computeCanvasGraphRevision(input.graph)
    if (expectedRevision !== input.graphRevision) throw new Error('工作流已发生变化，请重新发起运行')
    const runId = randomUUID()
    const controller = new AbortController()
    const handle = {} as CanvasRunHandle
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
      persistRecord: (record) => options.store.saveRun(input.userId, record),
      onEvent: (event) => publish(event, input.userId, input.ownerId),
    }).finally(() => {
      if (active.get(runId)?.handle === handle) active.delete(runId)
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
    active.set(runId, { userId: input.userId, ownerId: input.ownerId, controller, handle })
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
