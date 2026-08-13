import { describe, expect, it, vi } from 'vitest'
import { createAiImageService, type AiImageAssetWriter } from './ai-image-service'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function setup(
  fetchImpl: typeof fetch,
  queueOptions: { maxActive?: number; maxQueued?: number; timeoutMs?: number } = {},
) {
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
    readOwned: vi.fn(async () => ({
      asset: { assetId: 'asset-source', localUrl: 'xingmang-asset://image/asset-source', mimeType: 'image/png' as const, fileName: 'source.png' },
      bytes: Buffer.from('source'),
    })),
  }
  return {
    service: createAiImageService({
      baseUrl: 'https://xm.solov.cc',
      credentials,
      assets,
      fetchImpl,
      ...queueOptions,
    }),
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
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({ model: 'gpt-image-2', quality: 'low', n: 1 })
    expect(body).not.toHaveProperty('response_format')
    expect(String(url)).not.toContain('chat/completions')
    expect(assets.storeBase64).toHaveBeenCalledWith(7, 'aGVsbG8=', { revisedPrompt: 'revised' })
    expect(JSON.stringify(result)).not.toContain('sk-secret')
  })

  it('uses the same upstream-compatible request shape for GPT Image 1', async () => {
    const fetchImpl = vi.fn(async () => response({ data: [{ b64_json: 'aGVsbG8=' }] })) as unknown as typeof fetch
    const { service } = setup(fetchImpl)
    await service.generate(4, {
      requestId: 'gpt-image-1', group: '生图分组', model: 'gpt-image-1', prompt: '一张图', size: '1024x1024',
    })

    const body = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0][1]?.body))
    expect(body).toMatchObject({ model: 'gpt-image-1', quality: 'low', n: 1, size: '1024x1024' })
    expect(body).not.toHaveProperty('response_format')
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
    expect(body).not.toHaveProperty('response_format')
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

  it('sends image edits as multipart with repeated image fields and no manual content type', async () => {
    const fetchImpl = vi.fn(async () => response({ data: [{ b64_json: 'aGVsbG8=' }] })) as unknown as typeof fetch
    const { service, assets } = setup(fetchImpl)
    const ids = ['a'.repeat(43), 'b'.repeat(43)]
    vi.mocked(assets.readOwned).mockImplementation(async (_userId, assetId) => ({
      asset: {
        assetId, localUrl: `xingmang-asset://image/${assetId}`,
        mimeType: assetId === ids[0] ? 'image/png' : 'image/jpeg',
        fileName: assetId === ids[0] ? 'source-a.png' : 'source-b.jpg',
      },
      bytes: Buffer.from(assetId === ids[0] ? 'source-a' : 'source-b'),
    }))

    await service.edit(4, {
      requestId: 'edit-1', group: '生图分组', model: 'gpt-image-2', prompt: '改成夜景',
      sourceAssetIds: ids, expectedUserId: 7, size: '1024x1024', quality: 'high',
    })

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]
    expect(String(url)).toBe('https://xm.solov.cc/v1/images/edits')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ Accept: 'application/json', Authorization: 'Bearer sk-secret-never-return' })
    expect(init?.headers).not.toHaveProperty('Content-Type')
    expect(init?.body).toBeInstanceOf(FormData)
    const form = init?.body as FormData
    expect(form.get('model')).toBe('gpt-image-2')
    expect(form.get('prompt')).toBe('改成夜景')
    expect(form.get('n')).toBe('1')
    expect(form.get('size')).toBe('1024x1024')
    expect(form.get('quality')).toBe('high')
    expect(form.getAll('image')).toHaveLength(2)
    expect(form.getAll('image').map((value) => (value as File).name)).toEqual(['source-a.png', 'source-b.jpg'])
    expect(assets.readOwned).toHaveBeenNthCalledWith(1, 7, ids[0])
    expect(assets.readOwned).toHaveBeenNthCalledWith(2, 7, ids[1])
  })

  it('rejects image edits across accounts and invalid asset lists before network dispatch', async () => {
    const fetchImpl = vi.fn(async () => response({ data: [{ b64_json: 'aGVsbG8=' }] })) as unknown as typeof fetch
    const { service, assets } = setup(fetchImpl)
    const id = 'a'.repeat(43)
    await expect(service.edit(4, {
      requestId: 'edit-account', group: 'g', model: 'gpt-image-2', prompt: 'p', sourceAssetIds: [id], expectedUserId: 8,
    })).rejects.toThrow('登录账号已变化')
    await expect(service.edit(4, {
      requestId: 'edit-duplicate', group: 'g', model: 'gpt-image-2', prompt: 'p', sourceAssetIds: [id, id],
    })).rejects.toThrow('不能重复')
    await expect(service.edit(4, {
      requestId: 'edit-too-many', group: 'g', model: 'gpt-image-2', prompt: 'p',
      sourceAssetIds: ['a', 'b', 'c', 'd', 'e'].map((prefix) => prefix.repeat(43)),
    })).rejects.toThrow('1-4')
    expect(assets.readOwned).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects providers without image-edit support before asset reads or network dispatch', async () => {
    const fetchImpl = vi.fn(async () => response({ data: [{ b64_json: 'aGVsbG8=' }] })) as unknown as typeof fetch
    const { service, assets } = setup(fetchImpl)
    await expect(service.edit(4, {
      requestId: 'edit-unsupported', group: '生图分组', model: 'jimeng_high_aes_general_v21_L', prompt: '改成夜景',
      sourceAssetIds: ['a'.repeat(43)],
    })).rejects.toThrow('不支持图片编辑')
    expect(assets.readOwned).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('enforces the aggregate edit-source size before dispatch', async () => {
    const fetchImpl = vi.fn(async () => response({ data: [{ b64_json: 'aGVsbG8=' }] })) as unknown as typeof fetch
    const { service, assets } = setup(fetchImpl)
    vi.mocked(assets.readOwned).mockResolvedValue({
      asset: {
        assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}`,
        mimeType: 'image/png', fileName: 'large.png',
      },
      bytes: Buffer.alloc(64 * 1024 * 1024 + 1),
    })
    await expect(service.edit(4, {
      requestId: 'edit-large', group: 'g', model: 'gpt-image-2', prompt: 'p', sourceAssetIds: ['a'.repeat(43)],
    })).rejects.toThrow('64 MB')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports cancellation during local asset validation as not dispatched', async () => {
    let release!: (value: Awaited<ReturnType<AiImageAssetWriter['readOwned']>>) => void
    const fetchImpl = vi.fn(async () => response({ data: [{ b64_json: 'aGVsbG8=' }] })) as unknown as typeof fetch
    const { service, assets } = setup(fetchImpl)
    vi.mocked(assets.readOwned).mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const pending = service.edit(4, {
      requestId: 'edit-cancel-local', group: 'g', model: 'gpt-image-2', prompt: 'p', sourceAssetIds: ['a'.repeat(43)],
    })
    await vi.waitFor(() => expect(assets.readOwned).toHaveBeenCalled())
    expect(service.cancel(4, 'edit-cancel-local')).toEqual({ canceled: true, mayStillComplete: false })
    release({
      asset: {
        assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}`,
        mimeType: 'image/png', fileName: 'source.png',
      },
      bytes: Buffer.from('source'),
    })
    await expect(pending).rejects.toThrow('已取消生图请求')
    expect(fetchImpl).not.toHaveBeenCalled()
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

  it('bounds concurrency and cancels queued work without resolving credentials or fetching', async () => {
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof fetch
    const { service, credentials } = setup(fetchImpl, { maxActive: 1, maxQueued: 1 })
    const running = service.generate(4, {
      requestId: 'bounded-running', group: '生图分组', model: 'gpt-image-2', prompt: '图一',
    })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    const queued = service.generate(4, {
      requestId: 'bounded-queued', group: '生图分组', model: 'gpt-image-2', prompt: '图二',
    })

    expect(service.cancel(4, 'bounded-queued')).toEqual({ canceled: true, mayStillComplete: false })
    await expect(queued).rejects.toThrow('已取消生图请求')
    expect(credentials.resolveCredential).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    expect(service.cancel(4, 'bounded-running')).toEqual({ canceled: true, mayStillComplete: true })
    await expect(running).rejects.toThrow('服务端可能仍在生成')
  })

  it('rejects work beyond maxQueued without starting credentials or fetch', async () => {
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof fetch
    const { service, credentials } = setup(fetchImpl, { maxActive: 1, maxQueued: 1 })
    const running = service.generate(4, {
      requestId: 'full-running', group: '生图分组', model: 'gpt-image-2', prompt: '图一',
    })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    const queued = service.generate(4, {
      requestId: 'full-queued', group: '生图分组', model: 'gpt-image-2', prompt: '图二',
    })

    await expect(service.generate(4, {
      requestId: 'full-overflow', group: '生图分组', model: 'gpt-image-2', prompt: '图三',
    })).rejects.toThrow('队列已满')
    expect(credentials.resolveCredential).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    expect(service.cancelAll()).toBe(2)
    await expect(running).rejects.toThrow('服务端可能仍在生成')
    await expect(queued).rejects.toThrow('已取消生图请求')
  })

  it('shutdown aborts active work, rejects queued work, and closes the service queue', async () => {
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof fetch
    const { service } = setup(fetchImpl, { maxActive: 1, maxQueued: 1 })
    const running = service.generate(4, {
      requestId: 'shutdown-running', group: '生图分组', model: 'gpt-image-2', prompt: '图一',
    })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    const queued = service.generate(4, {
      requestId: 'shutdown-queued', group: '生图分组', model: 'gpt-image-2', prompt: '图二',
    })

    expect(service.shutdown()).toBe(2)
    await expect(running).rejects.toThrow('服务端可能仍在生成')
    await expect(queued).rejects.toThrow('已取消生图请求')
    await expect(service.generate(4, {
      requestId: 'shutdown-rejected', group: '生图分组', model: 'gpt-image-2', prompt: '图三',
    })).rejects.toThrow('队列已关闭')
    expect(service.shutdown()).toBe(0)
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
