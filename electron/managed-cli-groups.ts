import {
  managedCliKeyProfiles,
  providerIds,
  resolveManagedCliKeyProfiles,
  sub2ApiManagedCliKeyProfiles,
  type ProviderId,
} from './catalog'

export interface ManagedCliGroupCandidate {
  name: string
  /** 分组背后接的是哪家上游。只有「历史账号」那套后端（Sub2API）会给，新站没有。 */
  platform?: string
}

/** preferred: 服务端就有这个名字；alias: 命中另一套已知名单；
 *  detected: 靠工具专属词认出来的；fallback: 没认出来，退回写死名单。 */
export type ManagedCliGroupSource = 'preferred' | 'alias' | 'detected' | 'fallback'

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
    if (!name || name.length > maximumGroupNameLength || seen.has(name)) continue
    if (/[\u0000-\u001f\u007f]/.test(name)) continue
    seen.add(name)
    const platform = typeof group.platform === 'string' ? group.platform.trim().toLowerCase() : ''
    normalized.push(platform && platform.length <= maximumPlatformLength ? { name, platform } : { name })
  }
  return normalized
}

function platformOwner(platform: string | undefined): ProviderId | null {
  if (!platform) return null
  return providerIds.find((provider) => providerPlatforms[provider].includes(platform)) ?? null
}

/**
 * 从服务端实际可用的分组里挑出这家 CLI 该用的那个。四档从准到松：
 * 名单里的名字还在 → 另一套已知名单里的名字 → 认出来（先看分组接的是哪家上游，
 * 再看名字里的工具专属词，都要唯一）→ 退回名单。
 * 认不出或认到多个一律退回名单，让后续校验报「分组不可用」，不猜。
 */
export function resolveManagedCliGroup(
  provider: ProviderId,
  groups: readonly ManagedCliGroupCandidate[],
  siteId?: string,
): ResolvedManagedCliGroup {
  const preferred = resolveManagedCliKeyProfiles(siteId)[provider].group
  const normalized = normalizeGroups(groups)
  const names = normalized.map((group) => group.name)
  if (names.length === 0) return { group: preferred, source: 'fallback' }
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

export function resolveManagedCliGroups(
  groups: readonly ManagedCliGroupCandidate[],
  siteId?: string,
): Record<ProviderId, ResolvedManagedCliGroup> {
  return Object.fromEntries(
    providerIds.map((provider) => [provider, resolveManagedCliGroup(provider, groups, siteId)]),
  ) as Record<ProviderId, ResolvedManagedCliGroup>
}

interface ManagedCliGroupAccountService {
  listUsableGroups?: () => Promise<ManagedCliGroupCandidate[]>
  getActiveSiteId?: () => string
}

/**
 * 读一次服务端的可用分组并解析。拿不到（离线、鉴权过期、接口异常）返回 null，
 * 由调用方退回写死名单——那正是加入动态识别之前的行为，所以这条路径不引入新的失败方式。
 */
export async function loadManagedCliGroups(
  accountService: ManagedCliGroupAccountService,
): Promise<Record<ProviderId, ResolvedManagedCliGroup> | null> {
  if (typeof accountService.listUsableGroups !== 'function') return null
  const siteId = accountService.getActiveSiteId?.()
  try {
    const groups = await accountService.listUsableGroups()
    // 读分组这段时间里切了站点，这份结果就不属于当前账号了，按「没拿到」处理。
    if (accountService.getActiveSiteId?.() !== siteId) return null
    return resolveManagedCliGroups(groups, siteId)
  } catch {
    return null
  }
}
