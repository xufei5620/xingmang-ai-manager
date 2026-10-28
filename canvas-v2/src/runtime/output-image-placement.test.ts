import { describe, expect, it, vi } from 'vitest'
import type { CanvasImageAssetSummary, CanvasRunGraph, CanvasRunRecord } from '../host'
import { defaultImageTransformRecipe } from '../image-tools/recipe'
import { createOutputImagePlacementCoordinator } from './output-image-placement'

const a = 'a'.repeat(43), b = 'b'.repeat(43)
function asset(assetId = a): CanvasImageAssetSummary { return { assetId, mediaType: 'image', mimeType: 'image/png', localUrl: `xingmang-asset://image/${assetId}`, thumbnailUrl: '', fileName: 'image.png', width: 640, height: 480, createdAt: '' } }
function graph(): CanvasRunGraph { return { nodes: [{ id: 'input', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: a } }, { id: 'tool', kind: 'image-collage', definitionVersion: 1, data: { prompt: '', model: '', imageTransform: defaultImageTransformRecipe('collage') } }], edges: [{ id: 'edge', source: 'input', sourceHandle: 'out:image', target: 'tool', targetHandle: 'in:images' }] } }
function record(): CanvasRunRecord { return { version: 1, userId: 1, ownerId: 1, runId: 'run', graphRevision: 'rev', projectId: 'project', scope: { kind: 'to-node', nodeId: 'tool' }, status: 'succeeded', createdAt: '', startedAt: '', events: [], nodes: [{ nodeId: 'tool', kind: 'image-collage', state: 'succeeded', attempts: [{ attemptId: 'attempt', fingerprint: '', state: 'succeeded', startedAt: '', completedAt: '', durationMs: 1, cached: false, candidates: [{ candidateId: 'candidate', attemptId: 'attempt', createdAt: '', asset: { kind: 'image', assetId: b, localUrl: asset(b).localUrl } }] }] }] } }
function deferred() { let resolve: (value: CanvasImageAssetSummary) => void = () => undefined; const promise = new Promise<CanvasImageAssetSummary>((done) => { resolve = done }); return { promise, resolve } }
function fixture() {
  let currentGraph = graph(), scope: string | null = 'owner/account/project/1', ids = [a]
  const read = vi.fn(async (id: string, _signal: AbortSignal) => asset(id)), commit = vi.fn(), notice = vi.fn(), busy = vi.fn()
  const coordinator = createOutputImagePlacementCoordinator({ scope: () => scope, graph: () => currentGraph, outputIds: () => ids, read, commit, notice, busy })
  return { coordinator, read, commit, notice, busy, graph: () => currentGraph, change: (update: (value: CanvasRunGraph) => void) => update(currentGraph), scope: (value: string | null) => { scope = value }, ids: (value: string[]) => { ids = value }, replace: () => { currentGraph = graph() } }
}
async function settled() { await new Promise<void>((resolve) => setTimeout(resolve, 0)) }

describe('explicit image output placement coordinator', () => {
  it('reuses the captured existing asset without a run and consumes duplicate completion once', async () => {
    const f = fixture(), token = f.coordinator.begin('tool', 'current', f.graph(), [a])!
    expect(f.coordinator.begin('tool', 'current', f.graph(), [a])).toBeNull()
    await Promise.all([f.coordinator.resolve(token, [a]), f.coordinator.resolve(token, [a])])
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.commit).toHaveBeenCalledExactlyOnceWith('tool', [asset()]); expect(f.coordinator.pending('tool')).toBe(false)
  })
  it.each(['account', 'reopen', 'disabled', 'source', 'recipe', 'edge', 'deleted', 'selection'] as const)('rejects a late existing result after %s changes', async (kind) => {
    const f = fixture(), pending = deferred(); f.read.mockReturnValue(pending.promise)
    const token = f.coordinator.begin('tool', 'current', f.graph(), [a])!, completion = f.coordinator.resolve(token, [a])
    if (kind === 'account' || kind === 'reopen') f.scope(kind)
    if (kind === 'disabled') f.scope(null)
    if (kind === 'source') f.change((g) => { g.nodes[0].data.adoptedAssetId = b })
    if (kind === 'recipe') f.change((g) => { const recipe = defaultImageTransformRecipe('collage'); if (recipe.kind === 'collage') g.nodes[1].data.imageTransform = { ...recipe, gap: 10 } })
    if (kind === 'edge') f.change((g) => { g.edges = [] })
    if (kind === 'deleted') f.change((g) => { g.nodes = g.nodes.slice(0, 1) })
    if (kind === 'selection') f.ids([b])
    pending.resolve(asset()); await completion
    expect(f.commit).not.toHaveBeenCalled(); expect(f.coordinator.pending('tool')).toBe(false)
  })
  it('accepts only the requested terminal run and preserves success on a repeated history refresh', async () => {
    const f = fixture(), token = f.coordinator.begin('tool', 'current', f.graph())!
    f.coordinator.attach(token, { runId: 'run', graphRevision: 'rev' })
    f.coordinator.accept({ ...record(), graphRevision: 'other' }); f.coordinator.accept({ ...record(), status: 'running' }); expect(f.read).not.toHaveBeenCalled()
    f.coordinator.accept(record()); f.coordinator.accept(record()); await settled(); f.coordinator.accept(record())
    expect(f.commit).toHaveBeenCalledExactlyOnceWith('tool', [asset(b)]); expect(f.read).toHaveBeenCalledTimes(1)
  })
  it.each(['failed', 'cancelled', 'interrupted'] as const)('does not reuse an old attempt when the new run is %s', async (state) => {
    const f = fixture(), token = f.coordinator.begin('tool', 'current', f.graph())!, run = record()
    f.coordinator.attach(token, { runId: 'run', graphRevision: 'rev' }); run.status = state; run.nodes[0].state = state
    f.coordinator.accept(run); await settled(); expect(f.read).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled(); expect(f.coordinator.pending('tool')).toBe(false)
  })
  it('allows this run upstream result adoption while rejecting a later manual upstream replacement', async () => {
    const f = fixture(), token = f.coordinator.begin('tool', 'current', f.graph())!, run = record()
    f.change((g) => { g.nodes[0].kind = 'image-generate' }); token.graph.nodes[0].kind = 'image-generate'
    run.nodes.push({ ...run.nodes[0], nodeId: 'input', kind: 'image-generate' })
    f.change((g) => { g.nodes[0].data.adoptedAssetId = b }); f.coordinator.attach(token, { runId: 'run', graphRevision: 'rev' }); f.coordinator.accept(run); await settled()
    expect(f.commit).toHaveBeenCalledTimes(1)
    const next = f.coordinator.begin('tool', 'current', f.graph())!
    f.coordinator.attach(next, { runId: 'run', graphRevision: 'rev' }); f.change((g) => { g.nodes[0].data.adoptedAssetId = 'c'.repeat(43) }); f.coordinator.accept(run); await settled()
    expect(f.commit).toHaveBeenCalledTimes(1)
  })
  it('invalidation aborts pending reads and releases the node for a new session', async () => {
    const f = fixture(), pending = deferred(); f.read.mockReturnValue(pending.promise)
    const token = f.coordinator.begin('tool', 'current', f.graph(), [a])!, done = f.coordinator.resolve(token, [a])
    f.coordinator.invalidate(); expect(token.controller.signal.aborted).toBe(true)
    pending.resolve(asset()); await done; expect(f.commit).not.toHaveBeenCalled(); expect(f.notice).not.toHaveBeenCalled()
    expect(f.coordinator.begin('tool', 'current', f.graph(), [a])).not.toBeNull()
  })
  it('rejects deleted or wrong assets and a read failure without partially placing a batch', async () => {
    for (const response of [asset(b), { ...asset(), deletedAt: 'now' }]) {
      const f = fixture(); f.read.mockResolvedValue(response)
      const token = f.coordinator.begin('tool', 'all', f.graph(), [a, b])!; f.ids([a, b]); await f.coordinator.resolve(token, [a, b]); expect(f.commit).not.toHaveBeenCalled()
    }
    const f = fixture(); f.read.mockRejectedValue(new Error('不可读取')); const token = f.coordinator.begin('tool', 'current', f.graph(), [a])!; await f.coordinator.resolve(token, [a]); expect(f.notice).toHaveBeenCalledWith('不可读取')
  })
})

it('rejects an asynchronously resolved output after changing the tile source slot', async () => {
  const f = fixture(), pending = deferred(); f.read.mockReturnValue(pending.promise)
  f.change((g) => {
    g.nodes[1].kind = 'image-tile'; g.nodes[1].data.imageTransform = defaultImageTransformRecipe('tile')
    g.nodes[1].data.tileInput = { edgeId: 'edge', outputIndex: 0 }; g.edges[0].targetHandle = 'in:image'
    g.edges.push({ ...g.edges[0], id: 'second' })
  })
  const token = f.coordinator.begin('tool', 'current', f.graph(), [a])!, completion = f.coordinator.resolve(token, [a])
  f.change((g) => { g.nodes[1].data.tileInput = { edgeId: 'second', outputIndex: 0 } })
  pending.resolve(asset()); await completion
  expect(f.commit).not.toHaveBeenCalled(); expect(f.coordinator.pending('tool')).toBe(false)
})
