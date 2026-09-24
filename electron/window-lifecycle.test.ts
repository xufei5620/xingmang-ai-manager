import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWindowLifecycle, type QuitConfirmation, type WindowLifecycleOptions } from './window-lifecycle'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

function fixture(overrides: Partial<WindowLifecycleOptions> = {}) {
  const options = {
    readPreference: vi.fn<WindowLifecycleOptions['readPreference']>(() => 'ask'),
    trayAvailable: vi.fn(() => true),
    requestCloseDecision: vi.fn<WindowLifecycleOptions['requestCloseDecision']>(async () => 'cancel'),
    prepareToQuit: vi.fn(async () => {}),
    flushWindowState: vi.fn(async () => {}),
    show: vi.fn(), hide: vi.fn(), quit: vi.fn(), onError: vi.fn(),
    ...overrides,
  }
  return { options, lifecycle: createWindowLifecycle(options) }
}

describe('window close coordination', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('keeps the window visible when the tray preference cannot be fulfilled', async () => {
    const { options, lifecycle } = fixture({ readPreference: () => 'tray', trayAvailable: () => false })
    expect(await lifecycle.requestClose()).toBe('kept-visible')
    expect(options.show).toHaveBeenCalledOnce()
    expect(options.hide).not.toHaveBeenCalled()
    expect(options.prepareToQuit).not.toHaveBeenCalled()
    expect(options.quit).not.toHaveBeenCalled()
  })

  it('only hides after flushing, without preparing or cancelling background tasks', async () => {
    const flush = deferred<void>()
    const { options, lifecycle } = fixture({ readPreference: () => 'tray', flushWindowState: () => flush.promise })
    const result = lifecycle.requestClose()
    await Promise.resolve()
    expect(options.hide).not.toHaveBeenCalled()
    flush.resolve()
    expect(await result).toBe('hidden')
    expect(options.hide).toHaveBeenCalledOnce()
    expect(options.prepareToQuit).not.toHaveBeenCalled()
    expect(lifecycle.isQuitting).toBe(false)
  })

  it('rechecks tray availability immediately before hiding', async () => {
    const flush = deferred<void>()
    let available = true
    const { options, lifecycle } = fixture({ readPreference: () => 'tray', trayAvailable: () => available, flushWindowState: () => flush.promise })
    const result = lifecycle.requestClose()
    await Promise.resolve()
    available = false
    flush.resolve()
    expect(await result).toBe('kept-visible')
    expect(options.hide).not.toHaveBeenCalled()
    expect(options.show).toHaveBeenCalledOnce()
  })

  it('shares one in-flight dialog between repeated close requests', async () => {
    const decision = deferred<'cancel'>()
    const { options, lifecycle } = fixture({ requestCloseDecision: vi.fn(() => decision.promise) })
    const first = lifecycle.requestClose()
    const second = lifecycle.requestClose()
    expect(first).toBe(second)
    await Promise.resolve()
    expect(options.requestCloseDecision).toHaveBeenCalledOnce()
    decision.resolve('cancel')
    expect(await first).toBe('cancelled')
    expect(options.show).toHaveBeenCalledOnce()
    expect(options.quit).not.toHaveBeenCalled()
  })

  it('runs cleanup and state persistence concurrently before quitting, regardless of the hide preference', async () => {
    const prepare = deferred<void>()
    const flush = deferred<void>()
    const { options, lifecycle } = fixture({ readPreference: () => 'tray', prepareToQuit: vi.fn(() => prepare.promise), flushWindowState: vi.fn(() => flush.promise) })
    const result = lifecycle.requestQuit()
    expect(result).toBe(lifecycle.requestQuit())
    await vi.advanceTimersByTimeAsync(0)
    expect(options.prepareToQuit).toHaveBeenCalledOnce()
    expect(options.flushWindowState).toHaveBeenCalledOnce()
    expect(lifecycle.isQuitting).toBe(false)
    prepare.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(options.quit).not.toHaveBeenCalled()
    flush.resolve()
    expect(await result).toBe('quit-requested')
    expect(options.quit).toHaveBeenCalledOnce()
    expect(options.requestCloseDecision).not.toHaveBeenCalled()
    expect(lifecycle.isQuitting).toBe(true)
    expect(await lifecycle.requestQuit()).toBe('quit-requested')
    expect(options.quit).toHaveBeenCalledOnce()
  })

  it('upgrades a pending close dialog to explicit quit instead of swallowing it as hide', async () => {
    const decision = deferred<'hide'>()
    const { options, lifecycle } = fixture({ requestCloseDecision: () => decision.promise })
    const close = lifecycle.requestClose()
    await Promise.resolve()
    expect(lifecycle.requestQuit()).toBe(close)
    decision.resolve('hide')
    expect(await close).toBe('quit-requested')
    expect(options.prepareToQuit).toHaveBeenCalledOnce()
    expect(options.hide).not.toHaveBeenCalled()
  })

  it('upgrades a pending tray flush to quit without hiding the window', async () => {
    const flush = deferred<void>()
    const { options, lifecycle } = fixture({ readPreference: () => 'tray', flushWindowState: () => flush.promise })
    const close = lifecycle.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    expect(lifecycle.requestQuit()).toBe(close)
    flush.resolve()
    expect(await close).toBe('quit-requested')
    expect(options.prepareToQuit).toHaveBeenCalledOnce()
    expect(options.quit).toHaveBeenCalledOnce()
    expect(options.hide).not.toHaveBeenCalled()
  })

  it.each(['prepareToQuit', 'flushWindowState'] as const)('logs a rejected %s and still quits', async (field) => {
    const failure = new Error(`${field} failed`)
    const { options, lifecycle } = fixture({ [field]: vi.fn(async () => { throw failure }) })
    expect(await lifecycle.requestQuit()).toBe('quit-requested')
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(options.prepareToQuit).toHaveBeenCalledOnce()
    expect(options.flushWindowState).toHaveBeenCalledOnce()
    expect(options.quit).toHaveBeenCalledOnce()
    expect(options.show).not.toHaveBeenCalled()
    expect(lifecycle.isQuitting).toBe(true)
  })

  it.each(['prepareToQuit', 'flushWindowState'] as const)('does not let a synchronous %s failure veto quitting or skip the other cleanup', async (field) => {
    const failure = new Error(`${field} failed synchronously`)
    const { options, lifecycle } = fixture({ [field]: vi.fn(() => { throw failure }) })
    expect(await lifecycle.requestQuit()).toBe('quit-requested')
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(options.prepareToQuit).toHaveBeenCalledOnce()
    expect(options.flushWindowState).toHaveBeenCalledOnce()
    expect(options.quit).toHaveBeenCalledOnce()
  })

  it.each(['prepareToQuit', 'flushWindowState', 'both'] as const)('quits within two seconds when %s never settles', async (field) => {
    const pending = deferred<void>()
    const { options, lifecycle } = fixture({
      ...(field === 'prepareToQuit' || field === 'both' ? { prepareToQuit: () => pending.promise } : {}),
      ...(field === 'flushWindowState' || field === 'both' ? { flushWindowState: () => pending.promise } : {}),
    })
    const result = lifecycle.requestQuit()
    await vi.advanceTimersByTimeAsync(1999)
    expect(options.quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBe('quit-requested')
    expect(options.quit).toHaveBeenCalledOnce()
    expect(options.show).not.toHaveBeenCalled()
    pending.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(options.quit).toHaveBeenCalledOnce()
  })

  it('still hides when saving window state rejects', async () => {
    const failure = new Error('state persistence failed')
    const { options, lifecycle } = fixture({ readPreference: () => 'tray', flushWindowState: async () => { throw failure } })
    expect(await lifecycle.requestClose()).toBe('hidden')
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(options.hide).toHaveBeenCalledOnce()
    expect(options.prepareToQuit).not.toHaveBeenCalled()
    expect(options.quit).not.toHaveBeenCalled()
    expect(options.show).not.toHaveBeenCalled()
  })

  it('hides within two seconds when saving window state never settles', async () => {
    const flush = deferred<void>()
    const { options, lifecycle } = fixture({ readPreference: () => 'tray', flushWindowState: () => flush.promise })
    const result = lifecycle.requestClose()
    await vi.advanceTimersByTimeAsync(1999)
    expect(options.hide).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBe('hidden')
    expect(options.hide).toHaveBeenCalledOnce()
    expect(options.prepareToQuit).not.toHaveBeenCalled()
    expect(options.quit).not.toHaveBeenCalled()
    flush.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(options.hide).toHaveBeenCalledOnce()
  })

  it('opens a fresh decision after cancellation without running cleanup', async () => {
    const { options, lifecycle } = fixture({
      requestCloseDecision: vi.fn<WindowLifecycleOptions['requestCloseDecision']>().mockResolvedValueOnce('cancel').mockResolvedValueOnce('quit'),
    })
    expect(await lifecycle.requestClose()).toBe('cancelled')
    expect(options.prepareToQuit).not.toHaveBeenCalled()
    expect(options.flushWindowState).not.toHaveBeenCalled()
    expect(options.show).toHaveBeenCalledOnce()
    expect(await lifecycle.requestClose()).toBe('quit-requested')
    expect(options.requestCloseDecision).toHaveBeenCalledTimes(2)
    expect(options.quit).toHaveBeenCalledOnce()
  })

  it('keeps the window recoverable and allows retrying when the actual quit call throws', async () => {
    const failure = new Error('quit failed')
    const { options, lifecycle } = fixture({ quit: vi.fn().mockImplementationOnce(() => { throw failure }) })
    expect(await lifecycle.requestQuit()).toBe('failed')
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(options.show).toHaveBeenCalledOnce()
    expect(lifecycle.isQuitting).toBe(false)
    expect(await lifecycle.requestQuit()).toBe('quit-requested')
    expect(options.quit).toHaveBeenCalledTimes(2)
    expect(lifecycle.isQuitting).toBe(true)
  })

  it('does not let failed error reporting block forced quit', async () => {
    const { options, lifecycle } = fixture({
      prepareToQuit: async () => { throw new Error('cleanup failed') },
      onError: () => { throw new Error('logging failed') },
    })
    expect(await lifecycle.requestQuit()).toBe('quit-requested')
    expect(options.quit).toHaveBeenCalledOnce()
  })

  // e2e/renderer-v2-native-close-race.mjs used to prove this with a five-second wall clock
  // around a real Electron exit, which a busy Windows runner outlasted on its own. The
  // guarantee itself is that nothing on this path waits for the page: with no clock time
  // passing at all, a native close under the quit preference is already a quit.
  it('turns a native close under the quit preference into a quit without any time passing', async () => {
    const window = new EventEmitter()
    const application = new EventEmitter()
    const { options, lifecycle } = fixture({
      readPreference: () => 'quit',
      confirmQuit: vi.fn(async (): Promise<QuitConfirmation> => 'quit'),
      quit: vi.fn(() => application.emit('before-quit', { preventDefault: vi.fn() })),
    })
    lifecycle.attach(window, application)
    const close = { preventDefault: vi.fn() }
    window.emit('close', close)
    expect(close.preventDefault).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(0)
    expect(options.quit).toHaveBeenCalledOnce()
    expect(options.requestCloseDecision).not.toHaveBeenCalled()
    expect(options.show).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    lifecycle.dispose()
  })

  it('intercepts native close and app quit, then permits reentrant before-quit after preparation', async () => {
    const window = new EventEmitter()
    const application = new EventEmitter()
    const allowedQuit = { preventDefault: vi.fn() }
    const { options, lifecycle } = fixture({ quit: vi.fn(() => application.emit('before-quit', allowedQuit)) })
    lifecycle.attach(window, application)
    const close = { preventDefault: vi.fn() }
    window.emit('close', close)
    expect(close.preventDefault).toHaveBeenCalledOnce()
    const beforeQuit = { preventDefault: vi.fn() }
    application.emit('before-quit', beforeQuit)
    expect(beforeQuit.preventDefault).toHaveBeenCalledOnce()
    await lifecycle.requestQuit()
    expect(options.quit).toHaveBeenCalledOnce()
    expect(allowedQuit.preventDefault).not.toHaveBeenCalled()
    const finalClose = { preventDefault: vi.fn() }
    window.emit('close', finalClose)
    expect(finalClose.preventDefault).not.toHaveBeenCalled()
    lifecycle.dispose()
    expect(window.listenerCount('close')).toBe(0)
    expect(application.listenerCount('before-quit')).toBe(0)
    expect(window.listenerCount('session-end')).toBe(0)
    expect(window.listenerCount('query-session-end')).toBe(0)
  })

  it('confirms before a direct quit and keeps the window when the user stays', async () => {
    const confirmQuit = vi.fn<NonNullable<WindowLifecycleOptions['confirmQuit']>>(async (): Promise<QuitConfirmation> => 'cancel')
    const { options, lifecycle } = fixture({ readPreference: () => 'quit', confirmQuit })
    expect(await lifecycle.requestClose()).toBe('cancelled')
    expect(confirmQuit).toHaveBeenCalledOnce()
    expect(options.show).toHaveBeenCalledOnce()
    expect(options.prepareToQuit).not.toHaveBeenCalled()
    expect(options.quit).not.toHaveBeenCalled()
    expect(lifecycle.isQuitting).toBe(false)
  })

  it('confirms the tray quit too, and proceeds once the user accepts', async () => {
    const confirmQuit = vi.fn<NonNullable<WindowLifecycleOptions['confirmQuit']>>(async (): Promise<QuitConfirmation> => 'quit')
    const { options, lifecycle } = fixture({ readPreference: () => 'tray', confirmQuit })
    expect(await lifecycle.requestQuit()).toBe('quit-requested')
    expect(confirmQuit).toHaveBeenCalledOnce()
    expect(options.hide).not.toHaveBeenCalled()
    expect(options.quit).toHaveBeenCalledOnce()
  })

  it('installs the downloaded update before quitting when the user takes the offer', async () => {
    const installDownloadedUpdate = vi.fn()
    const { options, lifecycle } = fixture({
      readPreference: () => 'tray',
      confirmQuit: vi.fn<NonNullable<WindowLifecycleOptions['confirmQuit']>>(async (): Promise<QuitConfirmation> => 'install-update'),
      installDownloadedUpdate,
    })
    expect(await lifecycle.requestQuit()).toBe('quit-requested')
    expect(options.prepareToQuit).toHaveBeenCalledOnce()
    expect(installDownloadedUpdate).toHaveBeenCalledOnce()
    // 安装器自己会让程序退出，所以它必须排在「不再拦截退出」之后。
    expect(lifecycle.isQuitting).toBe(true)
    expect(options.quit).toHaveBeenCalledOnce()
  })

  it('quits without the installer when the user puts the update off', async () => {
    const installDownloadedUpdate = vi.fn()
    const { options, lifecycle } = fixture({
      readPreference: () => 'quit',
      confirmQuit: vi.fn<NonNullable<WindowLifecycleOptions['confirmQuit']>>(async (): Promise<QuitConfirmation> => 'quit'),
      installDownloadedUpdate,
    })
    expect(await lifecycle.requestClose()).toBe('quit-requested')
    expect(installDownloadedUpdate).not.toHaveBeenCalled()
    expect(options.quit).toHaveBeenCalledOnce()
  })

  it('still quits when the installer cannot be launched', async () => {
    const failure = new Error('update install failed')
    const { options, lifecycle } = fixture({
      readPreference: () => 'quit',
      confirmQuit: vi.fn<NonNullable<WindowLifecycleOptions['confirmQuit']>>(async (): Promise<QuitConfirmation> => 'install-update'),
      installDownloadedUpdate: () => { throw failure },
    })
    expect(await lifecycle.requestClose()).toBe('quit-requested')
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(options.quit).toHaveBeenCalledOnce()
  })

  it('does not start an installer once Windows reports the session is ending', async () => {
    const window = new EventEmitter()
    const application = new EventEmitter()
    const installDownloadedUpdate = vi.fn()
    const answer = deferred<QuitConfirmation>()
    const { options, lifecycle } = fixture({
      readPreference: () => 'quit',
      confirmQuit: () => answer.promise,
      installDownloadedUpdate,
    })
    lifecycle.attach(window, application)
    const result = lifecycle.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    window.emit('session-end', { preventDefault: vi.fn() })
    answer.resolve('install-update')
    expect(await result).toBe('quit-requested')
    expect(installDownloadedUpdate).not.toHaveBeenCalled()
    expect(options.quit).toHaveBeenCalledOnce()
  })

  it('does not confirm twice on the prompt path, whose own dialog already warns about running tasks', async () => {
    const confirmQuit = vi.fn<NonNullable<WindowLifecycleOptions['confirmQuit']>>(async (): Promise<QuitConfirmation> => 'cancel')
    const { options, lifecycle } = fixture({
      requestCloseDecision: vi.fn<WindowLifecycleOptions['requestCloseDecision']>(async () => 'quit'),
      confirmQuit,
    })
    expect(await lifecycle.requestClose()).toBe('quit-requested')
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(options.quit).toHaveBeenCalledOnce()
  })

  it('keeps hiding to the tray without asking, since nothing is interrupted', async () => {
    const confirmQuit = vi.fn<NonNullable<WindowLifecycleOptions['confirmQuit']>>(async (): Promise<QuitConfirmation> => 'cancel')
    const { options, lifecycle } = fixture({ readPreference: () => 'tray', confirmQuit })
    expect(await lifecycle.requestClose()).toBe('hidden')
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(options.hide).toHaveBeenCalledOnce()
  })

  it('never lets a broken confirmation veto a quit the user already chose', async () => {
    const failure = new Error('dialog failed')
    const { options, lifecycle } = fixture({
      readPreference: () => 'quit',
      confirmQuit: () => { throw failure },
    })
    expect(await lifecycle.requestClose()).toBe('quit-requested')
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(options.quit).toHaveBeenCalledOnce()
  })

  it('skips the confirmation once Windows reports the session is ending', async () => {
    const window = new EventEmitter()
    const application = new EventEmitter()
    const confirmQuit = vi.fn<NonNullable<WindowLifecycleOptions['confirmQuit']>>(async (): Promise<QuitConfirmation> => 'cancel')
    const { options, lifecycle } = fixture({ readPreference: () => 'quit', confirmQuit })
    lifecycle.attach(window, application)
    window.emit('session-end', { preventDefault: vi.fn() })
    expect(await lifecycle.requestClose()).toBe('quit-requested')
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(options.quit).toHaveBeenCalledOnce()
  })

  it('quits anyway when the session ends while the confirmation is still open', async () => {
    const window = new EventEmitter()
    const application = new EventEmitter()
    const answer = deferred<QuitConfirmation>()
    const { options, lifecycle } = fixture({ readPreference: () => 'quit', confirmQuit: () => answer.promise })
    lifecycle.attach(window, application)
    const result = lifecycle.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    window.emit('session-end', { preventDefault: vi.fn() })
    answer.resolve('cancel')
    expect(await result).toBe('quit-requested')
    expect(options.show).not.toHaveBeenCalled()
    expect(options.quit).toHaveBeenCalledOnce()
  })

  it('detaches and stops a pending close from changing a disposed host', async () => {
    const preparation = deferred<void>()
    const { options, lifecycle } = fixture({ prepareToQuit: () => preparation.promise })
    const request = lifecycle.requestQuit()
    await vi.advanceTimersByTimeAsync(0)
    expect(options.flushWindowState).toHaveBeenCalledOnce()
    lifecycle.dispose()
    preparation.resolve()
    expect(await request).toBe('cancelled')
    expect(options.quit).not.toHaveBeenCalled()
    expect(options.hide).not.toHaveBeenCalled()
    expect(await lifecycle.requestClose()).toBe('cancelled')
  })

  it('does not hide a disposed host when an outstanding state flush times out', async () => {
    const flush = deferred<void>()
    const { options, lifecycle } = fixture({ readPreference: () => 'tray', flushWindowState: () => flush.promise })
    const result = lifecycle.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    lifecycle.dispose()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await result).toBe('cancelled')
    expect(options.hide).not.toHaveBeenCalled()
    expect(options.quit).not.toHaveBeenCalled()
    expect(options.show).not.toHaveBeenCalled()
  })
  // Electron terminates the process on WM_ENDSESSION without before-quit, so
  // a session-end is too late for cleanup; query-session-end is the last hook.
  it('holds Windows shutdown while cleanup that must finish runs, then quits without asking', async () => {
    const window = new EventEmitter()
    const application = new EventEmitter()
    const preparation = deferred<void>()
    const confirmQuit = vi.fn<NonNullable<WindowLifecycleOptions['confirmQuit']>>(async (): Promise<QuitConfirmation> => 'cancel')
    const { options, lifecycle } = fixture({
      readPreference: () => 'quit',
      confirmQuit,
      needsShutdownCleanup: () => true,
      prepareToQuit: vi.fn(() => preparation.promise),
    })
    lifecycle.attach(window, application)
    const query = { preventDefault: vi.fn() }
    window.emit('query-session-end', query)
    expect(query.preventDefault).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(0)
    expect(options.prepareToQuit).toHaveBeenCalledOnce()
    expect(options.quit).not.toHaveBeenCalled()
    preparation.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(options.quit).toHaveBeenCalledOnce()
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(lifecycle.isQuitting).toBe(true)
  })

  it('gives a held shutdown longer than an ordinary quit before giving up on cleanup', async () => {
    const window = new EventEmitter()
    const application = new EventEmitter()
    const { options, lifecycle } = fixture({
      needsShutdownCleanup: () => true,
      prepareToQuit: vi.fn(() => new Promise<void>(() => {})),
    })
    lifecycle.attach(window, application)
    window.emit('query-session-end', { preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(options.quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(options.quit).toHaveBeenCalledOnce()
    expect(options.onError).toHaveBeenCalledOnce()
  })

  it('lets Windows shut down right away when nothing needs cleaning up', async () => {
    const window = new EventEmitter()
    const application = new EventEmitter()
    const { options, lifecycle } = fixture({ needsShutdownCleanup: () => false })
    lifecycle.attach(window, application)
    const query = { preventDefault: vi.fn() }
    window.emit('query-session-end', query)
    await vi.advanceTimersByTimeAsync(0)
    expect(query.preventDefault).not.toHaveBeenCalled()
    expect(options.prepareToQuit).not.toHaveBeenCalled()
    expect(options.quit).not.toHaveBeenCalled()
  })

  it('does not hold shutdown when the cleanup check itself fails', async () => {
    const window = new EventEmitter()
    const application = new EventEmitter()
    const failure = new Error('state unreadable')
    const { options, lifecycle } = fixture({ needsShutdownCleanup: () => { throw failure } })
    lifecycle.attach(window, application)
    const query = { preventDefault: vi.fn() }
    window.emit('query-session-end', query)
    expect(query.preventDefault).not.toHaveBeenCalled()
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it('does not let a close dialog left open keep a held shutdown waiting', async () => {
    const window = new EventEmitter()
    const application = new EventEmitter()
    const decision = deferred<'hide' | 'quit' | 'cancel'>()
    const { options, lifecycle } = fixture({
      requestCloseDecision: () => decision.promise,
      needsShutdownCleanup: () => true,
    })
    lifecycle.attach(window, application)
    const close = lifecycle.requestClose()
    await vi.advanceTimersByTimeAsync(0)
    window.emit('query-session-end', { preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)
    expect(options.quit).toHaveBeenCalledOnce()
    decision.resolve('quit')
    expect(await close).toBe('quit-requested')
    expect(options.quit).toHaveBeenCalledOnce()
    expect(options.prepareToQuit).toHaveBeenCalledOnce()
  })
  // electron-updater's quitAndInstall ends in app.quit(); on macOS it closes
  // every window first. Both must pass once the host has cleaned up.
  it('cleans up, then lets an installer-initiated quit through without asking', async () => {
    const window = new EventEmitter()
    const application = new EventEmitter()
    const confirmQuit = vi.fn<NonNullable<WindowLifecycleOptions['confirmQuit']>>(async (): Promise<QuitConfirmation> => 'install-update')
    const { options, lifecycle } = fixture({ readPreference: () => 'ask', confirmQuit })
    lifecycle.attach(window, application)
    await lifecycle.prepareUpdateQuit()
    expect(options.prepareToQuit).toHaveBeenCalledOnce()
    expect(options.flushWindowState).toHaveBeenCalledOnce()
    const close = { preventDefault: vi.fn() }
    window.emit('close', close)
    const beforeQuit = { preventDefault: vi.fn() }
    application.emit('before-quit', beforeQuit)
    expect(close.preventDefault).not.toHaveBeenCalled()
    expect(beforeQuit.preventDefault).not.toHaveBeenCalled()
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(options.requestCloseDecision).not.toHaveBeenCalled()
  })

  it('hands back synchronously when the user already chose to install on quit', async () => {
    const { lifecycle } = fixture({ readPreference: () => 'quit', confirmQuit: async () => 'install-update' as const, installDownloadedUpdate: () => {
      expect(lifecycle.prepareUpdateQuit()).toBeUndefined()
    } })
    expect(await lifecycle.requestClose()).toBe('quit-requested')
  })

  it('intercepts closes again when the installer never started', async () => {
    const window = new EventEmitter()
    const application = new EventEmitter()
    const { lifecycle } = fixture()
    lifecycle.attach(window, application)
    await lifecycle.prepareUpdateQuit()
    lifecycle.abortUpdateQuit()
    expect(lifecycle.isQuitting).toBe(false)
    const close = { preventDefault: vi.fn() }
    window.emit('close', close)
    expect(close.preventDefault).toHaveBeenCalledOnce()
  })

  it('does not undo a quit the user chose when an aborted install is reported late', async () => {
    const { lifecycle } = fixture({ readPreference: () => 'quit' })
    expect(await lifecycle.requestClose()).toBe('quit-requested')
    lifecycle.abortUpdateQuit()
    expect(lifecycle.isQuitting).toBe(true)
  })
})
