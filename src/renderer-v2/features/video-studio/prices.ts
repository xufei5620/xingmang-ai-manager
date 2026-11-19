import { useCallback, useEffect, useState } from 'react'
import type { AccountPriceList, XingmangApi } from '../../../../electron/ipc-contract'
import { dollars } from '../../business-common'
import { createLatestRequest } from '../../latest-request'

// 确认框里那句「预计约 $x」（#1406 P2-1 后半，0.2.25 总单第 14 项）。价目和画布「预计约 $x」、个人中心「用量账单」
// 是同一份 /api/pricing（account:get-price-list，主进程已经乘上这个账号在各分组的倍率）。这里只按「每次多少钱 × 几次」
// 乘一乘上屏，扣多少钱照旧是站点算。没有按次的价（按 Token 计、分档计、没读到）就不写这句，不编一个数。

/** Prices change rarely: one read serves every confirmation for this long, like the canvas's price snapshot. */
export const videoStudioPriceListMaxAgeMs = 10 * 60_000
/** After a failed read, opening confirmations again does not ask the site again within this window. */
export const videoStudioPriceListRetryMs = 60_000

export type VideoStudioPriceBridge = Pick<XingmangApi, 'getAccountPriceList'>

/** One call of this model in this group, in US dollars at the group's ratio; null when it is not priced per call. */
export function videoStudioPerCallUsd(list: AccountPriceList | null, model: string, group: string): number | null {
  if (!list || !model || !group) return null
  const row = list.rows.find((item) => item.model === model && item.group === group)
  const usd = row?.kind === 'call' ? row.perCall : undefined
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : null
}

/**
 * The words 「预计约 $x」 for count calls at most. Null when there is no price.
 * approximate is for video: the site may scale a clip's charge by its length
 * and size, so the canvas marks the same number 估算 too.
 */
export function videoStudioQuoteText(perCallUsd: number | null, count: number, approximate: boolean): string | null {
  if (perCallUsd === null || !Number.isInteger(count) || count <= 0) return null
  const usd = perCallUsd * count
  // Two decimals like the balance, but a few tenths of a cent must not read as free (same as the canvas).
  const money = usd > 0 && usd < 0.005 ? '不到 $0.01' : `约 ${dollars(usd)}`
  return `预计${money}${approximate ? '（估算）' : ''}`
}

export interface VideoStudioPriceCache {
  /** The list last read while this account was signed in; null before the first answer or for another account. */
  current(scope: string): AccountPriceList | null
  /**
   * Reads again unless this account has a list younger than maxAgeMs, a read
   * in flight, or a failure within retryMs: opening confirmations in a row
   * costs the site one read.
   */
  refresh(scope: string, read: () => Promise<AccountPriceList | null>): void
  /** Drops the read in flight (the page went away); a later refresh starts over. */
  cancel(): void
}

export interface VideoStudioPriceCacheOptions {
  onChange(): void
  now?: () => number
  maxAgeMs?: number
  retryMs?: number
}

export function createVideoStudioPriceCache(options: VideoStudioPriceCacheOptions): VideoStudioPriceCache {
  const now = options.now ?? Date.now
  const maxAgeMs = options.maxAgeMs ?? videoStudioPriceListMaxAgeMs
  const retryMs = options.retryMs ?? videoStudioPriceListRetryMs
  const latest = createLatestRequest()
  let cached: { scope: string, at: number, list: AccountPriceList | null } | null = null
  let failed: { scope: string, at: number } | null = null
  let pending: string | null = null

  function within(since: number, at: number, limit: number): boolean {
    return at - since >= 0 && at - since < limit
  }

  return {
    current: (scope) => cached?.scope === scope ? cached.list : null,
    refresh(scope, read) {
      const at = now()
      if (pending === scope) return
      if (cached?.scope === scope && within(cached.at, at, maxAgeMs)) return
      if (failed?.scope === scope && within(failed.at, at, retryMs)) return
      // Another account's read still in flight answers for that account: drop it.
      const current = latest.begin()
      pending = scope
      read().then((list) => {
        if (!current()) return
        pending = null
        failed = null
        cached = { scope, at: now(), list }
        options.onChange()
      }, () => {
        if (!current()) return
        pending = null
        // Keep what this account had: a price a few minutes old beats none.
        failed = { scope, at: now() }
      })
    },
    cancel() {
      latest.invalidate()
      pending = null
    },
  }
}

/**
 * The price list for the confirmation dialogs. Read once when the page shows
 * for this account, so the dialog opens with the price already there, and
 * call refresh() when a paid confirmation opens to pick up a stale list.
 */
export function useVideoStudioPriceList(bridge: VideoStudioPriceBridge, accountScope: string, active: boolean): { list: AccountPriceList | null, refresh(): void } {
  const [, setVersion] = useState(0)
  const [cache] = useState(() => createVideoStudioPriceCache({ onChange: () => setVersion((version) => version + 1) }))
  const refresh = useCallback(() => cache.refresh(accountScope, () => bridge.getAccountPriceList()), [cache, accountScope, bridge])
  useEffect(() => { if (active) refresh() }, [active, refresh])
  useEffect(() => cache.cancel, [cache])
  return { list: cache.current(accountScope), refresh }
}
