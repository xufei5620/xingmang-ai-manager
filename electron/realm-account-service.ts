import {
  accountRealms, captureRealmLogin, parseRealmSavedAccount, realmForExplicitSite, realmOwnerKey,
  RealmAccountError, type AccountRealmId, type RealmAccountOwner, type RealmSavedAccount,
} from './realm-account'
import type { RealmAccountVault, RealmLoginHintSummary } from './realm-account-vault'
import type { RelayBackendCapabilities, RelayBackendClient } from './relay-backend'
import type { NewApiLoginInput, NewApiLoginResult, NewApiPersistableSession, NewApiSessionState } from './new-api-client'
import { savedAccountId, type SavedAccountSummary } from './saved-accounts'

export type RealmAccountSiteId = 'solov' | 'solov-api'
export interface RealmAccountSessionState extends NewApiSessionState {
  siteId: RealmAccountSiteId
  realmId: AccountRealmId
  capabilities: RelayBackendCapabilities
  /** 只在开机恢复因为联不上而搁着时出现：登录还在本机，等下一次重试。 */
  restoring?: { account: { siteId: RealmAccountSiteId; userId: number }; retrying: true }
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
  /**
   * Best-effort server revocation of a stored credential this handle does not
   * hold. Never rejects; backends without a logout endpoint omit it.
   */
  endSavedSession?(saved: RealmSavedAccount): Promise<void>
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
  /** 开机恢复进行中时，正在恢复的那个账号；本机账号库读出来之前与恢复结束之后都是 null。 */
  restoringAccount(): { siteId: RealmAccountSiteId; userId: number } | null
  /**
   * 开机恢复登录没成、但不是因为登录失效（联不上、服务维护、超时）时，那个仍留在
   * 本机的账号；再调一次 restoreActive() 就是重试。恢复成功、确认失效、登录、
   * 退出或切换账号之后都是 null。
   */
  stalledAccount(): { siteId: RealmAccountSiteId; userId: number } | null
  migrateLegacy(): Promise<void>
  latestLoginHint(): Promise<RealmLoginHintSummary | null>
  loginHintOwner(identifier: string): Promise<RealmAccountOwner | null>
}
interface RuntimeHandle extends RealmAccountClientHandle {
  siteId: RealmAccountSiteId
  saved: RealmSavedAccount | null
  persistence: Promise<void>
  expiredAtRevision: number | null
}

function restoreMayRecover(error: unknown): boolean {
  return !(error instanceof RealmAccountError && ['INVALID', 'PROTOCOL', 'STORAGE', 'ACCOUNT_LIMIT', 'UNSUPPORTED'].includes(error.code))
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
  let restoring: { siteId: RealmAccountSiteId; userId: number } | null = null
  let stalled: { siteId: RealmAccountSiteId; userId: number } | null = null
  const prepareTimeoutMs = options.prepareTimeoutMs ?? 30000
  if (!Number.isSafeInteger(prepareTimeoutMs) || prepareTimeoutMs < 1 || prepareTimeoutMs > 120000) throw new RealmAccountError('INVALID')
  const publicClients = new Map<RealmAccountSiteId, RelayBackendClient>()
  const publicMethods = new Set<keyof RelayBackendClient>([
    'getLegalDocument', 'sendEmailVerification', 'register',
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
    const state = { ...active.client.getSessionState(), ...metadata() }
    // 界面据此留在首页、说「暂时连不上，登录还在」，而不是当成没登录退回欢迎页。
    return stalled && !state.authenticated ? { ...state, restoring: { account: { ...stalled }, retrying: true } } : state
  }
  function markStalled(value: typeof stalled): void {
    if (stalled?.siteId === value?.siteId && stalled?.userId === value?.userId) return
    stalled = value
    requestChanged()
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
  // 只给用户亲手点的「退出登录」用。切换账号、登录/恢复失败丢掉的候选句柄都走上面的
  // dispose：那些凭据还留在本机账号库里，在服务端注销掉就等于把保存的账号也登出了。
  // Fire-and-forget: the client captures its credentials synchronously, then
  // dispose() may clear them at once. The request has its own short timeout and
  // never rejects, so the local sign-out is neither blocked nor failed by it.
  function endServerSession(handle: RuntimeHandle): void {
    try { void Promise.resolve(handle.client.endServerSession?.()).catch(() => undefined) } catch { /* best effort */ }
  }
  function endSavedSession(handle: RuntimeHandle, saved: RealmSavedAccount): void {
    try { void Promise.resolve(handle.endSavedSession?.(saved)).catch(() => undefined) } catch { /* best effort */ }
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

  async function transition<T>(operation: () => Promise<T>, recoverForLogin = false): Promise<T> {
    if (busy) throw new RealmAccountError('BUSY')
    advance()
    busy = true
    quiescing = true
    try {
      // Only an explicit login without an active identity may replace an
      // unreadable vault. Startup and account switching must preserve it.
      if (recoverForLogin && active.saved === null && !active.client.getSessionState().authenticated
        && await options.vault.recoverUnreadable()) migration = undefined
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
  async function promote(handle: RuntimeHandle, expected?: RealmSavedAccount, identifier?: string, fresh = false): Promise<void> {
    const saved = candidateSaved(handle, expected)
    // 重新输密码登录同一个账号（#476）：新登录是服务端的一个新会话，本机账号库里这个
    // 账号原来那份凭据马上被覆盖，旧会话从此没人能用也没人去注销，攒到 50 个就登不进了。
    // 所以提交成功后把它注销掉。切换已保存账号、开机恢复用的就是库里那份，不能动。
    // 读不出库里原来那份就不往下写：写了就把它盖掉，那个旧会话再也没人能注销（#476
    // 复核 F05）。这里报错后 login 的 finally 会把刚登上的新会话注销，本机什么都没变。
    const stored = fresh ? await options.vault.get(saved).catch(() => { throw new RealmAccountError('STORAGE') }) : null
    await options.vault.activate(saved, identifier)
    // No await between durable commit and the synchronous pointer swap.
    const previous = active
    handle.saved = saved
    active = handle
    stalled = null
    if (fresh) {
      // The running client holds the freshest (possibly rotated) credential of
      // the replaced session; the vault copy only covers a signed-out or
      // stalled client whose record outlived its in-memory session.
      if (previous.saved && realmOwnerKey(previous.saved) === realmOwnerKey(saved)) endServerSession(previous)
      else if (stored && JSON.stringify(stored.credential) !== JSON.stringify(saved.credential)) endSavedSession(handle, stored)
    }
    dispose(previous)
    requestChanged()
  }
  async function login(input: NewApiLoginInput & { siteId?: RealmAccountSiteId }): Promise<RealmAccountLoginResult> {
    const selected = input?.siteId === undefined ? undefined : site(input.siteId)
    const captured = captureRealmLogin({ identifier: input?.username, password: input?.password, turnstileToken: input?.turnstileToken })
    return transition(async () => {
      // Exactly one account backend ever receives the plaintext password. The
      // site is either the caller's explicit choice or the deterministic hint
      // this machine already recorded for the identifier; a rejection ends the
      // attempt. Probing the other backend with the same secret would hand a
      // password the user only ever meant for one site to both of them.
      const siteId = selected ?? await options.vault.preferredLoginSite(captured.identifier) ?? 'solov'
      const candidate = createHandle(siteId)
      try {
        const result = await prepare(() => candidate.client.login({ username: captured.identifier, password: captured.password,
          ...(captured.turnstileToken === undefined ? {} : { turnstileToken: captured.turnstileToken }) }))
        await promote(candidate, undefined, captured.identifier, true)
        return { ...result, ...metadata() }
      } finally {
        // 服务端已经登上、本机却没存下来（账号库写失败、校验不过）：这个会话本机再也
        // 找不到，当场注销，别让它占着服务端的登录名额（#476）。没登上时这里什么也不发。
        if (active !== candidate) {
          if (candidate.client.getSessionState().authenticated) endServerSession(candidate)
          dispose(candidate)
        }
      }
    }, true)
  }
  async function logout(): Promise<void> {
    return transition(async () => {
      const replacement = createHandle(active.siteId)
      // 先把本机账号库里的这份凭据删掉再注销服务端：本机删不掉（存储出错）时
      // 退出整体失败、登录照旧可用，不能出现本机还「登着」而服务端已经作废的状态。
      await options.vault.signOut()
      const previous = active
      active = replacement
      stalled = null
      endServerSession(previous)
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
    if (stalled && !busy) return retryStalled()
    return transition(async () => {
      const saved = await options.vault.active()
      if (!saved) { markStalled(null); return false }
      const userId = Number(saved.userId)
      const owner = Number.isSafeInteger(userId) && userId > 0 ? { siteId: site(accountRealms[saved.realmId].siteId), userId } : null
      restoring = owner
      try {
        try { if (await restore(saved)) return true } catch (error) {
          // 只有服务明确说登录失效（401）才清掉本机登录。联不上、维护、超时都不是
          // 凭据的问题：登录留着，记下来等重试，界面也不按「没登录」处理。
          if (!(error instanceof RealmAccountError) || error.code !== 'UNAUTHORIZED') {
            // 本机记录本身读不通（格式、存储）再试也不会好：登录照旧留着，但不挂
            // 「稍后重试」，免得界面一直停在「暂时连不上」而用户找不到登录入口。
            markStalled(restoreMayRecover(error) ? owner : null)
            throw error
          }
        }
        await options.vault.signOut(saved)
        markStalled(null)
        return false
      } finally { restoring = null }
    })
  }
  // 「暂时连不上，登录还在」之后的自动重试（全面检测 Q9）。以前每次重试都走一遍
  // transition：先推 revision、再占 busy，网络那一段（超时时十几秒）里读工具配置、
  // 打开工具、保存、一键切回官方全报「账号切换正在进行」，正在跑的保存做完了又报
  // 「账号上下文已变化」。可这时当前身份本来就是未登录，没有什么要保护的：续期只动
  // 一个还没接上的候选句柄。所以网络那段不占锁，只在真要换身份的那一下进 transition。
  //
  // The refresh may rotate the saved cookie on the server. When the candidate
  // cannot be promoted (the user logged in meanwhile, or quiescing failed),
  // its rotated credential is written back to the untouched vault record, or
  // the next retry would present a cookie the server has already retired.
  let retrying = false
  async function retryStalled(): Promise<boolean> {
    if (retrying) return false
    retrying = true
    try {
      await migrateLegacy()
      const saved = await options.vault.active()
      if (!saved) { markStalled(null); return false }
      const userId = Number(saved.userId)
      const owner = Number.isSafeInteger(userId) && userId > 0 ? { siteId: site(accountRealms[saved.realmId].siteId), userId } : null
      const epoch = revision
      const candidate = createHandle(site(accountRealms[saved.realmId].siteId))
      restoring = owner
      let restored = false
      try {
        try { restored = await withinRestoreBudget(() => candidate.restore(saved)) } catch (error) {
          if (!(error instanceof RealmAccountError) || error.code !== 'UNAUTHORIZED') {
            // 等的这段时间里用户自己登录、切换或退出过，就别把「等重试」的标记再挂回去：
            // 那会让新登录的账号被下一轮重试当成掉线的去恢复。
            if (revision === epoch && stalled !== null) markStalled(restoreMayRecover(error) ? owner : null)
            throw error
          }
        }
        return await transition(async () => {
          // 等网络的这段时间里，用户可能已经自己登录、切换或退出：那一次说了算。
          const current = await options.vault.active()
          if (revision !== epoch + 1 || stalled === null || !current || realmOwnerKey(current) !== realmOwnerKey(saved)) return false
          if (!restored) {
            await options.vault.signOut(saved)
            markStalled(null)
            return false
          }
          await promote(candidate, saved)
          return true
        })
      } finally {
        restoring = null
        if (active !== candidate) {
          if (restored) await keepRotatedCredential(candidate, saved)
          dispose(candidate)
        }
      }
    } finally { retrying = false }
  }
  async function withinRestoreBudget<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RealmAccountError('TIMEOUT')), prepareTimeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
  async function keepRotatedCredential(candidate: RuntimeHandle, saved: RealmSavedAccount): Promise<void> {
    try {
      const rotated = candidateSaved(candidate, saved)
      const stored = await options.vault.get(saved)
      // 只在本机记录还是出发时那一份时写回；这期间重新登录过同一个账号就以那次为准。
      if (stored && JSON.stringify(stored) === JSON.stringify(saved)) await options.vault.updateSession(rotated)
    } catch { /* the next retry reports whatever is still wrong */ }
  }
  async function switchSavedAccount(id: string): Promise<RealmAccountSessionState> {
    return transition(async () => {
      const saved = await findSaved(id)
      if (active.saved && realmOwnerKey(active.saved) === realmOwnerKey(saved)) return session()
      let restored: boolean
      try { restored = await restore(saved) } catch (error) {
        if (error instanceof RealmAccountError && error.code === 'UNAUTHORIZED') throw new RealmAccountError('SAVED_EXPIRED')
        throw error
      }
      if (!restored) throw new RealmAccountError('SAVED_EXPIRED')
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
      // Server-side revocation belongs to logout() alone; no business caller may
      // end the active session behind the vault's back.
      if (property === 'endServerSession' || property === 'endPersistedServerSession') return undefined
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
    restoringAccount: () => restoring ? { ...restoring } : null,
    stalledAccount: () => stalled ? { ...stalled } : null,
    latestLoginHint: async () => { await migrateLegacy(); return options.vault.latestLoginHint() },
    loginHintOwner: async (identifier: string) => { await migrateLegacy(); return options.vault.loginHintOwner(identifier) } })
}
