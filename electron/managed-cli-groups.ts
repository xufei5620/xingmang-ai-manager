import {
  activeProviderIds,
  managedCliKeyProfiles,
  providerIds,
  resolveManagedCliKeyProfiles,
  sub2ApiManagedCliKeyProfiles,
  type ActiveProviderId,
  type ProviderId,
} from './catalog'

export interface ManagedCliGroupCandidate {
  name: string
  /** 分组背后接的是哪家上游。只有「历史账号」那套后端（Sub2API）会给，新站没有。 */
  platform?: string
}

/** subscription: 账号买了这家工具的订阅，Key 要放进订阅分组才扣订阅额度；
 *  mapped: 服务状态文件里的分组对照写明了用哪个（站上改了本名也跟得上）；
 *  preferred: 服务端就有这个名字；alias: 命中另一套已知名单；
 *  detected: 靠工具专属词认出来的；fallback: 没认出来，退回写死名单。 */
export type ManagedCliGroupSource = 'subscription' | 'mapped' | 'preferred' | 'alias' | 'detected' | 'fallback'

/**
 * 分组对照里的几样用途：三家在用的命令行工具，加上画图。下线的工具不在里面——星芒不再替它签 Key。
 */
export type AccountGroupRole = ActiveProviderId | 'image'

export const accountGroupRoles: readonly AccountGroupRole[] = [...activeProviderIds, 'image']

/**
 * 发布者在服务状态文件里写的分组对照（`service-status.ts` 的 accountGroups）：每样用途按先后
 * 列几个候选名字，这个账号在站上能用哪个就用排在前面的那个。只管星芒账号（xm 站）。
 *
 * 为什么要它：new-api 的分组没有编号，Key、可用分组接口、倍率配置全按名字认，站上改一次本名，
 * 写死在客户端里的名字就对不上了。对照放在更新目录上，改名那天发布者改这一份就行，不用等发版。
 */
export type AccountGroupHints = Partial<Record<AccountGroupRole, readonly string[]>>

export interface ResolvedManagedCliGroup {
  group: string
  source: ManagedCliGroupSource
}

// Only tokens that belong to exactly one CLI vendor. These exist so that a
// group renamed on the account backend can still be recognised: an exact
// name match is always preferred, and these patterns only run once it fails.
const providerGroupPatterns: Record<ProviderId, readonly RegExp[]> = {
  claude: [/claude/i],
  codex: [/codex/i, /gpt/i, /openai/i],
  gemini: [/gemini/i],
  grok: [/grok/i],
}

// 不属于任何一家 CLI 的公共分组。不排掉的话「默认」会被四家一起认领，
// 生图/视频分组也会被 GPT-image 这类名字带进 codex。
const sharedGroupPatterns: readonly RegExp[] = [
  /^default$/i,
  /^默认/,
  /图片|生图|image/i,
  /视频|video/i,
  /音频|语音|audio|tts/i,
  /嵌入|embed/i,
  /rerank/i,
]

// Sub2API tags every group with the upstream it routes to. That tag is set by
// whoever configured the group, not typed into its display name, so it still
// holds after a rename to something like 「MAX 专线」 that carries no vendor
// token at all. Only the four platforms that map onto our CLIs are listed;
// everything else (antigravity, composite, kimi, ...) says nothing either way.
const providerPlatforms: Record<ProviderId, readonly string[]> = {
  claude: ['anthropic'],
  codex: ['openai'],
  gemini: ['gemini'],
  grok: ['grok'],
}

const maximumGroupNameLength = 128
const maximumPlatformLength = 64

/** The same bounded name may be returned by the backend and stored for offline key reuse. */
export function isManagedCliGroupName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumGroupNameLength
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}

interface NormalizedGroup {
  name: string
  platform?: string
}

function knownGroupAliases(provider: ProviderId, preferred: string): string[] {
  return [managedCliKeyProfiles[provider].group, sub2ApiManagedCliKeyProfiles[provider].group]
    .filter((name) => name !== preferred)
}

function isSharedGroup(name: string): boolean {
  return sharedGroupPatterns.some((pattern) => pattern.test(name))
}

function matchesProvider(provider: ProviderId, name: string): boolean {
  return providerGroupPatterns[provider].some((pattern) => pattern.test(name))
}

// A name that looks like two vendors at once carries no usable attribution.
// Claiming it would silently bill a CLI against the wrong group, which is
// far harder to notice than an outright "group unavailable" error.
function matchesOnlyProvider(provider: ProviderId, name: string): boolean {
  if (!matchesProvider(provider, name)) return false
  return providerIds.every((other) => other === provider || !matchesProvider(other, name))
}

/** 服务端返回的分组名去空白、去重，丢掉空值、超长与带控制字符的。这份名字会原样
 *  进建 Key 的请求体和面向用户的错误文案，所以按敌意输入对待（I5），
 *  口径与 `xingmang-ai-skill.ts` 对分组名的校验保持一致。 */
export function normalizeGroupNames(groups: readonly ManagedCliGroupCandidate[]): string[] {
  return normalizeGroups(groups).map((group) => group.name)
}

function normalizeGroups(groups: readonly ManagedCliGroupCandidate[]): NormalizedGroup[] {
  const seen = new Set<string>()
  const normalized: NormalizedGroup[] = []
  for (const group of groups) {
    const name = typeof group?.name === 'string' ? group.name.trim() : ''
    if (!isManagedCliGroupName(name) || seen.has(name)) continue
    seen.add(name)
    const platform = typeof group.platform === 'string' ? group.platform.trim().toLowerCase() : ''
    normalized.push(platform && platform.length <= maximumPlatformLength ? { name, platform } : { name })
  }
  return normalized
}

/**
 * 对照里这样用途排在最前、这个账号此刻又真能用的那个分组；对照没写或一个都不在可用分组里时返回 null，
 * 调用方照旧自己认。只在服务端给出的可用分组里挑，所以对照写错、被改坏，最多是换到这个账号
 * 本来就能选的另一个分组，用不上任何它本来用不了的分组。
 */
export function resolveMappedGroup(
  role: AccountGroupRole,
  groups: readonly ManagedCliGroupCandidate[],
  hints: AccountGroupHints | null | undefined,
): string | null {
  const candidates = hints?.[role]
  if (!candidates?.length) return null
  const names = new Set(normalizeGroupNames(groups))
  return candidates.find((name) => names.has(name)) ?? null
}

function isAccountGroupRole(value: string): value is AccountGroupRole {
  return (accountGroupRoles as readonly string[]).includes(value)
}

function platformOwner(platform: string | undefined): ProviderId | null {
  if (!platform) return null
  return providerIds.find((provider) => providerPlatforms[provider].includes(platform)) ?? null
}

/**
 * 从服务端实际可用的分组里挑出这家 CLI 该用的那个。五档从准到松：
 * 分组对照写明的（只有星芒账号）→ 名单里的名字还在 → 另一套已知名单里的名字 →
 * 认出来（先看分组接的是哪家上游，再看名字里的工具专属词，都要唯一）→ 退回名单。
 * 认不出或认到多个一律退回名单，让后续校验报「分组不可用」，不猜。
 */
export function resolveManagedCliGroup(
  provider: ProviderId,
  groups: readonly ManagedCliGroupCandidate[],
  siteId?: string,
  subscribedGroups: readonly string[] = [],
  hints?: AccountGroupHints | null,
): ResolvedManagedCliGroup {
  const preferred = resolveManagedCliKeyProfiles(siteId)[provider].group
  const normalized = normalizeGroups(groups)
  const names = normalized.map((group) => group.name)
  if (names.length === 0) return { group: preferred, source: 'fallback' }
  const subscription = subscribedGroupFor(provider, normalized, subscribedGroups)
  if (subscription) return { group: subscription, source: 'subscription' }
  // 对照只写给星芒账号：历史账号那套后端的分组名字是另一份，认法也不同。
  const mapped = siteId !== 'solov-api' && isAccountGroupRole(provider)
    ? resolveMappedGroup(provider, normalized, hints)
    : null
  if (mapped) return { group: mapped, source: 'mapped' }
  if (names.includes(preferred)) return { group: preferred, source: 'preferred' }
  for (const alias of knownGroupAliases(provider, preferred)) {
    if (names.includes(alias)) return { group: alias, source: 'alias' }
  }
  // A group the backend says routes to another CLI's upstream is never ours,
  // whatever its name says; an unknown or missing platform decides nothing.
  const eligible = normalized.filter((group) => {
    const owner = platformOwner(group.platform)
    return !isSharedGroup(group.name) && (owner === null || owner === provider)
  })
  const byPlatform = eligible.filter((group) => platformOwner(group.platform) === provider)
  if (byPlatform.length === 1) return { group: byPlatform[0].name, source: 'detected' }
  // Several groups on the right upstream (a MAX tier and a Pro tier, say) are
  // only told apart by name; with none, the name is all there is to go on.
  const pool = byPlatform.length > 1 ? byPlatform : eligible
  const detected = pool.filter((group) => matchesOnlyProvider(provider, group.name))
  if (detected.length === 1) return { group: detected[0].name, source: 'detected' }
  return { group: preferred, source: 'fallback' }
}

/**
 * 历史账号的订阅绑在一个分组上：只有放在那个分组里的 Key 才扣订阅额度，放在别的
 * 分组里照旧扣余额。所以买了某家工具的订阅，这家工具的 Key 就该换进订阅分组。
 * 认法与下面认普通分组同一套（先看分组接的上游，再看名字里的工具专属词），但只在
 * 「这个账号有生效订阅、且服务端此刻仍允许用」的分组里挑，认到多个就不挑——猜错了
 * 是把钱扣到用户没想用的地方。
 */
function subscribedGroupFor(
  provider: ProviderId,
  normalized: readonly NormalizedGroup[],
  subscribedGroups: readonly string[],
): string | null {
  if (subscribedGroups.length === 0) return null
  const subscribed = new Set(subscribedGroups)
  const candidates = normalized.filter((group) => subscribed.has(group.name) && !isSharedGroup(group.name))
  const byPlatform = candidates.filter((group) => platformOwner(group.platform) === provider)
  if (byPlatform.length === 1) return byPlatform[0].name
  const pool = byPlatform.length > 1
    ? byPlatform
    : candidates.filter((group) => platformOwner(group.platform) === null)
  const detected = pool.filter((group) => matchesOnlyProvider(provider, group.name))
  return detected.length === 1 ? detected[0].name : null
}

export function resolveManagedCliGroups(
  groups: readonly ManagedCliGroupCandidate[],
  siteId?: string,
  subscribedGroups: readonly string[] = [],
  hints?: AccountGroupHints | null,
): Record<ProviderId, ResolvedManagedCliGroup> {
  return Object.fromEntries(
    providerIds.map((provider) => [provider, resolveManagedCliGroup(provider, groups, siteId, subscribedGroups, hints)]),
  ) as Record<ProviderId, ResolvedManagedCliGroup>
}

/**
 * AI 对话没选过分组时默认用 Codex 那把 Key 的分组（渲染层 chat/state.ts 的 DEFAULT_CHAT_GROUP 是它的
 * 出厂名字）。这里按签 Key 的同一套认法把它标出来：站上改了本名、对照写上新名字以后，对话也落在
 * 对的分组上，不会掉到排在第一个、没接渠道的 default 里。只标星芒账号的，认不出（fallback）不标，
 * 渲染层照旧按写死的名字找。
 */
export function markRecommendedChatGroup<T extends ManagedCliGroupCandidate>(
  groups: readonly T[],
  siteId: string | undefined,
  hints: AccountGroupHints | null,
): Array<T & { recommended?: true }> {
  if (siteId === 'solov-api') return [...groups]
  const resolved = resolveManagedCliGroup('codex', groups, siteId, [], hints)
  if (resolved.source === 'fallback') return [...groups]
  return groups.map((group) => group.name === resolved.group ? { ...group, recommended: true as const } : group)
}

interface ManagedCliSubscriptionSnapshot {
  activeSubscriptions: ReadonlyArray<{ status: string; groupName?: string; endsAt?: string }>
}

export interface ManagedCliGroupAccountService {
  listUsableGroups?: () => Promise<ManagedCliGroupCandidate[]>
  getActiveSiteId?: () => string
  getSubscriptionSelf?: () => Promise<ManagedCliSubscriptionSnapshot>
  /** 服务状态文件里的分组对照；没有、读不到都给 null。缺省 = 不看对照。 */
  getAccountGroupHints?: () => Promise<AccountGroupHints | null>
}

/** 读分组对照。读不到不算失败：对照只是让认法更准，没有它照旧按名单和工具专属词认。 */
export async function loadAccountGroupHints(
  accountService: Pick<ManagedCliGroupAccountService, 'getAccountGroupHints' | 'getActiveSiteId'>,
): Promise<AccountGroupHints | null> {
  if (accountService.getActiveSiteId?.() === 'solov-api' || typeof accountService.getAccountGroupHints !== 'function') return null
  try {
    return await accountService.getAccountGroupHints()
  } catch {
    return null
  }
}

/** 订阅会不会决定 Key 该放哪个分组。星芒账号的订阅不看分组、哪把 Key 都先扣订阅，只有历史账号要换。 */
export function subscriptionsBindKeyGroups(accountService: ManagedCliGroupAccountService): boolean {
  return accountService.getActiveSiteId?.() === 'solov-api' && typeof accountService.getSubscriptionSelf === 'function'
}

export function activeSubscriptionGroupNames(snapshot: ManagedCliSubscriptionSnapshot, now = Date.now()): string[] {
  if (!snapshot || !Array.isArray(snapshot.activeSubscriptions)) throw new Error('当前订阅响应格式异常')
  return normalizeGroupNames(snapshot.activeSubscriptions.flatMap((subscription) => {
    if (subscription?.status !== 'active' || typeof subscription.groupName !== 'string') return []
    // 状态还没来得及翻成到期、时间已经过了的，不再往里放 Key。
    const endsAt = typeof subscription.endsAt === 'string' ? Date.parse(subscription.endsAt) : Number.NaN
    return Number.isFinite(endsAt) && endsAt <= now ? [] : [{ name: subscription.groupName }]
  }))
}

/**
 * 读一次服务端的可用分组并解析。拿不到（离线、鉴权过期、接口异常）返回 null，
 * 由调用方退回写死名单——那正是加入动态识别之前的行为，所以这条路径不引入新的失败方式。
 * 历史账号还要一并读订阅：订阅读不到时同样返回 null，不能当成「没有订阅」，
 * 否则一次读失败就会把已经在扣订阅的工具换回扣余额。
 * 星芒账号一并读分组对照；对照读不到只是少一档认法，不让整次返回 null。
 */
export async function loadManagedCliGroups(
  accountService: ManagedCliGroupAccountService,
): Promise<Record<ProviderId, ResolvedManagedCliGroup> | null> {
  if (typeof accountService.listUsableGroups !== 'function') return null
  const siteId = accountService.getActiveSiteId?.()
  try {
    const [groups, subscribedGroups, hints] = await Promise.all([
      accountService.listUsableGroups(),
      subscriptionsBindKeyGroups(accountService)
        ? accountService.getSubscriptionSelf!().then((snapshot) => activeSubscriptionGroupNames(snapshot))
        : Promise.resolve([]),
      loadAccountGroupHints(accountService),
    ])
    // 读分组这段时间里切了站点，这份结果就不属于当前账号了，按「没拿到」处理。
    if (accountService.getActiveSiteId?.() !== siteId) return null
    return resolveManagedCliGroups(groups, siteId, subscribedGroups, hints)
  } catch {
    return null
  }
}
