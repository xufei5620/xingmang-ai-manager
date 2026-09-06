export type CanvasClosePhase = 'draft' | 'confirm' | 'waiting' | 'saving'
export type CanvasCloseChoice = 'wait' | 'stop' | 'cancel'

export interface CanvasCloseGuardOptions {
  hasPendingWork(): boolean
  hasPendingDraft?(): boolean
  chooseAction(): Promise<CanvasCloseChoice>
  dismissChoice(): void
  stopPendingWork(requestId: string): Promise<boolean>
  saveLatest(): Promise<void>
  finishClose(requestId: string, allowed: boolean): Promise<boolean>
  onPhase(phase: CanvasClosePhase | null): void
  onError(error: unknown): void
  pause?(): Promise<void>
}

export function createCanvasCloseGuard(options: CanvasCloseGuardOptions) {
  let current: { requestId: string; promise: Promise<void> } | null = null
  let disposed = false
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 80)))
  const cancel = (requestId: string) => {
    if (current?.requestId !== requestId) return
    current = null
    options.dismissChoice()
    if (!disposed) options.onPhase(null)
  }
  return {
    request(requestId: string): Promise<void> {
      if (disposed) return Promise.resolve()
      if (current?.requestId === requestId) return current.promise
      if (current) cancel(current.requestId)
      const request = { requestId, promise: Promise.resolve() }
      current = request
      const active = () => !disposed && current === request
      request.promise = Promise.resolve().then(async () => {
        if (!active()) return
        try {
          if (options.hasPendingDraft?.()) {
            options.onPhase('draft')
            const choice = await options.chooseAction()
            if (!active()) return
            if (choice !== 'stop') {
              await options.finishClose(requestId, false)
              cancel(requestId)
              return
            }
          }
          if (options.hasPendingWork()) {
            options.onPhase('confirm')
            const choice = await options.chooseAction()
            if (!active()) return
            if (choice === 'cancel') {
              await options.finishClose(requestId, false)
              cancel(requestId)
              return
            }
            options.onPhase('waiting')
            if (choice === 'stop' && !await options.stopPendingWork(requestId)) {
              cancel(requestId)
              return
            }
            while (active() && options.hasPendingWork()) await pause()
          }
          if (!active()) return
          options.onPhase('saving')
          await options.saveLatest()
          if (!active()) return
          if (!await options.finishClose(requestId, true)) cancel(requestId)
          // An accepted reply stays locked until the native window is closed,
          // or the host revokes the request through its cancellation event.
        } catch (error) {
          if (!active()) return
          options.onError(error)
          try { await options.finishClose(requestId, false) } catch { /* The host timeout also fails closed. */ }
          cancel(requestId)
        }
      })
      return request.promise
    },
    cancel,
    dispose() {
      disposed = true
      if (current) cancel(current.requestId)
    },
  }
}
