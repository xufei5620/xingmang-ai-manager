import { describe, expect, it } from 'vitest'
import {
  isNewerVersion,
  minimumSupportedNodeVersion,
  nodeVersionStatus,
  parseNodeVersion,
} from './versions'

describe('CLI version comparison', () => {
  it('extracts semantic versions from CLI output', () => {
    expect(isNewerVersion('codex-cli 0.145.0', '0.146.0')).toBe(true)
    expect(isNewerVersion('2.1.218 (Claude Code)', '2.1.218')).toBe(false)
  })

  it('compares numeric segments instead of strings', () => {
    expect(isNewerVersion('1.9.9', '1.10.0')).toBe(true)
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(false)
  })

  it('handles prerelease versions and malformed output', () => {
    expect(isNewerVersion('1.0.0-beta.1', '1.0.0')).toBe(true)
    expect(isNewerVersion('unknown', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0.0', null)).toBe(false)
  })
})

describe('Node.js runtime version gate', () => {
  it('parses node --version output without throwing on surrounding text', () => {
    expect(parseNodeVersion('v22.17.0')).toEqual({ major: 22, minor: 17, patch: 0 })
    expect(parseNodeVersion('Node.js v20.0.0\n')).toEqual({ major: 20, minor: 0, patch: 0 })
    expect(parseNodeVersion('not a node version')).toBeNull()
    expect(parseNodeVersion(null)).toBeNull()
  })

  it.each([
    ['v16.20.2', 'too-old'],
    ['v20.0.0', 'supported'],
    ['v22.17.0', 'supported'],
    ['v24.1.0', 'supported'],
  ] as const)('classifies %s as %s', (version, expected) => {
    expect(nodeVersionStatus(version)).toBe(expected)
  })

  it('keeps the minimum gate explicit for UI messaging', () => {
    expect(minimumSupportedNodeVersion).toEqual({ major: 20, minor: 0, patch: 0 })
  })
})
