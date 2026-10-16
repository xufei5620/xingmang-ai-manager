import type { AccountKey, AccountKeyOptions, AccountKeysPage, AppConfigSummary, ProviderId, XingmangApi } from '../../../../electron/ipc-contract'

export const CURRENT_KEY = 'current'
export const AUTOMATIC_KEY = 'automatic'
export type ConfigKeyMetadata = AccountKeyOptions

export function initialKeyChoice(native: AppConfigSummary['providers'][ProviderId]): string {
  // 别的站的 Key（接过别家、换了站登录）不能「保持当前」，默认替用户选好自动准备。
  return native.hasApiKey && native.matchesRelay ? CURRENT_KEY : AUTOMATIC_KEY
}

/**
 * v4 下拉里账号密钥的第二行：掩码在前、分组在后。名字单独占第一行，同名的两把靠这一行分开；
 * 分组认不出就不写，「分组未确认」对用户只是一句看不懂的话。
 */
export function accountKeyDescription(key: Pick<AccountKey, 'group' | 'maskedKey'>): string {
  return [key.maskedKey || '密钥预览未提供', key.group ? `${key.group}分组` : null].filter(Boolean).join('，')
}

/**
 * 自己填写的密钥在检测前先过一遍格式。只有星芒的密钥确定是 sk- 开头（strict）；历史账号那边的
 * 前缀没核实过，只拦空的，别把能用的密钥挡在外面。
 */
export function manualKeyIssue(secret: string, strict: boolean): string | null {
  const value = secret.trim()
  if (!value) return '请粘贴你在星芒创建的密钥'
  if (strict && (!value.startsWith('sk-') || value.length < 20)) return '这不像星芒的密钥：应以 sk- 开头，20 位以上'
  return null
}

/** Names/groups come only from exact main-process matching, never from masked suffixes. */
export function currentKeyLabel(metadata: ConfigKeyMetadata | null, fallbackPreview: string | null): string {
  return ['保持当前', metadata?.current.name || '名称未确认', metadata?.current.group, metadata?.current.preview || fallbackPreview || '密钥预览未提供'].filter(Boolean).join(' · ')
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
