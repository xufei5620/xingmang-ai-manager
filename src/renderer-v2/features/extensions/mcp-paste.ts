// 外接工具「自定义连接」里的粘贴框：把提供方给的一整段配置认成「本地程序 / 网络服务」两种，替用户填好下面几项。
// 这里只认、只填，不往下写：填好的表单照旧走 submitMcpInstall，命令、参数和请求头到了主进程还要再过一遍校验（I1、I5）。
// 认得的写法照 CC Switch 4.0 那一套：`mcpServers`（Claude Desktop、Cursor、Claude Code 的 .mcp.json）、VS Code 的
// `servers`、OpenCode 的 `mcp`、单独一条、`"名字": { … }`、Codex / Grok 的 `[mcp_servers.名字]`，再加上一行启动命令、
// 一个地址和各家文档里常见的 `claude mcp add …` 那一行。
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { isRecord } from '../../../../electron/input-guards'
import { mcpHttpHeaderNamePattern } from '../../../../electron/mcp-http-headers'

export type PastedMcpConfig =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string>; bearerTokenEnvVar?: string }

export interface PastedMcpServer {
  /** 整理成「字母、数字和 - _」的名字；认不出名字时是空串，由用户自己填。 */
  name: string
  config: PastedMcpConfig | null
  /** 这一条加不了的原因；能加时为 null。 */
  problem: string | null
}

export type McpPasteResult =
  | { status: 'empty' }
  | { status: 'failed'; problem: string }
  | { status: 'ok'; servers: PastedMcpServer[] }

export interface McpPasteNotice {
  tone: 'ok' | 'warn'
  title: string
  body: string
}

const unrecognized = '请把提供方说明里的那一整段原样复制过来：以 { 开头、以 } 结尾的那段，或者一行启动命令、一个 https:// 开头的地址都可以。'
const noServer = '这段里没找到启动命令或服务地址，可能少复制了一部分，对照提供方说明再看看。'
const missing = '这一段里没找到启动命令或服务地址。'
// 三家都认的是 streamable HTTP；Codex 根本不认 SSE，所以这里不替他悄悄换成 http，免得装上了却连不上。
const sseProblem = '它用的是老式的网络连接方式（SSE），这里加不了。提供方一般还会给一个以 /mcp 结尾的地址，换那一段粘贴就行。'
const transportProblem = '它用的连接方式这里加不了，换提供方给的其他写法试试。'
const urlProblem = '服务地址要以 http:// 或 https:// 开头'

function formatProblem(field: string): string {
  return `这一段里的${field}格式不对，没法自动填，照提供方说明手动填下面几项吧。`
}

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/
const serverKeys = ['command', 'url', 'serverUrl', 'httpUrl']
const containerKeys = ['mcpServers', 'servers', 'context_servers', 'mcp_servers']

// 一行命令要以这些开头（或者是一个程序的路径）才算启动命令，免得随手贴的一句话也被当成程序。
const commandRunners = new Set([
  'npx', 'pnpx', 'bunx', 'uvx', 'uv', 'pipx', 'python', 'python3', 'py', 'node', 'deno', 'bun',
  'npm', 'pnpm', 'yarn', 'docker', 'podman', 'java', 'dotnet', 'go',
])
const cliNames = new Set(['claude', 'codex', 'grok', 'gemini'])

function executableName(command: string): string {
  return (command.split(/[\\/]/).pop() ?? '').replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

/** 起名只能用字母、数字和 - _，最多 40 位（customMcpProblem 同一条规矩）；别的字符换成 -。 */
export function mcpNameFrom(raw: string): string {
  return raw
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

function suggestedName(config: PastedMcpConfig): string {
  if (config.type === 'http') {
    try {
      const labels = new URL(config.url).hostname.split('.').filter((label) => !['mcp', 'api', 'www'].includes(label))
      return mcpNameFrom(labels[0] ?? '')
    } catch {
      return ''
    }
  }
  // 包名一般是最后一个不像开关、不像路径的参数：npx -y @amap/amap-maps-mcp-server、docker run … ghcr.io/github/github-mcp-server。
  const packages = config.args.filter(
    (arg) => !arg.startsWith('-') && !arg.includes('=') && !/^[A-Za-z]:|^[\\/.~]|\\|^https?:/i.test(arg),
  )
  const last = (packages[packages.length - 1] ?? '').split('/').pop() ?? ''
  // 去掉版本号和镜像标签：server-filesystem@2026.8.31、github-mcp-server:latest。
  const fromPackage = mcpNameFrom(last.replace(/(.)[@:][^@:]*$/, '$1'))
  if (fromPackage) return fromPackage
  const program = executableName(config.command)
  return commandRunners.has(program) ? '' : mcpNameFrom(program)
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const result = value.map(scalarText)
  return result.every((entry): entry is string => entry !== null) ? result : null
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null
  const result: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) {
    const text = scalarText(entry)
    if (text === null) return null
    result[name] = text
  }
  return result
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

type TransportKind = 'stdio' | 'http' | 'sse' | 'other'

function declaredTransport(value: Record<string, unknown>): TransportKind | null {
  const raw = [value.type, value.transport, value.transportType].find((entry) => typeof entry === 'string')
  if (typeof raw !== 'string') return null
  const key = raw.toLowerCase().replace(/[^a-z]/g, '')
  if (key === 'stdio' || key === 'local') return 'stdio'
  if (['http', 'https', 'streamablehttp', 'streamable', 'remote'].includes(key)) return 'http'
  return key === 'sse' ? 'sse' : 'other'
}

function sseAddress(url: string): boolean {
  try {
    return /\/sse\/?$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function failedServer(name: string, problem: string): PastedMcpServer {
  return { name: mcpNameFrom(name), config: null, problem }
}

function namedServer(name: string, config: PastedMcpConfig): PastedMcpServer {
  return { name: mcpNameFrom(name) || suggestedName(config), config, problem: null }
}

function readStdio(name: string, value: Record<string, unknown>): PastedMcpServer {
  // Zed 的老写法把整条命令放在 command 对象里：{ path, args, env }。
  const nested = isRecord(value.command) ? value.command : null
  const rawCommand = nested ? nested.path : value.command
  let command = ''
  let args: string[] = []
  if (Array.isArray(rawCommand)) {
    // OpenCode 把命令和参数写成一个数组。
    const parts = stringList(rawCommand)
    if (!parts) return failedServer(name, formatProblem('启动命令'))
    command = parts[0] ?? ''
    args = parts.slice(1)
  } else if (typeof rawCommand === 'string') {
    command = rawCommand.trim()
  }
  const extra = stringList(value.args ?? nested?.args ?? [])
  if (!extra) return failedServer(name, formatProblem('附加参数'))
  args = [...args, ...extra]
  const env = stringRecord(value.env ?? value.environment ?? nested?.env ?? {})
  if (!env || !Object.keys(env).every((key) => envNamePattern.test(key))) return failedServer(name, formatProblem('附加设置'))
  if (!command.trim()) return failedServer(name, missing)
  // `"command": "npx -y 包名"` 这种把整行塞进 command 的：几家 CLI 起进程都不经过命令行解释器，原样交下去会找不到程序。
  // 只拆以 npx、uvx 这类开头的，C:\Program Files\… 这种带空格的路径本来就是一个程序。
  if (!args.length && /\s/.test(command)) {
    const tokens = splitCommandLine(command)
    if (tokens && tokens.length > 1 && commandRunners.has(executableName(tokens[0] ?? ''))) {
      command = tokens[0] ?? ''
      args = tokens.slice(1)
    }
  }
  return namedServer(name, { type: 'stdio', command, args, env })
}

function readHttp(name: string, value: Record<string, unknown>): PastedMcpServer {
  const url = firstText(value.url, value.serverUrl, value.httpUrl)
  if (!url) return failedServer(name, missing)
  if (!/^https?:\/\/\S+$/i.test(url)) return failedServer(name, urlProblem)
  const requestInit = isRecord(value.requestInit) ? value.requestInit : null
  const headers = stringRecord(value.headers ?? value.http_headers ?? requestInit?.headers ?? {})
  // 值可以先空着（说明里常留空让人填），提交的时候再拦；名字不合格的就没法替他写进去。
  if (!headers || !Object.entries(headers).every(([key, entry]) => mcpHttpHeaderNamePattern.test(key) && !/[\r\n\0]/.test(entry))) {
    return failedServer(name, formatProblem('请求头'))
  }
  const trimmed = Object.fromEntries(Object.entries(headers).map(([key, entry]) => [key, entry.trim()]))
  const bearer = firstText(value.bearer_token_env_var)
  return namedServer(name, { type: 'http', url, headers: trimmed, ...(bearer ? { bearerTokenEnvVar: bearer } : {}) })
}

function readServer(name: string, value: unknown): PastedMcpServer {
  if (!isRecord(value)) return failedServer(name, missing)
  const declared = declaredTransport(value)
  const url = firstText(value.url, value.serverUrl, value.httpUrl)
  const kind = declared
    ?? (value.command !== undefined
      ? 'stdio'
      : url === null
        ? null
        : value.httpUrl === undefined && sseAddress(url) ? 'sse' : 'http')
  if (kind === 'stdio') return readStdio(name, value)
  if (kind === 'http') return readHttp(name, value)
  return failedServer(name, kind === 'sse' ? sseProblem : kind === 'other' ? transportProblem : missing)
}

function looksLikeServer(value: unknown): boolean {
  return isRecord(value) && serverKeys.some((key) => key in value)
}

function serverMap(root: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of containerKeys) {
    const value = root[key]
    if (isRecord(value)) return value
  }
  // VS Code 老的 settings.json 是 "mcp": { "servers": … }，OpenCode 是 "mcp": { 名字: … }。
  if (isRecord(root.mcp)) return isRecord(root.mcp.servers) ? root.mcp.servers : root.mcp
  return null
}

function serversFromObject(root: Record<string, unknown>): PastedMcpServer[] {
  const map = serverMap(root)
  if (map) return Object.entries(map).map(([name, value]) => readServer(name, value))
  if (looksLikeServer(root)) return [readServer(typeof root.name === 'string' ? root.name : '', root)]
  return Object.entries(root)
    .filter(([, value]) => looksLikeServer(value))
    .map(([name, value]) => readServer(name, value))
}

function parseJsonText(text: string): unknown {
  // 微信、网页里复制出来的常带中文引号和不换行空格；先照原样认，认不出再换掉它们试一次。
  const normalized = text.replace(/[\u201C\u201D\u201E\uFF02]/g, '"').replace(/[\u00A0\u3000]/g, ' ')
  const candidates = [text, normalized]
  // 只复制了中间一截：`"名字": { … }` 或 `"mcpServers": { … }`，外面补一层括号再试。
  for (const candidate of [text, normalized]) if (candidate.startsWith('"')) candidates.push(`{${candidate}}`)
  for (const candidate of candidates) {
    const errors: ParseError[] = []
    const value: unknown = parseJsonc(candidate, errors, { allowTrailingComma: true })
    if (!errors.length && value !== undefined) return value
  }
  return undefined
}

/**
 * 按空白切开一行命令，单双引号里的空白不切。双引号里只认 \" 这一种转义：Windows 路径里的 \ 要原样留着。
 * 引号没配对时回 null。
 */
export function splitCommandLine(line: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null
  let started = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index)
    if (quote) {
      if (char === quote) quote = null
      else if (quote === '"' && char === '\\' && line.charAt(index + 1) === '"') {
        current += '"'
        index += 1
      } else current += char
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) tokens.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (quote) return null
  if (started) tokens.push(current)
  return tokens
}

const valueFlags = new Map<string, 'transport' | 'env' | 'header' | 'url' | 'bearer' | null>([
  ['-t', 'transport'], ['--transport', 'transport'],
  ['-e', 'env'], ['--env', 'env'],
  ['-H', 'header'], ['--header', 'header'],
  ['--url', 'url'],
  ['--bearer-token-env-var', 'bearer'],
  // 下面这些带一个值，但这里用不上（装到哪一层、OAuth 登录、工具筛选），跳过它们的值。
  ['-s', null], ['--scope', null], ['--client-id', null], ['--callback-port', null],
  ['--oauth-client-id', null], ['--oauth-client-secret', null], ['--oauth-resource', null],
  ['--oauth-client-registration', null], ['-c', null], ['--config', null], ['--enable', null],
  ['--disable', null], ['--description', null], ['--timeout', null], ['--include-tools', null],
  ['--exclude-tools', null],
])
const headerLinePattern = /^([A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*)\s*:(?!\/\/)\s*(.*)$/

/** 各家文档里给的 `claude mcp add …` / `codex mcp add …` / `grok mcp add …` 那一行。不是这种写法回 null。 */
function readMcpAddCommand(tokens: string[]): PastedMcpServer[] | null {
  if (!cliNames.has(executableName(tokens[0] ?? '')) || tokens[1] !== 'mcp') return null
  // `claude mcp add-json 名字 '{ … }'`：后面那段就是单独一条的 JSON。
  if (tokens[2] === 'add-json') {
    const positionals = tokens.slice(3).filter((token) => !token.startsWith('-'))
    const value = parseJsonText(positionals[1] ?? '')
    return isRecord(value) ? [readServer(positionals[0] ?? '', value)] : null
  }
  if (tokens[2] !== 'add') return null
  const positionals: string[] = []
  const env: Record<string, string> = {}
  const headers: Record<string, string> = {}
  let transport = ''
  let url = ''
  let bearer = ''
  let rest: string[] = []
  // Claude Code 的 -e、-H 能一次跟好几个值（-e A=1 B=2），接在后面、长得像的也算进去。
  let variadic: 'env' | 'header' | null = null
  for (let index = 3; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (token === '--') {
      rest = tokens.slice(index + 1)
      break
    }
    const equals = token.startsWith('--') ? token.indexOf('=') : -1
    const flag = equals > 0 ? token.slice(0, equals) : token
    if (valueFlags.has(flag)) {
      const role = valueFlags.get(flag)
      const value = equals > 0 ? token.slice(equals + 1) : tokens[++index]
      if (value === undefined) return null
      variadic = role === 'env' || role === 'header' ? role : null
      if (role === 'transport') transport = value.toLowerCase()
      else if (role === 'url') url = value
      else if (role === 'bearer') bearer = value
      else if (role === 'env' && !addEnvAssignment(env, value)) return null
      else if (role === 'header' && !addHeaderLine(headers, value)) return null
      continue
    }
    if (variadic === 'env' && addEnvAssignment(env, token)) continue
    if (variadic === 'header' && headerLinePattern.test(token) && addHeaderLine(headers, token)) continue
    variadic = null
    // 认不得的开关（--trust、--client-secret 这类）跳过；名字和命令之后的照原样当参数。
    if (token.startsWith('-') && positionals.length < 2) continue
    positionals.push(token)
  }
  const [rawName = '', ...others] = positionals
  const trailing = [...others, ...rest]
  if (transport === 'sse') return [failedServer(rawName, sseProblem)]
  if (transport && transport !== 'stdio' && transport !== 'http') return [failedServer(rawName, transportProblem)]
  const address = url || (transport !== 'stdio' && /^https?:\/\//i.test(trailing[0] ?? '') ? trailing[0] ?? '' : '')
  if (address) {
    return [namedServer(rawName, { type: 'http', url: address, headers, ...(bearer ? { bearerTokenEnvVar: bearer } : {}) })]
  }
  const [command = '', ...args] = trailing
  if (!command) return [failedServer(rawName, missing)]
  return [namedServer(rawName, { type: 'stdio', command, args, env })]
}

function addEnvAssignment(env: Record<string, string>, text: string): boolean {
  const equals = text.indexOf('=')
  const name = equals > 0 ? text.slice(0, equals) : ''
  if (!envNamePattern.test(name)) return false
  env[name] = text.slice(equals + 1)
  return true
}

function addHeaderLine(headers: Record<string, string>, text: string): boolean {
  const match = headerLinePattern.exec(text.trim())
  if (!match) return false
  headers[match[1] ?? ''] = (match[2] ?? '').trim()
  return true
}

function readCommandLine(tokens: string[]): PastedMcpServer[] | null {
  const env: Record<string, string> = {}
  let index = 0
  // `API_KEY=xxx npx …` 这种把设置写在命令前面的。
  while (index < tokens.length - 1 && addEnvAssignment(env, tokens[index] ?? '')) index += 1
  const [command = '', ...args] = tokens.slice(index)
  if (!commandRunners.has(executableName(command)) && !/[\\/]/.test(command)) return null
  return [namedServer('', { type: 'stdio', command, args, env })]
}

function readCommandText(text: string): PastedMcpServer[] | null {
  // 文档里拆成几行的长命令：行尾的 \（bash）、^（cmd）、`（PowerShell）是接着下一行的意思。
  const joined = text.replace(/[\\^`][ \t]*\r?\n/g, ' ')
  const lines = joined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length !== 1) return null
  const tokens = splitCommandLine((lines[0] ?? '').replace(/^(?:\$|>|PS [^>]*>)\s+/, ''))
  if (!tokens?.length) return null
  if (tokens.length === 1 && /^https?:\/\/\S+$/i.test(tokens[0] ?? '')) {
    const url = tokens[0] ?? ''
    return [sseAddress(url) ? failedServer('', sseProblem) : namedServer('', { type: 'http', url, headers: {} })]
  }
  return readMcpAddCommand(tokens) ?? readCommandLine(tokens)
}

export function parseMcpPaste(input: string): McpPasteResult {
  const text = input.replace(/^\uFEFF/, '').trim()
  if (!text) return { status: 'empty' }
  let servers: PastedMcpServer[] | null
  if (/^\s*\[\s*["']?mcp_servers["']?\s*\./m.test(text)) {
    const root = parseTomlSubset(text)
    servers = root && isRecord(root.mcp_servers)
      ? Object.entries(root.mcp_servers).map(([name, value]) => readServer(name, value))
      : null
  } else if (text.startsWith('{') || text.startsWith('"') || text.startsWith('\u201C')) {
    const value = parseJsonText(text)
    servers = isRecord(value) ? serversFromObject(value) : null
  } else {
    servers = readCommandText(text)
  }
  if (!servers) return { status: 'failed', problem: unrecognized }
  if (!servers.length) return { status: 'failed', problem: noServer }
  return { status: 'ok', servers }
}

// 说明里留给人替换的示例文字：<YOUR_TOKEN>、${input:token}、YOUR_API_KEY、xxx、「你的密钥」、/path/to/…。
const placeholderPatterns = [
  /<[^<>\s][^<>]*>/,
  /\$\{[^}]*\}/,
  /your[\s_-]*[a-z_-]*(?:key|token|secret|password|pat|id)/i,
  /^(?:\*{3,}|\.{3,}|…+)$/,
  /(?:^|[^a-z])x{3,}(?:$|[^a-z])/i,
  /\/path\/to\//i,
  /你的|您的|您在|替换|填入|填写|在此|此处|申请的/,
]

function isPlaceholder(value: string): boolean {
  const text = value.trim()
  return placeholderPatterns.some((pattern) => pattern.test(text))
}

/** 看起来还是示例文字、要换成自己的那几项，按「设置名、请求头名、附加参数、服务地址」说。空着的设置和请求头也算。 */
export function mcpPastePlaceholders(config: PastedMcpConfig): string[] {
  const found: string[] = []
  if (config.type === 'stdio') {
    for (const [name, value] of Object.entries(config.env)) if (!value.trim() || isPlaceholder(value)) found.push(name)
    if (config.args.some(isPlaceholder)) found.push('附加参数')
    return found
  }
  if (isPlaceholder(decodeURIComponentSafe(config.url))) found.push('服务地址')
  for (const [name, value] of Object.entries(config.headers)) if (!value || isPlaceholder(value)) found.push(name)
  return found
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 粘贴框下面那一条提示。没粘贴时不出。 */
export function mcpPasteNotice(result: McpPasteResult, choice: number): McpPasteNotice | null {
  if (result.status === 'empty') return null
  if (result.status === 'failed') return { tone: 'warn', title: '没认出这段配置', body: result.problem }
  const server = result.servers[choice] ?? result.servers[0]
  if (!server) return null
  const named = server.name ? `「${server.name}」` : ''
  if (!server.config) return { tone: 'warn', title: `${named || '这一段'}加不了`, body: server.problem ?? missing }
  const placeholders = mcpPastePlaceholders(server.config)
  const sentences = [
    placeholders.length
      ? `下面几项已经替你填好。${placeholders.join('、')} 看起来还是说明里的示例文字，换成你自己的再点「添加」。`
      : '下面几项已经替你填好，看一眼再点「添加」。',
  ]
  if (result.servers.length > 1) sentences.push('一次加一个，加好以后再粘贴同一段，选下一个。')
  return {
    tone: placeholders.length ? 'warn' : 'ok',
    title: `认出来了：${server.config.type === 'stdio' ? '本地程序' : '网络服务'}${named}`,
    body: sentences.join(''),
  }
}

/** 多条时下拉里每一项的字；没名字的按「第几个」叫。 */
export function mcpPasteChoiceLabel(server: PastedMcpServer, index: number): string {
  return server.name || `第 ${index + 1} 个`
}

/** 请求头放进表单时一行一个「名称: 值」，和提供方说明、Claude Code 的 --header 一个写法。 */
export function mcpHeaderLines(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\n')
}

// ---- Codex / Grok 的 [mcp_servers.名字] ----
// 只认外接工具片段用得到的那一小块 TOML：表头、键值、字符串、数字、布尔、数组和单行内联表。多行字符串、
// [[数组表]]、日期这些片段里不会出现，遇到就整段当认不出，不猜。

interface TomlCursor {
  text: string
  index: number
}

function skipSpaces(cursor: TomlCursor, newlines: boolean): void {
  while (cursor.index < cursor.text.length) {
    const char = cursor.text.charAt(cursor.index)
    if (char === ' ' || char === '\t' || (newlines && (char === '\n' || char === '\r'))) cursor.index += 1
    else if (char === '#') {
      while (cursor.index < cursor.text.length && cursor.text.charAt(cursor.index) !== '\n') cursor.index += 1
    } else break
  }
}

function readTomlString(cursor: TomlCursor): string | null {
  const quote = cursor.text.charAt(cursor.index)
  if (cursor.text.startsWith(quote.repeat(3), cursor.index)) return null
  cursor.index += 1
  let result = ''
  while (cursor.index < cursor.text.length) {
    const char = cursor.text.charAt(cursor.index)
    cursor.index += 1
    if (char === quote) return result
    if (char === '\n') return null
    if (quote === '"' && char === '\\') {
      const escape = cursor.text.charAt(cursor.index)
      cursor.index += 1
      const simple: Record<string, string> = { '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }
      if (escape in simple) result += simple[escape]
      else if (escape === 'u' || escape === 'U') {
        const length = escape === 'u' ? 4 : 8
        const code = Number.parseInt(cursor.text.slice(cursor.index, cursor.index + length), 16)
        if (!Number.isFinite(code)) return null
        result += String.fromCodePoint(code)
        cursor.index += length
      } else return null
    } else result += char
  }
  return null
}

function readTomlKeyPath(cursor: TomlCursor): string[] | null {
  const keys: string[] = []
  for (;;) {
    skipSpaces(cursor, false)
    const char = cursor.text.charAt(cursor.index)
    let key: string | null
    if (char === '"' || char === '\'') key = readTomlString(cursor)
    else {
      const match = /^[A-Za-z0-9_-]+/.exec(cursor.text.slice(cursor.index))
      key = match ? match[0] : null
      if (match) cursor.index += match[0].length
    }
    if (key === null) return null
    keys.push(key)
    skipSpaces(cursor, false)
    if (cursor.text.charAt(cursor.index) !== '.') return keys
    cursor.index += 1
  }
}

function readTomlValue(cursor: TomlCursor): unknown {
  skipSpaces(cursor, false)
  const char = cursor.text.charAt(cursor.index)
  if (char === '"' || char === '\'') return readTomlString(cursor) ?? undefined
  if (char === '[') {
    cursor.index += 1
    const items: unknown[] = []
    for (;;) {
      skipSpaces(cursor, true)
      if (cursor.text.charAt(cursor.index) === ']') {
        cursor.index += 1
        return items
      }
      const item = readTomlValue(cursor)
      if (item === undefined) return undefined
      items.push(item)
      skipSpaces(cursor, true)
      const next = cursor.text.charAt(cursor.index)
      cursor.index += 1
      if (next === ']') return items
      if (next !== ',') return undefined
    }
  }
  if (char === '{') {
    cursor.index += 1
    const table: Record<string, unknown> = {}
    for (;;) {
      skipSpaces(cursor, true)
      if (cursor.text.charAt(cursor.index) === '}') {
        cursor.index += 1
        return table
      }
      const keys = readTomlKeyPath(cursor)
      if (!keys || cursor.text.charAt(cursor.index) !== '=') return undefined
      cursor.index += 1
      const value = readTomlValue(cursor)
      if (value === undefined || !assignToml(table, keys, value)) return undefined
      skipSpaces(cursor, true)
      const next = cursor.text.charAt(cursor.index)
      cursor.index += 1
      if (next === '}') return table
      if (next !== ',') return undefined
    }
  }
  const match = /^[^\s,\]}#]+/.exec(cursor.text.slice(cursor.index))
  if (!match) return undefined
  cursor.index += match[0].length
  if (match[0] === 'true' || match[0] === 'false') return match[0] === 'true'
  const number = Number(match[0].replace(/_/g, ''))
  return /^[+-]?[0-9_.eE+-]+$/.test(match[0]) && Number.isFinite(number) ? number : undefined
}

function tomlTable(root: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | null {
  let table = root
  for (const key of keys) {
    const existing = table[key]
    if (existing === undefined) table[key] = {}
    else if (!isRecord(existing)) return null
    table = table[key] as Record<string, unknown>
  }
  return table
}

function assignToml(table: Record<string, unknown>, keys: readonly string[], value: unknown): boolean {
  const parent = tomlTable(table, keys.slice(0, -1))
  const last = keys[keys.length - 1]
  if (!parent || last === undefined || last in parent) return false
  parent[last] = value
  return true
}

function parseTomlSubset(text: string): Record<string, unknown> | null {
  const root: Record<string, unknown> = {}
  let table: Record<string, unknown> | null = root
  const cursor: TomlCursor = { text, index: 0 }
  for (;;) {
    skipSpaces(cursor, true)
    if (cursor.index >= text.length) return root
    if (text.charAt(cursor.index) === '[') {
      if (text.charAt(cursor.index + 1) === '[') return null
      cursor.index += 1
      const keys = readTomlKeyPath(cursor)
      if (!keys || text.charAt(cursor.index) !== ']') return null
      cursor.index += 1
      table = tomlTable(root, keys)
    } else {
      const keys = readTomlKeyPath(cursor)
      if (!keys || text.charAt(cursor.index) !== '=') return null
      cursor.index += 1
      const value = readTomlValue(cursor)
      if (value === undefined || !table || !assignToml(table, keys, value)) return null
    }
    if (!table) return null
    skipSpaces(cursor, false)
    const end = text.charAt(cursor.index)
    if (end && end !== '\n' && end !== '\r') return null
  }
}
