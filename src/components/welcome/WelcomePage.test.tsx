import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WelcomePage } from './WelcomePage'

describe('WelcomePage', () => {
  it('sends beginners to register or login, not an authorization code', () => {
    const markup = renderToStaticMarkup(
      <WelcomePage
        theme="dark"
        onRegister={vi.fn()}
        onLogin={vi.fn()}
        onOpenSupport={vi.fn()}
      />,
    )

    expect(markup).toContain('免费注册')
    expect(markup).toContain('登录')
    expect(markup).toContain('扫码加客服')
    expect(markup).toContain('装好就能用的')
    expect(markup).not.toContain('onboarding-api-key')
    expect(markup).not.toContain('welcome-cta-ghost')
    expect(markup).not.toContain('已有账号？登录')
    expect(markup).not.toContain('TODO')
    expect(markup).not.toContain('星芒账号')
    expect(markup).not.toContain('一把账号四家工具')
  })
})
