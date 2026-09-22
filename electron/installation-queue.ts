export interface InstallationQueueSnapshot {
  activeKey: string | null
  pendingKeys: string[]
}

interface QueueEntry<T> {
  key: string
  task: () => Promise<T> | T
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
  promise: Promise<T>
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

  enqueue<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    if (!key.trim()) throw new TypeError('安装队列操作名不能为空')
    const existing = this.findExisting<T>(key)
    if (existing) return existing

    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    const entry: QueueEntry<T> = { key, task, resolve, reject, promise }
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
    this.changes++
    try {
      entry.resolve(await entry.task())
    } catch (error) {
      entry.reject(error)
    } finally {
      this.changes++
      this.active = null
      void this.pump()
    }
  }
}
