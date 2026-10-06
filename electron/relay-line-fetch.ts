/**
 * 星芒自己的请求按线路走（直连适配第二步）。
 *
 * 账号、余额、AI 工作区的对话画图视频这些请求，调用方照旧按默认线路的地址发（账号客户端、
 * sub2api-relay-backend.ts 里都写死着默认线路），这里按这个站这会儿走的线路换掉地址。选
 * 「自动」、这会儿走直连时，直连没走通就当场改走默认线路重发一次：
 *
 * - 会退回的：解析不出地址、连不上、TLS 握手失败、连接被断、超时；代理回绝了直连这个地址（只放行
 *   老域名的公司网关、按域名列规则的代理）；网关 502/503/504 回的网页；直连回的别的网页或跳转（拦截页、
 *   上网认证）；直连回的网页形式的 404（白名单挡下了这个接口，只记日志，不算直连坏了）。
 * - 不退回的：401、403、429、余额不足这些业务错误（服务回的是 JSON），代理软件本身没开（换哪条都一样，
 *   归 proxy-bypass.ts 管），以及调用方自己中止的。
 * - 会改动数据的请求（下单、建 Key、充值、AI 生成）只在请求肯定还没送到服务器时才重发：解析
 *   不出、连不上、TLS 失败、代理回绝、白名单 404。送出去以后才断的不重发，免得重复下单、重复扣费。
 * - 回了话以后正文读到一半断了（AI 回复写到一半）：已经交给调用方的回应没法重发，只报给线路那边查一次。
 *
 * 写进工具配置之前那几次查模型、工具自检用的是另一个（createRelayObservedFetch）：它们查的
 * 正是那条线路通不通，不换地址也不重发，只把直连上的失败报给线路那边。
 */
import { classifyNetworkFailure, isHtmlContentType, isJsonContentType, networkFailureCode, type NetworkFailureReason } from './network-failure'
import { relayEndpointForUrl, relayEndpointOrigin, type RelayEndpointId, type RelayRouteSiteId } from './relay-sites'
import { watchResponseBody } from './response-body-watch'

export interface RelayLineRouter {
  /** 一个站这会儿走哪条线路；automatic 为真时（「自动」）直连没走通可以改走默认线路。 */
  route(siteId: RelayRouteSiteId): { line: RelayEndpointId; automatic: boolean }
  /** 直连上的请求没走通（白名单 404 不算），交给线路那边再查一次。 */
  reportDirectFailure(siteId: RelayRouteSiteId, reason: string): void
  /** 线路改了就叫一声；返回取消订阅。 */
  subscribe(listener: (siteId: RelayRouteSiteId) => void): () => void
}

export interface RelayLineFetchOptions {
  /**
   * 调用方自己中止的请求算不算直连不通。账号请求只会因为等太久没回话而中止，算；AI 聊天、
   * 画图中止多半是客户点了「停止」，不算（同 proxy-bypass.ts 的 SiteFetchOptions）。
   */
  abortMeansUnreachable?: boolean
  log?(level: 'info' | 'warn', event: string, message: string, detail: Record<string, unknown>): void
}

/**
 * 「自动」走直连时，只读的请求这么久还没回话就报给线路那边查一次直连。不掐它：直连只是慢的话
 * 接着等；查下来要改走默认线路，订阅那边会掐掉它、改走默认线路重发。账号请求 10 秒超时，
 * 这里加上一次检查的时间（relay-route-controller.ts 的 5 秒）还赶得上在超时前重发。
 */
export const relayDirectSlowResponseMs = 3_000

/**
 * 代理回绝了这一个地址：代理对 CONNECT 回 403、502 时 Chromium 报的是它（第三十八批在 Electron 上实测过），
 * 归类和代理软件没开一样是 proxy。只放行老域名的公司网关、按域名列规则的代理碰上直连域名就是这样，
 * 换默认线路有可能走得通；代理软件没开（ERR_PROXY_CONNECTION_FAILED）换哪条都一样。
 */
const tunnelRefusedCode = 'ERR_TUNNEL_CONNECTION_FAILED'

// 这些错误码出现时请求肯定还没送到服务器：连接都没建起来，或者代理没放它过去。
const unsentFailureCodes: ReadonlySet<string> = new Set([
  'ERR_NAME_NOT_RESOLVED', 'ERR_NAME_RESOLUTION_FAILED', 'ENOTFOUND', 'EAI_AGAIN',
  'ERR_CONNECTION_REFUSED', 'ECONNREFUSED', 'ERR_ADDRESS_UNREACHABLE', 'ERR_CONNECTION_FAILED',
  'ERR_CONNECTION_TIMED_OUT', 'ERR_INTERNET_DISCONNECTED', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH',
  tunnelRefusedCode,
])

// 跟线路有关的失败：换一条线路有可能走得通（被拦到别的页面也算：拦的可能只是直连域名）。代理软件
// 本身没开、服务自己说暂时不可用（JSON）不算。
const lineFailureReasons: ReadonlySet<NetworkFailureReason> = new Set(['offline', 'dns', 'tls', 'certDate', 'refused', 'timeout', 'intercepted'])

const gatewayStatuses: ReadonlySet<number> = new Set([502, 503, 504])

// 这几个状态码的回应不能带正文，重新包一层时也不能给。
const nullBodyStatuses: ReadonlySet<number> = new Set([101, 103, 204, 205, 304])

function requestUrl(input: string | URL | Request): string | null {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : null
}

function isIdempotent(init: RequestInit | undefined): boolean {
  const method = (init?.method ?? 'GET').toUpperCase()
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

// Swap scheme and host only. Re-resolving the path against the new origin would read a path that
// starts with '//' as a different host.
function onLine(url: string, siteId: RelayRouteSiteId, line: RelayEndpointId): string {
  const origin = relayEndpointOrigin(siteId, line)
  if (!origin) return url
  const target = new URL(url)
  const destination = new URL(origin)
  target.protocol = destination.protocol
  target.host = destination.host
  return target.href
}

/** 白名单挡下的接口：nginx 回的是网页，new-api 自己回的 404 是 JSON（:countTokens 这类本来就不支持的）。 */
function blockedByAllowlist(response: Response): boolean {
  return response.status === 404 && !isJsonContentType(response.headers.get('content-type'))
}

function gatewayFailure(response: Response): boolean {
  return gatewayStatuses.has(response.status) && !isJsonContentType(response.headers.get('content-type'))
}

/** 直连回的不是星芒的回话：网页（拦截页、上网认证页、网关的错误页）或者跳转。 */
function answeredBySomeoneElse(response: Response): boolean {
  return response.type === 'opaqueredirect' || isHtmlContentType(response.headers.get('content-type'))
}

/**
 * 直连上的这个回应说明直连这会儿没走通，就给出报给线路那边的原因（白名单 404 只挡这一个接口，不报，
 * 由调用方另说）；服务自己回的话（JSON，流式正文）给 null。检查页也按这个认。
 */
export function relayLineFailureAnswer(response: Response): string | null {
  if (gatewayFailure(response)) return `http-${response.status}`
  if (blockedByAllowlist(response)) return null
  return answeredBySomeoneElse(response) ? 'intercepted' : null
}

/** 换一条线路有可能走得通的失败（检查页、更新检查也按这个认）；别的返回 null。 */
export function relayLineFailureReason(error: unknown): NetworkFailureReason | null {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout'
  const reason = classifyNetworkFailure(error)
  if (reason === 'proxy') return networkFailureCode(error) === tunnelRefusedCode ? reason : null
  return reason && lineFailureReasons.has(reason) ? reason : null
}

function provablyUnsent(error: unknown, reason: NetworkFailureReason): boolean {
  if (reason === 'dns' || reason === 'tls' || reason === 'certDate') return true
  const code = networkFailureCode(error)
  return code !== null && unsentFailureCodes.has(code)
}

/**
 * The caller checks that the answer came from the URL it asked for (a redirect must never move an
 * authenticated request to another host). Only the origin was swapped here, so a response that was
 * not redirected and answers exactly the URL actually sent is handed back without that URL; anything
 * else (an opaque redirect, a followed redirect, a different URL) goes back untouched for the
 * caller's own checks to reject.
 */
function asRequested(response: Response, sent: string, requested: string): Response {
  if (sent === requested || response.type === 'opaqueredirect' || response.redirected) return response
  if (response.url && response.url !== sent) return response
  return new Response(nullBodyStatuses.has(response.status) ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

/**
 * 星芒自己的请求用的 fetch：认得出的星芒地址按这个站这会儿的线路换掉 origin，别的地址原样
 * 交给 base。base 是 proxy-bypass.ts 的 relayFetch / accountFetch，所以换完线路以后照旧
 * 按代理那边的分流走。
 */
export function createRelayLineFetch(router: RelayLineRouter, base: typeof fetch, options: RelayLineFetchOptions = {}): typeof fetch {
  function log(level: 'info' | 'warn', event: string, message: string, detail: Record<string, unknown>): void {
    try { options.log?.(level, event, message, detail) } catch { /* 记日志失败不影响请求 */ }
  }
  const fetchOnLine: typeof fetch = async (input, init) => {
    const requested = requestUrl(input)
    const endpoint = requested === null ? null : relayEndpointForUrl(requested)
    if (requested === null || !endpoint) return base(input, init)
    return routed(requested, endpoint.siteId, init)
  }
  async function routed(requested: string, siteId: RelayRouteSiteId, init: RequestInit | undefined): Promise<Response> {
    const route = router.route(siteId)
    const sent = onLine(requested, siteId, route.line)
    // 正文是流的发出去就没了，没法重发：照旧走这条线路，不退回。
    const replayable = !(init?.body instanceof ReadableStream)
    if (!route.automatic || route.line !== 'direct' || !replayable) return asRequested(await base(sent, init), sent, requested)

    const idempotent = isIdempotent(init)
    const callerSignal = init?.signal ?? undefined
    const path = new URL(requested).pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    async function fallBack(reason: string): Promise<Response> {
      const primary = onLine(requested, siteId, 'primary')
      log('info', 'relay.line.fallback', '直连这次没走通，改走默认线路重发', { siteId, from: 'direct', to: 'primary', reason, method, path })
      return asRequested(await base(primary, init), primary, requested)
    }

    // 只读的请求在直连上等着时，线路那边已经改走默认线路（开机那次查的结论、别的请求报上去
    // 查出来的）：不陪它等到超时，掐掉改走默认线路。会改动数据的请求不掐，它可能已经送到了。
    const lineChange = new AbortController()
    let lineChanged = false
    const unsubscribe = idempotent
      ? router.subscribe((changed) => {
        if (changed !== siteId || router.route(siteId).line === 'direct') return
        lineChanged = true
        lineChange.abort(new Error('线路已改走默认线路'))
      })
      : null
    const signal = unsubscribe
      ? callerSignal ? AbortSignal.any([callerSignal, lineChange.signal]) : lineChange.signal
      : callerSignal
    const slow = idempotent ? setTimeout(() => router.reportDirectFailure(siteId, 'slow'), relayDirectSlowResponseMs) : null
    slow?.unref?.()
    let response: Response
    try {
      response = await base(sent, unsubscribe ? { ...init, signal } : init)
    } catch (error) {
      if (callerSignal?.aborted) {
        if (options.abortMeansUnreachable) router.reportDirectFailure(siteId, 'timeout')
        throw error
      }
      if (lineChanged) return fallBack('line-changed')
      const reason = relayLineFailureReason(error)
      if (!reason) throw error
      router.reportDirectFailure(siteId, networkFailureCode(error) ?? reason)
      if (idempotent || provablyUnsent(error, reason)) return fallBack(networkFailureCode(error) ?? reason)
      throw error
    } finally {
      unsubscribe?.()
      if (slow) clearTimeout(slow)
    }
    if (blockedByAllowlist(response)) {
      // 白名单挡下的是这一个接口，直连本身是通的：不报给线路那边，后面的请求照样先走直连。
      await discard(response)
      log('warn', 'relay.line.blocked', '直连没放行这个接口，这次改走默认线路', { siteId, method, path })
      return fallBack('allowlist-404')
    }
    const failure = relayLineFailureAnswer(response)
    if (failure) {
      router.reportDirectFailure(siteId, failure)
      if (idempotent) {
        await discard(response)
        return fallBack(failure)
      }
    }
    // 回了话以后正文读到一半断了：这一次没法重发，只报给线路那边查一次直连。调用方自己中止的不算，
    // 账号请求除外（同上）。
    const watched = watchResponseBody(response, () => {
      if (options.abortMeansUnreachable || !callerSignal?.aborted) router.reportDirectFailure(siteId, 'body')
    })
    return asRequested(watched, sent, requested)
  }
  return fetchOnLine
}

/**
 * 写进工具配置之前查模型、工具自检用的 fetch：查的正是工具会用的那条线路通不通，所以不换地址、
 * 不重发；「自动」的站在直连上没走通时只报给线路那边，由它决定要不要退回。
 */
export function createRelayObservedFetch(router: RelayLineRouter, base: typeof fetch, options: Pick<RelayLineFetchOptions, 'log'> = {}): typeof fetch {
  return async (input, init) => {
    const requested = requestUrl(input)
    const endpoint = requested === null ? null : relayEndpointForUrl(requested)
    if (requested === null || !endpoint || endpoint.endpointId !== 'direct' || !router.route(endpoint.siteId).automatic) {
      return base(input, init)
    }
    const { siteId } = endpoint
    let response: Response
    try {
      response = await base(input, init)
    } catch (error) {
      const reason = init?.signal?.aborted ? null : relayLineFailureReason(error)
      if (reason) router.reportDirectFailure(siteId, networkFailureCode(error) ?? reason)
      throw error
    }
    const failure = relayLineFailureAnswer(response)
    if (failure) router.reportDirectFailure(siteId, failure)
    else if (blockedByAllowlist(response)) {
      try {
        options.log?.('warn', 'relay.line.blocked', '直连没放行这个接口', {
          siteId, method: (init?.method ?? 'GET').toUpperCase(), path: new URL(requested).pathname,
        })
      } catch { /* 记日志失败不影响请求 */ }
    }
    return watchResponseBody(response, () => {
      if (!init?.signal?.aborted) router.reportDirectFailure(siteId, 'body')
    })
  }
}
