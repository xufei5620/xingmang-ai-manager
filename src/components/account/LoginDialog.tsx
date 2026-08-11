import { useState, type FormEvent, type MouseEvent } from 'react'
import { Eye, EyeOff, LogIn, X } from 'lucide-react'
import { dialogAriaProps, DialogBackdrop } from '../Dialog'
import type { LegalDocumentKind } from '../../types'
import { LegalDocumentDialog } from './LegalDocumentDialog'
import { validateAgreement, validateLoginForm, type AccountFieldErrors } from './validation'

/**
 * Login form. The identifier field accepts either a username or an email
 * address: new-api's Login handler matches it against both
 * (model.User.ValidateAndFill does `DB.Where("username = ? OR email = ?",
 * username, username)`), and the official web frontend labels the same
 * field "Username or Email" (web/src/features/auth/sign-in/components/
 * user-auth-form.tsx) -- confirmed by reading QuantumNous/new-api's own
 * source rather than assumed. Submitting calls the parent's onSubmit with
 * the validated {identifier, password, remember} once client-side
 * validation (including the terms-agreement checkbox, 老板要求 2026-08-10)
 * passes; the parent (App.tsx) performs the real
 * window.xingmang.loginAccount call (sending `identifier` as new-api's
 * `username` request field, whichever kind of value it holds), owns the
 * in-flight/error state passed back down as isSubmitting, and persists or
 * clears the "记住密码" credential based on `remember` -- only after the
 * login actually succeeded.
 *
 * initialIdentifier pre-fills the field -- used by App.tsx right after a
 * successful registration, so the user only has to type their password
 * again instead of retyping the username they just chose. It is reused the
 * same way after a successful password reset (see ForgotPasswordDialog and
 * App.tsx's handleForgotPasswordDone). initialPassword/initialRemember seed
 * from the safeStorage-backed "记住密码" store; App.tsx only mounts this
 * dialog once that read has settled, because these are useState initials
 * and a later arrival would never show.
 */
export function LoginDialog({
  onClose,
  onSwitchToRegister,
  onSubmit,
  onForgotPassword,
  initialIdentifier = '',
  initialPassword = '',
  initialRemember = false,
  isSubmitting = false,
}: {
  onClose: () => void
  onSwitchToRegister: () => void
  onSubmit: (values: { identifier: string; password: string; remember: boolean }) => void
  onForgotPassword: () => void
  initialIdentifier?: string
  initialPassword?: string
  initialRemember?: boolean
  isSubmitting?: boolean
}) {
  const [identifier, setIdentifier] = useState(initialIdentifier)
  const [password, setPassword] = useState(initialPassword)
  const [remember, setRemember] = useState(initialRemember)
  const [agreedToTerms, setAgreedToTerms] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<AccountFieldErrors>({})
  const [legalKind, setLegalKind] = useState<LegalDocumentKind | null>(null)

  const clearError = (field: keyof AccountFieldErrors) => {
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current))
  }

  // The legal links sit inside the agreement <label>: preventDefault stops
  // the label's default activation from also toggling the checkbox.
  const openLegalPage = (event: MouseEvent, kind: LegalDocumentKind) => {
    event.preventDefault()
    event.stopPropagation()
    setLegalKind(kind)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (isSubmitting) return
    const nextErrors = validateLoginForm({ identifier, password })
    const agreementError = validateAgreement(agreedToTerms)
    if (agreementError) nextErrors.agreement = agreementError
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) return
    onSubmit({ identifier: identifier.trim(), password, remember })
  }

  if (legalKind) {
    return <LegalDocumentDialog kind={legalKind} onClose={() => setLegalKind(null)} />
  }

  return (
    <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={onClose}>
      <form
        className="extension-dialog compact-dialog account-dialog"
        onSubmit={submit}
        {...dialogAriaProps('login-dialog-title')}
      >
        <header className="extension-dialog-head">
          <div>
            <span className="extension-dialog-icon"><LogIn size={19} /></span>
            <div>
              <h2 id="login-dialog-title">登录星芒账号</h2>
              <small>登录后可查看余额与充值</small>
            </div>
          </div>
          <button className="icon-button compact" type="button" title="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="extension-dialog-body">
          <label className="field extension-field">
            <span>用户名或邮箱</span>
            <input
              value={identifier}
              onChange={(event) => { setIdentifier(event.target.value); clearError('identifier') }}
              placeholder="用户名或 you@qq.com"
              autoComplete="username"
            />
            {errors.identifier && <small className="field-error" role="alert">{errors.identifier}</small>}
          </label>

          <label className="field extension-field">
            <span>密码</span>
            <div className="input-with-action">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => { setPassword(event.target.value); clearError('password') }}
                placeholder="请输入密码"
                autoComplete="current-password"
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

          <label className="account-agreement">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>记住密码</span>
          </label>

          <label className="account-agreement">
            <input
              type="checkbox"
              checked={agreedToTerms}
              onChange={(event) => { setAgreedToTerms(event.target.checked); clearError('agreement') }}
            />
            <span>
              我已阅读并同意
              <button type="button" className="account-inline-link" onClick={(event) => openLegalPage(event, 'user-agreement')}>用户协议</button>
              和
              <button type="button" className="account-inline-link" onClick={(event) => openLegalPage(event, 'privacy-policy')}>隐私政策</button>
            </span>
          </label>
          {errors.agreement && <small className="field-error" role="alert">{errors.agreement}</small>}

          <p className="account-dialog-switch">
            忘记密码？
            <button type="button" onClick={onForgotPassword}>找回密码</button>
          </p>

          <p className="account-dialog-switch">
            还没有账号？
            <button type="button" onClick={onSwitchToRegister}>去注册</button>
          </p>
        </div>

        <footer className="extension-dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? '登录中…' : '登录'}
          </button>
        </footer>
      </form>
    </DialogBackdrop>
  )
}
