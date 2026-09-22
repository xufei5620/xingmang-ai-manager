/**
 * 免费加速时长快用完、以及用完自动断开的那一刻，各发一条系统通知。
 *
 * 为什么放在主进程：用户开着加速去打游戏时，主窗口一定是缩在托盘里的，而
 * 渲染层的加速控制器（features/acceleration/controller.ts）把每秒计时与 15 秒
 * 轮询都挂在「窗口可见」上——恰恰在最该提醒的那段时间里，渲染层什么都不算。
 * 真正扣时长、到点断开的是后端自己的定时器（acceleration-development-backend.ts
 * 的 arm/stopSession），它停会话时不会产出状态，所以只要没人去读，主进程也看
 * 不到「已经断开了」。这个模块补的就是那次读：到点去读一次状态，让服务把新
 * 状态发出来，再据此判断该不该发通知。
 *
 * 三条边界：
 * - **不自己停加速**。停止仍由后端的定时器与渲染层负责，这里只观察与提醒；
 *   多一条停止路径就是多一种把用户正连着的会话停掉的方式。
 * - **只提醒本次运行里亲眼看着连上的会话**。打开软件时账号时长早就用完，
 *   不该弹一条「加速已断开」。
 * - **「已断开」只认 exhausted**。停止失败时状态停在 stopping、隧道其实还在，
 *   那时候说「已断开」是在骗用户。
 *
 * 不含任何 Electron 依赖：时钟、定时器、通知与状态读取都由宿主注入。
 */
import { accelerationExpiryWarningSeconds, type AccelerationState } from './acceleration-contract'

export type AccelerationExpiryStage = 'expiring' | 'exhausted'

export interface AccelerationExpiryNoticeOptions {
  /** 发一条通知；去重键由这里给出，宿主不必再记一份。 */
  notify(stage: AccelerationExpiryStage, eventKey: string): void
  /** 到点去读一次状态；读到的那一份会经由服务的 onState 回到 observe()。 */
  readState(scope: string): Promise<AccelerationState>
  schedule?(callback: () => void, delayMs: number): () => void
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
  warningSeconds?: number
}

export interface AccelerationExpiryNotice {
  /** 服务每产出一个状态就送进来，与托盘那一路同一个来源。 */
  observe(state: AccelerationState): void
  /** 切换账号：上一个账号的会话一律不再提醒。 */
  reset(): void
  dispose(): void
}

interface TrackedSession {
  scope: string
  /** 同一次连接的稳定编号；重连会换一个，于是两条通知各自重新可发。 */
  key: string
  warned: boolean
  /**
   * 到点之后重读了几次仍没有结论：读到的还是 stopping，或者这次读根本失败了。
   * 有上限，免得一个停不下来的会话把定时器永远续下去。
   */
  settleAttempts: number
}

/** 到点后多等一会再读：后端的停止是排队执行的，读太早只会读到 stopping。 */
const settleDelayMs = 2000
const settleRetryMs = 5000
const maxSettleAttempts = 6
const minimumDelayMs = 1000

function sessionKey(state: AccelerationState): string {
  return `${state.scope}:${state.connectedAt ?? state.measuredAt}`
}

function scheduleTimeout(callback: () => void, delayMs: number) {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}

export function createAccelerationExpiryNotice(options: AccelerationExpiryNoticeOptions): AccelerationExpiryNotice {
  const schedule = options.schedule ?? scheduleTimeout
  const warningSeconds = options.warningSeconds ?? accelerationExpiryWarningSeconds
  let tracked: TrackedSession | null = null
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

  function send(stage: AccelerationExpiryStage, session: TrackedSession): void {
    try { options.notify(stage, session.key) }
    catch (error) {
      log('warn', 'acceleration.expiry.notify.failed', '加速时长通知没有发出',
        { stage, cause: error instanceof Error ? error.message : String(error) })
      return
    }
    log('info', stage === 'expiring' ? 'acceleration.expiry.warned' : 'acceleration.expiry.exhausted',
      stage === 'expiring' ? '已提醒加速时长即将用完' : '已提醒加速时长已用完并断开')
  }

  function poke(scope: string, delayMs: number): void {
    clearTimer()
    if (disposed) return
    cancel = schedule(() => {
      cancel = null
      if (disposed || tracked?.scope !== scope) return
      void Promise.resolve()
        .then(() => options.readState(scope))
        .catch((error) => {
          const session = tracked
          if (session?.scope !== scope) return
          session.settleAttempts += 1
          log('warn', 'acceleration.expiry.read.failed', '读取加速剩余时长失败',
            { attempt: session.settleAttempts, cause: error instanceof Error ? error.message : String(error) })
          // 一次读失败不代表这次会话不该再提醒（服务还没就绪、请求正好撞上账号
          // 切换都会这样），但也不能无限重试：到次数就收手，绝不凭猜测发通知。
          if (session.settleAttempts > maxSettleAttempts) {
            tracked = null
            return
          }
          poke(scope, settleRetryMs)
        })
    }, Math.max(minimumDelayMs, Math.ceil(delayMs)))
  }

  function follow(state: AccelerationState, remainingSeconds: number): void {
    const key = sessionKey(state)
    if (!tracked || tracked.scope !== state.scope || tracked.key !== key) {
      tracked = { scope: state.scope, key, warned: false, settleAttempts: 0 }
    }
    tracked.settleAttempts = 0
    if (remainingSeconds <= warningSeconds) {
      if (!tracked.warned) {
        tracked.warned = true
        send('expiring', tracked)
      }
      poke(state.scope, remainingSeconds * 1000 + settleDelayMs)
      return
    }
    poke(state.scope, (remainingSeconds - warningSeconds) * 1000)
  }

  function settle(state: AccelerationState): void {
    const session = tracked
    if (!session || session.scope !== state.scope) return
    if (state.phase === 'exhausted') {
      tracked = null
      clearTimer()
      send('exhausted', session)
      return
    }
    if (state.phase === 'stopping' && state.remainingSeconds === 0) {
      // 时长到了、停止还没落定（也可能是停失败了）。隧道说不定还在，这时候说
      // 「已断开」就是假话：再给它几次机会，仍不落定就不提醒。
      session.settleAttempts += 1
      if (session.settleAttempts > maxSettleAttempts) {
        log('warn', 'acceleration.expiry.unsettled', '加速时长已用完但停止未落定，不再提醒')
        tracked = null
        clearTimer()
        return
      }
      poke(state.scope, settleRetryMs)
      return
    }
    // 用户自己停的、连接失败的、还剩时长的：都不是「用完了」，不提醒。
    tracked = null
    clearTimer()
  }

  return {
    observe(state) {
      if (disposed) return
      if (state.phase === 'active' && state.remainingSeconds !== null && state.remainingSeconds > 0) {
        follow(state, state.remainingSeconds)
        return
      }
      if (state.phase === 'connecting') return
      settle(state)
    },
    reset() {
      tracked = null
      clearTimer()
    },
    dispose() {
      disposed = true
      tracked = null
      clearTimer()
    },
  }
}
