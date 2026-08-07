import type { ProviderId } from './catalog'

export type PlatformFamily = 'windows' | 'macos' | 'linux'
export type InstallManagement = 'managed' | 'external'

export interface PlatformCapabilities {
  readonly platform: PlatformFamily
  readonly architecture: string
  readonly isMac: boolean
  readonly nodeRuntimeInstall: InstallManagement
  readonly cliInstall: Readonly<Record<ProviderId, InstallManagement>>
  readonly codexDesktop: Readonly<{
    install: InstallManagement
    launch: boolean
    uninstall: boolean
    windowsStore: boolean
  }>
  readonly nativeMenu: boolean
  readonly trafficLightInset: number
}

function platformFamily(platform: string): PlatformFamily {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return 'linux'
}

export function platformCapabilitiesFor(
  platform: string = process.platform,
  architecture: string = process.arch,
): PlatformCapabilities {
  const family = platformFamily(platform)
  const windows = family === 'windows'
  const macos = family === 'macos'
  return Object.freeze({
    platform: family,
    architecture,
    isMac: macos,
    nodeRuntimeInstall: windows ? 'managed' : 'external',
    cliInstall: Object.freeze({
      claude: 'managed',
      codex: 'managed',
      gemini: 'managed',
      grok: windows || macos ? 'managed' : 'external',
    }),
    codexDesktop: Object.freeze({
      install: windows ? 'managed' : 'external',
      launch: windows || macos,
      uninstall: windows,
      windowsStore: windows,
    }),
    nativeMenu: !windows,
    trafficLightInset: macos ? 78 : 0,
  })
}
