import { describe, expect, it, vi } from 'vitest'
import { computeCanvasGraphRevision } from './canvas-fingerprint'
import { createCanvasRunService } from './canvas-run-service'
import type { CanvasRunCacheEntry, CanvasRunGraph, CanvasRunRecord } from './canvas-run-contract'

function workflow(): CanvasRunGraph {
  return {
    nodes: [{ id: 'text', kind: 'text', definitionVersion: 1, data: { prompt: 'hello', model: '' } }],
    edges: [],
  }
}

function memoryStore() {
  const runs: CanvasRunRecord[] = []
  const cache = new Map<string, CanvasRunCacheEntry>()
  return {
    runs,
    cache,
    initializeUser: async () => structuredClone(runs),
    listRuns: async () => structuredClone(runs),
    getRun: async (_userId: number, runId: string) => structuredClone(runs.find((run) => run.runId === runId) ?? null),
    getAssetLineage: async () => ({}),
    listAssetIdsByLineage: async () => [],
    saveRun: async (_userId: number, run: CanvasRunRecord) => {
      const index = runs.findIndex((entry) => entry.runId === run.runId)
      if (index >= 0) runs.splice(index, 1)
      runs.unshift(structuredClone(run))
    },
    resolveCache: async (_userId: number, fingerprint: string) => structuredClone(cache.get(fingerprint) ?? null),
    storeCache: async (_userId: number, entry: CanvasRunCacheEntry) => { cache.set(entry.fingerprint, structuredClone(entry)) },
    reconcileAssets: async () => [],
  }
}

describe('createCanvasRunService', () => {
  it('rejects stale graph revisions before creating paid work', async () => {
    const graph = workflow()
    const text = vi.fn(async () => ({ outputText: 'hello' }))
    const service = createCanvasRunService({
      store: memoryStore(),
      executors: { text, image: async () => ({ assets: [] }), video: async () => ({ assets: [] }) },
    })
    await expect(service.start({ userId: 7, ownerId: 9, graphRevision: 'stale', graph, scope: { kind: 'all' } }))
      .rejects.toThrow('工作流已发生变化')
    expect(text).not.toHaveBeenCalled()
  })

  it('persists terminal state before publishing the terminal event', async () => {
    const graph = workflow()
    const store = memoryStore()
    const service = createCanvasRunService({
      store,
      randomUUID: () => 'run-1',
      executors: { text: async () => ({ outputText: 'hello' }), image: async () => ({ assets: [] }), video: async () => ({ assets: [] }) },
    })
    const observations: string[] = []
    service.subscribe(async ({ event, userId, ownerId }) => {
      expect({ userId, ownerId }).toEqual({ userId: 7, ownerId: 9 })
      if (event.type === 'node-stage') {
        expect(store.runs[0]?.nodes.find((node) => node.nodeId === event.nodeId)).toMatchObject({
          latestStage: event.stage,
          latestStageSequence: event.sequence,
        })
      }
      if (event.type === 'run-terminal') observations.push(store.runs[0]?.status ?? 'missing')
    })
    const handle = await service.start({
      userId: 7,
      ownerId: 9,
      graphRevision: computeCanvasGraphRevision(graph),
      graph,
      scope: { kind: 'all' },
    })
    await expect(handle.promise).resolves.toMatchObject({ status: 'succeeded' })
    expect(observations).toEqual(['succeeded'])
  })

  it('isolates cancellation by owner and tolerates event listener failures', async () => {
    const graph = workflow()
    const store = memoryStore()
    const gates = new Map<number, () => void>()
    const service = createCanvasRunService({
      store,
      executors: {
        text: ({ ownerId }) => new Promise((resolve) => gates.set(ownerId, () => resolve({ outputText: 'done' }))),
        image: async () => ({ assets: [] }),
        video: async () => ({ assets: [] }),
      },
    })
    service.subscribe(() => { throw new Error('renderer gone') })
    const revision = computeCanvasGraphRevision(graph)
    const [first, second] = await Promise.all([
      service.start({ userId: 7, ownerId: 10, graphRevision: revision, graph, scope: { kind: 'all' } }),
      service.start({ userId: 7, ownerId: 20, graphRevision: revision, graph, scope: { kind: 'all' } }),
    ])
    await vi.waitFor(() => expect(gates.size).toBe(2))
    expect(service.cancelOwner(10)).toBe(1)
    gates.get(20)?.()
    await expect(first.promise).resolves.toMatchObject({ status: 'cancelled' })
    await expect(second.promise).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('locks one active run per user, owner, and project until the terminal state', async () => {
    const graph = workflow()
    const store = memoryStore()
    let releaseFirst: (() => void) | undefined
    const text = vi.fn(({ projectId }: { projectId?: string }) => (
      projectId === 'project-a'
        ? new Promise<{ outputText: string }>((resolve) => { releaseFirst = () => resolve({ outputText: 'first' }) })
        : Promise.resolve({ outputText: 'other project' })
    ))
    const service = createCanvasRunService({
      store,
      executors: { text, image: async () => ({ assets: [] }), video: async () => ({ assets: [] }) },
    })
    const revision = computeCanvasGraphRevision(graph)
    const first = await service.start({
      userId: 7, ownerId: 9, projectId: 'project-a', graphRevision: revision, graph, scope: { kind: 'all' },
    })
    await vi.waitFor(() => expect(text).toHaveBeenCalledOnce())

    await expect(service.start({
      userId: 7, ownerId: 9, projectId: 'project-a', graphRevision: revision, graph, scope: { kind: 'all' },
    })).rejects.toThrow('已有工作流正在运行')

    const otherProject = await service.start({
      userId: 7, ownerId: 9, projectId: 'project-b', graphRevision: revision, graph, scope: { kind: 'all' },
    })
    await expect(otherProject.promise).resolves.toMatchObject({ status: 'succeeded' })
    releaseFirst?.()
    await expect(first.promise).resolves.toMatchObject({ status: 'succeeded' })
    store.cache.clear()

    const afterTerminal = await service.start({
      userId: 7, ownerId: 9, projectId: 'project-a', graphRevision: revision, graph, scope: { kind: 'all' },
    })
    await vi.waitFor(() => expect(text).toHaveBeenCalledTimes(3))
    releaseFirst?.()
    await expect(afterTerminal.promise).resolves.toMatchObject({ status: 'succeeded' })
    expect(text).toHaveBeenCalledTimes(3)
  })

  it('does not admit paid work when the initial run record cannot be persisted', async () => {
    const graph = workflow()
    const store = memoryStore()
    const originalSaveRun = store.saveRun
    let failAdmission = true
    store.saveRun = vi.fn(async (userId, record) => {
      if (failAdmission) throw new Error('disk unavailable')
      await originalSaveRun(userId, record)
    })
    const text = vi.fn(async () => ({ outputText: 'paid result' }))
    const service = createCanvasRunService({
      store,
      executors: { text, image: async () => ({ assets: [] }), video: async () => ({ assets: [] }) },
    })
    const input = {
      userId: 7,
      ownerId: 9,
      projectId: 'project-a',
      graphRevision: computeCanvasGraphRevision(graph),
      graph,
      scope: { kind: 'all' } as const,
    }

    await expect(service.start(input)).rejects.toThrow('画布运行初始化持久化失败：disk unavailable')
    expect(text).not.toHaveBeenCalled()
    failAdmission = false
    const retry = await service.start(input)
    await expect(retry.promise).resolves.toMatchObject({ status: 'succeeded' })
    expect(text).toHaveBeenCalledOnce()
  })

  it('rejects a run that exceeds the bounded number of remote generation nodes', async () => {
    const graph: CanvasRunGraph = {
      nodes: Array.from({ length: 3 }, (_entry, index) => ({
        id: `image-${index}`,
        kind: 'image-generate',
        definitionVersion: 1,
        data: { prompt: String(index), model: 'gpt-image-2', group: '生图分组' },
      })),
      edges: [],
    }
    const image = vi.fn(async () => ({ assets: [] }))
    const service = createCanvasRunService({
      store: memoryStore(),
      maxRemoteGenerationsPerRun: 2,
      executors: { text: async () => ({ outputText: '' }), image, video: async () => ({ assets: [] }) },
    })
    await expect(service.start({
      userId: 7, ownerId: 9, graphRevision: computeCanvasGraphRevision(graph), graph, scope: { kind: 'all' },
    })).rejects.toThrow('最多允许 2 个远程生成节点')
    expect(image).not.toHaveBeenCalled()
  })
})
