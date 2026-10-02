import { describe, expect, it } from 'vitest'
import { parseSub2ApiAnnouncements, sub2ApiAnnouncementNotice } from './sub2api-announcements'

const announcement = (extra: Record<string, unknown> = {}) => ({
  id: 7, title: '系统公告', content: '更新内容 **Markdown**', updated_at: '2026-09-09T00:00:00Z', ...extra,
})

describe('Sub2API announcements parser', () => {
  it('preserves every visible announcement and authoritative read state with a field whitelist', () => {
    const parsed = parseSub2ApiAnnouncements([announcement({ access_token: 'do-not-return', refresh_token: 'do-not-return',
      targeting: { private: 'do-not-return' }, created_by: 987, key: 'do-not-return' }),
    announcement({ id: 8, title: '<img src=x onerror=alert(1)>', content: '第二条', read_at: '2026-09-09T01:00:00Z' })])
    expect(parsed).toEqual([
      { id: '7', title: '系统公告', content: '更新内容 **Markdown**', updatedAt: '2026-09-09T00:00:00.000Z', readAt: null, publishedAt: null },
      { id: '8', title: '<img src=x onerror=alert(1)>', content: '第二条', updatedAt: '2026-09-09T00:00:00.000Z', readAt: '2026-09-09T01:00:00.000Z', publishedAt: null },
    ])
    const notice = sub2ApiAnnouncementNotice(parsed)
    expect(notice?.entries).toEqual([
      { id: '8', title: '<img src=x onerror=alert(1)>', text: '第二条', read: true },
      { id: '7', title: '系统公告', text: '更新内容 **Markdown**', read: false },
    ])
    expect(JSON.stringify(notice)).not.toMatch(/do-not-return|targeting|created_by/)
    expect(notice?.text).toContain('第二条')
  })

  it('keeps content identity stable across read-state, order, and clock changes', () => {
    const first = sub2ApiAnnouncementNotice(parseSub2ApiAnnouncements([announcement(), announcement({ id: 8 })]))!
    const reordered = sub2ApiAnnouncementNotice(parseSub2ApiAnnouncements([
      announcement({ id: 8 }), announcement({ read_at: '2026-09-10T01:00:00Z' }),
    ]))!
    expect(first.id).toMatch(/^sub2api-[a-f0-9]{64}$/)
    expect(reordered.id).toBe(first.id)
    for (const change of [{ id: 9 }, { title: '标题变更' }, { content: '内容变更' }, { updated_at: '2026-09-10T00:00:00Z' }]) {
      expect(sub2ApiAnnouncementNotice(parseSub2ApiAnnouncements([announcement(change), announcement({ id: 8 })]))?.id).not.toBe(first.id)
    }
  })

  it('lists the most recently published announcement first even after it was read', () => {
    // The server sends unread entries first, so the newest one sinks once read.
    const notice = sub2ApiAnnouncementNotice(parseSub2ApiAnnouncements([
      announcement({ id: 5, title: '旧未读', created_at: '2026-09-05T00:00:00Z' }),
      announcement({ id: 3, title: '更旧未读', created_at: '2026-09-03T00:00:00Z' }),
      announcement({ id: 9, title: '最新已读', created_at: '2026-09-09T00:00:00Z', read_at: '2026-09-09T02:00:00Z' }),
      announcement({ id: 7, title: '较新已读', created_at: '2026-09-07T00:00:00Z', read_at: '2026-09-07T02:00:00Z' }),
    ]))!
    expect(notice.entries?.map(({ title, read }) => [title, read])).toEqual([
      ['最新已读', true], ['较新已读', true], ['旧未读', false], ['更旧未读', false],
    ])
    expect(notice.text.indexOf('最新已读')).toBeLessThan(notice.text.indexOf('更旧未读'))
  })

  it('orders a scheduled announcement by the time it went live', () => {
    const parsed = parseSub2ApiAnnouncements([
      announcement({ id: 6, title: '普通', created_at: '2026-09-05T00:00:00Z' }),
      announcement({ id: 4, title: '定时', created_at: '2026-09-01T00:00:00Z', starts_at: '2026-09-10T00:00:00Z' }),
      announcement({ id: 8, title: '补填开始时间', created_at: '2026-09-08T00:00:00Z', starts_at: '2026-08-01T00:00:00Z' }),
    ])
    expect(parsed.map(({ publishedAt }) => publishedAt))
      .toEqual(['2026-09-05T00:00:00.000Z', '2026-09-10T00:00:00.000Z', '2026-09-08T00:00:00.000Z'])
    expect(sub2ApiAnnouncementNotice(parsed)?.entries?.map(({ title }) => title)).toEqual(['定时', '补填开始时间', '普通'])
  })

  it('falls back to newest id when publish times are missing or equal', () => {
    const notice = sub2ApiAnnouncementNotice(parseSub2ApiAnnouncements([
      announcement({ id: 3 }), announcement({ id: 2, created_at: '2026-09-01T00:00:00Z' }),
      announcement({ id: 9 }), announcement({ id: 5, created_at: '2026-09-01T00:00:00Z' }),
    ]))
    expect(notice?.entries?.map(({ id }) => id)).toEqual(['5', '2', '9', '3'])
  })

  it('returns no notice only for a valid empty array', () => {
    expect(sub2ApiAnnouncementNotice(parseSub2ApiAnnouncements([]))).toBeNull()
  })

  it('accepts a rich notice with inline media larger than an ordinary API response', () => {
    const content = '<img src="data:image/png;base64,' + 'A'.repeat(2_600_000) + '">'
    expect(parseSub2ApiAnnouncements([announcement({ content })])[0].content).toBe(content)
  })

  it.each([null, {}, { items: [] }, 'announcements', [null], [announcement({ id: '7' })],
    [announcement({ id: 0 })], [announcement({ id: -1 })], [announcement({ id: 1.5 })],
    [announcement({ id: Number.MAX_SAFE_INTEGER + 1 })], [announcement({ title: 7 })],
    [announcement({ content: {} })], [announcement({ title: ' ' })], [announcement({ content: '' })],
    [announcement({ title: 'x'.repeat(257) })], [announcement({ content: 'x'.repeat(4 * 1024 * 1024 + 1) })],
    [announcement({ content: 'null\u0000byte' })], [announcement({ read_at: true })],
    [announcement({ updated_at: 'broken' })], [announcement({ created_at: 'broken' })],
    [announcement({ starts_at: 20260910 })], [announcement(), announcement()],
    Array.from({ length: 101 }, (_, id) => announcement({ id: id + 1 })),
    [announcement({ content: '中'.repeat(750_000) }), announcement({ id: 8, content: '中'.repeat(750_000) })],
  ].map((payload) => ({ payload })))('rejects malformed or excessive announcement payload %#', ({ payload }) => {
    expect(() => parseSub2ApiAnnouncements(payload)).toThrow('响应格式不兼容')
  })
})
