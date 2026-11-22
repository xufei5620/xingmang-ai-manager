import { describe, expect, it } from 'vitest'
import {
  claudeCodeMacObjectKey,
  claudeDesktopComponentsBucketPrefix,
  claudeDesktopVmPlatformKey,
  claudeDesktopWorkspaceObjectKey,
  resolveClaudeCodeMacPin,
} from './claude-desktop-component-keys'
import type { ClaudeDesktopComponentManifest } from './claude-desktop-component-manifest'

const sha = '072b6cbfe74f428a98bd86035f83b322b369d1f1'

describe('claude desktop component keys: workspace', () => {
  it('maps the platforms Claude ships a workspace for', () => {
    expect(claudeDesktopVmPlatformKey('win32')).toBe('win32')
    expect(claudeDesktopVmPlatformKey('darwin')).toBe('unix')
    expect(claudeDesktopVmPlatformKey('linux')).toBeNull()
  })

  it('puts the version, platform and checksum in the bucket key so a key never changes content', () => {
    const file = { name: 'rootfs.vhdx', checksum: 'a'.repeat(64) }
    expect(claudeDesktopComponentsBucketPrefix).toBe('xingmang/offline/claude-components')
    expect(claudeDesktopWorkspaceObjectKey(sha, 'win32', 'x64', file))
      .toBe(`xingmang/offline/claude-components/vm/${sha}/win32-x64/${'a'.repeat(64)}/rootfs.vhdx.zst`)
    expect(() => claudeDesktopWorkspaceObjectKey('main', 'win32', 'x64', file)).toThrow()
    expect(() => claudeDesktopWorkspaceObjectKey(sha, 'win32', 'x64', { ...file, checksum: 'A'.repeat(64) })).toThrow()
    expect(() => claudeDesktopWorkspaceObjectKey(sha, 'win32', 'x64', { ...file, name: '../rootfs' })).toThrow()
    expect(() => claudeDesktopWorkspaceObjectKey(sha, 'win32', 'x64', { ...file, name: 'a/b' })).toThrow()
  })
})

describe('claude desktop component keys: Mac program', () => {
  it('picks the bundle for this Mac and rejects malformed pins', () => {
    const manifest: ClaudeDesktopComponentManifest = {
      code: { version: '2.1.309', macBundles: { 'darwin-arm64': { checksum: 'a'.repeat(64), size: 93151388 } }, linux: {} },
      vm: null,
    }
    expect(resolveClaudeCodeMacPin(manifest, 'arm64')).toEqual({ version: '2.1.309', platform: 'darwin-arm64', checksum: 'a'.repeat(64), size: 93151388 })
    expect(resolveClaudeCodeMacPin(manifest, 'x64')).toBeNull()
    expect(resolveClaudeCodeMacPin({ code: null, vm: null }, 'arm64')).toBeNull()
    expect(resolveClaudeCodeMacPin({ ...manifest, code: { ...manifest.code!, version: 'latest' } }, 'arm64')).toBeNull()
    expect(resolveClaudeCodeMacPin({ ...manifest, code: { ...manifest.code!, macBundles: { 'darwin-arm64': { checksum: 'A'.repeat(64), size: 1 } } } }, 'arm64')).toBeNull()
    expect(resolveClaudeCodeMacPin({ ...manifest, code: { ...manifest.code!, macBundles: { 'darwin-arm64': { checksum: 'a'.repeat(64), size: 0 } } } }, 'arm64')).toBeNull()
    expect(resolveClaudeCodeMacPin({ ...manifest, code: { ...manifest.code!, macBundles: { 'darwin-arm64': { checksum: 'a'.repeat(64), size: 1024 * 1024 * 1024 } } } }, 'arm64')).toBeNull()
  })

  it('names the bucket object by version, chip and checksum', () => {
    const pin = { version: '2.1.326', platform: 'darwin-arm64' as const, checksum: 'c4434d650cb33999939847a668017baf105911f3345d7e63df3dbd22de596ca2' }
    expect(claudeCodeMacObjectKey(pin)).toBe(`xingmang/offline/claude-components/code/2.1.326/darwin-arm64/${pin.checksum}/claude.app.tar.zst`)
    expect(() => claudeCodeMacObjectKey({ ...pin, version: '../2' })).toThrow()
    expect(() => claudeCodeMacObjectKey({ ...pin, checksum: 'short' })).toThrow()
    expect(() => claudeCodeMacObjectKey({ ...pin, platform: 'linux-x64' as never })).toThrow()
  })
})
