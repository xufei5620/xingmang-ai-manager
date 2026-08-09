// Client-side validation for the login/register dialog skeletons. Deliberately
// lightweight: the real account system (xm.solov.cc / new-api) does its own
// authoritative validation server-side, and this wave never actually submits
// to it (see LoginDialog.tsx / RegisterDialog.tsx) — these checks only exist
// to give the stub forms honest, immediate, Chinese-language feedback.

// Intentionally permissive (not full RFC 5322): catches the typos users
// actually make without rejecting valid-but-unusual addresses.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// No confirmed backend policy yet (docs/RECON-new-api.md ran no register/login
// calls) — 8 is a conservative, common minimum, easy to loosen once the real
// policy is known.
const MIN_PASSWORD_LENGTH = 8

export interface AccountFieldErrors {
  email?: string
  password?: string
  verificationCode?: string
}

export function validateEmail(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return '请输入邮箱地址'
  if (!EMAIL_PATTERN.test(trimmed)) return '请输入正确的邮箱地址'
  return null
}

export function validatePassword(value: string): string | null {
  if (!value) return '请输入密码'
  if (value.length < MIN_PASSWORD_LENGTH) return `密码至少需要 ${MIN_PASSWORD_LENGTH} 位`
  return null
}

export function validateVerificationCode(value: string): string | null {
  if (!value.trim()) return '请输入验证码'
  return null
}

export function validateLoginForm(values: { email: string, password: string }): AccountFieldErrors {
  const errors: AccountFieldErrors = {}
  const emailError = validateEmail(values.email)
  if (emailError) errors.email = emailError
  const passwordError = validatePassword(values.password)
  if (passwordError) errors.password = passwordError
  return errors
}

export function validateRegisterForm(values: {
  email: string
  password: string
  verificationCode: string
}): AccountFieldErrors {
  const errors = validateLoginForm(values)
  const codeError = validateVerificationCode(values.verificationCode)
  if (codeError) errors.verificationCode = codeError
  return errors
}

export function hasAccountFieldErrors(errors: AccountFieldErrors): boolean {
  return Object.values(errors).some((message) => Boolean(message))
}
