import type { RealmAccountSiteId } from './realm-account-service'

/** 正在恢复的是哪个账号：本机账号库一读出来就知道，不用等联网。 */
export interface RestoringAccount {
  siteId: RealmAccountSiteId
  userId: number
}

export interface AccountStartupGate {
  /**
   * 启动画面那两条读取（会话、配置）该等到什么时候：账号恢复结束，或启动预算
   * 用完，二者先到的那个。永不 reject。
   */
  readonly released: Promise<void>
  /** 账号恢复本身还没结束。 */
  pending(): boolean
  /** 预算先于恢复用完：有读取拿到的是「恢复中」的答复，恢复结束后要补发一次会话。 */
  releasedEarly(): boolean
  restoringAccount(): RestoringAccount | null
}

export interface AccountStartupGateOptions {
  /** main.ts 的 accountSessionReady：恢复结束（成败都算）时 resolve，永不 reject。 */
  settled: Promise<void>
  budgetMs: number
  /**
   * 明确断网就不等：恢复必然联不上，等满预算只是让用户多盯三秒启动画面。
   * 只认「确定断网」，联网状态说不清时照常等预算。
   */
  offline: boolean
  restoringAccount(): RestoringAccount | null
  setTimer?(callback: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

/**
 * 启动画面以前要等账号恢复（刷新登录 + 拉一次个人信息）彻底结束才撤。网络慢的
 * 那一档用户开机先盯着启动画面十几到三十秒，而首页要的本机信息早就齐了。
 *
 * 这里只给启动画面那两条读取一个上限，其余要账号的操作照旧排在恢复之后：到点
 * 还没恢复完，会话先答「正在恢复哪个账号」，配置先按「来源待定」给出，恢复结束
 * 由界面补读一次。
 */
export function createAccountStartupGate(options: AccountStartupGateOptions): AccountStartupGate {
  let settled = false
  let early = false
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const released = new Promise<void>((resolve) => {
    let timer: unknown = null
    function releaseEarly() {
      if (settled) return
      early = true
      resolve()
    }
    void options.settled.catch(() => undefined).then(() => {
      settled = true
      if (timer !== null) clearTimer(timer)
      resolve()
    })
    if (options.offline) releaseEarly()
    else timer = setTimer(releaseEarly, Math.max(0, options.budgetMs))
  })
  return {
    released,
    pending: () => !settled,
    releasedEarly: () => early,
    restoringAccount: () => settled ? null : options.restoringAccount(),
  }
}
