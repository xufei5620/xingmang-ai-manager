import { describe, expect, it, vi } from 'vitest'
import {
  fetchGrokStableVersion,
  grokStableVersionUrls,
  parseGrokStableVersion,
  resolveGrokInstallVersion,
  type GrokVersionFetch,
} from './grok-update'

function textResponse(body: string, init: ResponseInit = {}, url?: string): Response {
  const response = new Response(body, {
    ...init,
    headers: {
      'Content-Type': 'text/plain',
      ...(init.headers ?? {}),
    },
  })
  if (url) Object.defineProperty(response, 'url', { value: url })
  return response
}

describe('Grok official stable version feed', () => {
  it('strictly parses plain semantic versions', () => {
    expect(parseGrokStableVersion('0.2.112\n')).toBe('0.2.112')
    expect(parseGrokStableVersion('0.2.113-rc.1')).toBe('0.2.113-rc.1')
    expect(parseGrokStableVersion('{"version":"0.2.112"}')).toBeNull()
    expect(parseGrokStableVersion('0.2.112 latest')).toBeNull()
  })

  it('installs a named version at or below the stable channel and never above it', () => {
    expect(resolveGrokInstallVersion(undefined, '1.0.44')).toBe('1.0.44')
    expect(resolveGrokInstallVersion('latest', '1.0.44')).toBe('1.0.44')
    expect(resolveGrokInstallVersion('1.0.44', '1.0.44')).toBe('1.0.44')
    expect(resolveGrokInstallVersion('1.0.41', '1.0.44')).toBe('1.0.41')
    expect(resolveGrokInstallVersion('1.0.45', '1.0.44')).toBe('1.0.44')
  })

  it('rejects named Grok versions that could slip under the stable ceiling or reach a URL', () => {
    // A prerelease sorts before its release, so 1.0.44-x would pass a plain
    // "not newer than stable" check without ever having been on that channel.
    expect(() => resolveGrokInstallVersion('1.0.44-rc.1', '1.0.44')).toThrow('版本号无效')
    expect(() => resolveGrokInstallVersion('1.0.44/../evil', '1.0.44')).toThrow('版本号无效')
    expect(() => resolveGrokInstallVersion('v1.0.44', '1.0.44')).toThrow('版本号无效')
  })

  it('uses the xAI stable endpoint when it succeeds', async () => {
    const fetchImpl = vi.fn<GrokVersionFetch>().mockResolvedValue(
      textResponse('0.2.112\n', {}, grokStableVersionUrls[0]),
    )

    await expect(fetchGrokStableVersion({ fetchImpl })).resolves.toEqual({
      version: '0.2.112',
      sourceUrl: grokStableVersionUrls[0],
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toBe(grokStableVersionUrls[0])
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
  })

  it('falls back to the official Google Storage endpoint', async () => {
    const fetchImpl = vi.fn<GrokVersionFetch>()
      .mockResolvedValueOnce(textResponse('unavailable', { status: 503 }, grokStableVersionUrls[0]))
      .mockResolvedValueOnce(textResponse('0.2.112', {}, grokStableVersionUrls[1]))

    await expect(fetchGrokStableVersion({ fetchImpl })).resolves.toEqual({
      version: '0.2.112',
      sourceUrl: grokStableVersionUrls[1],
    })
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([...grokStableVersionUrls])
  })

  it('rejects a malicious redirect without requesting its target and uses the fallback', async () => {
    const fetchImpl = vi.fn<GrokVersionFetch>()
      .mockResolvedValueOnce(textResponse('', {
        status: 302,
        headers: { Location: 'https://attacker.example/grok/stable' },
      }, grokStableVersionUrls[0]))
      .mockResolvedValueOnce(textResponse('0.2.112', {}, grokStableVersionUrls[1]))

    await expect(fetchGrokStableVersion({ fetchImpl })).resolves.toMatchObject({
      version: '0.2.112',
      sourceUrl: grokStableVersionUrls[1],
    })
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([...grokStableVersionUrls])
  })

  it('rejects oversized declared and streamed responses from both sources', async () => {
    const fetchImpl = vi.fn<GrokVersionFetch>()
      .mockResolvedValueOnce(textResponse('0.2.112', {
        headers: { 'Content-Length': '2048' },
      }, grokStableVersionUrls[0]))
      .mockResolvedValueOnce(textResponse('x'.repeat(1025), {}, grokStableVersionUrls[1]))

    await expect(fetchGrokStableVersion({ fetchImpl })).rejects.toThrow('超过 1 KiB 安全上限')
  })

  it('times out both sources with a bounded AbortSignal', async () => {
    const fetchImpl = vi.fn<GrokVersionFetch>().mockImplementation((_url, init) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      })
    ))

    await expect(fetchGrokStableVersion({ fetchImpl, timeoutMs: 5 }))
      .rejects.toThrow('x.ai：查询超时；storage.googleapis.com：查询超时')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('Grok stable version redirects', () => {
  const [primaryUrl, fallbackUrl] = grokStableVersionUrls

  function hop(status: number, location: string | null, url: string): Response {
    const response = new Response(null, { status, headers: location === null ? {} : { Location: location } })
    Object.defineProperty(response, 'url', { value: url })
    return response
  }

  function requestedUrls(fetchImpl: ReturnType<typeof vi.fn<GrokVersionFetch>>): string[] {
    return fetchImpl.mock.calls.map(([url]) => String(url))
  }

  it.each([301, 302, 303, 307, 308])(
    'follows a %i from the xAI endpoint to the Google Storage endpoint and reports where the version came from',
    async (status) => {
      const fetchImpl = vi.fn<GrokVersionFetch>()
        .mockResolvedValueOnce(hop(status, fallbackUrl, primaryUrl))
        .mockResolvedValueOnce(textResponse('1.0.62\n', {}, fallbackUrl))

      await expect(fetchGrokStableVersion({ fetchImpl })).resolves.toEqual({ version: '1.0.62', sourceUrl: fallbackUrl })
      expect(requestedUrls(fetchImpl)).toEqual([primaryUrl, fallbackUrl])
      for (const [, init] of fetchImpl.mock.calls) {
        expect(init).toMatchObject({ method: 'GET', headers: { Accept: 'text/plain' }, redirect: 'manual' })
        expect(init?.signal).toBeInstanceOf(AbortSignal)
      }
    },
  )

  it('resolves a relative redirect target against the hop that sent it', async () => {
    const fetchImpl = vi.fn<GrokVersionFetch>()
      .mockResolvedValueOnce(hop(302, '//storage.googleapis.com/grok-build-public-artifacts/cli/stable', primaryUrl))
      .mockResolvedValueOnce(textResponse('1.0.62', {}, fallbackUrl))

    await expect(fetchGrokStableVersion({ fetchImpl })).resolves.toEqual({ version: '1.0.62', sourceUrl: fallbackUrl })
    expect(requestedUrls(fetchImpl)).toEqual([primaryUrl, fallbackUrl])
  })

  it.each([300, 304])('leaves a %i unfollowed and reports it as an HTTP failure', async (status) => {
    const fetchImpl = vi.fn<GrokVersionFetch>()
      .mockResolvedValueOnce(hop(status, fallbackUrl, primaryUrl))
      .mockResolvedValueOnce(textResponse('', { status: 503 }, fallbackUrl))

    await expect(fetchGrokStableVersion({ fetchImpl })).rejects.toThrow(
      `Grok 官方版本查询失败：x.ai：Grok 版本服务返回 HTTP ${status}；storage.googleapis.com：Grok 版本服务返回 HTTP 503`,
    )
    expect(requestedUrls(fetchImpl)).toEqual([primaryUrl, fallbackUrl])
  })

  it('refuses a redirect loop between the two official endpoints from either side', async () => {
    const fetchImpl = vi.fn<GrokVersionFetch>()
      .mockResolvedValueOnce(hop(302, fallbackUrl, primaryUrl))
      .mockResolvedValueOnce(hop(302, primaryUrl, fallbackUrl))
      .mockResolvedValueOnce(hop(302, primaryUrl, fallbackUrl))
      .mockResolvedValueOnce(hop(302, fallbackUrl, primaryUrl))

    await expect(fetchGrokStableVersion({ fetchImpl })).rejects.toThrow(
      'Grok 官方版本查询失败：x.ai：Grok 版本服务返回了循环重定向；storage.googleapis.com：Grok 版本服务返回了循环重定向',
    )
    expect(requestedUrls(fetchImpl)).toEqual([primaryUrl, fallbackUrl, fallbackUrl, primaryUrl])
  })

  it('refuses a redirect without a target', async () => {
    const fetchImpl = vi.fn<GrokVersionFetch>()
      .mockResolvedValueOnce(hop(302, null, primaryUrl))
      .mockResolvedValueOnce(hop(307, null, fallbackUrl))

    await expect(fetchGrokStableVersion({ fetchImpl })).rejects.toThrow(
      'Grok 官方版本查询失败：x.ai：Grok 版本服务重定向缺少 Location；storage.googleapis.com：Grok 版本服务重定向缺少 Location',
    )
    expect(requestedUrls(fetchImpl)).toEqual([primaryUrl, fallbackUrl])
  })

  it.each([
    ['http://x.ai/cli/stable', 'http://x.ai'],
    ['https://x.ai:8443/cli/stable', 'https://x.ai:8443'],
    ['https://user:pass@x.ai/cli/stable', 'https://x.ai'],
    ['https://x.ai/cli/stable?channel=beta', 'https://x.ai'],
    ['https://x.ai/cli/stable#latest', 'https://x.ai'],
    ['https://x.ai/cli/latest', 'https://x.ai'],
    ['https://storage.googleapis.com/someone-else/cli/stable', 'https://storage.googleapis.com'],
    ['https://x.ai.evil.example/cli/stable', 'https://x.ai.evil.example'],
  ])('refuses a redirect to %s without requesting it', async (location, origin) => {
    const fetchImpl = vi.fn<GrokVersionFetch>()
      .mockResolvedValueOnce(hop(302, location, primaryUrl))
      .mockResolvedValueOnce(textResponse('', { status: 503 }, fallbackUrl))

    await expect(fetchGrokStableVersion({ fetchImpl })).rejects.toThrow(
      `Grok 官方版本查询失败：x.ai：Grok 版本查询拒绝不受信任的地址：${origin}；storage.googleapis.com：Grok 版本服务返回 HTTP 503`,
    )
    expect(requestedUrls(fetchImpl)).toEqual([primaryUrl, fallbackUrl])
  })

  it.each([
    [fallbackUrl, 'Grok 版本服务绕过了受限重定向策略'],
    ['https://attacker.example/cli/stable', 'Grok 版本查询拒绝不受信任的地址：https://attacker.example'],
  ])('refuses a version that reports it came from %s instead of the hop it asked', async (reportedUrl, message) => {
    const fetchImpl = vi.fn<GrokVersionFetch>()
      .mockResolvedValueOnce(textResponse('1.0.62', {}, reportedUrl))
      .mockResolvedValueOnce(textResponse('', { status: 503 }, fallbackUrl))

    await expect(fetchGrokStableVersion({ fetchImpl })).rejects.toThrow(
      `Grok 官方版本查询失败：x.ai：${message}；storage.googleapis.com：Grok 版本服务返回 HTTP 503`,
    )
    expect(requestedUrls(fetchImpl)).toEqual([primaryUrl, fallbackUrl])
  })

  it('serves the version straight from the Google Storage endpoint, which answers without redirecting', async () => {
    const fetchImpl = vi.fn<GrokVersionFetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(textResponse('1.0.62', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }, fallbackUrl))

    await expect(fetchGrokStableVersion({ fetchImpl })).resolves.toEqual({ version: '1.0.62', sourceUrl: fallbackUrl })
    expect(requestedUrls(fetchImpl)).toEqual([primaryUrl, fallbackUrl])
  })
})
