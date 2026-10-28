import { describe, expect, it, vi } from 'vitest'
import { createLayerPreviewScheduler } from './layer-preview-task'

function deferred() { let resolve!: () => void, reject!: (error: unknown) => void; const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
function job(name: string) {
  const pending = deferred(), resource = { name }, current = vi.fn(() => true)
  return { ...pending, resource, current, input: { current, create: vi.fn(() => resource), paint: vi.fn((_value: typeof resource, _signal: AbortSignal) => pending.promise), publish: vi.fn((_value: typeof resource) => false), dispose: vi.fn((_value: typeof resource) => {}), fail: vi.fn() } }
}

describe('bounded asynchronous layer preview scheduler', () => {
  it('allocates one raster at a time and lets the latest queued frame replace a cancelled one', async () => {
    const scheduler = createLayerPreviewScheduler(), first = job('first'), obsolete = job('obsolete'), latest = job('latest')
    const a = scheduler.schedule(first.input), b = scheduler.schedule(obsolete.input), c = scheduler.schedule(latest.input)
    await Promise.resolve()
    expect(first.input.create).toHaveBeenCalledOnce(); expect(obsolete.input.create).not.toHaveBeenCalled(); expect(latest.input.create).not.toHaveBeenCalled()
    b.cancel(); await b.done
    a.cancel(); expect(first.input.paint.mock.calls[0][1].aborted).toBe(true)
    first.resolve(); await a.done; await Promise.resolve(); await Promise.resolve()
    expect(first.input.publish).not.toHaveBeenCalled(); expect(first.input.dispose).toHaveBeenCalledOnce()
    expect(obsolete.input.create).not.toHaveBeenCalled(); expect(latest.input.create).toHaveBeenCalledOnce()
    latest.resolve(); await c.done
    expect(latest.input.publish).toHaveBeenCalledExactlyOnceWith(latest.resource)
    expect(latest.input.dispose).toHaveBeenCalledExactlyOnceWith(latest.resource)
  })

  it('rejects a completed old render even before React effect cleanup runs', async () => {
    const scheduler = createLayerPreviewScheduler(), old = job('old')
    const task = scheduler.schedule(old.input); await Promise.resolve()
    old.current.mockReturnValue(false); old.resolve(); await task.done
    expect(old.input.publish).not.toHaveBeenCalled(); expect(old.input.dispose).toHaveBeenCalledOnce(); expect(old.input.fail).not.toHaveBeenCalled()
  })

  it('never allocates a superseded queued render or a cancelled same-tick effect', async () => {
    const scheduler = createLayerPreviewScheduler(), first = job('first')
    const task = scheduler.schedule(first.input); task.cancel(); await task.done
    expect(first.input.create).not.toHaveBeenCalled(); expect(first.input.publish).not.toHaveBeenCalled()
    const stale = job('stale'); stale.current.mockReturnValue(false)
    await scheduler.schedule(stale.input).done
    expect(stale.input.create).not.toHaveBeenCalled()
  })

  it('transfers only complete retained surfaces and releases failed surfaces before continuing', async () => {
    const scheduler = createLayerPreviewScheduler(), complete = job('cache'), broken = job('broken'), next = job('next')
    complete.input.publish.mockReturnValue(true)
    const a = scheduler.schedule(complete.input), b = scheduler.schedule(broken.input), c = scheduler.schedule(next.input)
    complete.resolve(); await a.done
    expect(complete.input.dispose).not.toHaveBeenCalled()
    broken.reject(new Error('不可用字体')); await b.done
    expect(broken.input.publish).not.toHaveBeenCalled(); expect(broken.input.dispose).toHaveBeenCalledOnce(); expect(broken.input.fail).toHaveBeenCalledOnce()
    next.resolve(); await c.done
    expect(next.input.publish).toHaveBeenCalledOnce()
  })

  it('suppresses late errors on cancellation and releases the unfinished frame', async () => {
    const scheduler = createLayerPreviewScheduler(), aborted = job('cancelled')
    const task = scheduler.schedule(aborted.input); await Promise.resolve(); task.cancel()
    aborted.reject(new Error('late painter failure')); await task.done
    expect(aborted.input.fail).not.toHaveBeenCalled(); expect(aborted.input.dispose).toHaveBeenCalledOnce()
  })
})
