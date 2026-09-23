export type RendererCrashChoice = 'reload' | 'dismiss'
export type RendererCrashEvent = 'reload.auto' | 'prompt.shown' | 'prompt.reload' | 'prompt.dismiss'

export interface RendererCrashRecoveryOptions {
  reload(): void
  prompt(): Promise<RendererCrashChoice>
  log(event: RendererCrashEvent): void
  onError(error: unknown): void
  now?: () => number
}

export interface RendererCrashRecovery {
  handleGone(reason: string): void
  dispose(): void
}

// 页面进程被系统回收（内存紧张时常见）或崩了以后，窗口只剩一块空白，旧版本
// 只记日志，用户只能从托盘退出重开。偶尔一次直接重载就好；一分钟里第三次
// 说明重载也救不回来，再自动重载只会一直闪，改成问用户。
const automaticReloadLimit = 2
const automaticReloadWindowMs = 60_000

export function createRendererCrashRecovery(options: RendererCrashRecoveryOptions): RendererCrashRecovery {
  const now = options.now ?? Date.now
  const reloads: number[] = []
  let prompting = false
  let disposed = false

  const report = (error: unknown) => {
    try { options.onError(error) } catch { /* Error reporting cannot throw out of an event handler. */ }
  }
  const write = (event: RendererCrashEvent) => {
    try { options.log(event) } catch (error) { report(error) }
  }
  const reload = () => {
    if (disposed) return
    try { options.reload() } catch (error) { report(error) }
  }

  return {
    handleGone(reason) {
      // An orderly teardown reaches `render-process-gone` on some shutdown
      // paths; there is nothing to bring back.
      if (disposed || reason === 'clean-exit' || prompting) return
      const at = now()
      while (reloads.length > 0 && at - reloads[0] >= automaticReloadWindowMs) reloads.shift()
      if (reloads.length < automaticReloadLimit) {
        reloads.push(at)
        write('reload.auto')
        reload()
        return
      }
      prompting = true
      write('prompt.shown')
      void Promise.resolve()
        .then(() => options.prompt())
        .then((choice) => {
          if (choice !== 'reload') { write('prompt.dismiss'); return }
          write('prompt.reload')
          // The user asked for this one: it starts a fresh count.
          reloads.length = 0
          reloads.push(now())
          reload()
        }, report)
        .finally(() => { prompting = false })
    },
    dispose() { disposed = true },
  }
}
