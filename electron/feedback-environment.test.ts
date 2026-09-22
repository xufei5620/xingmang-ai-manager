import { describe, expect, it } from 'vitest'
import { providerIds } from './catalog'
import { externalToolIds } from './external-client-contract'
import {
  buildFeedbackEnvironmentLines,
  type FeedbackCliConfig,
  type FeedbackCliStatus,
  type FeedbackExternalClient,
} from './feedback-environment'

const installed: FeedbackCliStatus = {
  installed: true,
  version: '2.1.277',
  installSource: 'npm',
}

const pointingAtAccount: FeedbackCliConfig = {
  exists: true,
  hasApiKey: true,
  matchesRelay: true,
  model: 'claude-opus-5',
}

function statusesWith(overrides: Partial<Record<string, FeedbackCliStatus>> = {}) {
  return Object.fromEntries(
    providerIds.map((provider) => [provider, overrides[provider] ?? installed]),
  ) as Record<(typeof providerIds)[number], FeedbackCliStatus>
}

describe('buildFeedbackEnvironmentLines', () => {
  it('reports version, install source and account state for every managed CLI', () => {
    const lines = buildFeedbackEnvironmentLines({
      clis: statusesWith(),
      readConfig: () => pointingAtAccount,
    })

    expect(lines).toHaveLength(providerIds.length + externalToolIds.length)
    expect(lines[0]).toBe('Claude Code: 已安装 2.1.277（应用托管）；配置：指向当前账号，模型 claude-opus-5')
  })

  it('labels the other install sources and leaves Grok unlabelled', () => {
    const lines = buildFeedbackEnvironmentLines({
      clis: statusesWith({
        codex: { ...installed, version: '0.155.1', installSource: 'native' },
        gemini: { ...installed, version: '0.60.0', installSource: 'path' },
        grok: { ...installed, version: '1.0.40', installSource: undefined },
      }),
      readConfig: () => pointingAtAccount,
    })
    const text = lines.join('\n')

    expect(text).toContain('Codex CLI: 已安装 0.155.1（官方安装器）')
    expect(text).toContain('Gemini CLI: 已安装 0.60.0（其他来源）')
    // Grok 的安装与更新走原生通道，界面不给它标来源，报告同样不标。
    expect(text).toContain('Grok CLI: 已安装 1.0.40；')
  })

  it('separates not installed, probe failure and unknown version', () => {
    const lines = buildFeedbackEnvironmentLines({
      clis: statusesWith({
        claude: { installed: false, version: null },
        codex: { installed: false, version: null, detectionFailed: true },
        grok: { installed: true, version: null },
      }),
      readConfig: () => null,
    })
    const text = lines.join('\n')

    expect(text).toContain('Claude Code: 未安装；配置：未能读取')
    expect(text).toContain('Codex CLI: 检测失败；')
    expect(text).toContain('Grok CLI: 已安装（版本未知）；')
  })

  it('distinguishes a config that points elsewhere from one that does not exist', () => {
    const lines = buildFeedbackEnvironmentLines({
      clis: statusesWith(),
      readConfig: (provider) => provider === 'claude'
        ? { exists: true, hasApiKey: true, matchesRelay: false, model: '' }
        : { exists: false, hasApiKey: false, matchesRelay: false, model: '' },
    })
    const text = lines.join('\n')

    expect(text).toContain('Claude Code: 已安装 2.1.277（应用托管）；配置：未指向当前账号')
    expect(text).toContain('Codex CLI: 已安装 2.1.277（应用托管）；配置：未配置')
  })

  it('carries the verified-version advice a support reply needs', () => {
    const lines = buildFeedbackEnvironmentLines({
      clis: statusesWith({
        claude: {
          ...installed,
          version: '2.1.275',
          versionAdvice: {
            recommendedVersion: '2.1.277',
            blockedReason: '该版本对网关地址的请求会报 400',
            onRecommended: false,
            pinned: true,
            rollbackAvailable: true,
          },
        },
      }),
      readConfig: () => pointingAtAccount,
    })

    expect(lines[0]).toContain('推荐 2.1.277')
    expect(lines[0]).toContain('已知问题: 该版本对网关地址的请求会报 400')
  })

  it('writes 未能读取 for every CLI when no scan has been cached yet', () => {
    const lines = buildFeedbackEnvironmentLines({ clis: null, readConfig: () => pointingAtAccount })

    expect(lines).toEqual([...providerIds, ...externalToolIds].map(() => expect.stringContaining('未能读取')))
    expect(lines.join('\n')).not.toContain('配置：')
  })

  it('survives a config read that throws instead of failing the whole report', () => {
    const lines = buildFeedbackEnvironmentLines({
      clis: statusesWith(),
      readConfig: (provider) => {
        if (provider === 'claude') throw new Error('目录被替换成了链接')
        return pointingAtAccount
      },
    })

    expect(lines[0]).toContain('配置：未能读取')
    expect(lines[1]).toContain('指向当前账号')
  })

  it('answers the same three questions for the external desktop clients', () => {
    const clients: FeedbackExternalClient[] = [
      { tool: 'workbuddy', installed: true, version: '1.4.2', model: 'gpt-5.4', configurationSource: 'xingmang', detectionError: null },
      { tool: 'claudeDesktop', installed: true, version: null, model: 'claude-opus-5', configurationSource: 'other', detectionError: null },
      { tool: 'opencode', installed: false, version: null, model: null, configurationSource: 'missing', detectionError: null },
    ]
    const text = buildFeedbackEnvironmentLines({
      clis: statusesWith(), readConfig: () => pointingAtAccount, externalClients: clients,
    }).join('\n')

    expect(text).toContain('WorkBuddy: 已安装 1.4.2；配置：指向当前账号，模型 gpt-5.4')
    expect(text).toContain('Claude Desktop: 已安装（版本未知）；配置：未指向当前账号，模型 claude-opus-5')
    expect(text).toContain('OpenCode: 未安装；配置：未配置')
  })

  it('separates a client detection failure from a config that cannot be read', () => {
    const text = buildFeedbackEnvironmentLines({
      clis: statusesWith(),
      readConfig: () => pointingAtAccount,
      externalClients: [
        { tool: 'workbuddy', installed: false, version: null, model: null, configurationSource: 'missing', detectionError: '无法读取安装记录' },
        { tool: 'claudeDesktop', installed: true, version: '2.2553.1.0', model: null, configurationSource: 'unknown', detectionError: null },
      ],
    }).join('\n')

    expect(text).toContain('WorkBuddy: 检测失败；')
    expect(text).toContain('Claude Desktop: 已安装 2.2553.1.0；配置：未能读取')
    // 这一轮没检测到的客户端仍旧各占一行，不会从报告里消失。
    expect(text).toContain('OpenCode: 未能读取')
  })

  it('never carries an API key, a relay address or the site name', () => {
    const lines = buildFeedbackEnvironmentLines({
      clis: statusesWith(),
      // 真实的 inspectProviderConfig 会带上 apiKey / baseUrl 等字段，这里
      // 多塞几个进去，钉住构造器只读它声明的那几个。
      readConfig: () => ({
        ...pointingAtAccount,
        apiKey: 'sk-private-feedback-key',
        baseUrl: 'https://xm.solov.cc',
        actualBaseUrl: 'https://xm.solov.cc',
      } as FeedbackCliConfig),
    })
    const text = lines.join('\n')

    for (const secret of ['sk-private-feedback-key', 'solov', 'http', '星芒']) {
      expect(text).not.toContain(secret)
    }
  })
})
