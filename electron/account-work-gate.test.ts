import { describe, expect, it } from 'vitest'
import { createAccountWorkGate } from './account-work-gate'
import { BoundedOperationQueue } from './bounded-operation-queue'
import { InstallationQueue } from './installation-queue'

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

  // #1085：「打开」排在一次很长的安装后面时，换账号只等真正在跑的那些，不陪排队的等到 30 秒超时。
  it('does not wait for queued work until the queue starts it, and aborts what is still queued when an account change begins', async () => {
    let revision = 0
    let busy = false
    const gate = createAccountWorkGate({ revision: () => revision, assertReady: () => { if (busy) throw new Error('switching') } })
    const queue = new InstallationQueue()
    let finishInstall!: () => void
    const install = queue.enqueue('cli:install:claude', () => new Promise<void>((resolve) => { finishInstall = resolve }))
    const work = gate.queue()
    let started = false
    const launch = queue.enqueue('cli:launch:codex', () => work.run(async () => { started = true }), { signal: work.signal })

    // 排着队的还不算账号工作：whenIdle 不等它，也不等前面那次安装。
    await gate.whenIdle()
    busy = true
    revision++
    gate.abortQueued()
    await expect(launch).rejects.toThrow('账号上下文已变化')
    finishInstall()
    await install
    expect(started).toBe(false)
    expect(queue.busy).toBe(false)
  })

  it('counts queued work once it starts, and refuses it if the account changed while it waited', async () => {
    let revision = 0
    const gate = createAccountWorkGate({ revision: () => revision, assertReady: () => undefined })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const running = gate.queue().run(async () => { await blocked; return 'opened' })
    let drained = false
    const drain = gate.whenIdle().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    await expect(running).resolves.toBe('opened')
    await drain

    const waiting = gate.queue()
    revision++
    let ran = false
    await expect(waiting.run(async () => { ran = true })).rejects.toThrow('账号上下文已变化')
    expect(ran).toBe(false)
  })

  it('refuses to queue work while an account change is in progress, and lets a released entry outlive an abort', async () => {
    let busy = true
    const gate = createAccountWorkGate({ revision: () => 0, assertReady: () => { if (busy) throw new Error('switching') } })
    expect(() => gate.queue()).toThrow('switching')
    busy = false
    const shared = gate.queue()
    shared.release()
    gate.abortQueued()
    expect(shared.signal.aborted).toBe(false)
  })

  // #1085：Codex 桌面端发出启动请求以后不算账号工作，没等到窗口要补连加速之前先问一句账号换没换。
  it('reports queued work as current only while its account stays the same and no change is in progress', () => {
    let revision = 0
    let busy = false
    const gate = createAccountWorkGate({ revision: () => revision, assertReady: () => { if (busy) throw new Error('switching') } })
    const work = gate.queue()
    expect(work.isCurrent()).toBe(true)
    busy = true
    expect(work.isCurrent()).toBe(false)
    busy = false
    expect(work.isCurrent()).toBe(true)
    revision++
    expect(work.isCurrent()).toBe(false)
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
