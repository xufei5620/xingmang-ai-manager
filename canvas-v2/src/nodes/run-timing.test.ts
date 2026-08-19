import { describe, expect, it } from 'vitest'
import { formatRunElapsed, runElapsedMilliseconds } from './run-timing'

describe('node run timing', () => {
  it('calculates bounded elapsed time from an ISO timestamp', () => {
    expect(runElapsedMilliseconds('2026-08-19T01:00:00.000Z', Date.parse('2026-08-19T01:00:09.400Z'))).toBe(9_400)
    expect(runElapsedMilliseconds('invalid', 100)).toBe(0)
    expect(runElapsedMilliseconds('2026-08-19T01:00:10.000Z', Date.parse('2026-08-19T01:00:09.000Z'))).toBe(0)
  })

  it('formats short and minute-scale durations compactly', () => {
    expect(formatRunElapsed(9_900)).toBe('9 秒')
    expect(formatRunElapsed(65_000)).toBe('1:05')
  })
})
