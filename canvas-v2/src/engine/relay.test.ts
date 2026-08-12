import { afterEach, describe, expect, it, vi } from 'vitest'
import { editImage, generateImage } from './relay'

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

describe('editImage (图生图 /v1/images/edits)', () => {
  // Field-name and content-type facts verified in production against
  // xm.solov.cc (docs/RECON-image-generation.md section 5): the endpoint
  // takes multipart only, and the file field must be `image[]` -- `images`
  // is rejected by the upstream with a misleading message.
  const dataUrl = 'data:image/png;base64,QUJD'

  it('posts multipart with the image[] field and never sets Content-Type by hand', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => (
      jsonResponse(200, { data: [{ b64_json: 'REVG' }] })
    ))
    vi.stubGlobal('fetch', fetchMock)

    const asset = await editImage(config, {
      model: 'gpt-image-2',
      prompt: '把猫换成白色布偶猫',
      imageUrl: dataUrl,
      size: '1024x1024',
      quality: 'low',
    })

    expect(asset).toEqual({ kind: 'image', remoteUrl: 'data:image/png;base64,REVG' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://relay.invalid/v1/images/edits')
    const form = init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('gpt-image-2')
    expect(form.get('prompt')).toBe('把猫换成白色布偶猫')
    expect(form.get('n')).toBe('1')
    expect(form.get('size')).toBe('1024x1024')
    expect(form.get('quality')).toBe('low')
    expect(form.get('image[]')).toBeInstanceOf(Blob)
    // A hand-written Content-Type would strip the runtime-generated boundary
    // and make the upstream reject the body.
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain('Content-Type')
  })

  it('decodes a data: reference image locally without any extra network call', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => (
      jsonResponse(200, { data: [{ b64_json: 'REVG' }] })
    ))
    vi.stubGlobal('fetch', fetchMock)

    await editImage(config, { model: 'gpt-image-2', prompt: 'p', imageUrl: dataUrl })

    // Exactly one call: the edits request. The gpt-image b64 product never
    // needs a round trip to be re-uploaded.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData
    expect(await (form.get('image[]') as Blob).text()).toBe('ABC')
  })

  it('fetches an https reference image first, and explains an expired link', async () => {
    const fetchMock = vi.fn(async (url: string) => (
      url.startsWith('https://cdn.invalid')
        ? new Response('gone', { status: 403 })
        : jsonResponse(200, { data: [{ b64_json: 'REVG' }] })
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(editImage(config, {
      model: 'gpt-image-2',
      prompt: 'p',
      imageUrl: 'https://cdn.invalid/expired.png',
    })).rejects.toThrow('参考图下载失败,服务返回 403(链接可能已过期)')
  })

  it('rejects a reference image address that is neither data: nor https', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(editImage(config, {
      model: 'gpt-image-2',
      prompt: 'p',
      imageUrl: 'file:///C:/secret.png',
    })).rejects.toThrow('参考图地址不受支持')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('omits size and quality from the form when the caller does not supply them', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => (
      jsonResponse(200, { data: [{ b64_json: 'REVG' }] })
    ))
    vi.stubGlobal('fetch', fetchMock)

    await editImage(config, { model: 'gpt-image-2', prompt: 'p', imageUrl: dataUrl })

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData
    expect(form.has('size')).toBe(false)
    expect(form.has('quality')).toBe(false)
  })
})
