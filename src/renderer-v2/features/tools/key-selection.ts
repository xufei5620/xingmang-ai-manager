import type { AccountKey, AccountKeyOptions, AccountKeysPage, AppConfigSummary, ProviderId, XingmangApi } from '../../../../electron/ipc-contract'
import { managedCliKeyProfiles, retiredAccountGroups, retiredProviderIds } from '../../../../electron/catalog'
import { isMaskedApiKey, maskedApiKeyMessage, normalizePastedApiKey } from '../../../../electron/pasted-api-key'

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

// 下线工具（Gemini CLI）以前星芒替它签的那把。
const retiredManagedKeyNames = new Set<string>(retiredProviderIds.map((provider) => managedCliKeyProfiles[provider].keyName))

function lastUsedAt(key: AccountKey): number {
  const time = key.accessedAt ? Date.parse(key.accessedAt) : Number.NaN
  return Number.isFinite(time) ? time : 0
}

// 同一分组里同名的两把留哪把：正选着的，否则最近用过的，都没用过就留后建的（编号大）。
function preferredTwin(kept: AccountKey, other: AccountKey, selectedKeyId: string): AccountKey {
  if (String(kept.id) === selectedKeyId) return kept
  if (String(other.id) === selectedKeyId) return other
  return (lastUsedAt(other) - lastUsedAt(kept) || other.id - kept.id) > 0 ? other : kept
}

/**
 * 这把密钥的分组账号现在还能不能用（2026-11-19 yoyo 回「改」）。服务端删掉的分组，密钥还留在账号里、还是启用的
 * （8 月 AI 对话签的那批），一检测就是 403「无权访问 … 分组」：new-api 拿密钥调用时核的正是 `/api/user/self/groups`
 * 列的那份（rc.51 middleware/auth.go TokenAuth 与 controller/group.go GetUserGroups 同一个条件，`auto` 也只有列出来才算）。
 * usable 是 null（没读到）时只认 xm 站删掉的老名字，其余照旧当能用，不因此把下拉清空。分组空着的（new-api 走账号自己的
 * 等级分组）不算用不了。历史账号的密钥分组本来就是从它自己的可用分组里认的，认不出的是空的，所以那边等于不筛。
 */
function unusableKeyGroup(group: string, usable: ReadonlySet<string> | null): boolean {
  return Boolean(group) && (retiredAccountGroups.has(group) || (usable !== null && !usable.has(group)))
}

/**
 * 工具配置框的密钥下拉列哪几把（个人中心「密钥」页照旧全列）：
 * - 星芒签的密钥在同一个分组里同名的只列一把，挑最近用过的那把。xm 站改分组本名那几天，老版本星芒在老名字下
 *   又签了一把同名的，服务端删老名字时把它挂回了新名字下，就成了同一分组里两把一样名字的。用户自己建的同名密钥不合并。
 * - 下线工具（Gemini CLI）星芒签的那把不列：星芒不再替它配，选给别的工具也用不了。
 * - 分组账号现在用不了的不列（usableGroups 是 `/api/user/self/groups` 列的那份，见 unusableKeyGroup）。
 * 正选着的那把照旧列着，免得下拉里找不到它。
 */
export function listedAccountKeys(keys: readonly AccountKey[], selectedKeyId: string, usableGroups: readonly string[] | null = null): AccountKey[] {
  const usable = usableGroups ? new Set(usableGroups) : null
  const enabled = keys.filter((key) => key.status === 1)
  const shown = new Map<string, AccountKey>()
  for (const key of enabled) {
    if (!key.name.startsWith('xingmang-')) continue
    const slot = JSON.stringify([key.name, key.group])
    const kept = shown.get(slot)
    shown.set(slot, kept ? preferredTwin(kept, key, selectedKeyId) : key)
  }
  return enabled.filter((key) => {
    if (String(key.id) === selectedKeyId) return true
    if (retiredManagedKeyNames.has(key.name) || unusableKeyGroup(key.group, usable)) return false
    return !key.name.startsWith('xingmang-') || shown.get(JSON.stringify([key.name, key.group])) === key
  })
}

/**
 * Claude Desktop、WorkBuddy、OpenCode 的密钥下拉和登录后替它们自动连时，只在账号现在还能用的分组里挑
 * （见 unusableKeyGroup）。这里打开时就定下默认，没有「正选着的」要留。
 */
export function keysInUsableGroups<T extends Pick<AccountKey, 'group'>>(keys: readonly T[], usableGroups: readonly string[] | null): T[] {
  const usable = usableGroups ? new Set(usableGroups) : null
  return keys.filter((key) => !unusableKeyGroup(key.group, usable))
}

/**
 * 自己填写的密钥在检测前先过一遍格式。只有星芒的密钥确定是 sk- 开头（strict）；历史账号那边的
 * 前缀没核实过，只拦空的，别把能用的密钥挡在外面。夹着的空格、零宽字符先去掉再看，
 * 和主进程检测、保存时去掉的是同一批（J7）。打码的那串两个站都先认出来直说：星芒的正好过得了
 * sk- 开头、20 位以上那道检查，历史账号的不过那道检查，都要等服务端回 401 才知道。
 */
export function manualKeyIssue(secret: string, strict: boolean): string | null {
  const value = normalizePastedApiKey(secret)
  if (!value) return '请粘贴在星芒创建的密钥'
  if (isMaskedApiKey(value)) return maskedApiKeyMessage
  if (strict && (!value.startsWith('sk-') || value.length < 20)) return '密钥格式不正确：应以 sk- 开头，且不少于 20 位'
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
  throw new Error('密钥数量超过 5000 个，请先在密钥管理中整理后重试。')
}
