import { randomBytes } from 'node:crypto'
import { RemoteHttpError, requestRemoteJson } from './codex-remote-http'

// 微信遥控走腾讯给微信 ClawBot 开的 iLink 接口（ilinkai.weixin.qq.com）：电脑主动长轮询收消息，
// 不要公网、不经过星芒的服务器。接口没有公开文档，收发和扫码的写法照腾讯自己发布的
// @tencent-weixin/openclaw-weixin 2.4.10（MIT）逐个核过，代码是这里自己写的。
//
// 这条通道是腾讯给 OpenClaw 开的，别的程序借用许不许没写明，界面上标「实验功能」。所以这里
// 宁可少做：只收发文字，不传图片文件，不发「正在输入」，不做群聊。
//
// iLink can move a login to another host mid-scan (redirect_host) and hands the
// bot its own API host once confirmed (baseurl). Both arrive in a response body,
// so a hijacked or spoofed answer could point the bot token at any host. Only
// https hosts under weixin.qq.com are accepted; anything else falls back to the
// default host, and every request still goes through requestRemoteJson with
// that single origin pinned (I10).

export const weixinIlinkDefaultOrigin = 'https://ilinkai.weixin.qq.com'

// 协议版本照着核对过的那一版填：服务端按它判断客户端会不会新格式。自报身份放在 bot_agent，
// 腾讯说明里它只用来记日志和统计，星芒在这里如实写自己的名字和版本。
const weixinProtocolVersion = '2.4.10'
const weixinAppId = 'bot'
const weixinLoginBotType = '3'

export const weixinTextLimit = 4000

export const weixinConfirmedWithoutLoginMessage = '扫码成功了，但微信没有给回登录信息，请重新扫码'

const qrRequestTimeoutMs = 15_000
// 扫码状态是长轮询，服务端最多压 35 秒才回。
const qrStatusTimeoutMs = 40_000
const sendTimeoutMs = 15_000
const notifyTimeoutMs = 10_000
const defaultLongPollMs = 35_000
const minimumLongPollMs = 5_000
const maximumLongPollMs = 50_000
// 客户端比服务端多等一会儿，免得服务端正要回的时候被我们自己掐掉。
const longPollGraceMs = 10_000
const smallResponseBytes = 64 * 1024
const updatesResponseBytes = 2 * 1024 * 1024

/** 会话过期：令牌不能再用，要重新扫码。 */
export const weixinSessionExpiredCode = -14
/** 发消息时带的 context_token 过期了（对方很久没说话），去掉它再发一次。 */
export const weixinStaleContextCode = -2

const weixinMessageTypeUser = 1
const weixinMessageTypeBot = 2
const weixinMessageStateFinish = 2
const weixinItemText = 1
const weixinItemVoice = 3

const losslessIdFields: ReadonlySet<string> = new Set(['message_id', 'msg_id', 'svr_id'])

export class WeixinIlinkError extends Error {
  constructor(
    message: string,
    readonly reason: 'session-expired' | 'stale-context' | 'refused' | 'rejected' | 'invalid-response',
    readonly code?: number,
  ) {
    super(message)
    this.name = 'WeixinIlinkError'
  }
}

export interface WeixinIlinkContext {
  fetch: typeof fetch
  /** 已经过 resolveWeixinIlinkOrigin 认过的 origin。 */
  origin: string
  botAgent: string
  signal?: AbortSignal
}

export interface WeixinQrCode {
  /** 轮询扫码状态用的编号。 */
  qrcode: string
  /** 编进二维码里的内容（一个链接），只画成图，不打开它。 */
  content: string
}

export type WeixinQrStatus =
  | { status: 'wait' }
  | { status: 'scanned' }
  | { status: 'need-verify-code' }
  | { status: 'verify-code-blocked' }
  | { status: 'expired' }
  | { status: 'already-bound' }
  | { status: 'redirect'; origin: string | null }
  | { status: 'confirmed'; token: string; botId: string; origin: string | null; ownerUserId: string | null }

export interface WeixinInboundMessage {
  messageId: string
  fromUserId: string
  /** 群里来的消息有 group_id。 */
  groupId: string | null
  messageType: number
  createdAt: number | null
  contextToken: string | null
  /** 文字或语音转写；转不成文字时是 null。 */
  text: string | null
  /** 带了图片、文件、视频或转写不出的语音。 */
  hasMedia: boolean
}

export interface WeixinUpdates {
  messages: WeixinInboundMessage[]
  cursor: string
  nextLongPollMs: number
}

/**
 * Accepts an https origin (or a bare host, as redirect_host comes) under
 * weixin.qq.com and returns its origin. Ports, credentials and paths are
 * refused: iLink's own hosts never carry them, and keeping the origin bare
 * means endpoint paths always resolve from the root.
 */
export function resolveWeixinIlinkOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 255) return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null
  const host = parsed.hostname.toLowerCase()
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..')) return null
  if (host !== 'weixin.qq.com' && !host.endsWith('.weixin.qq.com')) return null
  return parsed.origin
}

/** 自报身份：只留 ASCII 版本号字样，拼不出来就退回不带版本的名字。 */
export function buildWeixinBotAgent(appVersion: string | null | undefined): string {
  const version = typeof appVersion === 'string' ? appVersion.trim() : ''
  return /^[0-9A-Za-z.+-]{1,32}$/.test(version) ? `XingmangAI/${version}` : 'XingmangAI/0'
}

/** 0x00MMNNPP，跟腾讯插件的算法一样。 */
export function buildWeixinClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

/**
 * JSON.parse that keeps uint64 message identifiers as strings. Two messages a
 * few IDs apart collapse into the same double past 2^53, and the core uses the
 * ID to drop redelivered messages, so a lossy parse would silently drop real
 * commands. Only object keys are rewritten; text inside string values is copied
 * verbatim.
 */
export function parseWeixinJson(text: string): unknown {
  let output = ''
  let index = 0
  while (index < text.length) {
    if (text[index] !== '"') {
      output += text[index]
      index += 1
      continue
    }
    const start = index
    index += 1
    let escaped = false
    while (index < text.length) {
      const character = text[index]
      index += 1
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') break
    }
    const token = text.slice(start, index)
    output += token
    let cursor = index
    while (/\s/.test(text[cursor] ?? '')) cursor += 1
    if (text[cursor] !== ':') continue
    let key: unknown
    try {
      key = JSON.parse(token)
    } catch {
      continue
    }
    if (typeof key !== 'string' || !losslessIdFields.has(key)) continue
    cursor += 1
    while (/\s/.test(text[cursor] ?? '')) cursor += 1
    const numberStart = cursor
    if (text[cursor] === '-') cursor += 1
    while (/\d/.test(text[cursor] ?? '')) cursor += 1
    const digits = text.slice(numberStart, cursor)
    if (!/^-?\d+$/.test(digits)) continue
    output += `${text.slice(index, numberStart)}"${digits}"`
    index = cursor
  }
  return JSON.parse(output)
}

function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
}

function commonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': weixinAppId,
    'iLink-App-ClientVersion': String(buildWeixinClientVersion(weixinProtocolVersion)),
  }
}

function botHeaders(token: string | null): Record<string, string> {
  return {
    ...commonHeaders(),
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function baseInfo(botAgent: string): Record<string, string> {
  return { channel_version: weixinProtocolVersion, bot_agent: botAgent }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maximumLength ? trimmed : null
}

function optionalInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^-?\d{1,15}$/.test(value)) return Number(value)
  return null
}

function identifierString(value: unknown): string | null {
  if (typeof value === 'string' && /^-?\d{1,20}$/.test(value.trim())) return value.trim()
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return null
}

function endpoint(context: WeixinIlinkContext, path: string): string {
  return new URL(path, `${context.origin}/`).toString()
}

/** ret / errcode 不为 0 时抛错；-14 单独认成会话过期。 */
function assertIlinkSuccess(payload: Record<string, unknown>, label: string): void {
  const ret = optionalInteger(payload.ret) ?? 0
  const errcode = optionalInteger(payload.errcode) ?? 0
  if (ret === weixinSessionExpiredCode || errcode === weixinSessionExpiredCode) {
    throw new WeixinIlinkError('微信这边的登录已经过期，请在电脑上重新扫码', 'session-expired', weixinSessionExpiredCode)
  }
  if (ret === weixinStaleContextCode) {
    throw new WeixinIlinkError(`${label}失败：这次对话已过期`, 'stale-context', ret)
  }
  if (ret !== 0 || errcode !== 0) {
    throw new WeixinIlinkError(`${label}失败（${ret !== 0 ? ret : errcode}）`, 'rejected', ret !== 0 ? ret : errcode)
  }
}

function payloadRecord(response: { status: number; ok: boolean; payload: unknown }, label: string): Record<string, unknown> {
  if (response.status === 401 || response.status === 403) {
    throw new WeixinIlinkError('微信拒绝了这次登录，请在电脑上重新扫码', 'refused', response.status)
  }
  if (!response.ok) {
    throw new WeixinIlinkError(`${label}失败，微信服务返回 HTTP ${response.status}`, 'rejected', response.status)
  }
  if (!isRecord(response.payload)) {
    throw new WeixinIlinkError(`${label}失败，微信服务的回应看不懂`, 'invalid-response')
  }
  return response.payload
}

export async function fetchWeixinLoginQrCode(context: WeixinIlinkContext, knownTokens: readonly string[]): Promise<WeixinQrCode> {
  const response = await requestRemoteJson({
    fetch: context.fetch,
    url: endpoint(context, `ilink/bot/get_bot_qrcode?bot_type=${weixinLoginBotType}`),
    allowedOrigins: [context.origin],
    method: 'POST',
    headers: commonHeaders(),
    // 带上本机已有的令牌，服务端认出是同一台已经连过的，就回 binded_redirect 而不是再签一个。
    body: { local_token_list: knownTokens.slice(0, 1) },
    timeoutMs: qrRequestTimeoutMs,
    maxResponseBytes: smallResponseBytes,
    label: '微信',
    signal: context.signal,
  })
  const payload = payloadRecord(response, '获取微信二维码')
  const qrcode = optionalString(payload.qrcode, 512)
  const content = optionalString(payload.qrcode_img_content, 2048)
  if (!qrcode || !content) throw new WeixinIlinkError('获取微信二维码失败，微信服务的回应看不懂', 'invalid-response')
  return { qrcode, content }
}

export async function pollWeixinLoginStatus(
  context: WeixinIlinkContext,
  qrcode: string,
  verifyCode: string | null,
): Promise<WeixinQrStatus> {
  const query = new URLSearchParams({ qrcode })
  if (verifyCode) query.set('verify_code', verifyCode)
  let response
  try {
    response = await requestRemoteJson({
      fetch: context.fetch,
      url: endpoint(context, `ilink/bot/get_qrcode_status?${query.toString()}`),
      allowedOrigins: [context.origin],
      method: 'GET',
      headers: commonHeaders(),
      timeoutMs: qrStatusTimeoutMs,
      maxResponseBytes: smallResponseBytes,
      label: '微信',
      signal: context.signal,
    })
  } catch (error) {
    // 长轮询到点没回是常态，当成「还在等」。
    if (error instanceof RemoteHttpError && error.reason === 'timeout') return { status: 'wait' }
    throw error
  }
  const payload = payloadRecord(response, '查询扫码结果')
  switch (payload.status) {
    case 'wait':
      return { status: 'wait' }
    case 'scaned':
      return { status: 'scanned' }
    case 'need_verifycode':
      return { status: 'need-verify-code' }
    case 'verify_code_blocked':
      return { status: 'verify-code-blocked' }
    case 'expired':
      return { status: 'expired' }
    case 'binded_redirect':
      return { status: 'already-bound' }
    case 'scaned_but_redirect':
      return { status: 'redirect', origin: resolveWeixinIlinkOrigin(payload.redirect_host) }
    case 'confirmed': {
      const token = optionalString(payload.bot_token, 4096)
      const botId = optionalString(payload.ilink_bot_id, 256)
      if (!token || !botId) throw new WeixinIlinkError(weixinConfirmedWithoutLoginMessage, 'invalid-response')
      return {
        status: 'confirmed',
        token,
        botId,
        origin: resolveWeixinIlinkOrigin(payload.baseurl),
        ownerUserId: optionalString(payload.ilink_user_id, 256),
      }
    }
    default:
      throw new WeixinIlinkError('查询扫码结果失败，微信服务的回应看不懂', 'invalid-response')
  }
}

function textOfItems(items: unknown[]): { text: string | null; hasMedia: boolean } {
  let hasMedia = false
  for (const item of items) {
    if (!isRecord(item)) continue
    const type = optionalInteger(item.type)
    if (type === weixinItemText && isRecord(item.text_item) && typeof item.text_item.text === 'string') {
      return { text: item.text_item.text, hasMedia }
    }
    // 微信自带语音转文字，转出来了就当文字用。
    if (type === weixinItemVoice && isRecord(item.voice_item) && typeof item.voice_item.text === 'string' && item.voice_item.text.trim()) {
      return { text: item.voice_item.text, hasMedia }
    }
    if (type !== null && type !== weixinItemText) hasMedia = true
  }
  return { text: null, hasMedia }
}

function firstItemMessageId(items: unknown[]): string | null {
  for (const item of items) {
    if (!isRecord(item)) continue
    const id = identifierString(item.msg_id)
    if (id) return id
  }
  return null
}

export function parseWeixinInboundMessage(value: unknown): WeixinInboundMessage | null {
  if (!isRecord(value)) return null
  const items = Array.isArray(value.item_list) ? value.item_list : []
  const fromUserId = optionalString(value.from_user_id, 256)
  const messageId = identifierString(value.message_id) ?? firstItemMessageId(items)
  if (!fromUserId || !messageId) return null
  const { text, hasMedia } = textOfItems(items)
  return {
    messageId,
    fromUserId,
    groupId: optionalString(value.group_id, 256),
    messageType: optionalInteger(value.message_type) ?? 0,
    createdAt: optionalInteger(value.create_time_ms),
    contextToken: optionalString(value.context_token, 4096),
    text,
    hasMedia,
  }
}

export function isWeixinUserMessage(message: WeixinInboundMessage): boolean {
  return message.messageType === weixinMessageTypeUser
}

export function clampWeixinLongPollMs(value: unknown): number {
  const suggested = optionalInteger(value)
  if (suggested === null || suggested <= 0) return defaultLongPollMs
  return Math.min(maximumLongPollMs, Math.max(minimumLongPollMs, suggested))
}

export async function fetchWeixinUpdates(
  context: WeixinIlinkContext,
  token: string,
  cursor: string,
  longPollMs: number,
): Promise<WeixinUpdates> {
  let response
  try {
    response = await requestRemoteJson({
      fetch: context.fetch,
      url: endpoint(context, 'ilink/bot/getupdates'),
      allowedOrigins: [context.origin],
      method: 'POST',
      headers: botHeaders(token),
      body: { get_updates_buf: cursor, base_info: baseInfo(context.botAgent) },
      timeoutMs: longPollMs + longPollGraceMs,
      maxResponseBytes: updatesResponseBytes,
      label: '微信',
      signal: context.signal,
      parseJson: parseWeixinJson,
    })
  } catch (error) {
    if (error instanceof RemoteHttpError && error.reason === 'timeout') {
      return { messages: [], cursor, nextLongPollMs: longPollMs }
    }
    throw error
  }
  const payload = payloadRecord(response, '收微信消息')
  assertIlinkSuccess(payload, '收微信消息')
  const nextCursor = typeof payload.get_updates_buf === 'string' && payload.get_updates_buf.length <= 64 * 1024
    ? payload.get_updates_buf
    : cursor
  const messages: WeixinInboundMessage[] = []
  if (Array.isArray(payload.msgs)) {
    for (const raw of payload.msgs) {
      const message = parseWeixinInboundMessage(raw)
      if (message) messages.push(message)
    }
  }
  return {
    messages,
    cursor: nextCursor || cursor,
    nextLongPollMs: payload.longpolling_timeout_ms === undefined ? longPollMs : clampWeixinLongPollMs(payload.longpolling_timeout_ms),
  }
}

export function buildWeixinClientId(): string {
  return `xingmang-weixin-${randomBytes(8).toString('hex')}`
}

export async function sendWeixinText(
  context: WeixinIlinkContext,
  token: string,
  toUserId: string,
  text: string,
  contextToken: string | null,
): Promise<void> {
  const response = await requestRemoteJson({
    fetch: context.fetch,
    url: endpoint(context, 'ilink/bot/sendmessage'),
    allowedOrigins: [context.origin],
    method: 'POST',
    headers: botHeaders(token),
    body: {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: buildWeixinClientId(),
        message_type: weixinMessageTypeBot,
        message_state: weixinMessageStateFinish,
        item_list: [{ type: weixinItemText, text_item: { text } }],
        ...(contextToken ? { context_token: contextToken } : {}),
      },
      base_info: baseInfo(context.botAgent),
    },
    timeoutMs: sendTimeoutMs,
    maxResponseBytes: smallResponseBytes,
    label: '微信',
    signal: context.signal,
    parseJson: parseWeixinJson,
  })
  assertIlinkSuccess(payloadRecord(response, '发微信消息'), '发微信消息')
}

/** 告诉微信这台开始收 / 不再收消息。腾讯插件启停时都发，失败不影响收发。 */
export async function notifyWeixinLifecycle(context: WeixinIlinkContext, token: string, phase: 'start' | 'stop'): Promise<void> {
  const response = await requestRemoteJson({
    fetch: context.fetch,
    url: endpoint(context, phase === 'start' ? 'ilink/bot/msg/notifystart' : 'ilink/bot/msg/notifystop'),
    allowedOrigins: [context.origin],
    method: 'POST',
    headers: botHeaders(token),
    body: { base_info: baseInfo(context.botAgent) },
    timeoutMs: notifyTimeoutMs,
    maxResponseBytes: smallResponseBytes,
    label: '微信',
    signal: context.signal,
  })
  assertIlinkSuccess(payloadRecord(response, '通知微信'), '通知微信')
}
