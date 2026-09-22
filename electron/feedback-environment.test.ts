import { describe, expect, it } from 'vitest'
import { providerIds } from './catalog'
import { externalToolIds } from './external-client-contract'
import {
  buildFeedbackEnvironmentLines,
  buildFeedbackRuntimeLines,
  pickFeedbackRuntimeSnapshot,
  type FeedbackRuntimeInput,
  type FeedbackCliConfig,
  type FeedbackCliStatus,
  type FeedbackExternalClient,
} from './feedback-environment'
import type { SystemSnapshot } from './system-service'

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

function runtimeInput(overrides: Partial<FeedbackRuntimeInput> = {}): FeedbackRuntimeInput {
  return {
    snapshot: {
      checkedAt: '2026-09-22T10:00:00.000Z',
      runtime: {
        node: { installed: true, version: 'v22.12.0', path: 'C:\\Program Files\\nodejs\\node.exe' },
        npm: { installed: true, version: '10.9.0', path: 'C:\\Program Files\\nodejs\\npm.cmd' },
        python: { installed: false, version: null, path: null },
        git: { installed: false, version: null, path: null, detectionFailed: true },
      },
      codexDesktop: { installed: true, version: '1.0.0', appVersion: '26.915.1', path: null, running: true },
      region: 'mainland-china',
    },
    platform: 'win32',
    executionMode: 'same-user',
    appDirectory: 'C:\\Program Files\\XingMang',
    dataDirectory: 'C:\\Users\\alice\\AppData\\Roaming\\xingmang',
    managedDirectory: 'C:\\ProgramData\\XingMangAI\\Cli',
    locale: 'zh-CN',
    timeZone: 'Asia/Shanghai',
    ...overrides,
  }
}

describe('buildFeedbackRuntimeLines', () => {
  it('lists system runtimes with version and location, separately from the bundled Node', () => {
    const lines = buildFeedbackRuntimeLines(runtimeInput())

    expect(lines).toEqual([
      '系统 Node.js: 已安装 v22.12.0，位置 C:\\Program Files\\nodejs\\node.exe',
      'npm: 已安装 10.9.0，位置 C:\\Program Files\\nodejs\\npm.cmd',
      'Python: 未安装',
      'Git: 检测失败',
      'Codex 桌面端: 已安装 26.915.1，正在运行',
      '网络位置: 中国大陆',
      '运行权限: 普通用户',
      '软件位置: C:\\Program Files\\XingMang',
      '数据目录: C:\\Users\\alice\\AppData\\Roaming\\xingmang',
      '托管目录: C:\\ProgramData\\XingMangAI\\Cli',
      '系统语言与时区: zh-CN，Asia/Shanghai',
      '以上来自 2026-09-22T10:00:00.000Z 的扫描',
    ])
  })

  it('never carries the public IP or country code from the scan into the report', () => {
    const scanned = {
      checkedAt: '2026-09-22T10:00:00.000Z',
      network: { publicIp: '198.51.100.18', countryCode: 'JP', region: 'outside-mainland-china', checkedAt: '2026-09-22T10:00:00.000Z', error: null },
      runtime: runtimeInput().snapshot?.runtime,
      clis: {},
      desktopApps: { codex: runtimeInput().snapshot?.codexDesktop },
    } as unknown as SystemSnapshot
    const picked = pickFeedbackRuntimeSnapshot(scanned)
    const text = buildFeedbackRuntimeLines(runtimeInput({ snapshot: picked })).join('\n')

    expect(JSON.stringify(picked)).not.toContain('198.51.100.18')
    expect(text).toContain('网络位置: 中国大陆以外')
    expect(text).not.toContain('198.51.100.18')
    expect(text).not.toContain('JP')
  })

  it('treats a missing scan as no snapshot', () => {
    expect(pickFeedbackRuntimeSnapshot(null)).toBeNull()
  })

  it('flags an outdated system Node so support does not have to compare versions by hand', () => {
    const input = runtimeInput()
    const snapshot = input.snapshot
    if (!snapshot) throw new Error('fixture must carry a snapshot')
    const lines = buildFeedbackRuntimeLines({
      ...input,
      snapshot: { ...snapshot, runtime: { ...snapshot.runtime, node: { installed: true, version: 'v16.0.0', path: null, tooOld: true } } },
    })

    expect(lines[0]).toBe('系统 Node.js: 已安装 v16.0.0，版本过低')
  })

  it('does not claim the user chose to run as administrator when the probe only fell back', () => {
    const lines = buildFeedbackRuntimeLines(runtimeInput({ executionMode: 'trusted-only' }))

    expect(lines).toContain('运行权限: 以管理员身份运行（或无法确认，按管理员处理）')
  })

  it('says why the app was treated as administrator when the startup probe failed', () => {
    const lines = buildFeedbackRuntimeLines(runtimeInput({ executionMode: 'trusted-only', executionProbeFailure: 'blocked' }))

    expect(lines).toContain('运行权限: 按管理员处理（没能确认：确认权限这一步被安全软件或电脑的管控策略拦下了）')
  })

  it('states a real administrator run plainly once the probe is known to have succeeded', () => {
    expect(buildFeedbackRuntimeLines(runtimeInput({ executionMode: 'trusted-only', executionProbeFailure: null })))
      .toContain('运行权限: 以管理员身份运行')
    expect(buildFeedbackRuntimeLines(runtimeInput({ executionMode: 'same-user', executionProbeFailure: null })))
      .toContain('运行权限: 普通用户')
  })

  it('omits the privilege line outside Windows', () => {
    const lines = buildFeedbackRuntimeLines(runtimeInput({ platform: 'darwin', executionMode: 'same-user' }))

    expect(lines.some((line) => line.startsWith('运行权限'))).toBe(false)
  })

  it('says unreadable instead of guessing when no scan has finished yet', () => {
    const lines = buildFeedbackRuntimeLines(runtimeInput({ snapshot: null, managedDirectory: null, locale: null, timeZone: null }))

    expect(lines).toEqual([
      '系统 Node.js: 未能读取',
      'npm: 未能读取',
      'Python: 未能读取',
      'Git: 未能读取',
      'Codex 桌面端: 未能读取',
      '网络位置: 未能读取',
      '运行权限: 普通用户',
      '软件位置: C:\\Program Files\\XingMang',
      '数据目录: C:\\Users\\alice\\AppData\\Roaming\\xingmang',
    ])
  })
})
