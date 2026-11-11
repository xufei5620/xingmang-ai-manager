import type { AccountPriceList, AccountPriceRow } from './ipc-contract'
import type { NewApiModelPricing } from './new-api-client'

// 个人中心「用量账单」里的价格表（Fable 第二轮 Q3）。价目和画布「预计约 $x」读的是同一份 /api/pricing，
// 这里只把它换成客户看得懂的「每百万 Token 多少美元」，已经乘上这个账号在各分组的倍率。扣多少钱照旧是站点算。

// Ratio 1 is US$0.002 per 1K tokens (new-api common/constants.go: QuotaPerUnit = 500 * 1000, "$0.002 / 1K tokens"),
// so US$2 per million. usage-pricing-parser.ts turns a call's model_ratio into a price with the same factor.
const usdPerMillionAtRatioOne = 2
// Anything above these is a broken answer rather than a price, and is left out instead of shown.
const maximumUsdPerMillion = 10_000
const maximumUsdPerCall = 1_000
const maximumRows = 1_000

// Ratios multiply into float noise (0.04 × 1.5 = 0.060000000000000005); ten decimals is far finer than any price shown.
function finitePrice(value: number, maximum: number): number | undefined {
  return Number.isFinite(value) && value >= 0 && value <= maximum ? Math.round(value * 1e10) / 1e10 : undefined
}

/**
 * One row per model and group the account can use it in. A model listed for
 * `all` shows up under every usable group. Tiered (expression or plugin)
 * pricing has no single number, so its row carries no price and the page says
 * where to find the tiers instead.
 */
export function buildAccountPriceList(pricing: NewApiModelPricing): AccountPriceList {
  const usableGroups = Object.keys(pricing.groupRatios)
  const rows: AccountPriceRow[] = []
  for (const entry of pricing.models) {
    if (!entry.groups) continue
    const groups = entry.groups.includes('all') ? usableGroups : entry.groups.filter((group) => Object.hasOwn(pricing.groupRatios, group))
    for (const group of groups) {
      const ratio = pricing.groupRatios[group]
      if (entry.expressionPriced) {
        rows.push({ model: entry.model, group, kind: 'tiered' })
      } else if (entry.quotaType === 1) {
        const perCall = finitePrice(entry.modelPrice * ratio, maximumUsdPerCall)
        if (perCall !== undefined) rows.push({ model: entry.model, group, kind: 'call', perCall })
      } else if (entry.quotaType === 0 && entry.modelRatio !== undefined) {
        const input = finitePrice(entry.modelRatio * usdPerMillionAtRatioOne * ratio, maximumUsdPerMillion)
        const output = input === undefined ? undefined : finitePrice(input * (entry.completionRatio ?? 1), maximumUsdPerMillion)
        if (input !== undefined && output !== undefined) rows.push({ model: entry.model, group, kind: 'token', input, output })
      }
    }
  }
  rows.sort((left, right) => left.group.localeCompare(right.group, 'zh-CN') || left.model.localeCompare(right.model, 'en'))
  return { rows: rows.slice(0, maximumRows) }
}
