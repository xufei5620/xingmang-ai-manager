import type { XingmangApi } from '../../../../electron/ipc-contract'

export function attachRuntimeReporting(native: XingmangApi) {
  const recent = new Map<string, number>()
  function report(error: unknown, context: string) {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '界面异步操作发生异常'
    const key = `${context}:${message}`.slice(0, 500)
    const now = Date.now()
    if (now - (recent.get(key) ?? 0) < 30000) return
    if (recent.size >= 20) recent.delete(recent.keys().next().value!)
    recent.set(key, now)
    void native.reportRendererError({ message: message.slice(0, 2000), stack: error instanceof Error ? error.stack?.slice(0, 6000) : undefined, context }).catch(() => undefined)
  }
  const onError = (event: ErrorEvent) => report(event.error ?? event.message, 'renderer-v2 window.error')
  const onRejection = (event: PromiseRejectionEvent) => report(event.reason, 'renderer-v2 unhandledrejection')
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection) }
}
