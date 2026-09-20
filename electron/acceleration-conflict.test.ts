import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  createAccelerationConflictDetector, detectMacosProxyConflicts, detectVirtualAdapterConflicts,
  detectWindowsProxyConflicts, parseMacosProxyState,
} from './acceleration-conflict'

function windowsReading(overrides: {
  flags?: number
  autoConfigUrl?: string
  ProxyEnable?: number | null
  AutoConfigURL?: string | null
} = {}) {
  return {
    flags: overrides.flags ?? 1,
    autoConfigUrl: overrides.autoConfigUrl ?? '',
    registry: {
      ProxyEnable: overrides.ProxyEnable ?? 0,
      AutoConfigURL: overrides.AutoConfigURL ?? null,
    },
  }
}

function address(overrides: Partial<os.NetworkInterfaceInfo> = {}): os.NetworkInterfaceInfo {
  return {
    address: '10.6.0.2', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00',
    internal: false, cidr: '10.6.0.2/24', ...overrides,
  } as os.NetworkInterfaceInfo
}

describe('windows system proxy conflict detection', () => {
  it('reports nothing on a machine with a direct connection', () => {
    expect(detectWindowsProxyConflicts(windowsReading())).toEqual([])
  })

  it('reports a proxy set through either WinInet flags or the registry value', () => {
    expect(detectWindowsProxyConflicts(windowsReading({ flags: 3 }))).toEqual(['system-proxy'])
    expect(detectWindowsProxyConflicts(windowsReading({ ProxyEnable: 1 }))).toEqual(['system-proxy'])
  })

  it('reports a PAC script separately from a manual proxy', () => {
    expect(detectWindowsProxyConflicts(windowsReading({ flags: 5 }))).toEqual(['proxy-auto-config'])
    expect(detectWindowsProxyConflicts(windowsReading({ AutoConfigURL: 'http://pac.example/proxy.pac' }))).toEqual(['proxy-auto-config'])
    expect(detectWindowsProxyConflicts(windowsReading({ flags: 7, ProxyEnable: 1 }))).toEqual(['system-proxy', 'proxy-auto-config'])
  })

  it('treats WPAD auto-detect alone as no conflict, because Windows ships it on', () => {
    expect(detectWindowsProxyConflicts(windowsReading({ flags: 9 }))).toEqual([])
  })

  it('falls back to no proxy when the flags field is not an integer', () => {
    expect(detectWindowsProxyConflicts(windowsReading({ flags: Number.NaN }))).toEqual([])
  })
})

describe('macOS system proxy conflict detection', () => {
  const activeProxy = [
    '<dictionary> {',
    '  ExceptionsList : <array> {',
    '    0 : *.local',
    '  }',
    '  HTTPEnable : 1',
    '  HTTPPort : 7890',
    '  HTTPProxy : 127.0.0.1',
    '  HTTPSEnable : 1',
    '  ProxyAutoConfigEnable : 0',
    '  ProxyAutoDiscoveryEnable : 1',
    '}',
  ].join('\n')

  it('reads the enable flags and keeps the proxy address out of the result', () => {
    const reading = parseMacosProxyState(activeProxy)
    expect(reading).toEqual({ proxyEnabled: true, autoConfigEnabled: false })
    expect(JSON.stringify(reading)).not.toContain('127.0.0.1')
    expect(detectMacosProxyConflicts(reading)).toEqual(['system-proxy'])
  })

  it('reports nothing for a machine with proxy discovery on but no proxy', () => {
    const reading = parseMacosProxyState('<dictionary> {\n  ProxyAutoDiscoveryEnable : 1\n}')
    expect(reading).toEqual({ proxyEnabled: false, autoConfigEnabled: false })
    expect(detectMacosProxyConflicts(reading)).toEqual([])
  })

  it('reports a SOCKS proxy and a PAC script', () => {
    expect(detectMacosProxyConflicts(parseMacosProxyState('  SOCKSEnable : 1'))).toEqual(['system-proxy'])
    expect(detectMacosProxyConflicts(parseMacosProxyState('  ProxyAutoConfigEnable : 1'))).toEqual(['proxy-auto-config'])
  })

  it('reads nothing out of output that is not a dictionary', () => {
    expect(parseMacosProxyState('')).toEqual({ proxyEnabled: false, autoConfigEnabled: false })
    expect(parseMacosProxyState('No proxy settings')).toEqual({ proxyEnabled: false, autoConfigEnabled: false })
  })
})

describe('virtual adapter detection', () => {
  it('recognises the adapter names VPN and tunnel clients install on Windows', () => {
    for (const name of ['Wintun Userspace Tunnel', 'TAP-Windows Adapter V9', 'WireGuard Tunnel', 'Clash', 'Tailscale']) {
      expect(detectVirtualAdapterConflicts({ [name]: [address()] }, 'win32')).toEqual(['virtual-adapter'])
    }
  })

  it('leaves Windows own pseudo interfaces alone', () => {
    const interfaces = {
      '以太网': [address({ address: '192.168.1.8' })],
      'Teredo Tunneling Pseudo-Interface': [address({ address: '2001:0:1::2', family: 'IPv6' })],
      'Loopback Pseudo-Interface 1': [address({ address: '127.0.0.1', internal: true })],
    }
    expect(detectVirtualAdapterConflicts(interfaces, 'win32')).toEqual([])
  })

  it('ignores an adapter that is installed but carries no address', () => {
    expect(detectVirtualAdapterConflicts({ 'WireGuard Tunnel': [], 'OpenVPN TAP': undefined }, 'win32')).toEqual([])
  })

  it('reports nothing on macOS, where utun says nothing about VPNs', () => {
    const interfaces = { utun0: [address({ address: '10.9.0.1' })], utun3: [address({ address: '10.9.0.2' })] }
    expect(detectVirtualAdapterConflicts(interfaces, 'darwin')).toEqual([])
  })
})

describe('acceleration conflict detector', () => {
  it('combines the Windows proxy reading with the adapter scan in a stable order', async () => {
    const detector = createAccelerationConflictDetector({
      platform: 'win32',
      inspectWindowsProxy: async () => windowsReading({ ProxyEnable: 1 }),
      networkInterfaces: () => ({ 'Wintun Userspace Tunnel': [address()] }),
    })
    expect(await detector.read()).toEqual(['system-proxy', 'virtual-adapter'])
  })

  it('reads the macOS proxy state through scutil output only', async () => {
    const readMacosProxyState = vi.fn(async () => '  HTTPSEnable : 1')
    const detector = createAccelerationConflictDetector({
      platform: 'darwin', readMacosProxyState, networkInterfaces: () => ({ utun0: [address()] }),
    })
    expect(await detector.read()).toEqual(['system-proxy'])
    expect(readMacosProxyState).toHaveBeenCalledTimes(1)
  })

  it('never throws, and reports nothing when neither reader can answer', async () => {
    const detector = createAccelerationConflictDetector({
      platform: 'darwin',
      readMacosProxyState: async () => { throw new Error('scutil missing') },
      networkInterfaces: () => { throw new Error('enumeration failed') },
    })
    await expect(detector.read()).resolves.toEqual([])
  })

  it('still scans adapters when the proxy reading fails', async () => {
    const detector = createAccelerationConflictDetector({
      platform: 'win32',
      inspectWindowsProxy: async () => { throw new Error('powershell unavailable') },
      networkInterfaces: () => ({ 'OpenVPN TAP-Windows6': [address()] }),
    })
    expect(await detector.read()).toEqual(['virtual-adapter'])
  })

  it('reports nothing on a host that gave it no way to read the proxy', async () => {
    const detector = createAccelerationConflictDetector({ platform: 'win32', networkInterfaces: () => ({}) })
    expect(await detector.read()).toEqual([])
  })
})
