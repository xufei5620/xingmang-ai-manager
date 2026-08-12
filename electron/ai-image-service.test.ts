import { describe, expect, it, vi } from 'vitest'
import { createAiImageService, type AiImageAssetWriter } from './ai-image-service'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function setup(fetchImpl: typeof fetch) {
  const credentials = {
    resolveCredential: vi.fn(async (group: string) => ({
      userId: 7,
      group,
      models: ['gpt-image-2'],
      keyCreated: false,
      apiKey: 'sk-secret-never-return',
      keyId: 1,
      keyName: 'image',
    })),
  }
  const assets: AiImageAssetWriter = {
    storeBase64: vi.fn(async (_userId, _value, metadata) => ({
      assetId: 'asset-b64', localUrl: 'xingmang-asset://image/asset-b64', mimeType: 'image/png', fileName: 'a.png', ...metadata,
    })),
    storeRemoteUrl: vi.fn(async (_userId, _url, metadata) => ({
      assetId: 'asset-url', localUrl: 'xingmang-asset://image/asset-url', mimeType: 'image/jpeg', fileName: 'b.jpg', ...metadata,
    })),
  }
  return {
    service: createAiImageService({ baseUrl: 'https://xm.solov.cc', credentials, assets, fetchImpl }),
    credentials,
    assets,
  }
}

describe('AI image service', () => {
  it('uses the images endpoint and explicit low quality for GPT Image', async () => {
    const fetchImpl = vi.fn(async () => response({ data: [{ b64_json: 'aGVsbG8=', revised_prompt: 'revised' }] })) as unknown as typeof fetch
    const { service, assets } = setup(fetchImpl)
    const result = await service.generate(4, {
      requestId: 'r1', group: '生图分组', model: 'gpt-image-2', prompt: '一张图', size: '1024x1024',
    })
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]
    expect(String(url)).toBe('https://xm.solov.cc/v1/images/generations')
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-image-2', quality: 'low', n: 1 })
    expect(String(url)).not.toContain('chat/completions')
    expect(assets.storeBase64).toHaveBeenCalledWith(7, 'aGVsbG8=', { revisedPrompt: 'revised' })
    expect(JSON.stringify(result)).not.toContain('sk-secret')
  })

  it('omits quality and maps dimensions for Jimeng', async () => {
    const fetchImpl = vi.fn(async () => response({ data: [{ url: 'https://images.example/result.jpg' }] })) as unknown as typeof fetch
    const { service, assets } = setup(fetchImpl)
    await service.generate(4, {
      requestId: 'r2', group: '生图分组', model: 'jimeng_high_aes_general_v21_L', prompt: '一张图', size: '1024x1024',
    })
    const body = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0][1]?.body))
    expect(body).not.toHaveProperty('quality')
    expect(body).not.toHaveProperty('size')
    expect(body.extra_fields).toEqual({ width: 1024, height: 1024 })
    expect(assets.storeRemoteUrl).toHaveBeenCalledWith(7, 'https://images.example/result.jpg', undefined)
  })

  it('rejects malformed, empty, and oversized-style responses without retrying', async () => {
    const fetchImpl = vi.fn(async () => response({ data: [] })) as unknown as typeof fetch
    const { service } = setup(fetchImpl)
    await expect(service.generate(4, {
      requestId: 'r3', group: '生图分组', model: 'gpt-image-2', prompt: '图',
    })).rejects.toThrow('没有返回图片')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('redacts upstream secrets and remote URLs', async () => {
    const fetchImpl = vi.fn(async () => response({
      error: { message: 'Bearer sk-super-secret-value failed at https://private.example/path' },
    }, 400)) as unknown as typeof fetch
    const { service } = setup(fetchImpl)
    await expect(service.generate(4, {
      requestId: 'r4', group: '生图分组', model: 'gpt-image-2', prompt: '图',
    })).rejects.not.toThrow(/sk-super|private\.example/)
  })

  it.each([
    [400, { error: { message: "Invalid size '1025x1024'" } }, '不支持这个图片尺寸'],
    [403, { error: { message: 'Project does not have access to model' } }, '暂无该生图模型权限'],
    [403, { error: { message: '用户额度不足' } }, '余额或 API Key 额度不足'],
    [429, { error: { message: 'rate limited' } }, '上游限流'],
    [503, { error: { message: 'upstream unavailable' } }, '暂时不可用'],
  ])('maps HTTP %s image failures to an actionable message', async (status, payload, expected) => {
    const fetchImpl = vi.fn(async () => response(payload, status)) as unknown as typeof fetch
    const { service } = setup(fetchImpl)
    await expect(service.generate(4, {
      requestId: `failure-${status}`, group: '生图分组', model: 'gpt-image-2', prompt: '图',
    })).rejects.toThrow(expected)
  })

  it('cancels only an owned request and warns that it may still complete', async () => {
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof fetch
    const { service } = setup(fetchImpl)
    const pending = service.generate(4, {
      requestId: 'r5', group: '生图分组', model: 'gpt-image-2', prompt: '图',
    })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled())
    expect(service.cancel(5, 'r5')).toEqual({ canceled: false, mayStillComplete: false })
    expect(service.cancel(4, 'r5')).toEqual({ canceled: true, mayStillComplete: true })
    await expect(pending).rejects.toThrow('服务端可能仍在生成')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('cancels pending image requests by sender, account, or application lifecycle', async () => {
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof fetch
    const { service } = setup(fetchImpl)

    const bySender = service.generate(4, {
      requestId: 'sender-request', group: '生图分组', model: 'gpt-image-2', prompt: '图',
    })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    expect(service.cancelSender(5)).toBe(0)
    expect(service.cancelSender(4)).toBe(1)
    await expect(bySender).rejects.toThrow('服务端可能仍在生成')

    const byUser = service.generate(6, {
      requestId: 'user-request', group: '生图分组', model: 'gpt-image-2', prompt: '图',
    })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    expect(service.cancelUser(8)).toBe(0)
    expect(service.cancelUser(7)).toBe(1)
    await expect(byUser).rejects.toThrow('服务端可能仍在生成')

    const byApplication = service.generate(7, {
      requestId: 'app-request', group: '生图分组', model: 'gpt-image-2', prompt: '图',
    })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3))
    expect(service.cancelAll()).toBe(1)
    await expect(byApplication).rejects.toThrow('服务端可能仍在生成')
    expect(service.cancelAll()).toBe(0)
  })
})
