import { describe, expect, it } from 'vitest'
import { initialWindowOs, windowOsFor } from './window-os'

describe('windowOsFor', () => {
  it('maps the main process platform family onto the window layout', () => {
    expect(windowOsFor('macos')).toBe('mac')
    expect(windowOsFor('windows')).toBe('win')
    expect(windowOsFor('linux')).toBe('linux')
  })
})

describe('initialWindowOs', () => {
  it('keeps what the entry point already wrote on the root element', () => {
    expect(initialWindowOs('mac', 'Win32')).toBe('mac')
    expect(initialWindowOs('win', 'MacIntel')).toBe('win')
    expect(initialWindowOs('linux', undefined)).toBe('linux')
  })

  it('reads a Mac from what Chromium reports before the platform capabilities arrive', () => {
    expect(initialWindowOs(undefined, 'MacIntel')).toBe('mac')
    expect(initialWindowOs('', 'MacIntel')).toBe('mac')
    expect(initialWindowOs('unexpected', 'MacIntel')).toBe('mac')
  })

  it('falls back to the Windows layout when nothing points at a Mac', () => {
    expect(initialWindowOs(undefined, 'Win32')).toBe('win')
    expect(initialWindowOs(undefined, 'Linux x86_64')).toBe('win')
    expect(initialWindowOs(undefined, undefined)).toBe('win')
  })
})
