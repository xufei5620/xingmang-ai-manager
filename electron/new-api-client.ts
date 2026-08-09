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
const tokenCollectionPath = '/api/token/'
const resetPasswordEmailPath = '/api/reset_password'
const resetPasswordPath = '/api/user/reset'

function tokenKeyPath(id: number): string {
  return `/api/token/${id}/key`
}

function tokenIdPath(id: number): string {
  return `/api/token/${id}`
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
}

export interface NewApiAccountUsageQuery {
  /** 1-based; matches new-api's `p` query parameter. */
  page?: number
  /** Server clamps to 100 regardless of what is sent (common/page_info.go). */
  pageSize?: number
}

// One row of GET /api/log/self's `items` array (model.Log, model/log.go).
// Deliberately narrower than the full Log struct: channel/channel_name/
// token_name/token_id/group/ip/request_id/upstream_request_id/content/other
// are relay-internal debugging fields with no value to a customer looking at
// their own usage, so they are dropped here rather than threaded across IPC
// for no reason.
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
}

export interface NewApiAccountUsagePage {
  page: number
  pageSize: number
  total: number
  records: NewApiAccountUsageRecord[]
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
// carries a `key` field (GetAllTokens masks it via buildMaskedTokenResponses
// -> Token.GetMaskedKey(), so it is never the full plaintext secret, but it
// is still a partial fragment of one), plus user_id/model_limits_enabled/
// model_limits/allow_ips/cross_group_retry, none of which this app has any
// display use for. parseAccountKey below never reads `.key` (or any of those
// other fields) under any circumstance -- see its own comment. Revealing a
// key's live plaintext value is out of scope for this wave entirely (see
// NewApiClientService.revokeKey's doc comment); this DTO exists only so a
// user can recognize *which* key is which well enough to revoke an orphaned
// one.
export interface NewApiAccountKey {
  id: number
  name: string
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
  // GET /api/user/self, parsed into the richer NewApiAccountProfileDetail DTO
  // for the 个人中心 profile/邀请 tabs (W4a). Deliberately does *not* also call
  // GET /api/status the way getBalance() above does: that would duplicate a
  // network round trip just to recompute a USD conversion this method's
  // callers can already get for free from the existing getBalance() result
  // (both ultimately read the same /api/user/self quota/used_quota fields).
  getProfile(): Promise<NewApiAccountProfileDetail>
  // GET /api/log/self, paginated. `input` omitted or with omitted fields
  // falls back to new-api's own server-side defaults (page 1, page size 10 --
  // common/page_info.go's GetPageQuery).
  getUsage(input?: NewApiAccountUsageQuery): Promise<NewApiAccountUsagePage>
  // GET /api/token/, paginated exactly like getUsage above (same
  // common/page_info.go PageInfo envelope). Feeds the 个人中心 Key 管理 tab
  // (W4b) -- see NewApiAccountKey's own doc comment for the I3 field
  // whitelist this applies on the way out.
  listKeys(input?: NewApiAccountKeysQuery): Promise<NewApiAccountKeysPage>
  // DELETE /api/token/:id. Destructive and immediate: any CLI config or
  // canvas session currently holding this key's plaintext stops working the
  // instant this resolves -- there is no undo. Scoped server-side to the
  // caller's own tokens (DeleteTokenById takes the authenticated userId,
  // controller/token.go), so an id belonging to another account fails rather
  // than silently no-op-ing. This app never reveals a key's plaintext value
  // (see NewApiAccountKey's comment), so the confirm-before-revoke UX this
  // backs is deliberately the *only* key-management action this wave ships.
  revokeKey(id: number): Promise<void>
  // PUT /api/user/self with {password, original_password} -- confirmed
  // identical between the `main` branch and the exact v1.0.0-rc.24 tag
  // xm.solov.cc is pinned to (controller/user.go's UpdateSelf handler,
  // service/auth_session.go's AdvanceCurrentSessionToUserVersion). See
  // parseChangePasswordResponseData's own comment for exactly what happens
  // to *this* session afterward (short version: it keeps working, no
  // re-login needed) versus every *other* session (signed out immediately,
  // new-api's own security response to a password change).
  changePassword(input: NewApiChangePasswordInput): Promise<NewApiChangePasswordResult>
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
  }
}

// GET /api/log/self's envelope data -- common.PageInfo (common/page_info.go)
// with its Items field populated from model.GetUserLogs. page/page_size/total
// default to new-api's own GetPageQuery defaults (page 1, page size 10) if
// somehow absent, so a malformed pagination header degrades to "page 1 of
// whatever came back" instead of throwing away a page of real usage data.
export function parseAccountUsagePage(payload: unknown): NewApiAccountUsagePage {
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
  }
}

// One entry of GET /api/token/'s `items` array. Mirrors
// parseAccountUsageRecord's own "drop a malformed row instead of failing the
// whole page" posture -- one bad token row should shrink the Key 管理 list by
// one row, not blank it entirely.
//
// I3: this function's field list is a hand-picked whitelist, not a spread or
// a generic mapper -- it must stay that way even if model.Token grows new
// fields upstream. In particular it never reads payload.key (or
// payload.token): see NewApiAccountKey's own doc comment for why that
// field's mere presence on the wire (masked or not) is irrelevant to this
// function's contract.
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
    status: asFiniteNumber(payload.status, 0),
    remainQuota: asFiniteNumber(payload.remain_quota, 0),
    unlimitedQuota: asBoolean(payload.unlimited_quota, false),
    usedQuota: asFiniteNumber(payload.used_quota, 0),
    createdAt,
    expiredAt,
    accessedAt,
  }
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

export function parseCliKeySecret(payload: unknown): string | null {
  const data = isRecord(payload) ? payload : null
  const candidate = data && typeof data.key === 'string'
    ? data.key
    : typeof payload === 'string' ? payload : null
  return candidate && candidate.trim() ? candidate.trim() : null
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

  const getProfile = (): Promise<NewApiAccountProfileDetail> => withSession(async (current) => {
    const raw = await performRequest(
      ctx,
      selfPath,
      { method: 'GET', headers: authHeaders(current) },
      '账号资料查询',
    )
    return parseAccountProfileDetail(unwrapEnvelope(raw, '账号资料查询', [current.accessToken]))
  })

  const getUsage = (input: NewApiAccountUsageQuery = {}): Promise<NewApiAccountUsagePage> => (
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
        query ? `${logSelfPath}?${query}` : logSelfPath,
        { method: 'GET', headers: authHeaders(current) },
        '用量明细查询',
      )
      return parseAccountUsagePage(unwrapEnvelope(raw, '用量明细查询', [current.accessToken]))
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

  const provisionCliKey = (input: NewApiProvisionCliKeyInput = {}): Promise<NewApiCliKeyResult> => (
    withSession(async (current) => {
      const name = (input.name?.trim() || buildCliKeyName()).slice(0, 128)
      const createBody = {
        name,
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

      const listRaw = await performRequest(
        ctx,
        tokenCollectionPath,
        { method: 'GET', headers: authHeaders(current) },
        'CLI Key 查询',
      )
      const listData = unwrapEnvelope(listRaw, 'CLI Key 查询', [current.accessToken])
      const id = findCliKeyIdByName(listData, name)
      if (id === null) throw new Error('CLI Key 创建成功但未能定位新记录，请重试')

      const keyRaw = await performRequest(
        ctx,
        tokenKeyPath(id),
        { method: 'POST', headers: authHeaders(current) },
        'CLI Key 明文读取',
      )
      const keyData = unwrapEnvelope(keyRaw, 'CLI Key 明文读取', [current.accessToken])
      const key = parseCliKeySecret(keyData)
      if (!key) throw new Error('CLI Key 明文读取失败，请重试')

      return { id, name, key }
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
    sendEmailVerification,
    sendPasswordResetEmail,
    resetPassword,
    register,
    login,
    logout,
    isAuthenticated,
    getSessionState,
    getBalance,
    getProfile,
    getUsage,
    listKeys,
    revokeKey,
    changePassword,
    provisionCliKey,
    findExistingCliKey,
    refreshAccessToken,
    getPersistableSession,
    restoreSession,
  }
}
