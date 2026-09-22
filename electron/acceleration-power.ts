/**
 * 电脑睡眠与醒来时的加速处理。
 *
 * 为什么要有它：免费时长按单调钟计，而两个平台对「睡眠里单调钟走不走」的态度
 * 相反——Windows 照走，合盖一晚醒来时长就被扣光；macOS 停表，到期的定时器跟着
 * 晚响一整觉。规矩是睡着的那段一律不计时：
 * - 睡前把会话的计时冻住、撤掉到期定时器（acceleration-development-backend.ts 的
 *   suspend）；
 * - 醒来先把睡眠扣掉，再看加速还在不在：还在就按剩余时长接着用；不在了就走意外
 *   断开那条路，先还原网络设置再提醒（backend 的 resume → inspect，提醒见
 *   acceleration-interruption-notice.ts）；
 * - 最后替用户读一次状态，让托盘、到期提醒按醒来后的剩余时长重新对齐——到期
 *   提醒自己的定时器同样跨过了这一觉，不能指望它。
 *
 * 不重连加速，也不因为睡眠去断开：还在的连接接着用，不在的只提醒。
 *
 * 不含任何 Electron 依赖：powerMonitor 由宿主接进来。
 */
import type { AccelerationState } from './acceleration-contract'

export interface AccelerationPowerOptions {
  suspend(): Promise<void>
  resume(): Promise<void>
  getAccountScope(): string | null
  /** 读到的那一份经由服务的 onState 送到托盘与两种提醒。 */
  readState(scope: string): Promise<AccelerationState>
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
}

export interface AccelerationPower {
  suspended(): void
  resumed(): void
}

export function createAccelerationPower(options: AccelerationPowerOptions): AccelerationPower {
  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log?.(level, event, message, detail) }
    catch { /* 记日志失败不能挡住睡眠与醒来的处理。 */ }
  }

  function cause(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  return {
    suspended() {
      log('info', 'acceleration.power.suspended', '电脑即将睡眠，加速计时已暂停')
      void Promise.resolve().then(() => options.suspend()).catch((error) => {
        log('warn', 'acceleration.power.suspend.failed', '电脑睡眠前暂停加速计时失败', { cause: cause(error) })
      })
    },
    resumed() {
      log('info', 'acceleration.power.resumed', '电脑已醒来，正在检查加速是否还在')
      void Promise.resolve()
        .then(() => options.resume())
        .catch((error) => {
          log('warn', 'acceleration.power.resume.failed', '电脑醒来后检查加速失败', { cause: cause(error) })
        })
        .then(() => {
          const scope = options.getAccountScope()
          if (scope) return options.readState(scope)
        })
        .catch((error) => {
          log('warn', 'acceleration.power.read.failed', '电脑醒来后读取加速状态失败', { cause: cause(error) })
        })
    },
  }
}
