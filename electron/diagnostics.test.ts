import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderId } from './catalog'
import type { ProviderConfigRoots } from './codex-home'
import type { NativeConfigInspection } from './config-files'
import { networkFailureMessages, type NetworkFailureReason } from './network-failure'
import { relaySites } from './relay-sites'
import {
  clockSkewMs,
  clockSyncGuidance,
  createDiagnosticsExport,
  describeRelocationTarget,
  findRelocatedFolders,
  parseClashTunConfig,
  redactDiagnosticText,
  relayStatusProbeUrl,
  runDiagnostics,
  type DiagnosticsScanSnapshot,
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

// 两个站的状态接口正常时回的就是一小段 JSON（new-api 的 /api/status 形如
// { success, data }），测试只关心「是不是 JSON」，不关心字段。
function statusJson(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: true, message: '', data: {} }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
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
    inspectElevationCapability: async () => 'unknown' as const,
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
    fetch: async () => statusJson(),
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

  it('flags project folder settings that override the current account, without values', async () => {
    // macOS 的临时目录经过 /var → /private/var 这条符号链接，bounded 读法会拒读。
    const home = fs.realpathSync.native(temporaryHome())
    const workspace = path.join(home, 'work', 'app')
    fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(workspace, '.claude', 'settings.local.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://elsewhere.example', ANTHROPIC_AUTH_TOKEN: 'sk-project-secret' },
    }))
    const input = dependencies(home)
    input.platform = process.platform
    input.workspace = workspace
    input.claudeManagedDirectory = path.join(home, 'managed')

    const item = (await runDiagnostics(input)).items.find((entry) => entry.code === 'WORKSPACE_CONFIG_OVERRIDE')

    expect(item).toMatchObject({
      title: '项目文件夹里的设置',
      state: 'fail',
      details: {
        workspace: '~/work/app',
        count: 1,
        file1: 'Claude Code · .claude/settings.local.json：ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN',
      },
    })
    expect(item?.summary).toContain('会让 Claude Code 不用当前账号')
    expect(JSON.stringify(item)).not.toContain('elsewhere.example')
    expect(JSON.stringify(item)).not.toContain('sk-project-secret')
  })

  it('still checks managed settings before any project folder was chosen', async () => {
    const home = fs.realpathSync.native(temporaryHome())
    const managed = path.join(home, 'managed')
    fs.mkdirSync(managed, { recursive: true })
    fs.writeFileSync(path.join(managed, 'managed-settings.json'), JSON.stringify({ apiKeyHelper: 'company-helper' }))
    const input = dependencies(home)
    input.platform = process.platform
    input.claudeManagedDirectory = managed

    const item = (await runDiagnostics(input)).items.find((entry) => entry.code === 'WORKSPACE_CONFIG_OVERRIDE')

    expect(item?.state).toBe('warn')
    expect(item?.summary).toBe('这台电脑上有统一下发的设置，可能会让 Claude Code 不用当前账号，需要找电脑管理员处理')
    expect(item?.details?.workspace).toBeUndefined()
  })

  it('rejects failed relay responses and refuses automatic redirects', async () => {
    const home = temporaryHome()
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }))
    const input = dependencies(home)
    input.fetch = fetchImpl

    const report = await runDiagnostics(input)

    expect(fetchImpl).toHaveBeenCalledWith('https://xm.solov.cc/api/status', expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
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
        label: 'a certificate whose dates do not line up',
        error: new Error('net::ERR_CERT_DATE_INVALID'),
        reason: 'certDate',
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
        details: { endpoint: 'https://xm.solov.cc/api/status', reason },
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

    // #302 的误报：站点根路径本来就是网页前端，正常时也回 text/html。探测改打
    // 本来就回 JSON 的状态接口后，根路径长什么样不再影响结论。
    it('passes a healthy site whose home page is a web page but whose status endpoint answers JSON', async () => {
      const home = temporaryHome()
      const input = dependencies(home)
      const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url) === 'https://xm.solov.cc/api/status'
        ? statusJson()
        : new Response('<!doctype html><title>星芒AI</title>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }))
      input.fetch = fetchImpl

      const report = await runDiagnostics(input)

      expect(report.items.find((item) => item.code === 'XINGMANG_NETWORK')).toMatchObject({
        state: 'pass',
        summary: '能连上星芒服务',
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(fetchImpl.mock.calls[0][0]).toBe('https://xm.solov.cc/api/status')
    })

    it('treats a login page served in place of the status endpoint as interception', async () => {
      const home = temporaryHome()
      const input = dependencies(home)
      const log = vi.fn()
      input.log = log
      input.fetch = vi.fn(async () => new Response('<html><body>请先登录校园网</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }))

      const report = await runDiagnostics(input)

      expect(report.items.find((item) => item.code === 'XINGMANG_NETWORK')).toMatchObject({
        state: 'fail',
        summary: networkFailureMessages.intercepted,
        details: { endpoint: 'https://xm.solov.cc/api/status', reason: 'intercepted', status: 200 },
      })
      expect(log).toHaveBeenCalledWith(
        'warn',
        'diagnostics.network.failed',
        expect.stringContaining('intercepted'),
        expect.objectContaining({ contentType: 'text/html; charset=utf-8' }),
      )
    })

    // 有的门户页不写 content-type，或者写成 JSON 骗过浏览器；判断看的是内容本身。
    it('judges by the body rather than the declared content type', async () => {
      const home = temporaryHome()
      const input = dependencies(home)
      input.fetch = vi.fn(async () => new Response('<html>portal</html>', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))

      const report = await runDiagnostics(input)

      expect(report.items.find((item) => item.code === 'XINGMANG_NETWORK')).toMatchObject({
        state: 'fail',
        details: { reason: 'intercepted' },
      })
    })

    it('does not read an error page body and still reports the HTTP status', async () => {
      const home = temporaryHome()
      const input = dependencies(home)
      input.fetch = vi.fn(async () => new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }))

      const report = await runDiagnostics(input)

      const network = report.items.find((item) => item.code === 'XINGMANG_NETWORK')
      expect(network).toMatchObject({ state: 'fail', details: { status: 502 } })
      expect(network?.summary).toContain('HTTP 502')
      expect(network?.details).not.toHaveProperty('reason')
    })

    it('classifies a connection cut while the answer is still arriving', async () => {
      const home = temporaryHome()
      const input = dependencies(home)
      const cut = new TypeError('terminated', {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      })
      input.fetch = vi.fn(async () => new Response(new ReadableStream({
        pull(controller) {
          controller.error(cut)
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))

      const report = await runDiagnostics(input)

      const network = report.items.find((item) => item.code === 'XINGMANG_NETWORK')
      expect(network?.state).toBe('fail')
      expect(network?.details).toHaveProperty('reason')
    })

    it('probes the historical account site through its own public settings endpoint', async () => {
      const home = temporaryHome()
      const input = dependencies(home)
      const historical = relaySites.find((site) => site.accountBackend === 'sub2api')
      expect(historical).toBeDefined()
      input.relaySite = historical
      const fetchImpl = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ code: 0, message: 'success', data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }))
      input.fetch = fetchImpl

      const report = await runDiagnostics(input)

      expect(fetchImpl.mock.calls[0][0]).toBe('https://api.solov.cc/api/v1/settings/public')
      const network = report.items.find((item) => item.code === 'XINGMANG_NETWORK')
      expect(network).toMatchObject({ state: 'pass' })
      // 结论文案不出现站点名。
      expect(network?.summary).not.toMatch(/solov|星芒AI（/)
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

  describe('relayStatusProbeUrl', () => {
    it('points every site at a JSON endpoint on the origin its CLIs call, never at the home page', () => {
      for (const site of relaySites) {
        const url = new URL(relayStatusProbeUrl(site))
        expect(url.origin).toBe(new URL(site.providerBaseUrls.claude).origin)
        expect(url.protocol).toBe('https:')
        expect(url.pathname.startsWith('/api/')).toBe(true)
      }
      expect(relayStatusProbeUrl(relaySites[0])).toBe('https://xm.solov.cc/api/status')
    })

    it('refuses to probe a site that is not served over https', () => {
      const site = { ...relaySites[0], providerBaseUrls: { ...relaySites[0].providerBaseUrls, claude: 'http://xm.solov.cc' } }
      expect(() => relayStatusProbeUrl(site)).toThrow('https')
    })
  })

  // 候选 4：证书过没过期是拿本机时钟比出来的，所以「证书日期对不上」的真正源头
  // 往往是这台电脑的时间。这一次探测的响应头里就有服务器时间，顺手比一次。
  describe('clock skew from a response header', () => {
    it('reads the server time out of the Date header', () => {
      const now = new Date('2026-09-22T08:10:00.000Z')
      expect(clockSkewMs('Tue, 22 Sep 2026 08:00:00 GMT', now)).toBe(10 * 60 * 1000)
      expect(clockSkewMs('Tue, 22 Sep 2026 08:20:00 GMT', now)).toBe(-10 * 60 * 1000)
    })

    it('answers null rather than guessing when there is nothing to compare against', () => {
      const now = new Date('2026-09-22T08:10:00.000Z')
      expect(clockSkewMs(null, now)).toBeNull()
      expect(clockSkewMs(undefined, now)).toBeNull()
      expect(clockSkewMs('', now)).toBeNull()
      expect(clockSkewMs('不是一个时间', now)).toBeNull()
    })

    it('names a real settings page on each supported system', () => {
      expect(clockSyncGuidance('win32')).toContain('时间和语言')
      expect(clockSyncGuidance('darwin')).toContain('日期与时间')
      expect(clockSyncGuidance('linux')).toContain('自动同步')
    })
  })

  describe('system clock comparison on the network probe', () => {
    function probe(input: DiagnosticsDependencies, headers: Record<string, string>) {
      const fetchImpl = vi.fn(async () => statusJson(headers))
      input.fetch = fetchImpl
      return fetchImpl
    }

    function networkItem(report: Awaited<ReturnType<typeof runDiagnostics>>) {
      return report.items.find((item) => item.code === 'XINGMANG_NETWORK')
    }

    it('stays quiet while the clock is within five minutes of the server', async () => {
      const input = dependencies(temporaryHome())
      const fetchImpl = probe(input, { date: 'Tue, 22 Sep 2026 08:00:00 GMT' })
      input.now = () => new Date('2026-09-22T08:04:30.000Z')

      const report = await runDiagnostics(input)

      expect(networkItem(report)).toMatchObject({ state: 'pass', summary: '能连上星芒服务' })
      // 不新增请求：这一项本来就要发的那一次请求就是全部。
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['ahead of the server', '2026-09-22T08:20:00.000Z', 20],
      ['behind the server', '2026-09-22T07:11:00.000Z', -49],
    ])('marks a clock %s as something to look at', async (_label, localTime, minutes) => {
      const input = dependencies(temporaryHome())
      const fetchImpl = probe(input, { date: 'Tue, 22 Sep 2026 08:00:00 GMT' })
      input.now = () => new Date(localTime)

      const report = await runDiagnostics(input)

      const network = networkItem(report)
      expect(network).toMatchObject({
        state: 'warn',
        details: { status: 200, clockSkewMinutes: minutes },
      })
      expect(network?.summary).toContain(`相差约 ${Math.abs(minutes)} 分钟`)
      expect(network?.summary).toContain('自动设置时间')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('names the entry point of whichever system the user is on', async () => {
      const input = dependencies(temporaryHome())
      probe(input, { date: 'Tue, 22 Sep 2026 08:00:00 GMT' })
      input.platform = 'darwin'
      input.now = () => new Date('2026-09-22T09:00:00.000Z')

      const report = await runDiagnostics(input)

      expect(networkItem(report)?.summary).toContain('系统设置 → 通用 → 日期与时间')
    })

    it.each([
      ['no Date header at all', {}],
      ['a Date header nothing can parse', { date: 'not-a-date' }],
    ])('says nothing about the clock when the answer carries %s', async (_label, headers) => {
      const input = dependencies(temporaryHome())
      probe(input, headers)
      input.now = () => new Date('2031-01-01T00:00:00.000Z')

      const report = await runDiagnostics(input)

      const network = networkItem(report)
      expect(network).toMatchObject({ state: 'pass', summary: '能连上星芒服务' })
      expect(network?.details).not.toHaveProperty('clockSkewMinutes')
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
        openai_api_key: 'sk-must-not-leak-key',
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
        // 大小写不敏感：Windows 上 `openai_api_key` 与大写是同一个变量。
        variable3: 'OPENAI_API_KEY（Codex CLI）',
        variable4: 'GEMINI_MODEL（Gemini CLI）',
      })
      expect(JSON.stringify(item)).not.toMatch(/must-not-leak|gateway\.example\.com/)
    })

    // 这四个在沙箱里实测会让 CLI 绕开写入的配置（diagnostics.ts 的 breaksAccount），
    // 用户在终端里跑就连不上当前账号，所以是待处理，开机提示也会数它。
    it.each([
      ['ANTHROPIC_API_KEY', 'sk-must-not-leak', 'Claude Code'],
      ['CLAUDE_CONFIG_DIR', '/must-not-leak/claude', 'Claude Code'],
      ['GOOGLE_GEMINI_BASE_URL', 'https://must-not-leak.example.com', 'Gemini CLI'],
      ['GEMINI_API_KEY', 'sk-must-not-leak', 'Gemini CLI'],
    ])('treats %s as a finding to handle because it takes the CLI off the current account', async (name, value, tool) => {
      const home = temporaryHome()
      const input = dependencies(home)
      input.env = { [name]: value }

      const item = overrideItem(await runDiagnostics(input))

      expect(item).toMatchObject({
        state: 'fail',
        summary: `系统环境变量里设置了 ${name}，会让 ${tool} 不用当前账号写入的配置，删掉后重新打开终端即可`,
        details: { count: 1, variable1: `${name}（${tool}，会绕开当前账号）` },
      })
      expect(JSON.stringify(item)).not.toContain('must-not-leak')
    })

    // 这些实测盖不过写入的配置，或只换模型、不换账号：留在需留意，不在开机时打扰。
    it.each([
      ['ANTHROPIC_BASE_URL', 'https://gateway.example.com'],
      ['ANTHROPIC_AUTH_TOKEN', 'sk-shell'],
      ['OPENAI_BASE_URL', 'https://gateway.example.com/v1'],
      ['OPENAI_API_KEY', 'sk-shell'],
      ['GOOGLE_GEMINI_API_KEY', 'sk-shell'],
      ['GEMINI_MODEL', 'gemini-other'],
      ['GOOGLE_GENAI_API_VERSION', 'v1'],
    ])('keeps %s as only worth a look because the written configuration still wins', async (name, value) => {
      const home = temporaryHome()
      const input = dependencies(home)
      input.env = { [name]: value }

      expect(overrideItem(await runDiagnostics(input))).toMatchObject({
        state: 'warn',
        summary: `系统环境变量里设置了 ${name}，可能会盖过当前账号写入的配置`,
      })
    })

    it('does not escalate a Gemini base URL that already points at the current account', async () => {
      const home = temporaryHome()
      const input = dependencies(home)
      input.env = { GOOGLE_GEMINI_BASE_URL: 'https://xm.solov.cc' }

      expect(overrideItem(await runDiagnostics(input))).toMatchObject({
        state: 'pass',
        details: { count: 1, variable1: 'GOOGLE_GEMINI_BASE_URL（Gemini CLI，已指向当前账号）' },
      })
    })

    it('ignores a CLAUDE_CONFIG_DIR that points at the default directory', async () => {
      const home = temporaryHome()
      const input = dependencies(home)
      input.env = { CLAUDE_CONFIG_DIR: path.join(home, '.claude') }

      expect(overrideItem(await runDiagnostics(input))).toMatchObject({ state: 'pass', details: { count: 0 } })
    })

    it('names only the variables that break the account when both kinds are set', async () => {
      const home = temporaryHome()
      const input = dependencies(home)
      input.env = { ANTHROPIC_BASE_URL: 'https://gateway.example.com', GEMINI_API_KEY: 'sk-shell', ANTHROPIC_API_KEY: 'sk-shell' }

      expect(overrideItem(await runDiagnostics(input))).toMatchObject({
        state: 'fail',
        summary: '系统环境变量里设置了 ANTHROPIC_API_KEY、GEMINI_API_KEY，会让 Claude Code、Gemini CLI 不用当前账号写入的配置，删掉后重新打开终端即可',
        details: {
          count: 3,
          variable1: 'ANTHROPIC_BASE_URL（Claude Code）',
          variable2: 'ANTHROPIC_API_KEY（Claude Code，会绕开当前账号）',
          variable3: 'GEMINI_API_KEY（Gemini CLI，会绕开当前账号）',
        },
      })
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

    function ignoredCodexHomeInput(home: string, value: string, reason: 'relative' | 'nul' = 'relative') {
      const input = dependencies(home)
      // The host has already replaced CODEX_HOME with the default it resolved.
      input.env = { CODEX_HOME: path.join(home, '.codex') }
      input.providerRoots = { userHome: home, codexHome: path.join(home, '.codex') }
      input.ignoredCodexHome = { value, reason }
      return input
    }

    it('flags an ignored CODEX_HOME as blocking when Codex outside the app would miss the account', async () => {
      const home = temporaryHome()
      const input = ignoredCodexHomeInput(home, '%USERPROFILE%/must-not-leak-user/.codex')

      const item = overrideItem(await runDiagnostics(input))

      expect(item).toMatchObject({
        state: 'fail',
        summary: '电脑里有一个 Codex 的设置写得不对，软件已经忽略它，但在软件外面打开 Codex 会连不上当前账号',
        details: { count: 1, variable1: 'CODEX_HOME（Codex CLI，写得不对，已忽略）' },
      })
      expect(JSON.stringify(item)).not.toMatch(/must-not-leak|USERPROFILE/)
    })

    it('treats an unexpanded home shortcut and a NUL value as unreachable', async () => {
      const home = temporaryHome()

      expect(overrideItem(await runDiagnostics(ignoredCodexHomeInput(home, '~/.codex')))?.state).toBe('fail')
      expect(overrideItem(await runDiagnostics(ignoredCodexHomeInput(home, `${home}\0x`, 'nul')))?.state).toBe('fail')
    })

    it('only warns when the relative value still resolves to the managed Codex directory from the user home', async () => {
      const home = temporaryHome()

      expect(overrideItem(await runDiagnostics(ignoredCodexHomeInput(home, '.codex')))).toMatchObject({
        state: 'warn',
        summary: '电脑里有一个 Codex 的设置写得不对，软件已经忽略它',
      })
    })

    it('only warns when Codex is not connected to the current account anyway', async () => {
      const home = temporaryHome()
      const input = ignoredCodexHomeInput(home, '~/.codex')
      input.inspectProvider = (provider) => ({
        ...inspection(provider, home, 'sk-super-secret-value'),
        ...(provider === 'codex' ? { exists: false, hasApiKey: false, matchesRelay: false, apiKey: '' } : {}),
      })

      expect(overrideItem(await runDiagnostics(input))?.state).toBe('warn')
    })

    it('mentions other overriding variables after the ignored CODEX_HOME', async () => {
      const home = temporaryHome()
      const input = ignoredCodexHomeInput(home, '.codex')
      input.env = { ...input.env, OPENAI_API_KEY: 'sk-must-not-leak' }

      const item = overrideItem(await runDiagnostics(input))

      expect(item).toMatchObject({
        state: 'warn',
        summary: '电脑里有一个 Codex 的设置写得不对，软件已经忽略它；另外系统环境变量里设置了 OPENAI_API_KEY，可能会盖过当前账号写入的配置',
        details: {
          count: 2,
          variable1: 'CODEX_HOME（Codex CLI，写得不对，已忽略）',
          variable2: 'OPENAI_API_KEY（Codex CLI）',
        },
      })
      expect(JSON.stringify(item)).not.toContain('must-not-leak')
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

  it('turns a slow permission check into a reminder instead of a red timeout', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.timeoutMs = 20
    input.platform = 'win32'
    input.inspectElevationCapability = async () => await new Promise(() => undefined)

    const item = (await runDiagnostics(input)).items.find((entry) => entry.code === 'ADMINISTRATOR')

    expect(item).toMatchObject({ state: 'warn', title: '运行权限', details: { timedOut: true } })
    expect(item?.summary).toContain('不影响软件使用')
    expect(item?.summary).not.toContain('超时')
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

  it('explains the macOS git/python3 shims instead of a bare "not installed"', async () => {
    const home = temporaryHome()
    const input = { ...dependencies(home), platform: 'darwin' as const }
    const previous = input.inspectTool!
    input.inspectTool = async (tool, signal) =>
      tool === 'git' || tool === 'python'
        ? { installed: false, version: null, path: null, commandLineToolsShim: true }
        : previous(tool, signal)

    const report = await runDiagnostics(input)

    const git = report.items.find((item) => item.code === 'RUNTIME_GIT')
    const python = report.items.find((item) => item.code === 'RUNTIME_PYTHON')
    expect(git).toMatchObject({ state: 'warn', details: { installed: false } })
    expect(git?.summary).toContain('macOS 自带的 git 只是个空壳')
    expect(git?.summary).toContain('xcode-select --install')
    // PowerShell 那句只在 Windows 成立。
    expect(git?.summary).not.toContain('PowerShell')
    expect(python).toMatchObject({ state: 'warn' })
    expect(python?.summary).toContain('macOS 自带的 python3 只是个空壳')
  })

  it('explains a pending Xcode license on the Git and Python rows without leaking the raw message', async () => {
    const home = temporaryHome()
    const input = { ...dependencies(home), platform: 'darwin' as const }
    const previous = input.inspectTool!
    input.inspectTool = async (tool, signal) =>
      tool === 'git' || tool === 'python'
        ? { installed: false, version: null, path: null, commandLineToolsShim: true, xcodeLicensePending: true }
        : previous(tool, signal)

    const report = await runDiagnostics(input)

    const git = report.items.find((item) => item.code === 'RUNTIME_GIT')
    const python = report.items.find((item) => item.code === 'RUNTIME_PYTHON')
    expect(git).toMatchObject({ state: 'warn', details: { installed: false } })
    expect(git?.summary).toContain('Xcode 还没同意许可协议')
    expect(git?.summary).not.toContain('空壳')
    expect(python).toMatchObject({ state: 'warn' })
    expect(python?.summary).toContain('Xcode 还没同意许可协议')
    for (const summary of [git?.summary, python?.summary]) {
      expect(summary).not.toMatch(/sudo|xcodebuild|xcode-select/)
    }
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

  it('tells a standard Windows account that installing Node.js will ask for a password', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.inspectElevationCapability = async () => 'standard'

    const report = await runDiagnostics(input)

    expect(report.items.find((item) => item.code === 'ADMINISTRATOR')).toMatchObject({
      state: 'warn',
      summary: expect.stringContaining('不在管理员组'),
      details: { elevated: false, canElevate: false },
    })
  })

  it('stays a plain pass when the account can elevate, and when the probe cannot answer', async () => {
    const home = temporaryHome()
    for (const [capability, canElevate] of [['administrator', true], ['unknown', null]] as const) {
      const input = dependencies(home)
      input.inspectElevationCapability = async () => capability

      const report = await runDiagnostics(input)

      expect(report.items.find((item) => item.code === 'ADMINISTRATOR')).toMatchObject({
        state: 'pass',
        summary: '当前以普通用户权限运行',
        details: { elevated: false, canElevate },
      })
    }
  })

  it('does not ask the elevation question on macOS, where this app never elevates', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.platform = 'darwin'
    input.inspectElevationCapability = async () => {
      throw new Error('must not probe on macOS')
    }

    const report = await runDiagnostics(input)

    expect(report.items.find((item) => item.code === 'ADMINISTRATOR')).toMatchObject({
      state: 'pass',
      summary: '当前以普通用户权限运行',
    })
  })

  it('explains that an elevated start with a failed startup probe was treated as administrator', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.windowsExecution = {
      mode: 'trusted-only',
      elapsedMs: 15_020,
      probeFailure: { reason: 'blocked', detail: 'Add-Type : Cannot add type. Compilation errors occurred.' },
    }
    input.inspectAdministrator = async () => true
    // The failure answer must not depend on a second probe of the same kind.
    input.inspectElevationCapability = async () => {
      throw new Error('must not probe capability once the startup probe failed')
    }

    const report = await runDiagnostics(input)
    const item = report.items.find((entry) => entry.code === 'ADMINISTRATOR')

    expect(item).toMatchObject({
      state: 'warn',
      details: { elevated: true, executionMode: 'trusted-only', probeFailure: 'blocked', probeElapsedMs: 15_020 },
    })
    expect(item?.summary).toContain('已按管理员方式处理')
    expect(item?.summary).toContain('被安全软件或电脑的管控策略拦下了')
    expect(item?.summary).toContain('直接双击重新打开')
    // 上游英文原文只进运行日志，不上屏；文案不出现技术词。
    expect(item?.summary).not.toMatch(/Add-Type|Compilation|PowerShell|管理员组|SID/)
    // 不能教用户「以管理员身份运行」来绕过去。
    expect(item?.summary).not.toContain('以管理员身份运行本')
  })

  it('reports a plain user when the startup probe learned nothing and was treated as an ordinary user', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.windowsExecution = {
      mode: 'same-user',
      elapsedMs: 15_000,
      probeFailure: { reason: 'timeout', detail: 'signal=SIGTERM' },
    }
    input.inspectAdministrator = async () => {
      throw new Error('powershell timed out again')
    }
    input.inspectElevationCapability = async () => {
      throw new Error('must not probe capability once the startup probe failed')
    }

    const item = (await runDiagnostics(input)).items.find((entry) => entry.code === 'ADMINISTRATOR')

    expect(item).toMatchObject({
      state: 'pass',
      summary: '当前以普通用户权限运行',
      details: { elevated: null, executionMode: 'same-user', probeFailure: 'timeout', probeElapsedMs: 15_000 },
    })
  })

  it('still advises a normal start when the live token is elevated after an unanswered startup probe', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.windowsExecution = { mode: 'same-user', elapsedMs: 900, probeFailure: { reason: 'failed', detail: 'x' } }
    input.inspectAdministrator = async () => true

    expect((await runDiagnostics(input)).items.find((item) => item.code === 'ADMINISTRATOR')).toMatchObject({
      state: 'warn',
      summary: '当前以管理员权限运行，建议普通启动',
      details: { probeFailure: 'failed', executionMode: 'same-user' },
    })
  })

  it('keeps the old answers when the startup probe succeeded or on macOS', async () => {
    const home = temporaryHome()
    const succeeded = dependencies(home)
    succeeded.windowsExecution = { mode: 'same-user', elapsedMs: 900 }
    expect((await runDiagnostics(succeeded)).items.find((item) => item.code === 'ADMINISTRATOR')).toMatchObject({
      state: 'pass',
      summary: '当前以普通用户权限运行',
    })

    const mac = dependencies(home)
    mac.platform = 'darwin'
    mac.windowsExecution = { mode: 'trusted-only', elapsedMs: 1, probeFailure: { reason: 'failed', detail: 'x' } }
    expect((await runDiagnostics(mac)).items.find((item) => item.code === 'ADMINISTRATOR')).toMatchObject({
      state: 'pass',
    })
  })

  it('passes the folder check when nothing on the way to the data folders is redirected', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.userDataDirectory = path.join(home, 'AppData', 'Roaming', 'xingmang')
    input.findReparseComponent = () => null

    const item = (await runDiagnostics(input)).items.find((entry) => entry.code === 'FOLDER_RELOCATED')

    expect(item).toMatchObject({ state: 'pass', title: '文件夹位置', details: { relocated: 0 } })
  })

  it('names a relocated user folder once, in plain words, and says why saving fails', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.userDataDirectory = path.join(home, 'AppData', 'Roaming', 'xingmang')
    const checked: string[] = []
    // 整个用户文件夹被「C 盘搬家」挪到了 D 盘：下面每个文件夹都经过同一级。
    input.findReparseComponent = (target) => {
      checked.push(target)
      return { component: home, target: 'D:\\Users\\peaker' }
    }

    const item = (await runDiagnostics(input)).items.find((entry) => entry.code === 'FOLDER_RELOCATED')

    expect(checked).toEqual(expect.arrayContaining([
      home,
      input.userDataDirectory,
      path.join(home, '.claude'),
      path.join(home, '.codex'),
    ]))
    expect(item?.state).toBe('fail')
    expect(item?.summary).toContain('用户文件夹、软件数据文件夹、Claude Code 配置文件夹')
    expect(item?.summary).toContain('被搬到了 D 盘')
    expect(item?.summary).toContain('C 盘搬家')
    expect(item?.summary).toContain('写入 Key、保存设置、记录日志都可能失败')
    expect(item?.summary).not.toMatch(/AppData|junction|联接|符号链接/)
    expect(item?.details).toMatchObject({ relocated: 1, to1: 'D 盘' })
    // 搬过去的路径带着用户名，报告的脱敏认不出它，所以压根不写进去。
    expect(JSON.stringify(item)).not.toContain('peaker')
  })

  it('passes the folder check when every relocated folder is followed', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.platform = 'win32'
    input.userDataDirectory = path.join(home, 'AppData', 'Roaming', 'xingmang')
    const moved = path.join(home, 'D-moved')
    input.resolveRelocatedPath = (target) => (target.startsWith(home) ? `${moved}${target.slice(home.length)}` : target)
    input.findReparseComponent = (target) => (target.startsWith(moved)
      ? null
      : { component: home, target: 'D:\\Users\\peaker' })

    const item = (await runDiagnostics(input)).items.find((entry) => entry.code === 'FOLDER_RELOCATED')

    expect(item?.state).toBe('pass')
    expect(item?.summary).toContain('在 D 盘')
    expect(item?.summary).toContain('能正常使用')
    expect(item?.details).toMatchObject({ relocated: 1, followed: true })
    expect(JSON.stringify(item)).not.toContain('peaker')
  })

  it('tells an elevated run to reopen the app normally when a relocation is refused', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.platform = 'win32'
    input.windowsExecution = { mode: 'trusted-only', elapsedMs: 5 }
    input.findReparseComponent = () => ({ component: home, target: 'D:\\Users\\peaker' })

    const item = (await runDiagnostics(input)).items.find((entry) => entry.code === 'FOLDER_RELOCATED')

    expect(item?.state).toBe('fail')
    expect(item?.summary).toContain('管理员身份运行')
    expect(item?.summary).toContain('直接双击打开')
    expect(item?.details).toMatchObject({ elevated: true })
  })

  it('names only the drive or disk a folder was moved to', () => {
    expect(describeRelocationTarget('D:\\Users\\alice', 'win32')).toBe(' D 盘')
    expect(describeRelocationTarget('\\\\?\\e:\\Users\\alice\\.codex', 'win32')).toBe(' E 盘')
    expect(describeRelocationTarget('\\\\nas\\home\\alice', 'win32')).toBe('另一台电脑的共享文件夹')
    expect(describeRelocationTarget('Users\\alice', 'win32')).toBe('别的位置')
    expect(describeRelocationTarget('/Volumes/Backup/alice/.codex', 'darwin')).toBe('外接磁盘「Backup」')
    expect(describeRelocationTarget('/Users/alice/Dropbox/.codex', 'darwin')).toBe('别的位置')
  })

  it('leaves the Windows-only hint out on macOS', async () => {
    const home = temporaryHome()
    const input = dependencies(home)
    input.platform = 'darwin'
    input.findReparseComponent = (target) => (target === path.join(home, '.codex')
      ? { component: path.join(home, '.codex'), target: null }
      : null)

    const item = (await runDiagnostics(input)).items.find((entry) => entry.code === 'FOLDER_RELOCATED')

    expect(item?.state).toBe('fail')
    expect(item?.summary).toContain('Codex CLI 配置文件夹被搬走了，但读不出它现在在哪里')
    expect(item?.summary).not.toContain('C 盘搬家')
  })

  it('groups relocated folders by the redirected component and skips probes that throw', () => {
    const findings = findRelocatedFolders(
      [
        { label: '甲', path: '/a/one' },
        { label: '乙', path: '/a/two' },
        { label: '丙', path: '/b' },
        { label: '丁', path: '/c' },
      ],
      (target) => {
        if (target === '/c') throw new Error('unexpected')
        if (target.startsWith('/a')) return { component: '/a', target: '/mnt/a' }
        if (target === '/b') return { component: '/b', target: null }
        return null
      },
    )
    expect(findings).toEqual([
      { component: '/a', target: '/mnt/a', labels: ['甲', '乙'] },
      { component: '/b', target: null, labels: ['丙'] },
    ])
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

  it('does not call the bypass mode a risk when this app wrote it for the signed-in account', async () => {
    const home = temporaryHome()
    const claudeSettings = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true })
    fs.writeFileSync(claudeSettings, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))
    const input = dependencies(home)
    input.readClaudeConfigOwnership = () => 'account'

    const report = await runDiagnostics(input)

    expect(report.items.find((item) => item.code === 'CLAUDE_BYPASS_PERMISSIONS')).toMatchObject({
      state: 'pass',
      details: { bypass: true, managed: true },
    })
  })

  it.each(['manual', 'unknown', 'changed'] as const)(
    'still warns about the bypass mode when the config source reads %s',
    async (ownership) => {
      const home = temporaryHome()
      const claudeSettings = path.join(home, '.claude', 'settings.json')
      fs.mkdirSync(path.dirname(claudeSettings), { recursive: true })
      fs.writeFileSync(claudeSettings, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))
      const input = dependencies(home)
      input.readClaudeConfigOwnership = () => ownership

      const report = await runDiagnostics(input)

      expect(report.items.find((item) => item.code === 'CLAUDE_BYPASS_PERMISSIONS')).toMatchObject({
        state: 'warn',
        details: { bypass: true, managed: false },
      })
    },
  )

  it('warns about the bypass mode when the host cannot tell who wrote the config', async () => {
    const home = temporaryHome()
    const claudeSettings = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true })
    fs.writeFileSync(claudeSettings, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))

    const report = await runDiagnostics(dependencies(home))

    expect(report.items.find((item) => item.code === 'CLAUDE_BYPASS_PERMISSIONS')).toMatchObject({
      state: 'warn',
      details: { bypass: true, managed: false },
    })
  })

  it('passes without a managed note when Claude asks before running commands', async () => {
    const home = temporaryHome()
    const claudeSettings = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true })
    fs.writeFileSync(claudeSettings, JSON.stringify({ permissions: { defaultMode: 'default' } }))
    const input = dependencies(home)
    input.readClaudeConfigOwnership = () => 'account'

    const report = await runDiagnostics(input)

    expect(report.items.find((item) => item.code === 'CLAUDE_BYPASS_PERMISSIONS')).toMatchObject({
      state: 'pass',
      details: { bypass: false, managed: false },
    })
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

describe('the disk space check', () => {
  const gigabyte = 1024 ** 3

  function diskDependencies(
    home: string,
    readDiskSpace: DiagnosticsDependencies['readDiskSpace'],
  ): DiagnosticsDependencies {
    const input = dependencies(home)
    // 托管目录这一处要算得出来才有两块盘可比。win32 要真实的 ProgramData，
    // macOS 只要一个 posix 绝对路径的 HOME——所以这里钉成 darwin 并给一个不落地
    // 的 HOME（磁盘读取是注入的，路径不会真的被访问），三个平台的结果才一致。
    input.platform = 'darwin'
    input.env = { HOME: '/Users/fixture' }
    input.userDataDirectory = '/Users/fixture/Library/Application Support/XingMangAI'
    input.readDiskSpace = readDiskSpace
    return input
  }

  function reading(availableBytes: number, measuredPath: string, deviceId: number) {
    return { availableBytes, totalBytes: 256 * gigabyte, measuredPath, deviceId }
  }

  it('passes and writes out how much is left', async () => {
    const home = temporaryHome()
    const report = await runDiagnostics(diskDependencies(
      home,
      async (target) => reading(40 * gigabyte, target, 1),
    ))

    const item = report.items.find((entry) => entry.code === 'DISK_SPACE')
    expect(item).toMatchObject({ state: 'pass' })
    expect(item?.summary).toContain('40.0 GB')
    // 两处目录同在一块盘上（同一个设备号）时只说一遍。
    expect(item?.details?.measured).toBe(1)
  })

  it('flags a tight disk as worth watching and a nearly full one as blocking', async () => {
    const home = temporaryHome()
    const tight = await runDiagnostics(diskDependencies(
      home,
      async (target) => reading(Math.floor(1.5 * gigabyte), target, 1),
    ))
    const full = await runDiagnostics(diskDependencies(
      home,
      async (target) => reading(300 * 1024 ** 2, target, 1),
    ))

    expect(tight.items.find((entry) => entry.code === 'DISK_SPACE')).toMatchObject({ state: 'warn' })
    const blocked = full.items.find((entry) => entry.code === 'DISK_SPACE')
    expect(blocked?.state).toBe('fail')
    expect(blocked?.summary).toContain('300 MB')
    expect(blocked?.summary).toContain('装不下')
  })

  it('reports two disks separately and judges by the tighter one', async () => {
    const home = temporaryHome()
    let device = 0
    const report = await runDiagnostics(diskDependencies(home, async (target) => {
      device += 1
      return reading(device === 1 ? 40 * gigabyte : 500 * 1024 ** 2, target, device)
    }))

    const item = report.items.find((entry) => entry.code === 'DISK_SPACE')
    expect(item?.details?.measured).toBe(2)
    expect(item?.state).toBe('fail')
  })

  it('does not turn an unreadable filesystem into a problem to fix', async () => {
    const home = temporaryHome()
    const report = await runDiagnostics(diskDependencies(home, async () => null))

    expect(report.items.find((entry) => entry.code === 'DISK_SPACE')).toMatchObject({
      state: 'warn',
      summary: expect.stringContaining('未能读取'),
      details: { measured: 0 },
    })
  })
})

describe('runDiagnostics AI output location', () => {
  it('only checks the AI output location when the host provides a probe', async () => {
    const report = await runDiagnostics(dependencies(temporaryHome()))
    expect(report.items.some((entry) => entry.code === 'AI_OUTPUT')).toBe(false)
  })

  it('passes when the probe can write', async () => {
    const probeAiOutput = vi.fn(async () => undefined)
    const report = await runDiagnostics({ ...dependencies(temporaryHome()), probeAiOutput })

    expect(probeAiOutput).toHaveBeenCalledTimes(1)
    expect(report.items.find((entry) => entry.code === 'AI_OUTPUT')).toMatchObject({
      state: 'pass',
      title: 'AI 作品保存位置',
    })
  })

  it('shows an unwritable location as worth watching, in plain words, and logs the raw reason', async () => {
    const home = temporaryHome()
    const log = vi.fn()
    const cause = Object.assign(new Error(`EACCES: permission denied, open '${path.join(home, 'output', '.write-check.tmp')}'`), { code: 'EACCES' })
    const report = await runDiagnostics({
      ...dependencies(home),
      log,
      probeAiOutput: async () => { throw new Error('保存位置写不进去，这次没有扣费。', { cause }) },
    })

    const item = report.items.find((entry) => entry.code === 'AI_OUTPUT')
    // warn, not fail: the paid request is already stopped before charging, and
    // a fail would put a startup notice in front of people who never generate.
    expect(item?.state).toBe('warn')
    expect(item?.summary).toContain('扣费前先拦下来')
    expect(item?.summary).not.toMatch(/权限|Program Files|EACCES|output/)
    expect(log).toHaveBeenCalledWith('warn', 'diagnostics.ai-output.unwritable', expect.any(String), expect.objectContaining({
      raw: expect.stringContaining('EACCES'),
    }))
    expect(JSON.stringify(log.mock.calls)).not.toContain(home)
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

describe('diagnostics reusing the home page scan', () => {
  function scanned(overrides: { gitFailed?: boolean; codexFailed?: boolean; desktopFailed?: boolean } = {}): DiagnosticsScanSnapshot {
    const tool = (version: string, failed = false) => failed
      ? { installed: false, version: null, path: null, installDirectory: null, detectionFailed: true, detectionError: '探测失败' }
      : { installed: true, version, path: `C:\\tools\\${version}.exe`, installDirectory: null }
    const cli = (version: string, failed = false) => ({ ...tool(version, failed), latestVersion: null, updateAvailable: false })
    return {
      runtime: { node: tool('22.12.0'), npm: tool('10.9.0'), python: { installed: false, version: null, path: null, installDirectory: null }, git: tool('2.47.0', overrides.gitFailed) },
      clis: { claude: cli('2.1.277'), codex: cli('0.155.1', overrides.codexFailed), gemini: cli('0.60.0'), grok: cli('1.0.40') },
      desktopApps: { codex: { ...tool('26.1', overrides.desktopFailed), appVersion: null, mirrorVersion: null, mirrorUpdateAvailable: null, mirrorError: null, running: false } },
    } as unknown as DiagnosticsScanSnapshot
  }

  function probes(home: string) {
    const input = dependencies(home)
    const inspectTool = vi.fn(input.inspectTool!)
    const inspectPowerShell = vi.fn(input.inspectPowerShell!)
    const inspectCodexDesktop = vi.fn(input.inspectCodexDesktop!)
    return { input: { ...input, inspectTool, inspectPowerShell, inspectCodexDesktop, resolvePowerShellExecutable: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }, inspectTool, inspectPowerShell, inspectCodexDesktop }
  }

  it('answers runtimes, CLIs, the desktop app and PowerShell from the scan without starting any probe', async () => {
    const p = probes(temporaryHome())
    const report = await runDiagnostics({ ...p.input, recentScan: scanned() })
    expect(p.inspectTool).not.toHaveBeenCalled()
    expect(p.inspectPowerShell).not.toHaveBeenCalled()
    expect(p.inspectCodexDesktop).not.toHaveBeenCalled()
    expect(report.items.find((item) => item.code === 'RUNTIME_NODE')).toMatchObject({ state: 'pass', summary: '22.12.0' })
    expect(report.items.find((item) => item.code === 'RUNTIME_PYTHON')).toMatchObject({ state: 'warn', summary: '未安装' })
    expect(report.items.find((item) => item.code === 'CLI_CODEX')).toMatchObject({ state: 'pass', summary: '0.155.1' })
    expect(report.items.find((item) => item.code === 'SYSTEM_POWERSHELL')).toMatchObject({ state: 'pass', summary: '可用' })
    expect(report.items.find((item) => item.code === 'CODEX_DESKTOP')).toMatchObject({ state: 'pass', summary: '已安装，当前未运行' })
  })

  it('still probes the items the scan itself could not detect', async () => {
    const p = probes(temporaryHome())
    await runDiagnostics({ ...p.input, recentScan: scanned({ gitFailed: true, codexFailed: true, desktopFailed: true }) })
    expect(p.inspectTool.mock.calls.map(([tool]) => tool).sort()).toEqual(['codex', 'git'])
    expect(p.inspectCodexDesktop).toHaveBeenCalledOnce()
    // 桌面端那次 PowerShell 没跑成，就证明不了 PowerShell 可用，得自己起一次。
    expect(p.inspectPowerShell).toHaveBeenCalledOnce()
  })

  it('probes everything itself when no scan is handed in, as a manual re-check does', async () => {
    const p = probes(temporaryHome())
    await runDiagnostics(p.input)
    expect(p.inspectTool).toHaveBeenCalledTimes(8)
    expect(p.inspectPowerShell).toHaveBeenCalledOnce()
    expect(p.inspectCodexDesktop).toHaveBeenCalledOnce()
  })
})

