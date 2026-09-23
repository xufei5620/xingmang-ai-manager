import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MaintenanceNotice, maintenanceNoticeBody, maintenanceNoticeKey } from './MaintenanceNotice'
import { StartupNotices } from './StartupNotices'

describe('MaintenanceNotice', () => {
  it('always tells the user there is nothing to fix on their side', () => {
    expect(maintenanceNoticeBody({ message: '服务升级中，预计 22:00 恢复。' }))
      .toBe('服务升级中，预计 22:00 恢复。 这不是你这边的问题，不用重新登录，也不用改任何设置，维护结束后会自动恢复。')
    expect(maintenanceNoticeBody({ message: null })).toContain('维护期间登录、余额和工具连接可能会失败。')
    expect(maintenanceNoticeBody({ message: null })).toContain('不用重新登录')
  })

  it('keys a dismissal to the wording, so a new message shows again', () => {
    expect(maintenanceNoticeKey(null)).toBeNull()
    expect(maintenanceNoticeKey({ message: 'a' })).not.toBe(maintenanceNoticeKey({ message: 'b' }))
    expect(maintenanceNoticeKey({ message: null })).toBe(maintenanceNoticeKey({ message: null }))
  })

  it('renders as a non-modal status notice in the startup corner', () => {
    const markup = renderToStaticMarkup(<StartupNotices notices={[]} onDismiss={() => undefined} onOpen={() => undefined}
      leading={<MaintenanceNotice maintenance={{ message: '升级中' }} onDismiss={() => undefined} />} />)
    expect(markup).toContain('data-testid="startup-notices"')
    expect(markup).toContain('data-testid="service-maintenance-notice"')
    expect(markup).toContain('服务正在维护')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-label="关闭"')
    expect(markup).not.toContain('aria-modal')
  })

  it('omits the close button where the notice cannot be dismissed', () => {
    const markup = renderToStaticMarkup(<MaintenanceNotice maintenance={{ message: null }} testId="auth-maintenance-notice" />)
    expect(markup).toContain('data-testid="auth-maintenance-notice"')
    expect(markup).not.toContain('aria-label="关闭"')
  })
})
