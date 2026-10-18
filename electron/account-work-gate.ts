/**
 * 先在安装队列里排队、轮到了才执行的活（命令行工具和 Codex 桌面端的「打开」，#1085）。
 * 排着队那段不算账号工作：前面那次安装可能要十几分钟，换账号、退出、重新登录不该陪它等，
 * 等满 30 秒就报「账号服务请求超时」。
 */
export interface QueuedAccountWork {
  /** 换账号一开始，还在排队的就由它出队（交给 InstallationQueue 的 signal）。 */
  readonly signal: AbortSignal
  /** 轮到它执行时调用：从这里起才算账号工作。排队期间换过账号或正在换，就一行都不跑。 */
  run<T>(operation: () => Promise<T>): Promise<T>
  /**
   * run 交出去的那段做完以后（Codex 桌面端已经发出启动请求，只剩等窗口、换中文），还要替这次点击碰一下
   * 账号（补连加速）之前问一句：点的时候那个账号还在、也没在换。换过或正在换，就别做了。
   */
  isCurrent(): boolean
}

const staleAccountMessage = '账号上下文已变化，请重试'

/** Track complete host handlers, including their final local writes, while an account changes. */
export function createAccountWorkGate(options: { assertReady(): void; revision(): number }) {
  const pending = new Set<Promise<unknown>>()
  const queued = new Set<AbortController>()
  function run<T>(operation: () => T, resultOptions: { checkRevision?: boolean } = {}): T {
    options.assertReady()
    const revision = options.revision()
    function assertCurrent(): void {
      if (resultOptions.checkRevision === false) return
      if (options.revision() !== revision) throw new Error(staleAccountMessage)
    }
    const value = operation()
    if (value && typeof (value as { then?: unknown }).then === 'function') {
      const tracked = Promise.resolve(value).then((result) => {
        assertCurrent()
        return result
      }, (error: unknown) => {
        assertCurrent()
        throw error
      })
      pending.add(tracked)
      void tracked.then(() => pending.delete(tracked), () => pending.delete(tracked))
      return tracked as T
    }
    assertCurrent()
    return value
  }
  /**
   * 点下去那一刻照旧核对账号没在切换；排队期间不算进 whenIdle。调用方在这次请求结束时
   * 调 release：同一个「打开」点两下时，第二下跟着第一下那份排队，它自己的这份从没交给队列。
   */
  function queue(): QueuedAccountWork & { release(): void } {
    options.assertReady()
    const revision = options.revision()
    const controller = new AbortController()
    queued.add(controller)
    function release(): void {
      queued.delete(controller)
    }
    return {
      signal: controller.signal,
      run<T>(operation: () => Promise<T>): Promise<T> {
        release()
        // 队列认 signal，排队时叫停的不会再交出来；这里再挡一次，没接 signal 的调用方也不会跑。
        if (controller.signal.aborted) return Promise.reject(controller.signal.reason)
        // 点的时候是上一个账号：换完再轮到它，不拿新账号的配置替上一个账号打开。
        if (options.revision() !== revision) return Promise.reject(new Error(staleAccountMessage))
        try {
          return run(operation)
        } catch (error) {
          return Promise.reject(error)
        }
      },
      isCurrent(): boolean {
        try {
          options.assertReady()
        } catch {
          return false
        }
        return options.revision() === revision
      },
      release,
    }
  }
  /** 换账号开始时调用：还在排队的出队，界面那一行当场结束，不等前面的安装做完。 */
  function abortQueued(): void {
    for (const controller of queued) controller.abort(new Error(staleAccountMessage))
    queued.clear()
  }
  async function whenIdle(): Promise<void> {
    while (pending.size) await Promise.allSettled([...pending])
  }
  return { run, queue, abortQueued, whenIdle }
}

export type AccountWorkGate = ReturnType<typeof createAccountWorkGate>
