import { describe, expect, it } from 'vitest'
import { createNewApiClient, type NewApiFetch } from './new-api-client'
import type { RelayBackendCapabilities, RelayBackendClient } from './relay-backend'

// This suite never exercises a real HTTP round trip -- every test either
// only constructs the client (capability/shape checks) or supplies a
// fetchImpl that fails the test if it is ever actually called. Network
// behavior itself is already covered by new-api-client.test.ts's 1400+
// lines; this file only proves the interface seam (relay-backend.ts) holds.
function unreachableFetch(): NewApiFetch {
  return async () => {
    throw new Error('relay-backend.test.ts: no test in this file should perform a real fetch')
  }
}

const allCapabilitiesTrue: RelayBackendCapabilities = {
  supportsRegistration: true,
  supportsPasswordReset: true,
  supportsKeyManagement: true,
  supportsUsage: true,
  supportsBilling: true,
  supportsSubscriptions: true,
  supportsProfileUpdate: true,
  supportsSessionManagement: true,
  supportsAutoKeyProvision: true,
  supportsAccountSession: true,
}

// Every RelayBackendClient method name, kept as a runtime list so the "is
// this a callable function" assertion below stays in sync with the
// interface without hand-duplicating it -- if a method is ever added to (or
// removed from) RelayBackendClient without updating this list, the
// assignment on the line right after it (typed as RelayBackendClient) is
// what actually catches the drift at compile time; this array only backs
// the runtime shape assertion.
const relayBackendMethodNames = [
  'getStatus',
  'getLegalDocument',
  'sendEmailVerification',
  'sendPasswordResetEmail',
  'resetPassword',
  'register',
  'login',
  'logout',
  'getSessionState',
  'getBalance',
  'getTopupInfo',
  'quoteTopupAmount',
  'createTopupPayment',
  'listTopupOrders',
  'redeemTopupCode',
  'transferAffiliateQuota',
  'listSubscriptionPlans',
  'getSubscriptionSelf',
  'updateSubscriptionPreference',
  'createSubscriptionPayment',
  'purchaseSubscriptionWithBalance',
  'getProfile',
  'updateDisplayName',
  'getUsage',
  'getDashboard',
  'getTasks',
  'listKeys',
  'listUsableGroups',
  'revealKey',
  'revokeKey',
  'createKey',
  'updateKey',
  'changePassword',
  'listLoginSessions',
  'revokeLoginSession',
  'revokeOtherLoginSessions',
  'provisionCliKey',
  'findExistingCliKey',
  'restoreSession',
] as const

describe('RelayBackendClient', () => {
  it('accepts createNewApiClient()\'s return value (new-api is the first implementation)', () => {
    // The type annotation here *is* the test: if createNewApiClient()'s
    // return type (NewApiClientService) ever stopped structurally
    // satisfying RelayBackendClient, this assignment would fail
    // typecheck -- caught by `npm run typecheck`, not just at runtime.
    const client: RelayBackendClient = createNewApiClient({ fetchImpl: unreachableFetch() })
    expect(client).toBeTruthy()
  })

  it('new-api reports every capability as true', () => {
    const client: RelayBackendClient = createNewApiClient({ fetchImpl: unreachableFetch() })
    expect(client.capabilities).toEqual(allCapabilitiesTrue)
  })

  it('capabilities is a plain data object, not re-derived per call', () => {
    const client = createNewApiClient({ fetchImpl: unreachableFetch() })
    expect(client.capabilities).toBe(client.capabilities)
  })

  it('exposes every RelayBackendClient method as a callable function', () => {
    const client: RelayBackendClient = createNewApiClient({ fetchImpl: unreachableFetch() })
    for (const name of relayBackendMethodNames) {
      expect(typeof client[name]).toBe('function')
    }
  })

  it('a hand-built fake satisfying the interface needs only the documented method set', () => {
    // Mirrors how a future sub2api implementation would look: a plain object
    // literal, no inheritance from new-api-client.ts, still assignable to
    // RelayBackendClient as long as every member here is present.
    const fake: RelayBackendClient = {
      capabilities: {
        supportsRegistration: false,
        supportsPasswordReset: false,
        supportsKeyManagement: false,
        supportsUsage: false,
        supportsBilling: false,
        supportsSubscriptions: false,
        supportsProfileUpdate: false,
        supportsSessionManagement: false,
        supportsAutoKeyProvision: false,
        supportsAccountSession: true,
      },
      getStatus: async () => ({
        systemName: 'sub2api-fake',
        version: '0.0.0',
        setupComplete: true,
        quotaPerUnit: 1,
        quotaDisplayType: 'USD',
        usdExchangeRate: 1,
        registerEnabled: false,
        passwordRegisterEnabled: false,
        emailVerificationEnabled: false,
        turnstileCheckEnabled: false,
      }),
      getLegalDocument: async (kind) => ({ kind, markdown: '# Fake', fetchedAt: '2026-08-11T00:00:00.000Z' }),
      sendEmailVerification: async () => undefined,
      sendPasswordResetEmail: async () => undefined,
      resetPassword: async () => ({ newPassword: 'unused' }),
      register: async () => undefined,
      login: async () => ({ account: { userId: 1, username: 'fake', group: null, role: null, quota: null, usedQuota: null }, accessExpiresAt: null }),
      logout: () => undefined,
      getSessionState: () => ({ authenticated: false, account: null }),
      getBalance: async () => ({ quota: 0, usedQuota: 0, quotaPerUnit: 1, quotaDisplayType: 'USD', usdExchangeRate: 1, displayAmount: 0 }),
      getTopupInfo: async () => ({
        onlineTopupEnabled: false,
        stripeTopupEnabled: false,
        creemTopupEnabled: false,
        waffoPancakeTopupEnabled: false,
        redemptionEnabled: false,
        paymentComplianceConfirmed: false,
        paymentComplianceTermsVersion: null,
        paymentMethods: [],
        minTopup: 0,
        amountOptions: [],
        discounts: {},
        topupLink: null,
      }),
      quoteTopupAmount: async ({ amount }) => ({ amount, payableAmount: amount }),
      createTopupPayment: async () => ({ action: 'https://pay.example.com/', allowedOrigin: 'https://pay.example.com', method: 'POST', fields: [{ name: 'sign', value: 'fake' }], tradeNo: null }),
      listTopupOrders: async () => ({ page: 1, pageSize: 10, total: 0, orders: [] }),
      redeemTopupCode: async () => ({ quotaAdded: 0 }),
      transferAffiliateQuota: async () => undefined,
      listSubscriptionPlans: async () => [],
      getSubscriptionSelf: async () => ({ billingPreference: 'subscription_first', activeSubscriptions: [], allSubscriptions: [] }),
      updateSubscriptionPreference: async (preference) => preference,
      createSubscriptionPayment: async () => ({
        kind: 'url',
        url: 'https://pay.example.com/checkout',
        tradeNo: null,
        expiresAt: null,
      }),
      purchaseSubscriptionWithBalance: async () => ({ purchased: true }),
      getProfile: async () => ({
        userId: 1,
        username: 'fake',
        displayName: null,
        email: null,
        group: null,
        quota: 0,
        usedQuota: 0,
        requestCount: 0,
        affCode: null,
        affCount: 0,
        affQuota: 0,
        affHistoryQuota: 0,
      }),
      updateDisplayName: async () => ({ updated: true }),
      getUsage: async () => ({ page: 1, pageSize: 10, total: 0, records: [], stats: { quota: 0, rpm: 0, tpm: 0 } }),
      getDashboard: async (input) => ({
        ...input,
        buckets: [],
        models: [],
        quota: 0,
        count: 0,
        tokens: 0,
        discardedCount: 0,
      }),
      getTasks: async () => ({ page: 1, pageSize: 10, total: 0, tasks: [] }),
      listKeys: async () => ({ page: 1, pageSize: 10, total: 0, keys: [] }),
      listUsableGroups: async () => [],
      revealKey: async () => 'sk-fake',
      revokeKey: async () => undefined,
      createKey: async () => undefined,
      updateKey: async () => undefined,
      changePassword: async () => ({ changed: true }),
      listLoginSessions: async () => [],
      revokeLoginSession: async (sid) => ({ revokedSid: sid, current: false }),
      revokeOtherLoginSessions: async () => ({ revokedCount: 0 }),
      provisionCliKey: async () => ({ id: 1, name: 'fake', key: 'sk-fake' }),
      findExistingCliKey: async () => null,
      restoreSession: async () => false,
    }
    expect(fake.capabilities.supportsAccountSession).toBe(true)
    expect(fake.capabilities.supportsRegistration).toBe(false)
  })
})
