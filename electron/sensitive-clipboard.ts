/**
 * 复制出去的密钥、找回密码后的新密码，60 秒后从剪贴板里清掉。密钥能直接花用户的钱，
 * 留在剪贴板里等于摆在所有程序面前，一次手滑的 Ctrl+V 就贴进了聊天框。
 *
 * 只清自己放进去的那一段：到点时剪贴板里已经换成用户新复制的东西，就一点不动。
 * 这里只比较文本，所以用户碰巧又复制了同一段密钥，也会一起清掉——那段本来就是
 * 该清的内容，不算误伤。
 */

export const SENSITIVE_CLIPBOARD_CLEAR_MS = 60_000

export interface SensitiveClipboardTarget {
  readText(): string
  writeText(text: string): void
  clear(): void
}

export interface SensitiveClipboardTimers {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

export interface SensitiveClipboard {
  write(text: string): void
  /** 退出时调用：还没到点的那段也清掉，不能因为软件关了就一直留在剪贴板里。 */
  dispose(): void
}

function defaultTimers(): SensitiveClipboardTimers {
  return {
    set(callback, delayMs) {
      const handle = setTimeout(callback, delayMs)
      // A pending wipe must not keep the main process alive on quit; dispose()
      // does the final wipe instead.
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
  let pending: { text: string; handle: unknown } | null = null

  function wipeIfUnchanged(text: string) {
    // Reading the clipboard can throw when another process holds it open
    // (Windows). Leaving the secret in place is the only outcome available
    // then; it must not surface as a crash in the main process.
    try {
      if (clipboard.readText() === text) clipboard.clear()
    } catch {
      // Nothing else to do.
    }
  }

  function cancelPending() {
    if (!pending) return
    timers.clear(pending.handle)
    pending = null
  }

  return {
    write(text) {
      // The previous secret is replaced on the clipboard by this write, so
      // its own timer has nothing left to protect.
      cancelPending()
      clipboard.writeText(text)
      if (!text) return
      const entry: { text: string; handle: unknown } = { text, handle: undefined }
      entry.handle = timers.set(() => {
        if (pending === entry) pending = null
        wipeIfUnchanged(text)
      }, delayMs)
      pending = entry
    },
    dispose() {
      if (!pending) return
      const { text } = pending
      cancelPending()
      wipeIfUnchanged(text)
    },
  }
}
