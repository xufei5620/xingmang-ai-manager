import { describe, expect, it } from 'vitest'
import {
  formatDownloadProxyUrl,
  isLoopbackDownloadProxy,
  parseChromiumProxyResult,
  subprocessDownloadProxyEnvironment,
} from './download-proxy'

describe('parseChromiumProxyResult', () => {
  it('reads the first entry of a proxy list', () => {
    expect(parseChromiumProxyResult('PROXY 127.0.0.1:7890;DIRECT')).toEqual({
      scheme: 'http', host: '127.0.0.1', port: 7890,
    })
  })

  it('maps the scheme keywords Chromium can return', () => {
    expect(parseChromiumProxyResult('HTTPS proxy.example.com:443')?.scheme).toBe('https')
    expect(parseChromiumProxyResult('SOCKS5 127.0.0.1:1080')?.scheme).toBe('socks5')
    expect(parseChromiumProxyResult('socks 127.0.0.1:1080')?.scheme).toBe('socks5')
  })

  it('reads a bracketed IPv6 authority', () => {
    expect(parseChromiumProxyResult('PROXY [::1]:7890')).toEqual({
      scheme: 'http', host: '[::1]', port: 7890,
    })
  })

  it('treats a direct or unusable answer as no proxy', () => {
    for (const value of [
      'DIRECT',
      '',
      '   ',
      'PROXY',
      'PROXY 127.0.0.1',
      'PROXY 127.0.0.1:0',
      'PROXY 127.0.0.1:70000',
      'PROXY 127.0.0.1:80x',
      'PROXY user:pass@127.0.0.1:7890',
      'PROXY 127.0.0.1:7890/path',
      'UNKNOWN 127.0.0.1:7890',
      `PROXY ${'a'.repeat(3000)}:1`,
      undefined,
      null,
      42,
    ]) {
      expect(parseChromiumProxyResult(value as unknown)).toBeNull()
    }
  })

  it('never falls through to a later entry when the first is direct', () => {
    expect(parseChromiumProxyResult('DIRECT;PROXY 10.0.0.1:8080')).toBeNull()
  })
})

describe('isLoopbackDownloadProxy', () => {
  it('accepts the addresses a local acceleration core listens on', () => {
    for (const host of ['127.0.0.1', '127.9.9.9', 'localhost', 'LOCALHOST', '[::1]']) {
      expect(isLoopbackDownloadProxy({ scheme: 'http', host, port: 7890 })).toBe(true)
    }
  })

  it('rejects any host that leaves this machine', () => {
    for (const host of ['10.0.0.1', 'proxy.example.com', '127.0.0.1.evil.com']) {
      expect(isLoopbackDownloadProxy({ scheme: 'http', host, port: 7890 })).toBe(false)
    }
  })
})

describe('subprocessDownloadProxyEnvironment', () => {
  it('passes a loopback proxy to the package manager', () => {
    expect(subprocessDownloadProxyEnvironment({ scheme: 'http', host: '127.0.0.1', port: 7890 })).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      http_proxy: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
    })
  })

  it('never hands an elevated subprocess a proxy outside this machine', () => {
    expect(subprocessDownloadProxyEnvironment({ scheme: 'http', host: 'proxy.example.com', port: 8080 })).toEqual({})
  })

  it('returns nothing when the route is direct', () => {
    expect(subprocessDownloadProxyEnvironment(null)).toEqual({})
  })
})

describe('formatDownloadProxyUrl', () => {
  it('keeps the scheme Chromium reported', () => {
    expect(formatDownloadProxyUrl({ scheme: 'socks5', host: '127.0.0.1', port: 1080 }))
      .toBe('socks5://127.0.0.1:1080')
  })
})
