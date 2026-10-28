import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { computeCanvasGraphRevision } from './canvas-fingerprint'
import { parseCanvasStartRunInput } from './canvas-request-parser'
import { createCanvasRunService } from './canvas-run-service'
import { CanvasRunStore } from './canvas-run-store'
import type { CanvasRunAsset, CanvasRunCacheEntry, CanvasRunGraph, CanvasRunRecord, CanvasRunScope } from './canvas-run-contract'

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
    resolveAssetOrigin: async () => null,
    reconcileAssets: async () => [],
  }
}

describe('createCanvasRunService', () => {
  it('reuses a duplicated project\'s results from the stored run history instead of paying again (O04)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-service-'))
    try {
      const owned = new Map<string, CanvasRunAsset>()
      const store = new CanvasRunStore({
        rootDirectory: root,
        assets: {
          readOwned: async (_userId, assetId) => {
            const stored = owned.get(assetId)
            if (!stored) throw new Error('missing')
            const { kind: _kind, ...rest } = stored
            return { asset: rest }
          },
        },
      })
      let generated = 0
      const image = vi.fn(async () => {
        const assetId = `${++generated}`.padStart(43, 'i')
        const stored = { kind: 'image' as const, assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' }
        owned.set(assetId, stored)
        return { assets: [stored] }
      })
      const service = createCanvasRunService({
        store,
        executors: { text: async ({ node }) => ({ outputText: node.data.prompt }), image, video: async () => ({ assets: [] }) },
      })
      function project(adoptedAssetId?: string): CanvasRunGraph {
        return {
          nodes: [
            { id: 'prompt', kind: 'text', definitionVersion: 1, data: { prompt: '一只猫', model: '' } },
            { id: 'image', kind: 'image-generate', definitionVersion: 1, data: {
              prompt: '', model: 'gpt-image-2', group: '生图分组', ...(adoptedAssetId ? { adoptedAssetId } : {}),
            } },
          ],
          edges: [{ id: 'e-1', source: 'prompt', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' }],
        }
      }
      async function run(projectId: string, graph: CanvasRunGraph) {
        const handle = await service.start({
          userId: 7, ownerId: 9, projectId, graphRevision: computeCanvasGraphRevision(graph), graph, scope: { kind: 'all' },
        })
        return handle.promise
      }

      const original = await run('11111111-1111-1111-1111-111111111111', project())
      const shown = original.nodes.find((entry) => entry.nodeId === 'image')?.attempts[0]?.candidates[0]?.asset.assetId
      expect(shown).toBeDefined()
      const copy = await run('22222222-2222-2222-2222-222222222222', project(shown))

      const copied = copy.nodes.find((entry) => entry.nodeId === 'image')
      expect(copied?.state).toBe('cached')
      expect(copied?.attempts[0]?.candidates[0]?.asset.assetId).toBe(shown)
      expect(image).toHaveBeenCalledOnce()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('stops a switched-back candidate whose run history was evicted instead of using the newest one, also after a restart (O06)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-service-'))
    try {
      const owned = new Map<string, CanvasRunAsset>()
      function openStore() {
        return new CanvasRunStore({
          rootDirectory: root,
          runRetention: 3,
          assets: {
            readOwned: async (_userId, assetId) => {
              const stored = owned.get(assetId)
              if (!stored) throw new Error('missing')
              const { kind: _kind, ...rest } = stored
              return { asset: rest }
            },
          },
        })
      }
      let generated = 0
      const image = vi.fn(async () => {
        const assetId = `${++generated}`.padStart(43, 'i')
        const stored = { kind: 'image' as const, assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' }
        owned.set(assetId, stored)
        return { assets: [stored] }
      })
      function openService() {
        return createCanvasRunService({
          store: openStore(),
          executors: { text: async ({ node }) => ({ outputText: node.data.prompt }), image, video: async () => ({ assets: [] }) },
        })
      }
      function project(adoptedAssetId?: string): CanvasRunGraph {
        return {
          nodes: [
            { id: 'prompt', kind: 'text', definitionVersion: 1, data: { prompt: '一只猫', model: '' } },
            { id: 'image', kind: 'image-generate', definitionVersion: 1, data: {
              prompt: '', model: 'gpt-image-2', group: '生图分组', ...(adoptedAssetId ? { adoptedAssetId } : {}),
            } },
          ],
          edges: [{ id: 'e-1', source: 'prompt', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' }],
        }
      }
      async function run(service: ReturnType<typeof openService>, projectId: string, graph: CanvasRunGraph, scope: CanvasRunScope = { kind: 'all' }) {
        const handle = await service.start({
          userId: 7, ownerId: 9, projectId, graphRevision: computeCanvasGraphRevision(graph), graph, scope,
        })
        return handle.promise
      }
      function imageOf(record: CanvasRunRecord) {
        return record.nodes.find((entry) => entry.nodeId === 'image')
      }
      const projectId = '11111111-1111-1111-1111-111111111111'

      let service = openService()
      const first = imageOf(await run(service, projectId, project()))?.attempts[0]?.candidates[0]?.asset.assetId
      const newest = imageOf(await run(service, projectId, project(first), { kind: 'to-node', nodeId: 'image' }))?.attempts[0]?.candidates[0]?.asset.assetId
      expect(first).toBeDefined()
      expect(newest).toBeDefined()
      expect(newest).not.toBe(first)
      for (let index = 0; index < 3; index += 1) await run(service, '22222222-2222-2222-2222-222222222222', workflow())

      service = openService()
      const switchedBack = imageOf(await run(service, projectId, project(first)))
      expect(switchedBack?.state).toBe('failed')
      expect(switchedBack?.errorMessage).toContain('找不到你选中的这张图当初的生成记录')
      expect(switchedBack?.attempts).toEqual([])
      expect(image).toHaveBeenCalledTimes(2)

      // What the message suggests: picking the newest one runs from the cache.
      const newestPicked = imageOf(await run(service, projectId, project(newest)))
      expect(newestPicked?.state).toBe('cached')
      expect(newestPicked?.attempts[0]?.candidates[0]?.asset.assetId).toBe(newest)
      expect(image).toHaveBeenCalledTimes(2)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

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

  it('requires the current account when cancelling a run owned by a shared canvas sender', async () => {
    const graph = workflow()
    const store = memoryStore()
    let release: (() => void) | undefined
    const service = createCanvasRunService({
      store,
      randomUUID: () => 'run-user-bound',
      executors: {
        text: () => new Promise((resolve) => { release = () => resolve({ outputText: 'done' }) }),
        image: async () => ({ assets: [] }),
        video: async () => ({ assets: [] }),
      },
    })
    const handle = await service.start({
      userId: 7,
      ownerId: 10,
      graphRevision: computeCanvasGraphRevision(graph),
      graph,
      scope: { kind: 'all' },
    })
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(service.cancel(handle.runId, 10, 8)).toBe(false)
    expect(service.cancel(handle.runId, 10, 7)).toBe(true)
    release?.()
    await expect(handle.promise).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('lets sibling generate nodes run together and only locks the overlapping ones', async () => {
    const graph: CanvasRunGraph = {
      nodes: [
        { id: 'left', kind: 'text', definitionVersion: 1, data: { prompt: 'left', model: '' } },
        { id: 'right', kind: 'text', definitionVersion: 1, data: { prompt: 'right', model: '' } },
      ],
      edges: [],
    }
    const store = memoryStore()
    const gates = new Map<string, () => void>()
    let holdProjectA = true
    const text = vi.fn((context: { node: { id: string }; projectId?: string }) => (
      context.projectId === 'project-a' && holdProjectA
        ? new Promise<{ outputText: string }>((resolve) => { gates.set(context.node.id, () => resolve({ outputText: context.node.id })) })
        : Promise.resolve({ outputText: context.projectId === 'project-a' ? context.node.id : 'other project' })
    ))
    const service = createCanvasRunService({
      store,
      executors: { text, image: async () => ({ assets: [] }), video: async () => ({ assets: [] }) },
    })
    const revision = computeCanvasGraphRevision(graph)
    const first = await service.start({
      userId: 7, ownerId: 9, projectId: 'project-a', graphRevision: revision, graph, scope: { kind: 'to-node', nodeId: 'left' },
    })
    const second = await service.start({
      userId: 7, ownerId: 9, projectId: 'project-a', graphRevision: revision, graph, scope: { kind: 'to-node', nodeId: 'right' },
    })
    await vi.waitFor(() => expect(gates.size).toBe(2))

    await expect(service.start({
      userId: 7, ownerId: 9, projectId: 'project-a', graphRevision: revision, graph, scope: { kind: 'to-node', nodeId: 'left' },
    })).rejects.toThrow('已在生成中')

    await expect(service.start({
      userId: 7, ownerId: 9, projectId: 'project-a', graphRevision: revision, graph, scope: { kind: 'all' },
    })).rejects.toThrow('已在生成中')

    const otherProject = await service.start({
      userId: 7, ownerId: 9, projectId: 'project-b', graphRevision: revision, graph, scope: { kind: 'all' },
    })
    await expect(otherProject.promise).resolves.toMatchObject({ status: 'succeeded' })
    gates.get('left')?.()
    gates.get('right')?.()
    await expect(first.promise).resolves.toMatchObject({ status: 'succeeded' })
    await expect(second.promise).resolves.toMatchObject({ status: 'succeeded' })
    store.cache.clear()
    holdProjectA = false

    const afterTerminal = await service.start({
      userId: 7, ownerId: 9, projectId: 'project-a', graphRevision: revision, graph, scope: { kind: 'all' },
    })
    await expect(afterTerminal.promise).resolves.toMatchObject({ status: 'succeeded' })
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

  it('refuses a run that reaches a setting the desktop cannot honour before any paid work', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('tests never reach the network'))
    try {
      // The same xc-shaped request the canvas kernel sends, after IPC cloning.
      function kernelRequest(disabled: boolean) {
        return parseCanvasStartRunInput(structuredClone({
          graph: {
            nodes: [
              { id: 'prompt', kind: 'prompt', definitionVersion: 1, data: { prompt: '一只猫', model: '', imageCandidateCount: undefined } },
              { id: 'image', kind: 'image-generate', definitionVersion: 1, disabled, data: {
                prompt: '', model: 'gpt-image-2', group: '生图分组', imageCandidateCount: 4,
              } },
              { id: 'compare', kind: 'image-compare', definitionVersion: 1, disabled, data: { prompt: '', model: '' } },
              { id: 'other', kind: 'text', definitionVersion: 1, data: { prompt: '独立分支', model: '' } },
            ],
            edges: [{ id: 'e-1', source: 'prompt', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' }],
          },
          scope: { kind: 'all' },
        }))
      }
      const store = memoryStore()
      const saveRun = vi.spyOn(store, 'saveRun')
      const text = vi.fn(async () => ({ outputText: 'text' }))
      const image = vi.fn(async () => ({ assets: [] }))
      const video = vi.fn(async () => ({ assets: [] }))
      const service = createCanvasRunService({ store, executors: { text, image, video } })
      const { graph } = kernelRequest(false)
      const graphRevision = computeCanvasGraphRevision(graph)

      await expect(service.start({ userId: 7, ownerId: 9, graphRevision, graph, scope: { kind: 'all' } }))
        .rejects.toThrow('桌面版暂不支持，本次没有提交任何付费请求')
      await expect(service.start({ userId: 7, ownerId: 9, graphRevision, graph, scope: { kind: 'to-node', nodeId: 'image' } }))
        .rejects.toThrow('「一次出多张图」桌面版暂不支持，本次没有提交任何付费请求')
      await expect(service.start({ userId: 7, ownerId: 9, graphRevision, graph, scope: { kind: 'selection', nodeIds: ['compare'] } }))
        .rejects.toThrow('「图片对比」节点桌面版暂不支持，本次没有提交任何付费请求')
      expect(text).not.toHaveBeenCalled()
      expect(image).not.toHaveBeenCalled()
      expect(video).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(saveRun).not.toHaveBeenCalled()

      // Outside the scope the same nodes do not block anything.
      const outside = await service.start({ userId: 7, ownerId: 9, graphRevision, graph, scope: { kind: 'to-node', nodeId: 'other' } })
      await expect(outside.promise).resolves.toMatchObject({ status: 'succeeded' })
      expect(text).toHaveBeenCalledOnce()

      // Switched off, they are skipped and the rest of the workflow runs.
      store.cache.clear()
      const switchedOff = kernelRequest(true).graph
      const handle = await service.start({
        userId: 7, ownerId: 9, graphRevision: computeCanvasGraphRevision(switchedOff), graph: switchedOff, scope: { kind: 'all' },
      })
      const record = await handle.promise
      expect(Object.fromEntries(record.nodes.map((entry) => [entry.nodeId, entry.state]))).toEqual({
        prompt: 'succeeded', image: 'skipped', compare: 'skipped', other: 'succeeded',
      })
      expect(image).not.toHaveBeenCalled()
      expect(video).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
