import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createProviderSourceUpdateInspector,
  detectMcpPackageSource,
  normalizeGitHubRemoteUrl,
  packageCommandExecutionMode,
  parseGitRemoteHead,
  parseGeminiSkillList,
  parseProviderPluginList,
  providerCommandResolutionOrder,
  ProviderExtensionService,
  readLocalGitMetadata,
  resolveProviderCommand,
  selectProviderCommandOutput,
  type ProviderCliInvoker,
  type SourceUpdateInspector,
} from './provider-extensions'

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
    }) as typeof globalThis.fetch
    const inspect = createProviderSourceUpdateInspector({}, 'standard', { fetch: fetchImplementation })

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
    const redirected = createProviderSourceUpdateInspector({}, 'standard', { fetch: redirectedFetch })
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
    const oversized = createProviderSourceUpdateInspector({}, 'standard', { fetch: oversizedFetch })
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

  it('disables Git redirects and accepts only a bounded HEAD hash result', async () => {
    const head = 'a'.repeat(40)
    const repository = temporaryDirectory()
    write(path.join(repository, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    write(path.join(repository, '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`)
    write(path.join(repository, '.git', 'config'), [
      '[remote "origin"]',
      '  url = git@github.com:acme/server.git',
    ].join('\n'))
    const runCommandImplementation = vi.fn(async () => ({ stdout: `${head}\tHEAD\n`, stderr: '' }))
    const gitExecutable = process.platform === 'win32'
      ? 'C:\\Program Files\\Git\\bin\\git.exe'
      : '/usr/bin/git'
    const inspect = createProviderSourceUpdateInspector({}, 'trusted-only', {
      findExecutable: vi.fn(async () => gitExecutable),
      runCommand: runCommandImplementation as never,
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
      env: baseEnv,
      codexEnv: { ...baseEnv, CODEX_HOME: codexHome },
      resolveCommand: async (provider, env) => {
        resolveCalls.push({ provider, env })
        return { executable: `/trusted/${provider}`, argv: [] }
      },
      runCommand: async (command, options) => {
        runCalls.push({
          provider: path.basename(command.executable) as ProviderId,
          env: options.env ?? {},
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
        'safe_server', 'npx', '-y', '@acme/server', '--flag=a&b',
      ],
      options: expect.objectContaining({
        timeoutMs: 120_000,
        maxOutputBytes: 2 * 1024 * 1024,
        sensitiveValues: [secret],
      }),
    })
  })

  it('uses native Gemini skill operations and rejects unsupported Codex updates', async () => {
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
      id: 'workspace-skill',
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
        return '[]'
      })
      const service = new ProviderExtensionService({ homeDirectory: temporaryDirectory(), invoke })

      const snapshot = await service.mutate({
        provider,
        kind: 'plugin',
        action: 'install',
        id: 'sample@official',
        source: 'official',
      })

      expect(calls[0]).toEqual(['plugin', 'install', 'sample@official'])
      expect(snapshot.provider).toBe(provider)
    },
  )
})
