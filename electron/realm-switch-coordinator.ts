import {
  captureRealmLogin, parseRealmSavedAccount, realmAccountSummary, realmForExplicitSite, realmOwnerKey,
  requireAccountRealm, RealmAccountError, type AccountRealmId, type RealmAccountOwner,
  type RealmAccountSummary, type RealmLoginInput, type RealmSavedAccount, type RealmSessionBackend,
} from './realm-account'
import type { RealmAccountVault } from './realm-account-vault'

export interface RealmSwitchSnapshot {
  readonly phase: 'signed-out' | 'active' | 'switching'
  readonly epoch: number
  readonly account: RealmAccountSummary | null
}

export interface OwnedRealmResult<T> {
  readonly epoch: number
  readonly owner: RealmAccountOwner
  readonly value: T
}

export interface RealmSwitchOptions {
  readonly backends: readonly RealmSessionBackend[]
  readonly enabledRealms: readonly AccountRealmId[]
  readonly vault: RealmAccountVault
  /** Must drain host tasks and reject when running external CLIs prevent a safe switch. */
  quiesce(owner: RealmAccountSummary | null, signal: AbortSignal): Promise<void>
  readonly prepareTimeoutMs?: number
}

export interface RealmSwitchCoordinator {
  snapshot(): RealmSwitchSnapshot
  login(siteId: unknown, input: RealmLoginInput): Promise<RealmSwitchSnapshot>
  switchAccount(owner: RealmAccountOwner): Promise<RealmSwitchSnapshot>
  restoreActive(): Promise<RealmSwitchSnapshot>
  signOut(): Promise<RealmSwitchSnapshot>
  forget(owner: RealmAccountOwner): Promise<void>
  execute<T>(operation: (session: RealmSavedAccount, signal: AbortSignal) => Promise<T>): Promise<OwnedRealmResult<T>>
  /** Check immediately before publishing an IPC result or making a local commit; no await after it. */
  assertCurrent(result: unknown): void
}

/**
 * Main-only two-phase switch: prepare against an immutable candidate, then
 * atomically save the account AND active pointer before publishing in memory.
 * Switching never calls logout and never deletes the previous saved account.
 * Backend requests cannot be rolled back; a failed disk commit can still
 * require re-login after a server-side rotating refresh token was consumed.
 */
export function createRealmSwitchCoordinator(options: RealmSwitchOptions): RealmSwitchCoordinator {
  const backends = new Map<AccountRealmId, RealmSessionBackend>()
  for (const backend of options.backends) {
    const realm = requireAccountRealm(backend.realmId)
    if (backends.has(realm)) throw new RealmAccountError('INVALID')
    backends.set(realm, backend)
  }
  const enabled = new Set(options.enabledRealms.map(requireAccountRealm))
  const timeoutMs = options.prepareTimeoutMs ?? 30000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || typeof options.quiesce !== 'function') throw new RealmAccountError('INVALID')
  let active: RealmSavedAccount | null = null
  let busy = false
  let epoch = 0
  const work = new Set<AbortController>()
  const issued = new WeakSet<object>()

  function backendFor(realm: AccountRealmId): RealmSessionBackend {
    const backend = backends.get(requireAccountRealm(realm))
    if (!enabled.has(realm) || !backend) throw new RealmAccountError('DISABLED')
    return backend
  }

  function snapshot(): RealmSwitchSnapshot {
    return Object.freeze({ phase: busy ? 'switching' : active ? 'active' : 'signed-out', epoch,
      account: active ? realmAccountSummary(active) : null })
  }

  function advance(): void {
    if (!Number.isSafeInteger(epoch + 1)) throw new RealmAccountError('STALE')
    epoch += 1
  }

  async function transition(prepare: (signal: AbortSignal) => Promise<RealmSavedAccount | null>): Promise<RealmSwitchSnapshot> {
    if (busy) throw new RealmAccountError('BUSY')
    advance()
    busy = true
    for (const controller of work) controller.abort()
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new RealmAccountError('TIMEOUT')) }, timeoutMs)
      })
      const preparing = (async () => {
        await options.quiesce(active ? realmAccountSummary(active) : null, controller.signal)
        if (controller.signal.aborted) throw new RealmAccountError('ABORTED')
        const candidate = await prepare(controller.signal)
        if (controller.signal.aborted) throw new RealmAccountError('ABORTED')
        return candidate === null ? null : parseRealmSavedAccount(candidate)
      })()
      const candidate = await Promise.race([preparing, deadline])
      clearTimeout(timer)
      // Do not race the durable commit against a timer: a delayed successful
      // rename must never be reported as a rollback with different memory state.
      if (candidate) await options.vault.activate(candidate)
      else await options.vault.signOut()
      active = candidate
      busy = false
      return snapshot()
    } catch (error) {
      // The prior active credential is retained. Its old epoch stays invalid.
      busy = false
      throw error instanceof RealmAccountError ? error : new RealmAccountError('NETWORK')
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  function validateCandidate(value: RealmSavedAccount, realm: AccountRealmId, expected?: string): RealmSavedAccount {
    const candidate = parseRealmSavedAccount(value)
    if (candidate.realmId !== realm || (expected !== undefined && realmOwnerKey(candidate) !== expected)) throw new RealmAccountError('PROTOCOL')
    return candidate
  }

  function assertCurrent(result: unknown): void {
    if (typeof result !== 'object' || result === null || !issued.has(result)) throw new RealmAccountError('STALE')
    const captured = result as OwnedRealmResult<unknown>
    if (busy || !active || captured.epoch !== epoch || realmOwnerKey(captured.owner) !== realmOwnerKey(active)) throw new RealmAccountError('STALE')
  }

  return Object.freeze({
    snapshot,
    login: (siteId: unknown, input: RealmLoginInput) => {
      const realm = realmForExplicitSite(siteId)
      const backend = backendFor(realm)
      const captured = captureRealmLogin(input)
      return transition(async (signal) => validateCandidate(await backend.authenticate(captured, signal), realm))
    },
    switchAccount: (owner: RealmAccountOwner) => {
      const id = realmOwnerKey(owner)
      const realm = requireAccountRealm(owner.realmId)
      const capturedOwner = Object.freeze({ realmId: realm, userId: owner.userId })
      const backend = backendFor(realm)
      return transition(async (signal) => {
        const saved = await options.vault.get(capturedOwner)
        if (!saved) throw new RealmAccountError('SIGNED_OUT')
        if (signal.aborted) throw new RealmAccountError('ABORTED')
        return validateCandidate(await backend.restore(saved, signal), realm, id)
      })
    },
    restoreActive: () => transition(async (signal) => {
      const saved = await options.vault.active()
      if (!saved) return null
      const backend = backendFor(saved.realmId)
      if (signal.aborted) throw new RealmAccountError('ABORTED')
      return validateCandidate(await backend.restore(saved, signal), saved.realmId, realmOwnerKey(saved))
    }),
    signOut: () => transition(async () => null),
    forget: async (owner: RealmAccountOwner) => {
      const id = realmOwnerKey(owner)
      if (busy || (active && realmOwnerKey(active) === id)) throw new RealmAccountError('BUSY')
      await options.vault.forget(owner)
    },
    execute: async <T>(operation: (session: RealmSavedAccount, signal: AbortSignal) => Promise<T>): Promise<OwnedRealmResult<T>> => {
      if (busy) throw new RealmAccountError('BUSY')
      if (!active) throw new RealmAccountError('SIGNED_OUT')
      const session = active
      const capturedEpoch = epoch
      const controller = new AbortController()
      work.add(controller)
      try {
        const value = await operation(session, controller.signal)
        if (busy || controller.signal.aborted || active !== session || epoch !== capturedEpoch) throw new RealmAccountError('STALE')
        const result = Object.freeze({ epoch: capturedEpoch,
          owner: Object.freeze({ realmId: session.realmId, userId: session.userId }), value })
        issued.add(result)
        return result
      } catch (error) {
        if (busy || controller.signal.aborted || active !== session || epoch !== capturedEpoch) throw new RealmAccountError('STALE')
        throw error instanceof RealmAccountError ? error : new RealmAccountError('NETWORK')
      } finally { work.delete(controller) }
    },
    assertCurrent,
  })
}
