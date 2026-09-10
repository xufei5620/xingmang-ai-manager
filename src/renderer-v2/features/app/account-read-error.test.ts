import { describe, expect, it } from 'vitest'
import { formatAccountReadError } from './account-read-error'

describe('account read error presentation', () => {
  it('discards only obsolete account reads even when Electron wraps the rejection', () => {
    expect(formatAccountReadError(new Error("Error invoking remote method 'account:get-balance': Error: 账号上下文已变化，请重试"), 'balance')).toBeNull()
    expect(formatAccountReadError(new Error('账号上下文已变化，请重试'), 'session')).toBeNull()
    expect(formatAccountReadError(new Error('请先登录账号'), 'balance')).toBe('当前登录已失效，请重新登录。')
  })

  it('keeps current-account failures actionable without transport internals', () => {
    expect(formatAccountReadError(new Error("Error invoking remote method 'account:get-balance': RealmAccountError: 账号服务暂时无法连接"), 'balance')).toBe('余额暂时没有读到，请检查网络后重试。')
    expect(formatAccountReadError(new Error('Failed to fetch'), 'session')).toBe('账号信息暂时没有读到，请检查网络后重试。')
    expect(formatAccountReadError(new Error("Error invoking remote method 'account:get-session': Error: unexpected response"), 'session')).toBe('账号信息暂时没有读到，请稍后重试。')
    expect(formatAccountReadError(null, 'balance')).toBe('余额暂时没有读到，请稍后重试。')
  })
})
