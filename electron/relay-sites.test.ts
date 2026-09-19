import { describe, expect, it } from 'vitest'
import { providerBaseUrls, providerIds } from './catalog'
import {
  defaultRelaySiteId,
  privacyPolicyUrl,
  relayApiProbeBaseUrl,
  relaySiteExternalUrls,
  relaySites,
  resolveRelaySite,
  resolveSupportServiceUrl,
  sub2ApiSupportServiceUrl,
  supportServiceUrl,
  userAgreementUrl,
} from './relay-sites'

describe('relay site registry', () => {
  it('pins both customer support destinations to their enterprise WeChat links', () => {
    expect(supportServiceUrl).toBe('https://work.weixin.qq.com/kfid/kfc3ac7eece5344c034')
    expect(sub2ApiSupportServiceUrl).toBe('https://work.weixin.qq.com/kfid/kfcffe6f62fdaa0ccf4')
  })
  it('uses the default contact before login, including retained historical account metadata', () => {
    expect(resolveSupportServiceUrl()).toBe(supportServiceUrl)
    expect(resolveSupportServiceUrl(null)).toBe(supportServiceUrl)
    expect(resolveSupportServiceUrl({ authenticated: false, siteId: 'solov-api', realmId: 'api-account' })).toBe(supportServiceUrl)
  })
  it('selects support by the authenticated account realm, preserving NewAPI aliases', () => {
    for (const siteId of ['solov', 'sub2api', undefined]) {
      expect(resolveSupportServiceUrl({ authenticated: true, siteId })).toBe(supportServiceUrl)
    }
    expect(resolveSupportServiceUrl({ authenticated: true, siteId: 'solov-api' })).toBe(sub2ApiSupportServiceUrl)
    expect(resolveSupportServiceUrl({ authenticated: true, realmId: 'api-account' })).toBe(sub2ApiSupportServiceUrl)
  })
  it('registers one entry per real relay and routes the explicit api site to its own origin', () => {
    // D-10 dropped the 'sub2api' entry, a field-for-field duplicate of
    // 'solov'. One entry per distinct relay from here on: a second entry
    // sharing every field is an alias, and aliases belong in the id map
    // resolveRelaySite consults, not in the registry.
    expect(relaySites).toHaveLength(2)
    expect(relaySites.map((site) => site.id)).toEqual(['solov', 'solov-api'])
    expect(resolveRelaySite('solov').providerBaseUrls).toBe(providerBaseUrls)
    expect(resolveRelaySite('solov-api').providerBaseUrls).toEqual({ claude: 'https://api.solov.cc',
      codex: 'https://api.solov.cc/v1', gemini: 'https://api.solov.cc', grok: 'https://api.solov.cc/v1' })
  })

  it('still resolves a settings file that names the retired sub2api id onto xm', () => {
    // The whole reason the alias existed. Removing its registry entry must
    // not change what an existing installation's settings.json resolves to.
    const site = resolveRelaySite('sub2api')
    expect(site.id).toBe('solov')
    expect(site.accountBackend).toBe('new-api')
    expect(site.accountBaseUrl).toBe('https://xm.solov.cc')
    expect(site.providerBaseUrls).toBe(providerBaseUrls)
  })

  it('never lets a retired id resolve onto the other account realm', () => {
    expect(resolveRelaySite('sub2api').id).not.toBe('solov-api')
  })

  it('requires every registered site to use the account login backend', () => {
    expect(relaySites.map((site) => site.accountBackend)).toEqual(['new-api', 'sub2api'])
    expect(relaySites.every((site) => typeof site.accountBaseUrl === 'string')).toBe(true)
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
    it('matches today\'s hand-maintained main.ts allowlist entries exactly (I12)', () => {
      // Pins the exact set electron/main.ts's externalUrlAllowlist used to
      // hand-type before W2 -- this is the "generation result matches
      // today's site set exactly" acceptance check for the allowlist wiring.
      // Updated 2026-08-10: 官网/取 Key 页移到账号域 xm.solov.cc(老板拍板;
      // 同日中转也统一切到 xm,见 catalog.ts),api.solov.cc 全面退出。
      // Unchanged by D-10: the removed sub2api entry was same-domain, so it
      // contributed no URL of its own here either.
      expect(relaySiteExternalUrls(relaySites)).toEqual(['https://xm.solov.cc', 'https://xm.solov.cc/keys', 'https://api.solov.cc', 'https://api.solov.cc/keys'])
    })

    it('returns only marketing and keys pages for an account-backed site', () => {
      const accountSite = {
        id: 'account-example',
        label: 'Account example',
        providerBaseUrls,
        websiteUrl: 'https://example.invalid',
        keysPageUrl: 'https://example.invalid/keys',
        accountBackend: 'new-api' as const,
        accountBaseUrl: 'https://example.invalid',
      }
      expect(relaySiteExternalUrls([accountSite])).toEqual([
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
        expect(relayApiProbeBaseUrl(site)).toBe(site.id === 'solov-api' ? 'https://api.solov.cc' : 'https://xm.solov.cc')
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

    it('keeps the legal documents realm-independent while support stays per realm (D-11)', () => {
      // Deliberate asymmetry, pinned so nobody "fixes" it into a per-realm
      // legal URL: one operator publishes one agreement for both account
      // systems, but the two support desks are staffed separately.
      const apiSession = { authenticated: true, siteId: 'solov-api', realmId: 'api-account' as const }
      expect(resolveSupportServiceUrl(apiSession)).toBe(sub2ApiSupportServiceUrl)
      for (const url of [userAgreementUrl, privacyPolicyUrl]) {
        expect(new URL(url).origin).toBe('https://xm.solov.cc')
      }
    })
  })
})
