import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRelayLineFetch,
  createRelayObservedFetch,
  relayLineFailureAnswer,
  relayLineAnswerWaitMs,
  relayLineFailureReason,
  reportedRelayLineFailure,
  type RelayLineRouter,
} from './relay-line-fetch'
import type { RelayEndpointId, RelayRouteSiteId } from './relay-sites'
import { requestDiagnosticsOf } from './request-diagnostics'

function fakeRouter(line: RelayEndpointId = 'direct', automatic = true) {
  const state = { line, automatic }
  const listeners = new Set<(siteId: RelayRouteSiteId) => void>()
  const reports: Array<[RelayRouteSiteId, string]> = []
  // 报的是哪条线路上的失败，和 reports 一一对应。
  const reportedLines: RelayEndpointId[] = []
  const router: RelayLineRouter = {
    route: () => ({ line: state.line, automatic: state.automatic }),
    reportFailure: (siteId, reportedLine, reason) => {
      reports.push([siteId, reason])
      reportedLines.push(reportedLine)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  function moveTo(next: RelayEndpointId, siteId: RelayRouteSiteId = 'solov') {
    state.line = next
    for (const listener of [...listeners]) listener(siteId)
  }
  return { router, reports, reportedLines, listeners, moveTo }
}

function networkError(code: string): Error {
  return new TypeError('fetch failed', { cause: new Error(`net::${code}`) })
}

function json(status: number, body: unknown = {}): Response {
  return Response.json(body, { status })
}

function page(status: number): Response {
  return new Response('<html>blocked</html>', { status, headers: { 'content-type': 'text/html' } })
}

function opaqueRedirect(): Response {
  const response = new Response(null, { status: 200 })
  Object.defineProperties(response, { type: { value: 'opaqueredirect' }, status: { value: 0 } })
  return response
}

function portalRedirect(): Response {
  return new Response(null, { status: 302, headers: { location: 'http://portal.example/login' } })
}

// 回了话、正文读到一半断了，跟 AI 回复写到一半连接断了一样。
function cutReply(onPull?: () => void): Response {
  let sent = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.()
      if (sent) controller.error(new TypeError('terminated', { cause: new Error('net::ERR_CONNECTION_RESET') }))
      else controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'))
      sent = true
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

// 每条线路上的请求都挂着，测试按主机名放回应或失败；被掐掉的记下主机名。
function hangingLines() {
  const pending = new Map<string, { resolve: (response: Response) => void; reject: (error: unknown) => void }>()
  const aborted: string[] = []
  const base = vi.fn<typeof fetch>((input, init) => new Promise<Response>((resolve, reject) => {
    const host = new URL(String(input)).host
    pending.set(host, { resolve, reject })
    init?.signal?.addEventListener('abort', () => {
      aborted.push(host)
      reject(new DOMException('aborted', 'AbortError'))
    })
  }))
  return {
    base,
    aborted,
    answer(host: string, response: Response) { pending.get(host)?.resolve(response) },
    fail(host: string, error: unknown) { pending.get(host)?.reject(error) },
  }
}

function sentUrls(base: ReturnType<typeof vi.fn>): string[] {
  return base.mock.calls.map((call) => String(call[0]))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createRelayLineFetch', () => {
  it('moves a registered origin onto the current line and leaves every other address alone', async () => {
    const { router } = fakeRouter('direct', false)
    const base = vi.fn<typeof fetch>(async () => json(200))
    const routed = createRelayLineFetch(router, base)

    await routed('https://xm.solov.cc/api/user/self?page=1')
    await routed('https://api.solov.cc/api/v1/auth/me')
    // A path that starts with '//' stays a path: only scheme and host change.
    await routed('https://xm.solov.cc//evil.example/v1/models')
    await routed('https://other.example/v1/models')
    await routed('https://38.147.105.28:8443/v1/models')
    const request = new Request('https://xm.solov.cc/api/status')
    await routed(request)

    expect(sentUrls(base)).toEqual([
      'https://xm-direct.solov.cc/api/user/self?page=1',
      'https://api-direct.solov.cc/api/v1/auth/me',
      'https://xm-direct.solov.cc//evil.example/v1/models',
      'https://other.example/v1/models',
      'https://38.147.105.28:8443/v1/models',
      String(request),
    ])
    expect(base.mock.calls[5][0]).toBe(request)
  })

  it('hands back a moved answer without its URL, and a redirected one untouched for the caller to reject', async () => {
    const { router } = fakeRouter('direct', false)
    const answered = json(201, { ok: true })
    Object.defineProperty(answered, 'url', { value: 'https://xm-direct.solov.cc/api/user/self' })
    const redirected = json(200)
    Object.defineProperty(redirected, 'redirected', { value: true })
    Object.defineProperty(redirected, 'url', { value: 'https://elsewhere.example/login' })
    const responses = [answered, redirected]
    const routed = createRelayLineFetch(router, vi.fn<typeof fetch>(async () => responses.shift()!))

    const first = await routed('https://xm.solov.cc/api/user/self')
    expect(first).not.toBe(answered)
    expect(first.url).toBe('')
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual({ ok: true })
    expect(await routed('https://xm.solov.cc/api/user/self')).toBe(redirected)
  })

  it('resends a read once on the default line when direct fails on the line', async () => {
    const { router, reports } = fakeRouter()
    const log = vi.fn()
    const base = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(networkError('ERR_NAME_NOT_RESOLVED'))
      .mockResolvedValueOnce(json(200, { data: [] }))
    const routed = createRelayLineFetch(router, base, { log })

    const response = await routed('https://xm.solov.cc/v1/models', { headers: { Authorization: 'Bearer sk-fixture' } })

    expect(response.status).toBe(200)
    expect(sentUrls(base)).toEqual(['https://xm-direct.solov.cc/v1/models', 'https://xm.solov.cc/v1/models'])
    expect(base.mock.calls[1][1]?.headers).toEqual({ Authorization: 'Bearer sk-fixture' })
    expect(reports).toEqual([['solov', 'ERR_NAME_NOT_RESOLVED']])
    expect(log).toHaveBeenCalledWith('info', 'relay.line.fallback', expect.any(String),
      { siteId: 'solov', from: 'direct', to: 'primary', reason: 'ERR_NAME_NOT_RESOLVED', method: 'GET', path: '/v1/models' })
    expect(JSON.stringify(log.mock.calls)).not.toContain('sk-fixture')
  })

  it('falls back for gateway pages, pages someone else answered with and an allowlist 404, never for answers the service itself gave', async () => {
    const cases: Array<{ answer: () => Response; fellBack: boolean; reported: string | null }> = [
      { answer: () => page(502), fellBack: true, reported: 'http-502' },
      { answer: () => page(504), fellBack: true, reported: 'http-504' },
      // 白名单挡下的是那一个接口，直连本身是通的：改走默认线路，但不报。
      { answer: () => page(404), fellBack: true, reported: null },
      // 公司网关、上网认证替服务答的话：拦的可能只是直连域名。
      { answer: () => page(200), fellBack: true, reported: 'intercepted' },
      { answer: () => page(403), fellBack: true, reported: 'intercepted' },
      { answer: () => page(500), fellBack: true, reported: 'intercepted' },
      { answer: opaqueRedirect, fellBack: true, reported: 'intercepted' },
      // main.ts 给每个 Chromium 会话包的 manual-redirect-fetch.ts 把跳转原样交回：不带正文的 3xx（#1064）。
      { answer: portalRedirect, fellBack: true, reported: 'intercepted' },
      { answer: () => json(404, { error: 'Invalid URL' }), fellBack: false, reported: null },
      { answer: () => json(503, { error: 'busy' }), fellBack: false, reported: null },
      { answer: () => json(401), fellBack: false, reported: null },
      { answer: () => json(403), fellBack: false, reported: null },
      { answer: () => json(429), fellBack: false, reported: null },
    ]
    for (const { answer, fellBack, reported } of cases) {
      const { router, reports } = fakeRouter()
      const first = answer()
      const base = vi.fn<typeof fetch>().mockResolvedValueOnce(first).mockResolvedValueOnce(json(200))
      const response = await createRelayLineFetch(router, base)('https://xm.solov.cc/api/status')
      expect(base).toHaveBeenCalledTimes(fellBack ? 2 : 1)
      expect(response.status).toBe(fellBack ? 200 : first.status)
      expect(reports).toEqual(reported ? [['solov', reported]] : [])
    }
  })

  it('resends a write only when it provably never reached the server', async () => {
    async function post(failure: Error | Response) {
      const { router, reports } = fakeRouter()
      const base = vi.fn<typeof fetch>()
      if (failure instanceof Error) base.mockRejectedValueOnce(failure)
      else base.mockResolvedValueOnce(failure)
      base.mockResolvedValueOnce(json(200))
      const outcome = await createRelayLineFetch(router, base)('https://xm.solov.cc/api/user/pay', { method: 'POST', body: '{"amount":10}' })
        .then((response) => response.status, (error: unknown) => error)
      return { outcome, sent: sentUrls(base), reports }
    }

    // 代理回绝了直连这个地址（ERR_TUNNEL_CONNECTION_FAILED）：连接都没建起来。
    for (const code of ['ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_REFUSED', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_CONNECTION_TIMED_OUT', 'ERR_TUNNEL_CONNECTION_FAILED']) {
      const result = await post(networkError(code))
      expect(result.outcome).toBe(200)
      expect(result.sent).toEqual(['https://xm-direct.solov.cc/api/user/pay', 'https://xm.solov.cc/api/user/pay'])
    }
    // 送出去以后才断的、被跳转到别处的：可能已经下了单，不重发。
    for (const code of ['ERR_CONNECTION_RESET', 'ERR_TIMED_OUT', 'ERR_EMPTY_RESPONSE', 'ERR_NETWORK_CHANGED', 'ERR_UNSAFE_REDIRECT']) {
      const result = await post(networkError(code))
      expect(result.outcome).toBeInstanceOf(TypeError)
      expect(result.sent).toEqual(['https://xm-direct.solov.cc/api/user/pay'])
      expect(result.reports).toEqual([['solov', code]])
    }
    const gateway = await post(page(502))
    expect(gateway.outcome).toBe(502)
    expect(gateway.sent).toHaveLength(1)
    expect(gateway.reports).toEqual([['solov', 'http-502']])
    const intercepted = await post(page(200))
    expect(intercepted.outcome).toBe(200)
    expect(intercepted.sent).toHaveLength(1)
    expect(intercepted.reports).toEqual([['solov', 'intercepted']])
    const redirected = await post(portalRedirect())
    expect(redirected.outcome).toBe(302)
    expect(redirected.sent).toHaveLength(1)
    expect(redirected.reports).toEqual([['solov', 'intercepted']])
    const blocked = await post(page(404))
    expect(blocked.outcome).toBe(200)
    expect(blocked.sent).toEqual(['https://xm-direct.solov.cc/api/user/pay', 'https://xm.solov.cc/api/user/pay'])
  })

  // 这两个 GET 每发一次服务端就寄一封信（#963）：和写请求一样，只在证明没送到时重发，线路改了也不掐。
  it('treats the GETs that send an email like writes', async () => {
    for (const path of ['/api/verification?email=user%40example.com', '/api/reset_password?email=user%40example.com']) {
      async function get(failure: Error | Response) {
        const { router, reports } = fakeRouter()
        const base = vi.fn<typeof fetch>()
        if (failure instanceof Error) base.mockRejectedValueOnce(failure)
        else base.mockResolvedValueOnce(failure)
        base.mockResolvedValueOnce(json(200))
        const outcome = await createRelayLineFetch(router, base)(`https://xm.solov.cc${path}`, { method: 'GET' })
          .then((response) => response.status, (error: unknown) => error)
        return { outcome, sent: sentUrls(base), reports }
      }
      const unsent = await get(networkError('ERR_CONNECTION_REFUSED'))
      expect(unsent.outcome).toBe(200)
      expect(unsent.sent).toEqual([`https://xm-direct.solov.cc${path}`, `https://xm.solov.cc${path}`])
      for (const failure of [networkError('ERR_CONNECTION_RESET'), networkError('ERR_TIMED_OUT')]) {
        const result = await get(failure)
        expect(result.outcome).toBeInstanceOf(TypeError)
        expect(result.sent).toEqual([`https://xm-direct.solov.cc${path}`])
        expect(result.reports).toHaveLength(1)
      }
      const gateway = await get(page(504))
      expect(gateway.outcome).toBe(504)
      expect(gateway.sent).toHaveLength(1)
      expect(gateway.reports).toEqual([['solov', 'http-504']])

      // 线路在它等回话时改走默认线路：不掐、不重发，照旧在直连上等回来。
      const { router, moveTo, listeners } = fakeRouter()
      let answer: (response: Response) => void = () => undefined
      const base = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { answer = resolve }))
      const pending = createRelayLineFetch(router, base)(`https://xm.solov.cc${path}`)
      await vi.waitFor(() => expect(base).toHaveBeenCalledTimes(1))
      expect(listeners.size).toBe(0)
      moveTo('primary')
      answer(json(200))
      expect((await pending).status).toBe(200)
      expect(sentUrls(base)).toEqual([`https://xm-direct.solov.cc${path}`])
    }
  })

  it('falls back when the proxy refuses the direct address or a portal redirects it', async () => {
    for (const code of ['ERR_TUNNEL_CONNECTION_FAILED', 'ERR_UNSAFE_REDIRECT']) {
      const { router, reports } = fakeRouter()
      const base = vi.fn<typeof fetch>().mockRejectedValueOnce(networkError(code)).mockResolvedValueOnce(json(200))
      expect((await createRelayLineFetch(router, base)('https://xm.solov.cc/api/status')).status).toBe(200)
      expect(sentUrls(base)).toEqual(['https://xm-direct.solov.cc/api/status', 'https://xm.solov.cc/api/status'])
      expect(reports).toEqual([['solov', code]])
    }
  })

  // Electron 的 net.fetch 碰到跳转不交回 opaqueredirect，只报这一句（#1064）：只读的退回备用线路；
  // 写请求可能已经送到，不重发。两种都报给线路那边。
  it('treats the redirect net.fetch gives up on like a portal redirect', async () => {
    const read = fakeRouter()
    const readBase = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('Redirect was cancelled')).mockResolvedValueOnce(json(200))
    expect((await createRelayLineFetch(read.router, readBase)('https://xm.solov.cc/api/user/self')).status).toBe(200)
    expect(sentUrls(readBase)).toEqual(['https://xm-direct.solov.cc/api/user/self', 'https://xm.solov.cc/api/user/self'])
    expect(read.reports).toEqual([['solov', 'intercepted']])

    const write = fakeRouter()
    const writeBase = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('Redirect was cancelled')).mockResolvedValueOnce(json(200))
    await expect(createRelayLineFetch(write.router, writeBase)('https://xm.solov.cc/api/user/login', { method: 'POST', body: '{}' }))
      .rejects.toThrow('Redirect was cancelled')
    expect(sentUrls(writeBase)).toEqual(['https://xm-direct.solov.cc/api/user/login'])
    expect(write.reports).toEqual([['solov', 'intercepted']])
  })

  it('leaves a proxy that is not running and the caller\'s own abort to the caller', async () => {
    // 代理软件本身没开，换哪条线路都一样（归 proxy-bypass.ts 管）。
    const proxyOff = fakeRouter()
    const proxyBase = vi.fn<typeof fetch>().mockRejectedValueOnce(networkError('ERR_PROXY_CONNECTION_FAILED'))
    await expect(createRelayLineFetch(proxyOff.router, proxyBase)('https://xm.solov.cc/api/status')).rejects.toThrow('fetch failed')
    expect(proxyBase).toHaveBeenCalledTimes(1)
    expect(proxyOff.reports).toEqual([])

    // 客户点了「停止」：说不上直连有没有毛病，不报（#941 第 3 节）。
    const { router, reports } = fakeRouter()
    const caller = new AbortController()
    const base = vi.fn<typeof fetch>(async () => {
      caller.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(createRelayLineFetch(router, base)('https://xm.solov.cc/v1/chat/completions', { method: 'POST', body: '{}', signal: caller.signal }))
      .rejects.toThrow('aborted')
    expect(base).toHaveBeenCalledTimes(1)
    expect(reports).toEqual([])
  })

  // 账号请求等到自己的时限（10 秒）还没拿到回应头就放弃：直连被丢包时就是这样，Chromium 自己要等
  // 二十秒到两分钟才报连接超时，早过了那个时限。叫线路那边查一轮，换不换由它定。
  it('asks for a line check when an account request gives up before any answer, and stays silent once a reply started', async () => {
    const { router, reports } = fakeRouter()
    const caller = new AbortController()
    const base = vi.fn<typeof fetch>(async () => {
      caller.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    const accountFetch = createRelayLineFetch(router, base, { abortMeansNoAnswer: true })
    await expect(accountFetch('https://xm.solov.cc/api/user/self', { signal: caller.signal })).rejects.toThrow('aborted')
    expect(reports).toEqual([['solov', 'no-answer']])

    // 回应头来了、正文读到一半到了时限：那是回应大、读得慢，不报。
    const reading = new AbortController()
    base.mockImplementationOnce(async () => cutReply(() => reading.abort()))
    const response = await accountFetch('https://xm.solov.cc/api/log/self', { signal: reading.signal })
    await expect(response.text()).rejects.toThrow('terminated')
    expect(reports).toEqual([['solov', 'no-answer']])

    // 公告照旧一个字不报。
    const notice = new AbortController()
    base.mockImplementationOnce(async () => {
      notice.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(accountFetch('https://xm.solov.cc/api/notice', { signal: notice.signal })).rejects.toThrow('aborted')
    expect(reports).toEqual([['solov', 'no-answer']])
  })

  it('resends a read that ran out of time on direct and asks for a line check, because no answer ever came', async () => {
    const { router, reports } = fakeRouter()
    const base = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(json(200))
    expect((await createRelayLineFetch(router, base)('https://xm.solov.cc/api/user/self')).status).toBe(200)
    expect(sentUrls(base)).toEqual(['https://xm-direct.solov.cc/api/user/self', 'https://xm.solov.cc/api/user/self'])
    expect(reports).toEqual([['solov', 'no-answer']])
  })

  it('reports a reply cut midway without resending it, unless the caller stopped it', async () => {
    const cut = fakeRouter()
    const cutBase = vi.fn<typeof fetch>(async () => cutReply())
    const reply = await createRelayLineFetch(cut.router, cutBase)('https://xm.solov.cc/v1/chat/completions', { method: 'POST', body: '{}' })
    await expect(reply.text()).rejects.toThrow('terminated')
    expect(cutBase).toHaveBeenCalledTimes(1)
    expect(cut.reports).toEqual([['solov', 'body']])

    // 客户点了「停止」、账号请求读一个大回应读到超时：都不算直连的毛病。
    const { router, reports } = fakeRouter()
    const caller = new AbortController()
    const base = vi.fn<typeof fetch>(async () => cutReply(() => caller.abort()))
    const response = await createRelayLineFetch(router, base)('https://xm.solov.cc/api/user/self', { signal: caller.signal })
    await expect(response.text()).rejects.toThrow('terminated')
    expect(reports).toEqual([])
  })

  it('never reports the notice, however its download goes', async () => {
    const failures: Array<() => Promise<Response>> = [
      () => Promise.reject(networkError('ERR_CONNECTION_RESET')),
      () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
      () => Promise.resolve(page(502)),
      () => Promise.resolve(cutReply()),
    ]
    for (const failure of failures) {
      const { router, reports } = fakeRouter()
      const base = vi.fn<typeof fetch>().mockImplementationOnce(failure).mockResolvedValueOnce(json(200, { data: '' }))
      const response = await createRelayLineFetch(router, base)('https://xm.solov.cc/api/notice')
      await response.text().catch(() => undefined)
      expect(reports).toEqual([])
    }
  })

  it('keeps a redirected answer recognisable for the caller to reject when direct is chosen automatically', async () => {
    const { router, reports } = fakeRouter()
    const redirected = json(200)
    Object.defineProperties(redirected, {
      redirected: { value: true },
      url: { value: 'https://elsewhere.example/login' },
    })
    const response = await createRelayLineFetch(router, vi.fn<typeof fetch>(async () => redirected))('https://xm.solov.cc/api/user/self')
    expect(response.redirected).toBe(true)
    expect(response.url).toBe('https://elsewhere.example/login')
    expect(await response.json()).toEqual({})
    expect(reports).toEqual([])
  })

  it('cuts a read still waiting on direct when the line moves and resends it on the default line', async () => {
    const { router, moveTo, listeners } = fakeRouter()
    const base = vi.fn<typeof fetch>((input, init) => String(input).startsWith('https://xm-direct.')
      ? new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
      : Promise.resolve(json(200)))
    const pending = createRelayLineFetch(router, base)('https://xm.solov.cc/api/user/self')
    await vi.waitFor(() => expect(base).toHaveBeenCalledTimes(1))

    moveTo('primary', 'solov-api')
    expect(base).toHaveBeenCalledTimes(1)
    moveTo('primary')

    expect((await pending).status).toBe(200)
    expect(sentUrls(base)).toEqual(['https://xm-direct.solov.cc/api/user/self', 'https://xm.solov.cc/api/user/self'])
    expect(listeners.size).toBe(0)
  })

  // 被丢包的线路连回应头都等不来，Chromium 自己要等二十秒以上才报超时（#1053）：只读的等满
  // relayLineAnswerWaitMs 就在另一条上也发一次，走着的这一次照样等着，谁先回了能用的话用谁。
  it('also sends a read that has had no answer for a while on the other line, and keeps a slow answer on the current line', async () => {
    vi.useFakeTimers()
    const { router, reports } = fakeRouter()
    const log = vi.fn()
    const lines = hangingLines()
    const pending = createRelayLineFetch(router, lines.base, { log, abortMeansNoAnswer: true })('https://xm.solov.cc/api/log/self')

    await vi.advanceTimersByTimeAsync(relayLineAnswerWaitMs - 1)
    expect(lines.base).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sentUrls(lines.base)).toEqual(['https://xm-direct.solov.cc/api/log/self', 'https://xm.solov.cc/api/log/self'])
    expect(log).toHaveBeenCalledWith('info', 'relay.line.hedge', expect.any(String),
      { siteId: 'solov', from: 'direct', to: 'primary', waitMs: relayLineAnswerWaitMs, method: 'GET', path: '/api/log/self' })

    // 服务端查得慢（用量明细）：走着的直连过了一阵照样回来，用它，另一条掐掉，也不报给线路那边。
    await vi.advanceTimersByTimeAsync(30_000)
    lines.answer('xm-direct.solov.cc', json(200, { data: 'direct' }))
    const response = await pending
    expect(await response.json()).toEqual({ data: 'direct' })
    expect(requestDiagnosticsOf(response)).toEqual({ line: 'direct' })
    expect(lines.aborted).toEqual(['xm.solov.cc'])
    expect(reports).toEqual([])
  })

  it('takes the other line when it answers first and tells the line check the current line never answered', async () => {
    vi.useFakeTimers()
    const { router, reports, reportedLines, listeners } = fakeRouter()
    const lines = hangingLines()
    const pending = createRelayLineFetch(router, lines.base)('https://xm.solov.cc/api/user/self')
    await vi.advanceTimersByTimeAsync(relayLineAnswerWaitMs)
    lines.answer('xm.solov.cc', json(200, { data: 'primary' }))
    const response = await pending
    expect(await response.json()).toEqual({ data: 'primary' })
    expect(requestDiagnosticsOf(response)).toEqual({ line: 'primary' })
    expect(lines.aborted).toEqual(['xm-direct.solov.cc'])
    expect(reports).toEqual([['solov', 'no-answer']])
    expect(reportedLines).toEqual(['direct'])
    expect(listeners.size).toBe(0)
  })

  it('keeps waiting on the current line when the other one answers with a page, and hands that page back only if the current line fails too', async () => {
    vi.useFakeTimers()
    const waiting = fakeRouter()
    const answered = hangingLines()
    const kept = createRelayLineFetch(waiting.router, answered.base)('https://xm.solov.cc/api/user/self')
    await vi.advanceTimersByTimeAsync(relayLineAnswerWaitMs)
    answered.answer('xm.solov.cc', page(502))
    await vi.advanceTimersByTimeAsync(0)
    answered.answer('xm-direct.solov.cc', json(200))
    expect((await kept).status).toBe(200)
    expect(waiting.reports).toEqual([])

    const failing = fakeRouter()
    const both = hangingLines()
    const lost = createRelayLineFetch(failing.router, both.base)('https://xm.solov.cc/api/user/self')
    await vi.advanceTimersByTimeAsync(relayLineAnswerWaitMs)
    both.answer('xm.solov.cc', page(502))
    await vi.advanceTimersByTimeAsync(0)
    both.fail('xm-direct.solov.cc', networkError('ERR_CONNECTION_RESET'))
    const response = await lost
    expect(response.status).toBe(502)
    expect(requestDiagnosticsOf(response)).toEqual({ line: 'primary' })
    expect(failing.reports).toEqual([['solov', 'ERR_CONNECTION_RESET']])
    expect(both.base).toHaveBeenCalledTimes(2)
  })

  it('never sends a write or a mail request twice while it waits', async () => {
    vi.useFakeTimers()
    for (const [url, init] of [
      ['https://xm.solov.cc/api/user/login', { method: 'POST', body: '{}' }],
      ['https://xm.solov.cc/api/verification?email=a%40example.test', undefined],
    ] as const) {
      const { router, reports } = fakeRouter()
      const lines = hangingLines()
      const pending = createRelayLineFetch(router, lines.base)(url, init)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(lines.base).toHaveBeenCalledTimes(1)
      lines.answer('xm-direct.solov.cc', json(200))
      expect((await pending).status).toBe(200)
      expect(reports).toEqual([])
    }
  })

  // 客户说登不上时，日志要记得出这一次实际走的哪条线路（三线路 7b）：退回默认线路重发的记默认线路。
  it('marks every answer and failure with the line that actually carried it', async () => {
    const login = { method: 'POST', body: '{}' }
    const onDirect = fakeRouter()
    const answered = await createRelayLineFetch(onDirect.router, vi.fn<typeof fetch>(async () => json(401)))('https://xm.solov.cc/api/user/login', login)
    expect(requestDiagnosticsOf(answered)).toEqual({ line: 'direct' })

    const unsent = fakeRouter()
    const unsentBase = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(networkError('ERR_NAME_NOT_RESOLVED'))
      .mockResolvedValueOnce(json(200))
    expect(requestDiagnosticsOf(await createRelayLineFetch(unsent.router, unsentBase)('https://xm.solov.cc/api/user/login', login)))
      .toEqual({ line: 'primary' })

    const cut = fakeRouter()
    const cutFailure = await createRelayLineFetch(cut.router, vi.fn<typeof fetch>().mockRejectedValueOnce(networkError('ERR_CONNECTION_RESET')))(
      'https://xm.solov.cc/api/user/login', login,
    ).catch((error: unknown) => error)
    expect(requestDiagnosticsOf(cutFailure)).toEqual({ line: 'direct' })

    const bothDown = fakeRouter()
    const bothBase = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(networkError('ERR_NAME_NOT_RESOLVED'))
      .mockRejectedValueOnce(networkError('ERR_CONNECTION_REFUSED'))
    const bothFailure = await createRelayLineFetch(bothDown.router, bothBase)('https://xm.solov.cc/api/status').catch((error: unknown) => error)
    expect(requestDiagnosticsOf(bothFailure)).toEqual({ line: 'primary' })

    const pinned = fakeRouter('primary', false)
    const pinnedFailure = await createRelayLineFetch(pinned.router, vi.fn<typeof fetch>().mockRejectedValueOnce(networkError('ERR_NAME_NOT_RESOLVED')))(
      'https://xm.solov.cc/api/status',
    ).catch((error: unknown) => error)
    expect(requestDiagnosticsOf(pinnedFailure)).toEqual({ line: 'primary' })

    const elsewhere = await createRelayLineFetch(onDirect.router, vi.fn<typeof fetch>(async () => json(200)))('https://example.test/api/status')
    expect(requestDiagnosticsOf(elsewhere)).toBeNull()
  })

  // 历史账号先走默认线路（api 的 CF），直连备用（yoyo 10-14）：两条对调。
  it('resends a historical read on direct when the default line fails, and back on the default line once direct fails too', async () => {
    const { router, reports, reportedLines } = fakeRouter('primary')
    const log = vi.fn()
    const base = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(networkError('ERR_NAME_NOT_RESOLVED'))
      .mockResolvedValueOnce(json(200))
    const response = await createRelayLineFetch(router, base, { log })('https://api.solov.cc/api/v1/auth/me')

    expect(response.status).toBe(200)
    expect(sentUrls(base)).toEqual(['https://api.solov.cc/api/v1/auth/me', 'https://api-direct.solov.cc/api/v1/auth/me'])
    expect(requestDiagnosticsOf(response)).toEqual({ line: 'direct' })
    expect(reports).toEqual([['solov-api', 'ERR_NAME_NOT_RESOLVED']])
    expect(reportedLines).toEqual(['primary'])
    expect(log).toHaveBeenCalledWith('info', 'relay.line.fallback', expect.any(String),
      { siteId: 'solov-api', from: 'primary', to: 'direct', reason: 'ERR_NAME_NOT_RESOLVED', method: 'GET', path: '/api/v1/auth/me' })

    // 已经退到直连、直连自己也坏了（#1053）：换回默认线路重发，报的是直连。
    const onDirect = fakeRouter('direct')
    const directBase = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(networkError('ERR_NAME_NOT_RESOLVED'))
      .mockResolvedValueOnce(json(200))
    const resent = await createRelayLineFetch(onDirect.router, directBase)('https://api.solov.cc/api/v1/auth/me')
    expect(resent.status).toBe(200)
    expect(sentUrls(directBase)).toEqual(['https://api-direct.solov.cc/api/v1/auth/me', 'https://api.solov.cc/api/v1/auth/me'])
    expect(requestDiagnosticsOf(resent)).toEqual({ line: 'primary' })
    expect(onDirect.reports).toEqual([['solov-api', 'ERR_NAME_NOT_RESOLVED']])
    expect(onDirect.reportedLines).toEqual(['direct'])
  })

  // 星芒账号退到默认线路以后，换了网络常常是默认线路先坏（#1053）：只读的换回直连重发，报的是默认线路。
  it('resends an xm read on direct when the default line it fell back to fails', async () => {
    const { router, reports, reportedLines } = fakeRouter('primary')
    const base = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(networkError('ERR_CONNECTION_REFUSED'))
      .mockResolvedValueOnce(json(200))
    const response = await createRelayLineFetch(router, base)('https://xm.solov.cc/api/user/self')
    expect(response.status).toBe(200)
    expect(sentUrls(base)).toEqual(['https://xm.solov.cc/api/user/self', 'https://xm-direct.solov.cc/api/user/self'])
    expect(requestDiagnosticsOf(response)).toEqual({ line: 'direct' })
    expect(reports).toEqual([['solov', 'ERR_CONNECTION_REFUSED']])
    expect(reportedLines).toEqual(['primary'])

    // 白名单只在直连上有：默认线路回的网页 404 照原样交回去，不换线路。
    const notFound = fakeRouter('primary')
    const notFoundBase = vi.fn<typeof fetch>().mockResolvedValueOnce(page(404))
    expect((await createRelayLineFetch(notFound.router, notFoundBase)('https://xm.solov.cc/api/status')).status).toBe(404)
    expect(notFoundBase).toHaveBeenCalledTimes(1)
  })

  it('falls back from the historical default line for gateway and intercepted pages, but hands a page-shaped 404 back since only direct has an allowlist', async () => {
    const cases: Array<{ answer: () => Response; fellBack: boolean; reported: string | null }> = [
      { answer: () => page(502), fellBack: true, reported: 'http-502' },
      { answer: () => page(200), fellBack: true, reported: 'intercepted' },
      { answer: () => page(404), fellBack: false, reported: null },
      { answer: () => json(401), fellBack: false, reported: null },
    ]
    for (const { answer, fellBack, reported } of cases) {
      const { router, reports } = fakeRouter('primary')
      const first = answer()
      const base = vi.fn<typeof fetch>().mockResolvedValueOnce(first).mockResolvedValueOnce(json(200))
      const response = await createRelayLineFetch(router, base)('https://api.solov.cc/api/v1/settings/public')
      expect(sentUrls(base)).toEqual(fellBack
        ? ['https://api.solov.cc/api/v1/settings/public', 'https://api-direct.solov.cc/api/v1/settings/public']
        : ['https://api.solov.cc/api/v1/settings/public'])
      expect(response.status).toBe(fellBack ? 200 : first.status)
      expect(reports).toEqual(reported ? [['solov-api', reported]] : [])
    }
    // 会改动数据的请求碰上网页 404 也不重发：它不是白名单挡下的，可能已经送到了。
    const { router } = fakeRouter('primary')
    const base = vi.fn<typeof fetch>().mockResolvedValueOnce(page(404))
    expect((await createRelayLineFetch(router, base)('https://api.solov.cc/api/v1/keys', { method: 'POST', body: '{}' })).status).toBe(404)
    expect(base).toHaveBeenCalledTimes(1)
  })

  it('cuts a historical read still waiting on the default line when the line moves to direct', async () => {
    const { router, moveTo, listeners } = fakeRouter('primary')
    const base = vi.fn<typeof fetch>((input, init) => String(input).startsWith('https://api.solov.cc/')
      ? new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
      : Promise.resolve(json(200)))
    const pending = createRelayLineFetch(router, base)('https://api.solov.cc/api/v1/auth/me')
    await vi.waitFor(() => expect(base).toHaveBeenCalledTimes(1))

    moveTo('direct', 'solov')
    expect(base).toHaveBeenCalledTimes(1)
    moveTo('direct', 'solov-api')

    expect((await pending).status).toBe(200)
    expect(sentUrls(base)).toEqual(['https://api.solov.cc/api/v1/auth/me', 'https://api-direct.solov.cc/api/v1/auth/me'])
    expect(listeners.size).toBe(0)
  })

  it('never resends a streamed body and never reroutes a pinned line', async () => {
    const streamed = fakeRouter()
    const streamBase = vi.fn<typeof fetch>().mockRejectedValueOnce(networkError('ERR_NAME_NOT_RESOLVED'))
    await expect(createRelayLineFetch(streamed.router, streamBase)('https://xm.solov.cc/v1/chat/completions',
      { method: 'POST', body: new ReadableStream() })).rejects.toThrow('fetch failed')
    expect(sentUrls(streamBase)).toEqual(['https://xm-direct.solov.cc/v1/chat/completions'])

    const pinned = fakeRouter('direct', false)
    const pinnedBase = vi.fn<typeof fetch>().mockRejectedValueOnce(networkError('ERR_NAME_NOT_RESOLVED'))
    await expect(createRelayLineFetch(pinned.router, pinnedBase)('https://xm.solov.cc/api/status')).rejects.toThrow('fetch failed')
    expect(pinnedBase).toHaveBeenCalledTimes(1)
    expect(pinned.reports).toEqual([])

    const pinnedPrimary = fakeRouter('primary', false)
    const primaryBase = vi.fn<typeof fetch>().mockRejectedValueOnce(networkError('ERR_NAME_NOT_RESOLVED'))
    await expect(createRelayLineFetch(pinnedPrimary.router, primaryBase)('https://xm-direct.solov.cc/api/status')).rejects.toThrow('fetch failed')
    expect(sentUrls(primaryBase)).toEqual(['https://xm.solov.cc/api/status'])
    expect(pinnedPrimary.reports).toEqual([])
  })
})

describe('createRelayObservedFetch', () => {
  it('reports direct failures of an auto site without moving or resending the request', async () => {
    const { router, reports } = fakeRouter()
    const log = vi.fn()
    const base = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(networkError('ERR_CONNECTION_REFUSED'))
      .mockResolvedValueOnce(page(502))
      .mockResolvedValueOnce(page(404))
      .mockResolvedValueOnce(json(401))
    const observed = createRelayObservedFetch(router, base, { log })

    await expect(observed('https://xm-direct.solov.cc/v1/models')).rejects.toThrow('fetch failed')
    expect((await observed('https://xm-direct.solov.cc/v1/models')).status).toBe(502)
    expect((await observed('https://xm-direct.solov.cc/v1/countTokens')).status).toBe(404)
    expect((await observed('https://xm-direct.solov.cc/v1/models')).status).toBe(401)

    expect(sentUrls(base)).toEqual(Array(4).fill('https://xm-direct.solov.cc/v1/models').map((url, index) => index === 2 ? 'https://xm-direct.solov.cc/v1/countTokens' : url))
    expect(reports).toEqual([['solov', 'ERR_CONNECTION_REFUSED'], ['solov', 'http-502']])
    // 查模型查到时限还没拿到回应头：同账号请求，叫线路那边查一轮。
    base.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
    await expect(observed('https://xm-direct.solov.cc/v1/models')).rejects.toThrow('timed out')
    expect(reports.at(-1)).toEqual(['solov', 'no-answer'])
    expect(log).toHaveBeenCalledWith('warn', 'relay.line.blocked', expect.any(String), { siteId: 'solov', line: 'direct', method: 'GET', path: '/v1/countTokens' })
  })

  it('reports a refused tunnel, a page someone else answered with and a reply cut midway', async () => {
    const { router, reports } = fakeRouter()
    const base = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(networkError('ERR_TUNNEL_CONNECTION_FAILED'))
      .mockResolvedValueOnce(page(200))
      .mockResolvedValueOnce(cutReply())
    const observed = createRelayObservedFetch(router, base)

    await expect(observed('https://xm-direct.solov.cc/v1/models')).rejects.toThrow('fetch failed')
    expect((await observed('https://xm-direct.solov.cc/v1/models')).status).toBe(200)
    await expect((await observed('https://xm-direct.solov.cc/v1/chat/completions', { method: 'POST', body: '{}' })).text()).rejects.toThrow('terminated')

    expect(base).toHaveBeenCalledTimes(3)
    expect(reports).toEqual([['solov', 'ERR_TUNNEL_CONNECTION_FAILED'], ['solov', 'intercepted'], ['solov', 'body']])
  })

  it('stays silent for the default line, a pinned site, a proxy that is not running, a caller abort and a reply the caller stopped', async () => {
    const auto = fakeRouter()
    const base = vi.fn<typeof fetch>().mockRejectedValue(networkError('ERR_CONNECTION_REFUSED'))
    const observed = createRelayObservedFetch(auto.router, base)
    await expect(observed('https://xm.solov.cc/v1/models')).rejects.toThrow('fetch failed')
    // 调用方自己到了时限就中止：这一次不报，由它自己说查不出模型。
    const caller = new AbortController()
    caller.abort()
    base.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
    await expect(observed('https://xm-direct.solov.cc/v1/models', { signal: caller.signal })).rejects.toThrow('timed out')
    await expect(observed('https://xm-direct.solov.cc/v1/models', { signal: caller.signal })).rejects.toThrow('fetch failed')
    base.mockRejectedValueOnce(networkError('ERR_PROXY_CONNECTION_FAILED'))
    await expect(observed('https://xm-direct.solov.cc/v1/models')).rejects.toThrow('fetch failed')
    const stopped = new AbortController()
    base.mockResolvedValueOnce(cutReply(() => stopped.abort()))
    await expect((await observed('https://xm-direct.solov.cc/v1/models', { signal: stopped.signal })).text()).rejects.toThrow('terminated')
    expect(auto.reports).toEqual([])

    const pinned = fakeRouter('direct', false)
    await expect(createRelayObservedFetch(pinned.router, base)('https://xm-direct.solov.cc/v1/models')).rejects.toThrow('fetch failed')
    expect(pinned.reports).toEqual([])
  })
})

describe('createRelayObservedFetch line marks', () => {
  it('marks answers and failures with the line the address belongs to, whether or not it reports them', async () => {
    for (const automatic of [true, false]) {
      const { router } = fakeRouter('direct', automatic)
      const base = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(json(401))
        .mockRejectedValueOnce(networkError('ERR_CONNECTION_REFUSED'))
        .mockResolvedValueOnce(json(200))
      const observed = createRelayObservedFetch(router, base)
      expect(requestDiagnosticsOf(await observed('https://xm.solov.cc/v1/models'))).toEqual({ line: 'primary' })
      expect(requestDiagnosticsOf(await observed('https://xm-direct.solov.cc/v1/models').catch((error: unknown) => error)))
        .toEqual({ line: 'direct' })
      expect(requestDiagnosticsOf(await observed('https://example.test/v1/models'))).toBeNull()
    }
  })
})

describe('createRelayObservedFetch with the tool line', () => {
  function toolLine(line: RelayEndpointId, automatic = true) {
    const reports: string[] = []
    return { reports, observer: { route: () => ({ line, automatic }), reportFailure: (trigger: string) => { reports.push(trigger) } } }
  }

  it('reports failures on whichever line the account tools use, to the tool line only', async () => {
    const app = fakeRouter('direct')
    const onCf = toolLine('primary')
    const base = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(networkError('ERR_CONNECTION_RESET'))
      .mockResolvedValueOnce(page(502))
      .mockResolvedValueOnce(cutReply())
    const observed = createRelayObservedFetch(app.router, base, { toolLine: onCf.observer })

    await expect(observed('https://xm.solov.cc/v1/models')).rejects.toThrow('fetch failed')
    expect((await observed('https://xm.solov.cc/v1/models')).status).toBe(502)
    await expect((await observed('https://xm.solov.cc/v1/chat/completions', { method: 'POST', body: '{}' })).text()).rejects.toThrow('terminated')

    expect(sentUrls(base)).toEqual(['https://xm.solov.cc/v1/models', 'https://xm.solov.cc/v1/models', 'https://xm.solov.cc/v1/chat/completions'])
    expect(onCf.reports).toEqual(['check:ERR_CONNECTION_RESET', 'check:http-502', 'check:body'])
    expect(app.reports).toEqual([])
  })

  it('leaves another line, a pinned choice and the legacy site where they were', async () => {
    const app = fakeRouter('direct')
    const onDirect = toolLine('direct')
    const base = vi.fn<typeof fetch>().mockRejectedValue(networkError('ERR_CONNECTION_REFUSED'))
    const observed = createRelayObservedFetch(app.router, base, { toolLine: onDirect.observer })
    // 不在工具线路上的地址（客户手填的另一条）只发不报。
    await expect(observed('https://xm.solov.cc/v1/models')).rejects.toThrow('fetch failed')
    expect(onDirect.reports).toEqual([])
    await expect(observed('https://xm-direct.solov.cc/v1/models')).rejects.toThrow('fetch failed')
    expect(onDirect.reports).toEqual(['check:ERR_CONNECTION_REFUSED'])

    const pinned = toolLine('direct', false)
    await expect(createRelayObservedFetch(app.router, base, { toolLine: pinned.observer })('https://xm-direct.solov.cc/v1/models')).rejects.toThrow('fetch failed')
    expect(pinned.reports).toEqual([])

    // 历史账号报给应用线路，报这会儿走的那条（这里已经退到直连），不在走着的那条上的不报。
    await expect(observed('https://api.solov.cc/v1/models')).rejects.toThrow('fetch failed')
    expect(app.reports).toEqual([])
    await expect(observed('https://api-direct.solov.cc/v1/models')).rejects.toThrow('fetch failed')
    expect(app.reports).toEqual([['solov-api', 'ERR_CONNECTION_REFUSED']])
    expect(app.reportedLines).toEqual(['direct'])
    expect(onDirect.reports).toEqual(['check:ERR_CONNECTION_REFUSED'])

    const onDefault = fakeRouter('primary')
    const legacy = createRelayObservedFetch(onDefault.router, base, { toolLine: onDirect.observer })
    await expect(legacy('https://api-direct.solov.cc/v1/models')).rejects.toThrow('fetch failed')
    await expect(legacy('https://api.solov.cc/v1/models')).rejects.toThrow('fetch failed')
    expect(onDefault.reports).toEqual([['solov-api', 'ERR_CONNECTION_REFUSED']])
    expect(onDefault.reportedLines).toEqual(['primary'])
  })
})

describe('createRelayLineFetch and the tool line', () => {
  it('only ever sends the app requests to the Los Angeles or Cloudflare origin', async () => {
    const sent = new Set<string>()
    for (const line of ['direct', 'primary'] as const) {
      for (const automatic of [true, false]) {
        const { router } = fakeRouter(line, automatic)
        const base = vi.fn<typeof fetch>()
          .mockRejectedValueOnce(networkError('ERR_CONNECTION_RESET'))
          .mockImplementation(async () => json(200))
        const routed = createRelayLineFetch(router, base)
        await routed('https://xm.solov.cc/api/user/self').catch(() => undefined)
        await routed('https://xm.solov.cc/api/notice')
        await routed('https://xm.solov.cc/v1/images/generations', { method: 'POST', body: '{}' })
        for (const url of sentUrls(base)) sent.add(new URL(url).origin)
      }
    }
    expect([...sent].sort()).toEqual(['https://xm-direct.solov.cc', 'https://xm.solov.cc'])
  })
})

describe('relayLineFailureAnswer', () => {
  it('names the answers another line could avoid and leaves the service\'s own answers and an allowlist 404 alone', () => {
    expect(relayLineFailureAnswer(page(502))).toBe('http-502')
    expect(relayLineFailureAnswer(page(200))).toBe('intercepted')
    expect(relayLineFailureAnswer(opaqueRedirect())).toBe('intercepted')
    expect(relayLineFailureAnswer(page(404))).toBeNull()
    expect(relayLineFailureAnswer(json(503))).toBeNull()
    expect(relayLineFailureAnswer(cutReply())).toBeNull()
  })
})

describe('reportedRelayLineFailure', () => {
  it('reports only failures to reach the line, never a request that was slow or stopped', () => {
    for (const code of ['ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT',
      'ERR_CERT_AUTHORITY_INVALID', 'ERR_SSL_PROTOCOL_ERROR', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_UNSAFE_REDIRECT', 'ERR_INTERNET_DISCONNECTED']) {
      expect(reportedRelayLineFailure(networkError(code))).toBe(code)
    }
    expect(reportedRelayLineFailure(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))).toBe('ETIMEDOUT')
    expect(reportedRelayLineFailure(new Error('self signed certificate in certificate chain'))).toBe('tls')
    expect(reportedRelayLineFailure(new DOMException('timed out', 'TimeoutError'))).toBeNull()
    expect(reportedRelayLineFailure(new DOMException('aborted', 'AbortError'))).toBeNull()
    expect(reportedRelayLineFailure(networkError('ERR_PROXY_CONNECTION_FAILED'))).toBeNull()
    expect(reportedRelayLineFailure(new Error('余额不足'))).toBeNull()
  })
})

describe('relayLineFailureReason', () => {
  it('counts only failures another line could avoid', () => {
    expect(relayLineFailureReason(new DOMException('timed out', 'TimeoutError'))).toBe('timeout')
    expect(relayLineFailureReason(networkError('ERR_NAME_NOT_RESOLVED'))).toBe('dns')
    expect(relayLineFailureReason(networkError('ERR_CERT_DATE_INVALID'))).toBe('certDate')
    expect(relayLineFailureReason(networkError('ERR_CONNECTION_RESET'))).toBe('refused')
    expect(relayLineFailureReason(networkError('ERR_INTERNET_DISCONNECTED'))).toBe('offline')
    // 代理回绝了这个地址，换一条线路有可能放行；代理软件本身没开换哪条都一样。
    expect(relayLineFailureReason(networkError('ERR_TUNNEL_CONNECTION_FAILED'))).toBe('proxy')
    expect(relayLineFailureReason(networkError('ERR_PROXY_CONNECTION_FAILED'))).toBeNull()
    expect(relayLineFailureReason(networkError('ERR_UNSAFE_REDIRECT'))).toBe('intercepted')
    expect(relayLineFailureReason(new Error('余额不足'))).toBeNull()
  })
})
