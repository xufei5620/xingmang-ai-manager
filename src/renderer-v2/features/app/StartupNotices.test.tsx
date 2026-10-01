import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { orderStartupNotices, StartupNotices } from './StartupNotices'
import { crashReportingNotice, displayCompatNotice, startupCheckFailure, startupDiagnosticsIssues, toolTemplateFilledNotice, unexpectedExitNotice, updatedNotice, vaultRecoveredNotice } from './startup-notice'

function render(notices: Parameters<typeof StartupNotices>[0]['notices']) {
  return renderToStaticMarkup(<StartupNotices notices={notices} onDismiss={() => undefined} onOpen={() => undefined} />)
}

describe('StartupNotices', () => {
  it('renders nothing when every startup check went through', () => {
    expect(render([])).toBe('')
  })

  it('renders a dismissible, non-modal notice instead of a dialog', () => {
    const markup = render([startupCheckFailure('update', '本地更新源暂时不可用')])
    expect(markup).toContain('startup-notice-update')
    expect(markup).toContain('本地更新源暂时不可用')
    expect(markup).toContain('查看更新')
    expect(markup).toContain('aria-label="关闭"')
    expect(markup).not.toContain('aria-modal')
    expect(markup).not.toContain('<dialog')
  })

  it('offers copying for support after an unexpected exit, with no extra close button', () => {
    const notice = unexpectedExitNotice({ unexpectedExit: { relaunched: true, exits: [{ at: Date.UTC(2026, 8, 30), error: 'Error: boom' }] } })
    if (!notice) throw new Error('expected a notice')
    const markup = render([notice])
    expect(markup).toContain('startup-notice-unexpected-exit-primary')
    expect(markup).toContain('复制给客服')
    expect(markup).toContain('知道了')
    expect(markup).not.toContain('aria-label="关闭"')
    // The raw error stays in the copied text; the card only speaks plain words.
    expect(markup).not.toContain('Error: boom')
  })

  it('omits the action button for a check with no useful destination', () => {
    expect(render([startupCheckFailure('appearance', '系统外观没有同步')])).not.toContain('xm-notice-actions')
  })

  it('offers a way straight back to signing in when the account store was rebuilt', () => {
    const markup = render([vaultRecoveredNotice()])
    expect(markup).toContain('startup-notice-vault-recovered')
    expect(markup).toContain('本机保存的登录信息已重置，请重新登录')
    expect(markup).toContain('去登录')
    expect(markup).toContain('aria-label="关闭"')
    expect(markup).not.toContain('aria-modal')
  })

  it('stacks one notice per check', () => {
    const issues = startupDiagnosticsIssues({ warn: 0, fail: 2, error: 0 })
    expect(issues).not.toBeNull()
    const markup = render([startupCheckFailure('update', 'A'), issues!])
    expect(markup).toContain('startup-notice-update')
    expect(markup).toContain('startup-notice-diagnostics')
    expect(markup).toContain('环境检查发现 2 项需要处理')
  })

  it('shows the first changes after an update as a light card with a single acknowledgement', () => {
    const markup = render([updatedNotice('0.2.9', { justUpdated: true, previousVersion: '0.2.8', notes: ['第一件事：细节', '第二件事。'] })!])
    expect(markup).toContain('startup-notice-updated')
    expect(markup).toContain('已更新到 0.2.9')
    expect(markup).toContain('<li>第一件事</li><li>第二件事</li>')
    expect(markup).toContain('知道了')
    expect(markup.match(/<button/g)).toHaveLength(1)
    expect(markup).not.toContain('aria-label="关闭"')
    expect(markup).not.toContain('aria-modal')
  })

  it('shows both choices without a close button when the user has to pick one', () => {
    const notice = displayCompatNotice({ displayCompat: 'auto' })
    expect(notice).not.toBeNull()
    const markup = render(notice ? [notice] : [])
    expect(markup).toContain('startup-notice-display-compat-primary')
    expect(markup).toContain('startup-notice-display-compat-secondary')
    expect(markup).toContain('一直用兼容方式')
    expect(markup).toContain('恢复原来的方式')
    expect(markup).not.toContain('aria-label="关闭"')
  })

  it('shows at most two cards and folds the rest into one line', () => {
    const markup = render([
      updatedNotice('0.2.12', { justUpdated: true, previousVersion: '0.2.11', notes: ['第一件事'] })!,
      toolTemplateFilledNotice(['codex'])!,
      startupDiagnosticsIssues({ warn: 0, fail: 1, error: 0 })!,
      displayCompatNotice({ displayCompat: 'auto' })!,
    ])
    expect(markup).toContain('startup-notice-display-compat')
    expect(markup).toContain('startup-notice-diagnostics')
    expect(markup).not.toContain('startup-notice-updated')
    expect(markup).not.toContain('startup-notice-template-filled')
    expect(markup).toContain('还有 2 条提示')
    expect(markup).toContain('aria-expanded="false"')
  })

  it('counts the maintenance notice against the two visible cards', () => {
    const markup = renderToStaticMarkup(<StartupNotices notices={[startupCheckFailure('update', 'A'), vaultRecoveredNotice()]}
      leading={<div data-testid="maintenance" />} onDismiss={() => undefined} onOpen={() => undefined} />)
    expect(markup).toContain('data-testid="maintenance"')
    expect(markup).toContain('startup-notice-vault-recovered')
    expect(markup).not.toContain('startup-notice-update"')
    expect(markup).toContain('还有 1 条提示')
  })

  it('has no fold line when everything fits', () => {
    const markup = render([startupCheckFailure('update', 'A'), vaultRecoveredNotice()])
    expect(markup).not.toContain('startup-notices-toggle')
  })

  it('puts choices first, then trouble, then things to look at, then plain news, keeping arrival order within a group', () => {
    const crash = crashReportingNotice({ crashReporting: true, crashReportingNoticeShown: false }, true)!
    const ordered = orderStartupNotices([
      updatedNotice('0.2.12', { justUpdated: true, previousVersion: '0.2.11', notes: [] })!,
      startupCheckFailure('update', 'A'),
      startupDiagnosticsIssues({ warn: 0, fail: 1, error: 0 })!,
      vaultRecoveredNotice(),
      crash,
      displayCompatNotice({ displayCompat: 'auto' })!,
    ])
    expect(ordered.map((notice) => notice.id)).toEqual(['crash-reporting', 'display-compat', 'vault-recovered', 'update', 'diagnostics', 'updated'])
  })
})
