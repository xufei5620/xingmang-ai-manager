import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildConnectionProbe } from './connection-check'
import {
  buildCodexResponsesRequest,
  createCodexResponsesProbeService,
  inspectCodexResponsesFinalAnswer,
  inspectCodexResponsesFunctionCall,
  runCodexResponsesProbe,
} from './codex-responses-probe'
import type { NativeConfigInspection } from './config-files'
import { resolveRelaySite } from './relay-sites'

const site = resolveRelaySite('solov')
const key = 'sk-responses-test-secret'
const model = 'gpt-6-astra'
const endpoint = 'https://xm.solov.cc/v1/responses'
const marker = 'XINGMANG_0123456789abcdef01234567'

function inspection(overrides: Partial<NativeConfigInspection> = {}): NativeConfigInspection {
  return {
    baseUrl: site.providerBaseUrls.codex,
    actualBaseUrl: site.providerBaseUrls.codex,
    exists: true,
    hasApiKey: true,
    matchesRelay: true,
    apiKey: key,
    model,
    dataDirectory: 'C:\\test\\.codex',
    dataDirectoryExists: true,
    files: [],
    updatedAt: null,
    ...overrides,
  }
}

function build() {
  return buildConnectionProbe('codex', site, inspection())
}

function reply(payload: unknown, status = 200, url = endpoint): Response {
  const response = Response.json(payload, { status })
  Object.defineProperty(response, 'url', { value: url })
  return response
}

function functionCall(argumentsText = '{}', name = 'xingmang_probe_echo', callId = 'call_fixed123') {
  return {
    object: 'response', id: 'resp_first', status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'function_call', id: 'fc_1', call_id: callId, name, arguments: argumentsText },
    ],
  }
}

function finalAnswer(text = marker) {
  return {
    object: 'response', id: 'resp_second', status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
  }
}

function mockReplies(...responses: Response[]): {
  fetch: typeof globalThis.fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const response = responses.shift()
    if (!response) throw new Error('Unexpected third request')
    return response
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

describe('Codex Responses tool roundtrip', () => {
  it('sends exactly two stateless bounded requests and verifies the fixed result', async () => {
    const mock = mockReplies(reply(functionCall()), reply(finalAnswer()))
    const markerFactory = vi.fn(() => marker)
    const result = await runCodexResponsesProbe(build(), { fetch: mock.fetch, markerFactory })
    expect(result).toMatchObject({
      ok: true, layer: 'network', verificationLevel: 'responses-tool-json',
      endpoint, model, status: 200,
    })
    expect(result.summary).toBe(`${model} 能正常调用工具`)
    expect(result.evidence).toContain('测试工具')
    expect(JSON.stringify(result)).not.toContain(key)
    expect(mock.calls).toHaveLength(2)
    for (const call of mock.calls) {
      expect(call.url).toBe(endpoint)
      expect(call.init).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'omit' })
      expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`)
    }
    const first = JSON.parse(String(mock.calls[0].init.body)) as Record<string, unknown>
    const second = JSON.parse(String(mock.calls[1].init.body)) as Record<string, unknown>
    expect(first).toMatchObject({
      model, store: false, stream: false, parallel_tool_calls: false,
      tool_choice: { type: 'function', name: 'xingmang_probe_echo' },
    })
    expect(first.max_output_tokens).toBeLessThanOrEqual(1024)
    expect(JSON.stringify(first)).not.toContain(marker)
    expect(markerFactory).toHaveBeenCalledTimes(1)
    expect(first.tools).toEqual([{
      type: 'function', name: 'xingmang_probe_echo', description: expect.any(String),
      strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    }])
    expect(second).toMatchObject({ model, store: false, stream: false, tool_choice: 'none' })
    expect(second).not.toHaveProperty('previous_response_id')
    expect(second.input).toEqual([
      (first.input as unknown[])[0],
      { type: 'reasoning', id: 'rs_1', summary: [] },
      functionCall().output[1],
      { type: 'function_call_output', call_id: 'call_fixed123', output: marker },
    ])
  })

  it('never accepts other tools, arguments, call ids or multiple calls', async () => {
    for (const invalid of [
      functionCall('{}', 'shell'),
      functionCall('{"command":"whoami"}'),
      functionCall('{}', 'xingmang_probe_echo', 'bad id'),
      { ...functionCall(), output: [{ ...functionCall().output[1], status: 'incomplete' }] },
      { ...functionCall(), output: [functionCall().output[1], functionCall().output[1]] },
      { ...functionCall(), status: 'incomplete' },
    ]) {
      expect(inspectCodexResponsesFunctionCall(invalid)).toBeNull()
      const mock = mockReplies(reply(invalid))
      expect(await runCodexResponsesProbe(build(), { fetch: mock.fetch })).toMatchObject({
        ok: false, layer: 'protocol',
      })
      expect(mock.calls).toHaveLength(1)
    }
  })

  it('requires the completed assistant marker after sending the tool result', async () => {
    for (const invalid of [
      finalAnswer('anything else'),
      { ...finalAnswer(), status: 'failed' },
      { ...finalAnswer(), output: [functionCall().output[1]] },
    ]) {
      expect(inspectCodexResponsesFinalAnswer(invalid, marker)).toBe(false)
      const mock = mockReplies(reply(functionCall()), reply(invalid))
      expect(await runCodexResponsesProbe(build(), { fetch: mock.fetch, markerFactory: () => marker })).toMatchObject({
        ok: false, layer: 'protocol',
      })
      expect(mock.calls).toHaveLength(2)
    }
  })

  it('reports incomplete responses as an output-limit issue rather than a key failure', async () => {
    const incomplete = { ...functionCall(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
    const first = mockReplies(reply(incomplete))
    const firstResult = await runCodexResponsesProbe(build(), { fetch: first.fetch })
    expect(firstResult).toMatchObject({ ok: false, layer: 'protocol' })
    expect(firstResult.summary).toBe('模型没答完就停了')
    expect(first.calls).toHaveLength(1)

    const second = mockReplies(reply(functionCall()), reply({ ...finalAnswer(), status: 'incomplete' }))
    const secondResult = await runCodexResponsesProbe(build(), { fetch: second.fetch, markerFactory: () => marker })
    expect(secondResult.summary).toBe('模型没答完就停了')
    expect(second.calls).toHaveLength(2)
  })

  it('rejects HTTP errors, redirects and oversized responses before round two', async () => {
    const revoked = mockReplies(reply({ error: { message: `令牌 ${key} 无效` } }, 401))
    const rejected = await runCodexResponsesProbe(build(), { fetch: revoked.fetch })
    expect(rejected.layer).toBe('credential')
    expect(JSON.stringify(rejected)).not.toContain(key)
    expect(revoked.calls).toHaveLength(1)

    for (const mock of [
      mockReplies(reply({}, 302)),
      mockReplies(reply(functionCall(), 200, 'https://elsewhere.invalid/v1/responses')),
    ]) {
      expect(await runCodexResponsesProbe(build(), { fetch: mock.fetch })).toMatchObject({
        ok: false, layer: 'protocol',
      })
      expect(mock.calls).toHaveLength(1)
      expect((mock.calls[0].init.signal as AbortSignal).aborted).toBe(true)
    }
    const oversized = mockReplies(reply({ large: 'x'.repeat(200) }))
    expect(await runCodexResponsesProbe(build(), {
      fetch: oversized.fetch, maxResponseBytes: 64,
    })).toMatchObject({ ok: false, layer: 'protocol' })
    expect(oversized.calls).toHaveLength(1)
  })

  it('blocks untrusted local config and shares an in-flight charged check', async () => {
    const blocked = buildConnectionProbe('codex', site, inspection({
      actualBaseUrl: 'https://other.invalid/v1', matchesRelay: false,
    }))
    const noNetwork = mockReplies()
    expect(await runCodexResponsesProbe(blocked, { fetch: noNetwork.fetch })).toMatchObject({
      ok: false, layer: 'config',
    })
    expect(noNetwork.calls).toHaveLength(0)

    const mock = mockReplies(reply(functionCall()), reply(finalAnswer()))
    const service = createCodexResponsesProbeService(build, { fetch: mock.fetch, markerFactory: () => marker })
    const first = service.run()
    const second = service.run()
    expect(first).toBe(second)
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(mock.calls).toHaveLength(2)
  })

  it('stops before the second billed request when account or config changes', async () => {
    let scope = 'solov:user-1:key-a'
    let releaseFirst!: (value: Response) => void
    const firstResponse = new Promise<Response>((resolve) => { releaseFirst = resolve })
    const calls: RequestInit[] = []
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init)
      return firstResponse
    }) as unknown as typeof globalThis.fetch
    const service = createCodexResponsesProbeService(build, {
      fetch,
      currentScope: () => scope,
      markerFactory: () => marker,
    })
    const pending = service.run()
    scope = 'solov:user-2:key-b'
    await expect(service.run()).rejects.toThrow('设置变了')
    releaseFirst(reply(functionCall()))
    const result = await pending
    expect(result).toMatchObject({ ok: false, layer: 'config' })
    expect(result.summary).toContain('第二次请求没有发')
    expect(calls).toHaveLength(1)
  })

  it('redacts transport errors and uses a fixed harmless tool', async () => {
    const fetch = vi.fn(async () => { throw new Error(`socket error ${key}`) }) as unknown as typeof globalThis.fetch
    const result = await runCodexResponsesProbe(build(), { fetch })
    expect(result).toMatchObject({ ok: false, layer: 'network' })
    expect(JSON.stringify(result)).not.toContain(key)
    expect(JSON.stringify(buildCodexResponsesRequest(model))).not.toContain('shell')
  })

  it('bounds the whole two-request operation with one abort deadline', async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })) as unknown as typeof globalThis.fetch
    const result = await runCodexResponsesProbe(build(), { fetch, timeoutMs: 5 })
    expect(result).toMatchObject({ ok: false, layer: 'network' })
    expect(result.summary).toContain('超时')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps every on-screen result free of protocol jargon and site names', () => {
    const source = readFileSync(join(__dirname, 'codex-responses-probe.ts'), 'utf8')
    const shown = [...source.matchAll(/finish\(\s*'[a-z]+',\s*(['`][^'`]*['`]),\s*(['`][^'`]*['`])/g)]
      .flatMap((match) => [match[1], match[2]])
    expect(shown.length).toBeGreaterThanOrEqual(24)
    for (const text of shown) expect(text).not.toMatch(/JSON|token|Responses|虚拟|流式|星芒|中转|协议/i)
  })
})
