import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWindowLifecycle, type QuitConfirmation, type WindowLifecycleOptions } from './window-lifecycle'

// 生成中退出软件，画布直接被关掉：最后不到一秒的改动没存，也不提醒还在生成（#1368 第 9 条）。
// 退出前先走画布自己的关窗流程，它存一次、在生成的问一句。

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

function fixture(overrides: Partial<WindowLifecycleOptions> = {}) {
  const calls: string[] = []
  const options = {
    readPreference: vi.fn<WindowLifecycleOptions['readPreference']>(() => 'quit'),
    trayAvailable: vi.fn(() => true),
    requestCloseDecision: vi.fn<WindowLifecycleOptions['requestCloseDecision']>(async () => 'cancel'),
    closeCanvas: vi.fn(async () => { calls.push('canvas'); return true }),
    confirmQuit: vi.fn(async (): Promise<QuitConfirmation> => { calls.push('confirm'); return 'quit' }),
    prepareToQuit: vi.fn(async () => { calls.push('prepare') }),
    flushWindowState: vi.fn(async () => {}),
    show: vi.fn(), hide: vi.fn(), quit: vi.fn(() => { calls.push('quit') }), onError: vi.fn(),
    ...overrides,
  }
  return { options, calls, lifecycle: createWindowLifecycle(options) }
}

describe('quitting with the canvas open', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('lets the canvas save and close before anything else the quit does', async () => {
    const { calls, lifecycle } = fixture()
    expect(await lifecycle.requestQuit()).toBe('quit-requested')
    expect(calls).toEqual(['canvas', 'confirm', 'prepare', 'quit'])
  })

  it('drops the quit when the user goes back to the canvas, leaving the main window where it was', async () => {
    const closeCanvas = vi.fn(async () => false)
    const { options, lifecycle } = fixture({ closeCanvas })
    expect(await lifecycle.requestQuit()).toBe('cancelled')
    expect(options.confirmQuit).not.toHaveBeenCalled()
    expect(options.prepareToQuit).not.toHaveBeenCalled()
    expect(options.quit).not.toHaveBeenCalled()
    expect(options.show).not.toHaveBeenCalled()
    expect(lifecycle.isQuitting).toBe(false)
    // The next quit asks the canvas again.
    closeCanvas.mockResolvedValueOnce(true)
    expect(await lifecycle.requestQuit()).toBe('quit-requested')
    expect(closeCanvas).toHaveBeenCalledTimes(2)
  })

  it('waits for as long as the canvas needs, since it may be asking the user', async () => {
    const answer = deferred<boolean>()
    const { options, lifecycle } = fixture({ closeCanvas: () => answer.promise })
    const result = lifecycle.requestQuit()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(options.prepareToQuit).not.toHaveBeenCalled()
    answer.resolve(true)
    expect(await result).toBe('quit-requested')
  })

  it('closes the canvas first when the user picks quit in the close dialog', async () => {
    const { options, calls, lifecycle } = fixture({ readPreference: () => 'ask', requestCloseDecision: vi.fn(async () => 'quit' as const) })
    expect(await lifecycle.requestClose()).toBe('quit-requested')
    expect(calls).toEqual(['canvas', 'prepare', 'quit'])
    // That dialog is the one question for this quit.
    expect(options.confirmQuit).not.toHaveBeenCalled()
  })

  it('leaves the canvas alone when the window only goes to the tray', async () => {
    const { options, lifecycle } = fixture({ readPreference: () => 'tray' })
    expect(await lifecycle.requestClose()).toBe('hidden')
    expect(options.closeCanvas).not.toHaveBeenCalled()
  })

  it('still quits when the canvas fails to close', async () => {
    const failure = new Error('画布窗口未能关闭')
    const { options, lifecycle } = fixture({ closeCanvas: vi.fn(async () => { throw failure }) })
    expect(await lifecycle.requestQuit()).toBe('quit-requested')
    expect(options.onError).toHaveBeenCalledWith(failure)
    expect(options.quit).toHaveBeenCalledOnce()
  })

  it('does not wait on the canvas while Windows shuts down', async () => {
    const window = new EventEmitter()
    const application = new EventEmitter()
    const { options, lifecycle } = fixture()
    lifecycle.attach(window, application)
    window.emit('query-session-end', { preventDefault: vi.fn() })
    application.emit('before-quit', { preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)
    expect(options.closeCanvas).not.toHaveBeenCalled()
    expect(options.quit).toHaveBeenCalledOnce()
    lifecycle.dispose()
  })

  it('stops waiting on the canvas when the system quits the app after a Mac power-off', async () => {
    const window = new EventEmitter()
    const application = new EventEmitter()
    const answer = deferred<boolean>()
    const { options, lifecycle } = fixture({ closeCanvas: () => answer.promise })
    lifecycle.attach(window, application)
    const result = lifecycle.requestQuit()
    await vi.advanceTimersByTimeAsync(0)
    lifecycle.noteSystemPowerOff()
    application.emit('before-quit', { preventDefault: vi.fn() })
    expect(await result).toBe('quit-requested')
    expect(options.confirmQuit).not.toHaveBeenCalled()
    expect(options.quit).toHaveBeenCalledOnce()
    // Going back to the canvas afterwards changes nothing.
    answer.resolve(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(options.quit).toHaveBeenCalledOnce()
    lifecycle.dispose()
  })
})
