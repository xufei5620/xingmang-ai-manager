import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandRunnerError, type runCommand as productionRunCommand } from './command-runner'
import { codexPluginCatalogNetworkMessage } from './codex-plugin-catalog'
import { providerIds } from './catalog'
import type { ProviderId } from './catalog'
import {
  claudeMarketplaceGitMissingMessage,
  claudeOfficialMarketplaceAddArgv,
  createProviderSourceUpdateInspector,
  detectMcpPackageSource,
  isNetworkBoundExtensionMutation,
  normalizeGitHubRemoteUrl,
  packageCommandExecutionMode,
  parseGitRemoteHead,
  parseClaudeMarketplaceNames,
  parseClaudeMcpHealth,
  parseGeminiMcpHealth,
  parseGeminiSkillList,
  parseProviderPluginList,
  providerCommandResolutionOrder,
  ProviderExtensionService,
  readClaudeSettingsMarketplaceNames,
  readLocalGitMetadata,
  resolveProviderCommand,
  selectProviderCommandOutput,
  type ProviderCliInvoker,
  type SourceUpdateInspector,
} from './provider-extensions'
import { setRelocatedFolderPolicy } from './relocated-folders'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-provider-extensions-'))
  temporaryDirectories.push(directory)
  return directory
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o700)
}

const registeredMarketplaceList = JSON.stringify([
  { name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official' },
])

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('MCP source recognition', () => {
  it('recognizes only explicit npm, PyPI and Git launch sources', () => {
    expect(detectMcpPackageSource('npx.cmd', ['-y', '@scope/server@1.2.3'])).toEqual({
      kind: 'npm', locator: '@scope/server', reference: '1.2.3',
    })
    expect(detectMcpPackageSource('uvx', ['--from', 'mcp-server-demo@2.0.0', 'demo'])).toEqual({
      kind: 'pypi', locator: 'mcp-server-demo', reference: '2.0.0',
    })
    expect(detectMcpPackageSource('npx', ['git+https://github.com/acme/server.git#abc'])).toEqual({
      kind: 'git', locator: 'https://github.com/acme/server.git', reference: 'abc',
    })
    expect(detectMcpPackageSource('node', ['C:\\tools\\server.js'])).toEqual({
      kind: 'source-unknown', locator: null, reference: null,
    })
    expect(detectMcpPackageSource('python', ['-m', 'some_module'])).toEqual({
      kind: 'source-unknown', locator: null, reference: null,
    })
  })

  it('does not read a plain service endpoint as a git repository', () => {
    // mcp-remote takes the endpoint as a positional argument. Reading it as a
    // git source made enrichUpdates report latestVersion: null, silently
    // skipping the npm version check for the package that actually runs.
    expect(detectMcpPackageSource('npx', ['-y', 'mcp-remote', 'https://example.com/mcp'])).toEqual({
      kind: 'npm', locator: 'mcp-remote', reference: null,
    })
    expect(detectMcpPackageSource('npx', ['-y', 'mcp-remote', 'http://127.0.0.1:8080/sse'])).toEqual({
      kind: 'npm', locator: 'mcp-remote', reference: null,
    })
  })

  it('still recognises every explicit git spelling', () => {
    // These name the transport outright, so they stay git with or without a
    // .git suffix; a bare http(s) URL only counts when it carries one.
    for (const entry of [
      'git+https://github.com/acme/server',
      'git@github.com:acme/server.git',
      'ssh://git@github.com/acme/server',
      'https://github.com/acme/server.git',
      'https://github.com/acme/server#v1.2.3',
    ]) {
      expect(detectMcpPackageSource('npx', [entry]).kind).toBe('git')
    }
  })
})

describe('provider source update network policy', () => {
  it('queries only exact official npm and PyPI JSON endpoints without redirects', async () => {
    const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      const body = href.includes('pypi.org')
        ? JSON.stringify({ info: { version: '2.0.0' } })
        : JSON.stringify({ version: '3.0.0' })
      const response = new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
      })
      Object.defineProperty(response, 'url', { value: href })
      expect(init).toMatchObject({ redirect: 'error' })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return response
    })
    const inspect = createProviderSourceUpdateInspector({}, 'same-user', { fetch: fetchImplementation })

    await expect(inspect({
      kind: 'npm', locator: '@scope/server', currentVersion: '1.0.0',
    })).resolves.toMatchObject({ latestVersion: '3.0.0' })
    await expect(inspect({
      kind: 'pypi', locator: 'mcp-server-demo', currentVersion: '1.0.0',
    })).resolves.toMatchObject({ latestVersion: '2.0.0' })

    expect(fetchImplementation.mock.calls.map(([url]) => String(url))).toEqual([
      'https://registry.npmjs.org/%40scope%2Fserver/latest',
      'https://pypi.org/pypi/mcp-server-demo/json',
    ])
  })

  it('rejects redirected and oversized registry responses', async () => {
    const redirectedFetch = vi.fn(async () => {
      const response = new Response('{"version":"9.9.9"}', { status: 200 })
      Object.defineProperty(response, 'url', { value: 'https://evil.example/package/latest' })
      return response
    }) as typeof globalThis.fetch
    const redirected = createProviderSourceUpdateInspector({}, 'same-user', { fetch: redirectedFetch })
    await expect(redirected({
      kind: 'npm', locator: 'sample', currentVersion: '1.0.0',
    })).rejects.toThrow('不受信任的重定向')

    const oversizedBody = JSON.stringify({ version: 'x'.repeat(512 * 1024) })
    const oversizedFetch = vi.fn(async (url: string | URL | Request) => {
      const response = new Response(oversizedBody, {
        status: 200,
        headers: { 'Content-Length': String(Buffer.byteLength(oversizedBody)) },
      })
      Object.defineProperty(response, 'url', { value: String(url) })
      return response
    }) as typeof globalThis.fetch
    const oversized = createProviderSourceUpdateInspector({}, 'same-user', { fetch: oversizedFetch })
    await expect(oversized({
      kind: 'pypi', locator: 'sample', currentVersion: '1.0.0',
    })).rejects.toThrow(/安全上限|大小/)
  })

  it('normalizes GitHub remotes and rejects other hosts or remote helpers', () => {
    expect(normalizeGitHubRemoteUrl('https://github.com/acme/server.git'))
      .toBe('https://github.com/acme/server.git')
    expect(normalizeGitHubRemoteUrl('git@github.com:acme/server.git'))
      .toBe('https://github.com/acme/server.git')
    expect(normalizeGitHubRemoteUrl('ssh://git@github.com/acme/server'))
      .toBe('https://github.com/acme/server.git')
    expect(() => normalizeGitHubRemoteUrl('https://github.com.evil.example/acme/server.git'))
      .toThrow('GitHub remote')
    expect(() => normalizeGitHubRemoteUrl('ext::powershell -Command calc'))
      .toThrow('GitHub HTTPS 或 SSH')
    expect(() => normalizeGitHubRemoteUrl('https://user:secret@github.com/acme/server.git'))
      .toThrow('不含凭据')
  })

  it('never runs the macOS git shim for an update check while the developer tools are missing', async () => {
    const repository = temporaryDirectory()
    write(path.join(repository, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const runCommandImplementation = vi.fn<typeof productionRunCommand>(async () => {
      throw new Error('must not run')
    })
    const inspect = createProviderSourceUpdateInspector({}, 'same-user', {
      platform: 'darwin',
      findExecutable: vi.fn(async () => '/usr/bin/git'),
      runCommand: runCommandImplementation,
      isCommandLineToolsShimBacked: async () => false,
    })

    await expect(inspect({
      kind: 'git',
      locator: repository,
      localPath: repository,
      currentVersion: null,
    })).rejects.toThrow('命令行开发者工具')
    expect(runCommandImplementation).not.toHaveBeenCalled()
  })

  it('disables Git redirects and accepts only a bounded HEAD hash result', async () => {
    const head = 'a'.repeat(40)
    const repository = temporaryDirectory()
    write(path.join(repository, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    write(path.join(repository, '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`)
    write(path.join(repository, '.git', 'config'), [
      '[remote "origin"]',
      '  url = git@github.com:acme/server.git',
    ].join('\n'))
    const runCommandImplementation = vi.fn<typeof productionRunCommand>(async (spec) => ({
      executable: spec.executable,
      argv: [...spec.argv],
      exitCode: 0,
      signal: null,
      stdout: `${head}\tHEAD\n`,
      stderr: '',
      outputBytes: 0,
      durationMs: 1,
    }))
    const gitExecutable = process.platform === 'win32'
      ? 'C:\\Program Files\\Git\\bin\\git.exe'
      : '/usr/bin/git'
    const inspect = createProviderSourceUpdateInspector({}, 'trusted-only', {
      findExecutable: vi.fn(async () => gitExecutable),
      runCommand: runCommandImplementation,
    })

    await expect(inspect({
      kind: 'git',
      locator: repository,
      localPath: repository,
      currentVersion: null,
    })).resolves.toEqual({
      currentVersion: 'b'.repeat(40),
      latestVersion: head,
      locator: 'https://github.com/acme/server.git',
    })
    expect(runCommandImplementation).toHaveBeenCalledTimes(1)
    expect(runCommandImplementation.mock.calls[0][0].argv).toEqual([
      '-c', 'http.followRedirects=false',
      '-c', 'credential.helper=',
      '-c', 'core.askPass=',
      'ls-remote', 'https://github.com/acme/server.git', 'HEAD',
    ])
    expect(runCommandImplementation.mock.calls[0][1]).toMatchObject({
      trustedOnly: process.platform === 'win32',
      cwd: path.dirname(gitExecutable),
      env: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
      },
    })
    expect(parseGitRemoteHead(`${head}\tHEAD\n`)).toBe(head)
    expect(() => parseGitRemoteHead('not-a-hash\tHEAD')).toThrow('无效的 HEAD')
  })

  it('reads detached and packed Git metadata without executing the local repository', () => {
    const detached = temporaryDirectory()
    write(path.join(detached, '.git', 'HEAD'), `${'c'.repeat(40)}\n`)
    write(path.join(detached, '.git', 'config'), '[remote "origin"]\nurl = https://github.com/acme/detached.git\n')
    expect(readLocalGitMetadata(detached)).toEqual({
      currentVersion: 'c'.repeat(40),
      locator: 'https://github.com/acme/detached.git',
    })

    const packed = temporaryDirectory()
    write(path.join(packed, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    write(path.join(packed, '.git', 'packed-refs'), `${'d'.repeat(40)} refs/heads/main\n`)
    write(path.join(packed, '.git', 'config'), '[remote "origin"]\nurl = git@github.com:acme/packed.git\n')
    expect(readLocalGitMetadata(packed).currentVersion).toBe('d'.repeat(40))
  })
})

describe('native plugin list parsing', () => {
  it('prefers npm CLI entries over colliding desktop executables on Windows', () => {
    expect(providerCommandResolutionOrder('codex', 'win32')).toEqual(['package', 'direct'])
    expect(providerCommandResolutionOrder('claude', 'win32')).toEqual(['package', 'direct'])
    expect(providerCommandResolutionOrder('gemini', 'win32')).toEqual(['package', 'direct'])
    expect(providerCommandResolutionOrder('grok', 'win32')).toEqual(['direct', 'package'])
    expect(providerCommandResolutionOrder('codex', 'linux')).toEqual(['direct', 'package'])
  })

  it('executes native package binaries directly and JavaScript entries through Node', () => {
    expect(packageCommandExecutionMode('C:\\npm\\claude.exe', 'win32')).toBe('native')
    expect(packageCommandExecutionMode('C:\\npm\\codex.js', 'win32')).toBe('node')
    expect(packageCommandExecutionMode('/opt/claude.exe', 'linux')).toBe('node')
  })

  it('resolves Gemini extensions through a Hermes-owned package', async () => {
    const directory = temporaryDirectory()
    const prefix = path.join(directory, 'hermes')
    const packageRoot = path.join(prefix, 'node_modules', '@google', 'gemini-cli')
    write(path.join(prefix, process.platform === 'win32' ? 'gemini.cmd' : 'gemini'), '#!/bin/sh\n')
    write(path.join(prefix, process.platform === 'win32' ? 'node.exe' : 'node'), '')
    write(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@google/gemini-cli',
      bin: { gemini: 'dist/index.js' },
    }))
    write(path.join(packageRoot, 'dist', 'index.js'), '#!/usr/bin/env node\n')

    const command = await resolveProviderCommand('gemini', { PATH: prefix, HOME: directory })

    expect(command.executable).toBe(path.resolve(
      prefix,
      process.platform === 'win32' ? 'node.exe' : 'node',
    ))
    expect(command.argv).toEqual([fs.realpathSync(path.join(packageRoot, 'dist', 'index.js'))])
  })

  it('compares installed and available versions without inventing a latest version', () => {
    const items = parseProviderPluginList('codex', JSON.stringify({
      installed: [{
        pluginId: 'alpha@curated', name: 'alpha', marketplaceName: 'curated',
        version: '1.0.0', installed: true, enabled: true,
      }, {
        pluginId: 'local@custom', name: 'local', marketplaceName: 'custom',
        version: '3.0.0', installed: true, enabled: true,
      }],
      available: [{
        pluginId: 'alpha@curated', name: 'alpha', marketplaceName: 'curated',
        version: '1.1.0', installed: false,
      }],
    }))

    expect(items.find((item) => item.id === 'alpha@curated')).toMatchObject({
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      update: { state: 'update-available' },
    })
    expect(items.find((item) => item.id === 'local@custom')).toMatchObject({
      currentVersion: '3.0.0',
      latestVersion: null,
      update: { state: 'unsupported' },
    })
  })

  it('accepts Claude/Grok status arrays and keeps null versions unsupported', () => {
    const items = parseProviderPluginList('claude', JSON.stringify([
      { status: 'installed', name: 'tools', marketplace: 'official', version: null },
      { status: 'available', name: 'tools', marketplace: 'official', version: null },
    ]))

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      installed: true,
      currentVersion: null,
      latestVersion: null,
      update: { state: 'unsupported' },
    })
  })

  it('merges Claude installed id/scope records with marketplace metadata', () => {
    const items = parseProviderPluginList('claude', JSON.stringify({
      installed: [{
        id: 'sample@official',
        version: '1.0.0',
        scope: 'project',
        enabled: false,
        installPath: 'C:\\plugins\\sample',
      }],
      available: [{
        pluginId: 'sample@official',
        name: 'sample',
        description: 'Marketplace description',
        marketplaceName: 'official',
        version: '1.2.0',
      }],
    }))

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'sample@official',
      name: 'sample',
      description: 'Marketplace description',
      installed: true,
      enabled: false,
      scope: 'project',
      currentVersion: '1.0.0',
      latestVersion: '1.2.0',
      source: { kind: 'native', locator: 'official' },
      update: { state: 'update-available' },
    })
  })

  it('uses the Gemini extension name as the operation id and preserves its active state and source', () => {
    const items = parseProviderPluginList('gemini', JSON.stringify([{
      id: '8a34b43c7b7acb0d187dbafe95199d4eb69eb6a5cb9187e479e24fa91ad815a8',
      name: 'sample-extension',
      version: '2.3.4',
      path: 'C:\\Users\\tester\\.gemini\\extensions\\sample-extension',
      installMetadata: {
        source: 'https://github.com/acme/sample-extension.git',
      },
      isActive: false,
    }]), '2026-07-25T12:00:00.000Z', 'workspace')

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'sample-extension',
      name: 'sample-extension',
      installed: true,
      enabled: false,
      scope: 'workspace',
      currentVersion: '2.3.4',
      source: {
        kind: 'git',
        locator: 'https://github.com/acme/sample-extension.git',
      },
    })
  })

  it('uses stderr only when a provider command leaves stdout empty', () => {
    expect(selectProviderCommandOutput('', '[]\n')).toBe('[]\n')
    expect(selectProviderCommandOutput('[]\n', 'diagnostic')).toBe('[]\n')
  })
})

describe('Gemini native Skill list parsing', () => {
  it('keeps the CLI enabled state and infers the installation scope from Location', () => {
    const home = temporaryDirectory()
    const repository = path.join(home, 'workspace')
    const userSkill = path.join(home, '.gemini', 'skills', 'user-skill', 'SKILL.md')
    const workspaceSkill = path.join(repository, '.agents', 'skills', 'workspace-skill', 'SKILL.md')
    const builtinSkill = path.join(home, 'gemini-cli', 'bundle', 'builtin', 'builtin-skill', 'SKILL.md')
    const output = [
      'Discovered Agent Skills:',
      '',
      'User Skill [Disabled]',
      '  Description: User-installed skill',
      `  Location:    ${userSkill}`,
      '',
      'Workspace Skill [Enabled]',
      '  Description: Repository skill',
      `  Location:    ${workspaceSkill}`,
      '',
      'Builtin Skill [Enabled] [Built-in]',
      '  Description: Bundled by Gemini CLI',
      `  Location:    ${builtinSkill}`,
      '',
    ].join('\n')

    const items = parseGeminiSkillList(output, home, repository)

    expect(items.find((item) => item.name === 'User Skill')).toMatchObject({
      enabled: false,
      scope: 'user',
      operations: { uninstall: true, enable: true, disable: true },
    })
    expect(items.find((item) => item.name === 'Workspace Skill')).toMatchObject({
      enabled: true,
      scope: 'workspace',
      operations: { uninstall: true, enable: true, disable: true },
    })
    expect(items.find((item) => item.name === 'Builtin Skill')).toMatchObject({
      enabled: true,
      scope: 'builtin',
      source: { kind: 'native' },
      operations: { uninstall: false, enable: true, disable: true },
    })
  })

  it('disables item mutations when Gemini reports an unknown Skill location', () => {
    const home = temporaryDirectory()
    const outside = path.join(temporaryDirectory(), 'external', 'SKILL.md')
    const items = parseGeminiSkillList([
      'External Skill [Enabled]',
      '  Description: Unknown scope',
      `  Location:    ${outside}`,
      '',
    ].join('\n'), home, null)

    expect(items[0]).toMatchObject({
      scope: null,
      operations: { uninstall: false, enable: false, disable: false },
    })
  })
})

describe('ProviderExtensionService list facade', () => {
  it('uses codexEnv only for Codex and leaves all other provider roots under userHome', async () => {
    const userHome = temporaryDirectory()
    const codexHome = temporaryDirectory()
    const repository = temporaryDirectory()
    write(path.join(codexHome, 'skills', 'codex-user', 'SKILL.md'), '---\nname: Codex User\n---\n')
    write(path.join(userHome, '.agents', 'skills', 'agents-user', 'SKILL.md'), '---\nname: Agents User\n---\n')
    write(path.join(userHome, '.claude', 'skills', 'claude-user', 'SKILL.md'), '---\nname: Claude User\n---\n')
    write(path.join(userHome, '.grok', 'skills', 'grok-user', 'SKILL.md'), '---\nname: Grok User\n---\n')
    write(path.join(repository, '.codex', 'skills', 'codex-project', 'SKILL.md'), '---\nname: Codex Project\n---\n')
    write(path.join(repository, '.agents', 'skills', 'agents-project', 'SKILL.md'), '---\nname: Agents Project\n---\n')
    const baseEnv = { HOME: userHome, XINGMANG_ENV_SENTINEL: 'preserved' }
    const resolveCalls: Array<{ provider: ProviderId; env: NodeJS.ProcessEnv }> = []
    const runCalls: Array<{ provider: ProviderId; env: NodeJS.ProcessEnv }> = []
    const service = new ProviderExtensionService({
      homeDirectory: userHome,
      codexHome,
      repositoryRoot: repository,
      windowsExecutionMode: 'same-user',
      env: baseEnv,
      codexEnv: { ...baseEnv, CODEX_HOME: codexHome },
      resolveCommand: async (provider, env) => {
        resolveCalls.push({ provider, env })
        return { executable: `/trusted/${provider}`, argv: [] }
      },
      runCommand: async (command, options) => {
        runCalls.push({
          provider: path.basename(command.executable) as ProviderId,
          env: options?.env ?? {},
        })
        return {
          executable: command.executable,
          argv: [...command.argv],
          exitCode: 0,
          signal: null,
          stdout: '[]',
          stderr: '',
          outputBytes: 2,
          durationMs: 1,
        }
      },
      inspectSource: async (input) => ({
        currentVersion: input.currentVersion,
        latestVersion: input.currentVersion,
      }),
    })

    const snapshots = await service.listAll()

    for (const calls of [resolveCalls, runCalls]) {
      expect(calls.find((call) => call.provider === 'codex')?.env).toMatchObject({
        CODEX_HOME: codexHome,
        XINGMANG_ENV_SENTINEL: 'preserved',
      })
      expect(calls.filter((call) => call.provider !== 'codex').every((call) => (
        call.env.CODEX_HOME === undefined && call.env.XINGMANG_ENV_SENTINEL === 'preserved'
      ))).toBe(true)
    }
    const skillNames = (provider: ProviderId) => snapshots
      .find((snapshot) => snapshot.provider === provider)!.items
      .filter((item) => item.kind === 'skill')
      .map((item) => item.name)
    expect(skillNames('codex')).toEqual(expect.arrayContaining([
      'Codex User',
      'Agents User',
      'Codex Project',
      'Agents Project',
    ]))
    expect(skillNames('claude')).toContain('Claude User')
    expect(skillNames('grok')).toContain('Grok User')
  })

  it('degrades an oversized local MCP config to a warning without disabling the whole list', async () => {
    const home = temporaryDirectory()
    write(path.join(home, '.claude', 'settings.json'), 'x'.repeat(2 * 1024 * 1024 + 1))
    write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { alive: { command: 'node' } } }))
    const service = new ProviderExtensionService({ homeDirectory: home, invoke: async () => '[]' })

    const snapshot = await service.list('claude')

    expect(snapshot.capabilities.mcp.list).toBe(true)
    expect(snapshot.warnings.some((warning) => warning.includes('2048 KB 安全上限'))).toBe(true)
    expect(snapshot.items.some((item) => item.kind === 'mcp' && item.name === 'alive')).toBe(true)
  })

  it('allows ~/.claude.json beyond 2MB up to the relaxed limit', async () => {
    const home = temporaryDirectory()
    write(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { big: { command: 'node' } },
      padding: 'x'.repeat(3 * 1024 * 1024),
    }))
    const service = new ProviderExtensionService({ homeDirectory: home, invoke: async () => '[]' })

    const snapshot = await service.list('claude')

    expect(snapshot.capabilities.mcp.list).toBe(true)
    expect(snapshot.warnings.some((warning) => warning.includes('MCP'))).toBe(false)
    expect(snapshot.items.some((item) => item.kind === 'mcp' && item.name === 'big')).toBe(true)
  })

  it('reports malformed local MCP config instead of silently returning an empty list', async () => {
    const home = temporaryDirectory()
    write(path.join(home, '.claude.json'), '{not-json')
    const service = new ProviderExtensionService({ homeDirectory: home, invoke: async () => '[]' })

    const snapshot = await service.list('claude')

    expect(snapshot.capabilities.mcp.list).toBe(true)
    expect(snapshot.warnings.some((warning) => warning.includes('MCP 配置读取失败'))).toBe(true)
  })

  it('skips Skill roots that are directory junctions', async () => {
    const home = temporaryDirectory()
    const outside = temporaryDirectory()
    write(path.join(outside, 'linked', 'SKILL.md'), '---\nname: Linked\n---\n')
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.symlinkSync(outside, path.join(home, '.claude', 'skills'), 'junction')
    const service = new ProviderExtensionService({ homeDirectory: home, invoke: async () => '[]' })

    const snapshot = await service.list('claude')

    expect(snapshot.items.some((item) => item.kind === 'skill')).toBe(false)
  })

  it('deduplicates identical remote source checks within one snapshot', async () => {
    const home = temporaryDirectory()
    write(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        first: { command: 'npx', args: ['-y', '@acme/shared@1.0.0'] },
        second: { command: 'npx', args: ['-y', '@acme/shared@1.0.0'] },
      },
    }))
    const inspectSource: SourceUpdateInspector = vi.fn(async (input) => ({
      currentVersion: input.currentVersion,
      latestVersion: '1.1.0',
    }))
    const service = new ProviderExtensionService({
      homeDirectory: home,
      invoke: async () => '[]',
      inspectSource,
    })

    const snapshot = await service.list('claude')

    expect(snapshot.items.filter((item) => item.kind === 'mcp')).toHaveLength(2)
    expect(inspectSource).toHaveBeenCalledTimes(1)
  })

  it('merges configured MCP, filesystem skills and native plugin JSON with verified updates', async () => {
    const home = temporaryDirectory()
    write(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        pinned: { command: 'npx', args: ['-y', '@acme/mcp@1.0.0'] },
        floating: { command: 'npx', args: ['-y', '@acme/floating'] },
        local: { command: 'node', args: ['C:\\mcp\\server.js'] },
      },
    }))
    const skillDirectory = path.join(home, '.claude', 'skills', 'git-skill')
    write(path.join(skillDirectory, 'SKILL.md'), [
      '---',
      'name: Git Skill',
      'description: Managed from Git',
      '---',
      '',
    ].join('\n'))
    fs.mkdirSync(path.join(skillDirectory, '.git'))

    const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv) => {
      expect(argv).toEqual(['plugin', 'list', '--available', '--json'])
      return JSON.stringify([
        { status: 'installed', name: 'sample', marketplace: 'official', version: '1.0.0' },
        { status: 'available', name: 'sample', marketplace: 'official', version: '1.2.0' },
      ])
    })
    const inspections: string[] = []
    const inspectSource: SourceUpdateInspector = vi.fn(async (input) => {
      inspections.push(`${input.kind}:${input.locator}`)
      if (input.kind === 'git') {
        return {
          currentVersion: 'aaaaaaaa',
          latestVersion: 'bbbbbbbb',
          locator: 'https://github.com/acme/skill.git',
        }
      }
      return { currentVersion: input.currentVersion, latestVersion: '1.1.0' }
    })
    const service = new ProviderExtensionService({
      homeDirectory: home,
      invoke,
      inspectSource,
      now: () => new Date('2026-07-24T08:00:00.000Z'),
    })

    const snapshot = await service.list('claude')

    expect(snapshot.capabilities).toEqual({
      mcp: { list: true, reason: null },
      skill: { list: true, reason: null },
      plugin: { list: true, reason: null },
    })
    expect(snapshot.items.find((item) => item.id === 'pinned')).toMatchObject({
      source: { kind: 'npm', locator: '@acme/mcp', reference: '1.0.0' },
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      update: { state: 'update-available', checkedAt: '2026-07-24T08:00:00.000Z' },
    })
    expect(snapshot.items.find((item) => item.id === 'floating')).toMatchObject({
      source: { kind: 'npm', locator: '@acme/floating', reference: null },
      latestVersion: null,
      update: { state: 'unsupported', reason: 'MCP 来源未固定版本，无法确定当前实际版本' },
    })
    expect(snapshot.items.find((item) => item.id === 'local')).toMatchObject({
      source: { kind: 'source-unknown' },
      update: { state: 'source-unknown' },
    })
    expect(snapshot.items.find((item) => item.name === 'Git Skill')).toMatchObject({
      source: { kind: 'git', locator: 'https://github.com/acme/skill.git', reference: 'aaaaaaaa' },
      currentVersion: 'aaaaaaaa',
      latestVersion: 'bbbbbbbb',
      update: { state: 'update-available' },
    })
    expect(snapshot.items.find((item) => item.id === 'sample@official')).toMatchObject({
      currentVersion: '1.0.0', latestVersion: '1.2.0', update: { state: 'update-available' },
    })
    expect(inspections).toEqual([
      'npm:@acme/mcp',
      `git:${skillDirectory}`,
    ])
  })

  it('matches Claude project MCP configuration across Windows path spelling differences', async () => {
    const home = temporaryDirectory()
    const repository = path.join(home, 'workspace', 'project')
    const projectKey = process.platform === 'win32'
      ? repository.replaceAll('\\', '/').toUpperCase()
      : `${repository}${path.sep}`
    write(path.join(home, '.claude.json'), JSON.stringify({
      projects: {
        [projectKey]: {
          mcpServers: {
            projectScoped: { command: 'npx', args: ['-y', '@acme/project-mcp@1.0.0'] },
          },
        },
      },
    }))
    const service = new ProviderExtensionService({
      homeDirectory: home,
      repositoryRoot: repository,
      invoke: async () => '[]',
      inspectSource: async (input) => ({
        currentVersion: input.currentVersion,
        latestVersion: '1.0.0',
      }),
    })

    const snapshot = await service.list('claude')

    expect(snapshot.items.find((item) => item.id === 'projectScoped')).toMatchObject({
      kind: 'mcp',
      source: { kind: 'npm', locator: '@acme/project-mcp', reference: '1.0.0' },
    })
  })

  it('degrades failed categories independently and never reports a guessed latest version', async () => {
    const home = temporaryDirectory()
    write(path.join(home, '.grok', 'skills', 'local', 'SKILL.md'), '---\nname: Local\n---\n')
    const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv) => {
      if (argv[0] === 'mcp') return 'not-json'
      throw new Error('plugin output unavailable')
    })
    const service = new ProviderExtensionService({ homeDirectory: home, invoke })

    const snapshot = await service.list('grok')

    expect(snapshot.capabilities.mcp.list).toBe(false)
    expect(snapshot.capabilities.plugin.list).toBe(false)
    expect(snapshot.capabilities.skill.list).toBe(true)
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        kind: 'skill',
        name: 'Local',
        latestVersion: null,
        update: expect.objectContaining({ state: 'unsupported' }),
      }),
    ])
    expect(snapshot.warnings).toHaveLength(2)
  })

  it('uses Gemini CLI as the authoritative Skill status source in the selected workspace', async () => {
    const home = temporaryDirectory()
    const repository = path.join(home, 'workspace')
    const skillPath = path.join(repository, '.gemini', 'skills', 'sample', 'SKILL.md')
    const calls: Array<{ argv: readonly string[]; cwd?: string }> = []
    const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv, options) => {
      calls.push({ argv: [...argv], cwd: options?.cwd })
      if (argv[0] === 'skills') {
        return [
          'Discovered Agent Skills:',
          '',
          'Sample [Disabled]',
          '  Description: Native status',
          `  Location:    ${skillPath}`,
          '',
        ].join('\n')
      }
      return '[]'
    })
    const service = new ProviderExtensionService({ homeDirectory: home, repositoryRoot: repository, invoke })

    const snapshot = await service.list('gemini')

    expect(calls).toEqual([
      { argv: ['skills', 'list', '--all'], cwd: repository },
      { argv: ['extensions', 'list', '--output-format', 'json'], cwd: repository },
    ])
    expect(snapshot.items.find((item) => item.kind === 'skill')).toMatchObject({
      name: 'Sample',
      enabled: false,
      scope: 'workspace',
    })
  })

  it('marks Gemini Skill listing unavailable when the native status command fails', async () => {
    const home = temporaryDirectory()
    write(path.join(home, '.gemini', 'skills', 'stale', 'SKILL.md'), '---\nname: Stale\n---\n')
    const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv) => {
      if (argv[0] === 'skills') throw new Error('Gemini CLI failed')
      return '[]'
    })
    const service = new ProviderExtensionService({ homeDirectory: home, invoke })

    const snapshot = await service.list('gemini')

    expect(snapshot.capabilities.skill.list).toBe(false)
    expect(snapshot.capabilities.skill.reason).toContain('Gemini CLI Skill 状态读取失败：Gemini CLI failed')
    expect(snapshot.items.some((item) => item.kind === 'skill')).toBe(false)
    expect(snapshot.warnings.some((warning) => warning.includes('Gemini CLI Skill 状态读取失败：Gemini CLI failed'))).toBe(true)
  })

  it('appends the last lines of the command output to a failed provider CLI listing', async () => {
    const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv) => {
      if (argv[0] !== 'mcp') return '[]'
      throw new CommandRunnerError('命令执行失败（退出码 1）：codex', {
        code: 'EXIT_NON_ZERO',
        executable: 'codex',
        argv: ['mcp', 'list', '--json'],
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: 'Usage: codex mcp\n\nError: config.toml is not valid TOML\n',
        outputBytes: 64,
        maxOutputBytes: 1024,
        durationMs: 12,
      })
    })
    const service = new ProviderExtensionService({ homeDirectory: temporaryDirectory(), invoke })

    const snapshot = await service.list('codex')

    expect(snapshot.capabilities.mcp.reason).toBe(
      'MCP 列表读取失败：命令执行失败（退出码 1）：codex'
      + '（命令输出：Usage: codex mcp / Error: config.toml is not valid TOML）',
    )
    expect(snapshot.warnings).toContain(`Codex CLI ${snapshot.capabilities.mcp.reason}`)
  })

  it('includes the original provider CLI failure in plugin capability diagnostics', async () => {
    const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv) => {
      if (argv[0] === 'plugin') throw new Error('registry lookup timed out')
      return '[]'
    })
    const service = new ProviderExtensionService({ homeDirectory: temporaryDirectory(), invoke })

    const snapshot = await service.list('claude')

    expect(snapshot.capabilities.plugin).toEqual({
      list: false,
      reason: 'Claude Code Plugin 列表读取失败：registry lookup timed out',
    })
    expect(snapshot.warnings).toContain('Claude Code Plugin 列表读取失败：registry lookup timed out')
  })

  it.runIf(process.platform === 'win32')('reports user-writable provider CLIs as unavailable instead of executing them', async () => {
    const home = temporaryDirectory()
    const prefix = path.join(home, 'npm')
    const packageRoot = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code')
    write(path.join(prefix, 'claude.cmd'), '@echo off\n')
    write(path.join(prefix, 'node.exe'), '')
    write(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@anthropic-ai/claude-code',
      bin: { claude: 'cli.js' },
    }))
    write(path.join(packageRoot, 'cli.js'), '#!/usr/bin/env node\n')
    const service = new ProviderExtensionService({
      homeDirectory: home,
      env: {
        PATH: prefix,
        USERPROFILE: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
      },
    })

    const snapshot = await service.list('claude')

    expect(snapshot.capabilities.plugin.list).toBe(false)
    expect(snapshot.capabilities.plugin.reason).toContain('Claude Code 扩展管理')
    expect(snapshot.capabilities.plugin.reason).toContain('运行时位于用户可写目录')
  })

  it.runIf(process.platform === 'win32')('reads provider extensions through a user CLI in confirmed same-user mode', async () => {
    const home = temporaryDirectory()
    const prefix = path.join(home, 'npm')
    const packageRoot = path.join(prefix, 'node_modules', '@openai', 'codex')
    write(path.join(prefix, 'codex.cmd'), '@echo off\n')
    write(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@openai/codex',
      bin: { codex: 'bin/codex.js' },
    }))
    write(path.join(packageRoot, 'bin', 'codex.js'), 'console.log("[]")\n')
    const service = new ProviderExtensionService({
      homeDirectory: home,
      env: {
        ...process.env,
        PATH: `${prefix}${path.delimiter}${process.env.PATH ?? ''}`,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
      },
      windowsExecutionMode: 'same-user',
    })

    const snapshot = await service.list('codex')

    expect(snapshot.capabilities.mcp.list).toBe(true)
    expect(snapshot.capabilities.plugin.list).toBe(true)
    expect(snapshot.warnings).toEqual([])
  })

  it.runIf(process.platform === 'win32')('does not fall back to a user npm shim for source update checks', async () => {
    const home = temporaryDirectory()
    const userBin = path.join(home, 'bin')
    write(path.join(userBin, 'npm.cmd'), '@echo off\n')
    write(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        pinned: { command: 'npx', args: ['-y', '@acme/mcp@1.0.0'] },
      },
    }))
    const fetchImplementation = vi.fn(async (url: string | URL | Request) => {
      const body = JSON.stringify({ version: '1.1.0' })
      const response = new Response(body, { status: 200 })
      Object.defineProperty(response, 'url', { value: String(url) })
      return response
    }) as typeof globalThis.fetch
    const service = new ProviderExtensionService({
      homeDirectory: home,
      env: {
        PATH: userBin,
        USERPROFILE: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
      },
      invoke: async () => '[]',
      sourceUpdateDependencies: { fetch: fetchImplementation },
    })

    const snapshot = await service.list('claude')
    const item = snapshot.items.find((entry) => entry.id === 'pinned')

    expect(item?.update).toMatchObject({
      state: 'update-available',
    })
    expect(item?.latestVersion).toBe('1.1.0')
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://registry.npmjs.org/%40acme%2Fmcp/latest',
      expect.objectContaining({ redirect: 'error' }),
    )
  })
})

describe('ProviderExtensionService native mutations', () => {
  it('uses inert argv and marks MCP environment values as sensitive', async () => {
    const calls: Array<{ provider: string; argv: readonly string[]; options: unknown }> = []
    const secret = 'secret; never-execute'
    const invoke: ProviderCliInvoker = vi.fn(async (provider, argv, options) => {
      calls.push({ provider, argv: [...argv], options })
      if (argv[0] === 'extensions') return '[]'
      return ''
    })
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke,
    })

    await service.mutate({
      provider: 'gemini',
      kind: 'mcp',
      action: 'install',
      id: 'safe_server',
      scope: 'user',
      mcp: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@acme/server', '--flag=a&b'],
        env: { API_TOKEN: secret },
      },
    })

    expect(calls[0]).toMatchObject({
      provider: 'gemini',
      argv: [
        'mcp', 'add', '--scope', 'user', '--transport', 'stdio',
        '--env', `API_TOKEN=${secret}`,
        'safe_server', 'npx', '--', '-y', '@acme/server', '--flag=a&b',
      ],
      options: expect.objectContaining({
        timeoutMs: 120_000,
        maxOutputBytes: 2 * 1024 * 1024,
        sensitiveValues: [secret],
      }),
    })
  })

  it('keeps option-looking MCP arguments behind the argv separator for every provider', async () => {
    const userArgs = ['--trust', '--scope', 'user', '--include-tools', 'shell']
    for (const provider of providerIds) {
      const calls: string[][] = []
      const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv) => {
        calls.push([...argv])
        if (argv[0] === 'extensions') return '[]'
        return ''
      })
      const service = new ProviderExtensionService({
        homeDirectory: temporaryDirectory(),
        invoke,
      })

      await service.mutate({
        provider,
        kind: 'mcp',
        action: 'install',
        id: 'safe_server',
        scope: 'user',
        mcp: { type: 'stdio', command: 'npx', args: userArgs },
      })

      const argv = calls[0]!
      const separator = argv.indexOf('--')
      expect(separator).toBeGreaterThan(-1)
      const tail = argv.slice(separator + 1)
      expect(tail.slice(-userArgs.length)).toEqual(userArgs)
      // Gemini parses <name> <commandOrUrl> as positionals and only folds what
      // follows '--' back into the server arguments, so its separator sits one
      // token later than the other CLIs. Either way no user-supplied entry is
      // left in front of it.
      expect(tail.slice(0, -userArgs.length)).toEqual(provider === 'gemini' ? [] : ['npx'])
    }
  })

  // Windows 上 npm 装出来的 npx / npm / pnpm / yarn 是 .cmd 垫片，没有 npx.exe，所以
  // 「要不要替用户包一层 cmd /c」会被反复提起。答案是不包，四家 CLI 都在自己那一侧解析：
  // Claude Code 与 Gemini CLI 的 MCP stdio 传输走 cross-spawn（按 PATHEXT 解析后，非
  // .exe/.com 的结果一律自动转成 cmd.exe /d /s /c），Codex 的 rmcp-client 用 which crate
  // 解析成绝对路径，Grok 自己文档里写明了它解析后再 spawn。我们再包一层只会多一层引号
  // 转义，还让写进用户配置的命令跟四家官方写法对不上。逐条依据在 docs/CURATED-EXTENSIONS.md。
  it('writes the stdio command into every CLI configuration without a shell wrapper', async () => {
    for (const provider of providerIds) {
      const calls: string[][] = []
      const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv) => {
        calls.push([...argv])
        if (argv[0] === 'extensions') return '[]'
        return ''
      })
      const service = new ProviderExtensionService({
        homeDirectory: temporaryDirectory(),
        invoke,
      })

      await service.mutate({
        provider,
        kind: 'mcp',
        action: 'install',
        id: 'safe_server',
        scope: 'user',
        mcp: { type: 'stdio', command: 'npx', args: ['-y', '@acme/server@1.2.3'] },
      })

      const argv = calls[0]!
      expect(argv.filter((entry) => entry === 'npx')).toHaveLength(1)
      for (const entry of argv) {
        expect(entry.toLowerCase()).not.toMatch(/^(?:cmd|cmd\.exe|powershell|powershell\.exe|\/c|\/k)$/)
      }
    }
  })

  it('uses native Gemini skill operations and rejects unsupported Codex updates', async () => {
    const repository = path.join(temporaryDirectory(), 'workspace')
    const workspaceSkill = path.join(repository, '.gemini', 'skills', 'workspace-skill', 'SKILL.md')
    const calls: Array<{ argv: string[]; cwd?: string }> = []
    const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv, options) => {
      calls.push({ argv: [...argv], cwd: options?.cwd })
      if (argv[0] === 'extensions') return '[]'
      if (argv.join(' ') === 'skills list --all') {
        return ['workspace-skill [Enabled]', `  Location:    ${workspaceSkill}`, ''].join('\n')
      }
      return ''
    })
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      repositoryRoot: repository,
      invoke,
    })

    await service.mutate({
      provider: 'gemini',
      kind: 'skill',
      action: 'install',
      source: 'https://github.com/acme/skill.git',
      scope: 'workspace',
    })
    await service.mutate({
      provider: 'gemini',
      kind: 'skill',
      action: 'disable',
      id: workspaceSkill,
      scope: 'workspace',
    })
    await expect(service.mutate({
      provider: 'codex',
      kind: 'plugin',
      action: 'update',
      id: 'sample@market',
    })).rejects.toThrow('不支持该原生操作')

    expect(calls[0]).toEqual({
      argv: [
        'skills', 'install', 'https://github.com/acme/skill.git',
        '--scope', 'workspace', '--consent',
      ],
      cwd: repository,
    })
    expect(calls.some((call) => (
      call.cwd === repository
      && call.argv.join(' ') === 'skills disable workspace-skill --scope workspace'
    ))).toBe(true)
  })

  it('uses the workspace scope when disabling a Gemini extension and reconciles the returned snapshot', async () => {
    const repository = path.join(temporaryDirectory(), 'workspace')
    const calls: Array<{ argv: string[]; cwd?: string }> = []
    const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv, options) => {
      calls.push({ argv: [...argv], cwd: options?.cwd })
      if (argv[0] === 'extensions') return '[]'
      return ''
    })
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      repositoryRoot: repository,
      invoke,
    })

    const snapshot = await service.mutate({
      provider: 'gemini',
      kind: 'plugin',
      action: 'disable',
      id: 'sample-extension',
      scope: 'workspace',
    })

    expect(calls[0]).toEqual({
      argv: ['extensions', 'disable', 'sample-extension', '--scope', 'workspace'],
      cwd: repository,
    })
    expect(calls).toContainEqual({
      argv: ['extensions', 'list', '--output-format', 'json'],
      cwd: repository,
    })
    expect(snapshot.provider).toBe('gemini')
  })

  it.each(['claude', 'grok'] as const)(
    'prefers the stable plugin id over a marketplace locator for %s installs',
    async (provider) => {
      const calls: string[][] = []
      const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv) => {
        calls.push([...argv])
        return argv[1] === 'marketplace' ? registeredMarketplaceList : '[]'
      })
      const service = new ProviderExtensionService({
        homeDirectory: temporaryDirectory(),
        invoke,
        // 市场已在册就不该碰 Git；返回 null 让「碰了」当场失败。
        findExecutable: async () => null,
      })

      const snapshot = await service.mutate({
        provider,
        kind: 'plugin',
        action: 'install',
        id: 'sample@official',
        source: 'official',
      })

      expect(calls).toContainEqual(['plugin', 'install', 'sample@official'])
      expect(snapshot.provider).toBe(provider)
    },
  )
})

describe('Claude Code official marketplace', () => {
  it('reads marketplace names from the CLI list and rejects an unsupported shape', () => {
    expect(parseClaudeMarketplaceNames(registeredMarketplaceList)).toEqual(['claude-plugins-official'])
    expect(parseClaudeMarketplaceNames('[]')).toEqual([])
    expect(parseClaudeMarketplaceNames(JSON.stringify({
      marketplaces: [{ name: 'claude-plugins-official' }, { name: '  ' }, 'ignored'],
    }))).toEqual(['claude-plugins-official'])
    expect(() => parseClaudeMarketplaceNames('not json')).toThrow('未返回有效 JSON')
    expect(() => parseClaudeMarketplaceNames('"text"')).toThrow('格式不受支持')
  })

  it('falls back to the marketplaces the CLI itself declared in user settings', () => {
    const home = temporaryDirectory()
    expect(readClaudeSettingsMarketplaceNames(home)).toEqual([])
    write(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      extraKnownMarketplaces: { 'claude-plugins-official': { source: { source: 'github' } } },
    }))
    expect(readClaudeSettingsMarketplaceNames(home)).toEqual(['claude-plugins-official'])
    write(path.join(home, '.claude', 'settings.json'), '{ broken')
    expect(readClaudeSettingsMarketplaceNames(home)).toEqual([])
  })

  it('names a platform-appropriate way to install Git', () => {
    expect(claudeMarketplaceGitMissingMessage('win32')).toContain('git-scm.com')
    expect(claudeMarketplaceGitMissingMessage('darwin')).toContain('xcode-select --install')
    expect(claudeMarketplaceGitMissingMessage('linux')).toContain('包管理器')
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(claudeMarketplaceGitMissingMessage(platform)).toContain('Git')
    }
  })

  it('only marks network-bound mutations as needing the current route', () => {
    const base = { provider: 'claude', kind: 'plugin' } as const
    expect(isNetworkBoundExtensionMutation({ ...base, action: 'install' })).toBe(true)
    expect(isNetworkBoundExtensionMutation({ ...base, action: 'update' })).toBe(true)
    expect(isNetworkBoundExtensionMutation({ ...base, action: 'uninstall' })).toBe(false)
    expect(isNetworkBoundExtensionMutation({
      provider: 'claude', kind: 'mcp', action: 'install',
    })).toBe(false)
  })

  it('adds the official marketplace before the first plugin install', async () => {
    const calls: string[][] = []
    const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv) => {
      calls.push([...argv])
      // 加之前市场为空，加过之后才有；install 本身返回空清单。
      if (argv[1] === 'marketplace' && argv[2] === 'list') {
        return calls.some((entry) => entry[2] === 'add') ? registeredMarketplaceList : '[]'
      }
      return '[]'
    })
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke,
      findExecutable: async () => '/usr/bin/git',
    })

    await service.mutate({
      provider: 'claude',
      kind: 'plugin',
      action: 'install',
      id: 'code-review@claude-plugins-official',
    })

    expect(calls[0]).toEqual(['plugin', 'marketplace', 'list', '--json'])
    expect(calls[1]).toEqual(claudeOfficialMarketplaceAddArgv())
    expect(calls[2]).toEqual(['plugin', 'install', 'code-review@claude-plugins-official'])
  })

  it('does not add the marketplace again once it is registered', async () => {
    const calls: string[][] = []
    const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv) => {
      calls.push([...argv])
      return argv[1] === 'marketplace' ? registeredMarketplaceList : '[]'
    })
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke,
      findExecutable: async () => '/usr/bin/git',
    })

    await service.mutate({
      provider: 'claude',
      kind: 'plugin',
      action: 'install',
      id: 'code-review@claude-plugins-official',
    })

    expect(calls.filter((argv) => argv[2] === 'add')).toEqual([])
    expect(calls).toContainEqual(['plugin', 'install', 'code-review@claude-plugins-official'])
  })

  it('tells the customer to install Git instead of running a command that cannot work', async () => {
    const calls: string[][] = []
    const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv) => {
      calls.push([...argv])
      return '[]'
    })
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke,
      findExecutable: async () => null,
    })

    await expect(service.mutate({
      provider: 'claude',
      kind: 'plugin',
      action: 'install',
      id: 'code-review@claude-plugins-official',
    })).rejects.toThrow(claudeMarketplaceGitMissingMessage())
    expect(calls.some((argv) => argv[2] === 'add' || argv[1] === 'install')).toBe(false)
  })

  it('trusts the CLI-declared marketplace when its list command fails', async () => {
    const home = temporaryDirectory()
    write(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      extraKnownMarketplaces: { 'claude-plugins-official': { source: { source: 'github' } } },
    }))
    const calls: string[][] = []
    const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv) => {
      calls.push([...argv])
      if (argv[1] === 'marketplace') throw new Error('unknown option --json')
      return '[]'
    })
    const service = new ProviderExtensionService({
      homeDirectory: home,
      invoke,
      findExecutable: async () => null,
    })

    await service.mutate({
      provider: 'claude',
      kind: 'plugin',
      action: 'install',
      id: 'code-review@claude-plugins-official',
    })

    expect(calls.some((argv) => argv[2] === 'add')).toBe(false)
    expect(calls).toContainEqual(['plugin', 'install', 'code-review@claude-plugins-official'])
  })

  it('reports the marketplace state on the Claude snapshot only', async () => {
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke: async (_provider, argv) => (argv[1] === 'marketplace' ? '[]' : '[]'),
      findExecutable: async () => null,
    })

    const claude = await service.list('claude')
    expect(claude.marketplace).toEqual({
      name: 'claude-plugins-official',
      registered: false,
      reason: null,
    })
    expect((await service.list('grok')).marketplace).toBeUndefined()

    const registered = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke: async (_provider, argv) => (argv[1] === 'marketplace' ? registeredMarketplaceList : '[]'),
      findExecutable: async () => null,
    })
    expect((await registered.list('claude')).marketplace).toMatchObject({ registered: true })
  })

  it('hands the current route to the marketplace and install commands, and to nothing else', async () => {
    const runCalls: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = []
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      windowsExecutionMode: 'same-user',
      env: { PATH: '/usr/bin' },
      resolveCommand: async () => ({ executable: '/trusted/claude', argv: [] }),
      runCommand: async (command, options) => {
        runCalls.push({ argv: [...command.argv], env: options?.env ?? {} })
        return {
          executable: command.executable,
          argv: [...command.argv],
          exitCode: 0,
          signal: null,
          stdout: '[]',
          stderr: '',
          outputBytes: 2,
          durationMs: 1,
        }
      },
      findExecutable: async () => '/usr/bin/git',
      resolveSubprocessProxyEnvironment: async () => ({ HTTPS_PROXY: 'http://127.0.0.1:7890' }),
      inspectSource: async (input) => ({
        currentVersion: input.currentVersion,
        latestVersion: input.currentVersion,
      }),
    })

    await service.mutate({
      provider: 'claude',
      kind: 'plugin',
      action: 'install',
      id: 'code-review@claude-plugins-official',
    })

    const proxied = runCalls.filter((call) => call.env.HTTPS_PROXY === 'http://127.0.0.1:7890')
    expect(proxied.map((call) => call.argv)).toEqual([
      claudeOfficialMarketplaceAddArgv(),
      ['plugin', 'install', 'code-review@claude-plugins-official'],
    ])
    // 读清单不出网，不该带上线路。
    expect(runCalls.find((call) => call.argv[2] === 'list')?.env.HTTPS_PROXY).toBeUndefined()
  })
})

describe('official marketplace as a standalone action', () => {
  it('adds the marketplace on request and returns the refreshed catalog', async () => {
    const calls: string[][] = []
    const invoke: ProviderCliInvoker = vi.fn(async (_provider, argv) => {
      calls.push([...argv])
      if (argv[1] === 'marketplace' && argv[2] === 'list') {
        return calls.some((entry) => entry[2] === 'add') ? registeredMarketplaceList : '[]'
      }
      return '[]'
    })
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke,
      findExecutable: async () => '/usr/bin/git',
    })

    const snapshot = await service.ensureMarketplace('claude')

    expect(calls[1]).toEqual(claudeOfficialMarketplaceAddArgv())
    expect(snapshot.marketplace).toMatchObject({ registered: true })
  })

  it('refuses a provider that has no official marketplace', async () => {
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke: async () => '[]',
      findExecutable: async () => '/usr/bin/git',
    })

    await expect(service.ensureMarketplace('grok')).rejects.toThrow('没有官方插件市场')
  })

  it('explains the macOS git shim instead of letting the marketplace add summon the system dialog', async () => {
    const calls: string[][] = []
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke: async (_provider, argv) => {
        calls.push([...argv])
        return '[]'
      },
      platform: 'darwin',
      findExecutable: async () => '/usr/bin/git',
      isCommandLineToolsShimBacked: async () => false,
    })

    const message = claudeMarketplaceGitMissingMessage('darwin', { commandLineToolsShim: true })
    expect(message).toContain('空壳')
    expect(message).toContain('xcode-select --install')
    await expect(service.ensureMarketplace('claude')).rejects.toThrow(message)
    expect(calls.some((argv) => argv.includes('add'))).toBe(false)
  })

  it('reports the missing Git rather than adding the marketplace', async () => {
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke: async () => '[]',
      findExecutable: async () => null,
    })

    await expect(service.ensureMarketplace('claude'))
      .rejects.toThrow(claudeMarketplaceGitMissingMessage())
  })
})

describe('Codex official plugin catalog', () => {
  function seedCatalog(codexHome: string): void {
    write(path.join(codexHome, '.tmp', 'plugins', '.agents', 'plugins', 'marketplace.json'), '{}')
    write(path.join(codexHome, '.tmp', 'plugins', '.agents', 'plugins', 'api_marketplace.json'), '{}')
    write(path.join(codexHome, '.tmp', 'plugins.sha'), 'export-backup\n')
  }

  it('tells the page whether the catalog Codex reads is on disk', async () => {
    const home = temporaryDirectory()
    const service = new ProviderExtensionService({ homeDirectory: home, invoke: async () => '[]' })

    expect((await service.list('codex')).marketplace)
      .toEqual({ name: 'openai-api-curated', registered: false, reason: null })
    seedCatalog(path.join(home, '.codex'))
    expect((await service.list('codex')).marketplace).toMatchObject({ registered: true })
  })

  it('names official catalog plugins from their own manifest and leaves other marketplaces alone', async () => {
    const home = temporaryDirectory()
    const codexHome = path.join(home, '.codex')
    seedCatalog(codexHome)
    write(path.join(codexHome, '.tmp', 'plugins', 'plugins', 'game-studio', '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'game-studio',
      interface: { displayName: 'Game Studio', shortDescription: 'Design and prototype browser games' },
    }))
    const listing = JSON.stringify({
      installed: [],
      available: [
        { pluginId: 'game-studio@openai-api-curated', name: 'game-studio', marketplaceName: 'openai-api-curated' },
        { pluginId: 'game-studio@team', name: 'game-studio', marketplaceName: 'team' },
      ],
    })
    const service = new ProviderExtensionService({
      homeDirectory: home,
      invoke: async (_provider, argv) => argv[0] === 'plugin' ? listing : '[]',
    })

    const plugins = (await service.list('codex')).items.filter((item) => item.kind === 'plugin')

    expect(plugins.find((item) => item.id === 'game-studio@openai-api-curated'))
      .toMatchObject({ name: 'Game Studio', description: 'Design and prototype browser games' })
    expect(plugins.find((item) => item.id === 'game-studio@team')).toMatchObject({ name: 'game-studio', description: '' })
  })

  it('downloads once for concurrent requests and always returns the acceleration lease', async () => {
    const fetchCalls: string[] = []
    const release = vi.fn(async () => undefined)
    const service = new ProviderExtensionService({
      homeDirectory: fs.realpathSync(temporaryDirectory()),
      invoke: async () => '[]',
      downloadFetch: async (input) => {
        fetchCalls.push(String(input))
        throw new TypeError('fetch failed')
      },
      acquireDownloadAcceleration: async () => ({ endpoint: null, accelerated: false, release }),
    })

    const results = await Promise.allSettled([service.ensureMarketplace('codex'), service.ensureMarketplace('codex')])

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(fetchCalls).toHaveLength(1)
    expect(release).toHaveBeenCalledTimes(1)
    await expect(service.ensureMarketplace('codex')).rejects.toThrow(codexPluginCatalogNetworkMessage)
    expect(fetchCalls).toHaveLength(2)
  })

  it('does not touch the network when the catalog is already there', async () => {
    const home = temporaryDirectory()
    seedCatalog(path.join(home, '.codex'))
    const downloadFetch = vi.fn<typeof fetch>()
    const service = new ProviderExtensionService({ homeDirectory: home, invoke: async () => '[]', downloadFetch })

    await expect(service.ensureMarketplace('codex')).resolves.toMatchObject({ marketplace: { registered: true } })
    expect(downloadFetch).not.toHaveBeenCalled()
  })
})

/**
 * 两段样例都是 2026-09-22 在沙箱里跑真实 CLI 抄下来的：
 * Claude Code 2.1.278 的 `claude mcp list` 与 Gemini CLI 0.60.0 的 `gemini mcp list`。
 * 状态词按两家源码里的字面量逐条覆盖，不是照着文档猜的。
 */
const claudeMcpListOutput = [
  'Checking MCP server health…',
  '',
  'good: node -e setInterval(()=>{},1000) - ✓ Connected',
  'broken: uvx mcp-server-fetch - ✗ Failed to connect — MCP server "broken" connection timed out after 30000ms',
  'remote: https://api.githubcopilot.com/mcp/ (HTTP) - ! Needs authentication',
  'partial: npx -y demo - ! Connected · tools fetch failed — listTools failed',
  'waiting: npx -y pending - ⏸ Pending approval (run `claude` to approve)',
  'paused: npx -y paused - ⊘ Disabled for this project (re-enable via /mcp)',
  'empty: https://example.test - - Not configured',
].join('\n')

const geminiMcpListOutput = [
  'Configured MCP servers:',
  '',
  '✓ good: node -e setInterval(()=>{},1000) (stdio) - Connected',
  '✗ missing: definitely-not-a-real-binary  (stdio) - Disconnected',
  '⛔ walled: npx -y blocked  (stdio) - Blocked',
  '○ off: npx -y paused  (stdio) - Disabled',
  '… slow (from demo-extension): https://example.test (http) - Connecting',
].join('\n')

describe('MCP connection health', () => {
  it('reads every Claude Code status word and keeps the CLI issue text', () => {
    expect(parseClaudeMcpHealth(claudeMcpListOutput)).toEqual([
      { id: 'good', state: 'connected', detail: null },
      {
        id: 'broken',
        state: 'failed',
        detail: '启动失败：MCP server "broken" connection timed out after 30000ms',
      },
      { id: 'remote', state: 'failed', detail: '还没登录这个服务' },
      { id: 'partial', state: 'failed', detail: '连上了，但读不到它提供的工具：listTools failed' },
      { id: 'waiting', state: 'unknown', detail: '这条连接还没在工具里确认过，本次没有检测' },
      { id: 'paused', state: 'unknown', detail: '这条连接在当前目录下已停用，本次没有检测' },
      { id: 'empty', state: 'failed', detail: '这条连接没有填地址' },
    ])
  })

  it('does not mistake a dash inside the launch command for the status separator', () => {
    expect(parseClaudeMcpHealth('demo: npx -y pkg - extra - ✓ Connected')).toEqual([
      { id: 'demo', state: 'connected', detail: null },
    ])
  })

  it('reads every Gemini CLI status word and drops the extension suffix from the name', () => {
    expect(parseGeminiMcpHealth(geminiMcpListOutput)).toEqual([
      { id: 'good', state: 'connected', detail: null },
      { id: 'missing', state: 'failed', detail: '连不上' },
      { id: 'walled', state: 'failed', detail: '被当前工具的策略拦下了' },
      { id: 'off', state: 'unknown', detail: '这条连接已在工具里停用，本次没有检测' },
      { id: 'slow', state: 'unknown', detail: '还在连接中，稍后再检测一次' },
    ])
  })

  it('explains that an untrusted folder, not the user, disabled every Gemini connection', () => {
    const untrusted = [
      'Warning: MCP servers are configured but disabled because this folder is untrusted.',
      '',
      'Configured MCP servers:',
      '',
      '○ good: node demo (stdio) - Disabled',
    ].join('\n')
    expect(parseGeminiMcpHealth(untrusted)).toEqual([
      {
        id: 'good',
        state: 'unknown',
        detail: '当前工具把这个目录当作不受信任的目录，连接被一并停用，本次没有检测',
      },
    ])
  })

  it('reports Codex and Grok as unchecked instead of guessing from their configuration', async () => {
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke: async () => {
        throw new Error('未检测的工具不该调用 CLI')
      },
    })
    for (const provider of ['codex', 'grok'] as const) {
      const report = await service.checkMcpHealth(provider)
      expect(report).toMatchObject({ provider, supported: false, entries: [] })
      expect(report.reason).toContain('没有提供连接状态')
    }
  })

  it('asks the CLI itself and gives it a budget longer than its own per-server wait', async () => {
    const calls: Array<{ argv: string[]; timeoutMs: number | undefined }> = []
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke: async (_provider, argv, options) => {
        calls.push({ argv: [...argv], timeoutMs: options?.timeoutMs })
        return claudeMcpListOutput
      },
    })
    const report = await service.checkMcpHealth('claude')
    expect(calls).toEqual([{ argv: ['mcp', 'list'], timeoutMs: 120_000 }])
    expect(report.supported).toBe(true)
    expect(report.reason).toBeNull()
    expect(report.entries[0]).toEqual({ id: 'good', state: 'connected', detail: null })
  })

  it('turns a failed probe into one explained reason instead of calling every connection broken', async () => {
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke: async () => {
        throw new Error('命令执行超时')
      },
    })
    const report = await service.checkMcpHealth('gemini')
    expect(report.entries).toEqual([])
    expect(report.supported).toBe(true)
    expect(report.reason).toContain('命令执行超时')
  })
})

describe('extension runtime availability', () => {
  it('reports Python and uv separately so a uvx connection is not blamed on a missing Python', async () => {
    const home = temporaryDirectory()
    const asked: string[] = []
    const service = new ProviderExtensionService({
      homeDirectory: home,
      invoke: async () => '[]',
      findExecutable: async (command) => {
        asked.push(command)
        return command === 'uvx' ? '/usr/bin/uvx' : null
      },
    })
    const snapshot = await service.list('claude')
    expect(snapshot.runtimes).toEqual({ python: false, uv: true })
    expect(asked).toEqual(expect.arrayContaining(['python3', 'python', 'py', 'uvx', 'uv']))
  })

  it('counts any Python spelling as installed', async () => {
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke: async () => '[]',
      findExecutable: async (command) => (command === 'py' ? 'C:/Windows/py.exe' : null),
    })
    expect((await service.list('claude')).runtimes).toEqual({ python: true, uv: false })
  })

  it('does not count the macOS python3 shim as Python while the developer tools are missing', async () => {
    const probed: string[] = []
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke: async () => '[]',
      platform: 'darwin',
      findExecutable: async (command) => (command === 'python3' ? '/usr/bin/python3' : null),
      isCommandLineToolsShimBacked: async (shim) => {
        probed.push(shim)
        return false
      },
    })
    expect((await service.list('claude')).runtimes).toEqual({ python: false, uv: false })
    expect(probed).toEqual(['/usr/bin/python3'])
  })

  it('counts the macOS python3 shim once the developer tools behind it exist', async () => {
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke: async () => '[]',
      platform: 'darwin',
      findExecutable: async (command) => (command === 'python3' ? '/usr/bin/python3' : null),
      isCommandLineToolsShimBacked: async () => true,
    })
    expect((await service.list('claude')).runtimes).toEqual({ python: true, uv: false })
  })
})

describe('local Git metadata on a relocated profile', () => {
  afterEach(() => setRelocatedFolderPolicy(null))

  function relocatedSkill(): { home: string; skill: string } {
    const root = fs.realpathSync.native(temporaryDirectory())
    const home = path.join(root, 'Users', 'alice')
    const movedHome = path.join(root, 'D', 'alice')
    fs.mkdirSync(path.dirname(home), { recursive: true })
    const movedSkill = path.join(movedHome, '.claude', 'skills', 'demo')
    write(path.join(movedSkill, '.git', 'HEAD'), `${'e'.repeat(40)}\n`)
    write(path.join(movedSkill, '.git', 'config'), '[remote "origin"]\nurl = https://github.com/acme/demo.git\n')
    // Junctions need no privilege on Windows; POSIX ignores the type argument.
    fs.symlinkSync(movedHome, home, 'junction')
    return { home, skill: path.join(home, '.claude', 'skills', 'demo') }
  }

  it('reads a Git-installed skill after the user folder was moved to another disk', () => {
    const { home, skill } = relocatedSkill()
    setRelocatedFolderPolicy({ homeDirectories: [home], acceptsTarget: () => true })

    expect(readLocalGitMetadata(skill)).toEqual({
      currentVersion: 'e'.repeat(40),
      locator: 'https://github.com/acme/demo.git',
    })
  })

  it('keeps refusing the moved Git directory while no policy accepts it', () => {
    const { skill } = relocatedSkill()

    expect(() => readLocalGitMetadata(skill)).toThrow('不能经过符号链接或目录联接')
  })
})

describe('ProviderExtensionService scope-preserving mutations', () => {
  function recordingInvoke(responses: (argv: readonly string[]) => string | undefined) {
    const calls: Array<{ provider: ProviderId; argv: string[]; cwd?: string }> = []
    const invoke: ProviderCliInvoker = vi.fn(async (provider, argv, options) => {
      calls.push({ provider, argv: [...argv], cwd: options?.cwd })
      return responses(argv) ?? ''
    })
    return { calls, invoke }
  }

  it('maps listed Gemini skill paths back to the skill name and the scope it lives in', async () => {
    const home = temporaryDirectory()
    const repository = path.join(temporaryDirectory(), 'workspace')
    const userSkill = path.join(home, '.gemini', 'skills', 'demo', 'SKILL.md')
    const workspaceSkill = path.join(repository, '.gemini', 'skills', 'demo', 'SKILL.md')
    const listing = [
      'Discovered Agent Skills:',
      '',
      'demo [Enabled]',
      '  Description: user copy',
      `  Location:    ${userSkill}`,
      '',
      'demo [Disabled]',
      '  Description: workspace copy',
      `  Location:    ${workspaceSkill}`,
      '',
    ].join('\n')
    const { calls, invoke } = recordingInvoke((argv) => {
      if (argv.join(' ') === 'skills list --all') return listing
      if (argv[0] === 'extensions') return '[]'
      return undefined
    })
    const service = new ProviderExtensionService({ homeDirectory: home, repositoryRoot: repository, invoke })

    const snapshot = await service.list('gemini')
    const skills = snapshot.items.filter((item) => item.kind === 'skill')
    const user = skills.find((item) => item.id === path.resolve(userSkill))!
    const workspace = skills.find((item) => item.id === path.resolve(workspaceSkill))!
    expect(user.scope).toBe('user')
    expect(workspace.scope).toBe('workspace')

    const mutations: Array<{ id: string; action: 'enable' | 'disable' | 'uninstall' }> = [
      { id: user.id, action: 'disable' },
      { id: workspace.id, action: 'disable' },
      { id: workspace.id, action: 'enable' },
      { id: user.id, action: 'uninstall' },
      { id: workspace.id, action: 'uninstall' },
    ]
    for (const mutation of mutations) {
      calls.length = 0
      const item = mutation.id === user.id ? user : workspace
      await service.mutate({ provider: 'gemini', kind: 'skill', action: mutation.action, id: item.id })
      const mutating = calls.filter((call) => call.argv[0] === 'skills' && call.argv[1] === mutation.action)
      expect(mutating).toHaveLength(1)
      expect(mutating[0].argv[2]).toBe('demo')
      expect(mutating[0].cwd).toBe(repository)
      if (mutation.action === 'enable') expect(mutating[0].argv).toEqual(['skills', 'enable', 'demo'])
      else expect(mutating[0].argv).toEqual(['skills', mutation.action, 'demo', '--scope', item.scope])
    }
  })

  it('refuses a Gemini skill the CLI no longer lists instead of passing the path through', async () => {
    const { calls, invoke } = recordingInvoke((argv) => (argv[0] === 'extensions' ? '[]' : undefined))
    const service = new ProviderExtensionService({ homeDirectory: temporaryDirectory(), invoke })
    const stale = path.join(temporaryDirectory(), 'gone', 'SKILL.md')

    await expect(service.mutate({ provider: 'gemini', kind: 'skill', action: 'disable', id: stale }))
      .rejects.toThrow('没有找到这个技能')
    expect(calls.some((call) => call.argv[1] === 'disable')).toBe(false)
  })

  it('keeps user and project copies of one Claude plugin apart and runs project operations inside the project', async () => {
    const repository = temporaryDirectory()
    const otherProject = temporaryDirectory()
    const pluginList = JSON.stringify([
      { id: 'demo@market', scope: 'project', enabled: true, projectPath: repository },
      { id: 'demo@market', scope: 'user', enabled: false },
      { id: 'elsewhere@market', scope: 'project', enabled: true, projectPath: otherProject },
    ])
    const { calls, invoke } = recordingInvoke((argv) => {
      if (argv.join(' ') === 'plugin list --available --json') return pluginList
      if (argv.join(' ') === 'plugin marketplace list --json') return registeredMarketplaceList
      if (argv.join(' ') === 'mcp list') return ''
      return undefined
    })
    const service = new ProviderExtensionService({
      homeDirectory: temporaryDirectory(),
      repositoryRoot: repository,
      invoke,
    })

    const plugins = (await service.list('claude')).items.filter((item) => item.kind === 'plugin')
    expect(plugins.map((item) => [item.id, item.scope, item.enabled])).toEqual([
      ['demo@market', 'project', true],
      ['demo@market', 'user', false],
    ])

    for (const item of plugins) {
      calls.length = 0
      await service.mutate({
        provider: 'claude',
        kind: 'plugin',
        action: 'uninstall',
        id: item.id,
        scope: item.scope === 'project' ? 'project' : 'user',
      })
      const uninstall = calls.find((call) => call.argv[1] === 'uninstall')!
      expect(uninstall.argv).toEqual(['plugin', 'uninstall', 'demo@market', '--scope', item.scope])
      expect(uninstall.cwd).toBe(repository)
    }
  })

  it('reports each Claude MCP configuration layer and removes from the layer that was picked', async () => {
    const home = temporaryDirectory()
    const repository = temporaryDirectory()
    write(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { shared: { command: 'user-server' } },
      projects: { [repository]: { mcpServers: { mine: { command: 'local-server' } } } },
    }))
    write(path.join(repository, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'project-server' } } }))
    const { calls, invoke } = recordingInvoke((argv) => {
      if (argv.join(' ') === 'plugin list --available --json') return '[]'
      if (argv.join(' ') === 'plugin marketplace list --json') return registeredMarketplaceList
      return undefined
    })
    const service = new ProviderExtensionService({ homeDirectory: home, repositoryRoot: repository, invoke })

    const servers = (await service.list('claude')).items.filter((item) => item.kind === 'mcp')
    expect(servers.map((item) => [item.id, item.scope]).sort()).toEqual([
      ['mine', 'local'],
      ['shared', 'project'],
      ['shared', 'user'],
    ])

    calls.length = 0
    await service.mutate({ provider: 'claude', kind: 'mcp', action: 'uninstall', id: 'shared', scope: 'project' })
    const remove = calls.find((call) => call.argv[1] === 'remove')!
    expect(remove.argv).toEqual(['mcp', 'remove', '--scope', 'project', 'shared'])
    expect(remove.cwd).toBe(repository)
  })

  it('asks for the project folder before touching a project-scoped item', async () => {
    const { calls, invoke } = recordingInvoke(() => undefined)
    const service = new ProviderExtensionService({ homeDirectory: temporaryDirectory(), invoke })

    await expect(service.mutate({
      provider: 'claude',
      kind: 'plugin',
      action: 'disable',
      id: 'demo@market',
      scope: 'project',
    })).rejects.toThrow('请先在工作目录里选好这个项目')
    expect(calls).toHaveLength(0)
  })

  it('shows Codex skills disabled in config.toml as disabled', async () => {
    const home = temporaryDirectory()
    const codexHome = temporaryDirectory()
    const disabled = path.join(home, '.agents', 'skills', 'quiet', 'SKILL.md')
    write(disabled, '---\nname: Quiet\n---\n')
    write(path.join(home, '.agents', 'skills', 'loud', 'SKILL.md'), '---\nname: Loud\n---\n')
    write(path.join(codexHome, 'config.toml'), `[[skills.config]]\npath = ${JSON.stringify(disabled)}\nenabled = false\n`)
    const { invoke } = recordingInvoke((argv) => {
      if (argv.join(' ') === 'mcp list --json') return '[]'
      if (argv[0] === 'plugin') return '{"installed":[],"available":[]}'
      return undefined
    })
    const service = new ProviderExtensionService({ homeDirectory: home, codexHome, invoke })

    const skills = (await service.list('codex')).items.filter((item) => item.kind === 'skill')
    expect(skills.map((item) => [item.name, item.enabled]).sort()).toEqual([
      ['Loud', true],
      ['Quiet', false],
    ])
  })
})
