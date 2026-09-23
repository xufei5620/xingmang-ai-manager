import os from 'node:os'
import path from 'node:path'
import { readBoundedUtf8File } from './bounded-file'

/**
 * Same-user npm installs run with an empty `--userconfig` so the user's .npmrc
 * cannot change the registry, lifecycle-script policy or lockfile behaviour of
 * a verified install. That also discarded the one setting the user meant for
 * every global install: `prefix`. npm then fell back to its builtin prefix
 * (`%APPDATA%\npm` on Windows), and the command the user actually runs kept
 * the old version. This module recovers only that key, parsed the way npm
 * parses it, so the install can pass it back as an explicit `--prefix`.
 */

// A user-level .npmrc holds a handful of lines; anything larger is not one we
// should be parsing on the install path.
const maximumUserNpmrcBytes = 64 * 1024
const maximumNpmPrefixLength = 1024

function isQuotedIniValue(value: string): boolean {
  return (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith('\'') && value.endsWith('\''))
}

/** Mirrors `unsafe()` in npm's `ini` package, which decides escapes and comments. */
function unescapeIniValue(raw: string): unknown {
  const value = raw.trim()
  if (isQuotedIniValue(value)) {
    const inner = value.charAt(0) === '\'' ? value.slice(1, -1) : value
    try {
      return JSON.parse(inner)
    } catch {
      return inner
    }
  }
  let escaped = false
  let result = ''
  for (const character of value) {
    if (escaped) {
      result += '\\;#'.includes(character) ? character : `\\${character}`
      escaped = false
    } else if (character === ';' || character === '#') {
      break
    } else if (character === '\\') {
      escaped = true
    } else {
      result += character
    }
  }
  if (escaped) result += '\\'
  return result.trim()
}

/**
 * Returns the last top-level string value of `key` in .npmrc text, or null.
 * Follows the `ini` decoder npm uses: keys under a `[section]` are not
 * top-level, `key[]` is a different (array) key, and a later line wins.
 */
export function parseNpmrcTopLevelString(text: string, key: string): string | null {
  let inSection = false
  let found: string | null = null
  for (const line of text.split(/[\r\n]+/g)) {
    if (!line || /^\s*[;#]/.test(line) || /^\s*$/.test(line)) continue
    const match = line.match(/^\[([^\]]*)\]\s*$|^([^=]+)(=(.*))?$/i)
    if (!match) continue
    if (match[1] !== undefined) {
      inSection = true
      continue
    }
    if (inSection || unescapeIniValue(match[2]) !== key) continue
    const value = match[3] ? unescapeIniValue(match[4]) : true
    found = typeof value === 'string' ? value : null
  }
  return found
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return env[name]
  // npm reads process.env, which Windows resolves case-insensitively; the
  // environment we are handed is a plain copy that does not.
  const wanted = name.toLowerCase()
  let value: string | undefined
  for (const [candidate, candidateValue] of Object.entries(env)) {
    if (candidate.toLowerCase() === wanted) value = candidateValue
  }
  return value
}

/** npm matches `npm_config_*` case-insensitively on every platform. */
function npmConfigEnvironmentValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const wanted = `npm_config_${key}`
  let value: string | null = null
  for (const [candidate, candidateValue] of Object.entries(env)) {
    if (candidate.toLowerCase() === wanted && candidateValue) value = candidateValue
  }
  return value
}

/** npm's home: `HOME` when set (Git Bash sets it on Windows), otherwise the OS answer. */
export function resolveNpmHomeDirectory(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  homedir: () => string = os.homedir,
): string {
  return environmentValue(env, 'HOME', platform) || homedir()
}

export interface NpmPathValueContext {
  env: NodeJS.ProcessEnv
  home: string
  platform?: NodeJS.Platform
}

/**
 * Resolves an npm `path`-typed config value (after ini decoding) the way npm's
 * parse-field does: `${VAR}` expansion, then `~/` against npm's home. npm
 * would resolve a relative value against whatever directory it was started in;
 * our installs start inside a temporary directory, so a relative or otherwise
 * unusable value yields null and the caller keeps its previous behaviour.
 */
export function resolveNpmPathConfigValue(
  raw: string,
  context: NpmPathValueContext,
): string | null {
  const platform = context.platform ?? process.platform
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const expanded = raw.trim().replace(
    /(?<!\\)(\\*)\$\{([^${}]+)\}/g,
    (original, escapes: string, name: string) => {
      const value = environmentValue(context.env, name, platform) ?? `\${${name}}`
      if (escapes.length % 2) return original.slice((escapes.length + 1) / 2)
      return escapes.slice(escapes.length / 2) + value
    },
  )
  if (!expanded || expanded.length > maximumNpmPrefixLength) return null
  // An unexpanded variable or a control character means this is not the path
  // the user believes they configured.
  if (expanded.includes('${') || /[\x00-\x1f]/.test(expanded)) return null
  const homePattern = platform === 'win32' ? /^~(\/|\\)/ : /^~\//
  const candidate = homePattern.test(expanded) && context.home
    ? pathApi.resolve(context.home, expanded.slice(2))
    : expanded
  if (platform === 'win32') {
    // Only drive-letter or UNC roots. A bare `\dir` depends on the current
    // drive, and `\\?\` / `\\.\` device paths are not install directories.
    if (/^[\\/]{2}[?.][\\/]/.test(candidate)) return null
    if (!/^[a-zA-Z]:[\\/]/.test(candidate) && !/^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(candidate)) return null
  } else if (!pathApi.isAbsolute(candidate)) {
    return null
  }
  const normalized = pathApi.resolve(candidate)
  return normalized.length > maximumNpmPrefixLength ? null : normalized
}

/** Where npm would read the user config from if we did not override it. */
export function resolveUserNpmrcPath(context: NpmPathValueContext): string | null {
  const fromEnvironment = npmConfigEnvironmentValue(context.env, 'userconfig')
  if (fromEnvironment) return resolveNpmPathConfigValue(fromEnvironment, context)
  const pathApi = (context.platform ?? process.platform) === 'win32' ? path.win32 : path.posix
  return context.home ? pathApi.join(context.home, '.npmrc') : null
}

/** The directory npm puts global command shims in for a given prefix. */
export function npmPrefixBinDirectory(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.win32.normalize(prefix) : path.posix.join(prefix, 'bin')
}

/** The `node_modules` directory npm installs global packages into for a prefix. */
export function npmPrefixGlobalRoot(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? path.win32.join(prefix, 'node_modules')
    : path.posix.join(prefix, 'lib', 'node_modules')
}

function comparablePathKey(value: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const unquoted = value.trim().replace(/^"(.*)"$/, '$1')
  let normalized = pathApi.normalize(unquoted)
  while (normalized.length > 1 && /[\\/]$/.test(normalized) && !/^[a-zA-Z]:[\\/]$/.test(normalized)) {
    normalized = normalized.slice(0, -1)
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function isDirectoryOnPath(
  directory: string,
  pathValue: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const wanted = comparablePathKey(directory, platform)
  return pathValue
    .split(platform === 'win32' ? ';' : ':')
    .some((entry) => entry.trim() !== '' && comparablePathKey(entry, platform) === wanted)
}

export interface ResolveSameUserNpmPrefixOptions {
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homedir?: () => string
  readFile?: (filePath: string) => Promise<string>
}

export interface SameUserNpmPrefix {
  prefix: string
  userConfigPath: string
}

async function readUserNpmrc(filePath: string): Promise<string> {
  return readBoundedUtf8File(filePath, maximumUserNpmrcBytes, 'npm 用户配置')
}

/**
 * The global prefix the user chose in their own npm config, for a same-user
 * install that otherwise runs with an empty `--userconfig`. Returns null
 * whenever passing `--prefix` would not reproduce what the user's own
 * `npm install -g` does:
 *
 * - `npm_config_prefix` is set: npm already honours the environment over the
 *   user config, and an explicit `--prefix` would override it instead.
 * - the file is missing, unreadable, oversized, or reached through a link: the
 *   bounded reader refuses those, and the install keeps its old destination.
 * - the prefix's command directory is not on PATH: the user cannot run what
 *   npm puts there, and the post-install check finds CLIs through PATH, so
 *   honouring it would turn a working install into a failed one.
 *
 * Never call this for an elevated install: the file is user-writable and must
 * not steer where an administrator-token npm writes.
 */
export async function resolveSameUserNpmPrefix(
  options: ResolveSameUserNpmPrefixOptions,
): Promise<SameUserNpmPrefix | null> {
  const platform = options.platform ?? process.platform
  const { env } = options
  if (npmConfigEnvironmentValue(env, 'prefix')) return null
  const home = resolveNpmHomeDirectory(env, platform, options.homedir)
  const context = { env, home, platform }
  const userConfigPath = resolveUserNpmrcPath(context)
  if (!userConfigPath) return null
  let text: string
  try {
    text = await (options.readFile ?? readUserNpmrc)(userConfigPath)
  } catch {
    return null
  }
  const raw = parseNpmrcTopLevelString(text, 'prefix')
  if (raw === null) return null
  const prefix = resolveNpmPathConfigValue(raw, context)
  if (!prefix) return null
  const pathValue = environmentValue(env, 'PATH', platform) ?? ''
  if (!isDirectoryOnPath(npmPrefixBinDirectory(prefix, platform), pathValue, platform)) return null
  return { prefix, userConfigPath }
}
