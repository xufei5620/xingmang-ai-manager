import { describe, expect, it } from 'vitest'
import { platformCapabilitiesFor } from './platform-capabilities'

describe('platformCapabilitiesFor', () => {
  it('returns the exact managed Windows policy', () => {
    expect(platformCapabilitiesFor('win32', 'x64')).toEqual({
      platform: 'windows',
      architecture: 'x64',
      isMac: false,
      nodeRuntimeInstall: 'managed',
      pythonRuntimeInstall: 'managed',
      cliInstall: {
        claude: 'managed',
        codex: 'managed',
        gemini: 'managed',
        grok: 'managed',
      },
      cliNeedsNodeRuntime: {
        claude: true,
        codex: true,
        gemini: true,
        grok: false,
      },
      acceleration: true,
      cliNeedsPythonRuntime: {
        claude: false,
        codex: false,
        gemini: true,
        grok: false,
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
      nodeRuntimeInstall: 'managed',
      pythonRuntimeInstall: 'external',
      cliInstall: {
        claude: 'managed',
        codex: 'managed',
        gemini: 'managed',
        grok: 'managed',
      },
      cliNeedsNodeRuntime: {
        claude: true,
        codex: true,
        gemini: true,
        grok: true,
      },
      acceleration: true,
      cliNeedsPythonRuntime: {
        claude: false,
        codex: false,
        gemini: true,
        grok: false,
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

  it('returns the exact Linux policy, with Node.js prepared by the app, Grok from npm and no Python for Gemini', () => {
    expect(platformCapabilitiesFor('linux', 'x64')).toEqual({
      platform: 'linux',
      architecture: 'x64',
      isMac: false,
      nodeRuntimeInstall: 'managed',
      pythonRuntimeInstall: 'external',
      cliInstall: {
        claude: 'managed',
        codex: 'managed',
        gemini: 'managed',
        grok: 'managed',
      },
      cliNeedsNodeRuntime: {
        claude: true,
        codex: true,
        gemini: true,
        grok: true,
      },
      acceleration: false,
      cliNeedsPythonRuntime: {
        claude: false,
        codex: false,
        gemini: false,
        grok: false,
      },
      codexDesktop: {
        install: 'external',
        launch: false,
        uninstall: false,
        windowsStore: false,
      },
    })
  })

  it('normalizes an unknown Node platform to the Linux policy', () => {
    expect(platformCapabilitiesFor('plan9', 'riscv64')).toEqual({
      platform: 'linux',
      architecture: 'riscv64',
      isMac: false,
      // The installer itself refuses chips Node.js has no official build for
      // (linux-node-runtime.ts), with a sentence that says so.
      nodeRuntimeInstall: 'managed',
      pythonRuntimeInstall: 'external',
      cliInstall: {
        claude: 'managed',
        codex: 'managed',
        gemini: 'managed',
        grok: 'managed',
      },
      cliNeedsNodeRuntime: {
        claude: true,
        codex: true,
        gemini: true,
        grok: true,
      },
      acceleration: false,
      cliNeedsPythonRuntime: {
        claude: false,
        codex: false,
        gemini: false,
        grok: false,
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
