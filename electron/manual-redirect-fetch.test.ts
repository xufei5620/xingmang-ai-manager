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
  aborted = false
  ended = false

  constructor(readonly options: ManualRedirectRequestOptions) {
    super()
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value)
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

  it('keeps requests with a body on the wrapped fetch', async () => {
    const { requests, wrapped, fetchWithRedirects } = harness()

    await fetchWithRedirects('https://example.test/', { method: 'POST', body: 'x', redirect: 'manual' })

    expect(wrapped).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(0)
  })
})
