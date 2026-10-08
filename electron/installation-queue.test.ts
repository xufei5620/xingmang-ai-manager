import { describe, expect, it } from 'vitest'
import { InstallationQueue } from './installation-queue'

describe('InstallationQueue', () => {
  it('serializes different writes and deduplicates the same write', async () => {
    const queue = new InstallationQueue()
    const events: string[] = []
    let release!: () => void
    const first = queue.enqueue('cli:codex', async () => {
      events.push('start-codex')
      await new Promise<void>((resolve) => { release = resolve })
      events.push('finish-codex')
      return 'codex'
    })
    const duplicate = queue.enqueue('cli:codex', async () => {
      events.push('duplicate-should-not-run')
      return 'duplicate'
    })
    const second = queue.enqueue('cli:claude', async () => {
      events.push('run-claude')
      return 'claude'
    })

    expect(duplicate).toBe(first)
    expect(queue.snapshot()).toEqual({ activeKey: 'cli:codex', pendingKeys: ['cli:claude'] })
    release()
    await expect(first).resolves.toBe('codex')
    await expect(second).resolves.toBe('claude')
    expect(events).toEqual(['start-codex', 'finish-codex', 'run-claude'])
    expect(queue.snapshot()).toEqual({ activeKey: null, pendingKeys: [] })
  })

  it('releases the lock after a failed job', async () => {
    const queue = new InstallationQueue()
    await expect(queue.enqueue('node', async () => {
      throw new Error('first failed')
    })).rejects.toThrow('first failed')
    await expect(queue.enqueue('npm', async () => 'next')).resolves.toBe('next')
    expect(queue.busy).toBe(false)
  })


  it('moves its revision whenever an entry starts or finishes, including a failed one', async () => {
    const queue = new InstallationQueue()
    const idle = queue.revision
    let release!: () => void
    const running = queue.enqueue('cli:codex', () => new Promise<void>((resolve) => { release = resolve }))
    await Promise.resolve()
    const started = queue.revision
    expect(started).toBeGreaterThan(idle)
    release()
    await running
    expect(queue.revision).toBeGreaterThan(started)
    const beforeFailure = queue.revision
    await expect(queue.enqueue('cli:claude', async () => { throw new Error('install failed') })).rejects.toThrow('install failed')
    expect(queue.revision).toBe(beforeFailure + 2)
  })
  it('notifies listeners when entries start and finish without an idle gap between queued entries', async () => {
    const queue = new InstallationQueue()
    const seen: Array<string | null> = []
    const stop = queue.onChange((snapshot) => {
      seen.push(snapshot.activeKey)
      throw new Error('listener failure must not break the queue')
    })
    const first = queue.enqueue('runtime:node', async () => 'node')
    const second = queue.enqueue('cli:install:claude', async () => 'claude')
    await expect(first).resolves.toBe('node')
    await expect(second).resolves.toBe('claude')
    expect(seen).toEqual(['runtime:node', 'cli:install:claude', null])
    stop()
    await queue.enqueue('runtime:python', async () => undefined)
    expect(seen).toHaveLength(3)
  })

  it('drops an entry whose signal aborts while it waits, without running it or waiting for the one ahead', async () => {
    const queue = new InstallationQueue()
    const events: string[] = []
    let release!: () => void
    const ahead = queue.enqueue('runtime:node', () => new Promise<void>((resolve) => { release = resolve }))
    const controller = new AbortController()
    const waiting = queue.enqueue('external-client:install:claudeDesktop', async () => {
      events.push('cancelled-entry-ran')
    }, { signal: controller.signal })
    const behind = queue.enqueue('cli:install:codex', async () => { events.push('codex') })
    const settled = waiting.then(() => 'resolved', (reason: unknown) => reason)
    const revision = queue.revision
    const reason = new Error('安装已取消')

    controller.abort(reason)
    await new Promise<void>((resolve) => setImmediate(resolve))

    // 前面那项还在跑：出队的这一项不等它，拒绝的就是信号带来的那个 reason。
    expect(await Promise.race([settled, Promise.resolve('still waiting for the entry ahead')])).toBe(reason)
    expect(queue.snapshot()).toEqual({ activeKey: 'runtime:node', pendingKeys: ['cli:install:codex'] })
    // 它没开始过，机器上什么都没变。
    expect(queue.revision).toBe(revision)
    // 同一个 key 能重新排进去，不会拿到出队那一项的结果。
    const again = queue.enqueue('external-client:install:claudeDesktop', async () => { events.push('claude-desktop') })
    expect(again).not.toBe(waiting)
    release()
    await Promise.all([ahead, behind, again])
    expect(events).toEqual(['codex', 'claude-desktop'])
  })

  it('leaves an entry that has started to its own task when its signal aborts', async () => {
    const queue = new InstallationQueue()
    const controller = new AbortController()
    let finish!: () => void
    const running = queue.enqueue('cli:install:claude', () => new Promise<string>((resolve) => {
      finish = () => resolve('finished')
    }), { signal: controller.signal })
    const next = queue.enqueue('cli:install:codex', async () => 'codex')

    controller.abort(new Error('安装已取消'))
    await new Promise<void>((resolve) => setImmediate(resolve))

    // 轮到它以后停不停由任务自己决定：队列不替它拒绝，也不放后面的插队。
    expect(queue.snapshot()).toEqual({ activeKey: 'cli:install:claude', pendingKeys: ['cli:install:codex'] })
    finish()
    await expect(running).resolves.toBe('finished')
    await expect(next).resolves.toBe('codex')
  })

  it('turns away an entry whose signal was aborted before it was queued', async () => {
    const queue = new InstallationQueue()
    const controller = new AbortController()
    const reason = new Error('安装已取消')
    controller.abort(reason)
    let ran = false

    await expect(queue.enqueue('cli:install:claude', async () => { ran = true }, { signal: controller.signal })).rejects.toBe(reason)
    expect(ran).toBe(false)
    expect(queue.busy).toBe(false)
  })
})
