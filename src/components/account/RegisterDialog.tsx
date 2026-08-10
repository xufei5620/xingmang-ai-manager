import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { Eye, EyeOff, UserPlus, X } from 'lucide-react'
import { dialogAriaProps, DialogBackdrop } from '../Dialog'
import { privacyPolicyUrl, userAgreementUrl } from '../../types'
import { validateEmail, validateRegisterForm, type AccountFieldErrors } from './validation'

// Server-side throttle is 2 sends per 30s per IP (see
// electron/new-api-client.ts's sendEmailVerification); a 60s client-side
// cooldown gives a comfortable margin instead of racing that window exactly.
const VERIFICATION_CODE_COOLDOWN_SECONDS = 60

/**
 * Register form. Field order mirrors xm.solov.cc's own registration page:
 * username, password, confirm password, email, verification code, terms
 * agreement, then the submit button -- collecting a real username instead
 * of defaulting it to the email address, which is what caused the
 * "Username already exists" failures this dialog was refactored to fix
 * (new-api enforces uniqueness on username independently of email; see
 * electron/new-api-client.ts's NewApiRegisterInput comment). Submitting
 * calls the parent's onSubmit with the validated {username, email, password,
 * verificationCode}; the parent (App.tsx) makes the real
 * window.xingmang.registerAccount call.
 *
 * "获取验证码" calls the parent's onRequestVerificationCode(email), which
 * wraps the real window.xingmang.sendVerificationCode IPC call and owns the
 * success/failure toast (same division of labor as onSubmit/handleAccount-
 * RegisterSubmit in App.tsx). This component only owns the button's own
 * local cooldown countdown and the synchronous double-click guard
 * (sendingRef) -- the parent's call never throws, so the ref is released
 * unconditionally in .finally().
 *
 * "用户协议"/"隐私政策" open the legal pages on the account domain via
 * openExternal (userAgreementUrl/privacyPolicyUrl in relay-sites.ts, both
 * I12-allowlisted in main.ts) -- 老板要求(2026-08-10)从原先的纯文本改为
 * 可点击。The links live inside the checkbox <label>, so their click
 * handler preventDefaults to keep the label from also toggling the box.
 */
export function RegisterDialog({
  onClose,
  onSwitchToLogin,
  onSubmit,
  onRequestVerificationCode,
  isSubmitting = false,
}: {
  onClose: () => void
  onSwitchToLogin: () => void
  onSubmit: (values: { username: string; email: string; password: string; verificationCode: string }) => void
  onRequestVerificationCode: (email: string) => Promise<void>
  isSubmitting?: boolean
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [email, setEmail] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [agreedToTerms, setAgreedToTerms] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<AccountFieldErrors>({})
  const [codeCooldown, setCodeCooldown] = useState(0)
  // Synchronous dedupe for a double click landing before React re-renders the
  // disabled button (T6) -- mirrors App.tsx's accountBusyRef for the same
  // reason: `codeCooldown` is only read fresh after a re-render, a plain ref
  // is not.
  const sendingCodeRef = useRef(false)

  useEffect(() => {
    if (codeCooldown <= 0) return undefined
    const timer = window.setInterval(() => {
      setCodeCooldown((current) => Math.max(0, current - 1))
    }, 1_000)
    return () => window.clearInterval(timer)
    // Deliberately keyed on the crossing (>0) rather than the exact number:
    // the interval's own functional setState decrements every second on its
    // own, so re-arming it on every intermediate value would just tear down
    // and recreate the same timer 60 times for no behavioral difference.
  }, [codeCooldown > 0])

  // Same preventDefault reasoning as LoginDialog's openLegalPage: the links
  // sit inside the agreement <label> and must not toggle its checkbox.
  const openLegalPage = (event: MouseEvent, url: string) => {
    event.preventDefault()
    event.stopPropagation()
    void window.xingmang.openExternal(url)
  }

  const clearError = (field: keyof AccountFieldErrors) => {
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current))
  }

  const requestCode = () => {
    const emailError = validateEmail(email)
    if (emailError) {
      setErrors((current) => ({ ...current, email: emailError }))
      return
    }
    if (sendingCodeRef.current || codeCooldown > 0) return
    sendingCodeRef.current = true
    setCodeCooldown(VERIFICATION_CODE_COOLDOWN_SECONDS)
    void onRequestVerificationCode(email.trim()).finally(() => {
      sendingCodeRef.current = false
    })
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (isSubmitting) return
    const nextErrors = validateRegisterForm({ username, email, password, confirmPassword, verificationCode, agreedToTerms })
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) return
    onSubmit({ username: username.trim(), email: email.trim(), password, verificationCode: verificationCode.trim() })
  }

  return (
    <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={onClose}>
      <form
        className="extension-dialog compact-dialog account-dialog"
        onSubmit={submit}
        {...dialogAriaProps('register-dialog-title')}
      >
        <header className="extension-dialog-head">
          <div>
            <span className="extension-dialog-icon"><UserPlus size={19} /></span>
            <div>
              <h2 id="register-dialog-title">注册星芒账号</h2>
              <small>邮箱验证 · 约 1 分钟</small>
            </div>
          </div>
          <button className="icon-button compact" type="button" title="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="extension-dialog-body">
          <label className="field extension-field">
            <span>用户名</span>
            <input
              value={username}
              onChange={(event) => { setUsername(event.target.value); clearError('username') }}
              placeholder="登录时使用的用户名"
              autoComplete="username"
            />
            {errors.username && <small className="field-error" role="alert">{errors.username}</small>}
          </label>

          <label className="field extension-field">
            <span>密码</span>
            <div className="input-with-action">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => { setPassword(event.target.value); clearError('password') }}
                placeholder="8-20 位"
                autoComplete="new-password"
              />
              <button
                type="button"
                title={showPassword ? '隐藏密码' : '显示密码'}
                onClick={() => setShowPassword((current) => !current)}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {errors.password && <small className="field-error" role="alert">{errors.password}</small>}
          </label>

          <label className="field extension-field">
            <span>确认密码</span>
            <div className="input-with-action">
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(event) => { setConfirmPassword(event.target.value); clearError('confirmPassword') }}
                placeholder="再次输入密码"
                autoComplete="new-password"
              />
              <button
                type="button"
                title={showPassword ? '隐藏密码' : '显示密码'}
                onClick={() => setShowPassword((current) => !current)}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {errors.confirmPassword && <small className="field-error" role="alert">{errors.confirmPassword}</small>}
          </label>

          <label className="field extension-field">
            <span>电子邮件</span>
            <input
              type="email"
              value={email}
              onChange={(event) => { setEmail(event.target.value); clearError('email') }}
              placeholder="you@qq.com"
              autoComplete="email"
            />
            {errors.email && <small className="field-error" role="alert">{errors.email}</small>}
          </label>

          <label className="field extension-field">
            <span>邮箱验证码</span>
            <div className="account-code-row">
              <input
                value={verificationCode}
                onChange={(event) => { setVerificationCode(event.target.value); clearError('verificationCode') }}
                placeholder="6 位验证码"
                autoComplete="one-time-code"
                inputMode="numeric"
              />
              <button
                type="button"
                className="secondary-button account-code-button"
                onClick={requestCode}
                disabled={codeCooldown > 0}
              >
                {codeCooldown > 0 ? `${codeCooldown} 秒后重试` : '获取验证码'}
              </button>
            </div>
            {errors.verificationCode && <small className="field-error" role="alert">{errors.verificationCode}</small>}
          </label>

          <label className="account-agreement">
            <input
              type="checkbox"
              checked={agreedToTerms}
              onChange={(event) => { setAgreedToTerms(event.target.checked); clearError('agreement') }}
            />
            <span>
              我已阅读并同意
              <button type="button" className="account-inline-link" onClick={(event) => openLegalPage(event, userAgreementUrl)}>用户协议</button>
              和
              <button type="button" className="account-inline-link" onClick={(event) => openLegalPage(event, privacyPolicyUrl)}>隐私政策</button>
            </span>
          </label>
          {errors.agreement && <small className="field-error" role="alert">{errors.agreement}</small>}

          <p className="account-dialog-switch">
            已有账号？
            <button type="button" onClick={onSwitchToLogin}>去登录</button>
          </p>
        </div>

        <footer className="extension-dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? '创建中…' : '创建账户'}
          </button>
        </footer>
      </form>
    </DialogBackdrop>
  )
}
