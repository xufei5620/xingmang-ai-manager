import { describe, expect, it } from 'vitest'
import {
  hasAccountFieldErrors,
  validateAgreement,
  validateChangePasswordForm,
  validateConfirmPassword,
  validateEmail,
  validateForgotPasswordForm,
  validateIdentifier,
  validateLoginForm,
  validateOriginalPassword,
  validatePassword,
  validateRegisterForm,
  validateResetToken,
  validateUsername,
  validateVerificationCode,
} from './validation'

describe('validateIdentifier', () => {
  it('rejects an empty value', () => {
    expect(validateIdentifier('')).toBe('请输入用户名或邮箱')
  })

  it('rejects a whitespace-only value', () => {
    expect(validateIdentifier('   ')).toBe('请输入用户名或邮箱')
  })

  it('accepts a bare username with no format restriction', () => {
    expect(validateIdentifier('nova')).toBeNull()
  })

  it('accepts an email address too, since new-api login matches either', () => {
    expect(validateIdentifier('user@example.com')).toBeNull()
  })
})

describe('validateUsername', () => {
  it('rejects an empty value', () => {
    expect(validateUsername('')).toBe('请输入用户名')
  })

  it('rejects a whitespace-only value', () => {
    expect(validateUsername('   ')).toBe('请输入用户名')
  })

  it('accepts a value at the maximum length (20, confirmed against new-api\'s User.Username validate tag)', () => {
    expect(validateUsername('a'.repeat(20))).toBeNull()
  })

  it('rejects a value longer than the maximum length', () => {
    expect(validateUsername('a'.repeat(21))).toBe('用户名不能超过 20 位')
  })

  it('accepts non-ASCII characters, since new-api enforces no character-class restriction', () => {
    expect(validateUsername('星芒用户')).toBeNull()
  })
})

describe('validateEmail', () => {
  it('rejects an empty value', () => {
    expect(validateEmail('')).toBe('请输入邮箱地址')
  })

  it('rejects a whitespace-only value', () => {
    expect(validateEmail('   ')).toBe('请输入邮箱地址')
  })

  it('rejects a value with no @', () => {
    expect(validateEmail('not-an-email')).toBe('请输入正确的邮箱地址')
  })

  it('rejects a value with no domain dot', () => {
    expect(validateEmail('user@host')).toBe('请输入正确的邮箱地址')
  })

  it('accepts a well-formed address', () => {
    expect(validateEmail('user@example.com')).toBeNull()
  })

  it('accepts a well-formed address with surrounding whitespace', () => {
    expect(validateEmail('  user@example.com  ')).toBeNull()
  })
})

describe('validatePassword', () => {
  it('rejects an empty value', () => {
    expect(validatePassword('')).toBe('请输入密码')
  })

  it('rejects a value shorter than the minimum length', () => {
    expect(validatePassword('short1')).toBe('密码至少需要 8 位')
  })

  it('accepts a value at the minimum length', () => {
    expect(validatePassword('12345678')).toBeNull()
  })

  it('accepts a value at the maximum length (20, confirmed against new-api\'s User.Password validate tag)', () => {
    expect(validatePassword('a'.repeat(20))).toBeNull()
  })

  it('rejects a value longer than the maximum length', () => {
    expect(validatePassword('a'.repeat(21))).toBe('密码不能超过 20 位')
  })
})

describe('validateConfirmPassword', () => {
  it('rejects an empty value', () => {
    expect(validateConfirmPassword('password123', '')).toBe('请再次输入密码')
  })

  it('rejects a value that does not match the password', () => {
    expect(validateConfirmPassword('password123', 'password124')).toBe('两次输入的密码不一致')
  })

  it('accepts a value that matches the password exactly', () => {
    expect(validateConfirmPassword('password123', 'password123')).toBeNull()
  })
})

describe('validateVerificationCode', () => {
  it('rejects an empty value', () => {
    expect(validateVerificationCode('')).toBe('请输入验证码')
  })

  it('rejects a whitespace-only value', () => {
    expect(validateVerificationCode('   ')).toBe('请输入验证码')
  })

  it('accepts any non-empty value', () => {
    expect(validateVerificationCode('123456')).toBeNull()
  })
})

describe('validateResetToken', () => {
  it('rejects an empty value', () => {
    expect(validateResetToken('')).toBe('请输入重置码')
  })

  it('rejects a whitespace-only value', () => {
    expect(validateResetToken('   ')).toBe('请输入重置码')
  })

  it('accepts any non-empty value regardless of length or shape', () => {
    expect(validateResetToken('abc123')).toBeNull()
    expect(validateResetToken('a'.repeat(32))).toBeNull()
  })
})

describe('validateAgreement', () => {
  it('rejects when not agreed', () => {
    expect(validateAgreement(false)).toBe('请先阅读并同意用户协议和隐私政策')
  })

  it('accepts when agreed', () => {
    expect(validateAgreement(true)).toBeNull()
  })
})

describe('validateLoginForm', () => {
  it('reports both fields when both are empty', () => {
    const errors = validateLoginForm({ identifier: '', password: '' })
    expect(errors.identifier).toBe('请输入用户名或邮箱')
    expect(errors.password).toBe('请输入密码')
  })

  it('reports no errors for a valid submission using a username', () => {
    const errors = validateLoginForm({ identifier: 'nova', password: 'password123' })
    expect(errors).toEqual({})
  })

  it('reports no errors for a valid submission using an email', () => {
    const errors = validateLoginForm({ identifier: 'user@example.com', password: 'password123' })
    expect(errors).toEqual({})
  })

  it('reports only the invalid field', () => {
    const errors = validateLoginForm({ identifier: 'nova', password: 'short' })
    expect(errors.identifier).toBeUndefined()
    expect(errors.password).toBe('密码至少需要 8 位')
  })
})

describe('validateRegisterForm', () => {
  const validValues = {
    username: 'nova',
    email: 'user@example.com',
    password: 'password123',
    confirmPassword: 'password123',
    verificationCode: '123456',
    agreedToTerms: true,
  }

  it('reports every field when all are empty or unchecked', () => {
    const errors = validateRegisterForm({
      username: '',
      email: '',
      password: '',
      confirmPassword: '',
      verificationCode: '',
      agreedToTerms: false,
    })
    expect(errors.username).toBeDefined()
    expect(errors.email).toBeDefined()
    expect(errors.password).toBeDefined()
    expect(errors.confirmPassword).toBeDefined()
    expect(errors.verificationCode).toBeDefined()
    expect(errors.agreement).toBeDefined()
  })

  it('reports no errors for a fully valid submission', () => {
    expect(validateRegisterForm(validValues)).toEqual({})
  })

  it('reports a mismatched confirmation password without flagging the password itself', () => {
    const errors = validateRegisterForm({ ...validValues, confirmPassword: 'different123' })
    expect(errors.password).toBeUndefined()
    expect(errors.confirmPassword).toBe('两次输入的密码不一致')
  })

  it('reports the agreement checkbox independently of every other field', () => {
    const errors = validateRegisterForm({ ...validValues, agreedToTerms: false })
    expect(errors).toEqual({ agreement: '请先阅读并同意用户协议和隐私政策' })
  })

  it('reports an over-length username independently of every other field', () => {
    const errors = validateRegisterForm({ ...validValues, username: 'a'.repeat(21) })
    expect(errors).toEqual({ username: '用户名不能超过 20 位' })
  })
})

describe('validateOriginalPassword', () => {
  it('rejects an empty value', () => {
    expect(validateOriginalPassword('')).toBe('请输入原密码')
  })

  it('accepts any non-empty value regardless of length or shape', () => {
    expect(validateOriginalPassword('short')).toBeNull()
    expect(validateOriginalPassword('a'.repeat(64))).toBeNull()
  })
})

describe('validateChangePasswordForm', () => {
  it('reports every field when all are empty', () => {
    const errors = validateChangePasswordForm({ originalPassword: '', newPassword: '', confirmNewPassword: '' })
    expect(errors.originalPassword).toBe('请输入原密码')
    expect(errors.password).toBe('请输入密码')
    expect(errors.confirmPassword).toBe('请再次输入密码')
  })

  it('reports no errors for a fully valid submission', () => {
    expect(validateChangePasswordForm({
      originalPassword: 'current-password-1',
      newPassword: 'new-password-123',
      confirmNewPassword: 'new-password-123',
    })).toEqual({})
  })

  it('reports a mismatched confirmation without flagging the new password itself', () => {
    const errors = validateChangePasswordForm({
      originalPassword: 'current-password-1',
      newPassword: 'new-password-123',
      confirmNewPassword: 'different-password',
    })
    expect(errors.password).toBeUndefined()
    expect(errors.confirmPassword).toBe('两次输入的密码不一致')
  })

  it('reports an under-length new password independently of the original password field', () => {
    const errors = validateChangePasswordForm({
      originalPassword: 'current-password-1',
      newPassword: 'short1',
      confirmNewPassword: 'short1',
    })
    expect(errors).toEqual({ password: '密码至少需要 8 位' })
  })
})

describe('validateForgotPasswordForm', () => {
  it('reports both fields when both are empty', () => {
    const errors = validateForgotPasswordForm({ email: '', token: '' })
    expect(errors.email).toBe('请输入邮箱地址')
    expect(errors.token).toBe('请输入重置码')
  })

  it('reports no errors for a fully valid submission', () => {
    expect(validateForgotPasswordForm({ email: 'user@example.com', token: 'abc123' })).toEqual({})
  })

  it('reports only the invalid field', () => {
    const errors = validateForgotPasswordForm({ email: 'not-an-email', token: 'abc123' })
    expect(errors.email).toBe('请输入正确的邮箱地址')
    expect(errors.token).toBeUndefined()
  })
})

describe('hasAccountFieldErrors', () => {
  it('is false for an empty errors object', () => {
    expect(hasAccountFieldErrors({})).toBe(false)
  })

  it('is true when any field has a message', () => {
    expect(hasAccountFieldErrors({ email: '请输入邮箱地址' })).toBe(true)
  })
})
