import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cliCatalog, type ProviderId } from './catalog'
import { readBoundedUtf8FileSync } from './bounded-file'
import { releaseStagedDarwinCli } from './darwin-cli-staging'
import {
  commandEnvironment,
  findExecutable,
  isUserWritablePath,
  runCommand,
  type CommandSpec,
} from './command-runner'
import {
  resolveDarwinCodexStandaloneSelection,
  stageDarwinCodexStandaloneSelection,
  type DarwinCodexCommandResult,
  type DarwinCodexStandaloneSelection,
} from './macos-codex'
import {
  resolveDarwinGrokCanonicalSelection,
  stageDarwinGrokCanonicalSelection,
} from './macos-grok'
import { sameLocalPathIdentity } from './path-identity'
import { stageVerifiedNativeCli } from './trusted-native-cli'
import type { WindowsCliExecutionMode } from './windows-elevation'

export type CliInstallSource = 'npm' | 'native'

export interface CliUninstallCapability {
  available: boolean
  reason: string | null
  manualCommand: string | null
  /** 卸载需要交给以登录用户身份运行的命令窗口，不能在提权主进程里直接执行。 */
  delegated?: boolean
}

export interface CliInstallation {
  commandPath: string
  installDirectory: string
  packageRoot: string | null
  npmPrefix: string | null
  packageVersion?: string | null
  source: CliInstallSource
}

export interface ResolveCliInstallationOptions {
  env?: NodeJS.ProcessEnv
  executablePath?: string | null
  npmExecutable?: string | null
  npmGlobalRoot?: string | null
  platform?: NodeJS.Platform
  queryNpmRoot?: (npmExecutable: string, env: NodeJS.ProcessEnv) => Promise<string | null>
}

export interface ResolveCliCommandOptions {
  arch?: NodeJS.Architecture
  platform?: NodeJS.Platform
  runCommand?: (
    spec: { executable: string; argv: readonly string[] },
  ) => Promise<DarwinCodexCommandResult>
  darwinStagingRetention?: 'ephemeral' | 'retained'
}

export interface ResolvedCliCommand extends CommandSpec {
  verifiedDarwinStandalone?: DarwinCodexStandaloneSelection
  release?: () => Promise<void>
}

export interface CliUninstallCapabilityOptions {
  managedNpmPrefix?: string | null
  managedNativeDirectory?: string | null
  homeDirectory?: string
  platform?: NodeJS.Platform
  verifiedDarwinStandalone?: DarwinCodexStandaloneSelection | null
  windowsExecutionMode?: WindowsCliExecutionMode
}

interface PackageManifest {
  name?: unknown
  bin?: unknown
  version?: unknown
}

const MAX_PACKAGE_MANIFEST_BYTES = 256 * 1024
const CODEX_STANDALONE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-(?:alpha|beta)(?:\.\d+){0,2})?$/

function normalizedPathKey(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

function equivalentPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const normalize = (value: string) => {
    const normalized = pathApi.resolve(value).replace(/[\\/]+$/, '')
    return platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

function shellSingleQuote(value: string): string {
  if (value.includes('\0')) throw new Error('卸载路径包含无效字符')
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function codexStandaloneManualUninstallCommand(
  installation: CliInstallation,
  selection: DarwinCodexStandaloneSelection | null | undefined,
  homeDirectory: string,
  platform: NodeJS.Platform,
): string | null {
  if (platform !== 'darwin' || !selection) return null
  const expectedCommand = path.posix.join(homeDirectory, '.local', 'bin', 'codex')
  if (
    installation.source !== 'native'
    || !equivalentPath(installation.commandPath, expectedCommand, platform)
    || !equivalentPath(selection.requestedExecutablePath, expectedCommand, platform)
  ) return null
  const standaloneRoot = path.posix.join(selection.codexHome, 'packages', 'standalone')
  const releasesRoot = path.posix.join(standaloneRoot, 'releases')
  if (
    !path.posix.isAbsolute(selection.codexHome)
    || selection.codexHome.includes('\0')
    || !CODEX_STANDALONE_VERSION_PATTERN.test(selection.version)
    || !/^(?:aarch64|x86_64)-apple-darwin$/.test(selection.target)
  ) return null
  const expectedReleaseRoot = path.posix.join(
    releasesRoot,
    `${selection.version}-${selection.target}`,
  )
  if (
    !equivalentPath(selection.releaseRoot, expectedReleaseRoot, platform)
    || !equivalentPath(
      selection.executablePath,
      path.posix.join(expectedReleaseRoot, 'bin', 'codex'),
      platform,
    )
  ) return null
  const trashRoot = path.posix.join(homeDirectory, '.Trash')

  return [
    `trash_root=${shellSingleQuote(trashRoot)} &&`,
    '/bin/mkdir -p "$trash_root" &&',
    'trash_dir=$(/usr/bin/mktemp -d "$trash_root/Codex-CLI.XXXXXXXX") &&',
    `/bin/mv ${shellSingleQuote(selection.requestedExecutablePath)} "$trash_dir/codex" &&`,
    `/bin/mv ${shellSingleQuote(standaloneRoot)} "$trash_dir/standalone"`,
  ].join('\n')
}

export function cliUninstallCapability(
  provider: ProviderId,
  installation: CliInstallation,
  options: CliUninstallCapabilityOptions = {},
): CliUninstallCapability {
  const platform = options.platform ?? process.platform
  if (installation.source === 'npm') {
    const managedPrefix = options.managedNpmPrefix
    if (
      managedPrefix
      && installation.npmPrefix
      && equivalentPath(managedPrefix, installation.npmPrefix, platform)
    ) {
      return { available: true, reason: null, manualCommand: null }
    }
    // The hazard is running a user-writable uninstall script with an elevated
    // token. Without elevation this is exactly what the user would run in their
    // own shell, so the restriction only belongs to the trusted-only mode.
    if ((options.windowsExecutionMode ?? 'trusted-only') === 'same-user') {
      return { available: true, reason: null, manualCommand: null, delegated: false }
    }
    // Elevated: still offered, but handed to a command window running under the
    // logged-on user so the package's own scripts never see an admin token.
    return {
      available: true,
      delegated: true,
      reason: '当前为用户级或非托管 npm 安装，将以普通用户权限打开窗口执行卸载',
      manualCommand: `npm uninstall -g ${cliCatalog[provider].packageName}`,
    }
  }

  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const homeDirectory = options.homeDirectory ?? os.homedir()
  const expectedDirectory = provider === 'grok'
    ? pathApi.join(homeDirectory, '.grok', 'bin')
    : provider === 'claude'
      ? pathApi.join(homeDirectory, '.local', 'bin')
      : null
  const managedNativeDirectory = options.managedNativeDirectory
  if (
    (expectedDirectory && equivalentPath(expectedDirectory, installation.installDirectory, platform))
    || (managedNativeDirectory && equivalentPath(
      managedNativeDirectory,
      installation.installDirectory,
      platform,
    ))
  ) {
    return { available: true, reason: null, manualCommand: null }
  }
  if (provider === 'codex') {
    const manualCommand = codexStandaloneManualUninstallCommand(
      installation,
      options.verifiedDarwinStandalone,
      homeDirectory,
      platform,
    )
    if (manualCommand) {
      return {
        available: false,
        reason: '已识别 OpenAI 官方 standalone 安装；为保留配置和会话，请按教程将 CLI 程序移动到废纸篓',
        manualCommand,
      }
    }
  }
  return {
    available: false,
    reason: '当前安装来源或目录不支持安全自动卸载，请使用该发行版自带的卸载方式',
    manualCommand: null,
  }
}

function uniquePaths(values: Array<string | null | undefined>, platform: NodeJS.Platform): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!value || value.includes('\0')) continue
    const resolved = path.resolve(value)
    const key = normalizedPathKey(resolved, platform)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(resolved)
  }
  return result
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function commandCandidates(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  explicitPath?: string | null,
): string[] {
  const extensions = platform === 'win32'
    ? ['.cmd', '.exe', '.com', '']
    : ['']
  const candidates = [explicitPath]
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`)
      if (isFile(candidate)) candidates.push(candidate)
    }
  }
  return uniquePaths(candidates, platform)
}

function readManifest(packageRoot: string): PackageManifest | null {
  try {
    const source = readBoundedUtf8FileSync(
      path.join(packageRoot, 'package.json'),
      MAX_PACKAGE_MANIFEST_BYTES,
      'CLI package.json',
    )
    if (!source) return null
    return JSON.parse(source) as PackageManifest
  } catch {
    return null
  }
}

export function verifiedPackageRoot(packageRoot: string, packageName: string): string | null {
  const manifest = readManifest(packageRoot)
  if (manifest?.name !== packageName) return null
  try {
    const realRoot = fs.realpathSync(packageRoot)
    return fs.statSync(realRoot).isDirectory() ? realRoot : null
  } catch {
    return null
  }
}

function packagePath(root: string, packageName: string): string {
  return path.join(root, ...packageName.split('/'))
}

function globalRootFromPackageRoot(packageRoot: string, packageName: string): string {
  return packageName.split('/').reduce((current) => path.dirname(current), packageRoot)
}

function packageRootCandidates(
  provider: ProviderId,
  commandPaths: readonly string[],
  env: NodeJS.ProcessEnv,
  npmGlobalRoot: string | null,
  platform: NodeJS.Platform,
): string[] {
  const packageName = cliCatalog[provider].packageName
  const roots: Array<string | null | undefined> = []
  for (const commandPath of commandPaths) {
    const commandDirectory = path.dirname(commandPath)
    roots.push(
      packagePath(path.join(commandDirectory, 'node_modules'), packageName),
      packagePath(path.join(commandDirectory, '..', 'node_modules'), packageName),
      packagePath(path.join(commandDirectory, '..', 'lib', 'node_modules'), packageName),
    )
  }
  if (npmGlobalRoot) roots.push(packagePath(npmGlobalRoot, packageName))
  if (env.APPDATA) roots.push(packagePath(path.join(env.APPDATA, 'npm', 'node_modules'), packageName))
  if (env.npm_config_prefix) {
    roots.push(
      packagePath(path.join(env.npm_config_prefix, 'node_modules'), packageName),
      packagePath(path.join(env.npm_config_prefix, 'lib', 'node_modules'), packageName),
    )
  }
  return uniquePaths(roots, platform)
}

export function npmPrefixFromGlobalRoot(globalRoot: string | null): string | null {
  if (!globalRoot) return null
  const resolved = path.resolve(globalRoot)
  if (path.basename(resolved).toLowerCase() !== 'node_modules') return null
  const parent = path.dirname(resolved)
  return path.basename(parent).toLowerCase() === 'lib' ? path.dirname(parent) : parent
}

async function defaultQueryNpmRoot(
  npmExecutable: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const result = await runCommand({
      executable: npmExecutable,
      argv: ['root', '--global'],
      windowsPackageManager: 'npm',
    }, {
      env,
      timeoutMs: 8_000,
      maxOutputBytes: 256 * 1024,
    })
    const root = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    return root && path.isAbsolute(root) ? path.resolve(root) : null
  } catch {
    return null
  }
}

export async function findNpmExecutable(
  envInput: NodeJS.ProcessEnv = process.env,
  commandPaths: readonly string[] = [],
): Promise<string | null> {
  const env = commandEnvironment(envInput)
  const platform = process.platform
  const siblingCandidates = commandPaths.flatMap((commandPath) => {
    const directory = path.dirname(commandPath)
    return platform === 'win32'
      ? [path.join(directory, 'npm.cmd'), path.join(directory, 'npm.exe')]
      : [path.join(directory, 'npm')]
  })
  const sibling = uniquePaths(siblingCandidates, platform).find(isFile)
  return sibling ?? findExecutable('npm', { env, windowsPackageManagers: ['npm'] })
}

export async function resolveNpmGlobalRoot(
  npmExecutable: string | null,
  envInput: NodeJS.ProcessEnv = process.env,
  queryNpmRoot = defaultQueryNpmRoot,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (!npmExecutable) return null
  const env = commandEnvironment(envInput)
  if (platform === 'win32') {
    // Running `npm root --global` from an elevated Electron process executes
    // npm-cli.js with administrator rights. The Windows global root is beside
    // the npm shim; package discovery also checks APPDATA and explicit prefixes.
    return path.win32.join(path.win32.dirname(npmExecutable), 'node_modules')
  }
  return queryNpmRoot(npmExecutable, env)
}

function closestCommandToPackage(
  commandPaths: readonly string[],
  packageRoot: string,
  platform: NodeJS.Platform,
): string {
  const rootKey = normalizedPathKey(packageRoot, platform)
  return commandPaths.find((commandPath) => {
    const directoryKey = normalizedPathKey(path.dirname(commandPath), platform)
    return rootKey.startsWith(`${directoryKey}${path.sep}`)
  }) ?? commandPaths[0]
}

export async function resolveCliInstallation(
  provider: ProviderId,
  options: ResolveCliInstallationOptions = {},
): Promise<CliInstallation | null> {
  const platform = options.platform ?? process.platform
  const env = commandEnvironment(options.env ?? process.env)
  const commands = commandCandidates(
    cliCatalog[provider].command,
    env,
    platform,
    options.executablePath,
  )
  if (!commands.length) return null

  const npmExecutable = options.npmExecutable
    ?? await findNpmExecutable(env, commands)
  const npmGlobalRoot = options.npmGlobalRoot
    ?? await resolveNpmGlobalRoot(npmExecutable, env, options.queryNpmRoot)
  for (const candidate of packageRootCandidates(provider, commands, env, npmGlobalRoot, platform)) {
    const packageRoot = verifiedPackageRoot(candidate, cliCatalog[provider].packageName)
    if (!packageRoot) continue
    const commandPath = closestCommandToPackage(commands, packageRoot, platform)
    const manifest = readManifest(packageRoot)
    const canonicalGlobalRoot = globalRootFromPackageRoot(packageRoot, cliCatalog[provider].packageName)
    const reportedGlobalRoot = npmGlobalRoot && sameLocalPathIdentity(npmGlobalRoot, canonicalGlobalRoot)
      ? npmGlobalRoot
      : canonicalGlobalRoot
    return {
      commandPath,
      installDirectory: packageRoot,
      packageRoot,
      npmPrefix: npmPrefixFromGlobalRoot(reportedGlobalRoot),
      packageVersion: typeof manifest?.version === 'string' && manifest.version.trim().length <= 128
        ? manifest.version.trim() || null
        : null,
      source: 'npm',
    }
  }

  const commandPath = commands[0]
  let installDirectory: string
  try {
    installDirectory = fs.realpathSync.native?.(path.dirname(commandPath))
      ?? fs.realpathSync(path.dirname(commandPath))
  } catch {
    // realpath 失败（如目录刚被移除）不应让整个环境扫描失败
    installDirectory = path.dirname(commandPath)
  }
  return {
    commandPath,
    installDirectory,
    packageRoot: null,
    npmPrefix: null,
    packageVersion: null,
    source: 'native',
  }
}

function packageBinPath(packageRoot: string, provider: ProviderId): string | null {
  const manifest = readManifest(packageRoot)
  const bin = typeof manifest?.bin === 'string'
    ? manifest.bin
    : manifest?.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)
      ? (manifest.bin as Record<string, unknown>)[cliCatalog[provider].command]
        ?? Object.values(manifest.bin as Record<string, unknown>).find((value) => typeof value === 'string')
      : null
  if (typeof bin !== 'string' || !bin || bin.includes('\0')) return null
  try {
    const realRoot = fs.realpathSync(packageRoot)
    const realBin = fs.realpathSync(path.resolve(realRoot, bin))
    const relative = path.relative(realRoot, realBin)
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(realBin).isFile()) return null
    return realBin
  } catch {
    return null
  }
}

function codexNativePackageBinPath(packageRoot: string): string | null {
  if (process.platform !== 'win32' || (process.arch !== 'x64' && process.arch !== 'arm64')) return null
  const packageName = `@openai/codex-win32-${process.arch}`
  const triple = process.arch === 'x64'
    ? 'x86_64-pc-windows-msvc'
    : 'aarch64-pc-windows-msvc'
  const lexicalPlatformRoot = path.join(packageRoot, 'node_modules', ...packageName.split('/'))
  const platformRoot = verifiedPackageRoot(lexicalPlatformRoot, packageName)
    ?? verifiedPackageRoot(lexicalPlatformRoot, '@openai/codex')
  if (!platformRoot) return null
  const candidate = path.join(platformRoot, 'vendor', triple, 'bin', 'codex.exe')
  try {
    const realCandidate = fs.realpathSync(candidate)
    const relative = path.relative(platformRoot, realCandidate)
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(realCandidate).isFile()) {
      return null
    }
    return realCandidate
  } catch {
    return null
  }
}

export async function resolveCliCommand(
  provider: ProviderId,
  envInput: NodeJS.ProcessEnv = process.env,
  windowsExecutionMode: WindowsCliExecutionMode = 'trusted-only',
  options: ResolveCliCommandOptions = {},
): Promise<ResolvedCliCommand> {
  const env = commandEnvironment(envInput)
  const platform = options.platform ?? process.platform
  const installation = await resolveCliInstallation(provider, { env, platform })
  if (!installation) throw new Error(`未检测到 ${cliCatalog[provider].name}`)
  const runDarwinVerificationCommand = options.runCommand ?? (async (spec) => {
    const result = await runCommand(spec, {
      env,
      timeoutMs: 8_000,
      maxOutputBytes: 1024 * 1024,
    })
    return { stdout: result.stdout, stderr: result.stderr }
  })
  if (platform === 'darwin' && provider === 'codex' && installation.source === 'native') {
    const selectionOptions = {
      executablePath: installation.commandPath,
      env,
      platform,
      arch: options.arch,
    }
    const selection = resolveDarwinCodexStandaloneSelection(selectionOptions)
    const executable = await stageDarwinCodexStandaloneSelection({
      ...selectionOptions,
      selection,
      runCommand: runDarwinVerificationCommand,
      retention: options.darwinStagingRetention,
    })
    return {
      executable,
      argv: [],
      verifiedDarwinStandalone: selection,
      release: options.darwinStagingRetention === 'ephemeral'
        ? () => releaseStagedDarwinCli(executable)
        : undefined,
    }
  }
  if (platform === 'darwin' && provider === 'grok' && installation.source === 'native') {
    const homeDirectory = env.HOME || os.homedir()
    const selected = resolveDarwinGrokCanonicalSelection(
      homeDirectory,
      installation.commandPath,
    )
    const executable = await stageDarwinGrokCanonicalSelection({
      homeDirectory,
      selection: selected,
      expectedVersion: selected.version,
      runCommand: runDarwinVerificationCommand,
      retention: options.darwinStagingRetention,
    })
    return {
      executable,
      argv: [],
      release: options.darwinStagingRetention === 'ephemeral'
        ? () => releaseStagedDarwinCli(executable)
        : undefined,
    }
  }
  if (installation.packageRoot) {
    if (provider === 'codex') {
      const native = codexNativePackageBinPath(installation.packageRoot)
      if (native) {
        const executable = windowsExecutionMode === 'trusted-only' && isUserWritablePath(native, env)
          ? await stageVerifiedNativeCli(provider, native, env)
          : native
        return { executable, argv: [] }
      }
    }
    const bin = packageBinPath(installation.packageRoot, provider)
    if (bin) {
      if (platform === 'win32' && path.extname(bin).toLowerCase() === '.exe') {
        const executable = windowsExecutionMode === 'trusted-only' && isUserWritablePath(bin, env)
          ? await stageVerifiedNativeCli(provider, bin, env)
          : bin
        return { executable, argv: [] }
      }
      const node = await findExecutable('node', {
        env,
        additionalPaths: [path.dirname(installation.commandPath)],
        trustedOnly: platform === 'win32'
          && windowsExecutionMode === 'trusted-only'
          && !isUserWritablePath(installation.packageRoot, env),
      })
      if (node) return { executable: node, argv: [bin] }
    }
  }
  const extension = path.extname(installation.commandPath).toLowerCase()
  if (platform === 'win32' && ['.cmd', '.bat', '.ps1'].includes(extension)) {
    throw new Error(`${cliCatalog[provider].name} 的命令入口无法安全执行，请重新安装该 CLI`)
  }
  const executable = platform === 'win32'
    && windowsExecutionMode === 'trusted-only'
    && isUserWritablePath(installation.commandPath, env)
    ? await stageVerifiedNativeCli(provider, installation.commandPath, env)
    : installation.commandPath
  return { executable, argv: [] }
}
