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

describe('buildExternalClientProbe', () => {
  it('reads the model catalogue at the endpoint each client actually points at', () => {
    const expected: Record<string, string> = {
      workbuddy: 'https://xm.solov.cc/v1/models',
      opencode: 'https://xm.solov.cc/v1/models',
      claudeDesktop: 'https://xm.solov.cc/v1/models',
    }
    for (const tool of externalToolIds) {
      const build = buildExternalClientProbe(input({
        tool,
        baseUrl: tool === 'claudeDesktop' ? xmSite.providerBaseUrls.claude : xmSite.providerBaseUrls.codex,
      }))
      expect(build.kind).toBe('probe')
      if (build.kind !== 'probe') continue
      expect(build.plan.url).toBe(expected[tool])
      expect(build.plan.method).toBe('GET')
      expect(build.plan.body).toBeNull()
      expect(build.plan.headers.authorization).toBe(`Bearer ${apiKey}`)
    }
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
