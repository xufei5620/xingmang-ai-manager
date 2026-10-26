/**
 * 「花费突然变多」提醒（第十五批 7）。不另起定时器，也不另拉余额：余额本来就在
 * 按时刷新，这里只把每次读成功的钱包余额记下来，算过去一小时少了多少。掉得够多了
 * 才去读一次用量核账，确认是真花掉的、而且远超平时才提醒。
 *
 * 原先在界面里（renderer-v2 的 features/app），缩到托盘久了界面会被关掉省内存
 * （renderer-release.ts），提醒却恰恰要在那时候发，所以挪到主进程：界面开着时它读
 * 余额走 account:get-balance，主进程照样看得到；界面关着时由主进程自己按时读。
 *
 * 阈值先写死，设置里只有开关（notifications.spend），不给调数字。
 */
export const spendSpikeWindow = 60 * 60_000
export const spendSpikeMinimumDollars = 5
export const spendSpikeRatio = 5
export const spendSpikeQuietPeriod = 6 * 60 * 60_000
// 窗口在后台时界面每 10 分钟读一次余额（balance-store.ts），界面关着时主进程也是这个节奏。
export const backgroundBalanceInterval = 10 * 60_000
// 两次读成功隔得比这还久，说明中间读失败过、电脑睡过或者软件关过，那一段少掉的钱
// 算不清是什么时候花的，不算。
export const spendSampleMaxGap = backgroundBalanceInterval + 5 * 60_000
// 余额掉够了但核账说不算（买了订阅、平时就用得多）或者用量没读到时，隔一会儿再核，
// 免得前台每分钟一刷就跟着读一次用量。
const baselineReuse = 15 * 60_000
const hoursInWeek = 7 * 24

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

/**
 * 只留还在安静期里的那几条：早就过了的没用了，顺手丢掉，免得换过很多账号后越记越长。
 * 读回来的东西一律当外来数据过一遍。
 */
export function pruneSpendSpikeRecord(record: unknown, at: number): Record<string, number> {
  const kept: Record<string, number> = {}
  if (!record || typeof record !== 'object' || Array.isArray(record)) return kept
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' && Number.isFinite(value) && at - value < spendSpikeQuietPeriod) kept[key] = value
  }
  return kept
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
  /** 这个账号上次提醒是什么时候（6 小时安静期按它算），没提醒过为 null。 */
  readNotifiedAt: (account: string) => number | null | Promise<number | null>
  rememberNotifiedAt: (account: string, at: number) => void | Promise<void>
}): SpendSpikeWatch {
  const { readNotifiedAt, rememberNotifiedAt } = options
  let scope: string | null = null
  let samples: BalanceSample[] = []
  let checkedAt: number | null = null
  let checking = false

  // 记录读得出来就当场判断，不多等一拍：同步的记录（测试、已经读进内存的）照旧当场去核账。
  function quiet(account: string, at: number): boolean | Promise<boolean> {
    const judge = (last: number | null) => last !== null && at - last >= 0 && at - last < spendSpikeQuietPeriod
    let last: number | null | Promise<number | null>
    try { last = readNotifiedAt(account) } catch { return false }
    return last instanceof Promise ? last.then(judge, () => false) : judge(last)
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
      if (checking) return
      if (checkedAt !== null && observation.at - checkedAt >= 0 && observation.at - checkedAt < baselineReuse) return
      checking = true
      const requestScope = scope
      try {
        const silenced = quiet(observation.account, observation.at)
        if (typeof silenced === 'boolean' ? silenced : await silenced) return
        const baseline = await options.readBaseline().catch(() => null)
        if (requestScope !== scope) return
        checkedAt = observation.at
        if (!baseline) return
        const notice = evaluateSpendSpike({ walletSpent: spent, baseline, quotaPerUnit: observation.quotaPerUnit })
        if (!notice) return
        // 记不下来也照样提醒：最多 6 小时里多说一次，不能因此一次都不说。
        await Promise.resolve().then(() => rememberNotifiedAt(observation.account, observation.at)).catch(() => undefined)
        options.notify(`spend:${observation.account.replace(/[^A-Za-z0-9._-]/g, '-')}:${observation.at}`, notice)
      } finally {
        checking = false
      }
    },
  }
}
