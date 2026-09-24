import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announcementAttentionKeys, readSeenAnnouncementKeys, rememberSeenAnnouncementKeys } from './newapi-announcements'

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
