import type { ProviderId, ToolTemplateFillResult } from '../../../../electron/ipc-contract'

/**
 * 开机那轮工具可能正开着，设置没补、Codex 的型号名单没按账号核对（主进程交回的 pending，
 * 第二十六批 E）。以前要等下次开星芒；客户升级后头一回打开时 Codex 多半正开着，就这样一直
 * 拖着。这里隔 10 分钟、或窗口回到前台时再要一次，主进程重新看工具开没开，只补欠着的那几样。
 * 补上了、不欠了、换了账号或者试满 6 次（约一小时）就停。主进程每次都要起进程看工具开没开，
 * 所以有上限；回到前台离上一次不到两分钟的也不算，免得来回切窗口把次数一下用完。
 */
export const templateFillRetryIntervalMs = 10 * 60_000
export const templateFillForegroundGapMs = 2 * 60_000
export const templateFillRetryLimit = 6

export interface TemplateFillRetryDependencies {
  /** 带 retry 再要一次（native.fillToolTemplateDefaults(true)）。 */
  fill(): Promise<ToolTemplateFillResult>
  /** 这次真补上了的工具，首页角落据此说一句。 */
  filled(providers: ProviderId[]): void
  now?: () => number
}

export interface TemplateFillRetry {
  /** 开机那轮（或联网后补跑那轮）的结果：还欠着就隔一阵再要，什么都不欠就停。 */
  follow(result: ToolTemplateFillResult): void
  /** 窗口回到前台。 */
  foreground(): void
  /** 换了账号或界面卸下：不再要，正在路上的那次结果也不用。 */
  stop(): void
}

export function createTemplateFillRetry({ fill, filled, now = Date.now }: TemplateFillRetryDependencies): TemplateFillRetry {
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let active = false
  let inFlight = false
  let attempts = 0
  let lastAttemptAt = 0

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  function stop() {
    generation++
    active = false
    inFlight = false
    clearTimer()
  }
  function settle(current: number, result: ToolTemplateFillResult | null) {
    if (current !== generation) return
    inFlight = false
    if (result?.filled.length) filled(result.filled)
    if ((result && !result.pending?.length) || attempts >= templateFillRetryLimit) {
      stop()
      return
    }
    timer = setTimeout(attempt, templateFillRetryIntervalMs)
  }
  function attempt() {
    if (!active || inFlight) return
    clearTimer()
    attempts++
    lastAttemptAt = now()
    inFlight = true
    const current = generation
    // 要不成（通道出错）也算一次，照旧隔 10 分钟再来。
    void fill().then((result) => settle(current, result), () => settle(current, null))
  }
  function follow(result: ToolTemplateFillResult) {
    if (!result.pending?.length) {
      stop()
      return
    }
    // 联网后补跑那轮又说欠着：接着原来的节奏和次数走，不重新数。
    if (active) return
    active = true
    attempts = 0
    lastAttemptAt = now()
    timer = setTimeout(attempt, templateFillRetryIntervalMs)
  }
  function foreground() {
    if (active && !inFlight && now() - lastAttemptAt >= templateFillForegroundGapMs) attempt()
  }
  return { follow, foreground, stop }
}
