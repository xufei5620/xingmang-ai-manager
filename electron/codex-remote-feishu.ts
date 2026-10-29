import { requestRemoteJson, RemoteHttpError } from './codex-remote-http'
import {
  decodeFeishuFrame,
  encodeFeishuFrame,
  feishuFrameHeader,
  feishuFrameMethod,
  type FeishuFrame,
} from './codex-remote-feishu-frame'
import { isRecord } from './input-guards'
import type {
  RemoteChannelAdapter,
  RemoteChannelDependencies,
  RemoteChannelHandlers,
  RemoteChannelStatus,
  RemoteInbound,
  RemoteOutbound,
  RemoteOutboundApproval,
  RemotePeer,
} from './codex-remote-channel'

// 飞书渠道：客户自己在飞书开放平台建一个企业自建应用（机器人），把 App ID、App Secret 填进星芒。
// 收消息走飞书的长连接（星芒主动连出去，不用公网地址），发消息走开放平台接口。协议照飞书官方
// Node SDK（@larksuiteoapi/node-sdk 1.76.0 的 WSClient）逐条对过，没有把 SDK 整个引进主进程。
//
// Only https://open.feishu.cn is ever called with the App Secret or the tenant
// token, and the long-connection URL handed back by the endpoint is accepted
// only as wss:// on a feishu.cn host: a tampered endpoint answer must not be
// able to point the socket somewhere else. Message text is never logged (I13).

export const feishuOpenOrigin = 'https://open.feishu.cn'
const allowedOrigins = [feishuOpenOrigin] as const
const label = '飞书'
const requestTimeoutMs = 15_000
const maxResponseBytes = 256 * 1024
const handshakeTimeoutMs = 15_000
const pongTimeoutMs = 30_000
const defaultPingIntervalMs = 120_000
const minPingIntervalMs = 10_000
const minReconnectDelayMs = 2_000
const maxReconnectDelayMs = 60_000
const fragmentTtlMs = 10_000
const maxFragmentsPerEvent = 64
const maxPendingEvents = 32
const maxEventBytes = 1024 * 1024
const seenEventLimit = 256
/** 一条文字消息按这么多字切；飞书单条上限远大于此，切短是为了在手机上好读。 */
const maxTextLength = 4000

// 长连接接口（/callback/ws/endpoint）回的 code，照 SDK 的 ErrorCode。
const endpointCodes = {
  ok: 0,
  systemBusy: 1,
  forbidden: 403,
  authFailed: 514,
  internalError: 1000040343,
  connectionLimit: 1000040350,
} as const

// 开放平台接口里 tenant_access_token 失效的几种 code，碰到就换一个再发一次。
const tokenInvalidCodes = new Set([99991661, 99991663, 99991668])

const needsLoginMessage = 'App ID 或 App Secret 不对，或者应用被停用了，请在电脑上重新填。'

export interface FeishuCredential {
  appId: string
  appSecret: string
}

export class FeishuAuthError extends Error {
  constructor(message = needsLoginMessage) {
    super(message)
    this.name = 'FeishuAuthError'
  }
}

const appIdPattern = /^cli_[A-Za-z0-9]{4,64}$/
const appSecretPattern = /^[A-Za-z0-9]{8,128}$/
const approvalNoncePattern = /^[A-Za-z0-9_-]{8,64}$/

/** 界面填进来的两串字：去掉两边空白，格式不对直接报能上屏的中文。 */
export function validateFeishuCredentialInput(appId: unknown, appSecret: unknown): FeishuCredential {
  const id = typeof appId === 'string' ? appId.trim() : ''
  const secret = typeof appSecret === 'string' ? appSecret.trim() : ''
  if (!appIdPattern.test(id)) throw new Error('App ID 应该是 cli_ 开头的一串字母和数字，请从飞书开放平台的「凭证与基础信息」里复制。')
  if (!appSecretPattern.test(secret)) throw new Error('App Secret 格式不对，请从飞书开放平台的「凭证与基础信息」里复制。')
  return { appId: id, appSecret: secret }
}

export function parseFeishuCredential(value: string | null): FeishuCredential | null {
  if (!value) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  try {
    return validateFeishuCredentialInput(parsed.appId, parsed.appSecret)
  } catch {
    return null
  }
}

export function serializeFeishuCredential(credential: FeishuCredential): string {
  return JSON.stringify({ appId: credential.appId, appSecret: credential.appSecret })
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export interface FeishuTenantToken {
  token: string
  expiresAt: number
}

/** 拿 tenant_access_token；App ID / App Secret 不对时抛 FeishuAuthError，保存凭据前也用它验一遍。 */
export async function requestFeishuTenantToken(
  fetchImpl: typeof fetch,
  credential: FeishuCredential,
  now: number,
  signal?: AbortSignal,
): Promise<FeishuTenantToken> {
  const response = await requestRemoteJson({
    fetch: fetchImpl,
    url: `${feishuOpenOrigin}/open-apis/auth/v3/tenant_access_token/internal`,
    allowedOrigins,
    method: 'POST',
    body: { app_id: credential.appId, app_secret: credential.appSecret },
    timeoutMs: requestTimeoutMs,
    maxResponseBytes,
    label,
    signal,
  })
  const payload = isRecord(response.payload) ? response.payload : {}
  const code = numberField(payload.code)
  const token = stringField(payload.tenant_access_token)
  if (code === 0 && token) {
    const expire = numberField(payload.expire) ?? 7200
    // 提前 5 分钟换，免得发到一半过期。
    return { token, expiresAt: now + Math.max(60, expire - 300) * 1000 }
  }
  if (code !== null && code !== 0) throw new FeishuAuthError()
  throw new Error(`飞书没有给出访问凭证（HTTP ${response.status}）`)
}

export type FeishuEndpointResult =
  | { kind: 'ok'; url: string; serviceId: number; pingIntervalMs: number; reconnectNonceMs: number }
  | { kind: 'auth-failed' }
  | { kind: 'connection-limit' }
  | { kind: 'retry' }

/** 长连接地址只认 wss:// 加 feishu.cn 的主机，不带账号密码。 */
export function resolveFeishuSocketUrl(value: unknown): { url: string; serviceId: number } | null {
  if (typeof value !== 'string' || value.length > 4096) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'wss:' || parsed.username || parsed.password) return null
  if (host !== 'feishu.cn' && !host.endsWith('.feishu.cn')) return null
  const serviceId = Number(parsed.searchParams.get('service_id'))
  if (!Number.isSafeInteger(serviceId)) return null
  return { url: parsed.href, serviceId }
}

function clampInterval(seconds: number | null, fallbackMs: number, minimumMs: number): number {
  if (seconds === null || seconds <= 0) return fallbackMs
  return Math.max(minimumMs, Math.min(seconds * 1000, 10 * 60_000))
}

export function parseFeishuEndpointResponse(status: number, payload: unknown): FeishuEndpointResult {
  if (!isRecord(payload)) return status === 401 || status === 403 ? { kind: 'auth-failed' } : { kind: 'retry' }
  const code = numberField(payload.code)
  if (code === endpointCodes.authFailed || code === endpointCodes.forbidden) return { kind: 'auth-failed' }
  if (code === endpointCodes.connectionLimit) return { kind: 'connection-limit' }
  if (code !== endpointCodes.ok) {
    // system_busy、internal_error 以外的 code 多半也是应用配置问题，但不确定时按能重试处理，
    // 重试有退避上限，不会把飞书打满。
    return code === endpointCodes.systemBusy || code === endpointCodes.internalError || code === null
      ? { kind: 'retry' }
      : { kind: 'auth-failed' }
  }
  const data = isRecord(payload.data) ? payload.data : {}
  const socket = resolveFeishuSocketUrl(data.URL)
  if (!socket) return { kind: 'retry' }
  const config = isRecord(data.ClientConfig) ? data.ClientConfig : {}
  return {
    kind: 'ok',
    url: socket.url,
    serviceId: socket.serviceId,
    pingIntervalMs: clampInterval(numberField(config.PingInterval), defaultPingIntervalMs, minPingIntervalMs),
    reconnectNonceMs: clampInterval(numberField(config.ReconnectNonce), 0, 0),
  }
}

/** 富文本（post）里能读成文字的几种节点；@、图片、表情这些不要。 */
function extractPostText(content: Record<string, unknown>): string | null {
  const body = Array.isArray(content.content)
    ? content
    : Object.values(content).find((value): value is Record<string, unknown> => isRecord(value) && Array.isArray(value.content))
  if (!body || !Array.isArray(body.content)) return null
  const lines: string[] = []
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (title) lines.push(title)
  for (const paragraph of body.content) {
    if (!Array.isArray(paragraph)) continue
    let line = ''
    for (const node of paragraph) {
      if (!isRecord(node)) continue
      if ((node.tag === 'text' || node.tag === 'a' || node.tag === 'code_block' || node.tag === 'md') && typeof node.text === 'string') {
        line += node.text
      }
    }
    lines.push(line)
  }
  const text = lines.join('\n').trim()
  return text || null
}

/** 把飞书消息的 content（JSON 字符串）读成纯文字；读不出来是 null，底座回「暂时只支持文字」。 */
export function extractFeishuText(messageType: unknown, content: unknown): string | null {
  if (typeof content !== 'string' || content.length > maxEventBytes) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (messageType === 'text') {
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
    return text || null
  }
  if (messageType === 'post') return extractPostText(parsed)
  return null
}

function parseMillis(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export interface FeishuEventContext {
  /** 认得的私聊会话：open_id → chat_id。卡片按钮回调不带 chat_type，靠它认是不是私聊里点的。 */
  p2pChats: Map<string, string>
}

export interface ParsedFeishuEvent {
  eventId: string | null
  inbound: RemoteInbound | null
}

/** 解析一条合并好的事件（schema 2.0）。认不出、不是人发的，inbound 为 null，照样回执。 */
export function parseFeishuEvent(payload: unknown, context: FeishuEventContext): ParsedFeishuEvent {
  if (!isRecord(payload) || !isRecord(payload.header) || !isRecord(payload.event)) return { eventId: null, inbound: null }
  const header = payload.header
  const event = payload.event
  const eventId = stringField(header.event_id)
  const eventType = header.event_type
  if (eventType === 'im.message.receive_v1') {
    const sender = isRecord(event.sender) ? event.sender : {}
    const senderId = isRecord(sender.sender_id) ? sender.sender_id : {}
    const message = isRecord(event.message) ? event.message : {}
    const openId = stringField(senderId.open_id)
    const messageId = stringField(message.message_id)
    if (sender.sender_type !== 'user' || !openId || !messageId) return { eventId, inbound: null }
    const direct = message.chat_type === 'p2p'
    const chatId = stringField(message.chat_id)
    if (direct && chatId) context.p2pChats.set(openId, chatId)
    const peer: RemotePeer = { channel: 'feishu', userId: openId }
    const sentAt = parseMillis(message.create_time)
    const base = { peer, direct, replyContext: messageId, ...(sentAt ? { sentAt } : {}) }
    const text = extractFeishuText(message.message_type, message.content)
    return {
      eventId,
      inbound: text === null ? { ...base, kind: 'unsupported', messageId } : { ...base, kind: 'text', messageId, text },
    }
  }
  if (eventType === 'card.action.trigger') {
    const operator = isRecord(event.operator) ? event.operator : {}
    const action = isRecord(event.action) ? event.action : {}
    const value = isRecord(action.value) ? action.value : {}
    const actionContext = isRecord(event.context) ? event.context : {}
    const openId = stringField(operator.open_id)
    const chatId = stringField(actionContext.open_chat_id) ?? stringField(event.open_chat_id)
    const approvalId = typeof value.approval === 'string' && /^\d{1,4}$/.test(value.approval) ? value.approval : null
    // 随机串认不出也照样交给底座，让它回一句卡片失效，而不是点了没反应。
    const nonce = typeof value.nonce === 'string' && approvalNoncePattern.test(value.nonce) ? value.nonce : null
    const decision = value.decision === 'accept' || value.decision === 'decline' ? value.decision : null
    if (!openId || !approvalId || !decision) return { eventId, inbound: null }
    const direct = Boolean(chatId) && context.p2pChats.get(openId) === chatId
    return {
      eventId,
      inbound: { kind: 'approval', peer: { channel: 'feishu', userId: openId }, direct, approvalId, nonce, decision },
    }
  }
  return { eventId, inbound: null }
}

/**
 * 审批卡片（消息卡片 1.0 写法）：正文是底座写好的纯文字，下面两颗按钮。按钮里带上这一条的随机串，
 * 旧卡片留在聊天记录里随时能点，底座靠它认出点的是不是当下这一条。
 */
export function buildFeishuApprovalCard(message: RemoteOutboundApproval): Record<string, unknown> {
  const { request } = message
  const button = (text: string, type: 'primary' | 'danger', decision: 'accept' | 'decline') => ({
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    value: { approval: request.approvalId, nonce: request.nonce, decision },
  })
  return {
    config: { wide_screen_mode: true, update_multi: false },
    header: { template: 'orange', title: { tag: 'plain_text', content: `需要你同意（第 ${request.approvalId} 条）` } },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: message.text } },
      { tag: 'action', actions: [button('同意', 'primary', 'accept'), button('拒绝', 'danger', 'decline')] },
    ],
  }
}

export function buildFeishuMessageBody(peer: RemotePeer, message: RemoteOutbound): Record<string, unknown> {
  if (message.kind === 'approval') {
    return { receive_id: peer.userId, msg_type: 'interactive', content: JSON.stringify(buildFeishuApprovalCard(message)) }
  }
  return { receive_id: peer.userId, msg_type: 'text', content: JSON.stringify({ text: message.text }) }
}

interface FragmentEntry {
  parts: Array<Uint8Array | undefined>
  bytes: number
  createdAt: number
}

/** 大事件会拆成几帧（同一个 message_id，sum 帧，seq 从 0 起）。合并有数量、大小、时间上限。 */
export class FeishuFragmentCache {
  private readonly entries = new Map<string, FragmentEntry>()

  merge(messageId: string, sum: number, seq: number, data: Uint8Array, now: number): Uint8Array | null {
    this.prune(now)
    if (!Number.isInteger(sum) || sum <= 0 || sum > maxFragmentsPerEvent || !Number.isInteger(seq) || seq < 0 || seq >= sum) {
      throw new Error('invalid fragment metadata')
    }
    if (sum === 1) return data
    let entry = this.entries.get(messageId)
    if (!entry) {
      if (this.entries.size >= maxPendingEvents) throw new Error('too many pending fragments')
      entry = { parts: new Array<Uint8Array | undefined>(sum).fill(undefined), bytes: 0, createdAt: now }
      this.entries.set(messageId, entry)
    }
    if (entry.parts.length !== sum) {
      this.entries.delete(messageId)
      throw new Error('fragment count changed')
    }
    if (!entry.parts[seq]) {
      entry.parts[seq] = data
      entry.bytes += data.byteLength
    }
    if (entry.bytes > maxEventBytes) {
      this.entries.delete(messageId)
      throw new Error('event too large')
    }
    const parts = entry.parts
    if (!parts.every((part): part is Uint8Array => part !== undefined)) return null
    this.entries.delete(messageId)
    const merged = new Uint8Array(entry.bytes)
    let offset = 0
    for (const part of parts) {
      merged.set(part, offset)
      offset += part.byteLength
    }
    return merged
  }

  clear(): void {
    this.entries.clear()
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now - entry.createdAt > fragmentTtlMs) this.entries.delete(id)
    }
  }
}

/** 主进程用全局 WebSocket（WHATWG 那套）；测试里换成假的。 */
export interface FeishuSocket {
  binaryType: string
  readonly readyState: number
  send(data: Uint8Array): void
  close(): void
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

export interface FeishuChannelOptions {
  createSocket?(url: string): FeishuSocket
  random?(): number
}

const socketOpen = 1
const textDecoder = new TextDecoder('utf-8', { fatal: true })
const textEncoder = new TextEncoder()

function defaultCreateSocket(url: string): FeishuSocket {
  return new WebSocket(url)
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return null
}

class FeishuRemoteChannel implements RemoteChannelAdapter {
  readonly id = 'feishu' as const
  readonly capabilities = { approvalButtons: true, maxTextLength }
  private handlers: RemoteChannelHandlers | null = null
  private credential: FeishuCredential | null = null
  private token: FeishuTenantToken | null = null
  private tokenRequest: Promise<FeishuTenantToken> | null = null
  private socket: FeishuSocket | null = null
  private generation = 0
  private running = false
  private serviceId = 0
  private pingIntervalMs = defaultPingIntervalMs
  private reconnectNonceMs = 0
  private reconnectDelayMs = minReconnectDelayMs
  private pingTimer: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private handshakeTimer: NodeJS.Timeout | null = null
  private abort: AbortController | null = null
  private readonly fragments = new FeishuFragmentCache()
  private readonly seenEvents = new Set<string>()
  private readonly eventContext: FeishuEventContext = { p2pChats: new Map() }
  private lastStatus: RemoteChannelStatus = { state: 'stopped' }
  /** 电脑上的时间比飞书快多少，每次连长连接、发消息时拿回应里的时间重估（RemoteInbound.clockAheadMs）。 */
  private clockAheadMs: number | undefined

  constructor(
    private readonly deps: RemoteChannelDependencies,
    private readonly options: FeishuChannelOptions,
  ) {}

  async start(handlers: RemoteChannelHandlers): Promise<void> {
    await this.stop()
    this.handlers = handlers
    this.running = true
    this.credential = parseFeishuCredential(await this.deps.readCredential())
    if (!this.running) return
    if (!this.credential) {
      this.running = false
      this.setStatus({ state: 'needs-login', message: '还没填飞书应用的 App ID 和 App Secret。' })
      return
    }
    this.reconnectDelayMs = minReconnectDelayMs
    void this.connect()
  }

  async stop(): Promise<void> {
    this.running = false
    this.generation += 1
    this.abort?.abort()
    this.abort = null
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
    }
    this.fragments.clear()
    this.token = null
    this.tokenRequest = null
    if (this.lastStatus.state !== 'stopped') this.setStatus({ state: 'stopped' })
  }

  async send(peer: RemotePeer, message: RemoteOutbound): Promise<void> {
    if (!this.credential) throw new Error('飞书渠道没有在运行')
    const body = buildFeishuMessageBody(peer, message)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.tenantToken()
      const response = await requestRemoteJson({
        fetch: this.deps.fetch,
        url: `${feishuOpenOrigin}/open-apis/im/v1/messages?receive_id_type=open_id`,
        allowedOrigins,
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
        timeoutMs: requestTimeoutMs,
        maxResponseBytes,
        label,
      })
      this.noteServerTime(response.serverTime)
      const payload = isRecord(response.payload) ? response.payload : {}
      const code = numberField(payload.code)
      if (code === 0) return
      if (code !== null && tokenInvalidCodes.has(code) && attempt === 0) {
        this.token = null
        continue
      }
      this.deps.log('warn', 'feishu.send-failed', { status: response.status, code })
      throw new Error(`飞书没有发出这条消息（错误码 ${code ?? response.status}）`)
    }
  }

  private noteServerTime(serverTime: number | undefined): void {
    if (serverTime !== undefined) this.clockAheadMs = this.deps.now() - serverTime
  }

  private setStatus(status: RemoteChannelStatus): void {
    if (status.state === this.lastStatus.state && status.message === this.lastStatus.message) return
    this.lastStatus = status
    this.handlers?.onStatus(status)
  }

  private tenantToken(): Promise<string> {
    const credential = this.credential
    if (!credential) return Promise.reject(new Error('飞书渠道没有在运行'))
    if (this.token && this.token.expiresAt > this.deps.now()) return Promise.resolve(this.token.token)
    if (!this.tokenRequest) {
      const request = requestFeishuTenantToken(this.deps.fetch, credential, this.deps.now())
      this.tokenRequest = request
      request.then(
        (token) => {
          if (this.tokenRequest === request) this.token = token
        },
        () => undefined,
      ).finally(() => {
        if (this.tokenRequest === request) this.tokenRequest = null
      })
    }
    return this.tokenRequest.then((token) => token.token).catch((error: unknown) => {
      if (error instanceof FeishuAuthError) this.failAuth()
      throw error
    })
  }

  private failAuth(): void {
    this.deps.log('warn', 'feishu.auth-failed')
    void this.stop().then(() => this.setStatus({ state: 'needs-login', message: needsLoginMessage }))
  }

  private clearTimers(): void {
    for (const timer of [this.pingTimer, this.pongTimer, this.reconnectTimer, this.handshakeTimer]) {
      if (timer) clearTimeout(timer)
    }
    this.pingTimer = null
    this.pongTimer = null
    this.reconnectTimer = null
    this.handshakeTimer = null
  }

  private async connect(): Promise<void> {
    const credential = this.credential
    if (!this.running || !credential) return
    const generation = ++this.generation
    this.setStatus(this.lastStatus.state === 'connected' || this.lastStatus.message
      ? { state: 'connecting', message: '连不上飞书，正在重试。' }
      : { state: 'connecting' })
    const controller = new AbortController()
    this.abort = controller
    let result: FeishuEndpointResult
    try {
      const response = await requestRemoteJson({
        fetch: this.deps.fetch,
        url: `${feishuOpenOrigin}/callback/ws/endpoint`,
        allowedOrigins,
        method: 'POST',
        headers: { locale: 'zh' },
        body: { AppID: credential.appId, AppSecret: credential.appSecret },
        timeoutMs: requestTimeoutMs,
        maxResponseBytes,
        label,
        signal: controller.signal,
      })
      this.noteServerTime(response.serverTime)
      result = parseFeishuEndpointResponse(response.status, response.payload)
    } catch (error) {
      if (generation !== this.generation) return
      this.deps.log('warn', 'feishu.endpoint-failed', {
        reason: error instanceof RemoteHttpError ? error.reason : 'unknown',
      })
      result = { kind: 'retry' }
    }
    if (generation !== this.generation || !this.running) return
    if (result.kind === 'auth-failed') {
      this.failAuth()
      return
    }
    if (result.kind === 'connection-limit') {
      this.deps.log('warn', 'feishu.connection-limit')
      await this.stop()
      this.setStatus({ state: 'error', message: '这个飞书应用连着的地方太多了，请关掉别处用同一个应用的长连接再试。' })
      return
    }
    if (result.kind === 'retry') {
      this.scheduleReconnect()
      return
    }
    this.serviceId = result.serviceId
    this.pingIntervalMs = result.pingIntervalMs
    this.reconnectNonceMs = result.reconnectNonceMs
    this.openSocket(result.url, generation)
  }

  private openSocket(url: string, generation: number): void {
    let socket: FeishuSocket
    try {
      socket = (this.options.createSocket ?? defaultCreateSocket)(url)
      socket.binaryType = 'arraybuffer'
    } catch {
      this.deps.log('warn', 'feishu.socket-create-failed')
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    let opened = false
    this.handshakeTimer = setTimeout(() => {
      if (opened || generation !== this.generation) return
      this.deps.log('warn', 'feishu.handshake-timeout')
      this.dropSocket(generation)
    }, handshakeTimeoutMs)
    this.handshakeTimer.unref?.()
    socket.addEventListener('open', () => {
      if (generation !== this.generation) return
      opened = true
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
      this.reconnectDelayMs = minReconnectDelayMs
      this.deps.log('info', 'feishu.connected')
      this.setStatus({ state: 'connected' })
      this.ping(generation)
    })
    socket.addEventListener('message', (event) => {
      if (generation !== this.generation) return
      this.onSocketMessage(event.data, generation)
    })
    socket.addEventListener('error', () => {
      if (generation !== this.generation) return
      this.deps.log('warn', 'feishu.socket-error')
    })
    socket.addEventListener('close', () => {
      if (generation !== this.generation) return
      this.deps.log('info', 'feishu.socket-closed')
      this.dropSocket(generation)
    })
  }

  /** 这条连接不能用了：清掉、按退避重连。 */
  private dropSocket(generation: number): void {
    if (generation !== this.generation) return
    const socket = this.socket
    this.socket = null
    this.generation += 1
    this.clearTimers()
    if (socket) {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return
    const jitter = this.reconnectNonceMs > 0 ? Math.floor((this.options.random ?? Math.random)() * this.reconnectNonceMs) : 0
    const delay = Math.min(maxReconnectDelayMs, this.reconnectDelayMs + jitter)
    this.reconnectDelayMs = Math.min(maxReconnectDelayMs, this.reconnectDelayMs * 2)
    this.setStatus({ state: 'connecting', message: '连不上飞书，正在重试。' })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private sendFrame(frame: FeishuFrame): void {
    const socket = this.socket
    if (!socket || socket.readyState !== socketOpen) return
    try {
      socket.send(encodeFeishuFrame(frame))
    } catch {
      this.deps.log('warn', 'feishu.frame-send-failed')
    }
  }

  private ping(generation: number): void {
    if (generation !== this.generation) return
    this.sendFrame({
      seqId: 0n,
      logId: 0n,
      service: this.serviceId,
      method: feishuFrameMethod.control,
      headers: [{ key: 'type', value: 'ping' }],
    })
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pongTimer = setTimeout(() => {
      this.deps.log('warn', 'feishu.pong-timeout')
      this.dropSocket(generation)
    }, pongTimeoutMs)
    this.pongTimer.unref?.()
    this.pingTimer = setTimeout(() => this.ping(generation), this.pingIntervalMs)
    this.pingTimer.unref?.()
  }

  private onSocketMessage(data: unknown, generation: number): void {
    const bytes = toBytes(data)
    if (!bytes) return
    // 收到任何一帧都说明连接还活着。
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pongTimer = null
    let frame: FeishuFrame
    try {
      frame = decodeFeishuFrame(bytes)
    } catch {
      this.deps.log('warn', 'feishu.frame-invalid', { bytes: bytes.byteLength })
      return
    }
    if (frame.method === feishuFrameMethod.control) {
      this.onControlFrame(frame)
      return
    }
    if (frame.method === feishuFrameMethod.data) this.onDataFrame(frame, generation)
  }

  private onControlFrame(frame: FeishuFrame): void {
    if (feishuFrameHeader(frame, 'type') !== 'pong' || !frame.payload) return
    try {
      const pong: unknown = JSON.parse(textDecoder.decode(frame.payload))
      if (isRecord(pong)) {
        this.pingIntervalMs = clampInterval(numberField(pong.PingInterval), this.pingIntervalMs, minPingIntervalMs)
        const nonce = numberField(pong.ReconnectNonce)
        if (nonce !== null) this.reconnectNonceMs = clampInterval(nonce, 0, 0)
      }
    } catch {
      this.deps.log('warn', 'feishu.pong-invalid')
    }
  }

  private onDataFrame(frame: FeishuFrame, generation: number): void {
    if (feishuFrameHeader(frame, 'type') !== 'event') return
    const messageId = feishuFrameHeader(frame, 'message_id') ?? ''
    let merged: Uint8Array | null
    try {
      merged = this.fragments.merge(
        messageId,
        Number(feishuFrameHeader(frame, 'sum') ?? '1'),
        Number(feishuFrameHeader(frame, 'seq') ?? '0'),
        frame.payload ?? new Uint8Array(),
        this.deps.now(),
      )
    } catch {
      this.deps.log('warn', 'feishu.fragment-invalid')
      return
    }
    if (!merged) return
    let payload: unknown = null
    try {
      payload = JSON.parse(textDecoder.decode(merged))
    } catch {
      this.deps.log('warn', 'feishu.event-unparsable', { bytes: merged.byteLength })
    }
    // 先回执再处理：飞书 3 秒内收不到回执会重投，底座处理慢也不该让它重投。
    this.acknowledge(frame, generation)
    if (payload === null) return
    if (isRecord(payload) && 'encrypt' in payload) {
      this.deps.log('warn', 'feishu.event-encrypted')
      return
    }
    const parsed = parseFeishuEvent(payload, this.eventContext)
    if (parsed.eventId) {
      if (this.seenEvents.has(parsed.eventId)) return
      this.seenEvents.add(parsed.eventId)
      if (this.seenEvents.size > seenEventLimit) {
        const oldest = this.seenEvents.values().next().value
        if (oldest !== undefined) this.seenEvents.delete(oldest)
      }
    }
    if (!parsed.inbound) return
    const inbound = this.clockAheadMs === undefined ? parsed.inbound : { ...parsed.inbound, clockAheadMs: this.clockAheadMs }
    try {
      this.handlers?.onInbound(inbound)
    } catch {
      this.deps.log('error', 'feishu.inbound-handler-failed')
    }
  }

  private acknowledge(frame: FeishuFrame, generation: number): void {
    if (generation !== this.generation) return
    this.sendFrame({
      ...frame,
      headers: [...frame.headers, { key: 'biz_rt', value: '0' }],
      payload: textEncoder.encode(JSON.stringify({ code: 200, data: Buffer.from('{}').toString('base64') })),
    })
  }
}

export function createFeishuRemoteChannel(deps: RemoteChannelDependencies, options: FeishuChannelOptions = {}): RemoteChannelAdapter {
  return new FeishuRemoteChannel(deps, options)
}
