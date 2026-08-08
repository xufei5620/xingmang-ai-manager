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

/** Reads and clears the startup log so it can be folded into the runtime log. */
export function drainStartupFailures(filePath: string): string | null {
  try {
    const contents = fs.readFileSync(filePath, 'utf8')
    fs.rmSync(filePath, { force: true })
    return contents.trim() || null
  } catch {
    return null
  }
}
