import { describe, expect, it } from 'vitest'
import { parseHttpDate, requestRemoteJson } from './codex-remote-http'

function fetchAnswering(response: Response): typeof fetch {
  return (async () => response) as typeof fetch
}

const request = {
  url: 'https://open.feishu.cn/callback/ws/endpoint',
  allowedOrigins: ['https://open.feishu.cn'],
  method: 'POST' as const,
  timeoutMs: 1000,
  maxResponseBytes: 1024,
  label: '飞书',
}

describe('codex-remote-http', () => {
  it('reads an HTTP date to the second and ignores what it cannot read', () => {
    expect(parseHttpDate('Sat, 25 Oct 2025 08:00:00 GMT')).toBe(1761379200000)
    expect(parseHttpDate('')).toBeUndefined()
    expect(parseHttpDate(null)).toBeUndefined()
    expect(parseHttpDate(undefined)).toBeUndefined()
    expect(parseHttpDate('not a date')).toBeUndefined()
    expect(parseHttpDate('Thu, 01 Jan 1970 00:00:00 GMT')).toBeUndefined()
  })

  it('hands back the time the platform answered at alongside the payload', async () => {
    const timed = new Response('{"code":0}', { status: 200, headers: { 'Content-Type': 'application/json', Date: 'Sat, 25 Oct 2025 08:00:00 GMT' } })
    await expect(requestRemoteJson({ ...request, fetch: fetchAnswering(timed) }))
      .resolves.toEqual({ status: 200, ok: true, payload: { code: 0 }, serverTime: 1761379200000 })
    const untimed = new Response('{"code":0}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    await expect(requestRemoteJson({ ...request, fetch: fetchAnswering(untimed) }))
      .resolves.toEqual({ status: 200, ok: true, payload: { code: 0 } })
  })
})
