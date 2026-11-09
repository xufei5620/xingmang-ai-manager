import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  awakeCheckIntervalMs,
  awakeGapMs,
  createAwakeClock,
  createAwakeDeadline,
} from './awake-deadline'

afterEach(() => {
  vi.useRealTimers()
})

/**
 * 醒着的时候单调时钟和计时器一起走；睡着的时候只有时钟往前跳、计时器一拍都不走，醒来第一拍才看见那段
 * 跳变（Mac、Windows 上睡着时到期的计时器一醒补触发的就是这一拍）。
 */
function createMachine() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  let slept = 0
  return {
    now: () => performance.now() + slept,
    async awake(milliseconds: number): Promise<void> {
      await vi.advanceTimersByTimeAsync(milliseconds)
    },
    sleep(milliseconds: number): void {
      slept += milliseconds
    },
  }
}

describe('createAwakeClock', () => {
  it('adds up the steps between readings while the machine is awake', () => {
    let at = 1_000
    const clock = createAwakeClock({ now: () => at })
    at += 15_000
    expect(clock.read()).toEqual({ awakeMs: 15_000, woke: false })
    at += 20_000
    expect(clock.read()).toEqual({ awakeMs: 35_000, woke: false })
  })

  it('still counts a reading that a busy main process ran late', () => {
    let at = 0
    const clock = createAwakeClock({ now: () => at })
    at += awakeGapMs
    expect(clock.read()).toEqual({ awakeMs: awakeGapMs, woke: false })
  })

  it('takes a step far longer than the interval for sleep and adds only one interval for it', () => {
    let at = 0
    const clock = createAwakeClock({ now: () => at })
    at += 60_000
    clock.read()
    at += 10 * 60_000
    expect(clock.read()).toEqual({ awakeMs: 60_000 + awakeCheckIntervalMs, woke: true })
    at += 15_000
    expect(clock.read()).toEqual({ awakeMs: 75_000 + awakeCheckIntervalMs, woke: false })
  })

  it('treats a clock that runs backwards as a gap rather than negative time', () => {
    let at = 100_000
    const clock = createAwakeClock({ now: () => at, intervalMs: 5_000 })
    at -= 50_000
    expect(clock.read()).toEqual({ awakeMs: 5_000, woke: true })
  })

  it('never takes two of a slow reader\'s own intervals for sleep', () => {
    let at = 0
    const clock = createAwakeClock({ now: () => at, intervalMs: 45_000 })
    at += 90_000
    expect(clock.read()).toEqual({ awakeMs: 90_000, woke: false })
  })
})

describe('createAwakeDeadline', () => {
  it('needs at least one window', () => {
    expect(() => createAwakeDeadline({}, vi.fn())).toThrow()
    expect(() => createAwakeDeadline({ ceilingMs: 0 }, vi.fn())).toThrow()
  })

  it('expires once the stall window passes without progress, and not before', async () => {
    const machine = createMachine()
    const expire = vi.fn()
    const deadline = createAwakeDeadline({ stallMs: 3 * 60_000, now: machine.now }, expire)
    await machine.awake(60_000)
    deadline.progressed()

    await machine.awake(3 * 60_000 - 1)
    expect(expire).not.toHaveBeenCalled()
    await machine.awake(1)
    expect(expire).toHaveBeenCalledTimes(1)
    expect(expire).toHaveBeenCalledWith('stall')
  })

  it('starts the stall window over after a sleep instead of expiring the moment the machine wakes', async () => {
    const machine = createMachine()
    const expire = vi.fn()
    createAwakeDeadline({ stallMs: 3 * 60_000, ceilingMs: 30 * 60_000, now: machine.now }, expire)
    await machine.awake(2 * 60_000 + 45_000)

    // Shut for ten minutes, a quarter of a minute short of the stall window before that.
    machine.sleep(10 * 60_000)
    await machine.awake(awakeCheckIntervalMs)
    expect(expire).not.toHaveBeenCalled()

    // The whole window again from the moment it woke, and then it does give up.
    await machine.awake(3 * 60_000 - 1)
    expect(expire).not.toHaveBeenCalled()
    await machine.awake(1)
    expect(expire).toHaveBeenCalledWith('stall')
  })

  it('leaves the sleep out of the ceiling', async () => {
    const machine = createMachine()
    const expire = vi.fn()
    createAwakeDeadline({ ceilingMs: 30 * 60_000, now: machine.now }, expire)
    await machine.awake(25 * 60_000)
    machine.sleep(60 * 60_000)
    await machine.awake(awakeCheckIntervalMs)
    expect(expire).not.toHaveBeenCalled()

    // The gap counted as one interval; the rest of the ceiling still has to pass awake.
    await machine.awake(5 * 60_000 - 2 * awakeCheckIntervalMs)
    expect(expire).not.toHaveBeenCalled()
    await machine.awake(awakeCheckIntervalMs)
    expect(expire).toHaveBeenCalledTimes(1)
    expect(expire).toHaveBeenCalledWith('ceiling')
  })

  it('still reaches the ceiling when every tick of a throttled main process looks like a gap', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let at = 0
    const expire = vi.fn()
    createAwakeDeadline({ stallMs: 3 * 60_000, ceilingMs: 30 * 60_000, now: () => at }, expire)
    // Each tick arrives two minutes after the last. The stall window keeps starting over, but
    // the download is never left running without an end.
    for (let tick = 1; tick <= (30 * 60_000) / awakeCheckIntervalMs; tick += 1) {
      at += 2 * 60_000
      await vi.advanceTimersByTimeAsync(awakeCheckIntervalMs)
    }
    expect(expire).toHaveBeenCalledTimes(1)
    expect(expire).toHaveBeenCalledWith('ceiling')
  })

  it('reads the clock more often for a window under a minute', async () => {
    const machine = createMachine()
    const expire = vi.fn()
    createAwakeDeadline({ ceilingMs: 1_000, now: machine.now }, expire)
    await machine.awake(999)
    expect(expire).not.toHaveBeenCalled()
    await machine.awake(250)
    expect(expire).toHaveBeenCalledWith('ceiling')
  })

  it('expires only once and stays quiet once stopped', async () => {
    const machine = createMachine()
    const expire = vi.fn()
    createAwakeDeadline({ stallMs: 60_000, now: machine.now }, expire)
    await machine.awake(10 * 60_000)
    expect(expire).toHaveBeenCalledTimes(1)

    const stopped = vi.fn()
    const deadline = createAwakeDeadline({ stallMs: 60_000, ceilingMs: 120_000, now: machine.now }, stopped)
    deadline.stop()
    deadline.progressed()
    await machine.awake(10 * 60_000)
    expect(stopped).not.toHaveBeenCalled()
  })
})
