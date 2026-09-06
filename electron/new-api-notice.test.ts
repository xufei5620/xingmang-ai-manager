import { describe, expect, it, vi } from 'vitest'
import { createNewApiClient } from './new-api-client'

describe('public account notices', () => {
  function response(data: unknown) {
    return new Response(JSON.stringify({ success: true, data }), { headers: { 'Content-Type': 'application/json' } })
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

  it('distinguishes an empty notice from malformed or oversized server data', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(''))
      .mockResolvedValueOnce(response({ text: 'wrong shape' }))
      .mockResolvedValueOnce(response('x'.repeat(64_001)))
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl })
    await expect(client.getNotice!()).resolves.toBeNull()
    await expect(client.getNotice!()).rejects.toThrow('公告内容格式')
    await expect(client.getNotice!()).rejects.toThrow('公告内容格式')
  })
})
