import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as TOML from '@iarna/toml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexExtensionService,
  resolveCodexCommand,
  type CodexInvocationOptions,
  type CodexInvoker,
} from './codex-extensions'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-extensions-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function writeExecutable(filePath: string, content: string): void {
  write(filePath, content)
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o700)
}

function mcpList(entries: unknown[]): string {
  return JSON.stringify(entries)
}

function stdioMcp(name: string, env: Record<string, string> = {}): Record<string, unknown> {
  return {
    name,
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      env,
      env_vars: ['INHERITED_TOKEN'],
      cwd: null,
    },
    startup_timeout_sec: 30,
    tool_timeout_sec: null,
    auth_status: 'unsupported',
  }
}

function httpMcp(name: string): Record<string, unknown> {
  return {
    name,
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'streamable_http',
      url: 'https://example.test/mcp',
      bearer_token_env_var: 'MCP_TOKEN',
      http_headers: { Authorization: 'Bearer secret-header', 'X-Key': 'secret-key' },
      env_http_headers: { 'X-Env': 'HEADER_ENV' },
    },
    startup_timeout_sec: null,
    tool_timeout_sec: 10,
    auth_status: 'not_logged_in',
  }
}

function pluginCatalog(installed: unknown[] = [], available: unknown[] = []): string {
  return JSON.stringify({ installed, available })
}

function plugin(pluginId: string, installed: boolean, enabled = installed): Record<string, unknown> {
  const [name, marketplaceName] = pluginId.split('@')
  return {
    pluginId,
    name,
    marketplaceName,
    version: '1.2.3',
    installed,
    enabled,
    source: { source: 'local', path: `C:\\plugins\\${name}` },
    installPolicy: 'AVAILABLE',
    authPolicy: 'ON_USE',
  }
}

function marketplaces(entries: unknown[] = []): string {
  return JSON.stringify({ marketplaces: entries })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('Codex MCP contract and secret boundary', () => {
  it('rejects an oversized config before parsing extension state', () => {
    const home = temporaryDirectory()
    const configPath = path.join(home, '.codex', 'config.toml')
    write(configPath, 'x'.repeat(2 * 1024 * 1024 + 1))
    const service = new CodexExtensionService({ homeDirectory: home, invoke: async () => '[]' })

    expect(() => service.listSkills()).toThrow('2048 KB 安全上限')
  })

  it('uses list/get JSON contracts and removes env/header values from DTOs', async () => {
    const home = temporaryDirectory()
    write(path.join(home, '.codex', 'config.toml'), '[mcp_servers.local_server]\ncommand = "node"\n')
    const pluginRoot = path.join(home, 'plugins', 'sample')
    write(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ mcpServers: '.mcp.json' }))
    write(path.join(pluginRoot, '.mcp.json'), JSON.stringify({ mcpServers: { plugin_server: { type: 'http' } } }))
    const secretValues = ['sk-env-secret', 'Bearer secret-header', 'secret-key', 'HEADER_ENV']
    const calls: string[][] = []
    const invoke: CodexInvoker = async (argv) => {
      calls.push([...argv])
      if (argv[0] === 'plugin') {
        return pluginCatalog([{
          ...plugin('sample@curated', true),
          source: { source: 'local', path: pluginRoot },
        }])
      }
      if (argv[1] === 'get') return JSON.stringify(stdioMcp('local_server', { API_KEY: secretValues[0] }))
      return mcpList([
        stdioMcp('local_server', { API_KEY: secretValues[0] }),
        httpMcp('plugin_server'),
      ])
    }
    const service = new CodexExtensionService({ homeDirectory: home, invoke })

    const listed = await service.listMcpServers()
    const detail = await service.getMcpServer('local_server')
    const serialized = JSON.stringify({ listed, detail })

    expect(calls).toEqual([
      ['mcp', 'list', '--json'],
      ['plugin', 'list', '--json'],
      ['mcp', 'get', 'local_server', '--json'],
    ])
    for (const secret of secretValues) expect(serialized).not.toContain(secret)
    expect(listed[0]).toMatchObject({
      name: 'local_server',
      envNames: ['API_KEY'],
      inheritedEnvNames: ['INHERITED_TOKEN'],
      origin: 'user',
      editable: true,
    })
    expect(listed[1]).toMatchObject({
      name: 'plugin_server',
      httpHeaderNames: ['Authorization', 'X-Key'],
      inheritedHttpHeaderNames: ['X-Env'],
      origin: 'plugin',
      editable: false,
    })
  })

  it('passes special characters as inert argv and marks env values sensitive', async () => {
    const home = temporaryDirectory()
    const calls: Array<{ argv: string[]; options?: CodexInvocationOptions }> = []
    const secret = 'sk-value; $(never-run) & more'
    const invoke: CodexInvoker = async (argv, options) => {
      calls.push({ argv: [...argv], options })
      if (argv[0] === 'plugin') return pluginCatalog()
      if (argv[1] === 'add') return ''
      return mcpList([stdioMcp('safe_name', { API_TOKEN: secret })])
    }
    const service = new CodexExtensionService({ homeDirectory: home, invoke })

    const result = await service.addMcpServer({
      type: 'stdio',
      name: 'safe_name',
      command: 'node',
      args: ['script; echo BAD', '--value=a&b'],
      env: { API_TOKEN: secret },
    })

    expect(calls[0].argv).toEqual([
      'mcp', 'add', 'safe_name',
      '--env', `API_TOKEN=${secret}`,
      '--', 'node', 'script; echo BAD', '--value=a&b',
    ])
    expect(calls[0].options?.sensitiveValues).toEqual([secret])
    expect(calls[1].argv).toEqual(['mcp', 'list', '--json'])
    expect(calls[2].argv).toEqual(['plugin', 'list', '--json'])
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('accepts an HTTP add that persisted before an OAuth command failure', async () => {
    const home = temporaryDirectory()
    let calls = 0
    const invoke: CodexInvoker = async (argv) => {
      calls += 1
      if (argv[0] === 'plugin') return pluginCatalog()
      if (argv[1] === 'add') throw new Error('OAuth browser unavailable')
      return mcpList([httpMcp('remote')])
    }
    const service = new CodexExtensionService({ homeDirectory: home, invoke })

    await expect(service.addMcpServer({
      type: 'http',
      name: 'remote',
      url: 'https://example.test/mcp',
    })).resolves.toHaveLength(1)
    expect(calls).toBe(3)
  })

  it('blocks deleting non-user MCP servers and rejects invalid HTTP/env input', async () => {
    const home = temporaryDirectory()
    const calls: string[][] = []
    const invoke: CodexInvoker = async (argv) => {
      calls.push([...argv])
      if (argv[0] === 'plugin') return pluginCatalog()
      return mcpList([httpMcp('plugin_server')])
    }
    const service = new CodexExtensionService({ homeDirectory: home, invoke })

    await expect(service.removeMcpServer('plugin_server')).rejects.toThrow('不能在此删除')
    await expect(service.addMcpServer({
      type: 'http', name: 'bad', url: 'https://user:pass@example.test/#secret',
    })).rejects.toThrow('不能包含用户名或密码')
    await expect(service.addMcpServer({
      type: 'stdio', name: 'bad', command: 'node', env: { 'BAD-NAME': 'secret' },
    })).rejects.toThrow('环境变量名无效')
    expect(calls).toEqual([['mcp', 'list', '--json'], ['plugin', 'list', '--json']])
  })
})

describe('Codex Plugin and marketplace contracts', () => {
  it('parses official list shapes and reconciles install using JSON commands', async () => {
    const home = temporaryDirectory()
    const calls: string[][] = []
    let installed = false
    const invoke: CodexInvoker = async (argv) => {
      calls.push([...argv])
      if (argv[0] === 'plugin' && argv[1] === 'add') {
        installed = true
        return JSON.stringify({ installed: true })
      }
      if (argv[1] === 'list') {
        return installed
          ? pluginCatalog([plugin('sample@curated', true)])
          : pluginCatalog([], [plugin('sample@curated', false)])
      }
      return marketplaces([{ name: 'curated', root: 'C:\\market' }])
    }
    const service = new CodexExtensionService({ homeDirectory: home, invoke })

    const catalog = await service.addPlugin('sample@curated')

    expect(calls[0]).toEqual(['plugin', 'add', 'sample@curated', '--json'])
    expect(calls).toContainEqual(['plugin', 'list', '--available', '--json'])
    expect(calls).toContainEqual(['plugin', 'marketplace', 'list', '--json'])
    expect(catalog.plugins[0]).toMatchObject({ pluginId: 'sample@curated', installed: true })
    expect(catalog.marketplaces).toEqual([{ name: 'curated', root: 'C:\\market' }])
  })

  it('writes plugin enabled state structurally, backs up, and preserves unrelated TOML', async () => {
    const home = temporaryDirectory()
    const configPath = path.join(home, '.codex', 'config.toml')
    write(configPath, [
      'model = "gpt-test"',
      '[features]',
      'goals = true',
      '[plugins."sample@curated"]',
      'enabled = false',
      '',
    ].join('\n'))
    const invoke: CodexInvoker = async (argv) => {
      if (argv[1] === 'list') {
        const parsed = TOML.parse(fs.readFileSync(configPath, 'utf8'))
        const enabled = Boolean(parsed.plugins?.['sample@curated']?.enabled)
        return pluginCatalog([plugin('sample@curated', true, enabled)])
      }
      return marketplaces()
    }
    const service = new CodexExtensionService({ homeDirectory: home, configPath, invoke })

    const catalog = await service.setPluginEnabled('sample@curated', true)
    const parsed = TOML.parse(fs.readFileSync(configPath, 'utf8'))

    expect(catalog.plugins[0].enabled).toBe(true)
    expect(parsed.model).toBe('gpt-test')
    expect(parsed.features.goals).toBe(true)
    expect(parsed.plugins['sample@curated'].enabled).toBe(true)
    expect(catalog.rewriteNotice).toContain('手写注释可能丢失')
    expect(fs.readdirSync(path.dirname(configPath)).some((name) => name.startsWith('config.toml.bak.'))).toBe(true)
  })

  it('rejects traversal in sparse checkout before invoking Codex', async () => {
    const calls: string[][] = []
    const service = new CodexExtensionService({
      homeDirectory: temporaryDirectory(),
      invoke: async (argv) => { calls.push([...argv]); return '{}' },
    })

    await expect(service.addMarketplace({
      source: 'owner/repo',
      sparse: ['plugins/good', '../outside'],
    })).rejects.toThrow('仓库内的相对路径')
    expect(calls).toEqual([])
  })
})

describe('Skill discovery and managed mutations', () => {
  it('uses custom Codex config and Skills while preserving user and repository roots', async () => {
    const userHome = temporaryDirectory()
    const codexHome = temporaryDirectory()
    const repository = temporaryDirectory()
    write(path.join(codexHome, 'skills', 'codex-user', 'SKILL.md'), '---\nname: Codex User\n---\n')
    write(path.join(userHome, '.agents', 'skills', 'agents-user', 'SKILL.md'), '---\nname: Agents User\n---\n')
    write(path.join(repository, '.codex', 'skills', 'codex-project', 'SKILL.md'), '---\nname: Codex Project\n---\n')
    write(path.join(repository, '.agents', 'skills', 'agents-project', 'SKILL.md'), '---\nname: Agents Project\n---\n')
    write(path.join(codexHome, 'config.toml'), '[mcp_servers.custom]\ncommand = "node"\n')
    const service = new CodexExtensionService({
      userHome,
      codexHome,
      repositoryRoot: repository,
      env: { HOME: userHome, CODEX_HOME: codexHome },
      invoke: async (argv) => argv[0] === 'plugin'
        ? pluginCatalog()
        : mcpList([stdioMcp('custom')]),
    })

    expect(await service.listMcpServers()).toEqual([
      expect.objectContaining({ name: 'custom', origin: 'user', editable: true }),
    ])
    expect(service.listSkills().map((item) => item.name)).toEqual(expect.arrayContaining([
      'Codex User',
      'Agents User',
      'Codex Project',
      'Agents Project',
    ]))
    expect(service.getRepositoryContext().repositoryRoot).toBe(repository)
    expect(fs.existsSync(path.join(userHome, '.codex'))).toBe(false)
  })

  it('skips a Skill root that is a directory junction', () => {
    const home = temporaryDirectory()
    const outside = temporaryDirectory()
    write(path.join(outside, 'linked-skill', 'SKILL.md'), '---\nname: Linked\n---\n')
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true })
    fs.symlinkSync(outside, path.join(home, '.agents', 'skills'), 'junction')
    const service = new CodexExtensionService({ homeDirectory: home, invoke: async () => '' })

    expect(service.listSkills()).toEqual([])
  })

  it('treats the home directory as no repository and updates repository context at runtime', () => {
    const home = temporaryDirectory()
    const repository = temporaryDirectory()
    write(path.join(home, '.agents', 'skills', 'user-skill', 'SKILL.md'), '---\nname: User\n---\n')
    write(path.join(repository, '.agents', 'skills', 'repo-skill', 'SKILL.md'), '---\nname: Repo\n---\n')
    const service = new CodexExtensionService({
      homeDirectory: home,
      repositoryRoot: home,
      invoke: async () => '',
    })

    expect(service.getRepositoryContext()).toEqual({ repositoryRoot: null })
    expect(service.listSkills()).toEqual([
      expect.objectContaining({ name: 'User', scope: 'user' }),
    ])

    expect(service.setRepositoryContext(repository)).toEqual({ repositoryRoot: path.resolve(repository) })
    expect(service.listSkills()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'User', scope: 'user' }),
      expect.objectContaining({ name: 'Repo', scope: 'repo' }),
    ]))

    expect(service.setRepositoryContext(home)).toEqual({ repositoryRoot: null })
    expect(service.listSkills().some((skill) => skill.scope === 'repo')).toBe(false)
  })

  it('scans agents and legacy roots, parses frontmatter, and applies skills.config', () => {
    const home = temporaryDirectory()
    const first = path.join(home, '.agents', 'skills', 'alpha', 'SKILL.md')
    const second = path.join(home, '.codex', 'skills', 'legacy', 'SKILL.md')
    const system = path.join(home, '.codex', 'skills', '.system', 'internal', 'SKILL.md')
    write(first, '---\nname: Alpha Skill\ndescription: First skill\n---\nBody\n')
    write(second, '---\nname: Legacy\ndescription: Compatible root\n---\n')
    write(system, '---\nname: Internal\n---\n')
    write(path.join(home, '.codex', 'config.toml'), [
      'model = "gpt-test"',
      '[[skills.config]]',
      `path = ${JSON.stringify(first)}`,
      'enabled = false',
      '',
    ].join('\n'))
    const service = new CodexExtensionService({ homeDirectory: home, invoke: async () => '' })

    const skills = service.listSkills()

    expect(skills).toHaveLength(3)
    expect(skills.find((skill) => skill.name === 'Alpha Skill')).toMatchObject({
      description: 'First skill', enabled: false, scope: 'user', source: 'agents', managed: true,
    })
    expect(skills.find((skill) => skill.name === 'Legacy')).toMatchObject({ source: 'codex', managed: true })
    expect(skills.find((skill) => skill.name === 'Internal')).toMatchObject({ scope: 'system', managed: false })
  })

  it('toggles a managed skill with backup while preserving unrelated TOML', async () => {
    const home = temporaryDirectory()
    const skillPath = path.join(home, '.agents', 'skills', 'alpha', 'SKILL.md')
    const configPath = path.join(home, '.codex', 'config.toml')
    write(skillPath, '---\nname: Alpha\ndescription: Test\n---\n')
    write(configPath, 'model = "gpt-test"\n[features]\ngoals = true\n')
    const service = new CodexExtensionService({ homeDirectory: home, invoke: async () => '' })

    const { skills, rewriteNotice } = await service.setSkillEnabled(skillPath, false)
    const parsed = TOML.parse(fs.readFileSync(configPath, 'utf8'))

    expect(skills[0].enabled).toBe(false)
    expect(parsed.model).toBe('gpt-test')
    expect(parsed.features.goals).toBe(true)
    expect(parsed.skills.config).toEqual([{ path: skillPath, enabled: false }])
    expect(fs.readdirSync(path.dirname(configPath)).some((name) => name.startsWith('config.toml.bak.'))).toBe(true)
    expect(rewriteNotice).toContain('手写注释可能丢失')
  })

  it('prunes old config.toml backups while keeping the most recent ones', async () => {
    const home = temporaryDirectory()
    const skillPath = path.join(home, '.agents', 'skills', 'alpha', 'SKILL.md')
    const configPath = path.join(home, '.codex', 'config.toml')
    write(skillPath, '---\nname: Alpha\ndescription: Test\n---\n')
    write(configPath, 'model = "gpt-test"\n')
    const service = new CodexExtensionService({ homeDirectory: home, invoke: async () => '' })

    for (let index = 0; index < 8; index += 1) {
      await service.setSkillEnabled(skillPath, index % 2 === 0)
    }
    const backups = fs.readdirSync(path.dirname(configPath))
      .filter((name) => name.startsWith('config.toml.bak.'))
    expect(backups.length).toBeGreaterThan(0)
    expect(backups.length).toBeLessThanOrEqual(5)
  })

  it('refuses to mutate config.toml through a directory junction', async () => {
    const home = temporaryDirectory()
    const outside = temporaryDirectory()
    write(path.join(outside, 'config.toml'), 'model = "outside"\n')
    fs.symlinkSync(outside, path.join(home, '.codex'), 'junction')
    const service = new CodexExtensionService({
      homeDirectory: home,
      invoke: async (argv) => argv[1] === 'marketplace'
        ? JSON.stringify({ marketplaces: [] })
        : JSON.stringify({ installed: [{ pluginId: 'sample@market', installed: true, enabled: true }] }),
    })

    await expect(service.setPluginEnabled('sample@market', false)).rejects.toThrow('符号链接')
    expect(fs.readFileSync(path.join(outside, 'config.toml'), 'utf8')).toBe('model = "outside"\n')
  })

  it('rejects relative traversal and symlink imports', () => {
    const home = temporaryDirectory()
    const sourceRoot = temporaryDirectory()
    const source = path.join(sourceRoot, 'source-skill')
    write(path.join(source, 'SKILL.md'), '---\nname: Source\n---\n')
    const service = new CodexExtensionService({ homeDirectory: home, invoke: async () => '' })

    expect(() => service.importSkill({ sourcePath: '..\\outside' })).toThrow('绝对路径')

    const linked = path.join(source, 'linked.md')
    try {
      fs.symlinkSync(path.join(source, 'SKILL.md'), linked, 'file')
      expect(() => service.importSkill({ sourcePath: source })).toThrow('符号链接')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
  })

  it('imports user skills and moves uninstall targets into application trash', () => {
    const home = temporaryDirectory()
    const sourceRoot = temporaryDirectory()
    const source = path.join(sourceRoot, 'portable-skill')
    const trash = path.join(home, 'app-trash')
    write(path.join(source, 'SKILL.md'), '---\nname: Portable\ndescription: Imported\n---\n')
    const service = new CodexExtensionService({
      homeDirectory: home,
      trashDirectory: trash,
      invoke: async () => '',
    })

    const imported = service.importSkill({ sourcePath: source })
    const result = service.uninstallSkill(imported[0].path)

    expect(result.skills).toEqual([])
    expect(fs.existsSync(path.join(result.trashPath, 'SKILL.md'))).toBe(true)
    expect(isPathInside(trash, result.trashPath)).toBe(true)
  })
})

describe('trusted Codex command resolution', () => {
  it.runIf(process.platform === 'darwin')('accepts a verified official standalone command before npm-only resolution', async () => {
    const home = temporaryDirectory()
    const visibleCommand = path.join(home, '.local', 'bin', 'codex')
    const releaseCommand = path.join(
      home,
      '.codex',
      'packages',
      'standalone',
      'releases',
      '0.146.0-aarch64-apple-darwin',
      'bin',
      'codex',
    )
    writeExecutable(releaseCommand, '#!/bin/sh\n')
    fs.mkdirSync(path.dirname(visibleCommand), { recursive: true })
    fs.symlinkSync(releaseCommand, visibleCommand)
    const privateCommand = path.join(home, 'private-cli', 'codex')
    writeExecutable(privateCommand, '#!/bin/sh\n')
    const verifyStandalone = vi.fn(async (executablePath: string) => {
      expect(executablePath).toBe(visibleCommand)
      return { executable: fs.realpathSync(privateCommand), argv: [] }
    })

    const command = await resolveCodexCommand(
      { HOME: home, PATH: path.dirname(visibleCommand) },
      undefined,
      undefined,
      'trusted-only',
      verifyStandalone,
    )

    expect(command).toEqual({ executable: fs.realpathSync(privateCommand), argv: [] })
    expect(verifyStandalone).toHaveBeenCalledOnce()
  })

  it.runIf(process.platform === 'win32' && process.arch === 'x64')('recognizes the official target-specific Windows package directory', async () => {
    const programFiles = temporaryDirectory()
    const root = path.join(programFiles, 'codex-package')
    write(path.join(root, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
    const platformRoot = path.join(root, 'node_modules', '@openai', 'codex-win32-x64')
    write(path.join(platformRoot, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
    const native = path.join(
      platformRoot,
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe',
    )
    write(native, 'test')
    const command = await resolveCodexCommand(
      process.env,
      root,
      {
        systemRoot: 'C:\\Windows',
        system32: 'C:\\Windows\\System32',
        programFiles,
        programFilesX86: null,
        programData: 'C:\\ProgramData',
      },
      'same-user',
    )

    expect(command).toEqual({ executable: fs.realpathSync(native), argv: [] })
  })

  it('falls back to node plus the verified npm bin script without using a shell shim', async () => {
    const root = temporaryDirectory()
    write(path.join(root, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
    write(path.join(root, 'bin', 'codex.js'), '#!/usr/bin/env node\n')
    const command = await resolveCodexCommand(process.env, root)

    expect(path.basename(command.executable).toLowerCase()).toMatch(/^node(?:\.exe)?$/)
    expect(command.argv).toEqual([fs.realpathSync(path.join(root, 'bin', 'codex.js'))])
    expect(command.executable.toLowerCase()).not.toMatch(/\.(cmd|ps1|bat)$/)
  })

  it('discovers the verified Codex package beside a Hermes shim', async () => {
    const directory = temporaryDirectory()
    const prefix = path.join(directory, 'hermes')
    const packageRoot = path.join(prefix, 'node_modules', '@openai', 'codex')
    const codexExecutable = process.platform === 'win32' ? 'codex.cmd' : 'codex'
    const nodeExecutable = process.platform === 'win32' ? 'node.exe' : 'node'
    writeExecutable(path.join(prefix, codexExecutable), process.platform === 'win32'
      ? '@echo off\n'
      : '#!/bin/sh\n')
    writeExecutable(path.join(prefix, nodeExecutable), '')
    write(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@openai/codex',
      bin: { codex: 'bin/codex.js' },
    }))
    write(path.join(packageRoot, 'bin', 'codex.js'), '#!/usr/bin/env node\n')

    const command = await resolveCodexCommand({ PATH: prefix, HOME: directory })

    expect(command.executable).toBe(path.resolve(prefix, nodeExecutable))
    expect(command.argv).toEqual([fs.realpathSync(path.join(packageRoot, 'bin', 'codex.js'))])
  })

  it.runIf(process.platform === 'win32')('blocks a user-writable Codex npm script in the default extension invoker', async () => {
    const home = temporaryDirectory()
    const packageRoot = path.join(home, 'node_modules', '@openai', 'codex')
    const runtimeDirectory = path.dirname(process.execPath)
    write(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
    write(path.join(packageRoot, 'bin', 'codex.js'), '#!/usr/bin/env node\n')
    const service = new CodexExtensionService({
      homeDirectory: home,
      codexPackageRoot: packageRoot,
      // 必须隔离真实环境：machinePaths 把 runtimeDirectory 伪装成 system32，
      // 而真机若装有系统级 Node.js，命令解析会优先选中 Program Files 下的
      // node.exe，其可信判定要用 machinePaths.system32 下的 PowerShell 查 ACL，
      // 在伪造路径下必然探测失败，测试就会因环境而非代码而失败。
      env: { PATH: runtimeDirectory, SystemRoot: path.dirname(runtimeDirectory) },
      machinePaths: {
        systemRoot: path.dirname(runtimeDirectory),
        system32: runtimeDirectory,
        programFiles: path.join(home, 'no-program-files'),
        programFilesX86: null,
        programData: path.join(home, 'no-program-data'),
      },
    })

    await expect(service.listPlugins()).rejects.toThrow(/Codex 扩展管理.*CLI 脚本或绝对路径参数位于用户可写目录/)
  })

  it.runIf(process.platform === 'win32')('reads Codex extensions through the user CLI in confirmed same-user mode', async () => {
    const home = temporaryDirectory()
    const packageRoot = path.join(home, 'node_modules', '@openai', 'codex')
    write(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
    write(
      path.join(packageRoot, 'bin', 'codex.js'),
      'console.log(JSON.stringify({ installed: [], available: [], marketplaces: [] }))\n',
    )
    const service = new CodexExtensionService({
      homeDirectory: home,
      codexPackageRoot: packageRoot,
      env: process.env,
      windowsExecutionMode: 'same-user',
    })

    await expect(service.listPlugins()).resolves.toEqual({ plugins: [], marketplaces: [] })
  })
})

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
