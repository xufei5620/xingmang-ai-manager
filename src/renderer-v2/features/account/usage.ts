import type { AccountDashboardData, AccountUsageRecord } from '../../../../electron/ipc-contract'
import type { AccountFilterField } from '../../AccountFilters'
import { localSpendDays, spendDayTitle } from './account-center'

/**
 * 用量账单这一页（v4 第 07 批）上由数据算出来的东西：时间范围、花费趋势每根柱子管哪一段、
 * 按模型的占比、调用明细的状态和快捷筛选。都是纯函数，页面只管摆；字以字表批07为准。
 */

export type UsageRange = '1' | '7' | '30'
export const usageRanges: ReadonlyArray<{ value: UsageRange; label: string }> = [
  { value: '1', label: '24 小时' },
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
]
export function isUsageRange(value: string): value is UsageRange {
  return value === '1' || value === '7' || value === '30'
}

/** 花费趋势里的一根柱子管的那一段（毫秒），横轴上的字，和悬停时那句的前半截。 */
export interface UsageSegment {
  start: number
  end: number
  label: string
  title: string
}

const hourMs = 3_600_000
const blockHours = 4

function monthDay(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

/**
 * 这个范围从什么时候算起（秒）。「7 天」「30 天」从本地零点算，跟首页、账号概览的「近 7 天」
 * 一样是今天加前面几天，每根柱子正好一天或一周；「24 小时」从 24 小时前所在的那个整点算。
 */
export function usageRangeStart(range: UsageRange, now: Date): number {
  if (range === '1') {
    // 后台看板数据只记到整点（created_at 先抹掉不满一小时的零头），查的是 created_at 不早于起点的行：
    // 起点落在 10:34，昨天 10 点那一行整个不回，10:34 到 11 点的花费看板上没有，下面调用明细却有
    // （#1093 第 4 条）。退到那个整点，看板和调用明细查的是同一段。
    const dayAgo = Math.floor(now.getTime() / 1000) - 86_400
    return dayAgo - dayAgo % 3_600
  }
  const days = localSpendDays(now, Number(range))
  return Math.floor(days[0].start / 1000)
}

/**
 * 「7 天」「30 天」每根柱子单独问一次后台（按本地日、本地周切），不用后台按 UTC 日分好的桶：
 * 北京时间早上 8 点前的花费会被算到前一天，跟账号概览的「近 7 天」对不上（同 account-center 的算法）。
 * 「30 天」按 7 天一根从今天往回切，最早那根不满一周。「24 小时」不在这里：一次问回来按小时分好的桶，
 * 再四小时并一根（usageHourBlocks）。
 */
export function usageSegments(range: Exclude<UsageRange, '1'>, now: Date): UsageSegment[] {
  const days = localSpendDays(now, Number(range))
  // 「7 天」悬停那句跟账号概览「近 7 天」一样（spendDayTitle），只取冒号前那半截。
  if (range === '7') return days.map((day) => ({ ...day, title: spendDayTitle(day, '').replace(/：$/, '') }))
  const weeks: UsageSegment[] = []
  for (let last = days.length - 1; last >= 0; last -= 7) {
    const first = Math.max(0, last - 6)
    const start = new Date(days[first].start)
    const end = new Date(days[last].start)
    weeks.unshift({
      start: days[first].start,
      end: days[last].end,
      label: `${start.getMonth() + 1}/${start.getDate()}`,
      title: first === last ? monthDay(start) : `${monthDay(start)}至${monthDay(end)}`,
    })
  }
  return weeks
}

/** 「24 小时」的柱子：从起点到现在按本地钟点每四小时一根，「0 点」「4 点」…；后台按小时的桶落进对应那根。 */
export function usageHourBlocks(startSeconds: number, now: Date, buckets: AccountDashboardData['buckets']): Array<UsageSegment & { quota: number }> {
  const offset = now.getTimezoneOffset() * 60_000
  const size = blockHours * hourMs
  const blocks: Array<UsageSegment & { quota: number }> = []
  for (let start = Math.floor((startSeconds * 1000 - offset) / size) * size + offset; start < now.getTime(); start += size) {
    const date = new Date(start)
    blocks.push({ start, end: start + size, label: `${date.getHours()} 点`, title: `${monthDay(date)} ${date.getHours()} 点`, quota: 0 })
  }
  for (const bucket of buckets) {
    const at = bucket.timestamp * 1000
    const block = blocks.find((item) => at >= item.start && at < item.end) ?? (at < (blocks[0]?.start ?? 0) ? blocks[0] : undefined)
    if (block) block.quota += bucket.quota
  }
  return blocks
}

/** 把几段各自问回来的数合成整段：总花费、次数、Token 相加，按模型的合并到同一个名字上。 */
export function mergeDashboards(parts: readonly AccountDashboardData[]): Pick<AccountDashboardData, 'quota' | 'count' | 'tokens' | 'models'> {
  const models = new Map<string, AccountDashboardData['models'][number]>()
  let quota = 0
  let count = 0
  let tokens = 0
  for (const part of parts) {
    quota += part.quota
    count += part.count
    tokens += part.tokens
    for (const model of part.models) {
      const total = models.get(model.model) ?? { model: model.model, count: 0, tokens: 0, quota: 0 }
      total.count += model.count
      total.tokens += model.tokens
      total.quota += model.quota
      models.set(model.model, total)
    }
  }
  return { quota, count, tokens, models: [...models.values()] }
}

/** 柱子高度（百分比，按刻度顶算）和左边那几条刻度：顶取一个整齐的数，最多四格。 */
export function usageChartScale(values: readonly number[]): { top: number; ticks: number[] } {
  const max = Math.max(0, ...values)
  if (max <= 0) return { top: 0, ticks: [] }
  const steps = [1, 2, 5]
  let step = 0.01
  for (let power = 0.01; ; power *= 10) {
    const found = steps.map((base) => base * power).find((candidate) => max / candidate <= 4)
    if (found) { step = found; break }
  }
  const top = Math.ceil(max / step - 1e-9) * step
  const ticks: number[] = []
  for (let tick = 0; tick <= top + step / 2; tick += step) ticks.push(Math.round(tick * 100) / 100)
  return { top, ticks }
}

/** 刻度上的字：「$0」「$0.5」「$2」，跟着格子大小留小数。 */
export function usageTickText(value: number, ticks: readonly number[]): string {
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : value
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  return `$${value.toFixed(digits)}`
}

/** 「按模型」那几行：按花费从多到少，最多五个，占比按整段总花费算。 */
export function modelShares(models: AccountDashboardData['models'], limit = 5): Array<AccountDashboardData['models'][number] & { percent: number }> {
  const total = models.reduce((sum, model) => sum + model.quota, 0)
  return [...models]
    .sort((a, b) => b.quota - a.quota || b.count - a.count)
    .slice(0, limit)
    .map((model) => ({ ...model, percent: total > 0 ? Math.round(model.quota / total * 100) : 0 }))
}

/** 悬停在一个模型上那句：请求次数原型没画，放在这里（字表批07的注）。 */
export function modelShareTitle(model: Pick<AccountDashboardData['models'][number], 'count' | 'tokens'>): string {
  return `${model.count.toLocaleString('en-US')} 次请求，${model.tokens.toLocaleString('en-US')} Token`
}

/** 快捷筛选里的「常用模型」：这段时间请求最多的两个。 */
export function frequentModels(models: AccountDashboardData['models'], limit = 2): string[] {
  return [...models].sort((a, b) => b.count - a.count || b.quota - a.quota).slice(0, limit).map((model) => model.model)
}

export type UsageQuickFilter = 'all' | 'fail' | `model:${string}`

/** 快捷筛选落到查询上的那几项：选了模型就按模型查，选「失败」就只查错误记录（日志类型 5）。 */
export function quickFilterQuery(filter: UsageQuickFilter): { modelName?: string; type?: number } {
  if (filter === 'fail') return { type: 5 }
  if (filter.startsWith('model:')) return { modelName: filter.slice('model:'.length) }
  return {}
}

/** 一条记录是什么类型（详情弹窗左上角那颗、明细表里不是成功也不是失败的那几种）。 */
export function usageTypeLabel(type: number): string {
  return ({ 1: '充值', 2: '消费', 3: '管理', 4: '系统', 5: '错误', 6: '退款', 7: '登录' } as Record<number, string>)[type] ?? '未知'
}

/**
 * 明细表「状态」那一栏：消费记录是「成功」；错误记录没扣钱写「失败，未扣费」，扣了写「失败」
 * （字表批07按注里的建议）；别的类型照写类型。
 */
export function usageStatus(record: Pick<AccountUsageRecord, 'type' | 'quota'>): { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } {
  if (record.type === 2) return { label: '成功', tone: 'ok' }
  if (record.type === 5) return record.quota > 0 ? { label: '失败', tone: 'bad' } : { label: '失败，未扣费', tone: 'warn' }
  return { label: usageTypeLabel(record.type), tone: 'neutral' }
}

/** 这次调用没成也没扣钱：详情弹窗里那条说明只在这种时候出。 */
export function usageFailedFree(record: Pick<AccountUsageRecord, 'type' | 'quota'>): boolean {
  return record.type === 5 && record.quota <= 0
}

/** 明细空着时那两句：选了「失败」、筛过、没筛三种（字表批07）。 */
export function usageEmptyText(filtered: boolean, failOnly: boolean): { title: string; description: string } {
  if (failOnly) return { title: '这段时间没有失败的调用', description: '换个筛选条件看看。' }
  return filtered ? { title: '这段时间没有调用', description: '换个筛选条件看看。' } : { title: '这段时间没有调用', description: '' }
}

// 历史账号的调用明细按整日查（Sub2API 的接口只认日历日），筛选项也跟星芒账号不一样。
// 「Key ID」「分组 ID」是技术词，按字表批07改成「密钥编号」「分组编号」。
export const sub2ApiUsageFilterFields: AccountFilterField[] = [
  { key: 'startDate', label: '开始日期', type: 'date' },
  { key: 'endDate', label: '结束日期', type: 'date' },
  { key: 'modelName', label: '模型名称' },
  { key: 'apiKeyId', label: '密钥编号', type: 'number' },
  { key: 'groupId', label: '分组编号', type: 'number' },
  { key: 'billingType', label: '计费来源', options: [
    { value: '', label: '全部来源' }, { value: '0', label: '账户余额' }, { value: '1', label: '订阅额度' },
  ] },
]

/** 历史账号「密钥编号」「分组编号」：空着不筛，填了必须是正整数。 */
export function sub2ApiFilterId(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('密钥编号和分组编号要填正整数。')
  return parsed
}
