import { describe, expect, it, vi } from 'vitest'
import type { AccelerationPhase, AccelerationState } from './acceleration-contract'
import { createAccelerationInterruptionNotice, type AccelerationInterruptionOutcome } from './acceleration-interruption-notice'

interface Timer {
  delay: number
  run: () => void
  cancelled: boolean
}

const connectedAt = '2026-09-22T10:00:00.000Z'
const key = `xm-account:1:${connectedAt}`

function state(phase: AccelerationPhase, overrides: Partial<AccelerationState> = {}): AccelerationState {
  return {
    scope: 'xm-account:1',
    phase,
    mode: 'system-proxy',
    totalSeconds: 1200,
    remainingSeconds: 900,
    sessionSeconds: 300,
    measuredAt: '2026-09-22T10:05:00.000Z',
    connectedAt: phase === 'active' ? connectedAt : null,
    line: null,
    error: null,
    ...overrides,
  }
}

function fixture(reads: Array<AccelerationState | Error> = [], scope: string | null = 'xm-account:1') {
  const timers: Timer[] = []
  const notices: Array<{ outcome: AccelerationInterruptionOutcome; key: string }> = []
  const queue = [...reads]
  const readState = vi.fn(async () => {
    const next = queue.shift()
    if (!next || next instanceof Error) throw next ?? new Error('加速服务尚未就绪。')
    // 真实接线里这一次读会经由服务的 onState 回到 observe()，夹具照做。
    notice.observe(next)
    return next
  })
  const notice = createAccelerationInterruptionNotice({
    notify: (outcome, eventKey) => { notices.push({ outcome, key: eventKey }) },
    readState,
    getAccountScope: () => scope,
    schedule: (callback, delay) => {
      const timer: Timer = { delay, run: callback, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
  })
  const live = () => timers.filter((timer) => !timer.cancelled)
  const fire = async () => {
    const pending = live()
    expect(pending.length).toBe(1)
    pending[0].cancelled = true
    pending[0].run()
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
  }
  return { notice, notices, readState, live, fire }
}

describe('acceleration interruption notice', () => {
  it('reads once after the core exits and says the network is back only when the session really stopped', async () => {
    const h = fixture([state('error', { error: '加速意外断开了，网络已恢复正常，可以重新连接。' })])
    h.notice.observe(state('active'))
    h.notice.runtimeExited()
    expect(h.live().map((timer) => timer.delay)).toEqual([0])
    await h.fire()
    expect(h.readState).toHaveBeenCalledOnce()
    expect(h.notices).toEqual([{ outcome: 'restored', key }])
    expect(h.live()).toHaveLength(0)
  })

  it('still recognises the session when a page poll saw the disconnect before the exit report', async () => {
    const h = fixture([state('error')])
    h.notice.observe(state('active'))
    h.notice.observe(state('error'))
    h.notice.runtimeExited()
    await h.fire()
    expect(h.notices).toEqual([{ outcome: 'restored', key }])
  })

  it('keeps reading while the stop has not settled and then says the network may still be down', async () => {
    const h = fixture(Array.from({ length: 6 }, () => state('stopping', { remainingSeconds: 900 })))
    h.notice.observe(state('active'))
    h.notice.runtimeExited()
    for (let attempt = 0; attempt < 6; attempt += 1) await h.fire()
    expect(h.notices).toEqual([{ outcome: 'unrestored', key }])
    expect(h.live()).toHaveLength(0)
  })

  it('settles as restored once a retried read finds the session stopped', async () => {
    const h = fixture([state('stopping'), new Error('加速服务尚未就绪。'), state('idle')])
    h.notice.observe(state('active'))
    h.notice.runtimeExited()
    await h.fire()
    expect(h.live().map((timer) => timer.delay)).toEqual([5000])
    await h.fire()
    await h.fire()
    expect(h.notices).toEqual([{ outcome: 'restored', key }])
  })

  it('stays quiet about a session that was never seen connected in this run', async () => {
    const h = fixture([state('error')])
    h.notice.runtimeExited()
    h.notice.helperExited(true)
    expect(h.live()).toHaveLength(0)
    expect(h.notices).toEqual([])
  })

  it('stays quiet when the user already reconnected before the read', async () => {
    const h = fixture([state('active', { connectedAt: '2026-09-22T10:06:00.000Z' })])
    h.notice.observe(state('active'))
    h.notice.runtimeExited()
    await h.fire()
    expect(h.notices).toEqual([])
    expect(h.live()).toHaveLength(0)
  })

  it('reports a killed helper only when the last state was still accelerating', async () => {
    const idle = fixture([state('idle')])
    idle.notice.observe(state('active'))
    idle.notice.observe(state('idle'))
    idle.notice.helperExited(true)
    expect(idle.live()).toHaveLength(0)
    expect(idle.notices).toEqual([])

    const running = fixture([state('idle')])
    running.notice.observe(state('active'))
    running.notice.helperExited(true)
    await running.fire()
    expect(running.notices).toEqual([{ outcome: 'restored', key }])
  })

  it('says the network may be down right away when the relaunched helper could not restore it', async () => {
    const h = fixture([new Error('本机加速进程初始化未完成。')])
    h.notice.observe(state('active'))
    h.notice.helperExited(false)
    expect(h.notices).toEqual([{ outcome: 'unrestored', key }])
    // 再读一次让托盘跟上（这一读也会再试着拉起辅助进程），但不再多发一条。
    await Promise.resolve()
    await Promise.resolve()
    expect(h.readState).toHaveBeenCalledOnce()
    expect(h.live()).toHaveLength(0)
  })

  it('reminds once per connection even if both the core and the helper report it', async () => {
    const h = fixture([state('error'), state('idle')])
    h.notice.observe(state('active'))
    h.notice.runtimeExited()
    await h.fire()
    h.notice.helperExited(true)
    h.notice.runtimeExited()
    expect(h.live()).toHaveLength(0)
    expect(h.notices).toHaveLength(1)
  })

  it('forgets the session on account change and after disposal', async () => {
    const h = fixture([state('error')])
    h.notice.observe(state('active'))
    h.notice.reset()
    h.notice.runtimeExited()
    expect(h.live()).toHaveLength(0)
    h.notice.observe(state('active'))
    h.notice.runtimeExited()
    h.notice.dispose()
    expect(h.live()).toHaveLength(0)
    expect(h.notices).toEqual([])
  })

  it('ignores a report that belongs to a different account than the one signed in now', () => {
    const h = fixture([state('error')], 'api-account:2')
    h.notice.observe(state('active'))
    h.notice.runtimeExited()
    expect(h.live()).toHaveLength(0)
  })

  it('does not let a failing notifier or logger break the flow', async () => {
    const readState = vi.fn(async (_scope: string) => state('idle'))
    const notice = createAccelerationInterruptionNotice({
      notify: () => { throw new Error('系统通知没有显示。') },
      readState: async (scope) => {
        const value = await readState(scope)
        notice.observe(value)
        return value
      },
      getAccountScope: () => 'xm-account:1',
      log: () => { throw new Error('log failed') },
      schedule: (callback) => { callback(); return () => undefined },
    })
    notice.observe(state('active'))
    expect(() => notice.runtimeExited()).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(readState).toHaveBeenCalledOnce()
  })
})
