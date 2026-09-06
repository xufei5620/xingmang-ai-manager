import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createWindowLifecycle, type WindowLifecycleOptions } from './window-lifecycle'

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
    prepareToQuit: vi.fn(async () => true),
    flushWindowState: vi.fn(async () => {}),
    show: vi.fn(), hide: vi.fn(), quit: vi.fn(), onError: vi.fn(),
    ...overrides,
  }
  return { options, lifecycle: createWindowLifecycle(options) }
}

describe('window close coordination', () => {
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

  it('requires preparation and durable state before an explicit quit, regardless of the hide preference', async () => {
    const prepare = deferred<boolean>()
    const flush = deferred<void>()
    const { options, lifecycle } = fixture({ readPreference: () => 'tray', prepareToQuit: () => prepare.promise, flushWindowState: () => flush.promise })
    const result = lifecycle.requestQuit()
    expect(result).toBe(lifecycle.requestQuit())
    await Promise.resolve()
    expect(lifecycle.isQuitting).toBe(false)
    prepare.resolve(true)
    await Promise.resolve()
    expect(options.quit).not.toHaveBeenCalled()
    flush.resolve()
    expect(await result).toBe('quit-requested')
    expect(options.quit).toHaveBeenCalledOnce()
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

  it('keeps the window and skips flushing when task preparation is cancelled', async () => {
    const { options, lifecycle } = fixture({ prepareToQuit: async () => false })
    expect(await lifecycle.requestQuit()).toBe('cancelled')
    expect(options.flushWindowState).not.toHaveBeenCalled()
    expect(options.quit).not.toHaveBeenCalled()
    expect(options.show).toHaveBeenCalledOnce()
    expect(lifecycle.isQuitting).toBe(false)
  })

  it.each(['prepareToQuit', 'flushWindowState', 'quit'] as const)('keeps the window recoverable when %s fails', async (field) => {
    const failure = new Error(`${field} failed`)
    const { options, lifecycle } = fixture({ [field]: vi.fn(() => { throw failure }) })
    expect(await lifecycle.requestQuit()).toBe('failed')
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(options.show).toHaveBeenCalledOnce()
    expect(lifecycle.isQuitting).toBe(false)
  })

  it('allows retrying a previously cancelled quit', async () => {
    const { options, lifecycle } = fixture({ prepareToQuit: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) })
    expect(await lifecycle.requestQuit()).toBe('cancelled')
    expect(await lifecycle.requestQuit()).toBe('quit-requested')
    expect(options.quit).toHaveBeenCalledOnce()
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
  })

  it('detaches and stops a pending close from changing a disposed host', async () => {
    const preparation = deferred<boolean>()
    const { options, lifecycle } = fixture({ prepareToQuit: () => preparation.promise })
    const request = lifecycle.requestQuit()
    await Promise.resolve()
    lifecycle.dispose()
    preparation.resolve(true)
    expect(await request).toBe('cancelled')
    expect(options.quit).not.toHaveBeenCalled()
    expect(options.flushWindowState).not.toHaveBeenCalled()
    expect(await lifecycle.requestClose()).toBe('cancelled')
  })
})
