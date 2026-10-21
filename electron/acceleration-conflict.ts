import { isIP } from 'node:net'
import os from 'node:os'
import { runCommand, trustedCommandEnvironment } from './command-runner'
import { accelerationConflictKinds, type AccelerationConflictKind } from './acceleration-contract'

/**
 * Acceleration takes over nothing but the OS proxy setting (`tun.enable` is
 * false in every generated core configuration), so a second program holding
 * that setting silently wins or loses depending on who wrote it last. The
 * checks below run before a connect and are read-only on purpose: the answer
 * belongs to the user, who is the only one who knows which of the two they
 * actually want.
 */

/** The Windows side of a reading, shaped so a `WindowsProxySnapshot` fits. */
export interface WindowsProxyReading {
  flags: number
  autoConfigUrl: string
  registry: { ProxyEnable: number | null; AutoConfigURL: string | null }
}

/** What `scutil --proxy` says, reduced to the two questions that matter. */
export interface MacosProxyReading {
  proxyEnabled: boolean
  autoConfigEnabled: boolean
}

const scutilExecutable = '/usr/sbin/scutil'
const maximumProxyOutputBytes = 64 * 1024
const routeExecutable = '/sbin/route'
const maximumRouteOutputBytes = 16 * 1024
// A profile holds a handful of lines; asking about more than this only slows a connect.
const maximumRouteChecks = 4

// WinInet PROXY_TYPE flags. AUTO_DETECT (8) is left out deliberately: Windows
// ships it on by default, so treating it as a conflict would warn every user.
const proxyTypeProxy = 2
const proxyTypeAutoConfigUrl = 4

/**
 * Adapter names an installed VPN or tunnel client gives its virtual interface
 * on Windows. Matched against the friendly name, never a substring like `tun`
 * or `tunnel` on its own: Windows' own "Teredo Tunneling Pseudo-Interface"
 * would match those on a machine with no VPN at all.
 */
const virtualAdapterPattern = /wintun|tap-?win(?:dows|32|64)?|openvpn|wireguard|zerotier|tailscale|clash|mihomo|sing-?box|v2ray|shadowsocks|proxifier|netch|softether|easyconnect|虚拟网卡/i

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * A system proxy is only ever ours while we hold the lease, and every start
 * path restores a leftover lease before reaching here. Anything still set at
 * this point therefore belongs to another program.
 */
export function detectWindowsProxyConflicts(reading: WindowsProxyReading): AccelerationConflictKind[] {
  const conflicts: AccelerationConflictKind[] = []
  const flags = Number.isInteger(reading.flags) ? reading.flags : 0
  if ((flags & proxyTypeProxy) !== 0 || reading.registry.ProxyEnable === 1) conflicts.push('system-proxy')
  if ((flags & proxyTypeAutoConfigUrl) !== 0 || nonEmpty(reading.autoConfigUrl) || nonEmpty(reading.registry.AutoConfigURL)) {
    conflicts.push('proxy-auto-config')
  }
  return conflicts
}

/**
 * `scutil --proxy` prints one `Key : value` pair per line inside a dictionary
 * block. Only the enable flags are read; the host and port are deliberately
 * left on the floor so no proxy address can reach the log or the screen.
 */
export function parseMacosProxyState(output: string): MacosProxyReading {
  const values = new Map<string, string>()
  for (const line of output.split('\n', 256)) {
    const match = /^\s*([A-Za-z]{1,64})\s*:\s*(\S{0,64})/.exec(line)
    if (match) values.set(match[1], match[2])
  }
  const enabled = (key: string) => values.get(key) === '1'
  return {
    proxyEnabled: enabled('HTTPEnable') || enabled('HTTPSEnable') || enabled('SOCKSEnable'),
    // ProxyAutoDiscoveryEnable (WPAD) is not read: like Windows' AUTO_DETECT it
    // is commonly on without any proxy behind it.
    autoConfigEnabled: enabled('ProxyAutoConfigEnable'),
  }
}

export function detectMacosProxyConflicts(reading: MacosProxyReading): AccelerationConflictKind[] {
  const conflicts: AccelerationConflictKind[] = []
  if (reading.proxyEnabled) conflicts.push('system-proxy')
  if (reading.autoConfigEnabled) conflicts.push('proxy-auto-config')
  return conflicts
}

/**
 * Windows only. macOS names every tunnel `utunN` no matter who created it, and
 * iCloud Private Relay, Handoff and personal hotspot all create one on a
 * machine with no VPN, so the name carries no signal there. Reporting nothing
 * beats reporting a warning the user cannot act on.
 */
export function detectVirtualAdapterConflicts(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
  platform: NodeJS.Platform,
): AccelerationConflictKind[] {
  if (platform !== 'win32') return []
  for (const [name, addresses] of Object.entries(interfaces)) {
    // An adapter with no address is not carrying traffic, and loopback is ours.
    if (!addresses?.some((address) => !address.internal)) continue
    if (virtualAdapterPattern.test(name)) return ['virtual-adapter']
  }
  return []
}

/**
 * `route -n get <address>` prints the interface the kernel would send a packet
 * to that address out of, without sending one. Only that name is kept.
 */
export function parseMacosRouteInterface(output: string): string | null {
  for (const line of output.split('\n', 64)) {
    const match = /^\s*interface:\s*([A-Za-z0-9]{1,32})\s*$/.exec(line)
    if (match) return match[1]
  }
  return null
}

/**
 * macOS. Where the interface list says nothing (see above), the route to the
 * line server does: when a VPN or a proxy in TUN mode has taken it over, it
 * leaves through a utun (or a ppp/ipsec link), and the line's UDP has to get
 * through that tunnel first. On 2026-10-21 that timed out on the owner's Mac
 * while the same process bound to Wi-Fi connected. Only the route is read;
 * the user's VPN and routing table are left exactly as they are.
 */
export function detectMacosTunnelRoute(interfaceName: string | null): AccelerationConflictKind[] {
  return interfaceName && /^(?:utun|ppp|ipsec)\d{1,4}$/.test(interfaceName) ? ['virtual-adapter'] : []
}

export interface AccelerationConflictDetectorOptions {
  platform?: NodeJS.Platform
  /** Windows: reads the live WinInet/registry proxy state. */
  inspectWindowsProxy?: () => Promise<WindowsProxyReading>
  /** macOS: raw `scutil --proxy` output. */
  readMacosProxyState?: () => Promise<string>
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>
  /** macOS: the line servers' addresses. Only IP literals are asked about, so the check never resolves a name. */
  lineAddresses?: () => Promise<readonly string[]>
  /** macOS: raw `route -n get <address>` output. */
  readMacosRoute?: (address: string) => Promise<string>
}

async function readMacosProxyState(): Promise<string> {
  const result = await runCommand({ executable: scutilExecutable, argv: ['--proxy'] }, {
    env: trustedCommandEnvironment(), timeoutMs: 10_000, maxOutputBytes: maximumProxyOutputBytes, windowsHide: true,
  })
  return result.stdout
}

async function readMacosRoute(address: string): Promise<string> {
  // The address is an IP literal by the time it gets here, so it can never read as an option.
  const result = await runCommand({ executable: routeExecutable, argv: ['-n', 'get', address] }, {
    env: trustedCommandEnvironment(), timeoutMs: 10_000, maxOutputBytes: maximumRouteOutputBytes, windowsHide: true,
  })
  return result.stdout
}

async function detectMacosLineRoutes(
  lineAddresses: () => Promise<readonly string[]>,
  readRoute: (address: string) => Promise<string>,
): Promise<AccelerationConflictKind[]> {
  const addresses = [...new Set((await lineAddresses()).filter((address) => typeof address === 'string' && isIP(address) !== 0))]
  for (const address of addresses.slice(0, maximumRouteChecks)) {
    try {
      const conflicts = detectMacosTunnelRoute(parseMacosRouteInterface(await readRoute(address)))
      if (conflicts.length) return conflicts
    } catch { /* No route to read is no evidence of a tunnel. */ }
  }
  return []
}

function orderConflicts(conflicts: AccelerationConflictKind[]): AccelerationConflictKind[] {
  return accelerationConflictKinds.filter((kind) => conflicts.includes(kind))
}

/**
 * Never throws and never blocks a connect: a machine this cannot read is a
 * machine that behaves exactly as it did before this check existed.
 */
export function createAccelerationConflictDetector(options: AccelerationConflictDetectorOptions = {}): {
  read(): Promise<AccelerationConflictKind[]>
} {
  const platform = options.platform ?? process.platform
  const listInterfaces = options.networkInterfaces ?? (() => os.networkInterfaces())
  const readMacos = options.readMacosProxyState ?? readMacosProxyState
  const readRoute = options.readMacosRoute ?? readMacosRoute
  return {
    async read() {
      const conflicts: AccelerationConflictKind[] = []
      try {
        if (platform === 'darwin') conflicts.push(...detectMacosProxyConflicts(parseMacosProxyState(await readMacos())))
        else if (options.inspectWindowsProxy) conflicts.push(...detectWindowsProxyConflicts(await options.inspectWindowsProxy()))
      } catch { /* An unreadable proxy setting must not stop the user connecting. */ }
      try { conflicts.push(...detectVirtualAdapterConflicts(listInterfaces(), platform)) }
      catch { /* Same: adapter enumeration is a hint, not a gate. */ }
      if (platform === 'darwin' && options.lineAddresses) {
        try { conflicts.push(...await detectMacosLineRoutes(options.lineAddresses, readRoute)) }
        catch { /* Same: an unreadable profile or route is a hint missed, not a gate. */ }
      }
      return orderConflicts(conflicts)
    },
  }
}
