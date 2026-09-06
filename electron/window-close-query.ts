import { randomUUID } from 'node:crypto'

export interface WindowCloseReport {
  blockingTask: boolean
  unsavedChanges: boolean
}

export function parseWindowCloseReport(value: unknown): WindowCloseReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('窗口退出状态格式错误')
  const record = value as Record<string, unknown>
  if (typeof record.blockingTask !== 'boolean' || typeof record.unsavedChanges !== 'boolean') throw new Error('窗口退出状态格式错误')
  return { blockingTask: record.blockingTask, unsavedChanges: record.unsavedChanges }
}

export function createWindowCloseQuery(send: (requestId: string) => void, timeoutMs = 15_000) {
  let pending: { id: string; promise: Promise<WindowCloseReport>; resolve(value: WindowCloseReport): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null
  const clear = () => { if (pending) clearTimeout(pending.timer); pending = null }
  return {
    request(): Promise<WindowCloseReport> {
      if (pending) return pending.promise
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
    dispose() {
      const reject = pending?.reject
      clear()
      reject?.(new Error('窗口已关闭'))
    },
  }
}
