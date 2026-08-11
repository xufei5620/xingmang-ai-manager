import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderId } from './catalog'
import type { ProviderConfigRoots } from './codex-home'
import type { NativeConfigInspection } from './config-files'
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
    expect(report.items.find((item) => item.code === 'XINGMANG_NETWORK')).toMatchObject({
      state: 'error',
      summary: '检查时发生错误',
      details: { reason: '星芒 AI 返回 HTTP 503' },
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
