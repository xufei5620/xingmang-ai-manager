import { useState, type FormEvent } from 'react'
import { Eye, EyeOff, LogIn, X } from 'lucide-react'
import { dialogAriaProps, DialogBackdrop } from '../Dialog'
import { validateLoginForm, type AccountFieldErrors } from './validation'

/**
 * Login form. Submitting calls the parent's onSubmit with the validated
 * {email, password} once client-side validation passes; the parent (App.tsx)
 * performs the real window.xingmang.loginAccount call and owns the
 * in-flight/error state, passed back down as isSubmitting.
 */
export function LoginDialog({
  onClose,
  onSwitchToRegister,
  onSubmit,
  isSubmitting = false,
}: {
  onClose: () => void
  onSwitchToRegister: () => void
  onSubmit: (values: { email: string; password: string }) => void
  isSubmitting?: boolean
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<AccountFieldErrors>({})

  const clearError = (field: keyof AccountFieldErrors) => {
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current))
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (isSubmitting) return
    const nextErrors = validateLoginForm({ email, password })
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) return
    onSubmit({ email: email.trim(), password })
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
