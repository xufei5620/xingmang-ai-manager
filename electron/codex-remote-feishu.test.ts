import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildFeishuMessageBody,
  buildFeishuProgressCard,
  classifyFeishuSendResponse,
  createFeishuRemoteChannel,
  extractFeishuText,
  FeishuAuthError,
  FeishuFragmentCache,
  feishuProblemMessages,
  parseFeishuCredential,
  parseFeishuEndpointResponse,
  parseFeishuEvent,
  requestFeishuTenantToken,
  resolveFeishuSocketUrl,
  serializeFeishuCredential,
  transientFeishuRequestFailure,
  validateFeishuCredentialInput,
  verifyFeishuCredential,
  type FeishuChannelOptions,
  type FeishuSocket,
} from './codex-remote-feishu'
import { RemoteHttpError } from './codex-remote-http'
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

async function startChannel(h: Harness, options: FeishuChannelOptions = {}) {
  const channel = createFeishuRemoteChannel(h.deps, {
    createSocket: (url) => {
      const socket = new FakeSocket(url)
      h.sockets.push(socket)
      return socket
    },
    random: () => 0,
    ...options,
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
    // Saving the credential shows this on the card too (D23): one fixed sentence, never Feishu's own words.
    await expect(requestFeishuTenantToken(bad, { appId, appSecret }, 0)).rejects.toThrow(feishuProblemMessages.credential)
  })

  // 「飞书保存改」：保存时飞书回的不是正常应答，红条只说批过的那句，HTTP 状态只进日志。
  it('keeps the HTTP status of an odd token answer out of the save failure and logs it instead', async () => {
    const logged: Array<{ event: string; detail?: Record<string, unknown> }> = []
    const deps = (respond: () => Response) => ({
      fetch: vi.fn(async () => respond()),
      now: () => 0,
      log: (_level: string, event: string, detail?: Record<string, string | number | boolean | null>) => { logged.push({ event, detail }) },
    })
    const page = deps(() => new Response('<html>401 Unauthorized</html>', { status: 401, headers: { 'Content-Type': 'text/html' } }))
    const failure = await verifyFeishuCredential(page, { appId, appSecret }).then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('飞书凭据没保存上。请核对 App ID 和 App Secret 有没有填错，再点一次「保存」；还不行请找客服。')
    expect((failure as Error).message).not.toMatch(/HTTP|401/)
    expect(logged).toEqual([{ event: 'feishu.save-token-unexpected', detail: { status: 401 } }])

    // A wrong secret and a good one keep their own outcome.
    await expect(verifyFeishuCredential(deps(() => json({ code: 10014, msg: 'app secret invalid' })), { appId, appSecret }))
      .rejects.toThrow(feishuProblemMessages.credential)
    await expect(verifyFeishuCredential(deps(() => json({ code: 0, tenant_access_token: 'tok', expire: 7200 })), { appId, appSecret }))
      .resolves.toBeUndefined()
    expect(logged).toHaveLength(1)
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

  // YKS-4：哪些回应值得等一会儿再发。照飞书文档：99991400 / 230020 限流、1500 内部错误、230049 正在发送中。
  it('retries only answers Feishu documents as momentary', () => {
    expect(classifyFeishuSendResponse(200, 0)).toBe('sent')
    expect(classifyFeishuSendResponse(400, 99991663)).toBe('token-invalid')
    expect(classifyFeishuSendResponse(400, 99991400)).toBe('retry')
    expect(classifyFeishuSendResponse(400, 230020)).toBe('retry')
    expect(classifyFeishuSendResponse(500, 1500)).toBe('retry')
    expect(classifyFeishuSendResponse(400, 230049)).toBe('retry')
    expect(classifyFeishuSendResponse(502, null)).toBe('retry')
    expect(classifyFeishuSendResponse(429, null)).toBe('retry')
    // Bad parameters, missing permission, a user who blocked the bot: sending again cannot help.
    expect(classifyFeishuSendResponse(400, 230001)).toBe('failed')
    expect(classifyFeishuSendResponse(400, 230053)).toBe('failed')
    expect(classifyFeishuSendResponse(403, null)).toBe('failed')
  })

  it('treats only a lost or timed-out request as worth sending again', () => {
    expect(transientFeishuRequestFailure(new RemoteHttpError('连不上飞书，请检查网络', 'network'))).toBe('network')
    expect(transientFeishuRequestFailure(new RemoteHttpError('飞书请求超时', 'timeout'))).toBe('timeout')
    expect(transientFeishuRequestFailure(new RemoteHttpError('飞书请求被重定向，已拒绝', 'redirected'))).toBeNull()
    expect(transientFeishuRequestFailure(new RemoteHttpError('飞书请求地址不在允许范围内，已拒绝', 'blocked-url'))).toBeNull()
    expect(transientFeishuRequestFailure(new FeishuAuthError())).toBeNull()
    expect(transientFeishuRequestFailure(new Error('boom'))).toBeNull()
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

  // #1407 P3-5：电脑时间快了，刚发的消息也会被底座当成旧的；拿飞书回应里的时间估快了多少，交给底座认。
  it('tells the core how far this computer runs ahead of Feishu, from the times Feishu answers with', async () => {
    const feishuTime = 1761379200000
    const h = harness(serializeFeishuCredential({ appId, appSecret }), (url) => {
      const answer = defaultRespond(url)
      const date = url.endsWith('/callback/ws/endpoint') ? 'Sat, 25 Oct 2025 08:00:00 GMT' : 'Sat, 25 Oct 2025 08:14:00 GMT'
      return new Response(answer.body, { status: answer.status, headers: { 'Content-Type': 'application/json', Date: date } })
    })
    h.deps.now = () => feishuTime + 15 * 60_000
    const channel = await startChannel(h)
    h.sockets[0].emit('open')
    h.sockets[0].deliver(eventFrame(textEvent()))
    expect(h.inbound[0]).toMatchObject({ kind: 'text', sentAt: 1761379200123, clockAheadMs: 15 * 60_000 })
    // Every reply sent refreshes the estimate.
    await channel.send({ channel: 'feishu', userId: 'ou_alice' }, { kind: 'text', text: '好' })
    h.sockets[0].deliver(eventFrame(textEvent({ eventId: 'ev-2' }), 'm-2'))
    expect(h.inbound[1]).toMatchObject({ clockAheadMs: 60_000 })
    await channel.stop()
  })

  it('leaves the clock estimate out when Feishu answers without a time', async () => {
    const h = harness(serializeFeishuCredential({ appId, appSecret }), defaultRespond)
    const channel = await startChannel(h)
    h.sockets[0].emit('open')
    h.sockets[0].deliver(eventFrame(textEvent()))
    expect(h.inbound[0]).not.toHaveProperty('clockAheadMs')
    await channel.stop()
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
    expect(h.statuses.at(-1)).toEqual({ state: 'needs-login', message: '飞书应用的 App ID 或 Secret 不对，到飞书开放平台核对后重新填。', problem: 'credential' })
  })

  // D23：原来这句带着「长连接」，现在只说关掉别处再试，卡片配「重新连接」。
  it('stops with a plain connection-limit sentence when the app is connected elsewhere', async () => {
    const h = harness(serializeFeishuCredential({ appId, appSecret }), (url) =>
      url.endsWith('/callback/ws/endpoint') ? json({ code: 1000040350, msg: 'connection limit' }) : defaultRespond(url))
    const channel = createFeishuRemoteChannel(h.deps, { createSocket: (url) => new FakeSocket(url) })
    await channel.start({ onInbound: () => undefined, onStatus: (status) => h.statuses.push(status) })
    await vi.waitFor(() => expect(h.statuses.at(-1)?.state).toBe('error'))
    expect(h.statuses.at(-1)).toEqual({ state: 'error', message: '这个飞书应用在别处也连着，先关掉别处再试。', problem: 'connection-limit' })
    expect(h.logs).toContain('feishu.connection-limit')
  })

  it('says the fixed fallback sentence instead of throwing when the saved credential cannot be read', async () => {
    const h = harness(null, defaultRespond)
    const deps: RemoteChannelDependencies = {
      ...h.deps,
      readCredential: async () => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.') },
    }
    const channel = createFeishuRemoteChannel(deps)
    await channel.start({ onInbound: () => undefined, onStatus: (status) => h.statuses.push(status) })
    expect(h.statuses.at(-1)).toEqual({ state: 'error', message: '没连上，点「重新连接」再试；还不行点「找客服」。', problem: 'other' })
    expect(h.logs).toContain('feishu.credential-read-failed')
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('never puts status codes or the words long connection on the card', () => {
    for (const message of Object.values(feishuProblemMessages)) {
      expect(message).not.toMatch(/HTTP|长连接|错误码|\d{3}/)
    }
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

// YKS-4：飞书发消息断一下网就丢，丢的要是审批卡，那一步直接当「拒绝」。
describe('codex-remote-feishu send retries', () => {
  const peer = { channel: 'feishu' as const, userId: 'ou_alice' }

  function sendBodies(h: Harness): Array<Record<string, unknown>> {
    return h.fetch.mock.calls
      .filter(([url]) => String(url).includes('/im/v1/messages'))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
  }

  it('sends again after the network drops, with the same uuid so Feishu delivers it once', async () => {
    let sends = 0
    const h = harness(serializeFeishuCredential({ appId, appSecret }), (url) => {
      if (url.includes('/im/v1/messages')) {
        sends += 1
        if (sends === 1) throw new TypeError('fetch failed')
      }
      return defaultRespond(url)
    })
    const waits: number[] = []
    const channel = await startChannel(h, { sleep: async (milliseconds) => { waits.push(milliseconds) } })
    await channel.send(peer, { kind: 'text', text: '做完了' })
    const bodies = sendBodies(h)
    expect(bodies).toHaveLength(2)
    expect(typeof bodies[0].uuid).toBe('string')
    // Feishu caps uuid at 50 characters.
    expect(String(bodies[0].uuid).length).toBeLessThanOrEqual(50)
    expect(bodies[1].uuid).toBe(bodies[0].uuid)
    expect(bodies[1]).toMatchObject({ receive_id: 'ou_alice', msg_type: 'text', content: '{"text":"做完了"}' })
    expect(waits).toEqual([1000])
    expect(h.logs).toContain('feishu.send-retry')
    await channel.stop()
  })

  it('waits longer each time Feishu is busy or rate limits, then delivers', async () => {
    const answers = [json({}, 502), json({ code: 99991400, msg: 'request trigger frequency limit' }, 400), json({ code: 0 })]
    const h = harness(serializeFeishuCredential({ appId, appSecret }), (url) => {
      if (url.includes('/im/v1/messages')) return answers.shift() ?? json({ code: 0 })
      return defaultRespond(url)
    })
    const waits: number[] = []
    const channel = await startChannel(h, { sleep: async (milliseconds) => { waits.push(milliseconds) } })
    await channel.send(peer, {
      kind: 'approval',
      request: { approvalId: '3', nonce: 'nonce-of-three', kind: 'command', summary: 'npm test' },
      text: 'Codex 想运行命令（第 3 条）：\nnpm test',
    })
    const bodies = sendBodies(h)
    expect(bodies).toHaveLength(3)
    expect(new Set(bodies.map((body) => body.uuid)).size).toBe(1)
    expect(bodies[2].msg_type).toBe('interactive')
    expect(waits).toEqual([1000, 4000])
    await channel.stop()
  })

  it('gives up after two more tries and says it could not reach Feishu', async () => {
    const h = harness(serializeFeishuCredential({ appId, appSecret }), (url) => {
      if (url.includes('/im/v1/messages')) throw new TypeError('fetch failed')
      return defaultRespond(url)
    })
    const waits: number[] = []
    const channel = await startChannel(h, { sleep: async (milliseconds) => { waits.push(milliseconds) } })
    await expect(channel.send(peer, { kind: 'text', text: '做完了' })).rejects.toThrow('连不上飞书，请检查网络')
    expect(sendBodies(h)).toHaveLength(3)
    expect(waits).toEqual([1000, 4000])
    expect(h.logs).toContain('feishu.send-failed')
    await channel.stop()
  })

  it('does not send again when Feishu refuses the message itself', async () => {
    const h = harness(serializeFeishuCredential({ appId, appSecret }), (url) => {
      if (url.includes('/im/v1/messages')) return json({ code: 230053, msg: 'The user has stopped the bot from sending messages.' }, 400)
      return defaultRespond(url)
    })
    const waits: number[] = []
    const channel = await startChannel(h, { sleep: async (milliseconds) => { waits.push(milliseconds) } })
    await expect(channel.send(peer, { kind: 'text', text: '做完了' })).rejects.toThrow('飞书没有发出这条消息（错误码 230053）')
    expect(sendBodies(h)).toHaveLength(1)
    expect(waits).toEqual([])
    await channel.stop()
  })

  it('retries a token request lost to the network before sending', async () => {
    let tokenCalls = 0
    const h = harness(serializeFeishuCredential({ appId, appSecret }), (url) => {
      if (url.endsWith('/tenant_access_token/internal')) {
        tokenCalls += 1
        if (tokenCalls === 1) throw new TypeError('fetch failed')
      }
      return defaultRespond(url)
    })
    const waits: number[] = []
    const channel = await startChannel(h, { sleep: async (milliseconds) => { waits.push(milliseconds) } })
    await channel.send(peer, { kind: 'text', text: '做完了' })
    expect(tokenCalls).toBe(2)
    expect(sendBodies(h)).toHaveLength(1)
    expect(waits).toEqual([1000])
    await channel.stop()
  })

  it('still refreshes an expired token once, without spending a retry on it', async () => {
    const answers = [json({ code: 99991663, msg: 'token invalid' }, 400), json({}, 503), json({ code: 0 })]
    const h = harness(serializeFeishuCredential({ appId, appSecret }), (url) => {
      if (url.includes('/im/v1/messages')) return answers.shift() ?? json({ code: 0 })
      return defaultRespond(url)
    })
    const waits: number[] = []
    const channel = await startChannel(h, { sleep: async (milliseconds) => { waits.push(milliseconds) } })
    await channel.send(peer, { kind: 'text', text: '做完了' })
    expect(sendBodies(h)).toHaveLength(3)
    expect(waits).toEqual([1000])
    const tokenCalls = h.fetch.mock.calls.filter(([url]) => String(url).endsWith('/tenant_access_token/internal'))
    expect(tokenCalls).toHaveLength(2)
    await channel.stop()
  })

  it('gives every message its own uuid', async () => {
    const h = harness(serializeFeishuCredential({ appId, appSecret }), defaultRespond)
    const channel = await startChannel(h)
    await channel.send(peer, { kind: 'text', text: '一' })
    await channel.send(peer, { kind: 'text', text: '一' })
    const [first, second] = sendBodies(h)
    expect(first.uuid).not.toBe(second.uuid)
    await channel.stop()
  })

  it('never logs message text while retrying', async () => {
    const h = harness(serializeFeishuCredential({ appId, appSecret }), (url) => {
      if (url.includes('/im/v1/messages')) throw new TypeError('fetch failed')
      return defaultRespond(url)
    })
    const logged: unknown[] = []
    h.deps.log = (_level, event, fields) => { logged.push(event, fields) }
    const channel = await startChannel(h, { sleep: async () => undefined })
    await expect(channel.send(peer, { kind: 'text', text: '机密的回答' })).rejects.toThrow()
    expect(JSON.stringify(logged)).not.toContain('机密')
    await channel.stop()
  })
})

describe('codex-remote-feishu progress card', () => {
  const peer = { channel: 'feishu' as const, userId: 'ou_alice' }
  const running = {
    state: 'running' as const,
    steps: [
      { text: '读代码', status: 'completed' as const },
      { text: '改测试', status: 'inProgress' as const },
      { text: '跑一遍', status: 'pending' as const },
    ],
    elapsed: '已经 3 分钟',
    stopNonce: 'stop-nonce-0001',
  }

  it('builds a shared card with marked steps, the elapsed time and a stop button', () => {
    const card = buildFeishuProgressCard(running)
    expect(card).toEqual({
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: 'Codex 正在处理' } },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: '✓ 读代码\n▶ 改测试\n○ 跑一遍' } },
        { tag: 'div', text: { tag: 'plain_text', content: '已经 3 分钟' } },
        {
          tag: 'action',
          actions: [{ tag: 'button', text: { tag: 'plain_text', content: '停止' }, type: 'danger', value: { stop: 'stop-nonce-0001' } }],
        },
      ],
    })
  })

  it('keeps only the title and steps once the turn has ended, and never leaves the card empty', () => {
    const done = buildFeishuProgressCard({ state: 'done', steps: running.steps.map((step) => ({ ...step, status: 'completed' as const })) })
    expect(done.header).toEqual({ template: 'green', title: { tag: 'plain_text', content: '做完了' } })
    expect(JSON.stringify(done)).not.toContain('stop')
    expect((done.config as Record<string, unknown>).update_multi).toBe(true)
    expect(buildFeishuProgressCard({ state: 'stopped', steps: [] })).toMatchObject({
      header: { template: 'grey', title: { content: '已停止' } },
      elements: [{ tag: 'hr' }],
    })
    expect(buildFeishuProgressCard({ state: 'failed', steps: [] }).header).toEqual({ template: 'red', title: { tag: 'plain_text', content: '没做完' } })
  })

  it('turns a stop click into a stop request, and hands over an unusable nonce as null', () => {
    const context = { p2pChats: new Map([['ou_alice', 'oc_p2p_alice']]) }
    expect(parseFeishuEvent(cardEvent('oc_p2p_alice', { stop: 'stop-nonce-0001' }), context).inbound).toEqual({
      kind: 'stop',
      peer,
      direct: true,
      nonce: 'stop-nonce-0001',
    })
    expect(parseFeishuEvent(cardEvent('oc_group', { stop: 'stop-nonce-0001' }), context).inbound).toMatchObject({ kind: 'stop', direct: false })
    for (const stop of ['', 'short', '<script>', 'x'.repeat(65), 42, null]) {
      expect(parseFeishuEvent(cardEvent('oc_p2p_alice', { stop }), context).inbound).toMatchObject({ kind: 'stop', nonce: null })
    }
  })

  it('sends the card and hands back the message id Feishu gives it', async () => {
    const h = harness(serializeFeishuCredential({ appId, appSecret }), (url) => {
      if (url.includes('/im/v1/messages')) return json({ code: 0, data: { message_id: 'om_progress_1' } })
      return defaultRespond(url)
    })
    const channel = await startChannel(h)
    await expect(channel.sendProgress?.(peer, running)).resolves.toBe('om_progress_1')
    const sendCall = h.fetch.mock.calls.find(([url]) => String(url).includes('/im/v1/messages'))
    expect(String(sendCall?.[0])).toBe('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id')
    const body = JSON.parse(String(sendCall?.[1].body)) as Record<string, unknown>
    expect(body).toMatchObject({ receive_id: 'ou_alice', msg_type: 'interactive' })
    expect(typeof body.uuid).toBe('string')
    expect(JSON.parse(String(body.content))).toEqual(buildFeishuProgressCard(running))
    await channel.stop()
  })

  it('refuses a card without a usable message id, since it could never be updated', async () => {
    for (const data of [{}, { message_id: 'om_../x' }, { message_id: 'abc' }]) {
      const h = harness(serializeFeishuCredential({ appId, appSecret }), (url) => {
        if (url.includes('/im/v1/messages')) return json({ code: 0, data })
        return defaultRespond(url)
      })
      const channel = await startChannel(h)
      await expect(channel.sendProgress?.(peer, running)).rejects.toThrow('飞书没有给出这张卡片的编号')
      await channel.stop()
    }
  })

  it('updates the same card in place with PATCH and refreshes an expired token once', async () => {
    let patches = 0
    const h = harness(serializeFeishuCredential({ appId, appSecret }), (url, init) => {
      if (url.includes('/im/v1/messages/') && init.method === 'PATCH') {
        patches += 1
        return patches === 1 ? json({ code: 99991663, msg: 'token invalid' }) : json({ code: 0 })
      }
      return defaultRespond(url)
    })
    const channel = await startChannel(h)
    const done = { state: 'done' as const, steps: running.steps }
    await channel.updateProgress?.('om_progress_1', done)
    const patchCalls = h.fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')
    expect(patchCalls).toHaveLength(2)
    expect(String(patchCalls[1][0])).toBe('https://open.feishu.cn/open-apis/im/v1/messages/om_progress_1')
    expect(JSON.parse(String(patchCalls[1][1]?.body))).toEqual({ content: JSON.stringify(buildFeishuProgressCard(done)) })
    expect(h.fetch.mock.calls.filter(([url]) => String(url).endsWith('/tenant_access_token/internal'))).toHaveLength(2)
    await channel.stop()
  })

  it('does not touch the network for a card id that is not a Feishu message id', async () => {
    const h = harness(serializeFeishuCredential({ appId, appSecret }), defaultRespond)
    const channel = await startChannel(h)
    const before = h.fetch.mock.calls.length
    for (const handle of ['../chats', 'om_a/b', 'om_', '']) {
      await expect(channel.updateProgress?.(handle, running)).rejects.toThrow('飞书卡片编号不对')
    }
    expect(h.fetch.mock.calls.length).toBe(before)
    await channel.stop()
  })

  it('logs a refused update without the card text and lets the caller carry on', async () => {
    const h = harness(serializeFeishuCredential({ appId, appSecret }), (url, init) => {
      if (init.method === 'PATCH') return json({ code: 230001, msg: 'bad' }, 400)
      return defaultRespond(url)
    })
    const logged: unknown[] = []
    h.deps.log = (_level, event, fields) => { logged.push(event, fields) }
    const channel = await startChannel(h)
    await expect(channel.updateProgress?.('om_progress_1', { ...running, steps: [{ text: '机密的步骤', status: 'inProgress' }] })).rejects.toThrow('230001')
    expect(logged).toContain('feishu.progress-update-failed')
    expect(JSON.stringify(logged)).not.toContain('机密')
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
    await channel.stop()
  })
})
