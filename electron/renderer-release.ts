import type { RendererRestartWork } from './ipc-contract'

/**
 * 主窗口缩在托盘里久了，把界面进程关掉省内存；再叫出来时重新加载（排队项「托盘关界面省内存」）。
 *
 * 2026-10-15 沙箱实测：缩到托盘以后界面进程还占着一百来兆，强制回收只省两三兆，换成空白页还剩五十兆，
 * 只有整个关掉才省得下来。窗口本身留着：Windows 关机时的清理挂在窗口上（window-lifecycle.ts 的
 * query-session-end），没有窗口 window-all-closed 还会让程序直接退出。
 *
 * 什么时候关：窗口藏起来（不是最小化）满 rendererReleaseDelayMs，界面说手上没事，主进程这边也没事
 * （mainBlocker）。有事就每 rendererReleaseRecheckMs 再看一次。刚缩下去马上又点开的人感觉不到。
 * 界面从没报告过手上有没有事的（旧回滚界面没有这一条）一律不关。
 *
 * 什么时候开：窗口要出来（show），或者主进程要界面在后台醒一下（wake，例如来了新公告：提醒不提醒
 * 要靠界面那套已读记录来判断）。重新加载那段时间要发给界面的跳转（托盘跳页、托盘打开工具、系统通知
 * 点进来）先存着，界面第一次报告手上有没有事，就算它准备好了，再一并发过去。
 *
 * 重新加载没成（本地页面一时读不出来、加载到一半界面进程没了）：还算「正在重新加载」，存着的跳转也留着，
 * 只是下次窗口出来时再加载一次（11-18 复核 U05：原先停在这里，要重启整个程序）。
 * 失败了不自己接着重试，免得一直读不出来时每隔一会儿就拉起一个界面进程；也不退回「关着」，崩溃恢复
 * 那边自己重载成功时，界面报告上来还要有人接。
 *
 * 这里只管状态和时机，真正关进程、重新加载、查主进程有没有事都由宿主给（main.ts），所以能单测。
 */

export const rendererReleaseDelayMs = 10 * 60_000
export const rendererReleaseRecheckMs = 60_000

export type RendererReleaseState = 'live' | 'released' | 'restoring'
export type RendererRestoreReason = 'show' | 'wake'

export type RendererReleaseLogEvent =
  | 'release.done'
  | 'release.deferred'
  | 'release.skipped'
  | 'restore.started'
  | 'restore.failed'
  | 'restore.ready'

export interface RendererReleaseOptions {
  delayMs?: number
  recheckMs?: number
  /** 窗口这会儿是不是缩在托盘里：看不见、也不是最小化（最小化的还在任务栏上，随时会被点开）。 */
  hiddenInTray(): boolean
  /** 主进程这边知道的、现在不能关界面的原因（日志用），没有返回 null。 */
  mainBlocker(): string | null
  /** 关掉界面进程。返回 false = 这次关不了（例如进程和别的窗口共用），这一轮不再试。 */
  release(): boolean
  /** 重新加载界面。返回加载的结果（loadURL 的 Promise）：失败了就等下次窗口出来再加载一次。 */
  reload(): Promise<unknown> | void
  /** 界面关掉了：托盘余额、余额提醒、新公告这些改由主进程在后台看着。 */
  onReleased?(): void
  /** 界面开始重新加载：主进程那套后台查看停下。 */
  onRestoring?(): void
  log(event: RendererReleaseLogEvent, detail?: Record<string, unknown>): void
  onError?(error: unknown): void
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export interface RendererRelease {
  readonly state: RendererReleaseState
  /**
   * 这次加载是不是关掉以后的重开、而且关之前窗口被看见过：开机那几句提示、开机检查、检查更新这次
   * 运行里已经摆给用户看过，不再来一遍。关之前窗口一次都没出来过（开机自启一直缩在托盘）的，照第一次
   * 打开那样再来一遍，免得用户一句都没看到。
   */
  readonly restoredBoot: boolean
  /**
   * 界面最后一次报告的是手上有事（装工具、聊天回复、出视频含拼片、同步密钥、开着对话框）。没报告过的、
   * 界面关着的都算没事：关着时那边没有活在跑。别处要「界面在忙就先别动」（例如闲时装更新）读这个。
   */
  readonly rendererBusy: boolean
  /**
   * 界面最后一次报告里、重启装更新前要点名问一句的那几样（聊天在回复或出图、视频剪辑在拼接，D10）。
   * 跟 rendererBusy 一样，没报告过的、界面关着的都算没有。
   */
  readonly rendererWork: readonly RendererRestartWork[]
  /** 窗口藏起来了（缩到托盘、开机自启没弹窗）：开始计时。 */
  noteHidden(): void
  /** 窗口出来了：不再计时；界面关着就马上重新加载。 */
  noteShown(): void
  /** 界面报告手上有没有事（装工具、聊天回复、出视频、同步密钥）。重新加载后第一次报告也算准备好了。 */
  reportActivity(busy: boolean, work?: readonly RendererRestartWork[]): void
  /** 界面关着就重新加载。返回 true = 这次加载归它管（调用方别再自己重载）。 */
  restore(reason: RendererRestoreReason): boolean
  /**
   * 界面进程没了：是不是这里自己关的。是就别当崩溃处理。不是、而且正赶上重新加载，这次重新加载就算没成，
   * 下次窗口出来再加载一次；眼下的自动重载照旧归崩溃恢复。
   */
  consumeExpectedExit(): boolean
  /** 要发给界面的跳转：界面开着就马上发；关着或正在重新加载先存着（同一个 key 只留最后一次）。 */
  deliver(key: string, send: () => void): void
  dispose(): void
}

export function createRendererRelease(options: RendererReleaseOptions): RendererRelease {
  const delayMs = options.delayMs ?? rendererReleaseDelayMs
  const recheckMs = options.recheckMs ?? rendererReleaseRecheckMs
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return timer
  })
  const clearTimer = options.clearTimer ?? ((timer: unknown) => { clearTimeout(timer as ReturnType<typeof setTimeout>) })
  let state: RendererReleaseState = 'live'
  // 界面报告过手上有没有事：旧回滚界面没有这一条，永远是 false，也就永远不关。
  let reporting = false
  let rendererBusy = false
  let rendererWork: readonly RendererRestartWork[] = []
  let expectedExit = false
  let shownOnce = false
  let restoredBoot = false
  let restoreStartedAt = 0
  // 第几次重新加载：迟到的加载结果只认最新这一次的。
  let restoreAttempt = 0
  // 最近这次重新加载没成，下次窗口出来要再加载。
  let restoreFailed = false
  let timer: unknown = null
  let deferredReason: string | null = null
  let disposed = false
  const pending = new Map<string, () => void>()

  const report = (error: unknown) => {
    try { options.onError?.(error) } catch { /* Error reporting cannot throw out of a timer. */ }
  }
  const write = (event: RendererReleaseLogEvent, detail?: Record<string, unknown>) => {
    try { options.log(event, detail) } catch (error) { report(error) }
  }
  const hidden = () => {
    try { return options.hiddenInTray() } catch (error) { report(error); return false }
  }
  const cancel = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  const schedule = (ms: number) => {
    cancel()
    if (disposed || state !== 'live') return
    timer = setTimer(check, ms)
  }
  const blocker = (): string | null => {
    if (!reporting) return 'renderer-silent'
    if (rendererBusy) return 'renderer-busy'
    try { return options.mainBlocker() } catch (error) { report(error); return 'unknown' }
  }
  const check = () => {
    timer = null
    if (disposed || state !== 'live') return
    // 窗口已经出来了：等它下次再藏起来时重新计时（noteHidden）。
    if (!hidden()) return
    const reason = blocker()
    if (reason) {
      // 同一个原因只记一次，不然装一个大工具的那十几分钟里每分钟都记一行。
      if (reason !== deferredReason) write('release.deferred', { reason })
      deferredReason = reason
      schedule(recheckMs)
      return
    }
    deferredReason = null
    expectedExit = true
    let released = false
    try { released = options.release() } catch (error) { report(error) }
    if (!released) {
      expectedExit = false
      write('release.skipped')
      return
    }
    state = 'released'
    reporting = false
    rendererBusy = false
    rendererWork = []
    write('release.done')
    try { options.onReleased?.() } catch (error) { report(error) }
  }
  const failRestore = (attempt: number, cause: 'load' | 'renderer-gone', error?: unknown) => {
    // 已经准备好了、又重新加载了一次、已经报过没成，或者窗口没了：这个结果过期了。
    if (disposed || state !== 'restoring' || attempt !== restoreAttempt || restoreFailed) return
    restoreFailed = true
    write('restore.failed', { cause })
    if (error !== undefined) report(error)
  }
  const restore = (reason: RendererRestoreReason): boolean => {
    if (disposed) return false
    if (state === 'restoring' && !restoreFailed) return true
    if (state === 'live') return false
    const retry = state === 'restoring'
    state = 'restoring'
    restoreFailed = false
    restoreAttempt += 1
    const attempt = restoreAttempt
    // 关之前窗口一次都没出来过的，这次照第一次打开来。再试的那次还是同一回重新加载，不重新算：
    // 第一次叫出窗口时没载出来，那一下不算用户看见过。
    if (!retry) restoredBoot = shownOnce
    restoreStartedAt = now()
    write('restore.started', retry ? { reason, retry: true } : { reason })
    if (!retry) {
      try { options.onRestoring?.() } catch (error) { report(error) }
    }
    let loading: Promise<unknown> | void
    try {
      loading = options.reload()
    } catch (error) {
      failRestore(attempt, 'load', error)
      return true
    }
    void Promise.resolve(loading).catch((error: unknown) => { failRestore(attempt, 'load', error) })
    return true
  }
  const flush = () => {
    const deliveries = [...pending.values()]
    pending.clear()
    for (const send of deliveries) {
      try { send() } catch (error) { report(error) }
    }
  }

  return {
    get state() { return state },
    get restoredBoot() { return restoredBoot },
    get rendererBusy() { return rendererBusy },
    get rendererWork() { return rendererWork },
    noteHidden() {
      if (disposed || state !== 'live') return
      deferredReason = null
      schedule(delayMs)
    },
    noteShown() {
      if (disposed) return
      cancel()
      // 先按「这之前出来过没有」重新加载，再记下这一次。
      restore('show')
      shownOnce = true
    },
    reportActivity(busy, work = []) {
      if (disposed || state === 'released') return
      rendererBusy = busy
      rendererWork = [...work]
      reporting = true
      if (state !== 'restoring') return
      state = 'live'
      restoreFailed = false
      // 关掉时那一声「界面进程没了」早该到了；万一没到，别让它把以后真的崩溃吞掉。
      expectedExit = false
      write('restore.ready', { ms: Math.max(0, now() - restoreStartedAt) })
      flush()
      // 后台醒一下的那次，窗口还藏着：照常从头计时，过一阵再关。
      if (hidden()) schedule(delayMs)
    },
    restore,
    consumeExpectedExit() {
      if (expectedExit) {
        expectedExit = false
        return true
      }
      failRestore(restoreAttempt, 'renderer-gone')
      return false
    },
    deliver(key, send) {
      if (disposed) return
      if (state === 'live') {
        try { send() } catch (error) { report(error) }
        return
      }
      pending.delete(key)
      pending.set(key, send)
    },
    dispose() {
      disposed = true
      cancel()
      pending.clear()
    },
  }
}
