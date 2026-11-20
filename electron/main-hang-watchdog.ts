import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { mainHangThresholdMs, mainHangWatchdogKind, parseMainHangCapture, type MainHangCapture } from './hang-report'
// Type only: the worker module is loaded by the worker thread, never by the main process.
import type { MainHangWatchdogOptions } from './main-hang-watchdog-worker'

/**
 * 主进程这一头：开关抓栈的后台线程（main-hang-watchdog-worker.ts），每秒给它一次心跳，收它抓到的栈。
 *
 * 后台线程一直开着要多占约 10 MB（Electron 45 实测），所以不一开机就起：匿名统计的卡住计时器
 * （usage-stats-reporter.ts createMainStallMonitor）这次打开后第一次报卡住 2 秒以上，才 arm() 起线程，
 * 等下一回卡 5 秒以上时抓。卡过一次的电脑多半还会再卡；从来不卡的电脑一点不多占。抓到一次就把线程关掉，
 * 一次打开最多报一回。心跳只在星芒的窗口在前台时发，跟卡住计时器同一条规矩：后台被系统放慢的不算。
 */

/** The parts of a worker_threads Worker the host uses; tests hand in a fake. */
export interface MainHangWorker {
  postMessage(value: unknown): void
  on(event: 'message' | 'error' | 'exit', listener: (value: unknown) => void): unknown
  terminate(): Promise<number>
  unref(): void
}

export interface MainHangWatchdogHostOptions {
  onHang(capture: MainHangCapture): void
  onError(error: unknown): void
  createWorker?: (options: MainHangWatchdogOptions) => MainHangWorker
  heartbeatMs?: number
}

export interface MainHangWatchdog {
  /** Start the worker if this session has not had one yet. Idempotent. */
  arm(): void
  /** One of our windows got focus: heartbeats on. */
  resume(): void
  /** None of our windows has focus: heartbeats off, the worker stops judging. */
  pause(): void
  /** Final: the worker goes and arm() does nothing any more. */
  stop(): void
}

export const mainHangWatchdogOptions: MainHangWatchdogOptions = {
  thresholdMs: mainHangThresholdMs,
  tickMs: 500,
  suspendGapMs: 2_000,
  recoveryGraceMs: 10_000,
}

export function mainHangWatchdogWorkerPath(): string {
  return path.join(__dirname, 'main-hang-watchdog-worker.js')
}

function startWatchdogWorker(options: MainHangWatchdogOptions): MainHangWorker {
  return new Worker(mainHangWatchdogWorkerPath(), {
    workerData: { kind: mainHangWatchdogKind, ...options },
    // The worker only keeps a few hundred script URLs while it captures once.
    resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4 },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createMainHangWatchdog(options: MainHangWatchdogHostOptions): MainHangWatchdog {
  const heartbeatMs = options.heartbeatMs ?? 1_000
  const createWorker = options.createWorker ?? startWatchdogWorker
  let worker: MainHangWorker | null = null
  let finished = false
  let focused = false
  let heartbeat: ReturnType<typeof setInterval> | null = null

  function stopHeartbeat(): void {
    if (heartbeat !== null) clearInterval(heartbeat)
    heartbeat = null
  }

  function startHeartbeat(): void {
    if (!worker || heartbeat !== null) return
    worker.postMessage({ type: 'resume' })
    heartbeat = setInterval(() => { worker?.postMessage({ type: 'beat' }) }, heartbeatMs)
    heartbeat.unref?.()
  }

  function finish(): void {
    finished = true
    stopHeartbeat()
    const current = worker
    worker = null
    if (current) void current.terminate().catch(() => undefined)
  }

  return {
    arm() {
      if (finished || worker) return
      let started: MainHangWorker
      try {
        started = createWorker(mainHangWatchdogOptions)
      } catch (error) {
        finished = true
        options.onError(error)
        return
      }
      worker = started
      // Quitting must never wait on it.
      started.unref()
      started.on('message', (value) => {
        if (worker !== started) return
        if (isRecord(value) && value.type === 'failed') {
          finish()
          options.onError(new Error(`卡住时没能取到调用栈：${typeof value.message === 'string' ? value.message.slice(0, 500) : '未知原因'}`))
          return
        }
        const capture = parseMainHangCapture(value)
        if (!capture) return
        finish()
        options.onHang(capture)
      })
      started.on('error', (error) => {
        if (worker !== started) return
        finish()
        options.onError(error)
      })
      started.on('exit', () => {
        if (worker !== started) return
        // Exited on its own without a report: there is nothing left to watch with.
        finished = true
        worker = null
        stopHeartbeat()
      })
      if (focused) startHeartbeat()
    },
    resume() {
      focused = true
      startHeartbeat()
    },
    pause() {
      focused = false
      if (heartbeat === null) return
      stopHeartbeat()
      worker?.postMessage({ type: 'pause' })
    },
    stop() {
      finish()
    },
  }
}
