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

/**
 * Returns fixed macOS discovery locations without consulting shell startup files.
 *
 * The system directories come before any writable one. Every command this app
 * resolves that macOS actually ships — git and python3 — is then taken from the
 * SIP-protected copy rather than from whatever a user-scoped directory happens to
 * offer under that name. Nothing else regresses: node, npm, npx and the four CLIs
 * do not exist under /usr/bin at all, so they still fall through to the locations
 * they are installed in.
 *
 * `additionalPaths` stays first because callers pass an exact directory they already
 * resolved, which is a stronger statement than any of the guesses below it.
 *
 * This is ordering only. Whether a resolved file may then be executed is a separate
 * decision, made in darwin-path-trust.ts.
 */
export function darwinCommandPathCandidates(
  baseEnv: NodeJS.ProcessEnv = process.env,
  additionalPaths: readonly string[] = [],
  homeDirectory = baseEnv.HOME?.trim() || os.homedir(),
): string[] {
  const inheritedPath = baseEnv.PATH ?? baseEnv.Path ?? baseEnv.path ?? ''
  return [
    ...additionalPaths,
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    managedNpmBinDirectory({ ...baseEnv, HOME: homeDirectory }, 'darwin'),
    path.join(homeDirectory, '.grok', 'bin'),
    path.join(homeDirectory, '.local', 'bin'),
    path.join(homeDirectory, '.volta', 'bin'),
    path.join(homeDirectory, '.cargo', 'bin'),
    path.join(homeDirectory, '.npm-global', 'bin'),
    path.join(homeDirectory, 'Library', 'pnpm'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
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
  try {
    await file.writeFile(content, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
  await fs.promises.chmod(temporaryPath, 0o700)
  await fs.promises.rename(temporaryPath, launcherPath)
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

  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-terminal-'))
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
      await fs.promises.rmdir(directory).catch(() => undefined)
    }
    throw error
  }
}
