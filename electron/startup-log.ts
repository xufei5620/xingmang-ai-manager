import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * This module records failures that happen before the normal logging stack
 * exists. It therefore imports nothing but Node built-ins: the failure being
 * recorded may well be `command-runner`, `safe-local-data` or Electron itself
 * failing to load, and a last-resort logger that shares their dependencies
 * would go down with them.
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

/** Replaces the user's home directory with `%USERPROFILE%` in any spelling. */
export function redactHomeDirectory(value: string, homeDirectory: string): string {
  const home = homeDirectory.trim()
  if (!home) return value
  const candidates = new Set([
    home,
    path.resolve(home),
    home.replaceAll('\\', '/'),
    home.replaceAll('/', '\\'),
    JSON.stringify(home).slice(1, -1),
  ])
  const caseInsensitive = /^[A-Za-z]:[\\/]/.test(home) || home.startsWith('\\\\')
  let result = value
  for (const candidate of [...candidates].filter(Boolean).sort((left, right) => right.length - left.length)) {
    result = result.replace(
      new RegExp(escapeRegExp(candidate), caseInsensitive ? 'gi' : 'g'),
      '%USERPROFILE%',
    )
  }
  return result
}

/**
 * A deliberately independent copy of the secret patterns in
 * `redactCommandText`. Importing that function would pull `command-runner` and
 * its whole Windows path-resolution graph into the one module that has to keep
 * working when such a module is the reason startup failed.
 */
export function redactStartupSecrets(value: string): string {
  return value
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]')
    // The quoted spellings need their own rules: in `{"access_token":"…"}` the
    // rule below can never match, because `\s*` does not cross the quote that
    // closes the key name, so any CLI writing JSON to stderr leaked its secrets
    // verbatim into the runtime log and the feedback export. Redacting between
    // the existing quotes also keeps a JSON body parseable.
    .replace(/((?:api[_-]?key|authorization|token|secret|password)"\s*[:=]\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/((?:api[_-]?key|authorization|token|secret|password)'\s*[:=]\s*)'[^']*'/gi, "$1'[REDACTED]'")
    .replace(/((?:api[_-]?key|authorization|token|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|token)=)[^&\s]+/gi, '$1[REDACTED]')
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
 * Appends one failure record and returns the file it landed in, or null when
 * even that was impossible. Never throws: this runs on the path where the
 * application is already failing, and a logger that adds a second exception
 * would replace the diagnosis with noise.
 */
export function recordStartupFailure(
  error: unknown,
  context: StartupFailureContext,
  location: StartupLogLocationOptions = {},
): string | null {
  try {
    const directory = resolveStartupLogDirectory(location)
    const filePath = path.join(directory, STARTUP_LOG_FILE_NAME)
    fs.mkdirSync(directory, { recursive: true })
    // Keep only the newest records. A boot loop would otherwise grow this file
    // without bound, and the oldest entry is the least useful one.
    try {
      if (fs.statSync(filePath).size > MAX_STARTUP_LOG_BYTES) fs.rmSync(filePath, { force: true })
    } catch {
      // No existing file, or it cannot be inspected; appending still works.
    }
    fs.appendFileSync(filePath, formatStartupFailure(error, context), { encoding: 'utf8' })
    return filePath
  } catch {
    return null
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
 * O_NOFOLLOW closes the window between the `lstat` and the `open`: a symlink
 * swapped in after the check makes the open fail instead of following it. The
 * flag is POSIX-only, so on Windows the `lstat` rejection stands alone — Node
 * reports both symlinks and directory junctions as symbolic links there.
 */
function readOnlyOpenFlags(): number {
  const noFollow = fs.constants.O_NOFOLLOW
  return typeof noFollow === 'number' ? fs.constants.O_RDONLY | noFollow : fs.constants.O_RDONLY
}

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
    if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1n) return null
    if (link.size > BigInt(MAX_STARTUP_LOG_READ_BYTES)) return null

    descriptor = fs.openSync(filePath, readOnlyOpenFlags())
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n) return null
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
