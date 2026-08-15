import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AccountCenterPage, AccountKeySecretCell } from './AccountCenterPage'
import {
  effectiveTopupMinimum,
  parseIntegerTopupAmount,
  subscriptionPaymentOptions,
} from './AccountCommercePanels'
import type { AccountSubscriptionPlan, AccountTopupInfo } from '../../types'

const sharedProps = {
  keyName: 'xingmang-desktop-codex',
  maskedKey: 'sk-abcd**********wxyz',
  copying: false,
  copied: false,
  revealing: false,
  copyDisabled: false,
  revealDisabled: false,
  onCopy: vi.fn(),
  onToggleReveal: vi.fn(),
}

describe('AccountKeySecretCell', () => {
  it('shows only the masked key and the reveal control by default', () => {
    const markup = renderToStaticMarkup(
      <AccountKeySecretCell {...sharedProps} revealedSecret={null} />,
    )

    expect(markup).toContain('sk-abcd**********wxyz')
    expect(markup).toContain('显示 API Key')
    expect(markup).toContain('aria-pressed="false"')
    expect(markup).not.toContain('sk-plaintext-secret')
  })

  it('shows the complete key and the hide control only after reveal succeeds', () => {
    const markup = renderToStaticMarkup(
      <AccountKeySecretCell {...sharedProps} revealedSecret="sk-plaintext-secret" />,
    )

    expect(markup).toContain('sk-plaintext-secret')
    expect(markup).toContain('隐藏 API Key')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).not.toContain('sk-abcd**********wxyz')
  })
})

describe('AccountCenterPage', () => {
  it('renders the complete local account workspace without legacy web-only destinations', () => {
    const markup = renderToStaticMarkup(
      <AccountCenterPage onClose={vi.fn()} onLogout={vi.fn()} />,
    )

    expect(markup).toContain('星芒 AI 账户')
    for (const label of ['概览', '数据看板', 'API 密钥', '使用日志', '任务日志', '钱包', '个人资料']) {
      expect(markup).toContain(label)
    }
    for (const legacyPrimaryLabel of ['账单与权益', '开发者', '设置']) {
      expect(markup).not.toContain(legacyPrimaryLabel)
    }
    expect(markup).not.toContain('xm.solov.cc/wallet')
    expect(markup).not.toContain('feishu')
  })

  it('keeps the top-up amount aligned with the New API int64 contract', () => {
    expect(parseIntegerTopupAmount('10')).toBe(10)
    expect(parseIntegerTopupAmount('10.5')).toBeNull()
    expect(parseIntegerTopupAmount('1e3')).toBe(1000)
    expect(parseIntegerTopupAmount('0')).toBeNull()
  })

  it('enforces the stricter minimum from the selected payment method', () => {
    expect(effectiveTopupMinimum({ minTopup: 1 }, { minTopup: 10 })).toBe(10)
    expect(effectiveTopupMinimum({ minTopup: 20 }, { minTopup: 5 })).toBe(20)
    expect(effectiveTopupMinimum({ minTopup: 1 }, null)).toBe(1)
  })

  it('intersects server-enabled gateways with each subscription plan configuration', () => {
    const plan: AccountSubscriptionPlan = {
      id: 3, title: '月度套餐', subtitle: '', priceAmount: 19.9, currency: 'USD',
      durationUnit: 'month', durationValue: 1, customSeconds: 0,
      allowBalancePay: true, allowWalletOverflow: true, maxPurchasePerUser: 0,
      totalAmount: 1_000_000, upgradeGroup: '', downgradeGroup: '',
      quotaResetPeriod: 'monthly', quotaResetCustomSeconds: 0,
      stripePriceId: 'price_monthly', creemProductId: null,
      waffoPancakeProductId: 'pancake_monthly',
    }
    const topupInfo: AccountTopupInfo = {
      onlineTopupEnabled: true, stripeTopupEnabled: true, creemTopupEnabled: true,
      waffoPancakeTopupEnabled: false, redemptionEnabled: true,
      paymentComplianceConfirmed: true, paymentComplianceTermsVersion: '2026-08',
      paymentMethods: [
        { name: '支付宝', type: 'alipay', provider: 'epay', color: null, icon: null, minTopup: 1 },
        { name: 'Stripe', type: 'stripe', provider: 'stripe', color: null, icon: null, minTopup: 1 },
      ],
      minTopup: 1, amountOptions: [10], discounts: {}, topupLink: null,
    }

    expect(subscriptionPaymentOptions(plan, topupInfo).map((option) => option.id)).toEqual([
      'balance',
      'epay:alipay',
      'stripe',
    ])
    expect(subscriptionPaymentOptions({ ...plan, allowBalancePay: false }, {
      ...topupInfo,
      onlineTopupEnabled: false,
      stripeTopupEnabled: false,
    })).toEqual([])
  })
})
