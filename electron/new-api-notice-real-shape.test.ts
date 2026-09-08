import { describe, expect, it, vi } from 'vitest'
import { createNewApiClient } from './new-api-client'

describe('production-shaped public notice responses', () => {
  it('reads a rich notice over the ordinary 512 KB cap without a success flag', async () => {
    const richBody = `<style>${'x'.repeat(600 * 1024)}</style><article><h1>重要通知</h1><p>请查看详情</p></article>`
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: richBody }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl })

    const notice = await client.getNotice!()

    expect(notice?.text).toBe(richBody)
    expect(notice?.text.length).toBeGreaterThan(512 * 1024)
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://notice.example.test/api/notice')
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toMatch(/Authorization|Cookie/)
  })

  it('still rejects a notice beyond its dedicated 4 MB transport cap', async () => {
    const body = JSON.stringify({ data: 'x'.repeat(4 * 1024 * 1024) })
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        },
      }),
    )
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl })

    await expect(client.getNotice!()).rejects.toThrow('公告读取响应超过 4096 KB 安全上限')
  })
})
