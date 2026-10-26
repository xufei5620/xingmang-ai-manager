import { describe, expect, it, vi } from 'vitest'
import type { RemoteChannelDependencies, RemoteChannelStatus, RemoteInbound } from './codex-remote-channel'
import { createWeixinRemoteChannel, nextWeixinBackoffMs, toWeixinRemoteInbound } from './codex-remote-weixin'
import type { WeixinInboundMessage } from './codex-remote-weixin-api'
import { encodeWeixinCredential } from './codex-remote-weixin-credential'

const owner = 'owner@im.wechat'

function credentialText(ownerUserId: string | null = owner): string {
  return encodeWeixinCredential({ version: 1, token: 'tok', botId: 'b1@im.bot', origin: 'https://ilinkai.weixin.qq.com', ownerUserId })
}

function message(overrides: Partial<WeixinInboundMessage> = {}): WeixinInboundMessage {
  return {
    messageId: '1',
    fromUserId: owner,
    groupId: null,
    messageType: 1,
    createdAt: 1761379200000,
    contextToken: 'ctx',
    text: '看下测试',
    hasMedia: false,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface Harness {
  dependencies: RemoteChannelDependencies
  requests: Array<{ url: string; body: Record<string, unknown> }>
  logs: string[]
}

function harness(credential: string | null, respond: (url: string, body: Record<string, unknown>, index: number) => Response | Promise<Response>): Harness {
  const requests: Harness['requests'] = []
  const logs: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    requests.push({ url, body })
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    return respond(url, body, requests.length - 1)
  }) as typeof fetch
  return {
    requests,
    logs,
    dependencies: {
      fetch: fetchImpl,
      readCredential: async () => credential,
      writeCredential: async () => undefined,
      log: (_level, event) => {
        logs.push(event)
      },
      now: () => 1761379200000,
      appVersion: '0.2.21',
    },
  }
}

function blockUntilAborted(): Promise<Response> {
  return new Promise(() => undefined)
}

describe('toWeixinRemoteInbound', () => {
  it('hands the owner text with its reply context and sent time', () => {
    expect(toWeixinRemoteInbound(message(), owner)).toEqual({
      kind: 'text',
      peer: { channel: 'weixin', userId: owner },
      direct: true,
      replyContext: 'ctx',
      sentAt: 1761379200000,
      messageId: '1',
      text: '看下测试',
    })
  })

  it('drops other senders, the bot echo and empty messages', () => {
    expect(toWeixinRemoteInbound(message({ fromUserId: 'stranger@im.wechat' }), owner)).toBeNull()
    expect(toWeixinRemoteInbound(message({ messageType: 2 }), owner)).toBeNull()
    expect(toWeixinRemoteInbound(message({ text: '   ' }), owner)).toBeNull()
  })

  it('reports media as unsupported and group messages as not direct', () => {
    expect(toWeixinRemoteInbound(message({ text: null, hasMedia: true }), owner)).toMatchObject({ kind: 'unsupported', messageId: '1' })
    expect(toWeixinRemoteInbound(message({ groupId: 'g1' }), owner)).toMatchObject({ direct: false })
  })

  it('leaves owner filtering to pairing when the login gave no owner', () => {
    expect(toWeixinRemoteInbound(message({ fromUserId: 'someone@im.wechat' }), null)).toMatchObject({ kind: 'text' })
  })
})

describe('nextWeixinBackoffMs', () => {
  it('doubles from two seconds up to one minute', () => {
    expect(nextWeixinBackoffMs(0)).toBe(2_000)
    expect(nextWeixinBackoffMs(2_000)).toBe(4_000)
    expect(nextWeixinBackoffMs(40_000)).toBe(60_000)
    expect(nextWeixinBackoffMs(60_000)).toBe(60_000)
  })
})

describe('createWeixinRemoteChannel', () => {
  it('asks for a login when nothing has been scanned yet', async () => {
    const { dependencies, requests } = harness(null, () => jsonResponse({}))
    const statuses: RemoteChannelStatus[] = []
    const channel = createWeixinRemoteChannel(dependencies, { botAgent: 'XingmangAI/test' })
    await channel.start({ onInbound: () => undefined, onStatus: (status) => statuses.push(status) })
    expect(statuses).toEqual([{ state: 'needs-login', message: '还没用微信扫码登录' }])
    expect(requests).toHaveLength(0)
    expect(channel.capabilities).toEqual({ approvalButtons: false, maxTextLength: 4000 })
  })

  it('delivers owner messages once, skipping strangers and redelivered ids', async () => {
    const batch = JSON.stringify({
      ret: 0,
      get_updates_buf: 'next',
      msgs: [
        { message_id: 1, from_user_id: owner, message_type: 1, context_token: 'c1', item_list: [{ type: 1, text_item: { text: '一' } }] },
        { message_id: 2, from_user_id: 'stranger@im.wechat', message_type: 1, item_list: [{ type: 1, text_item: { text: '偷' } }] },
        { message_id: 3, from_user_id: owner, message_type: 2, item_list: [{ type: 1, text_item: { text: '回声' } }] },
      ],
    })
    let pollCount = 0
    const { dependencies, requests, logs } = harness(credentialText(), (url) => {
      if (url.endsWith('/notifystart') || url.endsWith('/notifystop')) return jsonResponse({ ret: 0 })
      pollCount += 1
      return pollCount <= 2 ? jsonResponse(batch) : blockUntilAborted()
    })
    const inbound: RemoteInbound[] = []
    const statuses: RemoteChannelStatus[] = []
    const channel = createWeixinRemoteChannel(dependencies, { botAgent: 'XingmangAI/test' })
    await channel.start({ onInbound: (item) => inbound.push(item), onStatus: (status) => statuses.push(status) })
    await vi.waitFor(() => expect(pollCount).toBe(3))
    expect(inbound).toHaveLength(1)
    expect(inbound[0]).toMatchObject({ kind: 'text', text: '一', replyContext: 'c1', messageId: '1' })
    expect(statuses.map((status) => status.state)).toEqual(['connecting', 'connected'])
    expect(logs).toContain('weixin-inbound-ignored')
    const polls = requests.filter((request) => request.url.endsWith('/getupdates'))
    expect(polls.map((request) => request.body.get_updates_buf)).toEqual(['', 'next', 'next'])
    await channel.stop()
    expect(requests.at(-1)?.url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/msg/notifystop')
  })

  it('stops polling and asks for a new scan when the session expires', async () => {
    let pollCount = 0
    const { dependencies } = harness(credentialText(), (url) => {
      if (url.includes('/msg/notify')) return jsonResponse({ ret: 0 })
      pollCount += 1
      return jsonResponse({ ret: -14 })
    })
    const statuses: RemoteChannelStatus[] = []
    const channel = createWeixinRemoteChannel(dependencies, { botAgent: 'XingmangAI/test' })
    await channel.start({ onInbound: () => undefined, onStatus: (status) => statuses.push(status) })
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe('needs-login'))
    expect(pollCount).toBe(1)
  })

  it('backs off after a network failure and recovers', async () => {
    let pollCount = 0
    const sleeps: number[] = []
    const { dependencies } = harness(credentialText(), (url) => {
      if (url.includes('/msg/notify')) return jsonResponse({ ret: 0 })
      pollCount += 1
      if (pollCount === 1) throw new TypeError('fetch failed')
      if (pollCount === 2) return jsonResponse({ ret: 0, msgs: [] })
      return blockUntilAborted()
    })
    const statuses: RemoteChannelStatus[] = []
    const channel = createWeixinRemoteChannel(dependencies, {
      botAgent: 'XingmangAI/test',
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
      },
    })
    await channel.start({ onInbound: () => undefined, onStatus: (status) => statuses.push(status) })
    await vi.waitFor(() => expect(pollCount).toBe(3))
    expect(sleeps).toEqual([2_000])
    expect(statuses.map((status) => status.state)).toEqual(['connecting', 'error', 'connected'])
    expect(statuses[1].message).toBe('连不上微信，正在重试')
    await channel.stop()
  })

  it('resends without the reply context when it has gone stale', async () => {
    const { dependencies, requests } = harness(credentialText(), (_url, _body, index) => jsonResponse(index === 0 ? { ret: -2 } : { ret: 0 }))
    const channel = createWeixinRemoteChannel(dependencies, { botAgent: 'XingmangAI/test' })
    await channel.send({ channel: 'weixin', userId: owner }, { kind: 'text', text: '完成了' }, 'old-ctx')
    expect(requests).toHaveLength(2)
    expect((requests[0].body.msg as Record<string, unknown>).context_token).toBe('old-ctx')
    expect((requests[1].body.msg as Record<string, unknown>).context_token).toBeUndefined()
  })

  it('sends the plain text of an approval request', async () => {
    const { dependencies, requests } = harness(credentialText(), () => jsonResponse({ ret: 0 }))
    const channel = createWeixinRemoteChannel(dependencies, { botAgent: 'XingmangAI/test' })
    await channel.send({ channel: 'weixin', userId: owner }, {
      kind: 'approval',
      request: { approvalId: '1', nonce: 'nonce-of-one', kind: 'command', summary: 'npm test' },
      text: 'Codex 想运行：npm test\n回「同意 1」或「拒绝 1」',
    }, 'ctx')
    const msg = requests[0].body.msg as { item_list: Array<{ text_item: { text: string } }> }
    expect(msg.item_list[0].text_item.text).toBe('Codex 想运行：npm test\n回「同意 1」或「拒绝 1」')
  })

  it('never sends to anyone but the scanning user', async () => {
    const { dependencies, requests } = harness(credentialText(), () => jsonResponse({ ret: 0 }))
    const channel = createWeixinRemoteChannel(dependencies, { botAgent: 'XingmangAI/test' })
    await expect(channel.send({ channel: 'weixin', userId: 'stranger@im.wechat' }, { kind: 'text', text: 'x' })).rejects.toThrow('扫码登录的那个微信')
    expect(requests).toHaveLength(0)
  })

  it('retries a send once after a transient network failure', async () => {
    const { dependencies, requests } = harness(credentialText(), (_url, _body, index) => {
      if (index === 0) throw new TypeError('fetch failed')
      return jsonResponse({ ret: 0 })
    })
    const channel = createWeixinRemoteChannel(dependencies, { botAgent: 'XingmangAI/test', sleep: async () => undefined })
    await channel.send({ channel: 'weixin', userId: owner }, { kind: 'text', text: 'x' }, 'ctx')
    expect(requests).toHaveLength(2)
  })

  it('can be stopped repeatedly and before it ever started', async () => {
    const { dependencies } = harness(credentialText(), () => jsonResponse({ ret: 0 }))
    const channel = createWeixinRemoteChannel(dependencies, { botAgent: 'XingmangAI/test' })
    await channel.stop()
    await channel.stop()
  })
})
