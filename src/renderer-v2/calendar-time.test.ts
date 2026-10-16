import { describe, expect, it } from 'vitest'
import { formatClockTime } from './calendar-time'

describe('formatClockTime', () => {
  const now = new Date(2026, 9, 15, 15, 0).getTime()

  it('always carries the clock so two backups on one day stay apart', () => {
    expect(formatClockTime(new Date(2026, 9, 15, 9, 12).getTime(), now)).toBe('今天 09:12')
    // 刚做的那份也写钟点，不写「刚刚」。
    expect(formatClockTime(now - 5_000, now)).toBe('今天 14:59')
    expect(formatClockTime(new Date(2026, 9, 14, 18, 40).getTime(), now)).toBe('昨天 18:40')
    expect(formatClockTime(new Date(2026, 9, 12, 18, 40).getTime(), now)).toBe('10月12日 18:40')
  })

  it('adds the year for earlier years', () => {
    expect(formatClockTime(new Date(2025, 11, 31, 23, 5).getTime(), now)).toBe('2025年12月31日 23:05')
  })

  it('counts calendar days rather than 24-hour spans', () => {
    const earlyMorning = new Date(2026, 9, 15, 1, 0).getTime()
    expect(formatClockTime(new Date(2026, 9, 14, 23, 0).getTime(), earlyMorning)).toBe('昨天 23:00')
  })

  it('returns null for a time it cannot read', () => {
    expect(formatClockTime(Number.NaN, now)).toBeNull()
  })
})
