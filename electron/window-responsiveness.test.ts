import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  createWindowResponsivenessGuard,
  type UnresponsiveChoice,
  type UnresponsivePromptEvent,
  type WindowResponsivenessOptions,
} from './window-responsiveness'

type PromptMock = Mock<WindowResponsivenessOptions['prompt']>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(override?: PromptMock) {
  const answer = deferred<UnresponsiveChoice>()
  const signals: AbortSignal[] = []
  const logged: UnresponsivePromptEvent[] = []
  const prompt: PromptMock = override ?? vi.fn((signal) => { signals.push(signal); return answer.promise })
  const reload = vi.fn()
  const onError = vi.fn()
  const guard = createWindowResponsivenessGuard({
    prompt,
    reload,
    log: (event) => { logged.push(event) },
    onError,
  })
  return { prompt, reload, onError, answer, signals, logged, guard }
}

// Every assertion below waits a microtask for the guard's own promise chain.
async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('unresponsive window prompt', () => {
  it('shows one dialog per window while the renderer stays stuck', async () => {
    const { prompt, reload, answer, logged, guard } = fixture()
    guard.handleUnresponsive()
    guard.handleUnresponsive()
    guard.handleUnresponsive()
    await settle()
    expect(prompt).toHaveBeenCalledOnce()
    expect(guard.prompting).toBe(true)
    expect(logged).toEqual(['prompt.shown'])
    answer.resolve('wait')
    await settle()
    expect(guard.prompting).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('takes the dialog back when the renderer recovers on its own', async () => {
    const { reload, answer, signals, logged, guard } = fixture()
    guard.handleUnresponsive()
    await settle()
    guard.handleResponsive()
    expect(signals[0]?.aborted).toBe(true)
    // Electron resolves an aborted message box as if it had been cancelled.
    answer.resolve('wait')
    await settle()
    expect(reload).not.toHaveBeenCalled()
    expect(logged).toEqual(['prompt.shown', 'prompt.dismissed'])
    expect(guard.prompting).toBe(false)
  })

  it('reloads the renderer when the user asks for it', async () => {
    const { reload, answer, logged, guard } = fixture()
    guard.handleUnresponsive()
    await settle()
    answer.resolve('reload')
    await settle()
    expect(reload).toHaveBeenCalledOnce()
    expect(logged).toEqual(['prompt.shown', 'prompt.reload'])
  })

  it('prompts again the next time the renderer stalls', async () => {
    const first = deferred<UnresponsiveChoice>()
    const second = deferred<UnresponsiveChoice>()
    const answers = [first, second]
    const { prompt, reload, logged, guard } = fixture(vi.fn(() => answers.shift()!.promise))
    guard.handleUnresponsive()
    await settle()
    first.resolve('wait')
    await settle()
    guard.handleUnresponsive()
    await settle()
    expect(prompt).toHaveBeenCalledTimes(2)
    second.resolve('reload')
    await settle()
    expect(reload).toHaveBeenCalledOnce()
    expect(logged).toEqual(['prompt.shown', 'prompt.wait', 'prompt.shown', 'prompt.reload'])
  })

  it('never reloads a window that is already gone', async () => {
    const { prompt, reload, answer, guard } = fixture()
    guard.handleUnresponsive()
    await settle()
    guard.dispose()
    answer.resolve('reload')
    await settle()
    expect(reload).not.toHaveBeenCalled()
    guard.handleUnresponsive()
    expect(prompt).toHaveBeenCalledOnce()
  })

  it('reports a failed dialog instead of throwing into the event handler', async () => {
    const { reload, onError, answer, guard } = fixture()
    guard.handleUnresponsive()
    await settle()
    answer.reject(new Error('对话框打开失败'))
    await settle()
    expect(onError).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
    expect(guard.prompting).toBe(false)
  })
})
