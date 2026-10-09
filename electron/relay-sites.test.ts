import { describe, expect, it } from 'vitest'
import { providerBaseUrls, providerIds } from './catalog'
import {
  createRelayEndpointRoutingSnapshot,
  createToolRouteRoutingSnapshot,
  defaultRelaySiteId,
  privacyPolicyUrl,
  relayApiProbeBaseUrl,
  relayDirectHosts,
  relayDirectIps,
  relayEndpointForUrl,
  relayEndpointOrigin,
  relaySiteKnownOrigins,
  relayProviderBaseUrlEquals,
  relayProviderBaseUrlMatches,
  relayProviderBaseUrls,
  relaySiteEndpointChoices,
  relaySiteEndpointIdForBaseUrl,
  relaySiteForProviderBaseUrl,
  relaySiteExternalUrls,
  relaySiteProviderBaseUrlVariants,
  relayRoutePreferenceAllowed,
  relaySites,
  resolveRelayRoutePreferences,
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

  it('lists every host a relay site sends account or CLI traffic to, once each', () => {
    const hosts = relayDirectHosts()
    expect(hosts).toEqual(['xm.solov.cc', 'xm-direct.solov.cc', 'api.solov.cc', 'api-direct.solov.cc'])
    // 旧的 IP 测试入口只当别名认旧配置，服务端要关掉它，加速规则里不再带。
    expect(relayDirectIps()).toEqual([])
    for (const site of relaySites) {
      for (const url of [...Object.values(site.providerBaseUrls), site.accountBaseUrl, site.websiteUrl, site.keysPageUrl]) {
        if (url) expect(hosts).toContain(new URL(url).hostname)
      }
    }
  })

  it('skips non-https URLs when listing direct hosts', () => {
    expect(relayDirectHosts([{ ...relaySites[0], websiteUrl: 'http://plain.example.com', keysPageUrl: 'https://Keys.Example.com/keys' }]))
      .toEqual(['xm.solov.cc', 'keys.example.com', 'xm-direct.solov.cc'])
  })

  it('exposes only fixed choices belonging to each account site', () => {
    expect(relaySiteEndpointChoices('solov').map((endpoint) => endpoint.id)).toEqual(['primary', 'direct'])
    expect(relaySiteEndpointChoices('solov-api').map((endpoint) => endpoint.id)).toEqual(['primary', 'direct'])
    expect(relaySiteEndpointChoices('https://xm.solov.cc')).toEqual([])
    // 历史账号的直连有自己的域名（直连适配第二步），不借星芒账号那条。
    expect(relayProviderBaseUrls('solov-api', 'direct')).toEqual({ claude: 'https://api-direct.solov.cc',
      codex: 'https://api-direct.solov.cc/v1', gemini: 'https://api-direct.solov.cc', grok: 'https://api-direct.solov.cc/v1' })
    expect(() => relayProviderBaseUrls('https://api.solov.cc', 'direct')).toThrow('未知中转站点')
  })

  it('accepts only auto or a line the site actually has as a stored preference', () => {
    for (const siteId of ['solov', 'solov-api']) {
      for (const value of ['auto', 'primary', 'direct']) expect(relayRoutePreferenceAllowed(siteId, value)).toBe(true)
      for (const value of ['backup', '', null, undefined, 'https://xm-direct.solov.cc', 1]) expect(relayRoutePreferenceAllowed(siteId, value)).toBe(false)
    }
    // 没有线路的站连「自动」也不收：设置里不能给不认识的站存一个偏好。
    for (const siteId of ['sub2api', 'https://xm.solov.cc', undefined]) expect(relayRoutePreferenceAllowed(siteId, 'auto')).toBe(false)
  })

  it('maps a request to its site and line by exact origin and never treats an alias as a line', () => {
    expect(relayEndpointForUrl('https://xm.solov.cc/api/user/self')).toEqual({ siteId: 'solov', endpointId: 'primary' })
    expect(relayEndpointForUrl('https://XM-DIRECT.solov.cc/v1/models')).toEqual({ siteId: 'solov', endpointId: 'direct' })
    expect(relayEndpointForUrl('https://api.solov.cc/api/v1/auth/me')).toEqual({ siteId: 'solov-api', endpointId: 'primary' })
    expect(relayEndpointForUrl('https://api-direct.solov.cc/v1/messages')).toEqual({ siteId: 'solov-api', endpointId: 'direct' })
    for (const url of ['https://38.147.105.28:8443/v1/models', 'http://xm.solov.cc/v1', 'https://xm.solov.cc:8443/v1',
      'https://xm.solov.cc.evil.example/v1', 'https://other.example/v1', 'not a url']) {
      expect(relayEndpointForUrl(url)).toBeNull()
    }
    expect(relayEndpointOrigin('solov', 'direct')).toBe('https://xm-direct.solov.cc')
    expect(relayEndpointOrigin('solov-api', 'primary')).toBe('https://api.solov.cc')
    expect(relayEndpointOrigin('sub2api', 'primary')).toBeNull()
  })

  it('lists every address a site was reached at, retired aliases included, and nothing for other sites', () => {
    expect(relaySiteKnownOrigins('solov')).toEqual(['https://xm.solov.cc', 'https://xm-direct.solov.cc', 'https://38.147.105.28:8443'])
    expect(relaySiteKnownOrigins('solov-api')).toEqual(['https://api.solov.cc', 'https://api-direct.solov.cc'])
    expect(relaySiteKnownOrigins('sub2api')).toEqual([])
  })

  it('recognizes same-site aliases without accepting other sites or lookalike URLs', () => {
    const direct = relayProviderBaseUrls('solov', 'direct')
    for (const provider of providerIds) {
      expect(relayProviderBaseUrlMatches(provider, direct[provider], providerBaseUrls[provider])).toBe(true)
      expect(relayProviderBaseUrlMatches(provider, providerBaseUrls[provider], direct[provider])).toBe(true)
      expect(relayProviderBaseUrlMatches(provider, relaySites[1].providerBaseUrls[provider], direct[provider])).toBe(false)
    }
    for (const actual of ['https://xm.solov.cc.evil.example/v1', 'https://user:secret@xm.solov.cc/v1',
      'https://xm.solov.cc/v1?key=fixture', 'http://xm.solov.cc/v1', 'https://anything.solov.cc/v1']) {
      expect(relayProviderBaseUrlMatches('codex', actual, providerBaseUrls.codex)).toBe(false)
    }
    expect(relaySiteEndpointIdForBaseUrl('solov', 'codex', `${direct.codex}/`)).toBe('direct')
    expect(relaySiteEndpointIdForBaseUrl('solov-api', 'codex', direct.codex)).toBeNull()
    expect(relaySiteEndpointIdForBaseUrl('solov-api', 'codex', 'https://api-direct.solov.cc/v1')).toBe('direct')
    expect(relaySiteEndpointIdForBaseUrl('solov', 'codex', 'https://api-direct.solov.cc/v1')).toBeNull()
    expect(relayProviderBaseUrlMatches('claude', 'https://api-direct.solov.cc', relaySites[1].providerBaseUrls.claude)).toBe(true)
    expect(relaySiteForProviderBaseUrl('solov', 'codex', direct.codex)?.providerBaseUrls).toEqual(direct)
    // 旧的 IP 测试入口认作直连，认出来的那份按它原样的地址交出，迁不迁照选没选过线路定。
    expect(direct.codex).toBe('https://xm-direct.solov.cc/v1')
    expect(relaySiteEndpointIdForBaseUrl('solov', 'codex', 'https://38.147.105.28:8443/v1')).toBe('direct')
    expect(relayProviderBaseUrlMatches('codex', 'https://38.147.105.28:8443/v1', providerBaseUrls.codex)).toBe(true)
    expect(relaySiteForProviderBaseUrl('solov', 'codex', 'https://38.147.105.28:8443/v1')?.providerBaseUrls.codex)
      .toBe('https://38.147.105.28:8443/v1')
    for (const actual of ['https://38.147.105.28/v1', 'https://38.147.105.28:8444/v1', 'http://38.147.105.28:8443/v1']) {
      expect(relaySiteEndpointIdForBaseUrl('solov', 'codex', actual)).toBeNull()
    }
  })

  it('takes only the very address of a line as equal, never another line or a retired alias', () => {
    const direct = relayProviderBaseUrls('solov', 'direct')
    expect(relayProviderBaseUrlEquals(`${direct.codex}/`, direct.codex)).toBe(true)
    expect(relayProviderBaseUrlEquals('https://XM-DIRECT.solov.cc/v1', direct.codex)).toBe(true)
    expect(relayProviderBaseUrlEquals(providerBaseUrls.codex, direct.codex)).toBe(false)
    const [retired] = relaySiteProviderBaseUrlVariants('solov', 'codex')
      .filter((variant) => variant.endpointId === 'direct' && variant.baseUrl !== direct.codex)
    expect(relayProviderBaseUrlEquals(retired.baseUrl, direct.codex)).toBe(false)
    for (const actual of [`${direct.codex}?key=fixture`, 'https://user:secret@xm-direct.solov.cc/v1', 'not a url', '']) {
      expect(relayProviderBaseUrlEquals(actual, direct.codex)).toBe(false)
    }
  })

  it('lists every address a provider is known by on each line without writing an alias', () => {
    expect(relaySiteProviderBaseUrlVariants('solov', 'codex')).toEqual([
      { endpointId: 'primary', baseUrl: 'https://xm.solov.cc/v1' },
      { endpointId: 'direct', baseUrl: 'https://xm-direct.solov.cc/v1' },
      { endpointId: 'direct', baseUrl: 'https://38.147.105.28:8443/v1' },
    ])
    expect(relaySiteProviderBaseUrlVariants('solov', 'claude').map((variant) => variant.baseUrl))
      .toEqual(['https://xm.solov.cc', 'https://xm-direct.solov.cc', 'https://38.147.105.28:8443'])
    expect(relaySiteProviderBaseUrlVariants('solov-api', 'codex')).toEqual([{ endpointId: 'primary', baseUrl: 'https://api.solov.cc/v1' },
      { endpointId: 'direct', baseUrl: 'https://api-direct.solov.cc/v1' }])
    expect(relaySiteProviderBaseUrlVariants('https://xm.solov.cc', 'codex')).toEqual([])
    // 写进配置、发请求只用各条线路自己的地址。
    const direct = createRelayEndpointRoutingSnapshot({ solov: 'direct' }).require('solov')
    expect(JSON.stringify([direct, relayProviderBaseUrls('solov', 'direct')])).not.toContain('38.147.105.28')
  })

  it('freezes active transport independently of pending settings and canonical site identity', () => {
    const preferences = { solov: 'direct' as const, 'solov-api': 'primary' as const }
    const routing = createRelayEndpointRoutingSnapshot(preferences)
    Object.assign(preferences, { solov: 'primary', 'solov-api': 'direct' })
    expect(routing.preferences).toEqual({ solov: 'direct', 'solov-api': 'primary' })
    expect(Object.isFrozen(routing.preferences)).toBe(true)
    expect(routing.require('solov').accountBaseUrl).toBe('https://xm-direct.solov.cc')
    expect(routing.require('solov').providerBaseUrls).toEqual(relayProviderBaseUrls('solov', 'direct'))
    expect(routing.require('solov').websiteUrl).toBe('https://xm.solov.cc')
    expect(routing.require('solov-api').accountBaseUrl).toBe('https://api.solov.cc')
    expect(resolveRelaySite('solov').accountBaseUrl).toBe('https://xm.solov.cc')
    expect(Object.isFrozen(routing.require('solov').providerBaseUrls)).toBe(true)
    expect(createRelayEndpointRoutingSnapshot().selection('solov')).toBeUndefined()
    expect(() => routing.require('sub2api')).toThrow('未知中转站点')
    expect(() => routing.require('https://xm-direct.solov.cc')).toThrow('未知中转站点')
  })

  it('lets the account site follow the tool line while the legacy site keeps the application line', () => {
    const application = { solov: { line: 'direct' as const, settled: true }, 'solov-api': { line: 'direct' as const, settled: false } }
    let tool: 'direct' | 'primary' = 'primary'
    const routing = createToolRouteRoutingSnapshot({}, () => application, () => tool)
    expect(routing.lines()).toEqual({ solov: { line: 'primary', settled: true }, 'solov-api': { line: 'direct', settled: false } })
    expect(routing.selection('solov')).toBe('primary')
    expect(routing.selection('solov-api')).toBeUndefined()
    expect(routing.require('solov').providerBaseUrls).toEqual(relayProviderBaseUrls('solov', 'primary'))
    tool = 'direct'
    application['solov-api'] = { line: 'direct', settled: true }
    expect(routing.require('solov').providerBaseUrls).toEqual(relayProviderBaseUrls('solov', 'direct'))
    expect(routing.selection('solov-api')).toBe('direct')
    // 写死一条的偏好照旧压过线路结论。
    expect(createToolRouteRoutingSnapshot({ solov: 'primary' }, () => application, () => 'direct').selection('solov')).toBe('primary')
  })

  it('reads a missing preference as auto and keeps a choice saved before auto existed as that one line', () => {
    expect(resolveRelayRoutePreferences()).toEqual({ solov: 'auto', 'solov-api': 'auto' })
    expect(resolveRelayRoutePreferences({ solov: 'direct' })).toEqual({ solov: 'direct', 'solov-api': 'auto' })
    expect(resolveRelayRoutePreferences({ solov: 'primary', 'solov-api': 'direct' })).toEqual({ solov: 'primary', 'solov-api': 'direct' })
    expect(() => resolveRelayRoutePreferences({ solov: 'backup' as 'direct' })).toThrow('连接线路无效')
    // 写死一条的不看控制器报的线路：报上来什么都照走那一条。
    const pinned = createRelayEndpointRoutingSnapshot({ solov: 'primary', 'solov-api': 'direct' },
      () => ({ solov: { line: 'direct', settled: true }, 'solov-api': { line: 'primary', settled: true } }))
    expect(pinned.lines()).toEqual({ solov: { line: 'primary', settled: true }, 'solov-api': { line: 'direct', settled: true } })
    expect(pinned.selection('solov')).toBe('primary')
    expect(pinned.require('solov-api').accountBaseUrl).toBe('https://api-direct.solov.cc')
  })

  it('moves an auto site with the reported line and lets tools migrate only once the line is settled', () => {
    let reported: Partial<Record<'solov' | 'solov-api', { line: 'primary' | 'direct'; settled: boolean }>> = {}
    const routing = createRelayEndpointRoutingSnapshot({}, () => reported)
    // 第一次开机还没查出来：照旧走默认线路，不算定下来，工具配置不迁。
    expect(routing.lines().solov).toEqual({ line: 'primary', settled: false })
    expect(routing.resolve('solov').accountBaseUrl).toBe('https://xm.solov.cc')
    expect(routing.selection('solov')).toBeUndefined()
    reported = { solov: { line: 'direct', settled: true } }
    expect(routing.resolve('solov').providerBaseUrls).toEqual(relayProviderBaseUrls('solov', 'direct'))
    expect(routing.selection('solov')).toBe('direct')
    expect(routing.selection('solov-api')).toBeUndefined()
    reported = { solov: { line: 'primary', settled: true }, 'solov-api': { line: 'direct', settled: true } }
    expect(routing.require('solov').accountBaseUrl).toBe('https://xm.solov.cc')
    expect(routing.selection('solov')).toBe('primary')
    expect(routing.require('solov-api').providerBaseUrls.codex).toBe('https://api-direct.solov.cc/v1')
    // 报上来的线路这个站没有、或者没说定没定，一律当没定下来。
    reported = { solov: { line: 'backup' as 'direct', settled: true }, 'solov-api': { line: 'direct' } as { line: 'direct'; settled: boolean } }
    expect(routing.lines()).toEqual({ solov: { line: 'primary', settled: false }, 'solov-api': { line: 'direct', settled: false } })
    expect(Object.isFrozen(routing.lines().solov)).toBe(true)
  })

  it('separates literal IPs from DNS acceleration rules without changing registry choices', () => {
    const site = { ...relaySites[0], id: 'fixture-ip', accountBaseUrl: 'https://38.147.105.28:8443',
      providerBaseUrls: { ...providerBaseUrls, codex: 'https://38.147.105.28:8443/v1', gemini: 'https://[2001:db8::1]:8443' } }
    expect(relayDirectHosts([site])).toEqual(['xm.solov.cc'])
    expect(relayDirectIps([site])).toEqual(['38.147.105.28', '2001:db8::1'])
  })
})
