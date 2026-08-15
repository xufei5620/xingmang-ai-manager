import { describe, expect, it } from 'vitest'
import {
  accountTaskPlatformLabel,
  accountTaskStatusLabel,
  buildAccountTaskQuery,
  emptyAccountTaskFilters,
} from './AccountTaskPanel'
import { accountUsageTimestamp } from './AccountUsagePanel'

describe('AccountTaskPanel helpers', () => {
  it('builds the complete trimmed task query', () => {
    expect(buildAccountTaskQuery({
      ...emptyAccountTaskFilters,
      startAt: '2026-08-15T08:00',
      endAt: '2026-08-15T09:00',
      platform: ' openai ',
      taskId: ' task_1 ',
      status: 'IN_PROGRESS',
      action: ' video ',
    }, 2, 20)).toEqual({
      page: 2,
      pageSize: 20,
      startTimestamp: accountUsageTimestamp('2026-08-15T08:00'),
      endTimestamp: accountUsageTimestamp('2026-08-15T09:00'),
      platform: 'openai',
      taskId: 'task_1',
      status: 'IN_PROGRESS',
      action: 'video',
    })
  })

  it('maps every known New API task status to Chinese', () => {
    expect(accountTaskStatusLabel('NOT_START')).toBe('未开始')
    expect(accountTaskStatusLabel('SUBMITTED')).toBe('已提交')
    expect(accountTaskStatusLabel('QUEUED')).toBe('排队中')
    expect(accountTaskStatusLabel('IN_PROGRESS')).toBe('处理中')
    expect(accountTaskStatusLabel('SUCCESS')).toBe('已完成')
    expect(accountTaskStatusLabel('FAILURE')).toBe('失败')
    expect(accountTaskStatusLabel('FUTURE')).toBe('FUTURE')
  })

  it('turns numeric New API task platforms into user-facing provider names', () => {
    expect(accountTaskPlatformLabel('55')).toBe('Sora')
    expect(accountTaskPlatformLabel('24')).toBe('Gemini')
    expect(accountTaskPlatformLabel('gemini')).toBe('Gemini')
    expect(accountTaskPlatformLabel('suno')).toBe('Suno')
    expect(accountTaskPlatformLabel('future-platform')).toBe('future-platform')
    expect(accountTaskPlatformLabel('')).toBe('未知平台')
  })
})
