import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redactSecretPatterns } from './redaction-patterns'

/**
 * This module records failures that happen before the normal logging stack
 * exists. It therefore imports nothing but Node built-ins and the import-free
 * `redaction-patterns` table: the failure being recorded may well be
 * `command-runner`, `safe-local-data` or Electron itself failing to load, and a
 * last-resort logger that shares their dependencies would go down with them.
 *
 * Everything here is synchronous. A fatal startup error usually kills the
 * process within the same tick, so a queued async write would never land.
 */

const APP_DIRECTORY_NAME = '星芒AI管理工具'
/** Kept separate from runtime.jsonl so the runtime store's rotation cannot age
 *  out the one record that explains why the app never started. */
export const STARTUP_LOG_FILE_NAME = 'startup-failure.log'
const MAX_STARTUP_LOG_BYTES = 128 * 1024
const MAX_RECORD_LENGTH = 8_192

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Linux paths that carry an account name or uid outside the home directory itself:
 * other homes, removable media mounted per user, and the per-user runtime directory
 * (gvfs network shares live under it). /home is matched anywhere, like crash-report.ts
 * does, which also covers the /var/home and /data/home roots of Silverblue and UOS; the
 * generic /media segment only at a path start or under /run, so a package's own
 * media/ folder survives.
 */
const linuxUserPathPatterns: ReadonlyArray<[RegExp, string]> = [
  [/(\/home\/)[^/\s:"'\\]+/g, '$1%USER%'],
  [/(^|[^A-Za-z0-9._@~/-]|\/run)(\/media\/)[^/\s:"'\\]+/g, '$1$2%USER%'],
  [/(\/run\/user\/)\d+/g, '$1%UID%'],
  // gvfs names a network share's mount point after its login: smb-share:server=x,user=alice.
  [/(\/gvfs\/[^/\s"'\\]*?[:,]user=)[^,/\s"'\\]+/g, '$1%USER%'],
]

/** Applies only on Linux; the Windows and macOS output stays exactly what it was. */
export function redactLinuxUserPaths(value: string): string {
  let result = value
  for (const [pattern, replacement] of linuxUserPathPatterns) result = result.replace(pattern, replacement)
  return result
}

/**
 * Every spelling a root directory takes in the text we redact: as given and
 * resolved, with either separator, with escaped forward slashes (`C:\/Users\/al`,
 * from serializers that escape them) and JSON-escaped (a path inside a
 * serialized payload). The runtime log and the diagnostics export used to build
 * a list each, the runtime log's the shorter one, so a spelling the export
 * already hid could still reach support through the log. `resolved` comes from
 * the caller because the export resolves Windows paths as Windows paths on any
 * platform, which `path.resolve` does not.
 */
export function pathRootSpellings(root: string, resolved: string): string[] {
  const slashRoot = root.replaceAll('\\', '/')
  const slashResolved = resolved.replaceAll('\\', '/')
  const spellings = new Set([
    root,
    resolved,
    slashRoot,
    root.replaceAll('/', '\\'),
    slashResolved,
    resolved.replaceAll('/', '\\'),
    slashRoot.replaceAll('/', '\\/'),
    slashResolved.replaceAll('/', '\\/'),
  ])
  for (const spelling of [...spellings]) spellings.add(JSON.stringify(spelling).slice(1, -1))
  return [...spellings].filter(Boolean)
}

/**
 * Replaces the user's home directory in any spelling: with `%USERPROFILE%` on Windows and
 * macOS, and with `~` on Linux, where the Windows name only confuses support. On Linux
 * the match also has to end at a path boundary, so home /home/al does not turn
 * /home/alice into a mangled half-name, and the other per-user paths go too.
 */
export function redactHomeDirectory(
  value: string,
  homeDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = homeDirectory.trim()
  const linux = platform !== 'win32' && platform !== 'darwin'
  if (!home) return linux ? redactLinuxUserPaths(value) : value
  const candidates = pathRootSpellings(home, path.resolve(home))
  const caseInsensitive = /^[A-Za-z]:[\\/]/.test(home) || home.startsWith('\\\\')
  const posixHome = linux && !caseInsensitive
  const label = posixHome ? '~' : '%USERPROFILE%'
  const boundary = posixHome ? '(?![A-Za-z0-9._-])' : ''
  let result = value
  for (const candidate of candidates.sort((left, right) => right.length - left.length)) {
    result = result.replace(
      new RegExp(`${escapeRegExp(candidate)}${boundary}`, caseInsensitive ? 'gi' : 'g'),
      label,
    )
  }
  return linux ? redactLinuxUserPaths(result) : result
}

/**
 * Uses the import-free pattern table directly rather than `redactCommandText`:
 * importing that function would pull `command-runner` and its whole Windows
 * path-resolution graph into the one module that has to keep working when such
 * a module is the reason startup failed.
 */
export function redactStartupSecrets(value: string): string {
  return redactSecretPatterns(value)
}

export interface StartupLogLocationOptions {
  /** `app.getPath('userData')` when Electron is far enough along to provide it. */
  userDataDirectory?: string | null
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
}

/**
 * Resolves to the same `logs` directory the runtime log uses, so support only
 * ever has to ask for one location. The per-platform fallbacks reproduce
 * Electron's own `userData` convention for the case where `app` cannot answer.
 */
export function resolveStartupLogDirectory(options: StartupLogLocationOptions = {}): string {
  const userData = options.userDataDirectory?.trim()
  if (userData) return path.join(userData, 'logs')

  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.homeDirectory ?? os.homedir()
  if (platform === 'win32') {
    const roaming = env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming')
    return path.join(roaming, APP_DIRECTORY_NAME, 'logs')
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_DIRECTORY_NAME, 'logs')
  }
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config')
  return path.join(configHome, APP_DIRECTORY_NAME, 'logs')
}

export function resolveStartupLogPath(options: StartupLogLocationOptions = {}): string {
  return path.join(resolveStartupLogDirectory(options), STARTUP_LOG_FILE_NAME)
}

export interface StartupFailureContext {
  phase: string
  appVersion?: string | null
  packaged?: boolean | null
  platform?: NodeJS.Platform
  homeDirectory?: string
  now?: () => Date
}

function describeError(error: unknown): { name: string; message: string; stack: string } {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message || '',
      stack: typeof error.stack === 'string' ? error.stack : '',
    }
  }
  return { name: typeof error, message: String(error), stack: '' }
}

/** Builds the exact text appended to the startup log. Pure, so it is testable. */
export function formatStartupFailure(error: unknown, context: StartupFailureContext): string {
  const home = context.homeDirectory ?? os.homedir()
  const scrub = (value: string) => redactStartupSecrets(redactHomeDirectory(value, home))
  const described = describeError(error)
  const timestamp = (context.now?.() ?? new Date()).toISOString()
  const header = [
    `time=${timestamp}`,
    `phase=${context.phase}`,
    `version=${context.appVersion ?? 'unknown'}`,
    `packaged=${context.packaged ?? 'unknown'}`,
    `platform=${context.platform ?? process.platform}`,
    `electron=${process.versions.electron ?? 'unknown'}`,
    `node=${process.versions.node}`,
  ].join(' ')
  const body = described.stack || `${described.name}: ${described.message}`
  return `${header}\n${scrub(body).slice(0, MAX_RECORD_LENGTH)}\n\n`
}

/**
 * O_NOFOLLOW closes the window between the `lstat` and the `open`: a symlink
 * swapped in after the check makes the open fail instead of following it. The
 * flag is POSIX-only, so on Windows the `lstat` rejection and the re-check of
 * the opened descriptor stand alone — Node reports both symlinks and directory
 * junctions as symbolic links there.
 */
function noFollowFlag(): number {
  const noFollow = fs.constants.O_NOFOLLOW
  return typeof noFollow === 'number' ? noFollow : 0
}

/** The only thing this module writes to or reads from: a plain file with one name. */
function isPlainSingleLinkFile(stats: fs.BigIntStats): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n
}

/**
 * Opens the startup log for one append, or returns null when the name cannot
 * be trusted to be the file it looks like.
 *
 * The log sits in a user-writable directory and the process writing it may be
 * elevated, so a symlink or an extra hard link left under our name would turn
 * the append into a write wherever that link leads. Such a name is dropped the
 * same way an oversized log is: `rmSync` unlinks the name, never what it points
 * at, and the record goes into a file created here with O_EXCL, which refuses a
 * name that reappeared after the unlink instead of following it. An existing
 * plain file is opened without O_CREAT, so a link swapped in after the `lstat`
 * is never created through, and the descriptor must still be the file the
 * `lstat` saw before a byte is written.
 */
function openStartupLogForAppend(filePath: string): number | null {
  let existing: fs.BigIntStats | null = null
  try {
    existing = fs.lstatSync(filePath, { bigint: true })
  } catch {
    // Missing, or not inspectable: only a file created below gets written.
  }
  // Keep only the newest records. A boot loop would otherwise grow this file
  // without bound, and the oldest entry is the least useful one.
  if (existing && (!isPlainSingleLinkFile(existing) || existing.size > BigInt(MAX_STARTUP_LOG_BYTES))) {
    fs.rmSync(filePath, { force: true })
    existing = null
  }

  const { O_APPEND, O_CREAT, O_EXCL, O_WRONLY } = fs.constants
  const flags = existing ? O_WRONLY | O_APPEND : O_WRONLY | O_APPEND | O_CREAT | O_EXCL
  const descriptor = fs.openSync(filePath, flags | noFollowFlag())
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true })
    const sameFile = !existing || (opened.dev === existing.dev && opened.ino === existing.ino)
    if (isPlainSingleLinkFile(opened) && sameFile) return descriptor
  } catch {
    // A descriptor that cannot be verified is not written to.
  }
  fs.closeSync(descriptor)
  return null
}

/**
 * Appends one failure record and returns the file it landed in, or null when
 * even that was impossible. Never throws: this runs on the path where the
 * application is already failing, and a logger that adds a second exception
 * would replace the diagnosis with noise. Deliberately bare `fs` rather than
 * `safe-local-data` — see the module header for why this module imports nothing.
 */
export function recordStartupFailure(
  error: unknown,
  context: StartupFailureContext,
  location: StartupLogLocationOptions = {},
): string | null {
  let descriptor: number | null = null
  try {
    const record = Buffer.from(formatStartupFailure(error, context), 'utf8')
    const directory = resolveStartupLogDirectory(location)
    const filePath = path.join(directory, STARTUP_LOG_FILE_NAME)
    fs.mkdirSync(directory, { recursive: true })
    descriptor = openStartupLogForAppend(filePath)
    if (descriptor === null) return null
    let offset = 0
    while (offset < record.length) {
      const bytesWritten = fs.writeSync(descriptor, record, offset, record.length - offset)
      if (bytesWritten === 0) break
      offset += bytesWritten
    }
    return filePath
  } catch {
    return null
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Nothing useful is left to do with a descriptor that will not close.
      }
    }
  }
}

/**
 * Upper bound for a drained log. `recordStartupFailure` discards the file once
 * it passes MAX_STARTUP_LOG_BYTES and every record it appends afterwards is a
 * one-line header plus at most MAX_RECORD_LENGTH characters, so nothing this
 * module wrote can exceed this. Anything larger was put there by something
 * else, and reading it would fold an attacker-chosen file into runtime.jsonl
 * and from there into the support export.
 */
const MAX_STARTUP_LOG_READ_BYTES = MAX_STARTUP_LOG_BYTES + 2 * MAX_RECORD_LENGTH

/**
 * Reads and clears the startup log so it can be folded into the runtime log.
 *
 * The file lives in a user-writable directory, so anyone who can create a file
 * there can also leave a symlink, a junction or an extra hard link pointing at
 * something else entirely, and whatever comes back from here reaches the
 * feedback export. So: a plain single-linked file, no larger than this module
 * could have written, re-verified on the open descriptor so the name cannot be
 * swapped underneath us. Deliberately bare `fs` rather than `safe-local-data`
 * — see the module header for why this module imports nothing.
 */
export function drainStartupFailures(filePath: string): string | null {
  let descriptor: number | null = null
  try {
    const link = fs.lstatSync(filePath, { bigint: true })
    if (!isPlainSingleLinkFile(link)) return null
    if (link.size > BigInt(MAX_STARTUP_LOG_READ_BYTES)) return null

    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag())
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!isPlainSingleLinkFile(opened)) return null
    if (opened.size > BigInt(MAX_STARTUP_LOG_READ_BYTES)) return null
    if (opened.dev !== link.dev || opened.ino !== link.ino) return null

    const buffer = Buffer.allocUnsafe(Number(opened.size))
    let offset = 0
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset).toString('utf8').trim() || null
  } catch {
    return null
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Nothing useful is left to do with a descriptor that will not close.
      }
    }
    // Clear it whether or not it was read: a file we refuse would otherwise be
    // re-examined on every boot. `rmSync` unlinks the name, so a planted
    // symlink disappears and the file it points at is untouched.
    try {
      fs.rmSync(filePath, { force: true })
    } catch {
      // Best effort. The size cap keeps a file we cannot remove harmless.
    }
  }
}
