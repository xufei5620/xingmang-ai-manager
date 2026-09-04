import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AccountArea } from './AccountArea'
import type { AccountSnapshot } from './account-stub'

const snapshot: AccountSnapshot = {
  loggedIn: true,
  nickname: '星芒用户',
  quota: 123_456_789_000,
  quotaPerUnit: 500_000,
  usdExchangeRate: 7.3,
}

const sharedProps = {
  status: 'active' as const,
  snapshot,
  onLogin: vi.fn(),
  onLogout: vi.fn(),
  onRecharge: vi.fn(),
  onConfigureCliKey: vi.fn(),
  onRefreshBalance: vi.fn(),
  onOpenAccountCenter: vi.fn(),
}

describe('AccountArea', () => {
  it('keeps the complete balance available while allowing the narrow value to ellipsize', () => {
    const markup = renderToStaticMarkup(<AccountArea {...sharedProps} />)

    expect(markup).toContain('data-full-balance="$246913.58"')
    expect(markup).toContain('title="完整余额：$246913.58"')
    expect(markup).toContain('aria-label="完整余额：$246913.58"')
    expect(markup).toContain('text-overflow:ellipsis')
  })

  it('does not expose a legacy credential path for signed-out users', () => {
    const markup = renderToStaticMarkup(<AccountArea {...sharedProps} status="guest" />)

    expect(markup).toContain('登录')
    expect(markup).not.toContain('粘贴 Key')
    expect(markup).not.toContain('去获取 Key')
  })
})
