import { describe, expect, it } from 'vitest'
import { createWeixinLoginForHost } from './codex-remote-weixin'

describe('createWeixinLoginForHost', () => {
  it('draws the login QR code with the QR library it loads on first use', async () => {
    const requests: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(JSON.stringify({ qrcode: 'q1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/q1' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    const login = createWeixinLoginForHost({
      channelDependencies: () => ({
        fetch: fetchImpl,
        readCredential: async () => null,
        writeCredential: async () => undefined,
        log: () => undefined,
        now: () => 1_000_000,
        appVersion: '0.0.0',
      }),
      saveChannelCredential: async () => undefined,
    })

    const started = await login.start()

    expect(requests).toEqual(['https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3'])
    expect(started.phase).toBe('waiting-scan')
    const png = Buffer.from(String(started.qrImage).replace(/^data:image\/png;base64,/, ''), 'base64')
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
    login.cancel()
  })
})
