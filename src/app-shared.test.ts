import { describe, expect, it } from 'vitest'
import { isDetectionFailed, sameDesktopStatus, shouldShowWelcome } from './app-shared'
import type { AppConfigSummary, DesktopAppStatus, ProviderConfigSummary, ProviderId } from './types'

const baseDesktopStatus: DesktopAppStatus = {
  installed: true,
  version: '1.0.0',
  path: 'OpenAI.Codex!App',
  installDirectory: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex',
  appVersion: '1.0.0',
  mirrorVersion: '1.0.0',
  mirrorUpdateAvailable: false,
  mirrorError: null,
  running: false,
}

function unconfiguredProvider(overrides: Partial<ProviderConfigSummary> = {}): ProviderConfigSummary {
  return {
    baseUrl: 'https://api.solov.cc',
    actualBaseUrl: 'https://api.solov.cc',
    exists: false,
    hasApiKey: false,
    matchesRelay: false,
    apiKeyPreview: null,
    model: '',
    dataDirectory: '',
    dataDirectoryExists: false,
    files: [],
    updatedAt: null,
    ...overrides,
  }
}

function configWith(overrides: Partial<Record<ProviderId, ProviderConfigSummary>>): AppConfigSummary {
  return {
    workspace: '',
    providers: {
      claude: unconfiguredProvider(),
      codex: unconfiguredProvider(),
      grok: unconfiguredProvider(),
      gemini: unconfiguredProvider(),
      ...overrides,
    },
  }
}

describe('isDetectionFailed', () => {
  it('is false when detectionFailed is absent, matching the pre-scan and legacy-response default', () => {
    expect(isDetectionFailed({})).toBe(false)
  })

  it('is false when a probe explicitly concluded the tool is missing', () => {
    expect(isDetectionFailed({ detectionFailed: false })).toBe(false)
  })

  it('is true only when detectionFailed is explicitly true', () => {
    expect(isDetectionFailed({ detectionFailed: true })).toBe(true)
  })
})

describe('sameDesktopStatus', () => {
  it('treats identical statuses as the same', () => {
    expect(sameDesktopStatus(baseDesktopStatus, { ...baseDesktopStatus })).toBe(true)
  })

  it('detects a transition into a detection-failed state so background polling cannot drop it', () => {
    const failed: DesktopAppStatus = {
      ...baseDesktopStatus,
      installed: false,
      detectionFailed: true,
      detectionError: 'PowerShell 启动失败',
    }
    expect(sameDesktopStatus(baseDesktopStatus, failed)).toBe(false)
  })

  it('detects a change in the detection error message alone', () => {
    const first: DesktopAppStatus = { ...baseDesktopStatus, detectionFailed: true, detectionError: '超时' }
    const second: DesktopAppStatus = { ...baseDesktopStatus, detectionFailed: true, detectionError: '拒绝访问' }
    expect(sameDesktopStatus(first, second)).toBe(false)
  })
})

describe('shouldShowWelcome', () => {
  it('does not show the welcome page while config is still unknown, preserving the pre-existing startup flow', () => {
    expect(shouldShowWelcome(null)).toBe(false)
  })

  it('shows the welcome page for a brand-new install with no provider configured', () => {
    expect(shouldShowWelcome(configWith({}))).toBe(true)
  })

  it('skips the welcome page for a returning user who configured a different provider than the one being onboarded', () => {
    const config = configWith({ claude: unconfiguredProvider({ hasApiKey: true, matchesRelay: true }) })
    expect(shouldShowWelcome(config)).toBe(false)
  })

  it('skips the welcome page once the gated provider itself is configured', () => {
    const config = configWith({ codex: unconfiguredProvider({ hasApiKey: true, matchesRelay: true }) })
    expect(shouldShowWelcome(config)).toBe(false)
  })

  it('still shows the welcome page when a key exists but points at a non-xingmang relay', () => {
    const config = configWith({ codex: unconfiguredProvider({ hasApiKey: true, matchesRelay: false }) })
    expect(shouldShowWelcome(config)).toBe(true)
  })
})
