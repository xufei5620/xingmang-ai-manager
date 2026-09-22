import { describe, expect, it, vi } from 'vitest'
import type { AccelerationPhase, AccelerationState } from './acceleration-contract'
import { createAccelerationExpiryNotice, type AccelerationExpiryStage } from './acceleration-expiry-notice'

interface Timer {
  delay: number
  run: () => void
  cancelled: boolean
}

function state(phase: AccelerationPhase, remainingSeconds: number | null, overrides: Partial<AccelerationState> = {}): AccelerationState {
  return {
    scope: 'xm-account:1',
    phase,
    mode: 'system-proxy',
    totalSeconds: 1200,
    remainingSeconds,
    sessionSeconds: remainingSeconds === null ? 0 : 1200 - remainingSeconds,
    measuredAt: '2026-09-22T10:00:00.000Z',
    connectedAt: phase === 'active' ? '2026-09-22T10:00:00.000Z' : null,
    line: null,
    error: null,
    ...overrides,
  }
}

function fixture(reads: AccelerationState[] = []) {
  const timers: Timer[] = []
  const notices: Array<{ stage: AccelerationExpiryStage; key: string }> = []
  const queue = [...reads]
  const readState = vi.fn(async () => {
    const next = queue.shift()
    if (!next) throw new Error('账号已变更，请重新打开游戏加速。')
    // 真实接线里这一次读会经由服务的 onState 回到 observe()，夹具照做。
    notice.observe(next)
    return next
  })
  const notice = createAccelerationExpiryNotice({
    notify: (stage, key) => { notices.push({ stage, key }) },
    readState,
    schedule: (callback, delay) => {
      const timer: Timer = { delay, run: callback, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
  })
  const fire = async () => {
    const pending = timers.filter((timer) => !timer.cancelled)
    expect(pending.length).toBe(1)
    pending[0].cancelled = true
    pending[0].run()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  const live = () => timers.filter((timer) => !timer.cancelled)
  return { notice, notices, readState, live, fire }
}

describe('acceleration expiry reminders', () => {
  it('waits until five minutes are left before the first reminder', async () => {
    const h = fixture([state('active', 300)])
    h.notice.observe(state('active', 1200))
    // 1200 - 300 秒后才该醒来，而不是每秒都去读。
    expect(h.live().map((timer) => timer.delay)).toEqual([900_000])
    await h.fire()
    expect(h.notices).toEqual([{ stage: 'expiring', key: 'xm-account:1:2026-09-22T10:00:00.000Z' }])
  })

  it('reminds once more when the allowance actually ran out and acceleration stopped', async () => {
    const h = fixture([state('active', 300), state('exhausted', 0)])
    h.notice.observe(state('active', 1200))
    await h.fire()
    await h.fire()
    expect(h.notices.map((entry) => entry.stage)).toEqual(['expiring', 'exhausted'])
    // 两条共用同一次连接的编号，通知层据此各去重一次。
    expect(new Set(h.notices.map((entry) => entry.key)).size).toBe(1)
    expect(h.live()).toHaveLength(0)
  })

  it('reminds straight away when it first sees a session already inside the last five minutes', async () => {
    const h = fixture()
    h.notice.observe(state('active', 120))
    expect(h.notices.map((entry) => entry.stage)).toEqual(['expiring'])
    // 提醒过之后就只等到点那一次。
    expect(h.live().map((timer) => timer.delay)).toEqual([122_000])
  })

  it('does not repeat the reminder while the renderer keeps polling', () => {
    const h = fixture()
    h.notice.observe(state('active', 200))
    h.notice.observe(state('active', 190))
    h.notice.observe(state('active', 180))
    expect(h.notices).toHaveLength(1)
  })

  it('stays silent for an account whose allowance was already gone before this run', () => {
    const h = fixture()
    h.notice.observe(state('exhausted', 0))
    expect(h.notices).toEqual([])
    expect(h.live()).toHaveLength(0)
  })

  it('stays silent when the user stops acceleration with time still left', () => {
    const h = fixture()
    h.notice.observe(state('active', 900))
    h.notice.observe(state('idle', 900))
    expect(h.notices).toEqual([])
    expect(h.live()).toHaveLength(0)
  })

  // 停止失败的会话停在 stopping：隧道可能还在，这时候说「已断开」就是假话。
  it('never claims acceleration stopped while the stop has not settled', async () => {
    const stuck = () => state('stopping', 0, { error: '停止加速未完成，请稍后重试。' })
    const h = fixture([state('active', 1), ...Array.from({ length: 8 }, stuck)])
    h.notice.observe(state('active', 400))
    await h.fire()
    expect(h.notices.map((entry) => entry.stage)).toEqual(['expiring'])
    // 每次重读都还是 stopping：重试若干次之后收手，绝不补一条「已断开」。
    for (let attempt = 0; attempt < 7; attempt += 1) await h.fire()
    expect(h.notices.map((entry) => entry.stage)).toEqual(['expiring'])
    expect(h.live()).toHaveLength(0)
  })

  it('reminds again for the next session after a reconnect', async () => {
    const h = fixture([state('exhausted', 0)])
    h.notice.observe(state('active', 100))
    await h.fire()
    h.notice.observe(state('active', 100, { connectedAt: '2026-09-22T11:00:00.000Z' }))
    expect(h.notices.map((entry) => entry.key)).toEqual([
      'xm-account:1:2026-09-22T10:00:00.000Z',
      'xm-account:1:2026-09-22T10:00:00.000Z',
      'xm-account:1:2026-09-22T11:00:00.000Z',
    ])
    expect(h.notices.map((entry) => entry.stage)).toEqual(['expiring', 'exhausted', 'expiring'])
  })

  it('retries a failed read a bounded number of times and never guesses a reminder', async () => {
    const h = fixture()
    h.notice.observe(state('active', 100))
    expect(h.notices.map((entry) => entry.stage)).toEqual(['expiring'])
    // 第一次读失败（服务没就绪、账号正好切走）不该让这次会话就此没了下文。
    await h.fire()
    expect(h.live()).toHaveLength(1)
    for (let attempt = 0; attempt < 6; attempt += 1) await h.fire()
    expect(h.notices.map((entry) => entry.stage)).toEqual(['expiring'])
    expect(h.live()).toHaveLength(0)
  })

  it('still settles once a retried read finally answers', async () => {
    const h = fixture([])
    h.notice.observe(state('active', 100))
    await h.fire()
    h.readState.mockImplementationOnce(async () => {
      const answer = state('exhausted', 0)
      h.notice.observe(answer)
      return answer
    })
    await h.fire()
    expect(h.notices.map((entry) => entry.stage)).toEqual(['expiring', 'exhausted'])
  })

  it('forgets the tracked session on sign-out and on shutdown', () => {
    const signOut = fixture()
    signOut.notice.observe(state('active', 900))
    signOut.notice.reset()
    expect(signOut.live()).toHaveLength(0)
    signOut.notice.observe(state('exhausted', 0))
    expect(signOut.notices).toEqual([])

    const quit = fixture()
    quit.notice.observe(state('active', 900))
    quit.notice.dispose()
    expect(quit.live()).toHaveLength(0)
    quit.notice.observe(state('active', 100))
    expect(quit.notices).toEqual([])
  })

  it('keeps working when a reminder cannot be delivered', () => {
    const failures: string[] = []
    const notice = createAccelerationExpiryNotice({
      notify: () => { throw new Error('通知服务尚未就绪。') },
      readState: async () => state('exhausted', 0),
      schedule: () => () => undefined,
      log: (_level, event) => { failures.push(event) },
    })
    expect(() => notice.observe(state('active', 100))).not.toThrow()
    expect(failures).toEqual(['acceleration.expiry.notify.failed'])
  })
})
