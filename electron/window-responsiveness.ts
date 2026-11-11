import type { WebContents } from 'electron'

export type UnresponsiveChoice = 'wait' | 'reload'
export type UnresponsivePromptEvent = 'prompt.shown' | 'prompt.wait' | 'prompt.reload' | 'prompt.dismissed'

export interface WindowResponsivenessOptions {
  // The signal lets `responsive` take the dialog away again: Electron closes a
  // message box aborted this way as if the user had cancelled it.
  prompt(signal: AbortSignal): Promise<UnresponsiveChoice>
  reload(): void
  log(event: UnresponsivePromptEvent): void
  onError(error: unknown): void
}

export interface WindowResponsivenessGuard {
  readonly prompting: boolean
  handleUnresponsive(): void
  handleResponsive(): void
  dispose(): void
}

export function createWindowResponsivenessGuard(options: WindowResponsivenessOptions): WindowResponsivenessGuard {
  let disposed = false
  let pending: AbortController | null = null
  let dismissed = false

  const report = (error: unknown) => {
    try { options.onError(error) } catch { /* Error reporting cannot reject an event handler. */ }
  }
  const write = (event: UnresponsivePromptEvent) => {
    try { options.log(event) } catch (error) { report(error) }
  }
  const finish = (choice: UnresponsiveChoice) => {
    // A dialog the window took back on `responsive` is not a user decision, so
    // it must never reload: the renderer already recovered on its own.
    if (dismissed) { write('prompt.dismissed'); return }
    if (choice !== 'reload') { write('prompt.wait'); return }
    write('prompt.reload')
    if (disposed) return
    try { options.reload() } catch (error) { report(error) }
  }

  return {
    get prompting() { return pending !== null },
    handleUnresponsive() {
      // One dialog per window. Electron keeps emitting `unresponsive` while the
      // renderer is stuck, and stacked modal sheets cannot all be dismissed.
      if (disposed || pending) return
      const controller = new AbortController()
      pending = controller
      dismissed = false
      write('prompt.shown')
      void Promise.resolve()
        .then(() => options.prompt(controller.signal))
        .then(finish, (error) => { report(error) })
        .finally(() => { if (pending === controller) { pending = null; dismissed = false } })
    },
    handleResponsive() {
      if (!pending) return
      dismissed = true
      pending.abort()
    },
    dispose() {
      disposed = true
      if (!pending) return
      dismissed = true
      pending.abort()
    },
  }
}

type RendererProcessView = Pick<WebContents, 'isDestroyed' | 'getOSProcessId'>

/**
 * Whether `contents` can have its renderer process ended without taking another
 * page down with it. A hung page cannot be reloaded in place: the stuck process
 * would have to run the new page too, so Electron's way out of `unresponsive`
 * is forcefullyCrashRenderer() followed by a load in a fresh process. Some
 * pages share a process, and ending a shared one would kill them all.
 */
export function rendererProcessIsOwn(
  contents: RendererProcessView & Pick<WebContents, 'isCrashed'>,
  all: readonly RendererProcessView[],
): boolean {
  if (contents.isDestroyed() || contents.isCrashed()) return false
  const pid = contents.getOSProcessId()
  if (!(pid > 0)) return false
  return !all.some((other) => other !== contents && !other.isDestroyed() && other.getOSProcessId() === pid)
}
