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

function isPathWithinRoot(candidate: string, rendererRoot: string): boolean {
  const pathApi = isWindowsPath(rendererRoot) ? path.win32 : path
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
    const resolved = path.resolve(rendererRoot, relativePath)
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

const blockedPackagedDebugSwitches = new Set([
  '--inspect',
  '--inspect-brk',
  '--remote-debugging-port',
  '--remote-debugging-pipe',
])

export function hasDisallowedPackagedDebugSwitch(argv: readonly string[]): boolean {
  return argv.some((argument) => {
    if (typeof argument !== 'string') return false
    const switchName = argument.split('=', 1)[0].toLowerCase()
    return blockedPackagedDebugSwitches.has(switchName)
  })
}
