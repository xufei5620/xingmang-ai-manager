import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT_CENTER_TABS, AccountCenterPage, AccountKeySecretCell, commerceTabFor, primaryTabFor } from './AccountCenterPage'
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

    expect(markup).toContain('我的账号')
    for (const label of ['我的账号', '用量看板', '密钥', '调用明细', '异步任务', '充值与订阅', '我的订单', '邀请返利', '登录设备']) {
      expect(markup).toContain(label)
    }
    for (const legacyPrimaryLabel of ['账单与权益', '开发者', '设置']) {
      expect(markup).not.toContain(legacyPrimaryLabel)
    }
    expect(markup).not.toContain('xm.solov.cc/wallet')
    expect(markup).not.toContain('feishu')
  })

  it('registers nine complete tabs with a manual activation contract', () => {
    expect(ACCOUNT_CENTER_TABS.map((tab) => tab.id)).toEqual(['overview', 'dashboard', 'keys', 'usage', 'tasks', 'recharge', 'orders', 'invite', 'devices'])
    const markup = renderToStaticMarkup(<AccountCenterPage initialSection="orders" onClose={vi.fn()} onLogout={vi.fn()} />)
    expect(markup).toContain('id="account-tab-orders"')
    expect(markup).toContain('aria-labelledby="account-tab-orders"')
    expect(markup).toContain('aria-controls="account-center-panel"')
    expect(markup).toContain('aria-orientation="horizontal"')
    expect(markup.match(/data-account-tab=/g)).toHaveLength(9)
  })

  it('preserves legacy profile and commerce deep-link destinations', () => {
    expect(primaryTabFor('profile')).toBe('overview')
    expect(primaryTabFor('security')).toBe('overview')
    expect(primaryTabFor('wallet')).toBe('recharge')
    expect(primaryTabFor('subscriptions')).toBe('recharge')
    expect(primaryTabFor('redeem')).toBe('recharge')
    expect(primaryTabFor('orders')).toBe('orders')
    expect(primaryTabFor('invite')).toBe('invite')
    expect(primaryTabFor('devices')).toBe('devices')
    expect(commerceTabFor('wallet')).toBe('subscriptions')
    expect(commerceTabFor('recharge')).toBe('topup')
    expect(commerceTabFor('redeem')).toBe('redeem')
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
