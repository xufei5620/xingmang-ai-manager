import { describe, expect, it } from 'vitest'
import { networkFailureMessages, proxyAuthRequiredMessage } from '../../../../electron/network-failure'
import { isLocalNetworkFailure, isOffline, localNetworkFailureReason, offlineBannerTexts, offlineCause, offlineFailureThreshold } from './online-status'
import { balanceFailureLabel, balanceStatusText } from './balance-status'

describe('renderer-v2 online status', () => {
  it('trusts the browser when it reports no network at all', () => {
    expect(isOffline({ browserOnline: false, networkFailures: 0 })).toBe(true)
    expect(isOffline({ browserOnline: true, networkFailures: 0 })).toBe(false)
  })

  it('needs consecutive local network failures before calling a connected browser offline', () => {
    expect(offlineFailureThreshold).toBe(2)
    expect(isOffline({ browserOnline: true, networkFailures: 1 })).toBe(false)
    expect(isOffline({ browserOnline: true, networkFailures: 2 })).toBe(true)
  })

  it('counts only failures on the local side of the connection', () => {
    for (const reason of ['offline', 'dns', 'proxy', 'intercepted'] as const) {
      expect(isLocalNetworkFailure(new Error(networkFailureMessages[reason]))).toBe(true)
    }
    expect(isLocalNetworkFailure(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(true)
    expect(isLocalNetworkFailure('getaddrinfo ENOTFOUND xm.solov.cc')).toBe(true)
    // A slow or down service is not the user's network; blaming it sends them to reboot the router.
    for (const reason of ['timeout', 'refused', 'tls', 'certDate', 'serviceUnavailable'] as const) {
      expect(isLocalNetworkFailure(new Error(networkFailureMessages[reason]))).toBe(false)
    }
    expect(isLocalNetworkFailure(new Error('当前登录已失效，请重新登录。'))).toBe(false)
    expect(isLocalNetworkFailure(null)).toBe(false)
  })
})

describe('renderer-v2 offline cause', () => {
  it('keeps the reason of a local network failure', () => {
    expect(localNetworkFailureReason(new Error(networkFailureMessages.proxy))).toBe('proxy')
    expect(localNetworkFailureReason('net::ERR_UNSAFE_REDIRECT')).toBe('intercepted')
    expect(localNetworkFailureReason(new Error(networkFailureMessages.timeout))).toBeNull()
  })

  it('tells a proxy that wants a password apart from one that is down', () => {
    const wrapped = new Error(`Error invoking remote method 'account:get-balance': NewApiNetworkError: ${proxyAuthRequiredMessage}（余额请求失败）`)
    expect(localNetworkFailureReason(wrapped)).toBe('proxyAuth')
    expect(isLocalNetworkFailure(wrapped)).toBe(true)
    expect(localNetworkFailureReason('net::ERR_PROXY_AUTH_UNSUPPORTED')).toBe('proxyAuth')
    expect(localNetworkFailureReason('net::ERR_PROXY_CONNECTION_FAILED')).toBe('proxy')
    expect(offlineCause({ browserOnline: true, networkFailureReason: 'proxyAuth' })).toBe('proxyAuth')
    expect(offlineCause({ browserOnline: false, networkFailureReason: 'proxyAuth' })).toBe('offline')
  })

  it('asks for the administrator or another network, not the proxy app, when the proxy wants a password', () => {
    // D32 单子上的原句，一字不改。
    expect(offlineBannerTexts.proxyAuth).toBe('电脑设置的代理要账号密码，星芒现在用不了它，请联系管理员或换个网络。')
    expect(offlineBannerTexts.proxyAuth).not.toContain('代理软件')
    expect(offlineBannerTexts.proxy).toBe('电脑里设置的代理连不上，所以现在上不了网。请重新打开你的代理软件，或者把系统代理关掉。')
  })

  it('tells a broken proxy and a sign-in portal apart from a plain outage', () => {
    expect(offlineCause({ browserOnline: true, networkFailureReason: 'proxy' })).toBe('proxy')
    expect(offlineCause({ browserOnline: true, networkFailureReason: 'intercepted' })).toBe('portal')
    expect(offlineCause({ browserOnline: true, networkFailureReason: 'dns' })).toBe('offline')
    expect(offlineCause({ browserOnline: true })).toBe('offline')
    // No network card at all wins over whatever the last request said.
    expect(offlineCause({ browserOnline: false, networkFailureReason: 'proxy' })).toBe('offline')
  })

  it('never names a site or a technical setting in the banner', () => {
    for (const text of Object.values(offlineBannerTexts)) {
      expect(text).not.toMatch(/solov|xm\.|PAC|DNS|HTTP|IP/i)
    }
  })
})

describe('renderer-v2 balance status while offline', () => {
  it('says the balance will refresh later instead of reporting an update failure', () => {
    const view = { balanceError: '余额暂时没有读到，请检查网络后重试。', balanceUpdatedAt: null }
    expect(balanceStatusText({ ...view, offline: true })).toBe('没网，稍后自动刷新；余额尚未更新')
    expect(balanceStatusText(view)).toBe('更新失败：余额暂时没有读到，请检查网络后重试。；余额尚未更新')
    expect(balanceFailureLabel(true)).toBe('没网，稍后自动刷新')
    expect(balanceFailureLabel(false)).toBe('更新失败')
  })

  it('names the day of the last balance update when it was not today', () => {
    // D60：缩在托盘里过了一夜，昨天读到的余额只写钟点看着像今天。
    const updated = new Date(2026, 10, 9, 14, 5, 3).getTime()
    expect(balanceStatusText({ balanceUpdatedAt: updated }, new Date(2026, 10, 9, 20, 0).getTime())).toBe('最后更新于 14:05:03')
    expect(balanceStatusText({ balanceUpdatedAt: updated }, new Date(2026, 10, 10, 8, 0).getTime())).toBe('最后更新于 昨天 14:05')
    expect(balanceStatusText({ balanceUpdatedAt: updated, balanceError: '余额暂时没有读到' }, new Date(2026, 10, 12, 8, 0).getTime()))
      .toBe('更新失败：余额暂时没有读到；最后更新于 11月9日 14:05')
  })

  it('keeps the loading and success wording unchanged when offline', () => {
    expect(balanceStatusText({ balanceLoading: true, offline: true })).toBe('正在刷新余额；余额尚未更新')
    expect(balanceStatusText({ offline: true })).toBe('余额尚未更新')
  })
})
