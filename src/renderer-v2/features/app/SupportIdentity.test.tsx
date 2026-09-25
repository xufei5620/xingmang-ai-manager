import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SupportIdentity, buildSupportIdentityLine } from './SupportIdentity'

describe('SupportIdentity', () => {
  it('lists account name, id, version and system for a signed-in user', () => {
    expect(buildSupportIdentityLine({ signedIn: true, account: { userId: 10086, username: '张三' }, version: '0.2.10', os: 'win' }))
      .toBe('账号 张三（ID 10086） · 星芒AI管理工具 0.2.10 · Windows')
    expect(buildSupportIdentityLine({ signedIn: true, account: { userId: 7, username: 'peaker' }, version: '0.2.11', os: 'mac' }))
      .toBe('账号 peaker（ID 7） · 星芒AI管理工具 0.2.11 · macOS')
  })

  it('says not signed in when there is no account', () => {
    expect(buildSupportIdentityLine({ signedIn: false, account: null, version: '0.2.10', os: 'win' }))
      .toBe('未登录 · 星芒AI管理工具 0.2.10 · Windows')
    expect(buildSupportIdentityLine({ signedIn: false, account: { userId: 1, username: 'stale' }, version: '0.2.10', os: 'mac' }))
      .toBe('未登录 · 星芒AI管理工具 0.2.10 · macOS')
  })

  it('omits the id instead of inventing one when the account has no usable numeric id', () => {
    for (const userId of [0, Number.NaN, -3, 1.5]) {
      expect(buildSupportIdentityLine({ signedIn: true, account: { userId, username: 'legacy' }, version: '0.2.10', os: 'win' }))
        .toBe('账号 legacy · 星芒AI管理工具 0.2.10 · Windows')
    }
  })

  it('drops the version when it is not known yet', () => {
    expect(buildSupportIdentityLine({ signedIn: false, account: null, version: undefined, os: 'win' })).toBe('未登录 · 星芒AI管理工具 · Windows')
  })

  it('never includes an email or site name', () => {
    const line = buildSupportIdentityLine({ signedIn: true, account: { userId: 5, username: 'a' }, version: '1.0.0', os: 'win' })
    expect(line).not.toMatch(/@|solov|xm\./)
  })

  it('renders the line with a copy button', () => {
    const markup = renderToStaticMarkup(<SupportIdentity line="未登录 · 星芒AI管理工具 0.2.10 · Windows" onCopy={() => undefined} />)
    expect(markup).toContain('找客服时把这行一起发过去：')
    expect(markup).toContain('data-testid="support-identity-line"')
    expect(markup).toContain('未登录 · 星芒AI管理工具 0.2.10 · Windows')
    expect(markup).toContain('复制')
  })
})
