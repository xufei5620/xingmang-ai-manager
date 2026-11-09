import { randomUUID } from 'node:crypto'

/**
 * 退出前先让主窗口的聊天页把手上还没交出来的那一份存一次（0.2.24 深查聊天页 C1）。
 *
 * 聊天页的自动保存等字停下才存，回复一直在出字时最多隔两秒存一次（useChatController.ts）。退出时界面
 * 进程直接被关掉，最后这一两秒的回复和刚打的字都还在界面里，没交给主进程，等写盘（chatHistoryStore.idle）
 * 也等不到它们。所以退出前的清理先发一声 chat-history:flush-requested，界面存完回 chat-history:flushed，
 * 这时它要写的已经写进去了，再去等写盘。
 *
 * 界面答不了（缩到托盘久了被关掉、崩了、还没准备好、旧回滚界面没有这一条）就不问；问了不回，等满
 * timeoutMs 照样往下退。一律不抛错：存不存得下都不能拦住用户已经选了的退出。
 */

// 退出前的清理一共只给两秒（window-lifecycle.ts 的 quitCleanupBudgetMs），留一截给后面等写盘。
export const chatHistoryFlushTimeoutMs = 1_500

export interface ChatHistoryFlushOptions {
  /** 界面这会儿答得了：窗口和界面进程都在，这次加载以后报告过手上有没有事。 */
  canAsk(): boolean
  /** 把这一次的编号发给界面。 */
  send(requestId: string): void
  timeoutMs?: number
  createId?: () => string
  onError?(error: unknown): void
}

export interface ChatHistoryFlush {
  /** 问界面要一次，界面存完回话或等满时限就交回；不抛错。正在问的时候再叫，等的是同一次。 */
  request(): Promise<void>
  /**
   * 界面回话了。只认正在等的那个编号：编号是每次随机的，只发给主窗口，别的窗口拿不到；
   * 过期的、乱填的一律不理。
   */
  acknowledge(requestId: string): void
}

export function createChatHistoryFlush(options: ChatHistoryFlushOptions): ChatHistoryFlush {
  const timeoutMs = options.timeoutMs ?? chatHistoryFlushTimeoutMs
  const createId = options.createId ?? randomUUID
  let pending: { requestId: string; promise: Promise<void>; finish: () => void } | null = null

  function report(error: unknown): void {
    try { options.onError?.(error) } catch { /* Error reporting cannot reject a quit. */ }
  }

  function ask(): boolean {
    try { return options.canAsk() } catch (error) { report(error); return false }
  }

  function request(): Promise<void> {
    if (pending) return pending.promise
    if (!ask()) return Promise.resolve()
    const requestId = createId()
    let finish!: () => void
    const promise = new Promise<void>((resolve) => { finish = resolve })
    const timer = setTimeout(() => { done() }, timeoutMs)
    function done(): void {
      clearTimeout(timer)
      if (pending?.requestId === requestId) pending = null
      finish()
    }
    pending = { requestId, promise, finish: done }
    try {
      options.send(requestId)
    } catch (error) {
      report(error)
      done()
    }
    return promise
  }

  function acknowledge(requestId: string): void {
    if (pending?.requestId === requestId) pending.finish()
  }

  return { request, acknowledge }
}
