import { randomUUID } from 'node:crypto'

export interface WindowCloseReport {
  blockingTask: boolean
  unsavedChanges: boolean
}

export interface WindowCloseQueryOptions {
  /**
   * A renderer can only answer after its preload and close listener are
   * installed. Hosts should return false while the page is loading or after
   * the renderer has crashed; in that state there is no live UI state to
   * query and waiting for the timeout would make the native window appear
   * stuck.
   */
  isRendererReady?: () => boolean
}

export function parseWindowCloseReport(value: unknown): WindowCloseReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('窗口退出状态格式错误')
  const record = value as Record<string, unknown>
  if (typeof record.blockingTask !== 'boolean' || typeof record.unsavedChanges !== 'boolean') throw new Error('窗口退出状态格式错误')
  return { blockingTask: record.blockingTask, unsavedChanges: record.unsavedChanges }
}

export function createWindowCloseQuery(
  send: (requestId: string) => void,
  timeoutMs = 15_000,
  options: WindowCloseQueryOptions = {},
) {
  let pending: { id: string; promise: Promise<WindowCloseReport>; resolve(value: WindowCloseReport): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null
  const clear = () => { if (pending) clearTimeout(pending.timer); pending = null }
  const rendererReady = (): boolean => {
    if (!options.isRendererReady) return true
    try { return options.isRendererReady() }
    catch { return false }
  }
  const resolveUnavailable = (): void => {
    if (!pending) return
    const resolve = pending.resolve
    clear()
    resolve({ blockingTask: false, unsavedChanges: false })
  }
  return {
    request(): Promise<WindowCloseReport> {
      if (pending) {
        const existing = pending.promise
        if (!rendererReady()) resolveUnavailable()
        return existing
      }
      if (!rendererReady()) return Promise.resolve({ blockingTask: false, unsavedChanges: false })
      const id = randomUUID()
      let resolve!: (value: WindowCloseReport) => void
      let reject!: (error: Error) => void
      const promise = new Promise<WindowCloseReport>((accept, fail) => { resolve = accept; reject = fail })
      const timer = setTimeout(() => {
        if (pending?.id !== id) return
        clear()
        reject(new Error('界面未能完成退出检查，请稍后重试'))
      }, timeoutMs)
      pending = { id, promise, resolve, reject, timer }
      try { send(id) } catch { clear(); reject(new Error('无法向界面请求退出状态')) }
      return promise
    },
    reply(id: string, report: WindowCloseReport): boolean {
      if (!pending || pending.id !== id) return false
      const resolve = pending.resolve
      clear()
      resolve(report)
      return true
    },
    rendererUnavailable(): boolean {
      const existed = Boolean(pending)
      resolveUnavailable()
      return existed
    },
    dispose() {
      const reject = pending?.reject
      clear()
      reject?.(new Error('窗口已关闭'))
    },
  }
}
