import { describe, expect, it } from 'vitest'
import { isDetectionFailed, sameDesktopStatus } from './app-shared'
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
