import { describe, expect, it } from 'vitest'
import { diagnosticNetworkSettings, networkSettingsUnavailableMessages } from './network-settings-fix'

describe('network settings buttons on the check page', () => {
  it('offers the network settings on a DNS row the main process marked', () => {
    expect(diagnosticNetworkSettings({ code: 'RELAY_DNS', state: 'fail', details: { fix: 'open-dns-settings' } }))
      .toEqual({ kind: 'dns', label: '打开网络设置' })
    expect(diagnosticNetworkSettings({ code: 'RELAY_DNS', state: 'warn', details: { fix: 'open-dns-settings', reroute: 'auto' } }))
      .toEqual({ kind: 'dns', label: '打开网络设置' })
  })
  it('offers the proxy settings on a proxy row the main process marked', () => {
    expect(diagnosticNetworkSettings({ code: 'SYSTEM_PROXY_SOFTWARE', state: 'warn', details: { systemProxy: 'dead', proxyPort: 7890, fix: 'open-proxy-settings' } }))
      .toEqual({ kind: 'proxy', label: '打开系统代理设置' })
  })
  it('offers nothing on a passing row, an unmarked row or a row borrowing the other mark', () => {
    expect(diagnosticNetworkSettings({ code: 'RELAY_DNS', state: 'pass', details: { fix: 'open-dns-settings' } })).toBeNull()
    // Linux 上主进程不放 fix：没有能直接打开的设置页。
    expect(diagnosticNetworkSettings({ code: 'RELAY_DNS', state: 'fail', details: { line1: 'wrong', line2: 'wrong' } })).toBeNull()
    expect(diagnosticNetworkSettings({ code: 'SYSTEM_PROXY_SOFTWARE', state: 'warn' })).toBeNull()
    expect(diagnosticNetworkSettings({ code: 'RELAY_DNS', state: 'fail', details: { fix: 'open-proxy-settings' } })).toBeNull()
    expect(diagnosticNetworkSettings({ code: 'PROXY_ENVIRONMENT', state: 'warn', details: { fix: 'open-proxy-settings' } })).toBeNull()
  })
  it('points to the system settings when the page could not be opened', () => {
    expect(networkSettingsUnavailableMessages.dns).toBe('没能打开网络设置，请在系统设置里找「网络」。')
    expect(networkSettingsUnavailableMessages.proxy).toBe('没能打开系统代理设置，请在系统设置里找「代理」。')
  })
})
