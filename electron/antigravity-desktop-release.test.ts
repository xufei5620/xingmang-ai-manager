import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildAntigravityDesktopArtifactUrl, buildAntigravityDesktopFeedUrl, maximumAntigravityDesktopArtifactBytes,
  maximumAntigravityDesktopFeedBytes, minimumAntigravityDesktopArtifactBytes, parseAntigravityDesktopFeed,
  resolveAntigravityDesktopPlatform, type AntigravityDesktopPlatform,
} from './antigravity-desktop-release'

// The four feeds below are the 2.34.0 ones read verbatim on a GitHub runner on 2026-11-23;
// nothing in this file reaches Google.
const build = '5887025308631040'
const hub = `https://storage.googleapis.com/antigravity-public/antigravity-hub/2.34.0-${build}`

const real: Record<AntigravityDesktopPlatform, { url: string, sha512: string, size: number, path: string }> = {
  'windows-x64': {
    url: `${hub}/windows-x64/Antigravity-x64.exe`,
    sha512: 'KkMPl6KWQ8sXUdvkbSk3nHdfWySYPkE9ZNa+SbKEnLME4ZwwpF9QATf3WlQhrQnYLdfR1O0pDBw1vj1/4T8KbA==',
    size: 169817280,
    path: 'Antigravity-x64.exe',
  },
  'windows-arm64': {
    url: `${hub}/windows-arm/Antigravity-arm64.exe`,
    sha512: '6KyECd2D7qyq/WP9EH0vzO8Llf6C6fW9FGVK6ifyUtRVjb6xywnbFdOnhnFupI6NNbHXXpAIQWjpMxbKsyvtCw==',
    size: 160529640,
    path: 'Antigravity-arm64.exe',
  },
  'macos-x64': {
    url: `${hub}/darwin-x64/Antigravity.zip`,
    sha512: 'ovrm7s8YGNURw6n41DrL2K6kIZHvwalVFWaCSVRQy0rjLF5uSTyQigm5w4dEPb4Y7unEcDi+Fbl49j9HYreCkw==',
    size: 223410052,
    path: 'Antigravity.zip',
  },
  'macos-arm64': {
    url: `${hub}/darwin-arm/Antigravity.zip`,
    sha512: '4mY3QkbpWxuru5gPvJrabdr3tMH/mnQDtallcA5m6bZQ6g3AClqU5N6gryt0eml7mrLtm7Vkb+iIQdDRB3wCFw==',
    size: 211599326,
    path: 'Antigravity.zip',
  },
}

const platforms = Object.keys(real) as AntigravityDesktopPlatform[]

function feed(platform: AntigravityDesktopPlatform, overrides: Partial<{ version: string, url: string, sha512: string, size: string, path: string | null, topSha512: string | null }> = {}): string {
  const item = real[platform]
  const sha512 = overrides.sha512 ?? item.sha512
  const lines = [
    `version: ${overrides.version ?? '2.34.0'}`,
    'files:',
    `  - url: ${overrides.url ?? item.url}`,
    `    sha512: ${sha512}`,
    `    size: ${overrides.size ?? String(item.size)}`,
  ]
  const path = overrides.path === undefined ? item.path : overrides.path
  if (path !== null) lines.push(`path: ${path}`)
  const topSha512 = overrides.topSha512 === undefined ? sha512 : overrides.topSha512
  if (topSha512 !== null) lines.push(`sha512: ${topSha512}`)
  return `${lines.join('\n')}\n`
}

function hex(base64: string): string {
  return Buffer.from(base64, 'base64').toString('hex')
}

describe('resolveAntigravityDesktopPlatform', () => {
  it.each([
    ['win32', 'x64', 'windows-x64'],
    ['win32', 'arm64', 'windows-arm64'],
    ['darwin', 'x64', 'macos-x64'],
    ['darwin', 'arm64', 'macos-arm64'],
    ['win32', 'ia32', null],
    ['darwin', 'arm', null],
    ['linux', 'x64', null],
    ['linux', 'arm64', null],
    ['freebsd', 'x64', null],
  ] as const)('maps %s/%s to %s', (platform, architecture, expected) => {
    expect(resolveAntigravityDesktopPlatform(platform, architecture)).toBe(expected)
  })
})

describe('buildAntigravityDesktopFeedUrl', () => {
  it('reads the per-chip feed electron-updater itself reads, not latest.yml', () => {
    expect(platforms.map(buildAntigravityDesktopFeedUrl)).toEqual([
      'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-x64-win.yml',
      'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-win.yml',
      'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-x64-mac.yml',
      'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml',
    ])
  })
})

describe('buildAntigravityDesktopArtifactUrl', () => {
  it.each(platforms)('builds the address Google published for %s', (platform) => {
    expect(buildAntigravityDesktopArtifactUrl(platform, '2.34.0', build)).toBe(real[platform].url)
  })

  it.each([
    ['2.34', build],
    ['2.34.0.1', build],
    ['02.34.0', build],
    ['2.34.0-beta', build],
    ['../2.34.0', build],
    ['2.34.0', ''],
    ['2.34.0', '0123'],
    ['2.34.0', '58870253/../1'],
    ['2.34.0', `${build}x`],
    ['2.34.0', '1'.repeat(26)],
  ])('refuses version %j with build %j', (version, releaseBuild) => {
    expect(() => buildAntigravityDesktopArtifactUrl('windows-x64', version, releaseBuild)).toThrow('Antigravity 桌面端的版本号无效')
  })
})

describe('parseAntigravityDesktopFeed', () => {
  it.each(platforms)('reads the real 2.34.0 feed for %s', (platform) => {
    const item = real[platform]
    expect(parseAntigravityDesktopFeed(feed(platform), platform)).toEqual({
      platform,
      version: '2.34.0',
      build,
      url: item.url,
      bytes: item.size,
      sha512: hex(item.sha512),
      packaging: platform.startsWith('windows') ? 'nsis-installer' : 'app-zip',
    })
  })

  it('turns the base64 digest into the lower-case hex the downloader compares', () => {
    const release = parseAntigravityDesktopFeed(feed('windows-x64'), 'windows-x64')
    expect(release?.sha512).toMatch(/^[0-9a-f]{128}$/)
    expect(Buffer.from(release?.sha512 ?? '', 'hex').toString('base64')).toBe(real['windows-x64'].sha512)
  })

  it('accepts CRLF line endings, a byte-order mark, quoted values, blank lines and a release date', () => {
    const text = [
      '﻿version: \'2.34.0\'',
      '',
      'files:',
      `  - url: "${real['macos-arm64'].url}"`,
      `    sha512: ${real['macos-arm64'].sha512}`,
      `    size: '${real['macos-arm64'].size}'`,
      '    blockMapSize: 223456',
      'path: Antigravity.zip',
      `sha512: ${real['macos-arm64'].sha512}`,
      'releaseDate: \'2026-11-20T08:00:00.000Z\'',
      '',
    ].join('\r\n')
    expect(parseAntigravityDesktopFeed(text, 'macos-arm64')).toMatchObject({ version: '2.34.0', build, bytes: real['macos-arm64'].size })
  })

  it('accepts a feed without the legacy top-level path and sha512', () => {
    expect(parseAntigravityDesktopFeed(feed('windows-arm64', { path: null, topSha512: null }), 'windows-arm64')).toMatchObject({ build })
  })

  it.each(platforms.flatMap((asked) => platforms.filter((served) => served !== asked).map((served) => [served, asked] as const)))(
    'refuses the %s feed when %s was asked for',
    (served, asked) => {
      expect(parseAntigravityDesktopFeed(feed(served), asked)).toBeNull()
    },
  )

  const sha512 = real['windows-x64'].sha512
  const url = real['windows-x64'].url
  it.each([
    ['an empty feed', ''],
    ['a blank feed', ' \n\n'],
    ['a feed over the size limit only because of blank lines', `${feed('windows-x64')}${'\n'.repeat(maximumAntigravityDesktopFeedBytes)}`],
    ['a comment line', `# signed by Google\n${feed('windows-x64')}`],
    ['a missing version', feed('windows-x64').replace('version: 2.34.0\n', '')],
    ['a repeated version', `version: 2.34.0\n${feed('windows-x64')}`],
    ['a version the url does not name', feed('windows-x64', { version: '2.35.0' })],
    ['a pre-release version', feed('windows-x64', { version: '2.34.0-beta.1' })],
    ['a missing file list', 'version: 2.34.0\npath: Antigravity-x64.exe\n'],
    ['an inline file list', 'version: 2.34.0\nfiles: []\n'],
    ['an empty file list', 'version: 2.34.0\nfiles:\n'],
    ['a second file', feed('windows-x64').replace('path:', `  - url: ${url}\n    sha512: ${sha512}\n    size: 169817280\npath:`)],
    ['a repeated key inside the file', feed('windows-x64').replace('    size: 169817280\n', '    size: 169817280\n    size: 169817280\n')],
    ['a file key before any dash', 'version: 2.34.0\nfiles:\n    url: x\n'],
    ['an indented line outside the file list', `${feed('windows-x64')}stagingPercentage: 50\n  extra: 1\n`],
    ['a nested mapping', feed('windows-x64').replace('path:', 'signature:\n  publisherName: Google LLC\npath:')],
    ['a flow mapping line', feed('windows-x64').replace('path:', '{ url: x }\npath:')],
    ['a missing url', feed('windows-x64').replace(`  - url: ${url}\n    sha512:`, '  - sha512:')],
    ['a missing size', feed('windows-x64').replace('    size: 169817280\n', '')],
    ['a missing digest', feed('windows-x64').replace(`    sha512: ${sha512}\n`, '')],
    ['a digest that is not base64', feed('windows-x64', { sha512: `${'*'.repeat(86)}==`, topSha512: null })],
    ['a short digest', feed('windows-x64', { sha512: `${sha512.slice(0, 84)}==`, topSha512: null })],
    ['a non-canonical digest', feed('windows-x64', { sha512: `${sha512.slice(0, 85)}B==`, topSha512: null })],
    ['a hex digest', feed('windows-x64', { sha512: hex(sha512), topSha512: null })],
    ['a top-level digest that disagrees', feed('windows-x64', { topSha512: real['windows-arm64'].sha512 })],
    ['a top-level digest that is malformed', feed('windows-x64', { topSha512: 'nope' })],
    ['a top-level path naming another file', feed('windows-x64', { path: 'Antigravity-arm64.exe' })],
    ['a top-level path with a directory', feed('windows-x64', { path: 'windows-x64/Antigravity-x64.exe' })],
    ['a size with a leading zero', feed('windows-x64', { size: '0169817280' })],
    ['a fractional size', feed('windows-x64', { size: '169817280.5' })],
    ['a negative size', feed('windows-x64', { size: '-169817280' })],
    ['a size below the floor', feed('windows-x64', { size: String(minimumAntigravityDesktopArtifactBytes - 1) })],
    ['a size above the ceiling', feed('windows-x64', { size: String(maximumAntigravityDesktopArtifactBytes + 1) })],
    ['a size past safe integers', feed('windows-x64', { size: '9007199254740993' })],
    ['a url on another host', feed('windows-x64', { url: url.replace('storage.googleapis.com', 'storage.googleapis.com.evil.example') })],
    ['a url on a look-alike origin', feed('windows-x64', { url: url.replace('https://storage.googleapis.com', 'https://storage.googleapis.com:8443') })],
    ['a plain-http url', feed('windows-x64', { url: url.replace('https:', 'http:') })],
    ['a url in another bucket', feed('windows-x64', { url: url.replace('antigravity-public', 'antigravity-private') })],
    ['the command-line tool bucket', feed('windows-x64', { url: url.replace('antigravity-hub', 'antigravity-cli') })],
    ['a url without a build number', feed('windows-x64', { url: url.replace(`2.34.0-${build}`, '2.34.0') })],
    ['a url whose build climbs out', feed('windows-x64', { url: url.replace(`2.34.0-${build}`, `2.34.0-${build}/../../evil`) })],
    ['a url with a query', feed('windows-x64', { url: `${url}?alt=media` })],
    ['a url with a fragment', feed('windows-x64', { url: `${url}#x` })],
    ['a url with an encoded slash', feed('windows-x64', { url: url.replace(`-${build}/`, `-${build}%2F`) })],
    ['a url for another chip', feed('windows-x64', { url: real['windows-arm64'].url, path: null })],
    ['a url for the other system', feed('windows-x64', { url: real['macos-x64'].url, path: null })],
    ['a url with upper-case letters', feed('windows-x64', { url: url.replace('Antigravity-x64.exe', 'ANTIGRAVITY-x64.exe') })],
    ['a value with a trailing comment', feed('windows-x64').replace('version: 2.34.0', 'version: 2.34.0 # latest')],
    ['a key with a dash', feed('windows-x64').replace('path:', 'release-date: 2026-11-20\npath:')],
  ])('refuses %s', (_label, text) => {
    expect(parseAntigravityDesktopFeed(text, 'windows-x64')).toBeNull()
  })

  it('accepts sizes right at both bounds', () => {
    expect(parseAntigravityDesktopFeed(feed('windows-x64', { size: String(minimumAntigravityDesktopArtifactBytes) }), 'windows-x64')?.bytes).toBe(minimumAntigravityDesktopArtifactBytes)
    expect(parseAntigravityDesktopFeed(feed('windows-x64', { size: String(maximumAntigravityDesktopArtifactBytes) }), 'windows-x64')?.bytes).toBe(maximumAntigravityDesktopArtifactBytes)
  })

  it('reads a later release Google may publish the same way', () => {
    const later = `https://storage.googleapis.com/antigravity-public/antigravity-hub/3.0.12-6000000000000001/darwin-x64/Antigravity.zip`
    expect(parseAntigravityDesktopFeed(feed('macos-x64', { version: '3.0.12', url: later }), 'macos-x64')).toMatchObject({
      version: '3.0.12', build: '6000000000000001', url: later,
    })
  })
})

describe('parseAntigravityDesktopFeed with random inputs', () => {
  it('only ever hands out the artifact address it would build itself', () => {
    const platform = fc.constantFrom(...platforms)
    const line = fc.oneof(
      fc.string({ maxLength: 120 }),
      fc.constantFrom(`  - url: ${real['windows-x64'].url}`, `    url: ${real['macos-arm64'].url}`, 'files:', 'version: 2.34.0', `    sha512: ${real['windows-x64'].sha512}`),
    )
    fc.assert(fc.property(platform, fc.array(line, { maxLength: 8 }), fc.nat(), (asked, extra, at) => {
      const lines = feed(asked).split('\n')
      lines.splice(at % (lines.length + 1), 0, ...extra)
      const release = parseAntigravityDesktopFeed(lines.join('\n'), asked)
      if (release === null) return
      expect(release.platform).toBe(asked)
      expect(release.url).toBe(buildAntigravityDesktopArtifactUrl(asked, release.version, release.build))
      expect(release.bytes).toBeGreaterThanOrEqual(minimumAntigravityDesktopArtifactBytes)
      expect(release.bytes).toBeLessThanOrEqual(maximumAntigravityDesktopArtifactBytes)
    }), { numRuns: 400 })
  })

  it('refuses any url other than the one built from the version and build it names', () => {
    fc.assert(fc.property(fc.constantFrom(...platforms), fc.webUrl({ withQueryParameters: true, withFragments: true }), (asked, candidate) => {
      const release = parseAntigravityDesktopFeed(feed(asked, { url: candidate, path: null }), asked)
      expect(release === null || release.url === real[asked].url).toBe(true)
    }), { numRuns: 300 })
  })
})
