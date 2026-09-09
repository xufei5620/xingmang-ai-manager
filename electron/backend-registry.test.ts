import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { createBackendRegistry, type BackendRegistry } from './backend-registry'
import { requireRelaySite } from './relay-sites'
import type { AccountIdentitySource } from './active-identity'

function fixture() {
  let calls = 0
  const source = {
    getSessionState: () => ({ authenticated: true, account: { userId: 7 } }),
    getSessionRevision: () => 1,
    marker: 'original-client',
  }
  const registry = createBackendRegistry((definition) => {
    calls += 1
    assert.equal(definition.backend, 'new-api')
    assert.equal(definition.accountOrigin, 'https://xm.solov.cc')
    assert.ok(Object.isFrozen(definition))
    return source
  })
  return { registry, source, calls: () => calls }
}

describe('xm-only backend registry', () => {
  it('does not eagerly construct a client', () => {
    const example = fixture()
    assert.equal(example.calls(), 0)
  })

  it('returns exactly one runtime/client for both historical aliases', () => {
    const example = fixture()
    const first = example.registry.get('sub2api')
    assert.equal(first, example.registry.get('solov'))
    assert.equal(first, example.registry.get('sub2api'))
    assert.equal(first.accountService, example.source)
    assert.equal(first.accountService.marker, 'original-client')
    assert.equal(example.calls(), 1)
    assert.ok(Object.isFrozen(example.registry))
  })

  for (const cached of [false, true]) {
    it(`rejects unknown selections before returning or creating a client (cached=${cached})`, () => {
      const example = fixture()
      if (cached) example.registry.get('solov')
      for (const value of [undefined, 'solov-api', 'api.solov.cc', ' sub2api', { id: 'solov' }]) {
        assert.throws(() => example.registry.get(value), /未知中转站点/)
      }
      assert.equal(example.calls(), cached ? 1 : 0)
    })
  }

  it('does not memoize construction errors and supports a later explicit retry', () => {
    let calls = 0
    const example = fixture()
    const registry = createBackendRegistry(() => {
      if (++calls === 1) throw new Error('fixture-construction-failure')
      return example.source
    })
    assert.throws(() => registry.get('solov'), /fixture-construction-failure/)
    assert.equal(registry.get('sub2api').accountService, example.source)
    assert.equal(calls, 2)
  })

  it('does not cache an invalid client returned by a factory', () => {
    let calls = 0
    const example = fixture()
    const registry = createBackendRegistry(() => {
      if (++calls === 1) return {} as unknown as typeof example.source
      return example.source
    })
    assert.throws(() => registry.get('solov'), /缺少会话版本/)
    assert.equal(registry.get('solov').accountService, example.source)
  })

  it('rejects reentrant construction instead of creating duplicate clients', () => {
    const example = fixture()
    let nested = true
    let registry: BackendRegistry<AccountIdentitySource>
    registry = createBackendRegistry(() => {
      if (nested) {
        nested = false
        registry.get('sub2api')
      }
      return example.source
    })
    assert.throws(() => registry.get('solov'), /正在初始化/)
    assert.equal(registry.get('solov').accountService, example.source)
  })

  it('rejects changed routing rather than mixing it with a cached authenticated client', () => {
    const example = fixture()
    const runtime = example.registry.get('solov')
    const primary = requireRelaySite('solov')
    const original = primary.providerBaseUrls
    try {
      primary.providerBaseUrls = { ...original, codex: 'https://xm.solov.cc/v2' }
      assert.throws(() => example.registry.get('solov'), /配置已变化/)
      assert.equal(runtime.definition.providerBaseUrls.codex, 'https://xm.solov.cc/v1')
      assert.equal(example.calls(), 1)
    } finally { primary.providerBaseUrls = original }
    assert.equal(example.registry.get('solov'), runtime)
  })

  it('retains ownership context across alias lookups but not across separate registry instances', () => {
    const example = fixture()
    const captured = example.registry.get('solov').identities.capture()
    assert.doesNotThrow(() => example.registry.get('sub2api').identities.assertCurrent(captured))
    const second = fixture()
    assert.throws(() => second.registry.get('solov').identities.assertCurrent(captured), /上下文无效/)
  })
})
