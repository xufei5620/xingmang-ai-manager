import { createHash } from 'node:crypto'
import { isRealmRecord, RealmAccountError } from './realm-account'
import type { RelayNotice } from './relay-backend'

export interface Sub2ApiAnnouncement {
  id: string
  title: string
  content: string
  readAt: string | null
  updatedAt: string | null
  publishedAt: string | null
}

function protocol(): never { throw new RealmAccountError('PROTOCOL') }
const maximumAnnouncementBytes = 4 * 1024 * 1024

function timestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) protocol()
  return new Date(value).toISOString()
}

// 定时公告要到开始时间才对用户可见，比创建时间晚；开始时间早于创建时间时，创建那一刻就已可见。
function resolvePublishedAt(startsAt: string | null, createdAt: string | null): string | null {
  if (startsAt === null || createdAt === null) return startsAt ?? createdAt
  return Date.parse(startsAt) > Date.parse(createdAt) ? startsAt : createdAt
}

function publishedTime({ publishedAt }: Sub2ApiAnnouncement): number {
  return publishedAt === null ? -Infinity : Date.parse(publishedAt)
}

// Sub2API 把已读的排到所有未读后面，最新一条读过后会沉到列表底部；这里不分已读未读，最近发布的排最前面。
function newestFirst(a: Sub2ApiAnnouncement, b: Sub2ApiAnnouncement): number {
  return publishedTime(b) - publishedTime(a) || Number(b.id) - Number(a.id)
}

/** Only user-facing fields leave this parser; admin/credential fields never propagate. */
export function parseSub2ApiAnnouncements(payload: unknown): Sub2ApiAnnouncement[] {
  if (!Array.isArray(payload) || payload.length > 100) protocol()
  const ids = new Set<string>()
  let totalLength = 0
  return payload.map((value) => {
    if (!isRealmRecord(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0
      || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 256
      || typeof value.content !== 'string' || !value.content.trim() || Buffer.byteLength(value.content, 'utf8') > maximumAnnouncementBytes
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.title + value.content)) protocol()
    const id = String(value.id)
    totalLength += Buffer.byteLength(value.title + value.content, 'utf8')
    if (ids.has(id) || totalLength > maximumAnnouncementBytes) protocol()
    ids.add(id)
    return { id, title: value.title.trim(), content: value.content.trim(),
      readAt: timestamp(value.read_at), updatedAt: timestamp(value.updated_at),
      publishedAt: resolvePublishedAt(timestamp(value.starts_at), timestamp(value.created_at)) }
  })
}

export function sub2ApiAnnouncementNotice(announcements: Sub2ApiAnnouncement[]): RelayNotice | null {
  if (!announcements.length) return null
  // Read state does not change the content identity; request order does not either.
  const identity = announcements.map(({ id, title, content, updatedAt }) => ({ id, title, content, updatedAt }))
    .sort((a, b) => Number(a.id) - Number(b.id))
  const ordered = [...announcements].sort(newestFirst)
  return {
    id: `sub2api-${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`,
    text: ordered.map(({ title, content }) => `${title}\n\n${content}`).join('\n\n---\n\n'),
    entries: ordered.map(({ id, title, content, readAt, publishedAt }) => ({
      id, title, text: content, read: readAt !== null, ...(publishedAt === null ? {} : { publishedAt }),
    })),
  }
}
