import { describe, expect, it } from 'vitest'
import { parseHttpDate, RemoteHttpError, requestRemoteBytes, requestRemoteJson } from './codex-remote-http'

function fetchAnswering(response: Response): typeof fetch {
  return (async () => response) as typeof fetch
}

/** 先给出几个字节，再报一个读取错误：图片或回应下到一半断了网。 */
function brokenBody(head: number[], failure: string): ReadableStream<Uint8Array> {
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(new Uint8Array(head))
        return
      }
      controller.error(new Error(failure))
    },
  })
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

  // YF-14 取图：同样只去点名的 origin、不跟重定向、读到上限就停，交回原样的字节和类型。
  it('hands back raw bytes and the content type for a binary download', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const answer = new Response(bytes, { status: 200, headers: { 'Content-Type': 'Image/PNG; charset=binary' } })
    let seen: RequestInit | undefined
    const recording = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init
      return answer
    }) as typeof fetch
    const result = await requestRemoteBytes({ ...request, method: 'GET', fetch: recording, headers: { Authorization: 'Bearer t' } })
    expect(result).toEqual({ status: 200, ok: true, contentType: 'image/png', bytes: Buffer.from(bytes) })
    expect(seen?.redirect).toBe('manual')
    expect(new Headers(seen?.headers).get('accept')).toBe('*/*')
  })

  it('refuses binary downloads that are too big, redirected or off the allowed origin', async () => {
    const big = new Response(new Uint8Array(2048), { status: 200 })
    await expect(requestRemoteBytes({ ...request, method: 'GET', fetch: fetchAnswering(big) })).rejects.toMatchObject({ reason: 'oversize' })
    const moved = new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } })
    await expect(requestRemoteBytes({ ...request, method: 'GET', fetch: fetchAnswering(moved) })).rejects.toMatchObject({ reason: 'redirected' })
    await expect(requestRemoteBytes({ ...request, method: 'GET', url: 'https://evil.example/a.png', fetch: fetchAnswering(big) }))
      .rejects.toBeInstanceOf(RemoteHttpError)
  })

  // YR-5：只有真超过上限才叫 oversize；读到一半断了网是 network，手机上才不会叫人去缩图。
  it('tells a body that breaks off midway apart from one that is too big', async () => {
    const declaredBig = new Response(new Uint8Array(16), { status: 200, headers: { 'Content-Length': '4096' } })
    await expect(requestRemoteBytes({ ...request, method: 'GET', fetch: fetchAnswering(declaredBig) }))
      .rejects.toMatchObject({ reason: 'oversize', message: '飞书响应超过 1 KB 安全上限' })
    const streamedBig = new Response(new Uint8Array(2048), { status: 200 })
    await expect(requestRemoteBytes({ ...request, method: 'GET', fetch: fetchAnswering(streamedBig) }))
      .rejects.toMatchObject({ reason: 'oversize' })

    for (const send of [requestRemoteBytes, requestRemoteJson] as const) {
      // Electron 45 net.fetch rejects with a plain Error that only carries the
      // Chromium code in its message, no `code` and no `cause`.
      const broken = new Response(brokenBody([0x89, 0x50], 'net::ERR_CONNECTION_RESET'), { status: 200 })
      const error = await send({ ...request, method: 'GET', fetch: fetchAnswering(broken) }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(RemoteHttpError)
      expect(error).toMatchObject({ reason: 'network', message: '无法连接飞书，请检查网络' })
    }
  })
})

