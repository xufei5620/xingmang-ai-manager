import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { readBoundedUtf8File } from './bounded-file'
import { trustedCommandEnvironment } from './command-runner'
import { assertNoReparseComponents } from './safe-local-data'
import type { CliInstallSource } from './tool-installation'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

const execFileAsync = promisify(execFile)

// npm's cmd-shim writes a few hundred bytes; anything far larger is not one.
const maximumPowerShellShimBytes = 64 * 1024

// Windows PowerShell starts cold in well over ten seconds on a slow disk with
// Defender scanning; the step runs after the install already reported success,
// so a generous budget costs the user nothing.
const ensureUserPathTimeoutMs = 60_000

export type PowerShellShimRemoval = 'removed' | 'absent' | 'kept'
export type UserPathOutcome = 'added' | 'present'

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
    timeout: ensureUserPathTimeoutMs,
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
