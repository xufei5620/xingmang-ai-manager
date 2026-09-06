import type { AppCloseBehavior } from './window-preferences'

export type WindowCloseDecision = 'hide' | 'quit' | 'cancel'
export type WindowCloseResult = 'hidden' | 'quit-requested' | 'cancelled' | 'kept-visible' | 'failed'

export interface WindowLifecycleOptions {
  readPreference(): AppCloseBehavior
  trayAvailable(): boolean
  requestCloseDecision(): Promise<WindowCloseDecision>
  prepareToQuit(): Promise<boolean>
  flushWindowState(): Promise<void>
  show(): void
  hide(): void
  quit(): void
  onError(error: unknown): void
}

interface PreventableEvent { preventDefault(): void }
type LifecycleListener = (event: PreventableEvent) => void
interface WindowCloseSource {
  on(event: 'close', listener: LifecycleListener): unknown
  removeListener(event: 'close', listener: LifecycleListener): unknown
}
interface ApplicationQuitSource {
  on(event: 'before-quit', listener: LifecycleListener): unknown
  removeListener(event: 'before-quit', listener: LifecycleListener): unknown
}

export interface WindowLifecycle {
  readonly isQuitting: boolean
  requestClose(): Promise<WindowCloseResult>
  requestQuit(): Promise<WindowCloseResult>
  attach(window: WindowCloseSource, application: ApplicationQuitSource): () => void
  dispose(): void
}

export function createWindowLifecycle(options: WindowLifecycleOptions): WindowLifecycle {
  let quitting = false
  let disposed = false
  let explicitQuit = false
  let inFlight: Promise<WindowCloseResult> | null = null
  const detachListeners = new Set<() => void>()

  const reportError = (error: unknown) => {
    try { options.onError(error) } catch { /* Error reporting cannot reject an event handler. */ }
  }
  const show = () => {
    try { options.show() } catch (error) { reportError(error) }
  }
  const cancelled = (): WindowCloseResult => {
    if (!disposed) show()
    return 'cancelled'
  }
  const performQuit = async (): Promise<WindowCloseResult> => {
    if (!await options.prepareToQuit()) return cancelled()
    if (disposed) return 'cancelled'
    await options.flushWindowState()
    if (disposed) return 'cancelled'
    // Set before app.quit(): Electron emits before-quit synchronously.
    quitting = true
    options.quit()
    return 'quit-requested'
  }
  const performClose = async (): Promise<WindowCloseResult> => {
    if (explicitQuit) return performQuit()
    const preference = options.readPreference()
    const decision = preference === 'ask' ? await options.requestCloseDecision() : preference === 'tray' ? 'hide' : 'quit'
    if (disposed) return 'cancelled'
    if (explicitQuit || decision === 'quit') return performQuit()
    if (decision === 'cancel') return cancelled()
    if (!options.trayAvailable()) { show(); return 'kept-visible' }
    await options.flushWindowState()
    if (disposed) return 'cancelled'
    // A menu Quit arriving during the dialog or flush must not become Hide.
    if (explicitQuit) return performQuit()
    if (!options.trayAvailable()) { show(); return 'kept-visible' }
    options.hide()
    return explicitQuit ? performQuit() : 'hidden'
  }
  const request = (quit: boolean): Promise<WindowCloseResult> => {
    if (disposed) return Promise.resolve('cancelled')
    if (quitting) return Promise.resolve('quit-requested')
    if (quit) explicitQuit = true
    if (inFlight) return inFlight
    const result = Promise.resolve().then(performClose).catch((error): WindowCloseResult => {
      quitting = false
      if (!disposed) { show(); reportError(error) }
      return 'failed'
    })
    inFlight = result.finally(() => { inFlight = null; explicitQuit = false })
    return inFlight
  }

  const lifecycle: WindowLifecycle = {
    get isQuitting() { return quitting },
    requestClose: () => request(false),
    requestQuit: () => request(true),
    attach(window, application) {
      if (disposed) return () => {}
      const onClose: LifecycleListener = (event) => {
        if (quitting) return
        event.preventDefault()
        void lifecycle.requestClose()
      }
      const onBeforeQuit: LifecycleListener = (event) => {
        if (quitting) return
        event.preventDefault()
        void lifecycle.requestQuit()
      }
      window.on('close', onClose)
      application.on('before-quit', onBeforeQuit)
      const detach = () => {
        window.removeListener('close', onClose)
        application.removeListener('before-quit', onBeforeQuit)
        detachListeners.delete(detach)
      }
      detachListeners.add(detach)
      return detach
    },
    dispose() {
      disposed = true
      for (const detach of detachListeners) detach()
    },
  }
  return lifecycle
}
