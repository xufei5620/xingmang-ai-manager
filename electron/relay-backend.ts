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
// use -- ipc.ts's account:* handlers, chat-credential-coordinator.ts's
// main-process key resolution for the canvas, and main.ts's startup session
// restore (via account-session-store.ts's restoreAccountSessionOnStartup) --
// not new-api-client.ts's full surface.
// Two NewApiClientService methods are intentionally excluded because
// nothing outside new-api-client.ts (and its own tests) calls them today:
// isAuthenticated(), refreshAccessToken(). Add a
// method here only once a real consumer needs it, per AGENTS.md's own
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

export interface RelayNotice {
  id: string
  text: string
  /** Multiple user-visible notices with server-owned read state. */
  entries?: Array<{ id: string; title: string; text: string; read: boolean }>
}

/** Checkout payload returned by a relay top-up endpoint. Forms are the
 * legacy new-api POST flow; URL/QR payloads are handled by the main process
 * payment window and never exposed to the renderer. */
export type RelayTopupCheckout = NewApiPaymentForm | {
  kind: 'url'
  url: string
  tradeNo: string | null
  expiresAt: string | null
} | {
  kind: 'qrcode'
  code: string
  tradeNo: string | null
  expiresAt: string | null
  amount: number
  currency: string
}

// Optional operation flags preserve legacy NewAPI sessions. Other backends
// must explicitly opt in; a read capability never implies write support.
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
  /** Read subscription plans and current subscriptions. Writes have separate flags. */
  supportsSubscriptions: boolean
  supportsSubscriptionPreference?: boolean
  supportsSubscriptionPayment?: boolean
  supportsSubscriptionBalancePurchase?: boolean
  supportsDashboard?: boolean
  supportsDashboardTrends?: boolean
  supportsTasks?: boolean
  /** display_name editing. */
  supportsProfileUpdate: boolean
  /** Login-session list and revocation. */
  supportsSessionManagement: boolean
  /** provisionCliKey() -- CLI/canvas auto key issuance. */
  supportsAutoKeyProvision: boolean
  /** restoreSession() -- persisted-login restore across app restarts. */
  supportsAccountSession: boolean
}

/**
 * The subset of a relay backend's account client that today's real callers
 * use: ipc.ts's account:* handlers, chat-credential-coordinator.ts (the
 * canvas's key resolution, which happens in the main process -- the canvas
 * renderer never holds a key, see AGENTS.md's I15), and main.ts's startup
 * flow (restoreAccountSessionOnStartup in account-session-store.ts). Each
 * method below notes its consumer(s); see
 * new-api-client.ts's NewApiClientService for the full per-method
 * implementation contract (request/response shape, error semantics) -- kept
 * there rather than duplicated here to avoid the two drifting apart.
 */
export interface RelayBackendClient {
  readonly capabilities: RelayBackendCapabilities
  /** Main-process routing authority; legacy clients default to xm. */
  getActiveSiteId?(): 'solov' | 'solov-api'
  /** Main-only exact lookup. The input secret must never be sent to an account endpoint or returned in a DTO. */
  identifyKey?(secret: string): Promise<{ id: number; name: string; group: string } | null>

  /** ipc.ts: account:get-status */
  getStatus(): Promise<NewApiAccountStatus>
  getNotice?(): Promise<RelayNotice | null>
  /** Mark one entry from the last fetched notice snapshot read in the active account. */
  markNoticeRead?(id: string, entryId: string): Promise<void>
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
  /** ipc.ts: account:logout. Local only; also used to discard switched-away and candidate clients. */
  logout(): void
  /**
   * realm-account-service.ts: the explicit sign-out only. Best-effort server
   * revocation of this client's own login session; must never reject or touch
   * local state. Backends without a documented logout endpoint omit it.
   */
  endServerSession?(): Promise<void>
  /** ipc.ts: account:get-session; chat-credential-coordinator.ts (the account a canvas request resolves against) */
  getSessionState(): NewApiSessionState
  /** ipc.ts: account:get-balance */
  getBalance(): Promise<NewApiBalance>
  /** ipc.ts: account:get-topup-info */
  getTopupInfo(): Promise<NewApiTopupInfo>
  /** ipc.ts: account:quote-topup */
  quoteTopupAmount(input: NewApiTopupAmountInput): Promise<NewApiTopupAmountQuote>
  /** ipc.ts: account:create-topup-payment */
  createTopupPayment(input: NewApiTopupPaymentInput): Promise<RelayTopupCheckout>
  /** ipc.ts: account:list-topup-orders */
  listTopupOrders(input?: NewApiTopupOrdersQuery): Promise<NewApiTopupOrdersPage>
  /** Main-only verification of an existing order, never a create/payment operation. */
  getTopupOrderStatus?(tradeNo: string): Promise<'pending' | 'success' | 'failed' | 'expired' | 'unknown'>
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
  /** ipc.ts: account:provision-cli-key; chat-credential-coordinator.ts (mints the canvas's per-group key) */
  provisionCliKey(input?: NewApiProvisionCliKeyInput): Promise<NewApiCliKeyResult>
  /** main.ts's startup flow, via account-session-store.ts's restoreAccountSessionOnStartup */
  restoreSession(persisted: NewApiPersistableSession): Promise<boolean>
  /** Main-process-only saved-account switching; credentials must never cross IPC. */
  switchSession?(persisted: NewApiPersistableSession): Promise<boolean>
  getPersistableSession?(): NewApiPersistableSession | null
  /** Changes when a login, logout or switch is requested; token refresh keeps it stable. */
  getSessionRevision?(): number
}
