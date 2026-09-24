import { readLocalPreference, writeLocalPreference } from '../app/preferences'

export interface LocalAnnouncementEntry { id: string; title: string; text: string }
const maximumContentLength = 4 * 1024 * 1024
const maximumEntries = 100
const maximumNodes = 20_000
const maximumRememberedEntries = 200
const entryIdPattern = /^newapi-[a-f0-9]{64}$/

function malformed(): never { throw new Error('公告合集格式无法识别，请重新读取或到官网查看。') }

/** Extract the published collection envelope, leaving each body for the existing sanitizer. */
export async function parseNewApiAnnouncementCollection(text: string): Promise<LocalAnnouncementEntry[] | null> {
  if (!/\bdata-newapi-collection\s*=/i.test(text) || typeof DOMParser === 'undefined') return null
  if (text.length > maximumContentLength) throw new Error('公告合集超出读取上限，请到官网查看。')
  const parsed = new DOMParser().parseFromString(text, 'text/html')
  const roots = Array.from(parsed.body.children)
  const root = roots[0]
  if (roots.length !== 1 || root?.getAttribute('data-newapi-collection') !== 'v1'
    || Array.from(parsed.body.childNodes).some((node) => node.nodeType === 3 && node.textContent?.trim())) malformed()
  const walker = parsed.createTreeWalker(root, NodeFilter.SHOW_ALL)
  let count = 0
  while (walker.nextNode()) if (++count > maximumNodes) throw new Error('公告合集内容过多，请到官网查看。')
  const items = Array.from(root.children).filter((element) => element.matches('details.collection-entry'))
  if (items.length > maximumEntries) throw new Error('公告合集条目过多，请到官网查看。')
  // Never flatten an unrecognized collection back into a wall of mixed details.
  if (!items.length || root.querySelectorAll('details.collection-entry').length !== items.length) malformed()
  const entries: LocalAnnouncementEntry[] = []
  const ids = new Set<string>()
  for (const item of items) {
    const summaries = Array.from(item.children).filter((element) => element.matches('summary.collection-summary'))
    const bodies = Array.from(item.children).filter((element) => element.matches('.collection-body'))
    const titles = summaries[0]?.querySelectorAll('.collection-entry-title')
    if (summaries.length !== 1 || bodies.length !== 1 || titles?.length !== 1) malformed()
    const titleNode = titles[0].cloneNode(true) as Element
    titleNode.querySelectorAll('script, style, template').forEach((element) => element.remove())
    const title = (titleNode.textContent ?? '').replace(/\s+/g, ' ').trim()
    const body = bodies[0].innerHTML.trim()
    if (!title || title.length > 512 || !body) malformed()
    // A collection wrapper/id changes when another notice is published. Hash
    // only this entry so old read states survive insertions and reordering.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([title, body])))
    const id = `newapi-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
    if (ids.has(id)) continue
    ids.add(id)
    entries.push({ id, title, text: body })
  }
  return entries
}

function storageKey(scope: string): string { return `xingmang-v2-notice-entries:${scope}` }

/** The old single-notice ID may be opaque; persist it in the same bounded hash namespace. */
export async function legacyAnnouncementReadId(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))
  return `legacy-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function readLegacyAnnouncementId(scope: string): string | null {
  return readLocalPreference(`xingmang-v2-notice:${scope}`)
    ?? (scope.startsWith('xm-account:') ? readLocalPreference(`xingmang-v2-notice:${scope.replace('xm-account:', 'solov:')}`) : null)
}

export function readLocalAnnouncementIds(scope: string): string[] {
  const stored = readLocalPreference(storageKey(scope))
  if (!stored || stored.length > 20_000) return []
  try {
    const value: unknown = JSON.parse(stored)
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && entryIdPattern.test(id)))].slice(-maximumRememberedEntries) : []
  } catch { return [] }
}

export function markLocalAnnouncementRead(scope: string, id: string): boolean {
  if (!entryIdPattern.test(id)) return false
  return rememberLocalAnnouncementIds(scope, [id])
}

export function rememberLocalAnnouncementIds(scope: string, ids: string[]): boolean {
  const next = ids.filter((id) => entryIdPattern.test(id))
  const previous = readLocalAnnouncementIds(scope).filter((id) => !next.includes(id))
  return writeLocalPreference(storageKey(scope), JSON.stringify([...new Set([...previous, ...next])].slice(-maximumRememberedEntries)))
}

function seenStorageKey(scope: string): string { return `xingmang-v2-notice-seen:${scope}` }
function notifiedStorageKey(scope: string): string { return `xingmang-v2-notice-notified:${scope}` }
const maximumSeenKeyLength = 256

/**
 * Keys for the notices that still ask for attention. Seen is weaker than read:
 * once someone opened the notice center or closed the banner, the banner and
 * the bell dot stay quiet until a notice with a new key shows up.
 */
export function announcementAttentionKeys(announcement: { id: string; entries?: Array<{ id: string; read: boolean }> } | null, readId: string | null): string[] {
  if (!announcement) return []
  if (announcement.entries) return announcement.entries.filter((entry) => !entry.read).map((entry) => `entry:${entry.id}`.slice(0, maximumSeenKeyLength))
  return announcement.id === readId ? [] : [`notice:${announcement.id}`.slice(0, maximumSeenKeyLength)]
}

function readAnnouncementKeys(storageKey: string): string[] {
  const stored = readLocalPreference(storageKey)
  if (!stored || stored.length > 80_000) return []
  try {
    const value: unknown = JSON.parse(stored)
    return Array.isArray(value) ? [...new Set(value.filter((key): key is string => typeof key === 'string' && key.length <= maximumSeenKeyLength))].slice(-maximumRememberedEntries) : []
  } catch { return [] }
}

function rememberAnnouncementKeys(storageKey: string, keys: string[]): string[] {
  const previous = readAnnouncementKeys(storageKey).filter((key) => !keys.includes(key))
  const next = [...new Set([...previous, ...keys])].slice(-maximumRememberedEntries)
  writeLocalPreference(storageKey, JSON.stringify(next))
  return next
}

export function readSeenAnnouncementKeys(scope: string): string[] { return readAnnouncementKeys(seenStorageKey(scope)) }

/** Returns the merged list even when storage is unavailable, so this session still stays quiet. */
export function rememberSeenAnnouncementKeys(scope: string, keys: string[]): string[] { return rememberAnnouncementKeys(seenStorageKey(scope), keys) }

// A system notification is a louder, separate reminder: it goes out once per
// notice even though the banner stays until the notice is seen.
export function readNotifiedAnnouncementKeys(scope: string): string[] { return readAnnouncementKeys(notifiedStorageKey(scope)) }

export function rememberNotifiedAnnouncementKeys(scope: string, keys: string[]): string[] { return rememberAnnouncementKeys(notifiedStorageKey(scope), keys) }

/**
 * The platform bridge only accepts short ASCII event keys, while notice ids
 * are opaque server strings. A stable 32-bit FNV-1a digest is enough to tell
 * two batches apart for de-duplication; the text of the notice never leaves
 * the renderer.
 */
export function announcementNotificationKey(keys: string[]): string {
  let hash = 0x811c9dc5
  for (const character of [...keys].sort().join('\n')) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `notice-${hash.toString(16).padStart(8, '0')}`
}

/** Whether a background refresh brought anything the screen does not already show. */
export function sameAnnouncementSnapshot(previous: { id: string; entries?: Array<{ id: string; read: boolean }> } | null, next: { id: string; entries?: Array<{ id: string; read: boolean }> } | null): boolean {
  if (!previous || !next) return previous === next
  if (previous.id !== next.id || Boolean(previous.entries) !== Boolean(next.entries)) return false
  if (!previous.entries || !next.entries) return true
  return previous.entries.length === next.entries.length
    && previous.entries.every((entry, index) => entry.id === next.entries?.[index]?.id && entry.read === next.entries[index].read)
}

export type TimelineType = 'default' | 'ongoing' | 'success' | 'warning' | 'error'
export interface TimelineSource { id: string; content: string; extra: string; publishedAt: string; type: TimelineType }
export interface TimelineMeta { type: TimelineType; publishedAt: string; extra: string }
export interface TimelineEntry extends LocalAnnouncementEntry { timeline: TimelineMeta }

/** 和网页端圆点同一套含义：灰、蓝（进行中）、绿、橙、红。 */
export const timelineTypeLabels: Record<TimelineType, string> = {
  default: '通知',
  ongoing: '进行中',
  success: '上新',
  warning: '注意',
  error: '重要',
}
const maximumTimelineTitleLength = 60
/** 每个账号第一次接入时间线时，比这更早发布的只进列表、算已读，不出横条也不弹通知。 */
export const timelineFreshWindowMs = 7 * 24 * 60 * 60 * 1000

function plainTimelineLine(line: string): string {
  return line.replace(/\*\*|__/g, '').replace(/^\s*#{1,6}\s*/, '').replace(/\s+/g, ' ').trim()
}

/** 运营约定正文第一行写成 `**标题**`：拆成标题和正文；只有一行时正文仍显示完整内容。 */
export function splitTimelineContent(content: string): { title: string; body: string } {
  const lines = content.split(/\r?\n/)
  const index = lines.findIndex((line) => plainTimelineLine(line))
  if (index < 0) return { title: '公告', body: content }
  const characters = [...plainTimelineLine(lines[index])]
  const title = characters.length > maximumTimelineTitleLength ? `${characters.slice(0, maximumTimelineTitleLength).join('')}…` : characters.join('')
  const body = lines.slice(index + 1).join('\n').trim()
  return { title, body: body || content }
}

/**
 * new-api 网页端渲染时开着 breaks，单个换行就是换行。这里把段落里的单个换行
 * 改成 Markdown 的硬换行，免得三步说明挤成一行；空行分段和代码块不动。
 */
export function withMarkdownLineBreaks(text: string): string {
  let fenced = false
  return text.split('\n').map((line, index, lines) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const next = lines[index + 1]
    if (fenced || next === undefined || !line.trim() || !next.trim() || /\s{2}$/.test(line)) return line
    return `${line}  `
  }).join('\n')
}

export function timelineEntries(bulletins: TimelineSource[]): TimelineEntry[] {
  return bulletins.map(({ id, content, extra, publishedAt, type }) => {
    const { title, body } = splitTimelineContent(content)
    return { id, title, text: body, timeline: { type, publishedAt, extra } }
  })
}

function pad(value: number): string { return String(value).padStart(2, '0') }

/** `2026-09-09 20:00 · 3 天前`，按本机时区显示。 */
export function formatTimelineDate(publishedAt: string, now: number): string {
  const date = new Date(publishedAt)
  if (!Number.isFinite(date.getTime())) return ''
  const absolute = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  const minutes = Math.floor((now - date.getTime()) / 60_000)
  const relative = minutes < 1 ? '刚刚'
    : minutes < 60 ? `${minutes} 分钟前`
      : minutes < 24 * 60 ? `${Math.floor(minutes / 60)} 小时前`
        : minutes < 30 * 24 * 60 ? `${Math.floor(minutes / (24 * 60))} 天前`
          : minutes < 365 * 24 * 60 ? `${Math.floor(minutes / (30 * 24 * 60))} 个月前`
            : `${Math.floor(minutes / (365 * 24 * 60))} 年前`
  return `${absolute} · ${relative}`
}

function normalizedTitle(title: string): string { return title.replace(/\s+/g, '') }

/**
 * 每个账号第一次拿到时间线时算已读的那些：运营从旧合集原样搬过来、标题相同且
 * 旧合集里已经读过的，以及发布超过 7 天的旧公告。之后新增的照常提醒。
 */
export function timelineMigrationReadIds(entries: TimelineEntry[], readCollectionTitles: string[], now: number): string[] {
  const titles = new Set(readCollectionTitles.map(normalizedTitle))
  return entries.filter((entry) => titles.has(normalizedTitle(entry.title)) || now - Date.parse(entry.timeline.publishedAt) > timelineFreshWindowMs).map((entry) => entry.id)
}

function timelineMigrationKey(scope: string): string { return `xingmang-v2-notice-timeline:${scope}` }

export function readTimelineMigrated(scope: string): boolean { return readLocalPreference(timelineMigrationKey(scope)) === '1' }

export function rememberTimelineMigrated(scope: string): void { writeLocalPreference(timelineMigrationKey(scope), '1') }
