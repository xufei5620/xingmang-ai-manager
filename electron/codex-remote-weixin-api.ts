import { createDecipheriv, randomBytes } from 'node:crypto'
import type { RemoteImageFetchResult } from './codex-remote-channel'
import { RemoteHttpError, requestRemoteBytes, requestRemoteJson } from './codex-remote-http'

// 微信遥控走腾讯给微信 ClawBot 开的 iLink 接口（ilinkai.weixin.qq.com）：电脑主动长轮询收消息，
// 不要公网、不经过星芒的服务器。接口没有公开文档，收发和扫码的写法照腾讯自己发布的
// @tencent-weixin/openclaw-weixin 2.4.10（MIT）逐个核过，代码是这里自己写的。
//
// 这条通道是腾讯给 OpenClaw 开的，别的程序借用许不许没写明，界面上标「实验功能」。所以这里
// 宁可少做：只收文字和图片、只发文字，不发图片文件，不发「正在输入」，不做群聊。收图片（YF-14）是
// 2026-11-11 产品负责人亲手打字「微信图片网址加」以后才加的，取图只去腾讯的图片服务器那一个地址。
//
// iLink can move a login to another host mid-scan (redirect_host) and hands the
// bot its own API host once confirmed (baseurl). Both arrive in a response body,
// so a hijacked or spoofed answer could point the bot token at any host. Only
// https hosts under weixin.qq.com are accepted; anything else falls back to the
// default host, and every request still goes through requestRemoteJson with
// that single origin pinned (I10).

export const weixinIlinkDefaultOrigin = 'https://ilinkai.weixin.qq.com'

/**
 * 微信消息里的图放在腾讯的图片服务器上（YF-14），是加密过的，电脑去这里下载再解开。手机遥控能连的地址
 * 多这一条是放宽，产品负责人 2026-11-11 北京亲手打字「微信图片网址加」才加的；只认这一个 origin，
 * 消息里带来的别的地址一律不去。
 */
export const weixinCdnOrigin = 'https://novac2c.cdn.weixin.qq.com'

// 协议版本照着核对过的那一版填：服务端按它判断客户端会不会新格式。自报身份放在 bot_agent，
// 腾讯说明里它只用来记日志和统计，星芒在这里如实写自己的名字和版本。
const weixinProtocolVersion = '2.4.10'
const weixinAppId = 'bot'
const weixinLoginBotType = '3'
/**
 * 取二维码时请微信这次一定要扫码人输手机上显示的那串数字（YF-5）。照腾讯 openclaw-weixin 3.0.0-beta-0
 * `src/auth/login-qr.ts` 的 encodeBotSpamBusinessData：JSON 按 UTF-8 再标准 base64，放在请求体的
 * bot_spam_business_data 里；微信认不认、这次要不要数字仍以它回的状态为准。
 */
export const weixinVerifyPinBusinessData = Buffer.from(JSON.stringify({ verify_pin: 1 }), 'utf8').toString('base64')

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
const weixinItemImage = 2
const weixinItemVoice = 3
/** 一条消息里最多认这么多张图；底座自己还有一条每次最多几张的线。 */
const maxImagesPerMessage = 20
const maxEncryptQueryParamLength = 4096
const imageTimeoutMs = 30_000

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
  /** 带的图（YF-14），按消息里的顺序。 */
  images: WeixinImageRef[]
  /** 带了文件、视频或转写不出的语音（图片另算在 images 里）。 */
  hasMedia: boolean
}

/**
 * 一张图在腾讯图片服务器上的位置和解开它的钥匙（YF-14）。照腾讯 openclaw-weixin 的写法：
 * image_item.media.encrypt_query_param 拼下载地址；钥匙优先用 image_item.aeskey（32 位十六进制），
 * 没有再用 media.aes_key（base64，解出来是 16 字节原值，或者 32 个十六进制字符）。没有钥匙的照原样存。
 */
export interface WeixinImageRef {
  encryptQueryParam: string
  /** AES-128 钥匙，32 位小写十六进制；没有是 null。 */
  aesKeyHex: string | null
}

export interface WeixinUpdates {
  messages: WeixinInboundMessage[]
  cursor: string
  nextLongPollMs: number
  /** 这次回应里 Date 头的时间（毫秒），拿来估电脑上的时间准不准；没有或等超时了不填。 */
  serverTime?: number
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
    body: { local_token_list: knownTokens.slice(0, 1), bot_spam_business_data: weixinVerifyPinBusinessData },
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

/**
 * 扫码结果要不要客户输手机微信上显示的那串数字。腾讯 openclaw-weixin 3.0.0-beta-0 多了一种
 * confirmed_but_need_verifycode（手机上点了确认，但还要输数字），并改成状态名里含 need_verifycode 的
 * 一律要输（它的 statusNeedsVerifyCode）；腾讯说明里还写了以后绑定都会要这串数字。只认 need_verifycode
 * 这一个名字的话，新状态会被当成看不懂，客户就只看到「微信扫码登录失败」。
 *
 * A "confirmed_but_…" answer is deliberately not treated as confirmed, even if
 * it already carries a bot_token: the credential is only taken from a plain
 * "confirmed" that follows the accepted code, the same as the reference plugin,
 * so the phone PIN check WeChat asked for cannot be skipped.
 */
export function weixinStatusNeedsVerifyCode(status: string): boolean {
  return status.includes('need_verifycode')
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
  if (typeof payload.status === 'string' && weixinStatusNeedsVerifyCode(payload.status)) return { status: 'need-verify-code' }
  switch (payload.status) {
    case 'wait':
      return { status: 'wait' }
    case 'scaned':
      return { status: 'scanned' }
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

/** 钥匙认成 32 位小写十六进制；认不出返回 null。 */
export function normalizeWeixinAesKey(itemKey: unknown, mediaKey: unknown): string | null {
  if (typeof itemKey === 'string' && /^[0-9a-fA-F]{32}$/.test(itemKey.trim())) return itemKey.trim().toLowerCase()
  if (typeof mediaKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(mediaKey.trim())) return null
  const decoded = Buffer.from(mediaKey.trim(), 'base64')
  if (decoded.length === 16) return decoded.toString('hex')
  const ascii = decoded.toString('latin1')
  return decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii) ? ascii.toLowerCase() : null
}

function imageRefOf(item: Record<string, unknown>): WeixinImageRef | null {
  const image = isRecord(item.image_item) ? item.image_item : null
  const media = image && isRecord(image.media) ? image.media : null
  if (!image || !media) return null
  const query = typeof media.encrypt_query_param === 'string' ? media.encrypt_query_param.trim() : ''
  if (!query || query.length > maxEncryptQueryParamLength || !/^[\x21-\x7e]+$/.test(query)) return null
  return { encryptQueryParam: query, aesKeyHex: normalizeWeixinAesKey(image.aeskey, media.aes_key) }
}

function contentOfItems(items: unknown[]): { text: string | null; images: WeixinImageRef[]; hasMedia: boolean } {
  let text: string | null = null
  const images: WeixinImageRef[] = []
  let hasMedia = false
  for (const item of items) {
    if (!isRecord(item)) continue
    const type = optionalInteger(item.type)
    if (type === weixinItemText && isRecord(item.text_item) && typeof item.text_item.text === 'string') {
      text ??= item.text_item.text
      continue
    }
    // 微信自带语音转文字，转出来了就当文字用。
    if (type === weixinItemVoice && isRecord(item.voice_item) && typeof item.voice_item.text === 'string' && item.voice_item.text.trim()) {
      text ??= item.voice_item.text
      continue
    }
    if (type === weixinItemImage) {
      const ref = imageRefOf(item)
      // 是图但看不懂放在哪儿：交给底座当一张取不到的图，手机上说「没取到」，别说「只支持文字和图片」。
      if (images.length < maxImagesPerMessage) images.push(ref ?? { encryptQueryParam: '', aesKeyHex: null })
      continue
    }
    if (type !== null) hasMedia = true
  }
  return { text, images, hasMedia }
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
  const { text, images, hasMedia } = contentOfItems(items)
  return {
    messageId,
    fromUserId,
    groupId: optionalString(value.group_id, 256),
    messageType: optionalInteger(value.message_type) ?? 0,
    createdAt: optionalInteger(value.create_time_ms),
    contextToken: optionalString(value.context_token, 4096),
    text,
    images,
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
    ...(response.serverTime !== undefined ? { serverTime: response.serverTime } : {}),
  }
}

export function buildWeixinClientId(): string {
  return `xingmang-weixin-${randomBytes(8).toString('hex')}`
}

/**
 * 从腾讯图片服务器取一张图、解开（YF-14）：AES-128-ECB，PKCS#7 补齐，照 openclaw-weixin。只去
 * weixinCdnOrigin，最多读 maxBytes 再加一个块；解开以后比 maxBytes 大也不要。不抛，失败按原因交回。
 */
export async function downloadWeixinImage(
  fetchImpl: typeof fetch,
  ref: WeixinImageRef,
  maxBytes: number,
): Promise<RemoteImageFetchResult & { failure?: string }> {
  if (!ref.encryptQueryParam) return { ok: false, reason: 'failed', failure: 'no-location' }
  let response
  try {
    response = await requestRemoteBytes({
      fetch: fetchImpl,
      url: `${weixinCdnOrigin}/c2c/download?encrypted_query_param=${encodeURIComponent(ref.encryptQueryParam)}`,
      allowedOrigins: [weixinCdnOrigin],
      method: 'GET',
      timeoutMs: imageTimeoutMs,
      maxResponseBytes: maxBytes + 16,
      label: '微信',
    })
  } catch (error) {
    if (error instanceof RemoteHttpError && error.reason === 'oversize') return { ok: false, reason: 'too-large' }
    return { ok: false, reason: 'failed', failure: error instanceof RemoteHttpError ? error.reason : 'unknown' }
  }
  if (!response.ok) return { ok: false, reason: 'failed', failure: `status-${response.status}` }
  let bytes: Buffer = response.bytes
  if (ref.aesKeyHex) {
    try {
      const decipher = createDecipheriv('aes-128-ecb', Buffer.from(ref.aesKeyHex, 'hex'), null)
      bytes = Buffer.concat([decipher.update(response.bytes), decipher.final()])
    } catch {
      return { ok: false, reason: 'failed', failure: 'decrypt' }
    }
  }
  if (bytes.length > maxBytes) return { ok: false, reason: 'too-large' }
  return { ok: true, bytes }
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
