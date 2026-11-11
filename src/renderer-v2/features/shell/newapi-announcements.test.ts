import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatTimelineDate, formatTimelineListDate, splitTimelineContent, timelineEntries, timelineFreshWindowMs, timelineMigrationReadIds, withMarkdownLineBreaks, announcementAttentionKeys, announcementNotificationKey, readNotifiedAnnouncementKeys, readSeenAnnouncementKeys, rememberNotifiedAnnouncementKeys, rememberSeenAnnouncementKeys, sameAnnouncementSnapshot } from './newapi-announcements'

describe('announcement attention keys', () => {
  it('asks for attention only for unread entries or an unread single notice', () => {
    expect(announcementAttentionKeys(null, null)).toEqual([])
    expect(announcementAttentionKeys({ id: 'notice-1' }, null)).toEqual(['notice:notice-1'])
    expect(announcementAttentionKeys({ id: 'notice-1' }, 'notice-1')).toEqual([])
    expect(announcementAttentionKeys({ id: 'snapshot', entries: [{ id: 'a', read: true }, { id: 'b', read: false }] }, null)).toEqual(['entry:b'])
  })

  it('bounds keys built from opaque server ids', () => {
    const [key] = announcementAttentionKeys({ id: 'x'.repeat(5000) }, null)
    expect(key).toHaveLength(256)
  })
})

describe('seen announcement storage', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('keeps seen keys per account and merges new ones', () => {
    rememberSeenAnnouncementKeys('xm-account:1', ['entry:a'])
    expect(rememberSeenAnnouncementKeys('xm-account:1', ['entry:b', 'entry:a'])).toEqual(['entry:b', 'entry:a'])
    expect(readSeenAnnouncementKeys('xm-account:1')).toEqual(['entry:b', 'entry:a'])
    expect(readSeenAnnouncementKeys('xm-account:2')).toEqual([])
  })

  it('ignores corrupted storage and keeps only the latest 200 keys', () => {
    store.set('xingmang-v2-notice-seen:s', '{not json')
    expect(readSeenAnnouncementKeys('s')).toEqual([])
    store.set('xingmang-v2-notice-seen:s', JSON.stringify([1, 'entry:ok', 'y'.repeat(300)]))
    expect(readSeenAnnouncementKeys('s')).toEqual(['entry:ok'])
    const keys = Array.from({ length: 250 }, (_, index) => `entry:${index}`)
    expect(rememberSeenAnnouncementKeys('s', keys)).toHaveLength(200)
    expect(readSeenAnnouncementKeys('s').at(-1)).toBe('entry:249')
  })

  it('still returns the merged keys when storage refuses writes', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota') } })
    expect(rememberSeenAnnouncementKeys('s', ['entry:a'])).toEqual(['entry:a'])
  })
})

describe('announcement notification helpers', () => {
  it('derives a short bridge-safe key that ignores order but changes with the notices', () => {
    const key = announcementNotificationKey(['entry:b', 'notice:任意 服务端 id'])
    expect(key).toMatch(/^notice-[0-9a-f]{8}$/)
    expect(announcementNotificationKey(['notice:任意 服务端 id', 'entry:b'])).toBe(key)
    expect(announcementNotificationKey(['entry:c'])).not.toBe(key)
  })

  it('treats a background read as unchanged only when ids and read states match', () => {
    const base = { id: 's', entries: [{ id: 'a', read: false }, { id: 'b', read: true }] }
    expect(sameAnnouncementSnapshot(base, { id: 's', entries: [{ id: 'a', read: false }, { id: 'b', read: true }] })).toBe(true)
    expect(sameAnnouncementSnapshot(base, { id: 's', entries: [{ id: 'a', read: true }, { id: 'b', read: true }] })).toBe(false)
    expect(sameAnnouncementSnapshot(base, { id: 's', entries: [{ id: 'a', read: false }] })).toBe(false)
    expect(sameAnnouncementSnapshot({ id: 'x' }, { id: 'x' })).toBe(true)
    expect(sameAnnouncementSnapshot({ id: 'x' }, { id: 'y' })).toBe(false)
    expect(sameAnnouncementSnapshot(null, null)).toBe(true)
    expect(sameAnnouncementSnapshot(null, { id: 'x' })).toBe(false)
  })

  it('keeps notified notices separate from seen ones', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } })
    try {
      rememberNotifiedAnnouncementKeys('s', ['entry:a'])
      expect(readNotifiedAnnouncementKeys('s')).toEqual(['entry:a'])
      expect(readSeenAnnouncementKeys('s')).toEqual([])
    } finally { vi.unstubAllGlobals() }
  })
})

describe('announcement timeline entries', () => {
  it('takes the first line as the title and keeps the rest as the body', () => {
    expect(splitTimelineContent('**gpt-image-2.5 已上线**\n新图片模型现已上线：\n1. 打开配置')).toEqual({
      title: 'gpt-image-2.5 已上线', body: '新图片模型现已上线：\n1. 打开配置',
    })
    expect(splitTimelineContent('\n\n## __维护通知__\n周末维护')).toEqual({ title: '维护通知', body: '周末维护' })
    // A single line gives the title and still shows the whole text as the body.
    expect(splitTimelineContent('**只有一行**')).toEqual({ title: '只有一行', body: '**只有一行**' })
    const long = splitTimelineContent(`**${'很长'.repeat(40)}**\n正文`)
    expect([...long.title]).toHaveLength(61)
    expect(long.title.endsWith('…')).toBe(true)
  })

  it('turns single newlines into line breaks like the relay website does', () => {
    expect(withMarkdownLineBreaks('三步即可使用：\n1. 进入画布\n2. 选择分组\n\n下一段')).toBe('三步即可使用：  \n1. 进入画布  \n2. 选择分组\n\n下一段')
    expect(withMarkdownLineBreaks('```\na\nb\n```')).toBe('```\na\nb\n```')
  })

  it('shows the publish time as a date and how long ago', () => {
    // 本机时区：用本地时间造日期，哪个时区跑都是同一句。
    const now = new Date(2026, 8, 12, 12, 0).getTime()
    expect(formatTimelineDate(new Date(2026, 8, 9, 20, 0).toISOString(), now)).toBe('9月9日 20:00 · 2 天前')
    expect(formatTimelineDate(new Date(2026, 8, 9, 12, 0).toISOString(), now)).toBe('9月9日 12:00 · 3 天前')
    expect(formatTimelineDate(new Date(2026, 8, 12, 11, 30).toISOString(), now)).toBe('今天 11:30 · 30 分钟前')
    expect(formatTimelineDate(new Date(2026, 8, 11, 22, 0).toISOString(), now)).toBe('昨天 22:00 · 14 小时前')
    expect(formatTimelineDate(new Date(2026, 8, 12, 12, 0).toISOString(), now)).toBe('今天 12:00 · 刚刚')
    expect(formatTimelineDate('not a date', now)).toBe('')
  })

  it('writes only the date for entries 30 days old or more, never "12 months ago"', () => {
    // D60：以前按 30 天一个月折算，360～364 天会写「12 个月前」。
    const now = new Date(2026, 10, 20, 18, 0).getTime()
    expect(formatTimelineDate(new Date(2025, 10, 20, 18, 0).toISOString(), now)).toBe('2025年11月20日 18:00')
    expect(formatTimelineDate(new Date(2025, 10, 22, 18, 0).toISOString(), now)).toBe('2025年11月22日 18:00')
    // 边界按经过的时长算，不按日历：夏令时那一小时不影响。
    expect(formatTimelineDate(new Date(now - 30 * 86_400_000).toISOString(), now)).not.toContain(' · ')
    expect(formatTimelineDate(new Date(now - 30 * 86_400_000 + 60_000).toISOString(), now)).toMatch(/^\d+月\d+日 \d\d:\d\d · 29 天前$/)
  })

  it('keeps the short list date as month and day', () => {
    expect(formatTimelineListDate(new Date(2026, 8, 9, 20, 0).toISOString())).toBe('09-09')
    expect(formatTimelineListDate('not a date')).toBe('')
  })

  it('marks moved-over and week-old entries read the first time an account sees the timeline', () => {
    const now = Date.parse('2026-09-24T12:00:00Z')
    const entries = timelineEntries([
      { id: 'newapi-a', content: '**gpt-image-2.5 已上线**\n正文', extra: '', publishedAt: '2026-09-23T12:00:00Z', type: 'success' },
      { id: 'newapi-b', content: '**本周新公告**\n正文', extra: '', publishedAt: '2026-09-23T12:00:00Z', type: 'default' },
      { id: 'newapi-c', content: '**很久以前**\n正文', extra: '', publishedAt: new Date(now - timelineFreshWindowMs - 1).toISOString(), type: 'default' },
    ])
    expect(entries[0]).toMatchObject({ title: 'gpt-image-2.5 已上线', text: '正文', timeline: { type: 'success' } })
    expect(timelineMigrationReadIds(entries, [' gpt-image-2.5  已上线 ', '别的标题'], now)).toEqual(['newapi-a', 'newapi-c'])
  })
})
