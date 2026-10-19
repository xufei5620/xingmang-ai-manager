/**
 * 星芒自己的请求按线路走（直连适配第二步）。
 *
 * 账号、余额、AI 工作区的对话画图视频这些请求，调用方照旧按默认线路的地址发（账号客户端、
 * sub2api-relay-backend.ts 里都写死着默认线路），这里按这个站这会儿走的线路换掉地址。选
 * 「自动」时，走着的那条没走通就当场改走另一条重发一次：走的是先走的那条（星芒账号是直连，历史账号是
 * 默认线路，relay-sites.ts 的 relayAutoPreferredLines）就改走备用那条，已经退到备用那条就改回先走的
 * 那条（#1053：备用那条自己也会坏，换了网络以后常常是它先坏）。下面按走着直连说，走着默认线路时两条
 * 对调（白名单 404 除外，白名单只在直连上有）：
 *
 * - 会退回的：解析不出地址、连不上、TLS 握手失败、连接被断、超时；代理回绝了直连这个地址（只放行
 *   老域名的公司网关、按域名列规则的代理）；网关 502/503/504 回的网页；直连回的别的网页或跳转（拦截页、
 *   上网认证）；直连回的网页形式的 404（白名单挡下了这个接口，只记日志，不算直连坏了）。退到直连、直连
 *   只回了白名单 404 的，交回走着那条的结果：那张 404 网页说明不了这次为什么没走通。
 * - 不退回的：401、403、429、余额不足这些业务错误（服务回的是 JSON），代理软件本身没开（换哪条都一样，
 *   归 proxy-bypass.ts 管），本来就会跳转的接口回的跳转（redirectingPaths），以及调用方自己中止的。
 * - 会改动数据的请求（下单、建 Key、充值、AI 生成）只在请求肯定还没送到服务器时才重发：解析
 *   不出、连不上、证书没通过校验、代理回绝、白名单 404、被跳转拦下。送出去以后才断的不重发，握手做到
 *   一半被掐断的也不重发（分不清请求是不是已经写出去了），免得重复下单、重复扣费。
 * - 只读的请求在走着的那条上等了 relayLineAnswerWaitMs 还没等来回应头（被丢包时就是这样，Chromium 自己
 *   要等二十秒到两分钟才报连接超时，早过了调用方的时限），就在另一条上也发一次，谁先回了能用的话用谁，
 *   另一个掐掉。不掐走着的这一次：服务端查得慢（用量明细）的请求照样能在它上面回来。这样换线路那一次
 *   至少还剩调用方时限减去这几秒，不会被前一次耗光（#1053）。
 * - 回了话以后正文读到一半断了（AI 回复写到一半）：已经交给调用方的回应没法重发。
 *
 * 报给线路那边的只有网络层的失败（解析不出地址、连不上、TLS 失败、连接被重置或断开、代理回绝了
 * 直连这个地址）、回话的不是星芒（拦截页、跳转、网关错误页），和等到时限连回应头都没等来（直连被
 * 丢包时就是这样；另一条先回了话也算）；报的是这一次走的那条，报上去只是叫它马上查一轮健康检查，改不改
 * 线路只看健康检查（#941 第 3 节）。回应头到了以后正文下得慢不报：直连下行只有几十 KB/s 的客户，大一点
 * 的回应本来就要下一阵，不算直连坏了。公告整个不报，它下得再慢、下不下来都不影响线路。
 *
 * 写进工具配置之前那几次查模型、工具自检用的是另一个（createRelayObservedFetch）：它们查的
 * 正是那条线路通不通，不换地址也不重发，只按上面的口径把直连上的失败报给线路那边。
 */
import { classifyNetworkFailure, isHtmlContentType, isJsonContentType, networkFailureCode, type NetworkFailureReason } from './network-failure'
import {
  relayAutoBackupLine,
  relayAutoPreferredLines,
  relayEndpointForUrl,
  relayEndpointOrigin,
  type RelayEndpointId,
  type RelayRouteSiteId,
} from './relay-sites'
import { noteRequestDiagnostics } from './request-diagnostics'
import { watchResponseBody } from './response-body-watch'

export interface RelayLineRouter {
  /** 一个站这会儿走哪条线路；automatic 为真时（「自动」）走着的那条没走通可以改走另一条。 */
  route(siteId: RelayRouteSiteId): { line: RelayEndpointId; automatic: boolean }
  /** 这条线路上的请求没走通（白名单 404 不算），交给线路那边再查一次（relay-route-controller.ts 的 reportFailure）。 */
  reportFailure(siteId: RelayRouteSiteId, line: RelayEndpointId, reason: string): void
  /** 线路改了就叫一声；返回取消订阅。 */
  subscribe(listener: (siteId: RelayRouteSiteId) => void): () => void
}

export interface RelayLineFetchOptions {
  /**
   * 调用方只会因为自己等到时限才中止（账号请求：10 秒没回话就放弃）。中止时连回应头都没等来，直连多半
   * 这会儿不通：被丢包的地址就是这样，Chromium 自己要等二十秒到两分钟才报连接超时，早过了调用方的时限。
   * 这时报给线路那边查一轮健康检查；这一次不重发，调用方已经不等了。正文读到一半被中止照旧不报，那是
   * 回应大、读得慢。AI 对话、画图中止多半是客户点了「停止」，不给这个选项。
   */
  abortMeansNoAnswer?: boolean
  log?(level: 'info' | 'warn', event: string, message: string, detail: Record<string, unknown>): void
}

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

// 报给线路那边的失败：网络层连不上一类，加上跳转被拒（门户认证、拦截页的另一种样子）。超时只认连接
// 超时（连不上）；请求整个等太久（AbortSignal.timeout 的 TimeoutError）分不清是没回话还是正文读得慢，
// 不在这里认，由知道自己还没拿到回应头的那一段另报（createRelayLineFetch 的 noAnswerFailure）。
const reportedReasons: ReadonlySet<NetworkFailureReason> = new Set(['offline', 'dns', 'tls', 'certDate', 'refused', 'proxy', 'intercepted'])
const connectTimeoutCodes: ReadonlySet<string> = new Set(['ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT', 'ETIMEDOUT'])

// 发验证码、发重置邮件虽然是 GET，服务端每收到一次就寄一封信、记一个新码，新码顶掉上一封的
// （new-api-client.ts 给它们标了 idempotent: false，那个标记到不了 fetch 这一层）。照会改动数据的请求办：
// 线路改了不掐，失败只在证明没送到时重发。不然客户收到两封信，填先到的那封报验证码不对（#963）。
const mailingPaths: ReadonlySet<string> = new Set(['/api/verification', '/api/reset_password'])

// 公告：下得慢、下不下来都不报给线路那边（#941 第 4 节）。
const unreportedPaths: ReadonlySet<string> = new Set(['/api/notice'])

const gatewayStatuses: ReadonlySet<number> = new Set([502, 503, 504])

// 星芒这几个站的接口除了下面那一个都不跳转。manual-redirect-fetch.ts 照 Node 的 fetch 把跳转原样交回来
// （3xx 带 Location），门户认证、拦截设备回的正是它。
const redirectStatuses: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

// 中转站本来就会跳转的接口：视频生成完了下载成片，中转站可以跳到对象存储的签名地址，ai-video-service.ts
// 自己一跳一跳地查 Location、去掉 Authorization 再跟。这里回的 3xx 是星芒的回话，不算被拦、不换线路重发，
// 也不叫线路那边查（#1157 第 3 条）。
const redirectingPaths: readonly RegExp[] = [/^\/v1\/videos\/[^/]+\/content$/]

function pathMayRedirect(path: string): boolean {
  return redirectingPaths.some((pattern) => pattern.test(path))
}

/** 这个星芒地址回跳转是正常的（redirectingPaths）；直连分流（proxy-bypass.ts）也按它认。 */
export function relayAnswerMayRedirect(url: string): boolean {
  try {
    return pathMayRedirect(new URL(url).pathname)
  } catch {
    return false
  }
}

/**
 * 这里自己掐掉的那一次用的中止原因：另一条线路先回了能用的话，或者线路改走了另一条。下面那层直连分流
 * （proxy-bypass.ts 的 createSiteFetch）见到它就知道这不是直连不通，账号请求也不叫它再看一次（#1157 第 4 条）。
 */
class RelayLineCancel extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayLineCancel'
  }
}

/** 中止原因是这里自己掐的（RelayLineCancel），不是调用方中止、也不是等到了时限。 */
export function isRelayLineCancel(reason: unknown): boolean {
  return reason instanceof RelayLineCancel
}

/**
 * 只读的请求在走着的那条上等这么久还没等来回应头，就在另一条上也发一次（文件头）。和检查页「自动」给先走
 * 那条单独限的时间一样（diagnostics-network-checks.ts 的 PREFERRED_NETWORK_PROBE_TIMEOUT_MS）：账号请求的时限是 10 秒，
 * 另一条至少还剩 6 秒。平时一秒内就回，直连下行只有几十 KB/s 时回应头也早到了，慢的是正文。
 */
export const relayLineAnswerWaitMs = 4_000

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

function isRedirectAnswer(response: Response): boolean {
  return response.type === 'opaqueredirect' || redirectStatuses.has(response.status)
}

/**
 * 直连回的不是星芒的回话：网页（拦截页、上网认证页、网关的错误页）或者跳转。本来就会跳转的接口
 * （redirectingPaths）回的跳转不算，连它带着的那点网页正文也不看：Go 的 http.Redirect 给 GET 回跳转时
 * 带的就是一小段 text/html。
 */
function answeredBySomeoneElse(response: Response, redirectExpected: boolean): boolean {
  if (isRedirectAnswer(response)) return !redirectExpected
  return isHtmlContentType(response.headers.get('content-type'))
}

/**
 * 直连上的这个回应说明直连这会儿没走通，就给出报给线路那边的原因（白名单 404 只挡这一个接口，不报，
 * 由调用方另说）；服务自己回的话（JSON，流式正文）给 null。检查页也按这个认。redirectExpected 为真时
 * 跳转也是服务自己回的话（redirectingPaths）。
 */
export function relayLineFailureAnswer(response: Response, redirectExpected = false): string | null {
  if (gatewayFailure(response)) return `http-${response.status}`
  if (blockedByAllowlist(response)) return null
  return answeredBySomeoneElse(response, redirectExpected) ? 'intercepted' : null
}

/** 换一条线路有可能走得通的失败（检查页、更新检查也按这个认），这一次请求可以换线路重发；别的返回 null。 */
export function relayLineFailureReason(error: unknown): NetworkFailureReason | null {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout'
  const reason = classifyNetworkFailure(error)
  if (reason === 'proxy') return networkFailureCode(error) === tunnelRefusedCode ? reason : null
  return reason && lineFailureReasons.has(reason) ? reason : null
}

/**
 * 上面那些里要报给线路那边的（解析不出地址、连不上、TLS 失败、连接被重置或断开、代理回绝了直连这个
 * 地址、跳转被拒），给出报上去的原因（错误码，取不到就是归类）；请求自己超时、被人中止返回 null。
 * 检查页、更新检查也按这个决定报不报。
 */
export function reportedRelayLineFailure(error: unknown): string | null {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return null
  const reason = relayLineFailureReason(error)
  if (!reason) return null
  const code = networkFailureCode(error)
  if (reason === 'timeout') return code !== null && connectTimeoutCodes.has(code) ? code : null
  return reportedReasons.has(reason) ? code ?? reason : null
}

/**
 * fetch() 还没交出回应就超时了（它自己报的 TimeoutError，或者归成超时的错误码）：等到时限还没等来回应头，
 * 直连被丢包时就是这样。只在拿到回应以前那一段用，正文读得慢不算。报上去也只是叫线路那边查一轮健康
 * 检查，换不换线路由它连着查过再定（#941 第 3 节）。
 */
function noAnswerFailure(error: unknown): string | null {
  return relayLineFailureReason(error) === 'timeout' ? networkFailureCode(error) ?? 'no-answer' : null
}

/**
 * 证书没通过校验：Chromium 先验完证书才把请求写出去。只认 ERR_CERT_*，tls 那一类里 ERR_SSL_ 开头的不认：
 * 证书换了（ERR_SSL_SERVER_CERT_CHANGED）是连接用到一半重新握手时报的，那时请求可能已经写出去了。Node 的
 * 证书散句（测试里的 fetch）没有错误码，照证书失败算。
 */
function certificateRejected(error: unknown, reason: NetworkFailureReason): boolean {
  if (reason !== 'tls' && reason !== 'certDate') return false
  const code = networkFailureCode(error)
  return code === null || code.startsWith('ERR_CERT_')
}

/**
 * 会改动数据的请求能不能换一条线路重发：只有肯定还没送到服务器的才行。握手做到一半被掐断的
 * （ERR_SSL_PROTOCOL_ERROR、ERR_QUIC_HANDSHAKE_FAILED 这类，#1060 归 refused）不算：路上的设备在建好的连接上
 * 破坏 TLS 记录时 Chromium 报的也是它，QUIC 还会在握手没完时就把请求发出去，重发可能多签一把 Key、多下一单
 * （#1157 第 6 条）。
 */
function provablyUnsent(error: unknown, reason: NetworkFailureReason): boolean {
  if (reason === 'dns' || certificateRejected(error, reason)) return true
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

function otherLine(siteId: RelayRouteSiteId, line: RelayEndpointId): RelayEndpointId {
  return line === relayAutoPreferredLines[siteId] ? relayAutoBackupLine(siteId) : relayAutoPreferredLines[siteId]
}

/** 一次请求最后怎么了：回了话，或者失败了。不抛错，两条线路一起等时谁先回来都能接着往下看。 */
type AttemptOutcome = { response: Response; error?: undefined } | { response?: undefined; error: unknown }

interface LineAttempt {
  line: RelayEndpointId
  url: string
  controller: AbortController
  outcome: Promise<AttemptOutcome>
}

type LineRaceEvent = { from: 'first' | 'second'; outcome: AttemptOutcome } | { from: 'wait' }

/**
 * 交出去的回应、抛出去的失败都挂上这一次实际走的线路（request-diagnostics.ts）：客户说登不上、Key 配不上时，
 * 日志按它记走的是直连还是默认线路（三线路 7b）。served 在请求结束时才读，中途退回默认线路改了它也算数。
 */
async function onServedLine(served: { line?: RelayEndpointId }, send: () => Promise<Response>): Promise<Response> {
  try {
    const response = await send()
    noteRequestDiagnostics(response, served)
    return response
  } catch (error) {
    noteRequestDiagnostics(error, served)
    throw error
  }
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
    const served: { line?: RelayEndpointId } = {}
    return onServedLine(served, () => routed(requested, endpoint.siteId, init, served))
  }
  async function routed(requested: string, siteId: RelayRouteSiteId, init: RequestInit | undefined, served: { line?: RelayEndpointId }): Promise<Response> {
    const route = router.route(siteId)
    served.line = route.line
    const sent = onLine(requested, siteId, route.line)
    // 正文是流的发出去就没了，没法重发：照旧走这条线路，不退回。
    const replayable = !(init?.body instanceof ReadableStream)
    if (!route.automatic || !replayable) return asRequested(await base(sent, init), sent, requested)
    const line = route.line
    const other = otherLine(siteId, line)

    const path = new URL(requested).pathname
    const idempotent = isIdempotent(init) && !mailingPaths.has(path)
    const redirectExpected = pathMayRedirect(path)
    const callerSignal = init?.signal ?? undefined
    const method = (init?.method ?? 'GET').toUpperCase()
    function report(reason: string): void {
      if (!unreportedPaths.has(path)) router.reportFailure(siteId, line, reason)
    }
    function logFallback(reason: string): void {
      log('info', 'relay.line.fallback', '走着的那条线路这次没走通，改走另一条重发', { siteId, from: line, to: other, reason, method, path })
    }
    function logBlocked(message: string): void {
      log('warn', 'relay.line.blocked', message, { siteId, line: 'direct', method, path })
    }
    // 退到的是直连，直连回的却是白名单 404：那张网页只说明直连不放行这个接口，盖掉的是走着那条真正的错
    // （连接被切断、网关错误页），客户看到「HTTP 404」会和客服一起找错方向。交回走着那条的结果（#1157 第 2 条）。
    function blockedOnTheWayBack(response: Response): boolean {
      if (other !== 'direct' || !blockedByAllowlist(response)) return false
      logBlocked('线路2没放行这个接口，交回线路1这次的结果')
      return true
    }
    // current 是走着那条这次的结果（失败，或者不能用、还没丢掉的回应），另一条也只回了白名单 404 时交回它；
    // 走着那条本身就是白名单 404 的给 null。
    async function fallBack(reason: string, current: AttemptOutcome | null): Promise<Response> {
      const target = onLine(requested, siteId, other)
      served.line = other
      logFallback(reason)
      let response: Response
      try {
        response = await base(target, init)
      } catch (error) {
        if (current?.response) await discard(current.response)
        throw error
      }
      if (current && blockedOnTheWayBack(response)) {
        await discard(response)
        served.line = line
        if (!current.response) throw current.error
        return asRequested(current.response, sent, requested)
      }
      if (current?.response) await discard(current.response)
      return asRequested(response, target, requested)
    }
    // 走着的那条回的话不能用就给出退回的原因：白名单 404 只挡这一个接口，不报给线路那边；回话的不是星芒
    // （网关错误页、拦截页、跳转）要报。白名单只在直连上有，走着默认线路时碰上网页 404 照原样交回去。
    function unusableAnswer(response: Response): { reason: string; reported: boolean } | null {
      if (line === 'direct' && blockedByAllowlist(response)) return { reason: 'allowlist-404', reported: false }
      const failure = relayLineFailureAnswer(response, redirectExpected)
      return failure ? { reason: failure, reported: true } : null
    }
    // 回了话以后正文读到一半断了（连接被重置）：这一次没法重发，只报给线路那边查一轮。调用方自己中止的
    // 不报：账号请求读一个大回应读到超时，那是慢，不是线路坏了（10-7 公告就是这样被当成直连坏了）。
    function handOver(response: Response): Response {
      const watched = watchResponseBody(response, () => {
        if (!callerSignal?.aborted) report('body')
      })
      return asRequested(watched, sent, requested)
    }

    if (!idempotent) {
      // 会改动数据的请求：不掐、不同时发两次，只在证明没送到时重发（文件头）。
      let response: Response
      try {
        response = await base(sent, init)
      } catch (error) {
        // 调用方自己中止的（等到时限、客户点了「停止」）不重发。账号请求连回应头都没等来就到了时限，叫线路
        // 那边查一轮（abortMeansNoAnswer）；别的中止不报。
        if (callerSignal?.aborted) {
          if (options.abortMeansNoAnswer) report('no-answer')
          throw error
        }
        const reason = relayLineFailureReason(error)
        if (!reason) throw error
        const reported = reportedRelayLineFailure(error) ?? noAnswerFailure(error)
        if (reported) report(reported)
        if (provablyUnsent(error, reason)) return fallBack(networkFailureCode(error) ?? reason, { error })
        throw error
      }
      const unusable = unusableAnswer(response)
      if (unusable?.reason === 'allowlist-404') {
        // 白名单挡下的是这一个接口，请求没进到服务里：照样重发，后面的请求照样先走直连。
        await discard(response)
        logBlocked('线路2没放行这个接口，这次改走线路1')
        return fallBack('allowlist-404', null)
      }
      if (unusable) report(unusable.reason)
      // 被跳转拦下（上网认证、拦截设备）：星芒会改动数据的接口从来不跳转，回了跳转就是请求没进到服务里，
      // 跟白名单 404 一样换一条线路重发（#1157 第 7 条）。网页、网关错误页分不清送没送到，照旧不重发。
      if (unusable && isRedirectAnswer(response)) return fallBack(unusable.reason, { response })
      return handOver(response)
    }
    return readOnBothLines()

    // 只读的请求（文件头）：走着的那条没走通、回的话不能用、线路那边已经换了线路（开机那次查的结论、别的
    // 请求报上去查出来的），或者等了 relayLineAnswerWaitMs 还没等来回应头，就在另一条上发一次。等不来的那
    // 一种不掐走着的这一次，两条谁先回了能用的话用谁；另一条也没回能用的话，照退回那一次的结果原样交回去。
    async function readOnBothLines(): Promise<Response> {
      function launch(onto: RelayEndpointId): LineAttempt {
        const controller = new AbortController()
        const url = onLine(requested, siteId, onto)
        const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal
        let outcome: Promise<AttemptOutcome>
        try {
          outcome = base(url, { ...init, signal }).then((response) => ({ response }), (error: unknown) => ({ error }))
        } catch (error) {
          outcome = Promise.resolve({ error })
        }
        return { line: onto, url, controller, outcome }
      }
      // 不要了的那一次：掐掉，晚到的回应把正文丢掉，连接好早点放回去。
      function drop(attempt: LineAttempt | null): void {
        if (!attempt) return
        attempt.controller.abort(new RelayLineCancel('另一条线路已经回了话'))
        void attempt.outcome.then((outcome) => outcome.response ? discard(outcome.response) : undefined)
      }

      const first = launch(line)
      let firstPending = true
      let second: LineAttempt | null = null
      let secondPending = false
      // 另一条先回来、可走着的这条还没回的时候，它的结果先放着。
      let secondOutcome: AttemptOutcome | null = null
      // 走着的这条失败了、回的话不能用的时候，它的结果也先放着：另一条只回了白名单 404 的话交回它
      // （blockedOnTheWayBack）。线路改了被这里掐掉的那一次没什么可交回的，不放。
      let firstOutcome: AttemptOutcome | null = null
      let lineChanged = false
      const unsubscribe = router.subscribe((changed) => {
        if (changed !== siteId || router.route(siteId).line === line) return
        lineChanged = true
        first.controller.abort(new RelayLineCancel('线路已改走另一条'))
      })
      let waitOver: () => void = () => undefined
      const waited = new Promise<'waited'>((resolve) => { waitOver = () => resolve('waited') })
      const waitTimer = setTimeout(waitOver, relayLineAnswerWaitMs)
      waitTimer.unref?.()
      // 回来的是哪一条到时候再记（secondFinal）：走着的这条后回来、用的是它的话，记的还是它。
      function launchSecond(reason: string): LineAttempt {
        clearTimeout(waitTimer)
        if (reason === 'no-answer') {
          log('info', 'relay.line.hedge', '走着的那条线路等了一阵还没回话，在另一条上也发一次', {
            siteId, from: line, to: other, waitMs: relayLineAnswerWaitMs, method, path,
          })
        } else {
          logFallback(reason)
        }
        return launch(other)
      }
      function secondFinal(outcome: AttemptOutcome, attempt: LineAttempt): Response {
        const kept = firstOutcome
        if (kept && outcome.response && blockedOnTheWayBack(outcome.response)) {
          void discard(outcome.response)
          firstOutcome = null
          if (!kept.response) throw kept.error
          return asRequested(kept.response, first.url, requested)
        }
        served.line = other
        if (!outcome.response) throw outcome.error
        return asRequested(outcome.response, attempt.url, requested)
      }
      try {
        for (;;) {
          const waiting: Array<Promise<LineRaceEvent>> = []
          if (firstPending) waiting.push(first.outcome.then((outcome): LineRaceEvent => ({ from: 'first', outcome })))
          if (second && secondPending) waiting.push(second.outcome.then((outcome): LineRaceEvent => ({ from: 'second', outcome })))
          if (!second) waiting.push(waited.then((): LineRaceEvent => ({ from: 'wait' })))
          const next = await Promise.race(waiting)
          if (next.from === 'wait') {
            // 等满了还没等来回应头：在另一条上也发一次，走着的这一次照样等着。
            second = launchSecond('no-answer')
            secondPending = true
            continue
          }
          const outcome = next.outcome
          if (next.from === 'second') {
            const attempt = second
            if (!attempt) continue
            secondPending = false
            if (!firstPending) return secondFinal(outcome, attempt)
            if (outcome.response && !relayLineFailureAnswer(outcome.response, redirectExpected) && !(other === 'direct' && blockedByAllowlist(outcome.response))) {
              // 另一条先回了能用的话：用它，走着的这条连回应头都没等来，报给线路那边。
              drop(first)
              report('no-answer')
              return secondFinal(outcome, attempt)
            }
            secondOutcome = outcome
            continue
          }
          firstPending = false
          if (outcome.response) {
            const unusable = unusableAnswer(outcome.response)
            if (!unusable) {
              drop(second)
              return handOver(outcome.response)
            }
            if (unusable.reported) {
              firstOutcome = outcome
              report(unusable.reason)
            } else {
              await discard(outcome.response)
              logBlocked('线路2没放行这个接口，这次改走线路1')
            }
            if (secondOutcome && second) return secondFinal(secondOutcome, second)
            if (!second) {
              second = launchSecond(unusable.reason)
              secondPending = true
            }
            continue
          }
          const error = outcome.error
          // 调用方自己中止的（等到时限、客户点了「停止」）不重发。账号请求连回应头都没等来就到了时限，叫线路
          // 那边查一轮（abortMeansNoAnswer）；别的中止不报。
          if (callerSignal?.aborted) {
            drop(second)
            if (options.abortMeansNoAnswer) report('no-answer')
            throw error
          }
          let reason: string
          if (lineChanged) {
            reason = 'line-changed'
          } else {
            const failure = relayLineFailureReason(error)
            if (!failure) {
              drop(second)
              throw error
            }
            // 走到这里还没拿到回应：超时的也报（noAnswerFailure），正文读得慢的在 handOver 那段，不报。
            const reported = reportedRelayLineFailure(error) ?? noAnswerFailure(error)
            if (reported) report(reported)
            reason = networkFailureCode(error) ?? failure
            firstOutcome = outcome
          }
          if (secondOutcome && second) return secondFinal(secondOutcome, second)
          if (!second) {
            second = launchSecond(reason)
            secondPending = true
          }
        }
      } finally {
        clearTimeout(waitTimer)
        unsubscribe()
        // 放着没交回去的那份回应把正文丢掉。
        if (firstOutcome?.response) void discard(firstOutcome.response)
      }
    }
  }
  return fetchOnLine
}

/** 星芒账号的工具线路（xm 三线路 5.2）：写配置前查模型、工具自检在它上面没走通，报给它而不是应用线路。 */
export interface RelayToolLineObserver {
  /** 星芒账号这会儿写进工具配置的那条线路，以及是不是「自动」（只有「自动」会换线）。 */
  route(): { line: RelayEndpointId; automatic: boolean }
  /** 叫工具线路那边查一轮（tool-route-controller.ts 的 reportFailure），不直接计入连败。 */
  reportFailure(trigger: string): void
}

/**
 * 写进工具配置之前查模型、工具自检用的 fetch：查的正是工具会用的那条线路通不通，所以不换地址、
 * 不重发；「自动」的站在这会儿走的那条上连不上时只报给线路那边，由它查过健康检查再决定要不要换。
 * 给了 toolLine 时星芒账号改报工具线路：打在工具线路上的（洛杉矶、CF 都算）没走通就报给它；历史账号
 * 报这会儿走的那条（先走的默认线路，或者已经退到的直连）、报给应用线路。
 */
export function createRelayObservedFetch(
  router: RelayLineRouter,
  base: typeof fetch,
  options: Pick<RelayLineFetchOptions, 'log'> & { toolLine?: RelayToolLineObserver } = {},
): typeof fetch {
  function reporterFor(endpoint: { siteId: RelayRouteSiteId; endpointId: RelayEndpointId }): ((reason: string) => void) | null {
    const toolLine = options.toolLine
    if (endpoint.siteId === 'solov' && toolLine) {
      const route = toolLine.route()
      if (!route.automatic || route.line !== endpoint.endpointId) return null
      return (reason) => toolLine.reportFailure(`check:${reason}`)
    }
    const route = router.route(endpoint.siteId)
    if (!route.automatic || endpoint.endpointId !== route.line) return null
    return (reason) => router.reportFailure(endpoint.siteId, endpoint.endpointId, reason)
  }
  return async (input, init) => {
    const requested = requestUrl(input)
    const endpoint = requested === null ? null : relayEndpointForUrl(requested)
    if (requested === null || !endpoint) return base(input, init)
    // 这里不换地址，打到哪个地址就是哪条线路。
    return onServedLine({ line: endpoint.endpointId }, () => observed(input, init, requested, endpoint))
  }
  async function observed(
    input: string | URL | Request,
    init: RequestInit | undefined,
    requested: string,
    endpoint: { siteId: RelayRouteSiteId; endpointId: RelayEndpointId },
  ): Promise<Response> {
    const report = reporterFor(endpoint)
    if (!report) return base(input, init)
    let response: Response
    try {
      response = await base(input, init)
    } catch (error) {
      const reported = init?.signal?.aborted ? null : reportedRelayLineFailure(error) ?? noAnswerFailure(error)
      if (reported) report(reported)
      throw error
    }
    const failure = relayLineFailureAnswer(response, pathMayRedirect(new URL(requested).pathname))
    if (failure) report(failure)
    else if (endpoint.endpointId === 'direct' && blockedByAllowlist(response)) {
      try {
        options.log?.('warn', 'relay.line.blocked', '线路2没放行这个接口', {
          siteId: endpoint.siteId, line: 'direct', method: (init?.method ?? 'GET').toUpperCase(), path: new URL(requested).pathname,
        })
      } catch { /* 记日志失败不影响请求 */ }
    }
    return watchResponseBody(response, () => {
      if (!init?.signal?.aborted) report('body')
    })
  }
}
