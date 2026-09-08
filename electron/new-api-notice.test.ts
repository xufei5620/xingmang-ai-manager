import { describe, expect, it, vi } from 'vitest'
import { createNewApiClient } from './new-api-client'

describe('public account notices', () => {
  function response(data: unknown, init: ResponseInit = {}) {
    return new Response(JSON.stringify({ success: true, data }), {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> ?? {}) },
    })
  }

  it('uses the public notice contract without account credentials and gives content a stable id', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => response('公告正文'))
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl })
    const first = await client.getNotice!()
    const second = await client.getNotice!()
    expect(first).toEqual(second)
    expect(first).toMatchObject({ text: '公告正文', id: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://notice.example.test/api/notice')
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toMatch(/Authorization|Cookie/)
  })

  it('accepts the relay legacy envelope when it omits the success flag', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: '<p>上线通知</p>' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl })
    await expect(client.getNotice!()).resolves.toMatchObject({ text: '<p>上线通知</p>' })
  })

  it('does not treat a legacy HTTP-200 error message as announcement content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: '', message: 'error' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl })
    await expect(client.getNotice!()).rejects.toThrow('公告读取失败')
  })

  it('distinguishes an empty notice from malformed or oversized server data', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(''))
      .mockResolvedValueOnce(response({ text: 'wrong shape' }))
      .mockResolvedValueOnce(response('x'.repeat(4 * 1024 * 1024 + 1)))
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl })
    await expect(client.getNotice!()).resolves.toBeNull()
    await expect(client.getNotice!()).rejects.toThrow('公告内容格式')
    await expect(client.getNotice!()).rejects.toThrow('公告读取响应超过 4096 KB 安全上限')
  })

  it('keeps a separate bounded cap when the relay embeds oversized rich media', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response('本来很短的正文', { headers: { 'Content-Length': String(4 * 1024 * 1024 + 1) } }),
    )
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl })

    await expect(client.getNotice!()).rejects.toThrow('公告读取响应超过 4096 KB 安全上限')
  })
})
