import { describe, expect, it } from 'vitest'
import { platformCapabilitiesFor } from './platform-capabilities'

describe('platformCapabilitiesFor', () => {
  it('returns the exact managed Windows policy', () => {
    expect(platformCapabilitiesFor('win32', 'x64')).toEqual({
      platform: 'windows',
      architecture: 'x64',
      isMac: false,
      nodeRuntimeInstall: 'managed',
      cliInstall: {
        claude: 'managed',
        codex: 'managed',
        gemini: 'managed',
        grok: 'managed',
      },
      codexDesktop: {
        install: 'managed',
        launch: true,
        uninstall: true,
        windowsStore: true,
      },
    })
  })

  it('returns the exact managed macOS policy', () => {
    const capabilities = platformCapabilitiesFor('darwin', 'arm64')

    expect(capabilities).toEqual({
      platform: 'macos',
      architecture: 'arm64',
      isMac: true,
      nodeRuntimeInstall: 'external',
      cliInstall: {
        claude: 'managed',
        codex: 'managed',
        gemini: 'managed',
        grok: 'managed',
      },
      codexDesktop: {
        install: 'external',
        launch: true,
        uninstall: false,
        windowsStore: false,
      },
    })
    expect(Object.isFrozen(capabilities)).toBe(true)
    expect(Object.isFrozen(capabilities.cliInstall)).toBe(true)
    expect(Object.isFrozen(capabilities.codexDesktop)).toBe(true)
  })

  it('returns the exact externally managed Linux policy', () => {
    expect(platformCapabilitiesFor('linux', 'x64')).toEqual({
      platform: 'linux',
      architecture: 'x64',
      isMac: false,
      nodeRuntimeInstall: 'external',
      cliInstall: {
        claude: 'managed',
        codex: 'managed',
        gemini: 'managed',
        grok: 'external',
      },
      codexDesktop: {
        install: 'external',
        launch: false,
        uninstall: false,
        windowsStore: false,
      },
    })
  })

  it('normalizes an unknown Node platform to the fail-closed Linux policy', () => {
    expect(platformCapabilitiesFor('plan9', 'riscv64')).toEqual({
      platform: 'linux',
      architecture: 'riscv64',
      isMac: false,
      nodeRuntimeInstall: 'external',
      cliInstall: {
        claude: 'managed',
        codex: 'managed',
        gemini: 'managed',
        grok: 'external',
      },
      codexDesktop: {
        install: 'external',
        launch: false,
        uninstall: false,
        windowsStore: false,
      },
    })
  })
})
