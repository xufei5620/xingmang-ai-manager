import { describe, expect, it, vi } from 'vitest'
import {
  appendCanvasRunTimelineEvent,
  canvasImageBatchFailureMessage,
  canvasRunDescendants,
  canvasRunDesktopUnsupportedReason,
  canvasRunExclusiveNodeIds,
  canvasRunImageCandidateCount,
  canvasRunRemoteGenerationUpperBound,
  executeCanvasRun,
  type CanvasNodeExecutors,
  type CanvasRunAssetOrigin,
} from './canvas-run-engine'
import type {
  CanvasRunAsset,
  CanvasRunCacheEntry,
  CanvasRunEvent,
  CanvasRunGraph,
  CanvasRunGraphNode,
  CanvasRunRecord,
  CanvasRunScope,
} from './canvas-run-contract'
import { canvasRunTimelineLimit } from './canvas-run-contract'
import { canvasImageCandidateCacheKey } from './canvas-fingerprint'
import { createCanvasNodeExecutors } from './canvas-node-executors'

function node(id: string, kind: CanvasRunGraphNode['kind'], prompt = id): CanvasRunGraphNode {
  return { id, kind, definitionVersion: 1, data: { prompt, model: kind === 'image' ? 'gpt-image-2' : '' } }
}

function edge(source: string, target: string, kind: 'text' | 'image' = 'text') {
  return { id: `${source}->${target}:${kind}`, source, sourceHandle: `out:${kind}`, target, targetHandle: `in:${kind}` }
}

function graph(nodes: CanvasRunGraphNode[], edges: CanvasRunGraph['edges'] = []): CanvasRunGraph {
  return { nodes, edges }
}

function asset(id = 'a'.repeat(43)): CanvasRunAsset {
  return { kind: 'image', assetId: id, localUrl: `xingmang-asset://image/${id}`, mimeType: 'image/png' }
}

function executors(overrides: Partial<CanvasNodeExecutors> = {}): CanvasNodeExecutors {
  return {
    text: async ({ node }) => ({ outputText: node.data.prompt }),
    image: async () => ({ assets: [asset()] }),
    video: async () => { throw new Error('video disabled') },
    ...overrides,
  }
}

function runOptions(workflow: CanvasRunGraph, overrides: Partial<Parameters<typeof executeCanvasRun>[0]> = {}) {
  let uuid = 0
  let clock = Date.parse('2026-08-13T00:00:00.000Z')
  return {
    userId: 7,
    ownerId: 11,
    runId: 'run-1',
    graphRevision: 'revision-1',
    graph: workflow,
    scope: { kind: 'all' } as const,
    executors: executors(),
    signal: new AbortController().signal,
    randomUUID: () => `uuid-${++uuid}`,
    now: () => new Date(clock += 10),
    ...overrides,
  }
}

describe('executeCanvasRun', () => {
  it('runs a downstream closure and adds only the upstream dependencies required by that closure', async () => {
    const executed: string[] = []
    const text = vi.fn(async ({ node }: { node: CanvasRunGraphNode }) => {
      executed.push(node.id)
      return { outputText: node.data.prompt }
    })
    const workflow = graph(
      [
        node('root', 'text'), node('start', 'text'), node('downstream', 'text'), node('merge-dependency', 'text'),
        node('merged', 'text'), node('unrelated-root', 'text'), node('unrelated-leaf', 'text'),
      ],
      [
        edge('root', 'start'), edge('start', 'downstream'), edge('downstream', 'merged'),
        edge('merge-dependency', 'merged'), edge('unrelated-root', 'unrelated-leaf'),
      ],
    )
    const record = await executeCanvasRun(runOptions(workflow, {
      scope: { kind: 'from-node', nodeId: 'start' },
      executors: executors({ text }),
    }))

    expect(record.scope).toEqual({ kind: 'from-node', nodeId: 'start' })
    expect(record.nodes.map((entry) => entry.nodeId)).toEqual(['root', 'merge-dependency', 'start', 'downstream', 'merged'])
    expect(executed).toEqual(['root', 'merge-dependency', 'start', 'downstream', 'merged'])
    expect(record.outcome?.succeeded).toEqual(['root', 'merge-dependency', 'start', 'downstream', 'merged'])
  })

  it('uses the downstream scope for remote request admission estimates', () => {
    const workflow = graph(
      [node('prompt', 'text'), node('start', 'image'), node('video', 'video'), node('other', 'image')],
      [edge('prompt', 'start'), edge('start', 'video', 'image')],
    )
    expect(canvasRunRemoteGenerationUpperBound(workflow, { kind: 'from-node', nodeId: 'start' })).toBe(2)
    expect(() => canvasRunRemoteGenerationUpperBound(workflow, { kind: 'from-node', nodeId: 'missing' })).toThrow('不存在')
  })

  it('executes a diamond and concatenates fan-in text deterministically', async () => {
    const imageExecutor = vi.fn(async ({ inputs }) => {
      expect(inputs.text).toBe('left\nright')
      return { assets: [asset()] }
    })
    const workflow = graph(
      [node('root', 'text', 'root'), node('left', 'text', 'left'), node('right', 'text', 'right'), node('image', 'image')],
      [edge('root', 'left'), edge('root', 'right'), edge('left', 'image'), edge('right', 'image')],
    )
    const record = await executeCanvasRun(runOptions(workflow, {
      executors: executors({ image: imageExecutor }),
    }))
    expect(record.status).toBe('succeeded')
    expect(record.outcome?.succeeded).toEqual(['root', 'left', 'right', 'image'])
    expect(imageExecutor).toHaveBeenCalledOnce()
    for (const item of record.nodes) {
      expect(record.events.filter((event) => event.type === 'node-state' && event.nodeId === item.nodeId && ['succeeded', 'cached', 'failed', 'skipped', 'cancelled', 'interrupted'].includes(event.state))).toHaveLength(1)
    }
    expect(record.events.map((event) => event.sequence)).toEqual(record.events.map((_event, index) => index + 1))
  })

  it('persists ordered node stages and clears transient stage state at terminal success', async () => {
    const imageExecutor = vi.fn(async ({ reportStage }) => {
      await reportStage('downloading')
      await reportStage('saving')
      return { assets: [asset()] }
    })
    const record = await executeCanvasRun(runOptions(graph([node('image', 'image')]), {
      executors: executors({ image: imageExecutor }),
    }))
    const stages = record.events
      .filter((event) => event.type === 'node-stage')
      .map((event) => event.stage)

    expect(stages).toEqual([
      'validating', 'resolving-cache', 'waiting-slot', 'submitting', 'processing', 'downloading', 'saving',
    ])
    expect(record.nodes[0]).not.toHaveProperty('latestStage')
    expect(record.nodes[0]).not.toHaveProperty('latestStageSequence')
    expect(record.events.map((event) => event.sequence)).toEqual(record.events.map((_event, index) => index + 1))
  })

  it('persists changing progress on the same stage and suppresses only exact duplicates', async () => {
    const imageExecutor = vi.fn(async ({ reportStage }) => {
      await reportStage('processing', { value: 10, mode: 'determinate', health: 'normal' })
      await reportStage('processing', { value: 45, mode: 'determinate', health: 'normal' })
      await reportStage('processing', { value: 45, mode: 'determinate', health: 'normal' })
      await reportStage('processing', { value: 45, mode: 'indeterminate', health: 'delayed' })
      return { assets: [asset()] }
    })
    const record = await executeCanvasRun(runOptions(graph([node('image', 'image')]), {
      executors: executors({ image: imageExecutor }),
    }))
    const progressEvents = record.events.filter((event) => (
      event.type === 'node-stage' && event.stage === 'processing' && event.progress !== undefined
    ))

    expect(progressEvents).toMatchObject([
      { progress: 10, progressMode: 'determinate', health: 'normal' },
      { progress: 45, progressMode: 'determinate', health: 'normal' },
      { progress: 45, progressMode: 'indeterminate', health: 'delayed' },
    ])
    expect(record.nodes[0]).not.toHaveProperty('latestStage')
    expect(record.nodes[0]).not.toHaveProperty('latestProgress')
  })

  it('keeps a 5000-node stage timeline bounded with monotonic retained sequences', () => {
    const events: CanvasRunRecord['events'] = []
    for (let index = 1; index <= 5_000; index += 1) {
      appendCanvasRunTimelineEvent(events, {
        version: 1,
        type: 'node-stage',
        runId: 'run-1',
        graphRevision: 'revision-1',
        sequence: index,
        at: '2026-08-17T01:00:00.000Z',
        nodeId: `node-${index}`,
        stage: 'validating',
      })
    }
    expect(events).toHaveLength(canvasRunTimelineLimit)
    expect(events[0].sequence).toBe(5_000 - canvasRunTimelineLimit + 1)
    expect(events.at(-1)?.sequence).toBe(5_000)
  })

  it('preserves multiple image, video, and audio inputs for generic node executors', async () => {
    const imageA = { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }
    const imageB = { kind: 'image' as const, assetId: 'b'.repeat(43), localUrl: `xingmang-asset://image/${'b'.repeat(43)}` }
    const videoA = { kind: 'video' as const, assetId: 'c'.repeat(43), localUrl: `xingmang-asset://video/${'c'.repeat(43)}` }
    const videoB = { kind: 'video' as const, assetId: 'd'.repeat(43), localUrl: `xingmang-asset://video/${'d'.repeat(43)}` }
    const audioA = { kind: 'audio' as const, assetId: 'e'.repeat(43), localUrl: `xingmang-asset://audio/${'e'.repeat(43)}` }
    const audioB = { kind: 'audio' as const, assetId: 'f'.repeat(43), localUrl: `xingmang-asset://audio/${'f'.repeat(43)}` }
    const target = vi.fn(async ({ inputs }) => {
      expect(inputs.image).toEqual(imageA)
      expect(inputs.images).toEqual([imageA, imageB])
      expect(inputs.video).toEqual(videoA)
      expect(inputs.videos).toEqual([videoA, videoB])
      expect(inputs.audio).toEqual(audioA)
      expect(inputs.audios).toEqual([audioA, audioB])
      return { assets: [videoA] }
    })
    const workflow = graph([
      node('image-a', 'image-input'), node('image-b', 'image-input'),
      node('video-a', 'video-input'), node('video-b', 'video-input'),
      node('audio-a', 'audio-input'), node('audio-b', 'audio-input'),
      node('target', 'router'),
    ], [
      { id: 'i1', source: 'image-a', sourceHandle: 'out:image', target: 'target', targetHandle: 'in:images' },
      { id: 'i2', source: 'image-b', sourceHandle: 'out:image', target: 'target', targetHandle: 'in:images' },
      { id: 'v1', source: 'video-a', sourceHandle: 'out:video', target: 'target', targetHandle: 'in:videos' },
      { id: 'v2', source: 'video-b', sourceHandle: 'out:video', target: 'target', targetHandle: 'in:videos' },
      { id: 'a1', source: 'audio-a', sourceHandle: 'out:audio', target: 'target', targetHandle: 'in:audios' },
      { id: 'a2', source: 'audio-b', sourceHandle: 'out:audio', target: 'target', targetHandle: 'in:audios' },
    ])
    await executeCanvasRun(runOptions(workflow, {
      executors: executors({
        'image-input': async ({ node }) => ({ assets: [node.id === 'image-a' ? imageA : imageB] }),
        'video-input': async ({ node }) => ({ assets: [node.id === 'video-a' ? videoA : videoB] }),
        'audio-input': async ({ node }) => ({ assets: [node.id === 'audio-a' ? audioA : audioB] }),
        router: target,
      }),
    }))
    expect(target).toHaveBeenCalledOnce()
  })

  it('keeps an independent branch successful after another branch fails', async () => {
    const workflow = graph(
      [node('bad', 'image'), node('downstream', 'image'), node('independent', 'text')],
      [edge('bad', 'downstream', 'image')],
    )
    const record = await executeCanvasRun(runOptions(workflow, {
      executors: executors({ image: async ({ node }) => {
        if (node.id === 'bad') throw new Error('Bearer secret https://example.test C:\\Users\\person\\key.txt')
        return { assets: [asset()] }
      } }),
    }))
    expect(record.status).toBe('partial')
    expect(record.outcome).toMatchObject({ failed: ['bad'], skipped: ['downstream'], succeeded: ['independent'] })
    expect(JSON.stringify(record)).not.toContain('secret')
    expect(JSON.stringify(record)).not.toContain('example.test')
    expect(JSON.stringify(record)).not.toContain('Users')
  })

  it('does not leave a fast-failing executor rejection unhandled while the processing stage is persisted', async () => {
    // Persisting a stage really writes to disk, so the executor's rejection
    // lands before the engine gets round to awaiting it. Node treats that as
    // unhandled and main.ts forwards it to crash reporting.
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const record = await executeCanvasRun(runOptions(graph([node('clip', 'video')]), {
        executors: executors({ video: async () => { throw new Error('当前账号暂不支持视频生成') } }),
        persistRecord: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
      }))
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(record.outcome).toMatchObject({ failed: ['clip'] })
      expect(record.nodes[0]).toMatchObject({ state: 'failed', errorMessage: '当前账号暂不支持视频生成' })
    } finally {
      process.off('unhandledRejection', unhandled)
    }
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('rejects missing nodes and cycles before dispatching executors', async () => {
    const text = vi.fn(async () => ({ outputText: 'unused' }))
    await expect(executeCanvasRun(runOptions(graph([node('a', 'text')], [edge('ghost', 'a')]), {
      executors: executors({ text }),
    }))).rejects.toThrow('不存在的节点')
    await expect(executeCanvasRun(runOptions(graph([node('a', 'text'), node('b', 'text')], [edge('a', 'b'), edge('b', 'a')]), {
      executors: executors({ text }),
    }))).rejects.toThrow('循环连接')
    expect(text).not.toHaveBeenCalled()
  })

  it('requires initial record persistence before dispatching an executor', async () => {
    const text = vi.fn(async () => ({ outputText: 'paid result' }))
    const persistRecord = vi.fn(async () => undefined)
    const admissionSnapshots: CanvasRunRecord[] = []
    await expect(executeCanvasRun(runOptions(graph([node('a', 'text')]), {
      executors: executors({ text }),
      admitRecord: async (snapshot) => {
        admissionSnapshots.push(snapshot)
        throw new Error('disk unavailable')
      },
      persistRecord,
    }))).rejects.toThrow('画布运行初始化持久化失败：disk unavailable')

    expect(admissionSnapshots).toHaveLength(1)
    expect(admissionSnapshots[0]).toMatchObject({ status: 'running', events: [] })
    expect(admissionSnapshots[0].nodes).toEqual([
      expect.objectContaining({ nodeId: 'a', state: 'queued', attempts: [] }),
    ])
    expect(persistRecord).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
  })

  it('bounds executor concurrency while allowing independent branches', async () => {
    let active = 0
    let maximum = 0
    const gates: Array<() => void> = []
    const text = vi.fn(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise<void>((resolve) => gates.push(resolve))
      active -= 1
      return { outputText: 'done' }
    })
    const pending = executeCanvasRun(runOptions(graph([
      node('a', 'text'), node('b', 'text'), node('c', 'text'), node('d', 'text'),
    ]), { executors: executors({ text }), maxConcurrency: 2 }))
    await vi.waitFor(() => expect(text).toHaveBeenCalledTimes(2))
    expect(maximum).toBe(2)
    gates.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(text).toHaveBeenCalledTimes(4))
    gates.splice(0).forEach((release) => release())
    await expect(pending).resolves.toMatchObject({ status: 'succeeded' })
    expect(maximum).toBe(2)
  })

  it('cancels admitted nodes once and suppresses a late executor result', async () => {
    const controller = new AbortController()
    let resolveLate: ((value: { outputText: string }) => void) | undefined
    const text = vi.fn(() => new Promise<{ outputText: string }>((resolve) => { resolveLate = resolve }))
    const pending = executeCanvasRun(runOptions(graph([node('a', 'text'), node('b', 'text')], [edge('a', 'b')]), {
      executors: executors({ text }),
      signal: controller.signal,
    }))
    await vi.waitFor(() => expect(text).toHaveBeenCalledOnce())
    controller.abort(new Error('cancel'))
    const record = await pending
    resolveLate?.({ outputText: 'late' })
    await Promise.resolve()
    expect(record.status).toBe('cancelled')
    expect(record.outcome?.cancelled).toEqual(['a', 'b'])
    expect(record.events.some((event) => event.type === 'node-state' && event.nodeId === 'a' && event.state === 'cancelling')).toBe(true)
    expect(record.events.some((event) => event.type === 'node-state' && event.state === 'succeeded')).toBe(false)
  })

  it('does not dispatch a remote executor when cancelled while the running state is being persisted', async () => {
    const controller = new AbortController()
    const image = vi.fn(async () => ({ assets: [asset()] }))
    const record = await executeCanvasRun(runOptions(graph([node('image', 'image-generate')]), {
      executors: executors({ image }),
      signal: controller.signal,
      persistRecord: async (snapshot: CanvasRunRecord) => {
        if (snapshot.nodes.some((entry) => entry.state === 'running')) controller.abort(new Error('stop pressed'))
      },
    }))

    expect(image).not.toHaveBeenCalled()
    expect(record.status).toBe('cancelled')
    expect(record.outcome?.cancelled).toEqual(['image'])
    expect(record.nodes[0].attempts.at(-1)?.state).toBe('cancelled')
  })

  it('uses valid cache entries without dispatching an executor', async () => {
    const text = vi.fn(async () => ({ outputText: 'fresh' }))
    const record = await executeCanvasRun(runOptions(graph([node('a', 'text')]), {
      executors: executors({ text }),
      resolveCache: async (fingerprint) => ({
        version: 1,
        fingerprint,
        nodeKind: 'text',
        outputText: 'cached',
        createdAt: '2026-08-13T00:00:00.000Z',
        lastUsedAt: '2026-08-13T00:00:00.000Z',
      }),
    }))
    expect(text).not.toHaveBeenCalled()
    expect(record.status).toBe('succeeded')
    expect(record.nodes[0].state).toBe('cached')
    expect(record.outcome?.cached).toEqual(['a'])
  })

  it.each(['drama-character', 'drama-scene', 'drama-prop'] as const)(
    'rereads the bound image of %s after it is swapped while unchanged downstream work stays cached',
    async (kind) => {
      const imageA = 'a'.repeat(43)
      const imageB = 'b'.repeat(43)
      const reads: string[] = []
      const cache = new Map<string, CanvasRunCacheEntry>()
      const generate = vi.fn(async () => ({ assets: [asset('g'.repeat(43))] }))
      const realExecutors = createCanvasNodeExecutors({
        imageService: { generate: async () => { throw new Error('unused') }, cancel: () => ({ canceled: false, mayStillComplete: false }) },
        assets: {
          readOwned: async (_userId, assetId) => {
            reads.push(assetId)
            return { asset: { assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' } }
          },
        },
      })
      function workflow(bound: string): CanvasRunGraph {
        const source = node('ref', kind, '角色设定')
        source.data.adoptedAssetId = bound
        return graph([source, node('shot', 'image-generate')], [edge('ref', 'shot', 'image')])
      }
      async function run(bound: string) {
        return executeCanvasRun(runOptions(workflow(bound), {
          executors: { ...realExecutors, 'image-generate': generate },
          resolveCache: async (fingerprint) => cache.get(fingerprint) ?? null,
          storeCache: async (entry) => { cache.set(entry.fingerprint, entry) },
        }))
      }

      await run(imageA)
      const unchanged = await run(imageA)
      expect(unchanged.nodes.find((entry) => entry.nodeId === 'shot')?.state).toBe('cached')
      expect(generate).toHaveBeenCalledTimes(1)

      const swapped = await run(imageB)
      const source = swapped.nodes.find((entry) => entry.nodeId === 'ref')
      expect(source?.state).toBe('succeeded')
      expect(source?.attempts.at(-1)?.candidates[0]?.asset.assetId).toBe(imageB)
      expect(reads).toEqual([imageA, imageA, imageB])
      expect(swapped.nodes.find((entry) => entry.nodeId === 'shot')?.state).toBe('succeeded')
      expect(generate).toHaveBeenCalledTimes(2)
    },
  )

  it('still executes the explicit to-node target even when a cache entry exists', async () => {
    const image = vi.fn(async () => ({ assets: [asset()] }))
    const record = await executeCanvasRun(runOptions(graph(
      [node('prompt', 'text'), node('image', 'image-generate')],
      [edge('prompt', 'image')],
    ), {
      scope: { kind: 'to-node', nodeId: 'image' },
      executors: executors({ image }),
      resolveCache: async (fingerprint, current) => current.kind === 'image-generate'
        ? {
          version: 1,
          fingerprint,
          nodeKind: 'image-generate',
          candidate: {
            candidateId: 'cached-image',
            attemptId: 'cached-attempt',
            createdAt: '2026-08-13T00:00:00.000Z',
            asset: asset(),
          },
          createdAt: '2026-08-13T00:00:00.000Z',
          lastUsedAt: '2026-08-13T00:00:00.000Z',
        }
        : {
          version: 1,
          fingerprint,
          nodeKind: 'text',
          outputText: 'cached',
          createdAt: '2026-08-13T00:00:00.000Z',
          lastUsedAt: '2026-08-13T00:00:00.000Z',
        },
    }))
    expect(image).toHaveBeenCalledOnce()
    expect(record.nodes.find((entry) => entry.nodeId === 'prompt')?.state).toBe('cached')
    expect(record.nodes.find((entry) => entry.nodeId === 'image')?.state).toBe('succeeded')
  })

  it('cancels while cache lookup is pending and suppresses the late cache hit', async () => {
    const controller = new AbortController()
    let resolveCache: ((entry: CanvasRunCacheEntry | null) => void) | undefined
    const cache = new Promise<CanvasRunCacheEntry | null>((resolve) => { resolveCache = resolve })
    const text = vi.fn(async () => ({ outputText: 'must not run' }))
    const pending = executeCanvasRun(runOptions(graph([node('a', 'text')]), {
      signal: controller.signal,
      executors: executors({ text }),
      resolveCache: async () => cache,
    }))

    await Promise.resolve()
    controller.abort(new Error('cancel during cache lookup'))
    resolveCache?.({
      version: 1,
      fingerprint: 'a'.repeat(64),
      nodeKind: 'text',
      outputText: 'late cache value',
      createdAt: '2026-08-13T00:00:00.000Z',
      lastUsedAt: '2026-08-13T00:00:00.000Z',
    })
    const record = await pending

    expect(record.status).toBe('cancelled')
    expect(record.outcome?.cancelled).toEqual(['a'])
    expect(record.events.some((event) => event.type === 'node-state' && event.state === 'cached')).toBe(false)
    expect(text).not.toHaveBeenCalled()
  })

  it('treats cache read failures as misses instead of aborting the workflow', async () => {
    const text = vi.fn(async () => ({ outputText: 'fresh result' }))
    const record = await executeCanvasRun(runOptions(graph([node('a', 'text')]), {
      executors: executors({ text }),
      resolveCache: async () => { throw new Error('cache file unavailable') },
    }))

    expect(record.status).toBe('succeeded')
    expect(record.nodes[0].attempts[0].outputText).toBe('fresh result')
    expect(text).toHaveBeenCalledOnce()
  })

  it('completes a 100-node graph with bounded concurrency and one terminal event', async () => {
    let active = 0
    let maximum = 0
    const text = vi.fn(async ({ node }: { node: CanvasRunGraphNode }) => {
      active += 1
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active -= 1
      return { outputText: node.data.prompt }
    })
    const nodes = Array.from({ length: 100 }, (_entry, index) => node(`node-${index}`, 'text'))
    const startedAt = performance.now()
    const record = await executeCanvasRun(runOptions(graph(nodes), {
      executors: executors({ text }),
      maxConcurrency: 4,
    }))

    expect(record.status).toBe('succeeded')
    expect(record.outcome?.succeeded).toHaveLength(100)
    expect(text).toHaveBeenCalledTimes(100)
    expect(maximum).toBeLessThanOrEqual(4)
    expect(record.events.filter((event) => event.type === 'run-terminal')).toHaveLength(1)
    expect(performance.now() - startedAt).toBeLessThan(3_000)
  })

  it('persists before notifying and ignores callback failures', async () => {
    const order: string[] = []
    const record = await executeCanvasRun(runOptions(graph([node('a', 'text')]), {
      persistRecord: async (snapshot) => { order.push(`persist:${snapshot.events.at(-1)?.sequence}`) },
      onEvent: async (event) => {
        order.push(`notify:${event.sequence}`)
        if (event.sequence === 2) throw new Error('renderer gone')
      },
    }))
    expect(record.status).toBe('succeeded')
    expect(order.every((entry, index) => index % 2 === 0 ? entry.startsWith('persist:') : entry.startsWith('notify:'))).toBe(true)
  })

  // R-1: progress reports may wait in memory; whatever a paid request or its
  // result depends on still goes through the ordinary, durable save.
  it('saves stage and progress reports through persistProgress and every other step through persistRecord', async () => {
    function lastEntry(snapshot: CanvasRunRecord): string {
      const event = snapshot.events.at(-1)
      if (!event) return 'none'
      if (event.type === 'node-stage') return `stage:${event.stage}${event.progress === undefined ? '' : `:${event.progress}`}`
      if (event.type === 'node-state') return `state:${event.state}`
      return `terminal:${event.status}`
    }
    const durable: string[] = []
    const progress: string[] = []
    const imageExecutor = vi.fn(async ({ reportStage }) => {
      expect(durable).toContain('state:running')
      await reportStage('processing', { value: 30, mode: 'determinate', health: 'normal' })
      await reportStage('processing', { value: 80, mode: 'determinate', health: 'normal' })
      return { assets: [asset()] }
    })
    const record = await executeCanvasRun(runOptions(graph([node('image', 'image')]), {
      executors: executors({ image: imageExecutor }),
      persistRecord: async (snapshot) => { durable.push(lastEntry(snapshot)) },
      persistProgress: async (snapshot) => { progress.push(lastEntry(snapshot)) },
    }))

    expect(record.status).toBe('succeeded')
    expect(imageExecutor).toHaveBeenCalledOnce()
    expect(durable).toEqual(['state:running', 'state:succeeded', 'terminal:succeeded'])
    expect(progress).toEqual([
      'state:queued', 'stage:validating', 'stage:resolving-cache', 'stage:waiting-slot', 'stage:submitting',
      'stage:processing', 'stage:processing:30', 'stage:processing:80',
    ])
  })

  it('continues persistence after one snapshot write fails without replaying the executor', async () => {
    const text = vi.fn(async () => ({ outputText: 'paid result' }))
    const persisted: Array<{ sequence: number | undefined; status: string }> = []
    const notified: number[] = []
    let failedOnce = false
    const pending = executeCanvasRun(runOptions(graph([node('a', 'text')]), {
      executors: executors({ text }),
      persistRecord: async (snapshot) => {
        const sequence = snapshot.events.at(-1)?.sequence
        if (sequence === 2 && !failedOnce) {
          failedOnce = true
          throw new Error('transient disk error')
        }
        persisted.push({ sequence, status: snapshot.status })
      },
      onEvent: async (event) => { notified.push(event.sequence) },
    }))

    await expect(pending).resolves.toMatchObject({ status: 'succeeded' })
    expect(text).toHaveBeenCalledOnce()
    expect(persisted.map((entry) => entry.sequence)).not.toContain(2)
    expect(persisted.at(-1)?.status).toBe('succeeded')
    expect(notified).toContain(2)
    expect(notified.at(-1)).toBe(persisted.at(-1)?.sequence)
  })

  it('delivers the terminal event even when its final durable snapshot fails', async () => {
    const notified: CanvasRunEvent[] = []
    const pending = executeCanvasRun(runOptions(graph([node('a', 'text')]), {
      persistRecord: async (snapshot) => {
        if (snapshot.events.at(-1)?.type === 'run-terminal') throw new Error('terminal disk error')
      },
      onEvent: async (event) => { notified.push(event) },
    }))

    await expect(pending).rejects.toThrow('画布运行记录持久化失败：terminal disk error')
    expect(notified.at(-1)).toMatchObject({ type: 'run-terminal', status: 'succeeded' })
  })
})

function originResolver(records: readonly CanvasRunRecord[]) {
  return async (assetId: string, matches: (origin: CanvasRunAssetOrigin) => boolean): Promise<CanvasRunAssetOrigin | null> => {
    for (const run of records) {
      for (const entry of run.nodes) {
        for (const attempt of entry.attempts) {
          if (attempt.state !== 'succeeded' && attempt.state !== 'cached') continue
          const candidate = attempt.candidates.find((item) => item.asset.assetId === assetId)
          if (!candidate) continue
          const origin = {
            fingerprint: attempt.fingerprint,
            ...(run.projectId ? { projectId: run.projectId } : {}),
            candidate: structuredClone(candidate),
          }
          if (matches(origin)) return origin
        }
      }
    }
    return null
  }
}

const unprovenImageMessage = '找不到你选中的这张图当初的生成记录，没法确认它跟现在的设置对得上，所以这个节点先停下了，没有扣费。想接着用，请换选这个节点最新生成的那张；想要新图，在这个节点上点「运行到此」重新生成（会扣费）。'

function cachedEntry(fingerprint: string, nodeKind: CanvasRunGraphNode['kind'], cachedAsset: CanvasRunAsset): CanvasRunCacheEntry {
  return {
    version: 1,
    fingerprint,
    nodeKind,
    candidate: { candidateId: 'cached', attemptId: 'cached-attempt', createdAt: '2026-08-13T00:00:00.000Z', asset: cachedAsset },
    createdAt: '2026-08-13T00:00:00.000Z',
    lastUsedAt: '2026-08-13T00:00:00.000Z',
  }
}

function adoptionChain(prompt = '一只猫', adopted: { image?: string; video?: string } = {}): CanvasRunGraph {
  const image = node('image', 'image-generate')
  const video = node('video', 'video-generate')
  if (adopted.image) image.data.adoptedAssetId = adopted.image
  if (adopted.video) video.data.adoptedAssetId = adopted.video
  return graph(
    [node('prompt', 'text', prompt), image, video],
    [edge('prompt', 'image'), edge('image', 'video', 'image')],
  )
}

function adoptionHarness() {
  const cache = new Map<string, CanvasRunCacheEntry>()
  const records: CanvasRunRecord[] = []
  const videoInputs: Array<string | undefined> = []
  let imageCount = 0
  let videoCount = 0
  const image = vi.fn(async () => ({ assets: [asset(`image${++imageCount}`.padEnd(43, 'x'))] }))
  const video = vi.fn(async ({ inputs }: { inputs: { image?: CanvasRunAsset } }) => {
    videoInputs.push(inputs.image?.assetId)
    const assetId = `video${++videoCount}`.padEnd(43, 'x')
    return { assets: [{ kind: 'video' as const, assetId, localUrl: `xingmang-asset://video/${assetId}` }] }
  })
  async function run(projectId: string, workflow: CanvasRunGraph, scope: CanvasRunScope = { kind: 'all' }) {
    const record = await executeCanvasRun(runOptions(workflow, {
      projectId,
      runId: `run-${records.length + 1}`,
      scope,
      executors: executors({ image, video }),
      resolveCache: async (fingerprint) => structuredClone(cache.get(fingerprint) ?? null),
      storeCache: async (entry) => { cache.set(entry.fingerprint, structuredClone(entry)) },
      resolveAssetOrigin: originResolver(records),
    }))
    records.unshift(record)
    return record
  }
  return { cache, records, videoInputs, image, video, run }
}

function outputAssetId(record: CanvasRunRecord, nodeId: string): string | undefined {
  return record.nodes.find((entry) => entry.nodeId === nodeId)?.attempts.at(-1)?.candidates[0]?.asset.assetId
}

function nodeStates(record: CanvasRunRecord): Record<string, string> {
  return Object.fromEntries(record.nodes.map((entry) => [entry.nodeId, entry.state]))
}

describe('executeCanvasRun adopted results', () => {
  it('reuses what a duplicated project shows instead of generating it again (O04)', async () => {
    const harness = adoptionHarness()
    const original = await harness.run('project-a', adoptionChain())
    const shown = { image: outputAssetId(original, 'image'), video: outputAssetId(original, 'video') }

    const copy = await harness.run('project-b', adoptionChain('一只猫', shown))
    expect(nodeStates(copy)).toEqual({ prompt: 'succeeded', image: 'cached', video: 'cached' })
    expect(outputAssetId(copy, 'image')).toBe(shown.image)
    expect(outputAssetId(copy, 'video')).toBe(shown.video)
    expect(harness.image).toHaveBeenCalledOnce()
    expect(harness.video).toHaveBeenCalledOnce()

    // The copy now has its own cache entries, so it keeps reusing them after
    // the history that proved the adoption is gone.
    harness.records.length = 0
    const again = await harness.run('project-b', adoptionChain('一只猫', shown))
    expect(nodeStates(again)).toEqual({ prompt: 'cached', image: 'cached', video: 'cached' })
    expect(harness.image).toHaveBeenCalledOnce()
    expect(harness.video).toHaveBeenCalledOnce()
  })

  it('hands downstream the candidate the user switched back to, not the newest one (O06)', async () => {
    const harness = adoptionHarness()
    const first = await harness.run('project-a', adoptionChain())
    const firstShown = { image: outputAssetId(first, 'image'), video: outputAssetId(first, 'video') }
    const regenerated = await harness.run('project-a', adoptionChain('一只猫', firstShown), { kind: 'to-node', nodeId: 'image' })
    expect(outputAssetId(regenerated, 'image')).not.toBe(firstShown.image)
    expect(harness.image).toHaveBeenCalledTimes(2)

    const switchedBack = await harness.run('project-a', adoptionChain('一只猫', firstShown))
    expect(nodeStates(switchedBack)).toEqual({ prompt: 'cached', image: 'cached', video: 'cached' })
    expect(outputAssetId(switchedBack, 'image')).toBe(firstShown.image)
    expect(outputAssetId(switchedBack, 'video')).toBe(firstShown.video)
    expect(harness.image).toHaveBeenCalledTimes(2)
    expect(harness.video).toHaveBeenCalledOnce()
    expect(harness.videoInputs).toEqual([firstShown.image])
  })

  it('still generates again once the inputs behind the shown result have changed', async () => {
    const harness = adoptionHarness()
    const original = await harness.run('project-a', adoptionChain())
    const shown = { image: outputAssetId(original, 'image'), video: outputAssetId(original, 'video') }

    const edited = await harness.run('project-b', adoptionChain('一只狗', shown))
    expect(nodeStates(edited)).toEqual({ prompt: 'succeeded', image: 'succeeded', video: 'succeeded' })
    expect(outputAssetId(edited, 'image')).not.toBe(shown.image)
    expect(harness.image).toHaveBeenCalledTimes(2)
    expect(harness.video).toHaveBeenCalledTimes(2)
  })

  it('still regenerates the explicit to-node target even when it shows a reusable result', async () => {
    const harness = adoptionHarness()
    const original = await harness.run('project-a', adoptionChain())
    const shown = { image: outputAssetId(original, 'image'), video: outputAssetId(original, 'video') }

    const rerun = await harness.run('project-b', adoptionChain('一只猫', shown), { kind: 'to-node', nodeId: 'image' })
    expect(nodeStates(rerun)).toEqual({ prompt: 'succeeded', image: 'succeeded' })
    expect(harness.image).toHaveBeenCalledTimes(2)
  })

  it('ignores the shown result on nodes whose fingerprint already contains it', async () => {
    const harness = adoptionHarness()
    const resolveAssetOrigin = vi.fn(originResolver(harness.records))
    const input = node('input', 'image-input')
    input.data.adoptedAssetId = 'p'.repeat(43)
    await executeCanvasRun(runOptions(graph([input]), {
      projectId: 'project-a',
      executors: executors({ 'image-input': async () => ({ assets: [asset('p'.repeat(43))] }) }),
      resolveAssetOrigin,
    }))
    expect(resolveAssetOrigin).not.toHaveBeenCalled()
  })

  it('stops instead of handing downstream another cached result when the shown one cannot be looked up (O06)', async () => {
    const image = vi.fn(async () => ({ assets: [asset('n'.repeat(43))] }))
    const after = vi.fn(async () => ({ assets: [] }))
    const generate = node('image', 'image-generate')
    generate.data.adoptedAssetId = 'o'.repeat(43)
    const record = await executeCanvasRun(runOptions(graph([generate, node('after', 'video-generate')], [edge('image', 'after', 'image')]), {
      executors: executors({ image, video: after }),
      resolveCache: async (fingerprint) => cachedEntry(fingerprint, 'image-generate', asset('c'.repeat(43))),
      resolveAssetOrigin: async () => { throw new Error('run history unavailable') },
    }))
    expect(image).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
    expect(nodeStates(record)).toEqual({ image: 'failed', after: 'skipped' })
    expect(record.nodes[0].errorMessage).toBe(unprovenImageMessage)
    expect(record.nodes[0].attempts).toEqual([])
  })

  it('stops a video node whose shown result has no remembered origin, with the video wording', async () => {
    const video = vi.fn(async () => ({ assets: [] }))
    const generate = node('video', 'video-generate')
    generate.data.adoptedAssetId = 'o'.repeat(43)
    const shown = { kind: 'video' as const, assetId: 'c'.repeat(43), localUrl: `xingmang-asset://video/${'c'.repeat(43)}` }
    const record = await executeCanvasRun(runOptions(graph([generate]), {
      executors: executors({ video }),
      resolveCache: async (fingerprint) => cachedEntry(fingerprint, 'video-generate', shown),
      resolveAssetOrigin: async () => null,
    }))
    expect(video).not.toHaveBeenCalled()
    expect(record.nodes[0].state).toBe('failed')
    expect(record.nodes[0].errorMessage).toBe(
      '找不到你选中的这段视频当初的生成记录，没法确认它跟现在的设置对得上，所以这个节点先停下了，没有扣费。想接着用，请换选这个节点最新生成的那段；想要新视频，在这个节点上点「运行到此」重新生成（会扣费）。',
    )
  })

  it('stops instead of using the newest candidate once the history behind the switched-back one is evicted (O06)', async () => {
    const harness = adoptionHarness()
    const first = await harness.run('project-a', adoptionChain())
    const firstShown = { image: outputAssetId(first, 'image'), video: outputAssetId(first, 'video') }
    await harness.run('project-a', adoptionChain('一只猫', firstShown), { kind: 'to-node', nodeId: 'image' })
    expect(harness.image).toHaveBeenCalledTimes(2)

    harness.records.length = 0
    const switchedBack = await harness.run('project-a', adoptionChain('一只猫', firstShown))
    expect(nodeStates(switchedBack)).toEqual({ prompt: 'cached', image: 'failed', video: 'skipped' })
    expect(switchedBack.nodes.find((entry) => entry.nodeId === 'image')?.errorMessage).toBe(unprovenImageMessage)
    expect(harness.image).toHaveBeenCalledTimes(2)
    expect(harness.video).toHaveBeenCalledOnce()
    expect(harness.videoInputs).toEqual([firstShown.image])
  })

  it('still uses the cache for the current inputs when the shown result is remembered only under edited ones', async () => {
    const harness = adoptionHarness()
    const cat = await harness.run('project-a', adoptionChain())
    const catShown = { image: outputAssetId(cat, 'image'), video: outputAssetId(cat, 'video') }
    const dog = await harness.run('project-a', adoptionChain('一只狗'))
    const dogImage = outputAssetId(dog, 'image')

    const stale = await harness.run('project-a', adoptionChain('一只狗', catShown))
    expect(nodeStates(stale)).toEqual({ prompt: 'cached', image: 'cached', video: 'cached' })
    expect(outputAssetId(stale, 'image')).toBe(dogImage)
    expect(harness.image).toHaveBeenCalledTimes(2)
    expect(harness.video).toHaveBeenCalledTimes(2)
  })

  it('still generates again when the shown result has no remembered origin and nothing is cached', async () => {
    const harness = adoptionHarness()
    const original = await harness.run('project-a', adoptionChain())
    const shown = { image: outputAssetId(original, 'image'), video: outputAssetId(original, 'video') }

    harness.records.length = 0
    harness.cache.clear()
    const rerun = await harness.run('project-a', adoptionChain('一只猫', shown))
    expect(nodeStates(rerun)).toEqual({ prompt: 'succeeded', image: 'succeeded', video: 'succeeded' })
    expect(harness.image).toHaveBeenCalledTimes(2)
    expect(harness.video).toHaveBeenCalledTimes(2)
  })

  it('cancels while the shown result is being looked up without dispatching an executor', async () => {
    const controller = new AbortController()
    let lookupStarted!: () => void
    const started = new Promise<void>((resolve) => { lookupStarted = resolve })
    let resolveOrigin: ((origin: CanvasRunAssetOrigin | null) => void) | undefined
    const origin = new Promise<CanvasRunAssetOrigin | null>((resolve) => { resolveOrigin = resolve })
    const image = vi.fn(async () => ({ assets: [asset()] }))
    const generate = node('image', 'image-generate')
    generate.data.adoptedAssetId = 'o'.repeat(43)
    const pending = executeCanvasRun(runOptions(graph([generate]), {
      signal: controller.signal,
      executors: executors({ image }),
      resolveAssetOrigin: async () => {
        lookupStarted()
        return origin
      },
    }))

    await started
    controller.abort(new Error('cancel during adopted lookup'))
    resolveOrigin?.(null)
    const record = await pending

    expect(record.status).toBe('cancelled')
    expect(record.outcome?.cancelled).toEqual(['image'])
    expect(image).not.toHaveBeenCalled()
  })
})

function multiImageChain(count: 2 | 3 | 4 | undefined, adopted?: string, kind: CanvasRunGraphNode['kind'] = 'image-generate'): CanvasRunGraph {
  const image = node('image', kind)
  if (count) image.data.imageCandidateCount = count
  if (adopted) image.data.adoptedAssetId = adopted
  return graph(
    [node('prompt', 'text', '一只猫'), image, node('video', 'video-generate')],
    [edge('prompt', 'image'), edge('image', 'video', 'image')],
  )
}

function multiImageHarness() {
  const cache = new Map<string, CanvasRunCacheEntry>()
  const records: CanvasRunRecord[] = []
  const attemptIds: string[] = []
  const videoInputs: Array<string | undefined> = []
  let made = 0
  let failNext: string | undefined
  const image = vi.fn(async ({ attemptId }: { attemptId: string }) => {
    attemptIds.push(attemptId)
    if (failNext) {
      const message = failNext
      failNext = undefined
      throw new Error(message)
    }
    return { assets: [asset(`image${++made}`.padEnd(43, 'x'))], costQuota: 10 }
  })
  const video = vi.fn(async ({ inputs }: { inputs: { image?: CanvasRunAsset } }) => {
    videoInputs.push(inputs.image?.assetId)
    const assetId = `video${videoInputs.length}`.padEnd(43, 'x')
    return { assets: [{ kind: 'video' as const, assetId, localUrl: `xingmang-asset://video/${assetId}` }] }
  })
  async function run(workflow: CanvasRunGraph, scope: CanvasRunScope = { kind: 'all' }, projectId = 'project-a', extra: Partial<Parameters<typeof executeCanvasRun>[0]> = {}) {
    const record = await executeCanvasRun(runOptions(workflow, {
      projectId,
      runId: `run-${records.length + 1}`,
      randomUUID: (() => { let id = 0; return () => `run${records.length + 1}-uuid-${++id}` })(),
      scope,
      executors: executors({ image, video }),
      resolveCache: async (fingerprint) => structuredClone(cache.get(fingerprint) ?? null),
      storeCache: async (entry) => { cache.set(entry.fingerprint, structuredClone(entry)) },
      resolveAssetOrigin: originResolver(records),
      ...extra,
    }))
    records.unshift(record)
    return record
  }
  return { cache, records, attemptIds, videoInputs, image, video, run, failOnce: (message: string) => { failNext = message } }
}

function imageNode(record: CanvasRunRecord) {
  return record.nodes.find((entry) => entry.nodeId === 'image')!
}

function batchAssets(record: CanvasRunRecord): string[] {
  return imageNode(record).attempts.flatMap((attempt) => attempt.candidates.map((candidate) => candidate.asset.assetId))
}

describe('executeCanvasRun multi-image nodes', () => {
  it.each([2, 3, 4] as const)('sends %s independent one-image requests and keeps every image in order', async (count) => {
    const harness = multiImageHarness()
    const record = await harness.run(multiImageChain(count))

    expect(harness.image).toHaveBeenCalledTimes(count)
    expect(new Set(harness.attemptIds).size).toBe(count)
    const entry = imageNode(record)
    expect(entry.state).toBe('succeeded')
    expect(entry.attempts).toHaveLength(count)
    const batchIds = new Set(entry.attempts.map((attempt) => attempt.imageBatch?.batchId))
    expect(batchIds.size).toBe(1)
    expect(entry.attempts.map((attempt) => attempt.imageBatch?.index)).toEqual(Array.from({ length: count }, (_, index) => index + 1))
    expect(entry.attempts.every((attempt) => attempt.imageBatch?.count === count && !attempt.cached && attempt.candidates.length === 1)).toBe(true)
    // Every request is proven against the node's own fingerprint.
    expect(new Set(entry.attempts.map((attempt) => attempt.fingerprint)).size).toBe(1)
    expect(entry.attempts.every((attempt) => attempt.candidates[0].attemptId === attempt.attemptId)).toBe(true)
    // Downstream gets the first image, as the canvas falls back to it.
    expect(harness.videoInputs).toEqual([batchAssets(record)[0]])
    // One cache entry per request: request 1 under the node fingerprint.
    const fingerprint = entry.attempts[0].fingerprint
    expect(harness.cache.get(fingerprint)?.candidate?.asset.assetId).toBe(batchAssets(record)[0])
    for (let index = 2; index <= count; index++) {
      expect(harness.cache.get(canvasImageCandidateCacheKey(fingerprint, index))?.candidate?.asset.assetId).toBe(batchAssets(record)[index - 1])
    }
    const terminal = record.events.find((event) => event.type === 'node-state' && event.nodeId === 'image' && event.state === 'succeeded')
    expect(terminal).toMatchObject({ costQuota: 10 * count })
  })

  it('lets no request of a batch go out before the running state is on disk', async () => {
    const harness = multiImageHarness()
    let runningSaved = false
    let saveRunning!: () => void
    const disk = new Promise<void>((resolve) => { saveRunning = resolve })
    const sentEarly: boolean[] = []
    const image = vi.fn(async () => {
      sentEarly.push(!runningSaved)
      return { assets: [asset(`early${image.mock.calls.length}`.padEnd(43, 'x'))] }
    })
    const pending = harness.run(multiImageChain(3), { kind: 'all' }, 'project-a', {
      executors: executors({ image, video: harness.video }),
      persistRecord: async (snapshot) => {
        if (imageNode(snapshot).state !== 'running' || runningSaved) return
        await disk
        runningSaved = true
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(image).not.toHaveBeenCalled()

    saveRunning()
    const record = await pending
    expect(image).toHaveBeenCalledTimes(3)
    expect(sentEarly).toEqual([false, false, false])
    expect(imageNode(record).state).toBe('succeeded')
  })

  it('keeps a one-image node on the old single request', async () => {
    const harness = multiImageHarness()
    const record = await harness.run(multiImageChain(undefined))
    expect(harness.image).toHaveBeenCalledOnce()
    expect(imageNode(record).attempts).toHaveLength(1)
    expect(imageNode(record).attempts[0].imageBatch).toBeUndefined()
    expect(canvasRunImageCandidateCount(multiImageChain(4, undefined, 'image-edit').nodes[1])).toBe(4)
    const video = node('video', 'video-generate')
    video.data.imageCandidateCount = 4
    expect(canvasRunImageCandidateCount(video)).toBe(1)
  })

  it('keeps the images that came out when one request fails, and a later run sends only the missing one', async () => {
    const harness = multiImageHarness()
    harness.failOnce('上游超时')
    const failed = await harness.run(multiImageChain(3))

    expect(harness.image).toHaveBeenCalledTimes(3)
    const entry = imageNode(failed)
    expect(entry.state).toBe('failed')
    expect(entry.errorMessage).toBe('这次要出 3 张，出来 2 张，1 张没出来：上游超时')
    expect(entry.attempts.map((attempt) => attempt.imageBatch?.index)).toEqual([1, 2, 3])
    const failedAttempt = entry.attempts.find((attempt) => attempt.state === 'failed')!
    expect(entry.attempts.filter((attempt) => attempt.state === 'succeeded')).toHaveLength(2)
    expect(failedAttempt.errorMessage).toBe('上游超时')
    expect(failedAttempt.candidates).toEqual([])
    expect(failed.nodes.find((item) => item.nodeId === 'video')?.state).toBe('skipped')
    expect(harness.video).not.toHaveBeenCalled()

    const again = await harness.run(multiImageChain(3))
    expect(harness.image).toHaveBeenCalledTimes(4)
    const retried = imageNode(again)
    expect(retried.state).toBe('succeeded')
    expect(retried.attempts.map((attempt) => [attempt.imageBatch?.index, attempt.state])).toEqual([1, 2, 3].map((index) => (
      [index, index === failedAttempt.imageBatch?.index ? 'succeeded' : 'cached']
    )))
    expect(new Set(retried.attempts.map((attempt) => attempt.imageBatch?.batchId)).size).toBe(1)
    const kept = batchAssets(failed)
    expect(batchAssets(again).filter((assetId) => kept.includes(assetId))).toEqual(kept)
  })

  it('says plainly when none of the images came out', () => {
    expect(canvasImageBatchFailureMessage(4, 0, '余额不足')).toBe('这次要出 4 张，一张都没出来：余额不足')
    expect(canvasImageBatchFailureMessage(2, 1, 'x'.repeat(400)).length).toBe(300)
  })

  it('replays the whole batch from the cache, and a one-image run reuses request 1', async () => {
    const harness = multiImageHarness()
    const first = await harness.run(multiImageChain(4))
    const replay = await harness.run(multiImageChain(4, batchAssets(first)[0]))

    expect(harness.image).toHaveBeenCalledTimes(4)
    expect(imageNode(replay).state).toBe('cached')
    expect(batchAssets(replay)).toEqual(batchAssets(first))
    expect(imageNode(replay).attempts.map((attempt) => attempt.attemptId)).toEqual(imageNode(first).attempts.map((attempt) => attempt.attemptId))
    expect(new Set(imageNode(replay).attempts.map((attempt) => attempt.imageBatch?.batchId)).size).toBe(1)
    expect(imageNode(replay).attempts[0].imageBatch?.batchId).not.toBe(imageNode(first).attempts[0].imageBatch?.batchId)
    expect(replay.nodes.find((item) => item.nodeId === 'video')?.state).toBe('cached')

    const one = await harness.run(multiImageChain(undefined, batchAssets(first)[0]))
    expect(harness.image).toHaveBeenCalledTimes(4)
    expect(imageNode(one).state).toBe('cached')
    expect(batchAssets(one)).toEqual([batchAssets(first)[0]])
  })

  it('sends only the extra requests when the count goes up from one', async () => {
    const harness = multiImageHarness()
    const one = await harness.run(multiImageChain(undefined))
    const shown = batchAssets(one)[0]
    const three = await harness.run(multiImageChain(3, shown))

    expect(harness.image).toHaveBeenCalledTimes(3)
    expect(imageNode(three).attempts.map((attempt) => attempt.state)).toEqual(['cached', 'succeeded', 'succeeded'])
    expect(batchAssets(three)[0]).toBe(shown)
    // The image the canvas shows is in the batch, so downstream keeps it and
    // its own cache still answers.
    expect(harness.videoInputs).toEqual([shown])
    expect(three.nodes.find((item) => item.nodeId === 'video')?.state).toBe('cached')
  })

  it('regenerates every image of the explicit to-node target', async () => {
    const harness = multiImageHarness()
    const first = await harness.run(multiImageChain(2))
    const again = await harness.run(multiImageChain(2, batchAssets(first)[0]), { kind: 'to-node', nodeId: 'image' })

    expect(harness.image).toHaveBeenCalledTimes(4)
    expect(imageNode(again).state).toBe('succeeded')
    expect(batchAssets(again).some((assetId) => batchAssets(first).includes(assetId))).toBe(false)
  })

  it('hands downstream the image the user picked from the batch', async () => {
    const harness = multiImageHarness()
    const first = await harness.run(multiImageChain(4))
    const picked = batchAssets(first)[2]
    const replay = await harness.run(multiImageChain(4, picked))

    expect(harness.image).toHaveBeenCalledTimes(4)
    expect(imageNode(replay).state).toBe('cached')
    expect(replay.nodes.find((item) => item.nodeId === 'video')?.state).toBe('succeeded')
    expect(harness.videoInputs).toEqual([batchAssets(first)[0], picked])
  })

  it('reuses an image picked from an older batch, then shows it inside the kept batch', async () => {
    const harness = multiImageHarness()
    const older = await harness.run(multiImageChain(2))
    const newer = await harness.run(multiImageChain(2, batchAssets(older)[0]), { kind: 'to-node', nodeId: 'image' })
    const picked = batchAssets(older)[1]

    const switched = await harness.run(multiImageChain(2, picked))
    expect(harness.image).toHaveBeenCalledTimes(4)
    expect(imageNode(switched).state).toBe('cached')
    expect(imageNode(switched).attempts).toHaveLength(1)
    expect(imageNode(switched).attempts[0].imageBatch).toBeUndefined()
    expect(batchAssets(switched)).toEqual([picked])
    expect(harness.videoInputs.at(-1)).toBe(picked)

    const next = await harness.run(multiImageChain(2, picked))
    expect(harness.image).toHaveBeenCalledTimes(4)
    expect(imageNode(next).state).toBe('cached')
    expect(batchAssets(next)).toEqual([picked, batchAssets(newer)[1]])
  })

  it('stops instead of showing another batch when the picked image cannot be proven', async () => {
    const harness = multiImageHarness()
    const first = await harness.run(multiImageChain(2))
    harness.records.length = 0
    const stranger = 'stranger'.padEnd(43, 'x')
    const record = await harness.run(multiImageChain(2, stranger))

    expect(harness.image).toHaveBeenCalledTimes(2)
    expect(imageNode(record).state).toBe('failed')
    expect(imageNode(record).errorMessage).toBe(unprovenImageMessage)
    expect(batchAssets(first)).toHaveLength(2)
  })

  it('reuses what a duplicated project shows without sending the rest of its batch on the next run', async () => {
    const harness = multiImageHarness()
    const original = await harness.run(multiImageChain(3), { kind: 'all' }, 'project-a')
    const shown = batchAssets(original)[1]

    const copy = await harness.run(multiImageChain(3, shown), { kind: 'all' }, 'project-b')
    expect(harness.image).toHaveBeenCalledTimes(3)
    expect(imageNode(copy).state).toBe('cached')
    expect(batchAssets(copy)).toEqual([shown])

    const again = await harness.run(multiImageChain(3, shown), { kind: 'all' }, 'project-b')
    expect(harness.image).toHaveBeenCalledTimes(3)
    expect(imageNode(again).state).toBe('cached')
    expect(batchAssets(again)).toEqual([shown])
  })

  it('never lets one cached image fill two places of a batch', async () => {
    const harness = multiImageHarness()
    const first = await harness.run(multiImageChain(2))
    const fingerprint = imageNode(first).attempts[0].fingerprint
    harness.cache.set(canvasImageCandidateCacheKey(fingerprint, 2), structuredClone(harness.cache.get(fingerprint)!))

    const record = await harness.run(multiImageChain(2, batchAssets(first)[0]))
    expect(harness.image).toHaveBeenCalledTimes(3)
    expect(imageNode(record).attempts.map((attempt) => attempt.state)).toEqual(['cached', 'succeeded'])
    expect(new Set(batchAssets(record)).size).toBe(2)
  })

  it('bounds concurrent requests and stops sending the rest once cancelled', async () => {
    const controller = new AbortController()
    let active = 0
    let maximum = 0
    const gates: Array<() => void> = []
    const image = vi.fn(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise<void>((resolve) => gates.push(resolve))
      active -= 1
      return { assets: [asset()] }
    })
    const pending = executeCanvasRun(runOptions(multiImageChain(4), {
      executors: executors({ image }),
      maxConcurrency: 2,
      signal: controller.signal,
    }))
    await vi.waitFor(() => expect(image).toHaveBeenCalledTimes(2))
    expect(maximum).toBe(2)
    controller.abort(new Error('stop pressed'))
    const record = await pending
    gates.splice(0).forEach((release) => release())

    expect(image).toHaveBeenCalledTimes(2)
    expect(imageNode(record).state).toBe('cancelled')
    expect(imageNode(record).attempts.map((attempt) => attempt.state)).toEqual(['cancelled', 'cancelled'])
    expect(record.nodes.find((item) => item.nodeId === 'video')?.state).toBe('cancelled')
  })

  it('counts every image toward the per-run request estimate', () => {
    const workflow = multiImageChain(4)
    expect(canvasRunRemoteGenerationUpperBound(workflow, { kind: 'all' })).toBe(5)
    expect(canvasRunRemoteGenerationUpperBound(multiImageChain(undefined), { kind: 'all' })).toBe(2)
  })
})

describe('canvasRunDescendants', () => {
  it('fails a node the desktop cannot run without reaching an executor when a caller skips the service check', async () => {
    // A kernel-only kind falls back to the video executor, so this second
    // line is what keeps a direct engine call from spending money.
    const image = vi.fn(async () => ({ assets: [asset()] }))
    const video = vi.fn(async () => ({ assets: [] }))
    const reason = '「参考图角色」桌面版暂不支持，本次没有提交任何付费请求'
    const workflow = graph(
      [
        node('prompt', 'text'),
        node('compare', 'image-compare'),
        { ...node('many', 'image-generate'), desktopUnsupported: reason },
        node('after', 'image'),
      ],
      [edge('prompt', 'compare'), edge('prompt', 'many'), edge('many', 'after', 'image')],
    )
    const record = await executeCanvasRun(runOptions(workflow, { executors: executors({ image, video }) }))

    expect(image).not.toHaveBeenCalled()
    expect(video).not.toHaveBeenCalled()
    const states = Object.fromEntries(record.nodes.map((entry) => [entry.nodeId, entry.state]))
    expect(states).toEqual({ prompt: 'succeeded', compare: 'failed', many: 'failed', after: 'skipped' })
    expect(record.nodes.find((entry) => entry.nodeId === 'many')?.errorMessage).toBe(reason)
    expect(record.nodes.find((entry) => entry.nodeId === 'compare')?.errorMessage)
      .toBe('该节点桌面版暂不支持，本次没有提交任何付费请求')
  })

  it('returns descendants in topological order without including the roots', () => {
    const workflow = graph(
      [node('a', 'text'), node('b', 'text'), node('c', 'text'), node('d', 'text')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    )
    expect(canvasRunDescendants(workflow, ['a'])).toEqual(['b', 'c', 'd'])
  })
})

describe('canvasRunExclusiveNodeIds', () => {
  it('locks only the target of a to-node run so sibling generations can overlap', () => {
    const workflow = graph(
      [node('prompt', 'text'), node('left', 'image-generate'), node('right', 'video-generate')],
      [edge('prompt', 'left'), edge('prompt', 'right')],
    )
    expect(canvasRunExclusiveNodeIds(workflow, { kind: 'to-node', nodeId: 'left' })).toEqual(['left'])
    expect(canvasRunExclusiveNodeIds(workflow, { kind: 'to-node', nodeId: 'right' })).toEqual(['right'])
    expect(canvasRunExclusiveNodeIds(workflow, { kind: 'all' })).toEqual(['left', 'right'])
    expect(canvasRunExclusiveNodeIds(
      graph([node('a', 'text'), node('b', 'text')]),
      { kind: 'all' },
    )).toEqual(['a', 'b'])
  })
})

describe('canvasRunDesktopUnsupportedReason', () => {
  function unsupported(id: string, reason: string): CanvasRunGraphNode {
    return { ...node(id, 'image-generate'), desktopUnsupported: reason }
  }

  it('names the first unsupported node the run would execute', () => {
    const workflow = graph(
      [node('prompt', 'text'), unsupported('first', 'A'), unsupported('second', 'B'), node('other', 'text')],
      [edge('prompt', 'first'), edge('first', 'second')],
    )
    expect(canvasRunDesktopUnsupportedReason(workflow, { kind: 'all' })).toBe('A')
    // Every scope pulls in the upstream nodes the selected ones depend on.
    expect(canvasRunDesktopUnsupportedReason(workflow, { kind: 'selection', nodeIds: ['second'] })).toBe('A')
    expect(canvasRunDesktopUnsupportedReason(workflow, { kind: 'from-node', nodeId: 'second' })).toBe('A')

    const siblings = graph(workflow.nodes, [edge('prompt', 'first'), edge('prompt', 'second')])
    expect(canvasRunDesktopUnsupportedReason(siblings, { kind: 'to-node', nodeId: 'second' })).toBe('B')
  })

  it('ignores unsupported nodes outside the scope, switched off or behind a switched-off node', () => {
    const workflow = graph(
      [node('prompt', 'text'), unsupported('first', 'A'), unsupported('second', 'B'), node('other', 'text')],
      [edge('prompt', 'first'), edge('first', 'second')],
    )
    expect(canvasRunDesktopUnsupportedReason(workflow, { kind: 'to-node', nodeId: 'prompt' })).toBeUndefined()
    expect(canvasRunDesktopUnsupportedReason(workflow, { kind: 'selection', nodeIds: ['other'] })).toBeUndefined()

    const switchedOff = graph(
      [node('prompt', 'text'), { ...unsupported('first', 'A'), disabled: true }, unsupported('second', 'B'), node('other', 'text')],
      workflow.edges,
    )
    expect(canvasRunDesktopUnsupportedReason(switchedOff, { kind: 'all' })).toBeUndefined()

    const behindSwitchedOff = graph(
      [{ ...node('prompt', 'text'), disabled: true }, unsupported('first', 'A'), node('other', 'text')],
      [edge('prompt', 'first')],
    )
    expect(canvasRunDesktopUnsupportedReason(behindSwitchedOff, { kind: 'all' })).toBeUndefined()
  })

  it('still rejects a malformed graph before looking at any node', () => {
    expect(() => canvasRunDesktopUnsupportedReason(graph([unsupported('a', 'A')], [edge('ghost', 'a')]), { kind: 'all' }))
      .toThrow('不存在的节点')
  })
})
