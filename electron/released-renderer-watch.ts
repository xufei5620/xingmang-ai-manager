import type { RelayNotice } from './relay-backend'
import { backgroundBalanceInterval } from './spend-spike'

/**
 * 界面关着（renderer-release.ts）时，主进程替它按原来的节奏看着几件事：
 *
 * - 余额：照旧每 10 分钟读一次。读到的交给 main.ts 的 onAccountBalance，托盘上的余额跟着变，
 *   余额不足、花费突增两条提醒也在那里判断（balance-alerts.ts），和界面开着时是同一条路。
 * - 公告：读完余额顺带看一眼（cached，不另外发请求，同界面那边）。和界面最后一次读到的那份不一样了，
 *   就让界面在后台醒一下：提醒不提醒、提醒哪几条要靠界面那套已读、已提醒记录来判断，搬不出来。
 * - 充值活动的每日提醒：界面每天第一次读到还没结束的充值活动时会再提一次。日子换了、公告里还有
 *   说充值的，也让界面醒一下，由它决定提不提。
 *
 * 醒一下就是在后台重新加载界面，窗口不出来；界面跑完这一轮，过一阵照样再关掉。
 */

export type ReleasedRendererWakeReason = 'notice' | 'daily-promo'

export interface ReleasedRendererWatchOptions {
  intervalMs?: number
  signedIn(): boolean
  /** 读一次余额；结果由宿主交给托盘和余额提醒。失败了这一轮就算了。 */
  readBalance(): Promise<unknown>
  readNotice(): Promise<RelayNotice | null>
  /** 界面最后一次读到的公告（noticeFingerprint），界面没读过为 null：那就没有可比的，不叫它。 */
  lastSeenNotice(): string | null
  wake(reason: ReleasedRendererWakeReason): void
  onError?(error: unknown): void
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export interface ReleasedRendererWatch {
  start(): void
  stop(): void
}

/** 公告的「这一份」：系统公告和每一条的编号。已读状态不算，客户在网页上点了已读不用叫醒界面。 */
export function noticeFingerprint(notice: RelayNotice | null): string {
  if (!notice) return ''
  const entries = (notice.entries ?? []).map((entry) => entry.id)
  const bulletins = (notice.bulletins ?? []).map((bulletin) => bulletin.id)
  return [notice.id, ...entries, ...bulletins].join('\n')
}

/** 公告里有没有说充值的（界面认充值活动看标题里的「充值」，这里粗一点，多醒一次也不要紧）。 */
export function noticeMentionsRecharge(notice: RelayNotice | null): boolean {
  if (!notice) return false
  return (notice.entries ?? []).some((entry) => entry.title.includes('充值'))
    || (notice.bulletins ?? []).some((bulletin) => bulletin.content.includes('充值'))
}

/** 本机日历上的哪一天：每日提醒按它换日子，同界面 promo-announcements.ts 的 localDayKey。 */
export function localDay(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

export function createReleasedRendererWatch(options: ReleasedRendererWatchOptions): ReleasedRendererWatch {
  const intervalMs = options.intervalMs ?? backgroundBalanceInterval
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return timer
  })
  const clearTimer = options.clearTimer ?? ((timer: unknown) => { clearTimeout(timer as ReturnType<typeof setTimeout>) })
  let timer: unknown = null
  let generation = 0
  let day = ''
  // 为哪一份公告叫醒过界面：界面醒了却没去读公告（例如这个账号看不了公告），同一份不再叫第二次。
  let wokenFor: string | null = null

  const report = (error: unknown) => {
    try { options.onError?.(error) } catch { /* Error reporting cannot throw out of a timer. */ }
  }
  const schedule = (current: number) => {
    timer = setTimer(() => { void tick(current) }, intervalMs)
  }
  const tick = async (current: number) => {
    timer = null
    if (current !== generation) return
    try {
      if (options.signedIn()) {
        await options.readBalance().catch(() => undefined)
        if (current !== generation) return
        const notice = await options.readNotice().catch(() => undefined)
        if (current !== generation) return
        if (notice !== undefined) {
          const seen = options.lastSeenNotice()
          const fingerprint = noticeFingerprint(notice)
          const today = localDay(now())
          // 叫醒以后宿主会 stop()，下面排的下一轮也就作废了；没停（叫不醒）就照常再看。
          if (seen !== null && fingerprint !== seen && fingerprint !== wokenFor) {
            wokenFor = fingerprint
            options.wake('notice')
          } else if (today !== day && noticeMentionsRecharge(notice)) {
            day = today
            options.wake('daily-promo')
          }
        }
      }
    } catch (error) {
      report(error)
    }
    if (current === generation) schedule(current)
  }

  return {
    start() {
      generation++
      if (timer !== null) clearTimer(timer)
      // 界面关掉之前刚读过一遍，今天的那次提醒它已经看过了。
      day = localDay(now())
      schedule(generation)
    },
    stop() {
      generation++
      if (timer !== null) clearTimer(timer)
      timer = null
    },
  }
}
