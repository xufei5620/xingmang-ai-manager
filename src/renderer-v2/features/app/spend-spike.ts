import { readLocalPreference, writeLocalPreference } from './preferences'
import { backgroundRefreshInterval } from './balance-store'

/**
 * 「花费突然变多」提醒（第十五批 7）。不另起定时器，也不另拉余额：余额本来就在
 * 按时刷新（balance-store.ts），这里只把每次读成功的钱包余额记下来，算过去一小时
 * 少了多少。掉得够多了才去读一次用量核账，确认是真花掉的、而且远超平时才提醒。
 *
 * 阈值先写死，设置里只有开关（notifications.spend），不给调数字。
 */
export const spendSpikeWindow = 60 * 60_000
export const spendSpikeMinimumDollars = 5
export const spendSpikeRatio = 5
export const spendSpikeQuietPeriod = 6 * 60 * 60_000
// 后台每 10 分钟读一次；两次读成功隔得比这还久，说明中间读失败过、电脑睡过或者
// 软件关过，那一段少掉的钱算不清是什么时候花的，不算。
export const spendSampleMaxGap = backgroundRefreshInterval + 5 * 60_000
// 余额掉够了但核账说不算（买了订阅、平时就用得多）或者用量没读到时，隔一会儿再核，
// 免得前台每分钟一刷就跟着读一次用量。
const baselineReuse = 15 * 60_000
const hoursInWeek = 7 * 24
const storageKey = 'xingmang-v2-spend-spike-notified'

export interface BalanceSample {
  at: number
  quota: number
}

export interface SpendBaseline {
  /** 用量记录里最近一小时花掉的额度；按日期查用量的账号读不出来，为 null。 */
  hourQuota: number | null
  weekQuota: number
}

export interface SpendSpikeNotice {
  cents: number
  /** 是平时每小时的几倍；平时几乎没用过、算不出倍数时为 null。 */
  multiple: number | null
}

/** 记一笔新读到的余额，只留最近一小时的。时间倒退（改了系统时间）就从头记。 */
export function recordBalanceSample(samples: readonly BalanceSample[], sample: BalanceSample): BalanceSample[] {
  const last = samples[samples.length - 1]
  if (last && sample.at <= last.at) return last.at === sample.at ? [...samples] : [sample]
  return [...samples, sample].filter((entry) => entry.at >= sample.at - spendSpikeWindow)
}

/** 一小时里钱包净减少了多少额度：充值带来的增加不抵扣，隔得太久的那一段不算。 */
export function walletSpent(samples: readonly BalanceSample[]): number {
  let spent = 0
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1]!
    const current = samples[index]!
    if (current.at - previous.at > spendSampleMaxGap) continue
    spent += Math.max(0, previous.quota - current.quota)
  }
  return spent
}

/**
 * 核账之后的判断。花掉的钱以用量记录为准（买订阅也会让余额变少，但那不是「用掉」），
 * 读不到一小时用量时才退回余额的差。平时每小时用多少按最近七天去掉这一小时来算，
 * 免得这一小时本身把「平时」拉高。
 */
export function evaluateSpendSpike(input: { walletSpent: number; baseline: SpendBaseline; quotaPerUnit: number }): SpendSpikeNotice | null {
  const { baseline, quotaPerUnit } = input
  if (!(quotaPerUnit > 0)) return null
  const spent = baseline.hourQuota ?? input.walletSpent
  if (spent / quotaPerUnit < spendSpikeMinimumDollars) return null
  const usual = Math.max(0, baseline.weekQuota - spent) / (hoursInWeek - 1)
  if (usual > 0 && spent < usual * spendSpikeRatio) return null
  return {
    cents: Math.round((spent / quotaPerUnit) * 100),
    multiple: usual > 0 ? Math.floor(spent / usual) : null,
  }
}

export function readSpendSpikeNotifiedAt(account: string): number | null {
  const stored = readLocalPreference(storageKey)
  if (!stored) return null
  try {
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const value = (parsed as Record<string, unknown>)[account]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

export function rememberSpendSpikeNotifiedAt(account: string, at: number): boolean {
  let current: Record<string, number> = {}
  try {
    const parsed: unknown = JSON.parse(readLocalPreference(storageKey) ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        // 早就过了安静期的记录没用了，顺手丢掉，免得换过很多账号后越记越长。
        if (typeof value === 'number' && at - value < spendSpikeQuietPeriod) current[key] = value
      }
    }
  } catch {
    current = {}
  }
  return writeLocalPreference(storageKey, JSON.stringify({ ...current, [account]: at }))
}

export interface SpendSpikeObservation {
  /** 余额 store 的 scope：换账号、换站点时样本全部作废。 */
  scope: string
  /** 同一个账号 6 小时内最多提醒一次，按它记。 */
  account: string
  quota: number
  quotaPerUnit: number
  at: number
}

export interface SpendSpikeWatch {
  observe(observation: SpendSpikeObservation): Promise<void>
}

export function createSpendSpikeWatch(options: {
  readBaseline: () => Promise<SpendBaseline>
  notify: (eventKey: string, notice: SpendSpikeNotice) => void
  readNotifiedAt?: (account: string) => number | null
  rememberNotifiedAt?: (account: string, at: number) => void
}): SpendSpikeWatch {
  const readNotifiedAt = options.readNotifiedAt ?? readSpendSpikeNotifiedAt
  const rememberNotifiedAt = options.rememberNotifiedAt ?? rememberSpendSpikeNotifiedAt
  let scope: string | null = null
  let samples: BalanceSample[] = []
  let checkedAt: number | null = null
  let checking = false

  function quiet(account: string, at: number) {
    const last = readNotifiedAt(account)
    return last !== null && at - last >= 0 && at - last < spendSpikeQuietPeriod
  }

  return {
    async observe(observation) {
      if (observation.scope !== scope) {
        scope = observation.scope
        samples = []
        checkedAt = null
      }
      samples = recordBalanceSample(samples, { at: observation.at, quota: observation.quota })
      const spent = walletSpent(samples)
      if (!(observation.quotaPerUnit > 0) || spent / observation.quotaPerUnit < spendSpikeMinimumDollars) return
      if (checking || quiet(observation.account, observation.at)) return
      if (checkedAt !== null && observation.at - checkedAt >= 0 && observation.at - checkedAt < baselineReuse) return
      checking = true
      const requestScope = scope
      try {
        const baseline = await options.readBaseline().catch(() => null)
        if (requestScope !== scope) return
        checkedAt = observation.at
        if (!baseline) return
        const notice = evaluateSpendSpike({ walletSpent: spent, baseline, quotaPerUnit: observation.quotaPerUnit })
        if (!notice) return
        rememberNotifiedAt(observation.account, observation.at)
        options.notify(`spend:${observation.account.replace(/[^A-Za-z0-9._-]/g, '-')}:${observation.at}`, notice)
      } finally {
        checking = false
      }
    },
  }
}
