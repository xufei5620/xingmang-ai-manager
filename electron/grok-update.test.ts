import { describe, expect, it, vi } from 'vitest'
import {
  fetchGrokStableVersion,
  grokStableVersionUrls,
  parseGrokStableVersion,
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
