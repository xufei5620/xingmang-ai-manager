import { readLocalPreference, writeLocalPreference } from '../app/preferences'
import { timelineFreshWindowMs, type TimelineMeta } from './newapi-announcements'
import { buildTopupBonus } from '../account/topup-bonus'

// 账号服务的公告只有「正文、附加说明、发布时间、类型」四样，没有「活动类型」「结束时间」
// 「按钮链接」。先用约定顶上：标题里带「充值」就是充值活动；正文或附加说明里写
//「截止：10月7日」或「10月1日-10月7日」就当结束时间；没写的按发布后 7 天算。
// 没有发布时间的旧式系统公告永远不会变成活动卡片，后台里没清掉的旧公告不会跟着变显眼。
// 标题带「邀请」的（邀请有礼）也算活动：不单独挂大卡片，但和充值活动一起进顶部活动条，
// 截止时间同样从文字里找，没写按发布后 7 天。

export interface PromoSource { id: string; title: string; text: string; timeline?: TimelineMeta }
export type PromoKind = 'recharge' | 'invite'
export interface PromoAnnouncement { id: string; kind?: PromoKind; title: string; text: string; publishedAt: number; endsAt: number; endsExplicitly: boolean }

const dayMs = 24 * 60 * 60 * 1000
// 年份省略时，约定写的日期不会比发布时间早太多；早于发布时间一个月以上就当成明年。
const yearRolloverSlackMs = 31 * dayMs
// 写错的年份（比如 2062）会让卡片挂很多年。活动最长按 120 天算，超出就当没写。
const maximumPromoSpanMs = 120 * dayMs
const maximumScannedLength = 4_000

export function isRechargePromoTitle(title: string): boolean {
  return title.replace(/\s+/g, '').includes('充值')
}

/** 标题里带「充值」的是充值活动，否则带「邀请」的是邀请活动，都不带的不是活动。 */
export function resolvePromoKind(title: string): PromoKind | null {
  if (isRechargePromoTitle(title)) return 'recharge'
  return title.replace(/\s+/g, '').includes('邀请') ? 'invite' : null
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

/** 还没结束的活动（充值、邀请），最新发布的在前。 */
export function activePromos(entries: PromoSource[] | undefined, now: number): PromoAnnouncement[] {
  if (!entries) return []
  const promos: PromoAnnouncement[] = []
  for (const entry of entries) {
    const kind = entry.timeline ? resolvePromoKind(entry.title) : null
    if (!entry.timeline || !kind) continue
    const publishedAt = Date.parse(entry.timeline.publishedAt)
    if (!Number.isFinite(publishedAt)) continue
    const explicit = resolvePromoEndsAt(`${entry.title}\n${entry.text}\n${entry.timeline.extra}`, publishedAt)
    const endsAt = explicit ?? publishedAt + timelineFreshWindowMs
    if (now >= endsAt) continue
    promos.push({ id: entry.id, kind, title: entry.title, text: entry.text, publishedAt, endsAt, endsExplicitly: explicit !== null })
  }
  return promos.sort((left, right) => right.publishedAt - left.publishedAt)
}

/** 还没结束的充值活动，最新发布的在前。大卡片、每日提醒只跟它走。 */
export function activeRechargePromos(entries: PromoSource[] | undefined, now: number): PromoAnnouncement[] {
  return activePromos(entries, now).filter((promo) => promo.kind === 'recharge')
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

/** 活动条上的短截止：「10月8日截止，还剩 8 天」；没写截止时间的不显示，免得把估的当成承诺。 */
export function formatPromoShortDeadline(promo: Pick<PromoAnnouncement, 'endsAt' | 'endsExplicitly'>, now: number, withRemaining: boolean): string | null {
  if (!promo.endsExplicitly) return null
  const end = new Date(promo.endsAt)
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  const days = Math.floor((new Date(promo.endsAt).setHours(0, 0, 0, 0) - startOfToday) / dayMs)
  const clock = `${pad(end.getHours())}:${pad(end.getMinutes())}`
  if (days <= 0) return `今天 ${clock} 截止`
  if (days === 1) return `明天 ${clock} 截止`
  const date = `${end.getMonth() + 1}月${end.getDate()}日截止`
  return withRemaining ? `${date}，还剩 ${days} 天` : date
}

// 网址、域名（带不带 http 都算）。公告正文里常写站点地址，界面上不显示站点名。
// 带 http 的整段都去掉；不带的只认常见后缀，免得把「Node.js」这类字当成网址。
const siteAddressPattern = /https?:\/\/[^\s，。；、）)]+|(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|cn|cc|net|org|io|ai|top|xyz|me|co|app|dev|vip|site|online|shop|tech|info|link|cloud|pro|fun|club|icu)(?![a-z0-9-])(?::\d{1,5})?(?:\/[^\s，。；、）)]*)?/gi

/** 去掉文字里的网址和域名，再收拾掉它两边留下的连接符。 */
export function stripSiteAddresses(text: string): string {
  return text.replace(siteAddressPattern, ' ')
    .replace(/(^|\s)[·•|｜,，:：\-—]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[·•|｜,，:：\-—\s]+|[·•|｜\-—\s]+$/g, '')
}

/** 活动条上的短名字：标题里「｜」后面那段（「国庆礼遇 · 中秋同庆｜充值满赠」→「充值满赠」），没有就用整个标题。 */
export function promoShortName(title: string): string {
  const clean = stripSiteAddresses(title)
  const parts = clean.split(/[｜|]/).map((part) => part.trim()).filter(Boolean)
  return parts[parts.length - 1] ?? clean
}

function plainPromoLine(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
    .replace(/(```|~~~|`|\*\*|__|~~)/g, '')
}

const maximumPreviewLines = 3
const maximumPreviewLineLength = 80

/**
 * 没读到充值优惠时卡片的小字：正文前三行，保留原来的换行，去掉格式和网址。
 * 超出的行或太长的行用「…」收尾，全文靠「活动详情」看。
 */
export function promoPreviewLines(text: string): string[] {
  const source = text.slice(0, maximumScannedLength)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
  const lines = source.split(/\r?\n/).map((line) => stripSiteAddresses(plainPromoLine(line))).filter(Boolean)
  const shown = lines.slice(0, maximumPreviewLines).map((line) => {
    const characters = [...line]
    return characters.length > maximumPreviewLineLength ? `${characters.slice(0, maximumPreviewLineLength).join('')}…` : line
  })
  if (lines.length > maximumPreviewLines && shown.length && !shown[shown.length - 1].endsWith('…')) shown[shown.length - 1] += '…'
  return shown
}

export interface PromoTier { amount: number; pay: number; percent: number }
const maximumPromoTiers = 8

/** 按账号的充值优惠设置列出有赠送的档位（和充值页同一份数字），从小到大。没有赠送的档位不列。 */
export function buildPromoTiers(amountOptions: number[] | undefined, discounts: Record<string, number> | undefined): PromoTier[] {
  if (!amountOptions?.length || !discounts) return []
  const tiers: PromoTier[] = []
  for (const amount of [...new Set(amountOptions)].sort((left, right) => left - right)) {
    const bonus = buildTopupBonus(amount, discounts)
    if (!bonus) continue
    tiers.push({ amount, pay: Math.round((amount - bonus.bonus) * 100) / 100, percent: bonus.percent })
  }
  return tiers.slice(0, maximumPromoTiers)
}

function barHiddenKey(scope: string): string { return `xingmang-v2-promo-bar-hidden:${scope}` }

/** 活动条点过 × 的那天；只管当天，第二天自动回来。 */
export function readPromoBarHiddenDay(scope: string): string | null {
  const stored = readLocalPreference(barHiddenKey(scope))
  return stored && /^\d{8}$/.test(stored) ? stored : null
}
export function rememberPromoBarHiddenDay(scope: string, day: string): string {
  writeLocalPreference(barHiddenKey(scope), day)
  return day
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

/** 点过「这个活动不再提醒」（原来叫「知道了」）的活动：卡片收起、不再每天提醒，活动条和铃铛红点留到活动结束。 */
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
