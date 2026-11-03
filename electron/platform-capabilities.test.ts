import { describe, expect, it } from 'vitest'
import { accelerationInUse, platformCapabilitiesFor } from './platform-capabilities'

describe('platformCapabilitiesFor', () => {
  it('returns the exact managed Windows policy, with no Python for Gemini', () => {
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
      acceleration: false,
      automaticAcceleration: true,
      cliNeedsPythonRuntime: {
        claude: false,
        codex: false,
        gemini: false,
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

  it('returns the exact managed macOS policy, with no Python for Gemini', () => {
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
      acceleration: false,
      automaticAcceleration: true,
      cliNeedsPythonRuntime: {
        claude: false,
        codex: false,
        gemini: false,
        grok: false,
      },
      codexDesktop: {
        install: 'managed',
        launch: true,
        uninstall: false,
        windowsStore: false,
      },
    })
    expect(Object.isFrozen(capabilities)).toBe(true)
    expect(Object.isFrozen(capabilities.cliInstall)).toBe(true)
    expect(Object.isFrozen(capabilities.codexDesktop)).toBe(true)
  })

  it('installs the Codex desktop app on both Mac architectures and sends any other one to the guide', () => {
    expect(platformCapabilitiesFor('darwin', 'x64').codexDesktop.install).toBe('managed')
    expect(platformCapabilitiesFor('darwin', 'ia32').codexDesktop.install).toBe('external')
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
      automaticAcceleration: false,
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
      automaticAcceleration: false,
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

describe('accelerationInUse', () => {
  // 2026-11-03 yoyo「客户无法自己开启，作为内置完成一些必须要加速才用得到的事」：界面上没有加速，后台那几处照样要连。
  it('still uses the acceleration kernel on Windows and Mac, where the app connects in the background', () => {
    expect(accelerationInUse(platformCapabilitiesFor('win32', 'x64'))).toBe(true)
    expect(accelerationInUse(platformCapabilitiesFor('darwin', 'arm64'))).toBe(true)
  })

  it('never uses it on Linux, which ships no acceleration kernel', () => {
    expect(accelerationInUse(platformCapabilitiesFor('linux', 'x64'))).toBe(false)
  })

  it('treats a policy that shows acceleration on screen as using it, as before', () => {
    expect(accelerationInUse({})).toBe(true)
    expect(accelerationInUse({ acceleration: false })).toBe(false)
    expect(accelerationInUse({ acceleration: false, automaticAcceleration: true })).toBe(true)
  })
})
