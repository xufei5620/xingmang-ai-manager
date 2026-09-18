import { describe, expect, it } from 'vitest'
import { matchAccountErrorMessage } from './account-errors'

describe('renderer-v2 new-api account error table', () => {
  it('names the register-time collision that happened instead of merging both', () => {
    expect(matchAccountErrorMessage('Username already exists')).toBe('该用户名已被注册，请更换用户名，或点击“已有账号，登录”')
    expect(matchAccountErrorMessage('Username already exists or has been deleted')).toBe('该用户名已被注册，请更换用户名，或点击“已有账号，登录”')
    expect(matchAccountErrorMessage('用户名已存在，或已注销')).toBe('该用户名已被注册，请更换用户名，或点击“已有账号，登录”')
    expect(matchAccountErrorMessage('Email address is already in use')).toBe('该邮箱已被注册，请直接登录，或更换邮箱后重试')
    expect(matchAccountErrorMessage('邮箱地址已被占用')).toBe('该邮箱已被注册，请直接登录，或更换邮箱后重试')
  })
  it('keeps a change-password failure in the change-password vocabulary', () => {
    expect(matchAccountErrorMessage('Original password is incorrect')).toBe('原密码错误，请重新输入')
    expect(matchAccountErrorMessage('原密码错误')).toBe('原密码错误，请重新输入')
  })
  it('sends an account without a password to password recovery, not back to the password field', () => {
    const expected = '当前账号未设置密码，请先通过“找回密码”设置密码'
    expect(matchAccountErrorMessage('This account has no password set. Please use password reset or contact an administrator to reset it.')).toBe(expected)
    expect(matchAccountErrorMessage('当前账号未设置密码，请使用密码重置或联系管理员重置密码')).toBe(expected)
  })
  it('surfaces the server-side states a retry can never clear', () => {
    expect(matchAccountErrorMessage('User has been banned')).toBe('该账号已被封禁，请联系客服')
    expect(matchAccountErrorMessage('用户已被封禁')).toBe('该账号已被封禁，请联系客服')
    expect(matchAccountErrorMessage('New user registration has been disabled by administrator')).toBe('当前暂未开放注册，请联系客服')
    expect(matchAccountErrorMessage('注册功能已关闭')).toBe('当前暂未开放注册，请联系客服')
    expect(matchAccountErrorMessage('Password login has been disabled by administrator')).toBe('当前暂不支持密码登录，请联系客服')
    expect(matchAccountErrorMessage('密码登录已关闭')).toBe('当前暂不支持密码登录，请联系客服')
    expect(matchAccountErrorMessage('Database error, please contact the administrator')).toBe('服务暂时不可用，请稍后重试')
  })
  it('collapses the login failure the server itself refuses to split', () => {
    expect(matchAccountErrorMessage('Username or password is incorrect, or user has been banned')).toBe('用户名或密码错误')
    expect(matchAccountErrorMessage('用户名或密码错误，或用户已被封禁')).toBe('用户名或密码错误')
    expect(matchAccountErrorMessage('user does not exist')).toBe('用户名或密码错误')
    expect(matchAccountErrorMessage('No such user')).toBe('用户名或密码错误')
  })
  it('covers the verification and reset codes', () => {
    expect(matchAccountErrorMessage('Verification code is incorrect or has expired')).toBe('验证码错误或已过期，请重新获取验证码')
    expect(matchAccountErrorMessage('验证码错误或已过期')).toBe('验证码错误或已过期，请重新获取验证码')
    expect(matchAccountErrorMessage('Password reset link is invalid or has expired')).toBe('重置码错误或已过期，请重新获取重置邮件')
    expect(matchAccountErrorMessage('重置链接非法或已过期')).toBe('重置码错误或已过期，请重新获取重置邮件')
    expect(matchAccountErrorMessage('Email verification is enabled, please enter email address and verification code')).toBe('请输入邮箱地址并获取验证码')
  })
  it('still matches once the message crosses IPC or changes case', () => {
    expect(matchAccountErrorMessage("Error invoking remote method 'account:change-password': Error: Original password is incorrect")).toBe('原密码错误，请重新输入')
    expect(matchAccountErrorMessage('USERNAME ALREADY EXISTS')).toBe('该用户名已被注册，请更换用户名，或点击“已有账号，登录”')
    expect(matchAccountErrorMessage(new Error('  User has been banned  '))).toBe('该账号已被封禁，请联系客服')
  })
  it('reports no opinion on anything it does not know, leaving the caller its own fallback', () => {
    expect(matchAccountErrorMessage('some unexpected upstream failure xyz-123')).toBeNull()
    expect(matchAccountErrorMessage('New-Api 服务地址格式无效')).toBeNull()
    expect(matchAccountErrorMessage('')).toBeNull()
    expect(matchAccountErrorMessage('   ')).toBeNull()
    expect(matchAccountErrorMessage(undefined)).toBeNull()
    expect(matchAccountErrorMessage(null)).toBeNull()
  })
})
