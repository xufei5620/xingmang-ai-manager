import {
  accountRealms, captureRealmLogin, parseRealmSavedAccount, realmForExplicitSite, realmOwnerKey,
  RealmAccountError, type AccountRealmId, type RealmSavedAccount,
} from './realm-account'
import type { RealmAccountVault, RealmLoginHintSummary } from './realm-account-vault'
import { NewApiLoginRejectedError } from './new-api-client'
import type { RelayBackendCapabilities, RelayBackendClient } from './relay-backend'
import type { NewApiLoginInput, NewApiLoginResult, NewApiPersistableSession, NewApiSessionState } from './new-api-client'
import { savedAccountId, type SavedAccountSummary } from './saved-accounts'

export type RealmAccountSiteId = 'solov' | 'solov-api'
export interface RealmAccountSessionState extends NewApiSessionState {
  siteId: RealmAccountSiteId
  realmId: AccountRealmId
  capabilities: RelayBackendCapabilities
}
export interface RealmAccountLoginResult extends NewApiLoginResult {
  siteId: RealmAccountSiteId
  realmId: AccountRealmId
  capabilities: RelayBackendCapabilities
}
export interface RealmAccountClientHandle {
  client: RelayBackendClient
  restore(saved: RealmSavedAccount): Promise<boolean>
  getSavedAccount(): RealmSavedAccount | null
}
export interface RealmAccountServiceOptions {
  vault: RealmAccountVault
  createClient(siteId: RealmAccountSiteId, onSessionChange: (account: RealmSavedAccount | null) => void): RealmAccountClientHandle
  /** Drain the host's real work before preparing a different identity. */
  quiesce(): Promise<void>
  prepareTimeoutMs?: number
  onChanged?(siteId: RealmAccountSiteId, session: RealmAccountSessionState): void
  legacy?: {
    list(): Promise<SavedAccountSummary[]>
    getSession(id: string, origin: string): Promise<NewApiPersistableSession | null>
    readActive(): Promise<NewApiPersistableSession | null>
  }
}
export interface RealmAccountService {
  readonly client: RelayBackendClient
  getSiteId(): RealmAccountSiteId
  assertReady(): void
  getPublicClient(siteId: RealmAccountSiteId): RelayBackendClient
  login(input: NewApiLoginInput & { siteId?: RealmAccountSiteId }): Promise<RealmAccountLoginResult>
  logout(): Promise<void>
  listSavedAccounts(): Promise<SavedAccountSummary[]>
  switchSavedAccount(id: string): Promise<RealmAccountSessionState>
  removeSavedAccount(id: string): Promise<void>
  restoreActive(): Promise<boolean>
  migrateLegacy(): Promise<void>
  latestLoginHint(): Promise<RealmLoginHintSummary | null>
}
interface RuntimeHandle extends RealmAccountClientHandle {
  siteId: RealmAccountSiteId
  saved: RealmSavedAccount | null
  persistence: Promise<void>
  expiredAtRevision: number | null
}

/** Promote the authenticated client itself: rotating cookies are never restored twice. */
export function createRealmAccountService(options: RealmAccountServiceOptions): RealmAccountService {
  let active: RuntimeHandle
  let revision = 0
  let busy = false
  let quiescing = false
  let notifyPending = false
  let prepareDeadline = 0
  let migration: Promise<void> | undefined
  const prepareTimeoutMs = options.prepareTimeoutMs ?? 30000
  if (!Number.isSafeInteger(prepareTimeoutMs) || prepareTimeoutMs < 1 || prepareTimeoutMs > 120000) throw new RealmAccountError('INVALID')
  const publicClients = new Map<RealmAccountSiteId, RelayBackendClient>()
  const publicMethods = new Set<keyof RelayBackendClient>([
    'getLegalDocument', 'sendEmailVerification', 'sendPasswordResetEmail', 'resetPassword', 'register',
  ])

  function site(value: unknown): RealmAccountSiteId {
    if (value !== 'solov' && value !== 'solov-api') throw new RealmAccountError('INVALID')
    return value
  }
  function assertReady(): void {
    if (busy) throw new RealmAccountError('BUSY')
  }
  function metadata(handle = active) {
    return { siteId: handle.siteId, realmId: realmForExplicitSite(handle.siteId), capabilities: handle.client.capabilities }
  }
  function session(): RealmAccountSessionState {
    return { ...active.client.getSessionState(), ...metadata() }
  }
  function changed(): void {
    // A renderer/window callback cannot roll back an already committed identity.
    try { void Promise.resolve(options.onChanged?.(active.siteId, session())).catch(() => undefined) } catch { /* identity is committed */ }
  }
  function requestChanged(): void {
    if (busy) notifyPending = true
    else changed()
  }
  async function prepare<T>(operation: () => Promise<T>): Promise<T> {
    const remaining = prepareDeadline - Date.now()
    if (remaining <= 0) throw new RealmAccountError('TIMEOUT')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RealmAccountError('TIMEOUT')), remaining)
      })])
    } finally { clearTimeout(timer) }
  }
  function advance(): void {
    if (!Number.isSafeInteger(revision + 1)) throw new RealmAccountError('STALE')
    revision += 1
  }
  function createHandle(siteId: RealmAccountSiteId): RuntimeHandle {
    let handle: RuntimeHandle | undefined
    const created = options.createClient(siteId, (value) => {
      // Already-running requests may rotate credentials while being drained.
      // Once quiescence completes, detached late work cannot race a durable
      // candidate commit (including a re-login as the same numeric owner).
      if (!handle || active !== handle || (busy && !quiescing)) return
      const captured = handle
      try {
        const previous = captured.saved
        const saved = value === null ? null : validate(captured, value, previous ?? undefined)
        captured.saved = saved
        if (saved) captured.persistence = options.vault.updateSession(saved)
        else {
          advance()
          captured.expiredAtRevision = revision
          captured.persistence = previous ? options.vault.signOut(previous) : Promise.resolve()
        }
        // The callback is synchronous. Forward storage failures through the
        // originating business promise rather than making them unhandled.
        void captured.persistence.then(() => { if (active === captured) requestChanged() }, () => undefined)
      } catch (error) {
        captured.persistence = Promise.reject(error)
        void captured.persistence.catch(() => undefined)
      }
    })
    handle = { ...created, siteId, saved: null, persistence: Promise.resolve(), expiredAtRevision: null }
    return handle
  }
  active = createHandle('solov')

  function validate(handle: RuntimeHandle, value: RealmSavedAccount, expected?: RealmSavedAccount): RealmSavedAccount {
    const saved = parseRealmSavedAccount(value)
    const state = handle.client.getSessionState()
    if (saved.realmId !== realmForExplicitSite(handle.siteId) || !state.authenticated || !state.account
      || state.account.userId !== Number(saved.userId)
      || (expected && realmOwnerKey(expected) !== realmOwnerKey(saved))) throw new RealmAccountError('PROTOCOL')
    return saved
  }
  function candidateSaved(handle: RuntimeHandle, expected?: RealmSavedAccount): RealmSavedAccount {
    const saved = handle.getSavedAccount()
    if (!saved) throw new RealmAccountError('PROTOCOL')
    return validate(handle, saved, expected)
  }
  function dispose(handle: RuntimeHandle): void {
    try { handle.client.logout() } catch { /* detached credentials cannot affect the active client */ }
  }
  function getPublicClient(siteId: RealmAccountSiteId): RelayBackendClient {
    const selected = site(siteId)
    let client = publicClients.get(selected)
    if (!client) {
      client = options.createClient(selected, () => undefined).client
      publicClients.set(selected, client)
    }
    return client
  }

  function migrateLegacy(): Promise<void> {
    if (!migration) {
      migration = (async () => {
        if (await options.vault.hasMigratedLegacy()) return
        const legacy = options.legacy
        if (!legacy) { await options.vault.migrateLegacy([]); return }
        const summaries = await legacy.list()
        const records = []
        for (const entry of summaries) {
          if (entry.origin !== accountRealms['xm-account'].origin) continue
          const persisted = await legacy.getSession(entry.id, entry.origin)
          if (persisted) records.push({ ...persisted, origin: entry.origin, username: entry.username })
        }
        const saved = await legacy.readActive()
        const selected = saved ? { ...saved, origin: accountRealms['xm-account'].origin,
          username: summaries.find((entry) => entry.origin === accountRealms['xm-account'].origin && entry.userId === saved.userId)?.username
            ?? `user-${saved.userId}` } : undefined
        // The current session file may contain a newer rotating cookie than
        // the old account list. It wins only within this one-time import.
        const values = selected ? records.filter((entry) => entry.userId !== selected.userId).concat(selected) : records
        await options.vault.migrateLegacy(values, selected)
      })().catch((error) => { migration = undefined; throw error })
    }
    return migration
  }

  async function transition<T>(operation: () => Promise<T>): Promise<T> {
    if (busy) throw new RealmAccountError('BUSY')
    advance()
    busy = true
    quiescing = true
    try {
      await migrateLegacy()
      prepareDeadline = Date.now() + prepareTimeoutMs
      await prepare(options.quiesce)
      // A previous failed refresh write must not permanently prevent a new
      // login after the OS storage service becomes available again.
      await active.persistence.catch(() => undefined)
      quiescing = false
      return await operation()
    } finally {
      busy = false
      quiescing = false
      if (notifyPending) { notifyPending = false; changed() }
    }
  }
  async function promote(handle: RuntimeHandle, expected?: RealmSavedAccount, identifier?: string): Promise<void> {
    const saved = candidateSaved(handle, expected)
    await options.vault.activate(saved, identifier)
    // No await between durable commit and the synchronous pointer swap.
    const previous = active
    handle.saved = saved
    active = handle
    dispose(previous)
    requestChanged()
  }
  async function login(input: NewApiLoginInput & { siteId?: RealmAccountSiteId }): Promise<RealmAccountLoginResult> {
    const selected = input?.siteId === undefined ? undefined : site(input.siteId)
    const captured = captureRealmLogin({ identifier: input?.username, password: input?.password, turnstileToken: input?.turnstileToken })
    return transition(async () => {
      const preferred = selected ?? await options.vault.preferredLoginSite(captured.identifier) ?? 'solov'
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(captured.identifier)
      const candidates: RealmAccountSiteId[] = selected || !email ? [preferred]
        : [preferred, preferred === 'solov' ? 'solov-api' : 'solov']
      for (const siteId of candidates) {
        const candidate = createHandle(siteId)
        try {
          let result: NewApiLoginResult
          try {
            result = await prepare(() => candidate.client.login({ username: captured.identifier, password: captured.password,
              ...(captured.turnstileToken === undefined ? {} : { turnstileToken: captured.turnstileToken }) }))
          } catch (error) {
            // Only definitive password rejection permits another account
            // backend. A timeout, challenge, profile failure or bad response
            // must preserve the previous account instead of guessing.
            const rejected = error instanceof NewApiLoginRejectedError
              || (error instanceof RealmAccountError && error.code === 'LOGIN_REJECTED')
            if (selected || !rejected) throw error
            continue
          }
          await promote(candidate, undefined, captured.identifier)
          return { ...result, ...metadata() }
        } finally { if (active !== candidate) dispose(candidate) }
      }
      throw new RealmAccountError('LOGIN_REJECTED')
    })
  }
  async function logout(): Promise<void> {
    return transition(async () => {
      const replacement = createHandle(active.siteId)
      await options.vault.signOut()
      const previous = active
      active = replacement
      dispose(previous)
      requestChanged()
    })
  }
  async function findSaved(id: string): Promise<RealmSavedAccount> {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new RealmAccountError('INVALID')
    const summary = (await options.vault.list()).find((entry) => savedAccountId(entry.origin, Number(entry.userId)) === id)
    const saved = summary ? await options.vault.get(summary) : null
    if (!saved) throw new RealmAccountError('SIGNED_OUT')
    return saved
  }
  async function restore(saved: RealmSavedAccount): Promise<boolean> {
    const candidate = createHandle(site(accountRealms[saved.realmId].siteId))
    try {
      if (!await prepare(() => candidate.restore(saved))) return false
      await promote(candidate, saved)
      return true
    } finally { if (active !== candidate) dispose(candidate) }
  }
  async function restoreActive(): Promise<boolean> {
    return transition(async () => {
      const saved = await options.vault.active()
      if (!saved) return false
      try { if (await restore(saved)) return true } catch (error) {
        if (!(error instanceof RealmAccountError) || error.code !== 'UNAUTHORIZED') throw error
      }
      await options.vault.signOut(saved)
      return false
    })
  }
  async function switchSavedAccount(id: string): Promise<RealmAccountSessionState> {
    return transition(async () => {
      const saved = await findSaved(id)
      if (active.saved && realmOwnerKey(active.saved) === realmOwnerKey(saved)) return session()
      if (!await restore(saved)) throw new RealmAccountError('UNAUTHORIZED')
      return session()
    })
  }
  async function listSavedAccounts(): Promise<SavedAccountSummary[]> {
    await migrateLegacy()
    return (await options.vault.list()).map((entry) => ({ id: savedAccountId(entry.origin, Number(entry.userId)),
      origin: entry.origin, userId: Number(entry.userId), username: entry.username, updatedAt: '' }))
  }
  async function removeSavedAccount(id: string): Promise<void> {
    if (busy) throw new RealmAccountError('BUSY')
    await migrateLegacy()
    const saved = await findSaved(id)
    if (busy || (active.saved && realmOwnerKey(saved) === realmOwnerKey(active.saved))) throw new RealmAccountError('BUSY')
    await options.vault.forget(saved)
  }

  // Methods are bound when called, not when a consumer obtains the function.
  // Promise results AND errors are checked after await, including ABA logins.
  const client = new Proxy({} as RelayBackendClient, {
    get(_target, property) {
      if (property === 'capabilities') return active.client.capabilities
      if (property === 'getSessionState') return session
      if (property === 'getSessionRevision') return () => revision
      if (property === 'getActiveSiteId') return () => active.siteId
      if (property === 'login') return login
      if (property === 'logout') return logout
      if (property === 'getPersistableSession') return () => active.siteId === 'solov' ? active.client.getPersistableSession?.() ?? null : null
      if (property === 'restoreSession' || property === 'switchSession') return () => Promise.reject(new RealmAccountError('UNSUPPORTED'))
      if (typeof property !== 'string') return undefined
      if (publicMethods.has(property as keyof RelayBackendClient)) {
        return (...args: unknown[]) => {
          const selected = getPublicClient('solov')
          const method: unknown = Reflect.get(selected, property)
          if (typeof method !== 'function') throw new RealmAccountError('UNSUPPORTED')
          return Reflect.apply(method, selected, args)
        }
      }
      if (typeof Reflect.get(active.client, property) !== 'function') return undefined
      return async (...args: unknown[]) => {
        if (busy && property !== 'getStatus') throw new RealmAccountError('BUSY')
        const captured = active
        const epoch = revision
        const assertCurrent = () => {
          if (active !== captured || epoch !== revision || (busy && property !== 'getStatus')) throw new RealmAccountError('STALE')
        }
        try {
          const value: unknown = await Reflect.apply(Reflect.get(captured.client, property), captured.client, args)
          await captured.persistence
          // Password changes and revoking this device intentionally end the
          // session. Only their explicit success DTO and this handle's single
          // expiration qualify; another login/switch/logout still wins.
          const endsSession = value !== null && typeof value === 'object'
            && ((property === 'changePassword' && 'changed' in value && value.changed === true)
              || (property === 'revokeLoginSession' && 'current' in value && value.current === true))
          if (endsSession && !busy && active === captured
            && captured.expiredAtRevision === revision && revision === epoch + 1
            && !captured.client.getSessionState().authenticated) return value
          assertCurrent()
          return value
        } catch (error) { assertCurrent(); throw error }
      }
    },
  })
  return Object.freeze({ client, getSiteId: () => active.siteId, assertReady, getPublicClient, login, logout, listSavedAccounts,
    switchSavedAccount, removeSavedAccount, restoreActive, migrateLegacy,
    latestLoginHint: async () => { await migrateLegacy(); return options.vault.latestLoginHint() } })
}
