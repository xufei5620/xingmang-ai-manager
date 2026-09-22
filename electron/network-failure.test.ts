import { describe, expect, it } from 'vitest'
import {
  classifyNetworkFailure,
  matchNetworkFailureMessage,
  networkFailureMessages,
  networkFailureReasonForMessage,
  updateNetworkFailureMessages,
  type NetworkFailureReason,
} from './network-failure'

const chromiumFailures: [string, NetworkFailureReason][] = [
  ['net::ERR_NAME_NOT_RESOLVED', 'dns'],
  ['net::ERR_CERT_AUTHORITY_INVALID', 'tls'],
  ['net::ERR_SSL_PROTOCOL_ERROR', 'tls'],
  ['net::ERR_CONNECTION_REFUSED', 'refused'],
  ['net::ERR_CONNECTION_RESET', 'refused'],
  ['net::ERR_EMPTY_RESPONSE', 'refused'],
  ['net::ERR_CONNECTION_TIMED_OUT', 'timeout'],
  ['net::ERR_INTERNET_DISCONNECTED', 'offline'],
  ['net::ERR_PROXY_CONNECTION_FAILED', 'proxy'],
  ['net::ERR_TUNNEL_CONNECTION_FAILED', 'proxy'],
  ['net::ERR_UNSAFE_REDIRECT', 'intercepted'],
  ['net::ERR_TOO_MANY_REDIRECTS', 'intercepted'],
]

const nodeFailures: [string, NetworkFailureReason][] = [
  ['ENOTFOUND', 'dns'],
  ['EAI_AGAIN', 'dns'],
  ['ECONNREFUSED', 'refused'],
  ['ECONNRESET', 'refused'],
  ['ETIMEDOUT', 'timeout'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'],
  ['ENETUNREACH', 'offline'],
]

describe('restricted network failure classification', () => {
  it.each(chromiumFailures)('reads the Chromium net error %s as %s', (message, reason) => {
    expect(classifyNetworkFailure(new Error(message))).toBe(reason)
  })

  it.each(nodeFailures)('reads the Node error code %s as %s', (code, reason) => {
    expect(classifyNetworkFailure(Object.assign(new Error('request failed'), { code }))).toBe(reason)
  })

  // npm 走 OpenSSL，说的是散句不是 errno：公司网关换掉证书时，装 CLI 这条路上
  // 拿到的原文长这样。只认 errno 会让同一个网关在账号那侧认得出、安装那侧认不出。
  it.each([
    'request to https://registry.npmjs.org/@anthropic-ai%2fclaude-code failed, reason: self signed certificate in certificate chain',
    'unable to get local issuer certificate',
    'unable to verify the first certificate',
    'certificate has expired',
  ])('reads the OpenSSL wording npm prints as a replaced certificate: %s', (message) => {
    expect(classifyNetworkFailure(new Error(message))).toBe('tls')
  })

  it('reaches the real reason through the cause chain fetch wraps it in', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    expect(classifyNetworkFailure(new TypeError('fetch failed', { cause }))).toBe('dns')
    expect(classifyNetworkFailure({ cause: { cause: new Error('net::ERR_CERT_DATE_INVALID') } })).toBe('tls')
  })

  // 门户劫持是受限网络里唯一一类「请求成功地到了别的地方」的失败。要求
  // redirect:'error' 的调用方看不到那个 3xx：undici 把它变成 fetch failed，真正
  // 的原因只在 cause 的 'unexpected redirect' 这句里。
  it('reads the redirect undici refuses under redirect:error as a captive portal', () => {
    expect(classifyNetworkFailure(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })))
      .toBe('intercepted')
  })

  it('stops walking causes instead of following a cycle', () => {
    const outer: { message: string; cause?: unknown } = { message: 'outer' }
    outer.cause = outer
    expect(classifyNetworkFailure(outer)).toBeNull()
  })

  it('answers null for a failure that is not about the network', () => {
    expect(classifyNetworkFailure(new Error('账号或密码错误，请检查后重试'))).toBeNull()
    expect(classifyNetworkFailure(new Error(''))).toBeNull()
    expect(classifyNetworkFailure(null)).toBeNull()
    expect(classifyNetworkFailure(undefined)).toBeNull()
    expect(classifyNetworkFailure(42)).toBeNull()
  })

  it('prefers the certificate answer when an interception also reports a reset', () => {
    expect(classifyNetworkFailure(new Error('net::ERR_SSL_PROTOCOL_ERROR ECONNRESET'))).toBe('tls')
  })

  it('only reads the head of an oversized body so a captured page cannot drive the answer', () => {
    const padded = `${'x'.repeat(4_000)} net::ERR_NAME_NOT_RESOLVED`
    expect(classifyNetworkFailure(new Error(padded))).toBeNull()
  })
})

describe('restricted network failure copy', () => {
  it('round-trips every reason through the message the main process throws', () => {
    for (const reason of Object.keys(networkFailureMessages) as NetworkFailureReason[]) {
      const wrapped = `Error invoking remote method 'account:login': Error: ${networkFailureMessages[reason]}（账号登录请求失败）`
      expect(networkFailureReasonForMessage(wrapped)).toBe(reason)
      expect(matchNetworkFailureMessage(wrapped)).toBe(networkFailureMessages[reason])
      expect(classifyNetworkFailure(new Error(wrapped))).toBe(reason)
    }
  })

  it('never names a site, a domain or an internal code in copy the user reads', () => {
    for (const message of Object.values(networkFailureMessages)) {
      expect(message).not.toMatch(/solov|sub2api|new-api|http|ERR_|E[A-Z]{5,}/i)
      expect(message.endsWith('。')).toBe(true)
    }
  })

  it('keeps the update wording off the account subject it does not apply to', () => {
    for (const reason of Object.keys(networkFailureMessages) as NetworkFailureReason[]) {
      const message = updateNetworkFailureMessages[reason]
      // 更新器连的是静态更新目录，既不是账号服务也不涉及输密码；照抄登录那张表
      // 会让一次更新失败读起来像账号出了问题。
      expect(message).not.toMatch(/账号|密码/)
      expect(message).not.toMatch(/solov|sub2api|new-api|http|ERR_|E[A-Z]{5,}/i)
      expect(message.endsWith('。')).toBe(true)
    }
  })

  it('returns null for text this module never wrote', () => {
    expect(matchNetworkFailureMessage('登录没有成功，输入已保留，请稍后重试')).toBeNull()
    expect(matchNetworkFailureMessage(undefined)).toBeNull()
    expect(matchNetworkFailureMessage(new Error(networkFailureMessages.dns))).toBe(networkFailureMessages.dns)
  })
})
