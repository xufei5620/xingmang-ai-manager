import path from 'node:path'
import type { AddMcpInput, CodexExtensionService, McpServerDto } from './codex-extensions'

export const XINGMANG_IMAGE_MCP_NAME = 'xingmang-image'
export const XINGMANG_IMAGE_CONFIG_ENV = 'XINGMANG_IMAGE_CONFIG_PATH'

export interface XingmangImageMcpSyncInput {
  extensionService: Pick<CodexExtensionService, 'listMcpServers' | 'addMcpServer'>
  nodeExecutable: string
  configPath: string
  scriptPath: string
}

export function buildXingmangImageMcpInput(
  nodeExecutable: string,
  configPath: string,
  scriptPath: string,
): AddMcpInput {
  if (!path.isAbsolute(nodeExecutable) || !path.isAbsolute(configPath) || !path.isAbsolute(scriptPath)) {
    throw new Error('星芒图片 MCP 路径必须是绝对路径')
  }
  return {
    type: 'stdio',
    name: XINGMANG_IMAGE_MCP_NAME,
    command: nodeExecutable,
    args: [scriptPath],
    env: { [XINGMANG_IMAGE_CONFIG_ENV]: configPath },
  }
}

function sameMcpConfiguration(server: McpServerDto, input: AddMcpInput): boolean {
  if (input.type !== 'stdio') return false
  return server.transportType === 'stdio'
    && server.command === input.command
    && server.args.length === input.args?.length
    && server.args.every((value, index) => value === input.args?.[index])
    && server.envNames.length === Object.keys(input.env ?? {}).length
    && server.envNames.every((value) => Object.hasOwn(input.env ?? {}, value))
}

/**
 * The MCP bridge is opt-in at the account-sync boundary but idempotent after
 * that. An existing user-owned entry is left untouched so account refreshes
 * cannot silently overwrite a user's command or disable choice.
 */
export async function syncXingmangImageMcp(options: XingmangImageMcpSyncInput): Promise<void> {
  const input = buildXingmangImageMcpInput(options.nodeExecutable, options.configPath, options.scriptPath)
  const existing = (await options.extensionService.listMcpServers())
    .find((server) => server.name === XINGMANG_IMAGE_MCP_NAME)
  if (existing) {
    if (!sameMcpConfiguration(existing, input)) {
      throw new Error('已有同名 MCP 连接，未覆盖用户配置')
    }
    return
  }
  await options.extensionService.addMcpServer(input)
}
