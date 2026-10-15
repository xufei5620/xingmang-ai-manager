import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuthFlow, type AuthFlowProps } from './AuthFlow'
import { createAuthApi, type AuthBridge } from './api'
import { sessionOnlyLoginNotice } from '../app/remembered-login'

// renderToStaticMarkup 不跑 effect，桥上的方法一个都不会被调到。
const api = createAuthApi({} as unknown as AuthBridge)

function render(sessionOnly?: boolean, overrides: Partial<AuthFlowProps> = {}): string {
  return renderToStaticMarkup(<AuthFlow api={api} sessionOnly={sessionOnly} onAuthenticated={() => undefined} onClose={() => undefined} {...overrides} />)
}

/** 某个 data-testid 所在的那个标签（开头那一段），用来看它挂在哪颗按钮上、带不带 disabled。 */
function tagOf(markup: string, testId: string): string {
  return markup.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? ''
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

describe('renderer-v2 account dialogs in the v4 layout', () => {
  it('lays out the login like v4: no subtitle, the close button carries cancel, forgot sits beside remember', () => {
    const markup = render(false, { connectionSettings: () => null })
    expect(markup).toContain('<h2 id="_R_0_">登录星芒账号</h2>')
    expect(markup).not.toContain('xm-dialog-sub')
    expect(tagOf(markup, 'login-cancel')).toContain('data-modal-close="true"')
    expect(markup).toMatch(/class="auth-remember-row">.*data-testid="login-remember".*data-testid="login-forgot"[^>]*>找回密码</)
    expect(markup).toContain('placeholder="注册时填的用户名或邮箱"')
    expect(markup).toMatch(/我已阅读并同意<\/label><button[^>]*data-testid="auth-terms"[^>]*>《用户协议》<\/button>和<button[^>]*data-testid="auth-privacy"[^>]*>《隐私政策》</)
    expect(markup).toMatch(/class="auth-foot"><button[^>]*data-testid="login-submit"[^>]*><span>登录<\/span><\/button><div class="auth-alt">/)
    expect(markup).toMatch(/还没有账号？<button[^>]*data-testid="login-register"[^>]*>注册新账号</)
    expect(markup).toContain('data-testid="auth-source-expand"')
    expect(markup).toContain('data-testid="auth-connection-settings"')
  })

  it('offers no sign-up from a history account, which cannot register', () => {
    const markup = render(false, { initialSiteId: 'solov-api' })
    expect(markup).toContain('登录历史账号')
    expect(markup).toContain('data-testid="auth-source"')
    expect(markup).not.toContain('login-register')
    expect(markup).not.toContain('auth-source-expand')
  })

  it('names the sign-up after what it does and points the waiting button at its new name', () => {
    const markup = render(false, { initialMode: 'register' })
    expect(markup).toContain('注册星芒账号')
    expect(tagOf(markup, 'register-cancel')).toContain('data-modal-close="true"')
    expect(markup).toMatch(/data-testid="register-submit"[^>]*>.*注册并登录</)
    expect(markup).toContain('准备好之后就能点「注册并登录」。')
    expect(markup).toContain('placeholder="最多 20 位"')
    expect(markup).toContain('placeholder="再输一次"')
    expect(markup).toMatch(/已经有账号？<button[^>]*data-testid="register-login"[^>]*>去登录</)
  })

  it('starts password recovery with a bar stepper and a way back to login', () => {
    const markup = render(false, { initialMode: 'recovery' })
    expect(markup).toContain('找回星芒账号密码')
    expect(markup).toMatch(/<ol class="auth-stepper"[^>]*><li aria-current="step"[^>]*><i aria-hidden="true"><\/i><span>获取邮件<\/span>/)
    expect(markup).toContain('填写注册时用的邮箱，我们会发一封带重置码的邮件。')
    expect(markup).toMatch(/data-testid="forgot-send"[^>]*>.*发送重置邮件</)
    expect(markup).toMatch(/想起来了？<button[^>]*data-testid="forgot-back-login"[^>]*>回去登录</)
    expect(markup).toContain('找回历史账号的密码')
  })

  it('sends a history account to its website with the shorter wording', () => {
    const markup = render(false, { initialMode: 'recovery', initialSiteId: 'solov-api' })
    expect(markup).toContain('官网没有找回入口的话，请联系官网客服恢复访问。')
    expect(markup).toContain('data-testid="forgot-open-website"')
    expect(markup).toContain('data-testid="forgot-back-login"')
  })
})
