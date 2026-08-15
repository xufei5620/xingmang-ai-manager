import { describe, expect, it, vi } from 'vitest'
import {
  canvasRunDescendants,
  executeCanvasRun,
  type CanvasNodeExecutors,
} from './canvas-run-engine'
import type {
  CanvasRunAsset,
  CanvasRunCacheEntry,
  CanvasRunGraph,
  CanvasRunGraphNode,
} from './canvas-run-contract'

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
})

describe('canvasRunDescendants', () => {
  it('returns descendants in topological order without including the roots', () => {
    const workflow = graph(
      [node('a', 'text'), node('b', 'text'), node('c', 'text'), node('d', 'text')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    )
    expect(canvasRunDescendants(workflow, ['a'])).toEqual(['b', 'c', 'd'])
  })
})
