/**
 * 复制出去的密钥、找回密码后的新密码，60 秒后从剪贴板里清掉。密钥能直接花用户的钱，
 * 留在剪贴板里等于摆在所有程序面前，一次手滑的 Ctrl+V 就贴进了聊天框。
 *
 * 只清自己放进去的那一段：到点时剪贴板里已经换成用户新复制的东西，就一点不动。
 * 这里只比较文本，所以用户碰巧又复制了同一段密钥，也会一起清掉——那段本来就是
 * 该清的内容，不算误伤。
 *
 * 清理的责任不能半路丢：后一段写进去了，前一段才算被换掉、不用再清；后一段没写进去，
 * 前一段照原来的时间清。到点读不了剪贴板（Windows 上别的程序正占着）就隔几秒再试，
 * 试满次数才放手。
 *
 * Electron 44 起剪贴板的读写都是异步的（官方破坏性改动「clipboard module rearchitected」），
 * 只有清空还是当场做完。读回来比对和清空之间隔着一次等待，这几毫秒里用户恰好复制了
 * 别的东西就会被一起清掉；这个接口没有更窄的做法。
 */

export const SENSITIVE_CLIPBOARD_CLEAR_MS = 60_000
export const SENSITIVE_CLIPBOARD_RETRY_MS = 3_000
export const SENSITIVE_CLIPBOARD_MAX_RETRIES = 2

export interface SensitiveClipboardTarget {
  readText(): Promise<string>
  writeText(text: string): Promise<void>
  clear(): void
}

export interface SensitiveClipboardTimers {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

export interface SensitiveClipboard {
  /** 写好了才落定；写不进去照样抛给调用方，界面上好说「复制失败」。 */
  write(text: string): Promise<void>
  /**
   * 退出前调用（主窗口的 prepareToQuit）：还没到点的那段现在就清掉，不能因为软件关了就
   * 一直留在剪贴板里。落定时已经清完或确定不用清，不会 reject。
   */
  flush(): Promise<void>
  /**
   * 退出时调用（will-quit）：撤掉计时，再试一次 flush。异步读剪贴板在 will-quit 之后
   * 来不及回来（Electron 45 在 Linux 上实测，进程先退了），所以真正清掉靠前面那次 flush。
   */
  dispose(): void
}

interface PendingSecret {
  order: number
  text: string
  handle: unknown
  retries: number
}

function defaultTimers(): SensitiveClipboardTimers {
  return {
    set(callback, delayMs) {
      const handle = setTimeout(callback, delayMs)
      // A pending wipe must not keep the main process alive on quit; flush()
      // and dispose() do the final wipe instead.
      handle.unref?.()
      return handle
    },
    clear(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>) },
  }
}

export function createSensitiveClipboard(options: {
  clipboard: SensitiveClipboardTarget
  delayMs?: number
  retryMs?: number
  maxRetries?: number
  timers?: SensitiveClipboardTimers
}): SensitiveClipboard {
  const { clipboard } = options
  const delayMs = options.delayMs ?? SENSITIVE_CLIPBOARD_CLEAR_MS
  const retryMs = options.retryMs ?? SENSITIVE_CLIPBOARD_RETRY_MS
  const maxRetries = options.maxRetries ?? SENSITIVE_CLIPBOARD_MAX_RETRIES
  const timers = options.timers ?? defaultTimers()
  let issued = 0
  // Every secret whose wipe is still owed, in the order the writes were
  // issued. An entry joins before its write lands, so a flush that arrives
  // while it is in flight knows which text to look for. It leaves only when a
  // later write has landed over it, its wipe went through, its retries ran
  // out, or a flush took it; a later write that fails leaves it in place.
  const pending: PendingSecret[] = []

  // Reading the clipboard can fail when another process holds it open
  // (Windows); that must not surface as a crash in the main process. Resolves
  // to whether the clipboard could be checked at all.
  async function wipeIfUnchanged(texts: string[]): Promise<boolean> {
    try {
      if (texts.includes(await clipboard.readText())) clipboard.clear()
      return true
    } catch {
      return false
    }
  }

  function release(entry: PendingSecret) {
    const index = pending.indexOf(entry)
    if (index >= 0) pending.splice(index, 1)
    if (entry.handle !== undefined) timers.clear(entry.handle)
    entry.handle = undefined
  }

  function schedule(entry: PendingSecret, delay: number) {
    entry.handle = timers.set(() => {
      entry.handle = undefined
      void wipeOnTimer(entry)
    }, delay)
  }

  async function wipeOnTimer(entry: PendingSecret): Promise<void> {
    const checked = await wipeIfUnchanged([entry.text])
    // A flush or a later write took over while the clipboard was being read.
    if (!pending.includes(entry)) return
    if (checked || entry.retries >= maxRetries) {
      release(entry)
      return
    }
    entry.retries += 1
    schedule(entry, retryMs)
  }

  async function flush(): Promise<void> {
    if (pending.length === 0) return
    const texts = pending.map((entry) => entry.text)
    for (const entry of [...pending]) release(entry)
    await wipeIfUnchanged(texts)
  }

  return {
    async write(text) {
      const order = ++issued
      const entry: PendingSecret | null = text ? { order, text, handle: undefined, retries: 0 } : null
      if (entry) pending.push(entry)
      try {
        await clipboard.writeText(text)
      } catch (error) {
        // Whatever an earlier write put there is still on the clipboard, so
        // its wipe stays owed.
        if (entry) release(entry)
        throw error
      }
      // This write has replaced what every earlier one put on the clipboard,
      // so their wipes have nothing left to protect.
      for (const earlier of pending.filter((item) => item.order < order)) release(earlier)
      // A later write that landed first, a flush or dispose took over.
      if (entry && pending.includes(entry)) schedule(entry, delayMs)
    },
    flush,
    dispose() {
      void flush()
    },
  }
}
