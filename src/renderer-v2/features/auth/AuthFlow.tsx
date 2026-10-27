import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { ArrowRight, CircleAlert, Copy, ExternalLink, Eye, EyeOff, Headset, Info, KeyRound, LogIn, Mail, RefreshCw, UserPlus } from 'lucide-react'
import type { AccountLoginResult, AccountStatus, LegalDocumentKind } from '../../../../electron/ipc-contract'
import { Button, Dialog, Input, Segment } from '../../ui'
import { sessionOnlyLoginNotice } from '../app/remembered-login'
import { useLatestRequest } from '../../latest-request'
import { getAuthApi, type AccountSiteId, type AuthApi } from './api'
import { LegalDocument } from './LegalDocument'
import { isUsernameTakenError } from './account-errors'
import { accountSources, authErrorMessage, authFailure, authOfflineMessage, isEmail, isTwoFactorChallenge, isTwoFactorExpired, normalizeEmail, parseInviteCode, parseRecoveryCode, parseTwoFactorCode, registrationStatusFailure, requiresBrowserAuthentication, suggestEmailCorrection, usernameFromEmail, validateNewPassword, validateRegistration, type AuthFailureKind, type RegistrationDraft, type RegistrationErrors } from './state'
import { useCooldown } from './useCooldown'
import './auth.css'

export type AuthMode = 'login' | 'register' | 'recovery'
// 读注册设置第一次没读到时，隔这么久自动再试一次。单次请求的 10 秒超时不动，只多给一次机会。
const statusRetryDelayMs = 2_000
// 这几步失败后可以原样再点一次；其余（两步验证的验证码已经用掉、设新密码失败后临时密码已亮出）没有「再试一次」。
const retryableActions = ['登录', '发送验证码', '创建账号', '发送重置邮件', '重置密码'] as const
type RetryableAction = typeof retryableActions[number]
function isRetryableAction(action: string): action is RetryableAction {
  return (retryableActions as readonly string[]).includes(action)
}
/** 红字下面那排出口按什么给：哪一步、为什么失败；没网那种等网络回来后红字换成提示，出口留着。 */
interface FailureExit {
  action: string
  kind: AuthFailureKind
  message: string
  reconnected?: boolean
}
/** 一次登录要交的东西；newPassword 只在找回密码那条路上有：登上之后立刻把临时密码换成它。 */
interface LoginAttempt {
  username: string
  password: string
  siteId: AccountSiteId
  remember: boolean
  newPassword?: string
  /** 登上之后右下角那句短提示；缺省 = 「欢迎回来，{用户名}」。 */
  notice?: string
}
export interface AuthFlowProps {
  api?: AuthApi
  initialMode?: AuthMode
  initialIdentifier?: string
  initialSiteId?: AccountSiteId
  initialInviteCode?: string
  onAuthenticated: (result: AccountLoginResult, options?: { rememberError?: string; notice?: string }) => void
  onClose: () => void
  onHelp?: () => void
  /** Local connection settings remain reachable before the first successful login. */
  connectionSettings?: (onBusyChange: (busy: boolean) => void) => ReactNode
  /** 服务正在维护时的提示。登录框是模态的，会盖住角落里那条，所以在框里再放一份。 */
  notice?: ReactNode
  /** 这台电脑没法安全保存登录（Linux 没有系统密码保管）：不给「记住密码」，改说一句会怎样。 */
  sessionOnly?: boolean
}

export function AuthFlow({ api: providedApi, initialMode = 'login', initialIdentifier = '', initialSiteId = 'solov', initialInviteCode = '', onAuthenticated, onClose, onHelp, connectionSettings, notice, sessionOnly = false }: AuthFlowProps) {
  const [api] = useState(() => providedApi ?? getAuthApi())
  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [siteId, setSiteId] = useState<AccountSiteId>(initialMode === 'register' ? 'solov' : initialSiteId)
  const source = accountSources[siteId]
  // 2026-08 后端统一之后新注册的都是星芒账号，「历史账号」只剩老用户用得上：默认收起，
  // 点底部那行才出现来源切换。收起不等于换默认——默认仍是星芒账号，只发选中的那一站。
  const [sourceOpen, setSourceOpen] = useState(initialSiteId !== 'solov')
  const sourceVisible = sourceOpen || siteId !== 'solov'
  const [legal, setLegal] = useState<LegalDocumentKind | null>(null)
  const [routesOpen, setRoutesOpen] = useState(false)
  const [routesBusy, setRoutesBusy] = useState(false)
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [statusRevision, setStatusRevision] = useState(0)
  const [statusRetrying, setStatusRetrying] = useState(false)
  const [statusOffline, setStatusOffline] = useState(false)
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
  // 验证码空着就点「注册并登录」时，没点过「获取验证码」的人要先被指去点它，点过的才是忘了填。
  const [codeSent, setCodeSent] = useState(false)
  // 一次性的聚焦请求：撞名时请求发出去那会儿表单还是禁用的，要等 busy 落下再聚焦。
  const [focusTarget, setFocusTarget] = useState('')
  const [recoveryStep, setRecoveryStep] = useState<1 | 2 | 3>(1)
  const [recoveryEmail, setRecoveryEmail] = useState(isEmail(initialIdentifier) ? initialIdentifier : '')
  const [recoveryText, setRecoveryText] = useState('')
  // 账号服务重置后给的随机密码。先只在内存里拿来登录、再换成客户设的；只有没换成或客户选「先不设」时才亮出来。
  const [newPassword, setNewPassword] = useState('')
  const [tempShown, setTempShown] = useState(false)
  const [chosen, setChosen] = useState({ password: '', confirm: '' })
  const [chosenErrors, setChosenErrors] = useState<{ password?: string; confirm?: string }>({})
  // 已经用临时密码登上、但新密码没换成：主进程那边已是登录状态，关框也要当登录完成处理，不能让界面和会话对不上。
  const [recovered, setRecovered] = useState<AccountLoginResult | null>(null)
  const [reveal, setReveal] = useState(false)
  const [copyFallback, setCopyFallback] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState<FailureExit | null>(null)
  const [browserAuthentication, setBrowserAuthentication] = useState(false)
  // 密码已经对了、还差验证器里那 6 位数字（或备用码）。flow token 留在主进程，这里只记是哪种输入。
  const [twoFactor, setTwoFactor] = useState<{ backup: boolean } | null>(null)
  const [twoFactorCode, setTwoFactorCode] = useState('')
  // 第二步成功后才按「记住密码」落盘，所以把第一步交出去的那份账号密码留到那时。
  // 找回密码那条路上还带着客户设的新密码，两步验证过了再换。
  const twoFactorLogin = useRef<LoginAttempt | null>(null)
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const epoch = useLatestRequest()
  const loginTouched = useRef(Boolean(initialIdentifier))
  // 用户名默认跟着邮箱 @ 前那段走，用户亲手改过就不再覆盖；清空了则重新跟随。
  const usernameFollowsEmail = useRef(true)
  const focusedStep = useRef('')
  const registerCooldown = useCooldown()
  const resetCooldown = useCooldown()
  useEffect(() => () => { locked.current = false }, [])
  useEffect(() => {
    if (legal || routesOpen) { focusedStep.current = ''; return }
    if (busy) return
    const stepKey = `${siteId}:${mode}:${mode === 'recovery' ? `${recoveryStep}${tempShown ? 'temp' : ''}` : ''}:${twoFactor ? twoFactor.backup ? 'backup' : 'code' : ''}`
    if (focusedStep.current === stepKey) return
    const id = twoFactor ? 'login-2fa-code' : mode === 'login' ? identifier.trim() ? 'login-password' : 'login-account' : mode === 'register' ? 'register-email' : recoveryStep === 1 ? 'forgot-email' : recoveryStep === 2 ? 'forgot-token' : tempShown ? 'forgot-new-password' : 'forgot-set-password'
    const frame = window.requestAnimationFrame(() => {
      const input = document.getElementById(id)
      if (input instanceof HTMLInputElement && !input.disabled) { input.focus(); focusedStep.current = stepKey }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [siteId, mode, recoveryStep, tempShown, legal, routesOpen, busy, identifier, twoFactor])
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
    let timer: number | undefined
    setStatusError(''); setStatusRetrying(false); setStatusOffline(false); setStatus(null)
    // Turnstile and the site name differ per account source, so the snapshot must follow siteId.
    // Registration is main-account only (the flow pins siteId there), so its flags stay correct.
    function attempt(retried: boolean) {
      void api.getStatus(siteId).then((value) => { if (active) { setStatusRetrying(false); setStatus(value) } }, (reason: unknown) => {
        if (!active) return
        const failure = registrationStatusFailure(reason, navigator.onLine)
        if (failure.retry && !retried) { setStatusRetrying(true); timer = window.setTimeout(() => attempt(true), statusRetryDelayMs); return }
        setStatusRetrying(false); setStatusOffline(failure.offline); setStatusError(failure.message)
      })
    }
    attempt(false)
    return () => { active = false; window.clearTimeout(timer) }
  }, [api, siteId, statusRevision])
  // 没网时不叫客户去点「重新读取」：系统报网络回来了就自己重读。
  useEffect(() => {
    if (!statusOffline) return
    function reload() { setStatusRevision((value) => value + 1) }
    window.addEventListener('online', reload)
    return () => window.removeEventListener('online', reload)
  }, [statusOffline])
  // 登录、注册这些是客户自己点的，网络回来了不替他再点一次，只把「没连上网」换成一句提示。
  const offlineFailure = failure?.kind === 'offline' && !failure.reconnected
  useEffect(() => {
    if (!offlineFailure) return
    function reconnected() {
      setFailure((current) => current?.kind === 'offline' ? { ...current, reconnected: true } : current)
      setError((current) => current === authOfflineMessage ? '' : current)
      setMessage('网络回来了，点下面的「再试一次」就行。')
    }
    window.addEventListener('online', reconnected)
    return () => window.removeEventListener('online', reconnected)
  }, [offlineFailure])
  useEffect(() => {
    if (mode !== 'login') return
    let active = true
    const owner = epoch.capture()
    void api.getRemembered(siteId).then((value) => { if (active && owner() && !loginTouched.current && value) { setIdentifier(value.identifier); setPassword(value.password); setRemember(true) } }, () => undefined)
    return () => { active = false }
  }, [api, siteId, mode])

  const leaveTwoFactor = () => {
    setTwoFactor(null); setTwoFactorCode(''); twoFactorLogin.current = null
  }
  const clearRecoveredPassword = () => {
    setNewPassword(''); setTempShown(false); setChosen({ password: '', confirm: '' }); setChosenErrors({}); setRecovered(null); setReveal(false); setCopyFallback(false)
  }

  const changeSource = (value: string) => {
    if (locked.current || (value !== 'solov' && value !== 'solov-api') || value === siteId) return
    epoch.invalidate()
    setSiteId(value); setPassword(''); setRemember(false); setError(''); setMessage(''); setFailure(null); setBrowserAuthentication(false); leaveTwoFactor()
    setRecoveryStep(1); setRecoveryText(''); clearRecoveredPassword()
    loginTouched.current = false
  }

  const openHistorySource = () => {
    if (locked.current) return
    setSourceOpen(true); changeSource('solov-api')
  }

  const changeMode = (next: AuthMode, nextIdentifier?: string) => {
    if (locked.current) return
    epoch.invalidate()
    setMode(next); setError(''); setMessage(''); setFailure(null); setBrowserAuthentication(false); setFieldErrors({}); leaveTwoFactor(); clearRecoveredPassword()
    if (next === 'register') { setSiteId('solov'); setPassword(''); setRemember(false) }
    if (nextIdentifier !== undefined) { setIdentifier(nextIdentifier); setPassword(''); loginTouched.current = true }
    if (next === 'recovery') { setRecoveryStep(1); if (isEmail(identifier)) setRecoveryEmail(identifier) }
  }
  const close = () => {
    if (locked.current) { setMessage('正在处理，请稍候'); return }
    if (recovered) { continueWithTempPassword(); return }
    epoch.invalidate(); setPassword(''); clearRecoveredPassword(); leaveTwoFactor(); onClose()
  }
  const showFailure = (reason: unknown, action: string) => {
    const result = authFailure(reason, action, navigator.onLine)
    setError(result.message); setFailure({ action, kind: result.kind, message: result.message }); setBrowserAuthentication(requiresBrowserAuthentication(reason))
  }
  const run = async (action: string, work: (isCurrent: () => boolean) => Promise<void>) => {
    if (locked.current) return
    const current = epoch.capture()
    locked.current = true; setBusy(true); setError(''); setMessage(''); setFailure(null)
    try { await work(current) } catch (reason) { if (current()) showFailure(reason, action) }
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
  const finishLogin = async (result: AccountLoginResult, login: LoginAttempt, current: () => boolean) => {
    let password = login.password
    let notice = login.notice ?? `欢迎回来，${result.account.username}`
    if (login.newPassword) {
      // 这时已经用临时密码登上了。改失败就把临时密码亮出来：账号此刻认的就是它，客户不会被锁在外面。
      try { await api.changePassword({ originalPassword: login.password, newPassword: login.newPassword }) }
      catch (reason) {
        if (current()) {
          leaveTwoFactor(); setRecovered(result); setTempShown(true); setReveal(false)
          setMessage('新密码没设上，你已经用下面这个临时密码登录了。先复制存好，再点「继续」进软件；以后可以在「个人中心 › 账号安全」里改密码。')
          setError(authErrorMessage(reason, '设新密码'))
        }
        return
      }
      password = login.newPassword
      notice = '密码已重设，已自动登录'
    }
    let rememberError: string | undefined
    // 没法安全保存时，本机以前记住的那份密码读不到也写不进，但别顺手把它删了：
    // 系统密码保管恢复以后它还能用。
    if (!sessionOnly) {
      try { await api.setRemembered(login.remember ? { identifier: login.username, password } : null, login.siteId) }
      catch { rememberError = '已登录，但记住密码的设置没有保存成功' }
    }
    if (current()) { setPassword(''); leaveTwoFactor(); clearRecoveredPassword(); onAuthenticated(result, { rememberError, notice }) }
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
        // 找回密码那条路上临时密码还在，退回「设新密码」重点一次即可。
        if (isTwoFactorExpired(reason) && current()) { leaveTwoFactor(); if (mode === 'login') setPassword(''); focusedStep.current = '' }
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
    void run('发送验证码', async (current) => { await api.sendVerification(email); if (current()) { registerCooldown.start(); setCodeSent(true); setMessage(`验证码已发到 ${email}。几分钟内没收到的话，看看垃圾邮件。`) } })
  }
  const submitRegistration = () => {
    if (!status) { setError('注册还没准备好，请稍等，或点「重新读取」后再注册'); return }
    if (!status.registerEnabled || !status.passwordRegisterEnabled) { setError('目前暂未开放账号注册'); return }
    if (status.turnstileCheckEnabled) { setError('服务端需要安全验证，请在浏览器完成注册'); return }
    const draft = { ...registration, email: checkEmail() }
    const errors = validateRegistration(draft, status.emailVerificationEnabled, codeSent)
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
          showFailure(reason, '自动登录')
        }
        return
      }
      if (current()) { setRegistration((previous) => ({ ...previous, password: '', confirm: '', code: '' })); onAuthenticated(result, { notice: '注册成功，已自动登录' }) }
    })
  }
  const sendReset = () => {
    if (!source.supportsPasswordReset) return
    if (!isEmail(recoveryEmail)) { setError('请填写注册时用的邮箱'); return }
    if (resetCooldown.seconds) return
    void run('发送重置邮件', async (current) => {
      await api.sendReset(recoveryEmail.trim(), siteId)
      if (current()) { resetCooldown.start(); setRecoveryStep(2); setMessage('如果这个邮箱注册过，几分钟内会收到重置邮件。没收到的话，看看垃圾邮件。') }
    })
  }
  const submitReset = () => {
    if (!source.supportsPasswordReset) return
    if (!isEmail(recoveryEmail)) { setError('请先填写有效的注册邮箱'); return }
    const parsed = parseRecoveryCode(recoveryText, source.website)
    if (!parsed.ok) { setError(parsed.error); return }
    void run('重置密码', async (current) => {
      const result = await api.reset({ email: recoveryEmail.trim(), token: parsed.token }, siteId)
      if (current()) { clearRecoveredPassword(); setNewPassword(result.newPassword); setRecoveryStep(3); setRecoveryText('') }
    })
  }
  const showTempPassword = () => {
    if (locked.current) return
    setTempShown(true); setError(''); setChosenErrors({}); setMessage('用临时密码登录后，记得在「账号安全」里改成自己的密码。')
  }
  const updateChosen = (key: 'password' | 'confirm', value: string) => {
    setChosen((draft) => ({ ...draft, [key]: value }))
    setChosenErrors((errors) => ({ ...errors, [key]: undefined }))
  }
  const submitNewPassword = () => {
    if (!source.supportsPasswordReset || !newPassword || tempShown) return
    const errors = validateNewPassword(chosen.password, chosen.confirm)
    setChosenErrors(errors)
    if (Object.keys(errors).length) return
    const attempt: LoginAttempt = { username: recoveryEmail.trim(), password: newPassword, siteId, remember, newPassword: chosen.password }
    void run('设新密码', async (current) => {
      let result: AccountLoginResult
      try { result = await api.login({ username: attempt.username, password: attempt.password, siteId: attempt.siteId }) }
      catch (reason) {
        if (isTwoFactorChallenge(reason) && attempt.siteId === 'solov') {
          if (current()) { twoFactorLogin.current = attempt; setTwoFactorCode(''); setTwoFactor({ backup: false }) }
          return
        }
        // 连登录都没成：密码还是那串临时的，亮出来让客户照老办法去登录。
        if (current()) { setTempShown(true); setReveal(false); setMessage('新密码没设上，你的账号现在用的是下面这个临时密码。复制它去登录，登录后可以在「个人中心 › 账号安全」里再改。') }
        throw reason
      }
      if (current()) await finishLogin(result, attempt, current)
    })
  }
  const tempLoginNotice = '已用临时密码登录，记得改成自己的密码'
  const continueWithTempPassword = () => {
    const result = recovered
    if (!result) return
    void run('登录', async (current) => { await finishLogin(result, { username: recoveryEmail.trim(), password: newPassword, siteId, remember, notice: tempLoginNotice }, current) })
  }
  // 「先不设」之后直接拿临时密码登录，省掉回登录框再填一遍。没登上就照原来「前往登录」那样退回登录框，
  // 账号和临时密码都替他填好（临时密码这时还没人记下来，清掉就找不回了），红字和出口跟着过去。
  const loginWithTempPassword = () => {
    if (!source.supportsPasswordReset || !newPassword || !tempShown || recovered) return
    const attempt: LoginAttempt = { username: recoveryEmail.trim(), password: newPassword, siteId, remember, notice: tempLoginNotice }
    void run('登录', async (current) => {
      let result: AccountLoginResult
      try { result = await api.login({ username: attempt.username, password: attempt.password, siteId: attempt.siteId }) }
      catch (reason) {
        if (isTwoFactorChallenge(reason) && attempt.siteId === 'solov') {
          if (current()) { twoFactorLogin.current = attempt; setTwoFactorCode(''); setTwoFactor({ backup: false }) }
          return
        }
        if (current()) {
          setMode('login'); setIdentifier(attempt.username); setPassword(attempt.password); loginTouched.current = true
          setRecoveryStep(1); setRecoveryText(''); clearRecoveredPassword()
        }
        throw reason
      }
      if (current()) await finishLogin(result, attempt, current)
    })
  }
  // 两步验证这一步右上角的 × 是「返回」：回到输密码（或找回密码第 3 步），不关整个框。
  const leaveTwoFactorStep = () => {
    if (locked.current) return
    leaveTwoFactor(); if (mode === 'login') setPassword(''); setError(''); setMessage('')
  }
  const copyPassword = () => void run('复制新密码', async (current) => {
    try { await api.copyPassword(newPassword); if (current()) setMessage('临时密码已复制，1 分钟后会从剪贴板里清掉，请尽快粘贴') }
    catch { if (current()) { setCopyFallback(true); setReveal(true); setError('无法访问剪贴板，请选中临时密码后手动复制'); window.setTimeout(() => { const input = document.getElementById('forgot-new-password'); if (input instanceof HTMLInputElement) { input.focus(); input.select() } }, 0) } }
  })
  const openAccountWebsite = () => void run('打开账号官网', async () => {
    if (!await api.openExternal(source.website)) throw new Error('Open external failed')
  })

  const retryFailure = (action: RetryableAction) => {
    if (action === '登录') submitLogin()
    else if (action === '发送验证码') sendVerification()
    else if (action === '创建账号') submitRegistration()
    else if (action === '发送重置邮件') sendReset()
    else submitReset()
  }
  const goRecovery = (email: string) => {
    changeMode('recovery')
    if (isEmail(email)) setRecoveryEmail(email)
  }
  // 红字一出现，下面就给能点的出口；客户改了输入、换了一步或又出了别的提示，出口跟着红字一起消失。
  const exitsVisible = Boolean(failure && (failure.reconnected ? !error : error === failure.message))
  // 账号或密码不对时「找回密码」跟在红字后面，是那一行里的链接；其余出口在红字下面一排。
  const forgotInline = Boolean(failure && exitsVisible && failure.kind === 'credentials' && mode === 'login' && !twoFactor && source.supportsPasswordReset)
  const exitButtons = failure && exitsVisible ? [
    ['offline', 'unreachable', 'network', 'unknown'].includes(failure.kind) && isRetryableAction(failure.action) && <Button key="retry" size="xs" icon={RefreshCw} disabled={busy} onClick={() => { if (isRetryableAction(failure.action)) retryFailure(failure.action) }} testId="auth-exit-retry">再试一次</Button>,
    failure.kind === 'credentials' && mode === 'login' && !twoFactor && <Button key="register" size="xs" icon={UserPlus} disabled={busy} onClick={() => changeMode('register')} testId="auth-exit-register">还没有账号，去注册</Button>,
    failure.kind === 'code' && mode === 'register' && status?.emailVerificationEnabled && <Button key="code" size="xs" icon={Mail} disabled={busy || Boolean(registerCooldown.seconds)} onClick={sendVerification} testId="auth-exit-code">{registerCooldown.seconds ? `${registerCooldown.seconds} 秒后重新获取` : '重新获取验证码'}</Button>,
    failure.kind === 'taken' && mode === 'register' && <Button key="login" size="xs" icon={LogIn} disabled={busy} onClick={() => changeMode('login', normalizeEmail(registration.email))} testId="auth-exit-login">用这个邮箱去登录</Button>,
    failure.kind === 'taken' && mode === 'register' && <Button key="forgot" size="xs" icon={KeyRound} disabled={busy} onClick={() => goRecovery(normalizeEmail(registration.email))} testId="auth-exit-forgot">找回密码</Button>,
    onHelp && <Button key="help" size="xs" variant="ghost" icon={Headset} disabled={busy} onClick={onHelp} testId="auth-exit-help">找客服</Button>,
  ].filter(Boolean) : []

  if (legal) return <LegalDocument api={api} kind={legal} onClose={() => setLegal(null)} />
  if (routesOpen && connectionSettings) return <Dialog key="connection-routes" open title="切换连接线路" subtitle="返回后可继续填写；新线路要重启星芒才生效。" width={640} onClose={() => setRoutesOpen(false)} busy={routesBusy} testId="auth-connection-routes" footer={<Button disabled={routesBusy} onClick={() => setRoutesOpen(false)} testId="auth-connection-back">返回继续填写</Button>}>
    {connectionSettings(setRoutesBusy)}
  </Dialog>
  function link(label: string, testId: string, onClick: () => void, disabled = busy) {
    return <button type="button" className="auth-link" disabled={disabled} onClick={onClick} data-testid={testId}>{label}</button>
  }
  const agreement = (checked: boolean, onChange: (checked: boolean) => void) => <div className="auth-agreement"><label><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} data-testid="auth-agree" disabled={busy} />我已阅读并同意</label>{link('《用户协议》', 'auth-terms', () => setLegal('user-agreement'))}和{link('《隐私政策》', 'auth-privacy', () => setLegal('privacy-policy'))}</div>
  const rememberBox = (testId: string) => <label className="auth-checkbox"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy} data-testid={testId} />记住密码</label>
  const emailSuggestion = emailChecked ? suggestEmailCorrection(registration.email) : null
  const field = (label: string, id: string, value: string, onChange: (value: string) => void, { optional, ...options }: { type?: string; autoComplete?: string; placeholder?: string; error?: string; password?: boolean; maxLength?: number; mono?: boolean; addon?: ReactNode; optional?: boolean; onBlur?: (event: FocusEvent<HTMLInputElement>) => void } = {}) => <div className="auth-field" key={id}><Input id={id} label={optional ? <>{label}<span className="auth-field-optional">选填</span></> : label} testId={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={busy} aria-label={label} {...options} /></div>
  const recoveryResetStep = mode === 'recovery' && source.supportsPasswordReset
  // 底部那排：主按钮通栏，下面一行是「去注册 / 回去登录 / 历史账号 / 切换连接线路」这些去别处的链接。
  const primary = twoFactor ? <Button variant="primary" loading={busy} onClick={submitTwoFactor} testId="login-2fa-submit">{busy ? '正在登录…' : '登录'}</Button>
    : mode === 'login' ? <Button variant="primary" loading={busy} onClick={submitLogin} testId="login-submit">{busy ? '正在登录…' : '登录'}</Button>
      : mode === 'register' ? <Button variant="primary" loading={busy} disabled={!status || !status.registerEnabled || !status.passwordRegisterEnabled} onClick={submitRegistration} testId="register-submit">{busy ? '正在注册…' : '注册并登录'}</Button>
        : !source.supportsPasswordReset ? <Button variant="primary" icon={ExternalLink} loading={busy} onClick={openAccountWebsite} testId="forgot-open-website">前往历史账号官网</Button>
          : recoveryStep === 1 ? <Button variant="primary" loading={busy} disabled={Boolean(resetCooldown.seconds)} onClick={sendReset} testId="forgot-send">{resetCooldown.seconds ? `${resetCooldown.seconds} 秒后重发` : '发送重置邮件'}</Button>
            : recoveryStep === 2 ? <Button variant="primary" loading={busy} onClick={submitReset} testId="forgot-reset">下一步</Button>
              : !tempShown ? <Button variant="primary" loading={busy} onClick={submitNewPassword} testId="forgot-set-submit">{busy ? '正在登录…' : '设好并登录'}</Button>
                : recovered ? <Button variant="primary" icon={ArrowRight} loading={busy} onClick={continueWithTempPassword} testId="forgot-continue">继续</Button>
                  : <Button variant="primary" loading={busy} onClick={loginWithTempPassword} testId="forgot-finish">{busy ? '正在登录…' : '用临时密码登录'}</Button>
  const switchSource = !sourceVisible && (mode === 'login' || (mode === 'recovery' && recoveryStep === 1))
  const routesLink = Boolean(connectionSettings) && !(mode === 'recovery' && recoveryStep === 3)
  const alternatives = twoFactor ? [link(twoFactor.backup ? '用验证器里的数字' : '手机不在身边？用备用码登录', 'login-2fa-switch', switchTwoFactorInput)]
    : [
      mode === 'login' && siteId === 'solov' && <span key="register">还没有账号？{link('注册新账号', 'login-register', () => changeMode('register'))}</span>,
      mode === 'register' && <span key="login">已经有账号？{link('去登录', 'register-login', () => changeMode('login'))}</span>,
      // 第 3 步离开前临时密码还没给客户看过，回登录框会把人锁在外面；那一步的出口是「先不设」。
      mode === 'recovery' && (!source.supportsPasswordReset || recoveryStep < 3) && <span key="back">想起来了？{link('回去登录', 'forgot-back-login', () => changeMode('login', recoveryEmail.trim()))}</span>,
      recoveryResetStep && recoveryStep === 3 && !tempShown && <span key="temp">{link('先不设，用系统给的临时密码', 'forgot-use-temp', showTempPassword)}</span>,
      switchSource && <span key="source">{link(mode === 'login' ? '用历史账号登录' : '找回历史账号的密码', 'auth-source-expand', openHistorySource)}</span>,
      routesLink && <span key="routes">{link('切换连接线路', 'auth-connection-settings', () => setRoutesOpen(true))}</span>,
    ].filter(Boolean)
  const footer = <div className="auth-foot">{primary}{alternatives.length > 0 && <div className="auth-alt">{alternatives}</div>}</div>
  // 关框前要不要先问一句：只看客户亲手填的东西。记住密码自动带出来的那份不算，关了下次还在；
  // 两步验证那一步的 × 是「返回」，不丢东西。
  const dirty = !twoFactor && Boolean((password && (mode !== 'login' || loginTouched.current)) || registration.password || recoveryText || (mode === 'recovery' && newPassword && !tempShown))
  // 原来底部「取消」「返回」的 test id 挪到 × 上，跟着它的意思走。
  const closeTestId = twoFactor ? 'login-2fa-back' : mode === 'login' ? 'login-cancel' : mode === 'register' ? 'register-cancel' : undefined
  const title = twoFactor ? '两步验证' : mode === 'login' ? `登录${source.label}` : mode === 'register' ? '注册星芒账号' : `找回${source.label}密码`
  return <Dialog open title={title} width={480} onClose={twoFactor ? leaveTwoFactorStep : close} closeTestId={closeTestId} busy={busy} dirty={dirty} testId={`${mode === 'recovery' ? 'forgot-password' : mode}-dialog`} footer={footer}>
    <div className="auth-form" aria-busy={busy} data-busy={busy} onKeyDown={(event) => { if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.target instanceof HTMLButtonElement || event.target instanceof HTMLTextAreaElement || busy) return; event.preventDefault(); if (twoFactor) submitTwoFactor(); else if (mode === 'login') submitLogin(); else if (mode === 'register') submitRegistration(); else if (recoveryStep === 1) sendReset(); else if (recoveryStep === 2) submitReset(); else if (!tempShown) submitNewPassword() }}>
      {notice}
      {mode !== 'register' && sourceVisible && !twoFactor && !(mode === 'recovery' && recoveryStep === 3) && <div className="auth-source"><span className="auth-source-label">账号来源</span><Segment label="账号来源" value={siteId} onChange={changeSource} testId="auth-source" options={Object.entries(accountSources).map(([value, entry]) => ({ value, label: entry.label, disabled: busy }))} /></div>}
      {twoFactor && <>
        <p className="auth-lead" data-testid="login-2fa-hint">{twoFactor.backup ? '输入一个没用过的备用码。' : '打开手机上的验证器，输入星芒账号那一行的 6 位数字。'}</p>
        {field(twoFactor.backup ? '备用码' : '验证码', 'login-2fa-code', twoFactorCode, setTwoFactorCode, { autoComplete: twoFactor.backup ? 'off' : 'one-time-code', placeholder: twoFactor.backup ? '备用码' : '6 位数字', maxLength: 64, mono: true })}
      </>}
      {mode === 'login' && !twoFactor && <>
        {field(siteId === 'solov-api' ? '注册邮箱' : '用户名或邮箱', 'login-account', identifier, (value) => { loginTouched.current = true; setIdentifier(value) }, { autoComplete: 'username', placeholder: siteId === 'solov-api' ? '输入历史账号的注册邮箱' : '注册时填的用户名或邮箱' })}
        {field('密码', 'login-password', password, (value) => { loginTouched.current = true; setPassword(value) }, { password: true, autoComplete: 'current-password', placeholder: '输入密码' })}
        <div className="auth-remember-row">{sessionOnly ? <p className="auth-hint" data-testid="login-session-only">{sessionOnlyLoginNotice}</p> : rememberBox('login-remember')}{link('找回密码', 'login-forgot', () => changeMode('recovery'))}</div>
        {agreement(agreed, setAgreed)}
      </>}
      {mode === 'register' && <>
        {statusError && <div className="auth-status-error" role="alert"><p className="auth-error" data-testid="register-status-error"><CircleAlert size={15} aria-hidden="true" /><span>{statusError}</span></p><Button size="sm" icon={RefreshCw} onClick={() => setStatusRevision((value) => value + 1)} testId="register-status-retry">重新读取</Button></div>}
        {!status && !statusError && <p className="auth-hint" role="status" data-testid="register-status-loading">{statusRetrying ? '网络有点慢，正在再试一次…' : '正在准备注册…'}</p>}
        {status && (!status.registerEnabled || !status.passwordRegisterEnabled) && <p className="auth-error" role="alert"><CircleAlert size={15} aria-hidden="true" /><span>目前暂未开放账号注册</span></p>}
        {field('邮箱', 'register-email', registration.email, updateEmail, { type: 'email', autoComplete: 'email', placeholder: '常用邮箱（如 QQ 邮箱）', error: fieldErrors.email, onBlur: checkEmailOnLeave, addon: status?.emailVerificationEnabled ? <Button size="xs" onClick={sendVerification} disabled={busy || Boolean(registerCooldown.seconds)} testId="register-send-code">{registerCooldown.seconds ? `${registerCooldown.seconds} 秒后重发` : '获取验证码'}</Button> : undefined })}
        {emailSuggestion && <p className="auth-typo" role="status" data-testid="register-email-suggestion">你是不是想填 <b>{emailSuggestion}</b>？{link('改成这个', 'register-email-fix', () => updateEmail(emailSuggestion, true))}{typoConfirmedEmail === normalizeEmail(registration.email) && ` 没填错的话，再点一次「${status?.emailVerificationEnabled ? '获取验证码' : '注册并登录'}」。`}</p>}
        <div className="auth-two-fields">{status?.emailVerificationEnabled && field('验证码', 'register-code', registration.code, (value) => updateRegistration('code', value), { autoComplete: 'one-time-code', placeholder: '邮件里的 6 位数字', mono: true, error: fieldErrors.code })}{field('用户名', 'register-user', registration.username, updateUsername, { autoComplete: 'username', placeholder: '最多 20 位', error: fieldErrors.username, maxLength: 20 })}</div>
        <div className="auth-two-fields">{field('密码', 'register-password', registration.password, (value) => updateRegistration('password', value), { password: true, autoComplete: 'new-password', placeholder: '8 至 20 位', maxLength: 20, error: fieldErrors.password })}{field('确认密码', 'register-password-confirm', registration.confirm, (value) => updateRegistration('confirm', value), { password: true, autoComplete: 'new-password', placeholder: '再输一次', maxLength: 20, error: fieldErrors.confirm })}</div>
        {inviteOpen ? field('邀请码', 'register-invite', registration.invite, (value) => updateRegistration('invite', value), { placeholder: '邀请码或邀请链接', error: fieldErrors.invite, optional: true })
          : <div className="auth-more">{link('有邀请码？', 'register-invite-toggle', () => { setInviteOpen(true); setFocusTarget('register-invite') })}</div>}
        {agreement(registration.agreed, (value) => updateRegistration('agreed', value))}{fieldErrors.agreed && <p role="alert" className="auth-field-error">{fieldErrors.agreed}</p>}
        {/* 按钮灰着却不说为什么，客户只会一遍遍去点。 */}
        {!status && <p className="auth-hint" data-testid="register-submit-hint">{statusError ? '要先连上账号服务，「注册并登录」才能点。' : '准备好之后就能点「注册并登录」。'}</p>}
      </>}
      {mode === 'recovery' && !source.supportsPasswordReset && <p className="auth-note" data-testid="forgot-official-help"><Info size={15} aria-hidden="true" /><span>历史账号暂不支持在客户端重置密码。请前往历史账号官网使用找回入口；官网没有找回入口的话，请联系官网客服恢复访问。</span></p>}
      {recoveryResetStep && !twoFactor && <>
        <ol className="auth-stepper" aria-label="找回密码进度">{['获取邮件', '粘贴重置码', '设新密码'].map((text, index) => <li key={text} aria-current={recoveryStep === index + 1 ? 'step' : undefined} data-completed={index + 1 < recoveryStep}><i aria-hidden="true" /><span>{text}</span></li>)}</ol>
        {recoveryStep === 1 && <><p className="auth-lead">填写注册时用的邮箱，我们会发一封带重置码的邮件。</p>{field('注册邮箱', 'forgot-email', recoveryEmail, setRecoveryEmail, { type: 'email', autoComplete: 'email', placeholder: 'name@example.com' })}</>}
        {recoveryStep === 2 && <>{field('重置码或邮件链接', 'forgot-token', recoveryText, setRecoveryText, { placeholder: '把邮件里的重置码或整条链接粘贴过来', autoComplete: 'off', mono: true })}<div className="auth-link-row">{link('修改邮箱', 'forgot-change-email', () => { setRecoveryStep(1); setError('') })}{link(resetCooldown.seconds ? `${resetCooldown.seconds} 秒后重发` : '重新发送', 'forgot-resend', sendReset, busy || Boolean(resetCooldown.seconds))}</div></>}
        {recoveryStep === 3 && !tempShown && <>
          {field('新密码', 'forgot-set-password', chosen.password, (value) => updateChosen('password', value), { password: true, autoComplete: 'new-password', placeholder: '8 至 20 位', maxLength: 20, error: chosenErrors.password })}
          {field('再输一次', 'forgot-set-confirm', chosen.confirm, (value) => updateChosen('confirm', value), { password: true, autoComplete: 'new-password', placeholder: '和上面一样', maxLength: 20, error: chosenErrors.confirm })}
          {sessionOnly ? <p className="auth-hint" data-testid="forgot-session-only">{sessionOnlyLoginNotice}</p> : rememberBox('forgot-remember')}
        </>}
        {recoveryStep === 3 && tempShown && <><div className="auth-temp-password"><label htmlFor="forgot-new-password">临时密码</label><Input id="forgot-new-password" testId="forgot-new-password" readOnly type={reveal ? 'text' : 'password'} value={newPassword} aria-label="临时密码" mono /><Button variant="ghost" size="xs" icon={reveal ? EyeOff : Eye} onClick={() => setReveal(!reveal)} testId="forgot-show-password">{reveal ? '隐藏' : '显示'}</Button><Button variant="ghost" size="xs" icon={Copy} onClick={copyPassword} disabled={busy} testId="forgot-copy-password">复制</Button></div>{copyFallback && <p className="auth-hint">选中临时密码后使用系统复制操作，再返回登录。</p>}</>}
      </>}
      {message && <p className="auth-message" role="status" data-testid="auth-message"><Info size={15} aria-hidden="true" /><span>{message}</span></p>}
      {error && <p className="auth-error" role="alert" data-testid="auth-error"><CircleAlert size={15} aria-hidden="true" /><span>{error}{forgotInline && <>{' '}{link('找回密码', 'auth-exit-forgot', () => goRecovery(identifier.trim()))}</>}</span></p>}
      {exitButtons.length > 0 && <div className="auth-form-actions auth-exits" data-testid="auth-exits">{exitButtons}</div>}
      {browserAuthentication && <Button variant="ghost" icon={ExternalLink} onClick={openAccountWebsite} disabled={busy} testId="auth-open-website">前往{source.label}官网</Button>}
      {mode !== 'recovery' && status?.turnstileCheckEnabled && onHelp && !exitsVisible && <Button variant="ghost" onClick={onHelp} testId="auth-verification-help">打开帮助</Button>}
    </div>
  </Dialog>
}
