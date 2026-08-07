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
  commandEnvironment,
  findExecutable,
  runCommand,
  trustedCommandEnvironment,
  type CommandSpec,
  type RunCommandOptions,
} from './command-runner'
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

export interface ProviderExtensionsSnapshot {
  provider: ProviderId
  checkedAt: string
  capabilities: Record<ProviderExtensionKind, ProviderExtensionCategoryCapability>
  items: ProviderExtensionItem[]
  warnings: string[]
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
  inspectSource?: SourceUpdateInspector
  sourceUpdateDependencies?: ProviderSourceUpdateDependencies
  now?: () => Date
  windowsExecutionMode?: WindowsCliExecutionMode
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

function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 500) || '未知错误'
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
  const gitValue = args.find((entry) => /^(?:git\+|https?:\/\/|ssh:\/\/|git@).*(?:\.git|#[A-Za-z0-9._/-]+)?$/i.test(entry))
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

function pluginListArgv(provider: ProviderId): string[] {
  if (provider === 'codex') return ['plugin', 'list', '--available', '--json']
  if (provider === 'claude') return ['plugin', 'list', '--available', '--json']
  if (provider === 'gemini') return ['extensions', 'list', '--output-format', 'json']
  return ['plugin', 'list', '--available', '--json']
}

function mcpListArgv(provider: ProviderId): string[] | null {
  if (provider === 'codex' || provider === 'grok') return ['mcp', 'list', '--json']
  return null
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
    const providerEnv = provider === 'codex' ? codexEnv : env
    const base = await resolveCommand(provider, providerEnv, windowsExecutionMode)
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
      items.push(...parseProviderPluginList(
        provider,
        output,
        checkedAt,
        provider === 'gemini' ? (this.repositoryRoot ? 'workspace' : 'user') : null,
      ))
    } catch (error) {
      const noun = provider === 'gemini' ? 'Extension' : 'Plugin'
      const reason = `${cliCatalog[provider].name} ${noun} 列表读取失败：${errorDetail(error)}`
      capabilities.plugin = { list: false, reason }
      warnings.push(reason)
    }

    await this.enrichUpdates(items, checkedAt)
    return {
      provider,
      checkedAt,
      capabilities,
      items: items.map(publicItem),
      warnings,
    }
  }

  async listAll(): Promise<ProviderExtensionsSnapshot[]> {
    return Promise.all(providerIds.map((provider) => this.list(provider)))
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
    if (input.provider === 'codex') return { argv: ['mcp', 'add', id, ...envArgs, '--', command, ...args], secrets }
    if (input.provider === 'claude') return { argv: ['mcp', 'add', '--scope', scope, id, ...envArgs, '--', command, ...args], secrets }
    if (input.provider === 'gemini') return { argv: ['mcp', 'add', '--scope', scope, '--transport', 'stdio', ...envArgs, id, command, ...args], secrets }
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
    await this.invoke(input.provider, argv, {
      cwd: input.provider === 'gemini' ? this.repositoryRoot ?? undefined : undefined,
      timeoutMs: MUTATION_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      sensitiveValues: secrets,
    })
    return this.list(input.provider)
  }
}
