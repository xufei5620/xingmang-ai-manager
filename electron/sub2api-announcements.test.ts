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
      { id: '7', title: '系统公告', content: '更新内容 **Markdown**', updatedAt: '2026-09-09T00:00:00.000Z', readAt: null },
      { id: '8', title: '<img src=x onerror=alert(1)>', content: '第二条', updatedAt: '2026-09-09T00:00:00.000Z', readAt: '2026-09-09T01:00:00.000Z' },
    ])
    const notice = sub2ApiAnnouncementNotice(parsed)
    expect(notice?.entries).toEqual([
      { id: '7', title: '系统公告', text: '更新内容 **Markdown**', read: false },
      { id: '8', title: '<img src=x onerror=alert(1)>', text: '第二条', read: true },
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
    [announcement({ updated_at: 'broken' })], [announcement(), announcement()],
    Array.from({ length: 101 }, (_, id) => announcement({ id: id + 1 })),
    [announcement({ content: '中'.repeat(750_000) }), announcement({ id: 8, content: '中'.repeat(750_000) })],
  ].map((payload) => ({ payload })))('rejects malformed or excessive announcement payload %#', ({ payload }) => {
    expect(() => parseSub2ApiAnnouncements(payload)).toThrow('响应格式不兼容')
  })
})
