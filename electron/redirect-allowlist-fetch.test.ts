import { describe, expect, it, vi } from 'vitest'
import { fetchWithRedirectAllowlist, type RedirectAllowlist } from './redirect-allowlist-fetch'

const start = 'https://downloads.example/pkg/v1/app.zip'

function allowlist(overrides: Partial<RedirectAllowlist> = {}): RedirectAllowlist {
  return {
    label: '测试下载',
    maximumRedirects: 3,
    validate: (candidate) => {
      const url = new URL(candidate)
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.example') || url.hostname === 'evil.example') {
        throw new Error(`不认识的地址（${url.hostname}）`)
      }
      return url
    },
    ...overrides,
  }
}

interface Hop {
  status?: number
  location?: string
  url?: string
  body?: string
}

const nullBodyStatuses = new Set([204, 205, 304])

/** A fake network keyed by URL; every response body records whether it was cancelled. */
function network(hops: Record<string, Hop>) {
  const requested: string[] = []
  const inits: RequestInit[] = []
  const cancelled: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requested.push(url)
    inits.push(init ?? {})
    const hop = hops[url] ?? { status: 404 }
    const status = hop.status ?? (hop.location === undefined ? 200 : 302)
    const body = nullBodyStatuses.has(status) ? null : new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(hop.body ?? 'x'))
        controller.close()
      },
      cancel() {
        cancelled.push(url)
      },
    })
    const response = new Response(body, { status, headers: hop.location === undefined ? {} : { location: hop.location } })
    if (hop.url !== undefined) Object.defineProperty(response, 'url', { value: hop.url })
    return response
  }) as typeof globalThis.fetch
  return { fetch, requested, inits, cancelled }
}

describe('fetchWithRedirectAllowlist', () => {
  it('follows allowed redirects one hop at a time, resolving relative locations against the hop', async () => {
    const net = network({
      [start]: { status: 301, location: 'https://cdn.example/a' },
      'https://cdn.example/a': { status: 307, location: '../b?sig=1' },
      'https://cdn.example/b?sig=1': { body: 'payload' },
    })
    const response = await fetchWithRedirectAllowlist(start, {}, net.fetch, allowlist())
    expect(await response.text()).toBe('payload')
    expect(net.requested).toEqual([start, 'https://cdn.example/a', 'https://cdn.example/b?sig=1'])
    // Each redirect body is dropped before the next request; the final one is the caller's.
    expect(net.cancelled).toEqual([start, 'https://cdn.example/a'])
  })

  it('treats exactly 301, 302, 303, 307 and 308 as redirects', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const net = network({ [start]: { status, location: 'https://cdn.example/a' }, 'https://cdn.example/a': {} })
      await fetchWithRedirectAllowlist(start, {}, net.fetch, allowlist())
      expect(net.requested).toHaveLength(2)
    }
    for (const status of [200, 206, 300, 304, 404, 500]) {
      const net = network({ [start]: { status, location: 'https://cdn.example/a' } })
      const response = await fetchWithRedirectAllowlist(start, {}, net.fetch, allowlist())
      expect(response.status).toBe(status)
      expect(net.requested).toEqual([start])
      expect(net.cancelled).toEqual([])
    }
  })

  it('always asks for manual redirects and passes the rest of the request through', async () => {
    const net = network({ [start]: { status: 302, location: 'https://cdn.example/a' }, 'https://cdn.example/a': {} })
    const controller = new AbortController()
    await fetchWithRedirectAllowlist(start, {
      method: 'GET',
      redirect: 'follow',
      headers: { Range: 'bytes=5-' },
      signal: controller.signal,
    }, net.fetch, allowlist())
    expect(net.inits).toHaveLength(2)
    for (const init of net.inits) {
      expect(init.redirect).toBe('manual')
      expect(init.method).toBe('GET')
      expect(new Headers(init.headers).get('range')).toBe('bytes=5-')
      expect(init.signal).toBe(controller.signal)
    }
  })

  it('refuses the first URL without sending anything', async () => {
    const net = network({})
    await expect(fetchWithRedirectAllowlist('https://evil.example/x', {}, net.fetch, allowlist())).rejects.toThrow('evil.example')
    await expect(fetchWithRedirectAllowlist('http://downloads.example/x', {}, net.fetch, allowlist())).rejects.toThrow('不认识的地址')
    expect(net.requested).toEqual([])
  })

  it('refuses a redirect off the allow-list before following it and drops its body', async () => {
    for (const location of ['https://evil.example/x', 'http://cdn.example/a', '//evil.example/x']) {
      const net = network({ [start]: { status: 302, location } })
      await expect(fetchWithRedirectAllowlist(start, {}, net.fetch, allowlist())).rejects.toThrow('不认识的地址')
      expect(net.requested).toEqual([start])
      expect(net.cancelled).toEqual([start])
    }
  })

  it('checks a hop deep in the chain the same way as the first one', async () => {
    const net = network({
      [start]: { status: 302, location: 'https://cdn.example/a' },
      'https://cdn.example/a': { status: 302, location: 'https://evil.example/b' },
    })
    await expect(fetchWithRedirectAllowlist(start, {}, net.fetch, allowlist())).rejects.toThrow('evil.example')
    expect(net.requested).toEqual([start, 'https://cdn.example/a'])
  })

  it('refuses a redirect without a Location', async () => {
    const net = network({ [start]: { status: 303 } })
    await expect(fetchWithRedirectAllowlist(start, {}, net.fetch, allowlist())).rejects.toThrow('测试下载重定向缺少 Location')
    expect(net.cancelled).toEqual([start])
  })

  it('refuses a loop as soon as a hop comes round again', async () => {
    const net = network({
      [start]: { status: 302, location: 'https://cdn.example/a' },
      'https://cdn.example/a': { status: 302, location: start },
    })
    await expect(fetchWithRedirectAllowlist(start, {}, net.fetch, allowlist({ maximumRedirects: 10 })))
      .rejects.toThrow('测试下载发生了循环重定向')
    expect(net.requested).toEqual([start, 'https://cdn.example/a'])
  })

  it('treats two spellings of the same URL as one hop', async () => {
    const net = network({
      [start]: { status: 302, location: 'HTTPS://DOWNLOADS.EXAMPLE:443/pkg/v1/app.zip' },
    })
    await expect(fetchWithRedirectAllowlist(start, {}, net.fetch, allowlist())).rejects.toThrow('循环重定向')
    expect(net.requested).toEqual([start])
  })

  it('allows exactly the configured number of redirects and refuses one more', async () => {
    const chain: Record<string, Hop> = {
      'https://cdn.example/0': { status: 302, location: 'https://cdn.example/1' },
      'https://cdn.example/1': { status: 302, location: 'https://cdn.example/2' },
      'https://cdn.example/2': { status: 302, location: 'https://cdn.example/end' },
      'https://cdn.example/end': {},
    }
    const within = network(chain)
    const response = await fetchWithRedirectAllowlist('https://cdn.example/0', {}, within.fetch, allowlist({ maximumRedirects: 3 }))
    expect(response.status).toBe(200)
    expect(within.requested).toHaveLength(4)

    const beyond = network(chain)
    await expect(fetchWithRedirectAllowlist('https://cdn.example/0', {}, beyond.fetch, allowlist({ maximumRedirects: 2 })))
      .rejects.toThrow('测试下载重定向次数过多')
    expect(beyond.requested).toHaveLength(3)
    expect(beyond.cancelled).toEqual(beyond.requested)

    const none = network(chain)
    await expect(fetchWithRedirectAllowlist('https://cdn.example/0', {}, none.fetch, allowlist({ maximumRedirects: 0 })))
      .rejects.toThrow('重定向次数过多')
    expect(none.requested).toHaveLength(1)
  })

  it('refuses a limit that could never be reached', async () => {
    const net = network({})
    for (const maximumRedirects of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(fetchWithRedirectAllowlist(start, {}, net.fetch, allowlist({ maximumRedirects })))
        .rejects.toThrow('测试下载重定向上限无效')
    }
    expect(net.requested).toEqual([])
  })

  it('refuses a response that came from somewhere other than the hop it asked for', async () => {
    // A fetch that followed a redirect itself would hide where the bytes came from.
    const offList = network({ [start]: { url: 'https://evil.example/x' } })
    await expect(fetchWithRedirectAllowlist(start, {}, offList.fetch, allowlist())).rejects.toThrow('evil.example')
    expect(offList.cancelled).toEqual([start])

    const allowedButElsewhere = network({ [start]: { url: 'https://cdn.example/a' } })
    await expect(fetchWithRedirectAllowlist(start, {}, allowedButElsewhere.fetch, allowlist()))
      .rejects.toThrow('测试下载绕过了受限的重定向策略')
    expect(allowedButElsewhere.cancelled).toEqual([start])

    const sameHop = network({ [start]: { url: start, body: 'ok' } })
    expect(await (await fetchWithRedirectAllowlist(start, {}, sameHop.fetch, allowlist())).text()).toBe('ok')

    // Redirect responses are held to the same rule before their Location is read.
    const redirectFromElsewhere = network({ [start]: { status: 302, location: 'https://cdn.example/a', url: 'https://cdn.example/z' } })
    await expect(fetchWithRedirectAllowlist(start, {}, redirectFromElsewhere.fetch, allowlist())).rejects.toThrow('绕过')
    expect(redirectFromElsewhere.requested).toEqual([start])
  })

  it('compares the reported URL against the normalised hop', async () => {
    const net = network({ [start]: { url: 'https://DOWNLOADS.example:443/pkg/v1/app.zip' } })
    await expect(fetchWithRedirectAllowlist(start, {}, net.fetch, allowlist())).resolves.toMatchObject({ status: 200 })
  })

  it('pins every hop to the first URL when the policy closes over it', async () => {
    const first = new URL(start)
    const pinned = allowlist({
      validate: (candidate) => {
        const url = new URL(candidate)
        if (url.pathname !== first.pathname) throw new Error('资源路径变了')
        return url
      },
    })
    const net = network({ [start]: { status: 302, location: 'https://cdn.example/pkg/v2/app.zip' } })
    await expect(fetchWithRedirectAllowlist(start, {}, net.fetch, pinned)).rejects.toThrow('资源路径变了')
  })

  it('lets a failed request reject as it is', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    await expect(fetchWithRedirectAllowlist(start, {}, failing, allowlist())).rejects.toThrow('fetch failed')
  })
})
