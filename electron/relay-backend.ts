// Backend-agnostic contract for a relay (AI-API-proxy) account backend. The
// desktop app talks to a customer's paid relay account through this
// interface everywhere except new-api-client.ts itself: today the only
// implementation is createNewApiClient() (new-api-client.ts), which talks to
// xm.solov.cc (QuantumNous/new-api). A second backend (sub2api -- a Go/Gin
// relay whose management API is not compatible with new-api's, starting as a
// paste-a-key-only integration) can implement this same interface without
// touching ipc.ts, canvas-window.ts, or main.ts's assembly -- those consume
// RelayBackendClient, not the concrete new-api type, by design.
//
// The method list here is deliberately the *exact* set today's real callers
// use -- ipc.ts's account:* handlers, canvas-window.ts's
// buildCanvasTokenDependencies (the canvas auto-key flow), and main.ts's
// startup session restore (via account-session-store.ts's
// restoreAccountSessionOnStartup) -- not new-api-client.ts's full surface.
// Three NewApiClientService methods are intentionally excluded because
// nothing outside new-api-client.ts (and its own tests) calls them today:
// isAuthenticated(), refreshAccessToken(), getPersistableSession(). Add a
// method here only once a real consumer needs it, per CLAUDE.md's own
// guidance against speculative surface.
//
// DTO types are imported from new-api-client.ts rather than duplicated or
// renamed -- this wave only introduces the interface seam, not a renamed
// backend-neutral vocabulary for every field (that is a larger refactor for
// whenever a second backend actually lands). That reuse makes this file's
// type imports circular with new-api-client.ts's own `import type` of
// RelayBackendClient/RelayBackendCapabilities (see that file). Both sides
// import only *types*, which TypeScript erases completely at compile time --
// there is no runtime require() cycle, and interface declarations (unlike
// const/class) have no temporal-dead-zone ordering constraint, so this is
// safe.

import type {
  NewApiAccountKeyCreateInput,
  NewApiAccountKeysPage,
  NewApiAccountKeysQuery,
  NewApiAccountKeyUpdateInput,
  NewApiAccountProfileDetail,
  NewApiAccountStatus,
  NewApiAccountUsagePage,
  NewApiAccountUsageQuery,
  NewApiAccountDashboardData,
  NewApiAccountDashboardQuery,
  NewApiAccountTaskPage,
  NewApiAccountTaskQuery,
  NewApiBalance,
  NewApiAffiliateTransferInput,
  NewApiChangePasswordInput,
  NewApiChangePasswordResult,
  NewApiCliKeyResult,
  NewApiLoginInput,
  NewApiLoginResult,
  NewApiLoginSession,
  NewApiLegalDocument,
  NewApiLegalDocumentKind,
  NewApiPersistableSession,
  NewApiProvisionCliKeyInput,
  NewApiRegisterInput,
  NewApiResetPasswordInput,
  NewApiResetPasswordResult,
  NewApiSessionState,
  NewApiDisplayNameUpdateInput,
  NewApiPaymentForm,
  NewApiProfileUpdateResult,
  NewApiRedemptionResult,
  NewApiRevokeLoginSessionResult,
  NewApiRevokeOtherLoginSessionsResult,
  NewApiSubscriptionPlan,
  NewApiBillingPreference,
  NewApiSubscriptionCheckout,
  NewApiSubscriptionPaymentInput,
  NewApiSubscriptionPurchaseResult,
  NewApiSubscriptionSelf,
  NewApiTopupAmountInput,
  NewApiTopupAmountQuote,
  NewApiTopupInfo,
  NewApiTopupOrdersPage,
  NewApiTopupOrdersQuery,
  NewApiTopupPaymentInput,
  NewApiUsableGroup,
} from './new-api-client'

// Coarse, UI-facing flags -- granularity matches "which block of the account
// UI does the renderer need to show or hide for this backend", not a
// per-method feature matrix. new-api supports everything this app uses
// today, so its capabilities are all true (see new-api-client.ts's
// createNewApiClient). A future minimal backend (e.g. one with no self-serve
// password reset) would flip the matching flag to false rather than this
// interface growing a new optional method just for that one gap.
export interface RelayBackendCapabilities {
  /** register() / sendEmailVerification() -- self-serve sign-up. */
  supportsRegistration: boolean
  /** sendPasswordResetEmail() / resetPassword(). */
  supportsPasswordReset: boolean
  /** listKeys() / revokeKey() -- the 个人中心 Key 管理 tab. */
  supportsKeyManagement: boolean
  /** getUsage() -- the 个人中心 用量 tab. */
  supportsUsage: boolean
  /** Top-up configuration, quoting, checkout, orders, redemption, and referral transfer. */
  supportsBilling: boolean
  /** Subscription plans, current subscriptions, and balance purchase. */
  supportsSubscriptions: boolean
  /** display_name editing. */
  supportsProfileUpdate: boolean
  /** Login-session list and revocation. */
  supportsSessionManagement: boolean
  /** provisionCliKey() / findExistingCliKey() -- CLI/canvas auto key issuance. */
  supportsAutoKeyProvision: boolean
  /** restoreSession() -- persisted-login restore across app restarts. */
  supportsAccountSession: boolean
}

/**
 * The subset of a relay backend's account client that today's real callers
 * use: ipc.ts's account:* handlers, canvas-window.ts's
 * buildCanvasTokenDependencies (the canvas window's auto key-provisioning),
 * and main.ts's startup flow (restoreAccountSessionOnStartup in
 * account-session-store.ts). Each method below notes its consumer(s); see
 * new-api-client.ts's NewApiClientService for the full per-method
 * implementation contract (request/response shape, error semantics) -- kept
 * there rather than duplicated here to avoid the two drifting apart.
 */
export interface RelayBackendClient {
  readonly capabilities: RelayBackendCapabilities

  /** ipc.ts: account:get-status */
  getStatus(): Promise<NewApiAccountStatus>
  /** ipc.ts: account:get-legal-document */
  getLegalDocument(kind: NewApiLegalDocumentKind): Promise<NewApiLegalDocument>
  /** ipc.ts: account:send-email-verification */
  sendEmailVerification(email: string): Promise<void>
  /** ipc.ts: account:send-password-reset-email */
  sendPasswordResetEmail(email: string): Promise<void>
  /** ipc.ts: account:reset-password */
  resetPassword(input: NewApiResetPasswordInput): Promise<NewApiResetPasswordResult>
  /** ipc.ts: account:register */
  register(input: NewApiRegisterInput): Promise<void>
  /** ipc.ts: account:login */
  login(input: NewApiLoginInput): Promise<NewApiLoginResult>
  /** ipc.ts: account:logout */
  logout(): void
  /** ipc.ts: account:get-session; canvas-window.ts's buildCanvasTokenDependencies (isAccountAuthenticated) */
  getSessionState(): NewApiSessionState
  /** ipc.ts: account:get-balance */
  getBalance(): Promise<NewApiBalance>
  /** ipc.ts: account:get-topup-info */
  getTopupInfo(): Promise<NewApiTopupInfo>
  /** ipc.ts: account:quote-topup */
  quoteTopupAmount(input: NewApiTopupAmountInput): Promise<NewApiTopupAmountQuote>
  /** ipc.ts: account:create-topup-payment */
  createTopupPayment(input: NewApiTopupPaymentInput): Promise<NewApiPaymentForm>
  /** ipc.ts: account:list-topup-orders */
  listTopupOrders(input?: NewApiTopupOrdersQuery): Promise<NewApiTopupOrdersPage>
  /** ipc.ts: account:redeem-topup-code */
  redeemTopupCode(code: string): Promise<NewApiRedemptionResult>
  /** ipc.ts: account:transfer-affiliate-quota */
  transferAffiliateQuota(input: NewApiAffiliateTransferInput): Promise<void>
  /** ipc.ts: account:list-subscription-plans */
  listSubscriptionPlans(): Promise<NewApiSubscriptionPlan[]>
  /** ipc.ts: account:get-subscription-self */
  getSubscriptionSelf(): Promise<NewApiSubscriptionSelf>
  /** ipc.ts: account:update-subscription-preference */
  updateSubscriptionPreference(preference: NewApiBillingPreference): Promise<NewApiBillingPreference>
  /** ipc.ts: account:create-subscription-payment */
  createSubscriptionPayment(input: NewApiSubscriptionPaymentInput): Promise<NewApiSubscriptionCheckout>
  /** ipc.ts: account:purchase-subscription-balance */
  purchaseSubscriptionWithBalance(planId: number): Promise<NewApiSubscriptionPurchaseResult>
  /** ipc.ts: account:get-profile */
  getProfile(): Promise<NewApiAccountProfileDetail>
  /** ipc.ts: account:update-display-name */
  updateDisplayName(input: NewApiDisplayNameUpdateInput): Promise<NewApiProfileUpdateResult>
  /** ipc.ts: account:get-usage */
  getUsage(input?: NewApiAccountUsageQuery): Promise<NewApiAccountUsagePage>
  /** ipc.ts: account:get-dashboard */
  getDashboard(input: NewApiAccountDashboardQuery): Promise<NewApiAccountDashboardData>
  /** ipc.ts: account:get-tasks */
  getTasks(input?: NewApiAccountTaskQuery): Promise<NewApiAccountTaskPage>
  /** ipc.ts: account:list-keys */
  listKeys(input?: NewApiAccountKeysQuery): Promise<NewApiAccountKeysPage>
  /** ipc.ts: account:list-groups */
  listUsableGroups(): Promise<NewApiUsableGroup[]>
  /** ipc.ts: account:copy-key and account:reveal-key; renderer reveal is explicit and short-lived. */
  revealKey(id: number): Promise<string>
  /** ipc.ts: account:revoke-key */
  revokeKey(id: number): Promise<void>
  /** ipc.ts: account:create-key */
  createKey(input: NewApiAccountKeyCreateInput): Promise<void>
  /** ipc.ts: account:update-key */
  updateKey(input: NewApiAccountKeyUpdateInput): Promise<void>
  /** ipc.ts: account:change-password */
  changePassword(input: NewApiChangePasswordInput): Promise<NewApiChangePasswordResult>
  /** ipc.ts: account:list-login-sessions */
  listLoginSessions(): Promise<NewApiLoginSession[]>
  /** ipc.ts: account:revoke-login-session */
  revokeLoginSession(sid: string): Promise<NewApiRevokeLoginSessionResult>
  /** ipc.ts: account:revoke-other-login-sessions */
  revokeOtherLoginSessions(): Promise<NewApiRevokeOtherLoginSessionsResult>
  /** ipc.ts: account:provision-cli-key; canvas-window.ts's buildCanvasTokenDependencies */
  provisionCliKey(input?: NewApiProvisionCliKeyInput): Promise<NewApiCliKeyResult>
  /** canvas-window.ts's buildCanvasTokenDependencies (orphan-token reuse before minting a fresh one) */
  findExistingCliKey(namePrefix: string): Promise<NewApiCliKeyResult | null>
  /** main.ts's startup flow, via account-session-store.ts's restoreAccountSessionOnStartup */
  restoreSession(persisted: NewApiPersistableSession): Promise<boolean>
}
