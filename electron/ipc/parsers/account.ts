// 账号登录、注册、找回和修改密码、记住密码、显示名称、协议文档的入参。
import { isRecord } from '../../input-guards'
import type { LegalDocumentKind, RememberedAccountLogin } from '../../ipc-contract'
import type {
  NewApiChangePasswordInput,
  NewApiDisplayNameUpdateInput,
  NewApiLoginInput,
  NewApiRegisterInput,
  NewApiResetPasswordInput,
} from '../../new-api-client'
import { optionalString, requiredString } from './common'

// Not requiredString: a generated password is copied byte for byte, so it
// must not be trimmed on the way to the clipboard.
export function parseResetPasswordToCopy(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0')) throw new Error('新密码格式错误')
  return value
}

export function parseAccountSiteId(value: unknown): 'solov' | 'solov-api' {
  if (value !== 'solov' && value !== 'solov-api') throw new Error('账号来源无效')
  return value
}

export function parseAccountLoginInput(value: unknown): NewApiLoginInput {
  if (!isRecord(value)) throw new Error('登录信息格式错误')
  const username = requiredString(value.username, '用户名或邮箱', 128)
  // Not requiredString: a password must be forwarded exactly as typed, and
  // requiredString() both trims it and rejects an all-whitespace value.
  if (typeof value.password !== 'string' || !value.password || value.password.length > 256) {
    throw new Error('密码格式错误')
  }
  return {
    username,
    password: value.password,
    turnstileToken: optionalString(value.turnstileToken, '人机验证 Token', 4_096),
  }
}

// 验证器的 6 位数字或一次性备用码。格式对不对交给服务端判断（备用码的写法各版不同），
// 这里只挡掉明显不是验证码的输入，免得白白消耗服务端那份严格的限流。
export function parseTwoFactorCode(value: unknown): string {
  if (typeof value !== 'string') throw new Error('验证码格式错误')
  const code = value.trim()
  if (!code || code.length > 64 || /[\u0000-\u001f\u007f]/.test(code)) throw new Error('验证码格式错误')
  return code
}

// null = 用户取消勾选「记住密码」,清除已存凭据。字段上限与登录入参一致。
export function parseRememberedAccountLogin(value: unknown): RememberedAccountLogin | null {
  if (value === null) return null
  if (!isRecord(value)) throw new Error('记住密码信息格式错误')
  const identifier = requiredString(value.identifier, '用户名或邮箱', 128)
  // Same as parseAccountLoginInput: forward the password exactly as typed.
  if (typeof value.password !== 'string' || !value.password || value.password.length > 256) {
    throw new Error('密码格式错误')
  }
  return { identifier, password: value.password }
}

// Deliberately permissive (not full RFC 5322): catches the typos users
// actually make without rejecting a valid-but-unusual address. Mirrors
// src/components/account/validation.ts's EMAIL_PATTERN, kept as a separate
// literal rather than a shared import -- electron/ never imports from src/
// (renderer code may depend on Node-free bundling; see AGENTS.md I6/I7) --
// and this is the one account:* input parser that actually needs a format
// check rather than requiredString()'s bare non-empty test, since a
// malformed address here would silently fail server-side with no useful
// per-field feedback back to RegisterDialog.
const accountEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function parseAccountEmailInput(value: unknown): string {
  const email = requiredString(value, '邮箱地址', 254)
  if (!accountEmailPattern.test(email)) throw new Error('请输入正确的邮箱地址')
  return email
}

export function parseAccountRegisterInput(value: unknown): NewApiRegisterInput {
  if (!isRecord(value)) throw new Error('注册信息格式错误')
  const email = parseAccountEmailInput(value.email)
  // Required, not defaulted from email: new-api enforces uniqueness on
  // username independently of email (see NewApiRegisterInput's own comment
  // in new-api-client.ts), and RegisterDialog.tsx now collects a real
  // username field for the caller to send here.
  const username = requiredString(value.username, '用户名', 128)
  // Not requiredString: see parseAccountLoginInput above for why passwords
  // are forwarded exactly as typed rather than trimmed.
  if (typeof value.password !== 'string' || !value.password || value.password.length > 256) {
    throw new Error('密码格式错误')
  }
  // The account status endpoint can disable email verification. In that mode
  // the renderer intentionally hides the field and sends an empty value; do
  // not reject an otherwise valid registration before the service sees it.
  const verificationCode = optionalString(value.verificationCode, '邮箱验证码', 32) ?? ''
  return {
    email,
    password: value.password,
    verificationCode,
    username,
    affCode: optionalString(value.affCode, '邀请码', 64),
  }
}

// account:reset-password's input. token is the opaque value copied out of
// the emailed reset link's `token=` query parameter (see
// NewApiResetPasswordInput's own comment in new-api-client.ts) -- bounded
// generously (256 chars) rather than pinned to the 32-hex-char shape
// new-api currently generates it as, so a future change to that length on
// the server side degrades to "wrong code" instead of "rejected before it
// even reaches the server".
export function parseAccountPasswordResetInput(value: unknown): NewApiResetPasswordInput {
  if (!isRecord(value)) throw new Error('重置密码信息格式错误')
  return {
    email: parseAccountEmailInput(value.email),
    token: requiredString(value.token, '重置码', 256),
  }
}

export function parseAccountDisplayNameUpdateInput(value: unknown): NewApiDisplayNameUpdateInput {
  if (!isRecord(value) || typeof value.displayName !== 'string' || value.displayName.length > 20) {
    throw new Error('显示名称格式错误')
  }
  return { displayName: value.displayName.trim() }
}

export function parseLegalDocumentKind(value: unknown): LegalDocumentKind {
  if (value !== 'user-agreement' && value !== 'privacy-policy') {
    throw new Error('法律文档类型格式错误')
  }
  return value
}

// account:change-password's input. MIN/MAX mirror
// src/components/account/validation.ts's own MIN_PASSWORD_LENGTH /
// MAX_PASSWORD_LENGTH (confirmed against QuantumNous/new-api's model.User
// struct tag validate:"min=8,max=20") -- kept as separate literals rather
// than a shared import, same reasoning as accountEmailPattern above:
// electron/ never imports from src/ (AGENTS.md I6/I7). originalPassword is
// only checked for presence (not length-bounded): the server is the actual
// authority on whether it matches the account's current password, and
// rejecting it here on a length technicality before the server even gets to
// say "wrong password" would be a worse failure mode. Neither field is
// trimmed -- both must be forwarded exactly as typed, same as
// parseAccountLoginInput's password field.
const MIN_ACCOUNT_PASSWORD_LENGTH = 8
const MAX_ACCOUNT_PASSWORD_LENGTH = 20

export function parseAccountChangePasswordInput(value: unknown, sub2Api = false): NewApiChangePasswordInput {
  const minimum = sub2Api ? 6 : MIN_ACCOUNT_PASSWORD_LENGTH
  const maximum = sub2Api ? 256 : MAX_ACCOUNT_PASSWORD_LENGTH
  if (!isRecord(value)) throw new Error('修改密码信息格式错误')
  if (
    typeof value.originalPassword !== 'string'
    || !value.originalPassword
    || value.originalPassword.length > 256
  ) {
    throw new Error('原密码格式错误')
  }
  const newPassword = value.newPassword
  if (
    typeof newPassword !== 'string'
    || newPassword.length < minimum
    || newPassword.length > maximum
  ) {
    throw new Error(`新密码长度需为 ${minimum} 到 ${maximum} 位`)
  }
  return { originalPassword: value.originalPassword, newPassword }
}
