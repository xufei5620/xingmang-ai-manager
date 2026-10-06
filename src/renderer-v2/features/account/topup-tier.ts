import { useEffect, useRef, useState } from 'react'
import { buildTopupBonus } from './topup-bonus'

export type TopupQuoteState = number | 'loading' | 'failed'

export interface TopupTierView {
  credited: string
  // 试算好的实付；还在算、算不了时为 null：卡上不写「实付」，也不在每张卡上报错。
  paid: string | null
  // 实付还在算：卡上放一条灰色占位条，不写字。
  quoting: boolean
  // 有赠送时的「送 10%」；没有赠送时为 null，不写「无赠送」。
  bonus: string | null
  label: string
}

// 两种账号档位的含义不同：带 `creditMultiplier` 的账号，档位是实付金额，到账 =
// 档位 × 倍数，全部档位同一个赠送比例；不带的账号，后台「充值金额选项」的数是到账额度，
// 单位跟余额一样是美元，赠送按档位各自的折扣算。实付由服务端试算
// （会把档位折扣和当前账号所在分组的倍率都算进去），客户端不自己乘比例：
// 价格和活动都在后台改，写死在这里迟早对不上。
// quote 为 'unavailable'：这会儿算不了（断网、没有支付渠道、充值信息没读到），不写「实付」。
export function describeTopupTier(input: {
  amount: number
  quote: TopupQuoteState | 'unavailable' | undefined
  discounts: Record<string, number> | undefined
  provider: string | undefined
  creditMultiplier?: number
}): TopupTierView {
  const multiplier = input.creditMultiplier
  const credited = `$${formatAmount(multiplier === undefined ? input.amount : Math.round(input.amount * multiplier * 100) / 100)}`
  const paid = typeof input.quote === 'number'
    ? `${payableSymbol(input.provider)}${input.quote.toFixed(2)}`
    : null
  const percent = multiplier === undefined
    ? buildTopupBonus(input.amount, input.discounts)?.percent ?? 0
    : Math.round((multiplier - 1) * 100)
  const bonus = percent > 0 ? `送 ${percent}%` : null
  return {
    credited,
    paid,
    quoting: input.quote === undefined || input.quote === 'loading',
    bonus,
    label: [`到账 ${credited}`, paid === null ? null : `实付 ${paid}`, bonus].filter(Boolean).join('，'),
  }
}

// 充值下单一律走 /api/user/pay（易支付），收款额就是 /api/user/amount 的试算值，
// 与选哪个支付方式无关；后台「充值价格」是「元/美金」，所以易支付渠道标人民币。
// 别的渠道币种以渠道页面为准，不乱标符号。
export function payableSymbol(provider: string | undefined): string {
  return provider === 'epay' ? '¥' : ''
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

export function isQuotableAmount(amount: number, minimum: number): boolean {
  return Number.isSafeInteger(amount) && amount > 0 && amount >= minimum
}

const maxPresetQuotes = 16
const customQuoteDelayMs = 500

// 逐档向服务端试算实付金额。一次只发一个请求，档位最多算 16 个，避免一打开页面
// 就撞上服务端限流；自定义金额停止输入半秒后再算。换账号或重新加载充值信息时
// `resetKey` 会变，旧结果整批作废，晚到的旧响应也不会写回来。
export function useTopupQuotes(input: {
  quote: (amount: number) => Promise<number>
  presets: readonly number[]
  custom: number | null
  enabled: boolean
  resetKey: unknown
}): ReadonlyMap<number, TopupQuoteState> {
  const [quotes, setQuotes] = useState<ReadonlyMap<number, TopupQuoteState>>(() => new Map())
  const generation = useRef(0)
  const requested = useRef(new Set<number>())
  const quoteRef = useRef(input.quote)
  quoteRef.current = input.quote

  function request(amounts: readonly number[], current: number) {
    const pending = amounts.filter((amount) => !requested.current.has(amount))
    if (pending.length === 0) return
    for (const amount of pending) requested.current.add(amount)
    setQuotes((previous) => {
      const next = new Map(previous)
      for (const amount of pending) next.set(amount, 'loading')
      return next
    })
    void (async () => {
      for (const amount of pending) {
        if (generation.current !== current) return
        let result: TopupQuoteState
        try {
          result = await quoteRef.current(amount)
        } catch {
          result = 'failed'
        }
        if (generation.current !== current) return
        if (result === 'failed') requested.current.delete(amount)
        setQuotes((previous) => new Map(previous).set(amount, result))
      }
    })()
  }

  const presetKey = input.presets.slice(0, maxPresetQuotes).join(',')
  useEffect(() => {
    generation.current += 1
    requested.current = new Set()
    setQuotes(new Map())
  }, [input.resetKey])

  useEffect(() => {
    if (!input.enabled || !presetKey) return
    request(presetKey.split(',').map(Number), generation.current)
  }, [input.enabled, presetKey, input.resetKey])

  useEffect(() => {
    const amount = input.custom
    if (!input.enabled || amount === null || requested.current.has(amount)) return
    const current = generation.current
    const timer = setTimeout(() => request([amount], current), customQuoteDelayMs)
    return () => clearTimeout(timer)
  }, [input.enabled, input.custom, input.resetKey])

  return quotes
}
