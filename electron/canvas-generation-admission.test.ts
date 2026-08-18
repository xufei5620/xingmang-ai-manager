import { describe, expect, it } from 'vitest'
import { CanvasGenerationAdmission } from './canvas-generation-admission'

describe('CanvasGenerationAdmission', () => {
  it('bounds concurrent direct generation per canvas window', async () => {
    const guard = new CanvasGenerationAdmission({ maxActive: 2, maxStartsPerWindow: 10 })
    const releases: Array<() => void> = []
    const operation = () => new Promise<number>((resolve) => releases.push(() => resolve(1)))
    const first = guard.run(7, operation)
    const second = guard.run(7, operation)
    await expect(guard.run(7, operation)).rejects.toThrow('任务过多')
    releases.splice(0).forEach((release) => release())
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1])
  })

  it('bounds starts in a rolling window and isolates owners', async () => {
    let now = 1_000
    const guard = new CanvasGenerationAdmission({ maxActive: 2, maxStartsPerWindow: 2, windowMs: 100, now: () => now })
    await guard.run(7, async () => 1)
    await guard.run(7, async () => 2)
    await expect(guard.run(7, async () => 3)).rejects.toThrow('过于频繁')
    await expect(guard.run(8, async () => 4)).resolves.toBe(4)
    now += 100
    await expect(guard.run(7, async () => 5)).resolves.toBe(5)
  })

  it('releases active capacity after failures and can clear closed owners', async () => {
    const guard = new CanvasGenerationAdmission({ maxActive: 1, maxStartsPerWindow: 2 })
    await expect(guard.run(7, async () => { throw new Error('failed') })).rejects.toThrow('failed')
    await expect(guard.run(7, async () => 'retry')).resolves.toBe('retry')
    guard.releaseOwner(7)
    await expect(guard.run(7, async () => 'fresh')).resolves.toBe('fresh')
  })
})
