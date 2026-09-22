import { describe, expect, it, vi } from 'vitest'
import type { AccelerationState } from './acceleration-contract'
import { createAccelerationPower } from './acceleration-power'

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function fixture(scope: string | null = 'xm-account:1') {
  const order: string[] = []
  const options = {
    suspend: vi.fn(async () => { order.push('suspend') }),
    resume: vi.fn(async () => { order.push('resume') }),
    getAccountScope: () => scope,
    readState: vi.fn(async (value: string) => {
      order.push(`read:${value}`)
      return { scope: value } as AccelerationState
    }),
    log: vi.fn(),
  }
  return { power: createAccelerationPower(options), options, order }
}

describe('acceleration across sleep', () => {
  it('pauses the session before sleep and, after waking, checks it and then re-reads the state for every surface', async () => {
    const h = fixture()
    h.power.suspended()
    await settle()
    h.power.resumed()
    await settle()
    expect(h.order).toEqual(['suspend', 'resume', 'read:xm-account:1'])
  })

  it('still re-reads after a failed wake-up check, and skips the read when nobody is signed in', async () => {
    const h = fixture()
    h.options.resume.mockRejectedValueOnce(new Error('本机加速进程已断开，请重新打开软件。'))
    h.power.resumed()
    await settle()
    expect(h.options.readState).toHaveBeenCalledOnce()
    expect(h.options.log).toHaveBeenCalledWith('warn', 'acceleration.power.resume.failed', expect.any(String), expect.any(Object))

    const signedOut = fixture(null)
    signedOut.power.resumed()
    await settle()
    expect(signedOut.options.readState).not.toHaveBeenCalled()
  })

  it('never throws out of the power event handlers', async () => {
    const h = fixture()
    h.options.suspend.mockRejectedValueOnce(new Error('x'))
    h.options.readState.mockRejectedValueOnce(new Error('y'))
    h.options.log.mockImplementation(() => { throw new Error('log failed') })
    expect(() => h.power.suspended()).not.toThrow()
    expect(() => h.power.resumed()).not.toThrow()
    await settle()
  })
})
