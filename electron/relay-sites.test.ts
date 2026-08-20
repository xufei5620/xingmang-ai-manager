import { describe, expect, it } from 'vitest'
import { providerBaseUrls, providerIds } from './catalog'
import {
  defaultRelaySiteId,
  privacyPolicyUrl,
  relayApiProbeBaseUrl,
  relaySiteExternalUrls,
  relaySites,
  resolveRelaySite,
  supportServiceUrl,
  userAgreementUrl,
} from './relay-sites'

describe('relay site registry', () => {
  it('pins the customer support destination to the exact enterprise WeChat link', () => {
    expect(supportServiceUrl).toBe('https://work.weixin.qq.com/kfid/kfcffe6f62fdaa0ccf4')
  })
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
      // Updated 2026-08-10: 官网/取 Key 页移到账号域 xm.solov.cc(老板拍板;
      // 同日中转也统一切到 xm,见 catalog.ts),api.solov.cc 全面退出。
      expect(relaySiteExternalUrls(relaySites)).toEqual(['https://xm.solov.cc', 'https://xm.solov.cc/keys'])
    })

    it('returns only marketing and keys pages for a manual-key site', () => {
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

  describe('relayApiProbeBaseUrl', () => {
    it('derives the probe origin from the relay CLI base the CLIs actually call', () => {
      // 2026-08-10 the relay itself moved to xm.solov.cc too, so probe base
      // and websiteUrl happen to coincide today -- the assertion that
      // matters is the derivation source (providerBaseUrls, not the
      // marketing URL), which keeps probes correct if they ever split again.
      for (const site of relaySites) {
        expect(relayApiProbeBaseUrl(site)).toBe(site.providerBaseUrls.claude)
        expect(relayApiProbeBaseUrl(site)).toBe('https://xm.solov.cc')
      }
    })
  })

  describe('legal page URLs', () => {
    it('serves the agreement and privacy pages from the account domain over https', () => {
      expect(userAgreementUrl).toBe('https://xm.solov.cc/user-agreement')
      expect(privacyPolicyUrl).toBe('https://xm.solov.cc/privacy-policy')
      for (const url of [userAgreementUrl, privacyPolicyUrl]) {
        const parsed = new URL(url)
        expect(parsed.protocol).toBe('https:')
        expect(parsed.origin).toBe('https://xm.solov.cc')
      }
    })
  })
})
