import { platformCapabilitiesFor } from '../platform-capabilities'
import { platformUiRegistryFor } from './registry'
import type { PlatformCapabilityFacade, PlatformNativeCapabilities } from './types'

const failClosedNative: PlatformNativeCapabilities = Object.freeze({
  tray: false,
  notifications: false,
  safeStorage: false,
  deepLinks: false,
  startup: false,
})

function nativeCapabilities(input: Partial<PlatformNativeCapabilities> | undefined): PlatformNativeCapabilities {
  return Object.freeze({
    tray: input?.tray === true,
    notifications: input?.notifications === true,
    safeStorage: input?.safeStorage === true,
    deepLinks: input?.deepLinks === true,
    startup: input?.startup === true,
  })
}

/**
 * Creates the read-only platform snapshot consumed by the v2 adapter. The
 * caller supplies platform and native probes so renderer code never reads
 * process.platform or infers an OS feature from a user-agent string.
 */
export function platformFacadeFor(
  platform: string,
  architecture: string,
  native: Partial<PlatformNativeCapabilities> = failClosedNative,
): PlatformCapabilityFacade {
  const capabilities = platformCapabilitiesFor(platform, architecture)
  return Object.freeze({
    ...capabilities,
    native: nativeCapabilities(native),
    ui: platformUiRegistryFor(capabilities.platform),
  })
}
