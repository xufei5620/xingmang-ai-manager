import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildFeishuMessageBody,
  createFeishuRemoteChannel,
  extractFeishuText,
  FeishuAuthError,
  FeishuFragmentCache,
  parseFeishuCredential,
  parseFeishuEndpointResponse,
  parseFeishuEvent,
  requestFeishuTenantToken,
  resolveFeishuSocketUrl,
  serializeFeishuCredential,
  validateFeishuCredentialInput,
  type FeishuSocket,
} from './codex-remote-feishu'
import { decodeFeishuFrame, encodeFeishuFrame, feishuFrameHeader, type FeishuFrame } from './codex-remote-feishu-frame'
import type { RemoteChannelDependencies, RemoteChannelStatus, RemoteInbound } from './codex-remote-channel'

const appId = 'cli_a1b2c3d4e5f6a7b8'
const appSecret = 'S3cretS3cretS3cretS3cretS3cret00'
const socketUrl = 'wss://msg-frontier.feishu.cn/ws/v2?device_id=d1&service_id=321&ticket=t'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function textEvent(overrides: { eventId?: string; chatType?: string; senderType?: string; messageType?: string; content?: string } = {}) {
  return {
    schema: '2.0',
    header: { event_id: overrides.eventId ?? 'ev-1', event_type: 'im.message.receive_v1', create_time: '1761379200000' },
    event: {
      sender: { sender_id: { open_id: 'ou_alice' }, sender_type: overrides.senderType ?? 'user' },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_p2p_alice',
        chat_type: overrides.chatType ?? 'p2p',
        message_type: overrides.messageType ?? 'text',
        content: overrides.content ?? JSON.stringify({ text: ' 帮我跑一下测试 ' }),
        create_time: '1761379200123',
      },
    },
  }
}

function cardEvent(chatId: string, value: Record<string, unknown> = { approval: '2', nonce: 'Zx9_-nonce-0042', decision: 'accept' }) {
  return {
    schema: '2.0',
    header: { event_id: 'ev-card', event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'ou_alice' },
      action: { tag: 'button', value },
      context: { open_message_id: 'om_card', open_chat_id: chatId },
    },
  }
}

function eventFrame(payload: unknown, messageId = 'm-1'): Uint8Array {
  return encodeFeishuFrame({
    seqId: 5n,
    logId: 6n,
    service: 321,
    method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: messageId },
      { key: 'sum', value: '1' },
      { key: 'seq', value: '0' },
    ],
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  })
}

class FakeSocket implements FeishuSocket {
  binaryType = 'blob'
  readyState = 0
  sent: FeishuFrame[] = []
  closed = false
  private listeners = new Map<string, Array<(event: { data: unknown }) => void>>()

  constructor(readonly url: string) {}

  send(data: Uint8Array): void {
    this.sent.push(decodeFeishuFrame(data))
  }

  close(): void {
    this.closed = true
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  emit(type: string, data?: unknown): void {
    if (type === 'open') this.readyState = 1
    if (type === 'close') this.readyState = 3
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }

  deliver(bytes: Uint8Array): void {
    const copy = bytes.slice()
    this.emit('message', copy.buffer)
  }
}

interface Harness {
  deps: RemoteChannelDependencies
  fetch: ReturnType<typeof vi.fn>
  sockets: FakeSocket[]
  statuses: RemoteChannelStatus[]
  inbound: RemoteInbound[]
  logs: string[]
}

function harness(credential: string | null, respond: (url: string, init: RequestInit) => Response): Harness {
  const logs: string[] = []
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => respond(String(input), init ?? {}))
  return {
    fetch: fetchMock,
    sockets: [],
    statuses: [],
    inbound: [],
    logs,
    deps: {
      fetch: fetchMock,
      readCredential: async () => credential,
      writeCredential: async () => undefined,
      log: (_level, event) => { logs.push(event) },
      now: () => Date.now(),
      appVersion: '0.2.21',
    },
  }
}

function defaultRespond(url: string): Response {
  if (url.endsWith('/callback/ws/endpoint')) {
    return json({ code: 0, data: { URL: socketUrl, ClientConfig: { PingInterval: 90, ReconnectNonce: 0 } } })
  }
  if (url.endsWith('/tenant_access_token/internal')) return json({ code: 0, tenant_access_token: 't-1', expire: 7200 })
  if (url.includes('/im/v1/messages')) return json({ code: 0, data: {} })
  return json({ code: 404 }, 404)
}

async function startChannel(h: Harness) {
  const channel = createFeishuRemoteChannel(h.deps, {
    createSocket: (url) => {
      const socket = new FakeSocket(url)
      h.sockets.push(socket)
      return socket
    },
    random: () => 0,
  })
  await channel.start({ onInbound: (message) => h.inbound.push(message), onStatus: (status) => h.statuses.push(status) })
  await vi.waitFor(() => expect(h.sockets).toHaveLength(1))
  return channel
}

afterEach(() => {
  vi.useRealTimers()
})

describe('codex-remote-feishu credentials', () => {
  it('trims and validates what the user pastes', () => {
    expect(validateFeishuCredentialInput(` ${appId} `, `${appSecret}\n`)).toEqual({ appId, appSecret })
    expect(() => validateFeishuCredentialInput('a1b2c3', appSecret)).toThrow('cli_')
    expect(() => validateFeishuCredentialInput(appId, 'short')).toThrow('App Secret')
  })

  it('round-trips the stored credential and rejects junk', () => {
    expect(parseFeishuCredential(serializeFeishuCredential({ appId, appSecret }))).toEqual({ appId, appSecret })
    expect(parseFeishuCredential('{"appId":1}')).toBeNull()
    expect(parseFeishuCredential('not json')).toBeNull()
    expect(parseFeishuCredential(null)).toBeNull()
  })

  it('asks open.feishu.cn for a tenant token and reports bad secrets as an auth error', async () => {
    const ok = vi.fn(async (_input: URL | RequestInfo) => json({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
    const token = await requestFeishuTenantToken(ok, { appId, appSecret }, 1000)
    expect(token).toEqual({ token: 'tok', expiresAt: 1000 + 6900 * 1000 })
    expect(String(ok.mock.calls[0][0])).toBe('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal')
    const bad = vi.fn(async () => json({ code: 10014, msg: 'app secret invalid' }))
    await expect(requestFeishuTenantToken(bad, { appId, appSecret }, 0)).rejects.toBeInstanceOf(FeishuAuthError)
  })

  it('refuses to follow a redirect with the secret', async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }))
    await expect(requestFeishuTenantToken(redirect, { appId, appSecret }, 0)).rejects.toThrow('重定向')
  })
})

describe('codex-remote-feishu endpoint', () => {
  it('accepts only wss URLs on feishu.cn hosts', () => {
    expect(resolveFeishuSocketUrl(socketUrl)).toEqual({ url: socketUrl, serviceId: 321 })
    expect(resolveFeishuSocketUrl('ws://msg-frontier.feishu.cn/ws/v2?service_id=1')).toBeNull()
    expect(resolveFeishuSocketUrl('wss://msg-frontier.feishu.cn.evil.com/ws?service_id=1')).toBeNull()
    expect(resolveFeishuSocketUrl('wss://user:pw@msg-frontier.feishu.cn/ws?service_id=1')).toBeNull()
    expect(resolveFeishuSocketUrl('wss://evilfeishu.cn/ws?service_id=1')).toBeNull()
    expect(resolveFeishuSocketUrl('wss://msg-frontier.feishu.cn/ws?service_id=abc')).toBeNull()
  })

  it('classifies endpoint answers', () => {
    expect(parseFeishuEndpointResponse(200, { code: 514 })).toEqual({ kind: 'auth-failed' })
    expect(parseFeishuEndpointResponse(200, { code: 403 })).toEqual({ kind: 'auth-failed' })
    expect(parseFeishuEndpointResponse(200, { code: 1000040350 })).toEqual({ kind: 'connection-limit' })
    expect(parseFeishuEndpointResponse(200, { code: 1 })).toEqual({ kind: 'retry' })
    expect(parseFeishuEndpointResponse(502, null)).toEqual({ kind: 'retry' })
    expect(parseFeishuEndpointResponse(200, { code: 0, data: { URL: 'wss://elsewhere.example/ws?service_id=1' } })).toEqual({ kind: 'retry' })
    expect(parseFeishuEndpointResponse(200, { code: 0, data: { URL: socketUrl, ClientConfig: { PingInterval: 1 } } }))
      .toMatchObject({ kind: 'ok', serviceId: 321, pingIntervalMs: 10_000 })
  })
})

describe('codex-remote-feishu events', () => {
  it('turns a private text message into inbound text with its send time', () => {
    const context = { p2pChats: new Map<string, string>() }
    const parsed = parseFeishuEvent(textEvent(), context)
    expect(parsed.eventId).toBe('ev-1')
    expect(parsed.inbound).toEqual({
      kind: 'text',
      peer: { channel: 'feishu', userId: 'ou_alice' },
      direct: true,
      replyContext: 'om_1',
      sentAt: 1761379200123,
      messageId: 'om_1',
      text: '帮我跑一下测试',
    })
    expect(context.p2pChats.get('ou_alice')).toBe('oc_p2p_alice')
  })

  it('marks group messages as not direct and ignores bots', () => {
    const context = { p2pChats: new Map<string, string>() }
    expect(parseFeishuEvent(textEvent({ chatType: 'group' }), context).inbound).toMatchObject({ direct: false })
    expect(context.p2pChats.size).toBe(0)
    expect(parseFeishuEvent(textEvent({ senderType: 'app' }), context).inbound).toBeNull()
  })

  it('reports pictures as unsupported and reads rich text', () => {
    const context = { p2pChats: new Map<string, string>() }
    expect(parseFeishuEvent(textEvent({ messageType: 'image', content: '{"image_key":"k"}' }), context).inbound)
      .toMatchObject({ kind: 'unsupported', messageId: 'om_1' })
    const post = JSON.stringify({ title: '', content: [[{ tag: 'text', text: '第一行' }, { tag: 'at', user_id: 'x' }], [{ tag: 'text', text: '第二行' }]] })
    expect(extractFeishuText('post', post)).toBe('第一行\n第二行')
    expect(extractFeishuText('post', JSON.stringify({ zh_cn: { title: '标题', content: [[{ tag: 'text', text: '正文' }]] } }))).toBe('标题\n正文')
    expect(extractFeishuText('text', '{"text":"   "}')).toBeNull()
  })

  it('trusts a card click as direct only from the clicker\'s own private chat', () => {
    const context = { p2pChats: new Map([['ou_alice', 'oc_p2p_alice']]) }
    expect(parseFeishuEvent(cardEvent('oc_p2p_alice'), context).inbound).toEqual({
      kind: 'approval',
      peer: { channel: 'feishu', userId: 'ou_alice' },
      direct: true,
      approvalId: '2',
      nonce: 'Zx9_-nonce-0042',
      decision: 'accept',
    })
    expect(parseFeishuEvent(cardEvent('oc_group'), context).inbound).toMatchObject({ direct: false })
    expect(parseFeishuEvent(cardEvent('oc_p2p_alice'), { p2pChats: new Map() }).inbound).toMatchObject({ direct: false })
  })

  it('ignores card clicks whose value is not ours', () => {
    const event = cardEvent('oc_p2p_alice', { approval: '../1', nonce: 'Zx9_-nonce-0042', decision: 'accept' })
    expect(parseFeishuEvent(event, { p2pChats: new Map() }).inbound).toBeNull()
  })

  it('hands over a card click without a usable nonce so the core can call the card stale', () => {
    const context = { p2pChats: new Map([['ou_alice', 'oc_p2p_alice']]) }
    for (const nonce of [undefined, '', 'short', 'has space in it', '<script>', 'x'.repeat(65), 42]) {
      const event = cardEvent('oc_p2p_alice', { approval: '2', decision: 'accept', ...(nonce === undefined ? {} : { nonce }) })
      expect(parseFeishuEvent(event, context).inbound).toMatchObject({ kind: 'approval', approvalId: '2', nonce: null })
    }
  })
})

describe('codex-remote-feishu fragments', () => {
  it('merges fragments in any order', () => {
    const cache = new FeishuFragmentCache()
    const encoder = new TextEncoder()
    expect(cache.merge('m', 2, 1, encoder.encode('world'), 0)).toBeNull()
    expect(new TextDecoder().decode(cache.merge('m', 2, 0, encoder.encode('hello '), 1) ?? new Uint8Array())).toBe('hello world')
  })

  it('rejects bad metadata and forgets stale fragments', () => {
    const cache = new FeishuFragmentCache()
    expect(() => cache.merge('m', 0, 0, new Uint8Array(), 0)).toThrow()
    expect(() => cache.merge('m', 2, 2, new Uint8Array(), 0)).toThrow()
    expect(() => cache.merge('m', 1000, 0, new Uint8Array(), 0)).toThrow()
    cache.merge('old', 2, 0, new Uint8Array([1]), 0)
    expect(cache.merge('old', 2, 1, new Uint8Array([2]), 60_000)).toBeNull()
  })
})

describe('codex-remote-feishu outbound', () => {
  it('sends text as a text message and approvals as a card with two buttons', () => {
    const peer = { channel: 'feishu' as const, userId: 'ou_alice' }
    expect(buildFeishuMessageBody(peer, { kind: 'text', text: '你好' })).toEqual({
      receive_id: 'ou_alice',
      msg_type: 'text',
      content: '{"text":"你好"}',
    })
    const body = buildFeishuMessageBody(peer, {
      kind: 'approval',
      request: { approvalId: '3', nonce: 'nonce-of-three', kind: 'command', summary: 'npm test' },
      text: 'Codex 想运行命令（第 3 条）：\nnpm test',
    })
    expect(body.msg_type).toBe('interactive')
    const card = JSON.parse(String(body.content)) as { elements: Array<{ tag: string; actions?: Array<{ value: unknown }> }> }
    const actions = card.elements.find((element) => element.tag === 'action')?.actions ?? []
    expect(actions.map((action) => action.value)).toEqual([
      { approval: '3', nonce: 'nonce-of-three', decision: 'accept' },
      { approval: '3', nonce: 'nonce-of-three', decision: 'decline' },
    ])
  })
})

describe('codex-remote-feishu channel', () => {
  it('asks for credentials when none are saved', async () => {
    const h = harness(null, defaultRespond)
    const channel = createFeishuRemoteChannel(h.deps)
    const statuses: RemoteChannelStatus[] = []
    await channel.start({ onInbound: () => undefined, onStatus: (status) => statuses.push(status) })
    expect(statuses.at(-1)?.state).toBe('needs-login')
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('connects, pings, acknowledges events and hands them to the core once', async () => {
    const h = harness(serializeFeishuCredential({ appId, appSecret }), defaultRespond)
    const channel = await startChannel(h)
    const socket = h.sockets[0]
    expect(socket.url).toBe(socketUrl)
    expect(socket.binaryType).toBe('arraybuffer')
    const endpointBody = JSON.parse(String(h.fetch.mock.calls[0][1].body)) as Record<string, string>
    expect(endpointBody).toEqual({ AppID: appId, AppSecret: appSecret })

    socket.emit('open')
    expect(h.statuses.at(-1)).toEqual({ state: 'connected' })
    expect(feishuFrameHeader(socket.sent[0], 'type')).toBe('ping')
    expect(socket.sent[0].service).toBe(321)

    socket.deliver(eventFrame(textEvent()))
    socket.deliver(eventFrame(textEvent(), 'm-2'))
    expect(h.inbound).toHaveLength(1)
    expect(h.inbound[0]).toMatchObject({ kind: 'text', text: '帮我跑一下测试' })
    const acks = socket.sent.filter((frame) => feishuFrameHeader(frame, 'type') === 'event')
    expect(acks).toHaveLength(2)
    expect(acks[0].seqId).toBe(5n)
    expect(feishuFrameHeader(acks[0], 'biz_rt')).toBe('0')
    expect(JSON.parse(new TextDecoder().decode(acks[0].payload))).toMatchObject({ code: 200 })
    await channel.stop()
    expect(socket.closed).toBe(true)
    expect(h.statuses.at(-1)).toEqual({ state: 'stopped' })
  })

  it('never logs message text', async () => {
    const h = harness(serializeFeishuCredential({ appId, appSecret }), defaultRespond)
    const channel = await startChannel(h)
    h.sockets[0].emit('open')
    h.sockets[0].deliver(eventFrame(textEvent()))
    expect(h.logs.join(' ')).not.toContain('测试')
    await channel.stop()
  })

  it('sends messages with a cached tenant token and refreshes it once when Feishu says it expired', async () => {
    let sends = 0
    const h = harness(serializeFeishuCredential({ appId, appSecret }), (url) => {
      if (url.includes('/im/v1/messages')) {
        sends += 1
        return sends === 2 ? json({ code: 99991663, msg: 'token invalid' }) : json({ code: 0 })
      }
      return defaultRespond(url)
    })
    const channel = await startChannel(h)
    const peer = { channel: 'feishu' as const, userId: 'ou_alice' }
    await channel.send(peer, { kind: 'text', text: '一' })
    await channel.send(peer, { kind: 'text', text: '二' })
    const tokenCalls = h.fetch.mock.calls.filter(([url]) => String(url).endsWith('/tenant_access_token/internal'))
    expect(tokenCalls).toHaveLength(2)
    const sendCall = h.fetch.mock.calls.find(([url]) => String(url).includes('/im/v1/messages'))
    expect(String(sendCall?.[0])).toBe('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id')
    expect((sendCall?.[1].headers as Record<string, string>).Authorization).toBe('Bearer t-1')
    expect(sends).toBe(3)
    await channel.stop()
  })

  it('stops with needs-login when the endpoint rejects the app', async () => {
    const h = harness(serializeFeishuCredential({ appId, appSecret }), (url) =>
      url.endsWith('/callback/ws/endpoint') ? json({ code: 514, msg: 'auth failed' }) : defaultRespond(url))
    const channel = createFeishuRemoteChannel(h.deps, { createSocket: (url) => new FakeSocket(url) })
    await channel.start({ onInbound: () => undefined, onStatus: (status) => h.statuses.push(status) })
    await vi.waitFor(() => expect(h.statuses.at(-1)?.state).toBe('needs-login'))
  })

  it('reconnects with backoff after the socket closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness(serializeFeishuCredential({ appId, appSecret }), defaultRespond)
    const channel = await startChannel(h)
    h.sockets[0].emit('open')
    h.sockets[0].emit('close')
    expect(h.statuses.at(-1)).toEqual({ state: 'connecting', message: '连不上飞书，正在重试。' })
    await vi.advanceTimersByTimeAsync(2000)
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2))
    h.sockets[1].emit('open')
    expect(h.statuses.at(-1)).toEqual({ state: 'connected' })
    // Frames from the replaced socket are ignored.
    h.sockets[0].deliver(eventFrame(textEvent()))
    expect(h.inbound).toHaveLength(0)
    await channel.stop()
  })

  it('drops the connection when no pong arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness(serializeFeishuCredential({ appId, appSecret }), defaultRespond)
    const channel = await startChannel(h)
    h.sockets[0].emit('open')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.sockets[0].closed).toBe(true)
    expect(h.logs).toContain('feishu.pong-timeout')
    await channel.stop()
  })
})
