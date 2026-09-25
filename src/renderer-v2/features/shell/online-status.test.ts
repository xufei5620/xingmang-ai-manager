import { describe, expect, it } from 'vitest'
import { networkFailureMessages } from '../../../../electron/network-failure'
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

  it('keeps the loading and success wording unchanged when offline', () => {
    expect(balanceStatusText({ balanceLoading: true, offline: true })).toBe('正在刷新余额；余额尚未更新')
    expect(balanceStatusText({ offline: true })).toBe('余额尚未更新')
  })
})
