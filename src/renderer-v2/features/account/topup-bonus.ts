export interface TopupBonus {
  bonus: number
  percent: number
}

// 后台「充值金额选项 + 充值折扣」里，折扣是「付款 = 到账 × 比例」：到账不变，
// 少付的那部分就是送的。换成客户熟悉的「充 100 送 10」：送多少按到账单位算，
// 百分比按实付算，这样不需要知道后台的计价单价和币种。
export function buildTopupBonus(
  amount: number,
  discounts: Record<string, number> | undefined,
): TopupBonus | null {
  if (!Number.isFinite(amount) || amount <= 0) return null
  const ratio = discounts?.[String(amount)]
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return null
  const bonus = Math.round(amount * (1 - ratio) * 100) / 100
  const percent = Math.round(((1 - ratio) / ratio) * 100)
  if (bonus <= 0 || percent <= 0) return null
  return { bonus, percent }
}
