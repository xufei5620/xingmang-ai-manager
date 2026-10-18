// 充值、订单、邀请额度和订阅支付的入参。
import { isRecord } from '../../input-guards'
import type {
  NewApiAffiliateTransferInput,
  NewApiBillingPreference,
  NewApiSubscriptionPaymentInput,
  NewApiTopupAmountInput,
  NewApiTopupOrdersQuery,
  NewApiTopupPaymentInput,
} from '../../new-api-client'
import { optionalString, requiredString } from './common'

export function parsePositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label}格式错误`)
  }
  return value
}

export function parseAccountTopupAmountInput(value: unknown): NewApiTopupAmountInput {
  if (!isRecord(value)) throw new Error('充值金额信息格式错误')
  return { amount: parsePositiveSafeInteger(value.amount, '充值数量') }
}

export function parseAccountTopupPaymentInput(value: unknown): NewApiTopupPaymentInput {
  if (!isRecord(value)) throw new Error('充值支付信息格式错误')
  if (Object.keys(value).some((key) => key !== 'amount' && key !== 'paymentMethod')) {
    throw new Error('充值支付信息包含未知字段')
  }
  return {
    ...parseAccountTopupAmountInput(value),
    paymentMethod: requiredString(value.paymentMethod, '支付方式', 64),
  }
}

export function parseAccountTopupOrdersQuery(value: unknown): NewApiTopupOrdersQuery {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('订单查询参数格式错误')
  const page = value.page
  if (page !== undefined && (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 1_000_000)) {
    throw new Error('订单页码格式错误')
  }
  const pageSize = value.pageSize
  if (pageSize !== undefined && (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)) {
    throw new Error('订单分页大小格式错误')
  }
  return {
    page: page as number | undefined,
    pageSize: pageSize as number | undefined,
    keyword: optionalString(value.keyword, '订单搜索词', 128),
  }
}

export function parseAccountAffiliateTransferInput(value: unknown): NewApiAffiliateTransferInput {
  if (!isRecord(value)) throw new Error('邀请额度转余额信息格式错误')
  return { quota: parsePositiveSafeInteger(value.quota, '邀请额度') }
}

const accountBillingPreferences = new Set<NewApiBillingPreference>([
  'subscription_first',
  'wallet_first',
  'subscription_only',
  'wallet_only',
])

export function parseAccountBillingPreference(value: unknown): NewApiBillingPreference {
  if (typeof value !== 'string' || !accountBillingPreferences.has(value as NewApiBillingPreference)) {
    throw new Error('订阅扣费顺序格式错误')
  }
  return value as NewApiBillingPreference
}

export function parseAccountSubscriptionPaymentInput(value: unknown): NewApiSubscriptionPaymentInput {
  if (!isRecord(value)) throw new Error('订阅支付信息格式错误')
  if (Object.keys(value).some((key) => !['planId', 'provider', 'paymentMethod'].includes(key))) {
    throw new Error('订阅支付信息包含未知字段')
  }
  const provider = value.provider
  if (provider !== 'epay' && provider !== 'stripe' && provider !== 'creem' && provider !== 'waffo-pancake') {
    throw new Error('订阅支付渠道格式错误')
  }
  const paymentMethod = optionalString(value.paymentMethod, '订阅支付方式', 64)
  if (provider === 'epay' && !paymentMethod) throw new Error('订阅支付方式不能为空')
  if (provider !== 'epay' && paymentMethod !== undefined) throw new Error('当前订阅支付渠道不接受支付方式参数')
  return { planId: parsePositiveSafeInteger(value.planId, '订阅方案 ID'), provider, paymentMethod }
}
