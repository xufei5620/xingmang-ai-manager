/**
 * CLI installation used to ignore every proxy on the machine: the artifact
 * downloads ran on Node's own network stack and npm ran with no proxy
 * variables, so neither followed the system proxy. Turning acceleration on
 * therefore did nothing for the one thing it exists to fix -- the download.
 *
 * Chromium already resolves the effective proxy for a URL, including PAC
 * scripts and per-scheme overrides. This module turns that answer into the two
 * shapes the installers need: an endpoint the desktop host can hand to
 * Electron's network stack, and the environment variables a package manager
 * subprocess understands.
 */

export interface DownloadProxyEndpoint {
  scheme: 'http' | 'https' | 'socks5'
  host: string
  port: number
}

const proxySchemes = new Map<string, DownloadProxyEndpoint['scheme']>([
  ['PROXY', 'http'],
  ['HTTPS', 'https'],
  ['SOCKS', 'socks5'],
  ['SOCKS4', 'socks5'],
  ['SOCKS5', 'socks5'],
])

/** Loopback keeps every proxied subprocess inside this machine; see below. */
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

const maximumProxyResultLength = 2048

function isAcceptableProxyHost(host: string): boolean {
  if (!host || host.length > 255) return false
  if (host.startsWith('[')) return /^\[[0-9A-Fa-f:.]{2,45}\]$/.test(host)
  // A credential, path or query in the authority means this is not the plain
  // `host:port` Chromium documents, and guessing at it could send traffic
  // somewhere else entirely.
  return /^[A-Za-z0-9](?:[A-Za-z0-9.\-]{0,253}[A-Za-z0-9])?$/.test(host)
}

/**
 * Parses one Chromium `resolveProxy` result, for example
 * `PROXY 127.0.0.1:7890;DIRECT`. Only the first entry can be used: it is the
 * route Chromium itself would take, and the later fallbacks only apply after a
 * connection failure this process cannot observe. Anything unrecognized fails
 * closed to a direct connection, which is the behavior that existed before.
 */
export function parseChromiumProxyResult(value: unknown): DownloadProxyEndpoint | null {
  if (typeof value !== 'string' || value.length > maximumProxyResultLength) return null
  const entry = value.split(';', 1)[0].trim()
  if (!entry) return null
  const separator = entry.search(/\s/)
  if (separator < 0) return null
  const scheme = proxySchemes.get(entry.slice(0, separator).toUpperCase())
  if (!scheme) return null
  const authority = entry.slice(separator).trim()
  const portSeparator = authority.lastIndexOf(':')
  if (portSeparator <= 0) return null
  const host = authority.slice(0, portSeparator)
  const portText = authority.slice(portSeparator + 1)
  if (!/^\d{1,5}$/.test(portText)) return null
  const port = Number(portText)
  if (port < 1 || port > 65_535 || !isAcceptableProxyHost(host)) return null
  return { scheme, host, port }
}

export function formatDownloadProxyUrl(endpoint: DownloadProxyEndpoint): string {
  return `${endpoint.scheme}://${endpoint.host}:${endpoint.port}`
}

export function isLoopbackDownloadProxy(endpoint: DownloadProxyEndpoint): boolean {
  const host = endpoint.host.toLowerCase()
  return loopbackHosts.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * Proxy variables for a package-manager subprocess.
 *
 * The Windows install path runs npm across the elevation boundary, and the
 * system proxy is a per-user setting an unprivileged process can rewrite.
 * Handing an elevated npm an arbitrary remote proxy would let that setting
 * choose where the packages come from, so only a loopback proxy -- which is
 * what this application's own acceleration core installs, and which already
 * requires code running as this user -- is passed down. A remote system proxy
 * still applies to the in-process downloads, where Chromium terminates the
 * connection inside this process and every artifact is signature-verified.
 *
 * NO_PROXY keeps loopback traffic, including the acceleration core's own
 * controller, off the proxy it would otherwise be asked to relay to itself.
 */
export function subprocessDownloadProxyEnvironment(
  endpoint: DownloadProxyEndpoint | null,
): NodeJS.ProcessEnv {
  if (!endpoint || !isLoopbackDownloadProxy(endpoint)) return {}
  const url = formatDownloadProxyUrl(endpoint)
  const bypass = 'localhost,127.0.0.1,::1'
  return {
    HTTP_PROXY: url,
    http_proxy: url,
    HTTPS_PROXY: url,
    https_proxy: url,
    NO_PROXY: bypass,
    no_proxy: bypass,
  }
}
