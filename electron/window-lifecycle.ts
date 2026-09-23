import type { AppCloseBehavior } from './window-preferences'

export type WindowCloseDecision = 'hide' | 'quit' | 'cancel'
export type QuitConfirmation = 'quit' | 'cancel' | 'install-update'
export type WindowCloseResult = 'hidden' | 'quit-requested' | 'cancelled' | 'kept-visible' | 'failed'

export interface WindowLifecycleOptions {
  readPreference(): AppCloseBehavior
  trayAvailable(): boolean
  requestCloseDecision(): Promise<WindowCloseDecision>
  /**
   * 「直接退出」偏好和托盘 / 菜单「退出」放行前的最后一次确认：有安装正在跑时
   * 拦一下，或者问一句要不要顺手装上已经下载好的更新。缺省 = 旧行为，不确认。
   * 「每次询问」那条路径不走这里：它自己的对话框已经写了「强制退出不等待任务
   * 完成」，再弹一次是重复。**一次退出最多只问一句**，所以两件事合在同一个
   * 回调里由调用方排序，不是两个钩子各弹各的框。
   */
  confirmQuit?(): QuitConfirmation | Promise<QuitConfirmation>
  /**
   * 拉起已经下载好的更新的安装器，只在 confirmQuit 选了 'install-update' 之后
   * 调用。安装器自己会让程序退出，所以它必须在 quitting 置位之后才跑，否则那次
   * 退出会被这套流程再拦一遍。抛错也不能否决用户已经做出的退出选择。
   */
  installDownloadedUpdate?(): void
  /**
   * Windows 关机 / 重启 / 注销时，退出前的清理还有没有必须做完的事（开着加速时
   * 系统代理还指着本机端口）。返回 true 就先推迟关机，把 prepareToQuit 跑完再退；
   * 缺省 = 旧行为，不推迟。
   */
  needsShutdownCleanup?(): boolean
  prepareToQuit(): Promise<void>
  flushWindowState(): Promise<void>
  show(): void
  hide(): void
  quit(): void
  onError(error: unknown): void
}

interface PreventableEvent { preventDefault(): void }
type LifecycleListener = (event: PreventableEvent) => void
// query-session-end / session-end are BrowserWindow events on Windows; the
// App never emits them, so listening on `app` (as this module once did) sees
// nothing.
interface WindowCloseSource {
  on(event: 'close' | 'query-session-end' | 'session-end', listener: LifecycleListener): unknown
  removeListener(event: 'close' | 'query-session-end' | 'session-end', listener: LifecycleListener): unknown
}
interface ApplicationQuitSource {
  on(event: 'before-quit', listener: LifecycleListener): unknown
  removeListener(event: 'before-quit', listener: LifecycleListener): unknown
}

const quitCleanupBudgetMs = 2_000
// On WM_ENDSESSION Electron terminates the process immediately (no
// before-quit, no will-quit), so cleanup that must finish has to run while
// shutdown is held at query-session-end. Restoring the system proxy starts a
// cold PowerShell or two in the acceleration helper; the budget covers that
// without holding the user's shutdown indefinitely.
const shutdownCleanupBudgetMs = 10_000

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
  let shutdownQuit: Promise<WindowCloseResult> | null = null
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
  const cleanup = async (action: () => Promise<void>, budgetMs = quitCleanupBudgetMs): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('关闭窗口的后台清理超时，继续执行所选操作')), budgetMs)
        }),
      ])
    } catch (error) {
      reportError(error)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  const runQuit = async (installUpdate: boolean, budgetMs: number): Promise<WindowCloseResult> => {
    // The user already chose to quit. Saving placement or cleaning up a
    // background task must never veto that choice or wait on a renderer.
    await Promise.all([cleanup(options.prepareToQuit, budgetMs), cleanup(options.flushWindowState, budgetMs)])
    if (disposed) return 'cancelled'
    // Set before app.quit(): Electron emits before-quit synchronously.
    quitting = true
    // 安装器自己会结束进程，所以它排在 quitting 之后、app.quit() 之前：这一段
    // 里 close / before-quit 都已经放行，安装器发出的退出不会再被拦一次。
    if (installUpdate && options.installDownloadedUpdate) {
      try { options.installDownloadedUpdate() } catch (error) { reportError(error) }
    }
    options.quit()
    return 'quit-requested'
  }
  // A close that was already in flight when shutdown began joins the shutdown
  // quit instead of cleaning up, installing or quitting a second time.
  const performQuit = (installUpdate = false): Promise<WindowCloseResult> => shutdownQuit ?? runQuit(installUpdate, quitCleanupBudgetMs)
  // Runs beside any close already in flight: a close dialog left open must not
  // keep a held shutdown waiting on an answer nobody is there to give.
  const quitForShutdown = () => {
    if (disposed || quitting || shutdownQuit) return
    shutdownQuit = runQuit(false, shutdownCleanupBudgetMs).catch((error): WindowCloseResult => {
      reportError(error)
      options.quit()
      return 'quit-requested'
    })
  }
  const confirmedQuit = async (): Promise<WindowCloseResult> => {
    // Windows 关机 / 注销只给几秒钟，拦住它只会让系统强杀这个进程。
    if (systemShutdown || !options.confirmQuit) return performQuit()
    let confirmation: QuitConfirmation
    try {
      confirmation = await options.confirmQuit()
    } catch (error) {
      // 确认框自己坏了不能否决用户已经做出的退出选择。
      reportError(error)
      return performQuit()
    }
    if (disposed) return 'cancelled'
    // 关机途中不要再去拉起安装器：系统随时会强杀这个进程，装一半更糟。
    if (systemShutdown) return performQuit()
    if (confirmation === 'cancel') return cancelled()
    return performQuit(confirmation === 'install-update')
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
      // Windows 关机 / 重启 / 注销先问一句 query-session-end，再发 session-end；
      // 收到 session-end 之后 Electron 立刻结束进程，before-quit 和
      // prepareToQuit 都不会跑。所以必须做完的清理（开着加速时还原系统代理）
      // 只能在问的这一下推迟关机、当场做完再退；没有要做的就不拦，关机照常。
      // 两个事件都记下来，让后面的确认框直接放行。macOS 注销没有对应事件，
      // 那边由系统自己的「有程序阻止注销」界面兜底。
      const onQuerySessionEnd: LifecycleListener = (event) => {
        systemShutdown = true
        if (quitting) return
        let hold = false
        try { hold = options.needsShutdownCleanup?.() === true } catch (error) { reportError(error) }
        if (!hold) return
        event.preventDefault()
        quitForShutdown()
      }
      const onSessionEnd: LifecycleListener = () => { systemShutdown = true }
      window.on('close', onClose)
      window.on('query-session-end', onQuerySessionEnd)
      window.on('session-end', onSessionEnd)
      application.on('before-quit', onBeforeQuit)
      const detach = () => {
        window.removeListener('close', onClose)
        window.removeListener('query-session-end', onQuerySessionEnd)
        window.removeListener('session-end', onSessionEnd)
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
