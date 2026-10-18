// 会话记录页（Codex 会话和各工具会话）的入参。
import type { CodexSessionListQuery } from '../../codex-sessions'
import { isRecord } from '../../input-guards'
import { listedProviderSessionProviders, providerSessionProviders, type ProviderSessionListQuery } from '../../provider-sessions'

export function parseSessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error('会话 ID 格式错误')
  }
  return value
}

export function parseSessionListQuery(value: unknown): CodexSessionListQuery {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('会话查询格式错误')
  }
  const input = value as Record<string, unknown>
  const archive = input.archive
  if (archive !== undefined && archive !== 'all' && archive !== 'active' && archive !== 'archived') {
    throw new Error('会话归档筛选格式错误')
  }
  if (input.search !== undefined) {
    if (typeof input.search !== 'string') throw new Error('会话搜索内容格式错误')
    if (input.search.length > 256) throw new Error('会话搜索内容过长')
  }
  const integer = (entry: unknown, label: string) => {
    if (entry === undefined) return undefined
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1) {
      throw new Error(`${label}格式错误`)
    }
    return entry
  }
  return {
    search: typeof input.search === 'string' ? input.search : undefined,
    archive,
    page: integer(input.page, '页码'),
    pageSize: integer(input.pageSize, '分页大小'),
  }
}

export function parseProviderSessionListQuery(value: unknown): ProviderSessionListQuery {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('会话查询格式错误')
  const provider = value.provider
  if (
    provider !== undefined
    && provider !== 'all'
    && !listedProviderSessionProviders.includes(provider as (typeof providerSessionProviders)[number])
  ) {
    throw new Error('会话工具类型错误')
  }
  if (value.search !== undefined) {
    if (typeof value.search !== 'string') throw new Error('会话搜索内容格式错误')
    if (value.search.length > 256) throw new Error('会话搜索内容过长')
  }
  const integer = (entry: unknown, label: string) => {
    if (entry === undefined) return undefined
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1) {
      throw new Error(`${label}格式错误`)
    }
    return entry
  }
  return {
    provider: provider as ProviderSessionListQuery['provider'],
    search: typeof value.search === 'string' ? value.search : undefined,
    page: integer(value.page, '页码'),
    pageSize: integer(value.pageSize, '分页大小'),
  }
}
