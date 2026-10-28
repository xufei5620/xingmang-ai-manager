import { describe, expect, it, vi } from 'vitest'
import { createLayerGrabCutRunner, runLayerGrabCutSelection, type LayerGrabCutWorker } from './layer-grabcut-client'
import type { LayerGrabCutInput } from './layer-grabcut-selection'

vi.mock('./layer-grabcut-worker?worker', () => ({ default: class { constructor() { throw new DOMException('file:///private/worker.ts cannot be accessed', 'SecurityError') } } }))

function input(): LayerGrabCutInput { return { width: 7, height: 7, data: new Uint8ClampedArray(7 * 7 * 4).fill(255), region: { x: 1, y: 1, width: 5, height: 5 }, strokes: [] } }
function fakeWorker() {
  const worker: LayerGrabCutWorker = { onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn(), terminate: vi.fn() }
  function message(data: unknown) { worker.onmessage?.({ data } as MessageEvent<unknown>) }
  function complete() {
    message({ type: 'ready' })
    for (let iteration = 1; iteration <= 3; iteration++) message({ type: 'progress', iteration, total: 3 })
    const mask = new Uint8Array(25); mask[12] = 1
    message({ type: 'complete', mask })
  }
  return { worker, message, complete }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }

describe('disposable GrabCut worker lifecycle', () => {
  it('reports a worker-construction security failure in Chinese without leaking its internal URL', async () => {
    vi.stubGlobal('Worker', class {})
    try { await expect(runLayerGrabCutSelection(input())).rejects.toThrow('无法启动本地前景分割线程') }
    finally { vi.unstubAllGlobals() }
  })
  it('transfers only bounded copied pixels, preserves the source and terminates after a complete result', async () => {
    const f = fakeWorker(), started = deferred<void>(), run = createLayerGrabCutRunner(() => { started.resolve(); return f.worker }), onProgress = vi.fn()
    const source = input(), before = source.data.slice(), pending = run(source, { onProgress })
    await started.promise
    f.complete()
    expect(await pending).toEqual({ width: 7, height: 7, runs: [24, 1] })
    const post = vi.mocked(f.worker.postMessage).mock.calls[0]
    expect(post[0].input.rgba).toHaveLength(5 * 5 * 4)
    expect(post[1]).toEqual([post[0].input.rgba.buffer, post[0].input.labels.buffer])
    expect(source.data).toEqual(before)
    expect(f.worker.terminate).toHaveBeenCalledOnce()
    expect(onProgress.mock.calls.map(([value]) => value.phase)).toEqual(['preparing', 'loading', 'segmenting', 'segmenting', 'segmenting', 'segmenting', 'encoding'])
  })

  it('terminates an uninterruptible native job immediately when its owner aborts and ignores late completion', async () => {
    const f = fakeWorker(), started = deferred<void>(), controller = new AbortController(), run = createLayerGrabCutRunner(() => { started.resolve(); return f.worker })
    const pending = run(input(), { signal: controller.signal }), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await started.promise
    f.message({ type: 'ready' })
    const late = f.worker.onmessage!
    controller.abort()
    await rejected
    expect(f.worker.terminate).toHaveBeenCalledOnce()
    expect(f.worker.onmessage).toBeNull()
    late({ data: { type: 'complete', mask: new Uint8Array(25).fill(1) } } as MessageEvent<unknown>)
    expect(f.worker.terminate).toHaveBeenCalledOnce()
  })

  it('replaces an active job without queuing and does not cancel the new owner during old cleanup', async () => {
    const first = fakeWorker(), second = fakeWorker(), firstStarted = deferred<void>(), secondStarted = deferred<void>()
    let count = 0
    const run = createLayerGrabCutRunner(() => { if (++count === 1) { firstStarted.resolve(); return first.worker }; secondStarted.resolve(); return second.worker })
    const old = run(input()), rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    await firstStarted.promise
    first.message({ type: 'ready' })
    const latest = run(input())
    await secondStarted.promise
    await rejected
    second.complete()
    expect((await latest).runs).toEqual([24, 1])
    expect(first.worker.terminate).toHaveBeenCalledOnce()
    expect(second.worker.terminate).toHaveBeenCalledOnce()
  })

  it.each(['loading', 'processing'] as const)('terminates on the bounded %s deadline', async (phase) => {
    vi.useFakeTimers()
    try {
      const f = fakeWorker(), started = deferred<void>(), run = createLayerGrabCutRunner(() => { started.resolve(); return f.worker }, { loading: 20, processing: 30 })
      const pending = run(input()), rejected = expect(pending).rejects.toMatchObject({ code: 'time-budget' })
      await started.promise
      if (phase === 'processing') f.message({ type: 'ready' })
      await vi.advanceTimersByTimeAsync(phase === 'loading' ? 20 : 30)
      await rejected
      expect(f.worker.terminate).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it.each(['invalid-size', 'partial', 'duplicate-ready', 'error'] as const)('fails closed for %s worker messages and releases the worker', async (kind) => {
    const f = fakeWorker(), started = deferred<void>(), run = createLayerGrabCutRunner(() => { started.resolve(); return f.worker })
    const pending = run(input()), rejected = expect(pending).rejects.toThrow()
    await started.promise
    f.message({ type: 'ready' })
    if (kind === 'invalid-size') { for (let iteration = 1; iteration <= 3; iteration++) f.message({ type: 'progress', iteration, total: 3 }); f.message({ type: 'complete', mask: new Uint8Array(24) }) }
    if (kind === 'partial') f.message({ type: 'complete', mask: new Uint8Array(25) })
    if (kind === 'duplicate-ready') f.message({ type: 'ready' })
    if (kind === 'error') f.worker.onerror?.({} as ErrorEvent)
    await rejected
    expect(f.worker.terminate).toHaveBeenCalledOnce()
  })

  it('does not create a worker for cancelled or oversized inputs', async () => {
    const createWorker = vi.fn(() => fakeWorker().worker), run = createLayerGrabCutRunner(createWorker), controller = new AbortController()
    controller.abort()
    await expect(run(input(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const source = input()
    await expect(run({ ...source, width: 1001, height: 1000, data: new Uint8Array(1001 * 1000 * 4), region: { x: 0, y: 0, width: 1001, height: 1000 } })).rejects.toMatchObject({ code: 'too-complex' })
    expect(createWorker).not.toHaveBeenCalled()
  })

  it('does not submit after a progress callback cancels the active job', async () => {
    const f = fakeWorker(), started = deferred<void>(), controller = new AbortController(), run = createLayerGrabCutRunner(() => { started.resolve(); return f.worker })
    const pending = run(input(), { signal: controller.signal, onProgress(value) { if (value.phase === 'segmenting') controller.abort() } }), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await started.promise
    f.message({ type: 'ready' })
    await rejected
    expect(f.worker.postMessage).not.toHaveBeenCalled()
    expect(f.worker.terminate).toHaveBeenCalledOnce()
  })

  it('rejects a binary mask protocol violation without exposing a partial selection', async () => {
    const f = fakeWorker(), started = deferred<void>(), run = createLayerGrabCutRunner(() => { started.resolve(); return f.worker })
    const pending = run(input()), rejected = expect(pending).rejects.toThrow('二值')
    await started.promise
    f.message({ type: 'ready' })
    for (let iteration = 1; iteration <= 3; iteration++) f.message({ type: 'progress', iteration, total: 3 })
    f.message({ type: 'complete', mask: new Uint8Array(25).fill(3) })
    await rejected
    expect(f.worker.terminate).toHaveBeenCalledOnce()
  })
})
