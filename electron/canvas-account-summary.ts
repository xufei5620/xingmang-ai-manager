import type { CanvasAccountSummary } from './canvas-contract'
import type { NewApiBalance } from './new-api-client'

// 画布顶上的余额条（画布完善第 2b 条第 1 步）。画布跑第三方前端代码（I15），这里只给它四样：
// 哪种账号、打过码的账号名、余额、什么时候读的。邮箱、用户编号、密钥一样都不给。

/** A balance read this recently is answered as it is, without asking the account site again. */
export const canvasAccountSummaryFreshMs = 15_000

const maximumAccountLabelLength = 64

/**
 * Half-hides the account name before it reaches the canvas: the first one or
 * two characters and the last one stay, the rest becomes three stars whatever
 * its length. A historical account without a username shows its email here
 * (sub2api parseUser), so an address keeps only the first character before @
 * and loses the domain too.
 */
export function maskCanvasAccountLabel(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null
  const cleaned = name.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim()
  if (!cleaned) return null
  const at = cleaned.indexOf('@')
  if (at >= 0) {
    const first = [...cleaned.slice(0, at)][0]
    return first ? `${first}***@***` : '***@***'
  }
  const characters = [...cleaned].slice(0, maximumAccountLabelLength)
  if (characters.length <= 2) return `${characters[0]}***`
  if (characters.length <= 4) return `${characters[0]}***${characters[characters.length - 1]}`
  return `${characters.slice(0, 2).join('')}***${characters[characters.length - 1]}`
}

export interface CanvasAccountSummaryInput {
  siteId: 'solov' | 'solov-api'
  username: string | null | undefined
  balance: Pick<NewApiBalance, 'quota' | 'quotaPerUnit'> | null
  balanceReadAt: number | null
  /** traySubscriptionLabel's line, e.g. 「剩余 USD 12.30 · 10月3日到期」; null when there is no usable subscription. */
  subscriptionLabel: string | null
}

/** The summary for the balance chip; dollars like the main window's dollars(), quota / quotaPerUnit. */
export function buildCanvasAccountSummary(input: CanvasAccountSummaryInput): CanvasAccountSummary {
  const balanceUsd = input.balance && input.balance.quotaPerUnit > 0 && Number.isFinite(input.balance.quota)
    ? input.balance.quota / input.balance.quotaPerUnit
    : null
  return {
    siteLabel: input.siteId === 'solov-api' ? '历史账号' : '星芒账号',
    accountLabel: maskCanvasAccountLabel(input.username),
    balanceUsd,
    subscriptionLabel: input.subscriptionLabel ? `订阅${input.subscriptionLabel}` : null,
    readAt: balanceUsd !== null && input.balanceReadAt !== null ? new Date(input.balanceReadAt).toISOString() : null,
  }
}

export interface CanvasAccountSummaryReaderOptions {
  /** Who is signed in now; null when nobody is. The key changes whenever the account does. */
  current(): { key: string; siteId: 'solov' | 'solov-api'; username: string | null } | null
  /** The balance the main window, the balance alerts or this reader last read, and when. */
  latest(): { balance: Pick<NewApiBalance, 'quota' | 'quotaPerUnit'> | null; readAt: number | null; subscriptionLabel: string | null }
  /**
   * Reads the balance from the account site and records it where latest()
   * finds it, only if the account is still the one that asked (main.ts).
   */
  readBalance(): Promise<void>
  /**
   * When a canvas run last ended. A run spends money, so a balance read before
   * it is not fresh and the once-per-freshMs limit starts again from it: the
   * chip asks right after a run and must not get the balance from before it.
   */
  spentAt?(): number | null
  now?: () => number
  freshMs?: number
}

/**
 * Answers canvas-host:get-account-summary. The canvas cannot make it ask
 * anything else: no arguments, and at most one read of the account site per
 * freshMs (and per finished run) however often the canvas calls. A failed read
 * still answers with what was read before, so the chip shows its age rather
 * than nothing.
 */
export function createCanvasAccountSummaryReader(options: CanvasAccountSummaryReaderOptions): () => Promise<CanvasAccountSummary | null> {
  const now = options.now ?? Date.now
  const freshMs = options.freshMs ?? canvasAccountSummaryFreshMs
  let pending: { key: string; read: Promise<void> } | null = null
  let lastAsked: { key: string; at: number } | null = null

  function summary(): CanvasAccountSummary | null {
    const account = options.current()
    if (!account) return null
    const latest = options.latest()
    return buildCanvasAccountSummary({ siteId: account.siteId, username: account.username, balance: latest.balance, balanceReadAt: latest.readAt, subscriptionLabel: latest.subscriptionLabel })
  }

  function recent(time: number | null, at: number, since: number | null): boolean {
    return time !== null && (since === null || time >= since) && at - time >= 0 && at - time < freshMs
  }

  return async () => {
    const account = options.current()
    if (!account) return null
    const at = now()
    const since = options.spentAt?.() ?? null
    const fresh = recent(options.latest().readAt, at, since)
    // A failed read is not retried at once either: the canvas may ask in a loop.
    const askedRecently = lastAsked?.key === account.key && recent(lastAsked.at, at, since)
    if (!fresh && !askedRecently) {
      lastAsked = { key: account.key, at }
      const read = options.readBalance().catch(() => undefined).finally(() => {
        if (pending?.read === read) pending = null
      })
      pending = { key: account.key, read }
    }
    if (pending?.key === account.key) await pending.read
    return summary()
  }
}
