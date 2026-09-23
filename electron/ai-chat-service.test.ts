import { describe, expect, it, vi } from 'vitest'
import {
  AI_CHAT_STREAM_LIMITS,
  createAiChatService,
  type AiChatStreamEvent,
  type AiChatStreamLogEntry,
} from './ai-chat-service'
import { ChatKeyQuotaExhaustedError, type ChatCredentialCoordinator } from './chat-credential-coordinator'
import { networkFailureMessages } from './network-failure'
import { relayQuotaFailureMessages } from './relay-quota-failure'

const encoder = new TextEncoder()
type TestFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

function credentialCoordinator(apiKey = 'sk-super-secret-never-emit') {
  return {
    resolveCredential: vi.fn(async (group: string) => ({
      userId: 7,
      group,
      models: ['gpt-5.4'],
      keyCreated: false,
      apiKey,
      keyId: 3,
      keyName: 'chat-key',
    })),
  } as Pick<ChatCredentialCoordinator, 'resolveCredential'>
}

function sseResponse(chunks: readonly Uint8Array[], delayBeforeCloseMs = 0): Response {
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (delayBeforeCloseMs > 0) await new Promise((resolve) => setTimeout(resolve, delayBeforeCloseMs))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

function controlledSseResponse() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value },
  }), { headers: { 'content-type': 'text/event-stream' } })
  return {
    response,
    enqueue(value: string) { controller?.enqueue(encoder.encode(value)) },
    close() { controller?.close() },
  }
}

function startInput(senderId = 1, requestId = 'request-1') {
  return {
    senderId,
    requestId,
    group: 'codex-pro',
    model: 'gpt-5.4',
    messages: [{ role: 'user' as const, content: '你好' }],
  }
}

describe('AI chat streaming service', () => {
  it('decodes UTF-8 across chunks, handles reasoning/content/DONE, and final-flushes one batch', async () => {
    const events: Array<{ senderId: number; event: AiChatStreamEvent }> = []
    const full = encoder.encode([
      'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''))
    const splitInsideChineseCodePoint = full.findIndex((byte) => byte >= 0xe0) + 1
    const fetchImpl = vi.fn<TestFetch>(async () => sseResponse([
      full.slice(0, splitInsideChineseCodePoint),
      full.slice(splitInsideChineseCodePoint),
    ]))
    const service = createAiChatService({
      credentialCoordinator: credentialCoordinator(),
      fetchImpl,
      emit: (senderId, event) => events.push({ senderId, event }),
    })

    expect(service.start(startInput())).toEqual({ accepted: true, requestId: 'request-1' })
    await service.whenIdle()

    expect(events).toEqual([
      {
        senderId: 1,
        event: {
          type: 'delta',
          requestId: 'request-1',
          sequence: 1,
          content: '你好',
          reasoning: '思考',
        },
      },
      {
        senderId: 1,
        event: expect.objectContaining({
          type: 'complete',
          requestId: 'request-1',
          sequence: 2,
          outputBytes: Buffer.byteLength('你好思考'),
        }),
      },
    ])
    const [, init] = fetchImpl.mock.calls[0]
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://xm.solov.cc/v1/chat/completions')
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-5.4', stream: true })
    expect(JSON.parse(String(init?.body))).toHaveProperty('messages')
    expect(init?.credentials).toBe('omit')
  })

  it('allows a slow first response and accepts finish_reason without a trailing DONE frame', async () => {
    expect(AI_CHAT_STREAM_LIMITS.connectionTimeoutMs).toBe(60_000)
    const events: AiChatStreamEvent[] = []
    const fetchImpl = vi.fn<TestFetch>(async () => sseResponse([
      encoder.encode([
        'data: {"choices":[{"message":{"refusal":"这个请求无法处理"},"finish_reason":"stop"}]}\n\n',
      ].join('')),
    ]))
    const service = createAiChatService({
      credentialCoordinator: credentialCoordinator(),
      fetchImpl,
      emit: (_senderId, event) => events.push(event),
    })

    service.start(startInput())
    await service.whenIdle()

    expect(events).toEqual([
      expect.objectContaining({ type: 'delta', content: '这个请求无法处理' }),
      expect.objectContaining({ type: 'complete' }),
    ])
  })

  it('rejects a model outside the resolved group before sending a paid request', async () => {
    const events: AiChatStreamEvent[] = []
    const fetchImpl = vi.fn<TestFetch>()
    const coordinator = credentialCoordinator()
    coordinator.resolveCredential = vi.fn(async (group: string) => ({
      userId: 7,
      group,
      models: ['another-model'],
      keyCreated: false,
      apiKey: 'sk-never-sent',
      keyId: 3,
      keyName: 'chat-key',
    }))
    const service = createAiChatService({
      credentialCoordinator: coordinator,
      fetchImpl,
      emit: (_senderId, event) => events.push(event),
    })

    service.start(startInput())
    await service.whenIdle()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'model-unavailable' })])
  })

  it('says the chat key\'s own cap is used up instead of the generic preparation failure', async () => {
    const events: AiChatStreamEvent[] = []
    const fetchImpl = vi.fn<TestFetch>()
    const coordinator = credentialCoordinator()
    coordinator.resolveCredential = vi.fn(async () => { throw new ChatKeyQuotaExhaustedError() })
    const service = createAiChatService({
      credentialCoordinator: coordinator,
      fetchImpl,
      emit: (_senderId, event) => events.push(event),
    })

    service.start(startInput())
    await service.whenIdle()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'key-quota-exhausted', message: relayQuotaFailureMessages.keyLimit })])
  })

  it('coalesces nearby chunks on the configured batching interval', async () => {
    const stream = controlledSseResponse()
    const events: AiChatStreamEvent[] = []
    const service = createAiChatService({
      credentialCoordinator: credentialCoordinator(),
      fetchImpl: vi.fn(async () => stream.response),
      emit: (_senderId, event) => events.push(event),
      limits: { batchIntervalMs: 5 },
    })
    service.start(startInput())
    await vi.waitFor(() => expect(service.activeCount()).toBe(1))
    stream.enqueue('data: {"choices":[{"delta":{"content":"A"}}]}\n\n')
    stream.enqueue('data: {"choices":[{"delta":{"content":"B"}}]}\n\n')
    await new Promise((resolve) => setTimeout(resolve, 15))
    stream.enqueue('data: [DONE]\n\n')
    await service.whenIdle()

    expect(events.filter((event) => event.type === 'delta')).toEqual([expect.objectContaining({ content: 'AB' })])
  })

  it('owns identical request IDs independently by sender and drops all late data after cancel', async () => {
    const streams = [controlledSseResponse(), controlledSseResponse()]
    const events: Array<{ senderId: number; event: AiChatStreamEvent }> = []
    let nextStream = 0
    const fetchImpl = vi.fn<TestFetch>(async () => streams[nextStream++].response)
    const service = createAiChatService({
      credentialCoordinator: credentialCoordinator(),
      fetchImpl,
      emit: (senderId, event) => events.push({ senderId, event }),
    })
    service.start(startInput(11, 'same-id'))
    service.start(startInput(22, 'same-id'))
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))

    expect(service.cancel(22, 'missing')).toBe(false)
    expect(service.cancel(11, 'same-id')).toBe(true)
    expect(service.cancel(11, 'same-id')).toBe(false)
    streams[1].enqueue('data: {"choices":[{"delta":{"content":"sender-two"}}]}\n\n')
    streams[1].enqueue('data: [DONE]\n\n')
    await service.whenIdle()

    expect(events.filter(({ senderId }) => senderId === 11)).toEqual([{
      senderId: 11,
      event: { type: 'canceled', requestId: 'same-id', sequence: 1 },
    }])
    expect(events.some(({ senderId, event }) => senderId === 22 && event.type === 'delta')).toBe(true)
    expect(events.every(({ senderId, event }) => senderId !== 11 || event.type === 'canceled')).toBe(true)
  })

  it('cancelSender and cancelUser terminate only requests they own', async () => {
    const streams = [controlledSseResponse(), controlledSseResponse(), controlledSseResponse()]
    let nextStream = 0
    const fetchImpl = vi.fn<TestFetch>(async () => streams[nextStream++].response)
    const service = createAiChatService({
      credentialCoordinator: credentialCoordinator(),
      fetchImpl,
      emit: vi.fn(),
    })
    service.start(startInput(1, 'a'))
    service.start(startInput(1, 'b'))
    service.start(startInput(2, 'c'))
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3))

    expect(service.cancelSender(1)).toBe(2)
    expect(service.activeCount()).toBe(1)
    expect(service.cancelUser(7)).toBe(1)
    expect(service.activeCount()).toBe(0)
  })

  it('applies connection, idle, and total timeouts with safe errors', async () => {
    const runCase = async (
      fetchImpl: () => Promise<Response>,
      limits: { connectionTimeoutMs?: number; idleTimeoutMs?: number; totalTimeoutMs?: number },
      expectedCode: string,
    ) => {
      const events: AiChatStreamEvent[] = []
      const service = createAiChatService({
        credentialCoordinator: credentialCoordinator(),
        fetchImpl,
        emit: (_senderId, event) => events.push(event),
        limits: {
          connectionTimeoutMs: 15,
          idleTimeoutMs: 15,
          totalTimeoutMs: 40,
          ...limits,
        },
      })
      service.start(startInput())
      await service.whenIdle()
      expect(events.at(-1)).toMatchObject({ type: 'error', code: expectedCode })
    }

    await runCase(() => new Promise(() => undefined), { connectionTimeoutMs: 5 }, 'connection-timeout')
    const idle = controlledSseResponse()
    await runCase(async () => idle.response, { idleTimeoutMs: 5 }, 'idle-timeout')
    await runCase(() => new Promise(() => undefined), { connectionTimeoutMs: 50, totalTimeoutMs: 5 }, 'total-timeout')
  })

  it('enforces event, fragment, output, and cumulative response bounds', async () => {
    const runBound = async (payload: string, limits: Record<string, number>, expectedCode: string) => {
      const events: AiChatStreamEvent[] = []
      const service = createAiChatService({
        credentialCoordinator: credentialCoordinator(),
        fetchImpl: vi.fn(async () => sseResponse([encoder.encode(payload)])),
        emit: (_senderId, event) => events.push(event),
        limits,
      })
      service.start(startInput())
      await service.whenIdle()
      expect(events.at(-1)).toMatchObject({ type: 'error', code: expectedCode })
    }

    await runBound(`data: ${'x'.repeat(200)}\n\n`, { eventBytes: 100, fragmentBytes: 50 }, 'event-limit-exceeded')
    await runBound(
      `data: {"choices":[{"delta":{"content":"${'x'.repeat(80)}"}}]}\n\n`,
      { eventBytes: 200, fragmentBytes: 50 },
      'fragment-limit-exceeded',
    )
    await runBound(
      'data: {"choices":[{"delta":{"content":"123456"}}]}\n\n'
        + 'data: {"choices":[{"delta":{"content":"789012"}}]}\n\n',
      { eventBytes: 100, fragmentBytes: 50, outputBytes: 10 },
      'output-limit-exceeded',
    )
    await runBound(
      'data: {"choices":[{"delta":{"content":"123"}}]}\n\n',
      { eventBytes: 100, fragmentBytes: 50, responseBytes: 20, errorBytes: 10 },
      'response-limit-exceeded',
    )
  })

  it('never emits API keys, Authorization, upstream URLs, or raw error bodies', async () => {
    const secret = 'sk-production-secret-123456'
    const upstreamBody = JSON.stringify({
      error: { message: `Bearer ${secret} failed at https://private.example/path` },
    })
    const events: AiChatStreamEvent[] = []
    const fetchImpl = vi.fn<TestFetch>(async () => new Response(upstreamBody, {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }))
    const logs: AiChatStreamLogEntry[] = []
    const service = createAiChatService({
      credentialCoordinator: credentialCoordinator(secret),
      fetchImpl,
      emit: (_senderId, event) => events.push(event),
      log: (entry) => logs.push(entry),
    })
    service.start(startInput())
    await service.whenIdle()

    const exposed = JSON.stringify({ events, logs })
    expect(exposed).not.toContain(secret)
    expect(exposed).not.toContain('Authorization')
    expect(exposed).not.toContain('private.example')
    expect(events).toEqual([expect.objectContaining({
      type: 'error',
      code: 'upstream-http-error',
      message: '当前 API Key 无权使用所选模型或分组',
    })])
    expect(logs[0]).toEqual(expect.objectContaining({
      requestId: 'request-1',
      status: 'error',
      phase: 'response-headers',
      errorCode: 'upstream-http-error',
      httpStatus: 403,
      receivedBytes: 0,
      outputBytes: 0,
    }))
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${secret}` })
  })

  it.each([
    [403, { error: { message: '用户额度不足, 剩余额度: ＄0.000000 (request id: r1)', type: 'new_api_error', code: 'insufficient_user_quota' } }, relayQuotaFailureMessages.balance],
    [403, { error: { message: 'token quota is not enough, token remain quota: ＄0.001000, need quota: ＄0.050000', code: 'pre_consume_token_quota_failed' } }, relayQuotaFailureMessages.keyLimit],
    [401, { error: { message: '无效的令牌 (request id: r2)', type: 'new_api_error', code: '' } }, relayQuotaFailureMessages.keyInvalid],
    [403, { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient account balance' }, relayQuotaFailureMessages.balance],
    [429, { error: { message: 'API key 额度已用完', type: 'insufficient_quota', code: 'insufficient_quota' } }, relayQuotaFailureMessages.keyLimit],
    [429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }, '请求过于频繁，请稍后重试'],
  ])('tells balance, key limit and dead key apart on HTTP %s', async (status, payload, expected) => {
    const events: AiChatStreamEvent[] = []
    const service = createAiChatService({
      credentialCoordinator: credentialCoordinator(),
      fetchImpl: vi.fn<TestFetch>(async () => new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })),
      emit: (_senderId, event) => events.push(event),
    })
    service.start(startInput())
    await service.whenIdle()
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'upstream-http-error', message: expected })])
  })

  it('falls back to the status-only wording when the error body is oversized', async () => {
    const events: AiChatStreamEvent[] = []
    const body = JSON.stringify({ error: { message: `用户额度不足${'x'.repeat(20 * 1024)}` } })
    const service = createAiChatService({
      credentialCoordinator: credentialCoordinator(),
      fetchImpl: vi.fn<TestFetch>(async () => new Response(body, { status: 403 })),
      emit: (_senderId, event) => events.push(event),
    })
    service.start(startInput())
    await service.whenIdle()
    expect(events).toEqual([expect.objectContaining({ message: '当前 API Key 无权使用所选模型或分组' })])
  })

  it.each([
    ['a gateway error page', 502, { 'content-type': 'text/html' }],
    ['an edge origin timeout', 522, { 'content-type': 'text/html' }],
    ['a managed challenge', 403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }],
  ])('says the service is unavailable for %s instead of blaming the key', async (_label, status, headers) => {
    const events: AiChatStreamEvent[] = []
    const service = createAiChatService({
      credentialCoordinator: credentialCoordinator(),
      fetchImpl: vi.fn<TestFetch>(async () => new Response('<html>Just a moment...</html>', { status, headers })),
      emit: (_senderId, event) => events.push(event),
    })
    service.start(startInput())
    await service.whenIdle()
    expect(events).toEqual([expect.objectContaining({
      type: 'error',
      code: 'service-unavailable',
      message: networkFailureMessages.serviceUnavailable,
    })])
  })

  it('keeps a JSON 403 from the relay on the key and group wording', async () => {
    const events: AiChatStreamEvent[] = []
    const service = createAiChatService({
      credentialCoordinator: credentialCoordinator(),
      fetchImpl: vi.fn<TestFetch>(async () => new Response('{"error":{"message":"forbidden"}}', { status: 403, headers: { 'content-type': 'application/json', server: 'cloudflare' } })),
      emit: (_senderId, event) => events.push(event),
    })
    service.start(startInput())
    await service.whenIdle()
    expect(events).toEqual([expect.objectContaining({ code: 'upstream-http-error' })])
  })

  it('does not blame the login or the key when preparing the group fails because the service is down', async () => {
    const coordinator = credentialCoordinator()
    coordinator.resolveCredential = vi.fn(async () => {
      throw new Error(`${networkFailureMessages.serviceUnavailable}（HTTP 503）`)
    })
    const events: AiChatStreamEvent[] = []
    const fetchImpl = vi.fn<TestFetch>()
    const service = createAiChatService({ credentialCoordinator: coordinator, fetchImpl, emit: (_senderId, event) => events.push(event) })
    service.start(startInput())
    await service.whenIdle()
    expect(events).toEqual([expect.objectContaining({ code: 'service-unavailable' })])
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(service.completeOnce({ group: 'default', model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(networkFailureMessages.serviceUnavailable)
  })

  it('rejects media models, duplicate ownership keys, and excessive per-sender concurrency', async () => {
    const streams = Array.from({ length: 3 }, () => controlledSseResponse())
    let nextStream = 0
    const fetchImpl = vi.fn<TestFetch>(async () => streams[nextStream++].response)
    const service = createAiChatService({
      credentialCoordinator: credentialCoordinator(),
      fetchImpl,
      emit: vi.fn(),
      limits: { concurrentRequestsPerSender: 2 },
    })
    expect(() => service.start({ ...startInput(), model: 'gpt-image-2' })).toThrow('media models')
    expect(() => service.start({ ...startInput(), model: 'grok-imagine-video' })).toThrow('media models')
    service.start(startInput(1, 'a'))
    expect(() => service.start(startInput(1, 'a'))).toThrow('正在处理中')
    service.start(startInput(1, 'b'))
    expect(() => service.start(startInput(1, 'c'))).toThrow('当前窗口')
    service.dispose()
    await service.whenIdle()
  })

  it('collects a completeOnce stream without emitting to a renderer', async () => {
    const emit = vi.fn()
    const fetchImpl = vi.fn<TestFetch>(async () => sseResponse([
      encoder.encode('data: {"choices":[{"delta":{"content":"{\\"shots\\":[]}"}}]}\n\n'),
      encoder.encode('data: [DONE]\n\n'),
    ]))
    const service = createAiChatService({
      credentialCoordinator: credentialCoordinator(),
      fetchImpl,
      emit,
    })
    const text = await service.completeOnce({
      group: 'Gemini',
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: '解析' }],
    })
    expect(text).toContain('shots')
    expect(emit).not.toHaveBeenCalled()
    expect(fetchImpl.mock.calls[0][1]?.credentials).toBe('omit')
    service.dispose()
  })

  it('says what went wrong with the network instead of blaming the key when preparing the group fails offline', async () => {
    const coordinator = credentialCoordinator()
    coordinator.resolveCredential = vi.fn(async () => {
      throw new Error(networkFailureMessages.offline)
    })
    const events: AiChatStreamEvent[] = []
    const fetchImpl = vi.fn<TestFetch>()
    const service = createAiChatService({ credentialCoordinator: coordinator, fetchImpl, emit: (_senderId, event) => events.push(event) })
    service.start(startInput())
    await service.whenIdle()
    expect(events).toEqual([expect.objectContaining({ code: 'network-error', message: networkFailureMessages.offline })])
    await expect(service.completeOnce({ group: 'default', model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(networkFailureMessages.offline)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('stops a completeOnce request while the key is still being prepared, before anything is sent', async () => {
    const coordinator = credentialCoordinator()
    const resolveCredential = coordinator.resolveCredential
    let releaseCredential: () => void = () => undefined
    const credentialGate = new Promise<void>((resolve) => { releaseCredential = resolve })
    coordinator.resolveCredential = vi.fn(async (group: string) => {
      await credentialGate
      return resolveCredential(group)
    })
    const fetchImpl = vi.fn<TestFetch>()
    const service = createAiChatService({ credentialCoordinator: coordinator, fetchImpl, emit: vi.fn() })
    const stop = new AbortController()
    const pending = service.completeOnce({ group: 'Gemini', model: 'gpt-5.4', messages: [{ role: 'user', content: '解析' }], signal: stop.signal })
    await vi.waitFor(() => expect(coordinator.resolveCredential).toHaveBeenCalledOnce())
    stop.abort()
    releaseCredential()
    await expect(pending).rejects.toThrow('已取消')
    expect(fetchImpl).not.toHaveBeenCalled()
    service.dispose()
  })

  it('reports a completeOnce total timeout as a timeout, not as a cancel', async () => {
    const fetchImpl = vi.fn<TestFetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const service = createAiChatService({
      credentialCoordinator: credentialCoordinator(),
      fetchImpl,
      emit: vi.fn(),
      limits: { totalTimeoutMs: 5 },
    })
    await expect(service.completeOnce({ group: 'Gemini', model: 'gpt-5.4', messages: [{ role: 'user', content: '解析' }] }))
      .rejects.toThrow('本次对话超过最长处理时间')
    service.dispose()
  })

  it('does not hand back half an answer when a completeOnce stream closes without finishing', async () => {
    const fetchImpl = vi.fn<TestFetch>(async () => sseResponse([
      encoder.encode('data: {"choices":[{"delta":{"content":"{\\"shots\\":["}}]}\n\n'),
    ]))
    const service = createAiChatService({ credentialCoordinator: credentialCoordinator(), fetchImpl, emit: vi.fn() })
    await expect(service.completeOnce({ group: 'Gemini', model: 'gpt-5.4', messages: [{ role: 'user', content: '解析' }] }))
      .rejects.toThrow('AI 服务提前结束了本次响应')

    const finished = vi.fn<TestFetch>(async () => sseResponse([
      encoder.encode('data: {"choices":[{"delta":{"content":"完整"},"finish_reason":"stop"}]}\n\n'),
    ]))
    const finishing = createAiChatService({ credentialCoordinator: credentialCoordinator(), fetchImpl: finished, emit: vi.fn() })
    await expect(finishing.completeOnce({ group: 'Gemini', model: 'gpt-5.4', messages: [{ role: 'user', content: '解析' }] }))
      .resolves.toBe('完整')
    service.dispose()
    finishing.dispose()
  })

  it('rejects an unavailable completeOnce model before sending a request', async () => {
    const fetchImpl = vi.fn<TestFetch>()
    const service = createAiChatService({
      credentialCoordinator: credentialCoordinator(),
      fetchImpl,
      emit: vi.fn(),
    })

    await expect(service.completeOnce({
      group: 'Gemini',
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: '解析' }],
    })).rejects.toThrow('当前模型不在所选分组')
    expect(fetchImpl).not.toHaveBeenCalled()
    service.dispose()
  })
})
