import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import * as TOML from '@iarna/toml'
import { parse as parseYaml } from 'yaml'
import { mapWithConcurrency } from './async-map'
import { readBoundedUtf8File, readBoundedUtf8FileSync } from './bounded-file'
import { DirectoryEntryLimitError, readDirectoryEntries, readDirectoryEntriesSync } from './bounded-directory'
import {
  commandEnvironment,
  findExecutable,
  isUserWritablePath,
  runCommand,
  type CommandSpec,
  type RunCommandOptions,
} from './command-runner'
import {
  resolveCliCommand as resolveVerifiedCliCommand,
  resolveCliInstallation,
  type ResolvedCliCommand,
} from './tool-installation'
import { sameLocalPathIdentity } from './path-identity'
import { resolveRelocatedPath } from './relocated-folders'
import { renameWithTransientRetrySync } from './safe-local-data'
import {
  assertTrustedElevatedCliCommand,
  type WindowsCliExecutionMode,
} from './windows-elevation'
import type { WindowsMachinePaths } from './windows-machine-paths'
import { stageVerifiedNativeCli } from './trusted-native-cli'
import { isCodexDesktopCliInstallation } from './codex-desktop'
import { withCommandOutput } from './extension-command-output'
import { tomlErrorLocation } from './toml-error-location'
import { configBackupSuffix } from './config-file-backups'
import {
  appendTomlText,
  editTomlArrayTableText,
  editTomlTableText,
  mutateCodexConfigToml,
  removeTomlTableText,
  type CodexTomlMutation,
} from './codex-config-toml'
import { describeBrokenConfig } from './broken-config-advice'
import { isRecord } from './input-guards'

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SELECTOR_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SKILL_DIRECTORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_SKILL_FILES = 2_000
const MAX_SKILL_BYTES = 50 * 1024 * 1024
const MAX_SKILL_DISCOVERY_ENTRIES = 10_000
const SKILL_SCAN_CONCURRENCY = 16
const MAX_SKILL_IMPORT_DEPTH = 32
const MAX_CONFIG_BYTES = 2 * 1024 * 1024
const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_SKILL_DEFINITION_BYTES = 2 * 1024 * 1024

export type McpOrigin = 'user' | 'plugin' | 'system'
export type McpTransportType = 'stdio' | 'http'
export type SkillScope = 'user' | 'repo' | 'system'

export interface McpServerDto {
  name: string
  enabled: boolean
  disabledReason: string | null
  transportType: McpTransportType
  command: string | null
  args: string[]
  cwd: string | null
  url: string | null
  envNames: string[]
  inheritedEnvNames: string[]
  httpHeaderNames: string[]
  inheritedHttpHeaderNames: string[]
  bearerTokenEnvVar: string | null
  startupTimeoutSec: number | null
  toolTimeoutSec: number | null
  authStatus: string
  origin: McpOrigin
  editable: boolean
}

export interface StdioMcpInput {
  type: 'stdio'
  name: string
  command: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
}

export interface HttpMcpInput {
  type: 'http'
  name: string
  url: string
  bearerTokenEnvVar?: string
  oauthClientId?: string
  oauthResource?: string
}

export type AddMcpInput = StdioMcpInput | HttpMcpInput

export interface PluginDto {
  pluginId: string
  name: string
  marketplaceName: string
  version: string
  installed: boolean
  enabled: boolean
  installPolicy: string
  authPolicy: string
  sourceType: string
  sourcePath: string | null
}

export interface MarketplaceDto {
  name: string
  root: string
}

export interface PluginCatalogDto {
  plugins: PluginDto[]
  marketplaces: MarketplaceDto[]
  rewriteNotice?: string
}

export interface AddMarketplaceInput {
  source: string
  ref?: string
  sparse?: readonly string[]
}

export interface SkillDto {
  id: string
  name: string
  description: string
  path: string
  scope: SkillScope
  source: 'agents' | 'codex'
  enabled: boolean
  managed: boolean
}

export interface ImportSkillInput {
  sourcePath: string
  scope?: 'user' | 'repo'
}

export interface RepositoryContext {
  repositoryRoot: string | null
}

export interface CodexInvocationOptions {
  sensitiveValues?: readonly string[]
  timeoutMs?: number
  /** 中途停下（扩展页「登录授权」旁的「取消」）：交给 runCommand，连子进程一起结束。 */
  signal?: AbortSignal
}

export type CodexInvoker = (
  argv: readonly string[],
  options?: CodexInvocationOptions,
) => Promise<string>

export interface CodexExtensionServiceOptions {
  userHome?: string
  codexHome?: string
  /** @deprecated Use userHome. */
  homeDirectory?: string
  repositoryRoot?: string | null
  trashDirectory?: string
  configPath?: string
  env?: NodeJS.ProcessEnv
  codexPackageRoot?: string
  invoke?: CodexInvoker
  machinePaths?: WindowsMachinePaths
  windowsExecutionMode?: WindowsCliExecutionMode
  /**
   * 保存配置那一队（system-service.ts 的 serializeToolConfigWrite）。启停插件、技能直接改 config.toml，
   * 保存 Codex 配置正在队里等模型检测时插进来，那边核对配置没被动过就对不上，报「工具配置在模型检测期间
   * 发生变化」（#1157 第 9 条）。缺省 = 不排队，直接写。
   */
  serializeConfigWrite?: <T>(operation: () => Promise<T>) => Promise<T>
  /**
   * 这台电脑装没装 Codex CLI（main.ts 接的是 isCodexCliInstalled）。没装、只装了 Codex 桌面端时，外接工具不跑
   * `codex mcp`，直接读写 config.toml：桌面端和 CLI 读的是同一份。缺省 = 按装了算，照旧跑命令。
   */
  cliInstalled?: () => Promise<boolean>
}

interface SkillRoot {
  path: string
  scope: SkillScope
  source: 'agents' | 'codex'
  managed: boolean
}

interface PlatformTarget {
  packageName: string
  triple: string
  executable: string
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function recordKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort((left, right) => left.localeCompare(right)) : []
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown
    if (isRecord(parsed)) return parsed
  } catch {
    // The caller gets a stable error that never includes command output or secrets.
  }
  throw new Error(`${label} 返回了无效的 JSON`)
}

function parseJsonArray(text: string, label: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) return parsed
  } catch {
    // The caller gets a stable error that never includes command output or secrets.
  }
  throw new Error(`${label} 返回了无效的 JSON`)
}

function normalizedPathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isWithin(parentPath: string, childPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function assertNoSymlinkComponents(targetPath: string, label: string): void {
  // 用户文件夹搬到别的盘时按实际位置逐级检查；不在放行范围内的链接留在路径里，下面照旧拒绝（relocated-folders.ts）。
  const resolved = resolveRelocatedPath(targetPath)
  const root = path.parse(resolved).root
  let current = root
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let info: fs.Stats
    try {
      info = fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(`${label}无法安全检查：${error instanceof Error ? error.message : String(error)}`)
    }
    if (info.isSymbolicLink()) {
      let realPath: string
      try {
        realPath = fs.realpathSync(current)
      } catch {
        throw new Error(`${label}不能经过符号链接`)
      }
      if (!sameLocalPathIdentity(current, realPath)) {
        throw new Error(`${label}不能经过符号链接`)
      }
    }
  }
}

function assertSimpleName(value: string, label: string): string {
  if (!NAME_PATTERN.test(value)) throw new Error(`${label}只能包含字母、数字、下划线和连字符`)
  return value
}

function assertNoNul(value: string, label: string): string {
  if (!value.trim() || value.includes('\0')) throw new Error(`${label}不能为空或包含 NUL 字符`)
  return value
}

function assertOptionalValue(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === '') return undefined
  if (value.includes('\0') || value.length > 4_096) throw new Error(`${label}无效`)
  return value
}

function assertHttpUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('MCP URL 无效')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('MCP URL 仅支持 HTTP 或 HTTPS')
  if (parsed.username || parsed.password) throw new Error('MCP URL 不能包含用户名或密码')
  if (parsed.hash) throw new Error('MCP URL 不能包含片段')
  return parsed.toString()
}

function assertSelector(selector: string): string {
  const parts = selector.split('@')
  if (parts.length !== 2 || parts.some((part) => !SELECTOR_PART_PATTERN.test(part))) {
    throw new Error('Plugin 标识必须使用 plugin@marketplace 格式')
  }
  return selector
}

function assertMarketplaceName(value: string): string {
  if (!SELECTOR_PART_PATTERN.test(value)) throw new Error('市场名称无效')
  return value
}

function assertSparsePath(value: string): string {
  assertNoNul(value, 'Sparse 路径')
  const normalized = value.replace(/\\/g, '/')
  if (
    path.isAbsolute(value)
    || normalized.startsWith('//')
    || /^[A-Za-z]:/.test(value)
    || normalized.split('/').some((part) => part === '..')
  ) {
    throw new Error('Sparse 路径必须是仓库内的相对路径')
  }
  return normalized.replace(/^\.\//, '')
}

function assertMarketplaceSource(value: string): string {
  assertNoNul(value, '市场来源')
  if (value.length > 4_096) throw new Error('市场来源过长')
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)) return value
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+(?:\.git)?$/.test(value)) return value
  if (/^ssh:\/\//i.test(value)) {
    const parsed = new URL(value)
    if (parsed.username && parsed.username !== 'git') throw new Error('SSH 市场地址用户名必须为 git')
    if (parsed.password || parsed.hash) throw new Error('SSH 市场地址不能包含密码或片段')
    return value
  }
  if (/^https:\/\//i.test(value)) {
    const parsed = new URL(value)
    if (parsed.username || parsed.password || parsed.hash) throw new Error('HTTPS 市场地址不能包含凭据或片段')
    return value
  }
  if (path.isAbsolute(value) && fs.existsSync(value) && fs.statSync(value).isDirectory()) {
    return path.resolve(value)
  }
  throw new Error('市场来源必须是现有本地目录、owner/repo 或受支持的 Git URL')
}

function platformTarget(): PlatformTarget | null {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc', executable: 'codex.exe' }
  }
  if (process.platform === 'win32' && process.arch === 'arm64') {
    return { packageName: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc', executable: 'codex.exe' }
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin', executable: 'codex' }
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin', executable: 'codex' }
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl', executable: 'codex' }
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl', executable: 'codex' }
  }
  return null
}

function readPackageName(packageRoot: string): string | null {
  try {
    const parsed = JSON.parse(readBoundedUtf8FileSync(
      path.join(packageRoot, 'package.json'),
      MAX_MANIFEST_BYTES,
      'Codex package.json',
    )) as unknown
    return isRecord(parsed) && typeof parsed.name === 'string' ? parsed.name : null
  } catch {
    return null
  }
}

function candidateCodexPackageRoots(
  env: NodeJS.ProcessEnv,
  explicitRoot?: string,
): string[] {
  const candidates = [
    explicitRoot,
    env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex'),
    env.npm_config_prefix && path.join(env.npm_config_prefix, 'node_modules', '@openai', 'codex'),
    env.npm_config_prefix && path.join(env.npm_config_prefix, 'lib', 'node_modules', '@openai', 'codex'),
  ].filter((entry): entry is string => Boolean(entry))
  return [...new Set(candidates.map((entry) => path.resolve(entry)))]
}

/**
 * 和首页同一个判断（system-scan-service.ts 的 inspectCliTool）：找不到，或者找到的只是桌面端自带的 codex.exe，都算
 * 没装。找的过程自己出错时按装了算，照旧去跑命令，由命令报它自己的错。
 */
export async function isCodexCliInstalled(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const installation = await resolveCliInstallation('codex', { env })
    return installation !== null && !isCodexDesktopCliInstallation(installation)
  } catch {
    return true
  }
}

/** Resolves only files rooted in a verified @openai/codex npm installation. */
export async function resolveCodexCommand(
  env: NodeJS.ProcessEnv = process.env,
  explicitPackageRoot?: string,
  machinePaths?: WindowsMachinePaths,
  windowsExecutionMode: WindowsCliExecutionMode = 'trusted-only',
  verifyDarwinStandalone: (
    executablePath: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<ResolvedCliCommand> = async (_executablePath, standaloneEnv) => {
    return resolveVerifiedCliCommand(
      'codex',
      standaloneEnv,
      windowsExecutionMode,
      { darwinStagingRetention: 'ephemeral' },
    )
  },
): Promise<ResolvedCliCommand> {
  const target = platformTarget()
  const discovered = await resolveCliInstallation('codex', { env })
  const roots = [
    ...candidateCodexPackageRoots(env, explicitPackageRoot),
    ...(discovered?.packageRoot ? [discovered.packageRoot] : []),
  ]
  for (const lexicalRoot of [...new Set(roots.map((entry) => path.resolve(entry)))]) {
    if (readPackageName(lexicalRoot) !== '@openai/codex') continue
    let packageRoot: string
    try {
      packageRoot = fs.realpathSync(lexicalRoot)
    } catch {
      continue
    }

    if (target) {
      const platformRoot = path.join(packageRoot, 'node_modules', ...target.packageName.split('/'))
      // OpenAI's platform package currently keeps the manifest name
      // "@openai/codex" even though its npm directory is target-specific.
      if (['@openai/codex', target.packageName].includes(readPackageName(platformRoot) ?? '')) {
        const nativePath = path.join(platformRoot, 'vendor', target.triple, 'bin', target.executable)
        let realNativePath: string | null = null
        try {
          const candidate = fs.realpathSync(nativePath)
          if (isWithin(platformRoot, candidate) && fs.statSync(candidate).isFile()) {
            realNativePath = candidate
          }
        } catch {
          // A trusted JS entrypoint remains a valid fallback.
        }
        if (realNativePath) {
          // Signature/ACL failures are security failures, not a reason to
          // silently fall back to executing user-writable JavaScript.
          const executable = process.platform === 'win32'
            && windowsExecutionMode === 'trusted-only'
            && isUserWritablePath(realNativePath, env, machinePaths)
            ? await stageVerifiedNativeCli('codex', realNativePath, env)
            : realNativePath
          return { executable, argv: [] }
        }
      }
    }

    const scriptPath = path.join(packageRoot, 'bin', 'codex.js')
    try {
      const realScriptPath = fs.realpathSync(scriptPath)
      if (!isWithin(packageRoot, realScriptPath) || !fs.statSync(realScriptPath).isFile()) continue
      const additionalPaths = process.platform !== 'win32'
        && discovered?.packageRoot
        && sameLocalPathIdentity(discovered.packageRoot, packageRoot)
        ? [path.dirname(discovered.commandPath)]
        : []
      const nodeExecutable = await findExecutable('node', { env, additionalPaths })
      if (nodeExecutable) return { executable: nodeExecutable, argv: [realScriptPath] }
    } catch {
      // Continue looking for another verified installation.
    }
  }
  if (process.platform === 'darwin' && discovered?.source === 'native') {
    try {
      return await verifyDarwinStandalone(discovered.commandPath, env)
    } catch {
      // Native PATH entries remain untrusted unless the full standalone check passes.
    }
  }
  throw new Error('未找到受信任的 Codex CLI 安装，请先安装或更新 Codex CLI')
}

function defaultInvoker(options: CodexExtensionServiceOptions): CodexInvoker {
  const env = commandEnvironment(options.env ?? process.env)
  const windowsExecutionMode = options.windowsExecutionMode ?? 'trusted-only'
  return async (argv, invocationOptions = {}) => {
    const base = await resolveCodexCommand(
      env,
      options.codexPackageRoot,
      options.machinePaths,
      windowsExecutionMode,
    )
    const command = {
      executable: base.executable,
      argv: [...base.argv, ...argv],
    }
    const trustedOnly = process.platform === 'win32' && windowsExecutionMode === 'trusted-only'
    if (trustedOnly) {
      assertTrustedElevatedCliCommand(command, 'Codex 扩展管理', {
        env,
        machinePaths: options.machinePaths,
      })
    }
    const runOptions: RunCommandOptions = {
      env,
      trustedOnly,
      timeoutMs: invocationOptions.timeoutMs ?? 60_000,
      maxOutputBytes: 4 * 1024 * 1024,
      sensitiveValues: invocationOptions.sensitiveValues,
      signal: invocationOptions.signal,
      machinePaths: options.machinePaths,
    }
    try {
      const result = await runCommand(command, runOptions)
      return result.stdout
    } finally {
      await base.release?.()
    }
  }
}

function parseTomlFile(filePath: string): Record<string, unknown> {
  assertNoSymlinkComponents(filePath, 'Codex 配置路径')
  let info: fs.Stats
  try {
    info = fs.lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
    throw new Error('Codex config.toml 必须是单链接普通文件')
  }
  // 读文件自己的失败（超过上限、读的时候被换掉、被拒绝访问）照原样抛，那不是「无法解析」。
  const content = readBoundedUtf8FileSync(filePath, MAX_CONFIG_BYTES, 'Codex config.toml')
  try {
    return TOML.parse(content) as Record<string, unknown>
  } catch (error) {
    // 解析器的原话会把出错那行连同上下几行原样抄进来，客户自己加的外接工具的令牌常常
    // 就在旁边。这句会上屏、进运行日志和反馈报告，所以只报第几行（第三十批 B，I13），
    // 再和保存配置那边一样指去「重置为初始状态」（第三十批 C）。
    throw new Error(describeBrokenConfig('Codex', tomlErrorLocation(error)))
  }
}

function configRewriteNotice(backupPath: string | null): string {
  return backupPath
    ? `配置文件已整体重写，手写注释可能丢失，备份位于 ${backupPath}`
    : '配置文件已整体重写，手写注释可能丢失'
}

/**
 * 读、改、写、备份都交给 codex-config-toml.ts，和星芒画图技能、桌面端语言那几处同一套（#1068）。
 * 只动了几行时不提示；没能只动几行、整份重写了才告诉客户注释可能没了、备份在哪。
 */
function mutateConfigToml(
  configPath: string,
  mutation: Pick<CodexTomlMutation, 'mutate' | 'editText'>,
): string | undefined {
  const result = mutateCodexConfigToml(configPath, {
    ...mutation,
    label: 'Codex config.toml',
    // 和读的时候同一句：只报行号，不抄出旁边几行（第三十批 B，I13）。
    unreadable: (error) => describeBrokenConfig('Codex', tomlErrorLocation(error)),
    createIfMissing: true,
  })
  return result.rewritten ? configRewriteNotice(result.backupPath) : undefined
}

function mcpUserNames(configPath: string): Set<string> {
  const config = parseTomlFile(configPath)
  const servers = config.mcp_servers
  return new Set(isRecord(servers) ? Object.keys(servers) : [])
}

/**
 * 一份 config.toml 的 [mcp_servers] 表，按名字取各条原样写的内容，文件不在算空。扩展页拿它给
 * `codex mcp list` 列出来的连接分层（#1092）；路径和文件的检查与读用户那份同一套。
 */
export function readCodexMcpServerEntries(configPath: string): Map<string, unknown> {
  const servers = parseTomlFile(configPath).mcp_servers
  return new Map(isRecord(servers) ? Object.entries(servers) : [])
}

/** config.toml 里的一条，摆成 `codex mcp list --json` 的样子（0.163.0 的 mcp_cmd.rs），好跟命令列出来的过同一道检查。 */
function configuredMcpServer(name: string, entry: unknown): Record<string, unknown> {
  const config = isRecord(entry) ? entry : {}
  const stdio = typeof config.command === 'string'
  return {
    name,
    enabled: config.enabled,
    disabled_reason: null,
    transport: stdio
      ? { type: 'stdio', command: config.command, args: config.args, env: config.env, env_vars: config.env_vars, cwd: config.cwd }
      : {
          type: 'streamable_http',
          url: config.url,
          bearer_token_env_var: config.bearer_token_env_var,
          http_headers: config.http_headers,
          env_http_headers: config.env_http_headers,
        },
    startup_timeout_sec: config.startup_timeout_sec,
    tool_timeout_sec: config.tool_timeout_sec,
    // 登没登录授权要 CLI 去问，没装 CLI 时说不清；只认得出带令牌的。
    auth_status: stdio ? 'unsupported' : typeof config.bearer_token_env_var === 'string' ? 'bearer_token' : 'unknown',
  }
}

function sanitizeMcpServer(
  value: unknown,
  userNames: Set<string>,
  pluginNames: Set<string>,
): McpServerDto {
  if (!isRecord(value)) throw new Error('Codex MCP 列表包含无效条目')
  const name = assertSimpleName(stringValue(value.name), 'MCP 名称')
  const transport = isRecord(value.transport) ? value.transport : {}
  const rawType = stringValue(transport.type)
  const stdio = rawType === 'stdio'
  if (!stdio && rawType !== 'streamable_http' && rawType !== 'http') {
    throw new Error(`MCP ${name} 使用了不支持的传输类型`)
  }
  const origin: McpOrigin = userNames.has(name) ? 'user' : pluginNames.has(name) ? 'plugin' : 'system'
  return {
    name,
    enabled: value.enabled !== false,
    disabledReason: nullableString(value.disabled_reason),
    transportType: stdio ? 'stdio' : 'http',
    command: stdio ? nullableString(transport.command) : null,
    args: stdio ? stringArray(transport.args) : [],
    cwd: stdio ? nullableString(transport.cwd) : null,
    url: stdio ? null : nullableString(transport.url),
    envNames: stdio ? recordKeys(transport.env) : [],
    inheritedEnvNames: stdio ? stringArray(transport.env_vars).sort() : [],
    httpHeaderNames: stdio ? [] : recordKeys(transport.http_headers),
    inheritedHttpHeaderNames: stdio ? [] : recordKeys(transport.env_http_headers),
    bearerTokenEnvVar: stdio ? null : nullableString(transport.bearer_token_env_var),
    startupTimeoutSec: nullableNumber(value.startup_timeout_sec),
    toolTimeoutSec: nullableNumber(value.tool_timeout_sec),
    authStatus: stringValue(value.auth_status, 'unknown'),
    origin,
    editable: origin === 'user',
  }
}

// A failed add is only treated as "persisted before the failure" when the
// listed server carries what was requested. A same-named older entry would
// otherwise make a failed replacement look like it succeeded (#539).
function mcpServerMatchesInput(server: McpServerDto, input: AddMcpInput): boolean {
  if (input.type === 'stdio') {
    const requestedArgs = input.args ?? []
    return server.transportType === 'stdio'
      && server.command === input.command
      && server.args.length === requestedArgs.length
      && server.args.every((argument, index) => argument === requestedArgs[index])
      && sameNames(server.envNames, Object.keys(input.env ?? {}))
  }
  return server.transportType === 'http'
    && server.url !== null
    && sameHttpUrl(server.url, input.url)
    && (server.bearerTokenEnvVar ?? '') === (input.bearerTokenEnvVar ?? '')
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.length === sortedRight.length && sortedLeft.every((name, index) => name === sortedRight[index])
}

function sameHttpUrl(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString()
  } catch {
    return false
  }
}

function pluginDto(value: unknown): PluginDto {
  if (!isRecord(value)) throw new Error('Codex Plugin 列表包含无效条目')
  const source = isRecord(value.source) ? value.source : {}
  return {
    pluginId: assertSelector(stringValue(value.pluginId)),
    name: stringValue(value.name),
    marketplaceName: stringValue(value.marketplaceName),
    version: stringValue(value.version),
    installed: value.installed === true,
    enabled: value.enabled === true,
    installPolicy: stringValue(value.installPolicy),
    authPolicy: stringValue(value.authPolicy),
    sourceType: stringValue(source.source, 'unknown'),
    sourcePath: nullableString(source.path),
  }
}

function parsePluginList(text: string): PluginDto[] {
  const root = parseJsonObject(text, 'Codex Plugin 列表')
  const installed = Array.isArray(root.installed) ? root.installed : []
  const available = Array.isArray(root.available) ? root.available : []
  const result = new Map<string, PluginDto>()
  for (const entry of [...installed, ...available]) {
    const plugin = pluginDto(entry)
    const current = result.get(plugin.pluginId)
    if (!current || plugin.installed) result.set(plugin.pluginId, plugin)
  }
  return [...result.values()].sort((left, right) => {
    if (left.installed !== right.installed) return left.installed ? -1 : 1
    return left.pluginId.localeCompare(right.pluginId)
  })
}

function pluginMcpNames(plugins: readonly PluginDto[]): Set<string> {
  const result = new Set<string>()
  for (const plugin of plugins) {
    if (!plugin.installed || !plugin.sourcePath) continue
    const pluginRoot = path.resolve(plugin.sourcePath)
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json')
    let manifest: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(readBoundedUtf8FileSync(
        manifestPath,
        MAX_MANIFEST_BYTES,
        'Codex Plugin 清单',
      )) as unknown
      if (isRecord(parsed)) manifest = parsed
    } catch {
      // Plugins without a readable manifest cannot claim MCP ownership.
    }

    const declaration = manifest.mcpServers
    if (isRecord(declaration)) {
      for (const name of Object.keys(declaration)) if (NAME_PATTERN.test(name)) result.add(name)
      continue
    }

    const relativeDefinition = typeof declaration === 'string' ? declaration : '.mcp.json'
    if (path.isAbsolute(relativeDefinition) || relativeDefinition.includes('\0')) continue
    const definitionPath = path.resolve(pluginRoot, relativeDefinition)
    if (!isWithin(pluginRoot, definitionPath)) continue
    try {
      const parsed = JSON.parse(readBoundedUtf8FileSync(
        definitionPath,
        MAX_MANIFEST_BYTES,
        'Codex Plugin MCP 定义',
      )) as unknown
      const servers = isRecord(parsed) ? parsed.mcpServers : null
      if (isRecord(servers)) {
        for (const name of Object.keys(servers)) if (NAME_PATTERN.test(name)) result.add(name)
      }
    } catch {
      // A damaged optional MCP declaration does not make a Plugin editable.
    }
  }
  return result
}

function parseMarketplaceList(text: string): MarketplaceDto[] {
  const root = parseJsonObject(text, 'Codex 市场列表')
  const entries = Array.isArray(root.marketplaces) ? root.marketplaces : []
  return entries.map((entry) => {
    if (!isRecord(entry)) throw new Error('Codex 市场列表包含无效条目')
    return {
      name: assertMarketplaceName(stringValue(entry.name)),
      root: stringValue(entry.root),
    }
  }).sort((left, right) => left.name.localeCompare(right.name))
}

function frontmatter(content: string): Record<string, unknown> {
  const normalized = content.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) return {}
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return {}
  try {
    const parsed = parseYaml(match[1]) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function skillEnabled(config: Record<string, unknown>, skillPath: string): boolean {
  const skills = isRecord(config.skills) ? config.skills : {}
  const entries = Array.isArray(skills.config) ? skills.config : []
  const target = normalizedPathKey(skillPath)
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.path !== 'string') continue
    if (normalizedPathKey(entry.path) === target) return entry.enabled !== false
  }
  return true
}

/**
 * 删掉 skillEnabled 会认到这个技能头上的每一条启停记录。删空了连 skills.config 一起删，
 * 这样 [[skills.config]] 那几段整段拿掉以后，解析回去和这里改完的一模一样，不用整份重写。
 */
function removeSkillConfigEntries(config: Record<string, unknown>, skillPath: string): boolean {
  const skills = config.skills
  if (!isRecord(skills) || !Array.isArray(skills.config)) return false
  const target = normalizedPathKey(skillPath)
  const kept = skills.config.filter((entry) => !(
    isRecord(entry)
    && typeof entry.path === 'string'
    && normalizedPathKey(entry.path) === target
  ))
  if (kept.length === skills.config.length) return false
  if (kept.length > 0) {
    skills.config = kept
  } else {
    delete skills.config
    if (Object.keys(skills).length === 0) delete config.skills
  }
  return true
}

/**
 * 外接工具页的通用技能列表也要知道哪些技能在 config.toml 里被停用了，
 * 否则停用过的技能照样显示「已启用」（#490）。配置读不出来时按 Codex 的
 * 缺省（全部启用）算，不让一份坏配置拖垮整张列表。
 */
export function readCodexSkillEnablement(configPath: string): (skillPath: string) => boolean {
  let config: Record<string, unknown>
  try {
    config = parseTomlFile(configPath)
  } catch {
    return () => true
  }
  return (skillPath) => skillEnabled(config, skillPath)
}

async function skillFromFile(filePath: string, root: SkillRoot, config: Record<string, unknown>): Promise<SkillDto> {
  const metadata = frontmatter(await readBoundedUtf8File(
    filePath,
    MAX_SKILL_DEFINITION_BYTES,
    'Codex SKILL.md',
  ))
  const directoryName = path.basename(path.dirname(filePath))
  const system = root.scope === 'system' || path.relative(root.path, filePath).split(path.sep).includes('.system')
  return {
    id: normalizedPathKey(filePath),
    name: stringValue(metadata.name, directoryName),
    description: stringValue(metadata.description),
    path: path.resolve(filePath),
    scope: system ? 'system' : root.scope,
    source: root.source,
    enabled: skillEnabled(config, filePath),
    managed: root.managed && !system,
  }
}

interface SkillDiscoveryBudget {
  entries: number
  files: number
}

// Discovery runs on the main process whenever the Skills page opens, so every
// filesystem call here is asynchronous: a user with thousands of Skills (or a
// slow disk scanned by antivirus) must not freeze the whole window. Siblings
// are stat'ed a few at a time, but subdirectories are still walked one at a
// time so the shared entry budget is checked before each directory read,
// exactly as the synchronous walk did.
async function collectSkillFiles(
  root: string,
  depth = 0,
  budget: SkillDiscoveryBudget = { entries: 0, files: 0 },
): Promise<string[]> {
  if (depth > 5) return []
  let rootInfo: fs.Stats
  try {
    rootInfo = await fs.promises.lstat(root)
  } catch {
    return []
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return []
  let entries: fs.Dirent[]
  try {
    const remaining = MAX_SKILL_DISCOVERY_ENTRIES - budget.entries
    if (remaining < 1) throw new DirectoryEntryLimitError('Codex Skill 目录', MAX_SKILL_DISCOVERY_ENTRIES)
    entries = await readDirectoryEntries(root, remaining, 'Codex Skill 目录')
    budget.entries += entries.length
  } catch (error) {
    if (error instanceof DirectoryEntryLimitError) throw error
    return []
  }
  const infos = await mapWithConcurrency(entries, SKILL_SCAN_CONCURRENCY, (entry) => (
    fs.promises.lstat(path.join(root, entry.name)).catch(() => null)
  ))
  const result: string[] = []
  for (const [index, entry] of entries.entries()) {
    const entryPath = path.join(root, entry.name)
    const info = infos[index]
    if (!info) continue
    if (info.isSymbolicLink()) continue
    if (info.isFile() && info.nlink <= 1 && entry.name === 'SKILL.md') {
      budget.files += 1
      if (budget.files > MAX_SKILL_FILES) {
        throw new DirectoryEntryLimitError('Codex Skill 文件', MAX_SKILL_FILES)
      }
      result.push(entryPath)
    } else if (info.isDirectory()) {
      result.push(...await collectSkillFiles(entryPath, depth + 1, budget))
    }
  }
  return result
}

function validateSkillTree(sourceDirectory: string): void {
  let files = 0
  let bytes = 0
  let entries = 0
  const pending = [{ filePath: sourceDirectory, depth: 0 }]
  while (pending.length) {
    const { filePath: current, depth } = pending.pop()!
    const stats = fs.lstatSync(current)
    if (stats.isSymbolicLink()) throw new Error('Skill 导入不允许包含符号链接')
    if (stats.isFile()) {
      // A hard link looks like an ordinary file but can carry content from
      // outside the chosen directory into the managed skills tree (I8).
      if (stats.nlink !== 1) throw new Error('Skill 导入不允许包含硬链接文件')
      files += 1
      bytes += stats.size
      if (files > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) throw new Error('Skill 导入内容超过安全限制')
      continue
    }
    if (!stats.isDirectory()) throw new Error('Skill 导入只允许普通文件和目录')
    if (depth >= MAX_SKILL_IMPORT_DEPTH) throw new Error('Skill 导入目录层级超过安全限制')
    const remaining = MAX_SKILL_DISCOVERY_ENTRIES - entries
    if (remaining < 1) throw new DirectoryEntryLimitError('Skill 导入目录', MAX_SKILL_DISCOVERY_ENTRIES)
    const children = readDirectoryEntriesSync(current, remaining, 'Skill 导入目录')
    entries += children.length
    for (const child of children) pending.push({ filePath: path.join(current, child.name), depth: depth + 1 })
  }
  if (!fs.existsSync(path.join(sourceDirectory, 'SKILL.md'))) {
    throw new Error('Skill 目录根部缺少 SKILL.md')
  }
}

// validateSkillTree only inspects paths; each file is re-checked on its open
// handle so a file swapped for a hard link or symlink after validation is
// still refused, and writes use exclusive create so nothing is followed.
function copySkillTree(sourceDirectory: string, targetDirectory: string): void {
  fs.mkdirSync(targetDirectory)
  const pending = [{ source: sourceDirectory, target: targetDirectory }]
  let bytes = 0
  while (pending.length) {
    const { source, target } = pending.pop()!
    const children = readDirectoryEntriesSync(source, MAX_SKILL_DISCOVERY_ENTRIES, 'Skill 导入目录')
    for (const child of children) {
      const childSource = path.join(source, child.name)
      const childTarget = path.join(target, child.name)
      const stats = fs.lstatSync(childSource)
      if (stats.isDirectory()) {
        fs.mkdirSync(childTarget)
        pending.push({ source: childSource, target: childTarget })
        continue
      }
      if (!stats.isFile()) throw new Error('Skill 导入只允许普通文件和目录')
      const descriptor = fs.openSync(childSource, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      try {
        const opened = fs.fstatSync(descriptor)
        if (!opened.isFile() || opened.nlink !== 1) throw new Error('Skill 导入不允许包含硬链接文件')
        if (opened.dev !== stats.dev || opened.ino !== stats.ino) throw new Error('Skill 导入文件在复制期间发生变化')
        bytes += opened.size
        if (bytes > MAX_SKILL_BYTES) throw new Error('Skill 导入内容超过安全限制')
        const content = Buffer.alloc(opened.size)
        let offset = 0
        while (offset < content.length) {
          const read = fs.readSync(descriptor, content, offset, content.length - offset, offset)
          if (read === 0) throw new Error('Skill 导入文件在复制期间发生变化')
          offset += read
        }
        fs.writeFileSync(childTarget, content, { flag: 'wx' })
      } finally {
        fs.closeSync(descriptor)
      }
    }
  }
}

/**
 * 导入技能的来源：一个技能文件夹，或者它根部的 SKILL.md。Claude Code、Grok CLI 的技能导入
 * （provider-extensions.ts）走的也是这三步，跟 Codex 同一套检查（I8）。
 */
export function resolveSkillImportSource(sourcePath: string): string {
  if (!path.isAbsolute(sourcePath)) throw new Error('Skill 导入路径必须是绝对路径')
  let sourceDirectory = path.resolve(sourcePath)
  assertNoSymlinkComponents(sourceDirectory, 'Skill 导入路径')
  const sourceStats = fs.lstatSync(sourceDirectory)
  if (sourceStats.isSymbolicLink()) throw new Error('Skill 导入路径不能是符号链接')
  if (sourceStats.isFile()) {
    if (path.basename(sourceDirectory) !== 'SKILL.md') throw new Error('Skill 文件必须命名为 SKILL.md')
    sourceDirectory = path.dirname(sourceDirectory)
  } else if (!sourceStats.isDirectory()) {
    throw new Error('Skill 导入路径必须是目录或 SKILL.md')
  }
  validateSkillTree(sourceDirectory)
  return sourceDirectory
}

/** 技能要落到的文件夹：技能目录下跟来源同名的一层，已经有了就不导。 */
export function skillImportTarget(sourceDirectory: string, root: string): string {
  assertNoSymlinkComponents(root, 'Skill 受管目录')
  const directoryName = path.basename(sourceDirectory)
  if (!SKILL_DIRECTORY_PATTERN.test(directoryName)) throw new Error('Skill 目录名包含不支持的字符')
  const target = path.resolve(root, directoryName)
  if (!isWithin(root, target) || normalizedPathKey(root) === normalizedPathKey(target)) {
    throw new Error('Skill 目标路径越界')
  }
  if (fs.existsSync(target)) throw new Error(`Skill 已存在：${directoryName}`)
  return target
}

export function copySkillImport(sourceDirectory: string, root: string, target: string): void {
  fs.mkdirSync(root, { recursive: true })
  try {
    copySkillTree(sourceDirectory, target)
  } catch (error) {
    if (fs.existsSync(target) && isWithin(root, target)) fs.rmSync(target, { recursive: true, force: true })
    throw error
  }
}

/** 移除技能是把它所在的文件夹挪进星芒自己的回收站，不直接删。source 是那份 SKILL.md。 */
export function moveSkillToTrash(source: string, trashDirectory: string): string {
  assertNoSymlinkComponents(source, 'Skill 路径')
  assertNoSymlinkComponents(trashDirectory, '应用回收站路径')
  fs.mkdirSync(trashDirectory, { recursive: true })
  const target = path.join(
    trashDirectory,
    `${path.basename(path.dirname(source))}-${configBackupSuffix()}-${randomUUID()}`,
  )
  const sourceDirectory = path.dirname(source)
  try {
    // 安全软件正扫着 Skill 里的文件时，整个文件夹挪不动（EPERM），过一会儿就好，等一下
    // 再试（第三十七批 C）；每次试之前照开头那样再查两边的路径。
    renameWithTransientRetrySync(sourceDirectory, target, () => {
      assertNoSymlinkComponents(source, 'Skill 路径')
      assertNoSymlinkComponents(trashDirectory, '应用回收站路径')
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    validateSkillTree(sourceDirectory)
    fs.cpSync(sourceDirectory, target, { recursive: true, errorOnExist: true, force: false })
    if (!fs.existsSync(path.join(target, 'SKILL.md'))) {
      fs.rmSync(target, { recursive: true, force: true })
      throw new Error('Skill 移动到回收站时校验失败')
    }
    fs.rmSync(sourceDirectory, { recursive: true })
  }
  return target
}

export class CodexExtensionService {
  private readonly userHome: string
  private readonly codexHome: string
  private repositoryRoot?: string
  private readonly trashDirectory: string
  private readonly configPath: string
  private readonly invoke: CodexInvoker
  // 正在等浏览器授权的 `codex mcp login`，按名称记下，「取消」时一起停掉。
  private readonly mcpLogins = new Map<string, Set<AbortController>>()
  private readonly serializeConfigWrite: <T>(operation: () => Promise<T>) => Promise<T>
  private readonly cliInstalled: () => Promise<boolean>

  constructor(options: CodexExtensionServiceOptions = {}) {
    this.userHome = path.resolve(options.userHome ?? options.homeDirectory ?? os.homedir())
    this.codexHome = path.resolve(options.codexHome ?? path.join(this.userHome, '.codex'))
    this.repositoryRoot = this.normalizeRepositoryRoot(options.repositoryRoot)
    this.trashDirectory = path.resolve(
      options.trashDirectory ?? path.join(this.userHome, '.xingmang-ai-manager', 'trash', 'skills'),
    )
    this.configPath = path.resolve(options.configPath ?? path.join(this.codexHome, 'config.toml'))
    this.invoke = options.invoke ?? defaultInvoker(options)
    this.serializeConfigWrite = options.serializeConfigWrite ?? ((operation) => operation())
    this.cliInstalled = options.cliInstalled ?? (async () => true)
  }

  private writeConfigToml(mutation: Pick<CodexTomlMutation, 'mutate' | 'editText'>): Promise<string | undefined> {
    return this.serializeConfigWrite(async () => mutateConfigToml(this.configPath, mutation))
  }

  getRepositoryContext(): RepositoryContext {
    return { repositoryRoot: this.repositoryRoot ?? null }
  }

  setRepositoryContext(repositoryRoot?: string | null): RepositoryContext {
    this.repositoryRoot = this.normalizeRepositoryRoot(repositoryRoot)
    return this.getRepositoryContext()
  }

  private normalizeRepositoryRoot(repositoryRoot?: string | null): string | undefined {
    if (!repositoryRoot?.trim()) return undefined
    const resolved = path.resolve(repositoryRoot.trim())
    return normalizedPathKey(resolved) === normalizedPathKey(this.userHome) ? undefined : resolved
  }

  private skillRoots(): SkillRoot[] {
    const roots: SkillRoot[] = [
      { path: path.join(this.userHome, '.agents', 'skills'), scope: 'user', source: 'agents', managed: true },
      { path: path.join(this.codexHome, 'skills'), scope: 'user', source: 'codex', managed: true },
    ]
    if (this.repositoryRoot) {
      roots.push(
        { path: path.join(this.repositoryRoot, '.agents', 'skills'), scope: 'repo', source: 'agents', managed: true },
        { path: path.join(this.repositoryRoot, '.codex', 'skills'), scope: 'repo', source: 'codex', managed: true },
      )
    }
    return roots
  }

  async listMcpServers(): Promise<McpServerDto[]> {
    if (!await this.cliInstalled()) return this.listConfiguredMcpServers()
    const output = await this.invoke(['mcp', 'list', '--json'])
    const userNames = mcpUserNames(this.configPath)
    const entries = parseJsonArray(output, 'Codex MCP 列表')
    const hasNonUserServer = entries.some((entry) => isRecord(entry) && !userNames.has(stringValue(entry.name)))
    let pluginNames = new Set<string>()
    if (hasNonUserServer) {
      try {
        pluginNames = pluginMcpNames(parsePluginList(await this.invoke(['plugin', 'list', '--json'])))
      } catch {
        // Unknown ownership remains system/read-only if Plugin discovery fails.
      }
    }
    return entries
      .map((entry) => sanitizeMcpServer(entry, userNames, pluginNames))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * 没装 Codex CLI 时只列用户那份 config.toml：项目里那几层要看 Codex 信不信任那个项目，插件带的要问 CLI，
   * 这两样都不列。名字里带点号这类的星芒删不了（assertSimpleName），也不列，免得整张表读不出来。
   */
  private listConfiguredMcpServers(): McpServerDto[] {
    const entries = [...readCodexMcpServerEntries(this.configPath)].filter(([name]) => NAME_PATTERN.test(name))
    const userNames = new Set(entries.map(([name]) => name))
    return entries
      .map(([name, entry]) => sanitizeMcpServer(configuredMcpServer(name, entry), userNames, new Set()))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async getMcpServer(name: string): Promise<McpServerDto> {
    assertSimpleName(name, 'MCP 名称')
    const output = await this.invoke(['mcp', 'get', name, '--json'])
    const userNames = mcpUserNames(this.configPath)
    let pluginNames = new Set<string>()
    if (!userNames.has(name)) {
      try {
        pluginNames = pluginMcpNames(parsePluginList(await this.invoke(['plugin', 'list', '--json'])))
      } catch {
        // Unknown ownership remains system/read-only if Plugin discovery fails.
      }
    }
    return sanitizeMcpServer(parseJsonObject(output, 'Codex MCP 详情'), userNames, pluginNames)
  }

  async addMcpServer(input: AddMcpInput): Promise<McpServerDto[]> {
    const name = assertSimpleName(input.name, 'MCP 名称')
    const argv = ['mcp', 'add', name]
    const sensitiveValues: string[] = []
    // 没装 Codex CLI 时直接写进 config.toml 的那一条，照 `codex mcp add` 自己的写法（0.163.0 的
    // document_helpers.rs）：stdio 写 command、args、env，http 写 url、bearer_token_env_var，空的不写。
    const entry: Record<string, unknown> = {}
    let oauthRequested = false
    if (input.type === 'stdio') {
      const command = assertNoNul(input.command, 'MCP 命令')
      if (command.length > 4_096) throw new Error('MCP 命令过长')
      entry.command = command
      const env: Record<string, string> = {}
      for (const [envName, envValue] of Object.entries(input.env ?? {})) {
        if (!ENV_NAME_PATTERN.test(envName)) throw new Error(`环境变量名无效：${envName}`)
        if (envValue.includes('\0')) throw new Error(`环境变量 ${envName} 包含 NUL 字符`)
        argv.push('--env', `${envName}=${envValue}`)
        env[envName] = envValue
        if (envValue) sensitiveValues.push(envValue)
      }
      const args = [...(input.args ?? [])]
      if (args.some((argument) => argument.includes('\0'))) throw new Error('MCP 参数不能包含 NUL 字符')
      argv.push('--', command, ...args)
      if (args.length) entry.args = args
      if (Object.keys(env).length) entry.env = env
    } else {
      const url = assertHttpUrl(input.url)
      argv.push('--url', url)
      entry.url = url
      if (input.bearerTokenEnvVar) {
        if (!ENV_NAME_PATTERN.test(input.bearerTokenEnvVar)) throw new Error('Bearer Token 环境变量名无效')
        argv.push('--bearer-token-env-var', input.bearerTokenEnvVar)
        entry.bearer_token_env_var = input.bearerTokenEnvVar
      }
      const oauthClientId = assertOptionalValue(input.oauthClientId, 'OAuth Client ID')
      const oauthResource = assertOptionalValue(input.oauthResource, 'OAuth Resource')
      if (oauthClientId) argv.push('--oauth-client-id', oauthClientId)
      if (oauthResource) argv.push('--oauth-resource', oauthResource)
      oauthRequested = Boolean(oauthClientId || oauthResource)
    }

    if (!await this.cliInstalled()) {
      // 这两项是 `codex mcp add` 当场去做 OAuth 登录时用的，config.toml 里没有对应的写法；界面上没装 CLI 时不给填。
      if (oauthRequested) throw new Error('没装 Codex CLI 时，OAuth Client ID 和 OAuth Resource 填不了，要先装好 Codex CLI。')
      return this.addConfiguredMcpServer(name, entry)
    }
    try {
      await this.invoke(argv, { sensitiveValues, timeoutMs: 120_000 })
    } catch (error) {
      const reconciled = await this.listMcpServers()
      const persisted = reconciled.find((server) => server.name === name)
      if (persisted && mcpServerMatchesInput(persisted, input)) return reconciled
      throw withCommandOutput(error)
    }
    const reconciled = await this.listMcpServers()
    if (!reconciled.some((server) => server.name === name)) throw new Error('MCP 配置写入后未通过 Codex 对账')
    return reconciled
  }

  /**
   * 同名的整条换掉，和 `codex mcp add` 一样。原来那条单占表头时先整段拿掉、新的接在末尾，别的注释和排版不动；
   * 只能整份重写时备份照留，这条通道回的是列表，带不出「注释可能丢失」那句。
   */
  private async addConfiguredMcpServer(name: string, entry: Record<string, unknown>): Promise<McpServerDto[]> {
    await this.writeConfigToml({
      mutate: (config) => {
        if (!isRecord(config.mcp_servers)) config.mcp_servers = {}
        const servers = config.mcp_servers as Record<string, unknown>
        if (isDeepStrictEqual(servers[name], entry)) return false
        servers[name] = entry
        return true
      },
      editText: (source, before) => {
        const existing = isRecord(before.mcp_servers) && name in before.mcp_servers
        const base = existing ? removeTomlTableText(source, ['mcp_servers', name]) : source
        return base === null ? null : appendTomlText(base, { mcp_servers: { [name]: entry } })
      },
    })
    const reconciled = this.listConfiguredMcpServers()
    if (!reconciled.some((server) => server.name === name)) throw new Error('MCP 配置写入后未通过 Codex 对账')
    return reconciled
  }

  private async removeConfiguredMcpServer(name: string): Promise<McpServerDto[]> {
    await this.writeConfigToml({
      mutate: (config) => {
        const servers = config.mcp_servers
        if (!isRecord(servers) || !(name in servers)) return false
        delete servers[name]
        if (!Object.keys(servers).length) delete config.mcp_servers
        return true
      },
      editText: (source, _before, after) => {
        const removed = removeTomlTableText(source, ['mcp_servers', name])
        // 最后一条也删了的时候，空着的 [mcp_servers] 表头一起拿掉，解析回去才对得上。
        return removed !== null && after.mcp_servers === undefined
          ? removeTomlTableText(removed, ['mcp_servers']) ?? removed
          : removed
      },
    })
    const reconciled = this.listConfiguredMcpServers()
    if (reconciled.some((entry) => entry.name === name)) throw new Error('MCP 删除后仍存在，Codex 对账失败')
    return reconciled
  }

  async removeMcpServer(name: string): Promise<McpServerDto[]> {
    assertSimpleName(name, 'MCP 名称')
    if (!await this.cliInstalled()) return this.removeConfiguredMcpServer(name)
    const before = await this.listMcpServers()
    const server = before.find((entry) => entry.name === name)
    if (!server) return before
    if (!server.editable) throw new Error('该 MCP 由 Plugin 或系统提供，不能在此删除')
    await this.invoke(['mcp', 'remove', name])
    const reconciled = await this.listMcpServers()
    if (reconciled.some((entry) => entry.name === name)) throw new Error('MCP 删除后仍存在，Codex 对账失败')
    return reconciled
  }

  /**
   * Codex 没有 `mcp enable / disable`：停用就是用户 config.toml 里那条写 enabled = false（0.162.1 的 mcp list 报
   * disabled，`codex mcp add` 别的连接也不会把它冲掉）。启用时把 false 改回 true，不删这一行：只改一个值能按行改、
   * 留住客户的注释，删键就得整份重写；Codex 读 true 和不写一样。装没装 CLI、只装了桌面端都走这里。
   * 用户那份里没有这一条（项目里的、插件带的）就不写，交给对账：已经是要的状态算成，不是就报错。
   */
  async setMcpServerEnabled(name: string, enabled: boolean): Promise<McpServerDto[]> {
    assertSimpleName(name, 'MCP 名称')
    await this.writeConfigToml({
      mutate: (config) => {
        const servers = config.mcp_servers
        const entry = isRecord(servers) ? servers[name] : undefined
        if (!isRecord(entry) || (entry.enabled !== false) === enabled) return false
        entry.enabled = enabled
        return true
      },
      editText: (source, before, after) => editTomlTableText(source, ['mcp_servers', name], before, after),
    })
    const reconciled = await this.listMcpServers()
    const server = reconciled.find((entry) => entry.name === name)
    if (!server || server.enabled !== enabled) throw new Error('MCP 配置写入后未通过 Codex 对账')
    return reconciled
  }

  async loginMcpServer(name: string, scopes: readonly string[] = []): Promise<McpServerDto[]> {
    assertSimpleName(name, 'MCP 名称')
    const argv = ['mcp', 'login', name]
    const normalizedScopes = scopes.map((scope) => assertNoNul(scope, 'OAuth Scope').trim()).filter(Boolean)
    if (normalizedScopes.length) argv.push('--scopes', normalizedScopes.join(','))
    // 第一个 await 之前登记好：紧跟着到的「取消」要能找到它。
    const controller = new AbortController()
    const pending = this.mcpLogins.get(name) ?? new Set<AbortController>()
    pending.add(controller)
    this.mcpLogins.set(name, pending)
    try {
      await this.invoke(argv, { timeoutMs: 180_000, signal: controller.signal })
    } catch (error) {
      // 客户自己点了「取消」是正常结束，照常回列表，不当失败报红条、记错误日志（#1099 第 1 条）。
      // 认的是这次登录自己的停止标记，不认错误原话：原话哪天改了，取消也不会变回失败。
      if (!controller.signal.aborted) throw error
    } finally {
      pending.delete(controller)
      if (!pending.size && this.mcpLogins.get(name) === pending) this.mcpLogins.delete(name)
    }
    return this.listMcpServers()
  }

  /** 停掉这个名称正在等浏览器授权的登录；没有在等的返回 false。 */
  cancelMcpLogin(name: string): boolean {
    assertSimpleName(name, 'MCP 名称')
    const pending = this.mcpLogins.get(name)
    if (!pending?.size) return false
    for (const controller of pending) controller.abort()
    return true
  }

  async logoutMcpServer(name: string): Promise<McpServerDto[]> {
    assertSimpleName(name, 'MCP 名称')
    await this.invoke(['mcp', 'logout', name])
    return this.listMcpServers()
  }

  async listPlugins(): Promise<PluginCatalogDto> {
    const [plugins, marketplaces] = await Promise.all([
      this.invoke(['plugin', 'list', '--available', '--json']).then(parsePluginList),
      this.invoke(['plugin', 'marketplace', 'list', '--json']).then(parseMarketplaceList),
    ])
    return { plugins, marketplaces }
  }

  async addPlugin(selector: string): Promise<PluginCatalogDto> {
    assertSelector(selector)
    await this.invoke(['plugin', 'add', selector, '--json']).catch((error: unknown) => {
      throw withCommandOutput(error)
    })
    const catalog = await this.listPlugins()
    if (!catalog.plugins.some((plugin) => plugin.pluginId === selector && plugin.installed)) {
      throw new Error('Plugin 安装后未通过 Codex 对账')
    }
    return catalog
  }

  async removePlugin(selector: string): Promise<PluginCatalogDto> {
    assertSelector(selector)
    await this.invoke(['plugin', 'remove', selector, '--json'])
    const catalog = await this.listPlugins()
    if (catalog.plugins.some((plugin) => plugin.pluginId === selector && plugin.installed)) {
      throw new Error('Plugin 删除后仍存在，Codex 对账失败')
    }
    return catalog
  }

  async setPluginEnabled(selector: string, enabled: boolean): Promise<PluginCatalogDto> {
    assertSelector(selector)
    const before = await this.listPlugins()
    if (!before.plugins.some((plugin) => plugin.pluginId === selector && plugin.installed)) {
      throw new Error('只能启停已安装的 Plugin')
    }
    const rewriteNotice = await this.writeConfigToml({
      mutate: (config) => {
        if (!isRecord(config.plugins)) config.plugins = {}
        const plugins = config.plugins as Record<string, unknown>
        if (!isRecord(plugins[selector])) plugins[selector] = {}
        const entry = plugins[selector] as Record<string, unknown>
        if (entry.enabled === enabled) return false
        entry.enabled = enabled
        return true
      },
      editText: (source, before, after) => editTomlTableText(source, ['plugins', selector], before, after),
    })
    const catalog = await this.listPlugins()
    const plugin = catalog.plugins.find((entry) => entry.pluginId === selector && entry.installed)
    if (!plugin || plugin.enabled !== enabled) throw new Error('Plugin 状态写入后未通过 Codex 对账')
    if (rewriteNotice) catalog.rewriteNotice = rewriteNotice
    return catalog
  }

  async addMarketplace(input: AddMarketplaceInput): Promise<PluginCatalogDto> {
    const source = assertMarketplaceSource(input.source)
    const argv = ['plugin', 'marketplace', 'add', source]
    const ref = assertOptionalValue(input.ref, 'Git Ref')
    if (ref) argv.push('--ref', ref)
    for (const sparse of input.sparse ?? []) argv.push('--sparse', assertSparsePath(sparse))
    argv.push('--json')
    await this.invoke(argv, { timeoutMs: 180_000 }).catch((error: unknown) => {
      throw withCommandOutput(error)
    })
    return this.listPlugins()
  }

  async upgradeMarketplace(name?: string): Promise<PluginCatalogDto> {
    const argv = ['plugin', 'marketplace', 'upgrade']
    if (name) argv.push(assertMarketplaceName(name))
    argv.push('--json')
    await this.invoke(argv, { timeoutMs: 180_000 })
    return this.listPlugins()
  }

  async removeMarketplace(name: string): Promise<PluginCatalogDto> {
    assertMarketplaceName(name)
    await this.invoke(['plugin', 'marketplace', 'remove', name, '--json'])
    const catalog = await this.listPlugins()
    if (catalog.marketplaces.some((marketplace) => marketplace.name === name)) {
      throw new Error('市场删除后仍存在，Codex 对账失败')
    }
    return catalog
  }

  async listSkills(): Promise<SkillDto[]> {
    const config = parseTomlFile(this.configPath)
    const skills = new Map<string, SkillDto>()
    const discoveryBudget: SkillDiscoveryBudget = { entries: 0, files: 0 }
    for (const root of this.skillRoots()) {
      const files = await collectSkillFiles(root.path, 0, discoveryBudget)
      const parsed = await mapWithConcurrency(files, SKILL_SCAN_CONCURRENCY, (filePath) => (
        // A Skill may disappear while the filesystem is being scanned.
        skillFromFile(filePath, root, config).catch(() => null)
      ))
      for (const skill of parsed) {
        if (skill) skills.set(skill.id, skill)
      }
    }
    return [...skills.values()].sort((left, right) => {
      if (left.scope !== right.scope) return left.scope.localeCompare(right.scope)
      return left.name.localeCompare(right.name)
    })
  }

  async setSkillEnabled(
    skillPath: string,
    enabled: boolean,
  ): Promise<{ skills: SkillDto[]; rewriteNotice?: string }> {
    const target = await this.requireManagedSkill(skillPath)
    const rewriteNotice = await this.writeConfigToml({
      mutate: (config) => {
        if (!isRecord(config.skills)) config.skills = {}
        const skills = config.skills as Record<string, unknown>
        if (!Array.isArray(skills.config)) skills.config = []
        const entries = skills.config as unknown[]
        const key = normalizedPathKey(target.path)
        const existing = entries.find((entry) => (
          isRecord(entry)
          && typeof entry.path === 'string'
          && normalizedPathKey(entry.path) === key
        ))
        if (!isRecord(existing)) {
          entries.push({ path: target.path, enabled })
          return true
        }
        if (existing.enabled === enabled) return false
        existing.enabled = enabled
        return true
      },
      editText: (source, before, after) => editTomlArrayTableText(source, ['skills', 'config'], before, after),
    })
    const skills = await this.listSkills()
    const reconciled = skills.find((skill) => skill.id === target.id)
    if (!reconciled || reconciled.enabled !== enabled) throw new Error('Skill 状态写入后对账失败')
    return rewriteNotice ? { skills, rewriteNotice } : { skills }
  }

  async importSkill(input: ImportSkillInput): Promise<SkillDto[]> {
    const sourceDirectory = resolveSkillImportSource(input.sourcePath)
    const scope = input.scope ?? 'user'
    const root = scope === 'user'
      ? path.join(this.userHome, '.agents', 'skills')
      : this.repositoryRoot && path.join(this.repositoryRoot, '.agents', 'skills')
    if (!root) throw new Error('未设置仓库工作目录，不能导入 repo Skill')
    const target = skillImportTarget(sourceDirectory, root)
    // 这里还没有这个技能，config.toml 里它的启停记录只会是以前卸载（旧版本卸载不删）或手删目录
    // 留下的，不清掉的话新导入的一进来就是「已停用」（#1093 第 9 条）。
    await this.forgetSkillEnablement(path.join(target, 'SKILL.md'))
    copySkillImport(sourceDirectory, root, target)
    return this.listSkills()
  }

  async uninstallSkill(skillPath: string): Promise<{ skills: SkillDto[]; trashPath: string }> {
    const target = await this.requireManagedSkill(skillPath)
    const trashPath = moveSkillToTrash(target.path, this.trashDirectory)
    // 挪走以后再删启停记录：先删的话挪不动时技能还在，客户关掉的却被打开了（#1093 第 9 条）。
    await this.forgetSkillEnablement(target.path)
    return { skills: await this.listSkills(), trashPath }
  }

  /**
   * 技能已经不在了，这一步失败不该让卸载、导入报错：记录留着顶多让同一路径再导入的那一份显示
   * 「已停用」，下次导入前还会再清一次。和启停一样，能只删那几段就只删那几段，并留备份。
   */
  private async forgetSkillEnablement(skillPath: string): Promise<void> {
    try {
      await this.writeConfigToml({
        mutate: (config) => removeSkillConfigEntries(config, skillPath),
        editText: (source, before, after) => editTomlArrayTableText(source, ['skills', 'config'], before, after),
      })
    } catch {
      // 原因见上面的说明。
    }
  }

  private async requireManagedSkill(skillPath: string): Promise<SkillDto> {
    if (!path.isAbsolute(skillPath)) throw new Error('Skill 路径必须是绝对路径')
    const requested = normalizedPathKey(skillPath)
    const skill = (await this.listSkills()).find((entry) => entry.id === requested)
    if (!skill || !skill.managed || (skill.scope !== 'user' && skill.scope !== 'repo')) {
      throw new Error('只能修改受管的 user 或 repo Skill')
    }
    const root = this.skillRoots().find((entry) => entry.managed && isWithin(entry.path, skill.path))
    if (!root || normalizedPathKey(root.path) === normalizedPathKey(path.dirname(skill.path))) {
      throw new Error('Skill 路径不在受管目录中')
    }
    return skill
  }
}
