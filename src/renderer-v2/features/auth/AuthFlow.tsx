import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, Copy, ExternalLink, Eye, EyeOff, KeyRound, LogIn, Mail, RefreshCw, ShieldCheck, UserPlus } from 'lucide-react'
import type { AccountLoginResult, AccountStatus, LegalDocumentKind } from '../../../../electron/ipc-contract'
import { Button, Dialog, Input, Segment } from '../../ui'
import { getAuthApi, type AccountSiteId, type AuthApi } from './api'
import { LegalDocument } from './LegalDocument'
import { isUsernameTakenError } from './account-errors'
import { accountSources, authErrorMessage, isEmail, isTwoFactorChallenge, isTwoFactorExpired, normalizeEmail, parseInviteCode, parseRecoveryCode, parseTwoFactorCode, requiresBrowserAuthentication, suggestEmailCorrection, usernameFromEmail, validateRegistration, type RegistrationDraft, type RegistrationErrors } from './state'
import { useCooldown } from './useCooldown'
import './auth.css'

export type AuthMode = 'login' | 'register' | 'recovery'
export interface AuthFlowProps {
  api?: AuthApi
  initialMode?: AuthMode
  initialIdentifier?: string
  initialSiteId?: AccountSiteId
  initialInviteCode?: string
  onAuthenticated: (result: AccountLoginResult, options?: { rememberError?: string }) => void
  onClose: () => void
  onHelp?: () => void
  /** 服务正在维护时的提示。登录框是模态的，会盖住角落里那条，所以在框里再放一份。 */
  notice?: ReactNode
}

export function AuthFlow({ api: providedApi, initialMode = 'login', initialIdentifier = '', initialSiteId = 'solov', initialInviteCode = '', onAuthenticated, onClose, onHelp, notice }: AuthFlowProps) {
  const [api] = useState(() => providedApi ?? getAuthApi())
  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [siteId, setSiteId] = useState<AccountSiteId>(initialMode === 'register' ? 'solov' : initialSiteId)
  const source = accountSources[siteId]
  // 2026-08 后端统一之后新注册的都是星芒账号，「历史账号」只剩老用户用得上：默认收起，
  // 点底部那行才出现来源切换。收起不等于换默认——默认仍是星芒账号，只发选中的那一站。
  const [sourceOpen, setSourceOpen] = useState(initialSiteId !== 'solov')
  const sourceVisible = sourceOpen || siteId !== 'solov'
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
  // 邮箱拼错的提示只在离开邮箱框或点按钮之后出，免得边打字边闪「你是不是想填」。
  const [emailChecked, setEmailChecked] = useState(false)
  // 看过提示仍坚持用的那个地址：提醒一次，第二次照原样发，不拦死。
  const [typoConfirmedEmail, setTypoConfirmedEmail] = useState('')
  const [inviteOpen, setInviteOpen] = useState(Boolean(initialInviteCode.trim()))
  // 一次性的聚焦请求：撞名时请求发出去那会儿表单还是禁用的，要等 busy 落下再聚焦。
  const [focusTarget, setFocusTarget] = useState('')
  const [recoveryStep, setRecoveryStep] = useState<1 | 2 | 3>(1)
  const [recoveryEmail, setRecoveryEmail] = useState(isEmail(initialIdentifier) ? initialIdentifier : '')
  const [recoveryText, setRecoveryText] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [copyFallback, setCopyFallback] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [browserAuthentication, setBrowserAuthentication] = useState(false)
  // 密码已经对了、还差验证器里那 6 位数字（或备用码）。flow token 留在主进程，这里只记是哪种输入。
  const [twoFactor, setTwoFactor] = useState<{ backup: boolean } | null>(null)
  const [twoFactorCode, setTwoFactorCode] = useState('')
  // 第二步成功后才按「记住密码」落盘，所以把第一步交出去的那份账号密码留到那时。
  const twoFactorLogin = useRef<{ username: string; password: string; siteId: AccountSiteId; remember: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const epoch = useRef(0)
  const loginTouched = useRef(Boolean(initialIdentifier))
  // 用户名默认跟着邮箱 @ 前那段走，用户亲手改过就不再覆盖；清空了则重新跟随。
  const usernameFollowsEmail = useRef(true)
  const focusedStep = useRef('')
  const registerCooldown = useCooldown()
  const resetCooldown = useCooldown()
  useEffect(() => () => { epoch.current++; locked.current = false }, [])
  useEffect(() => {
    if (legal) { focusedStep.current = ''; return }
    if (busy) return
    const stepKey = `${siteId}:${mode}:${mode === 'recovery' ? recoveryStep : ''}:${twoFactor ? twoFactor.backup ? 'backup' : 'code' : ''}`
    if (focusedStep.current === stepKey) return
    const id = mode === 'login' ? twoFactor ? 'login-2fa-code' : identifier.trim() ? 'login-password' : 'login-account' : mode === 'register' ? 'register-email' : recoveryStep === 1 ? 'forgot-email' : recoveryStep === 2 ? 'forgot-token' : 'forgot-new-password'
    const frame = window.requestAnimationFrame(() => {
      const input = document.getElementById(id)
      if (input instanceof HTMLInputElement && !input.disabled) { input.focus(); focusedStep.current = stepKey }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [siteId, mode, recoveryStep, legal, busy, identifier, twoFactor])
  useEffect(() => {
    if (!focusTarget || busy) return
    const frame = window.requestAnimationFrame(() => {
      const input = document.getElementById(focusTarget)
      if (input instanceof HTMLInputElement && !input.disabled) input.focus()
      setFocusTarget('')
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusTarget, busy])
  useEffect(() => {
    let active = true
    setStatusError(''); setStatus(null)
    // Turnstile and the site name differ per account source, so the snapshot must follow siteId.
    // Registration is main-account only (the flow pins siteId there), so its flags stay correct.
    void api.getStatus(siteId).then((value) => { if (active) setStatus(value) }, (reason: unknown) => { if (active) setStatusError(authErrorMessage(reason, '读取账号设置')) })
    return () => { active = false }
  }, [api, siteId, statusRevision])
  useEffect(() => {
    if (mode !== 'login') return
    let active = true
    const owner = epoch.current
    void api.getRemembered(siteId).then((value) => { if (active && epoch.current === owner && !loginTouched.current && value) { setIdentifier(value.identifier); setPassword(value.password); setRemember(true) } }, () => undefined)
    return () => { active = false }
  }, [api, siteId, mode])

  const leaveTwoFactor = () => {
    setTwoFactor(null); setTwoFactorCode(''); twoFactorLogin.current = null
  }

  const changeSource = (value: string) => {
    if (locked.current || (value !== 'solov' && value !== 'solov-api') || value === siteId) return
    epoch.current++
    setSiteId(value); setPassword(''); setRemember(false); setError(''); setMessage(''); setBrowserAuthentication(false); leaveTwoFactor()
    setRecoveryStep(1); setRecoveryText(''); setNewPassword(''); setReveal(false); setCopyFallback(false)
    loginTouched.current = false
  }

  const openHistorySource = () => {
    if (locked.current) return
    setSourceOpen(true); changeSource('solov-api')
  }

  const changeMode = (next: AuthMode, nextIdentifier?: string) => {
    if (locked.current) return
    epoch.current++
    setMode(next); setError(''); setMessage(''); setBrowserAuthentication(false); setFieldErrors({}); leaveTwoFactor(); setNewPassword(''); setReveal(false); setCopyFallback(false)
    if (next === 'register') { setSiteId('solov'); setPassword(''); setRemember(false) }
    if (nextIdentifier !== undefined) { setIdentifier(nextIdentifier); setPassword(''); loginTouched.current = true }
    if (next === 'recovery') { setRecoveryStep(1); if (isEmail(identifier)) setRecoveryEmail(identifier) }
  }
  const close = () => {
    if (locked.current) { setMessage('正在处理，请稍候'); return }
    epoch.current++; setPassword(''); setNewPassword(''); leaveTwoFactor(); onClose()
  }
  const run = async (action: string, work: (isCurrent: () => boolean) => Promise<void>) => {
    if (locked.current) return
    const owner = epoch.current
    const current = () => epoch.current === owner
    locked.current = true; setBusy(true); setError(''); setMessage('')
    try { await work(current) } catch (reason) { if (current()) { setError(authErrorMessage(reason, action)); setBrowserAuthentication(requiresBrowserAuthentication(reason)) } }
    finally { if (current()) { locked.current = false; setBusy(false) } }
  }
  const submitLogin = () => {
    if (!identifier.trim() || !password) { setError('请输入账号和密码'); return }
    if (!agreed) { setError('请先同意用户协议和隐私政策'); return }
    if (siteId === 'solov-api' && !isEmail(identifier)) { setError('历史账号请使用注册邮箱登录'); return }
    const login = { username: identifier.trim(), password, siteId }
    void run('登录', async (current) => {
      let result: AccountLoginResult
      try { result = await api.login(login) }
      catch (reason) {
        // 只有当前账号能在客户端里接着输验证码；历史账号那边照旧指去官网。
        if (!isTwoFactorChallenge(reason) || login.siteId !== 'solov') throw reason
        if (current()) { twoFactorLogin.current = { ...login, remember }; setTwoFactorCode(''); setTwoFactor({ backup: false }) }
        return
      }
      if (current()) await finishLogin(result, { ...login, remember }, current)
    })
  }
  const finishLogin = async (result: AccountLoginResult, login: { username: string; password: string; siteId: AccountSiteId; remember: boolean }, current: () => boolean) => {
    let rememberError: string | undefined
    try { await api.setRemembered(login.remember ? { identifier: login.username, password: login.password } : null, login.siteId) }
    catch { rememberError = '已登录，但记住密码的设置没有保存成功' }
    if (current()) { setPassword(''); leaveTwoFactor(); onAuthenticated(result, { rememberError }) }
  }
  const submitTwoFactor = () => {
    const login = twoFactorLogin.current
    if (!twoFactor || !login) return
    const parsed = parseTwoFactorCode(twoFactorCode, twoFactor.backup)
    if (!parsed.ok) { setError(parsed.error); return }
    void run('两步验证', async (current) => {
      let result: AccountLoginResult
      try { result = await api.submitTwoFactor(parsed.code) }
      catch (reason) {
        // 超过 5 分钟服务端就不认这次登录了：回到输密码那一步，账号名留着。
        if (isTwoFactorExpired(reason) && current()) { leaveTwoFactor(); setPassword(''); focusedStep.current = '' }
        else if (current()) setTwoFactorCode('')
        throw reason
      }
      if (current()) await finishLogin(result, login, current)
    })
  }
  const switchTwoFactorInput = () => {
    if (locked.current || !twoFactor) return
    setTwoFactor({ backup: !twoFactor.backup }); setTwoFactorCode(''); setError('')
  }
  const updateRegistration = <K extends keyof RegistrationDraft>(key: K, value: RegistrationDraft[K]) => {
    setRegistration((draft) => ({ ...draft, [key]: value }))
    setFieldErrors((errors) => ({ ...errors, [key]: undefined }))
  }
  const updateEmail = (value: string, checked = false) => {
    const follow = usernameFollowsEmail.current
    setRegistration((draft) => ({ ...draft, email: value, username: follow ? usernameFromEmail(normalizeEmail(value)) : draft.username }))
    setFieldErrors((errors) => ({ ...errors, email: undefined, ...(follow ? { username: undefined } : {}) }))
    setEmailChecked(checked)
  }
  const checkEmail = () => {
    const email = normalizeEmail(registration.email)
    if (email !== registration.email) updateEmail(email, true)
    else setEmailChecked(true)
    return email
  }
  // 焦点正落到「获取验证码」「创建账号」上时，交给按钮自己查：提示在按下那一刻冒出来会把弹窗撑高、按钮挪位，
  // 松手时已不在按钮上，这一下就白点了。
  const checkEmailOnLeave = (event: FocusEvent<HTMLInputElement>) => {
    const next = event.relatedTarget instanceof HTMLElement ? event.relatedTarget.dataset.testid : undefined
    if (next !== 'register-send-code' && next !== 'register-submit') checkEmail()
  }
  // 返回 false 表示这次先停下给用户看拼写提示；同一个地址再点一次就放行。
  const passesTypoCheck = (email: string) => {
    if (!suggestEmailCorrection(email) || typoConfirmedEmail === email) return true
    setTypoConfirmedEmail(email)
    return false
  }
  const updateUsername = (value: string) => {
    usernameFollowsEmail.current = !value.trim()
    updateRegistration('username', value)
  }
  const sendVerification = () => {
    const email = checkEmail()
    if (!isEmail(email)) { setFieldErrors((errors) => ({ ...errors, email: '请填写正确的邮箱' })); return }
    if (registerCooldown.seconds || !passesTypoCheck(email)) return
    void run('发送验证码', async (current) => { await api.sendVerification(email); if (current()) { registerCooldown.start(); setMessage(`验证码已发到 ${email}。几分钟内没收到的话，看看垃圾邮件。`) } })
  }
  const submitRegistration = () => {
    if (!status) { setError('请先读取注册设置，再创建账号'); return }
    if (!status.registerEnabled || !status.passwordRegisterEnabled) { setError('目前暂未开放账号注册'); return }
    if (status.turnstileCheckEnabled) { setError('服务端需要安全验证，请在浏览器完成注册'); return }
    const draft = { ...registration, email: checkEmail() }
    const errors = validateRegistration(draft, status.emailVerificationEnabled)
    setFieldErrors(errors)
    if (Object.keys(errors).length || !passesTypoCheck(draft.email)) return
    void run('创建账号', async (current) => {
      try { await api.register({ email: draft.email.trim(), username: draft.username.trim(), password: draft.password, verificationCode: draft.code.trim(), affCode: parseInviteCode(draft.invite) || undefined }) }
      catch (reason) {
        // 用户名是替他从邮箱取的，撞名是这条路上最可能遇到的失败：直接指到那一格。
        if (!isUsernameTakenError(reason)) throw reason
        if (current()) { usernameFollowsEmail.current = false; setFieldErrors((errors) => ({ ...errors, username: '这个用户名已经有人用了，换一个试试' })); setFocusTarget('register-user') }
        return
      }
      if (!current()) return
      let result: AccountLoginResult
      try { result = await api.login({ username: draft.username.trim(), password: draft.password, siteId: 'solov' }) }
      catch (reason) {
        if (current()) {
          setMode('login'); setIdentifier(draft.username.trim()); setPassword(''); setAgreed(draft.agreed); loginTouched.current = true
          setRegistration((previous) => ({ ...previous, password: '', confirm: '', code: '' }))
          setMessage('账号已创建，自动登录没有完成，请输入密码继续')
          setError(authErrorMessage(reason, '自动登录'))
          setBrowserAuthentication(requiresBrowserAuthentication(reason))
        }
        return
      }
      if (current()) { setRegistration((previous) => ({ ...previous, password: '', confirm: '', code: '' })); onAuthenticated(result) }
    })
  }
  const sendReset = () => {
    if (!source.supportsPasswordReset) return
    if (!isEmail(recoveryEmail)) { setError('请填写注册时使用的邮箱'); return }
    if (resetCooldown.seconds) return
    void run('发送重置邮件', async (current) => {
      await api.sendReset(recoveryEmail.trim(), siteId)
      if (current()) { resetCooldown.start(); setRecoveryStep(2); setMessage('如果该邮箱可以接收重置邮件，你将收到一封邮件，请检查收件箱和垃圾邮件') }
    })
  }
  const submitReset = () => {
    if (!source.supportsPasswordReset) return
    if (!isEmail(recoveryEmail)) { setError('请先填写有效的注册邮箱'); return }
    const parsed = parseRecoveryCode(recoveryText, source.website)
    if (!parsed.ok) { setError(parsed.error); return }
    void run('重置密码', async (current) => {
      const result = await api.reset({ email: recoveryEmail.trim(), token: parsed.token }, siteId)
      if (current()) { setNewPassword(result.newPassword); setRecoveryStep(3); setRecoveryText(''); setReveal(false); setCopyFallback(false); setMessage('新密码已生成，请妥善保存') }
    })
  }
  const copyPassword = () => void run('复制新密码', async (current) => {
    try { await api.copyPassword(newPassword); if (current()) setMessage('新密码已复制') }
    catch { if (current()) { setCopyFallback(true); setReveal(true); setError('无法访问剪贴板，请选中新密码后手动复制'); window.setTimeout(() => { const input = document.getElementById('forgot-new-password'); if (input instanceof HTMLInputElement) { input.focus(); input.select() } }, 0) } }
  })
  const openAccountWebsite = () => void run('打开账号官网', async () => {
    if (!await api.openExternal(source.website)) throw new Error('Open external failed')
  })

  if (legal) return <LegalDocument api={api} kind={legal} onClose={() => setLegal(null)} />
  const agreement = (checked: boolean, onChange: (checked: boolean) => void) => <div className="auth-agreement"><label><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} data-testid="auth-agree" disabled={busy} />我已阅读并同意</label><Button size="xs" variant="ghost" disabled={busy} onClick={() => setLegal('user-agreement')} testId="auth-terms">用户协议</Button><Button size="xs" variant="ghost" disabled={busy} onClick={() => setLegal('privacy-policy')} testId="auth-privacy">隐私政策</Button></div>
  const emailSuggestion = emailChecked ? suggestEmailCorrection(registration.email) : null
  const field = (label: string, id: string, value: string, onChange: (value: string) => void, options: { type?: string; autoComplete?: string; placeholder?: string; error?: string; password?: boolean; maxLength?: number; onBlur?: (event: FocusEvent<HTMLInputElement>) => void } = {}) => <div className="auth-field" key={id}><Input id={id} label={label} testId={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={busy} aria-label={label} {...options} /></div>
  const footer = mode === 'login' && twoFactor ? <>
    <Button variant="ghost" icon={ArrowLeft} onClick={() => { if (locked.current) return; leaveTwoFactor(); setPassword(''); setError(''); setMessage('') }} disabled={busy} testId="login-2fa-back">返回</Button>
    <span className="auth-footer-spacer" />
    <Button variant="ghost" onClick={close} disabled={busy} testId="login-cancel">取消</Button>
    <Button variant="primary" icon={ShieldCheck} loading={busy} onClick={submitTwoFactor} testId="login-2fa-submit">验证并登录</Button>
  </> : mode === 'login' ? <>
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
    {!source.supportsPasswordReset ? <Button variant="primary" icon={ExternalLink} loading={busy} onClick={openAccountWebsite} testId="forgot-open-website">前往历史账号官网</Button>
      : recoveryStep === 1 ? <Button variant="primary" icon={Mail} loading={busy} disabled={Boolean(resetCooldown.seconds)} onClick={sendReset} testId="forgot-send">{resetCooldown.seconds ? `${resetCooldown.seconds} 秒后重发` : '发送重置邮件'}</Button>
      : recoveryStep === 2 ? <Button variant="primary" icon={KeyRound} loading={busy} onClick={submitReset} testId="forgot-reset">重置密码</Button>
        : <Button variant="primary" icon={ArrowRight} disabled={busy} onClick={() => changeMode('login', recoveryEmail.trim())} testId="forgot-finish">前往登录</Button>}
  </>
  return <Dialog open title={mode === 'login' ? `登录${source.label}` : mode === 'register' ? '创建星芒账号' : `找回${source.label}密码`} subtitle={mode === 'login' ? twoFactor ? '还差一步：两步验证' : '登录后继续你的工作台' : mode === 'register' ? '注册成功后登录并继续新手引导' : source.supportsPasswordReset ? `第 ${recoveryStep} 步，共 3 步` : '通过历史账号官网恢复访问'} icon={mode === 'login' ? LogIn : mode === 'register' ? UserPlus : KeyRound} width={480} onClose={close} busy={busy} dirty={Boolean(password || registration.password || recoveryText || twoFactorCode)} testId={`${mode === 'recovery' ? 'forgot-password' : mode}-dialog`} footer={footer}>
    <div className="auth-form" aria-busy={busy} data-busy={busy} onKeyDown={(event) => { if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.target instanceof HTMLButtonElement || event.target instanceof HTMLTextAreaElement || busy) return; event.preventDefault(); if (mode === 'login') { if (twoFactor) submitTwoFactor(); else submitLogin() } else if (mode === 'register') submitRegistration(); else if (recoveryStep === 1) sendReset(); else if (recoveryStep === 2) submitReset() }}>
      {notice}
      {mode !== 'register' && sourceVisible && !twoFactor && <div className="auth-source"><span className="auth-source-label">账号来源</span><Segment label="账号来源" value={siteId} onChange={changeSource} testId="auth-source" options={Object.entries(accountSources).map(([value, entry]) => ({ value, label: entry.label, disabled: busy }))} /></div>}
      {mode === 'login' && twoFactor && <>
        <p className="auth-hint" data-testid="login-2fa-hint">{twoFactor.backup ? '输入开两步验证时保存的备用码，每个只能用一次。' : '这个账号开了两步验证。打开手机上的验证器 App，输入星芒账号那一行显示的 6 位数字。'}</p>
        {field(twoFactor.backup ? '备用码' : '验证码', 'login-2fa-code', twoFactorCode, setTwoFactorCode, { autoComplete: twoFactor.backup ? 'off' : 'one-time-code', placeholder: twoFactor.backup ? '备用码' : '6 位验证码', maxLength: 64 })}
        <div className="auth-more"><Button size="xs" variant="ghost" disabled={busy} onClick={switchTwoFactorInput} testId="login-2fa-switch">{twoFactor.backup ? '改用验证器里的 6 位数字' : '手机不在身边？用备用码登录'}</Button></div>
      </>}
      {mode === 'login' && !twoFactor && <>
        {field(siteId === 'solov-api' ? '注册邮箱' : '用户名或邮箱', 'login-account', identifier, (value) => { loginTouched.current = true; setIdentifier(value) }, { autoComplete: 'username', placeholder: siteId === 'solov-api' ? '输入历史账号的注册邮箱' : '输入用户名或邮箱' })}
        {field('密码', 'login-password', password, (value) => { loginTouched.current = true; setPassword(value) }, { password: true, autoComplete: 'current-password', placeholder: '输入密码' })}
        <label className="auth-checkbox"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy} data-testid="login-remember" />记住密码</label>
        {agreement(agreed, setAgreed)}
      </>}
      {mode === 'register' && <>
        {statusError && <div role="alert"><p className="auth-error">{statusError}</p><Button icon={RefreshCw} onClick={() => setStatusRevision((value) => value + 1)} testId="register-status-retry">重新读取</Button></div>}
        {!status && !statusError && <p role="status">正在读取注册设置</p>}
        {status && (!status.registerEnabled || !status.passwordRegisterEnabled) && <p className="auth-error" role="alert">目前暂未开放账号注册</p>}
        <div className="auth-email-row">{field('邮箱', 'register-email', registration.email, updateEmail, { type: 'email', autoComplete: 'email', placeholder: '常用邮箱（如 QQ 邮箱）', error: fieldErrors.email, onBlur: checkEmailOnLeave })}{status?.emailVerificationEnabled && <Button onClick={sendVerification} icon={Mail} disabled={busy || Boolean(registerCooldown.seconds)} testId="register-send-code">{registerCooldown.seconds ? `${registerCooldown.seconds} 秒后重发` : '获取验证码'}</Button>}</div>
        {emailSuggestion && <div className="auth-email-suggestion" role="status" data-testid="register-email-suggestion"><p className="auth-hint">你是不是想填 {emailSuggestion}？{typoConfirmedEmail === normalizeEmail(registration.email) && `没填错的话，再点一次「${status?.emailVerificationEnabled ? '获取验证码' : '创建账号'}」。`}</p><Button size="xs" disabled={busy} onClick={() => updateEmail(emailSuggestion, true)} testId="register-email-fix">改成这个</Button></div>}
        <div className="auth-two-fields">{status?.emailVerificationEnabled && field('验证码', 'register-code', registration.code, (value) => updateRegistration('code', value), { autoComplete: 'one-time-code', error: fieldErrors.code })}{field('用户名', 'register-user', registration.username, updateUsername, { autoComplete: 'username', placeholder: '自动取邮箱 @ 前面的部分', error: fieldErrors.username, maxLength: 20 })}</div>
        <div className="auth-two-fields">{field('密码', 'register-password', registration.password, (value) => updateRegistration('password', value), { password: true, autoComplete: 'new-password', placeholder: '8 至 20 位', maxLength: 20, error: fieldErrors.password })}{field('确认密码', 'register-password-confirm', registration.confirm, (value) => updateRegistration('confirm', value), { password: true, autoComplete: 'new-password', placeholder: '再次输入密码', maxLength: 20, error: fieldErrors.confirm })}</div>
        {inviteOpen ? field('邀请码（选填）', 'register-invite', registration.invite, (value) => updateRegistration('invite', value), { placeholder: '邀请码或邀请链接', error: fieldErrors.invite })
          : <div className="auth-more"><Button size="xs" variant="ghost" disabled={busy} onClick={() => { setInviteOpen(true); setFocusTarget('register-invite') }} testId="register-invite-toggle">有邀请码？</Button></div>}
        {agreement(registration.agreed, (value) => updateRegistration('agreed', value))}{fieldErrors.agreed && <p role="alert" className="auth-field-error">{fieldErrors.agreed}</p>}
      </>}
      {mode === 'recovery' && !source.supportsPasswordReset && <p className="auth-hint" data-testid="forgot-official-help">历史账号暂不支持在客户端重置密码。请前往历史账号官网使用找回入口；若官网未提供入口，请联系官网客服恢复访问。</p>}
      {mode === 'recovery' && source.supportsPasswordReset && <>
        <ol className="auth-recovery-steps" aria-label="找回密码进度">{['获取邮件', '粘贴重置码', '取得新密码'].map((text, index) => <li key={text} data-current={recoveryStep === index + 1}><span>{index + 1}</span>{text}</li>)}</ol>
        {recoveryStep === 1 && <>{field('注册邮箱', 'forgot-email', recoveryEmail, setRecoveryEmail, { type: 'email', autoComplete: 'email', placeholder: 'name@example.com' })}<p className="auth-hint">使用注册时填写的邮箱获取重置邮件。</p></>}
        {recoveryStep === 2 && <><p className="auth-hint">邮箱：{recoveryEmail}</p>{field('重置码或邮件链接', 'forgot-token', recoveryText, setRecoveryText, { placeholder: '粘贴重置码或邮件中的完整链接', autoComplete: 'off' })}<div className="auth-form-actions"><Button variant="ghost" icon={ArrowLeft} disabled={busy} onClick={() => { setRecoveryStep(1); setError('') }} testId="forgot-change-email">修改邮箱</Button><Button variant="ghost" icon={RefreshCw} disabled={busy || Boolean(resetCooldown.seconds)} onClick={sendReset} testId="forgot-resend">{resetCooldown.seconds ? `${resetCooldown.seconds} 秒后重发` : '重新发送'}</Button></div></>}
        {recoveryStep === 3 && <><div className="auth-reset-success"><Check size={22} aria-hidden="true" /><strong>密码已重置</strong></div><div className="auth-field"><label htmlFor="forgot-new-password">新密码</label><div className="auth-password-result"><Input id="forgot-new-password" testId="forgot-new-password" readOnly type={reveal ? 'text' : 'password'} value={newPassword} aria-label="新密码" mono /><Button variant="ghost" icon={reveal ? EyeOff : Eye} onClick={() => setReveal(!reveal)} testId="forgot-show-password">{reveal ? '隐藏' : '显示'}</Button><Button icon={Copy} onClick={copyPassword} disabled={busy} testId="forgot-copy-password">复制</Button></div>{copyFallback && <p className="auth-hint">选中新密码后使用系统复制操作，再返回登录。</p>}</div></>}
      </>}
      {mode !== 'register' && !sourceVisible && !twoFactor && (mode === 'login' || recoveryStep === 1) && <div className="auth-more"><Button size="xs" variant="ghost" disabled={busy} onClick={openHistorySource} testId="auth-source-expand">{mode === 'login' ? '用历史账号登录' : '找回历史账号的密码'}</Button></div>}
      {message && <p className="auth-message" role="status" data-testid="auth-message">{message}</p>}
      {error && <p className="auth-error" role="alert" data-testid="auth-error">{error}</p>}
      {browserAuthentication && <Button variant="ghost" icon={ExternalLink} onClick={openAccountWebsite} disabled={busy} testId="auth-open-website">前往{source.label}官网</Button>}
      {mode !== 'recovery' && status?.turnstileCheckEnabled && onHelp && <Button variant="ghost" onClick={onHelp} testId="auth-verification-help">打开帮助</Button>}
    </div>
  </Dialog>
}
