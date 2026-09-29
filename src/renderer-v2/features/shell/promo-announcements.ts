import { readLocalPreference, writeLocalPreference } from '../app/preferences'
import { timelineFreshWindowMs, type TimelineMeta } from './newapi-announcements'

// 账号服务的公告只有「正文、附加说明、发布时间、类型」四样，没有「活动类型」「结束时间」
// 「按钮链接」。先用约定顶上：标题里带「充值」就是充值活动；正文或附加说明里写
//「截止：10月7日」或「10月1日-10月7日」就当结束时间；没写的按发布后 7 天算。
// 没有发布时间的旧式系统公告永远不会变成活动卡片，后台里没清掉的旧公告不会跟着变显眼。

export interface PromoSource { id: string; title: string; text: string; timeline?: TimelineMeta }
export interface PromoAnnouncement { id: string; title: string; text: string; publishedAt: number; endsAt: number; endsExplicitly: boolean }

const dayMs = 24 * 60 * 60 * 1000
// 年份省略时，约定写的日期不会比发布时间早太多；早于发布时间一个月以上就当成明年。
const yearRolloverSlackMs = 31 * dayMs
// 写错的年份（比如 2062）会让卡片挂很多年。活动最长按 120 天算，超出就当没写。
const maximumPromoSpanMs = 120 * dayMs
const maximumScannedLength = 4_000

export function isRechargePromoTitle(title: string): boolean {
  return title.replace(/\s+/g, '').includes('充值')
}

const datePattern = String.raw`(?:(\d{4})\s*[-/.年]\s*)?(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?(?:\s*(\d{1,2})\s*[:：点]\s*(\d{2})?)?`
const deadlinePattern = new RegExp(String.raw`(?:截止|截至|结束|到期)[^\d\n]{0,8}` + datePattern)
const rangePattern = new RegExp(datePattern + String.raw`[^\d\n]{0,3}?(?:-|~|～|—|–|至|到)\s*` + datePattern)

function plain(text: string): string {
  return text.slice(0, maximumScannedLength).replace(/<[^>]+>/g, ' ').replace(/\*\*|__|`/g, '')
}

function toLocalEnd(parts: Array<string | undefined>, publishedAt: number): number | null {
  const [yearText, monthText, dayText, hourText, minuteText] = parts
  const month = Number(monthText)
  const day = Number(dayText)
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) return null
  const hasTime = hourText !== undefined
  const hour = hasTime ? Number(hourText) : 23
  const minute = hasTime ? Number(minuteText ?? '0') : 59
  if (hour > 23 || minute > 59) return null
  const second = hasTime ? 0 : 59
  function build(year: number): number | null {
    const value = new Date(year, month - 1, day, hour, minute, second)
    return value.getMonth() === month - 1 && value.getDate() === day ? value.getTime() : null
  }
  if (yearText) return build(Number(yearText))
  const publishedYear = new Date(publishedAt).getFullYear()
  const sameYear = build(publishedYear)
  if (sameYear === null) return build(publishedYear + 1)
  return sameYear < publishedAt - yearRolloverSlackMs ? build(publishedYear + 1) : sameYear
}

/** 从正文和附加说明里找活动结束时间，按本机时区；只写日期的算到当天 23:59:59。找不到返回 null。 */
export function resolvePromoEndsAt(text: string, publishedAt: number): number | null {
  const source = plain(text)
  const deadline = deadlinePattern.exec(source)
  const range = deadline ? null : rangePattern.exec(source)
  const parts = deadline ? deadline.slice(1, 6) : range ? range.slice(6, 11) : null
  if (!parts) return null
  // 区间只写了「10月1日-7日」时，后半段没有月份；这种格式不猜，按没写处理。
  const endsAt = toLocalEnd(parts, publishedAt)
  if (endsAt === null || endsAt <= publishedAt || endsAt - publishedAt > maximumPromoSpanMs) return null
  return endsAt
}

/** 还没结束的充值活动，最新发布的在前。 */
export function activeRechargePromos(entries: PromoSource[] | undefined, now: number): PromoAnnouncement[] {
  if (!entries) return []
  const promos: PromoAnnouncement[] = []
  for (const entry of entries) {
    if (!entry.timeline || !isRechargePromoTitle(entry.title)) continue
    const publishedAt = Date.parse(entry.timeline.publishedAt)
    if (!Number.isFinite(publishedAt)) continue
    const explicit = resolvePromoEndsAt(`${entry.title}\n${entry.text}\n${entry.timeline.extra}`, publishedAt)
    const endsAt = explicit ?? publishedAt + timelineFreshWindowMs
    if (now >= endsAt) continue
    promos.push({ id: entry.id, title: entry.title, text: entry.text, publishedAt, endsAt, endsExplicitly: explicit !== null })
  }
  return promos.sort((left, right) => right.publishedAt - left.publishedAt)
}

function pad(value: number): string { return String(value).padStart(2, '0') }

/** 本机日历上的「今天」，每天第一次提醒按它算。 */
export function localDayKey(now: number): string {
  const date = new Date(now)
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

/** 「10月7日 23:59 结束，还剩 3 天」；没写结束时间的不说具体时刻，免得把估的当成承诺。 */
export function formatPromoDeadline(promo: Pick<PromoAnnouncement, 'endsAt' | 'endsExplicitly'>, now: number): string | null {
  if (!promo.endsExplicitly) return null
  const end = new Date(promo.endsAt)
  const clock = `${pad(end.getHours())}:${pad(end.getMinutes())}`
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  const days = Math.floor((new Date(promo.endsAt).setHours(0, 0, 0, 0) - startOfToday) / dayMs)
  if (days <= 0) return `今天 ${clock} 结束`
  if (days === 1) return `明天 ${clock} 结束`
  return `${end.getMonth() + 1}月${end.getDate()}日 ${clock} 结束，还剩 ${days} 天`
}

function acknowledgedKey(scope: string): string { return `xingmang-v2-promo-acknowledged:${scope}` }
function snoozedKey(scope: string): string { return `xingmang-v2-promo-snoozed:${scope}` }
function remindedKey(scope: string): string { return `xingmang-v2-promo-reminded:${scope}` }
const promoIdPattern = /^[A-Za-z0-9_-]{1,160}$/
const maximumRememberedPromos = 50

function readDayMap(key: string): Record<string, string> {
  const stored = readLocalPreference(key)
  if (!stored || stored.length > 20_000) return {}
  try {
    const value: unknown = JSON.parse(stored)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const result: Record<string, string> = {}
    for (const [id, day] of Object.entries(value)) if (promoIdPattern.test(id) && typeof day === 'string' && /^\d{8}$/.test(day)) result[id] = day
    return result
  } catch { return {} }
}

function writeDayMap(key: string, id: string, day: string): Record<string, string> {
  const next = { ...readDayMap(key), [id]: day }
  const trimmed = Object.fromEntries(Object.entries(next).slice(-maximumRememberedPromos))
  writeLocalPreference(key, JSON.stringify(trimmed))
  return trimmed
}

/** 点过「知道了」的活动：卡片收起、不再每天提醒，铃铛红点留到活动结束。 */
export function readAcknowledgedPromos(scope: string): string[] {
  const stored = readLocalPreference(acknowledgedKey(scope))
  if (!stored || stored.length > 20_000) return []
  try {
    const value: unknown = JSON.parse(stored)
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && promoIdPattern.test(id)).slice(-maximumRememberedPromos) : []
  } catch { return [] }
}

export function rememberAcknowledgedPromo(scope: string, id: string): string[] {
  const next = [...readAcknowledgedPromos(scope).filter((value) => value !== id), id].slice(-maximumRememberedPromos)
  writeLocalPreference(acknowledgedKey(scope), JSON.stringify(next))
  return next
}

/** 点过「今天不再提醒」的日子；换一天卡片和提醒就回来。 */
export function readSnoozedPromos(scope: string): Record<string, string> { return readDayMap(snoozedKey(scope)) }
export function rememberSnoozedPromo(scope: string, id: string, day: string): Record<string, string> { return writeDayMap(snoozedKey(scope), id, day) }

/** 每个活动每天最多提醒一次，记的是最后提醒的那天。 */
export function readRemindedPromos(scope: string): Record<string, string> { return readDayMap(remindedKey(scope)) }
export function rememberRemindedPromo(scope: string, id: string, day: string): Record<string, string> { return writeDayMap(remindedKey(scope), id, day) }

/** 首页该挂哪一张活动卡片：最新的、没点「知道了」、今天没点「今天不再提醒」的那个。 */
export function visiblePromo(promos: PromoAnnouncement[], acknowledged: string[], snoozed: Record<string, string>, today: string): PromoAnnouncement | null {
  return promos.find((promo) => !acknowledged.includes(promo.id) && snoozed[promo.id] !== today) ?? null
}

export interface PromoReminder { kind: 'arrival' | 'daily'; promo: PromoAnnouncement; notify: boolean }

/**
 * 这一次该不该提醒、要不要发系统通知。新活动第一次出现发「活动开始」，不管窗口在不在前台；
 * 之后每天第一次读到还在进行的活动算一次每日提醒：窗口没在前台（比如开机收在托盘）才发通知，
 * 在前台时首页卡片自己就是提醒，只记下「今天提醒过」。点过「知道了」或今天点过「今天不再提醒」的都跳过。
 * 读过这条公告的不算新活动，不再发「活动开始」。
 */
export function nextPromoReminder(input: {
  promos: PromoAnnouncement[]
  acknowledged: string[]
  snoozed: Record<string, string>
  reminded: Record<string, string>
  readIds: string[]
  today: string
  foreground: boolean
}): PromoReminder | null {
  for (const promo of input.promos) {
    if (input.acknowledged.includes(promo.id) || input.snoozed[promo.id] === input.today || input.reminded[promo.id] === input.today) continue
    if (input.reminded[promo.id] === undefined && !input.readIds.includes(promo.id)) return { kind: 'arrival', promo, notify: true }
    return { kind: 'daily', promo, notify: !input.foreground }
  }
  return null
}
