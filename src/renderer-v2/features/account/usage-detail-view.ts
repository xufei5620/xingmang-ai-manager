import type { AccountUsageRecord } from '../../../../electron/ipc-contract'

export const usagePriceFields = [
  ['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读取'],
  ['cacheCreation', '缓存写入'], ['cacheCreation5m', '缓存写入（5 分钟）'], ['cacheCreation1h', '缓存写入（1 小时）'],
  ['imageInput', '图片输入'], ['imageOutput', '图片输出'], ['audioInput', '音频输入'], ['audioOutput', '音频输出'],
] as const

export function usageNumber(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US', { maximumFractionDigits: 3 }) : '未提供'
}

export function usageMoney(value: number | null | undefined, table = false): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未提供'
  if (value !== 0 && Math.abs(value) < 0.00000001) return value < 0 ? '> -$0.00000001' : '< $0.00000001'
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: table ? 6 : 8 })}`
}

export function usageUnitPrice(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未提供'
  if (value > 0 && value < 0.00000001) return '< $0.00000001/M'
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 8 })}/M`
}

export function usageBillingMode(record: AccountUsageRecord): string {
  const mode = record.details.billingMode
  const labels: Record<string, string> = { tiered_expr: '动态计费', token: '按 Token 计费', per_token: '按 Token 计费', per_request: '按次计费', image: '按图片计费' }
  if (mode) return labels[mode] ?? mode
  if (record.details.modelPrice !== null && record.details.modelPrice > 0) return '按次计费'
  return record.details.modelRatio !== null ? '按 Token 计费' : '未提供'
}

export function normalizedUsageTier(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

export function usageTierCondition(condition: { variable: 'input' | 'output' | 'length'; operator: '<' | '<=' | '>' | '>='; value: number }): string {
  const label = { input: '输入', output: '输出', length: '上下文长度' }[condition.variable]
  return `${label} ${condition.operator} ${usageNumber(condition.value)}`
}
