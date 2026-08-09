import { useState, type FormEvent } from 'react'
import { Eye, EyeOff, UserPlus, X } from 'lucide-react'
import { dialogAriaProps, DialogBackdrop } from '../Dialog'
import { validateEmail, validateRegisterForm, type AccountFieldErrors } from './validation'

/**
 * Register form skeleton. Email + password only (docs/RECON-new-api.md: it is
 * the only enabled registration method on xm.solov.cc today — WeChat/GitHub/
 * phone toggles are all off). "获取验证码" and the submit button are both
 * stubs: neither calls window.xingmang.registerAccount or any other real
 * channel this wave (docs/OVERNIGHT-PLAN.md W4) — the parent shows a
 * "即将开放" toast instead.
 */
export function RegisterDialog({
  onClose,
  onSwitchToLogin,
  onSubmit,
  onRequestVerificationCode,
}: {
  onClose: () => void
  onSwitchToLogin: () => void
  onSubmit: () => void
  onRequestVerificationCode: () => void
}) {
  const [email, setEmail] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<AccountFieldErrors>({})

  const clearError = (field: keyof AccountFieldErrors) => {
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current))
  }

  const requestCode = () => {
    const emailError = validateEmail(email)
    if (emailError) {
      setErrors((current) => ({ ...current, email: emailError }))
      return
    }
    onRequestVerificationCode()
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const nextErrors = validateRegisterForm({ email, password, verificationCode })
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) return
    onSubmit()
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
              <small>邮箱注册 · 约 1 分钟</small>
            </div>
          </div>
          <button className="icon-button compact" type="button" title="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="extension-dialog-body">
          <label className="field extension-field">
            <span>邮箱</span>
            <input
              type="email"
              value={email}
              onChange={(event) => { setEmail(event.target.value); clearError('email') }}
              placeholder="you@example.com"
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
              <button type="button" className="secondary-button account-code-button" onClick={requestCode}>
                获取验证码
              </button>
            </div>
            {errors.verificationCode && <small className="field-error" role="alert">{errors.verificationCode}</small>}
          </label>

          <label className="field extension-field">
            <span>密码</span>
            <div className="input-with-action">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => { setPassword(event.target.value); clearError('password') }}
                placeholder="至少 8 位"
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

          <p className="account-dialog-switch">
            已有账号？
            <button type="button" onClick={onSwitchToLogin}>去登录</button>
          </p>
        </div>

        <footer className="extension-dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="primary-button" type="submit">注册</button>
        </footer>
      </form>
    </DialogBackdrop>
  )
}
