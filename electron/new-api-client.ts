import { randomUUID } from 'node:crypto'
import { readBoundedResponseText } from './bounded-response'
import { redactCommandText } from './command-runner'
import type { RelayBackendCapabilities, RelayBackendClient } from './relay-backend'
import { relaySites } from './relay-sites'

// xm.solov.cc runs QuantumNous/new-api (rc.22, custom branch). Every endpoint
// wraps its payload as { success, message, data } -- confirmed for the CLI
// token endpoints by docs/RECON-new-api.md section C.1 ("响应只有 success，
// 不返回 id/key") and assumed uniformly for the rest per that project's own
// convention. Treat unexpected shapes as a hard error rather than guessing.

// Exported so other main-process modules that need this exact host (the
// canvas window's host bridge injects it as the canvas app's own relay
// baseUrl -- see canvas-window.ts) never have to duplicate the literal.
// Derived from the site registry's solov entry (T2 precedent, W3) rather
// than a duplicated literal: solov is guaranteed to declare accountBaseUrl
// -- it is the one relay-sites.ts entry with accountBackend: 'new-api' --
// but the field is typed optional on RelaySite (a manual-key site like
// sub2api has none), so the `?? ` fallback below exists purely to stay
// type-safe; it is unreachable in practice.
export const defaultBaseUrl = relaySites.find((site) => site.id === 'solov')?.accountBaseUrl
  ?? 'https://xm.solov.cc'
const defaultTimeoutMs = 10_000
const defaultMaxResponseBytes = 512 * 1024
const redirectStatuses = new Set([301, 302, 303, 307, 308])

const statusPath = '/api/status'
const verificationPath = '/api/verification'
const registerPath = '/api/user/register'
const loginPath = '/api/user/login'
const refreshPath = '/api/user/auth/refresh'
const selfPath = '/api/user/self'
const logSelfPath = '/api/log/self'
const logSelfStatPath = '/api/log/self/stat'
const dataSelfPath = '/api/data/self'
const taskSelfPath = '/api/task/self'
const tokenCollectionPath = '/api/token/'
const userGroupsPath = '/api/user/self/groups'
const topupInfoPath = '/api/user/topup/info'
const topupAmountPath = '/api/user/amount'
const topupPaymentPath = '/api/user/pay'
const topupOrdersPath = '/api/user/topup/self'
const redemptionPath = '/api/user/topup'
const affiliateTransferPath = '/api/user/aff_transfer'
const subscriptionPlansPath = '/api/subscription/plans'
const subscriptionSelfPath = '/api/subscription/self'
const subscriptionPreferencePath = '/api/subscription/self/preference'
const subscriptionBalancePaymentPath = '/api/subscription/balance/pay'
const subscriptionPaymentPaths = Object.freeze({
  epay: '/api/subscription/epay/pay',
  stripe: '/api/subscription/stripe/pay',
  creem: '/api/subscription/creem/pay',
  'waffo-pancake': '/api/subscription/waffo-pancake/pay',
})
const loginSessionsPath = '/api/user/sessions'
const legalDocumentPaths = {
  'user-agreement': '/api/user-agreement',
  'privacy-policy': '/api/privacy-policy',
} as const
const resetPasswordEmailPath = '/api/reset_password'
const resetPasswordPath = '/api/user/reset'

function tokenKeyPath(id: number): string {
  return `/api/token/${id}/key`
}

function tokenIdPath(id: number): string {
  return `/api/token/${id}`
}

function loginSessionPath(sid: string): string {
  return `${loginSessionsPath}/${encodeURIComponent(sid)}`
}

export type NewApiFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface NewApiClientOptions {
  baseUrl?: string
  fetchImpl?: NewApiFetch
  timeoutMs?: number
  maxResponseBytes?: number
  // Fired synchronously every time the in-memory session is established,
  // rotated, or cleared -- login, logout, a silent 401 refresh-and-retry, and
  // restoreSession() all funnel through the same setSession() choke point, so
  // this is the *only* hook a host app needs to keep an on-disk encrypted
  // copy (see electron/account-session-store.ts) in sync, regardless of which
  // caller (the main window's account:* handlers, or the canvas window's own
  // token provisioning -- both can share one client instance) triggered the
  // change. Receives null on logout or a failed silent-refresh-and-retry.
  // Fire-and-forget by design: a disk hiccup persisting the session must
  // never fail the account operation that triggered it (I13/I8 territory
  // belongs to the host app, not this network client).
  onSessionChange?: (persistable: NewApiPersistableSession | null) => void
}

export interface NewApiAccountStatus {
  systemName: string
  version: string
  setupComplete: boolean
  quotaPerUnit: number
  quotaDisplayType: string
  usdExchangeRate: number
  registerEnabled: boolean
  passwordRegisterEnabled: boolean
  emailVerificationEnabled: boolean
  turnstileCheckEnabled: boolean
}

export type NewApiLegalDocumentKind = keyof typeof legalDocumentPaths

export interface NewApiLegalDocument {
  kind: NewApiLegalDocumentKind
  markdown: string
  fetchedAt: string
}

export interface NewApiUsableGroup {
  name: string
  description: string
  ratio: number | string
}

export interface NewApiAccountProfile {
  userId: number
  username: string
  group: string | null
  role: number | null
  quota: number | null
  usedQuota: number | null
}

// Despite the field's name, new-api's Login handler matches it against
// *either* a real username or an email address: model.User.ValidateAndFill
// does `DB.Where("username = ? OR email = ?", username, username)` (read
// directly from QuantumNous/new-api's model/user.go), and the official web
// frontend labels the same field "Username or Email"
// (web/src/features/auth/sign-in/components/user-auth-form.tsx). So callers
// (LoginDialog.tsx) may put either kind of value in this field.
export interface NewApiLoginInput {
  username: string
  password: string
  turnstileToken?: string
}

// RECON (docs/RECON-new-api.md section A) confirms /api/user/register wants
// username *and* email as separate fields. An earlier revision defaulted
// username to the email address, which broke real registration attempts:
// new-api enforces uniqueness on username independently of email (confirmed
// against QuantumNous/new-api's model.User struct tag --
// Username string `gorm:"unique;index" validate:"max=20"` -- and
// controller/user.go's Register handler, which rejects a collision with
// i18n key user.exists, "Username already exists..."), so two different
// people whose emails both happen to get used as a username, or the same
// person retrying after an interrupted attempt, collide on a field the user
// never chose or saw. RegisterDialog.tsx now collects a real, distinct
// username, so this is required rather than derived.
export interface NewApiRegisterInput {
  email: string
  password: string
  verificationCode: string
  username: string
  affCode?: string
}

// POST /api/user/reset's wire shape (PasswordResetRequest in
// controller/misc.go): email plus the opaque token embedded in the emailed
// reset link's `token=` query parameter. Deliberately has no password field
// -- see resetPassword()'s own comment below for why: new-api generates the
// new password itself and hands it back in the response.
//
// Read directly from QuantumNous/new-api's upstream `main` branch (commit
// pushed 2026-08-09), the same methodology already used for
// NewApiRegisterInput above, not yet exercised against the live xm.solov.cc
// instance. The same version-drift caveat RECON already flags applies here
// too (docs/RECON-new-api.md section C.5 -- the production instance is
// pinned to a customized rc.22 branch that can differ from upstream): if
// that branch turns out to accept a client-chosen password, this type and
// resetPassword() both need revisiting.
export interface NewApiResetPasswordInput {
  email: string
  token: string
}

// Safe to cross the IPC boundary: no access_token, no refresh cookie.
export interface NewApiLoginResult {
  account: NewApiAccountProfile
  accessExpiresAt: string | null
}

export interface NewApiSessionState {
  authenticated: boolean
  account: NewApiAccountProfile | null
}

export interface NewApiBalance {
  quota: number
  usedQuota: number
  quotaPerUnit: number
  quotaDisplayType: string
  usdExchangeRate: number
  displayAmount: number
}

// GET /api/user/self's full DTO for the 个人中心 (account center) profile tab
// (W4a). Deliberately a *separate* type from NewApiAccountProfile above
// rather than an extension of it: that type's shape is load-bearing for
// login/session/balance call sites and their existing tests, and this one
// exists purely to carry the richer read-only fields those flows never
// needed. Confirmed field-for-field against QuantumNous/new-api's
// buildSelfUserData (controller/user.go) -- read at both the `main` branch
// and the exact v1.0.0-rc.22 / v1.0.0-rc.24 tags (byte-identical across all
// three), the latter two bracketing xm.solov.cc's own pinned version.
// Excludes every field buildSelfUserData returns that this app has no use
// for yet (github_id/discord_id/oidc_id/wechat_id/telegram_id/linux_do_id,
// setting, stripe_customer, sidebar_modules, permissions) and the
// commission-history fields (aff_quota/aff_history_quota) the 邀请 tab
// deliberately defers to a later wave -- I3-style minimal surface, not an
// oversight.
export interface NewApiAccountProfileDetail {
  userId: number
  username: string
  displayName: string | null
  email: string | null
  group: string | null
  quota: number
  usedQuota: number
  requestCount: number
  affCode: string | null
  /** Number of users this account has referred -- shown on the 邀请 tab. */
  affCount: number
  /** Pending referral quota that can be transferred into wallet balance. */
  affQuota: number
  /** Lifetime referral quota earned by this account. */
  affHistoryQuota: number
}

export interface NewApiTopupPaymentMethod {
  name: string
  type: string
  provider: 'epay' | 'stripe' | 'creem' | 'waffo' | 'waffo-pancake'
  color: string | null
  icon: string | null
  minTopup: number
}

export interface NewApiTopupInfo {
  onlineTopupEnabled: boolean
  stripeTopupEnabled: boolean
  creemTopupEnabled: boolean
  waffoPancakeTopupEnabled: boolean
  redemptionEnabled: boolean
  paymentComplianceConfirmed: boolean
  paymentComplianceTermsVersion: string | null
  paymentMethods: NewApiTopupPaymentMethod[]
  minTopup: number
  amountOptions: number[]
  discounts: Record<string, number>
  topupLink: string | null
}

export interface NewApiTopupAmountInput {
  amount: number
}

export interface NewApiTopupAmountQuote {
  amount: number
  payableAmount: number
}

export interface NewApiTopupPaymentInput extends NewApiTopupAmountInput {
  paymentMethod: string
}

export interface NewApiPaymentFormField {
  name: string
  value: string
}

export interface NewApiPaymentForm {
  action: string
  allowedOrigin: string
  method: 'POST'
  fields: NewApiPaymentFormField[]
  tradeNo: string | null
}

export interface NewApiTopupOrdersQuery {
  page?: number
  pageSize?: number
  keyword?: string
}

export type NewApiTopupOrderStatus = 'pending' | 'success' | 'failed' | 'expired' | 'unknown'

export interface NewApiTopupOrder {
  id: number
  amount: number
  money: number
  tradeNo: string
  paymentMethod: string
  paymentProvider: string
  createdAt: string
  completedAt: string | null
  status: NewApiTopupOrderStatus
}

export interface NewApiTopupOrdersPage {
  page: number
  pageSize: number
  total: number
  orders: NewApiTopupOrder[]
}

export interface NewApiRedemptionResult {
  quotaAdded: number
}

export interface NewApiAffiliateTransferInput {
  quota: number
}

export interface NewApiSubscriptionPlan {
  id: number
  title: string
  subtitle: string
  priceAmount: number
  currency: string
  durationUnit: 'year' | 'month' | 'day' | 'hour' | 'custom'
  durationValue: number
  customSeconds: number
  allowBalancePay: boolean
  allowWalletOverflow: boolean
  maxPurchasePerUser: number
  totalAmount: number
  upgradeGroup: string
  downgradeGroup: string
  quotaResetPeriod: 'never' | 'daily' | 'weekly' | 'monthly' | 'custom'
  quotaResetCustomSeconds: number
  stripePriceId: string | null
  creemProductId: string | null
  waffoPancakeProductId: string | null
}

export type NewApiBillingPreference =
  | 'subscription_first'
  | 'wallet_first'
  | 'subscription_only'
  | 'wallet_only'

export type NewApiSubscriptionPaymentProvider = 'epay' | 'stripe' | 'creem' | 'waffo-pancake'

export interface NewApiSubscriptionPaymentInput {
  planId: number
  provider: NewApiSubscriptionPaymentProvider
  paymentMethod?: string
}

export type NewApiSubscriptionCheckout =
  | {
      kind: 'form'
      form: NewApiPaymentForm
      tradeNo: string | null
      expiresAt: string | null
    }
  | {
      kind: 'url'
      url: string
      tradeNo: string | null
      expiresAt: string | null
    }

export interface NewApiSubscription {
  id: number
  planId: number
  status: string
  source: string
  amountTotal: number
  amountUsed: number
  startedAt: string
  endsAt: string
  nextResetAt: string | null
}

export interface NewApiSubscriptionSelf {
  billingPreference: NewApiBillingPreference
  activeSubscriptions: NewApiSubscription[]
  allSubscriptions: NewApiSubscription[]
}

export interface NewApiSubscriptionPurchaseResult {
  purchased: true
}

export interface NewApiDisplayNameUpdateInput {
  displayName: string
}

export interface NewApiProfileUpdateResult {
  updated: true
}

export interface NewApiLoginSession {
  sid: string
  current: boolean
  loginMethod: string
  ip: string
  userAgent: string
  createdAt: string
  lastActiveAt: string
  expiresAt: string
}

export interface NewApiRevokeLoginSessionResult {
  revokedSid: string
  current: boolean
}

export interface NewApiRevokeOtherLoginSessionsResult {
  revokedCount: number
}

export interface NewApiAccountUsageQuery {
  /** 1-based; matches new-api's `p` query parameter. */
  page?: number
  /** Server clamps to 100 regardless of what is sent (common/page_info.go). */
  pageSize?: number
  type?: number
  startTimestamp?: number
  endTimestamp?: number
  modelName?: string
  tokenName?: string
  group?: string
  requestId?: string
  upstreamRequestId?: string
}

export interface NewApiAccountUsageStreamStatus {
  status: string
  endReason: string
  errorCount: number
  endError: string
  errors: string[]
}

export interface NewApiAccountUsageDetails {
  cacheTokens: number
  cacheCreationTokens: number
  cacheCreationTokens5m: number
  cacheCreationTokens1h: number
  firstResponseTimeMs: number | null
  reasoningEffort: string
  modelRatio: number | null
  completionRatio: number | null
  modelPrice: number | null
  groupRatio: number | null
  userGroupRatio: number | null
  cacheRatio: number | null
  cacheCreationRatio: number | null
  cacheCreationRatio5m: number | null
  cacheCreationRatio1h: number | null
  billingMode: string
  matchedTier: string
  upstreamModelName: string
  streamStatus: NewApiAccountUsageStreamStatus | null
}

// One row of GET /api/log/self's `items` array. This remains an explicit
// customer-facing whitelist: `other` itself, channel/admin data, IP and audit
// fields never cross IPC.
export interface NewApiAccountUsageRecord {
  id: number
  /** ISO 8601, converted from the wire's Unix-seconds Log.CreatedAt. */
  createdAt: string
  /** Log.Type: 0 unknown, 1 topup, 2 consume, 3 manage, 4 system, 5 error, 6 refund, 7 login. */
  type: number
  modelName: string
  promptTokens: number
  completionTokens: number
  /** Integer quota units, same convention as NewApiBalance.quota. */
  quota: number
  isStream: boolean
  tokenName: string
  group: string
  useTimeSeconds: number
  content: string
  requestId: string
  upstreamRequestId: string
  details: NewApiAccountUsageDetails
}

export interface NewApiAccountUsageStats {
  quota: number
  rpm: number
  tpm: number
}

export interface NewApiAccountUsagePage {
  page: number
  pageSize: number
  total: number
  records: NewApiAccountUsageRecord[]
  stats: NewApiAccountUsageStats
}

export interface NewApiAccountDashboardQuery {
  startTimestamp: number
  endTimestamp: number
}

// Customer-facing whitelist for GET /api/data/self. The upstream row also
// contains user identity fields; only chart dimensions and metrics cross IPC.
export interface NewApiAccountDashboardRecord {
  createdAt: number
  modelName: string
  tokenUsed: number
  count: number
  quota: number
}

export interface NewApiAccountDashboardData {
  startTimestamp: number
  endTimestamp: number
  records: NewApiAccountDashboardRecord[]
}

export interface NewApiAccountTaskQuery {
  page?: number
  pageSize?: number
  platform?: string
  taskId?: string
  status?: string
  action?: string
  startTimestamp?: number
  endTimestamp?: number
}

// Customer-facing whitelist for GET /api/task/self. The wire record also
// contains user_id, channel_id, username, data and arbitrary properties; none
// of those fields cross IPC. Only the two documented model-name properties
// are extracted below.
export interface NewApiAccountTaskRecord {
  id: number
  taskId: string
  platform: string
  group: string
  quota: number
  action: string
  status: string
  failReason: string
  resultUrl: string
  submitAt: string
  startAt: string
  finishAt: string
  progress: string
  originModelName: string
  upstreamModelName: string
}

export interface NewApiAccountTaskPage {
  page: number
  pageSize: number
  total: number
  tasks: NewApiAccountTaskRecord[]
}

export interface NewApiAccountKeysQuery {
  /** 1-based; matches new-api's `p` query parameter, same convention as NewApiAccountUsageQuery. */
  page?: number
  /** Server clamps to 100 regardless of what is sent (common/page_info.go). */
  pageSize?: number
}

// One row of GET /api/token/'s `items` array (model.Token, model/token.go),
// confirmed field-for-field against QuantumNous/new-api's controller/token.go
// (GetAllTokens/DeleteToken handlers) and model/token.go at both the `main`
// branch and the exact v1.0.0-rc.24 tag xm.solov.cc is pinned to
// (byte-identical between the two for every field read here).
//
// Deliberately a strict metadata whitelist -- I3. The wire response also
// carries user_id/model_limits_enabled/model_limits/allow_ips/
// cross_group_retry, none of which the list view needs. The `key` field is
// accepted only when it matches new-api's exact long-key mask shape; an
// accidental plaintext response is discarded before this DTO crosses IPC.
export interface NewApiAccountKey {
  id: number
  name: string
  /** Server-masked display value; never the full plaintext secret. */
  maskedKey: string
  group: string
  /** common.TokenStatus* (model/token.go): 1 enabled, 2 disabled, 3 expired, 4 exhausted. */
  status: number
  remainQuota: number
  unlimitedQuota: boolean
  usedQuota: number
  /** ISO 8601, converted from the wire's Unix-seconds Token.CreatedTime. */
  createdAt: string
  /** ISO 8601, or null when the wire's Token.ExpiredTime is the "never expires" sentinel (-1) or otherwise non-positive. */
  expiredAt: string | null
  /** ISO 8601, or null when the wire's Token.AccessedTime is its zero value (never used yet). */
  accessedAt: string | null
}

export interface NewApiAccountKeysPage {
  page: number
  pageSize: number
  total: number
  keys: NewApiAccountKey[]
}

// 个人中心 Key 管理的「添加」入参(老板需求 2026-08-10)。字段对齐
// POST /api/token/ (controller/token.go AddToken, rc.24):名称服务端上限
// 50 字符;remainQuota 是 quota 单位(美元换算由渲染层用 quotaPerUnit 完成,
// 与余额显示同一来源);expiredTime 为 Unix 秒,-1 = 永不过期(服务端哨兵)。
export interface NewApiAccountKeyCreateInput {
  name: string
  group: string
  remainQuota: number
  unlimitedQuota: boolean
  expiredTime: number
}

export interface NewApiAccountKeyUpdateInput extends NewApiAccountKeyCreateInput {
  id: number
}

export interface NewApiChangePasswordInput {
  originalPassword: string
  newPassword: string
}

// Deliberately minimal -- I3. The server's actual response to a successful
// password change carries a fresh access_token (see
// parseChangePasswordResponseData's comment for what that is for); it must
// never cross the IPC boundary into the renderer, so this is the only field
// worth exposing here.
export interface NewApiChangePasswordResult {
  /** Always true when this promise resolves -- a failed change rejects instead of resolving false. */
  changed: true
}

export interface NewApiProvisionCliKeyInput {
  name?: string
  group?: string
  remainQuota?: number
  unlimitedQuota?: boolean
  expiredTime?: number
}

// The plaintext key is meant to flow straight into a CLI config write (I3
// same-origin principle); this client never persists it itself.
export interface NewApiCliKeyResult {
  id: number
  name: string
  key: string
}

// Extends RelayBackendClient (relay-backend.ts) -- this is the first (and
// today, only) relay backend implementation, so createNewApiClient() below
// hands back an object satisfying both. The three methods declared only here
// (isAuthenticated/refreshAccessToken/getPersistableSession) have no caller
// outside this file and its own tests, so they stay off the shared contract
// per relay-backend.ts's own "add a method only once a real consumer needs
// it" rule.
export interface NewApiClientService extends RelayBackendClient {
  getStatus(): Promise<NewApiAccountStatus>
  getLegalDocument(kind: NewApiLegalDocumentKind): Promise<NewApiLegalDocument>
  // Public, unauthenticated endpoint that /api/user/register's
  // verification_code field depends on -- see register() below. Resolves on
  // success and rejects with the server's own (already sanitized) message
  // otherwise, the same as register().
  sendEmailVerification(email: string): Promise<void>
  // Public, unauthenticated endpoint (GET /api/reset_password) that always
  // resolves the same way whether or not the address has an account --
  // confirmed directly from QuantumNous/new-api's SendPasswordResetEmail
  // handler (see this method's own implementation comment for the exact
  // mechanism). Anti-enumeration: a caller can never learn from this call
  // alone whether an email is registered.
  sendPasswordResetEmail(email: string): Promise<void>
  // Public, unauthenticated endpoint (POST /api/user/reset) that completes a
  // reset started by sendPasswordResetEmail above. NOT a "choose your own
  // password" call -- see NewApiResetPasswordInput's and this method's own
  // implementation comment for why: the server verifies the emailed token
  // and, on success, generates and returns a brand-new password itself.
  resetPassword(input: NewApiResetPasswordInput): Promise<NewApiResetPasswordResult>
  register(input: NewApiRegisterInput): Promise<void>
  login(input: NewApiLoginInput): Promise<NewApiLoginResult>
  logout(): void
  isAuthenticated(): boolean
  getSessionState(): NewApiSessionState
  getBalance(): Promise<NewApiBalance>
  getTopupInfo(): Promise<NewApiTopupInfo>
  quoteTopupAmount(input: NewApiTopupAmountInput): Promise<NewApiTopupAmountQuote>
  createTopupPayment(input: NewApiTopupPaymentInput): Promise<NewApiPaymentForm>
  listTopupOrders(input?: NewApiTopupOrdersQuery): Promise<NewApiTopupOrdersPage>
  redeemTopupCode(code: string): Promise<NewApiRedemptionResult>
  transferAffiliateQuota(input: NewApiAffiliateTransferInput): Promise<void>
  listSubscriptionPlans(): Promise<NewApiSubscriptionPlan[]>
  getSubscriptionSelf(): Promise<NewApiSubscriptionSelf>
  updateSubscriptionPreference(preference: NewApiBillingPreference): Promise<NewApiBillingPreference>
  createSubscriptionPayment(input: NewApiSubscriptionPaymentInput): Promise<NewApiSubscriptionCheckout>
  purchaseSubscriptionWithBalance(planId: number): Promise<NewApiSubscriptionPurchaseResult>
  // GET /api/user/self, parsed into the richer NewApiAccountProfileDetail DTO
  // for the 个人中心 profile/邀请 tabs (W4a). Deliberately does *not* also call
  // GET /api/status the way getBalance() above does: that would duplicate a
  // network round trip just to recompute a USD conversion this method's
  // callers can already get for free from the existing getBalance() result
  // (both ultimately read the same /api/user/self quota/used_quota fields).
  getProfile(): Promise<NewApiAccountProfileDetail>
  updateDisplayName(input: NewApiDisplayNameUpdateInput): Promise<NewApiProfileUpdateResult>
  // GET /api/log/self, paginated. `input` omitted or with omitted fields
  // falls back to new-api's own server-side defaults (page 1, page size 10 --
  // common/page_info.go's GetPageQuery).
  getUsage(input?: NewApiAccountUsageQuery): Promise<NewApiAccountUsagePage>
  // GET /api/data/self, scoped server-side to the authenticated user.
  getDashboard(input: NewApiAccountDashboardQuery): Promise<NewApiAccountDashboardData>
  // GET /api/task/self, scoped server-side to the authenticated user.
  getTasks(input?: NewApiAccountTaskQuery): Promise<NewApiAccountTaskPage>
  // GET /api/token/, paginated exactly like getUsage above (same
  // common/page_info.go PageInfo envelope). Feeds the 个人中心 Key 管理 tab
  // (W4b) -- see NewApiAccountKey's own doc comment for the I3 field
  // whitelist this applies on the way out.
  listKeys(input?: NewApiAccountKeysQuery): Promise<NewApiAccountKeysPage>
  listUsableGroups(): Promise<NewApiUsableGroup[]>
  revealKey(id: number): Promise<string>
  // DELETE /api/token/:id. Destructive and immediate: any CLI config or
  // canvas session currently holding this key's plaintext stops working the
  // instant this resolves -- there is no undo. Scoped server-side to the
  // caller's own tokens (DeleteTokenById takes the authenticated userId,
  // controller/token.go), so an id belonging to another account fails rather
  // than silently no-op-ing. Plaintext reveal is a separate, explicit IPC
  // action; this destructive path remains guarded by confirm-before-revoke.
  revokeKey(id: number): Promise<void>
  // POST /api/token/ (AddToken). Response carries only {success,message} --
  // no id, no key (RECON 坑1) -- so the caller refreshes the list to see the
  // new row; nothing here needs the id.
  createKey(input: NewApiAccountKeyCreateInput): Promise<void>
  // GET /api/token/:id then PUT /api/token/ -- read-modify-write, NOT a
  // partial patch: rc.24's UpdateToken (controller/token.go) overwrites
  // name/expired_time/remain_quota/unlimited_quota/model_limits_enabled/
  // model_limits/allow_ips/group/cross_group_retry wholesale from the
  // request body, so every field this app does not edit must be read first
  // and sent back verbatim -- otherwise a simple rename would silently wipe
  // the key's model limits and group. Verified against the exact
  // v1.0.0-rc.24 tag xm.solov.cc is pinned to.
  updateKey(input: NewApiAccountKeyUpdateInput): Promise<void>
  // PUT /api/user/self with {password, original_password} -- confirmed
  // identical between the `main` branch and the exact v1.0.0-rc.24 tag
  // xm.solov.cc is pinned to (controller/user.go's UpdateSelf handler,
  // service/auth_session.go's AdvanceCurrentSessionToUserVersion). See
  // parseChangePasswordResponseData's own comment for exactly what happens
  // to *this* session afterward (short version: it keeps working, no
  // re-login needed) versus every *other* session (signed out immediately,
  // new-api's own security response to a password change).
  changePassword(input: NewApiChangePasswordInput): Promise<NewApiChangePasswordResult>
  listLoginSessions(): Promise<NewApiLoginSession[]>
  revokeLoginSession(sid: string): Promise<NewApiRevokeLoginSessionResult>
  revokeOtherLoginSessions(): Promise<NewApiRevokeOtherLoginSessionsResult>
  provisionCliKey(input?: NewApiProvisionCliKeyInput): Promise<NewApiCliKeyResult>
  /**
   * Looks up the most recently created existing token whose name starts with
   * namePrefix and re-reveals its plaintext, or null when none exists yet.
   * Lets a caller that wants "the usual key for this purpose" (e.g.
   * canvas-window.ts's xingmang-canvas-* key) reuse one it already minted
   * instead of creating a fresh token on every call -- see
   * canvas-window.ts's buildCanvasTokenDependencies for the orphan-token
   * accumulation bug this exists to close. One request (list only) when
   * nothing matches; two (list, then reveal) when something does.
   */
  findExistingCliKey(namePrefix: string): Promise<NewApiCliKeyResult | null>
  // Exchanges the captured refresh cookie for a new access_token. Every
  // authenticated call already retries through this same path once on a 401
  // (see withSession below); exposed directly too for a caller that wants to
  // proactively refresh ahead of a call it knows is coming.
  refreshAccessToken(): Promise<void>
  // Main-process-only (never serialize across IPC -- see
  // NewApiPersistableSession's own doc comment). Lets a host app (main.ts)
  // read out what to persist right after login, independent of the
  // onSessionChange push hook -- e.g. to do an initial write without having
  // to thread the callback through every call site.
  getPersistableSession(): NewApiPersistableSession | null
  // Re-establishes a session from a persisted {userId, cookies} pair captured
  // by a previous run (electron/account-session-store.ts), by spending the
  // refresh cookie for a fresh access_token and then re-fetching the profile
  // (a persisted session never carries a profile snapshot -- see
  // NewApiPersistableSession). Resolves false -- session stays unauthenticated,
  // caller should discard the persisted file -- when the credential is
  // definitively dead (server says 401, or the input fails basic shape
  // checks). Rethrows for anything else (network/timeout/unexpected server
  // response), so a caller can tell "this credential is gone" apart from
  // "couldn't reach the server this time" and keep the file for a later retry
  // in the latter case (task requirement: 恢复失败/过期一律干净降级为未登录，
  // 不报错卡启动 -- "failed" and "expired" are handled differently on purpose).
  // No-ops (returns true) if a session already exists.
  restoreSession(persisted: NewApiPersistableSession): Promise<boolean>
}

// Thrown when the server responds 401 on an authenticated call. Kept
// distinguishable from generic failures so a caller (or a future silent-
// refresh loop) can special-case "session is gone" from "request failed".
export class NewApiAuthenticationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NewApiAuthenticationError'
  }
}

interface InternalSession {
  accessToken: string
  userId: number
  cookies: string[]
  profile: NewApiAccountProfile
}

// UNLIKE every other exported type in this file, this one must never cross
// the IPC boundary into the renderer (it carries the refresh cookie, which is
// as sensitive as a password -- I3/I13). It exists purely for a same-process
// caller (main.ts, via onSessionChange/getPersistableSession/restoreSession)
// to persist and restore the long-lived credential; the access token is
// deliberately excluded because it is short-lived and cheaply re-derived from
// this via a refresh call (docs/RECON-new-api.md section D).
export interface NewApiPersistableSession {
  userId: number
  cookies: string[]
}

interface RequestContext {
  fetchImpl: NewApiFetch
  timeoutMs: number
  maxResponseBytes: number
  origin: string
}

interface PerformRequestInit {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
}

interface NewApiRawResponse {
  status: number
  ok: boolean
  payload: unknown
  headers: Headers
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asOptionalFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function validateBaseUrl(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('New-Api 服务地址格式无效')
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new Error('New-Api 服务地址必须是不含凭据的 https 地址')
  }
  return parsed
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

const controlCharacterPattern = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g')

function sanitizeUpstreamMessage(value: string, secrets: readonly string[]): string {
  if (!value) return ''
  return redactCommandText(value, secrets)
    .replace(controlCharacterPattern, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

// New-Api requires both headers on every authenticated call. Sending only
// Authorization still comes back 401, which is easy to misdiagnose as an
// expired session instead of a client bug (docs/RECON-new-api.md 坑2).
// Building both from the same session object makes that class of bug
// impossible rather than merely tested-against.
function authHeaders(session: InternalSession): Record<string, string> {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    'New-Api-User': String(session.userId),
  }
}

async function performRequest(
  ctx: RequestContext,
  pathName: string,
  init: PerformRequestInit,
  label: string,
): Promise<NewApiRawResponse> {
  const url = new URL(pathName, ctx.origin)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ctx.timeoutMs)
  timeout.unref?.()
  try {
    const response = await ctx.fetchImpl(url, {
      method: init.method,
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      // Manual redirects, then reject outright below. None of these endpoints
      // ever legitimately redirect; silently following one could repoint an
      // authenticated request (bearing the session token) at another host.
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.url) {
      const responseOrigin = safeOrigin(response.url)
      if (responseOrigin !== ctx.origin) {
        throw new Error(`${label}请求被重定向到不受信任的地址`)
      }
    }
    if (redirectStatuses.has(response.status)) {
      throw new Error(`${label}请求被重定向，已拒绝`)
    }
    const bodyText = await readBoundedResponseText(response, ctx.maxResponseBytes, label)
    let payload: unknown = null
    if (bodyText) {
      try {
        payload = JSON.parse(bodyText)
      } catch {
        payload = null
      }
    }
    return { status: response.status, ok: response.ok, payload, headers: response.headers }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${label}请求超时，请检查网络后重试`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function unwrapEnvelope(raw: NewApiRawResponse, label: string, secrets: readonly string[]): unknown {
  const envelope = isRecord(raw.payload) ? raw.payload : null
  const serverMessage = envelope && typeof envelope.message === 'string' ? envelope.message : ''
  const detail = sanitizeUpstreamMessage(serverMessage, secrets)
  if (raw.status === 401) {
    throw new NewApiAuthenticationError(detail || '登录状态已失效，请重新登录')
  }
  if (!envelope) {
    throw new Error(raw.ok ? `${label}返回的不是有效 JSON` : (detail || `${label}失败，服务返回 HTTP ${raw.status}`))
  }
  if (!raw.ok || envelope.success !== true) {
    throw new Error(detail || `${label}失败，服务返回 HTTP ${raw.status}`)
  }
  return envelope.data
}

interface LegacyBusinessEnvelope {
  data: unknown
  url: unknown
}

// The older billing handlers predate common.ApiSuccess and return
// {message:'success', data, url} without a success boolean. Keep that
// compatibility isolated to the two confirmed endpoints instead of making
// the ordinary envelope parser accept ambiguous shapes globally.
function unwrapLegacyBusinessEnvelope(
  raw: NewApiRawResponse,
  label: string,
  secrets: readonly string[],
): LegacyBusinessEnvelope {
  const envelope = isRecord(raw.payload) ? raw.payload : null
  const message = envelope && typeof envelope.message === 'string' ? envelope.message : ''
  const dataMessage = envelope && typeof envelope.data === 'string' ? envelope.data : ''
  const detail = sanitizeUpstreamMessage(message === 'error' ? dataMessage : message, secrets)
  if (raw.status === 401) {
    throw new NewApiAuthenticationError(detail || '登录状态已失效，请重新登录')
  }
  if (!envelope) {
    throw new Error(raw.ok ? `${label}返回的不是有效 JSON` : (detail || `${label}失败，服务返回 HTTP ${raw.status}`))
  }
  const succeeded = envelope.success === true || message.toLowerCase() === 'success'
  if (!raw.ok || !succeeded) {
    throw new Error(detail || `${label}失败，服务返回 HTTP ${raw.status}`)
  }
  return { data: envelope.data, url: envelope.url }
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || value.length > 256 * 1024) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || value.length > 256 * 1024) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function finiteNumberFromWire(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function safeIntegerFromWire(value: unknown): number | null {
  const parsed = finiteNumberFromWire(value)
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null
}

function unixSecondsToIso(value: unknown): string | null {
  const seconds = finiteNumberFromWire(value)
  if (seconds === null || seconds <= 0) return null
  const milliseconds = seconds * 1_000
  if (!Number.isFinite(milliseconds)) return null
  try {
    return new Date(milliseconds).toISOString()
  } catch {
    return null
  }
}

function parseHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.hash !== ''
  ) return null
  return parsed.href
}

function parseCheckoutHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null
    return parsed.href
  } catch {
    return null
  }
}

const billingPreferences = new Set<NewApiBillingPreference>([
  'subscription_first',
  'wallet_first',
  'subscription_only',
  'wallet_only',
])

function normalizeBillingPreference(value: unknown): NewApiBillingPreference {
  return typeof value === 'string' && billingPreferences.has(value as NewApiBillingPreference)
    ? value as NewApiBillingPreference
    : 'subscription_first'
}

function paymentProvider(type: string): NewApiTopupPaymentMethod['provider'] {
  if (type === 'stripe') return 'stripe'
  if (type === 'creem') return 'creem'
  if (type === 'waffo') return 'waffo'
  if (type === 'waffo_pancake') return 'waffo-pancake'
  return 'epay'
}

export function parseTopupInfo(payload: unknown): NewApiTopupInfo {
  if (!isRecord(payload)) throw new Error('充值配置响应格式异常')
  const paymentMethods: NewApiTopupPaymentMethod[] = []
  for (const entry of parseJsonArray(payload.pay_methods).slice(0, 32)) {
    if (!isRecord(entry)) continue
    const name = asString(entry.name, '').trim().slice(0, 80)
    const type = asString(entry.type, '').trim().slice(0, 64)
    if (!name || !type) continue
    const minTopup = safeIntegerFromWire(entry.min_topup) ?? 0
    paymentMethods.push({
      name,
      type,
      provider: paymentProvider(type),
      color: typeof entry.color === 'string' && entry.color.length <= 32 ? entry.color : null,
      icon: parseHttpsUrl(entry.icon),
      minTopup: Number.isFinite(minTopup) && minTopup >= 0 ? minTopup : 0,
    })
  }
  const amountOptions = parseJsonArray(payload.amount_options)
    .slice(0, 64)
    .map(safeIntegerFromWire)
    .filter((value): value is number => value !== null && value > 0)
  const discounts: Record<string, number> = {}
  for (const [key, value] of Object.entries(parseJsonRecord(payload.discount)).slice(0, 128)) {
    const amount = finiteNumberFromWire(key)
    const ratio = finiteNumberFromWire(value)
    if (amount === null || amount <= 0 || ratio === null || ratio <= 0 || ratio > 10) continue
    discounts[String(amount)] = ratio
  }
  const minTopup = safeIntegerFromWire(payload.min_topup) ?? 0
  return {
    onlineTopupEnabled: asBoolean(payload.enable_online_topup, false),
    stripeTopupEnabled: asBoolean(payload.enable_stripe_topup, false),
    creemTopupEnabled: asBoolean(payload.enable_creem_topup, false),
    waffoPancakeTopupEnabled: asBoolean(payload.enable_waffo_pancake_topup, false),
    redemptionEnabled: asBoolean(payload.enable_redemption, false),
    paymentComplianceConfirmed: asBoolean(payload.payment_compliance_confirmed, false),
    paymentComplianceTermsVersion: typeof payload.payment_compliance_terms_version === 'string'
      && payload.payment_compliance_terms_version.length <= 128
      ? payload.payment_compliance_terms_version
      : null,
    paymentMethods,
    minTopup: minTopup >= 0 ? minTopup : 0,
    amountOptions,
    discounts,
    topupLink: parseHttpsUrl(payload.topup_link),
  }
}

export function parseTopupAmountQuote(payload: unknown, amount: number): NewApiTopupAmountQuote {
  const payableAmount = finiteNumberFromWire(payload)
  if (payableAmount === null || payableAmount < 0.01) throw new Error('充值金额试算响应格式异常')
  return { amount, payableAmount }
}

export function parsePaymentForm(payload: LegacyBusinessEnvelope): NewApiPaymentForm {
  const action = parseHttpsUrl(payload.url)
  if (!action) throw new Error('支付地址格式异常，已取消打开')
  const fieldsRecord = isRecord(payload.data) ? payload.data : null
  if (!fieldsRecord) throw new Error('支付表单响应格式异常')
  const entries = Object.entries(fieldsRecord)
  if (entries.length === 0 || entries.length > 64) throw new Error('支付表单字段数量异常')
  const fields: NewApiPaymentFormField[] = []
  let totalLength = 0
  for (const [name, rawValue] of entries) {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(name)) throw new Error('支付表单字段名称异常')
    const value = typeof rawValue === 'string'
      ? rawValue
      : typeof rawValue === 'number' && Number.isFinite(rawValue) ? String(rawValue) : null
    if (value === null || value.length > 4_096) throw new Error('支付表单字段内容异常')
    totalLength += name.length + value.length
    if (totalLength > 64 * 1024) throw new Error('支付表单内容超过安全上限')
    fields.push({ name, value })
  }
  const tradeNo = fields.find((field) => field.name === 'out_trade_no')?.value ?? null
  return {
    action,
    allowedOrigin: new URL(action).origin,
    method: 'POST',
    fields,
    tradeNo: tradeNo && tradeNo.length <= 255 ? tradeNo : null,
  }
}

export function parseAccountStatus(payload: unknown): NewApiAccountStatus {
  if (!isRecord(payload)) throw new Error('账号服务状态响应格式异常')
  return {
    systemName: asString(payload.system_name, ''),
    version: asString(payload.version, ''),
    setupComplete: asBoolean(payload.setup, true),
    // 0 is a deliberately invalid sentinel, never a guessed conversion rate:
    // callers that divide by this must check it themselves (RECON 坑4 -
    // "不能硬编码"). Silently falling back to a remembered/observed value
    // would look correct while quietly mis-converting a live balance.
    quotaPerUnit: asFiniteNumber(payload.quota_per_unit, 0),
    quotaDisplayType: asString(payload.quota_display_type, ''),
    usdExchangeRate: asFiniteNumber(payload.usd_exchange_rate, 0),
    registerEnabled: asBoolean(payload.register_enabled, false),
    passwordRegisterEnabled: asBoolean(payload.password_register_enabled, false),
    emailVerificationEnabled: asBoolean(payload.email_verification, false),
    turnstileCheckEnabled: asBoolean(payload.turnstile_check, false),
  }
}

export function parseAccountProfile(payload: unknown): NewApiAccountProfile {
  const data = isRecord(payload) ? payload : null
  const userId = data ? asFiniteNumber(data.id, Number.NaN) : Number.NaN
  const username = data ? asString(data.username, '') : ''
  if (!data || !Number.isInteger(userId) || userId <= 0 || !username) {
    throw new Error('账号信息响应格式异常')
  }
  const group = typeof data.group === 'string' && data.group ? data.group : null
  return {
    userId,
    username,
    group,
    role: typeof data.role === 'number' && Number.isFinite(data.role) ? data.role : null,
    quota: asOptionalFiniteNumber(data.quota),
    usedQuota: asOptionalFiniteNumber(data.used_quota),
  }
}

// Same envelope shape as parseAccountProfile above (buildSelfUserData's
// output), just picking out the wider field set NewApiAccountProfileDetail
// needs. Kept as an independent function rather than layered on top of
// parseAccountProfile so neither one's guard/field set has to compromise for
// the other's callers.
export function parseAccountProfileDetail(payload: unknown): NewApiAccountProfileDetail {
  const data = isRecord(payload) ? payload : null
  const userId = data ? asFiniteNumber(data.id, Number.NaN) : Number.NaN
  const username = data ? asString(data.username, '') : ''
  if (!data || !Number.isInteger(userId) || userId <= 0 || !username) {
    throw new Error('账号资料响应格式异常')
  }
  return {
    userId,
    username,
    displayName: typeof data.display_name === 'string' && data.display_name ? data.display_name : null,
    email: typeof data.email === 'string' && data.email ? data.email : null,
    group: typeof data.group === 'string' && data.group ? data.group : null,
    quota: asOptionalFiniteNumber(data.quota) ?? 0,
    usedQuota: asOptionalFiniteNumber(data.used_quota) ?? 0,
    requestCount: asOptionalFiniteNumber(data.request_count) ?? 0,
    affCode: typeof data.aff_code === 'string' && data.aff_code ? data.aff_code : null,
    affCount: asOptionalFiniteNumber(data.aff_count) ?? 0,
    affQuota: asOptionalFiniteNumber(data.aff_quota) ?? 0,
    affHistoryQuota: asOptionalFiniteNumber(data.aff_history_quota) ?? 0,
  }
}

export function parseTopupOrder(payload: unknown): NewApiTopupOrder | null {
  if (!isRecord(payload)) return null
  const id = finiteNumberFromWire(payload.id)
  const tradeNo = asString(payload.trade_no, '').trim()
  if (id === null || !Number.isInteger(id) || id <= 0 || !tradeNo || tradeNo.length > 255) return null
  const rawStatus = asString(payload.status, '')
  const status: NewApiTopupOrderStatus = ['pending', 'success', 'failed', 'expired'].includes(rawStatus)
    ? rawStatus as NewApiTopupOrderStatus
    : 'unknown'
  return {
    id,
    amount: finiteNumberFromWire(payload.amount) ?? 0,
    money: finiteNumberFromWire(payload.money) ?? 0,
    tradeNo,
    paymentMethod: asString(payload.payment_method, '').slice(0, 64),
    paymentProvider: asString(payload.payment_provider, '').slice(0, 64),
    createdAt: unixSecondsToIso(payload.create_time) ?? '',
    completedAt: unixSecondsToIso(payload.complete_time),
    status,
  }
}

export function parseTopupOrdersPage(payload: unknown): NewApiTopupOrdersPage {
  if (!isRecord(payload)) throw new Error('充值订单响应格式异常')
  const orders: NewApiTopupOrder[] = []
  const items = Array.isArray(payload.items) ? payload.items.slice(0, 100) : []
  for (const entry of items) {
    const order = parseTopupOrder(entry)
    if (order) orders.push(order)
  }
  return {
    page: finiteNumberFromWire(payload.page) ?? 1,
    pageSize: finiteNumberFromWire(payload.page_size) ?? 10,
    total: finiteNumberFromWire(payload.total) ?? 0,
    orders,
  }
}

const subscriptionDurationUnits = new Set(['year', 'month', 'day', 'hour', 'custom'])
const subscriptionResetPeriods = new Set(['never', 'daily', 'weekly', 'monthly', 'custom'])

export function parseSubscriptionPlan(payload: unknown): NewApiSubscriptionPlan | null {
  if (!isRecord(payload) || !isRecord(payload.plan)) return null
  const plan = payload.plan
  const id = finiteNumberFromWire(plan.id)
  const title = asString(plan.title, '').trim()
  const durationUnit = asString(plan.duration_unit, '')
  const quotaResetPeriod = asString(plan.quota_reset_period, 'never')
  if (
    id === null
    || !Number.isInteger(id)
    || id <= 0
    || !title
    || title.length > 128
    || !subscriptionDurationUnits.has(durationUnit)
    || !subscriptionResetPeriods.has(quotaResetPeriod)
  ) return null
  return {
    id,
    title,
    subtitle: asString(plan.subtitle, '').slice(0, 255),
    priceAmount: finiteNumberFromWire(plan.price_amount) ?? 0,
    currency: asString(plan.currency, 'USD').slice(0, 8),
    durationUnit: durationUnit as NewApiSubscriptionPlan['durationUnit'],
    durationValue: finiteNumberFromWire(plan.duration_value) ?? 0,
    customSeconds: finiteNumberFromWire(plan.custom_seconds) ?? 0,
    allowBalancePay: asBoolean(plan.allow_balance_pay, true),
    allowWalletOverflow: asBoolean(plan.allow_wallet_overflow, true),
    maxPurchasePerUser: finiteNumberFromWire(plan.max_purchase_per_user) ?? 0,
    totalAmount: finiteNumberFromWire(plan.total_amount) ?? 0,
    upgradeGroup: asString(plan.upgrade_group, '').slice(0, 64),
    downgradeGroup: asString(plan.downgrade_group, '').slice(0, 64),
    quotaResetPeriod: quotaResetPeriod as NewApiSubscriptionPlan['quotaResetPeriod'],
    quotaResetCustomSeconds: finiteNumberFromWire(plan.quota_reset_custom_seconds) ?? 0,
    stripePriceId: typeof plan.stripe_price_id === 'string' && plan.stripe_price_id.length <= 128
      ? plan.stripe_price_id.trim() || null
      : null,
    creemProductId: typeof plan.creem_product_id === 'string' && plan.creem_product_id.length <= 128
      ? plan.creem_product_id.trim() || null
      : null,
    waffoPancakeProductId: typeof plan.waffo_pancake_product_id === 'string'
      && plan.waffo_pancake_product_id.length <= 128
      ? plan.waffo_pancake_product_id.trim() || null
      : null,
  }
}

export function parseSubscriptionPlans(payload: unknown): NewApiSubscriptionPlan[] {
  if (!Array.isArray(payload)) throw new Error('订阅方案响应格式异常')
  const plans: NewApiSubscriptionPlan[] = []
  for (const entry of payload.slice(0, 100)) {
    const plan = parseSubscriptionPlan(entry)
    if (plan) plans.push(plan)
  }
  return plans
}

export function parseSubscription(payload: unknown): NewApiSubscription | null {
  if (!isRecord(payload) || !isRecord(payload.subscription)) return null
  const subscription = payload.subscription
  const id = finiteNumberFromWire(subscription.id)
  const planId = finiteNumberFromWire(subscription.plan_id)
  if (
    id === null
    || !Number.isInteger(id)
    || id <= 0
    || planId === null
    || !Number.isInteger(planId)
    || planId <= 0
  ) return null
  return {
    id,
    planId,
    status: asString(subscription.status, '').slice(0, 32),
    source: asString(subscription.source, '').slice(0, 32),
    amountTotal: finiteNumberFromWire(subscription.amount_total) ?? 0,
    amountUsed: finiteNumberFromWire(subscription.amount_used) ?? 0,
    startedAt: unixSecondsToIso(subscription.start_time) ?? '',
    endsAt: unixSecondsToIso(subscription.end_time) ?? '',
    nextResetAt: unixSecondsToIso(subscription.next_reset_time),
  }
}

function parseSubscriptionCollection(payload: unknown): NewApiSubscription[] {
  if (!Array.isArray(payload)) return []
  const subscriptions: NewApiSubscription[] = []
  for (const entry of payload.slice(0, 200)) {
    const subscription = parseSubscription(entry)
    if (subscription) subscriptions.push(subscription)
  }
  return subscriptions
}

export function parseSubscriptionSelf(payload: unknown): NewApiSubscriptionSelf {
  if (!isRecord(payload)) throw new Error('当前订阅响应格式异常')
  return {
    billingPreference: normalizeBillingPreference(payload.billing_preference),
    activeSubscriptions: parseSubscriptionCollection(payload.subscriptions),
    allSubscriptions: parseSubscriptionCollection(payload.all_subscriptions),
  }
}

export function parseSubscriptionCheckout(
  provider: NewApiSubscriptionPaymentProvider,
  envelope: LegacyBusinessEnvelope,
): NewApiSubscriptionCheckout {
  if (provider === 'epay') {
    const form = parsePaymentForm(envelope)
    return { kind: 'form', form, tradeNo: form.tradeNo, expiresAt: null }
  }

  const data = isRecord(envelope.data) ? envelope.data : null
  if (!data) throw new Error('订阅支付响应格式异常')
  const rawUrl = provider === 'stripe' ? data.pay_link : data.checkout_url
  const url = parseCheckoutHttpsUrl(rawUrl)
  if (!url) throw new Error('订阅支付地址格式异常，已取消打开')
  const rawTradeNo = data.order_id
  const tradeNo = typeof rawTradeNo === 'string' && rawTradeNo.length <= 255
    ? rawTradeNo
    : null
  const rawExpiresAt = data.expires_at
  const expiresAt = typeof rawExpiresAt === 'string'
    && rawExpiresAt.length <= 128
    && Number.isFinite(Date.parse(rawExpiresAt))
    ? new Date(rawExpiresAt).toISOString()
    : null
  return { kind: 'url', url, tradeNo, expiresAt }
}

const loginSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseLoginSession(payload: unknown): NewApiLoginSession | null {
  if (!isRecord(payload)) return null
  const sid = asString(payload.sid, '').trim()
  if (!loginSessionIdPattern.test(sid)) return null
  return {
    sid,
    current: asBoolean(payload.current, false),
    loginMethod: asString(payload.login_method, '').slice(0, 64),
    ip: asString(payload.ip, '').slice(0, 128),
    userAgent: asString(payload.user_agent, '').slice(0, 512),
    createdAt: unixSecondsToIso(payload.created_at) ?? '',
    lastActiveAt: unixSecondsToIso(payload.last_active_at) ?? '',
    expiresAt: unixSecondsToIso(payload.expires_at) ?? '',
  }
}

export function parseLoginSessions(payload: unknown): NewApiLoginSession[] {
  if (!Array.isArray(payload)) throw new Error('登录设备响应格式异常')
  const sessions: NewApiLoginSession[] = []
  for (const entry of payload.slice(0, 100)) {
    const sessionEntry = parseLoginSession(entry)
    if (sessionEntry) sessions.push(sessionEntry)
  }
  return sessions
}

export function validateLoginSessionId(value: string): string {
  const sid = value.trim()
  if (!loginSessionIdPattern.test(sid)) throw new Error('登录会话 ID 格式错误')
  return sid
}

function boundedUsageString(value: unknown, maxLength: number): string {
  return asString(value, '').trim().slice(0, maxLength)
}

function nonNegativeUsageNumber(value: unknown): number {
  const parsed = finiteNumberFromWire(value)
  return parsed !== null && parsed >= 0 ? parsed : 0
}

function parseAccountUsageStreamStatus(value: unknown): NewApiAccountUsageStreamStatus | null {
  if (!isRecord(value)) return null
  return {
    status: boundedUsageString(value.status, 32),
    endReason: boundedUsageString(value.end_reason, 128),
    errorCount: nonNegativeUsageNumber(value.error_count),
    endError: boundedUsageString(value.end_error, 512),
    errors: Array.isArray(value.errors)
      ? value.errors
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 8)
        .map((entry) => entry.slice(0, 256))
      : [],
  }
}

export function parseAccountUsageDetails(value: unknown): NewApiAccountUsageDetails {
  const other = parseJsonRecord(value)
  return {
    cacheTokens: nonNegativeUsageNumber(other.cache_tokens),
    cacheCreationTokens: nonNegativeUsageNumber(other.cache_creation_tokens),
    cacheCreationTokens5m: nonNegativeUsageNumber(other.cache_creation_tokens_5m),
    cacheCreationTokens1h: nonNegativeUsageNumber(other.cache_creation_tokens_1h),
    firstResponseTimeMs: asOptionalFiniteNumber(other.frt),
    reasoningEffort: boundedUsageString(other.reasoning_effort, 32),
    modelRatio: asOptionalFiniteNumber(other.model_ratio),
    completionRatio: asOptionalFiniteNumber(other.completion_ratio),
    modelPrice: asOptionalFiniteNumber(other.model_price),
    groupRatio: asOptionalFiniteNumber(other.group_ratio),
    userGroupRatio: asOptionalFiniteNumber(other.user_group_ratio),
    cacheRatio: asOptionalFiniteNumber(other.cache_ratio),
    cacheCreationRatio: asOptionalFiniteNumber(other.cache_creation_ratio),
    cacheCreationRatio5m: asOptionalFiniteNumber(other.cache_creation_ratio_5m),
    cacheCreationRatio1h: asOptionalFiniteNumber(other.cache_creation_ratio_1h),
    billingMode: boundedUsageString(other.billing_mode, 64),
    matchedTier: boundedUsageString(other.matched_tier, 128),
    upstreamModelName: boundedUsageString(other.upstream_model_name, 128),
    streamStatus: parseAccountUsageStreamStatus(other.stream_status),
  }
}

// One entry of GET /api/log/self's `items` array. Unlike most parse*
// functions in this file, a malformed individual row is dropped rather than
// thrown on -- one bad row (e.g. a future server-side field type change)
// should degrade the usage list by one row, not blank the whole page.
export function parseAccountUsageRecord(payload: unknown): NewApiAccountUsageRecord | null {
  if (!isRecord(payload)) return null
  const id = asFiniteNumber(payload.id, Number.NaN)
  if (!Number.isInteger(id) || id <= 0) return null
  const createdAtSeconds = payload.created_at
  const createdAt = typeof createdAtSeconds === 'number' && Number.isFinite(createdAtSeconds)
    ? new Date(createdAtSeconds * 1000).toISOString()
    : ''
  return {
    id,
    createdAt,
    type: asFiniteNumber(payload.type, 0),
    modelName: asString(payload.model_name, ''),
    promptTokens: asFiniteNumber(payload.prompt_tokens, 0),
    completionTokens: asFiniteNumber(payload.completion_tokens, 0),
    quota: asFiniteNumber(payload.quota, 0),
    isStream: asBoolean(payload.is_stream, false),
    tokenName: boundedUsageString(payload.token_name, 128),
    group: boundedUsageString(payload.group, 128),
    useTimeSeconds: nonNegativeUsageNumber(payload.use_time),
    content: boundedUsageString(payload.content, 2_000),
    requestId: boundedUsageString(payload.request_id, 128),
    upstreamRequestId: boundedUsageString(payload.upstream_request_id, 256),
    details: parseAccountUsageDetails(payload.other),
  }
}

export function parseAccountUsageStats(payload: unknown): NewApiAccountUsageStats {
  const data = isRecord(payload) ? payload : {}
  return {
    quota: nonNegativeUsageNumber(data.quota),
    rpm: nonNegativeUsageNumber(data.rpm),
    tpm: nonNegativeUsageNumber(data.tpm),
  }
}

// GET /api/log/self's envelope data -- common.PageInfo (common/page_info.go)
// with its Items field populated from model.GetUserLogs. page/page_size/total
// default to new-api's own GetPageQuery defaults (page 1, page size 10) if
// somehow absent, so a malformed pagination header degrades to "page 1 of
// whatever came back" instead of throwing away a page of real usage data.
export function parseAccountUsagePage(
  payload: unknown,
  stats: NewApiAccountUsageStats = { quota: 0, rpm: 0, tpm: 0 },
): NewApiAccountUsagePage {
  const data = isRecord(payload) ? payload : null
  const items = data && Array.isArray(data.items) ? data.items : []
  const records: NewApiAccountUsageRecord[] = []
  for (const entry of items) {
    const record = parseAccountUsageRecord(entry)
    if (record) records.push(record)
  }
  return {
    page: data ? asFiniteNumber(data.page, 1) : 1,
    pageSize: data ? asFiniteNumber(data.page_size, 10) : 10,
    total: data ? asFiniteNumber(data.total, 0) : 0,
    records,
    stats,
  }
}

export function parseAccountDashboardRecord(payload: unknown): NewApiAccountDashboardRecord | null {
  if (!isRecord(payload)) return null
  const createdAt = safeIntegerFromWire(payload.created_at)
  if (createdAt === null || createdAt <= 0) return null
  const modelName = asString(payload.model_name, '').trim().slice(0, 128) || '未知模型'
  return {
    createdAt,
    modelName,
    tokenUsed: nonNegativeUsageNumber(payload.token_used),
    count: nonNegativeUsageNumber(payload.count),
    quota: nonNegativeUsageNumber(payload.quota),
  }
}

export function parseAccountDashboardData(
  payload: unknown,
  query: NewApiAccountDashboardQuery,
): NewApiAccountDashboardData {
  const records: NewApiAccountDashboardRecord[] = []
  if (Array.isArray(payload)) {
    for (const entry of payload.slice(0, 20_000)) {
      const record = parseAccountDashboardRecord(entry)
      if (record) records.push(record)
    }
  }
  return { ...query, records }
}

export function parseAccountTaskRecord(payload: unknown): NewApiAccountTaskRecord | null {
  if (!isRecord(payload)) return null
  const id = asFiniteNumber(payload.id, Number.NaN)
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const properties = parseJsonRecord(payload.properties)
  return {
    id,
    taskId: boundedUsageString(payload.task_id, 256),
    platform: boundedUsageString(payload.platform, 64),
    group: boundedUsageString(payload.group, 128),
    quota: nonNegativeUsageNumber(payload.quota),
    action: boundedUsageString(payload.action, 64),
    status: boundedUsageString(payload.status, 32),
    failReason: boundedUsageString(payload.fail_reason, 2_000),
    resultUrl: boundedUsageString(payload.result_url, 2_048),
    submitAt: unixSecondsToIso(payload.submit_time) ?? '',
    startAt: unixSecondsToIso(payload.start_time) ?? '',
    finishAt: unixSecondsToIso(payload.finish_time) ?? '',
    progress: boundedUsageString(payload.progress, 32),
    originModelName: boundedUsageString(properties.origin_model_name, 128),
    upstreamModelName: boundedUsageString(properties.upstream_model_name, 128),
  }
}

export function parseAccountTaskPage(payload: unknown): NewApiAccountTaskPage {
  const data = isRecord(payload) ? payload : null
  const items = data && Array.isArray(data.items) ? data.items : []
  const tasks: NewApiAccountTaskRecord[] = []
  for (const entry of items) {
    const task = parseAccountTaskRecord(entry)
    if (task) tasks.push(task)
  }
  return {
    page: data ? asFiniteNumber(data.page, 1) : 1,
    pageSize: data ? asFiniteNumber(data.page_size, 10) : 10,
    total: data ? asFiniteNumber(data.total, 0) : 0,
    tasks,
  }
}

// One entry of GET /api/token/'s `items` array. Mirrors
// parseAccountUsageRecord's own "drop a malformed row instead of failing the
// whole page" posture -- one bad token row should shrink the Key 管理 list by
// one row, not blank it entirely.
//
// I3: this function's field list is a hand-picked whitelist, not a spread or
// a generic mapper -- it must stay that way even if model.Token grows new
// fields upstream. The key parser is fail-closed: only MaskTokenKey's
// 4 + 10 asterisks + 4 shape is allowed through, never a full secret.
function parseMaskedTokenKey(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  const withoutPrefix = trimmed.startsWith('sk-') ? trimmed.slice(3) : trimmed
  return /^[A-Za-z0-9]{4}\*{10}[A-Za-z0-9]{4}$/.test(withoutPrefix)
    ? `sk-${withoutPrefix}`
    : ''
}

export function parseAccountKey(payload: unknown): NewApiAccountKey | null {
  if (!isRecord(payload)) return null
  const id = asFiniteNumber(payload.id, Number.NaN)
  if (!Number.isInteger(id) || id <= 0) return null
  const createdSeconds = payload.created_time
  const createdAt = typeof createdSeconds === 'number' && Number.isFinite(createdSeconds)
    ? new Date(createdSeconds * 1000).toISOString()
    : ''
  const expiredSeconds = payload.expired_time
  const expiredAt = typeof expiredSeconds === 'number' && Number.isFinite(expiredSeconds) && expiredSeconds > 0
    ? new Date(expiredSeconds * 1000).toISOString()
    : null
  const accessedSeconds = payload.accessed_time
  const accessedAt = typeof accessedSeconds === 'number' && Number.isFinite(accessedSeconds) && accessedSeconds > 0
    ? new Date(accessedSeconds * 1000).toISOString()
    : null
  return {
    id,
    name: asString(payload.name, ''),
    maskedKey: parseMaskedTokenKey(payload.key),
    group: asString(payload.group, ''),
    status: asFiniteNumber(payload.status, 0),
    remainQuota: asFiniteNumber(payload.remain_quota, 0),
    unlimitedQuota: asBoolean(payload.unlimited_quota, false),
    usedQuota: asFiniteNumber(payload.used_quota, 0),
    createdAt,
    expiredAt,
    accessedAt,
  }
}

export function parseUsableGroups(payload: unknown): NewApiUsableGroup[] {
  if (!isRecord(payload)) throw new Error('可用分组响应格式异常')
  return Object.entries(payload).flatMap(([name, raw]) => {
    if (!name.trim() || !isRecord(raw)) return []
    const ratio = raw.ratio
    if (typeof ratio !== 'number' && typeof ratio !== 'string') return []
    return [{
      name,
      description: asString(raw.desc, name),
      ratio,
    }]
  }).sort((left, right) => {
    if (left.name === 'default') return -1
    if (right.name === 'default') return 1
    return left.name.localeCompare(right.name, 'zh-CN')
  })
}

// GET /api/token/'s envelope data -- the same common.PageInfo
// (common/page_info.go) shape as GET /api/log/self, confirmed directly from
// GetAllTokens (controller/token.go): pageInfo.SetTotal(...) /
// pageInfo.SetItems(...) then common.ApiSuccess(c, pageInfo). Defaults mirror
// parseAccountUsagePage's for the same reason -- a malformed pagination
// header degrades to "page 1 of whatever came back" instead of discarding a
// page of real key data.
export function parseAccountKeysPage(payload: unknown): NewApiAccountKeysPage {
  const data = isRecord(payload) ? payload : null
  const items = data && Array.isArray(data.items) ? data.items : []
  const keys: NewApiAccountKey[] = []
  for (const entry of items) {
    const key = parseAccountKey(entry)
    if (key) keys.push(key)
  }
  return {
    page: data ? asFiniteNumber(data.page, 1) : 1,
    pageSize: data ? asFiniteNumber(data.page_size, 10) : 10,
    total: data ? asFiniteNumber(data.total, 0) : 0,
    keys,
  }
}

function normalizeExpiresAt(value: unknown): string | null {
  if (typeof value === 'string' && value) return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    // new-api reports epoch seconds for *_time fields elsewhere in the API;
    // treat this the same way rather than assuming milliseconds.
    return new Date(value * 1000).toISOString()
  }
  return null
}

export interface NewApiRawLoginData {
  accessToken: string
  accessExpiresAt: string | null
  account: NewApiAccountProfile
}

export function parseLoginResponseData(payload: unknown): NewApiRawLoginData {
  if (!isRecord(payload)) throw new Error('登录响应格式异常')
  const accessToken = asString(payload.access_token, '')
  if (!accessToken) throw new Error('登录响应缺少访问令牌')
  return {
    accessToken,
    accessExpiresAt: normalizeExpiresAt(payload.access_expires_at),
    account: parseAccountProfile(payload.user),
  }
}

export interface NewApiRawRefreshData {
  accessToken: string
  accessExpiresAt: string | null
}

export function parseRefreshResponseData(payload: unknown): NewApiRawRefreshData {
  const data = isRecord(payload) ? payload : null
  const accessToken = data ? asString(data.access_token, '') : ''
  if (!accessToken) throw new Error('续期响应缺少访问令牌')
  return { accessToken, accessExpiresAt: normalizeExpiresAt(data?.access_expires_at) }
}

export interface NewApiResetPasswordResult {
  newPassword: string
}

// Unlike every other envelope this file unwraps, ResetPassword's success
// `data` field is the freshly generated password itself -- a bare string,
// not an object (controller/misc.go: `"data": password`). Guards against a
// missing/blank value rather than assuming the shape, the same defensive
// posture as every other parse* function here.
export function parseResetPasswordResponseData(payload: unknown): NewApiResetPasswordResult {
  if (typeof payload !== 'string' || !payload.trim()) {
    throw new Error('重置密码响应格式异常，未返回新密码')
  }
  return { newPassword: payload }
}

export interface NewApiRawChangePasswordData {
  accessToken: string
  accessExpiresAt: string | null
}

// PUT /api/user/self's success envelope when a password change actually
// happened (controller/user.go's UpdateSelf, the `if updatePassword {...}`
// branch) is *not* the plain {success,message} every other write in this
// file returns -- it hands back a fresh AuthBundle {access_token, token_type,
// access_expires_at, session}, because the access token this same request
// was authenticated with is about to become stale the instant this call
// commits (service/auth_session.go's AdvanceCurrentSessionToUserVersion bumps
// this *session's* stored auth-version counter to match the just-changed
// password, but deliberately does not rotate the refresh-token secret --
// only *other* sessions get revoked (RevokeOtherUserSessions), current-caller
// excluded). Practically: the desktop app's already-captured refresh cookie
// keeps working unchanged; only the access_token needs to be swapped in for
// this session to keep making authenticated calls without a spurious 401.
// Confirmed identical between the `main` branch and the exact v1.0.0-rc.24
// tag xm.solov.cc is pinned to (byte-for-byte, both the handler and the
// service function it calls).
//
// Returns null instead of throwing on a missing/malformed bundle: by the
// time this is called, envelope.success was already true, so the password
// itself genuinely changed -- a parse hiccup here must not fail the whole
// operation. changePassword()'s caller just skips the optimistic in-place
// session update in that case; the next authenticated call in this session
// would 401 against the superseded access token and self-heal via the
// ordinary silent-refresh path (withSession/retryAfterSilentRefresh), since
// -- per the paragraph above -- the refresh cookie was never invalidated.
export function parseChangePasswordResponseData(payload: unknown): NewApiRawChangePasswordData | null {
  if (!isRecord(payload)) return null
  const accessToken = asString(payload.access_token, '')
  if (!accessToken) return null
  return { accessToken, accessExpiresAt: normalizeExpiresAt(payload.access_expires_at) }
}

// Captures every Set-Cookie the server sent, stripped down to bare
// "name=value" pairs (attributes like Path/HttpOnly/SameSite dropped). The
// main process has no browser cookie jar (RECON 坑3), so this is the only
// record of the refresh cookie; it is replayed verbatim on refresh rather
// than assuming a specific cookie name, since RECON never confirmed one.
export function extractSessionCookies(headers: Headers): string[] {
  return headers.getSetCookie()
    .map((entry) => entry.split(';', 1)[0].trim())
    .filter((entry) => entry.length > 0 && entry.includes('='))
}

// The bare cookie *value* -- the part after "=" -- is exactly as sensitive as
// the refresh cookie itself (I13). If a misbehaving backend, proxy, or WAF
// ever echoed the Cookie header (or a fragment of it) back into a response's
// JSON `message` field, unwrapEnvelope's redaction previously had no idea the
// value was secret and would let it straight through into the thrown Error's
// .message -- which two call sites then log verbatim: registerTrustedHandler
// folds every failed account:* IPC call's error.message into the runtime log
// (ipc.ts), and restoreAccountSessionOnStartup logs a failed restoreSession()
// the same way under a `reason` key (account-session-store.ts) that
// runtime-log.ts's key-name-based sanitizeValue never inspects (the key is
// "reason", not "cookie"/"token"/etc). Both land in the persisted runtime.jsonl
// and, from there, in a user's feedback export. Keeping just the value rather
// than the whole "name=value" pair still redacts the pair when both appear
// together (the value substring is found and blanked out either way), while
// also catching the value alone if a response echoes it without the cookie's
// name.
function cookieValueSecrets(cookies: readonly string[]): string[] {
  return cookies
    .map((entry) => entry.slice(entry.indexOf('=') + 1))
    .filter((value) => value.length > 0)
}

export function computeBalanceDisplay(quota: number, quotaPerUnit: number): number {
  if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) {
    throw new Error('无法获取余额换算比例，请稍后重试')
  }
  return quota / quotaPerUnit
}

export function buildCliKeyName(prefix = 'xingmang-desktop'): string {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  return `${prefix}-${Date.now().toString(36)}-${suffix}`.slice(0, 128)
}

function collectionEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isRecord(payload)) return []
  for (const key of ['items', 'records', 'tokens', 'data']) {
    if (Array.isArray(payload[key])) return payload[key] as unknown[]
  }
  return []
}

// Step 2 of the CLI-key three-call flow (RECON 坑1): POST /api/token/ never
// returns the new record's id, so it has to be found again by the unique
// name buildCliKeyName() generated for it.
export function findCliKeyIdByName(payload: unknown, name: string): number | null {
  for (const entry of collectionEntries(payload)) {
    if (!isRecord(entry)) continue
    if (asString(entry.name, '') !== name) continue
    const id = entry.id
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id
  }
  return null
}

export interface NewApiExistingCliKeyMatch {
  id: number
  name: string
}

// Backs findExistingCliKey (below): a prefix match over potentially many
// tokens, used to reuse an already-provisioned key (e.g. canvas-window.ts's
// xingmang-canvas-* tokens) instead of unconditionally minting a new one.
// Multiple matches can legitimately exist (a prior run of the bug this
// closes, or the same account used from more than one machine before this
// shipped); the highest id is the most recently created, and anything else
// would be an arbitrary tie-break.
export function findNewestCliKeyIdByNamePrefix(
  payload: unknown,
  namePrefix: string,
): NewApiExistingCliKeyMatch | null {
  let best: NewApiExistingCliKeyMatch | null = null
  for (const entry of collectionEntries(payload)) {
    if (!isRecord(entry)) continue
    const name = asString(entry.name, '')
    if (!name.startsWith(namePrefix)) continue
    const id = entry.id
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) continue
    if (!best || id > best.id) best = { id, name }
  }
  return best
}

export function findNewestUsableCliKeyByGroup(
  payload: unknown,
  group: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): NewApiExistingCliKeyMatch | null {
  let best: NewApiExistingCliKeyMatch | null = null
  for (const entry of collectionEntries(payload)) {
    if (!isRecord(entry) || asString(entry.group, '') !== group) continue
    if (asFiniteNumber(entry.status, 0) !== 1) continue
    const expiredTime = asFiniteNumber(entry.expired_time, -1)
    if (expiredTime !== -1 && expiredTime <= nowSeconds) continue
    const unlimitedQuota = entry.unlimited_quota === true
    const remainQuota = asFiniteNumber(entry.remain_quota, 0)
    if (!unlimitedQuota && remainQuota <= 0) continue
    const id = entry.id
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) continue
    const name = asString(entry.name, '')
    if (!best || id > best.id) best = { id, name }
  }
  return best
}

export function parseCliKeySecret(payload: unknown): string | null {
  const data = isRecord(payload) ? payload : null
  const candidate = data && typeof data.key === 'string'
    ? data.key
    : typeof payload === 'string' ? payload : null
  if (!candidate?.trim()) return null
  const trimmed = candidate.trim()
  return trimmed.startsWith('sk-') ? trimmed : `sk-${trimmed}`
}

// new-api (this module) is the first relay backend and, per CLAUDE.md's
// multi-backend plan, currently the only one -- so every flag is true. See
// relay-backend.ts's RelayBackendCapabilities for what a future backend
// flipping one of these to false would mean for the renderer.
const newApiCapabilities: RelayBackendCapabilities = {
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

export function createNewApiClient(options: NewApiClientOptions = {}): NewApiClientService {
  const origin = validateBaseUrl(options.baseUrl ?? defaultBaseUrl).origin
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError('New-Api 客户端超时必须是 1 到 120000 毫秒的整数')
  }
  const maxResponseBytes = options.maxResponseBytes ?? defaultMaxResponseBytes
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('New-Api 客户端响应上限必须是正整数')
  }
  const ctx: RequestContext = {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs,
    maxResponseBytes,
    origin,
  }

  const legalDocumentCache = new Map<NewApiLegalDocumentKind, { expiresAt: number; value: NewApiLegalDocument }>()

  let session: InternalSession | null = null

  // Every reassignment of `session` funnels through here so onSessionChange
  // (the one hook a host app needs for on-disk persistence) can never be
  // forgotten at a new call site -- see its doc comment in
  // NewApiClientOptions for why that matters.
  const setSession = (next: InternalSession | null): void => {
    session = next
    options.onSessionChange?.(
      next ? { userId: next.userId, cookies: [...next.cookies] } : null,
    )
  }

  const requireSession = (): InternalSession => {
    if (!session) throw new Error('请先登录星芒账号')
    return session
  }

  // Shared by refreshAccessToken, restoreSession, and withSession's own
  // silent-retry below. Deliberately does *not* go through withSession
  // itself: withSession's retry path calls this to recover from a 401, and
  // if the refresh endpoint could itself somehow answer 401, routing through
  // withSession here would recurse into another retry attempt instead of
  // failing cleanly.
  const performRefresh = async (current: InternalSession): Promise<InternalSession> => {
    if (current.cookies.length === 0) throw new Error('没有可用的登录凭据用于续期，请重新登录')
    const raw = await performRequest(
      ctx,
      refreshPath,
      { method: 'POST', headers: { Cookie: current.cookies.join('; ') } },
      '登录状态续期',
    )
    const data = parseRefreshResponseData(unwrapEnvelope(
      raw,
      '登录状态续期',
      [current.accessToken, ...cookieValueSecrets(current.cookies)],
    ))
    const newCookies = extractSessionCookies(raw.headers)
    return {
      ...current,
      accessToken: data.accessToken,
      cookies: newCookies.length > 0 ? newCookies : current.cookies,
    }
  }

  // Runs at most one silent refresh-and-retry after a 401 (docs/RECON-new-api.md
  // section D: "401 时凭 refresh cookie 静默续期"). Bounded to exactly one
  // attempt by construction -- this function does not call itself, and the
  // retried run() is only ever invoked once -- so a session that is well and
  // truly dead fails fast instead of looping. If refresh itself fails for any
  // reason, or the retried call 401s again even with a fresh access_token,
  // the session is cleared and the *original* 401 is what the caller sees: a
  // failed recovery attempt shouldn't bury the real failure behind unrelated
  // refresh-plumbing noise (e.g. a network blip mid-refresh).
  const retryAfterSilentRefresh = async <T>(
    failedSession: InternalSession,
    run: (current: InternalSession) => Promise<T>,
    originalError: NewApiAuthenticationError,
  ): Promise<T> => {
    let refreshed: InternalSession
    try {
      refreshed = await performRefresh(failedSession)
    } catch {
      setSession(null)
      throw originalError
    }
    setSession(refreshed)
    try {
      return await run(refreshed)
    } catch (retryError) {
      if (retryError instanceof NewApiAuthenticationError) setSession(null)
      throw retryError
    }
  }

  const withSession = async <T>(run: (current: InternalSession) => Promise<T>): Promise<T> => {
    const current = requireSession()
    try {
      return await run(current)
    } catch (error) {
      if (!(error instanceof NewApiAuthenticationError)) throw error
      return await retryAfterSilentRefresh(current, run, error)
    }
  }

  const getStatus = async (): Promise<NewApiAccountStatus> => {
    const raw = await performRequest(ctx, statusPath, { method: 'GET' }, '账号服务状态查询')
    return parseAccountStatus(unwrapEnvelope(raw, '账号服务状态查询', []))
  }

  const getLegalDocument = async (kind: NewApiLegalDocumentKind): Promise<NewApiLegalDocument> => {
    const pathName = legalDocumentPaths[kind]
    if (!pathName) throw new Error('未知的法律文档类型')
    const cached = legalDocumentCache.get(kind)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const raw = await performRequest(ctx, pathName, { method: 'GET' }, '法律文档读取')
    const data = unwrapEnvelope(raw, '法律文档读取', [])
    if (typeof data !== 'string' || !data.trim()) throw new Error('法律文档暂未配置')
    const value = { kind, markdown: data.trim(), fetchedAt: new Date().toISOString() }
    legalDocumentCache.set(kind, { expiresAt: Date.now() + 10 * 60 * 1_000, value })
    return value
  }

  // Confirmed against this instance's own new-api source (rc.22 custom
  // branch, commit 823e263): GET /api/verification, target address as a
  // plain `email` query parameter, no request body. Public like getStatus
  // above -- no Authorization/New-Api-User headers -- and this instance runs
  // with turnstile_check=false, so no turnstile parameter either (unlike
  // login's optional turnstileToken). Success is decided by the envelope's
  // `success` field via the shared unwrapEnvelope, not the HTTP status: a
  // request that reaches the per-IP rate limit (30s / 2 sends) comes back as
  // HTTP 429 with its own {success:false, message}, and an unconfigured SMTP
  // relay or an already-registered address both come back as plain HTTP 200
  // + {success:false, message} -- unwrapEnvelope already treats both the same
  // as any other failure, so there is nothing bespoke to special-case here.
  const sendEmailVerification = async (email: string): Promise<void> => {
    const trimmed = email.trim().toLowerCase()
    if (!trimmed) throw new Error('请输入邮箱地址')
    const raw = await performRequest(
      ctx,
      `${verificationPath}?email=${encodeURIComponent(trimmed)}`,
      { method: 'GET' },
      '发送邮箱验证码',
    )
    unwrapEnvelope(raw, '发送邮箱验证码', [])
  }

  // Confirmed against QuantumNous/new-api's own source (controller/misc.go's
  // SendPasswordResetEmail handler -- see NewApiResetPasswordInput's own
  // comment for the version-drift caveat that applies here too): GET
  // /api/reset_password, target address as a plain `email` query parameter,
  // same shape as sendEmailVerification above. Unlike sendEmailVerification
  // though (which can legitimately fail with "email already registered" --
  // useful feedback during registration), this handler unconditionally
  // returns {success:true} whether or not the address has an account:
  // model.GetUniqueUserByEmail only gates whether an email actually gets
  // sent, never the response. So unwrapEnvelope's ordinary failure path
  // below only ever fires for a genuine transport/validation/rate-limit
  // problem -- never to confirm or deny that an email exists. Anti-
  // enumeration by construction, not by any check this client performs.
  const sendPasswordResetEmail = async (email: string): Promise<void> => {
    const trimmed = email.trim().toLowerCase()
    if (!trimmed) throw new Error('请输入邮箱地址')
    const raw = await performRequest(
      ctx,
      `${resetPasswordEmailPath}?email=${encodeURIComponent(trimmed)}`,
      { method: 'GET' },
      '发送密码重置邮件',
    )
    unwrapEnvelope(raw, '发送密码重置邮件', [])
  }

  // POST /api/user/reset. NOT a "submit your own new password" call despite
  // the feature being named "reset password" -- confirmed directly from
  // controller/misc.go's ResetPassword handler and its PasswordResetRequest
  // wire type ({Email, Token}, no password field at all): the server
  // generates a fresh random password the instant the token verifies and
  // hands it back in the response body (parseResetPasswordResponseData
  // above). `token` is the opaque value sendPasswordResetEmail embedded in
  // the emailed link's `token=` query parameter (a full UUID with dashes
  // stripped, not a short human-typed code like sendEmailVerification's),
  // checked server-side with a plain string-equality lookup against
  // whatever was last generated for this email, 10-minute validity. Redacts
  // the token from any failure message the same way register() redacts its
  // password/verificationCode (I13) -- it is exactly as sensitive as a
  // password, since possessing it is sufficient to complete the reset.
  const resetPassword = async (input: NewApiResetPasswordInput): Promise<NewApiResetPasswordResult> => {
    const email = input.email.trim().toLowerCase()
    const token = input.token.trim()
    if (!email) throw new Error('请输入邮箱地址')
    if (!token) throw new Error('请输入重置码')
    const raw = await performRequest(
      ctx,
      resetPasswordPath,
      { method: 'POST', body: { email, token } },
      '重置密码',
    )
    return parseResetPasswordResponseData(unwrapEnvelope(raw, '重置密码', [token]))
  }

  // RECON never exercised /api/user/register against the live instance
  // (read-only recon, no writes), but this task's follow-up research read
  // QuantumNous/new-api's own controller/user.go Register handler directly:
  // on success it replies `c.JSON(http.StatusOK, gin.H{"success": true,
  // "message": ""})` -- no token, no session, no user object -- matching the
  // official web frontend (web/src/features/auth/sign-up/components/
  // sign-up-form.tsx), which shows a success toast and redirects to sign-in
  // rather than auto-logging in. Still resolves to void rather than parsing
  // an assumed `data` shape: the customized xm.solov.cc branch could in
  // principle add fields, and nothing here needs them. The caller (App.tsx)
  // is expected to route the user to LoginDialog instead of chaining an
  // automatic login the server was never going to hand a session for.
  const register = async (input: NewApiRegisterInput): Promise<void> => {
    const email = input.email.trim()
    const password = input.password
    const verificationCode = input.verificationCode.trim()
    const username = input.username.trim()
    if (!email) throw new Error('请输入邮箱地址')
    if (!password) throw new Error('请输入密码')
    if (!verificationCode) throw new Error('请输入邮箱验证码')
    if (!username) throw new Error('请输入用户名')
    const body: Record<string, unknown> = {
      username,
      password,
      email,
      verification_code: verificationCode,
    }
    if (input.affCode) body.aff_code = input.affCode
    const raw = await performRequest(ctx, registerPath, { method: 'POST', body }, '账号注册')
    unwrapEnvelope(raw, '账号注册', [password, verificationCode])
  }

  const login = async (input: NewApiLoginInput): Promise<NewApiLoginResult> => {
    const username = input.username.trim()
    const password = input.password
    if (!username || !password) throw new Error('请输入用户名和密码')
    const body: Record<string, unknown> = { username, password }
    if (input.turnstileToken) body.turnstile = input.turnstileToken
    const raw = await performRequest(ctx, loginPath, { method: 'POST', body }, '账号登录')
    const data = parseLoginResponseData(unwrapEnvelope(raw, '账号登录', [password]))
    const cookies = extractSessionCookies(raw.headers)
    setSession({ accessToken: data.accessToken, userId: data.account.userId, cookies, profile: data.account })
    // Strip accessToken before it ever leaves the main process (I3/I13).
    return { account: data.account, accessExpiresAt: data.accessExpiresAt }
  }

  const logout = (): void => {
    setSession(null)
  }

  const isAuthenticated = (): boolean => session !== null

  const getSessionState = (): NewApiSessionState => ({
    authenticated: session !== null,
    account: session?.profile ?? null,
  })

  const getBalance = (): Promise<NewApiBalance> => withSession(async (current) => {
    const [statusRaw, selfRaw] = await Promise.all([
      performRequest(ctx, statusPath, { method: 'GET' }, '账号余额查询'),
      performRequest(ctx, selfPath, { method: 'GET', headers: authHeaders(current) }, '账号余额查询'),
    ])
    const status = parseAccountStatus(unwrapEnvelope(statusRaw, '账号余额查询', []))
    const profile = parseAccountProfile(unwrapEnvelope(selfRaw, '账号余额查询', [current.accessToken]))
    if (profile.quota === null) throw new Error('账号余额查询失败，服务未返回余额')
    return {
      quota: profile.quota,
      usedQuota: profile.usedQuota ?? 0,
      quotaPerUnit: status.quotaPerUnit,
      quotaDisplayType: status.quotaDisplayType,
      usdExchangeRate: status.usdExchangeRate,
      displayAmount: computeBalanceDisplay(profile.quota, status.quotaPerUnit),
    }
  })

  const getTopupInfo = (): Promise<NewApiTopupInfo> => withSession(async (current) => {
    const raw = await performRequest(
      ctx,
      topupInfoPath,
      { method: 'GET', headers: authHeaders(current) },
      '充值配置查询',
    )
    return parseTopupInfo(unwrapEnvelope(raw, '充值配置查询', [current.accessToken]))
  })

  function validateTopupAmount(amount: number): number {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('充值数量格式错误')
    return amount
  }

  const quoteTopupAmount = (input: NewApiTopupAmountInput): Promise<NewApiTopupAmountQuote> => (
    withSession(async (current) => {
      const amount = validateTopupAmount(input.amount)
      const raw = await performRequest(
        ctx,
        topupAmountPath,
        { method: 'POST', body: { amount }, headers: authHeaders(current) },
        '充值金额试算',
      )
      const envelope = unwrapLegacyBusinessEnvelope(raw, '充值金额试算', [current.accessToken])
      return parseTopupAmountQuote(envelope.data, amount)
    })
  )

  const createTopupPayment = (input: NewApiTopupPaymentInput): Promise<NewApiPaymentForm> => (
    withSession(async (current) => {
      const amount = validateTopupAmount(input.amount)
      const paymentMethod = input.paymentMethod.trim()
      if (!paymentMethod || paymentMethod.length > 64) throw new Error('支付方式格式错误')
      const raw = await performRequest(
        ctx,
        topupPaymentPath,
        {
          method: 'POST',
          body: { amount, payment_method: paymentMethod },
          headers: authHeaders(current),
        },
        '充值订单创建',
      )
      return parsePaymentForm(unwrapLegacyBusinessEnvelope(
        raw,
        '充值订单创建',
        [current.accessToken],
      ))
    })
  )

  const listTopupOrders = (input: NewApiTopupOrdersQuery = {}): Promise<NewApiTopupOrdersPage> => (
    withSession(async (current) => {
      const params = new URLSearchParams()
      if (input.page !== undefined) {
        if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > 1_000_000) {
          throw new Error('订单页码格式错误')
        }
        params.set('p', String(input.page))
      }
      if (input.pageSize !== undefined) {
        if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) {
          throw new Error('订单分页大小格式错误')
        }
        params.set('page_size', String(input.pageSize))
      }
      const keyword = input.keyword?.trim() ?? ''
      if (keyword.length > 128) throw new Error('订单搜索词不能超过 128 个字符')
      if (keyword) params.set('keyword', keyword)
      const query = params.toString()
      const raw = await performRequest(
        ctx,
        query ? `${topupOrdersPath}?${query}` : topupOrdersPath,
        { method: 'GET', headers: authHeaders(current) },
        '充值订单查询',
      )
      return parseTopupOrdersPage(unwrapEnvelope(raw, '充值订单查询', [current.accessToken]))
    })
  )

  const redeemTopupCode = (value: string): Promise<NewApiRedemptionResult> => (
    withSession(async (current) => {
      const code = value.trim()
      if (!code || code.length > 256) throw new Error('兑换码格式错误')
      const raw = await performRequest(
        ctx,
        redemptionPath,
        { method: 'POST', body: { key: code }, headers: authHeaders(current) },
        '兑换码兑换',
      )
      const quotaAdded = finiteNumberFromWire(unwrapEnvelope(
        raw,
        '兑换码兑换',
        [current.accessToken, code],
      ))
      if (quotaAdded === null || !Number.isSafeInteger(quotaAdded) || quotaAdded < 0) {
        throw new Error('兑换码响应格式异常')
      }
      return { quotaAdded }
    })
  )

  const transferAffiliateQuota = (input: NewApiAffiliateTransferInput): Promise<void> => (
    withSession(async (current) => {
      if (!Number.isSafeInteger(input.quota) || input.quota <= 0) throw new Error('邀请额度格式错误')
      const raw = await performRequest(
        ctx,
        affiliateTransferPath,
        { method: 'POST', body: { quota: input.quota }, headers: authHeaders(current) },
        '邀请额度转余额',
      )
      unwrapEnvelope(raw, '邀请额度转余额', [current.accessToken])
    })
  )

  const listSubscriptionPlans = (): Promise<NewApiSubscriptionPlan[]> => (
    withSession(async (current) => {
      const raw = await performRequest(
        ctx,
        subscriptionPlansPath,
        { method: 'GET', headers: authHeaders(current) },
        '订阅方案查询',
      )
      return parseSubscriptionPlans(unwrapEnvelope(raw, '订阅方案查询', [current.accessToken]))
    })
  )

  const getSubscriptionSelf = (): Promise<NewApiSubscriptionSelf> => (
    withSession(async (current) => {
      const raw = await performRequest(
        ctx,
        subscriptionSelfPath,
        { method: 'GET', headers: authHeaders(current) },
        '当前订阅查询',
      )
      return parseSubscriptionSelf(unwrapEnvelope(raw, '当前订阅查询', [current.accessToken]))
    })
  )

  const updateSubscriptionPreference = (
    preference: NewApiBillingPreference,
  ): Promise<NewApiBillingPreference> => withSession(async (current) => {
    if (!billingPreferences.has(preference)) throw new Error('订阅扣费顺序格式错误')
    const raw = await performRequest(
      ctx,
      subscriptionPreferencePath,
      {
        method: 'PUT',
        body: { billing_preference: preference },
        headers: authHeaders(current),
      },
      '订阅扣费顺序更新',
    )
    const payload = unwrapEnvelope(raw, '订阅扣费顺序更新', [current.accessToken])
    if (!isRecord(payload)) throw new Error('订阅扣费顺序响应格式异常')
    return normalizeBillingPreference(payload.billing_preference)
  })

  const createSubscriptionPayment = (
    input: NewApiSubscriptionPaymentInput,
  ): Promise<NewApiSubscriptionCheckout> => withSession(async (current) => {
    if (!Number.isSafeInteger(input.planId) || input.planId <= 0) throw new Error('订阅方案 ID 格式错误')
    if (!Object.prototype.hasOwnProperty.call(subscriptionPaymentPaths, input.provider)) {
      throw new Error('订阅支付渠道格式错误')
    }
    const body: Record<string, unknown> = { plan_id: input.planId }
    if (input.provider === 'epay') {
      const method = input.paymentMethod?.trim() ?? ''
      if (!method || method.length > 64) throw new Error('订阅支付方式格式错误')
      body.payment_method = method
    } else if (input.paymentMethod !== undefined) {
      throw new Error('当前订阅支付渠道不接受支付方式参数')
    }
    const raw = await performRequest(
      ctx,
      subscriptionPaymentPaths[input.provider],
      { method: 'POST', body, headers: authHeaders(current) },
      '订阅支付订单创建',
    )
    const envelope = unwrapLegacyBusinessEnvelope(
      raw,
      '订阅支付订单创建',
      [current.accessToken],
    )
    return parseSubscriptionCheckout(input.provider, envelope)
  })

  const purchaseSubscriptionWithBalance = (planId: number): Promise<NewApiSubscriptionPurchaseResult> => (
    withSession(async (current) => {
      if (!Number.isSafeInteger(planId) || planId <= 0) throw new Error('订阅方案 ID 格式错误')
      const raw = await performRequest(
        ctx,
        subscriptionBalancePaymentPath,
        { method: 'POST', body: { plan_id: planId }, headers: authHeaders(current) },
        '余额购买订阅',
      )
      unwrapEnvelope(raw, '余额购买订阅', [current.accessToken])
      return { purchased: true }
    })
  )

  const getProfile = (): Promise<NewApiAccountProfileDetail> => withSession(async (current) => {
    const raw = await performRequest(
      ctx,
      selfPath,
      { method: 'GET', headers: authHeaders(current) },
      '账号资料查询',
    )
    return parseAccountProfileDetail(unwrapEnvelope(raw, '账号资料查询', [current.accessToken]))
  })

  const updateDisplayName = (input: NewApiDisplayNameUpdateInput): Promise<NewApiProfileUpdateResult> => (
    withSession(async (current) => {
      const displayName = input.displayName.trim()
      if (displayName.length > 20) throw new Error('显示名称不能超过 20 个字符')
      const raw = await performRequest(
        ctx,
        selfPath,
        {
          method: 'PUT',
          // UpdateSelf treats this as an overwrite DTO. Preserve username so
          // a display-name-only edit can never blank the login identifier.
          body: { username: current.profile.username, display_name: displayName },
          headers: authHeaders(current),
        },
        '账号资料更新',
      )
      unwrapEnvelope(raw, '账号资料更新', [current.accessToken])
      return { updated: true }
    })
  )

  const getUsage = (input: NewApiAccountUsageQuery = {}): Promise<NewApiAccountUsagePage> => (
    withSession(async (current) => {
      const params = new URLSearchParams()
      if (Number.isInteger(input.page) && (input.page as number) >= 1) {
        params.set('p', String(input.page))
      }
      if (Number.isInteger(input.pageSize) && (input.pageSize as number) >= 1) {
        params.set('page_size', String(input.pageSize))
      }
      if (input.type !== undefined) params.set('type', String(input.type))
      if (input.startTimestamp !== undefined) params.set('start_timestamp', String(input.startTimestamp))
      if (input.endTimestamp !== undefined) params.set('end_timestamp', String(input.endTimestamp))
      if (input.modelName) params.set('model_name', input.modelName)
      if (input.tokenName) params.set('token_name', input.tokenName)
      if (input.group) params.set('group', input.group)
      if (input.requestId) params.set('request_id', input.requestId)
      if (input.upstreamRequestId) params.set('upstream_request_id', input.upstreamRequestId)
      const listQuery = params.toString()
      const statParams = new URLSearchParams(params)
      statParams.delete('p')
      statParams.delete('page_size')
      statParams.delete('request_id')
      statParams.delete('upstream_request_id')
      const statQuery = statParams.toString()
      const [listRaw, statRaw] = await Promise.all([
        performRequest(
          ctx,
          listQuery ? `${logSelfPath}?${listQuery}` : logSelfPath,
          { method: 'GET', headers: authHeaders(current) },
          '用量明细查询',
        ),
        performRequest(
          ctx,
          statQuery ? `${logSelfStatPath}?${statQuery}` : logSelfStatPath,
          { method: 'GET', headers: authHeaders(current) },
          '用量统计查询',
        ),
      ])
      const stats = parseAccountUsageStats(unwrapEnvelope(statRaw, '用量统计查询', [current.accessToken]))
      return parseAccountUsagePage(
        unwrapEnvelope(listRaw, '用量明细查询', [current.accessToken]),
        stats,
      )
    })
  )

  const getDashboard = (input: NewApiAccountDashboardQuery): Promise<NewApiAccountDashboardData> => (
    withSession(async (current) => {
      const params = new URLSearchParams({
        start_timestamp: String(input.startTimestamp),
        end_timestamp: String(input.endTimestamp),
      })
      const raw = await performRequest(
        ctx,
        `${dataSelfPath}?${params.toString()}`,
        { method: 'GET', headers: authHeaders(current) },
        '数据看板查询',
      )
      return parseAccountDashboardData(
        unwrapEnvelope(raw, '数据看板查询', [current.accessToken]),
        input,
      )
    })
  )

  const getTasks = (input: NewApiAccountTaskQuery = {}): Promise<NewApiAccountTaskPage> => (
    withSession(async (current) => {
      const params = new URLSearchParams()
      if (Number.isInteger(input.page) && (input.page as number) >= 1) params.set('p', String(input.page))
      if (Number.isInteger(input.pageSize) && (input.pageSize as number) >= 1) params.set('page_size', String(input.pageSize))
      if (input.platform) params.set('platform', input.platform)
      if (input.taskId) params.set('task_id', input.taskId)
      if (input.status) params.set('status', input.status)
      if (input.action) params.set('action', input.action)
      if (input.startTimestamp !== undefined) params.set('start_timestamp', String(input.startTimestamp))
      if (input.endTimestamp !== undefined) params.set('end_timestamp', String(input.endTimestamp))
      const query = params.toString()
      const raw = await performRequest(
        ctx,
        query ? `${taskSelfPath}?${query}` : taskSelfPath,
        { method: 'GET', headers: authHeaders(current) },
        '任务日志查询',
      )
      return parseAccountTaskPage(unwrapEnvelope(raw, '任务日志查询', [current.accessToken]))
    })
  )

  const listKeys = (input: NewApiAccountKeysQuery = {}): Promise<NewApiAccountKeysPage> => (
    withSession(async (current) => {
      const params = new URLSearchParams()
      if (Number.isInteger(input.page) && (input.page as number) >= 1) {
        params.set('p', String(input.page))
      }
      if (Number.isInteger(input.pageSize) && (input.pageSize as number) >= 1) {
        params.set('page_size', String(input.pageSize))
      }
      const query = params.toString()
      const raw = await performRequest(
        ctx,
        query ? `${tokenCollectionPath}?${query}` : tokenCollectionPath,
        { method: 'GET', headers: authHeaders(current) },
        'Key 列表查询',
      )
      return parseAccountKeysPage(unwrapEnvelope(raw, 'Key 列表查询', [current.accessToken]))
    })
  )

  const loadUsableGroups = async (current: InternalSession): Promise<NewApiUsableGroup[]> => {
    const raw = await performRequest(
      ctx,
      userGroupsPath,
      { method: 'GET', headers: authHeaders(current) },
      '可用分组查询',
    )
    return parseUsableGroups(unwrapEnvelope(raw, '可用分组查询', [current.accessToken]))
  }

  const listUsableGroups = (): Promise<NewApiUsableGroup[]> => withSession(loadUsableGroups)

  const revealKey = (id: number): Promise<string> => withSession(async (current) => {
    if (!Number.isInteger(id) || id <= 0) throw new Error('Key ID 格式错误')
    const raw = await performRequest(
      ctx,
      tokenKeyPath(id),
      { method: 'POST', headers: authHeaders(current) },
      'Key 明文读取',
    )
    const key = parseCliKeySecret(unwrapEnvelope(raw, 'Key 明文读取', [current.accessToken]))
    if (!key) throw new Error('Key 明文读取失败，请重试')
    return key
  })

  const revokeKey = (id: number): Promise<void> => (
    withSession(async (current) => {
      // Defense in depth: ipc.ts's parseAccountRevokeKeyId already rejects
      // anything unsafe before it reaches here, but this client is also
      // callable directly by other main-process code and its own tests, so
      // the guard belongs here too rather than solely at the IPC boundary
      // (I5) -- id goes straight into a URL path segment below.
      if (!Number.isInteger(id) || id <= 0) throw new Error('Key ID 格式错误')
      const raw = await performRequest(
        ctx,
        tokenIdPath(id),
        { method: 'DELETE', headers: authHeaders(current) },
        'Key 撤销',
      )
      unwrapEnvelope(raw, 'Key 撤销', [current.accessToken])
    })
  )

  // Shared guards for createKey/updateKey -- same defense-in-depth posture
  // as revokeKey above (I5: this client is callable outside the IPC layer).
  // 50 is AddToken/UpdateToken's own server-side name cap (rc.24).
  function validateKeyEditorInput(input: NewApiAccountKeyCreateInput): { name: string; group: string } {
    const name = input.name.trim()
    if (!name) throw new Error('请输入 Key 名称')
    if (name.length > 50) throw new Error('Key 名称不能超过 50 个字符')
    const group = input.group.trim()
    if (!group || group.length > 128) throw new Error('请选择有效分组')
    if (!input.unlimitedQuota && (!Number.isInteger(input.remainQuota) || input.remainQuota < 0)) {
      throw new Error('额度格式错误')
    }
    if (!Number.isInteger(input.expiredTime) || (input.expiredTime !== -1 && input.expiredTime <= 0)) {
      throw new Error('过期时间格式错误')
    }
    return { name, group }
  }

  const assertUsableGroup = async (current: InternalSession, group: string): Promise<void> => {
    const groups = await loadUsableGroups(current)
    if (!groups.some((entry) => entry.name === group)) throw new Error(`当前账号不可使用分组「${group}」`)
  }

  const createKey = (input: NewApiAccountKeyCreateInput): Promise<void> => (
    withSession(async (current) => {
      const { name, group } = validateKeyEditorInput(input)
      await assertUsableGroup(current, group)
      const body = {
        name,
        group,
        remain_quota: input.unlimitedQuota ? 0 : input.remainQuota,
        unlimited_quota: input.unlimitedQuota,
        expired_time: input.expiredTime,
      }
      const raw = await performRequest(
        ctx,
        tokenCollectionPath,
        { method: 'POST', body, headers: authHeaders(current) },
        'Key 创建',
      )
      unwrapEnvelope(raw, 'Key 创建', [current.accessToken])
    })
  )

  const updateKey = (input: NewApiAccountKeyUpdateInput): Promise<void> => (
    withSession(async (current) => {
      if (!Number.isInteger(input.id) || input.id <= 0) throw new Error('Key ID 格式错误')
      const { name, group } = validateKeyEditorInput(input)
      await assertUsableGroup(current, group)
      // UpdateToken 是整体覆盖(见 NewApiClientService.updateKey 的注释):
      // 先 GET 当前记录,把本次不编辑的字段原样回填。record.key(掩码)
      // 按 I3 纪律绝不读取,也不进 PUT body(服务端本就不从请求读 Key)。
      const currentRaw = await performRequest(
        ctx,
        tokenIdPath(input.id),
        { method: 'GET', headers: authHeaders(current) },
        'Key 读取',
      )
      const existing = unwrapEnvelope(currentRaw, 'Key 读取', [current.accessToken])
      if (!isRecord(existing)) throw new Error('Key 详情数据不完整，已取消更新')
      const preservationFieldsValid = (
        typeof existing.remain_quota === 'number'
        && Number.isFinite(existing.remain_quota)
        && typeof existing.model_limits_enabled === 'boolean'
        && typeof existing.model_limits === 'string'
        && (typeof existing.allow_ips === 'string' || existing.allow_ips === null)
        && typeof existing.cross_group_retry === 'boolean'
      )
      if (!preservationFieldsValid) throw new Error('Key 详情数据不完整，已取消更新')
      const body = {
        id: input.id,
        name,
        expired_time: input.expiredTime,
        remain_quota: input.unlimitedQuota
          ? existing.remain_quota
          : input.remainQuota,
        unlimited_quota: input.unlimitedQuota,
        model_limits_enabled: existing.model_limits_enabled,
        model_limits: existing.model_limits,
        allow_ips: existing.allow_ips,
        group,
        cross_group_retry: group === 'auto' && existing.cross_group_retry,
      }
      const raw = await performRequest(
        ctx,
        tokenCollectionPath,
        { method: 'PUT', body, headers: authHeaders(current) },
        'Key 更新',
      )
      unwrapEnvelope(raw, 'Key 更新', [current.accessToken])
    })
  )

  const changePassword = (input: NewApiChangePasswordInput): Promise<NewApiChangePasswordResult> => (
    withSession(async (current) => {
      const originalPassword = input.originalPassword
      const newPassword = input.newPassword
      // Not trimmed: both must be forwarded exactly as typed, same reasoning
      // as parseAccountLoginInput's password field in ipc.ts.
      if (!originalPassword) throw new Error('请输入原密码')
      if (!newPassword) throw new Error('请输入新密码')
      const raw = await performRequest(
        ctx,
        selfPath,
        {
          method: 'PUT',
          body: { password: newPassword, original_password: originalPassword },
          headers: authHeaders(current),
        },
        '修改密码',
      )
      const data = unwrapEnvelope(raw, '修改密码', [originalPassword, newPassword, current.accessToken])
      const bundle = parseChangePasswordResponseData(data)
      // Optimistic in-place swap so the very next authenticated call in this
      // same session does not spuriously 401 against the now-superseded old
      // access token -- see parseChangePasswordResponseData's own comment
      // for why skipping this on a malformed/missing bundle is still safe.
      if (bundle) setSession({ ...current, accessToken: bundle.accessToken })
      return { changed: true }
    })
  )

  const listLoginSessions = (): Promise<NewApiLoginSession[]> => (
    withSession(async (current) => {
      const raw = await performRequest(
        ctx,
        loginSessionsPath,
        { method: 'GET', headers: authHeaders(current) },
        '登录设备查询',
      )
      return parseLoginSessions(unwrapEnvelope(raw, '登录设备查询', [current.accessToken]))
    })
  )

  const revokeLoginSession = (value: string): Promise<NewApiRevokeLoginSessionResult> => (
    withSession(async (current) => {
      const sid = validateLoginSessionId(value)
      const raw = await performRequest(
        ctx,
        loginSessionPath(sid),
        { method: 'DELETE', headers: authHeaders(current) },
        '登录设备撤销',
      )
      const data = unwrapEnvelope(raw, '登录设备撤销', [current.accessToken])
      if (!isRecord(data)) throw new Error('登录设备撤销响应格式异常')
      const revokedSid = asString(data.revoked_sid, '')
      if (revokedSid !== sid || typeof data.current !== 'boolean') {
        throw new Error('登录设备撤销响应格式异常')
      }
      const result = { revokedSid, current: data.current }
      if (result.current) setSession(null)
      return result
    })
  )

  const revokeOtherLoginSessions = (): Promise<NewApiRevokeOtherLoginSessionsResult> => (
    withSession(async (current) => {
      const raw = await performRequest(
        ctx,
        `${loginSessionsPath}/revoke-others`,
        { method: 'POST', headers: authHeaders(current) },
        '其他登录设备撤销',
      )
      const data = unwrapEnvelope(raw, '其他登录设备撤销', [current.accessToken])
      const revokedCount = isRecord(data) ? finiteNumberFromWire(data.revoked_count) : null
      if (revokedCount === null || !Number.isSafeInteger(revokedCount) || revokedCount < 0) {
        throw new Error('其他登录设备撤销响应格式异常')
      }
      return { revokedCount }
    })
  )

  const listAllTokenRecords = async (current: InternalSession): Promise<unknown[]> => {
    const entries: unknown[] = []
    for (let page = 1; page <= 1_000; page += 1) {
      const raw = await performRequest(
        ctx,
        `${tokenCollectionPath}?p=${page}&page_size=100`,
        { method: 'GET', headers: authHeaders(current) },
        'CLI Key 查询',
      )
      const data = unwrapEnvelope(raw, 'CLI Key 查询', [current.accessToken])
      const pageEntries = collectionEntries(data)
      entries.push(...pageEntries)
      const total = isRecord(data) ? asFiniteNumber(data.total, entries.length) : entries.length
      if (pageEntries.length === 0 || entries.length >= total) return entries
    }
    throw new Error('CLI Key 数量超过安全分页上限')
  }

  const revealCliKeyForSession = async (
    current: InternalSession,
    match: NewApiExistingCliKeyMatch,
  ): Promise<NewApiCliKeyResult> => {
    const keyRaw = await performRequest(
      ctx,
      tokenKeyPath(match.id),
      { method: 'POST', headers: authHeaders(current) },
      'CLI Key 明文读取',
    )
    const keyData = unwrapEnvelope(keyRaw, 'CLI Key 明文读取', [current.accessToken])
    const key = parseCliKeySecret(keyData)
    if (!key) throw new Error('CLI Key 明文读取失败，请重试')
    return { id: match.id, name: match.name, key }
  }

  const provisionCliKey = (input: NewApiProvisionCliKeyInput = {}): Promise<NewApiCliKeyResult> => (
    withSession(async (current) => {
      const name = (input.name?.trim() || buildCliKeyName()).slice(0, 50)
      const group = input.group?.trim()
      if (group) {
        if (group.length > 128) throw new Error('CLI Key 分组格式错误')
        await assertUsableGroup(current, group)
        const existing = findNewestUsableCliKeyByGroup(await listAllTokenRecords(current), group)
        if (existing) return revealCliKeyForSession(current, existing)
      }
      const createBody = {
        name,
        ...(group ? { group } : {}),
        remain_quota: Number.isFinite(input.remainQuota) ? input.remainQuota : 0,
        // Defaults to unlimited: the token is meant to let a CLI spend from
        // the account's own balance, which already bounds real spend. A
        // separate per-token cap is an opt-in the caller can still request.
        unlimited_quota: input.unlimitedQuota ?? true,
        expired_time: Number.isInteger(input.expiredTime) ? input.expiredTime : -1,
      }
      const createRaw = await performRequest(
        ctx,
        tokenCollectionPath,
        { method: 'POST', body: createBody, headers: authHeaders(current) },
        'CLI Key 创建',
      )
      unwrapEnvelope(createRaw, 'CLI Key 创建', [current.accessToken])

      const id = findCliKeyIdByName(await listAllTokenRecords(current), name)
      if (id === null) throw new Error('CLI Key 创建成功但未能定位新记录，请重试')

      return revealCliKeyForSession(current, { id, name })
    })
  )

  const findExistingCliKey = (namePrefix: string): Promise<NewApiCliKeyResult | null> => (
    withSession(async (current) => {
      const listRaw = await performRequest(
        ctx,
        tokenCollectionPath,
        { method: 'GET', headers: authHeaders(current) },
        'CLI Key 查询',
      )
      const listData = unwrapEnvelope(listRaw, 'CLI Key 查询', [current.accessToken])
      const match = findNewestCliKeyIdByNamePrefix(listData, namePrefix)
      if (!match) return null

      const keyRaw = await performRequest(
        ctx,
        tokenKeyPath(match.id),
        { method: 'POST', headers: authHeaders(current) },
        'CLI Key 明文读取',
      )
      const keyData = unwrapEnvelope(keyRaw, 'CLI Key 明文读取', [current.accessToken])
      const key = parseCliKeySecret(keyData)
      // Unlike provisionCliKey, a reveal failure here is not itself an
      // error worth surfacing -- the caller's contract for this function is
      // "an existing usable key, or null", and falling back to provisioning
      // a fresh one is always a safe, silent recovery (see
      // canvas-window.ts). Throwing here would turn a stale/revoked-in-the-
      // interim token into a hard failure instead.
      return key ? { id: match.id, name: match.name, key } : null
    })
  )

  // Deliberately does *not* go through withSession: this function IS
  // withSession's retry primitive (via performRefresh), so routing it back
  // through withSession would let a 401 from the refresh endpoint itself
  // trigger another silent-refresh attempt -- see performRefresh's own
  // comment. Mirrors withSession's original clear-only-on-401 semantics: a
  // transient network/timeout error here must not spuriously log the user
  // out, only a definitive "this credential is dead" from the server should.
  const refreshAccessToken = async (): Promise<void> => {
    const current = requireSession()
    try {
      setSession(await performRefresh(current))
    } catch (error) {
      if (error instanceof NewApiAuthenticationError) setSession(null)
      throw error
    }
  }

  const getPersistableSession = (): NewApiPersistableSession | null => (
    session ? { userId: session.userId, cookies: [...session.cookies] } : null
  )

  // A restored session never carries a real profile (a persisted file only
  // ever holds {userId, cookies} -- see NewApiPersistableSession); this
  // placeholder is discarded a few lines down in restoreSession, once the
  // post-refresh /api/user/self call resolves the real one. Only exists so
  // the intermediate value performRefresh operates on satisfies InternalSession.
  const placeholderProfile = (userId: number): NewApiAccountProfile => (
    { userId, username: '', group: null, role: null, quota: null, usedQuota: null }
  )

  const restoreSession = async (persisted: NewApiPersistableSession): Promise<boolean> => {
    if (session) return true
    if (!Number.isInteger(persisted.userId) || persisted.userId <= 0 || persisted.cookies.length === 0) {
      return false
    }
    const seed: InternalSession = {
      accessToken: '',
      userId: persisted.userId,
      cookies: [...persisted.cookies],
      profile: placeholderProfile(persisted.userId),
    }
    let refreshed: InternalSession
    try {
      refreshed = await performRefresh(seed)
    } catch (error) {
      if (error instanceof NewApiAuthenticationError) return false
      throw error
    }
    let profile: NewApiAccountProfile
    try {
      const selfRaw = await performRequest(
        ctx,
        selfPath,
        { method: 'GET', headers: authHeaders(refreshed) },
        '登录状态恢复',
      )
      profile = parseAccountProfile(unwrapEnvelope(selfRaw, '登录状态恢复', [refreshed.accessToken]))
    } catch (error) {
      if (error instanceof NewApiAuthenticationError) return false
      throw error
    }
    // Defensive consistency check: New-Api-User must equal the account the
    // Bearer token was actually minted for (RECON 坑2), so a self response for
    // a different user would mean the persisted userId no longer matches
    // reality -- treat that the same as an invalid credential rather than
    // silently logging the caller in as the wrong account.
    if (profile.userId !== persisted.userId) return false
    setSession({ ...refreshed, profile })
    return true
  }

  return {
    capabilities: newApiCapabilities,
    getStatus,
    getLegalDocument,
    sendEmailVerification,
    sendPasswordResetEmail,
    resetPassword,
    register,
    login,
    logout,
    isAuthenticated,
    getSessionState,
    getBalance,
    getTopupInfo,
    quoteTopupAmount,
    createTopupPayment,
    listTopupOrders,
    redeemTopupCode,
    transferAffiliateQuota,
    listSubscriptionPlans,
    getSubscriptionSelf,
    updateSubscriptionPreference,
    createSubscriptionPayment,
    purchaseSubscriptionWithBalance,
    getProfile,
    updateDisplayName,
    getUsage,
    getDashboard,
    getTasks,
    listKeys,
    listUsableGroups,
    revealKey,
    revokeKey,
    createKey,
    updateKey,
    changePassword,
    listLoginSessions,
    revokeLoginSession,
    revokeOtherLoginSessions,
    provisionCliKey,
    findExistingCliKey,
    refreshAccessToken,
    getPersistableSession,
    restoreSession,
  }
}
