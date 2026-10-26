import path from 'node:path'
import { resolveEmptyBalanceState, type EmptyBalanceRecord } from './empty-balance-alert'
import type { NewApiAccountUsageQuery } from './new-api-client'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'
import { createSpendSpikeWatch, pruneSpendSpikeRecord, type SpendBaseline, type SpendSpikeNotice } from './spend-spike'
import { usageDateRange } from './usage-date-range'

/**
 * 跟着余额走的三条系统通知：余额跌破 5 美元、余额到了 $0（empty-balance-alert.ts）、一小时里花得远超平时
 * （spend-spike.ts）。
 *
 * 原先由界面每次读到余额时判断。缩到托盘久了界面会被关掉省内存（renderer-release.ts），那段时间
 * 恰恰最需要这几条提醒，所以整个挪进主进程：界面开着时它读余额走 account:get-balance，主进程在
 * 那里看到；界面关着时主进程自己按时读，也交到这里。只此一处判断，不会两边各提醒一次。
 */

export const lowBalanceDollars = 5

export interface BalanceAlertObservation {
  /** 哪个站点的哪个账号：换了就从头记，上一个账号的余额不拿来比。 */
  scope: string
  userId: number
  quota: number
  quotaPerUnit: number
  at: number
  /** 账号能按时段查用量：花费突增要读用量核账，查不了就不看。 */
  supportsUsage: boolean
  /**
   * 当前账号有能扣的订阅：先扣订阅，钱包少于 5 美元不算余额不足。null = 这个账号的订阅还没读到：
   * 跌破 5 美元那条照旧当没有订阅，余额用完那条等读到了再说（只靠订阅的客户钱包本来就是 0）。
   */
  subscribed: boolean | null
}

export interface BalanceAlertsOptions {
  /** 文案固定在通知层（platform/notifications.ts），这里只给事件编号和花费的两个整数。 */
  notify(kind: 'balance' | 'spend', eventKey: string, notice?: SpendSpikeNotice): void
  readBaseline(): Promise<SpendBaseline>
  readNotifiedAt(account: string): number | null | Promise<number | null>
  rememberNotifiedAt(account: string, at: number): void | Promise<void>
  /** 余额用完那条「同一次只说一次」的记录（empty-balance-alert.ts）；缺省时不发这一条。 */
  emptyRecord?: EmptyBalanceRecord
}

export interface BalanceAlerts {
  observe(observation: BalanceAlertObservation): Promise<void>
}

export interface SpendBaselineSource {
  /** 历史账号（api 站）的用量只能按日期查，读不出一小时。 */
  dateOnly: boolean
  /** 和界面「用量账单」读的是同一条。 */
  getUsage(query: NewApiAccountUsageQuery): Promise<{ stats: { quota: number } }>
}

/**
 * 「花费突然变多」核账：最近一小时和最近七天各花了多少。只在余额一小时里掉了 5 美元以上时才读一次，
 * 不是又一处定时拉取。按日期查用量的账号读不出一小时，hourQuota 为 null，那边改用余额的差。
 */
export async function readSpendBaseline(source: SpendBaselineSource, now = new Date()): Promise<SpendBaseline> {
  if (source.dateOnly) {
    const week = await source.getUsage({ ...usageDateRange({}, now), page: 1, pageSize: 1 })
    return { hourQuota: null, weekQuota: week.stats.quota }
  }
  const endTimestamp = Math.floor(now.getTime() / 1000)
  // 只用合计：星芒账号只查合计那一个接口，不再陪着查一页明细。
  const [hour, week] = await Promise.all([
    source.getUsage({ type: 2, statsOnly: true, startTimestamp: endTimestamp - 3600, endTimestamp }),
    source.getUsage({ type: 2, statsOnly: true, startTimestamp: endTimestamp - 7 * 86400, endTimestamp }),
  ])
  return { hourQuota: hour.stats.quota, weekQuota: week.stats.quota }
}

/** 同一个账号上一次读到的余额在 5 美元以上、这一次跌到 5 美元以下，才算跌破。 */
export function crossedLowBalance(previous: number | null, current: number): boolean {
  return previous !== null && previous >= lowBalanceDollars && current < lowBalanceDollars
}

export function createBalanceAlerts(options: BalanceAlertsOptions): BalanceAlerts {
  let previous: { scope: string; dollars: number } | null = null
  const spend = createSpendSpikeWatch({
    readBaseline: options.readBaseline,
    notify: (eventKey, notice) => options.notify('spend', eventKey, notice),
    readNotifiedAt: options.readNotifiedAt,
    rememberNotifiedAt: options.rememberNotifiedAt,
  })
  // 钱包到了 0、又确定没有能扣的订阅：这一次用完还没说过就说一次。说了返回 true。
  async function observeEmptyBalance(observation: BalanceAlertObservation, dollars: number): Promise<boolean> {
    const record = options.emptyRecord
    if (!record) return false
    const state = resolveEmptyBalanceState(dollars, observation.subscribed)
    if (state === 'funded') {
      await record.release(observation.scope)
      return false
    }
    if (state === 'unknown' || !await record.claim(observation.scope, observation.at)) return false
    options.notify('balance', `balance-empty:${observation.userId}:${observation.at}`)
    return true
  }
  return {
    async observe(observation) {
      if (!(observation.quotaPerUnit > 0)) return
      const dollars = observation.quota / observation.quotaPerUnit
      const before = previous?.scope === observation.scope ? previous.dollars : null
      previous = { scope: observation.scope, dollars }
      // 一下从 5 美元以上掉到 0：只说「是 $0 了」，不再另说一条「不足 $5」。
      const emptied = await observeEmptyBalance(observation, dollars)
      if (!emptied && !observation.subscribed && crossedLowBalance(before, dollars)) {
        options.notify('balance', `balance:${observation.userId}:${observation.at}`)
      }
      if (!observation.supportsUsage) return
      await spend.observe({
        scope: observation.scope,
        account: String(observation.userId),
        quota: observation.quota,
        quotaPerUnit: observation.quotaPerUnit,
        at: observation.at,
      })
    },
  }
}

const recordLabel = '花费突增提醒记录'
const recordMaximumBytes = 16 * 1024

/**
 * 每个账号上次「花费突然变多」提醒的时间，6 小时安静期按它算，软件重开也不再说一遍。
 * 第一次要用时才读盘，之后都用内存里那份；写盘排队、原子替换，写不进去只少记一次。
 */
export function createSpendSpikeRecordStore(directory: string, now: () => number = Date.now): Pick<BalanceAlertsOptions, 'readNotifiedAt' | 'rememberNotifiedAt'> {
  const filePath = path.join(directory, 'spend-spike-notified.json')
  let loaded: Promise<Record<string, number>> | null = null
  let writes: Promise<void> = Promise.resolve()
  const load = () => {
    loaded ??= readSafeUtf8File(filePath, recordLabel, recordMaximumBytes).then((content) => {
      if (content === null) return {}
      try { return pruneSpendSpikeRecord(JSON.parse(content), now()) } catch { return {} }
    }).catch(() => ({}))
    return loaded
  }
  return {
    async readNotifiedAt(account) {
      return (await load())[account] ?? null
    },
    async rememberNotifiedAt(account, at) {
      const record = pruneSpendSpikeRecord({ ...await load(), [account]: at }, at)
      loaded = Promise.resolve(record)
      const content = `${JSON.stringify(record)}\n`
      writes = writes.then(async () => {
        ensureSafeDataDirectory(directory, recordLabel)
        await writeAtomicSafeUtf8File(filePath, content, recordLabel)
      }).catch(() => undefined)
      await writes
    },
  }
}
