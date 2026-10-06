import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { readBoundedUtf8File } from './bounded-file'
import { cliCatalog, type ProviderId } from './catalog'
import { trustedCommandEnvironment } from './command-runner'
import { assertNoReparseComponents } from './safe-local-data'
import type { CliInstallation, CliInstallSource } from './tool-installation'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

const execFileAsync = promisify(execFile)

// npm's cmd-shim writes a few hundred bytes; anything far larger is not one.
const maximumPowerShellShimBytes = 64 * 1024

// Windows PowerShell starts cold in well over ten seconds on a slow disk with
// Defender scanning; both PATH steps run after the install or uninstall already
// reported its result, so a generous budget costs the user nothing.
const userPathTimeoutMs = 60_000

export type PowerShellShimRemoval = 'removed' | 'absent' | 'kept'
export type UserPathOutcome = 'added' | 'present'
export type UserPathRemoval = 'removed' | 'absent'

export interface RemoveNpmPowerShellShimOptions {
  /** npm's global bin directory; on Windows that is the prefix itself. */
  binDirectory: string
  /** The command users type, e.g. `claude`. */
  command: string
  /** The package the shim must point into; any other `.ps1` is left alone. */
  packageName: string
}

/**
 * Recognises the `.ps1` launcher npm's cmd-shim writes for a global package.
 * The first two lines are fixed by cmd-shim, and every target it writes is
 * `$basedir/node_modules/<package>/...`, so a script someone wrote by hand, or a
 * shim for another package that happens to share the command name, never
 * matches.
 */
export function isNpmPowerShellShim(content: string, packageName: string): boolean {
  const normalized = content.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n')) {
    return false
  }
  return normalized.includes(`$basedir/node_modules/${packageName}/`)
}

/**
 * npm writes `claude.cmd` and `claude.ps1` side by side, and PowerShell prefers
 * the `.ps1`. Client Windows ships with the Restricted execution policy, so a
 * user who types `claude` in PowerShell gets "running scripts is disabled"
 * although the very same command works in cmd. Removing only the `.ps1` makes
 * PowerShell fall through to the `.cmd`, which the policy does not govern, so
 * nobody has to loosen their execution policy. The app itself never launches
 * through either shim (tool-installation.ts refuses `.cmd`/`.ps1`).
 */
export async function removeNpmPowerShellShim(
  options: RemoveNpmPowerShellShimOptions,
): Promise<PowerShellShimRemoval> {
  const label = '命令行启动文件'
  const binDirectory = path.resolve(options.binDirectory)
  // The bin directory is normally user-writable; a junction on the way would
  // turn this unlink into a deletion somewhere else (I8).
  assertNoReparseComponents(binDirectory, label)
  const scriptPath = path.join(binDirectory, `${options.command}.ps1`)
  const batchPath = path.join(binDirectory, `${options.command}.cmd`)
  let scriptStats: fs.Stats
  try {
    scriptStats = await fs.promises.lstat(scriptPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }
  // Without the `.cmd` next to it, deleting the `.ps1` would leave PowerShell
  // with nothing to run instead of something it refuses to run.
  const batchStats = await fs.promises.lstat(batchPath).catch(() => null)
  if (!batchStats?.isFile()) return 'kept'
  if (!scriptStats.isFile() || scriptStats.nlink !== 1) return 'kept'
  const content = await readBoundedUtf8File(scriptPath, maximumPowerShellShimBytes, label)
  if (!isNpmPowerShellShim(content, options.packageName)) return 'kept'
  const current = await fs.promises.lstat(scriptPath)
  if (current.ino !== scriptStats.ino || current.dev !== scriptStats.dev || !current.isFile()) {
    return 'kept'
  }
  // force: the startup sweep and an install finishing at the same moment may
  // both get here; the loser simply finds the file already gone.
  await fs.promises.rm(scriptPath, { force: true })
  return 'removed'
}

function normalizedWindowsDirectory(value: string): string | null {
  const trimmed = value.trim().replace(/^"(.*)"$/, '$1').trim()
  if (!trimmed || !path.win32.isAbsolute(trimmed)) return null
  return path.win32.resolve(trimmed).replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * Whether a Windows PATH value already lists `directory`. Entries are compared
 * the way Windows resolves them: case-insensitively and ignoring a trailing
 * separator. Entries that still hold `%VAR%` references are not expanded here;
 * the PowerShell side does that against the registry.
 */
export function pathListIncludesDirectory(pathValue: string | undefined, directory: string): boolean {
  const target = normalizedWindowsDirectory(directory)
  if (!target || !pathValue) return false
  return pathValue.split(';').some((entry) => normalizedWindowsDirectory(entry) === target)
}

/**
 * Appends `$env:XINGMANG_ADD_PATH` to the current user's PATH unless the user
 * or machine PATH already lists it. It reads the raw registry value so entries
 * written as `%USERPROFILE%\...` survive: `[Environment]::SetEnvironmentVariable`
 * would store the expanded text as REG_SZ and silently freeze them. The final
 * `SetEnvironmentVariable` on a throwaway name exists only for its
 * WM_SETTINGCHANGE broadcast, so terminals opened from now on see the change
 * without signing out.
 */
export function buildEnsureUserPathScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$target = [IO.Path]::GetFullPath($env:XINGMANG_ADD_PATH).TrimEnd("\\")',
    'function Test-ListsTarget([string]$value) {',
    '  foreach ($entry in ($value -split ";")) {',
    '    if (-not $entry.Trim()) { continue }',
    '    try {',
    '      $expanded = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim(\'"\'))',
    '      if ([IO.Path]::GetFullPath($expanded).TrimEnd("\\") -ieq $target) { return $true }',
    '    } catch {}',
    '  }',
    '  return $false',
    '}',
    '$machine = [Environment]::GetEnvironmentVariable("Path", "Machine")',
    '$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")',
    'try {',
    '  $names = $key.GetValueNames()',
    '  $raw = ""',
    '  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString',
    '  if ($names -contains "Path") {',
    '    $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
    '    if ($key.GetValueKind("Path") -eq [Microsoft.Win32.RegistryValueKind]::String) { $kind = [Microsoft.Win32.RegistryValueKind]::String }',
    '  }',
    '  if ((Test-ListsTarget $machine) -or (Test-ListsTarget $raw)) { "present"; return }',
    '  $next = if ($raw.Trim()) { $raw.TrimEnd(";") + ";" + $target } else { $target }',
    '  $key.SetValue("Path", $next, $kind)',
    '} finally {',
    '  $key.Close()',
    '}',
    '[Environment]::SetEnvironmentVariable("XINGMANG_PATH_REFRESH", $null, "User")',
    '"added"',
  ].join('\n')
}

export function parseEnsureUserPathOutput(stdout: string): UserPathOutcome {
  const last = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
  if (last === 'added' || last === 'present') return last
  throw new Error('无法确认命令行工具目录是否已加入当前用户的设置')
}

export interface EnsureUserPathOptions {
  /** PATH this process started with; when it already lists the directory, no PowerShell is started. */
  inheritedPath?: string
  runPowerShell?: (script: string, env: NodeJS.ProcessEnv) => Promise<string>
}

async function runPowerShellScript(script: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    env,
    windowsHide: true,
    timeout: userPathTimeoutMs,
    maxBuffer: 64 * 1024,
  })
  return stdout
}

/**
 * Makes `directory` reachable by name from terminals the user opens later.
 * Only the current user's PATH is written, which needs no elevation; the
 * directory is appended so a CLI the user placed earlier on PATH still wins.
 */
export async function ensureDirectoryOnWindowsUserPath(
  directory: string,
  options: EnsureUserPathOptions = {},
): Promise<UserPathOutcome> {
  if (!path.win32.isAbsolute(directory) || directory.includes('\0') || directory.includes(';')) {
    throw new Error('命令行工具目录无效')
  }
  const inherited = options.inheritedPath ?? process.env.Path ?? process.env.PATH
  if (pathListIncludesDirectory(inherited, directory)) return 'present'
  const run = options.runPowerShell ?? runPowerShellScript
  const stdout = await run(buildEnsureUserPathScript(), {
    ...trustedCommandEnvironment(),
    XINGMANG_ADD_PATH: directory,
  })
  return parseEnsureUserPathOutput(stdout)
}

/**
 * Takes `$env:XINGMANG_REMOVE_PATH` back out of the current user's PATH. Like
 * buildEnsureUserPathScript it reads and writes the raw registry value and
 * keeps its kind, so the entries that stay keep their `%USERPROFILE%\...` form;
 * entries are expanded only to compare them, so the directory goes however it
 * was written. Nothing is written when no entry matches, and the machine PATH
 * is never touched.
 */
export function buildRemoveUserPathScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$target = [IO.Path]::GetFullPath($env:XINGMANG_REMOVE_PATH).TrimEnd("\\")',
    'function Test-IsTarget([string]$entry) {',
    '  if (-not $entry.Trim()) { return $false }',
    '  try {',
    '    $expanded = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim(\'"\'))',
    '    return ([IO.Path]::GetFullPath($expanded).TrimEnd("\\") -ieq $target)',
    '  } catch { return $false }',
    '}',
    '$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)',
    'if ($null -eq $key) { "absent"; return }',
    'try {',
    '  if (-not ($key.GetValueNames() -contains "Path")) { "absent"; return }',
    '  $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
    '  $kept = @()',
    '  $removed = $false',
    '  foreach ($entry in ($raw -split ";")) {',
    '    if (Test-IsTarget $entry) { $removed = $true } else { $kept += $entry }',
    '  }',
    '  if (-not $removed) { "absent"; return }',
    '  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString',
    '  if ($key.GetValueKind("Path") -eq [Microsoft.Win32.RegistryValueKind]::String) { $kind = [Microsoft.Win32.RegistryValueKind]::String }',
    '  $key.SetValue("Path", ($kept -join ";"), $kind)',
    '} finally {',
    '  $key.Close()',
    '}',
    '[Environment]::SetEnvironmentVariable("XINGMANG_PATH_REFRESH", $null, "User")',
    '"removed"',
  ].join('\n')
}

export function parseRemoveUserPathOutput(stdout: string): UserPathRemoval {
  const last = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
  if (last === 'removed' || last === 'absent') return last
  throw new Error('无法确认命令行工具目录是否已从当前用户的设置中去掉')
}

export interface RemoveUserPathOptions {
  runPowerShell?: (script: string, env: NodeJS.ProcessEnv) => Promise<string>
}

/**
 * After a CLI was uninstalled from `directory`, stops terminals the user opens
 * later from looking there. The PATH this process inherited says nothing about
 * the registry (the entry may have been added after launch), so PowerShell
 * always runs; it writes only when an entry actually matches.
 */
export async function removeDirectoryFromWindowsUserPath(
  directory: string,
  options: RemoveUserPathOptions = {},
): Promise<UserPathRemoval> {
  if (!path.win32.isAbsolute(directory) || directory.includes('\0') || directory.includes(';')) {
    throw new Error('命令行工具目录无效')
  }
  const run = options.runPowerShell ?? runPowerShellScript
  const stdout = await run(buildRemoveUserPathScript(), {
    ...trustedCommandEnvironment(),
    XINGMANG_REMOVE_PATH: directory,
  })
  return parseRemoveUserPathOutput(stdout)
}

export interface CliTerminalAccessInput {
  platform: NodeJS.Platform
  executionMode: 'trusted-only' | 'same-user'
  source: CliInstallSource
  npmPrefix: string | null
  /** Whether the install lives in the app's own admin-owned directory. */
  managed: boolean
  reason: 'install' | 'startup'
}

export interface CliTerminalAccessPlan {
  /** The directory holding `<command>.cmd` / `.ps1`; null means leave everything alone. */
  binDirectory: string | null
  ensureUserPath: boolean
}

/**
 * Decides what to touch so a user's own terminal can run a CLI by name.
 * Only npm installs on Windows have the `.ps1` problem. Under an elevated
 * token only the admin-owned managed prefix is touched, because deleting inside
 * a user-writable directory with that token is exactly the redirection I8
 * guards against. The PATH is checked right after an install or update only:
 * at startup that would mean a PowerShell cold start on every launch.
 */
export function buildCliTerminalAccessPlan(input: CliTerminalAccessInput): CliTerminalAccessPlan {
  const skip = { binDirectory: null, ensureUserPath: false }
  if (input.platform !== 'win32' || input.source !== 'npm' || !input.npmPrefix) return skip
  if (input.executionMode === 'trusted-only' && !input.managed) return skip
  return { binDirectory: input.npmPrefix, ensureUserPath: input.reason === 'install' }
}

export interface CliTerminalAccessTarget {
  provider: ProviderId
  installation: Pick<CliInstallation, 'source' | 'npmPrefix'>
}

export interface CliTerminalAccessOptions {
  platform: NodeJS.Platform
  executionMode: 'trusted-only' | 'same-user'
  /** Whether an install lives in the app's admin-owned managed prefix; may throw. */
  isManaged: (installation: CliTerminalAccessTarget['installation']) => boolean
  /** Absent = never touch PATH (tests and hosts other than the desktop app). */
  ensureUserPath?: (directory: string) => Promise<UserPathOutcome>
  /** The way back for `forgetUserPath`. Absent = never touch PATH, as above. */
  removeUserPath?: (directory: string) => Promise<UserPathRemoval>
  /**
   * macOS counterpart of `ensureUserPath`: makes the user's own terminal find
   * the CLIs. Absent = never touch the shell profile. The outcome string only
   * goes to the log.
   */
  ensureShellProfile?: (reason: 'install' | 'startup') => Promise<string>
  /**
   * Linux counterpart (linux-shell-profile.ts): keeps one launcher per CLI the
   * app installed and the marked lines in the shell startup files in step with
   * what is installed, and takes the lines out again after the last uninstall.
   * Absent = never touch either.
   */
  syncTerminalCommands?: (reason: 'install' | 'startup' | 'uninstall') => Promise<TerminalCommandsSyncResult>
  log?: (level: 'info' | 'warn', event: string, message: string, detail: Record<string, unknown>) => void
  /** Error text for the log; the caller redacts home directories and secrets. */
  describeError?: (error: unknown) => string
}

export interface TerminalCommandsSyncResult {
  outcome: string
  /** Files that could not be changed safely, named for the log without the home directory. */
  skipped: readonly string[]
}

export interface CliTerminalAccess {
  /** Never throws; failures only reach the log. */
  prepare(target: CliTerminalAccessTarget, reason: 'install' | 'startup'): Promise<void>
  /** The first call sweeps every detected install; later calls do nothing. */
  sweepOnce(targets: readonly CliTerminalAccessTarget[]): Promise<void>
  /** After a CLI was uninstalled. Only Linux has anything to undo; never throws. */
  release(provider: ProviderId): Promise<void>
  /**
   * After an uninstall emptied `directory` on Windows, takes it back out of the
   * user's PATH. Returns at once and never throws; the outcome only reaches the log.
   */
  forgetUserPath(provider: ProviderId, directory: string): void
}

/**
 * Everything the service does so a user's own terminal can run a CLI by name,
 * kept out of the scan so it can be exercised on a real Windows file system
 * without the rest of the machine probes. On macOS the whole job is the shell
 * profile (macos-shell-profile.ts): npm writes no `.ps1` there, and the
 * directories it adds are fixed, so which CLI triggered it does not matter.
 * Linux (linux-shell-profile.ts) adds a launcher per installed CLI on top, so
 * there every install and uninstall syncs again instead of once per session.
 */
export function createCliTerminalAccess(options: CliTerminalAccessOptions): CliTerminalAccess {
  const describe = options.describeError ?? ((error: unknown) => error instanceof Error ? error.message : String(error))
  // One directory is checked once per session: the four CLIs usually share a
  // prefix, and two installs finishing together must not both append it.
  const userPathChecks = new Map<string, Promise<void>>()
  let swept = false
  let shellProfileCheck: Promise<void> | null = null
  // Linux runs every sync, one after another: each install or uninstall changes
  // which launchers should exist, and two of them must not append to the same
  // startup file at once.
  let terminalCommandsQueue: Promise<void> = Promise.resolve()
  const linux = options.platform !== 'win32' && options.platform !== 'darwin'

  function isManagedSafely(installation: CliTerminalAccessTarget['installation']): boolean {
    try { return options.isManaged(installation) } catch { return false }
  }

  // Not awaited by the caller, like the macOS check: a slow home folder must not
  // hold back the "installed" message.
  function syncTerminalCommands(provider: ProviderId, reason: 'install' | 'startup' | 'uninstall'): void {
    const sync = options.syncTerminalCommands
    if (!sync) return
    terminalCommandsQueue = terminalCommandsQueue.then(() => sync(reason)).then((result) => {
      options.log?.('info', result.outcome === 'removed' ? 'cli.shell-profile.removed' : 'cli.shell-profile.checked',
        result.outcome === 'added'
          ? '已让新开的终端可以直接敲工具名'
          : result.outcome === 'removed'
            ? '星芒装的工具都卸掉了，终端启动设置里加的那几行已去掉'
            : '终端启动设置无需改动', { provider, reason, outcome: result.outcome })
      if (result.skipped.length) {
        options.log?.('warn', 'cli.shell-profile.skipped', '有的终端启动设置没能改，从星芒首页「打开」不受影响', {
          provider,
          reason,
          skipped: [...result.skipped],
        })
      }
    }, (error: unknown) => {
      options.log?.('warn', 'cli.shell-profile.failed', '没能让终端直接敲工具名，从星芒首页「打开」不受影响', {
        provider,
        reason,
        error: describe(error),
      })
    })
  }

  // The profile block names fixed directories rather than this install's, so
  // one check per session covers all four CLIs.
  function checkShellProfile(provider: ProviderId, reason: 'install' | 'startup'): void {
    const ensureShellProfile = options.ensureShellProfile
    if (!ensureShellProfile || shellProfileCheck) return
    shellProfileCheck = ensureShellProfile(reason).then((outcome) => {
      // 跳过的 shell 要明说，别让客服看成「这一步没问题」。
      options.log?.('info', 'cli.shell-profile.checked', outcome === 'added'
        ? '已让新开的终端可以直接敲工具名'
        : outcome === 'unsupported-shell'
          ? '登录 shell 不是 zsh、bash、fish，没改终端启动设置'
          : '终端启动设置无需改动', { provider, reason, outcome })
    }, (error: unknown) => {
      // Forget the failure so the next install tries again.
      shellProfileCheck = null
      options.log?.('warn', 'cli.shell-profile.failed', '没能让终端直接敲工具名，从星芒首页「打开」不受影响', {
        provider,
        reason,
        error: describe(error),
      })
    })
  }

  async function prepare(target: CliTerminalAccessTarget, reason: 'install' | 'startup'): Promise<void> {
    const { provider, installation } = target
    if (linux) {
      // Same rule as macOS at startup (Grok as in sweepOnce); after an install the
      // sync itself looks at what the app installed, whichever CLI triggered it.
      if (reason === 'startup' && provider !== 'grok' && !isManagedSafely(installation)) return
      syncTerminalCommands(provider, reason)
      return
    }
    if (options.platform === 'darwin') {
      // At startup only an install the app itself made counts: someone who
      // brought their own CLI has no use for the app's directories on PATH.
      if (reason === 'startup') {
        let managed = false
        try { managed = options.isManaged(installation) } catch { managed = false }
        if (!managed) return
      }
      checkShellProfile(provider, reason)
      return
    }
    let managed = false
    if (options.platform === 'win32' && options.executionMode === 'trusted-only') {
      try { managed = options.isManaged(installation) } catch { managed = false }
    }
    const plan = buildCliTerminalAccessPlan({
      platform: options.platform,
      executionMode: options.executionMode,
      source: installation.source,
      npmPrefix: installation.npmPrefix,
      managed,
      reason,
    })
    const binDirectory = plan.binDirectory
    if (!binDirectory) return
    const definition = cliCatalog[provider]
    try {
      const removal = await removeNpmPowerShellShim({
        binDirectory,
        command: definition.command,
        packageName: definition.packageName,
      })
      if (removal === 'removed') {
        options.log?.('info', 'cli.powershell-shim.removed', `${definition.name} 的 PowerShell 启动文件已移除，改用 .cmd`, { provider, reason })
      }
    } catch (error) {
      options.log?.('warn', 'cli.powershell-shim.failed', `${definition.name} 的 PowerShell 启动文件没有清理成功`, {
        provider,
        reason,
        error: describe(error),
      })
    }
    const ensureUserPath = options.ensureUserPath
    if (!plan.ensureUserPath || !ensureUserPath) return
    const key = path.win32.resolve(binDirectory).toLowerCase()
    if (userPathChecks.has(key)) return
    // Not awaited: a cold PowerShell start takes tens of seconds on a slow
    // machine, and the "installed" message should not wait for it.
    userPathChecks.set(key, ensureUserPath(binDirectory).then((outcome) => {
      options.log?.('info', 'cli.user-path.checked', outcome === 'added'
        ? '工具目录已加入当前用户的 PATH，新开的终端即可直接使用'
        : '工具目录已在 PATH 中', { provider, outcome })
    }, (error: unknown) => {
      // Forget the failure so the next install tries again.
      userPathChecks.delete(key)
      options.log?.('warn', 'cli.user-path.failed', '工具目录没有加入当前用户的 PATH', {
        provider,
        error: describe(error),
      })
    }))
  }

  async function sweepOnce(targets: readonly CliTerminalAccessTarget[]): Promise<void> {
    if (swept) return
    swept = true
    if (linux) {
      // One sync covers all four CLIs, so the first install of ours is enough to trigger it.
      // Grok never lives in the app's npm folder on Linux (it goes to ~/.grok/bin), so
      // any Grok install triggers it and the sync tells whether that one is ours.
      const managed = targets.find((target) => target.provider === 'grok' || isManagedSafely(target.installation))
      if (managed) syncTerminalCommands(managed.provider, 'startup')
      return
    }
    await Promise.all(targets.map((target) => prepare(target, 'startup')))
  }

  async function release(provider: ProviderId): Promise<void> {
    if (linux) syncTerminalCommands(provider, 'uninstall')
  }

  // Not awaited, like ensureUserPath: the files are already gone, so the
  // "uninstalled" message should not wait for a cold PowerShell start, and a
  // failure only leaves an entry that points at an empty directory.
  function forgetUserPath(provider: ProviderId, directory: string): void {
    const removeUserPath = options.removeUserPath
    if (options.platform !== 'win32' || !removeUserPath) return
    void Promise.resolve().then(() => removeUserPath(directory)).then((outcome) => {
      options.log?.('info', 'cli.user-path.removed', outcome === 'removed'
        ? '工具目录已从当前用户的 PATH 中去掉'
        : '工具目录不在当前用户的 PATH 中', { provider, outcome })
    }, (error: unknown) => {
      options.log?.('warn', 'cli.user-path.remove-failed', '工具目录没能从当前用户的 PATH 中去掉，不影响卸载结果', {
        provider,
        error: describe(error),
      })
    })
  }

  return { prepare, sweepOnce, release, forgetUserPath }
}
