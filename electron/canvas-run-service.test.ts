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
    initializeUser: async () => structuredClone(runs),
    listRuns: async () => structuredClone(runs),
    getRun: async (_userId: number, runId: string) => structuredClone(runs.find((run) => run.runId === runId) ?? null),
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
  it('rejects stale graph revisions before creating paid work', () => {
    const graph = workflow()
    const text = vi.fn(async () => ({ outputText: 'hello' }))
    const service = createCanvasRunService({
      store: memoryStore(),
      executors: { text, image: async () => ({ assets: [] }), video: async () => ({ assets: [] }) },
    })
    expect(() => service.start({ userId: 7, ownerId: 9, graphRevision: 'stale', graph, scope: { kind: 'all' } }))
      .toThrow('工作流已发生变化')
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
      if (event.type === 'run-terminal') observations.push(store.runs[0]?.status ?? 'missing')
    })
    const handle = service.start({
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
    const first = service.start({ userId: 7, ownerId: 10, graphRevision: revision, graph, scope: { kind: 'all' } })
    const second = service.start({ userId: 7, ownerId: 20, graphRevision: revision, graph, scope: { kind: 'all' } })
    await vi.waitFor(() => expect(gates.size).toBe(2))
    expect(service.cancelOwner(10)).toBe(1)
    gates.get(20)?.()
    await expect(first.promise).resolves.toMatchObject({ status: 'cancelled' })
    await expect(second.promise).resolves.toMatchObject({ status: 'succeeded' })
  })
})
