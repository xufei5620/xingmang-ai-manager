import { describe, expect, it } from 'vitest'
import { startupCheckFailure, startupCheckLogContext, releaseNoteHeadline, startupDiagnosticsIssues, updatedNotice, vaultRecoveredNotice, withStartupNotice, withoutStartupNotice } from './startup-notice'

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

  it('explains a rebuilt account store as a fact with a way back in, not as a failed check', () => {
    const notice = vaultRecoveredNotice()
    expect(notice.id).toBe('vault-recovered')
    // 主进程已经把这件事记进运行日志了，界面再报一条错误日志只是重复。
    expect(notice.failure).toBe(false)
    expect(notice.title).toBe('本机保存的登录信息已重置，请重新登录')
    expect(notice.action).toEqual({ label: '去登录', login: true })
  })

  it('keeps the rebuilt-store wording free of site names, file names and blame', () => {
    const notice = vaultRecoveredNotice()
    const text = `${notice.title}${notice.body}`
    expect(text).not.toMatch(/solov|Sub2API|new-api/i)
    expect(text).not.toMatch(/\.dat|\.bak|realm-accounts/)
    expect(text).not.toMatch(/篡改|损坏|攻击/)
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

  it('announces the first launch after an update with its first changes and only an acknowledgement', () => {
    // yoyo 定的原则：用户是小白，这张卡片不让人做选择，只有一颗「知道了」。
    const notice = updatedNotice('0.2.9', { justUpdated: true, previousVersion: '0.2.8', notes: ['第一件事：细节', '第二件事。更多', '第三件事', '第四件事'] })
    expect(notice).toEqual({
      id: 'updated',
      failure: false,
      tone: 'ok',
      title: '已更新到 0.2.9',
      body: '这一版的主要改动如下，另外 1 项在「更新」页可以看到。',
      items: ['第一件事', '第二件事', '第三件事'],
      action: { label: '知道了', dismiss: true },
    })
    expect(updatedNotice('0.2.9', { justUpdated: true, previousVersion: '0.2.8', notes: ['唯一一件'] })?.body).toBe('这一版的改动：')
  })

  it('still confirms the update when the build carried no notes', () => {
    const notice = updatedNotice('0.2.9', { justUpdated: true, previousVersion: null, notes: null })
    expect(notice?.title).toBe('已更新到 0.2.9')
    expect(notice?.body).toBe('已经在用新版本了，可以照常使用。')
    expect(notice?.items).toBeUndefined()
    expect(notice?.action).toEqual({ label: '知道了', dismiss: true })
  })

  it('keeps only the leading clause of a change and trims it to fit the corner card', () => {
    expect(releaseNoteHeadline('修复开着本机加速时安装 CLI 却下载不动：安装用的下载以前从不经过加速线路')).toBe('修复开着本机加速时安装 CLI 却下载不动')
    expect(releaseNoteHeadline('没有标点的一句话')).toBe('没有标点的一句话')
    const long = releaseNoteHeadline('长'.repeat(80))
    expect(long).toHaveLength(36)
    expect(long.endsWith('…')).toBe(true)
  })

  it('says nothing on an ordinary launch or with an old snapshot', () => {
    expect(updatedNotice('0.2.9', { justUpdated: false, previousVersion: '0.2.9', notes: ['一条'] })).toBeNull()
    expect(updatedNotice('0.2.9', null)).toBeNull()
    expect(updatedNotice('0.2.9', undefined)).toBeNull()
  })
})
