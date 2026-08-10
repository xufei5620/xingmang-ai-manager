import { describe, expect, it } from 'vitest'
import {
  initialOnboardingPreview,
  isDetectionFailed,
  resolveInitialAppView,
  sameDesktopStatus,
} from './app-shared'
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
