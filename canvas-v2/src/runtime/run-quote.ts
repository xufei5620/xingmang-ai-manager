import type { CanvasPriceSnapshot } from '../host'
import { accountBalanceText } from './account-summary'
import type { CanvasRunPreflight } from './run-preflight'

// 运行前检查里的「预计约 $x」（桌面仓画布完善第 2b 条第 2 步）。价目和倍率都由宿主给，内核只按
// 「每次多少钱 × 分组倍率 × 最多几次」算；扣多少钱照旧由宿主和站点定，这个数不拿去扣费。

const maximumPricedModels = 2_000
const maximumModelNameLength = 128
const maximumGroupNameLength = 128
// One generation above this, or a ratio above this, is a broken answer rather than a price.
const maximumPerCallUsd = 1_000
const maximumGroupRatio = 1_000

export interface CanvasRunQuote {
  /** Dollars for every paid request the host could price, at its maximum count. */
  estimateUsd: number
  pricedRequests: number
  /** Paid requests whose model or group the host gave no price for. */
  unknownRequests: number
  /** Some priced model's price is the host's estimate rather than its exact charge. */
  approximate: boolean
}

export type CanvasRunQuoteView =
  | { state: 'loading' }
  | { state: 'ready'; quote: CanvasRunQuote }

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Reads the host's answer; null means the host cannot price this account at all. Anything malformed throws. */
export function parseCanvasPriceSnapshot(value: unknown): CanvasPriceSnapshot | null {
  if (value === null) return null
  const record = recordOf(value)
  const models = recordOf(record?.models)
  const groupRatios = recordOf(record?.groupRatios)
  if (!record || !models || !groupRatios || typeof record.readAt !== 'string' || !Number.isFinite(Date.parse(record.readAt))) throw new Error('价目格式不对')
  const modelEntries = Object.entries(models)
  if (modelEntries.length > maximumPricedModels) throw new Error('价目格式不对')
  const parsedModels: CanvasPriceSnapshot['models'] = {}
  for (const [name, entry] of modelEntries) {
    const price = recordOf(entry)
    if (!name || name.length > maximumModelNameLength || !price || typeof price.usd !== 'number' || !Number.isFinite(price.usd) || price.usd < 0 || price.usd > maximumPerCallUsd) throw new Error('价目格式不对')
    if (price.approximate !== undefined && typeof price.approximate !== 'boolean') throw new Error('价目格式不对')
    parsedModels[name] = { usd: price.usd, ...(price.approximate ? { approximate: true } : {}) }
  }
  const ratioEntries = Object.entries(groupRatios)
  if (ratioEntries.length > maximumPricedModels) throw new Error('价目格式不对')
  const parsedRatios: CanvasPriceSnapshot['groupRatios'] = {}
  for (const [name, ratio] of ratioEntries) {
    if (!name || name.length > maximumGroupNameLength || typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > maximumGroupRatio) throw new Error('价目格式不对')
    parsedRatios[name] = ratio
  }
  return { models: parsedModels, groupRatios: parsedRatios, readAt: new Date(record.readAt).toISOString() }
}

/**
 * Asks the host for its price list. A missing method, a failed read or a
 * malformed answer all price nothing (null), which reads 价格未知 rather than a
 * made-up number.
 */
export async function readCanvasPriceSnapshot(read: (() => Promise<unknown>) | undefined): Promise<CanvasPriceSnapshot | null> {
  if (!read) return null
  try {
    return parseCanvasPriceSnapshot(await read())
  } catch {
    return null
  }
}

/**
 * What the paid requests of this run cost at most, priced per generation.
 * Null when nothing in the run is paid. A null snapshot prices nothing, so
 * every paid request counts as unknown.
 */
export function buildCanvasRunQuote(preflight: Pick<CanvasRunPreflight, 'items'>, snapshot: CanvasPriceSnapshot | null): CanvasRunQuote | null {
  let estimateUsd = 0
  let pricedRequests = 0
  let unknownRequests = 0
  let approximate = false
  for (const item of preflight.items) {
    if (!item.paid || item.action !== 'execute' || item.requestCount <= 0) continue
    const price = item.model && snapshot && Object.hasOwn(snapshot.models, item.model) ? snapshot.models[item.model] : undefined
    const ratio = item.group && snapshot && Object.hasOwn(snapshot.groupRatios, item.group) ? snapshot.groupRatios[item.group] : undefined
    if (!price || ratio === undefined) {
      unknownRequests += item.requestCount
      continue
    }
    estimateUsd += price.usd * ratio * item.requestCount
    pricedRequests += item.requestCount
    if (price.approximate) approximate = true
  }
  if (pricedRequests + unknownRequests === 0) return null
  return { estimateUsd, pricedRequests, unknownRequests, approximate }
}

function moneyText(usd: number): string {
  // Two decimals like the main window, but a few tenths of a cent must not read as free.
  return usd > 0 && usd < 0.005 ? '不到 $0.01' : `约 ${accountBalanceText(usd)}`
}

/** The words after 「这次最多扣费生成 N 次，」. */
export function canvasRunQuoteText(view: CanvasRunQuoteView): string {
  if (view.state === 'loading') return '正在算预计多少钱'
  const { quote } = view
  if (quote.pricedRequests === 0) return '价格未知'
  const estimate = `预计${moneyText(quote.estimateUsd)}${quote.approximate ? '（估算）' : ''}`
  return quote.unknownRequests > 0 ? `${estimate}，另有 ${quote.unknownRequests} 次价格未知` : estimate
}
