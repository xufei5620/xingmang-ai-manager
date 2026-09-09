/** Backend-neutral account contracts. No Node imports; credential types stay main-only. */
export type AccountRealmId = 'xm-account' | 'api-account'
export type AccountBackendKind = 'new-api' | 'sub2api'

export const accountRealms = Object.freeze({
  'xm-account': Object.freeze({ siteId: 'solov', origin: 'https://xm.solov.cc', backend: 'new-api' as const }),
  'api-account': Object.freeze({ siteId: 'solov-api', origin: 'https://api.solov.cc', backend: 'sub2api' as const }),
})

export interface RealmAccountOwner {
  readonly realmId: AccountRealmId
  readonly userId: string
}

export type RealmCredential =
  | { readonly kind: 'new-api'; readonly cookies: readonly string[] }
  | { readonly kind: 'sub2api'; readonly accessToken: string; readonly refreshToken: string | null; readonly expiresAt: number | null }

/** Never export this object through an IPC result, renderer prop or log. */
export interface RealmSavedAccount extends RealmAccountOwner {
  readonly version: 2
  readonly origin: string
  readonly username: string
  readonly credential: RealmCredential
}

export interface RealmAccountSummary extends RealmAccountOwner {
  readonly id: string
  readonly origin: string
  readonly username: string
}

export interface RealmLoginInput {
  readonly identifier: string
  readonly password: string
  readonly turnstileToken?: string
}

export interface RealmSessionBackend {
  readonly realmId: AccountRealmId
  authenticate(input: RealmLoginInput, signal: AbortSignal): Promise<RealmSavedAccount>
  restore(saved: RealmSavedAccount, signal: AbortSignal): Promise<RealmSavedAccount>
}

export type RealmErrorCode = 'INVALID' | 'UNSUPPORTED' | 'DISABLED' | 'BUSY' | 'STALE' | 'SIGNED_OUT'
  | 'STORAGE' | 'NETWORK' | 'TIMEOUT' | 'ABORTED' | 'UNAUTHORIZED' | 'LOGIN_REJECTED' | 'TWO_FACTOR_REQUIRED' | 'PROTOCOL'

const messages: Record<RealmErrorCode, string> = {
  INVALID: '账号参数无效', UNSUPPORTED: '当前站点暂不支持此功能', DISABLED: '该站点尚未启用',
  BUSY: '账号切换正在进行，请稍后重试', STALE: '账号上下文已变化，请重试', SIGNED_OUT: '请先登录账号',
  STORAGE: '账号安全存储不可用，原记录未修改', NETWORK: '账号服务请求失败，请重试',
  TIMEOUT: '账号服务请求超时', ABORTED: '操作已取消', UNAUTHORIZED: '登录已失效，请重新登录',
  LOGIN_REJECTED: '账号或密码错误，请检查后重试',
  TWO_FACTOR_REQUIRED: '此账号需要双重验证，请先在站点完成验证', PROTOCOL: '账号服务响应格式不兼容',
}

export class RealmAccountError extends Error {
  constructor(readonly code: RealmErrorCode) {
    super(messages[code])
    this.name = 'RealmAccountError'
  }
}

export function isRealmRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requireAccountRealm(value: unknown): AccountRealmId {
  if (value !== 'xm-account' && value !== 'api-account') throw new RealmAccountError('INVALID')
  return value
}

/** Legacy sub2api is intentionally an xm alias; never infer a realm from a password or key. */
export function realmForExplicitSite(value: unknown): AccountRealmId {
  if (value === 'solov' || value === 'sub2api') return 'xm-account'
  if (value === 'solov-api') return 'api-account'
  throw new RealmAccountError('INVALID')
}

export function requireRealmUserId(value: unknown): string {
  // Both currently verified backends use positive safe integers. Do not round unsafe wire IDs.
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)
    || !Number.isSafeInteger(Number(value))) throw new RealmAccountError('INVALID')
  return value
}

export function realmOwnerKey(owner: RealmAccountOwner): string {
  if (!isRealmRecord(owner)) throw new RealmAccountError('INVALID')
  return JSON.stringify([requireAccountRealm(owner.realmId), requireRealmUserId(owner.userId)])
}

function boundedSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16384
    || /[\u0000-\u0020\u007f]/.test(value)) throw new RealmAccountError('INVALID')
  return value
}

/** Validate and clone before an await/queue boundary. Do not retain caller-owned objects. */
export function parseRealmSavedAccount(value: unknown): RealmSavedAccount {
  if (!isRealmRecord(value) || value.version !== 2 || !isRealmRecord(value.credential)) throw new RealmAccountError('INVALID')
  const realmId = requireAccountRealm(value.realmId)
  const userId = requireRealmUserId(value.userId)
  const definition = accountRealms[realmId]
  if (value.origin !== definition.origin || value.credential.kind !== definition.backend
    || typeof value.username !== 'string' || !value.username.trim() || value.username.length > 256
    || /[\u0000-\u001f\u007f]/.test(value.username)) throw new RealmAccountError('INVALID')
  let credential: RealmCredential
  if (value.credential.kind === 'new-api') {
    const cookies = value.credential.cookies
    if (!Array.isArray(cookies) || !cookies.length || cookies.length > 16
      || cookies.some((cookie) => typeof cookie !== 'string' || !cookie || cookie.length > 4096 || /[\r\n\u0000]/.test(cookie))
      || new TextEncoder().encode(cookies.join('; ')).byteLength > 16384) throw new RealmAccountError('INVALID')
    credential = Object.freeze({ kind: 'new-api', cookies: Object.freeze([...cookies]) })
  } else {
    const accessToken = boundedSecret(value.credential.accessToken)
    const refreshToken = value.credential.refreshToken === null ? null : boundedSecret(value.credential.refreshToken)
    const expiresAt = value.credential.expiresAt
    if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)) throw new RealmAccountError('INVALID')
    credential = Object.freeze({ kind: 'sub2api', accessToken, refreshToken, expiresAt })
  }
  return Object.freeze({ version: 2, realmId, userId, origin: definition.origin, username: value.username.trim(), credential })
}

export function realmAccountSummary(saved: RealmSavedAccount): RealmAccountSummary {
  const account = parseRealmSavedAccount(saved)
  return Object.freeze({ id: realmOwnerKey(account), realmId: account.realmId, userId: account.userId,
    origin: account.origin, username: account.username })
}

export function captureRealmLogin(input: RealmLoginInput): RealmLoginInput {
  if (!isRealmRecord(input) || typeof input.identifier !== 'string' || !input.identifier.trim()
    || input.identifier.length > 256 || /[\u0000-\u001f\u007f]/.test(input.identifier)
    || typeof input.password !== 'string' || !input.password || input.password.length > 4096
    || (input.turnstileToken !== undefined && (typeof input.turnstileToken !== 'string'
      || input.turnstileToken.length > 16384 || /[\r\n\u0000]/.test(input.turnstileToken)))) throw new RealmAccountError('INVALID')
  return Object.freeze({ identifier: input.identifier.trim(), password: input.password,
    ...(input.turnstileToken === undefined ? {} : { turnstileToken: input.turnstileToken }) })
}
