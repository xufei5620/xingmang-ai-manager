import { resolveAiModelCapability } from './ai-chat-protocol'
import type { CanvasPriceSnapshot } from './canvas-contract'
import type { NewApiModelPricing } from './new-api-client'

// 运行前检查里的「预计约 $x」（画布完善第 2b 条第 2 步）。价目来自星芒站给这个账号的 /api/pricing，
// 画布只拿去乘一乘、上屏；扣多少钱照旧是站点算，主进程不信画布算出来的数。历史账号没有按型号的价目，
// 回 null，画布写「价格未知」。

/** Prices change rarely; one read serves every preflight for this long. */
export const canvasPriceSnapshotCacheMs = 10 * 60_000
/** After a failed read, the next attempt waits this long however often the canvas asks. */
export const canvasPriceSnapshotRetryMs = 60_000

// Anything above these is a broken answer, not a price (the kernel refuses them too).
const maximumPerCallUsd = 1_000
const maximumGroupRatio = 1_000

/** Null for a name the desktop would refuse as a model anyway; the canvas cannot request it. */
function canvasModelKind(model: string): string | null {
  try {
    return resolveAiModelCapability(model).kind
  } catch {
    return null
  }
}

/**
 * The canvas's view of the price list: per-call models only. A token-priced
 * model, or one billed by an expression or a plugin, has no per-call number
 * and is left out, so the canvas says 价格未知 for it rather than a wrong price.
 * Video is marked an estimate: the relay may scale a call's price by its
 * duration and size.
 */
export function buildCanvasPriceSnapshot(pricing: NewApiModelPricing, readAt: number): CanvasPriceSnapshot {
  const models: CanvasPriceSnapshot['models'] = {}
  for (const entry of pricing.models) {
    if (entry.quotaType !== 1 || entry.expressionPriced) continue
    if (!(entry.modelPrice >= 0 && entry.modelPrice <= maximumPerCallUsd)) continue
    const kind = canvasModelKind(entry.model)
    if (!kind) continue
    models[entry.model] = kind === 'video' ? { usd: entry.modelPrice, approximate: true } : { usd: entry.modelPrice }
  }
  const groupRatios: CanvasPriceSnapshot['groupRatios'] = {}
  for (const [group, ratio] of Object.entries(pricing.groupRatios)) {
    if (ratio >= 0 && ratio <= maximumGroupRatio) groupRatios[group] = ratio
  }
  return { models, groupRatios, readAt: new Date(readAt).toISOString() }
}

export interface CanvasPriceSnapshotReaderOptions {
  /** Who is signed in now; null when nobody is. The key changes whenever the account does. */
  current(): { key: string; siteId: 'solov' | 'solov-api' } | null
  /** GET /api/pricing for the signed-in account; left out (or answering null) where the backend has no price list. */
  readPricing(): Promise<NewApiModelPricing | null>
  now?: () => number
  cacheMs?: number
  retryMs?: number
}

/**
 * Answers canvas-host:get-price-snapshot. No arguments reach it from the
 * canvas, one read at a time, a cached answer for cacheMs, and after a failure
 * no new read for retryMs: a canvas asking in a loop costs the site nothing.
 */
export function createCanvasPriceSnapshotReader(options: CanvasPriceSnapshotReaderOptions): () => Promise<CanvasPriceSnapshot | null> {
  const now = options.now ?? Date.now
  const cacheMs = options.cacheMs ?? canvasPriceSnapshotCacheMs
  const retryMs = options.retryMs ?? canvasPriceSnapshotRetryMs
  let cached: { key: string; at: number; snapshot: CanvasPriceSnapshot | null } | null = null
  let failed: { key: string; at: number } | null = null
  let pending: { key: string; read: Promise<CanvasPriceSnapshot | null> } | null = null

  function within(time: number, at: number, limit: number): boolean {
    return at - time >= 0 && at - time < limit
  }

  async function read(key: string): Promise<CanvasPriceSnapshot | null> {
    try {
      const pricing = await options.readPricing()
      const snapshot = pricing ? buildCanvasPriceSnapshot(pricing, now()) : null
      // Read for an account that is gone by now: keep it out of the cache and away from the canvas.
      if (options.current()?.key !== key) return null
      cached = { key, at: now(), snapshot }
      return snapshot
    } catch {
      failed = { key, at: now() }
      return cached?.key === key ? cached.snapshot : null
    }
  }

  return async () => {
    const account = options.current()
    if (!account || account.siteId !== 'solov') return null
    const at = now()
    if (cached?.key === account.key && within(cached.at, at, cacheMs)) return cached.snapshot
    if (failed?.key === account.key && within(failed.at, at, retryMs)) return cached?.key === account.key ? cached.snapshot : null
    if (pending?.key !== account.key) {
      const reading = read(account.key).finally(() => {
        if (pending?.read === reading) pending = null
      })
      pending = { key: account.key, read: reading }
    }
    return pending.read
  }
}
