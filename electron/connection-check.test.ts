import { describe, expect, it } from 'vitest'
import {
  buildConnectionProbe,
  classifyConnectionFailure,
  classifyConnectionResponse,
  connectionCheckSupported,
  extractUpstreamMessage,
  runConnectionCheck,
  sanitizeUpstreamDetail,
  type ConnectionCheckResult,
} from './connection-check'
import type { NativeConfigInspection } from './config-files'
import { relaySites, resolveRelaySite, type RelaySite } from './relay-sites'

const xmSite = resolveRelaySite('solov')
const apiSite = resolveRelaySite('solov-api')
const apiKey = 'sk-xingmang-selfcheck-secret-value'

function inspection(overrides: Partial<NativeConfigInspection> = {}, site: RelaySite = xmSite): NativeConfigInspection {
  const baseUrl = site.providerBaseUrls.claude
  return {
    baseUrl,
    actualBaseUrl: baseUrl,
    exists: true,
    hasApiKey: true,
    matchesRelay: true,
    apiKey,
    model: 'claude-opus-5',
    dataDirectory: '/home/user/.claude',
    dataDirectoryExists: true,
    files: [],
    updatedAt: null,
    ...overrides,
  }
}

function respondWith(status: number, payload: unknown, url = 'https://xm.solov.cc/v1/messages'): typeof globalThis.fetch {
  return (async () => {
    const response = new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
    // Response.url is read-only; the probe's origin guard reads it, so the
    // stub has to set it the same way a real redirect-followed reply would.
    Object.defineProperty(response, 'url', { value: url })
    return response
  }) as unknown as typeof globalThis.fetch
}

async function check(
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<NativeConfigInspection> = {},
  site: RelaySite = xmSite,
): Promise<ConnectionCheckResult> {
  return runConnectionCheck({
    provider: 'claude',
    site,
    inspection: inspection(overrides, site),
    fetch: fetchImpl,
    now: () => new Date('2026-09-18T12:00:00.000Z'),
    elapsed: (() => {
      let value = 0
      return () => (value += 5)
    })(),
  })
}

describe('connectionCheckSupported', () => {
  it('covers Claude Code only until the other CLIs have their own request shape', () => {
    expect(connectionCheckSupported('claude')).toBe(true)
    expect(connectionCheckSupported('codex')).toBe(false)
    expect(connectionCheckSupported('gemini')).toBe(false)
    expect(connectionCheckSupported('grok')).toBe(false)
  })
})

describe('buildConnectionProbe', () => {
  it('builds a one-token Messages request against the configured base URL', () => {
    const build = buildConnectionProbe('claude', xmSite, inspection())
    expect(build.kind).toBe('probe')
    if (build.kind !== 'probe') return
    expect(build.plan.url).toBe('https://xm.solov.cc/v1/messages')
    expect(build.plan.origin).toBe('https://xm.solov.cc')
    expect(build.plan.headers['x-api-key']).toBe(apiKey)
    expect(build.plan.headers['anthropic-version']).toBe('2023-06-01')
    expect(build.plan.body).toEqual({
      model: 'claude-opus-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    })
    expect(build.plan.siteId).toBe('solov')
  })

  it('probes the second site with the same protocol and its own origin', () => {
    const build = buildConnectionProbe('claude', apiSite, inspection({}, apiSite))
    expect(build.kind).toBe('probe')
    if (build.kind !== 'probe') return
    expect(build.plan.url).toBe('https://api.solov.cc/v1/messages')
    expect(build.plan.siteId).toBe('solov-api')
  })

  it('tolerates a trailing slash in the configured base URL', () => {
    const build = buildConnectionProbe('claude', xmSite, inspection({
      actualBaseUrl: 'https://xm.solov.cc/',
      matchesRelay: true,
    }))
    expect(build.kind).toBe('probe')
    if (build.kind !== 'probe') return
    expect(build.plan.url).toBe('https://xm.solov.cc/v1/messages')
  })

  it('falls back to the default model when the config file names none', () => {
    const build = buildConnectionProbe('claude', xmSite, inspection({ model: '' }))
    expect(build.kind).toBe('probe')
    if (build.kind !== 'probe') return
    expect(build.plan.model).toBe('claude-opus-5')
  })

  it('blocks before any request when the tool is not supported yet', () => {
    const build = buildConnectionProbe('codex', xmSite, inspection())
    expect(build.kind).toBe('blocked')
    if (build.kind !== 'blocked') return
    expect(build.outcome.layer).toBe('config')
    expect(build.outcome.summary).toContain('Codex CLI')
  })

  it('blocks when no config file exists', () => {
    const build = buildConnectionProbe('claude', xmSite, inspection({ exists: false }))
    expect(build.kind).toBe('blocked')
    if (build.kind !== 'blocked') return
    expect(build.outcome.layer).toBe('config')
    expect(build.outcome.summary).toContain('配置文件')
  })

  it('blocks when the config file has no API key', () => {
    const build = buildConnectionProbe('claude', xmSite, inspection({
      hasApiKey: false,
      apiKey: '',
      matchesRelay: false,
    }))
    expect(build.kind).toBe('blocked')
    if (build.kind !== 'blocked') return
    expect(build.outcome.summary).toContain('API Key')
  })

  it('blocks when the config points somewhere other than the active site, without naming the other site', () => {
    const build = buildConnectionProbe('claude', xmSite, inspection({
      actualBaseUrl: 'https://api.solov.cc',
      matchesRelay: false,
    }))
    expect(build.kind).toBe('blocked')
    if (build.kind !== 'blocked') return
    expect(build.outcome.layer).toBe('config')
    expect(build.outcome.summary).not.toContain('api.solov.cc')
    expect(build.outcome.summary).toContain('星芒服务')
  })

  it('refuses to probe when the inspection was reconciled against a different site', () => {
    // inspection() 用 apiSite 的地址建，却按 xmSite 判：真实调用点两边同源，
    // 这条守的是将来接错线时不要把 Key 发去一台没核对过的主机。
    const build = buildConnectionProbe('claude', xmSite, inspection({}, apiSite))
    expect(build.kind).toBe('blocked')
    if (build.kind !== 'blocked') return
    expect(build.outcome.layer).toBe('config')
    expect(build.outcome.summary).not.toContain('api.solov.cc')
  })

  it('refuses a non-https base URL rather than sending the key over plaintext', () => {
    const build = buildConnectionProbe('claude', xmSite, inspection({
      actualBaseUrl: 'http://xm.solov.cc',
      matchesRelay: true,
    }))
    expect(build.kind).toBe('blocked')
    if (build.kind !== 'blocked') return
    expect(build.outcome.layer).toBe('config')
    expect(build.outcome.summary).toContain('https')
  })
})

describe('extractUpstreamMessage', () => {
  it('reads both the OpenAI-style and the flat new-api envelope', () => {
    expect(extractUpstreamMessage({ error: { message: '当前分组下无可用渠道' } })).toBe('当前分组下无可用渠道')
    expect(extractUpstreamMessage({ message: '额度不足' })).toBe('额度不足')
    expect(extractUpstreamMessage({ error: 'plain' })).toBe('plain')
    expect(extractUpstreamMessage(null)).toBe('')
    expect(extractUpstreamMessage([1, 2])).toBe('')
  })
})

describe('classifyConnectionResponse', () => {
  it('passes a real Messages reply', () => {
    const outcome = classifyConnectionResponse('claude', 200, '', {
      type: 'message',
      content: [],
      stop_reason: 'max_tokens',
    }, 'claude-opus-5')
    expect(outcome.ok).toBe(true)
    expect(outcome.layer).toBe('network')
  })

  it('calls a 200 that is not a Messages reply a protocol problem', () => {
    const outcome = classifyConnectionResponse('claude', 200, '', { hello: 'world' }, 'claude-opus-5')
    expect(outcome.ok).toBe(false)
    expect(outcome.layer).toBe('protocol')
  })

  it('maps 401 to the credential layer', () => {
    expect(classifyConnectionResponse('claude', 401, '无效的令牌', {}, 'm').layer).toBe('credential')
  })

  it('splits 403 between a disabled key and an empty balance', () => {
    expect(classifyConnectionResponse('claude', 403, '该令牌已被禁用', {}, 'm').layer).toBe('credential')
    expect(classifyConnectionResponse('claude', 403, '当前分组额度不足', {}, 'm').layer).toBe('quota')
  })

  it('maps 402 and 429 to the quota layer', () => {
    expect(classifyConnectionResponse('claude', 402, '', {}, 'm').layer).toBe('quota')
    expect(classifyConnectionResponse('claude', 429, '', {}, 'm').layer).toBe('quota')
  })

  it('maps the 2026-08-12 no-channel failure to the group layer', () => {
    const outcome = classifyConnectionResponse('claude', 503, '当前分组 default 下对于模型无可用渠道', {}, 'm')
    expect(outcome.layer).toBe('group')
    expect(outcome.nextStep).toContain('写入 Key')
  })

  it('maps an unknown model to the model layer and names it', () => {
    const outcome = classifyConnectionResponse('claude', 404, '该模型未找到', {}, 'claude-opus-9')
    expect(outcome.layer).toBe('model')
    expect(outcome.summary).toContain('claude-opus-9')
  })

  it('maps model_not_found in English too', () => {
    expect(classifyConnectionResponse('claude', 400, 'model not_found_error', {}, 'm').layer).toBe('model')
  })

  it('maps a bare 404 with no upstream copy to the protocol layer', () => {
    expect(classifyConnectionResponse('claude', 404, '', {}, 'm').layer).toBe('protocol')
  })

  it('maps 5xx to the unknown layer rather than blaming the user', () => {
    expect(classifyConnectionResponse('claude', 502, '', {}, 'm').layer).toBe('unknown')
  })

  it('always supplies a Chinese next step', () => {
    for (const status of [200, 400, 401, 402, 403, 404, 405, 429, 500, 503]) {
      const outcome = classifyConnectionResponse('claude', status, '', {}, 'm')
      expect(outcome.nextStep.length).toBeGreaterThan(0)
      expect(outcome.summary.length).toBeGreaterThan(0)
    }
  })
})

describe('classifyConnectionFailure', () => {
  it('reports a timeout as a network failure', () => {
    const aborted = new Error('aborted')
    aborted.name = 'AbortError'
    const outcome = classifyConnectionFailure(aborted)
    expect(outcome.layer).toBe('network')
    expect(outcome.summary).toContain('超时')
  })

  it('reports a transport failure as a network failure', () => {
    expect(classifyConnectionFailure(new Error('getaddrinfo ENOTFOUND')).layer).toBe('network')
  })
})

describe('sanitizeUpstreamDetail', () => {
  it('redacts the key, strips control characters and truncates', () => {
    const detail = sanitizeUpstreamDetail(`失败\u0007 key=${apiKey}\n第二行`, [apiKey])
    expect(detail).not.toContain(apiKey)
    expect(detail).not.toContain('\u0007')
    expect(detail).toContain('[REDACTED]')
    expect(sanitizeUpstreamDetail('x'.repeat(500), []).length).toBe(300)
  })
})

describe('runConnectionCheck', () => {
  it('reports a working connection and keeps the key out of the result', async () => {
    const result = await check(respondWith(200, { type: 'message', content: [], stop_reason: 'max_tokens' }))
    expect(result.ok).toBe(true)
    expect(result.layer).toBe('network')
    expect(result.endpoint).toBe('https://xm.solov.cc/v1/messages')
    expect(result.model).toBe('claude-opus-5')
    expect(result.status).toBe(200)
    expect(result.detail).toBeNull()
    expect(JSON.stringify(result)).not.toContain(apiKey)
  })

  it('sends exactly one minimal POST with the configured key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), init })
      const response = new Response(JSON.stringify({ type: 'message', content: [] }), { status: 200 })
      Object.defineProperty(response, 'url', { value: 'https://xm.solov.cc/v1/messages' })
      return response
    }) as unknown as typeof globalThis.fetch
    await check(fetchImpl)
    expect(calls).toHaveLength(1)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.redirect).toBe('manual')
    expect(calls[0].init.credentials).toBe('omit')
    expect(JSON.parse(String(calls[0].init.body)).max_tokens).toBe(1)
    expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBe(apiKey)
  })

  it('attributes a revoked key to the credential layer and redacts the upstream copy', async () => {
    const result = await check(respondWith(401, { error: { message: `令牌 ${apiKey} 无效` } }))
    expect(result.ok).toBe(false)
    expect(result.layer).toBe('credential')
    expect(result.detail).not.toContain(apiKey)
    expect(JSON.stringify(result)).not.toContain(apiKey)
  })

  it('attributes an empty balance to the quota layer', async () => {
    const result = await check(respondWith(403, { error: { message: '当前分组额度不足' } }))
    expect(result.layer).toBe('quota')
  })

  it('attributes a missing channel to the group layer', async () => {
    const result = await check(respondWith(503, { error: { message: '当前分组下无可用渠道' } }))
    expect(result.layer).toBe('group')
  })

  it('attributes an unknown model to the model layer', async () => {
    const result = await check(respondWith(404, { error: { message: '模型不存在' } }))
    expect(result.layer).toBe('model')
  })

  it('attributes an HTML答复 to the protocol layer', async () => {
    const fetchImpl = (async () => {
      const response = new Response('<html>hi</html>', { status: 200 })
      Object.defineProperty(response, 'url', { value: 'https://xm.solov.cc/v1/messages' })
      return response
    }) as unknown as typeof globalThis.fetch
    const result = await check(fetchImpl)
    expect(result.layer).toBe('protocol')
  })

  it('refuses a redirect instead of following it with the key attached', async () => {
    const fetchImpl = (async () => {
      const response = new Response('', { status: 302, headers: { location: 'https://evil.example/v1' } })
      Object.defineProperty(response, 'url', { value: 'https://xm.solov.cc/v1/messages' })
      return response
    }) as unknown as typeof globalThis.fetch
    const result = await check(fetchImpl)
    expect(result.layer).toBe('protocol')
    expect(result.summary).toContain('跳转')
  })

  it('refuses a response that came back from another origin', async () => {
    const result = await check(respondWith(200, { type: 'message' }, 'https://evil.example/v1/messages'))
    expect(result.ok).toBe(false)
    expect(result.layer).toBe('protocol')
    expect(result.summary).toContain('重定向')
  })

  it('reports a timeout without swallowing it', async () => {
    const fetchImpl = ((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })) as unknown as typeof globalThis.fetch
    const result = await runConnectionCheck({
      provider: 'claude',
      site: xmSite,
      inspection: inspection(),
      fetch: fetchImpl,
      timeoutMs: 5,
    })
    expect(result.layer).toBe('network')
    expect(result.summary).toContain('超时')
  })

  it('reports a transport failure as a network failure with the reason kept', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND xm.solov.cc')
    }) as unknown as typeof globalThis.fetch
    const result = await check(fetchImpl)
    expect(result.layer).toBe('network')
    expect(result.detail).toContain('ENOTFOUND')
  })

  it('caps the response body rather than buffering an unbounded reply', async () => {
    const fetchImpl = (async () => {
      const response = new Response('x'.repeat(4096), { status: 200 })
      Object.defineProperty(response, 'url', { value: 'https://xm.solov.cc/v1/messages' })
      return response
    }) as unknown as typeof globalThis.fetch
    const result = await runConnectionCheck({
      provider: 'claude',
      site: xmSite,
      inspection: inspection(),
      fetch: fetchImpl,
      maxResponseBytes: 64,
    })
    expect(result.layer).toBe('protocol')
    expect(result.ok).toBe(false)
  })

  it('never reaches the network when the local config is incomplete', async () => {
    let called = 0
    const fetchImpl = (async () => {
      called += 1
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const result = await check(fetchImpl, { hasApiKey: false, apiKey: '', matchesRelay: false })
    expect(called).toBe(0)
    expect(result.layer).toBe('config')
    expect(result.endpoint).toBeNull()
  })

  it('carries the active site id for support logs on both sites', async () => {
    const onXm = await check(respondWith(200, { type: 'message' }))
    expect(onXm.siteId).toBe('solov')
    const onApi = await check(
      respondWith(200, { type: 'message' }, 'https://api.solov.cc/v1/messages'),
      {},
      apiSite,
    )
    expect(onApi.siteId).toBe('solov-api')
    expect(onApi.endpoint).toBe('https://api.solov.cc/v1/messages')
  })

  it('never names a site in any user-facing string', async () => {
    const results = await Promise.all([
      check(respondWith(401, { error: { message: 'bad' } })),
      check(respondWith(503, { error: { message: '无可用渠道' } })),
      check(respondWith(200, { type: 'message' })),
      check(respondWith(404, { error: { message: '模型不存在' } })),
    ])
    for (const result of results) {
      const copy = `${result.summary} ${result.nextStep}`
      for (const site of relaySites) {
        expect(copy).not.toContain(site.label)
        expect(copy).not.toContain(new URL(site.websiteUrl).hostname)
      }
    }
  })
})
