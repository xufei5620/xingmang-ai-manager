import { describe, expect, it } from 'vitest'
import { accountReadErrorAction, formatAccountReadError } from './account-read-error'
import { networkFailureMessages } from '../../../../electron/network-failure'

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

  it('says the service is down rather than asking to check the network or log in again', () => {
    const wrapped = new Error(`Error invoking remote method 'account:get-balance': Error: ${networkFailureMessages.serviceUnavailable}（HTTP 502）`)
    const message = formatAccountReadError(wrapped, 'balance')
    expect(message).toContain(networkFailureMessages.serviceUnavailable)
    expect(message).not.toMatch(/检查网络|重新登录/)
  })

  it('asks to sign in again when the account API says the login is gone in its own words', () => {
    // #1095：new-api 的 401 原话翻成中文后不带「重新登录」，以前落到「请稍后重试」，重读多少次都一样。
    for (const raw of [
      "Error invoking remote method 'account:get-balance': NewApiAuthenticationError: 无权进行此操作，access token 无效",
      '无权进行此操作，未登录且未提供 access token',
      '访问令牌已过期',
    ]) {
      expect(formatAccountReadError(new Error(raw), 'balance')).toBe('当前登录已失效，请重新登录。')
    }
  })

  it('reads the same reason whichever error class the main process threw', () => {
    // #1073 第9条：剥前缀改用渲染层共用的那一份，这几种主进程类名剥完要和以前一字不差。
    const balance = (text: string) => formatAccountReadError(new Error(`Error invoking remote method 'account:get-balance': ${text}`), 'balance')
    for (const reason of Object.keys(networkFailureMessages) as (keyof typeof networkFailureMessages)[]) {
      const message = balance(`NewApiNetworkError: ${networkFailureMessages[reason]}（余额请求失败）`)
      expect(message).toBe(reason === 'serviceUnavailable' ? `余额暂时没有读到：${networkFailureMessages.serviceUnavailable}` : '余额暂时没有读到，请检查网络后重试。')
    }
    expect(balance('NewApiSessionChangedError: 账号已切换，本次请求结果已丢弃，请重试')).toBe('余额暂时没有读到，请稍后重试。')
    expect(balance('NewApiCredentialPersistenceError: 登录凭据已更新，但安全存储保存失败，请重试')).toBe('余额暂时没有读到，请稍后重试。')
    expect(balance('AccountSourceServiceUnavailableError: ' + networkFailureMessages.serviceUnavailable)).toBe(`余额暂时没有读到：${networkFailureMessages.serviceUnavailable}`)
    expect(balance('RealmAccountError: 账号服务请求超时')).toBe('余额暂时没有读到，请检查网络后重试。')
    expect(balance('RealmAccountError: 账号服务请求失败，请重试')).toBe('余额暂时没有读到，请稍后重试。')
    expect(balance('RealmAccountError: 登录已失效，请重新登录')).toBe('当前登录已失效，请重新登录。')
    expect(balance('RealmAccountError: 请先登录账号')).toBe('当前登录已失效，请重新登录。')
    expect(balance('RealmAccountError: 账号上下文已变化，请重试')).toBeNull()
    expect(balance('TypeError: fetch failed')).toBe('余额暂时没有读到，请检查网络后重试。')
    expect(balance('AbortError: This operation was aborted')).toBe('余额暂时没有读到，请稍后重试。')
  })

  it('asks to check the network for every failure the main process already called a network one', () => {
    // 历史账号走 RealmAccountError，星芒账号走 NewApiNetworkError，「代理连不上」那句以前前者说「稍后重试」、
    // 后者说「检查网络」，差别只在类名里有没有 Network。剥掉类名以后两边都按句子认。
    for (const cls of ['RealmAccountError', 'NewApiNetworkError', 'Error']) {
      expect(formatAccountReadError(new Error(`Error invoking remote method 'account:get-balance': ${cls}: ${networkFailureMessages.proxy}`), 'balance')).toBe('余额暂时没有读到，请检查网络后重试。')
    }
  })

  it('offers a way to sign in again only when the message asks for it', () => {
    expect(accountReadErrorAction(formatAccountReadError(new Error('请先登录账号'), 'session') ?? '')).toBe('relogin')
    expect(accountReadErrorAction(formatAccountReadError(new Error('Failed to fetch'), 'session') ?? '')).toBe('retry')
    expect(accountReadErrorAction(formatAccountReadError(new Error('unexpected response'), 'session') ?? '')).toBe('retry')
  })
})
