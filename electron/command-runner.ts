import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { isDarwinForeignWritablePath } from './darwin-path-trust'
import { darwinCommandPathCandidates } from './macos-platform'
import { managedNativeProviderRoot, managedNpmBinDirectory } from './managed-cli-paths'
import { isRegisteredTrustedManagedWindowsPath } from './managed-path-trust'
import {
  isTrustedWindowsMachinePath,
  pathWithinWindowsRoot,
  resolveWindowsMachinePaths,
  type WindowsMachinePaths,
} from './windows-machine-paths'

const ANSI_PATTERN = /[\u001B\u009B](?:\][^\u0007]*(?:\u0007|\u001B\\)|[[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_KILL_GRACE_MS = 500

export type WindowsPackageManager = 'npm' | 'npx'

export type CommandErrorCode =
  | 'INVALID_COMMAND'
  | 'UNSAFE_COMMAND'
  | 'SPAWN_FAILED'
  | 'TIMED_OUT'
  | 'ABORTED'
  | 'OUTPUT_LIMIT'
  | 'EXIT_NON_ZERO'

export interface CommandSpec {
  executable: string
  argv: readonly string[]
  /**
   * Windows cannot execute a .cmd file without a command interpreter. For the
   * two package-manager shims used by this app, the runner resolves the shim to
   * node.exe + npm-cli.js/npx-cli.js instead of invoking cmd.exe.
   */
  windowsPackageManager?: WindowsPackageManager
}

export interface CommandOutputEvent {
  stream: 'stdout' | 'stderr'
  text: string
}

export interface RunCommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
  killSignal?: NodeJS.Signals
  killGraceMs?: number
  acceptedExitCodes?: readonly number[]
  sensitiveValues?: readonly string[]
  windowsHide?: boolean
  /** Only resolve and execute binaries from machine/system locations. */
  trustedOnly?: boolean
  /** Files consumed by a trusted command, such as an MSI or PowerShell script. */
  trustedPaths?: readonly string[]
  machinePaths?: WindowsMachinePaths
  onOutput?: (event: CommandOutputEvent) => void
}

export interface CommandResult {
  executable: string
  argv: string[]
  exitCode: number
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  outputBytes: number
  durationMs: number
}

export interface CommandErrorDetails {
  code: CommandErrorCode
  executable: string
  argv: string[]
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  outputBytes: number
  maxOutputBytes: number
  durationMs: number
}

export interface FindExecutableOptions {
  env?: NodeJS.ProcessEnv
  additionalPaths?: readonly string[]
  windowsPackageManagers?: readonly WindowsPackageManager[]
  trustedOnly?: boolean
  machinePaths?: WindowsMachinePaths
}

export interface WindowsSystemExecutableDependencies {
  currentPlatform?: NodeJS.Platform
  resolveMachinePaths?: typeof resolveWindowsMachinePaths
}

export interface TrustedCommandEnvironmentDependencies {
  isTrustedMachinePath?: typeof isTrustedWindowsMachinePath
}

export interface CommandRunnerDependencies {
  platform?: NodeJS.Platform
  spawnProcess?: typeof spawn
  resolveWindowsSystemExecutable?: (fileName: string) => string
}

export class CommandRunnerError extends Error {
  readonly code: CommandErrorCode
  readonly executable: string
  readonly argv: string[]
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly outputBytes: number
  readonly maxOutputBytes: number
  readonly durationMs: number

  constructor(message: string, details: CommandErrorDetails) {
    super(message)
    this.name = 'CommandRunnerError'
    this.code = details.code
    this.executable = details.executable
    this.argv = details.argv
    this.exitCode = details.exitCode
    this.signal = details.signal
    this.stdout = details.stdout
    this.stderr = details.stderr
    this.outputBytes = details.outputBytes
    this.maxOutputBytes = details.maxOutputBytes
    this.durationMs = details.durationMs
  }

  toJSON(): CommandErrorDetails & { message: string; name: string } {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      executable: this.executable,
      argv: [...this.argv],
      exitCode: this.exitCode,
      signal: this.signal,
      stdout: this.stdout,
      stderr: this.stderr,
      outputBytes: this.outputBytes,
      maxOutputBytes: this.maxOutputBytes,
      durationMs: this.durationMs,
    }
  }
}

function normalizedPathKey(value: string): string {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isTrustedWindowsExecutionPath(
  filePath: string,
  machinePaths: WindowsMachinePaths,
): boolean {
  return isTrustedWindowsMachinePath(filePath, machinePaths)
    || isRegisteredTrustedManagedWindowsPath(filePath)
}

/** PATH entries are discovery hints only. The resolved executable is checked
 * again with realpath and ACL validation immediately before spawn. */
function isPotentialWindowsExecutionPath(
  filePath: string,
  machinePaths: WindowsMachinePaths,
): boolean {
  return pathWithinWindowsRoot(filePath, machinePaths.system32)
    || pathWithinWindowsRoot(filePath, machinePaths.programFiles)
    || Boolean(
      machinePaths.programFilesX86
      && pathWithinWindowsRoot(filePath, machinePaths.programFilesX86),
    )
    || isRegisteredTrustedManagedWindowsPath(filePath)
}

/**
 * High-integrity execution fails closed outside known machine-protected roots.
 *
 * The underlying question is platform-specific. On Windows it is "can any principal
 * below Administrator write here?", because the app may hold an elevated token there.
 * macOS has no such boundary — the app never elevates — so it asks instead whether a
 * principal other than root or the invoking user can reach the path; see
 * darwin-path-trust.ts for why that is the faithful analogue rather than a weaker one.
 * Linux keeps the historical constant, which command-runner.test.ts pins.
 */
export function isUserWritablePath(
  filePath: string,
  _env: NodeJS.ProcessEnv = process.env,
  machinePaths?: WindowsMachinePaths,
): boolean {
  // Must precede the guard below. That guard maps a non-absolute path to false, i.e.
  // "trusted", which is a fail-open Windows defuses by checking absoluteness first in
  // isTrustedHighIntegrityExecutable. On darwin a relative path has to answer true.
  if (process.platform === 'darwin') return isDarwinForeignWritablePath(filePath)
  if (process.platform !== 'win32' || !filePath || !path.isAbsolute(filePath)) return false
  try {
    return !isTrustedWindowsExecutionPath(filePath, machinePaths ?? resolveWindowsMachinePaths())
  } catch {
    return true
  }
}

/** Resolves an inbox Windows executable without consulting PATH or COMSPEC. */
export function windowsSystemExecutable(
  fileName: string,
  _env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  machinePaths?: WindowsMachinePaths,
  dependencies: WindowsSystemExecutableDependencies = {},
): string {
  if (platform !== 'win32') return fileName
  if (!fileName || fileName.includes('\0') || path.win32.basename(fileName) !== fileName) {
    throw new Error('Windows 系统可执行文件名无效')
  }
  const resolveMachinePaths = dependencies.resolveMachinePaths ?? resolveWindowsMachinePaths
  const roots = machinePaths ?? (platform === (dependencies.currentPlatform ?? process.platform)
    ? resolveMachinePaths()
    : resolveMachinePaths({ platform }))
  return path.win32.join(roots.system32, fileName)
}

/** Builds a PATH for high-integrity operations without user-controlled entries. */
export function trustedCommandEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  machinePaths?: WindowsMachinePaths,
  platform: NodeJS.Platform = machinePaths ? 'win32' : process.platform,
  dependencies: TrustedCommandEnvironmentDependencies = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  // These variables can inject code, alter package resolution, or replace the
  // interpreter used by a child process. They must never cross the high
  // integrity boundary, even when the caller supplied a custom environment.
  const unsafeKeys = new Set([
    'node_options',
    'node_path',
    'node_extra_ca_certs',
    'openssl_conf',
    'ssl_cert_file',
    'ssl_cert_dir',
    'npm_config_node_options',
    'npm_config_prefix',
    'npm_config_userconfig',
    'npm_config_globalconfig',
    'pythonpath',
    'pythonhome',
    'pythonstartup',
    'pythoninspect',
    'pythonbreakpoint',
    'pythonuserbase',
    'pythonwarnings',
    'psmodulepath',
    'psmoduleanalysiscachepath',
    'psexecutionpolicypreference',
    'perl5lib',
    'perl5opt',
    'perl5db',
    'perllib',
    'rubyopt',
    'rubylib',
    'java_tool_options',
    'jdk_java_options',
    '_java_options',
    'classpath',
    'bash_env',
    'env',
    'zdotdir',
    'fpath',
    'shell',
    // CLI tools may treat these as executable selectors. For example, an
    // elevated OAuth login must not launch a user-supplied BROWSER command.
    'browser',
    'pager',
    'git_pager',
    'editor',
    'visual',
    'manpager',
    'lessopen',
    'lessclose',
    'comspec',
    'systemroot',
    'windir',
    'systemdrive',
    'programfiles',
    'programw6432',
    'programfiles(x86)',
    'programdata',
    'allusersprofile',
    // PowerShell 7 and other .NET children honor these variables before the
    // requested command starts. Inheriting them across an elevation boundary
    // can load an attacker-controlled startup-hook assembly or profiler DLL.
    'dotnet_startup_hooks',
    'dotnet_additional_deps',
    'dotnet_shared_store',
    'ld_preload',
    'ld_library_path',
    // Kept explicit for grep-ability even though the dyld_ prefix below now subsumes
    // them; these two are the ones every macOS injection write-up names.
    'dyld_insert_libraries',
    'dyld_library_path',
    // The field separator reaches any shell a CLI spawns for itself, and CDPATH can
    // redirect a relative chdir into an attacker's tree.
    'ifs',
    'cdpath',
    // Node loads compiled code from this directory at startup.
    'node_compile_cache',
  ])
  const unsafePrefixes = [
    'complus_',
    'corehost_',
    'coreclr_',
    'cor_',
    'dotnet_root',
    'electron_',
    // The two explicit keys above covered DYLD_INSERT_LIBRARIES and
    // DYLD_LIBRARY_PATH; dyld honours roughly ten more, including
    // DYLD_FRAMEWORK_PATH, DYLD_FALLBACK_LIBRARY_PATH, DYLD_VERSIONED_LIBRARY_PATH,
    // DYLD_ROOT_PATH and DYLD_IMAGE_SUFFIX, each able to substitute a library at load.
    'dyld_',
  ]
  const safeGitOverrides = new Map<string, Set<string>>([
    ['git_config_nosystem', new Set(['1'])],
    ['git_config_global', new Set(['NUL', '/dev/null'])],
    ['git_config_count', new Set(['0'])],
    ['git_terminal_prompt', new Set(['0'])],
    ['git_askpass', new Set([''])],
    ['ssh_askpass', new Set([''])],
  ])
  for (const [key, value] of Object.entries(baseEnv)) {
    const normalizedKey = key.toLowerCase()
    const packageManagerOverride = normalizedKey.startsWith('npm_config_')
      || normalizedKey.startsWith('npm_lifecycle_')
      || normalizedKey === 'npm_execpath'
      || normalizedKey === 'npm_node_execpath'
      || normalizedKey === 'npm_command'
    const fixedGitValues = safeGitOverrides.get(normalizedKey)
    const safeGitOverride = typeof value === 'string' && fixedGitValues?.has(value) === true
    const gitOverride = (
      normalizedKey.startsWith('git_')
      || normalizedKey === 'ssh_askpass'
    ) && !safeGitOverride
    const runtimeInjection = unsafePrefixes.some((prefix) => normalizedKey.startsWith(prefix))
    if (
      normalizedKey !== 'path'
      && !unsafeKeys.has(normalizedKey)
      && !runtimeInjection
      && !packageManagerOverride
      && !gitOverride
    ) {
      result[key] = value
    }
  }
  if (platform === 'darwin') {
    // Mirrors the win32 rebuild below: fixed machine directories first, then whatever
    // the caller inherited, with every candidate — machine entries included — put
    // through the same trust predicate and deduplicated first-wins. Handing back the
    // caller's raw PATH, as this used to, made "trusted" a claim the value did not
    // support: any world-writable or foreign-owned entry survived into it.
    const inheritedPath = baseEnv.PATH ?? baseEnv.Path ?? baseEnv.path ?? ''
    let managedBin: string | null = null
    try {
      managedBin = managedNpmBinDirectory(baseEnv, 'darwin')
    } catch {
      // No usable HOME. The fixed system directories below still give a working PATH.
    }
    const machineEntries = [managedBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    const trustedEntries: string[] = []
    const seenEntries = new Set<string>()
    for (const candidate of [...machineEntries, ...inheritedPath.split(path.posix.delimiter)]) {
      const entry = candidate?.trim()
      if (!entry || !path.posix.isAbsolute(entry)) continue
      const key = path.posix.normalize(entry)
      if (seenEntries.has(key)) continue
      seenEntries.add(key)
      if (isDarwinForeignWritablePath(entry)) continue
      trustedEntries.push(entry)
    }
    result.PATH = trustedEntries.join(path.posix.delimiter)
    result.PYTHONNOUSERSITE = '1'
    result.PYTHONSAFEPATH = '1'
    return result
  }
  if (platform !== 'win32') {
    result.PATH = baseEnv.PATH ?? baseEnv.Path ?? baseEnv.path ?? ''
    result.PYTHONNOUSERSITE = '1'
    result.PYTHONSAFEPATH = '1'
    return result
  }
  const roots = machinePaths ?? resolveWindowsMachinePaths()
  const machinePathEntries = [
    roots.system32,
    path.win32.join(roots.system32, 'WindowsPowerShell', 'v1.0'),
    path.win32.join(roots.programFiles, 'PowerShell', '7'),
    path.win32.join(roots.programFiles, 'nodejs'),
    roots.programFilesX86 && path.win32.join(roots.programFilesX86, 'nodejs'),
    path.win32.join(roots.programData, 'XingMangAI', 'Cli', 'npm'),
  ].filter((value): value is string => Boolean(value))
  const existingPath = baseEnv.PATH ?? baseEnv.Path ?? baseEnv.path ?? ''
  const candidates = [...machinePathEntries, ...existingPath.split(path.win32.delimiter)]
  const seen = new Set<string>()
  const entries: string[] = []
  for (const candidate of candidates) {
    const unquoted = candidate.trim().replace(/^"(.*)"$/, '$1')
    if (!unquoted || !isPotentialWindowsExecutionPath(unquoted, roots)) continue
    const key = path.win32.normalize(unquoted).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(unquoted)
  }
  result.PATH = entries.join(path.win32.delimiter)
  const systemModules = path.win32.join(
    roots.system32,
    'WindowsPowerShell',
    'v1.0',
    'Modules',
  )
  const isTrustedMachinePath = dependencies.isTrustedMachinePath ?? isTrustedWindowsMachinePath
  result.PSModulePath = isTrustedMachinePath(systemModules, roots) ? systemModules : ''
  result.SystemRoot = roots.systemRoot
  result.WINDIR = roots.systemRoot
  result.SystemDrive = path.win32.parse(roots.systemRoot).root.replace(/[\\/]$/, '')
  result.ProgramFiles = roots.programFiles
  result.ProgramW6432 = roots.programFiles
  if (roots.programFilesX86) result['ProgramFiles(x86)'] = roots.programFilesX86
  result.ProgramData = roots.programData
  result.PROGRAMDATA = roots.programData
  result.ALLUSERSPROFILE = roots.programData
  result.PYTHONNOUSERSITE = '1'
  result.PYTHONSAFEPATH = '1'
  return result
}

/**
 * Some third-party APIs spawn a verified installer without accepting an `env`
 * option. Replace the process environment only for the synchronous spawn call,
 * then restore it exactly. The child captures its environment during spawn.
 */
export function runWithTrustedWindowsProcessEnvironment(
  operation: () => void,
  targetEnv: NodeJS.ProcessEnv = process.env,
  machinePaths?: WindowsMachinePaths,
): void {
  if (process.platform !== 'win32') {
    operation()
    return
  }
  const original = { ...targetEnv }
  const trusted = trustedCommandEnvironment(targetEnv, machinePaths)
  const replace = (source: NodeJS.ProcessEnv) => {
    for (const key of Object.keys(targetEnv)) delete targetEnv[key]
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) targetEnv[key] = value
    }
  }
  replace(trusted)
  try {
    operation()
  } finally {
    replace(original)
  }
}

function defaultCommandPaths(env: NodeJS.ProcessEnv): string[] {
  return [
    process.platform === 'win32' && (env.ProgramData ?? env.PROGRAMDATA)
      ? managedNpmBinDirectory(env, 'win32')
      : null,
    process.platform === 'win32' && (env.ProgramData ?? env.PROGRAMDATA)
      ? managedNativeProviderRoot('grok', env, 'win32')
      : null,
    env.APPDATA && path.join(env.APPDATA, 'npm'),
    env.NVM_SYMLINK,
    env.FNM_MULTISHELL_PATH,
    env.VOLTA_HOME && path.join(env.VOLTA_HOME, 'bin'),
    env.USERPROFILE && path.join(env.USERPROFILE, '.volta', 'bin'),
    env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'shims'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'nodejs'),
    env.ChocolateyInstall && path.join(env.ChocolateyInstall, 'bin'),
    env.ProgramData && path.join(env.ProgramData, 'chocolatey', 'bin'),
    env.USERPROFILE && path.join(env.USERPROFILE, '.grok', 'bin'),
    env.USERPROFILE && path.join(env.USERPROFILE, '.local', 'bin'),
    env.USERPROFILE && path.join(env.USERPROFILE, '.cargo', 'bin'),
    env.ProgramW6432 && path.join(env.ProgramW6432, 'nodejs'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'nodejs'),
  ].filter((entry): entry is string => Boolean(entry))
}

/** Builds a deterministic PATH without mutating process.env or duplicating entries. */
export function commandEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  additionalPaths: readonly string[] = [],
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.toLowerCase() !== 'path') result[key] = value
  }

  const existingPath = baseEnv.PATH ?? baseEnv.Path ?? baseEnv.path ?? ''
  const candidates = process.platform === 'darwin'
    ? darwinCommandPathCandidates(baseEnv, additionalPaths)
    : [
        ...additionalPaths,
        ...defaultCommandPaths(baseEnv),
        ...existingPath.split(path.delimiter),
      ]
  const seen = new Set<string>()
  const entries: string[] = []
  for (const candidate of candidates) {
    const unquoted = candidate.trim().replace(/^"(.*)"$/, '$1')
    if (!unquoted) continue
    const key = normalizedPathKey(unquoted)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(unquoted)
  }
  result.PATH = entries.join(path.delimiter)
  return result
}

function isAllowedWindowsCmd(filePath: string, managers: readonly WindowsPackageManager[]): boolean {
  if (path.extname(filePath).toLowerCase() !== '.cmd') return true
  const fileName = path.basename(filePath).toLowerCase()
  return managers.some((manager) => fileName === `${manager}.cmd`)
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(filePath)
    if (!stats.isFile()) return false
    if (process.platform !== 'win32') {
      await fs.promises.access(filePath, fs.constants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

/**
 * A trusted command must not resolve through a symlink/junction into a
 * user-writable tree. Checking only the textual path is insufficient on
 * Windows because a machine PATH entry can point at a reparse point.
 */
async function isUserWritableResolvedPath(
  filePath: string,
  env: NodeJS.ProcessEnv,
  machinePaths?: WindowsMachinePaths,
): Promise<boolean> {
  if (isUserWritablePath(filePath, env, machinePaths)) return true
  try {
    const realPath = await fs.promises.realpath(filePath)
    return isUserWritablePath(realPath, env, machinePaths)
  } catch {
    // The regular executable check will report a missing target. Do not turn
    // an unreadable path into an implicit trust decision.
    return true
  }
}

export function isUserWritableResolvedPathSync(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
  machinePaths?: WindowsMachinePaths,
): boolean {
  if (isUserWritablePath(filePath, env, machinePaths)) return true
  try {
    return isUserWritablePath(fs.realpathSync(filePath), env, machinePaths)
  } catch {
    return true
  }
}

/**
 * High-integrity processes may discover user-scoped tools, but must never execute
 * them. This keeps discovery separate from the execution trust gate.
 *
 * The two platforms gate different things. On Windows the tool being user-scoped is
 * itself disqualifying, because execution may cross an elevation boundary. On macOS
 * every managed CLI is user-scoped by construction, so the gate instead rejects tools
 * a third principal could have tampered with. Linux still answers true unconditionally,
 * which is asserted in command-runner.test.ts rather than merely inherited.
 */
export function isTrustedHighIntegrityExecutable(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  machinePaths?: WindowsMachinePaths,
): boolean {
  if (platform === 'darwin') {
    // The darwin predicate resolves the path itself, so routing through
    // isUserWritableResolvedPathSync would only add a redundant second realpath.
    return path.posix.isAbsolute(filePath) && !isDarwinForeignWritablePath(filePath)
  }
  if (platform !== 'win32') return true
  return path.win32.isAbsolute(filePath) && !isUserWritableResolvedPathSync(filePath, env, machinePaths)
}

/** Resolves a command directly from PATH. It never invokes `where`, `which`, or a shell. */
export async function findExecutable(
  command: string,
  options: FindExecutableOptions = {},
): Promise<string | null> {
  if (!command || command.includes('\0')) return null

  const env = options.trustedOnly
    ? trustedCommandEnvironment(options.env, options.machinePaths)
    : commandEnvironment(options.env, options.additionalPaths)
  const managers = options.windowsPackageManagers ?? []
  const hasPathSeparator = command.includes('/') || command.includes('\\')
  const searchDirectories = path.isAbsolute(command) || hasPathSeparator
    ? ['']
    : (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const extension = path.extname(command)
  const extensions = process.platform === 'win32' && !extension
    ? managers.length
      ? ['.exe', '.com', '.cmd']
      : ['.exe', '.com', '']
    : ['']

  for (const directory of searchDirectories) {
    for (const suffix of extensions) {
      const candidate = directory ? path.join(directory, `${command}${suffix}`) : `${command}${suffix}`
      if (process.platform === 'win32') {
        const candidateExtension = path.extname(candidate).toLowerCase()
        if (candidateExtension === '.bat') continue
        if (!isAllowedWindowsCmd(candidate, managers)) continue
      }
      if (await isExecutableFile(candidate)) return path.resolve(candidate)
    }
  }
  return null
}

export function cleanCommandOutput(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(ANSI_PATTERN, '')
    .replace(/\u0000/g, '')
}

export function redactCommandText(value: string, sensitiveValues: readonly string[] = []): string {
  let redacted = cleanCommandOutput(value)
  const explicitValues = [...new Set(sensitiveValues.filter((entry) => entry.length >= 3))]
    .sort((left, right) => right.length - left.length)
  for (const secret of explicitValues) {
    redacted = redacted.split(secret).join('[REDACTED]')
  }

  return redacted
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|token|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|token)=)[^&\s]+/gi, '$1[REDACTED]')
}

function validateSpec(spec: CommandSpec): void {
  if (!spec.executable || spec.executable.includes('\0')) {
    throw new TypeError('executable must be a non-empty path without NUL bytes')
  }
  if (!Array.isArray(spec.argv) || spec.argv.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new TypeError('argv must contain only strings without NUL bytes')
  }
}

function errorMessage(code: CommandErrorCode, executable: string, detail?: number | null): string {
  const command = path.basename(executable) || executable
  switch (code) {
    case 'INVALID_COMMAND': return `Invalid command: ${command}`
    case 'UNSAFE_COMMAND': return `Unsafe command was blocked: ${command}`
    case 'SPAWN_FAILED': return `Failed to start command: ${command}`
    case 'TIMED_OUT': return `Command timed out: ${command}`
    case 'ABORTED': return `Command was cancelled: ${command}`
    case 'OUTPUT_LIMIT': return `Command exceeded its output limit: ${command}`
    case 'EXIT_NON_ZERO': return `Command exited with code ${detail ?? 'unknown'}: ${command}`
  }
}

function immediateError(
  code: CommandErrorCode,
  spec: CommandSpec,
  options: RunCommandOptions,
  message = errorMessage(code, spec.executable),
): CommandRunnerError {
  const sensitiveValues = options.sensitiveValues ?? []
  return new CommandRunnerError(redactCommandText(message, sensitiveValues), {
    code,
    executable: redactCommandText(spec.executable, sensitiveValues),
    argv: spec.argv.map((argument) => redactCommandText(argument, sensitiveValues)),
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    outputBytes: 0,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    durationMs: 0,
  })
}

async function resolveCommandSpec(spec: CommandSpec, env: NodeJS.ProcessEnv): Promise<CommandSpec> {
  if (process.platform !== 'win32') return spec

  const extension = path.extname(spec.executable).toLowerCase()
  if (extension === '.bat') {
    throw new Error('Windows batch files are not supported')
  }
  const manager = spec.windowsPackageManager
  if (!extension && manager && path.basename(spec.executable).toLowerCase() === manager) {
    const cmdShim = `${spec.executable}.cmd`
    if (await isExecutableFile(cmdShim)) {
      return resolveCommandSpec({ ...spec, executable: cmdShim }, env)
    }
  }
  if (extension !== '.cmd') return spec

  if (!manager || path.basename(spec.executable).toLowerCase() !== `${manager}.cmd`) {
    throw new Error('Windows .cmd files require an explicit package-manager policy')
  }

  const shimDirectory = path.dirname(path.resolve(spec.executable))
  const cliName = manager === 'npm' ? 'npm-cli.js' : 'npx-cli.js'
  const cliPath = path.join(shimDirectory, 'node_modules', 'npm', 'bin', cliName)
  if (!await isExecutableFile(cliPath)) {
    throw new Error('The package-manager shim does not have a trusted CLI target')
  }

  const siblingNode = path.join(shimDirectory, 'node.exe')
  const nodeExecutable = await isExecutableFile(siblingNode)
    ? siblingNode
    : await findExecutable('node', { env })
  if (!nodeExecutable || path.extname(nodeExecutable).toLowerCase() === '.cmd') {
    throw new Error('The package-manager shim does not have a trusted Node.js runtime')
  }

  return {
    executable: nodeExecutable,
    argv: [cliPath, ...spec.argv],
  }
}

async function resolveTrustedExecutable(
  executable: string,
  env: NodeJS.ProcessEnv,
  windowsPackageManagers: readonly WindowsPackageManager[] = [],
  machinePaths?: WindowsMachinePaths,
): Promise<string | null> {
  if (path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
    return executable
  }
  return findExecutable(executable, {
    env,
    trustedOnly: true,
    windowsPackageManagers,
    machinePaths,
  })
}

async function trustedRealPath(
  candidate: string,
  env: NodeJS.ProcessEnv,
  machinePaths?: WindowsMachinePaths,
): Promise<string | null> {
  if (!path.isAbsolute(candidate)) return null
  try {
    const realPath = await fs.promises.realpath(candidate)
    return await isUserWritableResolvedPath(realPath, env, machinePaths) ? null : realPath
  } catch {
    return null
  }
}

interface CommandArgumentPathReference {
  value: string
  start: number
  end: number
}

/**
 * High-integrity tools commonly accept paths as `--option=C:\...`,
 * `/option:C:\...`, or `@C:\response.rsp`. Treat those exactly like a
 * standalone absolute-path argument so a trusted runtime cannot be used to
 * load a user-writable script, config, plugin, or response file.
 */
function windowsCommandArgumentPath(argument: string): CommandArgumentPathReference | null {
  if (path.win32.isAbsolute(argument)) {
    return { value: argument, start: 0, end: argument.length }
  }

  let start = -1
  if (argument.startsWith('@')) {
    start = 1
  } else {
    const equals = argument.indexOf('=')
    if (equals > 0) {
      start = equals + 1
    } else if (/^[-/][^:\0]{1,128}:/.test(argument)) {
      start = argument.indexOf(':') + 1
    }
  }
  if (start < 0 || start >= argument.length) return null

  let end = argument.length
  const quote = argument[start]
  if ((quote === '"' || quote === "'") && argument.at(-1) === quote) {
    start += 1
    end -= 1
  }
  const value = argument.slice(start, end)
  return path.win32.isAbsolute(value) ? { value, start, end } : null
}

function replaceCanonicalTrustedPath(
  argument: string,
  replacements: ReadonlyMap<string, string>,
): string {
  const reference = windowsCommandArgumentPath(argument)
  if (!reference) return argument
  const replacement = replacements.get(normalizedPathKey(reference.value))
  return replacement
    ? `${argument.slice(0, reference.start)}${replacement}${argument.slice(reference.end)}`
    : argument
}

function positiveInteger(value: number, name: string, allowZero = false): number {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
  }
  return value
}

/** Runs a process with shell:false and a bounded, cancellable lifecycle. */
export async function runCommand(
  spec: CommandSpec,
  options: RunCommandOptions = {},
  dependencies: CommandRunnerDependencies = {},
): Promise<CommandResult> {
  validateSpec(spec)
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs', true)
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes')
  const killGraceMs = positiveInteger(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, 'killGraceMs', true)
  if (options.signal?.aborted) throw immediateError('ABORTED', spec, options)

  const machinePaths = options.trustedOnly && process.platform === 'win32'
    ? options.machinePaths ?? resolveWindowsMachinePaths()
    : undefined
  const env = options.trustedOnly
    ? trustedCommandEnvironment(options.env, machinePaths)
    : options.env ?? commandEnvironment()
  let resolvedSpec: CommandSpec
  try {
    resolvedSpec = await resolveCommandSpec(spec, env)
  } catch {
    throw immediateError('UNSAFE_COMMAND', spec, options)
  }

  if (options.trustedOnly && process.platform === 'win32') {
    const trustedExecutable = await resolveTrustedExecutable(
      resolvedSpec.executable,
      env,
      spec.windowsPackageManager ? [spec.windowsPackageManager] : [],
      machinePaths,
    )
    if (!trustedExecutable) {
      throw immediateError(
        'UNSAFE_COMMAND',
        resolvedSpec,
        options,
        '未能从受信任的系统目录解析高权限命令',
      )
    }
    const realExecutable = await trustedRealPath(trustedExecutable, env, machinePaths)
    const canonicalTrustedPaths = new Map<string, string>()
    const realArguments: string[] = []
    // 记录第一个被拒的路径。缺了它，这条错误无法区分「目标可被普通用户改写」
    // 和「路径压根不存在」（realpath 失败同样返回 null），排查时只能靠猜。
    let rejectedPath: string | null = realExecutable ? null : trustedExecutable
    for (const argument of resolvedSpec.argv) {
      const reference = windowsCommandArgumentPath(argument)
      if (!reference) {
        realArguments.push(argument)
        continue
      }
      const realArgument = await trustedRealPath(reference.value, env, machinePaths)
      if (!realArgument) {
        rejectedPath ??= reference.value
        break
      }
      canonicalTrustedPaths.set(normalizedPathKey(reference.value), realArgument)
      realArguments.push(argument)
    }
    for (const trustedPath of options.trustedPaths ?? []) {
      const realPath = await trustedRealPath(trustedPath, env, machinePaths)
      if (!realPath) {
        rejectedPath ??= trustedPath
        continue
      }
      canonicalTrustedPaths.set(normalizedPathKey(trustedPath), realPath)
    }
    if (rejectedPath || !realExecutable) {
      throw immediateError(
        'UNSAFE_COMMAND',
        resolvedSpec,
        options,
        `高权限命令目标或输入文件位于用户可写目录或不存在，已阻止执行：${rejectedPath ?? trustedExecutable}`,
      )
    }
    // Launch exactly the canonical targets that passed the trust check. This
    // avoids validating a junction path and then spawning through that path.
    resolvedSpec = {
      ...resolvedSpec,
      executable: realExecutable,
      argv: realArguments.map((argument) => replaceCanonicalTrustedPath(argument, canonicalTrustedPaths)),
    }
  }

  const acceptedExitCodes = new Set(options.acceptedExitCodes ?? [0])
  const sensitiveValues = options.sensitiveValues ?? []
  const startedAt = Date.now()
  const processPlatform = dependencies.platform ?? process.platform
  const spawnProcess = dependencies.spawnProcess ?? spawn

  return await new Promise<CommandResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawnProcess(resolvedSpec.executable, [...resolvedSpec.argv], {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: options.windowsHide ?? true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      reject(immediateError('SPAWN_FAILED', spec, options))
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let capturedBytes = 0
    let outputBytes = 0
    let forcedCode: CommandErrorCode | null = null
    let timeout: NodeJS.Timeout | undefined
    let hardKill: NodeJS.Timeout | undefined
    let exitSettleTimer: NodeJS.Timeout | undefined
    let settled = false

    const safeSpec = {
      executable: redactCommandText(resolvedSpec.executable, sensitiveValues),
      argv: resolvedSpec.argv.map((argument) => redactCommandText(argument, sensitiveValues)),
    }

    const outputs = () => ({
      stdout: redactCommandText(Buffer.concat(stdoutChunks).toString('utf8'), sensitiveValues),
      stderr: redactCommandText(Buffer.concat(stderrChunks).toString('utf8'), sensitiveValues),
    })

    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      if (hardKill) clearTimeout(hardKill)
      if (exitSettleTimer) clearTimeout(exitSettleTimer)
      stdoutDecoder.end()
      stderrDecoder.end()
      options.signal?.removeEventListener('abort', abort)
    }

    const commandError = (
      code: CommandErrorCode,
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): CommandRunnerError => {
      const output = outputs()
      return new CommandRunnerError(errorMessage(code, safeSpec.executable, exitCode), {
        code,
        executable: safeSpec.executable,
        argv: safeSpec.argv,
        exitCode,
        signal,
        stdout: output.stdout,
        stderr: output.stderr,
        outputBytes,
        maxOutputBytes,
        durationMs: Date.now() - startedAt,
      })
    }

    const stop = (code: CommandErrorCode) => {
      if (forcedCode || settled) return
      forcedCode = code
      const fallbackKill = () => child.kill(options.killSignal ?? 'SIGTERM')
      if (processPlatform === 'win32' && child.pid) {
        // child.kill() only reaches the direct child on Windows; a grandchild
        // holding the inherited stdio pipe handles would keep 'close' from
        // ever firing, so the whole tree must go down together.
        try {
          const taskkill = dependencies.resolveWindowsSystemExecutable ?? windowsSystemExecutable
          const killer = spawnProcess(taskkill('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          })
          killer.once('error', fallbackKill)
          killer.once('exit', (exitCode) => {
            if (exitCode !== 0) fallbackKill()
          })
          killer.unref()
        } catch {
          fallbackKill()
        }
      } else {
        fallbackKill()
      }
      if (killGraceMs > 0) {
        hardKill = setTimeout(() => {
          if (!settled) child.kill('SIGKILL')
        }, killGraceMs)
        hardKill.unref()
      }
    }

    const abort = () => stop('ABORTED')

    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += buffer.length
      const remaining = Math.max(0, maxOutputBytes - capturedBytes)
      const accepted = buffer.subarray(0, remaining)
      if (accepted.length) {
        ;(stream === 'stdout' ? stdoutChunks : stderrChunks).push(accepted)
        capturedBytes += accepted.length
        if (options.onOutput) {
          // Per-stream decoders keep multi-byte characters split across chunk
          // boundaries from surfacing as garbage in streamed progress output.
          const text = (stream === 'stdout' ? stdoutDecoder : stderrDecoder).write(accepted)
          if (text) {
            try {
              options.onOutput({
                stream,
                text: redactCommandText(text, sensitiveValues),
              })
            } catch {
              // Progress observers cannot change the child-process lifecycle.
            }
          }
        }
      }
      if (buffer.length > remaining) stop('OUTPUT_LIMIT')
    }

    child.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk))

    child.once('error', () => {
      if (settled) return
      settled = true
      cleanup()
      reject(commandError(forcedCode ?? 'SPAWN_FAILED', null, null))
    })

    const settleFromChild = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      cleanup()
      if (forcedCode) {
        reject(commandError(forcedCode, exitCode, signal))
        return
      }
      if (exitCode === null || !acceptedExitCodes.has(exitCode)) {
        reject(commandError('EXIT_NON_ZERO', exitCode, signal))
        return
      }
      const output = outputs()
      resolve({
        executable: safeSpec.executable,
        argv: safeSpec.argv,
        exitCode,
        signal,
        stdout: output.stdout,
        stderr: output.stderr,
        outputBytes,
        durationMs: Date.now() - startedAt,
      })
    }

    child.once('exit', (exitCode, signal) => {
      // A process that inherited the stdio pipe write handles can outlive the
      // child and keep 'close' from firing, which would strand every
      // settlement path. Once exit proves the child is dead, force the streams
      // shut and settle directly if close still has not arrived.
      exitSettleTimer = setTimeout(() => {
        if (!settled) {
          child.stdout?.destroy()
          child.stderr?.destroy()
          settleFromChild(exitCode, signal)
        }
      }, killGraceMs > 0 ? killGraceMs : 1000)
      exitSettleTimer.unref()
    })

    child.once('close', settleFromChild)

    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    if (timeoutMs > 0) {
      timeout = setTimeout(() => stop('TIMED_OUT'), timeoutMs)
      timeout.unref()
    }
  })
}
