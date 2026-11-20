// 「我的订单」里直接开发票（yoyo 2026-11-20 定的方向，同天在选择卡片上选了「免登录」）：主进程跟开票系统说话的这一层。
// 开票系统是 xingmang-console 仓库的开票模块，桌面接口契约在那边的 platform/contracts/auth/invoice-desktop-session.v1.md
// （CR-0225）。开票规则、金额、最低金额、审核全以开票系统为准：这里只换令牌、转请求、核对回来的形状，一分钱都不自己算。
//
// 凭据：客户在星芒里已经登录着账号站。换令牌时把账号的 access token 借给开票系统，让它问一次账号站「这是谁」
// （RelayBackendClient.lendInvoiceCredential），开票系统还一个自己的桌面令牌（空闲 30 分钟、最长 12 小时）。
// 桌面令牌只放在这里的内存里：不落盘、不过 IPC、不进日志；换了人或退出就丢掉，并告诉开票系统撤销。
// 请求只发往两个开票门户，不带 Cookie、不带 Origin（带了开票系统就当成网页请求拒掉，网页也就借不了这条路），
// 超时、响应上限、拒绝跳转一样不少（I10）。
import { readBoundedResponseBytes } from './bounded-response'
import type {
  InvoiceOrder,
  InvoiceOrdersSnapshot,
  InvoiceProfile,
  InvoiceProfileData,
  InvoiceProfileSaveInput,
  InvoiceRequest,
  InvoiceRequestLine,
  InvoiceRequestsPage,
  InvoiceRequestsQuery,
  InvoiceSubmitInput,
  InvoiceWithdrawInput,
} from './invoice-center-types'
import type { InvoiceAccountCredential } from './relay-backend'
import { resolveRelaySite } from './relay-sites'

export type InvoiceSiteId = 'solov' | 'solov-api'

export interface InvoiceCenterAccount {
  siteId: InvoiceSiteId
  userId: number
}

export type InvoiceDocumentType = 'pdf' | 'png' | 'jpeg'

export interface InvoiceDocument {
  bytes: Buffer
  type: InvoiceDocumentType
  /** 开票系统给的文件名，没给是空串；存之前由 buildInvoiceSaveName 洗过。 */
  suggestedName: string
}

/**
 * 开票系统没给出能给客户看的原因时，错误里只放这一串。它故意是英文：界面只把纯中文的原话给客户看，
 * 认不出的一律换成那一处批过的兜底句子（「没提交成功，请稍后再试；还不行请找客服。」那种）。
 */
export const invoiceCenterNoReason = 'INVOICE_CENTER_NO_REASON'

export class InvoiceCenterError extends Error {
  readonly code: string
  readonly status: number | null

  constructor(message: string, code: string, status: number | null) {
    super(message)
    this.name = 'InvoiceCenterError'
    this.code = code
    this.status = status
  }
}

export interface InvoiceCenterClientOptions {
  /** 主进程的会话 fetch（跟着系统代理和星芒的改直连走）。 */
  fetchImpl: typeof fetch
  /** 这会儿登录的是谁；没登录是 null。只由主进程按当前登录定，界面不给。 */
  currentAccount(): InvoiceCenterAccount | null
  /** 当前账号的 lendInvoiceCredential。 */
  lendCredential<T>(exchange: (credential: InvoiceAccountCredential) => Promise<T | null>): Promise<T | null>
  now?: () => number
  timeoutMs?: number
  /** 只记事件名和错误码，不记令牌、编号和开票系统回的原话。 */
  log?: (level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>) => void
}

export interface InvoiceCenterClient {
  listOrders(): Promise<InvoiceOrdersSnapshot>
  listProfiles(): Promise<InvoiceProfile[]>
  listRequests(query?: InvoiceRequestsQuery): Promise<InvoiceRequestsPage>
  saveProfile(input: InvoiceProfileSaveInput): Promise<InvoiceProfile>
  submitRequest(input: InvoiceSubmitInput): Promise<InvoiceRequest>
  withdrawRequest(input: InvoiceWithdrawInput): Promise<InvoiceRequest>
  downloadDocument(requestId: string): Promise<InvoiceDocument>
  /** 当前登录的是谁。换了人或退出：丢掉手上的桌面令牌，告诉开票系统撤销（不等、不报错）。 */
  setAccount(account: InvoiceCenterAccount | null): void
}

const apiPrefix = '/invoice-api/v1/desktop'
const sessionPath = `${apiPrefix}/session`
const customerPath = `${apiPrefix}/invoices/customer`
const defaultTimeoutMs = 15_000
// 开票系统那边换令牌的请求体上限是 16 KiB，回来的也只是一个令牌和一个名字。
const sessionMaxBytes = 16 * 1024
// 订单列表开票系统不分页：一笔订单四百来字节，4 MB 够一万来笔。
const ordersMaxBytes = 4 * 1024 * 1024
const listMaxBytes = 2 * 1024 * 1024
const actionMaxBytes = 256 * 1024
// 开票那边只收 8MB 以内的 PDF、PNG、JPEG 作发票文件（modules/invoices 的 MaxDocumentBytes）。
export const invoiceDocumentMaxBytes = 8 * 1024 * 1024
const requestsPageSize = 100
// 空闲 30 分钟就失效：闲了 25 分钟的令牌先换新的，不白跑一趟 401。离 12 小时到期不到 2 分钟的也先换。
const idleRenewMs = 25 * 60 * 1000
const expiryMarginMs = 2 * 60 * 1000
const redirectStatuses = new Set([301, 302, 303, 307, 308])
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const minorPattern = /^-?(0|[1-9][0-9]{0,18})$/
const maxMinor = 9223372036854775807n
const sitePlatforms: Readonly<Record<InvoiceSiteId, 'newapi' | 'sub2api'>> = { solov: 'newapi', 'solov-api': 'sub2api' }

/** 这个站的开票系统在哪（relay-sites.ts 的 invoiceOrigin）；没有、或者不是干净的 https origin 时返回 null。 */
export function resolveInvoiceCenterOrigin(siteId: string): string | null {
  const site = resolveRelaySite(siteId)
  if (site.id !== siteId || !site.invoiceOrigin) return null
  let parsed: URL
  try {
    parsed = new URL(site.invoiceOrigin)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.origin !== site.invoiceOrigin) return null
  return parsed.origin
}

/**
 * 开票系统的订单编号对得上「我的订单」哪一行（契约第 5 节）：星芒账号的充值是 newapi:top_up:<id>，历史账号的
 * 充值是 sub2api:payment_order:<id>，<id> 就是账号站订单接口回的 id。订阅单的编号是另一套（订阅订单表），
 * 「我的订单」里那一行带的是充值表的编号，对不上；管理员调额、手工登记的也对不上。认不出的种类一律按对不上。
 */
export function classifyInvoiceOriginRef(originRef: string, siteId: InvoiceSiteId): Pick<InvoiceOrder, 'kind' | 'accountOrderId'> {
  const match = /^([a-z0-9]+):([a-z_]+):([1-9][0-9]{0,15})$/.exec(originRef)
  const id = match ? Number(match[3]) : NaN
  const accountOrderId = Number.isSafeInteger(id) ? id : null
  if (match && siteId === 'solov' && match[1] === 'newapi') {
    if (match[2] === 'top_up') return { kind: 'topup', accountOrderId }
    if (match[2] === 'subscription_order') return { kind: 'subscription', accountOrderId: null }
  }
  if (match && siteId === 'solov-api' && match[1] === 'sub2api' && match[2] === 'payment_order') return { kind: 'topup', accountOrderId }
  return { kind: 'other', accountOrderId: null }
}

/** 按文件开头的几个字节认发票文件；不是 PDF、PNG、JPEG 的返回 null。 */
export function resolveInvoiceDocumentType(bytes: Buffer): InvoiceDocumentType | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  return null
}

const invoiceDocumentExtensions: Readonly<Record<InvoiceDocumentType, string>> = { pdf: 'pdf', png: 'png', jpeg: 'jpg' }

/**
 * 保存框里默认的文件名。名字是开票系统给的，只留字母、数字和 .-_，扩展名按实际认出来的类型换，
 * 不让对方给的名字决定存成什么。
 */
export function buildInvoiceSaveName(suggested: string, type: InvoiceDocumentType): string {
  const base = suggested.replace(/\\/g, '/').split('/').pop()!.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '').slice(0, 100)
  return `${base || 'invoice'}.${invoiceDocumentExtensions[type]}`
}

/** Content-Disposition 里的文件名（只认 filename="…" 和 filename=…，filename* 那种编码过的不认，交给兜底名字）。 */
export function parseAttachmentName(header: string | null): string {
  if (!header) return ''
  const match = /(?:^|;)\s*filename="([^"]{1,200})"/i.exec(header) ?? /(?:^|;)\s*filename=([^;"\s]{1,200})/i.exec(header)
  return match ? match[1]! : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function protocolError(): InvoiceCenterError {
  return new InvoiceCenterError(invoiceCenterNoReason, 'INVALID_RESPONSE', null)
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw protocolError()
  return value
}

function text(value: unknown, maximum = 1_000): string {
  if (typeof value !== 'string' || value.length > maximum) throw protocolError()
  return value
}

function optionalText(value: unknown, maximum = 1_000): string | undefined {
  return value === undefined || value === null ? undefined : text(value, maximum)
}

function list(value: unknown, maximum = 20_000): unknown[] {
  if (value === null) return []
  if (!Array.isArray(value) || value.length > maximum) throw protocolError()
  return value
}

function minor(value: unknown): string {
  if (typeof value !== 'string' || !minorPattern.test(value)) throw protocolError()
  const amount = BigInt(value)
  if (amount > maxMinor || amount < -maxMinor - 1n) throw protocolError()
  return value
}

function identifier(value: unknown): string {
  const id = text(value, 64)
  if (!uuidPattern.test(id)) throw protocolError()
  return id.toLowerCase()
}

function timestamp(value: unknown): string {
  const raw = text(value, 64)
  if (!Number.isFinite(Date.parse(raw))) throw protocolError()
  return raw
}

function parseProfileData(value: unknown): InvoiceProfileData {
  const v = record(value)
  if (v.profile_kind !== 'personal' && v.profile_kind !== 'business') throw protocolError()
  const address = optionalText(v.address, 1_000)
  const phone = optionalText(v.phone, 1_000)
  const bankName = optionalText(v.bank_name, 1_000)
  const bankAccount = optionalText(v.bank_account, 1_000)
  return {
    kind: v.profile_kind,
    title: text(v.title, 1_000),
    taxId: optionalText(v.tax_id, 1_000) ?? '',
    email: text(v.email, 1_000),
    ...(address ? { address } : {}),
    ...(phone ? { phone } : {}),
    ...(bankName ? { bankName } : {}),
    ...(bankAccount ? { bankAccount } : {}),
  }
}

export function parseInvoiceProfile(value: unknown): InvoiceProfile {
  const v = record(value)
  return { profileId: identifier(v.profile_id), data: parseProfileData(v.data) }
}

export function parseInvoiceOrder(value: unknown, siteId: InvoiceSiteId): InvoiceOrder {
  const v = record(value)
  const originRef = text(v.origin_ref, 200)
  if (!originRef || /[\u0000-\u001f\u007f\s]/.test(originRef)) throw protocolError()
  const currency = text(v.currency, 8)
  return {
    originRef,
    ...classifyInvoiceOriginRef(originRef, siteId),
    availableMinor: minor(v.available_minor),
    heldMinor: minor(v.held_minor),
    issuedMinor: minor(v.issued_minor),
    currency,
    occurredAt: timestamp(v.occurred_at),
  }
}

export function parseInvoiceRequest(value: unknown): InvoiceRequest {
  const v = record(value)
  const revision = v.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) throw protocolError()
  const lines: InvoiceRequestLine[] = list(v.lines, 20_000).map((entry) => {
    const line = record(entry)
    if (line.excluded !== undefined && typeof line.excluded !== 'boolean') throw protocolError()
    return { originRef: text(line.origin_ref, 200), amountMinor: minor(line.amount_minor), excluded: line.excluded === true }
  })
  const invoiceNumber = optionalText(v.invoice_number, 200)
  return {
    requestId: identifier(v.request_id),
    status: text(v.status, 40),
    revision,
    amountMinor: minor(v.amount_minor),
    currency: text(v.currency, 8),
    title: parseProfileData(v.profile_snapshot).title,
    createdAt: timestamp(v.created_at),
    reason: optionalText(v.reason, 2_000) ?? '',
    invoiceNumber: invoiceNumber ? invoiceNumber : null,
    lines,
  }
}

export function parseInvoiceOrdersSnapshot(value: unknown, siteId: InvoiceSiteId): InvoiceOrdersSnapshot {
  const v = record(value)
  const minimum = minor(v.minimum_request_minor)
  if (BigInt(minimum) <= 0n) throw protocolError()
  return { orders: list(v.orders).map((entry) => parseInvoiceOrder(entry, siteId)), minimumRequestMinor: minimum }
}

export function parseInvoiceRequestsPage(value: unknown): InvoiceRequestsPage {
  const v = record(value)
  const cursor = optionalText(v.next_cursor, 2_048) ?? ''
  return { requests: list(v.requests, 1_000).map(parseInvoiceRequest), nextCursor: cursor ? cursor : null }
}

interface DesktopToken {
  owner: string
  origin: string
  token: string
  expiresAt: number
  lastUsedAt: number
}

export function parseDesktopSession(value: unknown, account: InvoiceCenterAccount, now: number): Omit<DesktopToken, 'owner' | 'origin'> {
  const v = record(value)
  const token = text(v.token, 512)
  // 契约说按不透明字符串处理；这里只拦会把请求头弄坏的东西。
  if (!/^[\x21-\x7e]{16,512}$/.test(token)) throw protocolError()
  const expiresAt = Date.parse(text(v.expires_at, 64))
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw protocolError()
  if (v.platform !== sitePlatforms[account.siteId]) throw protocolError()
  const user = record(v.user)
  // 换回来的令牌必须是这个账号的：对不上就不收，免得拿着别人的开票记录。
  if (String(user.platform_user_id) !== String(account.userId)) throw protocolError()
  return { token, expiresAt, lastUsedAt: now }
}

/**
 * 开票系统说的那句给客户看的话（契约：message 是给客户看的中文，不含站点名、域名和技术词）。
 * 只收短的、单行的；别的交给界面那句兜底。
 */
export function customerReason(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const reason = value.trim()
  if (!reason || reason.length > 200 || /[\u0000-\u001f\u007f]/.test(reason)) return null
  return reason
}

interface WireResponse {
  status: number
  headers: Headers
  bytes: Buffer
}

function payloadOf(response: WireResponse): unknown {
  if (!response.bytes.length) return null
  try {
    return JSON.parse(response.bytes.toString('utf8'))
  } catch {
    return null
  }
}

function errorCodeOf(payload: unknown): string | null {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null
  return error && typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : null
}

export function invoiceCenterFailure(response: Pick<WireResponse, 'status'>, payload: unknown): InvoiceCenterError {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null
  const reason = error ? customerReason(error.message) : null
  return new InvoiceCenterError(reason ?? invoiceCenterNoReason, errorCodeOf(payload) ?? `HTTP_${response.status}`, response.status)
}

function accountChanged(): InvoiceCenterError {
  return new InvoiceCenterError('账号刚切换过，请再试一次', 'ACCOUNT_CHANGED', null)
}

function ownerKey(account: InvoiceCenterAccount): string {
  return `${account.siteId}:${account.userId}`
}

export function createInvoiceCenterClient(options: InvoiceCenterClientOptions): InvoiceCenterClient {
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  let held: DesktopToken | null = null
  let exchanging: { owner: string; promise: Promise<DesktopToken> } | null = null
  // 每次换人、退出都加一：晚回来的换令牌结果对不上就作废。
  let generation = 0
  let account: string | null = null

  async function send(origin: string, path: string, init: {
    method: 'GET' | 'POST' | 'DELETE'
    headers?: Record<string, string>
    body?: unknown
    accept?: string
    maxBytes: number
    label: string
  }): Promise<WireResponse> {
    const url = new URL(path, origin)
    if (url.origin !== origin) throw new InvoiceCenterError(invoiceCenterNoReason, 'INVALID_URL', null)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    timeout.unref?.()
    try {
      const response = await options.fetchImpl(url.href, {
        method: init.method,
        // 不带 Cookie、不带 Origin：这两个只该出现在网页请求上，开票系统见了就拒（契约第 1 节）。
        headers: {
          Accept: init.accept ?? 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        // The Electron session's cookie jar must never ride along: a cookie on a
        // desktop route is exactly what the invoice center treats as a browser.
        credentials: 'omit',
        // None of these routes ever redirect; following one could carry the
        // Bearer token (or the account's access token) to another host.
        redirect: 'manual',
        signal: controller.signal,
      })
      if (response.url && new URL(response.url).origin !== origin) {
        throw new InvoiceCenterError(invoiceCenterNoReason, 'REDIRECTED', null)
      }
      if (response.type === 'opaqueredirect' || redirectStatuses.has(response.status)) {
        await response.body?.cancel().catch(() => undefined)
        throw new InvoiceCenterError(invoiceCenterNoReason, 'REDIRECTED', response.status)
      }
      const bytes = await readBoundedResponseBytes(response, init.maxBytes, init.label, {
        guard: { signal: controller.signal },
        oversizeError: () => new InvoiceCenterError(invoiceCenterNoReason, 'RESPONSE_TOO_LARGE', response.status),
      })
      return { status: response.status, headers: response.headers, bytes }
    } catch (error) {
      if (error instanceof InvoiceCenterError) throw error
      if (controller.signal.aborted) throw new InvoiceCenterError(invoiceCenterNoReason, 'TIMEOUT', null)
      throw new InvoiceCenterError(invoiceCenterNoReason, 'NETWORK', null)
    } finally {
      clearTimeout(timeout)
    }
  }

  function revoke(token: DesktopToken): void {
    void send(token.origin, sessionPath, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token.token}` },
      maxBytes: sessionMaxBytes,
      label: '开票登录撤销',
    }).then((response) => {
      if (response.status >= 400) options.log?.('warn', 'session.revoke.failed', '开票系统的桌面登录没撤销成，等它自己过期', { status: response.status })
    }, (error: unknown) => {
      options.log?.('warn', 'session.revoke.failed', '开票系统的桌面登录没撤销成，等它自己过期', { code: error instanceof InvoiceCenterError ? error.code : 'UNKNOWN' })
    })
  }

  function drop(): void {
    generation += 1
    exchanging = null
    const previous = held
    held = null
    if (previous) revoke(previous)
  }

  function requireAccount(): { account: InvoiceCenterAccount; origin: string } {
    const current = options.currentAccount()
    const origin = current ? resolveInvoiceCenterOrigin(current.siteId) : null
    if (!current || !origin) throw new InvoiceCenterError('请先登录', 'SIGNED_OUT', null)
    // 主进程没来得及告诉这里换了人（setAccount 在账号变化之后才到）：先丢掉上一个人的令牌。
    if (account !== ownerKey(current)) {
      if (account !== null || held) drop()
      account = ownerKey(current)
    }
    return { account: current, origin }
  }

  async function exchange(target: InvoiceCenterAccount, origin: string): Promise<DesktopToken> {
    let rejection: InvoiceCenterError | null = null
    const issued = await options.lendCredential(async (credential) => {
      const response = await send(origin, sessionPath, {
        method: 'POST',
        body: { access_token: credential.accessToken, ...(credential.userId ? { user_id: credential.userId } : {}) },
        maxBytes: sessionMaxBytes,
        label: '开票登录',
      })
      const payload = payloadOf(response)
      if (response.status === 401 && errorCodeOf(payload) === 'DESKTOP_CREDENTIAL_REJECTED') {
        rejection = invoiceCenterFailure(response, payload)
        return null
      }
      if (response.status !== 200) throw invoiceCenterFailure(response, payload)
      return parseDesktopSession(payload, target, now())
    })
    if (!issued) {
      options.log?.('warn', 'session.rejected', '开票系统没认这个账号的登录')
      throw rejection ?? new InvoiceCenterError(invoiceCenterNoReason, 'DESKTOP_CREDENTIAL_REJECTED', 401)
    }
    options.log?.('info', 'session.issued', '已换到开票系统的桌面登录')
    return { ...issued, owner: ownerKey(target), origin }
  }

  function usable(token: DesktopToken | null, owner: string): token is DesktopToken {
    const at = now()
    return token !== null && token.owner === owner && token.expiresAt - at > expiryMarginMs && at - token.lastUsedAt < idleRenewMs
  }

  function desktopToken(target: InvoiceCenterAccount, origin: string): Promise<DesktopToken> {
    const owner = ownerKey(target)
    if (usable(held, owner)) return Promise.resolve(held)
    if (exchanging?.owner === owner) return exchanging.promise
    const stale = held
    held = null
    if (stale) revoke(stale)
    const startedAt = generation
    const promise = exchange(target, origin).then((issued) => {
      // 换的这一会儿换了人、退出了：这张令牌不收，也告诉开票系统作废。
      if (generation !== startedAt) {
        revoke(issued)
        throw accountChanged()
      }
      held = issued
      return issued
    }).finally(() => {
      if (exchanging?.promise === promise) exchanging = null
    })
    exchanging = { owner, promise }
    return promise
  }

  async function call(path: string, init: { method: 'GET' | 'POST'; body?: unknown; accept?: string; maxBytes: number; label: string }): Promise<WireResponse> {
    const { account: target, origin } = requireAccount()
    const startedAt = generation
    for (let attempt = 0; ; attempt += 1) {
      const token = await desktopToken(target, origin)
      const response = await send(origin, path, { ...init, headers: { Authorization: `Bearer ${token.token}` } })
      if (generation !== startedAt) throw accountChanged()
      if (response.status === 401 && errorCodeOf(payloadOf(response)) === 'DESKTOP_SESSION_INVALID') {
        // 空闲超时、被撤销、过期：用最新的账号凭据重换一次、重试一次（契约第 4 节）。认人失败的请求没进业务，
        // 动作也可以照原样重发；第二次还是 401 就照实报。
        if (held === token) held = null
        if (attempt === 0) continue
      }
      if (response.status < 400) token.lastUsedAt = now()
      return response
    }
  }

  async function readJson(path: string, maxBytes: number, label: string): Promise<unknown> {
    const response = await call(path, { method: 'GET', maxBytes, label })
    const payload = payloadOf(response)
    if (response.status !== 200) throw invoiceCenterFailure(response, payload)
    return payload
  }

  async function act(actionId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await call(`${customerPath}/actions`, {
      method: 'POST',
      body: { action_id: actionId, params },
      maxBytes: actionMaxBytes,
      label: '开票操作',
    })
    const payload = payloadOf(response)
    if (response.status !== 200) throw invoiceCenterFailure(response, payload)
    const result = record(payload)
    text(result.run_id, 200)
    return record(result.value)
  }

  function currentSite(): InvoiceSiteId {
    return requireAccount().account.siteId
  }

  return {
    async listOrders() {
      const siteId = currentSite()
      return parseInvoiceOrdersSnapshot(await readJson(`${customerPath}/orders`, ordersMaxBytes, '开票订单读取'), siteId)
    },
    async listProfiles() {
      const payload = record(await readJson(`${customerPath}/profiles`, listMaxBytes, '开票抬头读取'))
      return list(payload.profiles, 1_000).map(parseInvoiceProfile)
    },
    async listRequests(query = {}) {
      const search = new URLSearchParams({ limit: String(requestsPageSize) })
      if (query.cursor) search.set('cursor', query.cursor)
      return parseInvoiceRequestsPage(await readJson(`${customerPath}/requests?${search.toString()}`, listMaxBytes, '开票记录读取'))
    },
    async saveProfile(input) {
      const profile = input.profile
      const value = await act('invoices.profile.save', {
        profile_kind: profile.kind,
        title: profile.title,
        tax_id: profile.taxId,
        email: profile.email,
        ...(profile.address ? { address: profile.address } : {}),
        ...(profile.phone ? { phone: profile.phone } : {}),
        ...(profile.bankName ? { bank_name: profile.bankName } : {}),
        ...(profile.bankAccount ? { bank_account: profile.bankAccount } : {}),
        idempotency_key: input.idempotencyKey,
      })
      return parseInvoiceProfile(value.profile)
    },
    async submitRequest(input) {
      const value = await act('invoices.request.submit', {
        profile_id: input.profileId,
        // 只开人民币普通发票（界面那句底部小字），开票门户也是写死 CNY 提交。
        currency: 'CNY',
        origin_refs: input.originRefs,
        amounts_minor: input.amountsMinor,
        idempotency_key: input.idempotencyKey,
      })
      return parseInvoiceRequest(value.request)
    },
    async withdrawRequest(input) {
      const value = await act('invoices.request.withdraw', {
        request_id: input.requestId,
        expected_revision: input.expectedRevision,
        idempotency_key: input.idempotencyKey,
      })
      return parseInvoiceRequest(value.request)
    },
    async downloadDocument(requestId) {
      if (!uuidPattern.test(requestId)) throw new InvoiceCenterError(invoiceCenterNoReason, 'INVALID_REQUEST_ID', null)
      const response = await call(`${customerPath}/requests/${requestId.toLowerCase()}/document`, {
        method: 'GET',
        accept: 'application/pdf, image/png, image/jpeg, application/json',
        maxBytes: invoiceDocumentMaxBytes,
        label: '发票文件下载',
      })
      if (response.status !== 200) throw invoiceCenterFailure(response, payloadOf(response))
      const type = resolveInvoiceDocumentType(response.bytes)
      if (!type) throw new InvoiceCenterError(invoiceCenterNoReason, 'NOT_A_DOCUMENT', response.status)
      return { bytes: response.bytes, type, suggestedName: parseAttachmentName(response.headers.get('content-disposition')) }
    },
    setAccount(next) {
      const owner = next ? ownerKey(next) : null
      if (owner === account) return
      if (account !== null || held) drop()
      account = owner
    },
  }
}
