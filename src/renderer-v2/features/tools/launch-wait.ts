/**
 * 账号这一轮还在给这个工具换密钥时点了「打开」（主路卡点 F7）：以前只弹一句「请稍后再打开」就停下，
 * 好了也不自己打开，客户得再点一次。现在等那一轮写完再接着打开。那一轮的进度只存在一个 ref 里，
 * 没有事件可订阅，所以每隔一小会儿看一眼；换了账号、关了窗就不等了。等太久也放手——主进程那一轮
 * 要是卡住，「打开中」会一直挂着，首页的「打开」也一直被它挡住。
 */
export const accountConnectionPollMs = 250
export const accountConnectionWaitMaxMs = 3 * 60_000

/** ready = 那一轮完了；stopped = 换了账号或关了窗，这次不开；timeout = 等够了还没完。 */
export type AccountConnectionWaitOutcome = 'ready' | 'stopped' | 'timeout'

export interface AccountConnectionWaitOptions {
  /** 那一轮还在不在给这个工具换密钥。 */
  pending(): boolean
  /** 点「打开」的还是不是这个账号、窗还开着没。 */
  current(): boolean
  sleep?(ms: number): Promise<void>
  now?(): number
  pollMs?: number
  maxMs?: number
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

export async function waitWhileAccountConnectionPending(options: AccountConnectionWaitOptions): Promise<AccountConnectionWaitOutcome> {
  const { pending, current, sleep = sleepFor, now = Date.now, pollMs = accountConnectionPollMs, maxMs = accountConnectionWaitMaxMs } = options
  const startedAt = now()
  for (;;) {
    if (!current()) return 'stopped'
    if (!pending()) return 'ready'
    if (now() - startedAt >= maxMs) return 'timeout'
    await sleep(pollMs)
  }
}
