export interface BoundedOperationQueueOptions {
  maxActive: number
  maxQueued: number
}

export type BoundedOperationState = 'queued' | 'running' | 'settled'

export interface BoundedOperationCancelResult {
  canceled: boolean
  started: boolean
}

export interface BoundedOperationHandle<T> {
  readonly promise: Promise<T>
  state(): BoundedOperationState
  cancel(reason?: Error): BoundedOperationCancelResult
}

interface QueueEntry<T> {
  operation: (signal: AbortSignal) => Promise<T>
  controller: AbortController
  state: BoundedOperationState
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正整数`)
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负整数`)
  return value
}

function cancellationReason(reason: Error | undefined): Error {
  return reason ?? new Error('操作已取消')
}

/**
 * A small FIFO scheduler for expensive operations. A running slot is held
 * until the operation promise settles, even after cancellation, so a task
 * that is slow to observe AbortSignal cannot accidentally exceed maxActive.
 */
export class BoundedOperationQueue {
  private readonly maxActive: number
  private readonly maxQueued: number
  private readonly pending: QueueEntry<unknown>[] = []
  private readonly entries = new Set<QueueEntry<unknown>>()
  private activeCount = 0
  private closed = false

  constructor(options: BoundedOperationQueueOptions) {
    this.maxActive = positiveInteger(options.maxActive, '最大并发数')
    this.maxQueued = nonNegativeInteger(options.maxQueued, '最大排队数')
  }

  enqueue<T>(operation: (signal: AbortSignal) => Promise<T>): BoundedOperationHandle<T> {
    if (this.closed) throw new Error('操作队列已关闭')
    if (typeof operation !== 'function') throw new Error('队列操作无效')
    if (this.activeCount >= this.maxActive && this.pending.length >= this.maxQueued) {
      throw new Error('操作队列已满，请稍后重试')
    }

    let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined
    let rejectPromise: (reason?: unknown) => void = () => undefined
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const entry: QueueEntry<T> = {
      operation,
      controller: new AbortController(),
      state: 'queued',
      resolve: resolvePromise,
      reject: rejectPromise,
    }
    this.entries.add(entry as QueueEntry<unknown>)

    const handle: BoundedOperationHandle<T> = {
      promise,
      state: () => entry.state,
      cancel: (reason) => this.cancelEntry(entry, cancellationReason(reason)),
    }

    if (this.activeCount < this.maxActive) this.startEntry(entry)
    else this.pending.push(entry as QueueEntry<unknown>)
    return handle
  }

  shutdown(reason = new Error('操作队列已关闭')): number {
    if (this.closed) return 0
    this.closed = true
    let canceled = 0
    for (const entry of [...this.entries]) {
      if (this.cancelEntry(entry, reason).canceled) canceled += 1
    }
    return canceled
  }

  snapshot(): { active: number; queued: number; closed: boolean } {
    return { active: this.activeCount, queued: this.pending.length, closed: this.closed }
  }

  private cancelEntry<T>(entry: QueueEntry<T>, reason: Error): BoundedOperationCancelResult {
    if (entry.state === 'settled' || entry.controller.signal.aborted) {
      return { canceled: false, started: entry.state !== 'queued' }
    }
    if (entry.state === 'queued') {
      const index = this.pending.indexOf(entry as QueueEntry<unknown>)
      if (index >= 0) this.pending.splice(index, 1)
      entry.state = 'settled'
      this.entries.delete(entry as QueueEntry<unknown>)
      entry.controller.abort(reason)
      entry.reject(reason)
      return { canceled: true, started: false }
    }
    entry.controller.abort(reason)
    // Reject the caller immediately even if the underlying implementation is
    // slow to observe AbortSignal. The active slot is still held until that
    // implementation settles in startEntry().
    entry.reject(reason)
    return { canceled: true, started: true }
  }

  private startEntry<T>(entry: QueueEntry<T>): void {
    if (entry.state !== 'queued') return
    entry.state = 'running'
    this.activeCount += 1
    void Promise.resolve()
      .then(() => entry.operation(entry.controller.signal))
      .then((value) => {
        if (entry.controller.signal.aborted) throw entry.controller.signal.reason
        return value
      })
      .then(entry.resolve, entry.reject)
      .finally(() => {
        if (entry.state === 'settled') return
        entry.state = 'settled'
        this.activeCount -= 1
        this.entries.delete(entry as QueueEntry<unknown>)
        this.startNext()
      })
  }

  private startNext(): void {
    while (!this.closed && this.activeCount < this.maxActive && this.pending.length > 0) {
      const next = this.pending.shift() as QueueEntry<unknown>
      this.startEntry(next)
    }
  }
}
