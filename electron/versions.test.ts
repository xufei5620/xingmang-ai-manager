import { describe, expect, it } from 'vitest'
import {
  isExactCliVersion,
  isNewerVersion,
  minimumSupportedNodeVersion,
  nodeVersionStatus,
  parseNodeVersion,
} from './versions'

describe('exact CLI version targets', () => {
  it('accepts registry versions with prerelease and build metadata', () => {
    for (const value of ['0.158.0', '0.158.0-beta.1', '0.158.0+build.1', '0.158.0-beta.1+build.2']) {
      expect(isExactCliVersion(value)).toBe(true)
    }
  })

  it('rejects tags, ranges, whitespace and command fragments', () => {
    for (const value of ['latest', '^1.2.3', '>=1.2.3', '1.2', '1.2.3+', '1.2.3-x;calc', '1.2.3\n', ' 1.2.3', '--version', null, 123]) {
      expect(isExactCliVersion(value)).toBe(false)
    }
  })
})

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

  it.each([
    ['v1.0.0', '1.0.1', true],
    ['1.0.0', 'v1.0.1', true],
    ['1.0.0-beta.2', '1.0.0-beta.10', true],
    ['1.0.0-beta.10', '1.0.0-beta.2', false],
    ['1.0.0-alpha', '1.0.0-beta', true],
    ['1.0.0', '1.0.0-beta.1', false],
    ['1.0.0-rc.1', '1.0.1', true],
    ['1.0.0+build.5', '1.0.1', true],
    ['1.2.3.4', '1.2.4', true],
    ['codex-cli 0.145.0-alpha.3', '0.145.0', true],
    ['x1.0.0', '2.0.0', false],
    ['1.0', '1.0.1', false],
    ['', '1.0.0', false],
    ['1.0.0', '', false],
    ['1.0.0', '1.0.0', false],
    ['1.0.0', '99999999999999999999.0.0', true],
  ] as const)('reads %j against %j as newer=%s', (current, latest, expected) => {
    expect(isNewerVersion(current, latest)).toBe(expected)
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
    ['20.1.0', 'supported'],
    ['v020.0.0', 'supported'],
    ['v19.99.99', 'too-old'],
    ['v20.0.0-nightly', 'unknown'],
    ['node v21.0.0 x64', 'supported'],
    ['v20.0', 'unknown'],
  ] as const)('classifies %s as %s', (version, expected) => {
    expect(nodeVersionStatus(version)).toBe(expected)
  })

  it('keeps the minimum gate explicit for UI messaging', () => {
    expect(minimumSupportedNodeVersion).toEqual({ major: 20, minor: 0, patch: 0 })
  })
})
