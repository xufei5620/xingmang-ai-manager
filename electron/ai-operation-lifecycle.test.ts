import { describe, expect, it, vi } from 'vitest'
import { observeAiOperation, type AiOperationStartedObserver } from './ai-operation-lifecycle'
import { createAiChatService, type StartAiChatStreamInput } from './ai-chat-service'
import { createAiImageService } from './ai-image-service'

function credentials() {
  return { resolveCredential: vi.fn(async (group: string) => ({
    userId: 7, group, apiKey: 'sk-test-not-real', keyId: 3, keyName: 'test',
    keyCreated: false, models: ['gpt-5.4', 'gpt-image-2'],
  })) }
}

function chatInput(): StartAiChatStreamInput {
  return { senderId: 1, requestId: 'chat-activity', group: 'test', model: 'gpt-5.4',
    messages: [{ role: 'user', content: 'test' }] }
}

function textResponse(): Response {
  return new Response('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } })
}

function imageService(fetchImpl: typeof fetch, onRequestStarted: AiOperationStartedObserver) {
  return createAiImageService({
    baseUrl: 'https://example.invalid', credentials: credentials(), fetchImpl, onRequestStarted,
    assets: {
      storeBase64: async () => ({ assetId: 'test', fileName: 'test.png', localUrl: 'test', mimeType: 'image/png' }),
      storeRemoteUrl: async () => { throw new Error('not used') },
      readOwned: async () => ({ asset: { assetId: 'test', fileName: 'test.png', localUrl: 'test', mimeType: 'image/png' }, bytes: Buffer.from('test') }),
    },
  })
}

describe('AI request lifecycle observation', () => {
  it('does not let observer errors alter an operation and settles once', () => {
    expect(() => observeAiOperation(() => { throw new Error('observer start') })()).not.toThrow()
    const onSettled = vi.fn(() => { throw new Error('observer complete') })
    const settle = observeAiOperation(() => onSettled)
    expect(() => { settle(); settle() }).not.toThrow()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it.each(['complete', 'error', 'canceled', 'sender-gone'] as const)('observes streaming %s exactly once', async (outcome) => {
    const onSettled = vi.fn()
    const onRequestStarted = vi.fn(() => onSettled)
    const service = createAiChatService({
      credentialCoordinator: credentials(), onRequestStarted,
      emit: () => { if (outcome === 'sender-gone') throw new Error('gone') },
      fetchImpl: async () => {
        if (outcome === 'error') throw new Error('mock network failure')
        return textResponse()
      },
    })
    service.start(chatInput())
    expect(onRequestStarted).toHaveBeenCalledTimes(1)
    expect(onSettled).not.toHaveBeenCalled()
    if (outcome === 'canceled') service.cancel(1, chatInput().requestId)
    await service.whenIdle()
    service.cancelAll()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it.each(['complete', 'error', 'canceled'] as const)('observes canvas text %s after completion', async (outcome) => {
    const onSettled = vi.fn()
    const onRequestStarted = vi.fn(() => onSettled)
    const controller = new AbortController()
    const service = createAiChatService({
      credentialCoordinator: credentials(), onRequestStarted, emit: vi.fn(),
      fetchImpl: async () => {
        if (outcome === 'canceled') controller.abort()
        if (outcome !== 'complete') throw new Error('mock network failure')
        return textResponse()
      },
    })
    const result = service.completeOnce({ ...chatInput(), signal: controller.signal })
    expect(onRequestStarted).toHaveBeenCalledTimes(1)
    expect(onSettled).not.toHaveBeenCalled()
    if (outcome === 'complete') await expect(result).resolves.toBe('done')
    else await expect(result).rejects.toThrow()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it.each(['generate', 'edit'] as const)('observes image %s completion after local assets have been stored', async (method) => {
    const onSettled = vi.fn()
    const onRequestStarted = vi.fn(() => onSettled)
    const service = imageService(async () => new Response(JSON.stringify({ data: [{ b64_json: 'dGVzdA==' }] })), onRequestStarted)
    const result = service[method](1, { requestId: 'image-activity', group: 'test', model: 'gpt-image-2',
      prompt: 'test', sourceAssetIds: ['a'.repeat(43)] })
    expect(onRequestStarted).toHaveBeenCalledTimes(1)
    expect(onSettled).not.toHaveBeenCalled()
    await expect(result).resolves.toHaveLength(1)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('observes failed image requests', async () => {
    const onSettled = vi.fn()
    const service = imageService(async () => { throw new Error('mock network failure') }, () => onSettled)
    await expect(service.generate(1, { requestId: 'image-error', group: 'test', model: 'gpt-image-2', prompt: 'test' })).rejects.toThrow()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('observes canceled image requests once even if the upstream finishes later', async () => {
    const onSettled = vi.fn()
    let resolveResponse!: (response: Response) => void
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve }))
    const service = imageService(fetchImpl, () => onSettled)
    const result = service.generate(1, { requestId: 'image-cancel', group: 'test', model: 'gpt-image-2', prompt: 'test' })
    const rejection = expect(result).rejects.toThrow('已停止等待')
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    service.cancel(1, 'image-cancel')
    await rejection
    expect(onSettled).toHaveBeenCalledTimes(1)
    resolveResponse(new Response(JSON.stringify({ data: [{ b64_json: 'dGVzdA==' }] })))
    await service.whenIdle()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })
})
