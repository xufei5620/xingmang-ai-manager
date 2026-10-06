import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as TOML from '@iarna/toml'
import { afterEach, describe, expect, it } from 'vitest'
import { syncXingmangImageMcpConfigs } from './config-files'
import {
  XINGMANG_IMAGE_CLAUDE_PERMISSION,
  XINGMANG_IMAGE_CONFIG_ENV,
  XINGMANG_IMAGE_MCP_NAME,
  XINGMANG_IMAGE_TOOL_TIMEOUT_SEC,
  applyXingmangImageMcpToJson,
  applyXingmangImageMcpToToml,
  applyXingmangImagePermissionToClaudeSettings,
  buildXingmangImageMcpInvocation,
  isManagedXingmangImageMcpEntry,
} from './xingmang-ai-mcp'

const temporaryHomes: string[] = []

afterEach(() => {
  for (const directory of temporaryHomes.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function temporaryHome(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-image-mcp-'))
  temporaryHomes.push(directory)
  return directory
}

// Absolute on whichever OS runs the test: a hard-coded C:\ path is relative on macOS.
const skillDirectory = path.resolve(os.tmpdir(), 'home', '.agents', 'skills', '星芒AI')
const nodeExecutable = path.resolve(os.tmpdir(), 'nodejs', 'node')
const invocation = buildXingmangImageMcpInvocation(nodeExecutable, skillDirectory)

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not a record')
  return value as Record<string, unknown>
}

describe('xingmang-ai-mcp', () => {
  it('builds the invocation from the skill directory without any key', () => {
    expect(invocation).toEqual({
      nodeExecutable,
      scriptPath: path.join(skillDirectory, 'scripts', 'mcp-server.mjs'),
      configPath: path.join(skillDirectory, 'config.json'),
    })
    expect(() => buildXingmangImageMcpInvocation('node', skillDirectory)).toThrow('绝对路径')
  })

  it('recognises only entries that launch the bundled script from a 星芒AI skill directory', () => {
    expect(isManagedXingmangImageMcpEntry({ args: [invocation.scriptPath] })).toBe(true)
    expect(isManagedXingmangImageMcpEntry({ args: ['C:\\Users\\a\\.agents\\skills\\星芒AI\\scripts\\mcp-server.mjs'] })).toBe(true)
    expect(isManagedXingmangImageMcpEntry({ args: ['/home/a/my-own/mcp-server.mjs'] })).toBe(false)
    expect(isManagedXingmangImageMcpEntry({ command: 'npx', args: ['-y', 'someone-else'] })).toBe(false)
  })

  it('writes a Codex entry with a five minute timeout and pre-approves only the image tool', () => {
    const parsed: Record<string, unknown> = { model: 'gpt-5.5' }
    expect(applyXingmangImageMcpToToml(parsed, invocation, 'codex')).toBe(true)
    const entry = asRecord(asRecord(parsed.mcp_servers)[XINGMANG_IMAGE_MCP_NAME])
    expect(entry).toEqual({
      command: nodeExecutable,
      args: [invocation.scriptPath],
      enabled: true,
      tool_timeout_sec: XINGMANG_IMAGE_TOOL_TIMEOUT_SEC,
      env: { [XINGMANG_IMAGE_CONFIG_ENV]: invocation.configPath },
      tools: { generate_image: { approval_mode: 'approve' } },
    })
    expect(JSON.stringify(parsed)).not.toContain('sk-')
    expect(applyXingmangImageMcpToToml(parsed, invocation, 'codex')).toBe(false)
  })

  it('writes a Grok entry without Codex-only approval keys', () => {
    const parsed: Record<string, unknown> = {}
    applyXingmangImageMcpToToml(parsed, invocation, 'grok')
    expect(asRecord(asRecord(parsed.mcp_servers)[XINGMANG_IMAGE_MCP_NAME]).tools).toBeUndefined()
  })

  it('leaves a same-name server the user set up alone', () => {
    const own = { command: 'npx', args: ['-y', 'my-image-server'] }
    const toml: Record<string, unknown> = { mcp_servers: { [XINGMANG_IMAGE_MCP_NAME]: own } }
    const json: Record<string, unknown> = { mcpServers: { [XINGMANG_IMAGE_MCP_NAME]: own } }
    expect(applyXingmangImageMcpToToml(toml, invocation, 'codex')).toBe(false)
    expect(applyXingmangImageMcpToJson(json, invocation, 'claude')).toBe(false)
    expect(asRecord(toml.mcp_servers)[XINGMANG_IMAGE_MCP_NAME]).toBe(own)
  })

  it('repoints its own entry after Node moves and keeps a user disable', () => {
    const parsed: Record<string, unknown> = {
      mcp_servers: {
        [XINGMANG_IMAGE_MCP_NAME]: { command: '/old/node', args: [invocation.scriptPath], enabled: false },
      },
    }
    expect(applyXingmangImageMcpToToml(parsed, invocation, 'codex')).toBe(true)
    const entry = asRecord(asRecord(parsed.mcp_servers)[XINGMANG_IMAGE_MCP_NAME])
    expect(entry.command).toBe(nodeExecutable)
    expect(entry.enabled).toBe(false)
  })

  it('keeps every choice the user made in its own Codex entry and only repoints the launch', () => {
    const oldSkillDirectory = path.resolve(os.tmpdir(), 'old-home', '.agents', 'skills', '星芒AI')
    const userEntry = {
      command: '/old/node',
      args: [path.join(oldSkillDirectory, 'scripts', 'mcp-server.mjs')],
      enabled: false,
      tool_timeout_sec: 120,
      startup_timeout_sec: 20,
      disabled_tools: ['other_tool'],
      env: { [XINGMANG_IMAGE_CONFIG_ENV]: path.join(oldSkillDirectory, 'config.json'), NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem' },
      tools: { generate_image: { approval_mode: 'prompt', output_token_limit: 2000 } },
    }
    const parsed: Record<string, unknown> = { mcp_servers: { [XINGMANG_IMAGE_MCP_NAME]: structuredClone(userEntry) } }
    expect(applyXingmangImageMcpToToml(parsed, invocation, 'codex')).toBe(true)
    expect(asRecord(parsed.mcp_servers)[XINGMANG_IMAGE_MCP_NAME]).toEqual({
      ...userEntry,
      command: nodeExecutable,
      args: [invocation.scriptPath],
      env: { [XINGMANG_IMAGE_CONFIG_ENV]: invocation.configPath, NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem' },
    })
    expect(applyXingmangImageMcpToToml(parsed, invocation, 'codex')).toBe(false)
  })

  it('does not bring back defaults the user deleted from its own entry', () => {
    const toml: Record<string, unknown> = {
      mcp_servers: {
        [XINGMANG_IMAGE_MCP_NAME]: {
          command: nodeExecutable,
          args: [invocation.scriptPath],
          env: { [XINGMANG_IMAGE_CONFIG_ENV]: invocation.configPath },
        },
      },
    }
    const json: Record<string, unknown> = {
      mcpServers: {
        [XINGMANG_IMAGE_MCP_NAME]: {
          command: nodeExecutable,
          args: [invocation.scriptPath],
          env: { [XINGMANG_IMAGE_CONFIG_ENV]: invocation.configPath },
        },
      },
    }
    expect(applyXingmangImageMcpToToml(toml, invocation, 'codex')).toBe(false)
    expect(applyXingmangImageMcpToJson(json, invocation, 'gemini')).toBe(false)
    expect(Object.keys(asRecord(asRecord(toml.mcp_servers)[XINGMANG_IMAGE_MCP_NAME]))).toEqual(['command', 'args', 'env'])
    expect(Object.keys(asRecord(asRecord(json.mcpServers)[XINGMANG_IMAGE_MCP_NAME]))).toEqual(['command', 'args', 'env'])
  })

  it('keeps a Gemini user who turned trust off or narrowed the tools', () => {
    const userEntry = {
      command: '/old/node',
      args: [invocation.scriptPath],
      env: { [XINGMANG_IMAGE_CONFIG_ENV]: invocation.configPath },
      timeout: 60_000,
      trust: false,
      excludeTools: ['generate_image'],
    }
    const parsed: Record<string, unknown> = { mcpServers: { [XINGMANG_IMAGE_MCP_NAME]: structuredClone(userEntry) } }
    expect(applyXingmangImageMcpToJson(parsed, invocation, 'gemini')).toBe(true)
    expect(asRecord(parsed.mcpServers)[XINGMANG_IMAGE_MCP_NAME]).toEqual({ ...userEntry, command: nodeExecutable })
  })

  it('keeps what the user added to its own Claude entry', () => {
    const parsed: Record<string, unknown> = {
      mcpServers: {
        [XINGMANG_IMAGE_MCP_NAME]: {
          type: 'stdio',
          command: '/old/node',
          args: [invocation.scriptPath],
          env: { [XINGMANG_IMAGE_CONFIG_ENV]: invocation.configPath, NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem' },
        },
      },
    }
    expect(applyXingmangImageMcpToJson(parsed, invocation, 'claude')).toBe(true)
    expect(asRecord(parsed.mcpServers)[XINGMANG_IMAGE_MCP_NAME]).toEqual({
      type: 'stdio',
      command: nodeExecutable,
      args: [invocation.scriptPath],
      env: { [XINGMANG_IMAGE_CONFIG_ENV]: invocation.configPath, NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem' },
    })
  })

  it('still rewrites what it needs to launch the script when the user broke it', () => {
    const toml: Record<string, unknown> = {
      mcp_servers: { [XINGMANG_IMAGE_MCP_NAME]: { command: nodeExecutable, args: [invocation.scriptPath], env: 'oops' } },
    }
    const json: Record<string, unknown> = {
      mcpServers: { [XINGMANG_IMAGE_MCP_NAME]: { type: 'sse', command: nodeExecutable, args: [invocation.scriptPath] } },
    }
    expect(applyXingmangImageMcpToToml(toml, invocation, 'grok')).toBe(true)
    expect(applyXingmangImageMcpToJson(json, invocation, 'claude')).toBe(true)
    expect(asRecord(asRecord(toml.mcp_servers)[XINGMANG_IMAGE_MCP_NAME]).env).toEqual({
      [XINGMANG_IMAGE_CONFIG_ENV]: invocation.configPath,
    })
    expect(asRecord(asRecord(json.mcpServers)[XINGMANG_IMAGE_MCP_NAME])).toEqual({
      type: 'stdio',
      command: nodeExecutable,
      args: [invocation.scriptPath],
      env: { [XINGMANG_IMAGE_CONFIG_ENV]: invocation.configPath },
    })
  })

  it('writes Claude and Gemini entries in their own shapes', () => {
    const claude: Record<string, unknown> = {}
    const gemini: Record<string, unknown> = {}
    applyXingmangImageMcpToJson(claude, invocation, 'claude')
    applyXingmangImageMcpToJson(gemini, invocation, 'gemini')
    expect(asRecord(claude.mcpServers)[XINGMANG_IMAGE_MCP_NAME]).toMatchObject({ type: 'stdio', command: nodeExecutable })
    expect(asRecord(gemini.mcpServers)[XINGMANG_IMAGE_MCP_NAME]).toMatchObject({
      command: nodeExecutable,
      timeout: XINGMANG_IMAGE_TOOL_TIMEOUT_SEC * 1000,
      trust: true,
    })
  })

  it('allows only the image tool in Claude settings and respects a user deny', () => {
    const fresh: Record<string, unknown> = { permissions: { allow: ['Bash(ls:*)'] } }
    expect(applyXingmangImagePermissionToClaudeSettings(fresh)).toBe(true)
    expect(asRecord(fresh.permissions).allow).toEqual(['Bash(ls:*)', XINGMANG_IMAGE_CLAUDE_PERMISSION])
    expect(applyXingmangImagePermissionToClaudeSettings(fresh)).toBe(false)
    const denied: Record<string, unknown> = { permissions: { deny: [`mcp__${XINGMANG_IMAGE_MCP_NAME}`] } }
    expect(applyXingmangImagePermissionToClaudeSettings(denied)).toBe(false)
    expect(asRecord(denied.permissions).allow).toBeUndefined()
  })
})

describe('syncXingmangImageMcpConfigs', () => {
  function roots(userHome: string) {
    return { userHome, codexHome: path.join(userHome, '.codex') }
  }

  it('registers the tool in every installed CLI without needing any CLI binary', () => {
    const home = temporaryHome()
    fs.mkdirSync(path.join(home, '.codex'))
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5.5"\n')
    fs.mkdirSync(path.join(home, '.claude'))
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"env":{}}\n')
    fs.mkdirSync(path.join(home, '.gemini'))
    fs.mkdirSync(path.join(home, '.grok'))
    fs.writeFileSync(path.join(home, '.grok', 'config.toml'), '[cli]\nauto_update = false\n')

    const result = syncXingmangImageMcpConfigs(roots(home), invocation, { codex: true })
    expect(result).toEqual({ changed: ['codex', 'claude', 'gemini', 'grok'], warnings: [] })

    const codex = TOML.parse(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')) as Record<string, unknown>
    expect(codex.model).toBe('gpt-5.5')
    expect(asRecord(codex.mcp_servers)[XINGMANG_IMAGE_MCP_NAME]).toMatchObject({ tool_timeout_sec: 300 })
    const claudeRoot = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) as Record<string, unknown>
    expect(asRecord(claudeRoot.mcpServers)[XINGMANG_IMAGE_MCP_NAME]).toMatchObject({ type: 'stdio' })
    const claudeSettings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(claudeSettings.env).toEqual({})
    expect(asRecord(claudeSettings.permissions).allow).toEqual([XINGMANG_IMAGE_CLAUDE_PERMISSION])
    const gemini = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(asRecord(gemini.mcpServers)[XINGMANG_IMAGE_MCP_NAME]).toMatchObject({ trust: true })
    const grok = TOML.parse(fs.readFileSync(path.join(home, '.grok', 'config.toml'), 'utf8')) as Record<string, unknown>
    expect(asRecord(grok.cli).auto_update).toBe(false)
    expect(asRecord(grok.mcp_servers)[XINGMANG_IMAGE_MCP_NAME]).toMatchObject({ command: nodeExecutable })

    expect(syncXingmangImageMcpConfigs(roots(home), invocation, { codex: true }).changed).toEqual([])
  })

  it('leaves a user who wants to be asked before each picture alone on every later sync', () => {
    const home = temporaryHome()
    const codexPath = path.join(home, '.codex', 'config.toml')
    const geminiPath = path.join(home, '.gemini', 'settings.json')
    fs.mkdirSync(path.join(home, '.codex'))
    fs.writeFileSync(codexPath, 'model = "gpt-5.5"\n')
    fs.mkdirSync(path.join(home, '.gemini'))
    expect(syncXingmangImageMcpConfigs(roots(home), invocation, { codex: true }).changed).toEqual(['codex', 'gemini'])

    const codex = TOML.parse(fs.readFileSync(codexPath, 'utf8'))
    Object.assign(asRecord(asRecord(codex.mcp_servers)[XINGMANG_IMAGE_MCP_NAME]), {
      startup_timeout_sec: 20,
      tools: { generate_image: { approval_mode: 'prompt' } },
    })
    fs.writeFileSync(codexPath, TOML.stringify(codex))
    const gemini = JSON.parse(fs.readFileSync(geminiPath, 'utf8')) as Record<string, unknown>
    Object.assign(asRecord(asRecord(gemini.mcpServers)[XINGMANG_IMAGE_MCP_NAME]), { trust: false, excludeTools: ['other_tool'] })
    fs.writeFileSync(geminiPath, `${JSON.stringify(gemini, null, 2)}\n`)
    const codexBefore = fs.readFileSync(codexPath, 'utf8')
    const geminiBefore = fs.readFileSync(geminiPath, 'utf8')

    expect(syncXingmangImageMcpConfigs(roots(home), invocation, { codex: true })).toEqual({ changed: [], warnings: [] })
    expect(fs.readFileSync(codexPath, 'utf8')).toBe(codexBefore)
    expect(fs.readFileSync(geminiPath, 'utf8')).toBe(geminiBefore)

    const movedNode = path.resolve(os.tmpdir(), 'nodejs-moved', 'node')
    const moved = buildXingmangImageMcpInvocation(movedNode, skillDirectory)
    expect(syncXingmangImageMcpConfigs(roots(home), moved, { codex: true }).changed).toEqual(['codex', 'gemini'])
    const codexAfter = TOML.parse(fs.readFileSync(codexPath, 'utf8'))
    expect(asRecord(codexAfter.mcp_servers)[XINGMANG_IMAGE_MCP_NAME]).toMatchObject({
      command: movedNode,
      tool_timeout_sec: XINGMANG_IMAGE_TOOL_TIMEOUT_SEC,
      startup_timeout_sec: 20,
      tools: { generate_image: { approval_mode: 'prompt' } },
    })
    const geminiAfter = JSON.parse(fs.readFileSync(geminiPath, 'utf8')) as Record<string, unknown>
    expect(asRecord(geminiAfter.mcpServers)[XINGMANG_IMAGE_MCP_NAME]).toMatchObject({
      command: movedNode,
      trust: false,
      excludeTools: ['other_tool'],
    })
  })

  it('creates nothing for tools that were never installed and skips Codex on an official login', () => {
    const home = temporaryHome()
    fs.mkdirSync(path.join(home, '.codex'))
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5.5"\n')
    const result = syncXingmangImageMcpConfigs(roots(home), invocation, { codex: false })
    expect(result).toEqual({ changed: [], warnings: [] })
    expect(fs.readdirSync(home).sort()).toEqual(['.codex'])
    expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).toBe('model = "gpt-5.5"\n')
  })

  it('reports one unreadable config without blocking the others', () => {
    const home = temporaryHome()
    fs.mkdirSync(path.join(home, '.codex'))
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = [unclosed\n')
    fs.mkdirSync(path.join(home, '.gemini'))
    const result = syncXingmangImageMcpConfigs(roots(home), invocation, { codex: true })
    expect(result.changed).toEqual(['gemini'])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/^codex：现有 Codex config.toml 无法解析/)
  })
})
