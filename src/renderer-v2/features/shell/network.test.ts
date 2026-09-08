import { describe, expect, it } from 'vitest'
import { networkLocationLabel } from './network'

describe('renderer v2 network location label', () => {
  it('shows the localized country and public IP returned by the system scan', () => {
    expect(networkLocationLabel({
      region: 'mainland-china',
      countryCode: 'cn',
      publicIp: '203.0.113.8',
      checkedAt: '2026-09-08T00:00:00.000Z',
      error: null,
    })).toBe('中国 · 203.0.113.8')
  })

  it('keeps a valid country visible when the probe has no IP', () => {
    expect(networkLocationLabel({
      region: 'outside-mainland-china',
      countryCode: 'US',
      publicIp: null,
      checkedAt: '2026-09-08T00:00:00.000Z',
      error: '地址未返回',
    })).toBe('美国 · IP 未知')
  })

  it('uses an explicit unknown label for missing or incomplete probe data', () => {
    expect(networkLocationLabel(undefined)).toBe('网络位置未知')
    expect(networkLocationLabel({
      region: 'unknown',
      countryCode: 'CN',
      publicIp: '203.0.113.8',
      checkedAt: '2026-09-08T00:00:00.000Z',
      error: '网络位置服务不可用',
    })).toBe('网络位置未知')
  })
})
