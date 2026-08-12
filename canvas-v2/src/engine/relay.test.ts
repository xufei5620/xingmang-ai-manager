import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateImage } from './relay'

const config = { baseUrl: 'https://relay.invalid', apiKey: 'sk-test' }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('generateImage', () => {
  it('returns the url form for legacy dall-e style responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: [{ url: 'https://cdn.invalid/a.png' }] })))
    await expect(generateImage(config, { model: 'm', prompt: 'p' })).resolves.toEqual({
      kind: 'image',
      remoteUrl: 'https://cdn.invalid/a.png',
    })
  })

  it('wraps gpt-image b64_json output into a data: URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: [{ b64_json: 'QUJD' }] })))
    await expect(generateImage(config, { model: 'gpt-image-2', prompt: 'p' })).resolves.toEqual({
      kind: 'image',
      remoteUrl: 'data:image/png;base64,QUJD',
    })
  })

  it('surfaces the server error message next to the status code -- a bare 503 hides the group/channel cause', async () => {
    // The exact body shape new-api returns for "no channel available in the
    // token's group" -- the failure mode behind the 2026-08-12 on-device 503.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503, {
      error: { message: '当前分组 default 下对于模型 gpt-image-2 无可用渠道', type: 'new_api_error' },
    })))
    await expect(generateImage(config, { model: 'gpt-image-2', prompt: 'p' })).rejects.toThrow(
      '图像生成失败,服务返回 503:当前分组 default 下对于模型 gpt-image-2 无可用渠道',
    )
  })

  it('strips control characters from and truncates a hostile error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, {
      error: { message: `bad\u0000\u001fnews${'x'.repeat(400)}` },
    })))
    const failure = await generateImage(config, { model: 'm', prompt: 'p' }).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('bad news')
    expect((failure as Error).message.length).toBeLessThan(250)
  })

  it('falls back to the bare status code when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', { status: 502 })))
    await expect(generateImage(config, { model: 'm', prompt: 'p' })).rejects.toThrow('图像生成失败,服务返回 502')
  })
})
