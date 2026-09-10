import { describe, expect, it } from 'vitest'
import { providerIds } from './catalog'
import {
  defaultRelaySiteId,
  relaySiteExternalUrls,
  relaySites,
  requireRelaySite,
  resolveRelaySite,
} from './relay-sites'

const invalidSelections: { label: string; value: unknown }[] = [
  { label: 'undefined', value: undefined },
  { label: 'null', value: null },
  { label: 'empty string', value: '' },
  { label: 'whitespace', value: '  ' },
  { label: 'leading whitespace', value: ' solov' },
  { label: 'trailing whitespace', value: 'solov ' },
  { label: 'different case', value: 'SOLOV' },
  { label: 'unregistered id', value: 'not-a-registered-site' },
  { label: 'account hostname', value: 'xm.solov.cc' },
  { label: 'account URL', value: 'https://xm.solov.cc' },
  { label: 'other account hostname', value: 'api.solov.cc' },
  { label: 'misspelled hostname', value: 'xm.solo.cc' },
  { label: 'number', value: 1 },
  { label: 'boolean', value: true },
  { label: 'array', value: ['solov'] },
  { label: 'object', value: { id: 'solov' } },
]

describe('explicit relay site identity', () => {
  it.each(['solov', 'sub2api'])('returns the registered object for %s', (id) => {
    expect(requireRelaySite(id)).toBe(relaySites.find((site) => site.id === id))
  })

  it.each(invalidSelections)('rejects $label without a default fallback', ({ value }) => {
    expect(() => requireRelaySite(value)).toThrow('未知中转站点')
  })

  it('does not coerce untrusted values into a registered id', () => {
    const value = { toString: () => { throw new Error('must not coerce') } }
    expect(() => requireRelaySite(value)).toThrow('未知中转站点')
  })

  it('does not reflect an unrecognized value in the error message', () => {
    try {
      requireRelaySite('untrusted-input-that-must-not-be-logged')
      expect.fail('an unknown site must be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('未知中转站点')
    }
  })

  it.each(['solov', 'sub2api'])('keeps historical %s account and CLI origins on xm', (id) => {
    // The persisted "sub2api" id is an xm alias, NOT the future
    // api.solov.cc realm. Adding that realm requires a fresh id.
    const site = requireRelaySite(id)
    expect(site.id).toBe(id)
    expect(site.accountBackend).toBe('new-api')
    expect(site.accountBaseUrl).toBe('https://xm.solov.cc')
    expect(new URL(site.websiteUrl).origin).toBe('https://xm.solov.cc')
    expect(new URL(site.keysPageUrl).origin).toBe('https://xm.solov.cc')
    for (const provider of providerIds) {
      expect(new URL(site.providerBaseUrls[provider]).origin).toBe('https://xm.solov.cc')
    }
  })

  it('keeps tolerant settings recovery separate from explicit identity resolution', () => {
    expect(defaultRelaySiteId).toBe('solov')
    for (const id of [undefined, null, '', 'not-a-registered-site']) {
      expect(resolveRelaySite(id)).toBe(requireRelaySite('solov'))
      expect(() => requireRelaySite(id)).toThrow('未知中转站点')
    }
  })

  it('requires unique registry ids so explicit selection is unambiguous', () => {
    expect(new Set(relaySites.map((site) => site.id)).size).toBe(relaySites.length)
  })

  it('does not expand the external URL allowlist in this preparatory wave', () => {
    expect(relaySiteExternalUrls(relaySites)).toEqual([
      'https://xm.solov.cc',
      'https://xm.solov.cc/keys',
      'https://api.solov.cc',
      'https://api.solov.cc/keys',
    ])
  })
})
