import { describe, expect, it } from 'vitest'
import { offersCodexDesktopRestartOnOpen } from './codex-desktop-open'

describe('Codex Desktop open while already running', () => {
  it('asks a Windows user whether to bring the window forward or restart', () => {
    expect(offersCodexDesktopRestartOnOpen('win', true)).toBe(true)
  })

  it('brings the existing Mac window forward instead of offering a restart the Mac refuses', () => {
    expect(offersCodexDesktopRestartOnOpen('mac', true)).toBe(false)
  })

  it('never asks when Codex Desktop is not running', () => {
    expect(offersCodexDesktopRestartOnOpen('win', false)).toBe(false)
    expect(offersCodexDesktopRestartOnOpen('mac', false)).toBe(false)
  })
})
