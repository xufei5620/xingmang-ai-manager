export interface InstallationQueueSnapshot {
  activeKey: string | null
  pendingKeys: string[]
}

export interface InstallationQueueEntryOptions {
  /**
   * 还在排队时这个信号被中止，这一项就直接出队，用信号的 reason 拒绝：任务一行都不跑，
   * 也不用等前面那项做完。已经轮到它的不归队列管，由任务自己看这个信号。
   */
  signal?: AbortSignal
}

interface QueueEntry<T> {
  key: string
  task: () => Promise<T> | T
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
  promise: Promise<T>
  /** 轮到它时摘掉「排队时取消就出队」的监听；没传信号时什么都不做。 */
  detach: () => void
}

/**
 * Serializes machine-wide installation writes and operations that must not
 * observe an installation half-way through an atomic replacement. Entries
 * with the same key share one promise so double clicks cannot duplicate work.
 */
export class InstallationQueue {
  private active: QueueEntry<unknown> | null = null
  private readonly pending: QueueEntry<unknown>[] = []
  private changes = 0
  private readonly listeners = new Set<(snapshot: InstallationQueueSnapshot) => void>()

  enqueue<T>(key: string, task: () => Promise<T> | T, options: InstallationQueueEntryOptions = {}): Promise<T> {
    if (!key.trim()) throw new TypeError('安装队列操作名不能为空')
    const existing = this.findExisting<T>(key)
    if (existing) return existing
    const { signal } = options
    // 进队之前就取消了的，和排着队时取消一样：不进队列，直接拒绝。
    if (signal?.aborted) return Promise.reject(signal.reason)

    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    const entry: QueueEntry<T> = { key, task, resolve, reject, promise, detach: () => undefined }
    if (signal) {
      const leave = () => this.leave(entry as QueueEntry<unknown>, signal.reason)
      signal.addEventListener('abort', leave, { once: true })
      entry.detach = () => signal.removeEventListener('abort', leave)
    }
    this.pending.push(entry as QueueEntry<unknown>)
    void this.pump()
    return promise
  }

  snapshot(): InstallationQueueSnapshot {
    return {
      activeKey: this.active?.key ?? null,
      pendingKeys: this.pending.map((entry) => entry.key),
    }
  }

  /**
   * 每有一项开始或结束就加一。拿它判断「这段时间里机器上的安装状态有没有可能
   * 变过」：两次读数相同，中间就没有任何安装、卸载开始或结束。
   */
  get revision(): number {
    return this.changes
  }

  /**
   * 每有一项开始或结束就通知一次，带上那一刻的快照。监听方出错不影响队列本身。
   */
  onChange(listener: (snapshot: InstallationQueueSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get busy(): boolean {
    return this.active !== null || this.pending.length > 0
  }

  private findExisting<T>(key: string): Promise<T> | null {
    if (this.active?.key === key) return this.active.promise as Promise<T>
    const pending = this.pending.find((entry) => entry.key === key)
    return pending ? pending.promise as Promise<T> : null
  }

  private async pump(): Promise<void> {
    if (this.active || this.pending.length === 0) return
    this.active = this.pending.shift() ?? null
    const entry = this.active
    if (!entry) return
    entry.detach()
    this.changes++
    this.notify()
    try {
      entry.resolve(await entry.task())
    } catch (error) {
      entry.reject(error)
    } finally {
      this.changes++
      this.active = null
      // 先接上下一项再通知：一项接一项排着装时，中间不会出现一瞬间的「空了」。
      void this.pump()
      if (!this.active) this.notify()
    }
  }

  /**
   * 排着队时取消的那一项出队。它没开始过，机器上什么都没动，所以 revision 不变，
   * 也不通知（通知只报开始和结束）。
   */
  private leave(entry: QueueEntry<unknown>, reason: unknown): void {
    const index = this.pending.indexOf(entry)
    if (index === -1) return
    this.pending.splice(index, 1)
    entry.reject(reason)
  }

  private notify(): void {
    if (this.listeners.size === 0) return
    const snapshot = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // 监听方只是旁观，它的错误不能让安装本身失败。
      }
    }
  }
}
