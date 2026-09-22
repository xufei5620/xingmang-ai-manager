import fs from 'node:fs'
import path from 'node:path'
import * as TOML from '@iarna/toml'
import { readBoundedUtf8FileSync } from './bounded-file'
import type { ProviderId } from './catalog'

/**
 * 本软件只写用户级配置（~/.claude/settings.json、~/.codex、~/.gemini …），但几家
 * CLI 还会读项目文件夹里、以及公司统一下发的设置，而且那些排在用户级前面。于是
 * 首页写着「已连接」，请求其实没经过当前账号：余额不动、用量为 0。
 *
 * 这个模块只看不改：找出「会盖过当前账号的服务地址或密钥」的那几份文件与键名，
 * 交给打开流程提醒一句、交给检查页列一项。那些文件是用户或公司的，绝不去动它们；
 * 读取一律走 bounded 读法、不跟符号链接（I8）；结果里只有路径与键名，值不出本模块
 * （I13）。
 *
 * 每一条规则都是 2026-09-22 在沙箱里真跑过四家 CLI 得出的（Claude Code 2.1.277、
 * Codex 0.155.1、Gemini CLI 0.60.0、Grok 1.0.40，本地假接口看请求落到哪）：
 *
 * - Claude Code：工作目录下 .claude/settings.json 与 settings.local.json 的 env
 *   会盖过用户级设置，连进程环境变量也盖得过；不往上层目录找。管理策略
 *   （managed-settings.json 与 managed-settings.d/）压过一切。
 * - Codex：项目里的 .codex/config.toml 改不了服务地址（model_providers、
 *   openai_base_url 都被它自己忽略），但 forced_login_method = "chatgpt" 会让它
 *   当场删掉 auth.json，cli_auth_credentials_store = "keyring" 会让它找不到密钥。
 *   项目配置从工作目录一直读到 git 根。工作目录里的 .env 它不读。
 * - Gemini CLI：项目里 .gemini/settings.json 换了登录方式，就算本软件注入了
 *   环境变量也照样不用当前账号；工作目录往上找到的第一个 .env 会整份挡住
 *   ~/.gemini/.env，但本软件打开时注入的环境变量优先，所以只影响用户自己开终端。
 * - Grok：项目里的 .grok/config.toml 只认 MCP / 插件 / 权限几张表，地址与密钥
 *   盖不过，这里不查。
 */

export type WorkspaceOverrideScope = 'project' | 'managed'

/**
 * blocking：照这份设置，工具一定不用当前账号（换了地址、换了密钥、换了登录方式）。
 * possible：可能不用（多带了一把密钥、设置读不了没法确认）。
 */
export type WorkspaceOverrideSeverity = 'blocking' | 'possible'

export interface WorkspaceConfigOverride {
  provider: ProviderId
  scope: WorkspaceOverrideScope
  /** 绝对路径；上屏与写日志前要经 displayOverrideFile 脱敏。 */
  file: string
  /** 只有键名，从来不带值。 */
  keys: string[]
  severity: WorkspaceOverrideSeverity
  /** 从本软件打开时不受影响，只在用户自己开终端时生效（Gemini 的 .env）。 */
  launchUnaffected?: boolean
  /** 文件在但读不了（符号链接、过大、在读的时候被改）。 */
  unreadable?: boolean
}

/** 当前账号写进这个工具的东西。只在主进程里比对，不进结果、不进日志。 */
export interface CurrentProviderAccount {
  baseUrl: string
  apiKey: string
  /** Gemini 用户级设置里的登录方式。 */
  authType?: string
  /** Codex auth.json 的 auth_mode。 */
  codexAuthMode?: 'apikey' | 'chatgpt' | null
}

export interface WorkspaceOverrideContext {
  platform: NodeJS.Platform
  home: string
  codexHome: string
  current: CurrentProviderAccount
  /** 只给测试用：管理策略所在目录，缺省按平台取 Claude Code 自己认的位置。 */
  claudeManagedDirectory?: string
}

const MAX_SETTINGS_BYTES = 256 * 1024
const MAX_MANAGED_DROP_INS = 32
// Codex 往上找到 git 根为止；Gemini 找 .env 一直到盘根。层数再深也不该超过这个，
// 超了就当没找到，免得一个诡异的挂载点让打开卡住。
const MAX_WALK_DEPTH = 64

const claudeBaseUrlKeys = ['ANTHROPIC_BASE_URL'] as const
// 这几个开关打开后 Claude Code 直接改走云厂商，服务地址与密钥都不再是当前账号的。
// 名字取自 2.1.277 可执行文件里的字符串，没见过的一律不猜。
const claudePlatformSwitches = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

function truthySwitch(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const text = nonEmptyString(value).toLowerCase()
  return text !== '' && text !== '0' && text !== 'false' && text !== 'no' && text !== 'off'
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

interface KeyFinding {
  key: string
  severity: WorkspaceOverrideSeverity
}

/**
 * Claude Code 设置文件（项目级或管理策略）里会换掉当前账号的键。写着与当前账号
 * 相同的地址或密钥不算：那是用户自己抄了一份，请求照样到当前账号。
 * 解析不了的 JSON 不算覆盖：Claude Code 自己也会跳过它。
 */
export function claudeSettingsOverrideKeys(text: string, current: CurrentProviderAccount): KeyFinding[] {
  const parsed = parseJsonRecord(text)
  if (!parsed) return []
  const findings: KeyFinding[] = []
  const env = isRecord(parsed.env) ? parsed.env : {}
  for (const key of claudeBaseUrlKeys) {
    const value = nonEmptyString(env[key])
    if (value && normalizeUrl(value) !== normalizeUrl(current.baseUrl)) findings.push({ key, severity: 'blocking' })
  }
  const token = nonEmptyString(env.ANTHROPIC_AUTH_TOKEN)
  if (token && token !== current.apiKey) findings.push({ key: 'ANTHROPIC_AUTH_TOKEN', severity: 'blocking' })
  // 实测 ANTHROPIC_API_KEY 与 apiKeyHelper 不换掉 Bearer，而是多带一个 x-api-key
  // 头；中转收到两把密钥认哪把说不准，所以只算「可能」。
  const apiKey = nonEmptyString(env.ANTHROPIC_API_KEY)
  if (apiKey && apiKey !== current.apiKey) findings.push({ key: 'ANTHROPIC_API_KEY', severity: 'possible' })
  for (const key of claudePlatformSwitches) {
    if (key in env && truthySwitch(env[key])) findings.push({ key, severity: 'blocking' })
  }
  if (nonEmptyString(parsed.apiKeyHelper)) findings.push({ key: 'apiKeyHelper', severity: 'possible' })
  return findings
}

/**
 * Codex 项目级 config.toml 里能把当前账号的密钥弄没的两个键。只有在当前账号走
 * 密钥（apikey 模式）时才是问题；用户用 ChatGPT 登录时，要求 ChatGPT 登录正合适。
 */
export function codexProjectOverrideKeys(text: string, current: CurrentProviderAccount): KeyFinding[] {
  if (current.codexAuthMode === 'chatgpt' || !current.apiKey) return []
  let parsed: Record<string, unknown>
  try {
    parsed = TOML.parse(text) as Record<string, unknown>
  } catch {
    return []
  }
  const findings: KeyFinding[] = []
  if (nonEmptyString(parsed.forced_login_method).toLowerCase() === 'chatgpt') {
    findings.push({ key: 'forced_login_method', severity: 'blocking' })
  }
  if (nonEmptyString(parsed.cli_auth_credentials_store).toLowerCase() === 'keyring') {
    findings.push({ key: 'cli_auth_credentials_store', severity: 'blocking' })
  }
  return findings
}

/**
 * Gemini 项目级 settings.json 换了登录方式时，本软件注入的密钥与地址都不再被用上。
 * 老版本的键名是顶层 selectedAuthType，新版本是 security.auth.selectedType。
 */
export function geminiSettingsOverrideKeys(text: string, current: CurrentProviderAccount): KeyFinding[] {
  const parsed = parseJsonRecord(text)
  if (!parsed) return []
  const security = isRecord(parsed.security) ? parsed.security : {}
  const auth = isRecord(security.auth) ? security.auth : {}
  const findings: KeyFinding[] = []
  const selected = nonEmptyString(auth.selectedType)
  if (selected && selected !== (current.authType ?? '')) {
    findings.push({ key: 'security.auth.selectedType', severity: 'blocking' })
  }
  const legacy = nonEmptyString(parsed.selectedAuthType)
  if (legacy && legacy !== (current.authType ?? '')) {
    findings.push({ key: 'selectedAuthType', severity: 'blocking' })
  }
  return findings
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform)
  const a = api.resolve(left)
  const b = api.resolve(right)
  return platform === 'win32' || platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Claude Code 自己认的管理策略目录（2.1.277 可执行文件里的原字面量）。 */
export function claudeManagedSettingsDirectory(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode'
  return '/etc/claude-code'
}

/**
 * 从 start 一直往上到盘根的每一层目录（含 start 自己），最多 MAX_WALK_DEPTH 层。
 */
export function ancestorDirectories(start: string, platform: NodeJS.Platform): string[] {
  const api = pathApi(platform)
  const directories: string[] = []
  let current = api.resolve(start)
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    directories.push(current)
    const parent = api.dirname(current)
    if (parent === current) break
    current = parent
  }
  return directories
}

type ReadOutcome = { state: 'missing' } | { state: 'unreadable' } | { state: 'read'; text: string }

function readSettingsFile(file: string): ReadOutcome {
  try {
    fs.lstatSync(file)
  } catch {
    return { state: 'missing' }
  }
  try {
    return { state: 'read', text: readBoundedUtf8FileSync(file, MAX_SETTINGS_BYTES, '项目设置文件') }
  } catch {
    return { state: 'unreadable' }
  }
}

function entryExists(file: string): boolean {
  try {
    fs.lstatSync(file)
    return true
  } catch {
    return false
  }
}

function inspectFile(
  provider: ProviderId,
  scope: WorkspaceOverrideScope,
  file: string,
  evaluate: (text: string) => KeyFinding[],
): WorkspaceConfigOverride | null {
  const outcome = readSettingsFile(file)
  if (outcome.state === 'missing') return null
  if (outcome.state === 'unreadable') {
    return { provider, scope, file, keys: [], severity: 'possible', unreadable: true }
  }
  const findings = evaluate(outcome.text)
  if (!findings.length) return null
  return {
    provider,
    scope,
    file,
    keys: findings.map((finding) => finding.key),
    severity: findings.some((finding) => finding.severity === 'blocking') ? 'blocking' : 'possible',
  }
}

function inspectClaude(workspace: string, context: WorkspaceOverrideContext): WorkspaceConfigOverride[] {
  const api = pathApi(context.platform)
  const evaluate = (text: string) => claudeSettingsOverrideKeys(text, context.current)
  const results: WorkspaceConfigOverride[] = []
  const managedDirectory = context.claudeManagedDirectory ?? claudeManagedSettingsDirectory(context.platform)
  const managed = inspectFile('claude', 'managed', api.join(managedDirectory, 'managed-settings.json'), evaluate)
  if (managed) results.push(managed)
  const dropInDirectory = api.join(managedDirectory, 'managed-settings.d')
  let dropIns: string[] = []
  try {
    dropIns = fs.readdirSync(dropInDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_MANAGED_DROP_INS)
  } catch {
    dropIns = []
  }
  for (const name of dropIns) {
    const finding = inspectFile('claude', 'managed', api.join(dropInDirectory, name), evaluate)
    if (finding) results.push(finding)
  }
  // 工作目录就是主目录时，项目级 .claude/settings.json 就是用户级那份，是本软件
  // 自己写的；settings.local.json 在主目录下仍然按项目级生效，照查。
  const projectDirectory = api.join(workspace, '.claude')
  const atHome = samePath(workspace, context.home, context.platform)
  for (const name of atHome ? ['settings.local.json'] : ['settings.json', 'settings.local.json']) {
    const finding = inspectFile('claude', 'project', api.join(projectDirectory, name), evaluate)
    if (finding) results.push(finding)
  }
  return results
}

function inspectCodex(workspace: string, context: WorkspaceOverrideContext): WorkspaceConfigOverride[] {
  const api = pathApi(context.platform)
  const ancestors = ancestorDirectories(workspace, context.platform)
  // 没有 git 仓库时 Codex 只读工作目录这一层；有就一直读到 git 根。
  const gitRootIndex = ancestors.findIndex((directory) => entryExists(api.join(directory, '.git')))
  const directories = gitRootIndex === -1 ? ancestors.slice(0, 1) : ancestors.slice(0, gitRootIndex + 1)
  const userConfig = api.join(context.codexHome, 'config.toml')
  const results: WorkspaceConfigOverride[] = []
  for (const directory of directories) {
    const file = api.join(directory, '.codex', 'config.toml')
    if (samePath(file, userConfig, context.platform)) continue
    const finding = inspectFile('codex', 'project', file, (text) => codexProjectOverrideKeys(text, context.current))
    if (finding) results.push(finding)
  }
  return results
}

function inspectGemini(workspace: string, context: WorkspaceOverrideContext): WorkspaceConfigOverride[] {
  const api = pathApi(context.platform)
  const results: WorkspaceConfigOverride[] = []
  if (!samePath(workspace, context.home, context.platform)) {
    const settings = inspectFile(
      'gemini',
      'project',
      api.join(workspace, '.gemini', 'settings.json'),
      (text) => geminiSettingsOverrideKeys(text, context.current),
    )
    if (settings) results.push(settings)
  }
  // Gemini 从工作目录往上，每层先看 .gemini/.env 再看 .env，找到第一份就停，只读
  // 那一份。走到主目录时先碰到的是 ~/.gemini/.env，也就是本软件写的那份，到此为止。
  const userEnv = api.join(context.home, '.gemini', '.env')
  for (const directory of ancestorDirectories(workspace, context.platform)) {
    const candidates = [api.join(directory, '.gemini', '.env'), api.join(directory, '.env')]
    const found = candidates.find((candidate) => entryExists(candidate))
    if (!found) continue
    if (!samePath(found, userEnv, context.platform)) {
      results.push({
        provider: 'gemini',
        scope: 'project',
        file: found,
        keys: [],
        severity: 'blocking',
        launchUnaffected: true,
      })
    }
    break
  }
  return results
}

/**
 * 在工作目录（以及这台电脑的管理策略）里找会盖过当前账号的设置。只读；
 * 任何一步读失败都不抛，最多记成一条「读不了」。
 */
export function inspectWorkspaceConfigOverrides(
  provider: ProviderId,
  workspace: string,
  context: WorkspaceOverrideContext,
): WorkspaceConfigOverride[] {
  if (typeof workspace !== 'string' || !workspace.trim() || !pathApi(context.platform).isAbsolute(workspace)) return []
  switch (provider) {
    case 'claude':
      return inspectClaude(workspace, context)
    case 'codex':
      return inspectCodex(workspace, context)
    case 'gemini':
      return inspectGemini(workspace, context)
    case 'grok':
      return []
  }
}

/**
 * 给用户看、写进日志的路径：项目里的写成相对工作目录，主目录换成 ~，
 * 管理策略那几份本来就在系统目录，照写。
 */
export function displayOverrideFile(file: string, workspace: string, home: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform)
  for (const [root, label] of [[workspace, ''], [home, '~']] as const) {
    if (!root) continue
    const relative = api.relative(api.resolve(root), api.resolve(file))
    if (relative && relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative)) {
      const posix = relative.split(api.sep).join('/')
      return label ? `${label}/${posix}` : posix
    }
  }
  return file
}

/**
 * 打开工具之后弹给用户的那一句。只算这次打开真会生效的（Gemini 的 .env 被本软件
 * 注入的环境变量压住了，不算）。不出现文件名与技术词，那些进日志与检查页详情。
 */
export function launchOverrideNotice(toolName: string, overrides: readonly WorkspaceConfigOverride[]): string | null {
  const effective = overrides.filter((entry) => !entry.launchUnaffected)
  if (!effective.length) return null
  const managed = effective.filter((entry) => entry.scope === 'managed')
  if (managed.length) {
    const certain = managed.some((entry) => entry.severity === 'blocking')
    return `这台电脑上有统一下发的设置（一般是公司的电脑管理员配的），${certain ? '会' : '可能会'}让 ${toolName} 不用当前账号，本软件改不了它，需要找管理员处理。`
  }
  const certain = effective.some((entry) => entry.severity === 'blocking')
  return `这个项目文件夹里有自己的设置，${certain ? '会' : '可能会'}让 ${toolName} 不用当前账号，余额和用量会对不上。不是你有意这样设的话，换一个文件夹打开就好。`
}

/** 日志与检查页详情里的一行：脱敏后的文件位置加键名，从来不带值。 */
export function describeOverride(
  override: WorkspaceConfigOverride,
  workspace: string,
  home: string,
  platform: NodeJS.Platform,
): string {
  const where = displayOverrideFile(override.file, workspace, home, platform)
  if (override.unreadable) return `${where}（读不了，没法确认）`
  return override.keys.length ? `${where}：${override.keys.join('、')}` : where
}

export interface WorkspaceOverrideCheck {
  state: 'pass' | 'warn' | 'fail'
  summary: string
  details: Record<string, string | number>
}

/**
 * 检查页那一项的结论。定级跟着「当前账号还连不连得上」走：从本软件打开时一定
 * 不用当前账号的算「待处理」（fail），可能、或只在用户自己开终端时才生效的算
 * 「需留意」（warn）。开机横幅只数 fail，所以别把「可能」抬成 fail。
 */
export function summarizeWorkspaceOverrides(
  overrides: readonly WorkspaceConfigOverride[],
  options: {
    toolName: (provider: ProviderId) => string
    describe: (override: WorkspaceConfigOverride) => string
    workspaceChecked: boolean
  },
): WorkspaceOverrideCheck {
  const details: Record<string, string | number> = { count: overrides.length }
  overrides.forEach((override, index) => {
    details[`file${index + 1}`] = `${options.toolName(override.provider)} · ${options.describe(override)}`
  })
  if (!overrides.length) {
    return {
      state: 'pass',
      summary: options.workspaceChecked
        ? '项目文件夹里没有会盖过当前账号的设置'
        : '这台电脑上没有会盖过当前账号的统一设置；还没从本软件打开过项目文件夹',
      details,
    }
  }
  const names = (entries: readonly WorkspaceConfigOverride[]) => [...new Set(entries.map((entry) => options.toolName(entry.provider)))].join('、')
  const parts: string[] = []
  const managed = overrides.filter((entry) => entry.scope === 'managed')
  if (managed.length) {
    const certain = managed.some((entry) => entry.severity === 'blocking')
    parts.push(`这台电脑上有统一下发的设置，${certain ? '会' : '可能会'}让 ${names(managed)} 不用当前账号，需要找电脑管理员处理`)
  }
  const project = overrides.filter((entry) => entry.scope === 'project' && !entry.launchUnaffected)
  if (project.length) {
    const certain = project.some((entry) => entry.severity === 'blocking')
    parts.push(`最近打开的项目文件夹里有自己的设置，${certain ? '会' : '可能会'}让 ${names(project)} 不用当前账号；不是有意这样设的话，换一个文件夹打开就好`)
  }
  const terminalOnly = overrides.filter((entry) => entry.launchUnaffected)
  if (terminalOnly.length) {
    parts.push(`在最近打开的项目文件夹里自己开终端运行 ${names(terminalOnly)} 时不会用当前账号，从本软件打开不受影响`)
  }
  const blocking = overrides.some((entry) => entry.severity === 'blocking' && !entry.launchUnaffected)
  return { state: blocking ? 'fail' : 'warn', summary: parts.join('；'), details }
}
