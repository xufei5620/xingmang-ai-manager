import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { readBoundedUtf8FileSync } from './bounded-file'
import { cliCatalog, providerIds, type ProviderId } from './catalog'
import {
  commandEnvironment,
  findExecutable,
  isTrustedHighIntegrityExecutable,
  runCommand,
  trustedCommandEnvironment,
} from './command-runner'
import { defaultProviderConfigRoots, type ProviderConfigRoots } from './codex-home'
import { inspectProviderConfig, type NativeConfigInspection } from './config-files'
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
  fetch?: typeof globalThis.fetch
  clashConfigPaths?: readonly string[]
  inspectProxyVariables?: (signal: AbortSignal) => Promise<ProxyVariableSummary[]>
}

export interface DiagnosticRedactionOptions {
  userHome?: string
  codexHome?: string
  /** @deprecated Use userHome. */
  homeDirectory?: string
  sensitiveValues?: readonly string[]
}

export type DiagnosticToolId = 'node' | 'npm' | 'python' | ProviderId

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
    // An elevated manager may have no Start Menu registration in its own
    // profile. AppX metadata is machine-readable and is the authoritative
    // fallback for packages installed for another user.
    'if ($app.Count -eq 0) { $pkg=@(Get-AppxPackage -Name "OpenAI.Codex*" | Sort-Object Name | Select-Object -First 1 PackageFamilyName,Version); if ($pkg.Count -eq 0) { $pkg=@(Get-AppxPackage -AllUsers -Name "OpenAI.Codex*" | Sort-Object Name | Select-Object -First 1 PackageFamilyName,Version) }; if ($pkg.Count -gt 0) { $app=@([pscustomobject]@{Name="Codex Desktop $($pkg[0].Version)";AppID="$($pkg[0].PackageFamilyName)!App"}) } }',
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
      code: 'XINGMANG_NETWORK',
      title: '星芒 AI 网络',
      run: async (signal) => {
        if (!fetchImpl) throw new Error('当前运行时不支持 fetch')
        const response = await fetchImpl('https://api.solov.cc/', {
          method: 'HEAD',
          redirect: 'error',
          signal,
          headers: { Accept: 'application/json,text/plain,*/*' },
        })
        if (!response.ok) throw new Error(`星芒 AI 返回 HTTP ${response.status}`)
        return {
          state: 'pass',
          summary: `已连通（HTTP ${response.status}）`,
          details: { endpoint: 'https://api.solov.cc/', status: response.status },
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
