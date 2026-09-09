import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { providerBaseUrls, providerIds } from './catalog'
import { relaySites, requireRelaySite, type RelaySite } from './relay-sites'
import { createSiteRuntime, requireXmSiteRuntimeDefinition } from './site-runtime'
import type { AccountIdentitySource } from './active-identity'

function withPatch(id: string, patch: Partial<RelaySite>, check: () => void): void {
  const site = requireRelaySite(id)
  const original = { ...site }
  try {
    Object.assign(site, patch)
    check()
  } finally {
    Object.assign(site, original)
  }
}

function client(): AccountIdentitySource {
  return { getSessionState: () => ({ authenticated: false, account: null }), getSessionRevision: () => 0 }
}

describe('xm-only site runtime', () => {
  for (const id of ['solov', 'sub2api']) {
    it(`resolves ${id} into the same canonical xm realm without mutating the persisted id`, () => {
      const selected = requireRelaySite(id)
      const definition = requireXmSiteRuntimeDefinition(id)
      assert.equal(selected.id, id)
      assert.deepEqual(definition, {
        siteId: 'solov', realmId: 'xm-account', backend: 'new-api',
        accountOrigin: 'https://xm.solov.cc', aiBaseUrl: 'https://xm.solov.cc', providerBaseUrls,
      })
    })
  }

  it('copies and freezes routing metadata without freezing the existing registry', () => {
    const definition = requireXmSiteRuntimeDefinition('solov')
    assert.ok(Object.isFrozen(definition))
    assert.ok(Object.isFrozen(definition.providerBaseUrls))
    assert.notEqual(definition.providerBaseUrls, providerBaseUrls)
    assert.equal(requireRelaySite('solov').providerBaseUrls, providerBaseUrls)
    assert.equal(Reflect.defineProperty(definition.providerBaseUrls, 'claude', { value: 'https://other.example.invalid' }), false)
    assert.equal(definition.aiBaseUrl, 'https://xm.solov.cc')
  })

  for (const value of [undefined, null, '', ' solov', 'solov ', 'SOLOV', 'solov-api', 'api.solov.cc', 1, {}, ['solov']]) {
    it(`does not default an invalid explicit selection: ${JSON.stringify(value)}`, () => {
      assert.throws(() => requireXmSiteRuntimeDefinition(value), /未知中转站点/)
    })
  }

  it('keeps future sites disabled even when they are present in the relay registry', () => {
    const mutable = relaySites as unknown as RelaySite[]
    const extra = { ...requireRelaySite('solov'), id: 'solov-api' }
    mutable.push(extra)
    try { assert.throws(() => requireXmSiteRuntimeDefinition('solov-api'), /尚未启用/) } finally { mutable.pop() }
  })

  for (const value of [undefined, '', ' http://xm.solov.cc', 'http://xm.solov.cc', 'https://user:secret@xm.solov.cc', 'https://xm.solov.cc/api', 'https://xm.solov.cc?token=fixture', 'https://xm.solov.cc#fragment', 'not-a-url']) {
    it(`rejects a malformed account origin: ${JSON.stringify(value)}`, () => {
      withPatch('solov', { accountBaseUrl: value }, () => {
        assert.throws(() => requireXmSiteRuntimeDefinition('solov'), /地址配置无效/)
      })
    })
  }

  it('refuses to reinterpret the historical alias as a different account origin', () => {
    withPatch('sub2api', { accountBaseUrl: 'https://other.example.invalid' }, () => {
      assert.throws(() => requireXmSiteRuntimeDefinition('sub2api'), /别名与账号域不一致/)
    })
  })

  for (const provider of providerIds) {
    it(`rejects a different account/AI origin for ${provider}`, () => {
      withPatch('solov', { providerBaseUrls: { ...providerBaseUrls, [provider]: 'https://other.example.invalid' } }, () => {
        assert.throws(() => requireXmSiteRuntimeDefinition('solov'), /路由配置不一致/)
      })
    })
    it(`rejects a different alias route for ${provider}`, () => {
      withPatch('sub2api', { providerBaseUrls: { ...providerBaseUrls, [provider]: 'https://other.example.invalid' } }, () => {
        assert.throws(() => requireXmSiteRuntimeDefinition('sub2api'), /路由配置不一致/)
      })
    })
  }

  it('requires a bare origin for the shared chat and media endpoint', () => {
    withPatch('solov', { providerBaseUrls: { ...providerBaseUrls, claude: 'https://xm.solov.cc/v1' } }, () => {
      assert.throws(() => requireXmSiteRuntimeDefinition('solov'), /地址配置无效/)
    })
  })

  it('keeps the exact client instance and does not trigger authentication during construction', () => {
    let reads = 0
    const account = {
      ...client(),
      getSessionState() {
        reads += 1
        return { authenticated: false, account: null }
      },
    }
    const runtime = createSiteRuntime(requireXmSiteRuntimeDefinition('solov'), account)
    assert.equal(runtime.accountService, account)
    assert.equal(reads, 0)
    assert.ok(Object.isFrozen(runtime))
    assert.ok(Object.isFrozen(runtime.definition))
    assert.ok(!Object.isFrozen(account))
    assert.equal(runtime.identities.read(), null)
    assert.equal(reads, 1)
  })

  it('fails closed when a client lacks the required session revision method', () => {
    const bad = { getSessionState: () => ({ authenticated: false, account: null }) } as unknown as AccountIdentitySource
    assert.throws(() => createSiteRuntime(requireXmSiteRuntimeDefinition('solov'), bad), /缺少会话版本/)
  })
})
