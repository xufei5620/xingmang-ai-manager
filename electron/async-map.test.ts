import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from './async-map'

describe('mapWithConcurrency', () => {
  it('keeps input order even when later items finish first', async () => {
    const delays = [30, 5, 20, 1, 10]
    const result = await mapWithConcurrency(delays, 2, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay))
      return `${index}:${delay}`
    })

    expect(result).toEqual(['0:30', '1:5', '2:20', '3:1', '4:10'])
  })

  it('never runs more than the limit at once', async () => {
    let active = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 20 }, (_, index) => index), 3, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setImmediate(resolve))
      active -= 1
    })

    expect(peak).toBe(3)
  })

  it('handles an empty list and rejects an invalid limit', async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([])
    await expect(mapWithConcurrency([1], 0, async () => 1)).rejects.toThrow('并发上限无效')
  })

  it('rejects with the first failure', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error('boom')
      return value
    })).rejects.toThrow('boom')
  })
})
