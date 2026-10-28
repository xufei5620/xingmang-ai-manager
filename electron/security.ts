import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { accelerationWorkerArgument } from './acceleration-worker-entry'
import { loginLaunchArgument } from './login-launch'
import { uninstallCleanupArgument, uninstallClearLoginArgument } from './uninstall-cleanup-entry'

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
// still works; on Windows, where the elevation is, resolvePackagedLaunchArguments
// below also drops every switch it does not know. Both run after Chromium has
// parsed the command line, so a switch consumed before the main script runs (for
// example by a child process launched that early) is not undone by exiting here.
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

// Every switch something we know of starts the packaged Windows app with. Only
// Windows gets an allowlist: it is where a shortcut edit can ride an elevated
// token, while macOS never elevates this app and Linux refuses to run it as root.
// Names are compared the way Chromium reads them, so another spelling of an
// allowed name passes too; none of them is read by Chromium, Electron or Node,
// except user-data-dir.
const windowsPackagedLaunchSwitchNames = new Set([
  // The Run key entry for "open at login" (platform/system-service.ts), which the
  // unexpected-exit relaunch also adds while the window is in the tray.
  loginLaunchArgument,
  // electron-builder's StartApp after an update and the finish page's "run" box
  // (common.nsh, assistedInstaller.nsh).
  '--updated',
  // customUnInstall in build/installer.nsh.
  uninstallCleanupArgument,
  uninstallClearLoginArgument,
  // The packaged acceleration worker (acceleration-development-host.ts).
  accelerationWorkerArgument,
  // Electron registers this executable as its toast activator's COM server, and
  // Windows adds one of these when a notification click starts the app cold.
  '-Embedding',
  '-ToastActivated',
  // The acceleration worker's private profile, and the packaged smokes in CI. It
  // only moves a directory that normally sits in %APPDATA%, where the same user
  // can already write anything and which I8 already treats as hostile.
  '--user-data-dir',
].flatMap((argument) => resolveSwitchName(argument, 'win32') ?? []))

export type PackagedLaunchArguments =
  | { action: 'start' }
  | { action: 'exit' }
  | { action: 'relaunch'; args: string[]; dropped: string[] }

// A switch outside the allowlist is dropped by starting again without it rather
// than by refusing to start: a launcher we did not foresee, or a tweak someone
// once typed into a shortcut, must not leave a customer with an app that never
// opens. The relaunch keeps the process token, so an elevated launch comes back
// elevated, minus the switches. Positional arguments (the deep link) are kept.
export function resolvePackagedLaunchArguments(
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
): PackagedLaunchArguments {
  if (hasDisallowedPackagedDebugSwitch(argv, platform)) return { action: 'exit' }
  if (platform !== 'win32') return { action: 'start' }
  const args: string[] = []
  const dropped: string[] = []
  for (const argument of argv.slice(1)) {
    if (typeof argument !== 'string') continue
    const switchName = resolveSwitchName(argument, platform)
    if (switchName === null || windowsPackagedLaunchSwitchNames.has(switchName)) args.push(argument)
    else dropped.push(switchName)
  }
  if (dropped.length === 0) return { action: 'start' }
  // The uninstaller and the acceleration host start these with exact arguments
  // and hold on to this very process (one waits for its exit code, the other
  // talks to it over IPC); a relaunch would only cut the work loose from them.
  if (argv.includes(uninstallCleanupArgument) || argv.includes(accelerationWorkerArgument)) {
    return { action: 'exit' }
  }
  return { action: 'relaunch', args, dropped }
}
