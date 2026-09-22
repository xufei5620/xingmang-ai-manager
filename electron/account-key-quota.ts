import { providerIds, resolveManagedCliKeyProfiles, type ProviderId } from './catalog'
import type { AccountKey, AccountKeyUpdateInput } from './ipc-contract'

// The two account backends record a single key's allowance in different
// units: NewAPI's remain_quota is an internal quota unit (the balance
// endpoint's quotaPerUnit is its ratio to one dollar), while the other
// backend's quota already is the dollar amount. Both conversions live here
// so no caller can forget one multiplication and hand the server a limit
// half a million times larger than the user typed.
export type AccountKeyQuotaSite = 'solov' | 'solov-api'

/** 用户填的金额 → 后端的额度单位;不限额时后端只看 unlimitedQuota,额度填 0。 */
export function accountKeyQuota(amount: number, quotaPerUnit: number, siteId: AccountKeyQuotaSite, unlimited: boolean): number {
  if (unlimited) return 0
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) throw new Error('请填写大于 0 的有效额度。')
  const quota = siteId === 'solov-api' ? amount : Math.round(amount * quotaPerUnit)
  if (!Number.isFinite(quota) || quota <= 0 || quota > Number.MAX_SAFE_INTEGER) throw new Error('额度超出可用范围。')
  return quota
}

/** 后端的额度单位 → 用户看到的金额;后端没给可用数字时返回 null,由界面显示「暂未读到」。 */
export function accountKeyAmount(quota: number | null | undefined, quotaPerUnit: number): number | null {
  if (typeof quota !== 'number' || !Number.isFinite(quota)) return null
  if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) return null
  return quota / quotaPerUnit
}

// The update endpoints replace the whole record, so the expiry has to be
// written back exactly as it was read: -1 is the server's "never expires"
// sentinel and anything else must be a positive whole second. An ISO value
// that will not parse is refused rather than silently turned into -1, which
// would quietly make a time-limited key permanent.
export function accountKeyExpiredTime(expiredAt: string | null): number {
  if (!expiredAt) return -1
  const milliseconds = Date.parse(expiredAt)
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error('这把密钥的到期时间无法识别，请在下方密钥列表里编辑它。')
  return Math.floor(milliseconds / 1000)
}

// 「按工具分账」设的上限不够这一次时 new-api 回 403「token quota is not enough」，
// Sub2API 用完回 429「API key 额度已用完」；与账号余额不足（用户额度不足 / user
// quota）是两回事：后者该去充值，前者是有人特意设的上限。只认「令牌 / token /
// key」这一级的额度字样。new-api 用到 0 之后回的是和 Key 被删一样的 401「无效的
// 令牌」，文本分不出，那一种由调用方去查 Key 列表（见 connection-check 的
// isCappedKeyUsedUp）。
const keyQuotaExhaustedPattern = /令牌额度|密钥额度|key\s*额度|token\s*quota|key\s*quota|tokenstatusexhausted/i

/** 上游报错说的是「这把 Key 自己的额度用完了」，不是 Key 失效，也不是账号没钱。 */
export function isKeyQuotaExhaustedMessage(message: string): boolean {
  return keyQuotaExhaustedPattern.test(message)
}

/**
 * 上限到了就停：签一把新 Key 会悄悄绕过这个上限，所以重签、自动换新都在这里止步，
 * 把话说给用户听。
 */
export const managedKeyQuotaExhaustedMessage = '这个工具的额度用完了，软件不会自动放开。到「账号」页「密钥」里调高这个工具的额度后再试。'

export interface ManagedCliKeyLimit {
  provider: ProviderId
  /** 托管 Key 的固定名称,用来在账号的密钥列表里认出这把 Key。 */
  keyName: string
  group: string
  /** 账号里还没有这把 Key 时为 null——用户没配过这个工具。 */
  key: AccountKey | null
  unlimited: boolean
  /** 上限剩下多少(金额);不限额或后端没给数字时为 null。 */
  remaining: number | null
  /** 这把 Key 已经用掉多少(金额);后端没给数字时为 null。 */
  used: number | null
}

// The key the main process marked as the one this tool is using right now
// (managedProvider: issued by this app AND still in the tool's config) wins:
// a same-named older key would otherwise show, and take, the wrong limit.
// Without that mark, a user can also create a key by hand with the same name,
// or move the managed one to another group. Prefer the one whose group matches
// what this program provisions; otherwise take the oldest id, so two refreshes
// of the same list never resolve to two different keys.
function pickManagedKey(keys: readonly AccountKey[], provider: ProviderId, keyName: string, group: string): AccountKey | null {
  const inUse = keys.find((key) => key.managedProvider === provider)
  if (inUse) return inUse
  const matches = keys.filter((key) => key.name === keyName).sort((left, right) => left.id - right.id)
  return matches.find((key) => key.group === group) ?? matches[0] ?? null
}

export function resolveManagedCliKeyLimits(
  keys: readonly AccountKey[],
  quotaPerUnit: number,
  siteId: AccountKeyQuotaSite,
): ManagedCliKeyLimit[] {
  const profiles = resolveManagedCliKeyProfiles(siteId)
  return providerIds.map((provider) => {
    const profile = profiles[provider]
    const key = pickManagedKey(keys, provider, profile.keyName, profile.group)
    return {
      provider,
      keyName: profile.keyName,
      group: key?.group || profile.group,
      key,
      unlimited: key ? key.unlimitedQuota : true,
      remaining: key && !key.unlimitedQuota ? accountKeyAmount(key.remainQuota, quotaPerUnit) : null,
      used: key ? accountKeyAmount(key.usedQuota, quotaPerUnit) : null,
    }
  })
}

/** 解析用户填的上限:留空 = 不限额。 */
export function parseManagedCliKeyLimitAmount(value: string): number | null {
  const text = value.trim()
  if (!text) return null
  const amount = Number(text)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('请填写大于 0 的上限金额，留空表示不限额。')
  return amount
}

/**
 * 把「这个工具还能再用多少」翻成一次更新调用的入参。两个后端拿到的都是
 * 剩余额度:NewAPI 的 remain_quota 本身就是剩余,另一个后端的适配层会把
 * 已用量加回去再写总额,所以这里不需要区分。
 */
export function buildManagedCliKeyLimitUpdate(
  limit: ManagedCliKeyLimit,
  amount: number | null,
  quotaPerUnit: number,
  siteId: AccountKeyQuotaSite,
): AccountKeyUpdateInput {
  const key = limit.key
  if (!key) throw new Error('这个工具还没有对应的密钥，先在首页配置一次这个工具就会自动签发。')
  const unlimited = amount === null
  return {
    id: key.id,
    name: key.name,
    group: limit.group,
    remainQuota: accountKeyQuota(unlimited ? 0 : amount, quotaPerUnit, siteId, unlimited),
    unlimitedQuota: unlimited,
    expiredTime: accountKeyExpiredTime(key.expiredAt),
  }
}

const managedKeyPageSize = 100
// 五页是安全阀而不是预期值:托管 Key 只有四把,真到第五页仍没认全,说明
// 这个账号的密钥多到该自己去密钥列表里找,不值得再翻下去。
const managedKeyPageLimit = 5

/** 托管 Key 可能落在任意一页,按页拉到翻完或到上限为止,只留下认得出的那几把。 */
export async function loadManagedCliKeys(
  load: (page: number, pageSize: number) => Promise<{ total: number; keys: AccountKey[] }>,
  siteId: AccountKeyQuotaSite,
): Promise<AccountKey[]> {
  const profiles = resolveManagedCliKeyProfiles(siteId)
  const names = new Set(providerIds.map((provider) => profiles[provider].keyName))
  const found: AccountKey[] = []
  for (let page = 1; page <= managedKeyPageLimit; page++) {
    const batch = await load(page, managedKeyPageSize)
    for (const key of batch.keys) {
      if (names.has(key.name) || key.managedProvider) found.push(key)
    }
    if (!batch.keys.length || page * managedKeyPageSize >= batch.total) break
  }
  return found
}
