import { describe, expect, it } from 'vitest'
import { platformFacadeFor } from './facade'
import { PLATFORM_UI_REGISTRY, platformUiRegistryFor } from './registry'
import { calculatePlatformZoom } from './zoom'

describe('platform facade', () => {
  it('projects platform and native probes without reading process globals', () => {
    const facade = platformFacadeFor('darwin', 'arm64', { tray: true, notifications: true })
    expect(facade.platform).toBe('macos')
    expect(facade.architecture).toBe('arm64')
    expect(facade.native).toEqual({
      tray: true,
      notifications: true,
      safeStorage: false,
      deepLinks: false,
      startup: false,
    })
    expect(facade.ui).toEqual(PLATFORM_UI_REGISTRY.macos)
    expect(Object.isFrozen(facade)).toBe(true)
    expect(Object.isFrozen(facade.native)).toBe(true)
  })

  it('fails closed for omitted native probes and unknown operating systems', () => {
    const facade = platformFacadeFor('plan9', 'riscv64')
    expect(facade.platform).toBe('linux')
    expect(facade.native.tray).toBe(false)
    expect(facade.native.notifications).toBe(false)
    expect(facade.ui.titleBarHeightDip).toBe(36)
  })
})

describe('platform UI registry', () => {
  it('keeps platform-specific title bars, modifiers and path examples', () => {
    expect(platformUiRegistryFor('windows')).toMatchObject({ titleBarHeightDip: 36, commandModifier: 'Ctrl' })
    expect(platformUiRegistryFor('macos')).toMatchObject({ titleBarHeightDip: 46, commandModifier: '\u2318' })
    expect(platformUiRegistryFor('linux')).toMatchObject({ titleBarHeightDip: 36, commandModifier: 'Ctrl' })
    expect(Object.isFrozen(PLATFORM_UI_REGISTRY)).toBe(true)
  })
})

describe('calculatePlatformZoom', () => {
  it('follows the 1280 DIP algorithm and preference multiplier', () => {
    expect(calculatePlatformZoom(640)).toBe(0.7)
    expect(calculatePlatformZoom(1280)).toBe(1)
    expect(calculatePlatformZoom(1280, '90')).toBe(0.9)
    expect(calculatePlatformZoom(1280, '110')).toBe(1.1)
    expect(calculatePlatformZoom(4096)).toBe(1.25)
    expect(calculatePlatformZoom(4096, '110')).toBe(1.25)
  })

  it('handles invalid widths without throwing', () => {
    expect(calculatePlatformZoom(Number.NaN)).toBe(1)
    expect(calculatePlatformZoom(0)).toBe(1)
    expect(calculatePlatformZoom(-100, '90')).toBe(1)
  })
})
