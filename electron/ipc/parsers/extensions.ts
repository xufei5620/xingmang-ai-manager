// MCP、插件市场、Skill 导入和各工具扩展操作的入参。
import { isActiveProviderId } from '../../catalog'
import type { AddMarketplaceInput, AddMcpInput, ImportSkillInput } from '../../codex-extensions'
import { isRecord } from '../../input-guards'
import type { ProviderExtensionMutation } from '../../provider-extensions'
import { optionalString, requiredString, stringArray } from './common'

export function parseMcpInput(value: unknown): AddMcpInput {
  if (!isRecord(value)) throw new Error('MCP 配置格式错误')
  const name = requiredString(value.name, 'MCP 名称', 128)
  if (value.type === 'stdio') {
    const envValue = value.env
    if (envValue !== undefined && !isRecord(envValue)) throw new Error('MCP 环境变量格式错误')
    const envEntries = Object.entries(envValue ?? {})
    if (envEntries.length > 128) throw new Error('MCP 环境变量数量过多')
    const env: Record<string, string> = {}
    for (const [key, entry] of envEntries) {
      if (typeof entry !== 'string' || entry.length > 4_096) throw new Error('MCP 环境变量格式错误')
      env[requiredString(key, '环境变量名', 128)] = entry
    }
    return {
      type: 'stdio',
      name,
      command: requiredString(value.command, 'MCP 命令'),
      args: stringArray(value.args, 'MCP 参数'),
      env,
    }
  }
  if (value.type !== 'http') throw new Error('MCP 类型错误')
  return {
    type: 'http',
    name,
    url: requiredString(value.url, 'MCP 地址'),
    bearerTokenEnvVar: optionalString(value.bearerTokenEnvVar, 'Bearer Token 环境变量名', 128),
    oauthClientId: optionalString(value.oauthClientId, 'OAuth Client ID'),
    oauthResource: optionalString(value.oauthResource, 'OAuth Resource'),
  }
}

export function parseMarketplaceInput(value: unknown): AddMarketplaceInput {
  if (!isRecord(value)) throw new Error('市场配置格式错误')
  return {
    source: requiredString(value.source, '市场来源'),
    ref: optionalString(value.ref, 'Git Ref', 256),
    sparse: stringArray(value.sparse, 'Sparse 路径'),
  }
}

export function parseSkillInput(value: unknown): ImportSkillInput {
  if (!isRecord(value)) throw new Error('Skill 导入格式错误')
  if (value.scope !== undefined && value.scope !== 'user' && value.scope !== 'repo') {
    throw new Error('Skill 范围格式错误')
  }
  return {
    sourcePath: requiredString(value.sourcePath, 'Skill 路径', 32_767),
    scope: value.scope,
  }
}

export function parseProviderExtensionMutation(value: unknown): ProviderExtensionMutation {
  if (!isRecord(value) || !isActiveProviderId(value.provider)) {
    throw new Error('扩展操作格式错误')
  }
  const kind = String(value.kind)
  if (!['mcp', 'skill', 'plugin'].includes(kind)) {
    throw new Error('扩展类型错误')
  }
  const action = String(value.action)
  if (!['install', 'uninstall', 'enable', 'disable', 'update'].includes(action)) {
    throw new Error('扩展操作类型错误')
  }
  const scope = value.scope === undefined ? undefined : String(value.scope)
  if (scope !== undefined && !['user', 'project', 'local', 'workspace'].includes(scope)) {
    throw new Error('扩展范围错误')
  }
  // Only a literal true counts as the user's answer; "true" or 1 must not slip a --trust in.
  if (value.trust !== undefined && typeof value.trust !== 'boolean') {
    throw new Error('扩展操作格式错误')
  }

  let mcp: ProviderExtensionMutation['mcp']
  if (value.mcp !== undefined) {
    if (!isRecord(value.mcp)) throw new Error('MCP 安装配置格式错误')
    if (value.mcp.type === 'http') {
      mcp = {
        type: 'http',
        url: requiredString(value.mcp.url, 'MCP 地址'),
      }
    } else if (value.mcp.type === 'stdio') {
      const envValue = value.mcp.env
      if (envValue !== undefined && !isRecord(envValue)) throw new Error('MCP 环境变量格式错误')
      const envEntries = Object.entries(envValue ?? {})
      if (envEntries.length > 128) throw new Error('MCP 环境变量数量过多')
      const env: Record<string, string> = {}
      for (const [key, entry] of envEntries) {
        if (typeof entry !== 'string' || entry.length > 4_096) throw new Error('MCP 环境变量格式错误')
        env[requiredString(key, '环境变量名', 128)] = entry
      }
      mcp = {
        type: 'stdio',
        command: requiredString(value.mcp.command, 'MCP 命令'),
        args: stringArray(value.mcp.args, 'MCP 参数'),
        env,
      }
    } else {
      throw new Error('MCP 安装配置类型错误')
    }
  }

  return {
    provider: value.provider,
    kind: kind as ProviderExtensionMutation['kind'],
    action: action as ProviderExtensionMutation['action'],
    id: optionalString(value.id, '扩展 ID', 512),
    source: optionalString(value.source, '扩展来源'),
    scope: scope as ProviderExtensionMutation['scope'],
    mcp,
    ...(value.trust === true ? { trust: true } : {}),
  }
}
