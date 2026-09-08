export interface RegistrationDraft { email: string; username: string; password: string; confirm: string; code: string; invite: string; agreed: boolean }
export type RegistrationErrors = Partial<Record<keyof RegistrationDraft, string>>
export type RecoveryCodeResult = { ok: true; token: string; source: 'code' | 'link' } | { ok: false; error: string }

export function isEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())
}

export function parseRecoveryCode(value: string): RecoveryCodeResult {
  const text = value.trim()
  if (!text) return { ok: false, error: '请粘贴邮件中的重置码或完整链接' }
  if (/\s/.test(text)) return { ok: false, error: '重置码不能包含空格或换行，请重新复制' }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    let url: URL
    try { url = new URL(text) } catch { return { ok: false, error: '链接格式不完整，请重新复制邮件中的链接' } }
    if (!['https:', 'http:'].includes(url.protocol)) return { ok: false, error: '只支持邮件中的 HTTP 或 HTTPS 链接' }
    const tokens = url.searchParams.getAll('token')
    if (tokens.length !== 1) return { ok: false, error: tokens.length ? '链接中包含多个重置码，请重新获取邮件' : '链接中没有重置码，请复制邮件中的完整链接' }
    const token = tokens[0]
    if (!token || /\s/.test(token)) return { ok: false, error: '链接中的重置码为空或包含空格，请重新获取邮件' }
    return { ok: true, token, source: 'link' }
  }
  return { ok: true, token: text, source: 'code' }
}

export function parseInviteCode(value: string): string {
  const text = value.trim()
  if (!text) return ''
  if (/^https?:/i.test(text)) {
    try { const url = new URL(text); return url.searchParams.get('aff')?.trim() ?? '' } catch { return '' }
  }
  return text
}

export function validateRegistration(draft: RegistrationDraft, verificationRequired: boolean): RegistrationErrors {
  const errors: RegistrationErrors = {}
  if (!isEmail(draft.email)) errors.email = '请填写正确的邮箱'
  if (draft.username.trim().length < 3 || draft.username.trim().length > 20) errors.username = '用户名需要 3 至 20 个字符'
  if (draft.password.length < 8) errors.password = '密码至少 8 位'
  else if (draft.password.length > 20) errors.password = '密码不能超过 20 位'
  if (draft.password !== draft.confirm) errors.confirm = '两次密码不一致'
  if (verificationRequired && !draft.code.trim()) errors.code = '请填写邮件中的验证码'
  if (draft.invite.trim() && !parseInviteCode(draft.invite)) errors.invite = '邀请链接中没有邀请码，请检查后重试'
  if (!draft.agreed) errors.agreed = '请先同意用户协议和隐私政策'
  return errors
}

export function remainingCooldown(deadline: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

export function authErrorMessage(error: unknown, action: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/429|频繁|too many|rate limit/i.test(message)) return '请求太频繁，请稍等一分钟再试'
  if (/已存在|占用|already exists/i.test(message)) return '用户名或邮箱已被使用，请检查后重试'
  if (/验证码|verification code/i.test(message)) return '验证码不正确或已过期，请重新获取'
  if (/重置/.test(action) && /token|重置码|expired|过期/i.test(message)) return '重置码已失效，请重新获取邮件'
  if (/用户名|密码|credential|password|unauthorized/i.test(message)) return '账号或密码不正确，请检查后重试'
  if (/timeout|timed.?out|超时|network|fetch|connect|网络/i.test(message)) return '连接星芒服务器超时，请检查网络后重试'
  if (/turnstile|人机/i.test(message)) return '服务端需要完成安全验证，请在浏览器完成后再试'
  return `${action}没有成功，输入已保留，请稍后重试`
}
