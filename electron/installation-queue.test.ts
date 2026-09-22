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
})
