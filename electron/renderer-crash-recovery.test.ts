import { describe, expect, it, vi } from 'vitest'
import { createRendererCrashRecovery, type RendererCrashChoice, type RendererCrashEvent } from './renderer-crash-recovery'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

function fixture() {
  let clock = 1_000_000
  const answer = deferred<RendererCrashChoice>()
  const logged: RendererCrashEvent[] = []
  const reload = vi.fn()
  const prompt = vi.fn(() => answer.promise)
  const onError = vi.fn()
  const recovery = createRendererCrashRecovery({ reload, prompt, onError, log: (event) => { logged.push(event) }, now: () => clock })
  return { recovery, reload, prompt, onError, answer, logged, advance: (ms: number) => { clock += ms } }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
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

  it('does nothing after the window is gone and survives a failing reload', () => {
    const { recovery, reload, onError } = fixture()
    reload.mockImplementationOnce(() => { throw new Error('destroyed') })
    recovery.handleGone('crashed')
    expect(onError).toHaveBeenCalledOnce()
    recovery.dispose()
    recovery.handleGone('crashed')
    expect(reload).toHaveBeenCalledOnce()
  })
})
