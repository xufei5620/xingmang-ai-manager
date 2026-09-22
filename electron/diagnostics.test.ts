import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderId } from './catalog'
import type { ProviderConfigRoots } from './codex-home'
import type { NativeConfigInspection } from './config-files'
import { networkFailureMessages, type NetworkFailureReason } from './network-failure'
import {
  createDiagnosticsExport,
  parseClashTunConfig,
  redactDiagnosticText,
  runDiagnostics,
  type DiagnosticToolId,
  type DiagnosticsDependencies,
} from './diagnostics'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryHome(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-diagnostics-'))
  temporaryDirectories.push(directory)
  return directory
}

function inspection(provider: ProviderId, home: string, apiKey: string): NativeConfigInspection {
  const extension = provider === 'codex' || provider === 'grok' ? 'toml' : 'json'
  return {
    baseUrl: provider === 'codex' || provider === 'grok'
      ? 'https://xm.solov.cc/v1'
      : 'https://xm.solov.cc',
    actualBaseUrl: provider === 'codex' || provider === 'grok'
      ? 'https://xm.solov.cc/v1?token=must-not-leak'
      : 'https://user:password@xm.solov.cc/?token=must-not-leak',
    exists: true,
    hasApiKey: true,
    matchesRelay: true,
    apiKey,
    model: 'gpt-5.6-sol',
    dataDirectory: path.join(home, `.${provider}`),
    dataDirectoryExists: true,
    files: [{ path: path.join(home, `.${provider}`, `config.${extension}`), exists: true }],
    updatedAt: '2026-07-24T00:00:00.000Z',
  }
}

function dependencies(home: string, apiKey = 'sk-super-secret-value'): DiagnosticsDependencies {
  return {
    app: { name: '星芒AI管理工具', version: '1.0.0', packaged: false },
    homeDirectory: home,
    platform: 'win32',
    arch: 'x64',
    release: '11.0.0',
    timeoutMs: 100,
    inspectAdministrator: async () => false,
    inspectPowerShell: async () => ({
      installed: true,
      version: '5.1.26100.1',
      path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    }),
    inspectTool: async (tool: DiagnosticToolId) => ({
      installed: true,
      version: `${tool} 1.0.0`,
      path: path.join(home, 'bin', `${tool}.exe`),
    }),
    inspectCodexDesktop: async () => ({
      installed: true,
      version: 'Codex',
      path: 'OpenAI.Codex_123!App',
      running: true,
    }),
    inspectProvider: (provider) => {
      const result = inspection(provider, home, apiKey)
      if (provider === 'codex') result.model = apiKey
      return result
    },
    fetch: async () => new Response(null, { status: 204 }),
    clashConfigPaths: [],
    env: {},
    inspectProxyVariables: async () => [],
  }
}

describe('diagnostics', () => {
  it('treats macOS as supported without probing Windows PowerShell', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    const inspectPowerShell = vi.fn(input.inspectPowerShell)
    input.platform = 'darwin'
    input.inspectPowerShell = inspectPowerShell

    const report = await runDiagnostics(input)

    expect(report.items.find((item) => item.code === 'OPERATING_SYSTEM')).toMatchObject({
      state: 'pass',
      details: { supported: true },
    })
    expect(report.items.find((item) => item.code === 'SYSTEM_POWERSHELL')).toMatchObject({
      state: 'pass',
      details: { required: false, installed: null, path: null },
    })
    expect(inspectPowerShell).not.toHaveBeenCalled()
  })

  it('continues to mark unrecognized operating systems as unsupported', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.platform = 'linux'

    const report = await runDiagnostics(input)

    expect(report.items.find((item) => item.code === 'OPERATING_SYSTEM')).toMatchObject({
      state: 'warn',
      details: { supported: false },
    })
  })

  it('runs isolated checks without exposing provider keys or config contents', async () => {
    const home = temporaryHome()
    const apiKey = 'sk-super-secret-value'
    const report = await runDiagnostics(dependencies(home, apiKey))
    const serialized = JSON.stringify(report)

    expect(report.counts.error).toBe(0)
    expect(report.items.some((item) => item.code === 'CLI_CODEX' && item.state === 'pass')).toBe(true)
    expect(report.items.some((item) => item.code === 'PROVIDER_CODEX' && item.state === 'pass')).toBe(true)
    expect(serialized).not.toContain(apiKey)
    expect(serialized).not.toContain('must-not-leak')
    expect(serialized).not.toContain('user:password')
    expect(serialized).not.toContain(home)
  })

  it('inspects providers and Codex dotenv through provider roots', async () => {
    const userHome = temporaryHome()
    const codexHome = path.join(path.dirname(userHome), `${path.basename(userHome)}-custom-codex`)
    temporaryDirectories.push(codexHome)
    fs.mkdirSync(codexHome, { recursive: true })
    fs.writeFileSync(path.join(codexHome, '.env'), 'OPENAI_API_KEY=sk-hidden\n')
    const input = dependencies(userHome)
    const providerRoots: ProviderConfigRoots = { userHome, codexHome }
    const inspected: Array<{ provider: ProviderId, roots: ProviderConfigRoots }> = []
    const inspectProvider = (provider: ProviderId, roots: ProviderConfigRoots) => {
      inspected.push({ provider, roots })
      return inspection(provider, provider === 'codex' ? roots.codexHome : roots.userHome, 'sk-hidden')
    }

    const report = await runDiagnostics({
      ...input,
      providerRoots,
      inspectProvider,
    })

    expect(inspected).toHaveLength(4)
    expect(inspected.map(({ provider }) => provider).sort()).toEqual(['claude', 'codex', 'gemini', 'grok'])
    expect(inspected.every(({ roots }) => roots === providerRoots)).toBe(true)
    expect(report.items.find((item) => item.code === 'CODEX_DOTENV')).toMatchObject({
      state: 'warn',
      details: { exists: true, path: '[CODEX_HOME]/.env' },
    })
    expect(report.items.find((item) => item.code === 'PROVIDER_CODEX')?.details?.file1)
      .toBe('[CODEX_HOME]/.codex/config.toml')
    expect(report.items.find((item) => item.code === 'PROVIDER_CLAUDE')?.details?.file1)
      .toBe('~/.claude/config.json')
  })

  it('rejects failed relay responses and refuses automatic redirects', async () => {
    const home = temporaryHome()
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }))
    const input = dependencies(home)
    input.fetch = fetchImpl

    const report = await runDiagnostics(input)

    expect(fetchImpl).toHaveBeenCalledWith('https://xm.solov.cc/', expect.objectContaining({
      method: 'HEAD',
      redirect: 'error',
    }))
    const network = report.items.find((item) => item.code === 'XINGMANG_NETWORK')
    expect(network).toMatchObject({ state: 'fail', details: { status: 503 } })
    expect(network?.summary).toContain('HTTP 503')
    // 网络本身通了，所以这一条不该建议用户换网络。
    expect(network?.summary).not.toContain('换一个网络')
  })

  describe('XINGMANG_NETWORK failure reasons', () => {
    const cases: readonly { label: string; error: unknown; reason: NetworkFailureReason }[] = [
      {
        label: 'a name that does not resolve',
        error: new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND xm.solov.cc'), { code: 'ENOTFOUND' }) }),
        reason: 'dns',
      },
      {
        label: 'a connection the network cut',
        error: new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }),
        reason: 'refused',
      },
      {
        label: 'a request that never answered',
        error: new TypeError('fetch failed', { cause: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }),
        reason: 'timeout',
      },
      {
        label: 'a certificate the gateway replaced',
        error: new Error('net::ERR_CERT_AUTHORITY_INVALID'),
        reason: 'tls',
      },
      {
        label: 'a captive portal redirect refused by redirect:error',
        error: new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
        reason: 'intercepted',
      },
    ]

    it.each(cases)('reports $label in Chinese and keeps the upstream text out of the report', async ({ error, reason }) => {
      const home = temporaryHome()
      const input = dependencies(home)
      const log = vi.fn()
      input.fetch = vi.fn(async () => { throw error })
      input.log = log

      const report = await runDiagnostics(input)

      const network = report.items.find((item) => item.code === 'XINGMANG_NETWORK')
      expect(network).toMatchObject({
        state: 'fail',
        summary: networkFailureMessages[reason],
        details: { endpoint: 'https://xm.solov.cc/', reason },
      })
      // 英文原文只进 runtime.jsonl，不进上屏（也会被导出）的报告。
      expect(JSON.stringify(network)).not.toMatch(/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_CERT|unexpected redirect/)
      expect(log).toHaveBeenCalledWith(
        'warn',
        'diagnostics.network.failed',
        expect.stringContaining(reason),
        expect.objectContaining({ reason, raw: expect.any(String) }),
      )
      expect(log.mock.calls[0][3].raw).not.toBe('')
    })

    it('treats an HTML answer to a HEAD probe as a login portal', async () => {
      const home = temporaryHome()
      const input = dependencies(home)
      input.fetch = vi.fn(async () => new Response(null, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }))

      const report = await runDiagnostics(input)

      expect(report.items.find((item) => item.code === 'XINGMANG_NETWORK')).toMatchObject({
        state: 'fail',
        summary: networkFailureMessages.intercepted,
        details: { reason: 'intercepted', status: 200 },
      })
    })

    it('still falls back to the generic error for a failure that is not about the network', async () => {
      const home = temporaryHome()
      const input = dependencies(home)
      const log = vi.fn()
      input.fetch = vi.fn(async () => { throw new Error('当前运行时不支持 fetch') })
      input.log = log

      const report = await runDiagnostics(input)

      expect(report.items.find((item) => item.code === 'XINGMANG_NETWORK')).toMatchObject({
        state: 'error',
        summary: '检查时发生错误',
      })
      expect(log).not.toHaveBeenCalled()
    })
  })

  describe('PROVIDER_ENVIRONMENT_OVERRIDE', () => {
    function overrideItem(report: Awaited<ReturnType<typeof runDiagnostics>>) {
      return report.items.find((item) => item.code === 'PROVIDER_ENVIRONMENT_OVERRIDE')
    }

    it('passes when nothing in the environment can override the account configuration', async () => {
      const home = temporaryHome()

      const report = await runDiagnostics(dependencies(home))

      expect(overrideItem(report)).toMatchObject({
        state: 'pass',
        summary: '没有会盖过当前账号配置的环境变量',
        details: { count: 0 },
      })
    })

    it('names the variables it found without ever reading their values', async () => {
      const home = temporaryHome()
      const input = dependencies(home)
      input.env = {
        ANTHROPIC_BASE_URL: 'https://gateway.example.com',
        ANTHROPIC_AUTH_TOKEN: 'sk-must-not-leak-token',
        anthropic_api_key: 'sk-must-not-leak-key',
        GEMINI_MODEL: 'gemini-must-not-leak',
      }

      const report = await runDiagnostics(input)
      const item = overrideItem(report)

      expect(item?.state).toBe('warn')
      expect(item?.summary).toContain('ANTHROPIC_BASE_URL')
      expect(item?.summary).toContain('ANTHROPIC_AUTH_TOKEN')
      expect(item?.summary).toContain('等 4 项')
      expect(item?.details).toMatchObject({
        count: 4,
        variable1: 'ANTHROPIC_BASE_URL（Claude Code）',
        variable2: 'ANTHROPIC_AUTH_TOKEN（Claude Code）',
        // 大小写不敏感：Windows 上 `anthropic_api_key` 与大写是同一个变量。
        variable3: 'ANTHROPIC_API_KEY（Claude Code）',
        variable4: 'GEMINI_MODEL（Gemini CLI）',
      })
      expect(JSON.stringify(item)).not.toMatch(/must-not-leak|gateway\.example\.com/)
    })

    it('does not scold a base URL that already points at the current account', async () => {
      const home = temporaryHome()
      const input = dependencies(home)
      input.env = { ANTHROPIC_BASE_URL: 'https://xm.solov.cc/', OPENAI_BASE_URL: 'https://xm.solov.cc/v1' }

      const report = await runDiagnostics(input)

      expect(overrideItem(report)).toMatchObject({
        state: 'pass',
        summary: '检测到的环境变量都指向当前账号，不会盖过写入的配置',
        details: {
          count: 2,
          variable1: 'ANTHROPIC_BASE_URL（Claude Code，已指向当前账号）',
          variable2: 'OPENAI_BASE_URL（Codex CLI，已指向当前账号）',
        },
      })
    })

    it('ignores the CODEX_HOME this app injects itself and reports one pointed elsewhere', async () => {
      const home = temporaryHome()
      const managed = dependencies(home)
      managed.env = { CODEX_HOME: path.join(home, '.codex') }

      expect(overrideItem(await runDiagnostics(managed))).toMatchObject({
        state: 'pass',
        details: { count: 0 },
      })

      const redirected = dependencies(home)
      redirected.env = { CODEX_HOME: path.join(home, 'elsewhere') }
      redirected.providerRoots = { userHome: home, codexHome: path.join(home, 'elsewhere') }

      expect(overrideItem(await runDiagnostics(redirected))).toMatchObject({
        state: 'warn',
        details: { count: 1, variable1: 'CODEX_HOME（Codex CLI）' },
      })
    })
  })

  it('contains a timed out item while the other checks still complete', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.timeoutMs = 20
    input.inspectTool = async (tool) => {
      if (tool === 'node') return await new Promise(() => undefined)
      return { installed: true, version: '1.0.0', path: path.join(home, 'bin', tool) }
    }

    const report = await runDiagnostics(input)
    const node = report.items.find((item) => item.code === 'RUNTIME_NODE')
    const npm = report.items.find((item) => item.code === 'RUNTIME_NPM')
    expect(node).toMatchObject({ state: 'error', summary: '检查超时' })
    expect(npm).toMatchObject({ state: 'pass' })
    expect(report.durationMs).toBeLessThan(500)
  })

  it('treats a missing Git as optional (warn) and spells out the impact', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    const previous = input.inspectTool!
    input.inspectTool = async (tool, signal) =>
      tool === 'git' ? { installed: false, version: null, path: null } : previous(tool, signal)

    const report = await runDiagnostics(input)

    const git = report.items.find((item) => item.code === 'RUNTIME_GIT')
    expect(git).toMatchObject({ state: 'warn', details: { required: false, installed: false } })
    // Windows 依赖是这份夹具的平台；提示要说清楚缺了会怎样，而不只是「未安装」。
    expect(git?.summary).toContain('PowerShell')
    expect(git?.summary).toContain('git-scm.com')
  })

  it('passes the Git check when Git is present', async () => {
    const home = temporaryHome()
    const report = await runDiagnostics(dependencies(home))

    expect(report.items.find((item) => item.code === 'RUNTIME_GIT')).toMatchObject({
      state: 'pass',
      details: { required: false, installed: true },
    })
  })

  it('reports a missing system PowerShell as a launch-blocking failure', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.inspectPowerShell = async () => ({ installed: false, version: null, path: null })

    const report = await runDiagnostics(input)

    expect(report.items.find((item) => item.code === 'SYSTEM_POWERSHELL')).toMatchObject({
      state: 'fail',
      summary: expect.stringContaining('PowerShell 5.1'),
      details: { installed: false, path: null },
    })
  })

  it('warns instead of requiring administrator privileges', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.inspectAdministrator = async () => true

    const report = await runDiagnostics(input)

    expect(report.items.find((item) => item.code === 'ADMINISTRATOR')).toMatchObject({
      state: 'warn',
      title: '运行权限',
      summary: '当前以管理员权限运行，建议普通启动',
      details: { elevated: true, required: false },
    })
  })

  it('redacts bearer tokens, sk keys, known keys, proxy credentials, queries and home paths', () => {
    const home = 'C:\\Users\\peaker'
    const knownKey = 'license-key-123456789'
    const raw = [
      `Bearer bearer-token-123456`,
      'sk-thismustdisappear',
      knownKey,
      'https://proxy-user:proxy-pass@127.0.0.1:7890/path?token=query-secret',
      `${home}\\.codex\\config.toml`,
      JSON.stringify(`${home}\\.codex\\auth.json`),
    ].join('\n')
    const redacted = redactDiagnosticText(raw, { homeDirectory: home, sensitiveValues: [knownKey] })

    for (const secret of [
      'bearer-token-123456',
      'sk-thismustdisappear',
      knownKey,
      'proxy-user',
      'proxy-pass',
      'query-secret',
      'C:\\Users\\peaker',
      'C:\\\\Users\\\\peaker',
    ]) {
      expect(redacted).not.toContain(secret)
    }
    expect(redacted).toContain('[REDACTED]')
  })

  it('redacts secrets spelled as JSON object keys', () => {
    const redacted = redactDiagnosticText(JSON.stringify({
      access_token: 'token-value-123456',
      authorization: 'Basic basic-value-123456',
      password: 'hunter2-secret',
      apiKey: 'plain-api-key-value',
      hasToken: true,
    }))

    for (const secret of [
      'token-value-123456',
      'basic-value-123456',
      'hunter2-secret',
      'plain-api-key-value',
    ]) {
      expect(redacted).not.toContain(secret)
    }
    expect(redacted).toContain('[REDACTED]')
    // Support reads the export with a parser, so redaction has to leave the
    // quotes that delimited each value in place.
    expect(() => JSON.parse(redacted)).not.toThrow()
  })

  it('exports only the report DTO and applies final redaction', async () => {
    const home = temporaryHome()
    const key = 'sk-export-secret'
    const externalPath = process.platform === 'win32'
      ? 'D:\\client-name\\private-project\\custom-node.exe'
      : '/srv/client-name/private-project/custom-node'
    const report = await runDiagnostics(dependencies(home, key))
    report.items[0].details = {
      unsafe: `Bearer hidden-bearer ${key} https://u:p@proxy.local/x?token=q ${home}`,
      externalPath,
    }
    const exported = createDiagnosticsExport(report, { homeDirectory: home, sensitiveValues: [key] })
    expect(exported).not.toContain(key)
    expect(exported).not.toContain('hidden-bearer')
    expect(exported).not.toContain('u:p')
    expect(exported).not.toContain('?token=q')
    expect(exported).not.toContain(home)
    expect(exported).not.toContain('client-name')
    expect(exported).not.toContain('private-project')
    expect(exported).toContain('[ABSOLUTE_PATH]')
    expect(exported).toContain(process.platform === 'win32' ? 'custom-node.exe' : 'custom-node')
    expect(exported).not.toContain('process.env')
  })

  it('redacts slash, backslash, and JSON-escaped variants of both roots from exports', async () => {
    const fixtureHome = temporaryHome()
    const userHome = '/Users/private/diagnostic-user'
    const codexHome = '/Volumes/private/codex-root'
    const userHomeBackslash = userHome.replaceAll('/', '\\')
    const codexHomeBackslash = codexHome.replaceAll('/', '\\')
    const report = await runDiagnostics(dependencies(fixtureHome))
    report.items[0].details = {
      userSlash: `${userHome}/.claude/settings.json`,
      userBackslash: `${userHomeBackslash}\\.gemini\\settings.json`,
      codexSlash: `${codexHome}/config.toml`,
      codexBackslash: `${codexHomeBackslash}\\auth.json`,
    }

    const exported = createDiagnosticsExport(report, { userHome, codexHome })

    for (const rootVariant of [
      userHome,
      userHomeBackslash,
      JSON.stringify(userHomeBackslash).slice(1, -1),
      codexHome,
      codexHomeBackslash,
      JSON.stringify(codexHomeBackslash).slice(1, -1),
    ]) {
      expect(exported).not.toContain(rootVariant)
    }
    expect(exported).toContain('~/.claude/settings.json')
    expect(exported).toContain('[CODEX_HOME]/config.toml')
  })

  it('labels the more specific Codex root before an overlapping user home', async () => {
    const fixtureHome = temporaryHome()
    const userHome = '/Users/private/diagnostic-user'
    const codexHome = `${userHome}/Library/Application Support/Codex`
    const report = await runDiagnostics(dependencies(fixtureHome))
    report.items[0].details = {
      paths: `${userHome}/.claude/settings.json ${codexHome}/config.toml`,
    }

    const exported = createDiagnosticsExport(report, { userHome, codexHome })

    expect(exported).not.toContain(userHome)
    expect(exported).not.toContain(codexHome)
    expect(exported).toContain('~/.claude/settings.json')
    expect(exported).toContain('[CODEX_HOME]/config.toml')
  })

  it('keeps prefix collisions and embedded root text classified as external absolute paths', async () => {
    const fixtureHome = temporaryHome()
    const userHome = '/Users/alex'
    const codexHome = `${userHome}/.codex`
    const report = await runDiagnostics(dependencies(fixtureHome))
    report.items[0].details = {
      prefixCollision: '/Users/alexander/private-project/tool',
      embeddedRoot: '/tmp/Users/alex/private-project/tool',
    }

    const exported = createDiagnosticsExport(report, { userHome, codexHome })
    const payload = JSON.parse(exported) as { diagnostics: typeof report }

    expect(payload.diagnostics.items[0].details).toMatchObject({
      prefixCollision: '[ABSOLUTE_PATH]/tool',
      embeddedRoot: '[ABSOLUTE_PATH]/tool',
    })
    expect(exported).not.toContain('alexander')
    expect(exported).not.toContain('private-project')
  })

  it('redacts escaped-forward-slash roots before and after JSON serialization', async () => {
    const fixtureHome = temporaryHome()
    const userHome = '/Users/alex'
    const codexHome = '/Volumes/private/codex-root'
    const escapedUserHome = userHome.replaceAll('/', '\\/')
    const escapedCodexHome = codexHome.replaceAll('/', '\\/')
    const serializedUserHome = JSON.stringify(escapedUserHome).slice(1, -1)
    const serializedCodexHome = JSON.stringify(escapedCodexHome).slice(1, -1)
    const report = await runDiagnostics(dependencies(fixtureHome))
    report.items[0].details = {
      userPath: `${escapedUserHome}\\/.claude\\/settings.json`,
      codexPath: `${escapedCodexHome}\\/config.toml`,
    }

    const exported = createDiagnosticsExport(report, { userHome, codexHome })

    for (const rootVariant of [
      escapedUserHome,
      serializedUserHome,
      escapedCodexHome,
      serializedCodexHome,
    ]) {
      expect(exported).not.toContain(rootVariant)
    }
    expect(exported).toContain('~')
    expect(exported).toContain('[CODEX_HOME]')
  })

  it('does not expose absolute tool paths outside the home directory', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.inspectTool = async (tool) => ({
      installed: true,
      version: '1.0.0',
      path: tool === 'node'
        ? process.platform === 'win32'
          ? 'D:\\customer\\secret-project\\node.exe'
          : '/opt/customer/secret-project/node'
        : path.join(home, '.local', 'bin', tool),
    })

    const report = await runDiagnostics(input)
    const nodePath = report.items.find((item) => item.code === 'RUNTIME_NODE')?.details?.path

    expect(nodePath).toBe(process.platform === 'win32'
      ? '[ABSOLUTE_PATH]/node.exe'
      : '[ABSOLUTE_PATH]/node')
  })

  it('rejects oversized Claude and Clash configuration files before parsing', async () => {
    const home = temporaryHome()
    const claudeSettings = path.join(home, '.claude', 'settings.json')
    const clashConfig = path.join(home, 'clash-verge.yaml')
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true })
    fs.writeFileSync(claudeSettings, Buffer.alloc(256 * 1024 + 1, 0x20))
    fs.writeFileSync(clashConfig, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20))
    const input = dependencies(home)
    input.clashConfigPaths = [clashConfig]

    const report = await runDiagnostics(input)

    expect(report.items.find((item) => item.code === 'CLAUDE_BYPASS_PERMISSIONS')).toMatchObject({
      state: 'error',
      details: { reason: expect.stringContaining('安全上限') },
    })
    expect(report.items.find((item) => item.code === 'CLASH_VERGE_TUN')).toMatchObject({
      state: 'error',
      details: { reason: expect.stringContaining('安全上限') },
    })
  })
})

describe('parseClashTunConfig', () => {
  it('reads supported top-level and nested TUN switches', () => {
    expect(parseClashTunConfig('enable_tun_mode: true\n')).toBe(true)
    expect(parseClashTunConfig('tun:\n  enable: true\n')).toBe(true)
    expect(parseClashTunConfig('tun:\n  enable: false\n')).toBe(false)
  })

  it('rejects custom YAML tags', () => {
    expect(() => parseClashTunConfig('enable_tun_mode: !unsafe true\n')).toThrow(/YAML/)
  })

  it('caps YAML alias expansion', () => {
    const source = [
      'a: &a [x, x, x, x]',
      'b: &b [*a, *a, *a, *a]',
      'c: &c [*b, *b, *b, *b]',
      'd: [*c, *c, *c, *c]',
    ].join('\n')
    expect(() => parseClashTunConfig(source)).toThrow(/alias|Alias|aliases|YAML/i)
  })
})
