import { randomUUID } from 'node:crypto'
import type { RemoteChannelLogDetail, RemoteChannelLogLevel } from './codex-remote-channel'
import { RemoteHttpError } from './codex-remote-http'
import {
  WeixinIlinkError,
  fetchWeixinLoginQrCode,
  pollWeixinLoginStatus,
  weixinConfirmedWithoutLoginMessage,
  weixinIlinkDefaultOrigin,
  type WeixinIlinkContext,
} from './codex-remote-weixin-api'
import { buildWeixinAccountLabel, decodeWeixinCredential, encodeWeixinCredential } from './codex-remote-weixin-credential'
import type { WeixinLoginPhase, WeixinLoginSnapshot } from './codex-remote-weixin-login-state'

// 微信扫码登录。界面每次调 poll 等一轮长轮询（最多四十来秒），拿到新状态再接着调；同一时间只有
// 一次登录，新的一次 start 或 poll 会顶掉在等的那一次。
//
// The login link and the bot token never reach the renderer: the QR content is
// drawn into a PNG data URL here, and the token goes straight into the
// encrypted credential store (I3).

const qrLifetimeMs = 5 * 60_000
const loginDeadlineMs = 8 * 60_000
const maximumQrRefreshes = 3
const transientRetryMs = 2_000

export interface WeixinLoginDependencies {
  fetch: typeof fetch
  botAgent: string
  now(): number
  readCredential(): Promise<string | null>
  /**
   * 存凭据。verifiedOwner：这次扫码微信要过手机上那串数字并且输对了时，扫码人的编号，主进程直接把他记成
   * 绑定的人（YF-5，yoyo 2026-11-11 亲手打字「微信免配对码，加条件做」）；没过数字是 null，照旧要配对码。
   */
  saveCredential(value: string, accountLabel: string, verifiedOwner: string | null): Promise<void>
  /**
   * 服务端认出是本机原来那份登录（already-bound）时调：凭据没换，渠道还停在「需要重新登录」的话要重连一次（YKS-6）。
   */
  reconnectIfLoggedOut(): Promise<void>
  /** 把二维码内容画成 data URL。 */
  renderQrCode(content: string): Promise<string>
  log(level: RemoteChannelLogLevel, event: string, detail?: RemoteChannelLogDetail): void
}

export interface WeixinLoginController {
  start(): Promise<WeixinLoginSnapshot>
  poll(loginId: string, verifyCode?: string | null): Promise<WeixinLoginSnapshot>
  cancel(loginId?: string): void
}

interface ActiveLogin {
  id: string
  qrcode: string
  origin: string
  startedAt: number
  qrIssuedAt: number
  refreshes: number
  phase: WeixinLoginPhase
  pendingVerifyCode: string | null
  /** 这张二维码上微信要过手机上那串数字（need_verifycode）。 */
  pinAsked: boolean
  /** 要过以后带着数字问回来，微信不再要数字了（回了已扫码或直接确认）：数字输对了。 */
  pinAccepted: boolean
  knownTokens: string[]
  poll: AbortController | null
}

/** 手机上显示的那串数字；只收数字，免得拼进查询串的东西不是数字。 */
export function normalizeWeixinVerifyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, '')
  return /^\d{1,8}$/.test(trimmed) ? trimmed : null
}

const genericLoginFailure = '微信扫码登录失败，请重试'

/**
 * 上屏的字只用 yoyo 10-25 批过的那几句（微信-界面文字.md 第 27、29、30 条）：拿不到二维码时带上
 * HTTP 状态码，扫码成功却没给登录信息单说一句，其余一律是通用的那句。
 */
function failureText(error: unknown): string {
  if (error instanceof WeixinIlinkError) {
    if (error.reason === 'invalid-response' && error.message === weixinConfirmedWithoutLoginMessage) return error.message
    if (error.reason === 'rejected' && /^获取微信二维码失败，微信服务返回 HTTP \d+$/.test(error.message)) return error.message
  }
  return genericLoginFailure
}

export function createWeixinLoginController(dependencies: WeixinLoginDependencies): WeixinLoginController {
  let active: ActiveLogin | null = null

  function context(origin: string, signal: AbortSignal): WeixinIlinkContext {
    return { fetch: dependencies.fetch, origin, botAgent: dependencies.botAgent, signal }
  }

  function snapshot(login: ActiveLogin, extra: Partial<WeixinLoginSnapshot> = {}): WeixinLoginSnapshot {
    return { loginId: login.id, phase: login.phase, retryAfterMs: 0, ...extra }
  }

  function finish(login: ActiveLogin, phase: WeixinLoginPhase, message?: string): WeixinLoginSnapshot {
    login.phase = phase
    login.poll?.abort()
    if (active === login) active = null
    return snapshot(login, message ? { message } : {})
  }

  async function issueQrCode(login: ActiveLogin, signal: AbortSignal): Promise<WeixinLoginSnapshot> {
    // 换二维码一律回默认主机：上一张扫到一半被换过主机，那是上一张的事。
    const qr = await fetchWeixinLoginQrCode(context(weixinIlinkDefaultOrigin, signal), login.knownTokens)
    const image = await dependencies.renderQrCode(qr.content)
    login.qrcode = qr.qrcode
    login.origin = weixinIlinkDefaultOrigin
    login.qrIssuedAt = dependencies.now()
    login.phase = 'waiting-scan'
    login.pendingVerifyCode = null
    // 新的一张二维码重新算：上一张输对过数字，不等于这一张也过了。
    login.pinAsked = false
    login.pinAccepted = false
    return snapshot(login, { qrImage: image, expiresAt: login.qrIssuedAt + qrLifetimeMs })
  }

  async function refreshOrFail(login: ActiveLogin, signal: AbortSignal, message: string, giveUp: string): Promise<WeixinLoginSnapshot> {
    if (login.refreshes >= maximumQrRefreshes) return finish(login, 'failed', giveUp)
    login.refreshes += 1
    const next = await issueQrCode(login, signal)
    return { ...next, message }
  }

  async function confirm(
    login: ActiveLogin,
    status: { token: string; botId: string; origin: string | null; ownerUserId: string | null },
  ): Promise<WeixinLoginSnapshot> {
    // 免配对码只认这一种（YF-5）：微信要过手机上那串数字、输对了，而且告诉了我们是谁扫的。扫码本身只证明有人拿到了
    // 二维码图（截图转给别人也能扫）；数字出在扫码人的手机上、要输进这台电脑，才证明坐在电脑前的人看得到那部手机。
    const verifiedOwner = login.pinAccepted ? status.ownerUserId : null
    if (!status.origin) dependencies.log('warn', 'weixin-login-origin-fallback', {})
    const value = encodeWeixinCredential({
      version: 1,
      token: status.token,
      botId: status.botId,
      origin: status.origin ?? weixinIlinkDefaultOrigin,
      ownerUserId: status.ownerUserId,
    })
    try {
      await dependencies.saveCredential(value, buildWeixinAccountLabel(status.botId), verifiedOwner)
    } catch (error) {
      // 存不下（比如这台电脑没法安全保存密码）：底座给的是能上屏的中文，原样交给界面。
      dependencies.log('warn', 'weixin-login-save-failed', {})
      return finish(login, 'failed', error instanceof Error && error.message ? error.message : '微信登录信息没能保存，请重试')
    }
    dependencies.log('info', 'weixin-login-confirmed', { hasOwner: status.ownerUserId !== null, pinVerified: login.pinAccepted, boundByScan: verifiedOwner !== null })
    const done = finish(login, 'confirmed')
    return verifiedOwner ? { ...done, boundByScan: true } : done
  }

  async function confirmAlreadyBound(login: ActiveLogin): Promise<WeixinLoginSnapshot> {
    // 重连没成（比如这一下 Codex 被卸了）也算登录好了：登录本身没问题，渠道为什么没连上卡片上另有一句。
    try {
      await dependencies.reconnectIfLoggedOut()
    } catch {
      dependencies.log('warn', 'weixin-login-reconnect-failed', {})
    }
    return finish(login, 'confirmed', '这个微信已经连着这台电脑了')
  }

  async function pollOnce(login: ActiveLogin, signal: AbortSignal): Promise<WeixinLoginSnapshot> {
    const codeSent = login.pendingVerifyCode !== null
    const status = await pollWeixinLoginStatus(context(login.origin, signal), login.qrcode, login.pendingVerifyCode)
    if (signal.aborted || active !== login) return snapshot(login)
    // 带着数字问、微信没再要数字（腾讯插件也是这么认的：带着数字回 scaned 就是对了）。只有微信先要过才算，
    // 免得界面没被要就塞一串数字、微信根本没看它，也被当成过了数字。
    if (codeSent && login.pinAsked && (status.status === 'scanned' || status.status === 'confirmed')) login.pinAccepted = true
    switch (status.status) {
      case 'wait':
        return snapshot(login)
      case 'scanned':
        login.pendingVerifyCode = null
        login.phase = 'scanned'
        return snapshot(login)
      case 'redirect':
        if (status.origin) login.origin = status.origin
        else dependencies.log('warn', 'weixin-login-redirect-refused', {})
        login.phase = 'scanned'
        return snapshot(login)
      case 'need-verify-code':
        login.phase = login.pendingVerifyCode ? 'verify-code-wrong' : 'need-verify-code'
        login.pendingVerifyCode = null
        login.pinAsked = true
        login.pinAccepted = false
        return snapshot(login)
      case 'verify-code-blocked':
        return refreshOrFail(login, signal, '数字输错太多次，已换了一张二维码，请重新扫', '数字输错太多次，请过一会儿再试')
      case 'expired':
        return refreshOrFail(login, signal, '二维码过期了，已换了一张，请重新扫', '二维码过期太多次，请重新开始')
      case 'already-bound':
        // 我们带去的就是本机已有的令牌：服务端说这个微信已经连着这台，原来的登录照旧能用。
        if (login.knownTokens.length > 0) return confirmAlreadyBound(login)
        return finish(login, 'failed', genericLoginFailure)
      case 'confirmed':
        return confirm(login, status)
    }
  }

  return {
    async start() {
      if (active) finish(active, 'cancelled')
      const existing = decodeWeixinCredential(await dependencies.readCredential())
      const startedAt = dependencies.now()
      const login: ActiveLogin = {
        id: randomUUID(),
        qrcode: '',
        origin: weixinIlinkDefaultOrigin,
        startedAt,
        qrIssuedAt: startedAt,
        refreshes: 1,
        phase: 'waiting-scan',
        pendingVerifyCode: null,
        pinAsked: false,
        pinAccepted: false,
        knownTokens: existing ? [existing.token] : [],
        poll: null,
      }
      active = login
      const controller = new AbortController()
      login.poll = controller
      try {
        return await issueQrCode(login, controller.signal)
      } catch (error) {
        dependencies.log('warn', 'weixin-login-qr-failed', { reason: error instanceof WeixinIlinkError || error instanceof RemoteHttpError ? error.reason : 'unknown' })
        return finish(login, 'failed', failureText(error))
      } finally {
        if (login.poll === controller) login.poll = null
      }
    },

    async poll(loginId, verifyCode) {
      const login = active
      if (!login || login.id !== loginId) {
        return { loginId, phase: 'failed', message: genericLoginFailure, retryAfterMs: 0 }
      }
      if (dependencies.now() - login.startedAt > loginDeadlineMs) return finish(login, 'failed', '等太久了，请重新开始扫码')
      if (verifyCode !== undefined && verifyCode !== null) {
        const normalized = normalizeWeixinVerifyCode(verifyCode)
        if (!normalized) return snapshot(login, { message: '请输入手机微信上显示的数字' })
        login.pendingVerifyCode = normalized
      }
      login.poll?.abort()
      const controller = new AbortController()
      login.poll = controller
      try {
        return await pollOnce(login, controller.signal)
      } catch (error) {
        if (controller.signal.aborted || active !== login) return snapshot(login)
        if (error instanceof RemoteHttpError && (error.reason === 'network' || error.reason === 'timeout')) {
          return snapshot(login, { message: '连不上微信，正在重试', retryAfterMs: transientRetryMs })
        }
        dependencies.log('warn', 'weixin-login-poll-failed', { reason: error instanceof WeixinIlinkError || error instanceof RemoteHttpError ? error.reason : 'unknown' })
        return finish(login, 'failed', failureText(error))
      } finally {
        if (login.poll === controller) login.poll = null
      }
    },

    cancel(loginId) {
      if (!active || (loginId !== undefined && active.id !== loginId)) return
      finish(active, 'cancelled')
    },
  }
}
