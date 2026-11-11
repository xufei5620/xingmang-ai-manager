/**
 * 睡着那段不算的时限（睡眠深查 G1）。
 *
 * The main process's timers and performance.now() keep counting while macOS
 * (mach_continuous_time) or Windows (QueryPerformanceCounter) sleeps, and every
 * timer that came due during sleep fires the moment the machine wakes. A limit
 * such as "give up after three minutes without progress" therefore expires on
 * wake whenever the lid stayed shut longer than that, which is exactly when the
 * network is still reconnecting and the transfer has had no chance to move.
 * Linux's CLOCK_MONOTONIC stops during sleep, so the old timers were already
 * right there and nothing here changes their outcome.
 *
 * Nothing tells a running timer how long the machine slept, so the clock is read
 * on a short interval instead. A step between two readings that is far longer
 * than the interval, or that runs backwards, was not spent awake: it adds only one
 * interval to the total, and a stall window starts over from that reading, so the
 * transfer gets its whole window to recover after wake. This is the rule the update
 * download watchdog in updater.ts already follows.
 *
 * 装工具时合盖几分钟，以前一醒就报「下载太久没有完成，超时中止」、换源从头下；现在醒来先接着等，
 * 醒着的时间照旧有上限。
 */

/** How often a deadline reads the clock, at most. */
export const awakeCheckIntervalMs = 15_000

/**
 * A step between two readings longer than this (or than two of the reader's intervals, if
 * that is longer) was spent asleep. It sits well above the check interval, so timers that a
 * busy main process runs late still count as awake time, and well below the shortest window
 * it guards (three minutes), so any sleep long enough to have expired one is caught.
 */
export const awakeGapMs = 60_000

export interface AwakeReading {
  /** Milliseconds this computer has been awake since the clock started. */
  awakeMs: number
  /** True when the step before this reading was a sleep or a clock jump rather than awake time. */
  woke: boolean
}

export interface AwakeClock {
  read(): AwakeReading
}

export interface AwakeClockOptions {
  /** Monotonic milliseconds. */
  now?: () => number
  /**
   * How often the reader reads the clock. A step taken for sleep still adds one interval to
   * the total: adding nothing would let a main process whose timers always run very late never
   * reach a ceiling, and one interval is too little for any sleep to matter.
   */
  intervalMs?: number
}

function monotonicNow(): number {
  return performance.now()
}

/** Totals awake time from readings taken every `intervalMs` (or more often) while the machine is awake. */
export function createAwakeClock(options: AwakeClockOptions = {}): AwakeClock {
  const now = options.now ?? monotonicNow
  const intervalMs = options.intervalMs ?? awakeCheckIntervalMs
  const gapMs = Math.max(awakeGapMs, 2 * intervalMs)
  let previous = now()
  let awakeMs = 0
  return {
    read() {
      const at = now()
      const step = at - previous
      previous = at
      const woke = step < 0 || step > gapMs
      awakeMs += woke ? intervalMs : step
      return { awakeMs, woke }
    },
  }
}

export type AwakeDeadlineExpiry = 'stall' | 'ceiling'

export interface AwakeDeadlineOptions {
  /** Expires once this much awake time passes without progressed(). */
  stallMs?: number
  /** Expires once this much awake time passes in total. */
  ceilingMs?: number
  /** Monotonic milliseconds. */
  now?: () => number
}

export interface AwakeDeadline {
  /** Starts the stall window over. */
  progressed(): void
  stop(): void
}

/**
 * Calls `expire` once, when either window runs out in awake time. The clock is read every
 * awakeCheckIntervalMs (sooner for windows under a minute), so expiry lands up to one interval
 * after the window, never before it.
 */
export function createAwakeDeadline(
  options: AwakeDeadlineOptions,
  expire: (kind: AwakeDeadlineExpiry) => void,
): AwakeDeadline {
  const { stallMs, ceilingMs } = options
  const shortest = Math.min(stallMs ?? Infinity, ceilingMs ?? Infinity)
  if (!Number.isFinite(shortest) || shortest <= 0) throw new Error('awake deadline needs a positive stall or ceiling window')
  const intervalMs = Math.max(1, Math.min(awakeCheckIntervalMs, Math.ceil(shortest / 4)))
  const clock = createAwakeClock({ now: options.now, intervalMs })
  let progressAt = 0
  let stopped = false
  const timer = setInterval(check, intervalMs)
  // 只是看表，不该替谁撑着进程：要等的下载、子进程自己会撑着。
  timer.unref?.()

  function check(): void {
    if (stopped) return
    const { awakeMs, woke } = clock.read()
    // 刚醒，网多半还没连上，断掉的连接也要重新建：没进展的那段从这一刻重新算。
    if (woke) progressAt = awakeMs
    let kind: AwakeDeadlineExpiry | null = null
    if (ceilingMs !== undefined && awakeMs >= ceilingMs) kind = 'ceiling'
    else if (stallMs !== undefined && awakeMs - progressAt >= stallMs) kind = 'stall'
    if (!kind) return
    stop()
    expire(kind)
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }

  return {
    progressed() {
      if (stopped) return
      progressAt = clock.read().awakeMs
    },
    stop,
  }
}
