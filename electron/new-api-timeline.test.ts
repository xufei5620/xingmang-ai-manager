import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNewApiClient, parseNoticeBulletins } from './new-api-client'

const origin = 'https://notice.example.test'
// The three entries the operator moved over from the old collection (shape copied from their draft).
const draft = [
  { id: 3, publishDate: '2026-09-09T20:00:00+08:00', type: 'success', extra: '有问题请[联系微信客服](https://work.weixin.qq.com/kfid/kfc3ac7eece5344c034)。', content: '**gpt-image-2.5 已上线**\n新图片模型 gpt-image-2.5 现已上线，三步即可使用：\n1. 进入「无限画布」，打开「配置」；\n2. 「图片分组」选择「图片模型-中转/订阅」；' },
  { publishDate: '2026-09-07T12:00:00+08:00', type: 'ongoing', extra: '', content: '**开票中心上线测试**\n测试阶段可能存在问题。' },
  { id: 'two', publishDate: '2026-09-09T12:00:00+08:00', type: 'warning', content: '**GPT-5.4 / mini 已下架，请停止请求**\nOpenAI 已下架。' },
]

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function relay(state: { notice: string; status: () => Response }) {
  return vi.fn(async (input: RequestInfo | URL) => new URL(String(input)).pathname === '/api/status'
    ? state.status()
    : json({ success: true, data: state.notice }))
}

function statusWith(announcements: unknown, enabled = true) {
  return () => json({ success: true, data: enabled ? { announcements_enabled: true, announcements } : { announcements_enabled: false } })
}

function requested(fetchImpl: ReturnType<typeof relay>) {
  return fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname)
}

describe('new-api announcement timeline', () => {
  afterEach(() => { vi.useRealTimers() })

  it('lists timeline entries newest first with type, date and note when the system notice is empty', async () => {
    const fetchImpl = relay({ notice: '', status: statusWith(draft) })
    const client = createNewApiClient({ baseUrl: origin, fetchImpl })
    const notice = await client.getNotice!()
    expect(notice?.text).toBe('')
    expect(notice?.bulletins?.map(({ content, type, publishedAt }) => [content.split('\n')[0], type, publishedAt])).toEqual([
      ['**gpt-image-2.5 已上线**', 'success', '2026-09-09T20:00:00+08:00'],
      ['**GPT-5.4 / mini 已下架，请停止请求**', 'warning', '2026-09-09T12:00:00+08:00'],
      ['**开票中心上线测试**', 'ongoing', '2026-09-07T12:00:00+08:00'],
    ])
    expect(notice?.bulletins?.[0].extra).toContain('https://work.weixin.qq.com/')
    expect(notice?.bulletins?.[2].extra).toBe('')
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toMatch(/Authorization|Cookie/)
  })

  it('keys each entry by origin and publish time, so fixing a typo keeps its read state', () => {
    const [first] = parseNoticeBulletins({ announcements: [draft[0]] }, origin)
    const [edited] = parseNoticeBulletins({ announcements: [{ ...draft[0], id: 99, content: `${draft[0].content}（已更正）` }] }, origin)
    const expected = `newapi-${createHash('sha256').update(`${origin}\nannouncement\n2026-09-09T20:00:00+08:00`).digest('hex')}`
    expect(first.id).toBe(expected)
    expect(edited.id).toBe(expected)
    const [republished] = parseNoticeBulletins({ announcements: [{ ...draft[0], publishDate: '2026-09-10T20:00:00+08:00' }] }, origin)
    expect(republished.id).not.toBe(expected)
    expect(parseNoticeBulletins({ announcements: [draft[0]] }, 'https://other.example.test')[0].id).not.toBe(expected)
  })

  it('tells apart two entries published at the same moment', () => {
    const entries = parseNoticeBulletins({ announcements: [
      { publishDate: '2026-09-09T20:00:00+08:00', content: '第一条' },
      { publishDate: '2026-09-09T20:00:00+08:00', content: '第二条' },
    ] }, origin)
    expect(entries).toHaveLength(2)
    expect(entries[0].id).not.toBe(entries[1].id)
    expect(entries.every(({ id }) => /^newapi-[a-f0-9]{64}$/.test(id))).toBe(true)
  })

  it('skips entries a direct database edit could have broken and keeps the rest', () => {
    const entries = parseNoticeBulletins({ announcements: [
      null,
      'text',
      { publishDate: '2026-09-09T20:00:00+08:00', content: 'x'.repeat(3_000) },
      { publishDate: '2026-09-09T20:00:00+08:00', content: '说明过长', extra: 'y'.repeat(501) },
      { publishDate: 'yesterday', content: '日期坏了' },
      { publishDate: 20260909, content: '日期类型不对' },
      { publishDate: '2026-09-09T20:00:00+08:00', content: 42 },
      { publishDate: '2026-09-09T20:00:00+08:00', content: '说明类型不对', extra: 7 },
      { id: { nested: true }, publishDate: '2026-09-08T20:00:00+08:00', content: '保留', type: 'purple' },
    ] }, origin)
    expect(entries.map(({ content, type }) => [content, type])).toEqual([['保留', 'default']])
  })

  it('shows at most 20 entries out of at most 100 read', () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
      publishDate: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      content: `第 ${index} 条`,
    }))
    const entries = parseNoticeBulletins({ announcements: many }, origin)
    expect(entries).toHaveLength(20)
    // Only the first 100 are looked at; the newest of those comes first.
    expect(entries[0].content).toBe('第 99 条')
  })

  it('leaves the system notice alone when the timeline panel is switched off', async () => {
    const client = createNewApiClient({ baseUrl: origin, fetchImpl: relay({ notice: '系统公告', status: statusWith(draft, false) }) })
    const notice = await client.getNotice!()
    expect(notice).toMatchObject({ text: '系统公告' })
    expect(notice).not.toHaveProperty('bulletins')
  })

  it('merges both sources and keeps the system notice id stable when the timeline changes', async () => {
    const state = { notice: '系统公告', status: statusWith(draft.slice(0, 1)) }
    vi.useFakeTimers({ now: new Date('2026-09-24T10:00:00Z'), toFake: ['Date'] })
    const client = createNewApiClient({ baseUrl: origin, fetchImpl: relay(state) })
    const first = await client.getNotice!()
    expect(first?.bulletins).toHaveLength(1)
    state.status = statusWith(draft)
    vi.setSystemTime(new Date('2026-09-24T10:06:00Z'))
    const second = await client.getNotice!()
    expect(second?.bulletins).toHaveLength(3)
    expect(second?.id).toBe(first?.id)
  })

  it('keeps the last timeline when /api/status fails or the network is down', async () => {
    const state = { notice: '', status: statusWith(draft) }
    vi.useFakeTimers({ now: new Date('2026-09-24T10:00:00Z'), toFake: ['Date'] })
    const fetchImpl = relay(state)
    const client = createNewApiClient({ baseUrl: origin, fetchImpl })
    expect((await client.getNotice!())?.bulletins).toHaveLength(3)
    state.status = () => json({ success: false, message: 'boom' }, 500)
    vi.setSystemTime(new Date('2026-09-24T10:06:00Z'))
    expect((await client.getNotice!())?.bulletins).toHaveLength(3)
    state.status = () => { throw new TypeError('Failed to fetch') }
    vi.setSystemTime(new Date('2026-09-24T10:12:00Z'))
    expect((await client.getNotice!())?.bulletins).toHaveLength(3)
    // And a relay that never delivered a timeline stays quiet instead of failing.
    const fresh = createNewApiClient({ baseUrl: origin, fetchImpl: relay({ notice: '系统公告', status: () => json({}, 500) }) })
    await expect(fresh.getNotice!()).resolves.toMatchObject({ text: '系统公告' })
  })

  it('lets the periodic check reuse what the balance refresh already fetched', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-24T10:00:00Z'), toFake: ['Date'] })
    const state = { notice: '系统公告', status: statusWith(draft.slice(0, 1)) }
    const fetchImpl = relay(state)
    const client = createNewApiClient({ baseUrl: origin, fetchImpl })
    await client.getNotice!()
    expect(requested(fetchImpl).sort()).toEqual(['/api/notice', '/api/status'])
    fetchImpl.mockClear()
    // Within five minutes of the last status read nothing new is requested.
    vi.setSystemTime(new Date('2026-09-24T10:04:00Z'))
    await client.getNotice!('cached')
    expect(requested(fetchImpl)).toEqual([])
    // An explicit open still re-reads the system notice.
    await client.getNotice!()
    expect(requested(fetchImpl)).toEqual(['/api/notice'])
  })

  it('does not treat the item id as identity, because the admin reuses it', () => {
    const [before] = parseNoticeBulletins({ announcements: [{ id: 4, publishDate: '2026-09-20T10:00:00Z', content: '被删掉的一条' }] }, origin)
    const [after] = parseNoticeBulletins({ announcements: [{ id: 4, publishDate: '2026-09-24T10:00:00Z', content: '新建的一条' }] }, origin)
    expect(after.id).not.toBe(before.id)
  })
})
