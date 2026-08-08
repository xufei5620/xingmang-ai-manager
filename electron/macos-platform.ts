import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { managedNpmBinDirectory } from './managed-cli-paths'
import type { CommandSpec, RunCommandOptions } from './command-runner'

export interface MacosTerminalScriptPlan {
  executable: string
  argv: readonly string[]
  workspace: string
  launcherPath: string
  env: NodeJS.ProcessEnv
}

export interface MacosTerminalLaunchPlan extends Omit<MacosTerminalScriptPlan, 'launcherPath'> {}

type MacosCommandRunner = (
  spec: CommandSpec,
  options: RunCommandOptions,
) => Promise<unknown>

export type MacosTerminalCleanupScheduler = (
  cleanup: () => Promise<void>,
  delayMs: number,
) => void

interface PathIdentity {
  device: bigint
  inode: bigint
  owner: bigint
}

/**
 * A directory has to be recognized by identity alone: removing the launcher bumps
 * its own mtime and size, so comparing those would make the cleanup abandon the
 * directory it just emptied.
 *
 * A regular file has no such excuse, and identity alone is not enough for one.
 * `unlink` frees the inode number, and a filesystem is free to hand it straight
 * back to the next file created in its place — ext4 and tmpfs do so immediately,
 * APFS happens not to. Comparing size, link count and both timestamps is what
 * makes "is this still the file I wrote?" independent of that allocation policy,
 * so a replacement dropped at the same path is never mistaken for our own.
 */
interface FileIdentity extends PathIdentity {
  size: bigint
  links: bigint
  modifiedNs: bigint
  changedNs: bigint
}

interface LauncherIdentity {
  directory: PathIdentity
  launcher: FileIdentity
}

const terminalLauncherCleanupDelayMs = 5 * 60_000
const persistedTerminalEnvironmentKeys = new Set([
  'HOME',
  'PATH',
  'CODEX_HOME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'NODE_DISABLE_COLORS',
  'CLICOLOR',
  'CLICOLOR_FORCE',
])

function isAbsolutePath(value: string): boolean {
  return Boolean(value) && !value.includes('\0') && path.isAbsolute(value)
}

function pathIdentity(stats: fs.BigIntStats): PathIdentity {
  return { device: stats.dev, inode: stats.ino, owner: stats.uid }
}

function fileIdentity(stats: fs.BigIntStats): FileIdentity {
  return {
    ...pathIdentity(stats),
    size: stats.size,
    links: stats.nlink,
    modifiedNs: stats.mtimeNs,
    changedNs: stats.ctimeNs,
  }
}

function samePathIdentity(stats: fs.BigIntStats, expected: PathIdentity): boolean {
  return stats.dev === expected.device
    && stats.ino === expected.inode
    && stats.uid === expected.owner
}

function sameFileIdentity(stats: fs.BigIntStats, expected: FileIdentity): boolean {
  return samePathIdentity(stats, expected)
    && stats.size === expected.size
    && stats.nlink === expected.links
    && stats.mtimeNs === expected.modifiedNs
    && stats.ctimeNs === expected.changedNs
}

async function lstat(filePath: string): Promise<fs.BigIntStats | null> {
  try {
    return await fs.promises.lstat(filePath, { bigint: true })
  } catch {
    return null
  }
}

async function removeLauncherIfUnchanged(
  directory: string,
  launcherPath: string,
  identity: LauncherIdentity,
): Promise<void> {
  const directoryStats = await lstat(directory)
  if (
    !directoryStats?.isDirectory()
    || !samePathIdentity(directoryStats, identity.directory)
  ) return

  const launcherStats = await lstat(launcherPath)
  if (launcherStats) {
    if (!launcherStats.isFile() || !sameFileIdentity(launcherStats, identity.launcher)) return
    await fs.promises.unlink(launcherPath).catch(() => undefined)
  }

  const currentDirectoryStats = await lstat(directory)
  if (
    currentDirectoryStats?.isDirectory()
    && samePathIdentity(currentDirectoryStats, identity.directory)
  ) {
    await fs.promises.rmdir(directory).catch(() => undefined)
  }
}

function scheduleLauncherCleanup(
  cleanup: () => Promise<void>,
  delayMs: number,
): void {
  const timer = setTimeout(() => {
    void cleanup().catch(() => undefined)
  }, delayMs)
  timer.unref()
}

/** Returns fixed macOS discovery locations without consulting shell startup files. */
export function darwinCommandPathCandidates(
  baseEnv: NodeJS.ProcessEnv = process.env,
  additionalPaths: readonly string[] = [],
  homeDirectory = baseEnv.HOME?.trim() || os.homedir(),
): string[] {
  const inheritedPath = baseEnv.PATH ?? baseEnv.Path ?? baseEnv.path ?? ''
  return [
    ...additionalPaths,
    managedNpmBinDirectory({ ...baseEnv, HOME: homeDirectory }, 'darwin'),
    path.join(homeDirectory, '.grok', 'bin'),
    path.join(homeDirectory, '.local', 'bin'),
    path.join(homeDirectory, '.volta', 'bin'),
    path.join(homeDirectory, '.cargo', 'bin'),
    path.join(homeDirectory, '.npm-global', 'bin'),
    path.join(homeDirectory, 'Library', 'pnpm'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    ...inheritedPath.split(path.delimiter),
  ]
}

/** Quotes one POSIX shell argument without evaluating its contents. */
export function quotePosixArgument(value: string): string {
  if (value.includes('\0')) throw new TypeError('POSIX argument must not contain NUL bytes')
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Builds the short-lived zsh launcher that Terminal executes. */
export function buildMacosTerminalScript(plan: MacosTerminalScriptPlan): string {
  if (!isAbsolutePath(plan.executable)) throw new TypeError('executable must be an absolute path')
  if (!isAbsolutePath(plan.workspace)) throw new TypeError('workspace must be an absolute path')
  if (!isAbsolutePath(plan.launcherPath)) throw new TypeError('launcher path must be an absolute path')
  if (plan.argv.some((argument) => argument.includes('\0'))) {
    throw new TypeError('argv must not contain NUL bytes')
  }
  const environmentEntries = Object.entries(plan.env)
  for (const [key, value] of environmentEntries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new TypeError(`invalid environment key: ${key}`)
    }
    if (value?.includes('\0')) throw new TypeError(`environment value for ${key} must not contain NUL bytes`)
  }
  for (const requiredKey of ['HOME', 'PATH'] as const) {
    if (!plan.env[requiredKey]?.trim()) {
      throw new TypeError(`environment ${requiredKey} is required`)
    }
  }
  const shellMaintainedEnvironmentKeys = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])
  const environmentExports = environmentEntries
    .filter((entry): entry is [string, string] => (
      entry[1] !== undefined
      && persistedTerminalEnvironmentKeys.has(entry[0])
      && !shellMaintainedEnvironmentKeys.has(entry[0])
    ))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `export ${key}=${quotePosixArgument(value)}`)

  return [
    '#!/bin/zsh -f',
    'set -eu',
    `rm -f -- ${quotePosixArgument(plan.launcherPath)}`,
    `rmdir -- ${quotePosixArgument(path.dirname(plan.launcherPath))} 2>/dev/null || true`,
    `cd -- ${quotePosixArgument(plan.workspace)}`,
    ...environmentExports,
    `exec -- ${[plan.executable, ...plan.argv].map(quotePosixArgument).join(' ')}`,
    '',
  ].join('\n')
}

async function writeLauncherAtomically(launcherPath: string, content: string): Promise<void> {
  const temporaryPath = `${launcherPath}.${randomUUID()}.tmp`
  const file = await fs.promises.open(temporaryPath, 'wx', 0o600)
  let renamed = false
  try {
    try {
      await file.writeFile(content, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await fs.promises.chmod(temporaryPath, 0o700)
    await fs.promises.rename(temporaryPath, launcherPath)
    renamed = true
  } finally {
    // A failed write must not leave the partial file behind. The caller only has an
    // empty-directory removal to fall back on, so a surviving .tmp would keep the
    // whole mkdtemp tree alive with no owner and no later pass to collect it.
    if (!renamed) await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

const collectedTerminalRoots = new Set<string>()

function terminalDirectoryPrefix(processId: number = process.pid): string {
  return `xingmang-terminal-${processId}-`
}

/** One sweep per temp root per process; launching a terminal is not a rare event. */
async function cleanupStaleTerminalDirectoriesOnce(baseDirectory: string): Promise<void> {
  const key = path.resolve(baseDirectory)
  if (collectedTerminalRoots.has(key)) return
  collectedTerminalRoots.add(key)
  await cleanupStaleTerminalDirectories(baseDirectory)
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Removes launcher directories left by processes that are gone.
 *
 * The launcher is normally unlinked by the script itself or by the scheduled
 * cleanup, but neither runs if the app exits in between, and nothing else ever
 * looked at these directories again. Keying on the creating pid rather than on an
 * age threshold means a directory is only collected once its owner cannot possibly
 * still need it, so a launcher waiting out its five-minute window is never taken.
 */
export async function cleanupStaleTerminalDirectories(
  baseDirectory = os.tmpdir(),
  isAlive: (processId: number) => boolean = processIsAlive,
): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(baseDirectory, { withFileTypes: true })
  } catch {
    return
  }
  const currentUid = process.getuid?.()
  await Promise.all(entries.map(async (entry) => {
    const match = /^xingmang-terminal-(\d+)-/.exec(entry.name)
    if (!match || !entry.isDirectory()) return
    const processId = Number(match[1])
    if (!Number.isSafeInteger(processId) || processId <= 0 || isAlive(processId)) return
    const directory = path.join(baseDirectory, entry.name)
    try {
      const stats = await fs.promises.lstat(directory)
      if (!stats.isDirectory() || stats.isSymbolicLink()) return
      if (currentUid !== undefined && stats.uid !== currentUid) return
      await fs.promises.rm(directory, { recursive: true, force: true })
    } catch {
      // A concurrently removed or inaccessible stale directory is harmless.
    }
  }))
}

async function defaultCommandRunner(spec: CommandSpec, options: RunCommandOptions): Promise<unknown> {
  const { runCommand } = await import('./command-runner')
  return runCommand(spec, options)
}

/** Creates an app-owned launcher and opens it in Terminal through runCommand. */
export async function launchMacosTerminal(
  plan: MacosTerminalLaunchPlan,
  commandRunner: MacosCommandRunner = defaultCommandRunner,
  scheduleCleanup: MacosTerminalCleanupScheduler = scheduleLauncherCleanup,
): Promise<void> {
  if (!isAbsolutePath(plan.executable)) throw new TypeError('executable must be an absolute path')
  if (!isAbsolutePath(plan.workspace)) throw new TypeError('workspace must be an absolute path')

  const baseDirectory = os.tmpdir()
  await cleanupStaleTerminalDirectoriesOnce(baseDirectory)
  // The pid is part of the name so the collector above can tell a directory whose
  // owner is gone from one still waiting out its cleanup delay.
  const directory = await fs.promises.mkdtemp(path.join(baseDirectory, terminalDirectoryPrefix()))
  const launcherPath = path.join(directory, 'launch.zsh')
  let launcherIdentity: LauncherIdentity | null = null
  try {
    await fs.promises.chmod(directory, 0o700)
    await writeLauncherAtomically(launcherPath, buildMacosTerminalScript({ ...plan, launcherPath }))
    const [directoryStats, launcherStats] = await Promise.all([
      fs.promises.lstat(directory, { bigint: true }),
      fs.promises.lstat(launcherPath, { bigint: true }),
    ])
    if (!directoryStats.isDirectory() || !launcherStats.isFile()) {
      throw new Error('macOS Terminal launcher identity is invalid')
    }
    launcherIdentity = {
      directory: pathIdentity(directoryStats),
      launcher: fileIdentity(launcherStats),
    }
    await commandRunner({
      executable: '/usr/bin/open',
      argv: ['-a', 'Terminal', launcherPath],
    }, {
      cwd: plan.workspace,
    })
    const cleanupIdentity = launcherIdentity
    scheduleCleanup(
      () => removeLauncherIfUnchanged(directory, launcherPath, cleanupIdentity),
      terminalLauncherCleanupDelayMs,
    )
  } catch (error) {
    if (launcherIdentity) {
      await removeLauncherIfUnchanged(directory, launcherPath, launcherIdentity)
    } else {
      // Recursive removal is confined to the directory this call just created with
      // mkdtemp, and is only reached before the launcher has an identity — so there
      // is nothing here worth preserving. A plain rmdir would fail on any partial
      // file left behind and leak the tree.
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
    throw error
  }
}
