import type { XingmangApi } from '../../../../electron/ipc-contract'

const repeatWindowMs = 30000
const trackedKeys = 20

type RuntimeErrorReport = { message: string; stack?: string; context: string }
type OpenWindow = { suppressed: number; report: RuntimeErrorReport; timer: ReturnType<typeof setTimeout> }

function describeRuntimeError(error: unknown): { message: string; stack?: string } {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '界面异步操作发生异常'
  return { message, stack: error instanceof Error ? error.stack?.slice(0, 6000) : undefined }
}

function repeatSummaryMessage(message: string, repeats: number): string {
  return `${message}（随后 30 秒内重复 ${repeats} 次）`
}

export function createRuntimeErrorReporter(native: Pick<XingmangApi, 'reportRendererError'>) {
  const open = new Map<string, OpenWindow>()
  function send(report: RuntimeErrorReport, message: string) {
    void native.reportRendererError({ message: message.slice(0, 2000), stack: report.stack, context: report.context }).catch(() => undefined)
  }
  function forget(key: string) {
    const entry = open.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    open.delete(key)
  }
  function report(error: unknown, context: string) {
    const described = describeRuntimeError(error)
    const key = `${context}:${described.message}`.slice(0, 500)
    const current = open.get(key)
    // Collapsing a burst into its first occurrence alone hides how often a failing
    // request was retried, which is the one thing the log is read for. Only the
    // first one is reported live; the window closes with a count of the rest.
    if (current) {
      current.suppressed += 1
      return
    }
    if (open.size >= trackedKeys) forget(open.keys().next().value!)
    const entry: OpenWindow = {
      suppressed: 0,
      report: { message: described.message, stack: described.stack, context },
      timer: setTimeout(() => {
        const closed = open.get(key)
        open.delete(key)
        if (closed && closed.suppressed > 0) send(closed.report, repeatSummaryMessage(closed.report.message, closed.suppressed))
      }, repeatWindowMs),
    }
    open.set(key, entry)
    send(entry.report, entry.report.message)
  }
  return {
    report,
    dispose: () => {
      for (const key of [...open.keys()]) forget(key)
    },
  }
}

export function attachRuntimeReporting(native: XingmangApi) {
  const reporter = createRuntimeErrorReporter(native)
  const onError = (event: ErrorEvent) => reporter.report(event.error ?? event.message, 'renderer-v2 window.error')
  const onRejection = (event: PromiseRejectionEvent) => reporter.report(event.reason, 'renderer-v2 unhandledrejection')
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); reporter.dispose() }
}
