import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildAntigravityCliArtifactUrl,
  buildAntigravityCliManifestUrl,
  parseAntigravityCliManifest,
  resolveAntigravityCliPlatform,
  type AntigravityCliPlatform,
} from './antigravity-cli-release'

// The Windows manifest as Google served it on 2026-11-23.
const windowsManifest = JSON.stringify({
  version: '1.5.15',
  url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-5514532022517760/windows-x64/cli_windows_x64.exe',
  sha512: 'f9b9d4ffe050c9b909df2afffc5dcca834cd97ed18c1a4cc1b686244c24cf53fd44b45c34c99c25b9892cb8057cbf35a27a376db0a62a5222e1cbf9e8e0bb47e',
})

function manifest(fields: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(windowsManifest) as Record<string, unknown>, ...fields })
}

describe('resolveAntigravityCliPlatform', () => {
  it('names the manifest for 64-bit Windows and Mac only', () => {
    expect(resolveAntigravityCliPlatform('win32', 'x64')).toBe('windows_amd64')
    expect(resolveAntigravityCliPlatform('win32', 'arm64')).toBe('windows_arm64')
    expect(resolveAntigravityCliPlatform('darwin', 'arm64')).toBe('darwin_arm64')
    expect(resolveAntigravityCliPlatform('darwin', 'x64')).toBe('darwin_amd64')
    expect(resolveAntigravityCliPlatform('win32', 'ia32')).toBeNull()
    expect(resolveAntigravityCliPlatform('linux', 'x64')).toBeNull()
  })

  it('builds the manifest address on Google\'s update host', () => {
    expect(buildAntigravityCliManifestUrl('darwin_arm64'))
      .toBe('https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json')
  })
})

describe('parseAntigravityCliManifest', () => {
  it('reads the manifest Google served', () => {
    expect(parseAntigravityCliManifest(windowsManifest, 'windows_amd64')).toEqual({
      platform: 'windows_amd64',
      version: '1.5.15',
      build: '5514532022517760',
      url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-5514532022517760/windows-x64/cli_windows_x64.exe',
      sha512: 'f9b9d4ffe050c9b909df2afffc5dcca834cd97ed18c1a4cc1b686244c24cf53fd44b45c34c99c25b9892cb8057cbf35a27a376db0a62a5222e1cbf9e8e0bb47e',
      packaging: 'executable',
    })
  })

  it('reads a Mac manifest as a tarball and lower-cases the digest', () => {
    const release = parseAntigravityCliManifest(manifest({
      url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-5514532022517760/darwin-arm/cli_mac_arm64.tar.gz',
      sha512: 'A'.repeat(128),
    }), 'darwin_arm64')
    expect(release.packaging).toBe('tar.gz')
    expect(release.sha512).toBe('a'.repeat(128))
  })

  it.each([
    ['another platform\'s file', { url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-5514532022517760/windows-arm/cli_windows_arm64.exe' }],
    ['another version\'s folder', { url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5514532022517760/windows-x64/cli_windows_x64.exe' }],
    ['another host', { url: 'https://storage.googleapis.com.evil.com/antigravity-public/antigravity-cli/1.5.15-5514532022517760/windows-x64/cli_windows_x64.exe' }],
    ['plain http', { url: 'http://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-5514532022517760/windows-x64/cli_windows_x64.exe' }],
    ['a query', { url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-5514532022517760/windows-x64/cli_windows_x64.exe?x=1' }],
    ['a path that climbs out', { url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-1/../../x/windows-x64/cli_windows_x64.exe' }],
    ['a build that is not a number', { url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-abc/windows-x64/cli_windows_x64.exe' }],
    ['a short digest', { sha512: 'f9b9d4ff' }],
    ['a version with a suffix', { version: '1.5.15-beta' }],
    ['a missing url', { url: undefined }],
  ])('refuses %s', (_name, fields) => {
    expect(() => parseAntigravityCliManifest(manifest(fields), 'windows_amd64')).toThrow('无法读取 Antigravity 命令行的版本信息')
  })

  it.each(['', 'not json', '[]', 'null', `{"pad":"${'x'.repeat(20_000)}"}`])('refuses %j', (text) => {
    expect(() => parseAntigravityCliManifest(text, 'windows_amd64')).toThrow('无法读取 Antigravity 命令行的版本信息')
  })
})

describe('antigravity-cli-release with random inputs', () => {
  const platforms: AntigravityCliPlatform[] = ['windows_amd64', 'windows_arm64', 'darwin_amd64', 'darwin_arm64']

  it('accepts a manifest only when its URL is the one built from its own version and build', () => {
    fc.assert(fc.property(
      fc.constantFrom(...platforms),
      fc.string({ maxLength: 12 }),
      fc.string({ maxLength: 160 }),
      (platform, version, url) => {
        let release
        try {
          release = parseAntigravityCliManifest(JSON.stringify({ version, url, sha512: 'b'.repeat(128) }), platform)
        } catch {
          return
        }
        expect(release.url).toBe(buildAntigravityCliArtifactUrl(platform, release.version, release.build))
        expect(new URL(release.url).origin).toBe('https://storage.googleapis.com')
      },
    ))
  })

  it('never builds a URL that leaves Google\'s artifact folder', () => {
    fc.assert(fc.property(fc.constantFrom(...platforms), fc.string({ maxLength: 12 }), fc.string({ maxLength: 30 }), (platform, version, build) => {
      let url: string
      try {
        url = buildAntigravityCliArtifactUrl(platform, version, build)
      } catch {
        return
      }
      const parsed = new URL(url)
      expect(parsed.origin).toBe('https://storage.googleapis.com')
      expect(parsed.pathname.startsWith('/antigravity-public/antigravity-cli/')).toBe(true)
      expect(parsed.href).toBe(url)
    }))
  })
})
