import { describe, expect, it } from 'vitest'
import {
  classifyNetworkFailure,
  isJsonContentType,
  isServiceUnavailableResponse,
  matchNetworkFailureMessage,
  networkFailureMessages,
  networkFailureReasonForMessage,
  parsesAsJsonObject,
  updateNetworkFailureMessages,
  type NetworkFailureReason,
} from './network-failure'

const chromiumFailures: [string, NetworkFailureReason][] = [
  ['net::ERR_NAME_NOT_RESOLVED', 'dns'],
  ['net::ERR_CERT_AUTHORITY_INVALID', 'tls'],
  ['net::ERR_CERT_DATE_INVALID', 'certDate'],
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
  ['CERT_HAS_EXPIRED', 'certDate'],
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
  ])('reads the OpenSSL wording npm prints as a replaced certificate: %s', (message) => {
    expect(classifyNetworkFailure(new Error(message))).toBe('tls')
  })

  // 日期类是同一批错误码里唯一「跟网络无关」的一类：证书过没过期是拿本机时钟比出来
  // 的，所以它要在 tls 之前被截走，否则用户拿到的是一句「换一个网络再试」。
  it.each([
    'net::ERR_CERT_DATE_INVALID',
    'request to https://registry.npmjs.org/@anthropic-ai%2fclaude-code failed, reason: certificate has expired',
    'certificate is not yet valid',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
  ])('reads a certificate whose dates do not line up as a clock problem: %s', (message) => {
    expect(classifyNetworkFailure(new Error(message))).toBe('certDate')
  })

  // 新增一类只许截走日期那几句，别的证书失败必须还在 tls。
  it.each([
    'net::ERR_CERT_AUTHORITY_INVALID',
    'net::ERR_CERT_COMMON_NAME_INVALID',
    'net::ERR_SSL_PROTOCOL_ERROR',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'self signed certificate in certificate chain',
    'unable to get local issuer certificate',
  ])('leaves every other certificate failure on the replaced-certificate answer: %s', (message) => {
    expect(classifyNetworkFailure(new Error(message))).toBe('tls')
  })

  it('reaches the real reason through the cause chain fetch wraps it in', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    expect(classifyNetworkFailure(new TypeError('fetch failed', { cause }))).toBe('dns')
    expect(classifyNetworkFailure({ cause: { cause: new Error('net::ERR_CERT_DATE_INVALID') } })).toBe('certDate')
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

  it('sends the date failure to the system clock before it mentions the network', () => {
    for (const message of [networkFailureMessages.certDate, updateNetworkFailureMessages.certDate]) {
      expect(message).toContain('系统时间')
      // 「换个网络」只能排在对时后面：先换网络就是用户白折腾的那一轮。
      expect(message.indexOf('系统时间')).toBeLessThan(message.indexOf('网络'))
    }
  })

  it('returns null for text this module never wrote', () => {
    expect(matchNetworkFailureMessage('登录没有成功，输入已保留，请稍后重试')).toBeNull()
    expect(matchNetworkFailureMessage(undefined)).toBeNull()
    expect(matchNetworkFailureMessage(new Error(networkFailureMessages.dns))).toBe(networkFailureMessages.dns)
  })
})

describe('service unavailable responses', () => {
  const html = { get: (name: string) => (name === 'content-type' ? 'text/html' : null) }

  it('recognizes gateway statuses whatever the body says', () => {
    for (const status of [502, 503, 504, 520, 521, 522, 523, 524, 525, 526]) {
      expect([status, isServiceUnavailableResponse({ status, json: true })]).toEqual([status, true])
    }
  })

  it('recognizes any 5xx that answers with something other than JSON', () => {
    expect(isServiceUnavailableResponse({ status: 500, json: false, headers: html })).toBe(true)
    expect(isServiceUnavailableResponse({ status: 500, json: true })).toBe(false)
  })

  it('recognizes an edge challenge on a 403 and nothing else', () => {
    expect(isServiceUnavailableResponse({ status: 403, json: false, headers: new Headers({ 'cf-mitigated': 'challenge' }) })).toBe(true)
    expect(isServiceUnavailableResponse({ status: 403, json: false, headers: new Headers({ server: 'cloudflare' }) })).toBe(true)
    expect(isServiceUnavailableResponse({ status: 403, json: false, bodyText: '<title>Just a moment...</title>' })).toBe(true)
    // new-api 自己的 403（Key 被禁用、额度用完）是 JSON，必须保持原意。
    expect(isServiceUnavailableResponse({ status: 403, json: true, headers: new Headers({ server: 'cloudflare' }) })).toBe(false)
    expect(isServiceUnavailableResponse({ status: 403, json: false })).toBe(false)
  })

  it('never calls a 2xx, a 401 or a 429 an outage', () => {
    // 2xx 回一张网页是门户认证替服务器答了话，与检查页的判法一致。
    for (const status of [200, 204, 401, 404, 429]) {
      expect([status, isServiceUnavailableResponse({ status, json: false, headers: html, bodyText: '<title>Just a moment...</title>' })]).toEqual([status, false])
    }
  })

  it('stays clear of the words the renderer\'s fallback patterns treat as login or network trouble', () => {
    for (const message of [networkFailureMessages.serviceUnavailable, updateNetworkFailureMessages.serviceUnavailable]) {
      expect(message).not.toMatch(/登录|Key|密钥|网络|连接|超时|Cloudflare/i)
    }
  })

  it('reads JSON from content-type and from a body the caller already has', () => {
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true)
    expect(isJsonContentType('application/problem+json')).toBe(true)
    expect(isJsonContentType('text/html')).toBe(false)
    expect(isJsonContentType(null)).toBe(false)
    expect(parsesAsJsonObject('{"error":{}}')).toBe(true)
    expect(parsesAsJsonObject('<html></html>')).toBe(false)
    expect(parsesAsJsonObject('')).toBe(false)
  })
})
