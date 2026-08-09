import { describe, expect, it } from 'vitest'
import { providerBaseUrls, providerIds } from './catalog'
import { defaultRelaySiteId, relaySiteExternalUrls, relaySites, resolveRelaySite } from './relay-sites'

describe('relay site registry', () => {
  it('ships the solov and sub2api sites, both reusing catalog providerBaseUrls by reference', () => {
    expect(relaySites).toHaveLength(2)
    expect(relaySites.map((site) => site.id)).toEqual(['solov', 'sub2api'])
    for (const site of relaySites) {
      expect(site.providerBaseUrls).toBe(providerBaseUrls)
    }
  })

  it('resolves the sub2api site', () => {
    expect(resolveRelaySite('sub2api').id).toBe('sub2api')
  })

  it('gives sub2api a manual-key account backend with no accountBaseUrl', () => {
    const site = resolveRelaySite('sub2api')
    expect(site.accountBackend).toBe('manual-key')
    expect(site.accountBaseUrl).toBeUndefined()
  })

  it('defaults to the solov site id', () => {
    expect(defaultRelaySiteId).toBe('solov')
    expect(relaySites.some((site) => site.id === defaultRelaySiteId)).toBe(true)
  })

  it('every site URL is https -- I10', () => {
    for (const site of relaySites) {
      for (const url of [site.websiteUrl, site.keysPageUrl, ...(site.accountBaseUrl ? [site.accountBaseUrl] : [])]) {
        expect(() => new URL(url)).not.toThrow()
        expect(new URL(url).protocol).toBe('https:')
      }
      for (const provider of providerIds) {
        const url = site.providerBaseUrls[provider]
        expect(() => new URL(url)).not.toThrow()
        expect(new URL(url).protocol).toBe('https:')
      }
    }
  })

  it('only declares accountBaseUrl for a new-api backed site', () => {
    for (const site of relaySites) {
      if (site.accountBackend === 'new-api') {
        expect(site.accountBaseUrl).toBeTruthy()
      }
    }
  })

  describe('resolveRelaySite', () => {
    it('resolves a known id', () => {
      expect(resolveRelaySite('solov').id).toBe('solov')
    })

    it('falls back to the default site for an unknown id', () => {
      expect(resolveRelaySite('not-a-real-site-id').id).toBe(defaultRelaySiteId)
    })

    it('falls back to the default site for null', () => {
      expect(resolveRelaySite(null).id).toBe(defaultRelaySiteId)
    })

    it('falls back to the default site for undefined', () => {
      expect(resolveRelaySite(undefined).id).toBe(defaultRelaySiteId)
    })

    it('never throws regardless of input', () => {
      expect(() => resolveRelaySite('')).not.toThrow()
      expect(() => resolveRelaySite('  ')).not.toThrow()
    })
  })

  describe('relaySiteExternalUrls', () => {
    it('matches today\'s hand-maintained main.ts allowlist entries exactly, with no growth from sub2api (I12: same-domain site adds zero new URLs)', () => {
      // Pins the exact set electron/main.ts's externalUrlAllowlist used to
      // hand-type before W2 -- this is the "generation result matches
      // today's site set exactly" acceptance check for the allowlist wiring.
      // Updated for W3: sub2api ships on the same domain as solov (same
      // websiteUrl/keysPageUrl strings, no accountBaseUrl of its own), so
      // this set is unchanged even though relaySites now has two entries --
      // the dedup in relaySiteExternalUrls is what keeps it that way.
      expect(relaySiteExternalUrls(relaySites)).toEqual([
        'https://api.solov.cc',
        'https://api.solov.cc/keys',
        'https://xm.solov.cc/wallet',
      ])
    })

    it('omits the wallet URL for a site with no account backend', () => {
      const manualKeySite = {
        id: 'manual-example',
        label: 'Manual example',
        providerBaseUrls,
        websiteUrl: 'https://example.invalid',
        keysPageUrl: 'https://example.invalid/keys',
        accountBackend: 'manual-key' as const,
      }
      expect(relaySiteExternalUrls([manualKeySite])).toEqual([
        'https://example.invalid',
        'https://example.invalid/keys',
      ])
    })

    it('returns an empty list for an empty site list', () => {
      expect(relaySiteExternalUrls([])).toEqual([])
    })
  })
})
