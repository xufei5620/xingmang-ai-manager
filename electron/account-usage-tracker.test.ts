import { describe, expect, it, vi } from 'vitest'
import { createActiveIdentityReader } from './active-identity'
import { createAccountUsageTracker } from './account-usage-tracker'

function fixture() {
  let current = { siteId: 'solov', userId: 7, revision: 1, authenticated: true, busy: false }
  const emit = vi.fn()
  function observer(siteId = 'solov', realmId = 'xm-account') {
    return createAccountUsageTracker({
      identities: createActiveIdentityReader({ siteId, realmId, accountOrigin: `https://${siteId}.example.invalid` }, {
        getSessionState: () => {
          if (current.siteId !== siteId) throw new Error('wrong realm')
          return { authenticated: current.authenticated, account: { userId: current.userId } }
        },
        getSessionRevision: () => current.revision,
      }),
      assertReady: () => { if (current.busy) throw new Error('switching account') },
      emit,
    })
  }
  return { emit, observer, update: (value: Partial<typeof current>) => { current = { ...current, ...value } } }
}

describe('account usage completion notifications', () => {
  it('only publishes one credential-free account scope per completed request', () => {
    const account = fixture()
    const settled = account.observer()()
    expect(account.emit).not.toHaveBeenCalled()
    settled?.()
    settled?.()
    expect(account.emit.mock.calls).toEqual([[{ scope: 'xm-account:7' }]])
  })

  it.each([
    { authenticated: false },
    { userId: 8 },
    { revision: 2 },
    { busy: true },
    { siteId: 'solov-api' },
  ])('ignores a completion after the account changed: %j', (next) => {
    const account = fixture()
    const settled = account.observer()()
    account.update(next)
    settled?.()
    expect(account.emit).not.toHaveBeenCalled()
  })

  it('keeps identical numeric users on different platforms isolated', () => {
    const account = fixture()
    const first = account.observer()()
    account.update({ siteId: 'solov-api', revision: 2 })
    const second = account.observer('solov-api', 'api-account')()
    first?.()
    second?.()
    expect(account.emit.mock.calls).toEqual([[{ scope: 'api-account:7' }]])
  })

  it('does not revive pending work on logout and re-login as the same account', () => {
    const account = fixture()
    const settled = account.observer()()
    account.update({ authenticated: false, revision: 2 })
    account.update({ authenticated: true, revision: 3 })
    settled?.()
    expect(account.emit).not.toHaveBeenCalled()
  })

  it('does not capture requests while an account switch is pending or logged out', () => {
    const account = fixture()
    account.update({ busy: true })
    expect(account.observer()()).toBeUndefined()
    account.update({ busy: false, authenticated: false })
    expect(account.observer()()).toBeUndefined()
  })

  it('does not let a closed main window change the generation result', () => {
    const account = fixture()
    account.emit.mockImplementation(() => { throw new Error('window destroyed') })
    const settled = account.observer()()
    expect(() => settled?.()).not.toThrow()
  })
})
