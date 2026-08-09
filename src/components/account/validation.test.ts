import { describe, expect, it } from 'vitest'
import {
  hasAccountFieldErrors,
  validateEmail,
  validateLoginForm,
  validatePassword,
  validateRegisterForm,
  validateVerificationCode,
} from './validation'

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

  it('accepts a longer value', () => {
    expect(validatePassword('a-fairly-long-passphrase')).toBeNull()
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

describe('validateLoginForm', () => {
  it('reports both fields when both are empty', () => {
    const errors = validateLoginForm({ email: '', password: '' })
    expect(errors.email).toBe('请输入邮箱地址')
    expect(errors.password).toBe('请输入密码')
  })

  it('reports no errors for a valid submission', () => {
    const errors = validateLoginForm({ email: 'user@example.com', password: 'password123' })
    expect(errors).toEqual({})
  })

  it('reports only the invalid field', () => {
    const errors = validateLoginForm({ email: 'user@example.com', password: 'short' })
    expect(errors.email).toBeUndefined()
    expect(errors.password).toBe('密码至少需要 8 位')
  })
})

describe('validateRegisterForm', () => {
  it('reports all three fields when all are empty', () => {
    const errors = validateRegisterForm({ email: '', password: '', verificationCode: '' })
    expect(errors.email).toBeDefined()
    expect(errors.password).toBeDefined()
    expect(errors.verificationCode).toBeDefined()
  })

  it('reports no errors for a valid submission', () => {
    const errors = validateRegisterForm({
      email: 'user@example.com',
      password: 'password123',
      verificationCode: '123456',
    })
    expect(errors).toEqual({})
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
