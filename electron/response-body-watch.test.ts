import { describe, expect, it, vi } from 'vitest'
import { watchResponseBody } from './response-body-watch'

// A body that hands out what it has, then fails the way a connection cut mid-reply does.
function cutAfter(...chunks: string[]): ReadableStream<Uint8Array> {
  const pending = chunks.map((chunk) => new TextEncoder().encode(chunk))
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pending.shift()
      if (next) controller.enqueue(next)
      else controller.error(new TypeError('terminated', { cause: new Error('net::ERR_CONNECTION_RESET') }))
    },
  })
}

describe('response body watch', () => {
  it('passes the body, status and headers through untouched, set-cookie included, and reports nothing for a body read to the end', async () => {
    const onFailure = vi.fn()
    const original = new Response('{"success":true}', {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json', 'set-cookie': 'session=abc; Path=/' },
    })
    const watched = watchResponseBody(original, onFailure)
    expect(watched.status).toBe(201)
    expect(watched.statusText).toBe('Created')
    expect(watched.headers.get('content-type')).toBe('application/json')
    expect(watched.headers.getSetCookie()).toEqual(['session=abc; Path=/'])
    expect(await watched.json()).toEqual({ success: true })
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('keeps the address and redirect facts callers use to refuse a redirected request', async () => {
    const original = new Response('page', { status: 200 })
    Object.defineProperties(original, {
      url: { value: 'https://portal.example/login' },
      redirected: { value: true },
      type: { value: 'basic' },
    })
    const watched = watchResponseBody(original, () => undefined)
    expect(watched).not.toBe(original)
    expect(watched.url).toBe('https://portal.example/login')
    expect(watched.redirected).toBe(true)
    expect(watched.type).toBe('basic')
  })

  it('reports a body cut midway once, and the reader still gets the original error after what had arrived', async () => {
    const onFailure = vi.fn()
    const watched = watchResponseBody(new Response(cutAfter('data: 你好\n\n')), onFailure)
    const reader = watched.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 你好\n\n')
    await expect(reader.read()).rejects.toThrow('terminated')
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(onFailure.mock.calls[0][0]).toBeInstanceOf(TypeError)
  })

  it('does not report a reader that stops reading on its own, as a size limit or a stop button does', async () => {
    const onFailure = vi.fn()
    const cancel = vi.fn()
    const source = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode('x')) },
      cancel,
    })
    const reader = watchResponseBody(new Response(source), onFailure).body!.getReader()
    await reader.read()
    await reader.cancel('enough')
    expect(cancel).toHaveBeenCalledWith('enough')
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('reads the original error out of a failing report without letting the report change it', async () => {
    const watched = watchResponseBody(new Response(cutAfter()), () => { throw new Error('report broke') })
    await expect(watched.text()).rejects.toThrow('terminated')
  })

  it('leaves a response with no body as it is', () => {
    const empty = new Response(null, { status: 204 })
    expect(watchResponseBody(empty, () => undefined)).toBe(empty)
    const opaque = { type: 'opaqueredirect', status: 0, body: null } as unknown as Response
    expect(watchResponseBody(opaque, () => undefined)).toBe(opaque)
  })
})
