import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { readBoundedUtf8FileSync } from './bounded-file'
import { readBoundedResponseText } from './bounded-response'
import { cliCatalog, providerConfigDirectoryNames, providerIds, type ProviderId } from './catalog'
import {
  commandEnvironment,
  findExecutable,
  isTrustedHighIntegrityExecutable,
  runCommand,
  trustedCommandEnvironment,
} from './command-runner'
import { defaultProviderConfigRoots, type IgnoredCodexHome, type ProviderConfigRoots } from './codex-home'
import { inspectProviderConfig, type NativeConfigInspection } from './config-files'
import {
  formatFreeSpace,
  installMinimumFreeBytes,
  lowDiskSpaceBytes,
  mergeSameDeviceReadings,
  readDiskSpace,
  type DiskSpaceReading,
} from './disk-space'
import { gitMissingImpact, gitMissingNotice } from './git-runtime'
import {
  commandLineToolsShimNotice,
  isCommandLineToolsShimBacked,
  isMacOsCommandLineToolsShim,
} from './macos-command-line-tools'
import { managedCliRoot } from './managed-cli-paths'
import { classifyNetworkFailure, networkFailureMessages } from './network-failure'
import { redactSecretPatterns } from './redaction-patterns'
import { relayApiProbeBaseUrl, resolveRelaySite, type RelaySite } from './relay-sites'
import { resolveCliCommand, resolveCliInstallation } from './tool-installation'
import type { ToolConfigOwnership } from './tool-config-ownership'
import {
  inspectWindowsElevationCapability,
  resolveWindowsPowerShellExecutable,
  type WindowsElevationCapability,
} from './windows-elevation'

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
  /** macOS：PATH 上只找到了命令行开发者工具的空壳，没去执行它（见 macos-command-line-tools.ts）。 */
  commandLineToolsShim?: boolean
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
  /** 当前 Windows 账号能不能自己提权（不是「现在是不是管理员」，见 windows-elevation.ts）。 */
  inspectElevationCapability?: (signal: AbortSignal) => Promise<WindowsElevationCapability>
  inspectPowerShell?: (signal: AbortSignal) => Promise<DiagnosticToolStatus>
  inspectTool?: (tool: DiagnosticToolId, signal: AbortSignal) => Promise<DiagnosticToolStatus>
  inspectCodexDesktop?: (signal: AbortSignal) => Promise<DiagnosticToolStatus>
  inspectProvider?: (provider: ProviderId, roots: ProviderConfigRoots) => NativeConfigInspection
  /**
   * 「Claude 命令确认方式」那一项要先知道这份 settings.json 是不是本软件替当前账号写
   * 的（`account`），否则每个配置正常的用户都会被自己造成的配置警告一次。诊断自己算
   * 不出来源（判定要读 userData 下的所有权记录并比对当前登录账号），宿主给了才分流，
   * 不给就按「不是我们写的」处理。
   */
  readClaudeConfigOwnership?: () => ToolConfigOwnership | null | undefined
  /** Which relay site's connectivity to probe (XINGMANG_NETWORK). Defaults to the default site. */
  relaySite?: RelaySite
  fetch?: typeof globalThis.fetch
  clashConfigPaths?: readonly string[]
  /**
   * 软件数据目录（Electron 的 userData）。诊断自己算不出它在哪，宿主给了才把它
   * 算进「磁盘空间」这一项；不给就只看 CLI 落点。
   */
  userDataDirectory?: string
  /** 剩余空间的读取口，测试用它造「够 / 不够 / 读不到」三种盘。 */
  readDiskSpace?: typeof readDiskSpace
  inspectProxyVariables?: (signal: AbortSignal) => Promise<ProxyVariableSummary[]>
  /**
   * 启动时发现用户环境里的 CODEX_HOME 不可用、已按没设处理（codex-home.ts）。
   * 传进来的 env 里 CODEX_HOME 已被换成本程序算出的位置，诊断自己看不到原值，
   * 只能由宿主告诉它。原值只用来判断会不会连不上，从不进报告。
   */
  ignoredCodexHome?: IgnoredCodexHome
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
/**
 * 差多少才值得说。证书校验本身有容差，本机时钟与服务器差几十秒也是常态，
 * 阈值定低了就是每次检查都亮一条没人能处理的黄灯。
 */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const MAX_CLASH_CONFIG_BYTES = 2 * 1024 * 1024
const MAX_CLAUDE_SETTINGS_BYTES = 256 * 1024
/** 两个站的状态接口都只回几 KB 的 JSON；门户页再大也用不着读完才认出来。 */
const MAX_NETWORK_PROBE_BYTES = 256 * 1024
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

  result = redactUrls(redactSecretPatterns(result))

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
  let commandLineToolsShim = false
  for (const command of commands) {
    const executable = await findExecutable(command, {
      env: commandEnvironment(env),
      windowsPackageManagers: command === 'npm' ? ['npm'] : [],
    }) ?? findWindowsShim(command, env)
    if (!executable) continue
    if (
      isMacOsCommandLineToolsShim(executable)
      && !await isCommandLineToolsShimBacked(executable, { env, signal })
    ) {
      commandLineToolsShim = true
      continue
    }
    let version: string | null = null
    try {
      version = await versionForExecutable(executable, tool, signal, env)
    } catch {
      // Presence is still useful when a package-manager shim cannot be executed safely.
    }
    return { installed: true, version, path: executable }
  }
  if (commandLineToolsShim) return { installed: false, version: null, path: null, commandLineToolsShim }
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

/**
 * 网络那一项探测的地址：当前站点上一个不用登录、本来就回 JSON 的公开接口。
 *
 * 站点根路径不能用来判断「被拦截」：两个站的根路径都是网页前端，正常时也回
 * text/html，#302 就是因此对所有人误报。换成本来就回 JSON 的接口后，「拿到的
 * 是网页而不是 JSON」才真正说明中间有东西替服务器答了话。两个接口都已按上游
 * 源码核实：new-api 的 `GET /api/status`（docs/RECON-new-api.md 的「状态」行，
 * 公开）与 sub2api 的 `GET /api/v1/settings/public`（登录页自己读的公开设置）。
 * 都在 /api 下，是账号客户端本来就要走的路径，不会被只放行 /api 与 /v1 的反代
 * 挡在外面。两者都只认 GET：gin 不会把 HEAD 路由到 GET 处理器，HEAD 拿不到这份
 * JSON。
 *
 * 地址跟着 CLI 实际调用的域走（relayApiProbeBaseUrl），今天两个站的中转域与
 * 账号域恰好同域，所以接口按 accountBackend 选。
 */
export function relayStatusProbeUrl(site: RelaySite): string {
  const origin = new URL(relayApiProbeBaseUrl(site))
  if (origin.protocol !== 'https:') throw new Error('星芒 AI 地址不是 https，已拒绝检查')
  switch (site.accountBackend) {
    case 'new-api':
      return new URL('/api/status', origin).href
    case 'sub2api':
      return new URL('/api/v1/settings/public', origin).href
  }
}

function parsesAsJson(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null
  } catch {
    return false
  }
}

/**
 * 一张证书有没有过期，是拿本机时钟去比出来的：系统时间差得多，每一张正常的证书
 * 都会当场变成「已过期」，于是登录、装 CLI、检查更新一起卡在证书校验这一步，而
 * 用户看到的只是「换个网络」。HTTP 的 Date 头里就带着服务器那一侧的时间，顺手比
 * 一次不用新发任何请求。
 *
 * 没有 Date 头、或者这个头不是一个能解析的时间，就返回 null——宁可不说，也不要
 * 拿一个解析不出来的值去吓用户。
 */
export function clockSkewMs(dateHeader: string | null | undefined, now: Date): number | null {
  if (!dateHeader) return null
  const serverTime = Date.parse(dateHeader)
  if (!Number.isFinite(serverTime)) return null
  return now.getTime() - serverTime
}

/** 对时入口每个系统都不一样，说不清具体在哪一页的提示等于没说。 */
export function clockSyncGuidance(platform: NodeJS.Platform): string {
  if (platform === 'win32') return '请在「设置 → 时间和语言 → 日期和时间」里打开「自动设置时间」，并确认时区正确。'
  if (platform === 'darwin') return '请在「系统设置 → 通用 → 日期与时间」里打开「自动设置时间和日期」，并确认时区正确。'
  return '请把系统时间设为自动同步，并确认时区正确。'
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

interface IgnoredCodexHomeFinding {
  /** true = 在软件外面打开的 Codex 读不到本程序替当前账号写好的配置。 */
  blocking: boolean
}

/**
 * 软件自己启动的 Codex 拿到的是注入过的 CODEX_HOME，不受影响；受影响的是用户
 * 从开始菜单、终端这些软件外面打开的 Codex，它读的仍是那个写错的值。Codex 不展开
 * `~` 和 `%USERPROFILE%`，相对路径按当前目录解析，而这类进程的当前目录通常就是
 * 用户目录，所以按用户目录解析一次：落回本程序写配置的那个目录（比如只写了
 * `.codex`）就还连得上，否则就连不上。Codex 根本没接当前账号时，连不连得上
 * 无从谈起，只提醒不算待处理。
 */
function inspectIgnoredCodexHome(
  ignored: IgnoredCodexHome | undefined,
  roots: ProviderConfigRoots,
  codexInspection: NativeConfigInspection | undefined,
): IgnoredCodexHomeFinding | null {
  if (!ignored) return null
  const configured = Boolean(codexInspection?.matchesRelay && codexInspection.hasApiKey)
  const landsOnCodexHome = ignored.reason === 'relative'
    && normalizedPathKey(path.resolve(roots.userHome, ignored.value)) === normalizedPathKey(roots.codexHome)
  return { blocking: configured && !landsOnCodexHome }
}

/**
 * 叠在 environmentOverrideOutcome 之后而不是改它：写错的 CODEX_HOME 不是「盖过
 * 配置」，是「本来要盖、被本程序忽略了」，结论要单独说，其余变量的判定原样保留。
 */
function withIgnoredCodexHome(outcome: CheckOutcome, finding: IgnoredCodexHomeFinding | null): CheckOutcome {
  if (!finding) return outcome
  const previous = outcome.details ?? {}
  const labels = Object.keys(previous)
    .filter((key) => /^variable\d+$/.test(key))
    .sort((left, right) => Number(left.slice(8)) - Number(right.slice(8)))
    .map((key) => previous[key])
  const details: Record<string, boolean | number | string | null> = {
    ...Object.fromEntries(Object.entries(previous).filter(([key]) => !/^variable\d+$/.test(key))),
    count: labels.length + 1,
  }
  // 写错的原值可能带着用户名，和其它变量一样只有名字进报告。
  const ordered = [`CODEX_HOME（${cliCatalog.codex.name}，写得不对，已忽略）`, ...labels]
  ordered.forEach((label, index) => {
    details[`variable${index + 1}`] = label
  })
  const effect = finding.blocking ? '，但在软件外面打开 Codex 会连不上当前账号' : ''
  const others = outcome.state === 'pass' ? '' : `；另外${outcome.summary}`
  // 连不上当前账号才算「待处理」（开机横幅只数这一档）；软件里打开的 Codex 本来
  // 就不受影响，其余情况只是提醒。其它变量已经判出更重的一档时不往下拉。
  const state = finding.blocking || outcome.state === 'fail' ? 'fail' : 'warn'
  return { state, summary: `电脑里有一个 Codex 的设置写得不对，软件已经忽略它${effect}${others}`, details }
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

/**
 * 本软件写 Claude 配置时本来就会带上 permissions.defaultMode = 'bypassPermissions'
 * （不这么写，用户每跑一条命令都要按一次确认，而这是本产品替客户省掉的门槛之一）。
 * 所以「文件里是 bypass」单独看不说明任何问题：它多半就是我们自己刚写的。只有确认
 * 这份配置是本软件替当前账号写下的（所有权 `account`）才当成正常状态；来源判不准
 * （用户手改过、别的工具写的、没登录、指纹对不上的 `changed`）时照旧提醒，因为那种
 * 情况下用户确实可能不知道自己的 AI 正在不打招呼地执行命令。
 */
function readClaudeBypass(homeDirectory: string, ownership: ToolConfigOwnership | null): CheckOutcome {
  const configPath = path.join(homeDirectory, '.claude', 'settings.json')
  if (!fs.existsSync(configPath)) return { state: 'pass', summary: '未检测到 Claude 权限绕过配置' }
  const parsed = JSON.parse(readBoundedUtf8FileSync(
    configPath,
    MAX_CLAUDE_SETTINGS_BYTES,
    'Claude settings.json',
  )) as unknown
  const permissions = isRecord(parsed) && isRecord(parsed.permissions) ? parsed.permissions : null
  const bypass = permissions?.defaultMode === 'bypassPermissions'
  if (!bypass) return { state: 'pass', summary: 'Claude 未跳过命令执行确认', details: { bypass, managed: false } }
  if (ownership === 'account') {
    return {
      state: 'pass',
      summary: '按当前账号的配置，Claude 执行命令时不再逐条确认',
      details: { bypass, managed: true },
    }
  }
  return {
    state: 'warn',
    summary: 'Claude 已开启 bypassPermissions，命令执行将跳过确认',
    details: { bypass, managed: false },
  }
}

/**
 * 「磁盘空间」这一项只看两处：CLI 落点（托管目录）和软件数据目录。托管目录在
 * Windows 上要有可信的 ProgramData 才算得出来，算不出就不看这一处；软件数据目录
 * 由宿主给出（诊断自己算不出 Electron 的 userData 在哪）。
 */
function resolveDiskSpaceTargets(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  userDataDirectory?: string,
): readonly { label: string, path: string }[] {
  const targets: { label: string, path: string }[] = []
  try {
    targets.push({ label: '工具安装目录', path: managedCliRoot(env, platform) })
  } catch {
    // 托管目录都算不出来的机器上装不了工具，这一项也就无从说起。
  }
  if (userDataDirectory?.trim()) targets.push({ label: '软件数据目录', path: userDataDirectory })
  return targets
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
  const inspectElevation = dependencies.inspectElevationCapability
    ?? ((signal) => inspectWindowsElevationCapability({ timeoutMs: 8_000, signal }))
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  const paths = dependencies.clashConfigPaths ?? clashCandidates(userHome, env)
  const inspectProxy = dependencies.inspectProxyVariables ?? ((signal) => defaultProxyVariables(env))
  const probeDiskSpace = dependencies.readDiskSpace ?? readDiskSpace
  const diskSpaceTargets = resolveDiskSpaceTargets(env, platform, dependencies.userDataDirectory)
  const log = dependencies.log
  const now = dependencies.now ?? (() => new Date())
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
      // 这一项问两件事。一是「现在是不是管理员在跑」——是的话仍然建议普通启动。
      // 二是「这个账号需要时能不能提权」：Node.js 是机器级 MSI、Codex 桌面端是
      // Appx，两处都会弹 UAC，普通账号走到那一步才失败，太晚了。macOS 上本程序
      // 从不提权，所以第二问只在 Windows 上做。
      code: 'ADMINISTRATOR',
      title: '运行权限',
      run: async (signal) => {
        const elevated = await inspectAdmin(signal)
        if (elevated) {
          return {
            state: 'warn',
            summary: '当前以管理员权限运行，建议普通启动',
            details: { elevated, required: false, canElevate: true },
          }
        }
        const capability = platform === 'win32' ? await inspectElevation(signal) : 'unknown'
        if (capability === 'standard') {
          return {
            state: 'warn',
            summary: '当前以普通用户权限运行。这个 Windows 账号不在管理员组，自动安装 Node.js、Codex 桌面端时会要求输入一个管理员账号的密码；公司或学校的电脑请联系 IT 协助，也可以请 IT 先装好 Node.js LTS 再回来点「重新检测」',
            details: { elevated, required: false, canElevate: false },
          }
        }
        return {
          state: 'pass',
          summary: '当前以普通用户权限运行',
          details: { elevated, required: false, canElevate: capability === 'administrator' ? true : null },
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
          summary: status.installed
            ? (status.version || '已安装')
            : status.commandLineToolsShim ? `未安装。${commandLineToolsShimNotice('python3')}。` : '未安装',
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
            : status.commandLineToolsShim
              ? `${commandLineToolsShimNotice('git')}。${gitMissingImpact(platform)}。`
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
        const endpoint = relayStatusProbeUrl(relaySite)
        let response: Response
        let body = ''
        try {
          response = await fetchImpl(endpoint, {
            method: 'GET',
            credentials: 'omit',
            redirect: 'error',
            signal,
            headers: { Accept: 'application/json' },
          })
          // 只有 2xx 才看内容；非 2xx 的错误页不读，免得一张大错误页顶掉下面那句 HTTP 状态。
          if (response.ok) body = await readBoundedResponseText(response, MAX_NETWORK_PROBE_BYTES, '星芒 AI 状态接口')
          else await response.body?.cancel().catch(() => undefined)
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
        // 门户认证页的另一种形态：请求明明成功，回来的却是一张 HTML 登录页。
        // 这时没有异常可归类，只能从内容认出来：这个接口正常时一定回 JSON，
        // 拿到别的（网页、空白）就是中间有东西替服务器答了话。
        if (response.ok && !parsesAsJson(body)) {
          const contentType = response.headers.get('content-type') ?? ''
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
        // 这一次请求已经拿到了响应头，Date 就在里面：顺手和本机时间比一次，
        // 把「证书日期对不上」的真正源头提前抓出来，不新增任何请求。
        const skewMs = clockSkewMs(response.headers.get('date'), now())
        if (skewMs !== null && Math.abs(skewMs) > MAX_CLOCK_SKEW_MS) {
          const minutes = Math.round(Math.abs(skewMs) / 60_000)
          return {
            state: 'warn',
            summary: `已连通（HTTP ${response.status}），但这台电脑的系统时间与服务器相差约 ${minutes} 分钟，`
              + `可能让登录、安装、更新卡在证书校验这一步。${clockSyncGuidance(platform)}`,
            details: { endpoint, status: response.status, clockSkewMinutes: Math.round(skewMs / 60_000) },
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
      // 8G 内存的机器通常也是 128/256G 的小硬盘，C 盘剩几百兆很常见，而装一个
      // CLI 的峰值要两份空间（临时目录装完整份再原子替换）。装到一半才报
      // ENOSPC 是最难受的失败方式，所以这一项的用处是「还没出事先说一声」。
      code: 'DISK_SPACE',
      title: '磁盘空间',
      run: async () => {
        const readings = mergeSameDeviceReadings(
          (await Promise.all(diskSpaceTargets.map(async (entry) => {
            const reading = await probeDiskSpace(entry.path)
            return reading ? { ...entry, reading } : null
          })))
            .filter((entry): entry is { label: string, path: string, reading: DiskSpaceReading } => entry !== null)
            .map((entry) => ({ ...entry.reading, label: entry.label })),
        )
        // 读不到不算失败：网络盘、交接点上 statfs 本来就可能不给数字，为此报一
        // 条待处理只会让人去修一个没坏的东西。
        if (!readings.length) {
          return {
            state: 'warn',
            summary: '未能读取磁盘剩余空间，这一项这次跳过',
            details: { measured: 0 },
          }
        }
        const tightest = readings.reduce(
          (left, right) => (right.availableBytes < left.availableBytes ? right : left),
        )
        const state: DiagnosticState = tightest.availableBytes < installMinimumFreeBytes
          ? 'fail'
          : tightest.availableBytes < lowDiskSpaceBytes ? 'warn' : 'pass'
        const summary = readings
          .map((reading) => `${reading.label}所在磁盘剩余 ${formatFreeSpace(reading.availableBytes)}`)
          .join('；')
        const details: Record<string, boolean | number | string | null> = { measured: readings.length }
        for (const [index, reading] of readings.entries()) {
          details[`disk${index + 1}`] = `${reading.label}：${formatFreeSpace(reading.availableBytes)} / `
            + `${formatFreeSpace(reading.totalBytes)}`
          details[`path${index + 1}`] = pathForDisplay(reading.measuredPath, displayRoots)
        }
        return {
          state,
          summary: state === 'fail'
            ? `${summary}，已经装不下新工具了，请清理后再安装或更新`
            : state === 'warn'
              ? `${summary}，空间偏紧，安装或更新工具前建议先清理一些`
              : summary,
          details,
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
      run: () => withIgnoredCodexHome(
        environmentOverrideOutcome(collectEnvironmentOverrides(env, relaySite.providerBaseUrls, userHome)),
        inspectIgnoredCodexHome(dependencies.ignoredCodexHome, providerRoots, providerInspections.get('codex')),
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
      title: 'Claude 命令确认方式',
      run: () => readClaudeBypass(userHome, dependencies.readClaudeConfigOwnership?.() ?? null),
    },
  ]

  const items = await Promise.all(checks.map((check) => runIsolatedCheck(check, timeoutMs, sanitize)))
  return {
    version: 1,
    generatedAt: now().toISOString(),
    durationMs: Date.now() - startedAt,
    counts: countStates(items),
    items,
  }
}
