import type { RelayBackendCapabilities, RelayBackendClient } from './relay-backend'
import type {
  NewApiAccountKeyCreateInput, NewApiAccountProfile, NewApiAccountProfileDetail,
  NewApiCliKeyResult, NewApiProvisionCliKeyInput,
} from './new-api-client'
import { sub2ApiManagedCliKeyProfiles } from './catalog'
import { summarizeKeySecret } from './key-secret-summary'
import { parseRealmSavedAccount, RealmAccountError, type RealmSavedAccount } from './realm-account'
import {
  createSub2ApiAccountClient, createSub2ApiSessionExecutor,
  type Sub2ApiAccountClientOptions, type Sub2ApiGroupSummary, type Sub2ApiKeySummary,
  type Sub2ApiProfile, type Sub2ApiSessionExecutor,
} from './sub2api-account-client'

export interface Sub2ApiRelayBackendOptions extends Sub2ApiAccountClientOptions {
  /** Main process only. Persist these credentials encrypted; never expose through IPC. */
  onSessionChange?: (saved: RealmSavedAccount | null) => void
  /** Persist a restored candidate's rotated credential without activating it. */
  onCredentialRotation?: (saved: RealmSavedAccount) => void | Promise<void>
}

export interface Sub2ApiRelayBackend {
  readonly client: RelayBackendClient
  restore(saved: RealmSavedAccount): Promise<boolean>
  getSavedAccount(): RealmSavedAccount | null
}

export const sub2ApiRelayCapabilities: Readonly<RelayBackendCapabilities> = Object.freeze({
  supportsRegistration: false, supportsPasswordReset: false,
  supportsKeyManagement: true, supportsUsage: false, supportsBilling: false,
  supportsSubscriptions: false, supportsProfileUpdate: true,
  supportsSessionManagement: false, supportsAutoKeyProvision: true, supportsAccountSession: true,
})

interface Session {
  saved: RealmSavedAccount
  account: NewApiAccountProfile
  executor: Sub2ApiSessionExecutor
}
interface Scope { entry: Session; revision: number }

function accountProfile(profile: Sub2ApiProfile): NewApiAccountProfile {
  // Shared DTO names are legacy. Sub2API amounts are native USD throughout;
  // quotaPerUnit=1 in status/balance ensures no new-api 500000 conversion.
  return { userId: Number(profile.userId), username: profile.username, group: null,
    role: profile.role === 'admin' ? 100 : profile.role === 'user' ? 1 : null,
    quota: profile.balance, usedQuota: null }
}

function detailProfile(profile: Sub2ApiProfile): NewApiAccountProfileDetail {
  // Usage/referral counters are unavailable in this adapter; their UI blocks
  // are disabled by capabilities and must not present these placeholders.
  return { userId: Number(profile.userId), username: profile.username, displayName: profile.username,
    email: profile.email, group: null, quota: profile.balance, usedQuota: 0, requestCount: 0,
    affCode: null, affCount: 0, affQuota: 0, affHistoryQuota: 0 }
}

async function unsupported(): Promise<never> { throw new RealmAccountError('UNSUPPORTED') }
function positiveId(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RealmAccountError('INVALID')
  return String(value)
}
function keyName(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw new RealmAccountError('INVALID')
  return value.trim()
}

/** Complete RelayBackendClient implementation for the explicitly selected api realm. */
export function createSub2ApiRelayBackend(options: Sub2ApiRelayBackendOptions): Sub2ApiRelayBackend {
  const native = createSub2ApiAccountClient(options)
  const now = options.now ?? Date.now
  const signal = new AbortController().signal
  let active: Session | null = null
  let revision = 0
  let provisionTail: Promise<unknown> = Promise.resolve()

  function changed(): void { options.onSessionChange?.(active?.saved ?? null) }
  function capture(): Scope {
    if (!active) throw new RealmAccountError('SIGNED_OUT')
    return { entry: active, revision }
  }
  function assertCurrent(scope: Scope): void {
    if (active !== scope.entry || revision !== scope.revision) throw new RealmAccountError('STALE')
  }
  function clear(scope: Scope): void {
    assertCurrent(scope)
    revision += 1
    active = null
    changed()
  }
  function install(saved: RealmSavedAccount, profile: Sub2ApiProfile): void {
    const entry: Session = { saved, account: accountProfile(profile), executor: undefined! }
    let refreshRevision = revision
    function assertRotationOwner(): void {
      if (active !== entry || revision !== refreshRevision) throw new RealmAccountError('STALE')
    }
    const refreshBackend = { restore: async (...args: Parameters<typeof native.restore>) => {
      refreshRevision = revision
      assertRotationOwner()
      const restored = await native.restore(...args)
      assertRotationOwner()
      return restored
    } }
    entry.executor = createSub2ApiSessionExecutor(saved, refreshBackend, { onSessionChange: async (rotated) => {
      assertRotationOwner()
      entry.saved = rotated
      await options.onCredentialRotation?.(rotated)
      assertRotationOwner()
      changed()
    } })
    active = entry
    changed()
  }

  async function call<T>(scope: Scope, operation: (saved: RealmSavedAccount, signal: AbortSignal) => Promise<T>, write = false): Promise<T> {
    assertCurrent(scope)
    try {
      const result = await scope.entry.executor.executeWithRefresh(async (saved, abort) => {
        assertCurrent(scope)
        try { return await operation(saved, abort) } catch (error) {
          // Do not start a refresh from an obsolete request's late 401.
          assertCurrent(scope)
          throw error
        }
      }, signal, { retryOnUnauthorized: !write })
      assertCurrent(scope)
      return result.value
    } catch (error) {
      assertCurrent(scope)
      if (error instanceof RealmAccountError && error.code === 'PROTOCOL') clear(scope)
      if (error instanceof RealmAccountError && error.code === 'UNAUTHORIZED') {
        if (write) {
          // A definitive 401 can refresh the next operation, but the write
          // itself is never replayed after an uncertain server outcome.
          try { await scope.entry.executor.refresh(signal) } catch (refreshError) {
            assertCurrent(scope)
            if (refreshError instanceof RealmAccountError && (refreshError.code === 'UNAUTHORIZED' || refreshError.code === 'PROTOCOL')) clear(scope)
            throw refreshError
          }
        } else clear(scope)
      }
      throw error
    }
  }

  async function groups(scope: Scope): Promise<Sub2ApiGroupSummary[]> {
    return (await call(scope, (saved, abort) => native.listGroups(saved, abort))).filter((group) => group.status === 'active')
  }
  async function resolveGroup(scope: Scope, name: string): Promise<Sub2ApiGroupSummary> {
    if (typeof name !== 'string' || !name || name.length > 256) throw new RealmAccountError('INVALID')
    const matches = (await groups(scope)).filter((group) => group.name === name)
    if (matches.length !== 1) throw new Error('分组不存在、不可用或名称重复，请确认账号可用分组')
    return matches[0]
  }
  async function allKeys(scope: Scope): Promise<Sub2ApiKeySummary[]> {
    const result: Sub2ApiKeySummary[] = []
    const seen = new Set<string>()
    for (let page = 1; page <= 1000; page += 1) {
      const batch = await call(scope, (saved, abort) => native.listKeys(saved, page, 100, abort))
      for (const key of batch.items) {
        if (seen.has(key.id)) throw new RealmAccountError('PROTOCOL')
        seen.add(key.id)
        result.push(key)
      }
      if (result.length >= batch.total) return result
      if (!batch.items.length) throw new RealmAccountError('PROTOCOL')
    }
    throw new Error('账号 API Key 数量超过安全分页上限')
  }
  function usable(key: Sub2ApiKeySummary): boolean {
    return key.status === 'active' && (!key.expiresAt || Date.parse(key.expiresAt) > now())
      && (!key.quota || key.quota > (key.quotaUsed ?? 0))
  }
  async function reveal(scope: Scope, key: Sub2ApiKeySummary): Promise<NewApiCliKeyResult> {
    return { id: Number(key.id), name: key.name, key: await call(scope, (saved, abort) => native.revealKey(saved, key.id, abort)) }
  }
  function keySettings(input: NewApiAccountKeyCreateInput): { name: string; quota: number; expiresAt: string; expiresInDays?: number } {
    const name = keyName(input.name)
    if (typeof input.unlimitedQuota !== 'boolean' || typeof input.remainQuota !== 'number' || !Number.isFinite(input.remainQuota)
      || input.remainQuota < 0 || input.remainQuota > Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(input.expiredTime)
      || (input.expiredTime !== -1 && input.expiredTime * 1000 <= now())) throw new RealmAccountError('INVALID')
    if (!input.unlimitedQuota && input.remainQuota === 0) throw new Error('限额必须大于 0；0 表示不限额')
    const expiresAt = input.expiredTime === -1 ? '' : new Date(input.expiredTime * 1000).toISOString()
    return { name, quota: input.unlimitedQuota ? 0 : input.remainQuota, expiresAt,
      ...(expiresAt ? { expiresInDays: Math.ceil((input.expiredTime * 1000 - now()) / 86400000) } : {}) }
  }
  async function create(scope: Scope, input: NewApiAccountKeyCreateInput, group: Sub2ApiGroupSummary): Promise<Sub2ApiKeySummary> {
    const settings = keySettings(input)
    const created = await call(scope, (saved, abort) => native.createKey(saved, {
      name: settings.name, groupId: group.id, quota: settings.quota,
      ...(settings.expiresInDays === undefined ? {} : { expiresInDays: settings.expiresInDays }),
    }, abort), true)
    if (settings.expiresAt) {
      // Create accepts whole days only. Update applies the precise user date.
      return call(scope, (saved, abort) => native.updateKey(saved, created.id, {
        name: settings.name, groupId: group.id, quota: settings.quota, expiresAt: settings.expiresAt,
      }, abort), true)
    }
    return created
  }

  const client: RelayBackendClient = {
    capabilities: sub2ApiRelayCapabilities,
    getActiveSiteId: () => 'solov-api',
    getStatus: async () => {
      const settings = await native.getPublicSettings(signal)
      return { systemName: settings.siteName, version: '', setupComplete: true, quotaPerUnit: 1,
        quotaDisplayType: 'USD', usdExchangeRate: 1, registerEnabled: false, passwordRegisterEnabled: false,
        emailVerificationEnabled: false, turnstileCheckEnabled: settings.turnstileEnabled }
    },
    getNotice: async () => null,
    getLegalDocument: unsupported, sendEmailVerification: unsupported, sendPasswordResetEmail: unsupported,
    resetPassword: unsupported, register: unsupported,
    login: async (input) => {
      const attempt = ++revision
      const candidate = await native.authenticate({ identifier: input.username, password: input.password,
        ...(input.turnstileToken === undefined ? {} : { turnstileToken: input.turnstileToken }) }, signal)
      if (revision !== attempt) throw new RealmAccountError('STALE')
      const profile = await native.getProfile(candidate, signal)
      if (revision !== attempt) throw new RealmAccountError('STALE')
      install(candidate, profile)
      return { account: { ...active!.account }, accessExpiresAt: candidate.credential.kind === 'sub2api' && candidate.credential.expiresAt
        ? new Date(candidate.credential.expiresAt).toISOString() : null }
    },
    logout: () => { revision += 1; active = null; changed() },
    getSessionState: () => ({ authenticated: active !== null, account: active ? { ...active.account } : null }),
    getSessionRevision: () => revision,
    getBalance: async () => {
      const scope = capture()
      const balance = await call(scope, (saved, abort) => native.getBalance(saved, abort))
      const amount = Number(balance.amount)
      scope.entry.account.quota = amount
      return { quota: amount, usedQuota: 0, quotaPerUnit: 1, quotaDisplayType: 'USD', usdExchangeRate: 1, displayAmount: amount }
    },
    getProfile: async () => {
      const scope = capture()
      const profile = await call(scope, (saved, abort) => native.getProfile(saved, abort))
      scope.entry.account = accountProfile(profile)
      return detailProfile(profile)
    },
    updateDisplayName: async (input) => {
      const scope = capture()
      const profile = await call(scope, (saved, abort) => native.updateProfile(saved, { username: input.displayName }, abort), true)
      scope.entry.account = accountProfile(profile)
      scope.entry.saved = parseRealmSavedAccount({ ...scope.entry.saved, username: profile.username })
      changed()
      return { updated: true }
    },
    listUsableGroups: async () => {
      const available = await groups(capture())
      const names = available.map((group) => group.name)
      return available.filter((group) => names.indexOf(group.name) === names.lastIndexOf(group.name))
        .map((group) => ({ name: group.name, description: group.platform, ratio: group.rateMultiplier ?? '' }))
    },
    listKeys: async (input = {}) => {
      const scope = capture()
      const page = input.page ?? 1
      const pageSize = input.pageSize ?? 20
      const batch = await call(scope, (saved, abort) => native.listKeys(saved, page, pageSize, abort))
      const available = await groups(scope)
      return { page, pageSize, total: batch.total, keys: batch.items.map((key) => ({
        id: Number(key.id), name: key.name, maskedKey: key.maskedKey ?? '••••••••',
        group: available.find((group) => group.id === key.groupId)?.name ?? '',
        status: { active: 1, inactive: 2, expired: 3, quota_exhausted: 4 }[key.status],
        remainQuota: Math.max(0, (key.quota ?? 0) - (key.quotaUsed ?? 0)), unlimitedQuota: key.quota === 0,
        usedQuota: key.quotaUsed ?? 0, createdAt: key.createdAt ?? '', expiredAt: key.expiresAt ?? null, accessedAt: key.lastUsedAt ?? null,
      })) }
    },
    identifyKey: async (secret) => {
      const fingerprint = summarizeKeySecret(secret).keyFingerprint
      if (!fingerprint) return null
      const scope = capture()
      const matches = (await allKeys(scope)).filter((key) => key.keyFingerprint === fingerprint)
      if (matches.length !== 1) return null
      const key = matches[0]
      const available = await groups(scope)
      const matchedGroup = available.find((group) => group.id === key.groupId)
      if (!matchedGroup || available.filter((group) => group.name === matchedGroup.name).length !== 1) return null
      return { id: Number(key.id), name: key.name, group: matchedGroup.name }
    },
    revealKey: async (id) => call(capture(), (saved, abort) => native.revealKey(saved, positiveId(id), abort)),
    revokeKey: async (id) => call(capture(), (saved, abort) => native.revokeKey(saved, positiveId(id), abort), true),
    createKey: async (input) => {
      const scope = capture()
      await create(scope, input, await resolveGroup(scope, input.group))
    },
    updateKey: async (input) => {
      const scope = capture()
      const settings = keySettings(input)
      const id = positiveId(input.id)
      const group = await resolveGroup(scope, input.group)
      const existing = await call(scope, (saved, abort) => native.getKey(saved, id, abort))
      if (existing.quotaUsed === undefined && !input.unlimitedQuota) throw new RealmAccountError('PROTOCOL')
      await call(scope, (saved, abort) => native.updateKey(saved, id, { name: settings.name, groupId: group.id,
        quota: input.unlimitedQuota ? 0 : settings.quota + existing.quotaUsed!, expiresAt: settings.expiresAt }, abort), true)
    },
    changePassword: async (input) => {
      const scope = capture()
      await call(scope, (saved, abort) => native.changePassword(saved, { oldPassword: input.originalPassword, newPassword: input.newPassword }, abort), true)
      // Sub2API increments TokenVersion and revokes all tokens on password change.
      clear(scope)
      return { changed: true }
    },
    provisionCliKey: async (input: NewApiProvisionCliKeyInput = {}) => {
      const scope = capture()
      const captured = { ...input }
      const pending = provisionTail.then(async () => {
        assertCurrent(scope)
        const groupName = captured.group ?? sub2ApiManagedCliKeyProfiles.codex.group
        const name = keyName(captured.name ?? sub2ApiManagedCliKeyProfiles.codex.keyName)
        const group = await resolveGroup(scope, groupName)
        const existing = (await allKeys(scope)).filter((key) => key.name === name && key.groupId === group.id && usable(key))
          .sort((a, b) => Number(b.id) - Number(a.id))[0]
        const key = existing ?? await create(scope, { name, group: groupName, remainQuota: captured.remainQuota ?? 0,
          unlimitedQuota: captured.unlimitedQuota ?? true, expiredTime: captured.expiredTime ?? -1 }, group)
        return reveal(scope, key)
      })
      provisionTail = pending.catch(() => undefined)
      return pending
    },
    findExistingCliKey: async (prefix) => {
      const scope = capture()
      const name = keyName(prefix)
      const available = await groups(scope)
      const expected = Object.values(sub2ApiManagedCliKeyProfiles).find((profile) => profile.keyName === name)?.group
      const validGroups = available.filter((group) => (!expected || group.name === expected)
        && available.filter((other) => other.name === group.name).length === 1)
      const matches = (await allKeys(scope)).filter((key) => key.name.startsWith(name) && usable(key)
        && validGroups.some((group) => group.id === key.groupId))
      if (!matches.length) return null
      if (new Set(matches.map((key) => key.groupId)).size !== 1) throw new Error('API Key 前缀对应多个分组，请指定分组重新初始化')
      return reveal(scope, matches.sort((a, b) => Number(b.id) - Number(a.id))[0])
    },
    getTopupInfo: unsupported, quoteTopupAmount: unsupported, createTopupPayment: unsupported,
    listTopupOrders: unsupported, redeemTopupCode: unsupported, transferAffiliateQuota: unsupported,
    listSubscriptionPlans: unsupported, getSubscriptionSelf: unsupported, updateSubscriptionPreference: unsupported,
    createSubscriptionPayment: unsupported, purchaseSubscriptionWithBalance: unsupported,
    getUsage: unsupported, getDashboard: unsupported, getTasks: unsupported,
    listLoginSessions: unsupported, revokeLoginSession: unsupported, revokeOtherLoginSessions: unsupported,
    // Cookie envelopes are never accepted here. Main uses restore(RealmSavedAccount).
    restoreSession: unsupported, switchSession: unsupported,
  }

  return Object.freeze({ client: Object.freeze(client), getSavedAccount: () => active?.saved ?? null,
    restore: async (input: RealmSavedAccount) => {
      const saved = parseRealmSavedAccount(input)
      if (saved.realmId !== 'api-account' || saved.credential.kind !== 'sub2api') throw new RealmAccountError('INVALID')
      const attempt = ++revision
      try {
        const candidate = await native.restore(saved, signal, async (rotated) => {
          if (revision !== attempt) throw new RealmAccountError('STALE')
          await options.onCredentialRotation?.(rotated)
          if (revision !== attempt) throw new RealmAccountError('STALE')
        })
        if (revision !== attempt) throw new RealmAccountError('STALE')
        const profile = await native.getProfile(candidate, signal)
        if (revision !== attempt) throw new RealmAccountError('STALE')
        install(candidate, profile)
        return true
      } catch (error) {
        if (revision !== attempt) throw new RealmAccountError('STALE')
        if (error instanceof RealmAccountError && error.code === 'UNAUTHORIZED') return false
        throw error
      }
    },
  })
}
