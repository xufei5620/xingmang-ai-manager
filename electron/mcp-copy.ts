// 外接工具页「也装到别的工具」（同类对比 备选 5）：把一个工具里已经配好的连接原样读出来，交给别的工具的添加那条路。
// 连接里的环境变量、请求头多半是密钥，界面只拿得到名字（列表不回值），所以读和转交都在主进程里做，值不过 IPC（I3）。
// 只认两家「我的（全局）」那份：Claude Code 的 ~/.claude.json、Codex 的 config.toml。项目里的连接常跟着仓库走，
// 搬进别的工具的项目配置等于把密钥写进仓库文件，不给搬；Grok 的连接列表不带环境变量和请求头，读不全，也不给搬。
import { isRecord } from './input-guards'
import { mcpHttpHeaderEntries } from './mcp-http-headers'
import type { ProviderMcpInstallConfiguration } from './provider-extensions'

export type McpCopySource = 'claude' | 'codex'

const MAX_ARGUMENTS = 256
const MAX_TEXT = 4_096
const MAX_ENV = 128

/**
 * 两家各自写法里能原样搬到别的工具的那几项。别的（Codex 的 bearer_token_env_var、env_vars、cwd、超时、工具白名单，
 * Claude Code 的 oauth、headersHelper 这类）别的工具没有同样的写法，搬过去会悄悄少一截，所以碰到就不搬、说清楚。
 */
const carriedKeys: Readonly<Record<McpCopySource, readonly string[]>> = {
  claude: ['type', 'command', 'args', 'env', 'url', 'headers'],
  codex: ['command', 'args', 'env', 'url', 'http_headers', 'enabled'],
}

function malformed(): Error {
  return new Error('这条连接的设置格式不对，星芒搬不过去，请在要装的工具里手动添加。')
}

function textField(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT || value.includes('\0')) throw malformed()
  return value
}

function argumentList(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) throw malformed()
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length > MAX_TEXT || entry.includes('\0')) throw malformed()
    return entry
  })
}

function environment(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw malformed()
  const entries = Object.entries(value)
  if (entries.length > MAX_ENV) throw malformed()
  return Object.fromEntries(entries.map(([name, entry]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof entry !== 'string' || entry.length > MAX_TEXT || entry.includes('\0')) throw malformed()
    return [name, entry]
  }))
}

function headers(value: unknown): Record<string, string> | undefined {
  let entries: Array<[string, string]>
  try {
    entries = mcpHttpHeaderEntries(value)
  } catch {
    throw malformed()
  }
  return entries.length ? Object.fromEntries(entries) : undefined
}

/** Claude Code 会替连接展开 ${变量}，别的工具照字面用，搬过去就是一串错的值。 */
function usesClaudeExpansion(config: ProviderMcpInstallConfiguration): boolean {
  const values = config.type === 'stdio'
    ? [config.command, ...(config.args ?? []), ...Object.values(config.env ?? {})]
    : [config.url, ...Object.values(config.headers ?? {})]
  return values.some((value) => value.includes('${'))
}

function remoteConfig(source: McpCopySource, entry: Record<string, unknown>): ProviderMcpInstallConfiguration {
  if (entry.command !== undefined || entry.args !== undefined || entry.env !== undefined) throw malformed()
  const carried = headers(source === 'claude' ? entry.headers : entry.http_headers)
  return { type: 'http', url: textField(entry.url), ...(carried ? { headers: carried } : {}) }
}

function localConfig(entry: Record<string, unknown>): ProviderMcpInstallConfiguration {
  if (entry.url !== undefined || entry.headers !== undefined || entry.http_headers !== undefined) throw malformed()
  return { type: 'stdio', command: textField(entry.command), args: argumentList(entry.args), env: environment(entry.env) }
}

/**
 * 纯函数：一条连接在来源工具配置里原样写的内容 → 别的工具添加那条路收的样子。entry 是 undefined（没有这一条）、
 * 带着搬不过去的设置、格式不对时抛中文原因。搬出来的值照样还要过各工具添加时的那道检查（I1、I5）。
 */
export function mcpCopyConfig(source: McpCopySource, entry: unknown): ProviderMcpInstallConfiguration {
  if (entry === undefined) throw new Error('没有找到这个连接，请刷新列表后再试。')
  if (!isRecord(entry)) throw malformed()
  const uncarried = Object.keys(entry).filter((key) => !carriedKeys[source].includes(key))
  if (source === 'claude' && entry.type !== undefined && entry.type !== 'stdio' && entry.type !== 'http') uncarried.unshift(`type = ${String(entry.type)}`)
  if (uncarried.length) {
    throw new Error(`这条连接用了星芒搬不过去的设置（${uncarried.join('、')}），请在要装的工具里手动添加。`)
  }
  const remote = source === 'claude' ? entry.type === 'http' : entry.command === undefined
  const config = remote ? remoteConfig(source, entry) : localConfig(entry)
  if (source === 'claude' && usesClaudeExpansion(config)) {
    throw new Error('这条连接里用了 ${…} 这种要 Claude Code 自己展开的写法，别的工具不认，请在要装的工具里手动添加。')
  }
  return config
}
