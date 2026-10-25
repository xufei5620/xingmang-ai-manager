import type {
  RemoteChannelAdapter,
  RemoteChannelDependencies,
  RemoteChannelHandlers,
  RemoteChannelStatus,
  RemoteInbound,
  RemoteOutbound,
  RemotePeer,
} from './codex-remote-channel'
import { RemoteHttpError } from './codex-remote-http'
import {
  WeixinIlinkError,
  fetchWeixinUpdates,
  isWeixinUserMessage,
  notifyWeixinLifecycle,
  sendWeixinText,
  weixinTextLimit,
  type WeixinIlinkContext,
  type WeixinInboundMessage,
} from './codex-remote-weixin-api'
import { decodeWeixinCredential, type WeixinCredential } from './codex-remote-weixin-credential'

// 微信渠道：长轮询收消息、发文字。配对、审批、脱敏、陈旧消息都在底座做（codex-remote-channel.ts
// 开头那段）；这里只多守一条：只交回扫码登录的那个微信用户发来的消息，也只往他那里发。

const initialBackoffMs = 2_000
const maximumBackoffMs = 60_000
const sendRetryDelayMs = 1_000
const recentIdLimit = 512
const defaultLongPollMs = 35_000

export interface WeixinChannelOptions {
  botAgent: string
  /** 测试里换成立即返回的。 */
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, milliseconds)
    timer.unref?.()
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export function nextWeixinBackoffMs(current: number): number {
  return Math.min(maximumBackoffMs, current <= 0 ? initialBackoffMs : current * 2)
}

/**
 * 把一条 iLink 消息换成交给底座的样子；不该交的返回 null。机器人自己发出去的那条也会从长轮询
 * 里回来，只留用户发的。
 */
export function toWeixinRemoteInbound(message: WeixinInboundMessage, ownerUserId: string | null): RemoteInbound | null {
  if (!isWeixinUserMessage(message)) return null
  if (ownerUserId && message.fromUserId !== ownerUserId) return null
  const base = {
    peer: { channel: 'weixin' as const, userId: message.fromUserId },
    direct: message.groupId === null,
    ...(message.contextToken ? { replyContext: message.contextToken } : {}),
    ...(message.createdAt !== null && message.createdAt > 0 ? { sentAt: message.createdAt } : {}),
  }
  if (message.text !== null && message.text.trim()) {
    return { ...base, kind: 'text', messageId: message.messageId, text: message.text }
  }
  if (message.hasMedia) return { ...base, kind: 'unsupported', messageId: message.messageId }
  return null
}

function isTransientSendFailure(error: unknown): boolean {
  if (error instanceof RemoteHttpError) return error.reason === 'network' || error.reason === 'timeout'
  if (error instanceof WeixinIlinkError) {
    return error.reason === 'rejected' && error.code !== undefined && (error.code === -1 || error.code >= 500)
  }
  return false
}

function failureReason(error: unknown): string {
  if (error instanceof WeixinIlinkError || error instanceof RemoteHttpError) return error.reason
  return 'unknown'
}

// 收消息失败后都会自己重试，界面上只说批过的那一句（微信-界面文字.md 第 20 条），原因进日志。
const pollRetryMessage = '连不上微信，正在重试'

export function createWeixinRemoteChannel(dependencies: RemoteChannelDependencies, options: WeixinChannelOptions): RemoteChannelAdapter {
  const sleep = options.sleep ?? abortableSleep
  let controller: AbortController | null = null
  let loop: Promise<void> | null = null
  let credential: WeixinCredential | null = null
  let handlers: RemoteChannelHandlers | null = null
  let lastStatus: RemoteChannelStatus | null = null
  const recentIds: string[] = []
  const recentIdSet = new Set<string>()

  function context(signal: AbortSignal, origin: string): WeixinIlinkContext {
    return { fetch: dependencies.fetch, origin, botAgent: options.botAgent, signal }
  }

  function report(status: RemoteChannelStatus): void {
    if (lastStatus && lastStatus.state === status.state && lastStatus.message === status.message) return
    lastStatus = status
    handlers?.onStatus(status)
  }

  function remember(messageId: string): boolean {
    if (recentIdSet.has(messageId)) return false
    recentIdSet.add(messageId)
    recentIds.push(messageId)
    while (recentIds.length > recentIdLimit) {
      const dropped = recentIds.shift()
      if (dropped !== undefined) recentIdSet.delete(dropped)
    }
    return true
  }

  function deliver(message: WeixinInboundMessage, owner: string | null): void {
    const inbound = toWeixinRemoteInbound(message, owner)
    if (!inbound) {
      if (isWeixinUserMessage(message)) {
        dependencies.log('info', 'weixin-inbound-ignored', { reason: owner && message.fromUserId !== owner ? 'not-owner' : 'empty' })
      }
      return
    }
    if (!remember(message.messageId)) return
    handlers?.onInbound(inbound)
  }

  async function run(active: WeixinCredential, signal: AbortSignal): Promise<void> {
    try {
      await notifyWeixinLifecycle(context(signal, active.origin), active.token, 'start')
    } catch (error) {
      if (signal.aborted) return
      // 只是打个招呼，失败不耽误收消息；令牌过期留给下面的长轮询报。
      dependencies.log('warn', 'weixin-notify-start-failed', { reason: failureReason(error) })
    }
    let cursor = ''
    let longPollMs = defaultLongPollMs
    let backoffMs = 0
    while (!signal.aborted) {
      try {
        const updates = await fetchWeixinUpdates(context(signal, active.origin), active.token, cursor, longPollMs)
        if (signal.aborted) return
        cursor = updates.cursor
        longPollMs = updates.nextLongPollMs
        backoffMs = 0
        report({ state: 'connected' })
        for (const message of updates.messages) deliver(message, active.ownerUserId)
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof WeixinIlinkError && (error.reason === 'session-expired' || error.reason === 'refused')) {
          dependencies.log('warn', 'weixin-login-expired', { reason: error.reason, code: error.code ?? null })
          report({ state: 'needs-login', message: '微信这边的登录已经过期，请在电脑上重新扫码' })
          return
        }
        backoffMs = nextWeixinBackoffMs(backoffMs)
        dependencies.log('warn', 'weixin-poll-failed', { reason: failureReason(error), retryInMs: backoffMs })
        report({ state: 'error', message: pollRetryMessage })
        await sleep(backoffMs, signal)
      }
    }
  }

  async function loadCredential(): Promise<WeixinCredential | null> {
    credential = decodeWeixinCredential(await dependencies.readCredential())
    return credential
  }

  async function sendOnce(active: WeixinCredential, peer: RemotePeer, text: string, contextToken: string | null): Promise<void> {
    const signal = new AbortController().signal
    try {
      await sendWeixinText(context(signal, active.origin), active.token, peer.userId, text, contextToken)
    } catch (error) {
      // 对方很久没说话，context_token 过期了：去掉它再发一次，腾讯插件也是不带它照发。
      if (error instanceof WeixinIlinkError && error.reason === 'stale-context' && contextToken) {
        await sendWeixinText(context(signal, active.origin), active.token, peer.userId, text, null)
        return
      }
      throw error
    }
  }

  return {
    id: 'weixin',
    capabilities: { approvalButtons: false, maxTextLength: weixinTextLimit },

    async start(nextHandlers) {
      if (controller) return
      handlers = nextHandlers
      lastStatus = null
      const active = await loadCredential()
      if (!active) {
        report({ state: 'needs-login', message: '还没用微信扫码登录' })
        return
      }
      const current = new AbortController()
      controller = current
      report({ state: 'connecting' })
      loop = run(active, current.signal).finally(() => {
        if (controller === current) controller = null
        loop = null
      })
    },

    async stop() {
      const current = controller
      const running = loop
      controller = null
      if (!current) return
      current.abort()
      await running?.catch(() => undefined)
      const active = credential
      if (active) {
        const farewell = new AbortController()
        await notifyWeixinLifecycle(context(farewell.signal, active.origin), active.token, 'stop').catch((error: unknown) => {
          dependencies.log('warn', 'weixin-notify-stop-failed', { reason: failureReason(error) })
        })
      }
    },

    async send(peer: RemotePeer, message: RemoteOutbound, replyContext?: string) {
      const active = credential ?? await loadCredential()
      if (!active) throw new Error('还没用微信扫码登录')
      if (peer.channel !== 'weixin') throw new Error('不是微信渠道的联系人')
      // 底座只往绑定的人发；这里再挡一道，令牌只给扫码的那个人发消息。
      if (active.ownerUserId && peer.userId !== active.ownerUserId) throw new Error('只能发给扫码登录的那个微信')
      const contextToken = replyContext ?? null
      try {
        await sendOnce(active, peer, message.text, contextToken)
      } catch (error) {
        if (error instanceof WeixinIlinkError && (error.reason === 'session-expired' || error.reason === 'refused')) {
          report({ state: 'needs-login', message: '微信这边的登录已经过期，请在电脑上重新扫码' })
          throw error
        }
        if (!isTransientSendFailure(error)) throw error
        await sleep(sendRetryDelayMs, new AbortController().signal)
        await sendOnce(active, peer, message.text, contextToken)
      }
    },
  }
}
