import { describe, expect, it } from 'vitest'
import { networkFailureMessages } from '../../../../electron/network-failure'
import { authErrorMessage, parseInviteCode, parseRecoveryCode, remainingCooldown, usernameFromEmail, validateRegistration, type RegistrationDraft } from './state'
import { guideOfficialLoginRequired, resolveGuideReadiness } from './StartGuide'

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
  it('does not accept another account source in a recovery link', () => {
    expect(parseRecoveryCode('https://xm.solov.cc/reset?token=valid', 'https://xm.solov.cc')).toMatchObject({ ok: true, token: 'valid' })
    for (const url of ['https://api.solov.cc/reset?token=valid', 'http://xm.solov.cc/reset?token=valid', 'https://xm.solov.cc.evil.test/reset?token=valid']) {
      expect(parseRecoveryCode(url, 'https://xm.solov.cc')).toEqual({ ok: false, error: '重置链接不属于所选账号来源，请使用该账号的重置邮件' })
    }
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
  it('accepts every username the account server accepts and only caps its length', () => {
    const draft: RegistrationDraft = { username: 'ab', email: 'a@example.test', password: 'long-password', confirm: 'long-password', code: '', invite: '', agreed: true }
    expect(validateRegistration(draft, false)).toEqual({})
    expect(validateRegistration({ ...draft, username: 'a' }, false)).toEqual({})
    expect(validateRegistration({ ...draft, username: 'a'.repeat(20) }, false)).toEqual({})
    expect(validateRegistration({ ...draft, username: 'a'.repeat(21) }, false)).toEqual({ username: '用户名不能超过 20 位' })
    expect(validateRegistration({ ...draft, username: '   ' }, false)).toEqual({ username: '请填写用户名' })
  })
  it('derives a username the account server accepts from the mailbox name', () => {
    expect(usernameFromEmail('12345678@qq.com')).toBe('12345678')
    expect(usernameFromEmail('  Person.Name+tag@example.test ')).toBe('Person.Name+tag')
    expect(usernameFromEmail('still-typing')).toBe('still-typing')
    expect(usernameFromEmail('')).toBe('')
    expect(usernameFromEmail('@example.test')).toBe('')
    expect(usernameFromEmail(`${'a'.repeat(30)}@example.test`)).toBe('a'.repeat(20))
    // Cut by character, not UTF-16 unit, so an emoji is never split in half.
    const derived = usernameFromEmail(`${'a'.repeat(19)}😀😀@example.test`)
    expect(derived).toBe(`${'a'.repeat(19)}😀`)
    const draft: RegistrationDraft = { username: derived, email: 'a@example.test', password: 'long-password', confirm: 'long-password', code: '', invite: '', agreed: true }
    expect(validateRegistration(draft, false)).toEqual({})
  })
  it('tells an empty confirmation apart from a mismatched one', () => {
    const draft: RegistrationDraft = { username: 'test-user', email: 'a@example.test', password: 'long-password', confirm: '', code: '', invite: '', agreed: true }
    expect(validateRegistration(draft, false)).toEqual({ confirm: '请再次输入密码' })
    expect(validateRegistration({ ...draft, confirm: 'other-password' }, false)).toEqual({ confirm: '两次密码不一致' })
  })
  it('reads an invitation code out of a poster link that carries no scheme', () => {
    expect(parseInviteCode('example.test/sign-up?aff=6B4j')).toBe('6B4j')
    expect(parseInviteCode('aff=6B4j')).toBe('6B4j')
    expect(parseInviteCode('example.test/sign-up')).toBe('')
    const draft: RegistrationDraft = { username: 'test-user', email: 'a@example.test', password: 'long-password', confirm: 'long-password', code: '', invite: 'example.test/sign-up?aff=6B4j', agreed: true }
    expect(validateRegistration(draft, false)).toEqual({})
    expect(validateRegistration({ ...draft, invite: 'example.test/sign-up' }, false)).toEqual({ invite: '邀请链接中没有邀请码，请检查后重试' })
    expect(validateRegistration({ ...draft, invite: 'a'.repeat(33) }, false)).toEqual({ invite: '邀请码不能超过 32 位' })
    expect(validateRegistration({ ...draft, invite: 'a'.repeat(32) }, false)).toEqual({})
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
    expect(authErrorMessage(new Error('TWO_FACTOR_REQUIRED'), '登录')).toContain('双重验证')
    expect(authErrorMessage(new Error('此账号需要双重验证，请先完成验证'), '登录')).toContain('所选账号官网')
  })
  // 校园网那位用户看到的就是这句兜底文案：真实原因是域名解析不了 / 证书被替换 /
  // 门户认证没做，界面却只说「请稍后重试」，于是他一遍遍重输密码。
  it('keeps the reason the main process worked out for a restricted network', () => {
    for (const reason of Object.keys(networkFailureMessages) as (keyof typeof networkFailureMessages)[]) {
      const wrapped = `Error invoking remote method 'account:login': Error: ${networkFailureMessages[reason]}（账号登录请求失败）`
      expect(authErrorMessage(new Error(wrapped), '登录')).toBe(networkFailureMessages[reason])
    }
  })
  it('does not let the broad network heuristics call a replaced certificate a timeout', () => {
    expect(authErrorMessage(new Error(networkFailureMessages.tls), '登录')).toBe(networkFailureMessages.tls)
    expect(authErrorMessage(new Error(networkFailureMessages.intercepted), '登录')).not.toContain('超时')
  })
  it('identifies local account storage failures without exposing details or blaming the password', () => {
    const expected = '本地账号安全存储暂不可用，原有数据已保留。请完全退出软件后重试；若仍失败，请联系支持并提供诊断日志。'
    expect(authErrorMessage(new Error('账号安全存储不可用，原记录未修改'), '登录')).toBe(expected)
    expect(authErrorMessage('本地账号存储恢复失败：password credential diagnostic detail', '登录')).toBe(expected)
    expect(authErrorMessage(new Error('账号或密码不正确'), '登录')).toBe('账号或密码不正确，请检查后重试')
  })
  it('keeps the reason the server gave instead of asking the user to try again later', () => {
    expect(authErrorMessage(new Error('User has been banned'), '登录')).toBe('该账号已被封禁，请联系客服')
    expect(authErrorMessage(new Error('New user registration has been disabled by administrator'), '注册')).toBe('当前暂未开放注册，请联系客服')
    expect(authErrorMessage(new Error('Password login has been disabled by administrator'), '登录')).toBe('当前暂不支持密码登录，请联系客服')
    expect(authErrorMessage(new Error('Database error, please contact the administrator'), '登录')).toBe('服务暂时不可用，请稍后重试')
    expect(authErrorMessage(new Error('Username already exists'), '注册')).toBe('该用户名已被注册，请更换用户名，或点击“已有账号，登录”')
    expect(authErrorMessage(new Error('Email address is already in use'), '注册')).toBe('该邮箱已被注册，请直接登录，或更换邮箱后重试')
  })
  it('does not send an account that never had a password back to the password field', () => {
    expect(authErrorMessage(new Error('This account has no password set. Please use password reset or contact an administrator to reset it.'), '修改密码')).toBe('当前账号未设置密码，请先通过“找回密码”设置密码')
    expect(authErrorMessage(new Error('Original password is incorrect'), '修改密码')).toBe('原密码错误，请重新输入')
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
  it('does not call an official Codex connected before ChatGPT has been signed in', () => {
    const codex = { id: 'codex' as const, installed: true, configured: true, source: 'official' as const, runtimeReady: true }
    expect(resolveGuideReadiness('codex', { ...codex, officialLoginRequired: true }, true).connected).toBe(false)
    expect(resolveGuideReadiness('codex', codex, true).connected).toBe(true)
    const desktop = { id: 'codexDesktop' as const, installed: true, configured: true, source: 'official' as const }
    expect(resolveGuideReadiness('codexDesktop', { ...desktop, officialLoginRequired: true }, true)).toEqual({ prepared: true, connected: false })
    expect(resolveGuideReadiness('codexDesktop', desktop, true)).toEqual({ prepared: true, connected: true })
  })
  it('only reads an official login state out of a config that actually records one', () => {
    expect(guideOfficialLoginRequired('codex', 'official', { codexAuthMode: null })).toBe(true)
    expect(guideOfficialLoginRequired('codex', 'official', { codexAuthMode: 'apikey' })).toBe(true)
    expect(guideOfficialLoginRequired('codex', 'official', undefined)).toBe(true)
    expect(guideOfficialLoginRequired('codex', 'official', { codexAuthMode: 'chatgpt' })).toBe(false)
    expect(guideOfficialLoginRequired('codex', 'account', { codexAuthMode: null })).toBe(false)
    for (const provider of ['claude', 'gemini', 'grok'] as const) expect(guideOfficialLoginRequired(provider, 'official', { codexAuthMode: null })).toBe(false)
  })
  it('requires Node, Python and the installed CLI for the Gemini route', () => {
    const tool = { id: 'gemini' as const, installed: true, configured: true, source: 'account' as const, runtimeReady: true, pythonReady: false }
    expect(resolveGuideReadiness('gemini', tool, true).prepared).toBe(false)
    expect(resolveGuideReadiness('gemini', { ...tool, pythonReady: true }, true).prepared).toBe(true)
    expect(resolveGuideReadiness('gemini', { ...tool, pythonReady: true, runtimeReady: false }, true).prepared).toBe(false)
    expect(resolveGuideReadiness('gemini', { ...tool, pythonReady: true, installed: false }, true).prepared).toBe(false)
  })
})
