import {
  accountRealms, captureRealmLogin, parseRealmSavedAccount, RealmAccountError,
  type RealmLoginInput, type RealmSavedAccount, type RealmSessionBackend,
} from './realm-account'

/** The real createNewApiClient return type structurally satisfies this seam. */
export interface IsolatedNewApiRealmClient {
  login(input: { username: string; password: string; turnstileToken?: string }): Promise<unknown>
  restoreSession(saved: { userId: number; cookies: string[] }): Promise<boolean>
  getSessionState(): { authenticated: boolean; account: { userId: number; username: string } | null }
  getPersistableSession(): { userId: number; cookies: string[] } | null
  logout(): void
}

/**
 * Construct an isolated client with no main.ts onSessionChange callback.
 * Candidate authentication must not mutate the currently active client or
 * invoke its logout/remove-saved-account side effects. No new-api DTO changes.
 */
export function createNewApiRealmBackend(
  createClient: (options: { baseUrl: string }) => IsolatedNewApiRealmClient,
): RealmSessionBackend {
  async function prepare(
    action: (client: IsolatedNewApiRealmClient) => Promise<unknown>,
    signal: AbortSignal,
    expectedUserId?: string,
  ): Promise<RealmSavedAccount> {
    if (signal.aborted) throw new RealmAccountError('ABORTED')
    const client = createClient({ baseUrl: accountRealms['xm-account'].origin })
    function cancel(): void { client.logout() }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      await action(client)
      if (signal.aborted) throw new RealmAccountError('ABORTED')
      const state = client.getSessionState()
      const persisted = client.getPersistableSession()
      if (!state.authenticated || !state.account || !persisted || persisted.userId !== state.account.userId
        || (expectedUserId !== undefined && String(state.account.userId) !== expectedUserId)) throw new RealmAccountError('UNAUTHORIZED')
      return parseRealmSavedAccount({ version: 2, realmId: 'xm-account', origin: accountRealms['xm-account'].origin,
        userId: String(state.account.userId), username: state.account.username,
        credential: { kind: 'new-api', cookies: persisted.cookies } })
    } catch (error) {
      if (signal.aborted) throw new RealmAccountError('ABORTED')
      throw error instanceof RealmAccountError ? error : new RealmAccountError('NETWORK')
    } finally {
      signal.removeEventListener('abort', cancel)
      client.logout()
    }
  }
  return Object.freeze({
    realmId: 'xm-account',
    authenticate: (input: RealmLoginInput, signal: AbortSignal) => {
      const captured = captureRealmLogin(input)
      return prepare((client) => client.login({ username: captured.identifier, password: captured.password,
        ...(captured.turnstileToken === undefined ? {} : { turnstileToken: captured.turnstileToken }) }), signal)
    },
    restore: (value: RealmSavedAccount, signal: AbortSignal) => {
      const saved = parseRealmSavedAccount(value)
      if (saved.realmId !== 'xm-account' || saved.credential.kind !== 'new-api') throw new RealmAccountError('INVALID')
      const cookies = [...saved.credential.cookies]
      return prepare(async (client) => {
        if (!await client.restoreSession({ userId: Number(saved.userId), cookies })) throw new RealmAccountError('UNAUTHORIZED')
      }, signal, saved.userId)
    },
  })
}
