import type { AccountKey, AccountKeyOptions, AccountKeysPage, AppConfigSummary, ProviderId, XingmangApi } from '../../../../electron/ipc-contract'

export const CURRENT_KEY = 'current'
export const AUTOMATIC_KEY = 'automatic'
export type ConfigKeyMetadata = AccountKeyOptions

export function initialKeyChoice(native: AppConfigSummary['providers'][ProviderId]): string {
  return native.hasApiKey ? CURRENT_KEY : AUTOMATIC_KEY
}

export function accountKeyLabel(key: Pick<AccountKey, 'name' | 'group' | 'maskedKey'>): string {
  return `${key.name} · ${key.group || '分组未确认'} · ${key.maskedKey || '密钥预览未提供'}`
}

/** Names/groups come only from exact main-process matching, never from masked suffixes. */
export function currentKeyLabel(metadata: ConfigKeyMetadata | null, fallbackPreview: string | null): string {
  return `保持当前 · ${metadata?.current.name || '名称未确认'} · ${metadata?.current.group || '分组未确认'} · ${metadata?.current.preview || fallbackPreview || '密钥预览未提供'}`
}

export function manualKeyPreview(value: string): string {
  if (!value) return '尚未填写'
  return `${value.startsWith('sk-') ? 'sk-' : ''}••••••••${value.length > 8 ? value.slice(-4) : ''}`
}

export async function readAllAccountKeys(readPage: XingmangApi['getAccountKeys']): Promise<AccountKeysPage> {
  const keys: AccountKey[] = []
  const seen = new Set<number>()
  const pageSize = 100
  for (let page = 1; page <= 50; page++) {
    const result = await readPage({ page, pageSize })
    if (!Number.isSafeInteger(result.total) || result.total < 0 || result.keys.length > pageSize) throw new Error('密钥列表返回异常，请重新读取。')
    for (const key of result.keys) {
      if (!Number.isSafeInteger(key.id) || key.id <= 0 || seen.has(key.id)) throw new Error('密钥列表在读取时发生变化，请重新读取。')
      seen.add(key.id)
      keys.push(key)
    }
    if (keys.length >= result.total) return { page: 1, pageSize: keys.length, total: keys.length, keys }
    if (!result.keys.length) throw new Error('密钥列表未完整返回，请重新读取。')
  }
  throw new Error('密钥超过 5000 把，请先在密钥管理中整理后重试。')
}
