import { resolveWeixinIlinkOrigin } from './codex-remote-weixin-api'

// 微信扫码登录拿到的东西。整份交给底座用 safeStorage 加密落盘（codex-remote 的
// readCredential / writeCredential），这里只管编码和读回时的校验。

export interface WeixinCredential {
  version: 1
  /** iLink 的机器人令牌，等同于这个微信遥控入口的密码。 */
  token: string
  botId: string
  origin: string
  /** 扫码的那个微信用户。只认他发来的消息；老协议不给时为 null，只靠底座的配对。 */
  ownerUserId: string | null
}

export function encodeWeixinCredential(credential: WeixinCredential): string {
  return JSON.stringify(credential)
}

/** 读不懂、缺字段、主机不在 weixin.qq.com 下的一律当没登录。 */
export function decodeWeixinCredential(text: string | null): WeixinCredential | null {
  if (!text || text.length > 16 * 1024) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.version !== 1) return null
  const token = typeof record.token === 'string' && record.token.trim() ? record.token.trim() : null
  const botId = typeof record.botId === 'string' && record.botId.trim() ? record.botId.trim() : null
  const origin = resolveWeixinIlinkOrigin(record.origin)
  if (!token || !botId || !origin) return null
  const ownerUserId = typeof record.ownerUserId === 'string' && record.ownerUserId.trim() ? record.ownerUserId.trim() : null
  return { version: 1, token, botId, origin, ownerUserId }
}

/** 界面上认得出是哪一个的非机密字样：机器人编号的末四位。 */
export function buildWeixinAccountLabel(botId: string): string {
  const head = botId.split('@')[0] ?? botId
  const tail = head.replace(/[^0-9A-Za-z]/g, '').slice(-4)
  return tail ? `ClawBot ${tail}` : 'ClawBot'
}
