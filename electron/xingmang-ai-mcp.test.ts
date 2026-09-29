import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  XINGMANG_IMAGE_CONFIG_ENV,
  XINGMANG_IMAGE_MCP_NAME,
  buildXingmangImageMcpInput,
  syncXingmangImageMcp,
} from './xingmang-ai-mcp'

describe('xingmang-ai-mcp', () => {
  it('builds a stdio MCP entry without putting the API key in Codex config', () => {
    const input = buildXingmangImageMcpInput(
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Users\\tester\\.agents\\skills\\星芒AI\\config.json',
      'C:\\Users\\tester\\.agents\\skills\\星芒AI\\scripts\\mcp-server.mjs',
    )
    expect(input).toEqual({
      type: 'stdio',
      name: XINGMANG_IMAGE_MCP_NAME,
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Users\\tester\\.agents\\skills\\星芒AI\\scripts\\mcp-server.mjs'],
      env: {
        [XINGMANG_IMAGE_CONFIG_ENV]: 'C:\\Users\\tester\\.agents\\skills\\星芒AI\\config.json',
      },
    })
    expect(JSON.stringify(input)).not.toContain('sk-')
  })

  it('does not overwrite a user-owned same-name server', async () => {
    const addMcpServer = vi.fn()
    const listMcpServers = vi.fn(async () => [{
      name: XINGMANG_IMAGE_MCP_NAME,
      enabled: true,
      disabledReason: null,
      transportType: 'stdio' as const,
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Users\\tester\\.agents\\skills\\星芒AI\\scripts\\mcp-server.mjs'],
      cwd: null,
      url: null,
      envNames: [XINGMANG_IMAGE_CONFIG_ENV],
      inheritedEnvNames: [],
      httpHeaderNames: [],
      inheritedHttpHeaderNames: [],
      bearerTokenEnvVar: null,
      startupTimeoutSec: null,
      toolTimeoutSec: null,
      authStatus: 'unknown',
      origin: 'user' as const,
      editable: true,
    }])
    await syncXingmangImageMcp({
      extensionService: { listMcpServers, addMcpServer },
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      configPath: 'C:\\Users\\tester\\.agents\\skills\\星芒AI\\config.json',
      scriptPath: 'C:\\Users\\tester\\.agents\\skills\\星芒AI\\scripts\\mcp-server.mjs',
    })
    expect(addMcpServer).not.toHaveBeenCalled()
  })

  it('adds the server when it is absent', async () => {
    const addMcpServer = vi.fn(async (_input: unknown) => [])
    const listMcpServers = vi.fn(async () => [])
    await syncXingmangImageMcp({
      extensionService: { listMcpServers, addMcpServer },
      nodeExecutable: path.win32.normalize('C:/Program Files/nodejs/node.exe'),
      configPath: path.win32.normalize('C:/Users/tester/.agents/skills/星芒AI/config.json'),
      scriptPath: path.win32.normalize('C:/Users/tester/.agents/skills/星芒AI/scripts/mcp-server.mjs'),
    })
    expect(addMcpServer).toHaveBeenCalledOnce()
    expect(addMcpServer.mock.calls[0][0]).toMatchObject({
      type: 'stdio',
      name: XINGMANG_IMAGE_MCP_NAME,
      env: { [XINGMANG_IMAGE_CONFIG_ENV]: expect.stringContaining('config.json') },
    })
  })
})
