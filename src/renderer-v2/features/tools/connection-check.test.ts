import { describe, expect, it } from 'vitest'
import { connectionCheckView, connectionLayerLabels, rewritableKeyProviders } from './connection-check'
import { providerIds, type AppConfigSummary, type ConnectionCheckLayer, type ConnectionCheckResult, type ProviderConfigSummary, type ProviderId } from '../../../../electron/ipc-contract'
import { writeManualSourceMarker, type SourceMarkerStorage } from './source-marker'

function memoryStorage(): SourceMarkerStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

function accountProviderConfig(): ProviderConfigSummary {
  return {
    exists: true,
    hasApiKey: true,
    matchesRelay: true,
    configurationOwnership: 'account',
    baseUrl: 'https://xm.solov.cc/v1',
    actualBaseUrl: 'https://xm.solov.cc/v1',
    model: 'fixture-model',
    apiKeyPreview: 'sk-***',
    dataDirectory: 'C:\\fixture',
    dataDirectoryExists: true,
    files: [],
    updatedAt: null,
  }
}

function config(overrides: Partial<Record<ProviderId, Partial<ProviderConfigSummary>>> = {}): AppConfigSummary {
  const providers = {} as AppConfigSummary['providers']
  for (const provider of providerIds) providers[provider] = { ...accountProviderConfig(), ...overrides[provider] }
  return { workspace: 'C:\\fixture', providers }
}

function result(overrides: Partial<ConnectionCheckResult> = {}): ConnectionCheckResult {
  return {
    provider: 'claude',
    siteId: 'solov',
    ok: false,
    layer: 'credential',
    summary: '密钥被拒绝（HTTP 401）',
    nextStep: '到「账号」页重新登录',
    endpoint: 'https://xm.solov.cc/v1/messages',
    model: 'claude-opus-5',
    detail: null,
    status: 401,
    durationMs: 12,
    checkedAt: '2026-09-18T12:00:00.000Z',
    ...overrides,
  }
}

const layers: ConnectionCheckLayer[] = [
  'unconfigured', 'config', 'network', 'credential', 'quota', 'group', 'model', 'protocol', 'unknown',
]

describe('connectionCheckView', () => {
  it('shows a success without an endpoint or a follow-up button', () => {
    const view = connectionCheckView(result({
      ok: true,
      layer: 'network',
      summary: '连接正常',
      evidence: '已用 claude-opus-5 发过一次最小请求',
    }))
    expect(view.tone).toBe('ok')
    expect(view.statusLabel).toBe('正常')
    expect(view.target).toBeNull()
    expect(view.endpoint).toBeNull()
    expect(view.body).toContain('claude-opus-5')
  })

  it('repeats what the main process actually did rather than guessing per tool', () => {
    const view = connectionCheckView(result({
      ok: true,
      provider: 'codex',
      layer: 'network',
      summary: '连接正常',
      evidence: '已核对当前账号的可用模型清单，gpt-6-astra 在其中',
    }))
    expect(view.body).toBe('已核对当前账号的可用模型清单，gpt-6-astra 在其中')
  })

  it('sends each failure layer to the page that can fix it', () => {
    expect(connectionCheckView(result({ layer: 'credential' })).target).toBe('account')
    expect(connectionCheckView(result({ layer: 'quota' })).target).toBe('account')
    expect(connectionCheckView(result({ layer: 'group' })).target).toBe('account')
    expect(connectionCheckView(result({ layer: 'model' })).target).toBe('home')
    expect(connectionCheckView(result({ layer: 'config' })).target).toBe('home')
    expect(connectionCheckView(result({ layer: 'unconfigured' })).target).toBe('home')
    expect(connectionCheckView(result({ layer: 'network' })).target).toBe('settings')
    expect(connectionCheckView(result({ layer: 'protocol' })).target).toBe('feedback')
    expect(connectionCheckView(result({ layer: 'unknown' })).target).toBe('feedback')
  })

  // 一个只装了 Claude Code 的用户按下「测试连接」，另外三个工具必须读成
  // 「还没配」，不是三条红色失败。
  it('shows a tool that was never set up as unconfigured rather than a failure', () => {
    const view = connectionCheckView(result({
      provider: 'gemini',
      layer: 'unconfigured',
      summary: '还没有给 Gemini CLI 写入星芒配置',
      nextStep: '在首页给这个工具写入星芒 Key，写完再回来自检',
      endpoint: null,
      detail: '不该出现',
    }))
    expect(view.tone).toBe('neutral')
    expect(view.statusLabel).toBe('未配置')
    expect(view.title).toBe('还没有给 Gemini CLI 写入星芒配置')
    expect(view.endpoint).toBeNull()
    expect(view.detail).toBeNull()
  })

  it('treats an incomplete local config as a warning rather than a failure', () => {
    expect(connectionCheckView(result({ layer: 'config' })).tone).toBe('warn')
    expect(connectionCheckView(result({ layer: 'group' })).tone).toBe('bad')
  })

  it('labels every failure with its layer and follows with the next step', () => {
    for (const layer of layers) {
      const view = connectionCheckView(result({ layer }))
      expect(view.statusLabel).toBe(connectionLayerLabels[layer])
      expect(view.title).toBe('密钥被拒绝（HTTP 401）')
      expect(view.body).toBe('到「账号」页重新登录')
    }
  })

  it('never surfaces the site id', () => {
    for (const layer of layers) {
      const view = connectionCheckView(result({ layer, siteId: 'solov-api' }))
      expect(`${view.title} ${view.body} ${view.statusLabel}`).not.toContain('solov')
    }
  })
})

describe('rewritableKeyProviders', () => {
  it('names the tools whose configuration came from the current account', () => {
    expect(rewritableKeyProviders(config(), memoryStorage())).toEqual([...providerIds])
  })

  // 覆盖用户自己填的密钥就是把他的配置弄丢了，而重写流程本来也会跳过这些工具，
  // 所以按钮不该出现在它们身上。
  it('leaves out an official account and a hand-written key', () => {
    const storage = memoryStorage()
    const marked = config({ gemini: { configurationOwnership: 'manual' } })
    writeManualSourceMarker(storage, marked.providers.grok.baseUrl, 'grok', true)
    const rewritable = rewritableKeyProviders(
      config({
        gemini: { configurationOwnership: 'manual' },
        codex: { codexAuthMode: 'chatgpt' },
      }),
      storage,
    )
    expect(rewritable).toContain('claude')
    expect(rewritable).not.toContain('gemini')
    expect(rewritable).not.toContain('codex')
  })

  it('gives nothing while the configuration has not been read yet', () => {
    expect(rewritableKeyProviders(null, memoryStorage())).toEqual([])
  })
})

describe('connectionCheckView rewrite action', () => {
  // 密钥和分组这两层的下一步就是重签一把 Key 写回去，所以按钮就地做这件事，
  // 不再把用户送到账号页（账号页上并没有「写入 Key」这颗按钮）。
  it('offers the rewrite in place of a jump for the key and group layers', () => {
    for (const layer of ['credential', 'group'] as ConnectionCheckLayer[]) {
      const view = connectionCheckView(result({ layer }), { canRewriteKey: true })
      expect(view.action).toBe('rewrite-key')
      expect(view.target).toBeNull()
      expect(view.body).toContain('重新写入 Key')
      // 文案以「当前账号」为主语，但不再让用户先跑一趟账号页。
      expect(view.body).toContain('当前账号')
      expect(view.body).not.toContain('「账号」页')
    }
  })

  it('keeps the jump for every other layer, rewritable or not', () => {
    for (const layer of layers.filter((entry) => entry !== 'credential' && entry !== 'group')) {
      const view = connectionCheckView(result({ layer }), { canRewriteKey: true })
      expect(view.action).toBeNull()
      expect(view.target).not.toBeNull()
    }
  })

  it('keeps the jump when this tool is not the current account\u2019s to rewrite', () => {
    const view = connectionCheckView(result({ layer: 'credential' }))
    expect(view.action).toBeNull()
    expect(view.target).toBe('account')
    expect(view.body).toBe('到「账号」页重新登录')
  })

  it('never surfaces the site id in the rewrite wording', () => {
    const view = connectionCheckView(result({ layer: 'group', siteId: 'solov-api' }), { canRewriteKey: true })
    expect(`${view.title} ${view.body}`).not.toContain('solov')
  })
})
