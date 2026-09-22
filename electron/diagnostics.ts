import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { readBoundedUtf8FileSync } from './bounded-file'
import { cliCatalog, providerConfigDirectoryNames, providerIds, type ProviderId } from './catalog'
import {
  commandEnvironment,
  findExecutable,
  isTrustedHighIntegrityExecutable,
  runCommand,
  trustedCommandEnvironment,
} from './command-runner'
import { defaultProviderConfigRoots, type ProviderConfigRoots } from './codex-home'
import { inspectProviderConfig, type NativeConfigInspection } from './config-files'
import { gitMissingNotice } from './git-runtime'
import { classifyNetworkFailure, networkFailureMessages } from './network-failure'
import { relayApiProbeBaseUrl, resolveRelaySite, type RelaySite } from './relay-sites'
import { resolveCliCommand, resolveCliInstallation } from './tool-installation'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

export type DiagnosticState = 'pass' | 'warn' | 'fail' | 'error'

export interface DiagnosticItem {
  code: string
  title: string
  state: DiagnosticState
  summary: string
  details?: Record<string, boolean | number | string | null>
  durationMs: number
}

export interface DiagnosticsReport {
  version: 1
  generatedAt: string
  durationMs: number
  counts: Record<DiagnosticState, number>
  items: DiagnosticItem[]
}

export interface DiagnosticToolStatus {
  installed: boolean
  version: string | null
  path: string | null
  running?: boolean
}

export interface DiagnosticAppInfo {
  name: string
  version: string
  packaged: boolean
}

export interface ProxyVariableSummary {
  name: string
  source: 'process' | 'user' | 'system'
}

export interface DiagnosticsDependencies {
  app: DiagnosticAppInfo
  providerRoots?: ProviderConfigRoots
  homeDirectory?: string
  platform?: NodeJS.Platform
  arch?: string
  release?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  now?: () => Date
  inspectAdministrator?: (signal: AbortSignal) => Promise<boolean>
  inspectPowerShell?: (signal: AbortSignal) => Promise<DiagnosticToolStatus>
  inspectTool?: (tool: DiagnosticToolId, signal: AbortSignal) => Promise<DiagnosticToolStatus>
  inspectCodexDesktop?: (signal: AbortSignal) => Promise<DiagnosticToolStatus>
  inspectProvider?: (provider: ProviderId, roots: ProviderConfigRoots) => NativeConfigInspection
  /** Which relay site's connectivity to probe (XINGMANG_NETWORK). Defaults to the default site. */
  relaySite?: RelaySite
  fetch?: typeof globalThis.fetch
  clashConfigPaths?: readonly string[]
  inspectProxyVariables?: (signal: AbortSignal) => Promise<ProxyVariableSummary[]>
  /**
   * 诊断报告是要上屏、也要能导出给客服的，所以它只装中文结论。认出一个失败靠的
   * 那段上游原文（`net::ERR_CERT_AUTHORITY_INVALID` 这类）留在 runtime.jsonl 里：
   * 用户看结论，排查的人看原文，两边都不用迁就对方。缺省不记。
   */
  log?: (
    level: 'info' | 'warn' | 'error',
    event: string,
    message: string,
    detail?: Record<string, unknown>,
  ) => void
}

export interface DiagnosticRedactionOptions {
  userHome?: string
  codexHome?: string
  /** @deprecated Use userHome. */
  homeDirectory?: string
  sensitiveValues?: readonly string[]
}

export type DiagnosticToolId = 'node' | 'npm' | 'python' | 'git' | ProviderId

interface CheckOutcome {
  state: DiagnosticState
  summary: string
  details?: Record<string, boolean | number | string | null>
}

interface CheckDefinition {
  code: string
  title: string
  run: (signal: AbortSignal) => Promise<CheckOutcome> | CheckOutcome
}

const DEFAULT_CHECK_TIMEOUT_MS = 8_000
const MAX_CLASH_CONFIG_BYTES = 2 * 1024 * 1024
const MAX_CLAUDE_SETTINGS_BYTES = 256 * 1024
const MAX_YAML_ALIAS_COUNT = 20
const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizedPathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function pathApiFor(value: string, ...roots: string[]): typeof path.win32 | typeof path.posix {
  return /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\\\')
    || roots.some((root) => /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\'))
    ? path.win32
    : path.posix
}

function resolvePathLike(value: string): string {
  return pathApiFor(value, value).resolve(value)
}

function isAbsolutePathLike(value: string, roots: ProviderConfigRoots): boolean {
  return pathApiFor(value, roots.userHome, roots.codexHome).isAbsolute(value)
}

function pathForDisplay(filePath: string | null, roots: ProviderConfigRoots): string | null {
  if (!filePath) return null
  const pathApi = pathApiFor(filePath, roots.userHome, roots.codexHome)
  const resolved = pathApi.resolve(filePath)
  const rootLabels = [
    { root: pathApi.resolve(roots.codexHome), label: '[CODEX_HOME]' },
    { root: pathApi.resolve(roots.userHome), label: '~' },
  ].sort((left, right) => right.root.length - left.root.length)
  for (const { root, label } of rootLabels) {
    const relative = pathApi.relative(root, resolved)
    if (relative === '') return label
    if (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative)) {
      return `${label}/${relative.split(pathApi.sep).join('/')}`
    }
  }
  const basename = pathApi.basename(resolved)
  return basename && basename !== pathApi.parse(resolved).root
    ? `[ABSOLUTE_PATH]/${basename}`
    : '[ABSOLUTE_PATH]'
}

function pathOrIdentifierForDisplay(value: string | null, roots: ProviderConfigRoots): string | null {
  if (!value) return null
  return isAbsolutePathLike(value, roots) || value.includes('/') || value.includes('\\')
    ? pathForDisplay(value, roots)
    : value
}

interface RootReplacement {
  candidate: string
  label: string
  caseInsensitive: boolean
}

function rootReplacements(roots: { userHome?: string, codexHome?: string }): RootReplacement[] {
  const replacements = new Map<string, RootReplacement>()
  for (const [root, label] of [
    [roots.codexHome?.trim(), '[CODEX_HOME]'],
    [roots.userHome?.trim(), '~'],
  ] as const) {
    if (!root) continue
    const resolved = resolvePathLike(root)
    const slashRoot = root.replaceAll('\\', '/')
    const slashResolved = resolved.replaceAll('\\', '/')
    const variants = new Set([
      root,
      resolved,
      slashRoot,
      root.replaceAll('/', '\\'),
      slashResolved,
      resolved.replaceAll('/', '\\'),
      slashRoot.replaceAll('/', '\\/'),
      slashResolved.replaceAll('/', '\\/'),
    ])
    for (const variant of [...variants]) variants.add(JSON.stringify(variant).slice(1, -1))
    const caseInsensitive = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\')
    for (const candidate of variants) {
      if (!candidate || replacements.has(candidate)) continue
      replacements.set(candidate, { candidate, label, caseInsensitive })
    }
  }
  return [...replacements.values()].sort((left, right) => right.candidate.length - left.candidate.length)
}

function redactRootPaths(value: string, roots: { userHome?: string, codexHome?: string }): string {
  let result = value
  for (const replacement of rootReplacements(roots)) {
    const flags = replacement.caseInsensitive ? 'gi' : 'g'
    const pattern = new RegExp(
      `(^|[^A-Za-z0-9\\\\/._-])${escapeRegExp(replacement.candidate)}(?=$|[\\\\/]|[^A-Za-z0-9\\\\/._-])`,
      flags,
    )
    result = result.replace(
      pattern,
      (_match, prefix: string) => `${prefix}${replacement.label}`,
    )
  }
  return result
}

function redactStructuredAbsolutePaths(value: unknown, roots: ProviderConfigRoots): unknown {
  if (typeof value === 'string') {
    const redacted = redactRootPaths(value, roots)
    if (redacted !== value) return redacted
    return isAbsolutePathLike(value, roots) ? pathForDisplay(value, roots) : value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactStructuredAbsolutePaths(entry, roots))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      redactStructuredAbsolutePaths(entry, roots),
    ]))
  }
  return value
}

function safeUrlForDisplay(value: string): string {
  if (!value) return ''
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, parsed.pathname === '/' ? '/' : '')
  } catch {
    return '[invalid URL]'
  }
}

function redactUrls(value: string): string {
  return value.replace(/\b(?:https?|socks4|socks5):\/\/[^\s"'<>]+/gi, (match) => {
    const suffix = match.match(/[),.;]+$/)?.[0] ?? ''
    const rawUrl = suffix ? match.slice(0, -suffix.length) : match
    try {
      const parsed = new URL(rawUrl)
      if (parsed.username) parsed.username = '[REDACTED]'
      if (parsed.password) parsed.password = '[REDACTED]'
      if (parsed.search) parsed.search = '?[REDACTED]'
      parsed.hash = ''
      return `${parsed.toString()}${suffix}`
    } catch {
      return `[REDACTED_URL]${suffix}`
    }
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function redactDiagnosticText(
  value: string,
  options: DiagnosticRedactionOptions = {},
): string {
  let result = value
  const secrets = [...new Set((options.sensitiveValues ?? []).filter((entry) => entry.length >= 3))]
    .sort((left, right) => right.length - left.length)
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]')

  result = result
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gi, '[REDACTED]')
    // The quoted spellings need their own rules: in `{"access_token":"…"}` the
    // rule below can never match, because `\s*` does not cross the quote that
    // closes the key name, so any CLI writing JSON to stderr leaked its secrets
    // verbatim into the runtime log and the feedback export. Redacting between
    // the existing quotes also keeps a JSON body parseable.
    .replace(/((?:api[_-]?key|authorization|token|secret|password)"\s*[:=]\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/((?:api[_-]?key|authorization|token|secret|password)'\s*[:=]\s*)'[^']*'/gi, "$1'[REDACTED]'")
    .replace(/((?:api[_-]?key|authorization|token|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
  result = redactUrls(result)

  return redactRootPaths(result, {
    userHome: options.userHome ?? options.homeDirectory,
    codexHome: options.codexHome,
  })
}

export function createDiagnosticsExport(
  report: DiagnosticsReport,
  options: DiagnosticRedactionOptions = {},
): string {
  const userHome = resolvePathLike(options.userHome ?? options.homeDirectory ?? os.homedir())
  const codexHome = resolvePathLike(
    options.codexHome ?? defaultProviderConfigRoots(userHome).codexHome,
  )
  const roots = { userHome, codexHome }
  const payload = {
    product: '星芒AI管理工具',
    exportedAt: new Date().toISOString(),
    diagnostics: redactStructuredAbsolutePaths(report, roots),
  }
  return `${redactDiagnosticText(JSON.stringify(payload, null, 2), {
    ...options,
    userHome,
    codexHome,
  })}\n`
}

function clashCandidates(homeDirectory: string, env: NodeJS.ProcessEnv): string[] {
  const appData = env.APPDATA
  const xdgConfig = env.XDG_CONFIG_HOME
  return [...new Set([
    appData && path.join(appData, 'io.github.clash-verge-rev.clash-verge-rev', 'clash-verge.yaml'),
    appData && path.join(appData, 'clash-verge-rev', 'clash-verge.yaml'),
    xdgConfig && path.join(xdgConfig, 'io.github.clash-verge-rev.clash-verge-rev', 'clash-verge.yaml'),
    path.join(homeDirectory, '.config', 'io.github.clash-verge-rev.clash-verge-rev', 'clash-verge.yaml'),
    path.join(homeDirectory, '.config', 'clash-verge-rev', 'clash-verge.yaml'),
  ].filter((entry): entry is string => Boolean(entry)).map((entry) => path.resolve(entry)))]
}

export function parseClashTunConfig(source: string): boolean {
  if (Buffer.byteLength(source, 'utf8') > MAX_CLASH_CONFIG_BYTES) {
    throw new Error('Clash 配置文件超过解析限制')
  }
  const document = parseDocument(source, {
    schema: 'core',
    customTags: [],
    resolveKnownTags: false,
    merge: false,
    strict: true,
    uniqueKeys: true,
    logLevel: 'silent',
  })
  if (document.errors.length || document.warnings.length) {
    throw new Error('Clash YAML 包含不受支持的结构或标签')
  }
  const value = document.toJS({ maxAliasCount: MAX_YAML_ALIAS_COUNT }) as unknown
  if (!isRecord(value)) throw new Error('Clash YAML 顶层必须是映射')

  if (value.enable_tun_mode === true || value.tun_mode === true) return true
  const tun = value.tun
  return isRecord(tun) && tun.enable === true
}

function findWindowsShim(command: string, env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== 'win32') return null
  const searchPath = env.PATH ?? env.Path ?? env.path ?? ''
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory.replace(/^"(.*)"$/, '$1'), `${command}.cmd`)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // Continue with the next PATH entry.
    }
  }
  return null
}

async function versionForExecutable(
  executable: string,
  tool: DiagnosticToolId,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (!isTrustedHighIntegrityExecutable(executable, env)) return null
  if (process.platform === 'win32' && path.extname(executable).toLowerCase() === '.cmd' && tool !== 'npm') {
    return null
  }
  const args = ['--version']
  const result = await runCommand({
    executable,
    argv: args,
    windowsPackageManager: tool === 'npm' ? 'npm' : undefined,
  }, {
    env: process.platform === 'win32' ? trustedCommandEnvironment(env) : commandEnvironment(env),
    trustedOnly: process.platform === 'win32',
    timeoutMs: 5_000,
    maxOutputBytes: 128 * 1024,
    signal,
  })
  return `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null
}

async function defaultInspectTool(
  tool: DiagnosticToolId,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<DiagnosticToolStatus> {
  if (providerIds.includes(tool as ProviderId)) {
    const provider = tool as ProviderId
    const installation = await resolveCliInstallation(provider, { env })
    if (!installation) return { installed: false, version: null, path: null }
    if (installation.source === 'npm') {
      return {
        installed: true,
        version: installation.packageVersion ?? null,
        path: installation.commandPath,
      }
    }
    try {
      const command = await resolveCliCommand(provider, env, 'trusted-only', {
        darwinStagingRetention: 'ephemeral',
      })
      try {
        if (!isTrustedHighIntegrityExecutable(command.executable, env)) {
          return { installed: true, version: null, path: installation.commandPath }
        }
        const result = await runCommand({
          executable: command.executable,
          argv: [...command.argv, ...cliCatalog[provider].versionArgs],
        }, {
          env: process.platform === 'win32' ? trustedCommandEnvironment(env) : commandEnvironment(env),
          trustedOnly: process.platform === 'win32',
          timeoutMs: 5_000,
          maxOutputBytes: 128 * 1024,
          signal,
        })
        return {
          installed: true,
          version: `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null,
          path: command.verifiedDarwinStandalone?.executablePath ?? installation.commandPath,
        }
      } finally {
        await command.release?.()
      }
    } catch {
      return { installed: true, version: null, path: null }
    }
  }
  const commands = tool === 'python' ? ['python', 'python3', 'py'] : [tool]
  for (const command of commands) {
    const executable = await findExecutable(command, {
      env: commandEnvironment(env),
      windowsPackageManagers: command === 'npm' ? ['npm'] : [],
    }) ?? findWindowsShim(command, env)
    if (!executable) continue
    let version: string | null = null
    try {
      version = await versionForExecutable(executable, tool, signal, env)
    } catch {
      // Presence is still useful when a package-manager shim cannot be executed safely.
    }
    return { installed: true, version, path: executable }
  }
  return { installed: false, version: null, path: null }
}

async function defaultInspectAdministrator(signal: AbortSignal): Promise<boolean> {
  if (process.platform !== 'win32') return typeof process.getuid === 'function' && process.getuid() === 0
  const script = [
    '$identity=[Security.Principal.WindowsIdentity]::GetCurrent()',
    '$principal=[Security.Principal.WindowsPrincipal]::new($identity)',
    '$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  ].join(';')
  const result = await runCommand({
    executable: resolveWindowsPowerShellExecutable(),
    argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
  }, {
    env: trustedCommandEnvironment(),
    trustedOnly: true,
    timeoutMs: 4_000,
    maxOutputBytes: 16 * 1024,
    signal,
  })
  return result.stdout.trim().toLowerCase() === 'true'
}

async function defaultInspectPowerShell(
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<DiagnosticToolStatus> {
  let executable: string
  try {
    executable = resolveWindowsPowerShellExecutable({ env })
  } catch {
    return { installed: false, version: null, path: null }
  }
  const result = await runCommand({
    executable,
    argv: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$PSVersionTable.PSVersion.ToString()',
    ],
  }, {
    env: trustedCommandEnvironment(env),
    trustedOnly: true,
    timeoutMs: 4_000,
    maxOutputBytes: 16 * 1024,
    signal,
  })
  return {
    installed: true,
    version: result.stdout.trim() || null,
    path: executable,
  }
}

async function defaultInspectCodexDesktop(signal: AbortSignal): Promise<DiagnosticToolStatus> {
  if (process.platform !== 'win32') return { installed: false, version: null, path: null, running: false }
  const script = [
    '$app=@(Get-StartApps | Where-Object { $_.AppID -like "OpenAI.Codex*!App" } | Select-Object -First 1 Name,AppID)',
    // AppX registration is per user. Do not fall back to Get-AppxPackage
    // -AllUsers: a normal account is commonly denied that query, and an
    // elevated manager could otherwise report another user's package as
    // launchable from the current profile.
    'if ($app.Count -eq 0) { $pkg=@(Get-AppxPackage -Name "OpenAI.Codex*" | Sort-Object Name | Select-Object -First 1 PackageFamilyName,Version); if ($pkg.Count -gt 0) { $app=@([pscustomobject]@{Name="Codex Desktop $($pkg[0].Version)";AppID="$($pkg[0].PackageFamilyName)!App"}) } }',
    '$running=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "Codex*" }).Count -gt 0',
    '[pscustomobject]@{Name=$app.Name;AppID=$app.AppID;Running=$running}|ConvertTo-Json -Compress',
  ].join(';')
  const result = await runCommand({
    executable: resolveWindowsPowerShellExecutable(),
    argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
  }, {
    env: trustedCommandEnvironment(),
    trustedOnly: true,
    timeoutMs: 6_000,
    maxOutputBytes: 64 * 1024,
    signal,
  })
  const parsed = JSON.parse(result.stdout) as { Name?: unknown; AppID?: unknown; Running?: unknown }
  const appId = typeof parsed.AppID === 'string' ? parsed.AppID : null
  return {
    installed: Boolean(appId),
    version: typeof parsed.Name === 'string' ? parsed.Name : null,
    path: appId,
    running: parsed.Running === true,
  }
}

async function defaultProxyVariables(env: NodeJS.ProcessEnv): Promise<ProxyVariableSummary[]> {
  const result: ProxyVariableSummary[] = []
  const pairs = Object.entries(env)
  for (const name of PROXY_NAMES) {
    const match = pairs.find(([candidate]) => candidate.toUpperCase() === name)
    if (match?.[1]?.trim()) result.push({ name, source: 'process' })
  }
  return result
}

type EnvironmentOverrideKind = 'baseUrl' | 'secret' | 'directory' | 'model' | 'other'

interface EnvironmentOverrideVariable {
  name: string
  provider: ProviderId
  kind: EnvironmentOverrideKind
}

interface EnvironmentOverrideMatch {
  name: string
  provider: ProviderId
  /** false = 用户确实设了它，但它指的就是当前账号，不会把请求带去别处。 */
  overriding: boolean
}

/**
 * 用户自己开终端跑 CLI 时，进程环境里这几个变量的优先级高于配置文件，所以
 * 「配置文件写对了」并不等于「跑起来用的就是当前账号」。这是「我明明配好了却
 * 还是走旧地址」最常见的来源，而检查页此前对此一无所知——四个 PROVIDER_* 项只
 * 看文件。
 *
 * 只读、只提醒：代删别人设的变量等于改用户的机器，而且本进程也删不掉别的 shell
 * 的环境。Grok 的同类变量没有在本仓实测过（`GROK_DISABLE_AUTOUPDATER` 是唯一
 * 核实过的一个，与中转地址无关），按 T12 的口径宁缺勿猜，等实测再补。
 */
const ENVIRONMENT_OVERRIDE_VARIABLES: readonly EnvironmentOverrideVariable[] = [
  { name: 'ANTHROPIC_BASE_URL', provider: 'claude', kind: 'baseUrl' },
  { name: 'ANTHROPIC_AUTH_TOKEN', provider: 'claude', kind: 'secret' },
  { name: 'ANTHROPIC_API_KEY', provider: 'claude', kind: 'secret' },
  { name: 'CLAUDE_CONFIG_DIR', provider: 'claude', kind: 'directory' },
  { name: 'OPENAI_BASE_URL', provider: 'codex', kind: 'baseUrl' },
  { name: 'OPENAI_API_KEY', provider: 'codex', kind: 'secret' },
  { name: 'CODEX_HOME', provider: 'codex', kind: 'directory' },
  { name: 'GOOGLE_GEMINI_BASE_URL', provider: 'gemini', kind: 'baseUrl' },
  { name: 'GEMINI_API_KEY', provider: 'gemini', kind: 'secret' },
  { name: 'GOOGLE_GEMINI_API_KEY', provider: 'gemini', kind: 'secret' },
  { name: 'GEMINI_MODEL', provider: 'gemini', kind: 'model' },
  { name: 'GOOGLE_GENAI_API_VERSION', provider: 'gemini', kind: 'other' },
]

/** 与 defaultProxyVariables 同法：Windows 的环境变量名大小写不敏感。 */
function environmentValueFor(env: NodeJS.ProcessEnv, name: string): string {
  const match = Object.entries(env).find(([candidate]) => candidate.toUpperCase() === name)
  return typeof match?.[1] === 'string' ? match[1].trim() : ''
}

function sameHostAs(value: string, expected: string): boolean {
  try {
    const left = new URL(value)
    const right = new URL(expected)
    return left.protocol === right.protocol && left.host.toLowerCase() === right.host.toLowerCase()
  } catch {
    return false
  }
}

function collectEnvironmentOverrides(
  env: NodeJS.ProcessEnv,
  providerBaseUrls: RelaySite['providerBaseUrls'],
  userHome: string,
): EnvironmentOverrideMatch[] {
  const matches: EnvironmentOverrideMatch[] = []
  for (const variable of ENVIRONMENT_OVERRIDE_VARIABLES) {
    const value = environmentValueFor(env, variable.name)
    if (!value) continue
    // CODEX_HOME 是本程序自己解析出来再注入进 codexEnv 的（codex-home.ts），所以
    // 诊断拿到的 env 里它永远有值。指到默认位置就是本程序自己写的那份，报它等于
    // 每次检查都给一条假警报；只有指到别处才是用户真的改过。
    if (variable.kind === 'directory') {
      const fallback = path.join(userHome, providerConfigDirectoryNames[variable.provider])
      if (normalizedPathKey(value) === normalizedPathKey(fallback)) continue
    }
    matches.push({
      name: variable.name,
      provider: variable.provider,
      // 指向当前站点的 BASE_URL 不会把请求带去别处，报它只会教用户删一个本来
      // 没问题的变量。Key 和模型不在此列：它们盖掉的是账号和分组本身。
      overriding: !(variable.kind === 'baseUrl' && sameHostAs(value, providerBaseUrls[variable.provider])),
    })
  }
  return matches
}

function environmentOverrideOutcome(matches: readonly EnvironmentOverrideMatch[]): CheckOutcome {
  const details: Record<string, boolean | number | string | null> = { count: matches.length }
  matches.forEach((match, index) => {
    // 只有变量名进报告。ANTHROPIC_AUTH_TOKEN 的值本身就是一把 Key，而诊断导出是
    // 要发到客服群里的（I3、I13）——所以这里永远不读也不写它的值。
    const note = match.overriding ? '' : '，已指向当前账号'
    details[`variable${index + 1}`] = `${match.name}（${cliCatalog[match.provider].name}${note}）`
  })
  const overriding = matches.filter((match) => match.overriding)
  if (!overriding.length) {
    return {
      state: 'pass',
      summary: matches.length
        ? '检测到的环境变量都指向当前账号，不会盖过写入的配置'
        : '没有会盖过当前账号配置的环境变量',
      details,
    }
  }
  const listed = overriding.slice(0, 3).map((match) => match.name).join('、')
  const rest = overriding.length > 3 ? `等 ${overriding.length} 项` : ''
  return {
    // 用「需留意」不是「待处理」：变量可能是用户自己有意设的，而本程序既不该也
    // 不能替他删。文案用「可能」——进程环境与 Claude settings.env 的优先级本仓
    // 没实测过，不做断言（T12）。
    state: 'warn',
    summary: `系统环境变量里设置了 ${listed}${rest}，可能会盖过当前账号写入的配置`,
    details,
  }
}

/** 日志里要看得见真正的原因，而 fetch 把它塞在 cause 里，外层只剩 fetch failed。 */
function errorChainText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (typeof current !== 'object') {
      parts.push(String(current))
      break
    }
    const record = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown }
    parts.push([record.name, record.message, record.code]
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      .join(': '))
    current = record.cause
  }
  return parts.filter(Boolean).join(' <- ').slice(0, 500)
}

function providerOutcome(provider: ProviderId, inspection: NativeConfigInspection, roots: ProviderConfigRoots): CheckOutcome {
  const details: Record<string, boolean | number | string | null> = {
    exists: inspection.exists,
    hasApiKey: inspection.hasApiKey,
    matchesRelay: inspection.matchesRelay,
    model: inspection.model || null,
    baseUrl: safeUrlForDisplay(inspection.actualBaseUrl),
    fileCount: inspection.files.length,
    existingFileCount: inspection.files.filter((file) => file.exists).length,
    updatedAt: inspection.updatedAt,
  }
  inspection.files.forEach((file, index) => {
    details[`file${index + 1}`] = pathForDisplay(file.path, roots)
  })
  if (inspection.matchesRelay && inspection.hasApiKey) {
    return { state: 'pass', summary: '已配置星芒 AI', details }
  }
  if (!inspection.exists) return { state: 'warn', summary: '未找到配置文件', details }
  if (!inspection.hasApiKey) return { state: 'fail', summary: '配置中未检测到 API Key', details }
  return { state: 'fail', summary: '当前中转地址不是星芒 AI', details }
}

function countStates(items: DiagnosticItem[]): Record<DiagnosticState, number> {
  return items.reduce<Record<DiagnosticState, number>>((counts, item) => {
    counts[item.state] += 1
    return counts
  }, { pass: 0, warn: 0, fail: 0, error: 0 })
}

async function runIsolatedCheck(
  check: CheckDefinition,
  timeoutMs: number,
  sanitize: (value: string) => string,
): Promise<DiagnosticItem> {
  const controller = new AbortController()
  const startedAt = Date.now()
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        const error = new Error('超时')
        error.name = 'DiagnosticTimeoutError'
        reject(error)
      }, timeoutMs)
      timer.unref()
    })
    const outcome = await Promise.race([Promise.resolve(check.run(controller.signal)), timeout])
    const details = outcome.details
      ? Object.fromEntries(Object.entries(outcome.details).map(([name, detail]) => [
          name,
          typeof detail === 'string' ? sanitize(detail) : detail,
        ]))
      : undefined
    return {
      ...outcome,
      summary: sanitize(outcome.summary),
      details,
      code: check.code,
      title: check.title,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'DiagnosticTimeoutError'
    const reason = timedOut
      ? `单项检查超过 ${timeoutMs}ms`
      : sanitize(error instanceof Error ? error.message : String(error))
    return {
      code: check.code,
      title: check.title,
      state: 'error',
      summary: timedOut ? '检查超时' : '检查时发生错误',
      details: { reason },
      durationMs: Date.now() - startedAt,
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function readClaudeBypass(homeDirectory: string): CheckOutcome {
  const configPath = path.join(homeDirectory, '.claude', 'settings.json')
  if (!fs.existsSync(configPath)) return { state: 'pass', summary: '未检测到 Claude 权限绕过配置' }
  const parsed = JSON.parse(readBoundedUtf8FileSync(
    configPath,
    MAX_CLAUDE_SETTINGS_BYTES,
    'Claude settings.json',
  )) as unknown
  const permissions = isRecord(parsed) && isRecord(parsed.permissions) ? parsed.permissions : null
  const bypass = permissions?.defaultMode === 'bypassPermissions'
  return bypass
    ? { state: 'warn', summary: 'Claude 已开启 bypassPermissions，命令执行将跳过确认' }
    : { state: 'pass', summary: 'Claude 权限模式未设为 bypassPermissions' }
}

export async function runDiagnostics(dependencies: DiagnosticsDependencies): Promise<DiagnosticsReport> {
  const startedAt = Date.now()
  const env = dependencies.env ?? process.env
  const userHome = path.resolve(
    dependencies.providerRoots?.userHome ?? dependencies.homeDirectory ?? os.homedir(),
  )
  const providerRoots = dependencies.providerRoots ?? defaultProviderConfigRoots(userHome, env)
  const codexHome = providerRoots.codexHome
  const displayRoots = { userHome, codexHome }
  const platform = dependencies.platform ?? process.platform
  const arch = dependencies.arch ?? process.arch
  const release = dependencies.release ?? os.release()
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  const inspectProvider = dependencies.inspectProvider
    ?? ((provider, roots) => inspectProviderConfig(provider, roots))
  const relaySite = dependencies.relaySite ?? resolveRelaySite(undefined)
  const providerInspections = new Map<ProviderId, NativeConfigInspection>()
  const knownSecrets: string[] = []
  for (const provider of providerIds) {
    try {
      const inspection = inspectProvider(provider, providerRoots)
      providerInspections.set(provider, inspection)
      if (inspection.apiKey) knownSecrets.push(inspection.apiKey)
    } catch {
      // The isolated provider check will surface its own error.
    }
  }
  const sanitize = (value: string) => redactDiagnosticText(value, {
    userHome,
    codexHome,
    sensitiveValues: knownSecrets,
  })
  const inspectTool = dependencies.inspectTool
    ?? ((tool, signal) => defaultInspectTool(tool, signal, env))
  const inspectPowerShell = dependencies.inspectPowerShell
    ?? ((signal) => defaultInspectPowerShell(signal, env))
  const inspectDesktop = dependencies.inspectCodexDesktop ?? defaultInspectCodexDesktop
  const inspectAdmin = dependencies.inspectAdministrator ?? defaultInspectAdministrator
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  const paths = dependencies.clashConfigPaths ?? clashCandidates(userHome, env)
  const inspectProxy = dependencies.inspectProxyVariables ?? ((signal) => defaultProxyVariables(env))
  const log = dependencies.log
  const supportedPlatform = platform === 'win32' || platform === 'darwin'

  const checks: CheckDefinition[] = [
    {
      code: 'APP_RUNTIME',
      title: '应用运行时',
      run: () => ({
        state: 'pass',
        summary: `${dependencies.app.name} ${dependencies.app.version}`,
        details: { packaged: dependencies.app.packaged },
      }),
    },
    {
      code: 'OPERATING_SYSTEM',
      title: '操作系统',
      run: () => ({
        state: supportedPlatform ? 'pass' : 'warn',
        summary: `${platform} ${release} (${arch})`,
        details: { supported: supportedPlatform },
      }),
    },
    {
      code: 'ADMINISTRATOR',
      title: '运行权限',
      run: async (signal) => {
        const elevated = await inspectAdmin(signal)
        return {
          state: elevated ? 'warn' : 'pass',
          summary: elevated ? '当前以管理员权限运行，建议普通启动' : '当前以普通用户权限运行',
          details: { elevated, required: false },
        }
      },
    },
    {
      code: 'SYSTEM_POWERSHELL',
      title: 'PowerShell 启动环境',
      run: async (signal) => {
        if (platform !== 'win32') {
          return {
            state: 'pass',
            summary: '当前平台不使用 Windows PowerShell 启动 CLI',
            details: { required: false, installed: null, path: null },
          }
        }
        const status = await inspectPowerShell(signal)
        return {
          state: status.installed ? 'pass' : 'fail',
          summary: status.installed
            ? `可用${status.version ? `（${status.version}）` : ''}`
            : '未找到可用的 Windows PowerShell 5.1 或 PowerShell 7',
          details: {
            required: true,
            installed: status.installed,
            path: pathForDisplay(status.path, displayRoots),
          },
        }
      },
    },
    ...(['node', 'npm', 'python'] as const).map<CheckDefinition>((tool) => ({
      code: `RUNTIME_${tool.toUpperCase()}`,
      title: `${tool === 'python' ? 'Python' : tool} 环境`,
      run: async (signal) => {
        const status = await inspectTool(tool, signal)
        const required = tool !== 'python'
        return {
          state: status.installed ? 'pass' : required ? 'fail' : 'warn',
          summary: status.installed ? (status.version || '已安装') : '未安装',
          details: { installed: status.installed, path: pathForDisplay(status.path, displayRoots) },
        }
      },
    })),
    {
      // 官方文档明说 Git for Windows 是 optional，所以缺了最重也只是「需留意」：
      // 把它判成待处理会让一个用不到 bash 的客户以为软件装坏了。要说的是
      // 「缺了会怎样」，文案在 git-runtime.ts（与插件市场那条共用）。
      code: 'RUNTIME_GIT',
      title: 'Git 环境',
      run: async (signal) => {
        const status = await inspectTool('git', signal)
        return {
          state: status.installed ? 'pass' : 'warn',
          summary: status.installed
            ? (status.version || '已安装')
            : gitMissingNotice(platform),
          details: {
            required: false,
            installed: status.installed,
            path: pathForDisplay(status.path, displayRoots),
          },
        }
      },
    },
    ...providerIds.map<CheckDefinition>((provider) => ({
      code: `CLI_${provider.toUpperCase()}`,
      title: `${cliCatalog[provider].name} 环境`,
      run: async (signal) => {
        const status = await inspectTool(provider, signal)
        return {
          state: status.installed ? 'pass' : 'warn',
          summary: status.installed ? (status.version || '已安装') : '未安装',
          details: { installed: status.installed, path: pathForDisplay(status.path, displayRoots) },
        }
      },
    })),
    {
      code: 'CODEX_DESKTOP',
      title: 'Codex 桌面端',
      run: async (signal) => {
        const status = await inspectDesktop(signal)
        return {
          state: status.installed ? 'pass' : 'warn',
          summary: status.installed ? (status.running ? '已安装并正在运行' : '已安装，当前未运行') : '未安装',
          details: {
            installed: status.installed,
            running: status.running ?? false,
            path: pathOrIdentifierForDisplay(status.path, displayRoots),
          },
        }
      },
    },
    ...providerIds.map<CheckDefinition>((provider) => ({
      code: `PROVIDER_${provider.toUpperCase()}`,
      title: `${cliCatalog[provider].name} 中转配置`,
      run: () => {
        const inspection = providerInspections.get(provider) ?? inspectProvider(provider, providerRoots)
        return providerOutcome(provider, inspection, displayRoots)
      },
    })),
    {
      // 这一项此前把任何失败都交给 runIsolatedCheck 的兜底，于是 DNS 解析不了、
      // 公司网关换掉证书、酒店 Wi-Fi 门户劫持在页面上长得一模一样：一句「检查时
      // 发生错误」，原因还是一行英文，藏在详情抽屉里。归类复用 network-failure.ts
      // （登录页用的是同一份文案），判断只用这里本来就要发的这一次请求。
      code: 'XINGMANG_NETWORK',
      title: '星芒 AI 网络',
      run: async (signal): Promise<CheckOutcome> => {
        if (!fetchImpl) throw new Error('当前运行时不支持 fetch')
        const endpoint = `${relayApiProbeBaseUrl(relaySite)}/`
        let response: Response
        try {
          response = await fetchImpl(endpoint, {
            method: 'HEAD',
            redirect: 'error',
            signal,
            headers: { Accept: 'application/json,text/plain,*/*' },
          })
        } catch (error) {
          const reason = classifyNetworkFailure(error)
          // 认不出来就照旧抛给兜底。把一个跟网络无关的故障说成「换个网络再试」，
          // 只会让用户白折腾一轮（同 network-failure.ts 的口径）。
          if (!reason) throw error
          log?.('warn', 'diagnostics.network.failed', `星芒 AI 网络检查失败（${reason}）`, {
            endpoint,
            reason,
            raw: sanitize(errorChainText(error)),
          })
          return { state: 'fail', summary: networkFailureMessages[reason], details: { endpoint, reason } }
        }
        // 门户认证页的另一种形态：HEAD 明明成功，回来的却是一张 HTML 登录页。
        // 这时没有异常可归类，只能从 content-type 认出来。
        const contentType = response.headers.get('content-type') ?? ''
        if (response.ok && /^\s*text\/html\b/i.test(contentType)) {
          log?.('warn', 'diagnostics.network.failed', '星芒 AI 网络检查被拦截（intercepted）', {
            endpoint,
            reason: 'intercepted',
            status: response.status,
            contentType,
          })
          return {
            state: 'fail',
            summary: networkFailureMessages.intercepted,
            details: { endpoint, reason: 'intercepted', status: response.status },
          }
        }
        if (!response.ok) {
          log?.('warn', 'diagnostics.network.failed', `星芒 AI 网络检查返回 HTTP ${response.status}`, {
            endpoint,
            status: response.status,
          })
          // 网络本身是通的，所以不该说「换个网络」：这是服务端那一侧的事。
          return {
            state: 'fail',
            summary: `网络能连通，但星芒 AI 返回 HTTP ${response.status}，多半是服务端暂时的问题，请稍后再试。`,
            details: { endpoint, status: response.status },
          }
        }
        return {
          state: 'pass',
          summary: `已连通（HTTP ${response.status}）`,
          details: { endpoint, status: response.status },
        }
      },
    },
    {
      code: 'CLASH_VERGE_TUN',
      title: 'Clash Verge Rev TUN 模式',
      run: () => {
        let detectedPath: string | null = null
        for (const candidate of paths) {
          if (!fs.existsSync(candidate)) continue
          detectedPath ??= candidate
          const enabled = parseClashTunConfig(readBoundedUtf8FileSync(
            candidate,
            MAX_CLASH_CONFIG_BYTES,
            'Clash 配置文件',
          ))
          if (enabled) {
            return {
              state: 'warn',
              summary: '检测到 TUN 模式已开启',
              details: { enabled: true, path: pathForDisplay(candidate, displayRoots) },
            }
          }
        }
        return {
          state: 'pass',
          summary: detectedPath ? 'TUN 模式未开启' : '未找到 Clash Verge Rev 配置',
          details: { enabled: false, path: pathForDisplay(detectedPath, displayRoots) },
        }
      },
    },
    {
      code: 'PROXY_ENVIRONMENT',
      title: '系统代理环境变量',
      run: async (signal) => {
        const variables = await inspectProxy(signal)
        const unique = [...new Map(variables.map((item) => [`${item.name}:${item.source}`, item])).values()]
          .sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source))
        return {
          state: unique.length ? 'warn' : 'pass',
          summary: unique.length ? `检测到 ${unique.length} 项代理环境变量` : '未检测到代理环境变量',
          details: Object.fromEntries(unique.map((item, index) => [`variable${index + 1}`, `${item.name} (${item.source})`])),
        }
      },
    },
    {
      code: 'PROVIDER_ENVIRONMENT_OVERRIDE',
      title: '环境变量覆盖',
      run: () => environmentOverrideOutcome(
        collectEnvironmentOverrides(env, relaySite.providerBaseUrls, userHome),
      ),
    },
    {
      code: 'CODEX_DOTENV',
      title: 'Codex .env 冲突',
      run: () => {
        const envPath = path.join(codexHome, '.env')
        const exists = fs.existsSync(envPath)
        return {
          state: exists ? 'warn' : 'pass',
          summary: exists ? '检测到 .codex/.env，可能覆盖当前中转配置' : '未检测到 .codex/.env 冲突',
          details: { exists, path: pathForDisplay(envPath, displayRoots) },
        }
      },
    },
    {
      code: 'CLAUDE_BYPASS_PERMISSIONS',
      title: 'Claude 权限风险',
      run: () => readClaudeBypass(userHome),
    },
  ]

  const items = await Promise.all(checks.map((check) => runIsolatedCheck(check, timeoutMs, sanitize)))
  return {
    version: 1,
    generatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    durationMs: Date.now() - startedAt,
    counts: countStates(items),
    items,
  }
}
