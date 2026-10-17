import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  createManualRedirectFetch,
  type ManualRedirectClientRequest,
  type ManualRedirectIncomingMessage,
  type ManualRedirectRequestOptions,
} from './manual-redirect-fetch'

// Mirrors the parts of Electron's ClientRequest the adapter drives: a redirect
// nobody follows dies with "Redirect was cancelled" unless the listener aborted.
class FakeClientRequest extends EventEmitter implements ManualRedirectClientRequest {
  readonly headers = new Map<string, string>()
  readonly written: Buffer[] = []
  aborted = false
  ended = false

  constructor(readonly options: ManualRedirectRequestOptions) {
    super()
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value)
  }

  write(chunk: Buffer): void {
    this.written.push(chunk)
  }

  abort(): void {
    this.aborted = true
  }

  end(): void {
    this.ended = true
  }

  redirect(statusCode: number, location: string): void {
    this.emit('redirect', statusCode, 'GET', location, { location: [location] })
    if (!this.aborted) this.emit('error', new Error('Redirect was cancelled'))
  }

  respond(statusCode: number, headers: Record<string, string | string[]>, chunks: string[]): void {
    const message = Object.assign(new PassThrough(), { statusCode, statusMessage: 'OK', headers }) satisfies ManualRedirectIncomingMessage
    this.emit('response', message)
    for (const chunk of chunks) message.write(chunk)
    message.end()
  }
}

function harness() {
  const requests: FakeClientRequest[] = []
  const wrapped = vi.fn<typeof fetch>(async () => new Response('wrapped'))
  const fetchWithRedirects = createManualRedirectFetch(wrapped, (options) => {
    const request = new FakeClientRequest(options)
    requests.push(request)
    return request
  })
  return { requests, wrapped, fetchWithRedirects }
}

describe('manual redirect fetch', () => {
  it('leaves every other redirect mode to the wrapped fetch', async () => {
    const { requests, wrapped, fetchWithRedirects } = harness()

    await fetchWithRedirects('https://example.test/a', { redirect: 'error' })
    await fetchWithRedirects('https://example.test/b')

    expect(wrapped).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(0)
  })

  it('hands a redirect back as a 3xx with its location and stops the request there', async () => {
    const { requests, wrapped, fetchWithRedirects } = harness()

    const pending = fetchWithRedirects('https://github.com/git-for-windows/git/releases/download/v1/Git.exe', {
      redirect: 'manual',
      credentials: 'omit',
      headers: { Accept: 'application/octet-stream', Range: 'bytes=10-' },
    })
    const request = requests[0]
    expect(request.ended).toBe(true)
    request.redirect(302, 'https://release-assets.githubusercontent.com/asset?sig=1')
    const response = await pending

    expect(wrapped).not.toHaveBeenCalled()
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://release-assets.githubusercontent.com/asset?sig=1')
    expect(response.body).toBeNull()
    expect(request.aborted).toBe(true)
    expect(request.options).toEqual({
      method: 'GET',
      url: 'https://github.com/git-for-windows/git/releases/download/v1/Git.exe',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'default',
    })
    expect(Object.fromEntries(request.headers)).toEqual({ accept: 'application/octet-stream', range: 'bytes=10-' })
  })

  it('streams a direct answer with its status and headers', async () => {
    const { requests, fetchWithRedirects } = harness()

    const pending = fetchWithRedirects('https://cdn.npmmirror.com/binaries/git-for-windows/Git.exe', { redirect: 'manual' })
    requests[0].respond(206, { 'content-length': '5', 'set-cookie': ['a=1', 'b=2'] }, ['he', 'llo'])
    const response = await pending

    expect(response.status).toBe(206)
    expect(response.headers.get('content-length')).toBe('5')
    expect(response.headers.get('set-cookie')).toBe('a=1, b=2')
    expect(await response.text()).toBe('hello')
    expect(requests[0].options.credentials).toBe('include')
  })

  it('gives a bodiless answer no body', async () => {
    const { requests, fetchWithRedirects } = harness()

    const pending = fetchWithRedirects('https://example.test/', { redirect: 'manual' })
    requests[0].respond(304, {}, [])

    expect((await pending).body).toBeNull()
  })

  it('rejects with the request error', async () => {
    const { requests, fetchWithRedirects } = harness()

    const pending = fetchWithRedirects('https://example.test/', { redirect: 'manual' })
    requests[0].emit('error', new Error('net::ERR_CONNECTION_RESET'))

    await expect(pending).rejects.toThrow('net::ERR_CONNECTION_RESET')
  })

  it('aborts the request when the caller cancels before or after the answer', async () => {
    const { requests, fetchWithRedirects } = harness()
    const already = new AbortController()
    already.abort(new Error('cancelled before'))

    await expect(fetchWithRedirects('https://example.test/', { redirect: 'manual', signal: already.signal })).rejects.toThrow('cancelled before')
    expect(requests).toHaveLength(0)

    const waiting = new AbortController()
    const pending = fetchWithRedirects('https://example.test/', { redirect: 'manual', signal: waiting.signal })
    waiting.abort(new Error('cancelled while waiting'))
    await expect(pending).rejects.toThrow('cancelled while waiting')
    expect(requests[0].aborted).toBe(true)

    const reading = new AbortController()
    const answered = fetchWithRedirects('https://example.test/', { redirect: 'manual', signal: reading.signal })
    requests[1].emit('response', Object.assign(new PassThrough(), { statusCode: 200, statusMessage: 'OK', headers: {} }))
    await answered
    expect(requests[1].aborted).toBe(false)
    reading.abort()
    expect(requests[1].aborted).toBe(true)
  })

  // 登录、建密钥、AI 对话都是带正文的 POST，也要按 'manual' 拿回跳转（#1064）：正文整个写进去才开始请求，
  // 跳转当场掐掉，正文不会被送去新地址。
  it('sends a request body before starting and hands a redirect of a POST back the same way', async () => {
    const { requests, wrapped, fetchWithRedirects } = harness()

    const pending = fetchWithRedirects('https://xm-direct.solov.cc/api/user/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'fixture', password: 'fixture-password' }),
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      redirect: 'manual',
    })
    const request = requests[0]
    await vi.waitFor(() => expect(request.ended).toBe(true))
    expect(Buffer.concat(request.written).toString()).toBe('{"username":"fixture","password":"fixture-password"}')
    expect(request.options).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'omit' })
    expect(request.headers.get('content-type')).toBe('application/json')
    request.redirect(302, 'http://portal.example/login')
    const response = await pending

    expect(wrapped).not.toHaveBeenCalled()
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('http://portal.example/login')
    expect(request.aborted).toBe(true)
  })

  it('streams a POST answer like any other', async () => {
    const { requests, fetchWithRedirects } = harness()

    const pending = fetchWithRedirects('https://xm.solov.cc/v1/chat/completions', {
      method: 'POST',
      body: new TextEncoder().encode('{"stream":true}'),
      redirect: 'manual',
    })
    await vi.waitFor(() => expect(requests[0].ended).toBe(true))
    requests[0].respond(200, { 'content-type': 'text/event-stream' }, ['data: 1\n\n', 'data: [DONE]\n\n'])
    const response = await pending

    expect(Buffer.concat(requests[0].written).toString()).toBe('{"stream":true}')
    expect(await response.text()).toBe('data: 1\n\ndata: [DONE]\n\n')
  })

  it('stops sending the body and rejects when the caller cancels while it is still going out', async () => {
    const { requests, fetchWithRedirects } = harness()
    const caller = new AbortController()
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        if (pulled === 1) controller.enqueue(new TextEncoder().encode('first'))
        // 第二块一直不来：调用方在这时候放弃。
      },
    })

    const pending = fetchWithRedirects('https://example.test/upload', { method: 'POST', body, duplex: 'half', redirect: 'manual', signal: caller.signal } as RequestInit)
    await vi.waitFor(() => expect(requests[0].written).toHaveLength(1))
    caller.abort(new Error('stopped'))

    await expect(pending).rejects.toThrow('stopped')
    expect(requests[0].aborted).toBe(true)
    expect(requests[0].ended).toBe(false)
  })
})
