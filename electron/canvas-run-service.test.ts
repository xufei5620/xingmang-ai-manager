import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { computeCanvasGraphRevision } from './canvas-fingerprint'
import { parseCanvasStartRunInput } from './canvas-request-parser'
import { canvasRunChargeFirstCheckMs, createCanvasRunChargeChecker } from './canvas-run-charges'
import { createCanvasRunService } from './canvas-run-service'
import type { CanvasNodeExecutionContext } from './canvas-run-engine'
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

  // R-1: with several videos running, each progress report used to rewrite
  // the whole run file on the main process.
  it('keeps progress reports off the disk until the next durable step while readers see them at once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-service-'))
    try {
      const store = new CanvasRunStore({
        rootDirectory: root,
        assets: {
          readOwned: async (_userId, assetId) => ({ asset: { assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' } }),
        },
        deferredWriteDelayMs: 60_000,
      })
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const assetId = 'p'.repeat(43)
      const service = createCanvasRunService({
        store,
        randomUUID: () => 'run-progress',
        executors: {
          text: async ({ node }) => ({ outputText: node.data.prompt }),
          image: async ({ reportStage }) => {
            await reportStage?.('processing', { value: 30, mode: 'determinate', health: 'normal' })
            await gate
            return { assets: [{ kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' }] }
          },
          video: async () => ({ assets: [] }),
        },
      })
      const graph: CanvasRunGraph = {
        nodes: [{ id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: '一只猫', model: 'gpt-image-2', group: '生图分组' } }],
        edges: [],
      }
      const handle = await service.start({
        userId: 7, ownerId: 9, graphRevision: computeCanvasGraphRevision(graph), graph, scope: { kind: 'all' },
      })
      function runOnDisk(): CanvasRunRecord | undefined {
        const state = JSON.parse(fs.readFileSync(path.join(root, 'user-7', 'canvas-runtime.json'), 'utf8')) as { runs: CanvasRunRecord[] }
        return state.runs.find((run) => run.runId === 'run-progress')
      }
      function progressEvents(run: CanvasRunRecord | null | undefined) {
        return (run?.events ?? []).filter((event) => event.type === 'node-stage' && event.progress === 30)
      }

      await vi.waitFor(async () => expect(progressEvents(await service.getRun(7, 'run-progress'))).toHaveLength(1))
      expect(runOnDisk()?.nodes[0].state).toBe('running')
      expect(progressEvents(runOnDisk())).toHaveLength(0)

      release()
      await expect(handle.promise).resolves.toMatchObject({ status: 'succeeded' })
      expect(runOnDisk()?.status).toBe('succeeded')
      expect(progressEvents(runOnDisk())).toHaveLength(1)
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

  it('says whether a run is still going, which restarting to install an update would cut short (D10)', async () => {
    const graph = workflow()
    const gate: { finish?: () => void } = {}
    const service = createCanvasRunService({
      store: memoryStore(),
      executors: {
        text: () => new Promise((resolve) => { gate.finish = () => resolve({ outputText: 'done' }) }),
        image: async () => ({ assets: [] }),
        video: async () => ({ assets: [] }),
      },
    })
    expect(service.hasActiveRuns()).toBe(false)
    const run = await service.start({ userId: 7, ownerId: 10, graphRevision: computeCanvasGraphRevision(graph), graph, scope: { kind: 'all' } })
    expect(service.hasActiveRuns()).toBe(true)
    await vi.waitFor(() => expect(gate.finish).toBeDefined())
    gate.finish?.()
    await expect(run.promise).resolves.toMatchObject({ status: 'succeeded' })
    await vi.waitFor(() => expect(service.hasActiveRuns()).toBe(false))
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

  it('takes a frame back only for a run the same window started under the same account', async () => {
    const graph = workflow()
    let release: (() => void) | undefined
    const complete = vi.fn(async () => undefined)
    const executors = {
      text: () => new Promise<{ outputText: string }>((resolve) => { release = () => resolve({ outputText: 'done' }) }),
      image: async () => ({ assets: [] }),
      video: async () => ({ assets: [] }),
    }
    const service = createCanvasRunService({ store: memoryStore(), randomUUID: () => 'run-frame', executors, preparations: { complete } })
    const handle = await service.start({ userId: 7, ownerId: 10, graphRevision: computeCanvasGraphRevision(graph), graph, scope: { kind: 'all' } })
    await vi.waitFor(() => expect(release).toBeDefined())
    const completion = { runId: handle.runId, operationId: 'attempt-1', kind: 'frame' as const, outcome: 'failed' as const }

    const refusal = '这一帧不在等待中，可能已经超时或运行已停止'
    await expect(service.completePreparation(7, 11, completion)).rejects.toThrow(refusal)
    await expect(service.completePreparation(8, 10, completion)).rejects.toThrow(refusal)
    await expect(service.completePreparation(7, 10, { ...completion, runId: 'run-other' })).rejects.toThrow(refusal)
    expect(complete).not.toHaveBeenCalled()
    await service.completePreparation(7, 10, completion)
    expect(complete).toHaveBeenCalledWith(7, completion)

    release?.()
    await expect(handle.promise).resolves.toMatchObject({ status: 'succeeded' })
    await vi.waitFor(() => expect(service.hasActiveRuns()).toBe(false))
    await expect(service.completePreparation(7, 10, completion)).rejects.toThrow(refusal)
    expect(complete).toHaveBeenCalledTimes(1)

    // A service without a broker takes no frames at all.
    const bare = createCanvasRunService({ store: memoryStore(), executors })
    await expect(bare.completePreparation(7, 10, completion)).rejects.toThrow(refusal)
  })

  // 画布完善第 7 条第三步: recipes never reach the run file, so a reloaded page reads them from here.
  it('adds the pictures a running run waits on to the records it lists, only from memory and only for that account', async () => {
    const graph: CanvasRunGraph = {
      nodes: [{ id: 'crop', kind: 'image-crop', definitionVersion: 1, data: { prompt: '', model: '', imageTransform: { kind: 'crop', outputWidth: 8, outputHeight: 8 } } }],
      edges: [],
    }
    const store = memoryStore()
    let release: (() => void) | undefined
    const preparation = {
      operationId: 'attempt', attemptId: 'attempt', runId: 'run-image', projectId: '11111111-1111-4111-8111-111111111111', nodeId: 'crop',
      sourceAssetIds: [], recipe: { kind: 'crop' as const, outputWidth: 8, outputHeight: 8 }, processorRevision: 'browser-image-v1',
    }
    const executors = {
      text: async () => ({ outputText: '' }),
      image: async () => ({ assets: [] }),
      video: async () => ({ assets: [] }),
      'image-crop': async ({ reportImagePreparation }: CanvasNodeExecutionContext) => {
        await reportImagePreparation!(preparation, true)
        await new Promise<void>((resolve) => { release = resolve })
        await reportImagePreparation!(preparation, false)
        return { assets: [] }
      },
    }
    const service = createCanvasRunService({ store, randomUUID: () => 'run-image', executors })
    const handle = await service.start({ userId: 7, ownerId: 10, projectId: preparation.projectId, graphRevision: computeCanvasGraphRevision(graph), graph, scope: { kind: 'all' } })
    await vi.waitFor(() => expect(release).toBeDefined())
    await vi.waitFor(async () => expect((await service.listRuns(7))[0]?.imagePreparations).toEqual([preparation]))
    expect(await service.getRun(7, 'run-image')).toMatchObject({ imagePreparations: [preparation] })
    expect((await service.listRuns(7, preparation.projectId))[0].imagePreparations).toEqual([preparation])
    expect((await service.listRuns(8))[0]).not.toHaveProperty('imagePreparations')
    expect(store.runs[0]).not.toHaveProperty('imagePreparations')

    release?.()
    await expect(handle.promise).resolves.toMatchObject({ status: 'succeeded' })
    await vi.waitFor(() => expect(service.hasActiveRuns()).toBe(false))
    expect((await service.listRuns(7))[0]).not.toHaveProperty('imagePreparations')
    // Whatever a record read back from the file says is never handed on.
    store.runs[0] = { ...store.runs[0], status: 'running', imagePreparations: [preparation] }
    expect((await service.listRuns(7))[0]).not.toHaveProperty('imagePreparations')
    expect(await service.getRun(7, 'run-image')).not.toHaveProperty('imagePreparations')
    await expect(service.completePreparation(7, 10, { runId: 'run-image', operationId: 'attempt', kind: 'image', outcome: 'failed' }))
      .rejects.toThrow('这次图片处理不在等待中，可能已经超时或运行已停止')
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
    })).rejects.toThrow('这次运行最多要生成 3 次，一次运行最多 2 次（一次出几张的按张数算），请分几次运行')
    expect(image).not.toHaveBeenCalled()
  })

  it('counts every image of a multi-image node toward the per-run limit', async () => {
    function single(count?: 2 | 3 | 4): CanvasRunGraph {
      return {
        nodes: [{
          id: 'image', kind: 'image-generate', definitionVersion: 1,
          data: { prompt: '一只猫', model: 'gpt-image-2', group: '生图分组', ...(count ? { imageCandidateCount: count } : {}) },
        }],
        edges: [],
      }
    }
    let made = 0
    const image = vi.fn(async () => {
      const assetId = `image${++made}`.padEnd(43, 'x')
      return { assets: [{ kind: 'image' as const, assetId, localUrl: `xingmang-asset://image/${assetId}` }] }
    })
    const service = createCanvasRunService({
      store: memoryStore(),
      maxRemoteGenerationsPerRun: 3,
      executors: { text: async () => ({ outputText: '' }), image, video: async () => ({ assets: [] }) },
    })
    const four = single(4)
    await expect(service.start({ userId: 7, ownerId: 9, graphRevision: computeCanvasGraphRevision(four), graph: four, scope: { kind: 'all' } }))
      .rejects.toThrow('这次运行最多要生成 4 次，一次运行最多 3 次')
    expect(image).not.toHaveBeenCalled()
    const three = single(3)
    const handle = await service.start({ userId: 7, ownerId: 9, graphRevision: computeCanvasGraphRevision(three), graph: three, scope: { kind: 'all' } })
    await handle.promise
    expect(image).toHaveBeenCalledTimes(3)
    // The count is part of the workflow revision: changing it is a new graph.
    expect(computeCanvasGraphRevision(four)).not.toBe(computeCanvasGraphRevision(three))
    expect(computeCanvasGraphRevision(single())).not.toBe(computeCanvasGraphRevision(three))
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
                prompt: '', model: 'gpt-image-2', group: '生图分组', imageReferenceOrder: { version: 1, slots: [] },
              } },
              { id: 'audio', kind: 'video-generate', definitionVersion: 1, disabled, data: {
                prompt: '', model: 'grok-imagine-video', group: '视频模型', seconds: '5', generateAudio: false,
              } },
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
        .rejects.toThrow('「参考图角色」桌面版暂不支持，本次没有提交任何付费请求')
      await expect(service.start({ userId: 7, ownerId: 9, graphRevision, graph, scope: { kind: 'selection', nodeIds: ['audio'] } }))
        .rejects.toThrow('「生成音频设置」桌面版暂不支持，本次没有提交任何付费请求')
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
        prompt: 'succeeded', image: 'skipped', audio: 'skipped', other: 'succeeded',
      })
      expect(image).not.toHaveBeenCalled()
      expect(video).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('createCanvasRunService charges', () => {
  it('schedules the 实扣 check once the terminal record is saved and publishes what it finds to subscribers', async () => {
    const graph = workflow()
    const store = memoryStore()
    const schedule = vi.fn()
    const clear = vi.fn()
    let publishCharge!: Parameters<NonNullable<Parameters<typeof createCanvasRunService>[0]['charges']>>[0]
    const service = createCanvasRunService({
      store,
      randomUUID: () => 'run-1',
      charges: (publish) => {
        publishCharge = publish
        return { schedule, clear }
      },
      executors: { text: async () => ({ outputText: 'hello' }), image: async () => ({ assets: [] }), video: async () => ({ assets: [] }) },
    })
    let savedWhenScheduled: string | undefined
    schedule.mockImplementation(() => { savedWhenScheduled = store.runs[0]?.status })
    const seen: unknown[] = []
    service.subscribe(({ event, userId, ownerId }) => { if (event.type === 'run-charge') seen.push({ runId: event.runId, userId, ownerId, usd: event.charge.usd }) })
    const handle = await service.start({ userId: 7, ownerId: 9, graphRevision: computeCanvasGraphRevision(graph), graph, scope: { kind: 'all' } })
    await handle.promise
    expect(schedule).toHaveBeenCalledOnce()
    expect(schedule.mock.calls[0][0]).toMatchObject({ runId: 'run-1', userId: 7, status: 'succeeded' })
    expect(schedule.mock.calls[0][1]).toBe(9)
    expect(savedWhenScheduled).toBe('succeeded')
    await publishCharge({
      version: 1, type: 'run-charge', runId: 'run-1', graphRevision: handle.graphRevision, sequence: 99, at: new Date().toISOString(),
      charge: { state: 'settled', usd: 0.06, unmatchedAttempts: 0, checkedAt: new Date().toISOString() }, attempts: [],
    }, 7, 9)
    expect(seen).toEqual([{ runId: 'run-1', userId: 7, ownerId: 9, usd: 0.06 }])
    service.shutdown()
    expect(clear).toHaveBeenCalledOnce()
  })

  it('still checks 实扣 for runs that end after a shutdown, as main shuts it down on every sign-in', async () => {
    const graph: CanvasRunGraph = {
      nodes: [{ id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: '一只猫', model: 'gpt-image-2', group: '生图分组' } }],
      edges: [],
    }
    const store = memoryStore()
    const timers: (() => void)[] = []
    let clock = Date.now()
    const readUsage = vi.fn(async () => ({ records: [{ requestId: 'req-1', quota: 30_000, type: 2 }], total: 1 }))
    let checker!: ReturnType<typeof createCanvasRunChargeChecker>
    const service = createCanvasRunService({
      store,
      charges: (publish) => {
        checker = createCanvasRunChargeChecker({
          current: () => ({ userId: 7, key: 'r1:7' }),
          readUsage,
          readQuotaPerUnit: async () => 500_000,
          getRun: (userId, runId) => store.getRun(userId, runId),
          saveRun: (userId, record) => store.saveRun(userId, record),
          publish,
          now: () => clock,
          setTimer: (callback) => { timers.push(callback); return callback },
          clearTimer: (timer) => { timers.splice(timers.indexOf(timer as () => void), 1) },
        })
        return checker
      },
      executors: {
        text: async () => ({ outputText: '' }),
        image: async ({ billing }) => {
          billing?.onRelayDispatch?.(true)
          billing?.onRelayAnswer?.('req-1')
          const assetId = 'image1'.padEnd(43, 'x')
          return { assets: [{ kind: 'image' as const, assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' }], model: 'gpt-image-2', group: '生图分组' }
        },
        video: async () => ({ assets: [] }),
      },
    })
    const seen: number[] = []
    service.subscribe(({ event }) => { if (event.type === 'run-charge') seen.push(event.charge.usd) })
    // Signing in shuts the service down before the first run (main.ts onChanged).
    service.shutdown()
    const handle = await service.start({ userId: 7, ownerId: 9, graphRevision: computeCanvasGraphRevision(graph), graph, scope: { kind: 'all' } })
    await handle.promise
    expect(timers).toHaveLength(1)
    clock += canvasRunChargeFirstCheckMs
    timers.shift()!()
    await checker.whenIdle()
    expect(readUsage).toHaveBeenCalledOnce()
    expect(seen).toEqual([0.06])
    expect(store.runs[0].charge).toMatchObject({ state: 'settled', usd: 0.06 })
  })

  it('never fails a run because its 实扣 could not be scheduled', async () => {
    const graph = workflow()
    const service = createCanvasRunService({
      store: memoryStore(),
      charges: () => ({ schedule: () => { throw new Error('boom') }, clear: () => undefined }),
      executors: { text: async () => ({ outputText: 'hello' }), image: async () => ({ assets: [] }), video: async () => ({ assets: [] }) },
    })
    const handle = await service.start({ userId: 7, ownerId: 9, graphRevision: computeCanvasGraphRevision(graph), graph, scope: { kind: 'all' } })
    await expect(handle.promise).resolves.toMatchObject({ status: 'succeeded' })
  })
})
