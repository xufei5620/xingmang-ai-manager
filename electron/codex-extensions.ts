import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as TOML from '@iarna/toml'
import { parse as parseYaml } from 'yaml'
import { readBoundedUtf8FileSync } from './bounded-file'
import { DirectoryEntryLimitError, readDirectoryEntriesSync } from './bounded-directory'
import {
  commandEnvironment,
  findExecutable,
  isUserWritablePath,
  runCommand,
  type CommandSpec,
  type RunCommandOptions,
} from './command-runner'
import { resolveCliInstallation } from './tool-installation'
import {
  assertTrustedElevatedCliCommand,
  type WindowsCliExecutionMode,
} from './windows-elevation'
import type { WindowsMachinePaths } from './windows-machine-paths'
import { stageVerifiedNativeCli } from './trusted-native-cli'

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SELECTOR_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SKILL_DIRECTORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_SKILL_FILES = 2_000
const MAX_SKILL_BYTES = 50 * 1024 * 1024
const MAX_SKILL_DISCOVERY_ENTRIES = 10_000
const MAX_SKILL_IMPORT_DEPTH = 32
const MAX_CONFIG_BYTES = 2 * 1024 * 1024
const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_SKILL_DEFINITION_BYTES = 2 * 1024 * 1024
const TOML_WRITE_QUEUES = new Map<string, Promise<void>>()

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
}

export type CodexInvoker = (
  argv: readonly string[],
  options?: CodexInvocationOptions,
) => Promise<string>

export interface CodexExtensionServiceOptions {
  homeDirectory?: string
  repositoryRoot?: string
  trashDirectory?: string
  configPath?: string
  env?: NodeJS.ProcessEnv
  codexPackageRoot?: string
  invoke?: CodexInvoker
  machinePaths?: WindowsMachinePaths
  windowsExecutionMode?: WindowsCliExecutionMode
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
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
  const resolved = path.resolve(targetPath)
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
    if (info.isSymbolicLink()) throw new Error(`${label}不能经过符号链接`)
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

/** Resolves only files rooted in a verified @openai/codex npm installation. */
export async function resolveCodexCommand(
  env: NodeJS.ProcessEnv = process.env,
  explicitPackageRoot?: string,
  machinePaths?: WindowsMachinePaths,
  windowsExecutionMode: WindowsCliExecutionMode = 'trusted-only',
): Promise<CommandSpec> {
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
      const nodeExecutable = await findExecutable('node', { env })
      if (nodeExecutable) return { executable: nodeExecutable, argv: [realScriptPath] }
    } catch {
      // Continue looking for another verified installation.
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
      machinePaths: options.machinePaths,
    }
    const result = await runCommand(command, runOptions)
    return result.stdout
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
  try {
    return TOML.parse(readBoundedUtf8FileSync(
      filePath,
      MAX_CONFIG_BYTES,
      'Codex config.toml',
    )) as Record<string, unknown>
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Codex config.toml 无法解析，未执行修改：${detail}`)
  }
}

function backupSuffix(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
}

function uniqueBackupPath(filePath: string): string {
  const base = `${filePath}.bak.${backupSuffix()}`
  let candidate = base
  let index = 1
  while (true) {
    try {
      const info = fs.lstatSync(candidate)
      if (info.isSymbolicLink()) {
        candidate = `${base}-${index++}`
        continue
      }
      candidate = `${base}-${index++}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
      throw error
    }
  }
}

function configRewriteNotice(backupPath: string | null): string {
  return backupPath
    ? `配置文件已整体重写，手写注释可能丢失，备份位于 ${backupPath}`
    : '配置文件已整体重写，手写注释可能丢失'
}

const MAX_BACKUPS_PER_FILE = 5

// 备份后缀是时间戳，字典序即时间序；清理失败只静默跳过，绝不影响已成功的写入。
function pruneBackups(filePath: string, keep = MAX_BACKUPS_PER_FILE): void {
  const directory = path.dirname(filePath)
  const prefix = `${path.basename(filePath)}.bak.`
  let entries: string[]
  try {
    entries = fs.readdirSync(directory)
  } catch {
    return
  }
  const backups = entries.filter((name) => name.startsWith(prefix)).sort()
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
    const backupPath = path.join(directory, name)
    try {
      const info = fs.lstatSync(backupPath)
      if (!info.isFile() || info.isSymbolicLink()) continue
      fs.rmSync(backupPath)
    } catch {
      continue
    }
  }
}

function writeUtf8Exclusive(filePath: string, content: string): void {
  const descriptor = fs.openSync(filePath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function performAtomicTomlMutation(
  filePath: string,
  mutate: (config: Record<string, unknown>) => void,
): string | null {
  assertNoSymlinkComponents(filePath, 'Codex 配置路径')
  const config = parseTomlFile(filePath)
  mutate(config)
  const content = TOML.stringify(config as Parameters<typeof TOML.stringify>[0])
  const directory = path.dirname(filePath)
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  fs.mkdirSync(directory, { recursive: true })
  let backupPath: string | null = null
  try {
    writeUtf8Exclusive(temporaryPath, content)
    assertNoSymlinkComponents(filePath, 'Codex 配置路径')
    let existing: fs.Stats | null = null
    try {
      existing = fs.lstatSync(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1) {
        throw new Error('Codex config.toml 必须是单链接普通文件')
      }
      backupPath = uniqueBackupPath(filePath)
      fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL)
    }
    fs.renameSync(temporaryPath, filePath)
  } finally {
    try {
      fs.rmSync(temporaryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  // 成功落盘后才清理旧备份，失败路径仍能靠最新 .bak 恢复。
  pruneBackups(filePath)
  return backupPath
}

function atomicTomlMutation(
  filePath: string,
  mutate: (config: Record<string, unknown>) => void,
): Promise<string | null> {
  const key = normalizedPathKey(filePath)
  const previous = TOML_WRITE_QUEUES.get(key) ?? Promise.resolve()
  const operation = previous.then(() => performAtomicTomlMutation(filePath, mutate))
  const tail = operation.then(() => undefined, () => undefined)
  TOML_WRITE_QUEUES.set(key, tail)
  void tail.then(() => {
    if (TOML_WRITE_QUEUES.get(key) === tail) TOML_WRITE_QUEUES.delete(key)
  })
  return operation
}

function mcpUserNames(configPath: string): Set<string> {
  const config = parseTomlFile(configPath)
  const servers = config.mcp_servers
  return new Set(isRecord(servers) ? Object.keys(servers) : [])
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

function skillFromFile(filePath: string, root: SkillRoot, config: Record<string, unknown>): SkillDto {
  const metadata = frontmatter(readBoundedUtf8FileSync(
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

function collectSkillFiles(
  root: string,
  depth = 0,
  budget: SkillDiscoveryBudget = { entries: 0, files: 0 },
): string[] {
  if (depth > 5) return []
  let rootInfo: fs.Stats
  try {
    rootInfo = fs.lstatSync(root)
  } catch {
    return []
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return []
  let entries: fs.Dirent[]
  try {
    const remaining = MAX_SKILL_DISCOVERY_ENTRIES - budget.entries
    if (remaining < 1) throw new DirectoryEntryLimitError('Codex Skill 目录', MAX_SKILL_DISCOVERY_ENTRIES)
    entries = readDirectoryEntriesSync(root, remaining, 'Codex Skill 目录')
    budget.entries += entries.length
  } catch (error) {
    if (error instanceof DirectoryEntryLimitError) throw error
    return []
  }
  const result: string[] = []
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name)
    let info: fs.Stats
    try {
      info = fs.lstatSync(entryPath)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) continue
    if (info.isFile() && info.nlink <= 1 && entry.name === 'SKILL.md') {
      budget.files += 1
      if (budget.files > MAX_SKILL_FILES) {
        throw new DirectoryEntryLimitError('Codex Skill 文件', MAX_SKILL_FILES)
      }
      result.push(entryPath)
    } else if (info.isDirectory()) {
      result.push(...collectSkillFiles(entryPath, depth + 1, budget))
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

function moveToTrash(source: string, trashDirectory: string): string {
  assertNoSymlinkComponents(source, 'Skill 路径')
  assertNoSymlinkComponents(trashDirectory, '应用回收站路径')
  fs.mkdirSync(trashDirectory, { recursive: true })
  const target = path.join(
    trashDirectory,
    `${path.basename(path.dirname(source))}-${backupSuffix()}-${randomUUID()}`,
  )
  const sourceDirectory = path.dirname(source)
  try {
    fs.renameSync(sourceDirectory, target)
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
  private readonly homeDirectory: string
  private repositoryRoot?: string
  private readonly trashDirectory: string
  private readonly configPath: string
  private readonly invoke: CodexInvoker

  constructor(options: CodexExtensionServiceOptions = {}) {
    this.homeDirectory = path.resolve(options.homeDirectory ?? os.homedir())
    this.repositoryRoot = this.normalizeRepositoryRoot(options.repositoryRoot)
    this.trashDirectory = path.resolve(
      options.trashDirectory ?? path.join(this.homeDirectory, '.xingmang-ai-manager', 'trash', 'skills'),
    )
    this.configPath = path.resolve(options.configPath ?? path.join(this.homeDirectory, '.codex', 'config.toml'))
    this.invoke = options.invoke ?? defaultInvoker(options)
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
    return normalizedPathKey(resolved) === normalizedPathKey(this.homeDirectory) ? undefined : resolved
  }

  private skillRoots(): SkillRoot[] {
    const roots: SkillRoot[] = [
      { path: path.join(this.homeDirectory, '.agents', 'skills'), scope: 'user', source: 'agents', managed: true },
      { path: path.join(this.homeDirectory, '.codex', 'skills'), scope: 'user', source: 'codex', managed: true },
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
    if (input.type === 'stdio') {
      const command = assertNoNul(input.command, 'MCP 命令')
      if (command.length > 4_096) throw new Error('MCP 命令过长')
      for (const [envName, envValue] of Object.entries(input.env ?? {})) {
        if (!ENV_NAME_PATTERN.test(envName)) throw new Error(`环境变量名无效：${envName}`)
        if (envValue.includes('\0')) throw new Error(`环境变量 ${envName} 包含 NUL 字符`)
        argv.push('--env', `${envName}=${envValue}`)
        if (envValue) sensitiveValues.push(envValue)
      }
      const args = [...(input.args ?? [])]
      if (args.some((argument) => argument.includes('\0'))) throw new Error('MCP 参数不能包含 NUL 字符')
      argv.push('--', command, ...args)
    } else {
      argv.push('--url', assertHttpUrl(input.url))
      if (input.bearerTokenEnvVar) {
        if (!ENV_NAME_PATTERN.test(input.bearerTokenEnvVar)) throw new Error('Bearer Token 环境变量名无效')
        argv.push('--bearer-token-env-var', input.bearerTokenEnvVar)
      }
      const oauthClientId = assertOptionalValue(input.oauthClientId, 'OAuth Client ID')
      const oauthResource = assertOptionalValue(input.oauthResource, 'OAuth Resource')
      if (oauthClientId) argv.push('--oauth-client-id', oauthClientId)
      if (oauthResource) argv.push('--oauth-resource', oauthResource)
    }

    try {
      await this.invoke(argv, { sensitiveValues, timeoutMs: 120_000 })
    } catch (error) {
      const reconciled = await this.listMcpServers()
      if (reconciled.some((server) => server.name === name)) return reconciled
      throw error
    }
    const reconciled = await this.listMcpServers()
    if (!reconciled.some((server) => server.name === name)) throw new Error('MCP 配置写入后未通过 Codex 对账')
    return reconciled
  }

  async removeMcpServer(name: string): Promise<McpServerDto[]> {
    assertSimpleName(name, 'MCP 名称')
    const before = await this.listMcpServers()
    const server = before.find((entry) => entry.name === name)
    if (!server) return before
    if (!server.editable) throw new Error('该 MCP 由 Plugin 或系统提供，不能在此删除')
    await this.invoke(['mcp', 'remove', name])
    const reconciled = await this.listMcpServers()
    if (reconciled.some((entry) => entry.name === name)) throw new Error('MCP 删除后仍存在，Codex 对账失败')
    return reconciled
  }

  async loginMcpServer(name: string, scopes: readonly string[] = []): Promise<McpServerDto[]> {
    assertSimpleName(name, 'MCP 名称')
    const argv = ['mcp', 'login', name]
    const normalizedScopes = scopes.map((scope) => assertNoNul(scope, 'OAuth Scope').trim()).filter(Boolean)
    if (normalizedScopes.length) argv.push('--scopes', normalizedScopes.join(','))
    await this.invoke(argv, { timeoutMs: 180_000 })
    return this.listMcpServers()
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
    await this.invoke(['plugin', 'add', selector, '--json'])
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
    const backupPath = await atomicTomlMutation(this.configPath, (config) => {
      if (!isRecord(config.plugins)) config.plugins = {}
      const plugins = config.plugins as Record<string, unknown>
      if (!isRecord(plugins[selector])) plugins[selector] = {}
      ;(plugins[selector] as Record<string, unknown>).enabled = enabled
    })
    const catalog = await this.listPlugins()
    const plugin = catalog.plugins.find((entry) => entry.pluginId === selector && entry.installed)
    if (!plugin || plugin.enabled !== enabled) throw new Error('Plugin 状态写入后未通过 Codex 对账')
    catalog.rewriteNotice = configRewriteNotice(backupPath)
    return catalog
  }

  async addMarketplace(input: AddMarketplaceInput): Promise<PluginCatalogDto> {
    const source = assertMarketplaceSource(input.source)
    const argv = ['plugin', 'marketplace', 'add', source]
    const ref = assertOptionalValue(input.ref, 'Git Ref')
    if (ref) argv.push('--ref', ref)
    for (const sparse of input.sparse ?? []) argv.push('--sparse', assertSparsePath(sparse))
    argv.push('--json')
    await this.invoke(argv, { timeoutMs: 180_000 })
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

  listSkills(): SkillDto[] {
    const config = parseTomlFile(this.configPath)
    const skills = new Map<string, SkillDto>()
    const discoveryBudget: SkillDiscoveryBudget = { entries: 0, files: 0 }
    for (const root of this.skillRoots()) {
      for (const filePath of collectSkillFiles(root.path, 0, discoveryBudget)) {
        try {
          const skill = skillFromFile(filePath, root, config)
          skills.set(skill.id, skill)
        } catch {
          // A Skill may disappear while the filesystem is being scanned.
        }
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
    const target = this.requireManagedSkill(skillPath)
    const backupPath = await atomicTomlMutation(this.configPath, (config) => {
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
      if (isRecord(existing)) existing.enabled = enabled
      else entries.push({ path: target.path, enabled })
    })
    const skills = this.listSkills()
    const reconciled = skills.find((skill) => skill.id === target.id)
    if (!reconciled || reconciled.enabled !== enabled) throw new Error('Skill 状态写入后对账失败')
    return { skills, rewriteNotice: configRewriteNotice(backupPath) }
  }

  importSkill(input: ImportSkillInput): SkillDto[] {
    if (!path.isAbsolute(input.sourcePath)) throw new Error('Skill 导入路径必须是绝对路径')
    let sourceDirectory = path.resolve(input.sourcePath)
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

    const scope = input.scope ?? 'user'
    const root = scope === 'user'
      ? path.join(this.homeDirectory, '.agents', 'skills')
      : this.repositoryRoot && path.join(this.repositoryRoot, '.agents', 'skills')
    if (!root) throw new Error('未设置仓库工作目录，不能导入 repo Skill')
    assertNoSymlinkComponents(root, 'Skill 受管目录')
    const directoryName = path.basename(sourceDirectory)
    if (!SKILL_DIRECTORY_PATTERN.test(directoryName)) throw new Error('Skill 目录名包含不支持的字符')
    const target = path.resolve(root, directoryName)
    if (!isWithin(root, target) || normalizedPathKey(root) === normalizedPathKey(target)) {
      throw new Error('Skill 目标路径越界')
    }
    if (fs.existsSync(target)) throw new Error(`Skill 已存在：${directoryName}`)
    fs.mkdirSync(root, { recursive: true })
    try {
      fs.cpSync(sourceDirectory, target, { recursive: true, errorOnExist: true, force: false })
    } catch (error) {
      if (fs.existsSync(target) && isWithin(root, target)) fs.rmSync(target, { recursive: true, force: true })
      throw error
    }
    return this.listSkills()
  }

  uninstallSkill(skillPath: string): { skills: SkillDto[]; trashPath: string } {
    const target = this.requireManagedSkill(skillPath)
    const trashPath = moveToTrash(target.path, this.trashDirectory)
    return { skills: this.listSkills(), trashPath }
  }

  private requireManagedSkill(skillPath: string): SkillDto {
    if (!path.isAbsolute(skillPath)) throw new Error('Skill 路径必须是绝对路径')
    const requested = normalizedPathKey(skillPath)
    const skill = this.listSkills().find((entry) => entry.id === requested)
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
