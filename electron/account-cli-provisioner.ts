import { createHash } from 'node:crypto'
import { activeProviderIds, buildAccountKeyName, resolveManagedCliKeyProfiles, providerIds, type ProviderId } from './catalog'
import { resolveDefaultCliModel, type CliModelHints } from './cli-model-defaults'
import { findAccountKeyById, isKeyQuotaExhaustedMessage, managedKeyQuotaExhaustedMessage } from './account-key-quota'
import {
  loadAccountGroupHints,
  loadManagedCliGroupListing,
  subscriptionsBindKeyGroups,
  type AccountGroupHints,
  type ManagedCliGroupAccountService,
  type ManagedCliGroupListing,
  type ResolvedManagedCliGroup,
} from './managed-cli-groups'
import type { ManagedCliGroupCheck, StoredManagedCliKey } from './managed-cli-key-store'
import { NewApiNetworkError } from './new-api-client'
import { RealmAccountError } from './realm-account'
import type { RelayBackendClient } from './relay-backend'
import { carryRequestDiagnostics } from './request-diagnostics'
import type { ConfigSavePayload, SystemService } from './system-service'

export interface ManagedCliKeyStatus {
  provider: ProviderId
  group: string
  name: string
}

export interface ManagedCliKeyFailure {
  provider: ProviderId
  group: string
  message: string
  /** 服务在维护或被防护层拦住（统一分类），不是 Key、分组或配置的问题；缺省 = 不是。 */
  serviceUnavailable?: boolean
}

export interface ManagedCliKeySyncSummary {
  ready: ManagedCliKeyStatus[]
  failed: ManagedCliKeyFailure[]
  /**
   * 这一轮 Key 换了分组的工具（买了订阅换进订阅分组、订阅到期换回来、分组改名）。
   * 已连好的工具开机时本不重写，这几家例外：配置里那把旧 Key 已经不扣该扣的额度了。
   * 缺省 = 没有。
   */
  regrouped?: ProviderId[]
  storageWarning?: string
  imageSkillWarning?: string
  /** 技能已写好、但星芒画图没登记进某些工具时给首页的一句话（已是客户能看懂的文案）；缺省 = 没问题。 */
  imageMcpWarning?: string
  /**
   * imageMcpWarning 只是因为这台电脑没有 Node.js（画图工具靠它跑）。首页凭这个跟着运行环境卡的说法走：
   * 一个命令行工具都没装时那一行写 Node.js「可选」，这句就不上首页（yoyo 10-8）。缺省 = 不是这个原因。
   */
  imageMcpNeedsNode?: boolean
}

export interface ManagedCliConfigurationOutcome {
  configured: ProviderId[]
  failed: Array<{ provider: ProviderId; message: string; serviceUnavailable?: boolean }>
}

/** new-api 与 Sub2API 两条后端各自的「服务暂时不可用」错误（network-failure.ts 的统一分类）。 */
export function isServiceUnavailableError(error: unknown): boolean {
  return (error instanceof NewApiNetworkError && error.reason === 'serviceUnavailable')
    || (error instanceof RealmAccountError && error.code === 'UNAVAILABLE')
}

export interface ManagedCliKeyStoreLike {
  read(userId: number): Promise<StoredManagedCliKey[]>
  save(userId: number, keys: readonly StoredManagedCliKey[], expectedRevision?: number): Promise<void | boolean>
  remove(userId: number, keyId: number): Promise<void>
  captureRevision?: () => number
  getSiteId?: () => string
  /** 三把都缓存时上一次问服务端分组的记录（#1157 第 8 条）。缺省 = 只记在内存里，软件重开就忘。 */
  readGroupCheck?: (userId: number) => Promise<ManagedCliGroupCheck | undefined>
  saveGroupCheck?: (userId: number, check: ManagedCliGroupCheck) => Promise<void>
}

interface ResolvedManagedCliKeys {
  keys: StoredManagedCliKey[]
  failed: ManagedCliKeyFailure[]
  regrouped: ProviderId[]
  storageWarning?: string
}

type ManagedKeyAccountService = Pick<RelayBackendClient,
  'getSessionState' | 'provisionCliKey' | 'getSessionRevision' | 'getActiveSiteId' | 'listUsableGroups'>
  & Partial<Pick<RelayBackendClient, 'getSubscriptionSelf' | 'listKeys' | 'revokeKey'>>
  & Pick<ManagedCliGroupAccountService, 'getAccountGroupHints'>
  & {
    /**
     * 服务状态文件里的型号表（service-status.ts 的 cliModels），挑默认型号时先看它。从不拒绝，读不到给 null；
     * 缺省 = 只用程序自带的那份。挂在这里是因为分组对照也挂在这里：两样都只搭启动时那次读取的便车。
     */
    getCliModelHints?: () => Promise<CliModelHints | null>
    /**
     * 不等、手上现有的分组对照：状态文件这次启动还没读成过给 undefined（说不准对照改没改），读成过给那份里的
     * 对照（没写对照是 null）。三把都缓存、还没到该查的时候只拿它比一下对照改没改，不为它等状态文件（#1157
     * 第 8 条）。缺省 = 照旧等 getAccountGroupHints。
     */
    peekAccountGroupHints?: () => AccountGroupHints | null | undefined
  }

class AccountSessionChangedError extends Error {
  constructor() {
    super('星芒账号已切换，已停止本次 API Key 初始化')
    this.name = 'AccountSessionChangedError'
  }
}

const inFlightResolutions = new WeakMap<object, Map<string, Promise<ResolvedManagedCliKeys>>>()

interface AccountSessionCapture {
  readonly userId: number
  readonly revision: number | null
}

function authenticatedSession(accountService: ManagedKeyAccountService): AccountSessionCapture {
  const session = accountService.getSessionState()
  const userId = session.account?.userId
  if (!session.authenticated || !userId) throw new Error('请先登录星芒账号')
  const revision = accountService.getSessionRevision?.()
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new AccountSessionChangedError()
  return { userId, revision: revision ?? null }
}

function assertSameAuthenticatedUser(
  accountService: ManagedKeyAccountService,
  expected: AccountSessionCapture,
): void {
  const session = accountService.getSessionState()
  const revision = accountService.getSessionRevision?.()
  if (!session.authenticated || session.account?.userId !== expected.userId
    || (expected.revision !== null && revision !== expected.revision)) {
    throw new AccountSessionChangedError()
  }
}

function rethrowAccountSessionChange(error: unknown): void {
  if (error instanceof AccountSessionChangedError) throw error
}

function isCredentialFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (/(?:服务返回|返回)\s*401\b/i.test(message)) return true
  const credential = '(?:API\\s*Key|key|token|密钥|令牌)'
  const invalid = '(?:无效|失效|过期|不存在|已撤销|invalid|expired|revoked)'
  return new RegExp(`${credential}.{0,24}${invalid}|${invalid}.{0,24}${credential}`, 'i').test(message)
}

// new-api 对放在已删、已停分组里的 Key 回 403「无权访问 X 分组」或「分组 X 已被弃用」（rc.40 的
// middleware/auth.go TokenAuth，/v1/models 也过这一道）。Key 本身没坏，换进现在的分组重签就好（#1074）。
function isGroupRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:服务返回|返回)\s*403\b/.test(message) && /无权访问\s.+\s分组|分组\s.+\s已被弃用/.test(message)
}

// 三把 Key 都在缓存里的老客户以前从不问服务端分组：站上删组、停组，或发布者改了分组对照，工具一直
// 403，首页照样「已连接」（#1074）。现在隔一阵问一次；不每次同步都问，是因为这一轮本来不用联网，
// 断网开机时不该次次白等一次超时。
const cachedGroupCheckIntervalMs = 24 * 60 * 60 * 1000
const cachedGroupRetryIntervalMs = 10 * 60 * 1000

export type CachedGroupCheck = ManagedCliGroupCheck

// 记进加密缓存里，所以存摘要不存原文：几家各列几个候选名，16 个账号攒起来会撑破缓存的大小上限。
export function accountGroupHintsFingerprint(hints: AccountGroupHints | null): string {
  if (!hints) return ''
  return createHash('sha256').update(JSON.stringify(activeProviderIds.map((provider) => hints[provider] ?? []))).digest('hex')
}

/** hints 给 undefined = 手上还没有对照、说不准改没改：只按时间算，不为它把还没到点的那一查提前。 */
export function isCachedGroupCheckDue(previous: CachedGroupCheck | undefined, hints: string | undefined, now: number): boolean {
  if (!previous || (hints !== undefined && previous.hints !== hints)) return true
  const elapsed = now - previous.at
  // 系统时间往回拨过：记下的那次说明不了什么，当作该查了。
  if (elapsed < 0) return true
  return elapsed >= (previous.succeeded ? cachedGroupCheckIntervalMs : cachedGroupRetryIntervalMs)
}

/**
 * 三把都在缓存里时，服务端认出来的分组能不能把缓存那把 Key 挪过去。这些客户以前从不换组，现在开始换，
 * 就只听明说的：订阅、分组对照、出厂名照着换；另一套名单、按工具专属词认出来的只是猜，缓存那把的分组
 * 服务端还列着时不为一个猜测换掉一把好好的 Key，分组没了才换。没认出来（fallback）从来不挪。
 */
export function movesFullyCachedKey(
  resolved: ResolvedManagedCliGroup,
  cachedGroup: string,
  listedGroups: readonly string[],
): boolean {
  if (resolved.source === 'fallback') return false
  if (resolved.source === 'subscription' || resolved.source === 'mapped' || resolved.source === 'preferred') return true
  return !listedGroups.includes(cachedGroup)
}

/** 星芒替工具签的 Key：以前的固定名 xingmang-desktop-*，或 xm 站新签的「用户名-分组」。别的名字是客户自己建的。 */
export function isManagedToolKeyName(name: string, group: string, username: string | undefined): boolean {
  if (name.startsWith('xingmang-desktop-')) return true
  return username !== undefined && name === buildAccountKeyName(username, group)
}

/**
 * 换组签了新 Key 以后，旧那把要不要在新 Key 写进工具后删掉（yoyo 10-17）：只删星芒签的，客户自建的不碰；
 * 只删分组已经没了的（服务端不再列它），那把放在哪儿都用不了了。分组还在、只是对照改了的不删：
 * 同一账号的另一台电脑可能还在用它。历史账号不删。
 */
export function retiresReplacedKey(
  previous: Pick<StoredManagedCliKey, 'id' | 'name' | 'group'>,
  replacement: { id: number; group: string },
  listedGroups: readonly string[],
  siteId: string | undefined,
  username: string | undefined,
): boolean {
  if (siteId === 'solov-api') return false
  if (previous.id === replacement.id || previous.group === replacement.group) return false
  if (listedGroups.includes(previous.group)) return false
  return isManagedToolKeyName(previous.name, previous.group, username)
}

interface PendingKeyRetirement {
  keyId: number
  replacementId: number
}

// 按缓存那个对象记：同步和写配置是两次调用、各自的账号包装也不一定是同一个，缓存是同一个。缓存会落盘的
// （readGroupCheck / saveGroupCheck）也记一份在这里：同一次启动里不用每轮都去解一遍缓存文件。
const cachedGroupChecks = new WeakMap<ManagedCliKeyStoreLike, Map<string, CachedGroupCheck>>()
// 等新 Key 写进工具再删的旧 Key，只记在内存里：软件关了就忘，旧那把留在账号里，宁可不删（失败不删）。
const pendingKeyRetirements = new WeakMap<ManagedCliKeyStoreLike, Map<string, PendingKeyRetirement>>()

function storeScopedMap<T>(registry: WeakMap<ManagedCliKeyStoreLike, Map<string, T>>, keyStore: ManagedCliKeyStoreLike): Map<string, T> {
  let entries = registry.get(keyStore)
  if (!entries) {
    entries = new Map()
    registry.set(keyStore, entries)
  }
  return entries
}

async function previousGroupCheck(
  keyStore: ManagedCliKeyStoreLike,
  checks: Map<string, CachedGroupCheck>,
  scope: string,
  userId: number,
): Promise<CachedGroupCheck | undefined> {
  const known = checks.get(scope)
  if (known || typeof keyStore.readGroupCheck !== 'function') return known
  const stored = await keyStore.readGroupCheck(userId).catch(() => undefined)
  if (stored && !checks.has(scope)) checks.set(scope, stored)
  return checks.get(scope)
}

// 记不下来只是下次开机再问一次，不让这一轮同步失败。
async function rememberGroupCheck(
  keyStore: ManagedCliKeyStoreLike,
  checks: Map<string, CachedGroupCheck>,
  scope: string,
  userId: number,
  record: CachedGroupCheck,
): Promise<void> {
  checks.set(scope, record)
  if (typeof keyStore.saveGroupCheck === 'function') await keyStore.saveGroupCheck(userId, record).catch(() => undefined)
}

// 没到点时只拿手上现有的对照比，不等状态文件；没有不等的那条路时照旧等。
async function knownGroupHintsFingerprint(accountService: ManagedKeyAccountService): Promise<string | undefined> {
  if (typeof accountService.peekAccountGroupHints !== 'function') {
    return accountGroupHintsFingerprint(await loadAccountGroupHints(accountService))
  }
  if (accountService.getActiveSiteId?.() === 'solov-api') return accountGroupHintsFingerprint(null)
  try {
    const hints = accountService.peekAccountGroupHints()
    return hints === undefined ? undefined : accountGroupHintsFingerprint(hints)
  } catch {
    return undefined
  }
}

function retirementSlot(siteId: string | undefined, userId: number, provider: ProviderId): string {
  return `${siteId ?? ''}:${userId}:${provider}`
}

function noteKeyRetirement(
  keyStore: ManagedCliKeyStoreLike,
  slot: string,
  previous: StoredManagedCliKey,
  replacement: { id: number; group: string },
  listing: ManagedCliGroupListing,
  siteId: string | undefined,
  username: string | undefined,
): void {
  const retirements = storeScopedMap(pendingKeyRetirements, keyStore)
  if (retiresReplacedKey(previous, replacement, listing.names, siteId, username)) {
    retirements.set(slot, { keyId: previous.id, replacementId: replacement.id })
  } else {
    retirements.delete(slot)
  }
}

// 新 Key 已经写进这家工具了才删旧那把。删不掉、核不清都只是账号里多留一把 Key，不算这家工具配置失败。
async function retireReplacedKey(
  accountService: ManagedKeyAccountService,
  keyStore: ManagedCliKeyStoreLike,
  slot: string,
  written: StoredManagedCliKey,
  capture: AccountSessionCapture,
): Promise<void> {
  const retirements = pendingKeyRetirements.get(keyStore)
  const pending = retirements?.get(slot)
  if (!retirements || !pending || pending.replacementId !== written.id) return
  retirements.delete(slot)
  const { listKeys, revokeKey } = accountService
  if (typeof listKeys !== 'function' || typeof revokeKey !== 'function') return
  try {
    assertSameAuthenticatedUser(accountService, capture)
    // 本机记的分组可能已经过时：站上删组时常先把 Key 挪到新分组下接着用（catalog.ts 的 retiredAccountGroups），
    // Claude Desktop 那份拷贝之类可能还拿着它。动手前照服务端现在的样子再核一遍：这把还在、名字仍是星芒签的、
    // 所在的分组确实已经不能用，才删。
    const [current, listing] = await Promise.all([
      findAccountKeyById((query) => listKeys.call(accountService, query), pending.keyId),
      loadManagedCliGroupListing(accountService),
    ])
    assertSameAuthenticatedUser(accountService, capture)
    if (!current || !listing) return
    if (!retiresReplacedKey(current, written, listing.names, accountService.getActiveSiteId?.(),
      accountService.getSessionState().account?.username)) return
    await revokeKey.call(accountService, pending.keyId)
  } catch {
    // 见上。账号中途换了也落到这里：不拿旧账号的 Key 编号去动新账号。
  }
}

async function resolveManagedCliKeys(
  accountService: ManagedKeyAccountService,
  capture: AccountSessionCapture,
  keyStore?: ManagedCliKeyStoreLike,
): Promise<ResolvedManagedCliKeys> {
  const serviceKey = accountService as object
  const userId = capture.userId
  const resolutionKey = `${userId}:${capture.revision ?? 'legacy'}`
  let serviceResolutions = inFlightResolutions.get(serviceKey)
  const existing = serviceResolutions?.get(resolutionKey)
  if (existing) return existing
  if (!serviceResolutions) {
    serviceResolutions = new Map()
    inFlightResolutions.set(serviceKey, serviceResolutions)
  }

  const operation = (async (): Promise<ResolvedManagedCliKeys> => {
    assertSameAuthenticatedUser(accountService, capture)
    let cached: StoredManagedCliKey[] = []
    if (keyStore) {
      try {
        cached = await keyStore.read(userId)
      } catch (error) {
        // A damaged ciphertext or unavailable OS keychain must not trap a new
        // machine in onboarding. Keep the read API explicit for callers that
        // need to distinguish corruption, but let provisioning rebuild the
        // cache through save() (which quarantines a damaged record and
        // surfaces a transient read failure as a storage warning instead).
        // The save path below rebuilds the record after provisioning. A
        // recoverable read failure is therefore not itself a user-facing
        // storage failure.
      }
    }
    const cacheRevision = keyStore?.captureRevision?.()
    assertSameAuthenticatedUser(accountService, capture)
    const profiles = resolveManagedCliKeyProfiles(accountService.getActiveSiteId?.())
    const activeSiteId = accountService.getActiveSiteId?.()
    const cacheSiteId = keyStore?.getSiteId?.()
    const foreignCache = cacheSiteId !== undefined && activeSiteId !== undefined && cacheSiteId !== activeSiteId
    const scopedCache = activeSiteId !== undefined && cacheSiteId === activeSiteId
    // Old/unscoped stores only prove their shipped names. The realm-bound
    // encrypted store may also prove a renamed group without going online.
    const usableCache = foreignCache ? [] : scopedCache ? cached : cached.filter((entry) => (
      entry.group === profiles[entry.provider].group
    ))
    // 历史账号例外：订阅是在服务端买、在服务端到期的，本机缓存看不出来，
    // 每次都得问一次，否则买了订阅工具也还在扣余额。
    const everyKeyCached = !subscriptionsBindKeyGroups(accountService) && activeProviderIds.every((provider) => (
      usableCache.some((entry) => entry.provider === provider)
    ))
    let listing: ManagedCliGroupListing | null = null
    let groupCheck: { checks: Map<string, CachedGroupCheck>; scope: string; record: CachedGroupCheck } | null = null
    if (!everyKeyCached) {
      listing = await loadManagedCliGroupListing(accountService)
    } else if (keyStore) {
      const checks = storeScopedMap(cachedGroupChecks, keyStore)
      const scope = `${activeSiteId ?? ''}:${userId}`
      const previous = await previousGroupCheck(keyStore, checks, scope, userId)
      const knownHints = await knownGroupHintsFingerprint(accountService)
      assertSameAuthenticatedUser(accountService, capture)
      if (isCachedGroupCheckDue(previous, knownHints, Date.now())) {
        listing = await loadManagedCliGroupListing(accountService)
        // 记的是这次查分组真用上的那份对照：查的时候已经等过状态文件，这里不再多等。
        const hints = accountGroupHintsFingerprint(await loadAccountGroupHints(accountService))
        groupCheck = { checks, scope, record: { at: Date.now(), succeeded: listing !== null, hints } }
        await rememberGroupCheck(keyStore, checks, scope, userId, groupCheck.record)
      }
    }
    const resolvedGroups = listing?.resolved ?? null
    assertSameAuthenticatedUser(accountService, capture)
    const groupFor = (provider: ProviderId): string => {
      const resolved = resolvedGroups?.[provider]
      const cachedGroup = usableCache.find((entry) => entry.provider === provider)?.group
      if (everyKeyCached && listing && resolved && cachedGroup !== undefined) {
        return movesFullyCachedKey(resolved, cachedGroup, listing.names) ? resolved.group : cachedGroup
      }
      // A fallback means the listing did not identify a new owner. It does
      // not invalidate a group already confirmed when this key was issued.
      // 历史账号订阅到期也走这条：服务端还给得出这家工具的普通分组时会认出来、
      // 换回去；认不出时换去写死的名字只会签 Key 失败，配置里仍是这把旧 Key。
      return (resolved?.source !== 'fallback' ? resolved?.group : undefined)
        ?? cachedGroup
        ?? profiles[provider].group
    }
    // A group rename on the account backend must invalidate the old local
    // entry. Otherwise a cached secret from the previous production config
    // would bypass provisioning and keep writing requests to a stale group.
    const keys = new Map(usableCache.flatMap((entry) => {
      const profile = profiles[entry.provider]
      return profile && groupFor(entry.provider) === entry.group ? [[entry.provider, entry] as const] : []
    }))
    const failed: ManagedCliKeyFailure[] = []
    const regrouped: ProviderId[] = []
    let fetchedFromServer = false
    let droppedDeadKey = false

    // 下线的工具（Gemini CLI）不再签 Key：历史账号多半已经没有它的分组，签不出来会让每次登录都报一条失败。
    const username = accountService.getSessionState().account?.username
    for (const provider of activeProviderIds) {
      if (keys.has(provider)) continue
      const group = groupFor(provider)
      const previous = usableCache.find((entry) => entry.provider === provider)
      const previousGroup = previous?.group
      try {
        assertSameAuthenticatedUser(accountService, capture)
        const result = await accountService.provisionCliKey({
          name: profiles[provider].keyName,
          group,
        })
        assertSameAuthenticatedUser(accountService, capture)
        keys.set(provider, {
          id: result.id,
          provider,
          group,
          name: result.name,
          key: result.key,
        })
        if (previousGroup !== undefined && previousGroup !== group) regrouped.push(provider)
        if (previous && keyStore && listing) {
          noteKeyRetirement(keyStore, retirementSlot(activeSiteId, userId, provider), previous, { id: result.id, group }, listing, activeSiteId, username)
        }
        fetchedFromServer = true
      } catch (error) {
        rethrowAccountSessionChange(error)
        if (groupCheck && listing && previous) {
          if (listing.names.includes(previous.group)) {
            // 三把都缓存、对照改了却没换过去：旧那把的分组还在、照样能用，接着用它，过一会儿再试。
            keys.set(provider, previous)
            if (keyStore) await rememberGroupCheck(keyStore, groupCheck.checks, groupCheck.scope, userId, { ...groupCheck.record, succeeded: false })
            continue
          }
          // 分组没了，旧那把已经用不了：从缓存里拿掉，下一轮照常重签、照实报失败，不再拿它当「已连好」。
          droppedDeadKey = true
        }
        // 签 Key 那次请求走的线路、状态码、请求编号跟着这条失败走，写 Key 失败的日志要用（request-diagnostics.ts）。
        failed.push(carryRequestDiagnostics(error, {
          provider,
          group,
          message: error instanceof Error ? error.message : 'CLI Key 初始化失败',
          ...(isServiceUnavailableError(error) ? { serviceUnavailable: true } : {}),
        }))
      }
    }

    let storageWarning: string | undefined
    if (keyStore && (fetchedFromServer || droppedDeadKey)) {
      try {
        assertSameAuthenticatedUser(accountService, capture)
        // 下线工具以前签的那把还留在缓存里，不因为这次保存丢掉；只是不再交出去写配置。
        const cachedKeys = providerIds.flatMap((provider) => {
          const entry = keys.get(provider)
          return entry ? [entry] : []
        })
        const saved = cacheRevision === undefined
          ? await keyStore.save(userId, cachedKeys)
          : await keyStore.save(userId, cachedKeys, cacheRevision)
        assertSameAuthenticatedUser(accountService, capture)
        if (saved === false) storageWarning = '本地 API Key 缓存已被其他操作更新，本次保留新缓存'
      } catch (error) {
        rethrowAccountSessionChange(error)
        storageWarning = error instanceof Error ? error.message : '本地 API Key 保存失败'
      }
    }

    assertSameAuthenticatedUser(accountService, capture)
    return {
      keys: activeProviderIds.flatMap((provider) => {
        const entry = keys.get(provider)
        return entry ? [entry] : []
      }),
      failed,
      regrouped,
      ...(storageWarning ? { storageWarning } : {}),
    }
  })()
  const trackedOperation = operation.finally(() => {
    const current = inFlightResolutions.get(serviceKey)
    if (current?.get(resolutionKey) !== trackedOperation) return
    current.delete(resolutionKey)
    if (current.size === 0) inFlightResolutions.delete(serviceKey)
  })
  serviceResolutions.set(resolutionKey, trackedOperation)
  return trackedOperation
}

export async function syncManagedCliKeySummary(
  accountService: ManagedKeyAccountService,
  keyStore?: ManagedCliKeyStoreLike,
): Promise<ManagedCliKeySyncSummary> {
  const capture = authenticatedSession(accountService)
  const result = await resolveManagedCliKeys(accountService, capture, keyStore)
  assertSameAuthenticatedUser(accountService, capture)
  return {
    ready: result.keys.map(({ provider, group, name }) => ({ provider, group, name })),
    failed: result.failed,
    ...(result.regrouped.length ? { regrouped: result.regrouped } : {}),
    ...(result.storageWarning ? { storageWarning: result.storageWarning } : {}),
  }
}

async function loadCliModelHints(accountService: ManagedKeyAccountService): Promise<CliModelHints | null> {
  if (typeof accountService.getCliModelHints !== 'function') return null
  try {
    return await accountService.getCliModelHints()
  } catch {
    return null
  }
}

// 失效重签只换缓存里这一家的那条。手上的 keys 只有在用的工具，拿它整份存回去会丢掉下线工具（Gemini）
// 以前签的那把和别处刚换好的条目，所以照缓存现在的样子改一条，跟同步那一轮保存的口径一致（#1093 第 6 条）。
// 新 Key 已经签好了：缓存没存上只是下次同步再签一把，不该让这把写不进配置。
async function cacheReplacementKey(
  keyStore: ManagedCliKeyStoreLike,
  userId: number,
  replacement: StoredManagedCliKey,
  assertSession: () => void,
): Promise<void> {
  try {
    const stored = await keyStore.read(userId)
    const revision = keyStore.captureRevision?.()
    assertSession()
    const cachedKeys = providerIds.flatMap((provider) => {
      if (provider === replacement.provider) return [replacement]
      const entry = stored.find((item) => item.provider === provider)
      return entry ? [entry] : []
    })
    if (revision === undefined) await keyStore.save(userId, cachedKeys)
    else await keyStore.save(userId, cachedKeys, revision)
  } catch (error) {
    rethrowAccountSessionChange(error)
  }
}

export async function configureManagedClis(
  accountService: ManagedKeyAccountService,
  systemService: Pick<SystemService, 'fetchAvailableModels' | 'saveConfig'>,
  providers: readonly ProviderId[],
  preferredModels: Partial<Record<ProviderId, string>>,
  previewOnboarding: boolean,
  keyStore?: ManagedCliKeyStoreLike,
  mode: ConfigSavePayload['mode'] = 'merge',
  intent: 'automatic' | 'explicit' = 'automatic',
  keepKeys: readonly ProviderId[] = [],
): Promise<ManagedCliConfigurationOutcome> {
  if (providers.length === 0) return { configured: [], failed: [] }
  const capture = authenticatedSession(accountService)
  const userId = capture.userId
  // 换线路这一轮沿用配置里那把的几家（#1159）用不上托管 Key。点名重写不在此列：那是客户要换成自动那把。
  const kept = new Set(intent === 'explicit' ? [] : keepKeys.filter((provider) => providers.includes(provider)))
  const needsManagedKeys = providers.some((provider) => !kept.has(provider))
  // 和签 Key 一起等；真到挑型号那一步才用得上。全是沿用的就不去问服务端：换线路多半正赶上网络不好。
  const pendingModelHints = needsManagedKeys ? loadCliModelHints(accountService) : Promise.resolve(null)
  const synchronized: Pick<ResolvedManagedCliKeys, 'keys' | 'failed'> = needsManagedKeys
    ? await resolveManagedCliKeys(accountService, capture, keyStore)
    : { keys: [], failed: [] }
  assertSameAuthenticatedUser(accountService, capture)
  const keys = new Map(synchronized.keys.map((entry) => [entry.provider, entry]))
  const syncFailures = new Map(synchronized.failed.map((entry) => [entry.provider, entry]))
  const outcome: ManagedCliConfigurationOutcome = { configured: [], failed: [] }

  for (const provider of providers) {
    if (kept.has(provider)) {
      // 客户在密钥页「写进工具」、配置窗口自己选的那把：Key 和型号原样，只跟着线路换地址。空 Key 交给 saveConfig
      // 沿用配置里那把，它照旧只认来源是当前账号、之后没人动过的配置，也照旧拿这把查一遍型号还在不在。
      try {
        const model = preferredModels[provider]
        if (!model) throw new Error('默认模型尚未写入配置')
        assertSameAuthenticatedUser(accountService, capture)
        await systemService.saveConfig(
          { provider, apiKey: '', model, mode },
          previewOnboarding,
          () => assertSameAuthenticatedUser(accountService, capture),
          { source: 'account', automatic: true },
        )
        assertSameAuthenticatedUser(accountService, capture)
        outcome.configured.push(provider)
      } catch (error) {
        outcome.failed.push(failedConfiguration(provider, error))
      }
      continue
    }
    let managedKey = keys.get(provider)
    if (!managedKey) {
      const syncFailure = syncFailures.get(provider)
      outcome.failed.push(carryRequestDiagnostics(syncFailure, {
        provider,
        message: syncFailure?.message ?? '对应分组 Key 未就绪',
        ...(syncFailure?.serviceUnavailable ? { serviceUnavailable: true } : {}),
      }))
      continue
    }
    try {
      assertSameAuthenticatedUser(accountService, capture)
      let models: string[]
      try {
        models = await systemService.fetchAvailableModels(managedKey.key, { bypassCache: true })
      } catch (error) {
        // 额度上限用完的 401 不是凭据失效：重签只会换来一把不限额的新 Key。
        if (isKeyQuotaExhaustedMessage(error instanceof Error ? error.message : String(error))) {
          throw new Error(managedKeyQuotaExhaustedMessage)
        }
        const groupRejected = isGroupRejection(error)
        if (!groupRejected && !isCredentialFailure(error)) throw error
        // 先从缓存拿掉失效的那把，下面重签没成也不会下次再拿它去试；拿不掉只是多试一次，不挡重签。
        if (keyStore) await keyStore.remove(userId, managedKey.id).catch(() => undefined)
        assertSameAuthenticatedUser(accountService, capture)
        const siteId = accountService.getActiveSiteId?.()
        const profile = resolveManagedCliKeyProfiles(siteId)[provider]
        // 失效也可能是分组改名；重签前先问服务端。组列表暂不可用时沿用
        // 原 Key 已确认过的组名，不把动态组误换成出厂组名。
        const listing = await loadManagedCliGroupListing(accountService)
        assertSameAuthenticatedUser(accountService, capture)
        const resolved = listing?.resolved[provider]
        const group = (resolved?.source !== 'fallback' ? resolved?.group : undefined) ?? managedKey.group
        // 分组被拒、又认不出别的分组可换：同一个分组里重签只会拿回同一把，照服务端原话报。
        if (groupRejected && group === managedKey.group) throw error
        const replacement = await accountService.provisionCliKey({ name: profile.keyName, group })
        assertSameAuthenticatedUser(accountService, capture)
        if (keyStore && listing) {
          noteKeyRetirement(keyStore, retirementSlot(siteId, userId, provider), managedKey, { id: replacement.id, group }, listing, siteId,
            accountService.getSessionState().account?.username)
        }
        managedKey = {
          id: replacement.id,
          provider,
          group,
          name: replacement.name,
          key: replacement.key,
        }
        keys.set(provider, managedKey)
        if (keyStore) await cacheReplacementKey(keyStore, userId, managedKey, () => assertSameAuthenticatedUser(accountService, capture))
        models = await systemService.fetchAvailableModels(managedKey.key, { bypassCache: true })
      }
      assertSameAuthenticatedUser(accountService, capture)
      if (models.length === 0) throw new Error('当前分组未返回可用模型')
      const model = resolveDefaultCliModel(provider, models, preferredModels[provider], await pendingModelHints)
      if (!model) throw new Error('当前分组未返回可用于交互的默认模型，请选择其他分组或手动配置模型')
      const payload: ConfigSavePayload = { provider, apiKey: managedKey.key, model, mode }
      assertSameAuthenticatedUser(accountService, capture)
      await systemService.saveConfig(
        payload,
        previewOnboarding,
        () => assertSameAuthenticatedUser(accountService, capture),
        { source: 'account', automatic: intent !== 'explicit' },
      )
      assertSameAuthenticatedUser(accountService, capture)
      outcome.configured.push(provider)
      if (keyStore) {
        await retireReplacedKey(accountService, keyStore, retirementSlot(accountService.getActiveSiteId?.(), userId, provider), managedKey, capture)
      }
    } catch (error) {
      outcome.failed.push(failedConfiguration(provider, error))
    }
  }
  return outcome
}

// 账号中途换了照旧整轮作废；其余的照原话交回界面，查型号那次请求的诊断跟着走（request-diagnostics.ts）。
function failedConfiguration(provider: ProviderId, error: unknown): ManagedCliConfigurationOutcome['failed'][number] {
  rethrowAccountSessionChange(error)
  return carryRequestDiagnostics(error, {
    provider,
    message: error instanceof Error ? error.message : 'CLI 配置失败',
    ...(isServiceUnavailableError(error) ? { serviceUnavailable: true } : {}),
  })
}
