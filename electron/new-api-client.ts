import { randomUUID } from 'node:crypto'
import { readBoundedResponseText } from './bounded-response'
import { redactCommandText } from './command-runner'

// xm.solov.cc runs QuantumNous/new-api (rc.22, custom branch). Every endpoint
// wraps its payload as { success, message, data } -- confirmed for the CLI
// token endpoints by docs/RECON-new-api.md section C.1 ("响应只有 success，
// 不返回 id/key") and assumed uniformly for the rest per that project's own
// convention. Treat unexpected shapes as a hard error rather than guessing.

const defaultBaseUrl = 'https://xm.solov.cc'
const defaultTimeoutMs = 10_000
const defaultMaxResponseBytes = 512 * 1024
const redirectStatuses = new Set([301, 302, 303, 307, 308])

const statusPath = '/api/status'
const registerPath = '/api/user/register'
const loginPath = '/api/user/login'
const refreshPath = '/api/user/auth/refresh'
const selfPath = '/api/user/self'
const tokenCollectionPath = '/api/token/'

function tokenKeyPath(id: number): string {
  return `/api/token/${id}/key`
}

// TODO(RECON): docs/RECON-new-api.md section A does not list an email
// verification-code endpoint, even though /api/user/register requires a
// verification_code field (see NewApiRegisterInput below). Do not guess the
// path here (this rc.22 custom branch has already drifted from upstream --
// section C.5). Add a sendRegistrationVerificationCode() function and wire
// an `account:send-verification-code` IPC channel the same way register()
// was wired only once a real probe (or an upstream source read) confirms it.
// Until then RegisterDialog.tsx's "获取验证码" button stays a toast stub.

export type NewApiFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface NewApiClientOptions {
  baseUrl?: string
  fetchImpl?: NewApiFetch
  timeoutMs?: number
  maxResponseBytes?: number
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

export interface NewApiLoginInput {
  username: string
  password: string
  turnstileToken?: string
}

// RECON (docs/RECON-new-api.md section A) confirms /api/user/register wants
// username *and* email as separate fields, but the only enabled sign-up path
// on this instance is email+password with a verification code (section
// "注册方式可用性对照") -- the account UI never collects a distinct username
// (see RegisterDialog.tsx). username defaults to the email address itself
// when the caller omits it, so callers never have to invent one.
export interface NewApiRegisterInput {
  email: string
  password: string
  verificationCode: string
  username?: string
  affCode?: string
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

export interface NewApiClientService {
  getStatus(): Promise<NewApiAccountStatus>
  register(input: NewApiRegisterInput): Promise<void>
  login(input: NewApiLoginInput): Promise<NewApiLoginResult>
  logout(): void
  isAuthenticated(): boolean
  getSessionState(): NewApiSessionState
  getBalance(): Promise<NewApiBalance>
  provisionCliKey(input?: NewApiProvisionCliKeyInput): Promise<NewApiCliKeyResult>
  // Exchanges the captured refresh cookie for a new access_token. Exposed for
  // a future silent-retry-on-401 caller; nothing in this skeleton invokes it
  // automatically yet (see docs/RECON-new-api.md section D).
  refreshAccessToken(): Promise<void>
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

interface RequestContext {
  fetchImpl: NewApiFetch
  timeoutMs: number
  maxResponseBytes: number
  origin: string
}

interface PerformRequestInit {
  method: 'GET' | 'POST'
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

export function parseCliKeySecret(payload: unknown): string | null {
  const data = isRecord(payload) ? payload : null
  const candidate = data && typeof data.key === 'string'
    ? data.key
    : typeof payload === 'string' ? payload : null
  return candidate && candidate.trim() ? candidate.trim() : null
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

  const requireSession = (): InternalSession => {
    if (!session) throw new Error('请先登录星芒账号')
    return session
  }

  const withSession = async <T>(run: (current: InternalSession) => Promise<T>): Promise<T> => {
    const current = requireSession()
    try {
      return await run(current)
    } catch (error) {
      if (error instanceof NewApiAuthenticationError) session = null
      throw error
    }
  }

  const getStatus = async (): Promise<NewApiAccountStatus> => {
    const raw = await performRequest(ctx, statusPath, { method: 'GET' }, '账号服务状态查询')
    return parseAccountStatus(unwrapEnvelope(raw, '账号服务状态查询', []))
  }

  // RECON never exercised /api/user/register (read-only recon, no writes),
  // so the response shape it returns beyond {success, message} is unconfirmed
  // -- unlike login's `data.access_token`/`data.user`, which the probe of
  // section D's suggested flow was written against. Rather than guess a
  // shape and silently misparse it, this resolves to void on success; the
  // caller is expected to follow up with login() using the same credentials,
  // whose response shape *is* confirmed.
  const register = async (input: NewApiRegisterInput): Promise<void> => {
    const email = input.email.trim()
    const password = input.password
    const verificationCode = input.verificationCode.trim()
    if (!email) throw new Error('请输入邮箱地址')
    if (!password) throw new Error('请输入密码')
    if (!verificationCode) throw new Error('请输入邮箱验证码')
    // Only clamp an *explicit* custom username -- the App.tsx caller always
    // follows a successful register() with login({ username: email, ... })
    // using the untruncated email, so silently truncating the email-derived
    // default here would make that follow-up login send a different
    // username than the one just registered.
    const username = input.username?.trim() || email
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
    session = { accessToken: data.accessToken, userId: data.account.userId, cookies, profile: data.account }
    // Strip accessToken before it ever leaves the main process (I3/I13).
    return { account: data.account, accessExpiresAt: data.accessExpiresAt }
  }

  const logout = (): void => {
    session = null
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

  const refreshAccessToken = (): Promise<void> => withSession(async (current) => {
    if (current.cookies.length === 0) throw new Error('没有可用的登录凭据用于续期，请重新登录')
    const raw = await performRequest(
      ctx,
      refreshPath,
      { method: 'POST', headers: { Cookie: current.cookies.join('; ') } },
      '登录状态续期',
    )
    const data = parseRefreshResponseData(unwrapEnvelope(raw, '登录状态续期', [current.accessToken]))
    const newCookies = extractSessionCookies(raw.headers)
    session = {
      ...current,
      accessToken: data.accessToken,
      cookies: newCookies.length > 0 ? newCookies : current.cookies,
    }
  })

  return {
    getStatus,
    register,
    login,
    logout,
    isAuthenticated,
    getSessionState,
    getBalance,
    provisionCliKey,
    refreshAccessToken,
  }
}
