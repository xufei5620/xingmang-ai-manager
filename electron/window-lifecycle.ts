import type { AppCloseBehavior } from './window-preferences'

export type WindowCloseDecision = 'hide' | 'quit' | 'cancel'
export type QuitConfirmation = 'quit' | 'cancel'
export type WindowCloseResult = 'hidden' | 'quit-requested' | 'cancelled' | 'kept-visible' | 'failed'

export interface WindowLifecycleOptions {
  readPreference(): AppCloseBehavior
  trayAvailable(): boolean
  requestCloseDecision(): Promise<WindowCloseDecision>
  /**
   * 「直接退出」偏好和托盘 / 菜单「退出」放行前的最后一次确认，用来在有安装
   * 正在跑时拦一下。缺省 = 旧行为，不确认。「每次询问」那条路径不走这里：
   * 它自己的对话框已经写了「强制退出不等待任务完成」，再弹一次是重复。
   */
  confirmQuitWhileBusy?(): QuitConfirmation | Promise<QuitConfirmation>
  prepareToQuit(): Promise<void>
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
  on(event: 'before-quit' | 'session-end', listener: LifecycleListener): unknown
  removeListener(event: 'before-quit' | 'session-end', listener: LifecycleListener): unknown
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
  let systemShutdown = false
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
  const cleanup = async (action: () => Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('关闭窗口的后台清理超时，继续执行所选操作')), 2_000)
        }),
      ])
    } catch (error) {
      reportError(error)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  const performQuit = async (): Promise<WindowCloseResult> => {
    // The user already chose to quit. Saving placement or cleaning up a
    // background task must never veto that choice or wait on a renderer.
    await Promise.all([cleanup(options.prepareToQuit), cleanup(options.flushWindowState)])
    if (disposed) return 'cancelled'
    // Set before app.quit(): Electron emits before-quit synchronously.
    quitting = true
    options.quit()
    return 'quit-requested'
  }
  const confirmedQuit = async (): Promise<WindowCloseResult> => {
    // Windows 关机 / 注销只给几秒钟，拦住它只会让系统强杀这个进程。
    if (systemShutdown || !options.confirmQuitWhileBusy) return performQuit()
    let confirmation: QuitConfirmation
    try {
      confirmation = await options.confirmQuitWhileBusy()
    } catch (error) {
      // 确认框自己坏了不能否决用户已经做出的退出选择。
      reportError(error)
      return performQuit()
    }
    if (disposed) return 'cancelled'
    if (systemShutdown) return performQuit()
    return confirmation === 'cancel' ? cancelled() : performQuit()
  }
  const performClose = async (): Promise<WindowCloseResult> => {
    if (explicitQuit) return confirmedQuit()
    const preference = options.readPreference()
    if (preference === 'quit') return confirmedQuit()
    const decision = preference === 'ask' ? await options.requestCloseDecision() : 'hide'
    if (disposed) return 'cancelled'
    if (explicitQuit || decision === 'quit') return performQuit()
    if (decision === 'cancel') return cancelled()
    if (!options.trayAvailable()) { show(); return 'kept-visible' }
    await cleanup(options.flushWindowState)
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
      // Windows 关机 / 注销先发 session-end 再走退出流程，记下来让后面的
      // 确认框直接放行。macOS 注销没有对应事件，那边由系统自己的「有程序
      // 阻止注销」界面兜底。
      const onSessionEnd: LifecycleListener = () => { systemShutdown = true }
      window.on('close', onClose)
      application.on('before-quit', onBeforeQuit)
      application.on('session-end', onSessionEnd)
      const detach = () => {
        window.removeListener('close', onClose)
        application.removeListener('before-quit', onBeforeQuit)
        application.removeListener('session-end', onSessionEnd)
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
