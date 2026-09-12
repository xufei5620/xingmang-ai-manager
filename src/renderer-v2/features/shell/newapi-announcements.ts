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
