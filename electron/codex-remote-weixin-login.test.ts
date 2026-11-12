import { describe, expect, it } from 'vitest'
import { decodeWeixinCredential, encodeWeixinCredential } from './codex-remote-weixin-credential'
import { createWeixinLoginController, normalizeWeixinVerifyCode, type WeixinLoginDependencies } from './codex-remote-weixin-login'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface LoginHarness {
  dependencies: WeixinLoginDependencies
  requests: string[]
  saved: Array<{ value: string; label: string; verifiedOwner: string | null }>
  clock: { now: number }
  reconnects: { count: number; failure: Error | null }
  logs: string[]
}

function harness(responses: Array<Response | Error>, existing: string | null = null): LoginHarness {
  const requests: string[] = []
  const saved: LoginHarness['saved'] = []
  const clock = { now: 1_000_000 }
  const reconnects: LoginHarness['reconnects'] = { count: 0, failure: null }
  const logs: string[] = []
  const queue = [...responses]
  const fetchImpl = (async (input: RequestInfo | URL) => {
    requests.push(String(input))
    const next = queue.shift()
    if (!next) throw new Error('unexpected request')
    if (next instanceof Error) throw next
    return next
  }) as typeof fetch
  return {
    requests,
    saved,
    clock,
    reconnects,
    logs,
    dependencies: {
      fetch: fetchImpl,
      botAgent: 'XingmangAI/test',
      now: () => clock.now,
      readCredential: async () => existing,
      saveCredential: async (value, label, verifiedOwner) => {
        saved.push({ value, label, verifiedOwner })
      },
      reconnectIfLoggedOut: async () => {
        reconnects.count += 1
        if (reconnects.failure) throw reconnects.failure
      },
      renderQrCode: async (content) => `data:image/png;base64,${Buffer.from(content).toString('base64')}`,
      log: (_level, event) => {
        logs.push(event)
      },
    },
  }
}

function qr(id: string): Response {
  return jsonResponse({ qrcode: id, qrcode_img_content: `https://liteapp.weixin.qq.com/q/${id}` })
}

describe('normalizeWeixinVerifyCode', () => {
  it('keeps only short digit strings', () => {
    expect(normalizeWeixinVerifyCode(' 12 34 ')).toBe('1234')
    expect(normalizeWeixinVerifyCode('12a4')).toBeNull()
    expect(normalizeWeixinVerifyCode('123456789')).toBeNull()
    expect(normalizeWeixinVerifyCode(1234)).toBeNull()
  })
})

describe('createWeixinLoginController', () => {
  it('draws the QR code in the main process and saves the scanned credential', async () => {
    const { dependencies, requests, saved, reconnects } = harness([
      qr('q1'),
      jsonResponse({ status: 'scaned' }),
      jsonResponse({ status: 'scaned_but_redirect', redirect_host: 'sz.ilinkai.weixin.qq.com' }),
      jsonResponse({ status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'b0f5860fdecb@im.bot', baseurl: 'https://sz.ilinkai.weixin.qq.com', ilink_user_id: 'owner@im.wechat' }),
    ])
    const login = createWeixinLoginController(dependencies)
    const started = await login.start()
    expect(started.phase).toBe('waiting-scan')
    expect(started.qrImage).toBe(`data:image/png;base64,${Buffer.from('https://liteapp.weixin.qq.com/q/q1').toString('base64')}`)
    expect(started.expiresAt).toBe(1_000_000 + 5 * 60_000)
    expect(JSON.stringify(started)).not.toContain('liteapp.weixin.qq.com')

    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'scanned' })
    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'scanned' })
    const done = await login.poll(started.loginId)
    expect(done).toMatchObject({ phase: 'confirmed' })
    expect(JSON.stringify(done)).not.toContain('tok')
    expect(requests[3]).toBe('https://sz.ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=q1')
    expect(saved).toHaveLength(1)
    // 新凭据走保存那条路重启渠道，不用另外重连。
    expect(reconnects.count).toBe(0)
    expect(saved[0].label).toBe('ClawBot decb')
    // 微信没要数字：扫码的人不直接绑，照旧要配对码（YF-5 只在过了数字时免）。
    expect(saved[0].verifiedOwner).toBeNull()
    expect(done.boundByScan).toBeUndefined()
    expect(decodeWeixinCredential(saved[0].value)).toEqual({
      version: 1, token: 'tok', botId: 'b0f5860fdecb@im.bot', origin: 'https://sz.ilinkai.weixin.qq.com', ownerUserId: 'owner@im.wechat',
    })
    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'failed' })
  })

  it('falls back to the default host when the confirmed base URL is foreign', async () => {
    const { dependencies, saved } = harness([
      qr('q1'),
      jsonResponse({ status: 'scaned_but_redirect', redirect_host: 'attacker.example' }),
      jsonResponse({ status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'b1@im.bot', baseurl: 'https://attacker.example' }),
    ])
    const login = createWeixinLoginController(dependencies)
    const started = await login.start()
    await login.poll(started.loginId)
    await login.poll(started.loginId)
    expect(decodeWeixinCredential(saved[0].value)?.origin).toBe('https://ilinkai.weixin.qq.com')
    expect(decodeWeixinCredential(saved[0].value)?.ownerUserId).toBeNull()
  })

  it('asks for the number shown on the phone and says when it was wrong', async () => {
    const { dependencies, requests } = harness([
      qr('q1'),
      jsonResponse({ status: 'need_verifycode' }),
      jsonResponse({ status: 'need_verifycode' }),
      jsonResponse({ status: 'scaned' }),
    ])
    const login = createWeixinLoginController(dependencies)
    const started = await login.start()
    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'need-verify-code' })
    await expect(login.poll(started.loginId, 'abc')).resolves.toMatchObject({ phase: 'need-verify-code', message: '请输入手机微信上显示的数字' })
    await expect(login.poll(started.loginId, '1111')).resolves.toMatchObject({ phase: 'verify-code-wrong' })
    expect(requests[2]).toContain('verify_code=1111')
    await expect(login.poll(started.loginId, '2222')).resolves.toMatchObject({ phase: 'scanned' })
  })

  it('asks for the phone number when WeChat confirms but still wants it, and only saves after the plain confirm', async () => {
    const { dependencies, requests, saved } = harness([
      qr('q1'),
      jsonResponse({ status: 'scaned' }),
      jsonResponse({ status: 'confirmed_but_need_verifycode', bot_token: 'early', ilink_bot_id: 'b1@im.bot' }),
      jsonResponse({ status: 'confirmed_but_need_verifycode' }),
      jsonResponse({ status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'b1@im.bot', ilink_user_id: 'owner@im.wechat' }),
    ])
    const login = createWeixinLoginController(dependencies)
    const started = await login.start()
    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'scanned' })
    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'need-verify-code' })
    expect(saved).toHaveLength(0)
    await expect(login.poll(started.loginId, '1111')).resolves.toMatchObject({ phase: 'verify-code-wrong' })
    expect(requests[3]).toContain('verify_code=1111')
    await expect(login.poll(started.loginId, '2222')).resolves.toMatchObject({ phase: 'confirmed' })
    expect(requests[4]).toContain('verify_code=2222')
    expect(saved).toHaveLength(1)
    expect(decodeWeixinCredential(saved[0].value)).toMatchObject({ token: 'tok', ownerUserId: 'owner@im.wechat' })
    // YF-5：确认了还要数字（confirmed_but_need_verifycode）也算微信要过数字，输对了扫码的人直接记成绑定的人。
    expect(saved[0].verifiedOwner).toBe('owner@im.wechat')
  })

  // YF-5：微信要过手机上那串数字、输对了，扫码的人直接记成绑定的人。
  it('hands over the scanner as the bound person only after the number on the phone was asked for and accepted', async () => {
    const { dependencies, saved } = harness([
      qr('q1'),
      jsonResponse({ status: 'need_verifycode' }),
      jsonResponse({ status: 'need_verifycode' }),
      jsonResponse({ status: 'scaned' }),
      jsonResponse({ status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'b1@im.bot', ilink_user_id: 'owner@im.wechat' }),
    ])
    const login = createWeixinLoginController(dependencies)
    const started = await login.start()
    await login.poll(started.loginId)
    await expect(login.poll(started.loginId, '1111')).resolves.toMatchObject({ phase: 'verify-code-wrong' })
    await expect(login.poll(started.loginId, '2222')).resolves.toMatchObject({ phase: 'scanned' })
    const done = await login.poll(started.loginId)
    expect(done).toMatchObject({ phase: 'confirmed', boundByScan: true })
    expect(saved[0].verifiedOwner).toBe('owner@im.wechat')
  })

  it('also counts a number accepted straight into the confirmation', async () => {
    const { dependencies, saved } = harness([
      qr('q1'),
      jsonResponse({ status: 'need_verifycode' }),
      jsonResponse({ status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'b1@im.bot', ilink_user_id: 'owner@im.wechat' }),
    ])
    const login = createWeixinLoginController(dependencies)
    const started = await login.start()
    await login.poll(started.loginId)
    await expect(login.poll(started.loginId, '2222')).resolves.toMatchObject({ phase: 'confirmed', boundByScan: true })
    expect(saved[0].verifiedOwner).toBe('owner@im.wechat')
  })

  it('keeps asking for pairing when no number was asked for, the scanner is unknown, or the number came for another QR', async () => {
    // 界面没被要就塞了一串数字：微信根本没要过，不算过了数字。
    const unasked = harness([
      qr('q1'),
      jsonResponse({ status: 'scaned' }),
      jsonResponse({ status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'b1@im.bot', ilink_user_id: 'owner@im.wechat' }),
    ])
    let login = createWeixinLoginController(unasked.dependencies)
    let started = await login.start()
    await login.poll(started.loginId, '2222')
    expect((await login.poll(started.loginId)).boundByScan).toBeUndefined()
    expect(unasked.saved[0].verifiedOwner).toBeNull()

    // 过了数字，可微信没说是谁扫的：没法直接绑。
    const anonymous = harness([
      qr('q1'),
      jsonResponse({ status: 'need_verifycode' }),
      jsonResponse({ status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'b1@im.bot' }),
    ])
    login = createWeixinLoginController(anonymous.dependencies)
    started = await login.start()
    await login.poll(started.loginId)
    expect((await login.poll(started.loginId, '2222')).boundByScan).toBeUndefined()
    expect(anonymous.saved[0].verifiedOwner).toBeNull()

    // 上一张二维码输对过数字，过期换了一张、这张微信没要数字：不算。
    const refreshed = harness([
      qr('q1'),
      jsonResponse({ status: 'need_verifycode' }),
      jsonResponse({ status: 'scaned' }),
      jsonResponse({ status: 'expired' }),
      qr('q2'),
      jsonResponse({ status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'b1@im.bot', ilink_user_id: 'owner@im.wechat' }),
    ])
    login = createWeixinLoginController(refreshed.dependencies)
    started = await login.start()
    await login.poll(started.loginId)
    await login.poll(started.loginId, '2222')
    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'waiting-scan' })
    expect((await login.poll(started.loginId)).boundByScan).toBeUndefined()
    expect(refreshed.saved[0].verifiedOwner).toBeNull()
  })

  it('swaps in a new QR code when one expires, up to three in total', async () => {
    const { dependencies } = harness([
      qr('q1'),
      jsonResponse({ status: 'expired' }),
      qr('q2'),
      jsonResponse({ status: 'expired' }),
      qr('q3'),
      jsonResponse({ status: 'expired' }),
    ])
    const login = createWeixinLoginController(dependencies)
    const started = await login.start()
    const second = await login.poll(started.loginId)
    expect(second).toMatchObject({ phase: 'waiting-scan', message: '二维码过期了，已换了一张，请重新扫' })
    expect(second.qrImage).toContain(Buffer.from('https://liteapp.weixin.qq.com/q/q2').toString('base64'))
    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'waiting-scan' })
    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'failed', message: '二维码过期太多次，请重新开始' })
  })

  it('keeps waiting through a network blip and gives up after the deadline', async () => {
    const { dependencies, clock } = harness([qr('q1'), new TypeError('fetch failed')])
    const login = createWeixinLoginController(dependencies)
    const started = await login.start()
    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'waiting-scan', retryAfterMs: 2_000 })
    clock.now += 9 * 60_000
    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'failed', message: '等太久了，请重新开始扫码' })
  })

  it('offers the existing token so an already-linked WeChat stays linked', async () => {
    const existing = encodeWeixinCredential({ version: 1, token: 'old', botId: 'b1@im.bot', origin: 'https://ilinkai.weixin.qq.com', ownerUserId: null })
    const { dependencies, saved, reconnects } = harness([qr('q1'), jsonResponse({ status: 'binded_redirect' })], existing)
    const login = createWeixinLoginController(dependencies)
    const started = await login.start()
    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'confirmed', message: '这个微信已经连着这台电脑了' })
    expect(saved).toHaveLength(0)
    // YKS-6：凭据没换，保存那条重启渠道的路不走，由这里让渠道重连。
    expect(reconnects.count).toBe(1)
  })

  it('still finishes the login when the channel cannot reconnect after the old login is recognised', async () => {
    const existing = encodeWeixinCredential({ version: 1, token: 'old', botId: 'b1@im.bot', origin: 'https://ilinkai.weixin.qq.com', ownerUserId: null })
    const { dependencies, reconnects, logs } = harness([qr('q1'), jsonResponse({ status: 'binded_redirect' })], existing)
    reconnects.failure = new Error('这台电脑还没装 Codex 命令行工具，先在首页把它装好。')
    const login = createWeixinLoginController(dependencies)
    const started = await login.start()
    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'confirmed', message: '这个微信已经连着这台电脑了' })
    expect(reconnects.count).toBe(1)
    expect(logs).toContain('weixin-login-reconnect-failed')
  })

  it('fails without touching the channel when the server says already linked but this computer had no login', async () => {
    const { dependencies, reconnects } = harness([qr('q1'), jsonResponse({ status: 'binded_redirect' })])
    const login = createWeixinLoginController(dependencies)
    const started = await login.start()
    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'failed', message: '微信扫码登录失败，请重试' })
    expect(reconnects.count).toBe(0)
  })

  it('ends a login on cancel and when a new one starts', async () => {
    const { dependencies } = harness([qr('q1'), qr('q2')])
    const login = createWeixinLoginController(dependencies)
    const first = await login.start()
    const second = await login.start()
    await expect(login.poll(first.loginId)).resolves.toMatchObject({ phase: 'failed' })
    login.cancel(second.loginId)
    await expect(login.poll(second.loginId)).resolves.toMatchObject({ phase: 'failed' })
  })

  it('reports a failed QR request in plain Chinese', async () => {
    const { dependencies } = harness([jsonResponse({}, 500)])
    const login = createWeixinLoginController(dependencies)
    await expect(login.start()).resolves.toMatchObject({ phase: 'failed', message: '获取微信二维码失败，微信服务返回 HTTP 500' })
  })
})

describe('createWeixinLoginController save failures', () => {
  it('shows the store message when the credential cannot be saved', async () => {
    const { dependencies } = harness([
      qr('q1'),
      jsonResponse({ status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'b1@im.bot' }),
    ])
    dependencies.saveCredential = async () => {
      throw new Error('这台电脑没法安全保存密码，已拒绝写入微信登录信息。')
    }
    const login = createWeixinLoginController(dependencies)
    const started = await login.start()
    await expect(login.poll(started.loginId)).resolves.toMatchObject({ phase: 'failed', message: '这台电脑没法安全保存密码，已拒绝写入微信登录信息。' })
  })
})

describe('createWeixinLoginController wording', () => {
  it('only puts approved sentences on screen', async () => {
    const unknownStatus = harness([qr('q1'), jsonResponse({ status: 'something-new' })])
    const first = createWeixinLoginController(unknownStatus.dependencies)
    const started = await first.start()
    await expect(first.poll(started.loginId)).resolves.toMatchObject({ phase: 'failed', message: '微信扫码登录失败，请重试' })

    const offline = harness([new TypeError('fetch failed')])
    await expect(createWeixinLoginController(offline.dependencies).start()).resolves.toMatchObject({ phase: 'failed', message: '微信扫码登录失败，请重试' })

    const noToken = harness([qr('q1'), jsonResponse({ status: 'confirmed', ilink_bot_id: 'b1@im.bot' })])
    const third = createWeixinLoginController(noToken.dependencies)
    const again = await third.start()
    await expect(third.poll(again.loginId)).resolves.toMatchObject({ phase: 'failed', message: '扫码成功了，但微信没有给回登录信息，请重新扫码' })
  })

  it('answers a poll for a login that is gone with the general sentence', async () => {
    const { dependencies } = harness([])
    await expect(createWeixinLoginController(dependencies).poll('0f8fad5b-d9cb-469f-a165-70867728950e')).resolves.toMatchObject({ phase: 'failed', message: '微信扫码登录失败，请重试' })
  })
})
