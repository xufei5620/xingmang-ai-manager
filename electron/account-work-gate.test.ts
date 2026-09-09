import { describe, expect, it } from 'vitest'
import { createAccountWorkGate } from './account-work-gate'
import { BoundedOperationQueue } from './bounded-operation-queue'

describe('account work drain', () => {
  it('waits for the last local write and discards the response from an old identity', async () => {
    let revision = 0
    let busy = false
    const gate = createAccountWorkGate({ revision: () => revision, assertReady: () => { if (busy) throw new Error('switching') } })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const work = gate.run(async () => { await blocked; return 'old secret' })
    const rejected = expect(work).rejects.toThrow('账号上下文已变化')
    busy = true
    revision++
    expect(() => gate.run(() => 'new work')).toThrow('switching')
    let drained = false
    const drain = gate.whenIdle().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    await rejected
    await drain
    expect(drained).toBe(true)
  })

  it('does not treat queue cancellation as completion of an underlying file write', async () => {
    const queue = new BoundedOperationQueue({ maxActive: 1, maxQueued: 1 })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const work = queue.enqueue(async () => { await blocked; return true })
    await Promise.resolve()
    work.cancel(new Error('cancel'))
    await expect(work.promise).rejects.toThrow('cancel')
    let drained = false
    const idle = queue.whenIdle().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    await idle
    expect(drained).toBe(true)
  })
})
