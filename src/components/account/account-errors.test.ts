import { describe, expect, it } from 'vitest'
import { resolveAccountErrorMessage } from './account-errors'

describe('resolveAccountErrorMessage', () => {
  it('maps the exact production message this refactor exists to fix (xm.solov.cc\'s shorter, customized phrasing)', () => {
    expect(resolveAccountErrorMessage('Username already exists')).toBe(
      '该用户名已被注册，请更换用户名，或点击"去登录"',
    )
  })

  it('also maps the longer upstream QuantumNous/new-api phrasing for the same failure', () => {
    expect(resolveAccountErrorMessage('Username already exists or has been deleted')).toBe(
      '该用户名已被注册，请更换用户名，或点击"去登录"',
    )
  })

  it('maps the official Chinese translation of the same failure', () => {
    expect(resolveAccountErrorMessage('用户名已存在，或已注销')).toBe(
      '该用户名已被注册，请更换用户名，或点击"去登录"',
    )
  })

  it('maps an already-registered email to a distinct, login-oriented message', () => {
    expect(resolveAccountErrorMessage('Email address is already in use')).toBe(
      '该邮箱已被注册，请直接登录，或更换邮箱后重试',
    )
    expect(resolveAccountErrorMessage('邮箱地址已被占用')).toBe(
      '该邮箱已被注册，请直接登录，或更换邮箱后重试',
    )
  })

  it('maps an incorrect or expired verification code', () => {
    expect(resolveAccountErrorMessage('Verification code is incorrect or has expired')).toBe(
      '验证码错误或已过期，请重新获取验证码',
    )
    expect(resolveAccountErrorMessage('验证码错误或已过期')).toBe(
      '验证码错误或已过期，请重新获取验证码',
    )
  })

  it('maps an invalid or expired password-reset link/token', () => {
    expect(resolveAccountErrorMessage('Password reset link is invalid or has expired')).toBe(
      '重置码错误或已过期，请重新获取重置邮件',
    )
    expect(resolveAccountErrorMessage('重置链接非法或已过期')).toBe(
      '重置码错误或已过期，请重新获取重置邮件',
    )
  })

  it('maps a missing email/code when email verification is required', () => {
    expect(resolveAccountErrorMessage(
      'Email verification is enabled, please enter email address and verification code',
    )).toBe('请输入邮箱地址并获取验证码')
  })

  it('maps new-api\'s single generic login failure message to a Chinese equivalent', () => {
    expect(resolveAccountErrorMessage('Username or password is incorrect, or user has been banned')).toBe(
      '用户名或密码错误',
    )
    expect(resolveAccountErrorMessage('用户名或密码错误，或用户已被封禁')).toBe('用户名或密码错误')
  })

  it('maps defensive "account not found" phrasing to the same login failure message', () => {
    expect(resolveAccountErrorMessage('user does not exist')).toBe('用户名或密码错误')
    expect(resolveAccountErrorMessage('No such user')).toBe('用户名或密码错误')
  })

  it('maps a standalone banned-account message', () => {
    expect(resolveAccountErrorMessage('User has been banned')).toBe('该账号已被封禁，请联系客服')
  })

  it('maps registration-disabled messages', () => {
    expect(resolveAccountErrorMessage('New user registration has been disabled by administrator')).toBe(
      '当前暂未开放注册，请联系客服',
    )
    expect(resolveAccountErrorMessage(
      'Password registration has been disabled by administrator, please use third-party account verification',
    )).toBe('当前暂未开放注册，请联系客服')
  })

  it('maps a password-login-disabled message', () => {
    expect(resolveAccountErrorMessage('Password login has been disabled by administrator')).toBe(
      '当前暂不支持密码登录，请联系客服',
    )
  })

  it('maps a database error to a generic retry hint rather than exposing internals', () => {
    expect(resolveAccountErrorMessage('Database error, please contact the administrator')).toBe(
      '服务暂时不可用，请稍后重试',
    )
  })

  it('is case-insensitive', () => {
    expect(resolveAccountErrorMessage('USERNAME ALREADY EXISTS')).toBe(
      '该用户名已被注册，请更换用户名，或点击"去登录"',
    )
  })

  it('passes through an unrecognized message unchanged instead of swallowing it', () => {
    expect(resolveAccountErrorMessage('New-Api 服务地址格式无效')).toBe('New-Api 服务地址格式无效')
    expect(resolveAccountErrorMessage('some unexpected upstream failure xyz-123')).toBe(
      'some unexpected upstream failure xyz-123',
    )
  })

  it('trims surrounding whitespace on both matched and passthrough messages', () => {
    expect(resolveAccountErrorMessage('  Username already exists  ')).toBe(
      '该用户名已被注册，请更换用户名，或点击"去登录"',
    )
    expect(resolveAccountErrorMessage('  unrecognized message  ')).toBe('unrecognized message')
  })

  it('returns an empty string unchanged', () => {
    expect(resolveAccountErrorMessage('')).toBe('')
    expect(resolveAccountErrorMessage('   ')).toBe('')
  })
})
