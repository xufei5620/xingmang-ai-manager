import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AccountTopupInfo } from '../../../../electron/ipc-contract'
import { PaymentMethodIcon } from './AccountRecharge'

type Method = Pick<AccountTopupInfo['paymentMethods'][number], 'provider' | 'type'>

describe('renderer-v2 recharge payment method icon', () => {
  it('draws the channel mark for alipay, wechat pay and stripe', () => {
    const marks: Array<[Method, string]> = [
      [{ provider: 'epay', type: 'alipay' }, 'Alipay'],
      [{ provider: 'epay', type: 'wxpay' }, 'WeChat'],
      [{ provider: 'epay', type: 'wechat' }, 'WeChat'],
      [{ provider: 'stripe', type: 'stripe' }, 'Stripe'],
    ]
    for (const [method, mark] of marks) {
      const html = renderToStaticMarkup(<PaymentMethodIcon method={method} />)
      expect(html, method.type).toContain(`aria-label="${mark}"`)
      expect(html, method.type).not.toContain('circle-help')
    }
  })

  it('draws a neutral card instead of a question mark for channels it has no mark for', () => {
    // A question mark next to where the customer pays reads as something gone wrong.
    const methods: Method[] = [
      { provider: 'epay', type: 'qqpay' },
      { provider: 'epay', type: 'usdt' },
      { provider: 'creem', type: 'creem' },
      { provider: 'waffo', type: 'waffo' },
      { provider: 'waffo-pancake', type: 'waffo_pancake' },
    ]
    for (const method of methods) {
      const html = renderToStaticMarkup(<PaymentMethodIcon method={method} />)
      expect(html, method.type).not.toContain('circle-help')
      expect(html, method.type).not.toContain('其他工具')
      expect(html, method.type).toContain('lucide-credit-card')
    }
  })
})
