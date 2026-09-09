import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Copy, Eye, EyeOff, KeyRound, LogIn, Mail, RefreshCw, UserPlus } from 'lucide-react'
import type { AccountLoginResult, AccountStatus, LegalDocumentKind } from '../../../../electron/ipc-contract'
import { Button, Dialog, Input } from '../../ui'
import { getAuthApi, type AuthApi } from './api'
import { LegalDocument } from './LegalDocument'
import { authErrorMessage, isEmail, parseInviteCode, parseRecoveryCode, validateRegistration, type RegistrationDraft, type RegistrationErrors } from './state'
import { useCooldown } from './useCooldown'
import './auth.css'

export type AuthMode = 'login' | 'register' | 'recovery'
export interface AuthFlowProps {
  api?: AuthApi
  initialMode?: AuthMode
  initialIdentifier?: string
  initialInviteCode?: string
  onAuthenticated: (result: AccountLoginResult, options?: { rememberError?: string }) => void
  onClose: () => void
  onHelp?: () => void
}

export function AuthFlow({ api: providedApi, initialMode = 'login', initialIdentifier = '', initialInviteCode = '', onAuthenticated, onClose, onHelp }: AuthFlowProps) {
  const [api] = useState(() => providedApi ?? getAuthApi())
  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [legal, setLegal] = useState<LegalDocumentKind | null>(null)
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [statusRevision, setStatusRevision] = useState(0)
  const [identifier, setIdentifier] = useState(initialIdentifier)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const [registration, setRegistration] = useState<RegistrationDraft>({ email: '', username: '', password: '', confirm: '', code: '', invite: initialInviteCode, agreed: false })
  const [fieldErrors, setFieldErrors] = useState<RegistrationErrors>({})
  const [recoveryStep, setRecoveryStep] = useState<1 | 2 | 3>(1)
  const [recoveryEmail, setRecoveryEmail] = useState(isEmail(initialIdentifier) ? initialIdentifier : '')
  const [recoveryText, setRecoveryText] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [copyFallback, setCopyFallback] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const epoch = useRef(0)
  const loginTouched = useRef(Boolean(initialIdentifier))
  const focusedStep = useRef('')
  const registerCooldown = useCooldown()
  const resetCooldown = useCooldown()
  useEffect(() => () => { epoch.current++; locked.current = false }, [])
  useEffect(() => {
    if (legal) { focusedStep.current = ''; return }
    if (busy) return
    const stepKey = `${mode}:${mode === 'recovery' ? recoveryStep : ''}`
    if (focusedStep.current === stepKey) return
    const id = mode === 'login' ? identifier.trim() ? 'login-password' : 'login-account' : mode === 'register' ? 'register-email' : recoveryStep === 1 ? 'forgot-email' : recoveryStep === 2 ? 'forgot-token' : 'forgot-new-password'
    const frame = window.requestAnimationFrame(() => {
      const input = document.getElementById(id)
      if (input instanceof HTMLInputElement && !input.disabled) { input.focus(); focusedStep.current = stepKey }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [mode, recoveryStep, legal, busy, identifier])
  useEffect(() => {
    let active = true
    setStatusError(''); setStatus(null)
    void api.getStatus().then((value) => { if (active) setStatus(value) }, (reason: unknown) => { if (active) setStatusError(authErrorMessage(reason, '读取账号设置')) })
    return () => { active = false }
  }, [api, statusRevision])
  useEffect(() => {
    let active = true
    void api.getRemembered().then((value) => { if (active && !loginTouched.current && value) { setIdentifier(value.identifier); setPassword(value.password); setRemember(true) } }, () => undefined)
    return () => { active = false }
  }, [api])

  const changeMode = (next: AuthMode, nextIdentifier?: string) => {
    if (locked.current) return
    epoch.current++
    setMode(next); setError(''); setMessage(''); setFieldErrors({}); setNewPassword(''); setReveal(false); setCopyFallback(false)
    if (nextIdentifier !== undefined) { setIdentifier(nextIdentifier); setPassword(''); loginTouched.current = true }
    if (next === 'recovery') { setRecoveryStep(1); if (isEmail(identifier)) setRecoveryEmail(identifier) }
  }
  const close = () => {
    if (locked.current) { setMessage('正在处理，请稍候'); return }
    epoch.current++; setPassword(''); setNewPassword(''); onClose()
  }
  const run = async (action: string, work: (isCurrent: () => boolean) => Promise<void>) => {
    if (locked.current) return
    const owner = epoch.current
    const current = () => epoch.current === owner
    locked.current = true; setBusy(true); setError(''); setMessage('')
    try { await work(current) } catch (reason) { if (current()) setError(authErrorMessage(reason, action)) }
    finally { if (current()) { locked.current = false; setBusy(false) } }
  }
  const submitLogin = () => {
    if (!identifier.trim() || !password) { setError('请输入账号和密码'); return }
    if (!agreed) { setError('请先同意用户协议和隐私政策'); return }
    const login = { username: identifier.trim(), password }
    void run('登录', async (current) => {
      const result = await api.login(login)
      if (!current()) return
      let rememberError: string | undefined
      try { await api.setRemembered(remember ? { identifier: login.username, password: login.password } : null, result.siteId) }
      catch { rememberError = '已登录，但记住密码的设置没有保存成功' }
      if (current()) { setPassword(''); onAuthenticated(result, { rememberError }) }
    })
  }
  const updateRegistration = <K extends keyof RegistrationDraft>(key: K, value: RegistrationDraft[K]) => {
    setRegistration((draft) => ({ ...draft, [key]: value }))
    setFieldErrors((errors) => ({ ...errors, [key]: undefined }))
  }
  const sendVerification = () => {
    if (!isEmail(registration.email)) { setFieldErrors((errors) => ({ ...errors, email: '请填写正确的邮箱' })); return }
    if (registerCooldown.seconds) return
    void run('发送验证码', async (current) => { await api.sendVerification(registration.email.trim()); if (current()) { registerCooldown.start(); setMessage('验证码已发送，请查看邮箱') } })
  }
  const submitRegistration = () => {
    if (!status) { setError('请先读取注册设置，再创建账号'); return }
    if (!status.registerEnabled || !status.passwordRegisterEnabled) { setError('目前暂未开放账号注册'); return }
    if (status.turnstileCheckEnabled) { setError('服务端需要安全验证，请在浏览器完成注册'); return }
    const errors = validateRegistration(registration, status.emailVerificationEnabled)
    setFieldErrors(errors)
    if (Object.keys(errors).length) return
    const draft = registration
    void run('创建账号', async (current) => {
      await api.register({ email: draft.email.trim(), username: draft.username.trim(), password: draft.password, verificationCode: draft.code.trim(), affCode: parseInviteCode(draft.invite) || undefined })
      if (!current()) return
      let result: AccountLoginResult
      try { result = await api.login({ username: draft.username.trim(), password: draft.password, siteId: 'solov' }) }
      catch (reason) {
        if (current()) {
          setMode('login'); setIdentifier(draft.username.trim()); setPassword(''); setAgreed(draft.agreed); loginTouched.current = true
          setRegistration((previous) => ({ ...previous, password: '', confirm: '', code: '' }))
          setMessage('账号已创建，自动登录没有完成，请输入密码继续')
          setError(authErrorMessage(reason, '自动登录'))
        }
        return
      }
      if (current()) { setRegistration((previous) => ({ ...previous, password: '', confirm: '', code: '' })); onAuthenticated(result) }
    })
  }
  const sendReset = () => {
    if (!isEmail(recoveryEmail)) { setError('请填写注册时使用的邮箱'); return }
    if (resetCooldown.seconds) return
    void run('发送重置邮件', async (current) => {
      await api.sendReset(recoveryEmail.trim())
      if (current()) { resetCooldown.start(); setRecoveryStep(2); setMessage('如果该邮箱可以接收重置邮件，你将收到一封邮件，请检查收件箱和垃圾邮件') }
    })
  }
  const submitReset = () => {
    if (!isEmail(recoveryEmail)) { setError('请先填写有效的注册邮箱'); return }
    const parsed = parseRecoveryCode(recoveryText)
    if (!parsed.ok) { setError(parsed.error); return }
    void run('重置密码', async (current) => {
      const result = await api.reset({ email: recoveryEmail.trim(), token: parsed.token })
      if (current()) { setNewPassword(result.newPassword); setRecoveryStep(3); setRecoveryText(''); setReveal(false); setCopyFallback(false); setMessage('新密码已生成，请妥善保存') }
    })
  }
  const copyPassword = () => void run('复制新密码', async (current) => {
    try { await api.copyPassword(newPassword); if (current()) setMessage('新密码已复制') }
    catch { if (current()) { setCopyFallback(true); setReveal(true); setError('无法访问剪贴板，请选中新密码后手动复制'); window.setTimeout(() => { const input = document.getElementById('forgot-new-password'); if (input instanceof HTMLInputElement) { input.focus(); input.select() } }, 0) } }
  })

  if (legal) return <LegalDocument api={api} kind={legal} onClose={() => setLegal(null)} />
  const agreement = (checked: boolean, onChange: (checked: boolean) => void) => <div className="auth-agreement"><label><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} data-testid="auth-agree" disabled={busy} />我已阅读并同意</label><Button size="xs" variant="ghost" disabled={busy} onClick={() => setLegal('user-agreement')} testId="auth-terms">用户协议</Button><Button size="xs" variant="ghost" disabled={busy} onClick={() => setLegal('privacy-policy')} testId="auth-privacy">隐私政策</Button></div>
  const field = (label: string, id: string, value: string, onChange: (value: string) => void, options: { type?: string; autoComplete?: string; placeholder?: string; error?: string; password?: boolean; maxLength?: number } = {}) => <div className="auth-field" key={id}><Input id={id} label={label} testId={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={busy} aria-label={label} {...options} /></div>
  const footer = mode === 'login' ? <>
    <Button variant="ghost" onClick={() => changeMode('recovery')} testId="login-forgot" disabled={busy}>找回密码</Button>
    <Button variant="ghost" onClick={() => changeMode('register')} testId="login-register" disabled={busy}>创建账号</Button>
    <span className="auth-footer-spacer" />
    <Button variant="ghost" onClick={close} disabled={busy} testId="login-cancel">取消</Button>
    <Button variant="primary" icon={LogIn} loading={busy} onClick={submitLogin} testId="login-submit">登录</Button>
  </> : mode === 'register' ? <>
    <Button variant="ghost" onClick={() => changeMode('login')} testId="register-login" disabled={busy}>已有账号，登录</Button>
    <span className="auth-footer-spacer" />
    <Button variant="ghost" onClick={close} disabled={busy} testId="register-cancel">取消</Button>
    <Button variant="primary" icon={UserPlus} loading={busy} disabled={!status || !status.registerEnabled || !status.passwordRegisterEnabled} onClick={submitRegistration} testId="register-submit">创建账号</Button>
  </> : <>
    <Button variant="ghost" icon={ArrowLeft} onClick={() => changeMode('login', recoveryEmail.trim())} disabled={busy} testId="forgot-back-login">返回登录</Button>
    <span className="auth-footer-spacer" />
    {recoveryStep === 1 ? <Button variant="primary" icon={Mail} loading={busy} disabled={Boolean(resetCooldown.seconds)} onClick={sendReset} testId="forgot-send">{resetCooldown.seconds ? `${resetCooldown.seconds} 秒后重发` : '发送重置邮件'}</Button>
      : recoveryStep === 2 ? <Button variant="primary" icon={KeyRound} loading={busy} onClick={submitReset} testId="forgot-reset">重置密码</Button>
        : <Button variant="primary" icon={ArrowRight} disabled={busy} onClick={() => changeMode('login', recoveryEmail.trim())} testId="forgot-finish">前往登录</Button>}
  </>
  return <Dialog open title={mode === 'login' ? '登录星芒账号' : mode === 'register' ? '创建星芒账号' : '找回密码'} subtitle={mode === 'login' ? '登录后继续你的工作台' : mode === 'register' ? '注册成功后登录并继续新手引导' : `第 ${recoveryStep} 步，共 3 步`} icon={mode === 'login' ? LogIn : mode === 'register' ? UserPlus : KeyRound} width={480} onClose={close} busy={busy} dirty={Boolean(password || registration.password || recoveryText)} testId={`${mode === 'recovery' ? 'forgot-password' : mode}-dialog`} footer={footer}>
    <div className="auth-form" aria-busy={busy} data-busy={busy} onKeyDown={(event) => { if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.target instanceof HTMLButtonElement || event.target instanceof HTMLTextAreaElement || busy) return; event.preventDefault(); if (mode === 'login') submitLogin(); else if (mode === 'register') submitRegistration(); else if (recoveryStep === 1) sendReset(); else if (recoveryStep === 2) submitReset() }}>
      {mode === 'login' && <>
        {field('用户名或邮箱', 'login-account', identifier, (value) => { loginTouched.current = true; setIdentifier(value) }, { autoComplete: 'username', placeholder: '输入用户名或邮箱' })}
        {field('密码', 'login-password', password, (value) => { loginTouched.current = true; setPassword(value) }, { password: true, autoComplete: 'current-password', placeholder: '输入密码' })}
        <label className="auth-checkbox"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy} data-testid="login-remember" />记住密码</label>
        {agreement(agreed, setAgreed)}
      </>}
      {mode === 'register' && <>
        {statusError && <div role="alert"><p className="auth-error">{statusError}</p><Button icon={RefreshCw} onClick={() => setStatusRevision((value) => value + 1)} testId="register-status-retry">重新读取</Button></div>}
        {!status && !statusError && <p role="status">正在读取注册设置</p>}
        {status && (!status.registerEnabled || !status.passwordRegisterEnabled) && <p className="auth-error" role="alert">目前暂未开放账号注册</p>}
        <div className="auth-email-row">{field('邮箱', 'register-email', registration.email, (value) => updateRegistration('email', value), { type: 'email', autoComplete: 'email', placeholder: 'name@example.com', error: fieldErrors.email })}{status?.emailVerificationEnabled && <Button onClick={sendVerification} icon={Mail} disabled={busy || Boolean(registerCooldown.seconds)} testId="register-send-code">{registerCooldown.seconds ? `${registerCooldown.seconds} 秒后重发` : '获取验证码'}</Button>}</div>
        <div className="auth-two-fields">{status?.emailVerificationEnabled && field('验证码', 'register-code', registration.code, (value) => updateRegistration('code', value), { autoComplete: 'one-time-code', error: fieldErrors.code })}{field('用户名', 'register-user', registration.username, (value) => updateRegistration('username', value), { autoComplete: 'username', placeholder: '3 至 20 个字符', error: fieldErrors.username, maxLength: 20 })}</div>
        <div className="auth-two-fields">{field('密码', 'register-password', registration.password, (value) => updateRegistration('password', value), { password: true, autoComplete: 'new-password', placeholder: '8 至 20 位', maxLength: 20, error: fieldErrors.password })}{field('确认密码', 'register-password-confirm', registration.confirm, (value) => updateRegistration('confirm', value), { password: true, autoComplete: 'new-password', placeholder: '再次输入密码', maxLength: 20, error: fieldErrors.confirm })}</div>
        {field('邀请码（选填）', 'register-invite', registration.invite, (value) => updateRegistration('invite', value), { placeholder: '邀请码或邀请链接', error: fieldErrors.invite })}
        {agreement(registration.agreed, (value) => updateRegistration('agreed', value))}{fieldErrors.agreed && <p role="alert" className="auth-field-error">{fieldErrors.agreed}</p>}
      </>}
      {mode === 'recovery' && <>
        <ol className="auth-recovery-steps" aria-label="找回密码进度">{['获取邮件', '粘贴重置码', '取得新密码'].map((text, index) => <li key={text} data-current={recoveryStep === index + 1}><span>{index + 1}</span>{text}</li>)}</ol>
        {recoveryStep === 1 && <>{field('注册邮箱', 'forgot-email', recoveryEmail, setRecoveryEmail, { type: 'email', autoComplete: 'email', placeholder: 'name@example.com' })}<p className="auth-hint">使用注册时填写的邮箱获取重置邮件。</p></>}
        {recoveryStep === 2 && <><p className="auth-hint">邮箱：{recoveryEmail}</p>{field('重置码或邮件链接', 'forgot-token', recoveryText, setRecoveryText, { placeholder: '粘贴重置码或邮件中的完整链接', autoComplete: 'off' })}<div className="auth-form-actions"><Button variant="ghost" icon={ArrowLeft} disabled={busy} onClick={() => { setRecoveryStep(1); setError('') }} testId="forgot-change-email">修改邮箱</Button><Button variant="ghost" icon={RefreshCw} disabled={busy || Boolean(resetCooldown.seconds)} onClick={sendReset} testId="forgot-resend">{resetCooldown.seconds ? `${resetCooldown.seconds} 秒后重发` : '重新发送'}</Button></div></>}
        {recoveryStep === 3 && <><div className="auth-reset-success"><Check size={22} aria-hidden="true" /><strong>密码已重置</strong></div><div className="auth-field"><label htmlFor="forgot-new-password">新密码</label><div className="auth-password-result"><Input id="forgot-new-password" testId="forgot-new-password" readOnly type={reveal ? 'text' : 'password'} value={newPassword} aria-label="新密码" mono /><Button variant="ghost" icon={reveal ? EyeOff : Eye} onClick={() => setReveal(!reveal)} testId="forgot-show-password">{reveal ? '隐藏' : '显示'}</Button><Button icon={Copy} onClick={copyPassword} disabled={busy} testId="forgot-copy-password">复制</Button></div>{copyFallback && <p className="auth-hint">选中新密码后使用系统复制操作，再返回登录。</p>}</div></>}
      </>}
      {message && <p className="auth-message" role="status" data-testid="auth-message">{message}</p>}
      {error && <p className="auth-error" role="alert" data-testid="auth-error">{error}</p>}
      {mode === 'register' && status?.turnstileCheckEnabled && onHelp && <Button variant="ghost" onClick={onHelp} testId="auth-verification-help">打开帮助</Button>}
    </div>
  </Dialog>
}
