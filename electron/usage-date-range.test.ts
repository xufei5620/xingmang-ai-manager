import { describe, expect, it } from 'vitest'
import { usageCalendarDate, usageDateRange } from './usage-date-range'

describe('usage calendar dates', () => {
  it('preserves local date across UTC midnight and DST boundaries', () => {
    const instant = new Date('2026-09-17T16:30:00Z')
    expect(usageCalendarDate(instant, 'Asia/Shanghai')).toBe('2026-09-18')
    expect(usageCalendarDate(instant, 'America/Los_Angeles')).toBe('2026-09-17')
    expect(usageDateRange({ timezone: 'Asia/Shanghai' }, instant)).toEqual({ startDate: '2026-09-12', endDate: '2026-09-18', timezone: 'Asia/Shanghai' })
    expect(usageDateRange({ timezone: 'America/Los_Angeles' }, new Date('2026-03-08T10:30:00Z'))).toEqual({ startDate: '2026-03-02', endDate: '2026-03-08', timezone: 'America/Los_Angeles' })
  })
  it('keeps explicit inclusive dates unchanged and rejects invalid dates', () => {
    expect(usageDateRange({ startDate: '2024-02-29', endDate: '2024-03-01', timezone: 'UTC' })).toEqual({ startDate: '2024-02-29', endDate: '2024-03-01', timezone: 'UTC' })
    expect(() => usageDateRange({ startDate: '2026-02-29' })).toThrow('有效日期')
    expect(() => usageDateRange({ timezone: 'not/a-zone' })).toThrow('有效时区')
  })
})
