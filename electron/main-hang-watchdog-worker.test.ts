import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { mainHangWatchdogKind as hostKind, parseMainHangCapture } from './hang-report'
import {
  framesFromPausedEvent,
  mainHangWatchdogKind,
  runMainHangWatchdog,
  type MainHangInspectorMessage,
  type MainHangInspectorSession,
  type MainHangWatchdogOptions,
} from './main-hang-watchdog-worker'

const options: MainHangWatchdogOptions = { thresholdMs: 5000, tickMs: 500, suspendGapMs: 2000, recoveryGraceMs: 10000 }
const asar = 'file:///C:/Program%20Files/xingmang/resources/app.asar/dist-electron'

class FakeSession implements MainHangInspectorSession {
  posted: string[] = []
  connected = false
  disconnected = false
  failOn: string | null = null
  private listeners = new Map<string, (message: MainHangInspectorMessage) => void>()
  private callbacks: Array<() => void> = []

  connectToMainThread(): void { this.connected = true }
  on(event: string, listener: (message: MainHangInspectorMessage) => void): this {
    this.listeners.set(event, listener)
    return this
  }

  post(method: string, callback?: (error: Error | null) => void): void {
    this.posted.push(method)
    if (callback) this.callbacks.push(() => callback(this.failOn === method ? new Error(`${method} refused`) : null))
  }

  disconnect(): void { this.disconnected = true }
  /** Answers every request posted so far, the way the main thread does once it services the interrupt. */
  answer(): void {
    while (this.callbacks.length > 0) this.callbacks.shift()?.()
  }

  emit(event: string, params: unknown): void { this.listeners.get(event)?.({ params }) }
}

function harness() {
  let clock = 0
  const sent: unknown[] = []
  let deliver: (value: unknown) => void = () => undefined
  const sessions: FakeSession[] = []
  const tick = runMainHangWatchdog({
    on: (_event, listener) => { deliver = listener },
    postMessage: (value) => { sent.push(value) },
  }, options, {
    now: () => clock,
    createSession: () => {
      const session = new FakeSession()
      sessions.push(session)
      return session
    },
  })
  return {
    sent,
    sessions,
    send: (type: string) => deliver({ type }),
    /** Moves the clock in worker-tick steps, ticking on time. */
    advance(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += options.tickMs) {
        clock += options.tickMs
        tick()
      }
    },
    jump(ms: number) {
      clock += ms
      tick()
    },
  }
}

function pausedAt(...frames: Array<{ functionName: string; scriptId: string; lineNumber: number; url?: string }>) {
  return {
    reason: 'other',
    callFrames: frames.map((entry) => ({ functionName: entry.functionName, url: entry.url ?? '', location: { scriptId: entry.scriptId, lineNumber: entry.lineNumber, columnNumber: 4 } })),
  }
}

describe('runMainHangWatchdog', () => {
  it('does nothing while no window of ours has focus, however long the main thread is quiet', () => {
    const watchdog = harness()
    watchdog.advance(60000)
    expect(watchdog.sessions).toHaveLength(0)
    expect(watchdog.sent).toEqual([])
  })

  it('stays quiet while heartbeats keep coming', () => {
    const watchdog = harness()
    watchdog.send('resume')
    for (let second = 0; second < 30; second += 1) {
      watchdog.advance(1000)
      watchdog.send('beat')
    }
    expect(watchdog.sessions).toHaveLength(0)
  })

  it('pauses the main thread once after five quiet seconds, copies the frames, resumes it and reports when it is back', () => {
    const watchdog = harness()
    watchdog.send('resume')
    watchdog.advance(4500)
    expect(watchdog.sessions).toHaveLength(0)
    watchdog.advance(500)
    const [session] = watchdog.sessions
    expect(session?.connected).toBe(true)
    expect(session?.posted).toEqual(['Debugger.enable'])
    session.emit('Debugger.scriptParsed', { scriptId: '41', url: `${asar}/system-service.js` })
    session.emit('Debugger.scriptParsed', { scriptId: '7', url: 'node:internal/timers' })
    session.answer()
    expect(session.posted).toEqual(['Debugger.enable', 'Debugger.pause'])
    session.emit('Debugger.paused', pausedAt({ functionName: 'readEverything', scriptId: '41', lineNumber: 120 }, { functionName: 'listOnTimeout', scriptId: '7', lineNumber: 580 }))
    // Resumed and switched off before anything else happens.
    expect(session.posted).toEqual(['Debugger.enable', 'Debugger.pause', 'Debugger.resume', 'Debugger.disable'])
    expect(session.disconnected).toBe(true)
    expect(watchdog.sent).toEqual([])
    watchdog.advance(2000)
    watchdog.send('beat')
    expect(watchdog.sent).toHaveLength(1)
    expect(parseMainHangCapture(watchdog.sent[0])).toEqual({
      stalledMs: 7000,
      afterRecovery: false,
      frames: [
        { functionName: 'readEverything', url: `${asar}/system-service.js`, lineNumber: 120, columnNumber: 4 },
        { functionName: 'listOnTimeout', url: 'node:internal/timers', lineNumber: 580, columnNumber: 4 },
      ],
    })
    // One capture per worker: another long silence opens no second session.
    watchdog.advance(30000)
    expect(watchdog.sessions).toHaveLength(1)
  })

  it('starts the clock over when its own timer was late too, since then the whole computer was asleep', () => {
    const watchdog = harness()
    watchdog.send('resume')
    watchdog.advance(1000)
    watchdog.jump(3600000)
    watchdog.advance(4000)
    expect(watchdog.sessions).toHaveLength(0)
  })

  it('stops judging when the window loses focus and starts fresh when it comes back', () => {
    const watchdog = harness()
    watchdog.send('resume')
    watchdog.advance(3000)
    watchdog.send('pause')
    watchdog.advance(20000)
    watchdog.send('resume')
    watchdog.advance(4500)
    expect(watchdog.sessions).toHaveLength(0)
  })

  it('marks the frames as taken after recovery when the main thread was back before the pause landed', () => {
    const watchdog = harness()
    watchdog.send('resume')
    watchdog.advance(5000)
    const [session] = watchdog.sessions
    session.answer()
    watchdog.advance(1000)
    watchdog.send('beat')
    session.emit('Debugger.paused', pausedAt({ functionName: 'emit', scriptId: '3', lineNumber: 1, url: `${asar}/tray.js` }))
    expect(parseMainHangCapture(watchdog.sent[0])).toMatchObject({ stalledMs: 6000, afterRecovery: true })
  })

  it('treats a pause that lands in the heartbeat itself as taken after recovery', () => {
    const watchdog = harness()
    watchdog.send('resume')
    watchdog.advance(5000)
    const [session] = watchdog.sessions
    session.answer()
    session.emit('Debugger.paused', pausedAt(
      { functionName: 'Timeout._onTimeout', scriptId: '9', lineNumber: 80, url: `${asar}/main-hang-watchdog.js` },
      { functionName: 'listOnTimeout', scriptId: '7', lineNumber: 580, url: 'node:internal/timers' },
    ))
    watchdog.send('beat')
    expect(parseMainHangCapture(watchdog.sent[0])?.afterRecovery).toBe(true)
  })

  it('counts a focus change as the main thread being back, since then no heartbeat follows', () => {
    const watchdog = harness()
    watchdog.send('resume')
    watchdog.advance(5000)
    const [session] = watchdog.sessions
    session.answer()
    session.emit('Debugger.paused', pausedAt({ functionName: 'work', scriptId: '1', lineNumber: 1, url: `${asar}/main.js` }))
    watchdog.advance(1500)
    watchdog.send('pause')
    expect(parseMainHangCapture(watchdog.sent[0])).toMatchObject({ stalledMs: 6500, afterRecovery: false })
  })

  it('reports a failure and lets go of the main thread when the debugger refuses', () => {
    const watchdog = harness()
    watchdog.send('resume')
    watchdog.advance(5000)
    const [session] = watchdog.sessions
    session.failOn = 'Debugger.enable'
    session.answer()
    expect(watchdog.sent).toEqual([{ type: 'failed', message: 'Debugger.enable refused' }])
    expect(session.posted).toContain('Debugger.resume')
    expect(session.disconnected).toBe(true)
  })

  it('gives up and disconnects when the main thread came back but the pause never landed', () => {
    const watchdog = harness()
    watchdog.send('resume')
    watchdog.advance(5000)
    const [session] = watchdog.sessions
    session.answer()
    watchdog.send('beat')
    watchdog.advance(10500)
    expect(watchdog.sent).toEqual([{ type: 'failed', message: '主进程已经恢复，但没能停下来取调用栈' }])
    expect(session.disconnected).toBe(true)
    // A pause arriving after giving up changes nothing.
    session.emit('Debugger.paused', pausedAt({ functionName: 'late', scriptId: '1', lineNumber: 1 }))
    expect(watchdog.sent).toHaveLength(1)
  })

  it('ignores messages it does not know', () => {
    const watchdog = harness()
    watchdog.send('resume')
    watchdog.advance(4500)
    watchdog.send('beat-now')
    watchdog.advance(500)
    expect(watchdog.sessions).toHaveLength(1)
  })
})

describe('framesFromPausedEvent', () => {
  it('prefers the url the frame names and falls back to the parsed script', () => {
    const scripts = new Map([['5', `${asar}/main.js`]])
    expect(framesFromPausedEvent(pausedAt({ functionName: 'a', scriptId: '5', lineNumber: 2 }, { functionName: 'b', scriptId: '6', lineNumber: 3, url: 'node:fs' }), scripts))
      .toEqual([
        { functionName: 'a', url: `${asar}/main.js`, lineNumber: 2, columnNumber: 4 },
        { functionName: 'b', url: 'node:fs', lineNumber: 3, columnNumber: 4 },
      ])
  })

  it('skips frames it cannot read and blanks fields that are not plain text', () => {
    expect(framesFromPausedEvent({ callFrames: [null, { location: null }, { functionName: 'x\ny', url: 7, location: { scriptId: '1', lineNumber: -3, columnNumber: 1.5 } }] }, new Map()))
      .toEqual([{ functionName: '', url: '', lineNumber: 0, columnNumber: 0 }])
    expect(framesFromPausedEvent(undefined, new Map())).toEqual([])
  })
})

describe('main-hang-watchdog-worker source', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main-hang-watchdog-worker.ts'), 'utf8')

  // The session is in-process (connectToMainThread). Opening the inspector
  // would listen on a port any local program could attach to and run code
  // through; nothing in this file may ever do that.
  it('never opens an inspector port', () => {
    expect(source).not.toMatch(/\.open\s*\(/)
    expect(source).not.toMatch(/\burl\s*\(\s*\)/)
    expect(source).toContain('connectToMainThread()')
  })

  it('answers to the same workerData marker the host sends', () => {
    expect(mainHangWatchdogKind).toBe(hostKind)
  })

  it('imports nothing but Node built-ins, so it loads as a worker from inside app.asar on its own', () => {
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1])
    expect(imports).toEqual(['node:inspector', 'node:worker_threads'])
  })
})

// The real thing: the worker transpiled as it ships, a real inspector session
// on this test's main thread, and this thread blocked in a busy loop.
describe('main-hang-watchdog-worker in a real worker thread', () => {
  it('names the function the main thread is stuck in and leaves the thread running', async () => {
    const source = fs.readFileSync(path.join(__dirname, 'main-hang-watchdog-worker.ts'), 'utf8')
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    // Wrapped so the transpiled `exports.x = …` lines have an object to write to.
    const worker = new Worker(`(function (exports) {\n${code}\n})({})`, {
      eval: true,
      workerData: { kind: mainHangWatchdogKind, thresholdMs: 300, tickMs: 50, suspendGapMs: 2000, recoveryGraceMs: 10000 },
    })
    try {
      const reported = new Promise<unknown>((resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
      })
      await new Promise((resolve) => worker.once('online', resolve))
      worker.postMessage({ type: 'resume' })
      const finishedAt = blockThisThreadForTest(4000)
      worker.postMessage({ type: 'beat' })
      const capture = parseMainHangCapture(await reported)
      expect(finishedAt).toBeGreaterThan(0)
      expect(capture?.afterRecovery).toBe(false)
      expect(capture?.stalledMs).toBeGreaterThanOrEqual(300)
      expect(capture?.frames.map((frame) => frame.functionName)).toContain('blockThisThreadForTest')
    } finally {
      await worker.terminate()
    }
  })
})

function blockThisThreadForTest(ms: number): number {
  const end = Date.now() + ms
  let spins = 0
  while (Date.now() < end) spins += 1
  return spins
}
