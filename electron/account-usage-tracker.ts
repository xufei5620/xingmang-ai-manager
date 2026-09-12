import type { ActiveIdentityReader } from './active-identity'
import type { AiOperationStartedObserver } from './ai-operation-lifecycle'
import type { AccountUsageChangedEvent } from './ipc-contract'

export interface AccountUsageTrackerOptions {
  identities: ActiveIdentityReader
  assertReady(): void
  emit(event: AccountUsageChangedEvent): void
}

/** A completion hint only: balances are fetched by the main-window scheduler.
 * No credentials, prompt, model, or raw usage response cross this boundary. */
export function createAccountUsageTracker(options: AccountUsageTrackerOptions): AiOperationStartedObserver {
  return () => {
    try {
      options.assertReady()
      const identity = options.identities.capture()
      let settled = false
      return () => {
        if (settled) return
        settled = true
        try {
          options.assertReady()
          options.identities.assertCurrent(identity)
          options.emit({ scope: `${identity.realmId}:${identity.userId}` })
        } catch { /* old-account completions and closed windows are ignored */ }
      }
    } catch {
      // Login transitions can cancel old requests before their completion.
      return undefined
    }
  }
}
