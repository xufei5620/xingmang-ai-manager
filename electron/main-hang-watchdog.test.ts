import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mainHangThresholdMs, type MainHangCapture } from './hang-report'
import { createMainHangWatchdog, mainHangWatchdogOptions, mainHangWatchdogWorkerPath, type MainHangWorker } from './main-hang-watchdog'
import type { MainHangWatchdogOptions } from './main-hang-watchdog-worker'

class FakeWorker implements MainHangWorker {
  posted: unknown[] = []
  terminated = 0
  unrefed = false
  private listeners = new Map<string, (value: unknown) => void>()

  postMessage(value: unknown): void { this.posted.push(value) }
  on(event: 'message' | 'error' | 'exit', listener: (value: unknown) => void): this {
    this.listeners.set(event, listener)
    return this
  }

  terminate(): Promise<number> {
    this.terminated += 1
    return Promise.resolve(1)
  }

  unref(): void { this.unrefed = true }
  emit(event: 'message' | 'error' | 'exit', value: unknown): void {
    this.listeners.get(event)?.(value)
  }
}

const capture: MainHangCapture = {
  stalledMs: 6100,
  afterRecovery: false,
  frames: [{ functionName: 'work', url: 'file:///app.asar/dist-electron/main.js', lineNumber: 3, columnNumber: 4 }],
}

function harness() {
  const workers: FakeWorker[] = []
  const started: MainHangWatchdogOptions[] = []
  const hangs: MainHangCapture[] = []
  const errors: unknown[] = []
  const watchdog = createMainHangWatchdog({
    onHang: (value) => { hangs.push(value) },
    onError: (error) => { errors.push(error) },
    createWorker: (options) => {
      started.push(options)
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    },
  })
  return { watchdog, workers, started, hangs, errors }
}

function beats(worker: FakeWorker | undefined): number {
  return worker?.posted.filter((value) => JSON.stringify(value) === '{"type":"beat"}').length ?? 0
}

describe('createMainHangWatchdog', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('starts no worker until it is armed, so a computer that never stalls pays nothing', () => {
    const { watchdog, workers } = harness()
    watchdog.resume()
    vi.advanceTimersByTime(60000)
    expect(workers).toHaveLength(0)
  })

  it('starts one worker with the five-second threshold and never keeps the app from quitting', () => {
    const { watchdog, workers, started } = harness()
    watchdog.arm()
    watchdog.arm()
    expect(workers).toHaveLength(1)
    expect(workers[0]?.unrefed).toBe(true)
    expect(started).toEqual([mainHangWatchdogOptions])
    expect(mainHangWatchdogOptions.thresholdMs).toBe(mainHangThresholdMs)
  })

  it('beats once a second only while a window of ours has focus', () => {
    const { watchdog, workers } = harness()
    watchdog.resume()
    watchdog.arm()
    const [worker] = workers
    expect(worker?.posted[0]).toEqual({ type: 'resume' })
    vi.advanceTimersByTime(3000)
    expect(beats(worker)).toBe(3)
    watchdog.pause()
    expect(worker?.posted.at(-1)).toEqual({ type: 'pause' })
    vi.advanceTimersByTime(5000)
    expect(beats(worker)).toBe(3)
    watchdog.resume()
    vi.advanceTimersByTime(2000)
    expect(beats(worker)).toBe(5)
  })

  it('hands over the capture once, then shuts the worker and stays done', () => {
    const { watchdog, workers, hangs } = harness()
    watchdog.resume()
    watchdog.arm()
    const [worker] = workers
    worker?.emit('message', { type: 'hang', ...capture })
    expect(hangs).toEqual([capture])
    expect(worker?.terminated).toBe(1)
    const posted = worker?.posted.length
    vi.advanceTimersByTime(5000)
    expect(worker?.posted.length).toBe(posted)
    watchdog.arm()
    expect(workers).toHaveLength(1)
  })

  it('ignores a message it cannot read', () => {
    const { watchdog, workers, hangs, errors } = harness()
    watchdog.arm()
    workers[0]?.emit('message', { type: 'hang', stalledMs: 'long', frames: [], afterRecovery: false })
    workers[0]?.emit('message', 'hello')
    expect(hangs).toEqual([])
    expect(errors).toEqual([])
    expect(workers[0]?.terminated).toBe(0)
  })

  it('records a failed capture and shuts the worker', () => {
    const { watchdog, workers, errors } = harness()
    watchdog.arm()
    workers[0]?.emit('message', { type: 'failed', message: 'Debugger.enable refused' })
    expect(errors).toEqual([new Error('卡住时没能取到调用栈：Debugger.enable refused')])
    expect(workers[0]?.terminated).toBe(1)
  })

  it('records a worker that crashes and does not start another', () => {
    const { watchdog, workers, errors } = harness()
    watchdog.arm()
    workers[0]?.emit('error', new Error('out of memory'))
    expect(errors).toEqual([new Error('out of memory')])
    watchdog.arm()
    expect(workers).toHaveLength(1)
  })

  it('stops beating when the worker exits on its own', () => {
    const { watchdog, workers } = harness()
    watchdog.resume()
    watchdog.arm()
    workers[0]?.emit('exit', 0)
    vi.advanceTimersByTime(5000)
    expect(beats(workers[0])).toBe(0)
    watchdog.arm()
    expect(workers).toHaveLength(1)
  })

  it('reports a worker that cannot start and gives up for the session', () => {
    const errors: unknown[] = []
    let attempts = 0
    const watchdog = createMainHangWatchdog({
      onHang: () => undefined,
      onError: (error) => { errors.push(error) },
      createWorker: () => {
        attempts += 1
        throw new Error('no threads')
      },
    })
    watchdog.arm()
    watchdog.arm()
    expect(attempts).toBe(1)
    expect(errors).toEqual([new Error('no threads')])
  })

  it('shuts the worker on stop and cannot be armed again', () => {
    const { watchdog, workers } = harness()
    watchdog.resume()
    watchdog.arm()
    watchdog.stop()
    expect(workers[0]?.terminated).toBe(1)
    vi.advanceTimersByTime(5000)
    expect(beats(workers[0])).toBe(0)
    watchdog.arm()
    expect(workers).toHaveLength(1)
  })

  it('stops before ever arming means it never starts', () => {
    const { watchdog, workers } = harness()
    watchdog.stop()
    watchdog.arm()
    expect(workers).toHaveLength(0)
  })
})

describe('mainHangWatchdogWorkerPath', () => {
  it('points at the compiled worker next to this module', () => {
    expect(path.basename(mainHangWatchdogWorkerPath())).toBe('main-hang-watchdog-worker.js')
    expect(path.dirname(mainHangWatchdogWorkerPath())).toBe(__dirname)
  })
})
