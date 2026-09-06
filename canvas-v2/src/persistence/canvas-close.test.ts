import { describe, expect, it, vi } from 'vitest'
import { createCanvasCloseGuard, type CanvasCloseGuardOptions } from './canvas-close'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(overrides: Partial<CanvasCloseGuardOptions> = {}) {
  const options: CanvasCloseGuardOptions = {
    hasPendingWork: () => false,
    chooseAction: vi.fn<CanvasCloseGuardOptions['chooseAction']>(async () => 'cancel'),
    dismissChoice: vi.fn(),
    stopPendingWork: vi.fn(async () => true),
    saveLatest: vi.fn(async () => {}),
    finishClose: vi.fn(async () => true),
    onPhase: vi.fn(), onError: vi.fn(),
    ...overrides,
  }
  return { options, guard: createCanvasCloseGuard(options) }
}

describe('canvas renderer close guard', () => {
  it('protects unfinished project forms and discards them only through an explicit decision', async () => {
    const cancelled = fixture({ hasPendingDraft: () => true })
    await cancelled.guard.request('draft-cancel')
    expect(cancelled.options.onPhase).toHaveBeenCalledWith('draft')
    expect(cancelled.options.finishClose).toHaveBeenCalledExactlyOnceWith('draft-cancel', false)
    expect(cancelled.options.saveLatest).not.toHaveBeenCalled()
    const discarded = fixture({ hasPendingDraft: () => true, chooseAction: async () => 'stop' })
    await discarded.guard.request('draft-discard')
    expect(discarded.options.stopPendingWork).not.toHaveBeenCalled()
    expect(discarded.options.finishClose).toHaveBeenCalledExactlyOnceWith('draft-discard', true)
  })
  it('deduplicates one request and acknowledges only after the project save is durable', async () => {
    const save = deferred<void>()
    const { options, guard } = fixture({ saveLatest: vi.fn(() => save.promise) })
    const first = guard.request('request-a')
    expect(guard.request('request-a')).toBe(first)
    await Promise.resolve()
    expect(options.saveLatest).toHaveBeenCalledOnce()
    expect(options.finishClose).not.toHaveBeenCalled()
    save.resolve()
    await first
    expect(options.finishClose).toHaveBeenCalledExactlyOnceWith('request-a', true)
    expect(options.onPhase).toHaveBeenLastCalledWith('saving')
  })

  it('keeps the graph and unlocks the window after a failed save', async () => {
    const failure = new Error('disk full')
    const { options, guard } = fixture({ saveLatest: async () => { throw failure } })
    await guard.request('request-a')
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(options.finishClose).toHaveBeenCalledExactlyOnceWith('request-a', false)
    expect(options.onPhase).toHaveBeenLastCalledWith(null)
  })

  it('does not cancel tasks or save when the user returns to the canvas', async () => {
    const { options, guard } = fixture({ hasPendingWork: () => true })
    await guard.request('request-a')
    expect(options.chooseAction).toHaveBeenCalledOnce()
    expect(options.stopPendingWork).not.toHaveBeenCalled()
    expect(options.saveLatest).not.toHaveBeenCalled()
    expect(options.finishClose).toHaveBeenCalledExactlyOnceWith('request-a', false)
  })

  it('waits for actual task completion before taking the final graph snapshot', async () => {
    let running = true
    const settled = deferred<void>()
    const { options, guard } = fixture({ hasPendingWork: () => running, chooseAction: async () => 'wait', pause: () => settled.promise })
    const closing = guard.request('request-a')
    await vi.waitFor(() => expect(options.onPhase).toHaveBeenCalledWith('waiting'))
    expect(options.stopPendingWork).not.toHaveBeenCalled()
    expect(options.saveLatest).not.toHaveBeenCalled()
    running = false
    settled.resolve()
    await closing
    expect(options.saveLatest).toHaveBeenCalledOnce()
    expect(options.finishClose).toHaveBeenCalledExactlyOnceWith('request-a', true)
  })

  it('waits for terminal state after an accepted local cancellation instead of treating the request as completion', async () => {
    let running = true
    const settled = deferred<void>()
    const { options, guard } = fixture({ hasPendingWork: () => running, chooseAction: async () => 'stop', pause: () => settled.promise })
    const closing = guard.request('request-a')
    await vi.waitFor(() => expect(options.stopPendingWork).toHaveBeenCalledExactlyOnceWith('request-a'))
    expect(options.saveLatest).not.toHaveBeenCalled()
    running = false
    settled.resolve()
    await closing
    expect(options.finishClose).toHaveBeenCalledExactlyOnceWith('request-a', true)
  })

  it('ignores a save completion after the host expires its close nonce', async () => {
    const save = deferred<void>()
    const { options, guard } = fixture({ saveLatest: () => save.promise })
    const closing = guard.request('expired')
    await Promise.resolve()
    guard.cancel('expired')
    save.resolve()
    await closing
    expect(options.finishClose).not.toHaveBeenCalled()
    expect(options.onPhase).toHaveBeenLastCalledWith(null)
  })

  it('does not let an expired cancellation event revoke a newer close request', async () => {
    const oldSave = deferred<void>()
    const currentSave = deferred<void>()
    const { options, guard } = fixture({ saveLatest: vi.fn().mockImplementationOnce(() => oldSave.promise).mockImplementationOnce(() => currentSave.promise) })
    const old = guard.request('old')
    await Promise.resolve()
    guard.cancel('old')
    const current = guard.request('current')
    await Promise.resolve()
    guard.cancel('old')
    oldSave.resolve()
    currentSave.resolve()
    await Promise.all([old, current])
    expect(options.finishClose).toHaveBeenCalledExactlyOnceWith('current', true)
  })

  it('does not report a successful close when the host refuses an expired acknowledgement', async () => {
    const { options, guard } = fixture({ finishClose: vi.fn(async () => false) })
    await guard.request('request-a')
    expect(options.onPhase).toHaveBeenLastCalledWith(null)
  })

  it('releases an open decision and ignores its result on renderer teardown', async () => {
    const decision = deferred<'stop'>()
    const { options, guard } = fixture({ hasPendingWork: () => true, chooseAction: () => decision.promise })
    const closing = guard.request('request-a')
    await Promise.resolve()
    guard.dispose()
    decision.resolve('stop')
    await closing
    expect(options.dismissChoice).toHaveBeenCalledOnce()
    expect(options.stopPendingWork).not.toHaveBeenCalled()
    expect(options.saveLatest).not.toHaveBeenCalled()
  })
})
