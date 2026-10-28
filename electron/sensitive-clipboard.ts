/**
 * 复制出去的密钥、找回密码后的新密码，60 秒后从剪贴板里清掉。密钥能直接花用户的钱，
 * 留在剪贴板里等于摆在所有程序面前，一次手滑的 Ctrl+V 就贴进了聊天框。
 *
 * 只清自己放进去的那一段：到点时剪贴板里已经换成用户新复制的东西，就一点不动。
 * 这里只比较文本，所以用户碰巧又复制了同一段密钥，也会一起清掉——那段本来就是
 * 该清的内容，不算误伤。
 *
 * Electron 44 起剪贴板的读写都是异步的（官方破坏性改动「clipboard module rearchitected」），
 * 只有清空还是当场做完。读回来比对和清空之间隔着一次等待，这几毫秒里用户恰好复制了
 * 别的东西就会被一起清掉；这个接口没有更窄的做法。
 */

export const SENSITIVE_CLIPBOARD_CLEAR_MS = 60_000

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
  timers?: SensitiveClipboardTimers
}): SensitiveClipboard {
  const { clipboard } = options
  const delayMs = options.delayMs ?? SENSITIVE_CLIPBOARD_CLEAR_MS
  const timers = options.timers ?? defaultTimers()
  // Set before the write lands, so a flush that arrives while it is still in
  // flight knows which text to look for; the timer is attached once it lands.
  let pending: { text: string; handle: unknown } | null = null

  async function wipeIfUnchanged(text: string): Promise<void> {
    // Reading the clipboard can fail when another process holds it open
    // (Windows). Leaving the secret in place is the only outcome available
    // then; it must not surface as a crash in the main process.
    try {
      if (await clipboard.readText() === text) clipboard.clear()
    } catch {
      // Nothing else to do.
    }
  }

  function cancelPending() {
    if (!pending) return
    if (pending.handle !== undefined) timers.clear(pending.handle)
    pending = null
  }

  async function flush(): Promise<void> {
    if (!pending) return
    const { text } = pending
    cancelPending()
    await wipeIfUnchanged(text)
  }

  return {
    async write(text) {
      // The previous secret is replaced on the clipboard by this write, so
      // its own timer has nothing left to protect.
      cancelPending()
      if (!text) {
        await clipboard.writeText(text)
        return
      }
      const entry: { text: string; handle: unknown } = { text, handle: undefined }
      pending = entry
      try {
        await clipboard.writeText(text)
      } catch (error) {
        if (pending === entry) pending = null
        throw error
      }
      // A newer write, a flush or dispose took over while this one landed.
      if (pending !== entry) return
      entry.handle = timers.set(() => {
        if (pending === entry) pending = null
        void wipeIfUnchanged(text)
      }, delayMs)
    },
    flush,
    dispose() {
      void flush()
    },
  }
}
