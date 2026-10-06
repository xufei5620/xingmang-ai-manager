import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRelayLineFetch,
  createRelayObservedFetch,
  relayDirectSlowResponseMs,
  relayLineFailureAnswer,
  relayLineFailureReason,
  type RelayLineRouter,
} from './relay-line-fetch'
import type { RelayEndpointId, RelayRouteSiteId } from './relay-sites'

function fakeRouter(line: RelayEndpointId = 'direct', automatic = true) {
  const state = { line, automatic }
  const listeners = new Set<(siteId: RelayRouteSiteId) => void>()
  const reports: Array<[RelayRouteSiteId, string]> = []
  const router: RelayLineRouter = {
    route: () => ({ line: state.line, automatic: state.automatic }),
    reportDirectFailure: (siteId, reason) => { reports.push([siteId, reason]) },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  function moveTo(next: RelayEndpointId, siteId: RelayRouteSiteId = 'solov') {
    state.line = next
    for (const listener of [...listeners]) listener(siteId)
  }
  return { router, reports, listeners, moveTo }
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
    const blocked = await post(page(404))
    expect(blocked.outcome).toBe(200)
    expect(blocked.sent).toEqual(['https://xm-direct.solov.cc/api/user/pay', 'https://xm.solov.cc/api/user/pay'])
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

  it('leaves a proxy that is not running and the caller\'s own abort to the caller', async () => {
    // 代理软件本身没开，换哪条线路都一样（归 proxy-bypass.ts 管）。
    const proxyOff = fakeRouter()
    const proxyBase = vi.fn<typeof fetch>().mockRejectedValueOnce(networkError('ERR_PROXY_CONNECTION_FAILED'))
    await expect(createRelayLineFetch(proxyOff.router, proxyBase)('https://xm.solov.cc/api/status')).rejects.toThrow('fetch failed')
    expect(proxyBase).toHaveBeenCalledTimes(1)
    expect(proxyOff.reports).toEqual([])

    for (const abortMeansUnreachable of [false, true]) {
      const { router, reports } = fakeRouter()
      const caller = new AbortController()
      const base = vi.fn<typeof fetch>(async () => {
        caller.abort()
        throw new DOMException('aborted', 'AbortError')
      })
      await expect(createRelayLineFetch(router, base, { abortMeansUnreachable })('https://xm.solov.cc/api/user/self', { signal: caller.signal }))
        .rejects.toThrow('aborted')
      expect(base).toHaveBeenCalledTimes(1)
      // 账号请求只会因为等太久而中止，那正说明直连不通；AI 对话中止多半是客户点了「停止」。
      expect(reports).toEqual(abortMeansUnreachable ? [['solov', 'timeout']] : [])
    }
  })

  it('reports a reply cut midway without resending it, unless the caller stopped it', async () => {
    const cut = fakeRouter()
    const cutBase = vi.fn<typeof fetch>(async () => cutReply())
    const reply = await createRelayLineFetch(cut.router, cutBase)('https://xm.solov.cc/v1/chat/completions', { method: 'POST', body: '{}' })
    await expect(reply.text()).rejects.toThrow('terminated')
    expect(cutBase).toHaveBeenCalledTimes(1)
    expect(cut.reports).toEqual([['solov', 'body']])

    // 客户点了「停止」：不算直连的毛病；账号请求只会因为等太久而中止，算。
    for (const abortMeansUnreachable of [false, true]) {
      const { router, reports } = fakeRouter()
      const caller = new AbortController()
      const base = vi.fn<typeof fetch>(async () => cutReply(() => caller.abort()))
      const response = await createRelayLineFetch(router, base, { abortMeansUnreachable })('https://xm.solov.cc/api/user/self', { signal: caller.signal })
      await expect(response.text()).rejects.toThrow('terminated')
      expect(reports).toEqual(abortMeansUnreachable ? [['solov', 'body']] : [])
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

  it('asks the line check about a slow read without cutting it', async () => {
    vi.useFakeTimers()
    const { router, reports } = fakeRouter()
    let answer: (response: Response) => void = () => undefined
    const base = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { answer = resolve }))
    const pending = createRelayLineFetch(router, base)('https://xm.solov.cc/api/user/self')

    await vi.advanceTimersByTimeAsync(relayDirectSlowResponseMs - 1)
    expect(reports).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(reports).toEqual([['solov', 'slow']])
    answer(json(200))

    expect((await pending).status).toBe(200)
    expect(base).toHaveBeenCalledTimes(1)
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

    const onPrimary = fakeRouter('primary')
    const primaryBase = vi.fn<typeof fetch>().mockRejectedValueOnce(networkError('ERR_NAME_NOT_RESOLVED'))
    await expect(createRelayLineFetch(onPrimary.router, primaryBase)('https://xm-direct.solov.cc/api/status')).rejects.toThrow('fetch failed')
    expect(sentUrls(primaryBase)).toEqual(['https://xm.solov.cc/api/status'])
    expect(onPrimary.reports).toEqual([])
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
    expect(log).toHaveBeenCalledWith('warn', 'relay.line.blocked', expect.any(String), { siteId: 'solov', method: 'GET', path: '/v1/countTokens' })
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

  it('stays silent for the default line, a pinned site, a proxy that is not running and a caller abort', async () => {
    const auto = fakeRouter()
    const base = vi.fn<typeof fetch>().mockRejectedValue(networkError('ERR_CONNECTION_REFUSED'))
    const observed = createRelayObservedFetch(auto.router, base)
    await expect(observed('https://xm.solov.cc/v1/models')).rejects.toThrow('fetch failed')
    const caller = new AbortController()
    caller.abort()
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
