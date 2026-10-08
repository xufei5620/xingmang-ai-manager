import { describe, expect, it } from 'vitest'
import {
  buildExternalClientProbe,
  runExternalClientCheck,
  type ExternalClientProbeInput,
} from './external-client-connection'
import { externalToolIds } from './external-client-contract'
import { relaySites } from './relay-sites'

const apiKey = 'sk-external-client-test-key'
const xmSite = relaySites[0]

function input(overrides: Partial<ExternalClientProbeInput> = {}): ExternalClientProbeInput {
  return {
    tool: 'workbuddy',
    installed: true,
    baseUrl: xmSite.providerBaseUrls.codex,
    configurationSource: 'xingmang',
    model: 'gpt-5.4',
    apiKey,
    ...overrides,
  }
}

function catalogue(models: readonly string[], status = 200): typeof globalThis.fetch {
  return (async () => Response.json({ data: models.map((id) => ({ id })) }, { status })) as typeof globalThis.fetch
}

function rejection(status: number, message: string): typeof globalThis.fetch {
  return (async () => Response.json({ error: { message } }, { status })) as typeof globalThis.fetch
}

async function check(
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<ExternalClientProbeInput> = {},
) {
  return runExternalClientCheck(input(overrides), xmSite.id, {
    fetch: fetchImpl,
    now: () => new Date('2026-09-22T12:00:00.000Z'),
    elapsed: (() => {
      let value = 0
      return () => (value += 7)
    })(),
  })
}

function desktopInput(overrides: Partial<ExternalClientProbeInput> = {}): Partial<ExternalClientProbeInput> {
  return { tool: 'claudeDesktop', baseUrl: xmSite.providerBaseUrls.claude, model: 'claude-opus-5-5', ...overrides }
}

function generation(): typeof globalThis.fetch {
  return (async () => Response.json({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
    content: [{ type: 'text', text: 'H' }], stop_reason: 'max_tokens',
  })) as typeof globalThis.fetch
}

describe('buildExternalClientProbe', () => {
  it('reads the model catalogue at the endpoint the two codex-style clients point at', () => {
    for (const tool of externalToolIds.filter((id) => id !== 'claudeDesktop')) {
      const build = buildExternalClientProbe(input({ tool }))
      expect(build.kind).toBe('probe')
      if (build.kind !== 'probe') continue
      expect(build.plan.url).toBe('https://xm.solov.cc/v1/models')
      expect(build.plan.method).toBe('GET')
      expect(build.plan.body).toBeNull()
      expect(build.plan.headers.authorization).toBe(`Bearer ${apiKey}`)
    }
  })

  it('sends Claude Desktop the same one-character check its gateway sends on every launch', () => {
    // Claude Desktop 2.9939.4 的网关探测：Bearer、anthropic-version、内容「.」、max_tokens 1。
    // 它被拒（401 或 403）就是「Couldn't sign in to Gateway」那条横幅，所以形状一个字段都不改。
    const build = buildExternalClientProbe(input(desktopInput()))
    expect(build.kind).toBe('probe')
    if (build.kind !== 'probe') return
    expect(build.plan).toMatchObject({
      protocol: 'anthropic-messages',
      method: 'POST',
      url: 'https://xm.solov.cc/v1/messages',
      origin: 'https://xm.solov.cc',
      model: 'claude-opus-5-5',
    })
    expect(build.plan.headers).toEqual({
      authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      accept: 'application/json',
    })
    expect(build.plan.body).toEqual({ model: 'claude-opus-5-5', max_tokens: 1, messages: [{ role: 'user', content: '.' }] })
  })

  it('probes the second site at its own origin', () => {
    const build = buildExternalClientProbe(input({ baseUrl: relaySites[1].providerBaseUrls.codex }))
    expect(build.kind).toBe('probe')
    if (build.kind !== 'probe') return
    expect(build.plan.url).toBe('https://api.solov.cc/v1/models')
    expect(build.plan.origin).toBe('https://api.solov.cc')
  })

  it('treats a client that is not installed as unconfigured rather than broken', () => {
    const build = buildExternalClientProbe(input({ installed: false }))
    expect(build).toMatchObject({ kind: 'blocked', outcome: { layer: 'unconfigured' } })
  })

  it('treats a client with no xingmang configuration as unconfigured', () => {
    const build = buildExternalClientProbe(input({ configurationSource: 'missing', model: null, apiKey: null }))
    expect(build).toMatchObject({ kind: 'blocked', outcome: { layer: 'unconfigured' } })
    if (build.kind !== 'blocked') return
    expect(build.outcome.summary).toContain('WorkBuddy')
  })

  it('refuses to send a key the current account did not write', () => {
    const build = buildExternalClientProbe(input({ configurationSource: 'other', apiKey: null }))
    expect(build).toMatchObject({ kind: 'blocked', outcome: { layer: 'config' } })
    if (build.kind !== 'blocked') return
    // 指向哪里不回显：那可能是用户自己的另一家服务。
    expect(build.outcome.summary).not.toContain('http')
  })

  it('carries the local read failure through instead of inventing one', () => {
    const build = buildExternalClientProbe(input({
      configurationSource: 'unknown', apiKey: null, configurationError: '客户端配置无法安全读取。',
    }))
    expect(build).toMatchObject({ kind: 'blocked', outcome: { layer: 'config', summary: '客户端配置无法安全读取。' } })
  })

  it('stops on a configuration whose address is not a credential-free https URL', () => {
    for (const baseUrl of ['http://xm.solov.cc/v1', 'https://user:pass@xm.solov.cc/v1']) {
      expect(buildExternalClientProbe(input({ baseUrl }))).toMatchObject({ kind: 'blocked', outcome: { layer: 'config' } })
    }
  })
})

describe('runExternalClientCheck', () => {
  it('says what it verified and what it could not, and carries no key', async () => {
    const result = await check(catalogue(['gpt-5.4', 'gpt-6-astra']))

    expect(result).toMatchObject({ tool: 'workbuddy', siteId: 'solov', installed: true, ok: true, status: 200 })
    expect(result.summary).toContain('gpt-5.4')
    expect(result.evidence).toContain('本机测不到')
    expect(JSON.stringify(result)).not.toContain(apiKey)
  })

  it('answers the model layer from the catalogue the account can actually see', async () => {
    const result = await check(catalogue(['gpt-6-astra']), { model: 'gpt-5.4' })

    expect(result).toMatchObject({ ok: false, layer: 'model' })
  })

  it('answers the group layer when the token sees no channel at all', async () => {
    expect(await check(catalogue([]))).toMatchObject({ ok: false, layer: 'group' })
  })

  it('shares the CLI attribution table on the failure side', async () => {
    expect(await check(rejection(401, '无效的令牌'))).toMatchObject({ ok: false, layer: 'credential' })
    expect(await check(rejection(403, '当前分组额度不足'))).toMatchObject({ ok: false, layer: 'quota' })
    expect(await check(rejection(503, '当前分组下无可用渠道'))).toMatchObject({ ok: false, layer: 'group' })
  })

  it('posts the gateway check for Claude Desktop and says what it verified', async () => {
    const sent: Array<{ url: string; init: RequestInit | undefined }> = []
    const recorder: typeof globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init })
      return generation()(url, init)
    }) as typeof globalThis.fetch
    const result = await check(recorder, desktopInput())

    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://xm.solov.cc/v1/messages')
    expect(sent[0].init?.method).toBe('POST')
    expect(JSON.parse(String(sent[0].init?.body))).toEqual({ model: 'claude-opus-5-5', max_tokens: 1, messages: [{ role: 'user', content: '.' }] })
    expect(result).toMatchObject({ tool: 'claudeDesktop', ok: true, status: 200, endpoint: 'https://xm.solov.cc/v1/messages' })
    expect(result.summary).toBe('当前账号的密钥和模型 claude-opus-5-5 都可用')
    expect(result.evidence).toBe('已照 Claude Desktop 启动时的检查，用它配置里的密钥向 claude-opus-5-5 发过一条一个字的测试消息，服务正常回复；客户端里实际发起的对话由客户端自己发出，本机测不到')
    expect(JSON.stringify(result)).not.toContain(apiKey)
  })

  it('reports an empty balance that Claude Desktop shows as rejected credentials', async () => {
    // new-api 查模型清单不走计费：余额不足时清单照样 200，这条消息却回 403。Claude Desktop 把
    // 网关检查的 403 一律说成「The provider rejected your credentials」，这里要说出真正的原因。
    const result = await check(rejection(403, '用户额度不足, 剩余额度: ＄0.000000 (request id: test)'), desktopInput())

    expect(result).toMatchObject({ ok: false, layer: 'quota', status: 403, summary: '账号额度不足（HTTP 403）' })
    expect(result.detail).toContain('用户额度不足')
  })

  it('reports a key the relay rejects for Claude Desktop on the credential layer', async () => {
    expect(await check(rejection(401, '无效的令牌'), desktopInput())).toMatchObject({ ok: false, layer: 'credential', status: 401 })
  })

  it('does not take a model catalogue as an answer to the Claude Desktop check', async () => {
    const result = await check(catalogue(['claude-opus-5-5']), desktopInput())

    expect(result).toMatchObject({ ok: false, layer: 'protocol' })
  })

  it('reports a blocked build without sending anything', async () => {
    let calls = 0
    const counted: typeof globalThis.fetch = (async () => {
      calls += 1
      return Response.json({ data: [] })
    }) as typeof globalThis.fetch
    const result = await check(counted, { installed: false, apiKey: null, model: null })

    expect(calls).toBe(0)
    expect(result).toMatchObject({ ok: false, layer: 'unconfigured', installed: false, endpoint: null })
  })
})
