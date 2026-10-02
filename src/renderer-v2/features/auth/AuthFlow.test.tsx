import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuthFlow } from './AuthFlow'
import { createAuthApi, type AuthBridge } from './api'
import { sessionOnlyLoginNotice } from '../app/remembered-login'

// renderToStaticMarkup 不跑 effect，桥上的方法一个都不会被调到。
const api = createAuthApi({} as unknown as AuthBridge)

function render(sessionOnly?: boolean): string {
  return renderToStaticMarkup(<AuthFlow api={api} sessionOnly={sessionOnly} onAuthenticated={() => undefined} onClose={() => undefined} />)
}

describe('renderer-v2 login form remember-password', () => {
  it('offers remember-password where the login can be kept', () => {
    const markup = render()
    expect(markup).toContain('data-testid="login-remember"')
    expect(markup).not.toContain('login-session-only')
  })

  it('says the login is only kept for this run instead of offering a checkbox that cannot save', () => {
    const markup = render(true)
    expect(markup).not.toContain('login-remember')
    expect(markup).toContain('data-testid="login-session-only"')
    expect(markup).toContain(sessionOnlyLoginNotice)
    expect(sessionOnlyLoginNotice).not.toMatch(/密钥环|凭据服务|钥匙串|safeStorage|keyring/i)
  })
})
