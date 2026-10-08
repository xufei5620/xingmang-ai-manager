import { describe, expect, it } from 'vitest'
import { classifyResolvedAddress, classifyRouteFailure, parseIpAddress, resolvedAddressCategories } from './route-failure-classifier'

// 合法地址一律用文档专用段（RFC 5737 / RFC 3849），不写任何真实服务器地址。
const legitimate = { cloudflare: false as const, ips: ['192.0.2.10', '2001:db8::10'] }
const cloudflare = { cloudflare: true as const }

describe('route-failure-classifier', () => {
  it('parses IPv4, IPv6 and IPv4-mapped literals and rejects anything else', () => {
    expect(parseIpAddress('192.0.2.10')).toEqual({ family: 4, value: 0xc000020an })
    expect(parseIpAddress('2001:db8::10')?.family).toBe(6)
    expect(parseIpAddress('::ffff:192.0.2.10')).toEqual({ family: 4, value: 0xc000020an })
    for (const value of ['', 'xm.solov.cc', '192.0.2.10:443', '[2001:db8::1]', '256.1.1.1', '01.2.3.4.5']) {
      expect(parseIpAddress(value)).toBeNull()
    }
  })

  it('labels each row of the classification table', () => {
    expect(classifyResolvedAddress('192.0.2.10', legitimate)).toBe('normal')
    expect(classifyResolvedAddress('2001:db8:0:0::10', legitimate)).toBe('normal')
    expect(classifyResolvedAddress('104.16.1.1', cloudflare)).toBe('normal')
    expect(classifyResolvedAddress('2606:4700::1', cloudflare)).toBe('normal')
    for (const address of ['198.18.0.5', '198.19.255.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '100.64.0.1', '127.0.0.1', 'fd00::1', 'fe80::1', '::1']) {
      expect(classifyResolvedAddress(address, legitimate), address).toBe('proxy')
    }
    expect(classifyResolvedAddress('203.0.113.7', legitimate)).toBe('unknown')
    // CF 线路的合法集合只有 CF 段：被解析到别处的是不认识的地址。
    expect(classifyResolvedAddress('192.0.2.10', cloudflare)).toBe('unknown')
  })

  it('calls it hijack only when the address is foreign, the handshake was rejected and the legal set is known', () => {
    expect(classifyRouteFailure({ addresses: ['203.0.113.7'], legitimate, tlsRejected: true })).toBe('hijack')
    expect(classifyRouteFailure({ addresses: ['203.0.113.7'], legitimate, tlsRejected: false })).toBe('unknown')
    expect(classifyRouteFailure({ addresses: ['203.0.113.7'], legitimate: null, tlsRejected: true })).toBe('unknown')
    expect(classifyRouteFailure({ addresses: ['198.18.0.5'], legitimate, tlsRejected: true })).toBe('proxy')
    expect(classifyRouteFailure({ addresses: ['192.0.2.10', '2001:db8::10'], legitimate, tlsRejected: true })).toBe('normal')
    expect(classifyRouteFailure({ addresses: [], legitimate, tlsRejected: true })).toBe('unknown')
  })

  it('logs categories, never the addresses', () => {
    expect(resolvedAddressCategories(['192.0.2.10', '198.18.0.5', '203.0.113.7'], legitimate)).toEqual({ normal: 1, proxy: 1, unknown: 1 })
  })
})
