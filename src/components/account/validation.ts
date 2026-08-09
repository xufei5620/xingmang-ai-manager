// Client-side validation for the login/register dialogs. The real account
// system (xm.solov.cc / new-api) does its own authoritative validation
// server-side; these checks exist to give immediate, Chinese-language
// feedback and to catch the common mistakes before a round trip.
//
// Username and password length rules are not guesses: confirmed against
// QuantumNous/new-api's model.User struct tags (`validate:"max=20"` on
// Username, `validate:"min=8,max=20"` on Password) and matched by the
// official web frontend's own zod schema (web/src/features/auth/
// constants.ts registerFormSchema: password `.min(8).max(20)`). No
// character-class restriction on username is enforced server-side beyond
// non-empty + length, so none is added here either.

// Intentionally permissive (not full RFC 5322): catches the typos users
// actually make without rejecting valid-but-unusual addresses.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 20
const MAX_USERNAME_LENGTH = 20

export interface AccountFieldErrors {
  identifier?: string
  username?: string
  email?: string
  password?: string
  confirmPassword?: string
  verificationCode?: string
  agreement?: string
}

// LoginDialog's single identifier field: new-api's Login handler matches it
// against *either* username or email (model.User.ValidateAndFill: `DB.Where
// ("username = ? OR email = ?", username, username)`), so it is validated
// only for presence, not shape.
export function validateIdentifier(value: string): string | null {
  if (!value.trim()) return '请输入用户名或邮箱'
  return null
}

export function validateUsername(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return '请输入用户名'
  if (trimmed.length > MAX_USERNAME_LENGTH) return `用户名不能超过 ${MAX_USERNAME_LENGTH} 位`
  return null
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
  if (value.length > MAX_PASSWORD_LENGTH) return `密码不能超过 ${MAX_PASSWORD_LENGTH} 位`
  return null
}

export function validateConfirmPassword(password: string, confirmPassword: string): string | null {
  if (!confirmPassword) return '请再次输入密码'
  if (confirmPassword !== password) return '两次输入的密码不一致'
  return null
}

export function validateVerificationCode(value: string): string | null {
  if (!value.trim()) return '请输入验证码'
  return null
}

export function validateAgreement(agreed: boolean): string | null {
  if (!agreed) return '请先阅读并同意用户协议和隐私政策'
  return null
}

export function validateLoginForm(values: { identifier: string, password: string }): AccountFieldErrors {
  const errors: AccountFieldErrors = {}
  const identifierError = validateIdentifier(values.identifier)
  if (identifierError) errors.identifier = identifierError
  const passwordError = validatePassword(values.password)
  if (passwordError) errors.password = passwordError
  return errors
}

export function validateRegisterForm(values: {
  username: string
  email: string
  password: string
  confirmPassword: string
  verificationCode: string
  agreedToTerms: boolean
}): AccountFieldErrors {
  const errors: AccountFieldErrors = {}
  const usernameError = validateUsername(values.username)
  if (usernameError) errors.username = usernameError
  const emailError = validateEmail(values.email)
  if (emailError) errors.email = emailError
  const passwordError = validatePassword(values.password)
  if (passwordError) errors.password = passwordError
  const confirmPasswordError = validateConfirmPassword(values.password, values.confirmPassword)
  if (confirmPasswordError) errors.confirmPassword = confirmPasswordError
  const codeError = validateVerificationCode(values.verificationCode)
  if (codeError) errors.verificationCode = codeError
  const agreementError = validateAgreement(values.agreedToTerms)
  if (agreementError) errors.agreement = agreementError
  return errors
}

export function hasAccountFieldErrors(errors: AccountFieldErrors): boolean {
  return Object.values(errors).some((message) => Boolean(message))
}
