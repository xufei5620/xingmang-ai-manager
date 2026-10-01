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
