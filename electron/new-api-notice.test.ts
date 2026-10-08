import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNewApiClient } from './new-api-client'

afterEach(() => {
  vi.useRealTimers()
})

function noticeReads(fetchImpl: ReturnType<typeof vi.fn>): number {
  return fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/notice').length
}

// getNotice also reads the announcement timeline from /api/status. These
// cases are about /api/notice alone, so answer that one with an empty status.
function withEmptyStatus(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return async (input: RequestInfo | URL, init?: RequestInit) => new URL(String(input)).pathname === '/api/status'
    ? new Response(JSON.stringify({ success: true, data: {} }), { headers: { 'Content-Type': 'application/json' } })
    : fetchImpl(input, init)
}

describe('public account notices', () => {
  function response(data: unknown, init: ResponseInit = {}) {
    return new Response(JSON.stringify({ success: true, data }), {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> ?? {}) },
    })
  }

  it('uses the public notice contract without account credentials and gives content a stable id', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => response('公告正文'))
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl: withEmptyStatus(fetchImpl) })
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
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl: withEmptyStatus(fetchImpl) })
    await expect(client.getNotice!()).resolves.toMatchObject({ text: '<p>上线通知</p>' })
  })

  it('does not treat a legacy HTTP-200 error message as announcement content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: '', message: 'error' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl: withEmptyStatus(fetchImpl) })
    await expect(client.getNotice!()).rejects.toThrow('公告读取失败')
  })

  it('distinguishes an empty notice from malformed or oversized server data', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(''))
      .mockResolvedValueOnce(response({ text: 'wrong shape' }))
      .mockResolvedValueOnce(response('x'.repeat(4 * 1024 * 1024 + 1)))
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl: withEmptyStatus(fetchImpl) })
    await expect(client.getNotice!()).resolves.toBeNull()
    await expect(client.getNotice!()).rejects.toThrow('公告内容格式')
    await expect(client.getNotice!()).rejects.toThrow('公告读取响应超过 4096 KB 安全上限')
  })

  it('keeps a separate bounded cap when the relay embeds oversized rich media', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response('本来很短的正文', { headers: { 'Content-Length': String(4 * 1024 * 1024 + 1) } }),
    )
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl: withEmptyStatus(fetchImpl) })

    await expect(client.getNotice!()).rejects.toThrow('公告读取响应超过 4096 KB 安全上限')
  })

  it('gives the notice a minute to arrive, since a slow line takes a while to bring a few hundred KB', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let aborted = false
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('aborted', 'AbortError'))
      })
    }))
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl: withEmptyStatus(fetchImpl) })
    const reading = client.getNotice!()
    const outcome = expect(reading).rejects.toThrow('公告读取请求超时')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(50_000)
    await outcome
    expect(aborted).toBe(true)
  })

  it('tries a notice it could not read again at most every ten minutes on the periodic check', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T10:00:00Z'), toFake: ['Date'] })
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('net::ERR_CONNECTION_RESET') }))
      .mockResolvedValue(response('公告正文'))
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl: withEmptyStatus(fetchImpl) })
    await expect(client.getNotice!()).rejects.toThrow('公告读取请求失败')

    // 跟着余额刷新的那一路：十分钟里不再下，报的还是上次那个失败。
    for (const minute of [1, 5, 9]) {
      vi.setSystemTime(new Date(`2026-10-07T10:0${minute}:00Z`))
      await expect(client.getNotice!('cached')).rejects.toThrow('公告读取请求失败')
    }
    expect(noticeReads(fetchImpl)).toBe(1)

    vi.setSystemTime(new Date('2026-10-07T10:10:00Z'))
    await expect(client.getNotice!('cached')).resolves.toMatchObject({ text: '公告正文' })
    expect(noticeReads(fetchImpl)).toBe(2)
    // 读到了就一直用读到的那份。
    vi.setSystemTime(new Date('2026-10-07T11:00:00Z'))
    await expect(client.getNotice!('cached')).resolves.toMatchObject({ text: '公告正文' })
    expect(noticeReads(fetchImpl)).toBe(2)
  })

  it('still reads right away when the customer opens the notice after a failure', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T10:00:00Z'), toFake: ['Date'] })
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('net::ERR_CONNECTION_RESET') }))
      .mockResolvedValue(response('公告正文'))
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl: withEmptyStatus(fetchImpl) })
    await expect(client.getNotice!()).rejects.toThrow('公告读取请求失败')
    vi.setSystemTime(new Date('2026-10-07T10:01:00Z'))
    await expect(client.getNotice!()).resolves.toMatchObject({ text: '公告正文' })
    expect(noticeReads(fetchImpl)).toBe(2)
  })

  it('shares one download between opening the notice and the periodic check', async () => {
    let answer: (value: Response) => void = () => undefined
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve }))
    const client = createNewApiClient({ baseUrl: 'https://notice.example.test', fetchImpl: withEmptyStatus(fetchImpl) })
    const opened = client.getNotice!()
    const periodic = client.getNotice!('cached')
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    answer(response('公告正文'))
    await expect(opened).resolves.toMatchObject({ text: '公告正文' })
    await expect(periodic).resolves.toMatchObject({ text: '公告正文' })
    expect(noticeReads(fetchImpl)).toBe(1)
  })
})
