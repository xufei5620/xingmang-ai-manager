import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ApplicationUrlPolicy {
  rendererRoot: string
  devServerUrl?: string | null
  packagedBaseUrl?: string | null
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isHttpUrl(url: URL): boolean {
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && url.username === ''
    && url.password === ''
}

function isWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value)
}

function windowsFileUrlToPath(url: URL): string | null {
  if (url.hostname !== '') return null
  if (/%2f|%5c/i.test(url.pathname)) return null

  try {
    const decoded = decodeURIComponent(url.pathname)
    if (decoded.includes('\0') || !/^\/[a-z]:\//i.test(decoded)) return null
    return decoded.slice(1).replaceAll('/', '\\')
  } catch {
    return null
  }
}

function localFileUrlToPath(url: URL, rendererRoot: string): string | null {
  if (url.protocol !== 'file:' || url.username !== '' || url.password !== '') return null

  if (isWindowsPath(rendererRoot)) {
    return windowsFileUrlToPath(url)
  }

  if (url.hostname !== '' || /%2f|%5c/i.test(url.pathname)) return null
  try {
    const result = fileURLToPath(url)
    return result.includes('\0') ? null : result
  } catch {
    return null
  }
}

// The renderer root alone decides the path semantics, never the host. Leaving
// the non-Windows branch on the default `path` made a POSIX root resolve with
// backslashes when the process happened to run on Windows, so the same policy
// object produced different answers per host and could only be tested on one.
function pathApiForRoot(rendererRoot: string): path.PlatformPath {
  return isWindowsPath(rendererRoot) ? path.win32 : path.posix
}

function isPathWithinRoot(candidate: string, rendererRoot: string): boolean {
  const pathApi = pathApiForRoot(rendererRoot)
  const root = pathApi.resolve(rendererRoot)
  const relative = pathApi.relative(root, pathApi.resolve(candidate))
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative))
}

function isAllowedDevelopmentUrl(target: URL, devServerUrl: string | null | undefined): boolean {
  if (!devServerUrl || !isHttpUrl(target)) return false

  const devServer = parseUrl(devServerUrl)
  return devServer !== null
    && isHttpUrl(devServer)
    && target.origin === devServer.origin
}

function isAllowedPackagedUrl(target: URL, rendererRoot: string): boolean {
  if (!rendererRoot.trim()) return false
  const targetPath = localFileUrlToPath(target, rendererRoot)
  return targetPath !== null && isPathWithinRoot(targetPath, rendererRoot)
}

function packagedProtocolUrlToPath(
  target: URL,
  rendererRoot: string,
  packagedBaseUrl: string | null | undefined,
): string | null {
  if (!packagedBaseUrl || target.username !== '' || target.password !== '') return null
  const baseUrl = parseUrl(packagedBaseUrl)
  if (
    !baseUrl
    || baseUrl.protocol === 'file:'
    || target.protocol !== baseUrl.protocol
    || target.hostname !== baseUrl.hostname
    || target.port !== baseUrl.port
    || /%2f|%5c/i.test(target.pathname)
  ) {
    return null
  }

  try {
    const decodedPath = decodeURIComponent(target.pathname)
    if (decodedPath.includes('\0') || decodedPath.includes('\\')) return null
    const relativePath = decodedPath.replace(/^\/+/, '') || 'index.html'
    const resolved = pathApiForRoot(rendererRoot).resolve(rendererRoot, relativePath)
    return isPathWithinRoot(resolved, rendererRoot) ? resolved : null
  } catch {
    return null
  }
}

function isAllowedApplicationUrl(rawUrl: string, policy: ApplicationUrlPolicy): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false
  const target = parseUrl(rawUrl)
  if (!target) return false

  return isAllowedDevelopmentUrl(target, policy.devServerUrl)
    || isAllowedPackagedUrl(target, policy.rendererRoot)
    || packagedProtocolUrlToPath(target, policy.rendererRoot, policy.packagedBaseUrl) !== null
}

export function resolvePackagedApplicationFile(
  rawUrl: string,
  policy: ApplicationUrlPolicy,
): string | null {
  const target = parseUrl(rawUrl)
  if (!target) return null
  return packagedProtocolUrlToPath(target, policy.rendererRoot, policy.packagedBaseUrl)
}

export function isTrustedIpcSenderUrl(senderUrl: string, policy: ApplicationUrlPolicy): boolean {
  return isAllowedApplicationUrl(senderUrl, policy)
}

export function isAllowedAppNavigationUrl(targetUrl: string, policy: ApplicationUrlPolicy): boolean {
  return isAllowedApplicationUrl(targetUrl, policy)
}

export function isAllowedExternalUrl(targetUrl: string, allowlist: readonly string[]): boolean {
  if (typeof targetUrl !== 'string' || targetUrl.length === 0) return false
  const target = parseUrl(targetUrl)
  if (
    !target
    || !['https:', 'ms-windows-store:'].includes(target.protocol)
    || target.username !== ''
    || target.password !== ''
  ) {
    return false
  }

  return allowlist.some((allowedUrl) => {
    const allowed = parseUrl(allowedUrl)
    return allowed !== null
      && allowed.protocol === target.protocol
      && allowed.username === ''
      && allowed.password === ''
      && target.href === allowed.href
  })
}

// Packaged builds refuse to start with a switch that opens a debugger or makes
// Chromium run a command of the caller's choosing. A same-user process can add
// arguments to a shortcut; once the user picks "Run as administrator", those
// arguments would run with the elevated token (#1065).
//
// Residual risk: this is a blocklist, so a dangerous switch missing from it
// still works, and the check runs after Chromium has parsed the command line,
// so a switch consumed before the main script runs (for example by a child
// process launched that early) is not undone by exiting here. Accepting only
// known arguments is the follow-up step in #1065.
const blockedPackagedSwitchNames = new Set([
  // Node inspector. The nodeCliInspect fuse is the first lock; this is the second.
  'inspect',
  'inspect-brk',
  'inspect-brk-node',
  'inspect-wait',
  // Chromium DevTools protocol.
  'remote-debugging-port',
  'remote-debugging-pipe',
  // Chromium runs these as, or in front of, a child process command line.
  'browser-subprocess-path',
  'gpu-launcher',
  'renderer-cmd-prefix',
  'utility-cmd-prefix',
  'zygote-cmd-prefix',
])

// Chromium trims base::kWhitespaceWide before parsing; \s covers all of it
// except U+0085.
const switchSurroundingWhitespace = /^[\s\u0085]+|[\s\u0085]+$/g

function switchPrefixes(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32' ? ['--', '-', '/'] : ['--', '-']
}

// Reads a switch name the way base/command_line.cc does: trim, take the first
// matching prefix, stop at the first "=". Chromium lowercases names only on
// Windows; lowercasing everywhere can only block more. Arguments after a bare
// "--" are still checked even though Chromium stops reading switches there.
function resolveSwitchName(argument: string, platform: NodeJS.Platform): string | null {
  const trimmed = argument.replace(switchSurroundingWhitespace, '')
  const prefix = switchPrefixes(platform).find((candidate) => trimmed.startsWith(candidate))
  if (!prefix) return null
  return trimmed.slice(prefix.length).split('=', 1)[0].toLowerCase()
}

export function hasDisallowedPackagedDebugSwitch(
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  return argv.some((argument) => {
    if (typeof argument !== 'string') return false
    const switchName = resolveSwitchName(argument, platform)
    return switchName !== null && blockedPackagedSwitchNames.has(switchName)
  })
}
