import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { readBoundedUtf8FileSync } from './bounded-file'
import { sameLocalPathIdentity } from './path-identity'
import { DirectoryEntryLimitError, readDirectoryEntriesSync } from './bounded-directory'
import { readBoundedResponseText } from './bounded-response'
import { cliCatalog, providerIds, type ProviderId } from './catalog'
import {
  CODEX_API_CURATED_MARKETPLACE_NAME,
  ensureCodexPluginCatalog,
  inspectCodexPluginCatalog,
  readCodexCatalogPluginInterface,
} from './codex-plugin-catalog'
import {
  cleanCommandOutput,
  commandEnvironment,
  CommandRunnerError,
  findExecutable,
  runCommand,
  trustedCommandEnvironment,
  type CommandSpec,
  type RunCommandOptions,
} from './command-runner'
import type { DownloadAccelerationLease } from './download-acceleration'
import { gitInstallGuidance } from './git-runtime'
import {
  commandLineToolsShimNotice,
  isCommandLineToolsShimBacked,
  isMacOsCommandLineToolsShim,
} from './macos-command-line-tools'
import { resolveCliCommand, type ResolvedCliCommand } from './tool-installation'
import { isNewerVersion } from './versions'
import {
  assertTrustedElevatedCliCommand,
  type WindowsCliExecutionMode,
} from './windows-elevation'

const DEFAULT_TIMEOUT_MS = 30_000
const MUTATION_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_TEXT_LENGTH = 4_096
const MAX_CONFIG_BYTES = 2 * 1024 * 1024
const MAX_CLAUDE_ROOT_CONFIG_BYTES = 16 * 1024 * 1024
const MAX_SKILL_DEFINITION_BYTES = 2 * 1024 * 1024
const MAX_SKILL_DIRECTORY_ENTRIES = 10_000
const MAX_PROVIDER_VERSION_RESPONSE_BYTES = 512 * 1024
const PROVIDER_VERSION_TIMEOUT_MS = 12_000
const MAX_GIT_POINTER_BYTES = 4 * 1024
const MAX_GIT_CONFIG_BYTES = 2 * 1024 * 1024
const MAX_GIT_PACKED_REFS_BYTES = 8 * 1024 * 1024
/**
 * Claude Code registers its official marketplace only while its own first
 * interactive start runs. This application always spawns the CLI
 * non-interactively against the same `~/.claude`, so a customer who never
 * opened a terminal has no marketplace at all and every plugin install fails
 * with "not found in marketplace". Registering it takes a git clone, which is
 * why the missing-git path below has to say something a customer can act on.
 */
const CLAUDE_OFFICIAL_MARKETPLACE_NAME = 'claude-plugins-official'
const CLAUDE_OFFICIAL_MARKETPLACE_SOURCE = 'anthropics/claude-plugins-official'
/**
 * The CLI gives its own cache refresh and its own clone 120 seconds each, in
 * sequence. A shorter budget here would kill it mid-clone and replace its
 * explanation with a generic timeout.
 */
const MARKETPLACE_ADD_TIMEOUT_MS = 240_000
/**
 * `claude mcp list` really starts every stdio server, and the CLI itself waits
 * 30 seconds per server before calling one dead. A budget at our usual 30s
 * would therefore report "未检测" for the whole batch exactly when one entry is
 * broken — the case this check exists for.
 */
const MCP_HEALTH_TIMEOUT_MS = 120_000
const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/'
const OFFICIAL_PYPI_ORIGIN = 'https://pypi.org'
const OFFICIAL_GITHUB_ORIGIN = 'https://github.com'

export type ProviderExtensionKind = 'mcp' | 'skill' | 'plugin'
export type ProviderExtensionSourceKind =
  | 'npm'
  | 'pypi'
  | 'git'
  | 'native'
  | 'local'
  | 'source-unknown'
export type ProviderExtensionUpdateState =
  | 'up-to-date'
  | 'update-available'
  | 'unsupported'
  | 'source-unknown'
  | 'check-failed'
export type ProviderExtensionAction = 'install' | 'uninstall' | 'enable' | 'disable' | 'update'
export type ProviderExtensionScope = 'user' | 'project' | 'local' | 'workspace'
export type ProviderExtensionItemScope = ProviderExtensionScope | 'builtin' | 'extension'

export interface ProviderExtensionOperations {
  install: boolean
  uninstall: boolean
  enable: boolean
  disable: boolean
  update: boolean
}

export interface ProviderExtensionSource {
  kind: ProviderExtensionSourceKind
  locator: string | null
  reference: string | null
}

export interface ProviderExtensionUpdate {
  state: ProviderExtensionUpdateState
  reason: string
  checkedAt: string | null
}

export interface ProviderExtensionItem {
  provider: ProviderId
  kind: ProviderExtensionKind
  id: string
  name: string
  description: string
  installed: boolean
  enabled: boolean
  scope: ProviderExtensionItemScope | null
  currentVersion: string | null
  latestVersion: string | null
  source: ProviderExtensionSource
  update: ProviderExtensionUpdate
  operations: ProviderExtensionOperations
}

export interface ProviderExtensionCategoryCapability {
  list: boolean
  reason: string | null
}

export interface ProviderExtensionMarketplaceState {
  /** 官方市场名，未注册时界面要按它提示「添加官方市场」。 */
  name: string
  registered: boolean
  /** 读取市场清单失败的原因；成功时为 null。 */
  reason: string | null
}

/**
 * 连接能不能用，只有三种回答。`unknown` 是「这次没有检测」，不是「有问题」——
 * 没有检测能力的工具和检测超时都落在这里，界面不许把它画成红色。
 */
export type ProviderMcpHealthState = 'connected' | 'failed' | 'unknown'

export interface ProviderMcpHealthEntry {
  /** 与 ProviderExtensionItem.id 对齐，也就是 CLI 打印出来的连接名。 */
  id: string
  state: ProviderMcpHealthState
  /** 一句中文原因；工具没给出原因时为 null，不替它编一个。 */
  detail: string | null
}

export interface ProviderMcpHealthReport {
  provider: ProviderId
  checkedAt: string
  /** false = 这个工具没有可读的连接状态，整页一律「未检测」。 */
  supported: boolean
  /** 不支持或整批失败时的一句说明；成功时为 null。 */
  reason: string | null
  entries: ProviderMcpHealthEntry[]
}

/**
 * 本机跑不跑得起某一类 MCP。只看「有没有这个可执行文件」，不做版本判断：
 * 用户自己装的 conda / pyenv 也算数（见添加连接时的提示）。
 */
export interface ProviderExtensionRuntimeAvailability {
  python: boolean
  uv: boolean
}

export interface ProviderExtensionsSnapshot {
  provider: ProviderId
  checkedAt: string
  capabilities: Record<ProviderExtensionKind, ProviderExtensionCategoryCapability>
  items: ProviderExtensionItem[]
  warnings: string[]
  /** 仅 Claude Code 有官方市场这一层，其余 Provider 缺省即旧行为。 */
  marketplace?: ProviderExtensionMarketplaceState
  /** 添加 uvx / python 型连接前要用它提示缺环境；缺省即旧行为（不提示）。 */
  runtimes?: ProviderExtensionRuntimeAvailability
}

export type ProviderMcpInstallConfiguration =
  | {
      type: 'stdio'
      command: string
      args?: readonly string[]
      env?: Readonly<Record<string, string>>
    }
  | {
      type: 'http'
      url: string
    }

export interface ProviderExtensionMutation {
  provider: ProviderId
  kind: ProviderExtensionKind
  action: ProviderExtensionAction
  id?: string
  source?: string
  scope?: ProviderExtensionScope
  mcp?: ProviderMcpInstallConfiguration
}

export interface ProviderCliInvocationOptions {
  cwd?: string
  timeoutMs?: number
  maxOutputBytes?: number
  sensitiveValues?: readonly string[]
  /**
   * Extra variables merged on top of the provider environment, for the
   * invocations that actually reach the network. Acceleration only takes over
   * the system proxy, which a CLI subprocess does not read on its own.
   */
  extraEnvironment?: NodeJS.ProcessEnv
}

export type ProviderCliInvoker = (
  provider: ProviderId,
  argv: readonly string[],
  options?: ProviderCliInvocationOptions,
) => Promise<string>

export interface SourceUpdateInspectionInput {
  kind: 'npm' | 'pypi' | 'git'
  locator: string
  currentVersion: string | null
  localPath?: string
}

export interface SourceUpdateInspectionResult {
  currentVersion: string | null
  latestVersion: string | null
  locator?: string
}

export type SourceUpdateInspector = (
  input: SourceUpdateInspectionInput,
) => Promise<SourceUpdateInspectionResult>

export interface ProviderSourceUpdateDependencies {
  fetch?: typeof globalThis.fetch
  findExecutable?: typeof findExecutable
  runCommand?: typeof runCommand
  platform?: NodeJS.Platform
  /** 缺省真去问 xcode-select；与 runCommand 分开注入，免得假 git 输出被当成它的回答。 */
  isCommandLineToolsShimBacked?: (shim: string) => Promise<boolean>
}

export interface ProviderExtensionServiceOptions {
  homeDirectory?: string
  codexHome?: string
  repositoryRoot?: string | null
  env?: NodeJS.ProcessEnv
  codexEnv?: NodeJS.ProcessEnv
  invoke?: ProviderCliInvoker
  resolveCommand?: typeof resolveProviderCommand
  runCommand?: typeof runCommand
  findExecutable?: typeof findExecutable
  /** 出网的扩展操作跟当前加速线路走，缺省不带任何代理变量。 */
  resolveSubprocessProxyEnvironment?: () => Promise<NodeJS.ProcessEnv>
  /** 下载 Codex 插件目录用的网络栈；main.ts 接的是读系统代理与下载加速的那一条。 */
  downloadFetch?: typeof fetch
  /** 下载前临时借一条加速线路，与装 CLI 同一套；缺省 = 不借。 */
  acquireDownloadAcceleration?: () => Promise<DownloadAccelerationLease>
  inspectSource?: SourceUpdateInspector
  sourceUpdateDependencies?: ProviderSourceUpdateDependencies
  now?: () => Date
  windowsExecutionMode?: WindowsCliExecutionMode
  platform?: NodeJS.Platform
  /** 缺省真去问 xcode-select（见 macos-command-line-tools.ts）。 */
  isCommandLineToolsShimBacked?: (shim: string) => Promise<boolean>
}

interface MutableExtensionItem extends ProviderExtensionItem {
  sourceLocalPath?: string
}

interface RawMcpServer {
  name: string
  command: string | null
  args: string[]
  url: string | null
  enabled: boolean
}

interface ParsedPackageSource {
  kind: 'npm' | 'pypi' | 'git' | 'source-unknown'
  locator: string | null
  reference: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function nullableText(value: unknown): string | null {
  const result = text(value).trim()
  return result ? result.slice(0, MAX_TEXT_LENGTH) : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, 256)
    : []
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error(`${label}未返回有效 JSON`)
  }
}

function safeIdentifier(value: string | undefined, label: string): string {
  const result = value?.trim() ?? ''
  if (!result || result.length > 512 || result.includes('\0') || result.startsWith('-')) {
    throw new Error(`${label}格式错误`)
  }
  return result
}

function safeSource(value: string | undefined): string {
  const result = value?.trim() ?? ''
  if (!result || result.length > MAX_TEXT_LENGTH || result.includes('\0') || result.startsWith('-')) {
    throw new Error('扩展来源格式错误')
  }
  return result
}

function safeUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('MCP URL 格式错误')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error('MCP URL 必须是不含凭据和片段的 HTTP(S) 地址')
  }
  return parsed.toString()
}

function displayUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value.replace(/^git\+/, ''))
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

function displayGitLocator(value: string): string {
  return displayUrl(value) ?? value.replace(/^(?:[^@\s]+@)?([^:\s]+):/, 'git@$1:').slice(0, MAX_TEXT_LENGTH)
}

function gitPackageSource(value: string): ParsedPackageSource {
  const separator = value.lastIndexOf('#')
  const reference = separator >= 0 ? value.slice(separator + 1).trim() || null : null
  const locator = separator >= 0 ? value.slice(0, separator) : value
  return { kind: 'git', locator: displayGitLocator(locator), reference }
}

function normalizeScope(
  provider: ProviderId,
  scope: ProviderExtensionScope | undefined,
  kind: ProviderExtensionKind,
): string {
  const requested = scope ?? 'user'
  if (provider === 'gemini') {
    if (kind === 'mcp') return requested === 'user' ? 'user' : 'project'
    return requested === 'user' ? 'user' : 'workspace'
  }
  if (requested === 'workspace') return 'project'
  return requested
}

// 命令失败只说「执行失败（退出码 1）」等于什么都没说，真正的原因全在命令自己的
// 输出里。只取最后几行：这段话会直接上屏，而 CLI 失败时往往先吐一大段帮助。
// stdout / stderr 在 CommandRunnerError 构造时已经过一道 redactCommandText（I13）。
function commandOutputTail(error: unknown): string {
  if (!(error instanceof CommandRunnerError)) return ''
  const output = error.stderr.trim() || error.stdout.trim()
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return ''
  return lines.slice(-3).join(' / ').slice(0, 240)
}

function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const summary = message.replace(/\s+/g, ' ').trim().slice(0, 500) || '未知错误'
  const tail = commandOutputTail(error)
  return tail ? `${summary}（命令输出：${tail}）` : summary
}

class UnsupportedSourceInspectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedSourceInspectionError'
  }
}

function defaultUpdate(state: ProviderExtensionUpdateState, reason: string): ProviderExtensionUpdate {
  return { state, reason, checkedAt: null }
}

function nativeOperations(provider: ProviderId, kind: ProviderExtensionKind): ProviderExtensionOperations {
  if (kind === 'mcp') {
    return {
      install: true,
      uninstall: true,
      enable: provider === 'gemini',
      disable: provider === 'gemini',
      update: false,
    }
  }
  if (kind === 'skill') {
    const gemini = provider === 'gemini'
    return { install: gemini, uninstall: gemini, enable: gemini, disable: gemini, update: false }
  }
  if (provider === 'codex') {
    return { install: true, uninstall: true, enable: false, disable: false, update: false }
  }
  return { install: true, uninstall: true, enable: true, disable: true, update: true }
}

function packageParts(specifier: string): { name: string; reference: string | null } | null {
  const value = specifier.trim()
  if (!value || value.startsWith('-')) return null
  if (/^(?:git\+|https?:\/\/|ssh:\/\/|git@)/i.test(value)) return null
  let separator = -1
  if (value.startsWith('@')) {
    const slash = value.indexOf('/')
    if (slash < 2) return null
    separator = value.indexOf('@', slash)
  } else {
    separator = value.lastIndexOf('@')
  }
  const name = separator > 0 ? value.slice(0, separator) : value
  const reference = separator > 0 ? value.slice(separator + 1) || null : null
  if (!/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(name)) return null
  return { name, reference }
}

function firstPositional(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]
    if (entry === '--') return argv[index + 1] ?? null
    if (entry.startsWith('-')) {
      if (['--package', '-p', '--from'].includes(entry)) index += 1
      continue
    }
    return entry
  }
  return null
}

export function detectMcpPackageSource(command: string | null, args: readonly string[]): ParsedPackageSource {
  if (!command) return { kind: 'source-unknown', locator: null, reference: null }
  const executable = path.basename(command).replace(/\.(?:exe|cmd|ps1)$/i, '').toLowerCase()
  // The suffix group used to be optional, which collapsed the whole pattern
  // into "starts with a URL scheme". A plain endpoint such as
  // `npx -y mcp-remote https://example.com/mcp` was therefore read as a git
  // repository, and enrichUpdates then reported latestVersion: null because no
  // local checkout exists — silently skipping the npm version check.
  //
  // git+, git@ and ssh:// name the transport outright, so they stay
  // unconditional. A bare http(s) URL is indistinguishable from a service
  // endpoint unless it carries a .git suffix or an explicit #ref.
  const gitValue = args.find((entry) => (
    /^(?:git\+|git@|ssh:\/\/)/i.test(entry)
    || /^https?:\/\/.*(?:\.git|#[A-Za-z0-9._/-]+)$/i.test(entry)
  ))
  if (gitValue) return gitPackageSource(gitValue)

  if (executable === 'npx' || executable === 'npm') {
    const candidate = executable === 'npm' && args[0] === 'exec'
      ? firstPositional(args.slice(1))
      : firstPositional(args)
    if (candidate && /^(?:git\+|https?:\/\/|ssh:\/\/|git@)/i.test(candidate)) {
      return gitPackageSource(candidate)
    }
    const parsed = candidate ? packageParts(candidate) : null
    return parsed
      ? { kind: 'npm', locator: parsed.name, reference: parsed.reference }
      : { kind: 'source-unknown', locator: null, reference: null }
  }

  if (executable === 'uvx' || executable === 'pipx' || executable === 'uv') {
    const offset = executable === 'pipx' && args[0] === 'run'
      ? 1
      : executable === 'uv' && args[0] === 'tool' && args[1] === 'run'
        ? 2
        : 0
    const packageArgs = args.slice(offset)
    const fromIndex = packageArgs.indexOf('--from')
    const candidate = fromIndex >= 0 ? packageArgs[fromIndex + 1] ?? null : firstPositional(packageArgs)
    const parsed = candidate ? packageParts(candidate) : null
    return parsed
      ? { kind: 'pypi', locator: parsed.name, reference: parsed.reference }
      : { kind: 'source-unknown', locator: null, reference: null }
  }

  return { kind: 'source-unknown', locator: null, reference: null }
}

function rawMcpFromJson(value: unknown): RawMcpServer {
  if (!isRecord(value)) throw new Error('MCP 列表包含无效条目')
  const transport = isRecord(value.transport) ? value.transport : value
  const name = safeIdentifier(text(value.name), 'MCP 名称')
  const command = nullableText(transport.command)
  const url = displayUrl(nullableText(transport.url))
  return {
    name,
    command,
    args: stringArray(transport.args),
    url,
    enabled: value.enabled !== false && transport.enabled !== false,
  }
}

function parseMcpJson(output: string): RawMcpServer[] {
  const parsed = parseJson(output, 'MCP 列表')
  const values = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.servers)
      ? parsed.servers
      : isRecord(parsed) && isRecord(parsed.mcpServers)
        ? Object.entries(parsed.mcpServers).map(([name, value]) => ({ name, ...(isRecord(value) ? value : {}) }))
        : []
  return values.map(rawMcpFromJson)
}

function readJsonFile(filePath: string, maximumBytes = MAX_CONFIG_BYTES): Record<string, unknown> | null {
  let info: fs.Stats
  try {
    info = fs.lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
    throw new Error(`配置文件不是单链接普通文件：${filePath}`)
  }
  const parsed = JSON.parse(readBoundedUtf8FileSync(
    filePath,
    maximumBytes,
    '扩展配置文件',
  )) as unknown
  if (!isRecord(parsed)) throw new Error(`配置文件根节点必须是对象：${filePath}`)
  return parsed
}

function configMcpEntries(config: Record<string, unknown> | null): RawMcpServer[] {
  const servers = config?.mcpServers
  if (!isRecord(servers)) return []
  return Object.entries(servers).map(([name, value]) => rawMcpFromJson({
    name,
    ...(isRecord(value) ? value : {}),
  }))
}

function equivalentProjectPath(left: string, right: string): boolean {
  const pathApi = process.platform === 'win32' ? path.win32 : path.posix
  const normalize = (value: string) => {
    const normalized = pathApi.normalize(pathApi.resolve(value)).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

interface ConfiguredMcpServers {
  servers: RawMcpServer[]
  warnings: string[]
}

function readConfiguredMcpServers(
  provider: 'claude' | 'gemini',
  homeDirectory: string,
  repositoryRoot: string | null,
): ConfiguredMcpServers {
  const claudeRootConfig = path.join(homeDirectory, '.claude.json')
  const files = provider === 'claude'
    ? [
        claudeRootConfig,
        path.join(homeDirectory, '.claude', 'settings.json'),
        repositoryRoot ? path.join(repositoryRoot, '.mcp.json') : null,
        repositoryRoot ? path.join(repositoryRoot, '.claude', 'settings.json') : null,
      ]
    : [
        path.join(homeDirectory, '.gemini', 'settings.json'),
        repositoryRoot ? path.join(repositoryRoot, '.gemini', 'settings.json') : null,
      ]
  // ~/.claude.json 会随会话历史增长，2MB 上限会误伤正常用户，单独放宽。
  const limitFor = (filePath: string) => filePath === claudeRootConfig
    ? MAX_CLAUDE_ROOT_CONFIG_BYTES
    : MAX_CONFIG_BYTES
  const result = new Map<string, RawMcpServer>()
  const warnings: string[] = []
  const failedFiles = new Set<string>()
  const recordFailure = (filePath: string, error: unknown) => {
    failedFiles.add(filePath)
    warnings.push(`MCP 配置读取失败（${filePath}）：${errorDetail(error)}`)
  }
  for (const filePath of files) {
    if (!filePath) continue
    // 单个文件损坏或超限只降级为警告，避免拖垮其余配置来源。
    try {
      for (const server of configMcpEntries(readJsonFile(filePath, limitFor(filePath)))) result.set(server.name, server)
    } catch (error) {
      recordFailure(filePath, error)
    }
  }
  if (provider === 'claude' && repositoryRoot && !failedFiles.has(claudeRootConfig)) {
    try {
      const root = readJsonFile(claudeRootConfig, MAX_CLAUDE_ROOT_CONFIG_BYTES)
      const projects = isRecord(root?.projects) ? root.projects : null
      const projectValue = projects
        ? Object.entries(projects).find(([projectPath]) => equivalentProjectPath(projectPath, repositoryRoot))?.[1]
        : null
      const project = isRecord(projectValue) ? projectValue : null
      for (const server of configMcpEntries(project)) result.set(server.name, server)
    } catch (error) {
      recordFailure(claudeRootConfig, error)
    }
  }
  return { servers: [...result.values()], warnings }
}

function mcpItem(provider: ProviderId, server: RawMcpServer): MutableExtensionItem {
  const detected = detectMcpPackageSource(server.command, server.args)
  const sourceUnknown = detected.kind === 'source-unknown'
  return {
    provider,
    kind: 'mcp',
    id: server.name,
    name: server.name,
    description: server.url ?? (server.command
      ? `${path.basename(server.command)}（${server.args.length} 个参数）`
      : ''),
    installed: true,
    enabled: server.enabled,
    scope: null,
    currentVersion: detected.reference,
    latestVersion: null,
    source: detected,
    update: sourceUnknown
      ? defaultUpdate('source-unknown', '无法从 MCP 启动命令识别 npm、PyPI 或 Git 来源')
      : defaultUpdate('unsupported', '尚未查询远端版本'),
    operations: nativeOperations(provider, 'mcp'),
  }
}

function yamlFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith('---')) return {}
  const end = content.indexOf('\n---', 3)
  if (end < 0) return {}
  try {
    const parsed = parseYaml(content.slice(3, end)) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

interface SkillRoot {
  path: string
  scope: ProviderExtensionScope
}

function skillRoots(
  provider: ProviderId,
  home: string,
  codexHome: string,
  repository: string | null,
): SkillRoot[] {
  const roots: SkillRoot[] = []
  if (provider === 'codex') {
    roots.push(
      { path: path.join(home, '.agents', 'skills'), scope: 'user' },
      { path: path.join(codexHome, 'skills'), scope: 'user' },
    )
  }
  if (provider === 'claude') roots.push({ path: path.join(home, '.claude', 'skills'), scope: 'user' })
  if (provider === 'gemini') {
    roots.push(
      { path: path.join(home, '.gemini', 'skills'), scope: 'user' },
      { path: path.join(home, '.agents', 'skills'), scope: 'user' },
    )
  }
  if (provider === 'grok') roots.push({ path: path.join(home, '.grok', 'skills'), scope: 'user' })
  if (repository) {
    if (provider === 'codex') {
      roots.push(
        { path: path.join(repository, '.agents', 'skills'), scope: 'project' },
        { path: path.join(repository, '.codex', 'skills'), scope: 'project' },
      )
    } else if (provider === 'gemini') {
      roots.push(
        { path: path.join(repository, '.gemini', 'skills'), scope: 'workspace' },
        { path: path.join(repository, '.agents', 'skills'), scope: 'workspace' },
      )
    } else {
      roots.push({ path: path.join(repository, `.${provider}`, 'skills'), scope: 'project' })
    }
  }
  const result = new Map<string, SkillRoot>()
  for (const root of roots) {
    const resolved = path.resolve(root.path)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (!result.has(key)) result.set(key, { ...root, path: resolved })
  }
  return [...result.values()]
}

function findGitRoot(start: string, boundary: string): string | null {
  let current = path.resolve(start)
  const limit = path.resolve(boundary)
  while (current === limit || current.startsWith(`${limit}${path.sep}`)) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    if (current === limit) break
    current = path.dirname(current)
  }
  return null
}

function scanSkills(
  provider: ProviderId,
  home: string,
  codexHome: string,
  repository: string | null,
): MutableExtensionItem[] {
  const result = new Map<string, MutableExtensionItem>()
  for (const root of skillRoots(provider, home, codexHome, repository)) {
    let rootInfo: fs.Stats
    let realRoot: string
    try {
      rootInfo = fs.lstatSync(root.path)
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) continue
      realRoot = fs.realpathSync(root.path)
    } catch {
      continue
    }
    let directories: fs.Dirent[]
    try {
      directories = readDirectoryEntriesSync(root.path, MAX_SKILL_DIRECTORY_ENTRIES, `${provider} Skill 目录`)
    } catch (error) {
      if (error instanceof DirectoryEntryLimitError) throw error
      continue
    }
    for (const directory of directories) {
      const skillDirectory = path.join(root.path, directory.name)
      const definitionPath = path.join(skillDirectory, 'SKILL.md')
      let skillDirectoryInfo: fs.Stats
      let definitionInfo: fs.Stats
      let realDefinition: string
      let frontmatter: Record<string, unknown> = {}
      try {
        skillDirectoryInfo = fs.lstatSync(skillDirectory)
        definitionInfo = fs.lstatSync(definitionPath)
        realDefinition = fs.realpathSync(definitionPath)
        if (!skillDirectoryInfo.isDirectory() || skillDirectoryInfo.isSymbolicLink()) continue
        if (!definitionInfo.isFile() || definitionInfo.isSymbolicLink() || definitionInfo.nlink > 1) continue
        if (!pathInside(realDefinition, realRoot)) continue
        frontmatter = yamlFrontmatter(readBoundedUtf8FileSync(
          realDefinition,
          MAX_SKILL_DEFINITION_BYTES,
          `${provider} SKILL.md`,
        ))
      } catch {
        continue
      }
      const name = nullableText(frontmatter.name) ?? directory.name
      const gitRoot = findGitRoot(skillDirectory, root.path)
      const source: ProviderExtensionSource = gitRoot
        ? { kind: 'git', locator: gitRoot, reference: null }
        : { kind: 'local', locator: skillDirectory, reference: null }
      const id = path.resolve(definitionPath)
      const key = process.platform === 'win32' ? id.toLowerCase() : id
      result.set(key, {
        provider,
        kind: 'skill',
        id,
        name,
        description: nullableText(frontmatter.description) ?? '',
        installed: true,
        enabled: true,
        scope: root.scope,
        currentVersion: null,
        latestVersion: null,
        source,
        sourceLocalPath: gitRoot ?? undefined,
        update: gitRoot
          ? defaultUpdate('unsupported', '尚未查询 Git 远端提交')
          : defaultUpdate('unsupported', '本地 Skill 没有可验证的 Git 来源'),
        operations: nativeOperations(provider, 'skill'),
      })
    }
  }
  return [...result.values()]
}

function pathInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function geminiSkillScope(
  location: string,
  builtin: boolean,
  home: string,
  repository: string | null,
): ProviderExtensionItemScope | null {
  if (builtin) return 'builtin'
  const skillDirectory = path.dirname(location)
  for (const root of skillRoots('gemini', home, path.join(home, '.codex'), repository)) {
    if (pathInside(skillDirectory, root.path)) return root.scope
  }
  const extensionRoot = path.join(home, '.gemini', 'extensions')
  if (pathInside(skillDirectory, extensionRoot)) return 'extension'
  return null
}

function geminiSkillOperations(scope: ProviderExtensionItemScope | null): ProviderExtensionOperations {
  return {
    install: true,
    uninstall: scope === 'user' || scope === 'workspace',
    enable: scope !== null,
    disable: scope !== null,
    update: false,
  }
}

/** Parses Gemini CLI's native text listing, which is its only authoritative Skill status output in 0.52. */
export function parseGeminiSkillList(
  output: string,
  home: string,
  repository: string | null,
): ProviderExtensionItem[] {
  const lines = output.replace(/\r\n?/g, '\n').split('\n')
  const items: ProviderExtensionItem[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^(.+?)\s+\[(Enabled|Disabled)\](?:\s+\[Built-in\])?\s*$/)
    if (!header) continue
    const builtin = /\[Built-in\]\s*$/.test(lines[index])
    let description = ''
    let location = ''
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (/^(.+?)\s+\[(Enabled|Disabled)\](?:\s+\[Built-in\])?\s*$/.test(line)) {
        index -= 1
        break
      }
      const descriptionMatch = line.match(/^\s*Description:\s*(.*)$/)
      if (descriptionMatch) description = descriptionMatch[1].trim().slice(0, MAX_TEXT_LENGTH)
      const locationMatch = line.match(/^\s*Location:\s*(.+?)\s*$/)
      if (locationMatch) location = locationMatch[1].trim()
    }
    if (!location || location.includes('\0')) continue
    const resolvedLocation = path.resolve(location)
    const scope = geminiSkillScope(resolvedLocation, builtin, home, repository)
    items.push({
      provider: 'gemini',
      kind: 'skill',
      id: resolvedLocation,
      name: header[1].trim().slice(0, MAX_TEXT_LENGTH),
      description,
      installed: true,
      enabled: header[2] === 'Enabled',
      scope,
      currentVersion: null,
      latestVersion: null,
      source: {
        kind: builtin ? 'native' : 'local',
        locator: resolvedLocation,
        reference: null,
      },
      update: defaultUpdate('unsupported', builtin
        ? 'Gemini 内置 Skill 不支持独立更新'
        : 'Gemini CLI 未提供 Skill 版本信息'),
      operations: geminiSkillOperations(scope),
    })
  }
  return items.sort((left, right) => left.name.localeCompare(right.name))
}

function versionUpdate(
  currentVersion: string | null,
  latestVersion: string | null,
  checkedAt: string,
  sourceKind: ProviderExtensionSourceKind,
): ProviderExtensionUpdate {
  if (!currentVersion || !latestVersion) {
    return {
      state: sourceKind === 'source-unknown' ? 'source-unknown' : 'unsupported',
      reason: '缺少可比较的当前版本或远端版本',
      checkedAt,
    }
  }
  if (currentVersion === latestVersion) return { state: 'up-to-date', reason: '当前版本与远端版本一致', checkedAt }
  if (sourceKind === 'git') return { state: 'update-available', reason: '远端 Git 提交与本地提交不同', checkedAt }
  if (isNewerVersion(currentVersion, latestVersion)) {
    return { state: 'update-available', reason: '检测到更高的远端版本', checkedAt }
  }
  return { state: 'unsupported', reason: '版本格式不可比较或远端版本不高于当前版本', checkedAt }
}

function pluginKey(provider: ProviderId, value: Record<string, unknown>): string {
  if (provider === 'gemini') {
    return nullableText(value.name) ?? nullableText(value.id) ?? 'unknown'
  }
  const explicit = nullableText(value.pluginId) ?? nullableText(value.id)
  if (explicit) return explicit
  const name = nullableText(value.name) ?? 'unknown'
  const marketplace = nullableText(value.marketplace) ?? nullableText(value.marketplaceName)
  return marketplace ? `${name}@${marketplace}` : name
}

function pluginItem(
  provider: ProviderId,
  installedValue: Record<string, unknown> | null,
  availableValue: Record<string, unknown> | null,
  checkedAt: string,
  defaultScope: ProviderExtensionScope | null,
): MutableExtensionItem {
  const value = installedValue ?? availableValue ?? {}
  const id = safeIdentifier(pluginKey(provider, value), 'Plugin ID')
  const currentVersionValue = installedValue ? nullableText(installedValue.version) : null
  const latestVersionValue = availableValue ? nullableText(availableValue.version) : null
  const currentVersion = currentVersionValue?.toLowerCase() === 'unknown' ? null : currentVersionValue
  const latestVersion = latestVersionValue?.toLowerCase() === 'unknown' ? null : latestVersionValue
  const installed = Boolean(installedValue)
  const enabled = installedValue?.isActive !== false
    && installedValue?.enabled !== false
    && installedValue?.status !== 'disabled'
  const metadata = availableValue ?? installedValue ?? {}
  const sourceValue = isRecord(metadata.source) ? metadata.source : null
  const installMetadata = isRecord(metadata.installMetadata) ? metadata.installMetadata : null
  const installSource = isRecord(installMetadata?.source) ? installMetadata.source : null
  const locator = nullableText(sourceValue?.url)
    ?? nullableText(sourceValue?.path)
    ?? nullableText(installSource?.url)
    ?? nullableText(installSource?.path)
    ?? nullableText(installMetadata?.source)
    ?? nullableText(metadata.path)
    ?? nullableText(metadata.sourcePath)
    ?? nullableText(metadata.marketplace)
    ?? nullableText(metadata.marketplaceName)
    ?? (id.includes('@') ? id.slice(id.lastIndexOf('@') + 1) : null)
  const sourceKind: ProviderExtensionSourceKind = locator && /^(?:git\+|https?:\/\/|ssh:\/\/|git@)/i.test(locator)
    ? 'git'
    : provider === 'gemini' && locator && (path.isAbsolute(locator) || /^\.{1,2}[\\/]/.test(locator))
      ? 'local'
      : 'native'
  const installedScope = nullableText(installedValue?.scope)
  const scope: ProviderExtensionScope | null = installedScope
    && ['user', 'project', 'local', 'workspace'].includes(installedScope.toLowerCase())
    ? installedScope.toLowerCase() as ProviderExtensionScope
    : defaultScope
  return {
    provider,
    kind: 'plugin',
    id,
    name: nullableText(metadata.name) ?? id.split('@')[0],
    description: nullableText(metadata.description) ?? '',
    installed,
    enabled: installed && enabled,
    scope,
    currentVersion,
    latestVersion,
    source: { kind: sourceKind, locator, reference: null },
    update: installed
      ? versionUpdate(currentVersion, latestVersion, checkedAt, sourceKind)
      : defaultUpdate('unsupported', '扩展尚未安装'),
    operations: nativeOperations(provider, 'plugin'),
  }
}

export function parseProviderPluginList(
  provider: ProviderId,
  output: string,
  checkedAt = new Date().toISOString(),
  defaultScope: ProviderExtensionScope | null = null,
): ProviderExtensionItem[] {
  const parsed = parseJson(output, `${cliCatalog[provider].name} 扩展列表`)
  const installed = new Map<string, Record<string, unknown>>()
  const available = new Map<string, Record<string, unknown>>()
  if (isRecord(parsed)) {
    for (const entry of Array.isArray(parsed.installed) ? parsed.installed : []) {
      if (isRecord(entry)) installed.set(pluginKey(provider, entry), entry)
    }
    for (const entry of Array.isArray(parsed.available) ? parsed.available : []) {
      if (isRecord(entry)) available.set(pluginKey(provider, entry), entry)
    }
  } else if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (!isRecord(entry)) continue
      const status = text(entry.status).toLowerCase()
      if (status === 'installed' || entry.installed === true) installed.set(pluginKey(provider, entry), entry)
      else if (status === 'available' || entry.installed === false) available.set(pluginKey(provider, entry), entry)
      else installed.set(pluginKey(provider, entry), entry)
    }
  } else {
    throw new Error(`${cliCatalog[provider].name} 扩展列表格式不受支持`)
  }
  return [...new Set([...installed.keys(), ...available.keys()])]
    .map((key) => pluginItem(
      provider,
      installed.get(key) ?? null,
      available.get(key) ?? null,
      checkedAt,
      defaultScope,
    ))
    .sort((left, right) => Number(right.installed) - Number(left.installed) || left.name.localeCompare(right.name))
}

/** 官方目录里的插件补上 plugin.json 里的显示名与一句说明；别的市场原样不动。 */
export function describeCodexCatalogPlugins(items: MutableExtensionItem[], codexHome: string): void {
  const suffix = `@${CODEX_API_CURATED_MARKETPLACE_NAME}`
  for (const item of items) {
    if (!item.id.endsWith(suffix)) continue
    const face = readCodexCatalogPluginInterface(codexHome, item.id.slice(0, -suffix.length))
    if (!face) continue
    if (face.displayName) item.name = face.displayName
    if (!item.description && face.shortDescription) item.description = face.shortDescription
  }
}

function pluginListArgv(provider: ProviderId): string[] {
  if (provider === 'codex') return ['plugin', 'list', '--available', '--json']
  if (provider === 'claude') return ['plugin', 'list', '--available', '--json']
  if (provider === 'gemini') return ['extensions', 'list', '--output-format', 'json']
  return ['plugin', 'list', '--available', '--json']
}

export function claudeMarketplaceListArgv(): string[] {
  return ['plugin', 'marketplace', 'list', '--json']
}

export function claudeOfficialMarketplaceAddArgv(): string[] {
  return ['plugin', 'marketplace', 'add', CLAUDE_OFFICIAL_MARKETPLACE_SOURCE]
}

export function parseClaudeMarketplaceNames(output: string): string[] {
  const parsed = parseJson(output, 'Claude Code 插件市场列表')
  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.marketplaces) ? parsed.marketplaces : null
  if (!entries) throw new Error('Claude Code 插件市场列表格式不受支持')
  return entries
    .map((entry) => (isRecord(entry) ? text(entry.name).trim() : ''))
    .filter((name) => name.length > 0)
}

/**
 * Fallback for a CLI old enough to reject `--json` on the marketplace list:
 * the same registration the CLI itself writes, read from its user settings.
 */
export function readClaudeSettingsMarketplaceNames(homeDirectory: string): string[] {
  try {
    const parsed = parseJson(
      readBoundedUtf8FileSync(
        path.join(homeDirectory, '.claude', 'settings.json'),
        MAX_CLAUDE_ROOT_CONFIG_BYTES,
        'Claude Code 用户设置',
      ),
      'Claude Code 用户设置',
    )
    if (!isRecord(parsed) || !isRecord(parsed.extraKnownMarketplaces)) return []
    return Object.keys(parsed.extraKnownMarketplaces)
  } catch {
    return []
  }
}

export function claudeMarketplaceGitMissingMessage(
  platform: NodeJS.Platform = process.platform,
  options: { commandLineToolsShim?: boolean } = {},
): string {
  // 找到的只是 macOS 自带的空壳：让 CLI 去跑它只会招来苹果的安装弹窗、再失败一次，
  // 不如在这里先把原因说清楚（#346 的后续）。
  if (options.commandLineToolsShim) {
    return `第一次安装 Claude Code 插件要先把官方插件市场下载到本机，这一步需要 Git。${commandLineToolsShimNotice('git')}，装好后重新打开本软件再试。`
  }
  // 分平台的安装指引在 git-runtime.ts 只写一份：首页运行环境行和检查页要说的是
  // 同一句话，两处各抄一遍早晚会说岔（#294）。
  return `第一次安装 Claude Code 插件要先把官方插件市场下载到本机，这一步需要 Git，但这台电脑上没有找到它。${gitInstallGuidance(platform)}，装好后重新打开本软件再试。`
}

/** 只有真要出网的操作才需要代理：MCP 增删改的都是本地配置文件。 */
export function isNetworkBoundExtensionMutation(input: ProviderExtensionMutation): boolean {
  return input.kind !== 'mcp' && (input.action === 'install' || input.action === 'update')
}

function mcpListArgv(provider: ProviderId): string[] | null {
  if (provider === 'codex' || provider === 'grok') return ['mcp', 'list', '--json']
  return null
}

/**
 * 连接状态只有 Claude Code 与 Gemini CLI 自己回答得了：两家的 `mcp list` 会
 * 逐条真的把服务拉起来一次再打印结论。Codex / Grok 的 `mcp list --json` 只回
 * 配置内容，所以那两家一律「未检测」，不拿配置去猜。
 */
function mcpHealthArgv(provider: ProviderId): string[] | null {
  return provider === 'claude' || provider === 'gemini' ? ['mcp', 'list'] : null
}

interface McpHealthLabel {
  label: string
  state: ProviderMcpHealthState
  /** 状态本身译成中文；CLI 另给的原因会接在它后面。 */
  reason: string | null
}

/**
 * Claude Code 2.1.278 的状态字面量，逐条取自它自己的 `mcp list` 实现。
 * 顺序有意义：复合状态必须排在它的前缀之前，否则
 * `Connected · tools fetch failed` 会被先当成 `Connected`。
 */
const CLAUDE_MCP_HEALTH_LABELS: readonly McpHealthLabel[] = [
  { label: 'Connected · tools fetch failed', state: 'failed', reason: '连上了，但读不到它提供的工具' },
  { label: 'Connected', state: 'connected', reason: null },
  { label: 'Needs authentication', state: 'failed', reason: '还没登录这个服务' },
  { label: 'Not configured', state: 'failed', reason: '这条连接没有填地址' },
  { label: 'Failed to connect', state: 'failed', reason: '启动失败' },
  { label: 'Connection error', state: 'failed', reason: '连接时出错' },
  { label: 'Pending approval', state: 'unknown', reason: '这条连接还没在工具里确认过，本次没有检测' },
  { label: 'Rejected', state: 'failed', reason: '这条连接已被拒绝' },
  { label: 'Disabled for this project', state: 'unknown', reason: '这条连接在当前目录下已停用，本次没有检测' },
]

/** Gemini CLI 0.60.0 把这五个词原样打在行尾。 */
const GEMINI_MCP_HEALTH_LABELS: readonly McpHealthLabel[] = [
  { label: 'Connected', state: 'connected', reason: null },
  { label: 'Connecting', state: 'unknown', reason: '还在连接中，稍后再检测一次' },
  { label: 'Blocked', state: 'failed', reason: '被当前工具的策略拦下了' },
  { label: 'Disabled', state: 'unknown', reason: '这条连接已在工具里停用，本次没有检测' },
  { label: 'Disconnected', state: 'failed', reason: '连不上' },
]

/** 目录未被信任时 Gemini 会把用户级连接一并停用，那时的 Disabled 不是用户关的。 */
const GEMINI_UNTRUSTED_MARKER = 'because this folder is untrusted'
const GEMINI_UNTRUSTED_REASON = '当前工具把这个目录当作不受信任的目录，连接被一并停用，本次没有检测'

/** 两家在非终端下都不上色，但输出被别的壳层接过一手时仍可能带上色彩序列。 */
function healthLines(output: string): string[] {
  return cleanCommandOutput(output).replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd())
}

function cleanHealthDetail(value: string): string | null {
  const result = value.replace(/^[\s—–·:-]+/, '').trim()
  return result ? result.slice(0, MAX_TEXT_LENGTH) : null
}

function healthEntry(id: string, label: McpHealthLabel, issue: string | null): ProviderMcpHealthEntry {
  const detail = issue && label.reason ? `${label.reason}：${issue}` : issue ?? label.reason
  return { id, state: label.state, detail }
}

/**
 * Claude 的行是 `<名字>: <目标> - <符号> <状态>[ — <原因>]`，而目标里本来就可能
 * 出现 ` - `（`npx -y pkg - foo`），所以状态不能靠「最后一个 ` - `」去切，
 * 只能按已知状态词回头核对它前面确实是那个分隔符。
 */
function claudeHealthLabelAt(line: string, label: string): number {
  let index = line.indexOf(label)
  while (index >= 0) {
    if (/\s-\s(?:\S+\s)?$/.test(line.slice(0, index))) return index
    index = line.indexOf(label, index + 1)
  }
  return -1
}

export function parseClaudeMcpHealth(output: string): ProviderMcpHealthEntry[] {
  const entries: ProviderMcpHealthEntry[] = []
  for (const line of healthLines(output)) {
    const name = line.match(/^(.+?):\s/)
    if (!name) continue
    for (const label of CLAUDE_MCP_HEALTH_LABELS) {
      const index = claudeHealthLabelAt(line, label.label)
      if (index < 0) continue
      const rest = line.slice(index + label.label.length)
      const issue = rest.match(/\s—\s(.+)$/)
      entries.push(healthEntry(name[1].trim(), label, issue ? cleanHealthDetail(issue[1]) : null))
      break
    }
  }
  return entries
}

export function parseGeminiMcpHealth(output: string): ProviderMcpHealthEntry[] {
  const untrusted = output.includes(GEMINI_UNTRUSTED_MARKER)
  const entries: ProviderMcpHealthEntry[] = []
  for (const line of healthLines(output)) {
    // 行尾那个词就是状态，`(from 某扩展)` 是名字自带的后缀，不属于连接名。
    const parsed = line.match(
      /^(?:\S+\s+)?(.+?)(?:\s\(from\s[^)]*\))?:\s.*\s-\s(Connected|Connecting|Blocked|Disabled|Disconnected)$/,
    )
    if (!parsed) continue
    const label = GEMINI_MCP_HEALTH_LABELS.find((entry) => entry.label === parsed[2])
    if (!label) continue
    const untrustedDisable = untrusted && label.label === 'Disabled'
    entries.push(healthEntry(
      parsed[1].trim(),
      untrustedDisable ? { ...label, reason: GEMINI_UNTRUSTED_REASON } : label,
      null,
    ))
  }
  return entries
}

export function providerCommandResolutionOrder(
  provider: ProviderId,
  platform: NodeJS.Platform = process.platform,
): readonly ['package' | 'direct', 'package' | 'direct'] {
  if (platform !== 'win32') return ['direct', 'package']
  // Codex Desktop also exposes codex.exe. The npm package entry is the
  // authoritative CLI for npm-managed providers and avoids that name collision.
  return provider === 'grok' ? ['direct', 'package'] : ['package', 'direct']
}

export function packageCommandExecutionMode(
  commandPath: string,
  platform: NodeJS.Platform = process.platform,
): 'native' | 'node' {
  return platform === 'win32' && path.extname(commandPath).toLowerCase() === '.exe'
    ? 'native'
    : 'node'
}

export async function resolveProviderCommand(
  provider: ProviderId,
  env: NodeJS.ProcessEnv,
  windowsExecutionMode: WindowsCliExecutionMode = 'trusted-only',
): Promise<ResolvedCliCommand> {
  return resolveCliCommand(provider, env, windowsExecutionMode, {
    darwinStagingRetention: 'ephemeral',
  })
}

function defaultProviderInvoker(
  envInput: NodeJS.ProcessEnv,
  codexEnvInput: NodeJS.ProcessEnv,
  windowsExecutionMode: WindowsCliExecutionMode,
  resolveCommand: typeof resolveProviderCommand = resolveProviderCommand,
  runCommandImplementation: typeof runCommand = runCommand,
): ProviderCliInvoker {
  const env = commandEnvironment(envInput)
  const codexEnv = commandEnvironment(codexEnvInput)
  return async (provider, argv, options = {}) => {
    const baseEnv = provider === 'codex' ? codexEnv : env
    // 解析命令用的是不带代理变量的基底：代理只影响子进程怎么出网，不该参与
    // 「这个可执行文件在哪」的判断。
    const base = await resolveCommand(provider, baseEnv, windowsExecutionMode)
    const providerEnv = options.extraEnvironment
      ? { ...baseEnv, ...options.extraEnvironment }
      : baseEnv
    const command = {
      executable: base.executable,
      argv: [...base.argv, ...argv],
    }
    const trustedOnly = process.platform === 'win32' && windowsExecutionMode === 'trusted-only'
    if (trustedOnly) {
      assertTrustedElevatedCliCommand(command, `${cliCatalog[provider].name} 扩展管理`, { env: providerEnv })
    }
    const runOptions: RunCommandOptions = {
      cwd: options.cwd,
      env: providerEnv,
      trustedOnly,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
      sensitiveValues: options.sensitiveValues,
    }
    try {
      const result = await runCommandImplementation(command, runOptions)
      return selectProviderCommandOutput(result.stdout, result.stderr)
    } finally {
      await base.release?.()
    }
  }
}

/** Gemini management commands currently log machine-readable output through stderr. */
export function selectProviderCommandOutput(stdout: string, stderr: string): string {
  return stdout.trim() ? stdout : stderr
}

function registryVersionUrl(kind: 'npm' | 'pypi', locator: string): string {
  const value = locator.trim()
  if (!value || value.length > 512) throw new Error('扩展包名称格式错误')
  if (kind === 'npm') {
    if (!/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(value)) {
      throw new Error('npm 包名称格式错误')
    }
    return new URL(`${encodeURIComponent(value)}/latest`, OFFICIAL_NPM_REGISTRY).href
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) throw new Error('PyPI 包名称格式错误')
  return new URL(`/pypi/${encodeURIComponent(value)}/json`, OFFICIAL_PYPI_ORIGIN).href
}

function assertExactProviderResponseUrl(responseUrl: string, expectedUrl: string): void {
  let actual: URL
  let expected: URL
  try {
    actual = new URL(responseUrl)
    expected = new URL(expectedUrl)
  } catch {
    throw new Error('远端版本响应地址无效')
  }
  if (
    actual.href !== expected.href
    || actual.protocol !== 'https:'
    || actual.username
    || actual.password
    || actual.port
  ) {
    throw new Error('远端版本查询发生了不受信任的重定向')
  }
}

async function fetchJsonWithLimit(
  url: string,
  fetchImplementation: typeof globalThis.fetch,
  timeoutMs = PROVIDER_VERSION_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('远端版本查询超时')), timeoutMs)
  timeout.unref?.()
  try {
    const response = await fetchImplementation(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    })
    assertExactProviderResponseUrl(response.url, url)
    if (!response.ok) throw new Error(`远端返回 ${response.status}`)
    const body = await readBoundedResponseText(
      response,
      MAX_PROVIDER_VERSION_RESPONSE_BYTES,
      '远端版本',
    )
    return JSON.parse(body) as unknown
  } finally {
    clearTimeout(timeout)
  }
}

export function normalizeGitHubRemoteUrl(locator: string): string {
  const value = locator.trim()
  let owner = ''
  let repository = ''
  const shorthand = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(value)
  if (shorthand) {
    owner = shorthand[1]
    repository = shorthand[2]
  } else {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new UnsupportedSourceInspectionError('Git 更新检查只支持 GitHub HTTPS 或 SSH remote')
    }
    const https = parsed.protocol === 'https:'
    const ssh = parsed.protocol === 'ssh:'
    if (!https && !ssh) {
      throw new UnsupportedSourceInspectionError('Git 更新检查只支持 GitHub HTTPS 或 SSH remote')
    }
    if (
      (https && (parsed.username || parsed.password))
      || (ssh && ((parsed.username && parsed.username !== 'git') || parsed.password))
    ) {
      throw new UnsupportedSourceInspectionError('Git 更新检查只支持不含凭据的 GitHub remote')
    }
    if (
      parsed.hostname.toLowerCase() !== 'github.com'
      || parsed.port
      || parsed.search
      || parsed.hash
    ) {
      throw new UnsupportedSourceInspectionError('Git 更新检查只支持不含凭据的 GitHub remote')
    }
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length !== 2) {
      throw new UnsupportedSourceInspectionError('GitHub remote 必须指向 owner/repository')
    }
    ;[owner, repository] = segments
  }
  repository = repository.replace(/\.git$/i, '')
  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner)
    || !/^[A-Za-z0-9_.-]+$/.test(repository)
    || owner === '.'
    || owner === '..'
    || repository === '.'
    || repository === '..'
  ) {
    throw new UnsupportedSourceInspectionError('GitHub remote 的 owner 或 repository 格式错误')
  }
  return `${OFFICIAL_GITHUB_ORIGIN}/${owner}/${repository}.git`
}

export function parseGitRemoteHead(output: string): string | null {
  const value = output.trim()
  if (!value) return null
  const match = /^([0-9a-f]{40}|[0-9a-f]{64})\s+HEAD$/i.exec(value)
  if (!match) throw new Error('GitHub 返回了无效的 HEAD 引用')
  return match[1].toLowerCase()
}

interface LocalGitMetadata {
  currentVersion: string
  locator: string
}

function plainGitDirectory(directory: string): string {
  const stats = fs.lstatSync(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Git 元数据目录不是普通目录')
  }
  const canonical = fs.realpathSync(directory)
  if (!sameLocalPathIdentity(canonical, directory)) {
    throw new Error('Git 元数据目录不能经过符号链接或目录联接')
  }
  return canonical
}

function optionalGitFile(filePath: string, maximumBytes: number, label: string): string | null {
  try {
    return readBoundedUtf8FileSync(filePath, maximumBytes, label)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function resolveGitDirectory(localPath: string): string {
  const marker = path.join(path.resolve(localPath), '.git')
  const markerStats = fs.lstatSync(marker)
  if (markerStats.isDirectory() && !markerStats.isSymbolicLink()) return plainGitDirectory(marker)
  if (!markerStats.isFile() || markerStats.isSymbolicLink() || markerStats.nlink !== 1) {
    throw new Error('Git 元数据入口格式错误')
  }
  const pointer = readBoundedUtf8FileSync(marker, MAX_GIT_POINTER_BYTES, 'Git .git 指针').trim()
  const match = /^gitdir:\s*(.+)$/i.exec(pointer)
  if (!match || !match[1].trim() || match[1].includes('\0')) {
    throw new Error('Git .git 指针格式错误')
  }
  return plainGitDirectory(path.resolve(path.dirname(marker), match[1].trim()))
}

function resolveGitCommonDirectory(gitDirectory: string): string {
  const pointer = optionalGitFile(
    path.join(gitDirectory, 'commondir'),
    MAX_GIT_POINTER_BYTES,
    'Git commondir',
  )?.trim()
  if (!pointer) return gitDirectory
  if (pointer.includes('\0')) throw new Error('Git commondir 格式错误')
  return plainGitDirectory(path.resolve(gitDirectory, pointer))
}

function parseGitCommit(value: string, label: string): string {
  const normalized = value.trim()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(normalized)) {
    throw new Error(`${label}不是有效提交哈希`)
  }
  return normalized.toLowerCase()
}

function safeGitRefPath(commonDirectory: string, reference: string): string {
  if (
    !reference.startsWith('refs/')
    || reference.length > 1_024
    || reference.includes('\0')
    || reference.includes('\\')
    || reference.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Git HEAD 引用格式错误')
  }
  const candidate = path.resolve(commonDirectory, ...reference.split('/'))
  if (!pathInside(candidate, commonDirectory)) throw new Error('Git HEAD 引用越过元数据目录')
  return candidate
}

function currentGitCommit(gitDirectory: string, commonDirectory: string): string {
  const head = readBoundedUtf8FileSync(
    path.join(gitDirectory, 'HEAD'),
    MAX_GIT_POINTER_BYTES,
    'Git HEAD',
  ).trim()
  if (!head.toLowerCase().startsWith('ref:')) return parseGitCommit(head, 'Git HEAD')
  const reference = head.slice(4).trim()
  const loose = optionalGitFile(
    safeGitRefPath(commonDirectory, reference),
    MAX_GIT_POINTER_BYTES,
    'Git 引用',
  )
  if (loose !== null) return parseGitCommit(loose, 'Git 引用')
  const packed = optionalGitFile(
    path.join(commonDirectory, 'packed-refs'),
    MAX_GIT_PACKED_REFS_BYTES,
    'Git packed-refs',
  )
  if (packed !== null) {
    for (const line of packed.split(/\r?\n/)) {
      const match = /^([0-9a-f]{40}|[0-9a-f]{64})\s+(.+)$/i.exec(line.trim())
      if (match?.[2] === reference) return parseGitCommit(match[1], 'Git packed-refs')
    }
  }
  throw new Error(`Git 当前引用 ${reference} 没有对应提交`)
}

function gitOriginLocator(commonDirectory: string): string {
  const config = readBoundedUtf8FileSync(
    path.join(commonDirectory, 'config'),
    MAX_GIT_CONFIG_BYTES,
    'Git config',
  )
  let inOrigin = false
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = /^\[\s*remote\s+"([^"]+)"\s*\]$/i.exec(line)
    if (section) {
      inOrigin = section[1].toLowerCase() === 'origin'
      continue
    }
    if (line.startsWith('[')) {
      inOrigin = false
      continue
    }
    if (!inOrigin) continue
    const property = /^url\s*=\s*(.+)$/i.exec(line)
    if (!property) continue
    let value = property[1].trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (!value || value.includes('\0') || value.length > 2_048) break
    return value
  }
  throw new Error('Git 仓库没有可验证的 origin remote')
}

export function readLocalGitMetadata(localPath: string): LocalGitMetadata {
  const gitDirectory = resolveGitDirectory(localPath)
  const commonDirectory = resolveGitCommonDirectory(gitDirectory)
  return {
    currentVersion: currentGitCommit(gitDirectory, commonDirectory),
    locator: gitOriginLocator(commonDirectory),
  }
}

export function createProviderSourceUpdateInspector(
  envInput: NodeJS.ProcessEnv,
  windowsExecutionMode: WindowsCliExecutionMode,
  dependencies: ProviderSourceUpdateDependencies = {},
): SourceUpdateInspector {
  const env = commandEnvironment(envInput)
  const trustedOnly = process.platform === 'win32' && windowsExecutionMode === 'trusted-only'
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch
  const findExecutableImplementation = dependencies.findExecutable ?? findExecutable
  const runCommandImplementation = dependencies.runCommand ?? runCommand
  const platform = dependencies.platform ?? process.platform
  const commandLineToolsShimBacked = dependencies.isCommandLineToolsShimBacked
    ?? ((shim: string) => isCommandLineToolsShimBacked(shim, { env }))
  return async (input) => {
    if (input.kind === 'pypi') {
      const root = await fetchJsonWithLimit(
        registryVersionUrl('pypi', input.locator),
        fetchImplementation,
      )
      const info = isRecord(root) && isRecord(root.info) ? root.info : null
      return { currentVersion: input.currentVersion, latestVersion: nullableText(info?.version) }
    }
    if (input.kind === 'npm') {
      const root = await fetchJsonWithLimit(
        registryVersionUrl('npm', input.locator),
        fetchImplementation,
      )
      return {
        currentVersion: input.currentVersion,
        latestVersion: isRecord(root) ? nullableText(root.version) : null,
      }
    }
    if (!input.localPath) return { currentVersion: input.currentVersion, latestVersion: null }
    const git = await findExecutableImplementation('git', { env, trustedOnly })
    if (!git) {
      throw new UnsupportedSourceInspectionError(
        trustedOnly ? '高权限扩展更新检查未找到受信任的 Git' : '未检测到 Git',
      )
    }
    // 进外接工具页就会自动查更新：没装命令行开发者工具的 Mac 上跑空壳 git 会弹系统对话框。
    if (isMacOsCommandLineToolsShim(git, platform) && !await commandLineToolsShimBacked(git)) {
      throw new UnsupportedSourceInspectionError('未检测到可用的 Git：需要先装 macOS 的命令行开发者工具')
    }
    const runGit = async (argv: string[]) => (await runCommandImplementation(
      { executable: git, argv },
      {
        cwd: path.dirname(git),
        env: {
          ...(trustedOnly ? trustedCommandEnvironment(env) : commandEnvironment(env)),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_CONFIG_COUNT: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
          GCM_INTERACTIVE: 'Never',
        },
        trustedOnly,
        timeoutMs: 15_000,
        maxOutputBytes: 256 * 1024,
      },
    )).stdout.trim()
    const local = readLocalGitMetadata(input.localPath)
    const currentVersion = local.currentVersion
    const locator = normalizeGitHubRemoteUrl(local.locator)
    const remote = await runGit([
      '-c', 'http.followRedirects=false',
      '-c', 'credential.helper=',
      '-c', 'core.askPass=',
      'ls-remote', locator, 'HEAD',
    ])
    const latestVersion = parseGitRemoteHead(remote)
    return { currentVersion, latestVersion, locator }
  }
}

function categoryCapabilities(): Record<ProviderExtensionKind, ProviderExtensionCategoryCapability> {
  return {
    mcp: { list: true, reason: null },
    skill: { list: true, reason: null },
    plugin: { list: true, reason: null },
  }
}

function publicItem(item: MutableExtensionItem): ProviderExtensionItem {
  const { sourceLocalPath: _sourceLocalPath, ...result } = item
  return result
}

export class ProviderExtensionService {
  private readonly homeDirectory: string
  private readonly codexHome: string
  private repositoryRoot: string | null
  private readonly invoke: ProviderCliInvoker
  private readonly inspectSource: SourceUpdateInspector
  private readonly now: () => Date
  private readonly env: NodeJS.ProcessEnv
  private readonly trustedOnly: boolean
  private readonly findExecutable: typeof findExecutable
  private readonly resolveSubprocessProxyEnvironment: () => Promise<NodeJS.ProcessEnv>
  private readonly downloadFetch: typeof fetch
  private readonly acquireDownloadAcceleration: (() => Promise<DownloadAccelerationLease>) | null
  private codexCatalogDownload: Promise<void> | null = null
  private readonly platform: NodeJS.Platform
  private readonly commandLineToolsShimBacked: (shim: string) => Promise<boolean>

  constructor(options: ProviderExtensionServiceOptions = {}) {
    this.homeDirectory = path.resolve(options.homeDirectory ?? os.homedir())
    this.codexHome = path.resolve(options.codexHome ?? path.join(this.homeDirectory, '.codex'))
    this.repositoryRoot = options.repositoryRoot ? path.resolve(options.repositoryRoot) : null
    const env = options.env ?? process.env
    const codexEnv = options.codexEnv ?? env
    const windowsExecutionMode = options.windowsExecutionMode ?? 'trusted-only'
    this.invoke = options.invoke ?? defaultProviderInvoker(
      env,
      codexEnv,
      windowsExecutionMode,
      options.resolveCommand,
      options.runCommand,
    )
    this.inspectSource = options.inspectSource ?? createProviderSourceUpdateInspector(
      env,
      windowsExecutionMode,
      options.sourceUpdateDependencies,
    )
    this.now = options.now ?? (() => new Date())
    this.env = env
    this.trustedOnly = process.platform === 'win32' && windowsExecutionMode === 'trusted-only'
    this.findExecutable = options.findExecutable ?? findExecutable
    this.resolveSubprocessProxyEnvironment = options.resolveSubprocessProxyEnvironment
      ?? (async () => ({}))
    this.downloadFetch = options.downloadFetch ?? fetch
    this.acquireDownloadAcceleration = options.acquireDownloadAcceleration ?? null
    this.platform = options.platform ?? process.platform
    this.commandLineToolsShimBacked = options.isCommandLineToolsShimBacked
      ?? ((shim) => isCommandLineToolsShimBacked(shim, { env }))
  }

  /** macOS 自带的 git / python3 空壳背后没有真货时，对用户而言就是没装。 */
  private async isUnbackedCommandLineToolsShim(executable: string): Promise<boolean> {
    return isMacOsCommandLineToolsShim(executable, this.platform)
      && !await this.commandLineToolsShimBacked(executable)
  }

  /**
   * 加速只接管系统代理，而 CLI 子进程不读系统代理，所以出网的扩展操作要把
   * 当前线路以环境变量的形式带下去。解析失败按直连走，与加速关掉时一致。
   */
  private async networkEnvironment(): Promise<NodeJS.ProcessEnv> {
    try {
      return await this.resolveSubprocessProxyEnvironment()
    } catch {
      return {}
    }
  }

  /**
   * 社区里一半的 MCP 是 `uvx` 起的，而本应用把 Python 定义成可选环境，多数机器上
   * 没有。添加这类连接之前要能先说一句，所以每份快照都带上这两样在不在。
   */
  private async inspectExtensionRuntimes(): Promise<ProviderExtensionRuntimeAvailability> {
    const options = { env: this.env, trustedOnly: this.trustedOnly }
    const [python, uv] = await Promise.all([
      Promise.all(['python3', 'python', 'py'].map((name) => this.findExecutable(name, options))),
      Promise.all(['uvx', 'uv'].map((name) => this.findExecutable(name, options))),
    ])
    return {
      python: await this.anyUsableExecutable(python),
      uv: uv.some((entry) => entry !== null),
    }
  }

  private async anyUsableExecutable(candidates: readonly (string | null)[]): Promise<boolean> {
    for (const candidate of candidates) {
      if (candidate && !await this.isUnbackedCommandLineToolsShim(candidate)) return true
    }
    return false
  }

  private async inspectClaudeMarketplaces(): Promise<{ names: string[]; reason: string | null }> {
    try {
      const output = await this.invoke('claude', claudeMarketplaceListArgv(), {
        maxOutputBytes: MAX_OUTPUT_BYTES,
      })
      return { names: parseClaudeMarketplaceNames(output), reason: null }
    } catch (error) {
      return {
        names: readClaudeSettingsMarketplaceNames(this.homeDirectory),
        reason: `Claude Code 插件市场列表读取失败：${errorDetail(error)}`,
      }
    }
  }

  /**
   * 装插件前保证官方市场在册。市场已在册时什么都不做——`marketplace add`
   * 自己是幂等的，但它要 Git，而已经在册的机器本来不需要 Git 就能装。
   */
  private async ensureClaudeOfficialMarketplace(): Promise<void> {
    const { names } = await this.inspectClaudeMarketplaces()
    if (names.includes(CLAUDE_OFFICIAL_MARKETPLACE_NAME)) return
    const git = await this.findExecutable('git', { env: this.env, trustedOnly: this.trustedOnly })
    if (!git) throw new Error(claudeMarketplaceGitMissingMessage())
    if (await this.isUnbackedCommandLineToolsShim(git)) {
      throw new Error(claudeMarketplaceGitMissingMessage(this.platform, { commandLineToolsShim: true }))
    }
    await this.invoke('claude', claudeOfficialMarketplaceAddArgv(), {
      timeoutMs: MARKETPLACE_ADD_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      extraEnvironment: await this.networkEnvironment(),
    })
  }

  setRepositoryRoot(repositoryRoot: string | null): void {
    this.repositoryRoot = repositoryRoot ? path.resolve(repositoryRoot) : null
  }

  private async enrichUpdates(items: MutableExtensionItem[], checkedAt: string): Promise<void> {
    const inspections = new Map<string, Promise<SourceUpdateInspectionResult>>()
    for (const item of items) {
      if (item.kind === 'plugin' || !['npm', 'pypi', 'git'].includes(item.source.kind)) continue
      if ((item.source.kind === 'npm' || item.source.kind === 'pypi') && !item.currentVersion) {
        item.update = {
          state: 'unsupported',
          reason: 'MCP 来源未固定版本，无法确定当前实际版本',
          checkedAt,
        }
        continue
      }
      try {
        const input: SourceUpdateInspectionInput = {
          kind: item.source.kind as 'npm' | 'pypi' | 'git',
          locator: item.source.locator ?? item.sourceLocalPath ?? '',
          currentVersion: item.currentVersion,
          localPath: item.sourceLocalPath,
        }
        const key = JSON.stringify([input.kind, input.locator, input.currentVersion, input.localPath ?? ''])
        let pending = inspections.get(key)
        if (!pending) {
          pending = this.inspectSource(input)
          inspections.set(key, pending)
        }
        const inspection = await pending
        item.currentVersion = inspection.currentVersion
        item.latestVersion = inspection.latestVersion
        item.source.reference = inspection.currentVersion
        if (inspection.locator) item.source.locator = inspection.locator
        item.update = versionUpdate(
          inspection.currentVersion,
          inspection.latestVersion,
          checkedAt,
          item.source.kind,
        )
      } catch (error) {
        item.update = {
          state: error instanceof UnsupportedSourceInspectionError ? 'unsupported' : 'check-failed',
          reason: `远端版本查询失败：${errorDetail(error)}`,
          checkedAt,
        }
      }
    }
  }

  async list(provider: ProviderId): Promise<ProviderExtensionsSnapshot> {
    if (!providerIds.includes(provider)) throw new Error('未知的 Provider')
    const checkedAt = this.now().toISOString()
    const capabilities = categoryCapabilities()
    const warnings: string[] = []
    const items: MutableExtensionItem[] = []

    try {
      const argv = mcpListArgv(provider)
      let servers: RawMcpServer[]
      if (argv) {
        servers = parseMcpJson(await this.invoke(provider, argv, { maxOutputBytes: MAX_OUTPUT_BYTES }))
      } else {
        const configured = readConfiguredMcpServers(provider as 'claude' | 'gemini', this.homeDirectory, this.repositoryRoot)
        servers = configured.servers
        warnings.push(...configured.warnings.map((warning) => `${cliCatalog[provider].name} ${warning}`))
      }
      items.push(...servers.map((server) => mcpItem(provider, server)))
    } catch (error) {
      const reason = `MCP 列表读取失败：${errorDetail(error)}`
      capabilities.mcp = { list: false, reason }
      warnings.push(`${cliCatalog[provider].name} ${reason}`)
    }

    try {
      if (provider === 'gemini') {
        const output = await this.invoke(provider, ['skills', 'list', '--all'], {
          cwd: this.repositoryRoot ?? undefined,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        })
        items.push(...parseGeminiSkillList(output, this.homeDirectory, this.repositoryRoot))
      } else {
        items.push(...scanSkills(provider, this.homeDirectory, this.codexHome, this.repositoryRoot))
      }
    } catch (error) {
      const reason = `${provider === 'gemini' ? 'Gemini CLI Skill 状态' : 'Skill 目录'}读取失败：${errorDetail(error)}`
      capabilities.skill = { list: false, reason }
      warnings.push(`${cliCatalog[provider].name} ${reason}`)
    }

    try {
      const output = await this.invoke(provider, pluginListArgv(provider), {
        cwd: provider === 'gemini' ? this.repositoryRoot ?? undefined : undefined,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      })
      const plugins = parseProviderPluginList(
        provider,
        output,
        checkedAt,
        provider === 'gemini' ? (this.repositoryRoot ? 'workspace' : 'user') : null,
      )
      if (provider === 'codex') describeCodexCatalogPlugins(plugins, this.codexHome)
      items.push(...plugins)
    } catch (error) {
      const noun = provider === 'gemini' ? 'Extension' : 'Plugin'
      const reason = `${cliCatalog[provider].name} ${noun} 列表读取失败：${errorDetail(error)}`
      capabilities.plugin = { list: false, reason }
      warnings.push(reason)
    }

    // 没有官方市场时 `plugin list --available` 只会返回空清单，界面必须能分辨
    // 「这里没有可装的」和「市场还没加进来」。
    let marketplace: ProviderExtensionMarketplaceState | undefined
    if (provider === 'claude') {
      const inspection = await this.inspectClaudeMarketplaces()
      marketplace = {
        name: CLAUDE_OFFICIAL_MARKETPLACE_NAME,
        registered: inspection.names.includes(CLAUDE_OFFICIAL_MARKETPLACE_NAME),
        reason: inspection.reason,
      }
    } else if (provider === 'codex') {
      marketplace = {
        name: CODEX_API_CURATED_MARKETPLACE_NAME,
        registered: inspectCodexPluginCatalog(this.codexHome).present,
        reason: null,
      }
    }

    await this.enrichUpdates(items, checkedAt)
    return {
      provider,
      checkedAt,
      capabilities,
      items: items.map(publicItem),
      warnings,
      ...(marketplace ? { marketplace } : {}),
      runtimes: await this.inspectExtensionRuntimes(),
    }
  }

  /**
   * 用户点「重新检测」或进入外接工具页时读一次。不放进 list()：这条命令会把每个
   * 本地 MCP 真的拉起来一次，而 list() 在每次安装、卸载、开关之后都会重跑。
   */
  async checkMcpHealth(provider: ProviderId): Promise<ProviderMcpHealthReport> {
    if (!providerIds.includes(provider)) throw new Error('未知的 Provider')
    const checkedAt = this.now().toISOString()
    const argv = mcpHealthArgv(provider)
    if (!argv) {
      return {
        provider,
        checkedAt,
        supported: false,
        reason: `${cliCatalog[provider].name} 没有提供连接状态，这里只显示配置里有哪些连接。`,
        entries: [],
      }
    }
    try {
      const output = await this.invoke(provider, argv, {
        cwd: this.repositoryRoot ?? undefined,
        timeoutMs: MCP_HEALTH_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      })
      return {
        provider,
        checkedAt,
        supported: true,
        reason: null,
        entries: provider === 'claude'
          ? parseClaudeMcpHealth(output)
          : parseGeminiMcpHealth(output),
      }
    } catch (error) {
      return {
        provider,
        checkedAt,
        supported: true,
        reason: `连接状态检测没有完成：${errorDetail(error)}`,
        entries: [],
      }
    }
  }

  async listAll(): Promise<ProviderExtensionsSnapshot[]> {
    return Promise.all(providerIds.map((provider) => this.list(provider)))
  }

  /**
   * 手动把官方市场加进来。没有市场时可装清单是空的，用户也就无从触发那次
   * 安装时的自动注册，界面必须给一条自己能走通的路。
   */
  async ensureMarketplace(provider: ProviderId): Promise<ProviderExtensionsSnapshot> {
    if (provider === 'claude') await this.ensureClaudeOfficialMarketplace()
    else if (provider === 'codex') await this.ensureCodexPluginCatalog()
    else throw new Error('当前工具没有官方插件市场')
    return this.list(provider)
  }

  /** 连点两下、两个页面同时触发，都只下载一次。 */
  private ensureCodexPluginCatalog(): Promise<void> {
    if (!this.codexCatalogDownload) {
      this.codexCatalogDownload = this.downloadCodexPluginCatalog()
        .finally(() => { this.codexCatalogDownload = null })
    }
    return this.codexCatalogDownload
  }

  private async downloadCodexPluginCatalog(): Promise<void> {
    if (inspectCodexPluginCatalog(this.codexHome).present) return
    // 借不到线路就按直连下载：加速是加分项，不能变成下载的前置条件。
    const lease = this.acquireDownloadAcceleration
      ? await this.acquireDownloadAcceleration().catch(() => null)
      : null
    try {
      await ensureCodexPluginCatalog({ codexHome: this.codexHome, fetch: this.downloadFetch })
    } finally {
      await lease?.release().catch(() => undefined)
    }
  }

  private mcpInstallArgv(input: ProviderExtensionMutation, id: string): { argv: string[]; secrets: string[] } {
    const config = input.mcp
    if (!config) throw new Error('安装 MCP 需要结构化配置')
    const scope = normalizeScope(input.provider, input.scope, 'mcp')
    if (config.type === 'http') {
      const url = safeUrl(config.url)
      if (input.provider === 'codex') return { argv: ['mcp', 'add', id, '--url', url], secrets: [] }
      return { argv: ['mcp', 'add', '--transport', 'http', '--scope', scope, id, url], secrets: [] }
    }
    const command = safeIdentifier(config.command, 'MCP 命令')
    const args = (config.args ?? []).map((entry) => {
      if (entry.includes('\0') || entry.length > MAX_TEXT_LENGTH) throw new Error('MCP 参数格式错误')
      return entry
    })
    const envEntries = Object.entries(config.env ?? {})
    const secrets = envEntries.map(([, value]) => value).filter(Boolean)
    const envArgs = envEntries.flatMap(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) throw new Error('MCP 环境变量格式错误')
      return ['--env', `${key}=${value}`]
    })
    // Every branch terminates its own option list with '--' before the user-supplied
    // command and its arguments. `args` comes straight from IPC and legitimately
    // contains leading-dash entries (`npx -y <pkg>` is the most common MCP recipe),
    // so without the separator a pasted config carrying `--trust`, `--scope` or
    // `--include-tools` would be parsed as a flag of the CLI itself and silently
    // rewrite the server's trust level or tool allowlist.
    if (input.provider === 'codex') return { argv: ['mcp', 'add', id, ...envArgs, '--', command, ...args], secrets }
    if (input.provider === 'claude') return { argv: ['mcp', 'add', '--scope', scope, id, ...envArgs, '--', command, ...args], secrets }
    if (input.provider === 'gemini') return { argv: ['mcp', 'add', '--scope', scope, '--transport', 'stdio', ...envArgs, id, command, '--', ...args], secrets }
    return { argv: ['mcp', 'add', '--scope', scope, ...envArgs, id, '--', command, ...args], secrets }
  }

  private mutationArgv(input: ProviderExtensionMutation): { argv: string[]; secrets: string[] } {
    const operations = nativeOperations(input.provider, input.kind)
    if (!operations[input.action]) throw new Error('当前 Provider 不支持该原生操作')
    const id = input.action === 'install' && input.kind !== 'mcp'
      ? input.id ? safeIdentifier(input.id, '扩展 ID') : null
      : safeIdentifier(input.id, '扩展 ID')
    const scope = normalizeScope(input.provider, input.scope, input.kind)

    if (input.kind === 'mcp') {
      if (input.action === 'install') return this.mcpInstallArgv(input, safeIdentifier(input.id, 'MCP 名称'))
      if (input.action === 'uninstall') {
        return input.provider === 'codex'
          ? { argv: ['mcp', 'remove', id!], secrets: [] }
          : { argv: ['mcp', 'remove', '--scope', scope, id!], secrets: [] }
      }
      return { argv: ['mcp', input.action, id!], secrets: [] }
    }

    if (input.kind === 'skill') {
      if (input.provider !== 'gemini') throw new Error('当前 Provider 没有原生 Skill 管理命令')
      if (input.action === 'install') {
        return { argv: ['skills', 'install', safeSource(input.source), '--scope', scope, '--consent'], secrets: [] }
      }
      const argv = ['skills', input.action, id!]
      if (input.action === 'uninstall' || input.action === 'disable') argv.push('--scope', scope)
      return { argv, secrets: [] }
    }

    if (input.provider === 'codex') {
      return { argv: ['plugin', input.action === 'install' ? 'add' : 'remove', id ?? safeSource(input.source), '--json'], secrets: [] }
    }
    const command = input.provider === 'gemini' ? 'extensions' : 'plugin'
    if (input.action === 'install') {
      return { argv: [command, 'install', safeSource(id ?? input.source)], secrets: [] }
    }
    if (input.provider === 'gemini') {
      const argv = [command, input.action, id!]
      if (input.action === 'enable' || input.action === 'disable') argv.push('--scope', scope)
      if (input.action === 'update' && !id) argv.push('--all')
      return { argv, secrets: [] }
    }
    const argv = [command, input.action === 'uninstall' ? 'uninstall' : input.action, id!]
    if (input.provider === 'claude') argv.push('--scope', scope)
    return { argv, secrets: [] }
  }

  async mutate(input: ProviderExtensionMutation): Promise<ProviderExtensionsSnapshot> {
    if (!providerIds.includes(input.provider)) throw new Error('未知的 Provider')
    const { argv, secrets } = this.mutationArgv(input)
    if (input.provider === 'claude' && input.kind === 'plugin' && input.action === 'install') {
      await this.ensureClaudeOfficialMarketplace()
    }
    await this.invoke(input.provider, argv, {
      cwd: input.provider === 'gemini' ? this.repositoryRoot ?? undefined : undefined,
      timeoutMs: MUTATION_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      sensitiveValues: secrets,
      ...(isNetworkBoundExtensionMutation(input)
        ? { extraEnvironment: await this.networkEnvironment() }
        : {}),
    })
    return this.list(input.provider)
  }
}
