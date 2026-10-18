import { describe, expect, it } from 'vitest'
import { readBoundedResponseBytes, readBoundedResponseText } from './bounded-response'

describe('bounded HTTP response reader', () => {
  it('returns a response that fits the byte limit', async () => {
    const response = new Response('中文内容', {
      headers: { 'content-length': String(Buffer.byteLength('中文内容')) },
    })

    await expect(readBoundedResponseText(response, 64, '测试接口')).resolves.toBe('中文内容')
  })

  it('rejects an oversized declared content length before consuming the body', async () => {
    const response = new Response('small', { headers: { 'content-length': '4097' } })

    await expect(readBoundedResponseText(response, 4096, '测试接口'))
      .rejects.toThrow('测试接口响应超过 4 KB 安全上限')
  })

  it('rejects a chunked response as soon as the actual body crosses the limit', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(3072, 0x61))
        controller.enqueue(Buffer.alloc(2048, 0x62))
        controller.close()
      },
    }))

    await expect(readBoundedResponseText(response, 4096, '测试接口'))
      .rejects.toThrow('测试接口响应超过 4 KB 安全上限')
  })

  it('keeps the oversize message a caller passes for both the declared and the streamed length', async () => {
    const declared = new Response('small', { headers: { 'content-length': '4097' } })
    await expect(readBoundedResponseText(declared, 4096, '测试接口', { oversizeMessage: '测试接口响应过大' }))
      .rejects.toThrow(/^测试接口响应过大$/)

    let cancelled = false
    const streamed = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Buffer.alloc(3072, 0x61))
      },
      cancel() {
        cancelled = true
      },
    }))
    await expect(readBoundedResponseText(streamed, 4096, '测试接口', { oversizeMessage: '测试接口响应过大' }))
      .rejects.toThrow(/^测试接口响应过大$/)
    expect(cancelled).toBe(true)
  })

  it('closes the body it refuses to read because of its declared length', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    }), { headers: { 'content-length': '4097' } })

    await expect(readBoundedResponseText(response, 4096, '测试接口')).rejects.toThrow('测试接口响应超过 4 KB 安全上限')
    expect(cancelled).toBe(true)
  })

  it('throws the typed error a caller builds instead of the oversize message', async () => {
    class LimitError extends Error {}
    const declared = new Response('small', { headers: { 'content-length': '4097' } })
    await expect(readBoundedResponseBytes(declared, 4096, '测试接口', {
      oversizeMessage: 'unused',
      oversizeError: () => new LimitError('typed'),
    })).rejects.toBeInstanceOf(LimitError)

    const streamed = new Response(Buffer.alloc(4097, 0x61))
    await expect(readBoundedResponseBytes(streamed, 4096, '测试接口', { oversizeError: () => new LimitError('typed') }))
      .rejects.toBeInstanceOf(LimitError)
  })

  it('returns empty content by default and reports each empty case when the caller requires content', async () => {
    const requireNonEmpty = { missingBodyMessage: '测试接口没有内容', emptyMessage: '测试接口为空' }

    await expect(readBoundedResponseBytes(new Response(null), 64, '测试接口')).resolves.toHaveLength(0)
    await expect(readBoundedResponseBytes(new Response(''), 64, '测试接口')).resolves.toHaveLength(0)
    await expect(readBoundedResponseBytes(new Response(null), 64, '测试接口', { requireNonEmpty }))
      .rejects.toThrow(/^测试接口没有内容$/)
    const emptyChunks = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(0))
        controller.close()
      },
    }))
    await expect(readBoundedResponseBytes(emptyChunks, 64, '测试接口', { requireNonEmpty }))
      .rejects.toThrow(/^测试接口为空$/)
  })

  it('reports every chunk to the guard, empty ones included, and stops when it throws', async () => {
    let chunks = 0
    const counted = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(0))
        controller.enqueue(Buffer.from('ab'))
        controller.enqueue(Buffer.from('c'))
        controller.close()
      },
    }))
    const guard = { signal: new AbortController().signal, onChunk: () => { chunks += 1 } }
    await expect(readBoundedResponseText(counted, 64, '测试接口', { guard })).resolves.toBe('abc')
    expect(chunks).toBe(3)

    let cancelled = false
    const endless = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(0))
      },
      cancel() {
        cancelled = true
      },
    }))
    let seen = 0
    const limited = {
      signal: new AbortController().signal,
      onChunk: () => {
        seen += 1
        if (seen > 3) throw new Error('块数过多')
      },
    }
    await expect(readBoundedResponseBytes(endless, 64, '测试接口', { guard: limited })).rejects.toThrow(/^块数过多$/)
    expect(cancelled).toBe(true)
  })

  it('stops a body that ignores its request signal as soon as the guard signal aborts', async () => {
    let cancelled = false
    const stalled = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('{'))
      },
      cancel() {
        cancelled = true
      },
    }))
    const controller = new AbortController()
    const reading = readBoundedResponseBytes(stalled, 64, '测试接口', {
      guard: { signal: controller.signal, onChunk: () => undefined },
    })
    const stop = new Error('停止')
    setTimeout(() => controller.abort(stop), 10)

    await expect(reading).rejects.toBe(stop)
    expect(cancelled).toBe(true)
  })

  it('rejects invalid limits', async () => {
    await expect(readBoundedResponseText(new Response(''), 0, '测试接口'))
      .rejects.toThrow('测试接口响应读取上限无效')
  })
})
