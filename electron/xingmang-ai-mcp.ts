import path from 'node:path'
import { XINGMANG_AI_CONFIG_FILE, XINGMANG_AI_SKILL_DIRECTORY } from './xingmang-ai-skill'

export const XINGMANG_IMAGE_MCP_NAME = 'xingmang-image'
export const XINGMANG_IMAGE_TOOL_NAME = 'generate_image'
export const XINGMANG_IMAGE_CONFIG_ENV = 'XINGMANG_IMAGE_CONFIG_PATH'
export const XINGMANG_IMAGE_SCRIPT_FILE = 'mcp-server.mjs'
// 出一张高清图常常超过一分钟，Codex 缺省 60 秒就判工具超时；脚本自己也等 300 秒。
export const XINGMANG_IMAGE_TOOL_TIMEOUT_SEC = 300
export const XINGMANG_IMAGE_CLAUDE_PERMISSION = `mcp__${XINGMANG_IMAGE_MCP_NAME}__${XINGMANG_IMAGE_TOOL_NAME}`

/** 写进各家 MCP 配置的启动方式。Key 不在这里，脚本按路径去读星芒 Skill 的 config.json。 */
export interface XingmangImageMcpInvocation {
  nodeExecutable: string
  scriptPath: string
  configPath: string
}

export type XingmangImageTomlVariant = 'codex' | 'grok'
export type XingmangImageJsonVariant = 'claude' | 'gemini'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function buildXingmangImageMcpInvocation(
  nodeExecutable: string,
  skillDirectory: string,
): XingmangImageMcpInvocation {
  if (!path.isAbsolute(nodeExecutable) || !path.isAbsolute(skillDirectory)) {
    throw new Error('星芒图片 MCP 路径必须是绝对路径')
  }
  return {
    nodeExecutable,
    scriptPath: path.join(skillDirectory, 'scripts', XINGMANG_IMAGE_SCRIPT_FILE),
    configPath: path.join(skillDirectory, XINGMANG_AI_CONFIG_FILE),
  }
}

/**
 * An entry is ours only when it launches the bundled script from a 星芒AI skill
 * directory. Anything else under the same name belongs to the user and is never
 * rewritten. Paths are split on both separators because the config may have been
 * written on the other OS family than the one reading it in tests.
 */
export function isManagedXingmangImageMcpEntry(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.args) || value.args.length !== 1) return false
  const script = value.args[0]
  if (typeof script !== 'string') return false
  const segments = script.split(/[\\/]+/)
  return segments.length >= 3
    && segments[segments.length - 1] === XINGMANG_IMAGE_SCRIPT_FILE
    && segments[segments.length - 2] === 'scripts'
    && segments[segments.length - 3] === XINGMANG_AI_SKILL_DIRECTORY
}

// 只在第一次登记时写；以后缺了也不补回来，理由见 repointedEntry。
function freshTomlEntry(invocation: XingmangImageMcpInvocation, variant: XingmangImageTomlVariant): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    command: invocation.nodeExecutable,
    args: [invocation.scriptPath],
    enabled: true,
    tool_timeout_sec: XINGMANG_IMAGE_TOOL_TIMEOUT_SEC,
    env: { [XINGMANG_IMAGE_CONFIG_ENV]: invocation.configPath },
  }
  if (variant === 'codex') {
    // Pre-approved by default: this one tool of this one server can reach nothing
    // but the account's own image endpoint (see mcp-server.mjs). Every image still
    // costs balance, so a user who switches it back to a per-call prompt keeps that.
    entry.tools = { [XINGMANG_IMAGE_TOOL_NAME]: { approval_mode: 'approve' } }
  }
  return entry
}

function freshJsonEntry(invocation: XingmangImageMcpInvocation, variant: XingmangImageJsonVariant): Record<string, unknown> {
  const env = { [XINGMANG_IMAGE_CONFIG_ENV]: invocation.configPath }
  return variant === 'claude'
    ? { type: 'stdio', command: invocation.nodeExecutable, args: [invocation.scriptPath], env }
    : {
      command: invocation.nodeExecutable,
      args: [invocation.scriptPath],
      env,
      // Gemini 按毫秒计时。trust 只免这一个服务器的调用确认，不改别的服务器或工具。
      timeout: XINGMANG_IMAGE_TOOL_TIMEOUT_SEC * 1000,
      trust: true,
    }
}

/**
 * 登记过的条目每次只对齐脚本跑起来必需的几项（Node 或技能目录换了位置要跟着改）：
 * command、args，以及 env 里那个配置路径。别的键照现在的样子留着，缺了也不补：本软件
 * 写过的每一版都是上面那一整套，缺的只会是客户删的，或者工具自己改写时省掉的缺省值
 * （Codex 不写 enabled = true）。关掉、改超时、改成每次先问、自己加的项都算客户的选择；
 * 画一张图要扣余额，改成先问一句的人不能每次打开星芒又被改回不问就画。
 */
function repointedEntry(existing: Record<string, unknown>, invocation: XingmangImageMcpInvocation): Record<string, unknown> {
  return {
    ...existing,
    command: invocation.nodeExecutable,
    args: [invocation.scriptPath],
    env: { ...(isRecord(existing.env) ? existing.env : {}), [XINGMANG_IMAGE_CONFIG_ENV]: invocation.configPath },
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Codex 与 Grok 的 config.toml 都用 [mcp_servers.<名字>]。返回是否改动。 */
export function applyXingmangImageMcpToToml(
  parsed: Record<string, unknown>,
  invocation: XingmangImageMcpInvocation,
  variant: XingmangImageTomlVariant,
): boolean {
  if (parsed.mcp_servers !== undefined && !isRecord(parsed.mcp_servers)) return false
  const servers = isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {}
  const existing = servers[XINGMANG_IMAGE_MCP_NAME]
  if (existing !== undefined && !isManagedXingmangImageMcpEntry(existing)) return false
  const next = isRecord(existing) ? repointedEntry(existing, invocation) : freshTomlEntry(invocation, variant)
  if (sameValue(existing, next)) return false
  servers[XINGMANG_IMAGE_MCP_NAME] = next
  parsed.mcp_servers = servers
  return true
}

/** Claude Code 的 ~/.claude.json 与 Gemini CLI 的 settings.json 都用 mcpServers。返回是否改动。 */
export function applyXingmangImageMcpToJson(
  parsed: Record<string, unknown>,
  invocation: XingmangImageMcpInvocation,
  variant: XingmangImageJsonVariant,
): boolean {
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) return false
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {}
  const existing = servers[XINGMANG_IMAGE_MCP_NAME]
  if (existing !== undefined && !isManagedXingmangImageMcpEntry(existing)) return false
  const next = isRecord(existing) ? repointedEntry(existing, invocation) : freshJsonEntry(invocation, variant)
  // 起的是本地脚本，Claude Code 的 type 被改成别的连接方式就起不来了，和 command 一样每次对齐。
  if (variant === 'claude') next.type = 'stdio'
  if (sameValue(existing, next)) return false
  servers[XINGMANG_IMAGE_MCP_NAME] = next
  parsed.mcpServers = servers
  return true
}

/**
 * Claude Code 每次调 MCP 工具都会问一次，除非 permissions.allow 里有它。只加这一个
 * 工具名；用户把它写进 deny 或 ask 的，一律不动。
 */
export function applyXingmangImagePermissionToClaudeSettings(parsed: Record<string, unknown>): boolean {
  if (parsed.permissions !== undefined && !isRecord(parsed.permissions)) return false
  const permissions = isRecord(parsed.permissions) ? parsed.permissions : {}
  for (const key of ['deny', 'ask']) {
    const list = permissions[key]
    if (Array.isArray(list) && list.some((entry) => typeof entry === 'string' && entry.startsWith(`mcp__${XINGMANG_IMAGE_MCP_NAME}`))) {
      return false
    }
  }
  if (permissions.allow !== undefined && !Array.isArray(permissions.allow)) return false
  const allow = Array.isArray(permissions.allow) ? permissions.allow : []
  if (allow.includes(XINGMANG_IMAGE_CLAUDE_PERMISSION)) return false
  permissions.allow = [...allow, XINGMANG_IMAGE_CLAUDE_PERMISSION]
  parsed.permissions = permissions
  return true
}
