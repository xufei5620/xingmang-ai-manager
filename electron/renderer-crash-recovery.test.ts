import { describe, expect, it, vi } from 'vitest'
import { createRendererCrashRecovery, type RendererCrashChoice, type RendererCrashEvent } from './renderer-crash-recovery'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

function fixture(withPrompt = true) {
  let clock = 1_000_000
  const answer = deferred<RendererCrashChoice>()
  const logged: RendererCrashEvent[] = []
  const reload = vi.fn()
  const prompt = vi.fn(() => answer.promise)
  const onError = vi.fn()
  const recovery = createRendererCrashRecovery({
    reload, onError, log: (event) => { logged.push(event) }, now: () => clock,
    ...(withPrompt ? { prompt } : {}),
  })
  return { recovery, reload, prompt, onError, answer, logged, advance: (ms: number) => { clock += ms } }
}

async function settle() {
  // A macrotask turn drains the whole answer chain, `finally` included.
  await new Promise((resolve) => { setImmediate(resolve) })
}

describe('renderer crash recovery', () => {
  it('reloads a page the system reclaimed without asking', () => {
    const { recovery, reload, prompt, logged } = fixture()
    recovery.handleGone('killed')
    expect(reload).toHaveBeenCalledOnce()
    expect(prompt).not.toHaveBeenCalled()
    expect(logged).toEqual(['reload.auto'])
  })

  it('ignores an orderly teardown', () => {
    const { recovery, reload, logged } = fixture()
    recovery.handleGone('clean-exit')
    expect(reload).not.toHaveBeenCalled()
    expect(logged).toEqual([])
  })

  it('asks instead of reloading a third time within a minute', async () => {
    const { recovery, reload, prompt, answer, logged } = fixture()
    recovery.handleGone('crashed')
    recovery.handleGone('crashed')
    recovery.handleGone('crashed')
    recovery.handleGone('crashed')
    await settle()
    expect(reload).toHaveBeenCalledTimes(2)
    expect(prompt).toHaveBeenCalledOnce()
    answer.resolve('reload')
    await settle()
    expect(reload).toHaveBeenCalledTimes(3)
    expect(logged).toEqual(['reload.auto', 'reload.auto', 'prompt.shown', 'prompt.reload'])
  })

  it('leaves the window alone when the user dismisses the question', async () => {
    const { recovery, reload, answer, logged } = fixture()
    recovery.handleGone('crashed')
    recovery.handleGone('crashed')
    recovery.handleGone('crashed')
    answer.resolve('dismiss')
    await settle()
    expect(reload).toHaveBeenCalledTimes(2)
    expect(logged.at(-1)).toBe('prompt.dismiss')
  })

  it('reloads automatically again once the earlier crashes are a minute old', () => {
    const { recovery, reload, prompt, advance } = fixture()
    recovery.handleGone('oom')
    recovery.handleGone('oom')
    advance(60_000)
    recovery.handleGone('oom')
    expect(reload).toHaveBeenCalledTimes(3)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('reloads a blank window the user brings back after dismissing the question', async () => {
    const { recovery, reload, answer, logged } = fixture()
    recovery.handleGone('crashed')
    recovery.handleGone('crashed')
    recovery.handleGone('crashed')
    answer.resolve('dismiss')
    await settle()
    recovery.handleReopen(true)
    expect(reload).toHaveBeenCalledTimes(3)
    expect(logged.at(-1)).toBe('reload.reopen')
  })

  it('leaves a healthy window alone when it is brought back', () => {
    const { recovery, reload, logged } = fixture()
    recovery.handleReopen(false)
    expect(reload).not.toHaveBeenCalled()
    expect(logged).toEqual([])
  })

  it('lets the open question decide instead of reloading behind it', async () => {
    const { recovery, reload, answer } = fixture()
    recovery.handleGone('crashed')
    recovery.handleGone('crashed')
    recovery.handleGone('crashed')
    recovery.handleReopen(true)
    expect(reload).toHaveBeenCalledTimes(2)
    answer.resolve('reload')
    await settle()
    expect(reload).toHaveBeenCalledTimes(3)
  })

  it('starts a fresh count after a reload the user asked for by reopening', async () => {
    const { recovery, reload, prompt, answer } = fixture()
    recovery.handleGone('crashed')
    recovery.handleGone('crashed')
    recovery.handleGone('crashed')
    answer.resolve('dismiss')
    await settle()
    recovery.handleReopen(true)
    recovery.handleGone('crashed')
    recovery.handleGone('crashed')
    expect(reload).toHaveBeenCalledTimes(4)
    expect(prompt).toHaveBeenCalledOnce()
  })

  it('stops after two automatic reloads when there is nobody to ask, until the window is reopened', () => {
    const { recovery, reload, logged } = fixture(false)
    recovery.handleGone('crashed')
    recovery.handleGone('crashed')
    recovery.handleGone('crashed')
    expect(reload).toHaveBeenCalledTimes(2)
    expect(logged).toEqual(['reload.auto', 'reload.auto', 'reload.limit'])
    recovery.handleReopen(true)
    expect(reload).toHaveBeenCalledTimes(3)
    expect(logged.at(-1)).toBe('reload.reopen')
  })

  it('does nothing after the window is gone and survives a failing reload', () => {
    const { recovery, reload, onError } = fixture()
    reload.mockImplementationOnce(() => { throw new Error('destroyed') })
    recovery.handleGone('crashed')
    expect(onError).toHaveBeenCalledOnce()
    recovery.dispose()
    recovery.handleGone('crashed')
    recovery.handleReopen(true)
    expect(reload).toHaveBeenCalledOnce()
  })
})
