import { Session } from 'node:inspector'
import { parentPort, workerData } from 'node:worker_threads'

/**
 * 主进程卡住时问出它卡在哪段代码的后台线程（hang-report.ts 说了为什么要这个）。
 *
 * A thread cannot look at its own stack while it is blocked, so this runs as a
 * worker: the main thread sends it a heartbeat every second while one of our
 * windows has focus, and when no heartbeat has arrived for thresholdMs the
 * worker asks V8, through an in-process inspector session on the main thread
 * (Session.connectToMainThread), to pause it for a moment, copies the call
 * frames and resumes it at once. V8 services that request from inside running
 * JavaScript (an interrupt), which is what makes it work while the thread is
 * busy. Measured on Electron 45 with the release fuses (inspect arguments and
 * run-as-node off): the pause lands within ~60 ms of the request inside a busy
 * loop; inside a blocking native call it lands the moment that call returns,
 * still in the caller's frame.
 *
 * What this must never do:
 * - open a debugging port (inspector.open) -- the session lives inside this
 *   process and nothing outside it can attach;
 * - leave the main thread paused -- every path that saw the pause resumes it,
 *   and if this worker dies mid-pause V8 drops its session and resumes on its
 *   own (checked: a worker that exits while the main thread is paused leaves
 *   the main thread running);
 * - keep the debugger enabled after the one capture.
 *
 * It captures once and then reports; the host terminates it after that, so a
 * session costs at most one pause. It depends on Node built-ins only, so it
 * loads from inside app.asar on its own; the host imports nothing but its
 * types, and the tests drive runMainHangWatchdog with fakes.
 */

export interface MainHangWatchdogOptions {
  thresholdMs: number
  tickMs: number
  /** The worker's own timer this late means the whole process was suspended (sleep, lid closed). */
  suspendGapMs: number
  /** Gives up when the main thread came back but the pause never landed. */
  recoveryGraceMs: number
}

export interface MainHangWatchdogPort {
  on(event: 'message', listener: (value: unknown) => void): unknown
  postMessage(value: unknown): void
}

export interface MainHangInspectorMessage {
  params?: unknown
}

export interface MainHangInspectorSession {
  connectToMainThread(): void
  on(event: 'Debugger.scriptParsed' | 'Debugger.paused', listener: (message: MainHangInspectorMessage) => void): unknown
  post(method: string, callback?: (error: Error | null) => void): void
  disconnect(): void
}

export interface MainHangWatchdogDependencies {
  now(): number
  createSession(): MainHangInspectorSession
}

interface CapturedFrame {
  functionName: string
  url: string
  lineNumber: number
  columnNumber: number
}

const MAX_CAPTURED_FRAMES = 60
const MAX_FIELD_LENGTH = 2_048

/** Same value as hang-report.ts mainHangWatchdogKind (a test pins them equal); copied so this file needs no local import. */
export const mainHangWatchdogKind = 'xingmang-main-hang-watchdog'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shortText(value: unknown): string {
  return typeof value === 'string' && value.length <= MAX_FIELD_LENGTH && !/[\r\n\0]/.test(value) ? value : ''
}

function position(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * Debugger.paused call frames, top first. CallFrame.url is deprecated and comes
 * back empty for CommonJS modules on Node 24, so the script id is looked up in
 * what Debugger.scriptParsed announced when the debugger was enabled.
 */
export function framesFromPausedEvent(params: unknown, scripts: ReadonlyMap<string, string>): CapturedFrame[] {
  if (!isRecord(params) || !Array.isArray(params.callFrames)) return []
  const frames: CapturedFrame[] = []
  for (const callFrame of params.callFrames.slice(0, MAX_CAPTURED_FRAMES)) {
    if (!isRecord(callFrame) || !isRecord(callFrame.location)) continue
    const scriptId = typeof callFrame.location.scriptId === 'string' ? callFrame.location.scriptId : ''
    frames.push({
      functionName: shortText(callFrame.functionName),
      url: shortText(callFrame.url) || shortText(scripts.get(scriptId)),
      lineNumber: position(callFrame.location.lineNumber),
      columnNumber: position(callFrame.location.columnNumber),
    })
  }
  return frames
}

// The host's heartbeat lives in this file's sibling. A pause that lands in it
// means the stall ended outside JavaScript and the next thing to run was the
// heartbeat timer: the frames say nothing about what blocked.
function landedInHeartbeat(frames: readonly CapturedFrame[]): boolean {
  const top = frames.find((frame) => frame.url !== '' && !frame.url.startsWith('node:'))
  return top !== undefined && /[\\/]main-hang-watchdog\.js$/.test(top.url)
}

type Phase = 'watching' | 'capturing' | 'recovering' | 'done'

/** Returns the tick so tests can drive time; the real worker hands it to setInterval. */
export function runMainHangWatchdog(
  port: MainHangWatchdogPort,
  options: MainHangWatchdogOptions,
  dependencies: MainHangWatchdogDependencies,
): () => void {
  let phase: Phase = 'watching'
  let active = false
  let lastBeat = dependencies.now()
  let lastTick = lastBeat
  // Set when a stall is seen: the last heartbeat before it, and the first one after.
  let stallStartedAt = 0
  let recoveredAt: number | null = null
  let frames: CapturedFrame[] = []
  let session: MainHangInspectorSession | null = null

  function closeSession(resume: boolean): void {
    const current = session
    session = null
    if (!current) return
    try {
      if (resume) current.post('Debugger.resume')
      current.post('Debugger.disable')
      current.disconnect()
    } catch {
      // Disconnecting is what resumes a pause we never saw; nothing else to do.
    }
  }

  function finish(afterRecovery: boolean): void {
    phase = 'done'
    port.postMessage({
      type: 'hang',
      stalledMs: Math.max(0, (recoveredAt ?? dependencies.now()) - stallStartedAt),
      frames,
      afterRecovery: afterRecovery || landedInHeartbeat(frames),
    })
  }

  function fail(error: unknown): void {
    if (phase === 'done') return
    phase = 'done'
    closeSession(true)
    port.postMessage({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
  }

  function capture(): void {
    phase = 'capturing'
    stallStartedAt = lastBeat
    const scripts = new Map<string, string>()
    try {
      const opened = dependencies.createSession()
      session = opened
      opened.connectToMainThread()
      opened.on('Debugger.scriptParsed', (message) => {
        const params = message.params
        if (isRecord(params) && typeof params.scriptId === 'string' && typeof params.url === 'string') scripts.set(params.scriptId, params.url)
      })
      opened.on('Debugger.paused', (message) => {
        if (phase !== 'capturing' || session !== opened) return
        try {
          frames = framesFromPausedEvent(message.params, scripts)
        } finally {
          closeSession(true)
        }
        // A heartbeat that beat the pause here means the main thread ran its
        // timers before reaching the pause: what blocked it is already gone.
        if (recoveredAt !== null) {
          finish(true)
          return
        }
        phase = 'recovering'
      })
      opened.post('Debugger.enable', (error) => {
        if (error) {
          fail(error)
          return
        }
        if (session !== opened) return
        opened.post('Debugger.pause', (pauseError) => { if (pauseError) fail(pauseError) })
      })
    } catch (error) {
      fail(error)
    }
  }

  port.on('message', (value) => {
    if (!isRecord(value) || (value.type !== 'resume' && value.type !== 'pause' && value.type !== 'beat')) return
    const now = dependencies.now()
    if (value.type === 'resume') {
      active = true
      lastBeat = now
    } else if (value.type === 'pause') {
      active = false
    } else {
      lastBeat = now
    }
    // Any message at all means the main thread is running JavaScript again:
    // the window may have lost focus during the stall, and then the first
    // thing it sends afterwards is 'pause', with no heartbeat behind it.
    if (phase === 'capturing' && recoveredAt === null) recoveredAt = now
    if (phase === 'recovering') {
      recoveredAt = now
      finish(false)
    }
  })

  return function tick(): void {
    const now = dependencies.now()
    const lag = now - lastTick - options.tickMs
    lastTick = now
    if (phase === 'capturing') {
      if (recoveredAt !== null && now - recoveredAt > options.recoveryGraceMs) fail(new Error('主进程已经恢复，但没能停下来取调用栈'))
      return
    }
    if (phase !== 'watching') return
    // Sleep, a closed lid or a debugger freezes this thread too; the gap is
    // not the main thread's doing, so the clock starts over.
    if (lag >= options.suspendGapMs) {
      lastBeat = now
      return
    }
    if (!active || now - lastBeat < options.thresholdMs) return
    capture()
  }
}

function readOptions(value: unknown): MainHangWatchdogOptions | null {
  if (!isRecord(value) || value.kind !== mainHangWatchdogKind) return null
  const { thresholdMs, tickMs, suspendGapMs, recoveryGraceMs } = value
  const numbers = [thresholdMs, tickMs, suspendGapMs, recoveryGraceMs]
  if (!numbers.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry > 0)) return null
  return { thresholdMs: Number(thresholdMs), tickMs: Number(tickMs), suspendGapMs: Number(suspendGapMs), recoveryGraceMs: Number(recoveryGraceMs) }
}

// Started only when this file is the watchdog worker itself; imported anywhere
// else (the tests) it only exports.
const startOptions = parentPort ? readOptions(workerData) : null
if (parentPort && startOptions) {
  const tick = runMainHangWatchdog(parentPort, startOptions, {
    now: () => performance.now(),
    createSession: () => new Session(),
  })
  // This interval is also what keeps the worker alive while it waits for the
  // inspector's answers; an idle worker would exit mid-capture.
  setInterval(tick, startOptions.tickMs)
}
