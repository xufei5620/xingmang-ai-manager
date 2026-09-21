import { describe, expect, it } from 'vitest'
import { startupCheckFailure, startupCheckLogContext, startupDiagnosticsIssues, withStartupNotice, withoutStartupNotice } from './startup-notice'

describe('startup check notices', () => {
  it('keeps the backend sentence as the body so support still sees the original wording', () => {
    const notice = startupCheckFailure('update', '本地更新源暂时不可用')
    expect(notice.title).toBe('更新检查没有完成')
    expect(notice.body).toBe('本地更新源暂时不可用')
    expect(notice.failure).toBe(true)
    expect(notice.action).toEqual({ label: '查看更新', page: 'updates' })
  })

  it('offers no destination for checks whose page would not help', () => {
    expect(startupCheckFailure('appearance', '系统外观没有同步').action).toBeUndefined()
    expect(startupCheckFailure('diagnostics', '启动环境检查没有完成').action).toBeUndefined()
  })

  it('stays silent when the environment check found nothing to handle', () => {
    expect(startupDiagnosticsIssues(0)).toBeNull()
    expect(startupDiagnosticsIssues(-1)).toBeNull()
    expect(startupDiagnosticsIssues(Number.NaN)).toBeNull()
  })

  it('reports environment findings as a result rather than a failure', () => {
    const notice = startupDiagnosticsIssues(3)
    expect(notice?.title).toBe('环境检查发现 3 项需要处理')
    expect(notice?.failure).toBe(false)
    expect(notice?.action).toEqual({ label: '去看看', page: 'health' })
  })

  it('replaces an earlier notice from the same check instead of stacking repeats', () => {
    const first = withStartupNotice([], startupCheckFailure('update', '第一次'))
    const second = withStartupNotice(first, startupCheckFailure('update', '第二次'))
    expect(second).toHaveLength(1)
    expect(second[0]?.body).toBe('第二次')
  })

  it('keeps notices from different checks side by side, newest last', () => {
    const notices = withStartupNotice(withStartupNotice([], startupCheckFailure('update', 'A')), startupCheckFailure('appearance', 'B'))
    expect(notices.map((notice) => notice.id)).toEqual(['update', 'appearance'])
    expect(withoutStartupNotice(notices, 'update').map((notice) => notice.id)).toEqual(['appearance'])
    expect(withoutStartupNotice(notices, 'diagnostics')).toHaveLength(2)
  })

  it('names the check in the runtime log context', () => {
    expect(startupCheckLogContext('diagnostics')).toBe('renderer-v2 startup check: diagnostics')
  })
})
