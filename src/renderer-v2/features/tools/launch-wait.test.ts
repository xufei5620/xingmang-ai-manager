import { describe, expect, it } from 'vitest'
import { accountConnectionPollMs, accountConnectionWaitMaxMs, waitWhileAccountConnectionPending } from './launch-wait'

function clock() {
  const state = { now: 0, slept: [] as number[] }
  return {
    state,
    now: () => state.now,
    sleep: async (ms: number) => { state.slept.push(ms); state.now += ms },
  }
}

describe('waitWhileAccountConnectionPending (0.2.22 打磨 B4)', () => {
  it('returns at once when nothing is pending, without sleeping', async () => {
    const time = clock()
    const outcome = await waitWhileAccountConnectionPending({ pending: () => false, current: () => true, ...time })
    expect(outcome).toBe('ready')
    expect(time.state.slept).toEqual([])
  })

  it('polls until the account round finishes, then reports ready', async () => {
    const time = clock()
    let rounds = 3
    const outcome = await waitWhileAccountConnectionPending({ pending: () => rounds-- > 0, current: () => true, ...time })
    expect(outcome).toBe('ready')
    expect(time.state.slept).toEqual([accountConnectionPollMs, accountConnectionPollMs, accountConnectionPollMs])
  })

  it('stops when the account changed or the window closed while waiting', async () => {
    const time = clock()
    let checks = 0
    const outcome = await waitWhileAccountConnectionPending({ pending: () => true, current: () => ++checks < 3, ...time })
    expect(outcome).toBe('stopped')
    expect(time.state.slept).toHaveLength(2)
  })

  it('gives up after the cap so a stuck round cannot hold the launch forever', async () => {
    const time = clock()
    const outcome = await waitWhileAccountConnectionPending({ pending: () => true, current: () => true, ...time })
    expect(outcome).toBe('timeout')
    expect(time.state.now).toBeGreaterThanOrEqual(accountConnectionWaitMaxMs)
    expect(time.state.now).toBeLessThan(accountConnectionWaitMaxMs + accountConnectionPollMs)
  })

  it('checks the account before the round, so a stale account never opens even when the round is done', async () => {
    const time = clock()
    const outcome = await waitWhileAccountConnectionPending({ pending: () => false, current: () => false, ...time })
    expect(outcome).toBe('stopped')
  })
})
