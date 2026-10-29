import { describe, expect, it } from 'vitest'
import {
  WeixinIlinkError,
  buildWeixinBotAgent,
  buildWeixinClientVersion,
  clampWeixinLongPollMs,
  fetchWeixinLoginQrCode,
  fetchWeixinUpdates,
  parseWeixinInboundMessage,
  parseWeixinJson,
  pollWeixinLoginStatus,
  resolveWeixinIlinkOrigin,
  sendWeixinText,
  weixinIlinkDefaultOrigin,
  type WeixinIlinkContext,
} from './codex-remote-weixin-api'

interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockFetch(responses: Array<Response | (() => Response | Promise<Response>)>): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const queue = [...responses]
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    })
    const next = queue.shift()
    if (!next) throw new Error('unexpected request')
    return typeof next === 'function' ? next() : next
  }) as typeof fetch
  return { fetch: fetchImpl, requests }
}

function contextFor(fetchImpl: typeof fetch, origin = weixinIlinkDefaultOrigin): WeixinIlinkContext {
  return { fetch: fetchImpl, origin, botAgent: 'XingmangAI/0.2.21' }
}

describe('resolveWeixinIlinkOrigin', () => {
  it('accepts https hosts under weixin.qq.com, with or without scheme', () => {
    expect(resolveWeixinIlinkOrigin('https://ilinkai.weixin.qq.com')).toBe('https://ilinkai.weixin.qq.com')
    expect(resolveWeixinIlinkOrigin('https://ilinkai.weixin.qq.com/')).toBe('https://ilinkai.weixin.qq.com')
    expect(resolveWeixinIlinkOrigin('sh.ilinkai.weixin.qq.com')).toBe('https://sh.ilinkai.weixin.qq.com')
    expect(resolveWeixinIlinkOrigin(' ILINKAI.Weixin.QQ.com ')).toBe('https://ilinkai.weixin.qq.com')
  })

  it('refuses look-alike hosts, other schemes, ports, credentials and paths', () => {
    for (const value of [
      'https://weixin.qq.com.evil.com',
      'https://evilweixin.qq.com',
      'https://ilinkai.weixin.qq.com.evil.com/',
      'http://ilinkai.weixin.qq.com',
      'https://ilinkai.weixin.qq.com:8443',
      'https://user:pass@ilinkai.weixin.qq.com',
      'https://ilinkai.weixin.qq.com/c2c',
      'https://ilinkai.weixin.qq.com/?x=1',
      'evil.com/.weixin.qq.com',
      'javascript://ilinkai.weixin.qq.com',
      '',
      null,
      42,
    ]) {
      expect(resolveWeixinIlinkOrigin(value)).toBeNull()
    }
  })
})

describe('parseWeixinJson', () => {
  it('keeps uint64 message ids exact so two adjacent ids stay different', () => {
    const parsed = parseWeixinJson('{"msgs":[{"message_id":7234567890123456781},{"message_id": 7234567890123456782}]}') as {
      msgs: Array<{ message_id: string }>
    }
    expect(parsed.msgs.map((message) => message.message_id)).toEqual(['7234567890123456781', '7234567890123456782'])
    expect(JSON.parse('[7234567890123456781,7234567890123456782]')[0]).toBe(JSON.parse('[7234567890123456781,7234567890123456782]')[1])
  })

  it('leaves look-alike text inside string values untouched', () => {
    const parsed = parseWeixinJson('{"text":"\\"message_id\\":12345678901234567890","seq":12345678901234567890}') as Record<string, unknown>
    expect(parsed.text).toBe('"message_id":12345678901234567890')
    expect(typeof parsed.seq).toBe('number')
  })
})

describe('parseWeixinInboundMessage', () => {
  it('takes text, voice transcription, and marks media without text', () => {
    expect(parseWeixinInboundMessage({
      message_id: '11', from_user_id: 'u@im.wechat', message_type: 1, context_token: 'ctx',
      create_time_ms: 1761379200000, item_list: [{ type: 1, text_item: { text: '看下测试' } }],
    })).toMatchObject({ messageId: '11', text: '看下测试', hasMedia: false, contextToken: 'ctx', createdAt: 1761379200000 })
    expect(parseWeixinInboundMessage({
      message_id: '12', from_user_id: 'u@im.wechat', message_type: 1, item_list: [{ type: 3, voice_item: { text: '跑一下' } }],
    })).toMatchObject({ text: '跑一下', hasMedia: false })
    expect(parseWeixinInboundMessage({
      message_id: '13', from_user_id: 'u@im.wechat', message_type: 1, item_list: [{ type: 2, image_item: {} }],
    })).toMatchObject({ text: null, hasMedia: true })
  })

  it('drops messages without a sender or id', () => {
    expect(parseWeixinInboundMessage({ message_id: '1', item_list: [] })).toBeNull()
    expect(parseWeixinInboundMessage({ from_user_id: 'u', item_list: [] })).toBeNull()
    expect(parseWeixinInboundMessage('nope')).toBeNull()
  })

  it('falls back to the item msg_id and records group ids', () => {
    expect(parseWeixinInboundMessage({
      from_user_id: 'u', group_id: 'g1', message_type: 1, item_list: [{ type: 1, msg_id: '99', text_item: { text: 'hi' } }],
    })).toMatchObject({ messageId: '99', groupId: 'g1' })
  })
})

describe('protocol constants', () => {
  it('encodes the client version like the reference plugin', () => {
    expect(buildWeixinClientVersion('2.4.10')).toBe(0x0002040a)
  })

  it('declares Xingmang honestly and falls back on odd versions', () => {
    expect(buildWeixinBotAgent('0.2.21')).toBe('XingmangAI/0.2.21')
    expect(buildWeixinBotAgent('0.2.21 (evil)')).toBe('XingmangAI/0')
    expect(buildWeixinBotAgent(null)).toBe('XingmangAI/0')
  })

  it('clamps the server suggested long-poll time', () => {
    expect(clampWeixinLongPollMs(undefined)).toBe(35_000)
    expect(clampWeixinLongPollMs(100)).toBe(5_000)
    expect(clampWeixinLongPollMs(10 * 60_000)).toBe(50_000)
    expect(clampWeixinLongPollMs(30_000)).toBe(30_000)
  })
})

describe('login requests', () => {
  it('asks for a QR code without sending any bot token header', async () => {
    const { fetch, requests } = mockFetch([jsonResponse({ qrcode: 'q1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc' })])
    await expect(fetchWeixinLoginQrCode(contextFor(fetch), [])).resolves.toEqual({ qrcode: 'q1', content: 'https://liteapp.weixin.qq.com/q/abc' })
    expect(requests[0].url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3')
    expect(requests[0].headers.authorization).toBeUndefined()
    expect(requests[0].body).toEqual({ local_token_list: [] })
  })

  it('maps scan states and refuses a redirect to a foreign host', async () => {
    const { fetch } = mockFetch([
      jsonResponse({ status: 'scaned' }),
      jsonResponse({ status: 'scaned_but_redirect', redirect_host: 'sz.ilinkai.weixin.qq.com' }),
      jsonResponse({ status: 'scaned_but_redirect', redirect_host: 'attacker.example' }),
      jsonResponse({ status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'b1@im.bot', baseurl: 'https://evil.example', ilink_user_id: 'u@im.wechat' }),
    ])
    const context = contextFor(fetch)
    await expect(pollWeixinLoginStatus(context, 'q1', null)).resolves.toEqual({ status: 'scanned' })
    await expect(pollWeixinLoginStatus(context, 'q1', null)).resolves.toEqual({ status: 'redirect', origin: 'https://sz.ilinkai.weixin.qq.com' })
    await expect(pollWeixinLoginStatus(context, 'q1', null)).resolves.toEqual({ status: 'redirect', origin: null })
    await expect(pollWeixinLoginStatus(context, 'q1', null)).resolves.toEqual({
      status: 'confirmed', token: 'tok', botId: 'b1@im.bot', origin: null, ownerUserId: 'u@im.wechat',
    })
  })

  it('sends the verify code only as digits in the query string', async () => {
    const { fetch, requests } = mockFetch([jsonResponse({ status: 'wait' })])
    await pollWeixinLoginStatus(contextFor(fetch), 'q&1', '123456')
    expect(requests[0].url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=q%261&verify_code=123456')
  })

  it('refuses to follow a redirect away from the pinned host', async () => {
    const { fetch } = mockFetch([new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } })])
    await expect(fetchWeixinLoginQrCode(contextFor(fetch), [])).rejects.toThrow('重定向')
  })
})

describe('fetchWeixinUpdates', () => {
  it('sends the token only to the pinned origin and parses messages losslessly', async () => {
    const { fetch, requests } = mockFetch([jsonResponse(
      '{"ret":0,"get_updates_buf":"buf2","longpolling_timeout_ms":30000,"msgs":[{"message_id":7234567890123456781,"from_user_id":"u@im.wechat","message_type":1,"context_token":"c1","item_list":[{"type":1,"text_item":{"text":"hi"}}]}]}',
    )])
    const updates = await fetchWeixinUpdates(contextFor(fetch, 'https://sz.ilinkai.weixin.qq.com'), 'tok', 'buf1', 35_000)
    expect(requests[0].url).toBe('https://sz.ilinkai.weixin.qq.com/ilink/bot/getupdates')
    expect(requests[0].headers.authorization).toBe('Bearer tok')
    expect(requests[0].headers.authorizationtype).toBe('ilink_bot_token')
    expect(requests[0].body).toEqual({ get_updates_buf: 'buf1', base_info: { channel_version: '2.4.10', bot_agent: 'XingmangAI/0.2.21' } })
    expect(updates.cursor).toBe('buf2')
    expect(updates.nextLongPollMs).toBe(30_000)
    expect(updates.messages[0].messageId).toBe('7234567890123456781')
  })

  it('passes on the time WeChat answered at, so the channel can tell whether this computer runs fast', async () => {
    const timed = new Response('{"ret":0,"msgs":[]}', { status: 200, headers: { 'Content-Type': 'application/json', Date: 'Sat, 25 Oct 2025 08:00:00 GMT' } })
    const { fetch } = mockFetch([timed, jsonResponse({ ret: 0, msgs: [] })])
    await expect(fetchWeixinUpdates(contextFor(fetch), 'tok', '', 35_000)).resolves.toMatchObject({ serverTime: 1761379200000 })
    expect(await fetchWeixinUpdates(contextFor(fetch), 'tok', '', 35_000)).not.toHaveProperty('serverTime')
  })

  it('reports an expired session as its own reason', async () => {
    const { fetch } = mockFetch([jsonResponse({ ret: -14, errmsg: 'session timeout' })])
    const error = await fetchWeixinUpdates(contextFor(fetch), 'tok', '', 35_000).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(WeixinIlinkError)
    expect((error as WeixinIlinkError).reason).toBe('session-expired')
  })

  it('treats a refused token as needing a new login', async () => {
    const { fetch } = mockFetch([jsonResponse({}, 401)])
    const error = await fetchWeixinUpdates(contextFor(fetch), 'tok', '', 35_000).catch((caught: unknown) => caught)
    expect((error as WeixinIlinkError).reason).toBe('refused')
  })

  it('keeps the old cursor when the server leaves it out', async () => {
    const { fetch } = mockFetch([jsonResponse({ ret: 0, msgs: [] })])
    await expect(fetchWeixinUpdates(contextFor(fetch), 'tok', 'keep', 35_000)).resolves.toMatchObject({ cursor: 'keep', messages: [] })
  })
})

describe('sendWeixinText', () => {
  it('builds a finished bot text message with the reply context', async () => {
    const { fetch, requests } = mockFetch([jsonResponse({ ret: 0, message_id: 1 })])
    await sendWeixinText(contextFor(fetch), 'tok', 'u@im.wechat', '好的', 'ctx-1')
    const body = requests[0].body as { msg: Record<string, unknown> }
    expect(body.msg).toMatchObject({
      to_user_id: 'u@im.wechat',
      message_type: 2,
      message_state: 2,
      context_token: 'ctx-1',
      item_list: [{ type: 1, text_item: { text: '好的' } }],
    })
    expect(String(body.msg.client_id)).toMatch(/^xingmang-weixin-[0-9a-f]{16}$/)
  })

  it('reports a stale reply context separately so the caller can resend without it', async () => {
    const { fetch } = mockFetch([jsonResponse({ ret: -2 })])
    const error = await sendWeixinText(contextFor(fetch), 'tok', 'u', 'x', 'old').catch((caught: unknown) => caught)
    expect((error as WeixinIlinkError).reason).toBe('stale-context')
  })
})
