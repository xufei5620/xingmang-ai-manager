import { describe, expect, it } from 'vitest'
import {
  accountUsagePagination,
  accountUsageTimestamp,
  buildAccountUsageQuery,
  emptyAccountUsageFilters,
} from './AccountUsagePanel'

describe('AccountUsagePanel helpers', () => {
  it('builds the complete trimmed query without empty filters', () => {
    expect(buildAccountUsageQuery({
      ...emptyAccountUsageFilters,
      startAt: '2026-08-15T08:00',
      endAt: '2026-08-15T09:00',
      modelName: ' gpt-5 ',
      group: ' codex-pro ',
      type: '2',
      tokenName: ' desktop-key ',
      requestId: ' req-1 ',
      upstreamRequestId: ' up-1 ',
    }, 3, 50)).toEqual({
      page: 3,
      pageSize: 50,
      startTimestamp: accountUsageTimestamp('2026-08-15T08:00'),
      endTimestamp: accountUsageTimestamp('2026-08-15T09:00'),
      modelName: 'gpt-5',
      group: 'codex-pro',
      type: 2,
      tokenName: 'desktop-key',
      requestId: 'req-1',
      upstreamRequestId: 'up-1',
    })
  })

  it('renders compact pagination with stable ellipsis slots', () => {
    expect(accountUsagePagination(1, 3)).toEqual([1, 2, 3])
    expect(accountUsagePagination(6, 12)).toEqual([1, null, 5, 6, 7, null, 12])
  })
})
