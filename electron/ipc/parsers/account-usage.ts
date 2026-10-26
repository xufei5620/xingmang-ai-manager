// 用量明细、数据看板和任务记录查询的入参。
import { isRecord } from '../../input-guards'
import type { NewApiAccountDashboardQuery, NewApiAccountTaskQuery, NewApiAccountUsageQuery } from '../../new-api-client'
import { usageDateRange } from '../../usage-date-range'

const accountUsageQueryFields = new Set([
  'page', 'pageSize', 'type', 'startTimestamp', 'endTimestamp',
  'modelName', 'tokenName', 'group', 'requestId', 'upstreamRequestId',
  'startDate', 'endDate', 'timezone', 'apiKeyId', 'groupId', 'billingType', 'statsOnly',
])
const accountUsageLogTypes = new Set([0, 1, 2, 3, 4, 5, 6, 7])

export function parseOptionalAccountUsageText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${label}格式错误`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`)
  return trimmed || undefined
}

export function parseAccountUsageQuery(value: unknown): NewApiAccountUsageQuery {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('用量查询参数格式错误')
  if (Object.keys(value).some((key) => !accountUsageQueryFields.has(key))) {
    throw new Error('用量查询参数包含未知字段')
  }
  const page = value.page
  if (page !== undefined && (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 1_000_000)) {
    throw new Error('页码格式错误')
  }
  const pageSize = value.pageSize
  if (pageSize !== undefined && (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)) {
    throw new Error('分页大小格式错误')
  }
  const type = value.type
  if (type !== undefined && (typeof type !== 'number' || !Number.isInteger(type) || !accountUsageLogTypes.has(type))) {
    throw new Error('日志类型格式错误')
  }
  const startTimestamp = value.startTimestamp
  const endTimestamp = value.endTimestamp
  for (const [timestamp, label] of [[startTimestamp, '开始时间'], [endTimestamp, '结束时间']] as const) {
    if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 32_503_680_000)) {
      throw new Error(`${label}格式错误`)
    }
  }
  if (typeof startTimestamp === 'number' && typeof endTimestamp === 'number' && startTimestamp > endTimestamp) {
    throw new Error('开始时间不能晚于结束时间')
  }
  const hasDates = ['startDate', 'endDate', 'timezone'].some((key) => value[key] !== undefined)
  if (hasDates && (startTimestamp !== undefined || endTimestamp !== undefined)) throw new Error('日期筛选不能与精确时间混用')
  const dates = hasDates ? usageDateRange({
    startDate: parseOptionalAccountUsageText(value.startDate, '开始日期', 10),
    endDate: parseOptionalAccountUsageText(value.endDate, '结束日期', 10),
    timezone: parseOptionalAccountUsageText(value.timezone, '时区', 128),
  }) : {}
  for (const [id, label] of [[value.apiKeyId, 'Key ID'], [value.groupId, '分组 ID']] as const) {
    if (id !== undefined && (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) throw new Error(`${label}格式错误`)
  }
  if (value.billingType !== undefined && value.billingType !== 0 && value.billingType !== 1) throw new Error('计费来源格式错误')
  if (value.statsOnly !== undefined && typeof value.statsOnly !== 'boolean') throw new Error('用量查询参数格式错误')
  return {
    ...dates,
    apiKeyId: value.apiKeyId as number | undefined,
    groupId: value.groupId as number | undefined,
    billingType: value.billingType as 0 | 1 | undefined,
    page: page as number | undefined,
    pageSize: pageSize as number | undefined,
    type: type as number | undefined,
    startTimestamp: startTimestamp as number | undefined,
    endTimestamp: endTimestamp as number | undefined,
    modelName: parseOptionalAccountUsageText(value.modelName, '模型名称', 128),
    tokenName: parseOptionalAccountUsageText(value.tokenName, '令牌名称', 128),
    group: parseOptionalAccountUsageText(value.group, '分组名称', 128),
    requestId: parseOptionalAccountUsageText(value.requestId, '请求 ID', 128),
    upstreamRequestId: parseOptionalAccountUsageText(value.upstreamRequestId, '上游请求 ID', 256),
    // false 也不往下传：历史账号那边见到不认识的字段就整个拒掉。
    statsOnly: value.statsOnly === true ? true : undefined,
  }
}

export function parseAccountDashboardQuery(value: unknown): NewApiAccountDashboardQuery {
  if (!isRecord(value)) throw new Error('数据看板查询参数格式错误')
  if (Object.keys(value).some((key) => key !== 'startTimestamp' && key !== 'endTimestamp')) {
    throw new Error('数据看板查询参数包含未知字段')
  }
  const startTimestamp = value.startTimestamp
  const endTimestamp = value.endTimestamp
  for (const [timestamp, label] of [[startTimestamp, '开始时间'], [endTimestamp, '结束时间']] as const) {
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > 32_503_680_000) {
      throw new Error(`${label}格式错误`)
    }
  }
  if ((startTimestamp as number) > (endTimestamp as number)) throw new Error('开始时间不能晚于结束时间')
  if ((endTimestamp as number) - (startTimestamp as number) > 2_592_000) {
    throw new Error('数据看板时间跨度不能超过 30 天')
  }
  return { startTimestamp: startTimestamp as number, endTimestamp: endTimestamp as number }
}

const accountTaskQueryFields = new Set([
  'page', 'pageSize', 'platform', 'taskId', 'status', 'action', 'startTimestamp', 'endTimestamp',
])
const accountTaskStatuses = new Set([
  'NOT_START', 'SUBMITTED', 'QUEUED', 'IN_PROGRESS', 'FAILURE', 'SUCCESS', 'UNKNOWN',
])

export function parseAccountTaskQuery(value: unknown): NewApiAccountTaskQuery {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('任务查询参数格式错误')
  if (Object.keys(value).some((key) => !accountTaskQueryFields.has(key))) {
    throw new Error('任务查询参数包含未知字段')
  }
  const page = value.page
  if (page !== undefined && (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 1_000_000)) {
    throw new Error('页码格式错误')
  }
  const pageSize = value.pageSize
  if (pageSize !== undefined && (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)) {
    throw new Error('分页大小格式错误')
  }
  const startTimestamp = value.startTimestamp
  const endTimestamp = value.endTimestamp
  for (const [timestamp, label] of [[startTimestamp, '开始时间'], [endTimestamp, '结束时间']] as const) {
    if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 32_503_680_000)) {
      throw new Error(`${label}格式错误`)
    }
  }
  if (typeof startTimestamp === 'number' && typeof endTimestamp === 'number' && startTimestamp > endTimestamp) {
    throw new Error('开始时间不能晚于结束时间')
  }
  const status = parseOptionalAccountUsageText(value.status, '任务状态', 32)
  if (status && !accountTaskStatuses.has(status)) throw new Error('任务状态格式错误')
  return {
    page: page as number | undefined,
    pageSize: pageSize as number | undefined,
    platform: parseOptionalAccountUsageText(value.platform, '任务平台', 64),
    taskId: parseOptionalAccountUsageText(value.taskId, '任务 ID', 256),
    status,
    action: parseOptionalAccountUsageText(value.action, '任务动作', 64),
    startTimestamp: startTimestamp as number | undefined,
    endTimestamp: endTimestamp as number | undefined,
  }
}
