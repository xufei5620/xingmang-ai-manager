/**
 * 开机恢复登录联不上时，隔多久再试一次。前几次靠得近，是因为最常见的原因（刚开机
 * 网络还没连上、服务几分钟的维护）很快就会好；之后固定五分钟一次，一直到恢复成功、
 * 确认登录失效或用户自己登录 / 退出为止。每次只是一轮续期加一次个人信息读取。
 */
export const accountRestoreRetryDelaysMs = [30_000, 120_000, 300_000] as const

export function resolveAccountRestoreRetryDelay(attempt: number): number {
  const index = Math.min(Math.max(0, Math.floor(attempt)), accountRestoreRetryDelaysMs.length - 1)
  return accountRestoreRetryDelaysMs[index]
}

export interface AccountRestoreRetryOptions {
  /** realm 账号服务的 restoreActive()：成功 true，登录失效 false，其余抛错且登录保留。 */
  restore(): Promise<boolean>
  /** 还有没有一个「登录留着、等重试」的账号。登录、退出、切换账号后就没有了。 */
  stalled(): boolean
  onFailure?(error: unknown, attempt: number): void
  setTimer?(callback: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

export interface AccountRestoreRetry {
  /** 恢复没成且登录还留着时调用；已经排着一次就不再重复排。 */
  schedule(): void
  /** 退出软件时调用：退出过程中不能再去动账号。 */
  dispose(): void
}

export function createAccountRestoreRetry(options: AccountRestoreRetryOptions): AccountRestoreRetry {
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let attempt = 0
  let timer: unknown = null
  let running = false
  let disposed = false

  function schedule(): void {
    if (disposed || running || timer !== null || !options.stalled()) return
    timer = setTimer(run, resolveAccountRestoreRetryDelay(attempt))
  }
  function run(): void {
    timer = null
    if (disposed || !options.stalled()) return
    running = true
    const current = attempt
    attempt += 1
    void options.restore().catch((error: unknown) => {
      options.onFailure?.(error, current)
      return false
    }).then(() => {
      running = false
      schedule()
    })
  }
  return {
    schedule,
    dispose: () => {
      disposed = true
      if (timer !== null) clearTimer(timer)
      timer = null
    },
  }
}
