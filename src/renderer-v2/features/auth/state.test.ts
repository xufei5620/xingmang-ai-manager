import { describe, expect, it } from 'vitest'
import { authErrorMessage, parseInviteCode, parseRecoveryCode, remainingCooldown, validateRegistration, type RegistrationDraft } from './state'
import { resolveGuideReadiness } from './StartGuide'

describe('v2 auth recovery boundaries', () => {
  it('extracts only a single nonblank HTTP reset token without opening the link', () => {
    expect(parseRecoveryCode(' https://example.test/reset?email=a%40example.test&token=abc%2B123 ')).toEqual({ ok: true, token: 'abc+123', source: 'link' })
    expect(parseRecoveryCode('opaque-reset-code')).toEqual({ ok: true, token: 'opaque-reset-code', source: 'code' })
    for (const value of ['', 'abc def', 'abc\ndef', 'javascript:alert(1)', 'file:///token', 'https://example.test/reset', 'https://example.test/?token=', 'https://example.test/?token=one&token=two', 'https://example.test/?token=%20']) expect(parseRecoveryCode(value).ok).toBe(false)
  })
  it('does not expire a cooldown early after a delayed render', () => {
    expect(remainingCooldown(60_000, 0)).toBe(60)
    expect(remainingCooldown(60_000, 1001)).toBe(59)
    expect(remainingCooldown(60_000, 59_999)).toBe(1)
    expect(remainingCooldown(60_000, 80_000)).toBe(0)
  })
  it('honors the actual verification capability while preserving independent username and email', () => {
    const draft: RegistrationDraft = { username: 'test-user', email: 'a@example.test', password: 'long-password', confirm: 'long-password', code: '', invite: '', agreed: true }
    expect(validateRegistration(draft, false)).toEqual({})
    expect(validateRegistration(draft, true).code).toBeTruthy()
    expect(validateRegistration({ ...draft, confirm: 'different', agreed: false }, false)).toEqual({ confirm: '两次密码不一致', agreed: '请先同意用户协议和隐私政策' })
    expect(validateRegistration({ ...draft, username: '', email: '' }, false)).toHaveProperty('username')
    expect(validateRegistration({ ...draft, username: '', email: '' }, false)).toHaveProperty('email')
    expect(validateRegistration({ ...draft, password: 'a'.repeat(21), confirm: 'a'.repeat(21) }, false)).toEqual({ password: '密码不能超过 20 位' })
  })
  it('accepts common and custom-domain mailboxes instead of restricting registration to QQ', () => {
    for (const email of ['person@qq.com', 'person@163.com', 'person@gmail.com', 'person@mail.example.org']) {
      expect(validateRegistration({
        username: 'test-user',
        email,
        password: 'long-password',
        confirm: 'long-password',
        code: '',
        invite: '',
        agreed: true,
      }, false)).toEqual({})
    }
    expect(validateRegistration({
      username: 'test-user',
      email: 'person@localhost',
      password: 'long-password',
      confirm: 'long-password',
      code: '',
      invite: '',
      agreed: true,
    }, false)).toHaveProperty('email')
  })
  it('extracts an invitation code and rejects invitation links without one', () => {
    expect(parseInviteCode('https://example.test/register?aff=abc%2B1')).toBe('abc+1')
    expect(parseInviteCode('native-code')).toBe('native-code')
    expect(parseInviteCode('https://example.test/no-invitation')).toBe('')
  })
  it('does not expose raw server error text to the interface', () => {
    expect(authErrorMessage(new Error('GET https://example.test 500 internal stack trace'), '登录')).toBe('登录没有成功，输入已保留，请稍后重试')
    expect(authErrorMessage(new Error('ETIMEDOUT'), '登录')).toContain('网络')
  })
})

describe('v2 onboarding readiness', () => {
  it('leaves the initial choice empty and keeps chat independent of local runtimes', () => {
    expect(resolveGuideReadiness(null, undefined, true)).toEqual({ prepared: false, connected: false })
    expect(resolveGuideReadiness('chat', undefined, false)).toEqual({ prepared: true, connected: false })
    expect(resolveGuideReadiness('chat', undefined, true)).toEqual({ prepared: true, connected: true })
  })
  it('does not require Node for the desktop route and preserves official connections', () => {
    expect(resolveGuideReadiness('codexDesktop', { id: 'codexDesktop', installed: true, configured: false, source: 'official', runtimeReady: false }, false)).toEqual({ prepared: true, connected: true })
  })
  it('requires confirmed runtime capability and does not overwrite unknown connections', () => {
    expect(resolveGuideReadiness('claude', { id: 'claude', installed: true, configured: true, source: 'account' }, true).prepared).toBe(false)
    expect(resolveGuideReadiness('claude', { id: 'claude', installed: true, configured: true, source: 'unknown', runtimeReady: true }, true).connected).toBe(false)
    expect(resolveGuideReadiness('codexDesktop', { id: 'codexDesktop', installed: true, configured: true, source: 'account', supported: false }, true).prepared).toBe(false)
  })
  it('requires Node, Python and the installed CLI for the Gemini route', () => {
    const tool = { id: 'gemini' as const, installed: true, configured: true, source: 'account' as const, runtimeReady: true, pythonReady: false }
    expect(resolveGuideReadiness('gemini', tool, true).prepared).toBe(false)
    expect(resolveGuideReadiness('gemini', { ...tool, pythonReady: true }, true).prepared).toBe(true)
    expect(resolveGuideReadiness('gemini', { ...tool, pythonReady: true, runtimeReady: false }, true).prepared).toBe(false)
    expect(resolveGuideReadiness('gemini', { ...tool, pythonReady: true, installed: false }, true).prepared).toBe(false)
  })
})
