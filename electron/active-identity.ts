/**
 * Main-process-only identity snapshots. This is an ownership guard, not an
 * IPC authorization layer and not a transaction/remote-request cancellation
 * mechanism. Callers still need to check their sender and check ownership
 * immediately before publishing a result or committing a local write.
 */
export interface AccountIdentitySource {
  getSessionState(): {
    authenticated: boolean
    account: { userId: number } | null
  }
  // Required here: silently treating a missing revision as zero would allow
  // an old request to survive logout and re-login as the same user.
  getSessionRevision(): number
}

export interface AccountRealmBinding {
  readonly siteId: string
  readonly realmId: string
  readonly accountOrigin: string
}

export interface ActiveIdentity extends AccountRealmBinding {
  readonly userId: string
  readonly sessionRevision: number
}

export interface ActiveIdentityReader {
  read(): ActiveIdentity | null
  capture(): ActiveIdentity
  assertCurrent(identity: unknown): void
}

export function createActiveIdentityReader(
  binding: AccountRealmBinding,
  source: AccountIdentitySource,
): ActiveIdentityReader {
  // Copy only identity metadata. Never spread a profile/session object: it
  // could grow token/cookie fields later without changing this module.
  const realm = Object.freeze({
    siteId: binding.siteId,
    realmId: binding.realmId,
    accountOrigin: binding.accountOrigin,
  })
  const issued = new WeakSet<object>()
  let lastRevision = -1

  function revision(): number {
    const value = source.getSessionRevision()
    if (!Number.isSafeInteger(value) || value < 0 || value < lastRevision) {
      throw new Error('账号会话版本无效，请重新登录')
    }
    lastRevision = value
    return value
  }

  function read(): ActiveIdentity | null {
    const before = revision()
    const state = source.getSessionState()
    if (revision() !== before) throw new Error('账号上下文已变化，请重试')
    if (!state.authenticated) return null
    const userId = state.account?.userId
    // This wave only consumes new-api's numeric ID contract. A sub2api
    // adapter must introduce an explicitly verified neutral ID contract,
    // not coerce an arbitrary/unsafe number here.
    if (!Number.isSafeInteger(userId) || typeof userId !== 'number' || userId <= 0) {
      throw new Error('账号身份无效，请重新登录')
    }
    const identity = Object.freeze({ ...realm, userId: String(userId), sessionRevision: before })
    issued.add(identity)
    return identity
  }

  function capture(): ActiveIdentity {
    const identity = read()
    if (!identity) throw new Error('请先登录账号')
    return identity
  }

  function assertCurrent(identity: unknown): void {
    // Only objects minted by this reader are accepted. A copied IPC object
    // or a snapshot from another runtime with matching fields is not proof
    // of ownership. WeakSet does not retain completed-request snapshots.
    if (typeof identity !== 'object' || identity === null || !issued.has(identity)) {
      throw new Error('账号上下文无效')
    }
    const captured = identity as ActiveIdentity
    const current = read()
    if (!current || current.userId !== captured.userId
      || current.sessionRevision !== captured.sessionRevision) {
      throw new Error('账号上下文已变化，请重试')
    }
  }

  return Object.freeze({ read, capture, assertCurrent })
}
