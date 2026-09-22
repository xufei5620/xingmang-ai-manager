/**
 * 加速正连着、却不是用户自己点的断开：内核自己退出了，或者辅助进程被杀毒软件、
 * 清理工具结束了。这时候各处状态要跟上，并发一条系统通知说清楚网络的现状。
 *
 * 为什么要有它：内核退出后，辅助进程会先把系统代理改回去、把会话记成「意外
 * 断开」，但这件事以前**到此为止**——主进程这边没人去读，托盘一直显示「已连接」，
 * 首页和加速页要等用户自己打开窗口才看得到。辅助进程整个被杀更糟：系统代理还
 * 指着一个已经不存在的端口，浏览器、微信全部连不上，而用户第一反应是去重启路由器。
 *
 * 分工：
 * - **还原网络不在这里**。内核退出时由辅助进程自己先还原（acceleration-development-
 *   backend.ts 的 stopSession 先改回系统代理再停内核）；辅助进程没了由宿主当场重拉
 *   一个去还原（acceleration-development-host.ts 的 recoverAfterCrash）。这里只读
 *   状态与提醒，**不重连加速**。
 * - **读一次状态就够把托盘、首页、加速页都推到「已断开」**：读到的那一份经由服务的
 *   onState 回到托盘（与到期提醒同一个来源）；首页和加速页在窗口回到前台时会自己
 *   重读，点这条通知正好把窗口叫回来。
 * - **只说事实**（同 acceleration-expiry-notice.ts）。读到会话确实停了才说「网络已
 *   恢复正常」；读不到、或者停不下来，只说「网络可能暂时连不上」，绝不替没发生的事
 *   打包票。
 * - **只提醒本次运行里亲眼看着在加速的会话**，同一次连接最多提醒一次。
 *
 * 不含任何 Electron 依赖：时钟、定时器、通知与状态读取都由宿主注入。
 */
import type { AccelerationState } from './acceleration-contract'

/** restored：会话确实停了，网络设置已改回；unrestored：没能确认这一点。 */
export type AccelerationInterruptionOutcome = 'restored' | 'unrestored'

export interface AccelerationInterruptionNoticeOptions {
  notify(outcome: AccelerationInterruptionOutcome, eventKey: string): void
  /** 读一次状态；读到的那一份会经由服务的 onState 回到 observe()。 */
  readState(scope: string): Promise<AccelerationState>
  getAccountScope(): string | null
  schedule?(callback: () => void, delayMs: number): () => void
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
}

export interface AccelerationInterruptionNotice {
  /** 服务每产出一个状态就送进来，与托盘那一路同一个来源。 */
  observe(state: AccelerationState): void
  /** 辅助进程报告：加速中内核自己退出了，它已经先试过还原网络设置。 */
  runtimeExited(): void
  /** 宿主报告：辅助进程自己退出了，重拉的那一个有没有把网络设置改回去。 */
  helperExited(recovered: boolean): void
  /** 切换账号：上一个账号的会话一律不再提醒。 */
  reset(): void
  dispose(): void
}

interface PendingInterruption {
  scope: string
  key: string
  attempts: number
}

/** 停止是排队执行的，刚读到 stopping 时隔一会再读；次数有上限。 */
const settleRetryMs = 5000
const maxSettleAttempts = 6

function sessionKey(state: AccelerationState): string {
  return `${state.scope}:${state.connectedAt ?? state.measuredAt}`
}

function isRunning(state: AccelerationState): boolean {
  return state.phase === 'active' || state.phase === 'connecting' || state.phase === 'stopping'
}

function scheduleTimeout(callback: () => void, delayMs: number) {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}

export function createAccelerationInterruptionNotice(options: AccelerationInterruptionNoticeOptions): AccelerationInterruptionNotice {
  const schedule = options.schedule ?? scheduleTimeout
  // 最近一次读到的状态，以及本次运行里最近一次亲眼看着连上的会话。后者在会话
  // 结束后仍然留着：内核退出时，渲染层的一次轮询可能比辅助进程的报告先到，
  // 那时这里已经读到了「已断开」，报告来了仍要认得这次会话。
  let last: AccelerationState | null = null
  let seen: { scope: string; key: string } | null = null
  let pending: PendingInterruption | null = null
  const notified = new Set<string>()
  let cancel: (() => void) | null = null
  let disposed = false

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log?.(level, event, message, detail) }
    catch { /* 记日志失败不能反过来挡住通知。 */ }
  }

  function clearTimer(): void {
    cancel?.()
    cancel = null
  }

  function send(outcome: AccelerationInterruptionOutcome, key: string): void {
    pending = null
    clearTimer()
    if (notified.has(key)) return
    notified.add(key)
    while (notified.size > 64) notified.delete(notified.values().next().value!)
    try { options.notify(outcome, key) }
    catch (error) {
      log('warn', 'acceleration.interrupted.notify.failed', '加速意外断开的通知没有发出',
        { outcome, cause: error instanceof Error ? error.message : String(error) })
      return
    }
    log('info', 'acceleration.interrupted.notified',
      outcome === 'restored' ? '已提醒加速意外断开、网络已恢复' : '已提醒加速意外断开、网络可能尚未恢复', { outcome })
  }

  function read(delayMs: number): void {
    clearTimer()
    const current = pending
    if (disposed || !current) return
    cancel = schedule(() => {
      cancel = null
      if (disposed || pending !== current) return
      void Promise.resolve()
        .then(() => options.readState(current.scope))
        .catch((error) => {
          if (pending !== current) return
          log('warn', 'acceleration.interrupted.read.failed', '加速意外断开后读取状态失败',
            { attempt: current.attempts + 1, cause: error instanceof Error ? error.message : String(error) })
          retry(current)
        })
    }, Math.max(0, delayMs))
  }

  /** 读不到、或者读到的还在停：再给几次机会，仍没有结论就如实说「可能还没恢复」。 */
  function retry(current: PendingInterruption): void {
    current.attempts += 1
    if (current.attempts >= maxSettleAttempts) {
      send('unrestored', current.key)
      return
    }
    read(settleRetryMs)
  }

  function begin(scope: string, key: string): void {
    if (notified.has(key) || pending?.key === key) return
    pending = { scope, key, attempts: 0 }
    read(0)
  }

  function settle(state: AccelerationState): void {
    const current = pending
    if (!current || current.scope !== state.scope) return
    if (state.phase === 'connecting') return
    if (state.phase === 'active') {
      // 读到的已经是用户（或托盘、桌面端联动）重新连上的另一次会话：不必再提醒。
      if (sessionKey(state) !== current.key) {
        pending = null
        clearTimer()
        return
      }
      retry(current)
      return
    }
    if (state.phase === 'stopping') {
      // 停止没落定（也可能是还原网络设置失败、后端正每 5 秒重试）。
      retry(current)
      return
    }
    send('restored', current.key)
  }

  return {
    observe(state) {
      if (disposed) return
      last = state
      if (state.phase === 'active' && state.connectedAt) seen = { scope: state.scope, key: sessionKey(state) }
      settle(state)
    },
    runtimeExited() {
      if (disposed) return
      const scope = options.getAccountScope()
      if (!scope || seen?.scope !== scope) {
        log('info', 'acceleration.interrupted.skipped', '加速内核退出时本次运行里没有看到在加速的会话，不提醒')
        return
      }
      log('warn', 'acceleration.runtime.exited', '加速中加速组件意外退出，已先还原网络设置')
      begin(scope, seen.key)
    },
    helperExited(recovered) {
      if (disposed) return
      log(recovered ? 'warn' : 'info', 'acceleration.helper.exited',
        recovered ? '加速辅助组件意外退出，已重新拉起并还原网络设置' : '加速辅助组件意外退出，重新拉起未成功',
        { recovered })
      const scope = options.getAccountScope()
      // 辅助进程退出前最后一次读到的状态还在加速，才可能有网络设置要还原。
      if (!scope || !last || last.scope !== scope || !isRunning(last)) return
      const key = seen?.scope === scope ? seen.key : sessionKey(last)
      if (recovered) {
        begin(scope, key)
        return
      }
      send('unrestored', key)
      // 读一次让托盘跟上；这一读会再试着拉起一次辅助进程，成功了网络也就回来了。
      void Promise.resolve().then(() => options.readState(scope)).catch(() => undefined)
    },
    reset() {
      last = null
      seen = null
      pending = null
      clearTimer()
    },
    dispose() {
      disposed = true
      last = null
      seen = null
      pending = null
      clearTimer()
    },
  }
}
