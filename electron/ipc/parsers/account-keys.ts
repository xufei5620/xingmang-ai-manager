// 账号密钥的查询、新建、修改、删除，以及把密钥写进工具配置的入参。
import { activeProviderIds, isActiveProviderId, isProviderId, isRetiredProviderId } from '../../catalog'
import { isRecord } from '../../input-guards'
import type {
  AccountKeyCliConfigurationInput,
  AccountKeyCreateInput,
  AccountKeyUpdateInput,
  AccountManagedCliConfigurationInput,
} from '../../ipc-contract'
import type { NewApiAccountKeysQuery } from '../../new-api-client'
import { parseOptionalAccountUsageText } from './account-usage'
import { requiredString } from './common'

// account:list-keys' input. Same GetPageQuery-backed pagination family and
// the same bounds as parseAccountUsageQuery in account-usage.ts (common/page_info.go's
// clamp to 100 regardless of what is sent).
export function parseAccountKeysQuery(value: unknown): NewApiAccountKeysQuery {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('密钥查询参数格式错误')
  const page = value.page
  if (page !== undefined && (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 1_000_000)) {
    throw new Error('页码格式错误')
  }
  const pageSize = value.pageSize
  if (pageSize !== undefined && (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)) {
    throw new Error('分页大小格式错误')
  }
  return {
    page: page as number | undefined,
    pageSize: pageSize as number | undefined,
    keyword: parseOptionalAccountUsageText(value.keyword, '搜索词', 64),
  }
}

// account:revoke-key's sole argument. A destructive, id-addressed operation
// that lands directly in a URL path segment (new-api-client.ts's
// tokenIdPath) -- must be a genuine positive integer before it gets
// anywhere near that, same "reject anything that isn't obviously a real id"
// posture as parseSessionId's UUID regex in sessions.ts (I5, path-traversal-shaped
// defense even though the value here is numeric, not a path string).
export function parseAccountRevokeKeyId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error('密钥 ID 格式错误')
  }
  return value
}

export function parseManagedCliConfigurationInput(value: unknown): AccountManagedCliConfigurationInput {
  if (!isRecord(value) || !Array.isArray(value.providers) || value.providers.length > activeProviderIds.length) {
    throw new Error('CLI 配置目标格式错误')
  }
  const providers = value.providers.map((provider) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    return provider
  })
  if (new Set(providers).size !== providers.length) throw new Error('CLI 配置目标不能重复')
  if (value.preferredModels !== undefined && !isRecord(value.preferredModels)) {
    throw new Error('CLI 首选模型格式错误')
  }
  const preferredModels: AccountManagedCliConfigurationInput['preferredModels'] = {}
  for (const [provider, model] of Object.entries(value.preferredModels ?? {})) {
    if (!isProviderId(provider)) throw new Error('CLI 首选模型包含未知类型')
    // 下线的工具（Gemini CLI）不再写配置，渲染层老状态里残留的那一格直接略过。
    if (isRetiredProviderId(provider)) continue
    // Renderer state may contain an optional provider slot with an undefined
    // model. Treat that as absent; null and other non-string values remain
    // malformed input and are rejected below.
    if (model === undefined) continue
    preferredModels[provider] = requiredString(model, 'CLI 首选模型', 512)
  }
  if (value.mode !== undefined && value.mode !== 'merge' && value.mode !== 'reset') {
    throw new Error('未知的配置写入模式')
  }
  if (value.intent !== undefined && value.intent !== 'automatic' && value.intent !== 'explicit') throw new Error('CLI 配置意图无效')
  if (value.intent === 'explicit' && providers.length !== 1) throw new Error('请逐个确认需要替换的工具配置')
  if (value.keepKeys !== undefined && !Array.isArray(value.keepKeys)) throw new Error('CLI 配置目标格式错误')
  const keepKeys = (value.keepKeys ?? []).map((provider) => {
    if (!isActiveProviderId(provider) || !providers.includes(provider)) throw new Error('沿用现有密钥的工具不在这次的配置目标里')
    return provider
  })
  if (new Set(keepKeys).size !== keepKeys.length) throw new Error('CLI 配置目标不能重复')
  // 点名重写是客户要换成自动那把，和「沿用现有密钥」相反，一起来说明渲染层算错了。
  if (value.intent === 'explicit' && keepKeys.length) throw new Error('CLI 配置意图无效')
  return {
    providers,
    preferredModels,
    ...(value.mode === undefined ? {} : { mode: value.mode }),
    ...(value.intent === undefined ? {} : { intent: value.intent }),
    ...(keepKeys.length ? { keepKeys } : {}),
  }
}

// account:create-key 的入参。50 是 new-api AddToken/UpdateToken 的服务端
// 名称上限(rc.24 controller/token.go);expiredTime -1 = 永不过期哨兵。
export function parseAccountKeyCreateInput(value: unknown, sub2Api = false): AccountKeyCreateInput {
  if (!isRecord(value)) throw new Error('密钥信息格式错误')
  const name = requiredString(value.name, '密钥名称', sub2Api ? 100 : 50)
  if (typeof value.unlimitedQuota !== 'boolean') throw new Error('额度类型格式错误')
  if (
    typeof value.remainQuota !== 'number'
    || !(sub2Api ? Number.isFinite(value.remainQuota) : Number.isInteger(value.remainQuota))
    || value.remainQuota < 0
    || (sub2Api && !value.unlimitedQuota && value.remainQuota === 0)
    || value.remainQuota > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('额度格式错误')
  }
  if (
    typeof value.expiredTime !== 'number'
    || !Number.isInteger(value.expiredTime)
    || (value.expiredTime !== -1 && value.expiredTime <= 0)
  ) {
    throw new Error('过期时间格式错误')
  }
  return {
    name,
    group: requiredString(value.group, '密钥分组', 128),
    remainQuota: value.remainQuota,
    unlimitedQuota: value.unlimitedQuota,
    expiredTime: value.expiredTime,
  }
}

export function parseAccountKeyUpdateInput(value: unknown, sub2Api = false): AccountKeyUpdateInput {
  if (!isRecord(value)) throw new Error('密钥信息格式错误')
  return {
    ...parseAccountKeyCreateInput(value, sub2Api),
    id: parseAccountRevokeKeyId(value.id),
  }
}

export function parseAccountKeyCliConfigurationInput(value: unknown): AccountKeyCliConfigurationInput {
  if (!isRecord(value)) throw new Error('账号密钥配置信息格式错误')
  if (!isActiveProviderId(value.provider)) throw new Error('未知的 CLI 类型')
  const mode = value.mode
  if (mode !== 'merge' && mode !== 'reset') throw new Error('未知的配置写入模式')
  return {
    provider: value.provider,
    keyId: parseAccountRevokeKeyId(value.keyId),
    model: requiredString(value.model, '模型名称', 512),
    mode,
  }
}
