import { describe, expect, it, vi } from 'vitest'
import {
  codexSetupReadyForDashboard,
  initialOnboardingPreview,
  managedBootstrapCompleted,
  markManagedBootstrapCompleted,
  isDetectionFailed,
  resolveInitialAppView,
  sameDesktopStatus,
} from './app-shared'
import { platformCapabilitiesFor } from '../electron/platform-capabilities'
import type { CodexSetupStatus, ToolStatus } from './types'

function setupTool(installed: boolean): ToolStatus {
  return {
    installed,
    version: installed ? 'test-version' : null,
    path: installed ? 'C:\\Program Files\\tool.exe' : null,
    installDirectory: installed ? 'C:\\Program Files' : null,
    ...(installed ? { versionStatus: 'supported' as const } : {}),
  }
}

function resumableSetupStatus(options: { node?: boolean; npm?: boolean; cli?: boolean; desktop?: boolean } = {}): CodexSetupStatus {
  const { node = true, npm = true, cli = true, desktop = true } = options
  return {
    checkedAt: '2026-08-16T00:00:00.000Z',
    runtime: { node: setupTool(node), npm: setupTool(npm) },
    cli: setupTool(cli),
    desktop: {
      ...setupTool(desktop),
      appVersion: null,
      mirrorVersion: null,
      mirrorUpdateAvailable: null,
      mirrorError: null,
      running: false,
      updateAvailable: false,
      latestVersion: null,
      updateState: 'unknown',
      updateError: null,
    },
  }
}
import type { DesktopAppStatus } from './types'

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

describe('codexSetupReadyForDashboard', () => {
  const windows = platformCapabilitiesFor('win32', 'x64')

  it('requires every durable Windows bootstrap step before using the dashboard fast path', () => {
    expect(codexSetupReadyForDashboard(resumableSetupStatus(), windows)).toBe(true)
    expect(codexSetupReadyForDashboard(resumableSetupStatus({ node: false }), windows)).toBe(false)
    expect(codexSetupReadyForDashboard(resumableSetupStatus({ npm: false }), windows)).toBe(false)
    expect(codexSetupReadyForDashboard(resumableSetupStatus({ cli: false }), windows)).toBe(false)
    expect(codexSetupReadyForDashboard(resumableSetupStatus({ desktop: false }), windows)).toBe(false)
  })

  it('does not require an in-app desktop install on externally managed platforms', () => {
    expect(codexSetupReadyForDashboard(
      resumableSetupStatus({ desktop: false }),
      platformCapabilitiesFor('darwin', 'arm64'),
    )).toBe(true)
  })

  it('respects a persisted user choice to keep Codex Desktop uninstalled', () => {
    expect(codexSetupReadyForDashboard(
      resumableSetupStatus({ desktop: false }),
      windows,
      true,
    )).toBe(true)
  })

  it('never fast-paths a status that contains a failed probe', () => {
    const status = resumableSetupStatus()
    status.cli.detectionFailed = true
    status.cli.detectionError = '命令探测超时'
    expect(codexSetupReadyForDashboard(status, windows)).toBe(false)
  })
})

describe('managed bootstrap checkpoint', () => {
  it('is keyed per account and only accepts a completed sentinel', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    expect(managedBootstrapCompleted(36, storage)).toBe(false)
    markManagedBootstrapCompleted(36, storage)
    expect(managedBootstrapCompleted(36, storage)).toBe(true)
    expect(managedBootstrapCompleted(37, storage)).toBe(false)
  })

  it('rejects invalid user ids without touching storage', () => {
    const setItem = vi.fn()
    const storage = { getItem: vi.fn(() => null), setItem }
    markManagedBootstrapCompleted(0, storage)
    markManagedBootstrapCompleted(Number.NaN, storage)
    expect(setItem).not.toHaveBeenCalled()
    expect(managedBootstrapCompleted(-1, storage)).toBe(false)
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

describe('resolveInitialAppView', () => {
  // 登录先行(老板拍板 2026-08-10):账号站点上未登录一律先到欢迎页,
  // 不再凭"配过任一 CLI"跳过——所以这里不需要 config 形参。

  it('sends every signed-out user on an account-backed site to the welcome page (login-first)', () => {
    expect(resolveInitialAppView(false, false)).toBe('welcome')
  })

  it('routes an authenticated user to onboarding, never re-showing the welcome page', () => {
    expect(resolveInitialAppView(true, false)).toBe('onboarding')
  })

  it('lets dev preview mode win outright regardless of authentication state', () => {
    expect(resolveInitialAppView(false, true)).toBe('onboarding')
    expect(resolveInitialAppView(true, true)).toBe('onboarding')
  })

  it('skips the welcome page on a manual-key site, which has no account to welcome the user into', () => {
    // A manual-key site offers no register/login for the welcome page to
    // lead to, so the login-first rule cannot apply there.
    expect(resolveInitialAppView(false, false, true)).toBe('onboarding')
  })
})

describe('initialOnboardingPreview', () => {
  it('is false with no query string, matching every packaged build', () => {
    expect(initialOnboardingPreview('')).toBe(false)
  })

  it('is false when the onboardingPreview param is absent among other params', () => {
    expect(initialOnboardingPreview('?theme=dark')).toBe(false)
  })

  it('rejects truthy-looking values other than the exact "1" main.ts appends', () => {
    expect(initialOnboardingPreview('?onboardingPreview=true')).toBe(false)
    expect(initialOnboardingPreview('?onboardingPreview=0')).toBe(false)
  })

  it('is true for the exact ?onboardingPreview=1 main.ts appends in dev preview mode', () => {
    expect(initialOnboardingPreview('?onboardingPreview=1')).toBe(true)
  })
})
