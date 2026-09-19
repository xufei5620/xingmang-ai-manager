import { describe, expect, it } from 'vitest'
import { providerIds } from './catalog'
import {
  buildCliVersionAdvice,
  cliVerifiedVersions,
  findBlockedCliVersion,
  resolveCliInstallVersion,
  versionInBlockedRange,
  type CliVersionCompatibility,
} from './cli-verified-versions'

const semanticVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/

function listWith(entry: Partial<CliVersionCompatibility>): Record<'claude' | 'codex' | 'grok' | 'gemini', CliVersionCompatibility> {
  const empty: CliVersionCompatibility = { recommended: null, blocked: [] }
  return {
    claude: { ...empty, ...entry },
    codex: empty,
    grok: empty,
    gemini: empty,
  }
}

describe('cliVerifiedVersions data', () => {
  it('covers every provider so a new CLI cannot silently miss the list', () => {
    expect(Object.keys(cliVerifiedVersions).sort()).toEqual([...providerIds].sort())
  })

  it('pins only exact semantic versions', () => {
    for (const provider of providerIds) {
      const entry = cliVerifiedVersions[provider]
      if (entry.recommended) expect(entry.recommended.version).toMatch(semanticVersion)
      for (const range of entry.blocked) {
        expect(range.introduced).toMatch(semanticVersion)
        if (range.fixed) expect(range.fixed).toMatch(semanticVersion)
      }
    }
  })

  it('never recommends a version its own blocked ranges reject', () => {
    for (const provider of providerIds) {
      const recommended = cliVerifiedVersions[provider].recommended
      if (!recommended) continue
      for (const range of cliVerifiedVersions[provider].blocked) {
        expect(versionInBlockedRange(recommended.version, range)).toBe(false)
      }
    }
  })

  it('records a verification date and a Chinese note for every recommendation', () => {
    for (const provider of providerIds) {
      const recommended = cliVerifiedVersions[provider].recommended
      if (!recommended) continue
      expect(recommended.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(recommended.note.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('versionInBlockedRange', () => {
  const range = { introduced: '2.1.275', fixed: '2.1.277', reason: '每次请求都 400' }

  it('excludes versions below the first affected release', () => {
    expect(versionInBlockedRange('2.1.274', range)).toBe(false)
  })

  it('includes the first affected release and everything up to the fix', () => {
    expect(versionInBlockedRange('2.1.275', range)).toBe(true)
    expect(versionInBlockedRange('2.1.276', range)).toBe(true)
  })

  it('excludes the fixed release itself and anything newer', () => {
    expect(versionInBlockedRange('2.1.277', range)).toBe(false)
    expect(versionInBlockedRange('2.2.0', range)).toBe(false)
  })

  it('treats a range without a fix as open ended', () => {
    expect(versionInBlockedRange('9.9.9', { ...range, fixed: null })).toBe(true)
  })
})

describe('findBlockedCliVersion', () => {
  it('reports the matching range for the shipped Claude Code regressions', () => {
    expect(findBlockedCliVersion('claude', '2.1.276')?.fixed).toBe('2.1.277')
    expect(findBlockedCliVersion('claude', '2.1.266')?.fixed).toBe('2.1.268')
    expect(findBlockedCliVersion('claude', '2.1.277')).toBeNull()
  })

  it('ignores a version that cannot be parsed instead of guessing', () => {
    expect(findBlockedCliVersion('claude', '版本读取失败')).toBeNull()
    expect(findBlockedCliVersion('claude', null)).toBeNull()
  })

  it('applies a site-scoped range only on that site', () => {
    const list = listWith({ blocked: [{ introduced: '1.0.0', fixed: null, reason: '只影响这个站点', sites: ['solov-api'] }] })
    expect(findBlockedCliVersion('claude', '1.2.3', 'solov-api', list)?.reason).toBe('只影响这个站点')
    expect(findBlockedCliVersion('claude', '1.2.3', 'solov', list)).toBeNull()
    expect(findBlockedCliVersion('claude', '1.2.3', undefined, list)).toBeNull()
  })

  it('applies a range without sites on every site', () => {
    const list = listWith({ blocked: [{ introduced: '1.0.0', fixed: null, reason: '所有站点' }] })
    expect(findBlockedCliVersion('claude', '1.2.3', 'solov-api', list)?.reason).toBe('所有站点')
    expect(findBlockedCliVersion('claude', '1.2.3', undefined, list)?.reason).toBe('所有站点')
  })
})

describe('resolveCliInstallVersion', () => {
  const list = listWith({ recommended: { version: '2.1.277', verifiedAt: '2026-09-18', verifiedSites: [], note: '测试' } })

  it('installs the recommended version by default', () => {
    expect(resolveCliInstallVersion('claude', { list })).toEqual({ version: '2.1.277', source: 'recommended' })
  })

  it('follows npm latest when the user turned the switch on', () => {
    expect(resolveCliInstallVersion('claude', { list, alwaysLatest: true })).toEqual({ version: 'latest', source: 'latest' })
  })

  it('keeps installing latest for providers without a list, switch or not', () => {
    expect(resolveCliInstallVersion('codex', { list })).toEqual({ version: 'latest', source: 'latest' })
    expect(resolveCliInstallVersion('codex', { list, alwaysLatest: true })).toEqual({ version: 'latest', source: 'latest' })
  })

  it('honours an explicitly requested version over both the list and the switch', () => {
    expect(resolveCliInstallVersion('claude', { list, requested: '2.1.268' })).toEqual({ version: '2.1.268', source: 'requested' })
    expect(resolveCliInstallVersion('claude', { list, requested: '2.1.268', alwaysLatest: true })).toEqual({ version: '2.1.268', source: 'requested' })
  })

  it('ignores a blank request instead of installing an empty version', () => {
    expect(resolveCliInstallVersion('claude', { list, requested: '  ' })).toEqual({ version: '2.1.277', source: 'recommended' })
  })
})

describe('buildCliVersionAdvice', () => {
  const list = listWith({
    recommended: { version: '2.1.277', verifiedAt: '2026-09-18', verifiedSites: [], note: '测试' },
    blocked: [{ introduced: '2.1.275', fixed: '2.1.277', reason: '每次请求都 400' }],
  })

  it('stays quiet when the installed version is the recommended one', () => {
    expect(buildCliVersionAdvice('claude', '2.1.277', { list })).toEqual({
      recommendedVersion: '2.1.277',
      blockedReason: null,
      onRecommended: true,
      pinned: true,
      rollbackAvailable: false,
    })
  })

  it('stops pinning and stops offering a rollback once the user follows latest', () => {
    const advice = buildCliVersionAdvice('claude', '2.1.270', { list, alwaysLatest: true })
    expect(advice.pinned).toBe(false)
    expect(advice.rollbackAvailable).toBe(false)
  })

  it('still offers a rollback to a latest-follower stuck on a blocked version', () => {
    const advice = buildCliVersionAdvice('claude', '2.1.276', { list, alwaysLatest: true })
    expect(advice.pinned).toBe(false)
    expect(advice.blockedReason).toBe('每次请求都 400')
    expect(advice.rollbackAvailable).toBe(true)
  })

  it('offers a rollback when the installed version merely differs', () => {
    const advice = buildCliVersionAdvice('claude', '2.1.270', { list })
    expect(advice.rollbackAvailable).toBe(true)
    expect(advice.blockedReason).toBeNull()
  })

  it('explains the incompatibility when the installed version is blocked', () => {
    const advice = buildCliVersionAdvice('claude', '2.1.276', { list })
    expect(advice.blockedReason).toBe('每次请求都 400')
    expect(advice.rollbackAvailable).toBe(true)
  })

  it('reads a version out of a full CLI banner line', () => {
    expect(buildCliVersionAdvice('claude', '2.1.277 (Claude Code)', { list }).onRecommended).toBe(true)
  })

  it('never claims an unparsable version is the recommended one', () => {
    const advice = buildCliVersionAdvice('claude', '版本读取失败', { list })
    expect(advice.onRecommended).toBe(false)
    expect(advice.rollbackAvailable).toBe(false)
  })

  it('offers nothing for a provider without a list', () => {
    expect(buildCliVersionAdvice('codex', '1.0.0', { list })).toEqual({
      recommendedVersion: null,
      blockedReason: null,
      onRecommended: false,
      pinned: false,
      rollbackAvailable: false,
    })
  })

  it('offers nothing when the tool is not installed', () => {
    const advice = buildCliVersionAdvice('claude', null, { list })
    expect(advice.recommendedVersion).toBe('2.1.277')
    expect(advice.rollbackAvailable).toBe(false)
  })
})
