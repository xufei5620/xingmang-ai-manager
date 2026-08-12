import { describe, expect, it, vi } from 'vitest'
import { BoundedOperationQueue } from './bounded-operation-queue'

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined
  let reject: (reason?: unknown) => void = () => undefined
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('BoundedOperationQueue', () => {
  it('runs at maxActive and starts queued operations in FIFO order', async () => {
    const queue = new BoundedOperationQueue({ maxActive: 2, maxQueued: 2 })
    const gates = [deferred<number>(), deferred<number>(), deferred<number>(), deferred<number>()]
    const started: number[] = []
    const handles = gates.map((gate, index) => queue.enqueue(async () => {
      started.push(index)
      return gate.promise
    }))

    await vi.waitFor(() => expect(started).toEqual([0, 1]))
    expect(queue.snapshot()).toEqual({ active: 2, queued: 2, closed: false })
    gates[1].resolve(1)
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]))
    gates[0].resolve(0)
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]))
    gates[2].resolve(2)
    gates[3].resolve(3)

    await expect(Promise.all(handles.map((handle) => handle.promise))).resolves.toEqual([0, 1, 2, 3])
    expect(queue.snapshot()).toEqual({ active: 0, queued: 0, closed: false })
  })

  it('rejects overflow without creating an unobserved operation promise', async () => {
    const queue = new BoundedOperationQueue({ maxActive: 1, maxQueued: 1 })
    const firstGate = deferred<void>()
    const first = queue.enqueue(() => firstGate.promise)
    const second = queue.enqueue(async () => undefined)

    expect(() => queue.enqueue(async () => undefined)).toThrow('队列已满')
    firstGate.resolve()
    await expect(first.promise).resolves.toBeUndefined()
    await expect(second.promise).resolves.toBeUndefined()
  })

  it('cancels a queued operation without invoking it or occupying a slot', async () => {
    const queue = new BoundedOperationQueue({ maxActive: 1, maxQueued: 1 })
    const gate = deferred<void>()
    const first = queue.enqueue(() => gate.promise)
    const queuedOperation = vi.fn(async () => 'never')
    const queued = queue.enqueue(queuedOperation)

    expect(queued.cancel(new Error('queued canceled'))).toEqual({ canceled: true, started: false })
    await expect(queued.promise).rejects.toThrow('queued canceled')
    expect(queuedOperation).not.toHaveBeenCalled()
    expect(queue.snapshot()).toEqual({ active: 1, queued: 0, closed: false })
    gate.resolve()
    await expect(first.promise).resolves.toBeUndefined()
  })

  it('aborts a running operation and keeps its slot until the promise settles', async () => {
    const queue = new BoundedOperationQueue({ maxActive: 1, maxQueued: 1 })
    const operation = vi.fn((signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const running = queue.enqueue(operation)
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1))

    expect(running.cancel(new Error('running canceled'))).toEqual({ canceled: true, started: true })
    expect(queue.snapshot().active).toBe(1)
    await expect(running.promise).rejects.toThrow('running canceled')
    await vi.waitFor(() => expect(queue.snapshot().active).toBe(0))
    expect(running.cancel()).toEqual({ canceled: false, started: true })
  })

  it('does not publish a late success from an operation that ignored cancellation', async () => {
    const queue = new BoundedOperationQueue({ maxActive: 1, maxQueued: 0 })
    const gate = deferred<string>()
    const running = queue.enqueue(() => gate.promise)

    expect(running.cancel(new Error('canceled before late result')))
      .toEqual({ canceled: true, started: true })
    await expect(running.promise).rejects.toThrow('canceled before late result')
    expect(queue.snapshot().active).toBe(1)
    gate.resolve('late success')
    await vi.waitFor(() => expect(queue.snapshot().active).toBe(0))
  })

  it('shutdown rejects queued work, aborts active work, and refuses new entries', async () => {
    const queue = new BoundedOperationQueue({ maxActive: 1, maxQueued: 2 })
    const runningOperation = vi.fn((signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const queuedOperation = vi.fn(async () => undefined)
    const running = queue.enqueue(runningOperation)
    const queued = queue.enqueue(queuedOperation)
    await vi.waitFor(() => expect(runningOperation).toHaveBeenCalledTimes(1))

    expect(queue.shutdown(new Error('test shutdown'))).toBe(2)
    await expect(running.promise).rejects.toThrow('test shutdown')
    await expect(queued.promise).rejects.toThrow('test shutdown')
    expect(queuedOperation).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(queue.snapshot()).toEqual({ active: 0, queued: 0, closed: true }))
    expect(queue.shutdown()).toBe(0)
    expect(() => queue.enqueue(async () => undefined)).toThrow('队列已关闭')
  })
})
