import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, ClipboardCopy, LockKeyhole, X } from 'lucide-react'
import { dialogAriaProps, DialogBackdrop } from '../Dialog'
import { validateEmail, validateForgotPasswordForm, type AccountFieldErrors } from './validation'

// Mirrors RegisterDialog's VERIFICATION_CODE_COOLDOWN_SECONDS -- same 60s
// client-side margin, this time over new-api's CriticalRateLimit throttle on
// GET /api/reset_password (see electron/new-api-client.ts's
// sendPasswordResetEmail comment).
const RESET_CODE_COOLDOWN_SECONDS = 60

/**
 * "忘记密码?" flow, opened from LoginDialog. Two endpoints are involved, and
 * this dialog's shape follows their real contract rather than the more
 * familiar "type your new password twice" pattern one might expect from the
 * feature's name:
 *
 * 1. GET /api/reset_password (sendPasswordResetEmail) -- always succeeds
 *    whether or not the address has an account (anti-enumeration by
 *    construction; see electron/new-api-client.ts's own comment). Triggered
 *    by the "发送重置邮件" button below, which only reveals the 重置码 field
 *    once the parent's onRequestResetCode call actually resolves -- unlike
 *    RegisterDialog's sibling button, this one's callback is expected to
 *    *reject* on a genuine failure (see onRequestResetCode's own doc below),
 *    so this dialog can tell "an email really went out" apart from "the
 *    request failed" and gate the next field on the former.
 * 2. POST /api/user/reset (resetPassword) -- takes {email, token}, where
 *    token is the opaque value copied out of the emailed link's `token=`
 *    query parameter, NOT a password. new-api generates a brand-new
 *    password itself the instant the token verifies and returns it in the
 *    response; there is no field for a caller to submit a chosen one
 *    (confirmed directly from controller/misc.go's ResetPassword handler --
 *    see NewApiResetPasswordInput's comment in new-api-client.ts). So
 *    instead of a second "new password" + "confirm password" pair, a
 *    successful submit replaces the form with a read-only reveal of that
 *    generated password (resetResult, owned by the parent so the same value
 *    can also seed LoginDialog's prefill once the user clicks "去登录").
 */
export function ForgotPasswordDialog({
  onClose,
  onSwitchToLogin,
  onSubmit,
  onRequestResetCode,
  onDone,
  isSubmitting = false,
  resetResult,
}: {
  onClose: () => void
  onSwitchToLogin: () => void
  onSubmit: (values: { email: string; token: string }) => void
  // Unlike RegisterDialog's onRequestVerificationCode, this one is expected
  // to reject when the send genuinely failed (its parent still owns showing
  // the toast either way -- see App.tsx's handleSendPasswordResetCode) so
  // this dialog can gate revealing the 重置码 field on a real success rather
  // than merely "the call returned".
  onRequestResetCode: (email: string) => Promise<void>
  onDone: () => void
  isSubmitting?: boolean
  resetResult: { newPassword: string } | null
}) {
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [errors, setErrors] = useState<AccountFieldErrors>({})
  const [codeCooldown, setCodeCooldown] = useState(0)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  // Synchronous dedupe for a double click landing before React re-renders the
  // disabled button (T6) -- same pattern as RegisterDialog's sendingCodeRef.
  const sendingCodeRef = useRef(false)

  useEffect(() => {
    if (codeCooldown <= 0) return undefined
    const timer = window.setInterval(() => {
      setCodeCooldown((current) => Math.max(0, current - 1))
    }, 1_000)
    return () => window.clearInterval(timer)
    // Deliberately keyed on the crossing (>0), same reasoning as
    // RegisterDialog's identical effect.
  }, [codeCooldown > 0])

  const clearError = (field: keyof AccountFieldErrors) => {
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current))
  }

  const updateEmail = (value: string) => {
    setEmail(value)
    clearError('email')
    // A token already in hand only verifies against the address it was
    // issued for (new-api keys its verification store by email+purpose) --
    // changing the address makes any in-progress token stale, so ask for a
    // fresh one rather than let a mismatched submit fail confusingly later.
    if (codeSent) {
      setCodeSent(false)
      setToken('')
    }
  }

  const requestCode = () => {
    const emailError = validateEmail(email)
    if (emailError) {
      setErrors((current) => ({ ...current, email: emailError }))
      return
    }
    if (sendingCodeRef.current || codeCooldown > 0) return
    sendingCodeRef.current = true
    setCodeCooldown(RESET_CODE_COOLDOWN_SECONDS)
    onRequestResetCode(email.trim())
      .then(() => setCodeSent(true))
      .catch(() => undefined)
      .finally(() => { sendingCodeRef.current = false })
  }

  const copyPassword = async () => {
    if (!resetResult || !navigator.clipboard) {
      setCopyState('failed')
      return
    }
    try {
      await navigator.clipboard.writeText(resetResult.newPassword)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (isSubmitting) return
    const nextErrors = validateForgotPasswordForm({ email, token })
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) return
    onSubmit({ email: email.trim(), token: token.trim() })
  }

  if (resetResult) {
    return (
      <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={onClose}>
        <section
          className="extension-dialog compact-dialog account-dialog"
          {...dialogAriaProps('forgot-password-dialog-title')}
        >
          <header className="extension-dialog-head">
            <div>
              <span className="extension-dialog-icon"><LockKeyhole size={19} /></span>
              <div>
                <h2 id="forgot-password-dialog-title">密码重置成功</h2>
                <small>请复制新密码后登录</small>
              </div>
            </div>
            <button className="icon-button compact" type="button" title="关闭" onClick={onClose}>
              <X size={17} />
            </button>
          </header>

          <div className="extension-dialog-body">
            <p>系统已为您生成一个新密码，请妥善保管：</p>
            <label className="field extension-field">
              <span>新密码</span>
              <div className="input-with-action">
                <input
                  readOnly
                  value={resetResult.newPassword}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button
                  type="button"
                  title={copyState === 'copied' ? '已复制' : '复制新密码'}
                  onClick={() => void copyPassword()}
                >
                  {copyState === 'copied' ? <Check size={16} /> : <ClipboardCopy size={16} />}
                </button>
              </div>
            </label>
            <small className="field-hint">登录后建议前往个人中心修改为您熟悉的密码。</small>
          </div>

          <footer className="extension-dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose}>关闭</button>
            <button className="primary-button" type="button" onClick={onDone}>去登录</button>
          </footer>
        </section>
      </DialogBackdrop>
    )
  }

  return (
    <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={onClose}>
      <form
        className="extension-dialog compact-dialog account-dialog"
        onSubmit={submit}
        {...dialogAriaProps('forgot-password-dialog-title')}
      >
        <header className="extension-dialog-head">
          <div>
            <span className="extension-dialog-icon"><LockKeyhole size={19} /></span>
            <div>
              <h2 id="forgot-password-dialog-title">找回密码</h2>
              <small>通过邮箱重置密码</small>
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
              value={email}
              onChange={(event) => updateEmail(event.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
            {errors.email && <small className="field-error" role="alert">{errors.email}</small>}
          </label>

          <label className="field extension-field">
            <span>重置码</span>
            <div className="account-code-row">
              <input
                value={token}
                onChange={(event) => { setToken(event.target.value); clearError('token') }}
                placeholder={codeSent ? '粘贴邮件中重置链接的一长串字符' : '请先发送重置邮件'}
                autoComplete="one-time-code"
                disabled={!codeSent}
              />
              <button
                type="button"
                className="secondary-button account-code-button"
                onClick={requestCode}
                disabled={codeCooldown > 0}
              >
                {codeCooldown > 0 ? `${codeCooldown} 秒后重试` : (codeSent ? '重新发送' : '发送重置邮件')}
              </button>
            </div>
            {codeSent && (
              <small className="field-hint">
                请查收邮箱，打开邮件中的重置链接，将链接里 token= 后面的一长串字符粘贴到上方（10 分钟内有效）
              </small>
            )}
            {errors.token && <small className="field-error" role="alert">{errors.token}</small>}
          </label>

          <p className="account-dialog-switch">
            想起来了？
            <button type="button" onClick={onSwitchToLogin}>去登录</button>
          </p>
        </div>

        <footer className="extension-dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="primary-button" type="submit" disabled={isSubmitting || !codeSent}>
            {isSubmitting ? '重置中…' : '重置密码'}
          </button>
        </footer>
      </form>
    </DialogBackdrop>
  )
}
