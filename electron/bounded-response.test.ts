import { describe, expect, it } from 'vitest'
import { readBoundedResponseText } from './bounded-response'

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

  it('rejects invalid limits', async () => {
    await expect(readBoundedResponseText(new Response(''), 0, '测试接口'))
      .rejects.toThrow('测试接口响应读取上限无效')
  })
})
